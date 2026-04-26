import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildDefaultValidationCommands,
  buildIssueSignature,
  detectTouchedFilesFromGitStatus,
  findMissingValidationCommands,
  findSuggestedCommitBackfillSummary,
  findOutOfPlanTouchedFiles,
  hasMergeConflictMarkers,
  isSafeCommandAllowed,
  parseGitStatusPorcelain,
  parseProjectDiscoveryAnalysis,
  parseStoredWorkerAttemptComment,
  parseWorkerExecutionPlan,
  resolveUnexpectedAutomationFailure,
  resolveValidationPlan,
  resolveProjectSettings,
  resolveRoleLlmConfig,
} from '../kiraAutomationPlugin';

describe('parseStoredWorkerAttemptComment()', () => {
  it('parses summary and list sections from a stored worker comment', () => {
    const summary = parseStoredWorkerAttemptComment(
      [
        'Attempt 1 finished.',
        '',
        'Summary:',
        '메인 페이지 하단의 문구를 제거했습니다.',
        '',
        'Files changed:',
        '- templates/index.html',
        '',
        'Checks:',
        '- No checks reported',
        '',
        'Remaining risks:',
        '- None reported',
      ].join('\n'),
    );

    expect(summary).toEqual({
      summary: '메인 페이지 하단의 문구를 제거했습니다.',
      filesChanged: ['templates/index.html'],
      testsRun: [],
      remainingRisks: [],
    });
  });

  it('ignores new trailing guardrail sections after remaining risks', () => {
    const summary = parseStoredWorkerAttemptComment(
      [
        'Attempt 2 finished.',
        '',
        'Plan:',
        'Tighten Kira guardrails.',
        '',
        'Summary:',
        'Added safer worker planning.',
        '',
        'Files changed:',
        '- apps/webuiapps/src/lib/kiraAutomationPlugin.ts',
        '',
        'Checks:',
        '- pnpm exec vitest apps/webuiapps/src/lib/__tests__/kiraAutomationPlugin.test.ts',
        '',
        'Remaining risks:',
        '- None reported',
        '',
        'Validation gaps:',
        '- No missing planned checks',
        '',
        'Out-of-plan files:',
        '- No out-of-plan files',
      ].join('\n'),
    );

    expect(summary).toEqual({
      summary: 'Added safer worker planning.',
      filesChanged: ['apps/webuiapps/src/lib/kiraAutomationPlugin.ts'],
      testsRun: ['pnpm exec vitest apps/webuiapps/src/lib/__tests__/kiraAutomationPlugin.test.ts'],
      remainingRisks: [],
    });
  });

  it('returns null for non-worker-attempt comments', () => {
    expect(parseStoredWorkerAttemptComment('Approved.\n\nLooks good.')).toBeNull();
  });
});

describe('parseWorkerExecutionPlan()', () => {
  it('normalizes files and filters unsafe planned commands into risk notes', () => {
    const plan = parseWorkerExecutionPlan(
      JSON.stringify({
        summary: 'Update the Kira automation guardrails.',
        intendedFiles: [
          './apps/webuiapps/src/lib/kiraAutomationPlugin.ts',
          'apps\\webuiapps\\src\\lib\\__tests__\\kiraAutomationPlugin.test.ts',
        ],
        validationCommands: [
          'pnpm exec vitest apps/webuiapps/src/lib/__tests__/kiraAutomationPlugin.test.ts',
          'npm install',
        ],
        riskNotes: ['Watch for dirty worktree handling.'],
      }),
    );

    expect(plan).toEqual({
      summary: 'Update the Kira automation guardrails.',
      intendedFiles: [
        'apps/webuiapps/src/lib/kiraAutomationPlugin.ts',
        'apps/webuiapps/src/lib/__tests__/kiraAutomationPlugin.test.ts',
      ],
      validationCommands: [
        'pnpm exec vitest apps/webuiapps/src/lib/__tests__/kiraAutomationPlugin.test.ts',
      ],
      riskNotes: [
        'Watch for dirty worktree handling.',
        'Planner suggested an unsafe validation command that was removed: npm install',
      ],
    });
  });

  it('caps planner validation commands and records the trimming in risk notes', () => {
    const plan = parseWorkerExecutionPlan(
      JSON.stringify({
        summary: 'Keep the validation plan short.',
        validationCommands: [
          'git diff --stat',
          'pnpm test',
          'pnpm run lint',
          'pnpm run typecheck',
          'python -m pytest',
        ],
      }),
    );

    expect(plan.validationCommands).toEqual([
      'git diff --stat',
      'pnpm test',
      'pnpm run lint',
      'pnpm run typecheck',
    ]);
    expect(plan.riskNotes).toContain(
      'Planner suggested 5 safe validation commands, so Kira kept only the first 4.',
    );
  });
});

