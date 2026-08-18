// Aoi browser-drive bounded task orchestrator (P3.2a): the deterministic control
// loop that runs an operator-authored, ordered task of single-act steps within a
// hard budget, fail-stopping on the first non-ok step. It sits ON TOP of the P2.3b
// per-call runner and relaxes NOTHING: each task step still opens its own stateless
// session and passes every executor gate (standing grant / per-action approval,
// domain denylist, forbidden hard-blocks, drift block, audit, panic). This module
// only adds three things a chat loop cannot be trusted to enforce itself:
//
//   1. consume-not-author -- the task MUST carry owner='user'. Aoi never authors its
//      own task; a task with any other owner is refused. This is the load-bearing
//      "no self-instruction" guard for autonomy.
//   2. budget -- maxActs (irreversible acts) and maxSteps (total inner plan steps,
//      reads + acts) are HARD-capped; exceeding either stops the run.
//   3. fail-stop -- any step that is not ok (denied / drift / forbidden / error /
//      runner failure) stops the whole task immediately with a summary; the loop
//      never barrels past a bad step.
//
// Pure orchestration over an INJECTED per-step executor (the P2.3b runner in prod),
// so it is unit-tested without a browser. Inert until P3.2b wires the chat tool.

import type {
  AoiBrowserDriveActExecuteResult,
  AoiBrowserDriveRunFailure,
} from './aoiBrowserDriveActRunner';
import type { AoiBrowserDrivePlan } from './aoiBrowserDrivePlan';
import type { AoiBrowserDriveEffect } from './aoiBrowserDriveVerdict';

// The kill-switch capability toggle that must be ON for the autonomous multi-act
// task route to run at all (a human-only control, distinct from single-act standing
// approval; default OFF, panic forces off). A multi-act loop is materially riskier
// than approving acts one at a time, so it opts in separately.
export const AOI_BROWSER_DRIVE_TASK_CAPABILITY = 'os_browser_drive_task';

// Hard ceilings. The caller may request smaller budgets but never larger.
export const AOI_BROWSER_DRIVE_TASK_MAX_ACTS = 10;
export const AOI_BROWSER_DRIVE_TASK_MAX_STEPS = 40;
export const AOI_BROWSER_DRIVE_TASK_MAX_TASK_STEPS = 40;

export interface AoiBrowserDriveTaskStep {
  plan: AoiBrowserDrivePlan;
  targetStepIndex: number;
}

export interface AoiBrowserDriveTask {
  // Consume-not-author: only 'user' is accepted; anything else is refused.
  owner: string;
  goal: string;
  steps: AoiBrowserDriveTaskStep[];
}

export type AoiBrowserDriveTaskStopReason =
  | 'not_operator_authored'
  | 'empty_task'
  | 'too_many_steps'
  | 'budget_exhausted'
  | 'step_failed'
  // An act produced positive evidence that it did nothing (e.g. a write whose
  // read-back did not match). Stacking the next act on top of that would build
  // on a state that was never reached.
  | 'act_not_performed'
  // An act was delivered but nothing proved it landed, and another act was
  // queued behind it. A multi-act task advances only on evidence.
  | 'act_unverified'
  | 'completed';

export interface AoiBrowserDriveTaskStepOutcome {
  index: number;
  // Transport success only; see `effect` for what was actually proven.
  ok: boolean;
  // The runner reason (RunFailure) or the target step's stopReason, when not ok.
  reason?: string;
  finalUrl?: string;
  // Semantic verdict of the act, carried through so a caller can report what
  // each step really achieved instead of just that it ran.
  effect?: AoiBrowserDriveEffect;
  verified?: boolean;
}

export interface AoiBrowserDriveTaskResult {
  ok: boolean;
  goal: string;
  stopReason: AoiBrowserDriveTaskStopReason;
  actsRun: number;
  stepsRun: number;
  results: AoiBrowserDriveTaskStepOutcome[];
  detail?: string;
}

// The injected per-step executor -- the P2.3b runner in production. Returns its
// union so the orchestrator can distinguish a runner-level failure from a target
// step that ran-but-failed.
export type AoiBrowserDriveTaskStepExecutor = (
  step: AoiBrowserDriveTaskStep,
  index: number,
) => Promise<AoiBrowserDriveActExecuteResult | AoiBrowserDriveRunFailure>;

function clamp(value: number | undefined, fallback: number, cap: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return Math.min(fallback, cap);
  }
  return Math.min(Math.trunc(value), cap);
}

/**
 * Run an operator-authored task step-by-step within budget, fail-stopping on the
 * first non-ok step. Deterministic: never opens a browser itself (the injected
 * executor does), never relaxes a gate, never generates a goal.
 */
