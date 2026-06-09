export interface AoiWorkshopSkill {
  id: string;
  name: string;
  description: string;
  triggerTerms: string[];
  body: string;
  enabled: boolean;
  trusted: boolean;
  source: 'built-in' | 'user';
  createdAt: number;
  updatedAt: number;
}

export interface AoiWorkshopSkillMatch {
  skill: AoiWorkshopSkill;
  score: number;
  matchedTerms: string[];
}

export interface AoiSkillsWorkshopSummary {
  total: number;
  enabled: number;
  trusted: number;
  builtIn: number;
  user: number;
}

const STORAGE_KEY = 'openroom-aoi-skills-workshop-v1';
const MAX_ACTIVE_SKILLS = 4;
const MAX_SKILL_BODY_CHARS = 1200;

export const DEFAULT_AOI_WORKSHOP_SKILLS: AoiWorkshopSkill[] = [
  {
    id: 'review-mode',
    name: 'Review Mode',
    description: 'Re-check implemented work, identify bugs, fix them, then verify again.',
    triggerTerms: ['review mode', '리뷰모드', '다시 검토', '버그를 수정', '검토해서'],
    body: 'After a meaningful implementation step, switch to review mode: inspect the diff, look for correctness, stability, security, and missing validation risks, fix concrete issues, then run focused verification before reporting completion.',
    enabled: true,
    trusted: true,
    source: 'built-in',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'current-research',
    name: 'Current Research',
    description: 'Use live research before answering unstable or latest-information requests.',
    triggerTerms: ['latest', 'current', 'recent', '최신', '조사', '트렌드', 'verify'],
    body: 'For current, latest, or fast-moving topics, gather fresh evidence before answering. Prefer primary or official sources when available, compare dates, and separate confirmed facts from implementation recommendations.',
    enabled: true,
    trusted: true,
    source: 'built-in',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'stepwise-delivery',
    name: 'Stepwise Delivery',
    description: 'Break large work into explicit stages with verification before moving on.',
    triggerTerms: ['단계별', 'step by step', '구현하고', '검증', '커밋', 'commit'],
    body: 'For multi-stage work, handle one stage at a time: implement, review the changed surface, fix issues, verify with targeted tests or build checks, record the result, and only then move to the next stage.',
    enabled: true,
    trusted: true,
    source: 'built-in',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'windows-security-engineering',
    name: 'Windows Security Engineering',
    description: 'Favor practical anti-cheat and Windows security engineering details.',
    triggerTerms: ['anti-cheat', '안티치트', 'windows security', 'kernel', '커널', 'ue5', '보안'],
    body: 'For Windows security, anti-cheat, kernel/user-mode telemetry, memory inspection, TPM verification, or Unreal Engine security topics, prioritize practical architecture, failure paths, compatibility notes, false-positive control, and operational verification.',
    enabled: true,
    trusted: true,
    source: 'built-in',
    createdAt: 1,
    updatedAt: 1,
  },
];

export function loadAoiSkillsWorkshop(): AoiWorkshopSkill[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_AOI_WORKSHOP_SKILLS;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return DEFAULT_AOI_WORKSHOP_SKILLS;
    }
    return mergeBuiltInAoiSkills(parsed.filter(isAoiWorkshopSkill));
  } catch {
    return DEFAULT_AOI_WORKSHOP_SKILLS;
  }
}

export function saveAoiSkillsWorkshop(skills: AoiWorkshopSkill[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeAoiWorkshopSkills(skills)));
  } catch {
    // ignore persistence failures
  }
}

