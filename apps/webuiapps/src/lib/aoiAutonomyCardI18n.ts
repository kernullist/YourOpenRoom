// Localization for the Aoi proactive proposal card. The global i18n layer
// (src/i18) drops Korean to English because 'ko' is not in ENABLE_LOCALES, so the
// card cannot use it for Korean users. This module mirrors the ChatPanel nudge
// pattern instead: a small language code (ko|ja|zh|en) resolved directly from the
// app language setting, with a lang-keyed string table.
//
// Korean and English are fully authored. Japanese/Chinese fall back to English
// for now (the immediate requirement is Korean); adding them later only means
// filling the `ja`/`zh` branches -- callers and the type already carry them.

import type { AoiAutonomyRisk, AoiFailureKind } from './aoiAutonomyTypes';

export type AoiCardLang = 'ko' | 'ja' | 'zh' | 'en';

// Preserve Korean deliberately: normalizeLang() in @/i18 maps 'ko' -> 'en'
// because Korean is not an enabled global locale. The card must not inherit that
// fallback, so it resolves the language itself from the raw locale string.
export function normalizeAoiCardLang(value: string | null | undefined): AoiCardLang {
  const lower = (value ?? '').trim().toLowerCase();
  if (lower.startsWith('ko')) {
    return 'ko';
  }
  if (lower.startsWith('ja')) {
    return 'ja';
  }
  if (lower.startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}

// Resolve a { ko, en } pair for the active language. Japanese/Chinese fall back
// to English until their strings are authored.
function pick(lang: AoiCardLang, table: { ko: string; en: string }): string {
  return lang === 'ko' ? table.ko : table.en;
}

// Detect the card language from free text (e.g. the latest user message) by
// script. Mirrors the chat's own reply-language detection so proposals are
// authored in the same language the user is conversing in. Empty/Latin text ->
// 'en'. Used server-side by the autonomy tick, which receives latestUserMessage
// but has no browser locale.
export function detectAoiCardLangFromText(text: string | null | undefined): AoiCardLang {
  const value = text ?? '';
  if (/[가-힣]/.test(value)) {
    return 'ko';
  }
  if (/[぀-ヿ]/.test(value)) {
    return 'ja';
  }
  if (/[一-鿿]/.test(value)) {
    return 'zh';
  }
  return 'en';
}

export type AoiCardConfidenceKey =
  | 'low_evidence'
  | 'moderate_confidence'
  | 'good_confidence'
  | 'blocked_by_policy'
  | 'blocked_limited_evidence';

export function aoiCardConfidenceLabel(lang: AoiCardLang, key: AoiCardConfidenceKey): string {
  const table: Record<AoiCardConfidenceKey, { ko: string; en: string }> = {
    low_evidence: { ko: '근거 부족', en: 'low evidence' },
    moderate_confidence: { ko: '보통 확신', en: 'moderate confidence' },
    good_confidence: { ko: '높은 확신', en: 'good confidence' },
    blocked_by_policy: { ko: '정책상 차단됨', en: 'blocked by policy' },
    blocked_limited_evidence: {
      ko: '근거 부족으로 차단됨',
      en: 'blocked with limited evidence',
    },
  };
  return pick(lang, table[key]);
}

export function aoiCardRiskLabel(lang: AoiCardLang, risk: AoiAutonomyRisk): string {
  const table: Record<AoiAutonomyRisk, { ko: string; en: string }> = {
    low: { ko: '낮은 위험', en: 'low risk' },
    medium: { ko: '중간 위험', en: 'medium risk' },
    high: { ko: '높은 위험', en: 'high risk' },
  };
  return pick(lang, table[risk]);
}

export function aoiCardEvidenceLabel(lang: AoiCardLang, count: number): string {
  return lang === 'ko' ? `근거 ${count}건` : `evidence ${count}`;
}

export function aoiCardEvidenceSummary(lang: AoiCardLang, count: number): string {
  if (count <= 0) {
    return pick(lang, {
      ko: '근거 부족: 아직 첨부된 근거 참조가 없습니다.',
      en: 'Limited evidence: no evidence refs are attached yet.',
    });
  }
  if (lang === 'ko') {
    return `근거 ${count}건 첨부됨; 자세한 내용은 패널에 있습니다.`;
  }
  const noun = count === 1 ? 'evidence ref' : 'evidence refs';
  return `${count} ${noun} attached; details stay in the panel.`;
}

export type AoiCardApproveActionKey =
  | 'start_research'
  | 'create_kira_work'
  | 'save_memory'
  | 'read_research_artifact'
  | 'search_web'
  | 'record_review'
  | 'record_approval';

export function aoiCardApproveActionPhrase(
  lang: AoiCardLang,
  key: AoiCardApproveActionKey,
): string {
  const table: Record<AoiCardApproveActionKey, { ko: string; en: string }> = {
    start_research: { ko: '리서치 실행을 시작', en: 'start a research run' },
    create_kira_work: {
      ko: '검토된 Kira 작업 항목 하나를 생성',
      en: 'create one reviewed Kira work item',
    },
    save_memory: { ko: '메모리 노트를 저장', en: 'save a memory note' },
    read_research_artifact: { ko: '해당 리서치 보고서를 열람', en: 'read that research report' },
    search_web: { ko: '간단한 웹 검색을 실행', en: 'run a quick web search' },
    record_review: { ko: '이 검토를 기록', en: 'record this review' },
    record_approval: { ko: '이 승인을 기록', en: 'record this approval' },
  };
  return pick(lang, table[key]);
}

// "{subject} {whyNow} Approve to {approveAction}." with the connective localized.
export function aoiCardMessageSummary(
  lang: AoiCardLang,
  parts: { subjectSentence: string; whyNow: string; approveActionPhrase: string },
): string {
  const whyNow = parts.whyNow ? `${parts.whyNow} ` : '';
  if (lang === 'ko') {
    return `${parts.subjectSentence} ${whyNow}승인하면 ${parts.approveActionPhrase}합니다.`;
  }
  return `${parts.subjectSentence} ${whyNow}Approve to ${parts.approveActionPhrase}.`;
}

export function aoiCardLimitedEvidencePrefix(lang: AoiCardLang, reason: string): string {
  return lang === 'ko' ? `근거 부족: ${reason}` : `Limited evidence: ${reason}`;
}

export type AoiCardApprovalBoundaryKey =
  | 'create_kira_work'
  | 'start_research'
  | 'save_memory'
  | 'high_risk'
  | 'requires_approval'
  | 'display_only';

export function aoiCardApprovalBoundary(
  lang: AoiCardLang,
  key: AoiCardApprovalBoundaryKey,
): string {
  const table: Record<AoiCardApprovalBoundaryKey, { ko: string; en: string }> = {
    create_kira_work: {
      ko: '파일을 직접 수정하지 않습니다. 승인은 검토된 Kira 작업 항목 하나만 생성합니다.',
      en: 'I will not edit files directly; approval only creates one reviewed Kira work item.',
    },
    start_research: {
      ko: '명시적 승인 없이는 리서치 실행을 시작하지 않습니다.',
      en: 'I will not start a research run without explicit approval.',
    },
    save_memory: {
      ko: '명시적 승인 없이는 메모리를 승격하거나 스킬 초안을 만들지 않습니다.',
      en: 'I will not promote memory or create a skill draft without explicit approval.',
    },
    high_risk: {
      ko: '고위험 작업은 어떤 동작 전에도 새로운 명시적 승인이 필요합니다.',
      en: 'High-risk work needs fresh explicit approval before any action.',
    },
    requires_approval: {
      ko: '명시적 승인 없이는 도구를 실행하거나 상태를 바꾸지 않습니다.',
      en: 'I will not run tools or change state without explicit approval.',
    },
    display_only: {
      ko: '이 설명은 도구를 실행하거나 상태를 바꾸지 않습니다.',
      en: 'This explanation does not run tools or change state.',
    },
  };
  return pick(lang, table[key]);
}

export type AoiCardWhatChangedKey =
  | 'blocked_gate'
  | 'recovery_available'
  | 'attention_broker'
  | 'kira_outcome_followup'
  | 'goal_continuation'
  | 'incomplete_evidence'
  | 'generic';

export function aoiCardWhatChanged(
  lang: AoiCardLang,
  key: AoiCardWhatChangedKey,
  params: { failureKind?: string; triggerLabel?: string } = {},
): string {
  switch (key) {
    case 'blocked_gate':
      return pick(lang, {
        ko: '정책 또는 근거 게이트가 다음 단계를 막고 있습니다.',
        en: 'A policy or evidence gate is blocking the next step.',
      });
    case 'recovery_available':
      return lang === 'ko'
        ? `${params.failureKind ?? '실패'} 이후 더 좁은 복구 제안이 준비되었습니다.`
        : `A narrower recovery proposal is available after ${params.failureKind ?? 'a failure'}.`;
    case 'attention_broker':
      return pick(lang, {
        ko: '백그라운드 이벤트가 검토할 만한 제안을 떠올렸습니다.',
        en: 'A background event surfaced a proposal worth reviewing.',
      });
    case 'kira_outcome_followup':
      return pick(lang, {
        ko: '검토된 Kira 작업이 후속 노트 하나를 남겼습니다.',
        en: 'Reviewed Kira work produced one follow-up note.',
      });
    case 'goal_continuation':
      return pick(lang, {
        ko: '진행 중인 목표에 제안된 다음 단계가 있습니다.',
        en: 'The active goal has a proposed next step.',
      });
    case 'incomplete_evidence':
      return pick(lang, {
        ko: '제안은 있으나 뒷받침 근거가 아직 부족합니다.',
        en: 'A proposal exists, but supporting evidence is incomplete.',
      });
    case 'generic':
    default:
      return lang === 'ko'
        ? `${params.triggerLabel ?? '백그라운드 점검'} 제안이 검토 준비되었습니다.`
        : `A ${params.triggerLabel ?? 'background check'} proposal is ready for review.`;
  }
}

// Card chrome consumed by ChatPanel (chips, buttons, hints).
export type AoiCardChromeKey =
  | 'proposal_chip'
  | 'pause_family'
  | 'details'
  | 'hint_fallback'
  | 'approve_fallback'
  | 'approve_fallback_title';

export function aoiCardChromeLabel(lang: AoiCardLang, key: AoiCardChromeKey): string {
  const table: Record<AoiCardChromeKey, { ko: string; en: string }> = {
    proposal_chip: { ko: 'Aoi 제안', en: 'Aoi proposal' },
    pause_family: { ko: '이 제안 계열 잠시 멈춤', en: 'Pause suggestion family' },
    details: { ko: '자세히', en: 'Details' },
    hint_fallback: {
      ko: '이것은 제안일 뿐입니다. 실행된 도구가 없습니다.',
      en: 'This is only a proposal. No tool has run.',
    },
    approve_fallback: { ko: '정확한 동작 승인', en: 'Approve exact action' },
    approve_fallback_title: {
      ko: '도구 실행 없이 이 제안을 승인 기록합니다.',
      en: 'Record approval without executing tools',
    },
  };
  return pick(lang, table[key]);
}

// Feedback controls (label + hover title) keyed by category, mirroring
// AOI_PROPOSAL_FEEDBACK_CONTROLS in ChatPanel.
export type AoiCardFeedbackCategory =
  | 'useful'
  | 'too_much'
  | 'wrong_timing'
  | 'wrong_evidence'
  | 'wrong_source'
  | 'unsafe';

// category is intentionally a loose string: the ChatPanel feedback controls use
// AoiProposalFeedbackCategory, which has more members than the card localizes.
// Unknown categories return the supplied English fallback (the control's own
// label/title), so nothing renders blank.
export function aoiCardFeedbackLabel(
  lang: AoiCardLang,
  category: string,
  fallback?: string,
): string {
  const table: Partial<Record<string, { ko: string; en: string }>> = {
    useful: { ko: '유용함', en: 'Useful' },
    too_much: { ko: '너무 많음', en: 'Too much' },
    wrong_timing: { ko: '타이밍이 안 맞음', en: 'Wrong timing' },
    wrong_evidence: { ko: '근거가 틀림', en: 'Wrong evidence' },
    wrong_source: { ko: '출처 선택이 틀림', en: 'Wrong source' },
    unsafe: { ko: '안전하지 않음', en: 'Unsafe' },
  };
  const entry = table[category];
  return entry ? pick(lang, entry) : (fallback ?? category);
}

export function aoiCardFeedbackTitle(
  lang: AoiCardLang,
  category: string,
  fallback?: string,
): string {
  const table: Partial<Record<string, { ko: string; en: string }>> = {
    useful: {
      ko: '이 선제 제안을 유용하다고 표시',
      en: 'Mark this proactive suggestion as useful',
    },
    too_much: {
      ko: '너무 많아서 이 제안을 잠시 멈춤',
      en: 'Snooze this suggestion because it is too much',
    },
    wrong_timing: {
      ko: '타이밍이 안 맞아 이 제안을 잠시 멈춤',
      en: 'Snooze this suggestion because the timing is wrong',
    },
    wrong_evidence: {
      ko: '근거가 틀려서 이 제안을 무시',
      en: 'Dismiss this suggestion because the evidence is wrong',
    },
    wrong_source: {
      ko: '출처 선택이 틀려서 이 제안을 무시',
      en: 'Dismiss this suggestion because the source selection is wrong',
    },
    unsafe: {
      ko: '향후 보정을 위해 안전하지 않은 제안으로 무시',
      en: 'Dismiss this suggestion as unsafe for future calibration',
    },
  };
  const entry = table[category];
  return entry ? pick(lang, entry) : (fallback ?? category);
}

// Deterministic (non-LLM) proposal title/body/reason. Threaded into the engine
// builders so a deterministic proposal card is authored in the operator's
// language, matching the LLM-authored path. `body` is empty for proposals whose
// body is not a fixed string (research_followup interpolates the topic via
// {topic}; kira_attention shows the raw memory content) -- the builder composes
// those. Unlocalized languages fall back to English.
export type AoiCardProposalTextKey =
  | 'research_followup'
  | 'stale_research'
  | 'procedure_candidate'
  | 'repeated_research'
  | 'repeated_kira'
  | 'kira_attention';

export function aoiCardProposalText(
  lang: AoiCardLang,
  key: AoiCardProposalTextKey,
): { title: string; body: string; reason: string } {
  const table: Record<
    AoiCardProposalTextKey,
    {
      title: { ko: string; en: string };
      body: { ko: string; en: string };
      reason: { ko: string; en: string };
    }
  > = {
    research_followup: {
      title: { ko: '일치하는 Aoi 리서치 보고서 열기', en: 'Open the matching Aoi research report' },
      body: {
        ko: '현재 주제와 관련 있어 보이는 완료된 리서치 실행이 있습니다: {topic}',
        en: 'A completed research run looks relevant to the current topic: {topic}',
      },
      reason: {
        ko: '최근 사용자 메시지가 완료된 Aoi 리서치 실행과 겹칩니다.',
        en: 'The latest user message overlaps with a completed Aoi research run.',
      },
    },
    stale_research: {
      title: { ko: '오래된 Aoi 리서치 새로고침', en: 'Refresh stale Aoi research' },
      body: {
        ko: '일치하는 리서치 메모리가 최신 정보 질문용 신선도 기준보다 오래되었습니다.',
        en: 'The matching research memory is older than the freshness window for current-information questions.',
      },
      reason: {
        ko: '사용자가 최신 정보를 필요로 하는 것으로 보이나, 관련 리서치 메모리가 오래되었습니다.',
        en: 'The user appears to need current information, but the relevant research memory is stale.',
      },
    },
    procedure_candidate: {
      title: { ko: '재사용 가능한 Aoi 절차로 저장', en: 'Save this as a reusable Aoi procedure' },
      body: {
        ko: '최근 요청이 반복 워크플로나 선호처럼 보여 절차로 저장할 만합니다.',
        en: 'The latest request sounds like a repeated workflow or preference that may be worth saving as a procedure.',
      },
      reason: {
        ko: '반복 워크플로는 명시적 사용자 승인 후에만 승격해야 합니다.',
        en: 'Repeated workflows should be promoted only after explicit user approval.',
      },
    },
    repeated_research: {
      title: {
        ko: '반복된 리서치 워크플로 절차 승격',
        en: 'Promote repeated research workflow procedure',
      },
      body: {
        ko: '승인 게이트가 걸린 재사용 절차로 승격할 수 있는 성공적인 리서치 메모리가 여러 개 있습니다.',
        en: 'Aoi has multiple successful research memories that can be promoted into an approval-gated reusable procedure.',
      },
      reason: {
        ko: '반복된 성공 리서치 워크플로는 명시적 사용자 승인 후에만 영구화해야 합니다.',
        en: 'Repeated successful research workflows should become durable only after explicit user approval.',
      },
    },
    repeated_kira: {
      title: {
        ko: '반복된 Kira 리뷰 워크플로 절차 승격',
        en: 'Promote repeated Kira review workflow procedure',
      },
      body: {
        ko: '재사용 절차로 승격할 수 있는 검토된 Kira 완료 메모리가 여러 개 있습니다.',
        en: 'Aoi has multiple reviewed Kira completion memories that can be promoted into a reusable procedure.',
      },
      reason: {
        ko: '반복된 성공 Kira 결과는 명시적 승인이 있을 때만 절차 메모리로 저장해야 합니다.',
        en: 'Repeated successful Kira outcomes should be saved as procedure memory only with explicit approval.',
      },
    },
    kira_attention: {
      title: { ko: '대기 중인 Kira 자동화 검토', en: 'Review waiting Kira automation' },
      body: { ko: '', en: '' },
      reason: {
        ko: 'Kira에 사용자 주의가 필요할 수 있는 자동화 결과가 저장되어 있습니다.',
        en: 'Kira has a stored automation outcome that may need user attention.',
      },
    },
  };
  const entry = table[key];
  return {
    title: pick(lang, entry.title),
    body: pick(lang, entry.body),
    reason: pick(lang, entry.reason),
  };
}

// Failure-recovery proposal card text (title/body/reason), keyed by failure
// kind. Mirrors the English strings in aoiAutonomyRecovery.ts so the recovery
// card -- the most common deterministic card -- is authored in the operator's
// language. Unlocalized languages fall back to English.
export function aoiCardRecoveryText(
  lang: AoiCardLang,
  failureKind: AoiFailureKind,
  params: { sourceRef: string },
): { title: string; body: string; reason: string } {
  const labels: Record<AoiFailureKind, { ko: string; en: string }> = {
    policy_blocked: { ko: '명확화 한 가지 질문', en: 'Ask one clarification' },
    missing_evidence: { ko: '누락된 근거 요청', en: 'Ask for missing evidence' },
    scope_too_broad: { ko: '범위 좁히기', en: 'Narrow scope' },
    stale_confirmation: { ko: '확인 갱신', en: 'Refresh confirmation' },
    research_failed: { ko: '리서치 좁혀서 재시도', en: 'Refresh research narrowly' },
    research_insufficient_sources: {
      ko: '출처 점검하며 리서치 재시도',
      en: 'Refresh research with source check',
    },
    kira_needs_clarification: { ko: 'Kira 명확화 질문', en: 'Ask Kira clarification' },
    kira_validation_failed: { ko: 'Kira 후속 준비', en: 'Prepare Kira follow-up' },
    kira_review_blocked: { ko: '리뷰 후속 준비', en: 'Prepare review follow-up' },
    execution_exception: { ko: '사유와 함께 차단 표시', en: 'Mark blocked with reason' },
  };
  const needs: Record<AoiFailureKind, { ko: string; en: string }> = {
    policy_blocked: {
      ko: '새로운 명시적 승인 또는 정책상 안전한 대안',
      en: 'fresh explicit approval or a policy-safe alternative',
    },
    missing_evidence: {
      ko: '최소 하나의 구체적 근거 참조',
      en: 'at least one concrete evidence reference',
    },
    scope_too_broad: { ko: '더 작은 작업 경계 하나', en: 'one smaller task boundary' },
    stale_confirmation: { ko: '새로운 사용자 확인', en: 'fresh user confirmation' },
    research_failed: {
      ko: '더 작은 소스 예산과 재시도 한계',
      en: 'a smaller source budget and a retry boundary',
    },
    research_insufficient_sources: {
      ko: '주장을 뒷받침할 충분한 수용 출처',
      en: 'enough accepted sources to support the claim',
    },
    kira_needs_clarification: {
      ko: 'Kira가 계속하기 전 명확화 하나',
      en: 'one clarification before Kira continues',
    },
    kira_validation_failed: {
      ko: '실패한 Kira 작업의 검증 근거',
      en: 'validation evidence for the failed Kira task',
    },
    kira_review_blocked: {
      ko: '차단된 Kira 작업의 리뷰 근거',
      en: 'review evidence for the blocked Kira task',
    },
    execution_exception: { ko: '더 작은 확정된 다음 단계', en: 'a smaller confirmed next step' },
  };
  const need = pick(lang, needs[failureKind]);
  const body =
    lang === 'ko'
      ? `검증에 ${need}이(가) 필요해서 실패했습니다. 더 좁은 후속을 준비하거나, 질문 하나를 하거나, 멈출 수 있습니다.`
      : `That failed because validation needs ${need}. I can prepare a narrower follow-up, ask one question, or stop.`;
  const reason =
    lang === 'ko'
      ? `Aoi가 ${params.sourceRef}을(를) ${failureKind}로 분류하고 제한된 복구 동작을 찾았습니다.`
      : `Aoi classified ${params.sourceRef} as ${failureKind} and found a bounded recovery action.`;
  return { title: pick(lang, labels[failureKind]), body, reason };
}

// Goal proposal card text (goal_candidate / goal_continuation). Interpolated
// values (the user's objective text and plan step titles) are passed through
// verbatim -- only the surrounding template is localized. Unlocalized languages
// fall back to English.
export function aoiCardGoalTrackPrefix(lang: AoiCardLang, title: string): string {
  return lang === 'ko' ? `목표 추적: ${title}` : `Track goal: ${title}`;
}

export function aoiCardGoalContinuePrefix(lang: AoiCardLang, stepTitle: string): string {
  return lang === 'ko' ? `목표 계속: ${stepTitle}` : `Continue goal: ${stepTitle}`;
}

export function aoiCardGoalText(
  lang: AoiCardLang,
  key: 'from_user' | 'candidate',
): { body: string; reason: string } {
  if (key === 'from_user') {
    return {
      body: pick(lang, {
        ko: 'Aoi가 이 목표를 기억하고, 근거 기반의 작은 계획을 유지하며, 기존 승인 흐름을 통해서만 후속을 제안할 수 있습니다.',
        en: 'Aoi can remember this objective, keep a small evidence-backed plan, and propose continuations only through the existing approval flow.',
      }),
      reason: pick(lang, {
        ko: '최근 사용자 메시지가 다단계 목표를 추적/관리해 달라고 명시적으로 요청합니다.',
        en: 'The latest user message explicitly asks Aoi to track or manage a multi-step objective.',
      }),
    };
  }
  return {
    body: pick(lang, {
      ko: 'Aoi가 최근 활동에서 반복되는 패턴을 발견해 목표로 추적할 것을 제안합니다. 승인하면 근거 기반의 작은 목표가 활성화되며, 후속은 여전히 기존 승인 흐름을 거칩니다.',
      en: 'Aoi noticed a recurring pattern in recent activity and suggests tracking it as an objective. Approving activates a small evidence-backed goal; continuations still go through the existing approval flow.',
    }),
    reason: pick(lang, {
      ko: '최근 관찰 전반의 반복 신호가 추적할 만한 다단계 목표를 시사합니다.',
      en: 'Recurring signals across recent observations suggest a multi-step objective worth tracking.',
    }),
  };
}

export function aoiCardGoalContinuationBody(
  lang: AoiCardLang,
  params: { goalTitle: string; stepTitle: string },
): string {
  return lang === 'ko'
    ? `Aoi가 "${params.goalTitle}"을(를) 추적 중입니다. 다음 제안 단계: ${params.stepTitle}.`
    : `Aoi is tracking "${params.goalTitle}". The next proposed step is: ${params.stepTitle}.`;
}

export function aoiCardGoalContinuationReason(lang: AoiCardLang, blocked: boolean): string {
  if (blocked) {
    return pick(lang, {
      ko: '진행 중인 목표가 근거로 인해 막혀 있어 더 작은 후속 결정이 필요합니다.',
      en: 'The active goal is blocked by evidence and needs a smaller continuation decision.',
    });
  }
  return pick(lang, {
    ko: '진행 중인 목표에 근거 기반 계획의 대기 단계가 있습니다.',
    en: 'The active goal has a pending evidence-backed plan step.',
  });
}

// Status-level action presentation text. The inline proactive card only ever
// renders these status branches (the kind-specific accepted-flow branches belong
// to the post-approval Advanced panel), so localizing these covers the card.
export type AoiCardActionPresentationKey = 'blocked' | 'executed' | 'active' | 'unavailable';

export function aoiCardActionPresentationText(
  lang: AoiCardLang,
  key: AoiCardActionPresentationKey,
  params: { status?: string } = {},
): { primaryLabel: string; primaryTitle: string; mutationBoundary: string } {
  if (key === 'active') {
    return {
      primaryLabel: pick(lang, { ko: '정확한 동작 승인', en: 'Approve exact action' }),
      primaryTitle: pick(lang, {
        ko: '이 제안을 그대로 승인 기록합니다. 도구는 실행되지 않고 파일도 수정되지 않습니다.',
        en: 'Record approval for this exact proposal. No tools run and no files are edited.',
      }),
      mutationBoundary: pick(lang, {
        ko: '승인만 기록합니다. 도구를 실행하거나 파일을 수정하지 않습니다.',
        en: 'Records approval only. It does not run tools or edit files.',
      }),
    };
  }
  if (key === 'blocked') {
    return {
      primaryLabel: pick(lang, { ko: '근거 보기', en: 'Show evidence' }),
      primaryTitle: pick(lang, {
        ko: '정책 사유, 누락된 근거, 안전한 대안을 표시합니다.',
        en: 'Show policy reasons, missing evidence, and a safe alternative.',
      }),
      mutationBoundary: pick(lang, {
        ko: '이 제안이 차단된 동안에는 어떤 변경도 할 수 없습니다.',
        en: 'No mutation is available while this proposal is blocked.',
      }),
    };
  }
  if (key === 'executed') {
    return {
      primaryLabel: pick(lang, { ko: '근거 보기', en: 'Show evidence' }),
      primaryTitle: pick(lang, {
        ko: '완료된 동작의 근거를 표시합니다.',
        en: 'Show evidence for the completed action.',
      }),
      mutationBoundary: pick(lang, {
        ko: '완료된 이 제안에서는 추가 변경을 할 수 없습니다.',
        en: 'No additional mutation is available from this completed proposal.',
      }),
    };
  }
  return {
    primaryLabel: pick(lang, { ko: '근거 보기', en: 'Show evidence' }),
    primaryTitle:
      lang === 'ko'
        ? `상태가 ${params.status ?? 'unknown'}인 동안에는 기본 동작을 사용할 수 없습니다.`
        : `No primary action is available while status is ${params.status ?? 'unknown'}.`,
    mutationBoundary: pick(lang, {
      ko: '이 제안 상태에서는 변경을 할 수 없습니다.',
      en: 'No mutation is available for this proposal state.',
    }),
  };
}

// Language instruction injected into the reflection LLM prompt so authored
// title/body/reason match the operator's configured language.
export function aoiReflectionLanguageInstruction(lang: AoiCardLang): string {
  const name: Record<AoiCardLang, string> = {
    ko: 'Korean',
    ja: 'Japanese',
    zh: 'Chinese',
    en: 'English',
  };
  return `Author every human-readable field (title, body, reason) in ${name[lang]}, matching the operator's configured language.`;
}
