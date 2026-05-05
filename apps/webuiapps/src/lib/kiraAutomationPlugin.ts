import * as fs from 'fs';
import * as net from 'net';
import { execFile as execFileCallback, spawn } from 'child_process';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { basename, dirname, join, resolve } from 'path';
import type { Plugin } from 'vite';

const execFileAsync = promisify(execFileCallback);

type LLMProvider =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'llama.cpp'
  | 'minimax'
  | 'z.ai'
  | 'kimi'
  | 'openrouter'
  | 'opencode'
  | 'opencode-go'
  | 'codex-cli';

type LLMApiStyle = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

type KiraTaskStatus = 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done';
type WorkClarificationStatus = 'pending' | 'answered' | 'cleared';

interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  customHeaders?: string;
  command?: string;
  apiStyle?: LLMApiStyle;
  name?: string;
}

interface KiraSettings {
  workRootDirectory?: string;
  workerModel?: string;
  reviewerModel?: string;
  workers?: Array<Partial<LLMConfig>>;
  workerLlm?: Partial<LLMConfig>;
  reviewerLlm?: Partial<LLMConfig>;
  projectDefaults?: KiraProjectSettings;
}

interface WorkTask {
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

interface WorkClarificationQuestion {
  id: string;
  question: string;
  options: string[];
  allowCustomAnswer: boolean;
}

interface WorkClarificationAnswer {
  questionId: string;
  question: string;
  answer: string;
}

interface WorkClarificationState {
  status: WorkClarificationStatus;
  briefHash: string;
  summary: string;
  questions: WorkClarificationQuestion[];
  answers?: WorkClarificationAnswer[];
  createdAt: number;
  answeredAt?: number;
}

interface WorkClarificationAnalysis {
  needsClarification: boolean;
  confidence: number;
  summary: string;
  questions: WorkClarificationQuestion[];
}

interface TaskComment {
  id: string;
  taskId: string;
  taskType: 'work';
  author: string;
  body: string;
  createdAt: number;
}

interface AutomationLockRecord {
  ownerId: string;
  resource: 'project' | 'work';
  sessionPath: string;
  targetKey: string;
  acquiredAt: number;
  heartbeatAt: number;
}

interface WorkerSummary {
  summary: string;
  filesChanged: string[];
  testsRun: string[];
  remainingRisks: string[];
  selfCheck?: WorkerSelfCheck;
}

interface DiffHunkReview {
  file: string;
  intent: string;
  risk: string;
}

interface WorkerSelfCheck {
  reviewedDiff: boolean;
  followedProjectInstructions: boolean;
  matchedPlan: boolean;
  ranOrExplainedValidation: boolean;
  diffHunkReview: DiffHunkReview[];
  requirementTrace: RequirementTraceItem[];
  uncertainty: string[];
  notes: string[];
}

interface ChangeDesign {
  targetFiles: string[];
  invariants: string[];
  expectedImpact: string[];
  validationStrategy: string[];
  rollbackStrategy: string[];
}

interface WorkDecompositionRecommendation {
  shouldSplit: boolean;
  confidence: number;
  reason: string;
  suggestedWorks: string[];
  signals: string[];
}

type KiraTaskType =
  | 'frontend-ui'
  | 'backend-api'
  | 'test-validation'
  | 'tooling-config'
  | 'docs-maintainer'
  | 'data-migration'
  | 'security-auth'
  | 'generalist';

interface TaskPlaybook {
  taskType: KiraTaskType;
  confidence: number;
  inspectFocus: string[];
  validationFocus: string[];
  reviewChecklist: string[];
  riskSignals: string[];
}

interface DependencyInsight {
  file: string;
  imports: string[];
  importedBy: string[];
  nearbyTests: string[];
}

interface RequirementTraceItem {
  id: string;
  source: 'brief' | 'project-instruction' | 'change-design' | 'review';
  text: string;
  status?: 'planned' | 'satisfied' | 'partial' | 'blocked' | 'not_applicable';
  evidence: string[];
}

interface PatchAlternative {
  name: string;
  selected: boolean;
  rationale: string;
  tradeoffs: string[];
}

interface EscalationSignal {
  severity: 'low' | 'medium' | 'high';
  reason: string;
  suggestedQuestion: string;
}

interface UncertaintyEscalation {
  shouldAsk: boolean;
  questions: string[];
  blockers: string[];
}

interface RiskReviewPolicy {
  level: 'low' | 'medium' | 'high';
  reasons: string[];
  evidenceMinimum: number;
  requiresRuntimeValidation: boolean;
  requiresSecondPass: boolean;
}

interface RuntimeValidationSignal {
  applicable: boolean;
  reason: string;
  suggestedUrls: string[];
}

type SemanticGraphNodeRole = 'source' | 'test' | 'entrypoint' | 'config' | 'doc' | 'unknown';

interface SemanticGraphNode {
  file: string;
  role: SemanticGraphNodeRole;
  imports: string[];
  exports: string[];
  symbols: string[];
  dependents: string[];
  tests: string[];
}

interface TestImpactTarget {
  file: string;
  impactedTests: string[];
  commands: string[];
  rationale: string;
  confidence: number;
}

type ReviewerAdversarialMode =
  | 'correctness'
  | 'regression'
  | 'security'
  | 'runtime-ux'
  | 'data-safety'
  | 'integration'
  | 'maintainability';

interface ReviewAdversarialPlan {
  modes: ReviewerAdversarialMode[];
  rationale: string[];
  requiredEvidence: string[];
}

interface ReviewAdversarialCheck {
  mode: ReviewerAdversarialMode;
  result: 'passed' | 'failed' | 'not_applicable';
  evidence: string[];
  concern?: string;
}

interface RuntimeValidationResult {
  checked: boolean;
  applicable: boolean;
  serverDetected: boolean;
  url: string | null;
  status: 'skipped' | 'not_running' | 'reachable';
  notes: string[];
  httpStatus?: number;
  contentType?: string;
  title?: string;
  bodySnippet?: string;
  evidence: string[];
}

interface FailureReproductionStep {
  command: string;
  reason: string;
  expectedSignal: string;
}

interface FailureAnalysis {
  command: string;
  category:
    | 'typecheck'
    | 'unit-test'
    | 'lint'
    | 'build'
    | 'runtime'
    | 'environment'
    | 'safety'
    | 'unknown';
  summary: string;
  guidance: string;
  reproductionSteps: FailureReproductionStep[];
}

interface ScoredMemorySignal {
  text: string;
  score: number;
  hits: number;
  source: 'review' | 'validation' | 'pattern' | 'guidance' | 'success';
  lastSeenAt: number;
}

interface FailureMemoryCluster {
  signature: string;
  category: FailureAnalysis['category'] | 'review' | 'policy';
  hits: number;
  lastSeenAt: number;
  commands: string[];
  remediation: string[];
  examples: string[];
  staleScore: number;
}

type KiraRunMode = 'quick' | 'standard' | 'deep';

interface KiraRulePackSetting {
  id: string;
  enabled: boolean;
}

type KiraPolicyEvent =
  | 'before_tool'
  | 'after_tool'
  | 'before_validation'
  | 'before_integration'
  | 'task_completed';

type KiraPolicyDecision = 'allow' | 'warn' | 'block' | 'defer';

interface KiraPolicyRule {
  id: string;
  event: KiraPolicyEvent;
  enabled: boolean;
  decision: KiraPolicyDecision;
  message: string;
  toolNames: string[];
  pathPatterns: string[];
  commandPatterns: string[];
  riskLevels: Array<RiskReviewPolicy['level']>;
}

interface KiraExecutionPolicy {
  mode: 'balanced' | 'locked-down' | 'permissive';
  maxChangedFiles: number;
  maxDiffLines: number;
  protectedPaths: string[];
  commandAllowlist: string[];
  commandDenylist: string[];
  requireValidation: boolean;
  requireReviewerEvidence: boolean;
  rules: KiraPolicyRule[];
}

interface KiraEnvironmentContract {
  runner: 'local' | 'remote-command' | 'cloud';
  setupCommands: string[];
  validationCommands: string[];
  requiredEnv: string[];
  allowedNetwork: 'none' | 'localhost' | 'public';
  secretsPolicy: 'local-only' | 'masked' | 'unrestricted';
  windowsMode: 'auto' | 'native-powershell' | 'wsl';
  remoteCommand: string;
  devServerCommand: string;
}

interface KiraSubagentDefinition {
  id: string;
  label: string;
  profile: string;
  description: string;
  tools: string[];
  requiredEvidence: string[];
  modelHint: string;
  enabled: boolean;
}

interface KiraWorkflowDagNode {
  id: string;
  label: string;
  kind: 'plan' | 'implement' | 'validate' | 'review' | 'integrate' | 'blocked' | 'done';
  required: boolean;
}

interface KiraWorkflowDagEdge {
  from: string;
  to: string;
  condition: string;
}

interface KiraWorkflowDag {
  nodes: KiraWorkflowDagNode[];
  edges: KiraWorkflowDagEdge[];
  criticalPath: string[];
}

interface KiraPluginConnector {
  id: string;
  label: string;
  type: 'github' | 'linear' | 'slack' | 'mcp' | 'custom';
  enabled: boolean;
  capabilities: string[];
  policy: 'observe' | 'suggest' | 'apply';
}

interface KiraQualitySnapshot {
  attemptsTotal: number;
  approvedAttempts: number;
  validationFailures: number;
  reviewRejections: number;
  rollbacks: number;
  averageReadinessScore: number;
  passRate: number;
  topFailureCategories: string[];
}

interface KiraRulePackDefinition {
  id: string;
  label: string;
  description: string;
  instructions: string[];
}

interface OrchestrationPlan {
  promptContractVersion: number;
  runMode: KiraRunMode;
  taskType: KiraTaskType;
  workerCount: number;
  validationDepth: 'focused' | 'standard' | 'deep';
  reviewDepth: 'focused' | 'adversarial' | 'evidence-heavy';
  approvalThreshold: number;
  subagentIds: string[];
  workflowDag: KiraWorkflowDag;
  runner: KiraEnvironmentContract['runner'];
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
}

interface ManualEvidenceItem {
  id: string;
  kind: 'manual' | 'test' | 'runtime' | 'review' | 'risk-acceptance';
  author: string;
  summary: string;
  riskAccepted: boolean;
  createdAt: number;
}

interface EvidenceLedgerItem {
  id: string;
  kind:
    | 'plan'
    | 'diff'
    | 'validation'
    | 'runtime'
    | 'intent'
    | 'review'
    | 'manual'
    | 'risk-acceptance'
    | 'design'
    | 'policy'
    | 'environment'
    | 'workflow'
    | 'connectors';
  status: 'pass' | 'warn' | 'fail' | 'info';
  summary: string;
  target?: string;
  evidence: string[];
  createdBy: 'kira' | 'worker' | 'reviewer' | 'operator';
  confidence: number;
  createdAt: number;
}

interface ApprovalReadiness {
  score: number;
  status: 'ready' | 'needs_evidence' | 'blocked';
  blockers: string[];
  missingEvidence: string[];
  requiredEvidenceCount: number;
  observedEvidenceCount: number;
}

interface EvidenceLedger {
  items: EvidenceLedgerItem[];
  approvalReadiness: ApprovalReadiness;
}

interface EnvironmentExecutionSummary {
  setup: ValidationRerunSummary;
  remote: {
    declared: boolean;
    commandTemplate: string;
    status: 'not_declared' | 'validated' | 'blocked' | 'failed' | 'skipped';
    probes: string[];
    notes: string[];
  };
  devServer: {
    declared: boolean;
    command: string;
    status: 'not_declared' | 'validated' | 'blocked' | 'skipped';
    notes: string[];
  };
}

interface KiraConnectorEvidence {
  connectorId: string;
  status: 'observed' | 'suggested' | 'applied' | 'skipped' | 'failed';
  summary: string;
  url?: string;
  checks: string[];
  evidence: string[];
}

interface KiraIntegrationRecord {
  status: 'committed' | 'integrated' | 'skipped' | 'failed';
  message: string;
  commitHash?: string;
  pullRequestUrl?: string;
  connectors: KiraConnectorEvidence[];
  createdAt: number;
}

interface DiffReviewCoverage {
  changedLineCount: number;
  anchoredFindingCount: number;
  unanchoredFindingCount: number;
  filesWithChangedLines: string[];
  filesCoveredByReview: string[];
  coverageRatio: number;
  issues: string[];
}

interface PatchIntentVerification {
  status: 'aligned' | 'drift' | 'unknown';
  confidence: number;
  checkedFiles: string[];
  evidence: string[];
  issues: string[];
}

interface AttemptSynthesisRecommendation {
  canSynthesize: boolean;
  summary: string;
  candidateParts: string[];
  risks: string[];
}

interface ClarificationQualityGate {
  decision: 'proceed' | 'needs_clarification' | 'split' | 'blocked';
  confidence: number;
  reasons: string[];
  questions: string[];
}

interface ReviewerCalibration {
  strictness: 'normal' | 'heightened' | 'evidence-heavy';
  reasons: string[];
  focusMemories: string[];
  evidenceMinimum: number;
}

type DesignReviewRole = 'product' | 'architecture' | 'validation' | 'risk' | 'integration';

interface DesignReviewCheck {
  role: DesignReviewRole;
  verdict: 'pass' | 'warn' | 'block';
  concern: string;
  evidence: string[];
  requiredChanges: string[];
}

interface DesignReviewGate {
  status: 'passed' | 'warning' | 'blocked';
  summary: string;
  checks: DesignReviewCheck[];
  requiredChanges: string[];
  createdAt: number;
}

interface ReviewEvidenceChecked {
  file: string;
  reason: string;
  method: string;
}

interface ReviewerDiscourseEntry {
  role: ReviewerAdversarialMode | 'design-gate' | 'validation';
  position: 'support' | 'challenge' | 'resolved';
  argument: string;
  evidence: string[];
  response?: string;
}

interface WorkerExecutionPlan {
  valid: boolean;
  parseIssues: string[];
  understanding: string;
  repoFindings: string[];
  summary: string;
  intendedFiles: string[];
  protectedFiles: string[];
  validationCommands: string[];
  riskNotes: string[];
  stopConditions: string[];
  confidence: number;
  uncertainties: string[];
  decomposition: WorkDecompositionRecommendation;
  workerProfile: string;
  changeDesign: ChangeDesign;
  taskType: KiraTaskType;
  requirementTrace: RequirementTraceItem[];
  approachAlternatives: PatchAlternative[];
  escalation: UncertaintyEscalation;
}

interface KiraProjectProfile {
  schemaVersion: number;
  projectName: string;
  projectRoot: string;
  generatedAt: number;
  updatedAt: number;
  repoMap: {
    topLevelDirectories: string[];
    sourceRoots: string[];
    testRoots: string[];
    docs: string[];
    configFiles: string[];
    entrypoints: string[];
  };
  conventions: {
    packageManager: string | null;
    scripts: string[];
    styleSignals: string[];
    architectureNotes: string[];
  };
  validation: {
    candidateCommands: string[];
    testFiles: string[];
    notes: string[];
  };
  risk: {
    highRiskFiles: string[];
    generatedPaths: string[];
    concurrencyNotes: string[];
  };
  workers: {
    recommendedProfiles: string[];
    specializationHints: string[];
  };
  decomposition: {
    hints: string[];
    lastRecommendations: string[];
  };
  orchestration?: {
    subagents: KiraSubagentDefinition[];
    workflowDag: KiraWorkflowDag;
    pluginConnectors: KiraPluginConnector[];
    environment: KiraEnvironmentContract;
    executionPolicy: KiraExecutionPolicy;
    quality: KiraQualitySnapshot;
  };
  learning: {
    recentReviewFailures: string[];
    recentValidationFailures: string[];
    repeatedPatterns: string[];
    workerGuidanceRules: string[];
    successfulPatterns: string[];
    scoredMemories: ScoredMemorySignal[];
    failureClusters: FailureMemoryCluster[];
    lastUpdatedAt?: number;
  };
}

interface ProjectContextScan {
  projectRoot: string;
  packageManager: string | null;
  workspaceFiles: string[];
  packageScripts: string[];
  existingChanges: string[];
  searchTerms: string[];
  likelyFiles: string[];
  relatedDocs: string[];
  testFiles: string[];
  candidateChecks: string[];
  notes: string[];
  projectProfile?: KiraProjectProfile | null;
  profileSummary?: string[];
  recentFeedback?: string[];
  decomposition?: WorkDecompositionRecommendation;
  workerProfile?: string;
  taskPlaybook?: TaskPlaybook;
  dependencyMap?: DependencyInsight[];
  semanticGraph?: SemanticGraphNode[];
  testImpact?: TestImpactTarget[];
  requirementTrace?: RequirementTraceItem[];
  riskPolicy?: RiskReviewPolicy;
  reviewAdversarialPlan?: ReviewAdversarialPlan;
  runtimeValidation?: RuntimeValidationSignal;
  escalationSignals?: EscalationSignal[];
  clarificationGate?: ClarificationQualityGate;
  reviewerCalibration?: ReviewerCalibration;
  designReviewGate?: DesignReviewGate;
  orchestrationPlan?: OrchestrationPlan;
  subagentRegistry?: KiraSubagentDefinition[];
  workflowDag?: KiraWorkflowDag;
  executionPolicy?: KiraExecutionPolicy;
  environmentContract?: KiraEnvironmentContract;
  environmentExecution?: EnvironmentExecutionSummary;
  pluginConnectors?: KiraPluginConnector[];
  qualitySnapshot?: KiraQualitySnapshot;
  manualEvidence?: ManualEvidenceItem[];
}

interface ReviewSummary {
  approved: boolean;
  summary: string;
  issues: string[];
  filesChecked: string[];
  findings: ReviewFinding[];
  missingValidation: string[];
  nextWorkerInstructions: string[];
  residualRisk: string[];
  evidenceChecked: ReviewEvidenceChecked[];
  requirementVerdicts: RequirementTraceItem[];
  adversarialChecks: ReviewAdversarialCheck[];
  reviewerDiscourse: ReviewerDiscourseEntry[];
}

interface ReviewFinding {
  file: string;
  line: number | null;
  severity: 'low' | 'medium' | 'high';
  message: string;
}

interface ReviewFindingTriageItem {
  id: string;
  source: 'review' | 'validation' | 'runtime' | 'design' | 'intent';
  status: 'open' | 'fixed' | 'acknowledged' | 'dismissed';
  severity: ReviewFinding['severity'];
  title: string;
  file?: string;
  line?: number | null;
  evidence: string[];
  owner: 'worker' | 'reviewer' | 'operator';
  createdAt: number;
}

interface KiraAttemptRecord {
  recordVersion?: number;
  migratedFromVersion?: number;
  id: string;
  workId: string;
  attemptNo: number;
  status:
    | 'planned'
    | 'needs_context'
    | 'validation_failed'
    | 'reviewable'
    | 'review_requested_changes'
    | 'blocked'
    | 'approved';
  startedAt: number;
  finishedAt: number;
  contextScan: ProjectContextScan;
  workerPlan: WorkerExecutionPlan;
  preflightExploration: string[];
  readFiles: string[];
  patchedFiles: string[];
  changedFiles: string[];
  commandsRun: string[];
  validationReruns: ValidationRerunSummary;
  outOfPlanFiles: string[];
  validationGaps: string[];
  risks: string[];
  changeDesign?: ChangeDesign;
  diffHunkReview?: DiffHunkReview[];
  validationPlan?: ResolvedValidationPlan;
  diffStats?: DiffStats;
  observability?: KiraAttemptObservability;
  failureAnalysis?: FailureAnalysis[];
  runtimeValidation?: RuntimeValidationResult;
  riskPolicy?: RiskReviewPolicy;
  semanticGraph?: SemanticGraphNode[];
  testImpact?: TestImpactTarget[];
  reviewAdversarialPlan?: ReviewAdversarialPlan;
  patchIntentVerification?: PatchIntentVerification;
  clarificationGate?: ClarificationQualityGate;
  reviewerCalibration?: ReviewerCalibration;
  designReviewGate?: DesignReviewGate;
  orchestrationPlan?: OrchestrationPlan;
  evidenceLedger?: EvidenceLedger;
  integration?: KiraIntegrationRecord;
  requirementTrace?: RequirementTraceItem[];
  approachAlternatives?: PatchAlternative[];
  diffExcerpts?: string[];
  rawWorkerOutput?: string;
  blockedReason?: string;
  rollbackFiles?: string[];
}

interface KiraReviewRecord {
  recordVersion?: number;
  migratedFromVersion?: number;
  id: string;
  workId: string;
  attemptNo: number;
  approved: boolean;
  createdAt: number;
  summary: string;
  findings: ReviewFinding[];
  missingValidation: string[];
  nextWorkerInstructions: string[];
  residualRisk: string[];
  filesChecked: string[];
  evidenceChecked: ReviewEvidenceChecked[];
  requirementVerdicts: RequirementTraceItem[];
  adversarialChecks: ReviewAdversarialCheck[];
  reviewerDiscourse?: ReviewerDiscourseEntry[];
  triage?: ReviewFindingTriageItem[];
  diffCoverage?: DiffReviewCoverage;
  reviewAdversarialPlan?: ReviewAdversarialPlan;
  attemptSynthesis?: AttemptSynthesisRecommendation;
  observability?: KiraReviewObservability;
}

interface ValidationRerunSummary {
  passed: string[];
  failed: string[];
  failureDetails: string[];
}

interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
  hunks: number;
}

interface ResolvedValidationPlan {
  plannerCommands: string[];
  autoAddedCommands: string[];
  effectiveCommands: string[];
  notes: string[];
}

interface AutomationFailureResolution {
  summary: string;
  guidance: string;
  userMessage: string;
}

interface ProjectDiscoveryFinding {
  id: string;
  kind: 'feature' | 'bug';
  title: string;
  summary: string;
  evidence: string[];
  files: string[];
  taskDescription: string;
}

interface ProjectDiscoveryAnalysis {
  id: string;
  projectName: string;
  projectRoot: string;
  summary: string;
  findings: ProjectDiscoveryFinding[];
  basedOnPreviousAnalysis: boolean;
  previousAnalysisId?: string;
  createdAt: number;
  updatedAt: number;
}

interface KiraProjectSettings {
  autoCommit?: boolean;
  requiredInstructions?: string;
  runMode?: KiraRunMode;
  rulePacks?: unknown;
  executionPolicy?: unknown;
  environment?: unknown;
  subagents?: unknown;
  workflow?: unknown;
  plugins?: unknown;
}

interface ResolvedKiraProjectSettings {
  autoCommit: boolean;
  requiredInstructions: string;
  effectiveInstructions: string;
  runMode: KiraRunMode;
  rulePacks: KiraRulePackSetting[];
  executionPolicy: KiraExecutionPolicy;
  environment: KiraEnvironmentContract;
  subagents: KiraSubagentDefinition[];
  workflow: KiraWorkflowDag;
  plugins: KiraPluginConnector[];
}

export interface KiraOrchestrationValidationIssue {
  path: string;
  severity: 'error' | 'warning';
  message: string;
  suggestion?: string;
}

export interface KiraOrchestrationValidationReport {
  valid: boolean;
  issues: KiraOrchestrationValidationIssue[];
  normalized: {
    executionPolicy: KiraExecutionPolicy;
    environment: KiraEnvironmentContract;
    subagents: KiraSubagentDefinition[];
    workflow: KiraWorkflowDag;
    plugins: KiraPluginConnector[];
  };
  summary: string[];
}

interface KiraWorkspaceSession {
  primaryRoot: string;
  projectRoot: string;
  isolated: boolean;
  worktreePath?: string;
  branchName?: string;
}

interface KiraWorkerLane {
  id: string;
  label: string;
  config: LLMConfig;
  subagent?: KiraSubagentDefinition;
}

interface KiraWorkerAttemptResult {
  lane: KiraWorkerLane;
  workspace: KiraWorkspaceSession;
  attemptNo: number;
  cycle: number;
  startedAt: number;
  projectOverview: string;
  contextScan: ProjectContextScan;
  workerPlan: WorkerExecutionPlan;
  planningState: WorkerAttemptState;
  attemptState: WorkerAttemptState | null;
  workerSummary: WorkerSummary;
  validationPlan: ResolvedValidationPlan;
  validationReruns: ValidationRerunSummary;
  failureAnalysis: FailureAnalysis[];
  runtimeValidation: RuntimeValidationResult;
  patchIntentVerification: PatchIntentVerification;
  diffStats: DiffStats;
  outOfPlanFiles: string[];
  missingValidationCommands: string[];
  highRiskIssues: string[];
  diffExcerpts: string[];
  rawWorkerOutput?: string;
  status: 'needs_context' | 'validation_failed' | 'blocked' | 'reviewable' | 'failed';
  feedback: string[];
  blockedReason?: string;
}

interface KiraAttemptObservability {
  stage: KiraAttemptRecord['status'];
  metrics: {
    preflightExplorationCount: number;
    readFileCount: number;
    patchedFileCount: number;
    changedFileCount: number;
    commandRunCount: number;
    validationPassedCount: number;
    validationFailedCount: number;
    diffFileCount: number;
    diffAdditions: number;
    diffDeletions: number;
    diffHunks: number;
    durationMs: number;
    evidenceSignalCount: number;
    estimatedWorkerOutputTokens: number;
  };
  timeline: string[];
  notes: string[];
}

interface KiraReviewObservability {
  durationMs: number;
  findingCount: number;
  triageOpenCount: number;
  discourseCount: number;
  evidenceCount: number;
  estimatedReviewOutputTokens: number;
}

interface AttemptSelectionSummary {
  approved: boolean;
  selectedAttemptNo: number | null;
  summary: string;
  issues: string[];
  nextWorkerInstructions: string[];
  residualRisk: string[];
  filesChecked: string[];
  evidenceChecked: ReviewEvidenceChecked[];
  requirementVerdicts: RequirementTraceItem[];
  adversarialChecks: ReviewAdversarialCheck[];
}

interface KiraAutomationEvent {
  id: string;
  workId: string;
  title: string;
  projectName: string;
  message: string;
  createdAt: number;
  type: 'started' | 'resumed' | 'completed' | 'needs_attention';
}

interface KiraAutomationPluginOptions {
  configFile: string;
  sessionsDir: string;
  getWorkRootDirectory: () => string | null;
}

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface AttemptFileSnapshot {
  existed: boolean;
  content: string | null;
}

export interface DirtyFileContentSnapshot {
  exists: boolean;
  hash: string | null;
  size: number | null;
}

interface WorkerAttemptState {
  plan: WorkerExecutionPlan | null;
  fileSnapshots: Map<string, AttemptFileSnapshot>;
  dirtyFileSnapshots: Map<string, DirtyFileContentSnapshot>;
  executionPolicy: KiraExecutionPolicy;
  environmentContract: KiraEnvironmentContract;
  toolScope: Set<string> | null;
  commandsRun: string[];
  readFiles: Set<string>;
  explorationActions: string[];
  patchedFiles: Set<string>;
  dirtyFiles: Set<string>;
}

type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; reasoningContent?: string }
  | { role: 'tool'; content: string; toolCallId: string };
type ToolAgentFinalValidator = (content: string) => string[];

interface KiraModelRouteLock
{
  active: number;
  queue: Array<() => void>;
}

const KIMI_TOOL_CALL_REASONING_FALLBACK =
  'Kira is continuing a tool-call turn where the provider did not return reasoning_content.';
const COMMENTS_DIR_NAME = 'comments';
const WORKS_DIR_NAME = 'works';
const ANALYSIS_DIR_NAME = 'analysis';
const ATTEMPTS_DIR_NAME = 'attempts';
const REVIEWS_DIR_NAME = 'reviews';
const WORKTREES_DIR_NAME = 'worktrees';
const PROJECT_SETTINGS_DIR_NAME = '.kira';
const PROJECT_SETTINGS_FILE_NAME = 'project-settings.json';
const PROJECT_PROFILE_FILE_NAME = 'project-profile.json';
const PROJECT_PROFILE_SCHEMA_VERSION = 1;
const KIRA_ATTEMPT_RECORD_VERSION = 2;
const KIRA_REVIEW_RECORD_VERSION = 2;
const KIRA_PROMPT_CONTRACT_VERSION = 2;
const MAX_REVIEW_CYCLES = 5;
const MAX_DISCOVERY_FINDINGS = 10;
const MAX_CLARIFICATION_QUESTIONS = 3;
const MAX_CLARIFICATION_OPTIONS = 4;
const MAX_AGENT_REPAIR_TURNS = 2;
const MAX_AGENT_TIMEOUT_RETRIES = 1;
const KIRA_LOCAL_MODEL_ROUTE_LIMIT = 1;
const KIRA_REMOTE_MODEL_ROUTE_LIMIT = 2;
const KIRA_LLM_MAX_OUTPUT_TOKENS = 8192;
const MAX_FILE_BYTES = 80_000;
const MAX_OVERWRITE_FILE_BYTES = 8_000;
const MAX_FULL_REWRITE_FILE_BYTES = MAX_FILE_BYTES;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 40;
const MAX_PLANNED_FILES = 12;
const MAX_PLANNER_VALIDATION_COMMANDS = 4;
const MAX_DEFAULT_VALIDATION_COMMANDS = 3;
const MAX_EFFECTIVE_VALIDATION_COMMANDS = 6;
const MAX_REVIEW_DIFF_CHARS = 2_400;
const MAX_PROJECT_REQUIRED_INSTRUCTIONS_CHARS = 12_000;
const MAX_PROJECT_PROFILE_LIST_ITEMS = 20;
const MAX_PROJECT_LEARNING_ITEMS = 12;
const MAX_DIFF_HUNK_REVIEW_ITEMS = 24;
const MAX_DEPENDENCY_INSIGHTS = 8;
const MAX_REQUIREMENT_TRACE_ITEMS = 12;
const MAX_FAILURE_ANALYSIS_ITEMS = 8;
const MAX_PATCH_ALTERNATIVES = 4;
const MAX_SEMANTIC_GRAPH_NODES = 12;
const MAX_TEST_IMPACT_TARGETS = 8;
const MAX_RUNTIME_EVIDENCE_CHARS = 700;
const MAX_SCORED_MEMORY_ITEMS = 18;
const SMALL_PATCH_FILE_LIMIT = 10;
const SMALL_PATCH_LINE_LIMIT = 900;
const SMALL_PATCH_PLAN_FILE_LIMIT = 8;
const COMMON_DEV_SERVER_PORTS = [5173, 3000, 4173, 5174, 8080];
const SECRET_ENV_NAME_PATTERN = /(?:token|secret|key|password|credential|auth|cookie)/i;
const NETWORK_COMMAND_PATTERN =
  /\b(?:gh|git\s+(?:fetch|pull|push|clone)|npm\s+publish|pnpm\s+publish|yarn\s+publish)\b|https?:\/\//i;
const ENV_DISCLOSURE_COMMAND_PATTERN =
  /\b(?:printenv|set|env|Get-ChildItem\s+Env:|gci\s+Env:|\$env:)\b/i;
const DOCUMENTATION_FILE_PATTERN = /\.(?:md|mdx|txt|rst)$/i;
const RUNTIME_PROBE_TIMEOUT_MS = 450;
const COMMAND_TIMEOUT_MS = 90_000;
const REMOTE_RUNNER_PROBE_COMMAND = 'git rev-parse --is-inside-work-tree';
const LLM_REQUEST_TIMEOUT_MS = 240_000;
const EXTERNAL_AGENT_TIMEOUT_MS = 10 * 60_000;
const STALLED_WORK_MS = 15_000;
const GLOBAL_SCAN_INTERVAL_MS = 10_000;
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_STALE_MS = 10 * 60_000;
const WORKER_AUTHOR = 'Kira Worker';
const REVIEWER_AUTHOR = 'Main AI Reviewer';
const RECOVERABLE_LOCK_ERROR_CODES = new Set([
  'EACCES',
  'EBUSY',
  'EEXIST',
  'ENOENT',
  'ENOTDIR',
  'EPERM',
]);
const activeJobs = new Set<string>();
const activeProjectJobs = new Set<string>();
const jobAbortControllers = new Map<string, AbortController>();
const EVENT_QUEUE_FILE = 'kira-automation-events.json';
const LOCKS_DIR_NAME = 'automation-locks';
const GLOBAL_LOCKS_DIR_NAME = '.kira-automation-locks';
const SERVER_INSTANCE_ID = makeId('kira-server');
const kiraModelRouteLocks = new Map<string, KiraModelRouteLock>();
const CODEX_CLI_FALLBACK_MODEL = 'gpt-5.3-codex';
const KIRA_RULE_PACK_PRESETS: KiraRulePackDefinition[] = [
  {
    id: 'strict-typescript',
    label: 'Strict TypeScript',
    description: 'Prefer explicit contracts, typed boundaries, and no avoidable any casts.',
    instructions: [
      'Preserve strict TypeScript safety; do not introduce implicit any, broad any casts, or unchecked optional access.',
      'When changing exported APIs, update related types, normalizers, and tests together.',
    ],
  },
  {
    id: 'small-patch',
    label: 'Small Patch',
    description: 'Keep changes narrow, reversible, and directly tied to the task.',
    instructions: [
      'Keep patches tightly scoped to the work brief and avoid opportunistic refactors.',
      'Explain any out-of-plan file change and treat broad rewrites as review-blocking unless justified by the brief.',
    ],
  },
  {
    id: 'validation-first',
    label: 'Validation First',
    description: 'Require concrete verification evidence before approval.',
    instructions: [
      'Prefer existing test, lint, typecheck, or build commands and record exact validation evidence.',
      'Do not approve unless failed checks are fixed or the validation gap is explicitly justified as non-applicable.',
    ],
  },
  {
    id: 'frontend-runtime',
    label: 'Frontend Runtime',
    description: 'For UI changes, inspect runtime behavior when a dev server already exists.',
    instructions: [
      'For frontend-visible changes, verify rendering or runtime reachability when a dev server is already running.',
      'Do not start a dev server automatically; only use an already-running local server for runtime checks.',
    ],
  },
  {
    id: 'safe-refactor',
    label: 'Safe Refactor',
    description: 'Protect behavior while changing structure.',
    instructions: [
      'For refactors, preserve public behavior and call sites unless the brief explicitly changes them.',
      'Reviewer must compare before/after intent and reject behavior drift without evidence.',
    ],
  },
  {
    id: 'docs-safe',
    label: 'Docs Safe',
    description: 'Keep docs, examples, and code references synchronized.',
    instructions: [
      'When behavior or commands change, update adjacent docs, examples, or comments that would become misleading.',
      'Do not add docs claims that are not backed by the actual implementation.',
    ],
  },
];
const DEFAULT_KIRA_EXECUTION_POLICY: KiraExecutionPolicy = {
  mode: 'balanced',
  maxChangedFiles: 12,
  maxDiffLines: 900,
  protectedPaths: [
    '.env',
    '.env.*',
    '.git/**',
    '.kira/project-settings.json',
    '**/*.pem',
    '**/*.key',
    '**/secrets/**',
  ],
  commandAllowlist: [],
  commandDenylist: [
    'npm install',
    'pnpm add',
    'git reset',
    'git clean',
    'curl ',
    'Invoke-WebRequest',
  ],
  requireValidation: true,
  requireReviewerEvidence: true,
  rules: [
    {
      id: 'block-protected-write',
      event: 'before_tool',
      enabled: true,
      decision: 'block',
      message: 'Protected paths cannot be written by Kira automation.',
      toolNames: ['write_file', 'edit_file'],
      pathPatterns: [
        '.env',
        '.env.*',
        '.git/**',
        '.kira/project-settings.json',
        '**/*.pem',
        '**/*.key',
        '**/secrets/**',
      ],
      commandPatterns: [],
      riskLevels: [],
    },
    {
      id: 'block-denied-command',
      event: 'before_tool',
      enabled: true,
      decision: 'block',
      message: 'Command is denied by the project execution policy.',
      toolNames: ['run_command'],
      pathPatterns: [],
      commandPatterns: ['npm install', 'pnpm add', 'git reset', 'git clean'],
      riskLevels: [],
    },
  ],
};
const DEFAULT_KIRA_ENVIRONMENT_CONTRACT: KiraEnvironmentContract = {
  runner: 'local',
  setupCommands: [],
  validationCommands: [],
  requiredEnv: [],
  allowedNetwork: 'localhost',
  secretsPolicy: 'local-only',
  windowsMode: 'auto',
  remoteCommand: '',
  devServerCommand: '',
};
const DEFAULT_KIRA_PLUGIN_CONNECTORS: KiraPluginConnector[] = [
  {
    id: 'github',
    label: 'GitHub',
    type: 'github',
    enabled: false,
    capabilities: ['issues', 'pull-requests', 'checks'],
    policy: 'suggest',
  },
  {
    id: 'linear',
    label: 'Linear',
    type: 'linear',
    enabled: false,
    capabilities: ['issues', 'projects'],
    policy: 'observe',
  },
  {
    id: 'mcp',
    label: 'MCP',
    type: 'mcp',
    enabled: false,
    capabilities: ['context', 'tools'],
    policy: 'observe',
  },
];
const KIRA_PROJECT_ROOT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'requirements.txt',
  'pom.xml',
  'build.gradle',
  'settings.gradle',
  'deno.json',
];
const SAFE_SCRIPT_NAME = String.raw`(?:test|lint|build|check|typecheck)(?::[A-Za-z0-9_-]+)?`;
const SAFE_PNPM_DIR = String.raw`(?:(?!\.\.(?:[\\/]|$))(?!.*[\\/]\.\.(?:[\\/]|$))[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*)`;
const SAFE_COMMAND_PATTERNS = [
  /^python\s+-m\s+(?:pytest|unittest|compileall|py_compile|ruff|mypy)\b/i,
  /^py\s+-m\s+(?:pytest|unittest|compileall|py_compile|ruff|mypy)\b/i,
  /^pytest(?:\s|$)/i,
  /^uv\s+run\s+(?:pytest(?:\s|$)|python\s+-m\s+(?:pytest|unittest|compileall|py_compile|ruff|mypy)\b|py\s+-m\s+(?:pytest|unittest|compileall|py_compile|ruff|mypy)\b|ruff\b|mypy\b)/i,
  new RegExp(`^npm\\s+(?:test(?:\\s|$)|run\\s+${SAFE_SCRIPT_NAME}\\b)`, 'i'),
  new RegExp(
    `^pnpm\\s+(?:--dir\\s+${SAFE_PNPM_DIR}\\s+)?(?:(?:run\\s+)?${SAFE_SCRIPT_NAME}\\b|exec\\s+(?:vitest|jest|eslint|tsc|tsx|vite)\\b)`,
    'i',
  ),
  /^node\s+--test\b/i,
  /^git\s+(status|diff|show|rev-parse|branch|log)\b/i,
  /^rg(?:\s|$)/i,
  /^go\s+(?:test|vet)\b/i,
  /^cargo\s+(?:test|check|clippy|fmt)\b/i,
  /^dotnet\s+(?:test|build)\b/i,
];
const DANGEROUS_COMMAND_PATTERNS = [
  /\b(?:rm|del|rmdir|erase|format|shutdown)\b/i,
  /\b(?:remove-item|move-item|rename-item|copy-item)\b/i,
  /\b(?:invoke-expression|iex|start-process|curl|wget|invoke-webrequest)\b/i,
  /\bgit\s+(?:reset|checkout|clean)\b/i,
  /[|;&><]/,
];
const SKIPPED_TOOL_TRAVERSAL_DIRECTORIES = new Set([
  '.git',
  '.kira',
  '.mypy_cache',
  '.next',
  '.openroom',
  '.pytest_cache',
  '.turbo',
  '.venv',
  '__pycache__',
  'automation-locks',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'test-results',
  'venv',
]);

interface GitStatusEntry {
  path: string;
  status: string;
}

function sanitizeSessionPath(sessionPath: string): string {
  return sessionPath.replace(/[^a-zA-Z0-9_\-./]/g, '_').replace(/\.\./g, '');
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function shouldSkipToolTraversalDirectory(name: string): boolean {
  return SKIPPED_TOOL_TRAVERSAL_DIRECTORIES.has(name.toLowerCase());
}

function estimateTokenCount(value: string): number {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function normalizeProjectRequiredInstructions(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .slice(0, MAX_PROJECT_REQUIRED_INSTRUCTIONS_CHARS);
}

function normalizeRunMode(value: unknown, fallback: KiraRunMode = 'standard'): KiraRunMode {
  return value === 'quick' || value === 'standard' || value === 'deep' ? value : fallback;
}

function normalizeRulePackSettings(
  value: unknown,
  fallback: KiraRulePackSetting[] = [],
): KiraRulePackSetting[] {
  const fallbackEnabled = new Map(fallback.map((item) => [item.id, item.enabled]));
  const rawEnabled = new Map<string, boolean>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        rawEnabled.set(item, true);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const parsed = item as Partial<KiraRulePackSetting>;
      if (typeof parsed.id === 'string' && parsed.id.trim()) {
        rawEnabled.set(parsed.id.trim(), parsed.enabled !== false);
      }
    }
  }

  return KIRA_RULE_PACK_PRESETS.map((preset) => ({
    id: preset.id,
    enabled: rawEnabled.has(preset.id)
      ? Boolean(rawEnabled.get(preset.id))
      : Boolean(fallbackEnabled.get(preset.id)),
  }));
}

function buildRulePackInstructions(rulePacks: KiraRulePackSetting[]): string {
  const enabled = new Set(rulePacks.filter((item) => item.enabled).map((item) => item.id));
  const lines = KIRA_RULE_PACK_PRESETS.filter((preset) => enabled.has(preset.id)).flatMap(
    (preset) => [
      `Rule pack: ${preset.label}`,
      ...preset.instructions.map((instruction) => `- ${instruction}`),
    ],
  );
  return lines.join('\n');
}

function buildEffectiveProjectInstructions(
  requiredInstructions: string,
  rulePacks: KiraRulePackSetting[],
): string {
  return [requiredInstructions, buildRulePackInstructions(rulePacks)]
    .map((section) => section.trim())
    .filter(Boolean)
    .join('\n\n');
}

function collectManualEvidenceFromComments(comments: TaskComment[]): ManualEvidenceItem[] {
  return comments
    .filter((comment) => comment.body.includes('[Kira manual evidence]'))
    .map((comment): ManualEvidenceItem | null => {
      const kindMatch = comment.body.match(/^Kind:\s*(.+)$/im);
      const riskMatch = comment.body.match(/^Risk accepted:\s*(yes|no|true|false)$/im);
      const summaryMatch = comment.body.match(/Summary:\s*([\s\S]*)$/im);
      const kindValue = (kindMatch?.[1] ?? 'manual').trim().toLowerCase();
      const kind: ManualEvidenceItem['kind'] =
        kindValue === 'test' ||
        kindValue === 'runtime' ||
        kindValue === 'review' ||
        kindValue === 'risk-acceptance'
          ? kindValue
          : 'manual';
      const summary = normalizeProjectRequiredInstructions(summaryMatch?.[1] ?? comment.body);
      if (!summary) return null;
      return {
        id: comment.id,
        kind,
        author: comment.author || 'Operator',
        summary,
        riskAccepted:
          kind === 'risk-acceptance' || /^(yes|true)$/i.test((riskMatch?.[1] ?? '').trim()),
        createdAt: comment.createdAt,
      };
    })
    .filter((item): item is ManualEvidenceItem => item !== null)
    .slice(-20);
}

function clampConfidence(value: unknown, fallback = 0.5): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(1, Math.max(0, numeric));
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', ''].includes(normalized)) return false;
  }
  return fallback;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function limitedUniqueStrings(values: string[], limit = MAX_PROJECT_PROFILE_LIST_ITEMS): string[] {
  return uniqueStrings(values.map((value) => normalizeWhitespace(value)).filter(Boolean)).slice(
    0,
    limit,
  );
}

function stringArrayFrom(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function normalizePatternList(value: unknown, fallback: string[] = [], limit = 40): string[] {
  return limitedUniqueStrings(
    (Array.isArray(value) ? value.map(String) : fallback).map((item) => item.trim()),
    limit,
  );
}

function normalizePolicyRule(raw: unknown, fallback?: KiraPolicyRule): KiraPolicyRule | null {
  const value = typeof raw === 'object' && raw !== null ? (raw as Partial<KiraPolicyRule>) : {};
  const id =
    typeof value.id === 'string' && value.id.trim()
      ? normalizeWhitespace(value.id)
      : fallback?.id || '';
  if (!id) return null;
  const event =
    value.event === 'before_tool' ||
    value.event === 'after_tool' ||
    value.event === 'before_validation' ||
    value.event === 'before_integration' ||
    value.event === 'task_completed'
      ? value.event
      : (fallback?.event ?? 'before_tool');
  const decision =
    value.decision === 'allow' ||
    value.decision === 'warn' ||
    value.decision === 'block' ||
    value.decision === 'defer'
      ? value.decision
      : (fallback?.decision ?? 'warn');
  return {
    id,
    event,
    enabled: normalizeBoolean(value.enabled, fallback?.enabled ?? true),
    decision,
    message:
      typeof value.message === 'string' && value.message.trim()
        ? normalizeWhitespace(value.message)
        : fallback?.message || `Kira policy ${id} matched.`,
    toolNames: normalizePatternList(value.toolNames, fallback?.toolNames ?? [], 20),
    pathPatterns: normalizePatternList(value.pathPatterns, fallback?.pathPatterns ?? [], 40),
    commandPatterns: normalizePatternList(
      value.commandPatterns,
      fallback?.commandPatterns ?? [],
      40,
    ),
    riskLevels: Array.isArray(value.riskLevels)
      ? value.riskLevels.filter(
          (level): level is RiskReviewPolicy['level'] =>
            level === 'low' || level === 'medium' || level === 'high',
        )
      : (fallback?.riskLevels ?? []),
  };
}

export function normalizeExecutionPolicy(
  value: unknown,
  fallback: KiraExecutionPolicy = DEFAULT_KIRA_EXECUTION_POLICY,
): KiraExecutionPolicy {
  const raw =
    typeof value === 'object' && value !== null ? (value as Partial<KiraExecutionPolicy>) : {};
  const maxChangedFiles =
    typeof raw.maxChangedFiles === 'number' && Number.isFinite(raw.maxChangedFiles)
      ? Math.max(1, Math.min(200, Math.round(raw.maxChangedFiles)))
      : fallback.maxChangedFiles;
  const maxDiffLines =
    typeof raw.maxDiffLines === 'number' && Number.isFinite(raw.maxDiffLines)
      ? Math.max(1, Math.min(20_000, Math.round(raw.maxDiffLines)))
      : fallback.maxDiffLines;
  const mode =
    raw.mode === 'locked-down' || raw.mode === 'permissive' || raw.mode === 'balanced'
      ? raw.mode
      : fallback.mode;
  const fallbackRules = fallback.rules;
  const rawRules = Array.isArray(raw.rules) ? raw.rules : fallbackRules;
  return {
    mode,
    maxChangedFiles,
    maxDiffLines,
    protectedPaths: normalizePatternList(raw.protectedPaths, fallback.protectedPaths, 80),
    commandAllowlist: normalizePatternList(raw.commandAllowlist, fallback.commandAllowlist, 80),
    commandDenylist: normalizePatternList(raw.commandDenylist, fallback.commandDenylist, 80),
    requireValidation: normalizeBoolean(raw.requireValidation, fallback.requireValidation),
    requireReviewerEvidence: normalizeBoolean(
      raw.requireReviewerEvidence,
      fallback.requireReviewerEvidence,
    ),
    rules: rawRules
      .map((rule, index) => normalizePolicyRule(rule, fallbackRules[index]))
      .filter((rule): rule is KiraPolicyRule => rule !== null),
  };
}

export function normalizeEnvironmentContract(
  value: unknown,
  fallback: KiraEnvironmentContract = DEFAULT_KIRA_ENVIRONMENT_CONTRACT,
): KiraEnvironmentContract {
  const raw =
    typeof value === 'object' && value !== null ? (value as Partial<KiraEnvironmentContract>) : {};
  return {
    runner:
      raw.runner === 'remote-command' || raw.runner === 'cloud' || raw.runner === 'local'
        ? raw.runner
        : fallback.runner,
    setupCommands: normalizePatternList(raw.setupCommands, fallback.setupCommands, 12).filter(
      (command) => isSafeCommandAllowed(command),
    ),
    validationCommands: normalizePatternList(
      raw.validationCommands,
      fallback.validationCommands,
      12,
    ).filter((command) => isSafeCommandAllowed(command)),
    requiredEnv: normalizePatternList(raw.requiredEnv, fallback.requiredEnv, 40),
    allowedNetwork:
      raw.allowedNetwork === 'none' ||
      raw.allowedNetwork === 'localhost' ||
      raw.allowedNetwork === 'public'
        ? raw.allowedNetwork
        : fallback.allowedNetwork,
    secretsPolicy:
      raw.secretsPolicy === 'masked' ||
      raw.secretsPolicy === 'unrestricted' ||
      raw.secretsPolicy === 'local-only'
        ? raw.secretsPolicy
        : fallback.secretsPolicy,
    windowsMode:
      raw.windowsMode === 'native-powershell' ||
      raw.windowsMode === 'wsl' ||
      raw.windowsMode === 'auto'
        ? raw.windowsMode
        : fallback.windowsMode,
    remoteCommand:
      typeof raw.remoteCommand === 'string'
        ? normalizeWhitespace(raw.remoteCommand).slice(0, 400)
        : fallback.remoteCommand,
    devServerCommand:
      typeof raw.devServerCommand === 'string'
        ? normalizeWhitespace(raw.devServerCommand).slice(0, 400)
        : fallback.devServerCommand,
  };
}

function buildDefaultSubagentRegistry(
  profile?: KiraProjectProfile | null,
): KiraSubagentDefinition[] {
  const recommended = new Set(profile?.workers.recommendedProfiles ?? []);
  const defaults: KiraSubagentDefinition[] = [
    {
      id: 'explorer',
      label: 'Explorer',
      profile: 'generalist',
      description:
        'Find relevant files, contracts, tests, and project constraints before planning.',
      tools: ['list_files', 'search_files', 'read_file'],
      requiredEvidence: ['repoFindings', 'likelyFiles'],
      modelHint: '',
      enabled: true,
    },
    {
      id: 'implementer',
      label: 'Implementer',
      profile: recommended.has('frontend-ui') ? 'frontend-ui' : 'generalist',
      description: 'Apply the scoped patch while preserving user work and project policy.',
      tools: ['read_file', 'edit_file', 'write_file', 'run_command'],
      requiredEvidence: ['diffHunkReview', 'validation'],
      modelHint: '',
      enabled: true,
    },
    {
      id: 'test-validator',
      label: 'Test Validator',
      profile: 'test-validation',
      description: 'Select, run, and interpret focused validation for changed files.',
      tools: ['read_file', 'search_files', 'run_command'],
      requiredEvidence: ['validationCommands', 'failureAnalysis'],
      modelHint: '',
      enabled: recommended.has('test-validation'),
    },
    {
      id: 'security-reviewer',
      label: 'Security Reviewer',
      profile: 'security-auth',
      description: 'Challenge auth, secrets, permissions, data-loss, and rollback assumptions.',
      tools: ['read_file', 'search_files'],
      requiredEvidence: ['adversarialChecks', 'reviewerDiscourse'],
      modelHint: '',
      enabled: true,
    },
    {
      id: 'integration-judge',
      label: 'Integration Judge',
      profile: 'minimal-risk integration reviewer',
      description: 'Approve only when the evidence ledger, policy, and review findings are ready.',
      tools: ['read_file', 'run_command'],
      requiredEvidence: ['evidenceLedger', 'approvalReadiness'],
      modelHint: '',
      enabled: true,
    },
  ];
  return defaults;
}

export function normalizeSubagentRegistry(
  value: unknown,
  profile?: KiraProjectProfile | null,
): KiraSubagentDefinition[] {
  const defaults = buildDefaultSubagentRegistry(profile);
  const byId = new Map(defaults.map((agent) => [agent.id, agent]));
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const raw = item as Partial<KiraSubagentDefinition>;
      const id = typeof raw.id === 'string' && raw.id.trim() ? normalizeWhitespace(raw.id) : '';
      if (!id) continue;
      const fallback = byId.get(id);
      byId.set(id, {
        id,
        label:
          typeof raw.label === 'string' && raw.label.trim()
            ? normalizeWhitespace(raw.label)
            : fallback?.label || id,
        profile:
          typeof raw.profile === 'string' && raw.profile.trim()
            ? normalizeWhitespace(raw.profile)
            : fallback?.profile || 'generalist',
        description:
          typeof raw.description === 'string' && raw.description.trim()
            ? normalizeWhitespace(raw.description)
            : fallback?.description || 'Custom Kira subagent.',
        tools: normalizePatternList(raw.tools, fallback?.tools ?? [], 20),
        requiredEvidence: normalizePatternList(
          raw.requiredEvidence,
          fallback?.requiredEvidence ?? [],
          20,
        ),
        modelHint:
          typeof raw.modelHint === 'string' && raw.modelHint.trim()
            ? normalizeWhitespace(raw.modelHint)
            : fallback?.modelHint || '',
        enabled: normalizeBoolean(raw.enabled, fallback?.enabled ?? true),
      });
    }
  }
  return [...byId.values()].filter((agent) => agent.enabled).slice(0, 12);
}

function buildDefaultWorkflowDag(runMode: KiraRunMode = 'standard'): KiraWorkflowDag {
  const nodes: KiraWorkflowDagNode[] = [
    { id: 'discover', label: 'Context discovery', kind: 'plan', required: true },
    { id: 'plan', label: 'Preflight plan', kind: 'plan', required: true },
    { id: 'design-gate', label: 'Design gate', kind: 'review', required: runMode !== 'quick' },
    { id: 'implement', label: 'Implementation', kind: 'implement', required: true },
    { id: 'validate', label: 'Validation rerun', kind: 'validate', required: true },
    { id: 'review', label: 'Evidence review', kind: 'review', required: true },
    { id: 'integrate', label: 'Apply or commit decision', kind: 'integrate', required: true },
  ];
  if (runMode === 'deep') {
    nodes.splice(5, 0, {
      id: 'adversarial-pass',
      label: 'Adversarial second pass',
      kind: 'review',
      required: true,
    });
  }
  const criticalPath = nodes.map((node) => node.id);
  return {
    nodes,
    edges: criticalPath.slice(1).map((to, index) => ({
      from: criticalPath[index],
      to,
      condition: 'previous stage passed',
    })),
    criticalPath,
  };
}

export function normalizeWorkflowDag(
  value: unknown,
  runMode: KiraRunMode = 'standard',
): KiraWorkflowDag {
  const fallback = buildDefaultWorkflowDag(runMode);
  const raw =
    typeof value === 'object' && value !== null ? (value as Partial<KiraWorkflowDag>) : {};
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes
        .map((item): KiraWorkflowDagNode | null => {
          if (!item || typeof item !== 'object') return null;
          const node = item as Partial<KiraWorkflowDagNode>;
          const id =
            typeof node.id === 'string' && node.id.trim() ? normalizeWhitespace(node.id) : '';
          const label =
            typeof node.label === 'string' && node.label.trim()
              ? normalizeWhitespace(node.label)
              : id;
          const kind =
            node.kind === 'plan' ||
            node.kind === 'implement' ||
            node.kind === 'validate' ||
            node.kind === 'review' ||
            node.kind === 'integrate' ||
            node.kind === 'blocked' ||
            node.kind === 'done'
              ? node.kind
              : 'plan';
          return id ? { id, label, kind, required: node.required !== false } : null;
        })
        .filter((node): node is KiraWorkflowDagNode => node !== null)
    : fallback.nodes;
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = Array.isArray(raw.edges)
    ? raw.edges
        .map((item): KiraWorkflowDagEdge | null => {
          if (!item || typeof item !== 'object') return null;
          const edge = item as Partial<KiraWorkflowDagEdge>;
          const from = typeof edge.from === 'string' ? normalizeWhitespace(edge.from) : '';
          const to = typeof edge.to === 'string' ? normalizeWhitespace(edge.to) : '';
          if (!nodeIds.has(from) || !nodeIds.has(to)) return null;
          return {
            from,
            to,
            condition:
              typeof edge.condition === 'string' && edge.condition.trim()
                ? normalizeWhitespace(edge.condition)
                : 'previous stage passed',
          };
        })
        .filter((edge): edge is KiraWorkflowDagEdge => edge !== null)
    : fallback.edges;
  const criticalPath = normalizePatternList(raw.criticalPath, fallback.criticalPath, 40).filter(
    (id) => nodeIds.has(id),
  );
  return {
    nodes,
    edges,
    criticalPath: criticalPath.length > 0 ? criticalPath : fallback.criticalPath,
  };
}

function workflowHasRequiredKind(
  workflow: KiraWorkflowDag | undefined,
  kind: KiraWorkflowDagNode['kind'],
): boolean {
  return normalizeWorkflowDag(workflow).nodes.some((node) => node.required && node.kind === kind);
}

function workflowHasStage(workflow: KiraWorkflowDag | undefined, stageId: string): boolean {
  return normalizeWorkflowDag(workflow).nodes.some((node) => node.required && node.id === stageId);
}

export function normalizePluginConnectors(value: unknown): KiraPluginConnector[] {
  const byId = new Map(
    DEFAULT_KIRA_PLUGIN_CONNECTORS.map((connector) => [connector.id, connector]),
  );
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const raw = item as Partial<KiraPluginConnector>;
      const id = typeof raw.id === 'string' && raw.id.trim() ? normalizeWhitespace(raw.id) : '';
      if (!id) continue;
      const fallback = byId.get(id);
      const type =
        raw.type === 'github' ||
        raw.type === 'linear' ||
        raw.type === 'slack' ||
        raw.type === 'mcp' ||
        raw.type === 'custom'
          ? raw.type
          : (fallback?.type ?? 'custom');
      const policy =
        raw.policy === 'apply' || raw.policy === 'suggest' || raw.policy === 'observe'
          ? raw.policy
          : (fallback?.policy ?? 'observe');
      byId.set(id, {
        id,
        label:
          typeof raw.label === 'string' && raw.label.trim()
            ? normalizeWhitespace(raw.label)
            : fallback?.label || id,
        type,
        enabled: normalizeBoolean(raw.enabled, fallback?.enabled ?? false),
        capabilities: normalizePatternList(raw.capabilities, fallback?.capabilities ?? [], 20),
        policy,
      });
    }
  }
  return [...byId.values()].slice(0, 20);
}

function pushValidationIssue(
  issues: KiraOrchestrationValidationIssue[],
  issue: KiraOrchestrationValidationIssue,
): void {
  if (
    issues.some(
      (existing) =>
        existing.path === issue.path &&
        existing.severity === issue.severity &&
        existing.message === issue.message,
    )
  ) {
    return;
  }
  issues.push(issue);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateStringArrayField(
  issues: KiraOrchestrationValidationIssue[],
  value: unknown,
  path: string,
  options: { required?: boolean; maxItems?: number } = {},
): void {
  if (value === undefined) {
    if (options.required) {
      pushValidationIssue(issues, {
        path,
        severity: 'error',
        message: 'Required array field is missing.',
      });
    }
    return;
  }
  if (!Array.isArray(value)) {
    pushValidationIssue(issues, {
      path,
      severity: 'error',
      message: 'Expected an array.',
    });
    return;
  }
  if (options.maxItems && value.length > options.maxItems) {
    pushValidationIssue(issues, {
      path,
      severity: 'warning',
      message: `Only the first ${options.maxItems} entries are used.`,
    });
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      pushValidationIssue(issues, {
        path: `${path}[${index}]`,
        severity: 'error',
        message: 'Expected a non-empty string.',
      });
    }
  });
}

function validateNumberField(
  issues: KiraOrchestrationValidationIssue[],
  value: unknown,
  path: string,
  options: { min: number; max: number },
): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    pushValidationIssue(issues, {
      path,
      severity: 'error',
      message: 'Expected a finite number.',
    });
    return;
  }
  if (value < options.min || value > options.max) {
    pushValidationIssue(issues, {
      path,
      severity: 'warning',
      message: `Value is clamped to the supported range ${options.min}-${options.max}.`,
    });
  }
}

function validateBooleanField(
  issues: KiraOrchestrationValidationIssue[],
  value: unknown,
  path: string,
): void {
  if (value === undefined) return;
  if (typeof value !== 'boolean') {
    pushValidationIssue(issues, {
      path,
      severity: 'error',
      message: 'Expected a boolean.',
    });
  }
}

function validateEnumField(
  issues: KiraOrchestrationValidationIssue[],
  value: unknown,
  path: string,
  allowed: readonly string[],
): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    pushValidationIssue(issues, {
      path,
      severity: 'error',
      message: `Expected one of: ${allowed.join(', ')}.`,
    });
  }
}

function validateTopLevelUnknownKeys(
  issues: KiraOrchestrationValidationIssue[],
  raw: Record<string, unknown>,
): void {
  const known = new Set(['executionPolicy', 'environment', 'subagents', 'workflow', 'plugins']);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      pushValidationIssue(issues, {
        path: key,
        severity: 'warning',
        message: 'Unknown orchestration field will be ignored by Kira.',
      });
    }
  }
}

function validateExecutionPolicyContract(
  issues: KiraOrchestrationValidationIssue[],
  value: unknown,
): void {
  if (value === undefined) return;
  if (!isPlainRecord(value)) {
    pushValidationIssue(issues, {
      path: 'executionPolicy',
      severity: 'error',
      message: 'Execution policy must be an object.',
    });
    return;
  }
  validateEnumField(issues, value.mode, 'executionPolicy.mode', [
    'balanced',
    'locked-down',
    'permissive',
  ]);
  validateNumberField(issues, value.maxChangedFiles, 'executionPolicy.maxChangedFiles', {
    min: 1,
    max: 200,
  });
  validateNumberField(issues, value.maxDiffLines, 'executionPolicy.maxDiffLines', {
    min: 1,
    max: 20_000,
  });
  validateStringArrayField(issues, value.protectedPaths, 'executionPolicy.protectedPaths', {
    maxItems: 80,
  });
  validateStringArrayField(issues, value.commandAllowlist, 'executionPolicy.commandAllowlist', {
    maxItems: 80,
  });
  validateStringArrayField(issues, value.commandDenylist, 'executionPolicy.commandDenylist', {
    maxItems: 80,
  });
  validateBooleanField(issues, value.requireValidation, 'executionPolicy.requireValidation');
  validateBooleanField(
    issues,
    value.requireReviewerEvidence,
    'executionPolicy.requireReviewerEvidence',
  );
  if (value.rules === undefined) return;
  if (!Array.isArray(value.rules)) {
    pushValidationIssue(issues, {
      path: 'executionPolicy.rules',
      severity: 'error',
      message: 'Policy rules must be an array.',
    });
    return;
  }
  value.rules.forEach((rule, index) => {
    const path = `executionPolicy.rules[${index}]`;
    if (!isPlainRecord(rule)) {
      pushValidationIssue(issues, {
        path,
        severity: 'error',
        message: 'Policy rule must be an object.',
      });
      return;
    }
    if (typeof rule.id !== 'string' || !rule.id.trim()) {
      pushValidationIssue(issues, {
        path: `${path}.id`,
        severity: 'error',
        message: 'Policy rule requires a stable id.',
      });
    }
    validateEnumField(issues, rule.event, `${path}.event`, [
      'before_tool',
      'after_tool',
      'before_validation',
      'before_integration',
      'task_completed',
    ]);
    validateEnumField(issues, rule.decision, `${path}.decision`, [
      'allow',
      'warn',
      'block',
      'defer',
    ]);
    validateStringArrayField(issues, rule.toolNames, `${path}.toolNames`, { maxItems: 20 });
    validateStringArrayField(issues, rule.pathPatterns, `${path}.pathPatterns`, {
      maxItems: 40,
    });
    validateStringArrayField(issues, rule.commandPatterns, `${path}.commandPatterns`, {
      maxItems: 40,
    });
  });
}

function validateEnvironmentContract(
  issues: KiraOrchestrationValidationIssue[],
  value: unknown,
): void {
  if (value === undefined) return;
  if (!isPlainRecord(value)) {
    pushValidationIssue(issues, {
      path: 'environment',
      severity: 'error',
      message: 'Environment contract must be an object.',
    });
    return;
  }
  validateEnumField(issues, value.runner, 'environment.runner', [
    'local',
    'remote-command',
    'cloud',
  ]);
  validateStringArrayField(issues, value.setupCommands, 'environment.setupCommands', {
    maxItems: 12,
  });
  validateStringArrayField(issues, value.validationCommands, 'environment.validationCommands', {
    maxItems: 12,
  });
  validateStringArrayField(issues, value.requiredEnv, 'environment.requiredEnv', {
    maxItems: 40,
  });
  validateEnumField(issues, value.allowedNetwork, 'environment.allowedNetwork', [
    'none',
    'localhost',
    'public',
  ]);
  validateEnumField(issues, value.secretsPolicy, 'environment.secretsPolicy', [
    'local-only',
    'masked',
    'unrestricted',
  ]);
  validateEnumField(issues, value.windowsMode, 'environment.windowsMode', [
    'auto',
    'native-powershell',
    'wsl',
  ]);
  for (const field of ['setupCommands', 'validationCommands']) {
    const commands = Array.isArray(value[field]) ? value[field] : [];
    commands.forEach((command, index) => {
      if (typeof command === 'string' && !isSafeCommandAllowed(command)) {
        pushValidationIssue(issues, {
          path: `environment.${field}[${index}]`,
          severity: 'error',
          message: 'Command is not allowed by the Kira safe command policy.',
        });
      }
    });
  }
  if (
    typeof value.devServerCommand === 'string' &&
    value.devServerCommand.trim() &&
    !isSafeCommandAllowed(value.devServerCommand)
  ) {
    pushValidationIssue(issues, {
      path: 'environment.devServerCommand',
      severity: 'error',
      message: 'Dev server command is not allowed by the Kira safe command policy.',
    });
  }
  if (
    value.runner === 'remote-command' &&
    (typeof value.remoteCommand !== 'string' || !value.remoteCommand.includes('{command}'))
  ) {
    pushValidationIssue(issues, {
      path: 'environment.remoteCommand',
      severity: 'error',
      message: 'Remote-command runner requires a command template containing {command}.',
    });
  }
  if (value.runner === 'cloud') {
    pushValidationIssue(issues, {
      path: 'environment.runner',
      severity: 'warning',
      message: 'Cloud runner requires an enabled execution connector before work can start.',
    });
  }
}

function validateSubagentContract(
  issues: KiraOrchestrationValidationIssue[],
  value: unknown,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    pushValidationIssue(issues, {
      path: 'subagents',
      severity: 'error',
      message: 'Subagents must be an array.',
    });
    return;
  }
  const seen = new Set<string>();
  const allowedTools = new Set([
    'list_files',
    'search_files',
    'read_file',
    'write_file',
    'edit_file',
    'run_command',
  ]);
  value.forEach((agent, index) => {
    const path = `subagents[${index}]`;
    if (!isPlainRecord(agent)) {
      pushValidationIssue(issues, {
        path,
        severity: 'error',
        message: 'Subagent entry must be an object.',
      });
      return;
    }
    const id = typeof agent.id === 'string' ? agent.id.trim() : '';
    if (!id) {
      pushValidationIssue(issues, {
        path: `${path}.id`,
        severity: 'error',
        message: 'Subagent requires a stable id.',
      });
    } else if (seen.has(id)) {
      pushValidationIssue(issues, {
        path: `${path}.id`,
        severity: 'error',
        message: `Duplicate subagent id: ${id}.`,
      });
    }
    if (id) seen.add(id);
    validateStringArrayField(issues, agent.tools, `${path}.tools`, { maxItems: 20 });
    const tools = Array.isArray(agent.tools) ? agent.tools : [];
    tools.forEach((tool, toolIndex) => {
      if (typeof tool === 'string' && !allowedTools.has(tool)) {
        pushValidationIssue(issues, {
          path: `${path}.tools[${toolIndex}]`,
          severity: 'error',
          message: `Unknown Kira worker tool: ${tool}.`,
        });
      }
    });
    validateStringArrayField(issues, agent.requiredEvidence, `${path}.requiredEvidence`, {
      maxItems: 20,
    });
  });
}

function validateWorkflowContract(
  issues: KiraOrchestrationValidationIssue[],
  value: unknown,
  executionPolicy: KiraExecutionPolicy,
): void {
  if (value === undefined) return;
  if (!isPlainRecord(value)) {
    pushValidationIssue(issues, {
      path: 'workflow',
      severity: 'error',
      message: 'Workflow DAG must be an object.',
    });
    return;
  }
  if (!Array.isArray(value.nodes)) {
    pushValidationIssue(issues, {
      path: 'workflow.nodes',
      severity: 'error',
      message: 'Workflow nodes must be an array.',
    });
    return;
  }
  const nodeIds = new Set<string>();
  const requiredKinds = new Set<string>();
  value.nodes.forEach((node, index) => {
    const path = `workflow.nodes[${index}]`;
    if (!isPlainRecord(node)) {
      pushValidationIssue(issues, {
        path,
        severity: 'error',
        message: 'Workflow node must be an object.',
      });
      return;
    }
    const id = typeof node.id === 'string' ? node.id.trim() : '';
    if (!id) {
      pushValidationIssue(issues, {
        path: `${path}.id`,
        severity: 'error',
        message: 'Workflow node requires an id.',
      });
    } else if (nodeIds.has(id)) {
      pushValidationIssue(issues, {
        path: `${path}.id`,
        severity: 'error',
        message: `Duplicate workflow node id: ${id}.`,
      });
    }
    if (id) nodeIds.add(id);
    validateEnumField(issues, node.kind, `${path}.kind`, [
      'plan',
      'implement',
      'validate',
      'review',
      'integrate',
      'blocked',
      'done',
    ]);
    if (node.required !== false && typeof node.kind === 'string') {
      requiredKinds.add(node.kind);
    }
  });
  if (Array.isArray(value.edges)) {
    value.edges.forEach((edge, index) => {
      const path = `workflow.edges[${index}]`;
      if (!isPlainRecord(edge)) {
        pushValidationIssue(issues, {
          path,
          severity: 'error',
          message: 'Workflow edge must be an object.',
        });
        return;
      }
      const from = typeof edge.from === 'string' ? edge.from.trim() : '';
      const to = typeof edge.to === 'string' ? edge.to.trim() : '';
      if (!nodeIds.has(from)) {
        pushValidationIssue(issues, {
          path: `${path}.from`,
          severity: 'error',
          message: `Edge references unknown source node: ${from || '<empty>'}.`,
        });
      }
      if (!nodeIds.has(to)) {
        pushValidationIssue(issues, {
          path: `${path}.to`,
          severity: 'error',
          message: `Edge references unknown target node: ${to || '<empty>'}.`,
        });
      }
    });
  }
  if (Array.isArray(value.criticalPath)) {
    value.criticalPath.forEach((id, index) => {
      if (typeof id !== 'string' || !nodeIds.has(id)) {
        pushValidationIssue(issues, {
          path: `workflow.criticalPath[${index}]`,
          severity: 'error',
          message: `Critical path references unknown node: ${String(id)}.`,
        });
      }
    });
  }
  if (executionPolicy.requireValidation && !requiredKinds.has('validate')) {
    pushValidationIssue(issues, {
      path: 'workflow.nodes',
      severity: 'error',
      message: 'Execution policy requires validation but workflow has no required validate node.',
    });
  }
  if (executionPolicy.requireReviewerEvidence && !requiredKinds.has('review')) {
    pushValidationIssue(issues, {
      path: 'workflow.nodes',
      severity: 'error',
      message:
        'Execution policy requires reviewer evidence but workflow has no required review node.',
    });
  }
}

function validatePluginContract(issues: KiraOrchestrationValidationIssue[], value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    pushValidationIssue(issues, {
      path: 'plugins',
      severity: 'error',
      message: 'Plugins must be an array.',
    });
    return;
  }
  const seen = new Set<string>();
  value.forEach((plugin, index) => {
    const path = `plugins[${index}]`;
    if (!isPlainRecord(plugin)) {
      pushValidationIssue(issues, {
        path,
        severity: 'error',
        message: 'Plugin connector must be an object.',
      });
      return;
    }
    const id = typeof plugin.id === 'string' ? plugin.id.trim() : '';
    if (!id) {
      pushValidationIssue(issues, {
        path: `${path}.id`,
        severity: 'error',
        message: 'Plugin connector requires an id.',
      });
    } else if (seen.has(id)) {
      pushValidationIssue(issues, {
        path: `${path}.id`,
        severity: 'error',
        message: `Duplicate plugin id: ${id}.`,
      });
    }
    if (id) seen.add(id);
    validateEnumField(issues, plugin.type, `${path}.type`, [
      'github',
      'linear',
      'slack',
      'mcp',
      'custom',
    ]);
    validateEnumField(issues, plugin.policy, `${path}.policy`, ['observe', 'suggest', 'apply']);
    validateStringArrayField(issues, plugin.capabilities, `${path}.capabilities`, {
      maxItems: 20,
    });
  });
}

export function validateKiraOrchestrationContract(
  value: unknown,
  runMode: KiraRunMode = 'standard',
): KiraOrchestrationValidationReport {
  const issues: KiraOrchestrationValidationIssue[] = [];
  if (value !== undefined && !isPlainRecord(value)) {
    pushValidationIssue(issues, {
      path: '$',
      severity: 'error',
      message: 'Orchestration contract must be a JSON object.',
    });
  }
  const raw = isPlainRecord(value) ? value : {};
  validateTopLevelUnknownKeys(issues, raw);
  validateExecutionPolicyContract(issues, raw.executionPolicy);
  const executionPolicy = normalizeExecutionPolicy(raw.executionPolicy);
  validateEnvironmentContract(issues, raw.environment);
  validateSubagentContract(issues, raw.subagents);
  validateWorkflowContract(issues, raw.workflow, executionPolicy);
  validatePluginContract(issues, raw.plugins);
  const environment = normalizeEnvironmentContract(raw.environment);
  const subagents = normalizeSubagentRegistry(raw.subagents);
  const workflow = normalizeWorkflowDag(raw.workflow, runMode);
  const plugins = normalizePluginConnectors(raw.plugins);
  if (
    environment.runner === 'cloud' &&
    !plugins.some((plugin) => plugin.enabled && plugin.policy === 'apply')
  ) {
    pushValidationIssue(issues, {
      path: 'environment.runner',
      severity: 'error',
      message: 'Cloud runner requires at least one enabled apply connector.',
    });
  }
  const summary = [
    `policy=${executionPolicy.mode}`,
    `environment=${environment.runner}`,
    `subagents=${subagents.length}`,
    `workflow=${workflow.criticalPath.length}`,
    `plugins=${plugins.filter((plugin) => plugin.enabled).length}/${plugins.length}`,
  ];
  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
    normalized: {
      executionPolicy,
      environment,
      subagents,
      workflow,
      plugins,
    },
    summary,
  };
}

function normalizeQualitySnapshot(raw: unknown): KiraQualitySnapshot {
  const value =
    typeof raw === 'object' && raw !== null ? (raw as Partial<KiraQualitySnapshot>) : {};
  const attemptsTotal =
    typeof value.attemptsTotal === 'number' && Number.isFinite(value.attemptsTotal)
      ? Math.max(0, Math.round(value.attemptsTotal))
      : 0;
  const approvedAttempts =
    typeof value.approvedAttempts === 'number' && Number.isFinite(value.approvedAttempts)
      ? Math.max(0, Math.round(value.approvedAttempts))
      : 0;
  return {
    attemptsTotal,
    approvedAttempts,
    validationFailures:
      typeof value.validationFailures === 'number' && Number.isFinite(value.validationFailures)
        ? Math.max(0, Math.round(value.validationFailures))
        : 0,
    reviewRejections:
      typeof value.reviewRejections === 'number' && Number.isFinite(value.reviewRejections)
        ? Math.max(0, Math.round(value.reviewRejections))
        : 0,
    rollbacks:
      typeof value.rollbacks === 'number' && Number.isFinite(value.rollbacks)
        ? Math.max(0, Math.round(value.rollbacks))
        : 0,
    averageReadinessScore:
      typeof value.averageReadinessScore === 'number' &&
      Number.isFinite(value.averageReadinessScore)
        ? Math.max(0, Math.min(100, Math.round(value.averageReadinessScore)))
        : 0,
    passRate:
      typeof value.passRate === 'number' && Number.isFinite(value.passRate)
        ? Math.max(0, Math.min(1, value.passRate))
        : attemptsTotal > 0
          ? approvedAttempts / attemptsTotal
          : 0,
    topFailureCategories: normalizePatternList(value.topFailureCategories, [], 8),
  };
}

function normalizeDecompositionRecommendation(raw: unknown): WorkDecompositionRecommendation {
  const value =
    typeof raw === 'object' && raw !== null
      ? (raw as Partial<WorkDecompositionRecommendation>)
      : {};
  const suggestedWorks = Array.isArray(value.suggestedWorks)
    ? value.suggestedWorks.map(String)
    : [];
  const signals = Array.isArray(value.signals) ? value.signals.map(String) : [];
  return {
    shouldSplit: normalizeBoolean(value.shouldSplit) && suggestedWorks.length >= 2,
    confidence: clampConfidence(value.confidence, suggestedWorks.length >= 2 ? 0.7 : 0.3),
    reason:
      typeof value.reason === 'string' && value.reason.trim()
        ? normalizeWhitespace(value.reason)
        : suggestedWorks.length >= 2
          ? 'The work appears large enough to split into smaller implementation tasks.'
          : 'No split recommended.',
    suggestedWorks: limitedUniqueStrings(suggestedWorks, 6),
    signals: limitedUniqueStrings(signals, 8),
  };
}

function normalizeTaskType(value: unknown): KiraTaskType {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    [
      'frontend-ui',
      'backend-api',
      'test-validation',
      'tooling-config',
      'docs-maintainer',
      'data-migration',
      'security-auth',
      'generalist',
    ].includes(normalized)
  ) {
    return normalized as KiraTaskType;
  }
  return 'generalist';
}

function normalizeRequirementTrace(raw: unknown): RequirementTraceItem[] {
  if (!Array.isArray(raw)) return [];
  const usedIds = new Set<string>();
  return raw
    .map((item, index): RequirementTraceItem | null => {
      const value =
        typeof item === 'object' && item !== null ? (item as Partial<RequirementTraceItem>) : {};
      const rawId =
        typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `R${index + 1}`;
      const id = rawId.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 32) || `R${index + 1}`;
      const text =
        typeof value.text === 'string' && value.text.trim() ? normalizeWhitespace(value.text) : '';
      if (!text || usedIds.has(id)) return null;
      usedIds.add(id);
      const source =
        value.source === 'project-instruction' ||
        value.source === 'change-design' ||
        value.source === 'review'
          ? value.source
          : 'brief';
      const status =
        value.status === 'satisfied' ||
        value.status === 'partial' ||
        value.status === 'blocked' ||
        value.status === 'not_applicable'
          ? value.status
          : value.status === 'planned'
            ? 'planned'
            : undefined;
      return {
        id,
        source,
        text,
        ...(status ? { status } : {}),
        evidence: limitedUniqueStrings(
          Array.isArray(value.evidence) ? value.evidence.map(String) : [],
          6,
        ),
      };
    })
    .filter((item): item is RequirementTraceItem => item !== null)
    .slice(0, MAX_REQUIREMENT_TRACE_ITEMS);
}

function normalizePatchAlternatives(raw: unknown): PatchAlternative[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): PatchAlternative | null => {
      const value =
        typeof item === 'object' && item !== null ? (item as Partial<PatchAlternative>) : {};
      const name =
        typeof value.name === 'string' && value.name.trim() ? normalizeWhitespace(value.name) : '';
      const rationale =
        typeof value.rationale === 'string' && value.rationale.trim()
          ? normalizeWhitespace(value.rationale)
          : '';
      if (!name || !rationale) return null;
      return {
        name,
        selected: normalizeBoolean(value.selected),
        rationale,
        tradeoffs: limitedUniqueStrings(
          Array.isArray(value.tradeoffs) ? value.tradeoffs.map(String) : [],
          6,
        ),
      };
    })
    .filter((item): item is PatchAlternative => item !== null)
    .slice(0, MAX_PATCH_ALTERNATIVES);
}

function normalizeUncertaintyEscalation(raw: unknown): UncertaintyEscalation {
  const value =
    typeof raw === 'object' && raw !== null ? (raw as Partial<UncertaintyEscalation>) : {};
  const questions = limitedUniqueStrings(
    Array.isArray(value.questions) ? value.questions.map(String) : [],
    MAX_CLARIFICATION_QUESTIONS,
  );
  const blockers = limitedUniqueStrings(
    Array.isArray(value.blockers) ? value.blockers.map(String) : [],
    6,
  );
  return {
    shouldAsk: normalizeBoolean(value.shouldAsk) || blockers.length > 0,
    questions,
    blockers,
  };
}

function normalizeReviewEvidenceChecked(raw: unknown): ReviewEvidenceChecked[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): ReviewEvidenceChecked | null => {
      const value =
        typeof item === 'object' && item !== null ? (item as Partial<ReviewEvidenceChecked>) : {};
      const file = typeof value.file === 'string' ? normalizeRelativePath(value.file) : '';
      const reason =
        typeof value.reason === 'string' && value.reason.trim()
          ? normalizeWhitespace(value.reason)
          : '';
      const method =
        typeof value.method === 'string' && value.method.trim()
          ? normalizeWhitespace(value.method)
          : '';
      return file && reason && method ? { file, reason, method } : null;
    })
    .filter((item): item is ReviewEvidenceChecked => item !== null)
    .slice(0, 40);
}

function normalizeReviewerAdversarialMode(value: unknown): ReviewerAdversarialMode | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    [
      'correctness',
      'regression',
      'security',
      'runtime-ux',
      'data-safety',
      'integration',
      'maintainability',
    ].includes(normalized)
  ) {
    return normalized as ReviewerAdversarialMode;
  }
  return null;
}

function normalizeReviewAdversarialCheck(raw: unknown): ReviewAdversarialCheck | null {
  const value =
    typeof raw === 'object' && raw !== null ? (raw as Partial<ReviewAdversarialCheck>) : {};
  const mode = normalizeReviewerAdversarialMode(value.mode);
  if (!mode) return null;
  const result =
    value.result === 'passed' || value.result === 'failed' || value.result === 'not_applicable'
      ? value.result
      : 'failed';
  return {
    mode,
    result,
    evidence: limitedUniqueStrings(
      Array.isArray(value.evidence) ? value.evidence.map(String) : [],
      6,
    ),
    ...(typeof value.concern === 'string' && value.concern.trim()
      ? { concern: normalizeWhitespace(value.concern) }
      : {}),
  };
}

function normalizeReviewAdversarialChecks(raw: unknown): ReviewAdversarialCheck[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeReviewAdversarialCheck(item))
    .filter((item): item is ReviewAdversarialCheck => item !== null)
    .slice(0, 12);
}

function normalizeReviewerDiscourse(raw: unknown): ReviewerDiscourseEntry[] {
  if (!Array.isArray(raw)) return [];
  const validRoles = new Set<string>([
    'correctness',
    'regression',
    'security',
    'runtime-ux',
    'data-safety',
    'integration',
    'maintainability',
    'design-gate',
    'validation',
  ]);
  return raw
    .map((item): ReviewerDiscourseEntry | null => {
      const value =
        typeof item === 'object' && item !== null ? (item as Partial<ReviewerDiscourseEntry>) : {};
      const role = typeof value.role === 'string' ? value.role.trim() : '';
      const argument =
        typeof value.argument === 'string' ? normalizeWhitespace(value.argument) : '';
      if (!validRoles.has(role) || !argument) return null;
      const position =
        value.position === 'support' ||
        value.position === 'challenge' ||
        value.position === 'resolved'
          ? value.position
          : 'challenge';
      const response =
        typeof value.response === 'string' && value.response.trim()
          ? normalizeWhitespace(value.response)
          : undefined;
      return {
        role: role as ReviewerDiscourseEntry['role'],
        position,
        argument,
        evidence: limitedUniqueStrings(
          Array.isArray(value.evidence) ? value.evidence.map(String) : [],
          8,
        ),
        ...(response ? { response } : {}),
      };
    })
    .filter((item): item is ReviewerDiscourseEntry => item !== null)
    .slice(0, 12);
}

function normalizeChangeDesign(raw: unknown): ChangeDesign {
  const value = typeof raw === 'object' && raw !== null ? (raw as Partial<ChangeDesign>) : {};
  return {
    targetFiles: normalizePathList(Array.isArray(value.targetFiles) ? value.targetFiles : [], 20),
    invariants: limitedUniqueStrings(
      Array.isArray(value.invariants) ? value.invariants.map(String) : [],
      10,
    ),
    expectedImpact: limitedUniqueStrings(
      Array.isArray(value.expectedImpact) ? value.expectedImpact.map(String) : [],
      10,
    ),
    validationStrategy: limitedUniqueStrings(
      Array.isArray(value.validationStrategy) ? value.validationStrategy.map(String) : [],
      10,
    ),
    rollbackStrategy: limitedUniqueStrings(
      Array.isArray(value.rollbackStrategy) ? value.rollbackStrategy.map(String) : [],
      10,
    ),
  };
}

function normalizeDiffHunkReview(raw: unknown): DiffHunkReview[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const value =
        typeof item === 'object' && item !== null ? (item as Partial<DiffHunkReview>) : {};
      const file = typeof value.file === 'string' ? normalizeRelativePath(value.file) : '';
      const intent =
        typeof value.intent === 'string' && value.intent.trim()
          ? normalizeWhitespace(value.intent)
          : '';
      const risk =
        typeof value.risk === 'string' && value.risk.trim() ? normalizeWhitespace(value.risk) : '';
      return file && intent ? { file, intent, risk: risk || 'No specific risk noted.' } : null;
    })
    .filter((item): item is DiffHunkReview => item !== null)
    .slice(0, MAX_DIFF_HUNK_REVIEW_ITEMS);
}

function normalizeWorkerSelfCheck(raw: unknown): WorkerSelfCheck | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Partial<WorkerSelfCheck>;
  return {
    reviewedDiff: normalizeBoolean(value.reviewedDiff),
    followedProjectInstructions: normalizeBoolean(value.followedProjectInstructions),
    matchedPlan: normalizeBoolean(value.matchedPlan),
    ranOrExplainedValidation: normalizeBoolean(value.ranOrExplainedValidation),
    diffHunkReview: normalizeDiffHunkReview(value.diffHunkReview),
    requirementTrace: normalizeRequirementTrace(value.requirementTrace),
    uncertainty: limitedUniqueStrings(
      Array.isArray(value.uncertainty) ? value.uncertainty.map(String) : [],
      8,
    ),
    notes: limitedUniqueStrings(Array.isArray(value.notes) ? value.notes.map(String) : [], 8),
  };
}

function normalizeRelativePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
}

function normalizeCommandForComparison(command: string): string {
  return normalizeWhitespace(command).toLowerCase();
}

function normalizePathList(values: unknown[], limit: number): string[] {
  return uniqueStrings(
    values.map((value) => normalizeRelativePath(String(value))).filter((value) => value !== ''),
  ).slice(0, limit);
}

function isDocumentationOnlyChange(files: string[]): boolean {
  const normalizedFiles = normalizePathList(files, 200);
  return (
    normalizedFiles.length > 0 &&
    normalizedFiles.every((file) => DOCUMENTATION_FILE_PATTERN.test(file))
  );
}

function formatShellPath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  return /^[a-zA-Z0-9_./:@+-]+$/.test(normalized)
    ? normalized
    : `'${normalized.replace(/'/g, "''")}'`;
}

function formatIgnoredIntegrationPaths(ignoredFiles: string[]): string {
  return ignoredFiles.length > 0
    ? ` Ignored non-stageable reported paths: ${ignoredFiles.join(', ')}.`
    : '';
}

function createWorkerAttemptState(
  plan: WorkerExecutionPlan | null,
  dirtyFiles: string[] = [],
  projectRoot?: string,
  executionPolicy: KiraExecutionPolicy = DEFAULT_KIRA_EXECUTION_POLICY,
  environmentContract: KiraEnvironmentContract = DEFAULT_KIRA_ENVIRONMENT_CONTRACT,
  toolScope?: string[],
): WorkerAttemptState {
  const normalizedDirtyFiles = dirtyFiles
    .map((file) => normalizeRelativePath(file))
    .filter(Boolean);
  const normalizedToolScope = normalizePatternList(toolScope, [], 24);
  return {
    plan,
    fileSnapshots: new Map(),
    dirtyFileSnapshots: projectRoot
      ? captureDirtyFileSnapshots(projectRoot, normalizedDirtyFiles)
      : new Map(),
    executionPolicy: normalizeExecutionPolicy(executionPolicy),
    environmentContract: normalizeEnvironmentContract(environmentContract),
    toolScope: normalizedToolScope.length > 0 ? new Set(normalizedToolScope) : null,
    commandsRun: [],
    readFiles: new Set(),
    explorationActions: [],
    patchedFiles: new Set(),
    dirtyFiles: new Set(normalizedDirtyFiles),
  };
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || /aborted/i.test(error.message);
  }
  return false;
}

function createAbortError(message = 'Work was canceled or deleted.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfCanceled(
  sessionsDir: string,
  sessionPath: string,
  workId: string,
  signal?: AbortSignal,
): void {
  const workPath = getWorkFileAbsolutePath(sessionsDir, sessionPath, workId);
  if (signal?.aborted || !fs.existsSync(workPath)) {
    throw createAbortError();
  }
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf-8');
}

function listJsonFiles(dirPath: string): string[] {
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => join(dirPath, entry.name));
  } catch (error) {
    if (isRecoverableLockError(error)) return [];
    throw error;
  }
}

function getKiraDataDir(sessionsDir: string, sessionPath: string): string {
  return join(sessionsDir, sanitizeSessionPath(sessionPath), 'apps', 'kira', 'data');
}

function getKiraAnalysisDir(sessionsDir: string, sessionPath: string): string {
  return join(getKiraDataDir(sessionsDir, sessionPath), ANALYSIS_DIR_NAME);
}

function getKiraAttemptsDir(sessionsDir: string, sessionPath: string): string {
  return join(getKiraDataDir(sessionsDir, sessionPath), ATTEMPTS_DIR_NAME);
}

function getKiraReviewsDir(sessionsDir: string, sessionPath: string): string {
  return join(getKiraDataDir(sessionsDir, sessionPath), REVIEWS_DIR_NAME);
}

function getKiraWorktreesDir(sessionsDir: string, sessionPath: string): string {
  return join(getKiraDataDir(sessionsDir, sessionPath), WORKTREES_DIR_NAME);
}

function isKiraProjectRoot(directory: string): boolean {
  try {
    return KIRA_PROJECT_ROOT_MARKERS.some((marker) => fs.existsSync(join(directory, marker)));
  } catch {
    return false;
  }
}

export function resolveKiraProjectRoot(
  workRootDirectory: string | null | undefined,
  projectName: string | null | undefined,
): string {
  const root = workRootDirectory?.trim();
  const project = projectName?.trim();
  if (!root || !project) return '';

  const resolvedRoot = resolve(root);
  if (
    isKiraProjectRoot(resolvedRoot) &&
    basename(resolvedRoot).toLowerCase() === project.toLowerCase()
  ) {
    return resolvedRoot;
  }

  return resolve(join(resolvedRoot, project));
}

function getProjectSettingsPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_SETTINGS_DIR_NAME, PROJECT_SETTINGS_FILE_NAME);
}

export function getProjectProfilePath(projectRoot: string): string {
  return join(projectRoot, PROJECT_SETTINGS_DIR_NAME, PROJECT_PROFILE_FILE_NAME);
}

function getWorkFileAbsolutePath(sessionsDir: string, sessionPath: string, workId: string): string {
  return join(getKiraDataDir(sessionsDir, sessionPath), WORKS_DIR_NAME, `${workId}.json`);
}

function getProjectDiscoveryFilePath(
  sessionsDir: string,
  sessionPath: string,
  projectName: string,
): string {
  return join(
    getKiraAnalysisDir(sessionsDir, sessionPath),
    `project-discovery-${sanitizeLockKey(projectName.toLowerCase())}.json`,
  );
}

export function resolveProjectSettings(
  raw: unknown,
  fallback: Partial<KiraProjectSettings> = {},
): ResolvedKiraProjectSettings {
  const parsed = typeof raw === 'object' && raw !== null ? (raw as KiraProjectSettings) : {};
  const hasProjectRequiredInstructions = Object.prototype.hasOwnProperty.call(
    parsed,
    'requiredInstructions',
  );
  const projectRequiredInstructions = hasProjectRequiredInstructions
    ? normalizeProjectRequiredInstructions(parsed.requiredInstructions)
    : null;
  const hasProjectRulePacks = Object.prototype.hasOwnProperty.call(parsed, 'rulePacks');
  const fallbackRulePacks = normalizeRulePackSettings(fallback.rulePacks);
  const rulePacks = normalizeRulePackSettings(
    parsed.rulePacks,
    hasProjectRulePacks ? [] : fallbackRulePacks,
  );
  const requiredInstructions =
    projectRequiredInstructions ??
    normalizeProjectRequiredInstructions(fallback.requiredInstructions);
  const runMode = normalizeRunMode(parsed.runMode, normalizeRunMode(fallback.runMode));
  const hasExecutionPolicy = Object.prototype.hasOwnProperty.call(parsed, 'executionPolicy');
  const hasEnvironment = Object.prototype.hasOwnProperty.call(parsed, 'environment');
  const hasSubagents = Object.prototype.hasOwnProperty.call(parsed, 'subagents');
  const hasWorkflow = Object.prototype.hasOwnProperty.call(parsed, 'workflow');
  const hasPlugins = Object.prototype.hasOwnProperty.call(parsed, 'plugins');
  const executionPolicy = normalizeExecutionPolicy(
    hasExecutionPolicy ? parsed.executionPolicy : fallback.executionPolicy,
    normalizeExecutionPolicy(fallback.executionPolicy),
  );
  const environment = normalizeEnvironmentContract(
    hasEnvironment ? parsed.environment : fallback.environment,
    normalizeEnvironmentContract(fallback.environment),
  );
  const subagents = normalizeSubagentRegistry(hasSubagents ? parsed.subagents : fallback.subagents);
  const workflow = normalizeWorkflowDag(hasWorkflow ? parsed.workflow : fallback.workflow, runMode);
  const plugins = normalizePluginConnectors(hasPlugins ? parsed.plugins : fallback.plugins);
  return {
    autoCommit:
      typeof parsed.autoCommit === 'boolean'
        ? parsed.autoCommit
        : typeof fallback.autoCommit === 'boolean'
          ? fallback.autoCommit
          : true,
    requiredInstructions,
    effectiveInstructions: buildEffectiveProjectInstructions(requiredInstructions, rulePacks),
    runMode,
    rulePacks,
    executionPolicy,
    environment,
    subagents,
    workflow,
    plugins,
  };
}

function loadProjectSettings(
  projectRoot: string,
  fallback: Partial<KiraProjectSettings> = {},
): ResolvedKiraProjectSettings {
  const raw = readJsonFile<KiraProjectSettings>(getProjectSettingsPath(projectRoot));
  return resolveProjectSettings(raw, fallback);
}

function getAutomationEventQueuePath(sessionsDir: string, sessionPath: string): string {
  return join(sessionsDir, sanitizeSessionPath(sessionPath), 'chat', EVENT_QUEUE_FILE);
}

function getSessionAutomationLocksDir(sessionsDir: string, sessionPath: string): string {
  return join(getKiraDataDir(sessionsDir, sessionPath), LOCKS_DIR_NAME);
}

function getGlobalAutomationLocksDir(sessionsDir: string): string {
  return join(sessionsDir, GLOBAL_LOCKS_DIR_NAME);
}

function sanitizeLockKey(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 180) || 'lock'
  );
}

function getWorkLockPath(sessionsDir: string, sessionPath: string, workId: string): string {
  return join(
    getSessionAutomationLocksDir(sessionsDir, sessionPath),
    `work-${sanitizeLockKey(workId)}.json`,
  );
}

function getProjectLockPath(sessionsDir: string, projectKey: string): string {
  return join(
    getGlobalAutomationLocksDir(sessionsDir),
    `project-${sanitizeLockKey(projectKey)}.json`,
  );
}

function loadAutomationEvents(sessionsDir: string, sessionPath: string): KiraAutomationEvent[] {
  const queuePath = getAutomationEventQueuePath(sessionsDir, sessionPath);
  return readJsonFile<KiraAutomationEvent[]>(queuePath) ?? [];
}

function shouldSuppressAutomationEvent(event: KiraAutomationEvent): boolean {
  return (
    event.title === 'Kira automation scan' &&
    event.type === 'needs_attention' &&
    isRecoverableAutomationLockMessage(event.message)
  );
}

function enqueueEvent(sessionsDir: string, sessionPath: string, event: KiraAutomationEvent): void {
  if (shouldSuppressAutomationEvent(event)) return;
  const queuePath = getAutomationEventQueuePath(sessionsDir, sessionPath);
  const queue = loadAutomationEvents(sessionsDir, sessionPath).filter(
    (item) => !shouldSuppressAutomationEvent(item),
  );
  queue.push(event);
  writeJsonFile(queuePath, queue);
}

function drainEvents(sessionsDir: string, sessionPath: string): KiraAutomationEvent[] {
  const queuePath = getAutomationEventQueuePath(sessionsDir, sessionPath);
  const events = loadAutomationEvents(sessionsDir, sessionPath);
  if (events.length > 0) {
    writeJsonFile(queuePath, []);
  }
  return events.filter((event) => !shouldSuppressAutomationEvent(event));
}

function discoverSessionPaths(sessionsDir: string): string[] {
  const found = new Set<string>();

  const walk = (currentDir: string) => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (error) {
      if (isRecoverableLockError(error)) return;
      throw error;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      if (dirent.name === LOCKS_DIR_NAME || dirent.name === GLOBAL_LOCKS_DIR_NAME) continue;
      const absolutePath = join(currentDir, dirent.name);
      const relativePath = absolutePath.slice(sessionsDir.length).replace(/^[\\/]+/, '');
      const normalized = relativePath.replace(/\\/g, '/');
      if (normalized.endsWith('/apps/kira/data/works')) {
        const segments = normalized.split('/');
        const appsIndex = segments.indexOf('apps');
        if (appsIndex > 0) {
          found.add(segments.slice(0, appsIndex).join('/'));
        }
        continue;
      }
      walk(absolutePath);
    }
  };

  try {
    if (fs.existsSync(sessionsDir) && fs.statSync(sessionsDir).isDirectory()) {
      walk(sessionsDir);
    }
  } catch (error) {
    if (!isRecoverableLockError(error)) throw error;
  }
  return [...found];
}

function loadLlmConfig(configFile: string): LLMConfig | null {
  try {
    if (!fs.existsSync(configFile)) return null;
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as { llm?: LLMConfig };
    if (!raw.llm?.model?.trim()) return null;
    if (raw.llm.provider !== 'codex-cli' && !raw.llm.baseUrl?.trim()) return null;
    return {
      ...raw.llm,
      apiKey: raw.llm.apiKey ?? '',
      customHeaders: raw.llm.customHeaders?.trim() || undefined,
    };
  } catch {
    return null;
  }
}

function loadKiraSettings(configFile: string): KiraSettings {
  try {
    if (!fs.existsSync(configFile)) return {};
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as { kira?: KiraSettings };
    return typeof raw.kira === 'object' && raw.kira !== null ? raw.kira : {};
  } catch {
    return {};
  }
}

function buildAgentLabel(base: string, model: string | null | undefined): string {
  const normalized = model?.trim();
  return normalized ? `${base} - ${normalized}` : base;
}

function isWorkerAuthor(author: string): boolean {
  return author === WORKER_AUTHOR || author.startsWith(`${WORKER_AUTHOR} - `);
}

function isReviewerAuthor(author: string): boolean {
  return author === REVIEWER_AUTHOR || author.startsWith(`${REVIEWER_AUTHOR} - `);
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getOptionalApiStyle(value: unknown): LLMApiStyle | undefined {
  return value === 'openai-chat' || value === 'openai-responses' || value === 'anthropic-messages'
    ? value
    : undefined;
}

function defaultBaseUrlForProvider(provider: LLMProvider | undefined): string | undefined {
  if (provider === 'opencode') return 'https://opencode.ai/zen';
  if (provider === 'opencode-go') return 'https://opencode.ai/zen/go';
  return undefined;
}

function isCodexCliProvider(provider: LLMProvider | undefined): boolean {
  return provider === 'codex-cli';
}

function isOpenCodeProvider(provider: LLMProvider | undefined): boolean {
  return provider === 'opencode' || provider === 'opencode-go';
}

function normalizeProviderModel(config: Pick<LLMConfig, 'provider' | 'model'>): string {
  const model = config.model.trim();
  if (config.provider === 'opencode' && model.startsWith('opencode/')) {
    return model.slice('opencode/'.length);
  }
  if (config.provider === 'opencode-go' && model.startsWith('opencode-go/')) {
    return model.slice('opencode-go/'.length);
  }
  return model;
}

function normalizeKiraModelRouteBaseUrl(baseUrl: string): string
{
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed)
  {
    return '';
  }

  try
  {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '').toLowerCase();
  }
  catch
  {
    return trimmed.toLowerCase();
  }
}

function isPrivateIpv4Host(hostname: string): boolean
{
  const parts = hostname.split('.').map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
  {
    return false;
  }

  const [first, second] = parts;
  if (first === 10)
  {
    return true;
  }
  if (first === 127)
  {
    return true;
  }
  if (first === 169 && second === 254)
  {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31)
  {
    return true;
  }
  if (first === 192 && second === 168)
  {
    return true;
  }
  return first === 0 && second === 0 && parts[2] === 0 && parts[3] === 0;
}

export function isKiraLocalModelRoute(config: Pick<LLMConfig, 'provider' | 'baseUrl'>): boolean
{
  if (config.provider === 'llama.cpp')
  {
    return true;
  }

  const baseUrl = config.baseUrl.trim();
  if (!baseUrl)
  {
    return false;
  }

  try
  {
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname === '::1')
    {
      return true;
    }
    return isPrivateIpv4Host(hostname);
  }
  catch
  {
    return /^(?:https?:\/\/)?(?:localhost|127\.|0\.0\.0\.0|\[?::1\]?)/i.test(baseUrl);
  }
}

export function getKiraModelRouteLimit(config: Pick<LLMConfig, 'provider' | 'baseUrl'>): number
{
  return isKiraLocalModelRoute(config)
    ? KIRA_LOCAL_MODEL_ROUTE_LIMIT
    : KIRA_REMOTE_MODEL_ROUTE_LIMIT;
}

export function getKiraModelRouteKey(
  config: Pick<LLMConfig, 'provider' | 'baseUrl' | 'model'>,
): string
{
  return [
    config.provider,
    normalizeKiraModelRouteBaseUrl(config.baseUrl),
    normalizeProviderModel(config).toLowerCase(),
  ].join('|');
}

function makeKiraRouteAbortError(): Error
{
  const error = new Error('Agent run aborted.');
  error.name = 'AbortError';
  return error;
}

function getKiraModelRouteLock(routeKey: string): KiraModelRouteLock
{
  let lock = kiraModelRouteLocks.get(routeKey);
  if (!lock)
  {
    lock = {
      active: 0,
      queue: [],
    };
    kiraModelRouteLocks.set(routeKey, lock);
  }
  return lock;
}

function releaseKiraModelRouteSlot(routeKey: string): void
{
  const lock = kiraModelRouteLocks.get(routeKey);
  if (!lock)
  {
    return;
  }

  lock.active = Math.max(0, lock.active - 1);
  const next = lock.queue.shift();
  if (next)
  {
    next();
    return;
  }

  if (lock.active === 0)
  {
    kiraModelRouteLocks.delete(routeKey);
  }
}

function acquireKiraModelRouteSlot(
  routeKey: string,
  limit: number,
  signal?: AbortSignal,
): Promise<() => void>
{
  if (signal?.aborted)
  {
    return Promise.reject(makeKiraRouteAbortError());
  }

  const lock = getKiraModelRouteLock(routeKey);
  if (lock.active < limit)
  {
    lock.active += 1;
    return Promise.resolve((): void =>
    {
      releaseKiraModelRouteSlot(routeKey);
    });
  }

  return new Promise((resolve, reject) =>
  {
    let settled = false;

    const start = (): void =>
    {
      if (settled)
      {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', abort);
      lock.active += 1;
      resolve((): void =>
      {
        releaseKiraModelRouteSlot(routeKey);
      });
    };

    const abort = (): void =>
    {
      if (settled)
      {
        return;
      }
      settled = true;
      const index = lock.queue.indexOf(start);
      if (index >= 0)
      {
        lock.queue.splice(index, 1);
      }
      reject(makeKiraRouteAbortError());
    };

    lock.queue.push(start);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function runWithKiraModelRouteLimit<T>(
  config: LLMConfig,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T>
{
  const routeKey = getKiraModelRouteKey(config);
  const routeLimit = getKiraModelRouteLimit(config);
  const release = await acquireKiraModelRouteSlot(routeKey, routeLimit, signal);
  try
  {
    return await task();
  }
  finally
  {
    release();
  }
}

function resolveOpenCodeApiKey(config: LLMConfig): string {
  if (!isOpenCodeProvider(config.provider) || config.apiKey.trim()) return config.apiKey;
  return (
    process.env.OPENCODE_API_KEY ??
    process.env.OPENCODE_ZEN_API_KEY ??
    process.env.OPENCODE_GO_API_KEY ??
    ''
  );
}

function resolveOpenCodeApiStyle(config: LLMConfig): LLMApiStyle {
  if (config.apiStyle) return config.apiStyle;
  const model = normalizeProviderModel(config).toLowerCase();
  if (model.startsWith('gpt-')) return 'openai-responses';
  if (model.startsWith('claude-')) return 'anthropic-messages';
  if (config.provider === 'opencode-go' && /^minimax-m2\./.test(model)) {
    return 'anthropic-messages';
  }
  return 'openai-chat';
}

function isKimiToolReasoningSensitiveModel(config: Pick<LLMConfig, 'provider' | 'model'>): boolean {
  const model = normalizeProviderModel(config).toLowerCase();
  return model.includes('kimi-k2');
}

function shouldDisableOpenAiThinking(config: LLMConfig): boolean {
  if (!isOpenCodeProvider(config.provider) && config.provider !== 'kimi') return false;
  return isKimiToolReasoningSensitiveModel(config);
}

export function getOpenAiAssistantReasoningContent(
  config: Pick<LLMConfig, 'provider' | 'model'>,
  message: Pick<Extract<AgentMessage, { role: 'assistant' }>, 'reasoningContent' | 'toolCalls'>,
): string | undefined {
  const existing = message.reasoningContent?.trim();
  if (existing) return existing;
  if (message.toolCalls?.length && isKimiToolReasoningSensitiveModel(config)) {
    return KIMI_TOOL_CALL_REASONING_FALLBACK;
  }
  return undefined;
}

function isCodexCliModelUpgradeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /requires a newer version of Codex/i.test(message);
}

export function resolveRoleLlmConfig(
  baseConfig: LLMConfig | null,
  override: Partial<LLMConfig> | null | undefined,
  legacyModel: string | null | undefined,
): LLMConfig | null {
  const overrideProvider = getOptionalString(override?.provider) as LLMProvider | undefined;
  const provider = overrideProvider ?? baseConfig?.provider;
  const canInheritBaseProviderSettings =
    !overrideProvider || overrideProvider === baseConfig?.provider;
  const baseUrl =
    getOptionalString(override?.baseUrl) ??
    (canInheritBaseProviderSettings ? baseConfig?.baseUrl : undefined) ??
    defaultBaseUrlForProvider(provider as LLMProvider | undefined);
  const model =
    getOptionalString(override?.model) ??
    getOptionalString(legacyModel) ??
    (canInheritBaseProviderSettings ? baseConfig?.model : undefined);
  const apiKey =
    override?.apiKey ?? (canInheritBaseProviderSettings ? baseConfig?.apiKey : undefined) ?? '';
  const customHeaders =
    getOptionalString(override?.customHeaders) ??
    (canInheritBaseProviderSettings ? baseConfig?.customHeaders : undefined);
  const command =
    getOptionalString(override?.command) ??
    (canInheritBaseProviderSettings ? baseConfig?.command : undefined);
  const apiStyle =
    getOptionalApiStyle(override?.apiStyle) ??
    (canInheritBaseProviderSettings ? baseConfig?.apiStyle : undefined);
  const name =
    getOptionalString(override?.name) ??
    (canInheritBaseProviderSettings ? baseConfig?.name : undefined);

  if (!provider) return null;
  if (isCodexCliProvider(provider as LLMProvider)) {
    return {
      provider: provider as LLMProvider,
      apiKey: '',
      baseUrl: '',
      model: model ?? '',
      ...(command ? { command } : {}),
      ...(name ? { name } : {}),
    };
  }
  if (!baseUrl || !model) return null;

  return {
    provider: provider as LLMProvider,
    apiKey,
    baseUrl,
    model,
    ...(customHeaders ? { customHeaders } : {}),
    ...(command ? { command } : {}),
    ...(apiStyle ? { apiStyle } : {}),
    ...(name ? { name } : {}),
  };
}

export function resolveWorkerLlmConfigs(
  baseConfig: LLMConfig | null,
  kiraSettings: KiraSettings,
): LLMConfig[] {
  const rawWorkers = Array.isArray(kiraSettings.workers) ? kiraSettings.workers.slice(0, 3) : [];
  const workerConfigs =
    rawWorkers.length > 0
      ? rawWorkers
          .map((worker, index) =>
            resolveRoleLlmConfig(
              baseConfig,
              {
                ...worker,
                name: worker.name ?? `Worker ${index + 1}`,
              },
              null,
            ),
          )
          .filter((config): config is LLMConfig => config !== null)
      : [resolveRoleLlmConfig(baseConfig, kiraSettings.workerLlm, kiraSettings.workerModel)].filter(
          (config): config is LLMConfig => config !== null,
        );

  return workerConfigs.slice(0, 3);
}

function getKiraRuntimeSettings(configFile: string, fallbackWorkRootDirectory: string | null) {
  const llmConfig = loadLlmConfig(configFile);
  const kiraSettings = loadKiraSettings(configFile);
  const workRootDirectory = kiraSettings.workRootDirectory?.trim() || fallbackWorkRootDirectory;
  const workerConfigs = resolveWorkerLlmConfigs(llmConfig, kiraSettings);
  const workerConfig = workerConfigs[0] ?? null;
  const reviewerConfig = resolveRoleLlmConfig(
    llmConfig,
    kiraSettings.reviewerLlm,
    kiraSettings.reviewerModel,
  );
  const workerModel = workerConfig?.model ?? null;
  const reviewerModel = reviewerConfig?.model ?? null;

  return {
    workRootDirectory,
    defaultProjectSettings: resolveProjectSettings(kiraSettings.projectDefaults),
    workerModel,
    reviewerModel,
    workerAuthor: buildAgentLabel(WORKER_AUTHOR, workerModel),
    reviewerAuthor: buildAgentLabel(REVIEWER_AUTHOR, reviewerModel),
    workerConfig,
    workerConfigs,
    reviewerConfig,
  };
}

function selectRunnableSubagents(
  subagents: KiraSubagentDefinition[] | undefined,
): KiraSubagentDefinition[] {
  const enabled = (subagents ?? []).filter((agent) => agent.enabled);
  const implementers = enabled.filter((agent) =>
    agent.tools.some((tool) => ['edit_file', 'write_file', 'run_command'].includes(tool)),
  );
  return (implementers.length > 0 ? implementers : enabled).slice(0, 12);
}

function getPrimaryImplementationSubagent(
  subagents: KiraSubagentDefinition[] | undefined,
): KiraSubagentDefinition | undefined {
  const runnable = selectRunnableSubagents(subagents);
  return (
    runnable.find((agent) => agent.id === 'implementer') ??
    runnable.find((agent) => /implement|worker|builder|developer/i.test(agent.id)) ??
    runnable[0]
  );
}

function buildWorkerLanes(
  workerConfigs: LLMConfig[],
  subagents?: KiraSubagentDefinition[],
): KiraWorkerLane[] {
  const runnableSubagents = selectRunnableSubagents(subagents);
  return workerConfigs.slice(0, 3).map((config, index) => {
    const subagent = runnableSubagents[index % Math.max(1, runnableSubagents.length)];
    const configuredName = config.name?.trim();
    const baseLabel =
      configuredName || subagent?.label || `Worker ${String.fromCharCode(65 + index)}`;
    return {
      id: `worker-${index + 1}`,
      label: buildAgentLabel(baseLabel, config.model),
      config,
      ...(subagent ? { subagent } : {}),
    };
  });
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function hasVersionSuffix(url: string): boolean {
  return /\/v\d+\/?$/.test(url);
}

function getOpenAICompletionsPath(baseUrl: string): string {
  return hasVersionSuffix(baseUrl) ? 'chat/completions' : 'v1/chat/completions';
}

function getAnthropicMessagesPath(baseUrl: string): string {
  return hasVersionSuffix(baseUrl) ? 'messages' : 'v1/messages';
}

function parseCustomHeaders(raw?: string): Record<string, string> {
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(':');
    if (index <= 0) continue;
    headers[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return headers;
}

function isAnthropicProvider(provider: LLMProvider): boolean {
  return provider === 'anthropic' || provider === 'minimax';
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // ignore
  }

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    const candidate = codeBlockMatch[1].trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // ignore
    }
  }

  const firstBrace = trimmed.indexOf('{');
  if (firstBrace >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let index = firstBrace; index < trimmed.length; index += 1) {
      const ch = trimmed[index];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      if (depth === 0) return trimmed.slice(firstBrace, index + 1);
    }
  }

  return trimmed;
}

function normalizeToolArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function splitParameterSchema(parameters: Record<string, unknown>): {
  properties: Record<string, unknown>;
  required: string[];
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, rawValue] of Object.entries(parameters)) {
    const value = (rawValue ?? {}) as Record<string, unknown>;
    const { required: isRequired, ...rest } = value;
    properties[key] = rest;
    if (isRequired === true) required.push(key);
  }

  return { properties, required };
}

function toOpenAITools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: (() => {
        const schema = splitParameterSchema(tool.parameters);
        return {
          type: 'object',
          properties: schema.properties,
          required: schema.required,
        };
      })(),
    },
  }));
}

function toAnthropicTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: (() => {
      const schema = splitParameterSchema(tool.parameters);
      return {
        type: 'object',
        properties: schema.properties,
        required: schema.required,
      };
    })(),
  }));
}

function toResponsesTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: (() => {
      const schema = splitParameterSchema(tool.parameters);
      return {
        type: 'object',
        properties: schema.properties,
        required: schema.required,
      };
    })(),
  }));
}

async function fetchLlmWithTimeout(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LLM_REQUEST_TIMEOUT_MS);
  timeout.unref?.();

  const abortHandler = () => controller.abort();
  signal?.addEventListener('abort', abortHandler, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new Error(`LLM request timed out after ${LLM_REQUEST_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortHandler);
  }
}

async function callOpenAiCompatible(
  config: LLMConfig,
  systemPrompt: string,
  history: AgentMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[]; reasoningContent?: string }> {
  const targetUrl = joinUrl(config.baseUrl, getOpenAICompletionsPath(config.baseUrl));
  const apiKey = resolveOpenCodeApiKey(config);
  const messages = history.map((message) => {
    if (message.role === 'assistant') {
      const reasoningContent = getOpenAiAssistantReasoningContent(config, message);
      return {
        role: 'assistant',
        content: message.content,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(message.toolCalls
          ? {
              tool_calls: message.toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: 'function',
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.args),
                },
              })),
            }
          : {}),
      };
    }
    if (message.role === 'tool') {
      return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
    }
    return { role: 'user', content: message.content };
  });

  const body: Record<string, unknown> = {
    model: normalizeProviderModel(config),
    messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages,
    max_tokens: KIRA_LLM_MAX_OUTPUT_TOKENS,
    stream: false,
  };
  if (shouldDisableOpenAiThinking(config)) {
    body.thinking = { type: 'disabled' };
    body.reasoning = { enabled: false };
  }
  if (tools.length > 0) body.tools = toOpenAITools(tools);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...parseCustomHeaders(config.customHeaders),
  };
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchLlmWithTimeout(
    targetUrl,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    signal,
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LLM API error ${res.status}: ${text}`);
  }
  const data = JSON.parse(text) as {
    choices?: Array<{
      message?: {
        content?: string;
        reasoning_content?: string;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };
  const message = data.choices?.[0]?.message;
  const toolCalls =
    message?.tool_calls?.map((toolCall, index) => ({
      id: toolCall.id || `tool_${index}`,
      name: toolCall.function?.name || '',
      args: normalizeToolArguments(toolCall.function?.arguments || '{}'),
    })) ?? [];
  return {
    content: message?.content?.trim() || '',
    toolCalls: toolCalls.filter((tool) => tool.name),
    reasoningContent: message?.reasoning_content,
  };
}

async function callOpenAiResponses(
  config: LLMConfig,
  systemPrompt: string,
  history: AgentMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[]; reasoningContent?: string }> {
  const targetUrl = joinUrl(
    config.baseUrl,
    hasVersionSuffix(config.baseUrl) ? 'responses' : 'v1/responses',
  );
  const apiKey = resolveOpenCodeApiKey(config);
  const input: Array<Record<string, unknown>> = [];

  for (const message of history) {
    if (message.role === 'assistant') {
      if (message.content) {
        input.push({ role: 'assistant', content: message.content });
      }
      for (const toolCall of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.args),
        });
      }
      continue;
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.content,
      });
      continue;
    }
    input.push({ role: 'user', content: message.content });
  }

  const body: Record<string, unknown> = {
    model: normalizeProviderModel(config),
    input,
    max_output_tokens: KIRA_LLM_MAX_OUTPUT_TOKENS,
    stream: false,
  };
  if (systemPrompt) body.instructions = systemPrompt;
  if (tools.length > 0) body.tools = toResponsesTools(tools);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...parseCustomHeaders(config.customHeaders),
  };
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchLlmWithTimeout(
    targetUrl,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    signal,
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Responses API error ${res.status}: ${text}`);
  }
  const data = JSON.parse(text) as {
    output_text?: string;
    output?: Array<
      | {
          type?: 'message';
          content?: Array<{ type?: string; text?: string; output_text?: string }>;
        }
      | {
          type?: 'function_call';
          call_id?: string;
          id?: string;
          name?: string;
          arguments?: string;
        }
    >;
  };
  const contentParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const item of data.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        const textPart = part.text ?? part.output_text ?? '';
        if (textPart) contentParts.push(textPart);
      }
    }
    if (item.type === 'function_call' && item.name) {
      toolCalls.push({
        id: item.call_id || item.id || `tool_${toolCalls.length}`,
        name: item.name,
        args: normalizeToolArguments(item.arguments || '{}'),
      });
    }
  }

  return {
    content: (data.output_text || contentParts.join('')).trim(),
    toolCalls,
  };
}

async function callAnthropicCompatible(
  config: LLMConfig,
  systemPrompt: string,
  history: AgentMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[]; reasoningContent?: string }> {
  const targetUrl = joinUrl(config.baseUrl, getAnthropicMessagesPath(config.baseUrl));
  const apiKey = resolveOpenCodeApiKey(config);
  const messages = history.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: message.content,
          },
        ],
      };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...message.toolCalls.map((toolCall) => ({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.args,
          })),
        ],
      };
    }
    return { role: message.role, content: message.content };
  });

  const body: Record<string, unknown> = {
    model: normalizeProviderModel(config),
    max_tokens: KIRA_LLM_MAX_OUTPUT_TOKENS,
    messages,
  };
  if (systemPrompt) body.system = systemPrompt;
  if (tools.length > 0) body.tools = toAnthropicTools(tools);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...parseCustomHeaders(config.customHeaders),
  };
  if (apiKey.trim()) headers['x-api-key'] = apiKey;

  const res = await fetchLlmWithTimeout(
    targetUrl,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    signal,
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }
  const data = JSON.parse(text) as {
    content?: Array<
      | { type: 'text'; text?: string }
      | { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
    >;
  };
  const content = (data.content ?? [])
    .filter((block): block is { type: 'text'; text?: string } => block.type === 'text')
    .map((block) => block.text || '')
    .join('')
    .trim();
  const toolCalls = (data.content ?? [])
    .filter(
      (
        block,
      ): block is {
        type: 'tool_use';
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      } => block.type === 'tool_use',
    )
    .map((block, index) => ({
      id: block.id || `tool_${index}`,
      name: block.name || '',
      args: block.input ?? {},
    }))
    .filter((tool) => tool.name);
  return { content, toolCalls };
}

async function callLlm(
  config: LLMConfig,
  systemPrompt: string,
  history: AgentMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[]; reasoningContent?: string }> {
  return runWithKiraModelRouteLimit(
    config,
    async () =>
    {
      if (isOpenCodeProvider(config.provider))
      {
        const apiStyle = resolveOpenCodeApiStyle(config);
        if (apiStyle === 'openai-responses')
        {
          return callOpenAiResponses(config, systemPrompt, history, tools, signal);
        }
        if (apiStyle === 'anthropic-messages')
        {
          return callAnthropicCompatible(config, systemPrompt, history, tools, signal);
        }
        return callOpenAiCompatible(config, systemPrompt, history, tools, signal);
      }
      return isAnthropicProvider(config.provider)
        ? callAnthropicCompatible(config, systemPrompt, history, tools, signal)
        : callOpenAiCompatible(config, systemPrompt, history, tools, signal);
    },
    signal,
  );
}

function ensureInsideRoot(root: string, candidatePath: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(root, candidatePath);
  const prefix =
    resolvedRoot.endsWith('\\') || resolvedRoot.endsWith('/')
      ? resolvedRoot
      : `${resolvedRoot}${process.platform === 'win32' ? '\\' : '/'}`;
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(prefix)) {
    throw new Error('Path escapes the project root.');
  }
  return resolvedCandidate;
}

function containsCorruptionMarker(content: string): boolean {
  return /rest of file unchanged/i.test(content);
}

export function hasMergeConflictMarkers(content: string): boolean {
  return /^(<{7}|={7}|>{7})(?: .*)?$/m.test(content);
}

export function isSafeCommandAllowed(command: string): boolean {
  const normalized = normalizeWhitespace(command);
  if (!normalized) return false;
  if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isToolAllowedByScope(
  toolName: string,
  state: WorkerAttemptState | null | undefined,
): boolean {
  if (!state?.toolScope || state.toolScope.size === 0) return true;
  return state.toolScope.has(toolName);
}

function collectEnvironmentCommandIssues(environmentInput: unknown, command: string): string[] {
  const environment = normalizeEnvironmentContract(environmentInput);
  const normalized = normalizeWhitespace(command);
  const issues: string[] = [];
  if (!normalized) return issues;

  if (environment.allowedNetwork === 'none' && NETWORK_COMMAND_PATTERN.test(normalized)) {
    issues.push(
      `Environment contract blocks network-capable command while allowedNetwork=none: ${normalized}.`,
    );
  }
  if (
    environment.allowedNetwork === 'localhost' &&
    /https?:\/\//i.test(normalized) &&
    !/https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/i.test(normalized)
  ) {
    issues.push(
      `Environment contract allows only localhost network access for command: ${normalized}.`,
    );
  }
  if (
    environment.secretsPolicy !== 'unrestricted' &&
    ENV_DISCLOSURE_COMMAND_PATTERN.test(normalized)
  ) {
    issues.push(
      'Environment contract blocks commands that can disclose process environment secrets.',
    );
  }
  if (environment.runner !== 'local' && environment.secretsPolicy === 'local-only') {
    const secretNames = environment.requiredEnv.filter((name) =>
      SECRET_ENV_NAME_PATTERN.test(name),
    );
    if (secretNames.length > 0) {
      issues.push(
        `Environment contract keeps secret env vars local-only for remote runner: ${secretNames.join(', ')}.`,
      );
    }
  }
  return limitedUniqueStrings(issues, 8);
}

function buildChildProcessEnv(environmentInput?: KiraEnvironmentContract): NodeJS.ProcessEnv {
  const environment = normalizeEnvironmentContract(environmentInput);
  const nextEnv: NodeJS.ProcessEnv = { ...process.env };
  if (environment.secretsPolicy === 'unrestricted') return nextEnv;

  const shouldMask = environment.secretsPolicy === 'masked' || environment.runner !== 'local';
  if (!shouldMask) return nextEnv;

  for (const key of Object.keys(nextEnv)) {
    if (SECRET_ENV_NAME_PATTERN.test(key)) {
      nextEnv[key] = '';
    }
  }
  return nextEnv;
}

function readDirtyFileContentSnapshot(
  projectRoot: string,
  relativePath: string,
): DirtyFileContentSnapshot {
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath || isGeneratedArtifactPath(normalizedPath)) {
    return { exists: false, hash: null, size: null };
  }

  try {
    const absolutePath = ensureInsideRoot(projectRoot, normalizedPath);
    if (!fs.existsSync(absolutePath)) {
      return { exists: false, hash: null, size: null };
    }

    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      return { exists: false, hash: null, size: null };
    }

    const content = fs.readFileSync(absolutePath);
    return {
      exists: true,
      hash: createHash('sha256').update(content).digest('hex'),
      size: content.length,
    };
  } catch {
    return { exists: false, hash: null, size: null };
  }
}

export function captureDirtyFileSnapshots(
  projectRoot: string,
  dirtyFiles: string[],
): Map<string, DirtyFileContentSnapshot> {
  const snapshots = new Map<string, DirtyFileContentSnapshot>();
  for (const filePath of normalizePathList(dirtyFiles, 500)) {
    if (isGeneratedArtifactPath(filePath)) continue;
    snapshots.set(filePath, readDirtyFileContentSnapshot(projectRoot, filePath));
  }
  return snapshots;
}

function captureAttemptFileSnapshot(
  state: WorkerAttemptState | null | undefined,
  projectRoot: string,
  relativePath: string,
): void {
  if (!state) return;
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath || state.fileSnapshots.has(normalizedPath)) return;

  const absolutePath = ensureInsideRoot(projectRoot, normalizedPath);
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
    state.fileSnapshots.set(normalizedPath, {
      existed: true,
      content: fs.readFileSync(absolutePath, 'utf-8'),
    });
    return;
  }

  state.fileSnapshots.set(normalizedPath, {
    existed: false,
    content: null,
  });
}

function isPlannedFile(plan: WorkerExecutionPlan | null, relativePath: string): boolean {
  if (!plan) return false;
  const normalizedPath = normalizeRelativePath(relativePath);
  return plan.intendedFiles.some(
    (plannedFile) =>
      plannedFile === normalizedPath ||
      (plannedFile.endsWith('/') && normalizedPath.startsWith(plannedFile)),
  );
}

function isProtectedFile(plan: WorkerExecutionPlan | null, relativePath: string): boolean {
  if (!plan) return false;
  const normalizedPath = normalizeRelativePath(relativePath);
  return plan.protectedFiles.some(
    (protectedFile) =>
      protectedFile === normalizedPath ||
      (protectedFile.endsWith('/') && normalizedPath.startsWith(protectedFile)),
  );
}

function pathMatchesScope(scopes: string[], relativePath: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);
  return scopes.some((scope) => {
    const normalizedScope = normalizeRelativePath(scope);
    return (
      normalizedScope === normalizedPath ||
      (normalizedScope.endsWith('/') && normalizedPath.startsWith(normalizedScope))
    );
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globPatternToRegExp(pattern: string): RegExp {
  const normalized = normalizeRelativePath(pattern);
  const parts = normalized.split(/(\*\*|\*)/g);
  const body = parts
    .map((part) => {
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      return escapeRegExp(part);
    })
    .join('');
  return new RegExp(`^${body}$`, 'i');
}

function pathMatchesPolicyPattern(relativePath: string, pattern: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);
  const normalizedPattern = normalizeRelativePath(pattern);
  if (!normalizedPath || !normalizedPattern) return false;
  if (normalizedPattern.startsWith('**/')) {
    const tail = normalizedPattern.slice(3);
    if (pathMatchesPolicyPattern(normalizedPath, tail)) return true;
  }
  return globPatternToRegExp(normalizedPattern).test(normalizedPath);
}

function commandMatchesPolicyPattern(command: string, pattern: string): boolean {
  const normalizedCommand = normalizeCommandForComparison(command);
  const normalizedPattern = normalizeCommandForComparison(pattern);
  if (!normalizedCommand || !normalizedPattern) return false;
  if (normalizedPattern.includes('*')) {
    return globPatternToRegExp(normalizedPattern.replace(/\s+/g, ' ')).test(normalizedCommand);
  }
  return (
    normalizedCommand === normalizedPattern ||
    normalizedCommand.startsWith(`${normalizedPattern} `) ||
    normalizedCommand.includes(` ${normalizedPattern} `)
  );
}

function isProtectedByExecutionPolicy(policy: KiraExecutionPolicy, relativePath: string): boolean {
  return policy.protectedPaths.some((pattern) => pathMatchesPolicyPattern(relativePath, pattern));
}

export function evaluateExecutionPolicy(
  policyInput: unknown,
  event: KiraPolicyEvent,
  input: {
    toolName?: string;
    path?: string;
    command?: string;
    riskLevel?: RiskReviewPolicy['level'];
    changedFiles?: string[];
    diffStats?: DiffStats;
  },
): {
  decision: KiraPolicyDecision;
  issues: string[];
  warnings: string[];
  matchedRules: string[];
} {
  const policy = normalizeExecutionPolicy(policyInput);
  const toolName = input.toolName ? normalizeWhitespace(input.toolName) : '';
  const relativePath = input.path ? normalizeRelativePath(input.path) : '';
  const command = input.command ? normalizeWhitespace(input.command) : '';
  const changedFiles = normalizePathList(input.changedFiles ?? [], 500);
  const diffLineCount = (input.diffStats?.additions ?? 0) + (input.diffStats?.deletions ?? 0);
  const issues: string[] = [];
  const warnings: string[] = [];
  const matchedRules: string[] = [];

  if (
    relativePath &&
    (toolName === 'write_file' || toolName === 'edit_file') &&
    isProtectedByExecutionPolicy(policy, relativePath)
  ) {
    issues.push(`Execution policy blocks edits to protected path: ${relativePath}.`);
  }
  if (
    command &&
    policy.commandDenylist.some((pattern) => commandMatchesPolicyPattern(command, pattern))
  ) {
    issues.push(`Execution policy blocks denied command: ${command}.`);
  }
  if (
    command &&
    policy.commandAllowlist.length > 0 &&
    !policy.commandAllowlist.some((pattern) => commandMatchesPolicyPattern(command, pattern))
  ) {
    issues.push(`Execution policy requires an allowlisted command, but got: ${command}.`);
  }
  if (changedFiles.length > policy.maxChangedFiles) {
    const message = `Execution policy changed-file limit exceeded: ${changedFiles.length}/${policy.maxChangedFiles}.`;
    if (policy.mode !== 'permissive') {
      issues.push(message);
    } else {
      warnings.push(message);
    }
  }
  if (diffLineCount > policy.maxDiffLines) {
    const message = `Execution policy diff-line limit exceeded: ${diffLineCount}/${policy.maxDiffLines}.`;
    if (policy.mode !== 'permissive') {
      issues.push(message);
    } else {
      warnings.push(message);
    }
  }

  for (const rule of policy.rules) {
    if (!rule.enabled || rule.event !== event) continue;
    const toolMatched = rule.toolNames.length === 0 || rule.toolNames.includes(toolName);
    const pathMatched =
      rule.pathPatterns.length === 0 ||
      (relativePath &&
        rule.pathPatterns.some((pattern) => pathMatchesPolicyPattern(relativePath, pattern)));
    const commandMatched =
      rule.commandPatterns.length === 0 ||
      (command &&
        rule.commandPatterns.some((pattern) => commandMatchesPolicyPattern(command, pattern)));
    const riskMatched =
      rule.riskLevels.length === 0 ||
      (input.riskLevel ? rule.riskLevels.includes(input.riskLevel) : false);
    if (!toolMatched || !pathMatched || !commandMatched || !riskMatched) continue;
    matchedRules.push(rule.id);
    if (rule.decision === 'block') {
      issues.push(`${rule.message} (${rule.id})`);
    } else if (rule.decision === 'warn' || rule.decision === 'defer') {
      warnings.push(`${rule.message} (${rule.id})`);
    }
  }

  return {
    decision: issues.length > 0 ? 'block' : warnings.length > 0 ? 'warn' : 'allow',
    issues: limitedUniqueStrings(issues, 12),
    warnings: limitedUniqueStrings(warnings, 12),
    matchedRules: limitedUniqueStrings(matchedRules, 12),
  };
}

function formatPolicyEvaluationFailure(
  evaluation: ReturnType<typeof evaluateExecutionPolicy>,
): string {
  return `error: ${[
    ...evaluation.issues,
    ...(evaluation.matchedRules.length > 0
      ? [`Matched policy rules: ${evaluation.matchedRules.join(', ')}`]
      : []),
  ].join(' ')}`;
}

export function canUseFullFileRewrite(params: {
  existingFileSize: number;
  relativePath: string;
  intendedFiles: string[];
  protectedFiles?: string[];
  readFiles: string[];
  maxFileBytes?: number;
}): boolean {
  const normalizedPath = normalizeRelativePath(params.relativePath);
  if (!normalizedPath) return false;
  if (params.existingFileSize > (params.maxFileBytes ?? MAX_FULL_REWRITE_FILE_BYTES)) {
    return false;
  }
  if (!pathMatchesScope(params.readFiles, normalizedPath)) return false;
  if (!pathMatchesScope(params.intendedFiles, normalizedPath)) return false;
  if (pathMatchesScope(params.protectedFiles ?? [], normalizedPath)) return false;
  return true;
}

function validateWriteTarget(
  state: WorkerAttemptState | null | undefined,
  relativePath: string,
): string | null {
  if (!state) return null;
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath) return null;
  if (isProtectedByExecutionPolicy(state.executionPolicy, normalizedPath)) {
    return `error: ${normalizedPath} is protected by the project execution policy`;
  }
  if (isProtectedFile(state.plan, normalizedPath)) {
    return `error: ${normalizedPath} is listed in protectedFiles and cannot be edited by this attempt`;
  }
  if (state.dirtyFiles.has(normalizedPath) && !isPlannedFile(state.plan, normalizedPath)) {
    return `error: ${normalizedPath} has pre-existing worktree changes and is not listed in intendedFiles`;
  }
  return null;
}

function recordAttemptPatch(
  state: WorkerAttemptState | null | undefined,
  relativePath: string,
): void {
  if (!state) return;
  const normalizedPath = normalizeRelativePath(relativePath);
  if (normalizedPath) {
    state.patchedFiles.add(normalizedPath);
  }
}

function restoreAttemptFiles(
  projectRoot: string,
  state: WorkerAttemptState | null | undefined,
): string[] {
  if (!state || state.fileSnapshots.size === 0) return [];

  const restored: string[] = [];
  for (const [relativePath, snapshot] of [...state.fileSnapshots.entries()].reverse()) {
    const absolutePath = ensureInsideRoot(projectRoot, relativePath);
    if (snapshot.existed) {
      fs.mkdirSync(dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, snapshot.content ?? '', 'utf-8');
      restored.push(relativePath);
      continue;
    }

    if (fs.existsSync(absolutePath)) {
      fs.rmSync(absolutePath, { force: true });
      restored.push(relativePath);
    }
  }

  return restored.sort();
}

function tryRestoreAttemptFiles(
  projectRoot: string,
  state: WorkerAttemptState | null | undefined,
): { restoredFiles: string[]; error: string | null } {
  try {
    return { restoredFiles: restoreAttemptFiles(projectRoot, state), error: null };
  } catch (error) {
    return {
      restoredFiles: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function recordAttemptCommand(state: WorkerAttemptState | null | undefined, command: string): void {
  if (!state) return;
  const normalized = normalizeWhitespace(command);
  if (normalized) {
    state.commandsRun.push(normalized);
  }
}

function recordAttemptExploration(
  state: WorkerAttemptState | null | undefined,
  action: string,
): void {
  if (!state) return;
  const normalized = normalizeWhitespace(action);
  if (normalized) {
    state.explorationActions.push(normalized);
  }
}

function recordAttemptRead(
  state: WorkerAttemptState | null | undefined,
  relativePath: string,
): void {
  if (!state) return;
  const normalizedPath = normalizeRelativePath(relativePath);
  if (normalizedPath) {
    state.readFiles.add(normalizedPath);
    recordAttemptExploration(state, `read_file ${normalizedPath}`);
  }
}

function truncateForComment(value: string, maxChars: number, suffix: string): string {
  if (value.length <= maxChars) return value;
  const suffixWithBreak = `\n${suffix}`;
  return `${value.slice(0, Math.max(0, maxChars - suffixWithBreak.length)).trimEnd()}${suffixWithBreak}`;
}

function truncateForReview(value: string, maxChars: number): string {
  return truncateForComment(value, maxChars, '...diff truncated for review');
}

export function formatWorkerSubmission(
  rawWorkerOutput: string | undefined,
  maxChars = 8_000,
): string {
  const normalized = rawWorkerOutput?.trim();
  if (!normalized) return 'No raw worker submission captured.';
  return truncateForComment(normalized, maxChars, '...worker submission truncated for comment');
}

function isLlmTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /LLM request timed out/i.test(message);
}

function buildAgentTimeoutRetryPrompt(writable: boolean): string {
  return [
    'The previous Kira LLM request timed out before returning a response.',
    writable
      ? 'Continue with a narrower implementation step, use only necessary tools, and keep the final JSON concise.'
      : 'Continue with a narrower read-only planning step, inspect only the most relevant files, and keep the final JSON concise.',
    'Do not restart broad repository exploration unless no relevant files have been inspected yet.',
  ].join(' ');
}

function buildAgentFinalRepairPrompt(issues: string[], content: string): string {
  return [
    'Your previous final response did not satisfy Kira structured output requirements.',
    `Issues:\n${formatList(issues, 'No detailed issues provided')}`,
    content.trim()
      ? `Previous final response:\n${truncateForReview(content, 2_000)}`
      : 'Previous final response was empty.',
    'If repository context is missing, call list_files, search_files, or read_file before finalizing.',
    'Then return only the requested JSON object. Do not use markdown fences or prose.',
  ].join('\n\n');
}

function formatCommandOutput(stdout: string, stderr: string): string {
  return [`stdout:\n${stdout.trim() || '(empty)'}`, `stderr:\n${stderr.trim() || '(empty)'}`].join(
    '\n\n',
  );
}

function formatCommandFailureDetail(command: string, error: unknown): string {
  const stdout =
    error && typeof error === 'object' && 'stdout' in error ? String(error.stdout ?? '') : '';
  const stderr =
    error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '') : '';
  const message = error instanceof Error ? error.message : String(error);
  return [
    `Command: ${command}`,
    `Error: ${message}`,
    truncateForReview(formatCommandOutput(stdout, stderr), 1_200),
  ].join('\n\n');
}

function isHighRiskFile(projectRoot: string, relativePath: string): boolean {
  const absolutePath = ensureInsideRoot(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return false;

  const ext = absolutePath.slice(absolutePath.lastIndexOf('.')).toLowerCase();
  const basename = absolutePath.slice(absolutePath.lastIndexOf('\\') + 1).toLowerCase();
  const sourceLike = ['.py', '.js', '.jsx', '.ts', '.tsx', '.go', '.rs', '.java', '.cs'].includes(
    ext,
  );
  if (!sourceLike) return false;

  const content = fs.readFileSync(absolutePath, 'utf-8');
  const lineCount = content.split(/\r?\n/).length;
  return (
    lineCount >= 220 ||
    ['main.py', 'app.py', 'server.py', 'index.ts', 'index.tsx'].includes(basename)
  );
}

function requiresExplicitReadBeforeWrite(
  projectRoot: string,
  relativePath: string,
  state: WorkerAttemptState | null | undefined,
): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath || !state) return false;
  if (state.readFiles.has(normalizedPath)) return false;
  return isHighRiskFile(projectRoot, normalizedPath);
}

function collectFiles(root: string, currentDir: string, depth: number, entries: string[]): void {
  if (entries.length >= MAX_LIST_ENTRIES) return;
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    if (entries.length >= MAX_LIST_ENTRIES) return;
    if (dirent.isDirectory() && shouldSkipToolTraversalDirectory(dirent.name)) {
      continue;
    }
    const absolutePath = join(currentDir, dirent.name);
    const relativePath = absolutePath
      .slice(root.length)
      .replace(/^[\\/]+/, '')
      .replace(/\\/g, '/');
    if (dirent.isDirectory()) {
      entries.push(`[dir] ${relativePath}`);
      if (depth > 0) collectFiles(root, absolutePath, depth - 1, entries);
    } else {
      entries.push(`[file] ${relativePath}`);
    }
  }
}

function searchProjectFiles(root: string, query: string): string[] {
  const results: string[] = [];
  const needle = query.toLowerCase();
  const walk = (currentDir: string) => {
    if (results.length >= MAX_SEARCH_RESULTS) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (results.length >= MAX_SEARCH_RESULTS) return;
      if (dirent.isDirectory() && shouldSkipToolTraversalDirectory(dirent.name)) {
        continue;
      }
      const absolutePath = join(currentDir, dirent.name);
      if (dirent.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      const relativePath = absolutePath
        .slice(root.length)
        .replace(/^[\\/]+/, '')
        .replace(/\\/g, '/');
      if (relativePath.toLowerCase().includes(needle)) {
        results.push(`${relativePath}: filename match`);
        continue;
      }
      try {
        const stat = fs.statSync(absolutePath);
        if (stat.size > MAX_FILE_BYTES) continue;
        const content = fs.readFileSync(absolutePath, 'utf-8');
        const lower = content.toLowerCase();
        const index = lower.indexOf(needle);
        if (index >= 0) {
          const snippet = content.slice(
            Math.max(0, index - 80),
            Math.min(content.length, index + 120),
          );
          results.push(`${relativePath}: ${snippet.replace(/\s+/g, ' ').trim()}`);
        }
      } catch {
        // ignore unreadable files
      }
    }
  };
  walk(root);
  return results;
}

async function executeTool(
  projectRoot: string,
  toolName: string,
  args: Record<string, unknown>,
  writable: boolean,
  attemptState?: WorkerAttemptState | null,
  signal?: AbortSignal,
): Promise<string> {
  if (!isToolAllowedByScope(toolName, attemptState)) {
    return `error: tool ${toolName} is not allowed by the active Kira subagent contract`;
  }
  const policyEvaluation = evaluateExecutionPolicy(
    attemptState?.executionPolicy ?? DEFAULT_KIRA_EXECUTION_POLICY,
    'before_tool',
    {
      toolName,
      path: typeof args.path === 'string' ? args.path : undefined,
      command: typeof args.command === 'string' ? args.command : undefined,
    },
  );
  if (policyEvaluation.decision === 'block') {
    return formatPolicyEvaluationFailure(policyEvaluation);
  }
  if (policyEvaluation.warnings.length > 0) {
    recordAttemptExploration(
      attemptState,
      `policy warning ${toolName}: ${policyEvaluation.warnings.join('; ')}`,
    );
  }

  switch (toolName) {
    case 'list_files': {
      const directory = typeof args.directory === 'string' ? args.directory : '.';
      const depth = typeof args.depth === 'number' ? Math.max(0, Math.min(4, args.depth)) : 2;
      const targetDir = ensureInsideRoot(projectRoot, directory);
      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        return 'error: directory not found';
      }
      const entries: string[] = [];
      collectFiles(targetDir, targetDir, depth, entries);
      recordAttemptExploration(
        attemptState,
        `list_files ${normalizeRelativePath(directory) || '.'}`,
      );
      return entries.length > 0 ? entries.join('\n') : 'empty directory';
    }
    case 'read_file': {
      const filePath = typeof args.path === 'string' ? args.path : '';
      if (!filePath) return 'error: path is required';
      const absolutePath = ensureInsideRoot(projectRoot, filePath);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        return 'error: file not found';
      }
      const stat = fs.statSync(absolutePath);
      if (stat.size > MAX_FILE_BYTES) return 'error: file too large';
      recordAttemptRead(attemptState, filePath);
      return fs.readFileSync(absolutePath, 'utf-8');
    }
    case 'write_file': {
      if (!writable) return 'error: write_file is disabled for this agent';
      const filePath = typeof args.path === 'string' ? args.path : '';
      const content = typeof args.content === 'string' ? args.content : '';
      if (!filePath) return 'error: path is required';
      const absolutePath = ensureInsideRoot(projectRoot, filePath);
      const targetError = validateWriteTarget(attemptState, filePath);
      if (targetError) return targetError;
      if (containsCorruptionMarker(content)) {
        return 'error: refusing to write placeholder or corruption marker text';
      }
      if (hasMergeConflictMarkers(content)) {
        return 'error: refusing to write merge conflict markers';
      }
      if (Buffer.byteLength(content, 'utf-8') > MAX_FULL_REWRITE_FILE_BYTES) {
        return `error: write_file content is too large; maximum is ${MAX_FULL_REWRITE_FILE_BYTES} bytes`;
      }
      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
        if (requiresExplicitReadBeforeWrite(projectRoot, filePath, attemptState)) {
          return 'error: high-risk existing files must be read with read_file before overwriting';
        }
        const stat = fs.statSync(absolutePath);
        const canFullRewrite = canUseFullFileRewrite({
          existingFileSize: stat.size,
          relativePath: filePath,
          intendedFiles: attemptState?.plan?.intendedFiles ?? [],
          protectedFiles: attemptState?.plan?.protectedFiles ?? [],
          readFiles: Array.from(attemptState?.readFiles ?? []),
        });
        if (stat.size > MAX_OVERWRITE_FILE_BYTES && !canFullRewrite) {
          return 'error: existing file is too large for write_file unless it is listed in intendedFiles and was read with read_file in this attempt';
        }
      }
      captureAttemptFileSnapshot(attemptState, projectRoot, filePath);
      fs.mkdirSync(dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, content, 'utf-8');
      recordAttemptPatch(attemptState, filePath);
      const afterEvaluation = evaluateExecutionPolicy(
        attemptState?.executionPolicy ?? DEFAULT_KIRA_EXECUTION_POLICY,
        'after_tool',
        { toolName, path: filePath },
      );
      if (afterEvaluation.decision === 'block') {
        return formatPolicyEvaluationFailure(afterEvaluation);
      }
      return 'success';
    }
    case 'edit_file': {
      if (!writable) return 'error: edit_file is disabled for this agent';
      const filePath = typeof args.path === 'string' ? args.path : '';
      const find = typeof args.find === 'string' ? args.find : '';
      const replace = typeof args.replace === 'string' ? args.replace : '';
      const replaceAll = args.replace_all === true;
      if (!filePath) return 'error: path is required';
      if (!find) return 'error: find is required';
      const absolutePath = ensureInsideRoot(projectRoot, filePath);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        return 'error: file not found';
      }
      const targetError = validateWriteTarget(attemptState, filePath);
      if (targetError) return targetError;
      if (requiresExplicitReadBeforeWrite(projectRoot, filePath, attemptState)) {
        return 'error: high-risk files must be read with read_file before editing';
      }
      captureAttemptFileSnapshot(attemptState, projectRoot, filePath);
      const current = fs.readFileSync(absolutePath, 'utf-8');
      const occurrences = current.split(find).length - 1;
      if (occurrences === 0) return 'error: target text not found';
      if (!replaceAll && occurrences > 1) {
        return `error: target text matched ${occurrences} times; refine the find text or set replace_all=true`;
      }
      const next = replaceAll ? current.split(find).join(replace) : current.replace(find, replace);
      if (containsCorruptionMarker(next)) {
        return 'error: refusing to write placeholder or corruption marker text';
      }
      fs.writeFileSync(absolutePath, next, 'utf-8');
      recordAttemptPatch(attemptState, filePath);
      const afterEvaluation = evaluateExecutionPolicy(
        attemptState?.executionPolicy ?? DEFAULT_KIRA_EXECUTION_POLICY,
        'after_tool',
        { toolName, path: filePath },
      );
      if (afterEvaluation.decision === 'block') {
        return formatPolicyEvaluationFailure(afterEvaluation);
      }
      return `success: replaced ${replaceAll ? occurrences : 1} occurrence(s)`;
    }
    case 'search_files': {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return 'error: query is required';
      const results = searchProjectFiles(projectRoot, query);
      recordAttemptExploration(attemptState, `search_files ${query}`);
      return results.length > 0 ? results.join('\n') : 'no matches';
    }
    case 'run_command': {
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (!command) return 'error: command is required';
      if (
        DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(normalizeWhitespace(command)))
      ) {
        return 'error: command rejected by safety policy';
      }
      if (!isSafeCommandAllowed(command)) {
        return 'error: command prefix is not allowed';
      }
      const environmentIssues = collectEnvironmentCommandIssues(
        attemptState?.environmentContract,
        command,
      );
      if (environmentIssues.length > 0) {
        return `error: ${environmentIssues.join(' ')}`;
      }
      recordAttemptCommand(attemptState, command);
      try {
        const { stdout, stderr } = await runShellCommand(
          command,
          projectRoot,
          signal,
          COMMAND_TIMEOUT_MS,
          attemptState?.environmentContract,
        );
        const afterEvaluation = evaluateExecutionPolicy(
          attemptState?.executionPolicy ?? DEFAULT_KIRA_EXECUTION_POLICY,
          'after_tool',
          { toolName, command },
        );
        if (afterEvaluation.decision === 'block') {
          return formatPolicyEvaluationFailure(afterEvaluation);
        }
        return formatCommandOutput(stdout, stderr);
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        return formatCommandFailureDetail(command, error);
      }
    }
    default:
      return `error: unknown tool ${toolName}`;
  }
}

function buildToolDefinitions(writable: boolean): ToolDefinition[] {
  return [
    {
      name: 'list_files',
      description: 'List files and directories relative to the project root.',
      parameters: {
        directory: { type: 'string', description: 'Relative directory path', required: false },
        depth: { type: 'number', description: 'Recursion depth up to 4', required: false },
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file relative to the project root.',
      parameters: {
        path: { type: 'string', description: 'Relative file path', required: true },
      },
    },
    ...(writable
      ? [
          {
            name: 'edit_file',
            description:
              'Patch an existing UTF-8 file by replacing exact text. Prefer this over write_file for existing files, especially large ones.',
            parameters: {
              path: { type: 'string', description: 'Relative file path', required: true },
              find: {
                type: 'string',
                description: 'Exact existing text to replace',
                required: true,
              },
              replace: { type: 'string', description: 'Replacement text', required: true },
              replace_all: {
                type: 'boolean',
                description: 'When true, replace every occurrence instead of only one',
                required: false,
              },
            },
          } satisfies ToolDefinition,
          {
            name: 'write_file',
            description:
              'Create a UTF-8 file or write complete final content for an existing file. Existing large files are allowed only when the file is in intendedFiles, was read with read_file in this attempt, and is not protected.',
            parameters: {
              path: { type: 'string', description: 'Relative file path', required: true },
              content: {
                type: 'string',
                description: 'Complete final file content, not a patch or excerpt',
                required: true,
              },
            },
          } satisfies ToolDefinition,
        ]
      : []),
    {
      name: 'search_files',
      description: 'Search filenames and text content inside the project.',
      parameters: {
        query: { type: 'string', description: 'Case-insensitive search query', required: true },
      },
    },
    {
      name: 'run_command',
      description:
        'Run a safe diagnostic or validation command such as pytest, npm/pnpm test or lint, git status/diff/show, rg, go test, cargo test/check, or dotnet test/build.',
      parameters: {
        command: { type: 'string', description: 'Exact command to run', required: true },
      },
    },
  ];
}

function buildExternalAgentPrompt(systemPrompt: string, prompt: string): string {
  return [
    systemPrompt ? `Kira role instructions:\n${systemPrompt}` : '',
    'You are running inside Kira automation. Follow the Kira role instructions over your default habits when they are more specific.',
    'Return the final answer in exactly the structured JSON shape requested by the Kira task prompt.',
    prompt,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildCodexCliArgs(
  config: LLMConfig,
  projectRoot: string,
  writable: boolean,
  outputFile: string,
): string[] {
  const args = [
    'exec',
    '--cd',
    projectRoot,
    '--skip-git-repo-check',
    '--sandbox',
    writable ? 'workspace-write' : 'read-only',
    '--output-last-message',
    outputFile,
    '--color',
    'never',
  ];
  if (config.model.trim()) {
    args.push('--model', config.model.trim());
  }
  args.push('-');
  return args;
}

function createCommandExecutionError(
  message: string,
  stdout = '',
  stderr = '',
  name?: string,
): Error & { stdout?: string; stderr?: string } {
  const error = new Error(message) as Error & { stdout?: string; stderr?: string };
  if (name) {
    error.name = name;
  }
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.pid && process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => undefined);
      killer.unref?.();
    } catch {
      // Fall back to the direct child kill below.
    }
  }

  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch {
      // Fall back to the direct child kill below.
    }
  }

  try {
    child.kill();
  } catch {
    // Process may have already exited.
  }
}

function quoteShellArgument(value: string): string {
  if (process.platform === 'win32') {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildRunnerCommand(command: string, environment?: KiraEnvironmentContract): string {
  const contract = normalizeEnvironmentContract(environment);
  if (contract.runner === 'local') return command;
  if (contract.runner === 'cloud') {
    throw createCommandExecutionError(
      'Cloud runner is declared for this project, but the local Kira runtime has no cloud execution connector enabled.',
    );
  }
  if (!contract.remoteCommand || !contract.remoteCommand.includes('{command}')) {
    throw createCommandExecutionError(
      'Remote-command runner requires environment.remoteCommand with a {command} placeholder.',
    );
  }
  return contract.remoteCommand.replace('{command}', quoteShellArgument(command));
}

function buildShellCommandInvocation(
  command: string,
  environment?: KiraEnvironmentContract,
): { command: string; args: string[] } {
  const contract = normalizeEnvironmentContract(environment);
  if (process.platform === 'win32' && contract.windowsMode === 'wsl') {
    return {
      command: 'wsl.exe',
      args: ['bash', '-lc', command],
    };
  }
  return process.platform === 'win32'
    ? {
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      }
    : { command: '/bin/bash', args: ['-lc', command] };
}

function runProcessWithInput(
  command: string,
  args: string[],
  cwd: string,
  input: string,
  signal?: AbortSignal,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveProcess, reject) => {
    if (signal?.aborted) {
      reject(createCommandExecutionError('Agent run aborted.', '', '', 'AbortError'));
      return;
    }

    const child = spawn(command, args, {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      terminateProcessTree(child);
      if (!settled) {
        settled = true;
        reject(
          createCommandExecutionError(
            `Command timed out after ${timeoutMs}ms: ${command}`,
            stdout,
            stderr,
          ),
        );
      }
    }, timeoutMs);
    timeout.unref?.();

    const abortHandler = () => {
      terminateProcessTree(child);
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(createCommandExecutionError('Agent run aborted.', stdout, stderr, 'AbortError'));
      }
    };
    signal?.addEventListener('abort', abortHandler, { once: true });

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortHandler);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortHandler);
      if (code === 0) {
        resolveProcess({ stdout, stderr });
        return;
      }
      reject(
        createCommandExecutionError(
          [
            `Command failed with exit code ${code}: ${command}`,
            truncateForReview(formatCommandOutput(stdout, stderr), 1_200),
          ].join('\n\n'),
          stdout,
          stderr,
        ),
      );
    });
    child.stdin?.end(input);
  });
}

function runShellCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = COMMAND_TIMEOUT_MS,
  environment?: KiraEnvironmentContract,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveProcess, reject) => {
    if (signal?.aborted) {
      reject(createCommandExecutionError('Command aborted.', '', '', 'AbortError'));
      return;
    }

    let effectiveCommand: string;
    try {
      effectiveCommand = buildRunnerCommand(command, environment);
    } catch (error) {
      reject(error);
      return;
    }
    const invocation = buildShellCommandInvocation(effectiveCommand, environment);
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: buildChildProcessEnv(environment),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const abortHandler = () => {
      terminateProcessTree(child);
      if (!settled) {
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        reject(createCommandExecutionError('Command aborted.', stdout, stderr, 'AbortError'));
      }
    };

    timeout = setTimeout(() => {
      terminateProcessTree(child);
      if (!settled) {
        settled = true;
        signal?.removeEventListener('abort', abortHandler);
        reject(
          createCommandExecutionError(
            `Command timed out after ${timeoutMs}ms: ${effectiveCommand}`,
            stdout,
            stderr,
          ),
        );
      }
    }, timeoutMs);
    timeout.unref?.();
    signal?.addEventListener('abort', abortHandler, { once: true });

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener('abort', abortHandler);
      reject(createCommandExecutionError(error.message, stdout, stderr, error.name));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener('abort', abortHandler);
      if (code === 0) {
        resolveProcess({ stdout, stderr });
        return;
      }
      reject(
        createCommandExecutionError(
          `Command failed with exit code ${code}: ${effectiveCommand}`,
          stdout,
          stderr,
        ),
      );
    });
  });
}

async function runCodexCliAgent(
  config: LLMConfig,
  projectRoot: string,
  prompt: string,
  systemPrompt: string,
  writable: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const tempDir = fs.mkdtempSync(join(tmpdir(), 'kira-codex-'));
  const outputFile = join(tempDir, 'last-message.txt');
  try {
    const command = config.command?.trim() || 'codex';
    const input = buildExternalAgentPrompt(systemPrompt, prompt);
    try {
      await runProcessWithInput(
        command,
        buildCodexCliArgs(config, projectRoot, writable, outputFile),
        projectRoot,
        input,
        signal,
        EXTERNAL_AGENT_TIMEOUT_MS,
      );
    } catch (error) {
      if (
        config.model.trim() &&
        config.model.trim() !== CODEX_CLI_FALLBACK_MODEL &&
        isCodexCliModelUpgradeError(error)
      ) {
        await runProcessWithInput(
          command,
          buildCodexCliArgs(
            { ...config, model: CODEX_CLI_FALLBACK_MODEL },
            projectRoot,
            writable,
            outputFile,
          ),
          projectRoot,
          input,
          signal,
          EXTERNAL_AGENT_TIMEOUT_MS,
        );
      } else {
        throw error;
      }
    }
    if (fs.existsSync(outputFile)) {
      return fs.readFileSync(outputFile, 'utf-8').trim();
    }
    return '';
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runToolAgent(
  config: LLMConfig,
  projectRoot: string,
  prompt: string,
  systemPrompt: string,
  writable: boolean,
  signal?: AbortSignal,
  attemptState?: WorkerAttemptState | null,
  finalValidator?: ToolAgentFinalValidator,
): Promise<string> {
  if (isCodexCliProvider(config.provider)) {
    recordAttemptCommand(
      attemptState,
      `codex exec --sandbox ${writable ? 'workspace-write' : 'read-only'}${
        config.model ? ` --model ${config.model}` : ''
      }`,
    );
    recordAttemptExploration(attemptState, `external_agent ${config.provider}`);
    return runWithKiraModelRouteLimit(
      config,
      () => runCodexCliAgent(config, projectRoot, prompt, systemPrompt, writable, signal),
      signal,
    );
  }

  const history: AgentMessage[] = [{ role: 'user', content: prompt }];
  const tools = buildToolDefinitions(writable);
  let repairTurns = 0;
  let timeoutRetries = 0;

  for (;;)
  {
    if (signal?.aborted) {
      const error = new Error('Agent run aborted.');
      error.name = 'AbortError';
      throw error;
    }
    let response: Awaited<ReturnType<typeof callLlm>>;
    try {
      response = await callLlm(config, systemPrompt, history, tools, signal);
    } catch (error) {
      if (isLlmTimeoutError(error) && timeoutRetries < MAX_AGENT_TIMEOUT_RETRIES) {
        timeoutRetries += 1;
        history.push({ role: 'user', content: buildAgentTimeoutRetryPrompt(writable) });
        continue;
      }
      throw error;
    }
    if (response.toolCalls.length === 0) {
      const validationIssues = finalValidator?.(response.content) ?? [];
      if (validationIssues.length > 0 && repairTurns < MAX_AGENT_REPAIR_TURNS) {
        repairTurns += 1;
        history.push({
          role: 'assistant',
          content: response.content || '(empty final response)',
        });
        history.push({
          role: 'user',
          content: buildAgentFinalRepairPrompt(validationIssues, response.content),
        });
        continue;
      }
      return response.content;
    }

    history.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
      reasoningContent: response.reasoningContent,
    });

    for (const toolCall of response.toolCalls) {
      if (signal?.aborted) {
        const error = new Error('Agent run aborted.');
        error.name = 'AbortError';
        throw error;
      }
      const toolResult = await executeTool(
        projectRoot,
        toolCall.name,
        toolCall.args,
        writable,
        attemptState,
        signal,
      );
      history.push({
        role: 'tool',
        content: toolResult,
        toolCallId: toolCall.id,
      });
    }
  }
}

export function parseWorkerExecutionPlan(raw: string): WorkerExecutionPlan {
  try {
    const parsed = JSON.parse(extractJson(raw)) as Partial<WorkerExecutionPlan>;
    const allPlannedCommands = uniqueStrings(
      (Array.isArray(parsed.validationCommands) ? parsed.validationCommands : [])
        .map((value) => normalizeWhitespace(String(value)))
        .filter(Boolean),
    );
    const safeCommands = allPlannedCommands.filter((command) => isSafeCommandAllowed(command));
    const rejectedCommands = allPlannedCommands.filter((command) => !isSafeCommandAllowed(command));
    const acceptedCommands = safeCommands.slice(0, MAX_PLANNER_VALIDATION_COMMANDS);
    const droppedCommands = safeCommands.slice(MAX_PLANNER_VALIDATION_COMMANDS);

    const parseIssues: string[] = [];
    if (!parsed.understanding?.trim()) parseIssues.push('Missing required field: understanding');
    if (!parsed.summary?.trim()) parseIssues.push('Missing required field: summary');
    if (!Array.isArray(parsed.repoFindings) || parsed.repoFindings.length === 0) {
      parseIssues.push('Missing required field: repoFindings');
    }
    if (!Array.isArray(parsed.intendedFiles) || parsed.intendedFiles.length === 0) {
      parseIssues.push('Missing required field: intendedFiles');
    }
    if (!Array.isArray(parsed.stopConditions) || parsed.stopConditions.length === 0) {
      parseIssues.push('Missing required field: stopConditions');
    }
    const changeDesign = normalizeChangeDesign(parsed.changeDesign);
    if (changeDesign.targetFiles.length === 0) {
      parseIssues.push('Missing required field: changeDesign.targetFiles');
    }
    if (changeDesign.invariants.length === 0) {
      parseIssues.push('Missing required field: changeDesign.invariants');
    }
    if (changeDesign.expectedImpact.length === 0) {
      parseIssues.push('Missing required field: changeDesign.expectedImpact');
    }
    if (changeDesign.validationStrategy.length === 0) {
      parseIssues.push('Missing required field: changeDesign.validationStrategy');
    }
    if (changeDesign.rollbackStrategy.length === 0) {
      parseIssues.push('Missing required field: changeDesign.rollbackStrategy');
    }
    const requirementTrace = normalizeRequirementTrace(parsed.requirementTrace);
    if (requirementTrace.length === 0) {
      parseIssues.push('Missing required field: requirementTrace');
    }
    const approachAlternatives = normalizePatchAlternatives(parsed.approachAlternatives);
    if (
      approachAlternatives.length < 2 ||
      approachAlternatives.filter((item) => item.selected).length !== 1
    ) {
      parseIssues.push('Missing required field: approachAlternatives with one selected option');
    }
    const escalation = normalizeUncertaintyEscalation(parsed.escalation);

    return {
      valid: parseIssues.length === 0,
      parseIssues,
      understanding: parsed.understanding?.trim() || 'No requirement understanding provided.',
      repoFindings: uniqueStrings(
        Array.isArray(parsed.repoFindings) ? parsed.repoFindings.map(String) : [],
      ),
      summary: parsed.summary?.trim() || 'No execution plan provided.',
      intendedFiles: normalizePathList(
        Array.isArray(parsed.intendedFiles) ? parsed.intendedFiles : [],
        MAX_PLANNED_FILES,
      ),
      protectedFiles: normalizePathList(
        Array.isArray(parsed.protectedFiles) ? parsed.protectedFiles : [],
        MAX_PLANNED_FILES,
      ),
      validationCommands: acceptedCommands,
      riskNotes: uniqueStrings([
        ...(Array.isArray(parsed.riskNotes) ? parsed.riskNotes.map(String) : []),
        ...rejectedCommands.map(
          (command) =>
            `Planner suggested an unsafe validation command that was removed: ${command}`,
        ),
        ...(droppedCommands.length > 0
          ? [
              `Planner suggested ${safeCommands.length} safe validation commands, so Kira kept only the first ${MAX_PLANNER_VALIDATION_COMMANDS}.`,
            ]
          : []),
      ]),
      stopConditions: uniqueStrings(
        Array.isArray(parsed.stopConditions) ? parsed.stopConditions.map(String) : [],
      ),
      confidence: clampConfidence(parsed.confidence, parseIssues.length === 0 ? 0.7 : 0.3),
      uncertainties: limitedUniqueStrings(
        Array.isArray(parsed.uncertainties) ? parsed.uncertainties.map(String) : [],
        8,
      ),
      decomposition: normalizeDecompositionRecommendation(parsed.decomposition),
      workerProfile:
        typeof parsed.workerProfile === 'string' && parsed.workerProfile.trim()
          ? normalizeWhitespace(parsed.workerProfile)
          : 'generalist',
      changeDesign,
      taskType: normalizeTaskType(parsed.taskType),
      requirementTrace,
      approachAlternatives,
      escalation,
    };
  } catch {
    return {
      valid: false,
      parseIssues: ['Plan result could not be parsed into structured JSON.'],
      understanding: 'Plan result could not be parsed.',
      repoFindings: [],
      summary: raw.trim() || 'No execution plan provided.',
      intendedFiles: [],
      protectedFiles: [],
      validationCommands: [],
      riskNotes: [],
      stopConditions: [],
      confidence: 0,
      uncertainties: [],
      decomposition: normalizeDecompositionRecommendation(null),
      workerProfile: 'generalist',
      changeDesign: normalizeChangeDesign(null),
      taskType: 'generalist',
      requirementTrace: [],
      approachAlternatives: [],
      escalation: normalizeUncertaintyEscalation(null),
    };
  }
}

function parseWorkerSummary(raw: string): WorkerSummary {
  try {
    const parsed = JSON.parse(extractJson(raw)) as Partial<WorkerSummary>;
    return {
      summary: parsed.summary?.trim() || 'No worker summary provided.',
      filesChanged: normalizePathList(
        Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
        100,
      ),
      testsRun: uniqueStrings(
        (Array.isArray(parsed.testsRun) ? parsed.testsRun : []).map((value) =>
          normalizeWhitespace(String(value)),
        ),
      ),
      remainingRisks: uniqueStrings(
        Array.isArray(parsed.remainingRisks) ? parsed.remainingRisks.map(String) : [],
      ),
      selfCheck: normalizeWorkerSelfCheck(parsed.selfCheck),
    };
  } catch {
    return {
      summary: raw.trim() || 'No worker summary provided.',
      filesChanged: [],
      testsRun: [],
      remainingRisks: [],
      selfCheck: undefined,
    };
  }
}

function parseReviewSummary(raw: string): ReviewSummary {
  try {
    const parsed = JSON.parse(extractJson(raw)) as Partial<ReviewSummary>;
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.map((finding) => normalizeReviewFinding(finding))
      : [];
    const missingValidation = uniqueStrings(
      Array.isArray(parsed.missingValidation) ? parsed.missingValidation.map(String) : [],
    );
    const nextWorkerInstructions = uniqueStrings(
      Array.isArray(parsed.nextWorkerInstructions) ? parsed.nextWorkerInstructions.map(String) : [],
    );
    const residualRisk = uniqueStrings(
      Array.isArray(parsed.residualRisk) ? parsed.residualRisk.map(String) : [],
    );
    return {
      approved: normalizeBoolean(parsed.approved),
      summary: parsed.summary?.trim() || 'No review summary provided.',
      issues: uniqueStrings([
        ...(Array.isArray(parsed.issues) ? parsed.issues.map(String) : []),
        ...findings.map((finding) =>
          [finding.file, finding.line ? `line ${finding.line}` : '', finding.message]
            .filter(Boolean)
            .join(': '),
        ),
        ...missingValidation.map((command) => `Missing validation: ${command}`),
      ]),
      filesChecked: Array.isArray(parsed.filesChecked) ? parsed.filesChecked.map(String) : [],
      findings,
      missingValidation,
      nextWorkerInstructions,
      residualRisk,
      evidenceChecked: normalizeReviewEvidenceChecked(parsed.evidenceChecked),
      requirementVerdicts: normalizeRequirementTrace(parsed.requirementVerdicts),
      adversarialChecks: normalizeReviewAdversarialChecks(parsed.adversarialChecks),
      reviewerDiscourse: normalizeReviewerDiscourse(parsed.reviewerDiscourse),
    };
  } catch {
    return {
      approved: false,
      summary: raw.trim() || 'Review parsing failed.',
      issues: ['Review result could not be parsed into structured JSON.'],
      filesChecked: [],
      findings: [],
      missingValidation: [],
      nextWorkerInstructions: ['Return the review result as structured JSON.'],
      residualRisk: [],
      evidenceChecked: [],
      requirementVerdicts: [],
      adversarialChecks: [],
      reviewerDiscourse: [],
    };
  }
}

function normalizeReviewFinding(raw: unknown): ReviewFinding {
  const value = typeof raw === 'object' && raw !== null ? (raw as Partial<ReviewFinding>) : {};
  const severity =
    value.severity === 'high' || value.severity === 'medium' || value.severity === 'low'
      ? value.severity
      : 'medium';
  return {
    file: typeof value.file === 'string' ? normalizeRelativePath(value.file) : '',
    line: typeof value.line === 'number' && Number.isFinite(value.line) ? value.line : null,
    severity,
    message: typeof value.message === 'string' ? value.message.trim() : String(raw),
  };
}

function projectHasFile(projectRoot: string, relativePath: string): boolean {
  const absolutePath = join(projectRoot, relativePath);
  return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
}

function projectHasDirectory(projectRoot: string, relativePath: string): boolean {
  const absolutePath = join(projectRoot, relativePath);
  return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory();
}

function projectHasFileWithSuffix(projectRoot: string, suffixes: string[], maxDepth = 2): boolean {
  const walk = (currentDir: string, depth: number): boolean => {
    if (depth < 0 || !fs.existsSync(currentDir) || !fs.statSync(currentDir).isDirectory())
      return false;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const dirent of dirents) {
      if (dirent.isDirectory() && shouldSkipToolTraversalDirectory(dirent.name)) {
        continue;
      }
      const absolutePath = join(currentDir, dirent.name);
      if (dirent.isFile() && suffixes.some((suffix) => dirent.name.endsWith(suffix))) {
        return true;
      }
      if (dirent.isDirectory() && walk(absolutePath, depth - 1)) {
        return true;
      }
    }
    return false;
  };

  return walk(projectRoot, maxDepth);
}

function loadPackageScripts(projectRoot: string): Record<string, string> {
  const packageJsonPath = join(projectRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath) || !fs.statSync(packageJsonPath).isFile()) return {};

  try {
    const raw = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      scripts?: Record<string, unknown>;
    };
    return Object.fromEntries(
      Object.entries(raw.scripts ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function detectNodePackageManager(projectRoot: string): 'pnpm' | 'npm' | null {
  const packageJsonPath = join(projectRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath) || !fs.statSync(packageJsonPath).isFile()) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      packageManager?: unknown;
    };
    if (typeof raw.packageManager === 'string') {
      if (raw.packageManager.startsWith('pnpm@')) return 'pnpm';
      if (raw.packageManager.startsWith('npm@')) return 'npm';
    }
  } catch {
    // Ignore invalid package.json metadata and fall back to lockfiles.
  }

  if (projectHasFile(projectRoot, 'pnpm-lock.yaml')) return 'pnpm';
  return 'npm';
}

function detectWorkspaceFiles(projectRoot: string): string[] {
  return [
    'package.json',
    'pnpm-workspace.yaml',
    'turbo.json',
    'vite.config.ts',
    'vitest.config.ts',
    'jest.config.js',
    'tsconfig.json',
    'pyproject.toml',
    'pytest.ini',
    'requirements.txt',
    'go.mod',
    'Cargo.toml',
  ].filter((filePath) => projectHasFile(projectRoot, filePath));
}

function formatPackageScripts(scripts: Record<string, string>): string[] {
  return Object.entries(scripts)
    .filter(([name]) => ['test', 'lint', 'build', 'typecheck', 'check'].includes(name))
    .map(([name, command]) => `${name}: ${command}`);
}

function extractWorkSearchTerms(work: WorkTask): string[] {
  const source = `${work.title}\n${work.description}`;
  const pathLike = source.match(/[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+/g) ?? [];
  const words = source
    .replace(/[`*_#[\](){}:;,.!?]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && /[A-Za-z]/.test(word))
    .filter(
      (word) =>
        ![
          'this',
          'that',
          'with',
          'from',
          'into',
          'work',
          'task',
          'should',
          'would',
          'could',
          'when',
          'where',
          'there',
          'about',
          'using',
          'make',
          'update',
          'create',
          'delete',
          'remove',
          'fix',
          'add',
        ].includes(word.toLowerCase()),
    );

  return uniqueStrings([...pathLike, ...words]).slice(0, 8);
}

function collectLikelyFilesForWork(projectRoot: string, work: WorkTask): string[] {
  const results: string[] = [];
  for (const term of extractWorkSearchTerms(work)) {
    results.push(...searchProjectFiles(projectRoot, term).slice(0, 4));
    if (results.length >= 16) break;
  }
  return uniqueStrings(results).slice(0, 16);
}

function collectProjectPaths(
  root: string,
  predicate: (relativePath: string, dirent: fs.Dirent) => boolean,
  limit = MAX_SEARCH_RESULTS,
): string[] {
  const results: string[] = [];
  const walk = (currentDir: string) => {
    if (results.length >= limit) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (results.length >= limit) return;
      if (
        dirent.name === '.git' ||
        dirent.name === '.kira' ||
        dirent.name === '.openroom' ||
        dirent.name === 'node_modules' ||
        dirent.name === '.venv' ||
        dirent.name === 'automation-locks'
      ) {
        continue;
      }
      const absolutePath = join(currentDir, dirent.name);
      const relativePath = absolutePath
        .slice(root.length)
        .replace(/^[\\/]+/, '')
        .replace(/\\/g, '/');
      if (predicate(relativePath, dirent)) {
        results.push(relativePath);
      }
      if (dirent.isDirectory()) {
        walk(absolutePath);
      }
    }
  };

  walk(root);
  return uniqueStrings(results).slice(0, limit);
}

function collectRelatedDocs(projectRoot: string, work: WorkTask): string[] {
  const terms = extractWorkSearchTerms(work).map((term) => term.toLowerCase());
  const docs = collectProjectPaths(
    projectRoot,
    (relativePath, dirent) => {
      if (!dirent.isFile()) return false;
      const lowerPath = relativePath.toLowerCase();
      if (!/\.(md|mdx|txt|rst)$/.test(lowerPath)) return false;
      return terms.length === 0 || terms.some((term) => lowerPath.includes(term));
    },
    20,
  );

  return docs.length > 0
    ? docs
    : collectProjectPaths(
        projectRoot,
        (relativePath, dirent) =>
          dirent.isFile() &&
          /(^|\/)(readme|contributing|architecture|guide).*\.md$/i.test(relativePath),
        10,
      );
}

function collectRelatedTests(projectRoot: string, work: WorkTask): string[] {
  const terms = extractWorkSearchTerms(work).map((term) => term.toLowerCase());
  return collectProjectPaths(
    projectRoot,
    (relativePath, dirent) => {
      if (!dirent.isFile()) return false;
      const lowerPath = relativePath.toLowerCase();
      const isTestPath =
        lowerPath.includes('/__tests__/') ||
        lowerPath.includes('/tests/') ||
        /\.(test|spec)\.[a-z0-9]+$/.test(lowerPath) ||
        /^tests?\//.test(lowerPath);
      if (!isTestPath) return false;
      return terms.length === 0 || terms.some((term) => lowerPath.includes(term));
    },
    20,
  );
}

function extractSearchResultPath(entry: string): string {
  const normalized = normalizeRelativePath(entry.replace(/^\[(?:file|dir)\]\s+/i, ''));
  const colonIndex = normalized.indexOf(':');
  return colonIndex >= 0 ? normalizeRelativePath(normalized.slice(0, colonIndex)) : normalized;
}

function extractSearchResultPaths(entries: string[]): string[] {
  return normalizePathList(
    entries.map((entry) => extractSearchResultPath(entry)),
    40,
  );
}

function stripKnownSourceExtension(relativePath: string): string {
  return normalizeRelativePath(relativePath).replace(
    /\.(test|spec)?\.?(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|cs)$/i,
    '',
  );
}

function collectRelatedTestsForFiles(projectRoot: string, files: string[]): string[] {
  const normalizedFiles = normalizePathList(files, 40).filter(
    (file) => !/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(file),
  );
  if (normalizedFiles.length === 0) return [];

  const bases = uniqueStrings(
    normalizedFiles
      .map((file) => basename(stripKnownSourceExtension(file)).toLowerCase())
      .filter((item) => item.length >= 2),
  );
  if (bases.length === 0) return [];

  return collectProjectPaths(
    projectRoot,
    (relativePath, dirent) => {
      if (!dirent.isFile()) return false;
      const lowerPath = relativePath.toLowerCase();
      const isTestPath =
        lowerPath.includes('/__tests__/') ||
        lowerPath.includes('/tests/') ||
        /\.(test|spec)\.[a-z0-9]+$/.test(lowerPath) ||
        /^tests?\//.test(lowerPath);
      if (!isTestPath) return false;
      return bases.some((base) => basename(stripKnownSourceExtension(lowerPath)).includes(base));
    },
    12,
  );
}

function inferTaskType(work: WorkTask, files: string[] = []): KiraTaskType {
  const source = `${work.title}\n${work.description}\n${files.join('\n')}`.toLowerCase();
  if (/\b(auth|oauth|login|permission|security|token|session|csrf|xss|crypto)\b/.test(source)) {
    return 'security-auth';
  }
  if (/\b(migration|schema|database|db|sql|prisma|typeorm|knex)\b/.test(source)) {
    return 'data-migration';
  }
  if (/\b(api|route|endpoint|server|controller|service|backend)\b/.test(source)) {
    return 'backend-api';
  }
  if (/\b(test|spec|vitest|jest|pytest|coverage|validation)\b/.test(source)) {
    return 'test-validation';
  }
  if (/\b(config|vite|webpack|tsconfig|eslint|lint|build|package|tooling|ci)\b/.test(source)) {
    return 'tooling-config';
  }
  if (
    /\b(doc|readme|guide|markdown|mdx)\b/.test(source) ||
    files.every((file) => /\.(md|mdx|txt|rst)$/i.test(file))
  ) {
    return 'docs-maintainer';
  }
  if (
    /\b(ui|ux|screen|page|component|style|css|scss|layout|button|modal|form|react)\b/.test(source)
  ) {
    return 'frontend-ui';
  }
  return 'generalist';
}

function buildTaskPlaybook(taskType: KiraTaskType, confidence = 0.65): TaskPlaybook {
  const shared = {
    confidence,
    inspectFocus: ['changed files', 'nearest callers', 'nearest tests'],
    validationFocus: ['targeted tests for changed files', 'type or build checks when available'],
    reviewChecklist: [
      'requirements covered',
      'actual diff matches summary',
      'validation evidence is credible',
    ],
    riskSignals: ['unplanned file edits', 'skipped validation', 'unclear requirement tradeoffs'],
  };
  const byType: Record<KiraTaskType, Omit<TaskPlaybook, 'taskType' | 'confidence'>> = {
    'frontend-ui': {
      inspectFocus: [
        'component files',
        'stylesheets',
        'state hooks',
        'rendering entry points',
        'nearby UI tests',
      ],
      validationFocus: [
        'targeted component tests',
        'typecheck',
        'build',
        'runtime smoke check if a dev server is already running',
      ],
      reviewChecklist: [
        'responsive layout',
        'copy fits containers',
        'console/runtime errors',
        'accessibility states',
      ],
      riskSignals: [
        'layout overlap',
        'missing empty/loading/error states',
        'runtime render failure',
      ],
    },
    'backend-api': {
      inspectFocus: [
        'route handlers',
        'service layer',
        'data contracts',
        'callers/clients',
        'API tests',
      ],
      validationFocus: ['targeted API tests', 'typecheck/build', 'contract or integration checks'],
      reviewChecklist: [
        'request validation',
        'error handling',
        'backward compatibility',
        'data flow correctness',
      ],
      riskSignals: [
        'contract drift',
        'missing error branch',
        'unvalidated input',
        'hidden side effects',
      ],
    },
    'test-validation': {
      inspectFocus: ['failing tests', 'test helpers', 'implementation under test', 'fixtures'],
      validationFocus: ['specific failing test', 'related test file', 'minimal broader suite'],
      reviewChecklist: [
        'test asserts behavior not implementation trivia',
        'no weakened assertions',
        'failure reproduced conceptually',
      ],
      riskSignals: ['deleted assertions', 'over-mocking', 'snapshot churn', 'test-only workaround'],
    },
    'tooling-config': {
      inspectFocus: [
        'package scripts',
        'config files',
        'workspace boundaries',
        'CI-sensitive files',
      ],
      validationFocus: ['config-specific command', 'typecheck/build', 'lint where relevant'],
      reviewChecklist: [
        'tool compatibility',
        'workspace scope',
        'script safety',
        'developer workflow impact',
      ],
      riskSignals: ['lockfile churn', 'broad config blast radius', 'version mismatch'],
    },
    'docs-maintainer': {
      inspectFocus: ['related docs', 'examples', 'referenced code paths'],
      validationFocus: ['link/example sanity', 'formatting where configured'],
      reviewChecklist: ['accuracy against current code', 'clear scope', 'no stale commands'],
      riskSignals: ['invented behavior', 'stale API name', 'unverified command'],
    },
    'data-migration': {
      inspectFocus: [
        'schema/migration files',
        'models',
        'read/write paths',
        'rollback story',
        'data tests',
      ],
      validationFocus: ['migration check', 'model tests', 'type/build checks'],
      reviewChecklist: ['data loss risk', 'backward compatibility', 'rollback path', 'idempotency'],
      riskSignals: ['destructive schema change', 'missing rollback', 'silent data conversion'],
    },
    'security-auth': {
      inspectFocus: [
        'auth flows',
        'permission checks',
        'token/session handling',
        'security-sensitive tests',
      ],
      validationFocus: ['targeted auth/security tests', 'typecheck/build', 'negative-path tests'],
      reviewChecklist: [
        'authorization boundaries',
        'secret handling',
        'failure modes',
        'least privilege',
      ],
      riskSignals: [
        'permission bypass',
        'secret exposure',
        'unsafe default',
        'missing negative test',
      ],
    },
    generalist: shared,
  };
  return { taskType, confidence, ...byType[taskType] };
}

function extractRequirementLines(value: string): string[] {
  return limitedUniqueStrings(
    value
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/^#{1,6}\s*/, '')
          .replace(/^\s*[-*+]\s*/, '')
          .replace(/^\s*\d+[.)]\s*/, '')
          .trim(),
      )
      .filter((line) => line.length >= 8 && !/^brief$/i.test(line)),
    MAX_REQUIREMENT_TRACE_ITEMS,
  );
}

function buildRequirementTrace(work: WorkTask, requiredInstructions = ''): RequirementTraceItem[] {
  const briefItems = extractRequirementLines(`${work.title}\n${work.description}`).map(
    (text, index): RequirementTraceItem => ({
      id: `R${index + 1}`,
      source: 'brief',
      text,
      status: 'planned',
      evidence: [],
    }),
  );
  const instructionItems = extractRequirementLines(requiredInstructions).map(
    (text, index): RequirementTraceItem => ({
      id: `P${index + 1}`,
      source: 'project-instruction',
      text,
      status: 'planned',
      evidence: [],
    }),
  );
  return [...briefItems, ...instructionItems].slice(0, MAX_REQUIREMENT_TRACE_ITEMS);
}

function extractImportSpecifiers(content: string): string[] {
  const imports: string[] = [];
  const patterns = [
    /\bimport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bfrom\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) imports.push(match[1]);
    }
  }
  return limitedUniqueStrings(imports, 12);
}

function collectDependencyInsights(projectRoot: string, files: string[]): DependencyInsight[] {
  const normalizedFiles = normalizePathList(files, MAX_DEPENDENCY_INSIGHTS);
  if (normalizedFiles.length === 0) return [];
  const projectFiles = collectProjectPaths(
    projectRoot,
    (relativePath, dirent) =>
      dirent.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py)$/.test(relativePath),
    300,
  );

  return normalizedFiles
    .map((file): DependencyInsight | null => {
      const absolutePath = join(projectRoot, file);
      let imports: string[] = [];
      try {
        if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
          imports = extractImportSpecifiers(fs.readFileSync(absolutePath, 'utf-8'));
        }
      } catch {
        imports = [];
      }
      const stem = basename(stripKnownSourceExtension(file));
      const importedBy = projectFiles
        .filter((candidate) => candidate !== file)
        .filter((candidate) => {
          try {
            const content = fs.readFileSync(join(projectRoot, candidate), 'utf-8');
            return (
              content.includes(stem) || content.includes(file.replace(/\.(ts|tsx|js|jsx)$/i, ''))
            );
          } catch {
            return false;
          }
        })
        .slice(0, 6);
      return {
        file,
        imports,
        importedBy,
        nearbyTests: collectRelatedTestsForFiles(projectRoot, [file]).slice(0, 4),
      };
    })
    .filter((item): item is DependencyInsight => item !== null);
}

function inferSemanticNodeRole(
  relativePath: string,
  entrypoints: string[] = [],
): SemanticGraphNodeRole {
  const lowerPath = relativePath.toLowerCase();
  if (/\.(test|spec)\.[a-z0-9]+$/.test(lowerPath) || lowerPath.includes('/__tests__/')) {
    return 'test';
  }
  if (entrypoints.includes(relativePath)) return 'entrypoint';
  if (/\.(json|ya?ml|toml|config\.[jt]s|config\.mjs)$/i.test(relativePath)) return 'config';
  if (/\.(md|mdx|txt|rst)$/i.test(relativePath)) return 'doc';
  if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|cs)$/i.test(relativePath)) return 'source';
  return 'unknown';
}

function extractExportedSymbols(content: string): string[] {
  const symbols: string[] = [];
  const directExportPattern =
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of content.matchAll(directExportPattern)) {
    if (match[1]) symbols.push(match[1]);
  }
  for (const match of content.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    symbols.push(
      ...match[1]
        .split(',')
        .map((item) => item.replace(/\bas\b.+$/i, '').trim())
        .filter(Boolean),
    );
  }
  if (/\bmodule\.exports\b/.test(content)) symbols.push('module.exports');
  return limitedUniqueStrings(symbols, 12);
}

function extractDeclaredSymbols(content: string): string[] {
  const symbols: string[] = [];
  const declarationPattern =
    /\b(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  for (const match of content.matchAll(declarationPattern)) {
    const symbol = match[1] || match[2];
    if (symbol) symbols.push(symbol);
  }
  return limitedUniqueStrings(symbols, 16);
}

function collectSemanticCodeGraph(
  projectRoot: string,
  files: string[],
  profile?: KiraProjectProfile | null,
): SemanticGraphNode[] {
  const seedFiles = normalizePathList(
    [
      ...files,
      ...(profile?.repoMap.entrypoints ?? []).slice(0, 4),
      ...(profile?.validation.testFiles ?? []).slice(0, 4),
    ],
    MAX_SEMANTIC_GRAPH_NODES,
  );
  if (seedFiles.length === 0) return [];

  const projectFiles = collectProjectPaths(
    projectRoot,
    (relativePath, dirent) =>
      dirent.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|cs)$/.test(relativePath),
    400,
  );
  const entrypoints = profile?.repoMap.entrypoints ?? collectProjectEntrypoints(projectRoot);

  return seedFiles
    .map((file): SemanticGraphNode | null => {
      const absolutePath = join(projectRoot, file);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return null;
      let content = '';
      try {
        content = fs.readFileSync(absolutePath, 'utf-8');
      } catch {
        return null;
      }
      const imports = extractImportSpecifiers(content);
      const exports = extractExportedSymbols(content);
      const symbols = extractDeclaredSymbols(content);
      const stem = basename(stripKnownSourceExtension(file));
      const importNeedles = uniqueStrings([
        stem,
        file.replace(/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i, ''),
        `/${stem}`,
      ]).filter((item) => item.length >= 2);
      const dependents = projectFiles
        .filter((candidate) => candidate !== file)
        .filter((candidate) => {
          try {
            const candidateContent = fs.readFileSync(join(projectRoot, candidate), 'utf-8');
            return importNeedles.some((needle) => candidateContent.includes(needle));
          } catch {
            return false;
          }
        })
        .slice(0, 8);
      return {
        file,
        role: inferSemanticNodeRole(file, entrypoints),
        imports,
        exports,
        symbols,
        dependents,
        tests: collectRelatedTestsForFiles(projectRoot, [file]).slice(0, 6),
      };
    })
    .filter((item): item is SemanticGraphNode => item !== null)
    .slice(0, MAX_SEMANTIC_GRAPH_NODES);
}

function buildTestCommand(packageManager: 'pnpm' | 'npm' | null, testFiles: string[]): string {
  const formattedTests = testFiles.map(formatShellPath).join(' ');
  return packageManager === 'pnpm'
    ? `pnpm exec vitest ${formattedTests}`
    : `npm test -- ${formattedTests}`;
}

function buildTestImpactAnalysis(
  projectRoot: string,
  files: string[],
  packageManager: 'pnpm' | 'npm' | null,
): TestImpactTarget[] {
  const normalizedFiles = normalizePathList(files, MAX_TEST_IMPACT_TARGETS);
  if (normalizedFiles.length === 0) return [];

  return normalizedFiles
    .map((file): TestImpactTarget | null => {
      const isTestFile = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(file);
      const impactedTests = isTestFile
        ? [file]
        : collectRelatedTestsForFiles(projectRoot, [file]).slice(0, 5);
      const commands =
        packageManager && impactedTests.length > 0
          ? [buildTestCommand(packageManager, impactedTests.slice(0, 3))]
          : [];
      const rationale = impactedTests.length
        ? `Nearest tests were inferred from filename/path affinity for ${file}.`
        : `No direct test file was found for ${file}; reviewer should require another focused validation signal.`;
      return {
        file,
        impactedTests,
        commands,
        rationale,
        confidence: impactedTests.length > 0 ? 0.72 : 0.38,
      };
    })
    .filter((item): item is TestImpactTarget => item !== null)
    .slice(0, MAX_TEST_IMPACT_TARGETS);
}

function buildReviewAdversarialPlan(params: {
  taskType: KiraTaskType;
  files: string[];
  riskPolicy?: RiskReviewPolicy;
  runtimeValidation?: RuntimeValidationSignal;
  diffStats?: DiffStats;
  semanticGraph?: SemanticGraphNode[];
}): ReviewAdversarialPlan {
  const modes: ReviewerAdversarialMode[] = ['correctness', 'regression'];
  const rationale: string[] = [
    'Every attempt must prove requirement coverage and avoid regressions.',
  ];
  const source = params.files.join('\n').toLowerCase();
  if (
    params.taskType === 'security-auth' ||
    /\b(auth|token|secret|permission|session)\b/.test(source)
  ) {
    modes.push('security');
    rationale.push(
      'Security/auth signals require adversarial permission and secret handling checks.',
    );
  }
  if (
    params.taskType === 'data-migration' ||
    /\b(migration|schema|database|sql|prisma)\b/.test(source)
  ) {
    modes.push('data-safety');
    rationale.push('Data-changing surfaces require destructive-change and rollback scrutiny.');
  }
  if (params.runtimeValidation?.applicable || params.taskType === 'frontend-ui') {
    modes.push('runtime-ux');
    rationale.push(
      'Frontend/runtime-facing changes need render, reachable-server, and user-visible smoke evidence.',
    );
  }
  if ((params.semanticGraph ?? []).some((node) => node.dependents.length > 0)) {
    modes.push('integration');
    rationale.push(
      'Semantic graph dependents indicate callers may break even when local tests pass.',
    );
  }
  if (
    params.riskPolicy?.level === 'high' ||
    (params.diffStats?.files ?? 0) > SMALL_PATCH_FILE_LIMIT ||
    (params.diffStats?.additions ?? 0) + (params.diffStats?.deletions ?? 0) > SMALL_PATCH_LINE_LIMIT
  ) {
    modes.push('maintainability');
    rationale.push(
      'High-risk or broad patches need maintainability and review-surface pressure testing.',
    );
  }

  const uniqueModes = uniqueStrings(modes) as ReviewerAdversarialMode[];
  return {
    modes: uniqueModes,
    rationale: limitedUniqueStrings(rationale, 10),
    requiredEvidence: uniqueModes.map((mode) => {
      switch (mode) {
        case 'security':
          return 'Security mode: verify authorization boundaries, secret handling, and negative paths.';
        case 'data-safety':
          return 'Data-safety mode: verify non-destructive behavior, migration safety, and rollback intent.';
        case 'runtime-ux':
          return 'Runtime-UX mode: verify render/reachability evidence or a concrete reason it is unavailable.';
        case 'integration':
          return 'Integration mode: verify callers, exports, and nearby tests from the semantic graph.';
        case 'maintainability':
          return 'Maintainability mode: verify patch size, local conventions, and avoid broad incidental churn.';
        case 'regression':
          return 'Regression mode: verify changed files against tests, callers, and existing behavior.';
        default:
          return 'Correctness mode: verify every requirement has concrete implementation evidence.';
      }
    }),
  };
}

function buildClarificationQualityGate(
  work: WorkTask,
  contextScan: Pick<
    ProjectContextScan,
    'likelyFiles' | 'candidateChecks' | 'escalationSignals' | 'decomposition' | 'riskPolicy'
  >,
): ClarificationQualityGate {
  const reasons: string[] = [];
  const questions: string[] = [];
  const highSignals =
    contextScan.escalationSignals?.filter((signal) => signal.severity === 'high') ?? [];
  const briefText = `${work.title}\n${work.description}`.trim();
  let decision: ClarificationQualityGate['decision'] = 'proceed';
  let confidence = 0.72;

  if (contextScan.decomposition?.shouldSplit && contextScan.decomposition.confidence >= 0.88) {
    decision = 'split';
    confidence = Math.max(confidence, contextScan.decomposition.confidence);
    reasons.push(contextScan.decomposition.reason);
  }
  if (highSignals.length > 0) {
    decision = decision === 'split' ? decision : 'needs_clarification';
    confidence = Math.max(confidence, 0.86);
    reasons.push(...highSignals.map((signal) => signal.reason));
    questions.push(...highSignals.map((signal) => signal.suggestedQuestion));
  }
  if (briefText.length < 40 && contextScan.likelyFiles.length === 0) {
    decision = decision === 'split' ? decision : 'needs_clarification';
    confidence = Math.max(confidence, 0.78);
    reasons.push('The brief is too short to identify the implementation surface.');
    questions.push('Which concrete files, screen, API, or behavior should the worker change?');
  }
  if (contextScan.riskPolicy?.level === 'high' && contextScan.candidateChecks.length === 0) {
    decision = decision === 'split' ? decision : 'needs_clarification';
    confidence = Math.max(confidence, 0.8);
    reasons.push('High-risk work lacks an obvious validation path.');
    questions.push('What validation signal should be considered mandatory before approval?');
  }

  return {
    decision,
    confidence,
    reasons: limitedUniqueStrings(reasons, 8),
    questions: limitedUniqueStrings(questions, MAX_CLARIFICATION_QUESTIONS),
  };
}

function buildReviewerCalibration(
  profile: KiraProjectProfile | null | undefined,
  riskPolicy: RiskReviewPolicy | undefined,
  adversarialPlan: ReviewAdversarialPlan | undefined,
): ReviewerCalibration {
  const highValueMemories = (profile?.learning.scoredMemories ?? [])
    .filter((memory) => memory.score >= 0.55)
    .sort((a, b) => b.score - a.score || b.lastSeenAt - a.lastSeenAt)
    .slice(0, 6)
    .map((memory) => `${memory.source}/${memory.score.toFixed(2)}: ${memory.text}`);
  const reasons = limitedUniqueStrings(
    [
      ...(riskPolicy?.level === 'high' ? ['High-risk review policy is active.'] : []),
      ...(riskPolicy?.requiresRuntimeValidation
        ? ['Runtime validation evidence is required.']
        : []),
      ...(profile?.learning.recentReviewFailures.length
        ? ['Recent review failures exist in project memory.']
        : []),
      ...(adversarialPlan?.modes.includes('security')
        ? ['Security adversarial mode is active.']
        : []),
      ...(adversarialPlan?.modes.includes('data-safety')
        ? ['Data-safety adversarial mode is active.']
        : []),
    ],
    8,
  );
  const strictness: ReviewerCalibration['strictness'] =
    riskPolicy?.level === 'high' || adversarialPlan?.modes.includes('security')
      ? 'evidence-heavy'
      : reasons.length > 0 || highValueMemories.length > 0
        ? 'heightened'
        : 'normal';
  return {
    strictness,
    reasons,
    focusMemories: highValueMemories,
    evidenceMinimum: riskPolicy?.evidenceMinimum ?? 1,
  };
}

export function buildDesignReviewGate(params: {
  work: WorkTask;
  contextScan: ProjectContextScan;
  workerPlan: WorkerExecutionPlan;
  requiredInstructions?: string;
}): DesignReviewGate {
  const checks: DesignReviewCheck[] = [];
  const addCheck = (
    role: DesignReviewRole,
    verdict: DesignReviewCheck['verdict'],
    concern: string,
    evidence: string[],
    requiredChanges: string[] = [],
  ) => {
    checks.push({
      role,
      verdict,
      concern,
      evidence: limitedUniqueStrings(evidence, 8),
      requiredChanges: limitedUniqueStrings(requiredChanges, 6),
    });
  };

  const plan = params.workerPlan;
  const requiredInstructions = params.requiredInstructions?.trim() ?? '';
  const plannedRequirementIds = new Set(plan.requirementTrace.map((item) => item.id));
  const missingDetectedRequirements = (params.contextScan.requirementTrace ?? []).filter(
    (item) => !plannedRequirementIds.has(item.id),
  );
  const hasProjectInstructionTrace = plan.requirementTrace.some(
    (item) => item.source === 'project-instruction',
  );
  addCheck(
    'product',
    !plan.valid ||
      plan.requirementTrace.length === 0 ||
      missingDetectedRequirements.length > 0 ||
      (requiredInstructions.length > 0 && !hasProjectInstructionTrace)
      ? 'block'
      : plan.confidence < 0.58
        ? 'warn'
        : 'pass',
    'Validate that the plan covers the requested behavior and mandatory project instructions before editing.',
    [
      `Plan valid: ${plan.valid}`,
      `Requirement trace entries: ${plan.requirementTrace.length}`,
      `Missing detected requirements: ${formatInlineList(
        missingDetectedRequirements.map((item) => item.id),
      )}`,
      `Plan confidence: ${plan.confidence.toFixed(2)}`,
    ],
    [
      ...(!plan.valid ? ['Return a valid structured worker plan before implementation.'] : []),
      ...(plan.requirementTrace.length === 0
        ? ['Add a requirementTrace that maps every requested behavior to planned evidence.']
        : []),
      ...missingDetectedRequirements.map(
        (item) => `Cover detected requirement ${item.id}: ${item.text}`,
      ),
      ...(requiredInstructions.length > 0 && !hasProjectInstructionTrace
        ? ['Map mandatory project instructions into requirementTrace before editing.']
        : []),
      ...(plan.confidence < 0.58
        ? ['Inspect more repository context or narrow the plan before implementation.']
        : []),
    ],
  );

  const protectedAndPlanned = plan.intendedFiles.filter((file) => isProtectedFile(plan, file));
  const designTargetsOutsidePlan = plan.changeDesign.targetFiles.filter(
    (file) => !pathMatchesScope(plan.intendedFiles, file),
  );
  addCheck(
    'architecture',
    protectedAndPlanned.length > 0 ||
      designTargetsOutsidePlan.length > 0 ||
      plan.intendedFiles.length === 0 ||
      plan.changeDesign.targetFiles.length === 0
      ? 'block'
      : plan.intendedFiles.length > SMALL_PATCH_PLAN_FILE_LIMIT
        ? 'warn'
        : 'pass',
    'Validate planned ownership, file scope, and change design consistency.',
    [
      `Intended files: ${formatInlineList(plan.intendedFiles)}`,
      `Target files: ${formatInlineList(plan.changeDesign.targetFiles)}`,
      `Protected collisions: ${formatInlineList(protectedAndPlanned)}`,
      `Targets outside intendedFiles: ${formatInlineList(designTargetsOutsidePlan)}`,
    ],
    [
      ...(plan.intendedFiles.length === 0 ? ['Identify intendedFiles before implementation.'] : []),
      ...(plan.changeDesign.targetFiles.length === 0
        ? ['Identify changeDesign.targetFiles before implementation.']
        : []),
      ...protectedAndPlanned.map((file) => `Remove protected file from intendedFiles: ${file}`),
      ...designTargetsOutsidePlan.map(
        (file) => `Either add ${file} to intendedFiles or remove it from changeDesign.targetFiles.`,
      ),
      ...(plan.intendedFiles.length > SMALL_PATCH_PLAN_FILE_LIMIT
        ? ['Narrow intendedFiles or split the task before implementation.']
        : []),
    ],
  );

  const impactedCommands = params.contextScan.testImpact?.flatMap((item) => item.commands) ?? [];
  const missingValidation =
    params.contextScan.candidateChecks.length > 0 && plan.validationCommands.length === 0;
  const plannedCommands = plan.validationCommands.join('\n').toLowerCase();
  const missingImpactCommands = impactedCommands.filter(
    (command) => !plannedCommands.includes(command.toLowerCase()),
  );
  addCheck(
    'validation',
    missingValidation ||
      (params.contextScan.riskPolicy?.level === 'high' && plan.validationCommands.length === 0)
      ? 'block'
      : missingImpactCommands.length > 0 && plan.validationCommands.length < 2
        ? 'warn'
        : 'pass',
    'Validate that the plan has an executable proof strategy before code changes begin.',
    [
      `Planned commands: ${formatInlineList(plan.validationCommands)}`,
      `Candidate checks: ${formatInlineList(params.contextScan.candidateChecks)}`,
      `Impacted-test commands: ${formatInlineList(impactedCommands)}`,
    ],
    [
      ...(missingValidation
        ? [
            'Add at least one safe validation command or explain a concrete non-command validation signal.',
          ]
        : []),
      ...missingImpactCommands
        .slice(0, 3)
        .map((command) => `Consider impacted-test validation: ${command}`),
    ],
  );

  const highRiskNoRollback =
    params.contextScan.riskPolicy?.level === 'high' &&
    plan.changeDesign.rollbackStrategy.length === 0;
  addCheck(
    'risk',
    plan.escalation.shouldAsk || plan.escalation.blockers.length > 0 || highRiskNoRollback
      ? 'block'
      : plan.riskNotes.length === 0 && (params.contextScan.riskPolicy?.level ?? 'low') !== 'low'
        ? 'warn'
        : 'pass',
    'Validate that known risks, uncertainty, and rollback expectations are resolved before editing.',
    [
      `Risk level: ${params.contextScan.riskPolicy?.level ?? 'unknown'}`,
      `Risk notes: ${formatInlineList(plan.riskNotes)}`,
      `Escalation questions: ${formatInlineList(plan.escalation.questions)}`,
      `Escalation blockers: ${formatInlineList(plan.escalation.blockers)}`,
    ],
    [
      ...(plan.escalation.shouldAsk || plan.escalation.blockers.length > 0
        ? [
            `Resolve or ask about escalation before implementation: ${formatInlineList([
              ...plan.escalation.questions,
              ...plan.escalation.blockers,
            ])}`,
          ]
        : []),
      ...(highRiskNoRollback
        ? ['Add a rollbackStrategy for the high-risk change before implementation.']
        : []),
      ...(plan.riskNotes.length === 0 && (params.contextScan.riskPolicy?.level ?? 'low') !== 'low'
        ? ['Record concrete riskNotes for the reviewer.']
        : []),
    ],
  );

  const likelyFiles = extractSearchResultPaths(params.contextScan.likelyFiles);
  const ignoredLikelyFiles = likelyFiles
    .slice(0, 8)
    .filter((file) => !pathMatchesScope(plan.intendedFiles, file));
  addCheck(
    'integration',
    params.contextScan.decomposition?.shouldSplit &&
      params.contextScan.decomposition.confidence >= 0.9 &&
      !plan.decomposition.shouldSplit
      ? 'block'
      : ignoredLikelyFiles.length > 0 && plan.intendedFiles.length <= 2
        ? 'warn'
        : 'pass',
    'Validate that the plan accounts for likely callers, adjacent files, and decomposition signals.',
    [
      `Likely files not in intendedFiles: ${formatInlineList(ignoredLikelyFiles)}`,
      `Semantic graph nodes: ${params.contextScan.semanticGraph?.length ?? 0}`,
      `Decomposition: ${params.contextScan.decomposition?.reason ?? 'not available'}`,
    ],
    [
      ...(params.contextScan.decomposition?.shouldSplit &&
      params.contextScan.decomposition.confidence >= 0.9 &&
      !plan.decomposition.shouldSplit
        ? ['Split the task or explicitly narrow the work to one safe slice.']
        : []),
      ...(ignoredLikelyFiles.length > 0 && plan.intendedFiles.length <= 2
        ? [`Explain why likely files are out of scope: ${formatInlineList(ignoredLikelyFiles)}`]
        : []),
    ],
  );

  const requiredChanges = limitedUniqueStrings(
    checks.flatMap((check) => check.requiredChanges),
    12,
  );
  const blockedCount = checks.filter((check) => check.verdict === 'block').length;
  const warnCount = checks.filter((check) => check.verdict === 'warn').length;
  const status: DesignReviewGate['status'] =
    blockedCount > 0 ? 'blocked' : warnCount > 0 ? 'warning' : 'passed';
  return {
    status,
    summary:
      status === 'passed'
        ? 'Design review gate passed; implementation may proceed with the recorded plan.'
        : status === 'warning'
          ? `Design review gate found ${warnCount} warning(s); implementation may proceed but the worker and reviewer must address them.`
          : `Design review gate blocked implementation with ${blockedCount} blocking issue(s).`,
    checks,
    requiredChanges,
    createdAt: Date.now(),
  };
}

export function collectDesignReviewGateIssues(gate: DesignReviewGate | undefined): string[] {
  if (!gate || gate.status !== 'blocked') return [];
  return limitedUniqueStrings(
    gate.checks
      .filter((check) => check.verdict === 'block')
      .flatMap((check) =>
        check.requiredChanges.length > 0
          ? check.requiredChanges.map((change) => `Design review ${check.role}: ${change}`)
          : [`Design review ${check.role}: ${check.concern}`],
      ),
    12,
  );
}

function detectEscalationSignals(work: WorkTask, taskType: KiraTaskType): EscalationSignal[] {
  const source = `${work.title}\n${work.description}`.toLowerCase();
  const signals: EscalationSignal[] = [];
  if (/\b(tbd|todo|unclear|maybe|somehow|figure out|as appropriate|etc\.?)\b/.test(source)) {
    signals.push({
      severity: 'medium',
      reason: 'The brief contains ambiguous implementation language.',
      suggestedQuestion:
        'Which concrete behavior should be implemented before the worker edits code?',
    });
  }
  if (
    taskType === 'data-migration' &&
    !/\brollback|backup|preserve|non-destructive\b/.test(source)
  ) {
    signals.push({
      severity: 'high',
      reason: 'Data migration work does not state a rollback or data preservation expectation.',
      suggestedQuestion:
        'Should this migration be strictly non-destructive, and what rollback behavior is required?',
    });
  }
  if (
    taskType === 'security-auth' &&
    !/\b(role|permission|allow|deny|policy|scope)\b/.test(source)
  ) {
    signals.push({
      severity: 'high',
      reason: 'Security/auth work lacks explicit authorization boundary details.',
      suggestedQuestion:
        'Which users, roles, or scopes should be allowed and denied after this change?',
    });
  }
  return signals.slice(0, MAX_CLARIFICATION_QUESTIONS);
}

function buildRuntimeValidationSignal(
  taskType: KiraTaskType,
  files: string[],
): RuntimeValidationSignal {
  const frontendSignals =
    taskType === 'frontend-ui' ||
    files.some((file) => /\.(tsx|jsx|css|scss|sass|html?)$/i.test(file));
  if (!frontendSignals) {
    return {
      applicable: false,
      reason: 'Runtime UI validation is not applicable to this task type or file set.',
      suggestedUrls: [],
    };
  }
  return {
    applicable: true,
    reason:
      'Frontend-facing files changed; if a dev server is already running, Kira should perform a runtime reachability smoke check without starting a server.',
    suggestedUrls: COMMON_DEV_SERVER_PORTS.map((port) => `http://127.0.0.1:${port}`),
  };
}

function assessRiskReviewPolicy(params: {
  projectRoot: string;
  work: WorkTask;
  taskType: KiraTaskType;
  files: string[];
  diffStats?: DiffStats;
  runtimeValidation?: RuntimeValidationSignal;
  runMode?: KiraRunMode;
}): RiskReviewPolicy {
  const reasons: string[] = [];
  const source =
    `${params.work.title}\n${params.work.description}\n${params.files.join('\n')}`.toLowerCase();
  if (params.taskType === 'security-auth') reasons.push('Security/auth task type.');
  if (params.taskType === 'data-migration') reasons.push('Data migration task type.');
  if (/\b(auth|token|secret|permission|payment|billing|migration|schema|lockfile)\b/.test(source)) {
    reasons.push('High-risk wording or files detected.');
  }
  if (params.files.some((file) => isHighRiskFile(params.projectRoot, file))) {
    reasons.push('High-risk file pattern detected.');
  }
  if (
    (params.diffStats?.files ?? 0) >= 6 ||
    (params.diffStats?.additions ?? 0) + (params.diffStats?.deletions ?? 0) >= 400
  ) {
    reasons.push('Large patch review surface.');
  }
  const level: RiskReviewPolicy['level'] =
    reasons.some((item) => /security|migration|high-risk/i.test(item)) || reasons.length >= 2
      ? 'high'
      : reasons.length === 1 || params.runtimeValidation?.applicable
        ? 'medium'
        : 'low';
  const runMode = params.runMode ?? 'standard';
  if (runMode === 'deep') {
    reasons.push('Deep run mode requires stronger independent review evidence.');
  }
  const evidenceMinimum = level === 'high' ? 3 : level === 'medium' ? 2 : 1;
  return {
    level,
    reasons: limitedUniqueStrings(reasons, 8),
    evidenceMinimum: runMode === 'deep' ? Math.min(5, evidenceMinimum + 1) : evidenceMinimum,
    requiresRuntimeValidation: Boolean(params.runtimeValidation?.applicable),
    requiresSecondPass: level === 'high' || runMode === 'deep',
  };
}

function buildOrchestrationPlan(params: {
  work: WorkTask;
  taskType: KiraTaskType;
  runMode: KiraRunMode;
  workerCount: number;
  riskPolicy: RiskReviewPolicy;
  runtimeValidation: RuntimeValidationSignal;
  subagentRegistry?: KiraSubagentDefinition[];
  workflowDag?: KiraWorkflowDag;
  environmentContract?: KiraEnvironmentContract;
  pluginConnectors?: KiraPluginConnector[];
}): OrchestrationPlan {
  const runtimeEvidence = params.runtimeValidation.applicable
    ? ['runtime reachability or clear non-applicable note']
    : [];
  const baseEvidence = ['diff evidence', 'validation rerun evidence', ...runtimeEvidence];
  const enabledSubagents = (params.subagentRegistry ?? normalizeSubagentRegistry(null)).filter(
    (agent) => agent.enabled,
  );
  const workflowDag = params.workflowDag ?? normalizeWorkflowDag(null, params.runMode);
  const environmentContract = normalizeEnvironmentContract(params.environmentContract);
  const enabledConnectors = (params.pluginConnectors ?? normalizePluginConnectors(null)).filter(
    (connector) => connector.enabled,
  );
  const subagentByIntent = (intent: RegExp) =>
    enabledSubagents.find((agent) => intent.test(`${agent.id} ${agent.label} ${agent.profile}`));
  const laneFromSubagent = (
    id: string,
    role: string,
    goal: string,
    evidence: string[],
    agent?: KiraSubagentDefinition,
  ) => ({
    id,
    role: agent ? `${role} (${agent.label})` : role,
    goal,
    ...(agent ? { subagentId: agent.id } : {}),
    toolScope: agent?.tools ?? [],
    ...(agent?.modelHint ? { modelHint: agent.modelHint } : {}),
    requiredEvidence: uniqueStrings([...evidence, ...(agent?.requiredEvidence ?? [])]).slice(0, 12),
  });
  const plannerAgent = subagentByIntent(/explore|plan|architect|research/i);
  const implementerAgent =
    subagentByIntent(/implement|worker|builder|developer/i) ??
    getPrimaryImplementationSubagent(enabledSubagents);
  const validatorAgent = subagentByIntent(/test|validat|quality/i);
  const reviewerAgent = subagentByIntent(/review|security|judge|integration/i);
  const lanes =
    params.runMode === 'quick'
      ? [
          laneFromSubagent(
            'implement',
            'focused implementer',
            'Make the smallest complete correct change that satisfies the full acceptance target and record validation evidence.',
            baseEvidence.slice(0, 2),
            implementerAgent,
          ),
        ]
      : params.runMode === 'deep'
        ? [
            laneFromSubagent(
              'plan',
              'planner',
              'Identify scope, invariants, and stop conditions before editing.',
              ['preflight repository reads', 'change design'],
              plannerAgent,
            ),
            laneFromSubagent(
              'implement',
              'implementer',
              'Apply the planned patch while preserving project rules.',
              baseEvidence,
              implementerAgent,
            ),
            laneFromSubagent(
              'challenge',
              'adversarial reviewer',
              'Challenge correctness, regression, and integration assumptions.',
              ['adversarialChecks', 'reviewerDiscourse'],
              reviewerAgent,
            ),
            laneFromSubagent(
              'approval',
              'approval judge',
              'Approve only when the evidence ledger is ready and blockers are clear.',
              ['evidenceChecked', 'requirementVerdicts'],
              reviewerAgent,
            ),
          ]
        : [
            laneFromSubagent(
              'plan',
              'planner',
              'Map likely files, validation commands, and patch boundaries without shrinking the acceptance target.',
              ['preflight repository reads', 'change design'],
              plannerAgent,
            ),
            laneFromSubagent(
              'implement',
              'implementer',
              'Implement the scoped change and produce worker self-check evidence.',
              baseEvidence,
              implementerAgent,
            ),
            laneFromSubagent(
              'review',
              'reviewer',
              'Review changed files, validation, requirements, and concrete risks.',
              ['filesChecked', 'evidenceChecked'],
              validatorAgent ?? reviewerAgent,
            ),
          ];
  const checkpoints = [
    'preflight plan before edits',
    'design review gate before implementation',
    'Kira validation reruns after implementation',
    'patch intent verification before approval',
    `workflow DAG critical path: ${formatInlineList(workflowDag.criticalPath)}`,
    `execution runner: ${environmentContract.runner}`,
    ...(params.runMode === 'deep' ? ['evidence ledger readiness before completion'] : []),
  ];
  return {
    promptContractVersion: KIRA_PROMPT_CONTRACT_VERSION,
    runMode: params.runMode,
    taskType: params.taskType,
    workerCount: Math.max(1, params.workerCount),
    validationDepth:
      params.runMode === 'deep' ? 'deep' : params.runMode === 'quick' ? 'focused' : 'standard',
    reviewDepth:
      params.runMode === 'deep'
        ? 'evidence-heavy'
        : params.riskPolicy.level === 'low' && params.runMode === 'quick'
          ? 'focused'
          : 'adversarial',
    approvalThreshold: params.runMode === 'deep' ? 88 : params.runMode === 'quick' ? 72 : 80,
    subagentIds: enabledSubagents.map((agent) => agent.id),
    workflowDag,
    runner: environmentContract.runner,
    connectors: enabledConnectors.map((connector) => connector.id),
    summary: `${params.runMode} orchestration for "${params.work.title}" (${params.taskType}): ${lanes.length} lane(s), ${enabledSubagents.length} subagent contract(s), ${params.riskPolicy.evidenceMinimum}+ evidence item(s) required.`,
    lanes,
    checkpoints,
    stopRules: [
      'Stop if validation reruns fail and the failure is actionable.',
      'Stop if patch intent drifts from the accepted plan.',
      'Stop if mandatory project instructions or enabled rule packs are violated.',
      ...(params.riskPolicy.requiresRuntimeValidation
        ? ['Stop on failed runtime validation when a dev server is detected.']
        : []),
    ],
  };
}

function emptyRuntimeValidationResult(signal?: RuntimeValidationSignal): RuntimeValidationResult {
  return {
    checked: false,
    applicable: Boolean(signal?.applicable),
    serverDetected: false,
    url: null,
    status: signal?.applicable ? 'not_running' : 'skipped',
    notes: signal?.applicable
      ? ['No running dev server was detected; Kira did not start one.']
      : ['Runtime validation was not applicable.'],
    evidence: [],
  };
}

function probeTcpPort(port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(result);
    };
    socket.setTimeout(RUNTIME_PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function stripHtmlForEvidence(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' '),
  );
}

async function collectRuntimeHttpEvidence(
  url: string,
): Promise<
  Pick<RuntimeValidationResult, 'httpStatus' | 'contentType' | 'title' | 'bodySnippet' | 'evidence'>
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RUNTIME_PROBE_TIMEOUT_MS * 3);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') ?? undefined;
    const body = await response.text();
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
    const bodySnippet = stripHtmlForEvidence(body).slice(0, MAX_RUNTIME_EVIDENCE_CHARS);
    return {
      httpStatus: response.status,
      ...(contentType ? { contentType } : {}),
      ...(title ? { title: stripHtmlForEvidence(title).slice(0, 160) } : {}),
      ...(bodySnippet ? { bodySnippet } : {}),
      evidence: [
        `HTTP GET ${url} returned ${response.status}.`,
        ...(contentType ? [`Content-Type: ${contentType}`] : []),
        ...(title ? [`Page title: ${stripHtmlForEvidence(title).slice(0, 160)}`] : []),
      ],
    };
  } catch (error) {
    return {
      evidence: [
        `TCP port was reachable at ${url}, but HTTP evidence capture failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function collectRuntimeValidationResult(
  signal: RuntimeValidationSignal | undefined,
): Promise<RuntimeValidationResult> {
  if (!signal?.applicable) return emptyRuntimeValidationResult(signal);
  for (const port of COMMON_DEV_SERVER_PORTS) {
    if (await probeTcpPort(port)) {
      const url = `http://127.0.0.1:${port}`;
      const evidence = await collectRuntimeHttpEvidence(url);
      const httpReachable = typeof evidence.httpStatus === 'number';
      return {
        checked: true,
        applicable: true,
        serverDetected: true,
        url,
        status: httpReachable ? 'reachable' : 'not_running',
        notes: [
          'Detected an already-running dev server; Kira did not start a server.',
          ...(httpReachable
            ? [`Captured HTTP status ${evidence.httpStatus}.`]
            : ['The port accepted TCP connections, but HTTP evidence capture failed.']),
        ],
        ...evidence,
      };
    }
  }
  return emptyRuntimeValidationResult(signal);
}

function collectTopLevelDirectories(projectRoot: string): string[] {
  try {
    return fs
      .readdirSync(projectRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !['node_modules', 'dist', 'build', 'coverage'].includes(entry.name),
      )
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_PROJECT_PROFILE_LIST_ITEMS);
  } catch {
    return [];
  }
}

function collectDirectoryMatches(projectRoot: string, patterns: RegExp[], limit = 20): string[] {
  return collectProjectPaths(
    projectRoot,
    (relativePath, dirent) =>
      dirent.isDirectory() && patterns.some((pattern) => pattern.test(relativePath)),
    limit,
  );
}

function collectProjectEntrypoints(projectRoot: string): string[] {
  return collectProjectPaths(
    projectRoot,
    (relativePath, dirent) => {
      if (!dirent.isFile()) return false;
      return /(^|\/)(main|index|app|server|client|routes?|pages?)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i.test(
        relativePath,
      );
    },
    20,
  );
}

function collectHighRiskProjectFiles(projectRoot: string): string[] {
  return collectProjectPaths(
    projectRoot,
    (relativePath, dirent) => {
      if (!dirent.isFile()) return false;
      const lowerPath = relativePath.toLowerCase();
      return (
        lowerPath.includes('auth') ||
        lowerPath.includes('security') ||
        lowerPath.includes('payment') ||
        lowerPath.includes('permission') ||
        lowerPath.includes('migration') ||
        lowerPath.endsWith('.env') ||
        lowerPath.endsWith('.lock') ||
        /(^|\/)(package-lock|pnpm-lock|yarn\.lock|bun\.lockb)$/.test(lowerPath)
      );
    },
    20,
  );
}

function detectGeneratedPaths(projectRoot: string): string[] {
  return collectProjectPaths(
    projectRoot,
    (relativePath, dirent) => {
      if (!dirent.isDirectory() && !dirent.isFile()) return false;
      return /(^|\/)(dist|build|coverage|generated|__generated__|\.next|out)(\/|$)/i.test(
        relativePath,
      );
    },
    20,
  );
}

function detectStyleSignals(projectRoot: string): string[] {
  const signals: string[] = [];
  const knownFiles: Array<[string, string]> = [
    ['tsconfig.json', 'TypeScript project; prefer explicit public API typing.'],
    ['.eslintrc', 'ESLint configuration present.'],
    ['eslint.config.js', 'Flat ESLint configuration present.'],
    ['eslint.config.mjs', 'Flat ESLint configuration present.'],
    ['.prettierrc', 'Prettier formatting configuration present.'],
    ['prettier.config.js', 'Prettier formatting configuration present.'],
    ['biome.json', 'Biome formatting/linting configuration present.'],
    ['tailwind.config.js', 'Tailwind CSS conventions may apply.'],
    ['stylelint.config.js', 'Stylelint configuration present.'],
    ['pyproject.toml', 'Python tooling is configured in pyproject.toml.'],
    ['ruff.toml', 'Ruff linting configuration present.'],
  ];
  for (const [relativePath, signal] of knownFiles) {
    if (projectHasFile(projectRoot, relativePath)) signals.push(signal);
  }
  if (projectHasDirectory(projectRoot, 'src/components')) {
    signals.push('Component conventions likely live under src/components.');
  }
  if (projectHasDirectory(projectRoot, 'apps')) {
    signals.push('Multi-app layout detected; preserve app ownership boundaries.');
  }
  return limitedUniqueStrings(signals);
}

function inferProjectWorkerProfiles(projectRoot: string): string[] {
  const profiles: string[] = ['generalist'];
  if (
    projectHasDirectory(projectRoot, 'src/components') ||
    projectHasDirectory(projectRoot, 'pages')
  ) {
    profiles.push('frontend-ui');
  }
  if (
    projectHasDirectory(projectRoot, 'server') ||
    projectHasDirectory(projectRoot, 'api') ||
    projectHasDirectory(projectRoot, 'src/server') ||
    projectHasDirectory(projectRoot, 'src/api')
  ) {
    profiles.push('backend-api');
  }
  if (
    projectHasDirectory(projectRoot, 'tests') ||
    projectHasDirectory(projectRoot, '__tests__') ||
    projectHasDirectory(projectRoot, 'src/tests') ||
    projectHasDirectory(projectRoot, 'src/__tests__')
  ) {
    profiles.push('test-validation');
  }
  if (
    projectHasFile(projectRoot, 'package.json') ||
    projectHasFile(projectRoot, 'pyproject.toml')
  ) {
    profiles.push('tooling-config');
  }
  if (projectHasFile(projectRoot, 'README.md') || projectHasDirectory(projectRoot, 'docs')) {
    profiles.push('docs-maintainer');
  }
  return limitedUniqueStrings(profiles, 8);
}

function normalizeScoredMemories(raw: unknown): ScoredMemorySignal[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): ScoredMemorySignal | null => {
      const value =
        typeof item === 'object' && item !== null ? (item as Partial<ScoredMemorySignal>) : {};
      const text =
        typeof value.text === 'string' && value.text.trim() ? normalizeWhitespace(value.text) : '';
      if (!text) return null;
      const source =
        value.source === 'review' ||
        value.source === 'validation' ||
        value.source === 'pattern' ||
        value.source === 'guidance' ||
        value.source === 'success'
          ? value.source
          : 'pattern';
      const score =
        typeof value.score === 'number' && Number.isFinite(value.score)
          ? Math.min(1, Math.max(0, value.score))
          : 0.45;
      const hits =
        typeof value.hits === 'number' && Number.isFinite(value.hits)
          ? Math.max(1, Math.round(value.hits))
          : 1;
      const lastSeenAt =
        typeof value.lastSeenAt === 'number' && Number.isFinite(value.lastSeenAt)
          ? value.lastSeenAt
          : Date.now();
      return { text, score, hits, source, lastSeenAt };
    })
    .filter((item): item is ScoredMemorySignal => item !== null)
    .sort((a, b) => b.score - a.score || b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_SCORED_MEMORY_ITEMS);
}

function normalizeFailureMemoryClusters(raw: unknown): FailureMemoryCluster[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  return raw
    .map((item): FailureMemoryCluster | null => {
      const value =
        typeof item === 'object' && item !== null ? (item as Partial<FailureMemoryCluster>) : {};
      const signature =
        typeof value.signature === 'string' && value.signature.trim()
          ? normalizeWhitespace(value.signature)
          : '';
      if (!signature) return null;
      const lastSeenAt =
        typeof value.lastSeenAt === 'number' && Number.isFinite(value.lastSeenAt)
          ? value.lastSeenAt
          : now;
      const ageDays = Math.max(0, (now - lastSeenAt) / (24 * 60 * 60 * 1000));
      const hits =
        typeof value.hits === 'number' && Number.isFinite(value.hits)
          ? Math.max(1, Math.round(value.hits))
          : 1;
      const category =
        value.category === 'typecheck' ||
        value.category === 'unit-test' ||
        value.category === 'lint' ||
        value.category === 'build' ||
        value.category === 'runtime' ||
        value.category === 'environment' ||
        value.category === 'safety' ||
        value.category === 'review' ||
        value.category === 'policy' ||
        value.category === 'unknown'
          ? value.category
          : 'unknown';
      return {
        signature,
        category,
        hits,
        lastSeenAt,
        commands: limitedUniqueStrings(stringArrayFrom(value.commands), 6),
        remediation: limitedUniqueStrings(stringArrayFrom(value.remediation), 8),
        examples: limitedUniqueStrings(stringArrayFrom(value.examples), 6),
        staleScore:
          typeof value.staleScore === 'number' && Number.isFinite(value.staleScore)
            ? Math.max(0, Math.min(1, value.staleScore))
            : Math.max(0.1, Math.min(1, 1 / (1 + ageDays / 14))),
      };
    })
    .filter((item): item is FailureMemoryCluster => item !== null)
    .sort((a, b) => b.hits * b.staleScore - a.hits * a.staleScore || b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_SCORED_MEMORY_ITEMS);
}

function normalizeProjectProfile(raw: unknown, projectRoot: string): KiraProjectProfile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Partial<KiraProjectProfile>;
  const now = Date.now();
  return {
    schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
    projectName:
      typeof value.projectName === 'string' && value.projectName.trim()
        ? value.projectName.trim()
        : basename(projectRoot),
    projectRoot:
      typeof value.projectRoot === 'string' && value.projectRoot.trim()
        ? value.projectRoot.trim()
        : projectRoot,
    generatedAt:
      typeof value.generatedAt === 'number' && Number.isFinite(value.generatedAt)
        ? value.generatedAt
        : now,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : now,
    repoMap: {
      topLevelDirectories: limitedUniqueStrings(
        stringArrayFrom(value.repoMap?.topLevelDirectories),
      ),
      sourceRoots: limitedUniqueStrings(stringArrayFrom(value.repoMap?.sourceRoots)),
      testRoots: limitedUniqueStrings(stringArrayFrom(value.repoMap?.testRoots)),
      docs: limitedUniqueStrings(stringArrayFrom(value.repoMap?.docs)),
      configFiles: limitedUniqueStrings(stringArrayFrom(value.repoMap?.configFiles)),
      entrypoints: limitedUniqueStrings(stringArrayFrom(value.repoMap?.entrypoints)),
    },
    conventions: {
      packageManager:
        typeof value.conventions?.packageManager === 'string'
          ? value.conventions.packageManager
          : null,
      scripts: limitedUniqueStrings(stringArrayFrom(value.conventions?.scripts)),
      styleSignals: limitedUniqueStrings(stringArrayFrom(value.conventions?.styleSignals)),
      architectureNotes: limitedUniqueStrings(
        stringArrayFrom(value.conventions?.architectureNotes),
      ),
    },
    validation: {
      candidateCommands: limitedUniqueStrings(stringArrayFrom(value.validation?.candidateCommands)),
      testFiles: limitedUniqueStrings(stringArrayFrom(value.validation?.testFiles)),
      notes: limitedUniqueStrings(stringArrayFrom(value.validation?.notes)),
    },
    risk: {
      highRiskFiles: limitedUniqueStrings(stringArrayFrom(value.risk?.highRiskFiles)),
      generatedPaths: limitedUniqueStrings(stringArrayFrom(value.risk?.generatedPaths)),
      concurrencyNotes: limitedUniqueStrings(stringArrayFrom(value.risk?.concurrencyNotes)),
    },
    workers: {
      recommendedProfiles: limitedUniqueStrings(
        stringArrayFrom(value.workers?.recommendedProfiles),
      ),
      specializationHints: limitedUniqueStrings(
        stringArrayFrom(value.workers?.specializationHints),
      ),
    },
    decomposition: {
      hints: limitedUniqueStrings(stringArrayFrom(value.decomposition?.hints)),
      lastRecommendations: limitedUniqueStrings(
        stringArrayFrom(value.decomposition?.lastRecommendations),
      ),
    },
    orchestration: {
      subagents: normalizeSubagentRegistry(value.orchestration?.subagents),
      workflowDag: normalizeWorkflowDag(value.orchestration?.workflowDag),
      pluginConnectors: normalizePluginConnectors(value.orchestration?.pluginConnectors),
      environment: normalizeEnvironmentContract(value.orchestration?.environment),
      executionPolicy: normalizeExecutionPolicy(value.orchestration?.executionPolicy),
      quality: normalizeQualitySnapshot(value.orchestration?.quality),
    },
    learning: {
      recentReviewFailures: limitedUniqueStrings(
        stringArrayFrom(value.learning?.recentReviewFailures),
        MAX_PROJECT_LEARNING_ITEMS,
      ),
      recentValidationFailures: limitedUniqueStrings(
        stringArrayFrom(value.learning?.recentValidationFailures),
        MAX_PROJECT_LEARNING_ITEMS,
      ),
      repeatedPatterns: limitedUniqueStrings(
        stringArrayFrom(value.learning?.repeatedPatterns),
        MAX_PROJECT_LEARNING_ITEMS,
      ),
      workerGuidanceRules: limitedUniqueStrings(
        stringArrayFrom(value.learning?.workerGuidanceRules),
        MAX_PROJECT_LEARNING_ITEMS,
      ),
      successfulPatterns: limitedUniqueStrings(
        stringArrayFrom(value.learning?.successfulPatterns),
        MAX_PROJECT_LEARNING_ITEMS,
      ),
      scoredMemories: normalizeScoredMemories(value.learning?.scoredMemories),
      failureClusters: normalizeFailureMemoryClusters(value.learning?.failureClusters),
      lastUpdatedAt:
        typeof value.learning?.lastUpdatedAt === 'number'
          ? value.learning.lastUpdatedAt
          : undefined,
    },
  };
}

export function loadProjectIntelligenceProfile(projectRoot: string): KiraProjectProfile | null {
  const raw = readJsonFile<KiraProjectProfile>(getProjectProfilePath(projectRoot));
  return normalizeProjectProfile(raw, projectRoot);
}

export function refreshProjectIntelligenceProfile(
  projectRoot: string,
  projectName = basename(projectRoot),
): KiraProjectProfile {
  const previous = loadProjectIntelligenceProfile(projectRoot);
  const packageManager = detectNodePackageManager(projectRoot);
  const scripts = loadPackageScripts(projectRoot);
  const sourceRoots = collectDirectoryMatches(projectRoot, [
    /(^|\/)(src|app|apps|packages|lib|server|client|components)(\/|$)/i,
  ]);
  const testRoots = collectDirectoryMatches(projectRoot, [
    /(^|\/)(__tests__|tests?|spec|e2e)(\/|$)/i,
  ]);
  const docs = collectProjectPaths(
    projectRoot,
    (relativePath, dirent) =>
      dirent.isFile() &&
      /(^|\/)(readme|contributing|architecture|guide|docs?)[^/]*\.(md|mdx|rst|txt)$/i.test(
        relativePath,
      ),
    20,
  );
  const candidateCommands = buildDefaultValidationCommands(projectRoot, []);
  const testFiles = collectProjectPaths(
    projectRoot,
    (relativePath, dirent) =>
      dirent.isFile() &&
      (relativePath.includes('/__tests__/') ||
        relativePath.includes('/tests/') ||
        /\.(test|spec)\.[a-z0-9]+$/i.test(relativePath) ||
        /^tests?\//i.test(relativePath)),
    20,
  );
  const now = Date.now();
  const profile: KiraProjectProfile = {
    schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
    projectName,
    projectRoot,
    generatedAt: previous?.generatedAt ?? now,
    updatedAt: now,
    repoMap: {
      topLevelDirectories: collectTopLevelDirectories(projectRoot),
      sourceRoots,
      testRoots,
      docs,
      configFiles: detectWorkspaceFiles(projectRoot),
      entrypoints: collectProjectEntrypoints(projectRoot),
    },
    conventions: {
      packageManager,
      scripts: formatPackageScripts(scripts),
      styleSignals: detectStyleSignals(projectRoot),
      architectureNotes: limitedUniqueStrings([
        ...(projectHasDirectory(projectRoot, 'apps')
          ? [
              'App/workspace boundaries exist; avoid cross-app edits unless the task explicitly requires them.',
            ]
          : []),
        ...(projectHasDirectory(projectRoot, 'packages')
          ? [
              'Package boundaries exist; check exported APIs and downstream imports before changing shared code.',
            ]
          : []),
        ...(projectHasFile(projectRoot, 'tsconfig.json')
          ? ['TypeScript type contracts are part of the architecture surface.']
          : []),
      ]),
    },
    validation: {
      candidateCommands: candidateCommands.filter((command) => isSafeCommandAllowed(command)),
      testFiles,
      notes: limitedUniqueStrings([
        ...(candidateCommands.length === 0
          ? ['No default validation command was detected; workers must explain validation choice.']
          : []),
        ...(testFiles.length === 0
          ? [
              'No obvious test files were found; prefer targeted build/type/lint checks where available.',
            ]
          : []),
      ]),
    },
    risk: {
      highRiskFiles: collectHighRiskProjectFiles(projectRoot),
      generatedPaths: detectGeneratedPaths(projectRoot),
      concurrencyNotes: limitedUniqueStrings([
        'Preserve unrelated user changes and generated outputs.',
        'Treat lockfiles, migrations, auth, and security-sensitive files as high-risk edit surfaces.',
      ]),
    },
    workers: {
      recommendedProfiles: inferProjectWorkerProfiles(projectRoot),
      specializationHints: limitedUniqueStrings([
        'frontend-ui: UI, layout, copy, accessibility, visual regressions.',
        'backend-api: server routes, data flow, persistence, API contracts.',
        'test-validation: tests, type checks, validation gaps, regressions.',
        'tooling-config: build scripts, package/config changes, CI-sensitive files.',
        'docs-maintainer: docs, examples, developer guides.',
      ]),
    },
    decomposition: {
      hints: limitedUniqueStrings([
        'Split work that spans unrelated UI, backend, data migration, and validation surfaces.',
        'Split work when a task touches many high-risk files or requires independent rollout steps.',
      ]),
      lastRecommendations: previous?.decomposition.lastRecommendations ?? [],
    },
    orchestration: {
      subagents: normalizeSubagentRegistry(previous?.orchestration?.subagents, previous),
      workflowDag: normalizeWorkflowDag(previous?.orchestration?.workflowDag),
      pluginConnectors: normalizePluginConnectors(previous?.orchestration?.pluginConnectors),
      environment: normalizeEnvironmentContract(previous?.orchestration?.environment),
      executionPolicy: normalizeExecutionPolicy(previous?.orchestration?.executionPolicy),
      quality: normalizeQualitySnapshot(previous?.orchestration?.quality),
    },
    learning: previous?.learning ?? {
      recentReviewFailures: [],
      recentValidationFailures: [],
      repeatedPatterns: [],
      workerGuidanceRules: [],
      successfulPatterns: [],
      scoredMemories: [],
      failureClusters: [],
    },
  };

  writeJsonFile(getProjectProfilePath(projectRoot), profile);
  return profile;
}

function ensureProjectIntelligenceProfile(
  projectRoot: string,
  projectName = basename(projectRoot),
): KiraProjectProfile | null {
  try {
    return refreshProjectIntelligenceProfile(projectRoot, projectName);
  } catch {
    return loadProjectIntelligenceProfile(projectRoot);
  }
}

function summarizeProjectProfile(profile: KiraProjectProfile | null | undefined): string[] {
  if (!profile) return [];
  return limitedUniqueStrings(
    [
      `Source roots: ${formatInlineList(profile.repoMap.sourceRoots)}`,
      `Test roots: ${formatInlineList(profile.repoMap.testRoots)}`,
      `Validation: ${formatInlineList(profile.validation.candidateCommands)}`,
      `Style signals: ${formatInlineList(profile.conventions.styleSignals)}`,
      `Risk surfaces: ${formatInlineList(profile.risk.highRiskFiles)}`,
      `Worker profiles: ${formatInlineList(profile.workers.recommendedProfiles)}`,
      `Subagents: ${formatInlineList(profile.orchestration?.subagents.map((agent) => agent.id) ?? [])}`,
      `Workflow: ${formatInlineList(profile.orchestration?.workflowDag.criticalPath ?? [])}`,
      `Guidance rules: ${formatInlineList(profile.learning.workerGuidanceRules)}`,
      `Successful patterns: ${formatInlineList(profile.learning.successfulPatterns)}`,
      `Failure clusters: ${formatInlineList(
        profile.learning.failureClusters
          .slice(0, 4)
          .map((item) => `${item.category}/${item.hits} ${item.signature}`),
      )}`,
      `Weighted memories: ${formatInlineList(
        profile.learning.scoredMemories.slice(0, 4).map((item) => item.text),
      )}`,
    ].filter((item) => !item.endsWith(': none')),
    8,
  );
}

function deriveWorkerGuidanceRules(items: string[]): string[] {
  const source = items.join('\n').toLowerCase();
  const rules: string[] = [];
  if (/\bself-check|selfcheck|diffhunkreview|hunk\b/.test(source)) {
    rules.push('Before final JSON, inspect the final diff and include per-file diffHunkReview.');
  }
  if (/\bvalidation|rerun|missing check|test|typecheck|lint\b/.test(source)) {
    rules.push(
      'Select and run targeted validation for the changed files; explain any skipped check.',
    );
  }
  if (/\bprotected|dirty|out-of-plan|unrelated\b/.test(source)) {
    rules.push(
      'Keep edits inside intendedFiles and never modify protected or pre-existing dirty files.',
    );
  }
  if (/\bwide|broad|scope|too many|split|decomposition|small-patch\b/.test(source)) {
    rules.push('Keep patches small; split broad work before editing unrelated surfaces.');
  }
  if (/\binstruction|coding style|architecture|mandatory\b/.test(source)) {
    rules.push(
      'Confirm mandatory project instructions explicitly in the change design and self-check.',
    );
  }
  if (/\bdiff|summary conflicts|reviewable|files checked\b/.test(source)) {
    rules.push('Make the final summary match the actual diff and call out every risky hunk.');
  }
  if (/\block|eperm|automation-locks\b/.test(source)) {
    rules.push(
      'Treat transient Kira lock errors as recoverable automation noise, not task failure.',
    );
  }
  return limitedUniqueStrings(rules, MAX_PROJECT_LEARNING_ITEMS);
}

function memorySourceWeight(source: ScoredMemorySignal['source']): number {
  switch (source) {
    case 'review':
      return 0.76;
    case 'validation':
      return 0.74;
    case 'guidance':
      return 0.68;
    case 'success':
      return 0.58;
    default:
      return 0.62;
  }
}

function buildScoredMemoryUpdates(
  updates: {
    reviewFailures?: string[];
    validationFailures?: string[];
    repeatedPatterns?: string[];
    workerGuidanceRules?: string[];
    successfulPatterns?: string[];
  },
  now: number,
): ScoredMemorySignal[] {
  const pairs: Array<[ScoredMemorySignal['source'], string]> = [
    ...(updates.reviewFailures ?? []).map((item): [ScoredMemorySignal['source'], string] => [
      'review',
      item,
    ]),
    ...(updates.validationFailures ?? []).map((item): [ScoredMemorySignal['source'], string] => [
      'validation',
      item,
    ]),
    ...(updates.repeatedPatterns ?? []).map((item): [ScoredMemorySignal['source'], string] => [
      'pattern',
      item,
    ]),
    ...(updates.workerGuidanceRules ?? []).map((item): [ScoredMemorySignal['source'], string] => [
      'guidance',
      item,
    ]),
    ...(updates.successfulPatterns ?? []).map((item): [ScoredMemorySignal['source'], string] => [
      'success',
      item,
    ]),
  ];
  return pairs
    .map(([source, rawText]) => {
      const text = normalizeWhitespace(rawText);
      if (!text) return null;
      return {
        text,
        source,
        score: memorySourceWeight(source),
        hits: 1,
        lastSeenAt: now,
      };
    })
    .filter((memory): memory is ScoredMemorySignal => memory !== null);
}

function mergeScoredMemories(
  existing: ScoredMemorySignal[],
  incoming: ScoredMemorySignal[],
  now: number,
): ScoredMemorySignal[] {
  const byText = new Map<string, ScoredMemorySignal>();
  for (const memory of [...existing, ...incoming]) {
    const key = memory.text.toLowerCase();
    const previous = byText.get(key);
    if (!previous) {
      byText.set(key, { ...memory });
      continue;
    }
    const hits = previous.hits + memory.hits;
    const recencyBoost = memory.lastSeenAt >= previous.lastSeenAt ? 0.06 : 0;
    byText.set(key, {
      text: previous.text,
      source: previous.score >= memory.score ? previous.source : memory.source,
      hits,
      score: Math.min(
        1,
        Math.max(previous.score, memory.score) + Math.min(0.18, hits * 0.02) + recencyBoost,
      ),
      lastSeenAt: Math.max(previous.lastSeenAt, memory.lastSeenAt),
    });
  }
  return [...byText.values()]
    .map((memory) => {
      const ageDays = Math.max(0, (now - memory.lastSeenAt) / 86_400_000);
      const decay = Math.max(0.78, 1 - ageDays * 0.01);
      return { ...memory, score: Math.min(1, Math.max(0.05, memory.score * decay)) };
    })
    .sort((a, b) => b.score - a.score || b.hits - a.hits || b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_SCORED_MEMORY_ITEMS);
}

function buildFailureClusterUpdates(
  updates: {
    reviewFailures?: string[];
    validationFailures?: string[];
    repeatedPatterns?: string[];
  },
  now: number,
): FailureMemoryCluster[] {
  const validation = (updates.validationFailures ?? []).map((text): FailureMemoryCluster => {
    const command = /^Kira rerun failed for\s+(.+)$/i.exec(text)?.[1] ?? '';
    const category = classifyFailure(command, text);
    const signature = buildIssueSignature([category, command, text], text).slice(0, 180);
    return {
      signature,
      category,
      hits: 1,
      lastSeenAt: now,
      commands: command ? [command] : [],
      remediation: [guidanceForFailure(category)],
      examples: [text],
      staleScore: 1,
    };
  });
  const review = [...(updates.reviewFailures ?? []), ...(updates.repeatedPatterns ?? [])].map(
    (text): FailureMemoryCluster => ({
      signature: buildIssueSignature([text], text).slice(0, 180),
      category: /\bpolicy|protected|unsafe|deny|allowlist\b/i.test(text) ? 'policy' : 'review',
      hits: 1,
      lastSeenAt: now,
      commands: [],
      remediation: deriveWorkerGuidanceRules([text]),
      examples: [text],
      staleScore: 1,
    }),
  );
  return [...validation, ...review].filter((item) => item.signature);
}

function mergeFailureClusters(
  existing: FailureMemoryCluster[],
  incoming: FailureMemoryCluster[],
  now: number,
): FailureMemoryCluster[] {
  const bySignature = new Map<string, FailureMemoryCluster>();
  for (const cluster of [...existing, ...incoming]) {
    const key = cluster.signature.toLowerCase();
    const previous = bySignature.get(key);
    if (!previous) {
      bySignature.set(key, { ...cluster });
      continue;
    }
    bySignature.set(key, {
      signature: previous.signature,
      category: previous.category,
      hits: previous.hits + cluster.hits,
      lastSeenAt: Math.max(previous.lastSeenAt, cluster.lastSeenAt),
      commands: limitedUniqueStrings([...cluster.commands, ...previous.commands], 6),
      remediation: limitedUniqueStrings([...cluster.remediation, ...previous.remediation], 8),
      examples: limitedUniqueStrings([...cluster.examples, ...previous.examples], 6),
      staleScore: 1,
    });
  }
  return normalizeFailureMemoryClusters(
    [...bySignature.values()].map((cluster) => {
      const ageDays = Math.max(0, (now - cluster.lastSeenAt) / 86_400_000);
      return {
        ...cluster,
        staleScore: Math.max(0.1, Math.min(1, 1 / (1 + ageDays / 14))),
      };
    }),
  );
}

function updateProjectProfileLearning(
  projectRoot: string,
  updates: {
    reviewFailures?: string[];
    validationFailures?: string[];
    repeatedPatterns?: string[];
    decompositionRecommendations?: string[];
    workerGuidanceRules?: string[];
    successfulPatterns?: string[];
  },
): void {
  try {
    const profile =
      loadProjectIntelligenceProfile(projectRoot) ?? refreshProjectIntelligenceProfile(projectRoot);
    const now = Date.now();
    const derivedGuidance = deriveWorkerGuidanceRules([
      ...(updates.reviewFailures ?? []),
      ...(updates.validationFailures ?? []),
      ...(updates.repeatedPatterns ?? []),
    ]);
    profile.learning = {
      recentReviewFailures: limitedUniqueStrings(
        [...(updates.reviewFailures ?? []), ...profile.learning.recentReviewFailures],
        MAX_PROJECT_LEARNING_ITEMS,
      ),
      recentValidationFailures: limitedUniqueStrings(
        [...(updates.validationFailures ?? []), ...profile.learning.recentValidationFailures],
        MAX_PROJECT_LEARNING_ITEMS,
      ),
      repeatedPatterns: limitedUniqueStrings(
        [...(updates.repeatedPatterns ?? []), ...profile.learning.repeatedPatterns],
        MAX_PROJECT_LEARNING_ITEMS,
      ),
      workerGuidanceRules: limitedUniqueStrings(
        [
          ...(updates.workerGuidanceRules ?? []),
          ...derivedGuidance,
          ...profile.learning.workerGuidanceRules,
        ],
        MAX_PROJECT_LEARNING_ITEMS,
      ),
      successfulPatterns: limitedUniqueStrings(
        [...(updates.successfulPatterns ?? []), ...profile.learning.successfulPatterns],
        MAX_PROJECT_LEARNING_ITEMS,
      ),
      scoredMemories: mergeScoredMemories(
        profile.learning.scoredMemories ?? [],
        buildScoredMemoryUpdates(
          {
            ...updates,
            workerGuidanceRules: [...(updates.workerGuidanceRules ?? []), ...derivedGuidance],
          },
          now,
        ),
        now,
      ),
      failureClusters: mergeFailureClusters(
        profile.learning.failureClusters ?? [],
        buildFailureClusterUpdates(updates, now),
        now,
      ),
      lastUpdatedAt: now,
    };
    profile.decomposition.lastRecommendations = limitedUniqueStrings(
      [
        ...(updates.decompositionRecommendations ?? []),
        ...profile.decomposition.lastRecommendations,
      ],
      MAX_PROJECT_LEARNING_ITEMS,
    );
    profile.updatedAt = now;
    writeJsonFile(getProjectProfilePath(projectRoot), profile);
  } catch {
    // Learning is helpful context, not a reason to fail an active Kira run.
  }
}

function getProjectRecentFeedback(profile: KiraProjectProfile | null | undefined): string[] {
  if (!profile) return [];
  return limitedUniqueStrings(
    [
      ...profile.learning.recentReviewFailures.map((item) => `Recent review issue: ${item}`),
      ...profile.learning.recentValidationFailures.map(
        (item) => `Recent validation issue: ${item}`,
      ),
      ...profile.learning.repeatedPatterns.map((item) => `Repeated pattern: ${item}`),
      ...profile.learning.workerGuidanceRules.map((item) => `Guidance rule: ${item}`),
      ...profile.learning.successfulPatterns.map((item) => `Successful pattern: ${item}`),
      ...profile.learning.failureClusters
        .slice(0, 6)
        .map(
          (item) =>
            `Failure cluster ${item.category}/${item.hits}: ${item.signature}. Remediation: ${formatInlineList(item.remediation)}`,
        ),
      ...profile.learning.scoredMemories
        .slice(0, 6)
        .map((item) => `Weighted memory ${item.source}/${item.score.toFixed(2)}: ${item.text}`),
    ],
    MAX_PROJECT_LEARNING_ITEMS,
  );
}

export function recommendWorkDecomposition(
  work: WorkTask,
  contextScan: Pick<
    ProjectContextScan,
    'likelyFiles' | 'testFiles' | 'relatedDocs' | 'candidateChecks'
  >,
  profile?: KiraProjectProfile | null,
): WorkDecompositionRecommendation {
  const source = `${work.title}\n${work.description}`;
  const bullets = (source.match(/^\s*[-*]\s+/gm) ?? []).length;
  const headings = (source.match(/^#{1,3}\s+/gm) ?? []).length;
  const explicitMultiSurface = /\b(frontend|ui|backend|api|database|migration|auth|test|docs?)\b/gi;
  const surfaceSignals = uniqueStrings(
    [...source.matchAll(explicitMultiSurface)].map((match) => match[0].toLowerCase()),
  );
  const signals: string[] = [];
  if (source.length > 2600) signals.push('Long task brief');
  if (bullets >= 8) signals.push('Many checklist/bullet items');
  if (headings >= 4) signals.push('Many brief sections');
  if (contextScan.likelyFiles.length >= 10) signals.push('Many likely implementation files');
  if (contextScan.testFiles.length >= 6) signals.push('Many related test files');
  if (surfaceSignals.length >= 3) {
    signals.push(`Multiple implementation surfaces: ${surfaceSignals.slice(0, 5).join(', ')}`);
  }
  if ((profile?.risk.highRiskFiles.length ?? 0) >= 8 && contextScan.likelyFiles.length >= 5) {
    signals.push('High-risk project surface intersects a broad file set');
  }

  const shouldSplit =
    signals.length >= 2 || source.length > 4200 || contextScan.likelyFiles.length >= 14;
  const suggestedWorks = shouldSplit
    ? limitedUniqueStrings(
        [
          surfaceSignals.includes('frontend') || surfaceSignals.includes('ui')
            ? 'Implement the UI-facing changes and visual/accessibility checks'
            : '',
          surfaceSignals.includes('backend') || surfaceSignals.includes('api')
            ? 'Implement the backend/API contract changes'
            : '',
          surfaceSignals.includes('database') || surfaceSignals.includes('migration')
            ? 'Handle data model or migration work with rollback notes'
            : '',
          surfaceSignals.includes('test') || contextScan.candidateChecks.length > 0
            ? 'Add or update targeted validation coverage'
            : '',
          surfaceSignals.includes('docs') ? 'Update documentation and examples' : '',
          'Integrate the final path and run the project-level validation plan',
        ],
        6,
      ).filter(Boolean)
    : [];

  return {
    shouldSplit,
    confidence: shouldSplit ? Math.min(0.95, 0.55 + signals.length * 0.1) : 0.35,
    reason: shouldSplit
      ? `This work has ${signals.length} split signals and is likely safer as smaller tasks.`
      : 'The work appears small enough for one worker attempt.',
    suggestedWorks,
    signals: limitedUniqueStrings(signals, 8),
  };
}

function inferWorkerProfile(
  work: WorkTask,
  contextScan: Pick<ProjectContextScan, 'likelyFiles' | 'testFiles' | 'relatedDocs'>,
  profile?: KiraProjectProfile | null,
): string {
  const source =
    `${work.title}\n${work.description}\n${contextScan.likelyFiles.join('\n')}`.toLowerCase();
  const projectProfiles = profile?.workers.recommendedProfiles ?? [];
  if (/\b(css|scss|style|layout|component|react|vue|svelte|ui|ux|accessibility)\b/.test(source)) {
    return projectProfiles.includes('frontend-ui') ? 'frontend-ui' : 'frontend-focused generalist';
  }
  if (
    /\b(api|route|server|database|db|auth|permission|backend|controller|service)\b/.test(source)
  ) {
    return projectProfiles.includes('backend-api') ? 'backend-api' : 'backend-focused generalist';
  }
  if (/\b(test|spec|validation|coverage|lint|typecheck|regression)\b/.test(source)) {
    return projectProfiles.includes('test-validation')
      ? 'test-validation'
      : 'validation-focused generalist';
  }
  if (/\b(package|config|vite|webpack|eslint|prettier|ci|build|script)\b/.test(source)) {
    return projectProfiles.includes('tooling-config')
      ? 'tooling-config'
      : 'tooling-focused generalist';
  }
  if (/\b(readme|docs?|guide|example)\b/.test(source)) {
    return projectProfiles.includes('docs-maintainer')
      ? 'docs-maintainer'
      : 'docs-focused generalist';
  }
  return projectProfiles[0] ?? 'generalist';
}

function selectLaneWorkerProfile(
  lane: KiraWorkerLane,
  work: WorkTask,
  contextScan: ProjectContextScan,
  workerCount: number,
  attemptNo: number,
): string {
  if (lane.subagent) return lane.subagent.profile;
  const label = lane.label.toLowerCase();
  if (label.includes('test') || label.includes('review') || label.includes('validation')) {
    return 'test-validation';
  }
  if (label.includes('front') || label.includes('ui')) return 'frontend-ui';
  if (label.includes('back') || label.includes('api')) return 'backend-api';
  if (label.includes('docs')) return 'docs-maintainer';
  if (workerCount <= 1)
    return (
      contextScan.workerProfile ?? inferWorkerProfile(work, contextScan, contextScan.projectProfile)
    );

  const laneIndex = Math.max(0, attemptNo - 1) % workerCount;
  const baseProfile =
    contextScan.workerProfile ?? inferWorkerProfile(work, contextScan, contextScan.projectProfile);
  if (laneIndex === 0) return baseProfile;
  if (laneIndex === 1) return 'test-validation challenger';
  return 'minimal-risk integration reviewer';
}

function formatGitStatusEntries(entries: GitStatusEntry[] | null): string[] {
  if (!entries) return ['Git status unavailable'];
  return entries.map((entry) => `${entry.status.trim() || 'modified'} ${entry.path}`).slice(0, 40);
}

export async function buildProjectContextScan(
  projectRoot: string,
  work: WorkTask,
  requiredInstructions = '',
  runMode: KiraRunMode = 'standard',
  workerCount = 1,
  projectSettings?: Pick<
    ResolvedKiraProjectSettings,
    'executionPolicy' | 'environment' | 'subagents' | 'workflow' | 'plugins'
  >,
): Promise<ProjectContextScan> {
  const projectProfile = ensureProjectIntelligenceProfile(projectRoot, work.projectName);
  const executionPolicy = normalizeExecutionPolicy(projectSettings?.executionPolicy);
  const environmentContract = normalizeEnvironmentContract(projectSettings?.environment);
  const subagentRegistry =
    projectSettings?.subagents && projectSettings.subagents.length > 0
      ? projectSettings.subagents
      : normalizeSubagentRegistry(projectProfile?.orchestration?.subagents, projectProfile);
  const workflowDag =
    projectSettings?.workflow ??
    normalizeWorkflowDag(projectProfile?.orchestration?.workflowDag, runMode);
  const pluginConnectors =
    projectSettings?.plugins ??
    normalizePluginConnectors(projectProfile?.orchestration?.pluginConnectors);
  const qualitySnapshot = normalizeQualitySnapshot(projectProfile?.orchestration?.quality);
  const packageManager = detectNodePackageManager(projectRoot);
  const scripts = loadPackageScripts(projectRoot);
  const existingChanges = formatGitStatusEntries(await getGitWorktreeEntries(projectRoot));
  const searchTerms = extractWorkSearchTerms(work);
  const likelyFiles = collectLikelyFilesForWork(projectRoot, work);
  const relatedDocs = collectRelatedDocs(projectRoot, work);
  const testFiles = collectRelatedTests(projectRoot, work);
  const likelyFilePaths = extractSearchResultPaths(likelyFiles);
  const taskType = inferTaskType(work, likelyFilePaths);
  const taskPlaybook = buildTaskPlaybook(taskType);
  const dependencyMap = collectDependencyInsights(projectRoot, likelyFilePaths);
  const semanticGraph = collectSemanticCodeGraph(projectRoot, likelyFilePaths, projectProfile);
  const testImpact = buildTestImpactAnalysis(projectRoot, likelyFilePaths, packageManager);
  const requirementTrace = buildRequirementTrace(work, requiredInstructions);
  const runtimeValidation = buildRuntimeValidationSignal(taskType, likelyFilePaths);
  const escalationSignals = detectEscalationSignals(work, taskType);
  const riskPolicy = assessRiskReviewPolicy({
    projectRoot,
    work,
    taskType,
    files: likelyFilePaths,
    runtimeValidation,
    runMode,
  });
  const orchestrationPlan = buildOrchestrationPlan({
    work,
    taskType,
    runMode,
    workerCount,
    riskPolicy,
    runtimeValidation,
    subagentRegistry,
    workflowDag,
    environmentContract,
    pluginConnectors,
  });
  const reviewAdversarialPlan = buildReviewAdversarialPlan({
    taskType,
    files: likelyFilePaths,
    riskPolicy,
    runtimeValidation,
    semanticGraph,
  });
  const reviewerCalibration = buildReviewerCalibration(
    projectProfile,
    riskPolicy,
    reviewAdversarialPlan,
  );
  const candidateChecks = uniqueStrings([
    ...environmentContract.validationCommands,
    ...buildDefaultValidationCommands(projectRoot, likelyFilePaths),
    ...testImpact.flatMap((item) => item.commands),
    ...(['test', 'lint', 'typecheck', 'build'] as const)
      .filter((scriptName) => scripts[scriptName])
      .map((scriptName) =>
        packageManager === 'pnpm' ? `pnpm run ${scriptName}` : `npm run ${scriptName}`,
      ),
  ])
    .filter((command) => isSafeCommandAllowed(command))
    .slice(0, MAX_EFFECTIVE_VALIDATION_COMMANDS);

  const notes: string[] = [];
  if (existingChanges.length > 0 && existingChanges[0] !== 'Git status unavailable') {
    notes.push('Existing git changes may include user work; preserve unrelated changes.');
  }
  if (candidateChecks.length === 0) {
    notes.push(
      'No obvious validation command was detected; planner must explain validation choice.',
    );
  }
  if (likelyFiles.length === 0) {
    notes.push(
      'No likely implementation files were found from the brief; planner must search before planning edits.',
    );
  }
  if (testFiles.length === 0) {
    notes.push(
      'No related test files were detected from the brief; planner should identify the nearest validation path.',
    );
  }

  const baseScan = {
    projectRoot,
    packageManager,
    workspaceFiles: detectWorkspaceFiles(projectRoot),
    packageScripts: formatPackageScripts(scripts),
    existingChanges,
    searchTerms,
    likelyFiles,
    relatedDocs,
    testFiles,
    candidateChecks,
    notes,
    projectProfile,
    profileSummary: summarizeProjectProfile(projectProfile),
    recentFeedback: getProjectRecentFeedback(projectProfile),
    taskPlaybook,
    dependencyMap,
    requirementTrace,
    riskPolicy,
    reviewAdversarialPlan,
    runtimeValidation,
    escalationSignals,
    semanticGraph,
    testImpact,
    reviewerCalibration,
    orchestrationPlan,
    subagentRegistry,
    workflowDag,
    executionPolicy,
    environmentContract,
    pluginConnectors,
    qualitySnapshot,
  };
  const decomposition = recommendWorkDecomposition(work, baseScan, projectProfile);
  const workerProfile = inferWorkerProfile(work, baseScan, projectProfile);
  const clarificationGate = buildClarificationQualityGate(work, {
    ...baseScan,
    decomposition,
  });

  return {
    ...baseScan,
    decomposition,
    workerProfile,
    clarificationGate,
  };
}

export function buildDefaultValidationCommands(
  projectRoot: string,
  filesChanged: string[],
): string[] {
  const changedFiles = normalizePathList(filesChanged, 200);
  const changedExtensions = new Set(
    changedFiles
      .map((file) => file.slice(file.lastIndexOf('.')).toLowerCase())
      .filter((ext) => ext.startsWith('.')),
  );
  const commands: string[] = [];

  if (changedFiles.length > 0 && fs.existsSync(join(projectRoot, '.git'))) {
    commands.push(
      `git diff --check -- ${changedFiles.slice(0, 12).map(formatShellPath).join(' ')}`,
    );
  }

  const changedHtmlFile = changedFiles.find((file) => /\.html?$/i.test(file));
  if (changedHtmlFile) {
    try {
      const absolutePath = ensureInsideRoot(projectRoot, changedHtmlFile);
      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
        const content = fs.readFileSync(absolutePath, 'utf-8');
        if (/data-theme/i.test(content)) {
          commands.push(`rg -n "data-theme" ${formatShellPath(changedHtmlFile)}`);
        }
      }
    } catch {
      // If the file cannot be read, let the later validation plan continue with other checks.
    }
  }

  const packageManager = detectNodePackageManager(projectRoot);
  if (packageManager) {
    const scripts = loadPackageScripts(projectRoot);
    const changedTestFile = changedFiles.find((file) =>
      /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file.toLowerCase()),
    );
    if (changedTestFile) {
      commands.push(
        packageManager === 'pnpm'
          ? `pnpm exec vitest ${formatShellPath(changedTestFile)}`
          : `npm test -- ${formatShellPath(changedTestFile)}`,
      );
    }
    const relatedTestFiles = collectRelatedTestsForFiles(projectRoot, changedFiles).slice(0, 3);
    if (!changedTestFile && relatedTestFiles.length > 0) {
      commands.push(
        packageManager === 'pnpm'
          ? `pnpm exec vitest ${relatedTestFiles.map(formatShellPath).join(' ')}`
          : `npm test -- ${relatedTestFiles.map(formatShellPath).join(' ')}`,
      );
    }
    const hasNodeSignals =
      changedExtensions.has('.ts') ||
      changedExtensions.has('.tsx') ||
      changedExtensions.has('.js') ||
      changedExtensions.has('.jsx') ||
      changedExtensions.has('.mts') ||
      changedExtensions.has('.cts') ||
      changedExtensions.has('.mjs') ||
      changedExtensions.has('.cjs') ||
      changedFiles.length === 0;
    if (hasNodeSignals) {
      if (scripts.typecheck) {
        commands.push(packageManager === 'pnpm' ? 'pnpm run typecheck' : 'npm run typecheck');
      } else if (scripts.test) {
        commands.push(packageManager === 'pnpm' ? 'pnpm test' : 'npm test');
      } else if (scripts.lint) {
        commands.push(packageManager === 'pnpm' ? 'pnpm run lint' : 'npm run lint');
      }
    }
  }

  const hasPythonSignals =
    changedExtensions.has('.py') ||
    projectHasFile(projectRoot, 'pytest.ini') ||
    projectHasFile(projectRoot, 'pyproject.toml') ||
    projectHasDirectory(projectRoot, 'tests');
  if (
    hasPythonSignals &&
    (projectHasFile(projectRoot, 'pytest.ini') || projectHasDirectory(projectRoot, 'tests'))
  ) {
    commands.push('python -m pytest');
  }

  const hasGoSignals = changedExtensions.has('.go') || projectHasFile(projectRoot, 'go.mod');
  if (hasGoSignals) {
    commands.push('go test ./...');
  }

  const hasRustSignals = changedExtensions.has('.rs') || projectHasFile(projectRoot, 'Cargo.toml');
  if (hasRustSignals) {
    commands.push('cargo check');
  }

  const hasDotnetSignals =
    changedExtensions.has('.cs') || projectHasFileWithSuffix(projectRoot, ['.sln', '.csproj']);
  if (hasDotnetSignals) {
    commands.push('dotnet build');
  }

  return uniqueStrings(commands)
    .filter((command) => isSafeCommandAllowed(command))
    .slice(0, MAX_DEFAULT_VALIDATION_COMMANDS);
}

export function resolveValidationPlan(
  projectRoot: string,
  plannerCommands: string[],
  filesChanged: string[],
  environment?: KiraEnvironmentContract,
): ResolvedValidationPlan {
  const environmentContract = normalizeEnvironmentContract(environment);
  const normalizedPlannerCommands = uniqueStrings(
    plannerCommands.map((command) => normalizeWhitespace(command)),
  ).filter(Boolean);
  const contractCommands = environmentContract.validationCommands.filter(
    (command) => !normalizedPlannerCommands.includes(command),
  );
  const autoAddedCommands = uniqueStrings([
    ...contractCommands,
    ...buildDefaultValidationCommands(projectRoot, filesChanged),
  ]).filter((command) => !normalizedPlannerCommands.includes(command));
  const effectiveCommands = uniqueStrings([
    ...normalizedPlannerCommands,
    ...autoAddedCommands,
  ]).slice(0, MAX_EFFECTIVE_VALIDATION_COMMANDS);
  const notes: string[] = [];
  const normalizedFiles = normalizePathList(filesChanged, 200);
  const docOnly = isDocumentationOnlyChange(normalizedFiles);

  if (
    normalizedPlannerCommands.length + autoAddedCommands.length >
    MAX_EFFECTIVE_VALIDATION_COMMANDS
  ) {
    notes.push(
      `Kira limited the combined validation plan to ${MAX_EFFECTIVE_VALIDATION_COMMANDS} commands.`,
    );
  }
  if (docOnly && autoAddedCommands.length === 0) {
    notes.push('Only documentation files changed; no automatic code validation command was added.');
  }
  if (normalizedFiles.length > 0 && effectiveCommands.length === 0) {
    notes.push('No safe validation command could be inferred from the changed files.');
  }
  if (environmentContract.validationCommands.length > 0) {
    notes.push(
      `Project environment contract contributed ${environmentContract.validationCommands.length} validation command(s).`,
    );
  }
  if (environmentContract.runner !== 'local') {
    notes.push(`Validation will execute through the ${environmentContract.runner} runner.`);
  }

  return {
    plannerCommands: normalizedPlannerCommands,
    autoAddedCommands: autoAddedCommands.slice(
      0,
      Math.max(0, MAX_EFFECTIVE_VALIDATION_COMMANDS - normalizedPlannerCommands.length),
    ),
    effectiveCommands,
    notes,
  };
}

export function findOutOfPlanTouchedFiles(plannedFiles: string[], actualFiles: string[]): string[] {
  const planned = normalizePathList(plannedFiles, 200);
  if (planned.length === 0) return [];

  return normalizePathList(actualFiles, 200).filter(
    (actualFile) =>
      !planned.some(
        (plannedFile) =>
          plannedFile === actualFile ||
          (plannedFile.endsWith('/') && actualFile.startsWith(plannedFile)),
      ),
  );
}

export function findMissingValidationCommands(
  plannedCommands: string[],
  actualCommands: string[],
): string[] {
  const actual = new Set(actualCommands.map((command) => normalizeCommandForComparison(command)));
  return uniqueStrings(plannedCommands.map((command) => normalizeWhitespace(command))).filter(
    (command) => !actual.has(normalizeCommandForComparison(command)),
  );
}

function normalizeFindingKind(value: unknown, title: string, summary: string): 'feature' | 'bug' {
  if (value === 'bug' || value === 'feature') return value;
  const haystack = `${title} ${summary}`.toLowerCase();
  return /bug|fix|error|issue|broken|regression|버그|수정|오류/.test(haystack) ? 'bug' : 'feature';
}

function buildFallbackTaskDescription(finding: ProjectDiscoveryFinding): string {
  return [
    `# Brief`,
    '',
    finding.summary,
    '',
    `## Type`,
    '',
    `- ${finding.kind}`,
    '',
    `## Evidence`,
    '',
    ...finding.evidence.map((item) => `- ${item}`),
    '',
    `## Candidate Files`,
    '',
    ...(finding.files.length > 0
      ? finding.files.map((item) => `- ${item}`)
      : ['- Inspect the current project and choose the most relevant files.']),
    '',
    `## Acceptance Criteria`,
    '',
    `- Implement the change described above.`,
    `- Keep the behavior aligned with the current project style.`,
    `- Run the most relevant validation or checks when practical.`,
  ].join('\n');
}

export function parseProjectDiscoveryAnalysis(
  raw: string,
  projectName: string,
  projectRoot: string,
  previousAnalysis: ProjectDiscoveryAnalysis | null,
): ProjectDiscoveryAnalysis {
  const now = Date.now();

  try {
    const parsed = JSON.parse(extractJson(raw)) as Partial<ProjectDiscoveryAnalysis> & {
      findings?: Array<Partial<ProjectDiscoveryFinding>>;
    };
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.slice(0, MAX_DISCOVERY_FINDINGS).map((finding, index) => {
          const title = finding.title?.trim() || `Discovery item ${index + 1}`;
          const summary = finding.summary?.trim() || 'No summary provided.';
          const files = Array.isArray(finding.files)
            ? finding.files.map(String).filter(Boolean)
            : [];
          const evidence = Array.isArray(finding.evidence)
            ? finding.evidence.map(String).filter(Boolean)
            : files;
          const normalized: ProjectDiscoveryFinding = {
            id: finding.id?.trim() || `finding-${index + 1}`,
            kind: normalizeFindingKind(finding.kind, title, summary),
            title,
            summary,
            evidence,
            files,
            taskDescription: finding.taskDescription?.trim() || '',
          };
          return {
            ...normalized,
            taskDescription: normalized.taskDescription || buildFallbackTaskDescription(normalized),
          };
        })
      : [];

    return {
      id: parsed.id?.trim() || makeId('project-discovery'),
      projectName,
      projectRoot,
      summary: parsed.summary?.trim() || 'No discovery summary provided.',
      findings,
      basedOnPreviousAnalysis: Boolean(previousAnalysis),
      previousAnalysisId: previousAnalysis?.id,
      createdAt:
        typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt)
          ? parsed.createdAt
          : now,
      updatedAt: now,
    };
  } catch {
    return {
      id: makeId('project-discovery'),
      projectName,
      projectRoot,
      summary: raw.trim() || 'Project discovery parsing failed.',
      findings: [],
      basedOnPreviousAnalysis: Boolean(previousAnalysis),
      previousAnalysisId: previousAnalysis?.id,
      createdAt: now,
      updatedAt: now,
    };
  }
}

function hashWorkBrief(work: Pick<WorkTask, 'title' | 'description' | 'projectName'>): string {
  return createHash('sha256')
    .update(JSON.stringify([work.projectName, work.title.trim(), work.description.trim()]))
    .digest('hex')
    .slice(0, 20);
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

function normalizeClarificationSummary(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? normalizeWhitespace(value) : fallback;
}

function buildFallbackClarificationQuestion(
  question: string,
  index = 0,
): WorkClarificationQuestion {
  return {
    id: `q-${index + 1}`,
    question,
    options: [],
    allowCustomAnswer: true,
  };
}

function normalizeClarificationQuestion(
  raw: Partial<WorkClarificationQuestion> | null | undefined,
  index: number,
  usedIds: Set<string>,
): WorkClarificationQuestion | null {
  const question = typeof raw?.question === 'string' ? raw.question.trim() : '';
  if (!question) return null;
  const options = uniqueStrings(
    (Array.isArray(raw?.options) ? raw.options : [])
      .map((option) => normalizeWhitespace(String(option)))
      .filter(Boolean),
  ).slice(0, MAX_CLARIFICATION_OPTIONS);

  return {
    id: normalizeClarificationQuestionId(raw?.id, index, usedIds),
    question,
    options,
    allowCustomAnswer: options.length === 0 || raw?.allowCustomAnswer !== false,
  };
}

export function parseWorkClarificationAnalysis(raw: string): WorkClarificationAnalysis {
  try {
    const parsed = JSON.parse(extractJson(raw)) as Partial<WorkClarificationAnalysis> & {
      questions?: Array<Partial<WorkClarificationQuestion>>;
    };
    const usedIds = new Set<string>();
    const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
      .slice(0, MAX_CLARIFICATION_QUESTIONS)
      .map((question, index) => normalizeClarificationQuestion(question, index, usedIds))
      .filter((question): question is WorkClarificationQuestion => question !== null);
    const needsClarification = parsed.needsClarification === true;
    const summary = normalizeClarificationSummary(
      parsed.summary,
      needsClarification
        ? 'The brief needs clarification before worker assignment.'
        : 'The brief is ready for worker assignment.',
    );

    return {
      needsClarification,
      confidence:
        typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
      summary,
      questions:
        needsClarification && questions.length === 0
          ? [
              buildFallbackClarificationQuestion(
                'The main model said this work needs clarification but did not return usable questions. What detail should be added before a worker starts?',
              ),
            ]
          : questions,
    };
  } catch {
    return {
      needsClarification: true,
      confidence: 0,
      summary:
        'Clarification analysis could not be parsed, so Kira is blocking worker assignment instead of proceeding with an unchecked brief.',
      questions: [
        buildFallbackClarificationQuestion(
          'Kira could not read the main model clarification result. What should be clarified or changed in the brief before a worker starts?',
        ),
      ],
    };
  }
}

function validateWorkClarificationAnalysisFinal(content: string): string[] {
  const issues: string[] = [];
  let parsed: Partial<WorkClarificationAnalysis> & {
    questions?: Array<Partial<WorkClarificationQuestion>>;
  };

  try {
    parsed = JSON.parse(extractJson(content)) as Partial<WorkClarificationAnalysis> & {
      questions?: Array<Partial<WorkClarificationQuestion>>;
    };
  } catch {
    return [
      'Return a valid JSON object with needsClarification, confidence, summary, and questions.',
    ];
  }

  if (typeof parsed.needsClarification !== 'boolean') {
    issues.push('needsClarification must be a boolean.');
  }
  if (typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence)) {
    issues.push('confidence must be a finite number between 0 and 1.');
  }
  if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    issues.push('summary must be a non-empty string.');
  }
  if (!Array.isArray(parsed.questions)) {
    issues.push('questions must be an array.');
  }

  if (parsed.needsClarification === true) {
    const usableQuestions = (Array.isArray(parsed.questions) ? parsed.questions : []).filter(
      (question) => typeof question?.question === 'string' && question.question.trim(),
    );
    if (usableQuestions.length === 0) {
      issues.push('When needsClarification is true, include at least one usable question.');
    }
  }

  return issues;
}

function buildWorkClarificationPrompt(work: WorkTask, projectOverview: string): string {
  return [
    `Project: ${work.projectName}`,
    `Work title: ${work.title}`,
    `Work brief:\n${work.description || '(empty)'}`,
    `Project overview:\n${projectOverview}`,
    'Decide whether this work item is ready to hand to implementation workers.',
    'Ask clarification questions only when ambiguity would likely cause a worker to implement the wrong behavior, miss a key constraint, or choose between materially different product outcomes.',
    'Do not ask about details that a worker can safely infer from existing project code, tests, style, or common implementation practice.',
    `If clarification is needed, ask at most ${MAX_CLARIFICATION_QUESTIONS} high-signal questions.`,
    `Prefer multiple-choice questions with 2-${MAX_CLARIFICATION_OPTIONS} concise options whenever possible.`,
    'Use allowCustomAnswer=true when none of the options can safely cover the decision.',
    'Match the language of the work brief when writing questions and options.',
    'Return only JSON with this shape:',
    '{"needsClarification":true,"confidence":0.82,"summary":"string","questions":[{"id":"q1","question":"string","options":["..."],"allowCustomAnswer":true}]}',
    'If no clarification is needed, return:',
    '{"needsClarification":false,"confidence":0.9,"summary":"The brief is ready for worker assignment.","questions":[]}',
  ].join('\n\n');
}

function buildWorkClarificationSystemPrompt(): string {
  return [
    'You are Aoi, the main Kira orchestration model.',
    'Your job is to prevent bad worker assignments caused by underspecified or ambiguous work briefs.',
    'Be decisive: only interrupt the user for information that meaningfully changes implementation.',
    'Prefer objective multiple-choice questions over open-ended questions.',
    'Do not modify files.',
    'Do not wrap the final JSON in markdown fences.',
  ].join('\n');
}

function buildClarificationRequestComment(analysis: WorkClarificationAnalysis): string {
  return [
    'Clarification requested before worker assignment.',
    '',
    `Summary:\n${analysis.summary}`,
    '',
    `Questions:\n${analysis.questions
      .map((question, index) => {
        const options =
          question.options.length > 0
            ? question.options.map((option) => `  - ${option}`).join('\n')
            : '  - Free-form answer needed';
        return `${index + 1}. ${question.question}\n${options}`;
      })
      .join('\n\n')}`,
    '',
    'Answer in the Kira clarification panel, or update the work brief and save it again.',
  ].join('\n');
}

async function ensureWorkClarification(
  options: KiraAutomationPluginOptions,
  sessionPath: string,
  work: WorkTask,
  runtime: ReturnType<typeof getKiraRuntimeSettings>,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<WorkTask | null> {
  if (work.status !== 'todo') return work;

  const briefHash = hashWorkBrief(work);
  const current = work.clarification;
  if (current?.briefHash === briefHash && current.status !== 'pending') {
    return work;
  }
  if (current?.briefHash === briefHash && current.status === 'pending') {
    updateWork(options.sessionsDir, sessionPath, work.id, (existing) => ({
      ...existing,
      status: 'blocked',
    }));
    return null;
  }

  const projectOverview = buildProjectOverview(projectRoot);
  const raw = await runToolAgent(
    runtime.reviewerConfig!,
    projectRoot,
    buildWorkClarificationPrompt(work, projectOverview),
    buildWorkClarificationSystemPrompt(),
    false,
    signal,
    undefined,
    validateWorkClarificationAnalysisFinal,
  );
  const analysis = parseWorkClarificationAnalysis(raw);

  if (!analysis.needsClarification) {
    return (
      updateWork(options.sessionsDir, sessionPath, work.id, (existing) => ({
        ...existing,
        clarification: {
          status: 'cleared',
          briefHash,
          summary: analysis.summary,
          questions: [],
          createdAt: Date.now(),
        },
      })) ?? {
        ...work,
        clarification: {
          status: 'cleared',
          briefHash,
          summary: analysis.summary,
          questions: [],
          createdAt: Date.now(),
        },
      }
    );
  }

  const clarification: WorkClarificationState = {
    status: 'pending',
    briefHash,
    summary: analysis.summary,
    questions: analysis.questions,
    createdAt: Date.now(),
  };

  const updated = updateWork(options.sessionsDir, sessionPath, work.id, (existing) => ({
    ...existing,
    status: 'blocked',
    clarification,
  }));
  addComment(options.sessionsDir, sessionPath, {
    taskId: work.id,
    taskType: 'work',
    author: runtime.reviewerAuthor,
    body: buildClarificationRequestComment(analysis),
  });
  enqueueEvent(options.sessionsDir, sessionPath, {
    id: makeId('event'),
    workId: work.id,
    title: work.title,
    projectName: work.projectName,
    type: 'needs_attention',
    createdAt: Date.now(),
    message: `Kira 질문 필요: "${work.title}" 작업을 worker에게 넘기기 전에 확인할 내용이 있어요.`,
  });

  return updated?.status === 'todo' ? updated : null;
}

function formatList(items: string[], emptyLabel: string): string {
  if (items.length === 0) return `- ${emptyLabel}`;
  return items.map((item) => `- ${item}`).join('\n');
}

function formatInlineList(items: string[], emptyLabel = 'none'): string {
  return items.length > 0 ? items.slice(0, 6).join(', ') : emptyLabel;
}

function formatProjectProfileBlock(profile: KiraProjectProfile | null | undefined): string {
  if (!profile) return 'Project intelligence profile:\n- No saved profile available';
  return [
    'Project intelligence profile:',
    `- Updated: ${new Date(profile.updatedAt).toISOString()}`,
    `- Source roots: ${formatInlineList(profile.repoMap.sourceRoots)}`,
    `- Test roots: ${formatInlineList(profile.repoMap.testRoots)}`,
    `- Style signals: ${formatInlineList(profile.conventions.styleSignals)}`,
    `- Architecture notes: ${formatInlineList(profile.conventions.architectureNotes)}`,
    `- High-risk files: ${formatInlineList(profile.risk.highRiskFiles)}`,
    `- Worker profiles: ${formatInlineList(profile.workers.recommendedProfiles)}`,
    `- Recent review learning: ${formatInlineList(profile.learning.recentReviewFailures)}`,
    `- Recent validation learning: ${formatInlineList(profile.learning.recentValidationFailures)}`,
    `- Worker guidance rules: ${formatInlineList(profile.learning.workerGuidanceRules)}`,
    `- Failure clusters: ${formatInlineList(
      profile.learning.failureClusters
        .slice(0, 4)
        .map((item) => `${item.category}/${item.hits} ${item.signature}`),
    )}`,
    `- Orchestration subagents: ${formatInlineList(
      profile.orchestration?.subagents.map((agent) => agent.id) ?? [],
    )}`,
    `- Workflow path: ${formatInlineList(profile.orchestration?.workflowDag.criticalPath ?? [])}`,
    `- Runner: ${profile.orchestration?.environment.runner ?? 'local'}`,
    `- Weighted memories: ${formatInlineList(
      profile.learning.scoredMemories
        .slice(0, 4)
        .map((item) => `${item.source}/${item.score.toFixed(2)} ${item.text}`),
    )}`,
  ].join('\n');
}

function formatDecompositionRecommendation(
  recommendation: WorkDecompositionRecommendation | undefined,
): string {
  if (!recommendation) return 'Work decomposition:\n- No decomposition analysis available';
  return [
    'Work decomposition:',
    `- Recommendation: ${recommendation.shouldSplit ? 'split before implementation' : 'single focused task is acceptable'}`,
    `- Confidence: ${recommendation.confidence.toFixed(2)}`,
    `- Reason: ${recommendation.reason}`,
    `- Signals:\n${formatList(recommendation.signals, 'No split signals detected')}`,
    `- Suggested subworks:\n${formatList(recommendation.suggestedWorks, 'No split suggested')}`,
  ].join('\n');
}

function formatTaskPlaybook(playbook: TaskPlaybook | undefined): string {
  if (!playbook) return 'Task playbook:\n- No task playbook available';
  return [
    'Task playbook:',
    `- Type: ${playbook.taskType} (${playbook.confidence.toFixed(2)} confidence)`,
    `- Inspect focus:\n${formatList(playbook.inspectFocus, 'No inspect focus')}`,
    `- Validation focus:\n${formatList(playbook.validationFocus, 'No validation focus')}`,
    `- Review checklist:\n${formatList(playbook.reviewChecklist, 'No review checklist')}`,
    `- Risk signals:\n${formatList(playbook.riskSignals, 'No risk signals')}`,
  ].join('\n');
}

function formatDependencyMap(insights: DependencyInsight[] | undefined): string {
  if (!insights?.length) return 'Dependency map:\n- No dependency insights available';
  return [
    'Dependency map:',
    ...insights
      .slice(0, MAX_DEPENDENCY_INSIGHTS)
      .map((item) =>
        [
          `- ${item.file}`,
          `  imports: ${formatInlineList(item.imports)}`,
          `  importedBy: ${formatInlineList(item.importedBy)}`,
          `  nearbyTests: ${formatInlineList(item.nearbyTests)}`,
        ].join('\n'),
      ),
  ].join('\n');
}

function formatSemanticGraph(nodes: SemanticGraphNode[] | undefined): string {
  if (!nodes?.length) return 'Semantic code graph:\n- No semantic graph nodes available';
  return [
    'Semantic code graph:',
    ...nodes
      .slice(0, MAX_SEMANTIC_GRAPH_NODES)
      .map((node) =>
        [
          `- ${node.file} [${node.role}]`,
          `  symbols: ${formatInlineList(node.symbols)}`,
          `  exports: ${formatInlineList(node.exports)}`,
          `  imports: ${formatInlineList(node.imports)}`,
          `  dependents: ${formatInlineList(node.dependents)}`,
          `  tests: ${formatInlineList(node.tests)}`,
        ].join('\n'),
      ),
  ].join('\n');
}

function formatTestImpactAnalysis(items: TestImpactTarget[] | undefined): string {
  if (!items?.length) return 'Test impact analysis:\n- No impacted tests inferred';
  return [
    'Test impact analysis:',
    ...items
      .slice(0, MAX_TEST_IMPACT_TARGETS)
      .map((item) =>
        [
          `- ${item.file} (${item.confidence.toFixed(2)} confidence)`,
          `  impactedTests: ${formatInlineList(item.impactedTests)}`,
          `  commands: ${formatInlineList(item.commands)}`,
          `  rationale: ${item.rationale}`,
        ].join('\n'),
      ),
  ].join('\n');
}

function formatReviewAdversarialPlan(plan: ReviewAdversarialPlan | undefined): string {
  if (!plan) return 'Review adversarial plan:\n- No adversarial review plan available';
  return [
    'Review adversarial plan:',
    `- Modes: ${formatInlineList(plan.modes)}`,
    `- Rationale:\n${formatList(plan.rationale, 'No rationale')}`,
    `- Required evidence:\n${formatList(plan.requiredEvidence, 'No required evidence')}`,
  ].join('\n');
}

function formatClarificationQualityGate(gate: ClarificationQualityGate | undefined): string {
  if (!gate) return 'Clarification quality gate:\n- No clarification gate available';
  return [
    'Clarification quality gate:',
    `- Decision: ${gate.decision}`,
    `- Confidence: ${gate.confidence.toFixed(2)}`,
    `- Reasons:\n${formatList(gate.reasons, 'No gate concerns')}`,
    `- Questions:\n${formatList(gate.questions, 'No clarification questions')}`,
  ].join('\n');
}

function formatReviewerCalibration(calibration: ReviewerCalibration | undefined): string {
  if (!calibration) return 'Reviewer calibration:\n- No calibration available';
  return [
    'Reviewer calibration:',
    `- Strictness: ${calibration.strictness}`,
    `- Evidence minimum: ${calibration.evidenceMinimum}`,
    `- Reasons:\n${formatList(calibration.reasons, 'No strictness reasons')}`,
    `- Focus memories:\n${formatList(calibration.focusMemories, 'No weighted memory focus')}`,
  ].join('\n');
}

function formatDesignReviewGate(gate: DesignReviewGate | undefined): string {
  if (!gate) return 'Design review gate:\n- Not run yet';
  return [
    'Design review gate:',
    `- Status: ${gate.status}`,
    `- Summary: ${gate.summary}`,
    `- Required changes:\n${formatList(gate.requiredChanges, 'No required changes')}`,
    ...gate.checks.map((check) =>
      [
        `- ${check.role}: ${check.verdict}`,
        `  concern: ${check.concern}`,
        `  evidence: ${formatInlineList(check.evidence)}`,
        `  requiredChanges: ${formatInlineList(check.requiredChanges)}`,
      ].join('\n'),
    ),
  ].join('\n');
}

function formatRequirementTrace(trace: RequirementTraceItem[] | undefined): string {
  if (!trace?.length) return 'Requirement trace:\n- No requirement trace available';
  return [
    'Requirement trace:',
    ...trace
      .slice(0, MAX_REQUIREMENT_TRACE_ITEMS)
      .map(
        (item) =>
          `- ${item.id} [${item.source}${item.status ? `/${item.status}` : ''}]: ${item.text}${
            item.evidence.length ? ` Evidence: ${item.evidence.join('; ')}` : ''
          }`,
      ),
  ].join('\n');
}

function formatPatchAlternatives(alternatives: PatchAlternative[] | undefined): string {
  if (!alternatives?.length) return 'Patch alternatives:\n- No alternatives recorded';
  return [
    'Patch alternatives:',
    ...alternatives.map((item) =>
      [
        `- ${item.selected ? '[selected]' : '[rejected]'} ${item.name}: ${item.rationale}`,
        `  tradeoffs: ${formatInlineList(item.tradeoffs)}`,
      ].join('\n'),
    ),
  ].join('\n');
}

function formatRiskReviewPolicy(policy: RiskReviewPolicy | undefined): string {
  if (!policy) return 'Risk review policy:\n- No risk policy available';
  return [
    'Risk review policy:',
    `- Level: ${policy.level}`,
    `- Evidence minimum: ${policy.evidenceMinimum}`,
    `- Runtime validation required: ${policy.requiresRuntimeValidation}`,
    `- Second-pass review required: ${policy.requiresSecondPass}`,
    `- Reasons:\n${formatList(policy.reasons, 'No risk reasons')}`,
  ].join('\n');
}

function formatOrchestrationPlan(plan: OrchestrationPlan | undefined): string {
  if (!plan) return 'Orchestration plan:\n- No orchestration plan available';
  return [
    'Orchestration plan:',
    `- Run mode: ${plan.runMode}`,
    `- Task type: ${plan.taskType}`,
    `- Worker count: ${plan.workerCount}`,
    `- Validation depth: ${plan.validationDepth}`,
    `- Review depth: ${plan.reviewDepth}`,
    `- Approval threshold: ${plan.approvalThreshold}`,
    `- Runner: ${plan.runner}`,
    `- Subagents: ${formatInlineList(plan.subagentIds)}`,
    `- Connectors: ${formatInlineList(plan.connectors)}`,
    `- Workflow critical path: ${formatInlineList(plan.workflowDag.criticalPath)}`,
    `- Summary: ${plan.summary}`,
    `- Lanes:\n${formatList(
      plan.lanes.map(
        (lane) =>
          `${lane.id} (${lane.role}): ${lane.goal} Evidence: ${formatInlineList(
            lane.requiredEvidence,
          )}`,
      ),
      'No orchestration lanes',
    )}`,
    `- Checkpoints:\n${formatList(plan.checkpoints, 'No checkpoints')}`,
    `- Stop rules:\n${formatList(plan.stopRules, 'No stop rules')}`,
  ].join('\n');
}

function formatExecutionPolicy(policy: KiraExecutionPolicy | undefined): string {
  if (!policy) return 'Execution policy:\n- No execution policy available';
  return [
    'Execution policy:',
    `- Mode: ${policy.mode}`,
    `- Changed-file limit: ${policy.maxChangedFiles}`,
    `- Diff-line limit: ${policy.maxDiffLines}`,
    `- Require validation: ${policy.requireValidation}`,
    `- Require reviewer evidence: ${policy.requireReviewerEvidence}`,
    `- Protected paths: ${formatInlineList(policy.protectedPaths)}`,
    `- Command allowlist: ${formatInlineList(policy.commandAllowlist)}`,
    `- Command denylist: ${formatInlineList(policy.commandDenylist)}`,
    `- Rules: ${formatInlineList(policy.rules.filter((rule) => rule.enabled).map((rule) => rule.id))}`,
  ].join('\n');
}

function formatEnvironmentContract(contract: KiraEnvironmentContract | undefined): string {
  if (!contract) return 'Environment contract:\n- No environment contract available';
  return [
    'Environment contract:',
    `- Runner: ${contract.runner}`,
    `- Allowed network: ${contract.allowedNetwork}`,
    `- Secrets policy: ${contract.secretsPolicy}`,
    `- Windows mode: ${contract.windowsMode}`,
    `- Setup commands: ${formatInlineList(contract.setupCommands)}`,
    `- Validation commands: ${formatInlineList(contract.validationCommands)}`,
    `- Required env: ${formatInlineList(contract.requiredEnv)}`,
    `- Dev server command: ${contract.devServerCommand || 'none'}`,
  ].join('\n');
}

function formatSubagentRegistry(subagents: KiraSubagentDefinition[] | undefined): string {
  if (!subagents?.length) return 'Subagent registry:\n- No subagent registry available';
  return [
    'Subagent registry:',
    ...subagents.map(
      (agent) =>
        `- ${agent.id} (${agent.profile}): ${agent.description} Evidence: ${formatInlineList(
          agent.requiredEvidence,
        )}`,
    ),
  ].join('\n');
}

function formatWorkflowDag(dag: KiraWorkflowDag | undefined): string {
  if (!dag) return 'Workflow DAG:\n- No workflow DAG available';
  return [
    'Workflow DAG:',
    `- Nodes: ${formatInlineList(dag.nodes.map((node) => `${node.id}:${node.kind}`))}`,
    `- Critical path: ${formatInlineList(dag.criticalPath)}`,
    `- Edges: ${formatInlineList(dag.edges.map((edge) => `${edge.from}->${edge.to}`))}`,
  ].join('\n');
}

function formatPluginConnectors(connectors: KiraPluginConnector[] | undefined): string {
  if (!connectors?.length) return 'Plugin connectors:\n- No plugin connectors available';
  return [
    'Plugin connectors:',
    ...connectors.map(
      (connector) =>
        `- ${connector.id} (${connector.type}) enabled=${connector.enabled} policy=${connector.policy} capabilities=${formatInlineList(
          connector.capabilities,
        )}`,
    ),
  ].join('\n');
}

function formatQualitySnapshot(snapshot: KiraQualitySnapshot | undefined): string {
  if (!snapshot) return 'Quality snapshot:\n- No quality snapshot available';
  return [
    'Quality snapshot:',
    `- Attempts: ${snapshot.approvedAttempts}/${snapshot.attemptsTotal} approved`,
    `- Validation failures: ${snapshot.validationFailures}`,
    `- Review rejections: ${snapshot.reviewRejections}`,
    `- Rollbacks: ${snapshot.rollbacks}`,
    `- Average readiness: ${snapshot.averageReadinessScore}`,
    `- Pass rate: ${(snapshot.passRate * 100).toFixed(0)}%`,
    `- Top failure categories: ${formatInlineList(snapshot.topFailureCategories)}`,
  ].join('\n');
}

function formatManualEvidence(items: ManualEvidenceItem[] | undefined): string {
  if (!items?.length)
    return 'Manual evidence and risk acceptance:\n- No operator evidence recorded';
  return [
    'Manual evidence and risk acceptance:',
    ...items.map(
      (item) =>
        `- ${item.kind}${item.riskAccepted ? ' (risk accepted)' : ''} by ${item.author}: ${
          item.summary
        }`,
    ),
  ].join('\n');
}

function formatRuntimeValidationSignal(signal: RuntimeValidationSignal | undefined): string {
  if (!signal) return 'Runtime validation:\n- No runtime validation signal available';
  return [
    'Runtime validation:',
    `- Applicable: ${signal.applicable}`,
    `- Reason: ${signal.reason}`,
    `- Suggested running dev server URLs:\n${formatList(signal.suggestedUrls, 'No suggested URLs')}`,
  ].join('\n');
}

function formatRuntimeValidationResult(result: RuntimeValidationResult | undefined): string {
  if (!result) return 'Runtime validation result:\n- No runtime validation result recorded';
  return [
    'Runtime validation result:',
    `- Checked: ${result.checked}`,
    `- Applicable: ${result.applicable}`,
    `- Server detected: ${result.serverDetected}`,
    `- URL: ${result.url ?? 'none'}`,
    `- Status: ${result.status}`,
    ...(result.httpStatus ? [`- HTTP status: ${result.httpStatus}`] : []),
    ...(result.contentType ? [`- Content-Type: ${result.contentType}`] : []),
    ...(result.title ? [`- Title: ${result.title}`] : []),
    ...(result.bodySnippet ? [`- Body snippet: ${result.bodySnippet}`] : []),
    `- Evidence:\n${formatList(result.evidence, 'No runtime evidence captured')}`,
    `- Notes:\n${formatList(result.notes, 'No runtime validation notes')}`,
  ].join('\n');
}

function formatEscalationSignals(signals: EscalationSignal[] | undefined): string {
  if (!signals?.length) return 'Uncertainty escalation signals:\n- No escalation signals detected';
  return [
    'Uncertainty escalation signals:',
    ...signals.map(
      (item) => `- [${item.severity}] ${item.reason} Suggested question: ${item.suggestedQuestion}`,
    ),
  ].join('\n');
}

function formatFailureAnalysis(items: FailureAnalysis[] | undefined): string {
  if (!items?.length) return 'Failure analysis:\n- No validation failures analyzed';
  return [
    'Failure analysis:',
    ...items.map((item) =>
      [
        `- ${item.command} [${item.category}]: ${item.summary}`,
        `  Guidance: ${item.guidance}`,
        `  Reproduce:\n${formatList(
          item.reproductionSteps.map(
            (step) => `${step.command} -> ${step.expectedSignal} (${step.reason})`,
          ),
          'No reproduction steps',
        )}`,
      ].join('\n'),
    ),
  ].join('\n');
}

function formatPatchIntentVerification(verification: PatchIntentVerification | undefined): string {
  if (!verification) return 'Patch intent verification:\n- No patch intent verification recorded';
  return [
    'Patch intent verification:',
    `- Status: ${verification.status}`,
    `- Confidence: ${verification.confidence.toFixed(2)}`,
    `- Checked files: ${formatInlineList(verification.checkedFiles)}`,
    `- Evidence:\n${formatList(verification.evidence, 'No intent evidence')}`,
    `- Issues:\n${formatList(verification.issues, 'No intent issues')}`,
  ].join('\n');
}

function formatAttemptSynthesisRecommendation(
  recommendation: AttemptSynthesisRecommendation | undefined,
): string {
  if (!recommendation) return 'Cross-attempt synthesis:\n- No synthesis analysis available';
  return [
    'Cross-attempt synthesis:',
    `- Can synthesize: ${recommendation.canSynthesize}`,
    `- Summary: ${recommendation.summary}`,
    `- Candidate parts:\n${formatList(recommendation.candidateParts, 'No candidate parts')}`,
    `- Risks:\n${formatList(recommendation.risks, 'No synthesis risks')}`,
  ].join('\n');
}

function formatProjectContextScan(scan: ProjectContextScan): string {
  return [
    `Project context:\n- Root: ${scan.projectRoot}\n- Package manager: ${
      scan.packageManager ?? 'not detected'
    }`,
    formatProjectProfileBlock(scan.projectProfile),
    `Project profile summary:\n${formatList(scan.profileSummary ?? [], 'No profile summary available')}`,
    `Workspace/config files:\n${formatList(scan.workspaceFiles, 'No common workspace files detected')}`,
    `Important package scripts:\n${formatList(scan.packageScripts, 'No test/lint/build/typecheck scripts detected')}`,
    `Existing changes:\n${formatList(scan.existingChanges, 'Clean worktree or no git changes detected')}`,
    `Search terms from brief:\n${formatList(scan.searchTerms, 'No search terms extracted')}`,
    `Likely files:\n${formatList(scan.likelyFiles, 'No likely file matches detected yet')}`,
    `Related docs:\n${formatList(scan.relatedDocs, 'No related docs detected')}`,
    `Related tests:\n${formatList(scan.testFiles, 'No related tests detected')}`,
    `Candidate checks:\n${formatList(scan.candidateChecks, 'No candidate checks detected')}`,
    formatTaskPlaybook(scan.taskPlaybook),
    formatDependencyMap(scan.dependencyMap),
    formatSemanticGraph(scan.semanticGraph),
    formatTestImpactAnalysis(scan.testImpact),
    formatRequirementTrace(scan.requirementTrace),
    formatRiskReviewPolicy(scan.riskPolicy),
    formatOrchestrationPlan(scan.orchestrationPlan),
    formatExecutionPolicy(scan.executionPolicy),
    formatEnvironmentContract(scan.environmentContract),
    formatSubagentRegistry(scan.subagentRegistry),
    formatWorkflowDag(scan.workflowDag),
    formatPluginConnectors(scan.pluginConnectors),
    formatQualitySnapshot(scan.qualitySnapshot),
    formatReviewAdversarialPlan(scan.reviewAdversarialPlan),
    formatRuntimeValidationSignal(scan.runtimeValidation),
    formatEscalationSignals(scan.escalationSignals),
    formatClarificationQualityGate(scan.clarificationGate),
    formatReviewerCalibration(scan.reviewerCalibration),
    formatDesignReviewGate(scan.designReviewGate),
    formatManualEvidence(scan.manualEvidence),
    `Recommended worker profile:\n- ${scan.workerProfile ?? 'generalist'}`,
    formatDecompositionRecommendation(scan.decomposition),
    `Recent project feedback memory:\n${formatList(scan.recentFeedback ?? [], 'No learned review or validation feedback yet')}`,
    `Context notes:\n${formatList(scan.notes, 'No context notes')}`,
  ].join('\n\n');
}

function collectPreflightPlanningIssues(
  contextScan: ProjectContextScan,
  plan: WorkerExecutionPlan,
  explorationActions: string[],
): string[] {
  const issues: string[] = [];

  issues.push(...plan.parseIssues);

  if (explorationActions.length === 0) {
    issues.push(
      'The preflight planner did not inspect the repository with list_files, search_files, or read_file before returning a plan.',
    );
  }

  if (contextScan.likelyFiles.length === 0 && explorationActions.length === 0) {
    issues.push(
      'No likely files were found from the initial context scan, so the planner must search or list the repository before choosing files.',
    );
  }

  if (plan.intendedFiles.length === 0) {
    issues.push('The preflight plan did not identify any intended files to inspect or edit.');
  }

  const design = plan.changeDesign;
  if (design.targetFiles.length === 0) {
    issues.push('The preflight plan did not include changeDesign.targetFiles.');
  }
  if (design.invariants.length === 0) {
    issues.push('The preflight plan did not include changeDesign.invariants.');
  }
  if (design.expectedImpact.length === 0) {
    issues.push('The preflight plan did not include changeDesign.expectedImpact.');
  }
  if (design.validationStrategy.length === 0) {
    issues.push('The preflight plan did not include changeDesign.validationStrategy.');
  }
  if (design.rollbackStrategy.length === 0) {
    issues.push('The preflight plan did not include changeDesign.rollbackStrategy.');
  }
  const designTargetsOutsidePlan = design.targetFiles.filter(
    (file) => !pathMatchesScope(plan.intendedFiles, file),
  );
  if (designTargetsOutsidePlan.length > 0) {
    issues.push(
      `changeDesign.targetFiles includes files outside intendedFiles: ${designTargetsOutsidePlan.join(', ')}`,
    );
  }

  if (plan.repoFindings.length === 0) {
    issues.push('The preflight plan did not record concrete repository findings.');
  }

  if (contextScan.candidateChecks.length > 0 && plan.validationCommands.length === 0) {
    issues.push(
      'The preflight plan omitted validation commands even though Kira detected candidate checks.',
    );
  }
  const clarificationGate = contextScan.clarificationGate;
  const highConfidenceGate =
    clarificationGate &&
    clarificationGate.confidence >= 0.8 &&
    clarificationGate.decision !== 'proceed';
  if (highConfidenceGate && plan.uncertainties.length === 0 && !plan.escalation.shouldAsk) {
    issues.push(
      `The clarification quality gate is ${clarificationGate.decision}, but the preflight plan did not resolve or escalate it: ${clarificationGate.reasons.join('; ')}`,
    );
  }
  if (
    contextScan.testImpact?.some((item) => item.impactedTests.length > 0) &&
    plan.validationCommands.length > 0
  ) {
    const planned = plan.validationCommands.join('\n').toLowerCase();
    const hasBroadTestCommand = /\b(pnpm|npm)\s+(run\s+)?test\b|\bvitest\b(?!\s+\S)/.test(planned);
    const missingImpactCommands = contextScan.testImpact
      .flatMap((item) => item.commands)
      .filter((command) => !planned.includes(command.toLowerCase()));
    if (
      missingImpactCommands.length > 0 &&
      plan.validationCommands.length < 2 &&
      !hasBroadTestCommand
    ) {
      issues.push(
        `The preflight plan did not include inferred impacted-test validation: ${missingImpactCommands
          .slice(0, 2)
          .join(', ')}`,
      );
    }
  }

  if (plan.confidence < 0.45) {
    issues.push(
      `The preflight plan confidence is too low (${plan.confidence.toFixed(2)}); gather more context or ask for clarification.`,
    );
  }

  if (plan.taskType !== contextScan.taskPlaybook?.taskType && plan.taskType === 'generalist') {
    issues.push(
      `The preflight plan did not adopt the detected task playbook type (${contextScan.taskPlaybook?.taskType ?? 'unknown'}).`,
    );
  }
  if (plan.requirementTrace.length === 0) {
    issues.push('The preflight plan did not include a requirementTrace matrix.');
  }
  if (contextScan.requirementTrace?.length && plan.requirementTrace.length > 0) {
    const plannedIds = new Set(plan.requirementTrace.map((item) => item.id));
    const missingRequirements = contextScan.requirementTrace
      .slice(0, 6)
      .filter((item) => !plannedIds.has(item.id));
    if (missingRequirements.length > 0) {
      issues.push(
        `The preflight requirementTrace did not cover detected requirements: ${missingRequirements
          .map((item) => item.id)
          .join(', ')}`,
      );
    }
  }
  if (
    plan.approachAlternatives.length < 2 ||
    plan.approachAlternatives.filter((item) => item.selected).length !== 1
  ) {
    issues.push(
      'The preflight plan must compare at least two patch approaches and mark exactly one selected approach.',
    );
  }
  if (plan.escalation.shouldAsk || plan.escalation.blockers.length > 0) {
    issues.push(
      `The preflight plan escalated unresolved uncertainty: ${[
        ...plan.escalation.questions,
        ...plan.escalation.blockers,
      ].join('; ')}`,
    );
  }
  const highEscalationSignals =
    contextScan.escalationSignals?.filter((item) => item.severity === 'high') ?? [];
  if (highEscalationSignals.length > 0 && plan.uncertainties.length === 0) {
    issues.push(
      `Kira detected high-severity uncertainty; the plan must explicitly resolve or escalate: ${highEscalationSignals
        .map((item) => item.reason)
        .join('; ')}`,
    );
  }

  const blockingUncertainties = plan.uncertainties.filter((item) =>
    /\b(blocked|cannot|can't|unknown|unclear|conflict|unsafe|not sure)\b/i.test(item),
  );
  issues.push(
    ...blockingUncertainties.map(
      (item) => `The preflight plan reported blocking uncertainty: ${item}`,
    ),
  );

  if (plan.decomposition.shouldSplit) {
    issues.push(
      `The preflight planner recommended splitting this work before implementation: ${plan.decomposition.reason}`,
    );
  } else if (
    contextScan.decomposition?.shouldSplit &&
    contextScan.decomposition.confidence >= 0.85 &&
    plan.intendedFiles.length >= 8
  ) {
    issues.push(
      `Kira's decomposition analysis recommends splitting this broad work: ${contextScan.decomposition.reason}`,
    );
  }

  if (plan.intendedFiles.length > SMALL_PATCH_PLAN_FILE_LIMIT && !plan.decomposition.shouldSplit) {
    issues.push(
      `The preflight plan is too broad for Kira small-patch policy (${plan.intendedFiles.length} intended files); split the work or narrow intendedFiles.`,
    );
  }

  const protectedAndPlanned = plan.intendedFiles.filter((plannedFile) =>
    isProtectedFile(plan, plannedFile),
  );
  if (protectedAndPlanned.length > 0) {
    issues.push(
      `The preflight plan lists files as both intendedFiles and protectedFiles: ${protectedAndPlanned.join(', ')}`,
    );
  }

  return issues;
}

function parseStoredList(section: string): string[] {
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(
      (line) =>
        line !== '' && !/^No .* reported$/i.test(line) && line.toLowerCase() !== 'none reported',
    );
}

function extractSection(body: string, label: string, nextLabels: string[]): string {
  const startToken = `${label}:\n`;
  const startIndex = body.indexOf(startToken);
  if (startIndex < 0) return '';

  const contentStart = startIndex + startToken.length;
  let contentEnd = body.length;
  for (const nextLabel of nextLabels) {
    const nextIndex = body.indexOf(`\n\n${nextLabel}:\n`, contentStart);
    if (nextIndex >= 0 && nextIndex < contentEnd) {
      contentEnd = nextIndex;
    }
  }

  return body.slice(contentStart, contentEnd).trim();
}

export function parseStoredWorkerAttemptComment(body: string): WorkerSummary | null {
  if (!body.startsWith('Attempt ')) return null;

  const trailingLabels = [
    'Files changed',
    'Checks',
    'Remaining risks',
    'Validation gaps',
    'Out-of-plan files',
  ];
  const summary = extractSection(body, 'Summary', trailingLabels);
  return {
    summary: summary || 'No worker summary provided.',
    filesChanged: parseStoredList(
      extractSection(body, 'Files changed', [
        'Checks',
        'Remaining risks',
        'Validation gaps',
        'Out-of-plan files',
      ]),
    ),
    testsRun: parseStoredList(
      extractSection(body, 'Checks', ['Remaining risks', 'Validation gaps', 'Out-of-plan files']),
    ),
    remainingRisks: parseStoredList(
      extractSection(body, 'Remaining risks', ['Validation gaps', 'Out-of-plan files']),
    ),
  };
}

export function findSuggestedCommitBackfillSummary(comments: TaskComment[]): WorkerSummary | null {
  const approvalIndex = [...comments]
    .map((comment, index) => ({ comment, index }))
    .reverse()
    .find(
      ({ comment }) => isReviewerAuthor(comment.author) && comment.body.startsWith('Approved.'),
    )?.index;

  if (approvalIndex === undefined) return null;

  const hasCommitSuggestionAfterApproval = comments
    .slice(approvalIndex + 1)
    .some(
      (comment) =>
        isReviewerAuthor(comment.author) && comment.body.startsWith('Suggested commit message:'),
    );
  if (hasCommitSuggestionAfterApproval) return null;

  for (let index = approvalIndex - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (!isWorkerAuthor(comment.author)) continue;
    const summary = parseStoredWorkerAttemptComment(comment.body);
    if (summary) return summary;
  }

  return null;
}

function toKebabCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

function buildSuggestedCommitMessage(work: WorkTask, workerSummary: WorkerSummary): string {
  const fileList = workerSummary.filesChanged.join(' ').toLowerCase();
  const type =
    /fix|bug|error|repair|patch|hotfix|버그|수정/.test(work.title.toLowerCase()) ||
    /fix|bug|error|repair|patch|hotfix/.test(fileList)
      ? 'fix'
      : 'feat';
  const scope = toKebabCase(work.projectName);
  const prefix = scope ? `${type}(${scope})` : type;
  return `${prefix}: ${work.title}`;
}

async function runGitCommand(projectRoot: string, args: string[]): Promise<string> {
  const safeDirectory = projectRoot.replace(/\\/g, '/');
  const result = await execFileAsync(
    'git',
    ['-c', `safe.directory=${safeDirectory}`, '-C', projectRoot, ...args],
    {
      cwd: projectRoot,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  return `${result.stdout ?? ''}`.trim();
}

export function parseGitStatusPorcelain(output: string): GitStatusEntry[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line): GitStatusEntry | null => {
      let status = line.slice(0, 2);
      let rawPath = '';

      if (line.length >= 4 && line[2] === ' ') {
        rawPath = line.slice(3);
      } else {
        const compactMatch = line.match(/^(\S{1,2})\s+(.+)$/);
        if (!compactMatch) return null;
        status = compactMatch[1].padEnd(2, ' ');
        rawPath = compactMatch[2];
      }

      const normalizedPath = rawPath.trim().replace(/\\/g, '/');
      return {
        status,
        path: normalizedPath.includes(' -> ')
          ? (normalizedPath.split(' -> ').pop() ?? normalizedPath)
          : normalizedPath,
      };
    })
    .filter((entry): entry is GitStatusEntry => Boolean(entry?.path));
}

async function getGitWorktreeEntries(projectRoot: string): Promise<GitStatusEntry[] | null> {
  try {
    await runGitCommand(projectRoot, ['rev-parse', '--is-inside-work-tree']);
    const output = await runGitCommand(projectRoot, ['status', '--porcelain=v1', '-uall']);
    return parseGitStatusPorcelain(output);
  } catch {
    return null;
  }
}

async function isGitWorktree(projectRoot: string): Promise<boolean> {
  try {
    await runGitCommand(projectRoot, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

export function shouldUseKiraIsolatedWorktree(
  projectRoot: string,
  projectSettings: { autoCommit?: boolean },
): boolean {
  return (
    Boolean(projectRoot) &&
    projectSettings.autoCommit === true &&
    fs.existsSync(join(projectRoot, '.git'))
  );
}

export function shouldUseKiraAttemptWorktrees(
  projectRoot: string,
  projectSettings: { autoCommit?: boolean },
  workerCount: number,
): boolean {
  return (
    Boolean(projectRoot) &&
    fs.existsSync(join(projectRoot, '.git')) &&
    (projectSettings.autoCommit === true || workerCount > 1)
  );
}

function buildKiraWorktreeBranchName(work: WorkTask, label?: string): string {
  const titleSlug = toKebabCase(work.title) || 'work';
  const workSlug = sanitizeLockKey(work.id).slice(0, 32);
  const labelSlug = label ? `-${sanitizeLockKey(label).slice(0, 24)}` : '';
  return `codex/kira-${titleSlug}-${workSlug}${labelSlug}-${Date.now().toString(36)}`;
}

async function createKiraWorktreeSession(
  primaryRoot: string,
  sessionsDir: string,
  sessionPath: string,
  work: WorkTask,
  projectSettings: { autoCommit: boolean },
  options: { force?: boolean; label?: string } = {},
): Promise<KiraWorkspaceSession> {
  if (!(options.force || projectSettings.autoCommit) || !(await isGitWorktree(primaryRoot))) {
    return { primaryRoot, projectRoot: primaryRoot, isolated: false };
  }

  const worktreesDir = getKiraWorktreesDir(sessionsDir, sessionPath);
  fs.mkdirSync(worktreesDir, { recursive: true });
  const worktreePath = join(
    worktreesDir,
    [
      sanitizeLockKey(work.projectName),
      sanitizeLockKey(work.id),
      options.label ? sanitizeLockKey(options.label) : '',
      Date.now().toString(36),
    ]
      .filter(Boolean)
      .join('-'),
  );
  const branchName = buildKiraWorktreeBranchName(work, options.label);

  try {
    await runGitCommand(primaryRoot, ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);
    return {
      primaryRoot,
      projectRoot: worktreePath,
      isolated: true,
      worktreePath,
      branchName,
    };
  } catch {
    return { primaryRoot, projectRoot: primaryRoot, isolated: false };
  }
}

async function cleanupKiraWorktreeSession(session: KiraWorkspaceSession): Promise<void> {
  if (!session.isolated || !session.worktreePath) return;
  try {
    await runGitCommand(session.primaryRoot, [
      'worktree',
      'remove',
      '--force',
      session.worktreePath,
    ]);
  } catch {
    // Keep going so a stale branch does not block the automation loop cleanup.
  }
  if (session.branchName) {
    try {
      await runGitCommand(session.primaryRoot, ['branch', '-D', session.branchName]);
    } catch {
      // The branch may already be gone or still useful for manual recovery.
    }
  }
}

export function detectTouchedFilesFromGitStatus(
  before: GitStatusEntry[] | null,
  after: GitStatusEntry[] | null,
): string[] {
  if (!after) return [];

  const beforeMap = new Map((before ?? []).map((entry) => [entry.path, entry.status]));
  const afterMap = new Map(after.map((entry) => [entry.path, entry.status]));
  const touched = new Set<string>();

  for (const entry of after) {
    if (isGeneratedArtifactPath(entry.path)) continue;
    const previousStatus = beforeMap.get(entry.path);
    if (previousStatus !== entry.status) {
      touched.add(entry.path);
    }
  }

  for (const entry of before ?? []) {
    if (isGeneratedArtifactPath(entry.path)) continue;
    if (!afterMap.has(entry.path)) {
      touched.add(entry.path);
    }
  }

  return [...touched].sort();
}

export function detectTouchedFilesFromDirtySnapshots(
  projectRoot: string,
  beforeSnapshots: Map<string, DirtyFileContentSnapshot>,
): string[] {
  const touched = new Set<string>();

  for (const [relativePath, before] of beforeSnapshots.entries()) {
    if (isGeneratedArtifactPath(relativePath)) continue;
    const after = readDirtyFileContentSnapshot(projectRoot, relativePath);
    if (
      before.exists !== after.exists ||
      before.hash !== after.hash ||
      before.size !== after.size
    ) {
      touched.add(relativePath);
    }
  }

  return [...touched].sort();
}

export function isGeneratedArtifactPath(filePath: string): boolean {
  const normalized = normalizeRelativePath(filePath).toLowerCase();
  return (
    normalized === '.ds_store' ||
    normalized.endsWith('/.ds_store') ||
    normalized.startsWith('__pycache__/') ||
    normalized.includes('/__pycache__/') ||
    normalized.endsWith('.pyc') ||
    normalized.startsWith('.pytest_cache/') ||
    normalized.startsWith('.mypy_cache/')
  );
}

export function resolveAttemptChangedFiles(
  touchedFiles: string[],
  reportedFiles: string[],
  patchedFiles: string[],
): string[] {
  const observedFiles = normalizePathList([...touchedFiles, ...patchedFiles], 200).filter(
    (filePath) => !isGeneratedArtifactPath(filePath),
  );
  return observedFiles.length > 0
    ? observedFiles
    : normalizePathList(reportedFiles, 200).filter(
        (filePath) => !isGeneratedArtifactPath(filePath),
      );
}

export function filterStageableChangedFiles(
  filesChanged: string[],
  statusEntries: GitStatusEntry[] | null,
): { targetFiles: string[]; ignoredFiles: string[] } {
  const normalizedFiles = normalizePathList(filesChanged, 200).filter(
    (filePath) => !isGeneratedArtifactPath(filePath),
  );
  if (!statusEntries) {
    return { targetFiles: normalizedFiles, ignoredFiles: [] };
  }

  const dirtyFiles = new Set(
    statusEntries
      .map((entry) => normalizeRelativePath(entry.path))
      .filter((filePath) => filePath && !isGeneratedArtifactPath(filePath)),
  );
  return {
    targetFiles: normalizedFiles.filter((filePath) => dirtyFiles.has(filePath)),
    ignoredFiles: normalizedFiles.filter((filePath) => !dirtyFiles.has(filePath)),
  };
}

async function getTrackedHeadFile(
  projectRoot: string,
  relativePath: string,
): Promise<string | null> {
  try {
    const content = await runGitCommand(projectRoot, [
      'show',
      `HEAD:${relativePath.replace(/\\/g, '/')}`,
    ]);
    return content || '';
  } catch {
    return null;
  }
}

async function collectHighRiskAttemptIssues(
  projectRoot: string,
  filesChanged: string[],
): Promise<string[]> {
  const issues: string[] = [];

  for (const relativePath of filesChanged) {
    if (!isHighRiskFile(projectRoot, relativePath)) continue;

    const absolutePath = ensureInsideRoot(projectRoot, relativePath);
    const content = fs.readFileSync(absolutePath, 'utf-8');
    if (containsCorruptionMarker(content)) {
      issues.push(
        `High-risk file ${relativePath} still contains a placeholder or corruption marker.`,
      );
      continue;
    }

    if (relativePath.toLowerCase().endsWith('.py')) {
      try {
        await execFileAsync(
          'python',
          [
            '-c',
            [
              'import ast',
              'from pathlib import Path',
              `path = Path(r"""${absolutePath}""")`,
              "ast.parse(path.read_text(encoding='utf-8'))",
            ].join('; '),
          ],
          {
            cwd: projectRoot,
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
          },
        );
      } catch (error) {
        const stderr =
          error && typeof error === 'object' && 'stderr' in error
            ? String(error.stderr).trim()
            : '';
        const detail = stderr || (error instanceof Error ? error.message : String(error));
        issues.push(`High-risk Python file ${relativePath} failed syntax validation: ${detail}`);
      }
    }

    const headVersion = await getTrackedHeadFile(projectRoot, relativePath);
    if (headVersion !== null && headVersion !== '') {
      const currentLines = content.split(/\r?\n/).length;
      const headLines = headVersion.split(/\r?\n/).length;
      if (headLines >= 220 && currentLines <= Math.floor(headLines * 0.55)) {
        issues.push(
          `High-risk file ${relativePath} shrank from about ${headLines} lines to ${currentLines} lines, which looks like an accidental truncation.`,
        );
      }
    }
  }

  return issues;
}

async function collectPatchValidationIssues(
  projectRoot: string,
  filesChanged: string[],
): Promise<string[]> {
  const issues: string[] = [];
  const normalizedFiles = uniqueStrings(filesChanged.map((file) => normalizeRelativePath(file)));

  for (const relativePath of normalizedFiles) {
    if (!relativePath) continue;
    const absolutePath = ensureInsideRoot(projectRoot, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
    const content = fs.readFileSync(absolutePath, 'utf-8');
    if (hasMergeConflictMarkers(content)) {
      issues.push(`Merge conflict markers detected in ${relativePath}.`);
    }
  }

  if (normalizedFiles.length === 0) return issues;

  try {
    await runGitCommand(projectRoot, ['rev-parse', '--is-inside-work-tree']);
    const diffCheck = await runGitCommand(projectRoot, [
      'diff',
      '--check',
      '--',
      ...normalizedFiles,
    ]);
    if (diffCheck.trim()) {
      issues.push(
        `git diff --check reported patch problems:\n${truncateForReview(diffCheck, 500)}`,
      );
    }
  } catch {
    // Non-git projects or unavailable git diff checks are ignored here.
  }

  return issues;
}

async function rerunValidationCommands(
  projectRoot: string,
  commands: string[],
  signal?: AbortSignal,
  environment?: KiraEnvironmentContract,
  policy?: KiraExecutionPolicy,
): Promise<ValidationRerunSummary> {
  const plannedCommands = uniqueStrings(
    commands.map((command) => normalizeWhitespace(command)),
  ).filter(Boolean);
  const passed: string[] = [];
  const failed: string[] = [];
  const failureDetails: string[] = [];

  for (const command of plannedCommands) {
    if (signal?.aborted) {
      throw createAbortError('Validation rerun aborted.');
    }
    if (!isSafeCommandAllowed(command)) {
      failed.push(command);
      failureDetails.push(`Command: ${command}\n\nError: Rejected by Kira safety policy.`);
      continue;
    }
    const policyEvaluation = evaluateExecutionPolicy(
      policy ?? DEFAULT_KIRA_EXECUTION_POLICY,
      'before_validation',
      { toolName: 'run_command', command },
    );
    if (policyEvaluation.decision === 'block') {
      failed.push(command);
      failureDetails.push(
        `Command: ${command}\n\nError: ${formatPolicyEvaluationFailure(policyEvaluation)}`,
      );
      continue;
    }
    const environmentIssues = collectEnvironmentCommandIssues(environment, command);
    if (environmentIssues.length > 0) {
      failed.push(command);
      failureDetails.push(`Command: ${command}\n\nError: ${environmentIssues.join(' ')}`);
      continue;
    }

    try {
      await runShellCommand(command, projectRoot, signal, COMMAND_TIMEOUT_MS, environment);
      passed.push(command);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      failed.push(command);
      failureDetails.push(formatCommandFailureDetail(command, error));
    }
  }

  return { passed, failed, failureDetails };
}

async function runEnvironmentSetup(
  projectRoot: string,
  environment?: KiraEnvironmentContract,
  signal?: AbortSignal,
  policy?: KiraExecutionPolicy,
): Promise<EnvironmentExecutionSummary> {
  const contract = normalizeEnvironmentContract(environment);
  const setup = contract.setupCommands.length
    ? await rerunValidationCommands(projectRoot, contract.setupCommands, signal, contract, policy)
    : { passed: [], failed: [], failureDetails: [] };
  let remote: EnvironmentExecutionSummary['remote'] = {
    declared: contract.runner !== 'local',
    commandTemplate: contract.remoteCommand,
    status: contract.runner === 'local' ? 'not_declared' : 'skipped',
    probes: [],
    notes:
      contract.runner === 'local'
        ? ['Local runner uses direct process execution.']
        : ['Remote runner was not probed.'],
  };
  if (contract.runner === 'remote-command') {
    const remoteIssues =
      !contract.remoteCommand || !contract.remoteCommand.includes('{command}')
        ? ['Remote-command runner requires environment.remoteCommand with a {command} placeholder.']
        : [
            ...collectEnvironmentCommandIssues(contract, REMOTE_RUNNER_PROBE_COMMAND),
            ...(isSafeCommandAllowed(REMOTE_RUNNER_PROBE_COMMAND)
              ? []
              : ['Remote runner probe command is not in Kira safe command allowlist.']),
          ];
    if (remoteIssues.length > 0) {
      remote = {
        declared: true,
        commandTemplate: contract.remoteCommand,
        status: 'blocked',
        probes: [],
        notes: limitedUniqueStrings(remoteIssues, 8),
      };
    } else {
      try {
        const probe = await runShellCommand(
          REMOTE_RUNNER_PROBE_COMMAND,
          projectRoot,
          signal,
          Math.min(COMMAND_TIMEOUT_MS, 30_000),
          contract,
        );
        const probeOutput = `${probe.stdout}\n${probe.stderr}`;
        const confirmed = /\btrue\b/i.test(probeOutput);
        remote = {
          declared: true,
          commandTemplate: contract.remoteCommand,
          status: confirmed ? 'validated' : 'failed',
          probes: [truncateForReview(formatCommandOutput(probe.stdout, probe.stderr), 1_200)],
          notes: confirmed
            ? ['Remote-command runner validated git worktree reachability.']
            : ['Remote-command runner responded but did not confirm git worktree reachability.'],
        };
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        remote = {
          declared: true,
          commandTemplate: contract.remoteCommand,
          status: 'failed',
          probes: [],
          notes: [
            truncateForReview(
              formatCommandFailureDetail(REMOTE_RUNNER_PROBE_COMMAND, error),
              1_200,
            ),
          ],
        };
      }
    }
  } else if (contract.runner === 'cloud') {
    remote = {
      declared: true,
      commandTemplate: '',
      status: 'blocked',
      probes: [],
      notes: [
        'Cloud runner requires an enabled execution connector before Kira can execute remotely.',
      ],
    };
  }
  const devServerIssues = contract.devServerCommand
    ? [
        ...collectEnvironmentCommandIssues(contract, contract.devServerCommand),
        ...(isSafeCommandAllowed(contract.devServerCommand)
          ? []
          : ['Dev server command is not in Kira safe command allowlist.']),
      ]
    : [];
  return {
    setup,
    remote,
    devServer: {
      declared: Boolean(contract.devServerCommand),
      command: contract.devServerCommand,
      status: !contract.devServerCommand
        ? 'not_declared'
        : devServerIssues.length > 0
          ? 'blocked'
          : 'validated',
      notes: contract.devServerCommand
        ? devServerIssues.length > 0
          ? devServerIssues
          : [
              'Dev server command passed Kira environment policy checks. Kira will use runtime probes instead of leaving a long-running process open.',
            ]
        : ['No dev server command declared.'],
    },
  };
}

function collectEnvironmentExecutionIssues(summary: EnvironmentExecutionSummary): string[] {
  return uniqueStrings([
    ...summary.setup.failed.map((command) => `Environment setup failed: ${command}`),
    ...summary.setup.failureDetails,
    ...(summary.remote.status === 'blocked'
      ? summary.remote.notes.map((note) => `Remote runner blocked: ${note}`)
      : []),
    ...(summary.remote.status === 'failed'
      ? summary.remote.notes.map((note) => `Remote runner failed: ${note}`)
      : []),
    ...(summary.devServer.status === 'blocked'
      ? summary.devServer.notes.map((note) => `Dev server command blocked: ${note}`)
      : []),
  ]).slice(0, 12);
}

function classifyFailure(command: string, detail: string): FailureAnalysis['category'] {
  const source = `${command}\n${detail}`.toLowerCase();
  if (/rejected by kira safety|unsafe|permission denied/.test(source)) return 'safety';
  if (/tsc|type error|typescript|not assignable|property .* does not exist/.test(source)) {
    return 'typecheck';
  }
  if (/eslint|lint|prettier|biome|ruff|mypy/.test(source)) return 'lint';
  if (/vitest|jest|pytest|unittest|test failed|expect\(|assert/.test(source)) return 'unit-test';
  if (/vite build|webpack|rollup|build failed|failed to compile/.test(source)) return 'build';
  if (/eaddrinuse|localhost|connection refused|runtime|browser|console error/.test(source)) {
    return 'runtime';
  }
  if (/enoent|not found|missing|cannot find module|command .* not recognized|spawn/.test(source)) {
    return 'environment';
  }
  return 'unknown';
}

function guidanceForFailure(category: FailureAnalysis['category']): string {
  switch (category) {
    case 'typecheck':
      return 'Fix the type contract at the reported file/line, then rerun the same targeted typecheck.';
    case 'unit-test':
      return 'Identify the failing assertion and fix behavior first; do not weaken the test unless the requirement changed.';
    case 'lint':
      return 'Apply the project lint/style convention locally and rerun the same lint command.';
    case 'build':
      return 'Trace the build failure to imports, exports, or bundler config touched by the patch.';
    case 'runtime':
      return 'Reproduce the runtime path, inspect console/server errors, and fix the user-visible failure.';
    case 'environment':
      return 'Confirm the command exists in this project; choose an available equivalent if the environment lacks the tool.';
    case 'safety':
      return 'Replace the unsafe command with a diagnostic-only validation command allowed by Kira.';
    default:
      return 'Read the failure detail, narrow it to the changed files, and rerun the smallest useful check.';
  }
}

function buildFailureReproductionSteps(
  command: string,
  category: FailureAnalysis['category'],
): FailureReproductionStep[] {
  const safeCommand = isSafeCommandAllowed(command) ? command : '';
  const steps: FailureReproductionStep[] = safeCommand
    ? [
        {
          command: safeCommand,
          reason: 'Reproduce the exact Kira validation failure before changing more code.',
          expectedSignal: 'The same failure appears, or the command passes after the fix.',
        },
      ]
    : [];

  if (category === 'unit-test') {
    steps.push({
      command: 'git diff --check',
      reason:
        'Confirm the patch does not introduce whitespace or conflict-marker issues before rerunning the focused test.',
      expectedSignal: 'No diff formatting errors are reported.',
    });
  }
  if (category === 'typecheck' || category === 'build') {
    steps.push({
      command: 'git diff --name-only',
      reason: 'Narrow the failure to changed files and their exported/imported contracts.',
      expectedSignal: 'Changed files match the suspected contract surface.',
    });
  }
  if (category === 'runtime') {
    steps.push({
      command: 'git diff --name-only',
      reason: 'Identify the runtime-facing files that need a browser or dev-server smoke path.',
      expectedSignal: 'Runtime-facing files are clear enough to inspect and retest.',
    });
  }

  return steps.slice(0, 3);
}

function analyzeValidationFailures(summary: ValidationRerunSummary): FailureAnalysis[] {
  return summary.failureDetails
    .map((detail): FailureAnalysis | null => {
      const command =
        /^Command:\s*(.+)$/m.exec(detail)?.[1]?.trim() || summary.failed[0] || 'unknown';
      const category = classifyFailure(command, detail);
      const firstSignal =
        detail
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line && !/^Command:|^stdout:|^stderr:|^\(empty\)$/i.test(line)) ??
        'Validation failed without a concise error line.';
      return {
        command,
        category,
        summary: truncateForReview(firstSignal, 220),
        guidance: guidanceForFailure(category),
        reproductionSteps: buildFailureReproductionSteps(command, category),
      };
    })
    .filter((item): item is FailureAnalysis => item !== null)
    .slice(0, MAX_FAILURE_ANALYSIS_ITEMS);
}

async function getTrackedGitFiles(projectRoot: string, files: string[]): Promise<Set<string>> {
  if (files.length === 0) return new Set();
  try {
    const tracked = await runGitCommand(projectRoot, ['ls-files', '--', ...files]);
    return new Set(
      tracked
        .split(/\r?\n/)
        .map((line) => normalizeRelativePath(line))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function countTextLines(content: string): number {
  if (!content) return 0;
  const lines = content.split(/\r?\n/);
  return content.endsWith('\n') || content.endsWith('\r')
    ? Math.max(0, lines.length - 1)
    : lines.length;
}

function buildSyntheticNewFileDiff(projectRoot: string, relativePath: string): string | null {
  try {
    const absolutePath = ensureInsideRoot(projectRoot, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return null;
    const content = fs.readFileSync(absolutePath, 'utf-8');
    const lineCount = countTextLines(content);
    const previewLines = content
      .split(/\r?\n/)
      .slice(0, 80)
      .map((line) => `+${line}`)
      .join('\n');
    const hunk =
      lineCount > 0 ? `@@ -0,0 +1,${lineCount} @@\n${previewLines}` : '@@ -0,0 +0,0 @@\n';
    return [
      `File: ${relativePath}`,
      `diff --git a/${relativePath} b/${relativePath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${relativePath}`,
      hunk,
    ].join('\n');
  } catch {
    return null;
  }
}

export async function collectReviewerDiffExcerpts(
  projectRoot: string,
  filesChanged: string[],
): Promise<string[]> {
  const normalizedFiles = uniqueStrings(
    filesChanged.map((file) => normalizeRelativePath(file)),
  ).filter(Boolean);
  if (normalizedFiles.length === 0) return [];

  try {
    await runGitCommand(projectRoot, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return [];
  }

  const trackedFiles = await getTrackedGitFiles(projectRoot, normalizedFiles);
  const excerpts: string[] = [];
  for (const relativePath of normalizedFiles) {
    try {
      const diff = await runGitCommand(projectRoot, ['diff', '--unified=1', '--', relativePath]);
      if (diff.trim()) {
        excerpts.push(`File: ${relativePath}\n${truncateForReview(diff, MAX_REVIEW_DIFF_CHARS)}`);
        continue;
      }
      if (!trackedFiles.has(relativePath)) {
        const syntheticDiff = buildSyntheticNewFileDiff(projectRoot, relativePath);
        if (syntheticDiff) {
          excerpts.push(truncateForReview(syntheticDiff, MAX_REVIEW_DIFF_CHARS));
        }
      }
    } catch {
      // Ignore per-file diff failures and continue collecting what is available.
    }
  }

  return excerpts;
}

export async function collectGitDiffStats(
  projectRoot: string,
  filesChanged: string[],
): Promise<DiffStats> {
  const normalizedFiles = uniqueStrings(
    filesChanged.map((file) => normalizeRelativePath(file)),
  ).filter(Boolean);
  if (normalizedFiles.length === 0) return { files: 0, additions: 0, deletions: 0, hunks: 0 };

  try {
    await runGitCommand(projectRoot, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { files: normalizedFiles.length, additions: 0, deletions: 0, hunks: 0 };
  }

  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  const trackedFiles = await getTrackedGitFiles(projectRoot, normalizedFiles);
  try {
    const numstat = await runGitCommand(projectRoot, [
      'diff',
      '--numstat',
      '--',
      ...normalizedFiles,
    ]);
    for (const line of numstat.split(/\r?\n/)) {
      const [added, deleted] = line.trim().split(/\s+/);
      const addedCount = Number.parseInt(added, 10);
      const deletedCount = Number.parseInt(deleted, 10);
      if (Number.isFinite(addedCount)) additions += addedCount;
      if (Number.isFinite(deletedCount)) deletions += deletedCount;
    }
  } catch {
    // Keep file count even when numstat is unavailable.
  }

  try {
    const diff = await runGitCommand(projectRoot, [
      'diff',
      '--unified=0',
      '--',
      ...normalizedFiles,
    ]);
    hunks = (diff.match(/^@@\s/gm) ?? []).length;
  } catch {
    // Hunk count is advisory.
  }

  const untrackedFiles = normalizedFiles.filter((relativePath) => !trackedFiles.has(relativePath));
  for (const relativePath of untrackedFiles) {
    try {
      const absolutePath = ensureInsideRoot(projectRoot, relativePath);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
      const content = fs.readFileSync(absolutePath, 'utf-8');
      const lineCount = countTextLines(content);
      additions += lineCount;
      if (lineCount > 0) hunks += 1;
    } catch {
      // Keep tracked diff stats even when an untracked file cannot be read.
    }
  }

  return {
    files: normalizedFiles.length,
    additions,
    deletions,
    hunks,
  };
}

function collectPatchScopeIssues(params: {
  workerPlan: WorkerExecutionPlan | null;
  filesChanged: string[];
  diffStats: DiffStats;
}): string[] {
  const issues: string[] = [];
  const changedFiles = normalizePathList(params.filesChanged, 200);
  const changedLineCount = params.diffStats.additions + params.diffStats.deletions;
  const docOnly = isDocumentationOnlyChange(changedFiles);

  if (!docOnly && changedFiles.length > SMALL_PATCH_FILE_LIMIT) {
    issues.push(
      `Patch exceeds Kira small-patch policy: ${changedFiles.length} files changed; split the work or narrow the next attempt to ${SMALL_PATCH_FILE_LIMIT} files or fewer.`,
    );
  }
  if (!docOnly && changedLineCount > SMALL_PATCH_LINE_LIMIT) {
    issues.push(
      `Patch exceeds Kira small-patch policy: ${changedLineCount} changed lines; split broad refactors or reduce the patch size before review.`,
    );
  }
  if (
    params.workerPlan &&
    params.workerPlan.intendedFiles.length > SMALL_PATCH_PLAN_FILE_LIMIT &&
    !params.workerPlan.decomposition.shouldSplit
  ) {
    issues.push(
      `Preflight plan listed ${params.workerPlan.intendedFiles.length} intended files without splitting the work; keep the plan smaller or decompose the task.`,
    );
  }

  return uniqueStrings(issues);
}

function collectExecutionPolicyPatchIssues(params: {
  policy?: KiraExecutionPolicy;
  filesChanged: string[];
  diffStats: DiffStats;
  riskLevel?: RiskReviewPolicy['level'];
}): string[] {
  const evaluation = evaluateExecutionPolicy(
    params.policy ?? DEFAULT_KIRA_EXECUTION_POLICY,
    'before_integration',
    {
      changedFiles: params.filesChanged,
      diffStats: params.diffStats,
      riskLevel: params.riskLevel,
    },
  );
  if (evaluation.decision !== 'block') return [];
  return evaluation.issues.map((issue) => `Execution policy blocked integration: ${issue}`);
}

function collectExecutionPolicyCompletionIssues(params: {
  policy?: KiraExecutionPolicy;
  filesChanged: string[];
  diffStats: DiffStats;
  riskLevel?: RiskReviewPolicy['level'];
}): string[] {
  const evaluation = evaluateExecutionPolicy(
    params.policy ?? DEFAULT_KIRA_EXECUTION_POLICY,
    'task_completed',
    {
      changedFiles: params.filesChanged,
      diffStats: params.diffStats,
      riskLevel: params.riskLevel,
    },
  );
  if (evaluation.decision !== 'block') return [];
  return evaluation.issues.map((issue) => `Execution policy blocked completion: ${issue}`);
}

export function collectAttemptReviewabilityIssues(params: {
  rawWorkerOutput?: string;
  workerSummary: Pick<WorkerSummary, 'summary' | 'filesChanged'>;
  workerPlan?: Pick<WorkerExecutionPlan, 'intendedFiles'> | null;
  diffExcerpts: string[];
  gitDiffAvailable: boolean;
}): string[] {
  const issues: string[] = [];
  const raw = params.rawWorkerOutput?.trim() ?? '';
  const filesChanged = normalizePathList(params.workerSummary.filesChanged ?? [], 200);
  const intendedFiles = normalizePathList(params.workerPlan?.intendedFiles ?? [], 200);
  const summary = params.workerSummary.summary.trim();

  if (!raw) {
    issues.push(
      'Worker returned an empty final submission, so Kira cannot verify the attempt summary or validation evidence.',
    );
  } else if (!summary || summary === 'No worker summary provided.') {
    issues.push('Worker final submission did not include a usable summary.');
  }

  if (intendedFiles.length > 0 && filesChanged.length === 0) {
    issues.push(
      `Worker planned edits to ${intendedFiles.join(', ')} but produced no changed files.`,
    );
  }

  if (params.gitDiffAvailable && filesChanged.length > 0 && params.diffExcerpts.length === 0) {
    issues.push(
      `Kira detected changed files (${filesChanged.join(', ')}) but could not collect a git diff; the attempt cannot be reviewed safely.`,
    );
  }

  return uniqueStrings(issues);
}

export function collectWorkerSelfCheckIssues(params: {
  workerSummary: WorkerSummary;
  workerPlan: WorkerExecutionPlan | null;
  requiredInstructions: string;
  validationPlan: ResolvedValidationPlan;
  filesChanged: string[];
  diffExcerpts?: string[];
}): string[] {
  const issues: string[] = [];
  const selfCheck = params.workerSummary.selfCheck;
  const hasChangedFiles = params.filesChanged.length > 0;
  const hasValidationCommands = params.validationPlan.effectiveCommands.length > 0;
  const docsOnlyChange = isDocumentationOnlyChange(params.filesChanged);

  if (!selfCheck) {
    issues.push(
      'Worker final JSON did not include selfCheck; rerun with an explicit diff, plan, project-instruction, and validation self-check.',
    );
    return issues;
  }

  if (hasChangedFiles && !selfCheck.reviewedDiff) {
    issues.push('Worker self-check says the final diff was not reviewed before submission.');
  }
  if (hasChangedFiles && selfCheck.diffHunkReview.length === 0) {
    issues.push('Worker self-check did not include diffHunkReview for the final patch.');
  }
  if (hasChangedFiles && params.filesChanged.length <= 4 && selfCheck.diffHunkReview.length > 0) {
    const reviewedFiles = selfCheck.diffHunkReview.map((item) => item.file);
    const unreviewedFiles = normalizePathList(params.filesChanged, 20).filter(
      (file) => !pathMatchesScope(reviewedFiles, file),
    );
    if (unreviewedFiles.length > 0) {
      issues.push(
        `Worker diffHunkReview did not cover changed files: ${unreviewedFiles.join(', ')}`,
      );
    }
  }
  const plannedRequirementTrace = params.workerPlan?.requirementTrace ?? [];
  const selfCheckRequirementTrace = selfCheck.requirementTrace ?? [];
  if (plannedRequirementTrace.length > 0 && selfCheckRequirementTrace.length === 0) {
    issues.push('Worker self-check did not include requirementTrace evidence for the final patch.');
  }
  if (plannedRequirementTrace.length > 0 && selfCheckRequirementTrace.length > 0) {
    issues.push(
      ...collectIncompleteRequirementTraceIssues(selfCheckRequirementTrace, 'Worker self-check'),
      ...collectMissingRequirementTraceIds(
        plannedRequirementTrace,
        selfCheckRequirementTrace,
        'Worker self-check',
      ),
    );
  }
  if (params.requiredInstructions.trim() && !selfCheck.followedProjectInstructions) {
    issues.push('Worker self-check says mandatory project instructions were not confirmed.');
  }
  if (params.workerPlan && !selfCheck.matchedPlan) {
    issues.push('Worker self-check says the implementation does not match the approved plan.');
  }
  if (hasValidationCommands && !selfCheck.ranOrExplainedValidation) {
    issues.push(
      'Worker self-check did not confirm that planned validation was run or explicitly explained.',
    );
  }
  if (hasChangedFiles && !docsOnlyChange && !hasValidationCommands) {
    issues.push(
      'Kira found non-documentation changes but no effective validation command; add a safe project validation command or block the attempt instead of approving unverified code.',
    );
  }

  const blockingUncertainty = selfCheck.uncertainty.filter((item) =>
    /\b(blocked|cannot|can't|unknown|unclear|conflict|unsafe|not sure)\b/i.test(item),
  );
  issues.push(...blockingUncertainty.map((item) => `Blocking worker uncertainty: ${item}`));

  return uniqueStrings(issues);
}

export function verifyPatchIntent(params: {
  workerPlan: WorkerExecutionPlan | null;
  workerSummary: WorkerSummary;
  outOfPlanFiles: string[];
  diffStats: DiffStats;
  diffExcerpts: string[];
}): PatchIntentVerification {
  const issues: string[] = [];
  const evidence: string[] = [];
  const changedFiles = normalizePathList(params.workerSummary.filesChanged, 200);
  const intendedFiles = normalizePathList(params.workerPlan?.intendedFiles ?? [], 200);
  const targetFiles = normalizePathList(params.workerPlan?.changeDesign.targetFiles ?? [], 200);
  const expectedScope = uniqueStrings([...intendedFiles, ...targetFiles]);
  const hasExplainedScopeExpansion =
    params.outOfPlanFiles.length > 0 && params.workerSummary.remainingRisks.length > 0;

  if (!params.workerPlan) {
    return {
      status: 'unknown',
      confidence: 0.2,
      checkedFiles: changedFiles,
      evidence: ['No worker plan was available for patch intent verification.'],
      issues: ['Kira could not compare the patch to a preflight plan.'],
    };
  }

  if (changedFiles.length === 0 && expectedScope.length > 0) {
    issues.push(
      `Worker planned edits to ${expectedScope.slice(0, 6).join(', ')} but produced no changed files.`,
    );
  }
  const unscopedFiles = changedFiles.filter((file) => !pathMatchesScope(expectedScope, file));
  if (unscopedFiles.length > 0) {
    issues.push(
      hasExplainedScopeExpansion
        ? `Changed files expanded beyond the planned intent and require reviewer confirmation: ${unscopedFiles.join(
            ', ',
          )}`
        : `Changed files are outside the planned intent: ${unscopedFiles.join(', ')}`,
    );
  }
  if (params.outOfPlanFiles.length > 0 && !params.workerSummary.remainingRisks.length) {
    issues.push(
      `Out-of-plan edits were not explained in remainingRisks: ${params.outOfPlanFiles.join(', ')}`,
    );
  }
  if (params.workerSummary.selfCheck && !params.workerSummary.selfCheck.matchedPlan) {
    issues.push('Worker self-check says the implementation does not match the approved plan.');
  }
  if (changedFiles.length > 0 && params.diffExcerpts.length === 0) {
    issues.push('Changed files exist, but Kira could not collect diff evidence for intent review.');
  }

  evidence.push(
    `Plan intended files: ${formatInlineList(intendedFiles)}`,
    `Change design targets: ${formatInlineList(targetFiles)}`,
    `Changed files: ${formatInlineList(changedFiles)}`,
    `Diff stats: ${params.diffStats.files} files, ${params.diffStats.additions} additions, ${params.diffStats.deletions} deletions, ${params.diffStats.hunks} hunks`,
  );

  const status: PatchIntentVerification['status'] =
    issues.length === 0
      ? 'aligned'
      : changedFiles.length === 0 ||
          (unscopedFiles.length > 0 && !hasExplainedScopeExpansion) ||
          params.workerSummary.selfCheck?.matchedPlan === false
        ? 'drift'
        : 'unknown';
  const confidence =
    params.diffExcerpts.length > 0 || changedFiles.length === 0
      ? status === 'aligned'
        ? 0.82
        : 0.78
      : 0.48;
  return {
    status,
    confidence,
    checkedFiles: changedFiles,
    evidence: limitedUniqueStrings(evidence, 8),
    issues: limitedUniqueStrings(issues, 8),
  };
}

function emptyPatchIntentVerification(message: string): PatchIntentVerification {
  return {
    status: 'unknown',
    confidence: 0.2,
    checkedFiles: [],
    evidence: [message],
    issues: [message],
  };
}

function buildAttemptSynthesisRecommendation(
  attempts: KiraWorkerAttemptResult[],
): AttemptSynthesisRecommendation {
  if (attempts.length < 2) {
    return {
      canSynthesize: false,
      summary: 'Only one reviewable attempt is available; no cross-attempt synthesis is possible.',
      candidateParts: [],
      risks: [],
    };
  }

  const fileOwners = new Map<string, number[]>();
  for (const attempt of attempts) {
    for (const file of attempt.workerSummary.filesChanged) {
      const normalized = normalizeRelativePath(file);
      fileOwners.set(normalized, [...(fileOwners.get(normalized) ?? []), attempt.attemptNo]);
    }
  }
  const overlappingFiles = [...fileOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([file, owners]) => `${file} (${owners.join(', ')})`);
  const passingAttempts = attempts.filter(
    (attempt) => attempt.validationReruns.failed.length === 0,
  );
  const canSynthesize =
    passingAttempts.length >= 2 &&
    overlappingFiles.length === 0 &&
    attempts.every((attempt) => attempt.patchIntentVerification.status === 'aligned');

  return {
    canSynthesize,
    summary: canSynthesize
      ? 'Attempts touch disjoint aligned surfaces; reviewer may use them as synthesis guidance, but Kira will still integrate one selected winner.'
      : 'Synthesis is advisory only; overlapping files, validation gaps, or intent drift make single-winner selection safer.',
    candidateParts: passingAttempts
      .map(
        (attempt) =>
          `Attempt ${attempt.attemptNo} (${attempt.lane.label}): ${formatInlineList(
            attempt.workerSummary.filesChanged,
          )}`,
      )
      .slice(0, 8),
    risks: limitedUniqueStrings(
      [
        ...overlappingFiles.map((file) => `Overlapping changed file: ${file}`),
        ...attempts
          .filter((attempt) => attempt.validationReruns.failed.length > 0)
          .map((attempt) => `Attempt ${attempt.attemptNo} has failed validation.`),
        ...attempts
          .filter((attempt) => attempt.patchIntentVerification.status !== 'aligned')
          .map(
            (attempt) =>
              `Attempt ${attempt.attemptNo} patch intent is ${attempt.patchIntentVerification.status}.`,
          ),
      ],
      10,
    ),
  };
}

function collectPlanGuardrailIssues(
  projectRoot: string,
  plan: WorkerExecutionPlan | null,
  filesChanged: string[],
  commandsRun: string[],
): string[] {
  if (!plan) return [];

  const issues: string[] = [];
  const outOfPlanFiles = findOutOfPlanTouchedFiles(plan.intendedFiles, filesChanged);
  const highRiskOutOfPlan = outOfPlanFiles.filter((file) => isHighRiskFile(projectRoot, file));
  if (highRiskOutOfPlan.length > 0) {
    issues.push(
      `High-risk files were modified outside the approved plan: ${highRiskOutOfPlan.join(', ')}`,
    );
  } else if (outOfPlanFiles.length >= 4) {
    issues.push(
      `Too many files were modified outside the approved plan: ${outOfPlanFiles.join(', ')}`,
    );
  }

  const highRiskTouched = uniqueStrings(
    filesChanged.filter((file) => isHighRiskFile(projectRoot, file)),
  );
  const missingValidationCommands = findMissingValidationCommands(
    plan.validationCommands,
    commandsRun,
  );
  if (
    highRiskTouched.length > 0 &&
    plan.validationCommands.length > 0 &&
    missingValidationCommands.length === plan.validationCommands.length
  ) {
    issues.push(
      `Worker skipped all planned validation commands after changing high-risk files: ${highRiskTouched.join(', ')}`,
    );
  }

  return issues;
}

function getDirtyWorktreePaths(entries: GitStatusEntry[] | null): string[] {
  if (!entries) return [];
  return uniqueStrings(
    entries
      .map((entry) => normalizeRelativePath(entry.path))
      .filter(Boolean)
      .filter((filePath) => !isGeneratedArtifactPath(filePath)),
  );
}

function collectDirtyFileGuardrailIssues(
  plan: WorkerExecutionPlan | null,
  dirtyFiles: string[],
  filesChanged: string[],
): string[] {
  if (!plan) return [];
  const changedDirtyFiles = normalizePathList(filesChanged, 200).filter((file) =>
    dirtyFiles.includes(file),
  );
  const unplannedDirtyFiles = changedDirtyFiles.filter((file) => !isPlannedFile(plan, file));
  const protectedDirtyFiles = changedDirtyFiles.filter((file) => isProtectedFile(plan, file));
  return [
    ...protectedDirtyFiles.map((file) => `Protected dirty file was modified: ${file}`),
    ...unplannedDirtyFiles.map(
      (file) => `Pre-existing dirty file was modified outside intendedFiles: ${file}`,
    ),
  ];
}

function collectMissingRequirementTraceIds(
  expectedTrace: RequirementTraceItem[],
  actualTrace: RequirementTraceItem[],
  actor: string,
): string[] {
  if (expectedTrace.length === 0 || actualTrace.length === 0) return [];
  const expectedIds = new Set(expectedTrace.map((item) => item.id));
  const actualIds = new Set(actualTrace.map((item) => item.id));
  const missingIds = [...expectedIds].filter((id) => !actualIds.has(id)).slice(0, 6);
  return missingIds.length > 0
    ? [`${actor} requirementTrace missed planned requirements: ${missingIds.join(', ')}`]
    : [];
}

function collectIncompleteRequirementTraceIssues(
  trace: RequirementTraceItem[],
  actor: string,
): string[] {
  return trace
    .filter((item) => {
      const completed = item.status === 'satisfied' || item.status === 'not_applicable';
      const acceptanceRequirement =
        item.source === 'brief' || item.source === 'project-instruction';
      const invalidNotApplicable = item.status === 'not_applicable' && acceptanceRequirement;
      return !completed || invalidNotApplicable || item.evidence.length === 0;
    })
    .map((item) => {
      const status = item.status ?? 'missing';
      const evidenceNote = item.evidence.length === 0 ? ' without evidence' : '';
      const scopeNote =
        status === 'not_applicable' &&
        (item.source === 'brief' || item.source === 'project-instruction')
          ? ' Acceptance requirements from the brief or mandatory project instructions cannot be marked not_applicable.'
          : '';
      return `${actor} requirementTrace is incomplete for ${item.id}: status=${status}${evidenceNote}. ${item.text}${scopeNote}`;
    });
}

function buildReviewFindingTriage(
  reviewSummary: ReviewSummary,
  extras: {
    designReviewGate?: DesignReviewGate;
    patchIntentVerification?: PatchIntentVerification;
    runtimeValidation?: RuntimeValidationResult;
  } = {},
): ReviewFindingTriageItem[] {
  const now = Date.now();
  const items: ReviewFindingTriageItem[] = [];
  const addItem = (
    source: ReviewFindingTriageItem['source'],
    severity: ReviewFinding['severity'],
    title: string,
    evidence: string[],
    file?: string,
    line?: number | null,
  ) => {
    const key = normalizeWhitespace(`${source}:${severity}:${file ?? ''}:${line ?? ''}:${title}`);
    items.push({
      id: `triage-${createHash('sha1').update(key).digest('hex').slice(0, 12)}`,
      source,
      status: reviewSummary.approved ? 'fixed' : 'open',
      severity,
      title,
      ...(file ? { file } : {}),
      ...(line !== undefined ? { line } : {}),
      evidence: limitedUniqueStrings(evidence, 6),
      owner: reviewSummary.approved ? 'reviewer' : 'worker',
      createdAt: now,
    });
  };

  for (const finding of reviewSummary.findings) {
    addItem(
      'review',
      finding.severity,
      finding.message,
      [reviewSummary.summary],
      finding.file,
      finding.line,
    );
  }
  for (const command of reviewSummary.missingValidation) {
    addItem('validation', 'medium', `Missing validation: ${command}`, [command]);
  }
  for (const issue of reviewSummary.issues) {
    addItem('review', 'medium', issue, [reviewSummary.summary]);
  }
  for (const change of extras.designReviewGate?.requiredChanges ?? []) {
    addItem('design', 'medium', change, [extras.designReviewGate?.summary ?? 'Design review gate']);
  }
  for (const issue of extras.patchIntentVerification?.issues ?? []) {
    addItem('intent', 'high', issue, extras.patchIntentVerification?.evidence ?? []);
  }
  if (
    extras.runtimeValidation?.applicable &&
    extras.runtimeValidation.serverDetected &&
    extras.runtimeValidation.status !== 'reachable'
  ) {
    addItem(
      'runtime',
      'high',
      'Runtime validation failed on a detected dev server.',
      extras.runtimeValidation.evidence,
      extras.runtimeValidation.url ?? undefined,
    );
  }

  const byId = new Map<string, ReviewFindingTriageItem>();
  for (const item of items) {
    byId.set(item.id, item);
  }
  return [...byId.values()].slice(0, 30);
}

function extractChangedDiffLines(diffExcerpts: string[]): Map<string, Set<number>> {
  const byFile = new Map<string, Set<number>>();
  for (const excerpt of diffExcerpts) {
    const headerFile = /^File:\s*(.+)$/m.exec(excerpt)?.[1]?.trim();
    let currentFile = headerFile ? normalizeRelativePath(headerFile) : '';
    let nextLine = 0;
    for (const line of excerpt.split(/\r?\n/)) {
      const fileMatch = /^\+\+\+\s+b\/(.+)$/.exec(line);
      if (fileMatch?.[1]) {
        currentFile = normalizeRelativePath(fileMatch[1]);
        if (!byFile.has(currentFile)) byFile.set(currentFile, new Set());
        continue;
      }
      const hunkMatch = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
      if (hunkMatch?.[1]) {
        nextLine = Number.parseInt(hunkMatch[1], 10);
        if (currentFile && !byFile.has(currentFile)) byFile.set(currentFile, new Set());
        continue;
      }
      if (!currentFile || nextLine <= 0) continue;
      if (line.startsWith('+') && !line.startsWith('+++')) {
        byFile.get(currentFile)?.add(nextLine);
        nextLine += 1;
        continue;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        continue;
      }
      nextLine += 1;
    }
  }
  return byFile;
}

function buildDiffReviewCoverage(params: {
  workerSummary?: WorkerSummary;
  reviewSummary?: ReviewSummary;
  diffExcerpts?: string[];
}): DiffReviewCoverage {
  const changedLines = extractChangedDiffLines(params.diffExcerpts ?? []);
  const filesWithChangedLines = [...changedLines.keys()].sort();
  const changedLineCount = [...changedLines.values()].reduce(
    (total, lines) => total + lines.size,
    0,
  );
  const reviewSummary = params.reviewSummary;
  const reviewedFiles = normalizePathList(
    [
      ...(reviewSummary?.filesChecked ?? []),
      ...(reviewSummary?.evidenceChecked.map((item) => item.file) ?? []),
    ],
    200,
  );
  const findings = reviewSummary?.findings ?? [];
  const anchoredFindingCount = findings.filter((finding) => {
    const file = normalizeRelativePath(finding.file);
    return (
      file &&
      typeof finding.line === 'number' &&
      finding.line > 0 &&
      changedLines.get(file)?.has(finding.line)
    );
  }).length;
  const unanchoredFindingCount = findings.length - anchoredFindingCount;
  const filesCoveredByReview = filesWithChangedLines.filter((file) =>
    pathMatchesScope(reviewedFiles, file),
  );
  const issues = uniqueStrings([
    ...(filesWithChangedLines.length > 0 && filesCoveredByReview.length === 0
      ? ['Reviewer did not cover any file with changed diff lines.']
      : []),
    ...(reviewSummary?.approved && unanchoredFindingCount > 0
      ? [`Reviewer approved with ${unanchoredFindingCount} unanchored finding(s).`]
      : []),
    ...(params.workerSummary?.summary &&
    /\b(no changes|nothing changed|no files changed)\b/i.test(params.workerSummary.summary) &&
    (params.workerSummary.filesChanged?.length ?? 0) > 0
      ? ['Worker summary contradicts the detected changed files.']
      : []),
  ]);
  return {
    changedLineCount,
    anchoredFindingCount,
    unanchoredFindingCount,
    filesWithChangedLines,
    filesCoveredByReview,
    coverageRatio:
      filesWithChangedLines.length > 0
        ? filesCoveredByReview.length / filesWithChangedLines.length
        : 1,
    issues,
  };
}

function buildReviewObservability(params: {
  startedAt: number;
  finishedAt: number;
  reviewRaw: string;
  reviewSummary: ReviewSummary;
  triage: ReviewFindingTriageItem[];
}): KiraReviewObservability {
  return {
    durationMs: Math.max(0, params.finishedAt - params.startedAt),
    findingCount: params.reviewSummary.findings.length,
    triageOpenCount: params.triage.filter((item) => item.status === 'open').length,
    discourseCount: params.reviewSummary.reviewerDiscourse.length,
    evidenceCount: params.reviewSummary.evidenceChecked.length,
    estimatedReviewOutputTokens: estimateTokenCount(params.reviewRaw),
  };
}

function buildEvidenceLedger(params: {
  contextScan: ProjectContextScan;
  workerPlan: WorkerExecutionPlan;
  workerSummary?: WorkerSummary;
  validationReruns?: ValidationRerunSummary;
  diffStats?: DiffStats;
  runtimeValidation?: RuntimeValidationResult;
  patchIntentVerification?: PatchIntentVerification;
  designReviewGate?: DesignReviewGate;
  reviewSummary?: ReviewSummary;
  riskPolicy?: RiskReviewPolicy;
}): EvidenceLedger {
  const createdAt = Date.now();
  const items: EvidenceLedgerItem[] = [];
  const addItem = (
    kind: EvidenceLedgerItem['kind'],
    status: EvidenceLedgerItem['status'],
    summary: string,
    evidence: string[],
    createdBy: EvidenceLedgerItem['createdBy'],
    confidence: number,
    target?: string,
  ) => {
    const key = normalizeWhitespace(`${kind}:${status}:${target ?? ''}:${summary}`);
    items.push({
      id: `evidence-${createHash('sha1').update(key).digest('hex').slice(0, 12)}`,
      kind,
      status,
      summary,
      ...(target ? { target } : {}),
      evidence: limitedUniqueStrings(evidence, 8),
      createdBy,
      confidence: clampConfidence(confidence, 0.5),
      createdAt,
    });
  };

  addItem(
    'plan',
    params.workerPlan.valid ? 'pass' : 'warn',
    params.workerPlan.summary || 'Worker plan recorded.',
    [
      `Task type: ${params.workerPlan.taskType}`,
      `Intended files: ${formatInlineList(params.workerPlan.intendedFiles)}`,
      `Confidence: ${params.workerPlan.confidence.toFixed(2)}`,
    ],
    'worker',
    params.workerPlan.confidence,
  );

  const policy = params.contextScan.executionPolicy;
  const policyEvaluation = policy
    ? evaluateExecutionPolicy(policy, 'before_integration', {
        changedFiles: params.workerSummary?.filesChanged ?? [],
        diffStats: params.diffStats,
        riskLevel: params.riskPolicy?.level ?? params.contextScan.riskPolicy?.level,
      })
    : null;
  if (policy) {
    addItem(
      'policy',
      policyEvaluation?.decision === 'block'
        ? 'fail'
        : policyEvaluation?.decision === 'warn'
          ? 'warn'
          : 'pass',
      `Execution policy ${policy.mode}: ${policy.maxChangedFiles} files / ${policy.maxDiffLines} diff lines.`,
      [
        `Protected paths: ${formatInlineList(policy.protectedPaths)}`,
        `Denylist: ${formatInlineList(policy.commandDenylist)}`,
        ...(policyEvaluation ? [...policyEvaluation.issues, ...policyEvaluation.warnings] : []),
      ],
      'kira',
      policyEvaluation?.decision === 'block' ? 0.95 : 0.76,
    );
  }

  if (params.contextScan.environmentContract) {
    const setupFailed = (params.contextScan.environmentExecution?.setup.failed.length ?? 0) > 0;
    const remoteBlocked =
      params.contextScan.environmentExecution?.remote?.status === 'blocked' ||
      params.contextScan.environmentExecution?.remote?.status === 'failed';
    const devServerBlocked =
      params.contextScan.environmentExecution?.devServer.status === 'blocked';
    addItem(
      'environment',
      setupFailed || remoteBlocked || devServerBlocked
        ? 'fail'
        : params.contextScan.environmentContract.runner === 'cloud'
          ? 'warn'
          : 'pass',
      `Environment runner: ${params.contextScan.environmentContract.runner}.`,
      [
        `Validation commands: ${formatInlineList(params.contextScan.environmentContract.validationCommands)}`,
        `Setup passed: ${formatInlineList(params.contextScan.environmentExecution?.setup.passed ?? [])}`,
        `Setup failed: ${formatInlineList(params.contextScan.environmentExecution?.setup.failed ?? [])}`,
        `Remote runner: ${params.contextScan.environmentExecution?.remote?.status ?? 'not_checked'}`,
        `Remote probes: ${formatInlineList(params.contextScan.environmentExecution?.remote?.probes ?? [])}`,
        `Dev server: ${params.contextScan.environmentExecution?.devServer.status ?? 'not_checked'}`,
        `Required env: ${formatInlineList(params.contextScan.environmentContract.requiredEnv)}`,
        `Allowed network: ${params.contextScan.environmentContract.allowedNetwork}`,
      ],
      'kira',
      setupFailed || remoteBlocked || devServerBlocked
        ? 0.94
        : params.contextScan.environmentContract.runner === 'local'
          ? 0.78
          : 0.62,
    );
  }

  if (params.contextScan.workflowDag) {
    addItem(
      'workflow',
      params.contextScan.workflowDag.criticalPath.length > 0 ? 'pass' : 'warn',
      `Workflow DAG has ${params.contextScan.workflowDag.nodes.length} node(s).`,
      [
        `Critical path: ${formatInlineList(params.contextScan.workflowDag.criticalPath)}`,
        `Edges: ${formatInlineList(
          params.contextScan.workflowDag.edges.map((edge) => `${edge.from}->${edge.to}`),
        )}`,
      ],
      'kira',
      0.72,
    );
  }

  if (params.contextScan.pluginConnectors) {
    const enabled = params.contextScan.pluginConnectors.filter((connector) => connector.enabled);
    addItem(
      'connectors',
      enabled.length > 0 ? 'info' : 'warn',
      `${enabled.length} plugin connector(s) enabled for this project.`,
      params.contextScan.pluginConnectors.map(
        (connector) => `${connector.id}: enabled=${connector.enabled} policy=${connector.policy}`,
      ),
      'kira',
      enabled.length > 0 ? 0.62 : 0.5,
    );
  }

  if (params.diffStats) {
    addItem(
      'diff',
      params.diffStats.files > 0 ? 'pass' : 'warn',
      `${params.diffStats.files} changed file(s), ${params.diffStats.hunks} hunk(s).`,
      [
        `+${params.diffStats.additions}/-${params.diffStats.deletions}`,
        `Reported files: ${formatInlineList(params.workerSummary?.filesChanged ?? [])}`,
      ],
      'kira',
      params.diffStats.files > 0 ? 0.8 : 0.45,
    );
  }

  const validation = params.validationReruns;
  if (validation) {
    addItem(
      'validation',
      validation.failed.length > 0 ? 'fail' : validation.passed.length > 0 ? 'pass' : 'warn',
      `${validation.passed.length} validation rerun(s) passed, ${validation.failed.length} failed.`,
      [
        ...validation.passed.map((item) => `passed: ${item}`),
        ...validation.failed.map((item) => `failed: ${item}`),
      ],
      'kira',
      validation.failed.length > 0 ? 0.95 : validation.passed.length > 0 ? 0.82 : 0.35,
    );
  }

  if (params.runtimeValidation) {
    const runtimeStatus: EvidenceLedgerItem['status'] =
      params.runtimeValidation.status === 'reachable'
        ? 'pass'
        : params.runtimeValidation.applicable && params.runtimeValidation.serverDetected
          ? 'fail'
          : params.runtimeValidation.applicable
            ? 'warn'
            : 'info';
    addItem(
      'runtime',
      runtimeStatus,
      `Runtime validation ${params.runtimeValidation.status}.`,
      [...params.runtimeValidation.evidence, ...params.runtimeValidation.notes],
      'kira',
      runtimeStatus === 'pass' ? 0.85 : runtimeStatus === 'fail' ? 0.9 : 0.45,
      params.runtimeValidation.url ?? undefined,
    );
  }

  if (params.patchIntentVerification) {
    addItem(
      'intent',
      params.patchIntentVerification.status === 'aligned'
        ? 'pass'
        : params.patchIntentVerification.status === 'drift'
          ? 'fail'
          : 'warn',
      `Patch intent is ${params.patchIntentVerification.status}.`,
      [...params.patchIntentVerification.evidence, ...params.patchIntentVerification.issues],
      'kira',
      params.patchIntentVerification.confidence,
    );
  }

  const designGate = params.designReviewGate ?? params.contextScan.designReviewGate;
  if (designGate) {
    addItem(
      'design',
      designGate.status === 'blocked' ? 'fail' : designGate.status === 'warning' ? 'warn' : 'pass',
      designGate.summary,
      designGate.requiredChanges.length > 0 ? designGate.requiredChanges : [designGate.summary],
      'kira',
      designGate.status === 'passed' ? 0.8 : 0.7,
    );
  }

  if (params.reviewSummary) {
    addItem(
      'review',
      params.reviewSummary.approved ? 'pass' : 'warn',
      params.reviewSummary.summary,
      [
        ...params.reviewSummary.filesChecked.map((item) => `checked: ${item}`),
        ...params.reviewSummary.evidenceChecked.map(
          (item) => `${item.method}: ${item.file} (${item.reason})`,
        ),
        ...params.reviewSummary.issues,
      ],
      'reviewer',
      params.reviewSummary.approved ? 0.86 : 0.65,
    );
  }

  for (const manual of params.contextScan.manualEvidence ?? []) {
    addItem(
      manual.riskAccepted ? 'risk-acceptance' : 'manual',
      manual.riskAccepted ? 'warn' : 'info',
      manual.summary,
      [manual.summary],
      'operator',
      manual.riskAccepted ? 0.65 : 0.55,
      manual.author,
    );
  }

  const blockers = limitedUniqueStrings(
    [
      ...(validation?.failed.length ? [`Validation failed: ${validation.failed.join(', ')}`] : []),
      ...(params.patchIntentVerification?.status === 'drift'
        ? params.patchIntentVerification.issues.map((issue) => `Patch intent drift: ${issue}`)
        : []),
      ...(designGate?.status === 'blocked'
        ? designGate.requiredChanges.map((item) => `Design gate blocked: ${item}`)
        : []),
      ...(params.runtimeValidation?.applicable &&
      params.runtimeValidation.serverDetected &&
      params.runtimeValidation.status !== 'reachable'
        ? ['Runtime validation failed on a detected dev server.']
        : []),
      ...(params.contextScan.environmentExecution?.setup.failed ?? []).map(
        (command) => `Environment setup failed: ${command}`,
      ),
      ...(params.contextScan.environmentExecution?.remote?.status === 'blocked'
        ? ['Environment remote runner is blocked by policy.']
        : []),
      ...(params.contextScan.environmentExecution?.remote?.status === 'failed'
        ? ['Environment remote runner probe failed.']
        : []),
      ...(params.contextScan.environmentExecution?.devServer.status === 'blocked'
        ? ['Environment dev server command is blocked by policy.']
        : []),
      ...(policyEvaluation?.issues ?? []).map((issue) => `Execution policy blocked: ${issue}`),
    ],
    12,
  );
  const observedEvidenceCount = items.filter((item) => item.status === 'pass').length;
  const requiredEvidenceCount =
    params.riskPolicy?.evidenceMinimum ?? params.contextScan.riskPolicy?.evidenceMinimum ?? 1;
  const missingEvidence = limitedUniqueStrings(
    [
      ...(observedEvidenceCount < requiredEvidenceCount
        ? [`Need ${requiredEvidenceCount - observedEvidenceCount} more passing evidence item(s).`]
        : []),
      ...(!validation || validation.passed.length === 0
        ? policy?.requireValidation !== false
          ? ['No passed Kira validation rerun recorded.']
          : []
        : []),
      ...(policy?.requireReviewerEvidence === true &&
      params.reviewSummary &&
      params.reviewSummary.evidenceChecked.length === 0
        ? ['Execution policy requires reviewer evidence, but none was recorded.']
        : []),
      ...(params.workerSummary?.filesChanged.length && !params.diffStats
        ? ['Changed files exist but diff stats are missing.']
        : []),
      ...(params.reviewSummary && params.reviewSummary.evidenceChecked.length === 0
        ? ['Reviewer did not record evidenceChecked entries.']
        : []),
    ],
    8,
  );
  const riskAcceptanceBonus = (params.contextScan.manualEvidence ?? []).some(
    (item) => item.riskAccepted,
  )
    ? 6
    : 0;
  const score = Math.max(
    0,
    Math.min(
      100,
      items.reduce((total, item) => {
        const base =
          item.status === 'pass'
            ? 14
            : item.status === 'info'
              ? 5
              : item.status === 'warn'
                ? 2
                : -18;
        return total + base * item.confidence;
      }, 20) +
        riskAcceptanceBonus -
        blockers.length * 12 -
        missingEvidence.length * 4,
    ),
  );
  return {
    items,
    approvalReadiness: {
      score: Math.round(score),
      status:
        blockers.length > 0
          ? 'blocked'
          : missingEvidence.length > 0 || score < 80
            ? 'needs_evidence'
            : 'ready',
      blockers,
      missingEvidence,
      requiredEvidenceCount,
      observedEvidenceCount,
    },
  };
}

function buildReviewRecord(
  workId: string,
  attemptNo: number,
  reviewSummary: ReviewSummary,
  extras: {
    reviewAdversarialPlan?: ReviewAdversarialPlan;
    attemptSynthesis?: AttemptSynthesisRecommendation;
    designReviewGate?: DesignReviewGate;
    patchIntentVerification?: PatchIntentVerification;
    runtimeValidation?: RuntimeValidationResult;
    observability?: KiraReviewObservability;
    diffCoverage?: DiffReviewCoverage;
  } = {},
): KiraReviewRecord {
  const normalizedSummary = ensureReviewerDiscourse(reviewSummary, extras);
  const triage = buildReviewFindingTriage(normalizedSummary, extras);
  return {
    recordVersion: KIRA_REVIEW_RECORD_VERSION,
    id: `${workId}-${attemptNo}`,
    workId,
    attemptNo,
    approved: normalizedSummary.approved,
    createdAt: Date.now(),
    summary: normalizedSummary.summary,
    findings: normalizedSummary.findings,
    missingValidation: normalizedSummary.missingValidation,
    nextWorkerInstructions: normalizedSummary.nextWorkerInstructions,
    residualRisk: normalizedSummary.residualRisk,
    filesChecked: normalizedSummary.filesChecked,
    evidenceChecked: normalizedSummary.evidenceChecked,
    requirementVerdicts: normalizedSummary.requirementVerdicts,
    adversarialChecks: normalizedSummary.adversarialChecks,
    reviewerDiscourse: normalizedSummary.reviewerDiscourse,
    triage,
    ...(extras.diffCoverage ? { diffCoverage: extras.diffCoverage } : {}),
    ...(extras.reviewAdversarialPlan
      ? { reviewAdversarialPlan: extras.reviewAdversarialPlan }
      : {}),
    ...(extras.attemptSynthesis ? { attemptSynthesis: extras.attemptSynthesis } : {}),
    ...(extras.observability ? { observability: extras.observability } : {}),
  };
}

function ensureReviewerDiscourse(
  summary: ReviewSummary,
  evidence?: {
    reviewAdversarialPlan?: ReviewAdversarialPlan;
  },
): ReviewSummary {
  if (summary.reviewerDiscourse.length > 0) return summary;
  const fromChecks = summary.adversarialChecks.slice(0, 4).map((check): ReviewerDiscourseEntry => {
    const challenge = check.result === 'failed';
    return {
      role: check.mode,
      position: challenge ? 'challenge' : 'support',
      argument:
        check.concern ||
        `${check.mode} review ${check.result === 'passed' ? 'found no blocking issue' : 'needs attention'}.`,
      evidence: check.evidence,
      ...(challenge ? {} : { response: 'No blocking issue remained for this mode.' }),
    };
  });
  const fallbackMode = evidence?.reviewAdversarialPlan?.modes[0] ?? 'correctness';
  const discourse =
    fromChecks.length > 0
      ? fromChecks
      : [
          {
            role: fallbackMode,
            position: summary.approved ? 'resolved' : 'challenge',
            argument: summary.approved
              ? 'Reviewer found the implementation acceptable after checking the required evidence.'
              : 'Reviewer could not approve because blocking evidence was missing or incomplete.',
            evidence: summary.evidenceChecked.map(
              (item) => `${item.method} ${item.file}: ${item.reason}`,
            ),
            ...(summary.approved ? { response: summary.summary } : {}),
          } satisfies ReviewerDiscourseEntry,
        ];
  return {
    ...summary,
    reviewerDiscourse: discourse,
  };
}

export function enforceReviewDecision(
  summary: ReviewSummary,
  evidence?: {
    workerSummary?: WorkerSummary;
    validationReruns?: ValidationRerunSummary;
    validationPlan?: ResolvedValidationPlan;
    diffExcerpts?: string[];
    requiredInstructions?: string;
    riskPolicy?: RiskReviewPolicy;
    requirementTrace?: RequirementTraceItem[];
    runtimeValidation?: RuntimeValidationResult;
    reviewAdversarialPlan?: ReviewAdversarialPlan;
    patchIntentVerification?: PatchIntentVerification;
    designReviewGate?: DesignReviewGate;
  },
): ReviewSummary {
  summary = ensureReviewerDiscourse(summary, evidence);
  const blockingIssues = [
    ...summary.findings.map((finding) =>
      [finding.file, finding.line ? `line ${finding.line}` : '', finding.message]
        .filter(Boolean)
        .join(': '),
    ),
    ...summary.missingValidation.map((command) => `Missing validation: ${command}`),
  ];
  const changedFiles = normalizePathList(evidence?.workerSummary?.filesChanged ?? [], 200);
  const filesChecked = normalizePathList(summary.filesChecked, 200);
  const evidenceChecked = summary.evidenceChecked;
  const riskPolicy = evidence?.riskPolicy;
  const diffCoverage = buildDiffReviewCoverage({
    workerSummary: evidence?.workerSummary,
    reviewSummary: summary,
    diffExcerpts: evidence?.diffExcerpts,
  });
  if (summary.approved && evidence?.validationReruns?.failed.length) {
    blockingIssues.push(
      `Reviewer approved despite failed Kira validation reruns: ${evidence.validationReruns.failed.join(', ')}`,
    );
  }
  if (
    summary.approved &&
    changedFiles.length > 0 &&
    !isDocumentationOnlyChange(changedFiles) &&
    (evidence?.validationPlan?.effectiveCommands.length ?? 0) === 0
  ) {
    blockingIssues.push(
      'Reviewer approved non-documentation changes even though Kira had no effective validation command.',
    );
  }
  if (summary.approved && changedFiles.length > 0 && (evidence?.diffExcerpts?.length ?? 0) > 0) {
    if (filesChecked.length === 0) {
      blockingIssues.push(
        'Reviewer approved without recording filesChecked for the changed files.',
      );
    } else {
      const uncheckedFiles = changedFiles
        .slice(0, 8)
        .filter((file) => !pathMatchesScope(filesChecked, file));
      if (uncheckedFiles.length > 0) {
        blockingIssues.push(
          `Reviewer filesChecked did not cover changed files: ${uncheckedFiles.join(', ')}`,
        );
      }
    }
  }
  if (
    summary.approved &&
    evidence?.workerSummary &&
    changedFiles.length > 0 &&
    (!evidence.workerSummary.selfCheck ||
      evidence.workerSummary.selfCheck.diffHunkReview.length === 0)
  ) {
    blockingIssues.push('Reviewer approved an attempt without worker diffHunkReview evidence.');
  }
  if (
    summary.approved &&
    evidence?.requiredInstructions?.trim() &&
    evidence.workerSummary?.selfCheck &&
    !evidence.workerSummary.selfCheck.followedProjectInstructions
  ) {
    blockingIssues.push(
      'Reviewer approved even though worker self-check did not confirm mandatory project instructions.',
    );
  }
  if (summary.approved && evidenceChecked.length < (riskPolicy?.evidenceMinimum ?? 1)) {
    blockingIssues.push(
      `Reviewer approved with insufficient evidenceChecked entries for ${riskPolicy?.level ?? 'low'} risk review: ${evidenceChecked.length}/${riskPolicy?.evidenceMinimum ?? 1}.`,
    );
  }
  if (
    summary.approved &&
    changedFiles.length > 0 &&
    evidenceChecked.length > 0 &&
    changedFiles.slice(0, 8).some(
      (file) =>
        !pathMatchesScope(
          evidenceChecked.map((item) => item.file),
          file,
        ),
    )
  ) {
    const uncheckedEvidenceFiles = changedFiles.slice(0, 8).filter(
      (file) =>
        !pathMatchesScope(
          evidenceChecked.map((item) => item.file),
          file,
        ),
    );
    blockingIssues.push(
      `Reviewer evidenceChecked did not cover changed files: ${uncheckedEvidenceFiles.join(', ')}`,
    );
  }
  if (
    summary.approved &&
    (evidence?.requirementTrace?.length ?? 0) > 0 &&
    summary.requirementVerdicts.length === 0
  ) {
    blockingIssues.push('Reviewer approved without requirementVerdicts for the requirement trace.');
  }
  if (
    summary.approved &&
    (evidence?.requirementTrace?.length ?? 0) > 0 &&
    summary.requirementVerdicts.length > 0
  ) {
    blockingIssues.push(
      ...collectIncompleteRequirementTraceIssues(summary.requirementVerdicts, 'Reviewer'),
      ...collectMissingRequirementTraceIds(
        evidence?.requirementTrace ?? [],
        summary.requirementVerdicts,
        'Reviewer',
      ),
    );
  }
  if (
    summary.approved &&
    riskPolicy?.requiresRuntimeValidation &&
    evidence?.runtimeValidation?.serverDetected &&
    evidence.runtimeValidation.status !== 'reachable'
  ) {
    blockingIssues.push(
      'Reviewer approved despite failed runtime validation on a detected dev server.',
    );
  }
  if (summary.approved && evidence?.patchIntentVerification?.status === 'drift') {
    blockingIssues.push(
      `Reviewer approved despite patch intent drift: ${evidence.patchIntentVerification.issues.join('; ')}`,
    );
  }
  if (summary.approved && evidence?.designReviewGate?.status === 'blocked') {
    blockingIssues.push(
      `Reviewer approved despite a blocked design review gate: ${evidence.designReviewGate.requiredChanges.join('; ')}`,
    );
  }
  if (summary.approved && (evidence?.reviewAdversarialPlan?.modes.length ?? 0) > 0) {
    const expectedModes = evidence?.reviewAdversarialPlan?.modes ?? [];
    const checkedModes = new Set(summary.adversarialChecks.map((item) => item.mode));
    const missingModes = expectedModes.filter((mode) => !checkedModes.has(mode));
    if (missingModes.length > 0) {
      blockingIssues.push(
        `Reviewer approved without adversarialChecks for modes: ${missingModes.join(', ')}`,
      );
    }
    const failedModes = summary.adversarialChecks.filter(
      (item) => item.result === 'failed' || item.evidence.length === 0,
    );
    if (failedModes.length > 0) {
      blockingIssues.push(
        `Reviewer adversarialChecks were not passing/evidenced: ${failedModes
          .map((item) => item.mode)
          .join(', ')}`,
      );
    }
    if (summary.reviewerDiscourse.length === 0) {
      blockingIssues.push(
        'Reviewer approved without reviewerDiscourse for the adversarial review modes.',
      );
    }
  }
  if (
    summary.approved &&
    summary.reviewerDiscourse.some(
      (entry) => entry.position === 'challenge' && !entry.response?.trim(),
    )
  ) {
    blockingIssues.push('Reviewer approved with unresolved reviewerDiscourse challenge entries.');
  }
  if (summary.approved && riskPolicy?.requiresSecondPass && summary.evidenceChecked.length < 3) {
    blockingIssues.push(
      'Reviewer approved a high-risk task without enough independent evidence for the required second-pass review.',
    );
  }
  if (summary.approved && diffCoverage.issues.length > 0) {
    blockingIssues.push(...diffCoverage.issues);
  }
  if (summary.approved && blockingIssues.length > 0) {
    return {
      ...summary,
      approved: false,
      issues: uniqueStrings([...summary.issues, ...blockingIssues]),
      summary: `${summary.summary}\n\nKira changed this review to request changes because the structured review included blocking findings or missing validation.`,
    };
  }
  return summary;
}

function buildAttemptObservability(params: {
  status: KiraAttemptRecord['status'];
  startedAt: number;
  finishedAt: number;
  planningState: WorkerAttemptState;
  attemptState: WorkerAttemptState | null;
  workerSummary?: WorkerSummary;
  validationReruns?: ValidationRerunSummary;
  diffStats?: DiffStats;
  failureAnalysis?: FailureAnalysis[];
  runtimeValidation?: RuntimeValidationResult;
  patchIntentVerification?: PatchIntentVerification;
  rawWorkerOutput?: string;
  risks?: string[];
}): KiraAttemptObservability {
  const attemptState = params.attemptState ?? null;
  const validationReruns = params.validationReruns ?? {
    passed: [],
    failed: [],
    failureDetails: [],
  };
  const diffStats = params.diffStats ?? { files: 0, additions: 0, deletions: 0, hunks: 0 };
  const changedFiles = params.workerSummary?.filesChanged ?? [];
  const notes = uniqueStrings([
    ...(params.risks ?? []),
    ...(validationReruns.failed.length > 0
      ? [`Validation failed: ${validationReruns.failed.join(', ')}`]
      : []),
    ...(params.failureAnalysis ?? []).map((item) => `Failure ${item.category}: ${item.summary}`),
    ...(params.runtimeValidation?.applicable
      ? [
          params.runtimeValidation.serverDetected
            ? `Runtime validation reachable at ${params.runtimeValidation.url}`
            : 'Runtime validation applicable but no running dev server was detected.',
        ]
      : []),
    ...(params.patchIntentVerification
      ? [
          `Patch intent ${params.patchIntentVerification.status}: ${params.patchIntentVerification.issues.join('; ') || 'aligned'}`,
        ]
      : []),
    ...(diffStats.files > SMALL_PATCH_FILE_LIMIT ||
    diffStats.additions + diffStats.deletions > SMALL_PATCH_LINE_LIMIT
      ? ['Small-patch policy needs attention for this attempt.']
      : []),
  ]).slice(0, 12);

  return {
    stage: params.status,
    metrics: {
      preflightExplorationCount: uniqueStrings(params.planningState.explorationActions).length,
      readFileCount: attemptState ? attemptState.readFiles.size : 0,
      patchedFileCount: attemptState ? attemptState.patchedFiles.size : 0,
      changedFileCount: changedFiles.length,
      commandRunCount: attemptState
        ? uniqueStrings(attemptState.commandsRun).length
        : uniqueStrings(params.planningState.commandsRun).length,
      validationPassedCount: validationReruns.passed.length,
      validationFailedCount: validationReruns.failed.length,
      diffFileCount: diffStats.files,
      diffAdditions: diffStats.additions,
      diffDeletions: diffStats.deletions,
      diffHunks: diffStats.hunks,
      durationMs: Math.max(0, params.finishedAt - params.startedAt),
      evidenceSignalCount:
        validationReruns.passed.length +
        validationReruns.failed.length +
        (params.diffStats?.files ?? 0) +
        (params.runtimeValidation?.evidence.length ?? 0) +
        (params.patchIntentVerification?.evidence.length ?? 0),
      estimatedWorkerOutputTokens: estimateTokenCount(
        params.rawWorkerOutput ?? params.workerSummary?.summary ?? '',
      ),
    },
    timeline: [
      `started ${new Date(params.startedAt).toISOString()}`,
      `finished ${new Date(params.finishedAt).toISOString()}`,
      `stage ${params.status}`,
      `exploration ${uniqueStrings(params.planningState.explorationActions).length}`,
      `changedFiles ${changedFiles.length}`,
      `validation ${validationReruns.passed.length} passed / ${validationReruns.failed.length} failed`,
    ],
    notes,
  };
}

function buildAttemptRecord(params: {
  workId: string;
  attemptNo: number;
  status: KiraAttemptRecord['status'];
  startedAt: number;
  contextScan: ProjectContextScan;
  workerPlan: WorkerExecutionPlan;
  planningState: WorkerAttemptState;
  attemptState?: WorkerAttemptState | null;
  workerSummary?: WorkerSummary;
  validationPlan?: ResolvedValidationPlan;
  validationReruns?: ValidationRerunSummary;
  diffStats?: DiffStats;
  failureAnalysis?: FailureAnalysis[];
  runtimeValidation?: RuntimeValidationResult;
  riskPolicy?: RiskReviewPolicy;
  patchIntentVerification?: PatchIntentVerification;
  outOfPlanFiles?: string[];
  validationGaps?: string[];
  risks?: string[];
  diffExcerpts?: string[];
  rawWorkerOutput?: string;
  blockedReason?: string;
  rollbackFiles?: string[];
  reviewSummary?: ReviewSummary;
  integration?: KiraIntegrationRecord;
}): KiraAttemptRecord {
  const attemptState = params.attemptState ?? null;
  const finishedAt = Date.now();
  const evidenceLedger = buildEvidenceLedger({
    contextScan: params.contextScan,
    workerPlan: params.workerPlan,
    workerSummary: params.workerSummary,
    validationReruns: params.validationReruns,
    diffStats: params.diffStats,
    runtimeValidation: params.runtimeValidation,
    patchIntentVerification: params.patchIntentVerification,
    designReviewGate: params.contextScan.designReviewGate,
    reviewSummary: params.reviewSummary,
    riskPolicy: params.riskPolicy,
  });
  return {
    recordVersion: KIRA_ATTEMPT_RECORD_VERSION,
    id: `${params.workId}-${params.attemptNo}`,
    workId: params.workId,
    attemptNo: params.attemptNo,
    status: params.status,
    startedAt: params.startedAt,
    finishedAt,
    contextScan: params.contextScan,
    workerPlan: params.workerPlan,
    preflightExploration: uniqueStrings(params.planningState.explorationActions),
    readFiles: attemptState ? [...attemptState.readFiles].sort() : [],
    patchedFiles: attemptState ? [...attemptState.patchedFiles].sort() : [],
    changedFiles: params.workerSummary?.filesChanged ?? [],
    commandsRun: attemptState
      ? [...attemptState.commandsRun]
      : uniqueStrings(params.planningState.commandsRun),
    validationReruns: params.validationReruns ?? { passed: [], failed: [], failureDetails: [] },
    outOfPlanFiles: params.outOfPlanFiles ?? [],
    validationGaps: params.validationGaps ?? [],
    risks: params.risks ?? [],
    ...(params.workerPlan.changeDesign ? { changeDesign: params.workerPlan.changeDesign } : {}),
    ...(params.workerSummary?.selfCheck?.diffHunkReview
      ? { diffHunkReview: params.workerSummary.selfCheck.diffHunkReview }
      : {}),
    ...(params.validationPlan ? { validationPlan: params.validationPlan } : {}),
    ...(params.diffStats ? { diffStats: params.diffStats } : {}),
    ...(params.failureAnalysis ? { failureAnalysis: params.failureAnalysis } : {}),
    ...(params.runtimeValidation ? { runtimeValidation: params.runtimeValidation } : {}),
    ...(params.riskPolicy ? { riskPolicy: params.riskPolicy } : {}),
    ...(params.contextScan.semanticGraph
      ? { semanticGraph: params.contextScan.semanticGraph }
      : {}),
    ...(params.contextScan.testImpact ? { testImpact: params.contextScan.testImpact } : {}),
    ...(params.contextScan.reviewAdversarialPlan
      ? { reviewAdversarialPlan: params.contextScan.reviewAdversarialPlan }
      : {}),
    ...(params.contextScan.clarificationGate
      ? { clarificationGate: params.contextScan.clarificationGate }
      : {}),
    ...(params.contextScan.reviewerCalibration
      ? { reviewerCalibration: params.contextScan.reviewerCalibration }
      : {}),
    ...(params.contextScan.designReviewGate
      ? { designReviewGate: params.contextScan.designReviewGate }
      : {}),
    ...(params.contextScan.orchestrationPlan
      ? { orchestrationPlan: params.contextScan.orchestrationPlan }
      : {}),
    evidenceLedger,
    ...(params.integration ? { integration: params.integration } : {}),
    ...(params.patchIntentVerification
      ? { patchIntentVerification: params.patchIntentVerification }
      : {}),
    requirementTrace: params.workerSummary?.selfCheck?.requirementTrace.length
      ? params.workerSummary.selfCheck.requirementTrace
      : params.workerPlan.requirementTrace,
    approachAlternatives: params.workerPlan.approachAlternatives,
    observability: buildAttemptObservability({
      status: params.status,
      startedAt: params.startedAt,
      finishedAt,
      planningState: params.planningState,
      attemptState,
      workerSummary: params.workerSummary,
      validationReruns: params.validationReruns,
      diffStats: params.diffStats,
      failureAnalysis: params.failureAnalysis,
      runtimeValidation: params.runtimeValidation,
      patchIntentVerification: params.patchIntentVerification,
      rawWorkerOutput: params.rawWorkerOutput,
      risks: params.risks,
    }),
    ...(params.diffExcerpts ? { diffExcerpts: params.diffExcerpts } : {}),
    ...(params.rawWorkerOutput !== undefined ? { rawWorkerOutput: params.rawWorkerOutput } : {}),
    ...(params.blockedReason ? { blockedReason: params.blockedReason } : {}),
    ...(params.rollbackFiles ? { rollbackFiles: params.rollbackFiles } : {}),
  };
}

function saveAttemptRecord(
  sessionsDir: string,
  sessionPath: string,
  record: KiraAttemptRecord,
): void {
  writeJsonFile(
    join(getKiraAttemptsDir(sessionsDir, sessionPath), `${record.workId}-${record.attemptNo}.json`),
    migrateAttemptRecord(record),
  );
}

function saveReviewRecord(
  sessionsDir: string,
  sessionPath: string,
  record: KiraReviewRecord,
): void {
  writeJsonFile(
    join(getKiraReviewsDir(sessionsDir, sessionPath), `${record.workId}-${record.attemptNo}.json`),
    migrateReviewRecord(record),
  );
}

export function buildIssueSignature(issues: string[], summary: string): string {
  const normalized = (issues.length > 0 ? issues : [summary])
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return normalized.join(' | ');
}

export function resolveUnexpectedAutomationFailure(
  workTitle: string,
  errorMessage: string,
): AutomationFailureResolution {
  const normalizedMessage = errorMessage.trim() || 'Unknown automation error.';
  const missingCredentialFailure =
    /\bapi key\b/i.test(normalizedMessage) ||
    /\brequired api keys?\b/i.test(normalizedMessage) ||
    /\bcredentials?\b/i.test(normalizedMessage) ||
    /\btoken\b/i.test(normalizedMessage);

  if (missingCredentialFailure) {
    return {
      summary:
        'Automation blocked because the task depends on missing API keys or external credentials.',
      guidance:
        'Add the required API keys or credentials in the target project, or revise the work so that startup generation and other credential-gated steps are not required before retrying.',
      userMessage: `Kira blocked: "${workTitle}" 작업은 필요한 API 키 또는 외부 인증 정보가 없어 자동으로 멈췄어요.`,
    };
  }

  return {
    summary:
      'Automation failed unexpectedly, and Kira blocked the task to avoid repeating the same failure.',
    guidance:
      'Inspect the underlying error, fix the project or task brief, and then manually move the work out of Blocked before retrying.',
    userMessage: `Kira blocked: "${workTitle}" 작업이 예기치 않은 오류로 중단되어 같은 실패를 반복하지 않도록 멈췄어요.`,
  };
}

async function autoCommitApprovedWork(
  workspace: KiraWorkspaceSession,
  filesChanged: string[],
  commitMessage: string,
  defaultProjectSettings: Partial<KiraProjectSettings> = {},
  integrationLockPath?: string,
): Promise<{ status: 'committed' | 'skipped' | 'failed'; message: string; commitHash?: string }> {
  const projectRoot = workspace.projectRoot;
  const projectSettings = loadProjectSettings(workspace.primaryRoot, defaultProjectSettings);
  if (!projectSettings.autoCommit) {
    return { status: 'skipped', message: 'Project settings disabled auto-commit.' };
  }

  const normalizedFiles = normalizePathList(filesChanged, 200);
  if (normalizedFiles.length === 0) {
    return { status: 'skipped', message: 'No changed files were reported for this work.' };
  }

  try {
    await runGitCommand(projectRoot, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { status: 'skipped', message: 'Project root is not a git repository.' };
  }

  let projectLocalFiles: string[] = [];
  try {
    projectLocalFiles = normalizedFiles
      .map((filePath) => ensureInsideRoot(projectRoot, filePath))
      .map((absolutePath) =>
        absolutePath
          .slice(resolve(projectRoot).length)
          .replace(/^[\\/]+/, '')
          .replace(/\\/g, '/'),
      )
      .filter(Boolean);
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const { targetFiles, ignoredFiles } = filterStageableChangedFiles(
    projectLocalFiles,
    await getGitWorktreeEntries(projectRoot),
  );
  if (targetFiles.length === 0) {
    return {
      status: 'skipped',
      message: `No stageable project-local files were eligible for auto-commit.${formatIgnoredIntegrationPaths(
        ignoredFiles,
      )}`,
    };
  }

  const preStaged = await runGitCommand(projectRoot, ['diff', '--cached', '--name-only']);
  if (preStaged.trim()) {
    return {
      status: 'skipped',
      message: 'Auto-commit was skipped because unrelated staged changes were already present.',
    };
  }

  try {
    await runGitCommand(projectRoot, ['add', '--', ...targetFiles]);
    const staged = await runGitCommand(projectRoot, ['diff', '--cached', '--name-only']);
    if (!staged.trim()) {
      return {
        status: 'skipped',
        message: 'There were no stageable changes for the reported files.',
      };
    }

    await runGitCommand(projectRoot, ['commit', '-m', commitMessage]);
    const commitHash = await runGitCommand(projectRoot, ['rev-parse', '--short', 'HEAD']);

    if (workspace.isolated) {
      const integrationOwner = `${SERVER_INSTANCE_ID}:${commitHash}:${Date.now()}`;
      if (
        integrationLockPath &&
        !tryAcquireLock(integrationLockPath, {
          ownerId: integrationOwner,
          resource: 'project',
          sessionPath: 'git-integration',
          targetKey: workspace.primaryRoot,
        })
      ) {
        return {
          status: 'failed',
          message:
            'Auto-commit created an isolated worktree commit, but could not acquire the project integration lock. The Kira worktree was kept for manual recovery.',
          commitHash: commitHash || undefined,
        };
      }

      try {
        const primaryStaged = await runGitCommand(workspace.primaryRoot, [
          'diff',
          '--cached',
          '--name-only',
        ]);
        if (primaryStaged.trim()) {
          return {
            status: 'failed',
            message:
              'Auto-commit created an isolated worktree commit, but integration was stopped because the primary worktree already has staged changes.',
            commitHash: commitHash || undefined,
          };
        }

        const primaryDirtyEntries = await getGitWorktreeEntries(workspace.primaryRoot);
        const primaryDirtyFiles = getDirtyWorktreePaths(primaryDirtyEntries);
        const conflictingDirtyFiles = targetFiles.filter((filePath) =>
          primaryDirtyFiles.includes(filePath),
        );
        if (conflictingDirtyFiles.length > 0) {
          return {
            status: 'failed',
            message: [
              'Auto-commit created an isolated worktree commit, but integration was stopped because the primary worktree has overlapping dirty files.',
              `Conflicting files: ${conflictingDirtyFiles.join(', ')}`,
              'The Kira worktree was kept for manual recovery.',
            ].join(' '),
            commitHash: commitHash || undefined,
          };
        }

        try {
          await runGitCommand(workspace.primaryRoot, ['cherry-pick', commitHash]);
        } catch (error) {
          try {
            await runGitCommand(workspace.primaryRoot, ['cherry-pick', '--abort']);
          } catch {
            // If abort fails, report the original cherry-pick failure below.
          }
          return {
            status: 'failed',
            message: [
              'Auto-commit created an isolated worktree commit, but cherry-pick integration failed.',
              error instanceof Error ? error.message : String(error),
              'The Kira worktree was kept for manual conflict recovery.',
            ].join('\n\n'),
            commitHash: commitHash || undefined,
          };
        }
      } finally {
        if (integrationLockPath) {
          releaseLock(integrationLockPath, integrationOwner);
        }
      }
    }

    return {
      status: 'committed',
      message: workspace.isolated
        ? `Committed in an isolated Kira worktree and integrated into the primary worktree as ${commitHash}.${formatIgnoredIntegrationPaths(
            ignoredFiles,
          )}`
        : `Committed the approved changes as ${commitHash}.${formatIgnoredIntegrationPaths(
            ignoredFiles,
          )}`,
      commitHash: commitHash || undefined,
    };
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runGhCommand(
  projectRoot: string,
  args: string[],
): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await execFileAsync('gh', args, {
      cwd: projectRoot,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
  } catch (error) {
    const stdout =
      error && typeof error === 'object' && 'stdout' in error ? String(error.stdout ?? '') : '';
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '') : '';
    return {
      ok: false,
      output: truncateForReview(
        [stdout, stderr, error instanceof Error ? error.message : String(error)]
          .filter(Boolean)
          .join('\n'),
        1200,
      ),
    };
  }
}

function isProtectedGitHubBaseBranch(branch: string): boolean {
  return /^(main|master|trunk|production|prod|release)$/i.test(branch.trim());
}

function isSafeGitHubHeadBranch(branch: string): boolean {
  return /^[A-Za-z0-9._/-]{1,180}$/.test(branch) && !branch.includes('..');
}

function buildKiraPullRequestBody(work: WorkTask, commitHash?: string): string {
  return [
    `Kira work: ${work.title}`,
    '',
    work.description.slice(0, 4000),
    '',
    commitHash ? `Commit: ${commitHash}` : 'Commit: unavailable',
    '',
    'Generated by Kira automation after reviewer approval.',
  ].join('\n');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function collectGitHubCheckEvidence(
  projectRoot: string,
  attempts = 3,
): Promise<{ checks: string[]; evidence: string[] }> {
  const checks: string[] = [];
  const evidence: string[] = [];
  for (let index = 0; index < attempts; index += 1) {
    const result = await runGhCommand(projectRoot, ['pr', 'checks', '--json', 'name,state,link']);
    evidence.push(result.output);
    if (result.ok) {
      checks.push(truncateForReview(result.output, 1200));
      break;
    }
    if (/no checks|not found|no pull request/i.test(result.output)) {
      break;
    }
    await delay(750);
  }
  return { checks, evidence };
}

async function collectConnectorIntegrationEvidence(params: {
  projectRoot: string;
  work: WorkTask;
  commitMessage: string;
  commitHash?: string;
  connectors?: KiraPluginConnector[];
}): Promise<KiraConnectorEvidence[]> {
  const enabledConnectors = normalizePluginConnectors(params.connectors).filter(
    (connector) => connector.enabled,
  );
  const evidence: KiraConnectorEvidence[] = [];
  for (const connector of enabledConnectors) {
    if (connector.type !== 'github') {
      evidence.push({
        connectorId: connector.id,
        status: connector.policy === 'apply' ? 'suggested' : 'observed',
        summary: `${connector.label} connector is declared but no local adapter is available for type ${connector.type}.`,
        checks: [],
        evidence: [`Capabilities: ${formatInlineList(connector.capabilities)}`],
      });
      continue;
    }

    const ghVersion = await runGhCommand(params.projectRoot, ['--version']);
    if (!ghVersion.ok) {
      evidence.push({
        connectorId: connector.id,
        status: 'skipped',
        summary: 'GitHub connector skipped because the gh CLI is not available.',
        checks: [],
        evidence: [ghVersion.output],
      });
      continue;
    }

    const authStatus = await runGhCommand(params.projectRoot, ['auth', 'status']);
    if (!authStatus.ok) {
      evidence.push({
        connectorId: connector.id,
        status: 'skipped',
        summary: 'GitHub connector skipped because gh is not authenticated for this repository.',
        checks: [],
        evidence: [ghVersion.output, authStatus.output],
      });
      continue;
    }

    const branch = await runGitCommand(params.projectRoot, ['branch', '--show-current'])
      .then((output) => output.trim())
      .catch(() => '');
    const remote = await runGitCommand(params.projectRoot, ['remote', 'get-url', 'origin']).catch(
      () => '',
    );
    const connectorEvidence = [
      `gh: ${ghVersion.output.split(/\r?\n/)[0] ?? 'available'}`,
      `auth: ${authStatus.output.split(/\r?\n/)[0] ?? 'available'}`,
      `branch: ${branch || 'unknown'}`,
      `origin: ${remote || 'missing'}`,
      ...(params.commitHash ? [`commit: ${params.commitHash}`] : []),
    ];
    if (connector.policy !== 'apply' || !params.commitHash) {
      evidence.push({
        connectorId: connector.id,
        status: connector.policy === 'apply' ? 'skipped' : 'observed',
        summary:
          connector.policy === 'apply'
            ? 'GitHub PR creation skipped because no commit hash was available.'
            : 'GitHub connector observed local repository metadata.',
        checks: [],
        evidence: connectorEvidence,
      });
      continue;
    }

    if (!remote.trim()) {
      evidence.push({
        connectorId: connector.id,
        status: 'skipped',
        summary: 'GitHub PR creation skipped because origin remote is missing.',
        checks: [],
        evidence: connectorEvidence,
      });
      continue;
    }

    if (!branch || isProtectedGitHubBaseBranch(branch)) {
      evidence.push({
        connectorId: connector.id,
        status: 'suggested',
        summary:
          'GitHub PR creation was not attempted from a protected base branch; create a feature branch first.',
        checks: [],
        evidence: connectorEvidence,
      });
      continue;
    }

    if (!isSafeGitHubHeadBranch(branch)) {
      evidence.push({
        connectorId: connector.id,
        status: 'skipped',
        summary:
          'GitHub PR creation skipped because the current branch name is not safe for automation.',
        checks: [],
        evidence: connectorEvidence,
      });
      continue;
    }

    const existingPr = await runGhCommand(params.projectRoot, [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'url,title,isDraft,headRefName',
      '--limit',
      '1',
    ]);
    const existingPrUrl = /https?:\/\/\S+/.exec(existingPr.output)?.[0];
    if (existingPr.ok && existingPrUrl) {
      const checkEvidence = await collectGitHubCheckEvidence(params.projectRoot, 2);
      evidence.push({
        connectorId: connector.id,
        status: 'observed',
        summary: 'GitHub connector found an existing open PR for the current branch.',
        url: existingPrUrl,
        checks: checkEvidence.checks,
        evidence: [...connectorEvidence, existingPr.output, ...checkEvidence.evidence],
      });
      continue;
    }

    const push = await runGitCommand(params.projectRoot, ['push', '-u', 'origin', branch]).then(
      (output) => ({ ok: true, output }),
      (error) => ({ ok: false, output: error instanceof Error ? error.message : String(error) }),
    );
    if (!push.ok) {
      evidence.push({
        connectorId: connector.id,
        status: 'failed',
        summary: 'GitHub connector could not push the integration branch.',
        checks: [],
        evidence: [...connectorEvidence, push.output],
      });
      continue;
    }

    const prTitle = params.commitMessage.split(/\r?\n/)[0] || params.work.title;
    const prBody = buildKiraPullRequestBody(params.work, params.commitHash);
    const pr = await runGhCommand(params.projectRoot, [
      'pr',
      'create',
      '--draft',
      '--title',
      prTitle,
      '--body',
      prBody,
    ]);
    const prUrl = /https?:\/\/\S+/.exec(pr.output)?.[0];
    const checkEvidence = pr.ok
      ? await collectGitHubCheckEvidence(params.projectRoot)
      : { checks: [], evidence: [] };
    evidence.push({
      connectorId: connector.id,
      status: pr.ok ? 'applied' : 'failed',
      summary: pr.ok
        ? 'GitHub draft PR created for the approved Kira work.'
        : 'GitHub draft PR creation failed.',
      ...(prUrl ? { url: prUrl } : {}),
      checks: checkEvidence.checks,
      evidence: [...connectorEvidence, push.output, pr.output, ...checkEvidence.evidence],
    });
  }
  return evidence;
}

function updateAttemptRecordIntegration(
  sessionsDir: string,
  sessionPath: string,
  workId: string,
  attemptNo: number,
  integration: KiraIntegrationRecord,
): void {
  const attemptPath = join(
    getKiraAttemptsDir(sessionsDir, sessionPath),
    `${workId}-${attemptNo}.json`,
  );
  const current = readJsonFile<KiraAttemptRecord>(attemptPath);
  if (!current) return;
  writeJsonFile(attemptPath, migrateAttemptRecord({ ...current, integration }));
}

function migrateAttemptRecord(record: KiraAttemptRecord): KiraAttemptRecord {
  const previousVersion =
    typeof record.recordVersion === 'number' && Number.isFinite(record.recordVersion)
      ? Math.max(1, Math.round(record.recordVersion))
      : 1;
  return {
    ...record,
    recordVersion: KIRA_ATTEMPT_RECORD_VERSION,
    ...(previousVersion < KIRA_ATTEMPT_RECORD_VERSION
      ? { migratedFromVersion: previousVersion }
      : record.migratedFromVersion
        ? { migratedFromVersion: record.migratedFromVersion }
        : {}),
    ...(record.evidenceLedger
      ? { evidenceLedger: record.evidenceLedger }
      : record.contextScan && record.workerPlan
        ? {
            evidenceLedger: buildEvidenceLedger({
              contextScan: record.contextScan,
              workerPlan: record.workerPlan,
              validationReruns: record.validationReruns,
              diffStats: record.diffStats,
              runtimeValidation: record.runtimeValidation,
              patchIntentVerification: record.patchIntentVerification,
              designReviewGate: record.designReviewGate,
              riskPolicy: record.riskPolicy,
            }),
          }
        : {}),
    validationReruns: record.validationReruns ?? { passed: [], failed: [], failureDetails: [] },
    outOfPlanFiles: record.outOfPlanFiles ?? [],
    validationGaps: record.validationGaps ?? [],
    risks: record.risks ?? [],
  };
}

function migrateReviewRecord(record: KiraReviewRecord): KiraReviewRecord {
  const previousVersion =
    typeof record.recordVersion === 'number' && Number.isFinite(record.recordVersion)
      ? Math.max(1, Math.round(record.recordVersion))
      : 1;
  return {
    ...record,
    recordVersion: KIRA_REVIEW_RECORD_VERSION,
    ...(previousVersion < KIRA_REVIEW_RECORD_VERSION
      ? { migratedFromVersion: previousVersion }
      : record.migratedFromVersion
        ? { migratedFromVersion: record.migratedFromVersion }
        : {}),
    filesChecked: record.filesChecked ?? [],
    evidenceChecked: record.evidenceChecked ?? [],
    requirementVerdicts: record.requirementVerdicts ?? [],
    adversarialChecks: record.adversarialChecks ?? [],
  };
}

async function ensurePrimaryWorktreeCanIntegrate(
  workspace: KiraWorkspaceSession,
  targetFiles: string[],
): Promise<string | null> {
  const primaryStaged = await runGitCommand(workspace.primaryRoot, [
    'diff',
    '--cached',
    '--name-only',
  ]);
  if (primaryStaged.trim()) {
    return 'Integration stopped because the primary worktree already has staged changes.';
  }

  const primaryDirtyEntries = await getGitWorktreeEntries(workspace.primaryRoot);
  const primaryDirtyFiles = getDirtyWorktreePaths(primaryDirtyEntries);
  const conflictingDirtyFiles = targetFiles.filter((filePath) =>
    primaryDirtyFiles.includes(filePath),
  );
  if (conflictingDirtyFiles.length > 0) {
    return [
      'Integration stopped because the primary worktree has overlapping dirty files.',
      `Conflicting files: ${conflictingDirtyFiles.join(', ')}`,
    ].join(' ');
  }

  return null;
}

async function integrateApprovedWorktreeChanges(
  workspace: KiraWorkspaceSession,
  filesChanged: string[],
  commitMessage: string,
  integrationLockPath?: string,
): Promise<{ status: 'integrated' | 'skipped' | 'failed'; message: string; commitHash?: string }> {
  if (!workspace.isolated) {
    return {
      status: 'skipped',
      message: 'The approved attempt already ran in the primary worktree.',
    };
  }

  const projectLocalFiles = normalizePathList(filesChanged, 200);
  if (projectLocalFiles.length === 0) {
    return { status: 'skipped', message: 'No changed files were reported for integration.' };
  }

  const { targetFiles, ignoredFiles } = filterStageableChangedFiles(
    projectLocalFiles,
    await getGitWorktreeEntries(workspace.projectRoot),
  );
  if (targetFiles.length === 0) {
    return {
      status: 'skipped',
      message: `No stageable changed files were available to integrate.${formatIgnoredIntegrationPaths(
        ignoredFiles,
      )}`,
    };
  }

  const integrationOwner = `${SERVER_INSTANCE_ID}:no-commit:${Date.now()}`;
  if (
    integrationLockPath &&
    !tryAcquireLock(integrationLockPath, {
      ownerId: integrationOwner,
      resource: 'project',
      sessionPath: 'git-integration',
      targetKey: workspace.primaryRoot,
    })
  ) {
    return {
      status: 'failed',
      message:
        'Could not acquire the project integration lock. The winning Kira worktree was kept for manual recovery.',
    };
  }

  try {
    const blocker = await ensurePrimaryWorktreeCanIntegrate(workspace, targetFiles);
    if (blocker) {
      return {
        status: 'failed',
        message: `${blocker} The winning Kira worktree was kept for manual recovery.`,
      };
    }

    await runGitCommand(workspace.projectRoot, ['add', '--', ...targetFiles]);
    const staged = await runGitCommand(workspace.projectRoot, ['diff', '--cached', '--name-only']);
    if (!staged.trim()) {
      return { status: 'skipped', message: 'No staged changes were available to integrate.' };
    }
    await runGitCommand(workspace.projectRoot, ['commit', '-m', commitMessage]);
    const commitHash = await runGitCommand(workspace.projectRoot, ['rev-parse', '--short', 'HEAD']);

    try {
      await runGitCommand(workspace.primaryRoot, ['cherry-pick', '--no-commit', commitHash]);
    } catch (error) {
      try {
        await runGitCommand(workspace.primaryRoot, ['cherry-pick', '--abort']);
      } catch {
        // Preserve the original cherry-pick error below.
      }
      return {
        status: 'failed',
        message: [
          'Cherry-pick integration failed.',
          error instanceof Error ? error.message : String(error),
          'The winning Kira worktree was kept for manual conflict recovery.',
        ].join('\n\n'),
        commitHash: commitHash || undefined,
      };
    }

    return {
      status: 'integrated',
      message: `Integrated the winning isolated attempt into the primary worktree without creating a final commit. Temporary attempt commit: ${commitHash}.${formatIgnoredIntegrationPaths(
        ignoredFiles,
      )}`,
      commitHash: commitHash || undefined,
    };
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (integrationLockPath) {
      releaseLock(integrationLockPath, integrationOwner);
    }
  }
}

function readLockRecord(lockPath: string): AutomationLockRecord | null {
  return readJsonFile<AutomationLockRecord>(lockPath);
}

function isLockStale(lock: AutomationLockRecord): boolean {
  return Date.now() - lock.heartbeatAt >= LOCK_STALE_MS;
}

function writeLockRecord(lockPath: string, record: AutomationLockRecord): void {
  writeJsonFile(lockPath, record);
}

function getErrorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : '';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorPath(error: unknown): string {
  return error instanceof Error && 'path' in error ? String(error.path ?? '') : '';
}

function hasLockErrorSource(error: unknown): boolean {
  const source = `${getErrorMessage(error)}\n${getErrorPath(error)}`;
  return /\b(?:automation-locks|kira-automation-locks|lock)\b/i.test(source);
}

export function isRecoverableAutomationLockMessage(message: string): boolean {
  return (
    /\b(EACCES|EBUSY|EEXIST|ENOENT|ENOTDIR|EPERM)\b/i.test(message) &&
    /\b(?:automation-locks|kira-automation-locks)\b/i.test(message)
  );
}

export function isRecoverableLockError(error: unknown): boolean {
  const code = getErrorCode(error).toUpperCase();
  const message = getErrorMessage(error);
  const hasRecoverableCode =
    Boolean(code) && RECOVERABLE_LOCK_ERROR_CODES.has(code) && hasLockErrorSource(error);
  if (hasRecoverableCode) return true;

  return isRecoverableAutomationLockMessage(`${message}\n${getErrorPath(error)}`);
}

export function tryAcquireLock(
  lockPath: string,
  record: Omit<AutomationLockRecord, 'acquiredAt' | 'heartbeatAt'>,
): boolean {
  const now = Date.now();
  const nextRecord: AutomationLockRecord = {
    ...record,
    acquiredAt: now,
    heartbeatAt: now,
  };

  try {
    fs.mkdirSync(dirname(lockPath), { recursive: true });
  } catch (error) {
    if (isRecoverableLockError(error)) return false;
    throw error;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(nextRecord), 'utf-8');
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (error) {
      const code = getErrorCode(error);
      if (code !== 'EEXIST') {
        if (isRecoverableLockError(error)) return false;
        throw error;
      }

      const existing = readLockRecord(lockPath);
      if (!existing || isLockStale(existing)) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          return false;
        }
        continue;
      }
      return false;
    }
  }

  return false;
}

function refreshLock(lockPath: string, ownerId: string): void {
  try {
    const existing = readLockRecord(lockPath);
    if (!existing || existing.ownerId !== ownerId) return;
    writeLockRecord(lockPath, {
      ...existing,
      heartbeatAt: Date.now(),
    });
  } catch (error) {
    if (!isRecoverableLockError(error)) throw error;
  }
}

function releaseLock(lockPath: string, ownerId: string): void {
  try {
    const existing = readLockRecord(lockPath);
    if (!existing || existing.ownerId !== ownerId) return;
    fs.rmSync(lockPath, { force: true });
  } catch (error) {
    if (!isRecoverableLockError(error)) throw error;
  }
}

function getProjectKey(
  workRootDirectory: string | null,
  work: WorkTask,
  sessionPath: string,
): string {
  if (workRootDirectory?.trim() && work.projectName.trim()) {
    return resolveKiraProjectRoot(workRootDirectory, work.projectName).toLowerCase();
  }

  return `${sanitizeSessionPath(sessionPath)}::${work.projectName.toLowerCase()}`;
}

function buildProjectOverview(projectRoot: string): string {
  const topLevelEntries: string[] = [];
  collectFiles(projectRoot, projectRoot, 1, topLevelEntries);

  const snippets: string[] = [];
  for (const candidate of [
    'README.md',
    'README.ko.md',
    'package.json',
    'requirements.txt',
    'main.py',
  ]) {
    const absolutePath = join(projectRoot, candidate);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
    const content = fs.readFileSync(absolutePath, 'utf-8').slice(0, 2400);
    snippets.push(`File: ${candidate}\n${content}`);
  }

  return [
    `Project root: ${projectRoot}`,
    `Top-level tree:\n${topLevelEntries.join('\n') || '(empty)'}`,
    ...snippets,
  ].join('\n\n');
}

async function collectProjectSafetyIssues(
  projectRoot: string,
  projectSettings?: Pick<
    ResolvedKiraProjectSettings,
    'environment' | 'plugins' | 'executionPolicy' | 'workflow'
  >,
): Promise<string[]> {
  const issues: string[] = [];
  const environment = normalizeEnvironmentContract(projectSettings?.environment);
  const executionPolicy = normalizeExecutionPolicy(projectSettings?.executionPolicy);
  const workflow = normalizeWorkflowDag(projectSettings?.workflow);
  const missingEnv = environment.requiredEnv.filter((name) => !process.env[name]);
  if (missingEnv.length > 0) {
    issues.push(`Missing required environment variables: ${missingEnv.join(', ')}.`);
  }
  if (environment.runner === 'remote-command') {
    if (!environment.remoteCommand || !environment.remoteCommand.includes('{command}')) {
      issues.push(
        'Remote-command runner requires environment.remoteCommand with a {command} placeholder.',
      );
    }
  }
  if (environment.runner === 'cloud') {
    const cloudConnectorEnabled = normalizePluginConnectors(projectSettings?.plugins).some(
      (connector) =>
        connector.enabled &&
        (connector.type === 'custom' || connector.type === 'mcp') &&
        connector.capabilities.some((capability) => /runner|cloud|execute/i.test(capability)),
    );
    if (!cloudConnectorEnabled) {
      issues.push(
        'Cloud runner is declared, but no enabled cloud execution connector is available in local Kira.',
      );
    }
  }
  if (environment.allowedNetwork === 'none' && environment.runner !== 'local') {
    issues.push('Non-local runners require network access, but allowedNetwork is set to none.');
  }
  for (const command of [...environment.setupCommands, environment.devServerCommand].filter(
    Boolean,
  )) {
    const commandIssues = collectEnvironmentCommandIssues(environment, command);
    if (commandIssues.length > 0) {
      issues.push(...commandIssues);
    }
  }
  if (
    executionPolicy.requireValidation &&
    !workflow.nodes.some((node) => node.required && node.kind === 'validate')
  ) {
    issues.push(
      'Execution policy requires validation, but the workflow DAG has no required validate node.',
    );
  }
  if (
    executionPolicy.requireReviewerEvidence &&
    !workflow.nodes.some((node) => node.required && node.kind === 'review')
  ) {
    issues.push(
      'Execution policy requires reviewer evidence, but the workflow DAG has no required review node.',
    );
  }

  const placeholderHits = searchProjectFiles(projectRoot, 'rest of file unchanged')
    .slice(0, 3)
    .map((hit) => `Corruption marker detected: ${hit}`);
  issues.push(...placeholderHits);

  const pythonEntrypoints = ['main.py', 'app.py', 'server.py']
    .map((fileName) => ({ fileName, absolutePath: join(projectRoot, fileName) }))
    .filter(
      (entry) => fs.existsSync(entry.absolutePath) && fs.statSync(entry.absolutePath).isFile(),
    );

  for (const entry of pythonEntrypoints) {
    try {
      await execFileAsync(
        'python',
        [
          '-c',
          [
            'import ast',
            'from pathlib import Path',
            `path = Path(r"""${entry.absolutePath}""")`,
            "ast.parse(path.read_text(encoding='utf-8'))",
          ].join('; '),
        ],
        {
          cwd: projectRoot,
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
    } catch (error) {
      const stderr =
        error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
      const detail = stderr || (error instanceof Error ? error.message : String(error));
      issues.push(`Python AST syntax check failed for ${entry.fileName}: ${detail}`);
      break;
    }
  }

  return issues;
}

function loadProjectDiscoveryAnalysis(
  sessionsDir: string,
  sessionPath: string,
  projectName: string,
): ProjectDiscoveryAnalysis | null {
  return readJsonFile<ProjectDiscoveryAnalysis>(
    getProjectDiscoveryFilePath(sessionsDir, sessionPath, projectName),
  );
}

function saveProjectDiscoveryAnalysis(
  sessionsDir: string,
  sessionPath: string,
  analysis: ProjectDiscoveryAnalysis,
): void {
  writeJsonFile(
    getProjectDiscoveryFilePath(sessionsDir, sessionPath, analysis.projectName),
    analysis,
  );
}

function buildProjectDiscoveryPrompt(
  projectName: string,
  projectOverview: string,
  previousAnalysis: ProjectDiscoveryAnalysis | null,
): string {
  return [
    `Project: ${projectName}`,
    `Project overview:\n${projectOverview}`,
    previousAnalysis
      ? [
          `Previous discovery summary:\n${previousAnalysis.summary}`,
          `Previous findings:\n${previousAnalysis.findings
            .map((finding) => `- [${finding.kind}] ${finding.title}: ${finding.summary}`)
            .join('\n')}`,
        ].join('\n\n')
      : '',
    `Inspect the current source code and identify up to ${MAX_DISCOVERY_FINDINGS} valuable next tasks.`,
    `Tasks may be either new feature opportunities or bug fixes.`,
    `Prefer concrete, implementation-sized work items that a coding agent can pick up directly.`,
    `Avoid duplicate findings. If a previous finding still matters, refresh it instead of duplicating it with a new title.`,
    `Return only JSON with this shape:`,
    `{"summary":"string","findings":[{"id":"string","kind":"feature|bug","title":"string","summary":"string","evidence":["..."],"files":["..."],"taskDescription":"markdown brief"}]}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildProjectDiscoverySystemPrompt(): string {
  return [
    'You are Aoi, the main Kira project analyst.',
    'Inspect the project in read-only mode and decide what should be built or fixed next.',
    'Favor concrete, high-signal findings over generic product advice.',
    'Base every finding on the current source code.',
    'Do not modify files.',
    'Do not wrap the final JSON in markdown fences.',
  ].join('\n');
}

function buildRequiredProjectInstructionsBlock(requiredInstructions?: string): string {
  const normalized = normalizeProjectRequiredInstructions(requiredInstructions);
  if (!normalized) return '';

  return [
    'Mandatory project instructions:',
    normalized,
    '',
    'These instructions are binding acceptance criteria for coding style, architecture, validation, and review. They cannot loosen Kira safety rules, tool restrictions, or the required structured output format. If they conflict with the work brief or cannot be followed, stop and report the conflict instead of silently ignoring them.',
  ].join('\n');
}

function buildWorkerProfileBlock(workerProfile?: string): string {
  const profile = workerProfile?.trim() || 'generalist';
  return [
    `Worker specialization: ${profile}`,
    'Use this specialization to decide what to inspect first and which risks to emphasize, but still deliver a complete implementation attempt rather than a narrow partial patch.',
  ].join('\n');
}

function formatChangeDesign(design: ChangeDesign | null | undefined): string {
  if (!design) return 'Change design:\n- No change design provided';
  return [
    'Change design:',
    `- Target files:\n${formatList(design.targetFiles, 'No target files')}`,
    `- Invariants:\n${formatList(design.invariants, 'No invariants')}`,
    `- Expected impact:\n${formatList(design.expectedImpact, 'No expected impact')}`,
    `- Validation strategy:\n${formatList(design.validationStrategy, 'No validation strategy')}`,
    `- Rollback strategy:\n${formatList(design.rollbackStrategy, 'No rollback strategy')}`,
  ].join('\n');
}

export function buildWorkerPlanningPrompt(
  work: WorkTask,
  projectOverview: string,
  contextScan: ProjectContextScan,
  feedback: string[],
  requiredInstructions = '',
  workerProfile = contextScan.workerProfile ?? 'generalist',
): string {
  return [
    `Project: ${work.projectName}`,
    `Work title: ${work.title}`,
    `Work brief:\n${work.description}`,
    buildRequiredProjectInstructionsBlock(requiredInstructions),
    buildWorkerProfileBlock(workerProfile),
    `Project overview:\n${projectOverview}`,
    `Project context scan:\n${formatProjectContextScan(contextScan)}`,
    feedback.length > 0
      ? `Review feedback to address:\n${feedback.map((item) => `- ${item}`).join('\n')}`
      : '',
    'Inspect the project in read-only mode and create a focused implementation plan before any edits happen.',
    'Do not narrow the acceptance target. A small intendedFiles list limits patch surface only; it is not permission to complete only a convenient subset of the work brief.',
    'Use the context scan as a starting point, but verify relevant files yourself before planning edits.',
    'Call at least one read-only tool such as list_files, search_files, or read_file before returning the final plan.',
    'If likely relevant files are empty or weak, search/read the repository before returning a plan.',
    'Treat existing git changes as user or prior automation work unless inspection proves they are part of this task.',
    'List only the files you currently expect to edit; keep the list small and concrete.',
    'Create changeDesign before implementation: targetFiles, invariants that must stay true, expectedImpact, validationStrategy, and rollbackStrategy.',
    'Use the task playbook to classify taskType and choose inspection, validation, and review focus.',
    'Create requirementTrace using the provided requirement IDs; every acceptance requirement must map to intended evidence or validation.',
    'Compare at least two implementation approaches in approachAlternatives and mark exactly one selected approach.',
    'Use escalation.shouldAsk=true with concrete questions when requirements, data loss risk, authorization boundaries, or architecture tradeoffs cannot be resolved from code inspection.',
    'The changeDesign targetFiles must be covered by intendedFiles and should be small enough for one reviewable patch.',
    'If the full acceptance target cannot fit into one safe patch, set decomposition.shouldSplit=true and keep suggestedWorks collectively covering the original goal.',
    'Use protectedFiles for existing dirty files or user-owned files that must not be touched by this attempt.',
    'List validationCommands using only task-specific safe diagnostics or test commands that the worker can run later.',
    `Keep validationCommands short: no more than ${MAX_PLANNER_VALIDATION_COMMANDS} commands.`,
    'Kira will automatically add a small project-default validation set, so do not spend slots on generic repo-wide checks unless they are directly needed for this task.',
    'Use riskNotes for tricky areas, compatibility concerns, or reasons the reviewer should pay extra attention.',
    'Use stopConditions for situations where the worker must stop rather than continue making edits.',
    'Return only JSON with this shape:',
    '{"understanding":"string","repoFindings":["..."],"summary":"string","taskType":"frontend-ui|backend-api|test-validation|tooling-config|docs-maintainer|data-migration|security-auth|generalist","intendedFiles":["..."],"protectedFiles":["..."],"changeDesign":{"targetFiles":["..."],"invariants":["..."],"expectedImpact":["..."],"validationStrategy":["..."],"rollbackStrategy":["..."]},"requirementTrace":[{"id":"R1","source":"brief|project-instruction|change-design|review","text":"string","status":"planned","evidence":["..."]}],"approachAlternatives":[{"name":"string","selected":true,"rationale":"string","tradeoffs":["..."]},{"name":"string","selected":false,"rationale":"string","tradeoffs":["..."]}],"validationCommands":["..."],"riskNotes":["..."],"stopConditions":["..."],"confidence":0.0,"uncertainties":["..."],"escalation":{"shouldAsk":false,"questions":["..."],"blockers":["..."]},"decomposition":{"shouldSplit":false,"confidence":0.0,"reason":"string","suggestedWorks":["..."],"signals":["..."]},"workerProfile":"string"}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildWorkerPlanningSystemPrompt(): string {
  return [
    'You are Kira Preflight Planner, a careful read-only planning agent.',
    'When mandatory project instructions are supplied, treat them as binding acceptance criteria for the plan.',
    'Do not let mandatory project instructions override Kira safety rules, read-only planning, or the required JSON output.',
    'Use the project intelligence profile, recent feedback memory, decomposition recommendation, and worker specialization when choosing what to inspect.',
    'If the work is too broad for one safe implementation attempt, set decomposition.shouldSplit=true with concrete suggestedWorks instead of pretending it is safe.',
    'Do not rewrite the requested work into a smaller goal; patch boundaries are implementation constraints, not acceptance criteria.',
    'Before planning, inspect repository structure and relevant files with read-only tools.',
    'Never return the final plan before using list_files, search_files, or read_file, unless you are an external CLI agent that has already inspected the filesystem directly.',
    'Identify existing user changes and mark files that must not be overwritten as protectedFiles.',
    'Produce a structured plan with intended files, validation commands, risks, and stop conditions.',
    'Produce a concrete changeDesign that a reviewer can compare against the final diff.',
    'Produce a requirementTrace matrix and patch approach comparison before implementation.',
    'Escalate unresolved high-impact uncertainty instead of guessing.',
    'Do not modify files.',
    'Prefer existing project patterns over new abstractions.',
    'Prefer a narrow file list over a broad one.',
    `Keep intendedFiles at ${SMALL_PATCH_PLAN_FILE_LIMIT} files or fewer unless decomposition.shouldSplit=true.`,
    'Return concrete repoFindings based on files or searches you actually inspected.',
    'Do not invent inspected files, checks, or repository facts.',
    `Return at most ${MAX_PLANNER_VALIDATION_COMMANDS} validation commands.`,
    'Only suggest validation commands that are safe and diagnostic in nature, such as pytest, python -m pytest/unittest/compileall, npm or pnpm test/lint/build/typecheck, node --test, git status/diff/show, rg, go test/vet, cargo test/check/clippy/fmt, or dotnet test/build.',
    'Define stopConditions for blocked protected files, unclear requirements, unsafe required commands, or missing context that cannot be resolved with read-only inspection.',
    'Do not wrap the final JSON in markdown fences.',
  ].join('\n');
}

export function buildWorkerPrompt(
  work: WorkTask,
  projectOverview: string,
  contextScan: ProjectContextScan,
  plan: WorkerExecutionPlan | null,
  feedback: string[],
  requiredInstructions = '',
  workerProfile = contextScan.workerProfile ?? plan?.workerProfile ?? 'generalist',
): string {
  return [
    `Project: ${work.projectName}`,
    `Work title: ${work.title}`,
    `Work brief:\n${work.description}`,
    buildRequiredProjectInstructionsBlock(requiredInstructions),
    buildWorkerProfileBlock(workerProfile),
    `Project overview:\n${projectOverview}`,
    `Project context scan:\n${formatProjectContextScan(contextScan)}`,
    plan ? `Plan understanding:\n${plan.understanding}` : '',
    plan ? `Plan repo findings:\n${formatList(plan.repoFindings, 'No repo findings')}` : '',
    plan ? `Execution plan summary:\n${plan.summary}` : '',
    plan ? `Task type:\n${plan.taskType}` : '',
    plan ? formatPatchAlternatives(plan.approachAlternatives) : '',
    plan ? formatRequirementTrace(plan.requirementTrace) : '',
    plan ? formatChangeDesign(plan.changeDesign) : '',
    plan ? `Planned files:\n${formatList(plan.intendedFiles, 'No planned files')}` : '',
    plan ? `Protected files:\n${formatList(plan.protectedFiles, 'No protected files')}` : '',
    plan
      ? `Planned validation commands:\n${formatList(
          plan.validationCommands,
          'No planned validation commands',
        )}`
      : '',
    plan ? `Planner risk notes:\n${formatList(plan.riskNotes, 'No planner risks reported')}` : '',
    plan ? `Stop conditions:\n${formatList(plan.stopConditions, 'No stop conditions')}` : '',
    feedback.length > 0
      ? `Review feedback to address:\n${feedback.map((item) => `- ${item}`).join('\n')}`
      : '',
    'Modify the project directly using the available tools.',
    'Complete the full acceptance target from the work brief and mandatory project instructions; do not satisfy only the easiest subset because the patch should be small.',
    'Before editing, inspect the files that matter for this task, especially files from the context scan and planned file list.',
    'Use existing project patterns and local helpers before introducing new abstractions.',
    'Treat the design review gate as binding context: satisfy its requiredChanges before editing, and address warnings in remainingRisks or selfCheck notes.',
    'Stay within the planned files whenever practical. If you must expand scope, inspect the extra file first and keep the change justified and minimal.',
    'Follow the changeDesign. Preserve every invariant, keep expectedImpact narrow, use the validationStrategy, and keep rollbackStrategy true.',
    'Follow the requirementTrace. In the final selfCheck, mark every requirement satisfied, partial, blocked, or not_applicable and cite concrete evidence. Never mark brief or mandatory project-instruction requirements not_applicable to reduce scope.',
    'Implement the selected approachAlternative. If inspection proves it wrong, explain the change in remainingRisks and selfCheck notes.',
    'If unresolved uncertainty would change product behavior, authorization, data safety, or architecture, stop and report it instead of guessing.',
    'If the approved plan appears narrower than the work brief, stop and report the scope mismatch instead of implementing a partial goal.',
    'Never edit protectedFiles. Stop and report the blocker if a protected file must change.',
    'Do not touch out-of-plan files unless necessary and explained by the final summary.',
    'Read high-risk existing files with read_file before editing or overwriting them.',
    'For existing files, prefer edit_file with exact replacements.',
    'If edit_file cannot match a planned file after you already read it, use write_file with the complete final file content; Kira only permits this full rewrite for read, planned, unprotected files within the file-size limit.',
    'Use write_file only for new files, small existing files, or a read planned file that genuinely needs a full rewrite.',
    'Do not treat other existing modified or untracked files in the project as something you must clean up unless the task explicitly asks for cleanup.',
    'When you report filesChanged, list the files you intentionally touched for this attempt, not unrelated pre-existing worktree noise.',
    'Run the planned validation commands when practical, plus focused checks needed by the actual changes.',
    'Never claim a check passed unless you ran it in this attempt or Kira provided the rerun result.',
    'If validation cannot be run, put the reason and residual risk in remainingRisks.',
    'Before returning, inspect the final diff and write diffHunkReview entries that summarize the intent and risk of each changed file or meaningful hunk.',
    'Before returning, perform a self-check against the diff, mandatory project instructions, the approved plan, changeDesign, validation evidence, and any remaining uncertainty.',
    'When finished, return only JSON with this shape:',
    '{"summary":"string","filesChanged":["..."],"testsRun":["..."],"remainingRisks":["..."],"selfCheck":{"reviewedDiff":true,"followedProjectInstructions":true,"matchedPlan":true,"ranOrExplainedValidation":true,"diffHunkReview":[{"file":"path","intent":"string","risk":"string"}],"requirementTrace":[{"id":"R1","source":"brief|project-instruction|change-design|review","text":"string","status":"satisfied|partial|blocked|not_applicable","evidence":["changed file, test, or explicit reason"]}],"uncertainty":["..."],"notes":["..."]}}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildWorkerSystemPrompt(): string {
  return [
    'You are Kira Worker, a careful implementation agent.',
    `Kira prompt contract version: ${KIRA_PROMPT_CONTRACT_VERSION}.`,
    'When mandatory project instructions are supplied, follow them as binding acceptance criteria for implementation and validation.',
    'Do not let mandatory project instructions override Kira safety rules, protectedFiles, tool restrictions, or the required JSON output.',
    'If mandatory project instructions conflict with the work brief or cannot be followed, stop and report the blocker in remainingRisks.',
    'Use the project intelligence profile and recent feedback memory to avoid repeating known review or validation failures.',
    'Respect the worker specialization as a focus lens while still completing the whole task.',
    'Stay focused on the requested work item.',
    'Do not narrow the acceptance target; complete the requested outcome or report why it must be split or blocked.',
    'Respect the design review gate; if it records warnings, make the implementation and final self-check answer them directly.',
    'Before editing, inspect repository structure and relevant files.',
    'Identify existing user changes and avoid overwriting them.',
    'Assume other Kira agents may be working in sibling git worktrees; only rely on the files and tool results in your current project root.',
    'Prefer small targeted edits over broad refactors.',
    'Prefer existing project patterns over new abstractions.',
    'Respect the preflight plan unless inspection shows a clearly necessary small expansion.',
    'Respect the changeDesign and keep the patch small enough for one focused review.',
    'Do not touch out-of-plan files unless necessary and explained.',
    'Never edit protectedFiles; stop and report the blocker instead.',
    'Read high-risk existing files before editing them.',
    'Prefer edit_file for modifying existing files, especially large or critical ones.',
    'When edit_file cannot safely match text in a file listed in intendedFiles, read the file and then use write_file with the complete final content instead of getting stuck on repeated failed replacements.',
    'Do not try to clean unrelated dirty-worktree files unless the work item explicitly requires it.',
    'Use write_file only when creating a new file, replacing a genuinely small file, or rewriting a read planned file with complete final content.',
    'Use run_command for safe checks only, and run planned validation commands when practical.',
    'Summarize changed files, checks run, failures, and remaining risks.',
    'Run a final self-check and include the selfCheck object in the final JSON.',
    'The final selfCheck must include diffHunkReview based on the final diff.',
    'The final selfCheck must include requirementTrace evidence for each planned requirement.',
    'Brief and mandatory project-instruction requirements cannot be marked not_applicable; use satisfied, partial, or blocked with evidence.',
    'Never claim a check passed unless you ran it or Kira provided the result.',
    'Do not mention markdown fences in your final answer.',
  ].join('\n');
}

export function buildReviewPrompt(
  work: WorkTask,
  projectOverview: string,
  contextScan: ProjectContextScan,
  plan: WorkerExecutionPlan | null,
  workerSummary: WorkerSummary,
  outOfPlanFiles: string[],
  missingValidationCommands: string[],
  validationPlan: ResolvedValidationPlan,
  validationReruns: ValidationRerunSummary,
  diffExcerpts: string[],
  requiredInstructions = '',
  diffStats?: DiffStats,
  failureAnalysis: FailureAnalysis[] = [],
  runtimeValidation?: RuntimeValidationResult,
  patchIntentVerification?: PatchIntentVerification,
): string {
  const requirementTrace = workerSummary.selfCheck?.requirementTrace.length
    ? workerSummary.selfCheck.requirementTrace
    : (plan?.requirementTrace ?? contextScan.requirementTrace ?? []);
  return [
    `Project: ${work.projectName}`,
    `Work title: ${work.title}`,
    `Acceptance target:\n${work.description}`,
    buildRequiredProjectInstructionsBlock(requiredInstructions),
    `Project overview:\n${projectOverview}`,
    `Project context scan:\n${formatProjectContextScan(contextScan)}`,
    plan ? `Preflight understanding:\n${plan.understanding}` : '',
    plan ? `Repo findings:\n${formatList(plan.repoFindings, 'No repo findings')}` : '',
    plan ? `Preflight plan summary:\n${plan.summary}` : '',
    plan ? `Task type:\n${plan.taskType}` : '',
    plan ? formatPatchAlternatives(plan.approachAlternatives) : '',
    formatRequirementTrace(requirementTrace),
    plan ? formatChangeDesign(plan.changeDesign) : '',
    plan ? `Planned files:\n${formatList(plan.intendedFiles, 'No planned files')}` : '',
    plan ? `Protected files:\n${formatList(plan.protectedFiles, 'No protected files')}` : '',
    plan ? `Planned checks:\n${formatList(plan.validationCommands, 'No planned checks')}` : '',
    plan ? `Planner risk notes:\n${formatList(plan.riskNotes, 'No planner risks reported')}` : '',
    plan ? `Stop conditions:\n${formatList(plan.stopConditions, 'No stop conditions')}` : '',
    `Latest worker summary:\n${workerSummary.summary}`,
    `Files reported changed:\n${formatList(workerSummary.filesChanged, 'No files reported')}`,
    `Worker-reported checks:\n${formatList(workerSummary.testsRun, 'No checks reported')}`,
    workerSummary.selfCheck
      ? `Worker self-check:\n${formatList(
          [
            `reviewedDiff=${workerSummary.selfCheck.reviewedDiff}`,
            `followedProjectInstructions=${workerSummary.selfCheck.followedProjectInstructions}`,
            `matchedPlan=${workerSummary.selfCheck.matchedPlan}`,
            `ranOrExplainedValidation=${workerSummary.selfCheck.ranOrExplainedValidation}`,
            ...workerSummary.selfCheck.diffHunkReview.map(
              (item) => `diffHunkReview ${item.file}: ${item.intent} Risk: ${item.risk}`,
            ),
            ...workerSummary.selfCheck.requirementTrace.map(
              (item) =>
                `requirementTrace ${item.id}=${item.status ?? 'unknown'}: ${
                  item.evidence.join('; ') || item.text
                }`,
            ),
            ...workerSummary.selfCheck.uncertainty.map((item) => `uncertainty: ${item}`),
            ...workerSummary.selfCheck.notes.map((item) => `note: ${item}`),
          ],
          'No self-check values reported',
        )}`
      : 'Worker self-check:\n- Missing self-check object',
    `Kira auto-added validation checks:\n${formatList(
      validationPlan.autoAddedCommands,
      'No auto-added validation checks',
    )}`,
    `Kira effective validation plan:\n${formatList(
      validationPlan.effectiveCommands,
      'No effective validation commands',
    )}`,
    validationPlan.notes.length > 0
      ? `Validation plan notes:\n${formatList(validationPlan.notes, 'No validation plan notes')}`
      : '',
    `Kira-passed validation reruns:\n${formatList(
      validationReruns.passed,
      'No validation reruns passed',
    )}`,
    validationReruns.failed.length > 0
      ? `Kira validation reruns that failed:\n${formatList(
          validationReruns.failed,
          'No validation reruns failed',
        )}`
      : '',
    outOfPlanFiles.length > 0
      ? `Files changed outside the plan:\n${formatList(outOfPlanFiles, 'No out-of-plan files')}`
      : '',
    missingValidationCommands.length > 0
      ? `Planned checks the worker did not run:\n${formatList(
          missingValidationCommands,
          'No missing planned checks',
        )}`
      : '',
    diffStats
      ? `Diff stats:\n- files=${diffStats.files}\n- additions=${diffStats.additions}\n- deletions=${diffStats.deletions}\n- hunks=${diffStats.hunks}`
      : '',
    formatRiskReviewPolicy(contextScan.riskPolicy),
    formatReviewAdversarialPlan(contextScan.reviewAdversarialPlan),
    formatReviewerCalibration(contextScan.reviewerCalibration),
    formatDesignReviewGate(contextScan.designReviewGate),
    formatRuntimeValidationSignal(contextScan.runtimeValidation),
    formatRuntimeValidationResult(runtimeValidation),
    formatPatchIntentVerification(patchIntentVerification),
    formatFailureAnalysis(failureAnalysis),
    diffExcerpts.length > 0
      ? `Git diff excerpts for this attempt:\n${diffExcerpts.join('\n\n')}`
      : '',
    'Review the current project state. Do not modify files.',
    'Review mandatory project instructions as required acceptance criteria.',
    'Do not approve partial goal fulfillment. The patch may be small, but the completed behavior must still satisfy the full work brief and mandatory project instructions.',
    'Review the changeDesign against the actual diff. Do not approve if the diff violates stated invariants or broadens expectedImpact without a clear reason.',
    'Review patchIntentVerification. Do not approve patch intent drift; request a new worker attempt with corrected scope or explicit plan alignment.',
    'Review the selected patch alternative against the actual diff. Do not approve if the worker silently chose a different approach and the risk is unexplained.',
    'Run the review adversarial plan. For every listed mode, return an adversarialChecks entry with passed, failed, or not_applicable and concrete evidence.',
    'Run reviewerDiscourse before approving: include at least one challenge perspective and one support or resolved perspective, with evidence and responses for any challenge.',
    'Review the requirementTrace. For every listed requirement, return a requirementVerdicts entry with satisfied, partial, blocked, or not_applicable and concrete evidence. Treat not_applicable on brief or mandatory project-instruction requirements as a blocking scope-reduction attempt.',
    'Review worker diffHunkReview against the git diff excerpts. Do not approve if the hunk review is missing or contradicts the actual patch.',
    'Do not approve if the implementation violates mandatory project instructions; report the violation in findings or nextWorkerInstructions.',
    'Review priorities: correctness and requirement coverage first, then regressions, data loss, security, concurrency, missing validation, and maintainability risks that affect real outcomes.',
    'Only the Kira-passed validation reruns count as verification evidence.',
    'For non-documentation changes, do not approve if Kira produced no effective validation command; request a project validation command or a blocked/manual path instead.',
    'Use failureAnalysis to decide the next concrete worker fix when validation failed.',
    'If runtime validation is applicable and a dev server is detected, treat an unreachable runtime check as blocking unless the work is clearly non-runtime.',
    'Do not treat worker-reported checks as proof unless they also appear in the Kira-passed rerun list.',
    'Do not approve if Kira validation reruns failed or if missingValidation is required for confidence.',
    'Do not approve if the worker summary conflicts with the diff excerpts.',
    'Do not approve if filesChecked is empty while changed files or diff excerpts are present; independent review must record what was checked.',
    'Record evidenceChecked with one entry per independently checked file or runtime/test signal, including the method used and why it was checked.',
    'Triage every finding, missing validation, design-gate concern, and intent/runtime blocker in your own reasoning; Kira will store the triage state from your structured output and enforcement result.',
    'Meet the risk review policy evidence minimum before approving; high-risk reviews need stronger, independent evidence.',
    'Do not approve unexplained out-of-plan edits when they create concrete risk or obscure the requested outcome.',
    'Do NOT reject only because multiple project-local files changed, because the worker touched a file you did not expect, or because the git working tree already contains unrelated modified/untracked files, unless Kira small-patch policy or concrete risk is flagged.',
    'Treat out-of-plan edits or missing planned checks as risk signals to scrutinize, not automatic rejection reasons on their own.',
    'Do NOT enforce minimal-diff purity as a standalone requirement, but do enforce explicit Kira small-patch policy issues.',
    'Approve when the requested outcome is achieved and there is no clear regression or harmful side effect.',
    'Only request changes when the acceptance target is not met, the implementation is clearly risky, or there is a concrete user-facing/code-level regression.',
    'When requesting changes, provide concrete nextWorkerInstructions that the worker can execute immediately.',
    'Return only JSON with this shape:',
    '{"approved":true,"summary":"string","findings":[{"file":"path","line":1,"severity":"low|medium|high","message":"string"}],"missingValidation":["..."],"nextWorkerInstructions":["..."],"residualRisk":["..."],"issues":["..."],"filesChecked":["..."],"evidenceChecked":[{"file":"path-or-runtime","reason":"string","method":"read_file|diff|test|runtime|other"}],"adversarialChecks":[{"mode":"correctness|regression|security|runtime-ux|data-safety|integration|maintainability","result":"passed|failed|not_applicable","evidence":["..."],"concern":"string"}],"reviewerDiscourse":[{"role":"correctness|regression|security|runtime-ux|data-safety|integration|maintainability|design-gate|validation","position":"support|challenge|resolved","argument":"string","evidence":["..."],"response":"string"}],"requirementVerdicts":[{"id":"R1","source":"brief|project-instruction|change-design|review","text":"string","status":"satisfied|partial|blocked|not_applicable","evidence":["..."]}]}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildReviewSystemPrompt(): string {
  return [
    'You are Kira Reviewer, an independent code reviewer.',
    `Kira prompt contract version: ${KIRA_PROMPT_CONTRACT_VERSION}.`,
    'When mandatory project instructions are supplied, enforce them as binding acceptance criteria.',
    'Do not approve work that violates mandatory project instructions. If following them would conflict with Kira safety rules or the explicit work brief, report the conflict clearly instead of approving.',
    'Use the project intelligence profile and recent feedback memory to catch repeated mistakes, project-specific style drift, and validation gaps.',
    'Respect reviewer calibration: higher strictness requires more independent evidence before approval.',
    'Apply every requested adversarial review mode and record adversarialChecks with evidence.',
    'Simulate reviewer discourse: challenge the patch from at least one skeptical perspective, then resolve or answer the challenge before approval.',
    'Treat design-gate concerns and finding triage as first-class review artifacts.',
    'Treat a missing or failed worker self-check as review evidence that must be addressed before approval.',
    'Independently compare the changeDesign, worker self-check, filesChanged, and git diff excerpts instead of trusting the worker summary.',
    'Independently verify requirementTrace items and return requirementVerdicts with evidence.',
    'Record evidenceChecked for files, tests, runtime checks, or other concrete signals you actually inspected.',
    'Review the implementation carefully against the requested result and real regressions.',
    'Prioritize correctness and requirement coverage.',
    'Do not approve a small patch that solves only a narrower version of the requested goal.',
    'Then check regressions, data loss, security, concurrency, missing validation, and maintainability risks that affect real outcomes.',
    'Treat concurrent-agent integration risks, stale assumptions, and overlapping file edits as review risks when they affect correctness.',
    'Do not approve if validation failed.',
    'Do not approve non-documentation code changes when Kira has no effective validation command for them.',
    'Do not approve if the worker summary conflicts with the diff or provided project state.',
    'Do not approve without recording filesChecked for the changed files you reviewed.',
    'Do not approve without enough evidenceChecked entries for the supplied risk review policy.',
    'Do not approve unexplained out-of-plan edits when they create concrete risk or obscure the requested outcome.',
    'Provide concrete nextWorkerInstructions when requesting changes.',
    'Do not fail a review only for scope broadness, extra project-local file edits, or unrelated pre-existing dirty-worktree files unless Kira small-patch policy or concrete risk is flagged.',
    'Never edit files.',
    'Use read-only tools and safe commands only.',
    'Return only the requested structured JSON.',
  ].join('\n');
}

function buildAttemptComparisonReviewPrompt(
  work: WorkTask,
  attempts: KiraWorkerAttemptResult[],
  requiredInstructions = '',
  synthesisRecommendation = buildAttemptSynthesisRecommendation(attempts),
): string {
  return [
    `Project: ${work.projectName}`,
    `Work title: ${work.title}`,
    `Acceptance target:\n${work.description}`,
    buildRequiredProjectInstructionsBlock(requiredInstructions),
    'Multiple isolated Kira workers produced independent attempts for the same work item.',
    'Compare the attempts against the acceptance target and choose the single best attempt only if it should be integrated.',
    'If every attempt has correctness, validation, or integration risks that should block integration, set approved to false and selectedAttemptNo to null.',
    formatAttemptSynthesisRecommendation(synthesisRecommendation),
    ...attempts.map((attempt) =>
      [
        `Attempt ${attempt.attemptNo} (${attempt.lane.label})`,
        `Isolated worktree: ${attempt.workspace.projectRoot}`,
        `Task type: ${attempt.workerPlan.taskType}`,
        `Plan:\n${attempt.workerPlan.summary}`,
        `Plan understanding:\n${attempt.workerPlan.understanding}`,
        formatPatchAlternatives(attempt.workerPlan.approachAlternatives),
        formatRequirementTrace(
          attempt.workerSummary.selfCheck?.requirementTrace.length
            ? attempt.workerSummary.selfCheck.requirementTrace
            : attempt.workerPlan.requirementTrace,
        ),
        formatOrchestrationPlan(attempt.contextScan.orchestrationPlan),
        formatManualEvidence(attempt.contextScan.manualEvidence),
        formatChangeDesign(attempt.workerPlan.changeDesign),
        formatDesignReviewGate(attempt.contextScan.designReviewGate),
        formatReviewAdversarialPlan(attempt.contextScan.reviewAdversarialPlan),
        `Files changed:\n${formatList(attempt.workerSummary.filesChanged, 'No files reported')}`,
        `Worker summary:\n${attempt.workerSummary.summary}`,
        attempt.workerSummary.selfCheck
          ? `Worker diffHunkReview:\n${formatList(
              attempt.workerSummary.selfCheck.diffHunkReview.map(
                (item) => `${item.file}: ${item.intent} Risk: ${item.risk}`,
              ),
              'No diff hunk review reported',
            )}`
          : 'Worker diffHunkReview:\n- Missing self-check',
        `Validation passed:\n${formatList(attempt.validationReruns.passed, 'No validation reruns passed')}`,
        `Validation failed:\n${formatList(attempt.validationReruns.failed, 'No validation reruns failed')}`,
        formatRiskReviewPolicy(attempt.contextScan.riskPolicy),
        formatRuntimeValidationResult(attempt.runtimeValidation),
        formatPatchIntentVerification(attempt.patchIntentVerification),
        formatFailureAnalysis(attempt.failureAnalysis),
        `Diff stats:\n- files=${attempt.diffStats.files}\n- additions=${attempt.diffStats.additions}\n- deletions=${attempt.diffStats.deletions}\n- hunks=${attempt.diffStats.hunks}`,
        `Out-of-plan files:\n${formatList(attempt.outOfPlanFiles, 'No out-of-plan files')}`,
        `Validation gaps:\n${formatList(attempt.missingValidationCommands, 'No missing planned checks')}`,
        `Risks:\n${formatList(
          [...attempt.workerSummary.remainingRisks, ...attempt.highRiskIssues],
          'No risks reported',
        )}`,
        attempt.diffExcerpts.length > 0
          ? `Git diff excerpts:\n${attempt.diffExcerpts.join('\n\n')}`
          : 'Git diff excerpts:\n- No diff excerpts available',
      ].join('\n\n'),
    ),
    'Selection rules:',
    '- approved=true requires selecting exactly one attemptNo from the listed attempts.',
    '- Prefer the attempt that best satisfies the work brief with the least concrete regression risk.',
    '- Do not select or approve an attempt that violates mandatory project instructions.',
    '- Do not select or approve an attempt with a blocked design review gate.',
    '- Treat operator manual evidence and risk acceptance as review context, not as a substitute for required Kira validation evidence.',
    '- Compare each attempt changeDesign and diffHunkReview against the actual diff excerpts.',
    '- Compare each attempt patchIntentVerification against the actual changed files.',
    '- Do not approve an attempt with patch intent drift; request another round with corrected scope or plan alignment.',
    '- Apply the selected attempt review adversarial plan and return adversarialChecks for each mode.',
    '- Compare each attempt requirementTrace against its diff, validation reruns, and runtime validation result.',
    '- Do not approve without recording filesChecked for the selected attempt.',
    '- Do not approve without evidenceChecked coverage for the selected attempt and enough entries for its risk policy.',
    '- Return requirementVerdicts for the selected attempt before approving.',
    '- Do not approve an attempt only because it is smaller; approve it because it is correct and adequately validated.',
    '- Do not approve an attempt that shrinks the acceptance target or marks brief/project-instruction requirements not_applicable.',
    '- Do not approve if validation failed, if the summary conflicts with the diff, or if integration risk is concrete.',
    '- If requesting another worker round, give nextWorkerInstructions that all workers can act on.',
    'Return only JSON with this shape:',
    '{"approved":true,"selectedAttemptNo":1,"summary":"string","issues":["..."],"nextWorkerInstructions":["..."],"residualRisk":["..."],"filesChecked":["..."],"evidenceChecked":[{"file":"path-or-runtime","reason":"string","method":"read_file|diff|test|runtime|other"}],"adversarialChecks":[{"mode":"correctness|regression|security|runtime-ux|data-safety|integration|maintainability","result":"passed|failed|not_applicable","evidence":["..."],"concern":"string"}],"requirementVerdicts":[{"id":"R1","source":"brief|project-instruction|change-design|review","text":"string","status":"satisfied|partial|blocked|not_applicable","evidence":["..."]}]}',
  ].join('\n\n');
}

export function buildAttemptComparisonReviewSystemPrompt(): string {
  return [
    'You are Kira Reviewer, an independent code reviewer and attempt judge.',
    `Kira prompt contract version: ${KIRA_PROMPT_CONTRACT_VERSION}.`,
    'When mandatory project instructions are supplied, enforce them as binding acceptance criteria for attempt selection.',
    'Compare multiple isolated worker attempts for one task.',
    'Select one winning attempt only when it satisfies the requested outcome and has no blocking regression, validation, or integration risk.',
    'Do not select a smaller attempt that leaves part of the original acceptance target undone.',
    'Use cross-attempt synthesis only as review guidance; Kira still integrates one selected winning attempt.',
    'Apply the selected attempt adversarial review modes and record adversarialChecks with evidence.',
    'Use requirementVerdicts and evidenceChecked to justify any approval.',
    'If no attempt is good enough, request another worker round with concrete shared instructions.',
    'Never edit files.',
    'Return only the requested structured JSON.',
  ].join('\n');
}

export function parseAttemptSelectionSummary(
  raw: string,
  validAttemptNos: number[],
): AttemptSelectionSummary {
  try {
    const parsed = JSON.parse(extractJson(raw)) as Partial<AttemptSelectionSummary>;
    const selectedAttemptNo =
      typeof parsed.selectedAttemptNo === 'number' &&
      validAttemptNos.includes(parsed.selectedAttemptNo)
        ? parsed.selectedAttemptNo
        : null;
    const issues = uniqueStrings(Array.isArray(parsed.issues) ? parsed.issues.map(String) : []);
    return {
      approved: normalizeBoolean(parsed.approved) && selectedAttemptNo !== null,
      selectedAttemptNo,
      summary: parsed.summary?.trim() || 'No attempt comparison summary provided.',
      issues,
      nextWorkerInstructions: uniqueStrings(
        Array.isArray(parsed.nextWorkerInstructions)
          ? parsed.nextWorkerInstructions.map(String)
          : [],
      ),
      residualRisk: uniqueStrings(
        Array.isArray(parsed.residualRisk) ? parsed.residualRisk.map(String) : [],
      ),
      filesChecked: normalizePathList(
        Array.isArray(parsed.filesChecked) ? parsed.filesChecked : [],
        100,
      ),
      evidenceChecked: normalizeReviewEvidenceChecked(parsed.evidenceChecked),
      requirementVerdicts: normalizeRequirementTrace(parsed.requirementVerdicts),
      adversarialChecks: normalizeReviewAdversarialChecks(parsed.adversarialChecks),
    };
  } catch {
    return {
      approved: false,
      selectedAttemptNo: null,
      summary: raw.trim() || 'Attempt comparison parsing failed.',
      issues: ['Attempt comparison result could not be parsed into structured JSON.'],
      nextWorkerInstructions: ['Return the attempt comparison result as structured JSON.'],
      residualRisk: [],
      filesChecked: [],
      evidenceChecked: [],
      requirementVerdicts: [],
      adversarialChecks: [],
    };
  }
}

function buildAttemptSelectionReviewSummary(
  selection: AttemptSelectionSummary,
  approved: boolean,
  overrides: Partial<ReviewSummary> = {},
): ReviewSummary {
  const summary: ReviewSummary = {
    approved,
    summary: selection.summary,
    issues: approved ? [] : selection.issues,
    filesChecked: selection.filesChecked,
    findings: [],
    missingValidation: [],
    nextWorkerInstructions: approved ? [] : selection.nextWorkerInstructions,
    residualRisk: selection.residualRisk,
    evidenceChecked: selection.evidenceChecked,
    requirementVerdicts: selection.requirementVerdicts,
    adversarialChecks: selection.adversarialChecks,
    reviewerDiscourse: [],
    ...overrides,
  };
  return {
    ...summary,
    issues: uniqueStrings(summary.issues),
    filesChecked: normalizePathList(summary.filesChecked, 200),
    missingValidation: uniqueStrings(summary.missingValidation),
    nextWorkerInstructions: uniqueStrings(summary.nextWorkerInstructions),
    residualRisk: uniqueStrings(summary.residualRisk),
  };
}

function buildAttemptSelectionReviewRecord(params: {
  workId: string;
  attempt: KiraWorkerAttemptResult;
  reviewSummary: ReviewSummary;
  attemptSynthesis: AttemptSynthesisRecommendation;
  startedAt: number;
  finishedAt: number;
  reviewRaw: string;
}): { record: KiraReviewRecord; reviewSummary: ReviewSummary } {
  const reviewSummary = ensureReviewerDiscourse(params.reviewSummary, {
    reviewAdversarialPlan: params.attempt.contextScan.reviewAdversarialPlan,
  });
  const triage = buildReviewFindingTriage(reviewSummary, {
    designReviewGate: params.attempt.contextScan.designReviewGate,
    patchIntentVerification: params.attempt.patchIntentVerification,
    runtimeValidation: params.attempt.runtimeValidation,
  });
  const diffCoverage = buildDiffReviewCoverage({
    workerSummary: params.attempt.workerSummary,
    reviewSummary,
    diffExcerpts: params.attempt.diffExcerpts,
  });
  return {
    record: buildReviewRecord(params.workId, params.attempt.attemptNo, reviewSummary, {
      reviewAdversarialPlan: params.attempt.contextScan.reviewAdversarialPlan,
      attemptSynthesis: params.attemptSynthesis,
      designReviewGate: params.attempt.contextScan.designReviewGate,
      patchIntentVerification: params.attempt.patchIntentVerification,
      runtimeValidation: params.attempt.runtimeValidation,
      diffCoverage,
      observability: buildReviewObservability({
        startedAt: params.startedAt,
        finishedAt: params.finishedAt,
        reviewRaw: params.reviewRaw,
        reviewSummary,
        triage,
      }),
    }),
    reviewSummary,
  };
}

function enforceAttemptSelectionDecision(
  summary: AttemptSelectionSummary,
  selectedAttempt: KiraWorkerAttemptResult | null,
): AttemptSelectionSummary {
  if (!summary.approved || !selectedAttempt) return summary;

  const issues: string[] = [];
  if (selectedAttempt.validationReruns.failed.length > 0) {
    issues.push(
      `Selected attempt has failed Kira validation reruns: ${selectedAttempt.validationReruns.failed.join(', ')}`,
    );
  }
  if (
    selectedAttempt.workerSummary.filesChanged.length > 0 &&
    !isDocumentationOnlyChange(selectedAttempt.workerSummary.filesChanged) &&
    selectedAttempt.validationPlan.effectiveCommands.length === 0
  ) {
    issues.push(
      'Selected attempt has non-documentation changes but no effective Kira validation command.',
    );
  }
  if (
    !selectedAttempt.workerSummary.selfCheck ||
    selectedAttempt.workerSummary.selfCheck.diffHunkReview.length === 0
  ) {
    issues.push('Selected attempt is missing worker diffHunkReview evidence.');
  }
  const filesChecked = normalizePathList(summary.filesChecked, 200);
  const evidenceCheckedFiles = summary.evidenceChecked.map((item) => item.file);
  const uncheckedFiles = selectedAttempt.workerSummary.filesChanged
    .slice(0, 8)
    .filter((file) => !pathMatchesScope(filesChecked, file));
  if (selectedAttempt.workerSummary.filesChanged.length > 0 && filesChecked.length === 0) {
    issues.push('Attempt judge approved without recording filesChecked.');
  } else if (uncheckedFiles.length > 0) {
    issues.push(`Attempt judge filesChecked did not cover: ${uncheckedFiles.join(', ')}`);
  }
  const selectedRiskPolicy = selectedAttempt.contextScan.riskPolicy ?? {
    level: 'low' as const,
    evidenceMinimum: 1,
    reasons: [],
    requiresRuntimeValidation: false,
    requiresSecondPass: false,
  };
  if (summary.evidenceChecked.length < selectedRiskPolicy.evidenceMinimum) {
    issues.push(
      `Attempt judge evidenceChecked is insufficient for ${selectedRiskPolicy.level} risk: ${summary.evidenceChecked.length}/${selectedRiskPolicy.evidenceMinimum}`,
    );
  }
  const evidenceMissing = selectedAttempt.workerSummary.filesChanged
    .slice(0, 8)
    .filter((file) => !pathMatchesScope(evidenceCheckedFiles, file));
  if (selectedAttempt.workerSummary.filesChanged.length > 0 && evidenceMissing.length > 0) {
    issues.push(`Attempt judge evidenceChecked did not cover: ${evidenceMissing.join(', ')}`);
  }
  if (
    selectedAttempt.workerPlan.requirementTrace.length > 0 &&
    summary.requirementVerdicts.length === 0
  ) {
    issues.push('Attempt judge approved without requirementVerdicts.');
  }
  if (
    selectedAttempt.workerPlan.requirementTrace.length > 0 &&
    summary.requirementVerdicts.length > 0
  ) {
    issues.push(
      ...collectIncompleteRequirementTraceIssues(summary.requirementVerdicts, 'Attempt judge'),
      ...collectMissingRequirementTraceIds(
        selectedAttempt.workerPlan.requirementTrace,
        summary.requirementVerdicts,
        'Attempt judge',
      ),
    );
  }
  if (
    selectedRiskPolicy.requiresRuntimeValidation &&
    selectedAttempt.runtimeValidation.serverDetected &&
    selectedAttempt.runtimeValidation.status !== 'reachable'
  ) {
    issues.push('Selected attempt failed runtime validation on a detected dev server.');
  }
  if (selectedAttempt.patchIntentVerification.status === 'drift') {
    issues.push(
      `Selected attempt has patch intent drift: ${selectedAttempt.patchIntentVerification.issues.join('; ')}`,
    );
  }
  const diffCoverage = buildDiffReviewCoverage({
    workerSummary: selectedAttempt.workerSummary,
    reviewSummary: buildAttemptSelectionReviewSummary(summary, true),
    diffExcerpts: selectedAttempt.diffExcerpts,
  });
  if (diffCoverage.issues.length > 0) {
    issues.push(...diffCoverage.issues);
  }
  if (selectedAttempt.contextScan.designReviewGate?.status === 'blocked') {
    issues.push(
      `Selected attempt has a blocked design review gate: ${selectedAttempt.contextScan.designReviewGate.requiredChanges.join('; ')}`,
    );
  }
  const expectedModes = selectedAttempt.contextScan.reviewAdversarialPlan?.modes ?? [];
  if (expectedModes.length > 0) {
    const checkedModes = new Set(summary.adversarialChecks.map((item) => item.mode));
    const missingModes = expectedModes.filter((mode) => !checkedModes.has(mode));
    if (missingModes.length > 0) {
      issues.push(
        `Attempt judge approved without adversarialChecks for modes: ${missingModes.join(', ')}`,
      );
    }
    const failedModes = summary.adversarialChecks.filter(
      (item) => item.result === 'failed' || item.evidence.length === 0,
    );
    if (failedModes.length > 0) {
      issues.push(
        `Attempt judge adversarialChecks were not passing/evidenced: ${failedModes
          .map((item) => item.mode)
          .join(', ')}`,
      );
    }
  }

  if (issues.length === 0) return summary;

  return {
    ...summary,
    approved: false,
    selectedAttemptNo: null,
    issues: uniqueStrings([...summary.issues, ...issues]),
    nextWorkerInstructions: uniqueStrings([
      ...summary.nextWorkerInstructions,
      'Run another worker round with complete diffHunkReview, validation evidence, and reviewer filesChecked coverage.',
    ]),
    summary: `${summary.summary}\n\nKira changed this attempt selection to request changes because independent review evidence was incomplete.`,
  };
}

function updateWork(
  sessionsDir: string,
  sessionPath: string,
  workId: string,
  updater: (current: WorkTask) => WorkTask,
): WorkTask | null {
  const workPath = join(getKiraDataDir(sessionsDir, sessionPath), WORKS_DIR_NAME, `${workId}.json`);
  const current = readJsonFile<WorkTask>(workPath);
  if (!current) return null;
  const next = updater(current);
  const updatedAt = Date.now();
  const persisted = { ...next, updatedAt };
  writeJsonFile(workPath, persisted);
  return persisted;
}

function addComment(
  sessionsDir: string,
  sessionPath: string,
  payload: Omit<TaskComment, 'id' | 'createdAt'> & { body: string },
): TaskComment {
  const comment: TaskComment = {
    id: makeId('comment'),
    createdAt: Date.now(),
    ...payload,
  };
  const commentsDir = join(getKiraDataDir(sessionsDir, sessionPath), COMMENTS_DIR_NAME);
  fs.mkdirSync(commentsDir, { recursive: true });
  writeJsonFile(join(commentsDir, `${comment.id}.json`), comment);
  return comment;
}

function loadTaskComments(sessionsDir: string, sessionPath: string, taskId: string): TaskComment[] {
  const commentsDir = join(getKiraDataDir(sessionsDir, sessionPath), COMMENTS_DIR_NAME);
  return listJsonFiles(commentsDir)
    .map((filePath) => readJsonFile<TaskComment>(filePath))
    .filter((comment): comment is TaskComment => comment !== null && comment.taskId === taskId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function ensureSuggestedCommitMessageComment(
  options: KiraAutomationPluginOptions,
  sessionPath: string,
  work: WorkTask,
): void {
  if (work.status !== 'done') return;

  const lockPath = getWorkLockPath(options.sessionsDir, sessionPath, work.id);
  const lockAcquired = tryAcquireLock(lockPath, {
    ownerId: SERVER_INSTANCE_ID,
    resource: 'work',
    sessionPath,
    targetKey: work.id,
  });
  if (!lockAcquired) return;

  try {
    const runtime = getKiraRuntimeSettings(options.configFile, options.getWorkRootDirectory());
    const refreshedWork = readJsonFile<WorkTask>(
      join(getKiraDataDir(options.sessionsDir, sessionPath), WORKS_DIR_NAME, `${work.id}.json`),
    );
    if (!refreshedWork || refreshedWork.status !== 'done') return;

    const comments = loadTaskComments(options.sessionsDir, sessionPath, work.id);
    const workerSummary = findSuggestedCommitBackfillSummary(comments);
    if (!workerSummary) return;

    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: `Suggested commit message:\n${buildSuggestedCommitMessage(refreshedWork, workerSummary)}`,
    });
  } finally {
    releaseLock(lockPath, SERVER_INSTANCE_ID);
  }
}

function extractLatestReviewerFeedback(comments: TaskComment[]): string[] {
  const latestReviewComment = [...comments]
    .reverse()
    .find((comment) => isReviewerAuthor(comment.author) && comment.body.includes('Issues:'));

  if (!latestReviewComment) return [];
  const issuesSection = latestReviewComment.body.split('Issues:\n')[1] ?? '';
  return issuesSection
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function sendSseEvent(
  res: { write: (chunk: string) => unknown },
  data: Record<string, unknown>,
): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function buildWorkerAttemptFailureResult(params: {
  lane: KiraWorkerLane;
  workspace: KiraWorkspaceSession;
  attemptNo: number;
  cycle: number;
  startedAt: number;
  projectOverview: string;
  contextScan: ProjectContextScan;
  message: string;
}): KiraWorkerAttemptResult {
  const workerPlan = parseWorkerExecutionPlan(
    JSON.stringify({
      understanding: 'Attempt failed before a complete plan was produced.',
      repoFindings: [],
      summary: params.message,
      intendedFiles: [],
      protectedFiles: [],
      changeDesign: {
        targetFiles: [],
        invariants: [params.message],
        expectedImpact: [params.message],
        validationStrategy: [params.message],
        rollbackStrategy: [params.message],
      },
      validationCommands: [],
      riskNotes: [params.message],
      stopConditions: [params.message],
      confidence: 0,
      uncertainties: [params.message],
      decomposition: normalizeDecompositionRecommendation(null),
      workerProfile: 'generalist',
      taskType: params.contextScan.taskPlaybook?.taskType ?? 'generalist',
      requirementTrace: params.contextScan.requirementTrace ?? [],
      approachAlternatives: [
        {
          name: 'No implementation attempted',
          selected: true,
          rationale: params.message,
          tradeoffs: [params.message],
        },
        {
          name: 'Retry after blocker is resolved',
          selected: false,
          rationale: 'A complete attempt requires resolving the blocker first.',
          tradeoffs: ['No patch is safer than an unverifiable patch.'],
        },
      ],
      escalation: {
        shouldAsk: true,
        questions: [params.message],
        blockers: [params.message],
      },
    }),
  );
  return {
    lane: params.lane,
    workspace: params.workspace,
    attemptNo: params.attemptNo,
    cycle: params.cycle,
    startedAt: params.startedAt,
    projectOverview: params.projectOverview,
    contextScan: params.contextScan,
    workerPlan,
    planningState: createWorkerAttemptState(null),
    attemptState: null,
    workerSummary: {
      summary: params.message,
      filesChanged: [],
      testsRun: [],
      remainingRisks: [params.message],
    },
    validationPlan: {
      plannerCommands: [],
      autoAddedCommands: [],
      effectiveCommands: [],
      notes: [],
    },
    validationReruns: { passed: [], failed: [], failureDetails: [] },
    failureAnalysis: [],
    runtimeValidation: emptyRuntimeValidationResult(params.contextScan.runtimeValidation),
    patchIntentVerification: emptyPatchIntentVerification(params.message),
    diffStats: { files: 0, additions: 0, deletions: 0, hunks: 0 },
    outOfPlanFiles: [],
    missingValidationCommands: [],
    highRiskIssues: [params.message],
    diffExcerpts: [],
    status: 'failed',
    feedback: [params.message],
    blockedReason: params.message,
  };
}

async function runIsolatedWorkerAttempt(params: {
  options: KiraAutomationPluginOptions;
  sessionPath: string;
  work: WorkTask;
  lane: KiraWorkerLane;
  workerCount: number;
  cycle: number;
  attemptNo: number;
  primaryProjectRoot: string;
  projectSettings: ResolvedKiraProjectSettings;
  feedback: string[];
  manualEvidence?: ManualEvidenceItem[];
  signal?: AbortSignal;
}): Promise<KiraWorkerAttemptResult> {
  const attemptStartedAt = Date.now();
  const laneFeedback = [
    ...params.feedback,
    `${params.lane.label}: produce an independent solution in this isolated worktree. Do not coordinate through files outside this worktree.`,
    params.lane.subagent
      ? [
          `Subagent contract: ${params.lane.subagent.label} (${params.lane.subagent.profile}).`,
          `Allowed tools: ${formatInlineList(params.lane.subagent.tools)}`,
          `Required evidence: ${formatInlineList(params.lane.subagent.requiredEvidence)}`,
          params.lane.subagent.modelHint ? `Model hint: ${params.lane.subagent.modelHint}` : '',
        ]
          .filter(Boolean)
          .join(' ')
      : '',
  ];
  const fallbackContextScan = await buildProjectContextScan(
    params.primaryProjectRoot,
    params.work,
    params.projectSettings.effectiveInstructions,
    params.projectSettings.runMode,
    params.workerCount,
    params.projectSettings,
  );
  fallbackContextScan.manualEvidence = params.manualEvidence ?? [];
  const fallbackOverview = buildProjectOverview(params.primaryProjectRoot);
  const workspace = await createKiraWorktreeSession(
    params.primaryProjectRoot,
    params.options.sessionsDir,
    params.sessionPath,
    params.work,
    params.projectSettings,
    { force: true, label: `${params.lane.id}-attempt-${params.attemptNo}` },
  );

  if (!workspace.isolated) {
    return buildWorkerAttemptFailureResult({
      lane: params.lane,
      workspace,
      attemptNo: params.attemptNo,
      cycle: params.cycle,
      startedAt: attemptStartedAt,
      projectOverview: fallbackOverview,
      contextScan: fallbackContextScan,
      message: 'Kira could not create an isolated worktree for this worker attempt.',
    });
  }

  try {
    const projectRoot = workspace.projectRoot;
    const environmentExecution = await runEnvironmentSetup(
      projectRoot,
      params.projectSettings.environment,
      params.signal,
      params.projectSettings.executionPolicy,
    );
    const environmentIssues = collectEnvironmentExecutionIssues(environmentExecution);
    const projectOverview = buildProjectOverview(projectRoot);
    const contextScan = await buildProjectContextScan(
      projectRoot,
      params.work,
      params.projectSettings.effectiveInstructions,
      params.projectSettings.runMode,
      params.workerCount,
      params.projectSettings,
    );
    contextScan.manualEvidence = params.manualEvidence ?? [];
    contextScan.environmentExecution = environmentExecution;
    if (environmentIssues.length > 0) {
      return buildWorkerAttemptFailureResult({
        lane: params.lane,
        workspace,
        attemptNo: params.attemptNo,
        cycle: params.cycle,
        startedAt: attemptStartedAt,
        projectOverview,
        contextScan,
        message: `Environment contract blocked this worker attempt: ${environmentIssues.join(' ')}`,
      });
    }
    const laneWorkerProfile = selectLaneWorkerProfile(
      params.lane,
      params.work,
      contextScan,
      params.workerCount,
      params.attemptNo,
    );
    const planningState = createWorkerAttemptState(
      null,
      [],
      undefined,
      contextScan.executionPolicy,
      contextScan.environmentContract,
    );
    const workerPlanRaw = await runToolAgent(
      params.lane.config,
      projectRoot,
      buildWorkerPlanningPrompt(
        params.work,
        projectOverview,
        contextScan,
        laneFeedback,
        params.projectSettings.effectiveInstructions,
        laneWorkerProfile,
      ),
      buildWorkerPlanningSystemPrompt(),
      false,
      params.signal,
      planningState,
      (content) =>
        collectPreflightPlanningIssues(
          contextScan,
          parseWorkerExecutionPlan(content),
          uniqueStrings(planningState.explorationActions),
        ),
    );
    throwIfCanceled(params.options.sessionsDir, params.sessionPath, params.work.id, params.signal);
    const workerPlan = parseWorkerExecutionPlan(workerPlanRaw);
    const preflightIssues = collectPreflightPlanningIssues(
      contextScan,
      workerPlan,
      uniqueStrings(planningState.explorationActions),
    );
    if (preflightIssues.length > 0) {
      return {
        lane: params.lane,
        workspace,
        attemptNo: params.attemptNo,
        cycle: params.cycle,
        startedAt: attemptStartedAt,
        projectOverview,
        contextScan,
        workerPlan,
        planningState,
        attemptState: null,
        workerSummary: {
          summary: 'Preflight planning needs more repository context.',
          filesChanged: [],
          testsRun: [],
          remainingRisks: preflightIssues,
        },
        validationPlan: {
          plannerCommands: [],
          autoAddedCommands: [],
          effectiveCommands: [],
          notes: [],
        },
        validationReruns: { passed: [], failed: [], failureDetails: [] },
        failureAnalysis: [],
        runtimeValidation: emptyRuntimeValidationResult(contextScan.runtimeValidation),
        patchIntentVerification: emptyPatchIntentVerification(
          'Preflight planning needs more repository context.',
        ),
        diffStats: { files: 0, additions: 0, deletions: 0, hunks: 0 },
        outOfPlanFiles: [],
        missingValidationCommands: [],
        highRiskIssues: [],
        diffExcerpts: [],
        status: 'needs_context',
        feedback: preflightIssues,
        blockedReason: 'Preflight planning needs more repository context.',
      };
    }
    const shouldRunDesignGate = workflowHasStage(contextScan.workflowDag, 'design-gate');
    const designReviewGate = shouldRunDesignGate
      ? buildDesignReviewGate({
          work: params.work,
          contextScan,
          workerPlan,
          requiredInstructions: params.projectSettings.effectiveInstructions,
        })
      : undefined;
    contextScan.designReviewGate = designReviewGate;
    const designReviewIssues = designReviewGate
      ? collectDesignReviewGateIssues(designReviewGate)
      : [];
    if (designReviewIssues.length > 0) {
      return {
        lane: params.lane,
        workspace,
        attemptNo: params.attemptNo,
        cycle: params.cycle,
        startedAt: attemptStartedAt,
        projectOverview,
        contextScan,
        workerPlan,
        planningState,
        attemptState: null,
        workerSummary: {
          summary: 'Design review gate blocked implementation before editing.',
          filesChanged: [],
          testsRun: [],
          remainingRisks: designReviewIssues,
        },
        validationPlan: {
          plannerCommands: [],
          autoAddedCommands: [],
          effectiveCommands: [],
          notes: ['Implementation did not start because the design review gate blocked the plan.'],
        },
        validationReruns: { passed: [], failed: [], failureDetails: [] },
        failureAnalysis: [],
        runtimeValidation: emptyRuntimeValidationResult(contextScan.runtimeValidation),
        patchIntentVerification: emptyPatchIntentVerification(
          'Design review gate blocked implementation before editing.',
        ),
        diffStats: { files: 0, additions: 0, deletions: 0, hunks: 0 },
        outOfPlanFiles: [],
        missingValidationCommands: [],
        highRiskIssues: designReviewIssues,
        diffExcerpts: [],
        status: 'needs_context',
        feedback: designReviewIssues,
        blockedReason: 'Design review gate blocked implementation before editing.',
      };
    }

    const worktreeBefore = await getGitWorktreeEntries(projectRoot);
    const dirtyFilesBefore = getDirtyWorktreePaths(worktreeBefore);
    const attemptState = createWorkerAttemptState(
      workerPlan,
      dirtyFilesBefore,
      projectRoot,
      contextScan.executionPolicy,
      contextScan.environmentContract,
      params.lane.subagent?.tools,
    );
    const workerRaw = await runToolAgent(
      params.lane.config,
      projectRoot,
      buildWorkerPrompt(
        params.work,
        projectOverview,
        contextScan,
        workerPlan,
        laneFeedback,
        params.projectSettings.effectiveInstructions,
        laneWorkerProfile,
      ),
      buildWorkerSystemPrompt(),
      true,
      params.signal,
      attemptState,
    );
    throwIfCanceled(params.options.sessionsDir, params.sessionPath, params.work.id, params.signal);

    const parsedWorkerSummary = parseWorkerSummary(workerRaw);
    const worktreeAfter = await getGitWorktreeEntries(projectRoot);
    const touchedFiles = uniqueStrings([
      ...detectTouchedFilesFromGitStatus(worktreeBefore, worktreeAfter),
      ...detectTouchedFilesFromDirtySnapshots(projectRoot, attemptState.dirtyFileSnapshots),
    ]).sort();
    const resolvedFilesChanged = resolveAttemptChangedFiles(
      touchedFiles,
      parsedWorkerSummary.filesChanged,
      [...attemptState.patchedFiles],
    );
    const actualCommandsRun = uniqueStrings(
      attemptState.commandsRun.map((command) => normalizeWhitespace(command)),
    );
    const workerSummary: WorkerSummary = {
      ...parsedWorkerSummary,
      filesChanged: resolvedFilesChanged,
      testsRun: actualCommandsRun.length > 0 ? actualCommandsRun : parsedWorkerSummary.testsRun,
    };
    const outOfPlanFiles = findOutOfPlanTouchedFiles(
      workerPlan.intendedFiles,
      workerSummary.filesChanged,
    );
    const missingValidationCommands = findMissingValidationCommands(
      workerPlan.validationCommands,
      workerSummary.testsRun,
    );
    const shouldRunValidation =
      workflowHasRequiredKind(contextScan.workflowDag, 'validate') ||
      contextScan.executionPolicy?.requireValidation !== false;
    const validationPlan = shouldRunValidation
      ? resolveValidationPlan(
          projectRoot,
          workerPlan.validationCommands,
          workerSummary.filesChanged,
          contextScan.environmentContract,
        )
      : {
          plannerCommands: [],
          autoAddedCommands: [],
          effectiveCommands: [],
          notes: ['Workflow DAG does not require validation and execution policy allows it.'],
        };
    const patchValidationIssues = await collectPatchValidationIssues(
      projectRoot,
      workerSummary.filesChanged,
    );
    const validationReruns = shouldRunValidation
      ? await rerunValidationCommands(
          projectRoot,
          validationPlan.effectiveCommands,
          params.signal,
          contextScan.environmentContract,
          contextScan.executionPolicy,
        )
      : { passed: [], failed: [], failureDetails: [] };
    throwIfCanceled(params.options.sessionsDir, params.sessionPath, params.work.id, params.signal);
    const diffExcerpts = await collectReviewerDiffExcerpts(projectRoot, workerSummary.filesChanged);
    const diffStats = await collectGitDiffStats(projectRoot, workerSummary.filesChanged);
    const runtimeSignal = buildRuntimeValidationSignal(
      workerPlan.taskType,
      workerSummary.filesChanged,
    );
    const runtimeValidation = await collectRuntimeValidationResult(runtimeSignal);
    const riskPolicy = assessRiskReviewPolicy({
      projectRoot,
      work: params.work,
      taskType: workerPlan.taskType,
      files: workerSummary.filesChanged,
      diffStats,
      runtimeValidation: runtimeSignal,
      runMode: params.projectSettings.runMode,
    });
    contextScan.runtimeValidation = runtimeSignal;
    contextScan.riskPolicy = riskPolicy;
    contextScan.orchestrationPlan = buildOrchestrationPlan({
      work: params.work,
      taskType: workerPlan.taskType,
      runMode: params.projectSettings.runMode,
      workerCount: params.workerCount,
      riskPolicy,
      runtimeValidation: runtimeSignal,
      subagentRegistry: contextScan.subagentRegistry,
      workflowDag: contextScan.workflowDag,
      environmentContract: contextScan.environmentContract,
      pluginConnectors: contextScan.pluginConnectors,
    });
    contextScan.reviewAdversarialPlan = buildReviewAdversarialPlan({
      taskType: workerPlan.taskType,
      files: workerSummary.filesChanged,
      riskPolicy,
      runtimeValidation: runtimeSignal,
      diffStats,
      semanticGraph: contextScan.semanticGraph,
    });
    contextScan.reviewerCalibration = buildReviewerCalibration(
      contextScan.projectProfile,
      riskPolicy,
      contextScan.reviewAdversarialPlan,
    );
    const failureAnalysis = analyzeValidationFailures(validationReruns);
    const patchIntentVerification = verifyPatchIntent({
      workerPlan,
      workerSummary,
      outOfPlanFiles,
      diffStats,
      diffExcerpts,
    });
    const selfCheckIssues = collectWorkerSelfCheckIssues({
      workerSummary,
      workerPlan,
      requiredInstructions: params.projectSettings.effectiveInstructions,
      validationPlan,
      filesChanged: workerSummary.filesChanged,
      diffExcerpts,
    });
    const reviewabilityIssues = collectAttemptReviewabilityIssues({
      rawWorkerOutput: workerRaw,
      workerSummary,
      workerPlan,
      diffExcerpts,
      gitDiffAvailable: worktreeAfter !== null,
    });
    const highRiskIssues = [
      ...(await collectHighRiskAttemptIssues(projectRoot, workerSummary.filesChanged)),
      ...patchValidationIssues,
      ...reviewabilityIssues,
      ...collectDirtyFileGuardrailIssues(workerPlan, dirtyFilesBefore, workerSummary.filesChanged),
      ...collectPlanGuardrailIssues(
        projectRoot,
        workerPlan,
        workerSummary.filesChanged,
        workerSummary.testsRun,
      ),
      ...collectPatchScopeIssues({
        workerPlan,
        filesChanged: workerSummary.filesChanged,
        diffStats,
      }),
      ...collectExecutionPolicyPatchIssues({
        policy: contextScan.executionPolicy,
        filesChanged: workerSummary.filesChanged,
        diffStats,
        riskLevel: riskPolicy.level,
      }),
      ...(patchIntentVerification.status === 'drift'
        ? patchIntentVerification.issues.map((issue) => `Patch intent drift: ${issue}`)
        : []),
      ...(runtimeValidation.applicable &&
      runtimeValidation.serverDetected &&
      runtimeValidation.status !== 'reachable'
        ? ['Runtime validation failed even though a dev server was detected.']
        : []),
    ];

    return {
      lane: params.lane,
      workspace,
      attemptNo: params.attemptNo,
      cycle: params.cycle,
      startedAt: attemptStartedAt,
      projectOverview,
      contextScan,
      workerPlan,
      planningState,
      attemptState,
      workerSummary,
      validationPlan,
      validationReruns,
      failureAnalysis,
      runtimeValidation,
      patchIntentVerification,
      diffStats,
      outOfPlanFiles,
      missingValidationCommands,
      highRiskIssues,
      diffExcerpts,
      rawWorkerOutput: workerRaw,
      status:
        highRiskIssues.length > 0
          ? 'blocked'
          : validationReruns.failed.length > 0 || selfCheckIssues.length > 0
            ? 'validation_failed'
            : 'reviewable',
      feedback:
        highRiskIssues.length > 0
          ? highRiskIssues
          : validationReruns.failed.length > 0 || selfCheckIssues.length > 0
            ? [
                ...validationReruns.failed.map(
                  (command) => `Planned validation failed when Kira reran it: ${command}`,
                ),
                ...failureAnalysis.map(
                  (item) => `Failure analysis (${item.category}): ${item.guidance}`,
                ),
                ...selfCheckIssues,
              ]
            : [],
      blockedReason:
        highRiskIssues.length > 0
          ? 'Automated safety validation failed.'
          : validationReruns.failed.length > 0 || selfCheckIssues.length > 0
            ? 'Validation or worker self-check failed.'
            : undefined,
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return buildWorkerAttemptFailureResult({
      lane: params.lane,
      workspace,
      attemptNo: params.attemptNo,
      cycle: params.cycle,
      startedAt: attemptStartedAt,
      projectOverview: fallbackOverview,
      contextScan: fallbackContextScan,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function saveWorkerAttemptResult(
  sessionsDir: string,
  sessionPath: string,
  workId: string,
  result: KiraWorkerAttemptResult,
  status: KiraAttemptRecord['status'],
  extraRisks: string[] = [],
  reviewSummary?: ReviewSummary,
): void {
  saveAttemptRecord(
    sessionsDir,
    sessionPath,
    buildAttemptRecord({
      workId,
      attemptNo: result.attemptNo,
      status,
      startedAt: result.startedAt,
      contextScan: result.contextScan,
      workerPlan: result.workerPlan,
      planningState: result.planningState,
      attemptState: result.attemptState,
      workerSummary: result.workerSummary,
      validationPlan: result.validationPlan,
      validationReruns: result.validationReruns,
      failureAnalysis: result.failureAnalysis,
      runtimeValidation: result.runtimeValidation,
      riskPolicy: result.contextScan.riskPolicy,
      patchIntentVerification: result.patchIntentVerification,
      diffStats: result.diffStats,
      outOfPlanFiles: result.outOfPlanFiles,
      validationGaps: result.missingValidationCommands,
      risks: uniqueStrings([
        ...result.workerSummary.remainingRisks,
        ...result.highRiskIssues,
        ...result.feedback,
        ...extraRisks,
      ]),
      diffExcerpts: result.diffExcerpts,
      rawWorkerOutput: result.rawWorkerOutput,
      blockedReason: result.blockedReason,
      reviewSummary,
    }),
  );
}

function addWorkerAttemptComment(
  sessionsDir: string,
  sessionPath: string,
  work: WorkTask,
  result: KiraWorkerAttemptResult,
): void {
  addComment(sessionsDir, sessionPath, {
    taskId: work.id,
    taskType: 'work',
    author: buildAgentLabel(WORKER_AUTHOR, result.lane.label),
    body: [
      `Attempt ${result.attemptNo} finished from ${result.lane.label}.`,
      '',
      `Isolated worktree:\n${result.workspace.projectRoot}`,
      '',
      `Status:\n${result.status}`,
      '',
      `Plan:\n${result.workerPlan.summary}`,
      '',
      `Task type:\n${result.workerPlan.taskType}`,
      '',
      formatPatchAlternatives(result.workerPlan.approachAlternatives),
      '',
      formatRequirementTrace(
        result.workerSummary.selfCheck?.requirementTrace.length
          ? result.workerSummary.selfCheck.requirementTrace
          : result.workerPlan.requirementTrace,
      ),
      '',
      `Summary:\n${result.workerSummary.summary}`,
      '',
      `Files changed:\n${formatList(result.workerSummary.filesChanged, 'No files reported')}`,
      '',
      `Checks:\n${formatList(result.workerSummary.testsRun, 'No checks reported')}`,
      '',
      result.workerSummary.selfCheck
        ? `Self-check:\n${formatList(
            [
              `reviewedDiff=${result.workerSummary.selfCheck.reviewedDiff}`,
              `followedProjectInstructions=${result.workerSummary.selfCheck.followedProjectInstructions}`,
              `matchedPlan=${result.workerSummary.selfCheck.matchedPlan}`,
              `ranOrExplainedValidation=${result.workerSummary.selfCheck.ranOrExplainedValidation}`,
              ...result.workerSummary.selfCheck.diffHunkReview.map(
                (item) => `diffHunkReview ${item.file}: ${item.intent} Risk: ${item.risk}`,
              ),
              ...result.workerSummary.selfCheck.uncertainty.map((item) => `uncertainty: ${item}`),
            ],
            'No self-check details',
          )}`
        : 'Self-check:\n- Missing self-check object',
      '',
      `Diff stats:\n- files=${result.diffStats.files}\n- additions=${result.diffStats.additions}\n- deletions=${result.diffStats.deletions}\n- hunks=${result.diffStats.hunks}`,
      '',
      formatRiskReviewPolicy(result.contextScan.riskPolicy),
      '',
      formatDesignReviewGate(result.contextScan.designReviewGate),
      '',
      formatReviewAdversarialPlan(result.contextScan.reviewAdversarialPlan),
      '',
      formatRuntimeValidationResult(result.runtimeValidation),
      '',
      formatPatchIntentVerification(result.patchIntentVerification),
      '',
      `Kira-passed validation reruns:\n${formatList(
        result.validationReruns.passed,
        'No validation reruns passed',
      )}`,
      '',
      `Kira validation failures:\n${formatList(
        result.validationReruns.failed,
        'No validation reruns failed',
      )}`,
      '',
      formatFailureAnalysis(result.failureAnalysis),
      '',
      `Remaining risks:\n${formatList(
        [...result.workerSummary.remainingRisks, ...result.highRiskIssues, ...result.feedback],
        'None reported',
      )}`,
      '',
      `Validation gaps:\n${formatList(
        result.missingValidationCommands,
        'No missing planned checks',
      )}`,
      '',
      `Out-of-plan files:\n${formatList(result.outOfPlanFiles, 'No out-of-plan files')}`,
      '',
      `Worker submission:\n${formatWorkerSubmission(result.rawWorkerOutput)}`,
    ].join('\n'),
  });
}

function loadProjectWorks(
  sessionsDir: string,
  sessionPath: string,
  projectName: string,
): WorkTask[] {
  const worksDir = join(getKiraDataDir(sessionsDir, sessionPath), WORKS_DIR_NAME);
  return listJsonFiles(worksDir)
    .map((filePath) => readJsonFile<WorkTask>(filePath))
    .filter((work): work is WorkTask => work !== null && work.projectName === projectName);
}

async function analyzeProjectForDiscovery(
  options: KiraAutomationPluginOptions,
  sessionPath: string,
  projectName: string,
  res: { write: (chunk: string) => unknown },
): Promise<ProjectDiscoveryAnalysis> {
  sendSseEvent(res, { type: 'log', message: `Preparing discovery run for ${projectName}...` });

  const runtime = getKiraRuntimeSettings(options.configFile, options.getWorkRootDirectory());
  if (!runtime.reviewerConfig) {
    throw new Error('No usable LLM config was found in config.json.');
  }

  const projectRoot = resolveKiraProjectRoot(runtime.workRootDirectory, projectName);
  if (!runtime.workRootDirectory || !projectName || !fs.existsSync(projectRoot)) {
    throw new Error(`Project root was not found for ${projectName}.`);
  }

  const previousAnalysis = loadProjectDiscoveryAnalysis(
    options.sessionsDir,
    sessionPath,
    projectName,
  );
  if (previousAnalysis) {
    sendSseEvent(res, {
      type: 'log',
      message: `Loaded previous analysis from ${new Date(previousAnalysis.updatedAt).toLocaleString()}.`,
    });
  } else {
    sendSseEvent(res, {
      type: 'log',
      message: 'No previous saved analysis found for this project.',
    });
  }

  sendSseEvent(res, { type: 'log', message: 'Scanning the project overview and source map...' });
  const projectOverview = buildProjectOverview(projectRoot);

  sendSseEvent(res, {
    type: 'log',
    message: 'Aoi is reviewing the codebase and collecting candidate tasks...',
  });
  const raw = await runToolAgent(
    runtime.reviewerConfig,
    projectRoot,
    buildProjectDiscoveryPrompt(projectName, projectOverview, previousAnalysis),
    buildProjectDiscoverySystemPrompt(),
    false,
  );

  sendSseEvent(res, {
    type: 'log',
    message: 'Normalizing the findings and saving them for later reuse...',
  });
  const analysis = parseProjectDiscoveryAnalysis(raw, projectName, projectRoot, previousAnalysis);
  saveProjectDiscoveryAnalysis(options.sessionsDir, sessionPath, analysis);

  sendSseEvent(res, {
    type: 'log',
    message:
      analysis.findings.length > 0
        ? `Discovery complete. Found ${analysis.findings.length} candidate tasks.`
        : 'Discovery complete, but no actionable tasks were identified.',
  });

  return analysis;
}

function createWorksFromDiscovery(
  options: KiraAutomationPluginOptions,
  sessionPath: string,
  analysis: ProjectDiscoveryAnalysis,
): { created: WorkTask[]; skippedTitles: string[] } {
  const worksDir = join(getKiraDataDir(options.sessionsDir, sessionPath), WORKS_DIR_NAME);
  fs.mkdirSync(worksDir, { recursive: true });

  const existingTitles = new Set(
    loadProjectWorks(options.sessionsDir, sessionPath, analysis.projectName).map((work) =>
      work.title.trim().toLowerCase(),
    ),
  );

  const created: WorkTask[] = [];
  const skippedTitles: string[] = [];

  for (const finding of analysis.findings.slice(0, MAX_DISCOVERY_FINDINGS)) {
    const normalizedTitle = finding.title.trim().toLowerCase();
    if (!normalizedTitle || existingTitles.has(normalizedTitle)) {
      skippedTitles.push(finding.title);
      continue;
    }

    const now = Date.now();
    const work: WorkTask = {
      id: makeId('work'),
      type: 'work',
      projectName: analysis.projectName,
      title: finding.title.trim(),
      description: finding.taskDescription.trim() || buildFallbackTaskDescription(finding),
      status: 'todo',
      assignee: '',
      createdAt: now,
      updatedAt: now,
    };
    writeJsonFile(join(worksDir, `${work.id}.json`), work);
    created.push(work);
    existingTitles.add(normalizedTitle);
  }

  return { created, skippedTitles };
}

function shouldAutoDecomposeWork(recommendation: WorkDecompositionRecommendation): boolean {
  return (
    recommendation.shouldSplit &&
    recommendation.confidence >= 0.88 &&
    recommendation.suggestedWorks.length >= 2
  );
}

function createWorksFromDecomposition(
  options: KiraAutomationPluginOptions,
  sessionPath: string,
  parentWork: WorkTask,
  recommendation: WorkDecompositionRecommendation,
): { created: WorkTask[]; skippedTitles: string[] } {
  const worksDir = join(getKiraDataDir(options.sessionsDir, sessionPath), WORKS_DIR_NAME);
  fs.mkdirSync(worksDir, { recursive: true });
  const existingTitles = new Set(
    loadProjectWorks(options.sessionsDir, sessionPath, parentWork.projectName).map((work) =>
      work.title.trim().toLowerCase(),
    ),
  );
  const created: WorkTask[] = [];
  const skippedTitles: string[] = [];

  for (const [index, suggestedWork] of recommendation.suggestedWorks.entries()) {
    const title = `${parentWork.title}: ${suggestedWork}`.slice(0, 180);
    const normalizedTitle = title.trim().toLowerCase();
    if (!normalizedTitle || existingTitles.has(normalizedTitle)) {
      skippedTitles.push(title);
      continue;
    }
    const now = Date.now();
    const work: WorkTask = {
      id: makeId('work'),
      type: 'work',
      projectName: parentWork.projectName,
      title,
      description: [
        `# Brief`,
        suggestedWork,
        '',
        `# Parent work`,
        `- ${parentWork.title}`,
        '',
        `# Parent acceptance target`,
        parentWork.description,
        '',
        `# Decomposition context`,
        recommendation.reason,
        '',
        `# Ordering note`,
        `This is split item ${index + 1} of ${recommendation.suggestedWorks.length}. Keep the patch independently reviewable and avoid taking over sibling split items unless required for integration.`,
      ].join('\n'),
      status: 'todo',
      assignee: '',
      createdAt: now,
      updatedAt: now,
    };
    writeJsonFile(join(worksDir, `${work.id}.json`), work);
    created.push(work);
    existingTitles.add(normalizedTitle);
  }

  return { created, skippedTitles };
}

async function processWorkWithMultipleWorkers(params: {
  options: KiraAutomationPluginOptions;
  sessionPath: string;
  work: WorkTask;
  runtime: ReturnType<typeof getKiraRuntimeSettings>;
  primaryProjectRoot: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { options, sessionPath, work, runtime, primaryProjectRoot, signal } = params;
  if (!runtime.reviewerConfig) {
    throw new Error('No usable reviewer LLM config was found in config.json.');
  }
  const projectSettings = loadProjectSettings(primaryProjectRoot, runtime.defaultProjectSettings);
  const lanes = buildWorkerLanes(runtime.workerConfigs, projectSettings.subagents);
  if (!(await isGitWorktree(primaryProjectRoot))) {
    updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
      ...current,
      status: 'blocked',
    }));
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        'Automation blocked because multiple workers require git worktree isolation.',
        '',
        'Configure one worker for non-git projects, or initialize the project as a git repository before retrying.',
      ].join('\n'),
    });
    enqueueEvent(options.sessionsDir, sessionPath, {
      id: makeId('event'),
      workId: work.id,
      title: work.title,
      projectName: work.projectName,
      type: 'needs_attention',
      createdAt: Date.now(),
      message: `Kira blocked: "${work.title}" 작업은 여러 worker 격리를 위해 git worktree가 필요해요.`,
    });
    return;
  }

  const safetyIssues = await collectProjectSafetyIssues(primaryProjectRoot, projectSettings);
  if (safetyIssues.length > 0) {
    updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
      ...current,
      status: 'blocked',
      assignee: current.assignee || runtime.workerAuthor,
    }));
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        'Automation blocked before start due to project safety checks.',
        '',
        `Issues:\n${formatList(safetyIssues, 'No details provided')}`,
      ].join('\n'),
    });
    return;
  }

  const existingComments = loadTaskComments(options.sessionsDir, sessionPath, work.id);
  const manualEvidence = collectManualEvidenceFromComments(existingComments);
  let feedback =
    work.status === 'in_progress' ? extractLatestReviewerFeedback(existingComments) : [];
  let previousIssueSignature: string | null = null;
  let repeatedIssueCount = 0;

  updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
    ...current,
    status: 'in_progress',
    assignee: current.assignee || runtime.workerAuthor,
  }));
  enqueueEvent(options.sessionsDir, sessionPath, {
    id: makeId('event'),
    workId: work.id,
    title: work.title,
    projectName: work.projectName,
    type: work.status === 'in_progress' ? 'resumed' : 'started',
    createdAt: Date.now(),
    message:
      work.status === 'in_progress'
        ? `Kira 재개: "${work.title}" 작업을 ${lanes.length}개 worker로 다시 진행할게요.`
        : `Kira 시작: "${work.title}" 작업을 ${lanes.length}개 worker로 자동 시작할게요.`,
  });
  addComment(options.sessionsDir, sessionPath, {
    taskId: work.id,
    taskType: 'work',
    author: runtime.workerAuthor,
    body: [
      `Picked up the task with ${lanes.length} isolated workers in ${work.projectName}.`,
      '',
      `Workers:\n${formatList(
        lanes.map((lane) => lane.label),
        'No workers configured',
      )}`,
      '',
      'Each worker will produce an independent attempt in its own git worktree. The reviewer will compare passing attempts and select one winner.',
    ].join('\n'),
  });

  for (let cycle = 1; cycle <= MAX_REVIEW_CYCLES; cycle += 1) {
    throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);
    const results = await Promise.all(
      lanes.map((lane, index) =>
        runIsolatedWorkerAttempt({
          options,
          sessionPath,
          work,
          lane,
          workerCount: lanes.length,
          cycle,
          attemptNo: (cycle - 1) * lanes.length + index + 1,
          primaryProjectRoot,
          projectSettings,
          feedback,
          manualEvidence,
          signal,
        }),
      ),
    );
    throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);

    for (const result of results) {
      addWorkerAttemptComment(options.sessionsDir, sessionPath, work, result);
      const attemptStatus: KiraAttemptRecord['status'] =
        result.status === 'needs_context'
          ? 'needs_context'
          : result.status === 'validation_failed'
            ? 'validation_failed'
            : result.status === 'reviewable'
              ? 'reviewable'
              : 'blocked';
      saveWorkerAttemptResult(options.sessionsDir, sessionPath, work.id, result, attemptStatus);
    }

    const reviewableAttempts = results.filter((result) => result.status === 'reviewable');
    if (reviewableAttempts.length === 0) {
      feedback = uniqueStrings(results.flatMap((result) => result.feedback)).slice(0, 12);
      updateProjectProfileLearning(primaryProjectRoot, {
        validationFailures: feedback,
        repeatedPatterns: feedback.filter((item) =>
          /\b(validation|self-check|high-risk|protected|out-of-plan|small-patch|split)\b/i.test(
            item,
          ),
        ),
      });
      const issueSignature = buildIssueSignature(feedback, 'No worker attempts passed validation.');
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: [
          `No worker attempts were ready for review after cycle ${cycle}.`,
          '',
          `Issues:\n${formatList(feedback, 'No detailed issues provided')}`,
        ].join('\n'),
      });
      await Promise.all(results.map((result) => cleanupKiraWorktreeSession(result.workspace)));
      if (issueSignature === previousIssueSignature) {
        repeatedIssueCount += 1;
      } else {
        repeatedIssueCount = 1;
        previousIssueSignature = issueSignature;
      }
      if (repeatedIssueCount >= 2) break;
      continue;
    }

    updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
      ...current,
      status: 'in_review',
    }));
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        `Started review for cycle ${cycle}.`,
        '',
        `Reviewable attempts:\n${formatList(
          reviewableAttempts.map(
            (attempt) => `Attempt ${attempt.attemptNo} from ${attempt.lane.label}`,
          ),
          'No reviewable attempts',
        )}`,
        '',
        `Files changed:\n${formatList(
          uniqueStrings(
            reviewableAttempts.flatMap((attempt) => attempt.workerSummary.filesChanged),
          ),
          'No changed files recorded',
        )}`,
      ].join('\n'),
    });
    const synthesisRecommendation = buildAttemptSynthesisRecommendation(reviewableAttempts);
    const selectionStartedAt = Date.now();
    const selectionRaw = await runToolAgent(
      runtime.reviewerConfig,
      primaryProjectRoot,
      buildAttemptComparisonReviewPrompt(
        work,
        reviewableAttempts,
        projectSettings.effectiveInstructions,
        synthesisRecommendation,
      ),
      buildAttemptComparisonReviewSystemPrompt(),
      false,
      signal,
    );
    const selectionFinishedAt = Date.now();
    throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);
    let selection = parseAttemptSelectionSummary(
      selectionRaw,
      reviewableAttempts.map((attempt) => attempt.attemptNo),
    );
    let selectedAttempt = selection.selectedAttemptNo
      ? reviewableAttempts.find((attempt) => attempt.attemptNo === selection.selectedAttemptNo)
      : null;
    selection = enforceAttemptSelectionDecision(selection, selectedAttempt ?? null);
    selectedAttempt = selection.selectedAttemptNo
      ? reviewableAttempts.find((attempt) => attempt.attemptNo === selection.selectedAttemptNo)
      : null;

    if (selection.approved && selectedAttempt) {
      const completionPolicyIssues = collectExecutionPolicyCompletionIssues({
        policy: selectedAttempt.contextScan.executionPolicy,
        filesChanged: selectedAttempt.workerSummary.filesChanged,
        diffStats: selectedAttempt.diffStats,
        riskLevel: selectedAttempt.contextScan.riskPolicy?.level,
      });
      if (completionPolicyIssues.length > 0) {
        saveWorkerAttemptResult(
          options.sessionsDir,
          sessionPath,
          work.id,
          selectedAttempt,
          'blocked',
          completionPolicyIssues,
        );
        updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
          ...current,
          status: 'blocked',
        }));
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: [
            `Execution policy blocked selected attempt ${selectedAttempt.attemptNo} after review approval.`,
            '',
            `Issues:\n${formatList(completionPolicyIssues, 'No details provided')}`,
          ].join('\n'),
        });
        await Promise.all(results.map((result) => cleanupKiraWorktreeSession(result.workspace)));
        return;
      }
      const selectedReview = buildAttemptSelectionReviewRecord({
        workId: work.id,
        attempt: selectedAttempt,
        reviewSummary: buildAttemptSelectionReviewSummary(selection, true),
        attemptSynthesis: synthesisRecommendation,
        startedAt: selectionStartedAt,
        finishedAt: selectionFinishedAt,
        reviewRaw: selectionRaw,
      });
      updateProjectProfileLearning(primaryProjectRoot, {
        successfulPatterns: [
          `${selectedAttempt.workerPlan.taskType}: selected attempt ${selectedAttempt.attemptNo} with ${selectedAttempt.validationReruns.passed.length} validation checks and ${selection.evidenceChecked.length} judge evidence entries.`,
        ],
      });
      saveReviewRecord(options.sessionsDir, sessionPath, selectedReview.record);
      for (const result of reviewableAttempts) {
        const reviewForAttempt =
          result.attemptNo === selectedAttempt.attemptNo
            ? selectedReview
            : buildAttemptSelectionReviewRecord({
                workId: work.id,
                attempt: result,
                reviewSummary: buildAttemptSelectionReviewSummary(selection, false, {
                  summary: [
                    `Not selected by reviewer. Winning attempt: ${selectedAttempt.attemptNo}.`,
                    '',
                    selection.summary,
                  ].join('\n'),
                  issues: [
                    `Not selected by reviewer. Winning attempt: ${selectedAttempt.attemptNo}.`,
                  ],
                  filesChecked: [],
                  evidenceChecked: [],
                  requirementVerdicts: [],
                  adversarialChecks: [],
                  nextWorkerInstructions: [],
                  residualRisk: [],
                }),
                attemptSynthesis: synthesisRecommendation,
                startedAt: selectionStartedAt,
                finishedAt: selectionFinishedAt,
                reviewRaw: selectionRaw,
              });
        if (result.attemptNo !== selectedAttempt.attemptNo) {
          saveReviewRecord(options.sessionsDir, sessionPath, reviewForAttempt.record);
        }
        saveWorkerAttemptResult(
          options.sessionsDir,
          sessionPath,
          work.id,
          result,
          result.attemptNo === selectedAttempt.attemptNo ? 'approved' : 'review_requested_changes',
          result.attemptNo === selectedAttempt.attemptNo
            ? selection.residualRisk
            : [`Not selected by reviewer. Winning attempt: ${selectedAttempt.attemptNo}`],
          reviewForAttempt.reviewSummary,
        );
      }
      const suggestedCommitMessage = buildSuggestedCommitMessage(
        work,
        selectedAttempt.workerSummary,
      );
      const projectLockPath = getProjectLockPath(
        options.sessionsDir,
        getProjectKey(runtime.workRootDirectory, work, sessionPath),
      );
      const integrationResult = projectSettings.autoCommit
        ? await autoCommitApprovedWork(
            selectedAttempt.workspace,
            selectedAttempt.workerSummary.filesChanged,
            suggestedCommitMessage,
            runtime.defaultProjectSettings,
            projectLockPath,
          )
        : await integrateApprovedWorktreeChanges(
            selectedAttempt.workspace,
            selectedAttempt.workerSummary.filesChanged,
            suggestedCommitMessage,
            projectLockPath,
          );
      const connectorEvidence =
        integrationResult.status === 'committed'
          ? await collectConnectorIntegrationEvidence({
              projectRoot: selectedAttempt.workspace.primaryRoot,
              work,
              commitMessage: suggestedCommitMessage,
              commitHash: integrationResult.commitHash,
              connectors: projectSettings.plugins,
            })
          : [];
      updateAttemptRecordIntegration(
        options.sessionsDir,
        sessionPath,
        work.id,
        selectedAttempt.attemptNo,
        {
          status: integrationResult.status,
          message: integrationResult.message,
          ...(integrationResult.commitHash ? { commitHash: integrationResult.commitHash } : {}),
          pullRequestUrl: connectorEvidence.find((item) => item.url)?.url,
          connectors: connectorEvidence,
          createdAt: Date.now(),
        },
      );

      if (integrationResult.status === 'failed') {
        updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
          ...current,
          status: 'blocked',
        }));
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: [
            `Approved attempt ${selectedAttempt.attemptNo}, but integration failed.`,
            '',
            integrationResult.message,
          ].join('\n'),
        });
        await Promise.all(
          results
            .filter((result) => result.attemptNo !== selectedAttempt.attemptNo)
            .map((result) => cleanupKiraWorktreeSession(result.workspace)),
        );
        return;
      }

      updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
        ...current,
        status: 'done',
      }));
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: [
          `Approved attempt ${selectedAttempt.attemptNo}.`,
          '',
          selection.summary,
          '',
          `Selected worker: ${selectedAttempt.lane.label}`,
        ].join('\n'),
      });
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: `Suggested commit message:\n${suggestedCommitMessage}`,
      });
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: `Integrated winning attempt.\n\n${integrationResult.message}`,
      });
      if (connectorEvidence.length > 0) {
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: [
            'Connector integration evidence recorded.',
            '',
            ...connectorEvidence.map((item) =>
              [
                `${item.connectorId}: ${item.status}`,
                item.summary,
                item.url ? `URL: ${item.url}` : '',
                `Evidence:\n${formatList(item.evidence, 'No connector evidence')}`,
              ]
                .filter(Boolean)
                .join('\n'),
            ),
          ].join('\n\n'),
        });
      }
      await Promise.all(results.map((result) => cleanupKiraWorktreeSession(result.workspace)));
      enqueueEvent(options.sessionsDir, sessionPath, {
        id: makeId('event'),
        workId: work.id,
        title: work.title,
        projectName: work.projectName,
        type: 'completed',
        createdAt: Date.now(),
        message: `Kira 완료: "${work.title}" 작업에서 attempt ${selectedAttempt.attemptNo}를 선택해 통합했어요.`,
      });
      return;
    }

    feedback =
      selection.nextWorkerInstructions.length > 0
        ? selection.nextWorkerInstructions
        : selection.issues.length > 0
          ? selection.issues
          : [selection.summary];
    updateProjectProfileLearning(primaryProjectRoot, {
      reviewFailures: uniqueStrings([...selection.issues, ...selection.nextWorkerInstructions]),
      repeatedPatterns: selection.issues.filter((item) =>
        /\b(validation|regression|risk|missing|violates|instruction|diffhunkreview|fileschecked|small-patch|split)\b/i.test(
          item,
        ),
      ),
    });
    for (const result of reviewableAttempts) {
      const rejectedReview = buildAttemptSelectionReviewRecord({
        workId: work.id,
        attempt: result,
        reviewSummary: buildAttemptSelectionReviewSummary(selection, false),
        attemptSynthesis: synthesisRecommendation,
        startedAt: selectionStartedAt,
        finishedAt: selectionFinishedAt,
        reviewRaw: selectionRaw,
      });
      saveReviewRecord(options.sessionsDir, sessionPath, rejectedReview.record);
      saveWorkerAttemptResult(
        options.sessionsDir,
        sessionPath,
        work.id,
        result,
        'review_requested_changes',
        feedback,
        rejectedReview.reviewSummary,
      );
    }
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        `Reviewer did not approve any attempts after cycle ${cycle}.`,
        '',
        formatAttemptSynthesisRecommendation(synthesisRecommendation),
        '',
        `Summary:\n${selection.summary}`,
        '',
        `Issues:\n${formatList(selection.issues, 'No detailed issues provided')}`,
        '',
        `Next worker instructions:\n${formatList(
          selection.nextWorkerInstructions,
          'No next instructions provided',
        )}`,
      ].join('\n'),
    });
    await Promise.all(results.map((result) => cleanupKiraWorktreeSession(result.workspace)));

    const issueSignature = buildIssueSignature(selection.issues, selection.summary);
    if (issueSignature === previousIssueSignature) {
      repeatedIssueCount += 1;
    } else {
      repeatedIssueCount = 1;
      previousIssueSignature = issueSignature;
    }
    if (repeatedIssueCount >= 2) break;
    if (cycle < MAX_REVIEW_CYCLES) {
      updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
        ...current,
        status: 'in_progress',
      }));
    }
  }

  updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
    ...current,
    status: 'blocked',
  }));
  addComment(options.sessionsDir, sessionPath, {
    taskId: work.id,
    taskType: 'work',
    author: runtime.reviewerAuthor,
    body: [
      `Blocked after ${MAX_REVIEW_CYCLES} multi-worker review cycles.`,
      '',
      `Summary:\n${feedback[0] ?? 'No worker attempt satisfied the review requirements.'}`,
      '',
      `Issues:\n${formatList(feedback, 'No detailed issues provided')}`,
    ].join('\n'),
  });
  enqueueEvent(options.sessionsDir, sessionPath, {
    id: makeId('event'),
    workId: work.id,
    title: work.title,
    projectName: work.projectName,
    type: 'needs_attention',
    createdAt: Date.now(),
    message: `Kira blocked: "${work.title}" 작업이 여러 worker 재시도 후에도 리뷰를 통과하지 못했어요.`,
  });
}

async function processWork(
  options: KiraAutomationPluginOptions,
  sessionPath: string,
  workId: string,
  signal?: AbortSignal,
): Promise<void> {
  const runtime = getKiraRuntimeSettings(options.configFile, options.getWorkRootDirectory());
  const dataDir = getKiraDataDir(options.sessionsDir, sessionPath);
  let work = readJsonFile<WorkTask>(join(dataDir, WORKS_DIR_NAME, `${workId}.json`));
  if (!work || (work.status !== 'todo' && work.status !== 'in_progress')) return;

  if (!runtime.workerConfig || !runtime.reviewerConfig) {
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: 'Automation could not start because no usable LLM config was found in config.json.',
    });
    enqueueEvent(options.sessionsDir, sessionPath, {
      id: makeId('event'),
      workId: work.id,
      title: work.title,
      projectName: work.projectName,
      type: 'needs_attention',
      createdAt: Date.now(),
      message: `Kira 자동화 보류: "${work.title}" 작업을 처리할 LLM 설정이 없어요.`,
    });
    return;
  }

  const primaryProjectRoot = resolveKiraProjectRoot(runtime.workRootDirectory, work.projectName);
  if (!runtime.workRootDirectory || !work.projectName || !fs.existsSync(primaryProjectRoot)) {
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: 'Automation could not start because the project root directory for this work was not found.',
    });
    enqueueEvent(options.sessionsDir, sessionPath, {
      id: makeId('event'),
      workId: work.id,
      title: work.title,
      projectName: work.projectName,
      type: 'needs_attention',
      createdAt: Date.now(),
      message: `Kira 자동화 보류: "${work.title}" 작업의 프로젝트 루트를 찾지 못했어요.`,
    });
    return;
  }

  const clarifiedWork = await ensureWorkClarification(
    options,
    sessionPath,
    work,
    runtime,
    primaryProjectRoot,
    signal,
  );
  if (!clarifiedWork) return;
  work = clarifiedWork;

  const projectSettings = loadProjectSettings(primaryProjectRoot, runtime.defaultProjectSettings);
  const initialContextScan = await buildProjectContextScan(
    primaryProjectRoot,
    work,
    projectSettings.effectiveInstructions,
    projectSettings.runMode,
    projectSettings.runMode === 'quick' ? 1 : runtime.workerConfigs.length,
    projectSettings,
  );
  if (
    initialContextScan.decomposition &&
    shouldAutoDecomposeWork(initialContextScan.decomposition)
  ) {
    const { created, skippedTitles } = createWorksFromDecomposition(
      options,
      sessionPath,
      work,
      initialContextScan.decomposition,
    );
    updateProjectProfileLearning(primaryProjectRoot, {
      decompositionRecommendations: initialContextScan.decomposition.suggestedWorks,
    });
    updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
      ...current,
      status: 'blocked',
    }));
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        'Kira decomposed this broad work before assigning workers.',
        '',
        `Reason:\n${initialContextScan.decomposition.reason}`,
        '',
        `Signals:\n${formatList(initialContextScan.decomposition.signals, 'No split signals')}`,
        '',
        `Created split works:\n${formatList(
          created.map((item) => item.title),
          'No split works were created',
        )}`,
        '',
        `Skipped duplicates:\n${formatList(skippedTitles, 'No duplicate split works skipped')}`,
        '',
        'The original work is blocked so the smaller tasks can be handled independently.',
      ].join('\n'),
    });
    enqueueEvent(options.sessionsDir, sessionPath, {
      id: makeId('event'),
      workId: work.id,
      title: work.title,
      projectName: work.projectName,
      type: 'needs_attention',
      createdAt: Date.now(),
      message: `Kira 분해: "${work.title}" 작업이 너무 넓어 ${created.length}개의 작은 작업으로 나눴어요.`,
    });
    return;
  }

  if (runtime.workerConfigs.length > 1 && projectSettings.runMode !== 'quick') {
    await processWorkWithMultipleWorkers({
      options,
      sessionPath,
      work,
      runtime,
      primaryProjectRoot,
      signal,
    });
    return;
  }

  const workspace = await createKiraWorktreeSession(
    primaryProjectRoot,
    options.sessionsDir,
    sessionPath,
    work,
    projectSettings,
  );
  if (!workspace.isolated && shouldUseKiraIsolatedWorktree(primaryProjectRoot, projectSettings)) {
    updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
      ...current,
      status: 'blocked',
    }));
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        'Automation blocked because Kira could not create an isolated git worktree.',
        '',
        'The task was not run in the primary worktree because auto-commit is enabled and concurrent work requires isolation.',
      ].join('\n'),
    });
    enqueueEvent(options.sessionsDir, sessionPath, {
      id: makeId('event'),
      workId: work.id,
      title: work.title,
      projectName: work.projectName,
      type: 'needs_attention',
      createdAt: Date.now(),
      message: `Kira blocked: "${work.title}" 작업용 격리 worktree를 만들 수 없어 기본 워크트리를 보호했어요.`,
    });
    return;
  }
  const projectRoot = workspace.projectRoot;

  const safetyIssues = await collectProjectSafetyIssues(projectRoot, projectSettings);
  if (safetyIssues.length > 0) {
    updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
      ...current,
      status: 'blocked',
      assignee: current.assignee || runtime.workerAuthor,
    }));
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        'Automation blocked before start due to project safety checks.',
        '',
        `Issues:\n${formatList(safetyIssues, 'No details provided')}`,
        '',
        'Please restore the project to a healthy state before retrying this work.',
      ].join('\n'),
    });
    enqueueEvent(options.sessionsDir, sessionPath, {
      id: makeId('event'),
      workId: work.id,
      title: work.title,
      projectName: work.projectName,
      type: 'needs_attention',
      createdAt: Date.now(),
      message: `Kira blocked: "${work.title}" 작업을 시작하기 전에 프로젝트 손상 징후가 발견됐어요.`,
    });
    return;
  }

  const environmentExecution = await runEnvironmentSetup(
    projectRoot,
    projectSettings.environment,
    signal,
    projectSettings.executionPolicy,
  );
  const environmentExecutionIssues = collectEnvironmentExecutionIssues(environmentExecution);
  if (environmentExecutionIssues.length > 0) {
    updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
      ...current,
      status: 'blocked',
      assignee: current.assignee || runtime.workerAuthor,
    }));
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        'Automation blocked before worker start due to the project environment contract.',
        '',
        `Issues:\n${formatList(environmentExecutionIssues, 'No details provided')}`,
      ].join('\n'),
    });
    enqueueEvent(options.sessionsDir, sessionPath, {
      id: makeId('event'),
      workId: work.id,
      title: work.title,
      projectName: work.projectName,
      type: 'needs_attention',
      createdAt: Date.now(),
      message: `Kira blocked: "${work.title}" 작업의 환경 준비 단계가 실패했어요.`,
    });
    return;
  }

  const projectOverview = buildProjectOverview(projectRoot);
  const contextScan = await buildProjectContextScan(
    projectRoot,
    work,
    projectSettings.effectiveInstructions,
    projectSettings.runMode,
    1,
    projectSettings,
  );
  contextScan.environmentExecution = environmentExecution;
  const existingComments = loadTaskComments(options.sessionsDir, sessionPath, work.id);
  contextScan.manualEvidence = collectManualEvidenceFromComments(existingComments);
  const activeSubagent = getPrimaryImplementationSubagent(contextScan.subagentRegistry);
  const resumeFeedback =
    work.status === 'in_progress' ? extractLatestReviewerFeedback(existingComments) : [];

  throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);

  updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
    ...current,
    status: 'in_progress',
    assignee: current.assignee || runtime.workerAuthor,
  }));
  enqueueEvent(options.sessionsDir, sessionPath, {
    id: makeId('event'),
    workId: work.id,
    title: work.title,
    projectName: work.projectName,
    type: work.status === 'in_progress' ? 'resumed' : 'started',
    createdAt: Date.now(),
    message:
      work.status === 'in_progress'
        ? `Kira 재개: "${work.title}" 작업을 다시 이어서 진행할게요.`
        : `Kira 시작: "${work.title}" 작업을 자동으로 시작할게요.`,
  });
  addComment(options.sessionsDir, sessionPath, {
    taskId: work.id,
    taskType: 'work',
    author: runtime.workerAuthor,
    body:
      work.status === 'in_progress'
        ? `Detected a stalled task and resumed implementation in ${work.projectName}.`
        : [
            `Picked up the task and started implementation in ${work.projectName}.`,
            workspace.isolated
              ? `Using isolated git worktree: ${workspace.projectRoot}`
              : 'Using the primary project worktree.',
          ].join('\n\n'),
  });

  let feedback: string[] = resumeFeedback;
  let previousIssueSignature: string | null = null;
  let repeatedIssueCount = 0;
  for (let cycle = 1; cycle <= MAX_REVIEW_CYCLES; cycle += 1) {
    const attemptStartedAt = Date.now();
    const planningState = createWorkerAttemptState(
      null,
      [],
      undefined,
      contextScan.executionPolicy,
      contextScan.environmentContract,
    );
    const workerPlanRaw = await runToolAgent(
      runtime.workerConfig,
      projectRoot,
      buildWorkerPlanningPrompt(
        work,
        projectOverview,
        contextScan,
        feedback,
        projectSettings.effectiveInstructions,
        activeSubagent?.profile,
      ),
      buildWorkerPlanningSystemPrompt(),
      false,
      signal,
      planningState,
      (content) =>
        collectPreflightPlanningIssues(
          contextScan,
          parseWorkerExecutionPlan(content),
          uniqueStrings(planningState.explorationActions),
        ),
    );
    throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);
    const workerPlan = parseWorkerExecutionPlan(workerPlanRaw);
    const preflightIssues = collectPreflightPlanningIssues(
      contextScan,
      workerPlan,
      uniqueStrings(planningState.explorationActions),
    );
    if (preflightIssues.length > 0) {
      saveAttemptRecord(
        options.sessionsDir,
        sessionPath,
        buildAttemptRecord({
          workId: work.id,
          attemptNo: cycle,
          status: 'needs_context',
          startedAt: attemptStartedAt,
          contextScan,
          workerPlan,
          planningState,
          risks: preflightIssues,
          blockedReason: 'Preflight planning needs more repository context.',
        }),
      );
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: [
          `Preflight planning requested more context before attempt ${cycle}.`,
          '',
          `Issues:\n${formatList(preflightIssues, 'No detailed issues provided')}`,
          '',
          `Context scan search terms:\n${formatList(
            contextScan.searchTerms,
            'No search terms extracted',
          )}`,
          '',
          `Likely files:\n${formatList(contextScan.likelyFiles, 'No likely files detected')}`,
        ].join('\n'),
      });
      feedback = preflightIssues;
      continue;
    }
    const shouldRunDesignGate = workflowHasStage(contextScan.workflowDag, 'design-gate');
    const designReviewGate = shouldRunDesignGate
      ? buildDesignReviewGate({
          work,
          contextScan,
          workerPlan,
          requiredInstructions: projectSettings.effectiveInstructions,
        })
      : undefined;
    contextScan.designReviewGate = designReviewGate;
    const designReviewIssues = designReviewGate
      ? collectDesignReviewGateIssues(designReviewGate)
      : [];
    if (designReviewIssues.length > 0) {
      saveAttemptRecord(
        options.sessionsDir,
        sessionPath,
        buildAttemptRecord({
          workId: work.id,
          attemptNo: cycle,
          status: 'needs_context',
          startedAt: attemptStartedAt,
          contextScan,
          workerPlan,
          planningState,
          risks: designReviewIssues,
          blockedReason: 'Design review gate blocked implementation before editing.',
        }),
      );
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: [
          `Design review gate blocked attempt ${cycle} before implementation.`,
          '',
          formatDesignReviewGate(designReviewGate),
          '',
          `Required changes:\n${formatList(designReviewIssues, 'No required changes')}`,
        ].join('\n'),
      });
      feedback = designReviewIssues;
      continue;
    }
    const worktreeBefore = await getGitWorktreeEntries(projectRoot);
    const dirtyFilesBefore = getDirtyWorktreePaths(worktreeBefore);
    const attemptState = createWorkerAttemptState(
      workerPlan,
      dirtyFilesBefore,
      projectRoot,
      contextScan.executionPolicy,
      contextScan.environmentContract,
      activeSubagent?.tools,
    );
    let workerRaw: string;
    try {
      workerRaw = await runToolAgent(
        runtime.workerConfig,
        projectRoot,
        buildWorkerPrompt(
          work,
          projectOverview,
          contextScan,
          workerPlan,
          feedback,
          projectSettings.effectiveInstructions,
          activeSubagent?.profile,
        ),
        buildWorkerSystemPrompt(),
        true,
        signal,
        attemptState,
      );
    } catch (error) {
      if (!isAbortError(error)) {
        const { restoredFiles, error: restoreError } = tryRestoreAttemptFiles(
          projectRoot,
          attemptState,
        );
        if (restoredFiles.length > 0) {
          addComment(options.sessionsDir, sessionPath, {
            taskId: work.id,
            taskType: 'work',
            author: runtime.reviewerAuthor,
            body: [
              `Restored files after worker attempt ${cycle} failed unexpectedly.`,
              '',
              `Files restored:\n${formatList(restoredFiles, 'No files restored')}`,
            ].join('\n'),
          });
        }
        if (restoreError) {
          enqueueEvent(options.sessionsDir, sessionPath, {
            id: makeId('event'),
            workId: work.id,
            title: work.title,
            projectName: work.projectName,
            type: 'needs_attention',
            createdAt: Date.now(),
            message: `Kira rollback failed: "${work.title}" 작업의 실패한 시도 파일 복구 중 오류가 발생했어요.`,
          });
        }
      }
      throw error;
    }
    throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);
    const parsedWorkerSummary = parseWorkerSummary(workerRaw);
    const worktreeAfter = await getGitWorktreeEntries(projectRoot);
    const touchedFiles = uniqueStrings([
      ...detectTouchedFilesFromGitStatus(worktreeBefore, worktreeAfter),
      ...detectTouchedFilesFromDirtySnapshots(projectRoot, attemptState.dirtyFileSnapshots),
    ]).sort();
    const resolvedFilesChanged = resolveAttemptChangedFiles(
      touchedFiles,
      parsedWorkerSummary.filesChanged,
      [...attemptState.patchedFiles],
    );
    const actualCommandsRun = uniqueStrings(
      attemptState.commandsRun.map((command) => normalizeWhitespace(command)),
    );
    const workerSummary: WorkerSummary = {
      ...parsedWorkerSummary,
      filesChanged: resolvedFilesChanged,
      testsRun: actualCommandsRun.length > 0 ? actualCommandsRun : parsedWorkerSummary.testsRun,
    };
    const outOfPlanFiles = findOutOfPlanTouchedFiles(
      workerPlan.intendedFiles,
      workerSummary.filesChanged,
    );
    const missingValidationCommands = findMissingValidationCommands(
      workerPlan.validationCommands,
      workerSummary.testsRun,
    );
    const shouldRunValidation =
      workflowHasRequiredKind(contextScan.workflowDag, 'validate') ||
      contextScan.executionPolicy?.requireValidation !== false;
    const validationPlan = shouldRunValidation
      ? resolveValidationPlan(
          projectRoot,
          workerPlan.validationCommands,
          workerSummary.filesChanged,
          contextScan.environmentContract,
        )
      : {
          plannerCommands: [],
          autoAddedCommands: [],
          effectiveCommands: [],
          notes: ['Workflow DAG does not require validation and execution policy allows it.'],
        };
    const patchValidationIssues = await collectPatchValidationIssues(
      projectRoot,
      workerSummary.filesChanged,
    );
    const validationReruns = shouldRunValidation
      ? await rerunValidationCommands(
          projectRoot,
          validationPlan.effectiveCommands,
          signal,
          contextScan.environmentContract,
          contextScan.executionPolicy,
        )
      : { passed: [], failed: [], failureDetails: [] };
    throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);
    const diffExcerpts = await collectReviewerDiffExcerpts(projectRoot, workerSummary.filesChanged);
    const diffStats = await collectGitDiffStats(projectRoot, workerSummary.filesChanged);
    const runtimeSignal = buildRuntimeValidationSignal(
      workerPlan.taskType,
      workerSummary.filesChanged,
    );
    const runtimeValidation = await collectRuntimeValidationResult(runtimeSignal);
    const riskPolicy = assessRiskReviewPolicy({
      projectRoot,
      work,
      taskType: workerPlan.taskType,
      files: workerSummary.filesChanged,
      diffStats,
      runtimeValidation: runtimeSignal,
      runMode: projectSettings.runMode,
    });
    contextScan.runtimeValidation = runtimeSignal;
    contextScan.riskPolicy = riskPolicy;
    contextScan.orchestrationPlan = buildOrchestrationPlan({
      work,
      taskType: workerPlan.taskType,
      runMode: projectSettings.runMode,
      workerCount: 1,
      riskPolicy,
      runtimeValidation: runtimeSignal,
      subagentRegistry: contextScan.subagentRegistry,
      workflowDag: contextScan.workflowDag,
      environmentContract: contextScan.environmentContract,
      pluginConnectors: contextScan.pluginConnectors,
    });
    contextScan.reviewAdversarialPlan = buildReviewAdversarialPlan({
      taskType: workerPlan.taskType,
      files: workerSummary.filesChanged,
      riskPolicy,
      runtimeValidation: runtimeSignal,
      diffStats,
      semanticGraph: contextScan.semanticGraph,
    });
    contextScan.reviewerCalibration = buildReviewerCalibration(
      contextScan.projectProfile,
      riskPolicy,
      contextScan.reviewAdversarialPlan,
    );
    const failureAnalysis = analyzeValidationFailures(validationReruns);
    const patchIntentVerification = verifyPatchIntent({
      workerPlan,
      workerSummary,
      outOfPlanFiles,
      diffStats,
      diffExcerpts,
    });
    const selfCheckIssues = collectWorkerSelfCheckIssues({
      workerSummary,
      workerPlan,
      requiredInstructions: projectSettings.effectiveInstructions,
      validationPlan,
      filesChanged: workerSummary.filesChanged,
      diffExcerpts,
    });
    const reviewabilityIssues = collectAttemptReviewabilityIssues({
      rawWorkerOutput: workerRaw,
      workerSummary,
      workerPlan,
      diffExcerpts,
      gitDiffAvailable: worktreeAfter !== null,
    });
    const highRiskIssues = [
      ...(await collectHighRiskAttemptIssues(projectRoot, workerSummary.filesChanged)),
      ...patchValidationIssues,
      ...reviewabilityIssues,
      ...collectDirtyFileGuardrailIssues(workerPlan, dirtyFilesBefore, workerSummary.filesChanged),
      ...collectPlanGuardrailIssues(
        projectRoot,
        workerPlan,
        workerSummary.filesChanged,
        workerSummary.testsRun,
      ),
      ...collectPatchScopeIssues({
        workerPlan,
        filesChanged: workerSummary.filesChanged,
        diffStats,
      }),
      ...collectExecutionPolicyPatchIssues({
        policy: contextScan.executionPolicy,
        filesChanged: workerSummary.filesChanged,
        diffStats,
        riskLevel: riskPolicy.level,
      }),
      ...(patchIntentVerification.status === 'drift'
        ? patchIntentVerification.issues.map((issue) => `Patch intent drift: ${issue}`)
        : []),
      ...(runtimeValidation.applicable &&
      runtimeValidation.serverDetected &&
      runtimeValidation.status !== 'reachable'
        ? ['Runtime validation failed even though a dev server was detected.']
        : []),
    ];

    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.workerAuthor,
      body: [
        `Attempt ${cycle} finished.`,
        '',
        `Project context:\n- Root: ${contextScan.projectRoot}\n- Package manager: ${
          contextScan.packageManager ?? 'not detected'
        }`,
        '',
        `Existing changes:\n${formatList(
          contextScan.existingChanges,
          'Clean worktree or no git changes detected',
        )}`,
        '',
        `Likely files:\n${formatList(contextScan.likelyFiles, 'No likely files detected')}`,
        '',
        `Candidate checks:\n${formatList(contextScan.candidateChecks, 'No candidate checks detected')}`,
        '',
        `Preflight exploration:\n${formatList(
          uniqueStrings(planningState.explorationActions),
          'No preflight exploration recorded',
        )}`,
        '',
        `Read files:\n${formatList([...attemptState.readFiles].sort(), 'No files read during implementation')}`,
        '',
        `Patched files:\n${formatList([...attemptState.patchedFiles].sort(), 'No files patched during implementation')}`,
        '',
        `Plan:\n${workerPlan.summary}`,
        '',
        `Plan understanding:\n${workerPlan.understanding}`,
        '',
        `Repo findings:\n${formatList(workerPlan.repoFindings, 'No repo findings')}`,
        '',
        `Task type:\n${workerPlan.taskType}`,
        '',
        formatPatchAlternatives(workerPlan.approachAlternatives),
        '',
        formatRequirementTrace(
          workerSummary.selfCheck?.requirementTrace.length
            ? workerSummary.selfCheck.requirementTrace
            : workerPlan.requirementTrace,
        ),
        '',
        formatChangeDesign(workerPlan.changeDesign),
        '',
        `Planned files:\n${formatList(workerPlan.intendedFiles, 'No planned files')}`,
        '',
        `Protected files:\n${formatList(workerPlan.protectedFiles, 'No protected files')}`,
        '',
        `Planned checks:\n${formatList(workerPlan.validationCommands, 'No planned checks')}`,
        '',
        `Kira auto-added validation checks:\n${formatList(
          validationPlan.autoAddedCommands,
          'No auto-added validation checks',
        )}`,
        '',
        `Kira effective validation plan:\n${formatList(
          validationPlan.effectiveCommands,
          'No effective validation commands',
        )}`,
        '',
        `Validation plan notes:\n${formatList(validationPlan.notes, 'No validation plan notes')}`,
        '',
        `Plan risks:\n${formatList(workerPlan.riskNotes, 'No planner risks reported')}`,
        '',
        `Stop conditions:\n${formatList(workerPlan.stopConditions, 'No stop conditions')}`,
        '',
        `Summary:\n${workerSummary.summary}`,
        '',
        `Files changed:\n${formatList(workerSummary.filesChanged, 'No files reported')}`,
        '',
        `Checks:\n${formatList(workerSummary.testsRun, 'No checks reported')}`,
        '',
        workerSummary.selfCheck
          ? `Self-check:\n${formatList(
              [
                `reviewedDiff=${workerSummary.selfCheck.reviewedDiff}`,
                `followedProjectInstructions=${workerSummary.selfCheck.followedProjectInstructions}`,
                `matchedPlan=${workerSummary.selfCheck.matchedPlan}`,
                `ranOrExplainedValidation=${workerSummary.selfCheck.ranOrExplainedValidation}`,
                ...workerSummary.selfCheck.diffHunkReview.map(
                  (item) => `diffHunkReview ${item.file}: ${item.intent} Risk: ${item.risk}`,
                ),
                ...workerSummary.selfCheck.uncertainty.map((item) => `uncertainty: ${item}`),
                ...workerSummary.selfCheck.notes.map((item) => `note: ${item}`),
              ],
              'No self-check details',
            )}`
          : 'Self-check:\n- Missing self-check object',
        '',
        `Diff stats:\n- files=${diffStats.files}\n- additions=${diffStats.additions}\n- deletions=${diffStats.deletions}\n- hunks=${diffStats.hunks}`,
        '',
        formatRiskReviewPolicy(riskPolicy),
        '',
        formatDesignReviewGate(contextScan.designReviewGate),
        '',
        formatReviewAdversarialPlan(contextScan.reviewAdversarialPlan),
        '',
        formatRuntimeValidationResult(runtimeValidation),
        '',
        formatPatchIntentVerification(patchIntentVerification),
        '',
        `Kira-passed validation reruns:\n${formatList(
          validationReruns.passed,
          'No validation reruns passed',
        )}`,
        '',
        `Kira validation failures:\n${formatList(
          validationReruns.failed,
          'No validation reruns failed',
        )}`,
        '',
        formatFailureAnalysis(failureAnalysis),
        '',
        `Remaining risks:\n${formatList(
          [...workerSummary.remainingRisks, ...highRiskIssues, ...selfCheckIssues],
          'None reported',
        )}`,
        '',
        `Validation gaps:\n${formatList(missingValidationCommands, 'No missing planned checks')}`,
        '',
        `Out-of-plan files:\n${formatList(outOfPlanFiles, 'No out-of-plan files')}`,
        '',
        `Worker submission:\n${formatWorkerSubmission(workerRaw)}`,
      ].join('\n'),
    });

    if (highRiskIssues.length > 0) {
      updateProjectProfileLearning(projectRoot, {
        reviewFailures: highRiskIssues,
        repeatedPatterns: highRiskIssues.filter((issue) =>
          /\b(protected|high-risk|out-of-plan|unsafe|diff|reviewable|small-patch|split)\b/i.test(
            issue,
          ),
        ),
      });
      const { restoredFiles, error: restoreError } = tryRestoreAttemptFiles(
        projectRoot,
        attemptState,
      );
      saveAttemptRecord(
        options.sessionsDir,
        sessionPath,
        buildAttemptRecord({
          workId: work.id,
          attemptNo: cycle,
          status: 'blocked',
          startedAt: attemptStartedAt,
          contextScan,
          workerPlan,
          planningState,
          attemptState,
          workerSummary,
          validationPlan,
          validationReruns,
          failureAnalysis,
          runtimeValidation,
          riskPolicy,
          patchIntentVerification,
          diffStats,
          outOfPlanFiles,
          validationGaps: missingValidationCommands,
          risks: [...workerSummary.remainingRisks, ...highRiskIssues],
          diffExcerpts,
          rawWorkerOutput: workerRaw,
          blockedReason: 'Automated safety validation failed.',
          rollbackFiles: restoredFiles,
        }),
      );
      updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
        ...current,
        status: 'blocked',
      }));
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: [
          `Blocked after automated safety validation failed on attempt ${cycle}.`,
          '',
          `Issues:\n${formatList(highRiskIssues, 'No detailed issues provided')}`,
          '',
          `Rolled back files:\n${formatList(restoredFiles, 'No files rolled back')}`,
          '',
          restoreError ? `Rollback error:\n${restoreError}` : 'Rollback completed without errors.',
          '',
          'Kira rolled back the latest attempt instead of leaving unsafe or unverified edits in the worktree.',
        ].join('\n'),
      });
      enqueueEvent(options.sessionsDir, sessionPath, {
        id: makeId('event'),
        workId: work.id,
        title: work.title,
        projectName: work.projectName,
        type: 'needs_attention',
        createdAt: Date.now(),
        message: `Kira blocked: "${work.title}" 작업이 고위험 파일 안전 검증에 걸려 중단됐어요.`,
      });
      if (restoreError) {
        enqueueEvent(options.sessionsDir, sessionPath, {
          id: makeId('event'),
          workId: work.id,
          title: work.title,
          projectName: work.projectName,
          type: 'needs_attention',
          createdAt: Date.now(),
          message: `Kira rollback failed: "${work.title}" 작업의 안전 차단 후 파일 복구 중 오류가 발생했어요.`,
        });
      }
      return;
    }

    if (validationReruns.failed.length > 0 || selfCheckIssues.length > 0) {
      updateProjectProfileLearning(projectRoot, {
        validationFailures: [
          ...validationReruns.failed.map((command) => `Kira rerun failed for ${command}`),
          ...failureAnalysis.map((item) => `${item.category}: ${item.guidance}`),
          ...selfCheckIssues,
        ],
      });
      saveAttemptRecord(
        options.sessionsDir,
        sessionPath,
        buildAttemptRecord({
          workId: work.id,
          attemptNo: cycle,
          status: 'validation_failed',
          startedAt: attemptStartedAt,
          contextScan,
          workerPlan,
          planningState,
          attemptState,
          workerSummary,
          validationPlan,
          validationReruns,
          failureAnalysis,
          runtimeValidation,
          riskPolicy,
          patchIntentVerification,
          diffStats,
          outOfPlanFiles,
          validationGaps: missingValidationCommands,
          risks: [...workerSummary.remainingRisks, ...selfCheckIssues],
          diffExcerpts,
          rawWorkerOutput: workerRaw,
        }),
      );
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: [
          `Validation requested changes after attempt ${cycle}.`,
          '',
          `Passed reruns:\n${formatList(validationReruns.passed, 'No validation reruns passed')}`,
          '',
          `Failed reruns:\n${formatList(validationReruns.failed, 'No validation reruns failed')}`,
          '',
          `Failure details:\n${formatList(
            validationReruns.failureDetails,
            'No validation failure details provided',
          )}`,
          '',
          formatFailureAnalysis(failureAnalysis),
          '',
          `Worker self-check issues:\n${formatList(
            selfCheckIssues,
            'No worker self-check issues',
          )}`,
          '',
          'Kira reran the planned validation commands itself and will not send this attempt to final review until they pass.',
        ].join('\n'),
      });

      feedback = [
        ...validationReruns.failed.map(
          (command) => `Planned validation failed when Kira reran it: ${command}`,
        ),
        ...failureAnalysis.map((item) => `Failure analysis (${item.category}): ${item.guidance}`),
        ...selfCheckIssues,
      ];
      const validationSummary =
        validationReruns.failed.length > 0
          ? `Validation reruns failed: ${validationReruns.failed.join(', ')}`
          : 'Worker self-check failed.';
      const issueSignature = buildIssueSignature(feedback, validationSummary);
      if (issueSignature === previousIssueSignature) {
        repeatedIssueCount += 1;
      } else {
        repeatedIssueCount = 1;
        previousIssueSignature = issueSignature;
      }

      if (repeatedIssueCount >= 2) {
        saveAttemptRecord(
          options.sessionsDir,
          sessionPath,
          buildAttemptRecord({
            workId: work.id,
            attemptNo: cycle,
            status: 'blocked',
            startedAt: attemptStartedAt,
            contextScan,
            workerPlan,
            planningState,
            attemptState,
            workerSummary,
            validationPlan,
            validationReruns,
            failureAnalysis,
            runtimeValidation,
            riskPolicy,
            patchIntentVerification,
            diffStats,
            outOfPlanFiles,
            validationGaps: missingValidationCommands,
            risks: feedback,
            diffExcerpts,
            rawWorkerOutput: workerRaw,
            blockedReason: 'Validation failures repeated without progress.',
          }),
        );
        updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
          ...current,
          status: 'blocked',
        }));
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: [
            `Blocked early because the same validation failures repeated without progress after attempt ${cycle}.`,
            '',
            `Issues:\n${formatList(feedback, validationSummary)}`,
            '',
            'Kira stopped retrying because the worker was not making progress against the same rerun validation failures.',
          ].join('\n'),
        });
        enqueueEvent(options.sessionsDir, sessionPath, {
          id: makeId('event'),
          workId: work.id,
          title: work.title,
          projectName: work.projectName,
          type: 'needs_attention',
          createdAt: Date.now(),
          message: `Kira blocked: "${work.title}" 작업이 같은 검증 실패를 반복해서 더 이상 자동 재시도하지 않을게요.`,
        });
        return;
      }

      if (cycle < MAX_REVIEW_CYCLES) {
        updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
          ...current,
          status: 'in_progress',
        }));
      }
      continue;
    }

    updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
      ...current,
      status: 'in_review',
    }));
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        `Started review for attempt ${cycle}.`,
        '',
        `Files changed:\n${formatList(workerSummary.filesChanged, 'No changed files recorded')}`,
        '',
        `Kira-passed validation reruns:\n${formatList(
          validationReruns.passed,
          'No validation reruns passed',
        )}`,
      ].join('\n'),
    });

    const reviewStartedAt = Date.now();
    const reviewRaw = await runToolAgent(
      runtime.reviewerConfig,
      projectRoot,
      buildReviewPrompt(
        work,
        projectOverview,
        contextScan,
        workerPlan,
        workerSummary,
        outOfPlanFiles,
        missingValidationCommands,
        validationPlan,
        validationReruns,
        diffExcerpts,
        projectSettings.effectiveInstructions,
        diffStats,
        failureAnalysis,
        runtimeValidation,
        patchIntentVerification,
      ),
      buildReviewSystemPrompt(),
      false,
      signal,
    );
    const reviewFinishedAt = Date.now();
    throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);
    const reviewSummary = enforceReviewDecision(parseReviewSummary(reviewRaw), {
      workerSummary,
      validationReruns,
      validationPlan,
      diffExcerpts,
      requiredInstructions: projectSettings.effectiveInstructions,
      riskPolicy,
      requirementTrace: workerPlan.requirementTrace,
      runtimeValidation,
      reviewAdversarialPlan: contextScan.reviewAdversarialPlan,
      patchIntentVerification,
      designReviewGate: contextScan.designReviewGate,
    });
    const reviewTriage = buildReviewFindingTriage(reviewSummary, {
      designReviewGate: contextScan.designReviewGate,
      patchIntentVerification,
      runtimeValidation,
    });
    const diffCoverage = buildDiffReviewCoverage({
      workerSummary,
      reviewSummary,
      diffExcerpts,
    });
    const reviewRecord = buildReviewRecord(work.id, cycle, reviewSummary, {
      reviewAdversarialPlan: contextScan.reviewAdversarialPlan,
      designReviewGate: contextScan.designReviewGate,
      patchIntentVerification,
      runtimeValidation,
      diffCoverage,
      observability: buildReviewObservability({
        startedAt: reviewStartedAt,
        finishedAt: reviewFinishedAt,
        reviewRaw,
        reviewSummary,
        triage: reviewTriage,
      }),
    });
    saveReviewRecord(options.sessionsDir, sessionPath, reviewRecord);

    if (reviewSummary.approved) {
      const completionPolicyIssues = collectExecutionPolicyCompletionIssues({
        policy: contextScan.executionPolicy,
        filesChanged: workerSummary.filesChanged,
        diffStats,
        riskLevel: riskPolicy.level,
      });
      if (completionPolicyIssues.length > 0) {
        saveAttemptRecord(
          options.sessionsDir,
          sessionPath,
          buildAttemptRecord({
            workId: work.id,
            attemptNo: cycle,
            status: 'blocked',
            startedAt: attemptStartedAt,
            contextScan,
            workerPlan,
            planningState,
            attemptState,
            workerSummary,
            validationPlan,
            validationReruns,
            failureAnalysis,
            runtimeValidation,
            riskPolicy,
            patchIntentVerification,
            diffStats,
            outOfPlanFiles,
            validationGaps: missingValidationCommands,
            risks: [...workerSummary.remainingRisks, ...completionPolicyIssues],
            diffExcerpts,
            rawWorkerOutput: workerRaw,
            blockedReason: 'Execution policy blocked task completion.',
            reviewSummary,
          }),
        );
        updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
          ...current,
          status: 'blocked',
        }));
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: [
            'Execution policy blocked task completion after review approval.',
            '',
            `Issues:\n${formatList(completionPolicyIssues, 'No details provided')}`,
          ].join('\n'),
        });
        return;
      }
      updateProjectProfileLearning(projectRoot, {
        successfulPatterns: [
          `${workerPlan.taskType}: approved with ${validationReruns.passed.length} validation checks and ${reviewSummary.evidenceChecked.length} review evidence entries.`,
        ],
      });
      saveAttemptRecord(
        options.sessionsDir,
        sessionPath,
        buildAttemptRecord({
          workId: work.id,
          attemptNo: cycle,
          status: 'approved',
          startedAt: attemptStartedAt,
          contextScan,
          workerPlan,
          planningState,
          attemptState,
          workerSummary,
          validationPlan,
          validationReruns,
          failureAnalysis,
          runtimeValidation,
          riskPolicy,
          patchIntentVerification,
          diffStats,
          outOfPlanFiles,
          validationGaps: missingValidationCommands,
          risks: [...workerSummary.remainingRisks, ...reviewSummary.residualRisk],
          diffExcerpts,
          rawWorkerOutput: workerRaw,
          reviewSummary,
        }),
      );
      const suggestedCommitMessage = buildSuggestedCommitMessage(work, workerSummary);
      updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
        ...current,
        status: 'done',
      }));
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: `Approved.\n\n${reviewSummary.summary}`,
      });
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: `Suggested commit message:\n${suggestedCommitMessage}`,
      });

      const autoCommitResult = await autoCommitApprovedWork(
        workspace,
        workerSummary.filesChanged,
        suggestedCommitMessage,
        runtime.defaultProjectSettings,
        getProjectLockPath(
          options.sessionsDir,
          getProjectKey(runtime.workRootDirectory, work, sessionPath),
        ),
      );
      const connectorEvidence =
        autoCommitResult.status === 'committed'
          ? await collectConnectorIntegrationEvidence({
              projectRoot: workspace.isolated ? workspace.primaryRoot : workspace.projectRoot,
              work,
              commitMessage: suggestedCommitMessage,
              commitHash: autoCommitResult.commitHash,
              connectors: projectSettings.plugins,
            })
          : [];
      const integrationRecord: KiraIntegrationRecord = {
        status: autoCommitResult.status === 'committed' ? 'committed' : autoCommitResult.status,
        message: autoCommitResult.message,
        ...(autoCommitResult.commitHash ? { commitHash: autoCommitResult.commitHash } : {}),
        pullRequestUrl: connectorEvidence.find((item) => item.url)?.url,
        connectors: connectorEvidence,
        createdAt: Date.now(),
      };
      updateAttemptRecordIntegration(
        options.sessionsDir,
        sessionPath,
        work.id,
        cycle,
        integrationRecord,
      );
      if (autoCommitResult.status === 'committed') {
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: `Committed changes.\n\n${autoCommitResult.message}\n\nCommit message:\n${suggestedCommitMessage}`,
        });
        if (connectorEvidence.length > 0) {
          addComment(options.sessionsDir, sessionPath, {
            taskId: work.id,
            taskType: 'work',
            author: runtime.reviewerAuthor,
            body: [
              'Connector integration evidence recorded.',
              '',
              ...connectorEvidence.map((item) =>
                [
                  `${item.connectorId}: ${item.status}`,
                  item.summary,
                  item.url ? `URL: ${item.url}` : '',
                  `Evidence:\n${formatList(item.evidence, 'No connector evidence')}`,
                ]
                  .filter(Boolean)
                  .join('\n'),
              ),
            ].join('\n\n'),
          });
        }
      } else if (autoCommitResult.status === 'failed') {
        updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
          ...current,
          status: 'blocked',
        }));
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: [
            'Auto-commit failed and Kira blocked the task before marking integration complete.',
            '',
            autoCommitResult.message,
          ].join('\n'),
        });
        enqueueEvent(options.sessionsDir, sessionPath, {
          id: makeId('event'),
          workId: work.id,
          title: work.title,
          projectName: work.projectName,
          type: 'needs_attention',
          createdAt: Date.now(),
          message: `Kira blocked: "${work.title}" 작업의 승인된 변경을 통합하는 중 충돌 또는 git 상태 문제가 발생했어요.`,
        });
        return;
      } else if (autoCommitResult.message) {
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: `Auto-commit skipped.\n\n${autoCommitResult.message}`,
        });
      }

      await cleanupKiraWorktreeSession(workspace);

      enqueueEvent(options.sessionsDir, sessionPath, {
        id: makeId('event'),
        workId: work.id,
        title: work.title,
        projectName: work.projectName,
        type: 'completed',
        createdAt: Date.now(),
        message: `Kira 완료: "${work.title}" 작업이 끝났어요.`,
      });
      return;
    }

    updateProjectProfileLearning(projectRoot, {
      reviewFailures: uniqueStrings([
        ...reviewSummary.issues,
        ...reviewSummary.nextWorkerInstructions,
      ]),
      validationFailures: reviewSummary.missingValidation,
      repeatedPatterns:
        repeatedIssueCount > 0
          ? uniqueStrings(reviewSummary.issues).slice(0, MAX_PROJECT_LEARNING_ITEMS)
          : [],
    });

    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        `Review requested changes after attempt ${cycle}.`,
        '',
        `Summary:\n${reviewSummary.summary}`,
        '',
        `Findings:\n${formatList(
          reviewSummary.findings.map((finding) =>
            [
              finding.severity,
              finding.file,
              finding.line ? `line ${finding.line}` : '',
              finding.message,
            ]
              .filter(Boolean)
              .join(': '),
          ),
          'No structured findings',
        )}`,
        '',
        `Missing validation:\n${formatList(
          reviewSummary.missingValidation,
          'No missing validation reported',
        )}`,
        '',
        `Next worker instructions:\n${formatList(
          reviewSummary.nextWorkerInstructions,
          'No next instructions provided',
        )}`,
        '',
        `Issues:\n${formatList(reviewSummary.issues, 'No detailed issues provided')}`,
      ].join('\n'),
    });

    saveAttemptRecord(
      options.sessionsDir,
      sessionPath,
      buildAttemptRecord({
        workId: work.id,
        attemptNo: cycle,
        status: 'review_requested_changes',
        startedAt: attemptStartedAt,
        contextScan,
        workerPlan,
        planningState,
        attemptState,
        workerSummary,
        validationPlan,
        validationReruns,
        failureAnalysis,
        runtimeValidation,
        riskPolicy,
        patchIntentVerification,
        diffStats,
        outOfPlanFiles,
        validationGaps: [...missingValidationCommands, ...reviewSummary.missingValidation],
        risks: [...workerSummary.remainingRisks, ...reviewSummary.issues],
        diffExcerpts,
        rawWorkerOutput: workerRaw,
        reviewSummary,
      }),
    );

    feedback =
      reviewSummary.nextWorkerInstructions.length > 0
        ? reviewSummary.nextWorkerInstructions
        : reviewSummary.issues.length > 0
          ? reviewSummary.issues
          : [reviewSummary.summary];
    const issueSignature = buildIssueSignature(reviewSummary.issues, reviewSummary.summary);
    if (issueSignature === previousIssueSignature) {
      repeatedIssueCount += 1;
    } else {
      repeatedIssueCount = 1;
      previousIssueSignature = issueSignature;
    }

    if (repeatedIssueCount >= 2) {
      saveAttemptRecord(
        options.sessionsDir,
        sessionPath,
        buildAttemptRecord({
          workId: work.id,
          attemptNo: cycle,
          status: 'blocked',
          startedAt: attemptStartedAt,
          contextScan,
          workerPlan,
          planningState,
          attemptState,
          workerSummary,
          validationPlan,
          validationReruns,
          failureAnalysis,
          runtimeValidation,
          riskPolicy,
          patchIntentVerification,
          diffStats,
          outOfPlanFiles,
          validationGaps: [...missingValidationCommands, ...reviewSummary.missingValidation],
          risks: reviewSummary.issues,
          diffExcerpts,
          rawWorkerOutput: workerRaw,
          blockedReason: 'Review issues repeated without progress.',
          reviewSummary,
        }),
      );
      updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
        ...current,
        status: 'blocked',
      }));
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: [
          `Blocked early because the same review issues repeated without progress after attempt ${cycle}.`,
          '',
          `Issues:\n${formatList(reviewSummary.issues, reviewSummary.summary)}`,
          '',
          'Kira stopped retrying because the worker was not making progress against the same review feedback.',
        ].join('\n'),
      });
      enqueueEvent(options.sessionsDir, sessionPath, {
        id: makeId('event'),
        workId: work.id,
        title: work.title,
        projectName: work.projectName,
        type: 'needs_attention',
        createdAt: Date.now(),
        message: `Kira blocked: "${work.title}" 작업이 같은 반려 사유를 반복해서 더 이상 자동 재시도하지 않을게요.`,
      });
      return;
    }

    if (cycle < MAX_REVIEW_CYCLES) {
      updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
        ...current,
        status: 'in_progress',
      }));
    }
  }

  updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
    ...current,
    status: 'blocked',
  }));
  addComment(options.sessionsDir, sessionPath, {
    taskId: work.id,
    taskType: 'work',
    author: runtime.reviewerAuthor,
    body: [
      `Blocked after ${MAX_REVIEW_CYCLES} review or validation attempts.`,
      '',
      `Summary:\n${feedback[0] ?? 'The work could not satisfy the review requirements within the allowed retries.'}`,
      '',
      `Issues:\n${formatList(feedback, 'No detailed issues provided')}`,
      '',
      'Please revise the work brief or resolve the review issues before restarting this task.',
    ].join('\n'),
  });
  enqueueEvent(options.sessionsDir, sessionPath, {
    id: makeId('event'),
    workId: work.id,
    title: work.title,
    projectName: work.projectName,
    type: 'needs_attention',
    createdAt: Date.now(),
    message: `Kira blocked: "${work.title}" 작업이 ${MAX_REVIEW_CYCLES}회 리뷰 후에도 통과하지 못해 Blocked 상태로 전환됐어요.`,
  });
}

function startWorkJob(
  options: KiraAutomationPluginOptions,
  sessionPath: string,
  workId: string,
): void {
  const jobKey = `${sessionPath}::${workId}`;
  if (activeJobs.has(jobKey)) return;

  const dataDir = getKiraDataDir(options.sessionsDir, sessionPath);
  const runtime = getKiraRuntimeSettings(options.configFile, options.getWorkRootDirectory());
  const work = readJsonFile<WorkTask>(join(dataDir, WORKS_DIR_NAME, `${workId}.json`));
  if (!work?.projectName) return;
  const workLockPath = getWorkLockPath(options.sessionsDir, sessionPath, workId);
  const workLockAcquired = tryAcquireLock(workLockPath, {
    ownerId: SERVER_INSTANCE_ID,
    resource: 'work',
    sessionPath,
    targetKey: workId,
  });
  if (!workLockAcquired) return;

  const projectKey = getProjectKey(options.getWorkRootDirectory(), work, sessionPath);
  const projectLockPath = getProjectLockPath(options.sessionsDir, projectKey);
  const projectRoot = resolveKiraProjectRoot(runtime.workRootDirectory, work.projectName);
  const projectSettings = projectRoot
    ? loadProjectSettings(projectRoot, runtime.defaultProjectSettings)
    : runtime.defaultProjectSettings;
  const shouldUseIsolatedWorktree = shouldUseKiraAttemptWorktrees(
    projectRoot,
    projectSettings,
    runtime.workerConfigs.length,
  );
  let projectLockAcquired = false;
  if (
    !shouldUseIsolatedWorktree &&
    (activeProjectJobs.has(projectKey) ||
      !tryAcquireLock(projectLockPath, {
        ownerId: SERVER_INSTANCE_ID,
        resource: 'project',
        sessionPath,
        targetKey: projectKey,
      }))
  ) {
    const comments = loadTaskComments(options.sessionsDir, sessionPath, workId);
    const alreadyQueued = comments.some(
      (comment) =>
        isReviewerAuthor(comment.author) &&
        comment.body.startsWith('Queued: waiting for another work in the same project to finish.'),
    );
    if (!alreadyQueued) {
      addComment(options.sessionsDir, sessionPath, {
        taskId: workId,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: 'Queued: waiting for another work in the same project to finish.',
      });
    }
    releaseLock(workLockPath, SERVER_INSTANCE_ID);
    return;
  }
  projectLockAcquired = !shouldUseIsolatedWorktree;

  activeJobs.add(jobKey);
  if (projectLockAcquired) {
    activeProjectJobs.add(projectKey);
  }
  const controller = new AbortController();
  jobAbortControllers.set(jobKey, controller);
  const heartbeat = setInterval(() => {
    refreshLock(workLockPath, SERVER_INSTANCE_ID);
    if (projectLockAcquired) {
      refreshLock(projectLockPath, SERVER_INSTANCE_ID);
    }
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  void processWork(options, sessionPath, workId, controller.signal)
    .catch((error) => {
      if (isAbortError(error)) return;
      const work = readJsonFile<WorkTask>(join(dataDir, WORKS_DIR_NAME, `${workId}.json`));
      if (work) {
        const resolvedFailure = resolveUnexpectedAutomationFailure(
          work.title,
          error instanceof Error ? error.message : String(error),
        );
        updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
          ...current,
          status: 'blocked',
        }));
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: [
            'Automation failed unexpectedly and Kira blocked this task to avoid retry loops.',
            '',
            `Summary:\n${resolvedFailure.summary}`,
            '',
            `Error:\n${error instanceof Error ? error.message : String(error)}`,
            '',
            `Guidance:\n${resolvedFailure.guidance}`,
          ].join('\n'),
        });
        enqueueEvent(options.sessionsDir, sessionPath, {
          id: makeId('event'),
          workId: work.id,
          title: work.title,
          projectName: work.projectName,
          type: 'needs_attention',
          createdAt: Date.now(),
          message: resolvedFailure.userMessage,
        });
      }
    })
    .finally(() => {
      clearInterval(heartbeat);
      activeJobs.delete(jobKey);
      if (projectLockAcquired) {
        activeProjectJobs.delete(projectKey);
      }
      jobAbortControllers.delete(jobKey);
      releaseLock(workLockPath, SERVER_INSTANCE_ID);
      if (projectLockAcquired) {
        releaseLock(projectLockPath, SERVER_INSTANCE_ID);
      }
    });
}

function scanTodoWorks(options: KiraAutomationPluginOptions, sessionPath: string): void {
  const worksDir = join(getKiraDataDir(options.sessionsDir, sessionPath), WORKS_DIR_NAME);
  for (const filePath of listJsonFiles(worksDir)) {
    const work = readJsonFile<WorkTask>(filePath);
    if (!work) continue;
    if (work.status === 'done') {
      ensureSuggestedCommitMessageComment(options, sessionPath, work);
      continue;
    }
    if (work.status === 'todo') {
      startWorkJob(options, sessionPath, work.id);
      continue;
    }
    if (work.status === 'in_progress' && Date.now() - work.updatedAt >= STALLED_WORK_MS) {
      startWorkJob(options, sessionPath, work.id);
    }
  }
}

function scanActionableWorks(options: KiraAutomationPluginOptions, sessionPath: string): void {
  try {
    scanTodoWorks(options, sessionPath);
  } catch (error) {
    if (isRecoverableLockError(error)) return;
    enqueueEvent(options.sessionsDir, sessionPath, {
      id: makeId('event'),
      workId: '',
      title: 'Kira automation scan',
      projectName: '',
      type: 'needs_attention',
      createdAt: Date.now(),
      message: `Kira 자동 스캔 오류: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function scanAllSessions(options: KiraAutomationPluginOptions): void {
  for (const sessionPath of discoverSessionPaths(options.sessionsDir)) {
    scanActionableWorks(options, sessionPath);
  }
}

export function kiraAutomationPlugin(options: KiraAutomationPluginOptions): Plugin {
  return {
    name: 'kira-automation',
    configureServer(server) {
      queueMicrotask(() => {
        scanAllSessions(options);
      });
      const timer = setInterval(() => {
        scanAllSessions(options);
      }, GLOBAL_SCAN_INTERVAL_MS);
      timer.unref?.();

      const readRequestBody = (
        req: NodeJS.ReadableStream & {
          on: (event: string, listener: (chunk?: Buffer) => void) => void;
        },
        onParsed: (body: Record<string, unknown>) => void | Promise<void>,
        onError: (error: unknown) => void,
      ) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<
              string,
              unknown
            >;
            void onParsed(body);
          } catch (error) {
            onError(error);
          }
        });
      };

      server.middlewares.use('/api/kira-discovery/analyze', (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        readRequestBody(
          req,
          async (body) => {
            try {
              const sessionPath =
                typeof body.sessionPath === 'string' ? body.sessionPath.trim() : '';
              const projectName =
                typeof body.projectName === 'string' ? body.projectName.trim() : '';
              if (!sessionPath || !projectName) {
                throw new Error('Missing sessionPath or projectName.');
              }

              const analysis = await analyzeProjectForDiscovery(
                options,
                sessionPath,
                projectName,
                res,
              );
              sendSseEvent(res, {
                type: 'analysis_complete',
                analysis,
                message: `Aoi found ${analysis.findings.length} candidate tasks for ${projectName}.`,
              });
              sendSseEvent(res, { type: 'done' });
              res.end();
            } catch (error) {
              sendSseEvent(res, {
                type: 'error',
                message: error instanceof Error ? error.message : String(error),
              });
              sendSseEvent(res, { type: 'done' });
              res.end();
            }
          },
          (error) => {
            sendSseEvent(res, {
              type: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
            sendSseEvent(res, { type: 'done' });
            res.end();
          },
        );
      });

      server.middlewares.use('/api/kira-discovery/existing', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const sessionPath = url.searchParams.get('sessionPath')?.trim();
          const projectName = url.searchParams.get('projectName')?.trim();
          if (!sessionPath || !projectName) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing sessionPath or projectName' }));
            return;
          }

          const analysis = loadProjectDiscoveryAnalysis(
            options.sessionsDir,
            sessionPath,
            projectName,
          );
          res.writeHead(200);
          res.end(JSON.stringify({ analysis: analysis ?? null }));
        } catch (error) {
          res.writeHead(500);
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        }
      });

      server.middlewares.use('/api/kira-discovery/create-tasks', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        readRequestBody(
          req,
          async (body) => {
            try {
              const sessionPath =
                typeof body.sessionPath === 'string' ? body.sessionPath.trim() : '';
              const projectName =
                typeof body.projectName === 'string' ? body.projectName.trim() : '';
              if (!sessionPath || !projectName) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Missing sessionPath or projectName' }));
                return;
              }

              const analysis = loadProjectDiscoveryAnalysis(
                options.sessionsDir,
                sessionPath,
                projectName,
              );
              if (!analysis) {
                res.writeHead(404);
                res.end(
                  JSON.stringify({ error: 'No saved discovery analysis found for this project' }),
                );
                return;
              }

              const { created, skippedTitles } = createWorksFromDiscovery(
                options,
                sessionPath,
                analysis,
              );
              scanActionableWorks(options, sessionPath);
              res.writeHead(200);
              res.end(
                JSON.stringify({
                  createdCount: created.length,
                  skippedCount: skippedTitles.length,
                  createdWorks: created,
                  skippedTitles,
                }),
              );
            } catch (error) {
              res.writeHead(500);
              res.end(
                JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
              );
            }
          },
          (error) => {
            res.writeHead(400);
            res.end(
              JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            );
          },
        );
      });

      server.middlewares.use('/api/kira-automation/scan', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
              sessionPath?: string;
            };
            const sessionPath = body.sessionPath?.trim();
            if (!sessionPath) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Missing sessionPath' }));
              return;
            }
            scanActionableWorks(options, sessionPath);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
      });

      server.middlewares.use('/api/kira-automation/cancel', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
              sessionPath?: string;
              workId?: string;
            };
            const sessionPath = body.sessionPath?.trim();
            const workId = body.workId?.trim();
            if (!sessionPath || !workId) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Missing sessionPath or workId' }));
              return;
            }

            const jobKey = `${sessionPath}::${workId}`;
            const controller = jobAbortControllers.get(jobKey);
            controller?.abort();
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, wasRunning: Boolean(controller) }));
          } catch (error) {
            res.writeHead(500);
            res.end(
              JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            );
          }
        });
      });

      server.middlewares.use('/api/kira-automation/events', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const sessionPath = url.searchParams.get('sessionPath')?.trim();
          if (!sessionPath) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing sessionPath' }));
            return;
          }
          const events = drainEvents(options.sessionsDir, sessionPath);
          res.writeHead(200);
          res.end(JSON.stringify({ events }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}
