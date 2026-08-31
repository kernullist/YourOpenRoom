// Rebuild Aoi's pending nudge offers from the restored chat transcript.
//
// Every nudge card (idle music, cyber news, taste poll, preference poll) is
// persisted server-side in chat.json together with its reply chips, but the
// pending offer that gives those chips meaning lives in this browser's
// localStorage. Open the room in another browser profile, from another
// dev-server origin, or after clearing site data and the card comes back with
// its chips while the offer behind them is gone. A tapped chip then misses its
// direct-action path entirely: at best nothing happens, at worst it reaches the
// LLM, which reports an action it never performed.
//
// Recovery reads the transcript rather than syncing the offer to the server on
// purpose. The transcript is already the shared copy, it is restored before the
// chips can be tapped, and it needs no hydrate round trip that a fast tap could
// race.
//
// Cards are identified by their message id prefix (stable, persisted) rather
// than by matching prose, so localized copy can change without silently
// breaking recovery. Everything else is matched across ALL languages: the user
// may have switched language between the card and the tap.

import type { AoiDayPhase, AoiMusicMood } from './aoiMusicRecommendation';
import { AOI_MUSIC_MOODS } from './aoiMusicRecommendation';
import type { AoiNewsCandidate } from './aoiNewsNudge';
import type {
  PendingIdleMusicOffer,
  PendingNewsOffer,
  PendingPreferencePoll,
  PendingTastePoll,
} from './aoiPendingOffers';
import { TASTE_POLL_QUESTIONS } from './aoiMusicTaste';
import { PREFERENCE_POLL_QUESTIONS, type PreferencePollQuestion } from './aoiPreferencePoll';

export type NudgeCardLang = 'ko' | 'ja' | 'zh' | 'en';

export const NUDGE_CARD_LANGS: readonly NudgeCardLang[] = ['ko', 'ja', 'zh', 'en'];

// The idle-music card's opening line, in two halves.
//
// It used to be one mood-keyed sentence, which quietly made the card lie about
// the clock: the mood is only NUDGED by the time of day (+1) and an upbeat
// taste bias outvotes it, so a 3pm card opened with "just starting your day".
// The observation half is keyed by the real day phase and the offer half by the
// mood, so each states only what it actually knows.
//
// Shared with the card builder in ChatPanel so the reverse lookup below can
// never drift from the copy the user saw -- there is exactly one table of each.
// The halves concatenate to the exact sentence the old table held for the
// matching phase, so cards already in a transcript still read the same and
// still resolve.
export const IDLE_MUSIC_TIME_LINES: Record<NudgeCardLang, Record<AoiDayPhase, string>> = {
  ko: {
    morning: '이제 하루 시작하는 참이네.',
    working: '한참 집중하고 있었네.',
    evening: '잠깐 여유로운 시간이네.',
    late: '늦은 시간이라 조용하네.',
  },
  ja: {
    morning: '一日の始まりだね。',
    working: 'ずっと集中してたね。',
    evening: '少し落ち着いた時間だね。',
    late: '夜も遅くて静かだね。',
  },
  zh: {
    morning: '正是开始一天的时候。',
    working: '你已经专注很久了。',
    evening: '看起来是个放松的时刻。',
    late: '夜深人静。',
  },
  en: {
    morning: 'Starting up for the day.',
    working: 'You have been heads-down for a while.',
    evening: 'Looks like a quieter moment.',
    late: 'Late and quiet.',
  },
};

// The offer half, keyed by mood. Also the reverse-lookup key: it is the only
// part of the line the mood decides, and it survived the split unchanged, so it
// matches legacy cards too.
export const IDLE_MUSIC_MOOD_OFFERS: Record<NudgeCardLang, Record<AoiMusicMood, string>> = {
  ko: {
    focus: '작업하는 동안 집중용 음악 틀어줄까?',
    chill: '잔잔한 곡 하나 배경으로 깔아줄까?',
    upbeat: '기분 올릴 만한 곡 틀어줄까?',
    ambient: '은은한 사운드 하나 깔아줄까?',
  },
  ja: {
    focus: '作業の間、集中できる音楽をかけようか?',
    chill: 'ゆったりした曲を流そうか?',
    upbeat: '気分が上がる曲をかけようか?',
    ambient: '控えめなアンビエントを流そうか?',
  },
  zh: {
    focus: '要不要放点专注音乐陪你工作?',
    chill: '要不要放个轻松的背景音乐?',
    upbeat: '要来点带劲的音乐吗?',
    ambient: '要不要放点氛围音乐垫在下面?',
  },
  en: {
    focus: 'Want some focus music while you work?',
    chill: 'Want a chill mix in the background?',
    upbeat: 'Want something upbeat to get going?',
    ambient: 'Want some ambient sound to sit under the work?',
  },
};

