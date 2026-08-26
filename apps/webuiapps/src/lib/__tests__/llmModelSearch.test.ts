import { describe, expect, it } from 'vitest';
import { MODEL_SEARCH_MIN_OPTIONS, filterModelIds, sortModelIds } from '../llmModels';

// Shaped like the live OpenRouter list: vendor-prefixed ids in the API's own
// order, with labels whose marketing names do not match the slug.
const IDS = [
  'qwen/qwen3.10-flash',
  'anthropic/claude-haiku-4.5',
  'qwen/qwen3.7-flash',
  'google/gemini-2.5-flash-lite',
  'minimax/MiniMax-M2.5',
  'upstage/solar-pro4',
];
const LABELS: Record<string, string> = {
  'qwen/qwen3.10-flash': 'Qwen3.10 Flash (qwen/qwen3.10-flash)',
  'anthropic/claude-haiku-4.5': 'Claude Haiku 4.5 (anthropic/claude-haiku-4.5)',
  'qwen/qwen3.7-flash': 'Qwen3.7 Flash (qwen/qwen3.7-flash)',
  'google/gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite (google/gemini-2.5-flash-lite)',
  'minimax/MiniMax-M2.5': 'MiniMax M2.5 (minimax/MiniMax-M2.5)',
  'upstage/solar-pro4': 'Solar Pro 4 (upstage/solar-pro4)',
};
const labelOf = (id: string) => LABELS[id] ?? id;

describe('sortModelIds', () => {
  it('orders alphabetically, keeping each vendor together', () => {
    expect(sortModelIds(IDS)).toEqual([
      'anthropic/claude-haiku-4.5',
      'google/gemini-2.5-flash-lite',
      'minimax/MiniMax-M2.5',
      'qwen/qwen3.7-flash',
      'qwen/qwen3.10-flash',
      'upstage/solar-pro4',
    ]);
  });

  it('compares version numbers as numbers, not as text', () => {
    // Plain string order would put 3.10 before 3.7, which reads as older.
    expect(sortModelIds(['a/m3.10', 'a/m3.7', 'a/m3.2'])).toEqual(['a/m3.2', 'a/m3.7', 'a/m3.10']);
  });

  it('sorts an auto-update alias next to the vendor it aliases', () => {
    // OpenRouter marks these with a leading "~". Sorting on the raw id parked all
    // of them in a block above the letters, far from the models they alias.
    expect(
      sortModelIds([
        '~z-ai/glm-latest',
        'anthropic/claude-haiku-4.5',
        '~anthropic/claude-haiku-latest',
        'aion-labs/aion-2.0',
      ]),
    ).toEqual([
      'aion-labs/aion-2.0',
      'anthropic/claude-haiku-4.5',
      '~anthropic/claude-haiku-latest',
      '~z-ai/glm-latest',
    ]);
  });

  it('is case-insensitive and does not mutate the input', () => {
    const input = ['b/Zeta', 'b/alpha'];
    expect(sortModelIds(input)).toEqual(['b/alpha', 'b/Zeta']);
    expect(input).toEqual(['b/Zeta', 'b/alpha']);
  });
});

describe('filterModelIds', () => {
  it('returns everything for an empty or whitespace query', () => {
    expect(filterModelIds(IDS, '')).toEqual(IDS);
    expect(filterModelIds(IDS, '   ')).toEqual(IDS);
  });

  it('matches on the id', () => {
    expect(filterModelIds(IDS, 'qwen')).toEqual(['qwen/qwen3.10-flash', 'qwen/qwen3.7-flash']);
  });

  it('matches on the label when the slug does not contain the term', () => {
    // "haiku" is in the slug, but "claude haiku 4.5" spaced as a name is not --
    // searching only ids would miss the way people actually type it.
    expect(filterModelIds(IDS, 'Claude Haiku', { labelOf })).toEqual([
      'anthropic/claude-haiku-4.5',
    ]);
    expect(filterModelIds(IDS, 'solar pro', { labelOf })).toEqual(['upstage/solar-pro4']);
  });

  it('narrows with each additional term', () => {
    expect(filterModelIds(IDS, 'flash', { labelOf })).toHaveLength(3);
    expect(filterModelIds(IDS, 'flash qwen', { labelOf })).toEqual([
      'qwen/qwen3.10-flash',
      'qwen/qwen3.7-flash',
    ]);
    expect(filterModelIds(IDS, 'flash qwen 3.7', { labelOf })).toEqual(['qwen/qwen3.7-flash']);
  });

  it('is case-insensitive', () => {
    expect(filterModelIds(IDS, 'MINIMAX', { labelOf })).toEqual(['minimax/MiniMax-M2.5']);
  });

  it('keeps the selected id even when it does not match', () => {
    // Dropping it would leave the <select> holding a value that is not one of its
    // options, which renders as a different model than the configured one.
    expect(filterModelIds(IDS, 'qwen', { labelOf, keep: 'upstage/solar-pro4' })).toEqual([
      'upstage/solar-pro4',
      'qwen/qwen3.10-flash',
      'qwen/qwen3.7-flash',
    ]);
  });

  it('does not duplicate the selected id when it already matches', () => {
    expect(filterModelIds(IDS, 'qwen', { labelOf, keep: 'qwen/qwen3.7-flash' })).toEqual([
      'qwen/qwen3.10-flash',
      'qwen/qwen3.7-flash',
    ]);
  });

  it('ignores a keep value that is not in the list at all', () => {
    // A custom model typed by hand is rendered by its own <option>, so it must not
    // be smuggled back into the preset list.
    expect(filterModelIds(IDS, 'qwen', { labelOf, keep: 'typed/by-hand' })).toEqual([
      'qwen/qwen3.10-flash',
      'qwen/qwen3.7-flash',
    ]);
    expect(filterModelIds(IDS, 'qwen', { labelOf, keep: '  ' })).toEqual([
      'qwen/qwen3.10-flash',
      'qwen/qwen3.7-flash',
    ]);
  });

  it('returns nothing when a query matches nothing', () => {
    expect(filterModelIds(IDS, 'llama', { labelOf })).toEqual([]);
  });

  it('works without a labelOf, matching ids only', () => {
    expect(filterModelIds(IDS, 'solar')).toEqual(['upstage/solar-pro4']);
  });
});

describe('MODEL_SEARCH_MIN_OPTIONS', () => {
  it('is high enough that the curated per-provider lists stay unchanged', () => {
    // Those lists are a handful of entries each; only the fetched OpenRouter list
    // should grow a search box.
    expect(MODEL_SEARCH_MIN_OPTIONS).toBeGreaterThan(6);
  });
});
