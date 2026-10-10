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

import {
  decideAoiBrowserDriveNextStep,
  describeAoiBrowserDriveVerdict,
} from './aoiBrowserDriveVerdict';
import type { ToolDef } from './llmClient';
import {
  fetchAoiHostBrowserDriveActPreview,
  runAoiHostBrowserDriveActExecute,
  runAoiHostBrowserDriveTask,
  type AoiHostBrowserDriveActExecuteView,
  type AoiHostBrowserDriveActPreviewView,
  type AoiHostBrowserDriveAfterActView,
  type AoiHostBrowserDriveTaskResultView,
} from './aoiHostBridgeClient';
import { UNTRUSTED_PAGE_TEXT_NOTE } from './aoiUntrustedText';

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
                'READ: navigate | scroll | back | wait | extract | elements | tabs | tab. ' +
                'ACT: click | type | select | press | submit | hover | drag | dialog | upload | ' +
                'download. ' +
                '`elements` lists the interactable elements with refs so an act can target ' +
                '`element` instead of a hand-written selector. ' +
                '`tabs` lists open tabs and `tab` switches to one -- needed whenever a link, ' +
                'an OAuth flow or a payment step opens a new tab, because everything else acts ' +
                'on the CURRENT tab only. ' +
                '`dialog` answers a native alert/confirm/prompt; a page that raises one is ' +
                'blocked until it is answered, and accepting a confirm is how a page asks ' +
                '"really delete this?". ' +
                '`hover` opens menus that only appear on hover. `drag` needs toSelector or ' +
                'to_element. `upload` attaches a local file and works only for files inside the ' +
                'roots the operator registered. ' +
                '`download` clicks something that saves a file and puts it in a directory the ' +
                'operator registered as writable; give that directory in file_path.',
            },
            selector: {
              type: 'string',
              description:
                'CSS selector for the target element (act steps). Prefer `element` + ' +
                '`snapshot_id` from an `elements` step instead of authoring one of these.',
            },
            element: {
              type: 'number',
              description:
                'Element ref from an `elements` step, e.g. 7. More reliable than authoring a ' +
                'selector. Requires snapshot_id from the SAME elements result.',
            },
            snapshot_id: {
              type: 'string',
              description:
                'The id of the elements snapshot the ref came from. Refs are valid only for ' +
                'that snapshot: any act invalidates them, so take a fresh `elements` step after ' +
                'acting. A ref from an older snapshot is refused, never re-pointed.',
            },
            url: {
              type: 'string',
              description:
                'Absolute http(s) URL to navigate (blocked only if host is on the browser-drive denylist).',
            },
            text: { type: 'string', description: 'Text to fill (type).' },
            value: {
              type: 'string',
              description: 'Option value (select) / wait ms / scroll direction.',
            },
            key: { type: 'string', description: 'Key to press (press).' },
            to_selector: {
              type: 'string',
              description: 'Drop target for `drag` (CSS selector).',
            },
            to_element: {
              type: 'number',
              description: 'Drop target for `drag`, as a ref from the same elements snapshot.',
            },
            tab_index: {
              type: 'number',
              description: 'Which tab to switch to (`tab`), from a `tabs` listing.',
            },
            disposition: {
              type: 'string',
              enum: ['accept', 'dismiss'],
              description:
                'How to answer a `dialog`. Dismiss backs out; accept confirms whatever the page ' +
                'asked, so read the dialog message first rather than accepting by reflex.',
            },
            prompt_text: {
              type: 'string',
              description: 'Text to enter when accepting a prompt() dialog.',
            },
            file_path: {
              type: 'string',
              description:
                'For `upload`, the absolute path of the file to attach -- refused unless it sits ' +
                'inside a read root the operator registered. For `download`, the absolute path of ' +
                'an existing directory to save into, bounded by the write roots instead. Never ' +
                'guess a path, and never move a file the user did not ask you to.',
            },
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
          'asked Aoi to act on. Domains default to allowed (denylist blocks only); passwords/payments/CAPTCHAs are never entered.',
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
          'Fails if the user has not approved this exact action. ' +
          'READ THE RESULT BEFORE REPORTING: `ok` only means the call ran, it is NOT proof the action ' +
          'landed. Follow `status`/`effect`: "done" (confirmed -- say it happened, never repeat it); ' +
          '"delivered_unverified" (unverifiable -- read `observed_after` before saying anything, and ' +
          'do NOT repeat the action or claim a success it does not show); "not_performed" (suspected no-op or ' +
          'refusal -- say plainly it did not happen, and follow `escalation.recommended`: ' +
          'alternate_selector = try a different selector from a fresh snapshot, stop = do not retry). ' +
          'If `audit_recorded` is false the action HAPPENED but could not be written to the audit ' +
          'ledger, so the record of what was done is missing it -- say so to the user. ' +
          '`observed_after` is the page looked at again just after the act: the URL, the visible ' +
          'text that appeared, went away or was rearranged, tabs it opened, and a dialog it raised. ' +
          'It is the only look at the page AS THE ACT LEFT IT: the tab closes when this call ends, ' +
          'so a later read opens the page afresh and shows what the site kept, not a toast, a ' +
          'dialog or anything else the act left only on screen.',
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

