import type { ChatMessage } from './llmClient';

export interface DirectMusicIntent {
  query: string;
  /**
   * Picks the user explicitly rejected ("달플리 말고 ..."). The YouTube app
   * rides them as search minus operators and filters any result whose title or
   * channel names one, so the refused pick cannot come back as the answer.
   */
  exclude?: string[];
}

// The generic-filler word is stripped only as a STANDALONE trailing word
// (start-of-string or whitespace before it). Without the boundary the bare
// suffix match ate the last syllable of compounds -- "aespa 신곡" became
// "aespa 신", "soundtrack" became "sound" -- and the corrupted query searched.
// Attached filler ("에스파노래") now stays whole, which YouTube handles fine.
const MUSIC_QUERY_SUFFIX_PATTERN = /(?:^|\s)(?:노래|음악|곡|track|song|music)\s*$/i;
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

// Backticked code, never a pick: a path, a command flag, a call, a file name, a
// bare identifier with no spaces at all.
const MUSIC_CODE_LIKE_PATTERN =
  /[/\\]|^--?[a-z]|\(\)|\.(?:ts|tsx|js|jsx|mjs|cjs|json|ya?ml|md|s?css|py|sh|ps1|bat|exe|dll|sys|log)\b|^[a-z][a-z0-9_$]*$|^(?:pnpm|npm|npx|yarn|git|node|python|py|pip|tsc|vitest|jest|eslint|prettier|docker|make|cargo|go|cd|ls|cat|rm|mv|cp|mkdir|curl|sudo|bash|sh|pwsh|powershell)\b/i;

// Words that point BACK at something already said instead of naming a video.
// Used two ways: to spot a "play that again" request, and to reject one of these
// if it ever comes back out of the transcript as a recovered "title" -- Aoi's
// own ack for a mis-parsed request quotes the pronoun ("다시" 유튜브에서
// 틀어볼게), and recovering that would search for the pronoun a second time.
const MUSIC_DEFERRAL_PRONOUN_PATTERN =
  /^(?:다시|또|그거|그걸|그것|그건|이거|이것|이건|저거|저것|저건|그때|아까|방금|한\s*번\s*더|again|that|it|the\s+same)$/iu;

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

// A reference to Aoi's OWN pick that carries no playback verb at all
// ("아니, 너가 추천한 에스파 노래 말야"). Every pattern above is anchored on a
// playback verb, so this shape fell through to the LLM -- and on a turn that
// carries no app tools the LLM answered by promising playback "다음 턴에", then
// repeated that promise on every turn after it.
const MUSIC_PICK_REFERENCE_CORE = String.raw`(?:아까|방금|좀\s*전에)?\s*(?:네가|니가|너가|자기가)?\s*(?:추천한|추천했던|추천해준|말한|말했던|얘기한|얘기했던|골라준|고른|틀어준|들려준)\s*(?:\S+\s+)?(?:거|것|곡|노래|음악|트랙|플레이리스트|플레이\s*리스트)`;
// The message also has to SAY it is the request ("... 말야") or open with a
// correction ("아니, ..."). Without one of those a bare noun phrase is just as
// likely to start an opinion ("너가 추천한 노래 별로였어"), and playing something
// unasked is worse than falling through to the conversation.
//
// 맞아/맞지 are deliberately NOT here. "너가 추천한 노래 맞지?" is the user asking
// whether they have it right, and answering a question by starting playback is
// presumptuous. A bare "맞아" replying to Aoi's own confirm ask is already handled
// by isMusicPickConfirmationIntent.
const MUSIC_PICK_REFERENCE_TAIL = String.raw`(?:말(?:이)?야|말이지|말이라고|얘기야|이야|이라고)`;
const MUSIC_PICK_REFERENCE_PATTERNS: readonly RegExp[] = [
  new RegExp(
    String.raw`^${MUSIC_PICK_REFERENCE_CORE}\s*${MUSIC_PICK_REFERENCE_TAIL}[.!?~\s]*$`,
    'u',
  ),
  new RegExp(
    String.raw`^(?:아니+|아니야|그게\s*아니(?:고|라|야)|no+)[,.\s]+${MUSIC_PICK_REFERENCE_CORE}\s*${MUSIC_PICK_REFERENCE_TAIL}?[.!?~\s]*$`,
    'u',
  ),
  /^(?:no+[,.\s]+)?i\s+meant\s+the\s+(?:one|song|track)\s+you\s+(?:recommended|mentioned|said|picked|suggested)[.!?\s]*$/i,
];

