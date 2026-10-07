import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { ModCollection } from '@/lib/modManager';
import ModPanel, { nextModTargetId } from './ModPanel';

afterEach(cleanup);

describe('nextModTargetId', () => {
  it('is unique across every stage and the completed targets', () => {
    // A counter restarting at 100 per page load reused ids after a reload.
    const stages = [{ targets: [{ id: 1 }, { id: 100 }] }, { targets: [{ id: 2 }] }];
    expect(nextModTargetId(stages)).toBe(101);
    // An id that left the stages but is still completed must not come back.
    expect(nextModTargetId(stages, [250])).toBe(251);
    expect(nextModTargetId([], [])).toBe(1);
  });
});

describe('ModPanel target editor', () => {
  function collection(): ModCollection {
    return {
      activeId: 'm1',
      items: {
        m1: {
          config: {
            id: 'm1',
            mod_name: 'Test mod',
            mod_name_en: 'Test mod',
            mod_description: '',
            stage_count: 1,
            stages: {
              0: {
                stage_index: 0,
                stage_name: 'Opening',
                stage_description: '',
                stage_targets: { 1: 'Say hello', 2: 'Ask a name' },
              },
            },
          },
          // Target 7 was completed and later removed from the stage.
          state: {
            current_stage_index: 0,
            total_stage_count: 1,
            is_finished: false,
            completed_targets: [7],
          },
        },
      },
    };
  }

  it('gives a new target an id no stage or completed target uses', () => {
    const onSave = vi.fn();
    render(
      <ModPanel collection={collection()} onSave={onSave} onClose={() => {}} initialEditId="m1" />,
    );

    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Add Target'));
    fireEvent.change(screen.getByPlaceholderText('Target 3'), {
      target: { value: 'Find the key' },
    });
    fireEvent.click(screen.getByText('Done'));
    fireEvent.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as ModCollection;
    // Reusing 7 would have shown the new target as already completed.
    expect(saved.items.m1.config.stages[0].stage_targets).toEqual({
      1: 'Say hello',
      2: 'Ask a name',
      8: 'Find the key',
    });
  });
});
