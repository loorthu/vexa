/**
 * tab-reaper — the backstop that closes meeting tabs the bots left behind.
 *
 * A CDP-attached bot opens its tab in the SHARED session browser (see attach.ts) and closes it on
 * teardown. That covers the clean paths; it cannot cover the others. A bot force-exited by the
 * watchdog, SIGKILLed by the runtime, or destroyed mid-teardown never runs its teardown at all, and
 * its tab stays in the human's browser forever — 10 of them had accumulated when this was written,
 * with the container at ~2GB across 11 renderer processes. Nothing in the session process cleaned
 * them up, because nothing was looking.
 *
 * The rule is deliberately narrow, because this reaps tabs inside a browser a human also uses:
 *   • never touch a target that existed when the session started (that is the human's own tab);
 *   • only reap the platform's post-meeting landing page — a bot IN a meeting is on /<meeting-code>,
 *     never on /home, so this cannot evict a working bot;
 *   • require the tab to look reapable on two consecutive ticks, so a tab that is merely passing
 *     through (a bot's fresh about:blank, a redirect) is never caught mid-flight;
 *   • leave sign-in pages alone entirely — reaping one could kill a human's login over VNC, which
 *     is the whole reason this browser exists.
 *
 * Known and accepted: a tab a human opens LATER over VNC is not in the protected set, so one left
 * parked on the platform's landing page for two ticks is swept like any other. Their login tab and
 * anything mid-meeting are safe; only the idle landing page goes. SESSION_REAP_TABS=0 turns the
 * whole sweep off if that trade ever stops being worth it.
 *
 * Talks raw CDP HTTP (GET /json, /json/close/<id>) rather than Playwright: the tabs belong to a
 * DIFFERENT CDP client (the bot's connection), and the HTTP endpoints see every target regardless
 * of who opened it.
 */

/** A CDP target as /json reports it. */
export interface CdpTarget {
  id: string;
  type: string;
  url: string;
}

/** Post-meeting landing pages — where a bot's tab ends up once it has left the call. */
const REAPABLE_URL_PATTERNS: RegExp[] = [
  /^https:\/\/meet\.google\.com\/(home\/?)?(\?.*)?$/,
  /^https:\/\/meet\.google\.com\/landing(\/|\?|$)/,
  /^https:\/\/[a-z0-9.-]*zoom\.us\/(postattendee|leave)(\/|\?|$)/,
  /^https:\/\/teams\.microsoft\.com\/v2\/?(\?.*)?$/,
];

/** Is this URL a finished meeting tab (as opposed to a live one, or a human's login)? */
export function isReapableUrl(url: string): boolean {
  return REAPABLE_URL_PATTERNS.some((re) => re.test(url));
}

export interface ReaperOptions {
  /** Target ids that existed at session start — the human's own tabs. Never reaped. */
  protectedIds: Set<string>;
  /** List the browser's current targets. */
  listTargets: () => Promise<CdpTarget[]>;
  /** Close one target by id. */
  closeTarget: (id: string) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * One reaper, holding the "seen reapable last tick" set across calls. Call tick() on a timer; it
 * closes a tab only on the second consecutive tick that finds it reapable.
 */
export function createTabReaper(opts: ReaperOptions) {
  const log = opts.log ?? ((m: string) => console.log(m));
  let pending = new Set<string>();

  return {
    /** Returns the ids closed this tick (empty when there is nothing to do). */
    async tick(): Promise<string[]> {
      let targets: CdpTarget[];
      try {
        targets = await opts.listTargets();
      } catch (err: any) {
        log(`[tab-reaper] could not list targets (skipping this tick): ${err?.message ?? err}`);
        return [];
      }

      const reapableNow = new Set<string>();
      const closed: string[] = [];
      for (const t of targets) {
        if (t.type !== 'page') continue;
        if (opts.protectedIds.has(t.id)) continue;
        if (!isReapableUrl(t.url)) continue;
        reapableNow.add(t.id);
        if (!pending.has(t.id)) continue;   // first sighting: give it a tick to prove it is idle
        try {
          await opts.closeTarget(t.id);
          closed.push(t.id);
          log(`[tab-reaper] closed a left-behind meeting tab (${t.url})`);
        } catch (err: any) {
          log(`[tab-reaper] could not close ${t.id} (will retry next tick): ${err?.message ?? err}`);
        }
      }
      // Only carry forward what is still open and still reapable, so a tab that navigated back into
      // a meeting starts its two-tick count over.
      pending = new Set([...reapableNow].filter((id) => !closed.includes(id)));
      return closed;
    },
  };
}