/**
 * True when the user is asking for the pick Aoi already named, without naming
 * it themselves ("다시 틀어줘", "아까 너가 말한거 틀어줘", "너가 추천한 곡
 * 말야").
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
  return (
    MUSIC_DEFERRAL_PLAYBACK_PATTERNS.some((pattern) => pattern.test(trimmed)) ||
    MUSIC_PICK_REFERENCE_PATTERNS.some((pattern) => pattern.test(trimmed))
  );
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

// "A 말고 B" / "A 빼고 B" / "A 대신 B": A is the pick being rejected, B is the
// actual request. Keeping A would hand YouTube a positive keyword for the very
// thing the user refused. Greedy up to the LAST marker so a chained rejection
// ("A 말고 B도 말고 C") resolves to the final choice. The separator after the
// marker is required so words that merely end in the marker ("말고기") survive.
const MUSIC_EXCLUSION_PREFIX_PATTERN = /^(?<rejected>.*)(?:말고|말구|빼고|빼구|대신에?)[\s,]+/u;

// Splits a rejected prefix that chained several rejections into its terms. The
// marker must be followed by a separator, mirroring the prefix pattern above,
// so a marker embedded inside a word ("말고기", "대신맨") never splits it.
const MUSIC_EXCLUSION_MARKER_SPLIT_PATTERN = /(?:말고|말구|빼고|빼구|대신에?)(?=[\s,])|,/u;

// The same markers at the very end ("달플리 말고 틀어줘") reject a pick without
// naming a replacement -- there is no query to build from that.
const MUSIC_DANGLING_EXCLUSION_PATTERN = /(?:말고|말구|빼고|빼구|대신에?)$/u;

// Object particle left dangling once the playback verb is stripped
// ("...노래모음을 틀어줘" -> "...노래모음을"). It is request grammar, not part
// of the title, and it measurably skews YouTube ranking.
const MUSIC_TRAILING_OBJECT_PARTICLE_PATTERN = /(?<=[\p{L}\p{N}])[을를]$/u;

// Trailing topic/object particle on a REJECTED term ("달플리는", "B도"). 이/가
// stay OUT of the class: they end too many real artist names (싸이, 이하이) to
// strip blind -- an unstripped particle only makes the filter needle inert,
// while a wrongly stripped name makes it destructive.
const MUSIC_EXCLUSION_TERM_PARTICLE_PATTERN = /(?<=[\p{L}\p{N}])[은는을를도]$/u;

// "그 채널 빼고", "이 노래 말고": a bare demonstrative + noun names nothing the
// filter can act on, and its minus operator only skews the search.
const MUSIC_EXCLUSION_DEIXIS_PATTERN = /^(?:그|이|저)\s/u;

// Keep in sync with parseExcludeParam's cap on the MusicApp side, so what the
// parser promises and what the app enforces truncate identically.
const MAX_EXCLUSION_TERMS = 4;

/**
 * The rejected picks named before the exclusion markers, cleaned into terms
 * the YouTube app can filter by. Every guard here errs toward dropping the
 * term: the needles feed a substring filter, so a short, deictic, or pronoun
 * needle ("너", "그거", "그 채널") would nuke unrelated results, while a
 * dropped needle merely loses the active exclusion -- the cleaned request
 * side alone already expresses the intent.
 */
