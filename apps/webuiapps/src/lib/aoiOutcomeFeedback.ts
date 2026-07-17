import type { AoiOutcomeSignalInput } from './aoiOutcomeLearning';
import type { AoiOutcomeSignalRecord } from './aoiAutonomyTypes';
import type { AoiRunLedgerEntry, AoiRunLedgerEvent } from './aoiRunLedger';

export type AoiExplicitOutcomeFeedbackLabel = 'useful' | 'not_useful';

export interface AoiOutcomeFeedbackContract {
  version: 1;
  sourceMessage: string;
  feedbackLabel: AoiExplicitOutcomeFeedbackLabel;
  correction: string;
  targetKind: 'outcome_id' | 'latest_completed_file_task';
  targetOutcomeId?: string;
}

export interface AoiOutcomeFeedbackEvidence {
  targetRunId: string | null;
  targetOutcomeId: string;
  feedbackOutcomeId: string;
  correctionOutcomeId: string;
  feedbackLabel: AoiExplicitOutcomeFeedbackLabel;
  correction: string;
}

export interface AoiOutcomeFeedbackVerification {
  passed: boolean;
  enforced: boolean;
  issues: string[];
}

export interface AoiRecordedOutcomeFeedback {
  version: 1;
  sessionPath: string;
  targetRunId: string | null;
  feedbackLabel: AoiExplicitOutcomeFeedbackLabel;
  correction: string;
  targetOutcome: AoiOutcomeSignalRecord;
  feedbackOutcome: AoiOutcomeSignalRecord;
  correctionOutcome: AoiOutcomeSignalRecord;
}

export interface AoiOutcomeFeedbackSignalInputs {
  feedback: Partial<AoiOutcomeSignalRecord> & AoiOutcomeSignalInput;
  correction: Partial<AoiOutcomeSignalRecord> & AoiOutcomeSignalInput;
}

export interface AoiPersistedChatFileTaskReceipt {
  messageId: string;
  createdAt: number;
  path: string;
  sha256: string;
  lineCount: number;
  byteCount: number;
}

const FILE_MUTATION_TOOLS = new Set([
  'ide_write_file',
  'ide_patch_file',
  'file_write',
  'file_patch',
]);
const FILE_READ_TOOLS = new Set(['ide_read_file', 'file_read']);
const OUTCOME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u;
const CHAT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function normalizeFeedbackLabel(value: string): AoiExplicitOutcomeFeedbackLabel | null {
  const normalized = value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[ _-]+/gu, '_');
  if (normalized === 'useful') {
    return 'useful';
  }
  if (normalized === 'not_useful') {
    return 'not_useful';
  }
  return null;
}

function parseExplicitFeedbackLabel(message: string): AoiExplicitOutcomeFeedbackLabel | null {
  const patterns = [
    /(?:feedback\s*label|피드백\s*라벨|평가\s*라벨)\s*[:=]\s*(not[ _-]*useful|useful)\b/iu,
    /(?:결과|outcome|작업)\s*(?:은|는|이|가|:|=)?\s*(not[ _-]*useful|useful)\s*(?:이다|입니다|였다|였습니다)?\b/iu,
    /\b(not[ _-]*useful|useful)\s*(?:이다|입니다|로\s*평가|피드백|feedback)\b/iu,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      return normalizeFeedbackLabel(match[1]);
    }
  }
  return null;
}

function isPostCorrectionInstruction(line: string): boolean {
  return (
    /^(?:이\s*)?(?:피드백|feedback|correction).*(?:연결|저장|link|attach|record|save)/iu.test(
      line,
    ) ||
    /^(?:연결된|linked)\s+outcome/iu.test(line) ||
    /^(?:workspace|작업공간)\s*(?:파일|file)/iu.test(line) ||
    /^(?:do\s+not|don't)\s+(?:modify|change|write)/iu.test(line)
  );
}

function stripListPrefix(line: string): string {
  return line.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, '').trim();
}

