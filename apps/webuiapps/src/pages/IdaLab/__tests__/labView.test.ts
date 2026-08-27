import { describe, expect, it } from 'vitest';
import {
  buildBreadcrumbs,
  describeHealth,
  explainLabError,
  formatBytes,
  grantRemainingLabel,
  isSessionQueryable,
  sessionStateLabel,
  sortBrowseEntries,
} from '../labView';
import type { IdaSqlHealthView, IdaSqlSessionView } from '@/lib/idaSqlTypes';

const ROOTS = [{ id: 'bins', path: 'F:\\games', label: 'Games' }];

function makeHealth(overrides: Partial<IdaSqlHealthView> = {}): IdaSqlHealthView {
  return {
    configured: true,
    config: {
      idaExePath: 'C:\\ida\\ida.exe',
      idasqlExePath: 'C:\\ida\\idasql.exe',
      defaultMode: 'headless',
      binaryRoots: ROOTS,
      httpPortStart: 8300,
      httpPortEnd: 8399,
      sessionIdleTimeoutMs: 1_800_000,
      writeEnabled: false,
    },
    idasqlPresent: true,
    idasqlVersion: 'idasql 1.2',
    idaExePresent: true,
    idaDirectory: 'C:\\ida',
    idaEnginePresent: true,
    idaSqlPluginPath: '',
    idalibPresent: true,
    analysisCapabilityEnabled: true,
    writeCapabilityEnabled: false,
    autoSessionCapabilityEnabled: false,
    globalPanic: false,
    problems: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<IdaSqlSessionView> = {}): IdaSqlSessionView {
  return {
    id: 'ida-1',
    binaryPath: 'F:\\games\\client.exe',
    binaryName: 'client.exe',
    mode: 'headless',
    write: false,
    state: 'ready',
    port: 8300,
    pid: 1,
    startedAt: 0,
    readyAt: 1,
    lastUsedAt: 1,
    queryCount: 0,
    failureReason: '',
    unreviewedFunctions: [],
    progress: null,
    ...overrides,
  };
}

describe('formatBytes', () => {
  it('scales into readable units and rejects nonsense', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1024 * 40)).toBe('40 KB');
    expect(formatBytes(1024 * 1024 * 3.5)).toBe('3.5 MB');
    expect(formatBytes(0)).toBe('-');
    expect(formatBytes(Number.NaN)).toBe('-');
  });
});

describe('describeHealth', () => {
  it('reports ready with the probed version', () => {
    expect(describeHealth(makeHealth())).toEqual({
      tone: 'ok',
      text: 'Ready (idasql 1.2)',
      action: '',
    });
  });

  it('ranks panic above every other problem', () => {
    const status = describeHealth(
      makeHealth({ globalPanic: true, analysisCapabilityEnabled: false, idasqlPresent: false }),
    );
    expect(status.tone).toBe('error');
    expect(status.text).toContain('panic');
  });

  it('ranks a missing capability above a missing path', () => {
    const status = describeHealth(
      makeHealth({ analysisCapabilityEnabled: false, idasqlPresent: false }),
    );
    expect(status.text).toContain('capability');
    expect(status.action).toContain('Settings');
  });

  it('names the empty root list, since nothing can be analyzed without one', () => {
    const health = makeHealth();
    const status = describeHealth({
      ...health,
      config: { ...health.config, binaryRoots: [] },
    });
    expect(status.tone).toBe('warn');
    expect(status.text).toContain('binary roots');
  });

  it('warns when idalib is missing, because headless mode needs it', () => {
    const status = describeHealth(makeHealth({ idalibPresent: false }));
    expect(status.text).toContain('idalib');
  });

  it('is idle before anything loads', () => {
    expect(describeHealth(null).tone).toBe('idle');
  });
});

