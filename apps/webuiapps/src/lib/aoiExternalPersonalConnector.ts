// P5.7: a REAL external read-only personal-signal connector (Calendar / Gmail metadata),
// scaffolded FAIL-CLOSED.
//
// Today the only genuine external read is git; calendar/email are in-app metadata and a Gmail
// "connection" is a token boolean. This adds a true liveness probe: when a live, consent-
// granted, credentialed source is wired (via an injected metadata fetcher -- the production
// hook for a real Google Calendar / Gmail account), it performs a metadata-ONLY, redacted read
// and reports liveness 'live' with a summary that aoiPersonalSourceRealityCheck can consume.
// Without that (this environment's default -- no live account), every path fails closed to
// 'disconnected'/'consent_blocked'/'error' with NO data.
//
// Safety:
//   * Metadata-ONLY: the fetch result type carries counts + titles + a timestamp and has NO
//     field for a message/event body, so a body cannot leak structurally.
//   * Redaction by default: every surfaced title passes the same secret + source-instruction
//     redaction as memory content; the summary's redactionState is always 'redacted'.
//   * Consent-gated per source: only an explicit 'metadata_allowed' consent proceeds; any other
//     state (disabled/revoked/disconnected/body_disabled/unknown) fails closed without a fetch.
//   * Fail-closed everywhere: no consent / no credentials / fetch throw or malformed result ->
//     disconnected/error, never partial data.
//
// This module performs NO network or fs itself -- the network lives in the injected fetcher --
// so it stays deterministic and unit-testable; production supplies a real fetcher.
import type { AoiPersonalSignalMetadataSummary, AoiSignalFreshness } from './aoiAutonomyTypes';
import type { AoiPersonalSourceRealityConsentState } from './aoiPersonalSourceRealityCheck';
import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';

// The external kinds this connector can probe (notes are in-app only, not external).
export type AoiExternalPersonalSourceKind = 'calendar_metadata' | 'gmail_metadata';

export type AoiExternalPersonalSourceLiveness =
  | 'live'
  | 'disconnected'
  | 'consent_blocked'
  | 'error';

// Metadata ONLY. There is deliberately NO field for a message/event body.
export interface AoiExternalPersonalMetadataFetchResult {
  // Count of relevant items (upcoming events / unread messages).
  itemCount: number;
  // Event titles / email subjects -- redacted at the boundary before surfacing.
  recentTitles: string[];
  // Newest item timestamp (ms) for freshness; optional.
  latestAt?: number;
}

// The injected live reader. Returns null when the source is unreachable. Production wires a
// real read-only Google Calendar / Gmail-metadata client here; tests inject a mock; absent ->
// the probe fails closed to 'disconnected'.
export type AoiExternalPersonalMetadataFetcher = (
  sourceKind: AoiExternalPersonalSourceKind,
) => AoiExternalPersonalMetadataFetchResult | null;

export interface AoiExternalPersonalSourceProbe {
  version: 1;
  sourceKind: AoiExternalPersonalSourceKind;
  liveness: AoiExternalPersonalSourceLiveness;
  reason: string;
  checkedAt: number;
  // Present ONLY when liveness === 'live'; null on every fail-closed path.
  summary: AoiPersonalSignalMetadataSummary | null;
}

const MAX_TITLES = 4;
const MAX_TITLE_CHARS = 120;
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;

const SOURCE_META: Record<
  AoiExternalPersonalSourceKind,
  { id: string; label: string; display: string }
> = {
  calendar_metadata: {
    id: 'calendar-external',
    label: 'Calendar (external)',
    display: 'External Calendar',
  },
  gmail_metadata: { id: 'gmail-external', label: 'Gmail (external)', display: 'External Gmail' },
};

function redactTitle(value: unknown): string {
  return stripAoiSourceInstructions(
    redactAoiSensitiveContent(typeof value === 'string' ? value : ''),
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS);
}

function freshnessFor(latestAt: number | undefined, now: number): AoiSignalFreshness {
  if (typeof latestAt !== 'number' || !Number.isFinite(latestAt)) {
    return 'unknown';
  }
  const age = now - latestAt;
  if (age < 0) {
    return 'unknown';
  }
  return age <= FRESH_MS ? 'fresh' : 'stale';
}

