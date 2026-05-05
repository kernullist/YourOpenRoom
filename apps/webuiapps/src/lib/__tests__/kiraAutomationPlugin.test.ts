import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildDefaultValidationCommands,
  buildDesignReviewGate,
  buildCodexCliArgs,
  buildIssueSignature,
  buildProjectContextScan,
  buildReviewPrompt,
  buildReviewSystemPrompt,
  buildAttemptComparisonReviewSystemPrompt,
  canUseFullFileRewrite,
  captureDirtyFileSnapshots,
  collectAttemptReviewabilityIssues,
  collectDesignReviewGateIssues,
  collectGitDiffStats,
  collectReviewerDiffExcerpts,
  collectWorkerSelfCheckIssues,
  enforceReviewDecision,
  buildWorkerPlanningPrompt,
  buildWorkerPlanningSystemPrompt,
  buildWorkerPrompt,
  buildWorkerSystemPrompt,
  detectTouchedFilesFromDirtySnapshots,
  detectTouchedFilesFromGitStatus,
  evaluateExecutionPolicy,
  filterStageableChangedFiles,
  findMissingValidationCommands,
  findSuggestedCommitBackfillSummary,
  findOutOfPlanTouchedFiles,
  formatWorkerSubmission,
  getKiraModelRouteKey,
  getKiraModelRouteLimit,
  getOpenAiAssistantReasoningContent,
  getProjectProfilePath,
  hasMergeConflictMarkers,
  isGeneratedArtifactPath,
  isRecoverableAutomationLockMessage,
  isRecoverableLockError,
  isSafeCommandAllowed,
  parseGitStatusPorcelain,
  parseProjectDiscoveryAnalysis,
  parseAttemptSelectionSummary,
  parseStoredWorkerAttemptComment,
  parseWorkClarificationAnalysis,
  parseWorkerExecutionPlan,
  resolveAttemptChangedFiles,
  resolveUnexpectedAutomationFailure,
  resolveValidationPlan,
  resolveProjectSettings,
  resolveRoleLlmConfig,
  resolveKiraProjectRoot,
  resolveWorkerLlmConfigs,
  recommendWorkDecomposition,
  refreshProjectIntelligenceProfile,
  runWithKiraModelRouteLimit,
  shouldUseKiraAttemptWorktrees,
  shouldUseKiraIsolatedWorktree,
  tryAcquireLock,
  validateKiraOrchestrationContract,
  verifyPatchIntent,
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
    changeDesign: {
      targetFiles: ['src/kira.ts'],
      invariants: ['Do not weaken Kira safety guardrails.'],
      expectedImpact: ['Prompt behavior becomes safer for workers and reviewers.'],
      validationStrategy: ['Run pnpm test.'],
      rollbackStrategy: ['Revert src/kira.ts if prompts regress.'],
    },
    validationCommands: ['pnpm test'],
    riskNotes: ['Prompt drift could weaken guardrails.'],
    stopConditions: ['Protected files must change.'],
    confidence: 0.8,
    uncertainties: [],
    decomposition: {
      shouldSplit: false,
      confidence: 0.2,
      reason: 'No split needed.',
      suggestedWorks: [],
      signals: [],
    },
    workerProfile: 'generalist',
    taskType: 'tooling-config' as const,
    requirementTrace: [
      {
        id: 'R1',
        source: 'brief' as const,
        text: 'Make worker and reviewer behavior safer.',
        status: 'planned' as const,
        evidence: ['Update prompt builders and tests.'],
      },
    ],
    approachAlternatives: [
      {
        name: 'Tighten prompt contracts',
        selected: true,
        rationale: 'Keeps the behavior change scoped to Kira automation prompts.',
        tradeoffs: ['Prompt wording must remain precise.'],
      },
      {
        name: 'Rewrite automation flow',
        selected: false,
        rationale: 'Too broad for this targeted safety task.',
        tradeoffs: ['Higher regression risk.'],
      },
    ],
    escalation: {
      shouldAsk: false,
      questions: [],
      blockers: [],
    },
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
    expect(planner).toContain('Do not rewrite the requested work into a smaller goal');
    expect(worker).toContain('You are Kira Worker, a careful implementation agent.');
    expect(worker).toContain('Kira prompt contract version: 2.');
    expect(worker).toContain('Identify existing user changes and avoid overwriting them.');
    expect(worker).toContain('sibling git worktrees');
    expect(worker).toContain('Do not touch out-of-plan files unless necessary and explained.');
    expect(worker).toContain('complete final content');
    expect(worker).toContain('Do not narrow the acceptance target');
    expect(worker).toContain(
      'Brief and mandatory project-instruction requirements cannot be marked not_applicable',
    );
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
      'Use strict TypeScript and keep exported APIs backward compatible.',
    );
    const workerPrompt = buildWorkerPrompt(
      makeWork(),
      'package.json\nsrc/kira.ts',
      makeContextScan(),
      makePlan(),
      [],
      'Use strict TypeScript and keep exported APIs backward compatible.',
    );

    expect(planningPrompt).toContain('Mandatory project instructions:');
    expect(planningPrompt).toContain('Use strict TypeScript');
    expect(planningPrompt).toContain('"understanding":"string"');
    expect(planningPrompt).toContain('"repoFindings":["..."]');
    expect(planningPrompt).toContain('"protectedFiles":["..."]');
    expect(planningPrompt).toContain('"changeDesign"');
    expect(planningPrompt).toContain('"requirementTrace"');
    expect(planningPrompt).toContain('"approachAlternatives"');
    expect(planningPrompt).toContain('"escalation"');
    expect(planningPrompt).toContain('"stopConditions":["..."]');
    expect(planningPrompt).toContain('Call at least one read-only tool');
    expect(planningPrompt).toContain('Do not narrow the acceptance target');
    expect(planningPrompt).toContain('keep suggestedWorks collectively covering the original goal');
    expect(workerPrompt).toContain('Mandatory project instructions:');
    expect(workerPrompt).toContain('binding acceptance criteria');
    expect(workerPrompt).toContain('Complete the full acceptance target');
    expect(workerPrompt).toContain('Change design:');
    expect(workerPrompt).toContain('Requirement trace:');
    expect(workerPrompt).toContain('Patch alternatives:');
    expect(workerPrompt).toContain('Never edit protectedFiles.');
    expect(workerPrompt).toContain('Run the planned validation commands when practical');
    expect(workerPrompt).toContain('complete final file content');
    expect(workerPrompt).toContain(
      'Never mark brief or mandatory project-instruction requirements not_applicable',
    );
    expect(workerPrompt).toContain('If the approved plan appears narrower than the work brief');
    expect(workerPrompt).toContain('"diffHunkReview"');
    expect(workerPrompt).toContain('"requirementTrace"');
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
      'Use strict TypeScript and keep exported APIs backward compatible.',
    );

    expect(reviewerSystem).toContain('You are Kira Reviewer, an independent code reviewer.');
    expect(reviewerSystem).toContain('Kira prompt contract version: 2.');
    expect(reviewerSystem).toContain('enforce them as binding acceptance criteria');
    expect(reviewerSystem).toContain(
      'If following them would conflict with Kira safety rules or the explicit work brief, report the conflict clearly instead of approving.',
    );
    expect(reviewerSystem).not.toContain('unless following them would conflict');
    expect(reviewerSystem).toContain('Prioritize correctness and requirement coverage.');
    expect(reviewerSystem).toContain('concurrent-agent integration risks');
    expect(reviewerSystem).toContain('Do not approve if validation failed.');
    expect(reviewerSystem).toContain(
      'Do not approve a small patch that solves only a narrower version',
    );
    expect(reviewerSystem).toContain(
      'Do not approve non-documentation code changes when Kira has no effective validation command',
    );
    expect(reviewerSystem).toContain('Provide concrete nextWorkerInstructions');
    expect(buildAttemptComparisonReviewSystemPrompt()).toContain('attempt judge');
    expect(buildAttemptComparisonReviewSystemPrompt()).toContain(
      'Kira prompt contract version: 2.',
    );
    expect(buildAttemptComparisonReviewSystemPrompt()).toContain('Do not select a smaller attempt');
    expect(reviewPrompt).toContain('Only the Kira-passed validation reruns count');
    expect(reviewPrompt).toContain('Mandatory project instructions:');
    expect(reviewPrompt).toContain('Do not approve partial goal fulfillment');
    expect(reviewPrompt).toContain('Review the changeDesign against the actual diff');
    expect(reviewPrompt).toContain('Do not approve patch intent drift');
    expect(reviewPrompt).toContain('Review the requirementTrace.');
    expect(reviewPrompt).toContain('blocking scope-reduction attempt');
    expect(reviewPrompt).toContain('Risk review policy:');
    expect(reviewPrompt).toContain('Do not approve if the implementation violates');
    expect(reviewPrompt).toContain(
      'Do not approve if the worker summary conflicts with the diff excerpts.',
    );
    expect(reviewPrompt).toContain('no effective validation command');
    expect(reviewPrompt).toContain('"missingValidation":["..."]');
    expect(reviewPrompt).toContain('"nextWorkerInstructions":["..."]');
    expect(reviewPrompt).toContain('"residualRisk":["..."]');
    expect(reviewPrompt).toContain('"evidenceChecked"');
    expect(reviewPrompt).toContain('"adversarialChecks"');
    expect(reviewPrompt).toContain('"reviewerDiscourse"');
    expect(reviewPrompt).toContain('"requirementVerdicts"');
  });
});

