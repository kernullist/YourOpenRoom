// @vitest-environment node
//
// The GUI launch and the headless start share one spawn hook but must not share
// its options. Reusing the headless set meant IDA ran with no window at all:
// measured on a real machine as two ida.exe processes alive with
// MainWindowHandle = 0.
import { describe, expect, it } from 'vitest';

import { IdaSqlSessionManager, createIdaSqlNodeDeps } from '../idaSqlSession';
import { normalizeIdaSqlConfig } from '../idaSqlConfig';

const CONFIG = normalizeIdaSqlConfig({
  idaExePath: 'C:\\Program Files\\IDA Professional 9.4\\ida.exe',
  idasqlExePath: 'F:\\Aoi\\idasql\\idasql.exe',
  binaryRoots: [{ id: 'aoi', path: 'F:\\Aoi', label: 'Aoi' }],
});

const BINARY = 'F:\\Aoi\\samples\\x.exe';

function recordingManager(): {
  manager: IdaSqlSessionManager;
  calls: { program: string; options: Record<string, unknown> }[];
} {
  const calls: { program: string; options: Record<string, unknown> }[] = [];
  const manager = new IdaSqlSessionManager({
    spawnProcess: (program, _args, options) => {
      calls.push({ program, options: options as unknown as Record<string, unknown> });
      return { pid: 4242, onExit() {}, onOutput() {}, kill() {} };
    },
    httpRequest: async () => ({ status: 200, text: '{"tool":"idasql"}' }),
    now: () => 1_000_000,
    sleep: async () => {},
    isPortFree: async () => true,
  });
  return { manager, calls };
}

describe('launching the operator IDA window', () => {
  it('asks for an interactive spawn, so the window is not hidden', async () => {
    const { manager, calls } = recordingManager();
    const launched = await manager.launchGui({ config: CONFIG, binaryPath: BINARY });
    expect(launched.ok, launched.reason).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].program).toContain('ida.exe');
    expect(calls[0].options.interactive).toBe(true);
  });

  it('does not ask for it when starting our own headless idasql', async () => {
    const { manager, calls } = recordingManager();
    await manager.startHeadless({ config: CONFIG, binaryPath: BINARY, write: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].program).toContain('idasql.exe');
    // Undefined or false both mean "our process"; what matters is it is not true.
    expect(calls[0].options.interactive).not.toBe(true);
  });
});

describe('the real node spawn', () => {
  it('gives an interactive child no pipes to deadlock on, and lets it outlive us', async () => {
    // nodeSpawn is not exported, so drive it through the real deps. A child with
    // stdio 'ignore' exposes no stdout/stderr to read -- which is exactly why it
    // cannot fill a pipe buffer nobody drains. launchGui registers no reader.
    const deps = createIdaSqlNodeDeps();
    const env = {} as Record<string, string>;
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }

    let sawOutput = false;
    const windowed = deps.spawnProcess(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(1024))'],
      { cwd: process.cwd(), env, interactive: true },
    );
    windowed.onOutput(() => {
      sawOutput = true;
    });
    expect(typeof windowed.pid).toBe('number');
    await new Promise((done) => setTimeout(done, 300));
    expect(sawOutput).toBe(false);
    windowed.kill();

    // ...while our own child still hands us its output, which the readiness
    // poll and the diagnostics tail both depend on.
    const owned = deps.spawnProcess(
      process.execPath,
      ['-e', 'process.stdout.write("hello-from-child")'],
      { cwd: process.cwd(), env },
    );
    // Wait on the output itself rather than on a duration: node's own startup
    // dominates here, and a fixed sleep fails on a loaded machine for no real
    // reason. The race bounds it so a broken pipe cannot hang the suite.
    const firstChunk = new Promise<string>((resolveChunk) => {
      owned.onOutput(resolveChunk);
    });
    const timedOut = new Promise<string>((resolveTimeout) => {
      setTimeout(() => resolveTimeout(''), 10_000);
    });
    expect(await Promise.race([firstChunk, timedOut])).toContain('hello-from-child');
    owned.kill();
  });
});

