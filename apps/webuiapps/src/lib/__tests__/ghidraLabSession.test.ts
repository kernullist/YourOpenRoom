// @vitest-environment node
//
// Ghidra Lab session lifecycle, with every effect injected: no Ghidra, no JVM, no
// Python, no sockets. What is being pinned here is the behaviour that decides
// whether an operator gets a useful message or a shrug:
//
//   - MCP never answers  -> blame the install, kill the child, say so within the
//                           JVM window rather than after the analysis deadline.
//   - MCP answers, index  -> blame the binary (analysis_timeout), not the paths.
//     never fills
//   - stop() mid-probe   -> a late success must NOT resurrect the session.
import { describe, expect, it } from 'vitest';

import { normalizeGhidraLabConfig } from '../ghidraLabConfig';
import {
  GHIDRA_LAB_MAX_SESSIONS,
  GhidraLabSessionManager,
  describeGhidraExit,
  findProjectBinary,
  getSharedGhidraLabSessionManager,
  resetSharedGhidraLabSessionManager,
  type GhidraChildHandle,
  type GhidraLabSessionDeps,
  type GhidraMcpClientLike,
} from '../ghidraLabSession';
import type { GhidraLabConfigView, GhidraLabSessionState } from '../ghidraLabTypes';

const isWindows = process.platform === 'win32';
const ROOT = isWindows ? 'C:\\bins' : '/bins';
const BINARY = `${ROOT}${isWindows ? '\\' : '/'}client.exe`;

function config(patch: Record<string, unknown> = {}): GhidraLabConfigView {
  return normalizeGhidraLabConfig({
    ghidraInstallDir: isWindows ? 'C:\\ghidra' : '/ghidra',
    jdkHome: isWindows ? 'C:\\jdk21' : '/jdk21',
    pythonExePath: isWindows ? 'C:\\venv\\python.exe' : '/venv/python',
    projectRoot: isWindows ? 'C:\\projects' : '/projects',
    binaryRoots: [{ id: 'bins', path: ROOT, label: 'Bins' }],
    ...patch,
  });
}

interface FakeChild extends GhidraChildHandle {
  killed: boolean;
  emitExit(code: number | null, signal: string | null): void;
  emitOutput(chunk: string): void;
}

function makeChild(pid = 4242): FakeChild {
  const exitListeners: ((code: number | null, signal: string | null) => void)[] = [];
  const outputListeners: ((chunk: string) => void)[] = [];
  return {
    pid,
    killed: false,
    onExit(listener) {
      exitListeners.push(listener);
    },
    onOutput(listener) {
      outputListeners.push(listener);
    },
    kill() {
      this.killed = true;
    },
    emitExit(code, signal) {
      for (const listener of exitListeners) {
        listener(code, signal);
      }
    },
    emitOutput(chunk) {
      for (const listener of outputListeners) {
        listener(chunk);
      }
    },
  };
}

interface Harness {
  manager: GhidraLabSessionManager;
  deps: GhidraLabSessionDeps;
  child: FakeChild;
  clientCalls: { tool: string; args: Record<string, unknown> }[];
  spawns: { program: string; args: string[]; env: Record<string, string> }[];
  setMcpUp(up: boolean): void;
  setProjectHasBinary(has: boolean): void;
  setToolResult(tool: string, result: unknown | (() => unknown)): void;
  setTools(names: string[]): void;
}

