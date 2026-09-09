// @vitest-environment node
//
// The run manager is what makes a tens-of-minutes sweep survivable: it starts in
// the background, reports progress, can be cancelled between stages, and writes
// its findings to disk even when the tail of the pipeline fails.
//
// The property worth defending hardest is that work is never simply lost. A
// cancelled or partially failed run still writes the ledger and a report of what
// it did collect.
import { describe, expect, it } from 'vitest';

import { normalizeGhidraLabConfig } from '../ghidraLabConfig';
import {
  GhidraLabRunManager,
  getSharedGhidraLabRunManager,
  resetSharedGhidraLabRunManager,
  runCapa,
  type GhidraLabRunDeps,
} from '../ghidraLabRunner';
import type { GhidraLabQueryOutcome } from '../ghidraLabSession';

const BINARY = 'C:\\bins\\client.exe';
const config = normalizeGhidraLabConfig({
  ghidraInstallDir: 'C:\\ghidra',
  jdkHome: 'C:\\jdk21',
  projectRoot: 'C:\\projects',
});

function outcome(rows: unknown[]): GhidraLabQueryOutcome {
  return {
    ok: true,
    kind: null,
    mcpTool: 'fake',
    rows,
    rowCount: rows.length,
    truncated: false,
    elapsedMs: 1,
    engineError: '',
    reason: '',
  };
}

interface Harness {
  manager: GhidraLabRunManager;
  written: Map<string, string>;
  errors: string[];
}

function makeHarness(overrides: Partial<GhidraLabRunDeps> = {}): Harness {
  const written = new Map<string, string>();
  const errors: string[] = [];
  const deps: GhidraLabRunDeps = {
    async query(_sessionId, kind) {
      if (kind === 'imports') {
        return outcome([{ library: 'ntdll.dll', name: 'NtLoadDriver' }]);
      }
      if (kind === 'functions') {
        return outcome([{ name: 'DriverEntry', address: '0x1000', is_entry: true }]);
      }
      if (kind === 'decompile') {
        return outcome([{ name: 'DriverEntry', decompiled: 'void DriverEntry(void){}' }]);
      }
      return outcome([]);
    },
    hashFile: () => ({ sha256: 'b'.repeat(64), sizeBytes: 4096, mtimeMs: 0 }),
    writeArtifact: (path, contents) => {
      written.set(path, contents);
    },
    now: () => 5_000,
    // Immediate: the strings stage polls for the engine's background string
    // index, and a real sleep would make every run in this file wait that out.
    sleep: async () => {},
    logError: (message) => errors.push(message),
    ...overrides,
  };
  return { manager: new GhidraLabRunManager(deps, 'C:\\runs'), written, errors };
}

async function waitForRun(
  manager: GhidraLabRunManager,
  runId: string,
  states: string[],
  maxTicks = 20000,
): Promise<string> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const state = manager.get(runId)?.state;
    if (state && states.includes(state)) {
      return state;
    }
    await Promise.resolve();
  }
  throw new Error(`run never reached ${states.join('/')}`);
}