function extractExclusionTerms(rejected: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const segment of rejected.split(MUSIC_EXCLUSION_MARKER_SPLIT_PATTERN)) {
    const trimmed = segment.trim();
    const stripped = trimmed.replace(MUSIC_EXCLUSION_TERM_PARTICLE_PATTERN, '');
    // Keep the particle when stripping would leave a single char: 싸이 and
    // 유도 are names, not "싸 + 이" / "유 + 도".
    const term = stripped.length >= 2 ? stripped : trimmed;
    if (term.length < 2 || !MUSIC_QUERY_WORD_CHAR_PATTERN.test(term)) continue;
    if (MUSIC_DEFERRAL_PRONOUN_PATTERN.test(term)) continue;
    if (MUSIC_EXCLUSION_DEIXIS_PATTERN.test(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_EXCLUSION_TERMS) break;
  }
  return terms;
}

/**
 * Cleanup that is valid ONLY for the user's own typed request: exclusion
 * phrases and a trailing object particle. Recovered recommendation titles must
 * NOT pass through here -- a real title can contain " 말고 " ("너 말고 니 언니")
 * or end in 을/를, and stripping those would corrupt it.
 */
function cleanRequestedMusicQuery(value: string): {
  query: string;
  exclude: string[];
  // True when the message refused a pick, whether or not the refused terms
  // survived cleaning. exclude.length alone cannot say that -- extractExclusion
  // Terms drops needles too short or too deictic to filter by -- and the callers
  // must not resolve a refusal against the very pick that was refused.
  rejected: boolean;
} {
  const exclusionMatch = value.match(MUSIC_EXCLUSION_PREFIX_PATTERN);
  const request = exclusionMatch ? value.slice(exclusionMatch[0].length).trim() : value.trim();
  if (!request || MUSIC_DANGLING_EXCLUSION_PATTERN.test(request)) {
    // A rejection with no replacement named. An empty query drops the direct
    // path entirely so the conversation resolves it, instead of literally
    // searching YouTube for the rejection words.
    return { query: '', exclude: [], rejected: true };
  }
  return {
    query: cleanMusicQuery(request.replace(MUSIC_TRAILING_OBJECT_PARTICLE_PATTERN, '')),
    exclude: exclusionMatch ? extractExclusionTerms(exclusionMatch.groups?.rejected ?? '') : [],
    rejected: Boolean(exclusionMatch),
  };
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

interface RecommendedMusicPick {
  query: string;
  // The assistant message the query was read out of. Its prose names the same
  // pick in whatever script Aoi was speaking, which is not always the script the
  // query itself uses -- see resolveOfferSelectionQuery.
  source: string;
}

// Every pick a single assistant message names, in priority order: the exact
// search query first, then the quoted title, then the looser fallbacks. Split
// out of findRecommendedMusicPick so the intent classifier can offer the whole
// set as candidates instead of only the winner (see aoiMusicIntentClassifier).
function collectMusicPicksFromMessage(content: string): string[] {
  const picks: string[] = [];
  const push = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !picks.some((pick) => pick.toLowerCase() === trimmed.toLowerCase())) {
      picks.push(trimmed);
    }
  };

  push(content.match(/YouTube\s*(?:검색어|search query|検索語|搜索词)\s*:\s*`([^`]+)`/i)?.[1]);

  // Taste-backed cards: the pick quoted after the note marker. Greedy up to the
  // LAST quote on that line so a title containing quotes survives instead of
  // being cut at the first inner one.
  push(content.match(/🎵[^\n"“]*["“](.+)["”]\s*$/mu)?.[1]);

  const recommended = content.match(/(?:내\s*)?추천은\s+\*\*([^*]+)\*\*/)?.[1];
  if (recommended?.trim()) {
    push(cleanMusicQuery(recommended.replace(/\s*쪽으로.*$/u, '')) || recommended.trim());
  }

  push(content.match(/([0-9]{1,2}월\s*걸그룹|june\s+girl\s*group)/i)?.[1]);

  // Playback acks quote the pick but carry neither the note marker nor a
  // search-query line ("틀어줄게. 유튜브에서 "<title>" 찾아서 재생 준비해뒀어."),
  // so without this a "play that again" right after Aoi started something had
  // nothing to resolve against. The LAST quote wins: the substitution ack names
  // the query first and the video actually playing second, and the playing one
  // is what "again" means.
  // Gated on the message being about playback at all, so an unrelated assistant
  // line that happens to quote something is not mistaken for a pick.
  if (
    /(?:유튜브|youtube|틀어|틀었|재생|플레이|かけ|流し|播放|\bplay(?:ing|ed|s)?\b)/i.test(content)
  ) {
    // A backticked search query. The recommendation card prints one behind
    // "YouTube 검색어:" (matched above), but the model also drops a bare
    // backticked query into playback sentences ("다음 턴에 `aespa ... MV`
    // 열어줄게") -- the turn the reported loop stalled on, which quoted the pick
    // nowhere else. That string is the query verbatim, more exact than a title
    // quoted beside it, so it wins over the quote scan below.
    //
    // Backticks carry code far more often than picks in Aoi's messages, and a
    // path or command becoming a "pick" would search YouTube for a filename, so
    // code-shaped candidates are dropped rather than ranked.
    const backticked = [...content.matchAll(/`([^`\n]{2,})`/g)]
      .map((match) => match[1].trim())
      .filter(
        (candidate) =>
          candidate &&
          !MUSIC_DEFERRAL_PRONOUN_PATTERN.test(candidate) &&
          !MUSIC_CODE_LIKE_PATTERN.test(candidate),
      );
    push(backticked[backticked.length - 1]);

    const quoted = [...content.matchAll(/["“]([^"”\n]{2,})["”]/gu)]
      .map((match) => match[1].trim())
      .filter((candidate) => candidate && !MUSIC_DEFERRAL_PRONOUN_PATTERN.test(candidate));
    push(quoted[quoted.length - 1]);
  }

  return picks;
}