// One sentence the model can act on. A task that stopped on an unproven act is
// NOT a failure of the browser and must not be re-run blindly; a task that
// finished with an unverifiable act is not proof that act landed.
function buildTaskNote(ok: boolean, stopReason: string, unverifiedCount: number): string {
  if (!ok) {
    if (stopReason === 'act_not_performed') {
      return (
        'The task STOPPED because an act produced evidence it did nothing, and later acts would ' +
        'have been built on a state that was never reached. Nothing ran past it. Tell the user ' +
        'which step stopped and why; do not re-run the task unchanged.'
      );
    }
    if (stopReason === 'act_unverified') {
      return (
        'The task STOPPED because an act could not be proven to have landed and the next act ' +
        'depended on it. Nothing ran past it. Re-read the page to see the real state before ' +
        'proposing anything, and do NOT claim the remaining steps happened.'
      );
    }
    return 'The task stopped early; see stop_reason. Nothing ran past the stopping step.';
  }
  if (unverifiedCount > 0) {
    return (
      `Every act was delivered and gated, but ${unverifiedCount} of them could not be proven to ` +
      'have landed. Re-read the page before telling the user the task succeeded.'
    );
  }
  return 'The bounded task completed and every act was proven to have taken effect.';
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
  // Before the denylist arm below: this one HAPPENED, and must not be retried.
  if (lowered.includes('drift_after_act')) {
    return (
      `error: the action was carried out (or may have been), and then the page moved to a site ` +
      `on the browser-drive denylist, so Aoi closed it: ${message}. Do NOT repeat the action: ` +
      'tell the user what was done and that the page it led to is blocked.'
    );
  }
  if (lowered.includes('host_private')) {
    return (
      `error: private/loopback hosts are never driven by browser-drive: ${message}. ` +
      'Use a public https host.'
    );
  }
  if (
    lowered.includes('host_denylisted') ||
    lowered.includes('not_allowlisted') ||
    lowered.includes('drift_to_denylist') ||
    lowered.includes('drift_off_allowlist') ||
    lowered.includes('url_denylisted')
  ) {
    return (
      `error: blocked by the browser-drive denylist: ${message}. ` +
      'Remove the domain in Settings -> Advanced -> Host PC -> Browser drive denylist, then retry.'
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
      "If a window is already open on Aoi's browser profile without the debug port, close it, then retry."
    );
  }
  return `error: browser drive act failed: ${message}`;
}

/**
 * The page as it was just after the act, for the model.
 *
 * `summary` says in plain words what the look found; the lines themselves are
 * the page's own words and are kept apart from it, so nothing the page wrote is
 * ever phrased as something Aoi concluded.
 */
