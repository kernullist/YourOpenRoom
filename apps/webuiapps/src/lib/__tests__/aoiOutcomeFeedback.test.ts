import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAoiChatFileTaskOutcomeInput,
  buildAoiOutcomeFeedbackSuccessMessage,
  buildAoiOutcomeFeedbackSignalInputs,
  parseAoiOutcomeFeedbackContract,
  resolveLatestCompletedAoiFileTaskRun,
  verifyAoiOutcomeFeedbackCompletion,
} from '../aoiOutcomeFeedback';
import { recordAoiOutcomeFeedbackFromUserMessage } from '../aoiOutcomeFeedbackServer';
import { loadAoiOutcomeSignalRecords } from '../aoiAutonomyStore';
import type { AoiOutcomeSignalRecord } from '../aoiAutonomyTypes';
import type { AoiRunLedgerEntry, AoiRunLedgerEvent } from '../aoiRunLedger';

const SESSION = 'aoi/space_adventure';
const NOW = 1_800_000_000_000;
const USER_MESSAGE = `방금 aoi-field-status.md 파일 작업 결과는 useful이다.

근거:
- 실제 SHA-256, 15줄, 715바이트가 모두 검증 결과와 일치했다.

Correction:
- 정확성은 유지하되 다음 파일 작업에서는 불필요한 완료 시도와 반복 재작성을 줄여라.
- 목표 순서는 preview → 승인 → 1회 작성 → 1회 전체 재읽기 → 정확한 SHA 보고다.

이 피드백과 correction을 직전 파일 작업 outcome에 연결해 저장해.
연결된 outcome ID, feedback label, 학습한 correction만 보고하고 workspace 파일은 수정하지 마.`;

let roots: string[] = [];

afterEach(() => {
  roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
  roots = [];
});

function event(
  runId: string,
  index: number,
  type: AoiRunLedgerEvent['type'],
  toolName?: string,
  message?: string,
): AoiRunLedgerEvent {
  return {
    id: `${runId}-${index}`,
    type,
    createdAt: NOW - 100 + index,
    ...(toolName ? { toolNames: [toolName] } : {}),
    ...(message ? { message } : {}),
  };
}

function fileTaskRun(id: string, updatedAt = NOW - 10): AoiRunLedgerEntry {
  const sha256 = 'c30bf090a412baadd91ed32341c091db22986280e1523d3355b040b310f37b54';
  const events = [
    event(id, 1, 'run_started'),
    event(id, 2, 'model_response', 'ide_write_file'),
    event(
      id,
      3,
      'tool_result',
      'ide_write_file',
      JSON.stringify({ ok: true, path: 'written-by-me/output/aoi-field-status.md' }),
    ),
    event(id, 4, 'model_response', 'ide_read_file'),
    event(
      id,
      5,
      'tool_result',
      'ide_read_file',
      JSON.stringify({
        path: 'written-by-me/output/aoi-field-status.md',
        sha256,
        line_count: 15,
        byte_count: 715,
      }),
    ),
    event(id, 6, 'assistant_delivered'),
    event(id, 7, 'run_completed'),
  ];
  return {
    version: 1,
    id,
    createdAt: updatedAt - 100,
    updatedAt,
    status: 'completed',
    goal: {
      summary: 'Write and verify a status file.',
      sourceMessage: 'Write and verify written-by-me/output/aoi-field-status.md.',
      createdAt: updatedAt - 100,
    },
    modelRoute: 'main',
    includeAppTools: true,
    exposedToolNames: ['ide_write_file', 'ide_read_file', 'respond_to_user'],
    events,
    metrics: {
      iterations: 3,
      toolCallCount: 3,
      deliveredToolCallCount: 2,
      errorCount: 0,
      lastToolNames: [
        'ide_write_file(written-by-me/output/aoi-field-status.md)',
        'ide_read_file(written-by-me/output/aoi-field-status.md)',
      ],
    },
    finalMessage: `Changed written-by-me/output/aoi-field-status.md. SHA-256: ${sha256}`,
  };
}

function nonFileRun(id: string): AoiRunLedgerEntry {
  const run = fileTaskRun(id, NOW);
  return {
    ...run,
    events: [event(id, 1, 'run_started'), event(id, 2, 'run_completed')],
    metrics: { ...run.metrics, toolCallCount: 0, deliveredToolCallCount: 0 },
  };
}