function recentAssistantMessages(
  history: Pick<ChatMessage, 'role' | 'content'>[],
  limit: number,
): string[] {
  return [...history]
    .reverse()
    .filter((message) => message.role === 'assistant')
    .slice(0, limit)
    .map((message) => message.content);
}

function findRecommendedMusicPick(
  history: Pick<ChatMessage, 'role' | 'content'>[],
): RecommendedMusicPick | null {
  for (const content of recentAssistantMessages(history, 3)) {
    const pick = collectMusicPicksFromMessage(content)[0];
    if (pick) {
      return { query: pick, source: content };
    }
  }
  return null;
}

/**
 * Every pick still on the table, newest first, for the intent classifier to
 * choose between.
 *
 * The classifier is told to pick an id from this list rather than write a query,
 * so a wrong answer can only ever be the wrong pick from the conversation --
 * never a string the model made up. `context` is the message the pick came from,
 * which the classifier also needs: the card names the pick in the script the
 * user is reading while the query can be the real upload title in another one.
 */
export interface MusicPickCandidate {
  id: number;
  query: string;
  context: string;
}

export function collectMusicPickCandidates(
  history: Pick<ChatMessage, 'role' | 'content'>[],
  { messageLimit = 2, max = 4 }: { messageLimit?: number; max?: number } = {},
): MusicPickCandidate[] {
  const candidates: MusicPickCandidate[] = [];
  const seen = new Set<string>();
  for (const content of recentAssistantMessages(history, messageLimit)) {
    for (const query of collectMusicPicksFromMessage(content)) {
      const key = query.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({ id: candidates.length + 1, query, context: content });
      if (candidates.length >= max) {
        return candidates;
      }
    }
  }
  return candidates;
}

function extractRecommendedMusicQuery(
  history: Pick<ChatMessage, 'role' | 'content'>[],
): string | null {
  return findRecommendedMusicPick(history)?.query ?? null;
}