function parseExplicitCorrection(message: string): string | null {
  const lines = message.replace(/\r\n?/gu, '\n').split('\n');
  let collecting = false;
  const correctionLines: string[] = [];

  for (const line of lines) {
    if (!collecting) {
      const marker = line.match(/^\s*(?:correction|교정|수정\s*지침)\s*:\s*(.*)$/iu);
      if (!marker) {
        continue;
      }
      collecting = true;
      const inline = stripListPrefix(marker[1]);
      if (inline) {
        correctionLines.push(inline);
      }
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (correctionLines.length > 0 && isPostCorrectionInstruction(trimmed)) {
      break;
    }
    const correctionLine = stripListPrefix(trimmed);
    if (correctionLine) {
      correctionLines.push(correctionLine);
    }
  }

  const correction = compactWhitespace(correctionLines.join(' '));
  return correction ? correction.slice(0, 1000) : null;
}

function parseTargetOutcomeId(message: string): string | null {
  const match = message.match(
    /\boutcome(?:\s+id)?\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._:-]{2,159})\b/iu,
  );
  return match && OUTCOME_ID_PATTERN.test(match[1]) ? match[1] : null;
}

export function parseAoiOutcomeFeedbackContract(
  message: string,
): AoiOutcomeFeedbackContract | null {
  const sourceMessage = message.trim();
  if (!sourceMessage) {
    return null;
  }
  const hasFeedbackContext = /(?:피드백|feedback)/iu.test(sourceMessage);
  const hasOutcomeContext = /(?:outcome|결과)/iu.test(sourceMessage);
  const hasLinkInstruction = /(?:연결|link|attach)/iu.test(sourceMessage);
  if (!hasFeedbackContext || !hasOutcomeContext || !hasLinkInstruction) {
    return null;
  }

  const feedbackLabel = parseExplicitFeedbackLabel(sourceMessage);
  const correction = parseExplicitCorrection(sourceMessage);
  if (!feedbackLabel || !correction) {
    return null;
  }

  const targetOutcomeId = parseTargetOutcomeId(sourceMessage);
  if (targetOutcomeId) {
    return {
      version: 1,
      sourceMessage,
      feedbackLabel,
      correction,
      targetKind: 'outcome_id',
      targetOutcomeId,
    };
  }

  const referencesPreviousFileTask =
    /(?:직전|이전|최근|previous|prior|latest).{0,48}(?:파일\s*작업|file\s*(?:task|operation)|outcome)/isu.test(
      sourceMessage,
    );
  if (!referencesPreviousFileTask) {
    return null;
  }
  return {
    version: 1,
    sourceMessage,
    feedbackLabel,
    correction,
    targetKind: 'latest_completed_file_task',
  };
}

function eventHasTool(event: AoiRunLedgerEvent, toolNames: ReadonlySet<string>): boolean {
  return Boolean(event.toolNames?.some((toolName) => toolNames.has(toolName)));
}

export function isCompletedAoiFileTaskRun(run: AoiRunLedgerEntry): boolean {
  if (run.status !== 'completed') {
    return false;
  }
  let lastMutationIndex = -1;
  for (let index = 0; index < run.events.length; index += 1) {
    const event = run.events[index];
    if (event.type === 'tool_result' && eventHasTool(event, FILE_MUTATION_TOOLS)) {
      lastMutationIndex = index;
    }
  }
  if (lastMutationIndex < 0) {
    return false;
  }
  return run.events
    .slice(lastMutationIndex + 1)
    .some(
      (event) =>
        event.type === 'tool_result' &&
        eventHasTool(event, FILE_READ_TOOLS) &&
        !/^(?:error|failed|failure):/iu.test(event.message?.trim() ?? ''),
    );
}

