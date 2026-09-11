// A playback request is read by the turn classifier before anything plays.
//
// The direct music parser used to own the whole sentence: everything in front
// of "틀어줘" became the YouTube query, so "에스파 내가 좋아하는 노래 틀어줘" searched
// for the literal words "에스파 내가 좋아하는" while the taste memory held the
// aespa track the user had actually played. Reading "the one I like" is language,
// and language belongs to the model; this module only does the mechanics once
// the classifier has said what kind of request it is:
//
//   * a literal title or artist  -> search exactly those words
//   * a reference to taste       -> the newest remembered user play by that
//                                   artist, or the artist alone when none is
//                                   remembered, with an ack that says which
//   * something that is not a playback request at all -> hand the turn to the
//                                   model instead of playing a misread
//
// No pattern in here reads the user's words. The alias table is data about
// artist names (에스파 / aespa / エスパ are one group), not a parser.

import type { DirectMusicIntent } from './chatDirectActions';
import type { AoiMusicTasteState } from './aoiMusicTaste';
import type { AoiTurnUnderstanding } from './aoiTurnUnderstanding';

// One row per act: every spelling the user or a video title might use. Latin
// aliases match on token boundaries (so "ive" cannot match "love dive"); Hangul
// and kana aliases match as substrings, which is how they appear in titles.
const ARTIST_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['에스파', 'aespa', 'エスパ'],
  ['프로미스나인', '프로미스 나인', 'fromis_9', 'fromis9', 'fromis 9'],
  ['뉴진스', 'newjeans', 'new jeans'],
  ['아이브', 'ive'],
  ['르세라핌', 'le sserafim', 'lesserafim'],
  ['블랙핑크', 'blackpink', 'black pink'],
  ['트와이스', 'twice'],
  ['아이유', 'iu'],
  ['방탄소년단', '방탄', 'bts'],
  ['세븐틴', 'seventeen', 'svt'],
  ['엔믹스', 'nmixx'],
  ['있지', 'itzy'],
  ['스테이씨', 'stayc'],
  ['키스오브라이프', '키오프', 'kiss of life', 'kissoflife', 'kiof'],
  ['베이비몬스터', '베몬', 'babymonster', 'baby monster'],
  ['아일릿', 'illit'],
  ['트리플에스', 'triples', 'triple s'],
  ['엔하이픈', 'enhypen'],
  ['투모로우바이투게더', '투바투', 'txt', 'tomorrow x together'],
  ['라이즈', 'riize'],
  ['보이넥스트도어', 'boynextdoor', 'boy next door'],
  ['제로베이스원', 'zerobaseone', 'zb1'],
  ['스트레이키즈', '스트레이 키즈', '스키즈', 'stray kids', 'straykids', 'skz'],
  ['에이티즈', 'ateez'],
  ['여자아이들', '(여자)아이들', '아이들', '(g)i-dle', 'g-idle', 'gidle', 'i-dle', 'idle'],
  ['레드벨벳', 'red velvet', 'redvelvet'],
  ['소녀시대', "girls' generation", 'girls generation', 'snsd'],
  ['샤이니', 'shinee'],
  ['엑소', 'exo'],
  ['엔시티', 'nct'],
  ['데이식스', 'day6'],
  ['악뮤', 'akmu'],
  ['태연', 'taeyeon'],
  ['청하', 'chung ha', 'chungha'],
  ['선미', 'sunmi'],
  ['마마무', 'mamamoo'],
  ['오마이걸', 'oh my girl', 'ohmygirl'],
  ['빅뱅', 'bigbang', 'big bang'],
  ['지드래곤', 'g-dragon', 'gdragon'],
  ['트레저', 'treasure'],
  ['더보이즈', 'the boyz', 'theboyz'],
  ['플레이브', 'plave'],
  ['피프티피프티', 'fifty fifty', 'fiftyfifty'],
  ['하츠투하츠', 'hearts2hearts', 'hearts to hearts'],
  ['카리나', 'karina'],
  ['윈터', 'winter'],
  ['장원영', 'jang wonyoung', 'wonyoung'],
];

