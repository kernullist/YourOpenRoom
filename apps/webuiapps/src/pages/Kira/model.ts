export type KiraTaskStatus = 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done';
export type KiraTaskKind = 'work';
export type WorkClarificationStatus = 'pending' | 'answered' | 'cleared';

export interface WorkClarificationQuestion {
  id: string;
  question: string;
  options: string[];
  allowCustomAnswer: boolean;
}

export interface WorkClarificationAnswer {
  questionId: string;
  question: string;
  answer: string;
}

export interface WorkClarificationState {
  status: WorkClarificationStatus;
  briefHash: string;
  summary: string;
  questions: WorkClarificationQuestion[];
  answers?: WorkClarificationAnswer[];
  createdAt: number;
  answeredAt?: number;
}

export interface WorkTask {
  id: string;
  type: 'work';
  projectName: string;
  title: string;
  description: string;
  status: KiraTaskStatus;
  assignee: string;
  clarification?: WorkClarificationState;
  createdAt: number;
  updatedAt: number;
}

export interface TaskComment {
  id: string;
  taskId: string;
  taskType: 'work';
  author: string;
  body: string;
  createdAt: number;
}

export interface KiraRequirementTraceItem {
  id: string;
  source: string;
  text: string;
  status?: string;
  evidence: string[];
}

export interface KiraPatchAlternative {
  name: string;
  selected: boolean;
  rationale: string;
  tradeoffs: string[];
}

export interface KiraRiskReviewPolicy {
  level?: string;
  reasons?: string[];
  evidenceMinimum?: number;
  requiresRuntimeValidation?: boolean;
  requiresSecondPass?: boolean;
}

export interface KiraRuntimeValidationResult {
  checked?: boolean;
  applicable?: boolean;
  serverDetected?: boolean;
  url?: string | null;
  status?: string;
  notes?: string[];
  httpStatus?: number;
  contentType?: string;
  title?: string;
  bodySnippet?: string;
  evidence?: string[];
}

export interface KiraFailureReproductionStep {
  command: string;
  reason: string;
  expectedSignal: string;
}

export interface KiraFailureAnalysisItem {
  command: string;
  category: string;
  summary: string;
  guidance: string;
  reproductionSteps?: KiraFailureReproductionStep[];
}

export interface KiraReviewEvidenceChecked {
  file: string;
  reason: string;
  method: string;
}

export interface KiraSemanticGraphNode {
  file: string;
  role: string;
  imports?: string[];
  exports?: string[];
  symbols?: string[];
  dependents?: string[];
  tests?: string[];
}

export interface KiraTestImpactTarget {
  file: string;
  impactedTests?: string[];
  commands?: string[];
  rationale?: string;
  confidence?: number;
}

export interface KiraReviewAdversarialPlan {
  modes?: string[];
  rationale?: string[];
  requiredEvidence?: string[];
}

export interface KiraReviewAdversarialCheck {
  mode: string;
  result: string;
  evidence: string[];
  concern?: string;
}

export interface KiraPatchIntentVerification {
  status?: string;
  confidence?: number;
  checkedFiles?: string[];
  evidence?: string[];
  issues?: string[];
}

export interface KiraClarificationQualityGate {
  decision?: string;
  confidence?: number;
  reasons?: string[];
  questions?: string[];
}

export interface KiraReviewerCalibration {
  strictness?: string;
  reasons?: string[];
  focusMemories?: string[];
  evidenceMinimum?: number;
}

export interface KiraDesignReviewCheck {
  role: string;
  verdict: string;
  concern: string;
  evidence: string[];
  requiredChanges: string[];
}

export interface KiraDesignReviewGate {
  status?: string;
  summary?: string;
  checks?: KiraDesignReviewCheck[];
  requiredChanges?: string[];
  createdAt?: number;
}

export interface KiraAttemptSynthesisRecommendation {
  canSynthesize?: boolean;
  summary?: string;
  candidateParts?: string[];
  risks?: string[];
}

export interface KiraReviewerDiscourseEntry {
  role: string;
  position: string;
  argument: string;
  evidence: string[];
  response?: string;
}

export interface KiraReviewFindingTriageItem {
  id: string;
  source: string;
  status: string;
  severity: string;
  title: string;
  file?: string;
  line?: number | null;
  evidence: string[];
  owner: string;
  createdAt: number;
}

export interface KiraDiffReviewCoverage {
  changedLineCount: number;
  anchoredFindingCount: number;
  unanchoredFindingCount: number;
  filesWithChangedLines: string[];
  filesCoveredByReview: string[];
  coverageRatio: number;
  issues: string[];
}

export interface KiraConnectorEvidence {
  connectorId: string;
  status: string;
  summary: string;
  url?: string;
  checks: string[];
  evidence: string[];
}

export interface KiraIntegrationRecord {
  status: string;
  message: string;
  commitHash?: string;
  pullRequestUrl?: string;
  connectors: KiraConnectorEvidence[];
  createdAt: number;
}

export interface KiraWorkflowDag {
  nodes: Array<{
    id: string;
    label: string;
    kind: string;
    required: boolean;
  }>;
  edges: Array<{
    from: string;
    to: string;
    condition: string;
  }>;
  criticalPath: string[];
}

