// Aoi host-bridge desktop activity (HP4): the metadata-only ingestion + summary
// layer for "what the operator is actually doing on the PC" -- the foreground
// app, focus switches, and idle time -- so Aoi can learn interests from real
// work (docs/aoi-host-access-design.md).
//
// Capture is done OUTSIDE this module: a native helper (Phase 2, C++
// SetWinEventHook) or a Phase-1 PowerShell poller observes the foreground window
// and POSTs metadata samples to the daemon; this module normalizes, redacts, and
// summarizes them. Keeping the capture in a separate process is deliberate
// (crash isolation + privilege separation).
//
// Safety posture (load-bearing):
//   - METADATA ONLY: a sample is { appName, focused, idleMs, observedAt } plus an
//     OPTIONAL windowTitle that is dropped STRUCTURALLY unless the operator has
//     turned on the window-title sub-toggle. When on, the title is redacted
//     (paths / emails / tokens masked). Everything is bounded.
//   - The `desktop-activity` environment source (default OFF, private,
//     explicit_target) gates whether any of this is captured/read at all.
//   - Interest signals derived here are OBSERVATION ONLY. Turning "spends time in
//     Ghidra" into a stored preference still requires the taste-poll / explicit
//     confirmation path -- implicit observation never auto-promotes a preference.
//
// PURE + client-safe (no fs/crypto/child_process): only string redaction. The
// daemon persists samples via its own store / the activity pipeline.
import { redactAoiSensitiveContent } from './aoiMemoryShared';

const MAX_APP_NAME_CHARS = 80;
const MAX_TITLE_CHARS = 160;
const MAX_TOP_APPS = 12;
const MAX_IDLE_MS = 24 * 60 * 60 * 1000;

export interface AoiDesktopActivitySampleInput {
  appName?: unknown;
  windowTitle?: unknown;
  focused?: unknown;
  idleMs?: unknown;
  observedAt?: unknown;
}

// Metadata-only. windowTitle is present ONLY when the operator enabled title
// capture; otherwise the field does not exist (structural privacy boundary).
export interface AoiDesktopActivitySample {
  version: 1;
  appName: string;
  windowTitle?: string;
  focused: boolean;
  idleMs: number;
  observedAt: number;
  privacyState: 'metadata_only';
}

export interface AoiDesktopActivityAppFocus {
  appName: string;
  focusedCount: number;
  lastObservedAt: number;
}

export interface AoiDesktopActivitySummary {
  version: 1;
  generatedAt: number;
  totalSamples: number;
  activeAppName: string | null;
  topApps: AoiDesktopActivityAppFocus[];
  lastObservedAt: number | null;
  lastIdleMs: number | null;
  cannotKnow: string[];
}

export interface NormalizeAoiDesktopActivityOptions {
  // The window-title sub-toggle. Default false -> titles are dropped entirely.
  captureWindowTitles?: boolean;
  now?: number;
}

const REDACTED_TITLE_TOKEN = '[redacted]';

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// Window titles are a privacy hotspot: they routinely embed emails, absolute
// file paths, and URLs (docs/aoi-host-access-design.md T6). The shared secret
// redactor only masks keys/tokens, so titles additionally mask those three
// classes on top of it before a title is ever stored.
export function redactAoiDesktopTitle(value: string): string {
  return redactAoiSensitiveContent(value)
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, REDACTED_TITLE_TOKEN)
    .replace(/\bhttps?:\/\/[^\s]+/gi, REDACTED_TITLE_TOKEN)
    .replace(/\b[A-Za-z]:\\(?:[^\\\r\n|<>]*\\)*[^\s\\\r\n|<>]*/g, REDACTED_TITLE_TOKEN)
    .replace(/(?:^|\s)\/(?:[^\s/|<>]+\/)+[^\s/|<>]*/g, ' ' + REDACTED_TITLE_TOKEN);
}

