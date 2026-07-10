// Aoi general preference poll: occasional multiple-choice questions Aoi asks in
// chat to learn the user's technical interests, working style, and personal
// tastes, so the answers can inform later judgments.
//
// This mirrors the music taste poll (aoiMusicTaste) but is domain-agnostic and
// feeds the general memory pipeline instead of the music recommender: each
// answered option carries a learnable payload that ChatPanel persists as a
// structured `preference` memory (see buildPreferencePollMemoryCandidate). Those
// preference memories flow into the preference prompt block Aoi reads on every
// turn -- i.e. "used for later judgments".
//
// Routing: only questions in the `interest` category surface as technical
// interest topics (via real entities/tags that the interest profile extracts).
// Every other category is tagged `preference-only`, which the interest profile
// treats as an excluded tag, so working-style and personal-taste answers stay
// preference-only and never pollute the technical interest / curiosity pipeline.
//
// Everything except the two storage helpers is pure and deterministic so the
// question bank, gating, memory derivation, and memory-supersede/forget
// selection are all unit-testable offline.

import type { AoiMemoryCandidate, AoiMemoryEntry } from './aoiMemoryShared';

export type AoiPreferenceLang = 'ko' | 'ja' | 'zh' | 'en';

// Tag applied to every non-interest taste memory. It is registered as an
// excluded tag in aoiInterestProfile, so these preference memories inform the
// preference prompt block but never become interest topics.
export const PREFERENCE_ONLY_TAG = 'preference-only';

export interface AoiPreferencePollState {
  version: 1;
  // questionId -> chosen optionId, for questions the user has answered.
  answers: Record<string, string>;
  // When a poll was last shown (answered or not), for the cooldown.
  lastAskedAt: number;
}

export const AOI_PREFERENCE_POLL_STATE_VERSION = 1 as const;

export const DEFAULT_AOI_PREFERENCE_POLL_STATE: AoiPreferencePollState = {
  version: AOI_PREFERENCE_POLL_STATE_VERSION,
  answers: {},
  lastAskedAt: 0,
};

// Ask at most one preference question per day, and only after a few idle minutes
// -- the same cadence as the music taste poll so the two never feel spammy.
export const PREFERENCE_POLL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const PREFERENCE_POLL_MIN_IDLE_MS = 3 * 60 * 1000;

// --- Categories --------------------------------------------------------------

export type AoiPreferenceCategory = 'interest' | 'work_style' | 'collaboration' | 'personal';

export interface PreferenceCategoryMeta {
  id: AoiPreferenceCategory;
  labels: Record<AoiPreferenceLang, string>;
}

// Display order for the dashboard. `interest` first because it is the only
// category that feeds the technical interest profile.
export const PREFERENCE_POLL_CATEGORIES: readonly PreferenceCategoryMeta[] = [
  {
    id: 'interest',
    labels: { ko: '관심 분야', ja: '関心分野', zh: '关注领域', en: 'Interests' },
  },
  {
    id: 'work_style',
    labels: { ko: '작업 스타일', ja: '作業スタイル', zh: '工作风格', en: 'Working style' },
  },
  {
    id: 'collaboration',
    labels: {
      ko: '협업·소통',
      ja: '協働・コミュニケーション',
      zh: '协作与沟通',
      en: 'Collaboration',
    },
  },
  {
    id: 'personal',
    labels: { ko: '개인 취향', ja: '個人の好み', zh: '个人喜好', en: 'Personal taste' },
  },
];

// --- Question bank -----------------------------------------------------------

// What an answered option teaches Aoi. `statement` is stored verbatim as the
// preference memory content (localized, user-facing). `tags`/`entities` steer
// downstream extraction: interest-category options carry real interest-like
// tags/entities so the interest profile surfaces a topic; every other option
// omits them and is additionally marked PREFERENCE_ONLY_TAG by the builder.
export interface PreferenceLearnPayload {
  // Stable preference key suffix, shared by every option of a question, e.g.
  // 'focus-area' -> pref:taste.focus-area. Re-answering supersedes by this key.
  key: string;
  statement: Record<AoiPreferenceLang, string>;
  tags: readonly string[];
  entities?: readonly string[];
}

export interface PreferencePollOption {
  id: string;
  labels: Record<AoiPreferenceLang, string>;
  learn: PreferenceLearnPayload;
}

export interface PreferencePollQuestion {
  id: string;
  // Seed questions use an AoiPreferenceCategory; Aoi-generated questions may
  // introduce brand-new category ids, so at the bank level this is a plain string.
  category: string;
  // Generated questions carry their own localized category label; seed questions
  // resolve their label from PREFERENCE_POLL_CATEGORIES instead.
  categoryLabels?: Record<AoiPreferenceLang, string>;
  prompts: Record<AoiPreferenceLang, string>;
  options: readonly PreferencePollOption[];
  // Marks a question Aoi generated itself (vs the static seed bank).
  generated?: boolean;
}

// Seed bank + any Aoi-generated questions, in that order.
function allPreferenceQuestions(
  extraQuestions: readonly PreferencePollQuestion[] = [],
): PreferencePollQuestion[] {
  return [...PREFERENCE_POLL_QUESTIONS, ...extraQuestions];
}

// An option routes to a technical interest topic when it carries interest
// entities; otherwise it stays preference-only. This is per-option (not
// per-question) so a "how deep?" question can have one interest option and
// several preference-only ones.
export function optionRoutesToInterest(option: PreferencePollOption): boolean {
  return (option.learn.entities?.length ?? 0) > 0;
}