const HANGUL_PATTERN = /[가-힣]/u;
const KANA_PATTERN = /[぀-ヿ]/u;

function normalizeSpelling(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’“”'"`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokensOf(value: string): string[] {
  return normalizeSpelling(value).split(' ').filter(Boolean);
}

function includesTokenSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

/**
 * Every spelling to look for when the user named `target`: the target itself
 * plus the rest of its alias group when it belongs to one.
 */
export function expandArtistAliases(target: string): string[] {
  const wanted = normalizeSpelling(target).replace(/\s+/g, '');
  if (!wanted) {
    return [];
  }
  const aliases = new Set<string>([target.trim()]);
  for (const group of ARTIST_ALIAS_GROUPS) {
    if (group.some((alias) => normalizeSpelling(alias).replace(/\s+/g, '') === wanted)) {
      for (const alias of group) {
        aliases.add(alias);
      }
    }
  }
  return [...aliases];
}

/**
 * The known act named inside `text`, when one is: the classifier's target can
 * carry more than the artist ("에스파 내가 좋아하는 노래"), and the alias table is
 * what recognises the act in it. Latin aliases match whole tokens; Hangul and
 * kana aliases match at the start of a token, so a particle ("에스파의") does not
 * hide the name and a name inside another word does not invent one.
 */
export function findKnownArtistIn(text: string): string | null {
  const normalized = normalizeSpelling(text);
  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  for (const group of ARTIST_ALIAS_GROUPS) {
    for (const alias of group) {
      const aliasNormalized = normalizeSpelling(alias);
      if (!aliasNormalized) {
        continue;
      }
      if (HANGUL_PATTERN.test(alias) || KANA_PATTERN.test(alias)) {
        const compactAlias = aliasNormalized.replace(/\s+/g, '');
        if (tokens.some((token) => token.startsWith(compactAlias))) {
          return alias;
        }
        continue;
      }
      if (includesTokenSequence(tokens, tokensOf(alias))) {
        return alias;
      }
    }
  }
  return null;
}

/** Whether a remembered play label is by the artist the user named. */
export function playMatchesArtist(playLabel: string, target: string): boolean {
  const labelNormalized = normalizeSpelling(playLabel);
  const labelCompact = labelNormalized.replace(/\s+/g, '');
  const labelTokens = labelNormalized.split(' ').filter(Boolean);
  for (const alias of expandArtistAliases(target)) {
    const normalized = normalizeSpelling(alias);
    if (!normalized) {
      continue;
    }
    if (HANGUL_PATTERN.test(alias) || KANA_PATTERN.test(alias)) {
      if (labelCompact.includes(normalized.replace(/\s+/g, ''))) {
        return true;
      }
      continue;
    }
    if (includesTokenSequence(labelTokens, tokensOf(alias))) {
      return true;
    }
  }
  return false;
}

/**
 * The searchable part of a remembered play label: the title, without the
 * " - channel" suffix the capture appends.
 */
export function playLabelToQuery(label: string): string {
  const dashSplit = label.trim().match(/^(.+)\s+[-–—]\s+.+$/u);
  return (dashSplit ? dashSplit[1] : label).trim();
}

// A remembered label that is contained in the present request is not a song:
// it is the search the same words ran last time (the literal "에스파 내가 좋아하는"
// this module exists to stop), recorded as a play when its result autoplayed.
function isEchoOfRequest(label: string, requestQuery: string | undefined): boolean {
  if (!requestQuery) {
    return false;
  }
  const labelNormalized = normalizeSpelling(label);
  return labelNormalized.length > 0 && normalizeSpelling(requestQuery).includes(labelNormalized);
}

export type AoiPreferredMusicResolution =
  | { kind: 'remembered_play'; query: string; play: string; target: string | null }
  | { kind: 'artist_fallback'; query: string; target: string }
  | { kind: 'no_memory' };

