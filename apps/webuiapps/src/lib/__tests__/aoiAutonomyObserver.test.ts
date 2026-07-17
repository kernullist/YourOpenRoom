import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ingestAoiObservation } from '../aoiAutonomyObserver';
import { runAoiAttentionBroker } from '../aoiAttentionBroker';
import { runAoiAutonomyBackgroundTick } from '../aoiAutonomyEngine';
import {
  DEFAULT_AOI_AUTONOMY_POLICY,
  getDefaultAoiEnvironmentSourceRegistry,
} from '../aoiAutonomyPolicy';
import { loadAoiRelationIndex } from '../aoiAutonomyRelations';
import {
  applyAoiProposalDecision,
  loadAoiActiveProposals,
  loadAoiCommandAuditRecords,
  loadAoiObservationIndex,
  loadAoiObservations,
  saveAoiActiveProposals,
  saveAoiAutonomyPolicy,
} from '../aoiAutonomyStore';
import type {
  AoiEnvironmentSourceRegistry,
  AoiMissionState,
  AoiProposal,
} from '../aoiAutonomyTypes';
import {
  collectAoiWorkspaceSnapshot,
  createAoiWorkspaceObservations,
  deriveAoiValidationFreshness,
  normalizeAoiWorkspaceSnapshot,
} from '../aoiWorkspaceSignals';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-autonomy-observer-test-'));
  tempRoots.push(root);
  return root;
}

function makeWorkspaceRegistry(): AoiEnvironmentSourceRegistry {
  const registry = getDefaultAoiEnvironmentSourceRegistry(SESSION_PATH, NOW);
  return {
    ...registry,
    sources: registry.sources.map((source) =>
      source.id === 'workspace-git' || source.id === 'workspace-build'
        ? {
            ...source,
            enabled: true,
            consentReason: 'Test enables metadata-only workspace signals.',
            updatedAt: NOW,
          }
        : source,
    ),
  };
}

