// Aoi music taste learning: in-app YouTube searches, playback, and taste polls.
//
// Signals that feed recommendations (idle cards + chat):
// 1. Queries the user typed into the YouTube app (strong interest).
// 2. Titles the user actually played (PLAY_VIDEO), agent plays excluded by caller.
// 3. Answers to occasional multiple-choice taste questions.
// Everything except the storage helpers is pure and deterministic for unit tests.

import type { AoiMusicMood } from './aoiMusicRecommendation';

export type AoiTasteLang = 'ko' | 'ja' | 'zh' | 'en';

export interface AoiMusicTasteState {
  version: 1;
  // questionId -> chosen optionId, for questions the user has answered.
  answers: Record<string, string>;
  // User-typed YouTube searches, newest first, deduped, capped.
  recentSearches: string[];
  // User-initiated plays (title [+ channel]), newest first, deduped, capped.
  recentPlays: string[];
  // When a taste poll was last shown (answered or not), for the cooldown.
  lastAskedAt: number;
}

export const AOI_MUSIC_TASTE_STATE_VERSION = 1 as const;

export const DEFAULT_AOI_MUSIC_TASTE_STATE: AoiMusicTasteState = {
  version: AOI_MUSIC_TASTE_STATE_VERSION,
  answers: {},
  recentSearches: [],
  recentPlays: [],
  lastAskedAt: 0,
};

const MAX_TASTE_SEARCHES = 12;
const MAX_TASTE_PLAYS = 16;
const MAX_SEARCH_QUERY_LENGTH = 80;
const MAX_PLAY_LABEL_LENGTH = 100;
// Ask at most one taste question per day, and only while questions remain.
export const TASTE_POLL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const TASTE_POLL_MIN_IDLE_MS = 3 * 60 * 1000;

// --- YouTube search / play capture --------------------------------------------

// Normalize a user-typed search into a learnable query, or null when it is not
// worth remembering (blank, URL paste, symbol-only, unreasonably long).
export function sanitizeTasteSearchQuery(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  if (!collapsed || collapsed.length > MAX_SEARCH_QUERY_LENGTH) {
    return null;
  }
  if (/^https?:\/\//i.test(collapsed)) {
    return null;
  }
  if (!/[\p{L}\p{N}]/u.test(collapsed)) {
    return null;
  }
  return collapsed;
}

function sanitizePlayLabel(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  if (!collapsed || collapsed.length > MAX_PLAY_LABEL_LENGTH) {
    return null;
  }
  if (/^https?:\/\//i.test(collapsed)) {
    return null;
  }
  if (!/[\p{L}\p{N}]/u.test(collapsed)) {
    return null;
  }
  return collapsed;
}

function prependUnique(list: string[], item: string, max: number): string[] {
  const lower = item.toLowerCase();
  return [item, ...list.filter((entry) => entry.toLowerCase() !== lower)].slice(0, max);
}

// Record a user-initiated YouTube search (newest first, case-insensitive
// dedupe, capped). Returns a new state; never mutates the input.
export function recordYouTubeSearch(
  state: AoiMusicTasteState | null | undefined,
  params: { query: string },
): AoiMusicTasteState {
  const base = normalizeTasteState(state);
  const query = sanitizeTasteSearchQuery(params.query);
  if (!query) {
    return base;
  }
  return {
    ...base,
    recentSearches: prependUnique(base.recentSearches, query, MAX_TASTE_SEARCHES),
  };
}

// Record a user-initiated play. Prefer "title - channel" when both exist so
// recommender personal queries stay searchable on YouTube.
export function recordYouTubePlay(
  state: AoiMusicTasteState | null | undefined,
  params: { title?: string; channel?: string; query?: string },
): AoiMusicTasteState {
  const base = normalizeTasteState(state);
  const title = sanitizePlayLabel(params.title ?? '');
  const channel = sanitizePlayLabel(params.channel ?? '');
  const explicit = sanitizeTasteSearchQuery(params.query ?? '');
  let label: string | null = explicit;
  if (!label && title && channel && !title.toLowerCase().includes(channel.toLowerCase())) {
    label = sanitizePlayLabel(`${title} - ${channel}`);
  }
  if (!label) {
    label = title;
  }
  if (!label) {
    return base;
  }
  return {
    ...base,
    recentPlays: prependUnique(base.recentPlays, label, MAX_TASTE_PLAYS),
  };
}

