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
//   4. every step is bound to the domain allowlist -- the current page must be
//      allowlisted before we touch it, and after an ACT the FINAL url must STILL be
//      allowlisted or the tab is blanked and the run stops (drift block reuse).
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
import { extractAoiHostBrowserReadable } from './aoiHostBrowserRead';

const DEFAULT_ACT_TIMEOUT_MS = 15_000;
const MAX_ACT_TIMEOUT_MS = 45_000;
const DEFAULT_WAIT_MS = 500;
const MAX_WAIT_MS = 10_000;
const DEFAULT_SCROLL_DELTA = 600;
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
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
}

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
  | 'not_allowlisted'
  | 'approval_denied'
  | 'approval_gate_error'
  | 'drift_off_allowlist'
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
  // Present for an ACT step: the fingerprint the approval gate was asked about.
  approvalFingerprint?: string;
  // True when the ACT was authorized by a standing grant (P3.1) rather than a fresh
  // per-action approval -- surfaced so the audit ledger can mark autonomous acts.
  approvalViaStanding?: boolean;
  observation?: { before?: AoiBrowserDriveObservation; after?: AoiBrowserDriveObservation };
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
export function computeAoiBrowserDriveActionFingerprint(
  goal: string,
  stepIndex: number,
  action: AoiBrowserDriveActionRequest,
): string {
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
  ].join('\n');
  return `${fnv1a(canonical, 0x811c9dc5)}${fnv1a(canonical, 0x9e3779b1)}`;
}

async function blankPage(page: AoiBrowserDriveActablePage): Promise<void> {
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

  const action = step.action;
  const beforeUrl = safeUrl(page);
  const before = await observe(params.observer, {
    stepIndex,
    phase: 'before',
    action,
    url: beforeUrl,
  });

  // 4) Allowlist binding. 'navigate' delegates its own pre/post drift checks to
  //    navigateAndExtract; every other step acts on the CURRENT page, which must
  //    already be allowlisted before we touch it.
  if (action.kind !== 'navigate') {
    const here = isAoiBrowserDriveUrlAllowed(allowlist, beforeUrl);
    if (!here.allowed) {
      return finish(params.observer, stepIndex, action, before, {
        index: stepIndex,
        category: decision.category,
        ok: false,
        stopReason: 'not_allowlisted',
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
    approvalFingerprint = computeAoiBrowserDriveActionFingerprint(plan.goal, stepIndex, action);
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

    // ACT (approved above).
    await executeActStep({ page, action, timeout });

    // Post-act drift: the effect may have navigated off-allowlist. If so, blank the
    // tab so no off-allowlist content persists in the Aoi page, and stop.
    const finalUrl = safeUrl(page);
    const post = isAoiBrowserDriveUrlAllowed(allowlist, finalUrl);
    if (!post.allowed) {
      await blankPage(page);
      return finish(params.observer, stepIndex, action, before, {
        index: stepIndex,
        category: 'act',
        ok: false,
        stopReason: 'drift_off_allowlist',
        detail: post.reason,
        finalUrl,
        approvalFingerprint,
      });
    }
    return finish(params.observer, stepIndex, action, before, {
      index: stepIndex,
      category: 'act',
      ok: true,
      finalUrl,
      approvalFingerprint,
      ...(approvalViaStanding ? { approvalViaStanding: true } : {}),
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
            outcome.reason === 'url_not_allowlisted'
              ? 'not_allowlisted'
              : outcome.reason === 'drift_off_allowlist'
                ? 'drift_off_allowlist'
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
        return { ok: false, stopReason: 'drift_off_allowlist', detail: post.reason, finalUrl };
      }
      return { ok: true, finalUrl };
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

async function executeActStep(params: {
  page: AoiBrowserDriveActablePage;
  action: AoiBrowserDriveActionRequest;
  timeout: number;
}): Promise<void> {
  const { page, action, timeout } = params;
  const selector = typeof action.selector === 'string' ? action.selector : '';
  if (!selector) {
    throw new Error(`action ${action.kind} requires a selector`);
  }
  switch (action.kind) {
    case 'click':
      await page.click(selector, { timeout });
      return;
    case 'type':
      await page.fill(selector, action.text ?? action.value ?? '', { timeout });
      return;
    case 'select':
      await page.selectOption(selector, action.value ?? '', { timeout });
      return;
    case 'press':
      await page.press(selector, action.key ?? 'Enter', { timeout });
      return;
    case 'submit':
      // A form submit is triggered by activating its submit control.
      await page.click(selector, { timeout });
      return;
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
