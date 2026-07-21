// Aoi browser-drive ACT runner (P2.3b): the stateless single-ACT-per-call model.
//
// Chosen session-lifecycle model (see JARVIS/05-browser-drive-roadmap.md): the
// daemon holds NO live session between calls. To act on a step, we open a FRESH CDP
// session, deterministically REPLAY the plan's read prefix (navigate/scroll/back/
// wait/extract) to bring the page to the state the target step acts on, run the ONE
// target step, and close. No pooled/stateful session, so no cross-call teardown or
// idle-timeout bugs; the cost is a re-navigation per call and the constraint that a
// plan may contain AT MOST ONE act (the target) -- any earlier act makes the prefix
// non-replayable (replaying it would re-fire an irreversible effect), so it is
// refused and the caller must re-plan after each act.
//
// Two entry points share the prefix replay:
//   - previewAoiBrowserDriveActStep: replay the read prefix, screenshot the page the
//     act would touch (the approval card's before-image), return WITHOUT acting.
//   - executeAoiBrowserDriveActStep: replay the read prefix, then run the target step
//     through the executor with the injected (store-backed) approval gate.
//
// Pure orchestration over an INJECTED session factory + approval gate, so it is
// unit-tested with a fake session/page -- no real browser. Inert until P2.3c wires
// the routes.

import {
  classifyAoiBrowserDriveAction,
  type AoiBrowserDriveActionRequest,
} from './aoiBrowserDriveAction';
import {
  executeAoiBrowserDriveStep,
  type AoiBrowserDriveActablePage,
  type AoiBrowserDriveApprovalGate,
  type AoiBrowserDriveObserver,
  type AoiBrowserDriveStepResult,
} from './aoiBrowserDriveExecutor';
import {
  isAoiBrowserDriveUrlAllowed,
  type AoiBrowserDriveAllowlist,
} from './aoiBrowserDriveAllowlist';
import { classifyAoiBrowserDrivePlan, type AoiBrowserDrivePlan } from './aoiBrowserDrivePlan';
import {
  makeAoiBrowserDriveAuditObserver,
  type AoiBrowserDriveArtifactWriter,
} from './aoiBrowserDriveAuditObserver';
import type { AoiBrowserDriveAuditEntry } from './aoiBrowserDriveAuditStore';

export type AoiBrowserDriveAuditEntryInput = Omit<
  AoiBrowserDriveAuditEntry,
  'version' | 'id' | 'recordedAt'
>;

// Audit sink for the execute path: capture writes before/after artifacts via
// writeArtifact (refs land on each step result), and the runner records one ledger
// entry per step via recordEntry. Optional -- omitted in tests / read-only preview.
export interface AoiBrowserDriveRunAudit {
  runId: string;
  writeArtifact: AoiBrowserDriveArtifactWriter;
  recordEntry: (entry: AoiBrowserDriveAuditEntryInput) => void;
}

// A denying gate: read steps ignore the gate, so the prefix replay uses this to be
// certain no act can slip through the prefix (they are refused before we get here).
const PREFIX_DENY_GATE: AoiBrowserDriveApprovalGate = async () => ({
  approved: false,
  reason: 'prefix steps must be read-only',
});

export interface AoiBrowserDriveRunnerSession {
  page: AoiBrowserDriveActablePage;
  close(): Promise<void>;
}

export type AoiBrowserDriveSessionFactory = () => Promise<AoiBrowserDriveRunnerSession>;

export type AoiBrowserDriveRunDenyReason =
  | 'plan_inadmissible'
  | 'step_out_of_range'
  | 'prefix_contains_act'
  | 'prefix_failed'
  | 'session_start_failed'
  | 'panicked';

export interface AoiBrowserDriveActPreviewResult {
  ok: true;
  stepIndex: number;
  action: AoiBrowserDriveActionRequest;
  hostname: string;
  finalUrl: string;
  beforeScreenshotBase64?: string;
  prefix: AoiBrowserDriveStepResult[];
}

