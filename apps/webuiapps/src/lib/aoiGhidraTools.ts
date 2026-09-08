// Chat-facing Ghidra Lab tools: let Aoi find a binary on the real PC, propose
// starting Ghidra on it, ask bounded questions about it, and run a full sweep
// that ends in a written report.
//
// The surface is deliberately narrow -- seven tools where the engine publishes
// dozens and competing MCP servers publish 200+. Aoi can PROPOSE (find, start,
// sweep) and it can READ. It cannot approve its own proposal, edit the configured
// paths, or bootstrap a Python environment: those routes exist, but they are not
// called from here, so they are not in the model's tool list. That is the same
// posture the host-bridge and IDA Lab tools take, and the same honest limit --
// what keeps Aoi out is the absence of the tool, not a separate credential.
//
// Every result is a JSON string, because these results are read by a model: the
// keys ARE the explanation, and a refusal has to say what to do next.
import {
  browseGhidraPath,
  cancelGhidraRun,
  fetchGhidraLabHealth,
  fetchGhidraReport,
  fetchGhidraRuns,
  fetchGhidraSessions,
  findGhidraBinaries,
  previewGhidraReport,
  previewGhidraSession,
  runGhidraQuery,
  stopGhidraSession,
} from './ghidraLabClient';
import { GHIDRA_QUERY_SPECS } from './ghidraLabQuery';
import type { GhidraLabSessionView } from './ghidraLabTypes';
import type { ToolDef } from './llmClient';

export const GHIDRA_FIND_BINARY_TOOL = 'ghidra_find_binary';
export const GHIDRA_SESSION_LIST_TOOL = 'ghidra_session_list';
export const GHIDRA_ANALYZE_START_TOOL = 'ghidra_analyze_start';
export const GHIDRA_QUERY_TOOL = 'ghidra_query';
export const GHIDRA_REPORT_RUN_TOOL = 'ghidra_report_run';
export const GHIDRA_REPORT_READ_TOOL = 'ghidra_report_read';
export const GHIDRA_SESSION_STOP_TOOL = 'ghidra_session_stop';

const GHIDRA_TOOL_NAMES: readonly string[] = [
  GHIDRA_FIND_BINARY_TOOL,
  GHIDRA_SESSION_LIST_TOOL,
  GHIDRA_ANALYZE_START_TOOL,
  GHIDRA_QUERY_TOOL,
  GHIDRA_REPORT_RUN_TOOL,
  GHIDRA_REPORT_READ_TOOL,
  GHIDRA_SESSION_STOP_TOOL,
];

// --- What a result may cost the model ---------------------------------------
//
// A decompiled function is tens of kilobytes and a sweep report is longer than
// most chat turns. The engine already caps rows; these caps are the second wall,
// applied to what actually reaches the history.
const MAX_ROWS_IN_RESULT = 40;
const MAX_RESULT_CHARS = 6000;
const MAX_REPORT_CHARS = 12000;

/**
 * Serialize a tool result under a character budget.
 *
 * The budget is a parameter because reading a report is a different kind of
 * answer from listing imports: the report was explicitly asked for and is
 * useless truncated to a few paragraphs. With one shared cap, the report path
 * capped its text to MAX_REPORT_CHARS and then this function replaced the whole
 * thing with a "too large" stub, so a finished report could never actually
 * reach the model.
 */
function jsonResult(value: unknown, maxChars: number = MAX_RESULT_CHARS): string {
  let text = '';
  try {
    text = JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: 'result_not_serializable' });
  }
  if (text.length <= maxChars) {
    return text;
  }
  // Truncating JSON produces invalid JSON, so say so in valid JSON instead.
  return JSON.stringify({
    truncated: true,
    note: `Result was ${text.length} chars, over the ${maxChars} cap. Ask a narrower question (add a name/pattern, or a lower limit).`,
    preview: text.slice(0, Math.max(0, maxChars - 400)),
  });
}

function errorResult(error: unknown, hint?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({ error: message, ...(hint ? { hint } : {}) });
}

function describeSession(session: GhidraLabSessionView): Record<string, unknown> {
  return {
    sessionId: session.id,
    binary: session.binaryName,
    binaryPath: session.binaryPath,
    project: session.projectName,
    state: session.state,
    ...(session.state === 'starting' && session.progress
      ? {
          waitingOn:
            session.progress.phase === 'jvm'
              ? 'the JVM is still booting and the engine is not answering yet'
              : 'Ghidra is still analyzing the binary',
        }
      : {}),
    ...(session.failureReason ? { failureReason: session.failureReason } : {}),
  };
}

// --- Gating ------------------------------------------------------------------

const GHIDRA_STICKY_KEY = 'aoi.ghidraLab.lastTouched';
const GHIDRA_STICKY_TTL_MS = 30 * 60 * 1000;

