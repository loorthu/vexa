/**
 * attach — connect to an ALREADY-RUNNING browser over CDP instead of launching one.
 *
 * The dual of browser.ts. Where launchPersistentBrowser() owns a fresh Chromium whose
 * profile dir IS the session, attachOverCDP() borrows a long-lived session browser (the
 * one browser-session.sh keeps alive, logged in once over VNC) and opens a tab in its
 * existing context. The meeting bot drives that tab; the session browser — and the
 * human's login — outlives the meeting.
 *
 * Teardown is asymmetric on purpose (see disconnect()): closing the tab must NOT close
 * the context or the browser, or every finished meeting would kill the shared session.
 *
 * Uses `chromium` from 'playwright' directly, not 'playwright-extra': the stealth plugin
 * rewrites launch flags, which is meaningless for an attach — the target was already
 * launched (with getBrowserSessionArgs()) long before we connect.
 */
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

export interface CdpAttachment {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Close only the tab we opened, then drop the CDP connection. Leaves the remote
   *  browser and its context (the human's login) running. */
  disconnect(): Promise<void>;
}

export async function attachOverCDP(cdpUrl: string): Promise<CdpAttachment> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    async disconnect() {
      try {
        await page.close();
      } catch {
        // tab may already be gone; the session browser is what matters, leave it be.
      }
      // Drop the CDP connection. For a connectOverCDP() browser, close() disconnects
      // the client WITHOUT terminating the remote Chrome (proven in production) — the
      // shared session, and the human's login, keep running.
      if (browser.isConnected()) await browser.close();
    },
  };
}