// Words that are nothing but "yes". They rank as consent ONLY on a turn that
// answers Aoi asking to confirm a pick (see isMusicPickConfirmationIntent) --
// on their own they name no music at all.
const MUSIC_CONFIRMATION_WORDS = new Set([
  '응',
  '어',
  '엉',
  '웅',
  'ㅇㅇ',
  'ㅇㅋ',
  '넵',
  '넹',
  '네',
  '예',
  '맞아',
  '맞아요',
  '맞지',
  '맞음',
  '그래',
  '그럼',
  '그렇지',
  '좋아',
  '좋지',
  '오케이',
  '오키',
  '콜',
  '굿',
  '그거',
  '그거야',
  '그걸로',
  'ok',
  'okay',
  'yes',
  'yeah',
  'yep',
  'yup',
  'sure',
  'right',
  'correct',
  'exactly',
  'it',
  'that',
]);

// At most two of those words. A third word means the message says something
// past "yes", and consent must not be read out of a sentence we did not parse.
const MAX_CONFIRMATION_WORDS = 2;

// English says yes in several words at once. Collapsed to one before the count
// above, so "yeah that's right" is still a bare confirmation while "yeah but
// later" is not.
const CONFIRMATION_PHRASE_PATTERN = /\bthat(?:'?s|\s+is)\s+(?:right|it|correct|the\s+one)\b/i;

function isBareConfirmation(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/[.!?~ㅋㅎ]+$/u, '')
    .replace(CONFIRMATION_PHRASE_PATTERN, 'right')
    .trim();
  if (!normalized || normalized.length > 24) {
    return false;
  }
  const words = normalized.split(/[\s,]+/u).filter(Boolean);
  if (words.length === 0 || words.length > MAX_CONFIRMATION_WORDS) {
    return false;
  }
  return words.every((word) => MUSIC_CONFIRMATION_WORDS.has(word.toLowerCase()));
}

// Aoi asking the user to confirm before playing: "이거 틀어줄까?", "그거 맞는
// 거지? 확인만 해줘", and the deferral wording this was reported for ("다음 턴에
// ... 열어줄게"). A bare "응" means play only when it answers one of these.
const MUSIC_CONFIRM_ASK_PATTERNS: readonly RegExp[] = [
  /(?:틀어줄까|틀까|틀어도\s*될까|틀어도\s*돼|재생할까|재생해줄까|열어줄까|들려줄까|플레이할까|이걸로\s*갈까|그걸로\s*갈까)/u,
  /(?:맞지|맞는\s*거\s*지|맞나|맞아\?|맞는지|확인만|확인해\s*줘)/u,
  /다음\s*턴/u,
  /\b(?:want\s+me\s+to\s+play|should\s+i\s+play|shall\s+i\s+play|is\s+that\s+(?:right|the\s+one)|confirm)\b/i,
];

// The ask has to be about music. A confirm question about anything else must
// never be answered by starting playback.
const MUSIC_CONFIRM_TOPIC_PATTERN =
  /(?:유튜브|youtube|노래|음악|곡|플레이리스트|틀어|틀었|재생|플레이|\btrack\b|\bsong\b|\bmusic\b|\bplay(?:ing|ed|s)?\b)/i;

/**
 * True when the user is confirming the pick Aoi asked them to confirm.
 *
 * This is the turn the reported loop died on: Aoi asked "그거 맞는 거지? 확인만
 * 해줘", the user answered "응 맞아", nothing matched, and the turn reached the
 * LLM with no app tools -- which promised playback for the next turn again, and
 * again. Consent is only read when the PREVIOUS assistant turn both asked for it
 * and carries a pick that resolves, so a bare "응" anywhere else is still left to
 * the conversation.
 */