let ghidraTouchedAt = 0;
let ghidraStickyWrittenAt = 0;

function readStickyStore(): number {
  try {
    const raw = globalThis.localStorage?.getItem(GHIDRA_STICKY_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

/** Mark Ghidra Lab as in-use so the tools stay available for the next few turns. */
export function touchGhidraTools(now: number = Date.now()): void {
  ghidraTouchedAt = now;
  // Throttle the write: this is called per tool use, and localStorage is sync.
  if (now - ghidraStickyWrittenAt > 30_000) {
    ghidraStickyWrittenAt = now;
    try {
      globalThis.localStorage?.setItem(GHIDRA_STICKY_KEY, String(now));
    } catch {
      // Non-fatal: stickiness degrades to trigger-word matching.
    }
  }
}

function isGhidraSessionSticky(now: number = Date.now()): boolean {
  const at = Math.max(ghidraTouchedAt, readStickyStore());
  // A clock that jumped backwards would otherwise make a fresh mark look
  // ancient; treat a future stamp as current rather than as expired.
  return at > 0 && (now < at || now - at < GHIDRA_STICKY_TTL_MS);
}

/** Test seam. */
export function resetGhidraToolStickiness(): void {
  ghidraTouchedAt = 0;
  ghidraStickyWrittenAt = 0;
  try {
    globalThis.localStorage?.removeItem(GHIDRA_STICKY_KEY);
  } catch {
    // Nothing to clear.
  }
}

const GHIDRA_TRIGGER_PATTERNS: readonly RegExp[] = [
  /\bghidra\b/i,
  /\bpyghidra\b/i,
  /\bcapa\b/i,
  /\bdecompil/i,
  /\bdisassembl/i,
  /\bbinary analysis\b/i,
  /\breverse[- ]?engineer/i,
  /\bcall\s?graph\b/i,
  /기드라/,
  /리버싱/,
  /역분석/,
  /디컴파일/,
  /바이너리\s*분석/,
];

export function shouldEnableGhidraTools(
  latestUserMessage: string,
  history: readonly { content?: unknown }[] = [],
): boolean {
  if (isGhidraSessionSticky()) {
    return true;
  }
  const recent = history
    .slice(-3)
    .map((entry) => (typeof entry.content === 'string' ? entry.content : ''));
  const haystack = [latestUserMessage, ...recent].join('\n');
  return GHIDRA_TRIGGER_PATTERNS.some((pattern) => pattern.test(haystack));
}

export function isGhidraTool(toolName: string): boolean {
  return GHIDRA_TOOL_NAMES.includes(toolName);
}

// --- Definitions -------------------------------------------------------------

const QUERY_KIND_HELP = GHIDRA_QUERY_SPECS.map((spec) => `${spec.kind} (${spec.summary})`).join(
  '; ',
);

export function getGhidraToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: GHIDRA_FIND_BINARY_TOOL,
        description:
          'Find a binary on the real operator PC to analyze with Ghidra. Searches only inside the ' +
          'folders registered as Ghidra Lab binary roots. Use this before ghidra_analyze_start ' +
          'when you only know a file name. Returns absolute paths; pass one verbatim.',
        parameters: {
          type: 'object',
          properties: {
            find: {
              type: 'string',
              description:
                'Case-insensitive filename substring, e.g. "client", "tavern.sys". Omit to list the registered roots.',
            },
            path: {
              type: 'string',
              description: 'Optional absolute folder to search inside (must be within a root).',
            },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: GHIDRA_SESSION_LIST_TOOL,
        description:
          'List open Ghidra analysis sessions plus the lab configuration state (Ghidra version, ' +
          'JDK version, which modes are available and why). Call this first when unsure whether ' +
          'the lab is usable at all.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: GHIDRA_ANALYZE_START_TOOL,
        description:
          'PROPOSE starting headless Ghidra on a binary. This starts nothing by itself: it records ' +
          'a pending approval the operator must click. Analysis of a large binary takes minutes, ' +
          'so poll ghidra_session_list until the session is "ready" before querying it.',
        parameters: {
          type: 'object',
          properties: {
            binaryPath: {
              type: 'string',
              description:
                'Absolute path inside a registered binary root, from ghidra_find_binary.',
            },
          },
          required: ['binaryPath'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: GHIDRA_QUERY_TOOL,
        description:
          `Ask one bounded question of an open Ghidra session. Sub-commands: ${QUERY_KIND_HELP}. ` +
          'Results are capped; narrow with a name/pattern rather than asking for everything.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'From ghidra_session_list.' },
            kind: {
              type: 'string',
              description: `One of: ${GHIDRA_QUERY_SPECS.map((spec) => spec.kind).join(', ')}.`,
            },
            args: {
              type: 'object',
              description:
                'Sub-command arguments, e.g. {"name":"DriverEntry"} for decompile, {"query":"registry"} for search. Unknown keys are dropped.',
            },
          },
          required: ['sessionId', 'kind'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: GHIDRA_REPORT_RUN_TOOL,
        description:
          'PROPOSE a full sweep of an open session: identity, imports, exports, strings, function ' +
          'inventory, deep read of the most interesting functions, capa capability matching, call ' +
          'graph, then a written report where every claim cites collected evidence. Records a ' +
          'pending approval; the operator clicks to start. Takes many minutes. Poll with ' +
          'ghidra_report_read.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'A session already in the "ready" state.' },
          },
          required: ['sessionId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: GHIDRA_REPORT_READ_TOOL,
        description:
          'List sweep runs, or read one finished report. Without runId it returns run states and ' +
          'per-stage progress; with runId it returns the report markdown (truncated).',
        parameters: {
          type: 'object',
          properties: {
            runId: { type: 'string', description: 'Omit to list runs.' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: GHIDRA_SESSION_STOP_TOOL,
        description:
          'Close a Ghidra session started by this lab, freeing its JVM and port. Does not delete ' +
          'the Ghidra project, so a later session on the same binary reuses the analysis.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
          },
          required: ['sessionId'],
        },
      },
    },
  ];
}

// --- Execution ---------------------------------------------------------------

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function runFindBinaryTool(params: Record<string, unknown>): Promise<string> {
  const find = asString(params.find);
  const path = asString(params.path);
  try {
    const view = find
      ? await findGhidraBinaries({ find, ...(path ? { path } : {}) })
      : await browseGhidraPath(path || undefined);
    return jsonResult({
      path: view.path,
      truncated: view.truncated,
      entries: view.entries.slice(0, MAX_ROWS_IN_RESULT).map((entry) => ({
        name: entry.name,
        path: entry.path,
        kind: entry.kind,
        sizeBytes: entry.sizeBytes,
        analyzable: entry.analyzable,
      })),
    });
  } catch (error) {
    return errorResult(
      error,
      'Binaries can only be found inside folders the operator registered as Ghidra Lab roots.',
    );
  }
}

async function runSessionListTool(): Promise<string> {
  try {
    const [sessions, health] = await Promise.all([fetchGhidraSessions(), fetchGhidraLabHealth()]);
    const failing = health.checks.filter((check) => !check.ok && check.required);
    return jsonResult({
      sessions: sessions.map(describeSession),
      lab: {
        usable: health.availableModes.includes('headless'),
        availableModes: health.availableModes,
        ghidraVersion: health.ghidraVersion || 'unknown',
        jdkVersion: health.jdkVersion || 'unknown',
        capa: health.capaVersion || 'not configured',
        ...(failing.length
          ? {
              blockedBy: failing.map((check) => ({
                check: check.id,
                found: check.found,
                fix: check.remedy,
              })),
            }
          : {}),
      },
    });
  } catch (error) {
    return errorResult(error);
  }
}

async function runAnalyzeStartTool(params: Record<string, unknown>): Promise<string> {
  const binaryPath = asString(params.binaryPath);
  if (!binaryPath) {
    return errorResult(new Error('missing_binary_path'), 'Call ghidra_find_binary first.');
  }
  try {
    const preview = await previewGhidraSession(binaryPath);
    touchGhidraTools();
    if (!preview.allowed) {
      return jsonResult({
        started: false,
        blocked: preview.blockReasons,
        ...(preview.existingSessionId
          ? {
              hint: 'A session for this binary is already open; reuse it rather than starting another.',
              existingSessionId: preview.existingSessionId,
            }
          : {
              hint: 'Nothing was started. A preflight_* reason means the operator has to fix a path in Ghidra Lab setup.',
            }),
      });
    }
    return jsonResult({
      started: false,
      awaitingApproval: true,
      target: preview.targetSummary,
      note: 'An approval is now pending for the operator. Nothing runs until they click it. Poll ghidra_session_list.',
    });
  } catch (error) {
    return errorResult(error);
  }
}

async function runQueryTool(params: Record<string, unknown>): Promise<string> {
  const sessionId = asString(params.sessionId);
  const kind = asString(params.kind);
  if (!sessionId || !kind) {
    return errorResult(new Error('missing_session_or_kind'));
  }
  const args =
    params.args && typeof params.args === 'object' && !Array.isArray(params.args)
      ? (params.args as Record<string, unknown>)
      : {};
  try {
    const view = await runGhidraQuery({ sessionId, kind, args });
    touchGhidraTools();
    return jsonResult({
      kind: view.kind,
      engineTool: view.mcpTool,
      rowCount: view.rowCount,
      truncated: view.truncated,
      rows: view.rows.slice(0, MAX_ROWS_IN_RESULT),
    });
  } catch (error) {
    return errorResult(
      error,
      'A session must be in the "ready" state before it can answer. Check ghidra_session_list.',
    );
  }
}

async function runReportRunTool(params: Record<string, unknown>): Promise<string> {
  const sessionId = asString(params.sessionId);
  if (!sessionId) {
    return errorResult(new Error('missing_session_id'));
  }
  try {
    const preview = await previewGhidraReport(sessionId);
    touchGhidraTools();
    if (!preview.allowed) {
      return jsonResult({ started: false, blocked: preview.blockReasons });
    }
    return jsonResult({
      started: false,
      awaitingApproval: true,
      target: preview.targetSummary,
      note: 'A sweep approval is pending for the operator. It takes many minutes once started; poll ghidra_report_read.',
    });
  } catch (error) {
    return errorResult(error);
  }
}

async function runReportReadTool(params: Record<string, unknown>): Promise<string> {
  const runId = asString(params.runId);
  try {
    if (!runId) {
      const runs = await fetchGhidraRuns();
      return jsonResult({
        runs: runs.slice(0, 10).map((run) => ({
          runId: run.runId,
          binary: run.binaryName,
          state: run.state,
          anchors: run.anchorCount,
          droppedClaims: run.droppedClaims,
          stages: run.stages
            .filter((stage) => stage.state !== 'pending')
            .map((stage) => `${stage.stage}:${stage.state}`),
          ...(run.failureReason ? { failureReason: run.failureReason } : {}),
        })),
      });
    }
    const report = await fetchGhidraReport(runId);
    touchGhidraTools();
    if (!report) {
      return jsonResult({
        runId,
        ready: false,
        note: 'No report yet. The sweep may still be running.',
      });
    }
    return jsonResult(
      {
        runId,
        ready: true,
        report: report.slice(0, MAX_REPORT_CHARS),
        truncated: report.length > MAX_REPORT_CHARS,
      },
      // Room for the capped report plus its envelope.
      MAX_REPORT_CHARS + 2000,
    );
  } catch (error) {
    return errorResult(error);
  }
}

async function runSessionStopTool(params: Record<string, unknown>): Promise<string> {
  const sessionId = asString(params.sessionId);
  if (!sessionId) {
    return errorResult(new Error('missing_session_id'));
  }
  try {
    await stopGhidraSession(sessionId);
    return jsonResult({ stopped: true, sessionId });
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * One line shown in the chat while a tool runs.
 *
 * Worth being specific: a sweep can run for half an hour, and "working..." would
 * leave the operator unsure whether anything is happening at all.
 */
export function getGhidraToolPendingSummary(
  toolName: string,
  params: Record<string, unknown>,
): string {
  switch (toolName) {
    case GHIDRA_FIND_BINARY_TOOL:
      return asString(params.find)
        ? `Searching the binary roots for "${asString(params.find)}"`
        : 'Listing the registered binary roots';
    case GHIDRA_SESSION_LIST_TOOL:
      return 'Checking Ghidra Lab sessions and setup';
    case GHIDRA_ANALYZE_START_TOOL:
      return `Proposing Ghidra analysis of ${asString(params.binaryPath).split(/[\\/]/).pop() || 'a binary'}`;
    case GHIDRA_QUERY_TOOL:
      return `Asking Ghidra for ${asString(params.kind) || 'data'}`;
    case GHIDRA_REPORT_RUN_TOOL:
      return 'Proposing a full sweep and report';
    case GHIDRA_REPORT_READ_TOOL:
      return asString(params.runId) ? 'Reading the analysis report' : 'Listing sweep runs';
    case GHIDRA_SESSION_STOP_TOOL:
      return 'Closing a Ghidra session';
    default:
      return 'Ghidra Lab';
  }
}

export async function executeGhidraTool(
  toolName: string,
  params: Record<string, unknown>,
): Promise<string> {
  if (toolName === GHIDRA_FIND_BINARY_TOOL) {
    return runFindBinaryTool(params);
  }
  if (toolName === GHIDRA_SESSION_LIST_TOOL) {
    return runSessionListTool();
  }
  if (toolName === GHIDRA_ANALYZE_START_TOOL) {
    return runAnalyzeStartTool(params);
  }
  if (toolName === GHIDRA_QUERY_TOOL) {
    return runQueryTool(params);
  }
  if (toolName === GHIDRA_REPORT_RUN_TOOL) {
    return runReportRunTool(params);
  }
  if (toolName === GHIDRA_REPORT_READ_TOOL) {
    return runReportReadTool(params);
  }
  if (toolName === GHIDRA_SESSION_STOP_TOOL) {
    return runSessionStopTool(params);
  }
  return JSON.stringify({ error: `unknown_ghidra_tool: ${toolName}` });
}

/** Cancel a run. Not exposed as a tool -- the operator cancels from the app. */
export async function cancelGhidraSweep(runId: string): Promise<void> {
  await cancelGhidraRun(runId);
}
