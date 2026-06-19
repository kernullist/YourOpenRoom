import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AoiMemoryEntry } from '../aoiMemoryShared';
import type { AoiProactiveBriefCandidate } from '../aoiAutonomyTypes';
import {
  expireStaleAoiProactiveBriefCandidates,
  loadAoiInterestProfile,
  loadAoiProactiveBriefCandidates,
  loadAoiProactiveBriefCooldownState,
  normalizeAoiProactiveBriefCandidate,
  rebuildAndSaveAoiInterestProfile,
  resolveAoiProactiveBriefPaths,
  upsertAoiProactiveBriefCandidate,
  upsertAoiProactiveBriefCooldown,
} from '../aoiProactiveBriefStore';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-proactive-brief-test-'));
  tempRoots.push(root);
  return root;
}

function makeMemory(partial: Partial<AoiMemoryEntry> = {}): AoiMemoryEntry {
  const content = partial.content ?? 'The user is interested in reverse engineering.';
  return {
    version: 2,
    id: partial.id ?? 'memory-interest-001',
    scope: partial.scope ?? 'user',
    type: partial.type ?? 'preference',
    status: partial.status ?? 'active',
    content,
    normalizedContent: partial.normalizedContent ?? content.toLowerCase(),
    importance: partial.importance ?? 0.8,
    confidence: partial.confidence ?? 0.85,
    hits: partial.hits ?? 1,
    createdAt: partial.createdAt ?? 100,
    updatedAt: partial.updatedAt ?? 200,
    sourceEpisodeIds: partial.sourceEpisodeIds ?? ['episode-001'],
    tags: partial.tags ?? ['interest', 'reverse-engineering'],
    entities: partial.entities ?? ['reverse engineering'],
    ...(partial.expiresAt !== undefined ? { expiresAt: partial.expiresAt } : {}),
    ...(partial.permanent !== undefined ? { permanent: partial.permanent } : {}),
    ...(partial.supersedes !== undefined ? { supersedes: partial.supersedes } : {}),
    ...(partial.sessionPath !== undefined ? { sessionPath: partial.sessionPath } : {}),
    ...(partial.projectKey !== undefined ? { projectKey: partial.projectKey } : {}),
  };
}

function makeCandidate(
  partial: Partial<AoiProactiveBriefCandidate> = {},
): AoiProactiveBriefCandidate {
  return {
    version: 1,
    id: partial.id ?? 'aoi-brief-test-001',
    sessionPath: partial.sessionPath ?? 'aoi/default',
    topicId: partial.topicId ?? 'aoi-interest-reverse',
    topicLabel: partial.topicLabel ?? 'Reverse Engineering',
    status: partial.status ?? 'candidate',
    title: partial.title ?? 'Fresh reverse engineering writeup',
    hook: partial.hook ?? 'A fresh reverse engineering writeup looks relevant.',
    summary: partial.summary ?? 'Short source-backed summary placeholder.',
    whyForOperator: partial.whyForOperator ?? 'Matches the operator interest profile.',
    noveltyReason: partial.noveltyReason ?? 'New source for a saved topic.',
    sources: partial.sources ?? [
      {
        title: 'Reverse engineering writeup',
        url: 'https://example.com/re/writeup',
        host: 'example.com',
        retrievedAt: 1000,
        snippet: 'A public source snippet.',
      },
    ],
    evidenceRefs: partial.evidenceRefs ?? ['memory:memory-interest-001'],
    memoryIds: partial.memoryIds ?? ['memory-interest-001'],
    ...(partial.researchRunId !== undefined ? { researchRunId: partial.researchRunId } : {}),
    score: partial.score ?? 0.78,
    confidence: partial.confidence ?? 0.82,
    risk: partial.risk ?? 'low',
    freshness: partial.freshness ?? {
      searchedAt: 1000,
      cannotKnow: [],
    },
    delivery: partial.delivery ?? {
      allowedModes: ['dashboard'],
    },
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    ...(partial.dedupeKey !== undefined ? { dedupeKey: partial.dedupeKey } : {}),
    createdAt: partial.createdAt ?? 1000,
    updatedAt: partial.updatedAt ?? 1000,
    expiresAt: partial.expiresAt ?? 2000,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi proactive brief profile storage', () => {
  it('roundtrips an interest profile under the autonomy root', () => {
    const root = makeTempRoot();
    const profile = rebuildAndSaveAoiInterestProfile({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      now: 1000,
      memories: [makeMemory()],
    });
    const paths = resolveAoiProactiveBriefPaths(root, 'aoi/default');
    const loaded = loadAoiInterestProfile(root, 'aoi/default', 2000);

    expect(paths.profile).toBe(join(paths.root, 'proactive-interest-profile.json'));
    expect(fs.existsSync(paths.profile)).toBe(true);
    expect(loaded).toMatchObject({
      sessionPath: 'aoi/default',
      topics: profile.topics,
      sourceMemoryCount: 1,
    });
  });

  it('normalizes malformed profile records without throwing', () => {
    const root = makeTempRoot();
    const paths = resolveAoiProactiveBriefPaths(root, 'aoi/default');
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(
      paths.profile,
      JSON.stringify({
        version: 1,
        topics: [
          {
            id: '../bad',
            label: 123,
            confidence: 'bad',
            aliases: ['reverse engineering', 5],
          },
        ],
      }),
      'utf-8',
    );

    const loaded = loadAoiInterestProfile(root, 'aoi/default', 3000);

    expect(loaded.sessionPath).toBe('aoi/default');
    expect(loaded.topics).toHaveLength(1);
    expect(loaded.topics[0]).toMatchObject({
      label: 'Interest Topic',
      confidence: 0.55,
    });
  });
});

