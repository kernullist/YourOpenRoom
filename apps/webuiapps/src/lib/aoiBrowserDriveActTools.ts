// Chat-facing browser-drive ACT tools (BD P2.3d): the two-phase, human-gated path
// for Aoi to actually ACT on the operator's OWN logged-in browser (click/type/
// select/press/submit), as opposed to browser_read_auth which only reads.
//
// The flow is deliberately two calls with a HUMAN approval in between:
//   1. browser_drive_act (PROPOSE): the model proposes a short plan (read steps +
//      exactly ONE act at target_step_index). This replays the read prefix in a
//      fresh session, screenshots the page the act would touch, and records a
//      PENDING per-action approval. It returns an approval_required result -- it
//      NEVER acts. The pending approval appears in the Host Bridge Approvals inbox
//      (Settings -> Advanced -> Host PC -> Approvals) for the operator to approve.
//   2. browser_drive_run (EXECUTE): after the operator approves, the model runs the
//      SAME plan; the server consumes the single-use approval and performs the one
//      act. Without an approved entry it is fail-closed (approval_missing).
//
// The model MUST pass an IDENTICAL plan to run as it did to propose -- the approval
// is keyed on a content-addressed fingerprint of (goal, step index, action), so any
// change re-fingerprints and the run is refused until re-approved. Triple-gated
// server-side (os_browser_drive kill-switch + browser-drive consent + domain
// allowlist); passwords/payments/CAPTCHAs are permanently hard-blocked and can
// never run even if approved.

import type { ToolDef } from './llmClient';
import {
  fetchAoiHostBrowserDriveActPreview,
  runAoiHostBrowserDriveActExecute,
  runAoiHostBrowserDriveTask,
  type AoiHostBrowserDriveActExecuteView,
  type AoiHostBrowserDriveActPreviewView,
  type AoiHostBrowserDriveTaskResultView,
} from './aoiHostBridgeClient';

export const BROWSER_DRIVE_PROPOSE_TOOL = 'browser_drive_act';
export const BROWSER_DRIVE_RUN_TOOL = 'browser_drive_run';
export const BROWSER_DRIVE_TASK_TOOL = 'browser_drive_task';

export interface BrowserDriveActToolContext {
  sessionPath: string;
  previewFetcher?: (
    sessionPath: string,
    plan: unknown,
    targetStepIndex: number,
  ) => Promise<AoiHostBrowserDriveActPreviewView>;
  executeFetcher?: (
    sessionPath: string,
    plan: unknown,
    targetStepIndex: number,
  ) => Promise<AoiHostBrowserDriveActExecuteView>;
  taskFetcher?: (
    sessionPath: string,
    task: unknown,
    budget?: { maxActs?: number; maxSteps?: number },
  ) => Promise<AoiHostBrowserDriveTaskResultView>;
}

const PLAN_PARAM_SCHEMA = {
  goal: {
    type: 'string',
    description: 'One-line description of what the whole plan accomplishes.',
  },
  steps: {
    type: 'array',
    description:
      'Ordered steps. Every step BEFORE target_step_index must be read-only ' +
      '(navigate/scroll/back/wait/extract); target_step_index itself is the single ' +
      'act (click/type/select/press/submit). At most one act per plan.',
    items: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Human-readable step description.' },
        action: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              description:
                'navigate | scroll | back | wait | extract | click | type | select | press | submit',
            },
            selector: {
              type: 'string',
              description: 'CSS selector for the target element (act steps).',
            },
            url: { type: 'string', description: 'Absolute allowlisted http(s) URL (navigate).' },
            text: { type: 'string', description: 'Text to fill (type).' },
            value: {
              type: 'string',
              description: 'Option value (select) / wait ms / scroll direction.',
            },
            key: { type: 'string', description: 'Key to press (press).' },
          },
          required: ['kind'],
        },
      },
      required: ['action'],
    },
  },
  target_step_index: {
    type: 'number',
    description: 'Index of the single act step to propose/run.',
  },
};

