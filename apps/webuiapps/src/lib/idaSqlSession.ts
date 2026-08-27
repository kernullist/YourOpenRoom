// IDA Lab session manager: owns the lifetime of every idasql HTTP server this
// machine has started, and is the only place SQL is put on the wire.
//
// Shape of a session:
//   headless - we spawn `idasql -s <binary> --http <port>` ourselves. idalib runs
//              the auto-analysis, so the session is 'starting' until /status
//              answers; a big binary can sit there for minutes.
//   gui      - the operator's real IDA window is launched with the binary, and the
//              in-GUI idasql plugin serves HTTP on a port it picks itself from
//              8100-8199 after `.http start`. We cannot be told that port, so we
//              probe the window and attach. pid stays null: that process belongs
//              to the operator, not to us, and we must never kill it.
//
// Every effect is injected (spawn, http, clock, sleep) so the whole lifecycle is
// unit-testable without IDA installed. The production wiring lives in
// createIdaSqlNodeDeps.
//
// Server-only: child_process / net.
import { spawn } from 'child_process';
import { statSync } from 'fs';
import { randomBytes } from 'crypto';
import { createServer } from 'net';
import { delimiter } from 'path';
import type {
  IdaSqlConfigView,
  IdaSqlSessionProgress,
  IdaSqlQueryResultSet,
  IdaSqlSessionMode,
  IdaSqlSessionState,
  IdaSqlSessionView,
} from './idaSqlTypes';
import { KNOWN_IDASQL_FUNCTIONS } from './idaSqlPolicy';
import {
  IDA_SQL_GUI_PROBE_PORT_END,
  IDA_SQL_GUI_PROBE_PORT_START,
  buildIdaGuiArgs,
  buildIdaSqlHeadlessArgs,
  resolveIdaDirectory,
} from './idaSqlConfig';

/** Concurrent live sessions this machine will hold. Exported so the routes can
 *  refuse a start at preview time instead of at execute time. */
export const IDA_SQL_MAX_SESSIONS = 8;
const MAX_SESSIONS = IDA_SQL_MAX_SESSIONS;
// idalib auto-analysis on a large binary is slow; this is the wall for going
// 'starting' -> 'ready', not a query timeout.
const READY_TIMEOUT_MS = 10 * 60 * 1000;
const READY_POLL_MIN_MS = 500;
const READY_POLL_MAX_MS = 2000;
// Above idasql's OWN limits, deliberately. Read from a live install:
//   query_timeout_ms            = 60000   (the engine aborts the query)
//   queue_admission_timeout_ms  = 120000  (the wait for a slot when queued)
// A client timeout of exactly 120s sat on top of the second one, so a saturated
// queue could have the client abort at the same moment the server admitted the
// query -- an ambiguous failure with two plausible causes. Letting the engine be
// the timeout authority means every timeout arrives as an engine error that says
// what happened; this is only a backstop for a server that stopped answering.
const QUERY_TIMEOUT_MS = 150 * 1000;
const PROBE_TIMEOUT_MS = 1500;
const OUTPUT_TAIL_CHARS = 4000;
const MAX_RESULT_ROWS = 500;
const MAX_CELL_CHARS = 2000;

export interface IdaSqlChildHandle {
  pid: number | null;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onOutput(listener: (chunk: string) => void): void;
  kill(): void;
}

export interface IdaSqlHttpResponse {
  status: number;
  text: string;
}

export interface IdaSqlSessionDeps {
  spawnProcess(
    program: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      /**
       * This child has a UI the operator drives, and is not ours to manage.
       *
       * The two cases genuinely differ. A headless idasql is our process: we
       * hide its console, read its output, and it dies with us. The operator's
       * IDA is the opposite on all three counts -- see nodeSpawn, where reusing
       * the headless options meant IDA ran with no window at all.
       */
      interactive?: boolean;
    },
  ): IdaSqlChildHandle;
  httpRequest(
    url: string,
    init: { method: 'GET' | 'POST'; body?: string; timeoutMs: number; token?: string },
  ): Promise<IdaSqlHttpResponse>;
  /** Per-session bearer token generator. Injected so tests are deterministic. */
  createToken?(): string;
  now(): number;
  sleep(ms: number): Promise<void>;
  isPortFree(port: number): Promise<boolean>;
  /**
   * Total bytes of the IDA database sidecars beside `binaryPath`.
   *
   * The only honest progress signal there is: idasql emits nothing at all while
   * it analyzes (measured), so the database growing on disk is what tells the
   * operator work is happening. Injected so tests do not touch a filesystem.
   */
  databaseBytes?(binaryPath: string): number;
  /** Called once per successful spawn so the caller can audit the pid. */
  onSpawned?(spawned: { pid: number; imageName: string }): void;
  logError?(message: string, error?: unknown): void;
}

interface SessionRecord {
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
  failureReason: string;
  outputTail: string;
  child: IdaSqlChildHandle | null;
  // Bearer token this session's HTTP server was started with. Empty for a GUI
  // session, whose server the operator started themselves.
  token: string;
  // Non-builtin functions this engine exposes that the policy has never
  // reviewed. See reviewSessionFunctions.
  unreviewedFunctions: Set<string>;
  // Queries in flight right now. A session executing a query is not idle, and
  // lastUsedAt cannot say so on its own: it is stamped when a query RETURNS, so
  // for the whole duration of a slow query it still reads as the previous use.
  // See reapIdle.
  activeQueries: number;
  progress: IdaSqlSessionProgress | null;
}

export interface IdaSqlStartResult {
  ok: boolean;
  session: IdaSqlSessionView | null;
  /**
   * Set only alongside reason 'session_already_open': the session that already
   * holds this binary's database, so the caller can reuse it instead of retrying.
   */
  existingSessionId?: string;
  reason: string;
}

export interface IdaSqlQueryOutcome {
  ok: boolean;
  resultSets: IdaSqlQueryResultSet[];
  engineError: string;
  elapsedMs: number;
  reason: string;
}

function baseName(path: string): string {
  const lastSep = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return lastSep >= 0 ? path.slice(lastSep + 1) : path;
}

function truncateTail(current: string, addition: string): string {
  const merged = current + addition;
  return merged.length > OUTPUT_TAIL_CHARS ? merged.slice(-OUTPUT_TAIL_CHARS) : merged;
}

