// Ghidra Lab configuration: the operator-owned paths and bounds that decide what
// a session may be started from, and the argument vectors used to start one.
//
// Persisted under the `ghidraLab` key of the shared config file (same file and
// same shape of access as `idaSql` / `idaPe`), so the dev server, the daemon and
// the app all read one source of truth.
//
// Four things here are load-bearing:
//
//   - BINARY ROOTS ARE THE REACH LIMIT. A session can only ever be started from a
//     file that resolves (after symlink resolution by the caller) inside a root
//     the operator registered. An empty root list means the app can analyze
//     nothing -- fail-closed, like every other host store.
//   - ARGUMENT VECTORS, NEVER COMMAND STRINGS. The spawn is shell:false with a
//     validated vector, so there is no shell to inject into.
//   - THE JDK IS OURS, NOT THE SYSTEM'S. Ghidra 12 needs JDK 21; this machine's
//     system JAVA_HOME is 11 and other toolchains still expect that. So JAVA_HOME
//     is injected into the Ghidra child only, and the version is verified before
//     anything is spawned -- because when Ghidra cannot find a usable JDK it
//     PROMPTS on stdin, which in a spawned child is an indefinite hang, not an
//     error we could report.
//   - .BAT NEEDS CMD. Node refuses to spawn a .bat/.cmd without a shell (since
//     the 2024 argument-injection fix), and analyzeHeadless ships only as a
//     batch file on Windows. We therefore route batch mode through
//     `cmd.exe /c`, which re-introduces cmd's own metacharacter parsing -- so
//     batch-mode paths get a STRICTER character check than the rest (see
//     CMD_UNSAFE_REGEX).
//
// Server/test only: imports node `path` and reads `process.env`. Client code must
// import from ghidraLabTypes / ghidraLabClient instead (a node import here would
// break the bundle).
import { delimiter, isAbsolute, join, resolve, sep } from 'path';
import type { GhidraBinaryRoot, GhidraLabConfigView, GhidraLabSessionMode } from './ghidraLabTypes';

export const GHIDRA_LAB_CONFIG_KEY = 'ghidraLab';

