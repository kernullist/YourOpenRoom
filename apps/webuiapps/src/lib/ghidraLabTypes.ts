// Shared Ghidra Lab (headless Ghidra + pyghidra-mcp) types.
//
// Browser-safe by construction: no node builtins, no fs/path/crypto. The app UI,
// the Aoi tool layer and the server plugin all speak these shapes, so this file
// must stay importable from client code (see the client-bundle rule: a lib module
// that reaches for node crypto/fs breaks `pnpm build` even when tests pass).
//
// Sibling of idaSqlTypes: the two labs are deliberately shaped alike (roots are
// the reach limit, sessions have the same four states, approvals carry the same
// envelope) so an operator who has learned one already knows the other.

/** How the Ghidra engine is reached for a session. */
export type GhidraLabSessionMode =
  // pyghidra-mcp serving MCP over streamable-HTTP on a loopback port. Long-lived,
  // answers follow-up questions, keeps the Ghidra project open. The default.
  | 'headless'
  // `analyzeHeadless.bat` + our GhidraLabDump post-script: a one-shot JSON dump
  // with no session and no follow-up. The degraded path for a machine with no
  // usable Python, and the only mode that needs nothing but Ghidra + a JDK.
  | 'batch'
  // Reserved for G8: attach to a Ghidra window the operator launched themselves.
  | 'gui';

export type GhidraLabSessionState =
  // Spawned, not yet answering. Two distinct waits live here -- JVM boot, then
  // Ghidra auto-analysis -- and `progress.phase` says which one we are in.
  | 'starting'
  // MCP initialize succeeded and the target binary reports analysis complete.
  | 'ready'
  // The process exited, never became reachable, or blew its analysis deadline.
  | 'failed'
  // Shut down on purpose.
  | 'stopped';

export interface GhidraBinaryRoot {
  id: string;
  path: string;
  label: string;
}

/** Operator settings, persisted under the `ghidraLab` key of the shared config. */
export interface GhidraLabConfigView {
  /** Ghidra installation root -- the folder holding `support/` and `Ghidra/`. */
  ghidraInstallDir: string;
  /**
   * JDK 21+ home, injected as JAVA_HOME into the Ghidra child ONLY.
   *
   * Never the system JAVA_HOME: this machine's system JDK is 11 and other
   * toolchains depend on that staying true. Ghidra 12 needs 21, and if it cannot
   * find one it PROMPTS INTERACTIVELY -- which in a spawned child is a hang, not
   * an error. So the version is checked here before anything is spawned.
   */
  jdkHome: string;
  /** Python interpreter that has pyghidra-mcp importable. Blank -> batch mode only. */
  pythonExePath: string;
  /** Where .gpr projects are created. Reused across runs, which is what makes reruns cheap. */
  projectRoot: string;
  /** -> GHIDRA_MAXMEM. Ghidra's own headless default is 2G, too small for a game binary. */
  maxMemMb: number;
  /** THE reach limit. Empty means nothing can be analyzed -- fail-closed. */
  binaryRoots: GhidraBinaryRoot[];
  httpPortStart: number;
  httpPortEnd: number;
  sessionIdleTimeoutMs: number;
  /** Wall clock for one analysis before the session is declared failed. */
  analysisTimeoutMs: number;
  /** Optional second engine: capa, for rule-backed ATT&CK/MBC capability matching. */
  capaExePath: string;
  /**
   * Optional third engine: FLOSS, for strings that are not in the binary as text.
   *
   * Stack strings, tight strings and strings a routine decodes at run time are
   * invisible to a string dump, and on anything obfuscated they are most of the
   * interesting ones. FLOSS recovers them by emulating the code that builds them.
   */
  flossExePath: string;
  /**
   * Let Ghidra download PDBs from Microsoft's symbol server during analysis.
   *
   * OFF by default, which is the opposite of pyghidra-mcp's own default, for two
   * measured reasons:
   *
   *   - It hangs behind a filtering proxy. On this machine analysis parked at
   *     ~38s of CPU and never advanced; the engine was waiting on a symbol
   *     request that never returned, and the session sat in 'starting' until the
   *     analysis deadline.
   *   - The binaries this lab exists for -- game clients, anti-cheat modules,
   *     third-party drivers -- have no public PDBs anyway, so the wait buys
   *     nothing.
   *
   * Turn it on for Microsoft-signed system binaries on a network that can reach
   * msdl.microsoft.com, where it does improve naming.
   */
  symbolDownloads: boolean;
  /**
   * Operator opt-in for Ghidra-database writes (rename/comment/prototype).
   *
   * Ghidra never touches the original binary -- it analyzes an imported copy --
   * so this is narrower than IdaLab's equivalent. It still defaults off: a
   * renamed database is shared state the operator may be mid-way through.
   */
  writeEnabled: boolean;
}