function isTerminalSessionState(record: SessionRecord): boolean {
  return record.state === 'failed' || record.state === 'stopped';
}

// Windows NTSTATUS codes that arrive as a negative exit code. 0xC0000135 is the
// one that matters here: it is what idasql does when the IDA directory is not on
// PATH -- it dies before printing a single line, so the exit code is the ONLY
// evidence, and "exited (code=-1073741515)" tells nobody anything.
const WINDOWS_EXIT_REASONS: Readonly<Record<number, string>> = {
  [-1073741515]:
    'a required DLL was not found (0xC0000135) -- the IDA install directory is almost certainly not on PATH, so idasql could not load the IDA engine. Check the ida.exe path in Setup.',
  [-1073741701]:
    'the image is not a valid Win32 application (0xC000007B) -- usually a 32/64-bit mismatch between idasql and IDA.',
  [-1073741819]: 'access violation (0xC0000005) -- idasql crashed.',
};

export function describeExit(code: number | null, signal: string | null): string {
  if (typeof code === 'number' && WINDOWS_EXIT_REASONS[code]) {
    return WINDOWS_EXIT_REASONS[code];
  }
  return `exited (code=${code}, signal=${signal})`;
}

function toView(record: SessionRecord): IdaSqlSessionView {
  return {
    id: record.id,
    binaryPath: record.binaryPath,
    binaryName: record.binaryName,
    mode: record.mode,
    write: record.write,
    state: record.state,
    port: record.port,
    pid: record.pid,
    startedAt: record.startedAt,
    readyAt: record.readyAt,
    lastUsedAt: record.lastUsedAt,
    queryCount: record.queryCount,
    failureReason: record.failureReason,
    unreviewedFunctions: [...record.unreviewedFunctions].sort(),
    progress: record.progress ? { ...record.progress } : null,
  };
}

function asStringCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}...` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const encoded = JSON.stringify(value) ?? '';
  return encoded.length > MAX_CELL_CHARS ? `${encoded.slice(0, MAX_CELL_CHARS)}...` : encoded;
}

function resultSetFromColumnsRows(
  columns: unknown,
  rows: unknown,
  declaredRowCount?: number,
): IdaSqlQueryResultSet | null {
  if (!Array.isArray(rows)) {
    return null;
  }
  const columnNames = Array.isArray(columns) ? columns.map((column) => asStringCell(column)) : [];
  const limited = rows.slice(0, MAX_RESULT_ROWS);
  const normalizedRows = limited.map((row) => {
    if (Array.isArray(row)) {
      return row.map((cell) => asStringCell(cell));
    }
    if (row && typeof row === 'object') {
      const record = row as Record<string, unknown>;
      const keys = columnNames.length > 0 ? columnNames : Object.keys(record);
      return keys.map((key) => asStringCell(record[key]));
    }
    return [asStringCell(row)];
  });
  const inferredColumns =
    columnNames.length > 0
      ? columnNames
      : rows.length > 0 && rows[0] && typeof rows[0] === 'object' && !Array.isArray(rows[0])
        ? Object.keys(rows[0] as Record<string, unknown>)
        : (normalizedRows[0]?.map((_, index) => `col${index + 1}`) ?? []);
  return {
    columns: inferredColumns,
    rows: normalizedRows,
    // Prefer the count idasql declares over the array length: it is the honest
    // source if a future version ever pages the rows it sends.
    rowCount:
      typeof declaredRowCount === 'number' && declaredRowCount >= rows.length
        ? declaredRowCount
        : rows.length,
    truncated: rows.length > limited.length,
  };
}

/**
 * Normalize whatever idasql answers with. The documented envelope is
 * { statement_count, results: [{ columns, rows }] }, but the wire format is not
 * something we control or can pin, so every plausible shape is accepted and an
 * unrecognized one surfaces as an engine error rather than a crash.
 */
export function parseIdaSqlQueryResponse(text: string): {
  resultSets: IdaSqlQueryResultSet[];
  engineError: string;
} {
  const trimmed = text.trim();
  if (!trimmed) {
    return { resultSets: [], engineError: '' };
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    // idasql answered with something that is not JSON: surface it verbatim.
    return { resultSets: [], engineError: trimmed.slice(0, 2000) };
  }

  if (Array.isArray(payload)) {
    const single = resultSetFromColumnsRows(undefined, payload);
    return { resultSets: single ? [single] : [], engineError: '' };
  }

  if (!payload || typeof payload !== 'object') {
    return { resultSets: [], engineError: '' };
  }

  const record = payload as Record<string, unknown>;
  // Top-level error shapes, kept as a fallback for other servers/versions.
  const topLevelError =
    typeof record.error === 'string'
      ? record.error
      : typeof record.message === 'string' && record.ok === false
        ? record.message
        : '';

  const resultSets: IdaSqlQueryResultSet[] = [];
  // idasql reports a failed statement INSIDE its entry, with HTTP 200 and a
  // top-level "success": false. Verified against v0.0.18.1:
  //   {"success":false,"results":[{"success":false,"columns":[],"rows":[],
  //     "row_count":0,"error":"no such column: start_ea"}], ...}
  // Reading only the top level meant a wrong column name arrived as a perfectly
  // successful query with zero rows -- so "that column does not exist" reached
  // the operator as "this binary has no functions".
  const statementErrors: string[] = [];
  const results = record.results ?? record.result ?? record.data;
  if (Array.isArray(results)) {
    for (const [index, entry] of results.entries()) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const inner = entry as Record<string, unknown>;
        if (typeof inner.error === 'string' && inner.error) {
          const position =
            typeof inner.statement_index === 'number' ? inner.statement_index : index;
          statementErrors.push(
            results.length > 1 ? `statement ${position + 1}: ${inner.error}` : inner.error,
          );
        }
        const parsed = resultSetFromColumnsRows(
          inner.columns,
          inner.rows ?? inner.values,
          typeof inner.row_count === 'number' ? inner.row_count : undefined,
        );
        if (parsed) {
          resultSets.push(parsed);
          continue;
        }
      }
      const flat = resultSetFromColumnsRows(undefined, [entry]);
      if (flat) {
        resultSets.push(flat);
      }
    }
  } else if (record.columns || record.rows) {
    const parsed = resultSetFromColumnsRows(record.columns, record.rows);
    if (parsed) {
      resultSets.push(parsed);
    }
  }

  let engineError = statementErrors.join('; ') || topLevelError;
  // A declared failure with no message anywhere is still a failure; saying so
  // beats reporting an empty success.
  if (!engineError && record.success === false) {
    engineError = 'the query failed and idasql gave no reason';
  }

  return { resultSets, engineError };
}

/**
 * Does this /status body look like idasql rather than some other local server?
 *
 * Used only for the blind port SCAN, where a wrong answer means sending the
 * operator's SQL to a stranger. So the evidence has to be specific: 'status' and
 * 'db' were in this list and match half the dev servers ever written
 * ({"status":"ok"} passed), which is not evidence of anything.
 */
export function looksLikeIdaSqlStatus(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (/idasql/i.test(trimmed)) {
    return true;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed as Record<string, unknown>).map((key) => key.toLowerCase());
      return keys.some((key) =>
        ['database', 'input_file', 'inputfile', 'idb', 'idb_path', 'tables'].includes(key),
      );
    }
  } catch {
    return false;
  }
  return false;
}

export class IdaSqlSessionManager {
  private readonly sessions = new Map<string, SessionRecord>();

  // Ports claimed by an in-flight allocation, before a session record exists to
  // claim them. See allocatePort.
  private readonly reservedPorts = new Set<number>();

  private sequence = 0;

  constructor(private readonly deps: IdaSqlSessionDeps) {}

  list(): IdaSqlSessionView[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((record) => toView(record));
  }

  get(sessionId: string): IdaSqlSessionView | null {
    const record = this.sessions.get(sessionId);
    return record ? toView(record) : null;
  }

  /** Live sessions are the ones holding a port and (headless) a process. */
  activeCount(): number {
    return [...this.sessions.values()].filter(
      (record) => record.state === 'starting' || record.state === 'ready',
    ).length;
  }

  findByBinary(binaryPath: string): IdaSqlSessionView | null {
    const lowered = binaryPath.toLowerCase();
    for (const record of this.sessions.values()) {
      if (
        record.binaryPath.toLowerCase() === lowered &&
        (record.state === 'ready' || record.state === 'starting')
      ) {
        return toView(record);
      }
    }
    return null;
  }

  private nextId(now: number): string {
    this.sequence += 1;
    return `ida-${now.toString(36)}-${this.sequence.toString(36)}`;
  }

  private usedPorts(): Set<number> {
    const ports = new Set<number>(this.reservedPorts);
    for (const record of this.sessions.values()) {
      if (record.state === 'starting' || record.state === 'ready') {
        ports.add(record.port);
      }
    }
    return ports;
  }

  /**
   * Allocate a port, holding a reservation across the async probe.
   *
   * Without the reservation two concurrent starts both awaited isPortFree on the
   * same port, both saw it free, and both spawned there -- the second idasql then
   * failed to bind and the session died for a reason that looked like a licence
   * problem. The reservation is dropped by the caller once the session record
   * (which is itself a port claim) exists, or on any failure before that.
   */
  private async allocatePort(config: IdaSqlConfigView): Promise<number> {
    const used = this.usedPorts();
    for (let port = config.httpPortStart; port <= config.httpPortEnd; port += 1) {
      if (used.has(port)) {
        continue;
      }
      this.reservedPorts.add(port);
      if (await this.deps.isPortFree(port)) {
        return port;
      }
      this.reservedPorts.delete(port);
    }
    return 0;
  }

  private spawnEnv(config: IdaSqlConfigView): { cwd: string; env: Record<string, string> } {
    const idaDir = resolveIdaDirectory(config);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
    // idasql resolves the IDA engine through PATH. Prepending the install
    // directory (and running there) is what makes a bare spawn work at all --
    // without it idasql starts and immediately fails to find the engine.
    if (idaDir) {
      const currentPath = env.PATH ?? env.Path ?? '';
      const nextPath = currentPath ? `${idaDir}${delimiter}${currentPath}` : idaDir;
      env.PATH = nextPath;
      if (env.Path !== undefined) {
        env.Path = nextPath;
      }
    }
    return { cwd: idaDir || process.cwd(), env };
  }

  /**
   * Start a headless idasql server for `binaryPath`. Returns as soon as the
   * process is up; readiness is polled in the background and reflected in the
   * session state, because auto-analysis can take minutes and the caller must not
   * block an HTTP request on it.
   */
  async startHeadless(params: {
    config: IdaSqlConfigView;
    binaryPath: string;
    write: boolean;
  }): Promise<IdaSqlStartResult> {
    const now = this.deps.now();
    if (this.activeCount() >= MAX_SESSIONS) {
      return { ok: false, session: null, reason: 'too_many_sessions' };
    }
    if (!params.config.idasqlExePath) {
      return { ok: false, session: null, reason: 'idasql_path_missing' };
    }
    // An IDA database has one writer. Measured against a real install: the
    // second idasql on the same binary exits immediately with
    //   Error: Failed to open database: <path>
    // after we have already allocated a port, spawned it, and spent the
    // readiness wait -- and for an approved start, consumed the approval. The
    // route checks this at preview too, but preview is not execute: another
    // start can win the database in between. The invariant belongs here, where
    // every caller passes.
    const holder = this.findByBinary(params.binaryPath);
    if (holder) {
      return {
        ok: false,
        session: null,
        reason: 'session_already_open',
        existingSessionId: holder.id,
      };
    }

    const port = await this.allocatePort(params.config);
    if (port === 0) {
      return { ok: false, session: null, reason: 'no_free_port' };
    }

    // A fresh token per session. The server it protects answers arbitrary SQL
    // against the operator's database on a loopback port, so "loopback" is not
    // the boundary -- every local process shares it.
    //
    // What this token does and does not cover, measured rather than assumed:
    //  - It DOES stop any other origin that can reach loopback. A web page in
    //    the operator's browser can fetch http://127.0.0.1:<port>/query; it
    //    cannot read a process command line. This is the threat it exists for.
    //  - It does NOT hide from a process running as the same user: --token lands
    //    on idasql's argv, and argv is readable locally (Win32_Process). Checked
    //    against idasql --help: --token is its ONLY auth input, with no env var,
    //    file, or stdin alternative, so this is upstream and not ours to fix.
    //    It also costs nothing, because such a process can already open the .i64
    //    itself -- the token was never the boundary there.
    //  - idasql does not echo it: verified that a real session's stdout/stderr
    //    contain no part of the token, which is what keeps outputTail safe to
    //    show the operator.
    const token = (this.deps.createToken ?? defaultCreateToken)();
    const args = buildIdaSqlHeadlessArgs({
      binaryPath: params.binaryPath,
      port,
      write: params.write,
      token,
    });
    const { cwd, env } = this.spawnEnv(params.config);

    let child: IdaSqlChildHandle;
    try {
      child = this.deps.spawnProcess(params.config.idasqlExePath, args, { cwd, env });
    } catch (error) {
      this.deps.logError?.('idasql spawn failed', error);
      // Nothing is holding this port now; releasing it keeps a failed start from
      // permanently shrinking the window.
      this.reservedPorts.delete(port);
      return { ok: false, session: null, reason: 'spawn_failed' };
    }

    const record: SessionRecord = {
      id: this.nextId(now),
      binaryPath: params.binaryPath,
      binaryName: baseName(params.binaryPath),
      mode: 'headless',
      write: params.write,
      state: 'starting',
      port,
      pid: child.pid,
      startedAt: now,
      readyAt: null,
      lastUsedAt: now,
      queryCount: 0,
      failureReason: '',
      outputTail: '',
      child,
      token,
      unreviewedFunctions: new Set<string>(),
      activeQueries: 0,
      progress: null,
    };
    this.sessions.set(record.id, record);
    // The record is the port claim from here on.
    this.reservedPorts.delete(port);

    if (typeof child.pid === 'number' && child.pid > 0) {
      this.deps.onSpawned?.({ pid: child.pid, imageName: baseName(params.config.idasqlExePath) });
    }

    child.onOutput((chunk) => {
      record.outputTail = truncateTail(record.outputTail, chunk);
    });
    child.onExit((code, signal) => {
      record.child = null;
      if (record.state === 'stopped') {
        return;
      }
      record.state = 'failed';
      record.failureReason = record.failureReason || describeExit(code, signal);
    });

    // Fire and forget, but never unhandled. pollReady's own deadline is what
    // normally reclaims a session that never comes up -- so if the loop itself
    // dies, the session stays 'starting' forever, and nothing reaps that state:
    // reapIdle takes only 'ready' and pruneTerminal only terminal ones. The
    // process and its port would be held by a record no code path can reach.
    void this.pollReady(record).catch((error: unknown) => {
      this.deps.logError?.('idasql readiness poll crashed', error);
      if (record.state === 'starting') {
        record.state = 'failed';
        record.failureReason = 'ready_poll_crashed';
        this.terminateChild(record);
      }
    });
    return { ok: true, session: toView(record), reason: '' };
  }

  private async pollReady(record: SessionRecord): Promise<void> {
    const deadline = this.deps.now() + READY_TIMEOUT_MS;
    let interval = READY_POLL_MIN_MS;
    while (this.deps.now() < deadline) {
      // Read the state through a call, not an inline comparison: the exit
      // listener and stop() mutate `record` while this loop is awaiting, and an
      // inline check gets narrowed away by control-flow analysis that assumes
      // nothing changed across the await.
      if (isTerminalSessionState(record)) {
        return;
      }
      await this.deps.sleep(interval);
      interval = Math.min(READY_POLL_MAX_MS, Math.floor(interval * 1.4));
      if (isTerminalSessionState(record)) {
        return;
      }
      this.sampleProgress(record);
      try {
        const response = await this.deps.httpRequest(`http://127.0.0.1:${record.port}/status`, {
          method: 'GET',
          timeoutMs: PROBE_TIMEOUT_MS,
          ...(record.token ? { token: record.token } : {}),
        });
        if (response.status >= 200 && response.status < 300) {
          // Re-check: stop() (or an early exit) can land WHILE this probe is in
          // flight. Without this, a session the operator just stopped flips back
          // to 'ready' on the late 200 and queries get sent to a dead port.
          if (isTerminalSessionState(record)) {
            return;
          }
          record.state = 'ready';
          record.readyAt = this.deps.now();
          await this.reviewSessionFunctions(record);
          return;
        }
      } catch {
        // Not up yet: keep polling until the deadline.
      }
    }
    if (record.state === 'starting') {
      record.state = 'failed';
      record.failureReason = 'ready_timeout';
      // Reclaim the process. idasql --http is a SERVER: it never exits on its
      // own, so giving up on readiness without killing it left a live process
      // holding a port, and pruneTerminal later dropped the record that held the
      // only handle to it -- an orphan nothing could reach.
      this.terminateChild(record);
    }
  }

  /**
   * Ask the live engine which non-builtin functions it has, and remember the
   * ones this build has never reviewed.
   *
   * The blocklist of dangerous idasql functions is pinned to the version it was
   * enumerated against. Upgrade idasql, gain a function nobody has looked at,
   * and a verb-based classifier would call `SELECT new_function()` a read. So
   * the session asks rather than assumes: anything it does not recognize makes a
   * statement a write, which puts it in front of the operator.
   *
   * Failure is not fatal -- an engine that cannot answer this leaves the set
   * empty, which is the pre-existing behaviour rather than a broken session.
   */
  private async reviewSessionFunctions(record: SessionRecord): Promise<void> {
    try {
      const response = await this.deps.httpRequest(`http://127.0.0.1:${record.port}/query`, {
        method: 'POST',
        body: 'SELECT DISTINCT name FROM pragma_function_list WHERE builtin = 0',
        timeoutMs: PROBE_TIMEOUT_MS * 4,
        ...(record.token ? { token: record.token } : {}),
      });
      if (response.status < 200 || response.status >= 300) {
        return;
      }
      const parsed = parseIdaSqlQueryResponse(response.text);
      if (parsed.engineError || parsed.resultSets.length === 0) {
        return;
      }
      const unreviewed = new Set<string>();
      for (const row of parsed.resultSets[0].rows) {
        const name = (row[0] ?? '').trim().toLowerCase();
        if (name && !KNOWN_IDASQL_FUNCTIONS.has(name)) {
          unreviewed.add(name);
        }
      }
      record.unreviewedFunctions = unreviewed;
    } catch {
      // Leave the set empty; the classifier then behaves as it did before.
    }
  }

  /** Functions the live session exposes that this build has not reviewed. */
  unreviewedFunctions(sessionId: string): ReadonlySet<string> {
    return this.sessions.get(sessionId)?.unreviewedFunctions ?? new Set<string>();
  }

  /** Kill the child we started, if we still own one. Never used for GUI mode. */
  private terminateChild(record: SessionRecord): void {
    if (!record.child) {
      return;
    }
    try {
      record.child.kill();
    } catch (error) {
      this.deps.logError?.('idasql kill failed', error);
    }
    record.child = null;
  }

  /**
   * Launch the operator's real IDA window on `binaryPath`. Returns the pid of the
   * launched IDA so the caller can audit it; attaching to its idasql server is a
   * separate, explicit step (the operator has to run `.http start` first).
   */
  /**
   * Open the operator's IDA on a binary, and say exactly how to make it
   * queryable.
   *
   * The instruction matters as much as the launch. Read out of the plugin's own
   * help: a bare `.http start` binds "127.0.0.1, random port, no auth" -- so the
   * old advice produced a server on a port nothing could find and with no token
   * on it. Naming a port inside the range attachGui probes turns that range from
   * a guess into a fact, and naming a token means the loopback SQL server is not
   * open to anything that can reach it.
   */
  async launchGui(params: { config: IdaSqlConfigView; binaryPath: string }): Promise<{
    ok: boolean;
    pid: number | null;
    reason: string;
    /** Port the operator should bind, already reserved against our own picks. */
    suggestedPort: number;
    /** Token to put on it. */
    suggestedToken: string;
    /** The literal line to type into IDA's idasql CLI. */
    startCommand: string;
  }> {
    const empty = { suggestedPort: 0, suggestedToken: '', startCommand: '' };
    if (!params.config.idaExePath) {
      return { ok: false, pid: null, reason: 'ida_path_missing', ...empty };
    }
    const { cwd, env } = this.spawnEnv(params.config);
    try {
      const child = this.deps.spawnProcess(
        params.config.idaExePath,
        buildIdaGuiArgs({ binaryPath: params.binaryPath }),
        { cwd, env, interactive: true },
      );
      // Observe the failure even though we do not manage this process: without a
      // subscriber a spawn error is invisible here, and the operator's only
      // clue was an IDA window that never appeared.
      child.onExit((_code, signal) => {
        if (signal === 'error') {
          this.deps.logError?.(`ida gui launch failed for ${params.config.idaExePath}`);
        }
      });
      if (typeof child.pid !== 'number' || child.pid <= 0) {
        // No pid means the program was never launched -- a moved or renamed
        // ida.exe is the usual cause. Reporting ok:true with a null pid told the
        // caller "IDA is starting" about a process that does not exist.
        return { ok: false, pid: null, reason: 'spawn_failed', ...empty };
      }
      this.deps.onSpawned?.({ pid: child.pid, imageName: baseName(params.config.idaExePath) });
      const suggestedPort = await this.suggestGuiPort();
      const suggestedToken = (this.deps.createToken ?? defaultCreateToken)();
      return {
        ok: true,
        pid: child.pid,
        reason: '',
        suggestedPort,
        suggestedToken,
        startCommand: `.http start 127.0.0.1 ${suggestedPort} --token ${suggestedToken}`,
      };
    } catch (error) {
      this.deps.logError?.('ida gui spawn failed', error);
      return { ok: false, pid: null, reason: 'spawn_failed', ...empty };
    }
  }

  /**
   * A port in the GUI probe range that nothing on this machine is listening on.
   *
   * Checked against the OS, not only against our own sessions: the operator
   * copies this port into IDA verbatim, and `.http start` on a port something
   * else already owns fails inside IDA with a bind error they then have to
   * diagnose. Not a guarantee -- they type it seconds later and the port could be
   * taken by then -- but attachGui probes the whole range as a fallback, so a
   * port that goes stale still ends up attachable.
   */
  private async suggestGuiPort(): Promise<number> {
    const taken = new Set(
      [...this.sessions.values()]
        .filter((record) => record.state === 'ready' || record.state === 'starting')
        .map((record) => record.port),
    );
    let firstUnclaimed = 0;
    for (let port = IDA_SQL_GUI_PROBE_PORT_START; port <= IDA_SQL_GUI_PROBE_PORT_END; port += 1) {
      if (taken.has(port)) {
        continue;
      }
      if (!firstUnclaimed) {
        firstUnclaimed = port;
      }
      if (await this.deps.isPortFree(port)) {
        return port;
      }
    }
    // Every port in the range is busy. Suggest one anyway rather than refusing
    // the launch: the operator can bind whatever they like and attachGui will
    // find it.
    return firstUnclaimed || IDA_SQL_GUI_PROBE_PORT_START;
  }

  /**
   * Find an idasql HTTP server exposed by a running IDA GUI and register it as a
   * session. The port is chosen by the plugin, so the only way to find it is to
   * probe the documented window; a hint short-circuits the scan.
   */
  async attachGui(params: {
    binaryPathHint?: string;
    /**
     * Try this port first. Still has to prove it is idasql.
     *
     * This used to double as a declaration ("I read 8137 in IDA"), which was
     * right when only a human could set it. It is no longer: launchGui now
     * SUGGESTS a port and the app passes it here automatically, so trusting a
     * hint meant trusting a port nobody declared -- and posting SQL to whatever
     * happened to be listening on it.
     */
    portHint?: number;
    /**
     * A human typed this port after reading it in IDA. Only then is a port taken
     * at its word, and only because a person can see what is on it. Never set
     * from a suggested port, and never from a port the model produced.
     */
    portDeclared?: boolean;
    /** Token the operator gave their in-IDA server, if they set one. */
    token?: string;
  }): Promise<IdaSqlStartResult> {
    const now = this.deps.now();
    if (this.activeCount() >= MAX_SESSIONS) {
      return { ok: false, session: null, reason: 'too_many_sessions' };
    }

    const candidates: number[] = [];
    if (params.portHint && params.portHint > 0) {
      candidates.push(params.portHint);
    }
    for (let port = IDA_SQL_GUI_PROBE_PORT_START; port <= IDA_SQL_GUI_PROBE_PORT_END; port += 1) {
      if (port !== params.portHint) {
        candidates.push(port);
      }
    }

    const used = this.usedPorts();
    // A 401 is not "nothing is there" -- it is idasql saying it wants a token
    // (verified: /status and /shutdown both answer 401 without one). Reporting
    // that as no_gui_server_found sent the operator hunting for a server they
    // were already talking to.
    let sawUnauthorized = false;
    let sawUnrecognized = false;
    for (const port of candidates) {
      if (used.has(port)) {
        continue;
      }
      let response: IdaSqlHttpResponse;
      try {
        response = await this.deps.httpRequest(`http://127.0.0.1:${port}/status`, {
          method: 'GET',
          timeoutMs: PROBE_TIMEOUT_MS,
          ...(params.token ? { token: params.token } : {}),
        });
      } catch {
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        sawUnauthorized = true;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        continue;
      }
      // Only a port a HUMAN declared is taken at its word: they can see what is
      // on it. A suggested port, a scanned port, or a port the model repeated
      // back is a guess, and a wrong guess means posting SQL to some unrelated
      // local service -- those have to prove themselves.
      const declaredByOperator =
        params.portDeclared === true && params.portHint !== undefined && port === params.portHint;
      if (!declaredByOperator && !looksLikeIdaSqlStatus(response.text)) {
        if (params.portHint !== undefined && port === params.portHint) {
          // Worth distinguishing from "nothing answered": something IS there, it
          // just did not identify itself, and the operator is the only one who
          // can say whether that is their IDA.
          sawUnrecognized = true;
        }
        continue;
      }
      const binaryPath = params.binaryPathHint ?? '';
      const record: SessionRecord = {
        id: this.nextId(now),
        binaryPath,
        binaryName: binaryPath ? baseName(binaryPath) : `gui:${port}`,
        mode: 'gui',
        // A GUI session's write-ability is IDA's own; we never pass -w and we
        // never claim the operator's window is read-only.
        write: true,
        state: 'ready',
        port,
        // Not ours to kill: the operator started this IDA.
        pid: null,
        startedAt: now,
        readyAt: now,
        lastUsedAt: now,
        queryCount: 0,
        failureReason: '',
        outputTail: '',
        child: null,
        // Whatever token the operator gave their own server, so later queries
        // carry it too. Empty when they did not set one.
        token: params.token ?? '',
        unreviewedFunctions: new Set<string>(),
        activeQueries: 0,
        progress: null,
      };
      this.sessions.set(record.id, record);
      // A GUI session skips the readiness poll, so the function review has to
      // happen here too -- the operator's IDA is just as much an unknown build.
      await this.reviewSessionFunctions(record);
      return { ok: true, session: toView(record), reason: '' };
    }

    return {
      ok: false,
      session: null,
      reason: sawUnauthorized
        ? 'gui_server_requires_token'
        : sawUnrecognized
          ? 'gui_server_unrecognized'
          : 'no_gui_server_found',
    };
  }

  /** Send SQL to a ready session. Classification happens in the route, not here. */
  async query(sessionId: string, sql: string): Promise<IdaSqlQueryOutcome> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return {
        ok: false,
        resultSets: [],
        engineError: '',
        elapsedMs: 0,
        reason: 'unknown_session',
      };
    }
    if (record.state === 'starting') {
      return {
        ok: false,
        resultSets: [],
        engineError: '',
        elapsedMs: 0,
        reason: 'session_starting',
      };
    }
    if (record.state !== 'ready') {
      return {
        ok: false,
        resultSets: [],
        engineError: record.failureReason,
        elapsedMs: 0,
        reason: `session_${record.state}`,
      };
    }

    const startedAt = this.deps.now();
    let response: IdaSqlHttpResponse;
    // Hold the session against the reaper for as long as the engine has the
    // query. lastUsedAt is stamped on RETURN, so a query slower than the idle
    // timeout used to read as an idle session: any concurrent request (the UI
    // polls the session list) ran reapIdle, killed the process mid-query, and
    // the operator got a transport error and a vanished session instead of an
    // answer. The floor on the idle timeout is below QUERY_TIMEOUT_MS, so this
    // was reachable by configuration alone.
    record.activeQueries += 1;
    try {
      response = await this.deps.httpRequest(`http://127.0.0.1:${record.port}/query`, {
        method: 'POST',
        body: sql,
        timeoutMs: QUERY_TIMEOUT_MS,
        ...(record.token ? { token: record.token } : {}),
      });
    } catch (error) {
      this.deps.logError?.('idasql query failed', error);
      return {
        ok: false,
        resultSets: [],
        engineError: error instanceof Error ? error.message : String(error),
        elapsedMs: this.deps.now() - startedAt,
        reason: 'query_transport_failed',
      };
    } finally {
      record.activeQueries = Math.max(0, record.activeQueries - 1);
      // Stamp the clock here too, not only on the success path: a query that
      // failed still occupied the session, and the idle countdown has to start
      // from when it let go.
      record.lastUsedAt = this.deps.now();
    }

    record.queryCount += 1;

    const parsed = parseIdaSqlQueryResponse(response.text);
    const elapsedMs = this.deps.now() - startedAt;
    if (response.status < 200 || response.status >= 300) {
      // Keep the STATUS as well as the body. Falling back to the status only
      // when the body was empty dropped it for every answer that had any text --
      // so a 401 from a token mismatch reported plain "Unauthorized", and the
      // one fact that identifies the problem was gone.
      const detail = parsed.engineError.trim();
      return {
        ok: false,
        resultSets: parsed.resultSets,
        engineError: detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`,
        elapsedMs,
        reason: 'query_rejected',
      };
    }
    return {
      ok: !parsed.engineError,
      resultSets: parsed.resultSets,
      engineError: parsed.engineError,
      elapsedMs,
      reason: parsed.engineError ? 'engine_error' : '',
    };
  }

  /**
   * Stop a session. A headless session is asked to shut down over HTTP first and
   * killed if it does not go; a GUI session is only detached, never killed -- that
   * window is the operator's.
   */
  async stop(sessionId: string): Promise<{ ok: boolean; reason: string }> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return { ok: false, reason: 'unknown_session' };
    }
    if (record.state === 'stopped') {
      return { ok: true, reason: '' };
    }

    const wasHeadless = record.mode === 'headless';
    record.state = 'stopped';

    if (wasHeadless) {
      try {
        await this.deps.httpRequest(`http://127.0.0.1:${record.port}/shutdown`, {
          method: 'POST',
          timeoutMs: PROBE_TIMEOUT_MS,
          ...(record.token ? { token: record.token } : {}),
        });
      } catch {
        // Best effort: fall through to the kill.
      }
      this.terminateChild(record);
    }
    return { ok: true, reason: '' };
  }

  /** Stop sessions idle past the configured timeout. Returns the ids stopped. */
  async reapIdle(config: IdaSqlConfigView): Promise<string[]> {
    const now = this.deps.now();
    const due = [...this.sessions.values()].filter((record) => {
      // A session stuck 'starting' long past the readiness deadline has lost the
      // loop that was supposed to time it out. Reap it here as well, so the
      // process is reclaimed even if pollReady never gets to say so. The margin
      // keeps this from racing a poll that is simply on its last iteration.
      if (record.state === 'starting') {
        return now - record.startedAt >= READY_TIMEOUT_MS + READY_POLL_MAX_MS * 2;
      }
      return (
        record.state === 'ready' &&
        record.activeQueries === 0 &&
        now - record.lastUsedAt >= config.sessionIdleTimeoutMs
      );
    });
    if (due.length === 0) {
      return [];
    }
    // Concurrently, not one after another. Every route awaits this reaper before
    // dispatching, and stop() waits up to the probe timeout for a /shutdown that
    // an unreachable session will never answer -- so a sequential sweep of eight
    // dead sessions made the first request after a break wait eight timeouts.
    await Promise.all(
      due.map(async (record) => {
        await this.stop(record.id);
        record.failureReason = 'idle_timeout';
      }),
    );
    return due.map((record) => record.id);
  }

  /**
   * Record that a request is about to use this session.
   *
   * The idle reaper runs before the route dispatch, so without this the FIRST
   * query after a long pause reaped the very session it was for: the operator
   * came back, typed SQL, and their own request killed the session and then
   * failed on it. A request naming a session IS activity on it.
   */
  touch(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record && (record.state === 'ready' || record.state === 'starting')) {
      record.lastUsedAt = this.deps.now();
    }
  }

  /**
   * Take one on-disk reading of how far the analysis has got.
   *
   * Cheap by design -- a handful of stats on sibling files -- because it runs on
   * every readiness poll. A reading that does not grow is reported as a zero
   * delta rather than hidden: "no visible work this tick" is information, and a
   * UI that silently repeated the last number would look like progress.
   */
  private sampleProgress(record: SessionRecord): void {
    const probe = this.deps.databaseBytes;
    if (!probe) {
      return;
    }
    let bytes = 0;
    try {
      bytes = probe(record.binaryPath);
    } catch {
      return;
    }
    const previous = record.progress;
    record.progress = {
      databaseBytes: bytes,
      deltaBytes: previous ? Math.max(0, bytes - previous.databaseBytes) : 0,
      sampledAt: this.deps.now(),
      sampleCount: (previous?.sampleCount ?? 0) + 1,
    };
  }

  /** Diagnostics tail for a failed headless session. */
  outputTail(sessionId: string): string {
    return this.sessions.get(sessionId)?.outputTail ?? '';
  }

  /**
   * Kill every process this manager started, without waiting for /shutdown.
   *
   * For the moment the owner is going away: a dev-server module reload or a
   * process exit resets the registry while the children keep running, and the
   * registry held the only handle to them. Observed for real: after an HMR the
   * server reported zero sessions while an idasql was still up holding its port
   * and the database open, which then made the NEXT analysis of that binary fail
   * to open it.
   */
  killAllChildren(): void {
    for (const record of this.sessions.values()) {
      if (record.mode !== 'headless') {
        continue;
      }
      if (record.state === 'ready' || record.state === 'starting') {
        record.state = 'stopped';
        record.failureReason = record.failureReason || 'server_shutdown';
      }
      this.terminateChild(record);
    }
  }

  /** Drop terminal sessions from the registry (called after a client reads them). */
  pruneTerminal(maxAgeMs: number): void {
    const now = this.deps.now();
    for (const [id, record] of [...this.sessions.entries()]) {
      if (record.state !== 'ready' && record.state !== 'starting') {
        if (now - record.lastUsedAt > maxAgeMs) {
          // Forgetting a record that still owns a child would orphan the process:
          // this map holds the only handle to it. Reclaim before dropping.
          this.terminateChild(record);
          this.sessions.delete(id);
        }
      }
    }
  }
}

