import { describe, expect, it } from 'vitest';
import {
  buildIssueSignature,
  detectTouchedFilesFromGitStatus,
  findSuggestedCommitBackfillSummary,
  parseGitStatusPorcelain,
  parseProjectDiscoveryAnalysis,
  parseStoredWorkerAttemptComment,
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

  it('returns null for non-worker-attempt comments', () => {
    expect(parseStoredWorkerAttemptComment('Approved.\n\nLooks good.')).toBeNull();
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

    const parsed = parseProjectDiscoveryAnalysis(raw, 'BriefWave-Cast', 'F:/root/BriefWave-Cast', null);

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
    const after = parseGitStatusPorcelain(' M existing.py\n M changed.py\n?? notes.txt\n?? new.txt');

    expect(detectTouchedFilesFromGitStatus(before, after)).toEqual(['changed.py', 'new.txt']);
  });
});

describe('buildIssueSignature()', () => {
  it('normalizes issue order so repeated review feedback can be compared reliably', () => {
    const a = buildIssueSignature(['B issue', 'A issue'], 'summary');
    const b = buildIssueSignature(['A issue', 'B issue'], 'another summary');
    expect(a).toBe(b);
  });
});