// --- Taste poll question bank -------------------------------------------------

export interface TastePollOption {
  id: string;
  labels: Record<AoiTasteLang, string>;
  moodBias?: Partial<Record<AoiMusicMood, number>>;
  seedQueries?: readonly string[];
}

export interface TastePollQuestion {
  id: string;
  prompts: Record<AoiTasteLang, string>;
  options: readonly TastePollOption[];
}

// Small fixed bank. Every option carries its own recommendation effect; the
// "depends" style options intentionally carry none so answering them still
// completes the question without skewing anything.
export const TASTE_POLL_QUESTIONS: readonly TastePollQuestion[] = [
  {
    id: 'vibe',
    prompts: {
      ko: '음악 취향 하나만 물어볼게. 배경으로 깔 때 어떤 분위기가 제일 좋아?',
      ja: '音楽の好みをひとつ聞かせて。BGMならどんな雰囲気が一番好き?',
      zh: '问你一个音乐偏好：当背景音乐时你最喜欢哪种氛围?',
      en: 'Quick taste check: what vibe do you like most as background music?',
    },
    options: [
      {
        id: 'calm_lofi',
        labels: {
          ko: '잔잔한 로파이·칠',
          ja: '穏やかなローファイ・チル',
          zh: '轻柔的 lofi/chill',
          en: 'Calm lofi / chill',
        },
        moodBias: { chill: 2 },
        seedQueries: ['lofi chill beats playlist'],
      },
      {
        id: 'energetic_pop',
        labels: {
          ko: '신나는 팝·케이팝',
          ja: 'ノリのいいポップ・K-POP',
          zh: '带感的流行/K-pop',
          en: 'Upbeat pop / k-pop',
        },
        moodBias: { upbeat: 2 },
        seedQueries: ['feel good kpop mix'],
      },
      {
        id: 'deep_focus',
        labels: {
          ko: '집중용 앰비언트·인스트루멘털',
          ja: '集中用アンビエント・インスト',
          zh: '专注向氛围/纯音乐',
          en: 'Focus ambient / instrumental',
        },
        moodBias: { focus: 1, ambient: 1 },
        seedQueries: ['deep focus instrumental mix'],
      },
      {
        id: 'depends',
        labels: {
          ko: '그때그때 달라',
          ja: 'そのときによる',
          zh: '看心情',
          en: 'Depends on the moment',
        },
      },
    ],
  },
  {
    id: 'vocals',
    prompts: {
      ko: '작업하면서 들을 때, 보컬 있는 곡도 괜찮아?',
      ja: '作業中に聴くなら、ボーカル入りの曲でも大丈夫?',
      zh: '工作时听歌，你介意有人声吗?',
      en: 'While you work, are vocals in the music okay?',
    },
    options: [
      {
        id: 'instrumental_only',
        labels: {
          ko: '인스트루멘털이 좋아',
          ja: 'インストがいい',
          zh: '更喜欢纯音乐',
          en: 'Instrumental only',
        },
        moodBias: { focus: 1 },
        seedQueries: ['instrumental concentration playlist'],
      },
      {
        id: 'vocals_ok',
        labels: {
          ko: '보컬 있어도 좋아',
          ja: 'ボーカルありでもいい',
          zh: '有人声也可以',
          en: 'Vocals are fine',
        },
        seedQueries: ['chill vocal pop playlist'],
      },
      {
        id: 'korean_songs',
        labels: {
          ko: '한국어 곡이 좋아',
          ja: '韓国語の曲がいい',
          zh: '更喜欢韩语歌',
          en: 'Korean songs please',
        },
        seedQueries: ['korean indie chill playlist'],
      },
      {
        id: 'depends',
        labels: {
          ko: '상관없어',
          ja: 'こだわらない',
          zh: '无所谓',
          en: 'No preference',
        },
      },
    ],
  },
  {
    id: 'genre',
    prompts: {
      ko: '하나만 골라야 한다면 어느 쪽이야?',
      ja: 'ひとつだけ選ぶならどれ?',
      zh: '只能选一个的话，你选哪种?',
      en: 'If you had to pick one lane, which is it?',
    },
    options: [
      {
        id: 'jazz_lofi',
        labels: {
          ko: '재즈·로파이',
          ja: 'ジャズ・ローファイ',
          zh: '爵士/lofi',
          en: 'Jazz / lofi',
        },
        moodBias: { chill: 1 },
        seedQueries: ['jazz lofi cafe mix'],
      },
      {
        id: 'electronic',
        labels: {
          ko: '일렉트로닉·EDM',
          ja: 'エレクトロニック・EDM',
          zh: '电子/EDM',
          en: 'Electronic / EDM',
        },
        moodBias: { upbeat: 1 },
        seedQueries: ['electronic work mix'],
      },
      {
        id: 'game_ost',
        labels: {
          ko: '게임·영화 OST',
          ja: 'ゲーム・映画のOST',
          zh: '游戏/电影原声',
          en: 'Game / film OST',
        },
        moodBias: { focus: 1 },
        seedQueries: ['game ost focus mix'],
      },
      {
        id: 'kpop',
        labels: {
          ko: '케이팝',
          ja: 'K-POP',
          zh: 'K-pop',
          en: 'K-pop',
        },
        moodBias: { upbeat: 1 },
        seedQueries: ['kpop hits playlist'],
      },
    ],
  },
];

