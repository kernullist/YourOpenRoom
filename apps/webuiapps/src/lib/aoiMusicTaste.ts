// Aoi music taste learning: in-app YouTube searches + explicit taste polls.
//
// Two signals feed the idle-music recommendation beyond mood accept/skip:
// 1. Queries the user typed into the YouTube app themselves (strong interest
//    signal; agent-triggered searches are filtered out by the caller).
// 2. Answers to occasional multiple-choice taste questions Aoi asks in chat.
// Both live in one versioned localStorage store. Everything except the two
// storage helpers is pure and deterministic for unit testing.

import type { AoiMusicMood } from './aoiMusicRecommendation';

export type AoiTasteLang = 'ko' | 'ja' | 'zh' | 'en';

export interface AoiMusicTasteState {
  version: 1;
  // questionId -> chosen optionId, for questions the user has answered.
  answers: Record<string, string>;
  // User-typed YouTube searches, newest first, deduped, capped.
  recentSearches: string[];
  // When a taste poll was last shown (answered or not), for the cooldown.
  lastAskedAt: number;
}

export const AOI_MUSIC_TASTE_STATE_VERSION = 1 as const;

export const DEFAULT_AOI_MUSIC_TASTE_STATE: AoiMusicTasteState = {
  version: AOI_MUSIC_TASTE_STATE_VERSION,
  answers: {},
  recentSearches: [],
  lastAskedAt: 0,
};

const MAX_TASTE_SEARCHES = 12;
const MAX_SEARCH_QUERY_LENGTH = 80;
// Ask at most one taste question per day, and only while questions remain.
export const TASTE_POLL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const TASTE_POLL_MIN_IDLE_MS = 3 * 60 * 1000;

// --- YouTube search capture ---------------------------------------------------

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
  const lower = query.toLowerCase();
  return {
    ...base,
    recentSearches: [
      query,
      ...base.recentSearches.filter((item) => item.toLowerCase() !== lower),
    ].slice(0, MAX_TASTE_SEARCHES),
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
  // Personal query candidates: poll seeds first (stable), then the user's own
  // recent searches (newest first). Deduped case-insensitively.
  personalQueries: string[];
}

export function deriveTasteProfile(state: AoiMusicTasteState | null | undefined): AoiTasteProfile {
  const base = normalizeTasteState(state);
  const moodBias: Partial<Record<AoiMusicMood, number>> = {};
  const personalQueries: string[] = [];
  const seen = new Set<string>();

  const push = (query: string) => {
    const key = query.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      personalQueries.push(query);
    }
  };

  for (const question of TASTE_POLL_QUESTIONS) {
    const optionId = base.answers[question.id];
    const option = question.options.find((item) => item.id === optionId);
    if (!option) {
      continue;
    }
    for (const [mood, bias] of Object.entries(option.moodBias ?? {})) {
      const key = mood as AoiMusicMood;
      moodBias[key] = (moodBias[key] ?? 0) + (bias ?? 0);
    }
    for (const seed of option.seedQueries ?? []) {
      push(seed);
    }
  }
  for (const search of base.recentSearches) {
    push(search);
  }

  return { moodBias, personalQueries };
}

// --- Persistence ---------------------------------------------------------------

const TASTE_STATE_STORAGE_KEY = 'aoi-music-taste-v1';

function normalizeTasteState(state: AoiMusicTasteState | null | undefined): AoiMusicTasteState {
  if (!state || state.version !== AOI_MUSIC_TASTE_STATE_VERSION) {
    return { ...DEFAULT_AOI_MUSIC_TASTE_STATE, answers: {}, recentSearches: [] };
  }
  return state;
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
        recentSearches: parsed.recentSearches,
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
    localStorage.setItem(TASTE_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort persistence; ignore quota / privacy-mode failures.
  }
}
