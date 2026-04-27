import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { initVibeApp, AppLifecycle } from '@gui/vibe-container';
import {
  useFileSystem,
  useAgentActionListener,
  reportAction,
  reportLifecycle,
  createAppFileApi,
  fetchVibeInfo,
  generateId,
  type CharacterAppAction,
} from '@/lib';
import { getSessionPath } from '@/lib/sessionPath';
import './i18n';
import styles from './index.module.scss';
import {
  type KiraTaskStatus,
  type KiraAttemptRecord,
  type KiraReviewRecord,
  type KiraViewState,
  type TaskComment,
  type WorkTask,
  DEFAULT_VIEW_STATE,
  STATUS_ORDER,
  formatTimestamp,
  getCommentFilePath,
  getWorkFilePath,
  groupWorksByStatus,
  matchesProjectName,
  normalizeTaskComment,
  normalizeKiraAttempt,
  normalizeKiraReview,
  normalizeWorkTask,
  sortByCreatedAtDesc,
  sortByUpdatedAtDesc,
} from './model';

const APP_ID = 18;
const APP_NAME = 'kira';
const WORKS_DIR = '/works';
const COMMENTS_DIR = '/comments';
const ATTEMPTS_DIR = '/attempts';
const REVIEWS_DIR = '/reviews';
const STATE_FILE = '/state.json';
const KIRA_LIVE_REFRESH_INTERVAL_MS = 4_000;

const kiraFileApi = createAppFileApi(APP_NAME);

interface TaskFormState {
  id: string | null;
  title: string;
  description: string;
  status: KiraTaskStatus;
  assignee: string;
}

interface FocusTarget {
  id?: string | null;
}

interface KiraProjectEntry {
  name: string;
  path: string;
}

interface KiraConfigResponse {
  configured: boolean;
  exists?: boolean;
  workRootDirectory?: string;
  projects?: KiraProjectEntry[];
}

interface KiraDiscoveryFinding {
  id: string;
  kind: 'feature' | 'bug';
  title: string;
  summary: string;
  evidence: string[];
  files: string[];
  taskDescription: string;
}

interface KiraProjectDiscoveryAnalysis {
  id: string;
  projectName: string;
  summary: string;
  findings: KiraDiscoveryFinding[];
  basedOnPreviousAnalysis: boolean;
  previousAnalysisId?: string;
  createdAt: number;
  updatedAt: number;
}

type KiraDiscoveryStage =
  | 'idle'
  | 'chooseExisting'
  | 'analyzing'
  | 'ready'
  | 'creating'
  | 'created'
  | 'done'
  | 'error';

type KiraDiscoveryEvent =
  | { type: 'log'; message: string }
  | { type: 'analysis_complete'; message?: string; analysis: KiraProjectDiscoveryAnalysis }
  | { type: 'error'; message: string }
  | { type: 'done' };

async function consumeSseResponse(
  response: Response,
  onEvent: (event: KiraDiscoveryEvent) => void,
): Promise<void> {
  if (!response.ok) {
    throw new Error(await response.text());
  }
  if (!response.body) {
    throw new Error('The discovery stream did not return a readable body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flushChunk = (chunk: string) => {
    const trimmed = chunk.trim();
    if (!trimmed) return;

    for (const line of trimmed.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      onEvent(JSON.parse(payload) as KiraDiscoveryEvent);
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex >= 0) {
      flushChunk(buffer.slice(0, separatorIndex));
      buffer = buffer.slice(separatorIndex + 2);
      separatorIndex = buffer.indexOf('\n\n');
    }
  }

  flushChunk(buffer + decoder.decode());
}

async function fetchExistingDiscoveryAnalysis(
  sessionPath: string,
  projectName: string,
): Promise<KiraProjectDiscoveryAnalysis | null> {
  const res = await fetch(
    `/api/kira-discovery/existing?sessionPath=${encodeURIComponent(sessionPath)}&projectName=${encodeURIComponent(projectName)}`,
  );
  const data = (await res.json()) as {
    analysis?: KiraProjectDiscoveryAnalysis | null;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || `Existing discovery lookup failed with ${res.status}`);
  }
  return data.analysis ?? null;
}

function createDraftForm(): TaskFormState {
  return {
    id: null,
    title: '',
    description: '',
    status: 'todo',
    assignee: '',
  };
}

function parseViewState(raw: unknown): KiraViewState {
  if (!raw) return DEFAULT_VIEW_STATE;

  try {
    const parsed =
      typeof raw === 'string'
        ? (JSON.parse(raw) as Partial<KiraViewState>)
        : (raw as Partial<KiraViewState>);

    return {
      selectedTaskId: parsed.selectedTaskId ?? null,
      activeProjectName: parsed.activeProjectName ?? null,
      previewMode: Boolean(parsed.previewMode),
    };
  } catch {
    return DEFAULT_VIEW_STATE;
  }
}

function resolveSelection(preferredId: string | null, works: WorkTask[]): string | null {
  if (preferredId && works.some((work) => work.id === preferredId)) return preferredId;
  return works[0]?.id ?? null;
}

