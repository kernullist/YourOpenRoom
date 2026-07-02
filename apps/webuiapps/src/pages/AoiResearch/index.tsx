import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AppLifecycle, initVibeApp } from '@gui/vibe-container';
import { Copy, ExternalLink, RefreshCw, Sparkles, Trash2, XCircle } from 'lucide-react';
import {
  reportAction,
  reportLifecycle,
  useAgentActionListener,
  type CharacterAppAction,
} from '@/lib';
import { getSessionPath } from '@/lib/sessionPath';
import { deleteAoiResearchRun, startAoiResearchRun } from '@/lib/aoiResearchClient';
import type {
  AoiResearchArtifactName,
  AoiResearchArtifactResponse,
  AoiResearchListResponse,
  AoiResearchMode,
  AoiResearchRecency,
  AoiResearchRunSummary,
} from '@/lib/aoiResearchTypes';
import styles from './index.module.scss';

const APP_ID = 24;
const APP_NAME = 'Aoi Research';

const RESEARCH_MODE_OPTIONS: { value: AoiResearchMode; label: string }[] = [
  { value: 'quick', label: 'Quick' },
  { value: 'standard', label: 'Standard' },
  { value: 'deep', label: 'Deep' },
];

const RESEARCH_RECENCY_OPTIONS: { value: AoiResearchRecency; label: string }[] = [
  { value: 'any', label: 'Any time' },
  { value: 'day', label: 'Past day' },
  { value: 'week', label: 'Past week' },
  { value: 'month', label: 'Past month' },
  { value: 'year', label: 'Past year' },
];

type DetailTab = 'sources' | 'evidence';

interface ArtifactState {
  report: string;
  sources: string;
  evidence: string;
}

function formatDateTime(value?: number): string {
  if (!value) {
    return '-';
  }
  return new Date(value).toLocaleString();
}

function getFinishedTime(run: AoiResearchRunSummary): number | undefined {
  if (run.completedAt) {
    return run.completedAt;
  }
  if (run.status === 'failed' || run.status === 'cancelled') {
    return run.updatedAt;
  }
  return undefined;
}

function statusLabel(run: AoiResearchRunSummary): string {
  return `${run.status} / ${run.phase}`;
}

function titleForRun(run: AoiResearchRunSummary): string {
  return run.title || run.request;
}

function stringifyArtifact(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error || `Request failed with ${response.status}`);
  }
  return data;
}

