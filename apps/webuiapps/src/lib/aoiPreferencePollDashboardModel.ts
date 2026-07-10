// Pure view model for the Aoi preference dashboard (AoiPreferenceDashboard).
// Groups the question bank by category, marks the user's current pick per
// question, and surfaces the learned statement so the dashboard can show exactly
// what Aoi will remember. Kept free of React/DOM so it is unit-testable.

import {
  PREFERENCE_POLL_CATEGORIES,
  PREFERENCE_POLL_QUESTIONS,
  type AoiPreferenceLang,
  type AoiPreferencePollState,
  type PreferencePollQuestion,
} from './aoiPreferencePoll';

export interface PreferenceDashboardOptionView {
  id: string;
  label: string;
  selected: boolean;
}

export interface PreferenceDashboardQuestionView {
  id: string;
  prompt: string;
  options: PreferenceDashboardOptionView[];
  answeredOptionId: string | null;
  // Localized statement Aoi stores for the current pick, or null when unanswered.
  answeredStatement: string | null;
  // True for questions Aoi generated itself (vs the static seed bank).
  generated: boolean;
}

export interface PreferenceDashboardCategoryView {
  id: string;
  label: string;
  questions: PreferenceDashboardQuestionView[];
}

export interface PreferenceDashboardViewModel {
  categories: PreferenceDashboardCategoryView[];
  answeredCount: number;
  totalCount: number;
  generatedCount: number;
}

function normalizeAnswers(
  state: AoiPreferencePollState | null | undefined,
): Record<string, string> {
  const answers = state?.answers;
  if (!answers || typeof answers !== 'object') {
    return {};
  }
  return answers;
}

// Category display order + labels: the seed categories first (in their fixed
// order), then any additional categories introduced by generated questions, in
// first-seen order, using their own carried label.
function resolveCategoryOrder(
  questions: readonly PreferencePollQuestion[],
  lang: AoiPreferenceLang,
): Array<{ id: string; label: string }> {
  const order: Array<{ id: string; label: string }> = PREFERENCE_POLL_CATEGORIES.map(
    (category) => ({
      id: category.id,
      label: category.labels[lang],
    }),
  );
  const seen = new Set(order.map((entry) => entry.id));
  for (const question of questions) {
    if (seen.has(question.category)) {
      continue;
    }
    seen.add(question.category);
    order.push({
      id: question.category,
      label: question.categoryLabels?.[lang] ?? question.category,
    });
  }
  return order;
}

export function buildPreferenceDashboardViewModel(
  state: AoiPreferencePollState | null | undefined,
  lang: AoiPreferenceLang,
  extraQuestions: readonly PreferencePollQuestion[] = [],
): PreferenceDashboardViewModel {
  const answers = normalizeAnswers(state);
  const allQuestions = [...PREFERENCE_POLL_QUESTIONS, ...extraQuestions];
  let answeredCount = 0;

  const categories = resolveCategoryOrder(allQuestions, lang)
    .map((category) => {
      const questions = allQuestions
        .filter((question) => question.category === category.id)
        .map((question) => {
          const rawAnswer = answers[question.id];
          // Only treat an answer as set when it still maps to a real option, so a
          // stale option id from an older bank never shows a phantom selection.
          const answeredOption = rawAnswer
            ? (question.options.find((option) => option.id === rawAnswer) ?? null)
            : null;
          const answeredOptionId = answeredOption ? answeredOption.id : null;
          if (answeredOptionId) {
            answeredCount += 1;
          }
          return {
            id: question.id,
            prompt: question.prompts[lang],
            options: question.options.map((option) => ({
              id: option.id,
              label: option.labels[lang],
              selected: option.id === answeredOptionId,
            })),
            answeredOptionId,
            answeredStatement: answeredOption ? answeredOption.learn.statement[lang] : null,
            generated: question.generated === true,
          } satisfies PreferenceDashboardQuestionView;
        });
      return {
        id: category.id,
        label: category.label,
        questions,
      } satisfies PreferenceDashboardCategoryView;
    })
    // A generated category can become empty after its questions are pruned; drop
    // empty categories so the dashboard never shows a bare header.
    .filter((category) => category.questions.length > 0);

  return {
    categories,
    answeredCount,
    totalCount: allQuestions.length,
    generatedCount: extraQuestions.length,
  };
}

// --- Localized dashboard chrome ----------------------------------------------

export interface PreferenceDashboardCopy {
  title: string;
  refresh: string;
  clear: string;
  learnedPrefix: string;
  unansweredHint: string;
  generate: string;
  generating: string;
  generatedBadge: string;
  // summary(answered, total) -> the header subtitle line.
  summary: (answered: number, total: number) => string;
}

export const PREFERENCE_DASHBOARD_COPY: Record<AoiPreferenceLang, PreferenceDashboardCopy> = {
  ko: {
    title: 'Aoi가 아는 내 취향',
    refresh: '새로고침',
    clear: '지우기',
    learnedPrefix: '기억:',
    unansweredHint: '아직 답 안 함',
    generate: 'Aoi가 새 질문 만들기',
    generating: '만드는 중...',
    generatedBadge: 'Aoi 생성',
    summary: (answered, total) =>
      `${total}개 중 ${answered}개 답함. 답한 취향은 이후 판단에 반영돼.`,
  },
  ja: {
    title: 'Aoiが知っている私の好み',
    refresh: '更新',
    clear: 'クリア',
    learnedPrefix: '記憶:',
    unansweredHint: '未回答',
    generate: 'Aoiが新しい質問を作る',
    generating: '作成中...',
    generatedBadge: 'Aoi生成',
    summary: (answered, total) =>
      `${total}件中${answered}件回答済み。回答は今後の判断に反映されます。`,
  },
  zh: {
    title: 'Aoi 了解的我的偏好',
    refresh: '刷新',
    clear: '清除',
    learnedPrefix: '记忆:',
    unansweredHint: '未回答',
    generate: 'Aoi 生成新问题',
    generating: '生成中...',
    generatedBadge: 'Aoi 生成',
    summary: (answered, total) => `${total} 项中已回答 ${answered} 项，回答会用于后续判断。`,
  },
  en: {
    title: 'What Aoi knows about you',
    refresh: 'Refresh',
    clear: 'Clear',
    learnedPrefix: 'Remembers:',
    unansweredHint: 'Not answered yet',
    generate: 'Have Aoi write new questions',
    generating: 'Generating...',
    generatedBadge: 'Aoi-generated',
    summary: (answered, total) =>
      `${answered} of ${total} answered. Answers inform Aoi's later judgments.`,
  },
};