export function isMusicPickConfirmationIntent(
  text: string,
  history: Pick<ChatMessage, 'role' | 'content'>[] = [],
): boolean {
  if (!isBareConfirmation(text)) {
    return false;
  }
  const content = [...history].reverse().find((message) => message.role === 'assistant')?.content;
  if (!content || !MUSIC_CONFIRM_TOPIC_PATTERN.test(content)) {
    return false;
  }
  if (!MUSIC_CONFIRM_ASK_PATTERNS.some((pattern) => pattern.test(content))) {
    return false;
  }
  // Only the immediately preceding turn counts: a confirmation answers the
  // question that was just asked, not a pick from three turns back.
  return extractRecommendedMusicQuery([{ role: 'assistant', content }]) !== null;
}

// Words of a query, for the offer-selection check below. Quotes, brackets and
// punctuation are dropped so a typed "KISS N TELL" and the offer's
// "aespa 'KISS N TELL' MV" compare on words alone.
function musicQueryWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[`'"“”‘’()[\]{}<>|.,!?~\-–—:;/]+/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);
}

// Below this, a typed fragment is too weak to prove it selects the offer.
const MIN_OFFER_SELECTION_CHARS = 3;

// How many words before the quoted title count as naming it. The card writes the
// artist directly in front of the title it quotes ("에스파 \"KISS N TELL\""), so a
// short window is enough to alias across scripts.
//
// It has to be short. Taking the whole message up to the first alternative marker
// let a card that mentions another artist in passing -- "뉴진스도 좋지만 오늘은
// 에스파 \"KISS N TELL\" 어때?" -- resolve "뉴진스로 가자" to the aespa query,
// which is the exact substitution this function exists to prevent. Sentence
// splitting does not help either: both artists are in the same sentence there.
// Two, not more: the card writes the artist immediately in front of the title, and
// every extra word widens the window back into preamble that can name someone
// else. Two still covers the "에스파의 신곡 \"...\"" shape. Anything inside the
// window CAN resolve -- that is the design, not a defect -- so the window is kept
// as small as the phrasings allow.
const MUSIC_ALIAS_WORDS_BEFORE_TITLE = 2;

/**
 * Resolve a typed fragment that NAMES part of the pick Aoi just offered back to
 * that offer's exact query.
 *
 * "에스파로 가자", right after Aoi offered 에스파 "KISS N TELL" together with its
 * search query, selects that offer -- it is not a new search. Searching the
 * fragment alone is what played an unrelated variety-show episode: a bare artist
 * name ranks whatever YouTube favors that day, while the offer already carried
 * "aespa 에스파 'KISS N TELL' MV".
 *
 * Only the recovered query is compared, never the whole card, so the alternative
 * Aoi names in the same breath ("아니면 프로미스나인 쪽으로 갈까?") cannot be
 * upgraded into the pick the user just passed over.
 */
function resolveOfferSelectionQuery(
  query: string,
  history: Pick<ChatMessage, 'role' | 'content'>[],
): string {
  const typed = musicQueryWords(query);
  if (typed.length === 0 || typed.join('').length < MIN_OFFER_SELECTION_CHARS) {
    return query;
  }

  const pick = findRecommendedMusicPick(history);
  const offerWords = pick ? musicQueryWords(pick.query) : [];
  if (!pick || offerWords.length <= typed.length) {
    // Nothing to gain when there is no offer, or the user already typed as much
    // as it holds.
    return query;
  }

  // EVERY typed word has to appear in the offer. "에스파 신곡" asks for something
  // other than the offered "KISS N TELL", so it stays a real search; "에스파"
  // alone is that offer, narrowed.
  if (matchesEveryWord(typed, offerWords.join(' '))) {
    return pick.query;
  }

  // The query Aoi prints is the real upload title, which is often in a different
  // script than the one she just spoke: the stored pick for this very case is
  // "aespa エスパ 'KISS N TELL' MV" while the card says 에스파. Typing 에스파 then
  // matches nothing above, which is the reported bug still live for every
  // mixed-script pick.
  //
  // The card's own prose is the alias table -- it names the pick in the script the
  // user is reading, immediately before the title it quotes -- so only those few
  // words are consulted.
  const alias = offerAliasWords(pick.source);
  return alias.length > 0 && matchesEveryWord(typed, alias.join(' ')) ? pick.query : query;
}

/**
 * The words Aoi used directly in front of the title she quoted.
 *
 * This is where the card names the pick in the reader's own script, which is what
 * makes a cross-script selection resolvable. Everything earlier in the message is
 * preamble and may name a different artist entirely, so it is left out.
 */
function offerAliasWords(source: string): string[] {
  const quoted = source.search(/["“`]/u);
  if (quoted <= 0) {
    return [];
  }
  return musicQueryWords(source.slice(0, quoted)).slice(-MUSIC_ALIAS_WORDS_BEFORE_TITLE);
}