/**
 * IDA writes the database beside the binary as sidecars while it works: .id0
 * (the b-tree), .id1, .id2, .nam, .til, and .i64 once packed. Summing whatever
 * exists is the measurement -- verified growing on a real ntoskrnl analysis
 * (.id0 went 108.5MB -> 119.9MB over 40 seconds).
 */
const IDA_DATABASE_SUFFIXES = ['.id0', '.id1', '.id2', '.nam', '.til', '.i64', '.idb'] as const;

/**
 * The base IDA hangs its sidecars off.
 *
 * For `foo.exe` that is `foo.exe`, giving `foo.exe.id0` and friends. But a
 * packed database is itself an analyzable target -- .i64 and .idb are both in
 * IDA_SQL_ANALYZABLE_EXTENSIONS -- and opening `foo.exe.i64` unpacks to
 * `foo.exe.id0`, NOT `foo.exe.i64.id0`. Without stripping, progress for a .i64
 * target measured files that can never exist and reported zero forever.
 */
function databaseBaseFor(binaryPath: string): string {
  const lowered = binaryPath.toLowerCase();
  for (const packed of ['.i64', '.idb']) {
    if (lowered.endsWith(packed)) {
      return binaryPath.slice(0, binaryPath.length - packed.length);
    }
  }
  return binaryPath;
}

