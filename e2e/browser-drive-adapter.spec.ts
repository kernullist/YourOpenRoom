import { test, expect, chromium, type Browser } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

import {
  attachAoiBrowserDriveDialogs,
  attachAoiBrowserDriveTabs,
  downloadAoiBrowserDriveFile,
  type AoiBrowserDriveDownloadablePage,
  type AoiBrowserDriveRawContext,
  type AoiBrowserDriveRawPage,
} from '../apps/webuiapps/src/lib/aoiBrowserDrivePageAdapter';

// Verification against a REAL browser.
//
// The adapter exists because three things are not plain Page methods: dialogs
// arrive as an event, tabs live on the context, and a download is discarded
// unless something saves it. Every other test for it runs against a fake that I
// wrote from reading the Playwright docs -- which means those tests prove the
// adapter matches my belief about Playwright, not that the belief is true. That
// gap is exactly where the last round of bugs lived (methods declared on an
// interface that the real page did not have), so it is worth closing with an
// actual browser.
//
// Deliberately NOT the operator's logged-in browser: a local page exercises the
// same API surface with no account, no network and nothing to damage.

const PAGE_HTML = `
<!doctype html>
<html><body>
  <h1>adapter fixture</h1>
  <button id="open-tab" onclick="window.open('about:blank#second', '_blank')">open a tab</button>
  <button id="ask" onclick="window.__answer = confirm('Delete this draft?')">confirm</button>
  <button id="prompt" onclick="window.__typed = prompt('Type a name', '')">prompt</button>
  <a id="save" download="report.txt"
     href="data:text/plain;charset=utf-8,hello%20from%20aoi">download</a>
</body></html>`;

let browser: Browser;

test.beforeAll(async () => {
  browser = await chromium.launch();
});

test.afterAll(async () => {
  await browser?.close();
});

test.describe('browser-drive adapter against a real browser', () => {
  test('answers a real confirm() and reports what it said', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(PAGE_HTML);

    const dialogs = attachAoiBrowserDriveDialogs(page as unknown as AoiBrowserDriveRawPage);
    // The click raises the dialog and BLOCKS the page until it is answered, so
    // the click cannot be awaited before answering.
    void page.click('#ask');
    const message = await dialogs.answerDialog('accept');

    expect(message).toBe('Delete this draft?');
    await expect.poll(() => page.evaluate(() => (window as any).__answer)).toBe(true);
    await context.close();
  });

  test('dismissing a real confirm() returns false to the page', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(PAGE_HTML);
    const dialogs = attachAoiBrowserDriveDialogs(page as unknown as AoiBrowserDriveRawPage);

    void page.click('#ask');
    await dialogs.answerDialog('dismiss');
    await expect.poll(() => page.evaluate(() => (window as any).__answer)).toBe(false);
    await context.close();
  });

  test('accepting a real prompt() delivers the text', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(PAGE_HTML);
    const dialogs = attachAoiBrowserDriveDialogs(page as unknown as AoiBrowserDriveRawPage);

    void page.click('#prompt');
    await dialogs.answerDialog('accept', 'Aoi');
    await expect.poll(() => page.evaluate(() => (window as any).__typed)).toBe('Aoi');
    await context.close();
  });

  test('an unclaimed dialog is dismissed instead of wedging the tab', async () => {
    // Attaching a listener removes Playwright's auto-dismiss. If nothing then
    // answers, the page stays blocked forever -- worse than no dialog support.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(PAGE_HTML);
    attachAoiBrowserDriveDialogs(page as unknown as AoiBrowserDriveRawPage, {
      abandonAfterMs: 250,
    });

    void page.click('#ask');
    // The page is unblocked again only because the abandon path dismissed it.
    await expect
      .poll(() => page.evaluate(() => (window as any).__answer), {
        timeout: 10_000,
      })
      .toBe(false);
    await context.close();
  });

  test('sees a tab the page opened and routes delivery to it', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(PAGE_HTML);

    const tabs = attachAoiBrowserDriveTabs(
      context as unknown as AoiBrowserDriveRawContext,
      page as unknown as AoiBrowserDriveRawPage,
    );
    await page.click('#open-tab');
    await expect.poll(async () => (await tabs.listTabs()).length).toBe(2);

    const before = await tabs.listTabs();
    expect(before.find((tab) => tab.current)?.index).toBe(0);

    await tabs.selectTab(1);
    const after = await tabs.listTabs();
    expect(after.find((tab) => tab.current)?.index).toBe(1);
    // The whole point: later work addresses the new tab.
    expect(tabs.currentPage().url()).toContain('#second');

    // And containment can get back without touching the other tab.
    tabs.returnToOwnTab();
    expect(tabs.isOnOwnTab()).toBe(true);
    await context.close();
  });

  test('saves a real download and reports where it landed', async () => {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await page.setContent(PAGE_HTML);

    const directory = fs.mkdtempSync(join(os.tmpdir(), 'aoi-download-'));
    const saved = await downloadAoiBrowserDriveFile(
      page as unknown as AoiBrowserDriveDownloadablePage,
      '#save',
      directory,
      { timeout: 15_000 },
    );

    expect(saved.suggestedFilename).toBe('report.txt');
    // The file has to actually be there: a click that merely did not throw is
    // exactly the failure this whole contract exists to catch.
    expect(fs.existsSync(saved.path)).toBe(true);
    expect(fs.readFileSync(saved.path, 'utf-8')).toBe('hello from aoi');

    fs.rmSync(directory, { recursive: true, force: true });
    await context.close();
  });
});