const KiraPage: React.FC = () => {
  const { t, i18n } = useTranslation('kira');
  const [works, setWorks] = useState<WorkTask[]>([]);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [attempts, setAttempts] = useState<KiraAttemptRecord[]>([]);
  const [reviews, setReviews] = useState<KiraReviewRecord[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [activeProjectName, setActiveProjectName] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<TaskFormState>(createDraftForm());
  const [commentDraft, setCommentDraft] = useState({ author: '', body: '' });
  const [workRootConfig, setWorkRootConfig] = useState<KiraConfigResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isInitialized, setIsInitialized] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [discoveryStage, setDiscoveryStage] = useState<KiraDiscoveryStage>('idle');
  const [discoveryLogs, setDiscoveryLogs] = useState<string[]>([]);
  const [discoveryAnalysis, setDiscoveryAnalysis] = useState<KiraProjectDiscoveryAnalysis | null>(
    null,
  );
  const discoveryAbortRef = useRef<AbortController | null>(null);

  const { saveFile, syncToCloud, deleteFromCloud, initFromCloud, getChildrenByPath, getByPath } =
    useFileSystem({ fileApi: kiraFileApi });

  const loadWorksFromFS = useCallback((): WorkTask[] => {
    return sortByUpdatedAtDesc(
      getChildrenByPath(WORKS_DIR)
        .filter((node) => node.type === 'file')
        .map((node) => {
          try {
            return normalizeWorkTask(node.content);
          } catch (error) {
            console.warn('[Kira] Failed to parse work', node.path, error);
            return null;
          }
        })
        .filter((work): work is WorkTask => work !== null),
    );
  }, [getChildrenByPath]);

  const loadCommentsFromFS = useCallback((): TaskComment[] => {
    return sortByCreatedAtDesc(
      getChildrenByPath(COMMENTS_DIR)
        .filter((node) => node.type === 'file')
        .map((node) => {
          try {
            return normalizeTaskComment(node.content);
          } catch (error) {
            console.warn('[Kira] Failed to parse comment', node.path, error);
            return null;
          }
        })
        .filter((comment): comment is TaskComment => comment !== null),
    );
  }, [getChildrenByPath]);

  const loadAttemptsFromFS = useCallback((): KiraAttemptRecord[] => {
    return getChildrenByPath(ATTEMPTS_DIR)
      .filter((node) => node.type === 'file')
      .map((node) => {
        try {
          return normalizeKiraAttempt(node.content);
        } catch (error) {
          console.warn('[Kira] Failed to parse attempt', node.path, error);
          return null;
        }
      })
      .filter((attempt): attempt is KiraAttemptRecord => attempt !== null)
      .sort((a, b) => b.attemptNo - a.attemptNo);
  }, [getChildrenByPath]);

  const loadReviewsFromFS = useCallback((): KiraReviewRecord[] => {
    return getChildrenByPath(REVIEWS_DIR)
      .filter((node) => node.type === 'file')
      .map((node) => {
        try {
          return normalizeKiraReview(node.content);
        } catch (error) {
          console.warn('[Kira] Failed to parse review', node.path, error);
          return null;
        }
      })
      .filter((review): review is KiraReviewRecord => review !== null)
      .sort((a, b) => b.attemptNo - a.attemptNo);
  }, [getChildrenByPath]);

  const saveViewState = useCallback(
    async (nextState: KiraViewState) => {
      saveFile(STATE_FILE, nextState);
      await syncToCloud(STATE_FILE, nextState);
    },
    [saveFile, syncToCloud],
  );

  const loadWorkRootConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/kira-config');
      if (!res.ok) throw new Error(`Kira config API error ${res.status}`);
      const data = (await res.json()) as KiraConfigResponse;
      const normalized = {
        configured: Boolean(data.configured),
        exists: data.exists ?? true,
        workRootDirectory: data.workRootDirectory?.trim() || undefined,
        projects: Array.isArray(data.projects)
          ? data.projects
              .filter((project): project is KiraProjectEntry => {
                return Boolean(project?.name?.trim() && project?.path?.trim());
              })
              .map((project) => ({
                name: project.name.trim(),
                path: project.path.trim(),
              }))
          : [],
      };
      setWorkRootConfig(normalized);
      return normalized;
    } catch (error) {
      console.warn('[Kira] Failed to load work root config:', error);
      setWorkRootConfig(null);
      return null;
    }
  }, []);

  const refreshFromCloud = useCallback(
    async (focus?: FocusTarget) => {
      const [, nextWorkRootConfig] = await Promise.all([initFromCloud(), loadWorkRootConfig()]);

      const nextWorks = loadWorksFromFS();
      const nextComments = loadCommentsFromFS();
      const nextAttempts = loadAttemptsFromFS();
      const nextReviews = loadReviewsFromFS();
      const stateNode = getByPath(STATE_FILE);
      const persisted = parseViewState(stateNode?.content);
      const projectNames = nextWorkRootConfig?.projects?.map((project) => project.name) ?? [];
      const nextActiveProjectName =
        persisted.activeProjectName && projectNames.includes(persisted.activeProjectName)
          ? persisted.activeProjectName
          : (projectNames[0] ?? null);
      const projectScopedWorks = nextWorks.filter((work) =>
        matchesProjectName(work.projectName, nextActiveProjectName),
      );

      setWorks(nextWorks);
      setComments(nextComments);
      setAttempts(nextAttempts);
      setReviews(nextReviews);
      setSelectedTaskId(
        resolveSelection(focus?.id ?? persisted.selectedTaskId, projectScopedWorks),
      );
      setActiveProjectName(nextActiveProjectName);
      setPreviewMode(persisted.previewMode);
    },
    [
      getByPath,
      initFromCloud,
      loadAttemptsFromFS,
      loadCommentsFromFS,
      loadReviewsFromFS,
      loadWorkRootConfig,
      loadWorksFromFS,
    ],
  );

  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'CREATE_WORK':
        case 'UPDATE_WORK':
        case 'DELETE_WORK':
        case 'CREATE_COMMENT':
        case 'DELETE_COMMENT':
        case 'REFRESH_KIRA':
        case 'CREATE_EPIC':
        case 'UPDATE_EPIC':
        case 'DELETE_EPIC':
          await refreshFromCloud({
            id: action.params?.focusId ?? action.params?.workId ?? action.params?.taskId ?? null,
          });
          return 'success';
        default:
          return `error: unknown action_type ${action.action_type}`;
      }
    },
    [refreshFromCloud],
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
          name: 'Kira',
          windowStyle: { width: 1320, height: 780 },
        });

        manager.handshake({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: 'Kira',
          windowStyle: { width: 1320, height: 780 },
        });

        reportLifecycle(AppLifecycle.DOM_READY);
        await fetchVibeInfo().catch((error) => console.warn('[Kira] fetchVibeInfo failed', error));
        await refreshFromCloud();
        setIsInitialized(true);
        setIsLoading(false);
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
      } catch (error) {
        console.error('[Kira] Init error:', error);
        setIsLoading(false);
        setErrorText(error instanceof Error ? error.message : String(error));
        reportLifecycle(AppLifecycle.ERROR, String(error));
      }
    };

    void init();

    return () => {
      reportLifecycle(AppLifecycle.UNLOADING);
      reportLifecycle(AppLifecycle.DESTROYED);
    };
  }, [refreshFromCloud]);

  useEffect(() => {
    if (!isInitialized) return;
    void saveViewState({
      selectedTaskId,
      activeProjectName,
      previewMode,
    });
  }, [activeProjectName, isInitialized, previewMode, saveViewState, selectedTaskId]);

  useEffect(() => {
    if (!isInitialized || editorOpen) return;

    let disposed = false;
    let running = false;

    const poll = async () => {
      if (disposed || running) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

      running = true;
      try {
        await refreshFromCloud({ id: selectedTaskId });
      } catch (error) {
        console.warn('[Kira] Live refresh failed:', error);
      } finally {
        running = false;
      }
    };

    const timer = window.setInterval(() => {
      void poll();
    }, KIRA_LIVE_REFRESH_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [editorOpen, isInitialized, refreshFromCloud, selectedTaskId]);

  const projectScopedWorks = useMemo(
    () => works.filter((work) => matchesProjectName(work.projectName, activeProjectName)),
    [activeProjectName, works],
  );

  const selectedWork = useMemo(
    () => projectScopedWorks.find((work) => work.id === selectedTaskId) ?? null,
    [projectScopedWorks, selectedTaskId],
  );

  useEffect(() => {
    if (selectedWork) {
      setForm({
        id: selectedWork.id,
        title: selectedWork.title,
        description: selectedWork.description,
        status: selectedWork.status,
        assignee: selectedWork.assignee,
      });
      return;
    }
    setForm(createDraftForm());
  }, [selectedWork]);

  useEffect(() => {
    setCommentDraft({ author: '', body: '' });
  }, [selectedTaskId]);

  useEffect(() => {
    if (!activeProjectName) return;
    if (selectedWork) return;
    setSelectedTaskId(null);
  }, [activeProjectName, selectedWork]);

  useEffect(() => {
    if (!editorOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setEditorOpen(false);
      setErrorText(null);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [editorOpen]);

  const worksByStatus = useMemo(() => groupWorksByStatus(projectScopedWorks), [projectScopedWorks]);
  const projectScopedTaskIds = useMemo(
    () => new Set(projectScopedWorks.map((work) => work.id)),
    [projectScopedWorks],
  );
  const projectScopedComments = useMemo(
    () => comments.filter((comment) => projectScopedTaskIds.has(comment.taskId)),
    [comments, projectScopedTaskIds],
  );
  const commentCountByTask = useMemo(() => {
    return projectScopedComments.reduce((acc, comment) => {
      acc.set(comment.taskId, (acc.get(comment.taskId) ?? 0) + 1);
      return acc;
    }, new Map<string, number>());
  }, [projectScopedComments]);
  const currentComments = useMemo(
    () =>
      selectedTaskId
        ? sortByCreatedAtDesc(comments.filter((comment) => comment.taskId === selectedTaskId))
        : [],
    [comments, selectedTaskId],
  );
  const currentAttempts = useMemo(
    () =>
      selectedTaskId
        ? attempts
            .filter((attempt) => attempt.workId === selectedTaskId)
            .sort((a, b) => b.attemptNo - a.attemptNo)
        : [],
    [attempts, selectedTaskId],
  );
  const reviewsByAttempt = useMemo(() => {
    const map = new Map<number, KiraReviewRecord>();
    for (const review of reviews) {
      if (review.workId === selectedTaskId) {
        map.set(review.attemptNo, review);
      }
    }
    return map;
  }, [reviews, selectedTaskId]);
  const automationBadgeByTask = useMemo(() => {
    const map = new Map<string, 'queued' | 'running' | 'reviewPending'>();
    const latestByTask = new Map<string, TaskComment>();

    for (const comment of projectScopedComments) {
      const previous = latestByTask.get(comment.taskId);
      if (!previous || comment.createdAt > previous.createdAt) {
        latestByTask.set(comment.taskId, comment);
      }
    }

    for (const [taskId, comment] of latestByTask.entries()) {
      if (
        comment.body.startsWith('Queued: waiting for another work in the same project to finish.')
      ) {
        map.set(taskId, 'queued');
      } else if (
        comment.body.includes('started implementation') ||
        comment.body.includes('resumed implementation')
      ) {
        map.set(taskId, 'running');
      } else if (comment.body.startsWith('Review requested changes')) {
        map.set(taskId, 'reviewPending');
      }
    }

    return map;
  }, [projectScopedComments]);

  const totalWorks = projectScopedWorks.length;
  const todoWorks = projectScopedWorks.filter((work) => work.status === 'todo').length;
  const doneWorks = projectScopedWorks.filter((work) => work.status === 'done').length;
  const reviewWorks = projectScopedWorks.filter((work) => work.status === 'in_review').length;
  const blockedWorks = projectScopedWorks.filter((work) => work.status === 'blocked').length;

  const handleOpenCreateTask = useCallback(() => {
    setSelectedTaskId(null);
    setPreviewMode(false);
    setEditorOpen(true);
    setErrorText(null);
    setForm(createDraftForm());
    reportAction(APP_ID, 'NEW_WORK_DRAFT', {});
  }, []);

  const handleSelectWork = useCallback((workId: string) => {
    setSelectedTaskId(workId);
    setEditorOpen(true);
    setErrorText(null);
    reportAction(APP_ID, 'SELECT_WORK', { workId });
  }, []);

  const handleSelectProject = useCallback((projectName: string) => {
    setActiveProjectName(projectName);
    setSelectedTaskId(null);
    setEditorOpen(false);
    setErrorText(null);
    reportAction(APP_ID, 'SELECT_PROJECT', { projectName });
  }, []);

  const handleCloseEditor = useCallback(() => {
    setEditorOpen(false);
    setErrorText(null);
  }, []);

  const appendDiscoveryLog = useCallback((message: string) => {
    setDiscoveryLogs((prev) => [...prev, message]);
  }, []);

  const handleCloseDiscovery = useCallback(() => {
    discoveryAbortRef.current?.abort();
    discoveryAbortRef.current = null;
    setDiscoveryOpen(false);
    setDiscoveryStage('idle');
    setDiscoveryLogs([]);
    setDiscoveryAnalysis(null);
  }, []);

  const runFreshDiscovery = useCallback(
    (projectName: string, sessionPath: string) => {
      discoveryAbortRef.current?.abort();
      setDiscoveryStage('analyzing');
      setDiscoveryLogs([t('messages.discoveryRunning')]);
      setDiscoveryAnalysis(null);
      reportAction(APP_ID, 'START_DISCOVERY', { projectName });

      const controller = new AbortController();
      discoveryAbortRef.current = controller;

      void (async () => {
        try {
          const response = await fetch('/api/kira-discovery/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionPath, projectName }),
            signal: controller.signal,
          });

          await consumeSseResponse(response, (event) => {
            if (event.type === 'log') {
              appendDiscoveryLog(event.message);
              return;
            }

            if (event.type === 'analysis_complete') {
              setDiscoveryAnalysis(event.analysis);
              setDiscoveryStage(event.analysis.findings.length > 0 ? 'ready' : 'done');
              if (event.message) appendDiscoveryLog(event.message);
              appendDiscoveryLog(t('messages.discoveryStored'));
              if (event.analysis.findings.length === 0) {
                appendDiscoveryLog(t('messages.discoveryNoFindings'));
              }
              return;
            }

            if (event.type === 'error') {
              setDiscoveryStage('error');
              appendDiscoveryLog(event.message);
            }
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          setDiscoveryStage('error');
          appendDiscoveryLog(error instanceof Error ? error.message : String(error));
        } finally {
          if (discoveryAbortRef.current === controller) {
            discoveryAbortRef.current = null;
          }
        }
      })();
    },
    [appendDiscoveryLog, t],
  );

  const handleOpenAoiDiscovery = useCallback(async () => {
    const projectName = activeProjectName?.trim() ?? '';
    const sessionPath = getSessionPath().trim();

    discoveryAbortRef.current?.abort();
    setDiscoveryOpen(true);
    setEditorOpen(false);
    setErrorText(null);
    setDiscoveryLogs([]);
    setDiscoveryAnalysis(null);

    if (!projectName) {
      setDiscoveryStage('error');
      setDiscoveryLogs([t('messages.discoveryProjectRequired')]);
      return;
    }

    if (!sessionPath) {
      setDiscoveryStage('error');
      setDiscoveryLogs([t('messages.discoverySessionMissing')]);
      return;
    }

    try {
      const existingAnalysis = await fetchExistingDiscoveryAnalysis(sessionPath, projectName);
      if (existingAnalysis) {
        setDiscoveryAnalysis(existingAnalysis);
        setDiscoveryStage('chooseExisting');
        setDiscoveryLogs([t('messages.discoveryExistingFound')]);
        return;
      }
    } catch (error) {
      console.warn('[Kira] Existing discovery lookup failed:', error);
    }

    runFreshDiscovery(projectName, sessionPath);
  }, [activeProjectName, runFreshDiscovery, t]);

  const handleUseSavedDiscovery = useCallback(() => {
    if (!discoveryAnalysis) return;
    setDiscoveryStage(discoveryAnalysis.findings.length > 0 ? 'ready' : 'done');
    appendDiscoveryLog(t('messages.discoveryUsingSaved'));
  }, [appendDiscoveryLog, discoveryAnalysis, t]);

  const handleAnalyzeAgain = useCallback(() => {
    const projectName = activeProjectName?.trim() ?? '';
    const sessionPath = getSessionPath().trim();
    if (!projectName || !sessionPath) return;
    runFreshDiscovery(projectName, sessionPath);
  }, [activeProjectName, runFreshDiscovery]);

  const handleContinueDiscovery = useCallback(async () => {
    const projectName = activeProjectName?.trim() ?? '';
    const sessionPath = getSessionPath().trim();
    if (!projectName || !sessionPath || !discoveryAnalysis) return;

    try {
      setDiscoveryStage('creating');
      appendDiscoveryLog('Creating todo works from the saved discovery findings...');

      const response = await fetch('/api/kira-discovery/create-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionPath, projectName }),
      });
      const data = (await response.json()) as {
        error?: string;
        createdCount?: number;
        skippedCount?: number;
        createdWorks?: WorkTask[];
      };

      if (!response.ok) {
        throw new Error(data.error || `Discovery task creation failed with ${response.status}`);
      }

      appendDiscoveryLog(
        `Created ${data.createdCount ?? 0} todo works${(data.skippedCount ?? 0) > 0 ? ` and skipped ${data.skippedCount} duplicates` : ''}.`,
      );
      await refreshFromCloud({ id: data.createdWorks?.[0]?.id ?? null });
      await fetch('/api/kira-automation/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionPath }),
      }).catch(() => undefined);
      setDiscoveryStage('created');
    } catch (error) {
      setDiscoveryStage('error');
      appendDiscoveryLog(error instanceof Error ? error.message : String(error));
    }
  }, [activeProjectName, appendDiscoveryLog, discoveryAnalysis, refreshFromCloud]);

  const handleSaveTask = useCallback(async () => {
    const title = form.title.trim();
    if (!title) {
      setErrorText(t('messages.validationTitle'));
      return;
    }

    try {
      setErrorText(null);
      const now = Date.now();
      const workId = form.id ?? generateId();
      const existing = works.find((work) => work.id === workId);
      const nextWork: WorkTask = {
        id: workId,
        type: 'work',
        projectName: activeProjectName ?? existing?.projectName ?? '',
        title,
        description: form.description.trim(),
        status: form.status,
        assignee: existing?.assignee ?? form.assignee.trim(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      const filePath = getWorkFilePath(workId);
      saveFile(filePath, nextWork);
      await syncToCloud(filePath, nextWork);
      setWorks((prev) =>
        sortByUpdatedAtDesc([...prev.filter((work) => work.id !== workId), nextWork]),
      );
      setSelectedTaskId(workId);
      setEditorOpen(false);
      reportAction(APP_ID, existing ? 'UPDATE_WORK' : 'CREATE_WORK', {
        filePath,
        focusId: workId,
      });
    } catch (error) {
      console.error('[Kira] Save failed:', error);
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [activeProjectName, form, saveFile, syncToCloud, t, works]);

  const handleDeleteTask = useCallback(async () => {
    if (!selectedTaskId) return;

    try {
      const sessionPath = getSessionPath().trim();
      if (sessionPath) {
        await fetch('/api/kira-automation/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionPath, workId: selectedTaskId }),
        }).catch(() => undefined);
      }

      const commentPaths = comments
        .filter((comment) => comment.taskId === selectedTaskId)
        .map((comment) => getCommentFilePath(comment.id));
      const attemptPaths = attempts
        .filter((attempt) => attempt.workId === selectedTaskId)
        .map((attempt) => `${ATTEMPTS_DIR}/${attempt.id}.json`);
      const reviewPaths = reviews
        .filter((review) => review.workId === selectedTaskId)
        .map((review) => `${REVIEWS_DIR}/${review.id}.json`);

      for (const path of [...commentPaths, ...attemptPaths, ...reviewPaths]) {
        await deleteFromCloud(path);
      }

      await deleteFromCloud(getWorkFilePath(selectedTaskId));
      setWorks((prev) => prev.filter((work) => work.id !== selectedTaskId));
      setComments((prev) => prev.filter((comment) => comment.taskId !== selectedTaskId));
      setAttempts((prev) => prev.filter((attempt) => attempt.workId !== selectedTaskId));
      setReviews((prev) => prev.filter((review) => review.workId !== selectedTaskId));
      setSelectedTaskId(null);
      setEditorOpen(false);
      setDeleteConfirmOpen(false);
      setForm(createDraftForm());
      setErrorText(null);
      reportAction(APP_ID, 'DELETE_WORK', { workId: selectedTaskId });
    } catch (error) {
      console.error('[Kira] Delete failed:', error);
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [attempts, comments, deleteFromCloud, reviews, selectedTaskId]);

  const requestDeleteTask = useCallback(() => {
    if (!selectedWork) return;
    if (selectedWork.status === 'in_progress' || selectedWork.status === 'in_review') {
      setDeleteConfirmOpen(true);
      return;
    }
    void handleDeleteTask();
  }, [handleDeleteTask, selectedWork]);

  const handleAddComment = useCallback(async () => {
    if (!selectedTaskId) {
      setErrorText(t('comments.saveFirst'));
      return;
    }

    const body = commentDraft.body.trim();
    if (!body) return;

    try {
      const nextComment: TaskComment = {
        id: generateId(),
        taskId: selectedTaskId,
        taskType: 'work',
        author: commentDraft.author.trim() || t('comments.defaultAuthor'),
        body,
        createdAt: Date.now(),
      };

      const filePath = getCommentFilePath(nextComment.id);
      saveFile(filePath, nextComment);
      await syncToCloud(filePath, nextComment);
      setComments((prev) => sortByCreatedAtDesc([...prev, nextComment]));
      setCommentDraft({ author: '', body: '' });
      setErrorText(null);
      reportAction(APP_ID, 'CREATE_COMMENT', {
        commentId: nextComment.id,
        taskId: selectedTaskId,
        focusType: 'work',
      });
    } catch (error) {
      console.error('[Kira] Comment save failed:', error);
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [commentDraft, saveFile, selectedTaskId, syncToCloud, t]);

  const handleDeleteComment = useCallback(
    async (commentId: string) => {
      try {
        await deleteFromCloud(getCommentFilePath(commentId));
        setComments((prev) => prev.filter((comment) => comment.id !== commentId));
        reportAction(APP_ID, 'DELETE_COMMENT', {
          commentId,
          taskId: selectedTaskId ?? '',
          focusType: 'work',
        });
      } catch (error) {
        console.error('[Kira] Comment delete failed:', error);
        setErrorText(error instanceof Error ? error.message : String(error));
      }
    },
    [deleteFromCloud, selectedTaskId],
  );

  if (isLoading) {
    return (
      <div className={styles.kiraApp}>
        <div className={styles.loadingState}>{t('messages.loading')}</div>
      </div>
    );
  }

  const workRootStateLabel = !workRootConfig
    ? null
    : !workRootConfig.configured
      ? t('root.unconfigured')
      : workRootConfig.exists === false
        ? t('root.missing')
        : (workRootConfig.projects?.length ?? 0) === 0
          ? t('root.noProjects')
          : t('root.ready');

  const workRootHint = !workRootConfig
    ? null
    : !workRootConfig.configured
      ? t('root.unconfiguredHint')
      : workRootConfig.exists === false
        ? t('root.missingHint')
        : (workRootConfig.projects?.length ?? 0) === 0
          ? t('root.noProjectsHint')
          : t('root.readyHint');
  const discoveryFooterMessage =
    discoveryStage === 'chooseExisting'
      ? t('messages.discoveryExistingPrompt')
      : discoveryStage === 'analyzing'
        ? t('messages.discoveryRunning')
        : discoveryStage === 'creating'
          ? t('messages.discoveryCreating')
          : discoveryStage === 'created'
            ? t('messages.discoveryCreatedHint')
            : discoveryStage === 'error'
              ? t('messages.discoveryErrored')
              : discoveryStage === 'done'
                ? t('messages.discoveryNoFindings')
                : t('messages.discoveryStored');
  const discoveryBusy = discoveryStage === 'analyzing' || discoveryStage === 'creating';
  const discoveryLatestLog = discoveryLogs[discoveryLogs.length - 1] ?? null;
  const discoveryStepLabels = [
    t('messages.discoveryStepMap'),
    t('messages.discoveryStepInspect'),
    t('messages.discoveryStepShape'),
  ];
  const discoveryActiveStepIndex =
    discoveryStage === 'analyzing'
      ? Math.min(discoveryStepLabels.length - 1, Math.max(0, discoveryLogs.length - 1))
      : discoveryStage === 'idle' || discoveryStage === 'chooseExisting'
        ? -1
        : discoveryStage === 'error'
          ? 0
          : discoveryStepLabels.length - 1;

  return (
    <div className={`${styles.kiraApp} ${editorOpen ? styles.editorOpen : styles.editorClosed}`}>
      <aside className={styles.sidebar}>
        <div className={styles.brandBlock}>
          <p className={styles.kicker}>{t('kicker')}</p>
          <h1>{t('title')}</h1>
          <p className={styles.subtitle}>{t('subtitle')}</p>
        </div>

        <div className={styles.statGrid}>
          <div className={styles.statCard}>
            <span>{t('stats.works')}</span>
            <strong>{totalWorks}</strong>
          </div>
          <div className={styles.statCard}>
            <span>{t('stats.todo')}</span>
            <strong>{todoWorks}</strong>
          </div>
          <div className={styles.statCard}>
            <span>{t('stats.done')}</span>
            <strong>{doneWorks}</strong>
          </div>
          <div className={styles.statCard}>
            <span>{t('stats.review')}</span>
            <strong>{reviewWorks}</strong>
          </div>
          <div className={styles.statCard}>
            <span>{t('stats.blocked')}</span>
            <strong>{blockedWorks}</strong>
          </div>
        </div>

        {workRootConfig ? (
          <div className={styles.rootCard}>
            <div className={styles.rootHeader}>
              <strong>{t('sections.workRoot')}</strong>
              <span
                className={`${styles.rootState} ${
                  !workRootConfig.configured
                    ? styles.rootStateIdle
                    : workRootConfig.exists === false
                      ? styles.rootStateMissing
                      : (workRootConfig.projects?.length ?? 0) === 0
                        ? styles.rootStateIdle
                        : styles.rootStateReady
                }`}
              >
                {workRootStateLabel}
              </span>
            </div>
            {workRootConfig.workRootDirectory ? (
              <code className={styles.rootPath}>{workRootConfig.workRootDirectory}</code>
            ) : null}
            {workRootHint ? <p className={styles.rootHint}>{workRootHint}</p> : null}
            {workRootConfig.projects && workRootConfig.projects.length > 0 ? (
              <div className={styles.projectSection}>
                <div className={styles.projectHeader}>
                  <strong>{t('sections.projects')}</strong>
                  {activeProjectName ? (
                    <span>
                      {t('root.activeProject')}: <b>{activeProjectName}</b>
                    </span>
                  ) : null}
                </div>
                <p className={styles.projectHint}>{t('root.activeProjectHint')}</p>
                <div className={styles.projectList}>
                  {workRootConfig.projects.map((project) => (
                    <button
                      key={project.name}
                      type="button"
                      className={`${styles.projectChip} ${
                        activeProjectName === project.name ? styles.projectChipActive : ''
                      }`}
                      onClick={() => handleSelectProject(project.name)}
                      title={project.path}
                    >
                      <strong>{project.name}</strong>
                      <span>{project.path}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className={styles.primaryActions}>
          <button className={styles.primaryButton} onClick={handleOpenCreateTask}>
            {t('actions.createTask')}
          </button>
          <button className={styles.aoiButton} onClick={handleOpenAoiDiscovery}>
            {t('actions.aoiTakeCare')}
          </button>
        </div>
      </aside>

      <section className={styles.boardSection}>
        <div className={styles.boardHeader}>
          <div>
            <p className={styles.kicker}>{t('sections.boardEyebrow')}</p>
            <h2>{t('sections.boardAllTitle')}</h2>
            <p className={styles.boardSubtitle}>{t('sections.boardSubtitle')}</p>
            {activeProjectName ? (
              <p className={styles.activeProjectBadge}>
                {t('root.activeProject')}: <strong>{activeProjectName}</strong>
              </p>
            ) : null}
          </div>
          <div className={styles.boardMeta}>
            <span>
              {projectScopedWorks.length} {t('stats.works').toLowerCase()}
            </span>
            <span>
              {projectScopedComments.length} {t('sections.comments').toLowerCase()}
            </span>
          </div>
        </div>

        {projectScopedWorks.length === 0 ? (
          <div className={styles.boardEmpty}>
            <strong>{t('sections.boardAllTitle')}</strong>
            <p>{t('board.emptyAll')}</p>
          </div>
        ) : (
          <div className={styles.boardGrid}>
            {STATUS_ORDER.map((status) => (
              <div key={status} className={styles.statusColumn}>
                <div className={styles.columnHeader}>
                  <span className={`${styles.statusPill} ${styles[`status${status}`]}`}>
                    {t(`status.${status}`)}
                  </span>
                  <strong>{worksByStatus[status].length}</strong>
                </div>
                <div className={styles.columnBody}>
                  {worksByStatus[status].map((work) => {
                    const isSelected = selectedTaskId === work.id;
                    const automationBadge = automationBadgeByTask.get(work.id);
                    return (
                      <button
                        key={work.id}
                        className={`${styles.workCard} ${isSelected ? styles.workCardActive : ''}`}
                        onClick={() => handleSelectWork(work.id)}
                      >
                        <div className={styles.workCardTop}>
                          <span>{work.projectName || t('root.unconfigured')}</span>
                          <span>{formatTimestamp(work.updatedAt, i18n.language)}</span>
                        </div>
                        <strong>{work.title}</strong>
                        {automationBadge ? (
                          <div className={styles.cardBadgeRow}>
                            <span className={styles.automationBadge}>
                              {automationBadge === 'queued'
                                ? t('board.queued')
                                : automationBadge === 'running'
                                  ? t('board.running')
                                  : t('board.reviewPending')}
                            </span>
                          </div>
                        ) : null}
                        <div className={styles.workCardBottom}>
                          <span>{work.assignee || t('board.unassigned')}</span>
                          <span>
                            {t('board.comments', { count: commentCountByTask.get(work.id) ?? 0 })}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {editorOpen ? (
        <section className={styles.editorSection}>
          <div className={styles.editorHeader}>
            <div>
              <p className={styles.kicker}>
                {selectedWork ? t('drafts.editTask') : t('drafts.task')}
              </p>
              <h2>{t('sections.details')}</h2>
              <p className={styles.editorCopy}>{t('sections.detailCopy')}</p>
            </div>
            <div className={styles.editorActions}>
              <button onClick={() => setPreviewMode((prev) => !prev)}>
                {previewMode ? t('actions.write') : t('actions.preview')}
              </button>
              <button onClick={handleCloseEditor}>{t('actions.close')}</button>
              {selectedTaskId ? (
                <button className={styles.dangerButton} onClick={requestDeleteTask}>
                  {t('actions.delete')}
                </button>
              ) : null}
            </div>
          </div>

          <div className={styles.detailCard}>
            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span>{t('fields.status')}</span>
                <select
                  value={form.status}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, status: e.target.value as KiraTaskStatus }))
                  }
                >
                  {STATUS_ORDER.map((status) => (
                    <option key={status} value={status}>
                      {t(`status.${status}`)}
                    </option>
                  ))}
                </select>
              </label>

              {selectedWork ? (
                <label className={styles.field}>
                  <span>{t('fields.assignee')}</span>
                  <input value={form.assignee || t('board.unassigned')} readOnly />
                </label>
              ) : null}
            </div>

            <label className={styles.field}>
              <span>{t('fields.title')}</span>
              <input
                value={form.title}
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                placeholder={t('placeholders.workTitle')}
              />
            </label>

            <label className={styles.field}>
              <span>{t('fields.description')}</span>
              {previewMode ? (
                <div className={styles.previewPane}>
                  {form.description.trim() ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{form.description}</ReactMarkdown>
                  ) : (
                    <div className={styles.previewEmpty}>{t('messages.previewEmpty')}</div>
                  )}
                </div>
              ) : (
                <textarea
                  value={form.description}
                  onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder={t('placeholders.workDescription')}
                  rows={12}
                />
              )}
            </label>

            <p className={styles.inlineHint}>{t('messages.markdownHint')}</p>

            {errorText ? <div className={styles.errorBox}>{errorText}</div> : null}

            <div className={styles.saveRow}>
              <span>{t('messages.syncHint')}</span>
              <button className={styles.primaryButton} onClick={() => void handleSaveTask()}>
                {t('actions.save')}
              </button>
            </div>
          </div>

          {selectedTaskId ? (
            <div className={styles.attemptsPanel}>
              <div className={styles.sectionHeader}>
                <h3>Attempts</h3>
                <span>{currentAttempts.length}</span>
              </div>
              {selectedWork?.status === 'blocked' && currentAttempts[0]?.blockedReason ? (
                <div className={styles.blockedNotice}>
                  <strong>Resume condition</strong>
                  <span>{currentAttempts[0].blockedReason}</span>
                </div>
              ) : null}
              <div className={styles.attemptList}>
                {currentAttempts.length > 0 ? (
                  currentAttempts.map((attempt) => {
                    const review = reviewsByAttempt.get(attempt.attemptNo);
                    return (
                      <details key={attempt.id} className={styles.attemptCard}>
                        <summary>
                          <span>Attempt {attempt.attemptNo}</span>
                          <strong>{attempt.status.replace(/_/g, ' ')}</strong>
                        </summary>
                        <div className={styles.attemptGrid}>
                          <div>
                            <h4>Plan</h4>
                            <p>{attempt.workerPlan?.summary || 'No plan summary'}</p>
                            <small>
                              Files:{' '}
                              {(attempt.workerPlan?.intendedFiles ?? []).join(', ') || 'none'}
                            </small>
                          </div>
                          <div>
                            <h4>Changes</h4>
                            <p>{attempt.changedFiles.join(', ') || 'No changed files recorded'}</p>
                            <small>
                              Read: {attempt.readFiles?.join(', ') || 'none'} | Patched:{' '}
                              {attempt.patchedFiles?.join(', ') || 'none'}
                            </small>
                          </div>
                          <div>
                            <h4>Validation</h4>
                            <p>Passed: {attempt.validationReruns?.passed?.join(', ') || 'none'}</p>
                            <small>
                              Failed: {attempt.validationReruns?.failed?.join(', ') || 'none'}
                            </small>
                          </div>
                          <div>
                            <h4>Review</h4>
                            <p>{review?.summary || 'No review record'}</p>
                            <small>
                              Findings: {review?.findings.length ?? 0} | Missing checks:{' '}
                              {review?.missingValidation.length ?? 0}
                            </small>
                          </div>
                        </div>
                      </details>
                    );
                  })
                ) : (
                  <div className={styles.commentEmpty}>No attempt records yet.</div>
                )}
              </div>
            </div>
          ) : null}

          <div className={styles.commentsPanel}>
            <div className={styles.sectionHeader}>
              <h3>{t('sections.comments')}</h3>
              <span>{currentComments.length}</span>
            </div>

            {selectedTaskId ? (
              <>
                <div className={styles.commentComposer}>
                  <label className={styles.field}>
                    <span>{t('fields.commentAuthor')}</span>
                    <input
                      value={commentDraft.author}
                      onChange={(e) =>
                        setCommentDraft((prev) => ({ ...prev, author: e.target.value }))
                      }
                      placeholder={t('placeholders.commentAuthor')}
                    />
                  </label>

                  <label className={styles.field}>
                    <span>{t('fields.commentBody')}</span>
                    <textarea
                      rows={3}
                      value={commentDraft.body}
                      onChange={(e) =>
                        setCommentDraft((prev) => ({ ...prev, body: e.target.value }))
                      }
                      placeholder={t('placeholders.commentBody')}
                    />
                  </label>

                  <div className={styles.commentActions}>
                    <span>{t('comments.hint')}</span>
                    <button
                      className={styles.secondaryButton}
                      onClick={() => void handleAddComment()}
                    >
                      {t('actions.addComment')}
                    </button>
                  </div>
                </div>

                <div className={styles.commentList}>
                  {currentComments.length > 0 ? (
                    currentComments.map((comment) => (
                      <div key={comment.id} className={styles.commentCard}>
                        <div className={styles.commentHeader}>
                          <div>
                            <strong>{comment.author}</strong>
                            <span>{formatTimestamp(comment.createdAt, i18n.language)}</span>
                          </div>
                          <button onClick={() => void handleDeleteComment(comment.id)}>
                            {t('actions.delete')}
                          </button>
                        </div>
                        <p>{comment.body}</p>
                      </div>
                    ))
                  ) : (
                    <div className={styles.commentEmpty}>{t('comments.empty')}</div>
                  )}
                </div>
              </>
            ) : (
              <div className={styles.commentEmpty}>{t('comments.saveFirst')}</div>
            )}
          </div>
        </section>
      ) : null}

      {discoveryOpen ? (
        <div className={styles.discoveryOverlay}>
          <div className={styles.discoveryModal}>
            <div className={styles.discoveryHeader}>
              <div>
                <p className={styles.kicker}>{t('sections.discoveryEyebrow')}</p>
                <h2>{t('sections.discoveryTitle')}</h2>
                <p className={styles.discoverySubtitle}>{t('sections.discoverySubtitle')}</p>
              </div>
              <button className={styles.secondaryButton} onClick={handleCloseDiscovery}>
                {t('actions.close')}
              </button>
            </div>

            <div className={styles.discoveryStatus}>
              <strong>
                {discoveryStage === 'chooseExisting'
                  ? t('messages.discoveryExistingReady')
                  : discoveryStage === 'analyzing'
                    ? t('messages.discoveryRunning')
                    : discoveryStage === 'ready'
                      ? t('messages.discoveryReady')
                      : discoveryStage === 'creating'
                        ? t('messages.discoveryCreating')
                        : discoveryStage === 'created'
                          ? t('messages.discoveryCreated')
                          : discoveryStage === 'error'
                            ? t('messages.discoveryErrored')
                            : t('messages.discoveryIdle')}
              </strong>
              {activeProjectName ? <span>{activeProjectName}</span> : null}
            </div>

            <div
              className={`${styles.discoveryHero} ${
                discoveryBusy
                  ? styles.discoveryHeroBusy
                  : discoveryStage === 'ready' ||
                      discoveryStage === 'created' ||
                      discoveryStage === 'done'
                    ? styles.discoveryHeroReady
                    : discoveryStage === 'error'
                      ? styles.discoveryHeroError
                      : ''
              }`}
            >
              <div className={styles.discoveryHeroTop}>
                <div className={styles.discoverySignal}>
                  <span className={styles.discoverySignalPulse} />
                  <span className={styles.discoverySignalCore} />
                </div>
                <div className={styles.discoveryHeroCopy}>
                  <span className={styles.discoveryHeroLabel}>
                    {discoveryBusy
                      ? t('messages.discoveryLiveLabel')
                      : discoveryStage === 'chooseExisting'
                        ? t('messages.discoverySavedLabel')
                        : t('messages.discoverySnapshotLabel')}
                  </span>
                  <strong>
                    {discoveryStage === 'chooseExisting'
                      ? t('messages.discoveryExistingReady')
                      : discoveryBusy
                        ? t('messages.discoveryAnalyzingTitle')
                        : discoveryStage === 'ready'
                          ? t('messages.discoveryReady')
                          : discoveryStage === 'created'
                            ? t('messages.discoveryCreated')
                            : discoveryStage === 'error'
                              ? t('messages.discoveryErrored')
                              : t('messages.discoveryIdle')}
                  </strong>
                  <p>
                    {discoveryLatestLog ??
                      (discoveryBusy
                        ? t('messages.discoveryAnalyzingHint')
                        : discoveryFooterMessage)}
                  </p>
                </div>
              </div>

              <div className={styles.discoveryStepRow}>
                {discoveryStepLabels.map((label, index) => {
                  const completed =
                    discoveryStage !== 'idle' &&
                    discoveryStage !== 'error' &&
                    (discoveryStage !== 'analyzing' || index < discoveryActiveStepIndex);
                  const active =
                    discoveryBusy &&
                    discoveryStage === 'analyzing' &&
                    index === discoveryActiveStepIndex;

                  return (
                    <div
                      key={label}
                      className={`${styles.discoveryStep} ${
                        completed
                          ? styles.discoveryStepDone
                          : active
                            ? styles.discoveryStepActive
                            : ''
                      }`}
                    >
                      <span>{index + 1}</span>
                      <strong>{label}</strong>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className={styles.discoveryBody}>
              <section className={styles.discoveryPanel}>
                <div className={styles.sectionHeader}>
                  <h3>{t('sections.discoveryLog')}</h3>
                  <span className={discoveryBusy ? styles.discoveryLiveBadge : ''}>
                    {discoveryBusy ? t('messages.discoveryLiveLabel') : discoveryLogs.length}
                  </span>
                </div>
                <div className={styles.discoveryLogList}>
                  {discoveryLogs.length > 0 ? (
                    discoveryLogs.map((entry, index) => (
                      <div key={`${entry}-${index}`} className={styles.discoveryLogItem}>
                        {entry}
                      </div>
                    ))
                  ) : (
                    <div className={styles.discoveryEmpty}>{t('messages.discoveryIdle')}</div>
                  )}
                </div>
              </section>

              <section className={styles.discoveryPanel}>
                <div className={styles.sectionHeader}>
                  <h3>{t('sections.discoveryFindings')}</h3>
                  <span>{discoveryAnalysis?.findings.length ?? 0}</span>
                </div>
                {discoveryAnalysis?.findings.length ? (
                  <div className={styles.discoveryFindingList}>
                    {discoveryAnalysis.findings.map((finding) => (
                      <article key={finding.id} className={styles.discoveryFindingCard}>
                        <div className={styles.discoveryFindingTop}>
                          <span
                            className={`${styles.statusPill} ${
                              finding.kind === 'bug' ? styles.statusblocked : styles.statustodo
                            }`}
                          >
                            {finding.kind === 'bug' ? 'Bug' : 'Feature'}
                          </span>
                          <span>
                            {finding.files[0] || finding.evidence[0] || activeProjectName}
                          </span>
                        </div>
                        <strong>{finding.title}</strong>
                        <p>{finding.summary}</p>
                      </article>
                    ))}
                  </div>
                ) : discoveryBusy ? (
                  <div className={styles.discoverySkeletonList}>
                    {[0, 1, 2].map((entry) => (
                      <div key={entry} className={styles.discoverySkeletonCard}>
                        <span className={styles.discoverySkeletonTag} />
                        <strong className={styles.discoverySkeletonTitle} />
                        <p className={styles.discoverySkeletonBody} />
                        <p className={styles.discoverySkeletonBodyShort} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.discoveryEmpty}>{t('messages.discoveryNoFindings')}</div>
                )}
              </section>
            </div>

            <div className={styles.discoveryFooter}>
              {discoveryStage === 'chooseExisting' ? (
                <>
                  <p>
                    {t('messages.discoveryExistingPrompt', {
                      count: discoveryAnalysis?.findings.length ?? 0,
                    })}
                  </p>
                  <div className={styles.discoveryFooterActions}>
                    <button className={styles.secondaryButton} onClick={handleAnalyzeAgain}>
                      {t('actions.analyzeAgain')}
                    </button>
                    <button className={styles.primaryButton} onClick={handleUseSavedDiscovery}>
                      {t('actions.useSavedAnalysis')}
                    </button>
                  </div>
                </>
              ) : discoveryStage === 'ready' ? (
                <>
                  <p>
                    {t('messages.discoveryContinuePrompt', {
                      count: discoveryAnalysis?.findings.length ?? 0,
                    })}
                  </p>
                  <div className={styles.discoveryFooterActions}>
                    <button className={styles.secondaryButton} onClick={handleCloseDiscovery}>
                      {t('actions.notNow')}
                    </button>
                    <button
                      className={styles.primaryButton}
                      onClick={() => void handleContinueDiscovery()}
                    >
                      {t('actions.continue')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p>{discoveryFooterMessage}</p>
                  <div className={styles.discoveryFooterActions}>
                    <button className={styles.secondaryButton} onClick={handleCloseDiscovery}>
                      {t('actions.close')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {deleteConfirmOpen && selectedWork ? (
        <div className={styles.discoveryOverlay}>
          <div className={styles.discoveryModal}>
            <div className={styles.discoveryHeader}>
              <div>
                <p className={styles.kicker}>{t('drafts.editTask')}</p>
                <h2>{t('actions.delete')}</h2>
                <p className={styles.discoverySubtitle}>
                  {selectedWork.status === 'in_progress'
                    ? 'This task is currently running. Deleting it will request cancellation first.'
                    : 'This task is currently under review. Deleting it will stop any further automated work.'}
                </p>
              </div>
            </div>

            <div className={styles.discoveryPanel}>
              <strong>{selectedWork.title}</strong>
              <p className={styles.discoverySubtitle}>
                {selectedWork.status === 'in_progress'
                  ? 'The worker may stop only after the current model/tool step returns.'
                  : 'Reviewer processing will be canceled before the task files are removed.'}
              </p>
            </div>

            <div className={styles.discoveryFooter}>
              <p>Delete this task and its comments?</p>
              <div className={styles.discoveryFooterActions}>
                <button
                  className={styles.secondaryButton}
                  onClick={() => setDeleteConfirmOpen(false)}
                >
                  {t('actions.notNow')}
                </button>
                <button className={styles.dangerButton} onClick={() => void handleDeleteTask()}>
                  {t('actions.delete')}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default KiraPage;
