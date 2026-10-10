import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import type { ChildProcess } from 'child_process';
import {
  aimPointOfQuads,
  axChainHolds,
  closedRootsUnder,
  formOwnerDefaultButtonWords,
  handOverToProtocol,
  reachedWherePlaywrightAims,
  wordsHeldBy,
  wordsOfAimedNode,
  wordsAroundAcrossShadowTrees,
  wordsAroundInPage,
  shownTextIn,
  watchTopFrameDialogs,
  aimedWordsWith,
  AoiBrowserDriveStartError,
  pickFreeLoopbackPort,
  findRunningAoiBrowserDriveProfile,
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

// A profile is required now: the browser refuses remote debugging on its own
// default directory, so there is nothing sane to fall back to.
const PROFILE_OPTIONS = { engine: 'chrome' as const, userDataDir: 'C:/profiles/aoi' };

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
  it('launches, attaches, opens an Aoi page, and leaves the browser running', async () => {
    const { deps, page, browser, child } = happyDeps();
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    expect(session.port).toBe(51222);
    expect(session.cdpHttpEndpoint).toBe('http://127.0.0.1:51222');
    expect(session.engine).toBe('chrome');
    expect(session.page).toBe(page);

    await session.close();
    expect(page.closed).toBe(true);
    // The CDP client is released. Measured against Chrome 151: close() over
    // connectOverCDP disconnects, the browser keeps running and the operator's
    // tabs survive -- so holding the connection open protected nothing and
    // leaked one websocket per act instead.
    expect(browser.closedBrowser).toBe(true);
    // What must NOT happen is killing the browser the operator is using, and
    // that is the spawned process, not the client.
    expect((child as unknown as { killed: boolean }).killed).toBeFalsy();
    // Idempotent close.
    await session.close();
  });

  it('passes the pinned launch args to spawn', async () => {
    const { deps } = happyDeps();
    await startAoiBrowserDriveSession({ ...PROFILE_OPTIONS, userDataDir: '/profile' }, deps);
    const spawnMock = deps.spawnImpl as unknown as ReturnType<typeof vi.fn>;
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--remote-debugging-port=51222');
    expect(args).toContain('--remote-allow-origins=http://127.0.0.1:51222');
    expect(args).toContain('--user-data-dir=/profile');
  });

  it('fails browser_not_found when no executable resolves', async () => {
    const { deps } = happyDeps({ resolveExecutable: () => null });
    await expect(startAoiBrowserDriveSession(PROFILE_OPTIONS, deps)).rejects.toMatchObject({
      reason: 'browser_not_found',
    });
  });

  it('fails user_data_dir_unresolved when no profile is given', async () => {
    // There is no fallback any more: the only directory one could fall back to
    // is the browser's own default, which refuses remote debugging.
    const { deps } = happyDeps();
    await expect(startAoiBrowserDriveSession({ engine: 'chrome' }, deps)).rejects.toMatchObject({
      reason: 'user_data_dir_unresolved',
    });
  });

  it('fails port_unavailable when a free port cannot be picked', async () => {
    const { deps } = happyDeps({
      pickPort: async () => {
        throw new Error('no port');
      },
    });
    await expect(startAoiBrowserDriveSession(PROFILE_OPTIONS, deps)).rejects.toMatchObject({
      reason: 'port_unavailable',
    });
  });

  it('fails spawn_failed and never leaks when spawn throws', async () => {
    const { deps } = happyDeps({
      spawnImpl: vi.fn(() => {
        throw new Error('ENOENT');
      }) as unknown as AoiBrowserDriveSessionDeps['spawnImpl'],
    });
    await expect(startAoiBrowserDriveSession(PROFILE_OPTIONS, deps)).rejects.toMatchObject({
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
    await expect(
      startAoiBrowserDriveSession({ ...PROFILE_OPTIONS, timeoutMs: 1_000 }, deps),
    ).rejects.toMatchObject({
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
    await expect(startAoiBrowserDriveSession(PROFILE_OPTIONS, deps)).rejects.toMatchObject({
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
    await expect(startAoiBrowserDriveSession(PROFILE_OPTIONS, deps)).rejects.toMatchObject({
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
      innerText: vi.fn(async () => `text of ${url}`),
      waitForLoadState: vi.fn(async () => {}),
      close: vi.fn(async () => {
        page.closed = true;
      }),
      fire: (dialog: unknown) => dialogHandler?.(dialog),
    };
    return page;
  }

  it("leaves its own tab when a frame's dialog shown in place of another cannot be dismissed", async () => {
    // The session puts forwarders in place of the page's methods: the spies
    // are kept apart. The drive is on another tab -- the operator's -- which is
    // not the one left.
    const goto = vi.fn(async () => {});
    const page = Object.assign(playwrightishPage('https://help.example/'), { goto });
    const otherGoto = vi.fn(async () => {});
    const other = Object.assign(playwrightishPage('https://mail.example/'), { goto: otherGoto });
    const handlers = new Map<string, (params: Record<string, unknown>) => void>();
    const cdp = {
      on: (event: string, handler: (params: Record<string, unknown>) => void) => {
        handlers.set(event, handler);
      },
      send: vi.fn(async (method: string) =>
        method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'top' } } } : {},
      ),
      detach: vi.fn(async () => {}),
    };
    Object.assign(page, { context: () => ({ newCDPSession: async () => cdp }) });
    const browser = {
      contexts: () => [{ newPage: async () => page, pages: () => [page, other] }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    await (session.page as unknown as { selectTab(index: number): Promise<void> }).selectTab(1);
    // The top frame's own, held for a step to answer.
    page.fire({
      type: () => 'alert',
      message: () => 'Your session will expire soon',
      accept: async () => {},
      dismiss: async () => {},
    });
    handlers.get('Page.javascriptDialogOpening')?.({
      type: 'alert',
      message: 'Your session will expire soon',
      frameId: 'top',
    });
    // A frame's, shown in its place: no answer reaches it.
    page.fire({
      type: () => 'alert',
      message: () => 'Hi! Need help?',
      accept: async () => {},
      dismiss: async () => {
        throw new Error('Protocol error (Page.handleJavaScriptDialog): No dialog is showing');
      },
    });
    handlers.get('Page.javascriptDialogOpening')?.({
      type: 'alert',
      message: 'Hi! Need help?',
      frameId: 'chat-widget',
    });
    await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('about:blank', expect.anything()));
    expect(otherGoto).not.toHaveBeenCalled();
    await session.close();
  });

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
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
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
    // The look after an act reads the tab the act went to, not Aoi's own.
    await expect((driven.innerText as (selector: string) => Promise<string>)('body')).resolves.toBe(
      'text of https://example.com/b',
    );
    await (driven.waitForLoadState as (state: string) => Promise<void>)('domcontentloaded');
    expect(second.waitForLoadState).toHaveBeenCalledWith('domcontentloaded');

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
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
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
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
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
    // What the look after an act sees while the dialog waits.
    expect((driven.pendingDialog as () => unknown)()).toEqual({
      type: 'confirm',
      message: 'Delete this draft?',
    });
    const message = await (driven.answerDialog as (d: string) => Promise<string>)('dismiss');
    expect(message).toBe('Delete this draft?');
    expect(dismissed).toBe(1);
    await session.close();
  });

  it('closes the page before it answers a dialog an act may be waiting behind', async () => {
    // Dismissing first would let an act still queued behind the dialog land,
    // on a page nobody is looking at any more.
    const first = playwrightishPage('https://example.com/a');
    const order: string[] = [];
    first.close.mockImplementation(async () => {
      order.push('close');
      first.closed = true;
    });
    const browser = {
      contexts: () => [{ newPage: async () => first, pages: () => [first] }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    first.fire({
      message: () => 'Leave?',
      type: () => 'confirm',
      accept: async () => {},
      dismiss: async () => {
        order.push('dismiss');
      },
    });

    await session.close();
    expect(order).toEqual(['close', 'dismiss']);
  });

  it('holds dialogs only on its own tab, and says which tab it is on', async () => {
    const first = playwrightishPage('https://example.com/a');
    const second = playwrightishPage('https://example.com/b');
    const browser = {
      contexts: () => [{ newPage: async () => first, pages: () => [first, second] }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    const driven = session.page as unknown as Record<string, unknown>;
    first.fire({
      message: () => 'Delete this draft?',
      type: () => 'confirm',
      accept: async () => {},
      dismiss: async () => {},
    });

    expect((driven.isOnOwnTab as () => boolean)()).toBe(true);
    const tabs = await (driven.listTabs as () => Promise<{ id: number }[]>)();
    // Ids stay with their tab for the session.
    expect(tabs.map((tab) => tab.id)).toEqual([1, 2]);
    await expect((driven.listTabs as () => Promise<{ id: number }[]>)()).resolves.toMatchObject([
      { id: 1 },
      { id: 2 },
    ]);

    await (driven.selectTab as (index: number) => Promise<void>)(1);
    expect((driven.isOnOwnTab as () => boolean)()).toBe(false);
    // Aoi's tab's dialog says nothing about this one, and is not answered from it.
    expect((driven.pendingDialog as () => unknown)()).toBeNull();
    await expect((driven.answerDialog as (d: string) => Promise<string>)('accept')).rejects.toThrow(
      'only answered on the tab Aoi opened',
    );

    (driven.returnToOwnTab as () => void)();
    expect((driven.pendingDialog as () => unknown)()).toEqual({
      type: 'confirm',
      message: 'Delete this draft?',
    });
    await session.close();
  });

  it('counts matches and waits for a target on whichever tab is current, pressing nothing', async () => {
    const first = playwrightishPage('https://example.com/a');
    const second = playwrightishPage('https://example.com/b');
    const seen: string[] = [];
    for (const [tab, name] of [
      [first, 'a'],
      [second, 'b'],
    ] as const) {
      let enabledAfter = 2;
      let covered = false;
      const locator = (selector: string) => {
        const handle = {
          count: async () => {
            seen.push(`${name}:count:${selector}`);
            return 1;
          },
          first: () => handle,
          waitFor: async (options: { state: string }) => {
            seen.push(`${name}:${options.state}:${selector}`);
          },
          // Enabled on the second look: the wait polls rather than presses.
          isEnabled: async () => {
            enabledAfter -= 1;
            return enabledAfter <= 0;
          },
          isEditable: async () => true,
          scrollIntoViewIfNeeded: async () => {
            seen.push(`${name}:scroll:${selector}`);
          },
          // Covered on the first look at a pointer target, uncovered on the next;
          // scrolled another way between the two, as Playwright would.
          evaluate: async (fn: unknown, arg: { block?: string } | undefined) => {
            if (fn !== reachedWherePlaywrightAims) {
              seen.push(`${name}:scroll-${arg?.block}:${selector}`);
              return undefined;
            }
            covered = !covered;
            seen.push(`${name}:${covered ? 'covered' : 'uncovered'}:${selector}`);
            return !covered;
          },
        };
        return handle;
      };
      Object.assign(tab, { locator });
    }
    const browser = {
      contexts: () => [{ newPage: async () => first, pages: () => [first, second] }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const firstClick = first.click;
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    const driven = session.page as unknown as {
      countMatches: (selector: string) => Promise<number>;
      waitForActionable: (
        selector: string,
        kind: string,
        options: { timeout: number; toSelector?: string },
      ) => Promise<void>;
      selectTab: (index: number) => Promise<void>;
    };

    await expect(driven.countMatches('#x')).resolves.toBe(1);
    await driven.waitForActionable('#x', 'click', { timeout: 3_000 });
    await driven.selectTab(1);
    await driven.countMatches('#y');
    await driven.waitForActionable('#y', 'type', { timeout: 3_000 });
    await driven.waitForActionable('#y', 'drag', { timeout: 3_000, toSelector: '#z' });
    await driven.waitForActionable('#y', 'upload', { timeout: 3_000 });

    expect(seen).toEqual([
      'a:count:#x',
      'a:visible:#x',
      // A pointer target is waited for until nothing covers it.
      'a:scroll:#x',
      'a:covered:#x',
      'a:scroll-end:#x',
      'a:uncovered:#x',
      'b:count:#y',
      'b:visible:#y',
      'b:visible:#y',
      'b:visible:#z',
      'b:scroll:#y',
      'b:covered:#y',
      'b:scroll-end:#y',
      'b:uncovered:#y',
      'b:attached:#y',
    ]);
    // Nothing was clicked to find out.
    expect(firstClick).not.toHaveBeenCalled();
    expect(second.click).not.toHaveBeenCalled();
    await session.close();
  });

  it('presses a key wherever focus is on the current tab, and moves focus there', async () => {
    const first = playwrightishPage('https://example.com/a');
    const second = playwrightishPage('https://example.com/b');
    const pressed: string[] = [];
    for (const [tab, name] of [
      [first, 'a'],
      [second, 'b'],
    ] as const) {
      Object.assign(tab, {
        keyboard: { press: async (key: string) => pressed.push(`${name}:${key}`) },
        focus: vi.fn(async (selector: string) => {
          pressed.push(`${name}:focus:${selector}`);
        }),
      });
    }
    const browser = {
      contexts: () => [{ newPage: async () => first, pages: () => [first, second] }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    const driven = session.page as unknown as {
      keyboardPress: (key: string) => Promise<void>;
      focus: (selector: string) => Promise<void>;
      selectTab: (index: number) => Promise<void>;
    };
    await driven.focus('#q');
    await driven.keyboardPress('Enter');
    await driven.selectTab(1);
    await driven.focus('#r');
    await driven.keyboardPress('Escape');
    expect(pressed).toEqual(['a:focus:#q', 'a:Enter', 'b:focus:#r', 'b:Escape']);
    await session.close();
  });

  it('bounds every look the wait takes, and stops at once on a target that can never answer', async () => {
    const only = playwrightishPage('https://example.com/a');
    const asked: unknown[] = [];
    const handle = {
      count: async () => 1,
      first: () => handle,
      waitFor: async () => {},
      isEnabled: async (options?: { timeout?: number }) => {
        asked.push(options);
        return true;
      },
      scrollIntoViewIfNeeded: async () => {},
      evaluate: async () => true,
      isEditable: async () => {
        throw new Error('Element is not an <input>, <textarea> or [contenteditable] element');
      },
    };
    Object.assign(only, { locator: () => handle });
    const browser = {
      contexts: () => [{ newPage: async () => only, pages: () => [only] }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    const driven = session.page as unknown as {
      waitForActionable: (s: string, k: string, o: { timeout: number }) => Promise<void>;
    };
    await driven.waitForActionable('#x', 'click', { timeout: 2_000 });
    expect(asked).toHaveLength(1);
    expect((asked[0] as { timeout: number }).timeout).toBeGreaterThan(0);
    expect((asked[0] as { timeout: number }).timeout).toBeLessThanOrEqual(2_000);
    const started = Date.now();
    await expect(driven.waitForActionable('#x', 'type', { timeout: 5_000 })).rejects.toThrow(
      'not an <input>',
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    await session.close();
  });

  it('waits through a look that times out, and not at all on a page with no locator', async () => {
    const only = playwrightishPage('https://example.com/a');
    let looks = 0;
    const handle = {
      count: async () => 1,
      first: () => handle,
      waitFor: async () => {},
      isEnabled: async () => {
        looks += 1;
        if (looks === 1) {
          throw Object.assign(new Error('Timeout 100ms exceeded'), { name: 'TimeoutError' });
        }
        return true;
      },
      isEditable: async () => true,
      scrollIntoViewIfNeeded: async () => {},
      evaluate: async () => true,
    };
    Object.assign(only, { locator: () => handle });
    const browser = {
      contexts: () => [{ newPage: async () => only, pages: () => [only] }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    const driven = session.page as unknown as {
      waitForActionable: (s: string, k: string, o: { timeout: number }) => Promise<void>;
    };
    await driven.waitForActionable('#x', 'select', { timeout: 2_000 });
    expect(looks).toBe(2);
    // The tab this session is on has no locator: nothing to wait through.
    delete (only as unknown as Record<string, unknown>).locator;
    await expect(
      driven.waitForActionable('#x', 'click', { timeout: 100 }),
    ).resolves.toBeUndefined();
    await session.close();
  });

  it('stops waiting on a covered target in time for the act, scrolling it every way Playwright does', async () => {
    const only = playwrightishPage('https://example.com/a');
    const scrolls: string[] = [];
    const timeouts: number[] = [];
    const handle = {
      count: async () => 1,
      first: () => handle,
      waitFor: async () => {},
      isEnabled: async () => true,
      isEditable: async () => true,
      scrollIntoViewIfNeeded: async () => {
        scrolls.push('if-needed');
      },
      evaluate: async (
        fn: unknown,
        arg: { block?: string } | undefined,
        options?: { timeout?: number },
      ) => {
        timeouts.push(options?.timeout ?? -1);
        if (fn !== reachedWherePlaywrightAims) {
          // The scroll runs on the element, through Element's own scrollIntoView;
          // one of them fails, and the wait goes on.
          const scroll = fn as (element: unknown, options: unknown) => unknown;
          return scroll(document.createElement('div'), arg);
        }
        // Covered for good, and the look itself fails now and then.
        if (scrolls.length % 3 === 0) {
          throw new Error('Execution context was destroyed');
        }
        return false;
      },
    };
    Object.assign(only, { locator: () => handle });
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation((alignment?: boolean | ScrollIntoViewOptions) => {
        const block = typeof alignment === 'object' ? alignment.block : undefined;
        scrolls.push(String(block));
        if (block === 'center') {
          throw new Error('Element is not attached to the DOM');
        }
      });
    const browser = {
      contexts: () => [{ newPage: async () => only, pages: () => [only] }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    const driven = session.page as unknown as {
      waitForActionable: (s: string, k: string, o: { timeout: number }) => Promise<void>;
    };
    const started = Date.now();
    // Not a failure: the act goes ahead, and Playwright says what covers it.
    await expect(
      driven.waitForActionable('#x', 'hover', { timeout: 2_200 }),
    ).resolves.toBeUndefined();
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(600);
    expect(waited).toBeLessThan(1_400);
    expect(scrolls.slice(0, 5)).toEqual(['if-needed', 'end', 'center', 'start', 'if-needed']);
    scrollIntoView.mockRestore();
    // No look outlasts the time the act keeps for itself.
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(700);
    await session.close();
  });

  it('reads aria snapshots, form owners and what is outside shadow trees on the current tab', async () => {
    const first = playwrightishPage('https://example.com/a');
    const second = playwrightishPage('https://example.com/b');
    const asked: string[] = [];
    for (const [tab, name] of [
      [first, 'a'],
      [second, 'b'],
    ] as const) {
      Object.assign(tab, {
        locator: (selector: string) => ({
          count: async () => 1,
          ariaSnapshot: async (options: { timeout?: number }) => {
            asked.push(`${name}:aria:${selector}:${options?.timeout}`);
            return '- button "Pay now"';
          },
          evaluate: async (fn: unknown, _arg: unknown, options?: { timeout?: number }) => {
            const which =
              fn === formOwnerDefaultButtonWords
                ? 'owner'
                : fn === wordsAroundInPage
                  ? 'outside'
                  : 'other';
            asked.push(`${name}:${which}:${selector}:${options?.timeout}`);
            return 'words';
          },
        }),
      });
    }
    const browser = {
      contexts: () => [{ newPage: async () => first, pages: () => [first, second] }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    const driven = session.page as unknown as {
      ariaSnapshot: (s: string, o?: { timeout?: number }) => Promise<string>;
      formOwnerDefaultWords: (s: string, o?: { timeout?: number }) => Promise<string>;
      wordsOutsideShadow: (s: string, o?: { timeout?: number }) => Promise<string>;
      selectTab: (index: number) => Promise<void>;
    };
    await expect(driven.ariaSnapshot('#b', { timeout: 300 })).resolves.toBe('- button "Pay now"');
    await driven.selectTab(1);
    await expect(driven.formOwnerDefaultWords('#q', { timeout: 300 })).resolves.toBe('words');
    await expect(driven.wordsOutsideShadow('#p', { timeout: 300 })).resolves.toBe('words');
    expect(asked).toEqual(['a:aria:#b:300', 'b:owner:#q:300', 'b:outside:#p:300']);
    await session.close();
  });

  it('bounds what the page runs, and takes only a string for an answer', async () => {
    const only = playwrightishPage('https://example.com/a');
    let answer: unknown = 'Pay now';
    Object.assign(only, {
      locator: () => ({
        count: () => new Promise<number>(() => {}),
        evaluate: async () => {
          if (answer instanceof Error) {
            throw answer;
          }
          return answer;
        },
      }),
    });
    const browser = {
      contexts: () => [{ newPage: async () => only, pages: () => [only] }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    const driven = session.page as unknown as {
      countMatches: (s: string) => Promise<number>;
      formOwnerDefaultWords: (s: string, o?: { timeout?: number }) => Promise<string>;
      wordsOutsideShadow: (s: string, o?: { timeout?: number }) => Promise<string>;
    };
    await expect(driven.formOwnerDefaultWords('#q', { timeout: 50 })).resolves.toBe('Pay now');
    // A form read only in part: what Enter commits is not known. Any other
    // failure is the page's to report.
    answer = new Error('the form is too large to read through');
    await expect(driven.formOwnerDefaultWords('#q', { timeout: 50 })).rejects.toMatchObject({
      name: 'TooMuchToReadError',
    });
    answer = new Error('Execution context was destroyed');
    await expect(driven.formOwnerDefaultWords('#q', { timeout: 50 })).rejects.toThrow(
      'Execution context was destroyed',
    );
    answer = { then: () => {} };
    await expect(driven.wordsOutsideShadow('#p', { timeout: 50 })).rejects.toThrow(
      'did not answer',
    );
    answer = 42;
    await expect(driven.formOwnerDefaultWords('#q', { timeout: 50 })).resolves.toBe('');
    // A count that never comes back is cut off as well.
    const started = Date.now();
    await expect(driven.countMatches('#q')).rejects.toThrow('did not answer');
    expect(Date.now() - started).toBeLessThan(5_000);
    await session.close();
  });

  it('waits for the next frame to navigate on whichever tab is current', async () => {
    const first = playwrightishPage('https://example.com/a');
    const second = playwrightishPage('https://example.com/b');
    const waited: string[] = [];
    for (const [tab, name] of [
      [first, 'a'],
      [second, 'b'],
    ] as const) {
      Object.assign(tab, {
        waitForEvent: vi.fn(async (event: string, options: { timeout: number }) => {
          waited.push(`${name}:${event}:${options.timeout}`);
        }),
      });
    }
    const browser = {
      contexts: () => [{ newPage: async () => first, pages: () => [first, second] }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    const driven = session.page as unknown as {
      waitForFrameNavigation: (options: { timeout: number }) => Promise<void>;
      selectTab: (index: number) => Promise<void>;
    };
    await driven.waitForFrameNavigation({ timeout: 900 });
    await driven.selectTab(1);
    await driven.waitForFrameNavigation({ timeout: 800 });
    expect(waited).toEqual(['a:framenavigated:900', 'b:framenavigated:800']);
    await session.close();
  });

  it('gives up waiting for a target that never becomes enabled', async () => {
    const only = playwrightishPage('https://example.com/a');
    const handle = {
      count: async () => 1,
      first: () => handle,
      waitFor: async () => {},
      isEnabled: async () => false,
      isEditable: async () => false,
    };
    Object.assign(only, { locator: () => handle });
    const browser = {
      contexts: () => [{ newPage: async () => only, pages: () => [only] }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    const driven = session.page as unknown as {
      waitForActionable: (s: string, k: string, o: { timeout: number }) => Promise<void>;
    };
    await expect(driven.waitForActionable('#x', 'click', { timeout: 150 })).rejects.toThrow(
      'did not become enabled',
    );
    await session.close();
  });

  it('degrades honestly when the page provides neither', async () => {
    // A session factory that satisfies the DECLARED contract (url + close) must
    // not crash here; the executor then refuses those steps by name.
    const { deps } = happyDeps();
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
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
describe('the browser default profile', () => {
  it('is refused up front instead of attempted', async () => {
    // Chrome refuses remote debugging there, so falling back to it produces an
    // attempt that looks reasonable and then fails seconds later describing a
    // missing DevTools port -- a symptom of a completely different problem. A
    // caller with no profile has not been configured yet and should hear that.
    const { deps } = happyDeps();
    await expect(
      startAoiBrowserDriveSession(
        { engine: 'chrome', userDataDir: 'C:/Users/me/AppData/Local/Google/Chrome/User Data' },
        {
          ...deps,
          resolveDefaultUserDataDir: () => 'C:/Users/me/AppData/Local/Google/Chrome/User Data',
        },
      ),
    ).rejects.toThrow('refuses remote debugging');
  });

  it('does not refuse a dedicated directory', async () => {
    const page = fakePage();
    const { deps } = happyDeps({
      connect: async () =>
        ({
          contexts: () => [{ newPage: async () => page, pages: () => [page] }],
          isConnected: () => true,
          close: vi.fn(async () => {}),
        }) as unknown as AoiBrowserDriveBrowser,
      resolveDefaultUserDataDir: () => 'C:/Users/me/AppData/Local/Google/Chrome/User Data',
    });
    const session = await startAoiBrowserDriveSession(
      { engine: 'chrome', userDataDir: 'C:/Users/me/.openroom/browser-profile' },
      deps,
    );
    expect(session.port).toBeGreaterThan(0);
    await session.close();
  });
});

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
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
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
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
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
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    expect(session.port).toBe(51222);
    await session.close();
  });

  it('points at the lockfile without asserting a window is definitely open', async () => {
    // The unhelpful shape of this failure: a second launch on a profile that is
    // already open hands its command line to the running instance and exits, so
    // no debug port appears and the wait times out talking about DevTools --
    // describing a symptom of something else entirely.
    //
    // The message stops short of claiming a window IS open, because a killed
    // browser leaves the same file behind and the claim would then be false --
    // which is exactly what happened when this was first written.
    const { deps } = happyDeps({
      probeDevTools: async () => null,
      // Chrome keeps a lockfile in the profile while it is running.
      fileExists: (path: string) => path.includes('lockfile'),
      now: advancingClock(),
    });
    await expect(
      startAoiBrowserDriveSession({ ...PROFILE_OPTIONS, timeoutMs: 1_000 }, deps),
    ).rejects.toThrow('this profile has a lockfile');
  });

  it('reports attach_timeout only when neither signal arrives', async () => {
    const { deps } = happyDeps({
      probeDevTools: async () => null,
      fileExists: () => false,
      now: advancingClock(),
    });
    await expect(
      startAoiBrowserDriveSession({ ...PROFILE_OPTIONS, timeoutMs: 1_000 }, deps),
    ).rejects.toMatchObject({ reason: 'attach_timeout' });
  });
});

// An earlier session leaves the profile's browser running on purpose. Launching
// again handed the command line to it and exited, so no new debug port opened
// and an approved execute right after its preview timed out.
describe('reattaching to the profile browser an earlier session left running', () => {
  const RECORD = JSON.stringify({
    aoiDrivePort: 51333,
    aoiDriveWsPath: '/devtools/browser/running',
  });
  const runningProfile = {
    fileExists: (path: string) => path.endsWith('lockfile'),
    readFile: (path: string) => (path.endsWith('aoi-drive-port.json') ? RECORD : ''),
  };

  it('attaches to it instead of launching another', async () => {
    const connected: string[] = [];
    const page = fakePage();
    const { deps } = happyDeps({
      ...runningProfile,
      probeDevTools: async (port: number) =>
        port === 51333 ? 'ws://127.0.0.1:51333/devtools/browser/running' : null,
      connect: async (endpoint: string) => {
        connected.push(endpoint);
        return fakeBrowser(page);
      },
    });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    expect(deps.spawnImpl).not.toHaveBeenCalled();
    expect(session.port).toBe(51333);
    expect(session.child).toBeNull();
    // Straight to the recorded socket, not wherever an HTTP answer points.
    expect(connected).toEqual(['ws://127.0.0.1:51333/devtools/browser/running']);
    await session.close();
  });

  it('launches instead when something else now holds the recorded port', async () => {
    // Another browser on the same port answers with its own socket. Attaching
    // would drive that browser -- the operator's own, signed in everywhere.
    const { deps } = happyDeps({
      ...runningProfile,
      probeDevTools: async (port: number) =>
        port === 51333
          ? 'ws://127.0.0.1:51333/devtools/browser/someone-else'
          : `ws://127.0.0.1:${port}/devtools/browser/new`,
      writeFile: () => undefined,
    });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    expect(deps.spawnImpl).toHaveBeenCalledTimes(1);
    expect(session.port).toBe(51222);
    await session.close();
  });

  it('launches, and records the port, when the recorded one no longer answers', async () => {
    const writes: [string, string][] = [];
    const { deps } = happyDeps({
      ...runningProfile,
      probeDevTools: async (port: number) =>
        port === 51222 ? 'ws://127.0.0.1:51222/devtools/browser/new' : null,
      writeFile: (path: string, data: string) => {
        writes.push([path, data]);
      },
    });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    expect(deps.spawnImpl).toHaveBeenCalledTimes(1);
    expect(session.port).toBe(51222);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toMatch(/aoi-drive-port\.json$/);
    expect(JSON.parse(writes[0][1])).toEqual({
      aoiDrivePort: 51222,
      aoiDriveWsPath: '/devtools/browser/new',
    });
    await session.close();
  });

  it('ignores the record when the profile is not in use', async () => {
    const probed: number[] = [];
    const { deps } = happyDeps({
      fileExists: () => false,
      readFile: () => RECORD,
      probeDevTools: async (port: number) => {
        probed.push(port);
        return port === 51222 ? 'ws://127.0.0.1:51222/devtools/browser/new' : null;
      },
      writeFile: () => undefined,
    });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    expect(deps.spawnImpl).toHaveBeenCalledTimes(1);
    expect(probed).not.toContain(51333);
    await session.close();
  });

  it('accepts only a well-formed record and a real DevTools answer', async () => {
    const find = (record: string, socketUrl: string | null) =>
      findRunningAoiBrowserDriveProfile('C:/profiles/aoi', {
        fileExists: () => true,
        readFile: () => record,
        probeDevTools: async () => socketUrl,
      });
    await expect(find(RECORD, 'ws://127.0.0.1:51333/devtools/browser/running')).resolves.toEqual({
      port: 51333,
      wsPath: '/devtools/browser/running',
    });
    // DevToolsActivePort's own format is not a record of ours.
    await expect(find('51333\n/devtools/browser/x', 'ws://x/y')).resolves.toBeNull();
    await expect(find(JSON.stringify({ aoiDrivePort: 80 }), 'ws://x/y')).resolves.toBeNull();
    await expect(find(RECORD, null)).resolves.toBeNull();
    await expect(find(RECORD, 'not a url')).resolves.toBeNull();
    // Another browser's socket on the same port, one off this machine, or one on
    // another port: none of them is the browser that was recorded.
    for (const socket of [
      'ws://127.0.0.1:51333/devtools/browser/someone-else',
      'ws://evil.example:51333/devtools/browser/running',
      'ws://127.0.0.1:9222/devtools/browser/running',
      'wss://127.0.0.1:51333/devtools/browser/running',
    ]) {
      await expect(find(RECORD, socket), socket).resolves.toBeNull();
    }
    // A record from before the socket path was kept cannot be checked.
    await expect(
      find(JSON.stringify({ aoiDrivePort: 51333 }), 'ws://127.0.0.1:51333/devtools/browser/x'),
    ).resolves.toBeNull();
  });

  it('treats a profile it cannot inspect as not in use', async () => {
    await expect(
      findRunningAoiBrowserDriveProfile('C:/profiles/aoi', {
        fileExists: () => {
          throw new Error('access denied');
        },
        readFile: () => RECORD,
        probeDevTools: async () => 'ws://127.0.0.1:51333/devtools/browser/x',
      }),
    ).resolves.toBeNull();
  });

  it('does not try to stop a browser it only attached to', async () => {
    // Reattaching starts no process, so a failure after it has nothing to kill.
    const { deps, child } = happyDeps({
      ...runningProfile,
      probeDevTools: async () => 'ws://127.0.0.1:51333/devtools/browser/running',
      connect: async () => {
        throw new Error('websocket closed');
      },
    });
    await expect(startAoiBrowserDriveSession(PROFILE_OPTIONS, deps)).rejects.toMatchObject({
      reason: 'connect_failed',
    });
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('what the page itself says, read inside it', () => {
  // Run in the page; here, against nodes made of what they read.
  const text = (value: string) => ({ nodeType: 3, nodeValue: value, childNodes: [] });
  function element(options: {
    matches?: boolean;
    children?: unknown[];
    shadow?: unknown[];
    attrs?: Record<string, string>;
    innerText?: string;
    parentElement?: unknown;
    parentNode?: unknown;
  }) {
    return {
      nodeType: 1,
      matches: () => options.matches === true,
      childNodes: options.children ?? [],
      shadowRoot: options.shadow ? { childNodes: options.shadow } : null,
      getAttribute: (name: string) => options.attrs?.[name] ?? null,
      innerText: options.innerText,
      textContent: options.innerText ?? '',
      parentElement: options.parentElement ?? null,
      parentNode: options.parentNode ?? null,
    };
  }

  // A form of stand-ins: its tree's default buttons, its words and names.
  function formOf(defaults: unknown[], words: string[] = [], attrs: Record<string, string> = {}) {
    const tree: Record<string, unknown> = { querySelectorAll: () => defaults };
    const form = {
      ...element({ children: words.map(text), attrs }),
      getRootNode: () => tree,
    };
    tree.getElementById = (id: string) => (id === 'checkout' ? form : null);
    return { form, tree };
  }

  it("reads the default button of the field's form owner, its shadow tree too", () => {
    const defaults: unknown[] = [];
    const { form: owner } = formOf(defaults);
    const other = { id: 'Z' };
    // The tree's default buttons: another form's first, then the owner's.
    const search = { ...element({ children: [text('Search')] }), form: other };
    const pay = {
      ...element({
        children: [text('Pay')],
        shadow: [element({ children: [text(' now')] })],
        attrs: { 'aria-label': 'Pay the order', value: '' },
      }),
      form: owner,
    };
    defaults.push(search, pay);
    const field = (form: unknown = owner) =>
      ({ form, getRootNode: () => ({ host: null }) }) as unknown as Element;
    expect(formOwnerDefaultButtonWords(field())).toBe('Pay now Pay the order');
    // No form: nothing.
    expect(formOwnerDefaultButtonWords(field(null))).toBe('');
  });

  it('says what a form with no default button of its own says, by its start and its end', () => {
    const { form } = formOf([], ['Support us', ' x'.repeat(400), ' Donate $25 now'], {
      'aria-label': 'Donation',
      name: 'give',
    });
    const said = formOwnerDefaultButtonWords({
      form,
      getRootNode: () => ({ host: null }),
    } as unknown as Element);
    expect(said.startsWith('Donation give Support us x x')).toBe(true);
    expect(said.endsWith('x x Donate $25 now')).toBe(true);
    expect(said.length).toBeLessThan(700);
  });

  it('says what the buttons of a form with no default button say, a component holding one too', () => {
    // A long form whose pay button is a component: its host holds the label, a
    // button in its shadow tree submits.
    const host = {
      ...element({ children: [text('Pay $49.00')] }),
      shadowRoot: { childNodes: [], querySelector: () => ({}) },
    };
    const plain = {
      ...element({
        children: [text('Apply')],
        matches: true,
        attrs: { 'aria-label': 'Apply code' },
      }),
    };
    const section = element({
      children: [text(` ${'x '.repeat(400)}`), host, text(` ${'y '.repeat(400)}`), plain],
    });
    const { form } = formOf([], []);
    Object.assign(form, { childNodes: [section] });
    const said = formOwnerDefaultButtonWords({
      form,
      getRootNode: () => ({ host: null }),
    } as unknown as Element);
    // What its buttons say comes first, before all the form says around them.
    // What its buttons say comes first, a line each, before all the form says.
    expect(said.split('\n').slice(0, 2)).toEqual(['Pay $49.00', 'Apply Apply code']);
    expect(said.split('\n')[2].startsWith('x x')).toBe(true);
  });

  it("reads the buttons in a component's shadow tree that holds none at its top", () => {
    // A card component: its own shadow tree holds a section, the section a pay
    // button.
    const pay = element({ children: [text('Pay $49.00')], matches: true });
    const section = element({ children: [pay] });
    const card = {
      ...element({ children: [text('Pro plan')] }),
      shadowRoot: { childNodes: [section], querySelector: () => null },
    };
    const { form } = formOf([], []);
    Object.assign(form, { childNodes: [card] });
    const read = formOwnerDefaultButtonWords({
      form,
      getRootNode: () => ({ host: null }),
    } as unknown as Element);
    expect(read).toBe('Pay $49.00\nPro plan Pay $49.00');
  });

  it('reads the buttons of a form, a few words each, and says when it read no further', () => {
    const button = (words: string) =>
      element({ children: [text(words)], matches: true, attrs: { title: 'go' } });
    const many = (count: number) => {
      const { form } = formOf([], []);
      Object.assign(form, {
        childNodes: [
          ...Array.from({ length: count }, (_, n) => button(`Remove item ${n} ${'z'.repeat(300)}`)),
          button('Place order'),
        ],
      });
      return formOwnerDefaultButtonWords({
        form,
        getRootNode: () => ({ host: null }),
      } as unknown as Element);
    };
    // Eighty long buttons are read by their starts and ends, to the last.
    const read = many(80);
    expect(read).toContain('Place order go');
    expect(read.length).toBeLessThan(16_000 + 700);
    // Past 16,000 characters of them, the rest is not known.
    expect(() => many(100)).toThrow('the form is too large to read through');
  });

  it('reads on into a box that takes clicks, and a long one by its start and its end', () => {
    // The whole form's content in a box that takes clicks (analytics), the pay
    // link deep inside it; and a card that names its action after its
    // description.
    const link = element({ children: [text('Donate $25 now')], matches: true });
    const wrapper = element({
      children: [
        text(` ${'x '.repeat(200)}`),
        element({ children: [link] }),
        text(` ${'y '.repeat(200)}`),
      ],
      matches: true,
    });
    const card = element({
      children: [
        text(`${'Every gift helps the library stay open late. '.repeat(5)}`),
        text(' Donate $25 now'),
      ],
      matches: true,
    });
    const { form } = formOf([], []);
    Object.assign(form, { childNodes: [wrapper, card] });
    const lines = formOwnerDefaultButtonWords({
      form,
      getRootNode: () => ({ host: null }),
    } as unknown as Element).split('\n');
    // The wrapper by its two ends, the link inside it, and the card's end.
    expect(lines[0]).toMatch(/^x x .* y y$/);
    expect(lines[1]).toBe('Donate $25 now');
    expect(lines[2]).toMatch(/^Every gift .* Donate \$25 now$/);
    expect(lines[2].length).toBeLessThan(190);
  });

  it('reads the end of a long control through a shadow tree at its end', () => {
    const card = element({
      children: [
        text(`${'Every gift helps the library stay open late. '.repeat(5)}`),
        element({ shadow: [text('Donate $25 now')] }),
      ],
      matches: true,
    });
    const { form } = formOf([], []);
    Object.assign(form, { childNodes: [card] });
    const [line] = formOwnerDefaultButtonWords({
      form,
      getRootNode: () => ({ host: null }),
    } as unknown as Element).split('\n');
    expect(line).toMatch(/Donate \$25 now$/);
  });

  it('keeps the first 120 characters of a long control, where a card says what it does', () => {
    // A card that names its action a few words in, then goes on about it.
    const card = element({
      children: [
        text('Monthly supporter Keep our reporting free for everyone. Donate $25 now '),
        text(
          'Recurring gift, billed monthly. Change or cancel it at any time from your account page.',
        ),
      ],
      matches: true,
    });
    const { form } = formOf([], []);
    Object.assign(form, { childNodes: [card] });
    const [line] = formOwnerDefaultButtonWords({
      form,
      getRootNode: () => ({ host: null }),
    } as unknown as Element).split('\n');
    expect(line).toContain('Donate $25 now');
  });

  it('reads the controls a script makes of links and boxes, and not a link to a page', () => {
    // A long donation form: its pay control is a link to nowhere, a box that
    // takes clicks, or a link to a script -- and the help link goes to a page.
    const control = (words: string, attrs: Record<string, string>) =>
      element({ children: [text(words)], attrs });
    const { form } = formOf([], []);
    const filler = (letter: string) => text(` ${`${letter} `.repeat(400)}`);
    const matchesOf = (attrs: Record<string, string>) => (selector: string) =>
      (selector.includes('a[href^="#"]') && attrs.href === '#') ||
      (selector.includes('[onclick]') && 'onclick' in attrs);
    const link = { ...control('Donate $25 now', { href: '#' }) };
    Object.assign(link, { matches: matchesOf({ href: '#' }) });
    const box = { ...control('Give monthly', { onclick: 'give()' }) };
    Object.assign(box, { matches: matchesOf({ onclick: 'give()' }) });
    const help = { ...control('How giving works', { href: '/help' }) };
    Object.assign(help, { matches: matchesOf({ href: '/help' }) });
    Object.assign(form, {
      childNodes: [element({ children: [filler('x'), link, box, help, filler('y')] })],
    });
    const said = formOwnerDefaultButtonWords({
      form,
      getRootNode: () => ({ host: null }),
    } as unknown as Element);
    expect(said.split('\n').slice(0, 2)).toEqual(['Donate $25 now', 'Give monthly']);
    expect(said.split('\n')[2].startsWith('x x')).toBe(true);
    expect(said).not.toContain('How giving works');
  });

  it("finds the form a component's field submits, host by host up out of its trees", () => {
    const button = (form: unknown) => ({ ...element({ children: [text('Pay $49.00')] }), form });
    const fieldIn = (host: unknown) =>
      ({ form: null, getRootNode: () => ({ host }) }) as unknown as Element;
    const hostOf = (options: {
      form?: unknown;
      attrs?: Record<string, string>;
      around?: unknown;
      root?: unknown;
    }) => ({
      form: options.form,
      getAttribute: (name: string) => options.attrs?.[name] ?? null,
      closest: () => options.around ?? null,
      getRootNode: () => options.root ?? { host: null },
    });
    // A form-associated host's own form.
    const defaults: unknown[] = [];
    const { form, tree } = formOf(defaults);
    defaults.push(button(form));
    expect(formOwnerDefaultButtonWords(fieldIn(hostOf({ form })))).toBe('Pay $49.00');
    // One its form attribute names, in the host's tree -- and none for a name
    // of no form.
    expect(
      formOwnerDefaultButtonWords(fieldIn(hostOf({ attrs: { form: 'checkout' }, root: tree }))),
    ).toBe('Pay $49.00');
    expect(
      formOwnerDefaultButtonWords(
        fieldIn(hostOf({ attrs: { form: 'nowhere' }, root: tree, around: form })),
      ),
    ).toBe('');
    // The one around the host; a string the host keeps as its form is no form.
    expect(formOwnerDefaultButtonWords(fieldIn(hostOf({ form: '', around: form })))).toBe(
      'Pay $49.00',
    );
    // Two hosts up: a component in a component in the form.
    const outer = hostOf({ around: form });
    const inner = hostOf({ root: { host: outer } });
    expect(formOwnerDefaultButtonWords(fieldIn(inner))).toBe('Pay $49.00');
    // No form anywhere up.
    expect(formOwnerDefaultButtonWords(fieldIn(hostOf({})))).toBe('');
  });

  it("finds a real component's form through the prototypes, whatever the form calls its controls", () => {
    // A field in a closed shadow tree, in a form whose named controls stand in
    // for its childNodes and getAttribute.
    document.body.innerHTML =
      '<form id="checkout" aria-label="Checkout"><input name="childNodes"><input name="getAttribute">' +
      '<x-field id="host"></x-field><script>pay()</script><button id="pay">Pay $49.00</button></form>';
    const host = document.getElementById('host') as HTMLElement;
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<input id="inner">';
    const inner = shadow.getElementById('inner') as Element;
    const pay = document.getElementById('pay') as Element;
    // (The test DOM cannot match :default; the browser's own answer stood in for.)
    const defaults = vi
      .spyOn(Document.prototype, 'querySelectorAll')
      .mockReturnValue([pay] as unknown as NodeListOf<Element>);
    try {
      expect(formOwnerDefaultButtonWords(inner)).toBe('Pay $49.00');
      // With no default button, what the form says, past its named controls,
      // and what its buttons say.
      defaults.mockReturnValue([] as unknown as NodeListOf<Element>);
      expect(formOwnerDefaultButtonWords(inner)).toBe('Pay $49.00\nCheckout Pay $49.00');
    } finally {
      defaults.mockRestore();
      document.body.innerHTML = '';
    }
  });

  it('climbs out of shadow trees the way events bubble, and stops at a long wrapper', () => {
    // A real tree: a price drawn in a component, in a box that buys, in a page.
    document.body.innerHTML =
      `<div id="page" aria-label="Shop"><p>${'x'.repeat(200)}</p>` +
      '<div id="box">Buy now <x-price id="host"></x-price></div>' +
      '<button id="order" title="Order">Place order <i id="icon"></i></button></div>';
    const host = document.getElementById('host') as HTMLElement;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<span id="price">$19.99</span>';
    const price = shadow.getElementById('price') as Element;
    // The box draws the price its component draws, which no host's text holds.
    expect(wordsAroundAcrossShadowTrees(price)).toBe('Shop Buy now $19.99');
    // The first control met says what it is, too.
    expect(wordsAroundAcrossShadowTrees(document.getElementById('icon') as Element)).toBe(
      'Place order Order Shop Place order Order',
    );
    // The document's top has nothing around it.
    expect(wordsAroundAcrossShadowTrees(document.documentElement)).toBe('');
    document.body.innerHTML = '';
  });

  it('reads what a component draws around a field in it, not its style sheet', () => {
    // A component that buys on a click, its quantity field among what it draws.
    document.body.innerHTML =
      `<p>${'Choose a quantity, then buy below. '.repeat(4)}</p>` +
      '<buy-qty id="host" onclick="pay()"></buy-qty>';
    const host = document.getElementById('host') as HTMLElement;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      `<style>${'.row { display: flex; gap: 8px; } '.repeat(4)}</style>` +
      '<span>Buy now $49.00</span> <label for="q">Qty</label> <input id="q" type="number">';
    const field = shadow.getElementById('q') as Element;
    expect(wordsAroundAcrossShadowTrees(field)).toBe('Buy now $49.00 Qty');
    document.body.innerHTML = '';
  });

  it('reads, for a control that says what it is, only what takes the click past its tree', () => {
    // A product tile drawn in a component: its own buttons are read where it
    // is, by XPath -- not swept in with the wishlist button beside them.
    document.body.innerHTML =
      `<p>${'Our store ships worldwide, and returns are free. '.repeat(3)}</p>` +
      '<ul><li><product-tile id="tile"></product-tile></li></ul>';
    const tile = document.getElementById('tile') as HTMLElement;
    tile.attachShadow({ mode: 'open' }).innerHTML =
      '<div class="tile"><b>Wireless Headphones</b> <span>$49.00</span> ' +
      '<button id="wish">Add to wishlist</button> <button id="buy">Buy now</button></div>';
    const wish = tile.shadowRoot?.getElementById('wish') as Element;
    expect(wordsAroundAcrossShadowTrees(wish, true)).toBe('');
    // A host that buys on a click is what the click goes on to, by what it draws.
    tile.setAttribute('onclick', 'buy()');
    expect(wordsAroundAcrossShadowTrees(wish, true)).toContain('Buy now');
    // As is a link around it, however long.
    tile.removeAttribute('onclick');
    document.body.innerHTML =
      `<p>${'Our store ships worldwide, and returns are free. '.repeat(3)}</p>` +
      `<a href="/buy" aria-label="Buy now"><span>${'Wireless headphones with a long battery life. '.repeat(3)}</span><info-chip id="chip"></info-chip></a>`;
    const chip = document.getElementById('chip') as HTMLElement;
    chip.attachShadow({ mode: 'open' }).innerHTML = '<button id="d">Details</button>';
    const details = chip.shadowRoot?.getElementById('d') as Element;
    expect(wordsAroundAcrossShadowTrees(details, true)).toContain('Buy now');
    document.body.innerHTML = '';
  });

  it('reads what a closed tree it climbs out of draws', () => {
    document.body.innerHTML =
      `<p>${'Our store ships worldwide, and returns are free. '.repeat(3)}</p>` +
      '<div id="box">Buy now <x-price id="host"></x-price></div>';
    const host = document.getElementById('host') as HTMLElement;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<span id="price">$19.99</span> <i id="icon"></i>';
    const icon = root.getElementById('icon') as Element;
    // No read from the host goes into its tree; the climb out of it does.
    expect(wordsAroundAcrossShadowTrees(icon)).toContain('$19.99');
    document.body.innerHTML = '';
  });

  it('reads what a component in a component draws', () => {
    document.body.innerHTML =
      `<p>${'Choose a quantity, then buy below. '.repeat(4)}</p>` +
      '<buy-card id="card" onclick="pay()"></buy-card>';
    const card = document.getElementById('card') as HTMLElement;
    const root = card.attachShadow({ mode: 'open' });
    root.innerHTML = '<price-tag id="tag"></price-tag> <input id="q" aria-label="Quantity">';
    (root.getElementById('tag') as HTMLElement).attachShadow({ mode: 'open' }).innerHTML =
      '<b>Buy now $49.00</b>';
    const field = root.getElementById('q') as Element;
    expect(wordsAroundAcrossShadowTrees(field)).toContain('Buy now $49.00');
    expect(wordsAroundAcrossShadowTrees(field, true)).toContain('Buy now $49.00');
    document.body.innerHTML = '';
  });

  it('climbs from a slotted element to its slot, as its events do', () => {
    document.body.innerHTML =
      `<p>${'Our store ships worldwide, and returns are free. '.repeat(3)}</p>` +
      '<product-card id="pc"><button id="d">Details</button></product-card>';
    const pc = document.getElementById('pc') as HTMLElement;
    const root = pc.attachShadow({ mode: 'open' });
    root.innerHTML = '<div id="box" onclick="buy()"><b>Buy now $49.00</b> <slot></slot></div>';
    const slot = root.querySelector('slot') as Element;
    const button = document.getElementById('d') as Element;
    // (The test DOM assigns no slots: the browser's own answer stood in for.)
    Object.defineProperty(Element.prototype, 'assignedSlot', {
      configurable: true,
      get(this: Element) {
        return this === button ? slot : null;
      },
    });
    try {
      expect(wordsAroundAcrossShadowTrees(button, true)).toContain('Buy now $49.00');
    } finally {
      delete (Element.prototype as unknown as { assignedSlot?: unknown }).assignedSlot;
      document.body.innerHTML = '';
    }
  });

  it('reads what is around through the prototypes, whatever a form calls its controls', () => {
    // A form's named controls stand in for its properties; the climb does not
    // ask the form for them.
    document.body.innerHTML =
      '<form id="aspnet" aria-label="Checkout form"><span id="label">Buy now</span>' +
      '<x-price id="host"></x-price></form>';
    const form = document.getElementById('aspnet') as HTMLFormElement;
    // (Only matches: the test DOM's own getters read the others off the form,
    // as a browser's never do.)
    for (const name of ['matches']) {
      Object.defineProperty(form, name, {
        value: document.createElement('img'),
        configurable: true,
      });
    }
    const host = document.getElementById('host') as HTMLElement;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<span id="price">$19.99</span>';
    expect(wordsAroundAcrossShadowTrees(shadow.getElementById('price') as Element)).toContain(
      'Buy now',
    );
    document.body.innerHTML = '';
  });
});

describe('what an element shows where it can be seen', () => {
  type Box = [number, number, number, number];
  const rect = ([left, top, right, bottom]: Box) =>
    ({
      left,
      top,
      right,
      bottom,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    }) as DOMRect;
  // The test DOM lays nothing out: each element's box (by id), each text's
  // runs (by its words) and the styles the browser computes are given here.
  function laidOut(options: {
    boxes: Record<string, Box>;
    runs: Record<string, Box[]>;
    styles?: Record<string, Record<string, string>>;
  }) {
    const boxes = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return rect(options.boxes[this.id] ?? [0, 0, 0, 0]);
    });
    const runs = vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (
      this: Range,
    ) {
      const words = String(this.startContainer.textContent ?? '').trim();
      return (options.runs[words] ?? []).map(rect) as unknown as DOMRectList;
    });
    const styles = vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((element) => {
      const own = options.styles?.[(element as Element).id] ?? {};
      return {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        clipPath: 'none',
        clip: 'auto',
        position: 'static',
        overflowX: 'visible',
        overflowY: 'visible',
        contain: 'none',
        color: 'rgb(0, 0, 0)',
        ...own,
        getPropertyValue: (name: string) =>
          name === '-webkit-text-fill-color' ? (own.fill ?? '') : (own[name] ?? ''),
      } as unknown as CSSStyleDeclaration;
    });
    return () => {
      boxes.mockRestore();
      runs.mockRestore();
      styles.mockRestore();
      document.body.innerHTML = '';
    };
  }
  const seen = (text: string): Record<string, Box[]> => ({ [text]: [[10, 10, 290, 30]] });
  // How far the page scrolls, how far it has, and its window -- and so of the
  // boxes in it that scroll, by id (`boxes`): the test DOM scrolls nothing.
  type Scrolled = {
    width: number;
    height: number;
    left?: number;
    top?: number;
    clientWidth?: number;
    clientHeight?: number;
  };
  function scrolling(metrics: Scrolled, boxes: Record<string, Scrolled> = {}) {
    const of = (value: number, name: 'width' | 'height' | 'left' | 'top') =>
      function (this: Element) {
        return this === document.documentElement ? value : (boxes[this.id]?.[name] ?? 0);
      };
    const client = (name: 'clientWidth' | 'clientHeight') =>
      function (this: Element) {
        return this === document.documentElement
          ? (metrics[name] ?? metrics[name === 'clientWidth' ? 'width' : 'height'])
          : (boxes[this.id]?.[name] ?? 0);
      };
    const spies = [
      vi
        .spyOn(Element.prototype, 'scrollWidth', 'get')
        .mockImplementation(of(metrics.width, 'width')),
      vi
        .spyOn(Element.prototype, 'scrollHeight', 'get')
        .mockImplementation(of(metrics.height, 'height')),
      vi
        .spyOn(Element.prototype, 'scrollLeft', 'get')
        .mockImplementation(of(metrics.left ?? 0, 'left')),
      vi
        .spyOn(Element.prototype, 'scrollTop', 'get')
        .mockImplementation(of(metrics.top ?? 0, 'top')),
      vi
        .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
        .mockImplementation(client('clientWidth')),
      vi
        .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
        .mockImplementation(client('clientHeight')),
    ];
    const root = document.documentElement as unknown as Record<string, unknown>;
    Object.defineProperty(root, 'clientWidth', {
      configurable: true,
      value: metrics.clientWidth ?? metrics.width,
    });
    Object.defineProperty(root, 'clientHeight', {
      configurable: true,
      value: metrics.clientHeight ?? metrics.height,
    });
    return () => {
      for (const spy of spies) {
        spy.mockRestore();
      }
      delete root.clientWidth;
      delete root.clientHeight;
    };
  }

  it('counts the text drawn in its box, not what is there and not seen', () => {
    const hidden = {
      sr: 'Wireless Headphones Pro, noise cancelling, thirty hours of battery, opens checkout',
      tip: 'Free returns within thirty days of delivery, no questions asked, on every order',
      cp: 'Clipped away entirely by a clip-path that leaves nothing of it to be seen at all',
      cl: 'Clipped away entirely by an old clip rectangle on a box that is placed absolutely',
      clear: 'Written in a colour that draws nothing at all, though it takes up all the room',
      slash: 'Written in another colour of no opacity, which draws nothing either, all the same',
      fill: 'Filled with a transparent text fill, so that not a single letter of it is seen',
      off: 'Placed far off to the left of the page, where nobody ever scrolls to read it all',
      vh: 'Hidden from sight with visibility, though the box it is in still keeps its place',
      none: 'Not drawn at all, as its display is none, and so it is not laid out anywhere',
    };
    document.body.innerHTML =
      '<div id="box"><b id="b">Buy now $49.00</b><!-- the price shown -->' +
      Object.entries(hidden)
        .map(([id, words]) => `<span id="${id}">${words}</span>`)
        .join('') +
      '<span id="half">half</span>' +
      '<select id="s"><option>Small</option><option>Medium</option></select></div>';
    const restore = laidOut({
      boxes: { box: [0, 0, 300, 40], sr: [0, 0, 1, 1] },
      runs: {
        'Buy now $49.00': [[10, 10, 120, 30]],
        ...Object.assign({}, ...Object.values(hidden).map(seen)),
        [hidden.sr]: [[0, 0, 600, 20]],
        [hidden.off]: [[-10_000, 0, -9_000, 20]],
        half: [[130, 10, 160, 30]],
        Small: [[10, 10, 60, 30]],
      },
      styles: {
        sr: { overflowX: 'hidden', overflowY: 'hidden' },
        tip: { opacity: '0' },
        cp: { clipPath: 'inset(50%)' },
        cl: { position: 'absolute', clip: 'rect(0px, 0px, 0px, 0px)' },
        clear: { color: 'rgba(0, 0, 0, 0)' },
        slash: { color: 'color(srgb 0 0 0 / 0)' },
        fill: { fill: 'transparent' },
        vh: { visibility: 'hidden' },
        none: { display: 'none' },
        half: { color: 'rgba(0, 0, 0, 0.5)' },
      },
    });
    try {
      const box = document.getElementById('box') as Element;
      // "Buy now $49.00" and a faint "half": nothing hidden, nothing in a list box.
      expect(shownTextIn(box, 80)).toEqual({
        length: 'Buy now $49.00'.length + 'half'.length,
        text: 'Buy now $49.00 half',
      });
    } finally {
      restore();
    }
  });

  it('counts the part of a text a clamp lets show, and stops a little past the limit', () => {
    const words = 'word '.repeat(24).trim();
    document.body.innerHTML =
      `<div id="card"><p id="clamp">${words}</p><b id="x">${'x'.repeat(50)}</b>` +
      `<i id="y">${'y'.repeat(50)}</i><u id="z">${'z'.repeat(50)}</u><s id="gone">gone</s></div>`;
    const restore = laidOut({
      boxes: { card: [0, 0, 300, 200], clamp: [0, 0, 300, 20], gone: [0, 0, 0, 10] },
      runs: {
        // Four lines, one of which the clamp shows.
        [words]: [
          [0, 0, 300, 20],
          [0, 20, 300, 40],
          [0, 40, 300, 60],
          [0, 60, 300, 80],
        ],
        ['x'.repeat(50)]: [[0, 100, 300, 120]],
        ['y'.repeat(50)]: [[0, 120, 300, 140]],
        ['z'.repeat(50)]: [[0, 140, 300, 160]],
        gone: [[0, 160, 30, 170]],
      },
      styles: { clamp: { overflowY: 'hidden' }, gone: { contain: 'paint' } },
    });
    try {
      const card = document.getElementById('card') as Element;
      const clamped = Math.floor(words.length / 4);
      const all = shownTextIn(card, 1_000);
      expect(all?.length).toBe(clamped + 150);
      // Of a text partly shown, its start: a clamp shows the first line.
      expect(all?.text.startsWith(`${words.slice(0, clamped)} ${'x'.repeat(50)}`)).toBe(true);
      // Past the limit it stops: the "z" run is never measured.
      expect(shownTextIn(card, 80)?.length).toBe(clamped + 100);
      // With no page around it to draw on, an element of no size has nothing to say.
      expect(shownTextIn(document.getElementById('x') as Element, 80)).toBeNull();
    } finally {
      restore();
    }
  });

  it('counts what open shadow trees and slots draw in it, and walks only so many nodes', () => {
    document.body.innerHTML =
      '<x-card id="host"><span id="slotted">Buy now</span></x-card>' +
      `<div id="crowd">${'<span></span>'.repeat(5_001)}<b>late</b></div>`;
    const host = document.getElementById('host') as HTMLElement;
    host.attachShadow({ mode: 'open' }).innerHTML =
      '<div id="inner"><slot id="slot"></slot> <b id="price">$49.00</b>' +
      '<slot id="empty"><i id="fallback">or less</i></slot><p id="skip">Skipped</p></div>';
    const slotted = document.getElementById('slotted') as Element;
    const assigned = vi
      .spyOn(HTMLSlotElement.prototype, 'assignedNodes')
      .mockImplementation(function (this: HTMLSlotElement) {
        return this.id === 'slot' ? [slotted] : [];
      });
    // What the browser skips laying out (content-visibility, a closed details).
    Object.defineProperty(Element.prototype, 'checkVisibility', {
      configurable: true,
      value(this: Element) {
        return this.id !== 'skip';
      },
    });
    const restore = laidOut({
      boxes: { host: [0, 0, 300, 40], crowd: [0, 0, 300, 40] },
      runs: {
        'Buy now': [[0, 0, 50, 20]],
        $49: [[60, 0, 100, 20]],
        '$49.00': [[60, 0, 100, 20]],
        'or less': [[110, 0, 150, 20]],
        Skipped: [[160, 0, 200, 20]],
        late: [[0, 0, 30, 20]],
      },
      styles: { slot: { display: 'contents' }, empty: { display: 'contents' } },
    });
    try {
      expect(shownTextIn(host, 80)).toEqual({
        length: 'Buy now'.length + '$49.00'.length + 'or less'.length,
        text: 'Buy now $49.00 or less',
      });
      // Past as many nodes as it walks, what it shows cannot be told.
      expect(shownTextIn(document.getElementById('crowd') as Element, 80)).toBeNull();
    } finally {
      assigned.mockRestore();
      delete (Element.prototype as unknown as { checkVisibility?: unknown }).checkVisibility;
      restore();
    }
  });

  it('measures an element of no size by what it holds on the page, and clip-paths by what they leave', () => {
    document.body.innerHTML =
      '<div id="row" style="display:contents"><b id="buy">Buy now $49.00</b>' +
      '<span id="sr">Wireless Headphones Pro in black, ships tomorrow</span></div>' +
      '<div id="shut"><b>Hidden away</b></div>' +
      '<div id="card"><h3 id="round">Rounded corners</h3><h3 id="cut">Cut away</h3>' +
      '<h3 id="grad">Gradient title</h3><h3 id="flat">Flat clear title</h3></div>';
    const unscroll = scrolling({ width: 1000, height: 2000 });
    const restore = laidOut({
      boxes: { card: [0, 0, 300, 200], round: [0, 0, 300, 30] },
      runs: {
        'Buy now $49.00': [[10, 10, 120, 30]],
        // Off the page, to its left.
        'Wireless Headphones Pro in black, ships tomorrow': [[-10_000, 10, -9_000, 30]],
        'Hidden away': [[10, 40, 120, 60]],
        'Rounded corners': [[10, 10, 200, 30]],
        'Cut away': [[10, 40, 200, 60]],
        'Gradient title': [[10, 70, 200, 90]],
        'Flat clear title': [[10, 100, 200, 120]],
      },
      styles: {
        row: { display: 'contents' },
        shut: { overflowX: 'hidden', overflowY: 'hidden' },
        round: { clipPath: 'inset(0px round 12px)' },
        cut: { clipPath: 'inset(50%)' },
        grad: {
          fill: 'transparent',
          'background-clip': 'text',
          'background-image': 'linear-gradient(red, blue)',
        },
        flat: { fill: 'transparent', 'background-clip': 'text', 'background-image': 'none' },
      },
    });
    try {
      // A row of no size draws on the page: what it shows there, not off it.
      expect(shownTextIn(document.getElementById('row') as Element, 80)).toEqual({
        length: 14,
        text: 'Buy now $49.00',
      });
      // One of no size that clips what it holds shows nothing.
      expect(shownTextIn(document.getElementById('shut') as Element, 80)).toEqual({
        length: 0,
        text: '',
      });
      // A rounded clip-path clips to the box; one of half or more leaves nothing;
      // a gradient drawn through clear letters is seen.
      expect(shownTextIn(document.getElementById('card') as Element, 80)?.text).toBe(
        'Rounded corners Gradient title',
      );
    } finally {
      unscroll();
      restore();
    }
  });

  it('measures one of no size as far as the page goes -- across, its window where it hides that way', () => {
    const far =
      'Customer reviews, delivery times, the warranty and the returns policy, further down';
    const left = 'Written to the left of where a page set right to left starts';
    const right = 'Off to the right of the window, where a menu waits until it is opened';
    const markup =
      `<div id="wrap"><a id="co">Checkout</a><p id="far">${far}</p><p id="lw">${left}</p>` +
      `<p id="rw">${right}</p></div>`;
    document.body.innerHTML = markup;
    document.documentElement.id = 'root';
    document.body.id = 'body';
    const view = (styles: Record<string, Record<string, string>>, metrics = {}) => {
      const unscroll = scrolling({ width: 1000, height: 2000, clientHeight: 800, ...metrics });
      const restore = laidOut({
        boxes: {},
        runs: {
          Checkout: [[10, 10, 80, 30]],
          [far]: [[10, 1500, 900, 1520]],
          [left]: [[-1500, 40, -900, 60]],
          [right]: [[1500, 70, 1900, 90]],
        },
        styles,
      });
      try {
        return shownTextIn(document.getElementById('wrap') as Element, 500)?.length;
      } finally {
        unscroll();
        restore();
        document.body.innerHTML = markup;
      }
    };
    try {
      // A root of the window's height, the page running on below it: all of it.
      expect(view({})).toBe('Checkout'.length + far.length);
      // Below the window is out of view, not hidden -- even on a page that
      // keeps itself from scrolling, whether the root says so or the body the
      // window takes it from (an open dialog does).
      expect(view({ root: { overflowY: 'hidden' } })).toBe('Checkout'.length + far.length);
      expect(view({ body: { overflowY: 'hidden' } })).toBe('Checkout'.length + far.length);
      // Across, as far as the page scrolls -- or the window, where it hides
      // what overflows that way.
      expect(view({}, { width: 3000, clientWidth: 1000 })).toBe(
        'Checkout'.length + far.length + right.length,
      );
      expect(view({ root: { overflowX: 'hidden' } }, { width: 3000, clientWidth: 1000 })).toBe(
        'Checkout'.length + far.length,
      );
      // A page set right to left scrolls to the left of its start -- as its
      // body is written, which the root's way leaves to it.
      expect(
        view(
          { root: { direction: 'rtl' }, body: { direction: 'rtl' } },
          { width: 3000, clientWidth: 1000 },
        ),
      ).toBe('Checkout'.length + far.length + left.length);
      expect(
        view(
          { root: { direction: 'rtl' }, body: { direction: 'ltr' } },
          { width: 3000, clientWidth: 1000 },
        ),
      ).toBe('Checkout'.length + far.length + right.length);
      expect(view({}, { width: 3000, clientWidth: 1000, left: -500 })).toBe(
        'Checkout'.length + far.length + left.length,
      );
    } finally {
      document.documentElement.removeAttribute('id');
      document.body.removeAttribute('id');
      document.body.innerHTML = '';
    }
  });

  it('counts only what the boxes around it let show: a card of a set height hides the rest', () => {
    const rest =
      'Wireless headphones with thirty hours of battery and a case that charges them twice';
    const page = (card: Record<string, string>) => {
      document.body.innerHTML =
        `<div id="card"><div id="box"><b>Buy now $49.00</b> <button>Details</button>` +
        `<p>${rest}</p></div></div>`;
      const restore = laidOut({
        boxes: { card: [0, 0, 300, 60], box: [0, 0, 300, 200] },
        runs: {
          'Buy now $49.00': [[10, 10, 120, 30]],
          Details: [[130, 10, 190, 30]],
          [rest]: [[0, 80, 300, 200]],
        },
        styles: { card },
      });
      // The card scrolls as far down as the box it holds.
      const unscroll = scrolling(
        { width: 1000, height: 800 },
        { card: { width: 300, height: 200, clientWidth: 300, clientHeight: 60 } },
      );
      try {
        return shownTextIn(document.getElementById('box') as Element, 80);
      } finally {
        unscroll();
        restore();
      }
    };
    // Hidden past its height, or cut by a clip-path or paint containment.
    const shortOne = { length: 21, text: 'Buy now $49.00 Details' };
    expect(page({ overflowX: 'hidden', overflowY: 'hidden' })).toEqual(shortOne);
    expect(page({ overflowY: 'clip' })).toEqual(shortOne);
    expect(page({ clipPath: 'inset(0px round 8px)' })).toEqual(shortOne);
    expect(page({ contain: 'paint' })).toEqual(shortOne);
    // One that hides only across leaves what runs down; one that scrolls holds
    // what it scrolls to; one of no box of its own clips nothing.
    expect(page({ overflowX: 'hidden', overflowY: 'auto' })?.length).toBeGreaterThan(80);
    expect(page({ overflowX: 'auto', overflowY: 'auto' })?.length).toBeGreaterThan(80);
    expect(
      page({ display: 'contents', overflowX: 'hidden', overflowY: 'hidden' })?.length,
    ).toBeGreaterThan(80);
  });

  it('holds what a box that scrolls scrolls to: a card scrolled out of a carousel is out of view', () => {
    const rest =
      'Lightweight trail shoes with a grippy sole, a breathable mesh upper and a padded collar';
    const page = (carousel: Record<string, string>, card: [number, number, number, number]) => {
      document.body.innerHTML =
        `<div id="carousel"><article id="card"><b>Trail shoe 5</b><p>${rest}</p>` +
        '<button>Add to cart</button></article></div>';
      const [left, top, right, bottom] = card;
      const restore = laidOut({
        boxes: { carousel: [0, 0, 300, 200], card },
        runs: {
          'Trail shoe 5': [[left + 10, top + 10, left + 100, top + 30]],
          [rest]: [[left + 10, top + 40, right - 10, top + 120]],
          'Add to cart': [[left + 10, bottom - 50, left + 100, bottom - 30]],
        },
        styles: { carousel },
      });
      // The carousel scrolls as far as the card it holds.
      const unscroll = scrolling(
        { width: 1000, height: 800 },
        {
          carousel: {
            width: Math.max(300, right),
            height: Math.max(200, bottom),
            clientWidth: 300,
            clientHeight: 200,
          },
        },
      );
      try {
        return shownTextIn(document.getElementById('card') as Element, 80)?.length;
      } finally {
        unscroll();
        restore();
      }
    };
    const pastTheEdge: [number, number, number, number] = [1200, 0, 1500, 200];
    // A carousel that scrolls across: the card past its edge -- and past the
    // page -- is all there; contained or cut to rounded corners, the same.
    expect(page({ overflowX: 'auto', overflowY: 'hidden' }, pastTheEdge)).toBeGreaterThan(80);
    expect(
      page({ overflowX: 'auto', overflowY: 'hidden', contain: 'strict' }, pastTheEdge),
    ).toBeGreaterThan(80);
    expect(
      page({ overflowX: 'scroll', clipPath: 'inset(0px round 8px)' }, pastTheEdge),
    ).toBeGreaterThan(80);
    // A panel that scrolls down: what is below it, and below the page, too.
    expect(page({ overflowY: 'auto' }, [0, 1000, 300, 1200])).toBeGreaterThan(80);
    // One that hides what overflows it: the card past its edge shows nothing.
    expect(page({ overflowX: 'hidden', overflowY: 'hidden' }, pastTheEdge)).toBe(0);
    // Its containment cuts the ways it does not scroll.
    expect(page({ overflowY: 'auto', contain: 'paint' }, pastTheEdge)).toBe(0);
  });

  it('holds no more than a box that scrolls can bring into view, the ways it scrolls', () => {
    const note =
      'Hand-forged in Sheffield from carbon steel with an ash handle and a lifetime guarantee';
    // A row of no size of its own -- its "Buy now $49.00" in a panel that
    // scrolls -- and a note set somewhere about it.
    const page = (
      panel: Record<string, string>,
      where: Box,
      scrolled: Partial<Scrolled> = {},
      panelBox: Box = [0, 0, 300, 200],
    ) => {
      document.body.innerHTML =
        '<div id="panel"><div id="row"><b>Buy now $49.00</b>' +
        `<span id="note">${note}</span></div></div>`;
      const [left, top] = panelBox;
      const restore = laidOut({
        boxes: { panel: panelBox },
        runs: {
          'Buy now $49.00': [[left + 10, top + 10, left + 120, top + 30]],
          [note]: [where],
        },
        styles: {
          panel: { overflowX: 'auto', overflowY: 'auto', ...panel },
          row: { display: 'contents' },
        },
      });
      const unscroll = scrolling(
        { width: 1000, height: 800, clientWidth: 1000, clientHeight: 800 },
        { panel: { width: 300, height: 600, clientWidth: 300, clientHeight: 200, ...scrolled } },
      );
      try {
        return shownTextIn(document.getElementById('row') as Element, 200)?.text;
      } finally {
        unscroll();
        restore();
      }
    };
    const both = `Buy now $49.00 ${note}`;
    // To the left of where its scrolling starts, or above it: out of reach.
    expect(page({}, [-10_000, 10, -9_000, 30])).toBe('Buy now $49.00');
    expect(page({}, [10, -10_000, 290, -9_980])).toBe('Buy now $49.00');
    // Below it as far as it scrolls: in reach -- and past that, not.
    expect(page({}, [10, 400, 290, 420])).toBe(both);
    expect(page({}, [10, 700, 290, 720])).toBe('Buy now $49.00');
    // Scrolled down by 100, what is up to 100 above it is back in reach.
    expect(page({}, [10, -80, 290, -60], { top: 100 })).toBe(both);
    // Written right to left, it scrolls to the left of where it starts: what
    // is there is in reach, and what is to its right is not.
    expect(page({ direction: 'rtl' }, [-200, 10, -10, 30], { width: 600 })).toBe(both);
    expect(page({ direction: 'rtl' }, [400, 10, 590, 30], { width: 600 })).toBe('Buy now $49.00');
    // A reversed flex row from its right, a reversed column (a chat) up from
    // its bottom; a flex box whose lines wrap in reverse, the other way across
    // them.
    expect(
      page({ display: 'flex', flexDirection: 'row-reverse' }, [-200, 10, -10, 30], { width: 600 }),
    ).toBe(both);
    expect(page({ display: 'flex', flexDirection: 'column-reverse' }, [10, -300, 290, -280])).toBe(
      both,
    );
    expect(page({ display: 'flex', flexDirection: 'column-reverse' }, [10, 400, 290, 420])).toBe(
      'Buy now $49.00',
    );
    expect(page({ display: 'flex', flexWrap: 'wrap-reverse' }, [10, -300, 290, -280])).toBe(both);
    expect(
      page(
        { display: 'flex', flexDirection: 'column', flexWrap: 'wrap-reverse' },
        [-200, 10, -10, 30],
        { width: 600 },
      ),
    ).toBe(both);
    // Its lines set right to left (vertical-rl): from its right.
    expect(page({ writingMode: 'vertical-rl' }, [-200, 10, -10, 30], { width: 600 })).toBe(both);
    // A panel the page cannot show: nothing it holds is shown.
    expect(page({}, [-4_990, 50, -4_800, 70], {}, [-5_000, 0, -4_700, 200])).toBe('');
    // An inline box scrolls nothing, whatever its overflow says: what is
    // below it is shown as far as the page goes.
    expect(page({ display: 'inline' }, [10, 700, 290, 720])).toBe(both);
    // Nor in a box that hides it: what is around clips the panel.
    document.body.innerHTML =
      '<div id="shut"><div id="panel"><div id="row"><b>Buy now $49.00</b></div></div></div>';
    const restore = laidOut({
      boxes: { shut: [0, 0, 300, 200], panel: [400, 0, 700, 200] },
      runs: { 'Buy now $49.00': [[410, 10, 520, 30]] },
      styles: {
        shut: { overflowX: 'hidden', overflowY: 'hidden' },
        panel: { overflowX: 'auto', overflowY: 'auto' },
        row: { display: 'contents' },
      },
    });
    const unscroll = scrolling(
      { width: 1000, height: 800 },
      { panel: { width: 300, height: 200, clientWidth: 300, clientHeight: 200 } },
    );
    try {
      expect(shownTextIn(document.getElementById('row') as Element, 200)?.text).toBe('');
    } finally {
      unscroll();
      restore();
    }
  });

  it('holds what a box in a box that scrolls scrolls to, as far as the outer one reaches', () => {
    // A carousel in a panel that scrolls down: a card past the carousel's
    // edge is in reach while the carousel is in the panel's.
    const page = (carousel: Box, panelAcross = 'hidden') => {
      document.body.innerHTML =
        '<div id="panel"><div id="carousel"><div id="row"><b>Trail shoe 5 $49.00</b></div></div></div>';
      const [left, top] = carousel;
      const restore = laidOut({
        boxes: { panel: [0, 0, 300, 200], carousel },
        runs: { 'Trail shoe 5 $49.00': [[left + 900, top + 10, left + 1_000, top + 30]] },
        styles: {
          panel: { overflowX: panelAcross, overflowY: 'auto' },
          carousel: { overflowX: 'auto', overflowY: 'hidden' },
          row: { display: 'contents' },
        },
      });
      const unscroll = scrolling(
        { width: 1000, height: 800 },
        {
          panel: { width: 600, height: 1_000, clientWidth: 300, clientHeight: 200 },
          carousel: { width: 1_200, height: 100, clientWidth: 300, clientHeight: 100 },
        },
      );
      try {
        return shownTextIn(document.getElementById('row') as Element, 200)?.text;
      } finally {
        unscroll();
        restore();
      }
    };
    expect(page([0, 600, 300, 700])).toBe('Trail shoe 5 $49.00');
    // Below as far as the panel scrolls: out of reach.
    expect(page([0, 1_200, 300, 1_300])).toBe('');
    // A panel that scrolls across as well: the carousel in its reach across
    // holds what it scrolls to, and one past its reach holds nothing.
    expect(page([200, 600, 500, 700], 'auto')).toBe('Trail shoe 5 $49.00');
    expect(page([700, 600, 1_000, 700], 'auto')).toBe('');
  });

  it('shows of a box with nothing to scroll only what the boxes around it let show', () => {
    // A row in a clearfix wrapper (overflow: auto, nothing to scroll) in a list
    // item of a set height that hides the rest: its description is out of
    // sight for good. A wrapper that does scroll brings it as far as it goes.
    const rest =
      'Ships in 2 days. Free returns within 30 days. Includes charger, cable and a case.';
    const page = (wrapperTall: number) => {
      document.body.innerHTML =
        '<ul><li id="item"><div id="wrap"><div id="row"><b>Buy now $49.00</b> ' +
        `<button>Details</button><p>${rest}</p></div></div></li></ul>`;
      const restore = laidOut({
        boxes: { item: [0, 0, 420, 44], wrap: [0, 0, 420, 120], row: [48, 0, 420, 120] },
        runs: {
          'Buy now $49.00': [[48, 10, 160, 30]],
          Details: [[170, 10, 230, 30]],
          [rest]: [[48, 50, 420, 110]],
        },
        styles: {
          item: { overflowX: 'hidden', overflowY: 'hidden' },
          wrap: { overflowX: 'auto', overflowY: 'auto' },
        },
      });
      const unscroll = scrolling(
        { width: 1000, height: 800 },
        { wrap: { width: 420, height: wrapperTall, clientWidth: 420, clientHeight: 120 } },
      );
      try {
        return shownTextIn(document.getElementById('row') as Element, 200)?.text;
      } finally {
        unscroll();
        restore();
      }
    };
    expect(page(120)).toBe('Buy now $49.00 Details');
    // The wrapper scrolls as far again as it shows: the item's view can be
    // scrolled over the description.
    expect(page(240)).toBe(`Buy now $49.00 Details ${rest}`);
  });

  it('shows of what is fixed to the window only what is in the window', () => {
    // A sheet that peeks up from the bottom of a long page: its description is
    // below the window, where no scrolling of the page brings it.
    const rest =
      'Ships in 2 days. Free returns within 30 days. Includes charger, cable and a case.';
    const page = (
      sheet: Record<string, string>,
      wrap: Record<string, string> = {},
      windowHeight = 800,
    ) => {
      document.body.innerHTML =
        '<div id="wrap"><div id="sheet"><b>Buy now $49.00</b> <button>Details</button>' +
        `<p>${rest}</p></div></div>`;
      const restore = laidOut({
        boxes: { sheet: [0, 700, 400, 960], wrap: [0, 0, 1000, 3000] },
        runs: {
          'Buy now $49.00': [[10, 710, 120, 730]],
          Details: [[130, 710, 190, 730]],
          [rest]: [[10, 820, 390, 900]],
        },
        styles: { sheet, wrap },
      });
      const unscroll = scrolling({ width: 1000, height: 3000, clientHeight: 800 });
      const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
      const innerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: windowHeight });
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
      try {
        return shownTextIn(document.getElementById('sheet') as Element, 200)?.text;
      } finally {
        for (const [name, kept] of [
          ['innerHeight', innerHeight],
          ['innerWidth', innerWidth],
        ] as const) {
          if (kept) {
            Object.defineProperty(window, name, kept);
          } else {
            delete (window as unknown as Record<string, unknown>)[name];
          }
        }
        unscroll();
        restore();
      }
    };
    expect(page({ position: 'fixed' })).toBe('Buy now $49.00 Details');
    // Fixed by the box around it, the same.
    expect(page({}, { position: 'fixed' })).toBe('Buy now $49.00 Details');
    // Not fixed: the page scrolls to it. A window of no size to tell: the page.
    expect(page({})).toBe(`Buy now $49.00 Details ${rest}`);
    expect(page({ position: 'fixed' }, {}, 0)).toBe(`Buy now $49.00 Details ${rest}`);
  });

  it('shows nothing a box skips drawing, nor a closed details past its summary', () => {
    const skipped =
      'Free returns within thirty days of delivery, no questions asked, on every order';
    const folded = 'Ships from our warehouse in two to four business days, tracked all the way';
    document.body.innerHTML =
      `<div id="box"><b>Buy now $49.00</b><div id="skip">${skipped}</div>` +
      `<details id="more"><summary>More</summary>${folded}</details>` +
      '<details id="open" open><summary>Open</summary>Shown</details></div>';
    const restore = laidOut({
      boxes: { box: [0, 0, 600, 300] },
      runs: {
        'Buy now $49.00': [[10, 10, 120, 30]],
        [skipped]: [[10, 40, 590, 60]],
        More: [[10, 70, 60, 90]],
        [folded]: [[10, 100, 590, 120]],
        Open: [[10, 130, 60, 150]],
        Shown: [[10, 160, 60, 180]],
      },
      // A section hidden until found is skipped the same way.
      styles: { skip: { contentVisibility: 'hidden' } },
    });
    try {
      expect(shownTextIn(document.getElementById('box') as Element, 500)?.text).toBe(
        'Buy now $49.00 More Open Shown',
      );
    } finally {
      restore();
    }
  });

  it('climbs through the slots of closed trees it is handed, to the boxes they are in', () => {
    // A row slotted into a closed card of a set height: no script sees the
    // slot, so without it the climb goes to the host past the card.
    const rest =
      'Ships in 2 days. Free returns within 30 days. Includes charger, cable and a case.';
    document.body.innerHTML = `<x-card id="host"><div id="row"><b>Buy now $49.00</b> <p>${rest}</p></div></x-card>`;
    const host = document.getElementById('host') as HTMLElement;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<div id="clip"><slot id="slot"></slot></div>';
    const row = document.getElementById('row') as Element;
    const slot = root.getElementById('slot') as Element;
    // (The test DOM has no assignedSlot: a script's climb goes to the host, as
    // a browser's does from a closed tree's slot.)
    const restore = laidOut({
      boxes: { clip: [0, 0, 360, 30], row: [0, 0, 360, 120], host: [0, 0, 360, 120] },
      runs: { 'Buy now $49.00': [[10, 5, 120, 25]], [rest]: [[10, 40, 350, 110]] },
      styles: {
        clip: { overflowX: 'hidden', overflowY: 'hidden' },
        slot: { display: 'contents' },
      },
    });
    try {
      expect(shownTextIn(row, 200)?.text).toBe(`Buy now $49.00 ${rest}`);
      expect(shownTextIn(row, 200, [row, slot])?.text).toBe('Buy now $49.00');
      // An odd one out of the pairs is left alone.
      expect(shownTextIn(row, 200, [row, slot, host])?.text).toBe('Buy now $49.00');
    } finally {
      restore();
    }
  });

  it('scales what a scaled box that scrolls measures of itself as it is drawn', () => {
    // A carousel drawn at half again its size (zoom: 1.5): its scroll measures
    // are its own, its box the drawn one.
    const page = (drawn: Box, laidWide: number) => {
      document.body.innerHTML =
        '<div id="carousel"><div id="row"><b id="last">Trail shoe 5 $49.00</b></div></div>';
      const restore = laidOut({
        boxes: { carousel: drawn },
        runs: { 'Trail shoe 5 $49.00': [[1_700, 10, 1_850, 40]] },
        styles: {
          carousel: { overflowX: 'auto', overflowY: 'hidden' },
          row: { display: 'contents' },
        },
      });
      const unscroll = scrolling(
        { width: 3000, height: 800 },
        { carousel: { width: 1_400, height: 100, clientWidth: 400, clientHeight: 100 } },
      );
      const laid = vi
        .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
        .mockImplementation(function (this: HTMLElement) {
          if (laidWide < 0) {
            // What an element of another kind is asked as an HTML one's.
            throw new TypeError('Illegal invocation');
          }
          return this.id === 'carousel' ? laidWide : 0;
        });
      try {
        return shownTextIn(document.getElementById('row') as Element, 200)?.text;
      } finally {
        laid.mockRestore();
        unscroll();
        restore();
      }
    };
    // Drawn 600 wide for 400 laid out: it scrolls 2,100 drawn pixels.
    expect(page([0, 0, 600, 150], 400)).toBe('Trail shoe 5 $49.00');
    // Unscaled, 1,400 is as far as it goes.
    expect(page([0, 0, 400, 100], 400)).toBe('');
    // A box laid out at no size takes no scale, nor one whose size cannot be
    // read.
    expect(page([0, 0, 400, 100], 0)).toBe('');
    expect(page([0, 0, 600, 150], -1)).toBe('');
  });

  it('climbs out of shadow trees and slots for the boxes around, as far as it goes', () => {
    document.body.innerHTML = '<x-frame id="frame"><span id="slotted">x</span></x-frame>';
    const frame = document.getElementById('frame') as HTMLElement;
    const shadow = frame.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<div id="clipper"><slot id="slot"></slot></div><div id="inner"><i>Top line</i>' +
      '<i>Lower line, far down</i></div>';
    const slotted = document.getElementById('slotted') as Element;
    slotted.innerHTML = '<i>First</i><i>Second, far down</i>';
    const slot = shadow.getElementById('slot') as Element;
    Object.defineProperty(Element.prototype, 'assignedSlot', {
      configurable: true,
      get(this: Element) {
        return this === slotted ? slot : null;
      },
    });
    const restore = laidOut({
      boxes: {
        frame: [0, 0, 300, 60],
        clipper: [0, 0, 300, 40],
        inner: [0, 0, 300, 200],
        slotted: [0, 0, 300, 200],
      },
      runs: {
        'Top line': [[0, 10, 100, 30]],
        'Lower line, far down': [[0, 100, 100, 120]],
        First: [[0, 10, 100, 30]],
        'Second, far down': [[0, 45, 100, 58]],
      },
      styles: {
        frame: { overflowY: 'hidden', overflowX: 'hidden' },
        clipper: { overflowY: 'hidden', overflowX: 'hidden' },
      },
    });
    try {
      // From a shadow tree's top to its host, which hides what runs past it.
      expect(shownTextIn(shadow.getElementById('inner') as Element, 80)?.text).toBe('Top line');
      // From a slotted element to its slot, in a box that hides what overflows.
      expect(shownTextIn(slotted, 80)?.text).toBe('First');
    } finally {
      delete (Element.prototype as unknown as { assignedSlot?: unknown }).assignedSlot;
      restore();
    }
    // Deeper than the climb goes: it cannot be told.
    document.body.innerHTML = `${'<div>'.repeat(1_001)}<b id="deep">Deep</b>${'</div>'.repeat(1_001)}`;
    const deep = laidOut({ boxes: { deep: [0, 0, 100, 20] }, runs: { Deep: [[0, 0, 50, 20]] } });
    try {
      expect(shownTextIn(document.getElementById('deep') as Element, 80)).toBeNull();
    } finally {
      deep();
    }
  });

  it('runs on what is drawn on, and sets apart blocks and runs drawn apart', () => {
    document.body.innerHTML =
      '<div id="row"><mark id="m">Pay</mark>ments <span id="a">Buy</span><span id="b">now</span>' +
      '<span id="t">Send</span><span id="u">Money</span><div id="c1">Invoice</div>' +
      '<div id="c2">Paid</div><span id="w">Gift</span> card<span id="v1">Up</span>' +
      '<span id="v2">Down</span></div>';
    const inline = { display: 'inline' };
    const upright = { display: 'inline', writingMode: 'vertical-rl' };
    const restore = laidOut({
      boxes: { row: [-100, -100, 400, 200] },
      runs: {
        // A highlight's "Pay" and the "ments" it touches.
        Pay: [[10, 10, 40, 30]],
        ments: [[40, 10, 100, 30]],
        // Two runs a margin apart, and two set with letter spacing.
        Buy: [[110, 10, 140, 30]],
        now: [[160, 10, 190, 30]],
        Send: [[200, 10, 240, 30]],
        Money: [[240, 10, 290, 30]],
        // Two blocks side by side.
        Invoice: [[0, 40, 50, 60]],
        Paid: [[50, 40, 80, 60]],
        // A space written between two that touch.
        Gift: [[0, 70, 30, 90]],
        card: [[30, 70, 70, 90]],
        // Written down the page: on from each other along it.
        Up: [[100, 40, 120, 60]],
        Down: [[100, 60, 120, 100]],
      },
      styles: {
        m: inline,
        a: inline,
        b: inline,
        t: { display: 'inline', letterSpacing: '4px' },
        u: inline,
        w: inline,
        v1: upright,
        v2: upright,
      },
    });
    try {
      expect(shownTextIn(document.getElementById('row') as Element, 500)?.text).toBe(
        'Payments Buy now Send Money Invoice Paid Gift card UpDown',
      );
    } finally {
      restore();
    }
  });

  it("runs on what touches a highlight's box, and boxes set in a line as they are drawn", () => {
    const drawnAs = (
      html: string,
      runs: Record<string, Box[]>,
      styles: Record<string, Record<string, string>>,
      boxes: Record<string, Box> = {},
    ) => {
      document.body.innerHTML = `<div id="row">${html}</div>`;
      const restore = laidOut({ boxes: { row: [-100, -100, 600, 200], ...boxes }, runs, styles });
      const rects = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (
        this: Element,
      ) {
        return (boxes[this.id] ? [rect(boxes[this.id])] : []) as unknown as DOMRectList;
      });
      try {
        return shownTextIn(document.getElementById('row') as Element, 500)?.text;
      } finally {
        rects.mockRestore();
        restore();
      }
    };
    const yellow = { display: 'inline', backgroundColor: 'rgb(252, 248, 227)' };
    const mark = '<mark id="m">Pay</mark>ment methods';
    const runs: Record<string, Box[]> = {
      Pay: [[10, 10, 40, 30]],
      'ment methods': [[45, 10, 150, 30]],
    };
    const padded: Record<string, Box> = { m: [5, 5, 45, 35] };
    // A search's highlight, padded 5px: "ment" touches its box, if not its "Pay".
    expect(drawnAs(mark, runs, { m: yellow }, padded)).toBe('Payment methods');
    // With nothing drawn around it, the gap is the letters'.
    expect(drawnAs(mark, runs, { m: { display: 'inline' } }, padded)).toBe('Pay ment methods');
    // A border draws a box as well; one in a colour of none does not.
    const border = (color: string) => ({
      display: 'inline',
      borderBottomWidth: '2px',
      borderBottomStyle: 'solid',
      borderBottomColor: color,
    });
    expect(drawnAs(mark, runs, { m: border('rgb(0, 0, 0)') }, padded)).toBe('Payment methods');
    expect(drawnAs(mark, runs, { m: border('rgba(0, 0, 0, 0)') }, padded)).toBe('Pay ment methods');
    // Padded past a third of the letters' size, the box sets them apart.
    expect(
      drawnAs(
        mark,
        { Pay: [[30, 10, 60, 30]], 'ment methods': [[90, 10, 190, 30]] },
        { m: yellow },
        { m: [0, 5, 90, 35] },
      ),
    ).toBe('Pay ment methods');
    // A highlight a run begins: from its box's start.
    expect(
      drawnAs(
        'Pay<mark id="m">ment</mark> methods',
        { Pay: [[10, 10, 40, 30]], ment: [[45, 10, 90, 30]], methods: [[95, 10, 150, 30]] },
        { m: yellow },
        { m: [40, 5, 95, 35] },
      ),
    ).toBe('Payment methods');
    // Two chips side by side, each drawn and padded: as far apart as drawn.
    expect(
      drawnAs(
        '<span id="c1">Buy</span><span id="c2">49,00 €</span>',
        { Buy: [[10, 10, 40, 30]], '49,00 €': [[56, 10, 120, 30]] },
        { c1: yellow, c2: yellow },
        { c1: [2, 5, 48, 35], c2: [48, 5, 128, 35] },
      ),
    ).toBe('Buy 49,00 €');
    // A word and a price chip padded beside it: the chip's box splits no word
    // -- letters on both sides are what it joins.
    expect(
      drawnAs(
        'Buy<span id="c2">49,00 €</span>',
        { Buy: [[10, 10, 40, 30]], '49,00 €': [[45, 10, 110, 30]] },
        { c2: yellow },
        { c2: [40, 5, 114, 35] },
      ),
    ).toBe('Buy 49,00 €');
    // Nor a chip that begins with a letter: one holding a word of its own and
    // more ("CHF 49.00"), a tag in capitals ("NEW"), one whose word begins in
    // a capital ("Now") -- only a piece of a word, going on in lower case.
    for (const chip of ['CHF 49.00', 'NEW', 'Now']) {
      expect(
        drawnAs(
          `Buy<span id="c2">${chip}</span>`,
          { Buy: [[10, 10, 40, 30]], [chip]: [[45, 10, 110, 30]] },
          { c2: yellow },
          { c2: [40, 5, 114, 35] },
        ),
        chip,
      ).toBe(`Buy ${chip}`);
    }
    // Two inline blocks of one wordmark run on; two a margin apart do not.
    const block = { display: 'inline-block' };
    expect(
      drawnAs(
        'Log in with <span id="w1">Pay</span><span id="w2">Pal</span>',
        { 'Log in with': [[0, 10, 80, 30]], Pay: [[84, 10, 110, 30]], Pal: [[110, 10, 135, 30]] },
        { w1: block, w2: block },
      ),
    ).toBe('Log in with PayPal');
    expect(
      drawnAs(
        '<span id="w1">Buy</span><span id="w2">49,00 €</span>',
        { Buy: [[0, 10, 30, 30]], '49,00 €': [[38, 10, 100, 30]] },
        { w1: block, w2: block },
      ),
    ).toBe('Buy 49,00 €');
  });

  it('takes a clip-path for one that leaves nothing when its sides meet or it holds no area', () => {
    const cases: [string, string, boolean][] = [
      ['ix', 'inset(0px 50%)', false],
      ['iy', 'inset(0px 0px 100% 0px)', false],
      ['flat', 'polygon(0px 0px, 0px 0px, 0px 0px)', false],
      ['tri', 'polygon(evenodd, 0% 0%, 100% 0%, 100% 100%)', true],
      ['calc', 'inset(calc(50% - 1px))', true],
      ['ell', 'ellipse(0px at 50% 50%)', false],
    ];
    document.body.innerHTML = `<div id="card">${cases
      .map(([id]) => `<h3 id="${id}">Words of ${id}</h3>`)
      .join('')}</div>`;
    const restore = laidOut({
      boxes: {
        card: [0, 0, 300, 300],
        ...Object.fromEntries(
          cases.map(([id], at) => [id, [0, at * 40, 300, at * 40 + 30] as Box]),
        ),
      },
      runs: Object.fromEntries(
        cases.map(([id], at) => [
          `Words of ${id}`,
          [[10, at * 40 + 5, 200, at * 40 + 25]] as Box[],
        ]),
      ),
      styles: Object.fromEntries(cases.map(([id, clipPath]) => [id, { clipPath }])),
    });
    try {
      expect(shownTextIn(document.getElementById('card') as Element, 500)?.text).toBe(
        cases
          .filter(([, , shown]) => shown)
          .map(([id]) => `Words of ${id}`)
          .join(' '),
      );
    } finally {
      restore();
    }
  });

  it('reads what a slot draws of the page around it, in the box it is in', () => {
    // A closed buy box whose "Buy now $49.00" the page slots in beside a field:
    // the box draws it, though no text of its own tree holds it.
    document.body.innerHTML =
      '<pay-b id="host"><span id="label">Buy now $49.00</span> <input id="qty" type="number"></pay-b>';
    const host = document.getElementById('host') as HTMLElement;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<div id="box" onclick="buy()"><slot id="slot"></slot></div>';
    const slot = root.getElementById('slot') as HTMLSlotElement;
    const label = document.getElementById('label') as Element;
    const qty = document.getElementById('qty') as Element;
    const assigned = vi
      .spyOn(HTMLSlotElement.prototype, 'assignedNodes')
      .mockImplementation(function (this: HTMLSlotElement) {
        return this === slot ? [label, document.createTextNode(' '), qty] : [];
      });
    try {
      expect(wordsAroundAcrossShadowTrees(slot, true, () => null, true)).toContain(
        'Buy now $49.00',
      );
    } finally {
      assigned.mockRestore();
      document.body.innerHTML = '';
    }
  });

  it('reads nothing a slot or a shadow tree holds that is not drawn', () => {
    // A box that slots in a label, a note kept hidden, and a group of no box of
    // its own; a submenu waiting in a hidden panel of its tree; a tooltip's
    // content in a hidden box.
    document.body.innerHTML =
      '<pay-b id="host"><span id="label">Buy now $49.00</span>' +
      '<div id="gone" hidden>Pay later with Klarna</div>' +
      '<div id="flat" style="display:contents"><span id="seen">Seen here</span>' +
      '<span id="unseen" hidden>Pay in 4</span></div>' +
      '<div id="sub" slot="submenu">Buy gift cards</div></pay-b>';
    const host = document.getElementById('host') as HTMLElement;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML =
      '<div id="box" onclick="buy()"><slot id="slot"></slot>' +
      '<div id="panel" hidden><slot id="menu" name="submenu"></slot></div></div>' +
      '<div id="tip" hidden>Or 4 interest-free payments of $12.25</div>';
    const slot = root.getElementById('slot') as HTMLSlotElement;
    const menu = root.getElementById('menu') as HTMLSlotElement;
    const byId = (id: string) => document.getElementById(id) as Element;
    const assigned = vi
      .spyOn(HTMLSlotElement.prototype, 'assignedNodes')
      .mockImplementation(function (this: HTMLSlotElement) {
        return this === slot
          ? [byId('label'), byId('gone'), byId('flat')]
          : this === menu
            ? [byId('sub')]
            : [];
      });
    // What the browser draws: nothing under a hidden box, and no box of its own
    // for one of display: contents. (The submenu itself it would not draw
    // either; that the walk does not go into the panel is what is tried here.)
    Object.defineProperty(Element.prototype, 'checkVisibility', {
      configurable: true,
      value(this: Element) {
        return !this.closest('[hidden]') && getComputedStyle(this).display !== 'contents';
      },
    });
    try {
      const words = wordsAroundAcrossShadowTrees(slot, true, () => null, true);
      expect(words).toContain('Buy now $49.00');
      expect(words).toContain('Seen here');
      for (const unseen of ['Klarna', 'Pay in 4', 'gift cards', 'interest-free']) {
        expect(words).not.toContain(unseen);
      }
    } finally {
      assigned.mockRestore();
      delete (Element.prototype as unknown as { checkVisibility?: unknown }).checkVisibility;
      document.body.innerHTML = '';
    }
  });

  it('reads a wrapper short by its text as it is drawn too, words its text runs on set apart', () => {
    // "Buy" and "49,00 €" in two inline boxes a margin apart: the text runs
    // them on, the drawing sets them apart.
    document.body.innerHTML =
      '<div id="box" onclick="buy()"><span>Buy</span><span>49,00 €</span> <x-chip id="chip"></x-chip></div>';
    const chip = document.getElementById('chip') as HTMLElement;
    chip.attachShadow({ mode: 'open' }).innerHTML = '<button id="d">Details</button>';
    const details = chip.shadowRoot?.getElementById('d') as Element;
    const box = document.getElementById('box') as Element;
    const drawnApart = (node: Element) =>
      node === box ? { length: 19, text: 'Buy 49,00 € Details' } : null;
    expect(wordsAroundAcrossShadowTrees(details, true, drawnApart)).toContain('Buy 49,00 €');
    // No drawing to read, or one past the limit: its text alone.
    expect(wordsAroundAcrossShadowTrees(details, true, () => null)).not.toContain('Buy 49');
    const long = (node: Element) => (node === box ? { length: 200, text: 'x'.repeat(200) } : null);
    expect(wordsAroundAcrossShadowTrees(details, true, long)).not.toContain('xxx');
    document.body.innerHTML = '';
  });

  it('takes a wrapper for a short one by what it shows, when its text is long', () => {
    document.body.innerHTML =
      `<p>${'Our store ships worldwide, and returns are free. '.repeat(3)}</p>` +
      '<div id="box" onclick="buy()"><b>Buy now $49.00</b> ' +
      `<span>${'Wireless headphones with a long battery life. '.repeat(3)}</span> ` +
      '<x-chip id="chip"></x-chip></div>';
    const chip = document.getElementById('chip') as HTMLElement;
    chip.attachShadow({ mode: 'open' }).innerHTML =
      '<button id="d">Details</button><i id="icon"></i>';
    const details = chip.shadowRoot?.getElementById('d') as Element;
    const icon = chip.shadowRoot?.getElementById('icon') as Element;
    const box = document.getElementById('box') as Element;
    // By its text the box is long, and a click on "Details" goes on to nothing read.
    expect(wordsAroundAcrossShadowTrees(details, true)).toBe('');
    // What it shows is "Buy now $49.00": the rest is for screen readers.
    const shows = (node: Element) => (node === box ? { length: 14, text: 'Buy now $49.00' } : null);
    expect(wordsAroundAcrossShadowTrees(details, true, shows)).toContain('Buy now $49.00');
    // A mute icon in it is labelled by the box too.
    expect(wordsAroundAcrossShadowTrees(icon, false)).not.toContain('Buy now');
    expect(wordsAroundAcrossShadowTrees(icon, false, shows)).toContain('Buy now $49.00');
    // A measure that cannot be taken, or fails, leaves the text to decide.
    expect(wordsAroundAcrossShadowTrees(details, true, () => null)).toBe('');
    const failing = () => {
      throw new Error('the page went away');
    };
    expect(wordsAroundAcrossShadowTrees(details, true, failing)).toBe('');
    // In the page it runs with its measure: one function, nothing of this
    // module's. (Run here it would meet the counters coverage writes into both.)
    const source = String(wordsAroundInPage);
    expect(source).toContain('function wordsAroundAcrossShadowTrees');
    expect(source).toContain('function shownTextIn');
    expect(wordsAroundInPage).toHaveLength(2);
    // What a box shows is read first: a long text's cut would leave it out.
    box.insertAdjacentHTML('afterbegin', `<span>${'x'.repeat(700)}</span>`);
    expect(wordsAroundAcrossShadowTrees(details, true, shows)).toContain('Buy now $49.00');
    // From a slot of a closed tree, the read goes on through the slot's own tree.
    const root = document.createElement('div');
    root.innerHTML = '<div id="slotbox" onclick="buy()"><b>Buy now $49.00</b> <slot></slot></div>';
    document.body.append(root);
    const slot = root.querySelector('slot') as Element;
    expect(wordsAroundAcrossShadowTrees(slot, true, () => null, true)).toContain('Buy now $49.00');
    document.body.innerHTML = '';
  });
});

describe("telling a dialog of a frame inside the page from the top frame's", () => {
  function watched(options: { on?: boolean; rejects?: boolean } = {}) {
    const handlers = new Map<string, (params: Record<string, unknown>) => void>();
    const cdp = {
      ...(options.on === false
        ? {}
        : {
            on: (event: string, handler: (params: Record<string, unknown>) => void) => {
              handlers.set(event, handler);
            },
          }),
      send: async (method: string) =>
        method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'top' } } } : {},
    };
    const page = {
      context: () => ({
        newCDPSession: async () => {
          if (options.rejects) {
            throw new Error('Target closed');
          }
          return cdp;
        },
      }),
    };
    const report = (message: string, frameId: string) =>
      handlers.get('Page.javascriptDialogOpening')?.({ type: 'alert', message, frameId });
    return { fromAFrame: watchTopFrameDialogs(page), report };
  }
  const dialog = (message: string) => ({ type: () => 'alert', message: () => message });

  it('tells them apart by the frame the browser reports', async () => {
    const { fromAFrame, report } = watched();
    // Reported before it is asked about, or after.
    await new Promise((resolve) => setTimeout(resolve, 0));
    report('Widget says hi', 'chat-widget');
    await expect(fromAFrame?.(dialog('Widget says hi'))).resolves.toBe(true);
    report('Discard draft?', 'top');
    await expect(fromAFrame?.(dialog('Discard draft?'))).resolves.toBe(false);
    const late = fromAFrame?.(dialog('Widget again'));
    setTimeout(() => report('Widget again', 'chat-widget'), 20);
    await expect(late).resolves.toBe(true);
    // Only so many reports are kept, the oldest let go.
    for (let n = 0; n < 40; n += 1) {
      report(`Widget ${n}`, 'chat-widget');
    }
    await expect(fromAFrame?.(dialog('Widget 39'))).resolves.toBe(true);
    // Never reported: held, as before.
    await expect(fromAFrame?.(dialog('Nobody said'))).resolves.toBe(false);
  });

  it('takes no report from long before the dialog it is asked about', async () => {
    const { fromAFrame, report } = watched();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const now = vi.spyOn(Date, 'now');
    try {
      // The top frame's "Saved", which no dialog took; then a frame's, the
      // same words, a while later.
      now.mockReturnValue(1_000);
      report('Saved', 'top');
      now.mockReturnValue(3_500);
      report('Saved', 'chat-widget');
      await expect(fromAFrame?.(dialog('Saved'))).resolves.toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('holds every dialog when it has no way to watch', async () => {
    expect(watchTopFrameDialogs({})).toBeUndefined();
    for (const options of [{ on: false }, { rejects: true }]) {
      const { fromAFrame } = watched(options);
      await expect(fromAFrame?.(dialog('Widget says hi'))).resolves.toBe(false);
    }
  });
});

describe('whether a pointer would reach an element where Playwright aims it', () => {
  // Run in the page; here, against elements made of what it reads.
  interface Node {
    parentElement?: Node | null;
    parentNode?: unknown;
    assignedSlot?: Node | null;
    shadowRoot?: {
      elementFromPoint(x: number, y: number): Node | null;
      elementsFromPoint?(x: number, y: number): Node[];
    } | null;
  }
  type Rect = { left: number; top: number; right: number; bottom: number };
  const VIEW = { innerWidth: 800, innerHeight: 600 };

  function target(options: {
    boxes?: Rect[];
    hit?: (self: Node, x: number, y: number) => Node | null;
    field?: boolean;
    closest?: Node | null;
  }) {
    const aimedAt: [number, number][] = [];
    const self: Node & Record<string, unknown> = {
      parentElement: null,
      getClientRects: () => options.boxes ?? [{ left: 10, top: 10, right: 110, bottom: 30 }],
      matches: () => options.field === true,
      isContentEditable: false,
      closest: () => options.closest ?? null,
      ownerDocument: {
        defaultView: VIEW,
        elementFromPoint: (x: number, y: number) => {
          aimedAt.push([x, y]);
          return options.hit ? options.hit(self, x, y) : self;
        },
      },
    };
    return { element: self as unknown as Element, aimedAt };
  }

  it('aims at the middle of the first box, of the part in view', () => {
    // A link that wraps: its first line. A box taller than the window: what shows.
    const wrapped = target({
      boxes: [
        { left: 0, top: 0, right: 0, bottom: 0 },
        { left: 200, top: 40, right: 300, bottom: 60 },
        { left: 0, top: 70, right: 50, bottom: 90 },
      ],
    });
    expect(reachedWherePlaywrightAims(wrapped.element)).toBe(true);
    expect(wrapped.aimedAt).toEqual([[250, 50]]);
    const tall = target({ boxes: [{ left: 0, top: -400, right: 100, bottom: 2_600 }] });
    expect(reachedWherePlaywrightAims(tall.element)).toBe(true);
    expect(tall.aimedAt).toEqual([[50, 300]]);
    // Nothing of it in view, or nothing of it at all: not reached.
    expect(
      reachedWherePlaywrightAims(
        target({ boxes: [{ left: 0, top: 700, right: 100, bottom: 720 }] }).element,
      ),
    ).toBe(false);
    expect(reachedWherePlaywrightAims(target({ boxes: [] }).element)).toBe(false);
  });

  it('counts a hit on the element or anything inside it, through shadow trees and slots', () => {
    const inside = (self: Node): Node => ({ parentElement: self });
    expect(reachedWherePlaywrightAims(target({ hit: (self) => inside(self) }).element)).toBe(true);
    // The document says the host; the host's own tree says what in it was hit.
    const inShadow = target({
      hit: (self) => {
        const shadow = { nodeType: 11, host: self };
        const deep: Node = { parentElement: null, parentNode: shadow };
        self.shadowRoot = { elementFromPoint: () => deep };
        return self;
      },
    });
    expect(reachedWherePlaywrightAims(inShadow.element)).toBe(true);
    // A node slotted into it.
    const slotted = target({
      hit: (self) => ({ assignedSlot: { parentElement: self } }),
    });
    expect(reachedWherePlaywrightAims(slotted.element)).toBe(true);
    // A host whose tree says itself, or nothing: the host.
    const flat = target({
      hit: (self) => {
        self.shadowRoot = { elementFromPoint: () => null };
        return self;
      },
    });
    expect(reachedWherePlaywrightAims(flat.element)).toBe(true);
  });

  it('finds what is hit in a tree over text a slot puts in it, as Playwright does', () => {
    // A component's own button labelled by text the page slots in: the
    // document and the tree both answer with the host; under the point in the
    // tree, first, the button.
    const host: Node = { parentElement: null };
    const button = target({
      hit: (self) => {
        host.shadowRoot = { elementFromPoint: () => host, elementsFromPoint: () => [self, host] };
        return host;
      },
    });
    expect(reachedWherePlaywrightAims(button.element)).toBe(true);
    // Nothing under the point in it: the host, which is not the button.
    const empty = target({
      hit: () => {
        host.shadowRoot = { elementFromPoint: () => host, elementsFromPoint: () => [] };
        return host;
      },
    });
    expect(reachedWherePlaywrightAims(empty.element)).toBe(false);
  });

  it('counts a hit on the button or link around it, which is what Playwright aims for', () => {
    const button: Node = { parentElement: null };
    expect(reachedWherePlaywrightAims(target({ closest: button, hit: () => button }).element)).toBe(
      true,
    );
    // A field is aimed at itself, never at what is around it.
    expect(
      reachedWherePlaywrightAims(
        target({ field: true, closest: button, hit: () => button }).element,
      ),
    ).toBe(false);
  });

  it('says no for anything else, or nothing at all', () => {
    const other: Node = { parentElement: { parentElement: null, parentNode: { nodeType: 9 } } };
    expect(reachedWherePlaywrightAims(target({ hit: () => other }).element)).toBe(false);
    expect(reachedWherePlaywrightAims(target({ hit: () => null }).element)).toBe(false);
  });
});

describe('telling whether the profile is in use', () => {
  // Chrome's SingletonLock is a symlink to nothing on macOS and Linux, which a
  // check that follows links calls missing. The lock is looked at itself.
  it('sees a lock file in the profile without following it', async () => {
    const profile = fs.mkdtempSync(join(os.tmpdir(), 'aoi-drive-lock-'));
    try {
      fs.writeFileSync(join(profile, 'lockfile'), '');
      fs.writeFileSync(
        join(profile, 'aoi-drive-port.json'),
        JSON.stringify({ aoiDrivePort: 51333, aoiDriveWsPath: '/devtools/browser/running' }),
      );
      const { deps } = happyDeps({
        fileExists: undefined,
        readFile: (path: string) => fs.readFileSync(path, 'utf8'),
        probeDevTools: async (port: number) =>
          port === 51333 ? 'ws://127.0.0.1:51333/devtools/browser/running' : null,
      });
      const session = await startAoiBrowserDriveSession(
        { engine: 'chrome', userDataDir: profile },
        deps,
      );
      expect(deps.spawnImpl).not.toHaveBeenCalled();
      expect(session.port).toBe(51333);
      await session.close();
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });

  it('launches when the profile holds no lock', async () => {
    const profile = fs.mkdtempSync(join(os.tmpdir(), 'aoi-drive-lock-'));
    try {
      const { deps } = happyDeps({
        fileExists: undefined,
        probeDevTools: async (port: number) => `ws://127.0.0.1:${port}/devtools/browser/new`,
        writeFile: () => undefined,
      });
      const session = await startAoiBrowserDriveSession(
        { engine: 'chrome', userDataDir: profile },
        deps,
      );
      expect(deps.spawnImpl).toHaveBeenCalledTimes(1);
      await session.close();
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
});

describe('launching when the browser answers oddly', () => {
  it('does not connect through a DevTools answer that is not its own socket', async () => {
    // Playwright would go wherever the answer points; an answer off this
    // machine, on another port or unreadable did not come from this browser.
    for (const answer of [
      'not a url',
      'ws://evil.example:51222/devtools/browser/abc',
      'ws://127.0.0.1:9222/devtools/browser/abc',
    ]) {
      const connect = vi.fn();
      const { deps } = happyDeps({
        fileExists: () => false,
        probeDevTools: async () => answer,
        writeFile: () => undefined,
        connect,
      });
      await expect(
        startAoiBrowserDriveSession(PROFILE_OPTIONS, deps),
        answer,
      ).rejects.toMatchObject({ reason: 'attach_timeout' });
      expect(connect, answer).not.toHaveBeenCalled();
    }
  });

  it('attaches through the port file when the answer is not usable but the file is', async () => {
    const { deps } = happyDeps({
      probeDevTools: async () => 'not a url',
      fileExists: (path: string) => path.endsWith('DevToolsActivePort'),
      readFile: () => '51222\n/devtools/browser/from-file',
      writeFile: () => undefined,
    });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    expect(session.port).toBe(51222);
    await session.close();
  });

  it('times out plainly when even the lockfile cannot be checked', async () => {
    let clock = 1_000;
    const { deps } = happyDeps({
      probeDevTools: async () => null,
      // Every other file is simply absent; only the lockfile cannot be looked at.
      fileExists: (path: string) => {
        if (path.includes('lockfile')) {
          throw new Error('access denied');
        }
        return false;
      },
      now: () => {
        clock += 200;
        return clock;
      },
    });
    const failure = await startAoiBrowserDriveSession(
      { ...PROFILE_OPTIONS, timeoutMs: 1_000 },
      deps,
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ reason: 'attach_timeout' });
    expect(String((failure as Error).message)).not.toContain('lockfile');
  });

  it('reports any other failure while waiting as a timeout to attach', async () => {
    const { deps, child } = happyDeps({
      probeDevTools: async () => {
        throw new Error('probe exploded');
      },
    });
    await expect(startAoiBrowserDriveSession(PROFILE_OPTIONS, deps)).rejects.toMatchObject({
      reason: 'attach_timeout',
      message: expect.stringContaining('probe exploded'),
    });
    expect(child.kill).toHaveBeenCalled();
  });
});

describe('where the browser says a click lands', () => {
  // An accessibility tree, a row per node: id, its element, role, name, parent.
  type Row = [string, number, string, string, string?, boolean?];
  const axTree = (...rows: Row[]) => ({
    nodes: rows.map(([nodeId, backendDOMNodeId, role, name, parentId, ignored]) => ({
      nodeId,
      backendDOMNodeId,
      role: { value: role },
      name: { value: name },
      childIds: rows.filter((row) => row[4] === nodeId).map((row) => row[0]),
      ...(parentId ? { parentId } : {}),
      ...(ignored ? { ignored } : {}),
    })),
  });

  it('reads the hit, what it holds, the controls around it and what its attributes say', () => {
    const tree = axTree(
      ['n13', 13, 'generic', 'own', 'n10'],
      ['n10', 10, 'button', 'Details', 'n5'],
      ['n5', 5, 'generic', 'a card', 'n4'],
      ['n4', 4, 'link', 'Buy now Details', 'n1'],
      ['n1', 1, 'RootWebArea', 'Shop'],
    );
    // What it holds: text -- shown text the read-out leaves out too -- an image,
    // a control, whatever has a name; not a box of the text, nor its own name
    // again.
    const held = axTree(
      ['h0', 13, 'generic', 'a wrapper'],
      ['h1', 31, 'StaticText', 'Pay', 'h0'],
      ['h2', 32, 'InlineTextBox', 'Pay', 'h1'],
      ['h3', 33, 'StaticText', 'now', 'h0', true],
      ['h4', 34, 'image', 'card logo', 'h0'],
      ['h5', 35, 'button', 'More', 'h0'],
    );
    expect(wordsOfAimedNode(tree, 13, ['alt', 'Pay', 'TITLE', 'a title', 'class', 'x'], held)).toBe(
      'own Pay now card logo More Details Buy now Details Pay a title',
    );
    // A node the tree does not hold says only what its attributes do.
    expect(wordsOfAimedNode(axTree(), 7, ['aria-label', 'Close'])).toBe('Close');
    // What a hit holds that its control already says is read in the control's
    // name: a search's highlight, the runs of a wordmark -- not in pieces.
    const highlight = axTree(
      ['m', 21, 'mark', '', 'a'],
      ['a', 20, 'link', 'Payment methods we accept', 'r'],
      ['r', 1, 'RootWebArea', 'Help'],
    );
    expect(wordsOfAimedNode(highlight, 21, [], axTree(['s', 22, 'StaticText', 'Pay', 'm']))).toBe(
      'Payment methods we accept',
    );
    const wordmark = axTree(
      ['w', 31, 'generic', '', 'b'],
      ['b', 30, 'button', 'Log in with PayPal', 'r'],
      ['r', 1, 'RootWebArea', 'Shop'],
    );
    expect(
      wordsOfAimedNode(
        wordmark,
        31,
        [],
        axTree(['p', 32, 'StaticText', 'Pay', 'w'], ['q', 33, 'StaticText', 'Pal', 'w']),
      ),
    ).toBe('Log in with PayPal');
    // A result card, one link around a heading the highlight is in: the text
    // is the link's, read in its name; the heading's name stands beside it.
    const card = axTree(['l', 40, 'link', 'Payment methods we accept Which cards we take', 'r']);
    expect(
      wordsOfAimedNode(
        card,
        40,
        [],
        axTree(
          ['h', 41, 'heading', 'Payment methods we accept', 'l'],
          ['s1', 42, 'StaticText', 'Pay', 'h'],
          ['s2', 43, 'StaticText', 'ment methods we accept', 'h'],
          ['s3', 44, 'StaticText', 'Which cards we take', 'l'],
        ),
      ),
    ).toBe('Payment methods we accept Which cards we take Payment methods we accept');
    // What it draws that the names hold is read in them; anything else beside.
    expect(aimedWordsWith('Payment methods we accept', 'Pay')).toBe('Payment methods we accept');
    expect(aimedWordsWith('Continue', 'Pay $19.99')).toBe('Continue Pay $19.99');
    expect(wordsOfAimedNode({}, 7, [])).toBe('');
    // A name of a whole card is read by its start and its end.
    const long = `${'a '.repeat(400)}Buy now`;
    const read = wordsOfAimedNode(axTree(['n1', 1, 'link', long]), 1, []);
    expect(read).toContain('Buy now');
    expect(read.length).toBeLessThan(700);
  });

  it('reads a piece of text the click lands on as the word it runs on into, as drawn', async () => {
    // A highlight with no name that holds only text: the word it is drawn in.
    const mark = axTree(
      ['m', 21, 'mark', '', 'c'],
      ['c', 20, 'generic', '', 'r'],
      ['r', 1, 'RootWebArea', 'Help'],
    );
    const held = axTree(['s', 22, 'StaticText', 'pay', 'm']);
    expect(wordsOfAimedNode(mark, 21, [], held)).toBe('pay');
    expect(wordsOfAimedNode(mark, 21, [], held, 'payments')).toBe('payments');
    // Not a hit with a name, nor one that holds something named.
    const link = axTree(['b', 31, 'link', 'Pay', 'r'], ['r', 1, 'RootWebArea', 'Shop']);
    expect(
      wordsOfAimedNode(link, 31, [], axTree(['t', 32, 'StaticText', 'Pay', 'b']), 'Payment'),
    ).toBe('Pay');
    expect(
      wordsOfAimedNode(
        mark,
        21,
        [],
        axTree(['i', 23, 'image', 'Pay now', 'm'], ['s', 22, 'StaticText', 'pay', 'm']),
        'payments',
      ),
    ).toBe('Pay now pay');
    // The session reads it in the hit's world, and reads it whole.
    const { tab, session: cdp } = aimingTab({
      drawn: 'pay',
      replies: {
        'DOM.describeNode': (params: Record<string, unknown>) =>
          params.objectId ? { node: { backendNodeId: 10 } } : { node: { nodeName: 'mark' } },
        'Accessibility.getPartialAXTree': axTree(
          ['n13', 13, 'mark', '', 'n10'],
          ['n10', 10, 'generic', '', 'n1'],
        ),
        'Accessibility.queryAXTree': axTree(['s', 14, 'StaticText', 'pay', 'n13']),
        'Runtime.callFunctionOn': (params: Record<string, unknown>) =>
          String(params.functionDeclaration).includes('runsInto')
            ? { result: { value: 'payments' } }
            : String(params.functionDeclaration).includes('closedRoots')
              ? { result: { value: { text: 'pay', said: '', whole: true } } }
              : { result: { value: true } },
      },
    });
    const { session, aim } = await aimOn(tab);
    await expect(aim?.('#b')).resolves.toMatchObject({ words: 'payments' });
    await session.close();
    const source = (cdp.send.mock.calls as unknown as [string, Record<string, unknown>][])
      .map(([, params]) => String(params?.functionDeclaration ?? ''))
      .find((declaration) => declaration.includes('runsInto'));
    const runsOn = new Function(`return (${source})`)() as (this: Element) => string;
    // Run here, on a page of the test's own: divs and paragraphs are blocks,
    // the rest set inline; each run of text drawn where `layout` says.
    type Box = [number, number, number, number];
    const layout: Record<string, Box> = {
      My: [0, 0, 20, 16],
      pay: [24, 0, 48, 16],
      'ments due': [48, 0, 110, 16],
      re: [0, 20, 14, 36],
      ward: [14, 20, 44, 36],
      Pay: [0, 40, 24, 56],
      now: [40, 40, 64, 56],
      Buy: [0, 60, 24, 76],
      it: [24, 60, 40, 76],
      Sub: [0, 80, 20, 96],
      way: [20, 80, 44, 96],
      tot: [0, 100, 20, 116],
      al: [20, 100, 32, 116],
      's here': [32, 100, 80, 116],
      up: [0, 120, 16, 136],
      side: [0, 136, 16, 168],
    };
    const styles = vi.spyOn(globalThis, 'getComputedStyle').mockImplementation(
      (element) =>
        ({
          display: /^(DIV|P)$/.test((element as Element).tagName) ? 'block' : 'inline',
          writingMode: (element as Element).id === 'v' ? 'vertical-rl' : '',
        }) as unknown as CSSStyleDeclaration,
    );
    const rects = vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (
      this: Range,
    ) {
      const box = layout[String(this.startContainer.textContent ?? '').trim()];
      return (box
        ? [{ left: box[0], top: box[1], right: box[2], bottom: box[3] } as DOMRect]
        : []) as unknown as DOMRectList;
    });
    document.body.innerHTML =
      '<div>My <mark id="r1">pay</mark>ments due</div>' +
      '<div>re<mark id="r2">ward</mark></div>' +
      '<div><mark id="r3">Pay</mark><span>now</span></div>' +
      '<div><mark id="r4">Buy</mark> it</div>' +
      '<div><p>Sub</p><mark id="r5">way</mark></div>' +
      '<div id="blk">Block</div>' +
      '<div><mark id="r7">tot</mark><b>al</b>s here</div>' +
      '<div><mark id="r8"></mark>x</div>' +
      '<div><mark id="r9">no</mark>box</div>' +
      '<div id="v"><mark id="r10">up</mark>side</div>';
    try {
      const of = (id: string) => runsOn.call(document.getElementById(id) as Element);
      // Runs on into what it touches, as far as a space, either side.
      expect(of('r1')).toBe('payments');
      expect(of('r2')).toBe('reward');
      expect(of('r7')).toBe('totals');
      expect(of('r10')).toBe('upside');
      // Not into a run drawn apart, past a space, in another block, or into
      // nothing drawn; nor from a block, an element with no text, or one in no
      // block at all.
      expect(of('r3')).toBe('');
      expect(of('r4')).toBe('');
      expect(of('r5')).toBe('');
      expect(of('r9')).toBe('');
      expect(of('blk')).toBe('');
      expect(of('r8')).toBe('');
      expect(runsOn.call(document.createElement('mark'))).toBe('');
    } finally {
      styles.mockRestore();
      rects.mockRestore();
      document.body.innerHTML = '';
    }
  });

  it('tells whether the target is the hit or around it, through any tree the parents make', () => {
    const tree = axTree(
      ['n5', 5, 'generic', '', 'n9'],
      ['n9', 9, 'none', '', 'n4', true],
      ['n4', 4, 'button', '', 'n1'],
      ['n1', 1, 'RootWebArea', ''],
    );
    expect(axChainHolds(tree, 5, 5)).toBe(true);
    expect(axChainHolds(tree, 5, 4)).toBe(true);
    expect(axChainHolds(tree, 4, 9)).toBe(false);
    expect(axChainHolds(tree, 77, 4)).toBe(false);
    // Parents in a circle end the walk.
    const circle = axTree(['a', 1, 'generic', '', 'b'], ['b', 2, 'generic', '', 'a']);
    expect(axChainHolds(circle, 1, 3)).toBe(false);
  });

  it('aims where Playwright does: the middle of the first box in view, as much of it as shows', () => {
    // A link that wraps: its first line.
    const wrapped = [
      [132, 126, 243, 126, 243, 147, 132, 147],
      [0, 147, 216, 147, 216, 168, 0, 168],
    ];
    expect(aimPointOfQuads(wrapped, 800, 600)).toEqual({ x: 187, y: 136 });
    // A box taller than the window, and one out of view before one in it.
    expect(aimPointOfQuads([[0, -400, 100, -400, 100, 2_600, 0, 2_600]], 800, 600)).toEqual({
      x: 50,
      y: 300,
    });
    expect(
      aimPointOfQuads(
        [
          [0, 700, 100, 700, 100, 720, 0, 720],
          [10, 10, 30, 10, 30, 30, 10, 30],
        ],
        800,
        600,
      ),
    ).toEqual({ x: 20, y: 20 });
    // The nearest whole point stays in a box a pixel wide.
    expect(aimPointOfQuads([[10.2, 0, 11.2, 0, 11.2, 1, 10.2, 1]], 800, 600)).toEqual({
      x: 11,
      y: 0,
    });
    // Nothing that is a box, or nothing in view.
    expect(aimPointOfQuads('nope', 800, 600)).toBeNull();
    expect(
      aimPointOfQuads(
        [
          [1, 2, 3],
          [0, 0, 1, 0, 1, Number.NaN, 0, 1],
        ],
        800,
        600,
      ),
    ).toBeNull();
    expect(aimPointOfQuads([[0, 700, 100, 700, 100, 720, 0, 720]], 800, 600)).toBeNull();
  });

  it('hands the element over in the top document only', () => {
    const element = document.createElement('button');
    expect(handOverToProtocol(element, '__aoiTest1')).toBe(true);
    expect((window as unknown as Record<string, unknown>).__aoiTest1).toBe(element);
    delete (window as unknown as Record<string, unknown>).__aoiTest1;
    const top = Object.getOwnPropertyDescriptor(window, 'top');
    Object.defineProperty(window, 'top', { configurable: true, get: () => ({}) });
    try {
      expect(handOverToProtocol(element, '__aoiTest2')).toBe(false);
      expect('__aoiTest2' in window).toBe(false);
    } finally {
      if (top) {
        Object.defineProperty(window, 'top', top);
      }
    }
  });

  // A tab whose element is handed over, and a protocol session that answers
  // from a table.
  function aimingTab(options: {
    placed?: unknown;
    replies?: Record<string, unknown>;
    cdp?: 'none' | 'fails';
    crowded?: boolean;
    // What the walk in the check's own world finds drawn at the hit, and what
    // the DOM says of the hit being inside the target ('fails': no answer).
    drawn?: string;
    holds?: boolean | 'fails';
  }) {
    const sent: string[] = [];
    const replies: Record<string, unknown> = {
      'Runtime.evaluate': { result: { objectId: 'o1', subtype: 'node' } },
      'DOM.describeNode': (params: Record<string, unknown>) =>
        params.objectId
          ? { node: { backendNodeId: 10 } }
          : { node: { nodeName: 'span', attributes: ['title', 'Pay now'] } },
      'DOM.getContentQuads': { quads: [[0, 0, 100, 0, 100, 40, 0, 40]] },
      'Page.getLayoutMetrics': { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } },
      'Page.getFrameTree': {
        frameTree: {
          frame: { id: 'top' },
          childFrames: [{ frame: { id: 'child' }, childFrames: [{ frame: { id: 'grandchild' } }] }],
        },
      },
      'DOM.getNodeForLocation': { backendNodeId: 13, frameId: 'top' },
      'Accessibility.getPartialAXTree': (params: Record<string, unknown>) =>
        params.backendNodeId === 13
          ? axTree(['n13', 13, 'generic', '', 'n10'], ['n10', 10, 'button', 'Go', 'n1'])
          : axTree(['f', 20, 'Iframe', '', 'n10'], ['n10', 10, 'generic', '']),
      'DOM.getFrameOwner': { backendNodeId: 20 },
      'Page.createIsolatedWorld': { executionContextId: 5 },
      'DOM.resolveNode': (params: Record<string, unknown>) => ({
        object: { objectId: `node-${String(params.backendNodeId)}` },
      }),
      'Runtime.callFunctionOn': (params: Record<string, unknown>) => {
        if (String(params.functionDeclaration).includes('closedRoots')) {
          return { result: { value: { text: options.drawn ?? 'Pay now', said: '', whole: true } } };
        }
        if (options.holds === 'fails') {
          throw new Error('Execution context was destroyed.');
        }
        return { result: { value: options.holds ?? true } };
      },
      ...options.replies,
    };
    const session = {
      send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        sent.push(method);
        const reply = replies[method];
        if (reply instanceof Error) {
          throw reply;
        }
        return typeof reply === 'function' ? reply(params) : (reply ?? {});
      }),
      detach: vi.fn(async () => {}),
    };
    const newCDPSession = vi.fn(async () => {
      if (options.cdp === 'fails') {
        throw new Error('not a Chromium browser');
      }
      return session;
    });
    const evaluate = vi.fn(async (fn: unknown, name: string) => {
      expect(fn).toBe(handOverToProtocol);
      expect(name).toMatch(/^__aoiAim/);
      return 'placed' in options ? options.placed : true;
    });
    const tab = {
      url: () => 'https://shop.example/',
      close: vi.fn(async () => {}),
      locator: (selector: string) => ({
        evaluate,
        count: async () => (selector.includes('count(*) >') ? (options.crowded ? 1 : 0) : 1),
      }),
      ...(options.cdp === 'none' ? {} : { context: () => ({ newCDPSession }) }),
    };
    return { tab, session, sent, newCDPSession };
  }

  async function aimOn(tab: unknown) {
    const browser = {
      contexts: () => [{ newPage: async () => tab }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    const driven = session.page as unknown as {
      aimPointReadOut?: (
        s: string,
        o?: { timeout?: number },
      ) => Promise<{ words: string; frame: boolean; embedded: boolean; inside: boolean } | null>;
    };
    return { session, aim: driven.aimPointReadOut };
  }

  it('reads what is where the click is aimed, and whether it is inside the target', async () => {
    const { tab, sent, newCDPSession, session: cdp } = aimingTab({});
    const { session, aim } = await aimOn(tab);
    await expect(aim?.('#b', { timeout: 500 })).resolves.toEqual({
      // Its title, as the read-out has it and as the DOM does.
      words: 'Go Pay now',
      frame: false,
      embedded: false,
      inside: true,
      blank: false,
      lost: false,
    });
    expect(sent).toContain('Runtime.releaseObjectGroup');
    // The page's session is kept for the next read; its accessibility tree is
    // read on a session of its own each time, let go after the read.
    await aim?.('#b');
    expect(newCDPSession).toHaveBeenCalledTimes(3);
    expect(cdp.detach).toHaveBeenCalledTimes(2);
    await session.close();
  });

  it('follows a hit in a frame of the page back out to the top document', async () => {
    const { tab } = aimingTab({
      replies: { 'DOM.getNodeForLocation': { backendNodeId: 13, frameId: 'child' } },
    });
    const { session, aim } = await aimOn(tab);
    await expect(aim?.('#b')).resolves.toMatchObject({ inside: true });
    await session.close();
    // Two frames deep; a frame the tree does not hold, and an owner with no
    // element, where nothing can say: what is there is read, since it can only
    // add to what is refused.
    for (const [replies, inside] of [
      [{ 'DOM.getNodeForLocation': { backendNodeId: 13, frameId: 'grandchild' } }, true],
      [{ 'DOM.getNodeForLocation': { backendNodeId: 13, frameId: 'elsewhere' } }, true],
      [
        {
          'DOM.getNodeForLocation': { backendNodeId: 13, frameId: 'child' },
          'DOM.getFrameOwner': {},
        },
        true,
      ],
    ] as [Record<string, unknown>, boolean][]) {
      const { tab: other } = aimingTab({ replies, holds: false });
      const { session: next, aim: aimNext } = await aimOn(other);
      await expect(aimNext?.('#b')).resolves.toMatchObject({ inside });
      await next.close();
    }
  });

  it("counts an image map's area as inside the image it is clicked through", async () => {
    // The tree puts the area under its map, not under the image.
    for (const [nodeName, inside] of [
      ['AREA', true],
      ['SPAN', false],
    ] as [string, boolean][]) {
      const { tab } = aimingTab({
        replies: {
          'DOM.describeNode': (params: Record<string, unknown>) =>
            params.objectId
              ? { node: { backendNodeId: 10 } }
              : { node: { nodeName, attributes: ['alt', 'Buy now'] } },
          'Accessibility.getPartialAXTree': axTree(
            ['n13', 13, 'none', '', 'm'],
            ['m', 30, 'none', ''],
          ),
        },
        drawn: 'Buy now',
        holds: false,
      });
      const { session, aim } = await aimOn(tab);
      await expect(aim?.('#map')).resolves.toMatchObject({ words: 'Buy now', inside });
      await session.close();
    }
  });

  it('says when the hit is a frame it does not look into, or an embedded document', async () => {
    for (const [nodeName, frame, embedded] of [
      ['IFRAME', true, false],
      ['frame', true, false],
      ['OBJECT', false, true],
      ['EMBED', false, true],
    ] as [string, boolean, boolean][]) {
      const { tab } = aimingTab({
        replies: {
          'DOM.describeNode': (params: Record<string, unknown>) =>
            params.objectId ? { node: { backendNodeId: 10 } } : { node: { nodeName } },
        },
      });
      const { session, aim } = await aimOn(tab);
      await expect(aim?.('#b')).resolves.toMatchObject({ frame, embedded });
      await session.close();
    }
  });

  it('has no answer for an element it is not handed, or nothing of which is in view', async () => {
    for (const options of [
      { placed: false },
      { replies: { 'Runtime.evaluate': { result: { type: 'undefined' } } } },
      { replies: { 'Runtime.evaluate': { result: { objectId: 'o', subtype: 'array' } } } },
      {
        replies: {
          'DOM.describeNode': (params: Record<string, unknown>) =>
            params.objectId ? { node: {} } : { node: { nodeName: 'SPAN' } },
        },
      },
      { replies: { 'DOM.getContentQuads': { quads: [] } } },
      { replies: { 'Page.getLayoutMetrics': {} } },
      { replies: { 'DOM.getNodeForLocation': {} } },
      { cdp: 'fails' as const },
    ]) {
      const { tab } = aimingTab(options);
      const { session, aim } = await aimOn(tab);
      await expect(aim?.('#b'), JSON.stringify(options)).resolves.toBeNull();
      await session.close();
    }
    // A page that is no Playwright page has no way to ask.
    const { tab } = aimingTab({ cdp: 'none' });
    const { session, aim } = await aimOn(tab);
    expect(aim).toBeUndefined();
    await session.close();
  });

  it('asks no accessibility tree at the aim point among thousands of siblings', async () => {
    // Without the tree, the DOM says whether the hit is inside, in the check's
    // own world; and when it cannot, what is there is read all the same.
    for (const [holds, inside] of [
      [true, true],
      [false, false],
      ['fails', true],
    ] as [boolean | 'fails', boolean][]) {
      const { tab, sent } = aimingTab({ crowded: true, holds });
      const { session, aim } = await aimOn(tab);
      await expect(aim?.('#b'), String(holds)).resolves.toMatchObject({ inside });
      expect(sent.some((method) => method.startsWith('Accessibility.'))).toBe(false);
      await session.close();
    }
  });

  it('climbs from a hit to the target through hosts and the element a pseudo-element is drawn for', async () => {
    const { tab, session: cdp } = aimingTab({ crowded: true });
    const { session, aim } = await aimOn(tab);
    await aim?.('#b');
    await session.close();
    const asked = cdp.send.mock.calls as unknown as [string, Record<string, unknown>][];
    const source = asked
      .map(([, params]) => String(params?.functionDeclaration ?? ''))
      .find((declaration) => declaration.includes('(target)'));
    const holds = new Function(`return (${source})`)() as (
      this: unknown,
      target: unknown,
    ) => boolean;
    const target = {};
    const host = { parentNode: target };
    const text = { parentNode: { host } };
    expect(holds.call({ element: text }, target)).toBe(true);
    expect(holds.call({ parentNode: { parentNode: null } }, target)).toBe(false);
    expect(holds.call(null, target)).toBe(false);
    // A loop is not climbed for ever.
    const loop: Record<string, unknown> = {};
    loop.parentNode = loop;
    expect(holds.call(loop, target)).toBe(false);
  });

  it('knows a hit on the target itself is inside it, without asking', async () => {
    const { tab, session: cdp } = aimingTab({
      crowded: true,
      holds: false,
      replies: { 'DOM.getNodeForLocation': { backendNodeId: 10, frameId: 'top' } },
    });
    const { session, aim } = await aimOn(tab);
    await expect(aim?.('#b')).resolves.toMatchObject({ inside: true });
    const asked = cdp.send.mock.calls as unknown as [string, Record<string, unknown>][];
    expect(
      asked.some(
        ([method, params]) =>
          method === 'Runtime.callFunctionOn' &&
          String(params.functionDeclaration).includes('(target)'),
      ),
    ).toBe(false);
    await session.close();
  });

  it('says when a hit is in a frame still on the empty document it starts with', async () => {
    // What arrives in it has not been read. One a script has written into, or
    // one with an address of its own, is read where the click lands.
    for (const [url, hit, blank] of [
      ['', { nodeName: 'BODY', children: [] }, true],
      ['about:blank', { nodeName: 'BODY', children: [{ nodeType: 3 }] }, true],
      ['', { nodeName: 'HTML', children: [{ nodeType: 1 }, { nodeType: 1 }] }, true],
      ['about:blank', { nodeName: 'BODY', children: [{ nodeType: 1 }] }, false],
      ['about:blank', { nodeName: 'P', children: [] }, false],
      ['https://ads.example/slot', { nodeName: 'BODY', children: [] }, false],
    ] as [string, Record<string, unknown>, boolean][]) {
      const { tab } = aimingTab({
        replies: {
          'DOM.getNodeForLocation': { backendNodeId: 13, frameId: 'child' },
          'DOM.describeNode': (params: Record<string, unknown>) =>
            params.objectId ? { node: { backendNodeId: 10 } } : { node: hit },
          'Page.getFrameTree': {
            frameTree: {
              frame: { id: 'top', url: 'https://shop.example/' },
              childFrames: [{ frame: { id: 'child', url } }],
            },
          },
        },
      });
      const { session, aim } = await aimOn(tab);
      await expect(aim?.('#b'), `${url} ${JSON.stringify(hit)}`).resolves.toMatchObject({
        blank,
        frame: false,
      });
      await session.close();
    }
  });

  it('takes an <object> or <embed> of an image for an image, and any other for a document', async () => {
    for (const [nodeName, attributes, embedded] of [
      ['OBJECT', ['type', 'image/svg+xml', 'data', '/logo.svg'], false],
      ['OBJECT', ['data', '/icons/cart.PNG?v=2'], false],
      ['EMBED', ['src', '/badge.svg'], false],
      ['OBJECT', ['type', 'text/html', 'data', '/panel.html'], true],
      ['EMBED', ['src', '/report.pdf'], true],
    ] as [string, string[], boolean][]) {
      const { tab } = aimingTab({
        replies: {
          'DOM.describeNode': (params: Record<string, unknown>) =>
            params.objectId ? { node: { backendNodeId: 10 } } : { node: { nodeName, attributes } },
        },
      });
      const { session, aim } = await aimOn(tab);
      await expect(aim?.('#b'), JSON.stringify(attributes)).resolves.toMatchObject({ embedded });
      await session.close();
    }
  });

  it('opens a new session after one fails, and keeps one that only ran out of time', async () => {
    const {
      tab,
      session: cdp,
      newCDPSession,
    } = aimingTab({
      replies: { 'DOM.getContentQuads': new Error('Session closed') },
    });
    const { session, aim } = await aimOn(tab);
    await expect(aim?.('#b')).rejects.toThrow('Session closed');
    expect(cdp.detach).toHaveBeenCalled();
    await expect(aim?.('#b')).rejects.toThrow('Session closed');
    expect(newCDPSession).toHaveBeenCalledTimes(4);
    await session.close();
    const { tab: slow, newCDPSession: opened } = aimingTab({
      replies: { 'DOM.getContentQuads': new Promise(() => {}) },
    });
    // A reply that never comes is cut off at the deadline, and the session kept
    // (the accessibility tree's is one of each read's own).
    const { session: next, aim: aimSlow } = await aimOn(slow);
    await expect(aimSlow?.('#b', { timeout: 50 })).rejects.toThrow('did not answer');
    await expect(aimSlow?.('#b', { timeout: 50 })).rejects.toThrow('did not answer');
    expect(opened).toHaveBeenCalledTimes(3);
    await next.close();
  });
});

describe('the hit test reads a real page through its prototypes', () => {
  it("is not turned aside by a form's named controls or a document's named elements", () => {
    document.body.innerHTML =
      '<form id="f"><button id="b"><span id="s">Pay</span></button><input id="i" name="parentElement"></form>';
    const form = document.getElementById('f') as HTMLFormElement;
    const button = document.getElementById('b') as HTMLElement;
    const span = document.getElementById('s') as HTMLElement;
    const input = document.getElementById('i') as HTMLElement;
    // As a browser has them: the form's control for its parentElement, and the
    // document's own elementFromPoint stood in for.
    Object.defineProperty(form, 'parentElement', { configurable: true, value: button });
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => span });
    // The prototypes that answer for them, wherever along the chain that is.
    const owner = (node: object, name: string): object => {
      for (let proto = Object.getPrototypeOf(node); proto; proto = Object.getPrototypeOf(proto)) {
        if (Object.getOwnPropertyDescriptor(proto, name)) {
          return proto;
        }
      }
      throw new Error(`nothing answers for ${name}`);
    };
    const rects = vi
      .spyOn(owner(button, 'getClientRects') as Element, 'getClientRects')
      .mockReturnValue([{ left: 0, top: 0, right: 100, bottom: 40 }] as unknown as DOMRectList);
    const hit = vi
      .spyOn(owner(document, 'elementFromPoint') as Document, 'elementFromPoint')
      .mockReturnValue(input);
    try {
      // The browser's hit is the input outside the button; up from it, the form's
      // real parent -- not the button its control names.
      expect(reachedWherePlaywrightAims(button)).toBe(false);
      hit.mockReturnValue(span);
      expect(reachedWherePlaywrightAims(button)).toBe(true);
    } finally {
      rects.mockRestore();
      hit.mockRestore();
      delete (document as unknown as Record<string, unknown>).elementFromPoint;
      document.body.innerHTML = '';
    }
  });
});

describe('a click followed into frames from other sites', () => {
  type Replies = Record<string, unknown>;
  // A DevTools session that answers from a table, and records what it was sent.
  function fakeSession(replies: Replies) {
    const sent: [string, Record<string, unknown>][] = [];
    return {
      sent,
      send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        sent.push([method, params]);
        const reply = replies[method];
        if (reply instanceof Error) {
          throw reply;
        }
        return typeof reply === 'function' ? reply(params) : (reply ?? {});
      }),
      detach: vi.fn(async () => {}),
    };
  }
  const ax = (...rows: [string, number, string, string, string?][]) => ({
    nodes: rows.map(([nodeId, backendDOMNodeId, role, name, parentId]) => ({
      nodeId,
      backendDOMNodeId,
      role: { value: role },
      name: { value: name },
      ...(parentId ? { parentId } : {}),
    })),
  });
  // The top document, scrolled 300 down, whose click lands on a frame element
  // (13) inside the target (10), its content box at the window's top left.
  function topReplies(overrides: Replies = {}): Replies {
    return {
      'Runtime.evaluate': { result: { objectId: 'o1', subtype: 'node' } },
      'DOM.describeNode': (params: Record<string, unknown>) =>
        params.objectId
          ? { node: { backendNodeId: 10 } }
          : params.depth === 1
            ? { node: { nodeName: 'IFRAME', attributes: ['title', 'Card details'] } }
            : { node: { frameId: 'oop1' } },
      'DOM.getContentQuads': { quads: [[0, 0, 100, 0, 100, 40, 0, 40]] },
      'Page.getLayoutMetrics': {
        cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 300 },
        cssVisualViewport: { pageX: 0, pageY: 300 },
      },
      'Page.getFrameTree': { frameTree: { frame: { id: 'top' } } },
      'DOM.getNodeForLocation': { backendNodeId: 13, frameId: 'top' },
      'Accessibility.getPartialAXTree': ax(
        ['f', 13, 'Iframe', 'Card details', 'n10'],
        ['n10', 10, 'generic', ''],
      ),
      'DOM.getBoxModel': { model: { content: [0, 0, 100, 0, 100, 40, 0, 40] } },
      ...overrides,
    };
  }
  // A frame's own document, scrolled 100 down, with `name` where the click lands.
  function frameReplies(
    id: string,
    nodeName: string,
    name: string,
    overrides: Replies = {},
    // How wide and tall the frame's window is: its box, unless it is scaled.
    size: [number, number] = [100, 40],
  ): Replies {
    return {
      'Page.createIsolatedWorld': { executionContextId: 3 },
      'Runtime.evaluate': { result: { value: size } },
      'Page.getFrameTree': { frameTree: { frame: { id } } },
      'Page.getLayoutMetrics': { cssLayoutViewport: { pageX: 0, pageY: 100 } },
      'DOM.getNodeForLocation': { backendNodeId: 7 },
      'DOM.describeNode': (params: Record<string, unknown>) =>
        params.depth === 1
          ? { node: { nodeName, childNodeCount: 1 } }
          : { node: { frameId: 'oop2' } },
      'Accessibility.getPartialAXTree': ax(['b', 7, 'button', name]),
      'Accessibility.queryAXTree': ax(['t', 8, 'StaticText', name]),
      'DOM.getBoxModel': { model: { content: [10, 10, 60, 10, 60, 30, 10, 30] } },
      ...overrides,
    };
  }

  async function aimThrough(
    top: Replies,
    frames: (Replies | 'same-process' | null)[],
    withFrames = true,
  ) {
    const main = fakeSession(top);
    const frameObjects = frames.map((replies, index) => ({ index, replies }));
    const sessions = new Map<unknown, ReturnType<typeof fakeSession>>();
    const opened: { target: unknown; session: ReturnType<typeof fakeSession> }[] = [];
    const tab: Record<string, unknown> = {
      url: () => 'https://shop.example/',
      close: vi.fn(async () => {}),
      locator: (selector: string) => ({
        evaluate: async () => true,
        count: async () => (selector.includes('count(*) >') ? 0 : 1),
      }),
      context: () => ({
        newCDPSession: async (target: unknown) => {
          if (target === tab) {
            return main;
          }
          const frame = target as { replies: Replies | 'same-process' | null };
          if (frame.replies === 'same-process' || frame.replies === null) {
            throw new Error('This frame does not have a separate CDP session');
          }
          const session = fakeSession(frame.replies);
          if (!sessions.has(target)) {
            sessions.set(target, session);
          }
          opened.push({ target, session });
          return session;
        },
      }),
      ...(withFrames ? { frames: () => [...frameObjects, 'not a frame'] } : {}),
    };
    const browser = {
      contexts: () => [{ newPage: async () => tab }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    const aim = (
      session.page as unknown as {
        aimPointReadOut: (s: string) => Promise<Record<string, unknown> | null>;
      }
    ).aimPointReadOut;
    const result = await aim('#f');
    await session.close();
    return { result, main, sessions, frameObjects, opened };
  }

  it('asks again for a frame that had no session of its own, and for one whose session went', async () => {
    // A frame of the page's own process (blank, not yet given its address)
    // that goes to another site, then to another process again.
    const frame: { replies: Replies | 'same-process' } = { replies: 'same-process' };
    const opened: ReturnType<typeof fakeSession>[] = [];
    let tabFails = 1;
    const main = fakeSession(topReplies());
    const tab: Record<string, unknown> = {
      url: () => 'https://shop.example/',
      close: vi.fn(async () => {}),
      locator: (selector: string) => ({
        evaluate: async () => true,
        count: async () => (selector.includes('count(*) >') ? 0 : 1),
      }),
      context: () => ({
        newCDPSession: async (target: unknown) => {
          if (target === tab) {
            // The tab's own session could not be opened the first time.
            if (tabFails > 0) {
              tabFails -= 1;
              throw new Error('Target page, context or browser has been closed');
            }
            return main;
          }
          if (frame.replies === 'same-process') {
            throw new Error('This frame does not have a separate CDP session');
          }
          const session = fakeSession(frame.replies);
          opened.push(session);
          return session;
        },
      }),
      frames: () => [frame],
    };
    const browser = {
      contexts: () => [{ newPage: async () => tab }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    const aim = (
      session.page as unknown as {
        aimPointReadOut: (s: string) => Promise<Record<string, unknown> | null>;
      }
    ).aimPointReadOut;
    // No session for the tab yet: nothing to say; the next read opens one.
    expect(await aim('#f')).toBeNull();
    // The frame has no session of its own: the caller reads it through.
    expect(await aim('#f')).toMatchObject({ frame: true });
    // It went to another site: followed in.
    const first = frameReplies('oop1', 'BUTTON', 'Pay now');
    frame.replies = first;
    expect(await aim('#f')).toMatchObject({
      frame: false,
      words: expect.stringContaining('Pay now'),
    });
    // ...and to another process: the session kept no longer answers.
    first['Page.getFrameTree'] = new Error('Target closed');
    frame.replies = frameReplies('oop1', 'BUTTON', 'Buy now');
    expect(await aim('#f')).toMatchObject({
      frame: false,
      words: expect.stringContaining('Buy now'),
    });
    // Each frame session it reads in -- not the accessibility tree's, one of
    // each read's own -- is opened once while it answers.
    const reading = () =>
      opened.filter((one) => one.sent.some(([method]) => !method.startsWith('Accessibility.')));
    expect(reading()).toHaveLength(2);
    // One that still answers is kept.
    expect(await aim('#f')).toMatchObject({ words: expect.stringContaining('Buy now') });
    expect(reading()).toHaveLength(2);
    await session.close();
  });

  it('does not wait for a busy frame before the one the click goes into', async () => {
    // An ad frame first whose page never answers its session's first question.
    const { result } = await aimThrough(topReplies(), [
      { 'Page.getFrameTree': () => new Promise(() => {}) },
      frameReplies('oop1', 'BUTTON', 'Pay now'),
    ]);
    expect(result).toMatchObject({ frame: false, words: expect.stringContaining('Pay now') });
  });

  it('reads what the click lands on inside the frame, as the frame scrolls', async () => {
    const { result, main, sessions, frameObjects, opened } = await aimThrough(topReplies(), [
      'same-process',
      frameReplies('oop1', 'BUTTON', 'Pay now'),
    ]);
    expect(result).toEqual({
      words: 'Card details Card details Pay now',
      frame: false,
      embedded: false,
      inside: true,
      blank: false,
      lost: false,
    });
    // The top document's hit test is asked for its own point, scrolled; the
    // frame's for the point inside its box, as the frame is scrolled.
    expect(main.sent).toContainEqual([
      'DOM.getNodeForLocation',
      expect.objectContaining({ x: 50, y: 320, ignorePointerEventsNone: false }),
    ]);
    expect(sessions.get(frameObjects[1])?.sent).toContainEqual([
      'DOM.getNodeForLocation',
      expect.objectContaining({ x: 50, y: 120 }),
    ]);
    // The frame's accessibility tree is read on a session of its own, let go
    // after the read; the frame's other reads go to the one it keeps.
    const kept = sessions.get(frameObjects[1]);
    const own = opened
      .filter(({ target, session }) => target === frameObjects[1] && session !== kept)
      .map(({ session }) => session);
    expect(own).toHaveLength(1);
    expect(own[0].sent.map(([method]) => method)).toEqual([
      'Accessibility.getPartialAXTree',
      'Accessibility.queryAXTree',
    ]);
    expect(own[0].detach).toHaveBeenCalledTimes(1);
    expect(kept?.sent.some(([method]) => method.startsWith('Accessibility.'))).toBe(false);
  });

  it('follows a frame in a frame, and says when what it lands on is embedded', async () => {
    const { result } = await aimThrough(topReplies(), [
      frameReplies('oop1', 'IFRAME', 'Checkout'),
      frameReplies('oop2', 'OBJECT', '', {}, [50, 20]),
    ]);
    expect(result).toMatchObject({
      words: 'Card details Card details Checkout',
      frame: false,
      embedded: true,
    });
  });

  it('maps the point into a frame scaled or zoomed on the page, and not into one scaled unevenly', async () => {
    // The frame's box is 100 by 40; its window twice that: the point in the
    // box's middle is the window's middle.
    const { result, sessions, frameObjects } = await aimThrough(topReplies(), [
      frameReplies('oop1', 'BUTTON', 'Pay now', {}, [200, 80]),
    ]);
    expect(result).toMatchObject({ frame: false, words: expect.stringContaining('Pay now') });
    expect(sessions.get(frameObjects[0])?.sent).toContainEqual([
      'DOM.getNodeForLocation',
      expect.objectContaining({ x: 100, y: 140 }),
    ]);
    // Wider than it is tall, scaled, or with no window to say: left to the caller.
    for (const size of [[300, 80], null] as ([number, number] | null)[]) {
      const { result: uneven } = await aimThrough(topReplies(), [
        frameReplies(
          'oop1',
          'BUTTON',
          'Pay now',
          size ? {} : { 'Runtime.evaluate': { result: { value: 'x' } } },
          size ?? [100, 40],
        ),
      ]);
      expect(uneven, JSON.stringify(size)).toMatchObject({ frame: true });
    }
  });

  it('says when the click lands in a frame, in a frame from another site, that shows nothing yet', async () => {
    const { result } = await aimThrough(topReplies(), [
      frameReplies('oop1', 'BODY', '', {
        'DOM.getNodeForLocation': { backendNodeId: 7, frameId: 'late' },
        'DOM.describeNode': (params: Record<string, unknown>) =>
          params.depth === 1 ? { node: { nodeName: 'BODY', children: [] } } : { node: {} },
        'Page.getFrameTree': {
          frameTree: { frame: { id: 'oop1' }, childFrames: [{ frame: { id: 'late', url: '' } }] },
        },
      }),
    ]);
    expect(result).toMatchObject({ blank: true, frame: false });
  });

  it('leaves to the caller a frame it cannot follow the click into', async () => {
    const cases: [Replies, (Replies | 'same-process' | null)[], boolean?][] = [
      // A frame element turned on the page: no box to map a point into.
      [
        topReplies({ 'DOM.getBoxModel': { model: { content: [0, 0, 100, 10, 90, 50, -10, 40] } } }),
        [frameReplies('oop1', 'BUTTON', 'Pay')],
      ],
      // One the protocol names no frame for.
      [
        topReplies({
          'DOM.describeNode': (p: Record<string, unknown>) =>
            p.objectId ? { node: { backendNodeId: 10 } } : { node: { nodeName: 'IFRAME' } },
        }),
        [frameReplies('oop1', 'BUTTON', 'Pay')],
      ],
      // One with no session of its own, or none found for it.
      [topReplies(), ['same-process']],
      [topReplies(), [frameReplies('elsewhere', 'BUTTON', 'Pay')]],
      [topReplies(), [{ 'Page.getFrameTree': {} }]],
      [topReplies(), [frameReplies('oop1', 'BUTTON', 'Pay')], false],
      // Nothing where the click lands inside it, or a read that fails there.
      [topReplies(), [frameReplies('oop1', 'BUTTON', 'Pay', { 'DOM.getNodeForLocation': {} })]],
      [
        topReplies(),
        [
          frameReplies('oop1', 'BUTTON', 'Pay', {
            'DOM.describeNode': new Error('gone'),
          }),
        ],
      ],
    ];
    for (const [top, frames, withFrames] of cases) {
      const { result } = await aimThrough(top, frames, withFrames ?? true);
      expect(result, JSON.stringify(frames)).toMatchObject({ frame: true, embedded: false });
    }
  });

  it('says the click was lost when it was followed into a frame and no further', async () => {
    // Frames in frames past as deep as it goes.
    const { result: deep } = await aimThrough(topReplies(), [
      frameReplies('oop1', 'IFRAME', 'a', {
        'Page.getFrameTree': { frameTree: { frame: { id: 'oop1' } } },
        'DOM.describeNode': (p: Record<string, unknown>) =>
          p.depth === 1 ? { node: { nodeName: 'IFRAME' } } : { node: { frameId: 'oop1' } },
      }),
    ]);
    expect(deep).toMatchObject({ frame: false, lost: true, words: expect.stringContaining('a') });
    // A frame in the frame turned on its page, or one whose read fails there.
    for (const inner of [
      { 'DOM.getBoxModel': { model: { content: [0, 0, 100, 10, 90, 50, -10, 40] } } },
      { 'DOM.getBoxModel': new Error('gone') },
    ]) {
      const { result } = await aimThrough(topReplies(), [
        frameReplies('oop1', 'IFRAME', 'Widget', {
          'DOM.describeNode': (p: Record<string, unknown>) =>
            p.depth === 1 ? { node: { nodeName: 'IFRAME' } } : { node: { frameId: 'oop2' } },
          ...inner,
        }),
      ]);
      expect(result, JSON.stringify(inner)).toMatchObject({ frame: false, lost: true });
    }
  });

  it('reads where the window is scrolled to from the visual viewport, or the layout one', async () => {
    for (const [metrics, y] of [
      [{ cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 40 } }, 60],
      [{ cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } }, 20],
    ] as [Replies, number][]) {
      const top = topReplies({
        'Page.getLayoutMetrics': metrics,
        'DOM.describeNode': (p: Record<string, unknown>) =>
          p.objectId ? { node: { backendNodeId: 10 } } : { node: { nodeName: 'BUTTON' } },
      });
      const { main } = await aimThrough(top, []);
      expect(main.sent).toContainEqual([
        'DOM.getNodeForLocation',
        expect.objectContaining({ x: 50, y }),
      ]);
    }
  });
});

describe('what the browser reads out of an element', () => {
  const ax = (...rows: [string, number, string, string, string?, boolean?][]) => ({
    nodes: rows.map(([nodeId, backendDOMNodeId, role, name, parentId, ignored]) => ({
      nodeId,
      backendDOMNodeId,
      role: { value: role },
      name: { value: name },
      ...(parentId ? { parentId } : {}),
      ...(ignored ? { ignored } : {}),
    })),
  });

  it('is the text, images and controls under it -- not its own made-up name -- and its frames', () => {
    const tree = ax(
      ['r', 10, 'button', 'Submit'],
      ['t1', 11, 'StaticText', 'Pay', 'r'],
      ['b1', 12, 'InlineTextBox', 'Pay', 't1'],
      ['t2', 13, 'StaticText', '$49.00', 'r', true],
      ['i', 14, 'image', 'card logo', 'r'],
      ['c', 15, 'link', 'Terms', 'r'],
      ['g', 16, 'generic', 'a wrapper', 'r'],
      ['f', 17, 'Iframe', 'Payment', 'r'],
    );
    // Whatever has a name says it -- a box an aria-label names, a frame's title --
    // but not the pieces a text is laid out in, which say it again.
    expect(wordsHeldBy(tree, 10)).toEqual({
      words: 'Pay $49.00 card logo Terms a wrapper Payment',
      text: 'Pay $49.00',
      names: 'card logo Terms a wrapper Payment',
      frames: 1,
    });
    expect(wordsHeldBy({}, 10)).toEqual({ words: '', text: '', names: '', frames: 0 });
    const long = `${'a '.repeat(400)}Pay now`;
    const read = wordsHeldBy(ax(['r', 1, 'generic', ''], ['t', 2, 'StaticText', long, 'r']), 1);
    expect(read.words).toContain('Pay now');
    expect(read.words.length).toBeLessThan(700);
  });

  // A tab whose element is handed over, and a session that answers from a table.
  function readingTab(options: { placed?: boolean; replies?: Record<string, unknown> }) {
    const sent: [string, Record<string, unknown>][] = [];
    const replies: Record<string, unknown> = {
      'Runtime.evaluate': { result: { objectId: 'o1', subtype: 'node' } },
      'DOM.describeNode': { node: { backendNodeId: 10 } },
      'Accessibility.queryAXTree': ax(
        ['r', 10, 'generic', ''],
        ['t', 11, 'StaticText', 'Pay $19.99', 'r'],
      ),
      ...options.replies,
    };
    const session = {
      send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        sent.push([method, params]);
        const reply = replies[method];
        return typeof reply === 'function'
          ? (reply as (p: Record<string, unknown>) => unknown)(params)
          : (reply ?? {});
      }),
      detach: vi.fn(async () => {}),
    };
    const selectText = vi.fn(async () => {});
    const locate = vi.fn((selector: string) => ({
      evaluate: async () => options.placed ?? true,
      count: async () => (selector.includes('count(*) >') ? 0 : 1),
      selectText,
    }));
    const tab = {
      url: () => 'https://shop.example/',
      close: vi.fn(async () => {}),
      locator: locate,
      context: () => ({ newCDPSession: async () => session }),
    };
    return { tab, sent, selectText, locate };
  }

  async function sessionOn(tab: unknown) {
    const browser = {
      contexts: () => [{ newPage: async () => tab }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    return {
      session,
      driven: session.page as unknown as {
        readOutOf: (s: string, o?: { timeout?: number }) => Promise<unknown>;
        focusToFill: (s: string, o?: { timeout?: number }) => Promise<void>;
      },
    };
  }

  it('reads it out over the protocol, closed shadow trees and all, each read in its own object group', async () => {
    const { tab, sent } = readingTab({});
    const { session, driven } = await sessionOn(tab);
    await expect(driven.readOutOf('#pay', { timeout: 500 })).resolves.toEqual({
      words: 'Pay $19.99',
      frames: 0,
      drawnFrames: 0,
      // Nowhere to ask what is drawn: not all of it is known.
      whole: false,
      sealed: false,
    });
    await driven.readOutOf('#pay');
    const groups = sent
      .filter(([method]) => method === 'Runtime.evaluate')
      .map(([, params]) => params.objectGroup);
    const released = sent
      .filter(([method]) => method === 'Runtime.releaseObjectGroup')
      .map(([, params]) => params.objectGroup);
    expect(groups).toHaveLength(2);
    expect(new Set(groups).size).toBe(2);
    expect(released).toEqual(groups);
    await session.close();
    // An element it is not handed has no read-out.
    const { tab: elsewhere } = readingTab({ placed: false });
    const { session: next, driven: other } = await sessionOn(elsewhere);
    await expect(other.readOutOf('#pay')).resolves.toBeNull();
    await next.close();
  });

  it("takes the drawing's spacing for the text the read-out sets apart, beside the names in it", async () => {
    const { tab } = readingTab({
      replies: {
        'Page.getFrameTree': { frameTree: { frame: { id: 'top' } } },
        'Page.createIsolatedWorld': { executionContextId: 7 },
        'DOM.resolveNode': { object: { objectId: 'n1' } },
        'Accessibility.queryAXTree': ax(
          ['r', 10, 'link', 'Payment methods we accept'],
          ['h', 11, 'heading', 'Payment methods we accept', 'r'],
          ['t1', 12, 'StaticText', 'Pay', 'h'],
          ['t2', 13, 'StaticText', 'ment methods we accept', 'h'],
        ),
        'Runtime.callFunctionOn': {
          result: {
            value: {
              text: 'Payment methods we accept',
              spaced: 'Payment methods we accept',
              said: '',
              frames: 0,
              whole: true,
            },
          },
        },
      },
    });
    const { session, driven } = await sessionOn(tab);
    const read = (await driven.readOutOf('#card', { timeout: 500 })) as { words: string };
    expect(read.words).toBe('Payment methods we accept Payment methods we accept');
    expect(read.words).not.toContain('Pay ment');
    await session.close();
  });

  it('measures what an element shows out of reach of the page, as far as a limit', async () => {
    const world = {
      'Page.getFrameTree': { frameTree: { frame: { id: 'top' } } },
      'Page.createIsolatedWorld': { executionContextId: 7 },
      'DOM.resolveNode': { object: { objectId: 'n1' } },
    };
    const { tab, sent } = readingTab({
      replies: {
        ...world,
        'Runtime.callFunctionOn': { result: { value: { length: 14, text: 'Buy now $49.00' } } },
      },
    });
    const { session, driven } = await sessionOn(tab);
    const measured = driven as unknown as {
      shownTextOf: (s: string, o?: { timeout?: number; limit?: number }) => Promise<unknown>;
    };
    await expect(measured.shownTextOf('#box', { timeout: 500, limit: 80 })).resolves.toEqual({
      length: 14,
      text: 'Buy now $49.00',
    });
    const declared = sent
      .filter(([method]) => method === 'Runtime.callFunctionOn')
      .map(([, params]) => String(params.functionDeclaration));
    expect(declared[0]).toContain('function shownTextIn');
    expect(declared[0]).toContain('(this, 80, closedSlots)');
    // A limit is a whole number in bounds; none is 80.
    await measured.shownTextOf('#box', { limit: 1e9 });
    await measured.shownTextOf('#box');
    const limits = sent
      .filter(([method]) => method === 'Runtime.callFunctionOn')
      .map(
        ([, params]) =>
          /\(this, (\d+), closedSlots\)/.exec(String(params.functionDeclaration))?.[1],
      );
    expect(limits).toEqual(['80', '10000', '80']);
    await session.close();
    // No number for an answer, or no element handed over: it cannot be told.
    for (const value of ['long', { length: 14 }]) {
      const { tab: odd } = readingTab({
        replies: { ...world, 'Runtime.callFunctionOn': { result: { value } } },
      });
      const { session: oddSession, driven: oddDriven } = await sessionOn(odd);
      await expect(
        (oddDriven as unknown as { shownTextOf: (s: string) => Promise<unknown> }).shownTextOf(
          '#box',
        ),
      ).resolves.toBeNull();
      await oddSession.close();
    }
    const { tab: elsewhere } = readingTab({ placed: false });
    const { session: last, driven: other } = await sessionOn(elsewhere);
    await expect(
      (other as unknown as { shownTextOf: (s: string) => Promise<unknown> }).shownTextOf('#box'),
    ).resolves.toBeNull();
    await last.close();
  });

  it('measures again through the slots of closed trees, where it shows more than the limit', async () => {
    // A row slotted into a closed card of a set height: by a script's climb it
    // shows all its description; through the card's slot, which the browser's
    // protocol names, only what the card lets show.
    const long = { length: 144, text: 'Buy now $49.00 Details Ships in 2 days' };
    const short = { length: 21, text: 'Buy now $49.00 Details' };
    const measuring = (
      second: unknown,
      paths: Record<string, string[]> = {
        self: ['self', 'row', 'card', 'body'],
        node77: ['node77', 'clip', 'card', 'body'],
      },
      world: unknown = { executionContextId: 7 },
      extra: Record<string, unknown> = {},
    ) =>
      readingTab({
        replies: {
          'Page.getFrameTree': { frameTree: { frame: { id: 'top' } } },
          'Page.createIsolatedWorld': world,
          'DOM.resolveNode': (params: Record<string, unknown>) => ({
            object: {
              objectId:
                params.backendNodeId === 10 ? 'self' : `node${String(params.backendNodeId)}`,
            },
          }),
          'Runtime.callFunctionOn': (params: Record<string, unknown>) =>
            String(params.functionDeclaration).includes('path.push')
              ? { result: { objectId: `path:${String(params.objectId)}` } }
              : (params.arguments as unknown[] | undefined)?.length
                ? second
                : { result: { value: long } },
          'Runtime.getProperties': (params: Record<string, unknown>) => ({
            result: (paths[String(params.objectId).slice(5)] ?? []).map((objectId, at) => ({
              name: String(at),
              value: { objectId },
            })),
          }),
          'DOM.describeNode': (params: Record<string, unknown>) => ({
            node:
              params.objectId === 'o1'
                ? { backendNodeId: 10 }
                : ({
                    self: { backendNodeId: 10 },
                    row: { backendNodeId: 11, assignedSlot: { backendNodeId: 77 } },
                    card: { backendNodeId: 12, shadowRoots: [{ shadowRootType: 'closed' }] },
                    node77: { backendNodeId: 77 },
                    clip: { backendNodeId: 55 },
                  }[String(params.objectId)] ?? {}),
          }),
          ...extra,
        },
      });
    const shownOf = async (tab: unknown) => {
      const { session, driven } = await sessionOn(tab);
      try {
        return await (
          driven as unknown as {
            shownTextOf: (s: string, o?: { timeout?: number; limit?: number }) => Promise<unknown>;
          }
        ).shownTextOf('#row', { timeout: 500, limit: 80 });
      } finally {
        await session.close();
      }
    };
    const { tab, sent } = measuring({ result: { value: short } });
    await expect(shownOf(tab)).resolves.toEqual(short);
    // The second measure is handed the row and the card's slot, and no tree is
    // ever asked its mode.
    const measures = sent.filter(
      ([method, params]) =>
        method === 'Runtime.callFunctionOn' &&
        String(params.functionDeclaration).includes('function shownTextIn'),
    );
    expect(measures).toHaveLength(2);
    expect(measures[1][1].arguments).toEqual([{ objectId: 'node11' }, { objectId: 'node77' }]);
    expect(
      sent.some(
        ([method, params]) =>
          method === 'Runtime.callFunctionOn' &&
          /\.mode\b/.test(String(params.functionDeclaration)),
      ),
    ).toBe(false);
    // From the card's slot on, only what is inside the card is asked about
    // again: past its host the way is the one described (beyond the batch
    // asked about at once).
    const way = Array.from({ length: 70 }, (_, at) => `up${at}`);
    const { tab: deep, sent: sentDeep } = measuring(
      { result: { value: short } },
      {
        self: ['self', 'row', 'card', ...way, 'body'],
        node77: ['node77', 'clip', 'card', ...way, 'body'],
      },
    );
    await expect(shownOf(deep)).resolves.toEqual(short);
    const described = (objectId: string) =>
      sentDeep.filter(
        ([method, params]) => method === 'DOM.describeNode' && params.objectId === objectId,
      ).length;
    expect(described('clip')).toBe(1);
    expect(described('up69')).toBe(1);
    expect(described('body')).toBe(1);
    // A climb from the slot that never meets the host is described whole.
    const { tab: hostless } = measuring(
      { result: { value: short } },
      { self: ['self', 'row', 'card', 'body'], node77: ['node77', 'clip', 'body'] },
    );
    await expect(shownOf(hostless)).resolves.toEqual(short);
    // Boxes one check measures together, named by what is inside them: one
    // climb for them all, from that element -- and for that check alone.
    const { tab: together, sent: sentTogether } = measuring({ result: { value: short } });
    const { session: both, driven: bothDriven } = await sessionOn(together);
    const measuredBoth = bothDriven as unknown as {
      shownTextOf: (
        s: string,
        o?: { timeout?: number; limit?: number; from?: string; together?: object },
      ) => Promise<unknown>;
    };
    const check = {};
    await expect(
      Promise.all([
        measuredBoth.shownTextOf('#row', {
          timeout: 500,
          limit: 80,
          from: '#details',
          together: check,
        }),
        measuredBoth.shownTextOf('#card', {
          timeout: 500,
          limit: 80,
          from: '#details',
          together: check,
        }),
      ]),
    ).resolves.toEqual([short, short]);
    await expect(
      measuredBoth.shownTextOf('#card', {
        timeout: 500,
        limit: 80,
        from: '#details',
        together: check,
      }),
    ).resolves.toEqual(short);
    const climbsSoFar = () =>
      sentTogether.filter(
        ([method, params]) =>
          method === 'Runtime.callFunctionOn' &&
          String(params.functionDeclaration).includes('path.push'),
      ).length;
    expect(climbsSoFar()).toBe(2);
    // Another check -- the next one, or one on another page, whose elements
    // the browser may number the same -- climbs anew; so does a measure of no
    // check, and one handed what is no object.
    await expect(
      measuredBoth.shownTextOf('#row', { timeout: 500, limit: 80, from: '#details', together: {} }),
    ).resolves.toEqual(short);
    expect(climbsSoFar()).toBe(4);
    await expect(
      measuredBoth.shownTextOf('#row', { timeout: 500, limit: 80, from: '#details' }),
    ).resolves.toEqual(short);
    expect(climbsSoFar()).toBe(6);
    await expect(
      measuredBoth.shownTextOf('#row', {
        timeout: 500,
        limit: 80,
        from: '#details',
        together: 'check' as unknown as object,
      }),
    ).resolves.toEqual(short);
    expect(climbsSoFar()).toBe(8);
    await expect(
      measuredBoth.shownTextOf('#row', {
        timeout: 500,
        limit: 80,
        from: '#details',
        together: null as unknown as object,
      }),
    ).resolves.toEqual(short);
    expect(climbsSoFar()).toBe(10);
    await both.close();
    // A climb that does not answer in half the time leaves the first measure.
    const { tab: stuck } = measuring({ result: { value: short } }, undefined, undefined, {
      'Runtime.getProperties': () => new Promise(() => {}),
    });
    await expect(shownOf(stuck)).resolves.toEqual(long);
    // A second measure that cannot be had leaves the first; so does a climb
    // that meets no closed tree, and one that cannot be had.
    const { tab: failing } = measuring({ result: { value: 'long' } });
    await expect(shownOf(failing)).resolves.toEqual(long);
    const { tab: open } = measuring(
      { result: { value: short } },
      { self: ['self', 'row', 'card', 'body'].filter((at) => at !== 'card') },
    );
    await expect(shownOf(open)).resolves.toEqual(long);
    const { tab: nowhere } = measuring({ result: { value: short } }, {});
    await expect(shownOf(nowhere)).resolves.toEqual(long);
    // No world of the check's own to climb in, once measured: the first stands.
    let worlds = 0;
    const { tab: worldless } = measuring({ result: { value: short } }, undefined, () => {
      worlds += 1;
      return worlds > 1 ? {} : { executionContextId: 7 };
    });
    await expect(shownOf(worldless)).resolves.toEqual(long);
  });

  it('reads around every slot of a closed tree the climb passes, never asking a tree its mode', async () => {
    type Described = {
      backendNodeId?: number;
      assignedSlot?: { backendNodeId: number };
      shadowRoots?: { shadowRootType: string }[];
    };
    // A page by the climb from each element one starts at, and what the
    // browser says of each element on it; a slot's words by its node.
    const climbing = (
      paths: Record<string, string[]>,
      nodes: Record<string, Described>,
      words: (objectId: string) => unknown = () => ({ result: { value: 'Buy now $49.00' } }),
      replies: Record<string, unknown> = {},
    ) =>
      readingTab({
        replies: {
          'Page.getFrameTree': { frameTree: { frame: { id: 'top' } } },
          'Page.createIsolatedWorld': { executionContextId: 7 },
          'DOM.resolveNode': (params: Record<string, unknown>) => ({
            object: {
              objectId:
                params.backendNodeId === 10 ? 'self' : `node${String(params.backendNodeId)}`,
            },
          }),
          'Runtime.callFunctionOn': (params: Record<string, unknown>) =>
            String(params.functionDeclaration).includes('path.push')
              ? { result: { objectId: `path:${String(params.objectId)}` } }
              : words(String(params.objectId)),
          'Runtime.getProperties': (params: Record<string, unknown>) => ({
            result: [
              ...(paths[String(params.objectId).slice(5)] ?? []).map((objectId, at) => ({
                name: String(at),
                value: { objectId },
              })),
              { name: 'length', value: {} },
            ],
          }),
          'DOM.describeNode': (params: Record<string, unknown>) => ({
            node:
              params.objectId === 'o1'
                ? { backendNodeId: 10 }
                : (nodes[String(params.objectId)] ?? {}),
          }),
          ...replies,
        },
      });
    const read = async (tab: unknown) => {
      const { session, driven } = await sessionOn(tab);
      try {
        return await (
          driven as unknown as {
            closedSlotWordsOf: (s: string, o?: { timeout?: number }) => Promise<unknown>;
          }
        ).closedSlotWordsOf('#d', { timeout: 500 });
      } finally {
        await session.close();
      }
    };
    const closed = [{ shadowRootType: 'closed' }];
    // A button in an open component, that component slotted into a closed box:
    // the open slot is climbed into, the closed one read from.
    const { tab, sent } = climbing(
      {
        self: ['self', 'oslot', 'row', 'fancy', 'pay', 'body'],
        node77: ['node77', 'paydiv', 'pay', 'body'],
      },
      {
        self: { backendNodeId: 10, assignedSlot: { backendNodeId: 50 } },
        oslot: { backendNodeId: 50 },
        row: { backendNodeId: 51 },
        fancy: { backendNodeId: 52, assignedSlot: { backendNodeId: 77 } },
        pay: { backendNodeId: 53, shadowRoots: closed },
        body: { backendNodeId: 54 },
        node77: { backendNodeId: 77 },
        paydiv: { backendNodeId: 55 },
      },
    );
    await expect(read(tab)).resolves.toBe('Buy now $49.00');
    const declared = sent
      .filter(([method]) => method === 'Runtime.callFunctionOn')
      .map(([, params]) => String(params.functionDeclaration));
    expect(declared.some((text) => text.includes('wordsAroundAcrossShadowTrees'))).toBe(true);
    // Asking a tree of the browser's own its mode brings the tab down.
    expect(declared.some((text) => /\.mode\b/.test(text))).toBe(false);
    // A closed component slotted into a closed box: each slot is read from.
    const { tab: nested } = climbing(
      {
        self: ['self', 'mid', 'pay', 'body'],
        node77: ['node77', 'row', 'mid', 'pay', 'body'],
        node78: ['node78', 'paydiv', 'pay', 'body'],
      },
      {
        self: { backendNodeId: 10, assignedSlot: { backendNodeId: 77 } },
        mid: { backendNodeId: 11, assignedSlot: { backendNodeId: 78 }, shadowRoots: closed },
        pay: { backendNodeId: 12, shadowRoots: closed },
        node77: { backendNodeId: 77 },
        node78: { backendNodeId: 78 },
      },
      (objectId) => ({ result: { value: objectId === 'node77' ? '' : 'Buy now $49.00' } }),
    );
    await expect(read(nested)).resolves.toBe('Buy now $49.00');
    // A <details>'s summary, slotted into a tree of the browser's own: nothing
    // read there, and nothing asked of it.
    const ua = climbing(
      { self: ['self', 'details', 'body'] },
      {
        self: { backendNodeId: 10, assignedSlot: { backendNodeId: 90 } },
        details: { backendNodeId: 11, shadowRoots: [{ shadowRootType: 'user-agent' }] },
      },
    );
    await expect(read(ua.tab)).resolves.toBe('');
    expect(
      ua.sent.some(
        ([method, params]) =>
          method === 'Runtime.callFunctionOn' &&
          String(params.functionDeclaration).includes('wordsAroundAcrossShadowTrees'),
      ),
    ).toBe(false);
    // Slotted nowhere: nothing around to read.
    const { tab: plain } = climbing({ self: ['self', 'body'] }, { self: { backendNodeId: 10 } });
    await expect(read(plain)).resolves.toBe('');
    // What cannot be told: a host of no kind the browser names, a slotted
    // element the climb ends at, a climb past as far as it goes or of nothing,
    // a read of the slot's tree that gives no words or fails, a slot or an
    // element that cannot be had, a climb that cannot be had, a protocol that
    // fails -- and more closed trees on the way than are read.
    const slotted = { self: { backendNodeId: 10, assignedSlot: { backendNodeId: 77 } } };
    const pay = { pay: { backendNodeId: 12, shadowRoots: closed } };
    const deep = Array.from({ length: 1_025 }, (_, at) => `n${at}`);
    const many = Object.fromEntries(
      Array.from({ length: 6 }, (_, at) => [
        at === 0 ? 'self' : `node${99 + at}`,
        [at === 0 ? 'self' : `node${99 + at}`, `h${at}`],
      ]),
    );
    const manyNodes: Record<string, Described> = Object.fromEntries(
      Array.from({ length: 6 }, (_, at) => [
        [
          at === 0 ? 'self' : `node${99 + at}`,
          { backendNodeId: at === 0 ? 10 : 99 + at, assignedSlot: { backendNodeId: 100 + at } },
        ],
        [`h${at}`, { backendNodeId: 200 + at, shadowRoots: closed }],
      ]).flat(),
    );
    for (const odd of [
      climbing({ self: ['self', 'host'] }, { ...slotted, host: { backendNodeId: 12 } }),
      climbing({ self: ['self'] }, slotted),
      climbing({ self: deep }, {}),
      climbing({ self: [] }, {}),
      climbing({ self: ['self', 'pay'] }, { ...slotted, ...pay }, () => ({ result: {} })),
      climbing({ self: ['self', 'pay'] }, { ...slotted, ...pay }, () => ({
        result: { value: 'x' },
        exceptionDetails: { text: 'Uncaught' },
      })),
      climbing({ self: ['self', 'pay'] }, { ...slotted, ...pay }, undefined, {
        'DOM.resolveNode': (params: Record<string, unknown>) => ({
          object: params.backendNodeId === 10 ? { objectId: 'self' } : {},
        }),
      }),
      climbing({ self: ['self'] }, {}, undefined, { 'DOM.resolveNode': { object: {} } }),
      climbing({ self: ['self'] }, {}, undefined, { 'Runtime.callFunctionOn': { result: {} } }),
      climbing({ self: ['self'] }, {}, undefined, {
        'Runtime.getProperties': () => {
          throw new Error('Target closed');
        },
      }),
    ]) {
      await expect(read(odd.tab)).resolves.toBeNull();
    }
    // What was read before the rest could not be is what is said: more closed
    // trees on the way than are read, or a climb on from a slot that fails.
    await expect(read(climbing(many, manyNodes).tab)).resolves.toBe(
      Array.from({ length: 4 }, () => 'Buy now $49.00').join(' '),
    );
    await expect(
      read(
        climbing({ self: ['self', 'pay'] }, { ...slotted, ...pay }, undefined, {
          'Runtime.getProperties': (params: Record<string, unknown>) => {
            if (params.objectId === 'path:node77') {
              throw new Error('Target closed');
            }
            return {
              result: [
                { name: '0', value: { objectId: 'self' } },
                { name: '1', value: { objectId: 'pay' } },
                { name: 'length', value: {} },
              ],
            };
          },
        }).tab,
      ),
    ).resolves.toBe('Buy now $49.00');
    // A long climb is asked about a batch at a time, all of it.
    const long = Array.from({ length: 150 }, (_, at) => `e${at}`);
    const { tab: tall, sent: tallSent } = climbing({ self: ['self', ...long] }, {});
    await expect(read(tall)).resolves.toBe('');
    expect(
      tallSent.filter(
        ([method, params]) => method === 'DOM.describeNode' && params.objectId !== 'o1',
      ),
    ).toHaveLength(151);
    // As many closed trees as are read, each read.
    const four = { ...Object.fromEntries(Object.entries(many).slice(0, 4)), node103: ['node103'] };
    const fourNodes = { ...manyNodes, node103: { backendNodeId: 103 } };
    await expect(read(climbing(four, fourNodes).tab)).resolves.toBe(
      Array.from({ length: 4 }, () => 'Buy now $49.00').join(' '),
    );
    // No world of the check's own to read in: it cannot be told.
    await expect(
      read(climbing({ self: ['self'] }, {}, undefined, { 'Page.createIsolatedWorld': {} }).tab),
    ).resolves.toBeNull();
    // An element not handed over -- in a frame -- is one no slot read reaches.
    const { tab: elsewhere } = readingTab({ placed: false });
    await expect(read(elsewhere)).resolves.toBe('');
  });

  it('focuses a field where fill would, with its text selected', async () => {
    const { tab, selectText, locate } = readingTab({});
    const { session, driven } = await sessionOn(tab);
    await driven.focusToFill('label[for=q]', { timeout: 700 });
    expect(locate).toHaveBeenCalledWith('label[for=q]');
    expect(selectText).toHaveBeenCalledWith({ timeout: 700 });
    await session.close();
  });
});

describe("what is drawn under a node, read in the check's own world", () => {
  const textNode = (backendNodeId: number) => ({ nodeType: 3, nodeName: '#text', backendNodeId });

  it('finds the closed shadow trees no script can open, and counts the nodes', () => {
    const tree = {
      nodeType: 1,
      nodeName: 'DIV',
      backendNodeId: 10,
      shadowRoots: [
        {
          nodeType: 11,
          nodeName: '#document-fragment',
          backendNodeId: 50,
          shadowRootType: 'closed',
          children: [textNode(52)],
        },
      ],
      children: [
        {
          nodeType: 1,
          nodeName: 'X-OPEN',
          backendNodeId: 20,
          shadowRoots: [
            {
              nodeType: 11,
              backendNodeId: 51,
              shadowRootType: 'open',
              children: [
                {
                  nodeType: 1,
                  nodeName: 'X-IN',
                  backendNodeId: 30,
                  shadowRoots: [{ nodeType: 11, backendNodeId: 53, shadowRootType: 'closed' }],
                },
              ],
            },
          ],
        },
        {
          nodeType: 1,
          nodeName: 'IFRAME',
          backendNodeId: 40,
          frameId: 'child',
          contentDocument: {
            nodeType: 9,
            backendNodeId: 41,
            children: [
              {
                nodeType: 1,
                nodeName: 'X-F',
                backendNodeId: 42,
                shadowRoots: [{ nodeType: 11, backendNodeId: 54, shadowRootType: 'closed' }],
              },
            ],
          },
        },
        null,
      ],
    };
    // A frame of the page's own apart, with its document's root and closed
    // trees, its nodes not counted with the rest.
    const found = closedRootsUnder(tree as never);
    expect([...found.closed].sort()).toEqual([50, 53]);
    expect(found.frames).toEqual([{ frameId: 'child', root: 42, closed: [54] }]);
    expect(found.nodes).toBe(8);
    expect(closedRootsUnder(undefined)).toEqual({ closed: [], nodes: 0, frames: [] });
    // Never counted past as many as are read.
    const wide = {
      nodeType: 1,
      backendNodeId: 1,
      children: Array.from({ length: 25_000 }, (_, n) => textNode(n + 2)),
    };
    expect(closedRootsUnder(wide as never).nodes).toBe(20_001);
  });

  // A tab whose element (10) is handed over, whose read-out has "Details", and
  // whose DOM is described with closed shadow trees (50 on) and an open one.
  function tabWith(
    options: {
      drawn?: unknown;
      ax?: 'hangs' | 'crowded';
      // The runs of text the read-out has, in place of "Details".
      axTexts?: string[];
      axFrames?: boolean;
      world?: 'noFrame' | 'noWorld' | 'worldFails' | 'callFails' | 'exception';
      unresolved?: number[];
      closedRoots?: number;
      nodes?: number;
      // A frame of the page's own under the element, described with its document.
      frameDocument?: { frameId: string; root: number };
    } = {},
  ) {
    const sent: [string, Record<string, unknown>][] = [];
    const described = {
      nodeType: 1,
      nodeName: 'DIV',
      backendNodeId: 10,
      shadowRoots: [
        ...Array.from({ length: options.closedRoots ?? 1 }, (_, n) => ({
          nodeType: 11,
          backendNodeId: 50 + n,
          shadowRootType: 'closed',
        })),
        { nodeType: 11, backendNodeId: 9, shadowRootType: 'open' },
      ],
      children: [
        ...Array.from({ length: options.nodes ?? 0 }, (_, n) => textNode(1_000 + n)),
        ...(options.frameDocument
          ? [
              {
                nodeType: 1,
                nodeName: 'IFRAME',
                backendNodeId: 76,
                frameId: options.frameDocument.frameId,
                contentDocument: {
                  nodeType: 9,
                  children: [
                    { nodeType: 10 },
                    { nodeType: 1, nodeName: 'HTML', backendNodeId: options.frameDocument.root },
                  ],
                },
              },
            ]
          : []),
      ],
    };
    const session = {
      send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        sent.push([method, params]);
        switch (method) {
          case 'Runtime.evaluate':
            return { result: { objectId: 'o1', subtype: 'node' } };
          case 'DOM.describeNode':
            return params.objectId ? { node: { backendNodeId: 10 } } : { node: described };
          case 'Accessibility.queryAXTree':
            if (options.ax === 'hangs') {
              return new Promise(() => {});
            }
            return {
              nodes: [
                { nodeId: 'r', backendDOMNodeId: 10, role: { value: 'generic' } },
                ...(options.axTexts ?? ['Details']).map((value, n) => ({
                  nodeId: `t${n}`,
                  backendDOMNodeId: 4 + n * 100,
                  role: { value: 'StaticText' },
                  name: { value },
                })),
                ...(options.axFrames
                  ? [{ nodeId: 'f', backendDOMNodeId: 5, role: { value: 'Iframe' } }]
                  : []),
              ],
            };
          case 'Page.getFrameTree':
            return options.world === 'noFrame' ? {} : { frameTree: { frame: { id: 'main' } } };
          case 'Page.createIsolatedWorld':
            if (options.world === 'worldFails') {
              throw new Error('No frame for given id found');
            }
            return options.world === 'noWorld'
              ? {}
              : { executionContextId: params.frameId === 'main' ? 7 : 8 };
          case 'DOM.resolveNode':
            if (options.unresolved?.includes(params.backendNodeId as number)) {
              throw new Error('No node with given id found');
            }
            return { object: { objectId: `node-${String(params.backendNodeId)}` } };
          case 'Runtime.callFunctionOn':
            if (options.world === 'callFails') {
              throw new Error('Execution context was destroyed.');
            }
            if (options.world === 'exception') {
              return { exceptionDetails: { text: 'TypeError' } };
            }
            return {
              result: {
                value:
                  typeof options.drawn === 'function'
                    ? (options.drawn as (objectId: string) => unknown)(String(params.objectId))
                    : 'drawn' in options
                      ? options.drawn
                      : {
                          text: 'Details\nPay now $49.00',
                          said: 'Card logo',
                          frames: 0,
                          whole: true,
                        },
              },
            };
          default:
            return {};
        }
      }),
      detach: vi.fn(async () => {}),
    };
    const tab = {
      url: () => 'https://shop.example/',
      close: vi.fn(async () => {}),
      locator: (selector: string) => ({
        evaluate: async () => true,
        count: async () =>
          selector.includes('count(*) >') ? (options.ax === 'crowded' ? 1 : 0) : 1,
      }),
      context: () => ({ newCDPSession: async () => session }),
    };
    return { tab, sent };
  }

  async function readOut(tab: unknown) {
    const browser = {
      contexts: () => [{ newPage: async () => tab }],
      isConnected: () => true,
      close: vi.fn(async () => {}),
    } as unknown as AoiBrowserDriveBrowser;
    const { deps } = happyDeps({ connect: async () => browser });
    const session = await startAoiBrowserDriveSession(PROFILE_OPTIONS, deps);
    const read = await (
      session.page as unknown as { readOutOf: (s: string) => Promise<unknown> }
    ).readOutOf('#t');
    await session.close();
    return read;
  }

  it("reads what the read-out has and what is drawn, in a world of the check's own", async () => {
    const { tab, sent } = tabWith();
    await expect(readOut(tab)).resolves.toEqual({
      words: 'Details Details Pay now $49.00 Card logo',
      frames: 0,
      drawnFrames: 0,
      whole: true,
      sealed: true,
    });
    const world = sent.find(([method]) => method === 'Page.createIsolatedWorld')?.[1];
    expect(world).toEqual({
      frameId: 'main',
      worldName: expect.any(String),
      grantUniveralAccess: true,
    });
    // The node and its closed shadow tree, as objects of that world, in one
    // group that is let go of after.
    const resolved = sent.filter(([method]) => method === 'DOM.resolveNode').map(([, p]) => p);
    expect(resolved.map((params) => params.backendNodeId)).toEqual([10, 50]);
    expect(resolved.every((params) => params.executionContextId === 7)).toBe(true);
    const group = resolved[0]?.objectGroup;
    expect(new Set(resolved.map((params) => params.objectGroup)).size).toBe(1);
    expect(sent.find(([method]) => method === 'Runtime.callFunctionOn')?.[1]).toMatchObject({
      objectId: 'node-10',
      arguments: [{ objectId: 'node-50' }],
      returnByValue: true,
    });
    expect(sent).toContainEqual(['Runtime.releaseObjectGroup', { objectGroup: group }]);
  });

  it('reads a long drawn text by its start and its end, and only so much of what elements say', async () => {
    const text = `${'a '.repeat(3_000)}Pay now`;
    const read = (await readOut(
      tabWith({ drawn: { text, said: 'x'.repeat(3_000), frames: 0, whole: true } }).tab,
    )) as { words: string };
    expect(read.words.startsWith('Details a a')).toBe(true);
    expect(read.words).toContain('a a Pay now x');
    expect(read.words.length).toBeLessThan(4_000 + 1_000 + 20);
  });

  it('is not whole when what is drawn cannot be read', async () => {
    const cases: Parameters<typeof tabWith>[0][] = [
      { world: 'noFrame' },
      { world: 'noWorld' },
      { world: 'worldFails' },
      { world: 'callFails' },
      { world: 'exception' },
      { unresolved: [50] },
      { drawn: 'oops' },
      { drawn: null },
    ];
    for (const options of cases) {
      const { tab, sent } = tabWith(options);
      await expect(readOut(tab), JSON.stringify(options)).resolves.toEqual({
        words: 'Details',
        frames: 0,
        drawnFrames: 0,
        whole: false,
        sealed: true,
      });
      // Nothing was had there that needs letting go of, without a world: only
      // the group the element was handed over in is let go of.
      if (options?.world === 'noFrame' || options?.world === 'noWorld') {
        expect(
          sent.filter(([method]) => method === 'Runtime.releaseObjectGroup').map(([, p]) => p),
        ).toEqual([{ objectGroup: expect.stringMatching(/^aoi-aim-point-/) }]);
      }
    }
  });

  it('is not whole past as many closed shadow trees or nodes as are read, or when the walk says so', async () => {
    const { tab, sent } = tabWith({ closedRoots: 1_001 });
    await expect(readOut(tab)).resolves.toMatchObject({ whole: false });
    const called = sent.find(([method]) => method === 'Runtime.callFunctionOn')?.[1];
    expect((called?.arguments as unknown[]).length).toBe(1_000);
    await expect(readOut(tabWith({ nodes: 20_001 }).tab)).resolves.toMatchObject({ whole: false });
    // A grid of a few hundred closed components is read whole.
    await expect(readOut(tabWith({ closedRoots: 400 }).tab)).resolves.toMatchObject({
      whole: true,
    });
    await expect(
      readOut(tabWith({ drawn: { text: 'Pay', said: '', frames: 0, whole: false } }).tab),
    ).resolves.toEqual({
      words: 'Details Pay',
      frames: 0,
      drawnFrames: 0,
      whole: false,
      sealed: true,
    });
  });

  it("takes the drawing's spacing where the read-out holds the same letters", async () => {
    // The read-out sets the runs of one wordmark apart; the drawing has them touch.
    const drawn = (text: string) => ({ text, said: '', frames: 0, whole: true });
    await expect(
      readOut(
        tabWith({ axTexts: ['Log in with', 'Pay', 'Pal'], drawn: drawn('Log in with PayPal') }).tab,
      ),
    ).resolves.toMatchObject({ words: 'Log in with PayPal' });
    // Letters the drawing does not have: both are read.
    await expect(
      readOut(tabWith({ axTexts: ['Pay now'], drawn: drawn('Continue') }).tab),
    ).resolves.toMatchObject({ words: 'Pay now Continue' });
  });

  it('takes the frames the walk counts, or those the read-out names', async () => {
    await expect(
      readOut(tabWith({ drawn: { text: '', said: '', frames: 2, whole: true } }).tab),
    ).resolves.toEqual({ words: 'Details', frames: 2, drawnFrames: 2, whole: true, sealed: true });
    await expect(
      readOut(tabWith({ axFrames: true, drawn: { text: '', said: '', whole: true } }).tab),
    ).resolves.toEqual({ words: 'Details', frames: 1, drawnFrames: 0, whole: true, sealed: true });
  });

  it('does not ask the accessibility tree about an element among thousands of siblings', async () => {
    // There the browser takes seconds over every read of that tree, the page
    // frozen meanwhile: what is drawn says it alone.
    const { tab, sent } = tabWith({ ax: 'crowded' });
    await expect(readOut(tab)).resolves.toEqual({
      words: 'Details Pay now $49.00 Card logo',
      frames: 0,
      drawnFrames: 0,
      whole: true,
      sealed: true,
    });
    expect(sent.some(([method]) => method.startsWith('Accessibility.'))).toBe(false);
  });

  it('says what is drawn alone when the accessibility tree is slow to come', async () => {
    await expect(readOut(tabWith({ ax: 'hangs' }).tab)).resolves.toEqual({
      words: 'Details Pay now $49.00 Card logo',
      frames: 0,
      drawnFrames: 0,
      whole: true,
      sealed: true,
    });
  });

  it("reads what a frame of the page's own draws in that frame's own world", async () => {
    // A frame of another origin of the same site is of the page's process: its
    // document is in the description, read where its own scripts are.
    const { tab, sent } = tabWith({
      frameDocument: { frameId: 'child', root: 77 },
      drawn: (objectId: string) =>
        objectId === 'node-77'
          ? { text: 'Pay $49.00', said: '', frames: 0, whole: false }
          : { text: 'Upgrade', said: '', frames: 1, whole: true },
    });
    await expect(readOut(tab)).resolves.toEqual({
      words: 'Details Upgrade Pay $49.00',
      frames: 1,
      drawnFrames: 1,
      // What the frame holds past what is read leaves the element whole.
      whole: true,
      sealed: true,
    });
    const worlds = sent
      .filter(([method]) => method === 'Page.createIsolatedWorld')
      .map(([, p]) => p);
    expect(worlds.map((params) => String(params.frameId)).sort()).toEqual(['child', 'main']);
  });

  it('reads the text again with its inline boxes apart, when that reads otherwise', async () => {
    const read = (await readOut(
      tabWith({
        drawn: { text: 'Paynow', spaced: 'Pay now', said: '', frames: 0, whole: true },
      }).tab,
    )) as { words: string };
    expect(read.words).toBe('Details Paynow Pay now');
    const same = (await readOut(
      tabWith({ drawn: { text: 'Pay now', spaced: 'Pay now', said: '', whole: true } }).tab,
    )) as { words: string };
    expect(same.words).toBe('Details Pay now');
  });

  // The walk as the session sends it, to run here.
  async function walkSource(): Promise<string> {
    const { tab, sent } = tabWith();
    await readOut(tab);
    return String(
      sent.find(([method]) => method === 'Runtime.callFunctionOn')?.[1]?.functionDeclaration,
    );
  }

  type Walked = { text: string; spaced: string; said: string; frames: number; whole: boolean };
  // Runs the walk on a DOM of the test's own, with the styles the browser would
  // give: what `styles` says of an element by its id -- inherited visibility as
  // a browser has it -- else block for a div, p, ul, li or section, and inline
  // for the rest; `pseudos` gives what CSS draws before or after one.
  function walkOn(
    source: string,
    self: unknown,
    closedRoots: unknown[] = [],
    // Any other property an element's style gives (a margin, a font size).
    styles: Record<string, Partial<Record<string, string>>> = {},
    pseudos: Record<string, Partial<Record<'content' | 'display' | 'visibility', string>>> = {},
    // Where each run of text is drawn, by its text trimmed: left, top, right, bottom.
    // (The test DOM lays nothing out.)
    layout: Record<string, [number, number, number, number]> = {},
  ): Walked {
    const walk = new Function(`return (${source})`)() as (
      this: unknown,
      ...roots: unknown[]
    ) => Walked;
    const own = (element: Element) => styles[element.id] ?? {};
    const visibilityOf = (element: Element): string => {
      for (let node: Node | null = element; node; ) {
        const set = node instanceof Element ? own(node).visibility : undefined;
        if (set) {
          return set;
        }
        node =
          (node as Element).parentElement ?? (node.parentNode as ShadowRoot | null)?.host ?? null;
      }
      return 'visible';
    };
    vi.stubGlobal('getComputedStyle', (element: Element, which?: string) => {
      if (which) {
        const drawn = pseudos[`${element.id}${which}`] ?? {};
        return {
          content: drawn.content ?? 'none',
          display: drawn.display ?? 'inline',
          visibility: drawn.visibility ?? visibilityOf(element),
        };
      }
      return {
        ...own(element),
        display:
          own(element).display ??
          (['head', 'title'].includes(element.localName)
            ? 'none'
            : ['div', 'p', 'ul', 'li', 'section'].includes(element.localName)
              ? 'block'
              : 'inline'),
        visibility: visibilityOf(element),
        contentVisibility: own(element).contentVisibility ?? 'visible',
      };
    });
    const createRange = vi.spyOn(document, 'createRange').mockImplementation(() => {
      let text = '';
      return {
        selectNodeContents: (node: Node) => {
          text = (node.textContent ?? '').trim();
        },
        getClientRects: () => {
          const box = layout[text];
          return box ? [{ left: box[0], top: box[1], right: box[2], bottom: box[3] }] : [];
        },
      } as unknown as Range;
    });
    try {
      return walk.call(self, ...closedRoots);
    } finally {
      createRange.mockRestore();
      vi.unstubAllGlobals();
    }
  }
  const lines = (walked: Walked) =>
    walked.text
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

  it('joins inline text as it is drawn, sets blocks apart, and reads no scripts or styles', async () => {
    const walk = await walkSource();
    document.body.innerHTML =
      '<div id="t"><span>Det</span><span>ails</span><div>Pay now</div><script>buy()</script>' +
      '<style>.x{}</style><template><b>Buy</b></template><noscript>Buy</noscript><!-- Buy --></div>';
    const walked = walkOn(walk, document.getElementById('t'));
    expect(lines(walked)).toEqual(['Details', 'Pay now']);
    expect(walked).toMatchObject({ said: '', frames: 0, whole: true });
    document.body.innerHTML = '';
  });

  it('reads nothing of what is not drawn: display none, a skipped section, visibility hidden', async () => {
    const walk = await walkSource();
    document.body.innerHTML =
      '<div id="t"><ul id="menu"><li>Buy gift cards</li></ul><div id="unrendered"><b>Pay</b></div>' +
      '<section id="folded" aria-label="Folded">Pay later</section>' +
      '<p id="ghost" title="Ghost">Hidden <span id="back">Shown</span></p></div>';
    const unrendered = document.getElementById('unrendered') as HTMLElement & {
      checkVisibility?: () => boolean;
    };
    unrendered.checkVisibility = () => false;
    const walked = walkOn(walk, document.getElementById('t'), [], {
      menu: { display: 'none' },
      folded: { contentVisibility: 'hidden' },
      ghost: { visibility: 'hidden' },
      back: { visibility: 'visible' },
    });
    expect(lines(walked)).toEqual(['Shown']);
    // A skipped section still says its name; a hidden one does not.
    expect(walked.said).toBe('Folded');
    document.body.innerHTML = '';
  });

  it('reads what shown elements say: alt, aria-label, title, a button value, a choice', async () => {
    const walk = await walkSource();
    document.body.innerHTML =
      '<div id="t"><img alt="Card logo"><span aria-label="Buy now"></span><a title="Terms">T</a>' +
      '<input type="submit" value="Pay now"><input type="text" value="typed">' +
      '<select><option>Visa 4242</option><option selected>MC 5555</option></select>' +
      '<img id="hid" alt="Hidden alt"><input type="button"></div>';
    for (const option of Array.from(document.querySelectorAll('option'))) {
      (option as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility = () => false;
    }
    const walked = walkOn(walk, document.getElementById('t'), [], {
      hid: { visibility: 'hidden' },
    });
    expect(walked.said.split('\n')).toEqual([
      'Card logo',
      'Buy now',
      'Terms',
      'Pay now',
      'MC 5555',
    ]);
    expect(lines(walked)).toEqual(['T']);
    document.body.innerHTML = '';
  });

  it("reads shadow trees, closed ones it is handed too, and slots, in place of a host's own nodes", async () => {
    const walk = await walkSource();
    document.body.innerHTML =
      '<div id="t"><x-open id="open">Unslotted</x-open><x-closed id="closed">Slotted pay</x-closed>' +
      '<x-empty id="empty"></x-empty></div>';
    const open = document.getElementById('open') as HTMLElement;
    open.attachShadow({ mode: 'open' }).innerHTML = '<p>Open tree</p>';
    const closedRoot = (document.getElementById('closed') as HTMLElement).attachShadow({
      mode: 'closed',
    });
    closedRoot.innerHTML = '<div>Closed tree <slot></slot></div>';
    const emptyRoot = (document.getElementById('empty') as HTMLElement).attachShadow({
      mode: 'closed',
    });
    emptyRoot.innerHTML = '<slot>Fallback</slot>';
    expect(
      lines(walkOn(walk, document.getElementById('t'), [closedRoot, emptyRoot, null])),
    ).toEqual(['Open tree', 'Closed tree Slotted pay', 'Fallback']);
    // A closed tree it is not handed is not read: only what a script can reach.
    expect(lines(walkOn(walk, document.getElementById('t')))).toEqual(['Open tree', 'Slotted pay']);
    document.body.innerHTML = '';
  });

  it('reads what CSS draws before and after an element, quoted strings and escapes', async () => {
    const walk = await walkSource();
    document.body.innerHTML =
      '<div id="t"><span id="a"></span><span id="b">x</span><span id="c"></span><span id="d"></span></div>';
    const walked = walkOn(
      walk,
      document.getElementById('t'),
      [],
      {},
      {
        'a::before': { content: '"Buy " \'now\'' },
        'b::after': { content: '"\\201C quoted\\201D" counter(n) " \\"it\\""' },
        'c::before': { content: '"Not drawn"', display: 'none' },
        'c::after': { content: '"Not shown"', visibility: 'hidden' },
        'd::before': { content: 'normal' },
      },
    );
    expect(lines(walked)).toEqual(['Buy nowx\u201cquoted\u201d "it"']);
    // Run on a pseudo-element, it reads what CSS draws there.
    const pseudo = { element: document.getElementById('a'), type: '::before' };
    expect(lines(walkOn(walk, pseudo, [], {}, { 'a::before': { content: '"Pay now"' } }))).toEqual([
      'Pay now',
    ]);
    document.body.innerHTML = '';
  });

  it('counts frames and embedded documents, and leaves what they hold to be read in their own worlds', async () => {
    const walk = await walkSource();
    document.body.innerHTML =
      '<div id="t"><iframe id="same"></iframe><iframe id="other"></iframe><object></object><embed></div>';
    const inner = document.implementation.createHTMLDocument('inner');
    inner.body.innerHTML = '<p>Pay in frame</p>';
    Object.defineProperty(document.getElementById('same'), 'contentDocument', { value: inner });
    Object.defineProperty(document.getElementById('other'), 'contentDocument', {
      get: () => {
        throw new Error('Blocked a frame with origin');
      },
    });
    const walked = walkOn(walk, document.getElementById('t'));
    expect(walked.frames).toBe(4);
    expect(lines(walked)).toEqual([]);
    // Nor is the frame the walk starts from one of its own.
    expect(walkOn(walk, document.getElementById('same')).frames).toBe(0);
    document.body.innerHTML = '';
  });

  it('sets lines and inline boxes apart, and reads no image addresses as words', async () => {
    const walk = await walkSource();
    document.body.innerHTML =
      '<div id="t"><button>Buy<br>now</button> <span id="a">Pay</span><span id="b">now</span>' +
      '<span id="icon"></span><object id="logo" type="image/svg+xml" data="/logo.svg" aria-label="Acme"></object>' +
      '<embed id="pic" src="/x.png"><svg><slot></slot><text>Svg</text></svg></div>';
    const walked = walkOn(
      walk,
      document.getElementById('t'),
      [],
      { a: { display: 'inline-block' }, b: { display: 'inline-flex' } },
      {
        'icon::before': { content: 'url("/static/checkout-bag.svg") "Bag"' },
        'icon::after': { content: 'image-set(url("/a/top-up.png") 1x, url("/b.png") 2x) " (2)"' },
      },
      // "now" six pixels after "Pay".
      { Pay: [0, 0, 30, 16], now: [36, 0, 66, 16] },
    );
    expect(walked.text.replace(/\s+/g, ' ').trim()).toBe('Buy now PaynowBag (2)Svg');
    expect(walked.spaced.replace(/\s+/g, ' ').trim()).toBe('Buy now Pay nowBag (2)Svg');
    // The image object and embed are images, with what they say of themselves.
    expect(walked).toMatchObject({ frames: 0, said: 'Acme', whole: true });
  });

  it('sets runs apart only where the browser draws them apart', async () => {
    const walk = await walkSource();
    // A wordmark of two colours: two runs that touch draw one word. A run a
    // few pixels after the one before it, right to left as well, or on the
    // next line, is set apart; one less than a sixth of the letters' size
    // after it is not.
    document.body.innerHTML =
      '<div id="t"><span>Pay</span><span>Pal</span> Pay<span>roll</span> Buy<span>now</span> ' +
      '<span>Order</span><span>here</span> <span id="r">Send</span><span id="s">cash</span> ' +
      '<span>Place</span><span>order</span></div>';
    const walked = walkOn(
      walk,
      document.getElementById('t'),
      [],
      { r: { fontSize: '12px' } },
      {},
      {
        Pay: [0, 0, 30, 16],
        Pal: [30, 0, 55, 16],
        roll: [30, 0, 58, 16],
        Buy: [100, 0, 130, 16],
        now: [134, 0, 164, 16],
        // Right to left: "here" is drawn to the left of "Order".
        Order: [200, 20, 250, 36],
        here: [160, 20, 196, 36],
        Send: [0, 40, 40, 56],
        cash: [42, 40, 80, 56],
        // "order" wraps to the next line.
        Place: [300, 60, 350, 76],
        order: [0, 80, 50, 96],
      },
    );
    expect(walked.text.replace(/\s+/g, ' ').trim()).toBe(
      'PayPal Payroll Buynow Orderhere Sendcash Placeorder',
    );
    expect(walked.spaced.replace(/\s+/g, ' ').trim()).toBe(
      'PayPal Payroll Buy now Order here Sendcash Place order',
    );
    document.body.innerHTML = '';
  });

  it("runs on a run that touches a highlight's box, as far as a third of the letters' size", async () => {
    const walk = await walkSource();
    const spacedOf = (
      html: string,
      layout: Record<string, [number, number, number, number]>,
      styles: Record<string, Partial<Record<string, string>>>,
      boxes: Record<string, [number, number, number, number]>,
    ) => {
      document.body.innerHTML = `<div id="t">${html}</div>`;
      const rects = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (
        this: Element,
      ) {
        const box = boxes[this.id];
        return (box
          ? [{ left: box[0], top: box[1], right: box[2], bottom: box[3] }]
          : []) as unknown as DOMRectList;
      });
      try {
        return walkOn(walk, document.getElementById('t'), [], styles, {}, layout)
          .spaced.replace(/\s+/g, ' ')
          .trim();
      } finally {
        rects.mockRestore();
        document.body.innerHTML = '';
      }
    };
    const yellow = { backgroundColor: 'rgb(252, 248, 227)' };
    const html = '<mark id="m">Pay</mark>ment';
    const layout: Record<string, [number, number, number, number]> = {
      Pay: [10, 10, 40, 30],
      ment: [45, 10, 90, 30],
    };
    const padded: Record<string, [number, number, number, number]> = { m: [5, 5, 45, 35] };
    expect(spacedOf(html, layout, { m: yellow }, padded)).toBe('Payment');
    // Nothing drawn around it: the letters' gap.
    expect(spacedOf(html, layout, {}, padded)).toBe('Pay ment');
    expect(spacedOf(html, layout, { m: { backgroundColor: 'rgba(0, 0, 0, 0)' } }, padded)).toBe(
      'Pay ment',
    );
    // A border draws a box; an image behind it too.
    expect(
      spacedOf(
        html,
        layout,
        { m: { borderLeftWidth: '1px', borderLeftStyle: 'dotted', borderLeftColor: 'red' } },
        padded,
      ),
    ).toBe('Payment');
    expect(
      spacedOf(html, layout, { m: { backgroundImage: 'linear-gradient(red, blue)' } }, padded),
    ).toBe('Payment');
    // Padded past a third of the letters' size: set apart.
    expect(
      spacedOf(
        html,
        { Pay: [30, 10, 60, 30], ment: [90, 10, 130, 30] },
        { m: yellow },
        { m: [0, 5, 90, 35] },
      ),
    ).toBe('Pay ment');
    // A highlight a run begins, and one in an inline box of its own: the box
    // a highlight is in does not carry into it.
    expect(
      spacedOf('Pay<mark id="m">ment</mark>', layout, { m: yellow }, { m: [40, 5, 95, 35] }),
    ).toBe('Payment');
    // A price chip beside a word: no letter on its side, no word to join; nor
    // a chip of a word of its own and more, or a tag in capitals.
    expect(
      spacedOf(
        'Buy<mark id="m">49,00 €</mark>',
        { Buy: [10, 10, 40, 30], '49,00 €': [45, 10, 110, 30] },
        { m: yellow },
        { m: [40, 5, 114, 35] },
      ),
    ).toBe('Buy 49,00 €');
    for (const chip of ['CHF 49.00', 'NEW']) {
      expect(
        spacedOf(
          `Buy<mark id="m">${chip}</mark>`,
          { Buy: [10, 10, 40, 30], [chip]: [45, 10, 110, 30] },
          { m: yellow },
          { m: [40, 5, 114, 35] },
        ),
        chip,
      ).toBe(`Buy ${chip}`);
    }
    // A highlight a word of lower case goes on from: joined.
    expect(
      spacedOf(
        'Pre<mark id="m">pay</mark>ment',
        { Pre: [10, 10, 40, 30], pay: [45, 10, 80, 30], ment: [85, 10, 130, 30] },
        { m: yellow },
        { m: [40, 5, 85, 35] },
      ),
    ).toBe('Prepayment');
    expect(
      spacedOf(
        '<mark id="m"><span id="ib">Pay</span></mark>ment',
        layout,
        { m: yellow, ib: { display: 'inline-block' } },
        padded,
      ),
    ).toBe('Pay ment');
  });

  it('tells lines apart by their middles, columns in vertical writing, and gaps by the size drawn', async () => {
    const walk = await walkSource();
    const spacedOf = (
      html: string,
      layout: Record<string, [number, number, number, number]>,
      styles: Record<string, Partial<Record<string, string>>> = {},
    ) => {
      document.body.innerHTML = `<div id="t">${html}</div>`;
      const walked = walkOn(walk, document.getElementById('t'), [], styles, {}, layout);
      document.body.innerHTML = '';
      return walked.spaced.replace(/\s+/g, ' ').trim();
    };
    const two = '<span id="a">Pay</span><span id="b">now</span>';
    // Two lines at a tight line height: their boxes overlap, their middles do not.
    expect(spacedOf(two, { Pay: [0, 0, 30, 16], now: [0, 14, 30, 30] })).toBe('Pay now');
    // Vertical writing: one column runs on, two columns are apart.
    const vertical = { a: { writingMode: 'vertical-rl' }, b: { writingMode: 'vertical-rl' } };
    expect(spacedOf(two, { Pay: [0, 0, 16, 30], now: [0, 30, 16, 60] }, vertical)).toBe('Paynow');
    expect(spacedOf(two, { Pay: [20, 0, 36, 30], now: [0, 0, 16, 30] }, vertical)).toBe('Pay now');
    // Scaled to half: a gap of 2 px is a gap of 4 at the letters' own size.
    expect(spacedOf(two, { Pay: [0, 0, 15, 8], now: [17, 0, 32, 8] })).toBe('Pay now');
    // A small run, then a large one 10 px on.
    expect(spacedOf(two, { Pay: [0, 0, 30, 16], now: [40, 0, 140, 72] })).toBe('Pay now');
    // Touching on one line: one word.
    expect(spacedOf(two, { Pay: [0, 0, 30, 16], now: [30, 0, 60, 16] })).toBe('Paynow');
  });

  it('sets apart a run whose last letter is set with spacing after it', async () => {
    const walk = await walkSource();
    // "Pay" set 4px apart letter by letter: its box ends 4px past its "y", and
    // "now" starts there. Tight tracking takes nothing away.
    document.body.innerHTML =
      '<div id="t"><span id="a">Pay</span><span>now</span> <span id="b">Pay</span><span>Pal</span></div>';
    const walked = walkOn(
      walk,
      document.getElementById('t'),
      [],
      { a: { letterSpacing: '4px' }, b: { letterSpacing: '-0.5px' } },
      {},
      { Pay: [0, 0, 42, 16], now: [42, 0, 72, 16], Pal: [42, 0, 67, 16] },
    );
    expect(walked.spaced.replace(/\s+/g, ' ').trim()).toBe('Pay now PayPal');
    document.body.innerHTML = '';
  });

  it("walks an element's own tree whole before the frames in it, each on its own budget", () => {
    // A large frame of the page's own beside a closed tree that holds the pay
    // button: the frame is walked after, and does not use the walk up.
    const big = {
      nodeType: 9,
      children: [
        {
          nodeType: 1,
          backendNodeId: 50,
          children: Array.from({ length: 90_000 }, () => ({ nodeType: 1 })),
        },
      ],
    };
    const tree = {
      nodeType: 1,
      children: [
        { nodeType: 1, shadowRoots: [{ shadowRootType: 'closed', backendNodeId: 9 }] },
        { nodeType: 1, frameId: 'f1', contentDocument: big },
      ],
    };
    const roots = closedRootsUnder(tree as never);
    expect(roots.closed).toEqual([9]);
    expect(roots.nodes).toBeLessThan(10);
    expect(roots.frames).toEqual([{ frameId: 'f1', root: 50, closed: [] }]);
  });

  it('is not whole deeper than it goes', async () => {
    const walk = await walkSource();
    document.body.innerHTML = `<div id="t">${'<span>'.repeat(520)}Pay${'</span>'.repeat(520)}</div>`;
    expect(walkOn(walk, document.getElementById('t')).whole).toBe(false);
    document.body.innerHTML = '';
  });
});