// The session does not hand the executor a bare Page: it REPLACES the methods
// the executor calls so they follow the selected tab. That rewriting is the part
// a fake cannot check honestly -- the fake's methods are ordinary properties,
// while a real Page carries internal state through `this` and inherits from a
// prototype. Both of those are ways the rewrite can be subtly wrong while every
// unit test still passes.
test.describe('the session page rewrite works on a real Playwright page', () => {
  // A trimmed copy of what the session does, so this exercises the same shape
  // without needing a launched Chrome on a debug port.
  function wrapLikeSession(page: any, context: any) {
    const tabs = attachAoiBrowserDriveTabs(
      context as AoiBrowserDriveRawContext,
      page as AoiBrowserDriveRawPage,
    );
    const own = page as Record<string, unknown>;
    const target = () => tabs.currentPage() as unknown as Record<string, unknown>;
    const originals = new Map<string, (...args: unknown[]) => unknown>();
    const forward =
      (method: string) =>
      (...args: unknown[]) => {
        const current = target();
        const fn = current === own ? originals.get(method) : (current[method] as unknown);
        if (typeof fn !== 'function') {
          throw new Error(`the current tab cannot ${method}`);
        }
        return (fn as (...inner: unknown[]) => unknown).apply(current, args);
      };
    for (const method of ['click', 'title', 'content']) {
      const existing = own[method];
      if (typeof existing === 'function') {
        originals.set(method, (existing as (...a: unknown[]) => unknown).bind(page));
        own[method] = forward(method);
      }
    }
    const ownUrl = own.url;
    originals.set('url', (ownUrl as (...a: unknown[]) => unknown).bind(page));
    own.url = () => {
      const current = target();
      const fn = current === own ? originals.get('url') : current.url;
      return typeof fn === 'function' ? (fn as () => string).call(current) : '';
    };
    return { tabs, driven: own };
  }

  test('acts on its OWN tab without recursing into itself', async () => {
    // The rewritten method lives on the very object it forwards to, so looking
    // the method up on the current page finds the forwarder. That is not an edge
    // case -- it is every ordinary act, since most drives never switch tabs.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(PAGE_HTML);
    const { driven } = wrapLikeSession(page, context);

    await (driven.click as (s: string) => Promise<void>)('#ask');
    // Reaching here at all is the assertion: the un-fixed version dies with
    // "Maximum call stack size exceeded".
    expect(typeof (driven.url as () => string)()).toBe('string');
    await context.close();
  });

  test('follows the selected tab and comes back', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(PAGE_HTML);
    const { tabs, driven } = wrapLikeSession(page, context);

    await (driven.click as (s: string) => Promise<void>)('#open-tab');
    await expect.poll(async () => (await tabs.listTabs()).length).toBe(2);

    await tabs.selectTab(1);
    expect((driven.url as () => string)()).toContain('#second');
    // Real Playwright methods keep internal state on `this`; calling one bound
    // to the wrong page throws rather than acting on the wrong document.
    await expect((driven.title as () => Promise<string>)()).resolves.toBeDefined();

    tabs.returnToOwnTab();
    expect((driven.url as () => string)()).not.toContain('#second');
    await context.close();
  });
});
