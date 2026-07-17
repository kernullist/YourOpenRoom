import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RotateCcw, Sparkles, X } from 'lucide-react';

import {
  forgetAoiPreferencePollMemory,
  syncAoiMemoryFromPreferencePoll,
} from '@/lib/aoiMemoryManager';
import {
  buildPreferencePollMemoryCandidate,
  clearPreferenceAnswer,
  findPreferenceOption,
  getPreferenceQuestionPrefKey,
  loadAoiPreferencePollState,
  recordPreferenceAnswer,
  saveAoiPreferencePollState,
  type AoiPreferenceLang,
  type AoiPreferencePollState,
} from '@/lib/aoiPreferencePoll';
import {
  generatedQuestionsToSeedShape,
  loadAoiGeneratedQuestionsState,
} from '@/lib/aoiPreferenceQuestionGen';
import {
  PREFERENCE_DASHBOARD_COPY,
  buildPreferenceDashboardViewModel,
} from '@/lib/aoiPreferencePollDashboardModel';

import styles from './index.module.scss';

export interface AoiPreferenceDashboardProps {
  sessionPath: string;
  lang: AoiPreferenceLang;
  // Called after a set/clear writes memory so the caller can refresh its memory
  // inspector view.
  onMemoriesChanged?: () => void;
  // Runs one bank-expansion round (Aoi writes new questions from what it knows).
  // The dashboard reloads the generated store afterwards. When absent, the
  // "generate" button is hidden.
  onGenerate?: () => Promise<void>;
}

