import type { ChatMessage } from './llmClient';

export interface DirectMusicIntent {
  query: string;
}

const MUSIC_QUERY_SUFFIX_PATTERN = /\s*(?:노래|음악|곡|track|song|music)\s*$/i;
// A usable search title needs at least one letter or digit (any script).
// Symbol-only fragments -- a tapped "▶ 재생" reply chip, stray emoji -- must not
// become YouTube queries; rejecting them lets the message fall through to the
// normal conversation instead.
const MUSIC_QUERY_WORD_CHAR_PATTERN = /[\p{L}\p{N}]/u;

/**
 * Detect in-app YouTube "play my saved playlist" intents.
 *
 * Must stay stricter than generic music-search patterns: phrases like
 * "lofi chill playlist 틀어줘" remain YouTube search queries, while
 * "내 플레이 리스트 틀어줘" / "My Playlist 틀어줘" dispatch PLAY_LAST_PLAYLIST.
 */
export function isDirectPlaylistPlaybackIntent(text: string): boolean {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return false;
  }

  // Normalize common spacing variants before matching.
  const normalized = trimmed
    .replace(/플레이\s*리스트/gi, '플레이리스트')
    .replace(/\bmy\s+playlist\b/gi, 'my playlist');

  const patterns = [
    // Korean: optional ownership / recency / saved / in-app YouTube + 플레이리스트 + play verb
    /^(?:(?:내|나의|마이|my)\s+)?(?:(?:마지막|최근|방금|아까)\s*)?(?:(?:들었던|재생한|저장한|등록한)\s*)?(?:(?:인앱\s*)?(?:유튜브|youtube)\s*)?플레이리스트\s*(?:다시\s*)?(?:틀어줘|재생해줘|재생해|틀어|실행해|들려줘|play|resume)?[.!?]?$/i,
    // English / mixed: bare playlist (optional "my") + play verb
    /^(?:my\s+)?playlist\s*(?:틀어줘|재생해줘|재생해|틀어|play|resume)[.!?]?$/i,
    /^(?:play|resume)\s+(?:the\s+)?(?:my\s+)?(?:last\s+|saved\s+)?playlist[.!?]?$/i,
    /^play\s+my\s+playlist[.!?]?$/i,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function cleanMusicQuery(value: string): string {
  const cleaned = value.trim().replace(MUSIC_QUERY_SUFFIX_PATTERN, '').trim();
  return MUSIC_QUERY_WORD_CHAR_PATTERN.test(cleaned) ? cleaned : '';
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
    const youtubeQuery =
      content.match(/YouTube\s*(?:검색어|search query|検索語|搜索词)\s*:\s*`([^`]+)`/i)?.[1] ??
      content.match(/YouTube\s*(?:검색어|search query)\s*:\s*`([^`]+)`/i)?.[1];
    if (youtubeQuery?.trim()) {
      return youtubeQuery.trim();
    }

    // Taste-backed cards: 🎵 추천: "query" / 🎵 Pick: "query"
    const tasteCard = content.match(/🎵[^\n"]*["“]([^"”]+)["”]/u)?.[1];
    if (tasteCard?.trim()) {
      return tasteCard.trim();
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

  // Saved in-app playlist playback is handled by PLAY_LAST_PLAYLIST. Never
  // collapse those phrases into a YouTube search for "내 플레이 리스트".
  if (isDirectPlaylistPlaybackIntent(trimmed)) {
    return null;
  }

  // Deferral phrases ("play that one / you pick") must resolve against the
  // recommendation in recent context BEFORE the generic suffix patterns run:
  // "그걸로 가자" otherwise matches the `...로 가자` pattern and literally
  // searches YouTube for "그걸". With no recommendation to resolve, return null
  // so the conversation handles it instead of searching the pronoun.
  if (
    /^(?:네가|니가|너가)\s*골라[줘]?$/u.test(trimmed) ||
    /^(?:그걸로|이걸로|추천대로)\s*(?:가자|해줘|하자)?$/u.test(trimmed)
  ) {
    const query = extractRecommendedMusicQuery(history);
    return query ? { query } : null;
  }

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

  return null;
}
