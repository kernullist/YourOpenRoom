// Shared IDA Lab (native IDA + IDASQL) types.
//
// Browser-safe by construction: no node builtins, no fs/path/crypto. The app UI,
// the Aoi tool layer and the server plugin all speak these shapes, so this file
// must stay importable from client code (see the client-bundle rule: a lib module
// that reaches for node crypto/fs breaks `pnpm build` even when tests pass).

/** How the IDA engine is reached for a session. */
export type IdaSqlSessionMode =
  // Headless idalib: `idasql -s <binary> --http <port>`. No GUI window; idasql
  // drives auto-analysis itself. The default for automation.
  | 'headless'
  // Native IDA GUI: `ida.exe <binary>` is launched for the operator, and the
  // in-GUI idasql plugin's HTTP server (`.http start`) is attached to by probe.
  | 'gui';

export type IdaSqlSessionState =
  // Spawned, waiting for /status to answer (idalib auto-analysis runs here).
  | 'starting'
  // /status answered: SQL can be issued.
  | 'ready'
  // The process exited or never became reachable.
  | 'failed'
  // Shut down on purpose.
  | 'stopped';

/** A single SQL statement's classification (see idaSqlPolicy). */
export type IdaSqlStatementClass =
  // Pure query: forwarded without an approval.
  | 'read'
  // Mutates the database: needs a content-addressed operator approval per query,
  // and only lands on disk when the session was started in write mode (-w).
  | 'write'
  // Not an analysis query at all -- a host escape (ATTACH, writefile(), dot
  // commands that touch the filesystem or start servers). Refused even with an
  // approval; there is no approval flow that makes these in-scope.
  | 'forbidden';

export interface IdaSqlStatementInfo {
  sql: string;
  statementClass: IdaSqlStatementClass;
  /** Populated for 'forbidden': the token that disqualified the statement. */
  reason?: string;
}

export interface IdaSqlBinaryRoot {
  id: string;
  path: string;
  label: string;
}

/** Operator settings, persisted under the `idaSql` key of the shared config. */
export interface IdaSqlConfigView {
  /** Absolute path to ida.exe (GUI mode) -- also the source of the IDA directory. */
  idaExePath: string;
  /** Absolute path to idasql(.exe). Must sit next to the IDA binary. */
  idasqlExePath: string;
  defaultMode: IdaSqlSessionMode;
  binaryRoots: IdaSqlBinaryRoot[];
  httpPortStart: number;
  httpPortEnd: number;
  sessionIdleTimeoutMs: number;
  /**
   * Operator opt-in for write sessions. The `os_ida_write` capability still has
   * to be on and every write query still needs its own approval; this is the
   * app-level switch so a read-only setup cannot be talked into `-w`.
   */
  writeEnabled: boolean;
}

export interface IdaSqlHealthView {
  configured: boolean;
  config: IdaSqlConfigView;
  /** Does idasql exist at the configured path? */
  idasqlPresent: boolean;
  /** `idasql --version` output, when it could be probed. */
  idasqlVersion: string;
  idaExePresent: boolean;
  /** The directory placed on PATH for idasql -- where the IDA engine must live. */
  idaDirectory: string;
  /** Is the IDA engine actually in that directory? */
  idaEnginePresent: boolean;
  /**
   * Where the idasql IDA PLUGIN is installed, or '' if it is not.
   *
   * Distinct from idasqlExePath: the CLI serves a headless session, the plugin
   * is what puts `.http start` inside the IDA window. GUI mode is impossible
   * without it, and nothing used to check.
   */
  idaSqlPluginPath: string;
  /** Is idalib present next to the IDA binary (headless mode needs it)? */
  idalibPresent: boolean;
  /** Kill-switch capability state, mirrored so the app can explain a refusal. */
  analysisCapabilityEnabled: boolean;
  writeCapabilityEnabled: boolean;
  autoSessionCapabilityEnabled: boolean;
  globalPanic: boolean;
  problems: string[];
}

export interface IdaSqlBrowseEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  sizeBytes: number;
  /** True for extensions worth handing to IDA (.exe/.dll/.sys/.i64/...). */
  analyzable: boolean;
}

export interface IdaSqlBrowseView {
  path: string;
  rootId: string;
  parentPath: string;
  entries: IdaSqlBrowseEntry[];
  truncated: boolean;
}