export interface AoiBrowserDriveActExecuteResult {
  ok: boolean;
  stepIndex: number;
  action: AoiBrowserDriveActionRequest;
  prefix: AoiBrowserDriveStepResult[];
  target: AoiBrowserDriveStepResult;
}

export interface AoiBrowserDriveRunFailure {
  ok: false;
  reason: AoiBrowserDriveRunDenyReason;
  detail?: string;
  prefix?: AoiBrowserDriveStepResult[];
}

export interface AoiBrowserDriveActRunParams {
  plan: AoiBrowserDrivePlan;
  targetStepIndex: number;
  allowlist: AoiBrowserDriveAllowlist | null | undefined;
  sessionFactory: AoiBrowserDriveSessionFactory;
  now: number;
  timeoutMs?: number;
  observer?: AoiBrowserDriveObserver;
  maxPlanSteps?: number;
  sleep?: (ms: number) => Promise<void>;
  // When present (execute path), each step is captured + recorded to the audit
  // ledger. Omitted for preview / tests.
  audit?: AoiBrowserDriveRunAudit;
  // Cooperative panic check. The route gate already blocks a call that STARTS while
  // panicked; this re-check catches a panic engaged DURING the (possibly slow) read-
  // prefix replay, so the irreversible act is aborted before it runs. Optional.
  isPanicked?: () => boolean;
}

// Shared guard: validate the plan + target index and ensure every prefix step is a
// read (the stateless model cannot replay a prior act). Pure, no browser.
function guardRun(
  params: Pick<AoiBrowserDriveActRunParams, 'plan' | 'targetStepIndex' | 'maxPlanSteps'>,
): AoiBrowserDriveRunFailure | null {
  const { plan, targetStepIndex } = params;
  const total = plan?.steps?.length ?? 0;
  if (targetStepIndex < 0 || targetStepIndex >= total) {
    return {
      ok: false,
      reason: 'step_out_of_range',
      detail: `no step at index ${targetStepIndex}`,
    };
  }
  const planClass = classifyAoiBrowserDrivePlan(plan, {
    ...(params.maxPlanSteps ? { maxSteps: params.maxPlanSteps } : {}),
  });
  if (!planClass.admissible) {
    return {
      ok: false,
      reason: 'plan_inadmissible',
      detail: planClass.rejectReasons.join(',') || 'inadmissible',
    };
  }
  for (let index = 0; index < targetStepIndex; index += 1) {
    const decision = classifyAoiBrowserDriveAction(plan.steps[index].action);
    if (decision.category !== 'read') {
      return {
        ok: false,
        reason: 'prefix_contains_act',
        detail: `step ${index} is ${decision.category}; the stateless model allows at most one act (the target)`,
      };
    }
  }
  return null;
}

