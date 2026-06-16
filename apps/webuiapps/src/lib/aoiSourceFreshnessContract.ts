import type {
  AoiBrowserContextMetadata,
  AoiEnvironmentSource,
  AoiEnvironmentSourceKind,
  AoiEnvironmentSourceRegistry,
  AoiEnvironmentSourceScope,
  AoiPersonalSignalMetadataSummary,
  AoiSignalFreshness,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';
import type { AoiMemoryEntry } from './aoiMemoryShared';
import type { AoiResearchRunSummary } from './aoiResearchTypes';

export type AoiSourceFreshnessState =
  | 'fresh'
  | 'unknown'
  | 'stale'
  | 'failed'
  | 'disconnected'
  | 'revoked'
  | 'disabled';

export type AoiSourceScopeState = AoiEnvironmentSourceScope | 'metadata_only' | 'body_disabled';

export type AoiSourceConsentState =
  | 'not_required'
  | 'granted'
  | 'missing'
  | 'revoked'
  | 'disabled'
  | 'disconnected';

export type AoiSourceBodyAccessState =
  | 'not_applicable'
  | 'metadata_only'
  | 'body_disabled'
  | 'withheld';

export interface AoiSourceCannotKnow {
  version: 1;
  code: string;
  statement: string;
  evidenceRefs: string[];
}

export interface AoiSourceFreshnessFailureHint {
  sourceId: string;
  failedAt?: number;
  reasons?: string[];
}

export interface AoiSourceFreshnessContract {
  version: 1;
  id: string;
  sourceId: string;
  sourceKind: AoiEnvironmentSourceKind;
  sourceLabel: string;
  consentState: AoiSourceConsentState;
  dataScope: string;
  scopeState: AoiSourceScopeState;
  bodyAccessState: AoiSourceBodyAccessState;
  freshnessState: AoiSourceFreshnessState;
  signalFreshness: AoiSignalFreshness;
  lastObservedAt?: number;
  lastSuccessfulReadAt?: number;
  lastFailedReadAt?: number;
  staleAfterMs: number;
  staleAt?: number;
  cannotKnow: AoiSourceCannotKnow[];
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiSourceFreshnessContractInput {
  sourceRegistry?: AoiEnvironmentSourceRegistry | null;
  workspaceSnapshot?: AoiWorkspaceSnapshot | null;
  personalMetadata?: AoiPersonalSignalMetadataSummary[];
  memories?: AoiMemoryEntry[];
  researchRuns?: AoiResearchRunSummary[];
  browserContexts?: AoiBrowserContextMetadata[];
  sourceFailureHints?: AoiSourceFreshnessFailureHint[];
  disconnectedSourceIds?: string[];
  revokedSourceIds?: string[];
  staleAfterMsBySourceId?: Record<string, number>;
  now?: number;
}

export interface AoiSourceFreshnessDashboardContext {
  version: 1;
  visible: boolean;
  statusLabel: string;
  topStaleSourceLabels: string[];
  disconnectedSourceLabels: string[];
  revokedSourceLabels: string[];
  metadataOnlyBoundaryLabels: string[];
  lastObservedLabels: string[];
  lastSuccessfulReadLabels: string[];
  blindSpotLabels: string[];
  evidenceRefs: string[];
}

const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REFS = 16;
const WINDOWS_PRIVATE_PATH_PATTERN = /(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g;
const UNIX_PRIVATE_PATH_PATTERN =
  /(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+)/g;
const SECRET_TOKEN_PATTERN = /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_=-]{12,}/gi;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function redactContractText(value: string): string {
  return value
    .replace(WINDOWS_PRIVATE_PATH_PATTERN, '[local path]')
    .replace(UNIX_PRIVATE_PATH_PATTERN, '[local path]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[private email]')
    .replace(SECRET_TOKEN_PATTERN, '[redacted-token]');
}

function truncate(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(redactContractText(value));
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function dedupeStrings(values: Array<string | undefined | null>, maxItems = MAX_REFS): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = truncate(value ?? '', 180);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maxItems) {
      break;
    }
  }
  return result;
}

function formatTimestamp(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 'never';
  }
  return new Date(value).toISOString();
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function freshnessToSignal(state: AoiSourceFreshnessState): AoiSignalFreshness {
  if (state === 'fresh') {
    return 'fresh';
  }
  if (
    state === 'stale' ||
    state === 'disabled' ||
    state === 'revoked' ||
    state === 'disconnected'
  ) {
    return 'stale';
  }
  if (state === 'failed') {
    return 'failed';
  }
  return 'unknown';
}

