import {
  buildExcerpt,
  groupWorksByStatus,
  matchesProjectName,
  normalizeKiraAttempt,
  normalizeKiraReview,
  normalizeTaskComment,
  normalizeWorkTask,
} from './model';

describe('Kira model helpers', () => {
  it('normalizes work records with safe defaults', () => {
    const work = normalizeWorkTask(
      JSON.stringify({
        id: 'work-1',
        title: 'Ship Kira',
        description: '# Goal',
      }),
    );

    expect(work).toMatchObject({
      id: 'work-1',
      type: 'work',
      projectName: '',
      title: 'Ship Kira',
      description: '# Goal',
      status: 'todo',
    });
  });

  it('normalizes comments as work-scoped entries', () => {
    const comment = normalizeTaskComment({
      id: 'comment-1',
      taskId: 'work-1',
      taskType: 'epic',
      body: 'hello',
    });

    expect(comment).toMatchObject({
      id: 'comment-1',
      taskId: 'work-1',
      taskType: 'work',
      body: 'hello',
    });
  });

  it('normalizes pending clarification questions on work records', () => {
    const work = normalizeWorkTask({
      id: 'work-1',
      title: 'Ship Kira',
      description: 'Make it better',
      clarification: {
        status: 'pending',
        briefHash: 'abc123',
        summary: 'One decision is missing.',
        questions: [
          {
            question: 'Which UX should be used?',
            options: ['Compact', 'Guided'],
            allowCustomAnswer: false,
          },
        ],
        createdAt: 123,
      },
    });

    expect(work?.clarification).toMatchObject({
      status: 'pending',
      briefHash: 'abc123',
      questions: [
        {
          id: 'q-1',
          question: 'Which UX should be used?',
          options: ['Compact', 'Guided'],
          allowCustomAnswer: false,
        },
      ],
    });
  });

  it('deduplicates clarification question ids on work records', () => {
    const work = normalizeWorkTask({
      id: 'work-1',
      clarification: {
        status: 'pending',
        briefHash: 'abc123',
        summary: 'Two decisions are missing.',
        questions: [
          { id: 'choice', question: 'First decision?', options: [] },
          { id: 'choice', question: 'Second decision?', options: [] },
        ],
        createdAt: 123,
      },
    });

    expect(work?.clarification?.questions.map((question) => question.id)).toEqual([
      'choice',
      'q-2',
    ]);
  });

  it('adds a fallback question for pending clarification records without usable questions', () => {
    const work = normalizeWorkTask({
      id: 'work-1',
      clarification: {
        status: 'pending',
        briefHash: 'abc123',
        summary: 'Question data was malformed.',
        questions: [{ id: 'bad', question: '   ', options: ['A'] }],
        createdAt: 123,
      },
    });

    expect(work?.clarification?.questions).toEqual([
      {
        id: 'q-1',
        question:
          'Kira could not load the clarification questions for this work. What should be clarified or changed before a worker starts?',
        options: [],
        allowCustomAnswer: true,
      },
    ]);
  });

  it('groups works by status', () => {
    const works = [
      normalizeWorkTask({
        id: 'work-1',
        projectName: 'YourOpenRoom',
        title: 'Draft schema',
        status: 'todo',
      }),
      normalizeWorkTask({
        id: 'work-2',
        projectName: 'YourOpenRoom',
        title: 'Build board',
        status: 'done',
      }),
      normalizeWorkTask({
        id: 'work-3',
        projectName: 'YourOpenRoom',
        title: 'Review UI',
        status: 'in_review',
      }),
      normalizeWorkTask({
        id: 'work-4',
        projectName: 'YourOpenRoom',
        title: 'Resolve review deadlock',
        status: 'blocked',
      }),
    ].filter((work): work is NonNullable<typeof work> => work !== null);

    const grouped = groupWorksByStatus(works);

    expect(grouped.todo).toHaveLength(1);
    expect(grouped.in_review).toHaveLength(1);
    expect(grouped.blocked).toHaveLength(1);
    expect(grouped.done).toHaveLength(1);
  });

  it('builds compact excerpts from markdown content', () => {
    expect(buildExcerpt('# Heading\n\n- Ship it')).toBe('Heading Ship it');
  });

  it('matches project names with legacy blank fallback', () => {
    expect(matchesProjectName('YourOpenRoom', 'YourOpenRoom')).toBe(true);
    expect(matchesProjectName('', 'AnotherProject')).toBe(true);
    expect(matchesProjectName('YourOpenRoom', 'AnotherProject')).toBe(false);
  });

  it('normalizes Kira attempt records for the Attempts panel', () => {
    const attempt = normalizeKiraAttempt({
      id: 'work-1-2',
      workId: 'work-1',
      attemptNo: 2,
      status: 'blocked',
      changedFiles: ['src/app.ts', 123],
      commandsRun: ['pnpm test'],
      blockedReason: { invalid: true },
      patchedFiles: ['src/app.ts'],
    });

    expect(attempt).toMatchObject({
      id: 'work-1-2',
      workId: 'work-1',
      attemptNo: 2,
      status: 'blocked',
      changedFiles: ['src/app.ts', '123'],
      commandsRun: ['pnpm test'],
      patchedFiles: ['src/app.ts'],
    });
    expect(attempt?.blockedReason).toBeUndefined();
  });

  it('normalizes Kira review findings and drops malformed entries', () => {
    const review = normalizeKiraReview({
      id: 'work-1-2',
      workId: 'work-1',
      attemptNo: 2,
      approved: true,
      summary: 'Needs work',
      findings: [
        { file: 'src/app.ts', line: 4, severity: 'critical', message: 'bad branch' },
        { file: 'src/empty.ts', message: '' },
        'not-a-finding',
      ],
      missingValidation: ['pnpm test', 42],
    });

    expect(review?.findings).toEqual([
      { file: 'src/app.ts', line: 4, severity: 'medium', message: 'bad branch' },
    ]);
    expect(review?.missingValidation).toEqual(['pnpm test', '42']);
  });
});
