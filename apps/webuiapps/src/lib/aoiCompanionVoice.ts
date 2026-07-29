// Companion-voice core: the single persona register for user-facing Aoi copy.
//
// Bond rule (JARVIS relationship roadmap R1): everywhere the user is addressed,
// ONE persona speaks -- first person, casual register, localized. Today the
// same character speaks in three registers: warm casual nudges (ChatPanel),
// English-only brief hooks with raw scores (aoiProactiveBriefResearch), and
// formal third-person trend takes (aoiProactiveTrendAdvisor). This module is
// the pure copy layer that unifies them. Callers keep gating/telemetry/audit
// fields untouched -- the register boundary is: companion copy (chat, cards,
// nudges, greetings) renders here; audit/ledger/evidence text stays neutral
// ASCII English in its own modules.
//
// Register contract (enforced by tests):
// - always first person; never third-person self-reference ("Aoi trend signal")
// - never the noun "operator" for the user
// - never raw internal scores ("confidence 0.80")
// - Korean uses the persona's casual register, never formal endings
// Korean and English are fully authored. Japanese/Chinese are authored for
// short labels and fall back to English for longer prose, mirroring
// aoiAutonomyCardI18n.

import type { AoiCardLang } from './aoiAutonomyCardI18n';
import type { AoiProactiveBriefMediaBucket } from './aoiAutonomyTypes';

export interface AoiCompanionVoice {
  lang: AoiCardLang;
  // Optional display name for direct address (greetings). Used sparingly.
  userName?: string;
}

interface CompanionCopyTable {
  ko: string;
  en: string;
  ja?: string;
  zh?: string;
}