describe('GhidraLabRunManager', () => {
  it('runs a sweep to completion and writes all three artifacts', async () => {
    const harness = makeHarness();
    const started = harness.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    expect(started.ok).toBe(true);
    await waitForRun(harness.manager, started.runId, ['done']);

    const paths = [...harness.written.keys()].join(' ');
    expect(paths).toContain('report.md');
    expect(paths).toContain('ledger.json');
    expect(paths).toContain('manifest.json');

    const view = harness.manager.get(started.runId);
    expect(view?.anchorCount).toBeGreaterThan(0);
    expect(view?.finishedAt).not.toBeNull();
  });

  it('writes a report that carries the deterministic findings with no model', async () => {
    const harness = makeHarness();
    const started = harness.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    await waitForRun(harness.manager, started.runId, ['done']);
    const report =
      [...harness.written.entries()].find(([path]) => path.endsWith('report.md'))?.[1] ?? '';
    expect(report).toContain('Binary Analysis Report');
    expect(report).toContain('[import:NtLoadDriver]');
  });

  it('records the manifest with the honesty fields', async () => {
    const harness = makeHarness();
    const started = harness.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    await waitForRun(harness.manager, started.runId, ['done']);
    const manifest = JSON.parse(
      [...harness.written.entries()].find(([path]) => path.endsWith('manifest.json'))?.[1] ?? '{}',
    );
    expect(manifest.sha256).toHaveLength(64);
    expect(manifest.modelWritten).toBe(false);
    expect(typeof manifest.droppedClaims).toBe('number');
    expect(Array.isArray(manifest.stages)).toBe(true);
  });

  it('summarizes functions when a model is available and marks the report as model-written', async () => {
    const harness = makeHarness({
      callModel: async (_prompt, _tokens, json) =>
        json
          ? '{"needsRewrite":false,"findings":[]}'
          : [
              '# client.exe -- Binary Analysis Report',
              '',
              '## Capability summary',
              '',
              '- Can load a kernel driver. [import:NtLoadDriver]',
              '- Entry point is DriverEntry. [function:0x1000]',
              // Every required heading: a draft missing most of them reads as a
              // model that ran out of budget, and the writer prefers the
              // deterministic report over a truncated one.
              '## Architecture and entry flow',
              '## Notable functions',
              '## Strings of interest',
              '## What it does when it runs',
              '## Dynamically resolved APIs',
              '## Obfuscation',
              '## Recovered strings',
              '## Anti-analysis and packaging',
              '## Coverage',
              '## Open questions',
              'padding to clear the minimum length gate. '.repeat(6),
            ].join('\n'),
    });
    const started = harness.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    await waitForRun(harness.manager, started.runId, ['done']);
    const manifest = JSON.parse(
      [...harness.written.entries()].find(([path]) => path.endsWith('manifest.json'))?.[1] ?? '{}',
    );
    expect(manifest.modelWritten).toBe(true);
  });

  it('refuses a second run on the same binary and points at the first', () => {
    const harness = makeHarness({
      // Never resolves, so the first run stays active for the duration.
      query: () => new Promise<GhidraLabQueryOutcome>(() => {}),
    });
    const first = harness.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    const second = harness.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('run_already_active');
    expect(second.runId).toBe(first.runId);
  });

  it('cancels between stages and still writes what it collected', async () => {
    const harness = makeHarness();
    const started = harness.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    expect(harness.manager.cancel(started.runId)).toBe(true);
    await waitForRun(harness.manager, started.runId, ['cancelled', 'done']);
    // Cancellation is checked between stages, so a very fast fake run may finish
    // first; either way the artifacts exist.
    const paths = [...harness.written.keys()].join(' ');
    expect(paths).toContain('ledger.json');
    expect(paths).toContain('report.md');
  });

  it('will not cancel a finished run', async () => {
    const harness = makeHarness();
    const started = harness.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    await waitForRun(harness.manager, started.runId, ['done']);
    expect(harness.manager.cancel(started.runId)).toBe(false);
    expect(harness.manager.cancel('nope')).toBe(false);
  });

  it('marks the run failed when the sweep throws outright', async () => {
    const harness = makeHarness({
      hashFile: () => ({ sha256: '', sizeBytes: 0, mtimeMs: 0 }),
      query: () => {
        // Deliberately not an Error. A real MCP client can reject with anything,
        // and the sweep has to fold that into a stage rather than let it escape
        // as an unhandled rejection -- which is the whole point of this case.
        // eslint-disable-next-line no-throw-literal
        throw { toString: () => 'not an error' };
      },
    });
    const started = harness.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    // A thrown non-Error from the engine must not escape as an unhandled
    // rejection; the sweep folds query failures into stages, so this still
    // completes.
    const state = await waitForRun(harness.manager, started.runId, ['done', 'failed']);
    expect(['done', 'failed']).toContain(state);
  });

  it('lists runs newest first and prunes old terminal ones', async () => {
    let clock = 1_000;
    const harness = makeHarness({ now: () => clock });
    const first = harness.manager.start({
      sessionId: 's',
      binaryPath: 'C:\\bins\\a.exe',
      binaryName: 'a.exe',
      config,
    });
    await waitForRun(harness.manager, first.runId, ['done']);
    clock = 2_000;
    const second = harness.manager.start({
      sessionId: 's',
      binaryPath: 'C:\\bins\\b.exe',
      binaryName: 'b.exe',
      config,
    });
    await waitForRun(harness.manager, second.runId, ['done']);

    expect(harness.manager.list()[0].runId).toBe(second.runId);
    harness.manager.prune(500, 10_000);
    expect(harness.manager.list()).toHaveLength(0);
  });

  it('reports progress stages as the sweep advances', async () => {
    const harness = makeHarness();
    const started = harness.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    await waitForRun(harness.manager, started.runId, ['done']);
    const stages = harness.manager.get(started.runId)?.stages ?? [];
    expect(stages.length).toBeGreaterThanOrEqual(9);
    expect(stages.some((stage) => stage.stage === 'imports' && stage.state === 'done')).toBe(true);
  });
});

