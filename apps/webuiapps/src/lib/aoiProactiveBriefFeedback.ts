import {
  loadAoiInterestProfile,
  loadAoiProactiveBriefCandidates,
  loadAoiProactiveBriefCooldownState,
  loadAoiProactiveBriefFeedback,
  recordAoiProactiveBriefFeedback,
  saveAoiInterestProfile,
  upsertAoiProactiveBriefCandidate,
  upsertAoiProactiveBriefCooldown,
} from './aoiProactiveBriefStore';
import type {
  AoiInterestProfile,
  AoiInterestTopic,
  AoiProactiveBriefCandidate,
  AoiProactiveBriefCooldownState,
  AoiProactiveBriefFeedback,
  AoiProactiveBriefFeedbackCategory,
} from './aoiAutonomyTypes';

const DEFAULT_FEEDBACK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const TOO_FREQUENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const STALE_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export interface ApplyAoiProactiveBriefFeedbackInput {
  sessionsDir: string;
  sessionPath: string;
  briefId: string;
  category: AoiProactiveBriefFeedbackCategory;
  note?: string;
  now?: number;
  defaultCooldownMs?: number;
}

export interface AoiProactiveBriefFeedbackMutationResult {
  sessionPath: string;
  feedback: AoiProactiveBriefFeedback;
  candidate: AoiProactiveBriefCandidate;
  candidates: AoiProactiveBriefCandidate[];
  profile: AoiInterestProfile;
  cooldownState: AoiProactiveBriefCooldownState;
  allFeedback: AoiProactiveBriefFeedback[];
}

function clampScore(value: number): number {
  return Math.min(1, Math.max(0, Number(value.toFixed(3))));
}

function normalizeNote(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text ? text.slice(0, 240) : undefined;
}

function updateTopicForFeedback(
  topic: AoiInterestTopic,
  category: AoiProactiveBriefFeedbackCategory,
  now: number,
  feedbackId: string,
): AoiInterestTopic {
  if (category === 'mute_topic') {
    return {
      ...topic,
      muted: true,
      evidenceRefs: [...new Set([...topic.evidenceRefs, `feedback:${feedbackId}`])].slice(0, 24),
      updatedAt: now,
    };
  }
  if (category === 'pin_topic') {
    return {
      ...topic,
      pinned: true,
      muted: false,
      importance: clampScore(topic.importance + 0.1),
      confidence: clampScore(topic.confidence + 0.06),
      evidenceRefs: [...new Set([...topic.evidenceRefs, `feedback:${feedbackId}`])].slice(0, 24),
      updatedAt: now,
    };
  }
  if (category === 'useful' || category === 'show_more' || category === 'open_sources') {
    return {
      ...topic,
      importance: clampScore(topic.importance + 0.08),
      confidence: clampScore(topic.confidence + 0.04),
      currentInfoPreference: clampScore(topic.currentInfoPreference + 0.05),
      evidenceRefs: [...new Set([...topic.evidenceRefs, `feedback:${feedbackId}`])].slice(0, 24),
      updatedAt: now,
    };
  }
  if (category === 'wrong_topic') {
    return {
      ...topic,
      importance: clampScore(topic.importance - 0.18),
      confidence: clampScore(topic.confidence - 0.16),
      currentInfoPreference: clampScore(topic.currentInfoPreference - 0.08),
      evidenceRefs: [...new Set([...topic.evidenceRefs, `feedback:${feedbackId}`])].slice(0, 24),
      updatedAt: now,
    };
  }
  if (category === 'wrong_source') {
    return {
      ...topic,
      currentInfoPreference: clampScore(topic.currentInfoPreference - 0.08),
      evidenceRefs: [...new Set([...topic.evidenceRefs, `feedback:${feedbackId}`])].slice(0, 24),
      updatedAt: now,
    };
  }
  if (
    category === 'not_useful' ||
    category === 'show_less' ||
    category === 'too_frequent' ||
    category === 'wrong_timing' ||
    category === 'stale' ||
    category === 'unsafe'
  ) {
    return {
      ...topic,
      importance: clampScore(topic.importance - 0.08),
      currentInfoPreference: clampScore(topic.currentInfoPreference - 0.06),
      evidenceRefs: [...new Set([...topic.evidenceRefs, `feedback:${feedbackId}`])].slice(0, 24),
      updatedAt: now,
    };
  }
  return {
    ...topic,
    evidenceRefs: [...new Set([...topic.evidenceRefs, `feedback:${feedbackId}`])].slice(0, 24),
    updatedAt: now,
  };
}

