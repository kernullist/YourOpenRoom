import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IDA_SQL_CONFIG,
  IDA_SQL_DEFAULT_PORT_END,
  IDA_SQL_DEFAULT_PORT_START,
  buildIdaGuiArgs,
  buildIdaSqlHeadlessArgs,
  isPathWithinRoot,
  listIdaSqlConfigProblems,
  mergeIdaSqlConfig,
  normalizeIdaSqlConfig,
  resolveIdaDirectory,
  resolveIdaSqlPathWithinRoots,
  toStoredIdaSqlConfig,
} from '../idaSqlConfig';
import type { IdaSqlBinaryRoot } from '../idaSqlTypes';

const WIN_ROOTS: IdaSqlBinaryRoot[] = [
  { id: 'games', path: 'F:\\games', label: 'Games' },
  { id: 'samples', path: 'F:\\samples', label: 'Samples' },
];

describe('normalizeIdaSqlConfig', () => {
  it('returns complete defaults for junk input', () => {
    for (const raw of [null, undefined, 42, 'x', []]) {
      expect(normalizeIdaSqlConfig(raw)).toEqual({ ...DEFAULT_IDA_SQL_CONFIG, binaryRoots: [] });
    }
  });

  it('drops a relative executable path rather than accepting it', () => {
    expect(normalizeIdaSqlConfig({ idasqlExePath: 'idasql.exe' }).idasqlExePath).toBe('');
  });

  it('drops a path carrying shell metacharacters', () => {
    expect(
      normalizeIdaSqlConfig({ idasqlExePath: 'C:\\ida\\idasql.exe & calc' }).idasqlExePath,
    ).toBe('');
  });

  it('drops roots with an invalid id or a relative path, and dedupes by id', () => {
    const config = normalizeIdaSqlConfig({
      binaryRoots: [
        { id: 'Games', path: 'F:\\games', label: 'Games' },
        { id: 'games', path: 'F:\\other', label: 'Dup' },
        { id: 'bad id!', path: 'F:\\x' },
        { id: 'rel', path: 'games' },
      ],
    });
    expect(config.binaryRoots).toHaveLength(1);
    expect(config.binaryRoots[0].id).toBe('games');
  });

  it('clamps the idle timeout into range', () => {
    expect(normalizeIdaSqlConfig({ sessionIdleTimeoutMs: 5 }).sessionIdleTimeoutMs).toBe(60_000);
    expect(normalizeIdaSqlConfig({ sessionIdleTimeoutMs: 999_999_999 }).sessionIdleTimeoutMs).toBe(
      8 * 60 * 60 * 1000,
    );
  });

  it('swaps a reversed port window instead of allocating nothing', () => {
    const config = normalizeIdaSqlConfig({ httpPortStart: 8400, httpPortEnd: 8300 });
    expect(config.httpPortStart).toBe(8300);
    expect(config.httpPortEnd).toBe(8400);
  });

  it('falls back to the default window for out-of-range ports', () => {
    const config = normalizeIdaSqlConfig({ httpPortStart: 80, httpPortEnd: 70000 });
    expect(config.httpPortStart).toBe(IDA_SQL_DEFAULT_PORT_START);
    expect(config.httpPortEnd).toBe(IDA_SQL_DEFAULT_PORT_END);
  });

  it('drops an absurdly long path instead of storing it', () => {
    const long = `C:\\${'a'.repeat(1100)}\\idasql.exe`;
    expect(normalizeIdaSqlConfig({ idasqlExePath: long }).idasqlExePath).toBe('');
    expect(resolveIdaSqlPathWithinRoots(long, WIN_ROOTS, true).reason).toBe('path_too_long');
  });

  it('caps the number of binary roots', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: `root${index}`,
      path: `F:\\dir${index}`,
      label: `Root ${index}`,
    }));
    // The operator-visible consequence is that a root beyond the cap silently
    // disappears, which is why the app checks its root landed after saving.
    expect(normalizeIdaSqlConfig({ binaryRoots: many }).binaryRoots).toHaveLength(16);
  });

  it('refuses containment checks against an empty candidate or root', () => {
    expect(isPathWithinRoot('', 'F:\\games', true)).toBe(false);
    expect(isPathWithinRoot('F:\\games\\a.exe', '', true)).toBe(false);
  });

  it('treats writeEnabled as opt-in only', () => {
    expect(normalizeIdaSqlConfig({ writeEnabled: 'yes' }).writeEnabled).toBe(false);
    expect(normalizeIdaSqlConfig({ writeEnabled: true }).writeEnabled).toBe(true);
  });
});

describe('mergeIdaSqlConfig', () => {
  it('keeps untouched fields and drops unknown keys', () => {
    const current = normalizeIdaSqlConfig({
      idasqlExePath: 'C:\\ida\\idasql.exe',
      binaryRoots: WIN_ROOTS,
      writeEnabled: true,
    });
    const next = mergeIdaSqlConfig(current, { writeEnabled: false, smuggled: 'x' });
    expect(next.idasqlExePath).toBe('C:\\ida\\idasql.exe');
    expect(next.binaryRoots).toHaveLength(2);
    expect(next.writeEnabled).toBe(false);
    expect(Object.keys(toStoredIdaSqlConfig(next))).not.toContain('smuggled');
  });

  it('ignores a non-object patch', () => {
    const current = normalizeIdaSqlConfig({ writeEnabled: true });
    expect(mergeIdaSqlConfig(current, null).writeEnabled).toBe(true);
  });
});

