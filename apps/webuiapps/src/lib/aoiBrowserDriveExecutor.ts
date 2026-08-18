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
  classifyAoiBrowserDriveAction,
  type AoiBrowserDriveActionCategory,
  type AoiBrowserDriveActionRequest,
} from './aoiBrowserDriveAction';
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
  // answers one silently loses whatever the page was asking.
  answerDialog?(disposition: 'accept' | 'dismiss', promptText?: string): Promise<string>;
  // Tabs in the same browser context.
  listTabs?(): Promise<{ index: number; url: string; title: string; current: boolean }[]>;
  selectTab?(index: number): Promise<void>;
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
export function computeAoiBrowserDriveActionFingerprint(
  goal: string,
  stepIndex: number,
  action: AoiBrowserDriveActionRequest,
  hostname = '',
): string {
  // EVERY field that changes what the action does has to be in here.
  //
  // A fingerprint is what an approval is bound to, so anything left out is a
  // field the operator can be shown one value of and the run can then use
  // another. When the vocabulary grew these were initially missing, which meant
  // an approval to DISMISS a dialog also authorized accepting it, and an
  // approval to upload one file authorized uploading any other file through the
  // same input.
  const canonical = [
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
  ].join('\n');
  return `${fnv1a(canonical, 0x811c9dc5)}${fnv1a(canonical, 0x9e3779b1)}`;
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
    html = await page.content();
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
  const step = plan?.steps?.[stepIndex];
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
  const before = await observe(params.observer, {
    stepIndex,
    phase: 'before',
    action,
    url: beforeUrl,
  });

  // 4) Denylist binding. 'navigate' delegates its own pre/post checks to
  //    navigateAndExtract; every other step acts on the CURRENT page, which must
  //    not be denylisted before we touch it.
  if (action.kind !== 'navigate') {
    const here = isAoiBrowserDriveUrlAllowed(allowlist, beforeUrl);
    if (!here.allowed) {
      return finish(params.observer, stepIndex, action, before, {
        index: stepIndex,
        category: decision.category,
        ok: false,
        stopReason: 'host_denylisted',
        detail: here.reason,
        finalUrl: beforeUrl,
      });
    }
  }

  // ACT steps: require per-action approval BEFORE the effect. A denying/erroring
  // gate is fail-closed.
  let approvalFingerprint: string | undefined;
  let approvalViaStanding = false;
  if (decision.category === 'act') {
    // Defense-in-depth against a model that hides a forbidden control by omitting
    // targetText/field: derive the REAL accessible text + field metadata from the
    // live DOM and re-run the (deterministic) forbidden classifier. This matters
    // most on the autonomous standing-grant path, where no human sees the summary.
    const domForbidden = await classifyActFromLiveDom(page, action);
    if (domForbidden) {
      return finish(params.observer, stepIndex, action, before, {
        index: stepIndex,
        category: 'forbidden',
        ok: false,
        stopReason: 'forbidden',
        detail: domForbidden,
      });
    }
    // Bind the approval to the host the act actually lands on (see fingerprint doc).
    approvalFingerprint = computeAoiBrowserDriveActionFingerprint(
      plan.goal,
      stepIndex,
      action,
      hostnameOf(beforeUrl),
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
    const actOutcome = await executeActStep({
      page,
      action,
      timeout,
      ...(params.uploadGate ? { uploadGate: params.uploadGate } : {}),
      ...(params.downloadGate ? { downloadGate: params.downloadGate } : {}),
    });

    // Post-act drift: the effect may have navigated onto a denylisted host. If so,
    // blank the tab so blocked content does not persist in the Aoi page, and stop.
    const finalUrl = safeUrl(page);
    const post = isAoiBrowserDriveUrlAllowed(allowlist, finalUrl);
    if (!post.allowed) {
      await blankPage(page);
      return finish(params.observer, stepIndex, action, before, {
        index: stepIndex,
        category: 'act',
        ok: false,
        stopReason: 'drift_to_denylist',
        detail: post.reason,
        finalUrl,
        approvalFingerprint,
        verdict: classifyAoiBrowserDriveActVerdict({
          kind: action.kind,
          ok: false,
          stopReason: 'drift_to_denylist',
        }),
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
        urlAfter: finalUrl,
        ...(actOutcome.readBack ? { readBack: actOutcome.readBack } : {}),
      }),
    });
  } catch (error) {
    return finish(params.observer, stepIndex, action, before, {
      index: stepIndex,
      category: decision.category,
      ok: false,
      stopReason: 'action_failed',
      detail: error instanceof Error ? error.message : String(error),
      ...(approvalFingerprint ? { approvalFingerprint } : {}),
      finalUrl: safeUrl(page),
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

function safeUrl(page: AoiBrowserDriveActablePage): string {
  try {
    return page.url();
  } catch {
    return '';
  }
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

async function executeReadStep(params: {
  page: AoiBrowserDriveActablePage;
  action: AoiBrowserDriveActionRequest;
  allowlist: AoiBrowserDriveAllowlist | null | undefined;
  now: number;
  timeout: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<AoiBrowserDriveReadStepOutcome> {
  const { page, action, allowlist } = params;
  switch (action.kind) {
    case 'navigate': {
      const outcome = await navigateAndExtractAoiBrowserDrive({
        page,
        allowlist,
        url: action.url ?? '',
        now: params.now,
        timeoutMs: params.timeout,
      });
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
      const html = await page.content();
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
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: params.timeout });
      const finalUrl = safeUrl(page);
      const post = isAoiBrowserDriveUrlAllowed(allowlist, finalUrl);
      if (!post.allowed) {
        await blankPage(page);
        return { ok: false, stopReason: 'drift_to_denylist', detail: post.reason, finalUrl };
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
      return { ok: true, finalUrl: safeUrl(page), tabs: await page.listTabs() };
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
      // Everything addressed on the old tab is meaningless on the new one, and
      // the caller has to be told rather than left to discover it by acting.
      return { ok: true, finalUrl: safeUrl(page), tabs, tabSwitched: true };
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
    // Bound the wait. A dialog is answered through an event, so "no dialog is
    // showing" looks identical to "one has not appeared yet" -- and an
    // implementation that simply never resolves would hang the whole run with
    // no step, no verdict and no way to tell what happened. A timeout turns that
    // into an ordinary reportable failure.
    const message = await Promise.race([
      page.answerDialog(disposition, action.promptText),
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
      await page.click(selector, { timeout });
      return {};
    case 'type': {
      const expected = action.text ?? action.value ?? '';
      await page.fill(selector, expected, { timeout });
      return { readBack: { expected, actual: await readBackValue(page, selector, timeout) } };
    }
    case 'select': {
      const expected = action.value ?? '';
      await page.selectOption(selector, expected, { timeout });
      return { readBack: { expected, actual: await readBackValue(page, selector, timeout) } };
    }
    case 'press':
      await page.press(selector, action.key ?? 'Enter', { timeout });
      return {};
    case 'submit':
      // A form submit is triggered by activating its submit control.
      await page.click(selector, { timeout });
      return {};
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

// Defense-in-depth for the forbidden hard-block: enrich the action with the target's
// REAL accessible text (click/submit) or field metadata (type) read from the live
// DOM, then run the deterministic forbidden classifier. Returns the forbid reason if
// the DOM-derived action is forbidden, else undefined. Best-effort: a DOM read
// failure yields undefined, so this only ADDS blocks (a model cannot dodge the
// financial-commit/CAPTCHA/sensitive-field block by omitting targetText/field).
async function classifyActFromLiveDom(
  page: AoiBrowserDriveActablePage,
  action: AoiBrowserDriveActionRequest,
): Promise<string | undefined> {
  const selector = typeof action.selector === 'string' ? action.selector : '';
  if (!selector) {
    return undefined;
  }
  const opts = { timeout: DOM_READ_TIMEOUT_MS };
  let enriched: AoiBrowserDriveActionRequest = action;
  if (
    action.kind === 'click' ||
    action.kind === 'submit' ||
    action.kind === 'hover' ||
    action.kind === 'drag'
  ) {
    const [text, aria, value] = await Promise.all([
      safeDomRead(() => page.textContent(selector, opts)),
      safeDomRead(() => page.getAttribute(selector, 'aria-label', opts)),
      safeDomRead(() => page.getAttribute(selector, 'value', opts)),
    ]);
    // For a DRAG the destination is what actually gets activated -- "slide to
    // pay" commits at the drop, not the grab -- so the drop target's text has to
    // be part of what the hard-block sees. Reading only the source would leave
    // exactly the control this is meant to catch unexamined.
    let destinationText = '';
    if (action.kind === 'drag' && typeof action.toSelector === 'string' && action.toSelector) {
      const [dropText, dropAria, dropValue] = await Promise.all([
        safeDomRead(() => page.textContent(action.toSelector as string, opts)),
        safeDomRead(() => page.getAttribute(action.toSelector as string, 'aria-label', opts)),
        safeDomRead(() => page.getAttribute(action.toSelector as string, 'value', opts)),
      ]);
      destinationText = [dropText, dropAria, dropValue].filter(Boolean).join(' ');
    }
    const domText = [action.targetText, text, aria, value, destinationText]
      .filter((part): part is string => Boolean(part))
      .join(' ')
      .trim();
    if (!domText) {
      return undefined;
    }
    enriched = { ...action, targetText: domText };
  } else if (action.kind === 'type' || action.kind === 'upload') {
    const [type, name, autocomplete, ariaLabel, id] = await Promise.all([
      safeDomRead(() => page.getAttribute(selector, 'type', opts)),
      safeDomRead(() => page.getAttribute(selector, 'name', opts)),
      safeDomRead(() => page.getAttribute(selector, 'autocomplete', opts)),
      safeDomRead(() => page.getAttribute(selector, 'aria-label', opts)),
      safeDomRead(() => page.getAttribute(selector, 'id', opts)),
    ]);
    enriched = {
      ...action,
      field: {
        ...action.field,
        ...(type ? { type } : {}),
        ...(name ? { name } : {}),
        ...(autocomplete ? { autocomplete } : {}),
        ...(ariaLabel ? { ariaLabel } : {}),
        ...(id ? { id } : {}),
      },
    };
  } else {
    // select/press carry no financial/captcha/sensitive DOM signal to add.
    return undefined;
  }
  const decision = classifyAoiBrowserDriveAction(enriched);
  return decision.category === 'forbidden' ? decision.reason : undefined;
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