const AoiResearchPage: React.FC = () => {
  const [sessionPath, setSessionPath] = useState('');
  const [runs, setRuns] = useState<AoiResearchRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [detailTab, setDetailTab] = useState<DetailTab>('sources');
  const [artifacts, setArtifacts] = useState<ArtifactState>({
    report: '',
    sources: '',
    evidence: '',
  });
  const [loading, setLoading] = useState(true);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [flashText, setFlashText] = useState<string | null>(null);
  const [newRequest, setNewRequest] = useState('');
  const [newMode, setNewMode] = useState<AoiResearchMode>('standard');
  const [newRecency, setNewRecency] = useState<AoiResearchRecency>('any');
  const [starting, setStarting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId],
  );

  const loadRuns = useCallback(async () => {
    const currentSessionPath = getSessionPath().trim();
    setSessionPath(currentSessionPath);
    if (!currentSessionPath) {
      setRuns([]);
      setSelectedRunId('');
      setErrorText('Current session is not ready.');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const url = new URL('/api/aoi-research/list', window.location.origin);
      url.searchParams.set('sessionPath', currentSessionPath);
      url.searchParams.set('_t', String(Date.now()));
      const data = await fetchJson<AoiResearchListResponse>(`${url.pathname}${url.search}`);
      setRuns(data.runs);
      setErrorText(null);
      setSelectedRunId((previous) => {
        if (previous && data.runs.some((run) => run.id === previous)) {
          return previous;
        }
        return data.runs[0]?.id ?? '';
      });
      reportAction(APP_ID, 'REFRESH_AOI_RESEARCH_RUNS', { count: String(data.runs.length) });
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  const canStart = newRequest.trim().length > 0 && !starting;

  const submitResearch = useCallback(async () => {
    const trimmed = newRequest.trim();
    if (!trimmed || starting) {
      return;
    }
    try {
      setStarting(true);
      setErrorText(null);
      const response = await startAoiResearchRun({
        sessionPath,
        request: trimmed,
        mode: newMode,
        recency: newRecency,
      });
      setNewRequest('');
      setFlashText('Research started.');
      // User-initiated data mutation: notify the agent that a run now exists.
      // Not called from an Agent-dispatched handler, so no duplicate reporting.
      reportAction(APP_ID, 'CREATE_AOI_RESEARCH_RUN', {
        runId: response.run.id,
        request: trimmed,
      });
      await loadRuns();
      setSelectedRunId(response.run.id);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }, [loadRuns, newMode, newRecency, newRequest, sessionPath, starting]);

  const loadArtifact = useCallback(
    async (runId: string, artifact: AoiResearchArtifactName): Promise<string> => {
      if (!sessionPath || !runId) {
        return '';
      }
      const url = new URL('/api/aoi-research/artifact', window.location.origin);
      url.searchParams.set('sessionPath', sessionPath);
      url.searchParams.set('runId', runId);
      url.searchParams.set('artifact', artifact);
      const data = await fetchJson<AoiResearchArtifactResponse>(`${url.pathname}${url.search}`);
      return stringifyArtifact(data.content);
    },
    [sessionPath],
  );

  const refreshArtifacts = useCallback(async () => {
    if (!selectedRun) {
      setArtifacts({ report: '', sources: '', evidence: '' });
      return;
    }
    try {
      setArtifactLoading(true);
      const [report, detail] = await Promise.all([
        loadArtifact(selectedRun.id, 'report'),
        loadArtifact(selectedRun.id, detailTab),
      ]);
      setArtifacts((previous) => ({
        ...previous,
        report,
        [detailTab]: detail,
      }));
      setErrorText(null);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setArtifactLoading(false);
    }
  }, [detailTab, loadArtifact, selectedRun]);

  const cancelRun = useCallback(async () => {
    if (!selectedRun || !sessionPath) {
      return;
    }
    try {
      await fetchJson('/api/aoi-research/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionPath,
          runId: selectedRun.id,
          reason: 'Cancelled from Aoi Research Library.',
        }),
      });
      setFlashText('Cancelled.');
      reportAction(APP_ID, 'CANCEL_AOI_RESEARCH_RUN', { runId: selectedRun.id });
      await loadRuns();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [loadRuns, selectedRun, sessionPath]);

  const deleteRun = useCallback(async () => {
    if (!selectedRun || !sessionPath) {
      return;
    }
    const runId = selectedRun.id;
    try {
      setDeleting(true);
      setErrorText(null);
      await deleteAoiResearchRun({ sessionPath, runId });
      setConfirmingDelete(false);
      setSelectedRunId('');
      setFlashText('Research deleted.');
      // User-initiated data mutation: notify the agent the run is gone. Not called
      // from an Agent-dispatched handler, so no duplicate reporting.
      reportAction(APP_ID, 'DELETE_AOI_RESEARCH_RUN', { runId });
      await loadRuns();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }, [loadRuns, selectedRun, sessionPath]);

  const copyReport = useCallback(async () => {
    if (!selectedRun) {
      return;
    }
    try {
      const report = artifacts.report || (await loadArtifact(selectedRun.id, 'report'));
      await navigator.clipboard.writeText(report);
      setArtifacts((previous) => ({ ...previous, report }));
      setFlashText('Report copied.');
      reportAction(APP_ID, 'COPY_AOI_RESEARCH_REPORT', { runId: selectedRun.id });
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [artifacts.report, loadArtifact, selectedRun]);

  const openReport = useCallback(async () => {
    if (!selectedRun) {
      return;
    }
    try {
      const report = artifacts.report || (await loadArtifact(selectedRun.id, 'report'));
      setArtifacts((previous) => ({ ...previous, report }));
      const blob = new Blob([report], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      reportAction(APP_ID, 'OPEN_AOI_RESEARCH_REPORT', { runId: selectedRun.id });
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [artifacts.report, loadArtifact, selectedRun]);

  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'REFRESH_AOI_RESEARCH_RUNS': {
          await loadRuns();
          return 'success';
        }
        case 'OPEN_AOI_RESEARCH_REPORT': {
          await openReport();
          return 'success';
        }
        default:
          return `error: unknown action_type ${action.action_type}`;
      }
    },
    [loadRuns, openReport],
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
          windowStyle: { width: 1240, height: 760 },
        });
        reportLifecycle(AppLifecycle.DOM_READY);
        await loadRuns();
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
  }, [loadRuns]);

  useEffect(() => {
    void refreshArtifacts();
  }, [refreshArtifacts]);

  // Reset the delete confirmation whenever the selected run changes, so a pending
  // "confirm delete" never carries over to a different run.
  useEffect(() => {
    setConfirmingDelete(false);
  }, [selectedRun?.id]);

  useEffect(() => {
    if (!flashText) {
      return;
    }
    const timer = window.setTimeout(() => setFlashText(null), 2400);
    return () => window.clearTimeout(timer);
  }, [flashText]);

  const activeRuns = runs.filter((run) => run.status === 'queued' || run.status === 'running');
  const detailContent = detailTab === 'sources' ? artifacts.sources : artifacts.evidence;

  return (
    <main className={styles.aoiResearch} data-testid="aoi-research-page">
      <aside className={styles.runRail}>
        <div className={styles.railHeader}>
          <div>
            <h1>Aoi Research</h1>
            <span>{sessionPath || 'no session'}</span>
          </div>
          <button type="button" onClick={() => void loadRuns()} title="Refresh runs">
            <RefreshCw size={15} />
          </button>
        </div>

        <form
          className={styles.composer}
          data-testid="aoi-research-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submitResearch();
          }}
        >
          <textarea
            className={styles.composerInput}
            data-testid="aoi-research-new-request"
            value={newRequest}
            onChange={(event) => setNewRequest(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canStart) {
                event.preventDefault();
                void submitResearch();
              }
            }}
            placeholder="Ask Aoi to research a topic..."
            rows={2}
            disabled={starting}
          />
          <div className={styles.composerRow}>
            <select
              className={styles.composerSelect}
              data-testid="aoi-research-mode"
              value={newMode}
              onChange={(event) => setNewMode(event.target.value as AoiResearchMode)}
              disabled={starting}
              title="Research depth"
            >
              {RESEARCH_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className={styles.composerSelect}
              data-testid="aoi-research-recency"
              value={newRecency}
              onChange={(event) => setNewRecency(event.target.value as AoiResearchRecency)}
              disabled={starting}
              title="Source recency"
            >
              {RESEARCH_RECENCY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className={styles.composerStart}
              data-testid="aoi-research-start-btn"
              disabled={!canStart}
              title="Start a new research run"
            >
              <Sparkles size={14} />
              {starting ? 'Starting' : 'Research'}
            </button>
          </div>
          {!selectedRun && errorText ? (
            <div className={styles.composerError} data-testid="aoi-research-composer-error">
              {errorText}
            </div>
          ) : null}
        </form>

        <div className={styles.statStrip}>
          <div>
            <span>Total</span>
            <strong>{runs.length}</strong>
          </div>
          <div>
            <span>Active</span>
            <strong>{activeRuns.length}</strong>
          </div>
        </div>

        <div className={styles.runList}>
          {loading ? <div className={styles.emptyState}>Loading...</div> : null}
          {!loading && runs.length === 0 ? (
            <div className={styles.emptyState}>No runs yet.</div>
          ) : null}
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              className={`${styles.runItem} ${selectedRun?.id === run.id ? styles.selectedRun : ''}`}
              onClick={() => setSelectedRunId(run.id)}
            >
              <div className={styles.runItemTop}>
                <span className={`${styles.statusPill} ${styles[run.status]}`}>{run.status}</span>
                <span>{formatDateTime(run.createdAt)}</span>
              </div>
              <strong>{titleForRun(run)}</strong>
              <p>{run.request}</p>
              <div className={styles.runCounts}>
                <span>{run.sourceCounts.accepted} accepted</span>
                <span>{run.sourceCounts.failed} failed</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className={styles.reportPane}>
        {selectedRun ? (
          <>
            <div className={styles.reportHeader}>
              <div>
                <span className={styles.kicker}>{statusLabel(selectedRun)}</span>
                <h2>{titleForRun(selectedRun)}</h2>
                <p>{selectedRun.request}</p>
              </div>
              <div className={styles.headerActions}>
                <button
                  type="button"
                  onClick={() => void refreshArtifacts()}
                  title="Refresh artifacts"
                >
                  <RefreshCw size={15} />
                </button>
                <button type="button" onClick={() => void openReport()} title="Open report">
                  <ExternalLink size={15} />
                </button>
                <button type="button" onClick={() => void copyReport()} title="Copy report">
                  <Copy size={15} />
                </button>
                {selectedRun.status === 'queued' || selectedRun.status === 'running' ? (
                  <button type="button" onClick={() => void cancelRun()} title="Cancel run">
                    <XCircle size={15} />
                  </button>
                ) : confirmingDelete ? (
                  <div className={styles.deleteConfirm} data-testid="aoi-research-delete-confirm">
                    <span>Delete?</span>
                    <button
                      type="button"
                      className={styles.deleteConfirmYes}
                      onClick={() => void deleteRun()}
                      disabled={deleting}
                      title="Confirm delete"
                      data-testid="aoi-research-delete-yes"
                    >
                      {deleting ? 'Deleting' : 'Delete'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={deleting}
                      title="Keep this run"
                      data-testid="aoi-research-delete-no"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={styles.deleteBtn}
                    onClick={() => setConfirmingDelete(true)}
                    title="Delete run"
                    data-testid="aoi-research-delete-btn"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </div>

            <div className={styles.metaGrid}>
              <div>
                <span>Created</span>
                <strong>{formatDateTime(selectedRun.createdAt)}</strong>
              </div>
              <div>
                <span>Finished</span>
                <strong>{formatDateTime(getFinishedTime(selectedRun))}</strong>
              </div>
              <div>
                <span>Sources</span>
                <strong>
                  {selectedRun.sourceCounts.accepted}/{selectedRun.sourceCounts.candidates}
                </strong>
              </div>
              <div>
                <span>Claims</span>
                <strong>{selectedRun.claimCount ?? 0}</strong>
              </div>
            </div>

            {errorText ? <div className={styles.errorBox}>{errorText}</div> : null}
            {flashText ? <div className={styles.flashBox}>{flashText}</div> : null}

            <article className={styles.reportPreview}>
              {artifactLoading && !artifacts.report ? (
                <div className={styles.emptyState}>Loading report...</div>
              ) : artifacts.report ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{artifacts.report}</ReactMarkdown>
              ) : (
                <div className={styles.emptyState}>Report artifact is not available.</div>
              )}
            </article>
          </>
        ) : (
          <div className={styles.emptyState}>Select a run.</div>
        )}
      </section>

      <aside className={styles.detailPane}>
        <div className={styles.tabs}>
          <button
            type="button"
            className={detailTab === 'sources' ? styles.activeTab : ''}
            onClick={() => setDetailTab('sources')}
          >
            Sources
          </button>
          <button
            type="button"
            className={detailTab === 'evidence' ? styles.activeTab : ''}
            onClick={() => setDetailTab('evidence')}
          >
            Evidence
          </button>
        </div>
        <pre className={styles.artifactBlock}>
          {artifactLoading && !detailContent
            ? 'Loading artifact...'
            : detailContent || 'No artifact.'}
        </pre>
      </aside>
    </main>
  );
};

export default AoiResearchPage;
