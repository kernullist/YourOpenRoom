import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveAoiOutcomeSignalsFromKiraOutcomes,
  persistAoiKiraOutcomeSignals,
} from '../aoiKiraOutcomeLearning';
import { loadAoiOutcomeSignalRecords } from '../aoiAutonomyStore';
import type { AoiKiraOutcomeEvent, AoiKiraOutcomeKind } from '../aoiAutonomyTypes';

const SESSION = 'aoi/default';
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-kira-outcome-'));
  tempRoots.push(root);
  return fs.realpathSync(root);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

function event(
  kind: AoiKiraOutcomeKind,
  over: Partial<AoiKiraOutcomeEvent> = {},
): AoiKiraOutcomeEvent {
  const base: AoiKiraOutcomeEvent = {
    version: 1,
    id: 'kira-ev',
    sessionPath: SESSION,
    kind,
    workId: 'w1',
    workRef: 'kira-work:w1',
    workTitle: 'Fix tests',
    projectName: 'openroom',
    validationSummary: '',
    changedFilesSummary: '',
    evidenceRefs: ['kira-work:w1'],
    validationPassed: true,
    integrated: false,
    reviewerNotes: [],
    createdAt: 1000,
    dedupeKey: `kira-outcome:${kind}`,
    sourceProposalId: 'prop-1',
  };
  return { ...base, ...over };
}

describe('deriveAoiOutcomeSignalsFromKiraOutcomes()', () => {
  it('maps each linked execution outcome kind to the right signal', () => {
    const signals = deriveAoiOutcomeSignalsFromKiraOutcomes([
      event('kira_integrated', { id: 'a' }),
      event('kira_work_completed', { id: 'b' }),
      event('kira_validation_failed', { id: 'c' }),
      event('kira_review_rejected', { id: 'd' }),
      event('kira_work_blocked', { id: 'e' }),
    ]);

    expect(signals.map((signal) => [signal.outcomeKind, signal.result])).toEqual([
      ['commit_created', 'positive'],
      ['work_order_approved', 'positive'],
      ['validation_run', 'failed'],
      ['work_order_rejected', 'negative'],
      ['work_order_rejected', 'blocked'],
    ]);
    expect(signals[0].eventId).toBe('kira-outcome:a');
    expect(signals[0].sourceProposalId).toBe('prop-1');
  });

  it('skips the non-execution clarification kind', () => {
    expect(deriveAoiOutcomeSignalsFromKiraOutcomes([event('kira_needs_clarification')])).toEqual(
      [],
    );
  });

  it('skips unlinked outcomes (no sourceProposalId) -- not attributable to a capability', () => {
    const signals = deriveAoiOutcomeSignalsFromKiraOutcomes([
      event('kira_integrated', { sourceProposalId: undefined }),
    ]);
    expect(signals).toEqual([]);
  });
});

describe('persistAoiKiraOutcomeSignals()', () => {
  it('appends the derived signals to the unified outcome-signal ledger', () => {
    const root = makeRoot();

    const written = persistAoiKiraOutcomeSignals(
      root,
      [event('kira_integrated', { id: 'x', sourceProposalId: 'prop-9' })],
      2000,
    );

    expect(written).toBe(1);
    const records = loadAoiOutcomeSignalRecords(root, SESSION, 3000);
    expect(records).toHaveLength(1);
    expect(records[0].outcomeKind).toBe('commit_created');
    expect(records[0].result).toBe('positive');
    expect(records[0].sourceProposalId).toBe('prop-9');
  });

  it('writes nothing when there are no linked execution outcomes', () => {
    const root = makeRoot();

    const written = persistAoiKiraOutcomeSignals(root, [event('kira_needs_clarification')], 2000);

    expect(written).toBe(0);
    expect(loadAoiOutcomeSignalRecords(root, SESSION, 3000)).toHaveLength(0);
  });
});
