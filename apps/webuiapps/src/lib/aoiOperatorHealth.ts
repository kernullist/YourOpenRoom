import type {
  AoiAutonomySchedulerState,
  AoiAutonomyTickState,
  AoiCommandAuditRecord,
  AoiEnvironmentSource,
  AoiEnvironmentSourceRegistry,
  AoiOperatorHealthCapability,
  AoiOperatorHealthCapabilityState,
  AoiOperatorHealthIssue,
  AoiOperatorHealthRecommendation,
  AoiOperatorHealthRecommendationAction,
  AoiOperatorHealthSeverity,
  AoiOperatorHealthState,
  AoiOperatorHealthStatus,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';
import {
  buildAoiSourceFreshnessContracts,
  type AoiSourceFreshnessContract,
  type AoiSourceFreshnessFailureHint,
} from './aoiSourceFreshnessContract';
import type { AoiProactiveBriefDiagnostic } from './aoiProactiveBriefReplay';

const MAX_HEALTH_ISSUES = 12;
const MAX_EVIDENCE_REFS = 16;
const DEFAULT_SOURCE_TTL_MS = 5 * 60 * 1000;

const SOURCE_TTL_MS_BY_ID: Record<string, number> = {
  'workspace-git': 60 * 1000,
  'workspace-build': 5 * 60 * 1000,
  'kira-board': 2 * 60 * 1000,
  'research-runs': 2 * 60 * 1000,
  'app-state': 60 * 1000,
  'browser-context': 5 * 60 * 1000,
  'manual-note': 5 * 60 * 1000,
  'calendar-metadata': 10 * 60 * 1000,
  'gmail-metadata': 15 * 60 * 1000,
  'notes-metadata': 10 * 60 * 1000,
};

const CAPABILITIES: AoiOperatorHealthCapability[] = [
  'memory',
  'research',
  'kira',
  'workspace',
  'personal_signals',
  'voice',
  'approved_commands',
  'replay_evaluation',
];

const SEVERITY_RANK: Record<AoiOperatorHealthSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  blocker: 3,
};

const CAPABILITY_LABELS: Record<AoiOperatorHealthCapability, string> = {
  memory: 'Memory',
  research: 'Research',
  kira: 'Kira',
  workspace: 'Workspace',
  personal_signals: 'Personal signals',
  voice: 'Voice',
  approved_commands: 'Approved commands',
  replay_evaluation: 'Replay/evaluation',
};

export interface AoiOperatorHealthConfigSnapshot {
  tavilyConfigured?: boolean;
  gmailConfigured?: boolean;
  gmailConnected?: boolean;
  kiraConfigured?: boolean;
  kiraWorkerRouteConfigured?: boolean;
  kiraReviewerRouteConfigured?: boolean;
  voiceEnabled?: boolean;
  memoryAvailable?: boolean;
  approvedCommandRunnerAvailable?: boolean;
}

export interface AoiOperatorHealthReplayScenario {
  fixtureId: string;
  failed: boolean;
  summary: string;
  capability?: AoiOperatorHealthCapability;
  evidenceRefs?: string[];
}

export interface AoiOperatorHealthInput {
  sessionPath: string;
  registry?: AoiEnvironmentSourceRegistry | null;
  scheduler?: AoiAutonomySchedulerState | null;
  tickState?: AoiAutonomyTickState | null;
  workspaceSnapshot?: AoiWorkspaceSnapshot | null;
  commandAudits?: AoiCommandAuditRecord[];
  config?: AoiOperatorHealthConfigSnapshot;
  replayScenarios?: AoiOperatorHealthReplayScenario[];
  proactiveBriefDiagnostics?: AoiProactiveBriefDiagnostic[];
  sourceFreshnessContracts?: AoiSourceFreshnessContract[];
  now?: number;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxChars: number): string {
  return normalizeWhitespace(value).slice(0, maxChars);
}

