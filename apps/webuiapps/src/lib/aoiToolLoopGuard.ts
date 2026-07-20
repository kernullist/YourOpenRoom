/**
 * Detects stalled tool-only conversation loops (same tools repeated without
 * respond_to_user) and builds recovery prompts so the model can still answer
 * before the iteration budget is exhausted.
 */

export interface AoiToolCallLike {
  function: {
    name: string;
    arguments?: string;
  };
}

export interface AoiToolLoopGuardState {
  recentSignatures: string[];
  stallNotices: number;
  budgetNotices: number;
}

export interface AoiToolLoopGuardDecision {
  kind: 'none' | 'stall' | 'budget';
  prompt: string;
  state: AoiToolLoopGuardState;
}

const DEFAULT_REPEAT_THRESHOLD = 2;
const DEFAULT_SIGNATURE_WINDOW = 8;

export function createAoiToolLoopGuardState(): AoiToolLoopGuardState {
  return {
    recentSignatures: [],
    stallNotices: 0,
    budgetNotices: 0,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

export function buildAoiToolBatchSignature(toolCalls: readonly AoiToolCallLike[]): string {
  return toolCalls
    .map((toolCall) => {
      const name = toolCall.function.name || 'unknown';
      let args = '';
      try {
        const parsed = JSON.parse(toolCall.function.arguments || '{}') as unknown;
        args = stableJson(parsed);
      } catch {
        args = String(toolCall.function.arguments || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
      }
      return `${name}:${args}`;
    })
    .sort()
    .join('|');
}

function buildStallPrompt(signature: string, remainingIterations: number): string {
  return [
    'Tool-loop guard: the same tool batch was repeated without a user-visible reply.',
    `Repeated batch: ${signature.slice(0, 280)}`,
    'Stop rediscovering the same paths. Do NOT call the same file_list/file_read again unless the previous result was a hard error with a corrected path.',
    'If evidence is incomplete, answer with what you already know and name the remaining gap.',
    remainingIterations <= 1
      ? 'This is the final model turn. You MUST call respond_to_user now.'
      : `You have about ${remainingIterations} model/tool iteration(s) left. Call respond_to_user in this turn.`,
  ].join('\n');
}

function buildBudgetPrompt(remainingIterations: number): string {
  return [
    'Tool-loop guard: the conversation iteration budget is nearly exhausted and no respond_to_user has been delivered yet.',
    remainingIterations <= 1
      ? 'This is the final model turn. You MUST call respond_to_user now with the best answer available.'
      : `You have about ${remainingIterations} model/tool iteration(s) left. Prefer respond_to_user over more exploration.`,
    'Do not spend the remaining budget only on file_list/file_read rediscovery.',
  ].join('\n');
}

/**
 * Observe one finished tool batch (no respond_to_user delivered).
 * Returns a system prompt when the loop is stalling or near the budget wall.
 */
export function observeAoiToolLoopBatch(input: {
  state: AoiToolLoopGuardState;
  toolCalls: readonly AoiToolCallLike[];
  iterations: number;
  iterationLimit: number;
  deliveredAssistantContent: string;
  batchHasRespondTool: boolean;
  repeatThreshold?: number;
  signatureWindow?: number;
}): AoiToolLoopGuardDecision {
  const state: AoiToolLoopGuardState = {
    recentSignatures: [...input.state.recentSignatures],
    stallNotices: input.state.stallNotices,
    budgetNotices: input.state.budgetNotices,
  };

  if (input.batchHasRespondTool || input.deliveredAssistantContent.trim()) {
    return { kind: 'none', prompt: '', state };
  }

  const signature = buildAoiToolBatchSignature(input.toolCalls);
  if (signature) {
    state.recentSignatures = [...state.recentSignatures, signature].slice(
      -(input.signatureWindow ?? DEFAULT_SIGNATURE_WINDOW),
    );
  }

  const remainingIterations = Math.max(0, input.iterationLimit - input.iterations);
  const repeatThreshold = input.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD;
  const repeatCount = state.recentSignatures.filter((item) => item === signature).length;

  if (signature && repeatCount >= repeatThreshold && state.stallNotices < 2) {
    state.stallNotices += 1;
    return {
      kind: 'stall',
      prompt: buildStallPrompt(signature, remainingIterations),
      state,
    };
  }

  // Nudge once when only 1-2 iterations remain and still no user-visible reply.
  if (remainingIterations <= 2 && state.budgetNotices < 1) {
    state.budgetNotices += 1;
    return {
      kind: 'budget',
      prompt: buildBudgetPrompt(remainingIterations),
      state,
    };
  }

  return { kind: 'none', prompt: '', state };
}
