import {
  classifyAoiBrowserDrivePlan,
  type AoiBrowserDrivePlan,
  type AoiBrowserDrivePlanClassification,
} from '@/lib/aoiBrowserDrivePlan';
import type {
  AoiBrowserDriveActionField,
  AoiBrowserDriveActionKind,
  AoiBrowserDriveActionRequest,
} from '@/lib/aoiBrowserDriveAction';

// Turning what the operator types into a plan the classifier can judge.
//
// Both imports above are pure (aoiBrowserDrivePlan and aoiBrowserDriveAction
// have no node dependencies), which is what lets the console classify a plan as
// it is typed instead of after a server round-trip. aoiBrowserDriveAllowlist is
// deliberately NOT imported here -- it uses node fs and would break `pnpm build`
// while leaving typecheck and vitest green.

export const DRIVE_ACTION_KINDS: AoiBrowserDriveActionKind[] = [
  'navigate',
  'extract',
  'scroll',
  'screenshot',
  'wait',
  'back',
  'click',
  'type',
  'select',
  'press',
  'submit',
];

/** Kinds that need a target, so the editor can ask for the right field. */
const NEEDS_SELECTOR = new Set<AoiBrowserDriveActionKind>([
  'click',
  'type',
  'select',
  'press',
  'submit',
  'extract',
]);
const NEEDS_URL = new Set<AoiBrowserDriveActionKind>(['navigate']);
const NEEDS_VALUE = new Set<AoiBrowserDriveActionKind>(['type', 'select']);

export interface DraftStep {
  id: string;
  description: string;
  kind: AoiBrowserDriveActionKind;
  selector: string;
  url: string;
  value: string;
  targetText: string;
  /** Explicit field metadata; overrides whatever the selector implies. */
  fieldType: string;
  fieldName: string;
  fieldAutocomplete: string;
}

export interface PlanDraft {
  goal: string;
  steps: DraftStep[];
}

export const EMPTY_PLAN_DRAFT: PlanDraft = { goal: '', steps: [] };

export function stepNeeds(kind: AoiBrowserDriveActionKind): {
  selector: boolean;
  url: boolean;
  value: boolean;
} {
  return {
    selector: NEEDS_SELECTOR.has(kind),
    url: NEEDS_URL.has(kind),
    value: NEEDS_VALUE.has(kind),
  };
}

export function makeDraftStep(id: string, kind: AoiBrowserDriveActionKind = 'navigate'): DraftStep {
  return {
    id,
    description: '',
    kind,
    selector: '',
    url: '',
    value: '',
    targetText: '',
    fieldType: '',
    fieldName: '',
    fieldAutocomplete: '',
  };
}

/**
 * Recover field metadata from a CSS selector.
 *
 * The hard block on credential/payment/OTP fields keys off structured `field`
 * metadata, not the selector string. A hand-written plan has only a selector, so
 * without this a step typing into `input[type=password]` classifies as a
 * routine act that merely needs approval -- the console would under-warn about
 * the one thing it is most important to catch, and the block would only appear
 * at execute time.
 *
 * The operator's explicit entries always win; this only fills what the selector
 * already states.
 */
export function inferFieldFromSelector(
  selector: string,
  explicit: { type?: string; name?: string; autocomplete?: string } = {},
): AoiBrowserDriveActionField | null {
  const attr = (key: string): string | undefined => {
    const match = new RegExp(`\\[${key}\\s*=\\s*["']?([^\\]"']+)["']?\\]`, 'i').exec(selector);
    return match?.[1]?.trim() || undefined;
  };
  const idMatch = /#([A-Za-z0-9_-]+)/.exec(selector);

  const field: AoiBrowserDriveActionField = {
    ...(explicit.type?.trim() || attr('type')
      ? { type: (explicit.type?.trim() || attr('type')) as string }
      : {}),
    ...(explicit.name?.trim() || attr('name')
      ? { name: (explicit.name?.trim() || attr('name')) as string }
      : {}),
    ...(explicit.autocomplete?.trim() || attr('autocomplete')
      ? { autocomplete: (explicit.autocomplete?.trim() || attr('autocomplete')) as string }
      : {}),
    ...(idMatch ? { id: idMatch[1] } : {}),
  };

  return Object.keys(field).length > 0 ? field : null;
}

