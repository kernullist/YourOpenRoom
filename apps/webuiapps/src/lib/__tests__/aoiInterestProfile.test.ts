import { describe, expect, it } from 'vitest';
import {
  buildAoiInterestProfileFromMemories,
  extractAoiInterestTopicsFromMemories,
  isAoiMemoryEligibleForInterestProfile,
} from '../aoiInterestProfile';
import type { AoiMemoryEntry } from '../aoiMemoryShared';

function makeMemory(partial: Partial<AoiMemoryEntry> = {}): AoiMemoryEntry {
  const content =
    partial.content ??
    'The user is interested in reverse engineering and Windows kernel internals.';
  return {
    version: 2,
    id: partial.id ?? 'memory-interest-001',
    scope: partial.scope ?? 'user',
    type: partial.type ?? 'preference',
    status: partial.status ?? 'active',
    content,
    normalizedContent: partial.normalizedContent ?? content.toLowerCase(),
    importance: partial.importance ?? 0.76,
    confidence: partial.confidence ?? 0.82,
    hits: partial.hits ?? 1,
    createdAt: partial.createdAt ?? 100,
    updatedAt: partial.updatedAt ?? 200,
    sourceEpisodeIds: partial.sourceEpisodeIds ?? ['episode-001'],
    tags: partial.tags ?? ['interest'],
    entities: partial.entities ?? [],
    ...(partial.lastAccessedAt !== undefined ? { lastAccessedAt: partial.lastAccessedAt } : {}),
    ...(partial.expiresAt !== undefined ? { expiresAt: partial.expiresAt } : {}),
    ...(partial.permanent !== undefined ? { permanent: partial.permanent } : {}),
    ...(partial.supersedes !== undefined ? { supersedes: partial.supersedes } : {}),
    ...(partial.sessionPath !== undefined ? { sessionPath: partial.sessionPath } : {}),
    ...(partial.projectKey !== undefined ? { projectKey: partial.projectKey } : {}),
  };
}

describe('Aoi interest profile builder', () => {
  it('extracts topics from explicit user preference memories', () => {
    const profile = buildAoiInterestProfileFromMemories({
      sessionPath: 'aoi/default',
      now: 1000,
      memories: [
        makeMemory({
          id: 'memory-preference-interest',
          content: 'The user is interested in reverse engineering and Windows kernel internals.',
          tags: ['interest', 'reverse-engineering', 'kernel'],
          entities: ['reverse engineering', 'Windows kernel'],
        }),
      ],
    });

    expect(profile).toMatchObject({
      version: 1,
      sessionPath: 'aoi/default',
      generatedAt: 1000,
      sourceMemoryCount: 1,
    });
    expect(profile.topics.map((topic) => topic.label)).toEqual(
      expect.arrayContaining(['Reverse Engineering', 'Windows Kernel Internals']),
    );
    expect(
      profile.topics.every((topic) =>
        topic.evidenceRefs.includes('memory:memory-preference-interest'),
      ),
    ).toBe(true);
  });

  it('merges RE aliases into one reverse engineering topic', () => {
    const topics = extractAoiInterestTopicsFromMemories({
      sessionPath: 'aoi/default',
      now: 1000,
      memories: [
        makeMemory({
          id: 'memory-re',
          content: 'The user likes RE.',
          tags: ['interest'],
        }),
        makeMemory({
          id: 'memory-reversing',
          content: 'The user is interested in reversing tools.',
          tags: ['interest'],
        }),
        makeMemory({
          id: 'memory-reverse-engineering',
          content: 'The user has a durable interest in reverse engineering.',
          tags: ['interest', 'reverse-engineering'],
        }),
      ],
    });

    const reverseEngineeringTopics = topics.filter(
      (topic) => topic.label === 'Reverse Engineering',
    );

    expect(reverseEngineeringTopics).toHaveLength(1);
    expect(reverseEngineeringTopics[0]?.memoryIds).toEqual(
      expect.arrayContaining(['memory-re', 'memory-reversing', 'memory-reverse-engineering']),
    );
    expect(reverseEngineeringTopics[0]?.aliases).toEqual(
      expect.arrayContaining(['RE', 'Reverse Engineering', 'reversing']),
    );
  });

  it('excludes low-confidence, demoted, archived, expired, and private-sensitive memories', () => {
    const now = 2000;
    const memories = [
      makeMemory({
        id: 'low-confidence',
        confidence: 0.4,
        content: 'The user is interested in reverse engineering.',
      }),
      makeMemory({
        id: 'demoted',
        status: 'superseded',
        tags: ['interest', 'demoted'],
        content: 'The user is interested in kernel driver internals.',
      }),
      makeMemory({
        id: 'archived',
        status: 'archived',
        content: 'The user is interested in anti-cheat.',
      }),
      makeMemory({
        id: 'expired',
        expiresAt: 1500,
        content: 'The user is interested in Windows security.',
      }),
      makeMemory({
        id: 'private-sensitive',
        content: 'The user is interested in reverse engineering and api_key=secret-value.',
      }),
    ];

    expect(memories.some((memory) => isAoiMemoryEligibleForInterestProfile(memory, now))).toBe(
      false,
    );
    expect(
      buildAoiInterestProfileFromMemories({
        sessionPath: 'aoi/default',
        now,
        memories,
      }).topics,
    ).toEqual([]);
  });

  it('uses reusable tag and entity heuristics instead of only the RE example', () => {
    const profile = buildAoiInterestProfileFromMemories({
      sessionPath: 'aoi/default',
      now: 3000,
      memories: [
        makeMemory({
          id: 'memory-rust-compiler',
          content: 'The user is interested in Rust compiler internals.',
          tags: ['interest', 'research'],
          entities: ['Rust compiler internals'],
        }),
      ],
    });

    expect(profile.topics.map((topic) => topic.label)).toEqual(
      expect.arrayContaining(['Rust Compiler Internals', 'Research and Technical Writing']),
    );
  });
});

