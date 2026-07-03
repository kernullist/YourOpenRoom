import { describe, expect, it } from 'vitest';
import {
  aoiCardApprovalBoundary,
  aoiCardApproveActionPhrase,
  aoiCardConfidenceLabel,
  aoiCardEvidenceLabel,
  aoiCardEvidenceSummary,
  aoiCardFeedbackLabel,
  aoiCardFeedbackTitle,
  aoiCardGoalContinuationBody,
  aoiCardGoalContinuationReason,
  aoiCardGoalContinuePrefix,
  aoiCardGoalText,
  aoiCardGoalTrackPrefix,
  aoiCardMessageSummary,
  aoiCardProposalText,
  aoiCardRecoveryText,
  aoiCardRiskLabel,
  aoiCardWhatChanged,
  aoiReflectionLanguageInstruction,
  normalizeAoiCardLang,
} from '../aoiAutonomyCardI18n';

describe('normalizeAoiCardLang()', () => {
  it('preserves Korean even though the global i18n layer drops it to English', () => {
    expect(normalizeAoiCardLang('ko')).toBe('ko');
    expect(normalizeAoiCardLang('ko-KR')).toBe('ko');
    expect(normalizeAoiCardLang('KO')).toBe('ko');
  });

  it('maps ja/zh prefixes and falls back to en', () => {
    expect(normalizeAoiCardLang('ja-JP')).toBe('ja');
    expect(normalizeAoiCardLang('zh-CN')).toBe('zh');
    expect(normalizeAoiCardLang('en-US')).toBe('en');
    expect(normalizeAoiCardLang('')).toBe('en');
    expect(normalizeAoiCardLang(null)).toBe('en');
    expect(normalizeAoiCardLang(undefined)).toBe('en');
    expect(normalizeAoiCardLang('fr')).toBe('en');
  });
});

