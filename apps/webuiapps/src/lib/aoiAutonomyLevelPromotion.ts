import type { AoiAutonomyLevel, AoiAutonomyPolicy } from './aoiAutonomyTypes';
import type { AoiJarvisReadinessScorecard } from './aoiJarvisReadinessScorecard';

// Pure, browser-safe gated auto-promotion of the autonomy policy level (L0..L5),
// driven by the Jarvis readiness scorecard's canIncreaseTrust signal. The server
// runner (aoiAutonomyLevelPromotionRunner) does the I/O; this module owns the
// decision so it is fully unit-testable.
//
// Safety model (roadmap item 5b, the riskiest one):
//   - Promote by ONE level at a time, never skip.
//   - Promote ONLY when readiness is positive (canIncreaseTrust + trusted_operator
//     + gates not blocked) AND that has held over a SUSTAINED window (>= N
//     consecutive positive evaluations AND >= T elapsed since the streak began).
//   - HARD CEILING L4: the L4->L5 jump unlocks irreversible execution
//     (mutations / commands / connectors) and must always be a human decision, so
//     auto-promotion never reaches L5 regardless of configuration.
//   - INSTANT ROLLBACK to the baseline (the human-set floor) on ANY regression --
//     fast to revoke, slow to grant.
//   - An external manual level change re-baselines (the promoter yields to the
//     operator and never fights a manual setting).
//   - Every change is recorded in the gate-state history and audited by the runner.

const LEVEL_ORDER: AoiAutonomyLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

// Auto-promotion is hard-capped here; env config can only lower the ceiling.
export const AOI_AUTO_PROMOTE_HARD_CEILING: AoiAutonomyLevel = 'L4';

// P1b low-tier earned auto-promotion: field-readiness alone (NOT the
// trusted_operator-gated canIncreaseTrust) may earn levels up to here. Strictly
// below the L4 mutation/L5 line; promotions above this stay on the strict
// trusted_operator path, and L4->L5 is always human.
export const AOI_LOW_TIER_AUTO_PROMOTE_HARD_CEILING: AoiAutonomyLevel = 'L3';

// Readiness ladder (ascending), distinct from the autonomy LEVEL_ORDER. The
// low-tier signal requires a rung at or above supervised_prepare (the rung just
// below trusted_operator) -- weaker than the strict path's trusted_operator
// requirement, but still field-grounded + supervised.
const READINESS_LEVEL_ORDER = [
  'synthetic_pass',
  'field_shadow',
  'field_preview',
  'supervised_prepare',
  'trusted_operator',
];

function readinessRank(level: string): number {
  return READINESS_LEVEL_ORDER.indexOf(level);
}
export const DEFAULT_AOI_AUTO_PROMOTE_MIN_CONSECUTIVE = 3;
export const DEFAULT_AOI_AUTO_PROMOTE_SUSTAIN_MS = 60 * 60 * 1000;
const MAX_PROMOTION_HISTORY = 20;

function levelRank(level: AoiAutonomyLevel): number {
  const rank = LEVEL_ORDER.indexOf(level);
  return rank < 0 ? 0 : rank;
}

function levelByRank(rank: number): AoiAutonomyLevel {
  return LEVEL_ORDER[Math.min(LEVEL_ORDER.length - 1, Math.max(0, rank))];
}

