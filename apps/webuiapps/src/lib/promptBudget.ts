import type { ChatMessage, ToolDef } from './llmClient';

export interface PromptBudgetSnapshot {
  totalChars: number;
  estimatedTokens: number;
  messageCount: number;
  toolCount: number;
  systemPromptChars: number;
  historySummaryChars: number;
  recentHistoryChars: number;
  toolSchemaChars: number;
  messagesByRole: Record<ChatMessage['role'], number>;
  largestMessages: Array<{
    role: ChatMessage['role'];
    chars: number;
    preview: string;
  }>;
  largestTools: Array<{
    name: string;
    chars: number;
  }>;
}

export interface PromptBudgetEntry {
  label: string;
  iteration?: number;
  modelRoute?: 'main' | 'dialog';
  modelId?: string;
  snapshot: PromptBudgetSnapshot;
  createdAt: number;
}

export interface PromptBudgetOverview {
  averageEstimatedTokens: number;
  averageSystemPromptChars: number;
  averageRecentHistoryChars: number;
  averageToolSchemaChars: number;
  recentTurnCount: number;
  dialogTurnCount: number;
  mainTurnCount: number;
  topCostDrivers: Array<{ label: string; averageChars: number }>;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function estimateTokensFromChars(charCount: number): number {
  return Math.ceil(charCount / 4);
}

function toolToSchemaText(tool: ToolDef): string {
  return JSON.stringify(tool.function);
}

function getLargestMessages(
  messages: ChatMessage[],
  limit = 5,
): PromptBudgetSnapshot['largestMessages'] {
  return [...messages]
    .map((message) => ({
      role: message.role,
      chars: message.content.length,
      preview: normalizeWhitespace(message.content).slice(0, 140),
    }))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, limit);
}

function getLargestTools(tools: ToolDef[], limit = 5): PromptBudgetSnapshot['largestTools'] {
  return [...tools]
    .map((tool) => ({
      name: tool.function.name,
      chars: toolToSchemaText(tool).length,
    }))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, limit);
}

export function buildPromptBudgetSnapshot(input: {
  systemPrompt: string;
  historySummary?: string;
  recentHistory: ChatMessage[];
  allMessagesForRequest: ChatMessage[];
  tools: ToolDef[];
}): PromptBudgetSnapshot {
  const systemPromptChars = input.systemPrompt.length;
  const historySummaryChars = input.historySummary?.length ?? 0;
  const recentHistoryChars = input.recentHistory.reduce(
    (sum, message) => sum + message.content.length,
    0,
  );
  const toolSchemaChars = input.tools.reduce((sum, tool) => sum + toolToSchemaText(tool).length, 0);
  const messageChars = input.allMessagesForRequest.reduce(
    (sum, message) => sum + message.content.length,
    0,
  );
  const totalChars = messageChars + toolSchemaChars;

  return {
    totalChars,
    estimatedTokens: estimateTokensFromChars(totalChars),
    messageCount: input.allMessagesForRequest.length,
    toolCount: input.tools.length,
    systemPromptChars,
    historySummaryChars,
    recentHistoryChars,
    toolSchemaChars,
    messagesByRole: {
      system: input.allMessagesForRequest.filter((message) => message.role === 'system').length,
      user: input.allMessagesForRequest.filter((message) => message.role === 'user').length,
      assistant: input.allMessagesForRequest.filter((message) => message.role === 'assistant')
        .length,
      tool: input.allMessagesForRequest.filter((message) => message.role === 'tool').length,
    },
    largestMessages: getLargestMessages(input.allMessagesForRequest),
    largestTools: getLargestTools(input.tools),
  };
}

export function summarizePromptBudget(entries: PromptBudgetEntry[]): PromptBudgetOverview {
  if (entries.length === 0) {
    return {
      averageEstimatedTokens: 0,
      averageSystemPromptChars: 0,
      averageRecentHistoryChars: 0,
      averageToolSchemaChars: 0,
      recentTurnCount: 0,
      dialogTurnCount: 0,
      mainTurnCount: 0,
      topCostDrivers: [],
    };
  }

  const count = entries.length;
  const averageEstimatedTokens = Math.round(
    entries.reduce((sum, entry) => sum + entry.snapshot.estimatedTokens, 0) / count,
  );
  const averageSystemPromptChars = Math.round(
    entries.reduce((sum, entry) => sum + entry.snapshot.systemPromptChars, 0) / count,
  );
  const averageRecentHistoryChars = Math.round(
    entries.reduce((sum, entry) => sum + entry.snapshot.recentHistoryChars, 0) / count,
  );
  const averageToolSchemaChars = Math.round(
    entries.reduce((sum, entry) => sum + entry.snapshot.toolSchemaChars, 0) / count,
  );

  const drivers = [
    { label: 'System prompt', averageChars: averageSystemPromptChars },
    {
      label: 'History summary',
      averageChars: Math.round(
        entries.reduce((sum, entry) => sum + entry.snapshot.historySummaryChars, 0) / count,
      ),
    },
    { label: 'Recent history', averageChars: averageRecentHistoryChars },
    { label: 'Tool schemas', averageChars: averageToolSchemaChars },
  ]
    .filter((driver) => driver.averageChars > 0)
    .sort((a, b) => b.averageChars - a.averageChars)
    .slice(0, 3);

  const turnEntries = entries.filter((entry) => entry.label === 'conversation-seed');
  const dialogTurnCount = turnEntries.filter((entry) => entry.modelRoute === 'dialog').length;
  const mainTurnCount = turnEntries.filter((entry) => entry.modelRoute !== 'dialog').length;

  return {
    averageEstimatedTokens,
    averageSystemPromptChars,
    averageRecentHistoryChars,
    averageToolSchemaChars,
    recentTurnCount: turnEntries.length,
    dialogTurnCount,
    mainTurnCount,
    topCostDrivers: drivers,
  };
}