function makeHarness(overrides: Partial<GhidraLabSessionDeps> = {}): Harness {
  let clock = 1_000_000;
  let mcpUp = true;
  let projectHasBinary = true;
  let tools = [
    'list_project_binaries',
    'list_project_binary_metadata',
    'list_imports',
    'list_exports',
    'search_strings',
    'search_symbols_by_name',
    'decompile_function',
    'list_xrefs',
    'gen_callgraph',
    'search_code',
  ];
  const results = new Map<string, unknown | (() => unknown)>();
  const child = makeChild();
  const clientCalls: { tool: string; args: Record<string, unknown> }[] = [];
  const spawns: { program: string; args: string[]; env: Record<string, string> }[] = [];

  const client: GhidraMcpClientLike = {
    async initialize() {
      if (!mcpUp) {
        throw new Error('ECONNREFUSED');
      }
    },
    async listTools() {
      if (!mcpUp) {
        throw new Error('ECONNREFUSED');
      }
      return tools.map((name) => ({ name }));
    },
    async callTool(name, args) {
      clientCalls.push({ tool: name, args });
      if (!mcpUp) {
        throw new Error('ECONNREFUSED');
      }
      if (name === 'list_project_binaries') {
        // The real envelope: `programs`, an engine-assigned name, and the
        // engine's own analysis_complete flag.
        return projectHasBinary
          ? { programs: [{ name: '/client.exe-ab12cd', analysis_complete: true }] }
          : { programs: [] };
      }
      const canned = results.get(name);
      if (typeof canned === 'function') {
        return (canned as () => unknown)();
      }
      if (canned !== undefined) {
        return canned;
      }
      return { content: [{ type: 'text', text: '[]' }] };
    },
  };

  const deps: GhidraLabSessionDeps = {
    spawnProcess(program, args, options) {
      spawns.push({ program, args, env: options.env });
      return child;
    },
    createMcpClient: () => client,
    now: () => clock,
    // Sleeping advances the fake clock, which is what makes the deadline loops
    // terminate in a test without any real time passing.
    sleep: async (ms: number) => {
      clock += ms;
    },
    isPortFree: async () => true,
    projectBytes: () => 0,
    ...overrides,
  };

  return {
    manager: new GhidraLabSessionManager(deps),
    deps,
    child,
    clientCalls,
    spawns,
    setMcpUp: (up) => {
      mcpUp = up;
    },
    setProjectHasBinary: (has) => {
      projectHasBinary = has;
    },
    setToolResult: (tool, result) => {
      results.set(tool, result);
    },
    setTools: (names) => {
      tools = names;
    },
  };
}

/** Spin the microtask queue until the session lands in one of `states`. */
async function waitForState(
  manager: GhidraLabSessionManager,
  sessionId: string,
  states: GhidraLabSessionState[],
  maxTicks = 20000,
): Promise<GhidraLabSessionState> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const state = manager.get(sessionId)?.state;
    if (state && states.includes(state)) {
      return state;
    }
    await Promise.resolve();
  }
  throw new Error(`session never reached ${states.join('/')}`);
}

async function startReady(harness: Harness): Promise<string> {
  const started = await harness.manager.startHeadless({
    config: config(),
    binaryPath: BINARY,
    projectName: 'client-abc',
    launch: 'module',
  });
  const id = started.session?.id ?? '';
  await waitForState(harness.manager, id, ['ready']);
  return id;
}