describe('aoi card string tables', () => {
  it('returns Korean for ko and English for en', () => {
    expect(aoiCardConfidenceLabel('ko', 'good_confidence')).toBe('높은 확신');
    expect(aoiCardConfidenceLabel('en', 'good_confidence')).toBe('good confidence');
    expect(aoiCardRiskLabel('ko', 'medium')).toBe('중간 위험');
    expect(aoiCardRiskLabel('en', 'medium')).toBe('medium risk');
    expect(aoiCardEvidenceLabel('ko', 2)).toBe('근거 2건');
    expect(aoiCardEvidenceLabel('en', 2)).toBe('evidence 2');
  });

  it('falls back ja/zh to English', () => {
    expect(aoiCardConfidenceLabel('ja', 'good_confidence')).toBe('good confidence');
    expect(aoiCardRiskLabel('zh', 'high')).toBe('high risk');
  });

  it('localizes the evidence summary with count-aware phrasing', () => {
    expect(aoiCardEvidenceSummary('ko', 0)).toContain('근거 부족');
    expect(aoiCardEvidenceSummary('ko', 3)).toBe('근거 3건 첨부됨; 자세한 내용은 패널에 있습니다.');
    expect(aoiCardEvidenceSummary('en', 1)).toBe(
      '1 evidence ref attached; details stay in the panel.',
    );
    expect(aoiCardEvidenceSummary('en', 2)).toBe(
      '2 evidence refs attached; details stay in the panel.',
    );
  });

  it('localizes the approve-action phrase and full message summary', () => {
    expect(aoiCardApproveActionPhrase('ko', 'read_research_artifact')).toBe(
      '해당 리서치 보고서를 열람',
    );
    const ko = aoiCardMessageSummary('ko', {
      subjectSentence: '리서치 복구를 검토합니다.',
      whyNow: '실패한 실행이 아직 대기 중입니다.',
      approveActionPhrase: aoiCardApproveActionPhrase('ko', 'record_review'),
    });
    expect(ko).toBe(
      '리서치 복구를 검토합니다. 실패한 실행이 아직 대기 중입니다. 승인하면 이 검토를 기록합니다.',
    );
    const en = aoiCardMessageSummary('en', {
      subjectSentence: 'Review recovery.',
      whyNow: 'Still pending.',
      approveActionPhrase: aoiCardApproveActionPhrase('en', 'record_review'),
    });
    expect(en).toBe('Review recovery. Still pending. Approve to record this review.');
  });

  it('omits the double space when whyNow is empty', () => {
    expect(
      aoiCardMessageSummary('en', {
        subjectSentence: 'Subject.',
        whyNow: '',
        approveActionPhrase: 'record this review',
      }),
    ).toBe('Subject. Approve to record this review.');
  });

  it('localizes approval boundaries and whatChanged variants', () => {
    expect(aoiCardApprovalBoundary('ko', 'start_research')).toContain(
      '리서치 실행을 시작하지 않습니다',
    );
    expect(aoiCardApprovalBoundary('en', 'start_research')).toContain('research run');
    expect(
      aoiCardWhatChanged('ko', 'recovery_available', { failureKind: '리서치 실패' }),
    ).toContain('리서치 실패');
    expect(aoiCardWhatChanged('en', 'generic', { triggerLabel: 'background check' })).toBe(
      'A background check proposal is ready for review.',
    );
  });

  it('localizes feedback control labels and titles', () => {
    expect(aoiCardFeedbackLabel('ko', 'wrong_source')).toBe('출처 선택이 틀림');
    expect(aoiCardFeedbackLabel('en', 'wrong_source')).toBe('Wrong source');
    expect(aoiCardFeedbackTitle('ko', 'unsafe')).toContain('안전하지 않은');
  });

  it('names the target language in the reflection prompt instruction', () => {
    expect(aoiReflectionLanguageInstruction('ko')).toContain('Korean');
    expect(aoiReflectionLanguageInstruction('ja')).toContain('Japanese');
    expect(aoiReflectionLanguageInstruction('en')).toContain('English');
  });

  it('localizes deterministic proposal text and interpolates the research topic', () => {
    const ko = aoiCardProposalText('ko', 'research_followup');
    expect(ko.title).toBe('일치하는 Aoi 리서치 보고서 열기');
    expect(ko.body.replace('{topic}', 'RE 트렌드')).toContain('RE 트렌드');
    const en = aoiCardProposalText('en', 'stale_research');
    expect(en.title).toBe('Refresh stale Aoi research');
    expect(aoiCardProposalText('ko', 'kira_attention').body).toBe('');
  });

  it('localizes failure-recovery card text keyed by failure kind', () => {
    const ko = aoiCardRecoveryText('ko', 'research_failed', { sourceRef: 'research:r1' });
    expect(ko.title).toBe('리서치 좁혀서 재시도');
    expect(ko.body).toContain('실패했습니다');
    expect(ko.reason).toContain('research:r1');
    const en = aoiCardRecoveryText('en', 'research_failed', { sourceRef: 'research:r1' });
    expect(en.title).toBe('Refresh research narrowly');
    expect(en.body).toContain('That failed because validation needs');
  });

  it('localizes goal proposal card text and prefixes', () => {
    expect(aoiCardGoalTrackPrefix('ko', '커널 텔레메트리 강화')).toBe(
      '목표 추적: 커널 텔레메트리 강화',
    );
    expect(aoiCardGoalTrackPrefix('en', 'x')).toBe('Track goal: x');
    expect(aoiCardGoalContinuePrefix('ko', '증거 새로고침')).toBe('목표 계속: 증거 새로고침');
    expect(aoiCardGoalText('ko', 'from_user').reason).toContain('명시적으로 요청');
    expect(aoiCardGoalText('en', 'candidate').body).toContain('recurring pattern');
    expect(aoiCardGoalContinuationBody('ko', { goalTitle: '목표A', stepTitle: '단계1' })).toContain(
      '목표A',
    );
    expect(aoiCardGoalContinuationReason('ko', true)).toContain('막혀');
    expect(aoiCardGoalContinuationReason('en', false)).toContain('pending');
  });
});