describe('Aoi interest profile - non-work interests', () => {
  it('extracts a personal interest from an English preference memory', () => {
    const topics = extractAoiInterestTopicsFromMemories({
      sessionPath: 'aoi/default',
      now: 1000,
      memories: [
        makeMemory({
          id: 'memory-personal-en',
          type: 'preference',
          content: 'I love roguelike games.',
          tags: ['preference'],
        }),
      ],
    });
    const topic = topics.find((item) => item.label === 'Roguelike Games');
    expect(topic).toBeDefined();
    expect(topic?.interestKind).toBe('personal');
  });

  it('extracts a Korean personal interest and keeps a non-empty Hangul key', () => {
    const topics = extractAoiInterestTopicsFromMemories({
      sessionPath: 'aoi/default',
      now: 1000,
      memories: [
        makeMemory({
          id: 'memory-personal-ko',
          type: 'preference',
          content: '나는 로그라이크 게임을 좋아해',
          tags: ['preference'],
        }),
      ],
    });
    const topic = topics.find((item) => item.label.includes('로그라이크'));
    expect(topic).toBeDefined();
    expect(topic?.interestKind).toBe('personal');
    expect((topic?.normalizedLabel.length ?? 0) > 0).toBe(true);
  });

  it('classifies professional topics as professional', () => {
    const topics = extractAoiInterestTopicsFromMemories({
      sessionPath: 'aoi/default',
      now: 1000,
      memories: [
        makeMemory({
          id: 'memory-pro',
          content: 'The user is interested in reverse engineering.',
          tags: ['interest', 'reverse-engineering'],
        }),
      ],
    });
    const topic = topics.find((item) => item.label === 'Reverse Engineering');
    expect(topic?.interestKind).toBe('professional');
  });

  it('makes a personal fact eligible via a personal-interest tag and entity', () => {
    const memory = makeMemory({
      id: 'fact-personal',
      type: 'fact',
      content: 'The user follows the band Radiohead.',
      tags: ['music'],
      entities: ['Radiohead'],
    });
    expect(isAoiMemoryEligibleForInterestProfile(memory, 2000)).toBe(true);
    const topics = extractAoiInterestTopicsFromMemories({
      sessionPath: 'aoi/default',
      now: 2000,
      memories: [memory],
    });
    const topic = topics.find((item) => item.label === 'Radiohead');
    expect(topic).toBeDefined();
    expect(topic?.interestKind).toBe('personal');
  });
});
