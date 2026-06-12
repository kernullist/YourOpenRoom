import { tokenizeCommand } from './workspaceCommandPolicy';
import type {
  AoiApprovedCommandPolicy,
  AoiApprovedCommandRequest,
  AoiAutonomyRisk,
  AoiCommandBlockReason,
} from './aoiAutonomyTypes';

export const AOI_APPROVED_COMMAND_TIMEOUT_MS = 30_000;
export const AOI_COMMAND_APPROVAL_TTL_MS = 5 * 60 * 1000;

const MAX_COMMAND_CHARS = 320;
const SHELL_METACHAR_REGEX = /[|&;<>`\r\n]/;
const SAFE_PACKAGE_FILTER = /^@openroom\/[A-Za-z0-9._-]+$/;
const SAFE_RELATIVE_CWD = /^[A-Za-z0-9._/-]+$/;
const SAFE_TEST_TARGET =
  /^(?:src|apps\/webuiapps\/src)\/[A-Za-z0-9._/-]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SAFE_GIT_TOKEN = /^[A-Za-z0-9._/@:+,=-]+$/;

const DESTRUCTIVE_TOKENS = new Set([
  'remove-item',
  'del',
  'erase',
  'rm',
  'rmdir',
  'move',
  'mv',
  'copy',
  'cp',
  'robocopy',
  'xcopy',
  'new-item',
  'set-content',
  'add-content',
  'out-file',
]);

const PACKAGE_MUTATION_TOKENS = new Set([
  'install',
  'add',
  'remove',
  'rm',
  'update',
  'upgrade',
  'publish',
  'deploy',
  'create',
  'dlx',
  'link',
  'unlink',
  'rebuild',
]);

const SECRET_TOKENS = [
  'secret',
  'token',
  'apikey',
  'api-key',
  'api_key',
  'password',
  'passwd',
  'credential',
  'private-key',
  'private_key',
  'auth',
  'oauth',
];

const NETWORK_MUTATION_TOKENS = new Set([
  'curl',
  'wget',
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
  'scp',
  'sftp',
  'ssh',
  'gh',
]);

const BACKGROUND_TOKENS = new Set(['start', 'start-process', 'nohup', 'setsid']);
const INTERACTIVE_SHELL_TOKENS = new Set(['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh']);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeCommand(value: unknown): string {
  return typeof value === 'string' ? normalizeWhitespace(value).slice(0, MAX_COMMAND_CHARS) : '';
}

function normalizePurpose(value: unknown): string {
  const purpose = typeof value === 'string' ? normalizeWhitespace(value).slice(0, 180) : '';
  return purpose || 'Run an approved Aoi validation or inspection command.';
}

function normalizeTimeoutMs(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 15_000;
  }
  return Math.min(AOI_APPROVED_COMMAND_TIMEOUT_MS, Math.max(1_000, Math.trunc(parsed)));
}

export function normalizeAoiApprovedCommandCwd(value: unknown): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim().replace(/\\/g, '/') : '.';
  const withoutSlashes = raw.replace(/^\.\/+/, '').replace(/\/+$/g, '');
  return withoutSlashes === '' ? '.' : withoutSlashes;
}

function isSafeRelativeCwd(value: string): boolean {
  if (value === '.') {
    return true;
  }
  if (!SAFE_RELATIVE_CWD.test(value)) {
    return false;
  }
  return !value.includes('..') && !/^[A-Za-z]:\//.test(value) && !value.startsWith('/');
}

function hashStable(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function dedupeReasons(reasons: AoiCommandBlockReason[]): AoiCommandBlockReason[] {
  return [...new Set(reasons)];
}

function tokenHasSecretIntent(token: string): boolean {
  const lower = token.toLowerCase();
  return SECRET_TOKENS.some((secretToken) => lower.includes(secretToken));
}

function tokenHasNetworkMutationIntent(token: string): boolean {
  const lower = token.toLowerCase();
  if (NETWORK_MUTATION_TOKENS.has(lower)) {
    return true;
  }
  return lower === 'push' || lower === 'pull' || lower === 'fetch' || lower === 'clone';
}

function collectGlobalBlockReasons(command: string, tokens: string[]): AoiCommandBlockReason[] {
  const reasons: AoiCommandBlockReason[] = [];
  if (!command) {
    reasons.push('missing_command');
  }
  if (command.length >= MAX_COMMAND_CHARS) {
    reasons.push('command_too_long');
  }
  if (SHELL_METACHAR_REGEX.test(command)) {
    reasons.push('shell_metacharacters');
  }
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (DESTRUCTIVE_TOKENS.has(lower)) {
      reasons.push('destructive_file_operation');
    }
    if (PACKAGE_MUTATION_TOKENS.has(lower)) {
      reasons.push('package_install_or_update');
    }
    if (tokenHasSecretIntent(lower)) {
      reasons.push('credential_or_secret_command');
    }
    if (tokenHasNetworkMutationIntent(lower)) {
      reasons.push('network_mutation_command');
    }
    if (BACKGROUND_TOKENS.has(lower)) {
      reasons.push('background_process_launch');
    }
    if (INTERACTIVE_SHELL_TOKENS.has(lower)) {
      reasons.push('interactive_shell');
    }
  }
  return reasons;
}

function validatePnpm(tokens: string[]): {
  args: string[];
  reasons: AoiCommandBlockReason[];
  rationale: string[];
} {
  const [, ...args] = tokens;
  const reasons: AoiCommandBlockReason[] = [];
  const rationale: string[] = [];

  if (tokens[1] !== '--filter' || !SAFE_PACKAGE_FILTER.test(tokens[2] || '')) {
    reasons.push('unsupported_pnpm_shape');
    return { args, reasons, rationale };
  }

  if (tokens.length === 4 && tokens[3] === 'build:test') {
    rationale.push('Allowed exact filtered build:test validation command.');
    return { args, reasons, rationale };
  }

  if (tokens[3] !== 'test' || tokens[4] !== '--') {
    reasons.push('unsupported_pnpm_shape');
    return { args, reasons, rationale };
  }

  const targets = tokens.slice(5);
  if (targets.length <= 0) {
    reasons.push('untargeted_test_command');
    return { args, reasons, rationale };
  }

  for (const target of targets) {
    const normalizedTarget = target.replace(/\\/g, '/');
    if (
      normalizedTarget !== target ||
      normalizedTarget.includes('..') ||
      normalizedTarget.includes(' ') ||
      normalizedTarget.startsWith('/') ||
      /^[A-Za-z]:\//.test(normalizedTarget) ||
      !SAFE_TEST_TARGET.test(normalizedTarget)
    ) {
      reasons.push('unsafe_test_target');
    }
  }

  if (reasons.length <= 0) {
    rationale.push('Allowed filtered pnpm test command with explicit test file targets.');
  }
  return { args, reasons, rationale };
}

function validateGit(tokens: string[]): {
  args: string[];
  reasons: AoiCommandBlockReason[];
  rationale: string[];
} {
  const [, ...args] = tokens;
  const reasons: AoiCommandBlockReason[] = [];
  const rationale: string[] = [];
  const subcommand = args[0]?.toLowerCase() || '';
  const rest = args.slice(1);

  if (args.some((arg) => !SAFE_GIT_TOKEN.test(arg) || arg.includes('..'))) {
    reasons.push('unsafe_git_argument');
  }

  if (subcommand === 'diff') {
    const allowed = rest.every((arg) =>
      ['--check', '--stat', '--name-only', '--cached', '--', 'HEAD'].includes(arg),
    );
    if (!allowed) {
      reasons.push('unsafe_git_argument');
    } else {
      rationale.push(
        args.includes('--check')
          ? 'Allowed git diff --check validation command.'
          : 'Allowed read-only git diff inspection command.',
      );
    }
    return { args, reasons, rationale };
  }

  if (subcommand === 'status') {
    const allowed = rest.every((arg) =>
      ['--short', '--porcelain', '--porcelain=v1', '--branch'].includes(arg),
    );
    if (!allowed) {
      reasons.push('unsafe_git_argument');
    } else {
      rationale.push('Allowed read-only git status inspection command.');
    }
    return { args, reasons, rationale };
  }

  if (subcommand === 'log') {
    const allowed = rest.every(
      (arg) =>
        /^-\d+$/.test(arg) ||
        ['--oneline', '--stat', '--name-only', '--decorate', '--no-decorate'].includes(arg) ||
        arg.startsWith('--pretty='),
    );
    if (!allowed) {
      reasons.push('unsafe_git_argument');
    } else {
      rationale.push('Allowed read-only git log inspection command.');
    }
    return { args, reasons, rationale };
  }

  if (subcommand === 'show') {
    const allowed = rest.every(
      (arg) =>
        ['--stat', '--name-only', '--oneline', '--no-patch', 'HEAD'].includes(arg) ||
        /^[0-9a-fA-F]{6,40}$/.test(arg),
    );
    if (!allowed) {
      reasons.push('unsafe_git_argument');
    } else {
      rationale.push('Allowed read-only git show inspection command.');
    }
    return { args, reasons, rationale };
  }

  if (subcommand === 'branch') {
    if (rest.length === 1 && rest[0] === '--show-current') {
      rationale.push('Allowed read-only git branch inspection command.');
    } else {
      reasons.push('unsupported_git_shape');
    }
    return { args, reasons, rationale };
  }

  if (subcommand === 'rev-parse') {
    const allowed =
      rest.join(' ') === '--abbrev-ref HEAD' ||
      rest.join(' ') === '--short HEAD' ||
      rest.join(' ') === 'HEAD';
    if (allowed) {
      rationale.push('Allowed read-only git revision inspection command.');
    } else {
      reasons.push('unsupported_git_shape');
    }
    return { args, reasons, rationale };
  }

  reasons.push('unsupported_git_shape');
  return { args, reasons, rationale };
}

function buildFingerprint(params: {
  command: string;
  cwdHash: string;
  purposeHash: string;
  risk: AoiAutonomyRisk;
}): string {
  return hashStable(
    [
      'aoi-approved-command-v1',
      params.command,
      params.cwdHash,
      params.purposeHash,
      params.risk,
    ].join('\n'),
  );
}

export function createAoiApprovedCommandRequest(params: {
  sessionPath: string;
  proposalId?: string;
  decisionId?: string;
  command: unknown;
  cwd?: unknown;
  purpose?: unknown;
  risk?: AoiAutonomyRisk;
  timeoutMs?: unknown;
  requestedAt?: number;
  evidenceRefs?: string[];
}): AoiApprovedCommandRequest {
  return {
    version: 1,
    sessionPath: params.sessionPath,
    ...(params.proposalId ? { proposalId: params.proposalId } : {}),
    ...(params.decisionId ? { decisionId: params.decisionId } : {}),
    command: normalizeCommand(params.command),
    cwd: normalizeAoiApprovedCommandCwd(params.cwd),
    purpose: normalizePurpose(params.purpose),
    risk: params.risk ?? 'high',
    timeoutMs: normalizeTimeoutMs(params.timeoutMs),
    requestedAt: params.requestedAt ?? Date.now(),
    evidenceRefs: [...new Set(params.evidenceRefs ?? [])].slice(0, 16),
  };
}

export function evaluateAoiApprovedCommandPolicy(
  request: AoiApprovedCommandRequest,
): AoiApprovedCommandPolicy {
  const command = normalizeCommand(request.command);
  const cwd = normalizeAoiApprovedCommandCwd(request.cwd);
  const purpose = normalizePurpose(request.purpose);
  const cwdLabel = cwd === '.' ? 'workspace root' : cwd;
  const cwdHash = hashStable(cwd);
  const purposeHash = hashStable(purpose);
  let tokens: string[] = [];
  const reasons: AoiCommandBlockReason[] = [];
  const rationale: string[] = [];
  let program: AoiApprovedCommandPolicy['program'];
  let args: string[] = [];

  if (!isSafeRelativeCwd(cwd)) {
    reasons.push(cwd.includes('..') ? 'cwd_escapes_workspace' : 'cwd_not_relative');
  }

  try {
    tokens = command ? tokenizeCommand(command) : [];
  } catch {
    reasons.push('shell_metacharacters');
  }

  reasons.push(...collectGlobalBlockReasons(command, tokens));

  const programToken = tokens[0]?.toLowerCase() || '';
  if (tokens.length > 0 && reasons.length <= 0) {
    if (programToken === 'pnpm') {
      program = 'pnpm';
      const validation = validatePnpm(tokens);
      args = validation.args;
      reasons.push(...validation.reasons);
      rationale.push(...validation.rationale);
    } else if (programToken === 'git') {
      program = 'git';
      const validation = validateGit(tokens);
      args = validation.args;
      reasons.push(...validation.reasons);
      rationale.push(...validation.rationale);
    } else {
      reasons.push('unsupported_program');
    }
  }

  const blockReasons = dedupeReasons(reasons);
  return {
    version: 1,
    allowed: blockReasons.length === 0,
    blockReasons,
    command,
    displayCommand: command,
    ...(program ? { program } : {}),
    args,
    cwd,
    cwdLabel,
    cwdHash,
    purpose,
    purposeHash,
    risk: request.risk,
    requiredAutonomyLevel: 'L5',
    timeoutMs: request.timeoutMs,
    approvalFingerprint: buildFingerprint({
      command,
      cwdHash,
      purposeHash,
      risk: request.risk,
    }),
    expiresAt: request.requestedAt + AOI_COMMAND_APPROVAL_TTL_MS,
    rationale:
      rationale.length > 0
        ? rationale
        : ['Command is blocked until it matches the approved validation allowlist.'],
  };
}

export function normalizeAoiApprovedCommandPolicy(
  value: unknown,
): AoiApprovedCommandPolicy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<AoiApprovedCommandPolicy>;
  if (
    raw.version !== 1 ||
    typeof raw.allowed !== 'boolean' ||
    !Array.isArray(raw.blockReasons) ||
    typeof raw.command !== 'string' ||
    typeof raw.displayCommand !== 'string' ||
    !Array.isArray(raw.args) ||
    typeof raw.cwd !== 'string' ||
    typeof raw.cwdLabel !== 'string' ||
    typeof raw.cwdHash !== 'string' ||
    typeof raw.purpose !== 'string' ||
    typeof raw.purposeHash !== 'string' ||
    (raw.risk !== 'low' && raw.risk !== 'medium' && raw.risk !== 'high') ||
    raw.requiredAutonomyLevel !== 'L5' ||
    typeof raw.timeoutMs !== 'number' ||
    typeof raw.approvalFingerprint !== 'string' ||
    typeof raw.expiresAt !== 'number' ||
    !Array.isArray(raw.rationale)
  ) {
    return undefined;
  }
  return {
    version: 1,
    allowed: raw.allowed,
    blockReasons: raw.blockReasons.filter(
      (item): item is AoiCommandBlockReason => typeof item === 'string',
    ),
    command: raw.command,
    displayCommand: raw.displayCommand,
    ...(raw.program === 'git' || raw.program === 'pnpm' ? { program: raw.program } : {}),
    args: raw.args.filter((item): item is string => typeof item === 'string'),
    cwd: raw.cwd,
    cwdLabel: raw.cwdLabel,
    cwdHash: raw.cwdHash,
    purpose: raw.purpose,
    purposeHash: raw.purposeHash,
    risk: raw.risk,
    requiredAutonomyLevel: 'L5',
    timeoutMs: raw.timeoutMs,
    approvalFingerprint: raw.approvalFingerprint,
    expiresAt: raw.expiresAt,
    rationale: raw.rationale.filter((item): item is string => typeof item === 'string'),
  };
}

export function compareAoiApprovedCommandApproval(params: {
  approved: AoiApprovedCommandPolicy | undefined;
  current: AoiApprovedCommandPolicy;
  now: number;
}): AoiCommandBlockReason[] {
  const approved = params.approved;
  if (!approved) {
    return ['approval_missing'];
  }
  const reasons: AoiCommandBlockReason[] = [];
  if (approved.expiresAt < params.now) {
    reasons.push('approval_expired');
  }
  if (approved.command !== params.current.command) {
    reasons.push('approval_command_changed');
  }
  if (approved.cwdHash !== params.current.cwdHash) {
    reasons.push('approval_cwd_changed');
  }
  if (approved.risk !== params.current.risk) {
    reasons.push('approval_risk_changed');
  }
  if (approved.purposeHash !== params.current.purposeHash) {
    reasons.push('approval_purpose_changed');
  }
  if (approved.approvalFingerprint !== params.current.approvalFingerprint) {
    if (!reasons.includes('approval_command_changed')) {
      reasons.push('approval_command_changed');
    }
  }
  return dedupeReasons(reasons);
}