describe('project default validation helpers', () => {
  it('adds a minimal Node default validation command from package scripts', () => {
    const projectRoot = fs.mkdtempSync(join(os.tmpdir(), 'kira-node-'));
    fs.writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@9.0.0',
        scripts: {
          typecheck: 'tsc --noEmit',
          test: 'vitest run',
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(join(projectRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9', 'utf-8');

    try {
      expect(buildDefaultValidationCommands(projectRoot, ['src/app.ts'])).toEqual([
        'pnpm run typecheck',
      ]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('adds a minimal Python default validation command when tests exist', () => {
    const projectRoot = fs.mkdtempSync(join(os.tmpdir(), 'kira-py-'));
    fs.mkdirSync(join(projectRoot, 'tests'), { recursive: true });
    fs.writeFileSync(
      join(projectRoot, 'tests', 'test_sample.py'),
      'def test_ok():\n    assert True\n',
      'utf-8',
    );

    try {
      expect(buildDefaultValidationCommands(projectRoot, ['app/main.py'])).toEqual([
        'python -m pytest',
      ]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('resolves planner and auto-added validation commands into one capped plan', () => {
    const projectRoot = fs.mkdtempSync(join(os.tmpdir(), 'kira-merge-'));
    fs.writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@9.0.0',
        scripts: {
          typecheck: 'tsc --noEmit',
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(join(projectRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9', 'utf-8');

    try {
      expect(
        resolveValidationPlan(
          projectRoot,
          ['git diff --stat', 'pnpm exec vitest src/foo.test.ts'],
          ['src/app.ts'],
        ),
      ).toEqual({
        plannerCommands: ['git diff --stat', 'pnpm exec vitest src/foo.test.ts'],
        autoAddedCommands: ['pnpm run typecheck'],
        effectiveCommands: [
          'git diff --stat',
          'pnpm exec vitest src/foo.test.ts',
          'pnpm run typecheck',
        ],
        notes: [],
      });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('findSuggestedCommitBackfillSummary()', () => {
  it('returns the latest approved attempt when a commit suggestion is missing', () => {
    const comments = [
      {
        id: 'worker-old',
        taskId: 'work-1',
        taskType: 'work' as const,
        author: 'Kira Worker',
        body: 'Attempt 1 finished.\n\nSummary:\n이전 변경입니다.\n\nFiles changed:\n- old.txt',
        createdAt: 1,
      },
      {
        id: 'approval-old',
        taskId: 'work-1',
        taskType: 'work' as const,
        author: 'Main AI Reviewer',
        body: 'Approved.\n\n이전 승인입니다.',
        createdAt: 2,
      },
      {
        id: 'commit-old',
        taskId: 'work-1',
        taskType: 'work' as const,
        author: 'Main AI Reviewer',
        body: 'Suggested commit message:\nfeat(project): 이전 변경',
        createdAt: 3,
      },
      {
        id: 'worker-new',
        taskId: 'work-1',
        taskType: 'work' as const,
        author: 'Kira Worker',
        body: 'Attempt 2 finished.\n\nSummary:\n최신 변경입니다.\n\nFiles changed:\n- new.txt',
        createdAt: 4,
      },
      {
        id: 'approval-new',
        taskId: 'work-1',
        taskType: 'work' as const,
        author: 'Main AI Reviewer',
        body: 'Approved.\n\n최신 승인입니다.',
        createdAt: 5,
      },
    ];

    expect(findSuggestedCommitBackfillSummary(comments)).toEqual({
      summary: '최신 변경입니다.',
      filesChanged: ['new.txt'],
      testsRun: [],
      remainingRisks: [],
    });
  });

  it('returns null when the latest approval already has a commit suggestion after it', () => {
    const comments = [
      {
        id: 'worker-new',
        taskId: 'work-1',
        taskType: 'work' as const,
        author: 'Kira Worker',
        body: 'Attempt 2 finished.\n\nSummary:\n최신 변경입니다.\n\nFiles changed:\n- new.txt',
        createdAt: 4,
      },
      {
        id: 'approval-new',
        taskId: 'work-1',
        taskType: 'work' as const,
        author: 'Main AI Reviewer',
        body: 'Approved.\n\n최신 승인입니다.',
        createdAt: 5,
      },
      {
        id: 'commit-new',
        taskId: 'work-1',
        taskType: 'work' as const,
        author: 'Main AI Reviewer',
        body: 'Suggested commit message:\nfeat(project): 최신 변경',
        createdAt: 6,
      },
    ];

    expect(findSuggestedCommitBackfillSummary(comments)).toBeNull();
  });
});

describe('parseProjectDiscoveryAnalysis()', () => {
  it('normalizes discovery findings and caps them at the allowed limit', () => {
    const raw = JSON.stringify({
      summary: 'Found good follow-up work.',
      findings: [
        {
          kind: 'bug',
          title: 'Fix duplicate footer copy',
          summary: 'Remove the redundant footer line.',
          evidence: ['templates/index.html duplicates the message'],
          files: ['templates/index.html'],
          taskDescription: '# Brief\n\nRemove the duplicate footer line.',
        },
        {
          title: 'Add previous episode links',
          summary: 'Users can see titles but cannot navigate further.',
          files: ['templates/index.html', 'app.py'],
        },
      ],
    });

    const parsed = parseProjectDiscoveryAnalysis(
      raw,
      'BriefWave-Cast',
      'F:/root/BriefWave-Cast',
      null,
    );

    expect(parsed.projectName).toBe('BriefWave-Cast');
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0]).toMatchObject({
      kind: 'bug',
      title: 'Fix duplicate footer copy',
      files: ['templates/index.html'],
    });
    expect(parsed.findings[1].kind).toBe('feature');
    expect(parsed.findings[1].taskDescription).toContain('# Brief');
  });

  it('falls back safely when the response is not valid JSON', () => {
    const parsed = parseProjectDiscoveryAnalysis(
      'not json',
      'BriefWave-Cast',
      'F:/root/BriefWave-Cast',
      null,
    );

    expect(parsed.summary).toBe('not json');
    expect(parsed.findings).toEqual([]);
  });
});

describe('resolveRoleLlmConfig()', () => {
  it('inherits provider and credentials from the base config when only model is overridden', () => {
    const resolved = resolveRoleLlmConfig(
      {
        provider: 'openrouter',
        apiKey: 'sk-test',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openai/gpt-5.4',
      },
      { model: 'openai/gpt-5.4-mini' },
      null,
    );

    expect(resolved).toEqual({
      provider: 'openrouter',
      apiKey: 'sk-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5.4-mini',
    });
  });

  it('allows a role-specific provider config to fully override the base config', () => {
    const resolved = resolveRoleLlmConfig(
      {
        provider: 'openrouter',
        apiKey: 'sk-test',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openai/gpt-5.4',
      },
      {
        provider: 'anthropic',
        apiKey: 'ant-test',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4.6',
      },
      null,
    );

    expect(resolved).toEqual({
      provider: 'anthropic',
      apiKey: 'ant-test',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4.6',
    });
  });
});

describe('resolveProjectSettings()', () => {
  it('defaults autoCommit to true when the project settings file is absent or empty', () => {
    expect(resolveProjectSettings(null)).toEqual({ autoCommit: true });
    expect(resolveProjectSettings({})).toEqual({ autoCommit: true });
  });

  it('respects an explicit autoCommit false value', () => {
    expect(resolveProjectSettings({ autoCommit: false })).toEqual({ autoCommit: false });
  });

  it('uses the provided fallback when the project file does not define autoCommit', () => {
    expect(resolveProjectSettings({}, { autoCommit: false })).toEqual({ autoCommit: false });
  });
});

describe('git status helpers', () => {
  it('parses porcelain output and detects only files newly touched by an attempt', () => {
    const before = parseGitStatusPorcelain(' M existing.py\n?? notes.txt');
    const after = parseGitStatusPorcelain(
      ' M existing.py\n M changed.py\n?? notes.txt\n?? new.txt',
    );

    expect(detectTouchedFilesFromGitStatus(before, after)).toEqual(['changed.py', 'new.txt']);
  });
});

describe('worker guardrail helpers', () => {
  it('flags files that fall outside the preflight plan', () => {
    expect(
      findOutOfPlanTouchedFiles(
        ['src/app.ts', 'tests/'],
        ['src/app.ts', 'tests/unit.spec.ts', 'docs/notes.md'],
      ),
    ).toEqual(['docs/notes.md']);
  });

  it('detects missing planned validation commands after normalization', () => {
    expect(
      findMissingValidationCommands(
        ['pnpm exec vitest src/foo.test.ts', 'git diff --stat'],
        ['  pnpm   exec   vitest src/foo.test.ts  '],
      ),
    ).toEqual(['git diff --stat']);
  });

  it('detects merge conflict markers in file content', () => {
    expect(
      hasMergeConflictMarkers(
        ['const value = 1;', '<<<<<<< HEAD', 'const value = 2;', '=======', '>>>>>>> branch'].join(
          '\n',
        ),
      ),
    ).toBe(true);
    expect(hasMergeConflictMarkers('const value = 1;\nconst next = value + 1;')).toBe(false);
  });
});

describe('isSafeCommandAllowed()', () => {
  it('allows curated diagnostic commands', () => {
    expect(isSafeCommandAllowed('python -m pytest tests/test_memory.py')).toBe(true);
    expect(isSafeCommandAllowed('pnpm exec vitest src/foo.test.ts')).toBe(true);
    expect(isSafeCommandAllowed('git diff --stat')).toBe(true);
  });

  it('rejects commands that are too broad or potentially mutating', () => {
    expect(isSafeCommandAllowed('npm install')).toBe(false);
    expect(isSafeCommandAllowed('python scripts/migrate.py')).toBe(false);
    expect(isSafeCommandAllowed('pnpm add zod')).toBe(false);
    expect(isSafeCommandAllowed('curl https://example.com')).toBe(false);
  });
});

describe('buildIssueSignature()', () => {
  it('normalizes issue order so repeated review feedback can be compared reliably', () => {
    const a = buildIssueSignature(['B issue', 'A issue'], 'summary');
    const b = buildIssueSignature(['A issue', 'B issue'], 'another summary');
    expect(a).toBe(b);
  });
});

describe('resolveUnexpectedAutomationFailure()', () => {
  it('classifies missing API key failures with task-specific guidance', () => {
    expect(
      resolveUnexpectedAutomationFailure(
        'Do not attempt startup generation when required API keys are absent',
        'Do not attempt startup generation when required API keys are absent',
      ),
    ).toEqual({
      summary:
        'Automation blocked because the task depends on missing API keys or external credentials.',
      guidance:
        'Add the required API keys or credentials in the target project, or revise the work so that startup generation and other credential-gated steps are not required before retrying.',
      userMessage:
        'Kira blocked: "Do not attempt startup generation when required API keys are absent" 작업은 필요한 API 키 또는 외부 인증 정보가 없어 자동으로 멈췄어요.',
    });
  });

  it('blocks generic unexpected failures to avoid repeated retry loops', () => {
    expect(
      resolveUnexpectedAutomationFailure('Fix search layout', 'ReferenceError: missing helper'),
    ).toEqual({
      summary:
        'Automation failed unexpectedly, and Kira blocked the task to avoid repeating the same failure.',
      guidance:
        'Inspect the underlying error, fix the project or task brief, and then manually move the work out of Blocked before retrying.',
      userMessage:
        'Kira blocked: "Fix search layout" 작업이 예기치 않은 오류로 중단되어 같은 실패를 반복하지 않도록 멈췄어요.',
    });
  });
});