/** One row of the setup panel's preflight table. */
export interface GhidraLabPreflightCheck {
  /** Stable id for tests and for the UI to key rows: 'ghidra' | 'jdk' | 'python' | ... */
  id: string;
  label: string;
  ok: boolean;
  /** What was actually found ("Ghidra 12.1.3", "Java 11.0.14", "not installed"). */
  found: string;
  /** Empty when ok. Otherwise what the operator should do, in one sentence. */
  remedy: string;
  /** False when the check is not required for the currently selected mode. */
  required: boolean;
}

export interface GhidraLabHealthView {
  configured: boolean;
  config: GhidraLabConfigView;
  /** Every check, in display order, whether it passed or not. */
  checks: GhidraLabPreflightCheck[];
  /** Modes that could actually start right now, given the checks. */
  availableModes: GhidraLabSessionMode[];
  ghidraVersion: string;
  jdkVersion: string;
  jdkMajor: number;
  pyghidraMcpVersion: string;
  capaVersion: string;
  /** Kill-switch capability state, mirrored so the app can explain a refusal. */
  analysisCapabilityEnabled: boolean;
  writeCapabilityEnabled: boolean;
  autoSessionCapabilityEnabled: boolean;
  globalPanic: boolean;
  problems: string[];
}

export interface GhidraLabBrowseEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  sizeBytes: number;
  /** True for extensions Ghidra can reasonably import. */
  analyzable: boolean;
}

export interface GhidraLabBrowseView {
  path: string;
  rootId: string;
  parentPath: string;
  entries: GhidraLabBrowseEntry[];
  truncated: boolean;
}

/**
 * What can honestly be said about a session that is still starting.
 *
 * Unlike idasql, we DO have two observable phases here: the MCP endpoint starts
 * answering well before Ghidra finishes auto-analysis (pyghidra-mcp is async by
 * design and ships a --wait-for-analysis flag precisely because of this). So the
 * phase is real information, not a guess. There is still no percentage: Ghidra
 * reports analysis as done/not-done, never as a fraction.
 */
export interface GhidraLabSessionProgress {
  /** 'jvm' = process up, MCP not answering yet. 'analysis' = MCP up, binary not analyzed. */
  phase: 'jvm' | 'analysis';
  /** Project database bytes at sampledAt -- the only growth signal available. */
  projectBytes: number;
  deltaBytes: number;
  sampledAt: number;
  sampleCount: number;
}

export interface GhidraLabSessionView {
  id: string;
  binaryPath: string;
  binaryName: string;
  /** Ghidra project this session opened. Reused when the same binary comes back. */
  projectName: string;
  mode: GhidraLabSessionMode;
  write: boolean;
  state: GhidraLabSessionState;
  port: number;
  pid: number | null;
  startedAt: number;
  readyAt: number | null;
  lastUsedAt: number;
  queryCount: number;
  failureReason: string;
  progress: GhidraLabSessionProgress | null;
}

/** The read sub-commands `ghidra_query` accepts. Anything else is refused. */
export type GhidraQueryKind =
  | 'metadata'
  | 'functions'
  | 'imports'
  | 'exports'
  | 'strings'
  | 'symbols'
  | 'xrefs'
  | 'decompile'
  | 'callgraph'
  | 'search';

export const GHIDRA_QUERY_KINDS: readonly GhidraQueryKind[] = [
  'metadata',
  'functions',
  'imports',
  'exports',
  'strings',
  'symbols',
  'xrefs',
  'decompile',
  'callgraph',
  'search',
];

export function isGhidraQueryKind(value: unknown): value is GhidraQueryKind {
  return typeof value === 'string' && (GHIDRA_QUERY_KINDS as readonly string[]).includes(value);
}

export interface GhidraQueryView {
  sessionId: string;
  kind: GhidraQueryKind;
  /** The MCP tool the sub-command mapped to, so the audit trail is honest. */
  mcpTool: string;
  /** Rows/records as returned, already truncated to the per-call cap. */
  rows: unknown[];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
  engineError: string;
}

