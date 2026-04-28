import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildDefaultValidationCommands,
  buildCodexCliArgs,
  buildIssueSignature,
  buildProjectContextScan,
  buildReviewPrompt,
  buildReviewSystemPrompt,
  buildAttemptComparisonReviewSystemPrompt,
  canUseFullFileRewrite,
  collectAttemptReviewabilityIssues,
  buildWorkerPlanningPrompt,
  buildWorkerPlanningSystemPrompt,
  buildWorkerPrompt,
  buildWorkerSystemPrompt,
  detectTouchedFilesFromGitStatus,
  filterStageableChangedFiles,
  findMissingValidationCommands,
  findSuggestedCommitBackfillSummary,
  findOutOfPlanTouchedFiles,
  formatWorkerSubmission,
  getOpenAiAssistantReasoningContent,
  hasMergeConflictMarkers,
  isGeneratedArtifactPath,
  isSafeCommandAllowed,
  parseGitStatusPorcelain,
  parseProjectDiscoveryAnalysis,
  parseAttemptSelectionSummary,
  parseStoredWorkerAttemptComment,
  parseWorkerExecutionPlan,
  resolveAttemptChangedFiles,
  resolveUnexpectedAutomationFailure,
  resolveValidationPlan,
  resolveProjectSettings,
  resolveRoleLlmConfig,
  resolveKiraProjectRoot,
  resolveWorkerLlmConfigs,
  shouldUseKiraAttemptWorktrees,
  shouldUseKiraIsolatedWorktree,
} from '../kiraAutomationPlugin';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(join(os.tmpdir(), prefix));
}

