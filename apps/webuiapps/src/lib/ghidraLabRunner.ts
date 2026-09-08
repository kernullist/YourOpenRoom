// Ghidra Lab run manager: own the lifetime of a full-binary sweep + report.
//
// A sweep is the most expensive thing this feature does -- tens of minutes on a
// large binary, dozens of engine calls, and several model turns -- so it cannot
// run inside an HTTP request. Starting one returns a run id immediately; the run
// walks the stages in the background, and its progress is readable at any time.
//
// Three things this owns that the sweep itself deliberately does not:
//   - CANCELLATION. `shouldContinue` is wired to a per-run flag, so an operator
//     can stop a sweep between stages without killing the session it borrowed.
//   - PERSISTENCE. report.md / ledger.json / manifest.json land under the run
//     directory, which is what makes a report survive a server restart.
//   - CAPA. The second engine is a separate process, not an MCP call, so it is
//     spawned here and handed to the sweep as an injected dependency.
//
// Server-only: fs + child_process.
import { spawn } from 'child_process';
import * as fs from 'fs';
import { join } from 'path';

import { buildGhidraChildEnv } from './ghidraLabConfig';
import { writeGhidraReport, type GhidraReportDeps } from './ghidraLabReport';
import type { GhidraLabQueryOutcome } from './ghidraLabSession';
import {
  hashFileSync,
  runGhidraSweep,
  type GhidraCapaOutcome,
  type GhidraSweepDeps,
} from './ghidraLabSweep';
import type {
  GhidraLabConfigView,
  GhidraReportRunState,
  GhidraReportRunView,
  GhidraSweepLedger,
  GhidraSweepStageView,
} from './ghidraLabTypes';

/** capa on a large binary is slow but not unbounded; past this it is stuck. */
/**
 * How capa is launched.
 *
 * Injectable only so the outcome paths below -- a JSON document, a truncated
 * one, a crash, a timeout -- can be driven without a capa install. Production
 * passes nothing and gets `child_process.spawn`.
 */
export type SpawnCapa = typeof spawn;

const CAPA_TIMEOUT_MS = 15 * 60 * 1000;
const CAPA_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const GHIDRA_RUN_RETENTION_MS = 24 * 60 * 60 * 1000;
/**
 * The only run-id shape this manager mints (`grun-<base36>-<base36>`).
 *
 * Enforced before a run id is ever joined onto a filesystem path: the id comes
 * from a query string, and reading artifacts from disk (needed so a report
 * survives a server restart) would otherwise be a traversal primitive.
 */
export const RUN_ID_PATTERN = /^grun-[a-z0-9]+-[a-z0-9]+$/;
const MAX_RUNS_TRACKED = 40;
/** Decompiled bodies are large; a summary prompt must not carry an essay. */
const FUNCTION_SUMMARY_TOKENS = 400;

interface RunRecord {
  runId: string;
  sessionId: string;
  binaryPath: string;
  binaryName: string;
  state: GhidraReportRunState;
  stages: GhidraSweepStageView[];
  startedAt: number;
  finishedAt: number | null;
  anchorCount: number;
  droppedClaims: number;
  reportPath: string;
  ledgerPath: string;
  failureReason: string;
  cancelled: boolean;
}

export interface GhidraLabRunDeps {
  /** The session manager's query, already bound to a live session. */
  query(
    sessionId: string,
    kind: string,
    args: Record<string, unknown>,
  ): Promise<GhidraLabQueryOutcome>;
  /** Absent -> the deterministic report ships and no function is summarized. */
  callModel?(prompt: string, maxTokens: number, responseJson: boolean): Promise<string>;
  hashFile?(path: string): { sha256: string; sizeBytes: number; mtimeMs: number };
  runCapa?(params: { binaryPath: string; config: GhidraLabConfigView }): Promise<GhidraCapaOutcome>;
  writeArtifact?(path: string, contents: string): void;
  /** Injected so a test does not have to wait out the string-index poll. */
  sleep?(ms: number): Promise<void>;
  now(): number;
  logError?(message: string, error?: unknown): void;
}

function toView(record: RunRecord): GhidraReportRunView {
  return {
    runId: record.runId,
    sessionId: record.sessionId,
    binaryPath: record.binaryPath,
    binaryName: record.binaryName,
    state: record.state,
    stages: record.stages,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    anchorCount: record.anchorCount,
    droppedClaims: record.droppedClaims,
    reportPath: record.reportPath,
    ledgerPath: record.ledgerPath,
    failureReason: record.failureReason,
  };
}

