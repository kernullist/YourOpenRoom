import { describe, expect, it } from 'vitest';
import {
  condenseConversationHistory,
  shouldEnableAppTools,
  shouldUseDialogModel,
  summarizeToolResultForModel,
  truncateForTokenBudget,
} from '../chatTokenControl';
import { buildMemoryPrompt, selectMemoriesForPrompt, type MemoryEntry } from '../memoryManager';
import { buildFileReadResponse } from '../fileTools';

describe('condenseConversationHistory()', () => {
  it('keeps short histories unchanged', () => {
    const history = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];

    expect(condenseConversationHistory(history)).toEqual({
      summaryMessage: null,
      recentHistory: history,
    });
  });

  it('summarizes older history and preserves recent messages', () => {
    const history = Array.from({ length: 18 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `message ${index + 1}`,
    }));

    const condensed = condenseConversationHistory(history);
    expect(condensed.summaryMessage?.role).toBe('system');
    expect(condensed.summaryMessage?.content).toContain('Earlier conversation summary');
    expect(condensed.recentHistory).toHaveLength(12);
    expect(condensed.recentHistory[0].content).toBe('message 7');
  });
});

describe('summarizeToolResultForModel()', () => {
  it('shrinks Tavily search results to a compact JSON payload', () => {
    const raw = JSON.stringify({
      query: 'latest launch',
      answer: 'A'.repeat(800),
      results: [
        { title: 'One', url: 'https://one.test', content: 'B'.repeat(500) },
        { title: 'Two', url: 'https://two.test', content: 'C'.repeat(500) },
        { title: 'Three', url: 'https://three.test', content: 'D'.repeat(500) },
        { title: 'Four', url: 'https://four.test', content: 'E'.repeat(500) },
      ],
    });

    const summarized = summarizeToolResultForModel('search_web', raw);
    const parsed = JSON.parse(summarized) as {
      answer: string;
      results: Array<{ content: string }>;
    };

    expect(parsed.answer.length).toBeLessThan(520);
    expect(parsed.results).toHaveLength(3);
    expect(parsed.results[0].content.length).toBeLessThan(240);
  });

  it('caps list-like tool output to the first lines', () => {
    const raw = Array.from({ length: 100 }, (_, index) => `item ${index + 1}`).join('\n');
    const summarized = summarizeToolResultForModel('file_list', raw);
    expect(summarized).toContain('item 1');
    expect(summarized).toContain('more lines truncated');
    expect(summarized).not.toContain('item 100');
  });

  it('keeps workspace search payloads compact', () => {
    const raw = JSON.stringify({
      query: 'notes',
      directory: 'apps',
      total_matches: 9,
      has_more: true,
      matches: Array.from({ length: 9 }, (_, index) => ({
        path: `apps/notes/data/notes/note-${index + 1}.json`,
        type: 'file',
        match_type: 'content',
        snippets: [
          { line: 1, text: 'A'.repeat(320) },
          { line: 2, text: 'B'.repeat(320) },
          { line: 3, text: 'C'.repeat(320) },
        ],
      })),
    });

    const summarized = summarizeToolResultForModel('workspace_search', raw);
    const parsed = JSON.parse(summarized) as {
      matches: Array<{ snippets: Array<{ text: string }> }>;
      total_matches: number;
      has_more: boolean;
    };

    expect(parsed.total_matches).toBe(9);
    expect(parsed.has_more).toBe(true);
    expect(parsed.matches).toHaveLength(5);
    expect(parsed.matches[0].snippets).toHaveLength(2);
    expect(parsed.matches[0].snippets[0].text.length).toBeLessThan(170);
  });

  it('compacts read_url and run_command payloads', () => {
    const urlSummary = JSON.parse(
      summarizeToolResultForModel(
        'read_url',
        JSON.stringify({
          url: 'https://example.com',
          final_url: 'https://example.com/final',
          title: 'Example',
          site_name: 'example.com',
          excerpt: 'X'.repeat(500),
          blocks: Array.from({ length: 10 }, () => ({
            type: 'paragraph',
            text: 'Y'.repeat(300),
          })),
        }),
      ),
    ) as { blocks: Array<{ text: string }>; excerpt: string };

    const commandSummary = JSON.parse(
      summarizeToolResultForModel(
        'run_command',
        JSON.stringify({
          command: 'pnpm test',
          cwd: 'apps/webuiapps',
          exitCode: 0,
          stdout: 'A'.repeat(1500),
          stderr: 'B'.repeat(1500),
        }),
      ),
    ) as { stdout: string; stderr: string };

    expect(urlSummary.blocks).toHaveLength(6);
    expect(urlSummary.blocks[0].text.length).toBeLessThan(190);
    expect(urlSummary.excerpt.length).toBeLessThan(230);
    expect(commandSummary.stdout.length).toBeLessThan(750);
    expect(commandSummary.stderr.length).toBeLessThan(750);
  });
});

