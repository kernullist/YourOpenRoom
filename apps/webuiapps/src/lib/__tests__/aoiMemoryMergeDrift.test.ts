import { describe, expect, it } from 'vitest';
import { mergeAoiMemoryCandidates, type AoiMemoryEntry } from '../aoiMemoryManager';
import { mergeServerAoiMemoryCandidates } from '../aoiMemoryServerWriter';
import type { AoiMemoryCandidate } from '../aoiMemoryShared';

// P4.6: the browser (aoiMemoryManager) and server (aoiMemoryServerWriter) merge
// functions are independent copies of one merge/normalization contract; only the
// SAVE wrappers differ (the server path adds embed-on-write). This drift test locks
// their parity so the copies cannot silently diverge. New memories get a random id
// (makeId), so both outputs are normalized -- new ids remapped to positional
// placeholders (content-ordered) -- before comparison; everything else must match.

function memory(partial: Partial<AoiMemoryEntry>): AoiMemoryEntry {
  return {
    version: 2,
    id: 'mem',
    scope: 'user',
    type: 'fact',
    status: 'active',
    content: 'content',
    normalizedContent: 'content',
    importance: 0.7,
    confidence: 0.8,
    hits: 1,
    createdAt: 1,
    updatedAt: 1,
    sourceEpisodeIds: ['ep-1'],
    tags: [],
    entities: [],
    ...partial,
  } as AoiMemoryEntry;
}

const PARAMS = { sessionPath: 'aoi/default', episodeId: 'ep-2', now: 100 };

function normalize(
  result: { memories: AoiMemoryEntry[]; changedIds: string[] },
  existingIds: Set<string>,
) {
  const idMap = new Map<string, string>();
  let counter = 0;
  const mapId = (id: string): string => {
    if (existingIds.has(id)) {
      return id;
    }
    if (!idMap.has(id)) {
      idMap.set(id, `NEW_${counter++}`);
    }
    return idMap.get(id) as string;
  };
  const memories = [...result.memories]
    .sort(
      (a, b) =>
        a.normalizedContent.localeCompare(b.normalizedContent) || a.status.localeCompare(b.status),
    )
    .map((entry) => ({
      ...entry,
      id: mapId(entry.id),
      supersedes: entry.supersedes?.map(mapId),
    }));
  const changedIds = result.changedIds.map(mapId).sort();
  return { memories, changedIds };
}

function assertParity(existing: AoiMemoryEntry[], candidates: AoiMemoryCandidate[]): void {
  const existingIds = new Set(existing.map((entry) => entry.id));
  const browser = mergeAoiMemoryCandidates(
    existing.map((entry) => ({ ...entry })),
    candidates,
    PARAMS,
  );
  const server = mergeServerAoiMemoryCandidates(
    existing.map((entry) => ({ ...entry })),
    candidates,
    PARAMS,
  );
  expect(normalize(server, existingIds)).toEqual(normalize(browser, existingIds));
}

describe('memory merge drift -- browser vs server parity (P4.6)', () => {
  it('reinforces an exact-content duplicate identically', () => {
    assertParity(
      [
        memory({
          id: 'mem-a',
          content: 'The user prefers Korean responses.',
          normalizedContent: 'the user prefers korean responses.',
          hits: 1,
        }),
      ],
      [{ type: 'preference', content: 'The user prefers Korean responses.', confidence: 0.9 }],
    );
  });

  it('supersedes a stale name fact identically', () => {
    assertParity(
      [
        memory({
          id: 'old-name',
          content: "The user's name is OldName.",
          normalizedContent: "the user's name is oldname.",
        }),
      ],
      [{ type: 'fact', content: "The user's name is NewName.", confidence: 0.9 }],
    );
  });

  it('protects a permanent memory from a non-permanent conflict identically', () => {
    assertParity(
      [
        memory({
          id: 'perm',
          content: "The user's name is PermanentName.",
          normalizedContent: "the user's name is permanentname.",
          permanent: true,
        }),
      ],
      [{ type: 'fact', content: "The user's name is TransientName.", confidence: 0.9 }],
    );
  });

  it('adds a brand-new memory identically', () => {
    assertParity(
      [],
      [{ scope: 'user', type: 'fact', content: 'A fresh durable fact.', confidence: 0.8 }],
    );
  });

  it('does not increment hits on an episode replay identically', () => {
    assertParity(
      [
        memory({
          id: 'mem-a',
          content: 'A replayed fact.',
          normalizedContent: 'a replayed fact.',
          hits: 1,
          sourceEpisodeIds: ['ep-2'],
        }),
      ],
      [{ type: 'fact', content: 'A replayed fact.', confidence: 0.8 }],
    );
  });
});
