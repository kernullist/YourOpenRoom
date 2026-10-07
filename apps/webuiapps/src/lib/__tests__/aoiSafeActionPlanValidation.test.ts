import { describe, expect, it } from 'vitest';

import { buildAoiPreviewOnlyFileWorkPreparedActionPlan } from '../aoiSafeActionPlan';

describe('preview-only plan validation commands', () => {
  const base = {
    objective: 'Prepare memory promotion',
    existingGitStateAvailable: true,
  };

  it('keeps an explicit empty command list empty', () => {
    // save_memory passes []: the plan must not grow a `pnpm test` command and
    // become a command-capable work order that needs approval to run it.
    const plan = buildAoiPreviewOnlyFileWorkPreparedActionPlan({ ...base, validationCommands: [] });
    expect(plan.validation.commands).toEqual([]);
  });

  it('still defaults when no list is given, and keeps explicit commands', () => {
    const defaulted = buildAoiPreviewOnlyFileWorkPreparedActionPlan(base);
    expect(defaulted.validation.commands.length).toBeGreaterThan(0);
    const explicit = buildAoiPreviewOnlyFileWorkPreparedActionPlan({
      ...base,
      validationCommands: ['pnpm run typecheck', 'pnpm run typecheck'],
    });
    expect(explicit.validation.commands).toEqual(['pnpm run typecheck']);
  });
});
