import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AOI_WORKSHOP_SKILLS,
  buildAoiRegisteredSkillToolsCatalog,
  buildAoiSkillsPrompt,
  createUserAoiWorkshopSkill,
  normalizeAoiWorkshopSkills,
  removeAoiWorkshopSkill,
  resolveAoiActiveSkills,
  resolveAoiRegisteredSkillTools,
  sanitizeAoiSkillTool,
  summarizeAoiSkillsWorkshop,
  updateAoiWorkshopSkill,
  upsertAoiWorkshopSkill,
} from '../aoiSkillsWorkshop';

describe('aoiSkillsWorkshop', () => {
  it('creates user skills enabled but untrusted by default', () => {
    const userSkill = createUserAoiWorkshopSkill({
      name: 'Procedure Draft',
      triggerTerms: ['procedure draft'],
      body: 'Use this only after trust is granted.',
      now: 90,
    });

    expect(userSkill).toMatchObject({
      enabled: true,
      trusted: false,
      source: 'user',
    });
  });

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
    // Built-ins register no tools.
    expect(summary.registeredTools).toBe(0);
  });
});

describe('aoiSkillsWorkshop registered tools (P5.8)', () => {
  function toolSkill(now = 1) {
    return createUserAoiWorkshopSkill({
      name: 'Read Research Index',
      triggerTerms: ['research index'],
      body: 'Look up the research index.',
      tool: {
        name: 'read research index',
        description: 'Read the research index.',
        readOnly: true,
      },
      now,
    });
  }

  it('registers a read-only tool ONLY once the skill is trusted (human-approval gate)', () => {
    const skill = toolSkill();
    expect(skill.tool).toMatchObject({ name: 'read-research-index', readOnly: true });

    // Enabled but untrusted -> the tool is NOT registered.
    let skills = upsertAoiWorkshopSkill(DEFAULT_AOI_WORKSHOP_SKILLS, skill);
    expect(resolveAoiRegisteredSkillTools(skills)).toEqual([]);

    // Trusting the skill registers its tool.
    skills = updateAoiWorkshopSkill(skills, skill.id, { trusted: true }, 2);
    const tools = resolveAoiRegisteredSkillTools(skills);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: 'read-research-index', readOnly: true });
  });

  it('does not register a trusted-but-disabled skill tool', () => {
    const skill = toolSkill();
    let skills = upsertAoiWorkshopSkill(DEFAULT_AOI_WORKSHOP_SKILLS, skill);
    skills = updateAoiWorkshopSkill(skills, skill.id, { trusted: true, enabled: false }, 2);
    expect(resolveAoiRegisteredSkillTools(skills)).toEqual([]);
  });

  it('dedupes registered tools by name across trusted skills', () => {
    const a = createUserAoiWorkshopSkill({
      name: 'A',
      body: 'x',
      tool: { name: 'shared tool', description: 'first', readOnly: true },
      now: 1,
    });
    const b = createUserAoiWorkshopSkill({
      name: 'B',
      body: 'y',
      tool: { name: 'shared tool', description: 'second', readOnly: true },
      now: 2,
    });
    let skills = upsertAoiWorkshopSkill(upsertAoiWorkshopSkill(DEFAULT_AOI_WORKSHOP_SKILLS, a), b);
    skills = updateAoiWorkshopSkill(skills, a.id, { trusted: true }, 3);
    skills = updateAoiWorkshopSkill(skills, b.id, { trusted: true }, 4);
    expect(resolveAoiRegisteredSkillTools(skills)).toHaveLength(1);
  });

  it('counts registered tools in the summary and builds an advisory catalog', () => {
    const skill = toolSkill();
    let skills = upsertAoiWorkshopSkill(DEFAULT_AOI_WORKSHOP_SKILLS, skill);
    skills = updateAoiWorkshopSkill(skills, skill.id, { trusted: true }, 2);
    expect(summarizeAoiSkillsWorkshop(skills).registeredTools).toBe(1);
    const catalog = buildAoiRegisteredSkillToolsCatalog(resolveAoiRegisteredSkillTools(skills));
    expect(catalog).toContain('read-research-index');
    expect(catalog).toContain('requires approval');
    expect(buildAoiRegisteredSkillToolsCatalog([])).toBe('');
  });

  it('drops a non-read-only or malformed tool descriptor (read-only first)', () => {
    // Non-read-only -> dropped at creation.
    const notReadOnly = createUserAoiWorkshopSkill({
      name: 'Writer',
      body: 'x',
      tool: { name: 'writer_tool', description: 'writes', readOnly: false },
      now: 1,
    });
    expect(notReadOnly.tool).toBeUndefined();

    // A malformed tool injected onto a stored skill is stripped by normalization.
    const skill = { ...toolSkill(), trusted: true };
    const withBadTool = { ...skill, tool: { name: 'x', readOnly: false } } as never;
    const normalized = normalizeAoiWorkshopSkills([withBadTool]);
    expect(normalized.find((item) => item.id === skill.id)?.tool).toBeUndefined();
  });

  it('sanitizeAoiSkillTool enforces read-only + a usable name', () => {
    expect(sanitizeAoiSkillTool({ name: 'my tool', description: 'd', readOnly: true })).toEqual({
      name: 'my-tool',
      description: 'd',
      readOnly: true,
    });
    expect(sanitizeAoiSkillTool({ name: 'x', description: 'd', readOnly: false })).toBeUndefined();
    expect(sanitizeAoiSkillTool({ description: 'no name', readOnly: true })).toBeUndefined();
    expect(sanitizeAoiSkillTool({ name: '!!!', readOnly: true })).toBeUndefined();
    expect(sanitizeAoiSkillTool(null)).toBeUndefined();
    expect(sanitizeAoiSkillTool('nope')).toBeUndefined();
  });
});
