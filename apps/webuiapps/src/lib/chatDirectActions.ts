import type { ChatMessage } from './llmClient';

export interface DirectMusicIntent {
  query: string;
}

const MUSIC_QUERY_SUFFIX_PATTERN = /\s*(?:노래|음악|곡|track|song|music)\s*$/i;

function cleanMusicQuery(value: string): string {
  return value.trim().replace(MUSIC_QUERY_SUFFIX_PATTERN, '').trim();
}

function enrichMusicQueryFromHistory(
  query: string,
  history: Pick<ChatMessage, 'role' | 'content'>[],
): string {
  const normalized = query.trim();
  if (!/^(?:걸그룹|girl\s*group)$/i.test(normalized)) {
    return normalized;
  }

  const recentAssistant = [...history].reverse().find((message) => message.role === 'assistant');
  const content = recentAssistant?.content ?? '';
  const datedGirlGroup = content.match(/([0-9]{1,2}월\s*걸그룹|june\s+girl\s*group)/i)?.[1];
  return datedGirlGroup?.trim() || normalized;
}

function extractRecommendedMusicQuery(
  history: Pick<ChatMessage, 'role' | 'content'>[],
): string | null {
  const recentAssistantMessages = [...history]
    .reverse()
    .filter((message) => message.role === 'assistant')
    .slice(0, 3);

  for (const message of recentAssistantMessages) {
    const content = message.content;
    const youtubeQuery = content.match(/YouTube\s*검색어\s*:\s*`([^`]+)`/i)?.[1];
    if (youtubeQuery?.trim()) {
      return youtubeQuery.trim();
    }

    const recommended = content.match(/(?:내\s*)?추천은\s+\*\*([^*]+)\*\*/)?.[1];
    if (recommended?.trim()) {
      return cleanMusicQuery(recommended.replace(/\s*쪽으로.*$/u, '')) || recommended.trim();
    }

    const datedGirlGroup = content.match(/([0-9]{1,2}월\s*걸그룹|june\s+girl\s*group)/i)?.[1];
    if (datedGirlGroup?.trim()) {
      return datedGirlGroup.trim();
    }
  }

  return null;
}

export function parseDirectMusicIntent(
  text: string,
  history: Pick<ChatMessage, 'role' | 'content'>[] = [],
): DirectMusicIntent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const suffixPatterns = [
    /^(?<query>.+?)\s*(?:듣자|들어보자|틀어줘|재생해줘|재생해|들려줘|틀어|재생하자|재생)$/,
    /^(?<query>.+?)\s*(?:듣고 싶어|듣고싶어|듣고싶다|듣고 싶다)$/,
    /^(?<query>.+?)\s*(?:노래|음악|곡)?\s*(?:로|으로)\s*(?:가자|가줘|갈게|갈래|하자|해줘)$/,
    /^(?:play|listen to|put on)\s+(?<query>.+)$/i,
    /^(?:let'?s|lets)\s+listen(?:\s+to)?\s+(?<query>.+)$/i,
    /^(?:we should|can we|could we)\s+listen(?:\s+to)?\s+(?<query>.+)$/i,
  ];

  for (const pattern of suffixPatterns) {
    const match = trimmed.match(pattern);
    const query = cleanMusicQuery(match?.groups?.query ?? '');
    if (query) {
      return { query: enrichMusicQueryFromHistory(query, history) };
    }
  }

  const prefixPatterns = [
    /^(?:틀어줘|재생해줘|재생해|들려줘|틀어)\s+(?<query>.+)$/,
    /^(?:play|listen to|put on)\s+(?<query>.+)$/i,
    /^(?:let'?s|lets)\s+listen(?:\s+to)?\s+(?<query>.+)$/i,
    /^(?:we should|can we|could we)\s+listen(?:\s+to)?\s+(?<query>.+)$/i,
  ];

  for (const pattern of prefixPatterns) {
    const match = trimmed.match(pattern);
    const query = cleanMusicQuery(match?.groups?.query ?? '');
    if (query) {
      return { query: enrichMusicQueryFromHistory(query, history) };
    }
  }

  if (
    /^(?:네가|니가|너가)\s*골라[줘]?$/u.test(trimmed) ||
    /^(?:그걸로|이걸로|추천대로)\s*(?:가자|해줘|하자)?$/u.test(trimmed)
  ) {
    const query = extractRecommendedMusicQuery(history);
    if (query) {
      return { query };
    }
  }

  return null;
}
