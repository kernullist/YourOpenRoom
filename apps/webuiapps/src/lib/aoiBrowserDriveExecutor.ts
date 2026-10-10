// Aoi browser-drive executor (P2.2b): the FIRST module that actually acts on the
// operator's OWN logged-in browser (click/type/select/press/back), i.e. the highest-
// risk, genuinely irreversible surface of the whole feature. Everything before this
// only read; this drives.
//
// This module is PURE ORCHESTRATION over an INJECTED page + INJECTED approval gate.
// Playwright is never statically imported here (the client bundle must stay free of
// it and the daemon externalizes playwright-core); the page is a structural
// interface, so the whole flow is unit-testable with a fake page and a fake gate --
// no real browser, no CDP.
//
// SAFETY MODEL (see JARVIS/05-browser-drive-roadmap.md). Every step is gated, in
// order, and any failure STOPS the run (never proceeds past a bad step):
//   1. plan admissibility is RE-CHECKED at execution time (cache is never trusted);
//   2. the action is RE-CLASSIFIED at execution time -> a 'forbidden' action is
//      hard-blocked regardless of any approval (passwords/payment/OTP/CAPTCHA/
//      financial commit can never run);
//   3. ACT steps require an explicit per-action approval via the injected gate --
//      a gate that denies, is missing, or throws is treated as fail-closed;
//   4. every step is bound to the domain denylist (default-allow) -- the current
//      page must not be denylisted before we touch it, and after an ACT the FINAL
//      url must STILL not be denylisted or the tab is blanked and the run stops.
//
// This commit wires NOTHING to a route or tool -> importing it changes no runtime
// behavior. The real approval-store binding + approval card + before-screenshot land
// in P2.3; the step audit store + panic land in P2.4. The `observer` hook and the
// per-action fingerprint below are the seams those phases plug into.

import {
  aoiBrowserDriveIsCaptchaText,
  aoiBrowserDrivePressKey,
  aoiBrowserDrivePressOnlyMoves,
  classifyAoiBrowserDriveAction,
  namesAnotherExpiringThing,
  normalizeAoiBrowserDriveActionKeys,
  type AoiBrowserDriveActionCategory,
  type AoiBrowserDriveActionField,
  type AoiBrowserDriveActionRequest,
} from './aoiBrowserDriveAction';
import { cleanUntrustedErrorText } from './aoiUntrustedText';
import {
  isAoiBrowserDriveUrlAllowed,
  type AoiBrowserDriveAllowlist,
} from './aoiBrowserDriveAllowlist';
import {
  classifyAoiBrowserDrivePlan,
  type AoiBrowserDrivePlan,
  type AoiBrowserDrivePlanRejectReason,
} from './aoiBrowserDrivePlan';
import {
  navigateAndExtractAoiBrowserDrive,
  type AoiBrowserDriveNavigablePage,
  type AoiBrowserDriveReadResult,
} from './aoiBrowserDriveRead';
import {
  buildAoiBrowserDriveSnapshot,
  resolveAoiBrowserDriveElementRef,
  type AoiBrowserDriveSnapshot,
} from './aoiBrowserDriveSnapshot';
import {
  classifyAoiBrowserDriveActVerdict,
  type AoiBrowserDriveVerdict,
} from './aoiBrowserDriveVerdict';
import { extractAoiHostBrowserReadable } from './aoiHostBrowserRead';

const DEFAULT_ACT_TIMEOUT_MS = 15_000;
const MAX_ACT_TIMEOUT_MS = 45_000;
const DEFAULT_WAIT_MS = 500;
const MAX_WAIT_MS = 10_000;
const DEFAULT_SCROLL_DELTA = 600;
const DOM_READ_TIMEOUT_MS = 3_000;
const BLANK_URL = 'about:blank';

// The subset of a Playwright Page the executor drives. All members exist on a real
// Page with compatible signatures, so a session page casts to this structurally --
// but tests inject a fake, so no browser is required.
// What the browser says is where a click lands (see aimPointReadOut).
export interface AoiAimPoint {
  words: string;
  frame: boolean;
  embedded: boolean;
  inside: boolean;
  // The click lands in a frame still on the empty document a frame starts with.
  blank?: boolean;
  // The click was followed into a frame, and lost in a frame inside it.
  lost?: boolean;
}

