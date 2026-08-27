/**
 * L2 — the session browser's tab reaper (tab-reaper.ts), offline against a fake CDP.
 *
 * The leak it exists for: a bot force-exited or SIGKILLed never runs its teardown, so the tab it
 * opened in the SHARED session browser is never closed and they pile up (10 of them, ~2GB, when
 * this was written). Asserts the rules that make sweeping a HUMAN'S browser safe:
 *   • a left-behind meeting tab is closed — but only on the SECOND consecutive idle tick;
 *   • a bot sitting IN a meeting (/<code>) is never touched, however long it sits;
 *   • tabs that existed at session start (the human's own) are never touched;
 *   • sign-in pages are never touched — reaping one would kill a login in progress over VNC;
 *   • a tab that navigates back out of the landing page restarts its count;
 *   • a CDP that errors (listing or closing) costs nothing: no throw, retried next tick.
 * No browser, no network. Run: npx tsx src/tab-reaper.test.ts
 */
import { createTabReaper, isReapableUrl, type CdpTarget } from './tab-reaper.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const page = (id: string, url: string): CdpTarget => ({ id, type: 'page', url });

/** A fake CDP: a mutable target list plus a record of what got closed. */
const fakeCdp = (targets: CdpTarget[]) => {
  const state = { targets: [...targets], closed: [] as string[], listErr: null as Error | null, closeErr: null as Error | null };
  return {
    state,
    listTargets: async () => { if (state.listErr) throw state.listErr; return state.targets; },
    closeTarget: async (id: string) => {
      if (state.closeErr) throw state.closeErr;
      state.closed.push(id);
      state.targets = state.targets.filter((t) => t.id !== id);
    },
  };
};

const main = async () => {
  // ── URL rules ──
  check('meet /home is reapable', isReapableUrl('https://meet.google.com/home'));
  check('meet / is reapable', isReapableUrl('https://meet.google.com/'));
  check('a live meeting URL is NOT reapable', !isReapableUrl('https://meet.google.com/duv-anrv-ztp'));
  check('a sign-in page is NOT reapable',
    !isReapableUrl('https://accounts.google.com/v3/signin/challenge/pwd?TL=x'));
  check('a reauth bounce is NOT reapable', !isReapableUrl('https://meet.google.com/reauth?continue=x'));
  check('about:blank is NOT reapable', !isReapableUrl('about:blank'));

  // ── two ticks to reap a left-behind tab ──
  {
    const cdp = fakeCdp([page('own', 'https://meet.google.com/home'), page('bot', 'https://meet.google.com/home')]);
    const reaper = createTabReaper({
      protectedIds: new Set(['own']), listTargets: cdp.listTargets, closeTarget: cdp.closeTarget, log: () => {},
    });
    const first = await reaper.tick();
    check('first tick closes nothing (one sighting is not idle)', first.length === 0, JSON.stringify(first));
    const second = await reaper.tick();
    check('second consecutive tick closes the left-behind tab',
      second.length === 1 && second[0] === 'bot', JSON.stringify(second));
    check("the human's own tab survives", cdp.state.targets.some((t) => t.id === 'own'));
    const third = await reaper.tick();
    check('nothing left to close', third.length === 0);
  }

  // ── a bot in a live meeting is never reaped, no matter how many ticks ──
  {
    const cdp = fakeCdp([page('bot', 'https://meet.google.com/duv-anrv-ztp')]);
    const reaper = createTabReaper({
      protectedIds: new Set(), listTargets: cdp.listTargets, closeTarget: cdp.closeTarget, log: () => {},
    });
    for (let i = 0; i < 5; i++) await reaper.tick();
    check('a live meeting tab is never closed', cdp.state.closed.length === 0, JSON.stringify(cdp.state.closed));
  }

  // ── navigating back out of the landing page restarts the count ──
  {
    const cdp = fakeCdp([page('bot', 'https://meet.google.com/home')]);
    const reaper = createTabReaper({
      protectedIds: new Set(), listTargets: cdp.listTargets, closeTarget: cdp.closeTarget, log: () => {},
    });
    await reaper.tick();                                    // sighting 1
    cdp.state.targets = [page('bot', 'https://meet.google.com/abc-defg-hij')]; // joined a meeting
    await reaper.tick();
    cdp.state.targets = [page('bot', 'https://meet.google.com/home')];         // left again
    const afterReturn = await reaper.tick();
    check('the count restarts after a detour into a meeting', afterReturn.length === 0,
      JSON.stringify(afterReturn));
    const next = await reaper.tick();
    check('and reaps on the next consecutive idle tick', next.length === 1 && next[0] === 'bot');
  }

  // ── non-page targets (service workers, iframes) are ignored ──
  {
    const cdp = fakeCdp([
      { id: 'sw', type: 'service_worker', url: 'https://meet.google.com/home' },
      { id: 'if', type: 'iframe', url: 'https://meet.google.com/home' },
    ]);
    const reaper = createTabReaper({
      protectedIds: new Set(), listTargets: cdp.listTargets, closeTarget: cdp.closeTarget, log: () => {},
    });
    await reaper.tick(); await reaper.tick();
    check('only page targets are reaped', cdp.state.closed.length === 0, JSON.stringify(cdp.state.closed));
  }

  // ── a broken CDP is survivable ──
  {
    const cdp = fakeCdp([page('bot', 'https://meet.google.com/home')]);
    cdp.state.listErr = new Error('connection refused');
    const reaper = createTabReaper({
      protectedIds: new Set(), listTargets: cdp.listTargets, closeTarget: cdp.closeTarget, log: () => {},
    });
    const out = await reaper.tick();
    check('a failed listing is a quiet no-op', out.length === 0);

    cdp.state.listErr = null;
    cdp.state.closeErr = new Error('target already gone');
    await reaper.tick();
    const failedClose = await reaper.tick();
    check('a failed close does not throw and reports nothing closed', failedClose.length === 0);
    cdp.state.closeErr = null;
    const retried = await reaper.tick();
    check('and the tab is retried on the next tick', retried.length === 1 && retried[0] === 'bot');
  }
};

main().then(() => {
  if (failed) { console.error(`\n❌ tab-reaper (L2): ${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\n✅ tab-reaper (L2): left-behind meeting tabs are swept after two idle ticks, and live meetings, the human’s own tabs, and sign-in pages are left alone.');
});