function isAutonomyLevel(value: unknown): value is AoiAutonomyLevel {
  return typeof value === 'string' && (LEVEL_ORDER as string[]).includes(value);
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export interface AoiAutonomyLevelPromotionConfig {
  enabled: boolean;
  // Effective ceiling (already clamped to <= AOI_AUTO_PROMOTE_HARD_CEILING).
  ceiling: AoiAutonomyLevel;
  minConsecutive: number;
  sustainMs: number;
  // P1b low-tier earned auto-promotion (separate OFF-by-default opt-in). When on,
  // the weaker field-readiness signal may earn levels up to lowTierCeiling without
  // trusted_operator; the strict trusted_operator path still governs higher tiers.
  lowTierEnabled: boolean;
  lowTierCeiling: AoiAutonomyLevel;
}

// Resolve config from an env-shaped map. Pure (the caller passes process.env) so
// this module stays browser-safe. The ceiling is hard-clamped to L4.
export function resolveAoiAutonomyLevelPromotionConfig(
  env: Record<string, string | undefined>,
): AoiAutonomyLevelPromotionConfig {
  const rawCeiling = (env.AOI_AUTONOMY_AUTO_PROMOTE_CEILING ?? '').trim().toUpperCase();
  const requestedCeiling = isAutonomyLevel(rawCeiling) ? rawCeiling : AOI_AUTO_PROMOTE_HARD_CEILING;
  const ceiling = levelByRank(
    Math.min(levelRank(requestedCeiling), levelRank(AOI_AUTO_PROMOTE_HARD_CEILING)),
  );
  return {
    enabled: env.AOI_AUTONOMY_AUTO_PROMOTE === '1',
    ceiling,
    minConsecutive: clampInt(
      env.AOI_AUTONOMY_AUTO_PROMOTE_MIN_CONSECUTIVE,
      DEFAULT_AOI_AUTO_PROMOTE_MIN_CONSECUTIVE,
      1,
      100,
    ),
    sustainMs: clampInt(
      env.AOI_AUTONOMY_AUTO_PROMOTE_SUSTAIN_MS,
      DEFAULT_AOI_AUTO_PROMOTE_SUSTAIN_MS,
      0,
      30 * 24 * 60 * 60 * 1000,
    ),
    // Separate opt-in from AOI_AUTONOMY_AUTO_PROMOTE (the strict path); the
    // low-tier ceiling is fixed at the hard cap (L3) -- it cannot reach L4/L5.
    lowTierEnabled: env.AOI_AUTONOMY_AUTO_PROMOTE_LOW_TIER === '1',
    lowTierCeiling: AOI_LOW_TIER_AUTO_PROMOTE_HARD_CEILING,
  };
}

export interface AoiAutonomyLevelChangeRecord {
  kind: 'promote' | 'rollback';
  from: AoiAutonomyLevel;
  to: AoiAutonomyLevel;
  reason: string;
  readinessScore: number;
  readinessLevel: string;
  at: number;
  evidenceRefs: string[];
}

export interface AoiAutonomyLevelPromotionGateState {
  version: 1;
  sessionPath: string;
  // Human-set floor: auto-promotion never drops below this and rolls back to it.
  baselineLevel: AoiAutonomyLevel;
  // Level the promoter last set/observed; a mismatch with the live policy means a
  // manual change happened out-of-band, which re-baselines.
  lastManagedLevel: AoiAutonomyLevel;
  // Start of the current unbroken positive-readiness streak (null when broken).
  positiveSince: number | null;
  consecutivePositive: number;
  lastEvaluatedAt: number;
  history: AoiAutonomyLevelChangeRecord[];
  updatedAt: number;
}

export type AoiAutonomyLevelPromotionAction = 'promote' | 'rollback' | 'hold';

export interface AoiAutonomyLevelPromotionDecision {
  version: 1;
  action: AoiAutonomyLevelPromotionAction;
  changed: boolean;
  previousLevel: AoiAutonomyLevel;
  nextLevel: AoiAutonomyLevel;
  reason: string;
  nextGateState: AoiAutonomyLevelPromotionGateState;
  evidenceRefs: string[];
}

function normalizeChangeRecord(value: unknown): AoiAutonomyLevelChangeRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiAutonomyLevelChangeRecord>;
  if (
    (raw.kind !== 'promote' && raw.kind !== 'rollback') ||
    !isAutonomyLevel(raw.from) ||
    !isAutonomyLevel(raw.to) ||
    typeof raw.at !== 'number'
  ) {
    return null;
  }
  return {
    kind: raw.kind,
    from: raw.from,
    to: raw.to,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    readinessScore: typeof raw.readinessScore === 'number' ? raw.readinessScore : 0,
    readinessLevel: typeof raw.readinessLevel === 'string' ? raw.readinessLevel : '',
    at: raw.at,
    evidenceRefs: Array.isArray(raw.evidenceRefs)
      ? raw.evidenceRefs.filter((ref): ref is string => typeof ref === 'string').slice(0, 12)
      : [],
  };
}

