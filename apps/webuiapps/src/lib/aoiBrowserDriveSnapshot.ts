// Element-addressed snapshot for browser-drive (SOM-style addressing).
//
// Ported from the hermes-agent computer-use contract. Two ideas carry over:
//
//   1. Address elements by INDEX, not by coordinates or model-authored
//      selectors. "click element 7" is far more reliable than asking a model to
//      invent `div.card:nth-child(3) > button.primary`, which is where selector
//      drift and wrong-target clicks come from.
//
//   2. Refs are valid for exactly ONE snapshot. hermes puts it plainly: a new
//      snapshot supersedes every prior ref BEFORE the transport call, so a
//      failed snapshot cannot leave a stale ref usable. Every mutation
//      invalidates the set; a ref from an older snapshot is refused, never
//      guessed at.
//
// SECURITY: a ref is an ADDRESSING convenience and never a trust shortcut. It
// resolves to a selector, and the resolved selector then goes through exactly
// the same downstream path as a model-authored one -- the live-DOM forbidden
// re-check, the approval fingerprint, and the allowlist. Nothing here may be
// treated as pre-approved just because it came out of a snapshot Aoi built.
//
// Parsing follows the existing host-browser reader: regex over the HTML string,
// no DOM dependency, so this stays usable from the daemon and unit-testable
// without a browser.

export type AoiBrowserDriveElementRole =
  | 'button'
  | 'link'
  | 'textbox'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'other';

export interface AoiBrowserDriveElement {
  // 1-based index the model addresses. Stable only within its snapshot.
  ref: number;
  role: AoiBrowserDriveElementRole;
  // Accessible name, clamped. Page-controlled text: it reaches the model, so it
  // is bounded and stripped of markup here.
  name: string;
  // How the executor actually reaches the element.
  selector: string;
  disabled?: boolean;
  // Set when the element looks like a credential/payment input. The real block
  // is the downstream live-DOM re-check; this only keeps such elements from
  // being proposed in the first place.
  sensitive?: boolean;
}

export interface AoiBrowserDriveSnapshot {
  // Identifies this exact snapshot. A ref is only meaningful together with it.
  id: string;
  url: string;
  takenAt: number;
  elements: AoiBrowserDriveElement[];
  // Interactables the page exposes that carry no id/name/testid and so cannot be
  // addressed by ref. Surfaced so the model knows to author a selector for them
  // rather than assume the page has nothing else.
  unaddressable?: number;
}

const MAX_ELEMENTS = 120;
const MAX_NAME_CHARS = 80;

// Inputs whose value must never be driven by Aoi. Mirrors the forbidden
// classification's intent; the authoritative check still runs on the live DOM.
const SENSITIVE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'password',
  'tel',
  'creditcard',
  'cc-number',
]);

const SENSITIVE_NAME_PATTERN =
  /(password|passwd|pwd|비밀번호|암호|card|cvc|cvv|creditcard|otp|one-?time|인증번호|보안코드)/i;

function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampName(value: string): string {
  const text = stripMarkup(value);
  return text.length > MAX_NAME_CHARS ? `${text.slice(0, MAX_NAME_CHARS)}...` : text;
}

function readAttribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return (match?.[2] ?? match?.[3] ?? '').trim();
}