export interface KiraOrchestrationPlan {
  promptContractVersion?: number;
  runMode: string;
  taskType: string;
  workerCount: number;
  validationDepth: string;
  reviewDepth: string;
  approvalThreshold: number;
  subagentIds: string[];
  workflowDag?: KiraWorkflowDag;
  runner: string;
  connectors: string[];
  summary: string;
  lanes: Array<{
    id: string;
    role: string;
    goal: string;
    subagentId?: string;
    toolScope: string[];
    modelHint?: string;
    requiredEvidence: string[];
  }>;
  checkpoints: string[];
  stopRules: string[];
  adaptiveAgentPlan?: KiraAdaptiveAgentPlan;
}

export interface KiraAdaptiveAgentPlan {
  schemaVersion: number;
  mode: string;
  alternativeWorker: {
    enabled: boolean;
    maxWorkers: number;
    isolation: string;
    reasons: string[];
  };
  stages: Array<{
    id: string;
    role: string;
    label: string;
    activation: string;
    dependsOn: string[];
    reason: string;
    inputs: string[];
    outputs: string[];
    successCriteria: string[];
    toolScope: string[];
    isolation: string;
    modelHint?: string;
  }>;
  successCriteria: string[];
  verificationPlan: string[];
  integratorPolicy: {
    selection: string;
    mergeMode: string;
    conflictPolicy: string[];
    summaryRequirements: string[];
  };
  omittedRoles: Array<{
    role: string;
    reason: string;
  }>;
}

export interface KiraEvidenceLedger {
  items: Array<{
    id: string;
    kind: string;
    status: string;
    summary: string;
    target?: string;
    evidence: string[];
    createdBy: string;
    confidence: number;
    createdAt: number;
  }>;
  approvalReadiness: {
    score: number;
    status: string;
    blockers: string[];
    missingEvidence: string[];
    requiredEvidenceCount: number;
    observedEvidenceCount: number;
  };
}

export interface KiraAttemptRecord {
  recordVersion?: number;
  migratedFromVersion?: number;
  id: string;
  workId: string;
  attemptNo: number;
  status: string;
  startedAt: number;
  finishedAt: number;
  changedFiles: string[];
  commandsRun: string[];
  outOfPlanFiles: string[];
  validationGaps: string[];
  risks: string[];
  changeDesign?: {
    targetFiles?: string[];
    invariants?: string[];
    expectedImpact?: string[];
    validationStrategy?: string[];
    rollbackStrategy?: string[];
  };
  diffHunkReview?: Array<{
    file: string;
    intent: string;
    risk: string;
  }>;
  validationPlan?: {
    plannerCommands?: string[];
    autoAddedCommands?: string[];
    effectiveCommands?: string[];
    notes?: string[];
  };
  diffStats?: {
    files?: number;
    additions?: number;
    deletions?: number;
    hunks?: number;
  };
  observability?: {
    stage?: string;
    metrics?: Record<string, number>;
    timeline?: string[];
    notes?: string[];
  };
  failureAnalysis?: KiraFailureAnalysisItem[];
  runtimeValidation?: KiraRuntimeValidationResult;
  riskPolicy?: KiraRiskReviewPolicy;
  semanticGraph?: KiraSemanticGraphNode[];
  testImpact?: KiraTestImpactTarget[];
  reviewAdversarialPlan?: KiraReviewAdversarialPlan;
  patchIntentVerification?: KiraPatchIntentVerification;
  clarificationGate?: KiraClarificationQualityGate;
  reviewerCalibration?: KiraReviewerCalibration;
  designReviewGate?: KiraDesignReviewGate;
  orchestrationPlan?: KiraOrchestrationPlan;
  evidenceLedger?: KiraEvidenceLedger;
  integration?: KiraIntegrationRecord;
  requirementTrace?: KiraRequirementTraceItem[];
  approachAlternatives?: KiraPatchAlternative[];
  diffExcerpts?: string[];
  blockedReason?: string;
  rollbackFiles?: string[];
  workerPlan?: {
    summary?: string;
    taskType?: string;
    intendedFiles?: string[];
    protectedFiles?: string[];
    riskNotes?: string[];
    stopConditions?: string[];
  };
  validationReruns?: {
    passed?: string[];
    failed?: string[];
    failureDetails?: string[];
  };
  preflightExploration?: string[];
  readFiles?: string[];
  patchedFiles?: string[];
}

export interface KiraReviewRecord {
  recordVersion?: number;
  migratedFromVersion?: number;
  id: string;
  workId: string;
  attemptNo: number;
  approved: boolean;
  createdAt: number;
  summary: string;
  findings: Array<{
    file: string;
    line: number | null;
    severity: string;
    message: string;
  }>;
  missingValidation: string[];
  nextWorkerInstructions: string[];
  residualRisk: string[];
  filesChecked: string[];
  evidenceChecked: KiraReviewEvidenceChecked[];
  requirementVerdicts: KiraRequirementTraceItem[];
  adversarialChecks: KiraReviewAdversarialCheck[];
  reviewerDiscourse?: KiraReviewerDiscourseEntry[];
  triage?: KiraReviewFindingTriageItem[];
  diffCoverage?: KiraDiffReviewCoverage;
  reviewAdversarialPlan?: KiraReviewAdversarialPlan;
  attemptSynthesis?: KiraAttemptSynthesisRecommendation;
  observability?: {
    durationMs?: number;
    findingCount?: number;
    triageOpenCount?: number;
    discourseCount?: number;
    evidenceCount?: number;
    estimatedReviewOutputTokens?: number;
  };
}

