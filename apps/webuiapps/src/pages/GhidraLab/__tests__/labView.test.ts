import { describe, expect, it } from 'vitest';

import {
  buildBreadcrumbs,
  createLatestOnlyGate,
  describeHealth,
  describeProgress,
  explainLabError,
  formatBytes,
  formatElapsed,
  isRunActive,
  preflightTone,
  runStateLabel,
  isSessionQueryable,
  sessionStateLabel,
  sortBrowseEntries,
  summarizeRunStages,
} from '../labView';
import type {
  GhidraLabHealthView,
  GhidraLabPreflightCheck,
  GhidraLabSessionView,
  GhidraReportRunView,
  GhidraSweepStageView,
} from '@/lib/ghidraLabTypes';

function check(patch: Partial<GhidraLabPreflightCheck>): GhidraLabPreflightCheck {
  return {
    id: 'jdk',
    label: 'JDK 21+',
    ok: true,
    found: 'Java 21',
    remedy: '',
    required: true,
    ...patch,
  };
}

function health(patch: Partial<GhidraLabHealthView> = {}): GhidraLabHealthView {
  return {
    configured: true,
    config: {
      ghidraInstallDir: '',
      jdkHome: '',
      pythonExePath: '',
      projectRoot: '',
      maxMemMb: 4096,
      binaryRoots: [],
      httpPortStart: 8500,
      httpPortEnd: 8599,
      sessionIdleTimeoutMs: 0,
      analysisTimeoutMs: 0,
      capaExePath: '',
      flossExePath: '',
      symbolDownloads: false,
      writeEnabled: false,
    },
    checks: [check({})],
    availableModes: ['headless', 'batch'],
    ghidraVersion: '12.1.3',
    jdkVersion: 'openjdk version "21.0.4"',
    jdkMajor: 21,
    pyghidraMcpVersion: '0.5.0',
    capaVersion: '',
    analysisCapabilityEnabled: true,
    writeCapabilityEnabled: false,
    autoSessionCapabilityEnabled: false,
    globalPanic: false,
    problems: [],
    ...patch,
  };
}

function session(patch: Partial<GhidraLabSessionView> = {}): GhidraLabSessionView {
  return {
    id: 's1',
    binaryPath: 'C:\\bins\\client.exe',
    binaryName: 'client.exe',
    projectName: 'client',
    mode: 'headless',
    write: false,
    state: 'ready',
    port: 8500,
    pid: 1,
    startedAt: 1000,
    readyAt: 2000,
    lastUsedAt: 2000,
    queryCount: 0,
    failureReason: '',
    progress: null,
    ...patch,
  };
}

function stage(patch: Partial<GhidraSweepStageView>): GhidraSweepStageView {
  return {
    stage: 'identity',
    state: 'pending',
    startedAt: null,
    finishedAt: null,
    summary: '',
    detail: '',
    ...patch,
  };
}

describe('describeHealth', () => {
  it('is ok when everything passes', () => {
    expect(describeHealth(health()).tone).toBe('ok');
    expect(describeHealth(health()).label).toContain('12.1.3');
  });

  it('calls a configured-but-wrong JDK an error, not merely unconfigured', () => {
    // The distinction the whole feature turns on: a lab that LOOKS set up but
    // would hang is worse than one that is obviously blank.
    const status = describeHealth(
      health({
        checks: [
          check({ ok: false, found: 'Java 11 (openjdk version "11.0.14")', remedy: 'Use JDK 21.' }),
        ],
        availableModes: [],
      }),
    );
    expect(status.tone).toBe('error');
    expect(status.label).toContain('Java 11');
    expect(status.detail).toContain('JDK 21');
  });

  it('treats a blank setup as idle rather than broken', () => {
    const status = describeHealth(
      health({ checks: [check({ ok: false, found: 'not set' })], availableModes: [] }),
    );
    expect(status.tone).toBe('idle');
    expect(status.label).toBe('Setup needed');
  });

  it('flags a disabled capability and a global panic ahead of path problems', () => {
    expect(describeHealth(health({ analysisCapabilityEnabled: false })).tone).toBe('warn');
    expect(describeHealth(health({ globalPanic: true })).label).toBe('Panic');
  });

  it('says batch-only when Ghidra works but pyghidra-mcp does not', () => {
    const status = describeHealth(health({ availableModes: ['batch'] }));
    expect(status.tone).toBe('warn');
    expect(status.label).toBe('Batch only');
  });

  it('handles a null health without throwing', () => {
    expect(describeHealth(null).tone).toBe('idle');
  });
});