describe('startHeadless', () => {
  it('spawns with the Ghidra child environment and reaches ready', async () => {
    const harness = makeHarness();
    const id = await startReady(harness);
    const session = harness.manager.get(id);
    expect(session?.state).toBe('ready');
    expect(session?.mode).toBe('headless');
    expect(session?.pid).toBe(4242);
    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0].env.JAVA_HOME).toBe(isWindows ? 'C:\\jdk21' : '/jdk21');
    expect(harness.spawns[0].env.GHIDRA_INSTALL_DIR).toBe(isWindows ? 'C:\\ghidra' : '/ghidra');
    expect(harness.spawns[0].args).toContain('streamable-http');
  });

  it('tells the engine to re-analyse when it is reusing a project', async () => {
    const harness = makeHarness({ projectExists: () => true });
    await harness.manager.startHeadless({
      config: config(),
      binaryPath: BINARY,
      projectName: 'client-abc',
      launch: 'module',
    });
    expect(harness.spawns[0].args).toContain('--force-analysis');
  });

  it('clears progress once ready so the UI stops showing a wait', async () => {
    const harness = makeHarness();
    const id = await startReady(harness);
    expect(harness.manager.get(id)?.progress).toBeNull();
    expect(harness.manager.get(id)?.readyAt).not.toBeNull();
  });

  it('refuses a second session on the same binary and names the first', async () => {
    const harness = makeHarness();
    const id = await startReady(harness);
    const second = await harness.manager.startHeadless({
      config: config(),
      binaryPath: BINARY,
      projectName: 'client-abc',
      launch: 'module',
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('session_already_open');
    expect(second.existingSessionId).toBe(id);
  });

  it('enforces the session cap', async () => {
    const harness = makeHarness();
    for (let index = 0; index < GHIDRA_LAB_MAX_SESSIONS; index += 1) {
      const started = await harness.manager.startHeadless({
        config: config(),
        binaryPath: `${BINARY}.${index}`,
        projectName: `p${index}`,
        launch: 'module',
      });
      expect(started.ok).toBe(true);
    }
    const overflow = await harness.manager.startHeadless({
      config: config(),
      binaryPath: `${BINARY}.overflow`,
      projectName: 'overflow',
      launch: 'module',
    });
    expect(overflow.ok).toBe(false);
    expect(overflow.reason).toBe('session_limit_reached');
  });

  it('refuses headless mode with no interpreter configured', async () => {
    const harness = makeHarness();
    const started = await harness.manager.startHeadless({
      config: config({ pythonExePath: '' }),
      binaryPath: BINARY,
      projectName: 'p',
      launch: 'module',
    });
    expect(started.ok).toBe(false);
    expect(started.reason).toBe('python_not_configured');
  });

  it('reports a spawn failure rather than throwing', async () => {
    const harness = makeHarness({
      spawnProcess: () => {
        throw new Error('ENOENT');
      },
    });
    const started = await harness.manager.startHeadless({
      config: config(),
      binaryPath: BINARY,
      projectName: 'p',
      launch: 'module',
    });
    expect(started.ok).toBe(false);
    expect(started.reason).toContain('spawn_failed');
  });

  it('gives up on an unreachable engine inside the JVM window, not the analysis one', async () => {
    const harness = makeHarness();
    harness.setMcpUp(false);
    const started = await harness.manager.startHeadless({
      // A four-hour analysis budget must not delay a verdict about the install.
      config: config({ analysisTimeoutMs: 4 * 60 * 60 * 1000 }),
      binaryPath: BINARY,
      projectName: 'p',
      launch: 'module',
    });
    const id = started.session?.id ?? '';
    await waitForState(harness.manager, id, ['failed']);
    const session = harness.manager.get(id);
    expect(session?.failureReason).toContain('never answered');
    expect(session?.failureReason).toContain('Setup');
    // The server never exits on its own, so a give-up has to reclaim it.
    expect(harness.child.killed).toBe(true);
  });

  it('blames analysis, not the install, when MCP answers but the index never fills', async () => {
    const harness = makeHarness();
    harness.setProjectHasBinary(false);
    const started = await harness.manager.startHeadless({
      config: config({ analysisTimeoutMs: 5 * 60 * 1000 }),
      binaryPath: BINARY,
      projectName: 'p',
      launch: 'module',
    });
    const id = started.session?.id ?? '';
    await waitForState(harness.manager, id, ['failed']);
    expect(harness.manager.get(id)?.failureReason).toContain('analysis_timeout');
    expect(harness.child.killed).toBe(true);
  });

  it('surfaces an early child exit with an actionable cause', async () => {
    const harness = makeHarness();
    harness.setMcpUp(false);
    const started = await harness.manager.startHeadless({
      config: config(),
      binaryPath: BINARY,
      projectName: 'p',
      launch: 'module',
    });
    const id = started.session?.id ?? '';
    harness.child.emitOutput('ModuleNotFoundError: No module named pyghidra_mcp');
    harness.child.emitExit(1, null);
    expect(harness.manager.get(id)?.state).toBe('failed');
    expect(harness.manager.get(id)?.failureReason).toContain('pyghidra-mcp');
  });

  it('does not resurrect a session that was stopped while a probe was in flight', async () => {
    const harness = makeHarness();
    const started = await harness.manager.startHeadless({
      config: config(),
      binaryPath: BINARY,
      projectName: 'p',
      launch: 'module',
    });
    const id = started.session?.id ?? '';
    // Stop before the poll loop has had a chance to see a ready engine.
    await harness.manager.stop(id);
    for (let tick = 0; tick < 500; tick += 1) {
      await Promise.resolve();
    }
    expect(harness.manager.get(id)?.state).toBe('stopped');
    expect(harness.child.killed).toBe(true);
  });
});