function nodeDatabaseBytes(binaryPath: string): number {
  if (!binaryPath) {
    return 0;
  }
  const base = databaseBaseFor(binaryPath);
  let total = 0;
  for (const suffix of IDA_DATABASE_SUFFIXES) {
    try {
      total += statSync(`${base}${suffix}`).size;
    } catch {
      // Not written yet, or already packed away. Absent is zero, not an error.
    }
  }
  return total;
}

function nodeSpawn(
  program: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; interactive?: boolean },
): IdaSqlChildHandle {
  // An interactive child is the operator's IDA window; everything else is our
  // own headless idasql. Every option below differs between the two, and the
  // GUI launch used to get the headless set:
  //
  //  - windowsHide sets STARTUPINFO.wShowWindow = SW_HIDE, not just
  //    CREATE_NO_WINDOW. Qt honours it for the first top-level window, so IDA
  //    started, analyzed, and never drew anything. Measured: two ida.exe
  //    processes alive with MainWindowHandle = 0.
  //  - detached:false ties IDA's lifetime to this dev server. Restarting the
  //    server should not close the operator's disassembler.
  //  - piped stdio that nobody drains deadlocks the child once the ~64KB pipe
  //    buffer fills. launchGui registers no reader, so IDA would eventually
  //    freeze; we do not want its output at all.
  const interactive = options.interactive === true;
  const child = spawn(program, args, {
    cwd: options.cwd,
    env: options.env,
    // No shell, ever: the argument vector is the whole interface.
    shell: false,
    windowsHide: !interactive,
    stdio: interactive ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    detached: interactive,
  });
  // Attached HERE, unconditionally, and not left to the caller.
  //
  // A ChildProcess reports a program it could not launch (ENOENT, EACCES) as an
  // ASYNCHRONOUS 'error' event, and an EventEmitter 'error' with no listener
  // throws an uncaught exception -- in the dev server that is the whole server
  // going down. Only onExit() used to attach one, and launchGui discards its
  // handle without calling it, so a configured ida.exe path that no longer
  // exists killed the server. Reproduced: spawn of a missing exe with nothing
  // registered gives `pid === undefined` and then an uncaught ENOENT.
  //
  // "Every caller must remember to subscribe or the process dies" is not a
  // contract worth having, so the handle owns it.
  child.on('error', () => {
    // Deliberately empty. The real signal is `pid`, which is undefined for a
    // launch that never happened -- see launchGui, which now refuses on that.
    // Listeners added later via onExit still receive their own notification.
  });
  if (interactive) {
    // Let the event loop forget it: this process outlives us on purpose.
    child.unref();
  }
  return {
    pid: typeof child.pid === 'number' ? child.pid : null,
    onExit(listener) {
      child.on('exit', (code, signal) => listener(code ?? null, signal ?? null));
      child.on('error', () => listener(null, 'error'));
    },
    onOutput(listener) {
      child.stdout?.on('data', (chunk: Buffer) => listener(chunk.toString('utf-8')));
      child.stderr?.on('data', (chunk: Buffer) => listener(chunk.toString('utf-8')));
    },
    kill() {
      child.kill();
    },
  };
}