/**
 * Ask the model what one function does.
 *
 * Bounded hard on both sides: the decompiled body was already capped by the
 * sweep, and the answer is capped here. The prompt forbids speculation because
 * this summary becomes a ledger anchor marked non-deterministic -- it will be
 * quoted, so it must not contain anything the code does not show.
 */
function buildFunctionSummaryPrompt(params: {
  name: string;
  address: string;
  decompiled: string;
  reasons: string[];
}): string {
  return [
    'Summarize what this decompiled function does, in at most three sentences.',
    'Describe only what the code shows. Do not speculate about intent or malice.',
    'If the decompilation is too degraded to read, say exactly that and nothing else.',
    '',
    `Function: ${params.name || '(unnamed)'} at ${params.address || '(unknown address)'}`,
    `It was selected because: ${params.reasons.join('; ') || 'unspecified'}`,
    '',
    params.decompiled,
  ].join('\n');
}

export class GhidraLabRunManager {
  private readonly runs = new Map<string, RunRecord>();

  private sequence = 0;

  constructor(
    private readonly deps: GhidraLabRunDeps,
    private readonly runsDir: string,
  ) {}

  list(): GhidraReportRunView[] {
    return [...this.runs.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .map(toView);
  }

  get(runId: string): GhidraReportRunView | null {
    const record = this.runs.get(runId);
    return record ? toView(record) : null;
  }

  activeCount(): number {
    let count = 0;
    for (const record of this.runs.values()) {
      if (
        record.state === 'queued' ||
        record.state === 'running' ||
        record.state === 'drafting' ||
        record.state === 'verifying'
      ) {
        count += 1;
      }
    }
    return count;
  }

  findByBinary(binaryPath: string): GhidraReportRunView | null {
    for (const record of this.runs.values()) {
      if (record.state !== 'running' && record.state !== 'queued') {
        continue;
      }
      if (record.binaryPath.toLowerCase() === binaryPath.toLowerCase()) {
        return toView(record);
      }
    }
    return null;
  }

  cancel(runId: string): boolean {
    const record = this.runs.get(runId);
    if (!record) {
      return false;
    }
    if (record.state === 'done' || record.state === 'failed' || record.state === 'cancelled') {
      return false;
    }
    // Flag only. The sweep checks between stages, so an engine call already in
    // flight finishes rather than being torn out from under the engine.
    record.cancelled = true;
    return true;
  }

  /**
   * The clock, with a fallback.
   *
   * Only used on the failure paths. `now()` is injected, and a run that is
   * failing because a dep threw must still be marked finished -- otherwise the
   * UI polls a run that will never resolve.
   */
  private safeNow(fallback: number): number {
    try {
      return this.deps.now();
    } catch {
      return fallback;
    }
  }

  private runDir(runId: string): string {
    return join(this.runsDir, runId);
  }

  /**
   * Resolve one artifact of a run to a path, or '' if the id is not ours.
   *
   * The id reaches this from an HTTP query string, and the in-memory record it
   * used to depend on is gone after a restart -- so reading from disk is
   * necessary AND the id has to be validated before it is joined onto a path.
   * `grun-<base36>-<base36>` is the only shape this manager ever mints; anything
   * else (a traversal, an absolute path, a UNC prefix) is refused outright
   * rather than sanitised, because sanitising path input is how traversals get
   * through.
   */
  private artifactPath(runId: string, file: 'report.md' | 'ledger.json'): string {
    if (!RUN_ID_PATTERN.test(runId)) {
      return '';
    }
    const record = this.runs.get(runId);
    if (record) {
      return file === 'report.md' ? record.reportPath : record.ledgerPath;
    }
    // Not in memory: the run predates this process. The id is known-safe here.
    return join(this.runDir(runId), file);
  }

  readReport(runId: string): string {
    const path = this.artifactPath(runId, 'report.md');
    if (!path) {
      return '';
    }
    try {
      return fs.readFileSync(path, 'utf-8');
    } catch {
      return '';
    }
  }

  readLedger(runId: string): GhidraSweepLedger | null {
    const path = this.artifactPath(runId, 'ledger.json');
    if (!path) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(path, 'utf-8')) as GhidraSweepLedger;
    } catch {
      return null;
    }
  }

  prune(maxAgeMs: number, now: number): void {
    for (const [runId, record] of [...this.runs.entries()]) {
      const finished = record.finishedAt ?? record.startedAt;
      if (record.state === 'running' || record.state === 'queued') {
        continue;
      }
      if (now - finished > maxAgeMs) {
        this.runs.delete(runId);
      }
    }
    // Bound the map even when nothing has aged out.
    if (this.runs.size > MAX_RUNS_TRACKED) {
      const oldest = [...this.runs.values()]
        .filter((record) => record.state !== 'running' && record.state !== 'queued')
        .sort((left, right) => left.startedAt - right.startedAt);
      for (const record of oldest.slice(0, this.runs.size - MAX_RUNS_TRACKED)) {
        this.runs.delete(record.runId);
      }
    }
  }

  /**
   * Start a sweep + report. Returns immediately with a run id; the work happens
   * in the background and shows up in `get(runId)`.
   */
  start(params: {
    sessionId: string;
    binaryPath: string;
    binaryName: string;
    config: GhidraLabConfigView;
  }): { ok: boolean; runId: string; reason: string } {
    const existing = this.findByBinary(params.binaryPath);
    if (existing) {
      return { ok: false, runId: existing.runId, reason: 'run_already_active' };
    }
    const now = this.deps.now();
    this.sequence += 1;
    const runId = `grun-${now.toString(36)}-${this.sequence.toString(36)}`;
    const dir = this.runDir(runId);
    const record: RunRecord = {
      runId,
      sessionId: params.sessionId,
      binaryPath: params.binaryPath,
      binaryName: params.binaryName,
      state: 'queued',
      stages: [],
      startedAt: now,
      finishedAt: null,
      anchorCount: 0,
      droppedClaims: 0,
      reportPath: join(dir, 'report.md'),
      ledgerPath: join(dir, 'ledger.json'),
      failureReason: '',
      cancelled: false,
    };
    this.runs.set(runId, record);
    // The sweep runs in the background, so nothing is awaiting this promise --
    // which makes an unhandled rejection here fatal: Node's default is to
    // terminate the process, taking the dev server down with a run that was
    // only supposed to fail. Everything inside execute() is already guarded,
    // so reaching this catch means a dep itself threw (a clock, a logger, an
    // artifact writer). Record it on the run and keep the server up.
    void this.execute(record, params.config).catch((error) => {
      record.state = 'failed';
      record.failureReason = error instanceof Error ? error.message : String(error);
      if (record.finishedAt === null) {
        record.finishedAt = this.safeNow(record.startedAt);
      }
      try {
        this.deps.logError?.('ghidra-lab run crashed', error);
      } catch {
        // A logger that throws must not re-enter this handler.
      }
    });
    return { ok: true, runId, reason: '' };
  }

  private writeArtifact(path: string, contents: string): void {
    if (this.deps.writeArtifact) {
      this.deps.writeArtifact(path, contents);
      return;
    }
    try {
      fs.mkdirSync(join(path, '..'), { recursive: true });
      fs.writeFileSync(path, contents, 'utf-8');
    } catch (error) {
      this.deps.logError?.('ghidra-lab artifact write failed', error);
    }
  }

  private async execute(record: RunRecord, config: GhidraLabConfigView): Promise<void> {
    record.state = 'running';
    const sweepDeps: GhidraSweepDeps = {
      query: (sessionId, kind, args) => this.deps.query(sessionId, kind, args),
      hashFile: this.deps.hashFile ?? hashFileSync,
      now: () => this.deps.now(),
      sleep: this.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      shouldContinue: () => !record.cancelled,
      onStage: (_stage, ledger) => {
        record.stages = ledger.stages;
        record.anchorCount = ledger.anchors.length;
      },
      ...(this.deps.logError ? { logError: this.deps.logError } : {}),
      ...(this.deps.runCapa ? { runCapa: this.deps.runCapa } : {}),
      ...(this.deps.callModel
        ? {
            summarizeFunction: async (summaryParams) => {
              const answer = await this.deps.callModel?.(
                buildFunctionSummaryPrompt(summaryParams),
                FUNCTION_SUMMARY_TOKENS,
                false,
              );
              return (answer ?? '').trim().slice(0, 800);
            },
          }
        : {}),
    };

    let ledger: GhidraSweepLedger;
    try {
      ledger = await runGhidraSweep({
        runId: record.runId,
        sessionId: record.sessionId,
        binaryPath: record.binaryPath,
        binaryName: record.binaryName,
        config,
        deps: sweepDeps,
      });
    } catch (error) {
      record.state = 'failed';
      record.failureReason = error instanceof Error ? error.message : String(error);
      record.finishedAt = this.safeNow(record.startedAt);
      return;
    }

    record.stages = ledger.stages;
    record.anchorCount = ledger.anchors.length;
    this.writeArtifact(record.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

    if (record.cancelled) {
      record.state = 'cancelled';
      record.finishedAt = this.deps.now();
      // A cancelled sweep still produced findings; write what it got so the
      // work is not simply lost.
      const partial = await writeGhidraReport(ledger, this.reportDeps());
      this.writeArtifact(record.reportPath, partial.report);
      return;
    }

    record.state = 'drafting';
    try {
      const written = await writeGhidraReport(ledger, this.reportDeps());
      record.droppedClaims = written.droppedClaims;
      this.writeArtifact(record.reportPath, written.report);
      this.writeArtifact(
        join(this.runDir(record.runId), 'manifest.json'),
        `${JSON.stringify(
          {
            runId: record.runId,
            binaryPath: record.binaryPath,
            binaryName: record.binaryName,
            sha256: ledger.sha256,
            sizeBytes: ledger.sizeBytes,
            startedAt: record.startedAt,
            finishedAt: this.deps.now(),
            modelWritten: written.modelWritten,
            rewritten: written.rewritten,
            droppedClaims: written.droppedClaims,
            unknownAnchors: written.unknownAnchors,
            citedAnchors: written.citedAnchors.length,
            anchorCount: ledger.anchors.length,
            verifierFindings: written.verifierFindings,
            stages: ledger.stages,
          },
          null,
          2,
        )}\n`,
      );
      record.state = 'done';
    } catch (error) {
      record.state = 'failed';
      record.failureReason = error instanceof Error ? error.message : String(error);
      this.deps.logError?.('ghidra-lab report failed', error);
    }
    record.finishedAt = this.safeNow(record.startedAt);
  }

  private reportDeps(): GhidraReportDeps {
    return {
      ...(this.deps.callModel ? { callModel: this.deps.callModel } : {}),
      ...(this.deps.logError ? { logError: this.deps.logError } : {}),
    };
  }
}

