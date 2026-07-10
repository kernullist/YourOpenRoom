import { describe, expect, it } from 'vitest';
import { buildDurableMemoryCandidates } from '../aoiContextRouter';
import { getDefaultAoiEnvironmentSourceRegistry } from '../aoiAutonomyPolicy';
import type { AoiMemoryEntry } from '../aoiMemoryShared';

function memory(partial: Partial<AoiMemoryEntry>): AoiMemoryEntry {
  return {
    version: 2,
    id: 'mem',
    scope: 'user',
    type: 'fact',
    status: 'active',
    content: 'The user prefers deep kernel detail.',
    normalizedContent: 'the user prefers deep kernel detail.',
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

describe('buildDurableMemoryCandidates (P4.2)', () => {
  const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);

  it('surfaces active non-kira durable memories as manual_note candidates', () => {
    const out = buildDurableMemoryCandidates({
      memories: [
        memory({
          id: 'chat-1',
          content: 'The user prefers deep kernel detail.',
          tags: ['preference'],
        }),
        memory({ id: 'kira-1', content: 'Kira completed the work.', tags: ['kira'] }),
      ],
      latestUserMessage: 'kernel detail',
      registry,
      mission: null,
      now: 1000,
    });

    // The chat/preference memory surfaces; the kira memory is excluded (its own builder).
    expect(out.map((candidate) => candidate.evidenceRefs)).toContainEqual(['memory:chat-1']);
    expect(out.some((candidate) => candidate.evidenceRefs.includes('memory:kira-1'))).toBe(false);
    expect(out.every((candidate) => candidate.kind === 'manual_note')).toBe(true);
  });

  it('excludes superseded / archived memories (active-only recall filter)', () => {
    const out = buildDurableMemoryCandidates({
      memories: [
        memory({ id: 'sup-1', status: 'superseded', tags: ['preference'] }),
        memory({ id: 'arc-1', status: 'archived', tags: ['fact'] }),
      ],
      latestUserMessage: 'anything',
      registry,
      mission: null,
      now: 1000,
    });
    expect(out).toEqual([]);
  });

  it('excludes automation-tagged memories (handled by the kira builder)', () => {
    const out = buildDurableMemoryCandidates({
      memories: [memory({ id: 'auto-1', tags: ['automation'] })],
      latestUserMessage: 'x',
      registry,
      mission: null,
      now: 1000,
    });
    expect(out).toEqual([]);
  });

  it('returns [] when the manual-note source is disabled in the registry', () => {
    const disabled = {
      ...registry,
      sources: registry.sources.map((source) =>
        source.id === 'manual-note' ? { ...source, enabled: false } : source,
      ),
    };
    const out = buildDurableMemoryCandidates({
      memories: [memory({ id: 'chat-2', tags: ['preference'] })],
      latestUserMessage: 'kernel',
      registry: disabled,
      mission: null,
      now: 1000,
    });
    expect(out).toEqual([]);
  });
});