export function normalizeAoiAutonomyLevelPromotionGateState(
  value: unknown,
  fallback: { sessionPath: string; level: AoiAutonomyLevel; now: number },
): AoiAutonomyLevelPromotionGateState {
  const base: AoiAutonomyLevelPromotionGateState = {
    version: 1,
    sessionPath: fallback.sessionPath,
    baselineLevel: fallback.level,
    lastManagedLevel: fallback.level,
    positiveSince: null,
    consecutivePositive: 0,
    lastEvaluatedAt: fallback.now,
    history: [],
    updatedAt: fallback.now,
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return base;
  }
  const raw = value as Partial<AoiAutonomyLevelPromotionGateState>;
  return {
    version: 1,
    sessionPath: typeof raw.sessionPath === 'string' ? raw.sessionPath : fallback.sessionPath,
    baselineLevel: isAutonomyLevel(raw.baselineLevel) ? raw.baselineLevel : fallback.level,
    lastManagedLevel: isAutonomyLevel(raw.lastManagedLevel) ? raw.lastManagedLevel : fallback.level,
    positiveSince:
      typeof raw.positiveSince === 'number' && Number.isFinite(raw.positiveSince)
        ? raw.positiveSince
        : null,
    consecutivePositive:
      typeof raw.consecutivePositive === 'number' && raw.consecutivePositive >= 0
        ? Math.floor(raw.consecutivePositive)
        : 0,
    lastEvaluatedAt: typeof raw.lastEvaluatedAt === 'number' ? raw.lastEvaluatedAt : fallback.now,
    history: Array.isArray(raw.history)
      ? raw.history
          .map(normalizeChangeRecord)
          .filter((record): record is AoiAutonomyLevelChangeRecord => record !== null)
          .slice(-MAX_PROMOTION_HISTORY)
      : [],
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : fallback.now,
  };
}

// Is the readiness scorecard currently a positive promotion signal? canIncreaseTrust
// already bundles trusted_operator + direct-chat allowed + field labels >= minimum +
// compression/outcome trust; the extra checks are defensive.
export function isAoiReadinessPromotionPositive(scorecard: AoiJarvisReadinessScorecard): boolean {
  return (
    scorecard.canIncreaseTrust === true &&
    scorecard.level === 'trusted_operator' &&
    scorecard.gateStatus !== 'blocked'
  );
}

// P1b low-tier signal: field-grounded + supervised, WITHOUT requiring
// trusted_operator (which canIncreaseTrust demands). Strict: the overall gate must
// PASS (not merely be unblocked) and the readiness rung must be at or above
// supervised_prepare (the rung just below trusted_operator). Reads only
// field-evidence-derived fields (gate + rung), so it is not self-authorable -- no
// self-reinforcing promotion loop.
export function isAoiLowTierReadinessPositive(scorecard: AoiJarvisReadinessScorecard): boolean {
  return (
    scorecard.gateStatus === 'pass' &&
    readinessRank(scorecard.level) >= readinessRank('supervised_prepare')
  );
}

