import type { ChatMessage } from './llmClient';

export interface DirectMusicIntent {
  query: string;
}

const MUSIC_QUERY_SUFFIX_PATTERN = /\s*(?:노래|음악|곡|track|song|music)\s*$/i;
// A usable search title needs at least one letter or digit (any script).
// Symbol-only fragments -- stray emoji, a bare marker -- must not become YouTube
// queries. (The specific case of a tapped "▶ 재생" chip is resolved earlier, from
// the transcript; this stays as the guard for everything else.)
const MUSIC_QUERY_WORD_CHAR_PATTERN = /[\p{L}\p{N}]/u;

// Play chips emitted by Aoi's music cards ("▶ 재생" / "▶ Play" / ...). The chip
// carries no query of its own: its meaning is "play the recommendation in the
// card above", which normally comes from the pending-offer ref. That ref is
// browser-local (localStorage) while the card itself is restored from the
// server-persisted transcript, so a tap from another browser profile, another
// dev-server origin, or after cleared storage arrives with no offer behind it.
// The marker prefix is required -- a bare "재생" typed by the user is not a chip
// and keeps falling through to the normal patterns below.
const MUSIC_PLAY_CHIP_PATTERN = /^[▶▷▸►⏵‣➤]\s*(?:재생|플레이|再生|播放|play)\s*$/iu;

/**
 * True when the message is a tapped music play chip rather than typed text.
 *
 * Callers use this twice: to recover the recommended query from history (see
 * parseDirectMusicIntent), and to answer honestly when nothing is recoverable
 * instead of letting the chip reach the LLM, which then reports playback that
 * never happened.
 */
export function isAoiMusicPlayChip(text: string): boolean {
  // Strip variation selectors so an emoji-presentation marker still matches.
  const normalized = text.trim().replace(/[\uFE0E\uFE0F]/g, '');
  return MUSIC_PLAY_CHIP_PATTERN.test(normalized);
}

/**
 * True when a dispatched agent action did NOT actually happen.
 *
 * dispatchAgentAction never rejects: a closed target app, an unknown action, an
 * app-side failure, or a listener that never answers all come back as a RESOLVED
 * string ("error: ..." / "timeout: no response from app"). Wrapping the dispatch
 * in try/catch alone therefore reports success for actions that did nothing --
 * the exact failure the play chip was reported for. Every ack that claims an app
 * did something has to gate on this.
 */
export function isFailedAgentActionResult(result: string | null | undefined): boolean {
  const normalized = (result ?? '').trim().toLowerCase();
  // Silence is not success: an empty result means the dispatch layer told us
  // nothing, so there is no evidence the action ran.
  return normalized === '' || normalized.startsWith('error:') || normalized.startsWith('timeout:');
}

export interface StartedVideo {
  title: string;
  // False when the query did not name this video and the top hit was taken
  // instead. The caller must then say what is really playing.
  matchedQuery: boolean;
}

/**
 * Read the video the YouTube app reports it started, from an OPEN_SEARCH result.
 *
 * The app answers "success {json}", following the same convention
 * dispatchAgentAction uses when it appends extra info to a result. Anything
 * unparseable yields null, and the caller falls back to naming the query -- the
 * pre-existing wording, never a stronger claim than we can support.
 */
export function parseStartedVideo(result: string | null | undefined): StartedVideo | null {
  const raw = (result ?? '').trim();
  const start = raw.indexOf('{');
  if (start === -1) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw.slice(start)) as Partial<StartedVideo>;
    if (typeof parsed?.title !== 'string' || !parsed.title.trim()) {
      return null;
    }
    return { title: parsed.title.trim(), matchedQuery: parsed.matchedQuery === true };
  } catch {
    return null;
  }
}

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

    // Taste-backed cards: the pick quoted after the note marker. Greedy up to
    // the LAST quote on that line so a title containing quotes survives
    // instead of being cut at the first inner one.
    const tasteCard = content.match(/🎵[^\n"“]*["“](.+)["”]\s*$/mu)?.[1];
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

  // A tapped play chip resolves against the recommendation still visible in the
  // transcript. Without this the symbol-only chip is rejected by cleanMusicQuery
  // below and falls through to the LLM, which answers "I lined it up in YouTube"
  // without any search ever running.
  if (isAoiMusicPlayChip(trimmed)) {
    const chipQuery = extractRecommendedMusicQuery(history);
    return chipQuery ? { query: chipQuery } : null;
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
