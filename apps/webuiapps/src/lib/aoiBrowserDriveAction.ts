// Aoi browser-drive action classifier (P2.1): the safety core for Phase 2 (acting
// on the user's OWN logged-in browser). PURE + no execution -- it maps a proposed
// browser action into one of three categories:
//
//   read      -> observation only (navigate/extract/scroll/...). Runs without
//                per-action approval (still domain-allowlisted at navigation time).
//   act       -> a real side effect (click/type/select/submit). Requires explicit
//                per-action human approval before it may run (Phase 2 wiring).
//   forbidden -> HARD-BLOCKED, never runnable even with approval. Enforces the
//                permanent invariants: Aoi never enters passwords/payment/OTP/SSN,
//                never commits a financial transaction (pay/buy/transfer/trade),
//                and never interacts with a CAPTCHA. Login stays a human act.
//
// These hard-blocks are DETERMINISTIC (field metadata + accessible-name patterns)
// so they cannot be talked around by the model; the approval layer is the softer
// second gate for everything in 'act'.

export type AoiBrowserDriveActionKind =
  // read-only / observational
  | 'navigate'
  | 'extract'
  | 'scroll'
  | 'screenshot'
  | 'wait'
  | 'back'
  // side-effecting
  | 'click'
  | 'type'
  | 'select'
  | 'press'
  | 'submit';

export interface AoiBrowserDriveActionField {
  // The target input's `type` attribute (password/email/text/tel/number/...).
  type?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  ariaLabel?: string;
}

export interface AoiBrowserDriveActionRequest {
  kind: AoiBrowserDriveActionKind;
  selector?: string;
  url?: string;
  text?: string;
  value?: string;
  key?: string;
  // Metadata about the target element, used for deterministic hard-blocks.
  field?: AoiBrowserDriveActionField;
  // The accessible name / visible text of a click/submit target, used to block
  // financial-commit and captcha controls.
  targetText?: string;
}

export type AoiBrowserDriveActionCategory = 'read' | 'act' | 'forbidden';

export type AoiBrowserDriveActionForbidReason =
  | 'sensitive_field'
  | 'financial_commit'
  | 'captcha'
  | 'unknown_action';

export interface AoiBrowserDriveActionDecision {
  category: AoiBrowserDriveActionCategory;
  requiresApproval: boolean;
  reason: string;
  forbidReason?: AoiBrowserDriveActionForbidReason;
}

const READ_KINDS: ReadonlySet<AoiBrowserDriveActionKind> = new Set([
  'navigate',
  'extract',
  'scroll',
  'screenshot',
  'wait',
  'back',
]);

const ACT_KINDS: ReadonlySet<AoiBrowserDriveActionKind> = new Set([
  'click',
  'type',
  'select',
  'press',
  'submit',
]);

// Autocomplete tokens that name a credential / payment / one-time secret.
const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
]);

// Field name/id/label patterns that indicate a secret to be typed.
const SENSITIVE_FIELD_PATTERN =
  /(pass(word|wd|code)?|\bpwd\b|credit|card ?number|card ?num|\bccnum|\bcvv\b|\bcvc\b|security code|\bssn\b|social ?security|one[- ]?time|otp|\bpin\b|routing|\biban\b|account ?number)/i;

// Accessible-name / selector patterns for controls that COMMIT a financial action.
// Clicking these is hard-blocked (the prohibited transfer/trade/purchase class),
// not merely approval-gated.
const FINANCIAL_COMMIT_PATTERN =
  /(pay\b|pay now|make payment|confirm payment|place order|checkout|complete purchase|buy now|\bbuy\b|purchase|subscribe and pay|transfer|send money|wire\b|withdraw|deposit|\btrade\b|place (order|trade)|sell\b)/i;

const CAPTCHA_PATTERN = /(captcha|recaptcha|hcaptcha|i'?m not a robot|not a robot)/i;

function fieldHaystack(field: AoiBrowserDriveActionField | undefined): string {
  if (!field) {
    return '';
  }
  return [field.name, field.id, field.autocomplete, field.ariaLabel]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
}

function isSensitiveField(field: AoiBrowserDriveActionField | undefined): boolean {
  if (!field) {
    return false;
  }
  if (typeof field.type === 'string' && field.type.trim().toLowerCase() === 'password') {
    return true;
  }
  const autocomplete =
    typeof field.autocomplete === 'string' ? field.autocomplete.trim().toLowerCase() : '';
  if (autocomplete && SENSITIVE_AUTOCOMPLETE.has(autocomplete)) {
    return true;
  }
  return SENSITIVE_FIELD_PATTERN.test(fieldHaystack(field));
}

function isCaptchaTarget(request: AoiBrowserDriveActionRequest): boolean {
  const parts = [request.targetText, request.selector, fieldHaystack(request.field)]
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
  return CAPTCHA_PATTERN.test(parts);
}

function isFinancialCommitTarget(request: AoiBrowserDriveActionRequest): boolean {
  const text = typeof request.targetText === 'string' ? request.targetText : '';
  return FINANCIAL_COMMIT_PATTERN.test(text);
}

/**
 * Classify a proposed action. Forbidden checks run FIRST and are deterministic so
 * they cannot be bypassed by the model's framing.
 */
export function classifyAoiBrowserDriveAction(
  request: AoiBrowserDriveActionRequest,
): AoiBrowserDriveActionDecision {
  const kind = request.kind;

  // Unknown kind -> fail closed as forbidden.
  if (!READ_KINDS.has(kind) && !ACT_KINDS.has(kind)) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason: `unknown action kind: ${String(kind)}`,
      forbidReason: 'unknown_action',
    };
  }

  // CAPTCHA: never interact, regardless of kind.
  if (isCaptchaTarget(request)) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason: 'CAPTCHA interaction is never permitted; the user must solve it.',
      forbidReason: 'captcha',
    };
  }

  // Typing into a credential / payment / OTP field is never permitted.
  if (kind === 'type' && isSensitiveField(request.field)) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason: 'Entering passwords/payment/OTP/SSN is never permitted; the user must do it.',
      forbidReason: 'sensitive_field',
    };
  }

  // Committing a financial action (pay/buy/transfer/trade/checkout) is never
  // permitted, even with approval.
  if ((kind === 'click' || kind === 'submit') && isFinancialCommitTarget(request)) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason: 'Financial transactions (pay/buy/transfer/trade) are never permitted.',
      forbidReason: 'financial_commit',
    };
  }

  if (READ_KINDS.has(kind)) {
    return {
      category: 'read',
      requiresApproval: false,
      reason: 'observation only',
    };
  }

  return {
    category: 'act',
    requiresApproval: true,
    reason: 'side-effecting action requires per-action approval',
  };
}