export function evaluateAoiAutonomyLevelPromotion(params: {
  policy: AoiAutonomyPolicy;
  scorecard: AoiJarvisReadinessScorecard;
  gateState: AoiAutonomyLevelPromotionGateState | null;
  config: AoiAutonomyLevelPromotionConfig;
  now: number;
}): AoiAutonomyLevelPromotionDecision {
  const { policy, scorecard, config, now } = params;
  const currentLevel = policy.level;
  let state = normalizeAoiAutonomyLevelPromotionGateState(params.gateState, {
    sessionPath: scorecard.sessionPath,
    level: currentLevel,
    now,
  });

  // External manual change since the promoter last acted -> yield and re-baseline.
  if (state.lastManagedLevel !== currentLevel) {
    state = {
      ...state,
      baselineLevel: currentLevel,
      lastManagedLevel: currentLevel,
      positiveSince: null,
      consecutivePositive: 0,
    };
  }

  const evidenceRefs = [`jarvis-readiness:${scorecard.id}`, ...scorecard.blockerRefs].slice(0, 12);

  const hold = (
    reason: string,
    patch: Partial<AoiAutonomyLevelPromotionGateState> = {},
  ): AoiAutonomyLevelPromotionDecision => ({
    version: 1,
    action: 'hold',
    changed: false,
    previousLevel: currentLevel,
    nextLevel: currentLevel,
    reason,
    nextGateState: { ...state, ...patch, lastEvaluatedAt: now, updatedAt: now },
    evidenceRefs,
  });

  // Two independent OFF-by-default paths. STRICT: trusted_operator-gated, earns up
  // to the main ceiling (L4). LOW-TIER: weaker field-readiness signal, earns only up
  // to the low-tier ceiling (L3) -- never reaching the L4 mutation / L5 line.
  const strictActive = config.enabled && isAoiReadinessPromotionPositive(scorecard);
  const lowTierActive = config.lowTierEnabled && isAoiLowTierReadinessPositive(scorecard);

  if (!config.enabled && !config.lowTierEnabled) {
    return hold('auto_promote_disabled');
  }

  if (!strictActive && !lowTierActive) {
    // Regression: snap all auto-granted levels back to the human baseline at once.
    if (levelRank(currentLevel) > levelRank(state.baselineLevel)) {
      const reason = `readiness regressed (canIncreaseTrust=${scorecard.canIncreaseTrust}, level=${scorecard.level}, gate=${scorecard.gateStatus}); rolling back to ${state.baselineLevel}`;
      const record: AoiAutonomyLevelChangeRecord = {
        kind: 'rollback',
        from: currentLevel,
        to: state.baselineLevel,
        reason,
        readinessScore: scorecard.score,
        readinessLevel: scorecard.level,
        at: now,
        evidenceRefs,
      };
      return {
        version: 1,
        action: 'rollback',
        changed: true,
        previousLevel: currentLevel,
        nextLevel: state.baselineLevel,
        reason,
        nextGateState: {
          ...state,
          lastManagedLevel: state.baselineLevel,
          positiveSince: null,
          consecutivePositive: 0,
          history: [...state.history, record].slice(-MAX_PROMOTION_HISTORY),
          lastEvaluatedAt: now,
          updatedAt: now,
        },
        evidenceRefs,
      };
    }
    return hold('readiness_not_positive', { positiveSince: null, consecutivePositive: 0 });
  }

  // Positive readiness: advance the sustained-window streak.
  const positiveSince = state.positiveSince ?? now;
  const consecutivePositive = state.consecutivePositive + 1;
  // The strict (trusted_operator) signal earns up to the main ceiling (L4); the
  // low-tier field-readiness signal earns only up to the low-tier ceiling (L3). When
  // both are active (trusted_operator satisfies both), the strict ceiling wins.
  const ceilingRank = strictActive
    ? Math.min(levelRank(config.ceiling), levelRank(AOI_AUTO_PROMOTE_HARD_CEILING))
    : Math.min(levelRank(config.lowTierCeiling), levelRank(AOI_LOW_TIER_AUTO_PROMOTE_HARD_CEILING));

  if (levelRank(currentLevel) >= ceilingRank) {
    return hold(`at_ceiling (${currentLevel})`, { positiveSince, consecutivePositive });
  }

  const elapsed = now - positiveSince;
  const windowMet = consecutivePositive >= config.minConsecutive && elapsed >= config.sustainMs;
  if (!windowMet) {
    return hold(
      `sustaining readiness (${consecutivePositive}/${config.minConsecutive} consecutive, ${elapsed}/${config.sustainMs}ms)`,
      { positiveSince, consecutivePositive },
    );
  }

  const nextLevel = levelByRank(Math.min(levelRank(currentLevel) + 1, ceilingRank));
  const signalLabel = strictActive ? 'trusted readiness' : 'low-tier field readiness';
  const reason = `sustained ${signalLabel} (score=${scorecard.score}, ${consecutivePositive} consecutive over ${elapsed}ms); promoting ${currentLevel} -> ${nextLevel}`;
  const record: AoiAutonomyLevelChangeRecord = {
    kind: 'promote',
    from: currentLevel,
    to: nextLevel,
    reason,
    readinessScore: scorecard.score,
    readinessLevel: scorecard.level,
    at: now,
    evidenceRefs,
  };
  return {
    version: 1,
    action: 'promote',
    changed: true,
    previousLevel: currentLevel,
    nextLevel,
    reason,
    nextGateState: {
      ...state,
      lastManagedLevel: nextLevel,
      // Each promotion requires a fresh sustained window.
      positiveSince: null,
      consecutivePositive: 0,
      history: [...state.history, record].slice(-MAX_PROMOTION_HISTORY),
      lastEvaluatedAt: now,
      updatedAt: now,
    },
    evidenceRefs,
  };
}
