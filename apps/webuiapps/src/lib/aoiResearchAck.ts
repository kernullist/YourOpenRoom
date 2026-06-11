export type AoiResearchAckLanguage = 'ko' | 'ja' | 'zh' | 'en';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getPhaseLabel(phase: string, language: AoiResearchAckLanguage): string {
  if (language !== 'ko') {
    return phase || 'running';
  }

  switch (phase) {
    case 'queued':
      return '대기 중';
    case 'planning':
      return '조사 계획 수립';
    case 'searching':
      return '웹 검색';
    case 'reading_sources':
      return '자료 읽기';
    case 'extracting_evidence':
      return '근거 추출';
    case 'drafting_report':
      return '문서 초안 작성';
    case 'verifying_report':
      return '인용/근거 검증';
    case 'completed':
      return '완료';
    case 'failed':
      return '실패';
    case 'cancelled':
      return '취소됨';
    default:
      return phase || '진행 중';
  }
}

export function buildAoiResearchStartAckMessage(
  toolResult: string,
  language: AoiResearchAckLanguage = 'en',
): string | null {
  let parsed: Record<string, unknown>;
  try {
    const decoded = JSON.parse(toolResult);
    const record = asRecord(decoded);
    if (!record) {
      return null;
    }
    parsed = record;
  } catch {
    return null;
  }

  if (parsed.ok !== true) {
    return null;
  }

  const run = asRecord(parsed.run);
  const runId = readString(parsed.runId) || readString(run?.id);
  if (!runId) {
    return null;
  }

  const status = readString(run?.status);
  const phase = readString(run?.phase);
  const isBackground = parsed.background === true || status === 'queued' || status === 'running';
  if (!isBackground) {
    return null;
  }

  const phaseLabel = getPhaseLabel(phase, language);

  switch (language) {
    case 'ko':
      return [
        '연구를 시작했어.',
        `run id는 \`${runId}\`이고 현재 단계는 ${phaseLabel}이야.`,
        'Aoi Research 앱에서 진행 상황과 생성되는 report/sources/evidence를 확인할 수 있어.',
        '진행 중에도 이 채팅에서 다른 대화를 계속해도 돼.',
      ].join(' ');
    case 'ja':
      return [
        '調査を開始したよ。',
        `run id is \`${runId}\`, current phase is ${phaseLabel}.`,
        'You can keep chatting while it runs and check progress in Aoi Research.',
      ].join(' ');
    case 'zh':
      return [
        '研究任务已开始。',
        `run id is \`${runId}\`, current phase is ${phaseLabel}.`,
        'You can keep chatting while it runs and check progress in Aoi Research.',
      ].join(' ');
    default:
      return [
        'I started the research run.',
        `Run id is \`${runId}\`, current phase is ${phaseLabel}.`,
        'You can keep chatting while it runs and check progress in Aoi Research.',
      ].join(' ');
  }
}
