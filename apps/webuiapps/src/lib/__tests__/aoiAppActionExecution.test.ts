import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeAoiProposal } from '../aoiAutonomyExecution';
import {
  applyAoiProposalDecision,
  loadAoiActiveProposals,
  loadAoiAppActionAuditRecords,
  saveAoiActiveProposals,
  saveAoiAutonomyPolicy,
} from '../aoiAutonomyStore';
import type { AoiProposal } from '../aoiAutonomyTypes';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-app-action-exec-test-'));
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

// 'twitter' has a static 'post' schema, so a create_post app_action proposal is
// classified as a file_backed (schema_file_write) capability over apps/twitter/data.
function makeFileBackedAppActionProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'proposal-aa-001',
    sessionPath: 'aoi/default',
    status: 'active',
    title: 'Create an approved Twitter post',
    body: 'Aoi can create the reviewed post through the app capability.',
    reason: 'The reviewed post content is approved for this exact dataRoot path.',
    trigger: 'app_action_followup',
    createdAt: 1000,
    updatedAt: 1000,
    cooldownKey: 'app-action:create-post',
    confidence: 0.9,
    risk: 'high',
    requiredAutonomyLevel: 'L5',
    requiresUserApproval: true,
    suggestedTools: ['app_action'],
    evidenceRefs: ['memory:post-approved', 'goal:aoi-goal-aa-001'],
    memoryIds: [],
    artifactRefs: ['workspace:snapshot:aa-test'],
    riskSignals: ['app-action:approved'],
    acceptAction: {
      kind: 'app_action',
      params: {
        appName: 'twitter',
        intent: 'create_post',
        path: 'apps/twitter/data/posts/p1.json',
        content: '{"id":"p1","text":"hello"}',
        purpose: 'Create an approved Twitter post',
      },
    },
    ...partial,
  };
}

function makeWindowAppActionProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return makeFileBackedAppActionProposal({
    id: 'proposal-aa-win-001',
    title: 'Open the Twitter window',
    acceptAction: {
      kind: 'app_action',
      params: {
        appName: 'twitter',
        actionType: 'OPEN_APP_WINDOW',
        purpose: 'Open the Twitter window',
      },
    },
    ...partial,
  });
}

describe('executeAoiProposal() app actions', () => {
  it('executes an approved file_backed app action under L5 and records the audit', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeFileBackedAppActionProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-aa-001',
      action: 'accept',
      now: 2500,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      workspaceRoot: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-aa-001',
      decisionId: accepted.decision.id,
      now: 3000,
    });

    expect(result).toMatchObject({
      executed: true,
      outcome: 'executed',
      result: {
        kind: 'app_action',
        appActionResult: { ok: true, applied: true, routing: 'file_backed' },
      },
    });
    expect(fs.readFileSync(join(root, 'apps/twitter/data/posts/p1.json'), 'utf8')).toBe(
      '{"id":"p1","text":"hello"}',
    );
    const audits = loadAoiAppActionAuditRecords(root, 'aoi/default');
    expect(audits).toHaveLength(1);
    expect(audits[0].applied).toBe(true);
    expect(audits[0].capabilityId).toBe('twitter:schema:create_post');
    expect(audits[0].evidenceRefs.some((ref) => ref.startsWith('decision:'))).toBe(true);
  });

  it('blocks a file_backed app action below L5 and never touches the file', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [makeFileBackedAppActionProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-aa-001',
      action: 'accept',
      now: 2500,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      workspaceRoot: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-aa-001',
      decisionId: accepted.decision.id,
      now: 3000,
    });

    expect(result.executed).toBe(false);
    expect(result.reasons.join(',')).toContain('app_action_requires_l5');
    expect(fs.existsSync(join(root, 'apps/twitter/data/posts/p1.json'))).toBe(false);
  });

  it('blocks when the app action content changes after approval (content-addressed)', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeFileBackedAppActionProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-aa-001',
      action: 'accept',
      now: 2500,
    });

    const tampered = loadAoiActiveProposals(root, 'aoi/default').map((proposal) =>
      proposal.id === 'proposal-aa-001'
        ? {
            ...proposal,
            acceptAction: {
              kind: 'app_action' as const,
              params: {
                appName: 'twitter',
                intent: 'create_post',
                path: 'apps/twitter/data/posts/p1.json',
                content: '{"id":"p1","text":"INJECTED"}',
                purpose: 'Create an approved Twitter post',
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
      proposalId: 'proposal-aa-001',
      decisionId: accepted.decision.id,
      now: 3000,
    });

    expect(result.executed).toBe(false);
    expect(result.reasons.join(',')).toContain('app_action_approval_operation_changed');
    expect(fs.existsSync(join(root, 'apps/twitter/data/posts/p1.json'))).toBe(false);
  });

  it('blocks a pure window app action pending a Kira-style review handoff', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeWindowAppActionProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-aa-win-001',
      action: 'accept',
      now: 2500,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      workspaceRoot: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-aa-win-001',
      decisionId: accepted.decision.id,
      now: 3000,
    });

    expect(result.executed).toBe(false);
    expect(result.reasons.join(',')).toContain('app_action_review_handoff_required');
  });
});
