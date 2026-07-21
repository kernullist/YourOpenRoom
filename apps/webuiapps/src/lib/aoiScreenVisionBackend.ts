// SV2.1: injectable, fail-closed vision-backend abstraction for screen vision.
//
// Screen vision perceives the FOCUSED window's content through a vision model.
// This module defines the backend contract and a pure orchestrator around it;
// it does NOT itself store, redact, or persist anything, and it performs NO
// network / spawn / fs of its own -- the actual model call lives in an injected
// invoker (a local VLM in the native capture process, or a cloud API). That
// keeps the orchestration deterministic and unit-testable, and lets production
// wire either channel.
//
// Safety:
//   * Pixel-free orchestration: this module never holds raw pixels. A frame is
//     described only by a bounded metadata descriptor plus an opaque handle the
//     injected invoker uses to locate the bytes; the handle is never
//     interpreted, logged, or persisted here.
//   * Cloud is opt-in by construction: buildAoiCloudScreenVisionBackend returns
//     the INERT backend unless allowCloud === true, so pixels never reach a
//     cloud API without an explicit opt-in.
//   * Fail-closed everywhere: no backend / inert / null result / low confidence
//     -> 'unavailable'; invalid frame / invoker throw / timeout / malformed
//     result -> 'failed'. A fabricated description is never returned.
//   * NOT redacted here: the returned result is RAW model output, only
//     structurally bounded (length caps). SV2.2 redacts it before it can become
//     a stored signal.

export type AoiScreenVisionChannel = 'local' | 'cloud';

// Bounded descriptor of a captured FOCUSED-window frame. No raw pixels.
export interface AoiScreenVisionFrame {
  version: 1;
  width: number;
  height: number;
  capturedAt: number;
  // Validated slug of the focused app (metadata), optional.
  appId?: string;
  // Opaque handle the injected invoker uses to locate the frame bytes. Never
  // interpreted, logged, or persisted by this module.
  frameHandle: string;
}

// RAW model response from an invoker. Tolerant/unknown-typed; normalized below.
// NOT yet redacted -- SV2.2 redacts before anything is stored.
export interface AoiScreenVisionRawResponse {
  summary?: unknown;
  details?: unknown;
  appLabel?: unknown;
  confidence?: unknown;
  modelId?: unknown;
}

// Normalized, structurally-bounded result. Content is NOT redacted yet.
export interface AoiScreenVisionResult {
  version: 1;
  channel: AoiScreenVisionChannel;
  modelId: string;
  summary: string;
  details: string[];
  appLabel: string | null;
  confidence: number; // clamped to [0, 1]
  producedAt: number;
}

export type AoiScreenVisionOutcome =
  | { status: 'described'; result: AoiScreenVisionResult }
  // inert / no backend / null result / below the confidence floor
  | { status: 'unavailable'; reason: string }
  // invalid frame / invoker threw / timeout / malformed result
  | { status: 'failed'; reason: string };

// The injected transport. Returns the raw model response, or null when it
// cannot produce one. Production wires a local VLM invoker (native capture
// process) or a cloud API invoker; tests inject a mock; absent -> inert.
export type AoiScreenVisionInvoker = (
  frame: AoiScreenVisionFrame,
) => Promise<AoiScreenVisionRawResponse | null>;

export interface AoiScreenVisionBackend {
  readonly channel: AoiScreenVisionChannel;
  readonly modelId: string;
  describe(frame: AoiScreenVisionFrame): Promise<AoiScreenVisionRawResponse | null>;
}

// The inert default: always yields no result, so the orchestrator fails closed
// to 'unavailable'. Injected wherever a real backend is absent or disallowed.
export const AOI_INERT_SCREEN_VISION_BACKEND: AoiScreenVisionBackend = {
  channel: 'local',
  modelId: 'inert',
  describe: async () => null,
};

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_CONFIDENCE = 0.35;
const DEFAULT_MAX_SUMMARY_CHARS = 400;
const DEFAULT_MAX_DETAILS = 8;
const DEFAULT_MAX_DETAIL_CHARS = 200;
const MAX_DIMENSION = 16_384;

export interface AoiScreenVisionDescribeOptions {
  backend?: AoiScreenVisionBackend | null;
  now?: number;
  timeoutMs?: number;
  minConfidence?: number;
  maxSummaryChars?: number;
  maxDetails?: number;
  maxDetailChars?: number;
}

function isPositiveDimension(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_DIMENSION;
}