export function describeBrowserDriveObservedAfter(
  view: AoiHostBrowserDriveAfterActView,
): Record<string, unknown> {
  const parts: string[] = [];
  if (view.actInterrupted) {
    parts.push(
      'A dialog came up before the act finished, so it is not known whether the act itself ' +
        'went through: it may be what raised the dialog, or the page raised the dialog first ' +
        'and the act never landed. Do not report it as done.',
    );
  }
  if (view.dialog) {
    const kind = view.dialog.type === 'dialog' ? 'a dialog' : `a ${view.dialog.type} dialog`;
    parts.push(
      view.dialog.type === 'alert'
        ? 'The page showed an alert (dialog.message); it is closed when this call ends.'
        : `The page raised ${kind} (dialog.message) and nothing answered it. ` +
            'It is dismissed when this call ends, so what it asked about did NOT go ahead. Tell ' +
            'the user rather than repeating the act.',
    );
  }
  if (view.urlChanged) {
    parts.push('The page moved to a different address (url).');
  }
  if (view.tabsOpened?.length) {
    parts.push(
      `${view.tabsOpened.length === 1 ? 'A new tab' : `${view.tabsOpened.length} new tabs`} ` +
        'opened (tabs_opened).',
    );
  }
  if (!view.textRead) {
    if (!view.dialog) {
      parts.push(
        'The page text could not be read again, so nothing here shows what changed on it.',
      );
    }
  } else if (view.textAppeared.length === 0 && view.textGone.length === 0) {
    parts.push(
      view.textReordered
        ? 'The same lines of visible text are still there, but in a different order ' +
            '(text_reordered): a list may have been sorted or an item moved. Nothing appeared ' +
            'or went away.'
        : `The visible text did not change within ${view.waitedMs} ms of the act. That is not ` +
            'proof nothing happened: a change may not show as text.',
    );
  } else {
    parts.push(
      'The visible text changed: text_appeared is new since the act, text_gone is no longer shown.',
    );
  }
  if (view.textRead && view.textTruncated) {
    parts.push(
      'The page has more text than is compared (text_truncated), so a change further down ' +
        'the page would not show here.',
    );
  }
  return {
    waited_ms: view.waitedMs,
    url: view.url,
    url_changed: view.urlChanged,
    ...(view.textRead
      ? {
          text_appeared: view.textAppeared,
          text_gone: view.textGone,
          ...(view.textAppearedOmitted ? { text_appeared_omitted: view.textAppearedOmitted } : {}),
          ...(view.textGoneOmitted ? { text_gone_omitted: view.textGoneOmitted } : {}),
          ...(view.textReordered ? { text_reordered: true } : {}),
          ...(view.textTruncated ? { text_truncated: true } : {}),
        }
      : { text_unreadable: true }),
    ...(view.tabsOpened?.length ? { tabs_opened: view.tabsOpened } : {}),
    ...(view.dialog ? { dialog: view.dialog } : {}),
    ...(view.actInterrupted ? { act_interrupted: true } : {}),
    summary: parts.join(' '),
  };
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
      // What the replayed read prefix saw. This is where element refs come
      // from: propose replays the reads WITHOUT acting, so a ref can be
      // obtained before any approval is spent.
      ...(preview.reads?.length ? { reads: preview.reads } : {}),
      expires_at: preview.expiresAt,
      note:
        "This is a LIVE, irreversible action on the user's logged-in browser. It was NOT performed. " +
        'Ask the user to approve it in Settings -> Advanced -> Host PC -> Approvals (a before-screenshot ' +
        'was captured). Once approved, call browser_drive_run with the identical plan.' +
        (preview.reads?.length ? ` ${UNTRUSTED_PAGE_TEXT_NOTE}` : ''),
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
    // `ok` is transport success -- the call ran and no gate stopped it. It is NOT
    // evidence the action landed, and reporting it as "performed" is how a
    // delivered-but-unproven act became a completion claim. The verdict carries
    // what can actually be proven; `status` follows the verdict, not the
    // transport. (Contract ported from hermes-agent computer-use.)
    const verdict = result.verdict;
    const next = verdict ? decideAoiBrowserDriveNextStep(verdict) : null;
    const status = !result.ok
      ? 'failed'
      : next?.decision === 'done'
        ? 'done'
        : next?.decision === 'escalate'
          ? 'not_performed'
          : 'delivered_unverified';
    return JSON.stringify({
      status,
      ok: result.ok,
      step_index: result.stepIndex,
      ...(verdict
        ? {
            effect: verdict.effect,
            verified: verdict.verified,
            ...(verdict.code ? { code: verdict.code } : {}),
            ...(verdict.escalation ? { escalation: verdict.escalation } : {}),
            ...(next?.decision ? { next: next.decision } : {}),
          }
        : {}),
      ...(result.stopReason ? { stop_reason: result.stopReason } : {}),
      ...(result.finalUrl ? { final_url: result.finalUrl } : {}),
      // What the read steps saw. An `elements` step is how a ref is obtained at
      // all -- without this the model cannot use `element` + `snapshot_id` and
      // has to fall back to authoring selectors, which is the weaker path.
      ...(result.reads?.length ? { reads: result.reads } : {}),
      // The only look at what the act did: this call's tab closes with it.
      ...(result.observedAfter
        ? { observed_after: describeBrowserDriveObservedAfter(result.observedAfter) }
        : {}),
      // The act happened but the audit ledger could not be written. Said out
      // loud, because the ledger is what the operator would consult afterwards
      // to see what was done, and it will not mention this.
      ...(result.auditRecorded === false ? { audit_recorded: false } : {}),
      note: [
        verdict
          ? describeAoiBrowserDriveVerdict(verdict)
          : result.ok
            ? 'The action was delivered to the live browser. Nothing here proves it landed -- re-read the page before telling the user it worked.'
            : 'The action did not run; see stop_reason.',
        result.observedAfter
          ? 'observed_after is the page looked at again just after the act: say only what it shows.'
          : '',
        result.auditRecorded === false
          ? 'The audit ledger could not be written, so this step is missing from the record of what Aoi did. Tell the user.'
          : '',
        result.reads?.length || result.observedAfter ? UNTRUSTED_PAGE_TEXT_NOTE : '',
      ]
        .filter(Boolean)
        .join(' '),
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
    // A task runs unattended, so it advances only on evidence: the runner stops
    // on an act that did nothing (act_not_performed) and on an unproven act
    // that a later act would have depended on (act_unverified). Even a
    // completed task can end on an unverifiable LAST act -- nothing was stacked
    // on it, but it must not be reported as proven either.
    const unverifiedSteps = result.steps.filter((step) => step.effect === 'unverifiable');
    return JSON.stringify({
      status: result.ok ? (unverifiedSteps.length > 0 ? 'done_unverified' : 'done') : 'stopped',
      ok: result.ok,
      stop_reason: result.stopReason,
      acts_run: result.actsRun,
      steps_run: result.stepsRun,
      steps: result.steps.map((step) => ({
        index: step.index,
        ok: step.ok,
        ...(step.effect ? { effect: step.effect } : {}),
        ...(step.verified ? { verified: true } : {}),
        ...(step.reason ? { reason: step.reason } : {}),
      })),
      ...(result.detail ? { detail: result.detail } : {}),
      note: buildTaskNote(result.ok, result.stopReason, unverifiedSteps.length),
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
