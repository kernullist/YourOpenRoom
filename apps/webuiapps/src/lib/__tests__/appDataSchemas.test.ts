import { describe, expect, it } from 'vitest';

import { validateAppDataWrite } from '../appDataSchemas';

describe('validateAppDataWrite()', () => {
  it('validates and normalizes a notes note payload', () => {
    const result = validateAppDataWrite(
      'apps/notes/data/notes/weekly-synthesis.json',
      JSON.stringify({
        id: 'weekly-synthesis',
        title: 'Weekly synthesis',
        content: '# Notes',
        tags: ['weekly'],
        pinned: false,
        createdAt: 1776200000000,
        updatedAt: 1776203600000,
      }),
    );

    expect(result?.ok).toBe(true);
    if (result && result.ok) {
      expect(result.schemaId).toBe('notes-note');
      expect(JSON.parse(result.normalizedContent).id).toBe('weekly-synthesis');
    }
  });

  it('rejects invalid email folder values', () => {
    const result = validateAppDataWrite(
      'apps/email/data/emails/mail-1.json',
      JSON.stringify({
        id: 'mail-1',
        from: { name: 'Alice', address: 'alice@example.com' },
        to: [{ name: 'Bob', address: 'bob@example.com' }],
        cc: [],
        subject: 'Hello',
        content: 'Hi',
        timestamp: 1776200000000,
        isRead: false,
        isStarred: false,
        folder: 'archive',
      }),
    );

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.errors[0]).toContain('folder must be one of');
    }
  });
});
