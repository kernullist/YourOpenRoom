// @vitest-environment node
//
// Ghidra Lab config: normalization bounds, root containment, version parsing and
// the argument vectors. Nothing here touches a real Ghidra install -- these are
// the decisions made BEFORE anything is spawned, and they have to hold on a
// machine that has no Ghidra at all (which is the machine this was written on).
import { delimiter, isAbsolute, join } from 'path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GHIDRA_LAB_CONFIG,
  GHIDRA_LAB_DEFAULT_PORT_END,
  GHIDRA_LAB_DEFAULT_PORT_START,
  buildAnalyzeHeadlessCommand,
  buildGhidraChildEnv,
  buildPyghidraMcpCommand,
  deriveGhidraProjectName,
  findDottedPathElement,
  isCmdSafeArgument,
  isPathWithinRoot,
  mergeGhidraLabConfig,
  normalizeGhidraLabConfig,
  parseGhidraVersion,
  parseJavaMajorVersion,
  resolveAnalyzeHeadlessPath,
  resolveGhidraPathWithinRoots,
  resolveJavaExePath,
  toStoredGhidraLabConfig,
} from '../ghidraLabConfig';
import type { GhidraLabConfigView } from '../ghidraLabTypes';

const isWindows = process.platform === 'win32';

/** An absolute path that is absolute on whichever platform the suite runs on. */
function abs(...segments: string[]): string {
  return isWindows ? join('C:\\', ...segments) : join('/', ...segments);
}

function configWith(patch: Partial<GhidraLabConfigView>): GhidraLabConfigView {
  return { ...DEFAULT_GHIDRA_LAB_CONFIG, binaryRoots: [], ...patch };
}

describe('normalizeGhidraLabConfig', () => {
  it('returns a complete default view for junk input', () => {
    for (const junk of [null, undefined, 42, 'nope', []]) {
      const config = normalizeGhidraLabConfig(junk);
      expect(config.binaryRoots).toEqual([]);
      expect(config.httpPortStart).toBe(GHIDRA_LAB_DEFAULT_PORT_START);
      expect(config.httpPortEnd).toBe(GHIDRA_LAB_DEFAULT_PORT_END);
      expect(config.writeEnabled).toBe(false);
    }
  });

  it('drops relative paths and paths carrying shell metacharacters', () => {
    const config = normalizeGhidraLabConfig({
      ghidraInstallDir: 'relative/ghidra',
      jdkHome: `${abs('jdk21')} && calc.exe`,
      pythonExePath: abs('py', 'python.exe'),
    });
    expect(config.ghidraInstallDir).toBe('');
    expect(config.jdkHome).toBe('');
    expect(config.pythonExePath).toBe(abs('py', 'python.exe'));
  });

  it('keeps only well-formed, unique roots and caps how many', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: `root${index}`,
      path: abs('bins', `r${index}`),
      label: '',
    }));
    const config = normalizeGhidraLabConfig({
      binaryRoots: [
        { id: 'Good', path: abs('bins', 'good'), label: 'Good' },
        { id: 'good', path: abs('bins', 'dupe'), label: 'dupe' },
        { id: 'bad id!', path: abs('bins', 'bad'), label: '' },
        { id: 'relative', path: 'bins/rel', label: '' },
        ...many,
      ],
    });
    expect(config.binaryRoots.length).toBeLessThanOrEqual(16);
    // 'Good' lowercases to 'good'; the later duplicate is dropped, not merged.
    expect(config.binaryRoots[0]).toEqual({
      id: 'good',
      path: abs('bins', 'good'),
      label: 'Good',
    });
    expect(config.binaryRoots.some((root) => root.id === 'bad id!')).toBe(false);
    expect(config.binaryRoots.some((root) => root.id === 'relative')).toBe(false);
  });

  it('swaps a reversed port window instead of allocating nothing', () => {
    const config = normalizeGhidraLabConfig({ httpPortStart: 8599, httpPortEnd: 8500 });
    expect(config.httpPortStart).toBe(8500);
    expect(config.httpPortEnd).toBe(8599);
  });

  it('clamps memory and timeouts into their supported ranges', () => {
    const tiny = normalizeGhidraLabConfig({
      maxMemMb: 16,
      analysisTimeoutMs: 1000,
      sessionIdleTimeoutMs: 5,
    });
    expect(tiny.maxMemMb).toBe(1024);
    expect(tiny.analysisTimeoutMs).toBe(5 * 60 * 1000);
    expect(tiny.sessionIdleTimeoutMs).toBe(60 * 1000);

    const huge = normalizeGhidraLabConfig({
      maxMemMb: 1_000_000,
      analysisTimeoutMs: 99 * 60 * 60 * 1000,
    });
    expect(huge.maxMemMb).toBe(65536);
    expect(huge.analysisTimeoutMs).toBe(4 * 60 * 60 * 1000);
  });

  it('round-trips through the stored shape', () => {
    const config = normalizeGhidraLabConfig({
      ghidraInstallDir: abs('ghidra'),
      jdkHome: abs('jdk21'),
      binaryRoots: [{ id: 'games', path: abs('games'), label: 'Games' }],
      writeEnabled: true,
    });
    expect(normalizeGhidraLabConfig(toStoredGhidraLabConfig(config))).toEqual(config);
  });
});