/**
 * What "the one I like" means given the taste memory: the newest user-initiated
 * play by the named artist; without a name, the newest play of all; when the
 * artist has no remembered play, the artist itself as the search; and when
 * nothing is remembered at all, no answer -- the caller then recommends from
 * the taste profile instead of searching the user's words.
 */
export function resolveAoiPreferredMusicPlay(
  state: AoiMusicTasteState | null | undefined,
  target: string | null,
  options: { requestQuery?: string } = {},
): AoiPreferredMusicResolution {
  const plays = (state?.recentPlays ?? []).filter(
    (play) => !isEchoOfRequest(play, options.requestQuery),
  );
  const cleanTarget = target?.trim() || null;
  if (cleanTarget) {
    const match = plays.find((play) => playMatchesArtist(play, cleanTarget));
    if (match) {
      return {
        kind: 'remembered_play',
        query: playLabelToQuery(match),
        play: match,
        target: cleanTarget,
      };
    }
    // The target may carry more than the act ("에스파 내가 좋아하는 노래"); the act
    // inside it is what the memory is keyed on.
    const known = findKnownArtistIn(cleanTarget);
    if (known && normalizeSpelling(known) !== normalizeSpelling(cleanTarget)) {
      const knownMatch = plays.find((play) => playMatchesArtist(play, known));
      if (knownMatch) {
        return {
          kind: 'remembered_play',
          query: playLabelToQuery(knownMatch),
          play: knownMatch,
          target: known,
        };
      }
      return { kind: 'artist_fallback', query: known, target: known };
    }
    return { kind: 'artist_fallback', query: cleanTarget, target: cleanTarget };
  }
  if (plays.length > 0) {
    return {
      kind: 'remembered_play',
      query: playLabelToQuery(plays[0]),
      play: plays[0],
      target: null,
    };
  }
  return { kind: 'no_memory' };
}

export type AoiDirectMusicDecision =
  | { kind: 'play_literal'; intent: DirectMusicIntent }
  | { kind: 'play_remembered'; intent: DirectMusicIntent; play: string; target: string | null }
  | { kind: 'play_artist_fallback'; intent: DirectMusicIntent; target: string }
  | { kind: 'taste_recommend' }
  | { kind: 'defer_to_model'; reason: string };

/**
 * Decide what a typed playback request should do, from the classifier's
 * reading. A null reading (classifier off, timed out, refused) keeps the parser's
 * literal query, which is exactly what happened before this existed.
 */
export function decideAoiDirectMusicPlayback(params: {
  typed: DirectMusicIntent;
  understanding: AoiTurnUnderstanding | null;
  tasteState: AoiMusicTasteState | null | undefined;
}): AoiDirectMusicDecision {
  const { typed, understanding } = params;
  if (!understanding) {
    return { kind: 'play_literal', intent: typed };
  }
  // The parser's playback verb can sit inside a sentence that is not a request
  // to play anything: "틀어" in a question about last night, "...으로 해줘" about a
  // file. A confident reading that names no app family and is either not a
  // request at all or a request for some other family sends the turn to the
  // model rather than playing a misread. Medium confidence does not: the
  // parser's judgement is the floor.
  const conversational =
    understanding.kind === 'question' ||
    understanding.kind === 'chitchat' ||
    understanding.kind === 'meta';
  const namesOtherFamily = understanding.families.some((family) => family !== 'none');
  if (
    understanding.confidence === 'high' &&
    !understanding.families.includes('app') &&
    understanding.musicReference !== 'taste' &&
    (conversational || namesOtherFamily)
  ) {
    return {
      kind: 'defer_to_model',
      reason: `${understanding.kind}/${understanding.confidence}/${understanding.families.join('+')}`,
    };
  }
  if (understanding.musicReference === 'taste') {
    // A target that is the whole of the parser's query isolated nothing ("내가
    // 좋아하는 곡" copied back); it names no artist and is read as none.
    const rawTarget = understanding.musicTarget?.trim() ?? '';
    const target =
      rawTarget.length > 0 && normalizeSpelling(rawTarget) !== normalizeSpelling(typed.query)
        ? rawTarget
        : null;
    const resolution = resolveAoiPreferredMusicPlay(params.tasteState, target, {
      requestQuery: typed.query,
    });
    if (resolution.kind === 'remembered_play') {
      return {
        kind: 'play_remembered',
        intent: {
          query: resolution.query,
          ...(typed.exclude?.length ? { exclude: typed.exclude } : {}),
        },
        play: resolution.play,
        target: resolution.target,
      };
    }
    if (resolution.kind === 'artist_fallback') {
      return {
        kind: 'play_artist_fallback',
        intent: {
          query: resolution.query,
          ...(typed.exclude?.length ? { exclude: typed.exclude } : {}),
        },
        target: resolution.target,
      };
    }
    return { kind: 'taste_recommend' };
  }
  // A literal request: the parser's query stands. The classifier's target is not
  // used for the search: measured on the corpus (2026-09-11, qwen3.7-flash) it
  // dropped the artist on half the literal cases ("에스파 KISS N TELL 틀어줘" ->
  // "KISS N TELL"), which is the failure the subsumes-pick rule in
  // chatDirectActions exists to prevent. The slots decide WHAT KIND of request
  // this is; the words the user typed decide what is searched.
  return { kind: 'play_literal', intent: typed };
}