export interface KiraViewState {
  selectedTaskId: string | null;
  activeProjectName: string | null;
  previewMode: boolean;
}

export const STATUS_ORDER: KiraTaskStatus[] = [
  'todo',
  'in_progress',
  'in_review',
  'done',
  'blocked',
];

export const DEFAULT_VIEW_STATE: KiraViewState = {
  selectedTaskId: null,
  activeProjectName: null,
  previewMode: false,
};

function isStatus(value: unknown): value is KiraTaskStatus {
  return typeof value === 'string' && STATUS_ORDER.includes(value as KiraTaskStatus);
}

function parseRecord<T>(raw: unknown): T | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    return JSON.parse(raw) as T;
  }
  return raw as T;
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function normalizeRequirementTrace(value: unknown): KiraRequirementTraceItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): KiraRequirementTraceItem | null => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Partial<KiraRequirementTraceItem>;
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      const text = typeof raw.text === 'string' ? raw.text.trim() : '';
      if (!id || !text) return null;
      const status = typeof raw.status === 'string' ? raw.status : undefined;
      return {
        id,
        source: typeof raw.source === 'string' ? raw.source : 'brief',
        text,
        ...(status ? { status } : {}),
        evidence: normalizeStringList(raw.evidence),
      };
    })
    .filter((item): item is KiraRequirementTraceItem => item !== null);
}

function normalizePatchAlternatives(value: unknown): KiraPatchAlternative[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): KiraPatchAlternative | null => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Partial<KiraPatchAlternative>;
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (!name) return null;
      return {
        name,
        selected: raw.selected === true,
        rationale: typeof raw.rationale === 'string' ? raw.rationale.trim() : '',
        tradeoffs: normalizeStringList(raw.tradeoffs),
      };
    })
    .filter((item): item is KiraPatchAlternative => item !== null);
}

function normalizeFailureAnalysis(value: unknown): KiraFailureAnalysisItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): KiraFailureAnalysisItem | null => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Partial<KiraFailureAnalysisItem>;
      const command = typeof raw.command === 'string' ? raw.command.trim() : '';
      if (!command) return null;
      return {
        command,
        category: typeof raw.category === 'string' ? raw.category : 'unknown',
        summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
        guidance: typeof raw.guidance === 'string' ? raw.guidance.trim() : '',
        reproductionSteps: Array.isArray(raw.reproductionSteps)
          ? raw.reproductionSteps
              .map((step): KiraFailureReproductionStep | null => {
                if (!step || typeof step !== 'object') return null;
                const stepRaw = step as Partial<KiraFailureReproductionStep>;
                const stepCommand =
                  typeof stepRaw.command === 'string' ? stepRaw.command.trim() : '';
                if (!stepCommand) return null;
                return {
                  command: stepCommand,
                  reason: typeof stepRaw.reason === 'string' ? stepRaw.reason.trim() : '',
                  expectedSignal:
                    typeof stepRaw.expectedSignal === 'string' ? stepRaw.expectedSignal.trim() : '',
                };
              })
              .filter((step): step is KiraFailureReproductionStep => step !== null)
          : [],
      };
    })
    .filter((item): item is KiraFailureAnalysisItem => item !== null);
}

function normalizeReviewEvidenceChecked(value: unknown): KiraReviewEvidenceChecked[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Partial<KiraReviewEvidenceChecked>;
      const file = typeof raw.file === 'string' ? raw.file.trim() : '';
      if (!file) return null;
      return {
        file,
        reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
        method: typeof raw.method === 'string' ? raw.method.trim() : '',
      };
    })
    .filter((item): item is KiraReviewEvidenceChecked => item !== null);
}

function normalizeReviewAdversarialChecks(value: unknown): KiraReviewAdversarialCheck[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): KiraReviewAdversarialCheck | null => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Partial<KiraReviewAdversarialCheck>;
      const mode = typeof raw.mode === 'string' ? raw.mode.trim() : '';
      if (!mode) return null;
      return {
        mode,
        result: typeof raw.result === 'string' ? raw.result.trim() : 'failed',
        evidence: normalizeStringList(raw.evidence),
        ...(typeof raw.concern === 'string' && raw.concern.trim()
          ? { concern: raw.concern.trim() }
          : {}),
      };
    })
    .filter((item): item is KiraReviewAdversarialCheck => item !== null);
}

function normalizeDesignReviewGate(value: unknown): KiraDesignReviewGate | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<KiraDesignReviewGate>;
  const checks = Array.isArray(raw.checks)
    ? raw.checks
        .map((item): KiraDesignReviewCheck | null => {
          if (!item || typeof item !== 'object') return null;
          const check = item as Partial<KiraDesignReviewCheck>;
          const role = typeof check.role === 'string' ? check.role.trim() : '';
          if (!role) return null;
          return {
            role,
            verdict: typeof check.verdict === 'string' ? check.verdict.trim() : 'warn',
            concern: typeof check.concern === 'string' ? check.concern.trim() : '',
            evidence: normalizeStringList(check.evidence),
            requiredChanges: normalizeStringList(check.requiredChanges),
          };
        })
        .filter((item): item is KiraDesignReviewCheck => item !== null)
    : [];
  return {
    status: typeof raw.status === 'string' ? raw.status.trim() : undefined,
    summary: typeof raw.summary === 'string' ? raw.summary.trim() : undefined,
    checks,
    requiredChanges: normalizeStringList(raw.requiredChanges),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : undefined,
  };
}