// First question the user has not answered yet, in bank order.
export function pickNextTasteQuestion(
  state: AoiMusicTasteState | null | undefined,
): TastePollQuestion | null {
  const base = normalizeTasteState(state);
  return TASTE_POLL_QUESTIONS.find((question) => !(question.id in base.answers)) ?? null;
}

export interface ShouldAskTasteQuestionInput {
  now: number;
  userIdleMs: number | undefined;
  autonomyEnabled: boolean;
  quietMode: boolean;
  // True while a music / news / poll card is already awaiting an answer.
  otherOfferPending: boolean;
  lastAskedAt: number;
  hasUnansweredQuestion: boolean;
  minIdleMs?: number;
  cooldownMs?: number;
}

// Should Aoi ask a taste question right now? Mirrors the idle-music gates plus
// its own (long) cooldown, and never stacks on top of another pending card.
export function shouldAskTasteQuestion(input: ShouldAskTasteQuestionInput): boolean {
  if (!input.autonomyEnabled || input.quietMode || input.otherOfferPending) {
    return false;
  }
  if (!input.hasUnansweredQuestion) {
    return false;
  }
  if (typeof input.userIdleMs !== 'number' || !Number.isFinite(input.userIdleMs)) {
    return false;
  }
  if (input.userIdleMs < (input.minIdleMs ?? TASTE_POLL_MIN_IDLE_MS)) {
    return false;
  }
  const cooldownMs = input.cooldownMs ?? TASTE_POLL_COOLDOWN_MS;
  if (input.lastAskedAt > 0 && input.now - input.lastAskedAt < cooldownMs) {
    return false;
  }
  return true;
}

// Stamp that a poll was shown (starts the cooldown even if never answered).
export function recordTasteQuestionAsked(
  state: AoiMusicTasteState | null | undefined,
  params: { now: number },
): AoiMusicTasteState {
  return { ...normalizeTasteState(state), lastAskedAt: params.now };
}

// Fold an answer in. Unknown question/option ids are ignored (a stale pending
// poll from storage must not corrupt the profile). Never mutates the input.
export function recordTasteAnswer(
  state: AoiMusicTasteState | null | undefined,
  params: { questionId: string; optionId: string },
): AoiMusicTasteState {
  const base = normalizeTasteState(state);
  const question = TASTE_POLL_QUESTIONS.find((item) => item.id === params.questionId);
  const option = question?.options.find((item) => item.id === params.optionId);
  if (!question || !option) {
    return base;
  }
  return {
    ...base,
    answers: { ...base.answers, [question.id]: option.id },
  };
}

// --- Profile derivation ---------------------------------------------------------

export interface AoiTasteProfile {
  // Additive mood score from poll answers, fed into chooseAoiMusicMood.
  moodBias: Partial<Record<AoiMusicMood, number>>;
  // Personal query candidates, strongest first:
  // recent user searches -> recent plays -> poll seed queries.
  personalQueries: string[];
  // Human-readable answered poll choices (English labels for the model prompt).
  pollChoices: string[];
  recentSearches: string[];
  recentPlays: string[];
  hasTasteSignal: boolean;
}