// Operator-facing dashboard of the tastes/interests Aoi has learned from the
// preference poll -- including questions Aoi generated itself. It reads the same
// localStorage stores the chat loop uses (single source of truth), lets the user
// set/clear any answer, and can ask Aoi to grow the bank on demand.
export const AoiPreferenceDashboard: React.FC<AoiPreferenceDashboardProps> = ({
  sessionPath,
  lang,
  onMemoriesChanged,
  onGenerate,
}) => {
  const [state, setState] = useState<AoiPreferencePollState>(() => loadAoiPreferencePollState());
  const [generatedState, setGeneratedState] = useState(() => loadAoiGeneratedQuestionsState());
  const [pendingId, setPendingId] = useState('');
  const [generating, setGenerating] = useState(false);

  // Re-read the shared stores whenever the panel (re)mounts for a session, so
  // answers/questions added elsewhere since last open are reflected.
  useEffect(() => {
    setState(loadAoiPreferencePollState());
    setGeneratedState(loadAoiGeneratedQuestionsState());
  }, [sessionPath]);

  const copy = PREFERENCE_DASHBOARD_COPY[lang];
  const extraQuestions = useMemo(
    () => generatedQuestionsToSeedShape(generatedState),
    [generatedState],
  );
  const view = useMemo(
    () => buildPreferenceDashboardViewModel(state, lang, extraQuestions),
    [state, lang, extraQuestions],
  );

  const reload = useCallback(() => {
    setState(loadAoiPreferencePollState());
    setGeneratedState(loadAoiGeneratedQuestionsState());
  }, []);

  const handleSet = useCallback(
    async (questionId: string, optionId: string) => {
      // Rebase on the freshest stored state, not the render snapshot: the chat
      // loop writes answers and the ask-cooldown stamp to the same store while
      // this panel is open, and saving a stale snapshot would roll those back
      // (losing a chat-recorded answer and re-opening the daily ask cooldown).
      const current = loadAoiPreferencePollState();
      const alreadyChosen = current.answers[questionId] === optionId;
      const next = recordPreferenceAnswer(current, { questionId, optionId }, extraQuestions);
      setState(next);
      saveAoiPreferencePollState(next);
      if (alreadyChosen || !sessionPath) {
        return;
      }
      const candidate = buildPreferencePollMemoryCandidate(
        { questionId, optionId, lang },
        extraQuestions,
      );
      const option = findPreferenceOption(questionId, optionId, extraQuestions);
      if (!candidate || !option) {
        return;
      }
      setPendingId(questionId);
      try {
        await syncAoiMemoryFromPreferencePoll(sessionPath, {
          questionId,
          optionLabel: option.labels[lang],
          candidate,
          prefKey: getPreferenceQuestionPrefKey(questionId, extraQuestions) ?? undefined,
        });
        onMemoriesChanged?.();
      } catch (error) {
        console.warn('[AoiPreferenceDashboard] set answer failed', error);
      } finally {
        setPendingId('');
      }
    },
    [sessionPath, lang, extraQuestions, onMemoriesChanged],
  );

  const handleClear = useCallback(
    async (questionId: string) => {
      // Same rebase as handleSet: never clobber concurrent chat-loop writes.
      const next = clearPreferenceAnswer(loadAoiPreferencePollState(), { questionId });
      setState(next);
      saveAoiPreferencePollState(next);
      const prefKey = getPreferenceQuestionPrefKey(questionId, extraQuestions);
      if (!prefKey || !sessionPath) {
        return;
      }
      setPendingId(questionId);
      try {
        await forgetAoiPreferencePollMemory(sessionPath, prefKey);
        onMemoriesChanged?.();
      } catch (error) {
        console.warn('[AoiPreferenceDashboard] clear answer failed', error);
      } finally {
        setPendingId('');
      }
    },
    [sessionPath, extraQuestions, onMemoriesChanged],
  );

  const handleGenerate = useCallback(async () => {
    if (!onGenerate) {
      return;
    }
    setGenerating(true);
    try {
      await onGenerate();
      reload();
    } catch (error) {
      console.warn('[AoiPreferenceDashboard] generate failed', error);
    } finally {
      setGenerating(false);
    }
  }, [onGenerate, reload]);

  return (
    <div className={styles.settingsSectionCard} data-testid="aoi-preference-dashboard">
      <div className={styles.settingsSectionHeader}>
        <div>
          <div className={styles.settingsSectionTitle}>{copy.title}</div>
          <span className={styles.modelHint} data-testid="aoi-preference-summary">
            {copy.summary(view.answeredCount, view.totalCount)}
          </span>
        </div>
        <div className={styles.preferenceHeaderActions}>
          {onGenerate ? (
            <button
              type="button"
              className={styles.inlineActionBtn}
              onClick={() => void handleGenerate()}
              disabled={generating}
              title={copy.generate}
              data-testid="aoi-preference-generate"
            >
              <Sparkles size={14} />
              {generating ? copy.generating : copy.generate}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.inlineActionBtn}
            onClick={reload}
            title={copy.refresh}
          >
            <RotateCcw size={14} />
            {copy.refresh}
          </button>
        </div>
      </div>

      {view.categories.map((category) => (
        <div key={category.id} className={styles.preferenceCategory}>
          <div className={styles.preferenceCategoryLabel}>{category.label}</div>
          {category.questions.map((question) => (
            <div
              key={question.id}
              className={styles.connectorRow}
              data-testid={`aoi-preference-q-${question.id}`}
            >
              <div className={styles.preferenceQuestionHeader}>
                <strong>
                  {question.generated ? (
                    <span className={styles.preferenceGeneratedBadge}>{copy.generatedBadge}</span>
                  ) : null}
                  {question.prompt}
                </strong>
                {question.answeredOptionId ? (
                  <button
                    type="button"
                    className={styles.inlineActionBtn}
                    onClick={() => void handleClear(question.id)}
                    disabled={pendingId === question.id}
                    title={copy.clear}
                  >
                    <X size={14} />
                    {copy.clear}
                  </button>
                ) : null}
              </div>
              <div className={styles.preferenceOptionRow}>
                {question.options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`${styles.connectorToggle} ${
                      option.selected ? styles.connectorToggleOn : ''
                    }`}
                    aria-pressed={option.selected}
                    onClick={() => void handleSet(question.id, option.id)}
                    disabled={pendingId === question.id}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <span className={styles.modelHint}>
                {question.answeredStatement
                  ? `${copy.learnedPrefix} ${question.answeredStatement}`
                  : copy.unansweredHint}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};