function normalizeReviewerDiscourse(value: unknown): KiraReviewerDiscourseEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): KiraReviewerDiscourseEntry | null => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Partial<KiraReviewerDiscourseEntry>;
      const role = typeof raw.role === 'string' ? raw.role.trim() : '';
      const argument = typeof raw.argument === 'string' ? raw.argument.trim() : '';
      if (!role || !argument) return null;
      return {
        role,
        position: typeof raw.position === 'string' ? raw.position.trim() : 'challenge',
        argument,
        evidence: normalizeStringList(raw.evidence),
        ...(typeof raw.response === 'string' && raw.response.trim()
          ? { response: raw.response.trim() }
          : {}),
      };
    })
    .filter((item): item is KiraReviewerDiscourseEntry => item !== null);
}

function normalizeReviewTriage(value: unknown): KiraReviewFindingTriageItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): KiraReviewFindingTriageItem | null => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Partial<KiraReviewFindingTriageItem>;
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      const title = typeof raw.title === 'string' ? raw.title.trim() : '';
      if (!id || !title) return null;
      return {
        id,
        source: typeof raw.source === 'string' ? raw.source.trim() : 'review',
        status: typeof raw.status === 'string' ? raw.status.trim() : 'open',
        severity: typeof raw.severity === 'string' ? raw.severity.trim() : 'medium',
        title,
        ...(typeof raw.file === 'string' && raw.file.trim() ? { file: raw.file.trim() } : {}),
        line: typeof raw.line === 'number' && Number.isFinite(raw.line) ? raw.line : null,
        evidence: normalizeStringList(raw.evidence),
        owner: typeof raw.owner === 'string' ? raw.owner.trim() : 'worker',
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
      };
    })
    .filter((item): item is KiraReviewFindingTriageItem => item !== null);
}

function normalizeOrchestrationPlan(value: unknown): KiraOrchestrationPlan | undefined {
  const parsed = parseRecord<Partial<KiraOrchestrationPlan>>(value);
  if (!parsed?.runMode) return undefined;
  return {
    promptContractVersion:
      typeof parsed.promptContractVersion === 'number' &&
      Number.isFinite(parsed.promptContractVersion)
        ? parsed.promptContractVersion
        : 1,
    runMode: String(parsed.runMode),
    taskType: typeof parsed.taskType === 'string' ? parsed.taskType : 'generalist',
    workerCount: typeof parsed.workerCount === 'number' ? parsed.workerCount : 1,
    validationDepth:
      typeof parsed.validationDepth === 'string' ? parsed.validationDepth : 'standard',
    reviewDepth: typeof parsed.reviewDepth === 'string' ? parsed.reviewDepth : 'adversarial',
    approvalThreshold: typeof parsed.approvalThreshold === 'number' ? parsed.approvalThreshold : 80,
    subagentIds: normalizeStringList(parsed.subagentIds),
    workflowDag: normalizeWorkflowDag(parsed.workflowDag),
    runner: typeof parsed.runner === 'string' ? parsed.runner : 'local',
    connectors: normalizeStringList(parsed.connectors),
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    lanes: Array.isArray(parsed.lanes)
      ? parsed.lanes
          .map((lane): KiraOrchestrationPlan['lanes'][number] | null => {
            if (!lane || typeof lane !== 'object') return null;
            const raw = lane as Partial<KiraOrchestrationPlan['lanes'][number]>;
            return {
              id: typeof raw.id === 'string' ? raw.id : '',
              role: typeof raw.role === 'string' ? raw.role : '',
              goal: typeof raw.goal === 'string' ? raw.goal : '',
              ...(typeof raw.subagentId === 'string' ? { subagentId: raw.subagentId } : {}),
              toolScope: normalizeStringList(raw.toolScope),
              ...(typeof raw.modelHint === 'string' ? { modelHint: raw.modelHint } : {}),
              requiredEvidence: normalizeStringList(raw.requiredEvidence),
            };
          })
          .filter((lane): lane is KiraOrchestrationPlan['lanes'][number] => Boolean(lane?.id))
      : [],
    checkpoints: normalizeStringList(parsed.checkpoints),
    stopRules: normalizeStringList(parsed.stopRules),
    adaptiveAgentPlan: normalizeAdaptiveAgentPlan(parsed.adaptiveAgentPlan),
  };
}