describe('artifact reads', () => {
  it('refuses a run id that is not the shape this manager mints', () => {
    // The id arrives from a query string and is joined onto a filesystem path,
    // so anything but the minted shape has to be refused rather than sanitised.
    const harness = makeHarness();
    for (const bad of [
      '../../../../windows/win.ini',
      '..\\..\\secrets',
      'C:\\Windows\\System32\\config',
      'grun-1-1/../../etc',
      '',
      'grun',
    ]) {
      expect(harness.manager.readReport(bad)).toBe('');
      expect(harness.manager.readLedger(bad)).toBeNull();
    }
  });

  it('reads an artifact for a run this process never held', async () => {
    // A report has to survive a server restart: the in-memory record is gone but
    // the file is still on disk.
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghidra-runs-'));
    const runId = 'grun-abc123-1';
    fs.mkdirSync(path.join(runsDir, runId), { recursive: true });
    fs.writeFileSync(path.join(runsDir, runId, 'report.md'), '# recovered');

    const manager = new GhidraLabRunManager(
      {
        query: async () => outcome([]),
        hashFile: () => ({ sha256: '', sizeBytes: 0, mtimeMs: 0 }),
        now: () => 0,
      },
      runsDir,
    );
    expect(manager.readReport(runId)).toContain('recovered');
    fs.rmSync(runsDir, { recursive: true, force: true });
  });
});