export function deriveTasteProfile(state: AoiMusicTasteState | null | undefined): AoiTasteProfile {
  const base = normalizeTasteState(state);
  const moodBias: Partial<Record<AoiMusicMood, number>> = {};
  const personalQueries: string[] = [];
  const pollChoices: string[] = [];
  const seen = new Set<string>();

  const push = (query: string) => {
    const key = query.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      personalQueries.push(query);
    }
  };

  // User evidence first (real behavior), poll seeds last (weak priors).
  for (const search of base.recentSearches) {
    push(search);
  }
  for (const play of base.recentPlays) {
    push(play);
    // Expand "Title - Channel" plays into searchable title / artist fragments so
    // recommendations stay in the same lane instead of falling to the mood pool.
    const dash = play.match(/^(.+?)\s+[-–—]\s+(.+)$/u);
    if (dash) {
      const left = dash[1].trim();
      const right = dash[2].trim();
      if (left.length >= 2) {
        push(left);
      }
      if (right.length >= 2 && right.length <= 40) {
        push(right);
      }
    }
  }

  for (const question of TASTE_POLL_QUESTIONS) {
    const optionId = base.answers[question.id];
    const option = question.options.find((item) => item.id === optionId);
    if (!option) {
      continue;
    }
    pollChoices.push(option.labels.en);
    for (const [mood, bias] of Object.entries(option.moodBias ?? {})) {
      const key = mood as AoiMusicMood;
      moodBias[key] = (moodBias[key] ?? 0) + (bias ?? 0);
    }
    for (const seed of option.seedQueries ?? []) {
      push(seed);
    }
  }

  return {
    moodBias,
    personalQueries,
    pollChoices,
    recentSearches: [...base.recentSearches],
    recentPlays: [...base.recentPlays],
    hasTasteSignal:
      base.recentSearches.length > 0 ||
      base.recentPlays.length > 0 ||
      Object.keys(base.answers).length > 0,
  };
}

// Prompt block for the chat LLM so free-form music talk still honors taste.
export function buildAoiMusicTastePromptBlock(
  state: AoiMusicTasteState | null | undefined,
  options: { maxQueries?: number } = {},
): string {
  const profile = deriveTasteProfile(state);
  if (!profile.hasTasteSignal) {
    return [
      '',
      'Music taste (learned):',
      '- No durable music taste is stored yet.',
      '- When the user asks for a song recommendation, prefer asking a short preference question or suggesting a neutral focus/chill mix.',
      // R5.1: the original line read "Do not invent a personal taste profile",
      // which the model could only satisfy by having no side of its own at all.
      // The real rule is narrower: never fabricate, never pass your own
      // preference off as the user's -- but your documented character tastes are
      // yours to voice.
      '- Do not invent a taste profile for the user, and never present your own preference as theirs. Your own tastes, where the character description states them, are yours to say out loud.',
      '- Prefer the runtime music recommender path when available; never invent unrelated viral hits.',
    ].join('\n');
  }

  const maxQueries = Math.max(1, Math.min(options.maxQueries ?? 8, 12));
  const queries = profile.personalQueries.slice(0, maxQueries);
  const lines = [
    '',
    'Music taste (learned — must follow for music recommendations):',
    '- When the user asks for a song, playlist, or "something to play", recommend from this profile first.',
    '- Prefer personal queries / plays below over generic global hits.',
    '- Stay in the same language/genre lane as the personal evidence (e.g. Korean titles stay Korean-leaning).',
    '- If you recommend, name one concrete YouTube search query the app can open.',
    '- Do not recommend unrelated pop hits, random Western chart songs, or genres that contradict this profile.',
  ];

  if (profile.pollChoices.length > 0) {
    lines.push(`- Poll answers: ${profile.pollChoices.join('; ')}`);
  }
  if (profile.recentSearches.length > 0) {
    lines.push(
      `- Recent user YouTube searches (newest first): ${profile.recentSearches
        .slice(0, maxQueries)
        .map((item) => JSON.stringify(item))
        .join(', ')}`,
    );
  }
  if (profile.recentPlays.length > 0) {
    lines.push(
      `- Recent user plays (newest first): ${profile.recentPlays
        .slice(0, maxQueries)
        .map((item) => JSON.stringify(item))
        .join(', ')}`,
    );
  }
  if (queries.length > 0) {
    lines.push(
      `- Preferred recommendation candidates: ${queries
        .map((item) => JSON.stringify(item))
        .join(', ')}`,
    );
  }
  const moodBits = Object.entries(profile.moodBias)
    .filter(([, score]) => typeof score === 'number' && score !== 0)
    .map(([mood, score]) => `${mood}:${score}`);
  if (moodBits.length > 0) {
    lines.push(`- Mood bias scores: ${moodBits.join(', ')}`);
  }
  return lines.join('\n');
}