/**
 * What can honestly be said about an analysis that is still running.
 *
 * There is no percentage here on purpose. Measured against a real install:
 * idasql prints `Opening: <path>...` and then emits NOTHING until analysis
 * finishes -- no progress lines, and `--help` exposes no verbosity flag. So the
 * only observable signals are time and the database growing on disk, and
 * neither can be turned into a fraction without knowing a total that nothing
 * reports. A made-up bar would be worse than no bar.
 */
export interface IdaSqlSessionProgress {
  /** Total bytes across the IDA database sidecar files, at sampledAt. */
  databaseBytes: number;
  /** Growth since the previous sample. Zero means no visible work that tick. */
  deltaBytes: number;
  /** When databaseBytes was measured. */
  sampledAt: number;
  /** Samples taken so far -- lets the UI distinguish "no data yet" from "flat". */
  sampleCount: number;
}

export interface IdaSqlSessionView {
  id: string;
  binaryPath: string;
  binaryName: string;
  mode: IdaSqlSessionMode;
  write: boolean;
  state: IdaSqlSessionState;
  port: number;
  pid: number | null;
  startedAt: number;
  readyAt: number | null;
  lastUsedAt: number;
  queryCount: number;
  /** Why a session is in 'failed' (spawn error, probe timeout, early exit). */
  failureReason: string;
  /**
   * Functions this engine exposes that the policy has never reviewed.
   *
   * Non-empty means the installed idasql is newer or different from the build
   * the function classification was written against. Statements calling one of
   * these are treated as writes, so nothing is unguarded -- but the operator
   * should be told, because it means the review is stale.
   */
  unreviewedFunctions: string[];
  /** Live analysis signal while state is 'starting'. Null before the first sample. */
  progress: IdaSqlSessionProgress | null;
}

export interface IdaSqlQueryResultSet {
  columns: string[];
  rows: string[][];
  rowCount: number;
  truncated: boolean;
}

export interface IdaSqlQueryView {
  sessionId: string;
  statementClass: IdaSqlStatementClass;
  statements: IdaSqlStatementInfo[];
  resultSets: IdaSqlQueryResultSet[];
  elapsedMs: number;
  /** idasql's own error text when the query was rejected by the engine. */
  engineError: string;
}

/** Preview envelope shared by session-start and write-query approvals. */
export interface IdaSqlApprovalView {
  approvalFingerprint: string;
  capability: string;
  targetSummary: string;
  expiresAt: number;
  /** True when a live standing grant already covers this action. */
  autoApproved: boolean;
}

export interface IdaSqlSessionPreviewView extends IdaSqlApprovalView {
  binaryPath: string;
  mode: IdaSqlSessionMode;
  write: boolean;
  program: string;
  args: string[];
  blockReasons: string[];
  allowed: boolean;
  /**
   * Set only when blockReasons carries 'session_already_open': the session that
   * already holds this binary's database. Not a configuration problem -- the
   * caller should reuse this session rather than ask the operator to fix
   * anything.
   */
  existingSessionId?: string;
}

export interface IdaSqlWritePreviewView extends IdaSqlApprovalView {
  sessionId: string;
  sql: string;
  statements: IdaSqlStatementInfo[];
  blockReasons: string[];
  allowed: boolean;
}

export interface IdaSqlStandingGrantView {
  id: string;
  rootId: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  maxSessions: number;
  usedSessions: number;
}

export const IDA_SQL_ANALYSIS_CAPABILITY = 'os_ida_analysis';
export const IDA_SQL_WRITE_CAPABILITY = 'os_ida_write';
export const IDA_SQL_AUTO_SESSION_CAPABILITY = 'os_ida_auto_session';

/** Extensions IDA can reasonably be pointed at. */
export const IDA_SQL_ANALYZABLE_EXTENSIONS: readonly string[] = [
  '.exe',
  '.dll',
  '.sys',
  '.ocx',
  '.cpl',
  '.scr',
  '.efi',
  '.bin',
  '.elf',
  '.so',
  '.o',
  '.obj',
  '.a',
  '.lib',
  '.dylib',
  '.macho',
  '.ko',
  '.idb',
  '.i64',
  '.dmp',
  '.apk',
  '.dex',
  '.pyc',
  '.nro',
  '.nso',
];

export function isIdaSqlAnalyzableName(name: string): boolean {
  const lowered = name.toLowerCase();
  const dot = lowered.lastIndexOf('.');
  if (dot < 0) {
    // Extension-less files are common on POSIX targets; treat them as candidates.
    return true;
  }
  return IDA_SQL_ANALYZABLE_EXTENSIONS.includes(lowered.slice(dot));
}