/** Preview envelope shared by session-start and sweep approvals. */
export interface GhidraLabApprovalView {
  approvalFingerprint: string;
  capability: string;
  targetSummary: string;
  expiresAt: number;
  /** True when a live standing grant already covers this action. */
  autoApproved: boolean;
}

export interface GhidraLabSessionPreviewView extends GhidraLabApprovalView {
  binaryPath: string;
  mode: GhidraLabSessionMode;
  write: boolean;
  program: string;
  args: string[];
  blockReasons: string[];
  allowed: boolean;
  /** Set when blockReasons carries 'session_already_open': reuse this instead. */
  existingSessionId?: string;
}

export interface GhidraLabStandingGrantView {
  id: string;
  rootId: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  maxSessions: number;
  usedSessions: number;
}

// --- Sweep + report -------------------------------------------------------

/** The ten stages of a full-binary sweep, in execution order. */
export type GhidraSweepStage =
  | 'identity'
  | 'imports'
  | 'exports'
  | 'strings'
  // Strings that are not in the binary as text: stack strings, tight strings and
  // strings a routine decodes at run time. Runs right after the plain string
  // stage because the later stages read its output.
  | 'decodedstrings'
  | 'inventory'
  | 'selection'
  | 'deepread'
  // What the import table does not show: GetProcAddress/LoadLibrary resolution
  // and API hashing. Needs the decompiled bodies, so it follows deepread.
  | 'dynapi'
  | 'capability'
  // Control-flow flattening, opaque predicates, MBA density, packer sections.
  | 'obfuscation'
  | 'structure'
  // Reachability and ordering: which APIs are reachable from the entry, in what
  // order, and which known chains that ordering matches. Last of the
  // deterministic stages because it consumes all of them.
  | 'behavior'
  | 'synthesis';

export const GHIDRA_SWEEP_STAGES: readonly GhidraSweepStage[] = [
  'identity',
  'imports',
  'exports',
  'strings',
  'decodedstrings',
  'inventory',
  'selection',
  'deepread',
  'dynapi',
  'capability',
  'obfuscation',
  'structure',
  'behavior',
  'synthesis',
];

/** Which stages are produced by code rather than by the model. */
export const GHIDRA_DETERMINISTIC_STAGES: readonly GhidraSweepStage[] = [
  'identity',
  'imports',
  'exports',
  'strings',
  'inventory',
  'capability',
  'structure',
];

export type GhidraSweepStageState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface GhidraSweepStageView {
  stage: GhidraSweepStage;
  state: GhidraSweepStageState;
  startedAt: number | null;
  finishedAt: number | null;
  /** One line the UI can show: "412 imports across 14 DLLs". */
  summary: string;
  /** Why a stage was skipped ('capa_not_configured') or failed. */
  detail: string;
}

/**
 * A citable fact. Every claim in the report must name one of these by id, or the
 * verifier cuts the claim.
 *
 * The id format is `<kind>:<key>` and is stable within a run, so a report
 * sentence carrying `[fn:0x140001000]` can always be resolved back to the ledger
 * entry that justifies it.
 */
export type GhidraAnchorKind =
  | 'header'
  | 'section'
  | 'import'
  | 'export'
  | 'string'
  | 'function'
  | 'xref'
  | 'capa'
  | 'callgraph'
  // A rolled-up anti-analysis finding. Its own kind because its evidence is not
  // always a symbol -- it can be a section name or a string.
  | 'indicator'
  // A string that was NOT visible statically: built on the stack, or produced by
  // a decoder inside the binary and recovered by emulating it. Its own kind
  // because the evidence includes the routine that produced it, which a plain
  // string anchor has nowhere to put.
  | 'decoded'
  // An API the binary resolves at run time instead of importing. The import
  // table of an obfuscated binary is a lie by omission, and these are the rest.
  | 'dynapi'
  // An obfuscation construct found at a location, with what would undo it.
  | 'obfuscation'
  // An ordered chain of APIs reachable from a named entry. Reachability and
  // ordering -- never a claim that the binary was observed doing it.
  | 'behavior';

export interface GhidraEvidenceAnchor {
  id: string;
  kind: GhidraAnchorKind;
  /** Which binary in the project this came from (a project can hold several). */
  binary: string;
  address: string;
  symbol: string;
  /** The fact itself, verbatim where it came from a tool rather than a model. */
  detail: string;
  /** False when a model produced this text (a deep-read summary). */
  deterministic: boolean;
}

