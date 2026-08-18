// Aoi browser-drive plan model + classifier (P2.2a): the operator chose "propose a
// plan, then execute step-by-step". The LLM proposes a short ordered plan of
// actions; this PURE module classifies every step (via the P2.1 action classifier)
// and decides whether the plan is admissible at all.
//
// ADMISSIBILITY IS ALL-OR-NOTHING: if ANY step is forbidden, the WHOLE plan is
// inadmissible and must be re-planned. We never execute "up to" a forbidden step,
// so the model cannot smuggle a forbidden action by sequencing it after benign
// ones. Read steps run without approval; act steps each need per-action approval
// (wired in a later phase). No execution here.

import {
  classifyAoiBrowserDriveAction,
  normalizeAoiBrowserDriveActionKeys,
  type AoiBrowserDriveActionDecision,
  type AoiBrowserDriveActionRequest,
} from './aoiBrowserDriveAction';

export const AOI_BROWSER_DRIVE_MAX_PLAN_STEPS = 20;

export interface AoiBrowserDrivePlanStep {
  // Human-readable description shown in the approval card.
  description: string;
  action: AoiBrowserDriveActionRequest;
}

export interface AoiBrowserDrivePlan {
  goal: string;
  steps: AoiBrowserDrivePlanStep[];
}

export interface AoiBrowserDrivePlanStepDecision {
  index: number;
  description: string;
  action: AoiBrowserDriveActionRequest;
  decision: AoiBrowserDriveActionDecision;
}

export type AoiBrowserDrivePlanRejectReason =
  | 'empty_plan'
  | 'too_many_steps'
  | 'contains_forbidden_step';

export interface AoiBrowserDrivePlanClassification {
  goal: string;
  steps: AoiBrowserDrivePlanStepDecision[];
  admissible: boolean;
  rejectReasons: AoiBrowserDrivePlanRejectReason[];
  forbiddenStepIndexes: number[];
  approvalStepIndexes: number[];
  autoStepIndexes: number[];
}

/**
 * Classify a proposed plan. Pure: returns per-step decisions plus a plan-level
 * admissibility verdict. An over-long plan or one containing any forbidden step is
 * inadmissible (the caller must re-plan); an empty plan is inadmissible too.
 */
export function classifyAoiBrowserDrivePlan(
  plan: AoiBrowserDrivePlan,
  options: { maxSteps?: number } = {},
): AoiBrowserDrivePlanClassification {
  const maxSteps = Math.max(1, options.maxSteps ?? AOI_BROWSER_DRIVE_MAX_PLAN_STEPS);
  const goal = typeof plan?.goal === 'string' ? plan.goal.trim() : '';
  const rawSteps = Array.isArray(plan?.steps) ? plan.steps : [];

  const steps: AoiBrowserDrivePlanStepDecision[] = rawSteps.map((step, index) => {
    // Normalize BEFORE classifying: the forbidden checks read fields like
    // targetText and field, and a key the classifier cannot see is a check that
    // silently does not run.
    const action = normalizeAoiBrowserDriveActionKeys(
      step?.action ?? ({ kind: 'wait' } as AoiBrowserDriveActionRequest),
    );
    return {
      index,
      description:
        typeof step?.description === 'string' && step.description.trim()
          ? step.description.trim()
          : `step ${index + 1}`,
      action,
      decision: classifyAoiBrowserDriveAction(action),
    };
  });

  const forbiddenStepIndexes = steps
    .filter((step) => step.decision.category === 'forbidden')
    .map((step) => step.index);
  const approvalStepIndexes = steps
    .filter((step) => step.decision.category === 'act')
    .map((step) => step.index);
  const autoStepIndexes = steps
    .filter((step) => step.decision.category === 'read')
    .map((step) => step.index);

  const rejectReasons: AoiBrowserDrivePlanRejectReason[] = [];
  if (steps.length === 0) {
    rejectReasons.push('empty_plan');
  }
  if (rawSteps.length > maxSteps) {
    rejectReasons.push('too_many_steps');
  }
  if (forbiddenStepIndexes.length > 0) {
    rejectReasons.push('contains_forbidden_step');
  }

  return {
    goal,
    steps,
    admissible: rejectReasons.length === 0,
    rejectReasons,
    forbiddenStepIndexes,
    approvalStepIndexes,
    autoStepIndexes,
  };
}
