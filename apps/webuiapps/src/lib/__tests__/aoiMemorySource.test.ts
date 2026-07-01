import { describe, expect, it } from 'vitest';
import { deriveAoiMemorySources } from '../aoiMemoryShared';

function mem(
  sourceEpisodeIds: string[],
  tags: string[] = [],
): {
  sourceEpisodeIds: string[];
  tags: string[];
} {
  return { sourceEpisodeIds, tags };
}

describe('deriveAoiMemorySources', () => {
  it('maps the aoi_kira_ episode prefix to automation', () => {
    expect(deriveAoiMemorySources(mem(['aoi_kira_event-1']))).toEqual(['automation']);
  });

  it('maps the aoi_research_ episode prefix to research', () => {
    expect(deriveAoiMemorySources(mem(['aoi_research_run-1']))).toEqual(['research']);
  });

  it('maps a generic aoi_ep_ episode to chat', () => {
    expect(deriveAoiMemorySources(mem(['aoi_ep_123']))).toEqual(['chat']);
  });

  it('categorises by the automation / research tags even without a prefixed episode', () => {
    expect(deriveAoiMemorySources(mem(['x'], ['automation']))).toContain('automation');
    expect(deriveAoiMemorySources(mem(['x'], ['research']))).toContain('research');
  });

  it('returns the SET of categories for a multi-source memory (membership)', () => {
    const sources = deriveAoiMemorySources(mem(['aoi_ep_1', 'aoi_kira_2']));
    expect(new Set(sources)).toEqual(new Set(['chat', 'automation']));
  });

  it('defaults to chat when there is no episode and no matching tag', () => {
    expect(deriveAoiMemorySources(mem([], []))).toEqual(['chat']);
  });

  it('does not mark a pure Kira memory as chat', () => {
    // A memory whose only episode is a Kira one is automation-only, not chat.
    expect(deriveAoiMemorySources(mem(['aoi_kira_1'], ['kira', 'automation']))).toEqual([
      'automation',
    ]);
  });

  it('reproduces the isExternalAutomationMemory predicate byte-for-byte', () => {
    // automation-in-result IFF (tags includes 'automation' OR an aoi_kira_ episode).
    const cases: Array<{ episodes: string[]; tags: string[] }> = [
      { episodes: ['aoi_kira_1'], tags: [] },
      { episodes: ['aoi_ep_1'], tags: ['automation'] },
      { episodes: ['aoi_ep_1'], tags: ['unrelated'] },
      { episodes: ['aoi_research_1'], tags: [] },
      { episodes: [], tags: [] },
    ];
    for (const { episodes, tags } of cases) {
      const legacy =
        tags.includes('automation') || episodes.some((id) => id.startsWith('aoi_kira_'));
      expect(deriveAoiMemorySources(mem(episodes, tags)).includes('automation')).toBe(legacy);
    }
  });
});
