export interface WorkspaceCommandSpec {
  program: 'git' | 'node' | 'npm' | 'pnpm';
  args: string[];
  displayCommand: string;
}

export type WorkspaceCommandValidationResult =
  | { ok: true; spec: WorkspaceCommandSpec }
  | { ok: false; error: string };

const SHELL_METACHAR_REGEX = /[|&;<>`\r\n]/;
const SAFE_SCRIPT_NAMES = new Set(['test', 'lint', 'build', 'typecheck']);
const DISALLOWED_ARGS = new Set([
  '--fix',
  '--write',
  '--watch',
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
]);
const SAFE_GIT_COMMANDS = new Set(['status', 'diff', 'show', 'log', 'branch', 'rev-parse']);
// Flags that make an otherwise read-only command write or read OUTSIDE the
// workspace, matched by name with or without "=value": git diff/log/show
// --output=<any path>, git diff --no-index <a> <b> (reads any two files),
// vite build --outDir <dir> --emptyOutDir (empties it), eslint -o/--output-file,
// vitest --outputFile.
const DISALLOWED_FLAG_NAMES = new Set([
  '--output',
  '--output-file',
  '--outputfile',
  '-o',
  '--outdir',
  '--out-dir',
  '--outfile',
  '--emptyoutdir',
  '--empty-out-dir',
  '--no-index',
]);
// `git branch <name>` creates a branch and -d/-m/-f/-u rewrite refs; only
// listing is read-only.
const SAFE_GIT_BRANCH_FLAGS = new Set([
  '-a',
  '-r',
  '-v',
  '-vv',
  '--all',
  '--remotes',
  '--verbose',
  '--show-current',
  '--list',
  '--no-color',
]);

function hasShellMetacharacters(value: string): boolean {
  return SHELL_METACHAR_REGEX.test(value);
}

function isDisallowedArg(value: string): boolean {
  const lower = value.toLowerCase();
  return DISALLOWED_ARGS.has(lower) || DISALLOWED_FLAG_NAMES.has(lower.split('=')[0]);
}

export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === '\\' && index + 1 < command.length) {
        current += command[index + 1];
        index++;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error('Unterminated quoted string in command.');
  }

  if (current) tokens.push(current);
  return tokens;
}

function validateGitArgs(args: string[]): WorkspaceCommandValidationResult {
  const subcommand = args[0]?.toLowerCase();
  if (!subcommand || !SAFE_GIT_COMMANDS.has(subcommand)) {
    return {
      ok: false,
      error:
        'git commands are limited to status, diff, show, log, branch, and rev-parse in safe mode.',
    };
  }

  if (args.some((arg) => isDisallowedArg(arg) || hasShellMetacharacters(arg))) {
    return { ok: false, error: 'Unsafe git arguments were rejected.' };
  }

  if (
    subcommand === 'branch' &&
    !args.slice(1).every((arg) => SAFE_GIT_BRANCH_FLAGS.has(arg.toLowerCase()))
  ) {
    return {
      ok: false,
      error: 'git branch is limited to listing (-a, -r, -v, --show-current, --list) in safe mode.',
    };
  }

  return {
    ok: true,
    spec: {
      program: 'git',
      args,
      displayCommand: `git ${args.join(' ')}`.trim(),
    },
  };
}

function validateNodeArgs(args: string[]): WorkspaceCommandValidationResult {
  if (args.length !== 1 || !['-v', '--version'].includes(args[0])) {
    return {
      ok: false,
      error: 'node commands are limited to version checks in safe mode.',
    };
  }

  return {
    ok: true,
    spec: {
      program: 'node',
      args,
      displayCommand: `node ${args[0]}`,
    },
  };
}

function validatePackageManagerArgs(
  program: 'npm' | 'pnpm',
  args: string[],
): WorkspaceCommandValidationResult {
  if (args.length === 0) {
    return { ok: false, error: `${program} requires a command.` };
  }

  if (args.some((arg) => isDisallowedArg(arg) || hasShellMetacharacters(arg))) {
    return { ok: false, error: `Unsafe ${program} arguments were rejected.` };
  }

  const [first, second, third, ...rest] = args;
  const lowerFirst = first.toLowerCase();
  const lowerSecond = second?.toLowerCase() || '';
  const lowerThird = third?.toLowerCase() || '';

  if (SAFE_SCRIPT_NAMES.has(lowerFirst)) {
    return {
      ok: true,
      spec: {
        program,
        args,
        displayCommand: `${program} ${args.join(' ')}`.trim(),
      },
    };
  }

  if (lowerFirst === 'run' && SAFE_SCRIPT_NAMES.has(lowerSecond)) {
    return {
      ok: true,
      spec: {
        program,
        args,
        displayCommand: `${program} ${args.join(' ')}`.trim(),
      },
    };
  }

  if (lowerFirst === 'exec' && lowerSecond === 'vite' && lowerThird === 'build') {
    return {
      ok: true,
      spec: {
        program,
        args,
        displayCommand: `${program} ${args.join(' ')}`.trim(),
      },
    };
  }

  if (lowerFirst === 'exec' && lowerSecond === 'vitest' && lowerThird === 'run') {
    return {
      ok: true,
      spec: {
        program,
        args,
        displayCommand: `${program} ${args.join(' ')}`.trim(),
      },
    };
  }

  if (
    lowerFirst === 'exec' &&
    lowerSecond === 'eslint' &&
    ![third, ...rest].some((arg) => (arg || '').toLowerCase() === '--fix')
  ) {
    return {
      ok: true,
      spec: {
        program,
        args,
        displayCommand: `${program} ${args.join(' ')}`.trim(),
      },
    };
  }

  if (
    lowerFirst === 'exec' &&
    lowerSecond === 'tsc' &&
    [lowerThird, ...rest.map((arg) => arg.toLowerCase())].includes('--noemit')
  ) {
    return {
      ok: true,
      spec: {
        program,
        args,
        displayCommand: `${program} ${args.join(' ')}`.trim(),
      },
    };
  }

  if (
    lowerFirst === 'exec' &&
    lowerSecond === 'playwright' &&
    lowerThird === 'test' &&
    rest.map((arg) => arg.toLowerCase()).includes('--list')
  ) {
    return {
      ok: true,
      spec: {
        program,
        args,
        displayCommand: `${program} ${args.join(' ')}`.trim(),
      },
    };
  }

  return {
    ok: false,
    error: `${program} safe mode only allows test/lint/build/typecheck scripts and read-only exec commands.`,
  };
}

export function validateWorkspaceCommand(command: string): WorkspaceCommandValidationResult {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, error: 'Command is required.' };
  if (hasShellMetacharacters(trimmed)) {
    return { ok: false, error: 'Shell metacharacters are not allowed in safe mode.' };
  }

  let tokens: string[];
  try {
    tokens = tokenizeCommand(trimmed);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (tokens.length === 0) {
    return { ok: false, error: 'Command is required.' };
  }

  const [programToken, ...args] = tokens;
  const program = programToken.toLowerCase();

  switch (program) {
    case 'git':
      return validateGitArgs(args);
    case 'node':
      return validateNodeArgs(args);
    case 'npm':
    case 'pnpm':
      return validatePackageManagerArgs(program, args);
    default:
      return {
        ok: false,
        error: 'Only git, node, npm, and pnpm are allowed in safe mode.',
      };
  }
}