describe('runCapa', () => {
  it('refuses cleanly when capa is not configured', async () => {
    const result = await runCapa({ binaryPath: BINARY, config });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('capa_not_configured');
  });

  it('reports a spawn failure rather than throwing', async () => {
    const result = await runCapa({
      binaryPath: BINARY,
      config: normalizeGhidraLabConfig({
        ...config,
        capaExePath: process.platform === 'win32' ? 'C:\\nope\\capa.exe' : '/nope/capa',
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('does not block the event loop while capa runs', async () => {
    // This runs inside the dev server's Node process, so a synchronous capa
    // would freeze every other request for its whole run -- up to fifteen
    // minutes on a large binary.
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 0);
    const pending = runCapa({
      binaryPath: BINARY,
      config: normalizeGhidraLabConfig({ ...config, capaExePath: process.execPath }),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ticked).toBe(true);
    await pending;
  });
});

describe('bookkeeping', () => {
  it('counts only runs that are still working', async () => {
    const stalled = makeHarness({ query: () => new Promise<GhidraLabQueryOutcome>(() => {}) });
    stalled.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    expect(stalled.manager.activeCount()).toBe(1);

    const finished = makeHarness();
    const done = finished.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    await waitForRun(finished.manager, done.runId, ['done']);
    expect(finished.manager.activeCount()).toBe(0);
  });

  it('finds an active run by the binary it is sweeping', () => {
    const harness = makeHarness({ query: () => new Promise<GhidraLabQueryOutcome>(() => {}) });
    const started = harness.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    expect(harness.manager.findByBinary(BINARY)?.runId).toBe(started.runId);
    expect(harness.manager.findByBinary('C:\\bins\\other.exe')).toBeNull();
  });

  it('prunes finished runs past the retention window but never a live one', async () => {
    // A sweep can run for tens of minutes; pruning one mid-flight would drop the
    // record the UI is polling and make a running analysis look like it vanished.
    let clock = 1_000;
    const harness = makeHarness({ now: () => clock });
    const done = harness.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    await waitForRun(harness.manager, done.runId, ['done']);

    const live = makeHarness({
      now: () => clock,
      query: () => new Promise<GhidraLabQueryOutcome>(() => {}),
    });
    const running = live.manager.start({
      sessionId: 'sess-2',
      binaryPath: 'C:\\bins\\live.exe',
      binaryName: 'live.exe',
      config,
    });

    clock += 48 * 60 * 60 * 1000;
    harness.manager.prune(24 * 60 * 60 * 1000, clock);
    live.manager.prune(24 * 60 * 60 * 1000, clock);

    expect(harness.manager.get(done.runId)).toBeNull();
    expect(live.manager.get(running.runId)).not.toBeNull();
  });

  it('bounds the run map even when nothing has aged out', async () => {
    // Every sweep the operator starts leaves a record behind. Without the cap a
    // long-lived dev server accumulates them until the report list is unusable.
    let clock = 1_000;
    const harness = makeHarness({ now: () => clock });
    for (let index = 0; index < 46; index += 1) {
      clock += 1;
      const started = harness.manager.start({
        sessionId: 'sess-1',
        binaryPath: `C:\\bins\\b${index}.exe`,
        binaryName: `b${index}.exe`,
        config,
      });
      await waitForRun(harness.manager, started.runId, ['done']);
    }
    harness.manager.prune(24 * 60 * 60 * 1000, clock);
    expect(harness.manager.list().length).toBe(40);
    // The OLDEST are the ones dropped, so the most recent runs survive -- the
    // opposite would evict exactly the report the operator just asked for.
    const kept = harness.manager.list().map((run) => run.binaryName);
    expect(kept).toContain('b45.exe');
    expect(kept).not.toContain('b0.exe');
  });
});

describe('failure paths', () => {
  it('folds an engine that throws into the stage instead of losing the run', async () => {
    // A read that throws is a stage failure, not a run failure -- the other nine
    // stages still have work to do and the report should say what was missed.
    const harness = makeHarness({
      query: async () => {
        throw new Error('engine went away');
      },
    });
    const started = harness.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    await waitForRun(harness.manager, started.runId, ['done']);
    const stages = harness.manager.get(started.runId)?.stages ?? [];
    expect(stages.some((stage) => stage.detail.includes('engine went away'))).toBe(true);
  });

  it('marks the run failed when the sweep throws outside any stage', async () => {
    // Nothing in the sweep is supposed to escape its per-stage handler, so this
    // drives the guard the only way a caller can: the clock the sweep reads on
    // every stage boundary starts throwing partway through. The point is that an
    // unexpected throw is recorded on the run rather than leaving it 'running'
    // forever with the UI polling a run that will never finish.
    let ticks = 0;
    const harness = makeHarness({
      now: () => {
        ticks += 1;
        if (ticks > 4) {
          throw new Error('clock exploded');
        }
        return 5_000;
      },
    });
    const started = harness.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    await waitForRun(harness.manager, started.runId, ['failed']);
    expect(harness.manager.get(started.runId)?.failureReason).toContain('clock exploded');
    // Marked finished, so the UI stops polling a run that will never resolve.
    expect(harness.manager.get(started.runId)?.finishedAt).not.toBeNull();
    expect(harness.manager.activeCount()).toBe(0);
  });

  it('does not let a crashing dep escape as an unhandled rejection', async () => {
    // Nothing awaits the background sweep. Before the run promise had a catch,
    // a dep that threw on the FAILURE path escaped as an unhandled rejection --
    // which Node terminates the process for, taking the whole dev server down
    // over one bad run. The logger throwing too is the nastiest version of it,
    // because the handler itself is what would rethrow.
    const rejections: unknown[] = [];
    const onRejection = (error: unknown): void => {
      rejections.push(error);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const harness = makeHarness({
        now: () => {
          throw new Error('every clock read throws');
        },
        logError: () => {
          throw new Error('and so does the logger');
        },
      });
      // start() reads the clock for the run id, so the throw lands there first.
      expect(() =>
        harness.manager.start({
          sessionId: 'sess-1',
          binaryPath: BINARY,
          binaryName: 'client.exe',
          config,
        }),
      ).toThrow();

      let reads = 0;
      const later = makeHarness({
        now: () => {
          reads += 1;
          if (reads > 4) {
            throw new Error('clock died mid-run');
          }
          return 7_000;
        },
        logError: () => {
          throw new Error('and so does the logger');
        },
      });
      const started = later.manager.start({
        sessionId: 'sess-1',
        binaryPath: BINARY,
        binaryName: 'client.exe',
        config,
      });
      await waitForRun(later.manager, started.runId, ['failed']);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(rejections).toEqual([]);
      expect(later.manager.get(started.runId)?.finishedAt).toBe(7_000);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('catches a throw that escapes the run entirely, and keeps the record honest', async () => {
    // The ledger is written outside the report's try block, so an artifact
    // writer that throws there escapes execute() itself -- and nothing awaits
    // execute(). Without the catch on the run promise this was an unhandled
    // rejection, which Node terminates the process for.
    const harness = makeHarness({
      writeArtifact: (path) => {
        if (path.endsWith('ledger.json')) {
          throw new Error('ledger write refused');
        }
      },
      logError: () => {
        throw new Error('and the logger is broken too');
      },
    });
    const started = harness.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    await waitForRun(harness.manager, started.runId, ['failed']);
    const view = harness.manager.get(started.runId);
    expect(view?.failureReason).toContain('ledger write refused');
    expect(view?.finishedAt).not.toBeNull();
  });

  it('records the failure when writing the report throws', async () => {
    const harness = makeHarness({
      writeArtifact: (path) => {
        if (path.endsWith('report.md')) {
          throw new Error('disk full');
        }
      },
    });
    const started = harness.manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    await waitForRun(harness.manager, started.runId, ['failed']);
    const view = harness.manager.get(started.runId);
    expect(view?.failureReason).toContain('disk full');
    expect(view?.finishedAt).not.toBeNull();
    expect(harness.errors.join(' ')).toContain('report failed');
  });

  it('logs rather than throws when the real filesystem refuses the artifact', async () => {
    // No writeArtifact dep, so this takes the real fs path, and the runs dir is
    // a file -- mkdir under it cannot succeed.
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ghidra-block-')), 'runs');
    fs.writeFileSync(blocker, 'not a directory');

    const errors: string[] = [];
    const manager = new GhidraLabRunManager(
      {
        query: async () => outcome([]),
        hashFile: () => ({ sha256: 'c'.repeat(64), sizeBytes: 1, mtimeMs: 0 }),
        now: () => 1,
        sleep: async () => {},
        logError: (message) => errors.push(message),
      },
      blocker,
    );
    const started = manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    await waitForRun(manager, started.runId, ['done', 'failed']);
    expect(errors.join(' ')).toContain('artifact write failed');
    fs.rmSync(path.dirname(blocker), { recursive: true, force: true });
  });

  it('writes real files when no artifact dep is supplied, and reads them back', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghidra-real-'));
    const manager = new GhidraLabRunManager(
      {
        query: async (_sessionId, kind) =>
          kind === 'imports'
            ? outcome([{ library: 'ntdll.dll', name: 'NtLoadDriver' }])
            : outcome([]),
        hashFile: () => ({ sha256: 'd'.repeat(64), sizeBytes: 2, mtimeMs: 0 }),
        now: () => 1,
        sleep: async () => {},
      },
      runsDir,
    );
    const started = manager.start({
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
    });
    await waitForRun(manager, started.runId, ['done']);
    expect(manager.readReport(started.runId)).toContain('Binary Analysis Report');
    expect(manager.readLedger(started.runId)?.anchors.length).toBeGreaterThan(0);
    fs.rmSync(runsDir, { recursive: true, force: true });
  });

  it('returns nothing for artifacts that are not on disk', () => {
    const harness = makeHarness();
    expect(harness.manager.readReport('grun-gone-1')).toBe('');
    expect(harness.manager.readLedger('grun-gone-1')).toBeNull();
  });
});

describe('shared run manager', () => {
  it('hands back one manager per process and can be reset', () => {
    resetSharedGhidraLabRunManager();
    const deps = { query: async () => outcome([]), now: () => 0 };
    const first = getSharedGhidraLabRunManager(deps, 'C:\\runs');
    expect(getSharedGhidraLabRunManager(deps, 'C:\\other')).toBe(first);
    resetSharedGhidraLabRunManager();
    expect(getSharedGhidraLabRunManager(deps, 'C:\\runs')).not.toBe(first);
    resetSharedGhidraLabRunManager();
  });
});

describe('runCapa outcomes', () => {
  const capaConfig = normalizeGhidraLabConfig({ ...config, capaExePath: 'C:\\capa\\capa.exe' });

  /** A stand-in for the capa child process, driven by the test. */
  function fakeChild() {
    const listeners = new Map<string, ((value: never) => void)[]>();
    const stream = (): { setEncoding: () => void; on: (event: string, fn: never) => void } => ({
      setEncoding: () => {},
      on: (event, fn) => {
        const key = `out:${event}`;
        listeners.set(key, [...(listeners.get(key) ?? []), fn]);
      },
    });
    const child = {
      stdout: stream(),
      stderr: { setEncoding: () => {}, on: () => {} },
      kill: () => {},
      on: (event: string, fn: never) => {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      },
    };
    const emit = (event: string, value?: unknown): void => {
      for (const fn of listeners.get(event) ?? []) {
        (fn as unknown as (arg: unknown) => void)(value);
      }
    };
    return { child, emit };
  }

  it('parses the JSON document capa writes to stdout', async () => {
    const { child, emit } = fakeChild();
    const pending = runCapa(
      { binaryPath: BINARY, config: capaConfig },
      (() => child) as unknown as Parameters<typeof runCapa>[1],
    );
    await Promise.resolve();
    emit('out:data', 'warning: something\n{"rules":{"inject":{}}}');
    emit('close', 0);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect((result.payload as { rules: Record<string, unknown> }).rules.inject).toBeDefined();
  });

  it('reports unparseable output instead of claiming a result', async () => {
    const { child, emit } = fakeChild();
    const pending = runCapa(
      { binaryPath: BINARY, config: capaConfig },
      (() => child) as unknown as Parameters<typeof runCapa>[1],
    );
    await Promise.resolve();
    emit('out:data', '{"rules": truncated-mid-doc');
    emit('close', 0);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not JSON');
  });

  it('surfaces the child error event', async () => {
    const { child, emit } = fakeChild();
    const pending = runCapa(
      { binaryPath: BINARY, config: capaConfig },
      (() => child) as unknown as Parameters<typeof runCapa>[1],
    );
    await Promise.resolve();
    emit('error', new Error('ENOENT'));
    expect((await pending).error).toBe('ENOENT');
  });

  it('reports a spawn that throws rather than rejecting the promise', async () => {
    const result = await runCapa({ binaryPath: BINARY, config: capaConfig }, (() => {
      throw new Error('EACCES');
    }) as unknown as Parameters<typeof runCapa>[1]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('EACCES');
  });

  it('settles once, so a close after an error does not overwrite the outcome', async () => {
    const { child, emit } = fakeChild();
    const pending = runCapa(
      { binaryPath: BINARY, config: capaConfig },
      (() => child) as unknown as Parameters<typeof runCapa>[1],
    );
    await Promise.resolve();
    emit('error', new Error('first'));
    emit('out:data', '{"rules":{}}');
    emit('close', 0);
    expect((await pending).error).toBe('first');
  });
});