function makeMission(partial: Partial<AoiMissionState> = {}): AoiMissionState {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    status: 'active',
    activeGoalId: 'aoi-goal-workspace-test',
    focusSummary: 'Finish workspace signal connector goal',
    waitingOn: 'aoi',
    nextRecommendedAction: {
      kind: 'review_goal',
      label: 'Review goal state.',
      reason: 'The mission is active.',
    },
    evidenceRefs: ['goal:aoi-goal-workspace-test'],
    sourceRefs: {
      goalRef: 'goal:aoi-goal-workspace-test',
    },
    transitions: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

function makeAcceptedCommandProposal(): AoiProposal {
  return {
    version: 1,
    id: 'proposal-command-background-test',
    sessionPath: SESSION_PATH,
    status: 'active',
    title: 'Run background validation command',
    body: 'A safe validation command is available for explicit approval only.',
    reason: 'Validation is stale.',
    trigger: 'workspace_validation_stale',
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    cooldownKey: 'approved-command:background-test',
    confidence: 0.85,
    risk: 'high',
    requiredAutonomyLevel: 'L5',
    requiresUserApproval: true,
    suggestedTools: ['run_command'],
    evidenceRefs: ['workspace:validation:stale'],
    memoryIds: [],
    artifactRefs: ['workspace:snapshot:background-test'],
    riskSignals: ['workspace-validation:stale'],
    acceptAction: {
      kind: 'run_command',
      params: {
        command:
          'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyObserver.test.ts',
        cwd: '.',
        purpose: 'Validate observer behavior.',
      },
    },
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi autonomy observer', () => {
  it('deduplicates repeated observation ingest by stable key', () => {
    const root = makeTempRoot();

    const first = ingestAoiObservation(root, {
      source: 'research_run',
      sessionPath: SESSION_PATH,
      stableKey: 'research-001',
      createdAt: NOW,
      summary: 'Research completed.',
      artifactRefs: ['research:research-001/report'],
    });
    const second = ingestAoiObservation(root, {
      source: 'research_run',
      sessionPath: SESSION_PATH,
      stableKey: 'research-001',
      createdAt: NOW + 1000,
      summary: 'Research completed with updated summary.',
      artifactRefs: ['research:research-001/report'],
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.observation.id).toBe(first.observation.id);
    expect(loadAoiObservations(root, SESSION_PATH)).toHaveLength(1);
    expect(loadAoiObservations(root, SESSION_PATH)[0].summary).toContain('updated summary');
  });

  it('keeps the recent observation index bounded', () => {
    const root = makeTempRoot();

    for (let index = 0; index < 205; index += 1) {
      ingestAoiObservation(root, {
        source: 'app',
        sessionPath: SESSION_PATH,
        stableKey: `app-open-${index}`,
        createdAt: NOW + index,
        summary: `App session opened ${index}.`,
      });
    }

    const observationIndex = loadAoiObservationIndex(root, SESSION_PATH);
    const observations = loadAoiObservations(root, SESSION_PATH);
    expect(observationIndex.entries).toHaveLength(200);
    expect(observations).toHaveLength(200);
    expect(
      observations.some((observation) => observation.summary === 'App session opened 0.'),
    ).toBe(false);
  });

  it('rejects traversal session paths before writing observations', () => {
    const root = makeTempRoot();

    expect(() =>
      ingestAoiObservation(root, {
        source: 'app',
        sessionPath: '../escape',
        stableKey: 'bad',
        createdAt: NOW,
        summary: 'Should not write.',
      }),
    ).toThrow(/sessionPath/);
  });

  it('records relation links for observation evidence refs', () => {
    const root = makeTempRoot();

    const result = ingestAoiObservation(root, {
      source: 'proposal',
      sessionPath: SESSION_PATH,
      stableKey: 'decision-001',
      createdAt: NOW,
      summary: 'Aoi proposal accepted.',
      memoryIds: ['memory-001'],
      artifactRefs: ['research:run-001/report'],
      proposalIds: ['proposal-001'],
    });

    const relations = loadAoiRelationIndex(root, SESSION_PATH);
    expect(result.relationRecorded).toBe(true);
    expect(
      relations.nodes.some((node) => node.ref === `observation:${result.observation.id}`),
    ).toBe(true);
    expect(relations.nodes.some((node) => node.ref === 'memory:memory-001')).toBe(true);
    expect(relations.nodes.some((node) => node.ref === 'proposal:proposal-001')).toBe(true);
    expect(relations.edges.some((edge) => edge.kind === 'supports')).toBe(true);
  });

  it('does not fail observation ingest when relation writes fail', () => {
    const root = makeTempRoot();

    const result = ingestAoiObservation(
      root,
      {
        source: 'memory',
        sessionPath: SESSION_PATH,
        stableKey: 'memory-001',
        createdAt: NOW,
        summary: 'Memory refreshed.',
        memoryIds: ['memory-001'],
      },
      {
        recordRelations: () => {
          throw new Error('relation failure');
        },
      },
    );

    expect(result.created).toBe(true);
    expect(result.relationRecorded).toBe(false);
    expect(result.warnings).toContain('observation_relation_write_failed');
    expect(loadAoiObservations(root, SESSION_PATH)).toHaveLength(1);
  });

  it('normalizes workspace snapshots and redacts local dirty tree paths', () => {
    const snapshot = normalizeAoiWorkspaceSnapshot(
      {
        version: 1,
        sessionPath: SESSION_PATH,
        collectedAt: NOW,
        workspaceLabel: 'YourOpenRoom',
        sourceIds: ['workspace-git', 'workspace-build'],
        git: {
          version: 1,
          branchName: 'codex/aoi-workspace',
          branchChanged: false,
          isDirty: true,
          changedFileCount: 1,
          stagedFileCount: 0,
          unstagedFileCount: 1,
          untrackedFileCount: 0,
          statusSummary: 'dirty',
          changedFiles: [
            {
              version: 1,
              pathLabel: 'F:\\kernullist\\YourOpenRoom\\apps\\webuiapps\\src\\secret.ts',
              pathHash: 'raw',
              status: 'M',
              staged: false,
              unstaged: true,
              untracked: false,
              changedAt: NOW,
            },
          ],
        },
        validation: {
          version: 1,
          command: 'pnpm test',
          result: 'passed',
          completedAt: NOW - 1000,
          touchedFileScopes: ['apps/webuiapps/src'],
          freshness: 'fresh',
          evidenceRefs: [],
        },
        freshness: 'fresh',
        evidenceRefs: ['workspace:snapshot:test'],
        warnings: [],
      },
      SESSION_PATH,
      NOW,
      'F:\\kernullist\\YourOpenRoom',
    );

    expect(snapshot?.git?.changedFiles[0].pathLabel).toBe('apps/webuiapps/src/secret.ts');
    expect(snapshot?.validation.freshness).toBe('stale');
    expect(snapshot?.freshness).toBe('stale');
    expect(JSON.stringify(snapshot)).not.toContain('F:\\');
    expect(JSON.stringify(snapshot)).not.toContain('kernullist');
  });

  it('collects bounded read-only git snapshots and suppresses default disabled sources', () => {
    const disabledRunner = vi.fn(() => {
      throw new Error('git should not run');
    });
    const disabledSnapshot = collectAoiWorkspaceSnapshot({
      sessionPath: SESSION_PATH,
      workspaceRoot: 'F:\\kernullist\\YourOpenRoom',
      registry: getDefaultAoiEnvironmentSourceRegistry(SESSION_PATH, NOW),
      now: NOW,
      runGitCommand: disabledRunner,
    });

    expect(disabledSnapshot).toBeNull();
    expect(disabledRunner).not.toHaveBeenCalled();

    const gitRunner = vi.fn((args: string[]) => {
      const command = args.join(' ');
      if (command === 'rev-parse --abbrev-ref HEAD') {
        return 'codex/aoi-workspace';
      }
      if (command === 'status --porcelain=v1') {
        return [
          ' M F:\\kernullist\\YourOpenRoom\\apps\\webuiapps\\src\\private.ts',
          'A  apps/webuiapps/src/new-file.ts',
          '?? C:\\Users\\someone\\outside-secret.txt',
        ].join('\n');
      }
      if (command === 'log -1 --pretty=%H%x00%s') {
        return 'abcdef0123456789abcdef0123456789abcdef01\u0000add workspace signal connector';
      }
      throw new Error(`unexpected git command: ${command}`);
    });

    const snapshot = collectAoiWorkspaceSnapshot({
      sessionPath: SESSION_PATH,
      workspaceRoot: 'F:\\kernullist\\YourOpenRoom',
      registry: makeWorkspaceRegistry(),
      now: NOW,
      runGitCommand: gitRunner,
    });
    const paths = snapshot?.git?.changedFiles.map((file) => file.pathLabel) ?? [];
    const observations = snapshot
      ? createAoiWorkspaceObservations({
          snapshot,
          mission: makeMission(),
        })
      : [];

    expect(gitRunner).toHaveBeenCalledWith(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      'F:\\kernullist\\YourOpenRoom',
    );
    expect(paths).toContain('apps/webuiapps/src/private.ts');
    expect(paths).toContain('apps/webuiapps/src/new-file.ts');
    expect(paths).toContain('outside-secret.txt');
    expect(JSON.stringify(paths)).not.toContain('F:\\');
    expect(JSON.stringify(paths)).not.toContain('C:\\');
    expect(observations.some((observation) => observation.source === 'workspace')).toBe(true);
    expect(JSON.stringify(observations)).not.toContain('F:\\');
  });

  it('preserves the leading porcelain status column for the first unstaged file', () => {
    const workspaceRoot = makeTempRoot();
    execFileSync('git', ['init'], { cwd: workspaceRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Aoi Test'], {
      cwd: workspaceRoot,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.email', 'aoi-test@example.invalid'], {
      cwd: workspaceRoot,
      stdio: 'ignore',
    });
    fs.writeFileSync(join(workspaceRoot, 'tracked.txt'), 'before\n', 'utf-8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: workspaceRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'test fixture'], {
      cwd: workspaceRoot,
      stdio: 'ignore',
    });
    fs.appendFileSync(join(workspaceRoot, 'tracked.txt'), 'after\n', 'utf-8');

    const snapshot = collectAoiWorkspaceSnapshot({
      sessionPath: SESSION_PATH,
      workspaceRoot,
      registry: makeWorkspaceRegistry(),
      now: NOW,
    });

    expect(snapshot?.git?.changedFiles).toHaveLength(1);
    expect(snapshot?.git?.changedFiles[0]).toMatchObject({
      pathLabel: 'tracked.txt',
      staged: false,
      unstaged: true,
    });
  });

  it('keeps validation fresh across repeated observations when dirty file contents did not change', () => {
    const workspaceRoot = makeTempRoot();
    const filePath = join(workspaceRoot, 'apps', 'stable.ts');
    fs.mkdirSync(join(workspaceRoot, 'apps'), { recursive: true });
    fs.writeFileSync(filePath, 'export const stable = true;\n', 'utf-8');
    fs.utimesSync(filePath, new Date(NOW - 5_000), new Date(NOW - 5_000));
    const gitRunner = vi.fn((args: string[]) => {
      const command = args.join(' ');
      if (command === 'rev-parse --abbrev-ref HEAD') {
        return 'main';
      }
      if (command === 'status --porcelain=v1') {
        return ' M apps/stable.ts';
      }
      if (command === 'log -1 --pretty=%H%x00%s') {
        return 'abcdef0123456789abcdef0123456789abcdef01\u0000stable fixture';
      }
      throw new Error(`unexpected git command: ${command}`);
    });
    const first = collectAoiWorkspaceSnapshot({
      sessionPath: SESSION_PATH,
      workspaceRoot,
      registry: makeWorkspaceRegistry(),
      validation: {
        result: 'passed',
        completedAt: NOW - 1_000,
        touchedFileScopes: [],
      },
      now: NOW,
      runGitCommand: gitRunner,
    });
    const second = collectAoiWorkspaceSnapshot({
      sessionPath: SESSION_PATH,
      workspaceRoot,
      registry: makeWorkspaceRegistry(),
      previousSnapshot: first,
      now: NOW + 10_000,
      runGitCommand: gitRunner,
    });

    expect(first?.git?.changedFiles[0].changedAt).toBe(NOW - 5_000);
    expect(second?.git?.changedFiles[0].changedAt).toBe(NOW - 5_000);
    expect(first?.validation.freshness).toBe('fresh');
    expect(second?.validation.freshness).toBe('fresh');
    expect(second?.freshness).toBe('fresh');
  });

  it('does not execute approved command proposals from a background tick', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, SESSION_PATH, {
      ...DEFAULT_AOI_AUTONOMY_POLICY,
      enabled: true,
      previewMode: true,
      level: 'L5',
      proactiveSuggestionsEnabled: true,
    });
    saveAoiActiveProposals(root, SESSION_PATH, [makeAcceptedCommandProposal()]);
    applyAoiProposalDecision(root, SESSION_PATH, {
      proposalId: 'proposal-command-background-test',
      action: 'accept',
      now: NOW - 500,
    });

    const result = await runAoiAutonomyBackgroundTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'periodic',
      now: NOW,
      minIntervalMs: 0,
      maxRuntimeMs: 5000,
    });

    const proposals = loadAoiActiveProposals(root, SESSION_PATH);
    expect(result.ok).toBe(true);
    expect(loadAoiCommandAuditRecords(root, SESSION_PATH)).toEqual([]);
    expect(
      proposals.find((proposal) => proposal.id === 'proposal-command-background-test'),
    ).toMatchObject({
      status: 'accepted',
    });
  });

  it('detects stale validation only when relevant files changed after the recorded result', () => {
    const changedFile = {
      version: 1 as const,
      pathLabel: 'apps/webuiapps/src/lib/aoiWorkspaceSignals.ts',
      pathHash: 'changed',
      status: 'M',
      staged: false,
      unstaged: true,
      untracked: false,
      changedAt: NOW,
      directoryLabel: 'apps/webuiapps/src/lib',
      extension: 'ts',
    };

    expect(
      deriveAoiValidationFreshness({
        validation: {
          result: 'passed',
          completedAt: NOW - 1000,
          touchedFileScopes: ['apps/webuiapps/src'],
        },
        changedFiles: [changedFile],
        now: NOW,
      }),
    ).toBe('stale');
    expect(
      deriveAoiValidationFreshness({
        validation: {
          result: 'passed',
          completedAt: NOW - 1000,
          touchedFileScopes: ['docs'],
        },
        changedFiles: [changedFile],
        now: NOW,
      }),
    ).toBe('fresh');
    expect(
      deriveAoiValidationFreshness({
        validation: {
          result: 'failed',
          completedAt: NOW - 1000,
          touchedFileScopes: ['apps/webuiapps/src'],
        },
        changedFiles: [changedFile],
        now: NOW,
      }),
    ).toBe('failed');
  });

  it('keeps workspace validation attention quiet without chat interruption or proposal spam', () => {
    const mission = makeMission();
    const snapshot = normalizeAoiWorkspaceSnapshot(
      {
        version: 1,
        sessionPath: SESSION_PATH,
        collectedAt: NOW,
        workspaceLabel: 'YourOpenRoom',
        sourceIds: ['workspace-git', 'workspace-build'],
        git: {
          version: 1,
          branchName: 'codex/aoi-workspace',
          branchChanged: false,
          isDirty: true,
          changedFileCount: 1,
          stagedFileCount: 0,
          unstagedFileCount: 1,
          untrackedFileCount: 0,
          statusSummary: 'dirty: 1 changed, 0 staged',
          changedFiles: [
            {
              version: 1,
              pathLabel: 'apps/webuiapps/src/lib/aoiWorkspaceSignals.ts',
              pathHash: 'changed',
              status: 'M',
              staged: false,
              unstaged: true,
              untracked: false,
              changedAt: NOW,
            },
          ],
        },
        validation: {
          version: 1,
          command: 'pnpm --filter @openroom/webuiapps test',
          result: 'passed',
          completedAt: NOW - 1000,
          touchedFileScopes: ['apps/webuiapps/src'],
          freshness: 'fresh',
          evidenceRefs: [],
        },
        freshness: 'fresh',
        evidenceRefs: ['workspace:snapshot:quiet-test'],
        warnings: [],
      },
      SESSION_PATH,
      NOW,
      'F:\\kernullist\\YourOpenRoom',
    );
    if (!snapshot) {
      throw new Error('Expected workspace snapshot.');
    }
    expect(snapshot.validation.freshness).toBe('stale');

    const result = runAoiAttentionBroker({
      sessionPath: SESSION_PATH,
      now: NOW,
      policy: {
        ...DEFAULT_AOI_AUTONOMY_POLICY,
        enabled: true,
        proactiveSuggestionsEnabled: true,
        level: 'L3',
        updatedAt: NOW,
      },
      researchRuns: [],
      memories: [],
      activeProposals: [],
      recentDecisions: [],
      activeGoals: [],
      mission,
      workspaceSnapshots: [snapshot],
      quietMode: true,
    });

    expect(result.events.some((event) => event.kind === 'workspace_validation_stale')).toBe(true);
    expect(result.proposals).toHaveLength(0);
    expect(result.directClarificationRequested).toBe(false);
    expect(result.suppressedNotifications).toBeGreaterThan(0);
    expect(result.decisions.every((decision) => decision.kind !== 'ask_direct_clarification')).toBe(
      true,
    );
  });
});