export function resolveLatestCompletedAoiFileTaskRun(
  runs: readonly AoiRunLedgerEntry[],
  excludeRunId?: string,
): AoiRunLedgerEntry | null {
  return (
    [...runs]
      .filter((run) => run.id !== excludeRunId && isCompletedAoiFileTaskRun(run))
      .sort(
        (left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt,
      )[0] ?? null
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parsePersistedToolCallName(value: string): string | null {
  return value.trim().match(/^([A-Za-z0-9_]+)(?:\(|$)/u)?.[1] ?? null;
}

function normalizeReceiptPath(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/^["'`]+|["'`]+$/gu, '')
    .replace(/\\/gu, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split('/').some((part) => part === '..')
  ) {
    return null;
  }
  return normalized.slice(0, 500);
}

function parseReadToolPath(toolCall: string): string | null {
  const match = toolCall.trim().match(/^[A-Za-z0-9_]+\((.*)\)$/su);
  if (!match) {
    return null;
  }
  const rawArgument = match[1].trim();
  if (rawArgument.startsWith('{')) {
    try {
      const parsed = JSON.parse(rawArgument) as Record<string, unknown>;
      return typeof parsed.path === 'string' ? normalizeReceiptPath(parsed.path) : null;
    } catch {
      return null;
    }
  }
  return normalizeReceiptPath(rawArgument);
}

function parseReceiptCount(content: string, unitPattern: 'line' | 'byte'): number | null {
  const pattern =
    unitPattern === 'line'
      ? /(\d{1,7})\s*(?:줄|lines?)(?=\s|[,.)]|$)/iu
      : /(\d{1,10})\s*(?:바이트|bytes?)(?=\s|[,.)]|$)/iu;
  const value = Number(content.match(pattern)?.[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function resolveLatestAoiPersistedChatFileTaskReceipt(
  messages: readonly unknown[],
  now = Date.now(),
): AoiPersistedChatFileTaskReceipt | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message || message.role !== 'assistant' || typeof message.content !== 'string') {
      continue;
    }
    const messageId = typeof message.id === 'string' ? message.id.trim() : '';
    if (!CHAT_MESSAGE_ID_PATTERN.test(messageId)) {
      continue;
    }
    const toolCalls = Array.isArray(message.toolCalls)
      ? message.toolCalls.filter((value): value is string => typeof value === 'string')
      : [];
    let lastMutationIndex = -1;
    for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
      const toolName = parsePersistedToolCallName(toolCalls[toolIndex]);
      if (toolName && FILE_MUTATION_TOOLS.has(toolName)) {
        lastMutationIndex = toolIndex;
      }
    }
    if (lastMutationIndex < 0) {
      continue;
    }
    const readToolCall = toolCalls.slice(lastMutationIndex + 1).find((toolCall) => {
      const toolName = parsePersistedToolCallName(toolCall);
      return toolName !== null && FILE_READ_TOOLS.has(toolName);
    });
    if (!readToolCall || !/(?:작업\s*완료|(?:file\s+)?task\s+completed)/iu.test(message.content)) {
      continue;
    }
    const path = parseReadToolPath(readToolCall);
    const sha256 = message.content.match(/\bSHA-?256\s*:\s*([a-f0-9]{64})\b/iu)?.[1];
    const lineCount = parseReceiptCount(message.content, 'line');
    const byteCount = parseReceiptCount(message.content, 'byte');
    const normalizedContent = message.content.replace(/\\/gu, '/');
    if (
      !path ||
      !normalizedContent.includes(path) ||
      !sha256 ||
      lineCount === null ||
      byteCount === null
    ) {
      continue;
    }
    const messageTimestamp =
      typeof message.createdAt === 'number' && Number.isFinite(message.createdAt)
        ? message.createdAt
        : Number(messageId);
    return {
      messageId,
      createdAt: Number.isFinite(messageTimestamp) && messageTimestamp > 0 ? messageTimestamp : now,
      path,
      sha256: sha256.toLocaleLowerCase('en-US'),
      lineCount,
      byteCount,
    };
  }
  return null;
}

function parseResultField(message: string | undefined, field: string): string | null {
  if (!message) {
    return null;
  }
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    const value = parsed[field];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  } catch {
    // Run-ledger tool results are compacted and can be intentionally truncated.
  }
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = message.match(new RegExp(`"${escapedField}"\\s*:\\s*"([^"]+)"`, 'iu'));
  return match?.[1]?.trim() || null;
}

function lastFileTaskReadEvent(run: AoiRunLedgerEntry): AoiRunLedgerEvent | null {
  let lastMutationIndex = -1;
  for (let index = 0; index < run.events.length; index += 1) {
    if (
      run.events[index].type === 'tool_result' &&
      eventHasTool(run.events[index], FILE_MUTATION_TOOLS)
    ) {
      lastMutationIndex = index;
    }
  }
  if (lastMutationIndex < 0) {
    return null;
  }
  const reads = run.events
    .slice(lastMutationIndex + 1)
    .filter((event) => event.type === 'tool_result' && eventHasTool(event, FILE_READ_TOOLS));
  return reads[reads.length - 1] ?? null;
}

export function buildAoiChatFileTaskOutcomeInput(
  run: AoiRunLedgerEntry,
  sessionPath: string,
): Partial<AoiOutcomeSignalRecord> & AoiOutcomeSignalInput {
  if (!isCompletedAoiFileTaskRun(run)) {
    throw new Error(`Run ${run.id} is not a completed, read-back-verified file task.`);
  }
  const readEvent = lastFileTaskReadEvent(run);
  const path = parseResultField(readEvent?.message, 'path');
  const sha256 = parseResultField(readEvent?.message, 'sha256');
  const eventId = `chat-file-task:${run.id}`;
  return {
    id: eventId,
    eventId,
    sessionPath,
    sourceChatRef: `aoi-run:${run.id}`,
    sourceValidationRef: `aoi-run-ledger:${run.id}`,
    outcomeKind: 'proposal_executed',
    signalKind: 'passive_outcome',
    confidence: 0.45,
    validationPassed: true,
    evidenceRefs: [
      `aoi-run-ledger:${run.id}`,
      ...(path ? [`file:${path}`] : []),
      ...(sha256 && /^[a-f0-9]{64}$/iu.test(sha256) ? [`sha256:${sha256}`] : []),
    ],
    privacyState: 'metadata_only',
    createdAt: run.updatedAt,
  };
}

export function buildAoiPersistedChatFileTaskOutcomeInput(
  receipt: AoiPersistedChatFileTaskReceipt,
  sessionPath: string,
): Partial<AoiOutcomeSignalRecord> & AoiOutcomeSignalInput {
  const eventId = `chat-file-task-receipt:${receipt.messageId}`;
  return {
    id: eventId,
    eventId,
    sessionPath,
    sourceChatRef: `chat-message:${receipt.messageId}`,
    sourceValidationRef: `chat-delivery-postcondition:${receipt.messageId}`,
    outcomeKind: 'proposal_executed',
    signalKind: 'passive_outcome',
    confidence: 0.45,
    validationPassed: true,
    evidenceRefs: [
      `chat-message:${receipt.messageId}`,
      `file:${receipt.path}`,
      `sha256:${receipt.sha256}`,
      `line-count:${receipt.lineCount}`,
      `byte-count:${receipt.byteCount}`,
    ],
    privacyState: 'metadata_only',
    createdAt: receipt.createdAt,
  };
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function stableFeedbackFingerprint(value: string): string {
  return `${fnv1a(value)}${fnv1a(`aoi-outcome-feedback\n${value}`)}`;
}

export function buildAoiOutcomeFeedbackSignalInputs(params: {
  sessionPath: string;
  contract: AoiOutcomeFeedbackContract;
  targetOutcome: AoiOutcomeSignalRecord;
  sourceChatRef: string;
  now?: number;
}): AoiOutcomeFeedbackSignalInputs {
  const now = params.now ?? Date.now();
  const fingerprint = stableFeedbackFingerprint(
    [
      params.sessionPath,
      params.targetOutcome.id,
      params.contract.feedbackLabel,
      params.contract.correction,
    ].join('\n'),
  );
  const feedbackEventId = `user-feedback:${fingerprint}`;
  const correctionEventId = `user-correction:${fingerprint}`;
  const feedbackRef = `operator-feedback:${fingerprint}`;
  const common = {
    sessionPath: params.sessionPath,
    sourceOutcomeId: params.targetOutcome.id,
    sourceChatRef: params.sourceChatRef,
    explicitLabelRef: feedbackRef,
    evidenceRefs: [`outcome:${params.targetOutcome.id}`, feedbackRef],
    privacyState: 'metadata_only' as const,
  };

  return {
    feedback: {
      ...common,
      id: feedbackEventId,
      eventId: feedbackEventId,
      outcomeKind: 'user_feedback',
      signalKind: 'explicit_label',
      confidence: 0.72,
      explicitLabel: params.contract.feedbackLabel,
      createdAt: now,
    },
    correction: {
      ...common,
      id: correctionEventId,
      eventId: correctionEventId,
      outcomeKind: 'user_correction',
      signalKind: 'explicit_correction',
      confidence: 0.62,
      explicitCorrection: params.contract.correction,
      inferredAdjustment: {
        version: 1,
        target: 'readiness',
        direction: 'suppress',
        magnitude: 0.12,
        reason:
          'User-authored correction narrows future behavior without overriding the linked result label.',
      },
      createdAt: now + 1,
    },
  };
}

export function toAoiOutcomeFeedbackEvidence(
  result: AoiRecordedOutcomeFeedback,
): AoiOutcomeFeedbackEvidence {
  return {
    targetRunId: result.targetRunId,
    targetOutcomeId: result.targetOutcome.id,
    feedbackOutcomeId: result.feedbackOutcome.id,
    correctionOutcomeId: result.correctionOutcome.id,
    feedbackLabel: result.feedbackLabel,
    correction: result.correction,
  };
}

export function buildAoiOutcomeFeedbackSuccessMessage(result: AoiRecordedOutcomeFeedback): string {
  return [
    `연결된 Outcome ID: ${result.targetOutcome.id}`,
    `Feedback Label: ${result.feedbackLabel}`,
    `학습한 Correction: ${result.correction}`,
  ].join('\n');
}

export function verifyAoiOutcomeFeedbackCompletion(params: {
  contract: AoiOutcomeFeedbackContract | null;
  evidence: AoiOutcomeFeedbackEvidence | null;
  assistantContent: string;
}): AoiOutcomeFeedbackVerification {
  if (!params.contract) {
    return { passed: true, enforced: false, issues: [] };
  }
  const issues: string[] = [];
  if (!params.evidence) {
    issues.push('canonical outcome feedback was not recorded');
  } else {
    if (params.evidence.feedbackLabel !== params.contract.feedbackLabel) {
      issues.push('recorded feedback label does not match the user-authored label');
    }
    if (
      compactWhitespace(params.evidence.correction) !==
      compactWhitespace(params.contract.correction)
    ) {
      issues.push('recorded correction does not match the user-authored correction');
    }
    const normalizedContent = compactWhitespace(params.assistantContent).toLocaleLowerCase('en-US');
    if (!normalizedContent.includes(params.evidence.targetOutcomeId.toLocaleLowerCase('en-US'))) {
      issues.push(`final response is missing linked outcome ID ${params.evidence.targetOutcomeId}`);
    }
    const labelText = params.evidence.feedbackLabel.replace('_', ' ');
    if (
      !normalizedContent.includes(params.evidence.feedbackLabel) &&
      !normalizedContent.includes(labelText)
    ) {
      issues.push(`final response is missing feedback label ${params.evidence.feedbackLabel}`);
    }
    if (
      !normalizedContent.includes(
        compactWhitespace(params.evidence.correction).toLocaleLowerCase('en-US'),
      )
    ) {
      issues.push('final response is missing the learned correction');
    }
  }
  return { passed: issues.length === 0, enforced: true, issues };
}

export function buildAoiOutcomeFeedbackContractPrompt(
  contract: AoiOutcomeFeedbackContract,
): string {
  return [
    '',
    'Deterministic operator-outcome feedback contract:',
    `- The user explicitly authored feedback label ${contract.feedbackLabel}.`,
    `- The user-authored correction is: ${JSON.stringify(contract.correction)}.`,
    contract.targetKind === 'outcome_id'
      ? `- Link both records to canonical outcome ${contract.targetOutcomeId}.`
      : '- Resolve and link the latest completed, read-back-verified file-task run.',
    '- Call record_outcome_feedback exactly once. Do not call save_memory for this request.',
    '- The tool must persist and read back one explicit label and one explicit correction linked to the same target outcome.',
    '- After the tool succeeds, report only the linked outcome ID, feedback label, and exact learned correction.',
    '- The runtime will reject respond_to_user until those postconditions are proven.',
  ].join('\n');
}

export function buildAoiOutcomeFeedbackCorrectionPrompt(
  verification: AoiOutcomeFeedbackVerification,
  evidence: AoiOutcomeFeedbackEvidence | null,
): string {
  const nextAction = evidence
    ? `Call respond_to_user with linked outcome ID ${evidence.targetOutcomeId}, feedback label ${evidence.feedbackLabel}, and exact learned correction ${JSON.stringify(evidence.correction)}.`
    : 'Call record_outcome_feedback now. Do not call save_memory. After it succeeds, use its exact linked_outcome_id, feedback_label, and learned_correction fields.';
  return `Aoi outcome feedback completion check failed: ${verification.issues.join('; ')}. ${nextAction}`;
}

export function buildAoiOutcomeFeedbackFailureMessage(
  verification: AoiOutcomeFeedbackVerification,
): string {
  return `Aoi outcome feedback failed its deterministic completion checks: ${verification.issues.join('; ')}`;
}

export function getAoiOutcomeFeedbackToolDefinition() {
  return {
    type: 'function' as const,
    function: {
      name: 'record_outcome_feedback',
      description:
        'Record the latest user-authored useful/not-useful label and correction against the specified or latest completed file-task outcome. Never invent feedback.',
      parameters: {
        type: 'object' as const,
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  };
}