describe('buildDesignReviewGate()', () => {
  it('blocks implementation plans that ignore mandatory project instructions', () => {
    const gate = buildDesignReviewGate({
      work: makeWork(),
      contextScan: {
        ...makeContextScan(),
        requirementTrace: [
          {
            id: 'R1',
            source: 'brief',
            text: 'Make worker and reviewer behavior safer.',
            status: 'planned',
            evidence: [],
          },
          {
            id: 'R2',
            source: 'project-instruction',
            text: 'Use strict TypeScript.',
            status: 'planned',
            evidence: [],
          },
        ],
        candidateChecks: ['pnpm test'],
      },
      workerPlan: makePlan(),
      requiredInstructions: 'Use strict TypeScript.',
    });

    expect(gate.status).toBe('blocked');
    expect(collectDesignReviewGateIssues(gate).join('\n')).toContain(
      'mandatory project instructions',
    );
  });

  it('passes focused plans with requirements, scope, validation, and rollback covered', () => {
    const plan = {
      ...makePlan(),
      requirementTrace: [
        ...makePlan().requirementTrace,
        {
          id: 'R2',
          source: 'project-instruction' as const,
          text: 'Use strict TypeScript.',
          status: 'planned' as const,
          evidence: ['Keep existing TypeScript prompt builder style.'],
        },
      ],
    };
    const gate = buildDesignReviewGate({
      work: makeWork(),
      contextScan: {
        ...makeContextScan(),
        requirementTrace: plan.requirementTrace,
        candidateChecks: ['pnpm test'],
      },
      workerPlan: plan,
      requiredInstructions: 'Use strict TypeScript.',
    });

    expect(gate.status).toBe('passed');
    expect(collectDesignReviewGateIssues(gate)).toEqual([]);
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
      evidenceChecked: [],
      adversarialChecks: [],
      requirementVerdicts: [],
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

  it('does not treat the string "false" as approval', () => {
    expect(
      parseAttemptSelectionSummary(
        JSON.stringify({
          approved: 'false',
          selectedAttemptNo: 1,
          summary: 'The attempt still needs changes.',
        }),
        [1],
      ).approved,
    ).toBe(false);
  });
});

describe('parseWorkClarificationAnalysis()', () => {
  it('normalizes bounded multiple-choice questions', () => {
    const analysis = parseWorkClarificationAnalysis(
      JSON.stringify({
        needsClarification: true,
        confidence: 0.92,
        summary: 'Target behavior is ambiguous.',
        questions: [
          {
            question: 'Which UX should the worker implement?',
            options: ['Compact', 'Guided', 'Guided'],
            allowCustomAnswer: false,
          },
        ],
      }),
    );

    expect(analysis).toEqual({
      needsClarification: true,
      confidence: 0.92,
      summary: 'Target behavior is ambiguous.',
      questions: [
        {
          id: 'q-1',
          question: 'Which UX should the worker implement?',
          options: ['Compact', 'Guided'],
          allowCustomAnswer: false,
        },
      ],
    });
  });

  it('blocks assignment with a fallback question when clarification output is malformed', () => {
    const analysis = parseWorkClarificationAnalysis('not json');

    expect(analysis.needsClarification).toBe(true);
    expect(analysis.confidence).toBe(0);
    expect(analysis.questions).toEqual([
      {
        id: 'q-1',
        question:
          'Kira could not read the main model clarification result. What should be clarified or changed in the brief before a worker starts?',
        options: [],
        allowCustomAnswer: true,
      },
    ]);
  });

  it('keeps clarification blocking when the model omits usable questions', () => {
    const analysis = parseWorkClarificationAnalysis(
      JSON.stringify({
        needsClarification: true,
        confidence: 0.7,
        summary: 'The target flow is unclear.',
        questions: [],
      }),
    );

    expect(analysis).toMatchObject({
      needsClarification: true,
      confidence: 0.7,
      summary: 'The target flow is unclear.',
      questions: [
        {
          id: 'q-1',
          options: [],
          allowCustomAnswer: true,
        },
      ],
    });
  });

  it('deduplicates model-provided question ids', () => {
    const analysis = parseWorkClarificationAnalysis(
      JSON.stringify({
        needsClarification: true,
        confidence: 0.9,
        summary: 'Two decisions are missing.',
        questions: [
          { id: 'choice', question: 'First decision?', options: [] },
          { id: 'choice', question: 'Second decision?', options: [] },
        ],
      }),
    );

    expect(analysis.questions.map((question) => question.id)).toEqual(['choice', 'q-2']);
  });
});

describe('parseWorkerExecutionPlan()', () => {
  it('does not treat the string "false" as a split recommendation', () => {
    const plan = parseWorkerExecutionPlan(
      JSON.stringify({
        ...makePlan(),
        decomposition: {
          shouldSplit: 'false',
          confidence: 0.9,
          reason: 'The work can stay in one small patch.',
          suggestedWorks: ['Part A', 'Part B'],
          signals: ['two suggested labels only'],
        },
      }),
    );

    expect(plan.decomposition.shouldSplit).toBe(false);
  });

  it('requires exactly one selected patch alternative', () => {
    const plan = parseWorkerExecutionPlan(
      JSON.stringify({
        ...makePlan(),
        approachAlternatives: makePlan().approachAlternatives.map((item) => ({
          ...item,
          selected: true,
        })),
      }),
    );

    expect(plan.valid).toBe(false);
    expect(plan.parseIssues).toContain(
      'Missing required field: approachAlternatives with one selected option',
    );
  });

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
        'Missing required field: changeDesign.targetFiles',
        'Missing required field: changeDesign.invariants',
        'Missing required field: changeDesign.expectedImpact',
        'Missing required field: changeDesign.validationStrategy',
        'Missing required field: changeDesign.rollbackStrategy',
        'Missing required field: requirementTrace',
        'Missing required field: approachAlternatives with one selected option',
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
      confidence: 0.3,
      uncertainties: [],
      decomposition: {
        shouldSplit: false,
        confidence: 0.3,
        reason: 'No split recommended.',
        suggestedWorks: [],
        signals: [],
      },
      workerProfile: 'generalist',
      changeDesign: {
        targetFiles: [],
        invariants: [],
        expectedImpact: [],
        validationStrategy: [],
        rollbackStrategy: [],
      },
      taskType: 'generalist',
      requirementTrace: [],
      approachAlternatives: [],
      escalation: {
        shouldAsk: false,
        questions: [],
        blockers: [],
      },
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

  it('selects nearby tests for changed source files before broad checks', () => {
    const projectRoot = fs.mkdtempSync(join(os.tmpdir(), 'kira-targeted-tests-'));
    fs.mkdirSync(join(projectRoot, 'src', 'lib', '__tests__'), { recursive: true });
    fs.writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@9.0.0',
        scripts: {
          test: 'vitest run',
          typecheck: 'tsc --noEmit',
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(join(projectRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9', 'utf-8');
    fs.writeFileSync(join(projectRoot, 'src', 'lib', 'foo.ts'), 'export const foo = 1;\n');
    fs.writeFileSync(join(projectRoot, 'src', 'lib', '__tests__', 'foo.test.ts'), 'test("foo")');

    try {
      expect(buildDefaultValidationCommands(projectRoot, ['src/lib/foo.ts'])).toEqual([
        'pnpm exec vitest src/lib/__tests__/foo.test.ts',
        'pnpm run typecheck',
      ]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps targeted tests and typecheck when git diff validation is added', () => {
    const projectRoot = fs.mkdtempSync(join(os.tmpdir(), 'kira-targeted-git-tests-'));
    fs.mkdirSync(join(projectRoot, 'src', 'lib', '__tests__'), { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
    fs.writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@9.0.0',
        scripts: {
          test: 'vitest run',
          typecheck: 'tsc --noEmit',
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(join(projectRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9', 'utf-8');
    fs.writeFileSync(join(projectRoot, 'src', 'lib', 'foo.ts'), 'export const foo = 1;\n');
    fs.writeFileSync(join(projectRoot, 'src', 'lib', '__tests__', 'foo.test.ts'), 'test("foo")');

    try {
      expect(buildDefaultValidationCommands(projectRoot, ['src/lib/foo.ts'])).toEqual([
        'git diff --check -- src/lib/foo.ts',
        'pnpm exec vitest src/lib/__tests__/foo.test.ts',
        'pnpm run typecheck',
      ]);
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
      const scan = await buildProjectContextScan(
        projectRoot,
        {
          id: 'work-1',
          type: 'work',
          projectName: 'Demo',
          title: 'Improve Kira model handling',
          description: 'Update frontend UI model handling in src/pages/Kira/model.ts safely.',
          status: 'todo',
          assignee: '',
          createdAt: 1,
          updatedAt: 1,
        },
        'Follow existing TypeScript style.',
      );

      expect(scan.packageManager).toBe('pnpm');
      expect(scan.workspaceFiles).toContain('package.json');
      expect(scan.packageScripts).toContain('test: vitest run');
      expect(scan.searchTerms).toContain('src/pages/Kira/model.ts');
      expect(scan.candidateChecks).toContain('pnpm test');
      expect(scan.candidateChecks).toContain('pnpm run lint');
      expect(scan.likelyFiles.some((item) => item.includes('src/pages/Kira/model.ts'))).toBe(true);
      expect(scan.relatedDocs).toContain('README.md');
      expect(scan.testFiles).toContain('src/pages/Kira/model.test.ts');
      expect(fs.existsSync(getProjectProfilePath(projectRoot))).toBe(true);
      expect(scan.projectProfile?.projectName).toBe('Demo');
      expect(scan.profileSummary?.join('\n')).toContain('Source roots');
      expect(scan.workerProfile).toBeTruthy();
      expect(scan.taskPlaybook?.taskType).toBeTruthy();
      expect(scan.dependencyMap?.some((item) => item.file === 'src/pages/Kira/model.ts')).toBe(
        true,
      );
      expect(scan.semanticGraph?.some((item) => item.file === 'src/pages/Kira/model.ts')).toBe(
        true,
      );
      expect(scan.testImpact?.[0]?.impactedTests).toContain('src/pages/Kira/model.test.ts');
      expect(scan.reviewAdversarialPlan?.modes).toContain('correctness');
      expect(scan.clarificationGate?.decision).toBeTruthy();
      expect(scan.reviewerCalibration?.strictness).toBeTruthy();
      expect(scan.requirementTrace?.[0]?.id).toBe('R1');
      expect(scan.requirementTrace?.some((item) => item.source === 'project-instruction')).toBe(
        true,
      );
      expect(scan.riskPolicy?.evidenceMinimum).toBeGreaterThanOrEqual(1);
      expect(typeof scan.runtimeValidation?.applicable).toBe('boolean');
      expect(scan.executionPolicy?.mode).toBe('balanced');
      expect(scan.environmentContract?.runner).toBe('local');
      expect(scan.subagentRegistry?.some((agent) => agent.id === 'implementer')).toBe(true);
      expect(scan.workflowDag?.criticalPath).toContain('validate');
      expect(scan.pluginConnectors?.some((connector) => connector.id === 'github')).toBe(true);
      expect(scan.orchestrationPlan?.subagentIds).toContain('implementer');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('review diff collection', () => {
  it('builds review evidence and stats for untracked new files', async () => {
    const projectRoot = makeTempDir('kira-untracked-diff-');
    try {
      execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
      fs.mkdirSync(join(projectRoot, 'src'), { recursive: true });
      fs.writeFileSync(
        join(projectRoot, 'src', 'new-feature.ts'),
        'export const feature = true;\n',
        'utf-8',
      );

      const excerpts = await collectReviewerDiffExcerpts(projectRoot, ['src/new-feature.ts']);
      const stats = await collectGitDiffStats(projectRoot, ['src/new-feature.ts']);

      expect(excerpts.join('\n')).toContain('new file mode 100644');
      expect(excerpts.join('\n')).toContain('+export const feature = true;');
      expect(stats).toEqual({
        files: 1,
        additions: 1,
        deletions: 0,
        hunks: 1,
      });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('project intelligence profile', () => {
  it('builds a reusable profile for worker specialization and validation memory', () => {
    const projectRoot = makeTempDir('kira-profile-');
    try {
      fs.mkdirSync(join(projectRoot, 'src', 'components'), { recursive: true });
      fs.mkdirSync(join(projectRoot, 'src', '__tests__'), { recursive: true });
      fs.writeFileSync(
        join(projectRoot, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } }),
        'utf-8',
      );
      fs.writeFileSync(join(projectRoot, 'tsconfig.json'), '{}', 'utf-8');
      fs.writeFileSync(
        join(projectRoot, 'src', 'components', 'App.tsx'),
        'export function App() {}',
      );
      fs.writeFileSync(join(projectRoot, 'src', '__tests__', 'App.test.tsx'), 'test("app",()=>{})');
      fs.writeFileSync(join(projectRoot, 'README.md'), '# Demo');

      const profile = refreshProjectIntelligenceProfile(projectRoot, 'Demo');

      expect(fs.existsSync(getProjectProfilePath(projectRoot))).toBe(true);
      expect(profile.workers.recommendedProfiles).toContain('frontend-ui');
      expect(profile.workers.recommendedProfiles).toContain('test-validation');
      expect(profile.validation.candidateCommands.length).toBeGreaterThan(0);
      expect(profile.conventions.styleSignals.join('\n')).toContain('TypeScript');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('recommendWorkDecomposition()', () => {
  it('recommends splitting broad multi-surface work', () => {
    const recommendation = recommendWorkDecomposition(
      {
        ...makeWork(),
        description: [
          '# Brief',
          '- Update frontend UI',
          '- Add backend API',
          '- Add database migration',
          '- Add tests',
          '- Update docs',
          '- Handle auth',
          '- Update validation',
          '- Ship integration',
        ].join('\n'),
      },
      {
        likelyFiles: Array.from({ length: 12 }, (_, index) => `src/file-${index}.ts`),
        testFiles: ['src/file.test.ts'],
        relatedDocs: ['README.md'],
        candidateChecks: ['pnpm test'],
      },
    );

    expect(recommendation.shouldSplit).toBe(true);
    expect(recommendation.suggestedWorks.length).toBeGreaterThanOrEqual(2);
    expect(recommendation.signals.join('\n')).toContain('Multiple implementation surfaces');
  });
});

describe('collectWorkerSelfCheckIssues()', () => {
  it('requires workers to submit a meaningful final self-check', () => {
    expect(
      collectWorkerSelfCheckIssues({
        workerSummary: {
          summary: 'Updated files.',
          filesChanged: ['src/app.ts'],
          testsRun: [],
          remainingRisks: [],
        },
        workerPlan: makePlan(),
        requiredInstructions: 'Use strict TypeScript.',
        validationPlan: {
          plannerCommands: ['pnpm test'],
          autoAddedCommands: [],
          effectiveCommands: ['pnpm test'],
          notes: [],
        },
        filesChanged: ['src/app.ts'],
      }),
    ).toEqual([
      'Worker final JSON did not include selfCheck; rerun with an explicit diff, plan, project-instruction, and validation self-check.',
    ]);

    expect(
      collectWorkerSelfCheckIssues({
        workerSummary: {
          summary: 'Updated files.',
          filesChanged: ['src/app.ts'],
          testsRun: ['pnpm test'],
          remainingRisks: [],
          selfCheck: {
            reviewedDiff: true,
            followedProjectInstructions: true,
            matchedPlan: true,
            ranOrExplainedValidation: true,
            diffHunkReview: [
              {
                file: 'src/app.ts',
                intent: 'Update app behavior.',
                risk: 'Low risk.',
              },
            ],
            requirementTrace: [
              {
                id: 'R1',
                source: 'brief',
                text: 'Make worker and reviewer behavior safer.',
                status: 'satisfied',
                evidence: ['src/app.ts updated.'],
              },
            ],
            uncertainty: [],
            notes: ['Diff reviewed.'],
          },
        },
        workerPlan: makePlan(),
        requiredInstructions: 'Use strict TypeScript.',
        validationPlan: {
          plannerCommands: ['pnpm test'],
          autoAddedCommands: [],
          effectiveCommands: ['pnpm test'],
          notes: [],
        },
        filesChanged: ['src/app.ts'],
      }),
    ).toEqual([]);
  });

  it('requires diff hunk review for changed files', () => {
    expect(
      collectWorkerSelfCheckIssues({
        workerSummary: {
          summary: 'Updated files.',
          filesChanged: ['src/app.ts'],
          testsRun: ['pnpm test'],
          remainingRisks: [],
          selfCheck: {
            reviewedDiff: true,
            followedProjectInstructions: true,
            matchedPlan: true,
            ranOrExplainedValidation: true,
            diffHunkReview: [],
            requirementTrace: [
              {
                id: 'R1',
                source: 'brief',
                text: 'Make worker and reviewer behavior safer.',
                status: 'satisfied',
                evidence: ['src/app.ts updated.'],
              },
            ],
            uncertainty: [],
            notes: [],
          },
        },
        workerPlan: makePlan(),
        requiredInstructions: '',
        validationPlan: {
          plannerCommands: ['pnpm test'],
          autoAddedCommands: [],
          effectiveCommands: ['pnpm test'],
          notes: [],
        },
        filesChanged: ['src/app.ts'],
      }),
    ).toContain('Worker self-check did not include diffHunkReview for the final patch.');
  });

  it('does not accept planned or evidence-free requirement trace entries as completed work', () => {
    const issues = collectWorkerSelfCheckIssues({
      workerSummary: {
        summary: 'Updated files.',
        filesChanged: ['src/app.ts'],
        testsRun: ['pnpm test'],
        remainingRisks: [],
        selfCheck: {
          reviewedDiff: true,
          followedProjectInstructions: true,
          matchedPlan: true,
          ranOrExplainedValidation: true,
          diffHunkReview: [
            {
              file: 'src/app.ts',
              intent: 'Update app behavior.',
              risk: 'Low risk.',
            },
          ],
          requirementTrace: [
            {
              id: 'R1',
              source: 'brief',
              text: 'Make worker and reviewer behavior safer.',
              status: 'planned',
              evidence: [],
            },
          ],
          uncertainty: [],
          notes: [],
        },
      },
      workerPlan: makePlan(),
      requiredInstructions: '',
      validationPlan: {
        plannerCommands: ['pnpm test'],
        autoAddedCommands: [],
        effectiveCommands: ['pnpm test'],
        notes: [],
      },
      filesChanged: ['src/app.ts'],
    });

    expect(issues.join('\n')).toContain(
      'Worker self-check requirementTrace is incomplete for R1: status=planned without evidence.',
    );
  });

  it('does not allow brief requirements to be marked not_applicable to shrink scope', () => {
    const issues = collectWorkerSelfCheckIssues({
      workerSummary: {
        summary: 'Updated files.',
        filesChanged: ['src/app.ts'],
        testsRun: ['pnpm test'],
        remainingRisks: [],
        selfCheck: {
          reviewedDiff: true,
          followedProjectInstructions: true,
          matchedPlan: true,
          ranOrExplainedValidation: true,
          diffHunkReview: [
            {
              file: 'src/app.ts',
              intent: 'Update app behavior.',
              risk: 'Low risk.',
            },
          ],
          requirementTrace: [
            {
              id: 'R1',
              source: 'brief',
              text: 'Complete the full requested Kira hardening.',
              status: 'not_applicable',
              evidence: ['Skipped as out of scope.'],
            },
          ],
          uncertainty: [],
          notes: [],
        },
      },
      workerPlan: makePlan(),
      requiredInstructions: '',
      validationPlan: {
        plannerCommands: ['pnpm test'],
        autoAddedCommands: [],
        effectiveCommands: ['pnpm test'],
        notes: [],
      },
      filesChanged: ['src/app.ts'],
    });

    expect(issues.join('\n')).toContain('status=not_applicable');
    expect(issues.join('\n')).toContain('cannot be marked not_applicable');
  });

  it('blocks non-documentation changes when Kira has no effective validation command', () => {
    const issues = collectWorkerSelfCheckIssues({
      workerSummary: {
        summary: 'Updated files.',
        filesChanged: ['src/app.ts'],
        testsRun: [],
        remainingRisks: [],
        selfCheck: {
          reviewedDiff: true,
          followedProjectInstructions: true,
          matchedPlan: true,
          ranOrExplainedValidation: true,
          diffHunkReview: [
            {
              file: 'src/app.ts',
              intent: 'Update app behavior.',
              risk: 'Low risk.',
            },
          ],
          requirementTrace: [
            {
              id: 'R1',
              source: 'brief',
              text: 'Make worker and reviewer behavior safer.',
              status: 'satisfied',
              evidence: ['src/app.ts updated.'],
            },
          ],
          uncertainty: [],
          notes: [],
        },
      },
      workerPlan: makePlan(),
      requiredInstructions: '',
      validationPlan: {
        plannerCommands: [],
        autoAddedCommands: [],
        effectiveCommands: [],
        notes: ['No safe validation command could be inferred from the changed files.'],
      },
      filesChanged: ['src/app.ts'],
    });

    expect(issues).toContain(
      'Kira found non-documentation changes but no effective validation command; add a safe project validation command or block the attempt instead of approving unverified code.',
    );
  });

  it('allows documentation-only changes to explain that no code validation was inferred', () => {
    const issues = collectWorkerSelfCheckIssues({
      workerSummary: {
        summary: 'Updated docs.',
        filesChanged: ['docs/guide.md'],
        testsRun: [],
        remainingRisks: [],
        selfCheck: {
          reviewedDiff: true,
          followedProjectInstructions: true,
          matchedPlan: true,
          ranOrExplainedValidation: true,
          diffHunkReview: [
            {
              file: 'docs/guide.md',
              intent: 'Update documentation.',
              risk: 'Documentation only.',
            },
          ],
          requirementTrace: [
            {
              id: 'R1',
              source: 'brief',
              text: 'Update the documentation.',
              status: 'satisfied',
              evidence: ['docs/guide.md updated.'],
            },
          ],
          uncertainty: [],
          notes: ['No code validation required.'],
        },
      },
      workerPlan: {
        ...makePlan(),
        intendedFiles: ['docs/guide.md'],
        changeDesign: {
          ...makePlan().changeDesign,
          targetFiles: ['docs/guide.md'],
        },
      },
      requiredInstructions: '',
      validationPlan: {
        plannerCommands: [],
        autoAddedCommands: [],
        effectiveCommands: [],
        notes: [
          'Only documentation files changed; no automatic code validation command was added.',
        ],
      },
      filesChanged: ['docs/guide.md'],
    });

    expect(issues.join('\n')).not.toContain('no effective validation command');
  });
});

describe('enforceReviewDecision()', () => {
  it('overrides reviewer approval for non-documentation changes without validation commands', () => {
    const review = enforceReviewDecision(
      {
        approved: true,
        summary: 'Looks good.',
        issues: [],
        filesChecked: ['src/app.ts'],
        findings: [],
        missingValidation: [],
        nextWorkerInstructions: [],
        residualRisk: [],
        evidenceChecked: [
          {
            file: 'src/app.ts',
            reason: 'Reviewed the diff.',
            method: 'diff',
          },
        ],
        requirementVerdicts: [
          {
            id: 'R1',
            source: 'brief',
            text: 'Make worker and reviewer behavior safer.',
            status: 'satisfied',
            evidence: ['src/app.ts updated.'],
          },
        ],
        adversarialChecks: [
          {
            mode: 'correctness',
            result: 'passed',
            evidence: ['src/app.ts reviewed.'],
          },
        ],
        reviewerDiscourse: [],
      },
      {
        workerSummary: {
          summary: 'Updated files.',
          filesChanged: ['src/app.ts'],
          testsRun: [],
          remainingRisks: [],
          selfCheck: {
            reviewedDiff: true,
            followedProjectInstructions: true,
            matchedPlan: true,
            ranOrExplainedValidation: true,
            diffHunkReview: [
              {
                file: 'src/app.ts',
                intent: 'Update app behavior.',
                risk: 'Low risk.',
              },
            ],
            requirementTrace: [
              {
                id: 'R1',
                source: 'brief',
                text: 'Make worker and reviewer behavior safer.',
                status: 'satisfied',
                evidence: ['src/app.ts updated.'],
              },
            ],
            uncertainty: [],
            notes: [],
          },
        },
        validationPlan: {
          plannerCommands: [],
          autoAddedCommands: [],
          effectiveCommands: [],
          notes: ['No safe validation command could be inferred from the changed files.'],
        },
        validationReruns: {
          passed: [],
          failed: [],
          failureDetails: [],
        },
        diffExcerpts: ['diff -- src/app.ts'],
        requirementTrace: makePlan().requirementTrace,
      },
    );

    expect(review.approved).toBe(false);
    expect(review.issues).toContain(
      'Reviewer approved non-documentation changes even though Kira had no effective validation command.',
    );
  });
});

describe('verifyPatchIntent()', () => {
  it('flags changed files that drift from the preflight plan', () => {
    const verification = verifyPatchIntent({
      workerPlan: makePlan(),
      workerSummary: {
        summary: 'Updated the app.',
        filesChanged: ['src/other.ts'],
        testsRun: ['pnpm test'],
        remainingRisks: [],
        selfCheck: {
          reviewedDiff: true,
          followedProjectInstructions: true,
          matchedPlan: true,
          ranOrExplainedValidation: true,
          diffHunkReview: [
            {
              file: 'src/other.ts',
              intent: 'Change unrelated file.',
              risk: 'Unexpected scope.',
            },
          ],
          requirementTrace: [
            {
              id: 'R1',
              source: 'brief',
              text: 'Make worker and reviewer behavior safer.',
              status: 'satisfied',
              evidence: ['src/other.ts updated.'],
            },
          ],
          uncertainty: [],
          notes: [],
        },
      },
      outOfPlanFiles: ['src/other.ts'],
      diffStats: { files: 1, additions: 3, deletions: 0, hunks: 1 },
      diffExcerpts: ['diff -- src/other.ts'],
    });

    expect(verification.status).toBe('drift');
    expect(verification.issues.join('\n')).toContain('outside the planned intent');
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

describe('Kira model route limits', () =>
{
  it('uses one route slot for local model endpoints', () =>
  {
    expect(
      getKiraModelRouteLimit({
        provider: 'llama.cpp',
        baseUrl: 'https://example.invalid/v1',
      }),
    ).toBe(1);
    expect(
      getKiraModelRouteLimit({
        provider: 'openai',
        baseUrl: 'http://127.0.0.1:1234/v1',
      }),
    ).toBe(1);
    expect(
      getKiraModelRouteLimit({
        provider: 'openai',
        baseUrl: 'http://192.168.0.20:1234/v1',
      }),
    ).toBe(1);
  });

  it('uses two route slots for non-local model endpoints', () =>
  {
    expect(
      getKiraModelRouteLimit({
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
    ).toBe(2);
    expect(
      getKiraModelRouteLimit({
        provider: 'codex-cli',
        baseUrl: '',
      }),
    ).toBe(2);
  });

  it('normalizes same-model route keys by provider, base URL, and model', () =>
  {
    expect(
      getKiraModelRouteKey({
        provider: 'opencode-go',
        baseUrl: 'https://opencode.ai/zen/go/',
        model: 'opencode-go/kimi-k2.5',
      }),
    ).toBe('opencode-go|https://opencode.ai/zen/go|kimi-k2.5');
  });

  it('serializes same-route local model work', async () =>
  {
    const config = {
      provider: 'openai' as const,
      apiKey: '',
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'local-route-limit-test',
    };
    const events: string[] = [];
    let releaseFirst: (() => void) | null = null;

    const first = runWithKiraModelRouteLimit(config, async () =>
    {
      events.push('first-start');
      await new Promise<void>((resolve) =>
      {
        releaseFirst = resolve;
      });
      events.push('first-end');
      return 'first';
    });
    await Promise.resolve();

    const second = runWithKiraModelRouteLimit(config, async () =>
    {
      events.push('second-start');
      return 'second';
    });
    await Promise.resolve();

    expect(events).toEqual(['first-start']);
    expect(releaseFirst).toBeTypeOf('function');
    releaseFirst?.();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(events).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('allows two same-route non-local model calls before queueing', async () =>
  {
    const config = {
      provider: 'openrouter' as const,
      apiKey: 'sk-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'remote-route-limit-test',
    };
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirst: (() => void) | null = null;
    let releaseSecond: (() => void) | null = null;

    const runHeldTask = (
      label: string,
      setRelease: (release: () => void) => void,
    ): Promise<string> =>
      runWithKiraModelRouteLimit(config, async () =>
      {
        events.push(`${label}-start`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) =>
        {
          setRelease(resolve);
        });
        active -= 1;
        events.push(`${label}-end`);
        return label;
      });

    const first = runHeldTask('first', (release) =>
    {
      releaseFirst = release;
    });
    const second = runHeldTask('second', (release) =>
    {
      releaseSecond = release;
    });
    await Promise.resolve();

    const third = runWithKiraModelRouteLimit(config, async () =>
    {
      events.push('third-start');
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      events.push('third-end');
      return 'third';
    });
    await Promise.resolve();

    expect(events).toEqual(['first-start', 'second-start']);
    expect(maxActive).toBe(2);
    releaseFirst?.();
    await expect(first).resolves.toBe('first');
    await expect(third).resolves.toBe('third');
    releaseSecond?.();
    await expect(second).resolves.toBe('second');
    expect(events).toEqual([
      'first-start',
      'second-start',
      'first-end',
      'third-start',
      'third-end',
      'second-end',
    ]);
    expect(maxActive).toBe(2);
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
    expect(resolveProjectSettings(null)).toMatchObject({
      autoCommit: true,
      requiredInstructions: '',
      effectiveInstructions: '',
      runMode: 'standard',
    });
    expect(resolveProjectSettings({})).toMatchObject({
      autoCommit: true,
      requiredInstructions: '',
      effectiveInstructions: '',
      runMode: 'standard',
    });
  });

  it('respects an explicit autoCommit false value', () => {
    expect(resolveProjectSettings({ autoCommit: false })).toMatchObject({
      autoCommit: false,
      requiredInstructions: '',
      effectiveInstructions: '',
      runMode: 'standard',
    });
  });

  it('uses the provided fallback when the project file does not define autoCommit', () => {
    expect(resolveProjectSettings({}, { autoCommit: false })).toMatchObject({
      autoCommit: false,
      requiredInstructions: '',
      effectiveInstructions: '',
      runMode: 'standard',
    });
  });

  it('resolves mandatory project instructions with project-local precedence', () => {
    expect(
      resolveProjectSettings(
        { requiredInstructions: 'Use tabs for Makefiles.' },
        { requiredInstructions: 'Use spaces.' },
      ),
    ).toMatchObject({
      autoCommit: true,
      requiredInstructions: 'Use tabs for Makefiles.',
      effectiveInstructions: 'Use tabs for Makefiles.',
    });

    expect(resolveProjectSettings({}, { requiredInstructions: 'Use spaces.' })).toMatchObject({
      autoCommit: true,
      requiredInstructions: 'Use spaces.',
      effectiveInstructions: 'Use spaces.',
    });

    expect(
      resolveProjectSettings({ requiredInstructions: '' }, { requiredInstructions: 'Use spaces.' }),
    ).toMatchObject({
      autoCommit: true,
      requiredInstructions: '',
      effectiveInstructions: '',
    });
  });

  it('merges run mode and enabled rule packs into effective instructions', () => {
    const settings = resolveProjectSettings({
      runMode: 'deep',
      requiredInstructions: 'Use project conventions.',
      rulePacks: [{ id: 'small-patch', enabled: true }],
    });

    expect(settings.runMode).toBe('deep');
    expect(settings.rulePacks.find((item) => item.id === 'small-patch')?.enabled).toBe(true);
    expect(settings.effectiveInstructions).toContain('Use project conventions.');
    expect(settings.effectiveInstructions).toContain('Rule pack: Small Patch');
  });

  it('lets a project-local rule pack list override inherited defaults', () => {
    const settings = resolveProjectSettings(
      { rulePacks: [] },
      { rulePacks: [{ id: 'validation-first', enabled: true }] },
    );

    expect(settings.rulePacks.find((item) => item.id === 'validation-first')?.enabled).toBe(false);
    expect(settings.effectiveInstructions).not.toContain('Rule pack: Validation First');
  });

  it('normalizes orchestration settings for policy, environment, subagents, workflow, and plugins', () => {
    const settings = resolveProjectSettings({
      executionPolicy: {
        mode: 'locked-down',
        maxChangedFiles: 3,
        maxDiffLines: 120,
        protectedPaths: ['secrets/**'],
        commandDenylist: ['pnpm add'],
      },
      environment: {
        runner: 'remote-command',
        remoteCommand: 'ssh builder -- {command}',
        validationCommands: ['pnpm run typecheck'],
        requiredEnv: ['KIRA_TOKEN'],
      },
      subagents: [{ id: 'docs', label: 'Docs', profile: 'docs-maintainer', enabled: true }],
      workflow: {
        nodes: [
          { id: 'plan', label: 'Plan', kind: 'plan', required: true },
          { id: 'validate', label: 'Validate', kind: 'validate', required: true },
        ],
        edges: [{ from: 'plan', to: 'validate', condition: 'planned' }],
        criticalPath: ['plan', 'validate'],
      },
      plugins: [{ id: 'github', enabled: true, policy: 'suggest', capabilities: ['issues'] }],
    });

    expect(settings.executionPolicy.mode).toBe('locked-down');
    expect(settings.executionPolicy.maxChangedFiles).toBe(3);
    expect(settings.environment.runner).toBe('remote-command');
    expect(settings.environment.validationCommands).toContain('pnpm run typecheck');
    expect(settings.subagents.some((agent) => agent.id === 'docs')).toBe(true);
    expect(settings.workflow.criticalPath).toEqual(['plan', 'validate']);
    expect(settings.plugins.find((connector) => connector.id === 'github')?.enabled).toBe(true);
  });
});

describe('validateKiraOrchestrationContract()', () => {
  const fixtures = JSON.parse(
    fs.readFileSync(
      join(process.cwd(), 'src/pages/Kira/fixtures/orchestration-regression-fixtures.json'),
      'utf-8',
    ),
  ) as Record<string, any>;

  it('rejects remote-command runner declarations without an executable command template', () => {
    const report = validateKiraOrchestrationContract({
      environment: fixtures.remoteRunnerMissing.environment,
    });

    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.path)).toContain('environment.remoteCommand');
    expect(report.issues.map((issue) => issue.message).join('\n')).toContain('{command}');
  });

  it('keeps GitHub connector and customized DAG fixtures valid when policy requirements match', () => {
    const report = validateKiraOrchestrationContract({
      executionPolicy: {
        requireValidation: false,
        requireReviewerEvidence: true,
      },
      plugins: fixtures.pluginEnabled.plugins,
      workflow: fixtures.dagCustomized.workflow,
    });

    expect(report.valid).toBe(true);
    expect(report.normalized.plugins.find((connector) => connector.id === 'github')?.enabled).toBe(
      true,
    );
    expect(report.normalized.workflow.criticalPath).toEqual(['plan', 'implement', 'review']);
  });

  it('flags invalid workflow edges and duplicate subagent ids before project settings are saved', () => {
    const report = validateKiraOrchestrationContract({
      subagents: [
        { id: 'implementer', tools: ['read_file'], requiredEvidence: [] },
        { id: 'implementer', tools: ['unknown_tool'], requiredEvidence: [] },
      ],
      workflow: {
        nodes: [{ id: 'plan', kind: 'plan', required: true }],
        edges: [{ from: 'plan', to: 'missing' }],
        criticalPath: ['plan', 'missing'],
      },
    });

    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.path)).toContain('subagents[1].id');
    expect(report.issues.map((issue) => issue.path)).toContain('subagents[1].tools[0]');
    expect(report.issues.map((issue) => issue.path)).toContain('workflow.edges[0].to');
    expect(report.issues.map((issue) => issue.path)).toContain('workflow.criticalPath[1]');
  });

  it('normalizes policy-blocked attempt fixture with approval readiness blockers intact', () => {
    const attempt = fixtures.policyBlockedAttempt;

    expect(attempt.status).toBe('blocked');
    expect(attempt.evidenceLedger.approvalReadiness.status).toBe('blocked');
    expect(attempt.evidenceLedger.items[0].kind).toBe('policy');
  });
});

describe('evaluateExecutionPolicy()', () => {
  it('blocks protected writes and denied commands before tool execution', () => {
    expect(
      evaluateExecutionPolicy({ protectedPaths: ['secrets/**'] }, 'before_tool', {
        toolName: 'write_file',
        path: 'secrets/token.txt',
      }).decision,
    ).toBe('block');

    const denied = evaluateExecutionPolicy({ commandDenylist: ['pnpm add'] }, 'before_tool', {
      toolName: 'run_command',
      command: 'pnpm add left-pad',
    });

    expect(denied.decision).toBe('block');
    expect(denied.issues.join('\n')).toContain('denied command');
  });

  it('blocks integration when patch size exceeds locked execution policy limits', () => {
    const result = evaluateExecutionPolicy(
      {
        mode: 'locked-down',
        maxChangedFiles: 1,
        maxDiffLines: 5,
      },
      'before_integration',
      {
        changedFiles: ['src/a.ts', 'src/b.ts'],
        diffStats: { files: 2, additions: 10, deletions: 0, hunks: 2 },
      },
    );

    expect(result.decision).toBe('block');
    expect(result.issues.join('\n')).toContain('changed-file limit exceeded');
    expect(result.issues.join('\n')).toContain('diff-line limit exceeded');
  });

  it('applies before_validation and task_completed policy hooks', () => {
    const beforeValidation = evaluateExecutionPolicy(
      {
        rules: [
          {
            id: 'block-typecheck',
            event: 'before_validation',
            enabled: true,
            decision: 'block',
            message: 'Typecheck is blocked in this fixture.',
            toolNames: ['run_command'],
            pathPatterns: [],
            commandPatterns: ['pnpm run typecheck'],
            riskLevels: [],
          },
        ],
      },
      'before_validation',
      { toolName: 'run_command', command: 'pnpm run typecheck' },
    );
    const completed = evaluateExecutionPolicy(
      {
        rules: [
          {
            id: 'block-high-risk-complete',
            event: 'task_completed',
            enabled: true,
            decision: 'block',
            message: 'High risk completion requires manual approval.',
            toolNames: [],
            pathPatterns: [],
            commandPatterns: [],
            riskLevels: ['high'],
          },
        ],
      },
      'task_completed',
      { riskLevel: 'high' },
    );

    expect(beforeValidation.decision).toBe('block');
    expect(completed.decision).toBe('block');
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

  it('detects pre-existing dirty files that an attempt removed or reverted', () => {
    const before = parseGitStatusPorcelain(' M user-work.ts\n?? scratch.txt');
    const after = parseGitStatusPorcelain('?? scratch.txt');

    expect(detectTouchedFilesFromGitStatus(before, after)).toEqual(['user-work.ts']);
  });

  it('detects pre-existing dirty files whose git status entry stays unchanged', () => {
    const projectRoot = makeTempDir('kira-dirty-hash-');
    try {
      fs.mkdirSync(join(projectRoot, 'src'), { recursive: true });
      fs.writeFileSync(join(projectRoot, 'src', 'user-work.ts'), 'const value = 1;\n', 'utf-8');

      const before = captureDirtyFileSnapshots(projectRoot, ['src/user-work.ts']);
      fs.writeFileSync(join(projectRoot, 'src', 'user-work.ts'), 'const value = 2;\n', 'utf-8');

      expect(detectTouchedFilesFromDirtySnapshots(projectRoot, before)).toEqual([
        'src/user-work.ts',
      ]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('adds project environment validation commands to the effective plan', () => {
    const projectRoot = fs.mkdtempSync(join(os.tmpdir(), 'kira-env-validation-'));
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
      const plan = resolveValidationPlan(projectRoot, [], ['src/app.ts'], {
        runner: 'local',
        setupCommands: [],
        validationCommands: ['pnpm run typecheck'],
        requiredEnv: [],
        allowedNetwork: 'localhost',
        secretsPolicy: 'local-only',
        windowsMode: 'auto',
        remoteCommand: '',
        devServerCommand: '',
      });

      expect(plan.effectiveCommands).toContain('pnpm run typecheck');
      expect(plan.notes.join('\n')).toContain('environment contract');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('ignores pre-existing dirty files whose content is unchanged', () => {
    const projectRoot = makeTempDir('kira-dirty-hash-');
    try {
      fs.mkdirSync(join(projectRoot, 'src'), { recursive: true });
      fs.writeFileSync(join(projectRoot, 'src', 'user-work.ts'), 'const value = 1;\n', 'utf-8');

      const before = captureDirtyFileSnapshots(projectRoot, ['src/user-work.ts']);

      expect(detectTouchedFilesFromDirtySnapshots(projectRoot, before)).toEqual([]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
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
    expect(isSafeCommandAllowed('pnpm --dir apps/webuiapps exec vitest src/foo.test.ts')).toBe(
      true,
    );
    expect(isSafeCommandAllowed('pnpm --dir apps/webuiapps run build:test')).toBe(true);
    expect(isSafeCommandAllowed('npm run test:coverage')).toBe(true);
    expect(isSafeCommandAllowed('git diff --stat')).toBe(true);
    expect(isSafeCommandAllowed('rg -n "data-theme" templates/index.html')).toBe(true);
  });

  it('rejects commands that are too broad or potentially mutating', () => {
    expect(isSafeCommandAllowed('npm install')).toBe(false);
    expect(isSafeCommandAllowed('pnpm --dir ../other exec vitest')).toBe(false);
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

describe('automation locks', () => {
  it('treats inaccessible lock paths as unavailable instead of throwing', () => {
    const tempDir = makeTempDir('kira-locks-');
    try {
      const parentFile = join(tempDir, 'automation-locks');
      fs.writeFileSync(parentFile, 'not a directory', 'utf-8');

      expect(
        tryAcquireLock(join(parentFile, 'work-1.json'), {
          ownerId: 'test-owner',
          resource: 'work',
          sessionPath: 'test/session',
          targetKey: 'work-1',
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('recognizes lock EPERM messages even when the error has no code', () => {
    const message =
      "EPERM: operation not permitted, open 'C:\\Users\\kernulist\\.openroom\\sessions\\aoi\\space_adventure\\apps\\kira\\data\\automation-locks\\work-1777350905817-pthsqi2so.json'";

    expect(isRecoverableAutomationLockMessage(`Kira 자동 스캔 오류: ${message}`)).toBe(true);
    expect(isRecoverableLockError(new Error(message))).toBe(true);
  });

  it('does not hide unrelated filesystem errors with recoverable codes', () => {
    const error = Object.assign(
      new Error("ENOENT: no such file or directory, open 'missing.json'"),
      {
        code: 'ENOENT',
        path: 'missing.json',
      },
    );

    expect(isRecoverableLockError(error)).toBe(false);
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