// A standalone boolean attribute. A bare  also matched data-disabled,
// aria-disabled="false" and even class="not-disabled", so an ordinary control
// was reported disabled and then refused.
function hasBareAttribute(tag: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?=[\\s=>/]|$)`, 'i').test(tag);
}

// CSS-escape the subset that actually shows up in ids/names, so a crafted
// attribute cannot break out of the selector we build from it.
function cssEscape(value: string): string {
  return value.replace(/["\\\]]/g, (character) => `\\${character}`);
}

function roleOf(tagName: string, tag: string): AoiBrowserDriveElementRole {
  const lowered = tagName.toLowerCase();
  if (lowered === 'a') {
    return 'link';
  }
  if (lowered === 'button') {
    return 'button';
  }
  if (lowered === 'select') {
    return 'select';
  }
  if (lowered === 'textarea') {
    return 'textbox';
  }
  if (lowered === 'input') {
    const type = (readAttribute(tag, 'type') || 'text').toLowerCase();
    if (type === 'checkbox') {
      return 'checkbox';
    }
    if (type === 'radio') {
      return 'radio';
    }
    if (type === 'submit' || type === 'button' || type === 'reset') {
      return 'button';
    }
    return 'textbox';
  }
  return 'other';
}

function isSensitive(tag: string, name: string): boolean {
  const type = readAttribute(tag, 'type').toLowerCase();
  if (SENSITIVE_INPUT_TYPES.has(type)) {
    return true;
  }
  const haystack = [
    readAttribute(tag, 'name'),
    readAttribute(tag, 'id'),
    readAttribute(tag, 'autocomplete'),
    readAttribute(tag, 'placeholder'),
    name,
  ].join(' ');
  return SENSITIVE_NAME_PATTERN.test(haystack);
}

/**
 * A selector that addresses exactly this element, or null when none exists.
 *
 * Null is deliberate. The obvious fallback -- `tag:nth-of-type(n)` counted over
 * this scan -- is WRONG: CSS counts nth-of-type among siblings inside ONE
 * parent, while the scan walks the whole document, so on any page whose
 * controls are not all siblings it addresses a different element or nothing at
 * all. A ref that clicks the wrong control is worse than no ref, so an element
 * with no page-provided identifier is simply not addressable and the model
 * authors a selector for it instead.
 */
function selectorFor(tagName: string, tag: string): string | null {
  const id = readAttribute(tag, 'id');
  if (id) {
    return `#${cssEscape(id)}`;
  }
  const testId = readAttribute(tag, 'data-testid');
  if (testId) {
    return `[data-testid="${cssEscape(testId)}"]`;
  }
  const name = readAttribute(tag, 'name');
  if (name) {
    return `${tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
  }
  return null;
}

// Cheap, stable content hash so two snapshots of the same page compare equal
// and any change mints a new id.
function snapshotId(url: string, elements: AoiBrowserDriveElement[]): string {
  const material = `${url}|${elements.map((e) => `${e.role}:${e.selector}:${e.name}`).join('|')}`;
  let hash = 2166136261;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `bds-${(hash >>> 0).toString(36)}`;
}

const INTERACTABLE_PATTERN =
  /<(a|button|input|select|textarea)\b([^>]*)>([\s\S]*?)<\/\1>|<(input)\b([^>]*)\/?>/gi;

/**
 * Build an element-addressed snapshot from page HTML.
 *
 * Deliberately bounded: at most MAX_ELEMENTS entries with clamped names, since
 * every one of them lands in the model's context and the page controls the text.
 */
export function buildAoiBrowserDriveSnapshot(params: {
  html: string;
  url: string;
  now: number;
}): AoiBrowserDriveSnapshot {
  const html = typeof params.html === 'string' ? params.html : '';
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const elements: AoiBrowserDriveElement[] = [];
  let unaddressable = 0;
  let match: RegExpExecArray | null;
  INTERACTABLE_PATTERN.lastIndex = 0;
  while ((match = INTERACTABLE_PATTERN.exec(cleaned)) !== null) {
    if (elements.length >= MAX_ELEMENTS) {
      break;
    }
    const tagName = (match[1] ?? match[4] ?? '').toLowerCase();
    if (!tagName) {
      continue;
    }
    const tag = match[2] ?? match[5] ?? '';
    const inner = match[3] ?? '';
    const selector = selectorFor(tagName, tag);
    if (!selector) {
      // On the page but not reliably addressable by ref; counted so the listing
      // can say so instead of pretending the page is smaller than it is.
      unaddressable += 1;
      continue;
    }

    const name =
      clampName(inner) ||
      clampName(readAttribute(tag, 'aria-label')) ||
      clampName(readAttribute(tag, 'value')) ||
      clampName(readAttribute(tag, 'placeholder')) ||
      clampName(readAttribute(tag, 'title'));
    const element: AoiBrowserDriveElement = {
      ref: elements.length + 1,
      role: roleOf(tagName, tag),
      name,
      selector,
    };
    if (hasBareAttribute(tag, 'disabled')) {
      element.disabled = true;
    }
    if (isSensitive(tag, name)) {
      element.sensitive = true;
    }
    elements.push(element);
  }

  return {
    id: snapshotId(params.url, elements),
    url: params.url,
    takenAt: params.now,
    elements,
    ...(unaddressable > 0 ? { unaddressable } : {}),
  };
}

export type AoiBrowserDriveRefRefusal =
  // No snapshot has been taken in this session.
  | 'element_snapshot_missing'
  // The ref came from a snapshot that is no longer current.
  | 'element_ref_stale'
  // The snapshot is current but has no such ref.
  | 'element_ref_unknown'
  // The element is present but cannot be driven.
  | 'element_disabled'
  // Credential/payment surface: never addressable by Aoi.
  | 'element_forbidden';

export interface AoiBrowserDriveRefResolution {
  ok: boolean;
  selector?: string;
  element?: AoiBrowserDriveElement;
  code?: AoiBrowserDriveRefRefusal;
  detail?: string;
}

/**
 * Resolve a model-supplied element ref against the CURRENT snapshot.
 *
 * Fail-closed at every step. A ref whose snapshot id does not match is refused
 * rather than resolved against whatever snapshot happens to be loaded -- that
 * is the failure mode ref-addressing exists to remove, and silently rebinding
 * it would act on a different element than the model chose.
 */
export function resolveAoiBrowserDriveElementRef(params: {
  snapshot: AoiBrowserDriveSnapshot | null | undefined;
  ref: number;
  // When given, must equal the snapshot's id. A caller that has one and does
  // not pass it gets no staleness protection, so the action schema should
  // always carry it.
  snapshotId?: string;
}): AoiBrowserDriveRefResolution {
  const { snapshot, ref } = params;
  if (!snapshot) {
    return {
      ok: false,
      code: 'element_snapshot_missing',
      detail: 'take a snapshot before addressing elements by ref',
    };
  }
  if (params.snapshotId !== undefined && params.snapshotId !== snapshot.id) {
    return {
      ok: false,
      code: 'element_ref_stale',
      detail: 'that ref came from an older snapshot; take a fresh one and re-read the refs',
    };
  }
  if (!Number.isInteger(ref) || ref < 1) {
    return { ok: false, code: 'element_ref_unknown', detail: 'ref must be a positive integer' };
  }
  const element = snapshot.elements.find((entry) => entry.ref === ref);
  if (!element) {
    return {
      ok: false,
      code: 'element_ref_unknown',
      detail: `this snapshot has refs 1..${snapshot.elements.length}`,
    };
  }
  if (element.sensitive) {
    return {
      ok: false,
      code: 'element_forbidden',
      element,
      detail: 'credential/payment fields are never driven by Aoi; the user must do it',
    };
  }
  if (element.disabled) {
    return {
      ok: false,
      code: 'element_disabled',
      element,
      detail: 'the element is disabled; acting on it would do nothing',
    };
  }
  return { ok: true, selector: element.selector, element };
}

/**
 * Render a snapshot for the model, in hermes's AX-index style.
 *
 * Sensitive and disabled entries are listed rather than hidden: the model needs
 * to see that a password field exists so it stops asking, and a hidden element
 * would just be re-proposed by index drift.
 */
export function formatAoiBrowserDriveSnapshot(snapshot: AoiBrowserDriveSnapshot): string {
  if (snapshot.elements.length === 0) {
    return `snapshot ${snapshot.id}: no interactable elements found`;
  }
  const lines = snapshot.elements.map((element) => {
    const flags = [element.disabled ? 'disabled' : '', element.sensitive ? 'FORBIDDEN' : ''].filter(
      Boolean,
    );
    return `#${element.ref} ${element.role} ${JSON.stringify(element.name)}${
      flags.length > 0 ? ` [${flags.join(',')}]` : ''
    }`;
  });
  return [
    `snapshot ${snapshot.id} (${snapshot.elements.length} elements` +
      `${snapshot.unaddressable ? `, ${snapshot.unaddressable} more not addressable by ref` : ''})`,
    'Address elements by ref, and pass this snapshot id with the action.',
    'Refs are valid ONLY for this snapshot: any act invalidates them, so take a fresh one after acting.',
    ...lines,
  ].join('\n');
}

/**
 * True when a snapshot can still be trusted to address elements.
 *
 * A navigation always invalidates it. An act does too -- the caller drops the
 * snapshot after acting rather than asking this.
 */
export function isAoiBrowserDriveSnapshotCurrent(
  snapshot: AoiBrowserDriveSnapshot | null | undefined,
  currentUrl: string,
): boolean {
  if (!snapshot) {
    return false;
  }
  return snapshot.url === currentUrl;
}
