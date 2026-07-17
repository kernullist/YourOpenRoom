import type { AoiNonVoiceJarvisScorecard } from './aoiNonVoiceJarvisScorecard';
import {
  buildAoiNonVoiceScorecardRoute,
  parseAoiNonVoiceScorecardResponse,
  type AoiNonVoiceScorecardPanelResult,
} from './aoiNonVoiceScorecardPanelModel';

const LIVE_FIELD_TRUTH_TIMEOUT_MS = 20_000;

export interface LoadAoiLiveFieldTruthOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function hasAoiNonVoiceSubject(message: string): boolean {
  return /(?:\baoi\b|\bjarvis\b|자비스|비음성|non[\s-]?voice|live[\s-]?field|라이브[\s-]?필드)/i.test(
    message,
  );
}

function hasScorecardIntent(message: string): boolean {
  return /(?:현재|최신|점수|판정|상태|진척|증거|근접|얼마나|하드\s*게이트|게이트|90\s*\+?|90\s*%|current|latest|score|status|progress|evidence|close|near|hard[\s-]?gate|claim)/i.test(
    message,
  );
}

function formatTimestamp(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'none';
  }
  return new Date(value).toISOString();
}

function normalizeScore(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : String(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsCurrentScore(content: string, value: string): boolean {
  const exactNumber = `(?:^|[^0-9.])${escapeRegExp(value)}(?=$|[^0-9.])`;
  return new RegExp(
    `(?:current\\s+(?:live[\\s-]?field\\s+)?score|(?:live[\\s-]?field\\s+)?score|현재[^\\n]{0,24}점수|점수)[^\\n]{0,32}(?:\\n[^\\n]{0,24})?${exactNumber}`,
    'i',
  ).test(content);
}

function containsCurrentLevel(content: string, value: string): boolean {
  return new RegExp(
    `(?:current\\s+judg(?:e)?ment|level|현재[^\\n]{0,16}(?:판정|등급)|판정|등급)[^\\n]{0,24}(?:\\n[^\\n]{0,24})?\\b${escapeRegExp(value)}\\b`,
    'i',
  ).test(content);
}

export function shouldLoadAoiLiveFieldTruth(message: string): boolean {
  const normalized = message.trim();
  return (
    normalized.length > 0 && hasAoiNonVoiceSubject(normalized) && hasScorecardIntent(normalized)
  );
}

export function buildAoiLiveFieldTruthPrompt(scorecard: AoiNonVoiceJarvisScorecard): string {
  const failedGates = scorecard.hardGates.filter((gate) => !gate.passed);
  const passedGates = scorecard.hardGates.filter((gate) => gate.passed);
  const minimumEvidenceBlockers = scorecard.axes.filter((axis) => !axis.minimumEvidenceMet);

  return [
    '',
    'Canonical Aoi non-voice live-field truth (authoritative, read-only):',
    `- Snapshot generatedAt: ${formatTimestamp(scorecard.generatedAt)}.`,
    `- Last validatedAt: ${formatTimestamp(scorecard.lastValidatedAt)}.`,
    `- Current score: ${normalizeScore(scorecard.score)}/100; rawScore=${normalizeScore(scorecard.rawScore)}; scoreCap=${normalizeScore(scorecard.scoreCap)}.`,
    `- Current judgment: level=${scorecard.level}; claimEligible=${scorecard.claimEligible}; evidenceClass=${scorecard.evidenceClass}; voiceExcluded=true.`,
    `- Passed hard gates (${passedGates.length}): ${passedGates.map((gate) => `${gate.id} (${gate.label})`).join('; ') || 'none'}.`,
    `- Failed hard gates (${failedGates.length}):`,
    ...(failedGates.length > 0
      ? failedGates.map((gate) => `  - ${gate.id} (${gate.label}): ${gate.reason}`)
      : ['  - none']),
    `- Axes below minimum evidence (${minimumEvidenceBlockers.length}):`,
    ...(minimumEvidenceBlockers.length > 0
      ? minimumEvidenceBlockers.map(
          (axis) =>
            `  - ${axis.id}: blockers=${axis.blockers.join(' | ') || 'unspecified'}; next=${axis.nextEvidenceAction}`,
        )
      : ['  - none']),
    `- Canonical next actions: ${scorecard.recommendations.join(' | ') || 'none'}.`,
    '- This snapshot overrides older progress-ledger or document values when the user asks for the current score, judgment, or failed gates.',
    '- Historical documents may be cited only as history. Never label an older score or older gate state as current.',
    '- If creating a current-status artifact, include the exact current score, level, claimEligible value, and every current failed hard-gate id from this snapshot.',
  ].join('\n');
}

export function buildAoiLiveFieldTruthUnavailablePrompt(reason: string): string {
  return [
    '',
    'Canonical Aoi non-voice live-field truth is required for this request but could not be loaded.',
    `- Load failure: ${reason}`,
    '- Do not present a score or hard-gate state from a historical progress document as current.',
    '- State that current live verification is unavailable, and do not complete a current-status artifact until the canonical scorecard can be read.',
  ].join('\n');
}

export async function loadAoiLiveFieldTruth(
  sessionPath: string,
  options: LoadAoiLiveFieldTruthOptions = {},
): Promise<AoiNonVoiceScorecardPanelResult> {
  const controller = new AbortController();
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? LIVE_FIELD_TRUTH_TIMEOUT_MS);
  let timedOut = false;
  const handleParentAbort = () => {
    controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) {
    handleParentAbort();
  } else {
    options.signal?.addEventListener('abort', handleParentAbort, { once: true });
  }
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(buildAoiNonVoiceScorecardRoute(sessionPath, 'live_field'), {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`canonical scorecard request failed with ${response.status}`);
    }
    const payload = await response.json();
    const parsed = parseAoiNonVoiceScorecardResponse(payload, sessionPath, 'live_field');
    if (!parsed) {
      throw new Error('canonical scorecard response failed validation');
    }
    return parsed;
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? error;
    }
    if (timedOut) {
      throw new Error(`canonical scorecard request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    options.signal?.removeEventListener('abort', handleParentAbort);
  }
}

export function verifyAoiLiveFieldArtifactFacts(
  content: string,
  scorecard: AoiNonVoiceJarvisScorecard,
): string[] {
  const issues: string[] = [];
  const expectedScore = normalizeScore(scorecard.score);
  if (!containsCurrentScore(content, expectedScore)) {
    issues.push(`read-back content does not contain the current score ${expectedScore}`);
  }
  if (!containsCurrentLevel(content, scorecard.level)) {
    issues.push(`read-back content does not contain the current level ${scorecard.level}`);
  }
  const claimEligiblePattern = new RegExp(
    `(?:claim\\s*eligible|claimEligible)[^\\n]{0,16}\\b${scorecard.claimEligible}\\b`,
    'i',
  );
  if (!claimEligiblePattern.test(content)) {
    issues.push(
      `read-back content does not contain the current claimEligible value ${scorecard.claimEligible}`,
    );
  }
  scorecard.failedHardGateIds.forEach((gateId) => {
    if (!content.includes(gateId)) {
      issues.push(`read-back content is missing failed hard gate ${gateId}`);
    }
  });
  return issues;
}