// Generic "recommend / play something" chat intents that should use the taste
// recommender instead of free-form LLM guesses. Specific titles ("IVE 틀어줘")
// are handled by parseDirectMusicIntent and must not match here.
export type AoiMusicTasteChatIntent = { kind: 'recommend'; autoplay: boolean } | { kind: 'none' };

export function parseAoiMusicTasteChatIntent(text: string): AoiMusicTasteChatIntent {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 120) {
    return { kind: 'none' };
  }

  // Explicit title playback is handled elsewhere.
  if (
    /^(?:play|listen to|put on)\s+.+/i.test(trimmed) &&
    !/^(?:play|listen to|put on)\s+(?:something|anything|music|a song|some music)\b/i.test(trimmed)
  ) {
    return { kind: 'none' };
  }
  if (
    /^.+\s*(?:듣자|들어보자|틀어줘|재생해줘|재생해|들려줘|틀어|재생하자|재생)$/u.test(trimmed) &&
    !/^(?:아무거나|랜덤|아무 노래|아무 음악|음악|노래|곡)\s*(?:듣자|들어보자|틀어줘|재생해줘|재생해|들려줘|틀어|재생하자|재생)?$/u.test(
      trimmed,
    )
  ) {
    // Has a non-generic title prefix -> not a pure taste recommend intent.
    if (
      !/^(?:노래|음악|곡|music|song|track)?\s*(?:추천|recommend)/i.test(trimmed) &&
      !/^(?:뭐|무엇|무슨)\s*(?:듣지|들을까|들을게|들을래|들어|들어야)/u.test(trimmed)
    ) {
      return { kind: 'none' };
    }
  }

  const recommendOnly = [
    /^(?:노래|음악|곡)?\s*추천(?:해|해줘|해 줘| 좀|좀)?(?:\s*봐)?$/u,
    /^(?:추천|추천해|추천해줘|추천 좀)\s*(?:노래|음악|곡)?$/u,
    /^(?:뭐|무엇|무슨)\s*(?:듣지|들을까|들을게|들을래|들어|들어야\s*할까)\??$/u,
    /^(?:오늘|지금)?\s*(?:뭐\s*)?(?:듣지|들을까)\??$/u,
    /^(?:recommend|suggest)\s*(?:a\s*)?(?:song|track|music|playlist)?\s*(?:please)?[.!?]?$/i,
    /^(?:any|some)\s+(?:song|music|playlist)\s+recommendations?[.!?]?$/i,
    /^(?:what\s+should\s+i\s+listen\s+to)[.!?]?$/i,
    /^(?:음악|노래)\s*추천\s*(?:해\s*)?(?:줄래|해줄래|해봐|해 봐)?$/u,
  ];
  for (const pattern of recommendOnly) {
    if (pattern.test(trimmed)) {
      return { kind: 'recommend', autoplay: false };
    }
  }

  const recommendAndPlay = [
    /^(?:아무거나|랜덤|아무 노래|아무 음악)\s*(?:틀어줘|재생해줘|재생해|들려줘|틀어|재생)?$/u,
    /^(?:음악|노래|곡)\s*(?:틀어줘|재생해줘|재생해|들려줘|틀어)$/u,
    /^(?:틀어줘|재생해줘|들려줘)$/u,
    /^(?:play|put on)\s+(?:something|anything|music|a song|some music)\s*(?:please)?[.!?]?$/i,
    /^(?:just\s+)?(?:play|put on)\s+something\s*(?:for me)?[.!?]?$/i,
    /^(?:네가|니가|너가)\s*골라(?:\s*줘)?$/u,
    /^(?:추천대로|네 추천으로)\s*(?:틀어줘|재생|가자|해줘)?$/u,
    /^(?:you\s+pick|pick\s+(?:one|something)|surprise\s+me)[.!?]?$/i,
  ];
  for (const pattern of recommendAndPlay) {
    if (pattern.test(trimmed)) {
      return { kind: 'recommend', autoplay: true };
    }
  }

  return { kind: 'none' };
}

