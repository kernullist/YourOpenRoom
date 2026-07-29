import { describe, expect, it } from 'vitest';

import {
  buildAoiCompanionBriefChatHook,
  buildAoiCompanionBriefHook,
  buildAoiCompanionBriefReason,
  buildAoiCompanionFeedbackAction,
  buildAoiCompanionResumeGreeting,
  buildAoiCompanionResumeSafetyNote,
  buildAoiCompanionResumeTitle,
  buildAoiCompanionTrendHook,
  buildAoiCompanionTrendNextAction,
  buildAoiCompanionTrendTake,
  violatesAoiCompanionRegister,
  type AoiCompanionFeedbackActionKind,
  type AoiCompanionTrendTakeKind,
  type AoiCompanionVoice,
} from '../aoiCompanionVoice';

const KO: AoiCompanionVoice = { lang: 'ko' };
const EN: AoiCompanionVoice = { lang: 'en' };

const TAKE_KINDS: AoiCompanionTrendTakeKind[] = [
  'default_watch',
  'stale_refresh',
  'weak_source',
  'review_candidate',
];

const FEEDBACK_KINDS: AoiCompanionFeedbackActionKind[] = [
  'useful',
  'show_less',
  'wrong_timing',
  'wrong_source',
  'mute_topic',
  'open_sources',
  'archive_brief',
  'expand_summary',
];

describe('aoiCompanionVoice brief copy', () => {
  it('speaks Korean in the casual persona register with the source count', () => {
    const hook = buildAoiCompanionBriefHook(KO, {
      topicLabel: '커널 안티치트',
      sourceCount: 3,
      mediaBucket: 'read',
    });
    expect(hook).toContain('커널 안티치트');
    expect(hook).toContain('3');
    expect(hook).toContain('읽어볼 만한 자료');
    expect(hook).toContain('네가');
  });

  it('drops the count phrasing when no sources were found', () => {
    expect(buildAoiCompanionBriefHook(KO, { topicLabel: '주제', sourceCount: 0 })).toBe(
      '네가 관심 있어 하던 주제 쪽에 봐둘 만한 게 있어.',
    );
    expect(buildAoiCompanionBriefHook(EN, { topicLabel: 'topic', sourceCount: 0 })).toBe(
      'Spotted something on topic you might want to see.',
    );
  });

  it('treats a non-finite source count as zero', () => {
    expect(buildAoiCompanionBriefHook(EN, { topicLabel: 'topic', sourceCount: Number.NaN })).toBe(
      'Spotted something on topic you might want to see.',
    );
  });

  it('varies the flavor per media bucket and defaults to mixed', () => {
    expect(
      buildAoiCompanionBriefHook(EN, { topicLabel: 't', sourceCount: 2, mediaBucket: 'watch' }),
    ).toContain('worth watching');
    expect(
      buildAoiCompanionBriefHook(EN, { topicLabel: 't', sourceCount: 2, mediaBucket: 'listen' }),
    ).toContain('worth a listen');
    expect(buildAoiCompanionBriefHook(EN, { topicLabel: 't', sourceCount: 2 })).toContain(
      'worth a look',
    );
    expect(
      buildAoiCompanionBriefHook(KO, { topicLabel: 't', sourceCount: 2, mediaBucket: null }),
    ).toContain('볼만한 공개 자료');
  });

  it('appends an invitation for the direct-chat hook', () => {
    const chatHook = buildAoiCompanionBriefChatHook(KO, { topicLabel: '주제', sourceCount: 1 });
    expect(chatHook).toContain('열어볼래?');
    expect(
      chatHook.startsWith(
        buildAoiCompanionBriefHook(KO, {
          topicLabel: '주제',
          sourceCount: 1,
        }),
      ),
    ).toBe(true);
    expect(buildAoiCompanionBriefChatHook(EN, { topicLabel: 't', sourceCount: 1 })).toContain(
      'Want me to open it?',
    );
  });

  it('explains the reason relationally without exposing internal scores', () => {
    const professional = buildAoiCompanionBriefReason(KO, { interestKind: 'professional' });
    const personal = buildAoiCompanionBriefReason(KO, { interestKind: 'personal' });
    const unknown = buildAoiCompanionBriefReason(KO, {});
    expect(professional).toContain('파고 있던');
    expect(personal).toContain('좋아하는');
    expect(unknown).toBe(professional);
    expect(buildAoiCompanionBriefReason(EN, { interestKind: 'personal' })).toContain(
      'you like this stuff',
    );
    for (const text of [professional, personal, unknown]) {
      expect(text).not.toMatch(/0\.\d/);
    }
  });

  it('collapses control characters and caps long interpolated labels', () => {
    const noisy = buildAoiCompanionBriefHook(EN, {
      topicLabel: `kernel\u0007\ndriver`,
      sourceCount: 1,
    });
    expect(noisy).toContain('kernel driver');
    expect(noisy).not.toMatch(/\p{Cc}/u);

    const long = buildAoiCompanionBriefHook(EN, { topicLabel: 'x'.repeat(200), sourceCount: 1 });
    expect(long).toContain('…');
    expect(long).not.toContain('x'.repeat(81));
  });
});

