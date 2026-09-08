// @vitest-environment node
//
// Preflight decides whether we are allowed to spawn Ghidra at all. Every probe is
// injected here, so these run on a machine with no Ghidra, no JDK 21 and no
// pyghidra-mcp -- which is exactly the machine the feature was written on.
//
// The load-bearing case is the JDK: Ghidra 12 needs 21, this box has 11, and a
// wrong JDK does not fail loudly -- Ghidra prompts on stdin, which in a spawned
// child is an indefinite hang. So "Java 11 is rejected, with a remedy that says
// the system JAVA_HOME can stay put" is a behaviour worth pinning.
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { normalizeGhidraLabConfig } from '../ghidraLabConfig';
import {
  runGhidraLabPreflight,
  type GhidraLabPreflightDeps,
  type GhidraLabProbeResult,
} from '../ghidraLabPreflight';
import type { GhidraLabConfigView } from '../ghidraLabTypes';

const isWindows = process.platform === 'win32';

function abs(...segments: string[]): string {
  return isWindows ? join('C:\\', ...segments) : join('/', ...segments);
}

const GHIDRA_DIR = abs('ghidra');
const JDK_DIR = abs('jdk21');
const PY = abs('venv', isWindows ? 'python.exe' : 'python');
const PROJECTS = abs('projects');
const ROOT = abs('bins');

function ok(stdout: string): GhidraLabProbeResult {
  return { ok: true, stdout, stderr: '', code: 0, error: '' };
}

function fail(error: string): GhidraLabProbeResult {
  return { ok: false, stdout: '', stderr: '', code: 1, error };
}

interface FakeWorld {
  files: Set<string>;
  directories: Set<string>;
  texts: Record<string, string>;
  writableProblem: string;
  probes: (program: string, args: string[]) => GhidraLabProbeResult;
  /** Every probe actually issued, so a test can assert we did not shell out blindly. */
  calls: { program: string; args: string[] }[];
}

function makeDeps(world: Partial<FakeWorld>): GhidraLabPreflightDeps {
  const files = world.files ?? new Set<string>();
  const directories = world.directories ?? new Set<string>();
  const texts = world.texts ?? {};
  const calls = world.calls ?? [];
  return {
    fileExists: (path) => files.has(path),
    directoryExists: (path) => directories.has(path),
    readTextFile: (path) => texts[path] ?? '',
    checkWritableDirectory: () => world.writableProblem ?? '',
    probe: (program, args) => {
      calls.push({ program, args });
      return world.probes ? world.probes(program, args) : fail('no probe configured');
    },
  };
}

/** A world where everything is present and correct. */
function healthyWorld(overrides: Partial<FakeWorld> = {}): Partial<FakeWorld> {
  const headless = join(
    GHIDRA_DIR,
    'support',
    isWindows ? 'analyzeHeadless.bat' : 'analyzeHeadless',
  );
  const javaExe = join(JDK_DIR, 'bin', isWindows ? 'java.exe' : 'java');
  return {
    files: new Set([headless, javaExe, PY]),
    directories: new Set([GHIDRA_DIR, PROJECTS, ROOT]),
    texts: {
      [join(GHIDRA_DIR, 'Ghidra', 'application.properties')]:
        'application.name=Ghidra\napplication.version=12.1.3\n',
    },
    probes: (program, args) => {
      if (program === javaExe) {
        return {
          ok: true,
          stdout: '',
          stderr: 'openjdk version "21.0.4" 2024-07-16',
          code: 0,
          error: '',
        };
      }
      if (program === PY && args[1] === 'pyghidra_mcp') {
        return ok('pyghidra-mcp, version 0.5.0');
      }
      return fail('unexpected probe');
    },
    ...overrides,
  };
}

function fullConfig(patch: Partial<GhidraLabConfigView> = {}): GhidraLabConfigView {
  return normalizeGhidraLabConfig({
    ghidraInstallDir: GHIDRA_DIR,
    jdkHome: JDK_DIR,
    pythonExePath: PY,
    projectRoot: PROJECTS,
    binaryRoots: [{ id: 'bins', path: ROOT, label: 'Bins' }],
    ...patch,
  });
}

