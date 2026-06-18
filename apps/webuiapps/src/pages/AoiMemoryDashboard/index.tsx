import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppLifecycle, initVibeApp } from '@gui/vibe-container';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock,
  Copy,
  Database,
  Minus,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  archiveAoiMemory,
  deleteAoiMemory,
  demoteAoiPreferenceMemory,
  loadAoiMemories,
  markAoiMemoryTemporary,
  saveAoiPreferenceMemory,
  selectAoiMemoriesForPrompt,
  type AoiMemoryEntry,
  type AoiMemoryScope,
  type AoiMemoryStatus,
  type AoiMemoryType,
} from '@/lib/aoiMemoryManager';
import {
  reportAction,
  reportLifecycle,
  useAgentActionListener,
  type CharacterAppAction,
} from '@/lib';
import styles from './index.module.scss';

const APP_ID = 25;
const APP_NAME = 'Aoi Memory';
const MEMORY_API_PATH = '/api/session-data';
const MEMORY_ROOT = 'aoi/memory-v2';
const PROMPT_CONFIDENCE_FLOOR = 0.45;
const DEFAULT_PROMPT_PROBE = '꿀보에 대해 알고 있는 것, 선호, 작업 방식, 관심사';

type ScopeFilter = 'all' | AoiMemoryScope;
type TypeFilter = 'all' | AoiMemoryType;
type StatusFilter = 'all' | AoiMemoryStatus;
type TrustFilter = 'all' | 'confirmed' | 'inferred' | 'needs_review' | 'inactive';

interface EpisodeSummary {
  count: number;
  sessionBuckets: number;
}

interface MemoryOverview {
  total: number;
  active: number;
  archived: number;
  superseded: number;
  permanent: number;
  promptEligible: number;
  needsReview: number;
}

interface LensItem {
  key: string;
  label: string;
  count: number;
}

function memoryDataUrl(path: string, action?: 'list'): string {
  const url = new URL(MEMORY_API_PATH, window.location.origin);
  url.searchParams.set('path', path);
  if (action) {
    url.searchParams.set('action', action);
  }
  return `${url.pathname}${url.search}`;
}

async function listSessionData(path: string): Promise<Array<{ path: string; type: number }>> {
  try {
    const response = await fetch(memoryDataUrl(path, 'list'));
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as { files?: Array<{ path: string; type: number }> };
    return Array.isArray(data.files) ? data.files : [];
  } catch {
    return [];
  }
}

async function loadEpisodeSummary(): Promise<EpisodeSummary> {
  const stack = [`${MEMORY_ROOT}/episodes`];
  let count = 0;
  const sessionBuckets = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const files = await listSessionData(current);
    for (const file of files) {
      if (file.type === 1) {
        stack.push(file.path);
        continue;
      }
      if (file.path.endsWith('.json')) {
        count += 1;
        const bucket = file.path.replace(`${MEMORY_ROOT}/episodes/`, '').split('/').slice(0, -1);
        if (bucket.length > 0) {
          sessionBuckets.add(bucket.join('/'));
        }
      }
    }
  }

  return { count, sessionBuckets: sessionBuckets.size };
}