// One idle-music card opening line: what the clock says, then what the mood
// offers. The only place the two halves are joined.
export function buildIdleMusicCardLine(
  dayPhase: AoiDayPhase,
  mood: AoiMusicMood,
  lang: NudgeCardLang,
): string {
  return `${IDLE_MUSIC_TIME_LINES[lang][dayPhase]} ${IDLE_MUSIC_MOOD_OFFERS[lang][mood]}`;
}

// Emoji vs text presentation selectors: invisible, and a chip label may or may
// not carry one depending on where it was rendered.
const VARIATION_SELECTORS = /[\uFE0E\uFE0F]/g;

// The news card's "interested" chip, in every language it is emitted in. Only
// the marked play chip needs recognizing: the dismiss chip is ordinary text,
// and letting that one fall through costs nothing because neither path claims
// an action. The play chip does claim one, so a tap that cannot be resolved has
// to be answered rather than handed to the LLM.
const NEWS_PLAY_CHIP_PATTERN = /^📰\s*(?:관심 있어|気になる|有兴趣|interested)\s*$/iu;

export function isAoiNewsPlayChip(text: string): boolean {
  // Strip variation selectors so an emoji-presentation marker still matches.
  const normalized = text.trim().replace(VARIATION_SELECTORS, '');
  return NEWS_PLAY_CHIP_PATTERN.test(normalized);
}

export type NudgeCardKind = 'idle-music' | 'news' | 'taste-poll' | 'preference-poll';

// Message id prefixes stamped by each nudge emitter. Every prefix must be
// unique; the scan below takes the first match.
const CARD_ID_PREFIXES: ReadonlyArray<{ prefix: string; kind: NudgeCardKind }> = [
  { prefix: 'aoi-idle-music-', kind: 'idle-music' },
  // The taste-backed re-roll card (the "another" chip, or a genre chip) is an
  // idle-music offer too: same chips, same consume path, different copy.
  { prefix: 'aoi-taste-music-', kind: 'idle-music' },
  { prefix: 'aoi-news-', kind: 'news' },
  { prefix: 'aoi-taste-poll-', kind: 'taste-poll' },
  { prefix: 'aoi-preference-poll-', kind: 'preference-poll' },
];

export interface NudgeCardMessage {
  id?: string;
  role?: string;
  content?: string;
  suggestedReplies?: string[];
}

export interface PendingNudgeCard {
  kind: NudgeCardKind;
  id: string;
  content: string;
  suggestedReplies: string[];
}

/**
 * Find the nudge card still awaiting an answer, or null when none is.
 *
 * Scans backwards and stops at the first user message: anything the user sent
 * after a card already consumed that offer (accept, dismiss, or implicit skip),
 * so recovering it would re-arm a card that is no longer live. Assistant
 * messages that are not nudge cards -- a self-observation posted after the
 * card, which deliberately leaves the chips in place -- are skipped over.
 */
export function identifyPendingNudgeCard(
  messages: readonly NudgeCardMessage[] | null | undefined,
): PendingNudgeCard | null {
  if (!messages?.length) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return null;
    }
    if (message?.role !== 'assistant') {
      continue;
    }
    const id = typeof message.id === 'string' ? message.id : '';
    const match = CARD_ID_PREFIXES.find((entry) => id.startsWith(entry.prefix));
    if (!match) {
      continue;
    }
    const suggestedReplies = (message.suggestedReplies ?? []).filter(
      (reply): reply is string => typeof reply === 'string' && reply.trim().length > 0,
    );
    // A card whose chips were dropped cannot be answered by tapping, so there is
    // nothing to recover.
    if (suggestedReplies.length < 2) {
      return null;
    }
    return {
      kind: match.kind,
      id,
      content: typeof message.content === 'string' ? message.content : '',
      suggestedReplies,
    };
  }
  return null;
}

