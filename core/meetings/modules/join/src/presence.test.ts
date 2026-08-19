/**
 * presence — the bot leaves an empty meeting, and ONLY an empty meeting.
 *
 * Nothing watched participant count before this: removal.ts detects being kicked out, and the
 * runtime's 4h maxLifetimeSec was the only backstop. So when everyone hung up the bot sat there
 * recording a static screen and holding a concurrency slot.
 *
 * The two ways this can go wrong are opposite and both bad:
 *   - too slow / never fires  → the empty-room recording this exists to stop
 *   - too eager              → the bot walks out of a LIVE meeting, losing the rest of it
 * The checks below weight the second: a transient DOM read failure and a momentary dip must NOT
 * be mistaken for an empty meeting.
 *
 * No assert lib — same tsx + exit-code shape as the sibling *.test.ts.
 */
import { startGoogleAloneMonitor } from './googlemeet/presence';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * Drives the monitor against a fake clock, with the participant count expressed as a FUNCTION OF
 * TIME rather than a fixed sequence. The monitor polls far faster than the clock is advanced, so a
 * scripted array would be drained in the first few milliseconds and every scripted change would
 * land at t=0 — the count has to depend on the clock for a mid-countdown change to be expressible.
 */
function harness(countAt: (t: number) => number | null, graceMs = 1000) {
  let clock = 0;
  let fired = 0;
  const stop = startGoogleAloneMonitor(
    {} as any,
    () => { fired++; },
    {
      graceMs,
      pollMs: 1,
      now: () => clock,
      count: async () => countAt(clock),
    },
  );
  return {
    stop,
    /** Move the fake clock and let the poller observe the world at that instant. */
    async at(t: number) { clock = t; await tick(15); },
    get fired() { return fired; },
  };
}

async function main(): Promise<void> {
  // ── 1) AN EMPTY MEETING IS LEFT, once the grace period has actually elapsed ──
  {
    const h = harness(() => 1, 1000);
    await h.at(0);
    check('does not leave immediately on seeing 1 participant', h.fired === 0);
    await h.at(1500);
    check('leaves once alone for the full grace period', h.fired === 1, `fired=${h.fired}`);
    h.stop();
  }

  // ── 2) A POPULATED MEETING IS NEVER LEFT ──
  {
    const h = harness((t) => (t % 2 === 0 ? 3 : 2), 1000);
    await h.at(0);
    await h.at(60_000);
    check('never leaves while others are present', h.fired === 0, `fired=${h.fired}`);
    h.stop();
  }

  // ── 3) A MOMENTARY DIP RESETS THE TIMER ── (the "don't cut a live meeting short" case)
  // Someone reconnecting can drop the count for a poll or two, so the countdown must restart the
  // instant anyone is seen — not resume from where it left off.
  {
    const h = harness((t) => (t >= 800 && t < 1200 ? 3 : 1), 1000);
    await h.at(0);        // alone from t=0
    await h.at(900);      // someone is seen → reset (900ms of the grace period discarded)
    await h.at(1500);     // alone again → countdown restarts here
    await h.at(2000);     // only 500ms since the restart
    check('a dip back to populated resets the countdown', h.fired === 0, `fired=${h.fired}`);
    await h.at(2600);     // now 1100ms since the restart
    check('and it still leaves once the FULL period passes after the reset', h.fired === 1, `fired=${h.fired}`);
    h.stop();
  }

  // ── 4) AN UNREADABLE PAGE IS NOT AN EMPTY MEETING ── (the dangerous one)
  // countParticipantsOrNull returns null when the DOM read fails. Treating that as zero would make
  // a detached frame or a changed selector look exactly like everyone leaving.
  {
    const h = harness(() => null, 1000);
    await h.at(0);
    await h.at(60_000);
    check('null (unreadable) never triggers a leave', h.fired === 0, `fired=${h.fired}`);
    h.stop();
  }

  // ── 5) A READ FAILURE MID-COUNTDOWN HOLDS, IT DOES NOT ACCELERATE ──
  {
    const h = harness((t) => (t < 500 ? 1 : t < 1500 ? null : 5), 1000);
    await h.at(0);        // alone
    await h.at(800);      // unreadable — must neither fire nor reset
    await h.at(2000);     // populated again
    check('nulls then a populated read → no leave', h.fired === 0, `fired=${h.fired}`);
    h.stop();
  }

  // ── 6) IT FIRES ONCE, NOT EVERY POLL ──
  {
    const h = harness(() => 1, 100);
    await h.at(0);
    await h.at(5000);
    await h.at(9000);
    check('fires exactly once', h.fired === 1, `fired=${h.fired}`);
    h.stop();
  }

  // ── 7) STOPPING THE MONITOR SILENCES IT ──
  {
    const h = harness(() => 1, 100);
    h.stop();
    await h.at(5000);
    check('no leave after the monitor is stopped', h.fired === 0, `fired=${h.fired}`);
  }

  console.log(failed === 0 ? '\n✅ presence — all checks passed' : `\n❌ presence — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