describe('sessionStateLabel', () => {
  it('says analyzing for a starting headless session', () => {
    expect(sessionStateLabel(makeSession({ state: 'starting' }))).toBe('analyzing');
  });

  it('says attaching for a starting gui session', () => {
    expect(sessionStateLabel(makeSession({ state: 'starting', mode: 'gui' }))).toBe('attaching');
  });

  it('carries the failure reason so a failure is not silent', () => {
    expect(
      sessionStateLabel(makeSession({ state: 'failed', failureReason: 'ready_timeout' })),
    ).toBe('failed (ready_timeout)');
  });
});

describe('isSessionQueryable', () => {
  it('is true only for a ready session', () => {
    expect(isSessionQueryable(makeSession())).toBe(true);
    expect(isSessionQueryable(makeSession({ state: 'starting' }))).toBe(false);
    expect(isSessionQueryable(null)).toBe(false);
  });
});

describe('buildBreadcrumbs', () => {
  it('starts at the containing root and never above it', () => {
    const crumbs = buildBreadcrumbs('F:\\games\\client\\bin', ROOTS);
    expect(crumbs.map((crumb) => crumb.label)).toEqual(['Games', 'client', 'bin']);
    expect(crumbs[0].path).toBe('F:\\games');
    expect(crumbs[2].path).toBe('F:\\games\\client\\bin');
  });

  it('picks the deepest matching root', () => {
    const crumbs = buildBreadcrumbs('F:\\games\\client\\x', [
      ...ROOTS,
      { id: 'client', path: 'F:\\games\\client', label: 'Client' },
    ]);
    expect(crumbs[0].label).toBe('Client');
  });

  it('returns nothing for the root listing', () => {
    expect(buildBreadcrumbs('', ROOTS)).toEqual([]);
  });

  it('degrades to a single crumb when no root matches', () => {
    expect(buildBreadcrumbs('D:\\elsewhere', ROOTS)).toEqual([
      { label: 'D:\\elsewhere', path: 'D:\\elsewhere' },
    ]);
  });
});

describe('sortBrowseEntries', () => {
  it('puts folders first, then analyzable files, then the rest', () => {
    const sorted = sortBrowseEntries([
      { name: 'notes.txt', path: 'p1', kind: 'file', sizeBytes: 1, analyzable: false },
      { name: 'client.exe', path: 'p2', kind: 'file', sizeBytes: 2, analyzable: true },
      { name: 'sub', path: 'p3', kind: 'directory', sizeBytes: 0, analyzable: false },
    ]);
    expect(sorted.map((entry) => entry.name)).toEqual(['sub', 'client.exe', 'notes.txt']);
  });
});

describe('grantRemainingLabel', () => {
  it('reports time left and remaining quota', () => {
    const label = grantRemainingLabel(
      {
        id: 'g',
        rootId: 'bins',
        label: 'Games',
        createdAt: 0,
        expiresAt: 90 * 60 * 1000,
        maxSessions: 3,
        usedSessions: 1,
      },
      0,
    );
    expect(label).toBe('1h 30m, 2/3 left');
  });

  it('says expired once past the expiry', () => {
    expect(
      grantRemainingLabel(
        {
          id: 'g',
          rootId: 'bins',
          label: 'Games',
          createdAt: 0,
          expiresAt: 10,
          maxSessions: 3,
          usedSessions: 0,
        },
        20,
      ),
    ).toBe('expired');
  });
});

