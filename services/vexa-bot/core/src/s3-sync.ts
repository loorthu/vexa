import { execSync } from 'child_process';
import { existsSync, unlinkSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';

export const BROWSER_DATA_DIR = '/tmp/browser-data';

export const BROWSER_CACHE_EXCLUDES = [
  '*/Cache/*', '*/Code Cache/*', '*/GrShaderCache/*', '*/ShaderCache/*', '*/GraphiteDawnCache/*',
  '*/Service Worker/*', '*BrowserMetrics*',
  'SingletonLock', 'SingletonCookie', 'SingletonSocket',
  '*/GPUCache/*', '*/DawnGraphiteCache/*', '*/DawnWebGPUCache/*',
  '*/blob_storage/*', '*/File System/*', '*/IndexedDB/*',
];

export const CDP_COOKIES_FILE = 'Default/cdp-cookies.json';

export interface S3Config {
  userdataS3Path?: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  localUserdataPath?: string;
}

function getS3Env(config: S3Config): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    AWS_ACCESS_KEY_ID: config.s3AccessKey || '',
    AWS_SECRET_ACCESS_KEY: config.s3SecretKey || '',
  };
}

export function s3Sync(localDir: string, s3Path: string, config: S3Config, direction: 'up' | 'down', excludes: string[] = []): void {
  if (!config.userdataS3Path || !config.s3Endpoint || !config.s3Bucket) return;
  const s3Uri = `s3://${config.s3Bucket}/${s3Path}`;
  const excludeArgs = excludes.map(e => `--exclude "${e}"`).join(' ');
  const deleteArg = '';
  const [src, dst] = direction === 'down' ? [s3Uri, `${localDir}/`] : [`${localDir}/`, s3Uri];
  console.log(`[s3-sync] S3 sync ${direction}: ${src} → ${dst}`);
  execSync(
    `aws s3 sync "${src}" "${dst}" --endpoint-url "${config.s3Endpoint}" ${deleteArg} ${excludeArgs}`,
    { env: getS3Env(config), stdio: 'inherit', timeout: 300000 }
  );
}

export function syncBrowserDataFromS3(config: S3Config): void {
  s3Sync(BROWSER_DATA_DIR, `${config.userdataS3Path}/browser-data`, config, 'down', BROWSER_CACHE_EXCLUDES);
}

// Upload only auth-essential files via individual cp commands.
// ~200KB total, takes <2 seconds vs minutes for full sync.
const AUTH_ESSENTIAL_FILES = [
  'Local State',
  'Default/Cookies',
  'Default/Cookies-journal',
  'Default/Preferences',
  'Default/Secure Preferences',
  'Default/Login Data',
  'Default/Login Data-journal',
  'Default/Login Data For Account',
  'Default/Login Data For Account-journal',
  'Default/Network Persistent State',
  'Default/Web Data',
  CDP_COOKIES_FILE,
];

const AUTH_ESSENTIAL_DIRS = [
  'Default/Local Storage',
  'Default/Session Storage',
];

export function syncBrowserDataToS3(config: S3Config): void {
  if (!config.userdataS3Path || !config.s3Endpoint || !config.s3Bucket) return;
  const s3Base = `s3://${config.s3Bucket}/${config.userdataS3Path}/browser-data`;
  const env = getS3Env(config);
  const endpoint = `--endpoint-url "${config.s3Endpoint}"`;
  let uploaded = 0;

  console.log(`[s3-sync] S3 save (auth-essential files only)...`);

  for (const file of AUTH_ESSENTIAL_FILES) {
    const local = join(BROWSER_DATA_DIR, file);
    if (!existsSync(local)) continue;
    try {
      execSync(`aws s3 cp "${local}" "${s3Base}/${file}" ${endpoint}`, { env, stdio: 'pipe', timeout: 10000 });
      uploaded++;
    } catch (err: any) {
      console.log(`[s3-sync] Warning: failed to upload ${file}: ${err.message}`);
    }
  }

  for (const dir of AUTH_ESSENTIAL_DIRS) {
    const local = join(BROWSER_DATA_DIR, dir);
    if (!existsSync(local)) continue;
    try {
      execSync(`aws s3 sync "${local}/" "${s3Base}/${dir}/" ${endpoint}`, { env, stdio: 'pipe', timeout: 10000 });
      uploaded++;
    } catch (err: any) {
      console.log(`[s3-sync] Warning: failed to sync ${dir}: ${err.message}`);
    }
  }

  console.log(`[s3-sync] Uploaded ${uploaded} auth-essential items`);
}