describe('preflightTone', () => {
  it('separates unset from wrong', () => {
    expect(preflightTone(check({}))).toBe('ok');
    expect(preflightTone(check({ ok: false, found: 'not set' }))).toBe('warn');
    expect(preflightTone(check({ ok: false, found: 'Java 11' }))).toBe('error');
    expect(preflightTone(check({ ok: false, found: 'not set', required: false }))).toBe('idle');
  });
});

describe('describeProgress', () => {
  it('says nothing for a session that is not starting', () => {
    expect(describeProgress(session(), 5000)).toBeNull();
  });

  it('blames the install while the engine is not answering', () => {
    const progress = describeProgress(
      session({
        state: 'starting',
        progress: { phase: 'jvm', projectBytes: 0, deltaBytes: 0, sampledAt: 0, sampleCount: 1 },
      }),
      61_000,
    );
    expect(progress?.headline).toContain('Booting the JVM');
    expect(progress?.detail).toContain('JDK path');
  });

  it('blames the binary once the engine is up', () => {
    const progress = describeProgress(
      session({
        state: 'starting',
        progress: {
          phase: 'analysis',
          projectBytes: 5 * 1024 * 1024,
          deltaBytes: 1024 * 1024,
          sampledAt: 0,
          sampleCount: 4,
        },
      }),
      61_000,
    );
    expect(progress?.headline).toContain('Analyzing');
    expect(progress?.detail).toContain('still analyzing');
    expect(progress?.detail).toContain('1.0 MB');
  });

  it('is honest when there is no sample yet', () => {
    const progress = describeProgress(session({ state: 'starting' }), 2000);
    expect(progress?.detail).toContain('Waiting for the engine');
  });
});

describe('run helpers', () => {
  it('labels every run state', () => {
    const states: GhidraReportRunView['state'][] = [
      'queued',
      'running',
      'drafting',
      'verifying',
      'done',
      'cancelled',
      'failed',
    ];
    for (const state of states) {
      expect(runStateLabel({ state } as GhidraReportRunView)).toBeTruthy();
    }
    expect(runStateLabel({ state: 'drafting' } as GhidraReportRunView)).toBe('Writing report');
  });

  it('counts a skipped stage as finished, not as outstanding work', () => {
    const summary = summarizeRunStages([
      stage({ stage: 'identity', state: 'done' }),
      stage({ stage: 'capability', state: 'skipped' }),
      stage({ stage: 'strings', state: 'failed' }),
      stage({ stage: 'deepread', state: 'running' }),
      stage({ stage: 'synthesis', state: 'pending' }),
    ]);
    expect(summary.total).toBe(5);
    expect(summary.done).toBe(3);
    expect(summary.current).toBe('deepread');
    expect(summary.failed).toEqual(['strings']);
  });

  it('knows which runs are still moving', () => {
    expect(isRunActive({ state: 'running' } as GhidraReportRunView)).toBe(true);
    expect(isRunActive({ state: 'drafting' } as GhidraReportRunView)).toBe(true);
    expect(isRunActive({ state: 'done' } as GhidraReportRunView)).toBe(false);
    expect(isRunActive({ state: 'cancelled' } as GhidraReportRunView)).toBe(false);
  });
});

describe('formatting', () => {
  it('formats bytes across magnitudes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  it('formats elapsed time', () => {
    expect(formatElapsed(5_000)).toBe('5s');
    expect(formatElapsed(90_000)).toBe('1m 30s');
    expect(formatElapsed(3_900_000)).toBe('1h 5m');
    expect(formatElapsed(-1)).toBe('0s');
  });

  it('labels session states', () => {
    expect(sessionStateLabel(session({ state: 'starting' }))).toBe('Starting');
    expect(sessionStateLabel(session({ state: 'ready' }))).toBe('Ready');
    expect(sessionStateLabel(session({ state: 'failed' }))).toBe('Failed');
    expect(sessionStateLabel(session({ state: 'stopped' }))).toBe('Stopped');
  });

  it('lets only a ready session be queried', () => {
    // The query box is enabled off this. A starting session would take the
    // request and fail it ten stages in; a null one is the first render.
    expect(isSessionQueryable(session({ state: 'ready' }))).toBe(true);
    for (const state of ['starting', 'failed', 'stopped'] as const) {
      expect(isSessionQueryable(session({ state }))).toBe(false);
    }
    expect(isSessionQueryable(null)).toBe(false);
  });
});

