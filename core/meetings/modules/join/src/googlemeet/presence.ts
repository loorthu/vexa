import { Page } from "playwright";
import { log } from "../_host";

/**
 * Alone detection — the bot must not sit in an empty meeting.
 *
 * Nothing watched participant COUNT before this: removal.ts detects being kicked out, and the
 * runtime's maxLifetimeSec (4h default) was the only backstop. So when everyone hung up, the bot
 * stayed seated recording an empty screen until that cap or an operator intervened — burning a
 * slot against max_concurrent and, now that video records, ~30 MB/hour of a static Meet page.
 *
 * `left_alone` and `startup_alone` were already reserved in the sealed lifecycle.v1
 * CompletionReason enum, and meeting-api's reconciler already reports `left_alone` for a workload
 * that vanished. Only the bot-side signal was missing.
 */

/** The self "Backgrounds and effects" panel also carries data-participant-id; it is not a person. */
const EFFECTS_TILE = /visual_effects|backgrounds and effects/i;

/**
 * OTHER people in the meeting — the bot excluded — or `null` when the page could not be read.
 *
 * COUNTING OTHERS, NOT EVERYONE, is the contract, and getting it wrong walked the bot out of a
 * live meeting. `[data-participant-id]` matches the REMOTE tiles; Meet marks the bot's own tile
 * with `data-self-name` instead, so the bot does not appear in this count at all. The monitor
 * originally assumed it did and treated a count of 1 as "only me" — which is exactly what a
 * meeting with one other person looks like, so the bot left every one-on-one after the grace
 * period with the other person still sitting there.
 *
 * The self tile is filtered explicitly rather than relying on it being absent, so this stays
 * correct if a Meet build ever starts tagging it with both attributes. Either way the number
 * means the same thing: people who are not the bot. Zero of them is alone.
 *
 * The null is load-bearing. A DOM read can fail transiently (navigation, a detached frame) and a
 * failure is NOT evidence of an empty meeting — treating it as zero would make a broken selector
 * or a page hiccup look identical to everyone leaving, and the bot would walk out of a live
 * meeting. Only a successful count is allowed to advance the alone timer.
 */
export async function countOtherParticipantsOrNull(page: Page): Promise<number | null> {
  try {
    const tiles = await page.locator("[data-participant-id]").evaluateAll(
      els => els.map(e => ({
        label: e.getAttribute("aria-label") || (e.textContent || "").trim(),
        isSelf: e.hasAttribute("data-self-name")
          || !!e.querySelector("[data-self-name]")
          || !!e.closest("[data-self-name]"),
      })),
    );
    return tiles.filter(t => t.label && !EFFECTS_TILE.test(t.label) && !t.isSelf).length;
  } catch {
    return null;
  }
}

export interface AloneMonitorOptions {
  /** How long the meeting must stay empty before leaving. Default VEXA_ALONE_TIMEOUT_MS or 120s. */
  graceMs?: number;
  /** Poll interval. Default 5s — the grace period does the debouncing, not the poll rate. */
  pollMs?: number;
  /** Injected for tests. */
  now?: () => number;
  /** Injected for tests: the read of how many OTHER people are present. */
  count?: (page: Page) => Promise<number | null>;
}

/**
 * Fire `onAlone` once NOBODY ELSE has been in the meeting continuously for the grace period.
 *
 * "Alone" is zero others — the bot is not in its own count (see countOtherParticipantsOrNull).
 * A grace period rather than an instant trip because a count can dip legitimately — the last
 * human reconnecting, a tile re-rendering — and leaving on a blip would cut a live meeting
 * short. The timer resets the moment anyone is seen.
 */
export function startGoogleAloneMonitor(
  page: Page,
  onAlone: () => void | Promise<void>,
  opts: AloneMonitorOptions = {},
): () => void {
  // explicit option, else the env override, else the default (Number('') / undefined → NaN → default)
  const graceMs = opts.graceMs ?? (Number(process.env.VEXA_ALONE_TIMEOUT_MS) || 120_000);
  const pollMs = opts.pollMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const count = opts.count ?? countOtherParticipantsOrNull;

  let aloneSince: number | null = null;
  let fired = false;
  log(`[alone] monitoring participants (leave after ${Math.round(graceMs / 1000)}s alone)`);

  const timer = setInterval(async () => {
    if (fired) return;
    const n = await count(page);
    if (n === null) return;               // unreadable ≠ empty; hold the current state

    // ONE other person is a meeting, not an empty room. This read as `n > 1` before, which made
    // every one-on-one look empty and walked the bot out of it after the grace period.
    if (n > 0) {
      if (aloneSince !== null) log(`[alone] ${n} other participant(s) — no longer alone`);
      aloneSince = null;
      return;
    }

    if (aloneSince === null) {
      aloneSince = now();
      log(`[alone] bot appears to be alone; leaving in ${Math.round(graceMs / 1000)}s unless someone joins`);
      return;
    }

    if (now() - aloneSince >= graceMs) {
      fired = true;
      clearInterval(timer);
      log(`[alone] alone for ${Math.round((now() - aloneSince) / 1000)}s — leaving`);
      try { await onAlone(); } catch { /* best-effort; the caller owns teardown */ }
    }
  }, pollMs);

  return () => clearInterval(timer);
}