async function openSession(
  sessionFactory: AoiBrowserDriveSessionFactory,
): Promise<AoiBrowserDriveRunnerSession | AoiBrowserDriveRunFailure> {
  try {
    return await sessionFactory();
  } catch (error) {
    return {
      ok: false,
      reason: 'session_start_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

// Replay steps [0, targetStepIndex) as reads on the open page. Stops at the first
// non-ok read (e.g. a navigate that drifts off-allowlist).
async function replayReadPrefix(
  page: AoiBrowserDriveActablePage,
  params: AoiBrowserDriveActRunParams,
): Promise<{
  ok: boolean;
  results: AoiBrowserDriveStepResult[];
  failure?: AoiBrowserDriveStepResult;
}> {
  const results: AoiBrowserDriveStepResult[] = [];
  for (let index = 0; index < params.targetStepIndex; index += 1) {
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: params.plan,
      stepIndex: index,
      allowlist: params.allowlist,
      approvalGate: PREFIX_DENY_GATE,
      now: params.now,
      ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      ...(params.observer ? { observer: params.observer } : {}),
      ...(params.maxPlanSteps ? { maxPlanSteps: params.maxPlanSteps } : {}),
      ...(params.sleep ? { sleep: params.sleep } : {}),
    });
    results.push(result);
    if (!result.ok) {
      return { ok: false, results, failure: result };
    }
  }
  return { ok: true, results };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function currentUrl(page: AoiBrowserDriveActablePage): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

/**
 * Preview: open a session, replay the read prefix, screenshot the page the target
 * act would touch, and return WITHOUT acting. The before-screenshot is advisory for
 * the approval card; the approval identity is the action fingerprint, so it holds
 * even if the page differs slightly on the execute call's fresh session.
 */
export async function previewAoiBrowserDriveActStep(
  params: AoiBrowserDriveActRunParams,
): Promise<AoiBrowserDriveActPreviewResult | AoiBrowserDriveRunFailure> {
  const guard = guardRun(params);
  if (guard) {
    return guard;
  }
  const opened = await openSession(params.sessionFactory);
  if ('ok' in opened && opened.ok === false) {
    return opened;
  }
  const session = opened as AoiBrowserDriveRunnerSession;
  try {
    const prefix = await replayReadPrefix(session.page, params);
    if (!prefix.ok) {
      return {
        ok: false,
        reason: 'prefix_failed',
        detail: prefix.failure?.stopReason ?? 'prefix step failed',
        prefix: prefix.results,
      };
    }
    const finalUrl = currentUrl(session.page);
    // The current page must still be allowlisted before we present it for approval.
    const here = isAoiBrowserDriveUrlAllowed(params.allowlist, finalUrl);
    if (!here.allowed) {
      return {
        ok: false,
        reason: 'prefix_failed',
        detail: here.reason ?? 'not allowlisted',
        prefix: prefix.results,
      };
    }
    let beforeScreenshotBase64: string | undefined;
    try {
      const bytes = await session.page.screenshot({
        ...(params.timeoutMs ? { timeout: params.timeoutMs } : {}),
      });
      beforeScreenshotBase64 = Buffer.from(bytes).toString('base64');
    } catch {
      // Screenshot is best-effort; the card can render without it.
    }
    return {
      ok: true,
      stepIndex: params.targetStepIndex,
      action: params.plan.steps[params.targetStepIndex].action,
      hostname: hostnameOf(finalUrl),
      finalUrl,
      ...(beforeScreenshotBase64 ? { beforeScreenshotBase64 } : {}),
      prefix: prefix.results,
    };
  } finally {
    await safeClose(session);
  }
}

/**
 * Execute: open a session, replay the read prefix, then run the target step through
 * the executor with the injected (store-backed) approval gate. Fail-closed at every
 * gate inside the executor; the session is always closed.
 */
export async function executeAoiBrowserDriveActStep(
  params: AoiBrowserDriveActRunParams & { approvalGate: AoiBrowserDriveApprovalGate },
): Promise<AoiBrowserDriveActExecuteResult | AoiBrowserDriveRunFailure> {
  const guard = guardRun(params);
  if (guard) {
    return guard;
  }
  // Don't even open a session if panic is already engaged.
  if (safeIsPanicked(params.isPanicked)) {
    return { ok: false, reason: 'panicked', detail: 'host-bridge panic engaged' };
  }
  const opened = await openSession(params.sessionFactory);
  if ('ok' in opened && opened.ok === false) {
    return opened;
  }
  const session = opened as AoiBrowserDriveRunnerSession;
  // On the execute path an audit sink captures before/after artifacts (via an
  // observer bound to this session page) and records one ledger entry per step.
  const observer = params.audit
    ? makeAoiBrowserDriveAuditObserver({
        page: session.page,
        runId: params.audit.runId,
        writeArtifact: params.audit.writeArtifact,
      })
    : params.observer;
  const stepParams: AoiBrowserDriveActRunParams = observer ? { ...params, observer } : params;
  try {
    const prefix = await replayReadPrefix(session.page, stepParams);
    if (params.audit) {
      for (const result of prefix.results) {
        recordAuditStep(params.audit, params.plan, result);
      }
    }
    if (!prefix.ok) {
      return {
        ok: false,
        reason: 'prefix_failed',
        detail: prefix.failure?.stopReason ?? 'prefix step failed',
        prefix: prefix.results,
      };
    }
    // Panic re-check right before the irreversible act: a panic engaged during the
    // read-prefix replay aborts here (fail-closed), and finally closes the session.
    if (safeIsPanicked(params.isPanicked)) {
      return {
        ok: false,
        reason: 'panicked',
        detail: 'host-bridge panic engaged before the action ran',
        prefix: prefix.results,
      };
    }
    const target = await executeAoiBrowserDriveStep({
      page: session.page,
      plan: params.plan,
      stepIndex: params.targetStepIndex,
      allowlist: params.allowlist,
      approvalGate: params.approvalGate,
      now: params.now,
      ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      ...(observer ? { observer } : {}),
      ...(params.maxPlanSteps ? { maxPlanSteps: params.maxPlanSteps } : {}),
      ...(params.sleep ? { sleep: params.sleep } : {}),
    });
    if (params.audit) {
      recordAuditStep(params.audit, params.plan, target);
    }
    return {
      ok: target.ok,
      stepIndex: params.targetStepIndex,
      action: params.plan.steps[params.targetStepIndex].action,
      prefix: prefix.results,
      target,
    };
  } finally {
    await safeClose(session);
  }
}

function summarizeAuditAction(action: AoiBrowserDriveActionRequest): string {
  const target = action?.selector || action?.url || action?.targetText || '';
  return `${action?.kind ?? 'unknown'}${target ? ` ${target}` : ''}`.slice(0, 200);
}

// Record ONE ledger entry for a completed step, pulling before/after artifact refs
// from the observation the audit observer attached to the result. Best-effort: a
// recorder failure never propagates (auditing must not fail a driven step).
function recordAuditStep(
  audit: AoiBrowserDriveRunAudit,
  plan: AoiBrowserDrivePlan,
  result: AoiBrowserDriveStepResult,
): void {
  try {
    const action =
      plan.steps[result.index]?.action ?? ({ kind: 'wait' } as AoiBrowserDriveActionRequest);
    audit.recordEntry({
      runId: audit.runId,
      stepIndex: result.index,
      actionKind: action.kind,
      actionSummary: summarizeAuditAction(action),
      category: result.category,
      ok: result.ok,
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      ...(result.approvalViaStanding ? { viaStanding: true } : {}),
      url: result.finalUrl ?? '',
      ...(result.observation?.before?.screenshotRef
        ? { beforeScreenshotRef: result.observation.before.screenshotRef }
        : {}),
      ...(result.observation?.after?.screenshotRef
        ? { afterScreenshotRef: result.observation.after.screenshotRef }
        : {}),
      ...(result.observation?.before?.domRef
        ? { beforeDomRef: result.observation.before.domRef }
        : {}),
      ...(result.observation?.after?.domRef
        ? { afterDomRef: result.observation.after.domRef }
        : {}),
    });
  } catch {
    // best-effort audit; never fail a step because recording failed
  }
}

async function safeClose(session: AoiBrowserDriveRunnerSession): Promise<void> {
  try {
    await session.close();
  } catch {
    // best-effort teardown
  }
}

// A throwing panic check is treated as PANICKED (fail-closed): if we cannot confirm
// it is safe to act, we do not act.
function safeIsPanicked(isPanicked: (() => boolean) | undefined): boolean {
  if (!isPanicked) {
    return false;
  }
  try {
    return isPanicked() === true;
  } catch {
    return true;
  }
}