function matchesEveryWord(typed: readonly string[], haystack: string): boolean {
  return typed.every((word) => haystack.includes(word));
}

// Conversational lead-in the extraction patterns hand over INSIDE the query,
// because the pattern only anchors on the playback verb at the end: "응 그런데
// 다른거로 해줘" yields "응 그런데 다른거", which was searched on YouTube verbatim.
//
// Split into two classes, because dropping them all unconditionally cut the first
// word off real titles -- "그래서 그대는" became "그대는", "네 생각" became "생각".
// Pure interjections never open a title and always go. The rest can, so they are
// only dropped when they follow an interjection ("응 그런데 에스파로 가자") or when
// nothing searchable is left behind them ("그래 틀어줘", "근데 다른거로 해줘").
const MUSIC_INTERJECTION_LEAD_INS = new Set([
  '응',
  '어',
  '엉',
  '웅',
  'ㅇㅇ',
  'ㅇㅋ',
  '넵',
  '오케이',
  '오키',
  // "아니" opens a refusal, not a title. Leaving it ambiguous meant "아니 아니
  // 틀어줘" kept both words and searched for them.
  '아니',
  '아니야',
]);
const MUSIC_AMBIGUOUS_LEAD_INS = new Set(['네', '그래', '그럼', '그래서', '근데', '그런데']);
// Each has to be followed by a separator or end the fragment, so a title that
// merely starts with the same syllables ("어디에도", "네가 좋아") is left alone.
const MUSIC_LEAD_IN_WORD_PATTERN = /^(\S+?)(?:[\s,]+|$)/u;
const MAX_LEAD_IN_WORDS = 3;

// Asks for SOMETHING ELSE instead of naming it. Searching these literally is how
// "다른거로 해줘" became a YouTube search for "다른거"; recovering the last pick
// instead would replay the very thing being refused, so both are wrong and the
// conversation has to choose the next pick.
const MUSIC_PLACEHOLDER_REQUEST_PATTERN =
  /^(?:다른\s*(?:거|것|걸|곡|노래|음악)?|딴\s*(?:거|것|걸|곡|노래)?|아무\s*(?:거나|것|노래|곡)?|뭐(?:든|든지)?|알아서|추천(?:해줘|해)?|something\s+else|another\s+(?:one|song|track)|anything)$/u;

// Nothing a search can be run against: a pronoun pointing back at something
// already said, or a request for "something else" that names nothing.
function isUnsearchableRequest(value: string): boolean {
  return (
    MUSIC_DEFERRAL_PRONOUN_PATTERN.test(value) || MUSIC_PLACEHOLDER_REQUEST_PATTERN.test(value)
  );
}