function redactHealthText(value: string): string {
  return truncate(
    value
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
        '[redacted-secret]',
      )
      .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_=-]{12,}/gi, '[redacted-token]')
      .replace(
        /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|password|passwd|secret|client[_ -]?secret|private[_ -]?key)\b\s*[:=]\s*['"]?[^'"\s,;]+/gi,
        '$1=[redacted]',
      )
      .replace(/(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g, '[redacted-path]')
      .replace(
        /(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+)/g,
        '[redacted-path]',
      ),
    220,
  );
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function dedupeRefs(refs: Array<string | undefined>, maxItems = MAX_EVIDENCE_REFS): string[] {
  const seen = new Set<string>();
  for (const ref of refs) {
    const normalized = truncate(ref ?? '', 180);
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function sourceCapability(source: AoiEnvironmentSource): AoiOperatorHealthCapability {
  if (source.kind === 'research_runs') {
    return 'research';
  }
  if (source.kind === 'kira_board') {
    return 'kira';
  }
  if (source.kind === 'workspace_git' || source.kind === 'workspace_build') {
    return 'workspace';
  }
  if (
    source.kind === 'calendar_metadata' ||
    source.kind === 'gmail_metadata' ||
    source.kind === 'notes_metadata' ||
    source.kind === 'browser_context'
  ) {
    return 'personal_signals';
  }
  return 'memory';
}

function recommendation(
  action: AoiOperatorHealthRecommendationAction,
  label: string,
  targetPanel?: string,
  targetRef?: string,
): AoiOperatorHealthRecommendation {
  return {
    version: 1,
    action,
    label: truncate(label, 120),
    ...(targetPanel ? { targetPanel } : {}),
    ...(targetRef ? { targetRef } : {}),
  };
}

function makeIssue(params: {
  capability: AoiOperatorHealthCapability;
  severity: AoiOperatorHealthSeverity;
  code: string;
  title: string;
  summary: string;
  cannotKnow?: string;
  sourceId?: string;
  observedAt: number;
  evidenceRefs?: string[];
  recommendation: AoiOperatorHealthRecommendation;
}): AoiOperatorHealthIssue {
  const key = [
    params.capability,
    params.severity,
    params.code,
    params.sourceId ?? '',
    params.title,
  ].join(':');
  return {
    version: 1,
    id: `aoi-health-${params.code}-${hashText(key)}`.slice(0, 127),
    capability: params.capability,
    severity: params.severity,
    code: truncate(params.code, 64),
    title: redactHealthText(params.title),
    summary: redactHealthText(params.summary),
    ...(params.cannotKnow ? { cannotKnow: redactHealthText(params.cannotKnow) } : {}),
    ...(params.sourceId ? { sourceId: truncate(params.sourceId, 96) } : {}),
    observedAt: params.observedAt,
    evidenceRefs: dedupeRefs(params.evidenceRefs ?? []),
    recommendation: params.recommendation,
  };
}

function sourceTtl(sourceId: string, scheduler?: AoiAutonomySchedulerState | null): number {
  return (
    scheduler?.sourceSchedules.find((item) => item.sourceId === sourceId)?.ttlMs ??
    SOURCE_TTL_MS_BY_ID[sourceId] ??
    DEFAULT_SOURCE_TTL_MS
  );
}

function sourceRefreshFailed(
  sourceId: string,
  scheduler?: AoiAutonomySchedulerState | null,
): string[] {
  const schedule = scheduler?.sourceSchedules.find((item) => item.sourceId === sourceId);
  const reasons = schedule?.lastResult === 'failed' ? schedule.lastReasons : [];
  const wakeupReasons =
    scheduler?.recentWakeups
      .flatMap((record) =>
        record.skippedSources
          .filter((item) => item.sourceId === sourceId)
          .flatMap((item) => item.reasons),
      )
      .filter(
        (reason) =>
          reason.includes('source_refresh_failed') || reason.includes('workspace_refresh_failed'),
      ) ?? [];
  return [...new Set([...reasons, ...wakeupReasons])].slice(0, 4);
}

function buildSourceFailureHints(
  registry: AoiEnvironmentSourceRegistry | null | undefined,
  scheduler?: AoiAutonomySchedulerState | null,
): AoiSourceFreshnessFailureHint[] {
  return (registry?.sources ?? [])
    .map((source) => {
      const reasons = sourceRefreshFailed(source.id, scheduler);
      if (reasons.length === 0) {
        return null;
      }
      const failedAt =
        scheduler?.sourceSchedules.find((item) => item.sourceId === source.id)?.updatedAt ??
        scheduler?.recentWakeups[0]?.completedAt ??
        scheduler?.recentWakeups[0]?.startedAt;
      return {
        sourceId: source.id,
        ...(typeof failedAt === 'number' ? { failedAt } : {}),
        reasons,
      };
    })
    .filter((item): item is AoiSourceFreshnessFailureHint => item !== null);
}

function sourceTtlMap(
  registry: AoiEnvironmentSourceRegistry | null | undefined,
  scheduler?: AoiAutonomySchedulerState | null,
): Record<string, number> {
  return Object.fromEntries(
    (registry?.sources ?? []).map((source) => [source.id, sourceTtl(source.id, scheduler)]),
  );
}

function contractCannotKnow(
  contract: AoiSourceFreshnessContract | undefined,
  fallback: string,
): string {
  return contract?.cannotKnow.map((item) => item.statement).join(' ') || fallback;
}

function addSourceIssues(
  issues: AoiOperatorHealthIssue[],
  input: AoiOperatorHealthInput,
  now: number,
  contractsBySourceId: ReadonlyMap<string, AoiSourceFreshnessContract>,
): void {
  for (const source of input.registry?.sources ?? []) {
    const capability = sourceCapability(source);
    const contract = contractsBySourceId.get(source.id);
    if (!source.enabled || contract?.freshnessState === 'disabled') {
      issues.push(
        makeIssue({
          capability,
          severity: 'info',
          code: source.kind === 'gmail_metadata' ? 'gmail_source_disabled' : 'source_disabled',
          title: `${source.label} disabled`,
          summary: `${source.label} is disabled by source settings.`,
          cannotKnow: contractCannotKnow(
            contract,
            `Aoi cannot know ${source.label} because that source is disabled.`,
          ),
          sourceId: source.id,
          observedAt: source.updatedAt || now,
          evidenceRefs: contract?.evidenceRefs ?? [`environment-source:${source.id}`],
          recommendation: recommendation(
            'open_source_settings',
            'Open source settings',
            'environment_sources',
            `environment-source:${source.id}`,
          ),
        }),
      );
      continue;
    }

    if (contract?.consentState === 'revoked' || contract?.consentState === 'missing') {
      issues.push(
        makeIssue({
          capability,
          severity: 'warning',
          code:
            contract.consentState === 'revoked'
              ? 'source_consent_revoked'
              : 'source_consent_missing',
          title:
            contract.consentState === 'revoked'
              ? `${source.label} consent revoked`
              : `${source.label} consent missing`,
          summary:
            contract.consentState === 'revoked'
              ? `${source.label} is enabled, but source consent is revoked.`
              : `${source.label} is enabled, but explicit reviewed consent is missing.`,
          cannotKnow: contractCannotKnow(
            contract,
            `Aoi cannot use ${source.label} without explicit reviewed consent.`,
          ),
          sourceId: source.id,
          observedAt: source.lastReviewedAt ?? source.updatedAt ?? now,
          evidenceRefs: contract.evidenceRefs,
          recommendation: recommendation(
            'open_source_settings',
            'Review source consent',
            'environment_sources',
            `environment-source:${source.id}`,
          ),
        }),
      );
      continue;
    }

    if (contract?.freshnessState === 'disconnected') {
      issues.push(
        makeIssue({
          capability,
          severity: 'warning',
          code: source.kind === 'gmail_metadata' ? 'gmail_disconnected' : 'source_disconnected',
          title: `${source.label} disconnected`,
          summary: `${source.label} is enabled, but the source connector is disconnected.`,
          cannotKnow: contractCannotKnow(
            contract,
            `Aoi cannot know current ${source.label} because the source is disconnected.`,
          ),
          sourceId: source.id,
          observedAt: contract.lastObservedAt ?? source.updatedAt ?? now,
          evidenceRefs: contract.evidenceRefs,
          recommendation: recommendation(
            source.kind === 'gmail_metadata' ? 'connect_gmail' : 'open_source_settings',
            source.kind === 'gmail_metadata' ? 'Reconnect Gmail' : 'Review source settings',
            'environment_sources',
            `environment-source:${source.id}`,
          ),
        }),
      );
      continue;
    }

    const failedReasons = sourceRefreshFailed(source.id, input.scheduler);
    if (failedReasons.length > 0 || contract?.freshnessState === 'failed') {
      issues.push(
        makeIssue({
          capability,
          severity: 'error',
          code: 'source_refresh_failed',
          title: `${source.label} refresh failed`,
          summary:
            failedReasons.length > 0
              ? `Last refresh failed: ${redactHealthText(failedReasons.join(', '))}`
              : `${source.label} freshness contract reports a failed read.`,
          cannotKnow: contractCannotKnow(
            contract,
            `Aoi cannot know current ${source.label} because the last refresh failed.`,
          ),
          sourceId: source.id,
          observedAt:
            contract?.lastFailedReadAt ??
            input.scheduler?.sourceSchedules.find((item) => item.sourceId === source.id)
              ?.updatedAt ??
            now,
          evidenceRefs: contract?.evidenceRefs ?? [
            `environment-source:${source.id}`,
            `scheduler:source:${source.id}`,
          ],
          recommendation: recommendation(
            'review_scheduler',
            'Review wakeup scheduler',
            'wakeup_scheduler',
            `environment-source:${source.id}`,
          ),
        }),
      );
      continue;
    }

    if (
      contract?.freshnessState === 'stale' ||
      (source.lastObservedAt && now - source.lastObservedAt > sourceTtl(source.id, input.scheduler))
    ) {
      issues.push(
        makeIssue({
          capability,
          severity: 'warning',
          code: 'source_stale',
          title: `${source.label} stale`,
          summary: `${source.label} has not refreshed within its configured source TTL.`,
          cannotKnow: contractCannotKnow(
            contract,
            `Aoi cannot know current ${source.label} because the source is stale.`,
          ),
          sourceId: source.id,
          observedAt: contract?.lastObservedAt ?? source.lastObservedAt ?? now,
          evidenceRefs: contract?.evidenceRefs ?? [`environment-source:${source.id}`],
          recommendation: recommendation(
            'review_scheduler',
            'Refresh or review source TTL',
            'wakeup_scheduler',
            `environment-source:${source.id}`,
          ),
        }),
      );
    } else if (!source.lastObservedAt && !contract?.lastObservedAt && source.id !== 'app-state') {
      issues.push(
        makeIssue({
          capability,
          severity: 'info',
          code: 'source_not_observed',
          title: `${source.label} not observed yet`,
          summary: `${source.label} is enabled but has no recorded observation timestamp yet.`,
          cannotKnow: contractCannotKnow(
            contract,
            `Aoi cannot know whether ${source.label} is fresh until it observes the source.`,
          ),
          sourceId: source.id,
          observedAt: source.updatedAt || now,
          evidenceRefs: contract?.evidenceRefs ?? [`environment-source:${source.id}`],
          recommendation: recommendation(
            'review_scheduler',
            'Run a scoped refresh',
            'wakeup_scheduler',
            `environment-source:${source.id}`,
          ),
        }),
      );
    }
  }
}

function sourceEnabled(
  registry: AoiEnvironmentSourceRegistry | null | undefined,
  sourceId: string,
): boolean {
  return registry?.sources.find((source) => source.id === sourceId)?.enabled === true;
}

function addConfigIssues(
  issues: AoiOperatorHealthIssue[],
  input: AoiOperatorHealthInput,
  now: number,
): void {
  const config = input.config ?? {};

  if (sourceEnabled(input.registry, 'research-runs') && config.tavilyConfigured !== true) {
    issues.push(
      makeIssue({
        capability: 'research',
        severity: 'warning',
        code: 'tavily_missing',
        title: 'Tavily missing for research',
        summary:
          'Research can read existing run metadata, but web-backed research is not configured.',
        cannotKnow: 'Aoi cannot know fresh web evidence because Tavily is not configured.',
        observedAt: now,
        evidenceRefs: ['config:tavily', 'environment-source:research-runs'],
        recommendation: recommendation('configure_tavily', 'Configure Tavily', 'research'),
      }),
    );
  }

  const gmailSource = input.registry?.sources.find((source) => source.id === 'gmail-metadata');
  if (gmailSource?.enabled) {
    if (config.gmailConfigured !== true) {
      issues.push(
        makeIssue({
          capability: 'personal_signals',
          severity: 'warning',
          code: 'gmail_not_configured',
          title: 'Gmail metadata not configured',
          summary:
            'Gmail metadata is enabled as a source, but no Gmail client configuration is present.',
          cannotKnow: 'Aoi cannot know Gmail metadata because Gmail is not configured.',
          sourceId: 'gmail-metadata',
          observedAt: now,
          evidenceRefs: ['config:gmail', 'environment-source:gmail-metadata'],
          recommendation: recommendation('connect_gmail', 'Connect Gmail', 'environment_sources'),
        }),
      );
    } else if (config.gmailConnected !== true) {
      const alreadyReported = issues.some(
        (issue) => issue.code === 'gmail_disconnected' && issue.sourceId === 'gmail-metadata',
      );
      if (!alreadyReported) {
        issues.push(
          makeIssue({
            capability: 'personal_signals',
            severity: 'warning',
            code: 'gmail_disconnected',
            title: 'Gmail metadata disconnected',
            summary: 'Gmail metadata is enabled, but no active refresh token is available.',
            cannotKnow:
              'Aoi cannot know current Gmail metadata because Gmail is disconnected; disconnected is not evidence of an empty inbox.',
            sourceId: 'gmail-metadata',
            observedAt: now,
            evidenceRefs: ['config:gmail', 'environment-source:gmail-metadata'],
            recommendation: recommendation(
              'connect_gmail',
              'Reconnect Gmail',
              'environment_sources',
            ),
          }),
        );
      }
    }
  }

  if (sourceEnabled(input.registry, 'kira-board')) {
    const hasWorker = config.kiraWorkerRouteConfigured === true;
    const hasReviewer = config.kiraReviewerRouteConfigured === true;
    if (config.kiraConfigured === false) {
      issues.push(
        makeIssue({
          capability: 'kira',
          severity: 'warning',
          code: 'kira_not_configured',
          title: 'Kira automation not configured',
          summary: 'Kira source metadata can be shown, but automation settings are missing.',
          cannotKnow:
            'Aoi cannot know whether Kira automation can accept work because Kira is not configured.',
          observedAt: now,
          evidenceRefs: ['config:kira', 'environment-source:kira-board'],
          recommendation: recommendation('open_kira_settings', 'Open Kira settings', 'kira'),
        }),
      );
    }
    if (!hasWorker || !hasReviewer) {
      const missing = [!hasWorker ? 'worker' : '', !hasReviewer ? 'reviewer' : '']
        .filter(Boolean)
        .join(' and ');
      issues.push(
        makeIssue({
          capability: 'kira',
          severity: 'warning',
          code: 'kira_route_missing',
          title: `Kira ${missing} route missing`,
          summary: `Kira automation is missing a configured ${missing} route.`,
          cannotKnow: `Aoi cannot know whether Kira can safely complete reviewed work without a ${missing} route.`,
          observedAt: now,
          evidenceRefs: ['config:kira', 'environment-source:kira-board'],
          recommendation: recommendation('open_kira_settings', 'Configure Kira routes', 'kira'),
        }),
      );
    }
  }

  if (config.voiceEnabled === false) {
    issues.push(
      makeIssue({
        capability: 'voice',
        severity: 'info',
        code: 'voice_disabled',
        title: 'Operator voice disabled',
        summary: 'Voice output is disabled by operator preference.',
        cannotKnow: 'Aoi will not speak health or resume summaries while voice output is disabled.',
        observedAt: now,
        evidenceRefs: ['config:operator-voice'],
        recommendation: recommendation('enable_voice', 'Enable voice in preferences', 'voice'),
      }),
    );
  }

  if (config.memoryAvailable === false) {
    issues.push(
      makeIssue({
        capability: 'memory',
        severity: 'blocker',
        code: 'memory_unavailable',
        title: 'Aoi memory unavailable',
        summary: 'Aoi cannot load the local memory surface for this session.',
        cannotKnow: 'Aoi cannot know prior session context because memory is unavailable.',
        observedAt: now,
        evidenceRefs: ['aoi-memory:unavailable'],
        recommendation: recommendation('inspect_memory', 'Inspect Aoi memory storage', 'memory'),
      }),
    );
  }

  if (config.approvedCommandRunnerAvailable === false) {
    issues.push(
      makeIssue({
        capability: 'approved_commands',
        severity: 'blocker',
        code: 'approved_command_runner_unavailable',
        title: 'Approved command runner unavailable',
        summary: 'Approved command previews can be shown, but the runner is unavailable.',
        cannotKnow:
          'Aoi cannot know validation results because the approved command runner is unavailable.',
        observedAt: now,
        evidenceRefs: ['approved-command:runner'],
        recommendation: recommendation(
          'review_approved_command_policy',
          'Review approved command runner',
          'approved_commands',
        ),
      }),
    );
  }
}

function addWorkspaceIssues(
  issues: AoiOperatorHealthIssue[],
  input: AoiOperatorHealthInput,
  now: number,
): void {
  const workspaceEnabled =
    sourceEnabled(input.registry, 'workspace-git') ||
    sourceEnabled(input.registry, 'workspace-build');
  if (workspaceEnabled && !input.workspaceSnapshot) {
    issues.push(
      makeIssue({
        capability: 'workspace',
        severity: 'warning',
        code: 'workspace_snapshot_missing',
        title: 'Workspace snapshot missing',
        summary: 'Workspace sources are enabled, but no workspace snapshot is available.',
        cannotKnow:
          'Aoi cannot know current branch, dirty state, or validation freshness without a workspace snapshot.',
        observedAt: now,
        evidenceRefs: ['workspace:snapshot:missing'],
        recommendation: recommendation(
          'refresh_workspace',
          'Refresh workspace signals',
          'workspace',
        ),
      }),
    );
    return;
  }

  const snapshot = input.workspaceSnapshot;
  if (!snapshot) {
    return;
  }

  if (snapshot.freshness === 'failed' || snapshot.validation.freshness === 'failed') {
    issues.push(
      makeIssue({
        capability: 'workspace',
        severity: 'error',
        code: 'workspace_snapshot_failed',
        title: 'Workspace signal failed',
        summary: 'The latest workspace signal is marked failed.',
        cannotKnow: 'Aoi cannot know reliable workspace state because the workspace signal failed.',
        observedAt: snapshot.collectedAt,
        evidenceRefs: snapshot.evidenceRefs,
        recommendation: recommendation(
          'refresh_workspace',
          'Refresh workspace signals',
          'workspace',
        ),
      }),
    );
  }

  if (snapshot.validation.freshness === 'stale') {
    issues.push(
      makeIssue({
        capability: 'workspace',
        severity: 'warning',
        code: 'validation_stale',
        title: 'Last validation stale',
        summary: snapshot.validation.staleReason
          ? `Last validation is stale: ${snapshot.validation.staleReason}`
          : 'Last validation is stale for the current workspace state.',
        cannotKnow:
          'Aoi cannot know whether the current workspace still passes validation because the last validation is stale.',
        observedAt: snapshot.validation.completedAt ?? snapshot.collectedAt,
        evidenceRefs: snapshot.validation.evidenceRefs,
        recommendation: recommendation('run_validation', 'Run approved validation', 'workspace'),
      }),
    );
  }
}

function addTickIssues(
  issues: AoiOperatorHealthIssue[],
  input: AoiOperatorHealthInput,
  now: number,
): void {
  const latestWakeup = input.scheduler?.recentWakeups[0];
  if (latestWakeup && (latestWakeup.status === 'failed' || latestWakeup.tickOk === false)) {
    const timedOut = latestWakeup.warnings.some((warning) =>
      /timeout|timed out|runtime budget/i.test(warning),
    );
    issues.push(
      makeIssue({
        capability: 'memory',
        severity: 'error',
        code: timedOut ? 'autonomy_tick_timeout' : 'autonomy_tick_failed',
        title: timedOut ? 'Last autonomy tick timed out' : 'Last autonomy tick failed',
        summary:
          latestWakeup.warnings.length > 0
            ? `Last wakeup failed: ${latestWakeup.warnings.map(redactHealthText).join(', ')}`
            : 'Last wakeup did not complete successfully.',
        cannotKnow:
          'Aoi cannot know whether recent observations were processed because the last autonomy tick failed.',
        observedAt: latestWakeup.completedAt || latestWakeup.startedAt || now,
        evidenceRefs: [`scheduler:wakeup:${latestWakeup.id}`],
        recommendation: recommendation(
          'review_scheduler',
          'Review wakeup failure',
          'wakeup_scheduler',
        ),
      }),
    );
  }

  const tick = input.tickState;
  if (tick?.activeTick && tick.lockExpiresAt && tick.lockExpiresAt < now + 1000) {
    issues.push(
      makeIssue({
        capability: 'memory',
        severity: 'warning',
        code: 'autonomy_tick_lock_near_expiry',
        title: 'Autonomy tick lock near expiry',
        summary: 'An autonomy tick is still marked active and the lock is close to expiry.',
        cannotKnow: 'Aoi cannot know whether the running tick will finish until the lock clears.',
        observedAt: tick.updatedAt || now,
        evidenceRefs: [tick.activeTickId ? `tick:${tick.activeTickId}` : 'tick:active'],
        recommendation: recommendation(
          'review_scheduler',
          'Review active tick',
          'wakeup_scheduler',
        ),
      }),
    );
  }
}

function addReplayIssues(
  issues: AoiOperatorHealthIssue[],
  input: AoiOperatorHealthInput,
  now: number,
): void {
  for (const scenario of input.replayScenarios ?? []) {
    if (!scenario.failed) {
      continue;
    }
    issues.push(
      makeIssue({
        capability: scenario.capability ?? 'replay_evaluation',
        severity: 'error',
        code: 'replay_scenario_failed',
        title: `Replay scenario failed: ${scenario.fixtureId}`,
        summary: scenario.summary,
        cannotKnow:
          'Aoi cannot trust this replay-backed behavior until the failing scenario is fixed.',
        observedAt: now,
        evidenceRefs: dedupeRefs([
          `replay:${scenario.fixtureId}`,
          ...(scenario.evidenceRefs ?? []),
        ]),
        recommendation: recommendation(
          'review_replay',
          'Review replay failure',
          'replay_evaluation',
        ),
      }),
    );
  }
}

function proactiveBriefRecommendation(
  diagnostic: AoiProactiveBriefDiagnostic,
): AoiOperatorHealthRecommendation {
  if (diagnostic.code === 'tavily_unavailable') {
    return recommendation('configure_tavily', 'Configure Tavily', 'research');
  }
  if (diagnostic.code === 'source_freshness_stale') {
    return recommendation('review_scheduler', 'Review freshness', 'replay_evaluation');
  }
  if (diagnostic.code === 'no_eligible_topics' || diagnostic.code === 'all_topics_muted') {
    return recommendation('inspect_memory', 'Inspect interest profile', 'memory');
  }
  return recommendation('review_replay', 'Review proactive brief replay', 'replay_evaluation');
}

function proactiveBriefIssueTitle(code: string): string {
  switch (code) {
    case 'tavily_unavailable':
      return 'Proactive brief Tavily unavailable';
    case 'source_freshness_stale':
      return 'Proactive brief source stale';
    case 'no_eligible_topics':
      return 'No eligible proactive topics';
    case 'all_topics_muted':
      return 'All proactive topics muted';
    case 'cooldown_suppressed_all_candidates':
      return 'Proactive brief cooldown active';
    case 'direct_chat_disabled_by_policy':
      return 'Direct proactive chat disabled';
    case 'field_not_tested':
      return 'Proactive brief field events missing';
    case 'field_private_leak_detected':
      return 'Proactive brief private leak detected';
    case 'field_unauthorized_mutation_detected':
      return 'Proactive brief unauthorized mutation detected';
    default:
      return 'Proactive brief diagnostic';
  }
}

function addProactiveBriefIssues(
  issues: AoiOperatorHealthIssue[],
  input: AoiOperatorHealthInput,
  now: number,
): void {
  for (const diagnostic of input.proactiveBriefDiagnostics ?? []) {
    issues.push(
      makeIssue({
        capability: diagnostic.capability,
        severity: diagnostic.severity,
        code: `proactive_brief_${diagnostic.code}`,
        title: proactiveBriefIssueTitle(diagnostic.code),
        summary: diagnostic.summary,
        cannotKnow: diagnostic.cannotKnow,
        observedAt: diagnostic.observedAt || now,
        evidenceRefs: dedupeRefs([
          `proactive-brief-diagnostic:${diagnostic.code}`,
          ...diagnostic.evidenceRefs,
        ]),
        recommendation: proactiveBriefRecommendation(diagnostic),
      }),
    );
  }
}

function addApprovedCommandIssues(
  issues: AoiOperatorHealthIssue[],
  input: AoiOperatorHealthInput,
): void {
  const latest = (input.commandAudits ?? [])[0];
  if (!latest) {
    return;
  }
  if (latest.timedOut || (latest.allowed && latest.exitCode !== 0)) {
    issues.push(
      makeIssue({
        capability: 'approved_commands',
        severity: 'error',
        code: latest.timedOut ? 'approved_command_timeout' : 'approved_command_failed',
        title: latest.timedOut ? 'Approved command timed out' : 'Approved command failed',
        summary: latest.timedOut
          ? 'The latest approved command timed out.'
          : 'The latest approved command exited unsuccessfully.',
        cannotKnow:
          'Aoi cannot know whether validation succeeded because the approved command did not complete cleanly.',
        observedAt: latest.completedAt,
        evidenceRefs: [`approved-command:${latest.id}`, ...latest.evidenceRefs],
        recommendation: recommendation(
          'review_approved_command_policy',
          'Review command output',
          'approved_commands',
        ),
      }),
    );
    return;
  }
  if (!latest.allowed) {
    issues.push(
      makeIssue({
        capability: 'approved_commands',
        severity: 'info',
        code: 'approved_command_policy_blocked',
        title: 'Approved command blocked by policy',
        summary: `A command was blocked by policy: ${latest.blockReasons.join(', ') || 'blocked'}.`,
        cannotKnow: 'Aoi cannot know command output because the command was blocked by policy.',
        observedAt: latest.completedAt,
        evidenceRefs: [`approved-command:${latest.id}`, ...latest.evidenceRefs],
        recommendation: recommendation(
          'review_approved_command_policy',
          'Review command allowlist',
          'approved_commands',
        ),
      }),
    );
  }
}

function statusFromSeverity(severity: AoiOperatorHealthSeverity): AoiOperatorHealthStatus {
  if (severity === 'blocker') {
    return 'blocked';
  }
  if (severity === 'error') {
    return 'degraded';
  }
  if (severity === 'warning') {
    return 'limited';
  }
  return 'healthy';
}

function overallStatus(issues: AoiOperatorHealthIssue[]): AoiOperatorHealthStatus {
  const highest = issues.reduce<AoiOperatorHealthSeverity>(
    (current, issue) =>
      SEVERITY_RANK[issue.severity] > SEVERITY_RANK[current] ? issue.severity : current,
    'info',
  );
  return statusFromSeverity(highest);
}

function capabilityStates(issues: AoiOperatorHealthIssue[]): AoiOperatorHealthCapabilityState[] {
  return CAPABILITIES.map((capability) => {
    const capabilityIssues = issues.filter((issue) => issue.capability === capability);
    const highest = capabilityIssues.reduce<AoiOperatorHealthSeverity>(
      (current, issue) =>
        SEVERITY_RANK[issue.severity] > SEVERITY_RANK[current] ? issue.severity : current,
      'info',
    );
    const actionableCount = capabilityIssues.filter((issue) => issue.severity !== 'info').length;
    const status = actionableCount > 0 ? statusFromSeverity(highest) : 'healthy';
    return {
      version: 1,
      capability,
      status,
      highestSeverity: highest,
      issueCount: capabilityIssues.length,
      summary:
        capabilityIssues.length === 0
          ? `${CAPABILITY_LABELS[capability]} healthy.`
          : `${CAPABILITY_LABELS[capability]} has ${capabilityIssues.length} health note${
              capabilityIssues.length === 1 ? '' : 's'
            }.`,
      issueIds: capabilityIssues.map((issue) => issue.id).slice(0, 8),
    };
  });
}

function stateSummary(status: AoiOperatorHealthStatus, issues: AoiOperatorHealthIssue[]): string {
  const actionable = issues.filter((issue) => issue.severity !== 'info');
  if (actionable.length === 0) {
    return issues.length > 0
      ? `Aoi health is healthy with ${issues.length} informational note${
          issues.length === 1 ? '' : 's'
        }.`
      : 'Aoi health is healthy.';
  }
  const top = actionable[0];
  return `Aoi health is ${status}: ${top.title}.`;
}

export function evaluateAoiOperatorHealth(input: AoiOperatorHealthInput): AoiOperatorHealthState {
  const now = input.now ?? Date.now();
  const issues: AoiOperatorHealthIssue[] = [];
  const sourceFreshnessContracts =
    input.sourceFreshnessContracts ??
    buildAoiSourceFreshnessContracts({
      sourceRegistry: input.registry,
      workspaceSnapshot: input.workspaceSnapshot,
      sourceFailureHints: buildSourceFailureHints(input.registry, input.scheduler),
      disconnectedSourceIds:
        input.config?.gmailConfigured === true && input.config.gmailConnected !== true
          ? ['gmail-metadata']
          : [],
      staleAfterMsBySourceId: sourceTtlMap(input.registry, input.scheduler),
      now,
    });
  const contractsBySourceId = new Map(
    sourceFreshnessContracts.map((contract) => [contract.sourceId, contract]),
  );
  addSourceIssues(issues, input, now, contractsBySourceId);
  addConfigIssues(issues, input, now);
  addWorkspaceIssues(issues, input, now);
  addTickIssues(issues, input, now);
  addProactiveBriefIssues(issues, input, now);
  addReplayIssues(issues, input, now);
  addApprovedCommandIssues(issues, input);

  const sortedIssues = issues
    .sort(
      (left, right) =>
        SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
        right.observedAt - left.observedAt ||
        left.code.localeCompare(right.code),
    )
    .slice(0, MAX_HEALTH_ISSUES);
  const status = overallStatus(sortedIssues);
  return {
    version: 1,
    sessionPath: input.sessionPath,
    generatedAt: now,
    overallStatus: status,
    summary: stateSummary(status, sortedIssues),
    capabilities: capabilityStates(sortedIssues),
    issues: sortedIssues,
    userBlockingIssueCount: sortedIssues.filter((issue) => issue.severity === 'blocker').length,
    evidenceRefs: dedupeRefs(sortedIssues.flatMap((issue) => issue.evidenceRefs)),
  };
}
