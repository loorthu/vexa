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
 * Real participant tiles, or `null` when the page could not be read.
 *
 * The null is load-bearing. A DOM read can fail transiently (navigation, a detached frame) and a
 * failure is NOT evidence of an empty meeting — treating it as zero would make a broken selector
 * or a page hiccup look identical to everyone leaving, and the bot would walk out of a live
 * meeting. Only a successful count is allowed to advance the alone timer.
 */
export async function countParticipantsOrNull(page: Page): Promise<number | null> {
  try {
    const labels = await page.locator("[data-participant-id]").evaluateAll(
      els => els.map(e => e.getAttribute("aria-label") || (e.textContent || "").trim()),
    );
    return labels.filter(l => l && !EFFECTS_TILE.test(l)).length;
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
  /** Injected for tests: the participant read. */
  count?: (page: Page) => Promise<number | null>;
}

/**
 * Fire `onAlone` once the bot has been the ONLY participant continuously for the grace period.
 *
 * The bot's own tile counts, so "alone" is <= 1. A grace period rather than an instant trip
 * because a count can dip legitimately — the last human reconnecting, a tile re-rendering — and
 * leaving on a blip would cut a live meeting short. The timer resets the moment anyone is seen.
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
  const count = opts.count ?? countParticipantsOrNull;

  let aloneSince: number | null = null;
  let fired = false;
  log(`[alone] monitoring participants (leave after ${Math.round(graceMs / 1000)}s alone)`);

  const timer = setInterval(async () => {
    if (fired) return;
    const n = await count(page);
    if (n === null) return;               // unreadable ≠ empty; hold the current state

    if (n > 1) {
      if (aloneSince !== null) log(`[alone] ${n} participants — no longer alone`);
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
