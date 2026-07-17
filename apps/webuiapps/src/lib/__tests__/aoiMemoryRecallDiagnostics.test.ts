import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createAoiLocalEmbeddingProvider } from '../aoiLocalEmbedding';
import { loadAoiMemoryEmbeddingStatus } from '../aoiMemoryEmbeddingStatus';
import {
  buildAoiMemoryDiagnostics,
  loadAoiMemoryRecallTrials,
  recordAoiMemoryRecallTrial,
} from '../aoiMemoryRecallDiagnostics';
import { runAoiMeasuredMemoryRecall } from '../aoiMeasuredMemoryRecall';
import {
  loadServerAoiMemories,
  saveServerAoiMemoryCandidatesWithEmbedding,
} from '../aoiMemoryServerWriter';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-memory-diagnostics-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi memory recall diagnostics', () => {
  it('stores only a query fingerprint and rejects forged recall success', () => {
    const root = makeTempRoot();
    const trial = recordAoiMemoryRecallTrial({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      query: 'private recall probe text',
      retrievalPath: 'lexical_only',
      candidateCount: 2,
      selectedMemoryIds: ['memory-wrong'],
      expectedMemoryIds: ['memory-expected'],
      createdAt: NOW,
    });
    const filePath = join(
      root,
      'aoi',
      'default',
      'aoi-autonomy',
      'memory-diagnostics',
      'recall-trials.json',
    );
    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).not.toContain('private recall probe text');
    expect(trial).toMatchObject({ success: false, missReason: 'expected_memory_not_selected' });

    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    parsed[0].success = true;
    fs.writeFileSync(filePath, JSON.stringify(parsed), 'utf8');
    expect(loadAoiMemoryRecallTrials(root, SESSION_PATH)).toEqual([]);

    expect(() =>
      recordAoiMemoryRecallTrial({
        sessionsDir: root,
        sessionPath: SESSION_PATH,
        query: 'invalid path probe',
        retrievalPath: 'invalid' as never,
        candidateCount: 1,
        selectedMemoryIds: ['memory-expected'],
        expectedMemoryIds: ['memory-expected'],
        createdAt: NOW + 1,
      }),
    ).toThrow(/retrieval path/);
  });

  it('measures three real-store local recalls and reports conflicts, supersession, and decay', async () => {
    const root = makeTempRoot();
    const provider = createAoiLocalEmbeddingProvider();
    await saveServerAoiMemoryCandidatesWithEmbedding(
      root,
      SESSION_PATH,
      [
        {
          type: 'preference',
          content: 'The user prefers Korean security engineering answers.',
          importance: 0.95,
          confidence: 0.95,
          tags: ['language', 'security'],
        },
        {
          type: 'fact',
          content: 'Project codename cobalt uses deterministic validation receipts.',
          importance: 0.92,
          confidence: 0.94,
          tags: ['cobalt', 'validation'],
        },
        {
          type: 'procedure',
          content: 'Before release, run the narrow regression suite and verify the artifact hash.',
          importance: 0.9,
          confidence: 0.93,
          tags: ['release', 'regression'],
        },
        {
          type: 'event',
          content: 'Temporary expired recall evidence sample.',
          importance: 0.5,
          confidence: 0.4,
          expiresAt: NOW - 1,
        },
      ],
      'episode-initial',
      provider,
    );
    await saveServerAoiMemoryCandidatesWithEmbedding(
      root,
      SESSION_PATH,
      [
        {
          type: 'fact',
          content: "The user's name is Alice.",
          importance: 0.8,
          confidence: 0.9,
        },
      ],
      'episode-name-alice',
      provider,
    );
    await saveServerAoiMemoryCandidatesWithEmbedding(
      root,
      SESSION_PATH,
      [
        {
          type: 'fact',
          content: "The user's name is Bob.",
          importance: 0.9,
          confidence: 0.95,
        },
      ],
      'episode-name-bob',
      provider,
    );
    const memories = loadServerAoiMemories(root);
    const probes = [
      ['Korean security answers', 'The user prefers'],
      ['cobalt validation receipts', 'Project codename cobalt'],
      ['release regression artifact hash', 'Before release'],
    ] as const;
    for (let index = 0; index < probes.length; index += 1) {
      const [query, contentPrefix] = probes[index];
      const expected = memories.find((memory) => memory.content.startsWith(contentPrefix));
      if (!expected) {
        throw new Error(`Missing expected memory for ${contentPrefix}`);
      }
      const trial = await runAoiMeasuredMemoryRecall({
        sessionsDir: root,
        sessionPath: SESSION_PATH,
        query,
        expectedMemoryIds: [expected.id],
        provider,
        limit: 1,
        now: NOW + index,
      });
      expect(trial).toMatchObject({ success: true, retrievalPath: 'local_semantic' });
    }

    const status = loadAoiMemoryEmbeddingStatus(root, { provider });
    const diagnostics = buildAoiMemoryDiagnostics({
      sessionPath: SESSION_PATH,
      memories: loadServerAoiMemories(root),
      embeddingStatus: status,
      recallTrials: loadAoiMemoryRecallTrials(root, SESSION_PATH),
      now: NOW + 10,
    });

    expect(diagnostics).toMatchObject({
      retrievalPath: 'local_semantic',
      localFallbackConfigured: true,
      localFallbackVerified: true,
      recallSampleCount: 3,
      successfulRecallCount: 3,
      recallMissCount: 0,
      conflictResolutionCount: 1,
      supersessionCount: 1,
      supersededCount: 1,
      expiredActiveCount: 1,
      decayCandidateCount: 1,
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(diagnostics.embeddingCoverage).toBe(1);
  });
});