// Ordered to interleave categories so daily asks feel varied rather than five
// working-style questions in a row.
export const PREFERENCE_POLL_QUESTIONS: readonly PreferencePollQuestion[] = [
  {
    id: 'focus_area',
    category: 'interest',
    prompts: {
      ko: '요즘 가장 깊게 파고들고 싶은 기술 주제가 뭐야?',
      ja: '最近いちばん深掘りしたい技術トピックはどれ?',
      zh: '最近你最想深入钻研的技术主题是哪个?',
      en: 'Which technical topic do you most want to dig into these days?',
    },
    options: [
      {
        id: 'kernel_internals',
        labels: {
          ko: 'Windows 커널·드라이버 내부',
          ja: 'Windowsカーネル・ドライバ内部',
          zh: 'Windows 内核/驱动内部',
          en: 'Windows kernel / driver internals',
        },
        learn: {
          key: 'focus-area',
          statement: {
            ko: '요즘 Windows 커널·드라이버 내부 주제를 가장 깊게 파고들고 싶어 한다.',
            ja: '最近はWindowsカーネル・ドライバ内部のトピックを最も深掘りしたいと考えている。',
            zh: '最近最想深入钻研 Windows 内核/驱动内部主题。',
            en: 'Most wants to dig into Windows kernel and driver internals right now.',
          },
          tags: ['kernel', 'driver', 'windows'],
          entities: ['Windows kernel internals', 'kernel driver'],
        },
      },
      {
        id: 'anti_cheat',
        labels: {
          ko: '안티치트·게임 보안',
          ja: 'アンチチート・ゲームセキュリティ',
          zh: '反作弊/游戏安全',
          en: 'Anti-cheat / game security',
        },
        learn: {
          key: 'focus-area',
          statement: {
            ko: '요즘 안티치트·게임 보안 주제를 가장 깊게 파고들고 싶어 한다.',
            ja: '最近はアンチチート・ゲームセキュリティのトピックを最も深掘りしたい。',
            zh: '最近最想深入钻研反作弊/游戏安全主题。',
            en: 'Most wants to dig into anti-cheat and game security right now.',
          },
          tags: ['anti-cheat', 'game-security', 'security'],
          entities: ['anti-cheat', 'game security'],
        },
      },
      {
        id: 'reverse_engineering',
        labels: {
          ko: '리버스 엔지니어링',
          ja: 'リバースエンジニアリング',
          zh: '逆向工程',
          en: 'Reverse engineering',
        },
        learn: {
          key: 'focus-area',
          statement: {
            ko: '요즘 리버스 엔지니어링 주제를 가장 깊게 파고들고 싶어 한다.',
            ja: '最近はリバースエンジニアリングのトピックを最も深掘りしたい。',
            zh: '最近最想深入钻研逆向工程主题。',
            en: 'Most wants to dig into reverse engineering right now.',
          },
          tags: ['reverse-engineering', 'reversing', 'security'],
          entities: ['reverse engineering'],
        },
      },
      {
        id: 'tpm_verification',
        labels: {
          ko: 'TPM·하드웨어 기반 검증',
          ja: 'TPM・ハードウェア検証',
          zh: 'TPM/硬件验证',
          en: 'TPM / hardware verification',
        },
        learn: {
          key: 'focus-area',
          statement: {
            ko: '요즘 TPM·하드웨어 기반 검증 주제를 가장 깊게 파고들고 싶어 한다.',
            ja: '最近はTPM・ハードウェア検証のトピックを最も深掘りしたい。',
            zh: '最近最想深入钻研 TPM/硬件验证主题。',
            en: 'Most wants to dig into TPM and hardware-backed verification right now.',
          },
          tags: ['tpm', 'verification', 'security'],
          entities: ['TPM', 'attestation'],
        },
      },
    ],
  },
  {
    id: 'answer_depth',
    category: 'work_style',
    prompts: {
      ko: '내가 답변을 줄 때, 어떤 깊이가 제일 편해?',
      ja: '回答するとき、どのくらいの深さが一番いい?',
      zh: '我给回答时，你最喜欢哪种深度?',
      en: 'When I answer you, what depth works best?',
    },
    options: [
      {
        id: 'deep_detail',
        labels: {
          ko: '실무용 깊은 구현 디테일',
          ja: '実務向けの深い実装ディテール',
          zh: '可落地的深入实现细节',
          en: 'Deep, ready-to-use detail',
        },
        learn: {
          key: 'answer-depth',
          statement: {
            ko: '답변은 바로 실무에 쓸 수 있는 깊은 구현 디테일을 원한다.',
            ja: '回答はすぐ実務に使える深い実装ディテールを望む。',
            zh: '希望回答给出可直接落地的深入实现细节。',
            en: 'Wants answers with deep, ready-to-use implementation detail.',
          },
          tags: [],
        },
      },
      {
        id: 'summary_first',
        labels: {
          ko: '핵심 요약 먼저',
          ja: 'まず要点だけ',
          zh: '先给核心要点',
          en: 'Core summary first',
        },
        learn: {
          key: 'answer-depth',
          statement: {
            ko: '답변은 핵심 요약을 먼저 주는 방식을 원한다.',
            ja: '回答はまず要点の要約から欲しい。',
            zh: '希望回答先给出核心要点摘要。',
            en: 'Wants answers to lead with a core summary first.',
          },
          tags: [],
        },
      },
      {
        id: 'tradeoff_recommend',
        labels: {
          ko: '트레이드오프 비교 + 추천',
          ja: 'トレードオフ比較+推奨',
          zh: '权衡对比 + 推荐',
          en: 'Trade-off comparison + a pick',
        },
        learn: {
          key: 'answer-depth',
          statement: {
            ko: '선택지를 비교할 때 트레이드오프 설명과 추천을 함께 주기를 원한다.',
            ja: '選択肢を比較する際はトレードオフの説明と推奨を一緒に欲しい。',
            zh: '在比较选项时，希望同时给出权衡说明和推荐。',
            en: 'Wants trade-off explanations paired with a clear recommendation.',
          },
          tags: [],
        },
      },
    ],
  },
  {
    id: 'downtime',
    category: 'personal',
    prompts: {
      ko: '쉴 때는 주로 뭐 하면서 보내?',
      ja: '休むときは主に何をして過ごす?',
      zh: '休息时你主要做什么?',
      en: 'How do you usually spend your downtime?',
    },
    options: [
      {
        id: 'gaming',
        labels: { ko: '게임', ja: 'ゲーム', zh: '玩游戏', en: 'Gaming' },
        learn: {
          key: 'downtime',
          statement: {
            ko: '쉴 때는 주로 게임을 하며 보낸다.',
            ja: '休むときは主にゲームをして過ごす。',
            zh: '休息时主要通过玩游戏放松。',
            en: 'Usually spends downtime gaming.',
          },
          tags: [],
        },
      },
      {
        id: 'watching',
        labels: { ko: '영상·영화', ja: '動画・映画', zh: '看视频/电影', en: 'Videos / films' },
        learn: {
          key: 'downtime',
          statement: {
            ko: '쉴 때는 주로 영상이나 영화를 보며 보낸다.',
            ja: '休むときは主に動画や映画を観て過ごす。',
            zh: '休息时主要看视频或电影放松。',
            en: 'Usually spends downtime watching videos or films.',
          },
          tags: [],
        },
      },
      {
        id: 'reading',
        labels: { ko: '독서·글', ja: '読書・文章', zh: '阅读', en: 'Reading' },
        learn: {
          key: 'downtime',
          statement: {
            ko: '쉴 때는 주로 책이나 글을 읽으며 보낸다.',
            ja: '休むときは主に本や文章を読んで過ごす。',
            zh: '休息时主要通过阅读放松。',
            en: 'Usually spends downtime reading.',
          },
          tags: [],
        },
      },
      {
        id: 'active',
        labels: { ko: '운동·산책', ja: '運動・散歩', zh: '运动/散步', en: 'Exercise / walks' },
        learn: {
          key: 'downtime',
          statement: {
            ko: '쉴 때는 주로 운동이나 산책을 하며 보낸다.',
            ja: '休むときは主に運動や散歩をして過ごす。',
            zh: '休息时主要通过运动或散步放松。',
            en: 'Usually spends downtime exercising or walking.',
          },
          tags: [],
        },
      },
    ],
  },
  {
    id: 'feedback_style',
    category: 'collaboration',
    prompts: {
      ko: '내가 리뷰나 피드백을 줄 때 어떤 톤이 좋아?',
      ja: 'レビューやフィードバックはどんなトーンがいい?',
      zh: '我给评审或反馈时，你喜欢什么语气?',
      en: 'What tone do you want when I give you feedback?',
    },
    options: [
      {
        id: 'blunt',
        labels: {
          ko: '직설적·근거 위주',
          ja: '率直・根拠重視',
          zh: '直接、以依据为主',
          en: 'Blunt and evidence-first',
        },
        learn: {
          key: 'feedback-style',
          statement: {
            ko: '피드백은 직설적이고 근거 위주로 주기를 원한다.',
            ja: 'フィードバックは率直かつ根拠重視で欲しい。',
            zh: '希望反馈直接、以依据为主。',
            en: 'Wants feedback delivered bluntly and grounded in evidence.',
          },
          tags: [],
        },
      },
      {
        id: 'gentle',
        labels: {
          ko: '부드럽게',
          ja: 'やわらかく',
          zh: '委婉一些',
          en: 'Gently',
        },
        learn: {
          key: 'feedback-style',
          statement: {
            ko: '피드백은 부드러운 톤으로 주기를 원한다.',
            ja: 'フィードバックはやわらかいトーンで欲しい。',
            zh: '希望反馈用委婉的语气。',
            en: 'Wants feedback delivered in a gentle tone.',
          },
          tags: [],
        },
      },
      {
        id: 'concise',
        labels: {
          ko: '요점만 빠르게',
          ja: '要点だけ手早く',
          zh: '只讲要点',
          en: 'Just the key points',
        },
        learn: {
          key: 'feedback-style',
          statement: {
            ko: '피드백은 군더더기 없이 요점만 빠르게 주기를 원한다.',
            ja: 'フィードバックは無駄なく要点だけ手早く欲しい。',
            zh: '希望反馈干脆利落，只讲要点。',
            en: 'Wants feedback kept to the key points, no filler.',
          },
          tags: [],
        },
      },
    ],
  },
  {
    id: 'secondary_topic',
    category: 'interest',
    prompts: {
      ko: '주 종목 말고, 또 관심 가는 보안 분야가 있어?',
      ja: 'メイン以外で、他に関心のあるセキュリティ分野は?',
      zh: '主攻方向之外，你还关注哪个安全领域?',
      en: 'Beyond your main focus, which security area also draws you?',
    },
    options: [
      {
        id: 'cloud_infra',
        labels: {
          ko: '클라우드·인프라 보안',
          ja: 'クラウド・インフラ',
          zh: '云/基础设施安全',
          en: 'Cloud / infra security',
        },
        learn: {
          key: 'secondary-topic',
          statement: {
            ko: '클라우드·인프라 보안 분야에도 관심이 있다.',
            ja: 'クラウド・インフラのセキュリティ分野にも関心がある。',
            zh: '也关注云和基础设施安全领域。',
            en: 'Also drawn to cloud and infrastructure security.',
          },
          // No generic interest tag: the entities below seed the topic cleanly
          // (type=preference already makes them eligible), avoiding a spurious
          // Windows-security topic from a broad `security` tag.
          tags: [],
          entities: ['cloud security', 'infrastructure security'],
        },
      },
      {
        id: 'web_app',
        labels: {
          ko: '웹·앱 취약점',
          ja: 'Web・アプリ脆弱性',
          zh: 'Web/应用漏洞',
          en: 'Web / app vulnerabilities',
        },
        learn: {
          key: 'secondary-topic',
          statement: {
            ko: '웹·앱 취약점 분야에도 관심이 있다.',
            ja: 'Web・アプリの脆弱性分野にも関心がある。',
            zh: '也关注 Web 和应用漏洞领域。',
            en: 'Also drawn to web and application vulnerability research.',
          },
          tags: [],
          entities: ['web security', 'application security'],
        },
      },
      {
        id: 'cryptography',
        labels: {
          ko: '암호학',
          ja: '暗号学',
          zh: '密码学',
          en: 'Cryptography',
        },
        learn: {
          key: 'secondary-topic',
          statement: {
            ko: '암호학 분야에도 관심이 있다.',
            ja: '暗号学の分野にも関心がある。',
            zh: '也关注密码学领域。',
            en: 'Also drawn to cryptography.',
          },
          tags: [],
          entities: ['cryptography'],
        },
      },
      {
        id: 'ai_security',
        labels: {
          ko: 'AI·ML 보안',
          ja: 'AI・MLセキュリティ',
          zh: 'AI/ML 安全',
          en: 'AI / ML security',
        },
        learn: {
          key: 'secondary-topic',
          statement: {
            ko: 'AI·ML 보안 분야에도 관심이 있다.',
            ja: 'AI・MLセキュリティの分野にも関心がある。',
            zh: '也关注 AI/ML 安全领域。',
            en: 'Also drawn to AI and machine learning security.',
          },
          tags: [],
          entities: ['AI security', 'machine learning security'],
        },
      },
    ],
  },
  {
    id: 'code_form',
    category: 'work_style',
    prompts: {
      ko: '코드를 줄 때 어떤 형태가 제일 좋아?',
      ja: 'コードを渡すとき、どの形が一番いい?',
      zh: '我给代码时，你最喜欢哪种形式?',
      en: 'When I give you code, what form do you prefer?',
    },
    options: [
      {
        id: 'full_integrated',
        labels: {
          ko: '전체 통합 코드',
          ja: '完全な統合コード',
          zh: '完整整合代码',
          en: 'Full integrated code',
        },
        learn: {
          key: 'code-form',
          statement: {
            ko: '코드는 부분 조각보다 전체 통합 코드를 원한다.',
            ja: 'コードは断片よりも完全な統合コードを望む。',
            zh: '相比片段，更想要完整整合的代码。',
            en: 'Wants full integrated code over partial fragments.',
          },
          tags: [],
        },
      },
      {
        id: 'minimal_snippet',
        labels: {
          ko: '최소 스니펫만',
          ja: '最小限のスニペット',
          zh: '最小片段',
          en: 'Minimal snippet only',
        },
        learn: {
          key: 'code-form',
          statement: {
            ko: '코드는 요점을 담은 최소 스니펫만 원한다.',
            ja: 'コードは要点を押さえた最小限のスニペットだけ望む。',
            zh: '只想要抓住要点的最小片段。',
            en: 'Wants only a minimal snippet that captures the point.',
          },
          tags: [],
        },
      },
      {
        id: 'step_by_step',
        labels: {
          ko: '단계별 설명 위주',
          ja: 'ステップ解説中心',
          zh: '以分步讲解为主',
          en: 'Step-by-step explanation',
        },
        learn: {
          key: 'code-form',
          statement: {
            ko: '코드보다 단계별 설명 위주로 받기를 원한다.',
            ja: 'コードよりステップごとの解説中心で受け取りたい。',
            zh: '相比代码，更想以分步讲解为主。',
            en: 'Wants a step-by-step explanation over raw code.',
          },
          tags: [],
        },
      },
    ],
  },
  {
    id: 'game_taste',
    category: 'personal',
    prompts: {
      ko: '게임은 어떤 쪽을 즐겨?',
      ja: 'ゲームはどんなジャンルが好き?',
      zh: '你喜欢玩哪类游戏?',
      en: 'What kind of games do you enjoy?',
    },
    options: [
      {
        id: 'competitive_fps',
        labels: {
          ko: '경쟁·FPS',
          ja: '対戦・FPS',
          zh: '竞技/FPS',
          en: 'Competitive / FPS',
        },
        learn: {
          key: 'game-taste',
          statement: {
            ko: '게임은 경쟁성 있는 FPS 쪽을 즐긴다.',
            ja: 'ゲームは対戦系のFPSを好む。',
            zh: '喜欢竞技类 FPS 游戏。',
            en: 'Enjoys competitive FPS games.',
          },
          tags: [],
        },
      },
      {
        id: 'rpg_story',
        labels: {
          ko: 'RPG·스토리',
          ja: 'RPG・ストーリー',
          zh: 'RPG/剧情',
          en: 'RPG / story-driven',
        },
        learn: {
          key: 'game-taste',
          statement: {
            ko: '게임은 스토리 중심 RPG 쪽을 즐긴다.',
            ja: 'ゲームはストーリー重視のRPGを好む。',
            zh: '喜欢剧情向的 RPG 游戏。',
            en: 'Enjoys story-driven RPGs.',
          },
          tags: [],
        },
      },
      {
        id: 'strategy_sim',
        labels: {
          ko: '전략·시뮬',
          ja: '戦略・シミュ',
          zh: '策略/模拟',
          en: 'Strategy / sim',
        },
        learn: {
          key: 'game-taste',
          statement: {
            ko: '게임은 전략·시뮬레이션 쪽을 즐긴다.',
            ja: 'ゲームは戦略・シミュレーションを好む。',
            zh: '喜欢策略/模拟类游戏。',
            en: 'Enjoys strategy and simulation games.',
          },
          tags: [],
        },
      },
      {
        id: 'indie_puzzle',
        labels: {
          ko: '인디·퍼즐',
          ja: 'インディー・パズル',
          zh: '独立/解谜',
          en: 'Indie / puzzle',
        },
        learn: {
          key: 'game-taste',
          statement: {
            ko: '게임은 인디·퍼즐 쪽을 즐긴다.',
            ja: 'ゲームはインディー・パズルを好む。',
            zh: '喜欢独立/解谜类游戏。',
            en: 'Enjoys indie and puzzle games.',
          },
          tags: [],
        },
      },
    ],
  },
  {
    id: 'aoi_proactivity',
    category: 'collaboration',
    prompts: {
      ko: '내가 먼저 나서서 제안하는 걸 얼마나 원해?',
      ja: '私から先に提案するのはどのくらい望む?',
      zh: '你希望我主动提出建议到什么程度?',
      en: 'How proactive do you want me to be with suggestions?',
    },
    options: [
      {
        id: 'proactive',
        labels: {
          ko: '적극적으로 제안해줘',
          ja: '積極的に提案して',
          zh: '积极主动提议',
          en: 'Suggest proactively',
        },
        learn: {
          key: 'aoi-proactivity',
          statement: {
            ko: 'Aoi가 먼저 적극적으로 제안하고 나서 주기를 원한다.',
            ja: 'Aoiが先に積極的に提案してくれることを望む。',
            zh: '希望我主动积极地提出建议。',
            en: 'Wants me to step in and suggest things proactively.',
          },
          tags: [],
        },
      },
      {
        id: 'on_request',
        labels: {
          ko: '물어보면 그때',
          ja: '聞かれたら',
          zh: '问了再说',
          en: 'Only when asked',
        },
        learn: {
          key: 'aoi-proactivity',
          statement: {
            ko: 'Aoi는 물어봤을 때만 의견을 주기를 원한다.',
            ja: 'Aoiは聞かれたときだけ意見を出してほしい。',
            zh: '希望我只在被问到时才给意见。',
            en: 'Wants me to offer input only when asked.',
          },
          tags: [],
        },
      },
      {
        id: 'quiet',
        labels: {
          ko: '조용히 대기',
          ja: '静かに待機',
          zh: '安静待命',
          en: 'Stay quiet',
        },
        learn: {
          key: 'aoi-proactivity',
          statement: {
            ko: 'Aoi는 대체로 조용히 대기하다가 필요할 때만 나서기를 원한다.',
            ja: 'Aoiは基本静かに待機し、必要なときだけ動いてほしい。',
            zh: '希望我大多安静待命，只在需要时才出手。',
            en: 'Wants me to stay quiet by default and step in only when needed.',
          },
          tags: [],
        },
      },
    ],
  },
  {
    id: 'work_rhythm',
    category: 'work_style',
    prompts: {
      ko: '집중 작업은 어떤 리듬으로 하는 편이야?',
      ja: '集中作業はどんなリズムでやる?',
      zh: '专注工作时你偏好什么节奏?',
      en: 'What rhythm do you tend to work in?',
    },
    options: [
      {
        id: 'deep_sessions',
        labels: {
          ko: '긴 몰입 세션',
          ja: '長い没入セッション',
          zh: '长时间深度投入',
          en: 'Long deep sessions',
        },
        learn: {
          key: 'work-rhythm',
          statement: {
            ko: '집중 작업은 길게 몰입하는 세션 방식으로 하는 편이다.',
            ja: '集中作業は長く没入するセッション型でやる傾向がある。',
            zh: '专注工作时偏好长时间深度投入。',
            en: 'Tends to work in long, deeply focused sessions.',
          },
          tags: [],
        },
      },
      {
        id: 'short_bursts',
        labels: {
          ko: '짧게 자주',
          ja: '短く頻繁に',
          zh: '短时高频',
          en: 'Short frequent bursts',
        },
        learn: {
          key: 'work-rhythm',
          statement: {
            ko: '집중 작업은 짧게 자주 나눠서 하는 편이다.',
            ja: '集中作業は短く頻繁に分けてやる傾向がある。',
            zh: '专注工作时偏好短时、高频地分段进行。',
            en: 'Tends to work in short, frequent bursts.',
          },
          tags: [],
        },
      },
      {
        id: 'deadline_driven',
        labels: {
          ko: '마감 압박형',
          ja: '締切ドリブン',
          zh: '截止驱动',
          en: 'Deadline-driven',
        },
        learn: {
          key: 'work-rhythm',
          statement: {
            ko: '집중 작업은 마감 압박이 있을 때 몰아서 하는 편이다.',
            ja: '集中作業は締切のプレッシャーがあるとまとめてやる傾向がある。',
            zh: '专注工作时偏好在截止压力下集中冲刺。',
            en: 'Tends to push work through under deadline pressure.',
          },
          tags: [],
        },
      },
    ],
  },
  {
    id: 'content_flavor',
    category: 'personal',
    prompts: {
      ko: '즐겨 보는 기술 콘텐츠는 어떤 주제야?',
      ja: 'よく見る技術コンテンツはどんなテーマ?',
      zh: '你常看的技术内容偏哪个主题?',
      en: 'What tech content do you enjoy following?',
    },
    options: [
      {
        id: 'security_hacking',
        labels: {
          ko: '보안·해킹',
          ja: 'セキュリティ・ハッキング',
          zh: '安全/黑客',
          en: 'Security / hacking',
        },
        learn: {
          key: 'content-flavor',
          statement: {
            ko: '즐겨 보는 기술 콘텐츠는 보안·해킹 주제 쪽이다.',
            ja: 'よく見る技術コンテンツはセキュリティ・ハッキング系。',
            zh: '常看的技术内容偏安全/黑客主题。',
            en: 'Enjoys following security and hacking content.',
          },
          tags: [],
        },
      },
      {
        id: 'game_dev',
        labels: {
          ko: '게임 개발',
          ja: 'ゲーム開発',
          zh: '游戏开发',
          en: 'Game development',
        },
        learn: {
          key: 'content-flavor',
          statement: {
            ko: '즐겨 보는 기술 콘텐츠는 게임 개발 주제 쪽이다.',
            ja: 'よく見る技術コンテンツはゲーム開発系。',
            zh: '常看的技术内容偏游戏开发主题。',
            en: 'Enjoys following game development content.',
          },
          tags: [],
        },
      },
      {
        id: 'low_level',
        labels: {
          ko: '시스템·저수준',
          ja: 'システム・低レベル',
          zh: '系统/底层',
          en: 'Systems / low-level',
        },
        learn: {
          key: 'content-flavor',
          statement: {
            ko: '즐겨 보는 기술 콘텐츠는 시스템·저수준 주제 쪽이다.',
            ja: 'よく見る技術コンテンツはシステム・低レベル系。',
            zh: '常看的技术内容偏系统/底层主题。',
            en: 'Enjoys following systems and low-level content.',
          },
          tags: [],
        },
      },
      {
        id: 'science_math',
        labels: {
          ko: '과학·수학',
          ja: '科学・数学',
          zh: '科学/数学',
          en: 'Science / math',
        },
        learn: {
          key: 'content-flavor',
          statement: {
            ko: '즐겨 보는 기술 콘텐츠는 과학·수학 주제 쪽이다.',
            ja: 'よく見る技術コンテンツは科学・数学系。',
            zh: '常看的技术内容偏科学/数学主题。',
            en: 'Enjoys following science and math content.',
          },
          tags: [],
        },
      },
    ],
  },
  {
    id: 'automation_level',
    category: 'collaboration',
    prompts: {
      ko: '반복 작업은 얼마나 자동으로 밀어붙이는 게 좋아?',
      ja: '繰り返し作業はどれくらい自動で進めていい?',
      zh: '重复性工作，你希望自动推进到什么程度?',
      en: 'How aggressively should I automate repetitive work?',
    },
    options: [
      {
        id: 'aggressive',
        labels: {
          ko: '적극 자동화',
          ja: '積極的に自動化',
          zh: '积极自动化',
          en: 'Automate aggressively',
        },
        learn: {
          key: 'automation-level',
          statement: {
            ko: '반복 작업은 적극적으로 자동화해서 밀어붙이는 방식을 원한다.',
            ja: '繰り返し作業は積極的に自動化して進める方式を望む。',
            zh: '希望积极自动化并推进重复性工作。',
            en: 'Wants repetitive work pushed forward with aggressive automation.',
          },
          tags: [],
        },
      },
      {
        id: 'semi_auto',
        labels: {
          ko: '반자동 (중간 확인)',
          ja: '半自動(途中で確認)',
          zh: '半自动(中途确认)',
          en: 'Semi-auto with checkpoints',
        },
        learn: {
          key: 'automation-level',
          statement: {
            ko: '자동화하되 중간에 확인 단계를 두는 반자동 방식을 원한다.',
            ja: '自動化しつつ途中に確認段階を挟む半自動を望む。',
            zh: '希望半自动：自动化但保留中途确认步骤。',
            en: 'Wants semi-automation with confirmation checkpoints in between.',
          },
          tags: [],
        },
      },
      {
        id: 'manual_control',
        labels: {
          ko: '수동 제어 선호',
          ja: '手動制御を好む',
          zh: '偏好手动控制',
          en: 'Prefer manual control',
        },
        learn: {
          key: 'automation-level',
          statement: {
            ko: '중요한 작업은 수동으로 제어하는 방식을 원한다.',
            ja: '重要な作業は手動で制御する方式を望む。',
            zh: '希望重要工作保持手动控制。',
            en: 'Wants to keep important work under manual control.',
          },
          tags: [],
        },
      },
    ],
  },
  {
    id: 'learning_source',
    category: 'work_style',
    prompts: {
      ko: '새 기술 배울 때 어떤 자료를 제일 선호해?',
      ja: '新しい技術を学ぶとき、どの資料が一番好き?',
      zh: '学新技术时你最喜欢哪种资料?',
      en: 'When learning something new, which source do you prefer?',
    },
    options: [
      {
        id: 'official_docs',
        labels: {
          ko: '공식 문서',
          ja: '公式ドキュメント',
          zh: '官方文档',
          en: 'Official docs',
        },
        learn: {
          key: 'learning-source',
          statement: {
            ko: '새 기술을 배울 때 공식 문서를 가장 선호한다.',
            ja: '新しい技術を学ぶとき公式ドキュメントを最も好む。',
            zh: '学新技术时最喜欢看官方文档。',
            en: 'Learns new tech best from official documentation.',
          },
          tags: [],
        },
      },
      {
        id: 'source_code',
        labels: {
          ko: '소스코드 직접',
          ja: 'ソースコード直読み',
          zh: '直接读源码',
          en: 'The source code',
        },
        learn: {
          key: 'learning-source',
          statement: {
            ko: '새 기술을 배울 때 소스코드를 직접 읽는 것을 가장 선호한다.',
            ja: '新しい技術を学ぶときソースコードを直接読むのを最も好む。',
            zh: '学新技术时最喜欢直接读源码。',
            en: 'Learns new tech best by reading the source code directly.',
          },
          tags: [],
        },
      },
      {
        id: 'articles',
        labels: {
          ko: '블로그·튜토리얼',
          ja: 'ブログ・チュートリアル',
          zh: '博客/教程',
          en: 'Blogs / tutorials',
        },
        learn: {
          key: 'learning-source',
          statement: {
            ko: '새 기술을 배울 때 블로그나 튜토리얼을 가장 선호한다.',
            ja: '新しい技術を学ぶときブログやチュートリアルを最も好む。',
            zh: '学新技术时最喜欢看博客或教程。',
            en: 'Learns new tech best from blogs and tutorials.',
          },
          tags: [],
        },
      },
      {
        id: 'videos',
        labels: {
          ko: '영상 강의',
          ja: '動画講座',
          zh: '视频课程',
          en: 'Video courses',
        },
        learn: {
          key: 'learning-source',
          statement: {
            ko: '새 기술을 배울 때 영상 강의를 가장 선호한다.',
            ja: '新しい技術を学ぶとき動画講座を最も好む。',
            zh: '学新技术时最喜欢看视频课程。',
            en: 'Learns new tech best from video courses.',
          },
          tags: [],
        },
      },
    ],
  },
  {
    id: 'verification_rigor',
    category: 'work_style',
    prompts: {
      ko: '변경 후 검증은 어느 정도로 챙기는 게 좋아?',
      ja: '変更後の検証はどこまで徹底したい?',
      zh: '改动之后，验证要做到什么程度?',
      en: 'After a change, how much verification do you want?',
    },
    options: [
      {
        id: 'always_full',
        labels: {
          ko: '항상 테스트+빌드 강제',
          ja: '常にテスト+ビルド必須',
          zh: '始终强制测试+构建',
          en: 'Always test + build',
        },
        learn: {
          key: 'verification-rigor',
          statement: {
            ko: '변경 후에는 항상 테스트와 빌드 검증을 강제하기를 원한다.',
            ja: '変更後は常にテストとビルド検証を必須にすることを望む。',
            zh: '希望每次改动后都强制运行测试和构建验证。',
            en: 'Wants tests and a build enforced after every change.',
          },
          tags: [],
        },
      },
      {
        id: 'core_only',
        labels: {
          ko: '핵심 경로만',
          ja: '主要パスだけ',
          zh: '只验核心路径',
          en: 'Core paths only',
        },
        learn: {
          key: 'verification-rigor',
          statement: {
            ko: '변경 후 핵심 경로 위주로만 검증하기를 원한다.',
            ja: '変更後は主要パス中心に検証することを望む。',
            zh: '希望改动后主要验证核心路径。',
            en: 'Wants verification focused on the core paths only.',
          },
          tags: [],
        },
      },
      {
        id: 'fast_iteration',
        labels: {
          ko: '빠른 반복 우선',
          ja: '速い反復を優先',
          zh: '优先快速迭代',
          en: 'Favor fast iteration',
        },
        learn: {
          key: 'verification-rigor',
          statement: {
            ko: '검증보다 빠른 반복을 우선하기를 원한다.',
            ja: '検証よりも速い反復を優先することを望む。',
            zh: '希望优先快速迭代，其次才是验证。',
            en: 'Wants to favor fast iteration over heavy verification.',
          },
          tags: [],
        },
      },
    ],
  },
];

