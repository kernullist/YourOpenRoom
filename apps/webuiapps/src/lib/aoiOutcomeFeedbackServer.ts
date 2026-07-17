import { readFileSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import { appendAoiOutcomeSignalRecord, loadAoiOutcomeSignalRecords } from './aoiAutonomyStore';
import type { AoiOutcomeSignalRecord } from './aoiAutonomyTypes';
import {
  buildAoiChatFileTaskOutcomeInput,
  buildAoiOutcomeFeedbackSignalInputs,
  buildAoiPersistedChatFileTaskOutcomeInput,
  parseAoiOutcomeFeedbackContract,
  resolveLatestAoiPersistedChatFileTaskReceipt,
  resolveLatestCompletedAoiFileTaskRun,
  type AoiRecordedOutcomeFeedback,
} from './aoiOutcomeFeedback';
import { loadServerAoiRunLedger } from './aoiRunLedgerServer';

export interface AoiOutcomeFeedbackServerResult {
  record: AoiRecordedOutcomeFeedback;
  createdOutcomes: AoiOutcomeSignalRecord[];
}

function requireSourceChatRef(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 180 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/u.test(normalized)
  ) {
    throw new Error('A bounded sourceChatRef is required for operator outcome feedback.');
  }
  return normalized;
}

function currentRunIdFromChatRef(sourceChatRef: string): string | undefined {
  return sourceChatRef.startsWith('aoi-run:') ? sourceChatRef.slice('aoi-run:'.length) : undefined;
}

function requireStoredOutcome(
  outcomes: readonly AoiOutcomeSignalRecord[],
  id: string,
): AoiOutcomeSignalRecord {
  const outcome = outcomes.find((item) => item.id === id || item.eventId === id);
  if (!outcome) {
    throw new Error(`Canonical outcome ${id} was not found after write-back.`);
  }
  return outcome;
}

function findMatchingFeedbackOutcome(
  outcomes: readonly AoiOutcomeSignalRecord[],
  targetOutcomeId: string,
  label: string,
): AoiOutcomeSignalRecord | null {
  return (
    outcomes.find(
      (outcome) =>
        outcome.sourceOutcomeId === targetOutcomeId &&
        outcome.signalKind === 'explicit_label' &&
        outcome.explicitLabel === label,
    ) ?? null
  );
}

function findMatchingCorrectionOutcome(
  outcomes: readonly AoiOutcomeSignalRecord[],
  targetOutcomeId: string,
  correction: string,
): AoiOutcomeSignalRecord | null {
  return (
    outcomes.find(
      (outcome) =>
        outcome.sourceOutcomeId === targetOutcomeId &&
        outcome.signalKind === 'explicit_correction' &&
        outcome.explicitCorrection === correction,
    ) ?? null
  );
}

