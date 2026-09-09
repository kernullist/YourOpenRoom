// Ghidra Lab preflight: prove every configured path before anything is spawned.
//
// This is not a nicety. Each of the things checked here fails in a way that is
// worse than an error if it is left to be discovered at spawn time:
//
//   - A wrong JDK makes Ghidra PROMPT on stdin for a Java home. In a spawned
//     child with no console that is an indefinite hang -- the session sits in
//     'starting' until the analysis deadline, and the operator is told "analysis
//     timed out" about a problem that was visible before we started.
//   - A missing GHIDRA_INSTALL_DIR makes pyghidra-mcp die during import, long
//     before it binds a port, so the only symptom is a connection refused.
//   - A Python that cannot import pyghidra_mcp produces the same connection
//     refused, from a completely different cause.
//
// So the rule is: every check names what was FOUND and what to DO, and the
// session manager refuses a mode whose checks did not pass. Probes are injected
// so the whole thing is unit-testable with no Ghidra, no JDK and no Python.
//
// Server-only: fs + child_process.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { join } from 'path';

import {
  buildGhidraChildEnv,
  findDottedPathElement,
  parseGhidraVersion,
  parseJavaMajorVersion,
  resolveAnalyzeHeadlessPath,
  resolveGhidraVersionFilePath,
  resolveJavaExePath,
  resolvePyghidraScriptPath,
  type PyghidraLaunchKind,
} from './ghidraLabConfig';
import {
  GHIDRA_MIN_JDK_MAJOR,
  type GhidraLabConfigView,
  type GhidraLabPreflightCheck,
  type GhidraLabSessionMode,
} from './ghidraLabTypes';

const PROBE_TIMEOUT_MS = 8000;
const MAX_PROBE_OUTPUT_CHARS = 4000;

export interface GhidraLabProbeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  error: string;
}

export interface GhidraLabPreflightDeps {
  fileExists(path: string): boolean;
  directoryExists(path: string): boolean;
  readTextFile(path: string): string;
  /** '' when the directory exists (or was created) and is writable; else a reason. */
  checkWritableDirectory(path: string): string;
  probe(program: string, args: string[], env: Record<string, string>): GhidraLabProbeResult;
}

export interface GhidraLabPreflightResult {
  checks: GhidraLabPreflightCheck[];
  ghidraVersion: string;
  jdkVersion: string;
  jdkMajor: number;
  pyghidraMcpVersion: string;
  /** How pyghidra-mcp actually answered, or null when it did not. */
  pyghidraLaunch: PyghidraLaunchKind | null;
  capaVersion: string;
  flossVersion: string;
  availableModes: GhidraLabSessionMode[];
}

function truncate(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_PROBE_OUTPUT_CHARS
    ? `${trimmed.slice(0, MAX_PROBE_OUTPUT_CHARS)}...`
    : trimmed;
}

