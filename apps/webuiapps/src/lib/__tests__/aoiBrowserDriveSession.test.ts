import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import {
  AoiBrowserDriveStartError,
  pickFreeLoopbackPort,
  pollForAoiDevToolsActivePort,
  startAoiBrowserDriveSession,
  type AoiBrowserDriveBrowser,
  type AoiBrowserDrivePage,
  type AoiBrowserDriveSessionDeps,
} from '../aoiBrowserDriveSession';

describe('pickFreeLoopbackPort', () => {
  it('binds and releases an ephemeral loopback port', async () => {
    const port = await pickFreeLoopbackPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65_535);
  });
});

function fakeChild(): ChildProcess {
  const emitter = new EventEmitter() as unknown as ChildProcess & { killed: boolean };
  emitter.kill = vi.fn(() => {
    (emitter as unknown as { killed: boolean }).killed = true;
    return true;
  }) as unknown as ChildProcess['kill'];
  return emitter;
}

function fakePage(): AoiBrowserDrivePage & { closed: boolean } {
  const page = {
    closed: false,
    url: () => 'about:blank',
    close: vi.fn(async () => {
      page.closed = true;
    }),
  };
  return page as AoiBrowserDrivePage & { closed: boolean };
}

function fakeBrowser(
  page: AoiBrowserDrivePage,
): AoiBrowserDriveBrowser & { closedBrowser: boolean } {
  const browser = {
    closedBrowser: false,
    contexts: () => [{ newPage: async () => page }],
    isConnected: () => true,
    close: vi.fn(async () => {
      browser.closedBrowser = true;
    }),
  };
  return browser as unknown as AoiBrowserDriveBrowser & { closedBrowser: boolean };
}

function happyDeps(overrides: Partial<AoiBrowserDriveSessionDeps> = {}): {
  deps: AoiBrowserDriveSessionDeps;
  page: AoiBrowserDrivePage & { closed: boolean };
  browser: AoiBrowserDriveBrowser & { closedBrowser: boolean };
  child: ChildProcess;
} {
  const page = fakePage();
  const browser = fakeBrowser(page);
  const child = fakeChild();
  const deps: AoiBrowserDriveSessionDeps = {
    spawnImpl: vi.fn(() => child) as unknown as AoiBrowserDriveSessionDeps['spawnImpl'],
    resolveExecutable: () => ({ path: 'C:\\chrome.exe', engine: 'chrome' }),
    resolveDefaultUserDataDir: () => 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data',
    pickPort: async () => 51222,
    fileExists: () => true,
    readFile: () => '51222\n/devtools/browser/abc',
    connect: async () => browser,
    now: () => 1_000,
    sleep: async () => undefined,
    ...overrides,
  };
  return { deps, page, browser, child };
}

