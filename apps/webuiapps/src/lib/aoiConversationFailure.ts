export interface AoiUndeliveredConversationFailureInput {
  userMessage: string;
  iterations: number;
  pendingToolCalls?: readonly string[];
}

const MAX_VISIBLE_TOOL_CALLS = 3;
const MAX_VISIBLE_TOOL_CALL_CHARS = 96;

function summarizePendingToolCalls(toolCalls: readonly string[]): string {
  return toolCalls
    .slice(-MAX_VISIBLE_TOOL_CALLS)
    .map((toolCall) => toolCall.replace(/\s+/g, ' ').trim().slice(0, MAX_VISIBLE_TOOL_CALL_CHARS))
    .filter(Boolean)
    .join(', ');
}

export function buildAoiUndeliveredConversationFailureMessage(
  input: AoiUndeliveredConversationFailureInput,
): string {
  const iterations = Math.max(0, Math.floor(input.iterations));
  const pendingToolCalls = summarizePendingToolCalls(input.pendingToolCalls ?? []);
  const isKorean = /[\uac00-\ud7a3]/u.test(input.userMessage);

  if (isKorean) {
    return [
      `Aoi 오류: ${iterations}회의 모델/도구 반복 후 사용자에게 전달할 답변을 만들지 못했습니다.`,
      '실행은 실패로 기록되었으며 채팅 입력은 보존되었습니다.',
      pendingToolCalls ? `마지막 도구 단계: ${pendingToolCalls}` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  return [
    `Aoi error: no user-visible response was produced after ${iterations} model/tool iterations.`,
    'The run was recorded as failed and the chat input was preserved.',
    pendingToolCalls ? `Last tool steps: ${pendingToolCalls}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
