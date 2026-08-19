/**
 * video-chunker — the byte stream must survive being cut up and put back together.
 *
 * THE INVARIANT: concat(chunks in seq order) === exactly what ffmpeg wrote. The collector on the
 * far side of the airgap rebuilds the file from these parts and compares hashes, so a single lost,
 * duplicated, reordered or truncated byte is a corrupt recording — not a slightly worse one.
 *
 * Also pins recording.v1's completion protocol: the last chunk is EMPTY with isFinal=true, and it
 * is sent exactly once. The server treats that zero-byte marker as "recording COMPLETED", so an
 * early or duplicated one would flip a still-running recording to done.
 *
 * Drives the real VideoRecordingService's chunker through its private absorb/flushFinal via a fake
 * stdout, so no ffmpeg is involved.
 *
 * No assert lib — same tsx + exit-code shape as the sibling *.test.ts.
 */
import { VideoRecordingService } from './video-recording';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

type Chunk = { seq: number; isFinal: boolean; bytes: Buffer };

/** A service wired to a capturing sink, with its private chunker reachable for the test. */
function harness(chunkBytes: number) {
  process.env.VEXA_VIDEO_CHUNK_BYTES = String(chunkBytes);
  const chunks: Chunk[] = [];
  const svc = new VideoRecordingService(1, 'sess', (seq, isFinal, bytes) =>
    chunks.push({ seq, isFinal, bytes }));
  const inner = svc as unknown as { absorb(b: Buffer): void; flushFinal(): void; flushPartial(): void };
  return {
    chunks,
    feed: (b: Buffer) => inner.absorb(b),
    end: () => inner.flushFinal(),
    /** What the interval timer fires — flush on the clock rather than on size. */
    tick: () => inner.flushPartial(),
  };
}

const concat = (chunks: Chunk[]) => Buffer.concat(chunks.map((c) => c.bytes));

// ── 1) ROUND TRIP — arbitrary writes, arbitrary boundaries, byte-identical result ──
{
  const h = harness(1000);
  const source = Buffer.from(Array.from({ length: 4321 }, (_, i) => i % 256));
  // ffmpeg's stdout arrives in whatever sizes the pipe hands over, not in chunk-sized pieces.
  let off = 0;
  for (const n of [1, 999, 1, 1500, 820, 1000]) {
    h.feed(source.subarray(off, off + n));
    off += n;
  }
  h.end();
  check('reassembled stream is byte-identical', concat(h.chunks).equals(source),
    `${concat(h.chunks).length}B vs ${source.length}B`);
  check('no byte lost or duplicated', concat(h.chunks).length === source.length);
}

// ── 2) SEQ IS DENSE AND MONOTONIC FROM 0 ──
// The server orders parts by seq; a gap would silently drop a span of video.
{
  const h = harness(100);
  h.feed(Buffer.alloc(550, 7));
  h.end();
  const seqs = h.chunks.map((c) => c.seq);
  check('seq starts at 0 and increments by 1', seqs.every((s, i) => s === i), seqs.join(','));
}

// ── 3) THE COMPLETED SIGNAL — empty, final, last, exactly one ──
{
  const h = harness(100);
  h.feed(Buffer.alloc(250, 1));
  h.end();
  const finals = h.chunks.filter((c) => c.isFinal);
  check('exactly one isFinal chunk', finals.length === 1, `got ${finals.length}`);
  check('the isFinal chunk is empty', finals[0]?.bytes.length === 0);
  check('it is the LAST chunk', h.chunks[h.chunks.length - 1]?.isFinal === true);
  check('data chunks are never marked final', h.chunks.slice(0, -1).every((c) => !c.isFinal));
}

// ── 4) flushFinal IS IDEMPOTENT ──
// stop() can be reached twice (orchestrator teardown + index.ts's finally); a second COMPLETED
// signal at a later seq would look like a new, empty recording part.
{
  const h = harness(100);
  h.feed(Buffer.alloc(150, 2));
  h.end();
  const after = h.chunks.length;
  h.end();
  h.end();
  check('repeated flush emits nothing further', h.chunks.length === after, `${after} -> ${h.chunks.length}`);
}