function checkById(result: ReturnType<typeof runGhidraLabPreflight>, id: string) {
  const found = result.checks.find((check) => check.id === id);
  if (!found) {
    throw new Error(`no check with id ${id}`);
  }
  return found;
}

describe('runGhidraLabPreflight', () => {
  it('reports six checks in a stable order, whatever the config', () => {
    const result = runGhidraLabPreflight(normalizeGhidraLabConfig({}), makeDeps({}));
    expect(result.checks.map((check) => check.id)).toEqual([
      'ghidra',
      'jdk',
      'python',
      'projects',
      'capa',
      'roots',
    ]);
  });

  it('offers no modes at all when nothing is configured', () => {
    const result = runGhidraLabPreflight(normalizeGhidraLabConfig({}), makeDeps({}));
    expect(result.availableModes).toEqual([]);
    expect(checkById(result, 'ghidra').ok).toBe(false);
    expect(checkById(result, 'jdk').ok).toBe(false);
    expect(checkById(result, 'roots').ok).toBe(false);
  });

  it('does not probe anything when the paths are unset', () => {
    const calls: { program: string; args: string[] }[] = [];
    runGhidraLabPreflight(normalizeGhidraLabConfig({}), makeDeps({ calls }));
    expect(calls).toEqual([]);
  });

  it('accepts a complete, healthy install and enables both modes', () => {
    const result = runGhidraLabPreflight(fullConfig(), makeDeps(healthyWorld()));
    expect(result.availableModes).toEqual(['headless', 'batch']);
    expect(result.ghidraVersion).toBe('12.1.3');
    expect(result.jdkMajor).toBe(21);
    expect(result.pyghidraLaunch).toBe('module');
    expect(result.checks.filter((check) => check.required && !check.ok)).toEqual([]);
  });

  it('rejects JDK 11 and says the system JAVA_HOME can stay where it is', () => {
    const javaExe = join(JDK_DIR, 'bin', isWindows ? 'java.exe' : 'java');
    const result = runGhidraLabPreflight(
      fullConfig(),
      makeDeps(
        healthyWorld({
          probes: (program, args) => {
            if (program === javaExe) {
              return {
                ok: true,
                stdout: '',
                // Verbatim from this machine.
                stderr: 'openjdk version "11.0.14" 2022-01-18 LTS',
                code: 0,
                error: '',
              };
            }
            if (program === PY && args[1] === 'pyghidra_mcp') {
              return ok('pyghidra-mcp, version 0.5.0');
            }
            return fail('unexpected probe');
          },
        }),
      ),
    );
    const jdk = checkById(result, 'jdk');
    expect(jdk.ok).toBe(false);
    expect(jdk.found).toContain('Java 11');
    expect(jdk.remedy).toContain('21');
    expect(jdk.remedy).toContain('JAVA_HOME');
    expect(result.jdkMajor).toBe(11);
    // A bad JDK takes BOTH modes away: batch mode runs Ghidra too.
    expect(result.availableModes).toEqual([]);
  });

  it('treats unreadable java output as a failure, never as probably-fine', () => {
    const javaExe = join(JDK_DIR, 'bin', isWindows ? 'java.exe' : 'java');
    const result = runGhidraLabPreflight(
      fullConfig(),
      makeDeps(healthyWorld({ probes: (program) => (program === javaExe ? ok('') : fail('x')) })),
    );
    expect(checkById(result, 'jdk').ok).toBe(false);
    expect(result.jdkMajor).toBe(0);
  });

  it('rejects a folder that is not actually a Ghidra install', () => {
    const world = healthyWorld();
    const files = new Set(world.files);
    files.delete(
      join(GHIDRA_DIR, 'support', isWindows ? 'analyzeHeadless.bat' : 'analyzeHeadless'),
    );
    const result = runGhidraLabPreflight(fullConfig(), makeDeps({ ...world, files }));
    const ghidra = checkById(result, 'ghidra');
    expect(ghidra.ok).toBe(false);
    expect(ghidra.remedy).toContain('analyzeHeadless');
    expect(result.availableModes).toEqual([]);
  });

  it('still passes Ghidra when only the version file is missing', () => {
    const result = runGhidraLabPreflight(fullConfig(), makeDeps(healthyWorld({ texts: {} })));
    expect(checkById(result, 'ghidra').ok).toBe(true);
    expect(result.ghidraVersion).toBe('');
    expect(result.availableModes).toContain('batch');
  });

  it('falls back to batch mode when Python is absent', () => {
    const result = runGhidraLabPreflight(
      fullConfig({ pythonExePath: '' }),
      makeDeps(healthyWorld()),
    );
    expect(result.availableModes).toEqual(['batch']);
    const python = checkById(result, 'python');
    expect(python.ok).toBe(false);
    expect(python.required).toBe(false);
    expect(python.remedy).toContain('Batch mode');
  });

  it('uses the console script when the module launch does not answer', () => {
    const scriptPath = isWindows
      ? join(abs('venv'), 'Scripts', 'pyghidra-mcp.exe')
      : join(abs('venv'), 'pyghidra-mcp');
    const world = healthyWorld();
    const files = new Set(world.files);
    files.add(scriptPath);
    const result = runGhidraLabPreflight(
      fullConfig(),
      makeDeps({
        ...world,
        files,
        probes: (program, args) => {
          if (program.endsWith(isWindows ? 'java.exe' : 'java')) {
            return { ok: true, stdout: '', stderr: 'openjdk version "21.0.4"', code: 0, error: '' };
          }
          if (program === PY && args[1] === 'pyghidra_mcp') {
            return fail('No module named pyghidra_mcp.__main__');
          }
          if (program === scriptPath) {
            return ok('pyghidra-mcp, version 0.5.0');
          }
          return fail('unexpected probe');
        },
      }),
    );
    expect(checkById(result, 'python').ok).toBe(true);
    expect(result.pyghidraLaunch).toBe('script');
    expect(result.availableModes).toContain('headless');
  });

  it('reports why pyghidra-mcp did not answer when both launches fail', () => {
    const result = runGhidraLabPreflight(
      fullConfig(),
      makeDeps(
        healthyWorld({
          probes: (program) => {
            if (program.endsWith(isWindows ? 'java.exe' : 'java')) {
              return {
                ok: true,
                stdout: '',
                stderr: 'openjdk version "21.0.4"',
                code: 0,
                error: '',
              };
            }
            return fail('No module named pyghidra_mcp');
          },
        }),
      ),
    );
    const python = checkById(result, 'python');
    expect(python.ok).toBe(false);
    expect(python.remedy).toContain('No module named pyghidra_mcp');
    expect(result.pyghidraLaunch).toBeNull();
    expect(result.availableModes).toEqual(['batch']);
  });

  it('fails the project folder when it cannot be written', () => {
    const result = runGhidraLabPreflight(
      fullConfig(),
      makeDeps(healthyWorld({ writableProblem: 'EACCES: permission denied' })),
    );
    expect(checkById(result, 'projects').ok).toBe(false);
    expect(checkById(result, 'projects').remedy).toContain('EACCES');
    expect(result.availableModes).toEqual([]);
  });

  it('refuses a project folder Ghidra will reject, before anything is spawned', () => {
    // The default everything else in this app uses (~/.openroom/...) is exactly
    // the shape Ghidra refuses, and it only says so after the JVM is up.
    const dotted = isWindows
      ? join(abs('Users', 'me'), '.openroom', 'proj')
      : '/home/me/.openroom/proj';
    const result = runGhidraLabPreflight(
      fullConfig({ projectRoot: dotted }),
      makeDeps(healthyWorld()),
    );
    const projects = checkById(result, 'projects');
    expect(projects.ok).toBe(false);
    expect(projects.found).toContain('.openroom');
    expect(projects.remedy).toContain('starts with a dot');
    expect(result.availableModes).toEqual([]);
  });

  it('names the roots that have gone missing', () => {
    const result = runGhidraLabPreflight(
      fullConfig({
        binaryRoots: [
          { id: 'bins', path: ROOT, label: 'Bins' },
          { id: 'gone', path: abs('gone'), label: 'Gone' },
        ],
      }),
      makeDeps(healthyWorld()),
    );
    const roots = checkById(result, 'roots');
    expect(roots.ok).toBe(false);
    expect(roots.remedy).toContain('gone');
    expect(result.availableModes).toEqual([]);
  });

  it('keeps capa optional and never lets it block a mode', () => {
    const healthy = runGhidraLabPreflight(fullConfig(), makeDeps(healthyWorld()));
    const capa = checkById(healthy, 'capa');
    expect(capa.ok).toBe(false);
    expect(capa.required).toBe(false);
    expect(healthy.availableModes).toEqual(['headless', 'batch']);
  });

  it('reports a configured capa version when it runs', () => {
    const capaExe = abs('capa.exe');
    const world = healthyWorld();
    const files = new Set(world.files);
    files.add(capaExe);
    const result = runGhidraLabPreflight(
      fullConfig({ capaExePath: capaExe }),
      makeDeps({
        ...world,
        files,
        probes: (program, args) => {
          if (program === capaExe) {
            return ok('capa 7.4.0');
          }
          return world.probes ? world.probes(program, args) : fail('x');
        },
      }),
    );
    expect(checkById(result, 'capa').ok).toBe(true);
    expect(result.capaVersion).toBe('capa 7.4.0');
  });
});

