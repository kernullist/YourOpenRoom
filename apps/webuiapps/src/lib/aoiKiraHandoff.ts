import type { AoiAutonomyRisk, AoiProposal } from './aoiAutonomyTypes';

export interface AoiKiraHandoffPreview {
  version: 1;
  kind: 'create_kira_work';
  proposalId: string;
  title: string;
  objective: string;
  projectName: string;
  scope: string[];
  likelyFilesOrModules: string[];
  nonGoals: string[];
  validationCommands: string[];
  riskLevel: AoiAutonomyRisk;
  rollbackExpectations: string[];
  reviewExpectations: string[];
  evidenceRefs: string[];
  constraints: string[];
  requiresReview: true;
  finalActionLabel: 'Create Kira work item';
  noSideEffects: true;
  createdAt: number;
}

export interface AoiKiraHandoffCreateResult {
  kind: 'create_kira_work';
  preview: AoiKiraHandoffPreview;
  work: {
    id: string;
    ref: string;
    title: string;
    projectName: string;
    status: string;
  };
  reviewRequired: true;
  route: '/kira';
  openPayload: {
    workId: string;
    focusType: 'work';
  };
}

const MAX_LIST_ITEMS = 8;
const MAX_TEXT_CHARS = 220;
const DEFAULT_PROJECT_NAME = 'default';
const DEFAULT_VALIDATION_COMMANDS = [
  'pnpm --filter @openroom/webuiapps test',
  'pnpm --filter @openroom/webuiapps build:test',
];
const AOI_KIRA_VALIDATION_COMMANDS = [
  'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyPolicy.test.ts src/lib/__tests__/aoiAutonomyExecution.test.ts src/lib/__tests__/aoiAutonomyEngine.test.ts',
  'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyRelations.test.ts src/lib/__tests__/aoiAutonomyUi.test.ts',
  'pnpm --filter @openroom/webuiapps build:test',
];
const BROAD_SCOPE_PATTERN =
  /\b(?:all|entire|whole|every|everything|project-wide|codebase-wide)\b.*\b(?:repo|repository|codebase|project|app|system|files|modules)\b|\b(?:full rewrite|complete rewrite|rewrite the app|refactor all)\b/i;
const BROAD_SCOPE_ITEM_PATTERN =
  /^(?:all|everything|repo|repository|codebase|project|app|system|frontend|backend|all files|all modules)$/i;
const WINDOWS_OR_UNC_PATH_PATTERN = /(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]*/;
const UNIX_ABSOLUTE_PATH_PATTERN =
  /(?:^|\s)(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace|etc|root)\/|~\/|\.\.\/)/;
const PROJECT_NAME_PATTERN = /^[A-Za-z0-9._ -]{1,80}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value: unknown, fallback = '', maxLength = MAX_TEXT_CHARS): string {
  const raw = typeof value === 'string' ? value : fallback;
  const normalized = raw.replace(/\s+/g, ' ').trim();
  return normalized.slice(0, maxLength);
}

function uniqueStrings(values: string[], limit = MAX_LIST_ITEMS): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function stringListFromParams(params: Record<string, unknown>, keys: string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string') {
      values.push(value);
      continue;
    }
    if (!Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      if (typeof item === 'string') {
        values.push(item);
      }
    }
  }
  return uniqueStrings(values);
}

export function normalizeAoiKiraProjectName(value: unknown): string {
  const normalized = normalizeText(value, DEFAULT_PROJECT_NAME, 80) || DEFAULT_PROJECT_NAME;
  if (
    !PROJECT_NAME_PATTERN.test(normalized) ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    normalized.includes(':') ||
    normalized.includes('..')
  ) {
    return DEFAULT_PROJECT_NAME;
  }
  return normalized;
}

function normalizeObjective(proposal: AoiProposal, params: Record<string, unknown>): string {
  return (
    normalizeText(params.objective, '', 300) ||
    normalizeText(proposal.title, '', 300) ||
    normalizeText(
      proposal.body,
      'Create a reviewed Kira work item from the accepted Aoi proposal.',
      300,
    )
  );
}

function inferScope(proposal: AoiProposal, params: Record<string, unknown>): string[] {
  const direct = stringListFromParams(params, ['scope', 'taskScope', 'task_scope', 'areas']);
  if (direct.length > 0) {
    return direct;
  }
  const inferred = [
    proposal.acceptAction?.kind ? `Aoi action: ${proposal.acceptAction.kind}` : '',
    ...proposal.suggestedTools.map((tool) => `Tool policy: ${tool}`),
  ];
  return uniqueStrings(inferred, 4);
}

function inferLikelyFilesOrModules(
  proposal: AoiProposal,
  params: Record<string, unknown>,
): string[] {
  const direct = stringListFromParams(params, [
    'modules',
    'moduleRefs',
    'module_refs',
    'components',
    'likelyModules',
    'likely_modules',
  ]);
  if (direct.length > 0) {
    return direct;
  }
  const refs = [...proposal.artifactRefs, ...proposal.evidenceRefs]
    .map((ref) => {
      if (ref.startsWith('research:')) {
        return 'Aoi Research artifacts';
      }
      if (ref.startsWith('goal:')) {
        return 'Aoi goals';
      }
      if (ref.startsWith('memory:')) {
        return 'Aoi memory';
      }
      if (ref.startsWith('proposal:')) {
        return 'Aoi proposals';
      }
      return '';
    })
    .filter(Boolean);
  return uniqueStrings(['Aoi autonomy', 'Kira workflow', ...refs], 6);
}