function formatDateTime(value?: number): string {
  if (!value) {
    return '-';
  }
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

function oneLine(value: string, limit = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1).trimEnd()}...`;
}

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function buildMemorySignalStyle(memory: AoiMemoryEntry): React.CSSProperties {
  const strength = memory.confidence * 0.68 + memory.importance * 0.32;
  return {
    '--signal-strength': percent(strength),
    '--signal-confidence': percent(memory.confidence),
    '--signal-importance': percent(memory.importance),
  } as React.CSSProperties;
}

function isPromptEligible(memory: AoiMemoryEntry, now = Date.now()): boolean {
  if (memory.status !== 'active') {
    return false;
  }
  if (
    memory.tags.includes('demoted') ||
    memory.tags.includes('one-off-correction') ||
    memory.tags.includes('proposal-negative-feedback')
  ) {
    return false;
  }
  if (!memory.permanent && memory.confidence < PROMPT_CONFIDENCE_FLOOR) {
    return false;
  }
  if (!memory.permanent && memory.expiresAt && memory.expiresAt <= now) {
    return false;
  }
  return true;
}

function getTrust(memory: AoiMemoryEntry): TrustFilter {
  if (memory.status !== 'active') {
    return 'inactive';
  }
  if (memory.permanent || memory.confidence >= 0.86) {
    return 'confirmed';
  }
  if (memory.confidence >= 0.65) {
    return 'inferred';
  }
  return 'needs_review';
}

function getTrustLabel(memory: AoiMemoryEntry): string {
  switch (getTrust(memory)) {
    case 'confirmed':
      return '확실함';
    case 'inferred':
      return '추정';
    case 'needs_review':
      return '확인 필요';
    case 'inactive':
      return '비활성';
    default:
      return '전체';
  }
}

function getMemoryLens(memory: AoiMemoryEntry): string {
  const source =
    `${memory.content} ${memory.tags.join(' ')} ${memory.entities.join(' ')}`.toLowerCase();
  if (memory.type === 'preference' || source.includes('preference') || source.includes('선호')) {
    return 'preferences';
  }
  if (source.includes('interest') || source.includes('관심') || source.includes('asked')) {
    return 'interests';
  }
  if (memory.scope === 'project' || source.includes('project') || source.includes('workspace')) {
    return 'projects';
  }
  if (source.includes('workflow') || source.includes('procedure') || memory.type === 'procedure') {
    return 'workflow';
  }
  if (memory.type === 'event' || memory.type === 'action' || memory.type === 'decision') {
    return 'events';
  }
  return 'facts';
}

function lensLabel(key: string): string {
  switch (key) {
    case 'preferences':
      return '선호/규칙';
    case 'interests':
      return '관심사';
    case 'projects':
      return '프로젝트';
    case 'workflow':
      return '작업 방식';
    case 'events':
      return '세션 사건';
    default:
      return '사실';
  }
}

function lensQuery(key: string): string {
  switch (key) {
    case 'preferences':
      return 'preference';
    case 'interests':
      return 'interest';
    case 'projects':
      return 'project';
    case 'workflow':
      return 'workflow';
    case 'events':
      return 'event';
    default:
      return '';
  }
}

function getMemoryFlags(memory: AoiMemoryEntry): string[] {
  const flags: string[] = [];
  const text = `${memory.content} ${memory.tags.join(' ')}`.toLowerCase();

  if (memory.permanent) {
    flags.push('pinned');
  }
  if (isPromptEligible(memory)) {
    flags.push('prompt');
  }
  if (memory.confidence < 0.65 && memory.status === 'active') {
    flags.push('needs review');
  }
  if (/app_id|action_type|performed action|user closed app|opens app/.test(text)) {
    flags.push('low signal');
  }
  if (memory.tags.includes('llm-distilled')) {
    flags.push('distilled');
  }
  if (memory.sourceEpisodeIds.length === 0) {
    flags.push('no source');
  }
  if (memory.expiresAt) {
    flags.push('temporary');
  }

  return flags;
}

function summarizeMemories(memories: AoiMemoryEntry[]): MemoryOverview {
  const now = Date.now();
  return memories.reduce<MemoryOverview>(
    (summary, memory) => {
      summary.total += 1;
      if (memory.status === 'active') {
        summary.active += 1;
      }
      if (memory.status === 'archived') {
        summary.archived += 1;
      }
      if (memory.status === 'superseded') {
        summary.superseded += 1;
      }
      if (memory.status === 'active' && memory.permanent) {
        summary.permanent += 1;
      }
      if (isPromptEligible(memory, now)) {
        summary.promptEligible += 1;
      }
      if (getTrust(memory) === 'needs_review' || getMemoryFlags(memory).includes('low signal')) {
        summary.needsReview += 1;
      }
      return summary;
    },
    {
      total: 0,
      active: 0,
      archived: 0,
      superseded: 0,
      permanent: 0,
      promptEligible: 0,
      needsReview: 0,
    },
  );
}

function buildLensItems(memories: AoiMemoryEntry[]): LensItem[] {
  const counts = new Map<string, number>();
  for (const memory of memories) {
    counts.set(getMemoryLens(memory), (counts.get(getMemoryLens(memory)) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, label: lensLabel(key), count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function matchesQuery(memory: AoiMemoryEntry, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const haystack = [
    memory.id,
    memory.content,
    memory.scope,
    memory.type,
    memory.status,
    ...memory.tags,
    ...memory.entities,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(normalized);
}

function filterMemories(
  memories: AoiMemoryEntry[],
  filters: {
    scope: ScopeFilter;
    type: TypeFilter;
    status: StatusFilter;
    trust: TrustFilter;
    query: string;
  },
): AoiMemoryEntry[] {
  return memories
    .filter((memory) => filters.scope === 'all' || memory.scope === filters.scope)
    .filter((memory) => filters.type === 'all' || memory.type === filters.type)
    .filter((memory) => filters.status === 'all' || memory.status === filters.status)
    .filter((memory) => filters.trust === 'all' || getTrust(memory) === filters.trust)
    .filter((memory) => matchesQuery(memory, filters.query))
    .sort((left, right) => {
      const leftPrompt = isPromptEligible(left) ? 1 : 0;
      const rightPrompt = isPromptEligible(right) ? 1 : 0;
      return rightPrompt - leftPrompt || right.updatedAt - left.updatedAt;
    });
}

const AoiMemoryDashboard: React.FC = () => {
  const [memories, setMemories] = useState<AoiMemoryEntry[]>([]);
  const [episodeSummary, setEpisodeSummary] = useState<EpisodeSummary>({
    count: 0,
    sessionBuckets: 0,
  });
  const [selectedMemoryId, setSelectedMemoryId] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [trustFilter, setTrustFilter] = useState<TrustFilter>('all');
  const [query, setQuery] = useState('');
  const [promptProbe, setPromptProbe] = useState(DEFAULT_PROMPT_PROBE);
  const [loading, setLoading] = useState(true);
  const [pendingMemoryId, setPendingMemoryId] = useState('');
  const [deleteArmedMemoryId, setDeleteArmedMemoryId] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [flashText, setFlashText] = useState<string | null>(null);

  const overview = useMemo(() => summarizeMemories(memories), [memories]);
  const lensItems = useMemo(() => buildLensItems(memories), [memories]);
  const promptCandidates = useMemo(
    () => selectAoiMemoriesForPrompt(memories, promptProbe || DEFAULT_PROMPT_PROBE),
    [memories, promptProbe],
  );
  const promptCandidateIds = useMemo(
    () => new Set(promptCandidates.map((memory) => memory.id)),
    [promptCandidates],
  );
  const visibleMemories = useMemo(
    () =>
      filterMemories(memories, {
        scope: scopeFilter,
        type: typeFilter,
        status: statusFilter,
        trust: trustFilter,
        query,
      }),
    [memories, query, scopeFilter, statusFilter, trustFilter, typeFilter],
  );
  const selectedMemory =
    memories.find((memory) => memory.id === selectedMemoryId) ?? visibleMemories[0] ?? null;
  const selectedFlags = selectedMemory ? getMemoryFlags(selectedMemory) : [];
  const readinessRatio = overview.promptEligible / Math.max(1, overview.total);
  const readinessScore = Math.round(readinessRatio * 100);
  const reviewRatio = overview.needsReview / Math.max(1, overview.total);

  const loadDashboard = useCallback(async () => {
    try {
      setLoading(true);
      const [nextMemories, nextEpisodeSummary] = await Promise.all([
        loadAoiMemories(),
        loadEpisodeSummary(),
      ]);
      setMemories(nextMemories);
      setEpisodeSummary(nextEpisodeSummary);
      setSelectedMemoryId((previous) => {
        if (previous && nextMemories.some((memory) => memory.id === previous)) {
          return previous;
        }
        return nextMemories[0]?.id ?? '';
      });
      setErrorText(null);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const runMemoryAction = useCallback(
    async (
      memoryId: string,
      action: (id: string) => Promise<AoiMemoryEntry[]>,
      successMessage: string,
      actionType: string,
    ) => {
      try {
        setPendingMemoryId(memoryId);
        const nextMemories = await action(memoryId);
        setMemories(nextMemories);
        setFlashText(successMessage);
        setDeleteArmedMemoryId('');
        reportAction(APP_ID, actionType, { memoryId });
        setErrorText(null);
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error));
      } finally {
        setPendingMemoryId('');
      }
    },
    [],
  );

  const copyPromptCandidates = useCallback(async () => {
    const lines = promptCandidates.map(
      (memory) =>
        `- [${memory.scope}/${memory.type}, confidence ${memory.confidence.toFixed(2)}] ${memory.content}`,
    );
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setFlashText('Prompt 후보를 클립보드에 복사했어.');
      reportAction(APP_ID, 'COPY_AOI_MEMORY_PROMPT_CANDIDATES', {
        count: String(promptCandidates.length),
      });
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [promptCandidates]);

  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'REFRESH_AOI_MEMORY_DASHBOARD': {
          await loadDashboard();
          return 'success';
        }
        case 'FILTER_AOI_MEMORY': {
          setQuery(action.params?.query ?? '');
          return 'success';
        }
        case 'ARCHIVE_AOI_MEMORY': {
          const memoryId = action.params?.memoryId ?? action.params?.memory_id;
          if (!memoryId) {
            return 'error: memoryId is required';
          }
          await runMemoryAction(memoryId, archiveAoiMemory, 'Memory archived.', action.action_type);
          return 'success';
        }
        default:
          return `error: unknown action_type ${action.action_type}`;
      }
    },
    [loadDashboard, runMemoryAction],
  );

  useAgentActionListener(APP_ID, handleAgentAction);

  useEffect(() => {
    const init = async () => {
      try {
        reportLifecycle(AppLifecycle.LOADING);
        const manager = await initVibeApp({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: APP_NAME,
          windowStyle: { width: 1280, height: 760 },
        });
        reportLifecycle(AppLifecycle.DOM_READY);
        await loadDashboard();
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error));
        reportLifecycle(AppLifecycle.ERROR, String(error));
      }
    };

    void init();

    return () => {
      reportLifecycle(AppLifecycle.UNLOADING);
      reportLifecycle(AppLifecycle.DESTROYED);
    };
  }, [loadDashboard]);

  useEffect(() => {
    setDeleteArmedMemoryId('');
  }, [selectedMemory?.id]);

  return (
    <main className={styles.dashboard} data-testid="aoi-memory-dashboard">
      <div className={styles.dashboardLayout}>
        <aside className={styles.rail}>
          <div className={styles.identity}>
            <div className={styles.brandMark}>
              <Database size={20} />
            </div>
            <div className={styles.identityText}>
              <span>Memory Console</span>
              <h1>Aoi Memory</h1>
            </div>
          </div>

          <section className={styles.statusBlock}>
            <div className={styles.statusHead}>
              <div>
                <span>Readiness</span>
                <strong>{overview.promptEligible > 0 ? 'Memory online' : 'Needs signal'}</strong>
              </div>
              <div
                className={styles.readinessDial}
                style={{ '--readiness-score': percent(readinessRatio) } as React.CSSProperties}
              >
                <strong>{readinessScore}</strong>
                <span>score</span>
              </div>
              {overview.needsReview > 0 ? (
                <AlertTriangle size={20} className={styles.warnIcon} />
              ) : (
                <ShieldCheck size={20} className={styles.goodIcon} />
              )}
            </div>
            <div className={styles.statusMeter}>
              <span style={{ width: percent(readinessRatio) }} />
            </div>
            <div className={styles.statusFooter}>
              <span>Prompt-ready</span>
              <strong>
                {overview.promptEligible}/{overview.total}
              </strong>
            </div>
          </section>

          <div className={styles.railStats}>
            <div className={styles.primaryStat}>
              <span>Total records</span>
              <strong>{overview.total}</strong>
            </div>
            <div>
              <span>Episodes</span>
              <strong>{episodeSummary.count}</strong>
            </div>
            <div>
              <span>Review</span>
              <strong>{overview.needsReview}</strong>
            </div>
            <div>
              <span>Pinned</span>
              <strong>{overview.permanent}</strong>
            </div>
          </div>

          <section className={styles.railGroup}>
            <div className={styles.groupHeader}>
              <span>Knowledge Map</span>
            </div>
            <div className={styles.lensList}>
              {lensItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    setQuery(lensQuery(item.key));
                    setTrustFilter('all');
                  }}
                >
                  <span>{item.label}</span>
                  <strong>{item.count}</strong>
                </button>
              ))}
            </div>
          </section>

          <section className={styles.railGroup}>
            <div className={styles.groupHeader}>
              <span>Storage</span>
            </div>
            <div className={styles.storageGrid}>
              <div>
                <span>Active</span>
                <strong>{overview.active}</strong>
              </div>
              <div>
                <span>Archived</span>
                <strong>{overview.archived}</strong>
              </div>
              <div>
                <span>Superseded</span>
                <strong>{overview.superseded}</strong>
              </div>
              <div>
                <span>Permanent</span>
                <strong>{overview.permanent}</strong>
              </div>
              <div>
                <span>Session buckets</span>
                <strong>{episodeSummary.sessionBuckets}</strong>
              </div>
            </div>
          </section>
        </aside>

        <section className={styles.listPane}>
          <header className={styles.commandBar}>
            <div>
              <span>Memory Ledger</span>
              <h2>{visibleMemories.length} records</h2>
            </div>
            <div className={styles.commandActions}>
              {flashText ? <span className={styles.flash}>{flashText}</span> : null}
              <button type="button" onClick={() => void loadDashboard()} disabled={loading}>
                <RefreshCw size={15} />
                Refresh
              </button>
            </div>
          </header>

          <div className={styles.topline}>
            <div>
              <span>Active</span>
              <strong>{overview.active}</strong>
            </div>
            <div>
              <span>Prompt-ready</span>
              <strong>{overview.promptEligible}</strong>
            </div>
            <div className={overview.needsReview > 0 ? styles.warnMetric : ''}>
              <span>Review queue</span>
              <strong>{overview.needsReview}</strong>
            </div>
            <div>
              <span>Session buckets</span>
              <strong>{episodeSummary.sessionBuckets}</strong>
            </div>
          </div>

          <div className={styles.controlStrip}>
            <label className={styles.searchBox}>
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="기억 내용, 태그, 스코프 검색"
              />
            </label>
            <select
              value={scopeFilter}
              onChange={(event) => setScopeFilter(event.target.value as ScopeFilter)}
            >
              <option value="all">All scopes</option>
              <option value="user">User</option>
              <option value="agent">Agent</option>
              <option value="session">Session</option>
              <option value="project">Project</option>
            </select>
            <select
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}
            >
              <option value="all">All types</option>
              <option value="fact">Fact</option>
              <option value="preference">Preference</option>
              <option value="decision">Decision</option>
              <option value="event">Event</option>
              <option value="procedure">Procedure</option>
              <option value="action">Action</option>
              <option value="emotion">Emotion</option>
            </select>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            >
              <option value="all">All status</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="superseded">Superseded</option>
            </select>
            <select
              value={trustFilter}
              onChange={(event) => setTrustFilter(event.target.value as TrustFilter)}
            >
              <option value="all">All trust</option>
              <option value="confirmed">확실함</option>
              <option value="inferred">추정</option>
              <option value="needs_review">확인 필요</option>
              <option value="inactive">비활성</option>
            </select>
          </div>

          {errorText ? <div className={styles.errorBox}>{errorText}</div> : null}

          <section className={styles.briefStrip}>
            <div className={styles.briefHeader}>
              <div>
                <span>Current Brief</span>
                <strong>{promptCandidates.length} candidates</strong>
              </div>
              <button type="button" onClick={() => void copyPromptCandidates()}>
                <Copy size={14} />
                Copy
              </button>
            </div>
            <input
              className={styles.probeInput}
              value={promptProbe}
              onChange={(event) => setPromptProbe(event.target.value)}
            />
            <div className={styles.promptCandidates}>
              {promptCandidates.slice(0, 6).map((memory) => (
                <button
                  type="button"
                  key={memory.id}
                  onClick={() => setSelectedMemoryId(memory.id)}
                  className={selectedMemory?.id === memory.id ? styles.selectedPromptChip : ''}
                >
                  <span>{memory.scope}</span>
                  <strong>{memory.confidence.toFixed(2)}</strong>
                </button>
              ))}
              {promptCandidates.length === 0 ? <span>No prompt candidates</span> : null}
            </div>
          </section>

          <div className={styles.ledgerHeader}>
            <span>Memory</span>
            <span>Signals</span>
          </div>

          <div className={styles.memoryList} data-testid="aoi-memory-list">
            {loading ? (
              <div className={styles.emptyState}>Loading Aoi memory...</div>
            ) : visibleMemories.length > 0 ? (
              visibleMemories.map((memory) => {
                const selected = selectedMemory?.id === memory.id;
                const flags = getMemoryFlags(memory);
                return (
                  <button
                    type="button"
                    key={memory.id}
                    className={`${styles.memoryRow} ${selected ? styles.selectedMemoryRow : ''}`}
                    onClick={() => setSelectedMemoryId(memory.id)}
                    data-testid={`aoi-memory-row-${memory.id}`}
                  >
                    <span className={styles.trustRail} aria-hidden="true" />
                    <div className={styles.memoryMain}>
                      <div className={styles.memoryMeta}>
                        <span className={styles.scopeBadge}>{memory.scope}</span>
                        <span>{memory.type}</span>
                        <span className={styles[getTrust(memory)]}>{getTrustLabel(memory)}</span>
                        {promptCandidateIds.has(memory.id) ? <span>prompt now</span> : null}
                      </div>
                      <strong>{oneLine(memory.content, 210)}</strong>
                      <div className={styles.memoryFlags}>
                        {flags.slice(0, 4).map((flag) => (
                          <span key={flag}>{flag}</span>
                        ))}
                        {flags.length === 0 ? <span>clean</span> : null}
                      </div>
                      <div
                        className={styles.rowSignalTrace}
                        style={buildMemorySignalStyle(memory)}
                        aria-hidden="true"
                      >
                        <span />
                        <i />
                      </div>
                    </div>
                    <div className={styles.memorySignals}>
                      <span>{formatDateTime(memory.updatedAt)}</span>
                      <strong>{memory.confidence.toFixed(2)}</strong>
                      <small>conf</small>
                      <strong>{memory.importance.toFixed(2)}</strong>
                      <small>importance</small>
                    </div>
                  </button>
                );
              })
            ) : (
              <div className={styles.emptyState}>조건에 맞는 기억이 없어.</div>
            )}
          </div>
        </section>

        <aside className={styles.inspectorPane}>
          {selectedMemory ? (
            <>
              <header className={styles.inspectorHeader}>
                <div>
                  <span>Selected Memory</span>
                  <h2>{getTrustLabel(selectedMemory)}</h2>
                </div>
                <div className={styles.inspectorIcon}>
                  {selectedMemory.permanent ? <Pin size={18} /> : <Clock size={18} />}
                </div>
              </header>

              <section className={styles.memoryInspectorCard}>
                <div className={styles.detailMeta}>
                  <span>{selectedMemory.scope}</span>
                  <span>{selectedMemory.type}</span>
                  <span>{selectedMemory.status}</span>
                  {isPromptEligible(selectedMemory) ? <span>prompt eligible</span> : null}
                </div>
                <p>{selectedMemory.content}</p>
              </section>

              <section className={styles.scorePanel}>
                <div className={styles.scoreRow}>
                  <div>
                    <span>Confidence</span>
                    <strong>{selectedMemory.confidence.toFixed(2)}</strong>
                  </div>
                  <div className={styles.scoreBar}>
                    <span style={{ width: percent(selectedMemory.confidence) }} />
                  </div>
                </div>
                <div className={styles.scoreRow}>
                  <div>
                    <span>Importance</span>
                    <strong>{selectedMemory.importance.toFixed(2)}</strong>
                  </div>
                  <div className={styles.scoreBar}>
                    <span style={{ width: percent(selectedMemory.importance) }} />
                  </div>
                </div>
              </section>

              <section
                className={styles.signalPanel}
                style={buildMemorySignalStyle(selectedMemory)}
                aria-label="Memory signal trace"
              >
                <div>
                  <span>Memory signal trace</span>
                  <strong>
                    {Math.round((selectedMemory.confidence + selectedMemory.importance) * 50)}%
                  </strong>
                </div>
                <span className={styles.inspectorTrace}>
                  <i />
                </span>
              </section>

              <section className={styles.inspectorSection}>
                <div className={styles.groupHeader}>
                  <span>Operational Flags</span>
                </div>
                <div className={styles.flagWrap}>
                  {selectedFlags.map((flag) => (
                    <span key={flag}>{flag}</span>
                  ))}
                  {selectedFlags.length === 0 ? <span>clean</span> : null}
                </div>
              </section>

              <section className={styles.inspectorSection}>
                <div className={styles.groupHeader}>
                  <span>Source</span>
                </div>
                <div className={styles.sourceGrid}>
                  <div>
                    <span>Created</span>
                    <strong>{formatDateTime(selectedMemory.createdAt)}</strong>
                  </div>
                  <div>
                    <span>Updated</span>
                    <strong>{formatDateTime(selectedMemory.updatedAt)}</strong>
                  </div>
                  <div>
                    <span>Source episodes</span>
                    <strong>{selectedMemory.sourceEpisodeIds.length}</strong>
                  </div>
                  <div>
                    <span>Lens</span>
                    <strong>{lensLabel(getMemoryLens(selectedMemory))}</strong>
                  </div>
                </div>
              </section>

              <section className={styles.inspectorSection}>
                <div className={styles.groupHeader}>
                  <span>Tags</span>
                </div>
                <div className={styles.flagWrap}>
                  {selectedMemory.tags.length > 0 ? (
                    selectedMemory.tags.map((tag) => <span key={tag}>{tag}</span>)
                  ) : (
                    <span>no tags</span>
                  )}
                </div>
              </section>

              <section className={styles.actionPanel}>
                <button
                  type="button"
                  onClick={() =>
                    void runMemoryAction(
                      selectedMemory.id,
                      saveAoiPreferenceMemory,
                      '영구 선호 기억으로 저장했어.',
                      'SAVE_AOI_MEMORY_AS_PREFERENCE',
                    )
                  }
                  disabled={Boolean(pendingMemoryId) || selectedMemory.permanent}
                >
                  <Plus size={14} />
                  Save preference
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void runMemoryAction(
                      selectedMemory.id,
                      markAoiMemoryTemporary,
                      '세션 임시 기억으로 낮췄어.',
                      'MARK_AOI_MEMORY_TEMPORARY',
                    )
                  }
                  disabled={Boolean(pendingMemoryId) || selectedMemory.status === 'archived'}
                >
                  <RotateCcw size={14} />
                  Temporary
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void runMemoryAction(
                      selectedMemory.id,
                      demoteAoiPreferenceMemory,
                      '기억 신뢰도를 낮췄어.',
                      'DEMOTE_AOI_MEMORY',
                    )
                  }
                  disabled={Boolean(pendingMemoryId) || selectedMemory.status !== 'active'}
                >
                  <Minus size={14} />
                  Demote
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void runMemoryAction(
                      selectedMemory.id,
                      archiveAoiMemory,
                      '기억을 보관 처리했어.',
                      'ARCHIVE_AOI_MEMORY',
                    )
                  }
                  disabled={Boolean(pendingMemoryId) || selectedMemory.status === 'archived'}
                >
                  <Archive size={14} />
                  Archive
                </button>
                <button
                  type="button"
                  className={styles.dangerBtn}
                  onClick={() => {
                    if (deleteArmedMemoryId !== selectedMemory.id) {
                      setDeleteArmedMemoryId(selectedMemory.id);
                      return;
                    }
                    void runMemoryAction(
                      selectedMemory.id,
                      deleteAoiMemory,
                      '기억을 삭제했어.',
                      'DELETE_AOI_MEMORY',
                    );
                  }}
                  disabled={Boolean(pendingMemoryId)}
                >
                  <Trash2 size={14} />
                  {deleteArmedMemoryId === selectedMemory.id ? 'Confirm delete' : 'Delete'}
                </button>
              </section>
            </>
          ) : (
            <div className={styles.emptyDetail}>
              <CheckCircle2 size={24} />
              <strong>선택된 기억이 없어.</strong>
              <span>왼쪽 리스트에서 기억을 선택해줘.</span>
            </div>
          )}
        </aside>
      </div>
      <div className={styles.signalFooter} aria-hidden="true">
        <span>memory signal trace</span>
        <i style={{ width: percent(readinessRatio) }} />
        <b style={{ width: percent(reviewRatio) }} />
      </div>
    </main>
  );
};

export default AoiMemoryDashboard;