function updateCandidateForFeedback(
  candidate: AoiProactiveBriefCandidate,
  category: AoiProactiveBriefFeedbackCategory,
  now: number,
): AoiProactiveBriefCandidate {
  if (category === 'archive_brief') {
    return {
      ...candidate,
      status: 'archived',
      updatedAt: now,
    };
  }
  if (category === 'useful' || category === 'show_more' || category === 'pin_topic') {
    return {
      ...candidate,
      status: 'accepted',
      updatedAt: now,
    };
  }
  if (
    category === 'not_useful' ||
    category === 'show_less' ||
    category === 'wrong_topic' ||
    category === 'wrong_source' ||
    category === 'wrong_timing' ||
    category === 'too_frequent' ||
    category === 'stale'
  ) {
    return {
      ...candidate,
      status: 'dismissed',
      updatedAt: now,
    };
  }
  if (category === 'unsafe') {
    return {
      ...candidate,
      status: 'blocked',
      updatedAt: now,
    };
  }
  if (category === 'open_sources' || category === 'expand_summary') {
    return {
      ...candidate,
      status: candidate.status === 'candidate' ? 'shown' : candidate.status,
      updatedAt: now,
    };
  }
  return candidate;
}

function cooldownMsForFeedback(
  category: AoiProactiveBriefFeedbackCategory,
  defaultCooldownMs: number,
): number {
  if (category === 'too_frequent') {
    return Math.max(defaultCooldownMs, TOO_FREQUENT_COOLDOWN_MS);
  }
  if (category === 'stale') {
    return Math.max(defaultCooldownMs, STALE_COOLDOWN_MS);
  }
  if (
    category === 'not_useful' ||
    category === 'show_less' ||
    category === 'wrong_timing' ||
    category === 'wrong_topic' ||
    category === 'wrong_source' ||
    category === 'unsafe' ||
    category === 'mute_topic'
  ) {
    return defaultCooldownMs;
  }
  return 0;
}

export function applyAoiProactiveBriefFeedbackAction(
  input: ApplyAoiProactiveBriefFeedbackInput,
): AoiProactiveBriefFeedbackMutationResult {
  const now = input.now ?? Date.now();
  const candidates = loadAoiProactiveBriefCandidates(input.sessionsDir, input.sessionPath, now);
  const candidate = candidates.find((item) => item.id === input.briefId);
  if (!candidate) {
    throw new Error('Proactive brief candidate was not found.');
  }

  const feedback = recordAoiProactiveBriefFeedback(input.sessionsDir, {
    version: 1,
    briefId: candidate.id,
    topicId: candidate.topicId,
    sessionPath: input.sessionPath,
    category: input.category,
    note: normalizeNote(input.note),
    createdAt: now,
  });

  const profile = loadAoiInterestProfile(input.sessionsDir, input.sessionPath, now);
  const updatedProfile: AoiInterestProfile = {
    ...profile,
    topics: profile.topics.map((topic) =>
      topic.id === candidate.topicId
        ? updateTopicForFeedback(topic, input.category, now, feedback.id)
        : topic,
    ),
    generatedAt: Math.max(profile.generatedAt, now),
  };
  const savedProfile = saveAoiInterestProfile(
    input.sessionsDir,
    input.sessionPath,
    updatedProfile,
    now,
  );

  const updatedCandidate = updateCandidateForFeedback(candidate, input.category, now);
  const storedCandidate = upsertAoiProactiveBriefCandidate(
    input.sessionsDir,
    updatedCandidate,
    now,
  ).candidate;

  const cooldownMs = cooldownMsForFeedback(
    input.category,
    input.defaultCooldownMs ?? DEFAULT_FEEDBACK_COOLDOWN_MS,
  );
  if (cooldownMs > 0) {
    upsertAoiProactiveBriefCooldown(input.sessionsDir, input.sessionPath, {
      cooldownKey: candidate.cooldownKey,
      topicId: candidate.topicId,
      nextAllowedAt: now + cooldownMs,
      reason: `feedback:${input.category}`,
      sourceBriefIds: [candidate.id],
      now,
    });
  }

  return {
    sessionPath: input.sessionPath,
    feedback,
    candidate: storedCandidate,
    candidates: loadAoiProactiveBriefCandidates(input.sessionsDir, input.sessionPath, now),
    profile: savedProfile,
    cooldownState: loadAoiProactiveBriefCooldownState(input.sessionsDir, input.sessionPath, now),
    allFeedback: loadAoiProactiveBriefFeedback(input.sessionsDir, input.sessionPath),
  };
}