describe('mergeGhidraLabConfig', () => {
  it('applies only known keys and leaves the rest alone', () => {
    const current = normalizeGhidraLabConfig({
      ghidraInstallDir: abs('ghidra'),
      jdkHome: abs('jdk11'),
    });
    const merged = mergeGhidraLabConfig(current, {
      jdkHome: abs('jdk21'),
      somethingElse: 'ignored',
      __proto__: { polluted: true },
    });
    expect(merged.jdkHome).toBe(abs('jdk21'));
    expect(merged.ghidraInstallDir).toBe(abs('ghidra'));
    expect((merged as unknown as Record<string, unknown>).somethingElse).toBeUndefined();
  });

  it('lets an explicit empty string clear a path', () => {
    const current = normalizeGhidraLabConfig({ capaExePath: abs('capa.exe') });
    expect(mergeGhidraLabConfig(current, { capaExePath: '' }).capaExePath).toBe('');
  });

  it('ignores a non-object patch', () => {
    const current = normalizeGhidraLabConfig({ jdkHome: abs('jdk21') });
    expect(mergeGhidraLabConfig(current, 'nope')).toEqual(current);
    expect(mergeGhidraLabConfig(current, null)).toEqual(current);
  });
});

describe('parseJavaMajorVersion', () => {
  it('reads every vendor shape that matters', () => {
    expect(parseJavaMajorVersion('openjdk version "21.0.4" 2024-07-16')).toBe(21);
    // The exact string this machine reports today -- the case that must fail the check.
    expect(parseJavaMajorVersion('openjdk version "11.0.14" 2022-01-18 LTS')).toBe(11);
    expect(parseJavaMajorVersion('java version "1.8.0_401"')).toBe(8);
    expect(parseJavaMajorVersion('openjdk version "23" 2024-09-17')).toBe(23);
  });

  it('returns 0 for anything it cannot read, rather than guessing', () => {
    expect(parseJavaMajorVersion('')).toBe(0);
    expect(parseJavaMajorVersion('command not found')).toBe(0);
    expect(parseJavaMajorVersion('version "not-a-number"')).toBe(0);
  });
});

describe('parseGhidraVersion', () => {
  it('finds application.version and ignores comments and other keys', () => {
    const text = [
      '# comment',
      'application.name=Ghidra',
      'application.version=12.1.3',
      'application.release.name=PUBLIC',
    ].join('\n');
    expect(parseGhidraVersion(text)).toBe('12.1.3');
  });

  it('returns empty for a file that is not Ghidra properties', () => {
    expect(parseGhidraVersion('')).toBe('');
    expect(parseGhidraVersion('hello world')).toBe('');
  });
});

describe('root containment', () => {
  const roots = [
    { id: 'games', path: abs('bins', 'games'), label: 'Games' },
    { id: 'drivers', path: abs('bins', 'drivers'), label: 'Drivers' },
  ];

  it('accepts a file inside a root and reports which root', () => {
    const result = resolveGhidraPathWithinRoots(abs('bins', 'games', 'client.exe'), roots);
    expect(result.ok).toBe(true);
    expect(result.rootId).toBe('games');
  });

  it('refuses paths outside every root', () => {
    const result = resolveGhidraPathWithinRoots(abs('windows', 'system32', 'cmd.exe'), roots);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('path_outside_roots');
  });

  it('refuses a traversal that climbs out of a root', () => {
    const escape = join(abs('bins', 'games'), '..', '..', 'secret.exe');
    expect(resolveGhidraPathWithinRoots(escape, roots).ok).toBe(false);
  });

  it('fails closed when no roots are registered', () => {
    expect(resolveGhidraPathWithinRoots(abs('bins', 'games', 'client.exe'), []).reason).toBe(
      'no_binary_roots',
    );
  });

  it('refuses relative paths and shell metacharacters before touching roots', () => {
    expect(resolveGhidraPathWithinRoots('client.exe', roots).reason).toBe('path_not_absolute');
    expect(resolveGhidraPathWithinRoots(`${abs('bins')} | calc`, roots).reason).toBe(
      'shell_metacharacters',
    );
    expect(resolveGhidraPathWithinRoots('', roots).reason).toBe('missing_path');
  });

  it('does not treat a sibling with a shared prefix as inside the root', () => {
    expect(isPathWithinRoot(abs('bins', 'games-old', 'x.exe'), abs('bins', 'games'), true)).toBe(
      false,
    );
    expect(isPathWithinRoot(abs('bins', 'games'), abs('bins', 'games'), true)).toBe(true);
  });
});