// Defensive input normalization: companion copy interpolates labels/titles that
// originate from stored candidates, so strip control chars, collapse
// whitespace, and cap length before composing. Every caller states its own cap
// because the sensible limit differs per surface (a host list is not a title).
function sanitizeCompanionText(value: string | null | undefined, maxChars: number): string {
  const collapsed = (value ?? '')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function pickCompanionCopy(lang: AoiCardLang, table: CompanionCopyTable): string {
  if (lang === 'ko') {
    return table.ko;
  }
  if (lang === 'ja' && table.ja) {
    return table.ja;
  }
  if (lang === 'zh' && table.zh) {
    return table.zh;
  }
  return table.en;
}

function sanitizedUserName(voice: AoiCompanionVoice): string {
  return sanitizeCompanionText(voice.userName, 40);
}

// --- Proactive brief ---------------------------------------------------------

export interface AoiCompanionBriefHookParams {
  topicLabel: string;
  sourceCount: number;
  mediaBucket?: AoiProactiveBriefMediaBucket | null;
}

function briefFlavor(
  lang: AoiCardLang,
  bucket: AoiProactiveBriefMediaBucket | null | undefined,
): string {
  const bucketKey: AoiProactiveBriefMediaBucket = bucket ?? 'mixed';
  const tables: Record<AoiProactiveBriefMediaBucket, CompanionCopyTable> = {
    watch: { ko: '볼만한 영상 쪽 자료', en: 'things worth watching' },
    listen: { ko: '들어볼 만한 자료', en: 'things worth a listen' },
    read: { ko: '읽어볼 만한 자료', en: 'things worth reading' },
    mixed: { ko: '볼만한 공개 자료', en: 'things worth a look' },
  };
  return pickCompanionCopy(lang, tables[bucketKey]);
}

// The hook line for a proactive brief card: replaces the English
// "I found N public sources that may be worth a quick look for {topic}."
export function buildAoiCompanionBriefHook(
  voice: AoiCompanionVoice,
  params: AoiCompanionBriefHookParams,
): string {
  const topic = sanitizeCompanionText(params.topicLabel, 80);
  const count = Number.isFinite(params.sourceCount)
    ? Math.max(0, Math.floor(params.sourceCount))
    : 0;
  const flavor = briefFlavor(voice.lang, params.mediaBucket);
  if (voice.lang === 'ko') {
    if (count > 0) {
      return `네가 관심 있어 하던 ${topic} 쪽에 ${flavor} ${count}개 찾아뒀어.`;
    }
    return `네가 관심 있어 하던 ${topic} 쪽에 봐둘 만한 게 있어.`;
  }
  if (count > 0) {
    return `Found ${count} ${flavor} on ${topic} -- the kind of thing you keep digging into.`;
  }
  return `Spotted something on ${topic} you might want to see.`;
}

// The direct-chat invitation built on top of the hook: replaces
// "{hook} Open the brief if you want the sources."
export function buildAoiCompanionBriefChatHook(
  voice: AoiCompanionVoice,
  params: AoiCompanionBriefHookParams,
): string {
  const hook = buildAoiCompanionBriefHook(voice, params);
  const invite = pickCompanionCopy(voice.lang, {
    ko: '열어볼래? 출처도 같이 정리해뒀어.',
    en: 'Want me to open it? Sources are lined up.',
  });
  return `${hook} ${invite}`;
}

export interface AoiCompanionBriefReasonParams {
  interestKind?: 'professional' | 'personal' | null;
}

// Why this brief exists, in relationship terms: replaces the raw-score line
// "This matches a saved interest topic with confidence 0.80 and current-info
// preference 0.70." on user-facing surfaces. The scored record itself stays in
// the audit layer.
export function buildAoiCompanionBriefReason(
  voice: AoiCompanionVoice,
  params: AoiCompanionBriefReasonParams,
): string {
  if (params.interestKind === 'personal') {
    return pickCompanionCopy(voice.lang, {
      ko: '네가 좋아하는 쪽이라 골라왔어. 새로 나온 것 위주로 봤어.',
      en: 'Picked this because you like this stuff -- I leaned toward what is new.',
    });
  }
  return pickCompanionCopy(voice.lang, {
    ko: '네가 계속 파고 있던 주제라서 골라왔어. 흐름 놓치기 싫어할 것 같아서.',
    en: 'Picked this because you keep digging into it -- figured you would not want to miss what is moving.',
  });
}

// --- Trend opinion card ------------------------------------------------------

export type AoiCompanionTrendTakeKind =
  | 'default_watch'
  | 'stale_refresh'
  | 'weak_source'
  | 'review_candidate';

// First-person takes for the trend card, replacing the formal-register
// templates in the trend advisor.
export function buildAoiCompanionTrendTake(
  voice: AoiCompanionVoice,
  kind: AoiCompanionTrendTakeKind,
): string {
  const tables: Record<AoiCompanionTrendTakeKind, CompanionCopyTable> = {
    default_watch: {
      ko: '일단 지켜보는 게 좋겠어. 쓸만한 신호긴 한데 대화 끊을 정도는 아니야.',
      en: 'Worth parking as a watch item -- useful signal, not worth an interruption by itself.',
    },
    stale_refresh: {
      ko: '출처 근거가 새로고침되기 전엔 이걸 최신 정보로 안 칠 거야.',
      en: 'I would not treat this as current until the source evidence refreshes.',
    },
    weak_source: {
      ko: '독립적인 두 번째 출처가 나오기 전까진 약한 신호야.',
      en: 'This stays a weak signal until a second independent source shows up.',
    },
    review_candidate: {
      ko: '짧게 훑어볼 만해. 출처도 붙어 있고 네 관심사랑도 맞아.',
      en: 'Looks worth a short review -- it has sources and it matches what you care about.',
    },
  };
  return pickCompanionCopy(voice.lang, tables[kind]);
}

export function buildAoiCompanionTrendNextAction(
  voice: AoiCompanionVoice,
  kind: AoiCompanionTrendTakeKind,
): string {
  const tables: Record<AoiCompanionTrendTakeKind, CompanionCopyTable> = {
    default_watch: {
      ko: '편할 때 출처 열어보고 유용한지 노이즈인지 표시해줘.',
      en: 'Open the sources when convenient and mark it useful or noisy.',
    },
    stale_refresh: {
      ko: '움직이기 전에 스카우트 한 번 더 돌리거나 다음 새로고침 기다려줘.',
      en: 'Run the scout again or wait for the next refresh before acting on it.',
    },
    weak_source: {
      ko: '대시보드에만 두고 직접 대화로 격상하진 말자.',
      en: 'Keep it on the dashboard -- no direct-chat escalation yet.',
    },
    review_candidate: {
      ko: '출처 훑어보고 각도가 진짜 유효하면 유용으로 표시해줘.',
      en: 'Skim the sources and mark it useful if the angle actually holds.',
    },
  };
  return pickCompanionCopy(voice.lang, tables[kind]);
}

// Fallback for a trend card's "what changed" line, used only when the
// candidate carries neither a novelty reason nor a summary. The populated case
// stays as-is: those are factual source descriptions, not companion copy.
export function buildAoiCompanionTrendWhatChanged(
  voice: AoiCompanionVoice,
  params: { topicLabel: string },
): string {
  const topic = sanitizeCompanionText(params.topicLabel, 80);
  if (voice.lang === 'ko') {
    return `${topic} 쪽에 새로 뜬 게 있어. 출처 있는 것만 골랐어.`;
  }
  return `Something new turned up on ${topic}, and I only kept what has sources.`;
}

export interface AoiCompanionTrendHookParams {
  topicLabel: string;
  title: string;
  take: string;
  sourceHosts: string[];
}

// The direct-chat line for a trend card: replaces the third-person
// "Aoi trend signal for {topic}: ..." framing with first person.
export function buildAoiCompanionTrendHook(
  voice: AoiCompanionVoice,
  params: AoiCompanionTrendHookParams,
): string {
  const topic = sanitizeCompanionText(params.topicLabel, 80);
  const title = sanitizeCompanionText(params.title, 120);
  const take = sanitizeCompanionText(params.take, 200);
  const hosts = params.sourceHosts
    .map((host) => sanitizeCompanionText(host, 60))
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
  const hostsLabel =
    hosts || pickCompanionCopy(voice.lang, { ko: '공개 출처', en: 'public sources' });
  if (voice.lang === 'ko') {
    return `${topic} 쪽에 눈에 띄는 게 하나 있어: ${title}. 내 생각엔 — ${take} 출처는 ${hostsLabel} 쪽이야.`;
  }
  return `Something worth your eye on ${topic}: ${title}. My take -- ${take} Sources: ${hostsLabel}.`;
}

// --- Resume (returning after idle) -------------------------------------------

export interface AoiCompanionResumeParams {
  idleMs: number;
}

export function buildAoiCompanionResumeTitle(voice: AoiCompanionVoice): string {
  return pickCompanionCopy(voice.lang, {
    ko: '잠깐 사이에 있었던 일',
    en: 'While you were away',
    ja: '留守の間にあったこと',
    zh: '你不在的这会儿',
  });
}

// Time-gap-aware first line for the resume card. Replaces the compliance-card
// framing with the persona speaking; the caller still renders whatChanged /
// nextSafeAction content beneath it.
export function buildAoiCompanionResumeGreeting(
  voice: AoiCompanionVoice,
  params: AoiCompanionResumeParams,
): string {
  const idleMs = Number.isFinite(params.idleMs) ? Math.max(0, params.idleMs) : 0;
  const hours = Math.floor(idleMs / 3_600_000);
  let gap: string;
  if (hours < 1) {
    gap = pickCompanionCopy(voice.lang, {
      ko: '잠깐 자리 비웠었네.',
      en: 'Back already.',
    });
  } else if (hours < 8) {
    gap = pickCompanionCopy(voice.lang, {
      ko: `${hours}시간 만이네.`,
      en: `Back after ${hours}h.`,
    });
  } else {
    gap = pickCompanionCopy(voice.lang, {
      ko: '오랜만이야.',
      en: 'Been a while.',
    });
  }
  const name = sanitizedUserName(voice);
  return name ? `${name}, ${gap}` : gap;
}

export interface AoiCompanionSessionGreetingParams {
  // Time since the last session, used to pick the opener.
  gapMs: number;
  // What the last session was about, if anything was stored. Referencing it is
  // the strongest "she remembers" signal, so it is included when present.
  lastSessionSummary?: string;
}

const MAX_GREETING_SUMMARY_CHARS = 120;

// Opening line for a session that has shared history behind it. Replaces the
// static first-meeting prologue, which repeated verbatim every time the chat
// history was empty -- including after clearing it, when the relationship
// itself was still on record.
export function buildAoiCompanionSessionGreeting(
  voice: AoiCompanionVoice,
  params: AoiCompanionSessionGreetingParams,
): string {
  const gapMs = Number.isFinite(params.gapMs) ? Math.max(0, params.gapMs) : 0;
  const hours = gapMs / 3_600_000;
  let opener: string;
  if (hours < 12) {
    opener = pickCompanionCopy(voice.lang, { ko: '또 왔네.', en: 'Back again.' });
  } else if (hours < 48) {
    opener = pickCompanionCopy(voice.lang, {
      ko: '어제 이후로 처음이네.',
      en: 'First time since yesterday.',
    });
  } else {
    opener = pickCompanionCopy(voice.lang, { ko: '오랜만이야.', en: 'Been a while.' });
  }
  const name = sanitizedUserName(voice);
  const greeting = name ? `${name}, ${opener}` : opener;
  const summary = sanitizeCompanionText(params.lastSessionSummary, MAX_GREETING_SUMMARY_CHARS);
  if (!summary) {
    return greeting;
  }
  if (voice.lang === 'ko') {
    return `${greeting} 지난번엔 ${summary} 쪽 보고 있었어.`;
  }
  return `${greeting} Last time we were on ${summary}.`;
}

export interface AoiCompanionRetrospectiveParams {
  landedCount: number;
  stuckCount: number;
  openCount: number;
}

// One line offering the week just composed. It reports counts rather than
// retelling the whole retrospective: the panel holds the detail, and the
// greeting only has room to say it exists and is worth opening.
export function buildAoiCompanionRetrospectiveNote(
  voice: AoiCompanionVoice,
  params: AoiCompanionRetrospectiveParams,
): string {
  const landed = Math.max(0, Math.floor(params.landedCount || 0));
  const stuck = Math.max(0, Math.floor(params.stuckCount || 0));
  const open = Math.max(0, Math.floor(params.openCount || 0));
  if (landed === 0 && stuck === 0 && open === 0) {
    return '';
  }
  if (voice.lang === 'ko') {
    return `지난 한 주 정리해뒀어 — 끝낸 게 ${landed}개, 막힌 게 ${stuck}개, 아직 남은 게 ${open}개.`;
  }
  return `I put together our week -- ${landed} landed, ${stuck} stuck, ${open} still open.`;
}

export type AoiCompanionMilestoneKind =
  | 'first_met'
  | 'session_count'
  | 'trust_promoted'
  | 'first_accepted_proposal'
  | 'arc_completed';

export interface AoiCompanionMilestoneParams {
  kind: AoiCompanionMilestoneKind;
  // Sessions together, for the session-count milestone.
  sessionCount?: number;
  // Autonomy level reached, for the trust milestone.
  level?: string;
}

// Mentions a milestone that was crossed just now. Only ever spoken on the
// crossing itself -- a partner notes the hundredth session once, not every time.
export function buildAoiCompanionMilestoneNote(
  voice: AoiCompanionVoice,
  params: AoiCompanionMilestoneParams,
): string {
  if (params.kind === 'session_count') {
    const count =
      typeof params.sessionCount === 'number' && Number.isFinite(params.sessionCount)
        ? Math.max(0, Math.floor(params.sessionCount))
        : 0;
    if (count <= 0) {
      return '';
    }
    if (voice.lang === 'ko') {
      return `그러고 보니 우리 벌써 ${count}번째네.`;
    }
    return `That makes ${count} sessions together, by the way.`;
  }
  if (params.kind === 'trust_promoted') {
    const level = sanitizeCompanionText(params.level, 8);
    if (!level) {
      return '';
    }
    if (voice.lang === 'ko') {
      return `${level}까지 맡겨준 것도 기억하고 있어.`;
    }
    return `I have not forgotten you trusted me up to ${level}.`;
  }
  if (params.kind === 'first_accepted_proposal') {
    return pickCompanionCopy(voice.lang, {
      ko: '내 제안 처음 받아준 날이기도 해.',
      en: 'It is also the first time you took one of my suggestions.',
    });
  }
  if (params.kind === 'arc_completed') {
    return pickCompanionCopy(voice.lang, {
      ko: '우리 사이도 그때랑 좀 달라졌지.',
      en: 'Things between us are not quite what they were, either.',
    });
  }
  // first_met is the greeting's own premise; restating it would be odd.
  return '';
}

// Asks about one thread left unresolved last time. Following up on unfinished
// work is the strongest "she was paying attention" signal, which is also why at
// most one is ever raised and never twice (see aoiRelationshipThreads).
export function buildAoiCompanionThreadFollowUp(
  voice: AoiCompanionVoice,
  params: { title: string },
): string {
  const title = sanitizeCompanionText(params.title, 100);
  if (!title) {
    return '';
  }
  if (voice.lang === 'ko') {
    return `그런데 ${title} 그거 어떻게 됐어?`;
  }
  return `Also -- how did ${title} turn out?`;
}

// The safety boundary, spoken in-voice with the exact same meaning as the
// compliance sentence it replaces: nothing is approved, executed, run,
// researched, created, or edited without explicit approval.
export function buildAoiCompanionResumeSafetyNote(voice: AoiCompanionVoice): string {
  return pickCompanionCopy(voice.lang, {
    ko: '네 승인 없이는 아무것도 안 움직여 — 실행, 도구, 리서치, Kira 작업, 파일 수정 전부 네가 허락해야 해.',
    en: 'Nothing moves without your explicit approval -- no execution, tools, research, Kira work, or file edits.',
  });
}

// --- Brief feedback actions ---------------------------------------------------

export type AoiCompanionFeedbackActionKind =
  | 'useful'
  | 'show_less'
  | 'wrong_timing'
  | 'wrong_source'
  | 'mute_topic'
  | 'open_sources'
  | 'archive_brief'
  | 'expand_summary';

export interface AoiCompanionFeedbackActionCopy {
  label: string;
  title: string;
}

// Feedback chips on the brief card: the label is the short chip text, the
// title is the tooltip. First person -- Aoi says what SHE will do with the
// feedback, instead of "Tell Aoi ...". The wrong_source tooltip keeps the
// authority clarification (source trust never touches execute authority).
export function buildAoiCompanionFeedbackAction(
  voice: AoiCompanionVoice,
  action: AoiCompanionFeedbackActionKind,
): AoiCompanionFeedbackActionCopy {
  const labels: Record<AoiCompanionFeedbackActionKind, CompanionCopyTable> = {
    useful: { ko: '유용해', en: 'Useful', ja: '役に立った', zh: '有用' },
    show_less: { ko: '덜 보여줘', en: 'Less', ja: '控えめに', zh: '少来点' },
    wrong_timing: { ko: '타이밍 별로', en: 'Timing', ja: 'タイミングが微妙', zh: '时机不对' },
    wrong_source: { ko: '출처 별로', en: 'Source', ja: '出典が微妙', zh: '来源不行' },
    mute_topic: { ko: '이 주제 그만', en: 'Mute', ja: 'このテーマは休止', zh: '静音主题' },
    open_sources: { ko: '출처 보기', en: 'Sources', ja: '出典を見る', zh: '查看来源' },
    archive_brief: { ko: '보관', en: 'Archive', ja: '保管', zh: '归档' },
    expand_summary: { ko: '자세히', en: 'Details', ja: '詳しく', zh: '详情' },
  };
  const titles: Record<AoiCompanionFeedbackActionKind, CompanionCopyTable> = {
    useful: {
      ko: '좋았다고 기억해둘게. 이런 쪽 더 챙길게.',
      en: 'I will remember this landed -- more like this.',
    },
    show_less: {
      ko: '이 주제는 한동안 덜 가져올게.',
      en: 'I will bring this topic up less for a while.',
    },
    wrong_timing: {
      ko: '다음엔 타이밍 봐서 가져올게.',
      en: 'I will watch the timing next time.',
    },
    wrong_source: {
      ko: '이 출처들 신뢰는 낮출게. 실행 권한이랑은 무관해.',
      en: 'I will trust these sources less -- execute authority is untouched.',
    },
    mute_topic: {
      ko: '이 주제는 당분간 안 가져올게.',
      en: 'I will stop bringing this topic up.',
    },
    open_sources: {
      ko: '외부 링크는 안 열고 목록만 펼칠게.',
      en: 'Expands the list without opening external URLs.',
    },
    archive_brief: {
      ko: '이 브리프는 보관해둘게.',
      en: 'I will archive this brief.',
    },
    expand_summary: {
      ko: '요약이랑 근거를 펼쳐줄게.',
      en: 'Expands the summary and evidence.',
    },
  };
  return {
    label: pickCompanionCopy(voice.lang, labels[action]),
    title: pickCompanionCopy(voice.lang, titles[action]),
  };
}

// --- Register-contract helpers (exported for tests + future guard reuse) ------

// Formal Korean endings the companion register never uses. Matching the '니다'
// / '세요' / '십시오' terminators covers every polite conjugation (including
// '바랍니다', which an explicit '습니다|입니다|합니다' list would miss) while
// staying clear of the casual forms the persona does use ('표시해줘', '기다려줘').
const FORBIDDEN_KOREAN_FORMAL = /(니다|세요|십시오)/;
// Third-person self-reference / user-as-operator / raw score leakage.
const FORBIDDEN_REGISTER = /(\bAoi\b|\boperator\b|confidence\s+\d|preference\s+\d\.\d)/i;

export function violatesAoiCompanionRegister(text: string): boolean {
  return FORBIDDEN_REGISTER.test(text) || FORBIDDEN_KOREAN_FORMAL.test(text);
}
