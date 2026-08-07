import { describe, expect, it } from 'vitest';
import { ModManager, type ModConfig } from '../modManager';

function makeConfig(overrides: Partial<ModConfig> = {}): ModConfig {
  return {
    id: 'test_story',
    mod_name: 'Test Story',
    mod_name_en: 'Test Story',
    mod_description: 'A two-stage test script.',
    stage_count: 2,
    stages: {
      0: {
        stage_index: 0,
        stage_name: 'Opening',
        stage_description: 'Invite the user on a fictional quest.',
        stage_targets: { 1: 'Show the quest list', 2: 'User picks a quest' },
      },
      1: {
        stage_index: 1,
        stage_name: 'Finale',
        stage_description: 'Wrap the story up.',
        stage_targets: { 3: 'Say goodbye' },
      },
    },
    ...overrides,
  };
}

describe('ModManager.buildStageReminder', () => {
  it('injects the current stage script and pending targets while the story runs', () => {
    const mm = new ModManager(makeConfig());

    const reminder = mm.buildStageReminder();

    expect(reminder).toContain('Stage 1/2: Opening');
    expect(reminder).toContain('Invite the user on a fictional quest.');
    expect(reminder).toContain('- [1] Show the quest list');
    expect(reminder).toContain('- [2] User picks a quest');
    expect(reminder).not.toContain('[Story Complete]');
  });

  it('omits completed targets from the pending list', () => {
    const mm = new ModManager(makeConfig());
    mm.finishTarget([1]);

    const reminder = mm.buildStageReminder();

    expect(reminder).not.toContain('- [1] Show the quest list');
    expect(reminder).toContain('- [2] User picks a quest');
  });

  it('switches to grounded free-conversation rules once the story is finished', () => {
    const mm = new ModManager(makeConfig(), {
      current_stage_index: 2,
      total_stage_count: 2,
      is_finished: true,
      completed_targets: [1, 2, 3],
    });

    const reminder = mm.buildStageReminder();

    expect(reminder).toContain('[Story Complete]');
    expect(reminder).toContain('free conversation mode');
    // The finished-mode reminder is the guard against aimless fiction: no new
    // invented quests/documents, proactive suggestions grounded in real context.
    expect(reminder).toContain('Do not restart or continue the story script');
    expect(reminder).toContain('ground every proactive suggestion in something real');
    // The stage script must be gone entirely.
    expect(reminder).not.toContain('Invite the user on a fictional quest.');
    expect(reminder).not.toContain('finish_target');
  });
});

describe('ModManager.finishTarget', () => {
  it('advances stages and finishes the story after the last stage', () => {
    const mm = new ModManager(makeConfig());

    const partial = mm.finishTarget([1]);
    expect(partial.stageCompleted).toBe(false);
    expect(mm.currentStageIndex).toBe(0);

    const stageDone = mm.finishTarget([2]);
    expect(stageDone.stageCompleted).toBe(true);
    expect(stageDone.progressInfo?.stage_progress.next_stage?.name).toBe('Finale');
    expect(mm.currentStageIndex).toBe(1);

    const storyDone = mm.finishTarget([3]);
    expect(storyDone.stageCompleted).toBe(true);
    expect(storyDone.progressInfo?.stage_progress.all_stages_finished).toBe(true);
    expect(mm.isFinished).toBe(true);
    expect(mm.buildStageReminder()).toContain('[Story Complete]');
  });

  it('ignores unknown or already-completed targets and finished stories', () => {
    const mm = new ModManager(makeConfig());

    expect(mm.finishTarget([99]).message).toBe('No new targets completed.');
    mm.finishTarget([1]);
    expect(mm.finishTarget([1]).message).toBe('No new targets completed.');

    mm.finishTarget([2]);
    mm.finishTarget([3]);
    expect(mm.finishTarget([3]).message).toBe('All stages already completed.');
  });
});