export interface GhidraSweepLedger {
  runId: string;
  binaryPath: string;
  binaryName: string;
  sha256: string;
  sizeBytes: number;
  createdAt: number;
  anchors: GhidraEvidenceAnchor[];
  stages: GhidraSweepStageView[];
  /** Free-form per-stage payloads (import table, section table, capa json, ...). */
  facts: Record<string, unknown>;
}

export type GhidraReportRunState =
  | 'queued'
  | 'running'
  | 'drafting'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface GhidraReportRunView {
  runId: string;
  sessionId: string;
  binaryPath: string;
  binaryName: string;
  state: GhidraReportRunState;
  stages: GhidraSweepStageView[];
  startedAt: number;
  finishedAt: number | null;
  /** Anchors collected so far -- the UI shows this growing during a long sweep. */
  anchorCount: number;
  /** Claims the verifier removed for having no anchor. Reported, never hidden. */
  droppedClaims: number;
  reportPath: string;
  ledgerPath: string;
  failureReason: string;
}

export const GHIDRA_ANALYSIS_CAPABILITY = 'os_ghidra_analysis';
export const GHIDRA_WRITE_CAPABILITY = 'os_ghidra_write';
export const GHIDRA_AUTO_SESSION_CAPABILITY = 'os_ghidra_auto_session';

/** The JDK major Ghidra 12.x requires. Below this, do not spawn -- it hangs. */
export const GHIDRA_MIN_JDK_MAJOR = 21;

/** Extensions Ghidra can reasonably import. */
export const GHIDRA_ANALYZABLE_EXTENSIONS: readonly string[] = [
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
  '.apk',
  '.dex',
  '.jar',
  '.class',
  '.nro',
  '.nso',
  '.gzf',
];

export function isGhidraAnalyzableName(name: string): boolean {
  const lowered = name.toLowerCase();
  const dot = lowered.lastIndexOf('.');
  if (dot < 0) {
    // Extension-less files are common on POSIX targets; treat them as candidates.
    return true;
  }
  return GHIDRA_ANALYZABLE_EXTENSIONS.includes(lowered.slice(dot));
}

// --- Anchor ids -------------------------------------------------------------
//
// Anchor ids are built HERE and nowhere else.
//
// They were originally formatted at both ends -- the sweep when it recorded an
// anchor, the report when it cited one -- and the two drifted: the sweep wrote
// `import:ntdll.dll!NtLoadDriver` while the report cited `import:NtLoadDriver`,
// so the enforcement pass stripped the report's own citations as invented. The
// enforcement caught it, which is the system working, but the fix is to have one
// definition of the id rather than two that agree by luck.
//
// The library is deliberately NOT part of an import id: capability signals and
// anti-analysis indicators carry symbols alone, and a citation has to be
// constructible from what the citing code actually holds. Which library a symbol
// came from lives in the anchor's detail instead.

export function importAnchorId(symbol: string): string {
  return `import:${symbol}`;
}

export function exportAnchorId(name: string, address = ''): string {
  return `export:${name || address}`;
}

export function stringAnchorId(address: string, value: string): string {
  return `string:${address || value.slice(0, 40)}`;
}

export function functionAnchorId(address: string, name: string): string {
  return `function:${address || name}`;
}

export function capaAnchorId(rule: string): string {
  return `capa:${rule}`;
}

export function callgraphAnchorId(root: string): string {
  return `callgraph:${root}`;
}

export function indicatorAnchorId(code: string): string {
  return `indicator:${code}`;
}

/**
 * A recovered string, keyed by where it came from.
 *
 * The decoding routine is part of the identity on purpose: the same plaintext
 * decoded by two different routines is two findings, and a report that collapses
 * them loses the fact that the binary has two decoders.
 */
export function decodedAnchorId(routine: string, value: string): string {
  // The value goes into the id, so it must survive being written as a citation.
  // A recovered string carrying `]` would end the bracket early: the report
  // would cite a truncated id, enforcement would not find it, and the line
  // would be deleted as invented -- losing the very finding FLOSS just made.
  const safe = value
    .slice(0, 32)
    .replace(/[[\]\r\n]+/g, ' ')
    .trim();
  return `decoded:${routine || 'unknown'}:${safe}`;
}

export function dynApiAnchorId(symbol: string): string {
  return `dynapi:${symbol}`;
}

export function obfuscationAnchorId(code: string, where: string): string {
  return `obfuscation:${code}${where ? `:${where}` : ''}`;
}

export function behaviorAnchorId(code: string): string {
  return `behavior:${code}`;
}