// ── 5) A SILENT RECORDING STILL COMPLETES ──
// ffmpeg producing no output at all must not leave the recording stuck IN_PROGRESS forever.
{
  const h = harness(100);
  h.end();
  check('no data → still exactly one empty final chunk',
    h.chunks.length === 1 && h.chunks[0].isFinal && h.chunks[0].bytes.length === 0);
}

// ── 6) AN EXACT-MULTIPLE STREAM LEAVES NO EMPTY DATA CHUNK ──
// Boundary case: pendingLen hits 0 exactly, so flushFinal must not emit a spurious 0-byte data
// part before the marker.
{
  const h = harness(100);
  h.feed(Buffer.alloc(300, 3));
  h.end();
  const data = h.chunks.filter((c) => !c.isFinal);
  check('exact multiple → 3 data chunks, none empty',
    data.length === 3 && data.every((c) => c.bytes.length === 100), `${data.map((c) => c.bytes.length)}`);
}

// ── 7) A WRITE LARGER THAN THE THRESHOLD SPLITS, IT DOES NOT OVERSHOOT ──
{
  const h = harness(100);
  h.feed(Buffer.alloc(450, 4));
  h.end();
  const data = h.chunks.filter((c) => !c.isFinal);
  check('one big write splits into threshold-sized parts',
    data.slice(0, 4).every((c) => c.bytes.length === 100) && data[4].bytes.length === 50,
    `${data.map((c) => c.bytes.length)}`);
}

// ── 8) TIME-BASED FLUSH BOUNDS WHAT A CRASH COSTS ──
// FIELD FINDING: with a size threshold only, a near-static meeting screen encoded 4 MB in ~100s,
// so that much video sat unflushed and would have been lost on a crash. On a low-bitrate meeting
// it could be many minutes. The clock must be able to cut a chunk that size alone would not.
{
  const h = harness(4 * 1024 * 1024);       // a threshold far above what will be fed
  h.feed(Buffer.alloc(2048, 9));
  check('below the size threshold → nothing emitted yet', h.chunks.length === 0);
  h.tick();
  check('a clock tick flushes the partial buffer', h.chunks.length === 1, `${h.chunks.length}`);
  check('the flushed chunk carries the pending bytes', h.chunks[0]?.bytes.length === 2048);
  check('a partial flush is NOT marked final', h.chunks[0]?.isFinal === false);
}

// ── 9) AN IDLE TICK EMITS NOTHING ──
// An empty data chunk would burn a seq and upload zero bytes every interval.
{
  const h = harness(1000);
  h.tick(); h.tick(); h.tick();
  check('ticks with nothing pending emit nothing', h.chunks.length === 0, `${h.chunks.length}`);
  h.feed(Buffer.alloc(10, 1));
  h.tick();
  h.tick();
  check('only the tick with data emits', h.chunks.length === 1, `${h.chunks.length}`);
}

// ── 10) TIME AND SIZE FLUSHES INTERLEAVE WITHOUT LOSING BYTES ──
// The round-trip invariant must survive both paths firing against the same buffer.
{
  const h = harness(100);
  const source = Buffer.from(Array.from({ length: 350 }, (_, i) => i % 256));
  h.feed(source.subarray(0, 120));    // crosses the size threshold once, 20 left pending
  h.tick();                            // clock cuts the 20
  h.feed(source.subarray(120, 350));  // crosses again
  h.end();
  check('interleaved time+size flushes still round-trip', concat(h.chunks).equals(source),
    `${concat(h.chunks).length}B vs ${source.length}B`);
  const seqs = h.chunks.map((c) => c.seq);
  check('seq stays dense across both flush paths', seqs.every((s, i) => s === i), seqs.join(','));
}

// ── 11) NO PARTIAL FLUSH AFTER COMPLETION ──
// A late timer firing post-stop must not append a chunk after the COMPLETED signal.
{
  const h = harness(1000);
  h.feed(Buffer.alloc(50, 5));
  h.end();
  const after = h.chunks.length;
  h.feed(Buffer.alloc(50, 6));   // a straggling write racing teardown
  h.tick();
  check('no chunk is emitted after the final signal', h.chunks.length === after,
    `${after} -> ${h.chunks.length}`);
}

console.log(failed === 0 ? '\n✅ video-chunker — all checks passed' : `\n❌ video-chunker — ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