function toActionRequest(step: DraftStep): AoiBrowserDriveActionRequest {
  const needs = stepNeeds(step.kind);
  const selector = step.selector.trim();
  // Field metadata only matters for steps that put a value into an element.
  const field = needs.value
    ? inferFieldFromSelector(selector, {
        type: step.fieldType,
        name: step.fieldName,
        autocomplete: step.fieldAutocomplete,
      })
    : null;

  return {
    kind: step.kind,
    ...(needs.selector && selector ? { selector } : {}),
    ...(needs.url && step.url.trim() ? { url: step.url.trim() } : {}),
    ...(needs.value && step.value.trim() ? { value: step.value.trim() } : {}),
    ...(step.targetText.trim() ? { targetText: step.targetText.trim() } : {}),
    ...(field ? { field } : {}),
  };
}

export function draftToPlan(draft: PlanDraft): AoiBrowserDrivePlan {
  return {
    goal: draft.goal.trim(),
    steps: draft.steps.map((step) => ({
      // A blank description would reach the approval card as an empty line, so
      // fall back to something the operator can still recognize.
      description: step.description.trim() || `${step.kind} ${step.selector || step.url}`.trim(),
      action: toActionRequest(step),
    })),
  };
}

export function classifyDraft(draft: PlanDraft): AoiBrowserDrivePlanClassification {
  return classifyAoiBrowserDrivePlan(draftToPlan(draft));
}

export type StepCategory = 'read' | 'act' | 'forbidden';

export interface DraftSummary {
  total: number;
  read: number;
  act: number;
  forbidden: number;
  admissible: boolean;
  rejectReasons: string[];
  /** Step indexes that will each need their own operator approval. */
  approvalStepIndexes: number[];
}

/**
 * The headline the operator reads before touching anything.
 *
 * Counting act and forbidden steps separately matters: "3 steps" tells you
 * nothing, while "1 read, 1 needs approval, 1 blocked" tells you exactly how
 * much of this you are being asked to vouch for.
 */
export function summarizeDraft(draft: PlanDraft): DraftSummary {
  const classification = classifyDraft(draft);
  let read = 0;
  let act = 0;
  let forbidden = 0;
  for (const step of classification.steps) {
    const category = step.decision.category as StepCategory;
    if (category === 'forbidden') {
      forbidden += 1;
    } else if (category === 'act') {
      act += 1;
    } else {
      read += 1;
    }
  }
  return {
    total: classification.steps.length,
    read,
    act,
    forbidden,
    admissible: classification.admissible,
    rejectReasons: classification.rejectReasons,
    approvalStepIndexes: classification.approvalStepIndexes,
  };
}

/**
 * Why a step is unrunnable, phrased for the person deciding.
 *
 * The raw reason codes are precise but not self-explanatory; a plan that just
 * says "forbidden" invites the operator to work around it rather than
 * understand it.
 */
export function describeForbidReason(reason: string | undefined): string {
  switch (reason) {
    case 'sensitive_field':
      return '비밀번호·카드번호 등 민감 입력란이라 자동 입력이 차단됩니다.';
    case 'financial_commit':
      return '결제·송금 확정 버튼으로 판정되어 차단됩니다.';
    case 'captcha':
      return 'CAPTCHA/봇 판별 요소라 차단됩니다.';
    case 'unknown_action':
      return '알 수 없는 동작이라 차단됩니다.';
    default:
      return '차단된 동작입니다.';
  }
}

export function describeRejectReason(reason: string): string {
  switch (reason) {
    case 'empty_plan':
      return '단계가 없습니다.';
    case 'too_many_steps':
      return '단계 수가 상한을 넘었습니다.';
    case 'contains_forbidden_step':
      return '차단된 단계가 포함되어 있어 이 계획은 실행할 수 없습니다.';
    default:
      return reason;
  }
}
