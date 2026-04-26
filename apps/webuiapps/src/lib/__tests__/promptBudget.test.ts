import { describe, expect, it } from 'vitest';
import {
  buildPromptBudgetSnapshot,
  estimateTokensFromChars,
  summarizePromptBudget,
} from '../promptBudget';
import type { ChatMessage, ToolDef } from '../llmClient';

describe('estimateTokensFromChars()', () => {
  it('uses a simple 4 chars ~= 1 token heuristic', () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
  });
});

describe('buildPromptBudgetSnapshot()', () => {
  it('reports message and tool breakdowns', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system rules' },
      { role: 'user', content: 'open the browser' },
      { role: 'assistant', content: 'tool call reasoning' },
      { role: 'tool', content: 'tool output text' },
    ];
    const tools: ToolDef[] = [
      {
        type: 'function',
        function: {
          name: 'list_apps',
          description: 'List apps',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'file_read',
          description: 'Read file',
          parameters: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
            required: ['file_path'],
          },
        },
      },
    ];

    const snapshot = buildPromptBudgetSnapshot({
      systemPrompt: messages[0].content,
      historySummary: 'older summary',
      recentHistory: messages.slice(1, 3),
      allMessagesForRequest: messages,
      tools,
    });

    expect(snapshot.messageCount).toBe(4);
    expect(snapshot.toolCount).toBe(2);
    expect(snapshot.systemPromptChars).toBe(messages[0].content.length);
    expect(snapshot.historySummaryChars).toBe('older summary'.length);
    expect(snapshot.recentHistoryChars).toBe(
      messages[1].content.length + messages[2].content.length,
    );
    expect(snapshot.messagesByRole).toEqual({
      system: 1,
      user: 1,
      assistant: 1,
      tool: 1,
    });
    expect(snapshot.largestMessages[0]?.chars).toBeGreaterThan(0);
    expect(snapshot.largestTools[0]?.name).toBeDefined();
    expect(snapshot.estimatedTokens).toBeGreaterThan(0);
  });
});

describe('summarizePromptBudget()', () => {
  it('computes averages and ranks top cost drivers', () => {
    const summary = summarizePromptBudget([
      {
        label: 'conversation-seed',
        createdAt: 1,
        snapshot: {
          totalChars: 4000,
          estimatedTokens: 1000,
          messageCount: 4,
          toolCount: 2,
          systemPromptChars: 1800,
          historySummaryChars: 200,
          recentHistoryChars: 900,
          toolSchemaChars: 800,
          messagesByRole: { system: 1, user: 1, assistant: 1, tool: 1 },
          largestMessages: [],
          largestTools: [],
        },
      },
      {
        label: 'iteration-request',
        iteration: 1,
        createdAt: 2,
        snapshot: {
          totalChars: 4400,
          estimatedTokens: 1100,
          messageCount: 6,
          toolCount: 2,
          systemPromptChars: 2000,
          historySummaryChars: 220,
          recentHistoryChars: 1000,
          toolSchemaChars: 700,
          messagesByRole: { system: 1, user: 2, assistant: 2, tool: 1 },
          largestMessages: [],
          largestTools: [],
        },
      },
    ]);

    expect(summary.averageEstimatedTokens).toBe(1050);
    expect(summary.averageSystemPromptChars).toBe(1900);
    expect(summary.topCostDrivers.map((driver) => driver.label)).toEqual([
      'System prompt',
      'Recent history',
      'Tool schemas',
    ]);
  });
});
