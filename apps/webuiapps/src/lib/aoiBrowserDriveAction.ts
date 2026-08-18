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
  // Element-addressed snapshot: lists interactables with refs so an act can
  // target `element: N` instead of a model-authored selector.
  | 'elements'
  | 'scroll'
  | 'screenshot'
  | 'wait'
  | 'back'
  // Tabs. A link with target=_blank, an OAuth popup or a payment iframe opens a
  // page that is simply unreachable without these -- the drive would keep acting
  // on the original tab while the thing it was asked about sits in another one.
  | 'tabs'
  | 'tab'
  // side-effecting
  | 'click'
  | 'type'
  | 'select'
  | 'press'
  | 'submit'
  | 'hover'
  | 'drag'
  // Answer a native alert/confirm/prompt. This is an ACT, not a convenience:
  // accepting a confirm is how a page asks "really delete this?".
  | 'dialog'
  // Attach a local file to a file input.
  | 'upload'
  // Save a file the page offers. The click that triggers it is the act; this
  // says where the bytes are allowed to land.
  | 'download';

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
  // Element ref from an `elements` snapshot, used INSTEAD of authoring a
  // selector. Resolved to a concrete selector before anything else runs, so the
  // forbidden re-check, the approval fingerprint and the allowlist all see the
  // real target -- a ref is addressing, never a trust shortcut.
  element?: number;
  // The snapshot the ref came from. Required with `element`: it is a content
  // hash of the page, so a mismatch means the page changed and the ref is
  // refused rather than rebound onto whatever is there now.
  snapshotId?: string;
  url?: string;
  text?: string;
  value?: string;
  key?: string;
  // Metadata about the target element, used for deterministic hard-blocks.
  field?: AoiBrowserDriveActionField;
  // The accessible name / visible text of a click/submit target, used to block
  // financial-commit and captcha controls.
  targetText?: string;
  // drag: where to drop. Same addressing rules as `selector` / `element`.
  toSelector?: string;
  toElement?: number;
  // tab: which tab to make current, by index from a `tabs` listing.
  tabIndex?: number;
  // dialog: 'accept' or 'dismiss', plus the text for a prompt().
  disposition?: string;
  promptText?: string;
  // upload: absolute path of the file to attach. Refused unless it sits inside
  // an operator-registered read root -- see the executor.
  // download: the directory to save into, bounded the same way by WRITE roots.
  filePath?: string;
}

/**
 * Accept the snake_case key names the tool schema advertises.
 *
 * The schema says `snapshot_id`, `to_element`, `file_path`; the internal type is
 * camelCase. Translating in ONE place matters more than it looks: a key that is
 * silently dropped does not fail loudly, it produces an action missing the very
 * field that would have constrained it -- a drag with no destination, or worse,
 * an upload whose file_path never reaches the gate that was supposed to check
 * it. Both key styles are accepted so a model that guesses either is understood.
 */
export function normalizeAoiBrowserDriveActionKeys(raw: unknown): AoiBrowserDriveActionRequest {
  if (!raw || typeof raw !== 'object') {
    return { kind: 'wait' };
  }
  const source = raw as Record<string, unknown>;
  const pick = (camel: string, snake: string): unknown =>
    source[camel] !== undefined ? source[camel] : source[snake];

  const action = { ...source } as AoiBrowserDriveActionRequest & Record<string, unknown>;
  const pairs: [keyof AoiBrowserDriveActionRequest, string][] = [
    ['snapshotId', 'snapshot_id'],
    ['toSelector', 'to_selector'],
    ['toElement', 'to_element'],
    ['tabIndex', 'tab_index'],
    ['promptText', 'prompt_text'],
    ['filePath', 'file_path'],
    ['targetText', 'target_text'],
  ];
  for (const [camel, snake] of pairs) {
    const value = pick(camel as string, snake);
    if (value !== undefined) {
      (action as Record<string, unknown>)[camel as string] = value;
    }
  }
  return action;
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
  'elements',
  'scroll',
  'screenshot',
  'wait',
  'back',
  // Listing tabs observes; SELECTING one only changes which page the next step
  // addresses, and every act is separately gated anyway.
  'tabs',
  'tab',
]);

const ACT_KINDS: ReadonlySet<AoiBrowserDriveActionKind> = new Set([
  'click',
  'type',
  'select',
  'press',
  'submit',
  // Hover opens menus and fires the same handlers a click path does, so it is
  // not filed with the read-only steps just because nothing is pressed.
  'hover',
  'drag',
  'dialog',
  'upload',
  'download',
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

// A confirm() that commits money is the same prohibited class as clicking the
// button that raised it -- the dialog is just where the page asked. Its message
// is the thing to read, since there is no element to inspect.
function isFinancialDialog(request: AoiBrowserDriveActionRequest): boolean {
  if (request.kind !== 'dialog') {
    return false;
  }
  // Dismissing is always safe: it is how you back out.
  if ((request.disposition ?? '').trim().toLowerCase() !== 'accept') {
    return false;
  }
  return FINANCIAL_COMMIT_PATTERN.test(request.targetText ?? '');
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

  // ...and neither is confirming one in a dialog. The page moved the commit
  // into a confirm(); the answer is the same.
  if (isFinancialDialog(request)) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason: 'Confirming a financial transaction in a dialog is never permitted.',
      forbidReason: 'financial_commit',
    };
  }

  // Dropping a dragged element ONTO a commit control is a click by another
  // route; some UIs really are drag-to-confirm.
  if (kind === 'drag' && isFinancialCommitTarget(request)) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason: 'Dragging onto a financial commit control is never permitted.',
      forbidReason: 'financial_commit',
    };
  }

  // An upload targeting a credential-ish field (an identity-document or
  // signature slot) is the same refusal as typing into one.
  if (kind === 'upload' && isSensitiveField(request.field)) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason: 'Attaching a file to a credential field is never permitted.',
      forbidReason: 'sensitive_field',
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