describe('aoiCompanionVoice trend copy', () => {
  it('authors a distinct first-person take and next action per kind', () => {
    const koTakes = TAKE_KINDS.map((kind) => buildAoiCompanionTrendTake(KO, kind));
    const koActions = TAKE_KINDS.map((kind) => buildAoiCompanionTrendNextAction(KO, kind));
    expect(new Set(koTakes).size).toBe(TAKE_KINDS.length);
    expect(new Set(koActions).size).toBe(TAKE_KINDS.length);
    expect(buildAoiCompanionTrendTake(EN, 'review_candidate')).toContain('worth a short review');
    expect(buildAoiCompanionTrendNextAction(EN, 'stale_refresh')).toContain('Run the scout again');
  });

  it('replaces third-person self-reference with first person in the chat hook', () => {
    const hook = buildAoiCompanionTrendHook(KO, {
      topicLabel: 'TPM 검증',
      title: '새 우회 기법 공개',
      take: buildAoiCompanionTrendTake(KO, 'review_candidate'),
      sourceHosts: ['example.com', 'news.test'],
    });
    expect(hook).toContain('내 생각엔');
    expect(hook).toContain('TPM 검증');
    expect(hook).toContain('example.com, news.test');
    expect(hook).not.toContain('Aoi');
  });

  it('falls back to a generic source label and caps hosts at three', () => {
    expect(
      buildAoiCompanionTrendHook(KO, { topicLabel: 't', title: 'x', take: 'y', sourceHosts: [] }),
    ).toContain('공개 출처');
    const many = buildAoiCompanionTrendHook(EN, {
      topicLabel: 't',
      title: 'x',
      take: 'y',
      sourceHosts: ['a.com', 'b.com', 'c.com', 'd.com'],
    });
    expect(many).toContain('a.com, b.com, c.com');
    expect(many).not.toContain('d.com');
  });

  it('drops blank hosts before joining', () => {
    expect(
      buildAoiCompanionTrendHook(EN, {
        topicLabel: 't',
        title: 'x',
        take: 'y',
        sourceHosts: ['', '  ', 'real.com'],
      }),
    ).toContain('Sources: real.com.');
  });
});

describe('aoiCompanionVoice resume copy', () => {
  it('localizes the title with authored ja/zh strings', () => {
    expect(buildAoiCompanionResumeTitle(KO)).toBe('잠깐 사이에 있었던 일');
    expect(buildAoiCompanionResumeTitle(EN)).toBe('While you were away');
    expect(buildAoiCompanionResumeTitle({ lang: 'ja' })).toBe('留守の間にあったこと');
    expect(buildAoiCompanionResumeTitle({ lang: 'zh' })).toBe('你不在的这会儿');
  });

  it('falls back to English prose for ja/zh where only ko/en are authored', () => {
    expect(buildAoiCompanionResumeSafetyNote({ lang: 'ja' })).toBe(
      buildAoiCompanionResumeSafetyNote(EN),
    );
    expect(buildAoiCompanionBriefReason({ lang: 'zh' }, {})).toBe(
      buildAoiCompanionBriefReason(EN, {}),
    );
  });

  it('varies the greeting by how long the user was away', () => {
    expect(buildAoiCompanionResumeGreeting(KO, { idleMs: 20 * 60_000 })).toBe(
      '잠깐 자리 비웠었네.',
    );
    expect(buildAoiCompanionResumeGreeting(KO, { idleMs: 3 * 3_600_000 })).toBe('3시간 만이네.');
    expect(buildAoiCompanionResumeGreeting(KO, { idleMs: 30 * 3_600_000 })).toBe('오랜만이야.');
    expect(buildAoiCompanionResumeGreeting(EN, { idleMs: 3 * 3_600_000 })).toBe('Back after 3h.');
    expect(buildAoiCompanionResumeGreeting(EN, { idleMs: 30 * 3_600_000 })).toBe('Been a while.');
  });

  it('addresses the user by name when one is configured', () => {
    expect(buildAoiCompanionResumeGreeting({ lang: 'ko', userName: '꿀보' }, { idleMs: 0 })).toBe(
      '꿀보, 잠깐 자리 비웠었네.',
    );
    expect(
      buildAoiCompanionResumeGreeting({ lang: 'ko', userName: '   ' }, { idleMs: 0 }),
    ).not.toContain(',');
  });

  it('treats a non-finite or negative idle span as just-returned', () => {
    expect(buildAoiCompanionResumeGreeting(EN, { idleMs: Number.NaN })).toBe('Back already.');
    expect(buildAoiCompanionResumeGreeting(EN, { idleMs: -5 })).toBe('Back already.');
  });

  it('keeps the full safety boundary meaning in voice', () => {
    const ko = buildAoiCompanionResumeSafetyNote(KO);
    expect(ko).toContain('승인');
    expect(ko).toContain('실행');
    expect(ko).toContain('리서치');
    expect(ko).toContain('Kira');
    expect(ko).toContain('파일 수정');
    const en = buildAoiCompanionResumeSafetyNote(EN);
    for (const part of ['approval', 'execution', 'tools', 'research', 'Kira', 'file edits']) {
      expect(en).toContain(part);
    }
  });
});

