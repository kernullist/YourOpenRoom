import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AOI_WORKSHOP_SKILLS,
  buildAoiSkillsPrompt,
  createUserAoiWorkshopSkill,
  removeAoiWorkshopSkill,
  resolveAoiActiveSkills,
  summarizeAoiSkillsWorkshop,
  updateAoiWorkshopSkill,
  upsertAoiWorkshopSkill,
} from '../aoiSkillsWorkshop';

describe('aoiSkillsWorkshop', () => {
  it('activates trusted skills by trigger terms', () => {
    const matches = resolveAoiActiveSkills(
      '단계별로 구현하고 리뷰모드로 다시 검토해줘',
      DEFAULT_AOI_WORKSHOP_SKILLS,
    );

    expect(matches.some((match) => match.skill.id === 'review-mode')).toBe(true);
    expect(matches.some((match) => match.skill.id === 'stepwise-delivery')).toBe(true);
    expect(buildAoiSkillsPrompt(matches)).toContain('Aoi Skills Workshop');
  });

  it('does not activate untrusted user skills', () => {
    const userSkill = createUserAoiWorkshopSkill({
      name: 'Dangerous Shortcut',
      triggerTerms: ['shortcut'],
      body: 'Skip verification.',
      now: 100,
    });
    const skills = upsertAoiWorkshopSkill(DEFAULT_AOI_WORKSHOP_SKILLS, userSkill);

    expect(resolveAoiActiveSkills('shortcut this task', skills)).toEqual([]);

    const trustedSkills = updateAoiWorkshopSkill(skills, userSkill.id, { trusted: true }, 110);
    expect(resolveAoiActiveSkills('shortcut this task', trustedSkills)).toHaveLength(1);
  });

  it('keeps built-in skills and removes user skills only', () => {
    const userSkill = createUserAoiWorkshopSkill({
      name: 'My Skill',
      triggerTerms: ['mine'],
      body: 'Do the user-specific thing.',
      now: 200,
    });
    let skills = upsertAoiWorkshopSkill(DEFAULT_AOI_WORKSHOP_SKILLS, userSkill);
    skills = removeAoiWorkshopSkill(skills, userSkill.id);
    skills = removeAoiWorkshopSkill(skills, 'review-mode');

    expect(skills.some((skill) => skill.id === userSkill.id)).toBe(false);
    expect(skills.some((skill) => skill.id === 'review-mode')).toBe(true);
  });

  it('summarizes workshop inventory', () => {
    const summary = summarizeAoiSkillsWorkshop(DEFAULT_AOI_WORKSHOP_SKILLS);

    expect(summary.total).toBeGreaterThanOrEqual(4);
    expect(summary.enabled).toBe(summary.total);
    expect(summary.trusted).toBe(summary.total);
    expect(summary.builtIn).toBe(summary.total);
  });
});