function loadPersistedChatMessages(sessionsDir: string, sessionPath: string): readonly unknown[] {
  const sessionsRoot = resolve(sessionsDir);
  const chatPath = resolve(sessionsRoot, ...sessionPath.split('/'), 'chat', 'chat.json');
  const relativeChatPath = relative(sessionsRoot, chatPath);
  if (relativeChatPath.startsWith('..') || isAbsolute(relativeChatPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(chatPath, 'utf-8')) as Record<string, unknown>;
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch {
    return [];
  }
}

export function recordAoiOutcomeFeedbackFromUserMessage(params: {
  sessionsDir: string;
  sessionPath: string;
  userMessage: string;
  sourceChatRef: string;
  now?: number;
}): AoiOutcomeFeedbackServerResult {
  const contract = parseAoiOutcomeFeedbackContract(params.userMessage);
  if (!contract) {
    throw new Error(
      'The latest user message does not contain an explicit outcome target, useful/not-useful label, and correction.',
    );
  }
  const sourceChatRef = requireSourceChatRef(params.sourceChatRef);
  const now = params.now ?? Date.now();
  const existing = loadAoiOutcomeSignalRecords(params.sessionsDir, params.sessionPath, now, 500);
  const existingEventIds = new Set(existing.map((outcome) => outcome.eventId));
  const createdOutcomes: AoiOutcomeSignalRecord[] = [];

  let targetRunId: string | null = null;
  let targetOutcome: AoiOutcomeSignalRecord;
  if (contract.targetKind === 'outcome_id') {
    targetOutcome = requireStoredOutcome(existing, contract.targetOutcomeId ?? '');
  } else {
    const targetRun = resolveLatestCompletedAoiFileTaskRun(
      loadServerAoiRunLedger(params.sessionsDir, params.sessionPath),
      currentRunIdFromChatRef(sourceChatRef),
    );
    const persistedReceipt = targetRun
      ? null
      : resolveLatestAoiPersistedChatFileTaskReceipt(
          loadPersistedChatMessages(params.sessionsDir, params.sessionPath),
          now,
        );
    if (!targetRun && !persistedReceipt) {
      throw new Error(
        'No completed, read-back-verified file-task run or persisted completion receipt is available to receive feedback.',
      );
    }
    targetRunId = targetRun?.id ?? null;
    const targetInput = targetRun
      ? buildAoiChatFileTaskOutcomeInput(targetRun, params.sessionPath)
      : buildAoiPersistedChatFileTaskOutcomeInput(persistedReceipt!, params.sessionPath);
    const targetEventId = targetInput.eventId!;
    targetOutcome =
      existing.find((outcome) => outcome.eventId === targetEventId) ??
      appendAoiOutcomeSignalRecord(
        params.sessionsDir,
        {
          ...targetInput,
          sessionPath: params.sessionPath,
        },
        now,
      );
    if (!existingEventIds.has(targetOutcome.eventId)) {
      createdOutcomes.push(targetOutcome);
      existingEventIds.add(targetOutcome.eventId);
    }
  }

  const inputs = buildAoiOutcomeFeedbackSignalInputs({
    sessionPath: params.sessionPath,
    contract,
    targetOutcome,
    sourceChatRef,
    now,
  });
  const feedbackOutcome =
    findMatchingFeedbackOutcome(existing, targetOutcome.id, contract.feedbackLabel) ??
    appendAoiOutcomeSignalRecord(params.sessionsDir, inputs.feedback, now);
  if (!existingEventIds.has(feedbackOutcome.eventId)) {
    createdOutcomes.push(feedbackOutcome);
    existingEventIds.add(feedbackOutcome.eventId);
  }
  const correctionOutcome =
    findMatchingCorrectionOutcome(existing, targetOutcome.id, contract.correction) ??
    appendAoiOutcomeSignalRecord(params.sessionsDir, inputs.correction, now + 1);
  if (!existingEventIds.has(correctionOutcome.eventId)) {
    createdOutcomes.push(correctionOutcome);
    existingEventIds.add(correctionOutcome.eventId);
  }

  const stored = loadAoiOutcomeSignalRecords(params.sessionsDir, params.sessionPath, now + 1, 500);
  targetOutcome = requireStoredOutcome(stored, targetOutcome.id);
  const storedFeedback = requireStoredOutcome(stored, feedbackOutcome.id);
  const storedCorrection = requireStoredOutcome(stored, correctionOutcome.id);
  if (
    storedFeedback.sourceOutcomeId !== targetOutcome.id ||
    storedFeedback.signalKind !== 'explicit_label' ||
    storedFeedback.explicitLabel !== contract.feedbackLabel
  ) {
    throw new Error('Canonical feedback read-back did not preserve the target outcome and label.');
  }
  if (
    storedCorrection.sourceOutcomeId !== targetOutcome.id ||
    storedCorrection.signalKind !== 'explicit_correction' ||
    storedCorrection.explicitCorrection !== contract.correction
  ) {
    throw new Error('Canonical correction read-back did not preserve the target outcome and text.');
  }

  return {
    record: {
      version: 1,
      sessionPath: params.sessionPath,
      targetRunId,
      feedbackLabel: contract.feedbackLabel,
      correction: contract.correction,
      targetOutcome,
      feedbackOutcome: storedFeedback,
      correctionOutcome: storedCorrection,
    },
    createdOutcomes,
  };
}
