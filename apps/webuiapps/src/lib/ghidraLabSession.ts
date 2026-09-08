// Ghidra Lab session manager: owns the lifetime of every pyghidra-mcp server this
// machine has started, and is the only place MCP calls are put on the wire.
//
// Shape of a session:
//   headless - we spawn pyghidra-mcp ourselves, serving MCP over streamable-HTTP
//              on a loopback port. Ghidra imports and auto-analyzes the binary
//              inside that process, so the session is 'starting' for as long as
//              that takes -- minutes on a large binary.
//   batch    - not a session at all (see runGhidraBatchDump): one analyzeHeadless
//              run that writes a JSON dump and exits.
//
// Two waits live inside 'starting', and telling them apart is the whole reason
// this class does not just poll one endpoint:
//
//   phase 'jvm'      - the process is up but MCP does not answer yet. The JVM is
//                      booting and Ghidra is initializing. A failure here is
//                      almost always a bad JDK or a bad GHIDRA_INSTALL_DIR.
//   phase 'analysis' - MCP answers, but the binary is not in the project index
//                      yet. pyghidra-mcp is asynchronous by design; it serves
//                      before analysis finishes. A failure here is a genuinely
//                      slow binary, not a broken install.
//
// Reporting "analysis timed out" for what was really a wrong JDK is the failure
// mode this split exists to prevent -- and on this machine the system JDK is 11
// while Ghidra needs 21, so it is the likely one.
//
// Every effect (spawn, MCP client, clock, sleep, port probe, disk sampling) is
// injected, so the whole lifecycle is unit-testable with no Ghidra installed.
// Production wiring lives in createGhidraLabNodeDeps.
//
// Server-only: child_process / net / fs.
import { spawn } from 'child_process';
import { createServer } from 'net';
import * as fs from 'fs';
import { join } from 'path';

import { McpHttpClient } from './idaMcpHttpClient';
import {
  buildGhidraChildEnv,
  buildPyghidraMcpCommand,
  type PyghidraLaunchKind,
} from './ghidraLabConfig';
import {
  capGhidraQueryRows,
  normalizeGhidraToolResult,
  planGhidraQuery,
  type GhidraQueryPlan,
} from './ghidraLabQuery';
import type {
  GhidraLabConfigView,
  GhidraLabSessionMode,
  GhidraLabSessionProgress,
  GhidraLabSessionState,
  GhidraLabSessionView,
  GhidraQueryKind,
} from './ghidraLabTypes';

/** Concurrent live sessions this machine will hold.
 *
 *  Lower than IdaLab's 8 on purpose: every session here is a JVM with a
 *  multi-gigabyte heap (GHIDRA_MAXMEM defaults to 4G in our config), so eight of
 *  them would be an out-of-memory event rather than a busy machine. */
export const GHIDRA_LAB_MAX_SESSIONS = 4;

const READY_POLL_MIN_MS = 750;
const READY_POLL_MAX_MS = 4000;
/** How long MCP may stay unreachable before we stop blaming a slow JVM. */
const JVM_PHASE_TIMEOUT_MS = 3 * 60 * 1000;
const MCP_CALL_TIMEOUT_MS = 120 * 1000;
const OUTPUT_TAIL_CHARS = 4000;

export interface GhidraChildHandle {
  pid: number | null;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onOutput(listener: (chunk: string) => void): void;
  kill(): void;
}

