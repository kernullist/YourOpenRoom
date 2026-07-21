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