// The recommended query as the music cards print it: every recommend card emits
// an explicit "YouTube search query" line, and the idle/taste cards also quote
// the pick after the note marker. The explicit line wins when both are present.
export function extractCardMusicQuery(content: string): string | null {
  const explicit = content.match(
    /YouTube\s*(?:검색어|search query|検索語|搜索词)\s*:\s*`([^`]+)`/i,
  )?.[1];
  if (explicit?.trim()) {
    return explicit.trim();
  }
  // Quoted form, greedy to the LAST quote on its line, so a pick whose own
  // title contains quotes is not cut at the first inner one.
  const quoted = content.match(/🎵[^\n"“]*["“](.+)["”]\s*$/mu)?.[1];
  return quoted?.trim() || null;
}

// Reverse lookup of the mood the card was built from. Null is a real answer,
// not a failure: the taste re-roll card carries no mood line, and guessing one
// would teach the mood-feedback model something the user never expressed.
export function extractCardMusicMood(content: string): AoiMusicMood | null {
  const firstLine = content.split('\n')[0]?.trim() ?? '';
  if (!firstLine) {
    return null;
  }
  // Containment, not equality: the observation half in front of the offer is
  // chosen by the clock, so it varies independently of the mood -- and a card
  // written before the split carries the old one-sentence form, which ends in
  // the same offer clause.
  for (const lang of NUDGE_CARD_LANGS) {
    for (const mood of AOI_MUSIC_MOODS) {
      if (firstLine.includes(IDLE_MUSIC_MOOD_OFFERS[lang][mood])) {
        return mood;
      }
    }
  }
  return null;
}

export function recoverIdleMusicOffer(card: PendingNudgeCard): PendingIdleMusicOffer | null {
  if (card.kind !== 'idle-music') {
    return null;
  }
  const query = extractCardMusicQuery(card.content);
  if (!query) {
    return null;
  }
  return {
    playPrompt: card.suggestedReplies[0],
    dismissPrompt: card.suggestedReplies[1],
    query,
    mood: extractCardMusicMood(card.content),
    // A card id with no stamp leaves the offer undateable, which reads as
    // stale: it still plays, it just stops counting as mood feedback.
    offeredAt: parseNudgeCardStamp(card.id) ?? 0,
  };
}

/**
 * Decide which idle-music offer to trust when both a stored one and a
 * transcript-derived one exist.
 *
 * Storage is per browser profile while the transcript is shared, so a browser
 * holding an unanswered offer for an older card can be looking at a newer card
 * posted from somewhere else. The chips are identical either way, so trusting
 * storage would silently play the previous card's pick: the card on screen
 * decides.
 *
 * When the two describe the same pick they are the same offer, and the pieces
 * are merged rather than one replacing the other. The card supplies the chip
 * labels, which must match what is currently rendered (the user may have
 * switched language since). Storage supplies the mood, which the re-roll card
 * does not print -- real information the card simply cannot carry.
 */
export function reconcileRecoveredIdleMusicOffer(
  recovered: PendingIdleMusicOffer | null,
  stored: PendingIdleMusicOffer | null,
  cardContent: string,
): PendingIdleMusicOffer | null {
  if (!recovered) {
    // Nothing could be read off the card, so the stored offer is only usable if
    // it describes what the user is looking at. Trusting it blind is how a chip
    // would play a pick the card never named -- the same unconditional fallback
    // that kept a dead news offer armed.
    return stored && cardContent.includes(stored.query) ? stored : null;
  }
  if (!stored || stored.query !== recovered.query) {
    return recovered;
  }
  return { ...recovered, mood: recovered.mood ?? stored.mood };
}

// The headline as the news card prints it: the intro, a colon, the quoted
// title, then the closing question. Greedy between the first and last quote so
// a headline containing quotes survives; intro and question never contain any.
/**
 * The emit timestamp encoded in a nudge card's message id (`<kind>-<epoch ms>`).
 *
 * Null when the id carries no stamp. Callers that need the offer's age must
 * treat that as "unknown", never as "just now".
 */
export function parseNudgeCardStamp(id: string): number | null {
  const stamp = Number(id.match(/-(\d{10,})$/)?.[1]);
  return Number.isFinite(stamp) && stamp > 0 ? stamp : null;
}

export function extractCardNewsTitle(content: string): string | null {
  const quoted = content.match(/["“]([\s\S]+)["”]/u)?.[1];
  return quoted?.trim() || null;
}

/**
 * Rebuild the news offer by matching the card's headline against the articles
 * currently on disk. The article id and category cannot come from the
 * transcript, and without them the chip could neither open the article nor
 * record which category the user is interested in.
 */
export function recoverNewsOffer(
  card: PendingNudgeCard,
  candidates: readonly AoiNewsCandidate[],
): PendingNewsOffer | null {
  if (card.kind !== 'news') {
    return null;
  }
  // The card id is the only record of when the offer was made once
  // localStorage is out of the picture, and a news offer has to be dateable:
  // the article behind it ages out of the live feed. Ageing is left to the
  // caller -- this stays a pure rebuilder -- but an undateable card cannot be
  // rebuilt at all.
  const offeredAt = parseNudgeCardStamp(card.id);
  if (offeredAt === null) {
    return null;
  }
  const title = extractCardNewsTitle(card.content);
  if (!title) {
    return null;
  }
  const exact = candidates.find((candidate) => candidate.title.trim() === title);
  // Fall back to containment for a headline the card reformatted; longest first
  // so a short title that is a prefix of a longer one cannot win.
  const contained = exact
    ? undefined
    : [...candidates]
        .filter((candidate) => candidate.title.trim() && card.content.includes(candidate.title))
        .sort((a, b) => b.title.length - a.title.length)[0];
  const article = exact ?? contained;
  if (!article) {
    return null;
  }
  return {
    playPrompt: card.suggestedReplies[0],
    dismissPrompt: card.suggestedReplies[1],
    articleId: article.id,
    category: article.category,
    title: article.title,
    offeredAt,
  };
}

interface PollQuestionShape {
  id: string;
  prompts: Record<string, string>;
  options: readonly { id: string; labels: Record<string, string> }[];
}

// Match the card against a question bank across every language: the card was
// written in whatever language was active then, which may not be the current
// one. Options are resolved chip by chip so the recovered poll keeps the exact
// labels the user is looking at, paired with the option ids that record them.
function recoverPoll(
  card: PendingNudgeCard,
  questions: readonly PollQuestionShape[],
): { questionId: string; options: { id: string; label: string }[] } | null {
  const prompt = card.content.trim();
  if (!prompt) {
    return null;
  }
  const question = questions.find((candidate) =>
    NUDGE_CARD_LANGS.some((lang) => candidate.prompts[lang]?.trim() === prompt),
  );
  if (!question) {
    return null;
  }
  const options: { id: string; label: string }[] = [];
  for (const label of card.suggestedReplies) {
    const option = question.options.find((entry) =>
      NUDGE_CARD_LANGS.some((lang) => entry.labels[lang]?.trim() === label.trim()),
    );
    // A chip with no matching option means this is not the question it looks
    // like (bank edited since the card was posted). Recovering a partial option
    // set would record the wrong answer for whatever the user taps.
    if (!option) {
      return null;
    }
    options.push({ id: option.id, label });
  }
  return options.length > 0 ? { questionId: question.id, options } : null;
}

export function recoverTastePoll(card: PendingNudgeCard): PendingTastePoll | null {
  if (card.kind !== 'taste-poll') {
    return null;
  }
  return recoverPoll(card, TASTE_POLL_QUESTIONS as readonly PollQuestionShape[]);
}

/**
 * @param generatedQuestions Aoi-generated questions in seed shape; the card may
 * come from one of those rather than from the static bank.
 */
export function recoverPreferencePoll(
  card: PendingNudgeCard,
  generatedQuestions: readonly PreferencePollQuestion[] = [],
): PendingPreferencePoll | null {
  if (card.kind !== 'preference-poll') {
    return null;
  }
  const bank = [
    ...PREFERENCE_POLL_QUESTIONS,
    ...generatedQuestions,
  ] as readonly PollQuestionShape[];
  return recoverPoll(card, bank);
}
