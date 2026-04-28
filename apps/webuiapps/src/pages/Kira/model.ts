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

export interface KiraAttemptRecord {
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
  diffExcerpts?: string[];
  blockedReason?: string;
  rollbackFiles?: string[];
  workerPlan?: {
    summary?: string;
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

export function normalizeKiraAttempt(raw: unknown): KiraAttemptRecord | null {
  const parsed = parseRecord<Partial<KiraAttemptRecord>>(raw);
  if (!parsed?.id || !parsed.workId) return null;
  return {
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
