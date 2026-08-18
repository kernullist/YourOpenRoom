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

// Words that point BACK at something already said instead of naming a video.
// Used two ways: to spot a "play that again" request, and to reject one of these
// if it ever comes back out of the transcript as a recovered "title" -- Aoi's
// own ack for a mis-parsed request quotes the pronoun ("다시" 유튜브에서
// 틀어볼게), and recovering that would search for the pronoun a second time.
const MUSIC_DEFERRAL_PRONOUN_PATTERN =
  /^(?:다시|또|그거|그걸|그것|이거|이것|저거|저것|아까|방금|한\s*번\s*더|again|that|it|the\s+same)$/iu;

// A request to replay what Aoi just named, with no title of its own. Every
// pattern is anchored end to end and requires a playback verb, so a message that
// also carries a real title ("aespa 다시 틀어줘") is left to the normal
// extraction below rather than being collapsed into a pronoun.
const MUSIC_DEFERRAL_PLAYBACK_PATTERNS: readonly RegExp[] = [
  // "다시 틀어줘" / "한 번 더 재생해" / "또 들려줘"
  /^(?:다시|또|한\s*번\s*더)\s*(?:틀어줘|틀어|재생해줘|재생해|재생|들려줘|들려줄래|플레이)\s*$/u,
  // "그거 틀어줘" / "아까 그거 다시 재생해줘"
  /^(?:아까|방금|좀\s*전에)?\s*(?:그거|그걸|그것|이거|이것|저거|저것)\s*(?:를|을)?\s*(?:다시|또)?\s*(?:틀어줘|틀어|재생해줘|재생해|들려줘|플레이)\s*$/u,
  // "아니 아까 너가 말한거 틀어달란거야" and its many endings
  /^(?:아니\s*)?(?:아까|방금|좀\s*전에)?\s*(?:네가|니가|너가|자기가)?\s*(?:말한|말했던|얘기한|얘기했던|추천한|추천했던|틀어준|들려준)\s*(?:거|것|곡|노래|음악|플레이리스트|플레이\s*리스트)?\s*(?:를|을)?\s*(?:다시|또)?\s*(?:틀어|재생|들려|플레이)\S*\s*$/u,
  /^(?:play\s+(?:it|that|the\s+same(?:\s+one)?)\s+again|play\s+it|again|replay|one\s+more\s+time|play\s+the\s+one\s+you\s+(?:said|mentioned|recommended))[.!?]?$/i,
];

/**
 * True when the user is asking for the pick Aoi already named, without naming
 * it themselves ("다시 틀어줘", "아까 너가 말한거 틀어줘").
 *
 * These used to fall two different ways, both wrong: the suffix patterns below
 * turned "다시 틀어줘" into a YouTube search for "다시", and anything they did
 * not match reached the LLM, which announced playback it never dispatched.
 */
export function isDeferredMusicPlaybackIntent(text: string): boolean {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return false;
  }
  return MUSIC_DEFERRAL_PLAYBACK_PATTERNS.some((pattern) => pattern.test(trimmed));
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

    // Playback acks quote the pick but carry neither the note marker nor a
    // search-query line ("틀어줄게. 유튜브에서 "<title>" 찾아서 재생 준비해뒀어."),
    // so without this a "play that again" right after Aoi started something had
    // nothing to resolve against. The LAST quote wins: the substitution ack
    // names the query first and the video actually playing second, and the
    // playing one is what "again" means.
    // Gated on the message being about playback at all, so an unrelated
    // assistant line that happens to quote something is not mistaken for a pick.
    if (
      /(?:유튜브|youtube|틀어|틀었|재생|플레이|かけ|流し|播放|\bplay(?:ing|ed|s)?\b)/i.test(content)
    ) {
      const quoted = [...content.matchAll(/["“]([^"”\n]{2,})["”]/gu)]
        .map((match) => match[1].trim())
        .filter((candidate) => candidate && !MUSIC_DEFERRAL_PRONOUN_PATTERN.test(candidate));
      const lastQuoted = quoted[quoted.length - 1];
      if (lastQuoted) {
        return lastQuoted;
      }
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
    /^(?:그걸로|이걸로|추천대로)\s*(?:가자|해줘|하자)?$/u.test(trimmed) ||
    isDeferredMusicPlaybackIntent(trimmed)
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