describe('browse helpers', () => {
  it('puts directories first, then analyzable files', () => {
    const sorted = sortBrowseEntries([
      { name: 'notes.txt', path: 'b', kind: 'file', sizeBytes: 1, analyzable: false },
      { name: 'client.exe', path: 'c', kind: 'file', sizeBytes: 1, analyzable: true },
      { name: 'sub', path: 'a', kind: 'directory', sizeBytes: 0, analyzable: false },
    ]);
    expect(sorted.map((entry) => entry.name)).toEqual(['sub', 'client.exe', 'notes.txt']);
  });

  it('falls back to name order inside a group', () => {
    const sorted = sortBrowseEntries([
      { name: 'zulu.exe', path: 'z', kind: 'file', sizeBytes: 1, analyzable: true },
      { name: 'alpha.exe', path: 'a', kind: 'file', sizeBytes: 1, analyzable: true },
    ]);
    expect(sorted.map((entry) => entry.name)).toEqual(['alpha.exe', 'zulu.exe']);
  });

  it('builds breadcrumbs relative to the containing root', () => {
    const crumbs = buildBreadcrumbs('C:\\bins\\game\\win64', [
      { id: 'bins', path: 'C:\\bins', label: 'Binaries' },
    ]);
    expect(crumbs.map((crumb) => crumb.label)).toEqual(['Binaries', 'game', 'win64']);
    expect(crumbs[2].path).toBe('C:\\bins\\game\\win64');
  });

  it('stops at the root itself, with or without a trailing separator', () => {
    const roots = [{ id: 'bins', path: 'C:\\bins', label: 'Binaries' }];
    expect(buildBreadcrumbs('C:\\bins', roots)).toEqual([{ label: 'Binaries', path: 'C:\\bins' }]);
    // A trailing separator leaves an empty segment, which must not become a crumb.
    expect(buildBreadcrumbs('C:\\bins\\game\\', roots).map((crumb) => crumb.label)).toEqual([
      'Binaries',
      'game',
    ]);
  });

  it('degrades to a single crumb for a path outside every root', () => {
    expect(buildBreadcrumbs('D:\\elsewhere', [{ id: 'b', path: 'C:\\bins', label: 'B' }])).toEqual([
      { label: 'D:\\elsewhere', path: 'D:\\elsewhere' },
    ]);
    expect(buildBreadcrumbs('', [])).toEqual([]);
  });
});

describe('explainLabError', () => {
  it('turns route codes into something an operator can act on', () => {
    expect(explainLabError(new Error('preflight_jdk'))).toContain('JDK');
    expect(explainLabError(new Error('headless_mode_unavailable'))).toContain('pyghidra-mcp');
    expect(explainLabError(new Error('path_outside_roots'))).toContain(
      'outside every registered root',
    );
    expect(explainLabError(new Error('too_many_sessions'))).toContain('JVM');
    expect(explainLabError(new Error('session_already_open'))).toContain('Reuse');
    expect(explainLabError(new Error('preflight_ghidra'))).toContain('not a Ghidra install');
    expect(explainLabError(new Error('preflight_projects'))).toContain('project folder');
    expect(explainLabError(new Error('preflight_roots'))).toContain('binary root');
    expect(explainLabError(new Error('no_binary_roots'))).toContain('binary root');
    expect(explainLabError(new Error('not_authenticated'))).toContain('token');
    expect(explainLabError(new Error('capability_disabled'))).toContain('os_ghidra_analysis');
    expect(explainLabError(new Error('os_ghidra_analysis'))).toContain('Settings');
  });

  it('passes an unrecognized message through rather than swallowing it', () => {
    expect(explainLabError(new Error('something specific happened'))).toBe(
      'something specific happened',
    );
    expect(explainLabError(null)).toContain('no error text');
  });
});

describe('createLatestOnlyGate', () => {
  it('lets only the newest request land', () => {
    // Two clicks race and the SLOWER one wins by arriving last, which is how a
    // report pane ends up showing run A's text under run B's id.
    const gate = createLatestOnlyGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isStale(first)).toBe(true);
    expect(gate.isStale(second)).toBe(false);
  });

  it('keeps a single request current until another starts', () => {
    const gate = createLatestOnlyGate();
    const ticket = gate.begin();
    expect(gate.isStale(ticket)).toBe(false);
    expect(gate.isStale(ticket)).toBe(false);
    gate.begin();
    expect(gate.isStale(ticket)).toBe(true);
  });

  it('gives each pane its own sequence', () => {
    const reports = createLatestOnlyGate();
    const browse = createLatestOnlyGate();
    const ticket = reports.begin();
    browse.begin();
    browse.begin();
    // Browsing elsewhere must not invalidate a report that is still current.
    expect(reports.isStale(ticket)).toBe(false);
  });
});
