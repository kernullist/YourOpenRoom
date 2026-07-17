import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { appendAoiOutcomeSignalRecord, loadAoiOutcomeSignalRecords } from '../aoiAutonomyStore';
import { deriveAoiExecutedActionOutcomeSignal } from '../aoiOutcomeLearning';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'aoi-outcome-canonical-')));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('canonical execution outcome storage', () => {
  it('writes exactly one record when the same attempt is replayed', () => {
    const root = makeRoot();
    const signal = deriveAoiExecutedActionOutcomeSignal({
      sessionPath: SESSION_PATH,
      proposalId: 'proposal-1',
      decisionId: 'decision-1',
      actionKind: 'file-mutation',
      auditId: 'audit-1',
      ok: true,
      executionEvidence: {
        version: 1,
        attemptId: 'audit-1',
        actionKind: 'file_write',
        approvalFingerprint: 'aabbccdd',
        checkpointFingerprint: '1'.repeat(64),
        targetBeforeSha256: 'absent',
        targetAfterSha256: '2'.repeat(64),
        validationStatus: 'passed',
        rollbackAttempted: false,
        rollbackSucceeded: false,
      },
    });
    const first = appendAoiOutcomeSignalRecord(root, signal, NOW);
    const replay = appendAoiOutcomeSignalRecord(root, signal, NOW + 1);
    expect(replay.id).toBe(first.id);
    const outcomes = loadAoiOutcomeSignalRecords(root, SESSION_PATH, NOW + 1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].executionEvidence).toMatchObject({
      attemptId: 'audit-1',
      validationStatus: 'passed',
      checkpointFingerprint: '1'.repeat(64),
    });
  });
});
