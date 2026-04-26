import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { initVibeApp, AppLifecycle } from '@gui/vibe-container';
import {
  AlertTriangle,
  FileArchive,
  PanelLeft,
  RefreshCw,
  Search,
  Shield,
  Upload,
} from 'lucide-react';
import {
  createAppFileApi,
  fetchVibeInfo,
  reportAction,
  reportLifecycle,
  useAgentActionListener,
  useFileSystem,
  type CharacterAppAction,
} from '@/lib';
import {
  getIdaPeHealth,
  getPeFunctionDetail,
  getPeFunctions,
  runQuickPeAnalysis,
  useCurrentIdbAnalysis,
  uploadPeSample,
} from '@/lib/idaPeClient';
import type {
  IdaPeHealth,
  PeBackendFunctionDetail,
  PeBackendFunctionSummary,
  PeAnalysisRecord,
  PeAnalyzerState,
  PeAnalysisView,
  PeFindingSeverity,
  PeSampleRecord,
  PeStringHit,
} from '@/lib/idaPeTypes';
import styles from './index.module.scss';

const APP_ID = 20;
const APP_NAME = 'peanalyzer';
const STATE_FILE = '/state.json';
const SAMPLES_DIR = '/samples';
const ANALYSES_DIR = '/analyses';
const peAnalyzerFileApi = createAppFileApi(APP_NAME);

const DEFAULT_STATE: PeAnalyzerState = {
  activeSampleId: null,
  activeAnalysisId: null,
  selectedFindingId: null,
  selectedFunctionEa: null,
  activeView: 'overview',
  filterSeverity: null,
  sidebarOpen: true,
  showLibraryFunctions: false,
};

function sampleFilePath(sampleId: string): string {
  return `${SAMPLES_DIR}/${sampleId}.json`;
}

function analysisFilePath(analysisId: string): string {
  return `${ANALYSES_DIR}/${analysisId}.json`;
}

function normalizeState(raw: unknown): PeAnalyzerState {
  if (!raw) return DEFAULT_STATE;
  const parsed =
    typeof raw === 'string'
      ? (JSON.parse(raw) as Partial<PeAnalyzerState>)
      : (raw as Partial<PeAnalyzerState>);
  return {
    ...DEFAULT_STATE,
    ...parsed,
  };
}

function normalizeSample(raw: unknown): PeSampleRecord | null {
  if (!raw) return null;
  const parsed =
    typeof raw === 'string' ? (JSON.parse(raw) as PeSampleRecord) : (raw as PeSampleRecord);
  if (!parsed?.id) return null;
  return {
    ...parsed,
    lastAnalysisId: parsed.lastAnalysisId ?? null,
    lastScannedAt: parsed.lastScannedAt ?? null,
  };
}