// Probe one external personal source. Fail-closed on consent, credentials, and fetch errors;
// returns a redacted, metadata-only summary ONLY when a live consent-granted fetch succeeds.
export function probeAoiExternalPersonalSource(params: {
  sourceKind: AoiExternalPersonalSourceKind;
  consent: AoiPersonalSourceRealityConsentState;
  fetcher?: AoiExternalPersonalMetadataFetcher | null;
  now: number;
}): AoiExternalPersonalSourceProbe {
  const base = {
    version: 1 as const,
    sourceKind: params.sourceKind,
    checkedAt: params.now,
    summary: null,
  };
  // 1. Consent gate -- only an explicit metadata_allowed proceeds. Body access is never
  //    possible here (the fetch result carries no body), so there is no body opt-in path.
  if (params.consent !== 'metadata_allowed') {
    return { ...base, liveness: 'consent_blocked', reason: `consent_${params.consent}` };
  }
  // 2. No credentialed fetcher -> fail closed (this environment's default; the real fetch
  //    activates only when a fetcher is injected).
  if (typeof params.fetcher !== 'function') {
    return { ...base, liveness: 'disconnected', reason: 'no_credentials' };
  }
  // 3. Metadata-only fetch; any throw / null / malformed result -> fail closed.
  let result: AoiExternalPersonalMetadataFetchResult | null;
  try {
    result = params.fetcher(params.sourceKind);
  } catch {
    result = null;
  }
  if (!result || typeof result.itemCount !== 'number' || !Number.isFinite(result.itemCount)) {
    return { ...base, liveness: 'error', reason: 'fetch_failed' };
  }
  // 4. Build a redacted, metadata-only summary the reality check can consume.
  const titles = (Array.isArray(result.recentTitles) ? result.recentTitles : [])
    .map(redactTitle)
    .filter((title) => title.length > 0)
    .slice(0, MAX_TITLES);
  const itemCount = Math.max(0, Math.trunc(result.itemCount));
  const meta = SOURCE_META[params.sourceKind];
  const summary: AoiPersonalSignalMetadataSummary = {
    version: 1,
    sourceId: meta.id,
    kind: params.sourceKind,
    label: meta.label,
    displayName: meta.display,
    summary: `${itemCount} item(s) via a live read-only metadata probe.`,
    relevanceText:
      titles.length > 0 ? `Recent: ${titles.join('; ')}` : 'No recent titles surfaced.',
    evidenceRefs: [`personal:${meta.id}`],
    scoreReasons: ['live_external_probe', `items_${itemCount}`],
    updatedAt: params.now,
    freshness: freshnessFor(result.latestAt, params.now),
    confidence: itemCount > 0 ? 0.6 : 0.4,
    redactionState: 'redacted',
  };
  return { ...base, liveness: 'live', reason: 'ok', summary };
}

export function isAoiExternalPersonalSourceLive(probe: AoiExternalPersonalSourceProbe): boolean {
  return probe.liveness === 'live' && probe.summary !== null;
}

// Probe several sources at once (fail-closed independently). Used by the reality check to get
// a true per-source liveness signal.
export function probeAoiExternalPersonalSources(params: {
  sources: readonly {
    sourceKind: AoiExternalPersonalSourceKind;
    consent: AoiPersonalSourceRealityConsentState;
  }[];
  fetcher?: AoiExternalPersonalMetadataFetcher | null;
  now: number;
}): AoiExternalPersonalSourceProbe[] {
  return params.sources.map((source) =>
    probeAoiExternalPersonalSource({
      sourceKind: source.sourceKind,
      consent: source.consent,
      ...(params.fetcher ? { fetcher: params.fetcher } : {}),
      now: params.now,
    }),
  );
}

// The redacted, metadata-only summaries from the LIVE probes only -- the shape
// aoiPersonalSourceRealityCheck consumes. Fail-closed probes contribute nothing.
export function liveAoiExternalPersonalSummaries(
  probes: readonly AoiExternalPersonalSourceProbe[],
): AoiPersonalSignalMetadataSummary[] {
  const out: AoiPersonalSignalMetadataSummary[] = [];
  for (const probe of probes) {
    if (probe.liveness === 'live' && probe.summary) {
      out.push(probe.summary);
    }
  }
  return out;
}
