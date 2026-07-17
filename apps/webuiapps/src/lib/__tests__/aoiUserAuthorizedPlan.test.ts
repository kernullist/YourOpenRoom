// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { authorAoiUserAuthorizedPlan } from '../aoiUserAuthorizedPlan';
import { loadAoiActiveProposals, loadAoiObservations } from '../aoiAutonomyStore';
import { buildAoiApprovedFileMutationPreparedActionPlan } from '../aoiSafeActionPlan';
import { buildAoiBoundedWorkOrderFromProposal } from '../aoiBoundedWorkOrder';
import { previewAoiProposal } from '../aoiAutonomyExecution';

const tempRoots: string[] = [];

function makeFixture(): { sessionsDir: string; workspaceRoot: string } {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-user-plan-'));
  tempRoots.push(root);
  const sessionsDir = join(root, 'sessions');
  const workspaceRoot = join(root, 'workspace');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(join(workspaceRoot, 'written-by-me', 'output'), { recursive: true });
  return { sessionsDir, workspaceRoot };
}

function makeInput(fixture: { sessionsDir: string; workspaceRoot: string }) {
  return {
    ...fixture,
    sessionPath: 'aoi/space_adventure',
    goalTitle: 'Aoi non-voice live-field validation',
    filePath: 'written-by-me/output/aoi-live-field-smoke.txt',
    fileContent: 'AOI_NONVOICE_LIVE_FIELD_V1',
    researchRequest: 'Research current non-voice desktop agent evaluation methods.',
    researchMode: 'standard' as const,
    researchLanguage: 'ko' as const,
    researchRecency: 'year' as const,
    researchMaxSources: 8,
    now: 10_000,
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('authorAoiUserAuthorizedPlan', () => {
  it('authors exact goal, file, and research proposals without executing them', () => {
    const fixture = makeFixture();
    const input = makeInput(fixture);
    const result = authorAoiUserAuthorizedPlan(input);
    const proposals = loadAoiActiveProposals(fixture.sessionsDir, input.sessionPath);

    expect(proposals).toHaveLength(3);
    expect(result).toMatchObject({
      sessionPath: input.sessionPath,
      filePath: input.filePath,
      actionAuthority: 'display_only',
      mutationCount: 0,
      goal: { created: true, status: 'active' },
      file: { created: true, status: 'active' },
      research: { created: true, status: 'active' },
    });
    expect(
      proposals.find((proposal) => proposal.id === result.goal.id)?.acceptAction,
    ).toMatchObject({
      kind: 'activate_goal',
      params: { title: input.goalTitle },
    });
    expect(proposals.find((proposal) => proposal.id === result.file.id)?.acceptAction).toEqual({
      kind: 'file_write',
      params: {
        path: input.filePath,
        content: input.fileContent,
        purpose: input.goalTitle,
        validationPlan: {
          version: 1,
          expectedBeforeSha256: 'absent',
          expectedAfterSha256: result.fileContentSha256,
        },
      },
    });
    expect(proposals.find((proposal) => proposal.id === result.research.id)?.acceptAction).toEqual({
      kind: 'start_research',
      params: {
        sessionPath: input.sessionPath,
        request: input.researchRequest,
        mode: 'standard',
        language: 'ko',
        recency: 'year',
        maxSources: 8,
      },
    });
    expect(fs.existsSync(join(fixture.workspaceRoot, input.filePath))).toBe(false);
    expect(
      fs.existsSync(join(fixture.sessionsDir, input.sessionPath, 'aoi-research', 'runs')),
    ).toBe(false);
    expect(loadAoiObservations(fixture.sessionsDir, input.sessionPath)).toHaveLength(1);

    const fileProposal = proposals.find((proposal) => proposal.id === result.file.id)!;
    const plan = buildAoiApprovedFileMutationPreparedActionPlan(fileProposal);
    expect(plan).toMatchObject({
      status: 'ready',
      actionKind: 'file_write',
      checkpoint: {
        kind: 'approved_runner_checkpoint',
        required: true,
        available: true,
      },
      rollback: {
        kind: 'approved_runner_checkpoint_restore',
        guarantee: 'mechanism_backed',
      },
    });
    expect(plan.validation.summary).toContain(result.fileContentSha256);
    const workOrder = buildAoiBoundedWorkOrderFromProposal(fileProposal, { now: input.now });
    expect(workOrder.scope.files).toContain(input.filePath);
    expect(workOrder.allowedOperations).toContain('edit_file');
    expect(workOrder.risk.mutationCapable).toBe(true);
    expect(workOrder.risk.generated).toBe(false);
    expect(workOrder.policyResult.status).toBe('approval_required');
    const goalPreview = previewAoiProposal({
      sessionsDir: fixture.sessionsDir,
      sessionPath: input.sessionPath,
      proposalId: result.goal.id,
      now: input.now,
    });
    expect(goalPreview).toMatchObject({
      previewed: true,
      outcome: 'previewed',
      reasons: [],
      preparedActionPlan: { actionKind: 'activate_goal', status: 'ready' },
    });
  });

  it('is idempotent for the same authorization fingerprint', () => {
    const fixture = makeFixture();
    const input = makeInput(fixture);
    const first = authorAoiUserAuthorizedPlan(input);
    const second = authorAoiUserAuthorizedPlan({ ...input, now: 20_000 });

    expect(second.goal).toEqual({ ...first.goal, created: false });
    expect(second.file).toEqual({ ...first.file, created: false });
    expect(second.research).toEqual({ ...first.research, created: false });
    expect(loadAoiActiveProposals(fixture.sessionsDir, input.sessionPath)).toHaveLength(3);
    expect(loadAoiObservations(fixture.sessionsDir, input.sessionPath)).toHaveLength(1);
  });

  it('rejects traversal before writing session metadata', () => {
    const fixture = makeFixture();
    const input = makeInput(fixture);
    expect(() => authorAoiUserAuthorizedPlan({ ...input, filePath: '../escape.txt' })).toThrow(
      /workspace-relative|traversal/i,
    );
    expect(fs.existsSync(join(fixture.sessionsDir, input.sessionPath))).toBe(false);
  });

  it('rejects an existing linked parent that escapes the workspace', () => {
    const fixture = makeFixture();
    const input = makeInput(fixture);
    const outside = join(dirnameForFixture(fixture.workspaceRoot), 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const link = join(fixture.workspaceRoot, 'linked-output');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    expect(() =>
      authorAoiUserAuthorizedPlan({ ...input, filePath: 'linked-output/escape.txt' }),
    ).toThrow(/outside workspaceRoot/i);
    expect(fs.existsSync(join(fixture.sessionsDir, input.sessionPath))).toBe(false);
  });
});

function dirnameForFixture(workspaceRoot: string): string {
  return join(workspaceRoot, '..');
}