function normalizeAdaptiveAgentPlan(value: unknown): KiraAdaptiveAgentPlan | undefined {
  const parsed = parseRecord<Partial<KiraAdaptiveAgentPlan>>(value);
  if (!parsed?.mode) return undefined;
  const alternativeWorker = parseRecord<
    Partial<KiraAdaptiveAgentPlan['alternativeWorker']>
  >(parsed.alternativeWorker);
  const integratorPolicy = parseRecord<
    Partial<KiraAdaptiveAgentPlan['integratorPolicy']>
  >(parsed.integratorPolicy);
  return {
    schemaVersion:
      typeof parsed.schemaVersion === 'number' && Number.isFinite(parsed.schemaVersion)
        ? parsed.schemaVersion
        : 1,
    mode: String(parsed.mode),
    alternativeWorker: {
      enabled: Boolean(alternativeWorker?.enabled),
      maxWorkers:
        typeof alternativeWorker?.maxWorkers === 'number' &&
        Number.isFinite(alternativeWorker.maxWorkers)
          ? alternativeWorker.maxWorkers
          : 1,
      isolation:
        typeof alternativeWorker?.isolation === 'string'
          ? alternativeWorker.isolation
          : 'not-applicable',
      reasons: normalizeStringList(alternativeWorker?.reasons),
    },
    stages: Array.isArray(parsed.stages)
      ? parsed.stages
          .map((stage): KiraAdaptiveAgentPlan['stages'][number] | null => {
            if (!stage || typeof stage !== 'object') return null;
            const raw = stage as Partial<KiraAdaptiveAgentPlan['stages'][number]>;
            const id = typeof raw.id === 'string' ? raw.id.trim() : '';
            if (!id) return null;
            return {
              id,
              role: typeof raw.role === 'string' ? raw.role : '',
              label: typeof raw.label === 'string' ? raw.label : id,
              activation: typeof raw.activation === 'string' ? raw.activation : 'always',
              dependsOn: normalizeStringList(raw.dependsOn),
              reason: typeof raw.reason === 'string' ? raw.reason : '',
              inputs: normalizeStringList(raw.inputs),
              outputs: normalizeStringList(raw.outputs),
              successCriteria: normalizeStringList(raw.successCriteria),
              toolScope: normalizeStringList(raw.toolScope),
              isolation: typeof raw.isolation === 'string' ? raw.isolation : 'not-applicable',
              ...(typeof raw.modelHint === 'string' ? { modelHint: raw.modelHint } : {}),
            };
          })
          .filter((stage): stage is KiraAdaptiveAgentPlan['stages'][number] => Boolean(stage))
      : [],
    successCriteria: normalizeStringList(parsed.successCriteria),
    verificationPlan: normalizeStringList(parsed.verificationPlan),
    integratorPolicy: {
      selection:
        typeof integratorPolicy?.selection === 'string'
          ? integratorPolicy.selection
          : 'single-winning-patch',
      mergeMode:
        typeof integratorPolicy?.mergeMode === 'string'
          ? integratorPolicy.mergeMode
          : 'apply-approved-attempt',
      conflictPolicy: normalizeStringList(integratorPolicy?.conflictPolicy),
      summaryRequirements: normalizeStringList(integratorPolicy?.summaryRequirements),
    },
    omittedRoles: Array.isArray(parsed.omittedRoles)
      ? parsed.omittedRoles
          .map((item): KiraAdaptiveAgentPlan['omittedRoles'][number] | null => {
            if (!item || typeof item !== 'object') return null;
            const raw = item as Partial<KiraAdaptiveAgentPlan['omittedRoles'][number]>;
            const role = typeof raw.role === 'string' ? raw.role.trim() : '';
            if (!role) return null;
            return {
              role,
              reason: typeof raw.reason === 'string' ? raw.reason : '',
            };
          })
          .filter((item): item is KiraAdaptiveAgentPlan['omittedRoles'][number] =>
            Boolean(item),
          )
      : [],
  };
}

function normalizeWorkflowDag(value: unknown): KiraWorkflowDag | undefined {
  const parsed = parseRecord<Partial<KiraWorkflowDag>>(value);
  if (!parsed) return undefined;
  const nodes = Array.isArray(parsed.nodes)
    ? parsed.nodes
        .map((node): KiraWorkflowDag['nodes'][number] | null => {
          if (!node || typeof node !== 'object') return null;
          const raw = node as Partial<KiraWorkflowDag['nodes'][number]>;
          const id = typeof raw.id === 'string' ? raw.id.trim() : '';
          if (!id) return null;
          return {
            id,
            label: typeof raw.label === 'string' ? raw.label : id,
            kind: typeof raw.kind === 'string' ? raw.kind : 'plan',
            required: raw.required !== false,
          };
        })
        .filter((node): node is KiraWorkflowDag['nodes'][number] => node !== null)
    : [];
  return {
    nodes,
    edges: Array.isArray(parsed.edges)
      ? parsed.edges
          .map((edge): KiraWorkflowDag['edges'][number] | null => {
            if (!edge || typeof edge !== 'object') return null;
            const raw = edge as Partial<KiraWorkflowDag['edges'][number]>;
            const from = typeof raw.from === 'string' ? raw.from.trim() : '';
            const to = typeof raw.to === 'string' ? raw.to.trim() : '';
            if (!from || !to) return null;
            return {
              from,
              to,
              condition:
                typeof raw.condition === 'string' ? raw.condition : 'previous stage passed',
            };
          })
          .filter((edge): edge is KiraWorkflowDag['edges'][number] => edge !== null)
      : [],
    criticalPath: normalizeStringList(parsed.criticalPath),
  };
}