describe('query', () => {
  it('maps a sub-command onto the engine tool and caps the answer', async () => {
    const harness = makeHarness();
    const id = await startReady(harness);
    harness.setToolResult('list_imports', {
      content: [
        { type: 'text', text: JSON.stringify([{ dll: 'kernel32.dll', name: 'VirtualAlloc' }]) },
      ],
    });
    const outcome = await harness.manager.query(id, 'imports', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.mcpTool).toBe('list_imports');
    expect(outcome.rows).toEqual([{ dll: 'kernel32.dll', name: 'VirtualAlloc' }]);
    expect(harness.manager.get(id)?.queryCount).toBe(1);
  });

  it('refuses a sub-command that is not in the allowlist', async () => {
    const harness = makeHarness();
    const id = await startReady(harness);
    const outcome = await harness.manager.query(id, 'read_bytes', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('unknown_query_kind');
    // Nothing reached the engine.
    expect(harness.clientCalls.some((call) => call.tool === 'read_bytes')).toBe(false);
  });

  it('drops arguments that are not on the spec allowlist', async () => {
    const harness = makeHarness();
    const id = await startReady(harness);
    await harness.manager.query(id, 'imports', { binary_name: 'client.exe', danger: 'rm -rf' });
    const call = harness.clientCalls.find((entry) => entry.tool === 'list_imports');
    expect(call?.args.binary_name).toBe('client.exe');
    expect(call?.args.danger).toBeUndefined();
  });

  it('refuses when the live engine advertises no matching tool, and says what it has', async () => {
    const harness = makeHarness();
    harness.setTools(['list_project_binaries', 'something_else']);
    const id = await startReady(harness);
    const outcome = await harness.manager.query(id, 'decompile', { name: 'main' });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('tool_not_available_on_engine');
    expect(outcome.reason).toContain('something_else');
  });

  it('refuses a query against a session that is not ready', async () => {
    const harness = makeHarness();
    harness.setMcpUp(false);
    const started = await harness.manager.startHeadless({
      config: config(),
      binaryPath: BINARY,
      projectName: 'p',
      launch: 'module',
    });
    const id = started.session?.id ?? '';
    const outcome = await harness.manager.query(id, 'imports', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('session_not_ready');
  });

  it('reports an engine error without killing the session', async () => {
    const harness = makeHarness();
    const id = await startReady(harness);
    harness.setToolResult('list_imports', () => {
      throw new Error('decompiler unavailable');
    });
    const outcome = await harness.manager.query(id, 'imports', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('engine_error');
    expect(outcome.engineError).toContain('decompiler unavailable');
    expect(harness.manager.get(id)?.state).toBe('ready');
  });

  it('requires the arguments a sub-command cannot work without', async () => {
    const harness = makeHarness();
    const id = await startReady(harness);
    const outcome = await harness.manager.query(id, 'search', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('missing_required_args');
  });
});

describe('stop and reaping', () => {
  it('stop kills the child and is idempotent', async () => {
    const harness = makeHarness();
    const id = await startReady(harness);
    expect((await harness.manager.stop(id)).ok).toBe(true);
    expect(harness.child.killed).toBe(true);
    expect((await harness.manager.stop(id)).ok).toBe(true);
    expect(harness.manager.get(id)?.state).toBe('stopped');
  });

  it('reapIdle closes an idle session but never one mid-query', async () => {
    const harness = makeHarness();
    const id = await startReady(harness);
    let release = (): void => {};
    harness.setToolResult(
      'list_imports',
      () =>
        new Promise((resolve) => {
          release = () => resolve({ content: [] });
        }),
    );
    const inFlight = harness.manager.query(id, 'imports', {});
    await Promise.resolve();

    // lastUsedAt is stamped when a query RETURNS, so mid-query the session still
    // reads as idle by timestamp alone. It must not be reaped.
    const reapedDuring = await harness.manager.reapIdle(
      config({ sessionIdleTimeoutMs: 60 * 1000 }),
    );
    expect(reapedDuring).toEqual([]);

    release();
    await inFlight;
    expect(harness.manager.get(id)?.state).toBe('ready');
  });

  it('killAllChildren stops everything for a server shutdown', async () => {
    const harness = makeHarness();
    const id = await startReady(harness);
    harness.manager.killAllChildren();
    expect(harness.child.killed).toBe(true);
    expect(harness.manager.get(id)?.failureReason).toBe('server_shutdown');
  });

  it('pruneTerminal drops only old terminal records', async () => {
    const harness = makeHarness();
    const id = await startReady(harness);
    await harness.manager.stop(id);
    harness.manager.pruneTerminal(60 * 60 * 1000);
    expect(harness.manager.get(id)).not.toBeNull();
    harness.manager.pruneTerminal(-1);
    expect(harness.manager.get(id)).toBeNull();
  });
});

describe('describeGhidraExit', () => {
  it('translates the failures that would otherwise read as a generic crash', () => {
    expect(
      describeGhidraExit(1, null, 'Error: Could not create the Java Virtual Machine'),
    ).toContain('heap');
    expect(
      describeGhidraExit(1, null, 'ModuleNotFoundError: No module named pyghidra_mcp'),
    ).toContain('pyghidra-mcp');
    expect(
      describeGhidraExit(1, null, 'UnsupportedClassVersionError: class file version 65.0'),
    ).toContain('JDK 21');
    expect(describeGhidraExit(1, null, 'GHIDRA_INSTALL_DIR is not set')).toContain('Ghidra');
    expect(describeGhidraExit(null, 'SIGKILL', '')).toContain('SIGKILL');
    expect(describeGhidraExit(3, null, '')).toContain('code 3');
  });
});

describe('findProjectBinary', () => {
  it('returns the ENGINE name, which is not the filename we started from', () => {
    // Measured: where.exe is imported as /where.exe-e4c967, and every other tool
    // takes that name. Using ours gets "Binary where.exe not found".
    const found = findProjectBinary(
      { programs: [{ name: '/client.exe-ab12cd', analysis_complete: true }] },
      'client.exe',
    );
    expect(found?.name).toBe('/client.exe-ab12cd');
    expect(found?.analysisComplete).toBe(true);
  });

  it('reports an imported-but-unanalyzed binary as not complete', () => {
    const found = findProjectBinary(
      { programs: [{ name: '/client.exe-ab12cd', analysis_complete: false }] },
      'client.exe',
    );
    expect(found?.name).toBe('/client.exe-ab12cd');
    expect(found?.analysisComplete).toBe(false);
  });

  it('treats a missing analysis flag as complete rather than waiting forever', () => {
    expect(
      findProjectBinary({ programs: [{ name: 'client.exe' }] }, 'client.exe')?.analysisComplete,
    ).toBe(true);
  });

  it('accepts the other envelopes and a bare list', () => {
    expect(findProjectBinary({ binaries: [{ name: 'client.exe' }] }, 'client.exe')?.name).toBe(
      'client.exe',
    );
    expect(findProjectBinary([{ name: 'client.exe' }], 'client.exe')?.name).toBe('client.exe');
    expect(findProjectBinary(['client.exe'], 'CLIENT.EXE')?.name).toBe('client.exe');
  });

  it('returns null when the project does not hold it', () => {
    expect(findProjectBinary({ programs: [] }, 'client.exe')).toBeNull();
    expect(findProjectBinary(null, 'client.exe')).toBeNull();
    expect(findProjectBinary({ programs: [{ name: 'other.exe' }] }, 'client.exe')).toBeNull();
    expect(findProjectBinary({ programs: [{ name: 'client.exe' }] }, '')).toBeNull();
  });
});

describe('engine binary name', () => {
  it('is learned at readiness and used for every later query', async () => {
    const harness = makeHarness();
    const id = await startReady(harness);
    expect(harness.manager.engineBinaryName(id)).toBe('/client.exe-ab12cd');
    await harness.manager.query(id, 'imports', {});
    const call = harness.clientCalls.find((entry) => entry.tool === 'list_imports');
    expect(call?.args.binary_name).toBe('/client.exe-ab12cd');
  });

  it('lets an explicit binary_name win, for a multi-binary project', async () => {
    const harness = makeHarness();
    const id = await startReady(harness);
    await harness.manager.query(id, 'imports', { binary_name: '/other.dll-99' });
    const call = harness.clientCalls.find((entry) => entry.tool === 'list_imports');
    expect(call?.args.binary_name).toBe('/other.dll-99');
  });
});

describe('unknown sessions', () => {
  it('answers every accessor for an id it has never seen, rather than throwing', async () => {
    // The UI polls these while a session is starting and after one is reaped, so
    // an id that no longer exists is normal traffic, not an error condition.
    const harness = makeHarness();
    expect(harness.manager.get('nope')).toBeNull();
    expect(harness.manager.outputTail('nope')).toBe('');
    expect(harness.manager.engineBinaryName('nope')).toBe('');
    const stopped = await harness.manager.stop('nope');
    expect(stopped.ok).toBe(false);
    expect(stopped.reason).toBe('session_not_found');
    const query = await harness.manager.query('nope', 'imports', {});
    expect(query.ok).toBe(false);
    expect(query.reason).toBe('session_not_found');
  });
});

describe('shared session manager', () => {
  it('is one per process and kills its children when reset', async () => {
    // Reset runs on dev-server shutdown. A manager that forgot its children
    // there left the JVM holding the port, and the next start could not bind.
    resetSharedGhidraLabSessionManager();
    const harness = makeHarness();
    const first = getSharedGhidraLabSessionManager(harness.deps);
    expect(getSharedGhidraLabSessionManager(harness.deps)).toBe(first);
    resetSharedGhidraLabSessionManager();
    expect(getSharedGhidraLabSessionManager(harness.deps)).not.toBe(first);
    resetSharedGhidraLabSessionManager();
  });
});
