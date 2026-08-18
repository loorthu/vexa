/**
 * frame-pacer — video time MUST equal wall time.
 *
 * THE INVARIANT THIS PINS: with `image2pipe -framerate N`, ffmpeg timestamps input
 * frame K at K/N seconds. So the recording's duration is decided entirely by how many
 * frames we hand it — nothing else. DNA turns a transcript moment into a video offset
 * with `segment_wall_time - recording_t0`, so if the frame count ever stops tracking
 * elapsed wall time, every clip silently lands on the wrong part of the meeting.
 *
 * Page.screencastFrame fires on visual CHANGE, so arrivals are bursty and can stop
 * entirely while someone stares at a still frame. FramePacer absorbs that by re-writing
 * the latest frame on a clock. The checks below are the three ways that can break:
 * a quiet screencast, a backpressured sink, and a stalled clock.
 *
 * No assert lib — same tsx + exit-code shape as the sibling *.test.ts.
 */
import { FramePacer } from './video-recording';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const FPS = 5;
const frame = (tag: number) => Buffer.from([tag]);

/**
 * A fake sink + fake clock, so pacing is provable without real time passing.
 *
 * `acceptUntil` models a bounded buffer: the sink pushes back after that many writes
 * and keeps pushing back until release() — which is what a real stream's 'drain' means.
 * A sink that stayed blocked forever would not be a stream.
 */
function harness(opts: { acceptUntil?: number } = {}) {
  const writes: Buffer[] = [];
  let clock = 1_000_000;
  let buffered = 0;
  const pacer = new FramePacer({
    fps: FPS,
    now: () => clock,
    write: (f) => {
      writes.push(f);
      buffered++;
      return opts.acceptUntil === undefined || buffered < opts.acceptUntil;
    },
  });
  return {
    pacer,
    writes,
    advance: (ms: number) => { clock += ms; },
    /** The sink flushed its buffer — subsequent writes are accepted again. */
    release: () => { buffered = 0; },
    /** Tick until the count stops moving, mirroring the real repeating timer. */
    settle: () => { let prev = -1; while (prev !== pacer.framesWritten) { prev = pacer.framesWritten; pacer.tick(); } },
  };
}

// ── 1) A SILENT SCREENCAST STILL ADVANCES THE TIMELINE ──
// The load-bearing case: nothing moves on screen for a full second, so exactly one
// frame ever arrives. The file must still gain 5 frames == 1 second of video.
{
  const h = harness();
  h.pacer.start();
  h.pacer.push(frame(1));
  h.advance(1000);
  h.pacer.tick();
  check('1s of silence with one frame → fps frames written', h.pacer.framesWritten === FPS,
    `expected ${FPS}, got ${h.pacer.framesWritten}`);
  check('the same frame is repeated, not dropped', h.writes.length === FPS && h.writes.every((w) => w[0] === 1));
}

// ── 2) NEW FRAMES REPLACE, THEY DO NOT QUEUE ──
// Between ticks the screencast may deliver many frames. Only the newest should be
// emitted — a queue would drift further behind wall time with every burst.
{
  const h = harness();
  h.pacer.start();
  for (let i = 1; i <= 20; i++) h.pacer.push(frame(i));
  h.advance(1000);
  h.pacer.tick();
  check('a 20-frame burst still emits exactly fps frames', h.pacer.framesWritten === FPS,
    `got ${h.pacer.framesWritten}`);
  check('only the newest frame is used', h.writes.every((w) => w[0] === 20));
}

// ── 3) THE COUNT TRACKS THE CLOCK, NOT THE TICK RATE ──
// Ticks are best-effort (timer drift, GC pauses). Whatever the tick cadence, the
// cumulative count must equal floor(elapsed * fps / 1000).
{
  const h = harness();
  h.pacer.start();
  h.pacer.push(frame(1));
  for (const ms of [200, 200, 1000, 37, 2563]) { h.advance(ms); h.pacer.tick(); }
  h.settle();   // a long gap owes more than one maxBurst; the real timer keeps firing
  const elapsed = 200 + 200 + 1000 + 37 + 2563;
  const want = Math.floor((elapsed * FPS) / 1000);
  check('irregular ticks converge on floor(elapsed*fps/1000)', h.pacer.framesWritten === want,
    `expected ${want}, got ${h.pacer.framesWritten}`);
}

// ── 4) A LATE FIRST FRAME BACK-FILLS ──
// The timeline starts when the recorder starts, but the meeting UI may not paint for
// a second or two. Those seconds must exist in the file, or every later offset shifts.
{
  const h = harness();
  h.pacer.start();
  h.advance(2000);
  h.pacer.tick();
  check('no frame yet → nothing written', h.pacer.framesWritten === 0);
  h.pacer.push(frame(9));
  h.pacer.tick();
  check('first frame back-fills the elapsed 2s', h.pacer.framesWritten === 2 * FPS,
    `expected ${2 * FPS}, got ${h.pacer.framesWritten}`);
}

// ── 5) BACKPRESSURE MUST NOT SHORTEN THE VIDEO ──
// write() returning false means "buffer filling", NOT "rejected" — Node still queues
// the frame. So the count advances, we stop until 'drain', and the deficit is worked
// off afterwards. Dropping instead would shorten the file and break the invariant.
{
  const h = harness({ acceptUntil: 3 });   // the 3rd write returns false
  h.pacer.start();
  h.pacer.push(frame(1));
  h.advance(1000);
  h.pacer.tick();
  check('stops writing once the sink pushes back', h.writes.length === 3, `wrote ${h.writes.length}`);
  check('the pushed-back frame still counts', h.pacer.framesWritten === 3);
  check('pacer reports itself blocked', h.pacer.isBlocked);

  h.pacer.tick();
  check('further ticks are inert while blocked', h.writes.length === 3);

  h.release();
  h.pacer.onDrain();
  check('drain works off the full deficit', h.pacer.framesWritten === FPS,
    `expected ${FPS}, got ${h.pacer.framesWritten}`);
  check('no wall-clock seconds were lost to backpressure', h.writes.length === FPS);
}

// ── 6) A LONG STALL IS WORKED OFF, NEVER DISCARDED ──
// maxBurst bounds one tick so a stall can't block the event loop, but the debt must
// survive across ticks — capping by discarding would lose real seconds.
{
  const writes: Buffer[] = [];
  let clock = 0;
  const pacer = new FramePacer({ fps: FPS, now: () => clock, write: (f) => { writes.push(f); return true; }, maxBurst: 2 });
  pacer.start();
  pacer.push(frame(1));
  clock += 4000;                                    // 20 frames owed, burst caps at 2
  pacer.tick();
  check('one tick is capped by maxBurst', pacer.framesWritten === 2, `got ${pacer.framesWritten}`);
  for (let i = 0; i < 9; i++) pacer.tick();          // 9 more ticks × 2
  check('the deficit is repaid across ticks', pacer.framesWritten === 20, `got ${pacer.framesWritten}`);
}

// ── 7) STOP FREEZES THE TIMELINE ──
{
  const h = harness();
  h.pacer.start();
  h.pacer.push(frame(1));
  h.advance(1000);
  h.pacer.tick();
  h.pacer.stop();
  h.advance(5000);
  h.pacer.tick();
  check('no frames written after stop()', h.pacer.framesWritten === FPS, `got ${h.pacer.framesWritten}`);
}

console.log(failed === 0 ? '\n✅ frame-pacer — all checks passed' : `\n❌ frame-pacer — ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
