// Aoi cognition-readiness scorecard (SA5.1): measures GROUNDING ACCURACY --
// how well Aoi's picture of "now" is evidence-cited, fresh, complete, and
// actually consumed by proactive output. Parallel to the Jarvis (trust)
// readiness scorecard, which measures whether Aoi may act; this one measures
// whether Aoi actually KNOWS what is happening.
//
// Rules (load-bearing):
// - Hard grounding gates BLOCK, never lift: an uncited segment, an uncited
//   current intent, or a stale-fresh claim zeroes the level (tighten-only --
//   the consumer may only use this to HOLD trust, mirroring closedLoopMetrics).
// - Null samples gate nothing: no recent proposals -> the live-citation
//   metric reports no_sample instead of failing (the null-sample = no-gate
//   rule from the promotion scorecard).
// - Pure + display-only: no I/O; display_only + mutationCount 0 on the record.
import { normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';
import type { AoiProposal } from './aoiAutonomyTypes';
import type {
  AoiCurrentSituation,
  AoiCurrentSituationSegment,
  AoiCurrentSituationSegmentKind,
} from './aoiCurrentSituationModel';
import type { AoiIntentState } from './aoiIntentInference';

export const AOI_COGNITION_PROPOSAL_CITATION_TARGET = 0.8;
export const AOI_COGNITION_PROPOSAL_CITATION_FLOOR = 0.5;
export const AOI_COGNITION_SOURCE_COVERAGE_TARGET = 0.75;
export const AOI_COGNITION_SAMPLE_TARGET = 3;
export const AOI_COGNITION_GROUNDED_SCORE = 70;
export const AOI_COGNITION_LIVE_GROUNDED_SCORE = 85;
const RECENT_PROPOSAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const FADED_SALIENCE_FLOOR = 0.02;

export type AoiCognitionReadinessLevel =
  | 'ungrounded'
  | 'sensing'
  | 'inferring'
  | 'grounded'
  | 'live_grounded';

export type AoiCognitionMetricStatus = 'pass' | 'warning' | 'blocked' | 'no_sample';

export interface AoiCognitionReadinessMetric {
  key: string;
  label: string;
  value: number | null;
  target: number;
  floor: number;
  status: AoiCognitionMetricStatus;
  detail: string;
}

export interface AoiCognitionReadinessGate {
  key: string;
  blocked: boolean;
  detail: string;
}

export type AoiCognitionSourceDiagnosticStatus =
  | 'disabled'
  | 'consent_missing'
  | 'missing'
  | 'stale'
  | 'fresh';

export interface AoiCognitionSourceCoverageInput {
  sourceId: string;
  label?: string;
  enabled: boolean;
  consented: boolean;
  policyReasons?: string[];
}

export interface AoiCognitionSourceDiagnostic {
  version: 1;
  sourceId: string;
  label: string;
  segmentKind: AoiCurrentSituationSegmentKind;
  enabled: boolean;
  consented: boolean;
  represented: boolean;
  fresh: boolean;
  status: AoiCognitionSourceDiagnosticStatus;
  policyReasons: string[];
  evidenceRefs: string[];
  detail: string;
}

export interface AoiCognitionReadinessScorecard {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  score: number;
  level: AoiCognitionReadinessLevel;
  gateStatus: 'pass' | 'warning' | 'blocked';
  // Tighten-only signal for the trust-promotion path: false means the
  // grounding gates failed and cognition evidence must HOLD promotion.
  canSupportPromotion: boolean;
  metrics: AoiCognitionReadinessMetric[];
  gates: AoiCognitionReadinessGate[];
  sourceDiagnostics: AoiCognitionSourceDiagnostic[];
  recommendations: string[];
  evidenceRefs: string[];
  cannotKnow: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiCognitionReadinessInput {
  sessionPath: string;
  now?: number;
  situation?: AoiCurrentSituation | null;
  // How many situation briefs exist in the bounded history (grounding practice).
  situationSampleCount?: number;
  intentState?: AoiIntentState | null;
  // Recent proposals (active + archived), used for the live-citation rate.
  proposals?: AoiProposal[];
  // Source ids the operator has consented that CAN appear as situation
  // segments (the coverage denominator). Supplied by the caller from the
  // registry so this module stays pure.
  consentedSituationSourceIds?: string[];
  // Authoritative per-source policy checks from the server. This is preferred
  // over consentedSituationSourceIds because enabled and consented are distinct
  // states for private or explicit-target sources.
  sourceCoverage?: AoiCognitionSourceCoverageInput[];
}

// Which consented sources are expected to appear as which segment kinds.
export const AOI_COGNITION_SOURCE_SEGMENT_KIND: Readonly<
  Record<string, AoiCurrentSituationSegmentKind>
> = {
  'workspace-git': 'workspace',
  'workspace-build': 'workspace',
  'app-activity': 'activity',
  'calendar-metadata': 'calendar',
  'research-runs': 'research',
};

function findRepresentingSegment(params: {
  situation: AoiCurrentSituation | null;
  sourceId: string;
  segmentKind: AoiCurrentSituationSegmentKind;
  legacyKindFallback: boolean;
}): AoiCurrentSituationSegment | null {
  const candidates = (params.situation?.segments ?? []).filter(
    (segment) => segment.kind === params.segmentKind,
  );
  const sourceRef = `environment-source:${params.sourceId}`;
  const exact = candidates.find((segment) => segment.evidenceRefs.includes(sourceRef));
  if (exact) {
    return exact;
  }
  // Research has one canonical source and older persisted situation briefs did
  // not carry an environment-source ref. Keep those readable without letting
  // ambiguous workspace sources impersonate each other.
  if (params.sourceId === 'research-runs') {
    return candidates[0] ?? null;
  }
  return params.legacyKindFallback ? (candidates[0] ?? null) : null;
}

function buildSourceDiagnostics(params: {
  input: AoiCognitionReadinessInput;
  situation: AoiCurrentSituation | null;
}): AoiCognitionSourceDiagnostic[] {
  const hasAuthoritativeCoverage = Array.isArray(params.input.sourceCoverage);
  const rawSources: AoiCognitionSourceCoverageInput[] = hasAuthoritativeCoverage
    ? (params.input.sourceCoverage ?? [])
    : dedupeStrings(params.input.consentedSituationSourceIds ?? [], 16).map((sourceId) => ({
        sourceId,
        enabled: true,
        consented: true,
        policyReasons: [] as string[],
      }));
  const seen = new Set<string>();
  const diagnostics: AoiCognitionSourceDiagnostic[] = [];
  for (const source of rawSources) {
    const sourceId = typeof source.sourceId === 'string' ? source.sourceId.trim() : '';
    const segmentKind = AOI_COGNITION_SOURCE_SEGMENT_KIND[sourceId];
    if (!sourceId || !segmentKind || seen.has(sourceId)) {
      continue;
    }
    seen.add(sourceId);
    const segment = findRepresentingSegment({
      situation: params.situation,
      sourceId,
      segmentKind,
      legacyKindFallback: !hasAuthoritativeCoverage,
    });
    const enabled = source.enabled === true;
    const consented = source.consented === true;
    const represented = segment !== null;
    const fresh = represented && segment.freshness === 'fresh';
    const status: AoiCognitionSourceDiagnosticStatus = !enabled
      ? 'disabled'
      : !consented
        ? 'consent_missing'
        : !represented
          ? 'missing'
          : !fresh
            ? 'stale'
            : 'fresh';
    const detail =
      status === 'disabled'
        ? 'Source is disabled.'
        : status === 'consent_missing'
          ? 'Source is enabled but its policy consent gate is not satisfied.'
          : status === 'missing'
            ? 'Source is consented but no matching situation segment is represented.'
            : status === 'stale'
              ? 'Source is represented, but the matching situation segment is not fresh.'
              : 'Source is consented and represented by a fresh situation segment.';
    diagnostics.push({
      version: 1,
      sourceId,
      label:
        typeof source.label === 'string' && source.label.trim() ? source.label.trim() : sourceId,
      segmentKind,
      enabled,
      consented,
      represented,
      fresh,
      status,
      policyReasons: dedupeStrings(source.policyReasons ?? [], 6),
      evidenceRefs: segment?.evidenceRefs.slice(0, 8) ?? [],
      detail,
    });
    if (diagnostics.length >= 16) {
      break;
    }
  }
  return diagnostics;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function dedupeStrings(values: Array<string | undefined | null>, maxItems: number): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

export function buildAoiCognitionReadinessScorecard(
  input: AoiCognitionReadinessInput,
): AoiCognitionReadinessScorecard {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = input.now ?? Date.now();
  const situation = input.situation ?? null;
  const situationFresh = situation !== null && situation.staleAt > now;
  const metrics: AoiCognitionReadinessMetric[] = [];
  const gates: AoiCognitionReadinessGate[] = [];
  const recommendations: string[] = [];
  const cannotKnow: string[] = [];

  // --- 1. Grounded citation rate (hard invariant: every segment cites).
  const segmentCount = situation?.segments.length ?? 0;
  const citedSegmentCount =
    situation?.segments.filter((segment) => segment.evidenceRefs.length > 0).length ?? 0;
  const citationRate = segmentCount > 0 ? citedSegmentCount / segmentCount : null;
  const uncitedSegments = segmentCount - citedSegmentCount;
  metrics.push({
    key: 'grounded_citation_rate',
    label: 'Situation segments carrying evidence',
    value: citationRate,
    target: 1,
    floor: 1,
    status: citationRate === null ? 'no_sample' : uncitedSegments > 0 ? 'blocked' : 'pass',
    detail:
      citationRate === null
        ? 'No situation segments exist yet.'
        : `${citedSegmentCount}/${segmentCount} segments cite evidence.`,
  });
  gates.push({
    key: 'uncited_segment_zero',
    blocked: uncitedSegments > 0,
    detail:
      uncitedSegments > 0
        ? `${uncitedSegments} situation segment(s) carry no evidence refs.`
        : 'Every situation segment cites evidence.',
  });

  // --- 2. Stale-fresh claims (hard gate zero): a fresh-labeled segment whose
  // salience has fully faded is claiming currency it cannot ground.
  const staleClaims =
    situation?.segments.filter(
      (segment) => segment.freshness === 'fresh' && segment.salienceScore < FADED_SALIENCE_FLOOR,
    ).length ?? 0;
  metrics.push({
    key: 'stale_claim_count',
    label: 'Fresh claims with faded salience',
    value: segmentCount > 0 ? staleClaims : null,
    target: 0,
    floor: 0,
    status: segmentCount === 0 ? 'no_sample' : staleClaims > 0 ? 'blocked' : 'pass',
    detail:
      staleClaims > 0
        ? `${staleClaims} segment(s) claim freshness with faded salience.`
        : 'No stale-fresh claims.',
  });
  gates.push({
    key: 'stale_claim_zero',
    blocked: staleClaims > 0,
    detail: staleClaims > 0 ? 'A fresh claim has fully faded salience.' : 'No stale-fresh claims.',
  });

  // --- 3. Intent grounding (hard invariant when a current intent exists).
  const intent = input.intentState?.current ?? null;
  const intentCited = intent ? intent.evidenceRefs.length > 0 : null;
  metrics.push({
    key: 'intent_evidence_rate',
    label: 'Current intent carries evidence',
    value: intentCited === null ? null : intentCited ? 1 : 0,
    target: 1,
    floor: 1,
    status: intentCited === null ? 'no_sample' : intentCited ? 'pass' : 'blocked',
    detail:
      intentCited === null
        ? 'No current intent is claimed.'
        : intentCited
          ? 'The current intent cites evidence.'
          : 'The current intent carries no evidence refs.',
  });
  gates.push({
    key: 'uncited_intent_zero',
    blocked: intentCited === false,
    detail:
      intentCited === false
        ? 'A current intent is claimed without evidence.'
        : 'Intent claims are grounded.',
  });

  // --- 4. Source coverage: consented sources actually represented in the fusion.
  const sourceDiagnostics = buildSourceDiagnostics({ input, situation });
  const consentedDiagnostics = sourceDiagnostics.filter((source) => source.consented);
  const coveredDiagnostics = consentedDiagnostics.filter((source) => source.fresh);
  const coverageRate =
    consentedDiagnostics.length > 0
      ? coveredDiagnostics.length / consentedDiagnostics.length
      : null;
  metrics.push({
    key: 'source_coverage_rate',
    label: 'Consented sources represented in the fusion',
    value: coverageRate,
    target: AOI_COGNITION_SOURCE_COVERAGE_TARGET,
    floor: 0.25,
    status:
      coverageRate === null
        ? 'no_sample'
        : coverageRate >= AOI_COGNITION_SOURCE_COVERAGE_TARGET
          ? 'pass'
          : 'warning',
    detail:
      coverageRate === null
        ? 'No consented situation-capable sources.'
        : `${coveredDiagnostics.length}/${consentedDiagnostics.length} consented sources appear as fresh segments.`,
  });
  if (coverageRate !== null && coverageRate < AOI_COGNITION_SOURCE_COVERAGE_TARGET) {
    recommendations.push(
      'Some consented sources produced no situation segment; check that their signals are flowing.',
    );
  }
  if (sourceDiagnostics.some((source) => source.status === 'consent_missing')) {
    recommendations.push(
      'One or more enabled sources still require explicit operator consent before they can ground cognition.',
    );
  }
  if (sourceDiagnostics.some((source) => source.status === 'stale')) {
    recommendations.push('Refresh stale consented sources before relying on the situation brief.');
  }

  // --- 5. Situation practice: how many briefs have ever been fused.
  const sampleCount = Math.max(0, Math.trunc(input.situationSampleCount ?? 0));
  metrics.push({
    key: 'situation_sample_count',
    label: 'Fused situation briefs recorded',
    value: sampleCount,
    target: AOI_COGNITION_SAMPLE_TARGET,
    floor: 1,
    status: sampleCount >= AOI_COGNITION_SAMPLE_TARGET ? 'pass' : 'warning',
    detail: `${sampleCount} situation brief(s) recorded.`,
  });
  if (sampleCount === 0) {
    recommendations.push('No situation brief has been fused yet; run an autonomy wakeup.');
  }

  // --- 6. Proactive live-citation rate (null sample gates nothing).
  const recentProposals = (input.proposals ?? []).filter((proposal) => {
    const trigger = typeof proposal.trigger === 'string' ? proposal.trigger : '';
    return (
      now - proposal.createdAt <= RECENT_PROPOSAL_WINDOW_MS &&
      trigger !== 'manual' &&
      trigger !== 'goal_candidate' &&
      !trigger.startsWith('user_authorized_')
    );
  });
  const citedProposals = recentProposals.filter((proposal) =>
    proposal.evidenceRefs.some(
      (ref) => ref.startsWith('situation:') || ref.startsWith('activity:'),
    ),
  );
  const proposalCitationRate =
    recentProposals.length > 0 ? citedProposals.length / recentProposals.length : null;
  metrics.push({
    key: 'proposal_live_citation_rate',
    label: 'Recent proposals citing live context',
    value: proposalCitationRate,
    target: AOI_COGNITION_PROPOSAL_CITATION_TARGET,
    floor: AOI_COGNITION_PROPOSAL_CITATION_FLOOR,
    status:
      proposalCitationRate === null
        ? 'no_sample'
        : proposalCitationRate >= AOI_COGNITION_PROPOSAL_CITATION_TARGET
          ? 'pass'
          : proposalCitationRate >= AOI_COGNITION_PROPOSAL_CITATION_FLOOR
            ? 'warning'
            : 'blocked',
    detail:
      proposalCitationRate === null
        ? 'No proactive proposals were authored in the last 24h.'
        : `${citedProposals.length}/${recentProposals.length} recent proactive proposals cite live context.`,
  });
  gates.push({
    key: 'proposal_live_citation_floor',
    blocked:
      proposalCitationRate !== null && proposalCitationRate < AOI_COGNITION_PROPOSAL_CITATION_FLOOR,
    detail:
      proposalCitationRate !== null && proposalCitationRate < AOI_COGNITION_PROPOSAL_CITATION_FLOOR
        ? 'Recent proposals mostly ignore the live context.'
        : 'Proposal live-citation is at or above the floor (or has no sample).',
  });

  if (!situation) {
    cannotKnow.push('No current-situation brief exists; grounding cannot be measured fully.');
  } else if (!situationFresh) {
    cannotKnow.push('The current-situation brief is stale; live grounding cannot be claimed.');
    recommendations.push('Run an autonomy wakeup to fuse a fresh situation brief.');
  }
  cannotKnow.push(...(situation?.cannotKnow.slice(0, 4) ?? []));

  const anyBlocked = gates.some((gate) => gate.blocked);
  const anyWarning = metrics.some((metric) => metric.status === 'warning');

  // --- Score: deterministic weighted composition (0..100).
  const scoreParts: number[] = [];
  scoreParts.push(citationRate === null ? 0 : citationRate * 30);
  scoreParts.push(segmentCount === 0 ? 0 : staleClaims === 0 ? 15 : 0);
  scoreParts.push(intent ? (intentCited ? 15 : 0) : 0);
  scoreParts.push(coverageRate === null ? 0 : coverageRate * 15);
  scoreParts.push(clamp(sampleCount / AOI_COGNITION_SAMPLE_TARGET, 0, 1) * 10);
  scoreParts.push(proposalCitationRate === null ? 0 : proposalCitationRate * 15);
  const score = anyBlocked
    ? Math.min(30, Math.round(scoreParts.reduce((sum, part) => sum + part, 0)))
    : Math.round(scoreParts.reduce((sum, part) => sum + part, 0));

  // --- Level ladder.
  let level: AoiCognitionReadinessLevel = 'ungrounded';
  if (!anyBlocked && situation && situationFresh && segmentCount > 0) {
    level = 'sensing';
    if (intent && intentCited) {
      level = 'inferring';
    }
    if (level === 'inferring' && score >= AOI_COGNITION_GROUNDED_SCORE && sampleCount >= 1) {
      level = 'grounded';
    }
    if (
      level === 'grounded' &&
      score >= AOI_COGNITION_LIVE_GROUNDED_SCORE &&
      situation.segments.some(
        (segment) => segment.kind === 'activity' && segment.freshness === 'fresh',
      ) &&
      (proposalCitationRate === null ||
        proposalCitationRate >= AOI_COGNITION_PROPOSAL_CITATION_TARGET)
    ) {
      level = 'live_grounded';
    }
  }

  const canSupportPromotion = level === 'grounded' || level === 'live_grounded';

  return {
    version: 1,
    sessionPath,
    generatedAt: now,
    score: clamp(score, 0, 100),
    level,
    gateStatus: anyBlocked ? 'blocked' : anyWarning ? 'warning' : 'pass',
    canSupportPromotion,
    metrics,
    gates,
    sourceDiagnostics,
    recommendations: dedupeStrings(recommendations, 6),
    evidenceRefs: dedupeStrings(
      [
        ...(situation ? [`situation:${situation.id}`] : []),
        ...(situation?.evidenceRefs ?? []),
        ...(intent?.evidenceRefs ?? []),
      ],
      16,
    ),
    cannotKnow: dedupeStrings(cannotKnow, 8),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function formatAoiCognitionReadinessScorecard(
  scorecard: AoiCognitionReadinessScorecard,
): string {
  const metricLine = scorecard.metrics
    .map(
      (metric) =>
        `${metric.key}=${metric.value === null ? 'n/a' : Number(metric.value.toFixed(2))}(${metric.status})`,
    )
    .join(' ');
  return `cognition-readiness score=${scorecard.score} level=${scorecard.level} gate=${scorecard.gateStatus} ${metricLine}`;
}