function normalizeEvidenceLedger(value: unknown): KiraEvidenceLedger | undefined {
  const parsed = parseRecord<Partial<KiraEvidenceLedger>>(value);
  if (!parsed?.approvalReadiness) return undefined;
  return {
    items: Array.isArray(parsed.items)
      ? parsed.items
          .map((item): KiraEvidenceLedger['items'][number] | null => {
            if (!item || typeof item !== 'object') return null;
            const raw = item as Partial<KiraEvidenceLedger['items'][number]>;
            const id = typeof raw.id === 'string' ? raw.id : '';
            if (!id) return null;
            return {
              id,
              kind: typeof raw.kind === 'string' ? raw.kind : 'manual',
              status: typeof raw.status === 'string' ? raw.status : 'info',
              summary: typeof raw.summary === 'string' ? raw.summary : '',
              ...(typeof raw.target === 'string' ? { target: raw.target } : {}),
              evidence: normalizeStringList(raw.evidence),
              createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : 'kira',
              confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.5,
              createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
            };
          })
          .filter((item): item is KiraEvidenceLedger['items'][number] => item !== null)
      : [],
    approvalReadiness: {
      score:
        typeof parsed.approvalReadiness.score === 'number' ? parsed.approvalReadiness.score : 0,
      status:
        typeof parsed.approvalReadiness.status === 'string'
          ? parsed.approvalReadiness.status
          : 'needs_evidence',
      blockers: normalizeStringList(parsed.approvalReadiness.blockers),
      missingEvidence: normalizeStringList(parsed.approvalReadiness.missingEvidence),
      requiredEvidenceCount:
        typeof parsed.approvalReadiness.requiredEvidenceCount === 'number'
          ? parsed.approvalReadiness.requiredEvidenceCount
          : 1,
      observedEvidenceCount:
        typeof parsed.approvalReadiness.observedEvidenceCount === 'number'
          ? parsed.approvalReadiness.observedEvidenceCount
          : 0,
    },
  };
}

function normalizeDiffReviewCoverage(value: unknown): KiraDiffReviewCoverage | undefined {
  const parsed = parseRecord<Partial<KiraDiffReviewCoverage>>(value);
  if (!parsed) return undefined;
  return {
    changedLineCount: typeof parsed.changedLineCount === 'number' ? parsed.changedLineCount : 0,
    anchoredFindingCount:
      typeof parsed.anchoredFindingCount === 'number' ? parsed.anchoredFindingCount : 0,
    unanchoredFindingCount:
      typeof parsed.unanchoredFindingCount === 'number' ? parsed.unanchoredFindingCount : 0,
    filesWithChangedLines: normalizeStringList(parsed.filesWithChangedLines),
    filesCoveredByReview: normalizeStringList(parsed.filesCoveredByReview),
    coverageRatio: typeof parsed.coverageRatio === 'number' ? parsed.coverageRatio : 0,
    issues: normalizeStringList(parsed.issues),
  };
}

function normalizeIntegrationRecord(value: unknown): KiraIntegrationRecord | undefined {
  const parsed = parseRecord<Partial<KiraIntegrationRecord>>(value);
  if (!parsed?.status) return undefined;
  return {
    status: String(parsed.status),
    message: typeof parsed.message === 'string' ? parsed.message : '',
    ...(typeof parsed.commitHash === 'string' ? { commitHash: parsed.commitHash } : {}),
    ...(typeof parsed.pullRequestUrl === 'string' ? { pullRequestUrl: parsed.pullRequestUrl } : {}),
    connectors: Array.isArray(parsed.connectors)
      ? parsed.connectors
          .map((item): KiraConnectorEvidence | null => {
            const raw = parseRecord<Partial<KiraConnectorEvidence>>(item);
            if (!raw?.connectorId) return null;
            return {
              connectorId: String(raw.connectorId),
              status: typeof raw.status === 'string' ? raw.status : 'observed',
              summary: typeof raw.summary === 'string' ? raw.summary : '',
              ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
              checks: normalizeStringList(raw.checks),
              evidence: normalizeStringList(raw.evidence),
            };
          })
          .filter((item): item is KiraConnectorEvidence => item !== null)
      : [],
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
  };
}

function normalizeClarificationStatus(value: unknown): WorkClarificationStatus {
  return value === 'pending' || value === 'answered' || value === 'cleared' ? value : 'cleared';
}

function buildFallbackClarificationQuestion(): WorkClarificationQuestion {
  return {
    id: 'q-1',
    question:
      'Kira could not load the clarification questions for this work. What should be clarified or changed before a worker starts?',
    options: [],
    allowCustomAnswer: true,
  };
}