function stateFromTimestamp(params: {
  observedAt?: number;
  failedAt?: number;
  now: number;
  staleAfterMs: number;
  fallback?: AoiSignalFreshness;
}): AoiSourceFreshnessState {
  if (typeof params.failedAt === 'number' && Number.isFinite(params.failedAt)) {
    return 'failed';
  }
  if (params.fallback === 'failed') {
    return 'failed';
  }
  if (params.fallback === 'stale') {
    return 'stale';
  }
  if (
    typeof params.observedAt !== 'number' ||
    !Number.isFinite(params.observedAt) ||
    params.observedAt <= 0
  ) {
    return 'unknown';
  }
  if (params.now - params.observedAt > params.staleAfterMs) {
    return 'stale';
  }
  return 'fresh';
}

function isPersonalKind(kind: AoiEnvironmentSourceKind): boolean {
  return kind === 'calendar_metadata' || kind === 'gmail_metadata' || kind === 'notes_metadata';
}

function requiresExplicitConsent(source: AoiEnvironmentSource): boolean {
  return (
    source.privateByDefault || source.scope === 'explicit_target' || isPersonalKind(source.kind)
  );
}

function consentStateForSource(
  source: AoiEnvironmentSource,
  revokedSourceIds: ReadonlySet<string>,
  disconnectedSourceIds: ReadonlySet<string>,
): AoiSourceConsentState {
  if (!source.enabled) {
    return 'disabled';
  }
  if (
    revokedSourceIds.has(source.id) ||
    /\b(revoked|withdrawn|do not use|source disabled|disable source)\b/i.test(
      source.consentReason ?? '',
    )
  ) {
    return 'revoked';
  }
  if (disconnectedSourceIds.has(source.id)) {
    return 'disconnected';
  }
  if (!requiresExplicitConsent(source)) {
    return 'not_required';
  }
  if (source.lastReviewedAt && source.consentReason) {
    return 'granted';
  }
  return 'missing';
}

function scopeStateForSource(source: AoiEnvironmentSource): AoiSourceScopeState {
  if (isPersonalKind(source.kind)) {
    return 'metadata_only';
  }
  if (source.kind === 'browser_context') {
    return 'metadata_only';
  }
  return source.scope;
}

function bodyAccessStateForSource(source: AoiEnvironmentSource): AoiSourceBodyAccessState {
  if (isPersonalKind(source.kind)) {
    return 'body_disabled';
  }
  if (source.kind === 'browser_context') {
    return 'metadata_only';
  }
  return 'not_applicable';
}

function dataScopeForSource(source: AoiEnvironmentSource): string {
  if (source.kind === 'workspace_git') {
    return 'workspace branch, dirty state, and git status metadata';
  }
  if (source.kind === 'workspace_build') {
    return 'workspace validation command, result, and freshness metadata';
  }
  if (source.kind === 'kira_board') {
    return 'Kira work item status and reviewed automation metadata';
  }
  if (source.kind === 'research_runs') {
    return 'Aoi research run status, report availability, and evidence counts';
  }
  if (source.kind === 'app_state') {
    return 'OpenRoom app route and display context metadata';
  }
  if (source.kind === 'browser_context') {
    return 'explicit browser page title, host, redacted URL, and purpose metadata';
  }
  if (source.kind === 'manual_note') {
    return 'manual memory and note metadata captured by Aoi';
  }
  if (source.kind === 'calendar_metadata') {
    return 'calendar title, time, reminder, and count metadata only';
  }
  if (source.kind === 'gmail_metadata') {
    return 'Gmail connection, sync, folder, label, cached, and unread count metadata only';
  }
  return 'notes count, recent title, tag, and pinned metadata only';
}

function makeCannotKnow(
  code: string,
  statement: string,
  evidenceRefs: string[],
): AoiSourceCannotKnow {
  return {
    version: 1,
    code: truncate(code, 80),
    statement: truncate(statement, 240),
    evidenceRefs: dedupeStrings(evidenceRefs, 8),
  };
}