export interface AoiBrowserDriveActablePage extends AoiBrowserDriveNavigablePage {
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  selectOption(selector: string, values: string, options?: { timeout?: number }): Promise<unknown>;
  press(selector: string, key: string, options?: { timeout?: number }): Promise<void>;
  goBack(options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  screenshot(options?: { timeout?: number }): Promise<Uint8Array>;
  // Return delivery to the tab Aoi opened. Optional: a session without tab
  // support has only ever had its own tab, so there is nothing to return from.
  returnToOwnTab?(): void;
  // Whether delivery is on the tab Aoi opened. Absent means it always is.
  isOnOwnTab?(): boolean;
  // How many elements a selector matches, now, without waiting. Lets the
  // live-DOM check find the element an act really reaches (a label's control,
  // the button around an icon) without waiting out each miss.
  countMatches?(selector: string): Promise<number>;
  // Move focus to an element, and press a key wherever focus then is. With
  // both, a key is judged where it lands rather than where it was aimed.
  focus?(selector: string, options?: { timeout?: number }): Promise<void>;
  keyboardPress?(key: string): Promise<void>;
  // Wait for the next navigation of any frame to commit: the rest of a wait a
  // click's own call ran out of time for.
  waitForFrameNavigation?(options: { timeout: number }): Promise<unknown>;
  // An element's accessibility tree, as the browser reads it to a screen
  // reader -- names and text from open shadow trees, slots and labels included
  // -- read in Playwright's isolated world.
  ariaSnapshot?(selector: string, options?: { timeout?: number }): Promise<string>;
  // What the button Enter in a field presses says, found the way the browser
  // finds it: through the field's form owner, however the markup tied the two.
  // Read in the page's own world, so it is only ever added to what the isolated
  // reads found -- a page can make it say less, never make them say less.
  formOwnerDefaultWords?(selector: string, options?: { timeout?: number }): Promise<string>;
  // What is around an element past the shadow trees it sits in, the way its
  // events bubble out of them: the controls and short wrappers outside, read in
  // the page's own world -- and so, again, only ever added.
  wordsOutsideShadow?(
    selector: string,
    options?: { timeout?: number; onward?: boolean },
  ): Promise<string>;
  // What the browser's own hit test finds at the point a click on the element
  // is aimed at, and what its accessibility tree calls that and the controls
  // around it -- asked over the DevTools protocol, out of the page's reach:
  // whether that is a frame it does not look into or an embedded document, and
  // whether it is the element or inside it. Null when the element is not in
  // the top document or in view, or the browser cannot be asked.
  aimPointReadOut?(selector: string, options?: { timeout?: number }): Promise<AoiAimPoint | null>;
  // What an element shows where it can be seen -- in its box, not under an
  // opacity of 0, a clip or a colour that draws nothing -- its length as far
  // as `limit` and a little past it, and those words, measured out of the
  // page's reach. Null when it cannot be told.
  // The boxes around one element a check measures name it (`from`) and hand
  // each measure the same object (`together`): what is asked of the browser
  // about the way up from it is asked once for them, and for no other check.
  shownTextOf?(
    selector: string,
    options?: { timeout?: number; limit?: number; from?: string; together?: object },
  ): Promise<{ length: number; text: string } | null>;
  // What is around an element the page slots into a closed shadow tree, read
  // from its slot by the browser: the boxes and controls of that tree a click
  // on it goes on to, which no selector and no read of the page's own reaches.
  // '' when it is slotted into no closed tree; null when that cannot be told.
  closedSlotWordsOf?(selector: string, options?: { timeout?: number }): Promise<string | null>;
  // What the browser draws in an element, as its accessibility tree reads it
  // out and as it is drawn -- closed shadow trees included -- with how many
  // frames it holds (`drawnFrames`: those the drawing counts in its own
  // document, closed shadow trees too), whether all of it could be read
  // (`whole`, when it is said) and whether a closed shadow tree is in it
  // (`sealed`). Null when it cannot be asked.
  readOutOf?(
    selector: string,
    options?: { timeout?: number },
  ): Promise<{
    words: string;
    frames: number;
    drawnFrames?: number;
    whole?: boolean;
    sealed?: boolean;
  } | null>;
  // Focus where Playwright's fill would put it, with the text selected, and
  // type nothing.
  focusToFill?(selector: string, options?: { timeout?: number }): Promise<void>;
  // Wait until the target could take the act -- Playwright's actionability
  // checks, without acting -- so the target is judged as it will be touched.
  waitForActionable?(
    selector: string,
    kind: string,
    options: { timeout: number; toSelector?: string },
  ): Promise<void>;
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
  // Read-only DOM introspection used to derive the target's REAL accessible text +
  // field metadata from the live page, so the forbidden hard-block does not rely on
  // model-supplied action.targetText/field (which an injected model could omit).
  textContent(selector: string, options?: { timeout?: number }): Promise<string | null>;
  getAttribute(
    selector: string,
    name: string,
    options?: { timeout?: number },
  ): Promise<string | null>;
  // Current VALUE of an input, i.e. the DOM property. Distinct from the `value`
  // ATTRIBUTE, which holds the initial markup value and does not change when a
  // field is filled -- reading that instead reports an unchanged initial value
  // and a correct type looks like it did nothing. Optional so older injected
  // pages still satisfy the interface; without it a write is simply unverifiable.
  inputValue?(selector: string, options?: { timeout?: number }): Promise<string>;

  // All optional: a page that predates these still satisfies the interface, and
  // the executor refuses the action with a named code rather than throwing an
  // opaque TypeError at the model.
  hover?(selector: string, options?: { timeout?: number }): Promise<void>;
  dragAndDrop?(source: string, target: string, options?: { timeout?: number }): Promise<void>;
  setInputFiles?(selector: string, files: string, options?: { timeout?: number }): Promise<void>;
  // Click something that starts a download and save it. Returns where it landed
  // plus the name the site suggested, which is the only proof the file arrived.
  downloadTo?(
    selector: string,
    directory: string,
    options?: { timeout?: number },
  ): Promise<{ path: string; suggestedFilename: string }>;
  // Answer the NEXT native dialog. Playwright surfaces dialogs through an event
  // and auto-dismisses them when nothing is listening, so a drive that never
  // answers one silently loses whatever the page was asking. `read` is the
  // question judged: only a dialog that asks it is answered. `timeoutMs` ends
  // the wait for one, so a wait given up on answers nothing that comes later.
  answerDialog?(
    disposition: 'accept' | 'dismiss',
    promptText?: string,
    options?: { read?: string; timeoutMs?: number },
  ): Promise<string>;
  // Tabs in the same browser context. `id` stays with a tab for the session,
  // where `index` moves when another tab opens or closes before it.
  listTabs?(): Promise<
    { index: number; url: string; title: string; current: boolean; id?: number }[]
  >;
  selectTab?(index: number): Promise<void>;
  // What the page SHOWS (Playwright's innerText), unlike content(), which also
  // holds hidden templates. A page with this gets looked at again after an act;
  // one without it is left as it was.
  innerText?(selector: string, options?: { timeout?: number }): Promise<string>;
  // Wait for a navigation an act started to finish loading.
  waitForLoadState?(state: 'domcontentloaded', options?: { timeout?: number }): Promise<void>;
  // A native dialog the page raised that nobody has answered yet: the same
  // object for as long as the same dialog waits, `unanswerable` when nothing
  // over the browser connection can answer it.
  pendingDialog?(): PendingDialog | null;
}

interface PendingDialog {
  type: string;
  message: string;
  unanswerable?: true;
}

/**
 * Decides whether a local file may be attached to a web page.
 *
 * Uploading is the one browser action that moves data OUT of the operator's
 * machine, and the path is chosen inside a plan that a hostile page can
 * influence -- "attach your SSH key to this form" is a single step away
 * otherwise. So the path is not the model's to pick freely: production wires
 * this to the operator's registered read roots, the same list that bounds file
 * reads.
 *
 * Injected rather than resolved here so the executor stays pure, and DEFAULTED
 * TO DENY at the call site: a caller that forgets to wire it uploads nothing.
 */
export type AoiBrowserDriveUploadGate = (filePath: string) => {
  allowed: boolean;
  reason: string;
};

// Per-ACT approval. Returns whether THIS exact action (by content-addressed
// fingerprint) is approved. P2.2b tests inject a fake; P2.3 wraps the host-bridge
// approval store. A throwing/denying gate is fail-closed at the call site.
export type AoiBrowserDriveApprovalGate = (input: {
  fingerprint: string;
  stepIndex: number;
  action: AoiBrowserDriveActionRequest;
  // The current page URL where the act would happen -- lets a gate scope a standing
  // (domain-wide) pre-authorization to the acting domain (P3.1).
  url: string;
}) => Promise<{ approved: boolean; reason?: string; viaStanding?: boolean }>;

// Audit seam (P2.4 plugs in before/after screenshot + DOM capture). Best-effort:
// an observer that throws never blocks or fails a step.
export interface AoiBrowserDriveObserverContext {
  stepIndex: number;
  phase: 'before' | 'after';
  action: AoiBrowserDriveActionRequest;
  url: string;
}

export interface AoiBrowserDriveObservation {
  screenshotRef?: string;
  domRef?: string;
}

export interface AoiBrowserDriveObserver {
  onStep?(ctx: AoiBrowserDriveObserverContext): Promise<AoiBrowserDriveObservation | void>;
}

export type AoiBrowserDriveStepStopReason =
  | 'plan_inadmissible'
  | 'step_out_of_range'
  | 'forbidden'
  | 'host_denylisted'
  | 'not_allowlisted' // legacy alias of host_denylisted
  | 'approval_denied'
  | 'approval_gate_error'
  | 'drift_to_denylist'
  | 'drift_off_allowlist' // legacy alias of drift_to_denylist
  // The act was carried out (or may have been), and then the page moved onto a
  // denied site. Contained like any drift -- but the act is NOT to be repeated.
  | 'drift_after_act'
  | 'action_failed';

export interface AoiBrowserDriveStepResult {
  index: number;
  category: AoiBrowserDriveActionCategory;
  ok: boolean;
  stopReason?: AoiBrowserDriveStepStopReason;
  detail?: string;
  finalUrl?: string;
  // Present for read 'navigate'/'extract' steps.
  extract?: AoiBrowserDriveReadResult;
  // Present for a read 'screenshot' step.
  screenshotBase64?: string;
  // Present for a read 'elements' step: the refs an act may address.
  snapshot?: AoiBrowserDriveSnapshot;
  // Present for a read 'tabs'/'tab' step.
  tabs?: { index: number; url: string; title: string; current: boolean }[];
  // Set by a 'tab' step that verifiably changed the current tab. Every selector
  // and ref from before it describes a different document now.
  tabSwitched?: boolean;
  // Present for an ACT step: the fingerprint the approval gate was asked about.
  approvalFingerprint?: string;
  // True when the ACT was authorized by a standing grant (P3.1) rather than a fresh
  // per-action approval -- surfaced so the audit ledger can mark autonomous acts.
  approvalViaStanding?: boolean;
  observation?: { before?: AoiBrowserDriveObservation; after?: AoiBrowserDriveObservation };
  // Semantic verdict for an ACT step. `ok` above is transport success only --
  // the call ran and no gate stopped it. This says what we can actually prove
  // about the effect, so a caller never reports a delivered-but-unproven action
  // as done. See aoiBrowserDriveVerdict.
  verdict?: AoiBrowserDriveVerdict;
  // The page looked at again once the act had a moment to land.
  afterAct?: AoiBrowserDriveAfterAct;
}

/**
 * What the page showed after an act, against what it showed before.
 *
 * The session closes when the call ends and the next one opens a new tab and
 * replays its reads from the start, so whatever the act put on screen -- a
 * confirmation, a validation error, a dialog -- is visible here or nowhere.
 * Evidence to read, never proof: it does not change the verdict.
 */
export interface AoiBrowserDriveAfterAct {
  waitedMs: number;
  url: string;
  urlChanged: boolean;
  // False when the visible text could not be compared (unreadable, or a dialog
  // was holding the page).
  textRead: boolean;
  // Lines of visible text that were not there before the act, and ones that
  // went away. Page-written.
  textAppeared: string[];
  textGone: string[];
  textAppearedOmitted?: number;
  textGoneOmitted?: number;
  // The same lines, in a different order: a sort, or an item moved. Without it
  // that act reads as "the visible text did not change".
  textReordered?: true;
  // The page's text ran past what is compared, so a change further down would
  // not show here.
  textTruncated?: true;
  tabsOpened?: { index: number; url: string; title: string; denylisted?: true }[];
  // A dialog the act raised. Nothing answers it before the session closes, and
  // closing dismisses it.
  dialog?: { type: string; message: string };
  // A dialog came up before the act itself returned, so it is not known whether
  // the act was delivered or the page raised the dialog first. Closing the
  // session closes the page before it answers the dialog, so an act still
  // waiting behind it is never delivered later, unseen.
  actInterrupted?: true;
}

export interface AoiBrowserDriveExecuteStepParams {
  page: AoiBrowserDriveActablePage;
  plan: AoiBrowserDrivePlan;
  stepIndex: number;
  allowlist: AoiBrowserDriveAllowlist | null | undefined;
  approvalGate: AoiBrowserDriveApprovalGate;
  now: number;
  timeoutMs?: number;
  observer?: AoiBrowserDriveObserver;
  sleep?: (ms: number) => Promise<void>;
  maxPlanSteps?: number;
  // Decides whether a local file may be attached to the page. Absent means no
  // upload is possible, which is the safe default for a data-egress action.
  uploadGate?: AoiBrowserDriveUploadGate;
  // Decides where a download may be written. Absent means no download, for the
  // same reason: this one writes to the operator's disk.
  downloadGate?: AoiBrowserDriveUploadGate;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function clampTimeout(timeoutMs: number | undefined): number {
  return Math.min(MAX_ACT_TIMEOUT_MS, Math.max(1_000, timeoutMs ?? DEFAULT_ACT_TIMEOUT_MS));
}

// FNV-1a, seeded, 8 hex chars. Two seeded passes give a 16-hex fingerprint that
// satisfies the approval store's /^[a-f0-9]{4,64}$/ pattern.
function fnv1a(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// Canonical serialization of an action for content addressing. Only the fields that
// change the effect are included, in a fixed order, so the same action always maps
// to the same fingerprint (the P2.3 preview route derives it identically).
//
// `hostname` BINDS the approval to the page the act lands on: the preview records it
// from the replayed prefix's final host, and the executor computes it from the live
// page host at act time. An approval shown for one host therefore cannot be
// consumed to act on a DIFFERENT host (the "approve what you saw" guarantee),
// even when both hosts pass the denylist.
/**
 * Summarize the READ STEPS that lead to the act, for the fingerprint.
 *
 * Kept to the fields that decide which page the act lands on. A description
 * change should not invalidate a live approval, but a different URL must.
 */
// The tool schema documents snake_case keys (to_selector, file_path, prompt_text)
// while the code reads camelCase. Everything that reads an action's fields --
// classification, the fingerprint, the act itself -- has to see the same keys,
// or a field the model sent is silently absent from one of them.
function normalizedAction(
  action: AoiBrowserDriveActionRequest | undefined,
): AoiBrowserDriveActionRequest | undefined {
  return action ? normalizeAoiBrowserDriveActionKeys(action) : undefined;
}

export function summarizeAoiBrowserDrivePrefix(
  steps: readonly { action: AoiBrowserDriveActionRequest }[],
): string {
  return JSON.stringify(
    steps.map((step) => {
      const action = normalizedAction(step?.action);
      const summary = [
        action?.kind ?? '',
        action?.url ?? '',
        action?.selector ?? '',
        action?.targetText ?? '',
      ];
      // Which tab a tab step chose decides what page the act lands on: without
      // it, an approval shown one tab's page also covered every other tab.
      return action?.kind === 'tab' ? [...summary, String(action.tabIndex ?? '')] : summary;
    }),
  );
}

export function computeAoiBrowserDriveActionFingerprint(
  goal: string,
  stepIndex: number,
  action: AoiBrowserDriveActionRequest,
  hostname = '',
  // The read steps that run before this one.
  //
  // Without them the approval was bound to the act and the host but NOT to the
  // page the operator was shown. Same goal, same step index, same button, same
  // host, different navigation before it -- one fingerprint. Previewing "pay
  // bill 123" and then running a plan that opens bill 999 reused the approval,
  // and the operator had approved a screenshot of the first.
  prefix: readonly { action: AoiBrowserDriveActionRequest }[] = [],
): string {
  // EVERY field that changes what the action does has to be in here.
  //
  // A fingerprint is what an approval is bound to, so anything left out is a
  // field the operator can be shown one value of and the run can then use
  // another. When the vocabulary grew these were initially missing, which meant
  // an approval to DISMISS a dialog also authorized accepting it, and an
  // approval to upload one file authorized uploading any other file through the
  // same input.
  //
  // Joined as JSON, not with a separator character. Newline-joining let a
  // newline MOVE between fields without changing the string: text
  // 'transfer\n5000' with value 'to-bob', and text 'transfer' with value
  // '5000\nto-bob', produced ONE fingerprint -- so an approval for the
  // first also authorized the second, and those two type different text. JSON
  // escapes the separator out of the values, so no field can forge a boundary.
  //
  // Normalized first: with the documented snake_case keys, file_path and
  // prompt_text never reached this list, so an approval to upload one file also
  // authorized uploading any other through the same input.
  action = normalizedAction(action) as AoiBrowserDriveActionRequest;
  const canonical = JSON.stringify([
    (typeof goal === 'string' ? goal : '').trim(),
    String(stepIndex),
    action?.kind ?? '',
    action?.selector ?? '',
    action?.url ?? '',
    action?.text ?? '',
    action?.value ?? '',
    action?.key ?? '',
    action?.targetText ?? '',
    action?.toSelector ?? '',
    action?.disposition ?? '',
    action?.promptText ?? '',
    action?.filePath ?? '',
    (typeof hostname === 'string' ? hostname : '').trim().toLowerCase(),
    summarizeAoiBrowserDrivePrefix(prefix),
  ]);
  return `${fnv1a(canonical, 0x811c9dc5)}${fnv1a(canonical, 0x9e3779b1)}`;
}

// How long the page's whole document is waited for: a page whose main thread
// never comes back holds no step.
const PAGE_CONTENT_DEADLINE_MS = 10_000;

// The page's document, or null when it does not come in time.
async function pageContentInTime(page: AoiBrowserDriveActablePage): Promise<string | null> {
  return withDeadline(page.content(), PAGE_CONTENT_DEADLINE_MS);
}

// Build a snapshot from the live page. Best-effort: an unreadable page yields an
// empty snapshot rather than throwing, and an empty snapshot simply has no refs
// to address.
async function captureAoiBrowserDriveSnapshot(
  page: AoiBrowserDriveActablePage,
  now: number,
): Promise<AoiBrowserDriveSnapshot> {
  let html = '';
  try {
    html = (await pageContentInTime(page)) ?? '';
  } catch {
    html = '';
  }
  return buildAoiBrowserDriveSnapshot({ html, url: safeUrl(page), now });
}

/**
 * Turn an `element` ref into a concrete selector before anything else runs.
 *
 * The snapshot is re-derived from the LIVE page and its id compared to the one
 * the ref was minted against. The id is a content hash, so a mismatch means the
 * page changed since the model looked -- and the ref is refused rather than
 * rebound onto whatever occupies that index now. This is also what keeps an
 * approval honest: the fingerprint downstream is computed from the RESOLVED
 * selector, so an approval can never be obtained for one element and spent on
 * another.
 */
export async function resolveAoiBrowserDriveActionElementRef(
  page: AoiBrowserDriveActablePage,
  action: AoiBrowserDriveActionRequest,
  now: number,
): Promise<{ ok: true; action: AoiBrowserDriveActionRequest } | { ok: false; detail: string }> {
  // The schema's snake_case keys too: a drag addressed by to_element was
  // resolved here without its destination on the preview path, so its
  // approval could never match the run's.
  action = normalizeAoiBrowserDriveActionKeys(action);
  const hasSource = typeof action.element === 'number';
  const hasDestination = typeof action.toElement === 'number';
  if (!hasSource && !hasDestination) {
    return { ok: true, action };
  }

  // ONE snapshot for both ends of a drag. Capturing twice would let the source
  // resolve against one state of the page and the destination against another,
  // so the pair could describe a layout that never existed at any single moment.
  const snapshot = await captureAoiBrowserDriveSnapshot(page, now);
  // The action is model-authored JSON, and the tool schema spells this
  // snapshot_id while the internal type is snapshotId. Accept either KEY -- a
  // silent miss here would look exactly like a stale ref and make every
  // ref-addressed act mysteriously unusable. The VALUE is still matched
  // strictly.
  const suppliedSnapshotId = action.snapshotId ?? (action as { snapshot_id?: unknown }).snapshot_id;
  // Undefined would silently skip the staleness check, so a ref carrying no
  // snapshot id at all is refused outright.
  const snapshotId = typeof suppliedSnapshotId === 'string' ? suppliedSnapshotId : '';

  const resolveOne = (
    ref: number,
  ): { ok: true; selector: string } | { ok: false; detail: string } => {
    const resolved = resolveAoiBrowserDriveElementRef({ snapshot, ref, snapshotId });
    if (!resolved.ok || !resolved.selector) {
      return {
        ok: false,
        detail: `${resolved.code ?? 'element_ref_unknown'}: ${resolved.detail ?? 'ref did not resolve'}`,
      };
    }
    return { ok: true, selector: resolved.selector };
  };

  // The resolved selectors REPLACE any model-authored ones so nothing
  // downstream can act on a different target than the one that was resolved and
  // approved.
  const next: AoiBrowserDriveActionRequest = { ...action };
  if (hasSource) {
    const resolved = resolveOne(action.element as number);
    if (!resolved.ok) {
      return resolved;
    }
    next.selector = resolved.selector;
  }
  if (hasDestination) {
    const resolved = resolveOne(action.toElement as number);
    if (!resolved.ok) {
      return resolved;
    }
    next.toSelector = resolved.selector;
  }
  return { ok: true, action: next };
}

async function blankPage(page: AoiBrowserDriveActablePage): Promise<void> {
  // Come back to Aoi's own tab FIRST. This is containment for a drive that
  // drifted onto a denied domain, and the drive may be sitting on one of the
  // operator's own tabs -- blanking that would navigate their real page away
  // and lose whatever was on it. Returning to Aoi's tab already achieves what
  // this is for: the drive is no longer on the denied page.
  if (typeof page.returnToOwnTab === 'function') {
    try {
      page.returnToOwnTab();
    } catch {
      // Falling through still blanks something Aoi controls in the common case.
    }
  }
  try {
    await page.goto(BLANK_URL, { waitUntil: 'domcontentloaded', timeout: 5_000 });
  } catch {
    // best-effort blanking; the run stops regardless.
  }
}

async function observe(
  observer: AoiBrowserDriveObserver | undefined,
  ctx: AoiBrowserDriveObserverContext,
): Promise<AoiBrowserDriveObservation | undefined> {
  if (!observer?.onStep) {
    return undefined;
  }
  try {
    const result = await observer.onStep(ctx);
    return result ?? undefined;
  } catch {
    // Audit capture is best-effort and must never block or fail a step.
    return undefined;
  }
}

function toBase64(bytes: Uint8Array): string {
  // Node Buffer is available (server-only module); Buffer extends Uint8Array.
  return Buffer.from(bytes).toString('base64');
}

/**
 * Execute exactly ONE step of an operator-approved plan against the Aoi-driven page.
 * The single-step primitive is the unit the interactive UI drives: propose plan ->
 * human approves plan -> execute step-by-step, each ACT individually approved.
 *
 * Fail-closed at every gate; any non-ok result means the caller must STOP the run.
 */
export async function executeAoiBrowserDriveStep(
  params: AoiBrowserDriveExecuteStepParams,
): Promise<AoiBrowserDriveStepResult> {
  const { page, plan, stepIndex, allowlist, approvalGate } = params;
  const sleep = params.sleep ?? realSleep;
  const timeout = clampTimeout(params.timeoutMs);

  // Both the plan admissibility guard and the per-step forbidden guard are enforced;
  // a forbidden step also makes the plan inadmissible, but the forbidden check runs
  // FIRST so a forbidden action is always reported as forbidden (the strongest stop)
  // and the admissibility guard still catches empty/over-long plans whose target
  // step is itself benign.
  const rawStep = plan?.steps?.[stepIndex];
  // Every read below sees camelCase keys: the act used to read the raw step, so
  // tab_index, to_element, file_path and prompt_text -- the keys the tool schema
  // tells the model to send -- were all ignored and tab, drag, upload and
  // download failed for a model that followed the schema.
  const step = rawStep
    ? { ...rawStep, action: normalizeAoiBrowserDriveActionKeys(rawStep.action) }
    : rawStep;
  if (!step || stepIndex < 0 || stepIndex >= (plan?.steps?.length ?? 0)) {
    return {
      index: stepIndex,
      category: 'forbidden',
      ok: false,
      stopReason: 'step_out_of_range',
      detail: `no step at index ${stepIndex}`,
    };
  }

  // 1) Re-classify THIS action fresh (never trust the plan's cached decision).
  const decision = classifyAoiBrowserDriveAction(step.action);

  // 2) Forbidden -> hard stop. Approval cannot unlock it, and it is checked before
  //    anything else touches the browser.
  if (decision.category === 'forbidden') {
    return {
      index: stepIndex,
      category: 'forbidden',
      ok: false,
      stopReason: 'forbidden',
      detail: decision.reason,
    };
  }

  // 3) Plan admissibility is re-checked at execution time. An inadmissible plan
  //    (empty / too long / contains ANY forbidden step) never touches the browser,
  //    so a forbidden action can never be smuggled in behind benign ones.
  const planClass = classifyAoiBrowserDrivePlan(plan, {
    ...(params.maxPlanSteps ? { maxSteps: params.maxPlanSteps } : {}),
  });
  if (!planClass.admissible) {
    return {
      index: stepIndex,
      category: decision.category,
      ok: false,
      stopReason: 'plan_inadmissible',
      detail: planClass.rejectReasons.join(',') || 'inadmissible',
    };
  }

  // 3.5) Resolve an element ref FIRST, so everything below -- the live-DOM
  //      forbidden re-check, the approval fingerprint, the allowlist -- sees the
  //      concrete target. Resolving later would let an approval be obtained for
  //      one element and spent on another.
  const beforeUrl = safeUrl(page);
  const resolvedRef = await resolveAoiBrowserDriveActionElementRef(page, step.action, params.now);
  if (!resolvedRef.ok) {
    return finish(params.observer, stepIndex, step.action, undefined, {
      index: stepIndex,
      category: decision.category,
      ok: false,
      stopReason: 'action_failed',
      detail: resolvedRef.detail,
      finalUrl: beforeUrl,
      ...(decision.category === 'act'
        ? {
            verdict: classifyAoiBrowserDriveActVerdict({
              kind: step.action.kind,
              ok: false,
              stopReason: 'action_failed',
            }),
          }
        : {}),
    });
  }
  const action = resolvedRef.action;

  // 4) Denylist binding. 'navigate' delegates its own pre/post checks to
  //    navigateAndExtract; every other step acts on the CURRENT page, which must
  //    not be denylisted before we touch it.
  //
  // This runs BEFORE the audit observer. The observer writes a full screenshot
  // and the complete DOM of the current page to disk, so capturing first meant a
  // step refused for being on a denylisted host had already put that page's
  // contents on the operator's disk. The denylist exists to say Aoi may not have
  // that page; recording the refusal is right, keeping a copy of what was
  // refused is not.
  if (action.kind !== 'navigate') {
    const here = isAoiBrowserDriveUrlAllowed(allowlist, beforeUrl);
    if (!here.allowed) {
      // No observation on either side: `finish` would capture an 'after' of the
      // same forbidden page.
      return {
        index: stepIndex,
        category: decision.category,
        ok: false,
        stopReason: 'host_denylisted',
        detail: here.reason,
        finalUrl: deniedUrlOrigin(beforeUrl),
      };
    }
  }

  const before = await observe(params.observer, {
    stepIndex,
    phase: 'before',
    action,
    url: beforeUrl,
  });

  // ACT steps: require per-action approval BEFORE the effect. A denying/erroring
  // gate is fail-closed.
  let approvalFingerprint: string | undefined;
  let approvalViaStanding = false;
  if (decision.category === 'act') {
    // Defense-in-depth against a model that hides a forbidden control by omitting
    // targetText/field: derive the REAL accessible text + field metadata from the
    // live DOM and re-run the (deterministic) forbidden classifier. This matters
    // most on the autonomous standing-grant path, where no human sees the summary.
    // A dialog already up holds the page: say so, rather than wait out a read
    // of the target that it blocks and call the target missing.
    const pending = action.kind === 'dialog' ? null : readPendingDialog(page);
    if (pending !== null) {
      return finish(
        params.observer,
        stepIndex,
        action,
        before,
        dialogPendingRefusal(stepIndex, action, beforeUrl, pending),
      );
    }
    const domCheck = await classifyActFromLiveDom(page, action, 'ask');
    if (domCheck) {
      return finish(
        params.observer,
        stepIndex,
        action,
        before,
        liveDomRefusal(stepIndex, action.kind, domCheck),
      );
    }
    // Bind the approval to the host the act actually lands on (see fingerprint doc).
    approvalFingerprint = computeAoiBrowserDriveActionFingerprint(
      plan.goal,
      stepIndex,
      action,
      hostnameOf(beforeUrl),
      plan.steps.slice(0, stepIndex),
    );
    let verdict: { approved: boolean; reason?: string; viaStanding?: boolean };
    try {
      verdict = await approvalGate({
        fingerprint: approvalFingerprint,
        stepIndex,
        action,
        url: beforeUrl,
      });
    } catch (error) {
      return finish(params.observer, stepIndex, action, before, {
        index: stepIndex,
        category: 'act',
        ok: false,
        stopReason: 'approval_gate_error',
        detail: error instanceof Error ? error.message : String(error),
        approvalFingerprint,
      });
    }
    if (!verdict || verdict.approved !== true) {
      return finish(params.observer, stepIndex, action, before, {
        index: stepIndex,
        category: 'act',
        ok: false,
        stopReason: 'approval_denied',
        detail: verdict?.reason ?? 'not approved',
        approvalFingerprint,
      });
    }
    approvalViaStanding = verdict.viaStanding === true;
  }

  // 5) Execute.
  try {
    if (decision.category === 'read') {
      const readResult = await executeReadStep({
        page,
        action,
        allowlist,
        now: params.now,
        timeout,
        sleep,
      });
      return finish(params.observer, stepIndex, action, before, {
        ...readResult,
        index: stepIndex,
        category: 'read',
      });
    }

    // ACT (approved above). The URL is sampled first so a navigation caused by
    // the act is detectable evidence rather than a guess.
    const urlBefore = safeUrl(page);

    // The approval was for the page as it stood when it was asked for. A gate
    // can take its time and a page can move meanwhile -- onto a denied site, or
    // to another site altogether -- so where the act would land is looked at
    // again, and the target checked again, right before it is touched.
    const landing = isAoiBrowserDriveUrlAllowed(allowlist, urlBefore);
    if (!landing.allowed) {
      // Drift, as after an act: the denied page is not left showing, and the
      // record's 'after' is the blank page rather than a copy of the denied one.
      await blankPage(page);
      return finish(params.observer, stepIndex, action, before, {
        index: stepIndex,
        category: 'act',
        ok: false,
        stopReason: 'drift_to_denylist',
        detail: landing.reason,
        finalUrl: deniedUrlOrigin(urlBefore),
        approvalFingerprint,
        verdict: classifyAoiBrowserDriveActVerdict({
          kind: action.kind,
          ok: false,
          stopReason: 'drift_to_denylist',
        }),
      });
    }
    if (hostnameOf(urlBefore) !== hostnameOf(beforeUrl)) {
      return finish(params.observer, stepIndex, action, before, {
        index: stepIndex,
        category: 'act',
        ok: false,
        stopReason: 'approval_denied',
        detail:
          `the page moved from ${hostnameOf(beforeUrl) || 'nowhere'} to ` +
          `${hostnameOf(urlBefore) || 'nowhere'} after the approval was asked for, and that ` +
          'approval was for the first; nothing was done',
        finalUrl: urlBefore,
        approvalFingerprint,
        verdict: classifyAoiBrowserDriveActVerdict({
          kind: action.kind,
          ok: false,
          stopReason: 'approval_denied',
        }),
      });
    }
    // A dialog waiting for an answer holds the page. An act sent now is lost
    // -- the browser drops input while a dialog is up -- or lands whenever the
    // dialog goes, after this call, with nobody looking. Only answering the
    // dialog gets past one.
    const waiting = action.kind === 'dialog' ? null : readPendingDialog(page);
    if (waiting !== null) {
      return finish(params.observer, stepIndex, action, before, {
        ...dialogPendingRefusal(stepIndex, action, urlBefore, waiting),
        approvalFingerprint,
      });
    }
    // Playwright waits for the target to become actionable -- visible, enabled,
    // still -- for as long as the act timeout allows, and a page can change it
    // meanwhile: a disabled "Continue" that turns into an enabled "Pay now".
    // So wait first, without acting, and judge the target as it then is.
    // One deadline for the whole act: what the wait for the target takes, the
    // act no longer has.
    const actDeadline = Date.now() + timeout;
    if (typeof page.waitForActionable === 'function' && typeof action.selector === 'string') {
      try {
        await page.waitForActionable(action.selector, action.kind, {
          timeout,
          ...(typeof action.toSelector === 'string' ? { toSelector: action.toSelector } : {}),
        });
      } catch (error) {
        return finish(params.observer, stepIndex, action, before, {
          index: stepIndex,
          category: 'act',
          ok: false,
          stopReason: 'action_failed',
          detail: `target_not_ready: ${cleanUntrustedErrorText(
            error instanceof Error ? error.message : String(error),
          )}; nothing was done`,
          finalUrl: safeUrl(page),
          approvalFingerprint,
          verdict: classifyAoiBrowserDriveActVerdict({
            kind: action.kind,
            ok: false,
            stopReason: 'action_failed',
          }),
        });
      }
    }
    const lateCheck = await classifyActFromLiveDom(page, action, 'act', actDeadline - Date.now());
    if (lateCheck) {
      return finish(params.observer, stepIndex, action, before, {
        ...liveDomRefusal(stepIndex, action.kind, lateCheck),
        approvalFingerprint,
      });
    }
    // What the page showed before the act, so the look afterwards can tell what
    // the act changed from what was already there. Only a page that can show
    // its text is looked at; any other is left exactly as before.
    const looking = typeof page.innerText === 'function';
    const textBefore = looking ? await readVisibleText(page) : null;
    const tabsBefore = looking ? await listTabsQuietly(page) : null;
    const acting = executeActStep({
      page,
      action,
      timeout: Math.max(1, actDeadline - Date.now()),
      ...(params.uploadGate ? { uploadGate: params.uploadGate } : {}),
      ...(params.downloadGate ? { downloadGate: params.downloadGate } : {}),
    });
    // Answering a dialog is the one act a showing dialog does not interrupt;
    // every other act started with none up (see above).
    const settledAct =
      action.kind === 'dialog' ? { done: await acting } : await actOrDialog(page, acting);
    // A dialog came up before the act finished. Usually the act raised it, but
    // the page may have raised it first, with the act still waiting to be
    // delivered -- so whether the act went through is not known. There is no
    // read-back to have either way.
    const actInterrupted = 'dialogRaised' in settledAct;
    const actOutcome = 'done' in settledAct ? settledAct.done : {};
    // Judged again as it was about to land, and refused there: nothing was sent.
    if (actOutcome.refused) {
      return finish(params.observer, stepIndex, action, before, {
        ...liveDomRefusal(stepIndex, action.kind, actOutcome.refused),
        approvalFingerprint,
      });
    }

    // Post-act drift: the effect may have navigated onto a denylisted host. If so,
    // blank the tab so blocked content does not persist in the Aoi page, and stop.
    // The look below can find the same thing a moment later, from a redirect.
    let finalUrl = safeUrl(page);
    // The verdict counts a navigation only if it is there the moment the act
    // returns (Playwright waits for one the act started). One that shows up
    // during the look may be the page's own doing; the look reports it.
    const urlRightAfter = finalUrl;
    const post = isAoiBrowserDriveUrlAllowed(allowlist, finalUrl);
    let driftDetail: string | undefined = post.reason;
    let drifted = !post.allowed;
    let afterAct: AoiBrowserDriveAfterAct | undefined;
    if (!drifted && looking) {
      const look = await lookAfterAct({
        page,
        allowlist,
        urlBefore,
        textBefore,
        tabsBefore,
        sleep,
      });
      if ('drift' in look) {
        drifted = true;
        driftDetail = look.drift.reason;
        finalUrl = look.drift.url;
      } else {
        afterAct = actInterrupted ? { ...look.afterAct, actInterrupted: true } : look.afterAct;
        finalUrl = look.afterAct.url;
      }
    }
    if (drifted) {
      await blankPage(page);
      // The act ran: the page moved AFTER it. Contained like any drift, but the
      // act is not reported as one that did nothing, and so is not retried.
      return finish(params.observer, stepIndex, action, before, {
        index: stepIndex,
        category: 'act',
        ok: false,
        stopReason: 'drift_after_act',
        detail: driftDetail,
        // Where it went, to the origin: the rest of a denied page's address can
        // carry what the denylist exists to keep away (tokens, names, ids).
        finalUrl: deniedUrlOrigin(finalUrl),
        approvalFingerprint,
        verdict: DRIFT_AFTER_ACT_VERDICT,
      });
    }
    return finish(params.observer, stepIndex, action, before, {
      index: stepIndex,
      category: 'act',
      // Transport success only. What can actually be proven is in `verdict`.
      ok: true,
      finalUrl,
      approvalFingerprint,
      ...(approvalViaStanding ? { approvalViaStanding: true } : {}),
      verdict: classifyAoiBrowserDriveActVerdict({
        kind: action.kind,
        ok: true,
        urlBefore,
        // An act a dialog beat back may never have landed, so a URL that moved
        // meanwhile is not its doing to claim.
        urlAfter: actInterrupted ? urlBefore : urlRightAfter,
        ...(actOutcome.readBack ? { readBack: actOutcome.readBack } : {}),
        ...(actOutcome.unsettled ? { unsettled: true } : {}),
      }),
      ...(afterAct ? { afterAct } : {}),
    });
  } catch (error) {
    const detail = cleanUntrustedErrorText(error instanceof Error ? error.message : String(error));
    // An act that threw can still have landed somewhere denied first: a click
    // that redirected, then a download that never came. Contained, and its
    // address cut to the origin, like any drift -- and not to be repeated.
    const landedOn = safeUrl(page);
    if (decision.category === 'act' && !isAoiBrowserDriveUrlAllowed(allowlist, landedOn).allowed) {
      await blankPage(page);
      return finish(params.observer, stepIndex, action, before, {
        index: stepIndex,
        category: 'act',
        ok: false,
        stopReason: 'drift_after_act',
        detail,
        finalUrl: deniedUrlOrigin(landedOn),
        ...(approvalFingerprint ? { approvalFingerprint } : {}),
        verdict: DRIFT_AFTER_ACT_VERDICT,
      });
    }
    return finish(params.observer, stepIndex, action, before, {
      index: stepIndex,
      category: decision.category,
      ok: false,
      stopReason: 'action_failed',
      detail,
      ...(approvalFingerprint ? { approvalFingerprint } : {}),
      finalUrl: landedOn,
      ...(decision.category === 'act'
        ? {
            verdict: classifyAoiBrowserDriveActVerdict({
              kind: action.kind,
              ok: false,
              stopReason: 'action_failed',
            }),
          }
        : {}),
    });
  }
}

// The act was delivered, or may have been, before the page moved onto a denied
// site. Not proof of anything -- and not permission to send it again.
const DRIFT_AFTER_ACT_VERDICT: AoiBrowserDriveVerdict = {
  effect: 'unverifiable',
  verified: false,
  code: 'drift_after_act',
  escalation: {
    recommended: 'stop',
    reason:
      'the act was carried out, or may have been, and then the page moved to a denied site, ' +
      'which was closed; do not repeat the act',
  },
};

// What a step that waits on a page showing a dialog is told.
function dialogPendingDetail(dialog: PendingDialog, refused: string): string {
  return dialog.unanswerable
    ? `dialog_pending: the page is showing a dialog the browser connection cannot answer, so ${refused}; ` +
        'navigate or go back to close it'
    : `dialog_pending: the page is showing a dialog nobody has answered, so ${refused}; ` +
        'answer it with a dialog step first';
}

function dialogPendingRefusal(
  stepIndex: number,
  action: AoiBrowserDriveActionRequest,
  url: string,
  dialog: PendingDialog,
): AoiBrowserDriveStepResult {
  return {
    index: stepIndex,
    category: 'act',
    ok: false,
    stopReason: 'action_failed',
    detail: dialogPendingDetail(dialog, 'the act was not sent'),
    finalUrl: url,
    verdict: classifyAoiBrowserDriveActVerdict({
      kind: action.kind,
      ok: false,
      stopReason: 'action_failed',
    }),
  };
}

function safeUrl(page: AoiBrowserDriveActablePage): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

// ---- After an act: look again ----

// How long the page is given before each look. Most pages answer within a frame
// or two; the second look -- only taken when the first saw nothing change -- is
// for a slower one.
const AFTER_ACT_SETTLE_MS: readonly number[] = [300, 700];
// A navigation the act started gets this long to load before the page is read.
const AFTER_ACT_LOAD_TIMEOUT_MS = 3_000;
// All the look gets: a page that never finishes loading is reported as it
// stands, not waited on read after read.
const AFTER_ACT_BUDGET_MS = 3_000;
const VISIBLE_TEXT_READ_TIMEOUT_MS = 2_000;
const MAX_VISIBLE_TEXT_CHARS = 200_000;
const AFTER_ACT_LINES_LIMIT = 12;
const AFTER_ACT_LINE_CHARS = 200;

type AoiBrowserDriveTabListing = {
  index: number;
  url: string;
  title: string;
  current: boolean;
  id?: number;
}[];

// The tabs in `after` that were not in `before`. By identity when the listing
// carries one: counting positions called the wrong tab new whenever one closed
// while another opened, and missed the new one entirely when the count stayed.
function newTabs(
  before: AoiBrowserDriveTabListing,
  after: AoiBrowserDriveTabListing,
): AoiBrowserDriveTabListing {
  const identified = [...before, ...after].every((tab) => typeof tab.id === 'number');
  if (identified) {
    const seen = new Set(before.map((tab) => tab.id));
    return after.filter((tab) => !seen.has(tab.id));
  }
  return after.length > before.length ? after.slice(before.length) : [];
}

// A denied page's address, cut to its origin -- or nothing, when it is not one.
function deniedUrlOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? '' : parsed.origin;
  } catch {
    return '';
  }
}

// Resolves null rather than hanging: a page can stall a read (a dialog opening
// mid-read holds its script), and the act has already happened by then.
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline(null), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function readPendingDialog(page: AoiBrowserDriveActablePage): PendingDialog | null {
  try {
    return page.pendingDialog?.() ?? null;
  } catch {
    return null;
  }
}

// How often an act in flight is checked for a dialog it raised.
const DIALOG_POLL_MS = 50;

/**
 * Wait for an act, or for the dialog it raised -- whichever shows first.
 *
 * A native dialog blocks the page, and Playwright does not let the action that
 * raised it finish until the dialog is answered, which nothing can do within
 * the same call. So a click that opened a confirm sat out the whole act timeout
 * and came back as a failed click, when it had landed and the page was asking a
 * question. Now the wait ends when a dialog shows, and the look after the act
 * says what it asked. The caller only asks this for an act that started with
 * no dialog up: one already waiting would make every act look like it raised it.
 */
async function actOrDialog<T>(
  page: AoiBrowserDriveActablePage,
  work: Promise<T>,
  // The dialog already waiting when the work began: not one it raised.
  waiting: PendingDialog | null = null,
): Promise<{ done: T } | { dialogRaised: true }> {
  if (typeof page.pendingDialog !== 'function') {
    return { done: await work };
  }
  // The poll stops itself when it finds a dialog, and `finally` cancels it when
  // the act settles first -- in the same turn, so no check runs after either.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = work.then((value) => ({ done: value }));
  const dialogShown = new Promise<{ dialogRaised: true }>((resolveDialog) => {
    const check = () => {
      const showing = readPendingDialog(page);
      if (showing && showing !== waiting) {
        resolveDialog({ dialogRaised: true });
        return;
      }
      timer = setTimeout(check, DIALOG_POLL_MS);
    };
    timer = setTimeout(check, DIALOG_POLL_MS);
  });
  try {
    return await Promise.race([finished, dialogShown]);
  } finally {
    clearTimeout(timer);
    // The act stays pending on the dialog until the session dismisses it.
    // Nothing waits for it any more, so its eventual failure goes nowhere.
    finished.catch(() => undefined);
  }
}

interface VisibleText {
  text: string;
  // Longer than what is compared; `text` ends at the last whole line within it.
  truncated: boolean;
}

// What the page shows, as innerText reads it. Text inside a shadow root is not
// part of it (innerText walks the page's own children), so a change made only
// inside a web component's shadow tree does not show here -- one reason "the
// text did not change" is never proof that nothing did.
async function readVisibleText(
  page: AoiBrowserDriveActablePage,
  timeout = VISIBLE_TEXT_READ_TIMEOUT_MS,
): Promise<VisibleText | null> {
  if (typeof page.innerText !== 'function' || readPendingDialog(page)) {
    return null;
  }
  try {
    const text = await withDeadline(page.innerText('body', { timeout }), timeout + 500);
    if (typeof text !== 'string') {
      return null;
    }
    if (text.length <= MAX_VISIBLE_TEXT_CHARS) {
      return { text, truncated: false };
    }
    // Cut at a line end: half a line, cut somewhere else the next time, would
    // read as a line that changed.
    const kept = text.slice(0, MAX_VISIBLE_TEXT_CHARS);
    const lastBreak = kept.lastIndexOf('\n');
    return { text: lastBreak > 0 ? kept.slice(0, lastBreak) : kept, truncated: true };
  } catch {
    return null;
  }
}

// Listing reads every tab's title, and a tab held by a dialog cannot answer
// that until the dialog is gone -- measured against Chrome: the call waited for
// the dialog's 30 s dismissal. So no listing while one is up, and a deadline.
const TAB_LISTING_TIMEOUT_MS = 2_000;

async function listTabsQuietly(
  page: AoiBrowserDriveActablePage,
): Promise<AoiBrowserDriveTabListing | null> {
  if (typeof page.listTabs !== 'function' || readPendingDialog(page)) {
    return null;
  }
  try {
    return await withDeadline(page.listTabs(), TAB_LISTING_TIMEOUT_MS);
  } catch {
    return null;
  }
}

function visibleTextLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

/**
 * The lines of visible text that appeared and went away between two reads of a
 * page. Counted, so a second identical line is still news.
 */
export function diffAoiBrowserDriveVisibleText(
  before: string,
  after: string,
): { appeared: string[]; gone: string[]; reordered: boolean } {
  const beforeLines = visibleTextLines(before);
  const afterLines = visibleTextLines(after);
  const unmatched = new Map<string, number>();
  for (const line of beforeLines) {
    unmatched.set(line, (unmatched.get(line) ?? 0) + 1);
  }
  const appeared: string[] = [];
  for (const line of afterLines) {
    const left = unmatched.get(line) ?? 0;
    if (left > 0) {
      unmatched.set(line, left - 1);
    } else {
      appeared.push(line);
    }
  }
  const gone: string[] = [];
  for (const line of beforeLines) {
    const left = unmatched.get(line) ?? 0;
    if (left > 0) {
      gone.push(line);
      unmatched.set(line, left - 1);
    }
  }
  // Nothing came or went, so both hold the same lines; any position that
  // differs means they moved.
  const reordered =
    appeared.length === 0 &&
    gone.length === 0 &&
    beforeLines.some((line, index) => line !== afterLines[index]);
  return { appeared, gone, reordered };
}

function clampLines(lines: string[]): { lines: string[]; omitted: number } {
  const kept = lines
    .slice(0, AFTER_ACT_LINES_LIMIT)
    .map((line) =>
      line.length > AFTER_ACT_LINE_CHARS ? `${line.slice(0, AFTER_ACT_LINE_CHARS)}...` : line,
    );
  return { lines: kept, omitted: lines.length - kept.length };
}

/**
 * Give the page a moment after an act, then read it again. The denylist is
 * checked before anything is read and again after: a redirect that lands on a
 * refused page during the wait is drift, and its text is never kept.
 */
async function lookAfterAct(params: {
  page: AoiBrowserDriveActablePage;
  allowlist: AoiBrowserDriveAllowlist | null | undefined;
  urlBefore: string;
  textBefore: VisibleText | null;
  tabsBefore: AoiBrowserDriveTabListing | null;
  sleep: (ms: number) => Promise<void>;
}): Promise<{ drift: { url: string; reason?: string } } | { afterAct: AoiBrowserDriveAfterAct }> {
  const { page, allowlist, urlBefore, textBefore } = params;
  let waitedMs = 0;
  let url = urlBefore;
  let text: VisibleText | null = null;
  let dialog: { type: string; message: string } | null = null;
  const lookDeadline = Date.now() + AFTER_ACT_BUDGET_MS;
  const left = () => Math.max(1, lookDeadline - Date.now());
  for (const [round, delay] of AFTER_ACT_SETTLE_MS.entries()) {
    // A second look only while there is time for one.
    if (round > 0 && lookDeadline - Date.now() < delay) {
      break;
    }
    await params.sleep(delay);
    waitedMs += delay;
    url = safeUrl(page);
    if (url !== urlBefore && typeof page.waitForLoadState === 'function') {
      await withDeadline(
        page
          .waitForLoadState('domcontentloaded', {
            timeout: Math.min(AFTER_ACT_LOAD_TIMEOUT_MS, left()),
          })
          .catch(() => undefined),
        Math.min(AFTER_ACT_LOAD_TIMEOUT_MS, left()) + 500,
      );
      url = safeUrl(page);
    }
    const here = isAoiBrowserDriveUrlAllowed(allowlist, url);
    if (!here.allowed) {
      return { drift: { url, reason: here.reason } };
    }
    dialog = readPendingDialog(page);
    text = dialog
      ? null
      : await readVisibleText(page, Math.min(VISIBLE_TEXT_READ_TIMEOUT_MS, left()));
    const after = safeUrl(page);
    const still = isAoiBrowserDriveUrlAllowed(allowlist, after);
    if (!still.allowed) {
      return { drift: { url: after, reason: still.reason } };
    }
    url = after;
    const answered =
      dialog !== null ||
      url !== urlBefore ||
      (text !== null && textBefore !== null && text.text !== textBefore.text);
    if (answered) {
      break;
    }
  }

  const diff =
    text !== null && textBefore !== null
      ? diffAoiBrowserDriveVisibleText(textBefore.text, text.text)
      : null;
  const truncated = diff !== null && (textBefore?.truncated === true || text?.truncated === true);
  const appeared = clampLines(diff?.appeared ?? []);
  const gone = clampLines(diff?.gone ?? []);
  const tabsAfter = params.tabsBefore ? await listTabsQuietly(page) : null;
  const opened =
    params.tabsBefore && tabsAfter
      ? redactDenylistedTabs(newTabs(params.tabsBefore, tabsAfter), allowlist).map(
          ({ index, url: tabUrl, title, denylisted }) => ({
            index,
            url: tabUrl,
            title,
            ...(denylisted ? { denylisted } : {}),
          }),
        )
      : [];
  return {
    afterAct: {
      waitedMs,
      url,
      urlChanged: url !== urlBefore,
      textRead: diff !== null,
      textAppeared: appeared.lines,
      textGone: gone.lines,
      ...(appeared.omitted > 0 ? { textAppearedOmitted: appeared.omitted } : {}),
      ...(gone.omitted > 0 ? { textGoneOmitted: gone.omitted } : {}),
      ...(diff?.reordered ? { textReordered: true as const } : {}),
      ...(truncated ? { textTruncated: true as const } : {}),
      ...(opened.length > 0 ? { tabsOpened: opened } : {}),
      ...(dialog ? { dialog } : {}),
    },
  };
}

// Attach the 'after' observation to a completed step result (best-effort).
async function finish(
  observer: AoiBrowserDriveObserver | undefined,
  stepIndex: number,
  action: AoiBrowserDriveActionRequest,
  before: AoiBrowserDriveObservation | undefined,
  result: AoiBrowserDriveStepResult,
): Promise<AoiBrowserDriveStepResult> {
  const after = await observe(observer, {
    stepIndex,
    phase: 'after',
    action,
    url: result.finalUrl ?? '',
  });
  if (before || after) {
    result.observation = {
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    };
  }
  return result;
}

// A read step's execution outcome (subset of a step result; `ok` is required so it
// can be spread into a full step result without losing the discriminant).
interface AoiBrowserDriveReadStepOutcome {
  ok: boolean;
  stopReason?: AoiBrowserDriveStepStopReason;
  detail?: string;
  finalUrl?: string;
  extract?: AoiBrowserDriveReadResult;
  screenshotBase64?: string;
  snapshot?: AoiBrowserDriveSnapshot;
  // Tabs in this browser context, from a `tabs` step.
  tabs?: { index: number; url: string; title: string; current: boolean }[];
  // Set when a `tab` step changed which page is current. Every ref and selector
  // from the previous tab describes a different document now.
  tabSwitched?: boolean;
}

// A denylisted tab is listed (its index still exists) but not described: its
// address and title are exactly what the denylist says Aoi may not have.
// A blank tab is not a page anyone wrote; every other non-web scheme (chrome://
// settings and password pages among them) stays refused like a denied host.
function isTabUrlAllowed(allowlist: AoiBrowserDriveAllowlist | null | undefined, url: string) {
  if (url === 'about:blank' || url.startsWith('about:blank#')) {
    return { allowed: true as const, reason: '' };
  }
  return isAoiBrowserDriveUrlAllowed(allowlist, url);
}

export function redactDenylistedTabs(
  tabs: { index: number; url: string; title: string; current: boolean; id?: number }[],
  allowlist: AoiBrowserDriveAllowlist | null | undefined,
): { index: number; url: string; title: string; current: boolean; denylisted?: true }[] {
  return tabs.map((tab) =>
    isTabUrlAllowed(allowlist, tab.url).allowed
      ? { index: tab.index, url: tab.url, title: tab.title, current: tab.current }
      : { index: tab.index, url: '', title: '', current: tab.current, denylisted: true },
  );
}

// Navigating moves a page away from what it showed. On Aoi's own tab that is
// the job; on one of the operator's tabs it throws away whatever they had there
// -- a half-written message, a filled-in form.
function refuseOffOwnTab(
  page: AoiBrowserDriveActablePage,
  kind: string,
): AoiBrowserDriveReadStepOutcome | null {
  if (typeof page.isOnOwnTab !== 'function' || page.isOnOwnTab()) {
    return null;
  }
  return {
    ok: false,
    stopReason: 'action_failed',
    detail:
      `not_own_tab: ${kind} only runs on the tab Aoi opened, never on one of the operator's ` +
      'own tabs; switch back with a tab step first',
    finalUrl: safeUrl(page),
  };
}

// A page that asks something as it loads holds its load until it is answered:
// the step got the tab where it went -- or onto a denied site, which is closed
// as any drift is -- and the page there is waiting for an answer. Repeating the
// step would leave the page it is on.
async function askedWhileLoading(
  page: AoiBrowserDriveActablePage,
  allowlist: AoiBrowserDriveAllowlist | null | undefined,
  kind: 'navigate' | 'back',
): Promise<AoiBrowserDriveReadStepOutcome> {
  const finalUrl = safeUrl(page);
  const here = isAoiBrowserDriveUrlAllowed(allowlist, finalUrl);
  if (!here.allowed) {
    await blankPage(page);
    return {
      ok: false,
      stopReason: 'drift_to_denylist',
      detail: here.reason,
      finalUrl: deniedUrlOrigin(finalUrl),
    };
  }
  const kindOfDialog = readPendingDialog(page)?.type ?? 'dialog';
  return {
    ok: false,
    stopReason: 'action_failed',
    detail:
      `dialog_raised: ${/^[aeiou]/i.test(kindOfDialog) ? 'an' : 'a'} ${kindOfDialog} came up while the step ` +
      `${kind === 'back' ? 'went back' : 'navigated'}, and the page is waiting for an answer; ` +
      `answer it with a dialog step -- another ${kind} would leave the page it is on`,
    finalUrl,
  };
}

// The reads a dialog showing on the page holds up.
const PAGE_HELD_READS: ReadonlySet<string> = new Set([
  'extract',
  'elements',
  'scroll',
  'screenshot',
]);

async function executeReadStep(params: {
  page: AoiBrowserDriveActablePage;
  action: AoiBrowserDriveActionRequest;
  allowlist: AoiBrowserDriveAllowlist | null | undefined;
  now: number;
  timeout: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<AoiBrowserDriveReadStepOutcome> {
  const { page, action, allowlist } = params;
  // A dialog waiting for an answer holds the page: a read of it, or a scroll,
  // waits as long as the dialog does -- until it is answered, or let go when no
  // one does -- and gives nothing meanwhile.
  if (PAGE_HELD_READS.has(action.kind)) {
    const showing = readPendingDialog(page);
    if (showing !== null) {
      return {
        ok: false,
        stopReason: 'action_failed',
        detail: dialogPendingDetail(showing, 'the page was not read'),
        finalUrl: safeUrl(page),
      };
    }
  }
  switch (action.kind) {
    case 'navigate': {
      const offTab = refuseOffOwnTab(page, 'navigate');
      if (offTab) {
        return offTab;
      }
      // What waits already is not what the load raises: read before it begins.
      const waiting = readPendingDialog(page);
      const navigated = await actOrDialog(
        page,
        navigateAndExtractAoiBrowserDrive({
          page,
          allowlist,
          url: action.url ?? '',
          now: params.now,
          timeoutMs: params.timeout,
        }),
        waiting,
      );
      if ('dialogRaised' in navigated) {
        return askedWhileLoading(page, allowlist, 'navigate');
      }
      const outcome = navigated.done;
      if (!outcome.ok) {
        return {
          ok: false,
          stopReason:
            outcome.reason === 'url_denylisted' || outcome.reason === 'url_not_allowlisted'
              ? 'host_denylisted'
              : outcome.reason === 'drift_to_denylist' || outcome.reason === 'drift_off_allowlist'
                ? 'drift_to_denylist'
                : 'action_failed',
          detail: outcome.detail,
          finalUrl: safeUrl(page),
        };
      }
      return { ok: true, finalUrl: outcome.finalUrl, extract: outcome };
    }
    case 'extract': {
      const html = await pageContentInTime(page);
      if (html === null) {
        throw new Error('the page did not give its document in time');
      }
      const finalUrl = safeUrl(page);
      const extracted = extractAoiHostBrowserReadable(html, finalUrl);
      let title = '';
      try {
        title = (await page.title()).trim();
      } catch {
        // best-effort; extractor supplies a fallback title
      }
      return {
        ok: true,
        finalUrl,
        extract: {
          ok: true,
          url: finalUrl,
          finalUrl,
          hostname: hostnameOf(finalUrl),
          title: title || extracted.title,
          excerpt: extracted.excerpt,
          siteName: extracted.siteName,
          blocks: extracted.blocks,
          text: extracted.text,
          sampledAt: params.now,
        },
      };
    }
    case 'back': {
      const offTab = refuseOffOwnTab(page, 'back');
      if (offTab) {
        return offTab;
      }
      const waiting = readPendingDialog(page);
      const back = await actOrDialog(
        page,
        page.goBack({ waitUntil: 'domcontentloaded', timeout: params.timeout }),
        waiting,
      );
      if ('dialogRaised' in back) {
        return askedWhileLoading(page, allowlist, 'back');
      }
      const finalUrl = safeUrl(page);
      const post = isAoiBrowserDriveUrlAllowed(allowlist, finalUrl);
      if (!post.allowed) {
        await blankPage(page);
        return {
          ok: false,
          stopReason: 'drift_to_denylist',
          detail: post.reason,
          finalUrl: deniedUrlOrigin(finalUrl),
        };
      }
      return { ok: true, finalUrl };
    }
    case 'elements': {
      const snapshot = await captureAoiBrowserDriveSnapshot(page, params.now);
      return {
        ok: true,
        finalUrl: safeUrl(page),
        snapshot,
      };
    }
    case 'scroll': {
      const delta = action.value === 'up' ? -DEFAULT_SCROLL_DELTA : DEFAULT_SCROLL_DELTA;
      await page.mouse.wheel(0, delta);
      return { ok: true, finalUrl: safeUrl(page) };
    }
    case 'screenshot': {
      const bytes = await page.screenshot({ timeout: params.timeout });
      return { ok: true, finalUrl: safeUrl(page), screenshotBase64: toBase64(bytes) };
    }
    case 'tabs': {
      if (typeof page.listTabs !== 'function') {
        throw new Error('this browser session cannot list tabs');
      }
      return {
        ok: true,
        finalUrl: safeUrl(page),
        tabs: redactDenylistedTabs(await page.listTabs(), allowlist),
      };
    }
    case 'tab': {
      if (typeof page.selectTab !== 'function' || typeof page.listTabs !== 'function') {
        throw new Error('this browser session cannot switch tabs');
      }
      const index = typeof action.tabIndex === 'number' ? action.tabIndex : Number.NaN;
      if (!Number.isInteger(index) || index < 0) {
        throw new Error('tab requires a tabIndex from a tabs listing');
      }
      await page.selectTab(index);

      // Confirm the switch actually took, by reading back which tab is current.
      //
      // This is the one failure here that would be silent AND wrong: every later
      // step in the plan goes through this same `page`, so a selectTab that did
      // not really redirect it leaves the model believing it is driving the new
      // tab while every click lands on the old one. That is worse than an
      // error -- it is an action on a page nobody chose. A verified switch or a
      // refusal; nothing in between.
      const tabs = await page.listTabs();
      const current = tabs.find((tab) => tab.current);
      if (!current || current.index !== index) {
        throw new Error(
          `tab switch did not take effect (asked for ${index}, still on ${
            current ? current.index : 'unknown'
          })`,
        );
      }
      // The denylist binds tabs too. Switching onto one was how a plan reached a
      // denied host without ever navigating to it -- and every later step,
      // including the audit capture, would then read that page.
      const here = isTabUrlAllowed(allowlist, current.url);
      if (!here.allowed) {
        if (typeof page.returnToOwnTab === 'function') {
          try {
            page.returnToOwnTab();
          } catch {
            // The step is refused either way.
          }
        }
        return {
          ok: false,
          stopReason: 'host_denylisted',
          detail: here.reason,
          finalUrl: safeUrl(page),
          tabs: redactDenylistedTabs(tabs, allowlist),
        };
      }
      // Everything addressed on the old tab is meaningless on the new one, and
      // the caller has to be told rather than left to discover it by acting.
      return {
        ok: true,
        finalUrl: safeUrl(page),
        tabs: redactDenylistedTabs(tabs, allowlist),
        tabSwitched: true,
      };
    }
    case 'wait': {
      const requested = Number.parseInt(action.value ?? '', 10);
      const ms = Number.isFinite(requested)
        ? Math.min(MAX_WAIT_MS, Math.max(0, requested))
        : DEFAULT_WAIT_MS;
      await params.sleep(ms);
      return { ok: true, finalUrl: safeUrl(page) };
    }
    default:
      // Unreachable: classifier maps any non-read kind out of this path.
      return {
        ok: false,
        stopReason: 'action_failed',
        detail: `unhandled read kind: ${action.kind}`,
      };
  }
}

// Read one value straight back off the live element. Best-effort by design:
// any throw/timeout/absent element yields null, which the verdict reads as
// "could not verify" rather than as failure.
async function readBackValue(
  page: AoiBrowserDriveActablePage,
  selector: string,
  timeout: number,
): Promise<string | null> {
  // Property, never the attribute. `getAttribute('value')` returns the markup's
  // initial value, which fill() does not change: comparing against it reports a
  // perfectly good type as a suspected no-op, and in a multi-act task that halts
  // the run. With no inputValue available the honest answer is "unverifiable",
  // not a comparison against the wrong thing.
  if (typeof page.inputValue !== 'function') {
    return null;
  }
  try {
    return await page.inputValue(selector, { timeout });
  } catch {
    return null;
  }
}

// Runs the act and returns whatever can be proven about it. The write kinds
// read their value back off the page; the rest carry no read-back, and the
// verdict falls to navigation evidence or to `unverifiable`.
async function executeActStep(params: {
  page: AoiBrowserDriveActablePage;
  action: AoiBrowserDriveActionRequest;
  timeout: number;
  uploadGate?: AoiBrowserDriveUploadGate;
  downloadGate?: AoiBrowserDriveUploadGate;
}): Promise<{
  readBack?: { expected: string; actual: string | null };
  dialogMessage?: string;
  downloadedTo?: string;
  // The act was judged again as it was about to land, and refused: nothing was
  // sent.
  refused?: LiveDomCheck;
  // The act went out, and the page was still busy with it when its wait ran
  // out.
  unsettled?: true;
}> {
  const { page, action, timeout } = params;

  // A dialog is answered on the PAGE, not on an element -- there is no element
  // to name while a native dialog is up.
  if (action.kind === 'dialog') {
    if (typeof page.answerDialog !== 'function') {
      throw new Error('this browser session cannot answer dialogs');
    }
    const disposition = (action.disposition ?? '').trim().toLowerCase();
    if (disposition !== 'accept' && disposition !== 'dismiss') {
      throw new Error('dialog requires disposition "accept" or "dismiss"');
    }
    // Judged again as it is answered, and only the dialog judged is: one the
    // page raised in its place -- once the one read was let go, or as the tab
    // moved on -- asks something nobody has read.
    let read: string | undefined;
    if (disposition === 'accept') {
      const judged = judgeShowingDialog(page, action);
      if ('check' in judged) {
        return { refused: judged.check };
      }
      read = judged.message;
    }
    // Bound the wait. A dialog is answered through an event, so "no dialog is
    // showing" looks identical to "one has not appeared yet" -- and an
    // implementation that simply never resolves would hang the whole run with
    // no step, no verdict and no way to tell what happened. A timeout turns that
    // into an ordinary reportable failure.
    const message = await Promise.race([
      page.answerDialog(disposition, action.promptText, {
        ...(read !== undefined ? { read } : {}),
        timeoutMs: timeout,
      }),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no dialog appeared to answer')), timeout);
        // Do not hold the process open on a timer that lost the race.
        if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
          (timer as { unref: () => void }).unref();
        }
      }),
    ]);
    // The message is evidence of WHAT was answered, which matters more here
    // than for other acts: the model chose a disposition before seeing it.
    return { dialogMessage: typeof message === 'string' ? message : '' };
  }