function normalizeAnalysis(raw: unknown): PeAnalysisRecord | null {
  if (!raw) return null;
  const parsed =
    typeof raw === 'string' ? (JSON.parse(raw) as PeAnalysisRecord) : (raw as PeAnalysisRecord);
  if (!parsed?.id) return null;
  return parsed;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function getSeverityLabel(severity: PeFindingSeverity): string {
  return severity.toUpperCase();
}

function severityClass(severity: PeFindingSeverity): string {
  switch (severity) {
    case 'high':
      return styles.severityHigh;
    case 'medium':
      return styles.severityMedium;
    default:
      return styles.severityLow;
  }
}

function findLatestAnalysisForSample(
  analyses: PeAnalysisRecord[],
  sample: PeSampleRecord | null,
): PeAnalysisRecord | null {
  if (!sample) return null;
  const exact = sample.lastAnalysisId
    ? analyses.find((analysis) => analysis.id === sample.lastAnalysisId)
    : null;
  if (exact) return exact;
  return (
    analyses
      .filter((analysis) => analysis.sampleId === sample.id)
      .sort((left, right) => right.finishedAt - left.finishedAt)[0] ?? null
  );
}

function suspiciousStrings(strings: PeStringHit[]): PeStringHit[] {
  return strings.filter((item) => item.suspicious).slice(0, 12);
}

function parseNumericAddress(raw: string | null | undefined): number | null {
  const value = (raw || '').trim();
  if (!value) return null;
  if (/^0x/i.test(value)) {
    const parsed = Number.parseInt(value.slice(2), 16);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatHexAddress(value: number): string {
  return `0x${value.toString(16)}`;
}

function getPreferredEntryFunctionAddress(analysis: PeAnalysisRecord | null): string | null {
  if (!analysis) return null;

  const entryPoint = parseNumericAddress(analysis.metadata.entryPointRva);
  if (entryPoint === null) return null;

  const imageBase = parseNumericAddress(analysis.metadata.imageBase);
  if (imageBase !== null && entryPoint < imageBase) {
    return formatHexAddress(imageBase + entryPoint);
  }

  return formatHexAddress(entryPoint);
}

const PeAnalyzerPage: React.FC = () => {
  const [samples, setSamples] = useState<PeSampleRecord[]>([]);
  const [analyses, setAnalyses] = useState<PeAnalysisRecord[]>([]);
  const [health, setHealth] = useState<IdaPeHealth | null>(null);
  const [selectedSampleId, setSelectedSampleId] = useState<string | null>(null);
  const [selectedAnalysisId, setSelectedAnalysisId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<PeAnalysisView>('overview');
  const [filterSeverity, setFilterSeverity] = useState<PeFindingSeverity | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [selectedFunctionEa, setSelectedFunctionEa] = useState<string | null>(null);
  const [functionQuery, setFunctionQuery] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(DEFAULT_STATE.sidebarOpen);
  const [backendFunctions, setBackendFunctions] = useState<PeBackendFunctionSummary[]>([]);
  const [backendFunctionTotal, setBackendFunctionTotal] = useState(0);
  const [functionDetail, setFunctionDetail] = useState<PeBackendFunctionDetail | null>(null);
  const [functionError, setFunctionError] = useState<string | null>(null);
  const [isFunctionsLoading, setIsFunctionsLoading] = useState(false);
  const [isFunctionDetailLoading, setIsFunctionDetailLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [isRunningAnalysis, setIsRunningAnalysis] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const { saveFile, syncToCloud, initFromCloud, getChildrenByPath, getByPath } = useFileSystem({
    fileApi: peAnalyzerFileApi,
  });

  const loadSamplesFromFS = useCallback((): PeSampleRecord[] => {
    return getChildrenByPath(SAMPLES_DIR)
      .filter((node) => node.type === 'file')
      .map((node) => {
        try {
          return normalizeSample(node.content);
        } catch (error) {
          console.warn('[PeAnalyzer] Failed to parse sample', node.path, error);
          return null;
        }
      })
      .filter((sample): sample is PeSampleRecord => sample !== null)
      .sort((left, right) => right.uploadedAt - left.uploadedAt);
  }, [getChildrenByPath]);

  const loadAnalysesFromFS = useCallback((): PeAnalysisRecord[] => {
    return getChildrenByPath(ANALYSES_DIR)
      .filter((node) => node.type === 'file')
      .map((node) => {
        try {
          return normalizeAnalysis(node.content);
        } catch (error) {
          console.warn('[PeAnalyzer] Failed to parse analysis', node.path, error);
          return null;
        }
      })
      .filter((analysis): analysis is PeAnalysisRecord => analysis !== null)
      .sort((left, right) => right.finishedAt - left.finishedAt);
  }, [getChildrenByPath]);

  const writeJson = useCallback(
    async (path: string, value: unknown) => {
      saveFile(path, value);
      await syncToCloud(path, value);
    },
    [saveFile, syncToCloud],
  );

  const persistViewState = useCallback(
    async (nextState: PeAnalyzerState) => {
      await writeJson(STATE_FILE, nextState);
    },
    [writeJson],
  );

  const refreshHealth = useCallback(async () => {
    try {
      const nextHealth = await getIdaPeHealth();
      setHealth(nextHealth);
    } catch (error) {
      console.error('[PeAnalyzer] Failed to fetch health', error);
      setHealth({
        status: 'degraded',
        backendMode: 'prescan-only',
        backendConfigured: false,
        backendReachable: false,
        backendUrl: null,
        message: error instanceof Error ? error.message : String(error),
        capabilities: {
          upload: true,
          quickTriage: true,
          idaMcp: false,
          currentIdb: false,
        },
      });
    }
  }, []);

  const refreshFromCloud = useCallback(
    async (focusSampleId?: string | null, focusAnalysisId?: string | null) => {
      await initFromCloud();
      const nextSamples = loadSamplesFromFS();
      const nextAnalyses = loadAnalysesFromFS();
      const persisted = normalizeState(getByPath(STATE_FILE)?.content);
      const selectedSample =
        nextSamples.find((sample) => sample.id === (focusSampleId ?? persisted.activeSampleId)) ??
        nextSamples[0] ??
        null;
      const latestAnalysis = findLatestAnalysisForSample(nextAnalyses, selectedSample);

      setSamples(nextSamples);
      setAnalyses(nextAnalyses);
      setSelectedSampleId(selectedSample?.id ?? null);
      setSelectedAnalysisId(
        focusAnalysisId ??
          persisted.activeAnalysisId ??
          selectedSample?.lastAnalysisId ??
          latestAnalysis?.id ??
          null,
      );
      setActiveView(persisted.activeView);
      setFilterSeverity(persisted.filterSeverity);
      setSelectedFindingId(persisted.selectedFindingId);
      setSelectedFunctionEa(persisted.selectedFunctionEa);
      setSidebarOpen(persisted.sidebarOpen);
    },
    [getByPath, initFromCloud, loadAnalysesFromFS, loadSamplesFromFS],
  );

  const selectedSample = useMemo(
    () => samples.find((sample) => sample.id === selectedSampleId) ?? null,
    [samples, selectedSampleId],
  );

  const selectedAnalysis = useMemo(() => {
    const exact = analyses.find((analysis) => analysis.id === selectedAnalysisId) ?? null;
    if (exact) return exact;
    return findLatestAnalysisForSample(analyses, selectedSample);
  }, [analyses, selectedAnalysisId, selectedSample]);

  const preferredEntryFunctionEa = useMemo(
    () => getPreferredEntryFunctionAddress(selectedAnalysis),
    [selectedAnalysis],
  );

  useEffect(() => {
    if (!selectedSample) {
      setSelectedAnalysisId(null);
      return;
    }
    const latestAnalysis = findLatestAnalysisForSample(analyses, selectedSample);
    if (!selectedAnalysisId && latestAnalysis) {
      setSelectedAnalysisId(latestAnalysis.id);
      return;
    }
    if (
      selectedSample.lastAnalysisId &&
      selectedSample.lastAnalysisId !== selectedAnalysisId &&
      analyses.some((analysis) => analysis.id === selectedSample.lastAnalysisId)
    ) {
      setSelectedAnalysisId(selectedSample.lastAnalysisId);
    }
  }, [analyses, selectedAnalysisId, selectedSample]);

  const filteredFindings = useMemo(() => {
    const findings = selectedAnalysis?.findings ?? [];
    return filterSeverity
      ? findings.filter((finding) => finding.severity === filterSeverity)
      : findings;
  }, [filterSeverity, selectedAnalysis]);

  const highlightedFinding = useMemo(
    () =>
      filteredFindings.find((finding) => finding.id === selectedFindingId) ??
      filteredFindings[0] ??
      null,
    [filteredFindings, selectedFindingId],
  );

  const handlePersistSampleAndAnalysis = useCallback(
    async (sample: PeSampleRecord, analysis: PeAnalysisRecord) => {
      await Promise.all([
        writeJson(sampleFilePath(sample.id), sample),
        writeJson(analysisFilePath(analysis.id), analysis),
      ]);
    },
    [writeJson],
  );

  const handleSelectSample = useCallback(
    (sampleId: string) => {
      const sample = samples.find((entry) => entry.id === sampleId) ?? null;
      const analysis = findLatestAnalysisForSample(analyses, sample);
      setSelectedSampleId(sampleId);
      setSelectedAnalysisId(analysis?.id ?? sample?.lastAnalysisId ?? null);
      setSelectedFindingId(null);
      setSelectedFunctionEa(null);
      reportAction(APP_ID, 'OPEN_SAMPLE', { sampleId });
    },
    [analyses, samples],
  );

  const handleUploadFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      setIsUploading(true);
      setErrorText(null);
      try {
        const response = await uploadPeSample(file);
        await handlePersistSampleAndAnalysis(response.sample, response.analysis);
        setSamples((prev) =>
          [response.sample, ...prev.filter((sample) => sample.id !== response.sample.id)].sort(
            (left, right) => right.uploadedAt - left.uploadedAt,
          ),
        );
        setAnalyses((prev) =>
          [
            response.analysis,
            ...prev.filter((analysis) => analysis.id !== response.analysis.id),
          ].sort((left, right) => right.finishedAt - left.finishedAt),
        );
        setSelectedSampleId(response.sample.id);
        setSelectedAnalysisId(response.analysis.id);
        setSelectedFindingId(response.analysis.findings[0]?.id ?? null);
        setSelectedFunctionEa(null);
        setActiveView('overview');
        reportAction(APP_ID, 'RUN_QUICK_TRIAGE', {
          sampleId: response.sample.id,
          analysisId: response.analysis.id,
        });
      } catch (error) {
        console.error('[PeAnalyzer] Upload failed', error);
        setErrorText(error instanceof Error ? error.message : String(error));
      } finally {
        setIsUploading(false);
        event.target.value = '';
      }
    },
    [handlePersistSampleAndAnalysis],
  );

  const handleUseCurrentIdb = useCallback(async () => {
    setIsRunningAnalysis(true);
    setErrorText(null);
    try {
      const response = await useCurrentIdbAnalysis();
      await handlePersistSampleAndAnalysis(response.sample, response.analysis);
      setSamples((prev) =>
        [response.sample, ...prev.filter((sample) => sample.id !== response.sample.id)].sort(
          (left, right) => right.uploadedAt - left.uploadedAt,
        ),
      );
      setAnalyses((prev) =>
        [
          response.analysis,
          ...prev.filter((analysis) => analysis.id !== response.analysis.id),
        ].sort((left, right) => right.finishedAt - left.finishedAt),
      );
      setSelectedSampleId(response.sample.id);
      setSelectedAnalysisId(response.analysis.id);
      setSelectedFindingId(response.analysis.findings[0]?.id ?? null);
      setSelectedFunctionEa(null);
      setActiveView('overview');
      reportAction(APP_ID, 'RUN_QUICK_TRIAGE', {
        sampleId: response.sample.id,
        analysisId: response.analysis.id,
        sourceMode: 'current-idb',
      });
    } catch (error) {
      console.error('[PeAnalyzer] Current IDB analysis failed', error);
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRunningAnalysis(false);
    }
  }, [handlePersistSampleAndAnalysis]);

  const handleRunQuickTriage = useCallback(
    async (targetSampleId?: string | null) => {
      const sample =
        samples.find((entry) => entry.id === (targetSampleId ?? selectedSampleId)) ?? null;
      if (!sample) {
        if (health?.capabilities.currentIdb) {
          await handleUseCurrentIdb();
        }
        return;
      }
      if (sample.sourceMode === 'current-idb') {
        await handleUseCurrentIdb();
        return;
      }
      setIsRunningAnalysis(true);
      setErrorText(null);
      try {
        const response = await runQuickPeAnalysis(sample.diskPath, sample.id);
        await handlePersistSampleAndAnalysis(response.sample, response.analysis);
        setSamples((prev) =>
          [response.sample, ...prev.filter((entry) => entry.id !== response.sample.id)].sort(
            (left, right) => right.uploadedAt - left.uploadedAt,
          ),
        );
        setAnalyses((prev) =>
          [response.analysis, ...prev.filter((entry) => entry.id !== response.analysis.id)].sort(
            (left, right) => right.finishedAt - left.finishedAt,
          ),
        );
        setSelectedSampleId(response.sample.id);
        setSelectedAnalysisId(response.analysis.id);
        setSelectedFindingId(response.analysis.findings[0]?.id ?? null);
        setSelectedFunctionEa(null);
        reportAction(APP_ID, 'RUN_QUICK_TRIAGE', {
          sampleId: response.sample.id,
          analysisId: response.analysis.id,
        });
      } catch (error) {
        console.error('[PeAnalyzer] Quick triage failed', error);
        setErrorText(error instanceof Error ? error.message : String(error));
      } finally {
        setIsRunningAnalysis(false);
      }
    },
    [
      handlePersistSampleAndAnalysis,
      handleUseCurrentIdb,
      health?.capabilities.currentIdb,
      samples,
      selectedSampleId,
    ],
  );

  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'USE_CURRENT_IDB': {
          await handleUseCurrentIdb();
          return 'success';
        }
        case 'OPEN_SAMPLE': {
          const sampleId = action.params?.sampleId?.trim();
          if (!sampleId) return 'error: missing sampleId';
          await refreshFromCloud(sampleId, null);
          handleSelectSample(sampleId);
          return 'success';
        }
        case 'RUN_QUICK_TRIAGE': {
          const sampleId = action.params?.sampleId?.trim();
          if (!sampleId) return 'error: missing sampleId';
          await refreshFromCloud(sampleId, null);
          await handleRunQuickTriage(sampleId);
          return 'success';
        }
        case 'SHOW_ANALYSIS': {
          const analysisId = action.params?.analysisId?.trim();
          if (!analysisId) return 'error: missing analysisId';
          const analysis = analyses.find((entry) => entry.id === analysisId);
          if (!analysis) {
            await refreshFromCloud(null, analysisId);
          } else {
            setSelectedSampleId(analysis.sampleId);
            setSelectedAnalysisId(analysisId);
          }
          return 'success';
        }
        case 'REFRESH_PE_ANALYZER': {
          await refreshFromCloud(
            action.params?.sampleId ?? null,
            action.params?.analysisId ?? null,
          );
          return 'success';
        }
        default:
          return `error: unknown action_type ${action.action_type}`;
      }
    },
    [analyses, handleRunQuickTriage, handleSelectSample, handleUseCurrentIdb, refreshFromCloud],
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
          name: 'PE Analyst',
          windowStyle: { width: 1320, height: 820 },
        });

        manager.handshake({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: 'PE Analyst',
          windowStyle: { width: 1320, height: 820 },
        });

        reportLifecycle(AppLifecycle.DOM_READY);
        await fetchVibeInfo().catch(() => undefined);
        await Promise.all([refreshHealth(), refreshFromCloud()]);
        setIsLoading(false);
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
      } catch (error) {
        console.error('[PeAnalyzer] Init error', error);
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
  }, [refreshFromCloud, refreshHealth]);

  useEffect(() => {
    if (isLoading) return;
    void persistViewState({
      activeSampleId: selectedSampleId,
      activeAnalysisId: selectedAnalysis?.id ?? selectedAnalysisId,
      selectedFindingId: highlightedFinding?.id ?? null,
      selectedFunctionEa,
      activeView,
      filterSeverity,
      sidebarOpen,
      showLibraryFunctions: false,
    });
  }, [
    activeView,
    filterSeverity,
    highlightedFinding?.id,
    isLoading,
    persistViewState,
    sidebarOpen,
    selectedAnalysis?.id,
    selectedAnalysisId,
    selectedFunctionEa,
    selectedSampleId,
  ]);

  useEffect(() => {
    if (activeView !== 'functions') return;
    if (!selectedSample || selectedAnalysis?.backendMode !== 'mcp-http') {
      setBackendFunctions([]);
      setBackendFunctionTotal(0);
      setFunctionDetail(null);
      setFunctionError(null);
      return;
    }

    let cancelled = false;
    const loadFunctions = async () => {
      setIsFunctionsLoading(true);
      setFunctionError(null);
      try {
        const response = await getPeFunctions({
          samplePath: selectedSample.diskPath,
          limit: 150,
          ...(functionQuery.trim() ? { regex: functionQuery.trim() } : {}),
        });
        if (cancelled) return;
        let nextFunctions = [...response.functions];
        if (preferredEntryFunctionEa) {
          const entryIndex = nextFunctions.findIndex(
            (fn) => fn.address === preferredEntryFunctionEa,
          );
          if (entryIndex >= 0) {
            const [entryFunction] = nextFunctions.splice(entryIndex, 1);
            nextFunctions = [entryFunction, ...nextFunctions];
          } else if (!functionQuery.trim()) {
            nextFunctions = [
              { address: preferredEntryFunctionEa, name: 'Entry Point' },
              ...nextFunctions,
            ];
          }
        }

        setBackendFunctions(nextFunctions);
        setBackendFunctionTotal(response.total);
        setSelectedFunctionEa(preferredEntryFunctionEa || nextFunctions[0]?.address || null);
      } catch (error) {
        if (cancelled) return;
        setBackendFunctions([]);
        setBackendFunctionTotal(0);
        setFunctionDetail(null);
        setFunctionError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) {
          setIsFunctionsLoading(false);
        }
      }
    };

    void loadFunctions();
    return () => {
      cancelled = true;
    };
  }, [
    activeView,
    functionQuery,
    preferredEntryFunctionEa,
    selectedAnalysis?.backendMode,
    selectedSample,
  ]);

  useEffect(() => {
    if (activeView !== 'functions') return;
    if (!selectedSample || selectedAnalysis?.backendMode !== 'mcp-http' || !selectedFunctionEa) {
      setFunctionDetail(null);
      return;
    }

    let cancelled = false;
    const loadDetail = async () => {
      setIsFunctionDetailLoading(true);
      setFunctionError(null);
      try {
        const detail = await getPeFunctionDetail({
          samplePath: selectedSample.diskPath,
          address: selectedFunctionEa,
        });
        if (!cancelled) {
          setFunctionDetail(detail);
        }
      } catch (error) {
        if (!cancelled) {
          setFunctionDetail(null);
          setFunctionError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setIsFunctionDetailLoading(false);
        }
      }
    };

    void loadDetail();
    return () => {
      cancelled = true;
    };
  }, [activeView, selectedAnalysis?.backendMode, selectedFunctionEa, selectedSample]);

  const renderOverview = () => {
    if (!selectedAnalysis || !selectedSample) {
      return (
        <div className={styles.emptyPanel}>
          <FileArchive size={42} />
          <strong>No sample selected</strong>
          <p>Use the current IDB or upload a PE file to generate a quick static triage summary.</p>
        </div>
      );
    }

    return (
      <div className={styles.viewStack}>
        <section className={styles.heroCard}>
          <div>
            <span className={styles.heroEyebrow}>Quick Triage</span>
            <h2>{selectedSample.fileName}</h2>
            <p>{selectedAnalysis.summary}</p>
          </div>
          <div className={styles.heroStats}>
            <div>
              <span>Machine</span>
              <strong>{selectedAnalysis.metadata.machine}</strong>
            </div>
            <div>
              <span>Entrypoint</span>
              <strong>{selectedAnalysis.metadata.entryPointRva}</strong>
            </div>
            <div>
              <span>Imports</span>
              <strong>{selectedAnalysis.triage.importFunctionCount}</strong>
            </div>
            <div>
              <span>Findings</span>
              <strong>{selectedAnalysis.findings.length}</strong>
            </div>
          </div>
        </section>

        <section className={styles.metricGrid}>
          <article className={styles.metricCard}>
            <span>Suspected packed</span>
            <strong>{selectedAnalysis.triage.suspectedPacked ? 'Yes' : 'No'}</strong>
          </article>
          <article className={styles.metricCard}>
            <span>High entropy sections</span>
            <strong>{selectedAnalysis.triage.highEntropySectionCount}</strong>
          </article>
          <article className={styles.metricCard}>
            <span>Suspicious imports</span>
            <strong>{selectedAnalysis.triage.suspiciousImportCount}</strong>
          </article>
          <article className={styles.metricCard}>
            <span>Suspicious strings</span>
            <strong>{selectedAnalysis.triage.suspiciousStringCount}</strong>
          </article>
        </section>
      </div>
    );
  };

  const renderFindings = () => {
    if (!selectedAnalysis) return renderOverview();
    return (
      <section className={styles.dualColumn}>
        <article className={styles.panelCard}>
          <div className={styles.panelHeader}>
            <h3>Findings</h3>
            <div className={styles.filterRail}>
              {(['high', 'medium', 'low'] as PeFindingSeverity[]).map((severity) => (
                <button
                  key={severity}
                  className={`${styles.filterChip} ${
                    filterSeverity === severity ? styles.filterChipActive : ''
                  }`}
                  onClick={() => setFilterSeverity((prev) => (prev === severity ? null : severity))}
                >
                  {severity}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.findingList}>
            {filteredFindings.map((finding) => (
              <button
                key={finding.id}
                className={`${styles.findingItem} ${
                  highlightedFinding?.id === finding.id ? styles.findingItemActive : ''
                }`}
                onClick={() => setSelectedFindingId(finding.id)}
              >
                <div className={styles.findingMeta}>
                  <span className={`${styles.severityBadge} ${severityClass(finding.severity)}`}>
                    {getSeverityLabel(finding.severity)}
                  </span>
                  <span className={styles.findingCategory}>{finding.category}</span>
                </div>
                <strong>{finding.title}</strong>
                <p>{finding.description}</p>
              </button>
            ))}
            {filteredFindings.length === 0 && (
              <div className={styles.emptyInline}>
                No findings match the current severity filter.
              </div>
            )}
          </div>
        </article>

        <article className={styles.panelCard}>
          <div className={styles.panelHeader}>
            <h3>Evidence</h3>
            <span className={styles.mutedLabel}>
              {highlightedFinding ? highlightedFinding.evidence.length : 0} items
            </span>
          </div>
          {highlightedFinding ? (
            <div className={styles.evidenceStack}>
              <p className={styles.evidenceBody}>{highlightedFinding.description}</p>
              {highlightedFinding.evidence.map((item) => (
                <div key={item} className={styles.evidenceChip}>
                  <ChevronLine />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.emptyInline}>
              Select a finding to inspect supporting indicators.
            </div>
          )}
        </article>
      </section>
    );
  };

  const renderImports = () => {
    if (!selectedAnalysis) return renderOverview();
    return (
      <div className={styles.tableCard}>
        <div className={styles.panelHeader}>
          <h3>Imports</h3>
          <span className={styles.mutedLabel}>{selectedAnalysis.imports.length} modules</span>
        </div>
        <div className={styles.moduleList}>
          {selectedAnalysis.imports.map((entry) => (
            <div key={entry.module} className={styles.moduleCard}>
              <div className={styles.moduleHeader}>
                <div>
                  <strong>{entry.module}</strong>
                  <p>{entry.count} imported symbol(s)</p>
                </div>
                {entry.suspiciousCount > 0 && (
                  <span className={`${styles.severityBadge} ${styles.severityMedium}`}>
                    {entry.suspiciousCount} suspicious
                  </span>
                )}
              </div>
              <div className={styles.nameCloud}>
                {entry.names.map((name) => (
                  <span
                    key={`${entry.module}:${name}`}
                    className={`${styles.nameChip} ${
                      /virtualalloc|createremotethread|internetopen|isdebuggerpresent/i.test(name)
                        ? styles.nameChipHighlighted
                        : ''
                    }`}
                  >
                    {name}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderSections = () => {
    if (!selectedAnalysis) return renderOverview();
    return (
      <div className={styles.tableCard}>
        <div className={styles.panelHeader}>
          <h3>Sections</h3>
          <span className={styles.mutedLabel}>{selectedAnalysis.sections.length} sections</span>
        </div>
        <div className={styles.sectionTable}>
          <div className={styles.sectionHead}>
            <span>Name</span>
            <span>VA</span>
            <span>Raw</span>
            <span>Perms</span>
            <span>Entropy</span>
          </div>
          {selectedAnalysis.sections.map((section) => (
            <div key={section.name} className={styles.sectionRow}>
              <strong>{section.name}</strong>
              <span>{section.virtualAddress}</span>
              <span>{formatBytes(section.rawSize)}</span>
              <span>{section.permissions}</span>
              <span className={section.entropy >= 7.2 ? styles.highEntropy : ''}>
                {section.entropy.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderStrings = () => {
    if (!selectedAnalysis) return renderOverview();
    const interestingStrings = suspiciousStrings(selectedAnalysis.strings);
    return (
      <div className={styles.tableCard}>
        <div className={styles.panelHeader}>
          <h3>Strings</h3>
          <span className={styles.mutedLabel}>
            {interestingStrings.length} suspicious / {selectedAnalysis.strings.length} indexed
          </span>
        </div>
        <div className={styles.stringList}>
          {interestingStrings.length > 0 ? (
            interestingStrings.map((item) => (
              <div key={`${item.kind}:${item.offset}:${item.value}`} className={styles.stringRow}>
                <div className={styles.stringMeta}>
                  <span>{item.kind}</span>
                  <span>{item.offset}</span>
                </div>
                <code>{item.value}</code>
              </div>
            ))
          ) : (
            <div className={styles.emptyInline}>
              No suspicious strings were highlighted in the quick pass.
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderFunctions = () => {
    if (!selectedSample || !selectedAnalysis) return renderOverview();
    if (selectedAnalysis.backendMode !== 'mcp-http') {
      return (
        <div className={styles.emptyPanel}>
          <Search size={42} />
          <strong>Functions need MCP-backed analysis</strong>
          <p>
            Set `idaPe.mode` to `mcp-http` and point `idaPe.backendUrl` at `ida-headless-mcp` to
            browse decompiled functions.
          </p>
        </div>
      );
    }

    return (
      <div className={styles.functionLayout}>
        <aside className={styles.functionSidebar}>
          <div className={styles.panelHeader}>
            <h3>Functions</h3>
            <span className={styles.mutedLabel}>{backendFunctionTotal}</span>
          </div>
          <label className={styles.functionSearch}>
            <Search size={15} />
            <input
              value={functionQuery}
              onChange={(event) => setFunctionQuery(event.target.value)}
              placeholder="Regex filter (e.g. main|sub_401)"
            />
          </label>
          <div className={styles.functionList}>
            {isFunctionsLoading ? (
              <div className={styles.emptyInline}>Loading functions...</div>
            ) : backendFunctions.length > 0 ? (
              backendFunctions.map((fn) => (
                <button
                  key={`${fn.address}:${fn.name}`}
                  className={`${styles.functionItem} ${
                    selectedFunctionEa === fn.address ? styles.functionItemActive : ''
                  }`}
                  onClick={() => setSelectedFunctionEa(fn.address)}
                >
                  <strong>{fn.name || fn.address}</strong>
                  <span>{fn.address}</span>
                </button>
              ))
            ) : (
              <div className={styles.emptyInline}>No functions matched the current filter.</div>
            )}
          </div>
        </aside>

        <section className={styles.functionDetailPanel}>
          <div className={styles.panelHeader}>
            <h3>Function Detail</h3>
            <span className={styles.mutedLabel}>{selectedFunctionEa ?? 'None selected'}</span>
          </div>

          {functionError ? (
            <div className={styles.errorBanner}>
              <AlertTriangle size={18} />
              <span>{functionError}</span>
            </div>
          ) : null}

          {isFunctionDetailLoading ? (
            <div className={styles.emptyInline}>Loading function detail...</div>
          ) : functionDetail ? (
            <div className={styles.functionDetailStack}>
              <div className={styles.functionInfoGrid}>
                <article>
                  <span>Name</span>
                  <strong>{functionDetail.info?.name || selectedFunctionEa}</strong>
                </article>
                <article>
                  <span>Range</span>
                  <strong>
                    {functionDetail.info?.start || '-'} to {functionDetail.info?.end || '-'}
                  </strong>
                </article>
                <article>
                  <span>Prototype</span>
                  <strong>
                    {(functionDetail.info?.returnType || 'unknown') +
                      ' ' +
                      (functionDetail.info?.callingConvention || '')}
                  </strong>
                </article>
                <article>
                  <span>Args / Size</span>
                  <strong>
                    {functionDetail.info?.numArgs ?? 0} args / {functionDetail.info?.size ?? 0}{' '}
                    bytes
                  </strong>
                </article>
              </div>

              <div className={styles.functionFlagRow}>
                {functionDetail.info?.flags.isLibrary ? (
                  <span className={styles.smallPill}>library</span>
                ) : null}
                {functionDetail.info?.flags.isThunk ? (
                  <span className={styles.smallPill}>thunk</span>
                ) : null}
                {functionDetail.info?.flags.noReturn ? (
                  <span className={styles.smallPill}>noreturn</span>
                ) : null}
                {functionDetail.info?.flags.isStatic ? (
                  <span className={styles.smallPill}>static</span>
                ) : null}
              </div>

              {functionDetail.decompiled ? (
                <article className={styles.codePanel}>
                  <div className={styles.codeHeader}>Pseudocode</div>
                  <pre>{functionDetail.decompiled}</pre>
                </article>
              ) : (
                <div className={styles.emptyInline}>
                  Decompiler output was not available for this function.
                </div>
              )}

              {functionDetail.disassembly ? (
                <article className={styles.codePanel}>
                  <div className={styles.codeHeader}>Disassembly</div>
                  <pre>{functionDetail.disassembly}</pre>
                </article>
              ) : null}

              <article className={styles.tableCard}>
                <div className={styles.panelHeader}>
                  <h3>Xrefs To</h3>
                  <span className={styles.mutedLabel}>{functionDetail.xrefsTo.length}</span>
                </div>
                <div className={styles.xrefList}>
                  {functionDetail.xrefsTo.length > 0 ? (
                    functionDetail.xrefsTo.map((xref) => (
                      <div key={`${xref.from}:${xref.to}:${xref.type}`} className={styles.xrefItem}>
                        <strong>{xref.from}</strong>
                        <span>to {xref.to}</span>
                        <span>type {xref.type}</span>
                      </div>
                    ))
                  ) : (
                    <div className={styles.emptyInline}>No inbound xrefs were returned.</div>
                  )}
                </div>
              </article>
            </div>
          ) : (
            <div className={styles.emptyInline}>
              Choose a function to inspect metadata, pseudocode, and xrefs.
            </div>
          )}
        </section>
      </div>
    );
  };

  const renderActiveView = () => {
    switch (activeView) {
      case 'findings':
        return renderFindings();
      case 'functions':
        return renderFunctions();
      case 'imports':
        return renderImports();
      case 'sections':
        return renderSections();
      case 'strings':
        return renderStrings();
      default:
        return renderOverview();
    }
  };

  const isCurrentIdbSelected = selectedSample?.sourceMode === 'current-idb';
  const currentIdbActionLabel = isRunningAnalysis
    ? isCurrentIdbSelected
      ? 'Refreshing current IDB...'
      : 'Reading current IDB...'
    : isCurrentIdbSelected
      ? 'Refresh Current IDB'
      : 'Use Current IDB';
  const showTopbarRunQuickTriage = Boolean(
    selectedSample && selectedSample.sourceMode !== 'current-idb',
  );

  if (isLoading) {
    return <div className={styles.loading}>Loading PE Analyst...</div>;
  }

  return (
    <div className={`${styles.page} ${sidebarOpen ? '' : styles.pageCollapsed}`}>
      <aside className={`${styles.sidebar} ${sidebarOpen ? '' : styles.sidebarHidden}`}>
        <div className={styles.brandCard}>
          <div className={styles.brandIcon}>
            <FileArchive size={22} />
          </div>
          <div>
            <p className={styles.kicker}>Your Room</p>
            <h1>PE Analyst</h1>
            <p className={styles.brandCopy}>
              Start from the current IDB in IDA Pro or upload a PE file for pre-scan and
              MCP-assisted reversing.
            </p>
          </div>
        </div>

        <section className={styles.sidebarCard}>
          <div className={styles.sidebarHeader}>
            <h2>Backend</h2>
            <button
              className={styles.iconButton}
              onClick={() => void refreshHealth()}
              title="Refresh health"
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <div
            className={`${styles.healthCard} ${
              health?.status === 'degraded' ? styles.healthDegraded : styles.healthHealthy
            }`}
          >
            <div className={styles.healthMeta}>
              <Shield size={16} />
              <strong>
                {health?.backendMode === 'mcp-http' ? 'MCP configured' : 'Pre-scan only'}
              </strong>
            </div>
            <p>{health?.message ?? 'Health not loaded yet.'}</p>
          </div>
        </section>

        <section className={styles.sidebarCard}>
          <div className={styles.sidebarHeader}>
            <h2>Sources</h2>
            <span className={styles.mutedLabel}>Current IDB or upload</span>
          </div>
          <button
            className={styles.currentIdbButton}
            disabled={!health?.capabilities.currentIdb || isRunningAnalysis}
            onClick={() => void handleUseCurrentIdb()}
          >
            <Shield size={16} />
            <span>{currentIdbActionLabel}</span>
          </button>
          <label className={styles.uploadBox}>
            <Upload size={18} />
            <span>{isUploading ? 'Uploading...' : 'Upload PE sample'}</span>
            <input
              type="file"
              accept=".exe,.dll,.sys,.ocx,.scr,.cpl,.efi"
              onChange={handleUploadFile}
              disabled={isUploading}
            />
          </label>
          <div className={styles.sidebarActionStack}>
            <button
              className={`${styles.secondaryButton} ${styles.sidebarActionButton}`}
              onClick={() => void refreshFromCloud(selectedSampleId, selectedAnalysisId)}
            >
              <Search size={16} />
              <span>Reload Session</span>
            </button>
          </div>
        </section>

        <section className={styles.sidebarCard}>
          <div className={styles.sidebarHeader}>
            <h2>Samples</h2>
            <span className={styles.mutedLabel}>{samples.length}</span>
          </div>
          <div className={styles.sampleList}>
            {samples.map((sample) => (
              <button
                key={sample.id}
                className={`${styles.sampleItem} ${
                  selectedSampleId === sample.id ? styles.sampleItemActive : ''
                }`}
                onClick={() => handleSelectSample(sample.id)}
              >
                <div className={styles.sampleItemHeader}>
                  <strong>{sample.fileName}</strong>
                  <div className={styles.samplePills}>
                    {sample.sourceMode === 'current-idb' ? (
                      <span className={styles.smallPill}>CURRENT IDB</span>
                    ) : null}
                    {sample.isDll ? <span className={styles.smallPill}>DLL</span> : null}
                  </div>
                </div>
                <p>{sample.machineType}</p>
                <div className={styles.sampleMetaRow}>
                  <span>{formatBytes(sample.size)}</span>
                  <span>
                    {sample.lastScannedAt
                      ? new Date(sample.lastScannedAt).toLocaleString()
                      : 'Not scanned'}
                  </span>
                </div>
              </button>
            ))}
            {samples.length === 0 && (
              <div className={styles.emptyInline}>
                No samples yet. Use the current IDB or upload a PE file to start.
              </div>
            )}
          </div>
        </section>
      </aside>

      <main className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.topbarLead}>
            <button
              type="button"
              className={styles.sidebarToggle}
              onClick={() => setSidebarOpen((prev) => !prev)}
              aria-expanded={sidebarOpen}
              title={sidebarOpen ? 'Hide left panel' : 'Show left panel'}
            >
              <PanelLeft size={16} />
              <span>{sidebarOpen ? 'Hide Panel' : 'Show Panel'}</span>
            </button>
            <div className={styles.topbarTitle}>
              <h2>{selectedSample?.fileName ?? 'Nothing selected'}</h2>
            </div>
          </div>
          {showTopbarRunQuickTriage ? (
            <div className={styles.topbarActions}>
              <button
                className={styles.primaryButton}
                disabled={isRunningAnalysis}
                onClick={() => void handleRunQuickTriage()}
              >
                <RefreshCw size={16} />
                <span>{isRunningAnalysis ? 'Analyzing...' : 'Run Quick Triage'}</span>
              </button>
            </div>
          ) : null}
        </header>

        {errorText ? (
          <div className={styles.errorBanner}>
            <AlertTriangle size={18} />
            <span>{errorText}</span>
          </div>
        ) : null}

        {selectedSample && selectedAnalysis ? (
          <section className={styles.sampleSummaryStrip}>
            <article>
              <span>SHA-256</span>
              <strong>{selectedSample.sha256.slice(0, 16)}...</strong>
            </article>
            <article>
              <span>Subsystem</span>
              <strong>{selectedAnalysis.metadata.subsystem}</strong>
            </article>
            <article>
              <span>Image Size</span>
              <strong>{formatBytes(selectedAnalysis.metadata.imageSize)}</strong>
            </article>
            <article>
              <span>Directories</span>
              <strong>{selectedAnalysis.metadata.numberOfDirectories}</strong>
            </article>
          </section>
        ) : null}

        <nav className={styles.tabRail}>
          {(
            [
              'overview',
              'findings',
              'imports',
              'sections',
              'strings',
              'functions',
            ] as PeAnalysisView[]
          ).map((view) => (
            <button
              key={view}
              className={`${styles.tabButton} ${activeView === view ? styles.tabButtonActive : ''}`}
              onClick={() => setActiveView(view)}
            >
              {view}
            </button>
          ))}
        </nav>

        {renderActiveView()}
      </main>
    </div>
  );
};

const ChevronLine: React.FC = () => <span className={styles.chevronLine} aria-hidden="true" />;

export default PeAnalyzerPage;
