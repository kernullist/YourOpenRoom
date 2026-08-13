// Persistent mood (R6.2).
//
// Emotion has been a per-message reaction: the model picks one, the avatar plays
// it, and it is gone by the next turn. Nothing carried "how Aoi is doing" across
// turns or sessions, and she had no way to say it.
//
// THE LOAD-BEARING CONSTRAINT: mood is EXPRESSION ONLY. It never reaches a gate
// -- not the interruption governor, not promotion or readiness, not budgets, not
// approval eligibility, not delivery decisions. A mood that could tighten or
// loosen a gate would be an autonomy input dressed as a feeling, and a bug in it
// would move real authority. aoiMoodGateIntegrity.test.ts asserts the gate
// modules never mention mood at all, so this cannot drift by accident.
//
// Derivation is pure and evidence-shaped: each mood carries the reasons that
// produced it, and with no signals it stays neutral rather than inventing a
// feeling.

export type AoiMoodKind = 'neutral' | 'content' | 'proud' | 'curious' | 'worried';

export type AoiMoodReasonKind =
  | 'recent_failures'
  | 'recent_wins'
  | 'milestone_crossed'
  | 'open_threads_waiting'
  | 'approvals_waiting'
  | 'habit_momentum_growing'
  | 'habit_momentum_slipping';

/**
 * How the user's habit garden is trending, as a direction only.
 *
 * Supplied by the Habit Garden app (opt-in, off by default in its settings) and
 * summarized to three values before it ever gets here: the mood layer must not
 * learn a whole app's domain, and the autonomy store should not accumulate a
 * personal habit log it has no use for.
 */
export type AoiHabitMomentum = 'growing' | 'steady' | 'slipping';

// Which expression the mood leans toward. Only a hint for the model and the
// avatar -- never a forced emotion, because the message being answered still
// matters more than the background mood.
export type AoiMoodExpression =
  | 'default'
  | 'happy'
  | 'peaceful'
  | 'curious'
  | 'excited'
  | 'proud'
  | 'worried';

export interface AoiMoodState {
  version: 1;
  mood: AoiMoodKind;
  expression: AoiMoodExpression;
  reasons: AoiMoodReasonKind[];
  updatedAt: number;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface DeriveAoiMoodInput {
  now: number;
  // Outcome results inside the recent window ('positive' | 'negative' |
  // 'blocked' | 'failed' | ...), newest order irrelevant.
  recentOutcomes?: Array<{ result: string; createdAt: number }>;
  // Milestones crossed just now (R3.3), which is something to feel good about.
  newMilestoneCount?: number;
  // Unresolved threads carried forward (R2.3).
  openThreadCount?: number;
  // Approvals sitting in the inbox. Waiting on the user is a mild unease, not a
  // reason to nag -- the mood says it, the governor still decides delivery.
  pendingApprovalCount?: number;
  // Optional and absent unless the user opted in. Omitted entirely for anyone
  // who does not use the habit app, so its absence is not read as 'steady'.
  habitMomentum?: AoiHabitMomentum;
  windowMs?: number;
}

export const AOI_MOOD_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

const NEGATIVE_RESULTS = new Set(['negative', 'blocked', 'failed']);
const POSITIVE_RESULTS = new Set(['positive']);

const MOOD_EXPRESSION: Record<AoiMoodKind, AoiMoodExpression> = {
  neutral: 'default',
  content: 'peaceful',
  proud: 'proud',
  curious: 'curious',
  worried: 'worried',
};

export function deriveAoiMoodState(input: DeriveAoiMoodInput): AoiMoodState {
  const windowMs = input.windowMs ?? AOI_MOOD_WINDOW_MS;
  const windowStart = input.now - windowMs;
  const outcomes = (input.recentOutcomes ?? []).filter(
    (item) =>
      Number.isFinite(item.createdAt) &&
      item.createdAt >= windowStart &&
      item.createdAt <= input.now,
  );
  const failures = outcomes.filter((item) => NEGATIVE_RESULTS.has(item.result)).length;
  const wins = outcomes.filter((item) => POSITIVE_RESULTS.has(item.result)).length;
  const milestones = Math.max(0, Math.floor(input.newMilestoneCount ?? 0));
  const openThreads = Math.max(0, Math.floor(input.openThreadCount ?? 0));
  const approvals = Math.max(0, Math.floor(input.pendingApprovalCount ?? 0));

  const reasons: AoiMoodReasonKind[] = [];
  if (failures > 0) {
    reasons.push('recent_failures');
  }
  if (wins > 0) {
    reasons.push('recent_wins');
  }
  if (milestones > 0) {
    reasons.push('milestone_crossed');
  }
  if (openThreads > 0) {
    reasons.push('open_threads_waiting');
  }
  if (approvals > 0) {
    reasons.push('approvals_waiting');
  }
  if (input.habitMomentum === 'growing') {
    reasons.push('habit_momentum_growing');
  }
  if (input.habitMomentum === 'slipping') {
    reasons.push('habit_momentum_slipping');
  }

  // Precedence: something going wrong outweighs something going right. A mood
  // that reported pride while work was failing would read as not paying
  // attention.
  //
  // Habit momentum sits at the BOTTOM of this ladder on purpose. It is context
  // about the user's week, not about Aoi's own work, so it colours an otherwise
  // neutral mood rather than overriding a real signal -- and a slipping week is
  // never allowed to turn into worry while actual work is going well, which
  // would read as nagging.
  let mood: AoiMoodKind = 'neutral';
  if (failures > wins) {
    mood = 'worried';
  } else if (milestones > 0) {
    mood = 'proud';
  } else if (wins > 0) {
    mood = 'content';
  } else if (openThreads > 0 || approvals > 0) {
    mood = 'curious';
  } else if (input.habitMomentum === 'growing') {
    mood = 'content';
  }

  return {
    version: 1,
    mood,
    expression: MOOD_EXPRESSION[mood],
    reasons,
    updatedAt: input.now,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function normalizeAoiMoodState(raw: unknown, now: number): AoiMoodState | null {
  const value = raw as Partial<AoiMoodState> | null;
  if (!value || value.version !== 1) {
    return null;
  }
  const mood = value.mood;
  if (!mood || !(mood in MOOD_EXPRESSION)) {
    return null;
  }
  return {
    version: 1,
    mood,
    expression: MOOD_EXPRESSION[mood],
    reasons: Array.isArray(value.reasons)
      ? value.reasons.filter((reason): reason is AoiMoodReasonKind => typeof reason === 'string')
      : [],
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : now,
    // Re-asserted on every read: a file edited to claim authority still loads
    // display-only.
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

// A mood is worth mentioning only when it is not neutral and has a reason behind
// it. Prevents "I am feeling fine" filler.
export function shouldAoiMoodBeVoiced(mood: AoiMoodState | null): boolean {
  return Boolean(mood && mood.mood !== 'neutral' && mood.reasons.length > 0);
}
