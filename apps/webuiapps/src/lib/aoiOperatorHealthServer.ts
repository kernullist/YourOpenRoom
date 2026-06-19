import * as fs from 'fs';
import {
  loadAoiAutonomyPolicy,
  loadAoiAutonomyTickState,
  loadAoiCommandAuditRecords,
  loadAoiEnvironmentSourceRegistry,
  normalizeAoiAutonomySessionPath,
} from './aoiAutonomyStore';
import { loadAoiAutonomySchedulerState } from './aoiAutonomyScheduler';
import { loadAoiWorkspaceSnapshot } from './aoiWorkspaceSignals';
import {
  evaluateAoiOperatorHealth,
  type AoiOperatorHealthConfigSnapshot,
} from './aoiOperatorHealth';
import {
  loadAoiInterestProfile,
  loadAoiProactiveBriefCandidates,
  loadAoiProactiveBriefCooldownState,
  loadAoiProactiveBriefFieldMetrics,
  loadAoiProactiveBriefFeedback,
  resolveAoiProactiveBriefPaths,
} from './aoiProactiveBriefStore';
import {
  buildAoiProactiveBriefDiagnostics,
  buildAoiProactiveBriefFieldDiagnostics,
} from './aoiProactiveBriefReplay';
import type { PersistedConfig } from './configPersistence';
import type {
  AoiAutonomySchedulerState,
  AoiAutonomyTickState,
  AoiCommandAuditRecord,
  AoiEnvironmentSourceRegistry,
  AoiOperatorHealthState,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';

function readPersistedConfig(configFile: string): PersistedConfig {
  try {
    if (!fs.existsSync(configFile)) {
      return {};
    }
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as PersistedConfig)
      : {};
  } catch {
    return {};
  }
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasBaseLlmRoute(config: PersistedConfig): boolean {
  return hasText(config.llm?.model);
}

function buildConfigSnapshot(configFile: string): AoiOperatorHealthConfigSnapshot {
  const config = readPersistedConfig(configFile);
  const kira = config.kira ?? {};
  const baseRoute = hasBaseLlmRoute(config);
  const workerRoute = Boolean(
    (Array.isArray(kira.workers) && kira.workers.length > 0) ||
    hasText(kira.workerModel) ||
    hasText(kira.workerLlm?.model) ||
    baseRoute,
  );
  const reviewerRoute = Boolean(
    hasText(kira.reviewerModel) || hasText(kira.reviewerLlm?.model) || baseRoute,
  );
  return {
    tavilyConfigured: hasText(config.tavily?.apiKey),
    gmailConfigured: hasText(config.gmail?.clientId),
    gmailConnected: hasText(config.gmail?.clientId) && hasText(config.gmail?.refreshToken),
    kiraConfigured: Boolean(
      hasText(kira.workRootDirectory) ||
      workerRoute ||
      reviewerRoute ||
      hasText(kira.workerModel) ||
      hasText(kira.reviewerModel),
    ),
    kiraWorkerRouteConfigured: workerRoute,
    kiraReviewerRouteConfigured: reviewerRoute,
    voiceEnabled: config.conversationPreferences?.ttsEnabled === true,
  };
}

function tryLoad<T>(loader: () => T, fallback: T): T {
  try {
    return loader();
  } catch {
    return fallback;
  }
}

export function buildAoiOperatorHealthState(params: {
  sessionsDir: string;
  sessionPath: string;
  configFile: string;
  now?: number;
}): AoiOperatorHealthState {
  const now = params.now ?? Date.now();
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const registry = tryLoad<AoiEnvironmentSourceRegistry | null>(
    () => loadAoiEnvironmentSourceRegistry(params.sessionsDir, sessionPath, now),
    null,
  );
  const scheduler = tryLoad<AoiAutonomySchedulerState | null>(
    () => loadAoiAutonomySchedulerState(params.sessionsDir, sessionPath, now),
    null,
  );
  const tickState = tryLoad<AoiAutonomyTickState | null>(
    () => loadAoiAutonomyTickState(params.sessionsDir, sessionPath, now),
    null,
  );
  const workspaceSnapshot = tryLoad<AoiWorkspaceSnapshot | null>(
    () => loadAoiWorkspaceSnapshot(params.sessionsDir, sessionPath, now),
    null,
  );
  const commandAudits = tryLoad<AoiCommandAuditRecord[]>(
    () => loadAoiCommandAuditRecords(params.sessionsDir, sessionPath),
    [],
  );
  const config = buildConfigSnapshot(params.configFile);
  const policy = tryLoad(() => loadAoiAutonomyPolicy(params.sessionsDir, sessionPath), null);
  const proactivePaths = tryLoad(
    () => resolveAoiProactiveBriefPaths(params.sessionsDir, sessionPath),
    null,
  );
  const proactiveProfile = tryLoad(
    () => loadAoiInterestProfile(params.sessionsDir, sessionPath, now),
    null,
  );
  const proactiveCandidates = tryLoad(
    () => loadAoiProactiveBriefCandidates(params.sessionsDir, sessionPath, now),
    [],
  );
  const proactiveFeedback = tryLoad(
    () => loadAoiProactiveBriefFeedback(params.sessionsDir, sessionPath),
    [],
  );
  const proactiveCooldownState = tryLoad(
    () => loadAoiProactiveBriefCooldownState(params.sessionsDir, sessionPath, now),
    null,
  );
  const proactiveFieldMetrics = tryLoad(
    () => loadAoiProactiveBriefFieldMetrics(params.sessionsDir, sessionPath, now),
    null,
  );
  const hasProactiveArtifacts = Boolean(
    proactiveProfile?.topics.length ||
    proactiveCandidates.length ||
    proactiveFeedback.length ||
    (proactiveFieldMetrics?.eventCount ?? 0) > 0 ||
    Object.keys(proactiveCooldownState?.cooldowns ?? {}).length ||
    (proactivePaths &&
      (fs.existsSync(proactivePaths.profile) ||
        fs.existsSync(proactivePaths.index) ||
        fs.existsSync(proactivePaths.cooldowns) ||
        fs.existsSync(proactivePaths.fieldMetrics) ||
        fs.existsSync(proactivePaths.fieldEventIndex))),
  );
  const proactiveScoutWarnings =
    hasProactiveArtifacts &&
    proactiveProfile &&
    proactiveProfile.topics.some((topic) => !topic.muted) &&
    policy?.enabled === true &&
    policy.proactiveSuggestionsEnabled === true &&
    config.tavilyConfigured !== true
      ? ['tavily_not_configured:cannot_refresh_current_info']
      : [];
  const proactiveBriefDiagnostics = hasProactiveArtifacts
    ? [
        ...buildAoiProactiveBriefDiagnostics({
          profile: proactiveProfile,
          candidates: proactiveCandidates,
          feedback: proactiveFeedback,
          cooldownState: proactiveCooldownState,
          scoutWarnings: proactiveScoutWarnings,
          now,
        }),
        ...buildAoiProactiveBriefFieldDiagnostics(proactiveFieldMetrics, now),
      ]
    : [];

  return evaluateAoiOperatorHealth({
    sessionPath,
    registry,
    scheduler,
    tickState,
    workspaceSnapshot,
    commandAudits,
    config,
    proactiveBriefDiagnostics,
    now,
  });
}