function inferValidationCommands(
  proposal: AoiProposal,
  params: Record<string, unknown>,
  scope: string[],
  modules: string[],
): string[] {
  const profile = normalizeText(params.validationProfile ?? params.validation_profile, '', 80);
  const haystack = `${profile} ${proposal.title} ${proposal.body} ${scope.join(' ')} ${modules.join(' ')}`;
  if (/aoi|autonomy|kira/i.test(haystack)) {
    return AOI_KIRA_VALIDATION_COMMANDS;
  }
  return DEFAULT_VALIDATION_COMMANDS;
}

function inferNonGoals(): string[] {
  return [
    'Do not edit repository files from this Aoi action.',
    'Do not run shell commands from this Aoi action.',
    'Do not bypass Kira worker review.',
  ];
}

function inferConstraints(): string[] {
  return [
    'Aoi may only create a Kira work item draft through the supervised handoff API.',
    'All repository mutations must remain inside Kira workflow gates.',
    'Kira should verify the cited evidence before implementation.',
  ];
}

export function buildAoiKiraHandoffPreview(
  proposal: AoiProposal,
  options: { now?: number } = {},
): AoiKiraHandoffPreview {
  const params = isRecord(proposal.acceptAction?.params) ? proposal.acceptAction.params : {};
  const objective = normalizeObjective(proposal, params);
  const scope = inferScope(proposal, params);
  const likelyFilesOrModules = inferLikelyFilesOrModules(proposal, params);
  const validationCommands = inferValidationCommands(proposal, params, scope, likelyFilesOrModules);
  const projectName = normalizeAoiKiraProjectName(
    params.projectName ?? params.project_name ?? params.project,
  );
  const nonGoals = stringListFromParams(params, ['nonGoals', 'non_goals']);

  return {
    version: 1,
    kind: 'create_kira_work',
    proposalId: proposal.id,
    title: normalizeText(params.title, proposal.title, 180) || proposal.title,
    objective,
    projectName,
    scope,
    likelyFilesOrModules,
    nonGoals: nonGoals.length > 0 ? nonGoals : inferNonGoals(),
    validationCommands,
    riskLevel: proposal.risk,
    rollbackExpectations: [
      'Keep the Kira patch independently reviewable.',
      'If validation fails, leave review comments and do not integrate.',
    ],
    reviewExpectations: [
      'Kira reviewer approval is required before integration.',
      'Summarize evidence coverage, changed files, and validation results.',
    ],
    evidenceRefs: uniqueStrings([...proposal.evidenceRefs, ...proposal.artifactRefs], 12),
    constraints: inferConstraints(),
    requiresReview: true,
    finalActionLabel: 'Create Kira work item',
    noSideEffects: true,
    createdAt: options.now ?? Date.now(),
  };
}

export function hasAoiKiraHandoffArbitraryPath(proposal: AoiProposal): boolean {
  const params = isRecord(proposal.acceptAction?.params) ? proposal.acceptAction.params : {};
  const projectName = params.projectName ?? params.project_name ?? params.project;
  if (typeof projectName === 'string') {
    const normalized = projectName.trim();
    if (
      normalized.includes('/') ||
      normalized.includes('\\') ||
      normalized.includes(':') ||
      normalized.includes('..')
    ) {
      return true;
    }
  }

  const stack: unknown[] = [params];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') {
      if (
        WINDOWS_OR_UNC_PATH_PATTERN.test(value) ||
        UNIX_ABSOLUTE_PATH_PATTERN.test(value) ||
        value.includes('../') ||
        value.includes('..\\')
      ) {
        return true;
      }
      continue;
    }
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (isRecord(value)) {
      stack.push(...Object.values(value));
    }
  }
  return false;
}

export function collectAoiKiraHandoffScopeReasons(proposal: AoiProposal): string[] {
  const preview = buildAoiKiraHandoffPreview(proposal, { now: proposal.updatedAt });
  const reasons: string[] = [];
  if (preview.scope.length === 0) {
    reasons.push('kira_handoff_scope_missing');
  }
  const scopeText = `${preview.objective} ${preview.scope.join(' ')} ${proposal.body}`;
  if (
    BROAD_SCOPE_PATTERN.test(scopeText) ||
    preview.scope.length > 6 ||
    preview.scope.some((item) => BROAD_SCOPE_ITEM_PATTERN.test(item))
  ) {
    reasons.push('kira_handoff_scope_too_broad');
  }
  if (hasAoiKiraHandoffArbitraryPath(proposal)) {
    reasons.push('action_params_include_filesystem_path');
  }
  return reasons;
}

export function getAoiKiraSafeNarrowingSuggestion(): string {
  return 'Narrow the Kira handoff to one accepted task with 1-3 modules, explicit non-goals, evidence refs, and validation expectations.';
}