export async function executeAoiBrowserDriveTask(params: {
  task: AoiBrowserDriveTask;
  runStep: AoiBrowserDriveTaskStepExecutor;
  maxActs?: number;
  maxSteps?: number;
  maxTaskSteps?: number;
}): Promise<AoiBrowserDriveTaskResult> {
  const goal = typeof params.task?.goal === 'string' ? params.task.goal : '';
  const steps = Array.isArray(params.task?.steps) ? params.task.steps : [];
  const base = (
    stop: AoiBrowserDriveTaskStopReason,
    detail?: string,
  ): AoiBrowserDriveTaskResult => ({
    ok: stop === 'completed',
    goal,
    stopReason: stop,
    actsRun: 0,
    stepsRun: 0,
    results: [],
    ...(detail ? { detail } : {}),
  });

  // consume-not-author: refuse anything Aoi could have authored itself.
  if (params.task?.owner !== 'user') {
    return base(
      'not_operator_authored',
      `owner must be 'user', got '${String(params.task?.owner)}'`,
    );
  }
  if (steps.length === 0) {
    return base('empty_task');
  }
  const maxTaskSteps = clamp(
    params.maxTaskSteps,
    AOI_BROWSER_DRIVE_TASK_MAX_TASK_STEPS,
    AOI_BROWSER_DRIVE_TASK_MAX_TASK_STEPS,
  );
  if (steps.length > maxTaskSteps) {
    return base('too_many_steps', `${steps.length} > ${maxTaskSteps}`);
  }

  const maxActs = clamp(
    params.maxActs,
    AOI_BROWSER_DRIVE_TASK_MAX_ACTS,
    AOI_BROWSER_DRIVE_TASK_MAX_ACTS,
  );
  const maxSteps = clamp(
    params.maxSteps,
    AOI_BROWSER_DRIVE_TASK_MAX_STEPS,
    AOI_BROWSER_DRIVE_TASK_MAX_STEPS,
  );

  const results: AoiBrowserDriveTaskStepOutcome[] = [];
  let actsRun = 0;
  let stepsRun = 0;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const plannedInnerSteps = Math.max(1, (step?.targetStepIndex ?? 0) + 1);
    // Budget pre-check BEFORE the irreversible act: refuse rather than overrun.
    if (actsRun + 1 > maxActs || stepsRun + plannedInnerSteps > maxSteps) {
      return {
        ok: false,
        goal,
        stopReason: 'budget_exhausted',
        actsRun,
        stepsRun,
        results,
        detail: `stopped before step ${index} (acts ${actsRun}/${maxActs}, steps ${stepsRun}/${maxSteps})`,
      };
    }

    const outcome = await params.runStep(step, index);

    if ('reason' in outcome) {
      // Runner-level failure (bad plan / prefix / session / panic).
      results.push({ index, ok: false, reason: outcome.reason });
      return {
        ok: false,
        goal,
        stopReason: 'step_failed',
        actsRun,
        stepsRun,
        results,
        detail: `runner failure at step ${index}: ${outcome.reason}`,
      };
    }

    // The target ran (ok or gated). Count what it consumed either way.
    const innerRun = (outcome.prefix?.length ?? 0) + 1;
    stepsRun += innerRun;
    actsRun += 1;
    const verdict = outcome.target?.verdict;
    results.push({
      index,
      ok: outcome.ok,
      ...(outcome.target?.stopReason ? { reason: outcome.target.stopReason } : {}),
      ...(outcome.target?.finalUrl ? { finalUrl: outcome.target.finalUrl } : {}),
      ...(verdict ? { effect: verdict.effect, verified: verdict.verified } : {}),
    });

    if (!outcome.ok) {
      return {
        ok: false,
        goal,
        stopReason: 'step_failed',
        actsRun,
        stepsRun,
        results,
        detail: `step ${index} did not complete: ${outcome.target?.stopReason ?? 'failed'}`,
      };
    }

    // A multi-act task runs unattended, so every act after the first inherits
    // the previous one's state as a premise: click to open the form, THEN type
    // into it. Advancing on an act that was not proven builds the rest of the
    // task on a state that may never have existed -- and the later acts land
    // somewhere nobody chose. Single-act runs can hand an unverifiable result
    // back to the model to re-read; here there is no one to re-read it.
    if (verdict && verdict.effect === 'suspected_noop') {
      return {
        ok: false,
        goal,
        stopReason: 'act_not_performed',
        actsRun,
        stepsRun,
        results,
        detail:
          `step ${index} did not take effect` +
          `${verdict.escalation ? `: ${verdict.escalation.reason}` : ''}`,
      };
    }
    const isLastStep = index === steps.length - 1;
    if (verdict && verdict.effect === 'unverifiable' && !isLastStep) {
      return {
        ok: false,
        goal,
        stopReason: 'act_unverified',
        actsRun,
        stepsRun,
        results,
        detail:
          `step ${index} was delivered but nothing proved it landed, and step ` +
          `${index + 1} would have depended on it`,
      };
    }
  }

  return { ok: true, goal, stopReason: 'completed', actsRun, stepsRun, results };
}