async function nodeHttpRequest(
  url: string,
  init: { method: 'GET' | 'POST'; body?: string; timeoutMs: number; token?: string },
): Promise<IdaSqlHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) {
      headers['Content-Type'] = 'text/plain';
    }
    if (init.token) {
      // The scheme idasql enforces (verified against v0.0.18.1): a bare token,
      // X-Token, or ?token= all answer 401.
      headers.Authorization = `Bearer ${init.token}`;
    }
    const response = await fetch(url, {
      method: init.method,
      ...(init.body === undefined ? {} : { body: init.body }),
      headers,
      signal: controller.signal,
    });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function nodeIsPortFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePort) => {
    const server = createServer();
    server.once('error', () => resolvePort(false));
    server.once('listening', () => {
      server.close(() => resolvePort(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/** 256 bits of randomness, hex. Long enough that guessing is not a strategy. */
function defaultCreateToken(): string {
  return randomBytes(32).toString('hex');
}

export function createIdaSqlNodeDeps(
  overrides: Partial<IdaSqlSessionDeps> = {},
): IdaSqlSessionDeps {
  return {
    spawnProcess: nodeSpawn,
    httpRequest: nodeHttpRequest,
    createToken: defaultCreateToken,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    isPortFree: nodeIsPortFree,
    databaseBytes: nodeDatabaseBytes,
    ...overrides,
  };
}

let sharedManager: IdaSqlSessionManager | null = null;
let shutdownHooked = false;

/**
 * Reclaim the shared manager's children when this process goes away.
 *
 * Registered once, and ONLY on 'exit'. An earlier version also listened for
 * SIGINT/SIGTERM, which is a trap: Node documents that installing a listener for
 * those OVERRIDES the default terminate-on-Ctrl+C, and this handler does not
 * exit -- so the first Ctrl+C on the dev server would have done nothing at all.
 * Both hosts already own their signal handling (the daemon entrypoint installs
 * SIGINT/SIGTERM; Vite installs its own) and both leave through process.exit,
 * which is exactly when 'exit' fires. Taking signals over to clean up a child
 * process would trade a leak for an unkillable server.
 *
 * 'exit' listeners must be synchronous, and killAllChildren is.
 */
function hookProcessShutdown(manager: IdaSqlSessionManager): void {
  if (shutdownHooked) {
    return;
  }
  shutdownHooked = true;
  process.once('exit', () => {
    try {
      manager.killAllChildren();
    } catch {
      // Shutdown path: nothing useful to do with a failure here.
    }
  });
}

/**
 * One manager per server process. Sessions are process-scoped on purpose: a
 * restart must not inherit ownership of processes it can no longer see.
 */
export function getSharedIdaSqlSessionManager(
  deps?: Partial<IdaSqlSessionDeps>,
): IdaSqlSessionManager {
  if (!sharedManager) {
    sharedManager = new IdaSqlSessionManager(createIdaSqlNodeDeps(deps));
    hookProcessShutdown(sharedManager);
  }
  return sharedManager;
}

/** Test seam: drop the singleton so a suite can install its own deps. */
export function resetSharedIdaSqlSessionManager(): void {
  sharedManager = null;
}