function personalBodyCannotKnow(source: AoiEnvironmentSource): AoiSourceCannotKnow | null {
  if (source.kind === 'calendar_metadata') {
    return makeCannotKnow(
      'calendar_body_disabled',
      'Aoi cannot know calendar descriptions, notes, attendees beyond metadata, or private event body text from this source.',
      [`environment-source:${source.id}`, 'personal-signal:calendar_metadata'],
    );
  }
  if (source.kind === 'gmail_metadata') {
    return makeCannotKnow(
      'gmail_body_disabled',
      'Aoi cannot know email subject, snippet, thread text, sender intent, or message bodies from Gmail metadata counts.',
      [`environment-source:${source.id}`, 'personal-signal:gmail_metadata'],
    );
  }
  if (source.kind === 'notes_metadata') {
    return makeCannotKnow(
      'notes_body_disabled',
      'Aoi cannot know full note bodies or private note details from note title, tag, pinned, and count metadata.',
      [`environment-source:${source.id}`, 'personal-signal:notes_metadata'],
    );
  }
  if (source.kind === 'browser_context') {
    return makeCannotKnow(
      'browser_body_not_read',
      'Aoi cannot know the current page body, form contents, authenticated state, or unredacted URL from browser metadata.',
      [`environment-source:${source.id}`, 'browser-context:metadata'],
    );
  }
  return null;
}