// Short genre/lane replies used as suggested chips after need-preference, and
// free-typed equivalents. Recorded as personal search seeds (not pool picks).
const MUSIC_PREFERENCE_SEED_PATTERNS: readonly RegExp[] = [
  /^(?:케이\s*팝|k-?pop|케이팝)$/iu,
  /^(?:로파이|로 파이|lo-?fi|chill|칠(?:hop|hop)?|로파이\s*[·・,]?\s*칠)$/iu,
  /^(?:게임\s*ost|game\s*ost|ost)$/iu,
  /^(?:한국어\s*인디|korean\s*indie|인디)$/iu,
  /^(?:j-?pop|제이팝)$/iu,
  /^(?:edm|일렉|electronic)$/iu,
  /^(?:재즈|jazz)$/iu,
  /^(?:시티\s*팝|city\s*pop)$/iu,
];

export function parseAoiMusicPreferenceSeed(text: string): string | null {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > 40) {
    return null;
  }
  for (const pattern of MUSIC_PREFERENCE_SEED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return sanitizeTasteSearchQuery(trimmed);
    }
  }
  return null;
}

// When chat asks for a recommend but no durable taste exists yet, do NOT dump
// a generic pool mix (e.g. "sunset chill beats"). Ask a short preference first.
export function buildAoiMusicTasteNeedPreferenceCopy(lang: AoiTasteLang): {
  text: string;
  suggestedReplies: string[];
} {
  const copy = {
    ko: {
      text:
        '아직 네 음악 취향 신호가 거의 없어. 아무 제네릭 믹스를 찍기보다 먼저 듣고 싶은 쪽을 알려줄래?\n' +
        '예: 아티스트/장르/분위기 (케이팝, 로파이, 게임 OST, 한국어 인디…)\n' +
        'YouTube에서 검색·재생한 곡이 쌓이면 그걸 우선 추천할게.',
      suggestedReplies: ['케이팝', '로파이·칠', '게임 OST', '한국어 인디'],
    },
    ja: {
      text:
        'まだ音楽の好みの信号がほとんどないよ。適当な汎用ミックスより、聴きたい方向を教えて?\n' +
        '例: アーティスト/ジャンル/雰囲気\n' +
        'YouTubeで検索・再生した曲が増えたらそれを優先して勧めるね。',
      suggestedReplies: ['K-POP', 'lofi/chill', 'ゲームOST', 'J-POP'],
    },
    zh: {
      text:
        '我还几乎没有你的音乐口味信号。与其随便推一个通用混音，不如先告诉我想听的方向？\n' +
        '例如：歌手/类型/氛围\n' +
        '你在 YouTube 搜索、播放越多，我就会越优先按那些推荐。',
      suggestedReplies: ['K-pop', 'lofi/chill', '游戏OST', '华语'],
    },
    en: {
      text:
        'I barely have your music taste signals yet. Instead of inventing a generic mix, tell me a lane first?\n' +
        'Examples: artist / genre / vibe (k-pop, lofi, game OST, indie…)\n' +
        "Once you've searched or played songs on YouTube, I'll recommend from those first.",
      suggestedReplies: ['K-pop', 'lofi / chill', 'game OST', 'indie'],
    },
  }[lang];
  return { text: copy.text, suggestedReplies: copy.suggestedReplies };
}