describe('explainLabError', () => {
  it('appends the fix for a code the operator can act on', () => {
    expect(explainLabError(new Error('capability_disabled'))).toContain('Settings');
    expect(explainLabError(new Error('path_outside_roots'))).toContain('binary roots');
    expect(explainLabError(new Error('session_is_read_only'))).toContain('write session');
    expect(explainLabError(new Error('no_gui_server_found'))).toContain('.http start');
  });

  it('passes an unknown message through unchanged', () => {
    expect(explainLabError(new Error('boom'))).toBe('boom');
  });

  it('stringifies a thrown non-Error', () => {
    expect(explainLabError('no_binary_roots')).toContain('binary roots');
    expect(explainLabError(42)).toBe('42');
  });

  it('distinguishes a token-protected GUI server from no server at all', () => {
    // Verified against idasql v0.0.18.1: /status answers 401 without a token, so
    // "nothing there" and "wants a token" are different problems.
    expect(explainLabError(new Error('gui_server_requires_token'))).toContain('wants a token');
    expect(explainLabError(new Error('no_gui_server_found'))).toContain('.http start');
  });

  it('explains a write refusal from either half of the gate', () => {
    expect(explainLabError(new Error('write_capability_disabled'))).toContain('os_ida_write');
    expect(explainLabError(new Error('write_not_enabled_in_settings'))).toContain('Setup toggle');
  });
});

describe('view helper edges', () => {
  it('scales past megabytes', () => {
    expect(formatBytes(1024 ** 3 * 2)).toBe('2.0 GB');
    expect(formatBytes(1024 ** 4)).toBe('1024 GB');
  });

  it('reports a failure with no reason as plain failed', () => {
    expect(sessionStateLabel(makeSession({ state: 'failed' }))).toBe('failed');
  });

  it('passes stopped through unchanged', () => {
    expect(sessionStateLabel(makeSession({ state: 'stopped' }))).toBe('stopped');
  });

  it('warns about a missing idasql path before probing for the binary', () => {
    const health = makeHealth();
    const status = describeHealth({
      ...health,
      config: { ...health.config, idasqlExePath: '' },
    });
    expect(status.tone).toBe('warn');
    expect(status.text).toContain('idasql path');
  });

  it('warns when idasql is configured but absent from disk', () => {
    const status = describeHealth(makeHealth({ idasqlPresent: false }));
    expect(status.text).toContain('was not found');
    expect(status.action).toContain('release');
  });

  it('reports ready without a version when the probe returned nothing', () => {
    expect(describeHealth(makeHealth({ idasqlVersion: '' })).text).toBe('Ready');
  });

  it('normalizes a trailing separator on the current path', () => {
    const crumbs = buildBreadcrumbs('F:\\games\\', ROOTS);
    expect(crumbs.map((crumb) => crumb.label)).toEqual(['Games']);
  });

  it('handles posix separators', () => {
    const crumbs = buildBreadcrumbs('/srv/bins/game', [
      { id: 'bins', path: '/srv/bins', label: 'Bins' },
    ]);
    expect(crumbs.map((crumb) => crumb.label)).toEqual(['Bins', 'game']);
    expect(crumbs[1].path).toBe('/srv/bins/game');
  });

  it('reports minutes for a grant under an hour', () => {
    expect(
      grantRemainingLabel(
        {
          id: 'g',
          rootId: 'bins',
          label: 'Games',
          createdAt: 0,
          expiresAt: 30 * 60 * 1000,
          maxSessions: 3,
          usedSessions: 3,
        },
        0,
      ),
    ).toBe('30m, 0/3 left');
  });

  it('keeps alphabetical order within a kind', () => {
    const sorted = sortBrowseEntries([
      { name: 'b.exe', path: 'p1', kind: 'file', sizeBytes: 1, analyzable: true },
      { name: 'a.exe', path: 'p2', kind: 'file', sizeBytes: 1, analyzable: true },
      { name: 'z', path: 'p3', kind: 'directory', sizeBytes: 0, analyzable: false },
      { name: 'y', path: 'p4', kind: 'directory', sizeBytes: 0, analyzable: false },
    ]);
    expect(sorted.map((entry) => entry.name)).toEqual(['y', 'z', 'a.exe', 'b.exe']);
  });

  it('is queryable only in the ready state', () => {
    expect(isSessionQueryable(makeSession({ state: 'failed' }))).toBe(false);
    expect(isSessionQueryable(makeSession({ state: 'stopped' }))).toBe(false);
  });
});