/**
 * Run capa over a binary and parse its JSON document.
 *
 * ASYNCHRONOUS on purpose. capa can run for a quarter of an hour on a large
 * binary, and this executes inside the dev server's Node process -- a spawnSync
 * here freezes the event loop for the whole run, so every other request in the
 * app hangs behind it. Measured on the sibling bootstrap path, which had the
 * same shape and took the server down with it for the length of a pip install.
 *
 * capa stays a separate process rather than a library call so a capa crash costs
 * a stage, not the sweep. `-j` is the JSON switch; the Ghidra child environment
 * is reused so a capa build that shells out to a JDK finds the same one Ghidra
 * does.
 */
export function runCapa(
  params: {
    binaryPath: string;
    config: GhidraLabConfigView;
  },
  spawnCapa: SpawnCapa = spawn,
): Promise<GhidraCapaOutcome> {
  const exe = params.config.capaExePath;
  if (!exe) {
    return Promise.resolve({ ok: false, payload: null, error: 'capa_not_configured' });
  }
  return new Promise<GhidraCapaOutcome>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (outcome: GhidraCapaOutcome): void => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnCapa(exe, ['-j', params.binaryPath], {
        env: buildGhidraChildEnv(params.config),
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      finish({
        ok: false,
        payload: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish({ ok: false, payload: null, error: `capa timed out after ${CAPA_TIMEOUT_MS}ms` });
    }, CAPA_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      // The document is large but bounded; stop growing rather than letting one
      // run exhaust memory.
      if (stdout.length < CAPA_MAX_OUTPUT_BYTES) {
        stdout += chunk;
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) {
        stderr += chunk;
      }
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      finish({ ok: false, payload: null, error: error.message });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      const start = stdout.indexOf('{');
      if (start < 0) {
        finish({
          ok: false,
          payload: null,
          error: stderr.trim().slice(0, 500) || `capa exited ${code} with no JSON`,
        });
        return;
      }
      try {
        finish({ ok: true, payload: JSON.parse(stdout.slice(start)), error: '' });
      } catch (error) {
        finish({
          ok: false,
          payload: null,
          error: `capa output was not JSON: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
  });
}

let sharedRunManager: GhidraLabRunManager | null = null;

export function getSharedGhidraLabRunManager(
  deps: GhidraLabRunDeps,
  runsDir: string,
): GhidraLabRunManager {
  if (!sharedRunManager) {
    sharedRunManager = new GhidraLabRunManager(deps, runsDir);
  }
  return sharedRunManager;
}

export function resetSharedGhidraLabRunManager(): void {
  sharedRunManager = null;
}