describe('aoiCompanionVoice feedback chips', () => {
  it('gives every action a localized label and a first-person tooltip', () => {
    for (const action of FEEDBACK_KINDS) {
      const ko = buildAoiCompanionFeedbackAction(KO, action);
      const en = buildAoiCompanionFeedbackAction(EN, action);
      expect(ko.label.length).toBeGreaterThan(0);
      expect(ko.title.length).toBeGreaterThan(0);
      expect(en.label.length).toBeGreaterThan(0);
      expect(en.title.length).toBeGreaterThan(0);
      expect(ko.title).not.toContain('Aoi');
    }
    expect(buildAoiCompanionFeedbackAction(KO, 'useful').label).toBe('유용해');
    expect(buildAoiCompanionFeedbackAction({ lang: 'ja' }, 'useful').label).toBe('役に立った');
    expect(buildAoiCompanionFeedbackAction({ lang: 'zh' }, 'mute_topic').label).toBe('静音主题');
  });

  it('keeps the source-trust tooltip from implying execute authority changes', () => {
    expect(buildAoiCompanionFeedbackAction(KO, 'wrong_source').title).toContain('실행 권한');
    expect(buildAoiCompanionFeedbackAction(EN, 'wrong_source').title).toContain(
      'execute authority',
    );
  });
});

describe('aoiCompanionVoice register contract', () => {
  it('flags formal Korean, third-person self-reference, operator, and raw scores', () => {
    expect(violatesAoiCompanionRegister('출처를 열어보시기 바랍니다')).toBe(true);
    expect(violatesAoiCompanionRegister('출처를 열어주세요')).toBe(true);
    expect(violatesAoiCompanionRegister('Aoi trend signal for X')).toBe(true);
    expect(violatesAoiCompanionRegister('This matters to the operator')).toBe(true);
    expect(violatesAoiCompanionRegister('matches with confidence 0.80')).toBe(true);
    expect(violatesAoiCompanionRegister('current-info preference 0.70')).toBe(true);
    expect(violatesAoiCompanionRegister('출처 열어보고 표시해줘')).toBe(false);
    expect(violatesAoiCompanionRegister('Worth a short review.')).toBe(false);
  });

  it('emits no register violation across every authored string', () => {
    const voices: AoiCompanionVoice[] = [
      KO,
      EN,
      { lang: 'ja' },
      { lang: 'zh' },
      { lang: 'ko', userName: '꿀보' },
    ];
    const texts: string[] = [];
    for (const voice of voices) {
      texts.push(
        buildAoiCompanionBriefHook(voice, { topicLabel: '주제', sourceCount: 2 }),
        buildAoiCompanionBriefChatHook(voice, { topicLabel: '주제', sourceCount: 0 }),
        buildAoiCompanionBriefReason(voice, { interestKind: 'professional' }),
        buildAoiCompanionBriefReason(voice, { interestKind: 'personal' }),
        buildAoiCompanionResumeTitle(voice),
        buildAoiCompanionResumeGreeting(voice, { idleMs: 3 * 3_600_000 }),
        buildAoiCompanionResumeSafetyNote(voice),
      );
      for (const bucket of ['watch', 'listen', 'read', 'mixed'] as const) {
        texts.push(
          buildAoiCompanionBriefHook(voice, {
            topicLabel: '주제',
            sourceCount: 1,
            mediaBucket: bucket,
          }),
        );
      }
      for (const kind of TAKE_KINDS) {
        const take = buildAoiCompanionTrendTake(voice, kind);
        texts.push(
          take,
          buildAoiCompanionTrendNextAction(voice, kind),
          buildAoiCompanionTrendHook(voice, {
            topicLabel: '주제',
            title: '제목',
            take,
            sourceHosts: ['example.com'],
          }),
        );
      }
      for (const action of FEEDBACK_KINDS) {
        const copy = buildAoiCompanionFeedbackAction(voice, action);
        texts.push(copy.label, copy.title);
      }
    }
    const violations = texts.filter((text) => violatesAoiCompanionRegister(text));
    expect(violations).toEqual([]);
  });
});
