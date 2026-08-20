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
import { startGoogleAloneMonitor, countOtherParticipantsOrNull } from './googlemeet/presence';

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
    const h = harness(() => 0, 1000);
    await h.at(0);
    check('does not leave immediately on first seeing nobody else', h.fired === 0);
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
    const h = harness((t) => (t >= 800 && t < 1200 ? 3 : 0), 1000);
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
  // countOtherParticipantsOrNull returns null when the DOM read fails. Treating that as zero would make
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
    const h = harness((t) => (t < 500 ? 0 : t < 1500 ? null : 5), 1000);
    await h.at(0);        // alone
    await h.at(800);      // unreadable — must neither fire nor reset
    await h.at(2000);     // populated again
    check('nulls then a populated read → no leave', h.fired === 0, `fired=${h.fired}`);
    h.stop();
  }

  // ── 6) IT FIRES ONCE, NOT EVERY POLL ──
  {
    const h = harness(() => 0, 100);
    await h.at(0);
    await h.at(5000);
    await h.at(9000);
    check('fires exactly once', h.fired === 1, `fired=${h.fired}`);
    h.stop();
  }

  // ── 7) STOPPING THE MONITOR SILENCES IT ──
  {
    const h = harness(() => 0, 100);
    h.stop();
    await h.at(5000);
    check('no leave after the monitor is stopped', h.fired === 0, `fired=${h.fired}`);
  }

  // ── 8) ONE OTHER PERSON IS A MEETING, NOT AN EMPTY ROOM ── (the regression pin)
  //
  // THE BUG THIS EXISTS FOR: the count is of OTHER people, but the monitor read it as everyone
  // including the bot and treated 1 as "only me". A one-on-one therefore looked identical to an
  // empty room, and the bot walked out of it after the grace period while the other person was
  // still sitting there. Live, that ended a review 2m16s after the bot joined.
  //
  // Nothing above catches it: every other populated case uses 2 or more, which passes either way.
  {
    const h = harness(() => 1, 1000);
    await h.at(0);
    await h.at(60_000);
    check('never leaves a meeting with exactly ONE other person', h.fired === 0, `fired=${h.fired}`);
    h.stop();
  }

  // ── 9) THE COUNTER ITSELF, against DOM-shaped elements ──
  //
  // The checks above all inject a NUMBER, so they prove the timer's arithmetic and nothing about
  // what the number means. That gap is where the bug lived: the monitor was well tested and still
  // wrong, because no test ever asked the counter what it counts.
  {
    /** An element stand-in exposing only the surface the in-page callback uses. */
    const el = (attrs: Record<string, string>, selfDescendant = false, selfAncestor = false) => ({
      getAttribute: (k: string) => attrs[k] ?? null,
      hasAttribute: (k: string) => k in attrs,
      querySelector: (sel: string) => (selfDescendant && sel === '[data-self-name]' ? {} : null),
      closest: (sel: string) => (selfAncestor && sel === '[data-self-name]' ? {} : null),
    });
    const pageOf = (els: any[]): any => ({
      locator: () => ({ evaluateAll: async (fn: (e: any[]) => any) => fn(els) }),
    });

    const human = el({ 'data-participant-id': 'p1', 'aria-label': 'Cottalango Leon' });
    const selfTagged = el({ 'data-participant-id': 'p2', 'aria-label': 'DNA Recorder', 'data-self-name': 'DNA Recorder' });
    const effects = el({ 'data-participant-id': 'p3', 'aria-label': 'Backgrounds and effects' });

    check('one human tile → 1 other',
      (await countOtherParticipantsOrNull(pageOf([human]))) === 1);

    // The live DOM shape: Meet marks the bot with data-self-name, so it is not in this list at
    // all. One human is still one other person — the case the bot used to leave.
    check('a human plus an untagged bot tile → still counts the human',
      (await countOtherParticipantsOrNull(pageOf([human]))) === 1);

    check('the bot\'s own tile is excluded even if it carries data-participant-id',
      (await countOtherParticipantsOrNull(pageOf([human, selfTagged]))) === 1);

    check('self detected on a descendant is excluded',
      (await countOtherParticipantsOrNull(pageOf([human, el({ 'data-participant-id': 'p4', 'aria-label': 'me' }, true)]))) === 1);

    check('self detected on an ancestor is excluded',
      (await countOtherParticipantsOrNull(pageOf([human, el({ 'data-participant-id': 'p5', 'aria-label': 'me' }, false, true)]))) === 1);

    check('the effects panel is not a person',
      (await countOtherParticipantsOrNull(pageOf([human, effects]))) === 1);

    check('an EMPTY room is still zero — the bot must leave it',
      (await countOtherParticipantsOrNull(pageOf([]))) === 0);

    check('a room containing only the bot is zero',
      (await countOtherParticipantsOrNull(pageOf([selfTagged]))) === 0);

    const broken: any = { locator: () => ({ evaluateAll: async () => { throw new Error('detached'); } }) };
    check('an unreadable page is null, never zero',
      (await countOtherParticipantsOrNull(broken)) === null);
  }

  console.log(failed === 0 ? '\n✅ presence — all checks passed' : `\n❌ presence — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
