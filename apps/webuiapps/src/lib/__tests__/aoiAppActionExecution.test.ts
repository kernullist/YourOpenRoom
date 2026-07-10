import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeAoiProposal } from '../aoiAutonomyExecution';
import {
  applyAoiProposalDecision,
  loadAoiActiveProposals,
  loadAoiAppActionAuditRecords,
  loadAoiAppOperationDispatches,
  loadAoiArchivedProposals,
  loadAoiOutcomeSignalRecords,
  saveAoiActiveProposals,
  saveAoiAutonomyPolicy,
} from '../aoiAutonomyStore';
import { getAoiApprovedAppActionPolicyForProposal } from '../aoiAutonomyPolicy';
import { recordAoiAppOperationDispatchResult } from '../aoiAppOperationDispatchServer';
import { loadServerAoiRunLedger } from '../aoiRunLedgerServer';
import type { AoiProposal } from '../aoiAutonomyTypes';
import type {
  AoiJarvisReadinessLevel,
  AoiJarvisReadinessScorecard,
} from '../aoiJarvisReadinessScorecard';
import type { AoiKiraHandoffCreateResult, AoiKiraHandoffPreview } from '../aoiKiraHandoff';

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

// B3-1 live dispatch is OFF by default and read from process.env; set it only for the
// duration of the call and always restore so the other tests keep the default OFF path.
async function withAppOpLiveDispatch<T>(run: () => Promise<T>): Promise<T> {
  const prev = process.env.AOI_AUTONOMY_APP_OP_LIVE_DISPATCH;
  process.env.AOI_AUTONOMY_APP_OP_LIVE_DISPATCH = '1';
  try {
    return await run();
  } finally {
    if (prev === undefined) {
      delete process.env.AOI_AUTONOMY_APP_OP_LIVE_DISPATCH;
    } else {
      process.env.AOI_AUTONOMY_APP_OP_LIVE_DISPATCH = prev;
    }
  }
}

// B3-2 trust-bounded approval TTL is OFF by default and read from process.env; set it only
// for the duration of the call and always restore.
async function withApprovalTtl<T>(run: () => Promise<T>): Promise<T> {
  const prev = process.env.AOI_AUTONOMY_APPROVAL_TTL;
  process.env.AOI_AUTONOMY_APPROVAL_TTL = '1';
  try {
    return await run();
  } finally {
    if (prev === undefined) {
      delete process.env.AOI_AUTONOMY_APPROVAL_TTL;
    } else {
      process.env.AOI_AUTONOMY_APPROVAL_TTL = prev;
    }
  }
}

// Inject a readiness scorecard at a chosen rung; the TTL trust gate reads gateStatus + level.
function scorecardAt(level: AoiJarvisReadinessLevel): AoiJarvisReadinessScorecard {
  return { gateStatus: 'pass', level } as unknown as AoiJarvisReadinessScorecard;
}

function ledgerEventTypesFor(root: string): string[] {
  return loadServerAoiRunLedger(root, 'aoi/default').flatMap((entry) =>
    entry.events.map((event) => event.type),
  );
}

// 10min strict fresh-acceptance + 5min approval expiry; pick a `now` past BOTH but within
// the default 1h TTL window from the accept at 1000.
const ACCEPT_AT = 1000;
const STALE_NOW = ACCEPT_AT + 10 * 60 * 1000 + 1;
const FRESH_NOW = ACCEPT_AT + 60 * 1000;

function kiraWorkStub() {
  return {
    createKiraWork: ({
      preview,
    }: {
      preview: AoiKiraHandoffPreview;
    }): AoiKiraHandoffCreateResult => ({
      kind: 'create_kira_work' as const,
      preview,
      work: {
        id: 'w1',
        ref: 'kira-work:w1',
        title: 'Review the Twitter window app action',
        projectName: 'aoi',
        status: 'todo' as const,
      },
      reviewRequired: true,
      route: '/kira',
      openPayload: { workId: 'w1', focusType: 'work' },
    }),
  };
}

