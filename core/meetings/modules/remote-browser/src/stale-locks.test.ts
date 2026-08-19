/**
 * cleanStaleLocks — a DANGLING lock symlink must be removed.
 *
 * FIELD BUG this pins: Chromium writes its singleton guards as SYMLINKS —
 * `SingletonLock -> <hostname>-<pid>`, and `SingletonSocket` into a per-run directory under /tmp.
 * When the container that wrote them is gone, those links dangle. The guard here used `existsSync`,
 * which FOLLOWS a symlink and therefore reports false for a dangling one — so the cleaner skipped
 * exactly the locks it exists to remove. The session container then restart-looped on
 *
 *   "The profile appears to be in use by another Chromium process (132) on another computer"
 *
 * until someone deleted them by hand. lstatSync inspects the link itself, so a dangling link is
 * still seen and removed.
 *
 * No assert lib — same tsx + exit-code shape as the sibling *.test.ts.
 */
import { mkdtempSync, symlinkSync, writeFileSync, existsSync, lstatSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanStaleLocks } from './session-store';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

/** Does the path exist as a link OR a file? (existsSync alone cannot answer for dangling links.) */
const present = (p: string): boolean => {
  try { lstatSync(p); return true; } catch { return false; }
};

const dir = mkdtempSync(join(tmpdir(), 'stale-locks-'));

// ── 1) THE REGRESSION: dangling symlinks, exactly as a dead container leaves them ──
{
  symlinkSync('ae740756bbac-132', join(dir, 'SingletonLock'));
  symlinkSync('7488988290125822199', join(dir, 'SingletonCookie'));
  symlinkSync('/tmp/.org.chromium.Chromium.20hlc2/SingletonSocket', join(dir, 'SingletonSocket'));

  // Precondition — this is WHY the old guard failed.
  check('precondition: existsSync is blind to a dangling link',
    existsSync(join(dir, 'SingletonLock')) === false);
  check('precondition: the link itself is really there', present(join(dir, 'SingletonLock')));

  cleanStaleLocks(dir);

  check('dangling SingletonLock removed', !present(join(dir, 'SingletonLock')));
  check('dangling SingletonCookie removed', !present(join(dir, 'SingletonCookie')));
  check('dangling SingletonSocket removed', !present(join(dir, 'SingletonSocket')));
}

// ── 2) A LIVE (resolvable) lock is removed too ──
// Relaunch in a fresh container is always a new Chromium, so leftovers are stale by definition.
{
  const target = join(dir, 'real-target');
  writeFileSync(target, 'x');
  symlinkSync(target, join(dir, 'SingletonLock'));
  cleanStaleLocks(dir);
  check('resolvable SingletonLock removed', !present(join(dir, 'SingletonLock')));
  check('its target is left alone', existsSync(target));
}

// ── 3) A PLAIN FILE lock is removed (not every platform uses symlinks) ──
{
  writeFileSync(join(dir, 'SingletonLock'), 'plain');
  cleanStaleLocks(dir);
  check('plain-file SingletonLock removed', !present(join(dir, 'SingletonLock')));
}

// ── 4) CLEAN PROFILE + MISSING DIR are both no-ops, not throws ──
{
  let threw = false;
  try { cleanStaleLocks(dir); } catch { threw = true; }
  check('no locks present → no throw', !threw);

  const gone = join(dir, 'does-not-exist');
  threw = false;
  try { cleanStaleLocks(gone); } catch { threw = true; }
  check('missing profile dir → no throw', !threw);
}

// ── 5) THE PROFILE ITSELF IS UNTOUCHED — the login must survive a lock sweep ──
{
  mkdirSync(join(dir, 'Default'), { recursive: true });
  writeFileSync(join(dir, 'Default', 'cdp-cookies.json'), '[{"name":"SID"}]');
  symlinkSync('deadhost-1', join(dir, 'SingletonLock'));
  cleanStaleLocks(dir);
  check('saved cookies survive the sweep', existsSync(join(dir, 'Default', 'cdp-cookies.json')));
}

rmSync(dir, { recursive: true, force: true });

console.log(failed === 0 ? '\n✅ stale-locks — all checks passed' : `\n❌ stale-locks — ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