const MAX_BINARY_ROOTS = 16;
const MAX_PATH_CHARS = 1024;
const ROOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHELL_METACHAR_REGEX = /[|&;<>`\r\n$]/;
// Extra characters that are harmless to a shell:false spawn but are NOT harmless
// once cmd.exe parses the line for us in batch mode. `%` expands variables and
// `^` escapes, so a path containing either could change the command cmd runs.
const CMD_UNSAFE_REGEX = /[%^!"]/;

// Default HTTP port window for headless sessions. Deliberately disjoint from the
// IDA lab's windows (idasql headless 8300-8399, in-GUI idasql probes 8100-8199)
// so the two labs can be live at the same time without fighting over a port.
export const GHIDRA_LAB_DEFAULT_PORT_START = 8500;
export const GHIDRA_LAB_DEFAULT_PORT_END = 8599;

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_IDLE_TIMEOUT_MS = 60 * 1000;
const MAX_IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000;

const DEFAULT_ANALYSIS_TIMEOUT_MS = 45 * 60 * 1000;
const MIN_ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ANALYSIS_TIMEOUT_MS = 4 * 60 * 60 * 1000;

// Ghidra's own headless default is 2G, which is not enough for a game binary.
const DEFAULT_MAX_MEM_MB = 4096;
const MIN_MAX_MEM_MB = 1024;
const MAX_MAX_MEM_MB = 65536;

/** The raw persisted shape. Every field optional: a fresh config is legal. */
export interface GhidraLabStoredConfig {
  ghidraInstallDir?: string;
  jdkHome?: string;
  pythonExePath?: string;
  projectRoot?: string;
  maxMemMb?: number;
  binaryRoots?: GhidraBinaryRoot[];
  httpPortStart?: number;
  httpPortEnd?: number;
  sessionIdleTimeoutMs?: number;
  analysisTimeoutMs?: number;
  capaExePath?: string;
  flossExePath?: string;
  symbolDownloads?: boolean;
  writeEnabled?: boolean;
}

export const DEFAULT_GHIDRA_LAB_CONFIG: GhidraLabConfigView = {
  ghidraInstallDir: '',
  jdkHome: '',
  pythonExePath: '',
  projectRoot: '',
  maxMemMb: DEFAULT_MAX_MEM_MB,
  binaryRoots: [],
  httpPortStart: GHIDRA_LAB_DEFAULT_PORT_START,
  httpPortEnd: GHIDRA_LAB_DEFAULT_PORT_END,
  sessionIdleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  analysisTimeoutMs: DEFAULT_ANALYSIS_TIMEOUT_MS,
  capaExePath: '',
  flossExePath: '',
  symbolDownloads: false,
  writeEnabled: false,
};

function normalizeAbsolutePath(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PATH_CHARS) {
    return '';
  }
  if (SHELL_METACHAR_REGEX.test(trimmed)) {
    return '';
  }
  if (!isAbsolute(trimmed)) {
    return '';
  }
  return resolve(trimmed);
}

function normalizeRoot(raw: unknown): GhidraBinaryRoot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Partial<GhidraBinaryRoot>;
  const id = typeof value.id === 'string' ? value.id.trim().toLowerCase() : '';
  if (!ROOT_ID_PATTERN.test(id)) {
    return null;
  }
  const path = normalizeAbsolutePath(value.path);
  if (!path) {
    return null;
  }
  const label = typeof value.label === 'string' && value.label.trim() ? value.label.trim() : path;
  return { id, path, label: label.slice(0, 120) };
}

function clampPort(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  if (rounded < 1024 || rounded > 65535) {
    return fallback;
  }
  return rounded;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  if (rounded <= 0) {
    return fallback;
  }
  return Math.min(max, Math.max(min, rounded));
}

/** Normalize whatever is on disk into a complete, bounded view. */
export function normalizeGhidraLabConfig(raw: unknown): GhidraLabConfigView {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_GHIDRA_LAB_CONFIG, binaryRoots: [] };
  }
  const value = raw as GhidraLabStoredConfig;

  const seenIds = new Set<string>();
  const binaryRoots: GhidraBinaryRoot[] = [];
  for (const entry of Array.isArray(value.binaryRoots) ? value.binaryRoots : []) {
    const root = normalizeRoot(entry);
    if (!root || seenIds.has(root.id)) {
      continue;
    }
    seenIds.add(root.id);
    binaryRoots.push(root);
    if (binaryRoots.length >= MAX_BINARY_ROOTS) {
      break;
    }
  }

  let httpPortStart = clampPort(value.httpPortStart, GHIDRA_LAB_DEFAULT_PORT_START);
  let httpPortEnd = clampPort(value.httpPortEnd, GHIDRA_LAB_DEFAULT_PORT_END);
  if (httpPortEnd < httpPortStart) {
    // A reversed window would allocate nothing; swap rather than fail the load.
    const swap = httpPortStart;
    httpPortStart = httpPortEnd;
    httpPortEnd = swap;
  }

  return {
    ghidraInstallDir: normalizeAbsolutePath(value.ghidraInstallDir),
    jdkHome: normalizeAbsolutePath(value.jdkHome),
    pythonExePath: normalizeAbsolutePath(value.pythonExePath),
    projectRoot: normalizeAbsolutePath(value.projectRoot),
    maxMemMb: clampInt(value.maxMemMb, DEFAULT_MAX_MEM_MB, MIN_MAX_MEM_MB, MAX_MAX_MEM_MB),
    binaryRoots,
    httpPortStart,
    httpPortEnd,
    sessionIdleTimeoutMs: clampInt(
      value.sessionIdleTimeoutMs,
      DEFAULT_IDLE_TIMEOUT_MS,
      MIN_IDLE_TIMEOUT_MS,
      MAX_IDLE_TIMEOUT_MS,
    ),
    analysisTimeoutMs: clampInt(
      value.analysisTimeoutMs,
      DEFAULT_ANALYSIS_TIMEOUT_MS,
      MIN_ANALYSIS_TIMEOUT_MS,
      MAX_ANALYSIS_TIMEOUT_MS,
    ),
    capaExePath: normalizeAbsolutePath(value.capaExePath),
    flossExePath: normalizeAbsolutePath(value.flossExePath),
    // Opt-IN, unlike the engine's own default: see the field comment.
    symbolDownloads: value.symbolDownloads === true,
    writeEnabled: value.writeEnabled === true,
  };
}

/** Shape the normalized view back into the persisted (sparse) form. */
export function toStoredGhidraLabConfig(config: GhidraLabConfigView): GhidraLabStoredConfig {
  return {
    ...(config.ghidraInstallDir ? { ghidraInstallDir: config.ghidraInstallDir } : {}),
    ...(config.jdkHome ? { jdkHome: config.jdkHome } : {}),
    ...(config.pythonExePath ? { pythonExePath: config.pythonExePath } : {}),
    ...(config.projectRoot ? { projectRoot: config.projectRoot } : {}),
    ...(config.capaExePath ? { capaExePath: config.capaExePath } : {}),
    ...(config.flossExePath ? { flossExePath: config.flossExePath } : {}),
    maxMemMb: config.maxMemMb,
    binaryRoots: config.binaryRoots,
    httpPortStart: config.httpPortStart,
    httpPortEnd: config.httpPortEnd,
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
    analysisTimeoutMs: config.analysisTimeoutMs,
    symbolDownloads: config.symbolDownloads,
    writeEnabled: config.writeEnabled,
  };
}

const PATCHABLE_KEYS: readonly (keyof GhidraLabStoredConfig)[] = [
  'ghidraInstallDir',
  'jdkHome',
  'pythonExePath',
  'projectRoot',
  'maxMemMb',
  'binaryRoots',
  'httpPortStart',
  'httpPortEnd',
  'sessionIdleTimeoutMs',
  'analysisTimeoutMs',
  'capaExePath',
  'flossExePath',
  'symbolDownloads',
  'writeEnabled',
];

/**
 * Merge an operator patch onto the current config. Unknown keys are dropped by
 * normalization, so a hostile body cannot smuggle fields in.
 */
export function mergeGhidraLabConfig(
  current: GhidraLabConfigView,
  patch: unknown,
): GhidraLabConfigView {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return current;
  }
  const value = patch as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...toStoredGhidraLabConfig(current) };
  for (const key of PATCHABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      merged[key] = value[key];
    }
  }
  return normalizeGhidraLabConfig(merged);
}

// --- Derived paths ----------------------------------------------------------

/** `<ghidraInstallDir>/support/analyzeHeadless.bat` (or the POSIX script). */
export function resolveAnalyzeHeadlessPath(config: GhidraLabConfigView): string {
  if (!config.ghidraInstallDir) {
    return '';
  }
  const name = process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless';
  return join(config.ghidraInstallDir, 'support', name);
}

/** `<jdkHome>/bin/java(.exe)` -- what the preflight probes for a version. */
export function resolveJavaExePath(config: GhidraLabConfigView): string {
  if (!config.jdkHome) {
    return '';
  }
  const name = process.platform === 'win32' ? 'java.exe' : 'java';
  return join(config.jdkHome, 'bin', name);
}

/** `<ghidraInstallDir>/Ghidra/application.properties` -- where the version lives. */
export function resolveGhidraVersionFilePath(config: GhidraLabConfigView): string {
  if (!config.ghidraInstallDir) {
    return '';
  }
  return join(config.ghidraInstallDir, 'Ghidra', 'application.properties');
}

/**
 * Parse `application.version=12.1.3` out of Ghidra's properties file.
 * Returns '' when the file did not look like Ghidra's.
 */
export function parseGhidraVersion(propertiesText: string): string {
  for (const line of propertiesText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    if (trimmed.slice(0, eq).trim() !== 'application.version') {
      continue;
    }
    return trimmed.slice(eq + 1).trim();
  }
  return '';
}

/**
 * Pull the major version out of `java -version` output.
 *
 * `java -version` prints to STDERR, and the shapes differ across vendors and
 * eras -- all of these are real:
 *   openjdk version "21.0.4" 2024-07-16
 *   openjdk version "11.0.14" 2022-01-18 LTS      <- what this machine has
 *   java version "1.8.0_401"
 * Returns 0 when nothing parseable was found, which the caller must treat as a
 * failed check rather than as "probably fine".
 */
export function parseJavaMajorVersion(versionOutput: string): number {
  const match = /version\s+"([^"]+)"/.exec(versionOutput);
  if (!match) {
    return 0;
  }
  const raw = match[1];
  // 1.8.0_401 -> 8; everything since 9 leads with the major.
  const legacy = /^1\.(\d+)/.exec(raw);
  if (legacy) {
    return Number.parseInt(legacy[1], 10) || 0;
  }
  const modern = /^(\d+)/.exec(raw);
  if (!modern) {
    return 0;
  }
  return Number.parseInt(modern[1], 10) || 0;
}

/**
 * The first path element that starts with a dot, or ''.
 *
 * Ghidra's ProjectLocator refuses any path element beginning with '.' and throws
 * IllegalArgumentException("Path element starting with '.' is not permitted")
 * during startup -- measured, not guessed. That is fatal AFTER the JVM is up, so
 * it reads as a generic "exited with code 1" unless it is caught beforehand.
 *
 * This bites the obvious default hardest: everything else this app owns lives
 * under ~/.openroom, and that is exactly the shape Ghidra rejects.
 */
export function findDottedPathElement(path: string): string {
  if (!path) {
    return '';
  }
  for (const element of path.split(/[\\/]+/)) {
    // '.' and '..' are traversal, not names -- resolve() removes them before
    // this runs, and reporting '..' as the offending element would send the
    // operator looking for a folder that does not exist. A drive letter like
    // 'C:' has no leading dot. Anything else starting with one is fatal.
    if (element === '.' || element === '..') {
      continue;
    }
    if (element.length > 1 && element.startsWith('.')) {
      return element;
    }
  }
  return '';
}

/** Ghidra project names are used as filesystem names; keep them boring. */
export function deriveGhidraProjectName(binaryName: string, discriminator: string): string {
  const base = binaryName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = discriminator
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 8)
    .toLowerCase();
  const stem = base || 'binary';
  return suffix ? `${stem}-${suffix}` : stem;
}

// --- Containment ------------------------------------------------------------

function caseFold(value: string, caseInsensitive: boolean): string {
  return caseInsensitive ? value.toLowerCase() : value;
}

/** Is `candidate` the root itself or something underneath it? */
export function isPathWithinRoot(
  candidate: string,
  root: string,
  caseInsensitive: boolean = process.platform === 'win32',
): boolean {
  if (!candidate || !root) {
    return false;
  }
  const resolvedCandidate = caseFold(resolve(candidate), caseInsensitive);
  const resolvedRoot = caseFold(resolve(root), caseInsensitive);
  if (resolvedCandidate === resolvedRoot) {
    return true;
  }
  const withSep = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedCandidate.startsWith(withSep);
}

export interface GhidraLabPathResolution {
  ok: boolean;
  path: string;
  rootId: string;
  reason: string;
}

/**
 * Resolve a requested path against the registered roots. Rejects non-absolute
 * paths, shell metacharacters, and anything outside every root.
 *
 * Symlink resolution is the CALLER's job (it needs fs): this decides containment
 * for a path already made real, and must be re-run on the realpath.
 */
export function resolveGhidraPathWithinRoots(
  requestedPath: unknown,
  roots: readonly GhidraBinaryRoot[],
  caseInsensitive: boolean = process.platform === 'win32',
): GhidraLabPathResolution {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    return { ok: false, path: '', rootId: '', reason: 'missing_path' };
  }
  const trimmed = requestedPath.trim();
  if (trimmed.length > MAX_PATH_CHARS) {
    return { ok: false, path: '', rootId: '', reason: 'path_too_long' };
  }
  if (SHELL_METACHAR_REGEX.test(trimmed)) {
    return { ok: false, path: '', rootId: '', reason: 'shell_metacharacters' };
  }
  if (!isAbsolute(trimmed)) {
    return { ok: false, path: '', rootId: '', reason: 'path_not_absolute' };
  }
  if (roots.length === 0) {
    return { ok: false, path: '', rootId: '', reason: 'no_binary_roots' };
  }
  const resolved = resolve(trimmed);
  for (const root of roots) {
    if (isPathWithinRoot(resolved, root.path, caseInsensitive)) {
      return { ok: true, path: resolved, rootId: root.id, reason: '' };
    }
  }
  return { ok: false, path: resolved, rootId: '', reason: 'path_outside_roots' };
}

/**
 * Batch mode goes through `cmd.exe /c`, so every argument is re-parsed by cmd.
 * Anything cmd would treat as syntax has to be refused BEFORE the spawn, not
 * quoted around -- quoting rules there are not something to be clever about.
 */
export function isCmdSafeArgument(value: string): boolean {
  return !SHELL_METACHAR_REGEX.test(value) && !CMD_UNSAFE_REGEX.test(value);
}

// --- Argument vectors -------------------------------------------------------

/** How pyghidra-mcp gets launched once the preflight has decided it is reachable. */
export type PyghidraLaunchKind =
  // `<python> -m pyghidra_mcp ...` -- preferred: no console-script shim involved.
  | 'module'
  // `<pythonDir>/Scripts/pyghidra-mcp(.exe) ...` -- the console script, used when
  // the package ships no __main__.
  | 'script';

export interface GhidraLabCommand {
  program: string;
  args: string[];
}

/** `<pythonDir>/Scripts/pyghidra-mcp.exe` next to the configured interpreter. */
export function resolvePyghidraScriptPath(pythonExePath: string): string {
  if (!pythonExePath) {
    return '';
  }
  const lastSep = Math.max(pythonExePath.lastIndexOf('\\'), pythonExePath.lastIndexOf('/'));
  if (lastSep <= 0) {
    return '';
  }
  const dir = pythonExePath.slice(0, lastSep);
  if (process.platform === 'win32') {
    return join(dir, 'Scripts', 'pyghidra-mcp.exe');
  }
  return join(dir, 'pyghidra-mcp');
}

/**
 * Headless argument vector: pyghidra-mcp serving MCP over streamable-HTTP.
 *
 * Flag names are from the shipped CLI and are easy to get backwards:
 *   -p / --port INTEGER   (default 8000)
 *   -o / --host TEXT      (default 127.0.0.1)
 * `-o` is HOST, not output. Both are passed in long form here so the vector
 * reads correctly in the audit log.
 *
 * `--no-wait-for-analysis` is the CLI default and we keep it: the session
 * manager wants the server answering early so it can distinguish "JVM still
 * booting" from "analysis still running" and report which one the operator is
 * waiting on.
 */
export function buildPyghidraMcpCommand(params: {
  config: GhidraLabConfigView;
  launch: PyghidraLaunchKind;
  binaryPath: string;
  projectName: string;
  port: number;
  /**
   * True when a project of this name already exists on disk.
   *
   * The engine only analyses binaries it IMPORTED this run
   * (`if imported_programs or force_analysis`), and it does not re-import a
   * binary the project already holds. So a project left half-analysed -- by a
   * crash, a stopped server, or an analysis that stalled -- is never analysed
   * again, and every later session sits in 'starting' until the deadline.
   * Measured: three consecutive sessions parked forever on such a project.
   */
  projectExists?: boolean;
}): GhidraLabCommand {
  const args: string[] = [];
  let program = params.config.pythonExePath;
  if (params.launch === 'module') {
    args.push('-m', 'pyghidra_mcp');
  } else {
    program = resolvePyghidraScriptPath(params.config.pythonExePath);
  }
  args.push(
    '--transport',
    'streamable-http',
    '--host',
    '127.0.0.1',
    '--port',
    String(params.port),
    '--project-path',
    params.config.projectRoot,
    '--project-name',
    params.projectName,
    '--no-wait-for-analysis',
    // Symbol downloads are the difference between an analysis that finishes and
    // one that parks forever behind a filtering proxy, so the flag is always
    // explicit rather than left to the engine's default.
    params.config.symbolDownloads ? '--with-symbols' : '--no-symbols',
    params.binaryPath,
  );
  if (params.projectExists) {
    // Re-analysis costs time; a project that can never be analysed costs the
    // whole feature. Ghidra skips work that is genuinely already done.
    args.splice(args.length - 1, 0, '--force-analysis');
  }
  return { program, args };
}

/**
 * Batch argument vector: analyzeHeadless + our dump post-script.
 *
 * Routed through cmd.exe on Windows because Node will not spawn a .bat without a
 * shell. `-overwrite` is what makes a rerun idempotent: without it, importing the
 * same binary into an existing project fails instead of replacing it.
 */
export function buildAnalyzeHeadlessCommand(params: {
  config: GhidraLabConfigView;
  binaryPath: string;
  projectName: string;
  scriptDir: string;
  scriptName: string;
  outputPath: string;
}): GhidraLabCommand {
  const headless = resolveAnalyzeHeadlessPath(params.config);
  const args = [
    params.config.projectRoot,
    params.projectName,
    '-import',
    params.binaryPath,
    '-overwrite',
    '-scriptPath',
    params.scriptDir,
    '-postScript',
    params.scriptName,
    params.outputPath,
  ];
  if (process.platform !== 'win32') {
    return { program: headless, args };
  }
  return { program: process.env.ComSpec || 'cmd.exe', args: ['/c', headless, ...args] };
}

/**
 * The environment a Ghidra child runs in.
 *
 * `JAVA_HOME` is set unconditionally when configured: Ghidra checks JAVA_HOME
 * BEFORE PATH, so leaving the inherited value in place would silently hand it
 * the system JDK 11 and produce an interactive prompt instead of a failure.
 * The JDK's bin is also prepended to PATH for the tools Ghidra shells out to.
 */
export function buildGhidraChildEnv(
  config: GhidraLabConfigView,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  if (config.jdkHome) {
    env.JAVA_HOME = config.jdkHome;
    const jdkBin = join(config.jdkHome, 'bin');
    const currentPath = env.PATH ?? env.Path ?? '';
    const nextPath = currentPath ? `${jdkBin}${delimiter}${currentPath}` : jdkBin;
    env.PATH = nextPath;
    // Windows env objects can carry either spelling; keep them in step or the
    // child resolves against a stale one.
    if (env.Path !== undefined) {
      env.Path = nextPath;
    }
  }
  if (config.ghidraInstallDir) {
    env.GHIDRA_INSTALL_DIR = config.ghidraInstallDir;
  }
  if (config.maxMemMb > 0) {
    const value = `${config.maxMemMb}M`;
    env.GHIDRA_MAXMEM = value;
    // analyzeHeadless reads the headless-specific name first.
    env.GHIDRA_HEADLESS_MAXMEM = value;
  }
  return env;
}

// --- Problems ---------------------------------------------------------------

export interface GhidraLabConfigProblem {
  code: string;
  detail: string;
}

/** Everything wrong with the current config, for the app's setup panel. */
export function listGhidraLabConfigProblems(
  config: GhidraLabConfigView,
  mode: GhidraLabSessionMode,
): GhidraLabConfigProblem[] {
  const problems: GhidraLabConfigProblem[] = [];
  if (!config.ghidraInstallDir) {
    problems.push({
      code: 'ghidra_install_dir_missing',
      detail: 'Set the Ghidra installation folder (the one containing support/ and Ghidra/).',
    });
  }
  if (!config.jdkHome) {
    problems.push({
      code: 'jdk_home_missing',
      detail:
        'Set a JDK 21+ home. GhidraLab injects it only into the Ghidra process, so the system JAVA_HOME can stay where it is.',
    });
  }
  if (mode === 'headless' && !config.pythonExePath) {
    problems.push({
      code: 'python_path_missing',
      detail:
        'Headless (MCP) mode needs a Python interpreter with pyghidra-mcp installed. Batch mode works without one.',
    });
  }
  if (!config.projectRoot) {
    problems.push({
      code: 'project_root_missing',
      detail: 'Set a folder for Ghidra projects. Reusing projects is what makes a rerun cheap.',
    });
  }
  if (config.binaryRoots.length === 0) {
    problems.push({
      code: 'no_binary_roots',
      detail: 'Add at least one folder that binaries may be analyzed from.',
    });
  }
  return problems;
}
