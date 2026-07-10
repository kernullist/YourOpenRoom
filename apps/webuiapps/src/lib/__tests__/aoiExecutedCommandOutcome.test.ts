import { describe, expect, it } from 'vitest';
import {
  deriveAoiExecutedActionOutcomeSignal,
  deriveAoiExecutedCommandOutcomeSignal,
  normalizeAoiOutcomeSignalRecord,
} from '../aoiOutcomeLearning';
import { buildAoiClosedLoopMetrics } from '../aoiClosedLoopMetrics';
import type { AoiOutcomeSignalRecord, AoiProposalDecision } from '../aoiAutonomyTypes';

const SESSION = 'aoi/default';
const NOW = 1_800_000_000_000;

// P5.2: a real executed approved-command result must reach the unified outcome ledger
// so the closed-loop promotion metric counts ACTUAL executed outcomes, not just
// counterfactual shadow decisions.

describe('deriveAoiExecutedCommandOutcomeSignal (P5.2)', () => {
  it('maps a passing command to a validation_run signal with both attribution ids', () => {
    const signal = deriveAoiExecutedCommandOutcomeSignal({
      sessionPath: SESSION,
      proposalId: 'prop-1',
      decisionId: 'dec-1',
      commandAuditId: 'aud-1',
      commandOk: true,
    });
    expect(signal).toMatchObject({
      eventId: 'executed-command:aud-1',
      sessionPath: SESSION,
      outcomeKind: 'validation_run',
      signalKind: 'passive_outcome',
      sourceProposalId: 'prop-1',
      sourceDecisionId: 'dec-1',
      sourceValidationRef: 'aoi-command-audit:aud-1',
      validationPassed: true,
    });
  });

  it('marks a failing command as validationPassed=false', () => {
    const signal = deriveAoiExecutedCommandOutcomeSignal({
      sessionPath: SESSION,
      proposalId: 'prop-2',
      decisionId: 'dec-2',
      commandAuditId: 'aud-2',
      commandOk: false,
    });
    expect(signal.validationPassed).toBe(false);
  });

  it('keys the eventId on the command audit so a replay never double-writes', () => {
    const a = deriveAoiExecutedCommandOutcomeSignal({
      sessionPath: SESSION,
      proposalId: 'p',
      decisionId: 'd',
      commandAuditId: 'same-audit',
      commandOk: true,
    });
    const b = deriveAoiExecutedCommandOutcomeSignal({
      sessionPath: SESSION,
      proposalId: 'p',
      decisionId: 'd',
      commandAuditId: 'same-audit',
      commandOk: true,
    });
    expect(a.eventId).toBe(b.eventId);
  });
});

describe('deriveAoiExecutedCommandOutcomeSignal -> normalize (P5.2)', () => {
  it('normalizes a pass to a positive validation_run outcome record', () => {
    const record = normalizeAoiOutcomeSignalRecord(
      deriveAoiExecutedCommandOutcomeSignal({
        sessionPath: SESSION,
        proposalId: 'prop-1',
        decisionId: 'dec-1',
        commandAuditId: 'aud-1',
        commandOk: true,
      }),
      SESSION,
      NOW,
    );
    expect(record).not.toBeNull();
    expect(record?.outcomeKind).toBe('validation_run');
    expect(record?.result).toBe('positive');
    expect(record?.sourceDecisionId).toBe('dec-1');
  });

  it('normalizes a fail to a failed validation_run outcome record', () => {
    const record = normalizeAoiOutcomeSignalRecord(
      deriveAoiExecutedCommandOutcomeSignal({
        sessionPath: SESSION,
        proposalId: 'prop-2',
        decisionId: 'dec-2',
        commandAuditId: 'aud-2',
        commandOk: false,
      }),
      SESSION,
      NOW,
    );
    expect(record?.result).toBe('failed');
  });
});

// The aggregator only reads a few fields off each decision/outcome, so cast a minimal
// shape (mirrors the aoiClosedLoopMetrics test helpers).
function decision(over: {
  id: string;
  actionKind: string;
  proposalId: string;
}): AoiProposalDecision {
  return {
    id: over.id,
    proposalId: over.proposalId,
    action: 'execute',
    actionKind: over.actionKind,
    createdAt: NOW,
  } as unknown as AoiProposalDecision;
}