// Reduce a raw foreground identifier to a bounded app/image name. A path is
// stripped to its final segment so nothing resembling a directory is retained.
function normalizeAppName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const lastSegment = value.split(/[\\/]/).pop() ?? value;
  const normalized = normalizeWhitespace(lastSegment).slice(0, MAX_APP_NAME_CHARS);
  return normalized.length > 0 ? normalized : null;
}

function normalizeIdleMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(MAX_IDLE_MS, Math.round(value));
}

// Normalize one raw foreground sample to a metadata-only event, or null when it
// carries no usable app name. The window title is included ONLY when title
// capture is enabled, and is redacted even then.
export function normalizeAoiDesktopActivitySample(
  input: AoiDesktopActivitySampleInput | null | undefined,
  options: NormalizeAoiDesktopActivityOptions = {},
): AoiDesktopActivitySample | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const appName = normalizeAppName(input.appName);
  if (!appName) {
    return null;
  }
  const now = options.now ?? 0;
  const observedAt =
    typeof input.observedAt === 'number' && Number.isFinite(input.observedAt)
      ? Math.round(input.observedAt)
      : now;
  const sample: AoiDesktopActivitySample = {
    version: 1,
    appName,
    focused: input.focused !== false,
    idleMs: normalizeIdleMs(input.idleMs),
    observedAt,
    privacyState: 'metadata_only',
  };
  if (options.captureWindowTitles === true && typeof input.windowTitle === 'string') {
    const title = normalizeWhitespace(redactAoiDesktopTitle(input.windowTitle)).slice(
      0,
      MAX_TITLE_CHARS,
    );
    if (title) {
      sample.windowTitle = title;
    }
  }
  return sample;
}

// Build a foreground-usage summary: which apps the operator has been focused in,
// ranked by focus-sample count -- the raw taste signal ("most time in X"). The
// newest focused sample's app is the active app. Consent/idle handling is the
// caller's concern; this is pure aggregation.
export function summarizeAoiDesktopActivity(
  samples: readonly AoiDesktopActivitySample[],
  now: number,
): AoiDesktopActivitySummary {
  const byApp = new Map<
    string,
    { appName: string; focusedCount: number; lastObservedAt: number }
  >();
  let lastObservedAt: number | null = null;
  let lastIdleMs: number | null = null;
  let activeAppName: string | null = null;

  const ordered = [...samples].sort((left, right) => left.observedAt - right.observedAt);
  for (const sample of ordered) {
    lastObservedAt = sample.observedAt;
    lastIdleMs = sample.idleMs;
    if (sample.focused) {
      activeAppName = sample.appName;
      const key = sample.appName.toLowerCase();
      const entry = byApp.get(key) ?? {
        appName: sample.appName,
        focusedCount: 0,
        lastObservedAt: sample.observedAt,
      };
      entry.focusedCount += 1;
      entry.lastObservedAt = Math.max(entry.lastObservedAt, sample.observedAt);
      byApp.set(key, entry);
    }
  }

  const topApps = [...byApp.values()]
    .sort(
      (left, right) =>
        right.focusedCount - left.focusedCount ||
        right.lastObservedAt - left.lastObservedAt ||
        left.appName.localeCompare(right.appName),
    )
    .slice(0, MAX_TOP_APPS);

  const cannotKnow: string[] =
    ordered.length === 0
      ? ['Aoi cannot know desktop activity because no foreground samples have been observed.']
      : [];

  return {
    version: 1,
    generatedAt: now,
    totalSamples: ordered.length,
    activeAppName,
    topApps,
    lastObservedAt,
    lastIdleMs,
    cannotKnow,
  };
}

// Compact, observation-only interest labels derived from the summary. These are
// SIGNALS for the interest/taste pipeline, never stored preferences on their own
// (promotion still goes through the taste poll / explicit confirmation).
export function deriveAoiDesktopInterestSignals(summary: AoiDesktopActivitySummary): string[] {
  return summary.topApps
    .slice(0, 5)
    .map((app) => `Spends foreground time in ${app.appName} (${app.focusedCount} samples).`);
}