function makeWork() {
  return {
    id: 'work-1',
    type: 'work' as const,
    projectName: 'Demo',
    title: 'Improve Kira prompts',
    description: 'Make worker and reviewer behavior safer.',
    status: 'todo' as const,
    assignee: '',
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeContextScan() {
  return {
    projectRoot: '/repo',
    packageManager: 'pnpm',
    workspaceFiles: ['package.json'],
    packageScripts: ['test: vitest run'],
    existingChanges: [' M src/user-work.ts'],
    searchTerms: ['Kira'],
    likelyFiles: ['src/kira.ts: filename match'],
    relatedDocs: ['README.md'],
    testFiles: ['src/kira.test.ts'],
    candidateChecks: ['pnpm test'],
    notes: ['Existing git changes may include user work.'],
  };
}

function makePlan() {
  return {
    valid: true,
    parseIssues: [],
    understanding: 'Improve prompt behavior safely.',
    repoFindings: ['src/kira.ts contains Kira prompt builders.'],
    summary: 'Update Kira prompt builders.',
    intendedFiles: ['src/kira.ts'],
    protectedFiles: ['src/user-work.ts'],
    validationCommands: ['pnpm test'],
    riskNotes: ['Prompt drift could weaken guardrails.'],
    stopConditions: ['Protected files must change.'],
  };
}

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

describe('formatWorkerSubmission()', () => {
  it('preserves the raw worker final response for comments', () => {
    const raw = '  {"summary":"done","filesChanged":["src/app.ts"],"testsRun":["pnpm test"]}  ';

    expect(formatWorkerSubmission(raw)).toBe(
      '{"summary":"done","filesChanged":["src/app.ts"],"testsRun":["pnpm test"]}',
    );
  });

  it('truncates very long worker responses with a clear marker', () => {
    const formatted = formatWorkerSubmission('abcdef', 5);

    expect(formatted).toContain('...worker submission truncated for comment');
  });
});

describe('collectAttemptReviewabilityIssues()', () => {
  it('blocks empty worker submissions before final review', () => {
    expect(
      collectAttemptReviewabilityIssues({
        rawWorkerOutput: '',
        workerSummary: { summary: 'No worker summary provided.', filesChanged: [] },
        workerPlan: { intendedFiles: ['templates/index.html'] },
        diffExcerpts: [],
        gitDiffAvailable: true,
      }),
    ).toEqual([
      'Worker returned an empty final submission, so Kira cannot verify the attempt summary or validation evidence.',
      'Worker planned edits to templates/index.html but produced no changed files.',
    ]);
  });

  it('blocks git attempts that report changed files without reviewable diff evidence', () => {
    expect(
      collectAttemptReviewabilityIssues({
        rawWorkerOutput: JSON.stringify({
          summary: 'Changed the template.',
          filesChanged: ['templates/index.html'],
        }),
        workerSummary: { summary: 'Changed the template.', filesChanged: ['templates/index.html'] },
        workerPlan: { intendedFiles: ['templates/index.html'] },
        diffExcerpts: [],
        gitDiffAvailable: true,
      }),
    ).toEqual([
      'Kira detected changed files (templates/index.html) but could not collect a git diff; the attempt cannot be reviewed safely.',
    ]);
  });

  it('allows non-git attempts without diff excerpts when a worker summary exists', () => {
    expect(
      collectAttemptReviewabilityIssues({
        rawWorkerOutput: '{"summary":"Updated docs","filesChanged":["README.md"]}',
        workerSummary: { summary: 'Updated docs', filesChanged: ['README.md'] },
        workerPlan: { intendedFiles: ['README.md'] },
        diffExcerpts: [],
        gitDiffAvailable: false,
      }),
    ).toEqual([]);
  });
});

describe('Kira Codex-grade prompts', () => {
  it('locks worker system prompts to planning, safety, validation, and reporting rules', () => {
    const planner = buildWorkerPlanningSystemPrompt();
    const worker = buildWorkerSystemPrompt();

    expect(planner).toContain('inspect repository structure and relevant files');
    expect(planner).toContain('Never return the final plan before using list_files');
    expect(planner).toContain('protectedFiles');
    expect(planner).toContain('stopConditions');
    expect(planner).toContain('Do not invent inspected files');
    expect(worker).toContain('You are Kira Worker, a careful implementation agent.');
    expect(worker).toContain('Identify existing user changes and avoid overwriting them.');
    expect(worker).toContain('sibling git worktrees');
    expect(worker).toContain('Do not touch out-of-plan files unless necessary and explained.');
    expect(worker).toContain('complete final content');
    expect(worker).toContain(
      'Never claim a check passed unless you ran it or Kira provided the result.',
    );
  });

  it('locks worker planning and execution prompts to structured JSON contracts', () => {
    const planningPrompt = buildWorkerPlanningPrompt(
      makeWork(),
      'package.json\nsrc/kira.ts',
      makeContextScan(),
      ['Address review feedback.'],
    );
    const workerPrompt = buildWorkerPrompt(
      makeWork(),
      'package.json\nsrc/kira.ts',
      makeContextScan(),
      makePlan(),
      [],
    );

    expect(planningPrompt).toContain('"understanding":"string"');
    expect(planningPrompt).toContain('"repoFindings":["..."]');
    expect(planningPrompt).toContain('"protectedFiles":["..."]');
    expect(planningPrompt).toContain('"stopConditions":["..."]');
    expect(planningPrompt).toContain('Call at least one read-only tool');
    expect(workerPrompt).toContain('Never edit protectedFiles.');
    expect(workerPrompt).toContain('Run the planned validation commands when practical');
    expect(workerPrompt).toContain('complete final file content');
    expect(workerPrompt).toContain('"remainingRisks":["..."]');
  });

  it('locks reviewer prompts to independent review priorities and structured feedback', () => {
    const reviewerSystem = buildReviewSystemPrompt();
    const reviewPrompt = buildReviewPrompt(
      makeWork(),
      'package.json\nsrc/kira.ts',
      makeContextScan(),
      makePlan(),
      {
        summary: 'Updated prompt builders.',
        filesChanged: ['src/kira.ts'],
        testsRun: ['pnpm test'],
        remainingRisks: [],
      },
      [],
      [],
      {
        plannerCommands: ['pnpm test'],
        autoAddedCommands: [],
        effectiveCommands: ['pnpm test'],
        notes: [],
      },
      {
        passed: ['pnpm test'],
        failed: [],
        failureDetails: [],
      },
      ['diff -- src/kira.ts'],
    );

    expect(reviewerSystem).toContain('You are Kira Reviewer, an independent code reviewer.');
    expect(reviewerSystem).toContain('Prioritize correctness and requirement coverage.');
    expect(reviewerSystem).toContain('concurrent-agent integration risks');
    expect(reviewerSystem).toContain('Do not approve if validation failed.');
    expect(reviewerSystem).toContain('Provide concrete nextWorkerInstructions');
    expect(buildAttemptComparisonReviewSystemPrompt()).toContain('attempt judge');
    expect(reviewPrompt).toContain('Only the Kira-passed validation reruns count');
    expect(reviewPrompt).toContain(
      'Do not approve if the worker summary conflicts with the diff excerpts.',
    );
    expect(reviewPrompt).toContain('"missingValidation":["..."]');
    expect(reviewPrompt).toContain('"nextWorkerInstructions":["..."]');
    expect(reviewPrompt).toContain('"residualRisk":["..."]');
  });
});

describe('parseAttemptSelectionSummary()', () => {
  it('approves only when the selected attempt is one of the valid attempts', () => {
    expect(
      parseAttemptSelectionSummary(
        JSON.stringify({
          approved: true,
          selectedAttemptNo: 2,
          summary: 'Attempt 2 is the safest complete fix.',
          issues: [],
          nextWorkerInstructions: [],
          residualRisk: ['Watch release notes.'],
          filesChecked: ['src/kira.ts'],
        }),
        [1, 2, 3],
      ),
    ).toEqual({
      approved: true,
      selectedAttemptNo: 2,
      summary: 'Attempt 2 is the safest complete fix.',
      issues: [],
      nextWorkerInstructions: [],
      residualRisk: ['Watch release notes.'],
      filesChecked: ['src/kira.ts'],
    });

    expect(
      parseAttemptSelectionSummary(
        JSON.stringify({
          approved: true,
          selectedAttemptNo: 9,
          summary: 'Invalid winner.',
        }),
        [1, 2, 3],
      ).approved,
    ).toBe(false);
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
      valid: false,
      parseIssues: [
        'Missing required field: understanding',
        'Missing required field: repoFindings',
        'Missing required field: stopConditions',
      ],
      understanding: 'No requirement understanding provided.',
      repoFindings: [],
      summary: 'Update the Kira automation guardrails.',
      intendedFiles: [
        'apps/webuiapps/src/lib/kiraAutomationPlugin.ts',
        'apps/webuiapps/src/lib/__tests__/kiraAutomationPlugin.test.ts',
      ],
      protectedFiles: [],
      validationCommands: [
        'pnpm exec vitest apps/webuiapps/src/lib/__tests__/kiraAutomationPlugin.test.ts',
      ],
      riskNotes: [
        'Watch for dirty worktree handling.',
        'Planner suggested an unsafe validation command that was removed: npm install',
      ],
      stopConditions: [],
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

    expect(plan.valid).toBe(false);
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

  it('adds lightweight validation for changed HTML theme files', () => {
    const projectRoot = fs.mkdtempSync(join(os.tmpdir(), 'kira-html-'));
    fs.mkdirSync(join(projectRoot, 'templates'), { recursive: true });
    fs.writeFileSync(join(projectRoot, '.git'), 'gitdir: ../repo/.git/worktrees/demo\n', 'utf-8');
    fs.writeFileSync(
      join(projectRoot, 'templates', 'index.html'),
      '<select data-theme><option>default</option></select><script>localStorage.theme = "dark";</script>',
      'utf-8',
    );

    try {
      expect(buildDefaultValidationCommands(projectRoot, ['templates/index.html'])).toEqual([
        'git diff --check -- templates/index.html',
        'rg -n "data-theme" templates/index.html',
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

  it('prioritizes changed Vitest files and records doc-only validation notes', () => {
    const projectRoot = fs.mkdtempSync(join(os.tmpdir(), 'kira-validation-'));
    fs.writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@9.0.0',
        scripts: {
          test: 'vitest run',
          build: 'vite build',
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(join(projectRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9', 'utf-8');

    try {
      expect(buildDefaultValidationCommands(projectRoot, ['src/foo.test.ts'])).toContain(
        'pnpm exec vitest src/foo.test.ts',
      );
      expect(resolveValidationPlan(projectRoot, [], ['docs/guide.md']).notes).toContain(
        'Only documentation files changed; no automatic code validation command was added.',
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('buildProjectContextScan()', () => {
  it('collects scripts, likely files, and candidate checks for worker preflight', async () => {
    const projectRoot = makeTempDir('kira-context-');
    fs.mkdirSync(join(projectRoot, 'src', 'pages', 'Kira'), { recursive: true });
    fs.writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@9.0.0',
        scripts: {
          test: 'vitest run',
          lint: 'eslint .',
          build: 'vite build',
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(join(projectRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9', 'utf-8');
    fs.writeFileSync(join(projectRoot, 'README.md'), '# Kira model guide\n', 'utf-8');
    fs.writeFileSync(
      join(projectRoot, 'src', 'pages', 'Kira', 'model.test.ts'),
      'import "./model";\n',
      'utf-8',
    );
    fs.writeFileSync(
      join(projectRoot, 'src', 'pages', 'Kira', 'model.ts'),
      'export const kiraModel = true;\n',
      'utf-8',
    );

    try {
      const scan = await buildProjectContextScan(projectRoot, {
        id: 'work-1',
        type: 'work',
        projectName: 'Demo',
        title: 'Improve Kira model handling',
        description: 'Update src/pages/Kira/model.ts so Kira handles model state safely.',
        status: 'todo',
        assignee: '',
        createdAt: 1,
        updatedAt: 1,
      });

      expect(scan.packageManager).toBe('pnpm');
      expect(scan.workspaceFiles).toContain('package.json');
      expect(scan.packageScripts).toContain('test: vitest run');
      expect(scan.searchTerms).toContain('src/pages/Kira/model.ts');
      expect(scan.candidateChecks).toContain('pnpm test');
      expect(scan.candidateChecks).toContain('pnpm run lint');
      expect(scan.likelyFiles.some((item) => item.includes('src/pages/Kira/model.ts'))).toBe(true);
      expect(scan.relatedDocs).toContain('README.md');
      expect(scan.testFiles).toContain('src/pages/Kira/model.test.ts');
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

  it('supports Codex CLI roles without API endpoint settings', () => {
    const resolved = resolveRoleLlmConfig(
      null,
      {
        provider: 'codex-cli',
        model: 'gpt-5.3-codex',
      },
      null,
    );

    expect(resolved).toEqual({
      provider: 'codex-cli',
      apiKey: '',
      baseUrl: '',
      model: 'gpt-5.3-codex',
    });
  });

  it('defaults OpenCode API roles to the Zen endpoint', () => {
    const resolved = resolveRoleLlmConfig(
      null,
      {
        provider: 'opencode',
        apiKey: 'oc-test',
        model: 'opencode/kimi-k2.5',
      },
      null,
    );

    expect(resolved).toEqual({
      provider: 'opencode',
      apiKey: 'oc-test',
      baseUrl: 'https://opencode.ai/zen',
      model: 'opencode/kimi-k2.5',
    });
  });
});

describe('resolveWorkerLlmConfigs()', () => {
  it('caps configured workers at three and preserves per-worker models', () => {
    const workers = resolveWorkerLlmConfigs(
      {
        provider: 'openrouter',
        apiKey: 'sk-test',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openai/gpt-5.4',
      },
      {
        workers: [
          { model: 'openai/gpt-5.4-mini' },
          { provider: 'codex-cli', model: 'gpt-5.3-codex' },
          { provider: 'opencode-go', apiKey: 'oc-test', model: 'opencode-go/kimi-k2.5' },
          { model: 'ignored-fourth-worker' },
        ],
      },
    );

    expect(workers).toHaveLength(3);
    expect(workers.map((worker) => worker.model)).toEqual([
      'openai/gpt-5.4-mini',
      'gpt-5.3-codex',
      'opencode-go/kimi-k2.5',
    ]);
    expect(workers[1].provider).toBe('codex-cli');
    expect(workers[2].baseUrl).toBe('https://opencode.ai/zen/go');
  });
});

describe('buildCodexCliArgs()', () => {
  it('uses only arguments supported by the installed Codex CLI', () => {
    const args = buildCodexCliArgs(
      {
        provider: 'codex-cli',
        apiKey: '',
        baseUrl: '',
        model: 'gpt-5.5',
      },
      'F:/workspace/project',
      true,
      'F:/tmp/last-message.txt',
    );

    expect(args).not.toContain('--ask-for-approval');
    expect(args).toEqual(
      expect.arrayContaining([
        'exec',
        '--cd',
        'F:/workspace/project',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        '--output-last-message',
        'F:/tmp/last-message.txt',
        '--model',
        'gpt-5.5',
        '-',
      ]),
    );
  });
});

describe('getOpenAiAssistantReasoningContent()', () => {
  it('fills missing reasoning_content for Kimi tool-call turns', () => {
    expect(
      getOpenAiAssistantReasoningContent(
        { provider: 'opencode-go', model: 'opencode-go/kimi-k2.6' },
        {
          toolCalls: [
            {
              id: 'call_1',
              name: 'read_file',
              args: { path: 'templates/index.html' },
            },
          ],
        },
      ),
    ).toContain('reasoning_content');
  });

  it('keeps existing reasoning_content when the provider returned it', () => {
    expect(
      getOpenAiAssistantReasoningContent(
        { provider: 'opencode-go', model: 'opencode-go/kimi-k2.6' },
        {
          reasoningContent: 'Actual model reasoning.',
          toolCalls: [
            {
              id: 'call_1',
              name: 'read_file',
              args: { path: 'templates/index.html' },
            },
          ],
        },
      ),
    ).toBe('Actual model reasoning.');
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

describe('resolveKiraProjectRoot()', () => {
  it('treats the configured work root itself as the project when it has project markers', () => {
    const projectRoot = fs.mkdtempSync(join(os.tmpdir(), 'briefwave-cast-'));
    try {
      fs.writeFileSync(join(projectRoot, '.git'), 'gitdir: ../repo/.git/worktrees/demo\n', 'utf-8');

      expect(resolveKiraProjectRoot(projectRoot, projectRoot.split(/[\\/]/).pop())).toBe(
        projectRoot,
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('falls back to a child project path when the work root is a project container', () => {
    const workRoot = fs.mkdtempSync(join(os.tmpdir(), 'kira-work-root-'));
    try {
      expect(resolveKiraProjectRoot(workRoot, 'templates')).toBe(join(workRoot, 'templates'));
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });
});

describe('shouldUseKiraIsolatedWorktree()', () => {
  it('enables worktree isolation only for auto-commit git projects', () => {
    const projectRoot = fs.mkdtempSync(join(os.tmpdir(), 'kira-worktree-'));
    try {
      fs.writeFileSync(join(projectRoot, '.git'), 'gitdir: ../repo/.git/worktrees/demo\n', 'utf-8');

      expect(shouldUseKiraIsolatedWorktree(projectRoot, { autoCommit: true })).toBe(true);
      expect(shouldUseKiraIsolatedWorktree(projectRoot, { autoCommit: false })).toBe(false);
      expect(
        shouldUseKiraIsolatedWorktree(join(projectRoot, 'missing'), { autoCommit: true }),
      ).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('requires attempt worktrees for multi-worker git projects even without auto-commit', () => {
    const projectRoot = fs.mkdtempSync(join(os.tmpdir(), 'kira-attempt-worktree-'));
    try {
      fs.writeFileSync(join(projectRoot, '.git'), 'gitdir: ../repo/.git/worktrees/demo\n', 'utf-8');

      expect(shouldUseKiraAttemptWorktrees(projectRoot, { autoCommit: false }, 1)).toBe(false);
      expect(shouldUseKiraAttemptWorktrees(projectRoot, { autoCommit: false }, 3)).toBe(true);
      expect(shouldUseKiraAttemptWorktrees(projectRoot, { autoCommit: true }, 1)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
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

  it('uses the renamed target path from porcelain rename entries', () => {
    expect(parseGitStatusPorcelain('R  old-name.ts -> src/new-name.ts')).toEqual([
      { status: 'R ', path: 'src/new-name.ts' },
    ]);
  });

  it('preserves the first path character when status output uses compact one-column status', () => {
    expect(parseGitStatusPorcelain('M templates/index.html')).toEqual([
      { status: 'M ', path: 'templates/index.html' },
    ]);
  });

  it('keeps patched files in the resolved attempt changes even when git status is unchanged', () => {
    expect(resolveAttemptChangedFiles([], ['model-reported.ts'], ['src/dirty.ts'])).toEqual([
      'src/dirty.ts',
    ]);
    expect(resolveAttemptChangedFiles([], ['model-reported.ts'], [])).toEqual([
      'model-reported.ts',
    ]);
  });

  it('filters generated artifacts from detected attempt changes', () => {
    expect(isGeneratedArtifactPath('__pycache__/main.cpython-311.pyc')).toBe(true);
    expect(
      detectTouchedFilesFromGitStatus(
        [],
        [
          { status: '??', path: '__pycache__/main.cpython-311.pyc' },
          { status: ' M', path: 'templates/index.html' },
        ],
      ),
    ).toEqual(['templates/index.html']);
    expect(
      resolveAttemptChangedFiles(
        ['__pycache__/main.cpython-311.pyc'],
        ['__pycache__/main.cpython-311.pyc'],
        [],
      ),
    ).toEqual([]);
  });

  it('filters non-stageable reported paths before integration', () => {
    expect(
      filterStageableChangedFiles(
        ['emplates/index.html', 'templates/index.html'],
        [{ status: ' M', path: 'templates/index.html' }],
      ),
    ).toEqual({
      targetFiles: ['templates/index.html'],
      ignoredFiles: ['emplates/index.html'],
    });

    expect(
      filterStageableChangedFiles(
        ['templates/old.html'],
        [{ status: ' D', path: 'templates/old.html' }],
      ).targetFiles,
    ).toEqual(['templates/old.html']);
  });
});

describe('worker guardrail helpers', () => {
  it('allows full-file rewrites only for read, planned, unprotected files within size limits', () => {
    expect(
      canUseFullFileRewrite({
        existingFileSize: 20_000,
        relativePath: 'templates/index.html',
        intendedFiles: ['templates/index.html'],
        protectedFiles: [],
        readFiles: ['templates/index.html'],
      }),
    ).toBe(true);

    expect(
      canUseFullFileRewrite({
        existingFileSize: 20_000,
        relativePath: 'templates/index.html',
        intendedFiles: ['templates/index.html'],
        protectedFiles: [],
        readFiles: [],
      }),
    ).toBe(false);

    expect(
      canUseFullFileRewrite({
        existingFileSize: 20_000,
        relativePath: 'templates/index.html',
        intendedFiles: ['templates/index.html'],
        protectedFiles: ['templates/index.html'],
        readFiles: ['templates/index.html'],
      }),
    ).toBe(false);

    expect(
      canUseFullFileRewrite({
        existingFileSize: 100_000,
        relativePath: 'templates/index.html',
        intendedFiles: ['templates/index.html'],
        protectedFiles: [],
        readFiles: ['templates/index.html'],
      }),
    ).toBe(false);
  });

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
    expect(isSafeCommandAllowed('rg -n "data-theme" templates/index.html')).toBe(true);
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