  const selector = typeof action.selector === 'string' ? action.selector : '';
  if (!selector) {
    throw new Error(`action ${action.kind} requires a selector`);
  }
  switch (action.kind) {
    case 'hover':
      if (typeof page.hover !== 'function') {
        throw new Error('this browser session cannot hover');
      }
      await page.hover(selector, { timeout });
      return {};
    case 'drag': {
      if (typeof page.dragAndDrop !== 'function') {
        throw new Error('this browser session cannot drag');
      }
      const target = typeof action.toSelector === 'string' ? action.toSelector : '';
      if (!target) {
        throw new Error('drag requires a destination');
      }
      await page.dragAndDrop(selector, target, { timeout });
      return {};
    }
    case 'download': {
      if (typeof page.downloadTo !== 'function') {
        throw new Error('this browser session cannot save downloads');
      }
      const directory = typeof action.filePath === 'string' ? action.filePath : '';
      if (!directory) {
        throw new Error('download requires a destination directory');
      }
      // Same shape as upload and the same reason: a page influences the plan,
      // and this one writes to disk. Fail closed without a gate.
      const verdict = params.downloadGate
        ? params.downloadGate(directory)
        : { allowed: false, reason: 'downloads are not enabled for this session' };
      if (!verdict.allowed) {
        throw new Error(`download refused: ${verdict.reason}`);
      }
      const saved = await page.downloadTo(selector, directory, { timeout });
      // A path read back off the completed download is real evidence, unlike a
      // click that merely did not throw.
      return {
        readBack: {
          expected: directory,
          actual: typeof saved?.path === 'string' ? saved.path : null,
        },
        downloadedTo: typeof saved?.path === 'string' ? saved.path : '',
      };
    }
    case 'upload': {
      if (typeof page.setInputFiles !== 'function') {
        throw new Error('this browser session cannot attach files');
      }
      const filePath = typeof action.filePath === 'string' ? action.filePath : '';
      if (!filePath) {
        throw new Error('upload requires filePath');
      }
      // Fail closed: no gate means no upload, not a free one.
      const verdict = params.uploadGate
        ? params.uploadGate(filePath)
        : { allowed: false, reason: 'uploads are not enabled for this session' };
      if (!verdict.allowed) {
        throw new Error(`upload refused: ${verdict.reason}`);
      }
      await page.setInputFiles(selector, filePath, { timeout });
      return {};
    }
    case 'click':
      return clickJudgedAsItLands(page, action, selector, timeout);
    case 'type': {
      const expected = action.text ?? action.value ?? '';
      const refused = await fillWhereFocusLands(page, action, selector, expected, timeout);
      if (refused) {
        return { refused };
      }
      return { readBack: { expected, actual: await readBackValue(page, selector, timeout) } };
    }
    case 'select': {
      const expected = action.value ?? '';
      await page.selectOption(selector, expected, { timeout });
      return { readBack: { expected, actual: await readBackValue(page, selector, timeout) } };
    }
    case 'press': {
      // The key the classifier judged; a press without a usable one was refused.
      const key = aoiBrowserDrivePressKey(action) ?? 'Enter';
      return pressWhereFocusLands(page, action, selector, key, timeout);
    }
    case 'submit':
      // A form submit is triggered by activating its submit control.
      return clickJudgedAsItLands(page, action, selector, timeout);
    default:
      throw new Error(`unhandled act kind: ${action.kind}`);
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// Read one DOM string best-effort: any throw/timeout/absent element -> ''.
function safeDomRead(read: () => Promise<string | null>): Promise<string> {
  return Promise.resolve()
    .then(read)
    .then((value) => (typeof value === 'string' ? value : ''))
    .catch(() => '');
}

// Read one DOM string the check cannot do without: null when the read threw or
// timed out -- the element was not there to be read -- where an element with
// nothing in it, or without the attribute, reads as ''.
function requiredDomRead(read: () => Promise<string | null>): Promise<string | null> {
  return Promise.resolve()
    .then(read)
    .then((value) => (typeof value === 'string' ? value : ''))
    .catch(() => null);
}

// The reads AROUND a target -- the control a label labels, the form a field
// submits, that form's buttons -- usually find nothing, and nothing is the
// answer: each is made only of an element the page has counted there, so its
// wait is for a busy page to answer, not for an element to turn up. On a page
// of a hundred thousand elements every read waits its turn.
const DOM_LOOKAROUND_TIMEOUT_MS = 2_000;
// How much of one element's words the hard-block reads, at its start and at its
// end. Enter in a form with no submit button submits the form itself, so the
// form says what it commits the same way.
const MAX_TARGET_WORDS_CHARS = 300;

// The page names an element by an id no selector can spell (a NUL, which CSS
// reads as U+FFFD): what that element is cannot be checked, so the act is not
// done.
class UnreachableTargetError extends Error {}

// A value inside an XPath expression. XPath 1.0 has no escapes: a value with
// one kind of quote goes inside the other, and one with both is spelled with
// concat(). Two characters cannot be spelled at all. A NUL. And a backslash:
// Playwright's selector parser reads one as an escape wherever it stands, so
// one before a closing quote would carry the rest of the selector into the
// string.
function xpathString(value: string): string {
  if (value.includes('\0') || value.includes('\\')) {
    throw new UnreachableTargetError('the page names an element by an id no selector can reach');
  }
  if (!value.includes('"')) {
    return `"${value}"`;
  }
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  return `concat(${value
    .split('"')
    .map((part) => `"${part}"`)
    .join(`,'"',`)})`;
}

// ---- The element an act really reaches ----
//
// A selector names an element; the act can land on another. Playwright's fill,
// selectOption and setInputFiles retarget a label to the control it labels; a
// click on a label, or on an icon inside a button, activates that control; a key
// pressed "on" an element that cannot take focus goes to whatever has focus. The
// hard-blocks judge what is REACHED, so those elements are read too -- through
// selector chains, which Playwright evaluates in its own isolated world: the
// page's scripts cannot change what these reads report. Every chain starts at
// the selector's FIRST match, the one Playwright acts on, and never at another
// element the selector also matches.

const ALPHABET_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALPHABET_LOWER = 'abcdefghijklmnopqrstuvwxyz';
// XPath compares attribute values exactly; HTML's enumerated ones do not care
// about case.
const lowered = (attribute: string) =>
  `translate(${attribute},'${ALPHABET_UPPER}','${ALPHABET_LOWER}')`;
const TYPE_LOWER = lowered('@type');
// An element of one of these names, in any namespace. XPath's plain name test
// matches an HTML document's elements, and none of an XHTML document's: those
// are in the XHTML namespace, and "input" there would miss every input.
const named = (...names: string[]) =>
  `(${names.map((name) => `local-name()="${name}"`).join(' or ')})`;
const BUTTONISH_INPUT = `${TYPE_LOWER}="submit" or ${TYPE_LOWER}="image" or ${TYPE_LOWER}="button" or ${TYPE_LOWER}="reset"`;
const CHOICE_INPUT = `${TYPE_LOWER}="checkbox" or ${TYPE_LOWER}="radio"`;
// An href, plain or SVG 1.1's xlink:href.
const HREF = '@*[local-name()="href"]';
const CONTROL_TEST =
  `${named('button', 'label', 'summary', 'select', 'option')} or (${named('a')} and ${HREF}) or ` +
  `(${named('input')} and (${BUTTONISH_INPUT} or ${CHOICE_INPUT})) or ` +
  '@role="button" or @role="link" or @role="menuitem" or @role="option" or @role="tab" or ' +
  '@role="checkbox" or @role="radio" or @role="switch"';
// What a click on an element activates: the element, or the nearest control
// around it.
const ACTIVATION_TARGET = `xpath=ancestor-or-self::*[${CONTROL_TEST}][1]`;
// The element itself is that control.
const CONTROL_SELF = `xpath=self::*[${CONTROL_TEST}]`;
// The controls around a control: a button in a link. A click on the inner one
// goes on to them -- the browser runs a link's own action for a click that
// bubbles up to it -- and so to a box around it that takes clicks itself ("Buy
// now $49.00" around a "Details" button), read by what it draws
// (shortClickBoxes).
const OUTER_CONTROLS = `xpath=ancestor::*[${CONTROL_TEST}]`;
// A label's control, when the label does not name one with `for`.
const LABELED_DESCENDANT =
  `xpath=descendant::*[${named('button', 'select', 'textarea', 'meter', 'output', 'progress')} or ` +
  `(${named('input')} and not(${TYPE_LOWER}="hidden"))][1]`;
// Editable as HTML has it: contenteditable "", "true" or "plaintext-only", in
// any case. Every other value -- "false", " false", "no" -- is not.
const EDITABLE_VALUE = lowered('@contenteditable');
const EDITABLE =
  `(@contenteditable and (${EDITABLE_VALUE}="" or ${EDITABLE_VALUE}="true" or ` +
  `${EDITABLE_VALUE}="plaintext-only"))`;
// What a key press can move focus to. Not a disabled control, a hidden input or
// a tabindex that is no number: focus() leaves focus where it was on those.
const FOCUSABLE_SELF =
  `xpath=self::*[not(@disabled) and not(${named('input')} and ${TYPE_LOWER}="hidden") and ` +
  `(${named('input', 'select', 'textarea', 'button', 'summary')} or ` +
  `(${named('a', 'area')} and ${HREF}) or (${named('audio', 'video')} and @controls) or ` +
  `(@tabindex and string(number(@tabindex))!="NaN") or ${EDITABLE})]`;
// What can hold focus by itself once it has it. A focused element that is none
// of these -- a component's host with no tabindex -- holds focus for something
// inside a closed shadow tree, where no selector reaches.
const HOLDS_FOCUS_SELF =
  `xpath=self::*[${named('input', 'select', 'textarea', 'button', 'summary', 'a', 'area', 'audio', 'video', 'dialog')} or ` +
  `@tabindex or ${EDITABLE}]`;
// A field text is typed into. Its value is the user's or the page's words, not
// a control's name, and Enter in it presses its form's default button.
const TEXT_FIELD_SELF =
  `xpath=self::*[${named('textarea', 'select')} or ${EDITABLE} or ` +
  `(${named('input')} and not(${BUTTONISH_INPUT} or ${CHOICE_INPUT}))]`;
// A box a key ticks. Enter in one can submit its form as well.
const CHOICE_SELF = `xpath=self::*[${named('input')} and (${CHOICE_INPUT})]`;
// A field a click only focuses: an input that is no button, no box to tick and
// no slider (a click sets a slider's value), or a textarea. (A date's, a
// colour's or a file's opens its picker as well.)
const FOCUSED_FIELD_SELF =
  `xpath=self::*[${named('textarea')} or ` +
  `(${named('input')} and not(${BUTTONISH_INPUT} or ${CHOICE_INPUT} or ${TYPE_LOWER}="range"))]`;
// The handlers a page writes into an element for what a click does: on the
// click, the press, the release or the touch.
const POINTER_HANDLER =
  '@onclick or @onmousedown or @onmouseup or @onpointerdown or @onpointerup or ' +
  '@ontouchstart or @ontouchend';
// The elements around one that take clicks themselves, the page's body and
// root aside, whatever they hold: which of them is a box short enough to say
// what a click does -- a row, a card: "Buy now $49.00" -- and not an app's
// wrapper, which takes every click on the page and buys nothing by it, is told
// by what it draws (shortClickBoxes): its markup's text holds style sheets,
// structured data, hidden tooltips and a text box's own text, none of it drawn.
const POINTER_BOXES = `xpath=ancestor::*[(${POINTER_HANDLER}) and not(${named('body', 'html')})]`;
// What a click on a field goes on to: the field made a control itself
// (role="button"), or a control around it -- any but a label, which passes on
// no click that lands on a field inside it. (And a short box around it that
// takes clicks itself, as a row that buys does: shortClickBoxes.)
const ACTIVATED_WITH_FIELD = `xpath=ancestor-or-self::*[(${CONTROL_TEST}) and not(${named('label')})][1]`;
// A label that is more than a label: it takes clicks itself, or holds what a
// click on it may land on and press -- a button, a link, a box that takes
// clicks, a frame, a component drawing in a tree of its own ("$ [25] Donate
// $25" in one label).
const LABEL_HOLDS_MORE =
  `xpath=self::*[${POINTER_HANDLER}] | descendant::*[(${CONTROL_TEST}) or ${POINTER_HANDLER} or ` +
  `${named('iframe', 'frame', 'object', 'embed', 'fencedframe')} or contains(local-name(), "-")]`;
// A control an element is, or is in -- any but a label.
const IN_CONTROL = `xpath=ancestor-or-self::*[(${CONTROL_TEST}) and not(${named('label')})][1]`;
// An element of the document's own tree, not a shadow tree's: all that is
// around it can be seen.
const IN_DOCUMENT_TREE = `xpath=ancestor::*[${named('html')}][1]`;
// The submit controls under an element the browser counts as a form's DEFAULT
// button (:default) -- the one Enter presses: a button (of no other type: one
// of type button or reset is never a default), a submit or an image input.
// HTML matches `type` without regard to case, and so does CSS for it. Asked
// of the browser once under an element and then filtered: Playwright widens a
// `:scope` question to the whole of each element's parent, so asking it of
// every candidate in turn costs the page's size for each one.
const DEFAULT_SUBMITS =
  'css=button:default, input[type="submit" i]:default, input[type="image" i]:default';
// The element that has focus: the innermost, inside a shadow tree too. Only in
// the frame that has focus: an element in any other frame never matches it.
const FOCUSED = 'css=*:focus >> nth=-1';
// The document itself, where a key goes when nothing has focus: what the page
// says as a whole is not what one key does.
const DOCUMENT_SELF = `xpath=self::*[${named('body', 'html')}]`;
// The steps the checks take from an element, by name in any namespace.
const ANCESTOR_FORM = `xpath=ancestor::*[${named('form')}][1]`;
const ANCESTOR_LABEL = `xpath=ancestor::*[${named('label')}][1]`;
const LABEL_AROUND_OR_SELF = `xpath=ancestor-or-self::*[${named('label')}][1]`;
const LABEL_SELF = `xpath=self::*[${named('label')}]`;
const IMAGE_ALT_INSIDE = `xpath=descendant::*[${named('img')} and @alt][1]`;
const HTML_SELF = `xpath=self::*[${named('html')}]`;
// Spaces normalize-space keeps: the non-breaking, the zero-width, the others.
const INVISIBLE_SPACES =
  '\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a' +
  '\u200b\u200c\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff';
// A component that draws what it shows where no read reaches -- a closed
// shadow tree, as a pay button can -- and says nothing besides: an element of
// a hyphenated name that holds no text (not even a space nobody sees) and no
// image, in which Playwright's own look, piercing every open shadow tree,
// finds nothing either.
const SEALED_ELEMENT =
  `*[contains(local-name(), "-") and normalize-space(translate(., "${INVISIBLE_SPACES}", ""))="" and not(descendant::*[` +
  'local-name()="svg" or local-name()="img" or local-name()="picture" or ' +
  'local-name()="canvas" or local-name()="video" or local-name()="object" or ' +
  'local-name()="embed" or local-name()="iframe"])]';
const SEALED_SELF = `xpath=self::${SEALED_ELEMENT}`;
const SEALED_WITHIN = `xpath=descendant-or-self::${SEALED_ELEMENT}`;
// How many such components in one element are looked into; past that it is
// taken to be sealed.
const MAX_SEALED_CHECKED = 10;
// A media player. A key on one plays, pauses or seeks it: it is judged by what
// it is, like the document, not by what is around it.
const MEDIA_SELF = `xpath=self::*[${named('audio', 'video')}]`;
// An input that is a button: its value is the label it shows.
const INPUT_BUTTON_SELF = `xpath=self::*[${named('input')} and (${BUTTONISH_INPUT})]`;
// A submit, reset or image button, for which the browser makes up a name
// ("Submit") when the page gives it none.
const DEFAULT_NAMED_INPUT =
  `xpath=self::*[${named('input')} and (${TYPE_LOWER}="submit" or ${TYPE_LOWER}="image" or ` +
  `${TYPE_LOWER}="reset")]`;
// The controls inside an element, through open shadow trees too: a click on a
// container lands on whatever is where it is aimed, and a button is what a
// click there would press.
const CONTROLS_WITHIN =
  'css=button, a[href], area[href], label, summary, select, ' +
  'input:is([type="submit" i], [type="image" i], [type="button" i], [type="reset" i], ' +
  '[type="checkbox" i], [type="radio" i]), [role="button" i], [role="link" i], ' +
  '[role="menuitem" i], [role="option" i], [role="tab" i], [role="checkbox" i], ' +
  '[role="radio" i], [role="switch" i], [onclick], [onmousedown], [onmouseup], [onpointerdown], ' +
  '[onpointerup], [ontouchstart], [ontouchend]';
// Words, as opposed to marks: a letter, in any script. A number alone -- a
// price, a count, a button's value -- says nothing of what a control does; an
// icon font's glyph (a private use character), a space or a non-breaking one,
// an arrow or a cross is no word either.
const SPEECH = /\p{L}/u;
// Anything a reader sees at all: not a space, a format or control character,
// nor a glyph from a private use area.
const VISIBLE_MARK = /[^\s\p{Z}\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u;

// What an element's tree holds -- its document's, or the shadow root's it sits
// in -- as XPath reaches it: the last of an element's ancestors is its tree's
// root. An id, a label's `for` and a form= name mean an element of the same
// tree, so they are looked up there and nowhere else, as the browser looks them
// up; a chain that starts in a frame stays in that frame.
function inTreeOf(element: string, step: string): string {
  return `${element} >> xpath=ancestor-or-self::node()[last()]/descendant::${step}`;
}
// The DEFAULT buttons Enter in a field can press, as the browser has them
// (:default): HTML's form-owner rules -- form=, nesting, shadow trees -- are the
// browser's to apply, not a guess about tree order made here. The candidates
// come from the field's own tree: a button in another is never its form's.
function defaultInForm(formSelector: string): string {
  return `${formSelector} >> ${DEFAULT_SUBMITS} >> xpath=self::*[not(@form)]`;
}
// What a field's tree holds at its top: its document's root element, or a
// shadow root's top elements.
const TREE_TOP = 'xpath=ancestor-or-self::node()[last()]/*';
function defaultNamingForm(field: string, formId: string): string {
  return `${field} >> ${TREE_TOP} >> ${DEFAULT_SUBMITS} >> xpath=self::*[@form=${xpathString(formId)}]`;
}
// The form a field names with form=: the first element of its tree with that
// id, when that element is a form.
function namedForm(field: string, formId: string): string {
  return inTreeOf(field, `*[@id=${xpathString(formId)}][1][${named('form')}]`);
}
// A field the parser tied to a form it does not sit in (legacy markup that opens
// a form inside a table): its default button sits outside every form element.
function defaultOutsideForms(field: string): string {
  return `${field} >> ${TREE_TOP} >> ${DEFAULT_SUBMITS} >> xpath=self::*[not(ancestor::*[${named('form')}]) and not(@form)]`;
}

// A wrapper's words are a mute element's label only while this short; past
// that it is a container of other things (a whole product card).
const MAX_PARENT_LABEL_CHARS = 80;
// How far up the walk for a label goes: 32 levels, far enough for an icon
// nested in wrapper after wrapper -- past them, what is around is unseen. One
// level at a time first, where most walks end, then several at once.
const LABEL_WALK_BATCHES = [1, 1, 2, 4, 8, 16];
// How many matches of a selector that can match several are read. Past that
// the act is refused rather than judged by the first few.
const MAX_MATCHES_READ = 20;
// How many ids an aria-labelledby is read for, likewise.
const MAX_LABELLED_BY_IDS = 10;
// How many of those matches are read at once.
const MATCH_READ_BATCH = 4;

// Where a frame's focus can be that a chain can follow: frames. And where it
// cannot: an <object> or <embed> document, a fenced frame.
const FRAMES = 'css=iframe, frame';
const SEALED_FRAMES = 'css=object, embed, fencedframe';
const ENTER_FRAME = 'internal:control=enter-frame';
const MAX_FRAMES_SEARCHED = 20;
const MAX_FRAME_DEPTH = 4;
// A frame, and how many frames in what a click lands on are read through.
const FRAME_SELF = `xpath=self::*[${named('iframe', 'frame')}]`;
// An <object> or <embed> document, a fenced frame: nothing reads into them --
// but an <object> or <embed> of an image is an image, as an <img> is (an SVG
// logo in a link, made clickable through it).
const IMAGE_FILES = ['.svg', '.png', '.gif', '.jpg', '.jpeg', '.webp', '.avif', '.bmp', '.ico'];
const NOT_AN_IMAGE = `:not([type^="image/"])${IMAGE_FILES.map(
  (file) => `:not([data*="${file}"]):not([src*="${file}"])`,
).join('')}`;
const EMBEDDED_DOCUMENTS = `css=object${NOT_AN_IMAGE}, embed${NOT_AN_IMAGE}, fencedframe`;
// The frames and embedded documents (not images) a frame's document holds.
const FRAMES_HELD = `css=iframe, frame, object${NOT_AN_IMAGE}, embed${NOT_AN_IMAGE}, fencedframe`;
const AN_IMAGE = [
  `starts-with(${lowered('@type')}, "image/")`,
  ...IMAGE_FILES.map((file) => `contains(${lowered('concat(@data, " ", @src)')}, "${file}")`),
].join(' or ');
const SEALED_FRAME_SELF = `xpath=self::*[${named('object', 'embed', 'fencedframe')}][not(${AN_IMAGE})]`;
const MAX_FRAMES_READ = 5;
// The group a field is one of, and what names it: its fieldset's legend, a
// group's, radio group's or fieldset's aria-label or aria-labelledby --
// "Verification code" over six boxes of one digit each, "Card details" over an
// expiry date.
const FIELDSET_LEGEND = `xpath=ancestor::*[${named('fieldset')}][1]/*[${named('legend')}][1]`;
const NAMED_GROUP = `xpath=ancestor::*[@role="group" or @role="radiogroup" or ${named('fieldset')}][@aria-label or @aria-labelledby][1]`;
// What a field sits among, in a word the classifier reads beside its own (and
// only for what a word around can decide: whether an expiry is a card's, and
// whether a "PIN code" is a postal one).
//
// "card" when what the field is entered with holds a card field: the outermost
// form, fieldset or group around it -- a card form sets its number and its
// expiry apart in sections and fieldsets of their own, and they are still one
// form's -- or, outside any, the outermost section, article or region (a page
// with no form sets its parts apart in sections: a traveller's "Date of
// expiry" is not among the payment section's card), or else the whole of its
// tree: its page's, or a component's shadow tree that draws a card form with
// no form element. A card word around refuses, so it is looked for widely.
//
// "address" when the nearest form, fieldset, group, section, article or region
// around it -- or its page, outside any -- holds an address field. That word
// lets a "PIN code" be typed, so it is looked for narrowly: a card's PIN in a
// checkout's payment part is not the postal one of its address part.
const FIELD_GROUP = `${named('form', 'fieldset')} or @role="group"`;
const FIELD_PART = `${named('section', 'article')} or @role="region"`;
const CARD_SCOPE =
  `(ancestor::*[${FIELD_GROUP}][last()]` +
  ` | self::*[not(ancestor::*[${FIELD_GROUP}])]/ancestor::*[${FIELD_PART}][last()]` +
  ` | self::*[not(ancestor::*[${FIELD_GROUP} or ${FIELD_PART}])]/ancestor-or-self::node()[last()])`;
const AROUND_FIELD =
  `xpath=ancestor::*[${named('form', 'fieldset', 'section', 'article', 'html')} or ` +
  '@role="group" or @role="region"][1]';
const NAME_OR_ID = lowered('concat(@name, " ", @id)');
const CARD_FIELD_TEST = [
  `starts-with(${lowered('@autocomplete')}, "cc-")`,
  ...['card', 'cvv', 'cvc', 'csc', 'ccnum', 'cc_num', 'cc-num'].map(
    (word) => `contains(${NAME_OR_ID}, "${word}")`,
  ),
].join(' or ');
const ADDRESS_FIELD_TEST = [
  `contains(${lowered('@autocomplete')}, "address")`,
  `contains(${lowered('@autocomplete')}, "postal")`,
  ...['address', 'street', 'city', 'postal', 'zip'].map(
    (word) => `contains(${NAME_OR_ID}, "${word}")`,
  ),
].join(' or ');
const CARD_NEARBY = `xpath=${CARD_SCOPE}//*[${named('input', 'select')}][${CARD_FIELD_TEST}]`;
// The nearest form, fieldset or group around a field, and in it the card
// fields and the fields that are no part of an expiry (a month, a year, "MM",
// "YY"): a "Passenger 1" fieldset of a passport's number, expiry and
// nationality is a group of its own, not part of the payment beside it.
const NEAREST_GROUP = `ancestor::*[${FIELD_GROUP}][1]`;
const EXPIRY_PART_TEST = ['exp', 'month', 'year', 'mm', 'yy']
  .map(
    (word) =>
      `contains(${lowered('concat(@name, " ", @id, " ", @autocomplete, " ", @aria-label, " ", @placeholder)')}, "${word}")`,
  )
  .join(' or ');
const GROUP_FIELD_TEST =
  `(${named('select', 'textarea')} or (${named('input')} and not(${TYPE_LOWER}="hidden" or ` +
  `${BUTTONISH_INPUT} or ${CHOICE_INPUT})))`;
const CARD_IN_GROUP = `xpath=${NEAREST_GROUP}//*[${named('input', 'select')}][${CARD_FIELD_TEST}]`;
const OTHER_FIELDS_IN_GROUP = `xpath=${NEAREST_GROUP}//*[${GROUP_FIELD_TEST}][not(${EXPIRY_PART_TEST})]`;
const OTHER_FIELD_SELF = `xpath=self::*[${GROUP_FIELD_TEST}][not(${EXPIRY_PART_TEST})]`;
const ADDRESS_NEARBY = `${AROUND_FIELD}//*[${named('input', 'select', 'textarea')}][${ADDRESS_FIELD_TEST}]`;
// The dialog a control sits in: what names it says what the control is for when
// the control says only "Begin" -- in a human check named "Let's confirm you
// are human".
const AROUND_DIALOG = `xpath=ancestor::*[${named('dialog')} or @role="dialog" or @role="alertdialog"][1]`;
// The first heading in a dialog: what one with no name of its own is called.
const FIRST_HEADING = `xpath=descendant::*[${named('h1', 'h2', 'h3', 'h4', 'h5', 'h6')} or @role="heading"][1]`;
// A dialog that sets up a human check is none: "reCAPTCHA settings".
const CAPTCHA_SETUP =
  /\b(?:re|h)?captcha\s{1,3}(?:settings?|config(?:uration)?|options?|preferences?|setup|keys?|integration|plugin|provider|type|version|site\s?keys?)\b/gi;
// How long the browser is given to say where a click lands, and the page what
// a field's form owner's default button is.
const AIM_POINT_TIMEOUT_MS = 2_000;
// And what it draws in an element: on a page of a hundred thousand elements a
// read waits its turn behind every other.
const READ_OUT_TIMEOUT_MS = 4_000;
const OWNER_HINT_TIMEOUT_MS = 2_000;

// The chains above, for tests that stand in for a page.
export const AOI_BROWSER_DRIVE_REACH_SELECTORS = Object.freeze({
  ACTIVATION_TARGET,
  CONTROL_SELF,
  SEALED_SELF,
  SEALED_WITHIN,
  MEDIA_SELF,
  DEFAULT_NAMED_INPUT,
  CONTROLS_WITHIN,
  LABELED_DESCENDANT,
  FOCUSABLE_SELF,
  HOLDS_FOCUS_SELF,
  TEXT_FIELD_SELF,
  CHOICE_SELF,
  FOCUSED_FIELD_SELF,
  ACTIVATED_WITH_FIELD,
  POINTER_BOXES,
  LABEL_HOLDS_MORE,
  IN_CONTROL,
  IN_DOCUMENT_TREE,
  DOCUMENT_SELF,
  FOCUSED,
  FRAMES,
  FRAME_SELF,
  SEALED_FRAMES,
  EMBEDDED_DOCUMENTS,
  FRAMES_HELD,
  SEALED_FRAME_SELF,
  FIELDSET_LEGEND,
  NAMED_GROUP,
  CARD_NEARBY,
  CARD_IN_GROUP,
  OTHER_FIELDS_IN_GROUP,
  OTHER_FIELD_SELF,
  ADDRESS_NEARBY,
  AROUND_DIALOG,
  FIRST_HEADING,
  OUTER_CONTROLS,
  INPUT_BUTTON_SELF,
  ANCESTOR_FORM,
  ANCESTOR_LABEL,
  LABEL_AROUND_OR_SELF,
  LABEL_SELF,
  IMAGE_ALT_INSIDE,
  HTML_SELF,
  inTreeOf,
  defaultInForm,
  defaultNamingForm,
  namedForm,
  defaultOutsideForms,
});

// Whether a selector matches anything: 'no' only when the page says so. A page
// that cannot count, or a count that fails, leaves it 'unknown' -- and an
// unknown never skips a check: the element is read anyway, with a short wait.
type Reach = 'yes' | 'no' | 'unknown';

async function reach(page: AoiBrowserDriveActablePage, selector: string): Promise<Reach> {
  if (typeof page.countMatches !== 'function') {
    return 'unknown';
  }
  try {
    return (await page.countMatches(selector)) > 0 ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}

// Read a value off an element that may not be there: '' for none, and at once
// when the page can say it is not there. One the page says is there -- or
// cannot say is not -- answers, or the check stops: what a read that failed
// might have said is not taken to be nothing. A stand-in for a page, with no
// way to count, shows what it was given.
async function optionalRead(
  page: AoiBrowserDriveActablePage,
  selector: string,
  read: (selector: string) => Promise<string | null>,
): Promise<string> {
  if (typeof page.countMatches !== 'function') {
    return safeDomRead(() => read(selector));
  }
  if ((await reach(page, selector)) === 'no') {
    return '';
  }
  try {
    const value = await read(selector);
    return typeof value === 'string' ? value : '';
  } catch {
    throw new UnreachableTargetError('a part of what the act reaches could not be read in time');
  }
}

// What an element shows -- innerText, which leaves out scripts and hidden
// templates -- where the page can say; its raw text otherwise.
function visibleTextOf(
  page: AoiBrowserDriveActablePage,
  selector: string,
  options: { timeout: number },
): Promise<string | null> {
  if (typeof page.innerText !== 'function') {
    return page.textContent(selector, options);
  }
  // Not every element has an innerText -- an svg's is not: its text, then.
  return page.innerText(selector, options).catch((error: unknown) => {
    if (error instanceof Error && /not an HTMLElement/i.test(error.message)) {
      return page.textContent(selector, options);
    }
    throw error;
  });
}

const LOOKAROUND = { timeout: DOM_LOOKAROUND_TIMEOUT_MS };

// A long text by its start and its end: what a link of a whole paragraph ends
// with ("... Buy now") is as much its words as how it begins.
function headAndTail(text: string): string {
  return text.length <= 2 * MAX_TARGET_WORDS_CHARS
    ? text
    : `${text.slice(0, MAX_TARGET_WORDS_CHARS)} ${text.slice(-MAX_TARGET_WORDS_CHARS)}`;
}

// The text of an aria snapshot value: Playwright writes one in double quotes,
// with backslash escapes, when it has to.
function unquoteAriaValue(value: string): string {
  if (!value.startsWith('"')) {
    return value;
  }
  let out = '';
  for (let at = 1; at < value.length; at += 1) {
    const char = value[at];
    if (char === '"') {
      break;
    }
    if (char !== '\\') {
      out += char;
      continue;
    }
    at += 1;
    const next = value[at] ?? '';
    if (next === 'x') {
      out += String.fromCharCode(parseInt(value.slice(at + 1, at + 3), 16) || 32);
      at += 2;
    } else {
      out += 'bfnrt'.includes(next) ? ' ' : next;
    }
  }
  return out;
}

// The name in an aria snapshot line's key: `role "name" [state]`, the name in
// JSON quotes -- or as it is, when it looks like a /pattern/ -- the states,
// which are Playwright's and never the page's, after it.
function ariaKeyName(key: string): string {
  const named = /^[a-z]+ (.*)$/.exec(key);
  if (!named) {
    return '';
  }
  const rest = named[1];
  if (rest.startsWith('"')) {
    let end = 1;
    while (end < rest.length && rest[end] !== '"') {
      end += rest[end] === '\\' ? 2 : 1;
    }
    try {
      return String(JSON.parse(rest.slice(0, end + 1)));
    } catch {
      return rest.slice(1, end);
    }
  }
  return rest.startsWith('/') ? rest.slice(0, rest.lastIndexOf('/') + 1) : '';
}

/**
 * What an aria snapshot says, read back from where Playwright writes it: each
 * node a line, `- role "name" [state]: text` -- the whole key in YAML single
 * quotes when YAML needs them -- and a node's properties (a link's /url) on
 * lines of their own. The names and the text are kept, brackets and all; the
 * roles, the states and the addresses are not, so a mute icon button
 * ("- button: - img") stays mute.
 */
function readAriaLines(snapshot: string | null): { name: string; text: string; depth: number }[] {
  const lines: { name: string; text: string; depth: number }[] = [];
  for (const raw of (snapshot ?? '').split('\n')) {
    const item = /^(\s*)- (.*)$/.exec(raw);
    if (!item || item[2].startsWith('/')) {
      continue;
    }
    // How deep it is: YAML indents what a node holds under it.
    const depth = item[1].length;
    let rest = item[2];
    let key: string;
    if (rest.startsWith("'")) {
      // YAML's single quotes, in which '' is a quote.
      let end = 1;
      key = '';
      while (end < rest.length && !(rest[end] === "'" && rest[end + 1] !== "'")) {
        key += rest[end];
        end += rest[end] === "'" ? 2 : 1;
      }
      rest = rest.slice(end + 1);
    } else {
      // An unquoted key holds no colon before a space: YAML would have quoted it.
      const colon = rest.search(/:(\s|$)/);
      key = colon < 0 ? rest : rest.slice(0, colon);
      rest = colon < 0 ? '' : rest.slice(colon);
    }
    const text = /^:\s?(.*)$/.exec(rest)?.[1] ?? '';
    lines.push({ name: ariaKeyName(key), text: unquoteAriaValue(text), depth });
  }
  return lines;
}

// How many elements an element may hold for the browser's read-out of it to be
// taken: the snapshot is built on the page, whole, before anything is cut.
const MAX_ARIA_ELEMENTS = 400;
const MAX_ARIA_WORDS_CHARS = 2_000;

// The browser's read-out of an element -- its aria snapshot, built in
// Playwright's isolated world -- when it is small enough to take.
// Null when it was not taken: no way to, nothing there, or too much to take.
// One that fails for an element that is there stops the check, as any read.
async function accessibleSnapshotOf(
  page: AoiBrowserDriveActablePage,
  selector: string,
): Promise<string | null> {
  const snapshot = page.ariaSnapshot?.bind(page);
  if (!snapshot || typeof page.countMatches !== 'function') {
    return null;
  }
  let there: number;
  let inside: number;
  try {
    [there, inside] = await Promise.all([
      page.countMatches(selector),
      page.countMatches(`${selector} >> css=*`),
    ]);
  } catch {
    throw new UnreachableTargetError('a part of what the act reaches could not be counted');
  }
  if (there === 0 || inside > MAX_ARIA_ELEMENTS) {
    return null;
  }
  try {
    return await snapshot(selector, LOOKAROUND);
  } catch {
    throw new UnreachableTargetError('a part of what the act reaches could not be read in time');
  }
}

// What an element says as the browser would read it out: its accessible name
// and text, open shadow trees included -- a "Pay now" a component draws in its
// own tree is in neither innerText nor textContent.
async function accessibleWordsOf(
  page: AoiBrowserDriveActablePage,
  selector: string,
): Promise<string | null> {
  const snapshot = await accessibleSnapshotOf(page, selector);
  if (snapshot === null) {
    return null;
  }
  // The lines a line encloses whose words, run on, are its name -- the "Pay" a
  // search highlights in the link "Payment methods", a wordmark's "Pay" and
  // "Pal" in "Log in with PayPal" -- are read in that name, as the browser runs
  // them on, and not again on their own. Lines beside it, or enclosed by a
  // name of other words ("Payment options" around a "Pay" button), are read.
  const lines = readAriaLines(snapshot);
  const inName = new Set<number>();
  lines.forEach((line, index) => {
    const name = lettersOf(line.name);
    if (!name) {
      return;
    }
    let end = index + 1;
    while (end < lines.length && lines[end].depth > line.depth) {
      end += 1;
    }
    // What the lines it encloses say, each once: a line that encloses others
    // is said by them.
    const enclosed = lines.slice(index + 1, end);
    const said = enclosed
      .filter((inner, at) => !(at + 1 < enclosed.length && enclosed[at + 1].depth > inner.depth))
      .map((leaf) => `${leaf.name}${leaf.text}`)
      .join('');
    if (lettersOf(said) === name) {
      for (let at = index + 1; at < end; at += 1) {
        inName.add(at);
      }
    }
  });
  return lines
    .filter((_, index) => !inName.has(index))
    .flatMap((line) => [line.name, line.text])
    .filter((part) => lettersOf(part) !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ARIA_WORDS_CHARS);
}

// The letters of words, without their spacing or case.
function lettersOf(words: string): string {
  return words.replace(/\s+/g, '').toLowerCase();
}

// Words as they are spaced, one space for any run of it.
function spacedOf(words: string): string {
  return words.replace(/\s+/g, ' ').trim();
}

// Whether every letter of `part` is in `whole`, in its order.
function inOrderWithin(part: string, whole: string): boolean {
  const wanted = Array.from(part);
  let at = 0;
  for (const letter of whole) {
    if (at < wanted.length && wanted[at] === letter) {
      at += 1;
    }
  }
  return at === wanted.length;
}

// An element's accessible name alone, as the browser computes it: for a field,
// what its labels say -- through `for`, a wrapping label, aria-labelledby,
// shadow trees and slots -- and not what is typed in it.
async function accessibleNameOf(
  page: AoiBrowserDriveActablePage,
  selector: string,
): Promise<string> {
  return readAriaLines(await accessibleSnapshotOf(page, selector))[0]?.name ?? '';
}

// Every match of a selector that can match several: all of them, or a refusal
// -- past the limit, or when the page cannot count them after all. A page with
// no way to count is read at its first match.
async function readEachMatch<T>(
  page: AoiBrowserDriveActablePage,
  selector: string,
  read: (match: string) => Promise<T>,
): Promise<T[]> {
  if (typeof page.countMatches !== 'function') {
    return [await read(`${selector} >> nth=0`)];
  }
  let total: number;
  try {
    total = await page.countMatches(selector);
  } catch {
    throw new UnreachableTargetError('what the act reaches could not be counted');
  }
  if (total > MAX_MATCHES_READ) {
    throw new UnreachableTargetError(
      `the act reaches more than ${MAX_MATCHES_READ} elements of one kind, too many to check`,
    );
  }
  // A few at a time: every read waits its turn in the page, and so many at once
  // on a large page would each wait past their time.
  const results: T[] = [];
  for (let first = 0; first < total; first += MATCH_READ_BATCH) {
    const batch = Math.min(MATCH_READ_BATCH, total - first);
    results.push(
      ...(await Promise.all(
        Array.from({ length: batch }, (_, n) => read(`${selector} >> nth=${first + n}`)),
      )),
    );
  }
  return results;
}

// The text of the elements an aria-labelledby names, in the element's own tree.
// All of their text: a name is taken from them even where they are hidden.
async function labelledByText(
  page: AoiBrowserDriveActablePage,
  element: string,
  ids: string,
): Promise<string> {
  const named = ids.split(/\s+/).filter(Boolean);
  if (named.length > MAX_LABELLED_BY_IDS) {
    throw new UnreachableTargetError(
      `an element is labelled by more than ${MAX_LABELLED_BY_IDS} others, too many to check`,
    );
  }
  const texts = await Promise.all(
    named.map((id) =>
      optionalRead(page, inTreeOf(element, `*[@id=${xpathString(id)}][1]`), (s) =>
        page.textContent(s, LOOKAROUND),
      ),
    ),
  );
  return texts
    .map((text) => text.slice(0, MAX_TARGET_WORDS_CHARS))
    .filter(Boolean)
    .join(' ');
}

// The text of every label whose `for` names an element, in its tree.
async function labelsFor(
  page: AoiBrowserDriveActablePage,
  element: string,
  id: string,
): Promise<string> {
  const texts = await readEachMatch(
    page,
    inTreeOf(element, `*[${named('label')} and @for=${xpathString(id)}]`),
    (s) => optionalRead(page, s, (label) => visibleTextOf(page, label, LOOKAROUND)),
  );
  return texts
    .map((text) => text.slice(0, MAX_TARGET_WORDS_CHARS))
    .filter(Boolean)
    .join(' ');
}

// What a control says: everything read off it (`words`); whether that holds
// words of its own -- its text, value, names and labels, not a glyph or a space
// (`speaks`); and whether it shows anything at all, the browser's read-out
// included -- but not a name the browser makes up for an unnamed submit or
// image button (`shows`).
interface ControlWords {
  words: string;
  speaks: boolean;
  // Words of any source that counts, its read-out included.
  says: boolean;
  shows: boolean;
}

// Everything a control says about itself: its text, its accessible name, its
// value, an image's alt, a title, the alt of an image inside it, and the labels
// it has -- by aria-labelledby, by a label's `for`, or by sitting in a label (a
// checkbox's "Buy now with one click" is its label's, not its own) -- and what
// the browser reads out for it, shadow trees included, unless `aria` is off.
// With `hiddenToo`, the text nobody can see as well.
async function readControlWords(
  page: AoiBrowserDriveActablePage,
  selector: string,
  options: { hiddenToo?: boolean; aria?: boolean } = {},
): Promise<ControlWords> {
  const attribute = (name: string) =>
    optionalRead(page, selector, (s) => page.getAttribute(s, name, LOOKAROUND));
  const [accessible, text, hidden, aria, value, alt, title, labelledBy, id, imageAlt, aroundLabel] =
    await Promise.all([
      options.aria === false ? Promise.resolve(null) : accessibleWordsOf(page, selector),
      optionalRead(page, selector, (s) => visibleTextOf(page, s, LOOKAROUND)),
      options.hiddenToo
        ? optionalRead(page, selector, (s) => page.textContent(s, LOOKAROUND))
        : Promise.resolve(''),
      attribute('aria-label'),
      attribute('value'),
      attribute('alt'),
      attribute('title'),
      attribute('aria-labelledby'),
      attribute('id'),
      optionalRead(page, `${selector} >> ${IMAGE_ALT_INSIDE}`, (s) =>
        page.getAttribute(s, 'alt', LOOKAROUND),
      ),
      optionalRead(page, `${selector} >> ${ANCESTOR_LABEL}`, (s) =>
        visibleTextOf(page, s, LOOKAROUND),
      ),
    ]);
  const [labels, forLabels] = await Promise.all([
    labelledBy ? labelledByText(page, selector, labelledBy) : Promise.resolve(''),
    id ? labelsFor(page, selector, id) : Promise.resolve(''),
  ]);
  const shown = headAndTail(text);
  const own = [
    shown,
    headAndTail(hidden),
    aria,
    value,
    alt,
    title,
    imageAlt,
    labels,
    forLabels,
    aroundLabel.slice(0, MAX_TARGET_WORDS_CHARS),
  ]
    .filter(Boolean)
    .join(' ');
  // What it says in words of its own. Its text counts when the browser reads
  // it out as well: an icon's ligature ("arrow_forward") hidden from that
  // read-out is drawn as a glyph, not read as a word. Its value counts only on
  // an input that shows it as its label.
  const valueShows =
    SPEECH.test(value) && (await reach(page, `${selector} >> ${INPUT_BUTTON_SELF}`)) !== 'no';
  const speaks =
    (SPEECH.test(shown) && (accessible === null || SPEECH.test(accessible))) ||
    valueShows ||
    SPEECH.test([aria, alt, title, imageAlt, labels, forLabels, aroundLabel].join(' '));
  // The read-out sets apart what an element of its own splits off -- the "Pay"
  // a search highlights in "Payments" -- where the text runs it on; and the
  // text runs on what the page sets apart with CSS (two inline boxes a margin
  // apart) where the read-out does not. Where the two hold the same letters
  // spaced differently, the drawing says which: what the element shows, when
  // it holds those letters, or some of them in their order -- the rest is not
  // drawn (cut off by an ellipsis, a note for screen readers), and its text
  // still reads it. Otherwise the read-out stands.
  let readOut = accessible ?? '';
  if (
    accessible !== null &&
    lettersOf(text) !== '' &&
    lettersOf(accessible) === lettersOf(text) &&
    spacedOf(accessible) !== spacedOf(text)
  ) {
    const shown = await measureShown(page, selector, MAX_ARIA_WORDS_CHARS);
    if (
      shown !== null &&
      shown !== 'long' &&
      lettersOf(shown.text) !== '' &&
      inOrderWithin(lettersOf(shown.text), lettersOf(text))
    ) {
      readOut = shown.text;
    }
  }
  if (
    !speaks &&
    VISIBLE_MARK.test(readOut) &&
    (await reach(page, `${selector} >> ${DEFAULT_NAMED_INPUT}`)) !== 'no'
  ) {
    // "Submit": the browser's word for a button the page did not name.
    readOut = '';
  }
  return {
    words: [readOut, own].filter(Boolean).join(' '),
    speaks,
    says: speaks || SPEECH.test(readOut),
    shows: VISIBLE_MARK.test(own) || VISIBLE_MARK.test(readOut),
  };
}

// A container's own name -- aria-label, title -- without its contents.
async function readNameWords(page: AoiBrowserDriveActablePage, selector: string): Promise<string> {
  const [aria, title] = await Promise.all([
    optionalRead(page, selector, (s) => page.getAttribute(s, 'aria-label', LOOKAROUND)),
    optionalRead(page, selector, (s) => page.getAttribute(s, 'title', LOOKAROUND)),
  ]);
  return [aria, title].filter(Boolean).join(' ');
}

// The control a label labels: the first element of the label's tree with the
// id its `for` names, else the first control in it.
async function labelControl(
  page: AoiBrowserDriveActablePage,
  labelSelector: string,
): Promise<string> {
  const forId = await optionalRead(page, labelSelector, (s) =>
    page.getAttribute(s, 'for', LOOKAROUND),
  );
  return forId
    ? inTreeOf(labelSelector, `*[@id=${xpathString(forId)}][1]`)
    : `${labelSelector} >> ${LABELED_DESCENDANT}`;
}

// What the browser reads out of an element: what it draws there, closed shadow
// trees and what is hidden from the read-out included. Null when it cannot be
// asked; one it is asked about and does not answer stops the check -- a page
// can make that read slow on purpose.
async function browserReadOut(
  page: AoiBrowserDriveActablePage,
  selector: string,
): Promise<{
  words: string;
  frames: number;
  drawnFrames: number;
  whole: boolean;
  sealed: boolean;
} | null> {
  const readOut = page.readOutOf?.bind(page);
  if (!readOut) {
    return null;
  }
  let read: {
    words: string;
    frames: number;
    drawnFrames?: number;
    whole?: boolean;
    sealed?: boolean;
  } | null;
  try {
    read = await readOut(selector, { timeout: READ_OUT_TIMEOUT_MS });
  } catch {
    throw new UnreachableTargetError(
      'what the browser draws in a part of what the act reaches could not be read in time',
    );
  }
  return read && typeof read.words === 'string'
    ? {
        words: read.words,
        frames: Number(read.frames) || 0,
        drawnFrames: Number(read.drawnFrames ?? read.frames) || 0,
        whole: read.whole !== false,
        sealed: read.sealed === true,
      }
    : null;
}

// What the browser draws in an element small enough to read out whole -- a
// component's closed shadow tree among it, on any element -- and how many frames
// its drawing holds. Nothing for one that is not there or is too large.
async function readOutOfSmall(
  page: AoiBrowserDriveActablePage,
  selector: string,
): Promise<{ words: string; frames: number }> {
  if (typeof page.readOutOf !== 'function' || typeof page.countMatches !== 'function') {
    return { words: '', frames: 0 };
  }
  let there: number;
  let inside: number;
  try {
    [there, inside] = await Promise.all([
      page.countMatches(selector),
      page.countMatches(`${selector} >> css=*`),
    ]);
  } catch {
    throw new UnreachableTargetError('a part of what the act reaches could not be counted');
  }
  if (there === 0 || inside > MAX_ARIA_ELEMENTS) {
    return { words: '', frames: 0 };
  }
  const read = await browserReadOut(page, selector);
  if (read && !read.whole) {
    // More is drawn in it than is read -- and a "Pay now" could be among it.
    throw new UnreachableTargetError(
      'what the browser draws in a part of what the act reaches is too much to read',
    );
  }
  return { words: read?.words ?? '', frames: read?.drawnFrames ?? 0 };
}

/**
 * What is around an element that says too little for itself: the largest
 * wrapper short enough to be its label, and the name of the first one too long
 * to be. `unseen` when the walk could not get that far -- past the levels it
 * takes, onto a page that cannot say what is there, or to the top of a shadow
 * tree, past which, where the component sits on its page, no chain can look.
 */
async function wordsAround(
  page: AoiBrowserDriveActablePage,
  start: string,
): Promise<{ words: string[]; unseen: boolean; outside: string }> {
  if (typeof page.countMatches !== 'function') {
    return { words: [], unseen: true, outside: '' };
  }
  let label = '';
  // What the label shows, when its text is long and what it shows is not.
  let labelShown = '';
  let level = 1;
  for (const size of LABEL_WALK_BATCHES) {
    const first = level;
    level += size;
    const looks = await Promise.all(
      Array.from({ length: size }, async (_, n) => {
        const ancestor = `${start} >> xpath=ancestor::*[${first + n}]`;
        if ((await reach(page, ancestor)) === 'no') {
          return null;
        }
        const text = await optionalRead(page, ancestor, (s) => visibleTextOf(page, s, LOOKAROUND));
        return { ancestor, text: text.trim() };
      }),
    );
    for (const look of looks) {
      if (look === null) {
        // The top of the tree. A document's top says everything around; a
        // shadow tree's leaves out the page the component sits on.
        const [words, atDocument] = await Promise.all([
          label ? wrapperWords(page, label) : Promise.resolve(''),
          reach(page, `${label || start} >> ${HTML_SELF}`),
        ]);
        if (atDocument === 'yes') {
          return { words: [labelShown, words], unseen: false, outside: '' };
        }
        // The element's events bubble on past that top, to whatever on the page
        // handles them -- through the slot of a closed tree as well: what is
        // there is read as well, and only ever added.
        const outside = page.wordsOutsideShadow?.bind(page);
        const slotted = page.closedSlotWordsOf?.bind(page);
        const read = await Promise.all([
          outside ? safeDomRead(() => outside(start, LOOKAROUND)) : '',
          slotted ? safeDomRead(() => slotted(start, LOOKAROUND)) : '',
        ]);
        return {
          words: [labelShown, words],
          unseen: true,
          outside: read.filter(Boolean).join(' '),
        };
      }
      const shown =
        look.text.length > MAX_PARENT_LABEL_CHARS
          ? await measureShown(page, look.ancestor, MAX_PARENT_LABEL_CHARS)
          : { text: '' };
      if (shown === null || shown === 'long') {
        // Too long to be a label; its own name still is one.
        const [name, words] = await Promise.all([
          readNameWords(page, look.ancestor),
          label ? wrapperWords(page, label) : Promise.resolve(''),
        ]);
        return { words: [name, labelShown, words], unseen: false, outside: '' };
      }
      label = look.ancestor;
      labelShown = shown.text;
    }
  }
  return { words: [labelShown, await wrapperWords(page, label)], unseen: true, outside: '' };
}

// A wrapper read for a label: all it shows, what components in it draw in their
// own trees included -- a "Buy now" drawn in a shadow tree beside a mute button
// is beside it all the same. (Its read-out is skipped when it holds too much.)
async function wrapperWords(page: AoiBrowserDriveActablePage, wrapper: string): Promise<string> {
  const [own, drawn] = await Promise.all([
    readControlWords(page, wrapper),
    readOutOfSmall(page, wrapper),
  ]);
  return [own.words, drawn.words].filter(Boolean).join(' ');
}

// The components in these elements, or that they are, that draw where no page
// read reaches -- in a closed shadow tree, or by a stylesheet: Playwright's
// own look, piercing every open shadow tree, finds nothing in them beyond their
// own (empty) elements. The browser reads each out, and what it reads is their
// words. One it cannot -- no way to ask, a frame inside it, past as many as are
// looked into, a count that fails -- is sealed.
async function readSealed(
  page: AoiBrowserDriveActablePage,
  elements: string[],
): Promise<{ words: string[]; sealed: boolean }> {
  const words: string[] = [];
  const looks = await Promise.all(
    elements.map(async (element) => {
      const candidates = `${element} >> ${SEALED_WITHIN}`;
      let total: number;
      try {
        total = (await page.countMatches?.(candidates)) ?? 0;
      } catch {
        return true;
      }
      if (total > MAX_SEALED_CHECKED) {
        return true;
      }
      const each = await Promise.all(
        Array.from({ length: total }, async (_, n) => {
          const candidate = `${candidates} >> nth=${n}`;
          try {
            const [pierced, own] = await Promise.all([
              page.countMatches?.(`${candidate} >> css=*`) ?? 0,
              page.countMatches?.(`${candidate} >> xpath=descendant::*`) ?? 0,
            ]);
            if (pierced > own) {
              return false;
            }
          } catch {
            return true;
          }
          const read = await browserReadOut(page, candidate);
          if (read === null || read.frames > 0 || !read.whole) {
            return true;
          }
          words.push(read.words);
          return false;
        }),
      );
      return each.some(Boolean);
    }),
  );
  return { words: words.filter(Boolean), sealed: looks.some(Boolean) };
}

// What is around an element outside the shadow tree it sits in, as the page
// reads it -- and around the slot of a closed tree the page puts it in, as the
// browser reads that: '' for one of the document's own tree slotted into no
// closed one, or a page with no way to say.
async function outsideItsTree(page: AoiBrowserDriveActablePage, selector: string): Promise<string> {
  const outside = page.wordsOutsideShadow?.bind(page);
  const slotted = page.closedSlotWordsOf?.bind(page);
  const words = await Promise.all([
    outside ? safeDomRead(() => outside(selector, { ...LOOKAROUND, onward: true })) : '',
    slotted ? safeDomRead(() => slotted(selector, LOOKAROUND)) : '',
  ]);
  return words.filter(Boolean).join(' ');
}

// The same reads, to tell that a click only focuses a field: one that fails or
// does not come in time cannot say that nothing is there.
async function outsideItsTreeIfRead(
  page: AoiBrowserDriveActablePage,
  selector: string,
): Promise<string | null> {
  const outside = page.wordsOutsideShadow?.bind(page);
  const slotted = page.closedSlotWordsOf?.bind(page);
  const words = await Promise.all([
    outside ? requiredDomRead(() => outside(selector, { ...LOOKAROUND, onward: true })) : '',
    slotted
      ? slotted(selector, LOOKAROUND).then(
          (read) => (typeof read === 'string' ? read : null),
          () => null,
        )
      : '',
  ]);
  return words.some((read) => read === null) ? null : words.filter(Boolean).join(' ');
}

/**
 * What a click on `selector` can activate, as words: the element, the control
 * around it, and through a label the control it labels. With no control around
 * it, the click reaches some scripted container, and what says what that is is
 * around it -- read whatever the element says for itself: a price, a chevron, an
 * icon font's ligature all sit beside "Buy now". A control that says nothing
 * for itself is read the same way. `unsure` when the element says nothing of
 * its own and what is around it does not say either, or cannot be seen. With
 * `around: false`, only what the element says: it is not what gets activated.
 */
async function activationWords(
  page: AoiBrowserDriveActablePage,
  selector: string,
  options: { around: boolean; sealed?: boolean } = { around: true },
): Promise<{ words: string[]; unsure: boolean; frames: number }> {
  // A control is what it activates: read once, not again as the control
  // around itself.
  const itself = (await reach(page, `${selector} >> ${CONTROL_SELF}`)) === 'yes';
  const activated = itself ? selector : `${selector} >> ${ACTIVATION_TARGET}`;
  const around = itself ? 'yes' : await reach(page, activated);
  const targets = [selector];
  // A label passes the click on to its control, and from there it goes on to
  // what is around that control: a link, a box that buys.
  let labelled = '';
  if (around !== 'no') {
    if (!itself) {
      targets.push(activated);
    }
    if ((await reach(page, `${activated} >> ${LABEL_SELF}`)) !== 'no') {
      labelled = await labelControl(page, activated);
      targets.push(labelled);
    }
  }
  // What the browser draws in them, read out whole when they are small enough,
  // and the components in them no page read reaches: what an act on them does
  // is what they show, closed shadow trees and all. Not for a hover or a drag's
  // grab, which commit nothing.
  // (After its own words: on a large page every read waits its turn, and fewer
  // at once each wait less.)
  const reading = options.sealed !== false;
  // The short boxes around an element that take clicks: a click on it goes on
  // to them, whatever it is.
  const boxesOf = async (element: string) => {
    const boxes = await shortClickBoxes(page, element);
    return Promise.all(
      boxes.map(async ({ box, shown }) =>
        [shown, (await readControlWords(page, box)).words].filter(Boolean).join(' '),
      ),
    );
  };
  const outerOf = async (control: string) => {
    const [controls, boxes] = await Promise.all([
      readEachMatch(
        page,
        `${control} >> ${OUTER_CONTROLS}`,
        async (outer) => (await readControlWords(page, outer)).words,
      ),
      boxesOf(control),
    ]);
    return [...controls, ...boxes];
  };
  const [own, outer, outerOfLabelled] = await Promise.all([
    Promise.all(targets.map((target) => readControlWords(page, target))),
    around === 'yes'
      ? outerOf(activated)
      : around === 'no'
        ? boxesOf(selector)
        : Promise.resolve([] as string[]),
    labelled ? outerOf(labelled) : Promise.resolve([] as string[]),
  ]);
  const [readOuts, sealed] = await Promise.all([
    reading
      ? Promise.all(targets.map((target) => readOutOfSmall(page, target)))
      : Promise.resolve([] as { words: string; frames: number }[]),
    reading
      ? readSealed(page, around !== 'no' && !itself ? [selector, activated] : [selector])
      : Promise.resolve({ words: [] as string[], sealed: false }),
  ]);
  const drawn = readOuts.map((read) => read.words);
  // The frames the element's own drawing holds.
  const frames = readOuts[0]?.frames ?? 0;
  // What the controls around it say is what the click goes on to do as well;
  // it is read, but it does not speak for the control itself.
  const words = [
    ...own.map((read) => read.words),
    ...outer,
    ...outerOfLabelled,
    ...drawn,
    ...sealed.words,
  ];
  // Only words of its own -- not a glyph, not what the browser reads out for
  // it ("Cart" for an icon) -- say what a control does well enough to leave
  // what is around it unread.
  const speaks = own.some((read) => read.speaks);
  const readOut = [...drawn, ...sealed.words];
  const says = own.some((read) => read.says) || readOut.some((word) => SPEECH.test(word));
  const shows = own.some((read) => read.shows) || readOut.some((word) => VISIBLE_MARK.test(word));
  // A page that has no way to count shows nothing of what is around an
  // element -- a stand-in for a page, not a browser's -- and is judged by the
  // words it gave. One that can count and fails to is another matter: unseen.
  if ((around !== 'no' && speaks) || !options.around || typeof page.countMatches !== 'function') {
    // A control in a shadow tree that says what it is still sends its click on
    // out of the tree, to whatever around its host takes it -- read there in
    // the page's own world, where it can only add words.
    const outside =
      around !== 'no' && speaks && options.around ? await outsideItsTree(page, selector) : '';
    return { words: outside ? [...words, outside] : words, unsure: false, frames };
  }
  const context = await wordsAround(page, around !== 'no' ? activated : selector);
  return {
    frames,
    words: [...words, ...context.words, context.outside],
    // Words found outside, in the page's world, decide nothing on their own:
    // they can only add to what is refused. Something in it that nothing can
    // read decides, unless it says in words what it does all the same.
    unsure:
      (sealed.sealed && !says) ||
      (!shows && (context.unseen || !context.words.some((word) => VISIBLE_MARK.test(word)))),
  };
}

// The fields a fill (or a select, or an upload) can reach: the element, and the
// control of the label it sits in -- where Playwright sends the text when the
// element is not a field itself. Read whenever there is such a label, so that
// nothing the element claims about itself decides whether it is looked at.
async function fieldTargets(page: AoiBrowserDriveActablePage, selector: string): Promise<string[]> {
  const targets = [selector];
  const label = `${selector} >> ${LABEL_AROUND_OR_SELF}`;
  if ((await reach(page, label)) !== 'no') {
    targets.push(await labelControl(page, label));
  }
  return targets;
}

// What a field says it is for: its type, names, placeholder, title and the text
// of its labels -- where a site writes "카드번호" or "パスワード" far more often
// than in a name attribute.
async function readFieldFacts(
  page: AoiBrowserDriveActablePage,
  selector: string,
  required: boolean,
): Promise<AoiBrowserDriveActionField | null> {
  const type = required
    ? await requiredDomRead(() =>
        page.getAttribute(selector, 'type', { timeout: DOM_READ_TIMEOUT_MS }),
      )
    : await optionalRead(page, selector, (s) => page.getAttribute(s, 'type', LOOKAROUND));
  if (type === null) {
    return null;
  }
  const attribute = (name: string) =>
    optionalRead(page, selector, (s) => page.getAttribute(s, name, LOOKAROUND));
  const [
    name,
    autocomplete,
    ariaLabel,
    id,
    placeholder,
    title,
    labelledBy,
    around,
    legend,
    called,
  ] = await Promise.all([
    attribute('name'),
    attribute('autocomplete'),
    attribute('aria-label'),
    attribute('id'),
    attribute('placeholder'),
    attribute('title'),
    attribute('aria-labelledby'),
    optionalRead(page, `${selector} >> ${ANCESTOR_LABEL}`, (s) =>
      visibleTextOf(page, s, LOOKAROUND),
    ),
    optionalRead(page, `${selector} >> ${FIELDSET_LEGEND}`, (s) =>
      visibleTextOf(page, s, LOOKAROUND),
    ),
    groupName(page, `${selector} >> ${NAMED_GROUP}`),
  ]);
  const [forLabels, labels, named] = await Promise.all([
    id ? labelsFor(page, selector, id) : Promise.resolve(''),
    labelledBy ? labelledByText(page, selector, labelledBy) : Promise.resolve(''),
    // The name the browser gives a field -- its labels' words wherever they are
    // drawn, in a shadow tree or a slot. Only a field's: a link's name ("Forgot
    // password?") is what it says, not what it is for.
    reach(page, `${selector} >> ${TEXT_FIELD_SELF}`).then((field) =>
      field === 'no' ? '' : accessibleNameOf(page, selector),
    ),
  ]);
  const label = [around, forLabels, labels, named].filter(Boolean).join(' ').slice(0, 300);
  // The group's words apart from the field's own: a legend "Buy a gift card"
  // over a card's expiry names what is bought, not what expires.
  const group = [legend, called].filter(Boolean).join(' ').slice(0, 200);
  // A card form that cannot be counted is taken for one; an address that
  // cannot, is not. A group of its own around the field -- fields of its own
  // beside it, no card field -- holds no card.
  const [cardNear, addressNear, ownGroup] = await Promise.all([
    reach(page, `${selector} >> ${CARD_NEARBY}`),
    reach(page, `${selector} >> ${ADDRESS_NEARBY}`),
    inAGroupOfItsOwn(page, selector, group),
  ]);
  const near = [
    cardNear !== 'no' && !ownGroup ? 'card' : '',
    addressNear === 'yes' ? 'address' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    ...(type ? { type } : {}),
    ...(name ? { name } : {}),
    ...(autocomplete ? { autocomplete } : {}),
    ...(ariaLabel ? { ariaLabel } : {}),
    ...(id ? { id } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(title ? { title } : {}),
    ...(label ? { label } : {}),
    ...(group ? { group } : {}),
    ...(near ? { near } : {}),
  };
}

// Whether a field sits in a group of its own: its nearest form, fieldset or
// group holds no card field and at least one field, other than it, that is no
// part of an expiry -- and the group, or one of those fields, names another
// thing that expires: a passenger's passport number, a driver's licence. A
// security code or a holder's name beside a card's expiry names nothing of the
// kind. Anything that cannot be counted or read is no such group.
const MAX_GROUP_FIELDS_READ = 8;
async function inAGroupOfItsOwn(
  page: AoiBrowserDriveActablePage,
  selector: string,
  group: string,
): Promise<boolean> {
  if (typeof page.countMatches !== 'function') {
    return false;
  }
  try {
    const [card, others, self] = await Promise.all([
      page.countMatches(`${selector} >> ${CARD_IN_GROUP}`),
      page.countMatches(`${selector} >> ${OTHER_FIELDS_IN_GROUP}`),
      page.countMatches(`${selector} >> ${OTHER_FIELD_SELF}`),
    ]);
    if (card !== 0 || others - self < 1) {
      return false;
    }
    if (namesAnotherExpiringThing(group)) {
      return true;
    }
    const named = await Promise.all(
      Array.from({ length: Math.min(others, MAX_GROUP_FIELDS_READ) }, async (_, n) => {
        const field = `${selector} >> ${OTHER_FIELDS_IN_GROUP} >> nth=${n}`;
        const said = await Promise.all([
          ...['name', 'id', 'placeholder', 'aria-label', 'autocomplete'].map((name) =>
            optionalRead(page, field, (s) => page.getAttribute(s, name, LOOKAROUND)),
          ),
          accessibleNameOf(page, field).catch(() => ''),
        ]);
        return namesAnotherExpiringThing(said.join(' '));
      }),
    );
    return named.some(Boolean);
  } catch {
    return false;
  }
}

// What names a group: its aria-label, or the text of what its aria-labelledby
// names.
async function groupName(page: AoiBrowserDriveActablePage, group: string): Promise<string> {
  const [aria, labelledBy] = await Promise.all([
    optionalRead(page, group, (s) => page.getAttribute(s, 'aria-label', LOOKAROUND)),
    optionalRead(page, group, (s) => page.getAttribute(s, 'aria-labelledby', LOOKAROUND)),
  ]);
  const labels = labelledBy ? await labelledByText(page, group, labelledBy) : '';
  return [aria, labels].filter(Boolean).join(' ');
}

// A control in a dialog that names itself a human check is the check, whatever
// the control says: refused as a CAPTCHA. A dialog with no name of its own is
// called by its first heading. The dialog's name decides nothing else.
async function captchaDialogAround(
  page: AoiBrowserDriveActablePage,
  action: AoiBrowserDriveActionRequest,
  selector: string,
): Promise<LiveDomCheck | undefined> {
  const dialog = `${selector} >> ${AROUND_DIALOG}`;
  if ((await reach(page, dialog)) === 'no') {
    return undefined;
  }
  const called =
    (await groupName(page, dialog)) ||
    (await optionalRead(page, `${dialog} >> ${FIRST_HEADING}`, (s) =>
      visibleTextOf(page, s, LOOKAROUND),
    ));
  const name = called.replace(CAPTCHA_SETUP, ' ');
  if (!aoiBrowserDriveIsCaptchaText(name)) {
    return undefined;
  }
  return { forbidden: classifyAoiBrowserDriveAction({ ...action, targetText: name }).reason };
}

// What a default button says: all of its words, hidden ones too -- Enter presses
// a button nobody can see the same as one in plain view -- and, when it says
// nothing, what is around it.
async function defaultButtonWords(
  page: AoiBrowserDriveActablePage,
  button: string,
): Promise<string> {
  const own = await readControlWords(page, button, { hiddenToo: true });
  if (own.speaks) {
    return own.words;
  }
  const around = await wordsAround(page, button);
  return [own.words, ...around.words, around.outside].filter(Boolean).join(' ');
}

/**
 * What Enter in a field would commit, in the words of what it presses.
 *
 * HTML's implicit submission presses the field's form's DEFAULT button; with no
 * submit button at all, it submits the form itself. Which button that is -- the
 * form a field names with form=, the one it sits in, buttons outside it that
 * name it, forms nested by script, shadow trees -- is the browser's own answer
 * (:default), read through chains that start at the field, so a field in a
 * frame is looked up in its frame. The rest of the form -- a "Proceed to
 * checkout" heading, a "Buy now" Enter does not press -- is not read, which is
 * what kept Enter in a search box from being refused on a page that mentioned
 * paying. Only a form with no button to press at all speaks for itself.
 */
async function readDefaultButtonWords(
  page: AoiBrowserDriveActablePage,
  field: string,
): Promise<string[]> {
  const ancestorForm = `${field} >> ${ANCESTOR_FORM}`;
  const [formAttr, inForm] = await Promise.all([
    optionalRead(page, field, (s) => page.getAttribute(s, 'form', LOOKAROUND)),
    reach(page, ancestorForm),
  ]);
  let form = '';
  let formId = formAttr;
  if (formAttr) {
    form = namedForm(field, formAttr);
  } else if (inForm !== 'no') {
    form = ancestorForm;
    formId = await optionalRead(page, ancestorForm, (s) => page.getAttribute(s, 'id', LOOKAROUND));
  }
  const defaults = form
    ? [defaultInForm(form), ...(formId ? [defaultNamingForm(field, formId)] : [])]
    : [defaultOutsideForms(field)];
  const ownerWords = page.formOwnerDefaultWords?.bind(page);
  const [found, owner] = await Promise.all([
    Promise.all(
      defaults.map((selector) =>
        readEachMatch(page, selector, (match) => defaultButtonWords(page, match)),
      ),
    ),
    // The parser can tie a field to a form other than the one it sits in, and
    // that form's default button can sit anywhere: the browser's own answer is
    // read as well -- and when the page does not give it in time, what Enter
    // presses is not known.
    ownerWords
      ? ownerWords(field, { timeout: OWNER_HINT_TIMEOUT_MS }).then(
          (words) => (typeof words === 'string' ? words : ''),
          (error: unknown) => {
            if (error instanceof Error && error.name === 'TimeoutError') {
              throw new UnreachableTargetError(
                'what Enter would press could not be checked in time',
              );
            }
            if (error instanceof Error && error.name === 'TooMuchToReadError') {
              throw new UnreachableTargetError(
                'what Enter would press is in a form too large to read through',
              );
            }
            return '';
          },
        )
      : Promise.resolve(''),
  ]);
  const buttons = found.flat();
  // What the page says, a line for each of the form's buttons: each is judged
  // on its own.
  const owned = owner.split('\n').filter(Boolean);
  // A button to press, however little it says, is what Enter commits. A page
  // that cannot count has only shown that nothing it read spoke.
  const counted = typeof page.countMatches === 'function';
  if (!form || buttons.some(Boolean) || (counted && buttons.length > 0)) {
    return [...buttons, ...owned];
  }
  // What it says, by its start and its end ("... Donate $25 now"), and what is
  // drawn in it where no text read reaches -- a pay button a component draws in
  // its shadow tree.
  const [name, aria, text, drawn] = await Promise.all([
    optionalRead(page, form, (s) => page.getAttribute(s, 'name', LOOKAROUND)),
    optionalRead(page, form, (s) => page.getAttribute(s, 'aria-label', LOOKAROUND)),
    optionalRead(page, form, (s) => visibleTextOf(page, s, LOOKAROUND)),
    readOutOfSmall(page, form),
  ]);
  return [
    ...owned,
    [name, aria, headAndTail(text), headAndTail(drawn.words)].filter(Boolean).join(' '),
  ].filter(Boolean);
}

// What the live-DOM check found: a control the act must never touch, or a
// target it could not read at all -- which is refused too, since an element
// that appears after the check gave up would be acted on unexamined.
type LiveDomCheck = { forbidden: string } | { unreadable: string };

function liveDomRefusal(
  stepIndex: number,
  kind: AoiBrowserDriveActionRequest['kind'],
  check: LiveDomCheck,
): AoiBrowserDriveStepResult {
  if ('forbidden' in check) {
    return {
      index: stepIndex,
      category: 'forbidden',
      ok: false,
      stopReason: 'forbidden',
      detail: check.forbidden,
    };
  }
  return {
    index: stepIndex,
    category: 'act',
    ok: false,
    stopReason: 'action_failed',
    detail: `target_unreadable: ${check.unreadable}; nothing was done`,
    verdict: classifyAoiBrowserDriveActVerdict({ kind, ok: false, stopReason: 'action_failed' }),
  };
}

// Run the deterministic classifier over the words and fields an act reaches.
// Every field is judged on its own: one credential field among them is enough.
function judgeWith(
  action: AoiBrowserDriveActionRequest,
  words: string[],
  fields: AoiBrowserDriveActionField[],
): LiveDomCheck | undefined {
  const pieces = words.map((word) => word.trim()).filter(Boolean);
  const targetText = [action.targetText, ...pieces]
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .trim();
  // Every read on its own as well as all of them together: a phrase is judged
  // where it ends ("Check out" at the end of a button's own words), not only as
  // it runs on into the next read.
  // (Each once: a grid's thousand "Edit" buttons are one read.)
  const texts = [...new Set([targetText, ...pieces])];
  // Each field the page holds is judged as it is read, and with what the plan
  // says of it as well: a plan's words can add to a field's, never take a
  // refusal away -- a plan that calls a card's expiry box a "membership" one.
  const judged = fields.length
    ? fields.flatMap((field) => (action.field ? [field, { ...action.field, ...field }] : [field]))
    : [undefined];
  for (const text of texts) {
    const enriched: AoiBrowserDriveActionRequest = {
      ...action,
      ...(text ? { targetText: text } : {}),
    };
    for (const field of judged) {
      const decision = classifyAoiBrowserDriveAction(field ? { ...enriched, field } : enriched);
      if (decision.category === 'forbidden') {
        return { forbidden: decision.reason };
      }
    }
  }
  return undefined;
}

// The browser's answer for where a click on `selector` lands, or null.
async function readAimPoint(
  page: AoiBrowserDriveActablePage,
  selector: string,
): Promise<AoiAimPoint | null> {
  const aimPoint = page.aimPointReadOut?.bind(page);
  if (!aimPoint) {
    return null;
  }
  try {
    const aim = await aimPoint(selector, { timeout: AIM_POINT_TIMEOUT_MS });
    return aim && typeof aim.words === 'string'
      ? {
          words: aim.words,
          frame: aim.frame === true,
          embedded: aim.embedded === true,
          inside: aim.inside === true,
          blank: aim.blank === true,
          lost: aim.lost === true,
        }
      : null;
  } catch {
    return null;
  }
}

// Whether a click on an element only focuses it: a field of the document's own
// tree that nothing that takes clicks is around -- or a label of one, which
// passes the click on to its field and nowhere else. One that cannot be
// counted is not.
async function focusesOnly(page: AoiBrowserDriveActablePage, selector: string): Promise<boolean> {
  // Alone: no control around it, no short box that takes clicks, in the
  // document's own tree -- and nothing a slot puts it in that takes the click
  // either, which only the page's own world can tell (it can only add).
  const alone = async (target: string) => {
    const [activated, inDocument, boxes] = await Promise.all([
      reach(page, `${target} >> ${ACTIVATED_WITH_FIELD}`),
      reach(page, `${target} >> ${IN_DOCUMENT_TREE}`),
      shortClickBoxes(page, target),
    ]);
    return (
      activated === 'no' &&
      inDocument === 'yes' &&
      boxes.length === 0 &&
      (await outsideItsTreeIfRead(page, target)) === ''
    );
  };
  const [field, label] = await Promise.all([
    reach(page, `${selector} >> ${FOCUSED_FIELD_SELF}`),
    reach(page, `${selector} >> ${LABEL_SELF}`),
  ]);
  if (field === 'yes') {
    return alone(selector);
  }
  if (
    label !== 'yes' ||
    (await reach(page, `${selector} >> ${LABEL_HOLDS_MORE}`)) !== 'no' ||
    (await holdsATree(page, selector)) ||
    !(await alone(selector))
  ) {
    return false;
  }
  const control = await labelControl(page, selector);
  return (await reach(page, `${control} >> ${FOCUSED_FIELD_SELF}`)) === 'yes' && alone(control);
}

// The boxes around an element that take clicks themselves and draw little
// enough to say what a click on them does (POINTER_BOXES): by their text, or by
// what they show where it can be seen. One that cannot be measured is taken for
// one; past as many as are measured, the element is not checked at all.
const CLICK_BOX_CHARS = 80;
const MAX_POINTER_BOXES = 8;
async function shortClickBoxes(
  page: AoiBrowserDriveActablePage,
  selector: string,
): Promise<{ box: string; shown: string }[]> {
  if (typeof page.countMatches !== 'function') {
    return [];
  }
  const boxes = `${selector} >> ${POINTER_BOXES}`;
  let total: number;
  try {
    total = await page.countMatches(boxes);
  } catch {
    throw new UnreachableTargetError('what is around the target could not be counted');
  }
  if (total > MAX_POINTER_BOXES) {
    throw new UnreachableTargetError(
      `the target sits in more than ${MAX_POINTER_BOXES} boxes that take clicks, too many to check`,
    );
  }
  // What this check measures of the boxes around the element, it measures
  // together: the way up from the element is asked about once for them, and
  // never for another check, which comes later or on another page.
  const around = { from: selector, together: {} };
  const short = await Promise.all(
    Array.from({ length: total }, async (_, n) => {
      const box = `${boxes} >> nth=${n}`;
      // A short box's words as it draws them as well: pieces the page sets
      // apart with nothing between them in its text ("Buy" and "49,00 €" in two
      // boxes a margin apart), which its text and its read-out run on.
      const asDrawn = async () => {
        const measured = await measureShown(page, box, CLICK_BOX_CHARS, around);
        return measured !== null && measured !== 'long' ? measured.text : '';
      };
      const drawn = await visibleTextOf(page, box, LOOKAROUND).catch(() => null);
      if (drawn === null) {
        return { box, shown: await asDrawn() };
      }
      const length = drawn.replace(/\s+/g, ' ').trim().length;
      if (length <= CLICK_BOX_CHARS) {
        return { box, shown: await asDrawn() };
      }
      const notShown = await optionsNotShown(page, box);
      if (notShown !== null && length - notShown <= CLICK_BOX_CHARS) {
        return { box, shown: await asDrawn() };
      }
      const shown = await measureShown(page, box, CLICK_BOX_CHARS, around);
      if (shown === 'long') {
        return null;
      }
      if (shown !== null) {
        return { box, shown: shown.text };
      }
      // Neither its text nor what it shows can say how long it is: taken for
      // a short box.
      return notShown === null ? { box, shown: '' } : null;
    }),
  );
  return short.filter((box): box is { box: string; shown: string } => box !== null);
}

// What an element shows where it can be seen, when that is no more than `limit`
// characters (shownTextOf) -- which its text cannot tell: innerText counts a
// description for screen readers, a tooltip waiting at opacity 0 and the
// clamped rest of a card's text as well, and a long text is read by its head
// and its tail, which may leave out what is shown. 'long' when it shows more;
// null when that cannot be told. Boxes a check measures together name what is
// inside them (`around`).
async function measureShown(
  page: AoiBrowserDriveActablePage,
  selector: string,
  limit: number,
  around?: { from: string; together: object },
): Promise<{ text: string } | 'long' | null> {
  const shown = page.shownTextOf?.bind(page);
  if (!shown) {
    return null;
  }
  try {
    const measured = await shown(selector, { ...LOOKAROUND, limit, ...around });
    if (!measured) {
      return null;
    }
    return measured.length <= limit ? { text: measured.text } : 'long';
  } catch {
    return null;
  }
}

// How much of an element's text is the options of its list boxes that are not
// shown: a list box draws one, and its text holds every one. Null when that
// cannot be read -- more list boxes than are read included.
const MAX_LIST_BOXES = 4;
async function optionsNotShown(
  page: AoiBrowserDriveActablePage,
  box: string,
): Promise<number | null> {
  if (typeof page.countMatches !== 'function') {
    return 0;
  }
  const lists = `${box} >> css=select`;
  try {
    const total = await page.countMatches(lists);
    if (total > MAX_LIST_BOXES) {
      return null;
    }
    const held = await Promise.all(
      Array.from({ length: total }, async (_, n) => {
        const options = ((await visibleTextOf(page, `${lists} >> nth=${n}`, LOOKAROUND)) ?? '')
          .split('\n')
          .map((line) => line.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        const all = options.reduce((sum, line) => sum + line.length + 1, 0);
        const shown = options.reduce((least, line) => Math.min(least, line.length), Infinity);
        return options.length > 0 ? all - shown : 0;
      }),
    );
    return held.reduce((sum, length) => sum + length, 0);
  } catch {
    return null;
  }
}

// Whether an element holds a shadow tree, which no XPath step sees: Playwright's
// CSS engine, which goes into open ones, finds more under it than its own
// descendants -- or the browser's read-out of it met a closed one. One that
// cannot be counted is taken to.
async function holdsATree(page: AoiBrowserDriveActablePage, selector: string): Promise<boolean> {
  if (typeof page.countMatches !== 'function') {
    return false;
  }
  let pierced: number;
  let own: number;
  try {
    [pierced, own] = await Promise.all([
      page.countMatches(`${selector} >> css=*`),
      page.countMatches(`${selector} >> xpath=descendant::*`),
    ]);
  } catch {
    return true;
  }
  if (pierced > own) {
    return true;
  }
  return (await browserReadOut(page, selector))?.sealed === true;
}

// A label in what is clicked that labels a field, neither of them in a control:
// a click there focuses the field, and what the box clicked does is the box's
// own words' to say ("Check in", "Check out" over a search box's dates).
async function labelsAField(page: AoiBrowserDriveActablePage, control: string): Promise<boolean> {
  const [label, inControl] = await Promise.all([
    reach(page, `${control} >> ${LABEL_SELF}`),
    reach(page, `${control} >> ${IN_CONTROL}`),
  ]);
  if (label !== 'yes' || inControl !== 'no') {
    return false;
  }
  const field = await labelControl(page, control);
  const [isField, fieldInControl] = await Promise.all([
    reach(page, `${field} >> ${FOCUSED_FIELD_SELF}`),
    reach(page, `${field} >> ${IN_CONTROL}`),
  ]);
  return isField === 'yes' && fieldInControl === 'no';
}

// The words of the controls inside an element -- all of them. Past as many as
// are read, or when they cannot be counted, `cannotTell` hears why, and what
// was read is judged first.
async function controlsWithin(
  page: AoiBrowserDriveActablePage,
  element: string,
  cannotTell: (reason: string) => void,
): Promise<string[]> {
  try {
    // Only those a click could press: shown ones. A label presses its control.
    return await readEachMatch(
      page,
      `${element} >> ${CONTROLS_WITHIN} >> visible=true`,
      async (control) => {
        if (await labelsAField(page, control)) {
          return '';
        }
        const [own, labelled] = await Promise.all([
          readControlWords(page, control),
          reach(page, `${control} >> ${LABEL_SELF}`).then(async (label) =>
            label === 'no'
              ? ''
              : (await readControlWords(page, await labelControl(page, control))).words,
          ),
        ]);
        return [own.words, labelled].filter(Boolean).join(' ');
      },
    );
  } catch (error) {
    if (!(error instanceof UnreachableTargetError)) {
      throw error;
    }
    cannotTell(error.message);
    return [];
  }
}

// The frames inside what is clicked: what they show is part of what it says --
// a pay badge another site draws in a box that pays -- and is read through
// them. Past as many as are read, or when they cannot be counted or entered,
// it cannot be told.
async function framesWithin(
  page: AoiBrowserDriveActablePage,
  element: string,
  cannotTell: (reason: string) => void,
): Promise<{ words: string[]; found: number }> {
  let total: number;
  let embedded: number;
  try {
    [total, embedded] = await Promise.all([
      page.countMatches?.(`${element} >> ${FRAMES}`) ?? 0,
      page.countMatches?.(`${element} >> ${EMBEDDED_DOCUMENTS}`) ?? 0,
    ]);
  } catch {
    cannotTell('the frames in what the act reaches could not be counted');
    return { words: [], found: 0 };
  }
  const found = total + embedded;
  if (embedded > 0) {
    cannotTell('the act reaches an embedded document no check can read');
  }
  if (total > MAX_FRAMES_READ) {
    cannotTell(`the act reaches more than ${MAX_FRAMES_READ} frames, too many to check`);
    return { words: [], found };
  }
  const words = await Promise.all(
    Array.from({ length: total }, async (_, n) => {
      const inside = `${element} >> ${FRAMES} >> nth=${n} >> ${ENTER_FRAME}`;
      const body = `${inside} >> css=body`;
      const [there, holds] = await Promise.all([
        reach(page, body),
        reach(page, `${inside} >> ${FRAMES_HELD}`),
      ]);
      if (holds !== 'no') {
        cannotTell('a frame in what the act reaches holds frames of its own, which are not read');
      }
      if (there === 'unknown') {
        cannotTell('a frame in what the act reaches could not be read');
      }
      if (there !== 'no') {
        return there === 'yes' ? (await readControlWords(page, body)).words : '';
      }
      // A document with no body -- an SVG one -- is read from its root; one
      // still on the blank document it shows first holds nothing yet.
      const root = `${inside} >> css=:root`;
      const rooted = await reach(page, root);
      if (rooted === 'unknown') {
        cannotTell('a frame in what the act reaches could not be read');
      }
      return rooted === 'yes' ? (await readControlWords(page, root)).words : '';
    }),
  );
  return { words, found };
}

// A click on a frame lands in it. When the browser's own look at where it lands
// says nothing of what is there -- it could not be asked, it ran out of time,
// it could not tell that the point is in the frame -- the frame is read
// through, as one that look could not follow the click into. An embedded
// document nothing reads at all.
async function clickedFrameWords(
  page: AoiBrowserDriveActablePage,
  selector: string,
  aim: AoiAimPoint | null,
  frame: Reach,
  cannotTell: (reason: string) => void,
): Promise<string[]> {
  // A page with no way to count -- a stand-in for one -- shows no frames.
  if (typeof page.countMatches !== 'function') {
    return [];
  }
  const embedded = await reach(page, `${selector} >> ${SEALED_FRAME_SELF}`);
  if (embedded === 'yes') {
    cannotTell('the click lands on an embedded document no check can read');
    return [];
  }
  if (frame === 'unknown' || embedded === 'unknown') {
    cannotTell('the frames where the click lands could not be counted');
    return [];
  }
  if (frame === 'no' || aim?.inside) {
    return [];
  }
  return aimedWords(
    page,
    selector,
    { words: '', frame: true, embedded: false, inside: true },
    cannotTell,
  );
}

// The frames a click on `selector` can land in: the element, when it is one,
// or those inside it -- no more than are read.
async function framesAt(
  page: AoiBrowserDriveActablePage,
  selector: string,
  cannotTell: (reason: string) => void,
): Promise<string[]> {
  const self = await reach(page, `${selector} >> ${FRAME_SELF}`);
  if (self === 'yes') {
    return [selector];
  }
  let total = 0;
  try {
    if (self === 'unknown' || typeof page.countMatches !== 'function') {
      throw new Error('not counted');
    }
    total = await page.countMatches(`${selector} >> ${FRAMES}`);
  } catch {
    cannotTell('the frames where the click lands could not be counted');
    return [];
  }
  if (total > MAX_FRAMES_READ) {
    cannotTell(`the click lands among more than ${MAX_FRAMES_READ} frames, too many to check`);
    return [];
  }
  if (total === 0) {
    cannotTell('the click lands in a frame no check can read');
  }
  return Array.from({ length: total }, (_, n) => `${selector} >> ${FRAMES} >> nth=${n}`);
}

// What the browser found where a click lands. When that is a frame it does not
// look into -- one from another site -- what the frame holds is read through
// it: its words, the controls in it, and a component in it nothing reads is not
// clicked. An embedded document nothing reads at all. Read through, a frame's
// text is read by its start and its end: one that holds more is not clicked
// where the click could not be followed into it -- a "Pay now" box in the
// middle of a long panel is no control the read-through counts.
async function aimedWords(
  page: AoiBrowserDriveActablePage,
  selector: string,
  aim: AoiAimPoint,
  cannotTell: (reason: string) => void,
): Promise<string[]> {
  if (aim.embedded) {
    cannotTell('the click lands on an embedded document no check can read');
  }
  if (aim.blank) {
    // The blank document a frame shows until its own arrives.
    cannotTell('the frame where the click lands shows nothing yet');
  }
  if (aim.lost) {
    cannotTell('the click lands in a frame inside a frame where it could not be followed');
  }
  if (!aim.frame) {
    return [aim.words];
  }
  const frames = await framesAt(page, selector, cannotTell);
  const read = await Promise.all(
    frames.map(async (frame) => {
      const body = `${frame} >> ${ENTER_FRAME} >> css=body`;
      if ((await reach(page, body)) !== 'yes') {
        cannotTell('the frame where the click lands could not be read');
        return [];
      }
      const [own, within, sealed, holds, text] = await Promise.all([
        readControlWords(page, body),
        controlsWithin(page, body, cannotTell),
        readSealed(page, [body]),
        reach(page, `${body} >> css=*`),
        optionalRead(page, body, (s) => visibleTextOf(page, s, LOOKAROUND)),
      ]);
      if (sealed.sealed) {
        cannotTell('the click lands in a frame holding a component no check can read');
      }
      if (text.length > 2 * MAX_TARGET_WORDS_CHARS) {
        cannotTell(
          'the frame where the click lands holds more than can be read without following the click into it',
        );
      }
      if ((await reach(page, `${frame} >> ${ENTER_FRAME} >> ${FRAMES_HELD}`)) !== 'no') {
        cannotTell(
          'the frame where the click lands holds frames of its own, which it is not read through',
        );
      }
      if (!own.shows && holds !== 'yes') {
        // The blank document a frame shows until its own arrives.
        cannotTell('the frame where the click lands shows nothing yet');
      }
      return [own.words, ...within];
    }),
  );
  return [aim.words, ...read.flat()];
}

const MUTE_TARGET =
  'it says nothing about what it does, and what is around it does not say it either, or cannot be seen';
const UNSEEN_FOCUS =
  'focus is where no check can follow it -- an embedded document, a fenced frame or a closed ' +
  'shadow tree -- so what the key would do there cannot be told';

// What a key does where it lands. Enter in a text field presses its form's
// default button; on anything else -- a button, a link, a box with a key
// handler -- the key activates what it lands on, as a click would, and is
// judged by the same words. A key on the document itself is the page's to
// handle: what the page says as a whole is not what one key does. `lands` says
// the key is known to go to `receiver`: only then does one that says nothing,
// with nothing around it that does, keep the key from being sent.
async function judgeKeyReceiverWords(
  page: AoiBrowserDriveActablePage,
  action: AoiBrowserDriveActionRequest,
  receiver: string,
  options: { required: boolean; lands: boolean },
): Promise<LiveDomCheck | undefined> {
  const facts = await readFieldFacts(page, receiver, options.required);
  if (facts === null) {
    return missingTarget('the field');
  }
  const [textField, documentLevel, media] = await Promise.all([
    reach(page, `${receiver} >> ${TEXT_FIELD_SELF}`),
    reach(page, `${receiver} >> ${DOCUMENT_SELF}`),
    reach(page, `${receiver} >> ${MEDIA_SELF}`),
  ]);
  if (documentLevel === 'yes') {
    return judgeWith(action, [], [facts]);
  }
  if (media === 'yes') {
    // A player says nothing, and need not: the key plays it. But the key goes
    // on to what holds it -- a button, a card -- and that is judged.
    const held = await activationWords(page, receiver, { around: false });
    return judgeWith(action, held.words, [facts]);
  }
  const words: string[] = [];
  let unsure = false;
  if (textField !== 'yes') {
    // What is around it says what the key does only where the key lands: a
    // target that does not take it is read for what it says it is, no more.
    const activated = await activationWords(page, receiver, { around: options.lands });
    words.push(...activated.words);
    unsure = activated.unsure;
  }
  if (textField !== 'no' || (await reach(page, `${receiver} >> ${CHOICE_SELF}`)) !== 'no') {
    words.push(...(await readDefaultButtonWords(page, receiver)));
  }
  const check = judgeWith(action, words, [facts]);
  if (check || !unsure || !options.lands || aoiBrowserDrivePressOnlyMoves(action)) {
    return check;
  }
  return { unreadable: `the element the key goes to: ${MUTE_TARGET}` };
}

async function judgeKeyReceiver(
  page: AoiBrowserDriveActablePage,
  action: AoiBrowserDriveActionRequest,
  receiver: string,
  options: { required: boolean; lands: boolean },
): Promise<LiveDomCheck | undefined> {
  return (
    (await judgeKeyReceiverWords(page, action, receiver, options)) ??
    (await captchaDialogAround(page, action, receiver))
  );
}

function missingTarget(what: string): LiveDomCheck {
  return {
    unreadable: `${what} was not on the page to be checked within ${DOM_READ_TIMEOUT_MS / 1000} s`,
  };
}

type FocusAt = { selector: string } | 'none' | 'unseen';

/**
 * Where focus is, as the browser has it: the innermost element matching :focus
 * -- inside open shadow trees, and in whichever frame has focus, since an
 * element in any other frame never matches it. 'none' when nothing anywhere
 * has focus, and a key goes to the document. 'unseen' when it could be where
 * no chain follows: a document an <object> or <embed> holds, a fenced frame,
 * frames past those searched, a closed shadow tree, a count that failed. A
 * page with no way to count has its own focus read, all it can show.
 */
async function findFocus(page: AoiBrowserDriveActablePage): Promise<FocusAt> {
  const count = page.countMatches?.bind(page);
  if (!count) {
    return { selector: FOCUSED };
  }
  let searched = 0;
  const search = async (prefix: string, depth: number): Promise<FocusAt> => {
    const here = `${prefix}${FOCUSED}`;
    const found = await reach(page, here);
    if (found === 'yes') {
      return (await reach(page, `${here} >> ${HOLDS_FOCUS_SELF}`)) === 'no'
        ? 'unseen'
        : { selector: here };
    }
    if (found === 'unknown') {
      return 'unseen';
    }
    let frames: number;
    try {
      frames = await count(`${prefix}${FRAMES}`);
    } catch {
      return 'unseen';
    }
    for (let n = 0; n < frames; n += 1) {
      searched += 1;
      if (depth >= MAX_FRAME_DEPTH || searched > MAX_FRAMES_SEARCHED) {
        return 'unseen';
      }
      const inner = await search(`${prefix}${FRAMES} >> nth=${n} >> ${ENTER_FRAME} >> `, depth + 1);
      if (inner !== 'none') {
        return inner;
      }
    }
    return (await reach(page, `${prefix}${SEALED_FRAMES}`)) === 'no' ? 'none' : 'unseen';
  };
  return search('', 0);
}

// Which element has focus, as a string to compare: where it is, and what the
// element there says of itself. Read again a moment later, another element
// reads differently -- and focus moved. Only what an element keeps while it
// has focus: a page marks focus with a class, and that is no move.
const FOCUS_MARKS = ['id', 'name', 'type', 'role', 'aria-label', 'href', 'value'];

async function focusIdentity(page: AoiBrowserDriveActablePage, at: FocusAt): Promise<string> {
  if (typeof at === 'string') {
    return at;
  }
  const marks = await Promise.all([
    optionalRead(page, at.selector, (s) => page.textContent(s, LOOKAROUND)),
    ...FOCUS_MARKS.map((name) =>
      optionalRead(page, at.selector, (s) => page.getAttribute(s, name, LOOKAROUND)),
    ),
  ]);
  return JSON.stringify([at.selector, ...marks.map((mark) => mark.slice(0, 200))]);
}

// Defense-in-depth for the forbidden hard-block: enrich the action with what the
// live page says about every element the act can reach -- its words for a click,
// its field facts for a fill, the button a key would press -- and run the
// deterministic forbidden classifier over each, so a model cannot dodge the
// financial-commit/CAPTCHA/sensitive-field block by omitting targetText/field or
// by addressing a label or an icon. Fails closed: a target that cannot be read
// is not acted on.
// The check runs twice: when approval is asked for ('ask'), and once the target
// is ready, just before the act ('act'). Only then is it in view, and only then
// can the browser be asked what is where a click on it lands.
type CheckStage = 'ask' | 'act';

// All the check may take -- and once the act's own time runs, no more than is
// left of it. A page that makes it take longer is not acted on.
const LIVE_DOM_DEADLINE_MS = 10_000;
const TOO_LONG_TO_CHECK = 'the page took too long to be checked';

// Accepting a dialog agrees to what it says, so what it says is read off the
// page rather than taken from the plan -- and a dialog nobody can see is never
// accepted. What the page asks is judged on its own as well: words the plan
// puts before it ("You won't be charged") take nothing away from what it says.
function judgeShowingDialog(
  page: AoiBrowserDriveActablePage,
  action: AoiBrowserDriveActionRequest,
): { check: LiveDomCheck } | { message: string } {
  const showing = readPendingDialog(page);
  if (!showing) {
    return {
      check: {
        unreadable:
          'no dialog is showing, and a dialog is only accepted once its question has been read',
      },
    };
  }
  for (const targetText of [
    [action.targetText, showing.message].filter(Boolean).join(' '),
    showing.message,
  ]) {
    const decision = classifyAoiBrowserDriveAction({ ...action, targetText });
    if (decision.category === 'forbidden') {
      return { check: { forbidden: decision.reason } };
    }
  }
  return { message: showing.message };
}

async function classifyActFromLiveDom(
  page: AoiBrowserDriveActablePage,
  action: AoiBrowserDriveActionRequest,
  stage: CheckStage = 'act',
  budgetMs: number = LIVE_DOM_DEADLINE_MS,
): Promise<LiveDomCheck | undefined> {
  // A dialog is answered on the page, not on an element. Dismissing is how you
  // back out, and stays possible.
  if (action.kind === 'dialog') {
    if ((action.disposition ?? '').trim().toLowerCase() !== 'accept') {
      return undefined;
    }
    const judged = judgeShowingDialog(page, action);
    return 'check' in judged ? judged.check : undefined;
  }

  const raw = typeof action.selector === 'string' ? action.selector : '';
  if (!raw) {
    return undefined;
  }
  try {
    const judged = await withDeadline(
      judgeReachedTargets(page, action, raw, stage).then((check) => ({ check })),
      Math.max(1, Math.min(LIVE_DOM_DEADLINE_MS, budgetMs)),
    );
    if (judged === null) {
      return { unreadable: TOO_LONG_TO_CHECK };
    }
    return judged.check;
  } catch (error) {
    // Whatever stopped the check, the act is not done unexamined.
    return {
      unreadable:
        error instanceof UnreachableTargetError ? error.message : 'the target could not be checked',
    };
  }
}

async function judgeReachedTargets(
  page: AoiBrowserDriveActablePage,
  action: AoiBrowserDriveActionRequest,
  raw: string,
  stage: CheckStage,
): Promise<LiveDomCheck | undefined> {
  const selector = `${raw} >> nth=0`;
  const clickLike =
    action.kind === 'click' ||
    action.kind === 'submit' ||
    action.kind === 'hover' ||
    action.kind === 'drag' ||
    action.kind === 'download';
  const fieldLike = action.kind === 'type' || action.kind === 'upload' || action.kind === 'select';
  // The target has to be there to be judged at all.
  const present = await requiredDomRead(() =>
    page.textContent(raw, { timeout: DOM_READ_TIMEOUT_MS }),
  );
  if (present === null) {
    return missingTarget('the target');
  }

  if (action.kind === 'press') {
    // Where the key will land, as far as can be told before focus moves: the
    // target, and -- when it cannot take focus itself -- whatever has focus
    // now. A target that cannot may still pass focus on (a component's host
    // passes it to a field inside), so it is read for what it says, not refused
    // for saying nothing: the act moves focus first and judges where it went.
    const takesFocus = (await reach(page, `${selector} >> ${FOCUSABLE_SELF}`)) === 'yes';
    const receivers = [{ receiver: selector, required: true, lands: takesFocus }];
    let unseen = false;
    if (!takesFocus) {
      const at = await findFocus(page);
      if (typeof at !== 'string') {
        receivers.push({ receiver: at.selector, required: false, lands: true });
      }
      unseen = at === 'unseen';
    }
    for (const { receiver, ...options } of receivers) {
      const check = await judgeKeyReceiver(page, action, receiver, options);
      if (check) {
        return check;
      }
    }
    return unseen && !aoiBrowserDrivePressOnlyMoves(action)
      ? { unreadable: UNSEEN_FOCUS }
      : undefined;
  }

  const words: string[] = [];
  const fields: AoiBrowserDriveActionField[] = [];
  // What has to say what it is, and does not: only what a click lands on. A
  // hover commits nothing, and a drag commits at its drop.
  let unsure = '';
  let cannotTell = '';
  // A click lands where it is aimed, on whatever is there. Just before the act
  // the controls inside what is clicked are read, and the browser is asked what
  // is at the point the click is aimed at: what it says is there -- in a closed
  // shadow tree, an image map, a frame, a link around a button -- is read as
  // well, and a component nothing else reads is known for what it draws there
  // rather than refused for what it might. When it cannot say, such a
  // component is not clicked.
  const commits = action.kind !== 'hover' && action.kind !== 'drag';
  const told = (reason: string) => (cannotTell ||= reason);
  // A click on a field that no control is around only focuses it, as a key
  // typed into one goes into it: what the field is named for is what it holds,
  // not what the click does -- "Check out" over a date is the day a stay ends,
  // "Amount to transfer" the sum the form goes on to ask about. In a shadow
  // tree, where what is around its host cannot be seen, it is read like any
  // other target.
  const focusOnly = action.kind === 'click' && (await focusesOnly(page, selector));
  if (clickLike && !focusOnly) {
    const aim = commits && stage === 'act' ? await readAimPoint(page, selector) : null;
    const [reached, frame] = await Promise.all([
      activationWords(page, selector, { around: true, sealed: commits }),
      reach(page, `${selector} >> ${FRAME_SELF}`),
    ]);
    words.push(...reached.words);
    // A frame says what it is by what it holds, read where the click lands.
    if (reached.unsure && commits && frame !== 'yes') {
      unsure = 'the target';
    }
    if (commits && stage === 'act') {
      const within = await framesWithin(page, selector, told);
      words.push(
        ...(await controlsWithin(page, selector, told)),
        ...within.words,
        ...(await clickedFrameWords(page, selector, aim, frame, told)),
      );
      if (reached.frames > within.found) {
        told('the act reaches a frame in a closed shadow tree, which no check can read through');
      }
    }
    // What the browser finds where the click lands, when that is the target or
    // in it. Anything else there -- a layer over it -- is not what Playwright
    // clicks: its own check waits for the target to be uncovered.
    // What it finds that the reads already said, letter for letter, is not
    // read again; anything else is -- a "Pay" beside a "Payment" heading is a
    // control of its own. (What the hit holds as part of a name is read in
    // that name by the session.)
    if (aim?.inside) {
      const read = new Set(words.map(lettersOf));
      const aimed = await aimedWords(page, selector, aim, told);
      words.push(...aimed.filter((word) => !read.has(lettersOf(word))));
    }
    // For a DRAG the destination is what actually gets activated -- "slide to
    // pay" commits at the drop, not the grab.
    if (action.kind === 'drag' && typeof action.toSelector === 'string' && action.toSelector) {
      const destination = action.toSelector;
      const there = await requiredDomRead(() =>
        page.textContent(destination, { timeout: DOM_READ_TIMEOUT_MS }),
      );
      if (there === null) {
        return missingTarget('the drop target');
      }
      // What is at the drop point is what takes the drop.
      const dropAt = `${destination} >> nth=0`;
      const aimDrop = stage === 'act' ? await readAimPoint(page, dropAt) : null;
      const dropped = await activationWords(page, dropAt, { around: true, sealed: true });
      words.push(...dropped.words);
      if (stage === 'act') {
        const within = await framesWithin(page, dropAt, told);
        words.push(
          ...within.words,
          ...(await clickedFrameWords(
            page,
            dropAt,
            aimDrop,
            await reach(page, `${dropAt} >> ${FRAME_SELF}`),
            told,
          )),
        );
        if (dropped.frames > within.found) {
          told('the act reaches a frame in a closed shadow tree, which no check can read through');
        }
      }
      if (aimDrop?.inside) {
        words.push(...(await aimedWords(page, dropAt, aimDrop, told)));
      }
      if (dropped.unsure) {
        unsure = 'the drop target';
      }
    }
  }
  if (fieldLike) {
    const targets = await fieldTargets(page, selector);
    for (const [index, target] of targets.entries()) {
      const facts = await readFieldFacts(page, target, index === 0);
      if (facts === null) {
        return missingTarget('the field');
      }
      fields.push(facts);
    }
  }
  const check =
    judgeWith(action, words, fields) ??
    (clickLike ? await captchaDialogAround(page, action, selector) : undefined);
  if (check) {
    return check;
  }
  if (cannotTell) {
    return { unreadable: cannotTell };
  }
  return unsure ? { unreadable: `${unsure}: ${MUTE_TARGET}` } : undefined;
}

// Each click attempt gets this long inside Playwright. Playwright waits for a
// target to be clickable -- uncovered, still -- for as long as its timeout, and
// a page can change the target in that time: "Continue" under a loading
// overlay is "Pay now" once the overlay goes. So a click that ran out of time
// BEFORE Playwright began delivering it is judged again, as it now is, before
// the next attempt. Playwright logs "performing click action" before it
// delivers; a click whose delivery began is never sent twice.
const CLICK_ATTEMPT_TIMEOUT_MS = 1_500;

// Playwright's call log, line by line, as it wrote it. The log also quotes the
// page -- "<div>performing click action</div> intercepts pointer events" --
// but always within a longer line, since Playwright folds what it quotes onto
// one: a page cannot write itself a line of the log.
function callLogLines(message: string): string[] {
  return message
    .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
    .split('\n')
    .map((line) => line.replace(/^\s*-?\s*/, '').trim());
}

// Whether the click went out: Playwright began delivering its last attempt,
// and nothing stopped that one after -- its hit-target check can still catch
// the events and send the attempt round again.
function clickWentOut(lines: string[]): boolean {
  const performing = lines.lastIndexOf('performing click action');
  return (
    performing >= 0 &&
    !lines
      .slice(performing + 1)
      .some(
        (line) =>
          line.endsWith('intercepts pointer events') || line.startsWith('retrying click action'),
      )
  );
}

async function clickJudgedAsItLands(
  page: AoiBrowserDriveActablePage,
  action: AoiBrowserDriveActionRequest,
  selector: string,
  timeout: number,
): Promise<{ refused?: LiveDomCheck; unsettled?: true }> {
  const deadline = Date.now() + timeout;
  const urlAtStart = safeUrl(page);
  for (;;) {
    try {
      await page.click(selector, {
        timeout: Math.max(1, Math.min(CLICK_ATTEMPT_TIMEOUT_MS, deadline - Date.now())),
      });
      return {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      const log = callLogLines(message);
      if (timedOut && clickWentOut(log)) {
        // The click went out. What ran out of time is the wait after it: for
        // the page to take it, or for the navigation it started -- which goes
        // on here, for the rest of the act's time. It is never sent again.
        const navigating = log.includes('waiting for scheduled navigations to finish');
        if (navigating && safeUrl(page) !== urlAtStart) {
          return {};
        }
        if (navigating && typeof page.waitForFrameNavigation === 'function') {
          await page
            .waitForFrameNavigation({ timeout: Math.max(1, deadline - Date.now()) })
            .catch(() => undefined);
          // Some frame navigated -- an ad's, maybe. Only the page's own new
          // address says the click's navigation arrived.
          if (safeUrl(page) !== urlAtStart) {
            return {};
          }
        }
        return { unsettled: true };
      }
      if (!timedOut || Date.now() >= deadline || readPendingDialog(page) !== null) {
        throw error;
      }
    }
    if (typeof page.waitForActionable === 'function') {
      try {
        await page.waitForActionable(selector, action.kind, {
          timeout: Math.max(1, deadline - Date.now()),
        });
      } catch {
        // The next attempt says why it cannot click.
      }
    }
    const check = await classifyActFromLiveDom(page, action, 'act', deadline - Date.now());
    if (check) {
      return { refused: check };
    }
  }
}

// Playwright's press focuses the target and never checks that it took: a key
// "on" something that cannot take focus goes wherever focus already is, and
// focusing a component's host moves focus inside it. So focus moves first, the
// key is judged where focus really is -- in a frame, in a shadow tree -- and it
// is sent only if focus is still there.
async function pressWhereFocusLands(
  page: AoiBrowserDriveActablePage,
  action: AoiBrowserDriveActionRequest,
  selector: string,
  key: string,
  timeout: number,
): Promise<{ refused?: LiveDomCheck; unsettled?: true }> {
  if (
    typeof page.focus !== 'function' ||
    typeof page.keyboardPress !== 'function' ||
    typeof page.countMatches !== 'function'
  ) {
    await page.press(selector, key, { timeout });
    return {};
  }
  const deadline = Date.now() + timeout;
  await page.focus(selector, { timeout });
  let check: LiveDomCheck | undefined;
  try {
    const judged = await withDeadline(
      judgeWhereFocusIs(page, action).then((found) => ({ found })),
      Math.max(1, Math.min(LIVE_DOM_DEADLINE_MS, deadline - Date.now())),
    );
    check = judged === null ? { unreadable: TOO_LONG_TO_CHECK } : judged.found;
  } catch (error) {
    // Whatever stopped the check, the key is not sent unexamined.
    check = {
      unreadable:
        error instanceof UnreachableTargetError
          ? error.message
          : 'where the key would land could not be checked',
    };
  }
  if (check) {
    return { refused: check };
  }
  // The key goes out now, and Playwright waits for the page to take it -- with
  // no end of its own: a page busy with the key holds the act as long as it
  // likes. What runs out with the act's time is that wait. The key went out,
  // and is never sent again.
  const pressed = await withDeadline(
    page.keyboardPress(key).then(() => true),
    Math.max(1, deadline - Date.now()),
  );
  return pressed === null ? { unsettled: true } : {};
}

async function judgeFieldWhereFocusIs(
  page: AoiBrowserDriveActablePage,
  action: AoiBrowserDriveActionRequest,
  selector: string,
): Promise<LiveDomCheck | undefined> {
  const [targets, at] = await Promise.all([fieldTargets(page, selector), findFocus(page)]);
  if (at === 'unseen') {
    return { unreadable: 'the field the text would go into is where no check can follow it' };
  }
  const fields: AoiBrowserDriveActionField[] = [];
  for (const [index, target] of targets.entries()) {
    const facts = await readFieldFacts(page, target, index === 0);
    if (facts === null) {
      return missingTarget('the field');
    }
    fields.push(facts);
  }
  if (typeof at !== 'string') {
    const focused = await readFieldFacts(page, at.selector, false);
    if (focused) {
      fields.push(focused);
    }
  }
  return judgeWith(action, [], fields);
}

// Playwright's fill focuses the field, then types into it -- and a page can make
// that focus turn the field into another: a search box that becomes a card
// number field the moment it is focused. So focus moves first, where fill
// puts it (a label's control), the field is judged as it is then, together
// with whatever holds focus, and only then is the text filled in.
async function fillWhereFocusLands(
  page: AoiBrowserDriveActablePage,
  action: AoiBrowserDriveActionRequest,
  selector: string,
  text: string,
  timeout: number,
): Promise<LiveDomCheck | undefined> {
  if (typeof page.focusToFill !== 'function' || typeof page.countMatches !== 'function') {
    await page.fill(selector, text, { timeout });
    return undefined;
  }
  const deadline = Date.now() + timeout;
  await page.focusToFill(selector, { timeout });
  let check: LiveDomCheck | undefined;
  try {
    const judged = await withDeadline(
      judgeFieldWhereFocusIs(page, action, `${selector} >> nth=0`).then((found) => ({ found })),
      Math.max(1, Math.min(LIVE_DOM_DEADLINE_MS, deadline - Date.now())),
    );
    check = judged === null ? { unreadable: TOO_LONG_TO_CHECK } : judged.found;
  } catch (error) {
    // Whatever stopped the check, the text is not typed unexamined.
    check = {
      unreadable:
        error instanceof UnreachableTargetError
          ? error.message
          : 'the field the text would go into could not be checked',
    };
  }
  if (check) {
    return check;
  }
  await page.fill(selector, text, { timeout: Math.max(1, deadline - Date.now()) });
  return undefined;
}

async function judgeWhereFocusIs(
  page: AoiBrowserDriveActablePage,
  action: AoiBrowserDriveActionRequest,
): Promise<LiveDomCheck | undefined> {
  const at = await findFocus(page);
  if (at === 'unseen' && !aoiBrowserDrivePressOnlyMoves(action)) {
    return { unreadable: UNSEEN_FOCUS };
  }
  const before = await focusIdentity(page, at);
  if (typeof at !== 'string') {
    // Judged again even when it is the target: taking focus can change what
    // an element says -- a focus handler that relabels it.
    const check = await judgeKeyReceiver(page, action, at.selector, {
      required: false,
      lands: true,
    });
    if (check) {
      return check;
    }
  }
  if ((await focusIdentity(page, await findFocus(page))) !== before) {
    return { unreadable: 'focus moved while the key was being checked, so it was not pressed' };
  }
  return undefined;
}

export interface AoiBrowserDriveRunResult {
  admissible: boolean;
  rejectReasons: AoiBrowserDrivePlanRejectReason[];
  steps: AoiBrowserDriveStepResult[];
  stopped: boolean;
  stopReason?: AoiBrowserDriveStepStopReason;
}

/**
 * Thin convenience wrapper for the read-only / periodic-watch path: run an
 * admissible plan step-by-step, STOPPING at the first non-ok step. The interactive
 * live path uses the single-step primitive directly (so the UI can gate each ACT);
 * this wrapper is for sequences whose ACT steps are pre-approved (or that are all
 * read).
 */
export async function runAoiBrowserDrivePlan(
  params: Omit<AoiBrowserDriveExecuteStepParams, 'stepIndex'>,
): Promise<AoiBrowserDriveRunResult> {
  const planClass = classifyAoiBrowserDrivePlan(params.plan, {
    ...(params.maxPlanSteps ? { maxSteps: params.maxPlanSteps } : {}),
  });
  if (!planClass.admissible) {
    return {
      admissible: false,
      rejectReasons: planClass.rejectReasons,
      steps: [],
      stopped: true,
      stopReason: 'plan_inadmissible',
    };
  }
  const steps: AoiBrowserDriveStepResult[] = [];
  const total = params.plan.steps.length;
  for (let index = 0; index < total; index += 1) {
    const result = await executeAoiBrowserDriveStep({ ...params, stepIndex: index });
    steps.push(result);
    if (!result.ok) {
      return {
        admissible: true,
        rejectReasons: [],
        steps,
        stopped: true,
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      };
    }
  }
  return { admissible: true, rejectReasons: [], steps, stopped: false };
}