function stripMusicQueryLeadIn(value: string, { force = false } = {}): string {
  let rest = value.trim();
  let afterInterjection = false;
  for (let dropped = 0; dropped < MAX_LEAD_IN_WORDS && rest; dropped += 1) {
    const match = rest.match(MUSIC_LEAD_IN_WORD_PATTERN);
    const word = match?.[1];
    if (!match || !word) {
      break;
    }
    const isInterjection = MUSIC_INTERJECTION_LEAD_INS.has(word);
    if (!isInterjection && !MUSIC_AMBIGUOUS_LEAD_INS.has(word)) {
      break;
    }
    const remainder = rest.slice(match[0].length).trim();
    // An ambiguous word standing at the front of something searchable IS the
    // title's first word, not filler -- unless the caller is retrying on the
    // assumption that it was filler after all (see buildDirectMusicIntent).
    if (
      !force &&
      !isInterjection &&
      !afterInterjection &&
      remainder &&
      !isUnsearchableRequest(remainder)
    ) {
      break;
    }
    afterInterjection = afterInterjection || isInterjection;
    rest = remainder;
  }
  return rest;
}

function buildDirectMusicIntent(
  rawQuery: string,
  exclude: string[],
  rejected: boolean,
  history: Pick<ChatMessage, 'role' | 'content'>[],
): DirectMusicIntent | null {
  const named = stripMusicQueryLeadIn(rawQuery);
  if (!named || MUSIC_DEFERRAL_PRONOUN_PATTERN.test(named)) {
    // Playback was asked for, but nothing was named ("그래 틀어줘", "그거 틀어
    // 줘"). Resolve against the pick Aoi already named -- except after a
    // rejection ("그거 말고 다시 틀어줘"), where recovering that pick would replay
    // exactly what was refused.
    if (rejected) {
      return null;
    }
    const recovered = extractRecommendedMusicQuery(history);
    return recovered ? { query: recovered } : null;
  }
  if (MUSIC_PLACEHOLDER_REQUEST_PATTERN.test(named)) {
    return null;
  }
  const enriched = enrichMusicQueryFromHistory(named, history);
  // A rejection steers AWAY from the last card, so that card's query must not be
  // pulled back in as the "selection".
  if (rejected) {
    return { query: enriched, ...(exclude.length > 0 ? { exclude } : {}) };
  }
  const resolved = resolveOfferSelectionQuery(enriched, history);
  if (resolved !== enriched) {
    return { query: resolved, ...(exclude.length > 0 ? { exclude } : {}) };
  }

  // The conservative strip above keeps an ambiguous lead-in whenever something
  // searchable follows it, which is right for "그래서 그대는" and wrong for
  // "그래 에스파" -- there the kept word is what stopped the offer from resolving.
  // Retry once with it dropped, and prefer that ONLY if it resolves to a pick. A
  // miss changes nothing, so a real title never loses its first word.
  const forced = stripMusicQueryLeadIn(rawQuery, { force: true });
  if (forced && forced !== named && !isUnsearchableRequest(forced)) {
    const forcedEnriched = enrichMusicQueryFromHistory(forced, history);
    const forcedResolved = resolveOfferSelectionQuery(forcedEnriched, history);
    if (forcedResolved !== forcedEnriched) {
      return { query: forcedResolved, ...(exclude.length > 0 ? { exclude } : {}) };
    }
  }
  return { query: enriched, ...(exclude.length > 0 ? { exclude } : {}) };
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
  // A bare "응 / 맞아" answering Aoi's own "그거 맞지?" resolves the same way: it
  // consents to a pick already named in the turn above, so the query comes from
  // there, not from the word "응".
  if (
    /^(?:네가|니가|너가)\s*골라[줘]?$/u.test(trimmed) ||
    /^(?:그걸로|이걸로|추천대로)\s*(?:가자|해줘|하자)?$/u.test(trimmed) ||
    isDeferredMusicPlaybackIntent(trimmed) ||
    isMusicPickConfirmationIntent(trimmed, history)
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
    const { query, exclude, rejected } = cleanRequestedMusicQuery(match?.groups?.query ?? '');
    if (query) {
      return buildDirectMusicIntent(query, exclude, rejected, history);
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
    const { query, exclude, rejected } = cleanRequestedMusicQuery(match?.groups?.query ?? '');
    if (query) {
      return buildDirectMusicIntent(query, exclude, rejected, history);
    }
  }

  return null;
}
