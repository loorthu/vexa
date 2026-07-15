/**
 * session — the long-lived, human-authenticated browser the meeting bots attach to.
 *
 * The dual of index.ts (the meeting worker). Where the worker boots → joins → dies, this runner
 * boots ONE persistent Chromium with VNC + CDP exposed and then STAYS UP: a human logs into Google
 * once over VNC (noVNC :6080), and every authenticated meeting bot later borrows this browser over
 * CDP (:9222) via capture-bridge's attachOverCDP — so no bot ever fights Google's login/bot-detection.
 *
 * Run as the bot image's worker entry with BOT_WORKER_ENTRY=dist/session.js (entrypoint.sh brings up
 * the same Xvfb/PulseAudio/fluxbox env this headful browser needs). Started + supervised by
 * deploy/compose/bin/browser-session.sh, NOT by meeting-api — a browser_session is infra, not a meeting,
 * so it is deliberately NOT an invocation.v1 payload (no sealed-contract coupling).
 *
 * Persistence: BROWSER_DATA_DIR is a mounted docker volume, so the profile (localStorage / Login Data)
 * survives restarts on its own. The ONE thing Chromium keeps memory-only — SESSION cookies, which
 * Google's auth relies on — is snapshotted to JSON (saveCdpCookies) and re-injected on next launch, so
 * the login survives a container restart, even an ungraceful SIGKILL (bounded by the auto-save period).
 */
import {
  launchPersistentBrowser,
  getBrowserSessionArgs,
  ensureBrowserDataDir,
  cleanStaleLocks,
  saveCdpCookies,
  loadCdpCookies,
  validateLoggedIn,
  AUTH_LOGIN_URLS,
  BROWSER_DATA_DIR,
  type AuthPlatform,
} from '@vexa/remote-browser';
import { startDebugView } from '@vexa/join';
import { spawn, type ChildProcess } from 'child_process';

const SAVE_INTERVAL_MS = Number(process.env.SESSION_SAVE_INTERVAL_MS || 60_000);
// The port meeting bots attach to from OTHER containers. Chrome (v128+) ignores
// --remote-debugging-address and binds :9222 to 127.0.0.1 ONLY (security hardening), so CDP is
// unreachable across the docker network. A socat relay re-exposes it on 0.0.0.0:CDP_RELAY_PORT →
// 127.0.0.1:9222 — exactly what remote-browser/args.ts's CDP_DEBUG_ARGS comment anticipates. Bots
// connect to http://vexa-browser-session-<uid>:9223 (meeting-api's BROWSER_SESSION_CDP_PORT).
const CDP_RELAY_PORT = Number(process.env.CDP_RELAY_PORT || 9223);
const CHROME_CDP_PORT = 9222;

function startCdpRelay(): ChildProcess {
  const relay = spawn('socat', [
    `TCP-LISTEN:${CDP_RELAY_PORT},fork,reuseaddr`,
    `TCP:127.0.0.1:${CHROME_CDP_PORT}`,
  ], { stdio: 'ignore' });
  relay.on('error', (err) => console.log(`[browser-session] CDP relay (socat) failed to start: ${err.message}`));
  relay.on('exit', (code) => { if (code) console.log(`[browser-session] CDP relay exited with code ${code}`); });
  return relay;
}

function resolvePlatform(): AuthPlatform {
  const p = (process.env.SESSION_PLATFORM || 'google').toLowerCase();
  return (p === 'zoom' || p === 'teams' || p === 'google') ? p : 'google';
}

export async function runSession(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dataDir = env.BROWSER_DATA_DIR || BROWSER_DATA_DIR;
  const platform = resolvePlatform();

  ensureBrowserDataDir(dataDir);
  // A prior run killed mid-flight can leave a SingletonLock that makes Chromium open in "existing
  // session" mode and exit; clear it before launch (same hazard the meeting bots guard against).
  cleanStaleLocks(dataDir);

  // getBrowserSessionArgs() carries the VNC-friendly + CDP_DEBUG_ARGS (9222 on 0.0.0.0) set — the
  // exact flags capture-bridge's attach path RELIES on the session browser already having, since a
  // CDP attach does not (and cannot) re-apply launch flags.
  const { context, page } = await launchPersistentBrowser({ dataDir, args: getBrowserSessionArgs() });

  // Re-inject session cookies captured by the previous run (memory-only cookies Chromium never wrote
  // to the profile on disk). Must happen before navigation so the login is live on first paint.
  const saved = loadCdpCookies(dataDir);
  if (saved && saved.length > 0) {
    try {
      await context.addCookies(saved);
      console.log(`[browser-session] Restored ${saved.length} session cookies`);
    } catch (err: any) {
      console.log(`[browser-session] Warning: cookie restore failed: ${err.message}`);
    }
  }

  // Land on the platform's login page so a human attaching over VNC sees where to sign in (or, if the
  // restored session is still valid, their signed-in account — a no-op they can confirm at a glance).
  try {
    await page.goto(AUTH_LOGIN_URLS[platform], { waitUntil: 'domcontentloaded' });
  } catch (err: any) {
    console.log(`[browser-session] Warning: initial navigation failed: ${err.message}`);
  }

  // Bring up the live view so a human can drive this browser over noVNC. Reuses the join layer's
  // own VNC stack (x11vnc :5900 + websockify/noVNC :6080) — the same one CDP_DEBUG_ARGS already
  // opened :9222 for. The meeting bots never call this; it is the session's whole point.
  const view = await startDebugView().catch((err: any) => {
    console.log(`[browser-session] Warning: VNC bringup failed: ${err.message}`);
    return null;
  });

  // Expose Chrome's loopback-only CDP to the docker network for meeting bots to attach.
  const cdpRelay = startCdpRelay();

  const status = await validateLoggedIn(page, platform).catch(() => null);
  console.log(`[browser-session] Ready. platform=${platform} loggedIn=${status?.loggedIn ?? 'unknown'}`);
  console.log(`[browser-session] noVNC ${view?.novncUrl ?? ':6080'} (log in here) · CDP :${CDP_RELAY_PORT} (bots attach here)`);
  console.log(`[browser-session] Profile: ${dataDir}`);

  // Snapshot the live cookie set so a restart recovers the login. Also runs on graceful stop below;
  // the interval bounds how much a hard SIGKILL can lose (default ≤60s of freshly-set cookies).
  const snapshot = async (reason: string) => {
    try {
      saveCdpCookies(await context.cookies(), dataDir);
    } catch (err: any) {
      console.log(`[browser-session] cookie snapshot (${reason}) failed: ${err.message}`);
    }
  };
  const autoSave = setInterval(() => { void snapshot('auto'); }, SAVE_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[browser-session] ${sig} — snapshotting cookies and closing...`);
    clearInterval(autoSave);
    cdpRelay.kill();
    await snapshot('shutdown');
    // Closing the persistent context flushes the profile to the mounted volume.
    await context.close().catch(() => { /* best-effort */ });
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  // Stay up until a signal arrives.
  await new Promise<void>(() => { /* never resolves */ });
}

// Worker entry: browser-session.sh runs the bot image with BOT_WORKER_ENTRY=dist/session.js, so the
// container's entrypoint execs `node dist/session.js` and this runs at module top level.
if (import.meta.url === `file://${process.argv[1]}`) {
  runSession().catch((e) => { console.error(e); process.exit(1); });
}