describe('shouldEnableAppTools()', () => {
  it('enables tools for explicit app mentions', () => {
    expect(shouldEnableAppTools("Open Aoi's IDE")).toBe(true);
    expect(shouldEnableAppTools('유튜브에서 틀어줘')).toBe(true);
  });

  it('enables tools for URL-reading and app-state questions', () => {
    expect(shouldEnableAppTools('Can you summarize this URL for me?')).toBe(true);
    expect(shouldEnableAppTools('Which window is currently active?')).toBe(true);
    expect(shouldEnableAppTools('Find the ChatPanel component in the codebase')).toBe(true);
  });

  it('does not enable tools for generic web questions', () => {
    expect(shouldEnableAppTools('Can you verify this fact on the web?')).toBe(false);
  });

  it('supports short follow-ups when recent context already mentions an app', () => {
    expect(
      shouldEnableAppTools('open it', [
        { role: 'user', content: 'Please use the browser app for this link' },
      ]),
    ).toBe(true);
  });
});

describe('shouldUseDialogModel()', () => {
  it('uses the cheaper dialog model for short social turns', () => {
    expect(shouldUseDialogModel('That sounds nice')).toBe(true);
    expect(shouldUseDialogModel('고마워, 그럼 그렇게 하자')).toBe(true);
    expect(shouldUseDialogModel('Kira 좋네')).toBe(true);
    expect(shouldUseDialogModel("Aoi's IDE 꽤 마음에 들어")).toBe(true);
  });

  it('keeps heavier intents on the main model', () => {
    expect(shouldUseDialogModel('Open the browser and search for the latest news')).toBe(false);
    expect(shouldUseDialogModel('Can you verify this fact on the web?')).toBe(false);
    expect(shouldUseDialogModel("Aoi's IDE 열어줘")).toBe(false);
    expect(shouldUseDialogModel('유튜브에서 틀어줘')).toBe(false);
    expect(shouldUseDialogModel('Can you summarize this URL for me?')).toBe(false);
    expect(shouldUseDialogModel('Which window is currently active?')).toBe(false);
    expect(shouldUseDialogModel('Find the ChatPanel component in the codebase')).toBe(false);
  });
});

describe('memory prompt limits', () => {
  it('caps prompt memories and trims content', () => {
    const memories: MemoryEntry[] = Array.from({ length: 20 }, (_, index) => ({
      id: `mem-${index}`,
      content: `memory ${index} ${'x'.repeat(200)}`,
      category: 'fact',
      createdAt: index,
    }));

    const selected = selectMemoriesForPrompt(memories);
    expect(selected.length).toBeLessThanOrEqual(12);
    expect(selected.every((entry) => entry.content.length <= 160)).toBe(true);

    const prompt = buildMemoryPrompt(memories);
    expect(prompt).toContain('most relevant memories');
  });
});

describe('buildFileReadResponse()', () => {
  it('returns full content for short files', () => {
    expect(buildFileReadResponse('notes.txt', 'one\ntwo')).toBe('one\ntwo');
  });

  it('returns an excerpt for large files and mentions line ranges', () => {
    const content = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join('\n');
    const response = buildFileReadResponse('big.ts', content);
    expect(response).toContain('File big.ts is large');
    expect(response).toContain('Use file_read with start_line/end_line');
    expect(response).toContain('1: line 1');
    expect(response).toContain('400: line 400');
  });

  it('honors explicit line ranges', () => {
    const content = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n');
    const response = buildFileReadResponse('focus.ts', content, {
      startLine: 10,
      endLine: 14,
    });
    expect(response).toContain('showing lines 10-14');
    expect(response).toContain('10: line 10');
    expect(response).toContain('14: line 14');
  });
});

describe('truncateForTokenBudget()', () => {
  it('keeps short text intact and truncates long text with a suffix', () => {
    expect(truncateForTokenBudget('short', 20)).toBe('short');
    expect(truncateForTokenBudget('x'.repeat(100), 20)).toContain('truncated for token budget');
  });
});