export function createGhidraLabNodePreflightDeps(): GhidraLabPreflightDeps {
  return {
    fileExists(path: string): boolean {
      try {
        return fs.statSync(path).isFile();
      } catch {
        return false;
      }
    },
    directoryExists(path: string): boolean {
      try {
        return fs.statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    readTextFile(path: string): string {
      try {
        return fs.readFileSync(path, 'utf8');
      } catch {
        return '';
      }
    },
    checkWritableDirectory(path: string): string {
      try {
        fs.mkdirSync(path, { recursive: true });
      } catch (error) {
        return error instanceof Error ? error.message : 'could not be created';
      }
      const probeFile = join(path, `.ghidra-lab-write-probe-${process.pid}`);
      try {
        fs.writeFileSync(probeFile, 'ok');
        fs.unlinkSync(probeFile);
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : 'is not writable';
      }
    },
    probe(program: string, args: string[], env: Record<string, string>): GhidraLabProbeResult {
      try {
        const result = spawnSync(program, args, {
          env,
          timeout: PROBE_TIMEOUT_MS,
          encoding: 'utf8',
          windowsHide: true,
          // shell:false. A probe that needed a shell would be a probe of the
          // shell, not of the thing we are about to spawn.
          shell: false,
        });
        if (result.error) {
          return {
            ok: false,
            stdout: '',
            stderr: '',
            code: null,
            error: result.error.message,
          };
        }
        return {
          ok: result.status === 0,
          stdout: truncate(result.stdout ?? ''),
          stderr: truncate(result.stderr ?? ''),
          code: result.status,
          error: '',
        };
      } catch (error) {
        return {
          ok: false,
          stdout: '',
          stderr: '',
          code: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function checkGhidra(
  config: GhidraLabConfigView,
  deps: GhidraLabPreflightDeps,
): { check: GhidraLabPreflightCheck; version: string } {
  const base = { id: 'ghidra', label: 'Ghidra install', required: true };
  if (!config.ghidraInstallDir) {
    return {
      check: {
        ...base,
        ok: false,
        found: 'not set',
        remedy: 'Point this at the Ghidra folder that contains support/ and Ghidra/.',
      },
      version: '',
    };
  }
  if (!deps.directoryExists(config.ghidraInstallDir)) {
    return {
      check: {
        ...base,
        ok: false,
        found: 'folder does not exist',
        remedy: `No directory at ${config.ghidraInstallDir}.`,
      },
      version: '',
    };
  }
  const headless = resolveAnalyzeHeadlessPath(config);
  if (!deps.fileExists(headless)) {
    return {
      check: {
        ...base,
        ok: false,
        found: 'no support/analyzeHeadless',
        remedy:
          'This folder does not look like a Ghidra install -- it has no support/analyzeHeadless. Pick the extracted ghidra_<version>_PUBLIC folder itself, not its parent.',
      },
      version: '',
    };
  }
  const version = parseGhidraVersion(deps.readTextFile(resolveGhidraVersionFilePath(config)));
  return {
    check: {
      ...base,
      ok: true,
      found: version ? `Ghidra ${version}` : 'Ghidra (version unknown)',
      remedy: '',
    },
    version,
  };
}

function checkJdk(
  config: GhidraLabConfigView,
  deps: GhidraLabPreflightDeps,
): { check: GhidraLabPreflightCheck; version: string; major: number } {
  const base = { id: 'jdk', label: `JDK ${GHIDRA_MIN_JDK_MAJOR}+`, required: true };
  if (!config.jdkHome) {
    return {
      check: {
        ...base,
        ok: false,
        found: 'not set',
        remedy: `Set a JDK ${GHIDRA_MIN_JDK_MAJOR}+ home. It is injected into the Ghidra process only, so your system JAVA_HOME is left alone.`,
      },
      version: '',
      major: 0,
    };
  }
  const javaExe = resolveJavaExePath(config);
  if (!deps.fileExists(javaExe)) {
    return {
      check: {
        ...base,
        ok: false,
        found: 'no bin/java',
        remedy: `Expected ${javaExe}. Point this at the JDK home, not at bin/ and not at a JRE.`,
      },
      version: '',
      major: 0,
    };
  }
  // `java -version` writes to stderr on every vendor worth supporting.
  const probe = deps.probe(javaExe, ['-version'], buildGhidraChildEnv(config));
  const output = `${probe.stderr}\n${probe.stdout}`;
  const major = parseJavaMajorVersion(output);
  if (!major) {
    return {
      check: {
        ...base,
        ok: false,
        found: probe.error ? `probe failed: ${probe.error}` : 'unrecognized java -version output',
        remedy: 'Could not read a version from this java. Check that it runs.',
      },
      version: '',
      major: 0,
    };
  }
  const firstLine = output.trim().split(/\r?\n/)[0] ?? '';
  if (major < GHIDRA_MIN_JDK_MAJOR) {
    return {
      check: {
        ...base,
        ok: false,
        found: `Java ${major} (${firstLine})`,
        remedy: `Found Java ${major} at the configured path; Ghidra needs JDK ${GHIDRA_MIN_JDK_MAJOR}. Point this at a ${GHIDRA_MIN_JDK_MAJOR} install -- your system JAVA_HOME can stay on ${major}, GhidraLab only injects this into the Ghidra child process.`,
      },
      version: firstLine,
      major,
    };
  }
  return {
    check: { ...base, ok: true, found: `Java ${major}`, remedy: '' },
    version: firstLine,
    major,
  };
}

/**
 * Probe pyghidra-mcp the way we will actually launch it.
 *
 * Two launch shapes are tried in order -- `python -m pyghidra_mcp` first, then
 * the console script next to the interpreter -- because whether a package ships
 * a `__main__` is not something to assume. Whichever answered is what the
 * session manager uses, so the probe and the spawn can never disagree.
 */
function checkPython(
  config: GhidraLabConfigView,
  deps: GhidraLabPreflightDeps,
): { check: GhidraLabPreflightCheck; version: string; launch: PyghidraLaunchKind | null } {
  const base = { id: 'python', label: 'pyghidra-mcp', required: false };
  if (!config.pythonExePath) {
    return {
      check: {
        ...base,
        ok: false,
        found: 'not set',
        remedy:
          'Only headless (MCP) mode needs this. Batch mode runs on Ghidra + JDK alone; set a Python with pyghidra-mcp to enable follow-up questions.',
      },
      version: '',
      launch: null,
    };
  }
  if (!deps.fileExists(config.pythonExePath)) {
    return {
      check: {
        ...base,
        ok: false,
        found: 'interpreter not found',
        remedy: `No file at ${config.pythonExePath}.`,
      },
      version: '',
      launch: null,
    };
  }
  const env = buildGhidraChildEnv(config);
  const attempts: { launch: PyghidraLaunchKind; program: string; args: string[] }[] = [
    { launch: 'module', program: config.pythonExePath, args: ['-m', 'pyghidra_mcp', '--version'] },
  ];
  const scriptPath = resolvePyghidraScriptPath(config.pythonExePath);
  if (scriptPath && deps.fileExists(scriptPath)) {
    attempts.push({ launch: 'script', program: scriptPath, args: ['--version'] });
  }

  let lastDetail = '';
  for (const attempt of attempts) {
    const probe = deps.probe(attempt.program, attempt.args, env);
    if (probe.ok) {
      const reported = truncate(`${probe.stdout}\n${probe.stderr}`).split(/\r?\n/)[0] ?? '';
      return {
        check: {
          ...base,
          ok: true,
          found: reported || 'pyghidra-mcp (version unknown)',
          remedy: '',
        },
        version: reported,
        launch: attempt.launch,
      };
    }
    lastDetail = probe.error || truncate(probe.stderr).split(/\r?\n/)[0] || `exit ${probe.code}`;
  }
  return {
    check: {
      ...base,
      ok: false,
      found: 'not installed',
      remedy: `pyghidra-mcp did not answer (${lastDetail}). Use Bootstrap to create a venv with it, or point this at an interpreter that already has it.`,
    },
    version: '',
    launch: null,
  };
}

function checkProjectRoot(
  config: GhidraLabConfigView,
  deps: GhidraLabPreflightDeps,
): GhidraLabPreflightCheck {
  const base = { id: 'projects', label: 'Project folder', required: true };
  if (!config.projectRoot) {
    return {
      ...base,
      ok: false,
      found: 'not set',
      remedy: 'Set a folder for Ghidra projects. Reusing a project is what makes a rerun cheap.',
    };
  }
  const dotted = findDottedPathElement(config.projectRoot);
  if (dotted) {
    // Caught here because Ghidra only complains once the JVM is up, where it
    // surfaces as a bare "exited with code 1".
    return {
      ...base,
      ok: false,
      found: `contains "${dotted}"`,
      remedy: `Ghidra refuses any path element that starts with a dot, and this one contains "${dotted}". Pick a folder without a leading-dot component, e.g. C:\\Users\\you\\GhidraProjects.`,
    };
  }
  const problem = deps.checkWritableDirectory(config.projectRoot);
  if (problem) {
    return { ...base, ok: false, found: 'not writable', remedy: problem };
  }
  return { ...base, ok: true, found: config.projectRoot, remedy: '' };
}

function checkCapa(
  config: GhidraLabConfigView,
  deps: GhidraLabPreflightDeps,
): { check: GhidraLabPreflightCheck; version: string } {
  const base = { id: 'capa', label: 'capa (optional)', required: false };
  if (!config.capaExePath) {
    return {
      check: {
        ...base,
        ok: false,
        found: 'not set',
        remedy:
          'Optional. capa adds rule-backed ATT&CK/MBC capability matches, which the report quotes instead of paraphrasing decompiled code.',
      },
      version: '',
    };
  }
  if (!deps.fileExists(config.capaExePath)) {
    return {
      check: {
        ...base,
        ok: false,
        found: 'not found',
        remedy: `No file at ${config.capaExePath}.`,
      },
      version: '',
    };
  }
  const probe = deps.probe(config.capaExePath, ['--version'], buildGhidraChildEnv(config));
  if (!probe.ok) {
    return {
      check: {
        ...base,
        ok: false,
        found: 'did not run',
        remedy: probe.error || truncate(probe.stderr) || `exit ${probe.code}`,
      },
      version: '',
    };
  }
  const reported = truncate(`${probe.stdout}\n${probe.stderr}`).split(/\r?\n/)[0] ?? '';
  return {
    check: { ...base, ok: true, found: reported || 'capa', remedy: '' },
    version: reported,
  };
}

/**
 * FLOSS: optional, and the difference between "no interesting strings" and
 * "every interesting string was hidden" on an obfuscated target.
 */
function checkFloss(
  config: GhidraLabConfigView,
  deps: GhidraLabPreflightDeps,
): { check: GhidraLabPreflightCheck; version: string } {
  const base = { id: 'floss', label: 'FLOSS (optional)', required: false };
  if (!config.flossExePath) {
    return {
      check: {
        ...base,
        ok: false,
        found: 'not set',
        remedy:
          'Optional. FLOSS recovers stack strings, tight strings and strings a routine decodes at run time -- the ones a string dump cannot see. Use Download in Setup, or point this at floss.exe.',
      },
      version: '',
    };
  }
  if (!deps.fileExists(config.flossExePath)) {
    return {
      check: {
        ...base,
        ok: false,
        found: 'not found',
        remedy: `No file at ${config.flossExePath}.`,
      },
      version: '',
    };
  }
  const probe = deps.probe(config.flossExePath, ['--version'], buildGhidraChildEnv(config));
  if (!probe.ok) {
    return {
      check: {
        ...base,
        ok: false,
        found: 'did not run',
        remedy: probe.error || truncate(probe.stderr) || `exit ${probe.code}`,
      },
      version: '',
    };
  }
  const reported = truncate(`${probe.stdout}\n${probe.stderr}`).split(/\r?\n/)[0] ?? '';
  return {
    check: { ...base, ok: true, found: reported || 'floss', remedy: '' },
    version: reported,
  };
}

function checkBinaryRoots(
  config: GhidraLabConfigView,
  deps: GhidraLabPreflightDeps,
): GhidraLabPreflightCheck {
  const base = { id: 'roots', label: 'Binary roots', required: true };
  if (config.binaryRoots.length === 0) {
    return {
      ...base,
      ok: false,
      found: 'none registered',
      remedy:
        'Add at least one folder. With no roots, nothing can be analyzed -- that is on purpose.',
    };
  }
  const missing = config.binaryRoots.filter((root) => !deps.directoryExists(root.path));
  if (missing.length > 0) {
    return {
      ...base,
      ok: false,
      found: `${config.binaryRoots.length} registered, ${missing.length} missing`,
      remedy: `These roots do not exist: ${missing.map((root) => root.id).join(', ')}.`,
    };
  }
  return {
    ...base,
    ok: true,
    found: `${config.binaryRoots.length} folder${config.binaryRoots.length === 1 ? '' : 's'}`,
    remedy: '',
  };
}

/** Run every check. Order is display order in the setup panel. */
export function runGhidraLabPreflight(
  config: GhidraLabConfigView,
  deps: GhidraLabPreflightDeps = createGhidraLabNodePreflightDeps(),
): GhidraLabPreflightResult {
  const ghidra = checkGhidra(config, deps);
  const jdk = checkJdk(config, deps);
  const python = checkPython(config, deps);
  const projects = checkProjectRoot(config, deps);
  const capa = checkCapa(config, deps);
  const floss = checkFloss(config, deps);
  const roots = checkBinaryRoots(config, deps);

  const checks = [ghidra.check, jdk.check, python.check, projects, capa.check, floss.check, roots];

  // Batch mode is the floor: Ghidra + a real JDK + somewhere to put the project
  // + something to analyze. Headless adds a working pyghidra-mcp on top.
  const batchReady = ghidra.check.ok && jdk.check.ok && projects.ok && roots.ok;
  const availableModes: GhidraLabSessionMode[] = [];
  if (batchReady && python.check.ok) {
    availableModes.push('headless');
  }
  if (batchReady) {
    availableModes.push('batch');
  }

  return {
    checks,
    ghidraVersion: ghidra.version,
    jdkVersion: jdk.version,
    jdkMajor: jdk.major,
    pyghidraMcpVersion: python.version,
    pyghidraLaunch: python.launch,
    capaVersion: capa.version,
    flossVersion: floss.version,
    availableModes,
  };
}