describe('resolveIdaDirectory', () => {
  it('takes the folder of idasql, which is where the engine lives', () => {
    const config = normalizeIdaSqlConfig({ idasqlExePath: 'C:\\Program Files\\IDA\\idasql.exe' });
    expect(resolveIdaDirectory(config)).toBe('C:\\Program Files\\IDA');
  });

  it('falls back to the ida.exe folder', () => {
    const config = normalizeIdaSqlConfig({ idaExePath: 'C:\\Program Files\\IDA\\ida.exe' });
    expect(resolveIdaDirectory(config)).toBe('C:\\Program Files\\IDA');
  });

  it('is empty when nothing is configured', () => {
    expect(resolveIdaDirectory(DEFAULT_IDA_SQL_CONFIG)).toBe('');
  });
});

describe('isPathWithinRoot', () => {
  it('accepts the root itself and anything under it', () => {
    expect(isPathWithinRoot('F:\\games', 'F:\\games', true)).toBe(true);
    expect(isPathWithinRoot('F:\\games\\a\\b.exe', 'F:\\games', true)).toBe(true);
  });

  it('rejects a sibling whose name merely starts the same', () => {
    expect(isPathWithinRoot('F:\\games-secret\\a.exe', 'F:\\games', true)).toBe(false);
  });

  it('honors case-insensitivity only when asked', () => {
    expect(isPathWithinRoot('f:\\GAMES\\a.exe', 'F:\\games', true)).toBe(true);
    expect(isPathWithinRoot('/home/GAMES/a', '/home/games', false)).toBe(false);
  });
});

describe('resolveIdaSqlPathWithinRoots', () => {
  it('resolves a path inside a root and reports which root', () => {
    const result = resolveIdaSqlPathWithinRoots('F:\\games\\client\\client.exe', WIN_ROOTS, true);
    expect(result.ok).toBe(true);
    expect(result.rootId).toBe('games');
  });

  it('refuses a traversal that climbs out of the root', () => {
    const result = resolveIdaSqlPathWithinRoots('F:\\games\\..\\secret\\x.exe', WIN_ROOTS, true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('path_outside_roots');
  });

  it('refuses when no roots are registered', () => {
    expect(resolveIdaSqlPathWithinRoots('F:\\games\\x.exe', [], true).reason).toBe(
      'no_binary_roots',
    );
  });

  it('refuses a relative path, an empty path, and shell metacharacters', () => {
    expect(resolveIdaSqlPathWithinRoots('games\\x.exe', WIN_ROOTS, true).reason).toBe(
      'path_not_absolute',
    );
    expect(resolveIdaSqlPathWithinRoots('', WIN_ROOTS, true).reason).toBe('missing_path');
    expect(resolveIdaSqlPathWithinRoots('F:\\games\\x.exe && calc', WIN_ROOTS, true).reason).toBe(
      'shell_metacharacters',
    );
  });
});

describe('argument vectors', () => {
  it('omits -w unless the session is a write session, and pins the bind address', () => {
    // --bind is explicit rather than left to a default: this server answers
    // arbitrary SQL against the operator's database and must stay on loopback.
    expect(buildIdaSqlHeadlessArgs({ binaryPath: 'F:\\a.exe', port: 8300, write: false })).toEqual([
      '-s',
      'F:\\a.exe',
      '--http',
      '8300',
      '--bind',
      '127.0.0.1',
    ]);
  });

  it('appends -w for a write session', () => {
    expect(buildIdaSqlHeadlessArgs({ binaryPath: 'F:\\a.exe', port: 8301, write: true })).toContain(
      '-w',
    );
  });

  it('passes the bearer token when one is given', () => {
    // Without --token the HTTP server answers ANY local caller; verified against
    // idasql v0.0.18.1, which returns 401 once a token is set.
    const args = buildIdaSqlHeadlessArgs({
      binaryPath: 'F:\\a.exe',
      port: 8302,
      write: false,
      token: 'deadbeef',
    });
    expect(args).toContain('--token');
    expect(args[args.indexOf('--token') + 1]).toBe('deadbeef');
  });

  it('passes just the binary to the GUI', () => {
    expect(buildIdaGuiArgs({ binaryPath: 'F:\\a.exe' })).toEqual(['F:\\a.exe']);
  });
});

describe('listIdaSqlConfigProblems', () => {
  it('reports the missing idasql path and the empty root list', () => {
    const problems = listIdaSqlConfigProblems(DEFAULT_IDA_SQL_CONFIG, 'headless').map(
      (problem) => problem.code,
    );
    expect(problems).toContain('idasql_path_missing');
    expect(problems).toContain('no_binary_roots');
  });

  it('only demands ida.exe for GUI mode', () => {
    const config = normalizeIdaSqlConfig({
      idasqlExePath: 'C:\\ida\\idasql.exe',
      binaryRoots: WIN_ROOTS,
    });
    expect(listIdaSqlConfigProblems(config, 'headless')).toHaveLength(0);
    expect(listIdaSqlConfigProblems(config, 'gui').map((problem) => problem.code)).toEqual([
      'ida_path_missing',
    ]);
  });
});