export function normalizeAoiWorkshopSkills(skills: AoiWorkshopSkill[]): AoiWorkshopSkill[] {
  return mergeBuiltInAoiSkills(skills)
    .map((skill) => ({
      ...skill,
      name: truncateSingleLine(skill.name, 80),
      description: truncateSingleLine(skill.description, 180),
      triggerTerms: skill.triggerTerms
        .map((term) => term.trim())
        .filter(Boolean)
        .slice(0, 16),
      body: truncateText(skill.body.trim(), MAX_SKILL_BODY_CHARS),
      enabled: Boolean(skill.enabled),
      trusted: Boolean(skill.trusted),
    }))
    .sort((left, right) => {
      if (left.source !== right.source) {
        return left.source === 'built-in' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
}

export function createUserAoiWorkshopSkill(params: {
  name: string;
  description?: string;
  triggerTerms?: string[];
  body: string;
  now?: number;
}): AoiWorkshopSkill {
  const now = params.now ?? Date.now();
  const name = truncateSingleLine(params.name.trim() || 'Untitled skill', 80);
  return {
    id: `user-${slugify(name)}-${now.toString(36)}`,
    name,
    description: truncateSingleLine(params.description?.trim() || 'User-authored Aoi skill.', 180),
    triggerTerms: (params.triggerTerms ?? [])
      .map((term) => term.trim())
      .filter(Boolean)
      .slice(0, 16),
    body: truncateText(params.body.trim(), MAX_SKILL_BODY_CHARS),
    enabled: true,
    trusted: false,
    source: 'user',
    createdAt: now,
    updatedAt: now,
  };
}

export function upsertAoiWorkshopSkill(
  skills: AoiWorkshopSkill[],
  skill: AoiWorkshopSkill,
): AoiWorkshopSkill[] {
  return normalizeAoiWorkshopSkills([skill, ...skills.filter((item) => item.id !== skill.id)]);
}

export function removeAoiWorkshopSkill(
  skills: AoiWorkshopSkill[],
  skillId: string,
): AoiWorkshopSkill[] {
  return normalizeAoiWorkshopSkills(
    skills.filter((skill) => skill.id !== skillId || skill.source === 'built-in'),
  );
}

export function updateAoiWorkshopSkill(
  skills: AoiWorkshopSkill[],
  skillId: string,
  updates: Partial<
    Pick<AoiWorkshopSkill, 'enabled' | 'trusted' | 'body' | 'description' | 'triggerTerms'>
  >,
  now = Date.now(),
): AoiWorkshopSkill[] {
  return normalizeAoiWorkshopSkills(
    skills.map((skill) =>
      skill.id === skillId
        ? {
            ...skill,
            ...updates,
            trusted: skill.source === 'built-in' ? true : (updates.trusted ?? skill.trusted),
            updatedAt: now,
          }
        : skill,
    ),
  );
}

export function resolveAoiActiveSkills(
  latestUserMessage: string,
  skills: AoiWorkshopSkill[],
  maxSkills = MAX_ACTIVE_SKILLS,
): AoiWorkshopSkillMatch[] {
  const text = latestUserMessage.toLowerCase();
  return normalizeAoiWorkshopSkills(skills)
    .filter((skill) => skill.enabled && skill.trusted)
    .map((skill) => {
      const matchedTerms = skill.triggerTerms.filter((term) => text.includes(term.toLowerCase()));
      const score = matchedTerms.length;
      return { skill, score, matchedTerms };
    })
    .filter((match) => match.score > 0)
    .sort(
      (left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name),
    )
    .slice(0, maxSkills);
}

export function buildAoiSkillsPrompt(matches: AoiWorkshopSkillMatch[]): string {
  if (matches.length === 0) {
    return '';
  }

  const lines = [
    '',
    'Aoi Skills Workshop:',
    '- Apply only the matched, trusted skills below for this turn.',
  ];

  matches.forEach((match) => {
    lines.push(`- ${match.skill.name}: ${truncateText(match.skill.body, MAX_SKILL_BODY_CHARS)}`);
  });

  return `\n${lines.join('\n')}`;
}

export function summarizeAoiSkillsWorkshop(skills: AoiWorkshopSkill[]): AoiSkillsWorkshopSummary {
  const normalized = normalizeAoiWorkshopSkills(skills);
  return {
    total: normalized.length,
    enabled: normalized.filter((skill) => skill.enabled).length,
    trusted: normalized.filter((skill) => skill.trusted).length,
    builtIn: normalized.filter((skill) => skill.source === 'built-in').length,
    user: normalized.filter((skill) => skill.source === 'user').length,
  };
}

function mergeBuiltInAoiSkills(skills: AoiWorkshopSkill[]): AoiWorkshopSkill[] {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  DEFAULT_AOI_WORKSHOP_SKILLS.forEach((builtIn) => {
    const existing = byId.get(builtIn.id);
    byId.set(builtIn.id, {
      ...builtIn,
      enabled: existing?.enabled ?? builtIn.enabled,
      trusted: true,
      updatedAt: existing?.updatedAt ?? builtIn.updatedAt,
    });
  });
  return Array.from(byId.values());
}

function isAoiWorkshopSkill(value: unknown): value is AoiWorkshopSkill {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<AoiWorkshopSkill>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.body === 'string' &&
    Array.isArray(record.triggerTerms) &&
    (record.source === 'built-in' || record.source === 'user')
  );
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'skill'
  );
}

function truncateSingleLine(value: string, maxChars: number): string {
  return truncateText(value.replace(/\s+/g, ' ').trim(), maxChars);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}