describe('a GUI launch of a program that is not there', () => {
  it('fails cleanly instead of taking the server down', async () => {
    // Reproduced before the fix: spawn of a missing exe returns pid undefined and
    // then emits an ASYNCHRONOUS 'error'. An EventEmitter 'error' with no
    // listener throws an uncaught exception, and launchGui discarded its handle
    // without registering one -- so a moved ida.exe killed the dev server. It
    // also reported ok:true with a null pid, telling the caller "IDA is
    // starting" about a process that was never created.
    const config = normalizeIdaSqlConfig({
      idaExePath: 'C:\\Program Files\\IDA Professional 9.4\\ida_that_is_not_there.exe',
      idasqlExePath: 'F:\\Aoi\\idasql\\idasql.exe',
      binaryRoots: [{ id: 'aoi', path: 'F:\\Aoi', label: 'Aoi' }],
    });
    const uncaught: string[] = [];
    const onUncaught = (error: Error): void => {
      uncaught.push(String(error));
    };
    process.on('uncaughtException', onUncaught);
    const logged: string[] = [];
    try {
      const manager = new IdaSqlSessionManager(
        createIdaSqlNodeDeps({
          logError: (message) => {
            logged.push(message);
          },
        }),
      );
      const launched = await manager.launchGui({ config, binaryPath: BINARY });
      expect(launched.ok).toBe(false);
      expect(launched.reason).toBe('spawn_failed');
      expect(launched.pid).toBeNull();
      // The async 'error' lands after launchGui has returned; this is the window
      // the uncaught exception used to happen in.
      await new Promise((done) => setTimeout(done, 1200));
      expect(uncaught).toEqual([]);
      // ...and the operator gets told which path was wrong.
      expect(logged.join(' ')).toContain('ida_that_is_not_there.exe');
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  }, 20_000);

  it('never reports a launch with no pid as a success', async () => {
    // The injected-deps version of the same rule, so it holds without a real
    // filesystem: no pid means no process, whatever the reason.
    const manager = new IdaSqlSessionManager({
      spawnProcess: () => ({ pid: null, onExit() {}, onOutput() {}, kill() {} }),
      httpRequest: async () => ({ status: 200, text: '{"tool":"idasql"}' }),
      now: () => 1_000_000,
      sleep: async () => {},
      isPortFree: async () => true,
    });
    const launched = await manager.launchGui({ config: CONFIG, binaryPath: BINARY });
    expect(launched.ok).toBe(false);
    expect(launched.pid).toBeNull();
  });
});

describe('attaching to a port we suggested, not one a human declared', () => {
  function managerAnsweringWith(text: string, port: number): IdaSqlSessionManager {
    return new IdaSqlSessionManager({
      spawnProcess: () => ({ pid: 1, onExit() {}, onOutput() {}, kill() {} }),
      httpRequest: async (url) =>
        url.includes(`:${port}/`)
          ? { status: 200, text }
          : Promise.reject(new Error('ECONNREFUSED')),
      now: () => 1_000_000,
      sleep: async () => {},
      isPortFree: async () => true,
    });
  }

  it('refuses a server on the suggested port that does not identify itself', async () => {
    // The regression this pins: portHint used to double as "the operator read
    // this port in IDA", so it skipped the identity check. Once launchGui started
    // SUGGESTING a port and the app passed it automatically, that shortcut was
    // trusting a port nobody declared -- and posting SQL to whatever was on it.
    const manager = managerAnsweringWith('{"service":"some-unrelated-dev-server"}', 8100);
    const attached = await manager.attachGui({ portHint: 8100 });
    expect(attached.ok).toBe(false);
    expect(attached.reason).toBe('gui_server_unrecognized');
    expect(attached.session).toBeNull();
  });

  it('accepts it once it identifies itself as idasql', async () => {
    const manager = managerAnsweringWith(
      '{"functions":103,"status":"ok","success":true,"tool":"idasql"}',
      8100,
    );
    const attached = await manager.attachGui({ portHint: 8100 });
    expect(attached.ok, attached.reason).toBe(true);
    expect(attached.session?.port).toBe(8100);
  });

  it('still takes a HUMAN declaration at its word', async () => {
    // A person can see what is on the port. That is the whole basis for the
    // exception, so it needs an explicit flag rather than riding on a hint.
    const manager = managerAnsweringWith('{"something":"unidentified"}', 8137);
    const guessed = await manager.attachGui({ portHint: 8137 });
    expect(guessed.ok).toBe(false);

    const declared = await manager.attachGui({ portHint: 8137, portDeclared: true });
    expect(declared.ok, declared.reason).toBe(true);
    expect(declared.session?.port).toBe(8137);
  });

  it('distinguishes nothing-there from something-unrecognized', async () => {
    const silent = new IdaSqlSessionManager({
      spawnProcess: () => ({ pid: 1, onExit() {}, onOutput() {}, kill() {} }),
      httpRequest: async () => {
        throw new Error('ECONNREFUSED');
      },
      now: () => 1_000_000,
      sleep: async () => {},
      isPortFree: async () => true,
    });
    const nothing = await silent.attachGui({ portHint: 8100 });
    expect(nothing.reason).toBe('no_gui_server_found');
  });
});

describe('the port we suggest', () => {
  it('is one nothing on the machine is listening on', async () => {
    // The operator copies this port into IDA verbatim; `.http start` on a port
    // something else owns fails inside IDA with a bind error they then have to
    // diagnose.
    const busy = new Set([8100, 8101, 8102]);
    const manager = new IdaSqlSessionManager({
      spawnProcess: () => ({ pid: 4242, onExit() {}, onOutput() {}, kill() {} }),
      httpRequest: async () => ({ status: 200, text: '{"tool":"idasql"}' }),
      now: () => 1_000_000,
      sleep: async () => {},
      isPortFree: async (port) => !busy.has(port),
    });
    const launched = await manager.launchGui({ config: CONFIG, binaryPath: BINARY });
    expect(launched.ok, launched.reason).toBe(true);
    expect(launched.suggestedPort).toBe(8103);
    expect(launched.startCommand).toContain('127.0.0.1 8103');
  });

  it('suggests one anyway when the whole range is busy, rather than refusing', async () => {
    const manager = new IdaSqlSessionManager({
      spawnProcess: () => ({ pid: 4242, onExit() {}, onOutput() {}, kill() {} }),
      httpRequest: async () => ({ status: 200, text: '{"tool":"idasql"}' }),
      now: () => 1_000_000,
      sleep: async () => {},
      isPortFree: async () => false,
    });
    const launched = await manager.launchGui({ config: CONFIG, binaryPath: BINARY });
    expect(launched.ok, launched.reason).toBe(true);
    expect(launched.suggestedPort).toBeGreaterThan(0);
  });

  it('puts a token on the command, because the plugin default is no auth', async () => {
    const { manager } = recordingManager();
    const launched = await manager.launchGui({ config: CONFIG, binaryPath: BINARY });
    expect(launched.startCommand).toMatch(/^\.http start 127\.0\.0\.1 \d+ --token \S+$/);
    expect(launched.suggestedToken.length).toBeGreaterThan(16);
  });
});