/** The slice of McpHttpClient this manager depends on, so tests can fake it. */
export interface GhidraMcpClientLike {
  initialize(): Promise<void>;
  listTools(): Promise<{ name: string }[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface GhidraLabSessionDeps {
  spawnProcess(
    program: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
  ): GhidraChildHandle;
  /** One client per session. Never a shared/cached one: a reused port would
   *  otherwise inherit a dead session's MCP session-id. */
  createMcpClient(endpoint: string): GhidraMcpClientLike;
  now(): number;
  sleep(ms: number): Promise<void>;
  isPortFree(port: number): Promise<boolean>;
  /** Bytes under the Ghidra project directory -- the only growth signal there is. */
  projectBytes?(projectRoot: string, projectName: string): number;
  /** Does a project of this name already exist? Decides --force-analysis. */
  projectExists?(projectRoot: string, projectName: string): boolean;
  onSpawned?(spawned: { pid: number; imageName: string }): void;
  logError?(message: string, error?: unknown): void;
}

interface SessionRecord {
  id: string;
  binaryPath: string;
  binaryName: string;
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
  outputTail: string;
  child: GhidraChildHandle | null;
  client: GhidraMcpClientLike | null;
  /** Tool names the live server advertises. Empty until MCP answered. */
  engineTools: Set<string>;
  /** What the ENGINE calls this binary inside the project. Empty until known. */
  engineBinaryName: string;
  activeQueries: number;
  progress: GhidraLabSessionProgress | null;
}

export interface GhidraLabStartResult {
  ok: boolean;
  session: GhidraLabSessionView | null;
  existingSessionId?: string;
  reason: string;
}

export interface GhidraLabQueryOutcome {
  ok: boolean;
  kind: GhidraQueryKind | null;
  mcpTool: string;
  rows: unknown[];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
  engineError: string;
  reason: string;
}

export function baseName(path: string): string {
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

function toView(record: SessionRecord): GhidraLabSessionView {
  return {
    id: record.id,
    binaryPath: record.binaryPath,
    binaryName: record.binaryName,
    projectName: record.projectName,
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
    progress: record.progress,
  };
}

/**
 * Explain a child exit in terms the operator can act on.
 *
 * The two that matter here both look like a generic crash otherwise: a JVM that
 * refused the heap size, and a Python that could not import the package.
 */
export function describeGhidraExit(
  code: number | null,
  signal: string | null,
  outputTail: string,
): string {
  if (signal) {
    return `killed by ${signal}`;
  }
  const tail = outputTail.toLowerCase();
  if (
    tail.includes('could not create the java virtual machine') ||
    tail.includes('invalid maximum heap')
  ) {
    return 'the JVM refused the configured heap -- lower Max memory in Setup';
  }
  if (tail.includes('no module named') || tail.includes('modulenotfounderror')) {
    return 'python could not import pyghidra-mcp -- re-run Bootstrap, or point Setup at an interpreter that has it';
  }
  if (tail.includes('ghidra_install_dir') || tail.includes('ghidra installation')) {
    return 'pyghidra could not find Ghidra -- check the Ghidra install folder in Setup';
  }
  if (tail.includes('unsupportedclassversionerror') || tail.includes('class file version')) {
    return 'Ghidra was run with too old a JDK -- point Setup at a JDK 21 home';
  }
  if (code === null) {
    return 'exited without a code';
  }
  return `exited with code ${code}`;
}

export interface GhidraProjectBinary {
  /** The name the ENGINE uses, which is not the filename we started from. */
  name: string;
  analysisComplete: boolean;
}

/**
 * Find our binary in whatever `list_project_binaries` answered.
 *
 * Two things this exists for, both learned from a live pyghidra-mcp 0.2.5:
 *
 *   - THE ENGINE RENAMES THE BINARY. `where.exe` is imported into the project as
 *     `/where.exe-e4c967`, and every other tool takes that name in `binary_name`.
 *     Passing the filename we spawned with gets "Binary where.exe not found",
 *     so the session has to learn the engine's name and use it from then on.
 *   - IT REPORTS ITS OWN READINESS. Each program carries `analysis_complete`,
 *     which is a far better readiness signal than "the name showed up".
 *
 * Forgiving about the envelope (`programs` / `binaries` / a bare array) because
 * that has moved between versions; strict about the two fields above because
 * they are what the rest of the session depends on.
 */
export function findProjectBinary(
  payload: unknown,
  binaryName: string,
): GhidraProjectBinary | null {
  if (!binaryName) {
    return null;
  }
  const wanted = binaryName.toLowerCase();
  const rows: unknown[] = [];
  const collect = (value: unknown, depth: number): void => {
    if (depth > 4 || !value) {
      return;
    }
    if (Array.isArray(value)) {
      rows.push(...value);
      return;
    }
    if (typeof value !== 'object') {
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of ['programs', 'binaries', 'results', 'items']) {
      if (Array.isArray(record[key])) {
        rows.push(...(record[key] as unknown[]));
      }
    }
    if (rows.length === 0) {
      for (const nested of Object.values(record)) {
        collect(nested, depth + 1);
      }
    }
  };
  collect(payload, 0);

  for (const row of rows) {
    if (typeof row === 'string') {
      if (row.toLowerCase().includes(wanted)) {
        return { name: row, analysisComplete: true };
      }
      continue;
    }
    if (!row || typeof row !== 'object') {
      continue;
    }
    const record = row as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    if (!name || !name.toLowerCase().includes(wanted)) {
      continue;
    }
    // Absent means an older build that does not report it; treat that as done
    // rather than waiting forever for a field it will never send.
    const complete =
      record.analysis_complete === undefined ? true : record.analysis_complete === true;
    return { name, analysisComplete: complete };
  }
  return null;
}

export class GhidraLabSessionManager {
  private readonly sessions = new Map<string, SessionRecord>();

  private readonly reservedPorts = new Set<number>();

  private sequence = 0;

  constructor(private readonly deps: GhidraLabSessionDeps) {}

  list(): GhidraLabSessionView[] {
    return [...this.sessions.values()].map(toView);
  }

  get(sessionId: string): GhidraLabSessionView | null {
    const record = this.sessions.get(sessionId);
    return record ? toView(record) : null;
  }

  activeCount(): number {
    let count = 0;
    for (const record of this.sessions.values()) {
      if (record.state === 'starting' || record.state === 'ready') {
        count += 1;
      }
    }
    return count;
  }

  findByBinary(binaryPath: string): GhidraLabSessionView | null {
    for (const record of this.sessions.values()) {
      if (isTerminalSessionState(record)) {
        continue;
      }
      if (record.binaryPath.toLowerCase() === binaryPath.toLowerCase()) {
        return toView(record);
      }
    }
    return null;
  }

  private nextId(now: number): string {
    this.sequence += 1;
    return `ghidra-${now.toString(36)}-${this.sequence.toString(36)}`;
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
   * Allocate a port, holding a reservation across the async probe so two
   * concurrent starts cannot both pick the same free port and have the second
   * server fail to bind.
   */
  private async allocatePort(config: GhidraLabConfigView): Promise<number> {
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

  private endpointFor(port: number): string {
    return `http://127.0.0.1:${port}/mcp`;
  }

  /**
   * Start a headless pyghidra-mcp server for `binaryPath`.
   *
   * Returns as soon as the process is up. Readiness is polled in the background
   * and reflected in the session state, because Ghidra auto-analysis can take
   * minutes and an HTTP request must not block on it.
   */
  async startHeadless(params: {
    config: GhidraLabConfigView;
    binaryPath: string;
    projectName: string;
    launch: PyghidraLaunchKind;
    write?: boolean;
  }): Promise<GhidraLabStartResult> {
    const existing = this.findByBinary(params.binaryPath);
    if (existing) {
      return {
        ok: false,
        session: null,
        existingSessionId: existing.id,
        reason: 'session_already_open',
      };
    }
    if (this.activeCount() >= GHIDRA_LAB_MAX_SESSIONS) {
      return { ok: false, session: null, reason: 'session_limit_reached' };
    }
    if (!params.config.pythonExePath) {
      return { ok: false, session: null, reason: 'python_not_configured' };
    }

    const port = await this.allocatePort(params.config);
    if (!port) {
      this.reservedPorts.delete(port);
      return { ok: false, session: null, reason: 'no_free_port' };
    }

    const command = buildPyghidraMcpCommand({
      config: params.config,
      launch: params.launch,
      binaryPath: params.binaryPath,
      projectName: params.projectName,
      port,
      projectExists:
        this.deps.projectExists?.(params.config.projectRoot, params.projectName) ?? false,
    });
    const env = buildGhidraChildEnv(params.config);
    const now = this.deps.now();
    const record: SessionRecord = {
      id: this.nextId(now),
      binaryPath: params.binaryPath,
      binaryName: baseName(params.binaryPath),
      projectName: params.projectName,
      mode: 'headless',
      write: params.write === true,
      state: 'starting',
      port,
      pid: null,
      startedAt: now,
      readyAt: null,
      lastUsedAt: now,
      queryCount: 0,
      failureReason: '',
      outputTail: '',
      child: null,
      client: null,
      engineTools: new Set<string>(),
      engineBinaryName: '',
      activeQueries: 0,
      progress: null,
    };

    let child: GhidraChildHandle;
    try {
      child = this.deps.spawnProcess(command.program, command.args, {
        cwd: params.config.projectRoot || process.cwd(),
        env,
      });
    } catch (error) {
      this.reservedPorts.delete(port);
      this.deps.logError?.('ghidra-lab spawn failed', error);
      return {
        ok: false,
        session: null,
        reason: `spawn_failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    record.child = child;
    record.pid = child.pid;
    this.sessions.set(record.id, record);
    this.reservedPorts.delete(port);

    if (child.pid) {
      this.deps.onSpawned?.({ pid: child.pid, imageName: baseName(command.program) });
    }

    child.onOutput((chunk) => {
      record.outputTail = truncateTail(record.outputTail, chunk);
    });
    child.onExit((code, signal) => {
      if (isTerminalSessionState(record)) {
        return;
      }
      record.state = 'failed';
      record.failureReason = describeGhidraExit(code, signal, record.outputTail);
    });

    void this.pollReady(record, params.config);
    return { ok: true, session: toView(record), reason: '' };
  }

  /**
   * Walk a starting session through both waits.
   *
   * The JVM phase has its own, shorter deadline: if MCP has not answered in three
   * minutes the problem is the install, not the binary, and saying "analysis
   * timed out" after 45 minutes would be a lie about where to look.
   */
  private async pollReady(record: SessionRecord, config: GhidraLabConfigView): Promise<void> {
    const start = this.deps.now();
    const analysisDeadline = start + config.analysisTimeoutMs;
    const jvmDeadline = start + JVM_PHASE_TIMEOUT_MS;
    let interval = READY_POLL_MIN_MS;
    let mcpUp = false;
    let pending: GhidraMcpClientLike | undefined;

    while (this.deps.now() < analysisDeadline) {
      if (isTerminalSessionState(record)) {
        return;
      }
      await this.deps.sleep(interval);
      interval = Math.min(READY_POLL_MAX_MS, Math.floor(interval * 1.4));
      if (isTerminalSessionState(record)) {
        return;
      }
      this.sampleProgress(record, config, mcpUp ? 'analysis' : 'jvm');

      if (!mcpUp) {
        // One client for the whole wait. Building a new one per tick opened a
        // new MCP transport session on the server every few seconds while it
        // was still starting, for no benefit.
        pending ??= this.deps.createMcpClient(this.endpointFor(record.port));
        const client = pending;
        try {
          await client.initialize();
          const tools = await client.listTools();
          record.client = client;
          record.engineTools = new Set(tools.map((tool) => tool.name));
          mcpUp = true;
        } catch {
          if (this.deps.now() > jvmDeadline) {
            if (isTerminalSessionState(record)) {
              return;
            }
            record.state = 'failed';
            record.failureReason = record.outputTail
              ? `engine never answered on port ${record.port}: ${describeGhidraExit(null, null, record.outputTail)}`
              : `engine never answered on port ${record.port} -- check the Ghidra and JDK paths in Setup`;
            this.terminateChild(record);
            return;
          }
          continue;
        }
      }

      const client = record.client;
      if (!client) {
        continue;
      }
      try {
        const payload = await client.callTool('list_project_binaries', {});
        const found = findProjectBinary(payload, record.binaryName);
        if (found) {
          // Learn the engine's name for this binary even before it is analyzed:
          // every other tool takes that name, not the filename we spawned with.
          record.engineBinaryName = found.name;
        }
        if (found?.analysisComplete) {
          // Re-check: an exit or a stop() can land while the call is in flight.
          // Without this a stopped session flips back to 'ready' on the late
          // answer and queries get sent at a dead port.
          if (isTerminalSessionState(record)) {
            return;
          }
          record.state = 'ready';
          record.readyAt = this.deps.now();
          record.progress = null;
          return;
        }
      } catch {
        // Analysis still running, or the tool is named differently on this
        // build. Either way: keep waiting until the deadline rather than
        // declaring a failure we cannot substantiate.
      }
    }

    if (record.state === 'starting') {
      record.state = 'failed';
      record.failureReason = mcpUp
        ? 'analysis_timeout -- the binary is still being analyzed; raise the analysis timeout in Setup or give it more memory'
        : 'ready_timeout';
      // pyghidra-mcp is a SERVER: it never exits on its own, so giving up on
      // readiness without killing it would leave a live process holding a port
      // that nothing can reach once the record is pruned.
      this.terminateChild(record);
    }
  }

  private terminateChild(record: SessionRecord): void {
    const child = record.child;
    record.child = null;
    record.client = null;
    if (!child) {
      return;
    }
    try {
      child.kill();
    } catch (error) {
      this.deps.logError?.('ghidra-lab kill failed', error);
    }
  }

  /** Which advertised tool actually serves this plan, if any. */
  private resolveTool(record: SessionRecord, plan: GhidraQueryPlan): string {
    if (record.engineTools.size === 0) {
      // Nothing advertised (a faked or very old server): trust the preferred name.
      return plan.tool;
    }
    for (const candidate of plan.candidates) {
      if (record.engineTools.has(candidate)) {
        return candidate;
      }
    }
    return '';
  }

  async query(sessionId: string, kind: unknown, args: unknown): Promise<GhidraLabQueryOutcome> {
    const empty = {
      rows: [] as unknown[],
      rowCount: 0,
      truncated: false,
      elapsedMs: 0,
      engineError: '',
    };
    const record = this.sessions.get(sessionId);
    if (!record) {
      return { ok: false, kind: null, mcpTool: '', ...empty, reason: 'session_not_found' };
    }
    if (record.state !== 'ready') {
      return {
        ok: false,
        kind: null,
        mcpTool: '',
        ...empty,
        reason: `session_not_ready: ${record.state}`,
      };
    }
    const plan = planGhidraQuery(kind, args);
    if (!plan.ok) {
      return { ok: false, kind: plan.kind, mcpTool: '', ...empty, reason: plan.reason };
    }
    // Every engine tool but list_project_binaries requires `binary_name`, and the
    // session already knows which binary it is about. Making the caller repeat it
    // is a needless way to fail -- and the name the engine wants is the one IT
    // assigned at import, not the filename we spawned with.
    if (plan.args.binary_name === undefined) {
      const name = record.engineBinaryName || record.binaryName;
      if (name) {
        plan.args.binary_name = name;
      }
    }
    const tool = this.resolveTool(record, plan);
    if (!tool) {
      const advertised = [...record.engineTools].sort().slice(0, 40).join(', ');
      return {
        ok: false,
        kind: plan.kind,
        mcpTool: '',
        ...empty,
        reason: `tool_not_available_on_engine: tried ${plan.candidates.join(', ')}; this server exposes ${advertised || 'nothing'}`,
      };
    }
    const client = record.client;
    if (!client) {
      return { ok: false, kind: plan.kind, mcpTool: tool, ...empty, reason: 'engine_client_lost' };
    }

    const started = this.deps.now();
    record.activeQueries += 1;
    try {
      const payload = await client.callTool(tool, plan.args);
      const capped = capGhidraQueryRows(normalizeGhidraToolResult(payload));
      record.queryCount += 1;
      record.lastUsedAt = this.deps.now();
      return {
        ok: true,
        kind: plan.kind,
        mcpTool: tool,
        rows: capped.rows,
        rowCount: capped.rowCount,
        truncated: capped.truncated,
        elapsedMs: this.deps.now() - started,
        engineError: '',
        reason: '',
      };
    } catch (error) {
      record.lastUsedAt = this.deps.now();
      return {
        ok: false,
        kind: plan.kind,
        mcpTool: tool,
        rows: [],
        rowCount: 0,
        truncated: false,
        elapsedMs: this.deps.now() - started,
        engineError: error instanceof Error ? error.message : String(error),
        reason: 'engine_error',
      };
    } finally {
      record.activeQueries -= 1;
    }
  }

  async stop(sessionId: string): Promise<{ ok: boolean; reason: string }> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return { ok: false, reason: 'session_not_found' };
    }
    if (isTerminalSessionState(record)) {
      return { ok: true, reason: '' };
    }
    record.state = 'stopped';
    record.failureReason = '';
    record.progress = null;
    this.terminateChild(record);
    return { ok: true, reason: '' };
  }

  /** Close sessions nobody has touched for longer than the configured idle window. */
  async reapIdle(config: GhidraLabConfigView): Promise<string[]> {
    const now = this.deps.now();
    const reaped: string[] = [];
    for (const record of this.sessions.values()) {
      if (record.state !== 'ready') {
        continue;
      }
      // A session running a long query is NOT idle: lastUsedAt is stamped when a
      // query returns, so mid-query it still reads as the previous use.
      if (record.activeQueries > 0) {
        continue;
      }
      if (now - record.lastUsedAt < config.sessionIdleTimeoutMs) {
        continue;
      }
      record.state = 'stopped';
      record.failureReason = 'idle_timeout';
      this.terminateChild(record);
      reaped.push(record.id);
    }
    return reaped;
  }

  touch(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record && !isTerminalSessionState(record)) {
      record.lastUsedAt = this.deps.now();
    }
  }

  private sampleProgress(
    record: SessionRecord,
    config: GhidraLabConfigView,
    phase: 'jvm' | 'analysis',
  ): void {
    if (!this.deps.projectBytes) {
      record.progress = {
        phase,
        projectBytes: 0,
        deltaBytes: 0,
        sampledAt: this.deps.now(),
        sampleCount: (record.progress?.sampleCount ?? 0) + 1,
      };
      return;
    }
    const bytes = this.deps.projectBytes(config.projectRoot, record.projectName);
    const previous = record.progress;
    record.progress = {
      phase,
      projectBytes: bytes,
      deltaBytes: previous ? Math.max(0, bytes - previous.projectBytes) : 0,
      sampledAt: this.deps.now(),
      sampleCount: (previous?.sampleCount ?? 0) + 1,
    };
  }

  outputTail(sessionId: string): string {
    return this.sessions.get(sessionId)?.outputTail ?? '';
  }

  /** The engine's own name for the session's binary, once known. */
  engineBinaryName(sessionId: string): string {
    const record = this.sessions.get(sessionId);
    return record?.engineBinaryName ?? '';
  }

  engineToolNames(sessionId: string): string[] {
    const record = this.sessions.get(sessionId);
    return record ? [...record.engineTools].sort() : [];
  }

  killAllChildren(): void {
    for (const record of this.sessions.values()) {
      if (!isTerminalSessionState(record)) {
        record.state = 'stopped';
        record.failureReason = 'server_shutdown';
      }
      this.terminateChild(record);
    }
  }

  pruneTerminal(maxAgeMs: number): void {
    const now = this.deps.now();
    for (const [id, record] of [...this.sessions.entries()]) {
      if (!isTerminalSessionState(record)) {
        continue;
      }
      if (now - record.lastUsedAt > maxAgeMs) {
        this.sessions.delete(id);
      }
    }
  }
}

// --- Node wiring ------------------------------------------------------------

function directoryBytes(path: string, depth = 0): number {
  if (depth > 6) {
    return 0;
  }
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    try {
      if (entry.isDirectory()) {
        total += directoryBytes(child, depth + 1);
      } else if (entry.isFile()) {
        total += fs.statSync(child).size;
      }
    } catch {
      // A file can vanish mid-walk while Ghidra writes; skip it.
    }
  }
  return total;
}

export function createGhidraLabNodeDeps(
  overrides: Partial<GhidraLabSessionDeps> = {},
): GhidraLabSessionDeps {
  const base: GhidraLabSessionDeps = {
    spawnProcess(program, args, options) {
      const child = spawn(program, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // shell:false. Batch mode needs cmd.exe as the PROGRAM (see
        // buildAnalyzeHeadlessCommand); it never needs a shell here.
        shell: false,
      });
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      return {
        pid: child.pid ?? null,
        onExit(listener) {
          child.on('exit', listener);
          child.on('error', () => listener(null, null));
        },
        onOutput(listener) {
          child.stdout?.on('data', listener);
          child.stderr?.on('data', listener);
        },
        kill() {
          // Kill the TREE, not the process we spawned.
          //
          // `python -m pyghidra_mcp` re-execs, and the descendant is what holds
          // the Ghidra JVM: measured at 530MB and 102 threads while the process
          // we hold sat at 4MB and one thread. child.kill() reaps the launcher
          // and leaves the JVM running with nothing able to reach it.
          if (process.platform === 'win32' && child.pid) {
            try {
              spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true,
                shell: false,
                stdio: 'ignore',
              });
              return;
            } catch {
              // Fall through to the direct kill below.
            }
          }
          child.kill();
        },
      };
    },
    createMcpClient(endpoint) {
      // A fresh client per session on purpose: the shared cache is keyed by
      // endpoint, and a reused port would inherit a dead session's MCP id.
      return new McpHttpClient(endpoint, 'openroom-ghidra-lab', '1.0.0');
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    async isPortFree(port) {
      return new Promise<boolean>((resolve) => {
        const server = createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => {
          server.close(() => resolve(true));
        });
        server.listen(port, '127.0.0.1');
      });
    },
    projectBytes(projectRoot, projectName) {
      if (!projectRoot) {
        return 0;
      }
      // Ghidra keeps the database beside the .gpr in `<name>.rep`.
      return directoryBytes(join(projectRoot, `${projectName}.rep`));
    },
    projectExists(projectRoot, projectName) {
      if (!projectRoot) {
        return false;
      }
      try {
        return fs.existsSync(join(projectRoot, `${projectName}.gpr`));
      } catch {
        return false;
      }
    },
    logError(message, error) {
      console.error(`[ghidra-lab] ${message}`, error);
    },
  };
  return { ...base, ...overrides };
}

let sharedManager: GhidraLabSessionManager | null = null;

export function getSharedGhidraLabSessionManager(
  deps?: GhidraLabSessionDeps,
): GhidraLabSessionManager {
  if (!sharedManager) {
    sharedManager = new GhidraLabSessionManager(deps ?? createGhidraLabNodeDeps());
  }
  return sharedManager;
}

export function resetSharedGhidraLabSessionManager(): void {
  sharedManager?.killAllChildren();
  sharedManager = null;
}

// MCP_CALL_TIMEOUT_MS is exported for the routes, which need a wall for a single
// engine call that is longer than the client's own default but still finite.
export { MCP_CALL_TIMEOUT_MS };
