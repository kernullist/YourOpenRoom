import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

import {
  startAoiBrowserDriveSession,
  type AoiBrowserDriveSession,
} from '../apps/webuiapps/src/lib/aoiBrowserDriveSession';
import { resolveAoiHostBrowserExecutable } from '../apps/webuiapps/src/lib/aoiHostBrowserRead';

// The installed Chrome or Edge -- what browser drive really launches. Playwright's
// own build is not a stand-in here: the behavior under test is the real
// browser's single-instance hand-off. Headless, on a throwaway profile, so the
// operator's own browser and profile are never involved.
const systemBrowser = resolveAoiHostBrowserExecutable();

// A REAL browser, for the one behavior a fake cannot show: what Chrome does when
// a session starts on a profile whose browser is already running.
//
// Closing a session leaves the browser up on purpose (the operator may be using
// it), and every act opens a fresh session. A second launch on the same profile
// hands its command line to the running browser and exits, so it never opens
// the debug port it was given -- which made an approved execute fail right
// after its preview. The second session has to find the running browser and
// attach to it.

test.describe('browser-drive session on a profile that is already running', () => {
  test.describe.configure({ timeout: 90_000 });

  let profileDir = '';
  const sessions: AoiBrowserDriveSession[] = [];
  // The sessions that launched a browser process, so it can be stopped at the
  // end: the browser outlives its sessions by design.
  const launched: AoiBrowserDriveSession[] = [];

  test.beforeEach(() => {
    profileDir = fs.mkdtempSync(join(os.tmpdir(), 'aoi-drive-profile-'));
  });

  test.afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.close().catch(() => undefined);
    }
    for (const session of launched.splice(0)) {
      session.child?.kill();
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      }
    }
  });

  test('a second session attaches to the browser the first one left running', async () => {
    test.skip(!systemBrowser, 'no Chrome or Edge is installed on this machine');
    const options = {
      engine: systemBrowser?.engine.startsWith('edge') ? ('edge' as const) : ('chrome' as const),
      userDataDir: profileDir,
      headless: true,
      browserExecutablePath: systemBrowser?.path,
      timeoutMs: 30_000,
    };

    const first = await startAoiBrowserDriveSession(options);
    sessions.push(first);
    launched.push(first);
    expect(first.child).not.toBeNull();
    await (first.page as unknown as Page).goto('data:text/html,<title>first</title>');
    await first.close();

    const second = await startAoiBrowserDriveSession(options);
    sessions.push(second);
    // Attached, not launched: no new process, and the same debug port.
    expect(second.child).toBeNull();
    expect(second.port).toBe(first.port);
    const page = second.page as unknown as Page;
    await page.goto('data:text/html,<title>second</title>');
    expect(await page.title()).toBe('second');
  });
});
