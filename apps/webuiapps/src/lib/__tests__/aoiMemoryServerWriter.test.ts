import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { maliciousProcedureSourceFixture } from '../__fixtures__/aoiAutonomyEvaluationFixtures';
import {
  loadServerAoiMemories,
  saveServerAoiMemoryCandidates,
  syncAoiMemoryFromKiraAutomationEventServer,
  syncAoiMemoryFromResearchRunServer,
} from '../aoiMemoryServerWriter';
import type { AoiMemoryEpisode } from '../aoiMemoryShared';
import type { AoiResearchManifest } from '../aoiResearchTypes';

const tempRoots: string[] = [];

function makeTempSessionsDir(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'aoi-memory-server-'));
  tempRoots.push(dir);
  return dir;
}

function makeCompletedResearchManifest(
  partial: Partial<AoiResearchManifest> = {},
): AoiResearchManifest {
  const completedAt = new Date(2026, 5, 11).getTime();
  return {
    version: 1,
    id: 'aoi-research-test-1234',
    sessionPath: 'aoi/default',
    request: 'Investigate Windows kernel driver BYOVD research trends',
    mode: 'standard',
    language: 'ko',
    recency: 'year',
    maxSources: 12,
    createdAt: completedAt,
    updatedAt: completedAt,
    completedAt,
    status: 'completed',
    phase: 'completed',
    statusMessage: 'Verified research report completed.',
    sourceCounts: {
      planned: 12,
      candidates: 8,
      accepted: 5,
      failed: 1,
    },
    artifactPaths: {
      manifest: 'aoi-research/runs/aoi-research-test-1234/manifest.json',
      report: 'aoi-research/runs/aoi-research-test-1234/report.md',
      sources: 'aoi-research/runs/aoi-research-test-1234/sources.json',
      evidence: 'aoi-research/runs/aoi-research-test-1234/evidence.json',
    },
    artifactAvailability: {
      manifest: true,
      report: true,
      sources: true,
      evidence: true,
    },
    reportTitle: 'Windows kernel driver BYOVD research trends',
    claimCount: 14,
    ...partial,
  };
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Aoi server memory writer', () => {
  it('stores reviewed completed Kira events without a browser session-data round trip', () => {
    const sessionsDir = makeTempSessionsDir();

    const memories = syncAoiMemoryFromKiraAutomationEventServer(
      sessionsDir,
      'aoi/default',
      {
        id: 'event-1',
        workId: 'work-1',
        title: 'Add review controls',
        projectName: 'YourOpenRoom',
        message: 'Kira completed the work.',
        createdAt: 100,
        type: 'completed',
      },
      {
        reviewApproved: true,
        validationPassedCount: 1,
        validationFailedCount: 0,
      },
    );

    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      scope: 'project',
      type: 'action',
      projectKey: 'youropenroom',
      hits: 1,
      sourceEpisodeIds: ['aoi_kira_event-1'],
    });

    const storedMemories = loadServerAoiMemories(sessionsDir);
    expect(storedMemories).toHaveLength(1);
    expect(storedMemories[0].content).toContain('Kira completed project work');

    const episodePath = join(
      sessionsDir,
      'aoi',
      'memory-v2',
      'episodes',
      'aoi',
      'default',
      'aoi_kira_event-1.json',
    );
    const episode = JSON.parse(fs.readFileSync(episodePath, 'utf-8')) as AoiMemoryEpisode;
    expect(episode).toMatchObject({
      id: 'aoi_kira_event-1',
      source: 'kira_automation',
      outcome: 'completed',
    });
  });

  it('does not store unreviewed completed Kira events as durable memory', () => {
    const sessionsDir = makeTempSessionsDir();

    const memories = syncAoiMemoryFromKiraAutomationEventServer(sessionsDir, 'aoi/default', {
      id: 'event-unreviewed',
      workId: 'work-unreviewed',
      title: 'Unreviewed work',
      projectName: 'YourOpenRoom',
      message: 'Kira completed the work without reviewer evidence.',
      createdAt: 100,
      type: 'completed',
    });

    expect(memories).toEqual([]);
    expect(loadServerAoiMemories(sessionsDir)).toEqual([]);
  });

  it('does not inflate hits when the same Kira event is replayed', () => {
    const sessionsDir = makeTempSessionsDir();
    const event = {
      id: 'event-1',
      workId: 'work-1',
      title: 'Add review controls',
      projectName: 'YourOpenRoom',
      message: 'Kira completed the work.',
      createdAt: 100,
      type: 'completed' as const,
    };
    const context = {
      reviewApproved: true,
      validationPassedCount: 1,
      validationFailedCount: 0,
    };

    syncAoiMemoryFromKiraAutomationEventServer(sessionsDir, 'aoi/default', event, context);
    const second = syncAoiMemoryFromKiraAutomationEventServer(
      sessionsDir,
      'aoi/default',
      event,
      context,
    );

    expect(second).toHaveLength(1);
    expect(second[0].hits).toBe(1);
    expect(second[0].sourceEpisodeIds).toEqual(['aoi_kira_event-1']);
  });

  it('enriches completed Kira memories with attempt and review evidence', () => {
    const sessionsDir = makeTempSessionsDir();
    const event = {
      id: 'event-2',
      workId: 'work-2',
      title: 'Persist Kira evidence',
      projectName: 'YourOpenRoom',
      message: 'Kira completed the work.',
      createdAt: 200,
      type: 'completed' as const,
    };
    const context = {
      attemptNo: 2,
      attemptStatus: 'approved',
      changedFiles: ['src/lib/kiraAutomationPlugin.ts', 'src/lib/aoiMemoryShared.ts'],
      validationPassedCount: 3,
      validationFailedCount: 0,
      integrationStatus: 'committed',
      commitHash: 'abcdef1234567890',
      pullRequestUrl: 'https://github.com/kernullist/YourOpenRoom/pull/42',
      connectorStatuses: ['github:applied'],
      reviewApproved: true,
      reviewSummary: 'Reviewer checked the server writer and Kira enqueue flow.',
      reviewFindingCount: 0,
      missingValidationCount: 0,
      reviewEvidenceFiles: ['src/lib/kiraAutomationPlugin.ts', 'src/lib/aoiMemoryServerWriter.ts'],
      residualRiskCount: 1,
    };

    const first = syncAoiMemoryFromKiraAutomationEventServer(
      sessionsDir,
      'aoi/default',
      event,
      context,
    );
    const second = syncAoiMemoryFromKiraAutomationEventServer(
      sessionsDir,
      'aoi/default',
      event,
      context,
    );

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].hits).toBe(1);
    expect(second[0].content).toContain('attempt 2 approved');
    expect(second[0].content).toContain('integration committed abcdef123456');
    expect(second[0].content).toContain('validation passed=3 failed=0');
    expect(second[0].content).toContain('review approved');
    expect(second[0].tags).toEqual(
      expect.arrayContaining([
        'completed',
        'reviewed',
        'review-approved',
        'validation',
        'committed',
        'pull-request',
      ]),
    );
    expect(second[0].entities).toEqual(
      expect.arrayContaining([
        'YourOpenRoom',
        'Persist Kira evidence',
        'src/lib/kiraAutomationPlugin.ts',
      ]),
    );
  });

  it('ignores transient Kira progress events', () => {
    const sessionsDir = makeTempSessionsDir();

    const memories = syncAoiMemoryFromKiraAutomationEventServer(sessionsDir, 'aoi/default', {
      id: 'event-1',
      workId: 'work-1',
      title: 'Add review controls',
      projectName: 'YourOpenRoom',
      message: 'Kira started.',
      createdAt: 100,
      type: 'started',
    });

    expect(memories).toEqual([]);
    expect(loadServerAoiMemories(sessionsDir)).toEqual([]);
  });

  it('preserves permanent memories across server-side duplicate merges', () => {
    const sessionsDir = makeTempSessionsDir();

    const first = saveServerAoiMemoryCandidates(
      sessionsDir,
      'aoi/default',
      [
        {
          type: 'fact',
          content: 'The user wants permanent Windows kernel debugging preferences.',
          confidence: 0.7,
          expiresAt: 150,
        },
      ],
      'ep-1',
    );
    const second = saveServerAoiMemoryCandidates(
      sessionsDir,
      'aoi/default',
      [
        {
          type: 'fact',
          content: 'The user wants permanent Windows kernel debugging preferences.',
          confidence: 0.8,
          permanent: true,
        },
      ],
      'ep-2',
    );

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      permanent: true,
      hits: 2,
      sourceEpisodeIds: ['ep-1', 'ep-2'],
    });
    expect(second[0].expiresAt).toBeUndefined();
    expect(second[0].tags).toContain('permanent');
  });

  it('redacts credentials and strips source instructions before storing procedure memory', () => {
    const sessionsDir = makeTempSessionsDir();

    const memories = saveServerAoiMemoryCandidates(
      sessionsDir,
      'aoi/default',
      [
        {
          type: 'procedure',
          content: `${maliciousProcedureSourceFixture}\napi_key=sk-test12345678901234567890`,
          confidence: 0.8,
        },
      ],
      'episode-procedure-1',
    );

    expect(memories).toHaveLength(1);
    expect(memories[0].content).not.toMatch(/ignore previous instructions/i);
    expect(memories[0].content).not.toContain('sk-test12345678901234567890');
    expect(memories[0].content).toContain('[redacted_secret]');
    expect(memories[0].content).toContain('compare source dates');
  });

  it('stores completed research runs as reusable Aoi memories', () => {
    const sessionsDir = makeTempSessionsDir();
    const manifest = makeCompletedResearchManifest();
    const reportMarkdown = [
      '# Windows kernel driver BYOVD research trends',
      '',
      '## Key Findings',
      '- BYOVD activity increasingly targets vulnerable signed drivers [S01].',
      '- Driver blocklist coverage and HVCI enforcement remain deployment-dependent [S02].',
      '',
      '## Sources',
      '- [S01] src-001 - Research source.',
      '- [S02] src-002 - Microsoft source.',
      '',
    ].join('\n');

    const first = syncAoiMemoryFromResearchRunServer(sessionsDir, manifest, { reportMarkdown });
    const second = syncAoiMemoryFromResearchRunServer(sessionsDir, manifest, { reportMarkdown });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      scope: 'agent',
      type: 'fact',
      permanent: true,
      hits: 1,
      sourceEpisodeIds: ['aoi_research_aoi-research-test-1234'],
    });
    expect(second[0].content).toContain('Aoi completed research');
    expect(second[0].content).toContain('on 2026-06-11');
    expect(second[0].content).toContain('BYOVD');
    expect(second[0].content).toContain('run=aoi-research-test-1234');
    expect(second[0].tags).toEqual(
      expect.arrayContaining([
        'permanent',
        'research',
        'aoi-research',
        'completed',
        'windows',
        'kernel',
      ]),
    );
    expect(second[0].entities).toEqual(
      expect.arrayContaining([
        'Windows kernel driver BYOVD research trends',
        'aoi-research-test-1234',
        '2026-06-11',
      ]),
    );

    const episodePath = join(
      sessionsDir,
      'aoi',
      'memory-v2',
      'episodes',
      'aoi',
      'default',
      'aoi_research_aoi-research-test-1234.json',
    );
    const episode = JSON.parse(fs.readFileSync(episodePath, 'utf-8')) as AoiMemoryEpisode;
    expect(episode).toMatchObject({
      source: 'research_run',
      toolCalls: ['start_research'],
      outcome: 'completed',
    });
  });

  it('ignores unfinished research runs', () => {
    const sessionsDir = makeTempSessionsDir();

    const memories = syncAoiMemoryFromResearchRunServer(
      sessionsDir,
      makeCompletedResearchManifest({
        status: 'failed',
        phase: 'failed',
        statusMessage: 'Research failed.',
      }),
    );

    expect(memories).toEqual([]);
    expect(loadServerAoiMemories(sessionsDir)).toEqual([]);
  });
});