export function isAoiScreenVisionFrameValid(
  frame: AoiScreenVisionFrame | null | undefined,
): boolean {
  if (!frame || frame.version !== 1) {
    return false;
  }
  if (!isPositiveDimension(frame.width) || !isPositiveDimension(frame.height)) {
    return false;
  }
  if (
    typeof frame.capturedAt !== 'number' ||
    !Number.isFinite(frame.capturedAt) ||
    frame.capturedAt <= 0
  ) {
    return false;
  }
  if (typeof frame.frameHandle !== 'string' || frame.frameHandle.trim().length === 0) {
    return false;
  }
  if (frame.appId !== undefined && !APP_ID_PATTERN.test(frame.appId)) {
    return false;
  }
  return true;
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function boundedString(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxChars ? normalized : normalized.slice(0, maxChars).trimEnd();
}

function boundedDetails(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    const bounded = boundedString(item, maxChars);
    if (bounded.length > 0) {
      out.push(bounded);
    }
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

async function callWithTimeout(
  backend: AoiScreenVisionBackend,
  frame: AoiScreenVisionFrame,
  timeoutMs: number,
): Promise<{ ok: true; value: AoiScreenVisionRawResponse | null } | { ok: false; reason: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; reason: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), Math.max(1, timeoutMs));
  });
  try {
    const call = backend
      .describe(frame)
      .then((value) => ({ ok: true as const, value }))
      .catch(() => ({ ok: false as const, reason: 'backend_error' }));
    return await Promise.race([call, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

// Describe one focused-window frame through the injected backend. Pure w.r.t.
// the backend (all model I/O lives inside it); fail-closed on every error path.
export async function describeAoiScreenVisionFrame(
  frame: AoiScreenVisionFrame,
  options: AoiScreenVisionDescribeOptions = {},
): Promise<AoiScreenVisionOutcome> {
  if (!isAoiScreenVisionFrameValid(frame)) {
    return { status: 'failed', reason: 'invalid_frame' };
  }
  const backend = options.backend;
  if (!backend || typeof backend.describe !== 'function') {
    return { status: 'unavailable', reason: 'no_backend' };
  }
  const now = options.now ?? Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const maxSummaryChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  const maxDetails = options.maxDetails ?? DEFAULT_MAX_DETAILS;
  const maxDetailChars = options.maxDetailChars ?? DEFAULT_MAX_DETAIL_CHARS;

  const called = await callWithTimeout(backend, frame, timeoutMs);
  if (!called.ok) {
    return { status: 'failed', reason: called.reason };
  }
  const raw = called.value;
  if (!raw || typeof raw !== 'object') {
    return { status: 'unavailable', reason: 'no_result' };
  }

  const summary = boundedString(raw.summary, maxSummaryChars);
  if (summary.length === 0) {
    return { status: 'failed', reason: 'malformed_result' };
  }
  const confidence = clampConfidence(raw.confidence);
  if (confidence < minConfidence) {
    return { status: 'unavailable', reason: 'low_confidence' };
  }
  const modelId = boundedString(raw.modelId, 80) || backend.modelId;
  const appLabel = boundedString(raw.appLabel, 120);
  const result: AoiScreenVisionResult = {
    version: 1,
    channel: backend.channel,
    modelId,
    summary,
    details: boundedDetails(raw.details, maxDetails, maxDetailChars),
    appLabel: appLabel.length > 0 ? appLabel : null,
    confidence,
    producedAt: now,
  };
  return { status: 'described', result };
}

// Build a backend from an injected invoker (the common factory).
export function buildAoiScreenVisionBackend(params: {
  channel: AoiScreenVisionChannel;
  modelId: string;
  invoke: AoiScreenVisionInvoker;
}): AoiScreenVisionBackend {
  const modelId = params.modelId.trim() || 'unknown';
  return {
    channel: params.channel,
    modelId,
    describe: (frame) => params.invoke(frame),
  };
}

// Local VLM backend (default channel). The invoker runs a model on-device; on
// this path pixels never leave the machine.
export function buildAoiLocalScreenVisionBackend(params: {
  modelId: string;
  invoke: AoiScreenVisionInvoker;
}): AoiScreenVisionBackend {
  return buildAoiScreenVisionBackend({
    channel: 'local',
    modelId: params.modelId,
    invoke: params.invoke,
  });
}

// Cloud vision backend, OPT-IN by construction: when allowCloud is not exactly
// true this returns the INERT backend, so pixels never reach a cloud API
// without an explicit opt-in.
export function buildAoiCloudScreenVisionBackend(params: {
  modelId: string;
  invoke: AoiScreenVisionInvoker;
  allowCloud: boolean;
}): AoiScreenVisionBackend {
  if (params.allowCloud !== true) {
    return AOI_INERT_SCREEN_VISION_BACKEND;
  }
  return buildAoiScreenVisionBackend({
    channel: 'cloud',
    modelId: params.modelId,
    invoke: params.invoke,
  });
}

// Pick the backend to use: local is the default; cloud is used ONLY when it is
// explicitly opted in AND preferred AND present. Absent everything -> inert.
export function selectAoiScreenVisionBackend(params: {
  local?: AoiScreenVisionBackend | null;
  cloud?: AoiScreenVisionBackend | null;
  preferCloud?: boolean;
  allowCloud?: boolean;
}): AoiScreenVisionBackend {
  if (params.allowCloud === true && params.preferCloud === true && params.cloud) {
    return params.cloud;
  }
  if (params.local) {
    return params.local;
  }
  return AOI_INERT_SCREEN_VISION_BACKEND;
}