function latestPersonalMetadata(
  summaries: AoiPersonalSignalMetadataSummary[] | undefined,
  sourceId: string,
): AoiPersonalSignalMetadataSummary | undefined {
  return summaries
    ?.filter((summary) => summary.sourceId === sourceId)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function latestMemory(
  memories: AoiMemoryEntry[] | undefined,
  source: AoiEnvironmentSource,
): AoiMemoryEntry | undefined {
  const candidates = (memories ?? []).filter((memory) => {
    if (memory.status !== 'active') {
      return false;
    }
    const tags = new Set(memory.tags.map((tag) => tag.toLowerCase()));
    if (source.kind === 'kira_board') {
      return tags.has('kira');
    }
    if (source.kind === 'manual_note') {
      return !tags.has('kira');
    }
    return false;
  });
  return candidates.sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function latestResearchRun(
  runs: AoiResearchRunSummary[] | undefined,
): AoiResearchRunSummary | undefined {
  return (runs ?? [])
    .filter((run) => run.status !== 'cancelled')
    .sort(
      (left, right) =>
        (right.completedAt ?? right.updatedAt) - (left.completedAt ?? left.updatedAt),
    )[0];
}

function latestBrowserContext(
  contexts: AoiBrowserContextMetadata[] | undefined,
): AoiBrowserContextMetadata | undefined {
  return [...(contexts ?? [])].sort((left, right) => right.capturedAt - left.capturedAt)[0];
}

function sourceTimestamps(params: {
  source: AoiEnvironmentSource;
  input: AoiSourceFreshnessContractInput;
  failureHint?: AoiSourceFreshnessFailureHint;
}): {
  observedAt?: number;
  successAt?: number;
  failedAt?: number;
  fallback?: AoiSignalFreshness;
  evidenceRefs: string[];
} {
  const { source, input, failureHint } = params;
  const baseRefs = [`environment-source:${source.id}`];
  if (source.kind === 'workspace_git') {
    const snapshot = input.workspaceSnapshot;
    const failed = snapshot?.git?.error ? snapshot.collectedAt : undefined;
    return {
      observedAt: snapshot?.git ? snapshot.collectedAt : source.lastObservedAt,
      successAt: snapshot?.git && !snapshot.git.error ? snapshot.collectedAt : undefined,
      failedAt: failed ?? failureHint?.failedAt,
      fallback: snapshot?.freshness,
      evidenceRefs: dedupeStrings([...(snapshot?.evidenceRefs ?? []), ...baseRefs]),
    };
  }
  if (source.kind === 'workspace_build') {
    const snapshot = input.workspaceSnapshot;
    const validationAt = snapshot?.validation.completedAt ?? snapshot?.collectedAt;
    return {
      observedAt: validationAt ?? source.lastObservedAt,
      successAt: snapshot?.validation.result === 'passed' ? validationAt : undefined,
      failedAt:
        snapshot?.validation.result === 'failed' || snapshot?.validation.freshness === 'failed'
          ? validationAt
          : failureHint?.failedAt,
      fallback: snapshot?.validation.freshness,
      evidenceRefs: dedupeStrings([
        ...(snapshot?.evidenceRefs ?? []),
        ...(snapshot?.validation.evidenceRefs ?? []),
        ...baseRefs,
      ]),
    };
  }
  if (source.kind === 'research_runs') {
    const run = latestResearchRun(input.researchRuns);
    const observedAt = run ? (run.completedAt ?? run.updatedAt) : source.lastObservedAt;
    return {
      observedAt,
      successAt: run?.status === 'completed' ? observedAt : undefined,
      failedAt: run?.status === 'failed' ? observedAt : failureHint?.failedAt,
      evidenceRefs: dedupeStrings([
        run ? `research:${run.id}` : undefined,
        run?.artifactAvailability?.report ? `research:${run.id}/report` : undefined,
        ...baseRefs,
      ]),
    };
  }
  if (source.kind === 'kira_board' || source.kind === 'manual_note') {
    const memory = latestMemory(input.memories, source);
    return {
      observedAt: memory?.updatedAt ?? source.lastObservedAt,
      successAt: memory?.updatedAt,
      failedAt: failureHint?.failedAt,
      evidenceRefs: dedupeStrings([memory ? `memory:${memory.id}` : undefined, ...baseRefs]),
    };
  }
  if (source.kind === 'browser_context') {
    const context = latestBrowserContext(input.browserContexts);
    return {
      observedAt: context?.capturedAt ?? source.lastObservedAt,
      successAt: context?.capturedAt,
      failedAt: failureHint?.failedAt,
      evidenceRefs: dedupeStrings([...(context?.evidenceRefs ?? []), ...baseRefs]),
    };
  }
  if (isPersonalKind(source.kind)) {
    const summary = latestPersonalMetadata(input.personalMetadata, source.id);
    return {
      observedAt: summary?.updatedAt ?? source.lastObservedAt,
      successAt: summary?.updatedAt,
      failedAt: failureHint?.failedAt,
      fallback: summary?.freshness,
      evidenceRefs: dedupeStrings([...(summary?.evidenceRefs ?? []), ...baseRefs]),
    };
  }
  return {
    observedAt: source.lastObservedAt,
    successAt: source.lastObservedAt,
    failedAt: failureHint?.failedAt,
    evidenceRefs: baseRefs,
  };
}

function gmailSummaryDisconnected(summary: AoiPersonalSignalMetadataSummary | undefined): boolean {
  return summary?.kind === 'gmail_metadata' && /\bconnected=false\b/i.test(summary.summary);
}

function buildContractForSource(
  source: AoiEnvironmentSource,
  input: AoiSourceFreshnessContractInput,
  now: number,
): AoiSourceFreshnessContract {
  const disconnectedSourceIds = new Set(input.disconnectedSourceIds ?? []);
  const revokedSourceIds = new Set(input.revokedSourceIds ?? []);
  const personalSummary = latestPersonalMetadata(input.personalMetadata, source.id);
  if (gmailSummaryDisconnected(personalSummary)) {
    disconnectedSourceIds.add(source.id);
  }
  const failureHint = input.sourceFailureHints?.find((item) => item.sourceId === source.id);
  const staleAfterMs = input.staleAfterMsBySourceId?.[source.id] ?? DEFAULT_STALE_AFTER_MS;
  const timestamps = sourceTimestamps({
    source,
    input,
    failureHint,
  });
  const consentState = consentStateForSource(source, revokedSourceIds, disconnectedSourceIds);
  let freshnessState = stateFromTimestamp({
    observedAt: timestamps.observedAt,
    failedAt: timestamps.failedAt,
    now,
    staleAfterMs,
    fallback: timestamps.fallback,
  });
  if (consentState === 'disabled') {
    freshnessState = 'disabled';
  } else if (consentState === 'revoked') {
    freshnessState = 'revoked';
  } else if (consentState === 'disconnected') {
    freshnessState = 'disconnected';
  }

  const evidenceRefs = dedupeStrings([
    ...timestamps.evidenceRefs,
    ...(failureHint?.reasons ?? []).map((reason) => `source-failure:${source.id}:${reason}`),
  ]);
  const cannotKnow: AoiSourceCannotKnow[] = [];
  if (!source.enabled) {
    cannotKnow.push(
      makeCannotKnow(
        'source_disabled',
        `Aoi cannot know ${source.label} because that source is disabled.`,
        evidenceRefs,
      ),
    );
  }
  if (consentState === 'missing') {
    cannotKnow.push(
      makeCannotKnow(
        'consent_missing',
        `Aoi cannot use ${source.label} as current context until the source has explicit reviewed consent.`,
        evidenceRefs,
      ),
    );
  }
  if (consentState === 'revoked') {
    cannotKnow.push(
      makeCannotKnow(
        'consent_revoked',
        `Aoi cannot use ${source.label} because source consent is revoked.`,
        evidenceRefs,
      ),
    );
  }
  if (freshnessState === 'disconnected') {
    const statement =
      source.kind === 'gmail_metadata'
        ? 'Aoi cannot know current Gmail metadata because Gmail is disconnected; disconnected is not evidence of an empty inbox.'
        : `Aoi cannot know current ${source.label} because the source is disconnected.`;
    cannotKnow.push(makeCannotKnow('source_disconnected', statement, evidenceRefs));
  }
  if (freshnessState === 'failed') {
    const reason = failureHint?.reasons?.[0] ? ` Last failure: ${failureHint.reasons[0]}.` : '';
    cannotKnow.push(
      makeCannotKnow(
        'source_failed',
        `Aoi cannot know current ${source.label} because the latest source read failed.${reason}`,
        evidenceRefs,
      ),
    );
  }
  if (freshnessState === 'stale') {
    const statement =
      source.kind === 'manual_note'
        ? 'Aoi cannot treat stale memory as current truth without fresh validation.'
        : `Aoi cannot know current ${source.label} because the last successful observation is stale.`;
    cannotKnow.push(makeCannotKnow('source_stale', statement, evidenceRefs));
  }
  const bodyBoundary = personalBodyCannotKnow(source);
  if (bodyBoundary) {
    cannotKnow.push(bodyBoundary);
  }

  return {
    version: 1,
    id: `source-freshness:${source.id}:${stableHash(
      [
        source.id,
        source.kind,
        consentState,
        freshnessState,
        String(timestamps.observedAt ?? 0),
        String(timestamps.successAt ?? 0),
        String(timestamps.failedAt ?? 0),
      ].join('|'),
    )}`,
    sourceId: source.id,
    sourceKind: source.kind,
    sourceLabel: truncate(source.label, 120),
    consentState,
    dataScope: dataScopeForSource(source),
    scopeState: scopeStateForSource(source),
    bodyAccessState: bodyAccessStateForSource(source),
    freshnessState,
    signalFreshness: freshnessToSignal(freshnessState),
    ...(typeof timestamps.observedAt === 'number' ? { lastObservedAt: timestamps.observedAt } : {}),
    ...(typeof timestamps.successAt === 'number'
      ? { lastSuccessfulReadAt: timestamps.successAt }
      : {}),
    ...(typeof timestamps.failedAt === 'number' ? { lastFailedReadAt: timestamps.failedAt } : {}),
    staleAfterMs,
    ...(typeof timestamps.observedAt === 'number'
      ? { staleAt: timestamps.observedAt + staleAfterMs }
      : {}),
    cannotKnow: dedupeCannotKnow(cannotKnow),
    evidenceRefs,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function dedupeCannotKnow(items: AoiSourceCannotKnow[]): AoiSourceCannotKnow[] {
  const seen = new Set<string>();
  const result: AoiSourceCannotKnow[] = [];
  for (const item of items) {
    const key = `${item.code}:${item.statement}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function buildAoiSourceFreshnessContracts(
  input: AoiSourceFreshnessContractInput,
): AoiSourceFreshnessContract[] {
  const now = input.now ?? Date.now();
  return (input.sourceRegistry?.sources ?? []).map((source) =>
    buildContractForSource(source, input, now),
  );
}

export function findAoiSourceFreshnessContract(
  contracts: readonly AoiSourceFreshnessContract[] | undefined,
  sourceId: string,
): AoiSourceFreshnessContract | undefined {
  return contracts?.find((contract) => contract.sourceId === sourceId);
}

export function scoreAoiSourceFreshnessContract(
  contract: AoiSourceFreshnessContract | undefined,
): number {
  if (!contract) {
    return 0;
  }
  if (contract.freshnessState === 'fresh') {
    return 0.04;
  }
  if (contract.freshnessState === 'unknown') {
    return -0.03;
  }
  if (contract.freshnessState === 'stale') {
    return -0.18;
  }
  if (contract.freshnessState === 'failed') {
    return -0.34;
  }
  if (contract.freshnessState === 'disconnected') {
    return -0.42;
  }
  return -0.5;
}

export function buildAoiSourceFreshnessDashboardContext(
  contracts: readonly AoiSourceFreshnessContract[] | undefined,
): AoiSourceFreshnessDashboardContext {
  const items = [...(contracts ?? [])];
  const stale = items
    .filter((contract) => contract.freshnessState === 'stale')
    .sort((left, right) => (left.lastObservedAt ?? 0) - (right.lastObservedAt ?? 0));
  const disconnected = items.filter((contract) => contract.freshnessState === 'disconnected');
  const revoked = items.filter(
    (contract) => contract.freshnessState === 'revoked' || contract.consentState === 'revoked',
  );
  const metadataOnly = items.filter(
    (contract) =>
      contract.bodyAccessState === 'body_disabled' ||
      contract.bodyAccessState === 'metadata_only' ||
      contract.bodyAccessState === 'withheld',
  );
  const visibleTimelineItems = [...items].sort((left, right) => {
    const leftProblem =
      left.freshnessState === 'stale' ||
      left.freshnessState === 'failed' ||
      left.freshnessState === 'disconnected' ||
      left.freshnessState === 'revoked' ||
      left.freshnessState === 'disabled'
        ? 1
        : 0;
    const rightProblem =
      right.freshnessState === 'stale' ||
      right.freshnessState === 'failed' ||
      right.freshnessState === 'disconnected' ||
      right.freshnessState === 'revoked' ||
      right.freshnessState === 'disabled'
        ? 1
        : 0;
    return (
      rightProblem - leftProblem ||
      (right.lastObservedAt ?? 0) - (left.lastObservedAt ?? 0) ||
      (right.lastSuccessfulReadAt ?? 0) - (left.lastSuccessfulReadAt ?? 0) ||
      left.sourceLabel.localeCompare(right.sourceLabel)
    );
  });
  const blindSpotLabels = dedupeStrings(
    [
      ...stale.map(
        (contract) =>
          `${contract.sourceLabel}: stale since ${formatTimestamp(contract.lastObservedAt)}; ${contract.cannotKnow[0]?.statement ?? 'freshness validation required'}`,
      ),
      ...disconnected.map(
        (contract) =>
          `${contract.sourceLabel}: disconnected; ${contract.cannotKnow[0]?.statement ?? 'source read unavailable'}`,
      ),
      ...revoked.map(
        (contract) =>
          `${contract.sourceLabel}: consent revoked; ${contract.cannotKnow[0]?.statement ?? 'source consent required'}`,
      ),
    ],
    10,
  );
  return {
    version: 1,
    visible: items.length > 0,
    statusLabel:
      blindSpotLabels.length > 0
        ? `${blindSpotLabels.length} source freshness boundary(s)`
        : `${items.length} source freshness contract(s)`,
    topStaleSourceLabels: dedupeStrings(
      stale.map(
        (contract) =>
          `${contract.sourceLabel}: last observed ${formatTimestamp(contract.lastObservedAt)}`,
      ),
      5,
    ),
    disconnectedSourceLabels: dedupeStrings(
      disconnected.map((contract) => `${contract.sourceLabel}: disconnected`),
      5,
    ),
    revokedSourceLabels: dedupeStrings(
      revoked.map((contract) => `${contract.sourceLabel}: consent ${contract.consentState}`),
      5,
    ),
    metadataOnlyBoundaryLabels: dedupeStrings(
      metadataOnly.map(
        (contract) =>
          `${contract.sourceLabel}: ${contract.dataScope}; body=${contract.bodyAccessState}`,
      ),
      8,
    ),
    lastObservedLabels: dedupeStrings(
      visibleTimelineItems.map(
        (contract) =>
          `${contract.sourceLabel}: observed ${formatTimestamp(contract.lastObservedAt)}`,
      ),
      8,
    ),
    lastSuccessfulReadLabels: dedupeStrings(
      visibleTimelineItems.map(
        (contract) =>
          `${contract.sourceLabel}: success ${formatTimestamp(contract.lastSuccessfulReadAt)}`,
      ),
      8,
    ),
    blindSpotLabels,
    evidenceRefs: dedupeStrings(
      items.flatMap((contract) => contract.evidenceRefs),
      16,
    ),
  };
}