describe('paths that are configured but not there', () => {
  // The difference between "not set" and "set to something that does not exist"
  // is the whole value of this screen: the second one is a typo or a moved
  // folder, and saying only "not configured" sends the operator to re-enter a
  // path they already entered.

  it('separates a missing Ghidra folder from an unset one', () => {
    const world = healthyWorld();
    const result = runGhidraLabPreflight(
      fullConfig(),
      makeDeps({ ...world, directories: new Set([PROJECTS, ROOT]) }),
    );
    const check = checkById(result, 'ghidra');
    expect(check.ok).toBe(false);
    // The state goes in `found`, the path to go fix in `remedy`.
    expect(check.found).toBe('folder does not exist');
    expect(check.remedy).toContain(GHIDRA_DIR);
    expect(result.availableModes).toEqual([]);
  });

  it('names the java executable it looked for and did not find', () => {
    // A JDK home pointing one level too high (or too low) is the common mistake,
    // and the missing bin/java path is what makes that obvious.
    const world = healthyWorld();
    const files = new Set(world.files);
    for (const path of files) {
      if (path.includes('java')) {
        files.delete(path);
      }
    }
    const check = checkById(
      runGhidraLabPreflight(fullConfig(), makeDeps({ ...world, files })),
      'jdk',
    );
    expect(check.ok).toBe(false);
    expect(check.found).toContain('java');
  });

  it('reports a Python path that is not on disk without probing it', () => {
    // Probing a path that does not exist would report a spawn error instead of
    // the real problem, and headless mode has to drop off the list either way.
    const world = healthyWorld();
    const files = new Set(world.files);
    files.delete(PY);
    const calls: { program: string; args: string[] }[] = [];
    const result = runGhidraLabPreflight(fullConfig(), makeDeps({ ...world, files, calls }));
    const check = checkById(result, 'python');
    expect(check.ok).toBe(false);
    expect(check.remedy).toContain(PY);
    expect(calls.some((call) => call.program === PY)).toBe(false);
    expect(result.availableModes).not.toContain('headless');
  });

  it('reports a capa path that is not on disk, and stays optional', () => {
    const world = healthyWorld();
    const capa = abs('tools', 'capa.exe');
    const result = runGhidraLabPreflight(fullConfig({ capaExePath: capa }), makeDeps(world));
    const check = checkById(result, 'capa');
    expect(check.ok).toBe(false);
    expect(check.required).toBe(false);
    expect(check.remedy).toContain(capa);
    // capa is a second opinion, not a gate: the lab still works without it.
    expect(result.availableModes).toContain('headless');
  });

  it('reports a capa that is present but will not run', () => {
    const world = healthyWorld();
    const capa = abs('tools', 'capa.exe');
    const files = new Set([...(world.files ?? []), capa]);
    const result = runGhidraLabPreflight(
      fullConfig({ capaExePath: capa }),
      makeDeps({
        ...world,
        files,
        probes: (program, args) =>
          program === capa ? fail('not a valid executable') : world.probes!(program, args),
      }),
    );
    const check = checkById(result, 'capa');
    expect(check.ok).toBe(false);
    expect(check.found + check.remedy).toContain('not a valid executable');
    expect(result.capaVersion).toBe('');
  });
});
