import type {
  AoiUserAuthorizedPlanInput,
  AoiUserAuthorizedPlanResult,
} from './aoiUserAuthorizedPlan';

export const AOI_USER_AUTHORIZED_PLAN_EXIT_OK = 0;
export const AOI_USER_AUTHORIZED_PLAN_EXIT_ERROR = 1;
export const AOI_USER_AUTHORIZED_PLAN_EXIT_INPUT = 2;

export interface AoiUserAuthorizedPlanCliDeps {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  authorPlan: (input: AoiUserAuthorizedPlanInput) => AoiUserAuthorizedPlanResult;
  log: (message: string) => void;
  logError: (message: string) => void;
}
function readOption(argv: readonly string[], optionName: string, trim = true): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === optionName && index + 1 < argv.length) {
      return trim ? argv[index + 1].trim() : argv[index + 1];
    }
    const prefix = `${optionName}=`;
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length);
      return trim ? value.trim() : value;
    }
  }
  return '';
}

function readRequiredOption(
  argv: readonly string[],
  optionName: string,
  envValue?: string,
): string {
  return readOption(argv, optionName) || envValue?.trim() || '';
}

function decodeExactFileContent(argv: readonly string[]): string {
  const raw = readOption(argv, '--file-content', false);
  const base64 = readOption(argv, '--file-content-base64');
  if (raw && base64) {
    throw new Error('Pass only one of --file-content or --file-content-base64.');
  }
  if (raw) {
    return raw;
  }
  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new Error('Missing or invalid exact file content.');
  }
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.toString('base64') !== base64) {
    throw new Error('file-content-base64 is not canonical base64.');
  }
  return decoded.toString('utf8');
}

function buildInput(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): AoiUserAuthorizedPlanInput {
  const sessionsDir = readRequiredOption(
    argv,
    '--sessions-dir',
    env.AOI_SESSIONS_DIR ?? env.AOI_DAEMON_SESSIONS_DIR,
  );
  const sessionPath = readRequiredOption(argv, '--session-path', env.AOI_SESSION_PATH);
  const workspaceRoot = readRequiredOption(argv, '--workspace-root', env.AOI_DAEMON_WORKSPACE_ROOT);
  const goalTitle = readRequiredOption(argv, '--goal-title');
  const filePath = readRequiredOption(argv, '--file-path');
  const researchRequest = readRequiredOption(argv, '--research-request');
  const required: Array<[string, string]> = [
    ['--sessions-dir', sessionsDir],
    ['--session-path', sessionPath],
    ['--workspace-root', workspaceRoot],
    ['--goal-title', goalTitle],
    ['--file-path', filePath],
    ['--research-request', researchRequest],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Missing required options: ${missing.join(', ')}.`);
  }
  const mode = readOption(argv, '--research-mode') || 'standard';
  if (mode !== 'quick' && mode !== 'standard' && mode !== 'deep') {
    throw new Error('--research-mode must be quick, standard, or deep.');
  }
  const recency = readOption(argv, '--research-recency') || 'year';
  if (
    recency !== 'any' &&
    recency !== 'day' &&
    recency !== 'week' &&
    recency !== 'month' &&
    recency !== 'year'
  ) {
    throw new Error('--research-recency must be any, day, week, month, or year.');
  }
  const maxSourcesText = readOption(argv, '--research-max-sources') || '8';
  const maxSources = Number.parseInt(maxSourcesText, 10);
  if (!Number.isInteger(maxSources) || maxSources < 1 || maxSources > 12) {
    throw new Error('--research-max-sources must be an integer from 1 to 12.');
  }
  return {
    sessionsDir,
    sessionPath,
    workspaceRoot,
    goalTitle,
    filePath,
    fileContent: decodeExactFileContent(argv),
    researchRequest,
    researchMode: mode,
    researchLanguage: 'ko',
    researchRecency: recency,
    researchMaxSources: maxSources,
  };
}

export async function runAoiUserAuthorizedPlanCli(
  deps: AoiUserAuthorizedPlanCliDeps,
): Promise<number> {
  let input: AoiUserAuthorizedPlanInput;
  try {
    input = buildInput(deps.argv, deps.env);
  } catch (error) {
    deps.logError(`[aoi-user-authorized-plan] invalid input: ${String(error)}`);
    return AOI_USER_AUTHORIZED_PLAN_EXIT_INPUT;
  }

  try {
    const result = deps.authorPlan(input);
    deps.log(JSON.stringify(result, null, 2));
    deps.log('[aoi-user-authorized-plan] proposals authored; no action executed.');
    return AOI_USER_AUTHORIZED_PLAN_EXIT_OK;
  } catch (error) {
    deps.logError(`[aoi-user-authorized-plan] authoring failed: ${String(error)}`);
    return AOI_USER_AUTHORIZED_PLAN_EXIT_ERROR;
  }
}
