import * as fs from 'node:fs';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildAoiFieldEvidenceManifest,
  formatAoiFieldEvidenceManifest,
} from '../aoiFieldEvidenceManifest';
import { resolveAoiAutonomyPaths } from '../aoiAutonomyStore';
import { resolveAoiCurrentSituationPaths } from '../aoiCurrentSituationModel';
import { resolveAoiFieldEventLedgerPaths } from '../aoiFieldEventLedger';

const NOW = 1_800_000_000_000;
const SESSION_PATH = 'aoi/live';
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-field-evidence-test-'));
  tempRoots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function writeJsonLines(filePath: string, values: readonly unknown[]): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${values.map((value) => JSON.stringify(value)).join('\n')}\n`,
    'utf8',
  );
}

function seedPassingLiveFieldSession(root: string): void {
  const autonomy = resolveAoiAutonomyPaths(root, SESSION_PATH);
  const situation = resolveAoiCurrentSituationPaths(root, SESSION_PATH);
  const field = resolveAoiFieldEventLedgerPaths(root, SESSION_PATH);
  writeJsonLines(field.events, [
    {
      version: 1,
      id: 'field-event-1',
      sessionPath: SESSION_PATH,
      category: 'runtime',
      evidenceClass: 'live_field',
      privacyState: 'metadata_only',
      evidenceRefs: ['runtime:window-1'],
      createdAt: NOW - 4_000,
      mutationCount: 0,
    },
  ]);
  writeJsonLines(situation.history, [
    {
      version: 1,
      id: 'situation-1',
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      generatedAt: NOW - 3_000,
      segments: [
        {
          kind: 'activity',
          evidenceRefs: ['field-event:field-event-1'],
        },
      ],
      mutationCount: 0,
    },
  ]);
  writeJson(join(root, SESSION_PATH, 'aoi-run-ledger', 'runs.json'), {
    version: 1,
    savedAt: NOW - 2_000,
    runs: [
      {
        version: 1,
        id: 'run-1',
        evidenceClass: 'live_field',
        createdAt: NOW - 2_500,
        updatedAt: NOW - 2_000,
        events: [
          {
            id: 'event-1',
            type: 'app_action_executed',
            createdAt: NOW - 2_100,
          },
        ],
      },
    ],
  });
  writeJsonLines(autonomy.outcomeSignals, [
    {
      version: 1,
      id: 'outcome-1',
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      outcomeKind: 'proposal_executed',
      evidenceRefs: ['run:run-1'],
      createdAt: NOW - 1_000,
      mutationCount: 0,
    },
    {
      version: 1,
      id: 'outcome-2',
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      outcomeKind: 'user_feedback',
      signalKind: 'explicit_label',
      explicitLabelRef: 'proposal-feedback:decision-1',
      evidenceRefs: ['chat-label:feedback-1'],
      createdAt: NOW - 500,
      mutationCount: 0,
    },
  ]);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi field-evidence manifest', () => {
  it('accepts a complete live-field ledger without changing the session tree', () => {
    const root = makeTempRoot();
    seedPassingLiveFieldSession(root);
    const first = buildAoiFieldEvidenceManifest({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      now: NOW,
    });
    const second = buildAoiFieldEvidenceManifest({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      now: NOW + 1_000,
    });

    expect(first.passed).toBe(true);
    expect(first.claimEligible).toBe(true);
    expect(first.hardFailures).toEqual([]);
    expect(first.requiredEvidenceFailures).toEqual([]);
    expect(first.readOnlyVerified).toBe(true);
    expect(first.sessionRootFingerprintBefore).toBe(first.sessionRootFingerprintAfter);
    expect(second.manifestFingerprint).toBe(first.manifestFingerprint);
    expect(second.sessionRootFingerprintBefore).toBe(first.sessionRootFingerprintBefore);
    expect(first.evidenceClassCounts.live_field.recordCount).toBe(first.validRecordCount);
    expect(first.evidenceClassCounts.synthetic.recordCount).toBe(0);
    expect(first.operationalCounts).toMatchObject({
      fieldEventCount: 1,
      situationSampleCount: 1,
      groundedSituationCount: 1,
      runCount: 1,
      executionOutcomeCount: 1,
      outcomeSignalCount: 2,
      feedbackRecordCount: 1,
    });
    expect(formatAoiFieldEvidenceManifest(first)).toContain('Aoi field evidence: ready');
  });

  it('counts concurrent-retry feedback records once without rewriting the audit ledger', () => {
    const root = makeTempRoot();
    seedPassingLiveFieldSession(root);
    const outcomePath = resolveAoiAutonomyPaths(root, SESSION_PATH).outcomeSignals;
    const correction = 'Keep accuracy and avoid repeated rewrites.';
    const repeatedRecords = [
      {
        version: 1,
        id: 'feedback-retry-1',
        eventId: 'feedback-retry-event-1',
        sessionPath: SESSION_PATH,
        evidenceClass: 'live_field',
        sourceOutcomeId: 'receipt-1',
        outcomeKind: 'user_feedback',
        signalKind: 'explicit_label',
        explicitLabelRef: 'operator-feedback:receipt-1',
        explicitLabel: 'useful',
        createdAt: NOW - 400,
      },
      {
        version: 1,
        id: 'feedback-retry-2',
        eventId: 'feedback-retry-event-2',
        sessionPath: SESSION_PATH,
        evidenceClass: 'live_field',
        sourceOutcomeId: 'receipt-1',
        outcomeKind: 'user_feedback',
        signalKind: 'explicit_label',
        explicitLabelRef: 'operator-feedback:receipt-1',
        explicitLabel: 'useful',
        createdAt: NOW - 300,
      },
      {
        version: 1,
        id: 'correction-retry-1',
        eventId: 'correction-retry-event-1',
        sessionPath: SESSION_PATH,
        evidenceClass: 'live_field',
        sourceOutcomeId: 'receipt-1',
        outcomeKind: 'user_correction',
        signalKind: 'explicit_correction',
        explicitCorrection: correction,
        createdAt: NOW - 200,
      },
      {
        version: 1,
        id: 'correction-retry-2',
        eventId: 'correction-retry-event-2',
        sessionPath: SESSION_PATH,
        evidenceClass: 'live_field',
        sourceOutcomeId: 'receipt-1',
        outcomeKind: 'user_correction',
        signalKind: 'explicit_correction',
        explicitCorrection: correction,
        createdAt: NOW - 100,
      },
    ];
    fs.appendFileSync(
      outcomePath,
      `${repeatedRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );

    const before = fs.readFileSync(outcomePath, 'utf8');
    const manifest = buildAoiFieldEvidenceManifest({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      now: NOW,
    });
    const after = fs.readFileSync(outcomePath, 'utf8');

    expect(manifest.sources.find((source) => source.id === 'outcome_signals')).toMatchObject({
      recordCount: 6,
      validRecordCount: 6,
    });
    expect(manifest.operationalCounts).toMatchObject({
      outcomeSignalCount: 4,
      executionOutcomeCount: 1,
      feedbackRecordCount: 3,
    });
    expect(after).toBe(before);
  });

  it('fails closed when required real evidence is absent', () => {
    const root = makeTempRoot();
    fs.mkdirSync(join(root, SESSION_PATH), { recursive: true });
    const manifest = buildAoiFieldEvidenceManifest({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      now: NOW,
    });

    expect(manifest.passed).toBe(false);
    expect(manifest.requiredEvidenceFailures).toContain('required_source_empty:field_event_ledger');
    expect(manifest.requiredEvidenceFailures).toContain('real_execution_outcome_missing');
    expect(manifest.requiredEvidenceFailures).toContain('real_feedback_signal_missing');
  });

  it('treats valid empty optional collections as empty rather than corrupt', () => {
    const root = makeTempRoot();
    const autonomy = resolveAoiAutonomyPaths(root, SESSION_PATH);
    fs.mkdirSync(join(root, SESSION_PATH), { recursive: true });
    writeJson(autonomy.activeProposals, []);
    writeJson(autonomy.fieldShadowRecords, { version: 1, records: [] });
    const manifest = buildAoiFieldEvidenceManifest({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      now: NOW,
    });

    expect(manifest.parseErrorCount).toBe(0);
    expect(manifest.hardFailures).not.toContain('evidence_parse_error');
  });

  it('detects corrupt JSONL without exposing its contents', () => {
    const root = makeTempRoot();
    seedPassingLiveFieldSession(root);
    const outcomePath = resolveAoiAutonomyPaths(root, SESSION_PATH).outcomeSignals;
    fs.appendFileSync(outcomePath, '{not-json with private payload}\n', 'utf8');
    const manifest = buildAoiFieldEvidenceManifest({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      now: NOW,
    });
    const serialized = JSON.stringify(manifest);

    expect(manifest.passed).toBe(false);
    expect(manifest.parseErrorCount).toBeGreaterThan(0);
    expect(manifest.hardFailures).toContain('evidence_parse_error');
    expect(serialized).not.toContain('not-json with private payload');
  });

  it('rejects synthetic records mixed into a live-field claim', () => {
    const root = makeTempRoot();
    seedPassingLiveFieldSession(root);
    const fieldPath = resolveAoiFieldEventLedgerPaths(root, SESSION_PATH).events;
    fs.appendFileSync(
      fieldPath,
      `${JSON.stringify({
        version: 1,
        id: 'fixture-field-event',
        sessionPath: SESSION_PATH,
        evidenceClass: 'synthetic',
        createdAt: NOW - 100,
      })}\n`,
      'utf8',
    );
    const manifest = buildAoiFieldEvidenceManifest({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      now: NOW,
    });

    expect(manifest.passed).toBe(false);
    expect(manifest.syntheticMarkerCount).toBeGreaterThan(0);
    expect(manifest.mixedEvidenceClass).toBe(true);
    expect(manifest.hardFailures).toContain('mixed_evidence_class');
  });

  it('rejects cross-session records', () => {
    const root = makeTempRoot();
    seedPassingLiveFieldSession(root);
    const fieldPath = resolveAoiFieldEventLedgerPaths(root, SESSION_PATH).events;
    fs.appendFileSync(
      fieldPath,
      `${JSON.stringify({
        version: 1,
        id: 'wrong-session-event',
        sessionPath: 'aoi/other',
        evidenceClass: 'live_field',
        createdAt: NOW - 100,
      })}\n`,
      'utf8',
    );
    const manifest = buildAoiFieldEvidenceManifest({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      now: NOW,
    });

    expect(manifest.passed).toBe(false);
    expect(manifest.sessionMismatchCount).toBe(1);
    expect(manifest.hardFailures).toContain('cross_session_record_detected');
  });

  it('counts private values but never copies them into the report', () => {
    const root = makeTempRoot();
    seedPassingLiveFieldSession(root);
    const privateEmail = 'field-private@example.com';
    const outcomePath = resolveAoiAutonomyPaths(root, SESSION_PATH).outcomeSignals;
    fs.appendFileSync(
      outcomePath,
      `${JSON.stringify({
        version: 1,
        id: 'private-bait',
        sessionPath: SESSION_PATH,
        evidenceClass: 'live_field',
        outcomeKind: 'validation_run',
        note: privateEmail,
        createdAt: NOW - 100,
      })}\n`,
      'utf8',
    );
    const manifest = buildAoiFieldEvidenceManifest({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      now: NOW,
    });
    const serialized = JSON.stringify(manifest);

    expect(manifest.passed).toBe(false);
    expect(manifest.privateValueCount).toBeGreaterThan(0);
    expect(manifest.hardFailures).toContain('private_value_detected');
    expect(serialized).not.toContain(privateEmail);
  });

  it('preserves compacted proactive privacy failures as a hard gate', () => {
    const root = makeTempRoot();
    seedPassingLiveFieldSession(root);
    const autonomy = resolveAoiAutonomyPaths(root, SESSION_PATH);
    writeJson(join(autonomy.proactiveBriefFieldEventsDir, 'compaction.json'), {
      version: 1,
      sessionPath: SESSION_PATH,
      updatedAt: NOW - 100,
      compactedEventCount: 20,
      kindCounts: { shown_dashboard: 20 },
      deliveryModeCounts: { dashboard: 20 },
      redactedEventCount: 1,
      privateLeakCount: 1,
      unauthorizedMutationCount: 0,
      actionAuthority: 'display_only',
      mutationCount: 0,
    });

    const manifest = buildAoiFieldEvidenceManifest({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      now: NOW,
    });

    expect(manifest.operationalCounts.privateLeakCount).toBeGreaterThanOrEqual(1);
    expect(manifest.hardFailures).toContain('private_leak_detected');
    expect(manifest.claimEligible).toBe(false);
  });

  it('never grants a field claim to a synthetic scan', () => {
    const root = makeTempRoot();
    seedPassingLiveFieldSession(root);
    const manifest = buildAoiFieldEvidenceManifest({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'synthetic',
      now: NOW,
    });

    expect(manifest.passed).toBe(false);
    expect(manifest.claimEligible).toBe(false);
    expect(manifest.requiredEvidenceFailures).toEqual([
      'synthetic_evidence_not_field_claim_eligible',
    ]);
  });

  it('rejects evidence timestamps beyond the allowed clock skew', () => {
    const root = makeTempRoot();
    seedPassingLiveFieldSession(root);
    const outcomePath = resolveAoiAutonomyPaths(root, SESSION_PATH).outcomeSignals;
    fs.appendFileSync(
      outcomePath,
      `${JSON.stringify({
        version: 1,
        id: 'future-outcome',
        sessionPath: SESSION_PATH,
        evidenceClass: 'live_field',
        outcomeKind: 'validation_run',
        createdAt: NOW + 10 * 60 * 1000,
      })}\n`,
      'utf8',
    );
    const manifest = buildAoiFieldEvidenceManifest({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      now: NOW,
    });

    expect(manifest.passed).toBe(false);
    expect(manifest.hardFailures).toContain('evidence_timestamp_in_future');
  });

  it('rejects a session path that escapes the sessions directory', () => {
    const root = makeTempRoot();
    expect(() =>
      buildAoiFieldEvidenceManifest({
        sessionsDir: root,
        sessionPath: '../outside',
        evidenceClass: 'live_field',
        now: NOW,
      }),
    ).toThrow();
  });
});
