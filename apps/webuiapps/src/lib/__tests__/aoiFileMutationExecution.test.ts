import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeAoiProposal } from '../aoiAutonomyExecution';
import {
  applyAoiProposalDecision,
  loadAoiActiveProposals,
  loadAoiFileMutationAuditRecords,
  saveAoiActiveProposals,
  saveAoiAutonomyPolicy,
} from '../aoiAutonomyStore';
import type { AoiProposal } from '../aoiAutonomyTypes';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-file-mutation-exec-test-'));
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

function makeFileWriteProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'proposal-fw-001',
    sessionPath: 'aoi/default',
    status: 'active',
    title: 'Persist reviewed seed data',
    body: 'Aoi can write the reviewed seed file.',
    reason: 'The reviewed content is approved for this exact path.',
    trigger: 'file_write_followup',
    createdAt: 1000,
    updatedAt: 1000,
    cooldownKey: 'file-write:seed',
    confidence: 0.9,
    risk: 'high',
    requiredAutonomyLevel: 'L5',
    requiresUserApproval: true,
    suggestedTools: ['file_write'],
    evidenceRefs: ['memory:seed-approved', 'goal:aoi-goal-fw-001'],
    memoryIds: [],
    artifactRefs: ['workspace:snapshot:fw-test'],
    riskSignals: ['file-write:approved'],
    acceptAction: {
      kind: 'file_write',
      params: {
        path: 'apps/sample/data/seed.json',
        content: '{"version":1,"items":[]}',
        purpose: 'Persist reviewed seed data',
      },
    },
    ...partial,
  };
}

function makeFilePatchProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return makeFileWriteProposal({
    id: 'proposal-fp-001',
    title: 'Patch reviewed seed data',
    suggestedTools: ['file_patch'],
    acceptAction: {
      kind: 'file_patch',
      params: {
        path: 'apps/sample/data/seed.json',
        patchOps: [{ find: '"version":1', replace: '"version":2', expectedCount: 1 }],
        purpose: 'Bump the reviewed seed version',
      },
    },
    ...partial,
  });
}

describe('executeAoiProposal() file mutations', () => {
  it('writes an approved file under L5 and records the audit', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeFileWriteProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-fw-001',
      action: 'accept',
      now: 2500,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      workspaceRoot: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-fw-001',
      decisionId: accepted.decision.id,
      now: 3000,
    });

    expect(result).toMatchObject({
      executed: true,
      outcome: 'executed',
      result: {
        kind: 'file_write',
        mutationResult: { ok: true, applied: true, operation: 'write' },
      },
    });
    expect(fs.readFileSync(join(root, 'apps/sample/data/seed.json'), 'utf8')).toBe(
      '{"version":1,"items":[]}',
    );
    const audits = loadAoiFileMutationAuditRecords(root, 'aoi/default');
    expect(audits).toHaveLength(1);
    expect(audits[0].applied).toBe(true);
    expect(audits[0].evidenceRefs.some((ref) => ref.startsWith('decision:'))).toBe(true);
  });

  it('blocks a file write below L5 and never touches the file', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [makeFileWriteProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-fw-001',
      action: 'accept',
      now: 2500,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      workspaceRoot: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-fw-001',
      decisionId: accepted.decision.id,
      now: 3000,
    });

    expect(result.executed).toBe(false);
    expect(result.reasons.join(',')).toContain('file_mutation_requires_l5');
    expect(fs.existsSync(join(root, 'apps/sample/data/seed.json'))).toBe(false);
  });

  it('blocks when the proposal content changes after approval (content-addressed)', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeFileWriteProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-fw-001',
      action: 'accept',
      now: 2500,
    });

    // Tamper with the active proposal content after approval was captured.
    const tampered = loadAoiActiveProposals(root, 'aoi/default').map((proposal) =>
      proposal.id === 'proposal-fw-001'
        ? {
            ...proposal,
            acceptAction: {
              kind: 'file_write' as const,
              params: {
                path: 'apps/sample/data/seed.json',
                content: '{"version":1,"items":["INJECTED"]}',
                purpose: 'Persist reviewed seed data',
              },
            },
          }
        : proposal,
    );
    saveAoiActiveProposals(root, 'aoi/default', tampered);

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      workspaceRoot: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-fw-001',
      decisionId: accepted.decision.id,
      now: 3000,
    });

    expect(result.executed).toBe(false);
    expect(result.reasons.join(',')).toContain('file_mutation_approval_content_changed');
    expect(fs.existsSync(join(root, 'apps/sample/data/seed.json'))).toBe(false);
  });

  it('applies an approved anchored patch under L5', async () => {
    const root = makeTempRoot();
    fs.mkdirSync(join(root, 'apps/sample/data'), { recursive: true });
    fs.writeFileSync(join(root, 'apps/sample/data/seed.json'), '{"version":1,"items":[]}');
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeFilePatchProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-fp-001',
      action: 'accept',
      now: 2500,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      workspaceRoot: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-fp-001',
      decisionId: accepted.decision.id,
      now: 3000,
    });

    expect(result).toMatchObject({
      executed: true,
      result: { kind: 'file_patch', mutationResult: { ok: true, operation: 'patch' } },
    });
    expect(fs.readFileSync(join(root, 'apps/sample/data/seed.json'), 'utf8')).toBe(
      '{"version":2,"items":[]}',
    );
  });
});
