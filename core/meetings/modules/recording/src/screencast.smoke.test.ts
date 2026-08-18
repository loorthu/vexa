/**
 * screencast smoke — VideoRecordingService → REAL ffmpeg → a real fragmented mp4.
 *
 * frame-pacer.test.ts proves the pacer's arithmetic against a fake sink. This proves the other
 * half: that the arithmetic actually survives ffmpeg. It drives the real service with synthetic
 * JPEG frames and asserts the encoded file's DURATION matches the wall time the recorder ran —
 * the single assumption every downstream clip offset depends on.
 *
 * It also pins the fragmented-mp4 property that makes chunked upload possible: a PREFIX of the
 * byte stream is itself a playable file.
 *
 * Requires ffmpeg + ffprobe on PATH, so it is NOT in the package's default `test` script (macOS
 * dev boxes generally lack them). Run it where ffmpeg exists — the bot image, or:
 *   docker run --rm -v "$PWD/../../../..":/w -w /w/core/meetings/modules/recording node:22-bookworm \
 *     bash -c 'apt-get update -qq && apt-get install -y -qq ffmpeg && npx tsx src/screencast.smoke.test.ts'
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VideoRecordingService } from './video-recording';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FPS = 5;
const RUN_MS = 4000;
const SIZE = '320x240';

function requireTool(bin: string): void {
  const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
  if (r.error) {
    console.error(`SKIP: ${bin} not on PATH — see the header for how to run this.`);
    process.exit(0);
  }
}

/** A real JPEG of the right dimensions. image2pipe decodes every frame, so a 1x1 placeholder
 *  followed by full-size frames would be a mid-stream resolution change; keep them uniform. */
function makeJpeg(dir: string, seed: number): Buffer {
  const out = path.join(dir, `f${seed}.jpg`);
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=${SIZE}:rate=1:duration=1,hue=h=${seed * 40}`,
    '-frames:v', '1', out,
  ]);
  if (r.status !== 0) throw new Error(`could not synthesize a JPEG: ${r.stderr?.toString().slice(-300)}`);
  return fs.readFileSync(out);
}

function probeDuration(file: string): number {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ]);
  return parseFloat(r.stdout.toString().trim());
}

function probeCodec(file: string): string {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name',
    '-of', 'default=nw=1:nk=1', file,
  ]);
  return r.stdout.toString().trim();
}

async function main(): Promise<void> {
  requireTool('ffmpeg');
  requireTool('ffprobe');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screencast-smoke-'));
  process.env.VEXA_VIDEO_SOURCE = 'screencast';
  process.env.VEXA_VIDEO_FPS = String(FPS);

  const frames = [0, 1, 2].map((i) => makeJpeg(dir, i));
  const svc = new VideoRecordingService(4242, 'smoke-session');
  svc.start();

  // Feed frames the way a screencast does: bursty, then a long silence. The silence is the
  // interesting half — a naive implementation would collapse it and shorten the file.
  const startedAt = Date.now();
  svc.pushFrame(frames[0]);
  await sleep(300);
  svc.pushFrame(frames[1]);
  await sleep(200);
  svc.pushFrame(frames[2]);
  await sleep(RUN_MS - 500);          // ~3.5s with NO new frames at all
  const ranMs = Date.now() - startedAt;

  const file = await svc.stop();
  const exists = fs.existsSync(file) && fs.statSync(file).size > 0;
  check('produced a non-empty file', exists, file);
  if (!exists) { console.log(`\n❌ screencast smoke — ${++failed} failed`); process.exit(1); }

  check('container is mp4 with an h264 stream', probeCodec(file) === 'h264', probeCodec(file));

  // THE ASSERTION. Video duration must track the wall clock the recorder ran for, even though
  // only 3 frames ever arrived and the last 3.5s were silent. Tolerance covers process startup
  // and the final partial frame interval.
  const duration = probeDuration(file);
  const driftMs = Math.abs(duration * 1000 - ranMs);
  check(`duration tracks wall time (video=${duration.toFixed(2)}s, ran=${(ranMs / 1000).toFixed(2)}s)`,
    driftMs < 700, `drift ${driftMs.toFixed(0)}ms`);

  check('frames written matches fps × elapsed',
    Math.abs(svc.getFramesWritten() - (ranMs / 1000) * FPS) <= 2,
    `wrote ${svc.getFramesWritten()}, expected ~${((ranMs / 1000) * FPS).toFixed(0)}`);

  // Fragmented-mp4 prefix property — this is what lets Phase 2 upload the byte stream in pieces
  // and lets a bot that dies mid-meeting still leave something playable.
  const whole = fs.readFileSync(file);
  const prefixPath = path.join(dir, 'prefix.mp4');
  fs.writeFileSync(prefixPath, whole.subarray(0, Math.floor(whole.length / 2)));
  const prefixDuration = probeDuration(prefixPath);
  check('a truncated prefix is still a decodable mp4',
    Number.isFinite(prefixDuration) && prefixDuration > 0, `prefix duration=${prefixDuration}`);

  await svc.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(failed === 0 ? '\n✅ screencast smoke — all checks passed' : `\n❌ screencast smoke — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
