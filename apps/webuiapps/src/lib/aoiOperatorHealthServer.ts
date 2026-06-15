import * as fs from 'fs';
import {
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

  return evaluateAoiOperatorHealth({
    sessionPath,
    registry,
    scheduler,
    tickState,
    workspaceSnapshot,
    commandAudits,
    config: buildConfigSnapshot(params.configFile),
    now,
  });
}
