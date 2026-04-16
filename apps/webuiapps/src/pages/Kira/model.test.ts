import {
  buildExcerpt,
  groupWorksByStatus,
  matchesProjectName,
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
});