// --- Lookups -----------------------------------------------------------------

export function findPreferenceQuestion(
  questionId: string,
  extraQuestions: readonly PreferencePollQuestion[] = [],
): PreferencePollQuestion | null {
  return allPreferenceQuestions(extraQuestions).find((item) => item.id === questionId) ?? null;
}

export function findPreferenceOption(
  questionId: string,
  optionId: string,
  extraQuestions: readonly PreferencePollQuestion[] = [],
): PreferencePollOption | null {
  const question = findPreferenceQuestion(questionId, extraQuestions);
  return question?.options.find((item) => item.id === optionId) ?? null;
}

// The stable preference key a question maps to (shared by all its options).
export function getPreferenceQuestionPrefKey(
  questionId: string,
  extraQuestions: readonly PreferencePollQuestion[] = [],
): string | null {
  return findPreferenceQuestion(questionId, extraQuestions)?.options[0]?.learn.key ?? null;
}

// First question the user has not answered yet, in bank order (seed then generated).
export function pickNextPreferenceQuestion(
  state: AoiPreferencePollState | null | undefined,
  extraQuestions: readonly PreferencePollQuestion[] = [],
): PreferencePollQuestion | null {
  const base = normalizePreferenceState(state);
  return (
    allPreferenceQuestions(extraQuestions).find((question) => !(question.id in base.answers)) ??
    null
  );
}