// --- CDP cookie export/import (fixes session cookie persistence) ---
// Chromium only persists cookies with Expires/Max-Age to disk. Google uses
// session cookies (in-memory only), so we export all cookies via CDP before
// each save and restore them via addCookies() after the browser launches.

export function saveCdpCookies(cookies: object[]): void {
  const cookiesPath = join(BROWSER_DATA_DIR, CDP_COOKIES_FILE);
  mkdirSync(dirname(cookiesPath), { recursive: true });
  writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
  console.log(`[cdp-cookies] Saved ${cookies.length} cookies`);
}

export function loadCdpCookies(): object[] | null {
  const cookiesPath = join(BROWSER_DATA_DIR, CDP_COOKIES_FILE);
  if (!existsSync(cookiesPath)) return null;
  try {
    const cookies = JSON.parse(readFileSync(cookiesPath, 'utf-8'));
    console.log(`[cdp-cookies] Loaded ${cookies.length} cookies`);
    return cookies;
  } catch (err: any) {
    console.log(`[cdp-cookies] Warning: failed to parse cdp-cookies.json: ${err.message}`);
    return null;
  }
}

// --- Local filesystem sync (alternative to S3 for local dev) ---

export function syncBrowserDataFromLocal(localPath: string): void {
  const src = join(localPath, 'browser-data');
  if (!existsSync(src)) {
    console.log(`[local-sync] No existing data at ${src}, starting fresh`);
    return;
  }
  mkdirSync(BROWSER_DATA_DIR, { recursive: true });
  try {
    execSync(`cp -a "${src}/." "${BROWSER_DATA_DIR}/"`, { stdio: 'pipe' });
    console.log(`[local-sync] Restored browser data from ${src}`);
  } catch (err: any) {
    console.log(`[local-sync] Warning: restore failed: ${err.message}`);
  }
}

export function syncBrowserDataToLocal(localPath: string): void {
  const dst = join(localPath, 'browser-data');
  let saved = 0;

  for (const file of AUTH_ESSENTIAL_FILES) {
    const src = join(BROWSER_DATA_DIR, file);
    if (!existsSync(src)) continue;
    const dstFile = join(dst, file);
    mkdirSync(dirname(dstFile), { recursive: true });
    try {
      copyFileSync(src, dstFile);
      saved++;
    } catch (err: any) {
      console.log(`[local-sync] Warning: failed to copy ${file}: ${err.message}`);
    }
  }

  for (const dir of AUTH_ESSENTIAL_DIRS) {
    const src = join(BROWSER_DATA_DIR, dir);
    if (!existsSync(src)) continue;
    const dstDir = join(dst, dir);
    try {
      mkdirSync(dstDir, { recursive: true });
      execSync(`cp -a "${src}/." "${dstDir}/"`, { stdio: 'pipe' });
      saved++;
    } catch (err: any) {
      console.log(`[local-sync] Warning: failed to sync ${dir}: ${err.message}`);
    }
  }

  console.log(`[local-sync] Saved ${saved} auth-essential items to ${dst}`);
}

export function cleanStaleLocks(dir: string = BROWSER_DATA_DIR): void {
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  for (const f of lockFiles) {
    const p = join(dir, f);
    if (existsSync(p)) {
      try { unlinkSync(p); } catch {}
      console.log(`[s3-sync] Removed stale lock: ${f}`);
    }
  }
}

export function ensureBrowserDataDir(): void {
  mkdirSync(BROWSER_DATA_DIR, { recursive: true });
}