export function getBrowserDriveActToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: BROWSER_DRIVE_PROPOSE_TOOL,
        description:
          "Propose ONE action on the user's OWN logged-in browser (click/type/select/press/submit). " +
          'Give a short plan of read steps (navigate/scroll) plus exactly one act at target_step_index. ' +
          'This does NOT act -- it captures a before-screenshot and records a per-action approval the ' +
          'user must approve in Settings -> Advanced -> Host PC -> Approvals. After they approve, call ' +
          'browser_drive_run with the identical plan to perform it. Use for authenticated sites the user ' +
          'asked Aoi to act on. Only allowlisted domains; passwords/payments/CAPTCHAs are never entered.',
        parameters: {
          type: 'object',
          properties: PLAN_PARAM_SCHEMA,
          required: ['goal', 'steps', 'target_step_index'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: BROWSER_DRIVE_RUN_TOOL,
        description:
          'Perform the ONE action previously proposed with browser_drive_act, AFTER the user approved it ' +
          'in the Approvals inbox. Pass the IDENTICAL plan (goal + steps + target_step_index) you proposed. ' +
          'Fails if the user has not approved this exact action.',
        parameters: {
          type: 'object',
          properties: PLAN_PARAM_SCHEMA,
          required: ['goal', 'steps', 'target_step_index'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: BROWSER_DRIVE_TASK_TOOL,
        description:
          "Run a bounded, operator-authored MULTI-ACT task on the user's logged-in browser: an ordered " +
          'list of single-act steps, each executed in turn and fail-stopped on the first failure. Use ONLY ' +
          'when the user asked for a repeated/multi-step browser action. Requires the "Browser drive: ' +
          'standing approval" AND "Browser drive: bounded tasks" toggles ON and a standing grant for each ' +
          "domain (otherwise each act blocks). Bounded to <=10 acts / <=40 steps. Don't invent tasks -- only " +
          'run what the user explicitly asked for.',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'One-line description of the whole task.' },
            steps: {
              type: 'array',
              description: 'Ordered single-act steps; each is a plan + the index of its one act.',
              items: {
                type: 'object',
                properties: {
                  plan: {
                    type: 'object',
                    description: 'A single-act plan (read prefix + one act).',
                    properties: PLAN_PARAM_SCHEMA,
                    required: ['goal', 'steps'],
                  },
                  target_step_index: {
                    type: 'number',
                    description: 'Index of the single act step within this plan.',
                  },
                },
                required: ['plan', 'target_step_index'],
              },
            },
            max_acts: { type: 'number', description: 'Optional cap on acts (<=10).' },
            max_steps: { type: 'number', description: 'Optional cap on total steps (<=40).' },
          },
          required: ['goal', 'steps'],
        },
      },
    },
  ];
}

export function isBrowserDriveActTool(toolName: string): boolean {
  return (
    toolName === BROWSER_DRIVE_PROPOSE_TOOL ||
    toolName === BROWSER_DRIVE_RUN_TOOL ||
    toolName === BROWSER_DRIVE_TASK_TOOL
  );
}

export function getBrowserDriveActToolPendingSummary(
  toolName: string,
  params: Record<string, unknown>,
): string {
  if (toolName === BROWSER_DRIVE_TASK_TOOL) {
    const count = Array.isArray(params.steps) ? params.steps.length : 0;
    return `${toolName}(${count} steps)`;
  }
  const index = typeof params.target_step_index === 'number' ? params.target_step_index : '?';
  return `${toolName}(step ${index})`;
}

// Coerce loose tool params into { plan, targetStepIndex }. Returns null when the
// shape is unusable; the server classifiers normalize the plan further.
export function parseBrowserDriveActParams(
  params: Record<string, unknown>,
): { plan: { goal: string; steps: unknown[] }; targetStepIndex: number } | null {
  const goal = typeof params.goal === 'string' ? params.goal : '';
  const steps = Array.isArray(params.steps) ? params.steps : null;
  if (!steps || steps.length === 0) {
    return null;
  }
  const rawIndex = params.target_step_index;
  const targetStepIndex =
    typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : NaN;
  if (Number.isNaN(targetStepIndex) || targetStepIndex >= steps.length) {
    return null;
  }
  return { plan: { goal, steps }, targetStepIndex };
}

function formatActGateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (lowered.includes('approval_missing') || lowered.includes('approval_not_granted')) {
    return (
      `error: this action is not approved yet: ${message}. ` +
      'Ask the user to approve it in Settings -> Advanced -> Host PC -> Approvals, then call ' +
      'browser_drive_run again with the identical plan.'
    );
  }
  if (
    lowered.includes('forbidden_step') ||
    lowered.includes('sensitive_field') ||
    lowered.includes('financial_commit') ||
    lowered.includes('captcha')
  ) {
    return (
      `error: that action is permanently blocked (passwords/payments/transfers/CAPTCHA are never ` +
      `performed by Aoi): ${message}. The user must do it themselves.`
    );
  }
  if (lowered.includes('task_capability_disabled')) {
    return (
      `error: bounded tasks are off: ${message}. ` +
      'Ask the user to enable "Browser drive: bounded tasks" in Settings -> Advanced -> Host PC, then retry.'
    );
  }
  if (lowered.includes('not_operator_authored')) {
    return `error: the task was refused as not operator-authored: ${message}. Only run tasks the user explicitly asked for.`;
  }
  if (lowered.includes('prefix_contains_act')) {
    return (
      `error: a plan may contain at most one act (the target): ${message}. ` +
      'Propose one act at a time; after it is approved and run, propose the next.'
    );
  }
  if (lowered.includes('not_an_act')) {
    return `error: target_step_index must point at an act step (click/type/select/press/submit): ${message}.`;
  }
  if (lowered.includes('plan_inadmissible') || lowered.includes('too_many_steps')) {
    return `error: the plan was rejected: ${message}. Keep it short and free of any forbidden step.`;
  }
  if (lowered.includes('not_allowlisted') || lowered.includes('drift_off_allowlist')) {
    return (
      `error: blocked by the domain allowlist: ${message}. ` +
      'Add the domain in Settings -> Advanced -> Host PC -> Browser drive allowlist, then retry.'
    );
  }
  if (
    lowered.includes('consent') ||
    lowered.includes('capability_disabled') ||
    lowered.includes('panic') ||
    lowered.includes('blocked')
  ) {
    return (
      `error: browser drive blocked: ${message}. ` +
      'Enable Browser drive in Settings -> Advanced -> Host PC, then retry.'
    );
  }
  if (
    lowered.includes('attach_timeout') ||
    lowered.includes('session_start_failed') ||
    lowered.includes('navigation_failed')
  ) {
    return (
      `error: could not drive the browser: ${message}. ` +
      'Make sure the Aoi debug browser is running (close a conflicting main Chrome/Edge first), then retry.'
    );
  }
  return `error: browser drive act failed: ${message}`;
}

export async function executeBrowserDriveProposeTool(
  params: Record<string, unknown>,
  context: BrowserDriveActToolContext,
): Promise<string> {
  const sessionPath = typeof context.sessionPath === 'string' ? context.sessionPath.trim() : '';
  if (!sessionPath) {
    return 'error: browser drive needs an active Aoi session (sessionPath missing).';
  }
  const parsed = parseBrowserDriveActParams(params);
  if (!parsed) {
    return 'error: browser_drive_act needs goal, steps, and a valid target_step_index.';
  }
  const previewFetcher = context.previewFetcher ?? fetchAoiHostBrowserDriveActPreview;
  try {
    const preview = await previewFetcher(sessionPath, parsed.plan, parsed.targetStepIndex);
    return JSON.stringify({
      status: 'approval_required',
      approval_fingerprint: preview.approvalFingerprint,
      action: preview.targetSummary,
      hostname: preview.hostname,
      step_index: preview.stepIndex,
      before_screenshot_captured: Boolean(preview.beforeScreenshotBase64),
      expires_at: preview.expiresAt,
      note:
        "This is a LIVE, irreversible action on the user's logged-in browser. It was NOT performed. " +
        'Ask the user to approve it in Settings -> Advanced -> Host PC -> Approvals (a before-screenshot ' +
        'was captured). Once approved, call browser_drive_run with the identical plan.',
    });
  } catch (error) {
    return formatActGateError(error);
  }
}