// Localized reply for a taste-backed chat recommendation.
export function buildAoiMusicTasteRecommendCopy(input: {
  query: string;
  source: 'personal' | 'pool';
  lang: AoiTasteLang;
  autoplay: boolean;
}): { text: string; playPrompt: string; dismissPrompt: string } {
  const chips = {
    ko: { play: '재생', dismiss: '다른 거' },
    ja: { play: '再生', dismiss: '別の曲' },
    zh: { play: '播放', dismiss: '换一首' },
    en: { play: 'Play', dismiss: 'Another' },
  }[input.lang];
  const personal =
    input.source === 'personal'
      ? {
          ko: '네 검색·재생 취향을 반영해서',
          ja: 'あなたの検索・再生の好みから',
          zh: '根据你的搜索和播放偏好',
          en: 'From your searches and plays',
        }[input.lang]
      : {
          // Pool is only used when personal history is empty (idle fallback).
          ko: '아직 취향 데이터가 얇아서 임시 분위기로',
          ja: '好みデータが少ないので仮の雰囲気で',
          zh: '口味数据还少，先按临时氛围',
          en: 'With little taste history yet, for the moment',
        }[input.lang];

  if (input.autoplay) {
    const text = {
      ko: `${personal} "${input.query}" 틀어줄게.\nYouTube 검색어: \`${input.query}\``,
      ja: `${personal}「${input.query}」をかけるね。\nYouTube 検索語: \`${input.query}\``,
      zh: `${personal}，我放 “${input.query}”。\nYouTube 搜索词: \`${input.query}\``,
      en: `${personal}, playing "${input.query}".\nYouTube search query: \`${input.query}\``,
    }[input.lang];
    return {
      text,
      playPrompt: `▶ ${chips.play}`,
      dismissPrompt: chips.dismiss,
    };
  }

  const text = {
    ko: `${personal} 이 곡/믹스 어때?\n🎵 추천: "${input.query}"\nYouTube 검색어: \`${input.query}\`\n재생 누르면 바로 틀어줄게.`,
    ja: `${personal}これどう?\n🎵 おすすめ: "${input.query}"\nYouTube 検索語: \`${input.query}\`\n再生を押せばすぐ流すよ。`,
    zh: `${personal}，这首/这个混音怎么样?\n🎵 推荐: "${input.query}"\nYouTube 搜索词: \`${input.query}\`\n点播放我就直接打开。`,
    en: `${personal}: how about this?\n🎵 Pick: "${input.query}"\nYouTube search query: \`${input.query}\`\nTap Play and I'll open it.`,
  }[input.lang];

  return {
    text,
    playPrompt: `▶ ${chips.play}`,
    dismissPrompt: chips.dismiss,
  };
}

// --- Persistence ---------------------------------------------------------------

const TASTE_STATE_STORAGE_KEY = 'aoi-music-taste-v1';

function normalizeStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

function normalizeTasteState(state: AoiMusicTasteState | null | undefined): AoiMusicTasteState {
  if (!state || state.version !== AOI_MUSIC_TASTE_STATE_VERSION) {
    return {
      ...DEFAULT_AOI_MUSIC_TASTE_STATE,
      answers: {},
      recentSearches: [],
      recentPlays: [],
    };
  }
  // Keep the same object when already fully shaped so no-op writers can return
  // the input reference (stable for React/ref equality and unit tests).
  if (
    Array.isArray(state.recentSearches) &&
    Array.isArray(state.recentPlays) &&
    state.answers &&
    typeof state.lastAskedAt === 'number'
  ) {
    return state;
  }
  return {
    version: AOI_MUSIC_TASTE_STATE_VERSION,
    answers: state.answers ?? {},
    recentSearches: Array.isArray(state.recentSearches) ? state.recentSearches : [],
    recentPlays: Array.isArray(state.recentPlays) ? state.recentPlays : [],
    lastAskedAt: typeof state.lastAskedAt === 'number' ? state.lastAskedAt : 0,
  };
}

export function loadAoiMusicTasteState(): AoiMusicTasteState {
  try {
    const raw = localStorage.getItem(TASTE_STATE_STORAGE_KEY);
    if (!raw) {
      return normalizeTasteState(null);
    }
    const parsed = JSON.parse(raw) as Partial<AoiMusicTasteState> | null;
    if (
      parsed &&
      parsed.version === AOI_MUSIC_TASTE_STATE_VERSION &&
      typeof parsed.answers === 'object' &&
      parsed.answers !== null &&
      Array.isArray(parsed.recentSearches) &&
      parsed.recentSearches.every((item) => typeof item === 'string')
    ) {
      return {
        version: AOI_MUSIC_TASTE_STATE_VERSION,
        answers: Object.fromEntries(
          Object.entries(parsed.answers).filter(([, value]) => typeof value === 'string'),
        ),
        recentSearches: normalizeStringList(parsed.recentSearches, MAX_TASTE_SEARCHES),
        recentPlays: normalizeStringList(
          (parsed as { recentPlays?: unknown }).recentPlays,
          MAX_TASTE_PLAYS,
        ),
        lastAskedAt: typeof parsed.lastAskedAt === 'number' ? parsed.lastAskedAt : 0,
      };
    }
  } catch {
    // Malformed storage; start clean.
  }
  return normalizeTasteState(null);
}

export function saveAoiMusicTasteState(state: AoiMusicTasteState): void {
  try {
    localStorage.setItem(TASTE_STATE_STORAGE_KEY, JSON.stringify(normalizeTasteState(state)));
  } catch {
    // Best-effort persistence; ignore quota / privacy-mode failures.
  }
}