function quoteTitle(value: string): string {
  return `"${value}"`;
}

/**
 * The ack for a taste-resolved play. It names the memory it used, so a wrong
 * pick is visible and correctable, and when nothing was remembered it says so
 * and asks for the song to remember next time.
 */
export function buildAoiPreferredMusicAck(params: {
  lang: string;
  decision: Extract<AoiDirectMusicDecision, { kind: 'play_remembered' | 'play_artist_fallback' }>;
  startedTitle: string | null;
}): string {
  const { decision, startedTitle } = params;
  const lang =
    params.lang === 'ko' ? 'ko' : params.lang === 'ja' ? 'ja' : params.lang === 'zh' ? 'zh' : 'en';
  if (decision.kind === 'play_remembered') {
    const shown = quoteTitle(startedTitle ?? decision.intent.query);
    const who = decision.target;
    switch (lang) {
      case 'ko':
        return who
          ? `전에 네가 들었던 ${who} 곡으로 ${shown} 틀었어. 다른 곡이 좋았으면 말해줘.`
          : `전에 네가 들었던 ${shown} 틀었어. 다른 곡이 좋았으면 말해줘.`;
      case 'ja':
        return who
          ? `前に聴いていた${who}の曲 ${shown} をかけたよ。違う曲なら教えて。`
          : `前に聴いていた ${shown} をかけたよ。違う曲なら教えて。`;
      case 'zh':
        return who
          ? `放了你之前听过的${who}的歌 ${shown}。想听别的就告诉我。`
          : `放了你之前听过的 ${shown}。想听别的就告诉我。`;
      default:
        return who
          ? `Playing ${shown}, the ${who} track you played before. Tell me if you meant a different one.`
          : `Playing ${shown}, which you played before. Tell me if you meant a different one.`;
    }
  }
  const who = decision.target;
  const shown = startedTitle ? ` ${quoteTitle(startedTitle)}` : '';
  switch (lang) {
    case 'ko':
      return `기억해 둔 ${who} 곡이 없어서 ${quoteTitle(who)}로 찾아서${shown} 틀었어. 좋아하는 곡 알려주면 다음엔 그걸로 틀게.`;
    case 'ja':
      return `${who}で覚えている曲がなかったので ${quoteTitle(who)} で探して${shown} かけたよ。好きな曲を教えてくれたら次はそれをかけるね。`;
    case 'zh':
      return `没有记住你喜欢的${who}的歌，所以按 ${quoteTitle(who)} 搜了${shown} 来放。告诉我你喜欢哪首，下次就放它。`;
    default:
      return `I have no ${who} track remembered for you, so I searched ${quoteTitle(who)} and started${shown || ' it'}. Tell me the one you like and I will play that next time.`;
  }
}