// Count of questions the user has not answered yet (seed + generated). Used to
// decide when Aoi should expand the bank.
export function countUnansweredPreferenceQuestions(
  state: AoiPreferencePollState | null | undefined,
  extraQuestions: readonly PreferencePollQuestion[] = [],
): number {
  const base = normalizePreferenceState(state);
  return allPreferenceQuestions(extraQuestions).filter((question) => !(question.id in base.answers))
    .length;
}

// --- Gating ------------------------------------------------------------------

export interface ShouldAskPreferenceQuestionInput {
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

// Should Aoi ask a preference question right now? Mirrors the taste-poll gates:
// autonomy on, not quiet, nothing else pending, idle long enough, cooldown clear.
export function shouldAskPreferenceQuestion(input: ShouldAskPreferenceQuestionInput): boolean {
  if (!input.autonomyEnabled || input.quietMode || input.otherOfferPending) {
    return false;
  }
  if (!input.hasUnansweredQuestion) {
    return false;
  }
  if (typeof input.userIdleMs !== 'number' || !Number.isFinite(input.userIdleMs)) {
    return false;
  }
  if (input.userIdleMs < (input.minIdleMs ?? PREFERENCE_POLL_MIN_IDLE_MS)) {
    return false;
  }
  const cooldownMs = input.cooldownMs ?? PREFERENCE_POLL_COOLDOWN_MS;
  if (input.lastAskedAt > 0 && input.now - input.lastAskedAt < cooldownMs) {
    return false;
  }
  return true;
}

// --- State transitions -------------------------------------------------------

// Stamp that a poll was shown (starts the cooldown even if never answered).
export function recordPreferenceQuestionAsked(
  state: AoiPreferencePollState | null | undefined,
  params: { now: number },
): AoiPreferencePollState {
  return { ...normalizePreferenceState(state), lastAskedAt: params.now };
}

// Fold an answer in. Unknown question/option ids are ignored (a stale pending
// poll from storage must not corrupt the profile). Generated questions must be
// passed via extraQuestions or their answers would be rejected. Never mutates.
export function recordPreferenceAnswer(
  state: AoiPreferencePollState | null | undefined,
  params: { questionId: string; optionId: string },
  extraQuestions: readonly PreferencePollQuestion[] = [],
): AoiPreferencePollState {
  const base = normalizePreferenceState(state);
  const option = findPreferenceOption(params.questionId, params.optionId, extraQuestions);
  if (!option) {
    return base;
  }
  return {
    ...base,
    answers: { ...base.answers, [params.questionId]: params.optionId },
  };
}

// Drop an answer (dashboard "clear"). Unknown ids are a no-op. Never mutates.
export function clearPreferenceAnswer(
  state: AoiPreferencePollState | null | undefined,
  params: { questionId: string },
): AoiPreferencePollState {
  const base = normalizePreferenceState(state);
  if (!(params.questionId in base.answers)) {
    return base;
  }
  const answers = { ...base.answers };
  delete answers[params.questionId];
  return { ...base, answers };
}

// --- Memory derivation -------------------------------------------------------

// The `pref:` tag that keys a question's taste memory, e.g. pref:taste.focus-area.
export function tastePrefTag(prefKey: string): string {
  return `pref:taste.${prefKey}`;
}

// Build the structured `preference` memory candidate for one answered option, so
// ChatPanel can persist it and let it flow into the preference prompt block (and,
// for `interest` category questions only, into the interest profile). Returns
// null for unknown ids.
export function buildPreferencePollMemoryCandidate(
  params: {
    questionId: string;
    optionId: string;
    lang: AoiPreferenceLang;
  },
  extraQuestions: readonly PreferencePollQuestion[] = [],
): AoiMemoryCandidate | null {
  const question = findPreferenceQuestion(params.questionId, extraQuestions);
  const option = question?.options.find((item) => item.id === params.optionId);
  if (!question || !option) {
    return null;
  }
  const learn = option.learn;
  const isInterest = optionRoutesToInterest(option);
  const tags = Array.from(
    new Set([
      'preference',
      'taste-poll',
      'explicit-save',
      tastePrefTag(learn.key),
      ...learn.tags,
      // Non-interest tastes are marked so the interest profile excludes them;
      // they still inform the preference prompt block.
      ...(isInterest ? [] : [PREFERENCE_ONLY_TAG]),
    ]),
  ).slice(0, 10);
  // Only interest-routing options carry topic-seeding entities; the rest stay
  // preference-only (no entities that could surface as interest topics).
  const entities = isInterest ? Array.from(new Set(learn.entities ?? [])).slice(0, 10) : [];
  return {
    scope: 'user',
    type: 'preference',
    content: learn.statement[params.lang],
    confidence: 0.86,
    importance: 0.8,
    permanent: true,
    tags,
    entities,
  };
}

// --- Memory supersede / forget selection -------------------------------------

function sessionMatches(memorySessionPath: string | undefined, sessionPath: string): boolean {
  if (!sessionPath || !memorySessionPath) {
    return true;
  }
  return memorySessionPath === sessionPath;
}

// Active taste memories for `prefTag` whose content differs from the new answer:
// these are the prior picks to supersede when the user changes an answer, so the
// store never holds two contradictory picks for one question. Same-content
// re-answers are excluded (the merge path dedupes them in place).
export function selectStaleTasteMemoryIds(
  memories: readonly AoiMemoryEntry[],
  params: { prefTag: string; newNormalizedContent: string; sessionPath: string },
): string[] {
  return memories
    .filter(
      (memory) =>
        memory.status === 'active' &&
        memory.tags.includes(params.prefTag) &&
        memory.normalizedContent !== params.newNormalizedContent &&
        sessionMatches(memory.sessionPath, params.sessionPath),
    )
    .map((memory) => memory.id);
}

// Active taste memories for `prefTag`: these are archived when the user clears an
// answer in the dashboard so it stops influencing judgments.
export function selectTasteMemoryIdsToForget(
  memories: readonly AoiMemoryEntry[],
  params: { prefTag: string; sessionPath: string },
): string[] {
  return memories
    .filter(
      (memory) =>
        memory.status === 'active' &&
        memory.tags.includes(params.prefTag) &&
        sessionMatches(memory.sessionPath, params.sessionPath),
    )
    .map((memory) => memory.id);
}

// --- Persistence -------------------------------------------------------------

const PREFERENCE_POLL_STORAGE_KEY = 'aoi-preference-poll-v1';

function normalizePreferenceState(
  state: AoiPreferencePollState | null | undefined,
): AoiPreferencePollState {
  if (!state || state.version !== AOI_PREFERENCE_POLL_STATE_VERSION) {
    return { ...DEFAULT_AOI_PREFERENCE_POLL_STATE, answers: {} };
  }
  return state;
}

export function loadAoiPreferencePollState(): AoiPreferencePollState {
  try {
    const raw = localStorage.getItem(PREFERENCE_POLL_STORAGE_KEY);
    if (!raw) {
      return normalizePreferenceState(null);
    }
    const parsed = JSON.parse(raw) as Partial<AoiPreferencePollState> | null;
    if (
      parsed &&
      parsed.version === AOI_PREFERENCE_POLL_STATE_VERSION &&
      typeof parsed.answers === 'object' &&
      parsed.answers !== null
    ) {
      return {
        version: AOI_PREFERENCE_POLL_STATE_VERSION,
        answers: Object.fromEntries(
          Object.entries(parsed.answers).filter(([, value]) => typeof value === 'string'),
        ) as Record<string, string>,
        lastAskedAt: typeof parsed.lastAskedAt === 'number' ? parsed.lastAskedAt : 0,
      };
    }
  } catch {
    // Malformed storage; start clean.
  }
  return normalizePreferenceState(null);
}

export function saveAoiPreferencePollState(state: AoiPreferencePollState): void {
  try {
    localStorage.setItem(PREFERENCE_POLL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort persistence; ignore quota / privacy-mode failures.
  }
}