describe('isCmdSafeArgument', () => {
  it('refuses characters cmd.exe would reinterpret in batch mode', () => {
    expect(isCmdSafeArgument(abs('ghidra'))).toBe(true);
    expect(isCmdSafeArgument('C:\\ghidra %PATH%')).toBe(false);
    expect(isCmdSafeArgument('C:\\ghidra^x')).toBe(false);
    expect(isCmdSafeArgument('C:\\ghidra&calc')).toBe(false);
  });
});

describe('argument vectors', () => {
  const config = configWith({
    ghidraInstallDir: abs('ghidra'),
    jdkHome: abs('jdk21'),
    pythonExePath: abs('venv', isWindows ? 'python.exe' : 'python'),
    projectRoot: abs('projects'),
  });

  it('builds the pyghidra-mcp module launch with host and port the right way round', () => {
    const command = buildPyghidraMcpCommand({
      config,
      launch: 'module',
      binaryPath: abs('bins', 'client.exe'),
      projectName: 'client-abc12345',
      port: 8500,
    });
    expect(command.program).toBe(config.pythonExePath);
    expect(command.args.slice(0, 2)).toEqual(['-m', 'pyghidra_mcp']);
    // -o is host and -p is port in this CLI; we pass long forms so the audit
    // log cannot be misread.
    const hostIndex = command.args.indexOf('--host');
    const portIndex = command.args.indexOf('--port');
    expect(command.args[hostIndex + 1]).toBe('127.0.0.1');
    expect(command.args[portIndex + 1]).toBe('8500');
    expect(command.args).toContain('streamable-http');
    // Symbol downloads are opt-in: with them on, analysis parked behind a
    // filtering proxy and never finished. The flag is always explicit.
    expect(command.args).toContain('--no-symbols');
    expect(command.args[command.args.length - 1]).toBe(abs('bins', 'client.exe'));
  });

  it('forces re-analysis when the project already exists', () => {
    // The engine analyses only what it IMPORTED this run, and it does not
    // re-import a binary the project already holds -- so a project left
    // half-analysed is never analysed again and every later session parks in
    // 'starting'. Measured: three consecutive sessions stuck that way.
    const reused = buildPyghidraMcpCommand({
      config,
      launch: 'module',
      binaryPath: abs('bins', 'client.exe'),
      projectName: 'client',
      port: 8500,
      projectExists: true,
    });
    expect(reused.args).toContain('--force-analysis');
    // The binary path must stay last.
    expect(reused.args[reused.args.length - 1]).toBe(abs('bins', 'client.exe'));

    const fresh = buildPyghidraMcpCommand({
      config,
      launch: 'module',
      binaryPath: abs('bins', 'client.exe'),
      projectName: 'client',
      port: 8500,
    });
    expect(fresh.args).not.toContain('--force-analysis');
  });

  it('asks for symbols only when the operator turned them on', () => {
    const withSymbols = buildPyghidraMcpCommand({
      config: configWith({ ...config, symbolDownloads: true }),
      launch: 'module',
      binaryPath: abs('bins', 'client.exe'),
      projectName: 'client',
      port: 8500,
    });
    expect(withSymbols.args).toContain('--with-symbols');
    expect(withSymbols.args).not.toContain('--no-symbols');
  });

  it('uses the console script when that is how the probe answered', () => {
    const command = buildPyghidraMcpCommand({
      config,
      launch: 'script',
      binaryPath: abs('bins', 'client.exe'),
      projectName: 'client',
      port: 8501,
    });
    expect(command.program).not.toBe(config.pythonExePath);
    expect(command.program).toContain('pyghidra-mcp');
    expect(command.args).not.toContain('-m');
  });

  it('routes analyzeHeadless through cmd on Windows and includes -overwrite', () => {
    const command = buildAnalyzeHeadlessCommand({
      config,
      binaryPath: abs('bins', 'client.exe'),
      projectName: 'client',
      scriptDir: abs('scripts'),
      scriptName: 'GhidraLabDump.java',
      outputPath: abs('out', 'dump.json'),
    });
    if (isWindows) {
      // Node refuses to spawn a .bat without a shell, so cmd has to be the program.
      expect(command.program.toLowerCase()).toContain('cmd');
      expect(command.args[0]).toBe('/c');
      expect(command.args[1]).toBe(resolveAnalyzeHeadlessPath(config));
    } else {
      expect(command.program).toBe(resolveAnalyzeHeadlessPath(config));
    }
    expect(command.args).toContain('-overwrite');
    expect(command.args).toContain('-postScript');
    expect(command.args[command.args.length - 1]).toBe(abs('out', 'dump.json'));
  });
});