export async function executeBrowserDriveRunTool(
  params: Record<string, unknown>,
  context: BrowserDriveActToolContext,
): Promise<string> {
  const sessionPath = typeof context.sessionPath === 'string' ? context.sessionPath.trim() : '';
  if (!sessionPath) {
    return 'error: browser drive needs an active Aoi session (sessionPath missing).';
  }
  const parsed = parseBrowserDriveActParams(params);
  if (!parsed) {
    return 'error: browser_drive_run needs goal, steps, and a valid target_step_index.';
  }
  const executeFetcher = context.executeFetcher ?? runAoiHostBrowserDriveActExecute;
  try {
    const result = await executeFetcher(sessionPath, parsed.plan, parsed.targetStepIndex);
    return JSON.stringify({
      status: result.ok ? 'done' : 'failed',
      ok: result.ok,
      step_index: result.stepIndex,
      ...(result.stopReason ? { stop_reason: result.stopReason } : {}),
      ...(result.finalUrl ? { final_url: result.finalUrl } : {}),
      note: result.ok
        ? 'The approved action was performed on the live browser (single-use approval consumed).'
        : 'The action did not run; see stop_reason.',
    });
  } catch (error) {
    return formatActGateError(error);
  }
}

// Parse the task tool params into { owner:'user', goal, steps } + budget. Returns
// null when unusable; the server orchestrator + step runner re-validate everything.
export function parseBrowserDriveTaskParams(params: Record<string, unknown>): {
  task: { owner: 'user'; goal: string; steps: Array<{ plan: unknown; targetStepIndex: number }> };
  budget: { maxActs?: number; maxSteps?: number };
} | null {
  const goal = typeof params.goal === 'string' ? params.goal : '';
  const rawSteps = Array.isArray(params.steps) ? params.steps : null;
  if (!rawSteps || rawSteps.length === 0) {
    return null;
  }
  const steps: Array<{ plan: unknown; targetStepIndex: number }> = [];
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const step = raw as { plan?: unknown; target_step_index?: unknown };
    const plan = step.plan;
    const target = step.target_step_index;
    if (
      !plan ||
      typeof plan !== 'object' ||
      !Array.isArray((plan as { steps?: unknown }).steps) ||
      typeof target !== 'number' ||
      !Number.isInteger(target) ||
      target < 0
    ) {
      return null;
    }
    steps.push({ plan, targetStepIndex: target });
  }
  const budget: { maxActs?: number; maxSteps?: number } = {};
  if (typeof params.max_acts === 'number') {
    budget.maxActs = params.max_acts;
  }
  if (typeof params.max_steps === 'number') {
    budget.maxSteps = params.max_steps;
  }
  // owner is fixed to 'user': this tool runs a user-requested task. The real
  // provenance gate is the human-only os_browser_drive_task toggle on the daemon.
  return { task: { owner: 'user', goal, steps }, budget };
}

export async function executeBrowserDriveTaskTool(
  params: Record<string, unknown>,
  context: BrowserDriveActToolContext,
): Promise<string> {
  const sessionPath = typeof context.sessionPath === 'string' ? context.sessionPath.trim() : '';
  if (!sessionPath) {
    return 'error: browser drive needs an active Aoi session (sessionPath missing).';
  }
  const parsed = parseBrowserDriveTaskParams(params);
  if (!parsed) {
    return 'error: browser_drive_task needs goal and steps (each with a plan + target_step_index).';
  }
  const taskFetcher = context.taskFetcher ?? runAoiHostBrowserDriveTask;
  try {
    const result = await taskFetcher(sessionPath, parsed.task, parsed.budget);
    return JSON.stringify({
      status: result.ok ? 'done' : 'stopped',
      ok: result.ok,
      stop_reason: result.stopReason,
      acts_run: result.actsRun,
      steps_run: result.stepsRun,
      ...(result.detail ? { detail: result.detail } : {}),
      note: result.ok
        ? 'The bounded task completed; every act was gated (standing grant / approval) and audited.'
        : 'The task stopped early; see stop_reason. Nothing ran past the stopping step.',
    });
  } catch (error) {
    return formatActGateError(error);
  }
}

export async function executeBrowserDriveActTool(
  toolName: string,
  params: Record<string, unknown>,
  context: BrowserDriveActToolContext,
): Promise<string> {
  if (toolName === BROWSER_DRIVE_TASK_TOOL) {
    return executeBrowserDriveTaskTool(params, context);
  }
  if (toolName === BROWSER_DRIVE_RUN_TOOL) {
    return executeBrowserDriveRunTool(params, context);
  }
  return executeBrowserDriveProposeTool(params, context);
}