function normalizeClarificationQuestionId(
  rawId: unknown,
  index: number,
  usedIds: Set<string>,
): string {
  const fallbackId = `q-${index + 1}`;
  let nextId = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : fallbackId;
  if (usedIds.has(nextId)) nextId = fallbackId;
  let suffix = 2;
  while (usedIds.has(nextId)) {
    nextId = `${fallbackId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(nextId);
  return nextId;
}

function normalizeClarificationQuestions(value: unknown): WorkClarificationQuestion[] {
  if (!Array.isArray(value)) return [];
  const usedIds = new Set<string>();
  return value
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Partial<WorkClarificationQuestion>;
      const question = typeof raw.question === 'string' ? raw.question.trim() : '';
      if (!question) return null;
      const options = normalizeStringList(raw.options)
        .map((option) => option.trim())
        .filter(Boolean)
        .slice(0, 5);
      return {
        id: normalizeClarificationQuestionId(raw.id, index, usedIds),
        question,
        options,
        allowCustomAnswer: options.length === 0 || raw.allowCustomAnswer !== false,
      };
    })
    .filter((item): item is WorkClarificationQuestion => item !== null);
}

function normalizeClarificationAnswers(value: unknown): WorkClarificationAnswer[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Partial<WorkClarificationAnswer>;
      const questionId = typeof raw.questionId === 'string' ? raw.questionId.trim() : '';
      const question = typeof raw.question === 'string' ? raw.question.trim() : '';
      const answer = typeof raw.answer === 'string' ? raw.answer.trim() : '';
      if (!questionId || !question || !answer) return null;
      return { questionId, question, answer };
    })
    .filter((item): item is WorkClarificationAnswer => item !== null);
}

function normalizeWorkClarification(value: unknown): WorkClarificationState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<WorkClarificationState>;
  const briefHash = typeof raw.briefHash === 'string' ? raw.briefHash.trim() : '';
  if (!briefHash) return undefined;
  const answers = normalizeClarificationAnswers(raw.answers);
  const status = normalizeClarificationStatus(raw.status);
  const questions = normalizeClarificationQuestions(raw.questions);

  return {
    status,
    briefHash,
    summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
    questions:
      status === 'pending' && questions.length === 0
        ? [buildFallbackClarificationQuestion()]
        : questions,
    ...(answers.length > 0 ? { answers } : {}),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    ...(typeof raw.answeredAt === 'number' ? { answeredAt: raw.answeredAt } : {}),
  };
}

function normalizeReviewFindings(value: unknown): KiraReviewRecord['findings'] {
  if (!Array.isArray(value)) return [];
  return value
    .map((finding) => {
      if (!finding || typeof finding !== 'object') return null;
      const raw = finding as Partial<KiraReviewRecord['findings'][number]>;
      const message = typeof raw.message === 'string' ? raw.message.trim() : '';
      if (!message) return null;
      return {
        file: typeof raw.file === 'string' ? raw.file : '',
        line: typeof raw.line === 'number' && Number.isFinite(raw.line) ? raw.line : null,
        severity:
          raw.severity === 'low' || raw.severity === 'medium' || raw.severity === 'high'
            ? raw.severity
            : 'medium',
        message,
      };
    })
    .filter((finding): finding is KiraReviewRecord['findings'][number] => finding !== null);
}

export function normalizeWorkTask(raw: unknown): WorkTask | null {
  const parsed = parseRecord<Partial<WorkTask>>(raw);
  if (!parsed?.id) return null;

  const now = Date.now();
  const clarification = normalizeWorkClarification(parsed.clarification);

  return {
    id: parsed.id,
    type: 'work',
    projectName: parsed.projectName?.trim() || '',
    title: parsed.title?.trim() || 'Untitled work',
    description: parsed.description ?? '',
    status: isStatus(parsed.status) ? parsed.status : 'todo',
    assignee: parsed.assignee ?? '',
    ...(clarification ? { clarification } : {}),
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : now,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : now,
  };
}

export function normalizeTaskComment(raw: unknown): TaskComment | null {
  const parsed = parseRecord<Partial<TaskComment>>(raw);
  if (!parsed?.id || !parsed.taskId || !parsed.body) return null;

  return {
    id: parsed.id,
    taskId: parsed.taskId,
    taskType: 'work',
    author: parsed.author?.trim() || 'Operator',
    body: parsed.body.trim(),
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
  };
}

function extractBulletedCommentSection(body: string, sectionTitle: string): string[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const normalizedTitle = sectionTitle.trim().toLowerCase();
  const items: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inSection) {
      if (trimmed.replace(/:$/, '').toLowerCase() === normalizedTitle) {
        inSection = true;
      }
      continue;
    }

    if (!trimmed) {
      if (items.length > 0) break;
      continue;
    }

    if (items.length > 0 && /^[A-Za-z][A-Za-z0-9 /_-]{0,80}:$/.test(trimmed)) {
      break;
    }

    if (trimmed.startsWith('- ')) {
      items.push(trimmed.slice(2).trim());
      continue;
    }

    if (items.length === 0) {
      items.push(trimmed);
    }
  }

  return [...new Set(items.filter(Boolean))].slice(0, 12);
}

export function extractRetryFeedbackFromCommentBody(body: string): string[] {
  return extractBulletedCommentSection(body, 'Retry with feedback');
}

export function findLatestRetryFeedback(comments: TaskComment[]): string[] {
  for (const comment of [...comments].sort((a, b) => b.createdAt - a.createdAt)) {
    const feedback = extractRetryFeedbackFromCommentBody(comment.body);
    if (feedback.length > 0) return feedback;
  }
  return [];
}

export function normalizeKiraAttempt(raw: unknown): KiraAttemptRecord | null {
  const parsed = parseRecord<Partial<KiraAttemptRecord>>(raw);
  if (!parsed?.id || !parsed.workId) return null;
  return {
    recordVersion:
      typeof parsed.recordVersion === 'number' && Number.isFinite(parsed.recordVersion)
        ? parsed.recordVersion
        : 1,
    migratedFromVersion:
      typeof parsed.migratedFromVersion === 'number' && Number.isFinite(parsed.migratedFromVersion)
        ? parsed.migratedFromVersion
        : undefined,
    id: parsed.id,
    workId: parsed.workId,
    attemptNo: typeof parsed.attemptNo === 'number' ? parsed.attemptNo : 0,
    status: parsed.status ?? 'unknown',
    startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
    finishedAt: typeof parsed.finishedAt === 'number' ? parsed.finishedAt : 0,
    changedFiles: normalizeStringList(parsed.changedFiles),
    commandsRun: normalizeStringList(parsed.commandsRun),
    outOfPlanFiles: normalizeStringList(parsed.outOfPlanFiles),
    validationGaps: normalizeStringList(parsed.validationGaps),
    risks: normalizeStringList(parsed.risks),
    changeDesign: parsed.changeDesign,
    diffHunkReview: Array.isArray(parsed.diffHunkReview) ? parsed.diffHunkReview : [],
    validationPlan: parsed.validationPlan,
    diffStats: parsed.diffStats,
    observability: parsed.observability,
    failureAnalysis: normalizeFailureAnalysis(parsed.failureAnalysis),
    runtimeValidation: parsed.runtimeValidation,
    riskPolicy: parsed.riskPolicy,
    semanticGraph: Array.isArray(parsed.semanticGraph) ? parsed.semanticGraph : [],
    testImpact: Array.isArray(parsed.testImpact) ? parsed.testImpact : [],
    reviewAdversarialPlan: parsed.reviewAdversarialPlan,
    patchIntentVerification: parsed.patchIntentVerification,
    clarificationGate: parsed.clarificationGate,
    reviewerCalibration: parsed.reviewerCalibration,
    designReviewGate: normalizeDesignReviewGate(parsed.designReviewGate),
    orchestrationPlan: normalizeOrchestrationPlan(parsed.orchestrationPlan),
    evidenceLedger: normalizeEvidenceLedger(parsed.evidenceLedger),
    integration: normalizeIntegrationRecord(parsed.integration),
    requirementTrace: normalizeRequirementTrace(parsed.requirementTrace),
    approachAlternatives: normalizePatchAlternatives(parsed.approachAlternatives),
    diffExcerpts: normalizeStringList(parsed.diffExcerpts),
    blockedReason: typeof parsed.blockedReason === 'string' ? parsed.blockedReason : undefined,
    rollbackFiles: normalizeStringList(parsed.rollbackFiles),
    workerPlan: parsed.workerPlan,
    validationReruns: parsed.validationReruns,
    preflightExploration: Array.isArray(parsed.preflightExploration)
      ? normalizeStringList(parsed.preflightExploration)
      : [],
    readFiles: normalizeStringList(parsed.readFiles),
    patchedFiles: normalizeStringList(parsed.patchedFiles),
  };
}

export function normalizeKiraReview(raw: unknown): KiraReviewRecord | null {
  const parsed = parseRecord<Partial<KiraReviewRecord>>(raw);
  if (!parsed?.id || !parsed.workId) return null;
  return {
    recordVersion:
      typeof parsed.recordVersion === 'number' && Number.isFinite(parsed.recordVersion)
        ? parsed.recordVersion
        : 1,
    migratedFromVersion:
      typeof parsed.migratedFromVersion === 'number' && Number.isFinite(parsed.migratedFromVersion)
        ? parsed.migratedFromVersion
        : undefined,
    id: parsed.id,
    workId: parsed.workId,
    attemptNo: typeof parsed.attemptNo === 'number' ? parsed.attemptNo : 0,
    approved: Boolean(parsed.approved),
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
    summary: parsed.summary ?? '',
    findings: normalizeReviewFindings(parsed.findings),
    missingValidation: normalizeStringList(parsed.missingValidation),
    nextWorkerInstructions: normalizeStringList(parsed.nextWorkerInstructions),
    residualRisk: normalizeStringList(parsed.residualRisk),
    filesChecked: normalizeStringList(parsed.filesChecked),
    evidenceChecked: normalizeReviewEvidenceChecked(parsed.evidenceChecked),
    requirementVerdicts: normalizeRequirementTrace(parsed.requirementVerdicts),
    adversarialChecks: normalizeReviewAdversarialChecks(parsed.adversarialChecks),
    reviewerDiscourse: normalizeReviewerDiscourse(parsed.reviewerDiscourse),
    triage: normalizeReviewTriage(parsed.triage),
    diffCoverage: normalizeDiffReviewCoverage(parsed.diffCoverage),
    reviewAdversarialPlan: parsed.reviewAdversarialPlan,
    attemptSynthesis: parsed.attemptSynthesis,
    observability: parsed.observability,
  };
}

export function getWorkFilePath(workId: string): string {
  return `/works/${workId}.json`;
}

export function getCommentFilePath(commentId: string): string {
  return `/comments/${commentId}.json`;
}

export function sortByUpdatedAtDesc<T extends { updatedAt: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function sortByCreatedAtAsc<T extends { createdAt: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.createdAt - b.createdAt);
}

export function sortByCreatedAtDesc<T extends { createdAt: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.createdAt - a.createdAt);
}

export function buildExcerpt(text: string, maxLength = 140): string {
  const plain = text
    .replace(/[#>*`~_[\]()!-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!plain) return '';
  return plain.length > maxLength ? `${plain.slice(0, maxLength)}...` : plain;
}

export function matchesProjectName(
  taskProjectName: string | null | undefined,
  activeProjectName: string | null,
): boolean {
  if (!activeProjectName) return true;
  return !taskProjectName || taskProjectName === activeProjectName;
}

export function groupWorksByStatus(works: WorkTask[]): Record<KiraTaskStatus, WorkTask[]> {
  return STATUS_ORDER.reduce(
    (acc, status) => {
      acc[status] = works.filter((work) => work.status === status);
      return acc;
    },
    {
      todo: [] as WorkTask[],
      in_progress: [] as WorkTask[],
      in_review: [] as WorkTask[],
      blocked: [] as WorkTask[],
      done: [] as WorkTask[],
    },
  );
}

export function formatTimestamp(timestamp: number, language: string): string {
  const locale = language.startsWith('zh') ? 'zh-CN' : 'en-US';
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}