describe('executed-command outcome feeds the closed-loop metric (P5.2)', () => {
  it('attributes a real executed command success to its capability actionSuccessRate', () => {
    const decisions = [
      decision({ id: 'dec-ok', actionKind: 'run_command', proposalId: 'p-ok' }),
      decision({ id: 'dec-bad', actionKind: 'run_command', proposalId: 'p-bad' }),
    ];
    const outcomes = [
      normalizeAoiOutcomeSignalRecord(
        deriveAoiExecutedCommandOutcomeSignal({
          sessionPath: SESSION,
          proposalId: 'p-ok',
          decisionId: 'dec-ok',
          commandAuditId: 'aud-ok',
          commandOk: true,
        }),
        SESSION,
        NOW,
      ),
      normalizeAoiOutcomeSignalRecord(
        deriveAoiExecutedCommandOutcomeSignal({
          sessionPath: SESSION,
          proposalId: 'p-bad',
          decisionId: 'dec-bad',
          commandAuditId: 'aud-bad',
          commandOk: false,
        }),
        SESSION,
        NOW,
      ),
    ].filter((record): record is AoiOutcomeSignalRecord => record !== null);
    expect(outcomes).toHaveLength(2);

    const report = buildAoiClosedLoopMetrics({
      sessionPath: SESSION,
      decisions,
      outcomes,
      now: NOW,
      minSample: 2, // exactly the two real executed outcomes we attribute below
    });
    const runCommand = report.capabilities.find((c) => c.capability === 'run_command');
    // One real success + one real failure attributed to run_command -> 50% success.
    expect(runCommand?.actionSuccessRate).toBeCloseTo(0.5, 3);
  });
});

describe('deriveAoiExecutedActionOutcomeSignal (P5.2 -- file/app/connector)', () => {
  it('maps each executed action kind to a proposal_executed signal linked to its audit', () => {
    for (const actionKind of ['file-mutation', 'app-action', 'connector-call'] as const) {
      const signal = deriveAoiExecutedActionOutcomeSignal({
        sessionPath: SESSION,
        proposalId: 'prop-1',
        decisionId: 'dec-1',
        actionKind,
        auditId: 'aud-9',
        ok: true,
      });
      expect(signal).toMatchObject({
        eventId: `executed-action:${actionKind}:aud-9`,
        outcomeKind: 'proposal_executed',
        signalKind: 'passive_outcome',
        sourceProposalId: 'prop-1',
        sourceDecisionId: 'dec-1',
        sourceValidationRef: `aoi-${actionKind}-audit:aud-9`,
        validationPassed: true,
      });
    }
  });

  it('normalizes a success to a positive proposal_executed record and a failure to failed', () => {
    const pass = normalizeAoiOutcomeSignalRecord(
      deriveAoiExecutedActionOutcomeSignal({
        sessionPath: SESSION,
        proposalId: 'p',
        decisionId: 'd',
        actionKind: 'app-action',
        auditId: 'a1',
        ok: true,
      }),
      SESSION,
      NOW,
    );
    expect(pass?.outcomeKind).toBe('proposal_executed');
    expect(pass?.result).toBe('positive');

    const fail = normalizeAoiOutcomeSignalRecord(
      deriveAoiExecutedActionOutcomeSignal({
        sessionPath: SESSION,
        proposalId: 'p',
        decisionId: 'd',
        actionKind: 'connector-call',
        auditId: 'a2',
        ok: false,
      }),
      SESSION,
      NOW,
    );
    expect(fail?.result).toBe('failed');
  });

  it('feeds a capability actionSuccessRate as a real execution outcome', () => {
    const decisions = [
      decision({ id: 'dec-w', actionKind: 'app_action', proposalId: 'p-w' }),
      decision({ id: 'dec-l', actionKind: 'app_action', proposalId: 'p-l' }),
    ];
    const outcomes = [
      normalizeAoiOutcomeSignalRecord(
        deriveAoiExecutedActionOutcomeSignal({
          sessionPath: SESSION,
          proposalId: 'p-w',
          decisionId: 'dec-w',
          actionKind: 'app-action',
          auditId: 'aud-w',
          ok: true,
        }),
        SESSION,
        NOW,
      ),
      normalizeAoiOutcomeSignalRecord(
        deriveAoiExecutedActionOutcomeSignal({
          sessionPath: SESSION,
          proposalId: 'p-l',
          decisionId: 'dec-l',
          actionKind: 'connector-call',
          auditId: 'aud-l',
          ok: false,
        }),
        SESSION,
        NOW,
      ),
    ].filter((record): record is AoiOutcomeSignalRecord => record !== null);

    const report = buildAoiClosedLoopMetrics({
      sessionPath: SESSION,
      decisions,
      outcomes,
      now: NOW,
      minSample: 2,
    });
    const cap = report.capabilities.find((c) => c.capability === 'app_action');
    expect(cap?.actionSuccessRate).toBeCloseTo(0.5, 3);
  });
});
