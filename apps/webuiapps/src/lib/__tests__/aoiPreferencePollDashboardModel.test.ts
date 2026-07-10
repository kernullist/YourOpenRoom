import { describe, expect, it } from 'vitest';
import {
  PREFERENCE_POLL_CATEGORIES,
  PREFERENCE_POLL_QUESTIONS,
  findPreferenceOption,
  recordPreferenceAnswer,
  type AoiPreferenceLang,
  type AoiPreferencePollState,
  type PreferencePollQuestion,
} from '../aoiPreferencePoll';
import {
  PREFERENCE_DASHBOARD_COPY,
  buildPreferenceDashboardViewModel,
} from '../aoiPreferencePollDashboardModel';

const LANGS: readonly AoiPreferenceLang[] = ['ko', 'ja', 'zh', 'en'];

const EMPTY_STATE: AoiPreferencePollState = { version: 1, answers: {}, lastAskedAt: 0 };

// A generated question in a brand-new category, in seed shape.
const GENERATED_QUESTION: PreferencePollQuestion = {
  id: 'gen-os',
  category: 'dev_environment',
  categoryLabels: { ko: '개발 환경', ja: '開発環境', zh: '开发环境', en: 'Dev environment' },
  generated: true,
  prompts: { ko: '주 OS는?', ja: 'メインOSは?', zh: '主力系统?', en: 'Main OS?' },
  options: [
    {
      id: 'o0',
      labels: { ko: 'Windows', ja: 'Windows', zh: 'Windows', en: 'Windows' },
      learn: {
        key: 'gen.dev-environment.os',
        statement: { ko: 'Windows', ja: 'Windows', zh: 'Windows', en: 'Windows' },
        tags: [],
        entities: [],
      },
    },
    {
      id: 'o1',
      labels: { ko: 'Linux', ja: 'Linux', zh: 'Linux', en: 'Linux' },
      learn: {
        key: 'gen.dev-environment.os',
        statement: { ko: 'Linux', ja: 'Linux', zh: 'Linux', en: 'Linux' },
        tags: [],
        entities: [],
      },
    },
  ],
};

describe('buildPreferenceDashboardViewModel', () => {
  it('groups questions by category in display order and counts totals', () => {
    const view = buildPreferenceDashboardViewModel(EMPTY_STATE, 'ko');
    expect(view.categories.map((category) => category.id)).toEqual(
      PREFERENCE_POLL_CATEGORIES.map((category) => category.id),
    );
    const grouped = view.categories.flatMap((category) => category.questions);
    expect(grouped).toHaveLength(PREFERENCE_POLL_QUESTIONS.length);
    expect(view.totalCount).toBe(PREFERENCE_POLL_QUESTIONS.length);
    expect(view.answeredCount).toBe(0);
    // Every category present in the bank surfaces at least one question.
    for (const category of view.categories) {
      expect(category.questions.length).toBeGreaterThan(0);
    }
  });

  it('marks the selected option and exposes the learned statement', () => {
    const state = recordPreferenceAnswer(EMPTY_STATE, {
      questionId: 'focus_area',
      optionId: 'anti_cheat',
    });
    const view = buildPreferenceDashboardViewModel(state, 'ko');
    const focus = view.categories
      .flatMap((category) => category.questions)
      .find((question) => question.id === 'focus_area');
    expect(focus?.answeredOptionId).toBe('anti_cheat');
    expect(focus?.options.find((option) => option.id === 'anti_cheat')?.selected).toBe(true);
    expect(focus?.options.filter((option) => option.selected)).toHaveLength(1);
    const expected = findPreferenceOption('focus_area', 'anti_cheat')?.learn.statement.ko;
    expect(focus?.answeredStatement).toBe(expected);
    expect(view.answeredCount).toBe(1);
  });

  it('ignores a stale answer whose option no longer exists', () => {
    const state: AoiPreferencePollState = {
      version: 1,
      answers: { focus_area: 'removed_option' },
      lastAskedAt: 0,
    };
    const view = buildPreferenceDashboardViewModel(state, 'en');
    const focus = view.categories
      .flatMap((category) => category.questions)
      .find((question) => question.id === 'focus_area');
    expect(focus?.answeredOptionId).toBeNull();
    expect(focus?.answeredStatement).toBeNull();
    expect(focus?.options.some((option) => option.selected)).toBe(false);
    expect(view.answeredCount).toBe(0);
  });

  it('localizes prompts, option labels, and category labels for every language', () => {
    for (const lang of LANGS) {
      const view = buildPreferenceDashboardViewModel(EMPTY_STATE, lang);
      for (const category of view.categories) {
        expect(category.label.trim().length).toBeGreaterThan(0);
        for (const question of category.questions) {
          expect(question.prompt.trim().length).toBeGreaterThan(0);
          for (const option of question.options) {
            expect(option.label.trim().length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('tolerates null / malformed state', () => {
    expect(buildPreferenceDashboardViewModel(null, 'ko').answeredCount).toBe(0);
    expect(
      buildPreferenceDashboardViewModel(
        { version: 1, answers: undefined, lastAskedAt: 0 } as unknown as AoiPreferencePollState,
        'ko',
      ).answeredCount,
    ).toBe(0);
  });

  it('appends generated questions in a new category after the seed ones', () => {
    const view = buildPreferenceDashboardViewModel(EMPTY_STATE, 'ko', [GENERATED_QUESTION]);
    expect(view.totalCount).toBe(PREFERENCE_POLL_QUESTIONS.length + 1);
    expect(view.generatedCount).toBe(1);
    // Seed categories keep their leading order; the new category comes last.
    const ids = view.categories.map((category) => category.id);
    expect(ids.slice(0, PREFERENCE_POLL_CATEGORIES.length)).toEqual(
      PREFERENCE_POLL_CATEGORIES.map((category) => category.id),
    );
    const generatedCategory = view.categories.find((category) => category.id === 'dev_environment');
    expect(generatedCategory?.label).toBe('개발 환경');
    const generatedQuestion = generatedCategory?.questions[0];
    expect(generatedQuestion?.generated).toBe(true);
    expect(generatedQuestion?.prompt).toBe('주 OS는?');
  });

  it('marks a generated question answered and resolves its statement', () => {
    const state = recordPreferenceAnswer(EMPTY_STATE, { questionId: 'gen-os', optionId: 'o1' }, [
      GENERATED_QUESTION,
    ]);
    const view = buildPreferenceDashboardViewModel(state, 'en', [GENERATED_QUESTION]);
    const question = view.categories
      .flatMap((category) => category.questions)
      .find((item) => item.id === 'gen-os');
    expect(question?.answeredOptionId).toBe('o1');
    expect(question?.answeredStatement).toBe('Linux');
  });
});

describe('PREFERENCE_DASHBOARD_COPY', () => {
  it('provides non-empty chrome and a count-aware summary for every language', () => {
    for (const lang of LANGS) {
      const copy = PREFERENCE_DASHBOARD_COPY[lang];
      expect(copy.title.trim().length).toBeGreaterThan(0);
      expect(copy.refresh.trim().length).toBeGreaterThan(0);
      expect(copy.clear.trim().length).toBeGreaterThan(0);
      expect(copy.learnedPrefix.trim().length).toBeGreaterThan(0);
      expect(copy.unansweredHint.trim().length).toBeGreaterThan(0);
      const summary = copy.summary(3, 13);
      expect(summary).toContain('3');
      expect(summary).toContain('13');
    }
  });
});
