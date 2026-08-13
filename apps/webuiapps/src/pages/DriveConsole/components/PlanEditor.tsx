import { Plus, Trash2 } from 'lucide-react';
import {
  describeForbidReason,
  describeRejectReason,
  DRIVE_ACTION_KINDS,
  stepNeeds,
  type DraftStep,
  type PlanDraft,
} from '../planDraft';
import type { AoiBrowserDrivePlanClassification } from '@/lib/aoiBrowserDrivePlan';
import styles from './PlanEditor.module.scss';

interface PlanEditorProps {
  draft: PlanDraft;
  classification: AoiBrowserDrivePlanClassification;
  selectedStepIndex: number | null;
  onChange: (next: PlanDraft) => void;
  onSelectStep: (index: number | null) => void;
}

const CATEGORY_LABEL: Record<string, string> = {
  read: '읽기',
  act: '승인 필요',
  forbidden: '차단',
};

export function PlanEditor({
  draft,
  classification,
  selectedStepIndex,
  onChange,
  onSelectStep,
}: PlanEditorProps): JSX.Element {
  const updateStep = (index: number, patch: Partial<DraftStep>): void => {
    onChange({
      ...draft,
      steps: draft.steps.map((step, position) =>
        position === index ? { ...step, ...patch } : step,
      ),
    });
  };

  const addStep = (): void => {
    onChange({
      ...draft,
      steps: [
        ...draft.steps,
        {
          id: `step-${draft.steps.length}-${draft.steps.length + 1}`,
          description: '',
          kind: 'navigate',
          selector: '',
          url: '',
          value: '',
          targetText: '',
          fieldType: '',
          fieldName: '',
          fieldAutocomplete: '',
        },
      ],
    });
  };

  return (
    <div className={styles.editor} data-testid="drive-console-plan">
      <label className={styles.field}>
        <span className={styles.label}>목표</span>
        <input
          className={styles.input}
          value={draft.goal}
          placeholder="이 계획으로 이루려는 것"
          data-testid="drive-console-goal"
          onChange={(event) => onChange({ ...draft, goal: event.target.value })}
        />
      </label>

      {classification.rejectReasons.length > 0 ? (
        <div className={styles.reject} data-testid="drive-console-reject">
          {classification.rejectReasons.map((reason) => (
            <p key={reason} className={styles.rejectLine}>
              {describeRejectReason(reason)}
            </p>
          ))}
        </div>
      ) : null}

      <ul className={styles.steps}>
        {draft.steps.map((step, index) => {
          const decision = classification.steps[index]?.decision;
          const category = decision?.category ?? 'read';
          const needs = stepNeeds(step.kind);
          return (
            <li
              key={step.id}
              className={styles.step}
              data-category={category}
              data-active={selectedStepIndex === index ? 'true' : undefined}
              data-testid={`drive-console-step-${index}`}
            >
              <div className={styles.stepHead}>
                <button
                  type="button"
                  className={styles.stepSelect}
                  data-testid={`drive-console-step-select-${index}`}
                  onClick={() => onSelectStep(selectedStepIndex === index ? null : index)}
                >
                  <span className={styles.stepIndex}>{index + 1}</span>
                  <span className={styles.stepCategory} data-category={category}>
                    {CATEGORY_LABEL[category] ?? category}
                  </span>
                </button>
                <select
                  className={styles.kind}
                  value={step.kind}
                  aria-label={`${index + 1}번 동작`}
                  onChange={(event) =>
                    updateStep(index, { kind: event.target.value as DraftStep['kind'] })
                  }
                >
                  {DRIVE_ACTION_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`${index + 1}번 단계 삭제`}
                  onClick={() =>
                    onChange({
                      ...draft,
                      steps: draft.steps.filter((_, position) => position !== index),
                    })
                  }
                >
                  <Trash2 size={13} />
                </button>
              </div>

              <div className={styles.stepBody}>
                <input
                  className={styles.input}
                  value={step.description}
                  placeholder="설명 (승인 카드에 표시)"
                  onChange={(event) => updateStep(index, { description: event.target.value })}
                />
                {needs.url ? (
                  <input
                    className={styles.input}
                    value={step.url}
                    placeholder="https://..."
                    data-testid={`drive-console-step-url-${index}`}
                    onChange={(event) => updateStep(index, { url: event.target.value })}
                  />
                ) : null}
                {needs.selector ? (
                  <input
                    className={styles.input}
                    value={step.selector}
                    placeholder="CSS 셀렉터"
                    data-testid={`drive-console-step-selector-${index}`}
                    onChange={(event) => updateStep(index, { selector: event.target.value })}
                  />
                ) : null}
                {needs.value ? (
                  <input
                    className={styles.input}
                    value={step.value}
                    placeholder="입력할 값"
                    onChange={(event) => updateStep(index, { value: event.target.value })}
                  />
                ) : null}
              </div>

              {/* Shown while writing, not at execute time: the point is to move the
                  judgement earlier, when the plan can still be changed. */}
              {category === 'forbidden' ? (
                <p className={styles.forbidden} data-testid={`drive-console-forbidden-${index}`}>
                  {describeForbidReason(decision?.forbidReason)}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        className={styles.add}
        onClick={addStep}
        data-testid="drive-console-add-step"
      >
        <Plus size={14} />
        단계 추가
      </button>
    </div>
  );
}

export default PlanEditor;