describe('executeAoiProposal() trust-bounded approval TTL (B3-2)', () => {
  it('blocks a stale app_operation acceptance when the TTL is off (default)', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeWindowAppActionProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-aa-win-001',
      action: 'accept',
      now: ACCEPT_AT,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      workspaceRoot: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-aa-win-001',
      decisionId: accepted.decision.id,
      now: STALE_NOW,
    });

    expect(result.executed).toBe(false);
    // The 5min approval expiry is the binding gate for a stale app_operation.
    expect(result.reasons.join(',')).toContain('app_action_approval_expired');
  });

  it('lets a trusted_operator execute a stale app_operation within the window + records the marker', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeWindowAppActionProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-aa-win-001',
      action: 'accept',
      now: ACCEPT_AT,
    });

    const result = await withApprovalTtl(() =>
      executeAoiProposal({
        sessionsDir: root,
        configFile: join(root, 'config.json'),
        serverOrigin: 'http://127.0.0.1:3000',
        workspaceRoot: root,
        sessionPath: 'aoi/default',
        proposalId: 'proposal-aa-win-001',
        decisionId: accepted.decision.id,
        now: STALE_NOW,
        dependencies: {
          ...kiraWorkStub(),
          readReadinessScorecard: () => scorecardAt('trusted_operator'),
        },
      }),
    );

    expect(result.executed).toBe(true);
    // The loop acted on a stale approval via the window -> audit marker recorded.
    expect(ledgerEventTypesFor(root)).toContain('approval_window_used');
  });

  it('still blocks a stale app_operation when readiness is below trusted_operator', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeWindowAppActionProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-aa-win-001',
      action: 'accept',
      now: ACCEPT_AT,
    });

    const result = await withApprovalTtl(() =>
      executeAoiProposal({
        sessionsDir: root,
        configFile: join(root, 'config.json'),
        serverOrigin: 'http://127.0.0.1:3000',
        workspaceRoot: root,
        sessionPath: 'aoi/default',
        proposalId: 'proposal-aa-win-001',
        decisionId: accepted.decision.id,
        now: STALE_NOW,
        dependencies: {
          ...kiraWorkStub(),
          readReadinessScorecard: () => scorecardAt('supervised_prepare'),
        },
      }),
    );

    expect(result.executed).toBe(false);
    expect(result.reasons.join(',')).toContain('app_action_approval_expired');
    expect(ledgerEventTypesFor(root)).not.toContain('approval_window_used');
  });

  it('does not record the window marker when the acceptance was fresh', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeWindowAppActionProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-aa-win-001',
      action: 'accept',
      now: ACCEPT_AT,
    });

    const result = await withApprovalTtl(() =>
      executeAoiProposal({
        sessionsDir: root,
        configFile: join(root, 'config.json'),
        serverOrigin: 'http://127.0.0.1:3000',
        workspaceRoot: root,
        sessionPath: 'aoi/default',
        proposalId: 'proposal-aa-win-001',
        decisionId: accepted.decision.id,
        now: FRESH_NOW,
        dependencies: {
          ...kiraWorkStub(),
          readReadinessScorecard: () => scorecardAt('trusted_operator'),
        },
      }),
    );

    expect(result.executed).toBe(true);
    // The window was granted but not needed (fresh click) -> no marker.
    expect(ledgerEventTypesFor(root)).not.toContain('approval_window_used');
  });
});

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
    // P5.2: the real executed app action left a proposal_executed outcome in the unified
    // ledger so the closed-loop metric sees the actual result, not just shadow.
    const executedOutcome = loadAoiOutcomeSignalRecords(root, 'aoi/default').find(
      (signal) => signal.sourceProposalId === 'proposal-aa-001',
    );
    expect(executedOutcome?.outcomeKind).toBe('proposal_executed');
    expect(executedOutcome?.result).toBe('positive');
    expect(executedOutcome?.sourceValidationRef).toBe(`aoi-app-action-audit:${audits[0].id}`);
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

  it('hands a pure window app action to a Kira-style review under L5', async () => {
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
      dependencies: {
        createKiraWork: ({ preview }) => ({
          kind: 'create_kira_work',
          preview,
          work: {
            id: 'w1',
            ref: 'kira-work:w1',
            title: 'Review the Twitter window app action',
            projectName: 'aoi',
            status: 'todo',
          },
          reviewRequired: true,
          route: '/kira',
          openPayload: { workId: 'w1', focusType: 'work' },
        }),
      },
      now: 3000,
    });

    expect(result).toMatchObject({
      executed: true,
      outcome: 'executed',
      result: {
        kind: 'app_action',
        appActionResult: { ok: true, reviewHandoff: true, routing: 'app_operation' },
      },
    });
    const audits = loadAoiAppActionAuditRecords(root, 'aoi/default');
    expect(audits).toHaveLength(1);
    expect(audits[0].reviewHandoff).toBe(true);
    expect(audits[0].kiraWorkRef).toBe('kira-work:w1');
    // A pure app operation never mutates an app dataRoot file on the server.
    expect(audits[0].applied).toBe(false);
    // OFF by default: no live dispatch is queued -- the Kira handoff is the only path.
    expect(loadAoiAppOperationDispatches(root, 'aoi/default')).toHaveLength(0);
  });

  it('queues a pending live dispatch instead of a Kira handoff when the flag is on', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeWindowAppActionProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-aa-win-001',
      action: 'accept',
      now: 2500,
    });

    let kiraCalled = false;
    const result = await withAppOpLiveDispatch(() =>
      executeAoiProposal({
        sessionsDir: root,
        configFile: join(root, 'config.json'),
        serverOrigin: 'http://127.0.0.1:3000',
        workspaceRoot: root,
        sessionPath: 'aoi/default',
        proposalId: 'proposal-aa-win-001',
        decisionId: accepted.decision.id,
        dependencies: {
          createKiraWork: ({ preview }) => {
            kiraCalled = true;
            return {
              kind: 'create_kira_work',
              preview,
              work: {
                id: 'w1',
                ref: 'kira-work:w1',
                title: 'Review the Twitter window app action',
                projectName: 'aoi',
                status: 'todo',
              },
              reviewRequired: true,
              route: '/kira',
              openPayload: { workId: 'w1', focusType: 'work' },
            };
          },
        },
        now: 3000,
      }),
    );

    expect(result).toMatchObject({
      executed: true,
      outcome: 'executed',
      result: {
        kind: 'app_action',
        appActionResult: { ok: true, reviewHandoff: true, routing: 'app_operation' },
      },
    });
    // Live dispatch REPLACES the Kira handoff -- createKiraWork is never invoked.
    expect(kiraCalled).toBe(false);

    const dispatches = loadAoiAppOperationDispatches(root, 'aoi/default');
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].status).toBe('pending');
    expect(typeof dispatches[0].appId).toBe('number');
    // The id encodes now + the resolved numeric appId + the action type (filename-safe).
    expect(dispatches[0].id).toBe(`app-op-dispatch-3000-${dispatches[0].appId}-OPEN_APP_WINDOW`);
    expect(dispatches[0].actionType).toBe('OPEN_APP_WINDOW');
    // The content-addressed approval fingerprint is carried for the client re-check.
    expect(dispatches[0].approvalFingerprint.length).toBeGreaterThan(0);
    expect(dispatches[0].proposalId).toBe('proposal-aa-win-001');
    expect(typeof dispatches[0].decisionId).toBe('string');
    expect((dispatches[0].decisionId ?? '').length).toBeGreaterThan(0);

    // No Kira work ref on the audit; the dispatch ref is woven into the evidence.
    const audits = loadAoiAppActionAuditRecords(root, 'aoi/default');
    expect(audits).toHaveLength(1);
    expect(audits[0].reviewHandoff).toBe(true);
    expect(audits[0].kiraWorkRef).toBeUndefined();
    expect(audits[0].evidenceRefs.some((ref) => ref.startsWith('aoi-app-op-dispatch:'))).toBe(true);
    // The dispatch and its audit reference the same execution decision.
    expect(audits[0].evidenceRefs).toContain(`decision:${dispatches[0].decisionId}`);
  });

  it('with the flag on, a file_backed app action still mutates on disk and queues no dispatch', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeFileBackedAppActionProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-aa-001',
      action: 'accept',
      now: 2500,
    });

    const result = await withAppOpLiveDispatch(() =>
      executeAoiProposal({
        sessionsDir: root,
        configFile: join(root, 'config.json'),
        serverOrigin: 'http://127.0.0.1:3000',
        workspaceRoot: root,
        sessionPath: 'aoi/default',
        proposalId: 'proposal-aa-001',
        decisionId: accepted.decision.id,
        now: 3000,
      }),
    );

    // file_backed routing is unaffected by the live-dispatch gate: it mutates the
    // dataRoot file on disk and never queues a dispatch (only app_operation does).
    expect(result.executed).toBe(true);
    expect(fs.readFileSync(join(root, 'apps/twitter/data/posts/p1.json'), 'utf8')).toBe(
      '{"id":"p1","text":"hello"}',
    );
    expect(loadAoiAppOperationDispatches(root, 'aoi/default')).toHaveLength(0);
  });

  it('binds c2 dispatch to the c3 re-check: queued fingerprint == recomputed proposal fingerprint', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeWindowAppActionProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-aa-win-001',
      action: 'accept',
      now: 2500,
    });

    // c2: execute with the gate ON -> a pending dispatch carrying the accept-time
    // content-addressed approval fingerprint.
    await withAppOpLiveDispatch(() =>
      executeAoiProposal({
        sessionsDir: root,
        configFile: join(root, 'config.json'),
        serverOrigin: 'http://127.0.0.1:3000',
        workspaceRoot: root,
        sessionPath: 'aoi/default',
        proposalId: 'proposal-aa-win-001',
        decisionId: accepted.decision.id,
        now: 3000,
      }),
    );
    const dispatches = loadAoiAppOperationDispatches(root, 'aoi/default');
    expect(dispatches).toHaveLength(1);

    // c3: the client bridge re-checks the approval by recomputing the CURRENT policy
    // fingerprint for the loaded proposal at a LATER time. It MUST equal the queued one
    // (a time-independent, content-addressed binding) -- otherwise the bridge would
    // reject every dispatch as approval_fingerprint_mismatch and the feature is inert.
    const proposal =
      loadAoiActiveProposals(root, 'aoi/default').find((p) => p.id === 'proposal-aa-win-001') ??
      loadAoiArchivedProposals(root, 'aoi/default').find((p) => p.id === 'proposal-aa-win-001');
    expect(proposal).toBeDefined();
    const recheckFingerprint = getAoiApprovedAppActionPolicyForProposal(
      proposal as AoiProposal,
      9999,
    ).approvalFingerprint;
    expect(recheckFingerprint).toBe(dispatches[0].approvalFingerprint);

    // c2 report path: the bridge POSTs the result -> the record reaches a terminal state.
    const outcome = recordAoiAppOperationDispatchResult({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      id: dispatches[0].id,
      status: 'dispatched',
      actionResult: 'success',
      now: 10000,
    });
    expect(outcome.found).toBe(true);
    expect(loadAoiAppOperationDispatches(root, 'aoi/default')[0].status).toBe('dispatched');
  });
});