describe('Aoi proactive brief candidate storage', () => {
  it('upserts equivalent candidates by topic, title, source URL, and cooldown key', () => {
    const root = makeTempRoot();
    const first = upsertAoiProactiveBriefCandidate(root, makeCandidate(), 1200);
    const second = upsertAoiProactiveBriefCandidate(
      root,
      makeCandidate({
        id: 'aoi-brief-test-duplicate',
        updatedAt: 1300,
      }),
      1300,
    );
    const candidates = loadAoiProactiveBriefCandidates(root, 'aoi/default', 1400);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.candidate.id).toBe(first.candidate.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.dedupeKey).toBe(first.dedupeKey);
  });

  it('expires stale candidates without deleting their audit files', () => {
    const root = makeTempRoot();
    const upserted = upsertAoiProactiveBriefCandidate(
      root,
      makeCandidate({
        expiresAt: 1100,
      }),
      1000,
    );
    const paths = resolveAoiProactiveBriefPaths(root, 'aoi/default');
    const candidatePath = join(paths.candidatesDir, `${upserted.candidate.id}.json`);

    const expired = expireStaleAoiProactiveBriefCandidates(root, 'aoi/default', 1200);

    expect(expired[0]?.status).toBe('expired');
    expect(fs.existsSync(candidatePath)).toBe(true);
    expect(loadAoiProactiveBriefCandidates(root, 'aoi/default', 1300)[0]?.status).toBe('expired');
  });

  it('normalizes malformed candidates without throwing', () => {
    const normalized = normalizeAoiProactiveBriefCandidate(
      {
        version: 1,
        sessionPath: 'aoi/default',
        topicLabel: 123,
        title: 456,
        sources: [
          { url: 'not-a-url' },
          { url: 'https://example.com/item', title: 5, snippet: 'ok', retrievedAt: 'bad' },
        ],
        delivery: {
          allowedModes: ['bad-mode'],
        },
      },
      undefined,
      1000,
    );

    expect(normalized).toMatchObject({
      sessionPath: 'aoi/default',
      topicLabel: 'Interest Topic',
      title: 'Untitled proactive brief',
      sources: [
        {
          url: 'https://example.com/item',
          retrievedAt: 1000,
        },
      ],
      delivery: {
        allowedModes: ['dashboard'],
      },
    });
  });

  it('stores cooldown state for later planner gates', () => {
    const root = makeTempRoot();

    upsertAoiProactiveBriefCooldown(root, 'aoi/default', {
      cooldownKey: 'interest:reverse-engineering',
      topicId: 'aoi-interest-reverse',
      nextAllowedAt: 5000,
      reason: 'candidate_created',
      sourceBriefIds: ['aoi-brief-test-001'],
      now: 2000,
    });

    expect(loadAoiProactiveBriefCooldownState(root, 'aoi/default', 3000)).toMatchObject({
      sessionPath: 'aoi/default',
      cooldowns: {
        'interest:reverse-engineering': {
          nextAllowedAt: 5000,
          sourceBriefIds: ['aoi-brief-test-001'],
        },
      },
    });
  });

  it('does not import network, research, or command execution helpers in this layer', () => {
    const source = [
      fs.readFileSync(join(process.cwd(), 'src/lib/aoiInterestProfile.ts'), 'utf-8'),
      fs.readFileSync(join(process.cwd(), 'src/lib/aoiProactiveBriefStore.ts'), 'utf-8'),
    ].join('\n');

    expect(source).not.toMatch(
      /tavily|search_web|start_research|child_process|runAoiApprovedCommand|executeAoiApprovedCommand/i,
    );
  });
});