describe('pollForAoiDevToolsActivePort', () => {
  it('returns the parsed handshake once the file is valid', async () => {
    let calls = 0;
    const result = await pollForAoiDevToolsActivePort({
      userDataDir: '/data',
      timeoutMs: 5_000,
      fileExists: () => true,
      readFile: () => {
        calls += 1;
        // First read is mid-write (unparseable), second is valid.
        return calls === 1 ? '' : '9333\n/devtools/browser/x';
      },
      now: () => 0,
      sleep: async () => undefined,
    });
    expect(result).toEqual({ port: 9333, wsPath: '/devtools/browser/x' });
    expect(calls).toBe(2);
  });

  it('throws attach_timeout when the file never appears', async () => {
    let clock = 0;
    await expect(
      pollForAoiDevToolsActivePort({
        userDataDir: '/data',
        timeoutMs: 300,
        fileExists: () => false,
        readFile: () => '',
        now: () => {
          const value = clock;
          clock += 200;
          return value;
        },
        sleep: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(AoiBrowserDriveStartError);
  });
});

describe('startAoiBrowserDriveSession', () => {
  it('launches, attaches, opens an Aoi page, and closes only the page', async () => {
    const { deps, page, browser } = happyDeps();
    const session = await startAoiBrowserDriveSession({ engine: 'chrome' }, deps);
    expect(session.port).toBe(51222);
    expect(session.cdpHttpEndpoint).toBe('http://127.0.0.1:51222');
    expect(session.engine).toBe('chrome');
    expect(session.page).toBe(page);

    await session.close();
    expect(page.closed).toBe(true);
    // The shared browser is never closed by teardown.
    expect(browser.closedBrowser).toBe(false);
    // Idempotent close.
    await session.close();
  });

  it('passes the pinned launch args to spawn', async () => {
    const { deps } = happyDeps();
    await startAoiBrowserDriveSession({ engine: 'chrome', userDataDir: '/profile' }, deps);
    const spawnMock = deps.spawnImpl as unknown as ReturnType<typeof vi.fn>;
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--remote-debugging-port=51222');
    expect(args).toContain('--remote-allow-origins=http://127.0.0.1:51222');
    expect(args).toContain('--user-data-dir=/profile');
  });

  it('fails browser_not_found when no executable resolves', async () => {
    const { deps } = happyDeps({ resolveExecutable: () => null });
    await expect(startAoiBrowserDriveSession({}, deps)).rejects.toMatchObject({
      reason: 'browser_not_found',
    });
  });

  it('fails user_data_dir_unresolved when no dir resolves', async () => {
    const { deps } = happyDeps({ resolveDefaultUserDataDir: () => null });
    await expect(startAoiBrowserDriveSession({}, deps)).rejects.toMatchObject({
      reason: 'user_data_dir_unresolved',
    });
  });

  it('fails port_unavailable when a free port cannot be picked', async () => {
    const { deps } = happyDeps({
      pickPort: async () => {
        throw new Error('no port');
      },
    });
    await expect(startAoiBrowserDriveSession({}, deps)).rejects.toMatchObject({
      reason: 'port_unavailable',
    });
  });

  it('fails spawn_failed and never leaks when spawn throws', async () => {
    const { deps } = happyDeps({
      spawnImpl: vi.fn(() => {
        throw new Error('ENOENT');
      }) as unknown as AoiBrowserDriveSessionDeps['spawnImpl'],
    });
    await expect(startAoiBrowserDriveSession({}, deps)).rejects.toMatchObject({
      reason: 'spawn_failed',
    });
  });

  it('kills the child and fails attach_timeout when the handshake never lands', async () => {
    let clock = 0;
    const { deps, child } = happyDeps({
      fileExists: () => false,
      // Advancing clock so the bounded poll actually reaches its deadline.
      now: () => {
        const value = clock;
        clock += 500;
        return value;
      },
    });
    await expect(startAoiBrowserDriveSession({ timeoutMs: 1_000 }, deps)).rejects.toMatchObject({
      reason: 'attach_timeout',
    });
    expect(child.kill as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it('kills the child and fails connect_failed when CDP connect throws', async () => {
    const { deps, child } = happyDeps({
      connect: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(startAoiBrowserDriveSession({}, deps)).rejects.toMatchObject({
      reason: 'connect_failed',
    });
    expect(child.kill as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it('closes the browser (not killing the child) when opening a page fails', async () => {
    const page = fakePage();
    const browser = fakeBrowser(page);
    browser.contexts = () => [
      {
        newPage: async () => {
          throw new Error('no target');
        },
      },
    ];
    const { deps } = happyDeps({ connect: async () => browser });
    await expect(startAoiBrowserDriveSession({}, deps)).rejects.toMatchObject({
      reason: 'connect_failed',
    });
    expect(browser.closedBrowser).toBe(true);
  });
});

// Playwright gives a Page click/fill/hover/dragAndDrop/setInputFiles directly,
// but dialogs arrive as an EVENT and tabs live on the context. Those two were
// declared on the executor's page interface and gated and tested against a fake
// -- while the real session handed over a plain Page that had neither, so every
// dialog and tab step refused at runtime. These pin that the session actually
// supplies them.
describe('the session supplies the capabilities Playwright does not', () => {
  function playwrightishPage(url: string) {
    let dialogHandler: ((dialog: unknown) => void) | null = null;
    const page = {
      closed: false,
      url: () => url,
      on: (_event: string, handler: (dialog: unknown) => void) => {
        dialogHandler = handler;
      },
      title: async () => `title ${url}`,
      bringToFront: async () => {},
      click: vi.fn(async () => `clicked ${url}`),
      close: vi.fn(async () => {
        page.closed = true;
      }),
      fire: (dialog: unknown) => dialogHandler?.(dialog),
    };
    return page;
  }

  it('exposes dialog and tab methods, and routes delivery to the selected tab', async () => {
    const first = playwrightishPage('https://example.com/a');
    const second = playwrightishPage('https://example.com/b');
    const browser = {
      closedBrowser: false,
      contexts: () => [{ newPage: async () => first, pages: () => [first, second] }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;

    const { deps } = happyDeps({ connect: async () => browser });
    // The session REPLACES members on the page it returns in order to forward
    // them, so the original spy has to be captured first or the assertion below
    // would be checking the forwarder against itself.
    const firstClick = first.click;
    const session = await startAoiBrowserDriveSession({ engine: 'chrome' }, deps);
    const driven = session.page as unknown as Record<string, unknown>;

    expect(typeof driven.answerDialog).toBe('function');
    expect(typeof driven.listTabs).toBe('function');
    expect(typeof driven.selectTab).toBe('function');

    const tabs = await (driven.listTabs as () => Promise<{ index: number; current: boolean }[]>)();
    expect(tabs.map((tab) => tab.index)).toEqual([0, 1]);
    expect(tabs.find((tab) => tab.current)?.index).toBe(0);

    // The switch has to REDIRECT delivery: every later step goes through this
    // same object, so recording a choice without moving the target would leave
    // the caller acting on a tab nobody chose.
    await (driven.selectTab as (index: number) => Promise<void>)(1);
    await (driven.click as (selector: string) => Promise<void>)('#go');
    expect(second.click).toHaveBeenCalledWith('#go');
    expect(firstClick).not.toHaveBeenCalled();
    expect((driven.url as () => string)()).toBe('https://example.com/b');

    await session.close();
  });

  it('delivers to its OWN tab without recursing', async () => {
    // The common case: no tab switching at all. Forwarding looks the method up
    // on the current page -- which IS the object whose methods were replaced --
    // so a naive implementation finds its own forwarder and recurses forever.
    const only = playwrightishPage('https://example.com/a');
    const browser = {
      contexts: () => [{ newPage: async () => only, pages: () => [only] }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const originalClick = only.click;
    const session = await startAoiBrowserDriveSession({ engine: 'chrome' }, deps);
    const driven = session.page as unknown as Record<string, unknown>;

    await (driven.click as (selector: string) => Promise<void>)('#go');
    expect(originalClick).toHaveBeenCalledWith('#go');
    await session.close();
  });

  it('answers a dialog raised by the page', async () => {
    const first = playwrightishPage('https://example.com/a');
    const browser = {
      contexts: () => [{ newPage: async () => first, pages: () => [first] }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession({ engine: 'chrome' }, deps);
    const driven = session.page as unknown as Record<string, unknown>;

    let dismissed = 0;
    first.fire({
      message: () => 'Delete this draft?',
      type: () => 'confirm',
      accept: async () => {},
      dismiss: async () => {
        dismissed += 1;
      },
    });
    const message = await (driven.answerDialog as (d: string) => Promise<string>)('dismiss');
    expect(message).toBe('Delete this draft?');
    expect(dismissed).toBe(1);
    await session.close();
  });

  it('degrades honestly when the page provides neither', async () => {
    // A session factory that satisfies the DECLARED contract (url + close) must
    // not crash here; the executor then refuses those steps by name.
    const { deps } = happyDeps();
    const session = await startAoiBrowserDriveSession({ engine: 'chrome' }, deps);
    const driven = session.page as unknown as Record<string, unknown>;
    expect(driven.answerDialog).toBeUndefined();
    expect(driven.listTabs).toBeUndefined();
    await session.close();
  });
});

// How the session learns the browser is ready.
//
// It used to wait for Chrome to write a DevToolsActivePort file into the profile
// directory. Verified against Chrome 151 on a real machine: the browser starts,
// DevTools listens, and that file appears NOWHERE -- so the wait could only ever
// run out, and it reported "attach_timeout: DevToolsActivePort never appeared",
// which reads as "the browser did not start" when it had started fine.
describe('the attach handshake', () => {
  // A clock that moves. happyDeps freezes time, which is fine when a signal
  // arrives immediately but turns any wait into an endless one.
  function advancingClock(stepMs = 100) {
    let t = 1_000;
    return () => {
      t += stepMs;
      return t;
    };
  }

  function browserFor(page: AoiBrowserDrivePage) {
    return {
      contexts: () => [{ newPage: async () => page, pages: () => [page] }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
  }

  it('asks the browser directly instead of waiting for a file', async () => {
    const page = fakePage();
    const { deps } = happyDeps({
      connect: async () => browserFor(page),
      // No file, ever -- which is what current Chrome actually does.
      fileExists: () => false,
      readFile: () => {
        throw new Error('the port file must not be required');
      },
      probeDevTools: async (port: number) => `ws://127.0.0.1:${port}/devtools/browser/abc`,
      now: advancingClock(),
    });
    const session = await startAoiBrowserDriveSession({ engine: 'chrome' }, deps);
    expect(session.port).toBeGreaterThan(0);
    await session.close();
  });

  it('retries until the endpoint answers', async () => {
    // The browser takes a moment to open the port; a single probe would report a
    // perfectly healthy launch as a failure.
    const page = fakePage();
    let attempts = 0;
    const { deps } = happyDeps({
      connect: async () => browserFor(page),
      fileExists: () => false,
      probeDevTools: async (port: number) => {
        attempts += 1;
        return attempts < 3 ? null : `ws://127.0.0.1:${port}/devtools/browser/abc`;
      },
      now: advancingClock(),
    });
    const session = await startAoiBrowserDriveSession({ engine: 'chrome' }, deps);
    expect(attempts).toBe(3);
    await session.close();
  });

  it('still falls back to the port file for an older browser', async () => {
    // Older builds do write it, and dropping that path would trade one broken
    // case for another.
    const page = fakePage();
    const { deps } = happyDeps({
      connect: async () => browserFor(page),
      probeDevTools: async () => null,
      fileExists: () => true,
      readFile: () => '51222\n/devtools/browser/from-file',
    });
    const session = await startAoiBrowserDriveSession({ engine: 'chrome' }, deps);
    expect(session.port).toBe(51222);
    await session.close();
  });

  it('names an already-open browser as the reason it could not attach', async () => {
    // The unhelpful shape of this failure: a second launch on a profile that is
    // already open hands its command line to the running instance and exits, so
    // no debug port appears and the wait times out talking about DevTools --
    // describing a symptom of something else entirely.
    const { deps } = happyDeps({
      probeDevTools: async () => null,
      // Chrome keeps a lockfile in the profile while it is running.
      fileExists: (path: string) => path.includes('lockfile'),
      now: advancingClock(),
    });
    await expect(
      startAoiBrowserDriveSession({ engine: 'chrome', timeoutMs: 1_000 }, deps),
    ).rejects.toThrow('already open on this profile');
  });

  it('reports attach_timeout only when neither signal arrives', async () => {
    const { deps } = happyDeps({
      probeDevTools: async () => null,
      fileExists: () => false,
      now: advancingClock(),
    });
    await expect(
      startAoiBrowserDriveSession({ engine: 'chrome', timeoutMs: 1_000 }, deps),
    ).rejects.toMatchObject({ reason: 'attach_timeout' });
  });
});