describe('buildGhidraChildEnv', () => {
  it('overrides an inherited JAVA_HOME rather than deferring to it', () => {
    // The real hazard: Ghidra reads JAVA_HOME BEFORE PATH, so an inherited
    // JDK 11 would win and produce an interactive prompt in a headless child.
    const env = buildGhidraChildEnv(
      configWith({ jdkHome: abs('jdk21'), ghidraInstallDir: abs('ghidra'), maxMemMb: 8192 }),
      { JAVA_HOME: abs('jdk11'), PATH: abs('existing') },
    );
    expect(env.JAVA_HOME).toBe(abs('jdk21'));
    expect(env.PATH.startsWith(join(abs('jdk21'), 'bin') + delimiter)).toBe(true);
    expect(env.PATH).toContain(abs('existing'));
    expect(env.GHIDRA_INSTALL_DIR).toBe(abs('ghidra'));
    expect(env.GHIDRA_MAXMEM).toBe('8192M');
    expect(env.GHIDRA_HEADLESS_MAXMEM).toBe('8192M');
  });

  it('keeps both PATH spellings in step when the parent had Path', () => {
    const env = buildGhidraChildEnv(configWith({ jdkHome: abs('jdk21') }), {
      Path: abs('existing'),
      PATH: abs('existing'),
    });
    expect(env.Path).toBe(env.PATH);
  });

  it('leaves JAVA_HOME untouched when no JDK is configured', () => {
    const env = buildGhidraChildEnv(configWith({}), { JAVA_HOME: abs('jdk11') });
    expect(env.JAVA_HOME).toBe(abs('jdk11'));
  });
});

describe('findDottedPathElement', () => {
  it('finds the element that Ghidra will refuse', () => {
    // Measured against a real install: ProjectLocator throws
    // "Path element starting with '.' is not permitted" -- and only once the JVM
    // is up, where it surfaces as a bare exit code 1.
    expect(findDottedPathElement('C:\\Users\\me\\.openroom\\ghidra-lab\\projects')).toBe(
      '.openroom',
    );
    expect(findDottedPathElement('/home/me/.local/share/proj')).toBe('.local');
  });

  it('accepts a path with no dotted element', () => {
    expect(findDottedPathElement('C:\\Users\\me\\GhidraProjects')).toBe('');
    expect(findDottedPathElement('/home/me/ghidra-projects')).toBe('');
    expect(findDottedPathElement('')).toBe('');
  });

  it('does not report traversal segments as the offending element', () => {
    // '..' would send the operator looking for a folder that does not exist.
    expect(findDottedPathElement('C:\\a\\..\\b')).toBe('');
    expect(findDottedPathElement('/a/./b')).toBe('');
  });

  it('does not mistake a drive letter or a dotted filename for a dotted element', () => {
    // A version number inside a folder name is not a dotted path ELEMENT.
    expect(findDottedPathElement('D:\\Tools\\ghidra_12.1.3_PUBLIC')).toBe('');
  });
});

describe('derived paths', () => {
  it('points analyzeHeadless and java at the right spots', () => {
    const config = configWith({ ghidraInstallDir: abs('ghidra'), jdkHome: abs('jdk21') });
    expect(resolveAnalyzeHeadlessPath(config)).toContain(join('support', 'analyzeHeadless'));
    expect(isAbsolute(resolveJavaExePath(config))).toBe(true);
    expect(resolveJavaExePath(config)).toContain(join('bin', 'java'));
  });

  it('returns empty rather than a bogus path when unset', () => {
    expect(resolveAnalyzeHeadlessPath(configWith({}))).toBe('');
    expect(resolveJavaExePath(configWith({}))).toBe('');
  });

  it('makes project names filesystem-boring', () => {
    expect(deriveGhidraProjectName('Client Win64 Shipping.exe', 'ABCDEF0123456789')).toBe(
      'client-win64-shipping-exe-abcdef01',
    );
    expect(deriveGhidraProjectName('!!!', '')).toBe('binary');
  });
});
