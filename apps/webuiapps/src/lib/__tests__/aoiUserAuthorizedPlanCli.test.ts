// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  AOI_USER_AUTHORIZED_PLAN_EXIT_INPUT,
  AOI_USER_AUTHORIZED_PLAN_EXIT_OK,
  runAoiUserAuthorizedPlanCli,
  type AoiUserAuthorizedPlanCliDeps,
} from '../aoiUserAuthorizedPlanCli';
import type { AoiUserAuthorizedPlanResult } from '../aoiUserAuthorizedPlan';

function makeResult(): AoiUserAuthorizedPlanResult {
  return {
    version: 1,
    sessionPath: 'aoi/space_adventure',
    observationRef: 'observation:aoi-obs-test',
    authorizationFingerprint: 'a'.repeat(64),
    filePath: 'written-by-me/output/aoi-live-field-smoke.txt',
    fileContentSha256: 'b'.repeat(64),
    goal: { id: 'proposal-goal', status: 'active', created: true },
    file: { id: 'proposal-file', status: 'active', created: true },
    research: { id: 'proposal-research', status: 'active', created: true },
    warnings: [],
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function makeDeps(over: Partial<AoiUserAuthorizedPlanCliDeps> = {}): {
  deps: AoiUserAuthorizedPlanCliDeps;
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    deps: {
      argv: [
        '--sessions-dir',
        'C:/sessions',
        '--session-path',
        'aoi/space_adventure',
        '--workspace-root',
        'F:/workspace',
        '--goal-title',
        'Aoi non-voice live field',
        '--file-path',
        'written-by-me/output/aoi-live-field-smoke.txt',
        '--file-content-base64',
        Buffer.from('AOI_NONVOICE_LIVE_FIELD_V1', 'utf8').toString('base64'),
        '--research-request',
        'Research current non-voice agent evaluation.',
      ],
      env: {},
      authorPlan: vi.fn(() => makeResult()),
      log: (message) => logs.push(message),
      logError: (message) => errors.push(message),
      ...over,
    },
  };
}

describe('runAoiUserAuthorizedPlanCli', () => {
  it('passes exact provenance and decoded content while executing no action itself', async () => {
    const { deps, logs, errors } = makeDeps();
    const code = await runAoiUserAuthorizedPlanCli(deps);

    expect(code).toBe(AOI_USER_AUTHORIZED_PLAN_EXIT_OK);
    expect(deps.authorPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionsDir: 'C:/sessions',
        sessionPath: 'aoi/space_adventure',
        workspaceRoot: 'F:/workspace',
        fileContent: 'AOI_NONVOICE_LIVE_FIELD_V1',
        researchMode: 'standard',
        researchRecency: 'year',
        researchMaxSources: 8,
      }),
    );
    expect(logs.some((line) => line.includes('no action executed'))).toBe(true);
    expect(errors).toEqual([]);
  });

  it('fails closed before authoring when required provenance is missing', async () => {
    const authorPlan = vi.fn(() => makeResult());
    const { deps, errors } = makeDeps({ argv: ['--file-content', 'x'], authorPlan });
    const code = await runAoiUserAuthorizedPlanCli(deps);

    expect(code).toBe(AOI_USER_AUTHORIZED_PLAN_EXIT_INPUT);
    expect(authorPlan).not.toHaveBeenCalled();
    expect(errors[0]).toMatch(/missing required options/i);
  });

  it('rejects non-canonical base64 before authoring', async () => {
    const authorPlan = vi.fn(() => makeResult());
    const fixture = makeDeps({ authorPlan });
    const argv = [...fixture.deps.argv];
    argv[argv.indexOf('--file-content-base64') + 1] = 'not-base64';
    fixture.deps.argv = argv;

    expect(await runAoiUserAuthorizedPlanCli(fixture.deps)).toBe(
      AOI_USER_AUTHORIZED_PLAN_EXIT_INPUT,
    );
    expect(authorPlan).not.toHaveBeenCalled();
  });
});