function targetOutcome(id = 'chat-file-task:aoi-run-file'): AoiOutcomeSignalRecord {
  return {
    version: 1,
    id,
    eventId: id,
    sessionPath: SESSION,
    sourceChatRef: 'aoi-run:aoi-run-file',
    outcomeKind: 'proposal_executed',
    validationPassed: true,
    signalKind: 'passive_outcome',
    confidence: 0.45,
    inferredAdjustment: {
      version: 1,
      target: 'readiness',
      direction: 'boost',
      magnitude: 0.2,
      reason: 'Verified execution.',
    },
    deliveryMode: 'unknown',
    result: 'positive',
    evidenceRefs: [`outcome:${id}`],
    privacyState: 'metadata_only',
    createdAt: NOW - 10,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

describe('Aoi explicit outcome feedback contract', () => {
  it('extracts only an explicit user-authored label, correction, and previous-file target', () => {
    const contract = parseAoiOutcomeFeedbackContract(USER_MESSAGE);

    expect(contract).toMatchObject({
      feedbackLabel: 'useful',
      targetKind: 'latest_completed_file_task',
      correction:
        '정확성은 유지하되 다음 파일 작업에서는 불필요한 완료 시도와 반복 재작성을 줄여라. 목표 순서는 preview → 승인 → 1회 작성 → 1회 전체 재읽기 → 정확한 SHA 보고다.',
    });
    expect(
      parseAoiOutcomeFeedbackContract(
        '나중에 useful/not useful 피드백과 correction을 제공할게. 기억해둬.',
      ),
    ).toBeNull();
  });

  it('resolves the latest completed run with a successful mutation and later read-back', () => {
    const older = fileTaskRun('aoi-run-older', NOW - 20);
    const newer = fileTaskRun('aoi-run-newer', NOW - 10);
    const resolved = resolveLatestCompletedAoiFileTaskRun([
      nonFileRun('aoi-run-feedback'),
      older,
      newer,
    ]);

    expect(resolved?.id).toBe('aoi-run-newer');
    expect(buildAoiChatFileTaskOutcomeInput(resolved!, SESSION)).toMatchObject({
      id: 'chat-file-task:aoi-run-newer',
      outcomeKind: 'proposal_executed',
      validationPassed: true,
      sourceChatRef: 'aoi-run:aoi-run-newer',
    });
  });

  it('derives two idempotent, first-class links to the same target outcome', () => {
    const contract = parseAoiOutcomeFeedbackContract(USER_MESSAGE)!;
    const first = buildAoiOutcomeFeedbackSignalInputs({
      sessionPath: SESSION,
      contract,
      targetOutcome: targetOutcome(),
      sourceChatRef: 'aoi-run:aoi-run-feedback',
      now: NOW,
    });
    const replay = buildAoiOutcomeFeedbackSignalInputs({
      sessionPath: SESSION,
      contract,
      targetOutcome: targetOutcome(),
      sourceChatRef: 'aoi-run:aoi-run-feedback-retry',
      now: NOW + 100,
    });

    expect(first.feedback.eventId).toBe(replay.feedback.eventId);
    expect(first.correction.eventId).toBe(replay.correction.eventId);
    expect(first.feedback).toMatchObject({
      sourceOutcomeId: 'chat-file-task:aoi-run-file',
      signalKind: 'explicit_label',
      explicitLabel: 'useful',
    });
    expect(first.correction).toMatchObject({
      sourceOutcomeId: 'chat-file-task:aoi-run-file',
      signalKind: 'explicit_correction',
      explicitCorrection: contract.correction,
      inferredAdjustment: {
        target: 'readiness',
        direction: 'suppress',
        magnitude: 0.12,
      },
    });
  });

  it('rejects a generic acknowledgement and accepts only an exact evidence-backed report', () => {
    const contract = parseAoiOutcomeFeedbackContract(USER_MESSAGE)!;
    const evidence = {
      targetRunId: 'aoi-run-file',
      targetOutcomeId: 'chat-file-task:aoi-run-file',
      feedbackOutcomeId: 'user-feedback:1',
      correctionOutcomeId: 'user-correction:1',
      feedbackLabel: contract.feedbackLabel,
      correction: contract.correction,
    };

    expect(
      verifyAoiOutcomeFeedbackCompletion({
        contract,
        evidence: null,
        assistantContent: '알겠어, 기억해둘게.',
      }).issues,
    ).toContain('canonical outcome feedback was not recorded');
    expect(
      verifyAoiOutcomeFeedbackCompletion({
        contract,
        evidence,
        assistantContent: `Outcome ID: ${evidence.targetOutcomeId}\nFeedback label: useful\nCorrection: ${evidence.correction}`,
      }),
    ).toEqual({ passed: true, enforced: true, issues: [] });
  });
});

describe('Aoi outcome feedback canonical persistence', () => {
  it('promotes the prior verified file run, links both records, reads them back, and replays once', () => {
    const root = mkdtempSync(join(tmpdir(), 'aoi-outcome-feedback-'));
    roots.push(root);
    const ledgerPath = join(root, SESSION, 'aoi-run-ledger', 'runs.json');
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        version: 1,
        savedAt: NOW,
        runs: [nonFileRun('aoi-run-feedback'), fileTaskRun('aoi-run-file')],
      }),
      'utf-8',
    );

    const first = recordAoiOutcomeFeedbackFromUserMessage({
      sessionsDir: root,
      sessionPath: SESSION,
      userMessage: USER_MESSAGE,
      sourceChatRef: 'aoi-run:aoi-run-feedback',
      now: NOW,
    });
    const replay = recordAoiOutcomeFeedbackFromUserMessage({
      sessionsDir: root,
      sessionPath: SESSION,
      userMessage: USER_MESSAGE,
      sourceChatRef: 'aoi-run:aoi-run-feedback-retry',
      now: NOW + 100,
    });
    const stored = loadAoiOutcomeSignalRecords(root, SESSION, NOW + 100, 20);

    expect(first.createdOutcomes).toHaveLength(3);
    expect(replay.createdOutcomes).toHaveLength(0);
    expect(stored).toHaveLength(3);
    expect(first.record).toMatchObject({
      targetRunId: 'aoi-run-file',
      feedbackLabel: 'useful',
      targetOutcome: { id: 'chat-file-task:aoi-run-file' },
      feedbackOutcome: {
        sourceOutcomeId: 'chat-file-task:aoi-run-file',
        signalKind: 'explicit_label',
        explicitLabel: 'useful',
      },
      correctionOutcome: {
        sourceOutcomeId: 'chat-file-task:aoi-run-file',
        signalKind: 'explicit_correction',
        explicitCorrection: parseAoiOutcomeFeedbackContract(USER_MESSAGE)?.correction,
      },
    });
    expect(
      verifyAoiOutcomeFeedbackCompletion({
        contract: parseAoiOutcomeFeedbackContract(USER_MESSAGE),
        evidence: {
          targetRunId: first.record.targetRunId,
          targetOutcomeId: first.record.targetOutcome.id,
          feedbackOutcomeId: first.record.feedbackOutcome.id,
          correctionOutcomeId: first.record.correctionOutcome.id,
          feedbackLabel: first.record.feedbackLabel,
          correction: first.record.correction,
        },
        assistantContent: buildAoiOutcomeFeedbackSuccessMessage(first.record),
      }),
    ).toEqual({ passed: true, enforced: true, issues: [] });
  });

  it('recovers a verified persisted chat receipt after background runs evict the file run', () => {
    const root = mkdtempSync(join(tmpdir(), 'aoi-outcome-feedback-chat-receipt-'));
    roots.push(root);
    const ledgerPath = join(root, SESSION, 'aoi-run-ledger', 'runs.json');
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        version: 1,
        savedAt: NOW,
        runs: [nonFileRun('aoi-run-attention-only')],
      }),
      'utf-8',
    );
    const chatPath = join(root, SESSION, 'chat', 'chat.json');
    mkdirSync(dirname(chatPath), { recursive: true });
    writeFileSync(
      chatPath,
      JSON.stringify({
        version: 1,
        savedAt: NOW,
        messages: [
          {
            id: '1784271405334',
            role: 'assistant',
            content:
              '작업 완료. 변경 파일: written-by-me/output/aoi-field-status.md. SHA-256: c30bf090a412baadd91ed32341c091db22986280e1523d3355b040b310f37b54. 다른 파일 수정 없음. 15줄, 715바이트.',
            toolCalls: [
              'ide_write_file(written-by-me/output/aoi-field-status.md)',
              'ide_read_file(written-by-me/output/aoi-field-status.md)',
            ],
          },
        ],
      }),
      'utf-8',
    );

    const result = recordAoiOutcomeFeedbackFromUserMessage({
      sessionsDir: root,
      sessionPath: SESSION,
      userMessage: USER_MESSAGE,
      sourceChatRef: 'aoi-run:aoi-run-feedback-after-eviction',
      now: NOW,
    });
    const stored = loadAoiOutcomeSignalRecords(root, SESSION, NOW, 20);

    expect(result.createdOutcomes).toHaveLength(3);
    expect(result.record).toMatchObject({
      targetRunId: null,
      targetOutcome: {
        id: 'chat-file-task-receipt:1784271405334',
        sourceChatRef: 'chat-message:1784271405334',
        sourceValidationRef: 'chat-delivery-postcondition:1784271405334',
        validationPassed: true,
        evidenceRefs: expect.arrayContaining([
          'file:written-by-me/output/aoi-field-status.md',
          'sha256:c30bf090a412baadd91ed32341c091db22986280e1523d3355b040b310f37b54',
          'line-count:15',
          'byte-count:715',
        ]),
      },
      feedbackOutcome: {
        sourceOutcomeId: 'chat-file-task-receipt:1784271405334',
        explicitLabel: 'useful',
      },
      correctionOutcome: {
        sourceOutcomeId: 'chat-file-task-receipt:1784271405334',
        explicitCorrection: parseAoiOutcomeFeedbackContract(USER_MESSAGE)?.correction,
      },
    });
    expect(stored).toHaveLength(3);
  });
});
