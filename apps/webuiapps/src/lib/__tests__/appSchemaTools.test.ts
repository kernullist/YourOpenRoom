import { describe, expect, it } from 'vitest';

import { executeAppSchemaTool } from '../appSchemaTools';

describe('executeAppSchemaTool()', () => {
  it('lists schemas for a known app', async () => {
    const result = await executeAppSchemaTool({ app_name: 'notes' });
    const parsed = JSON.parse(result) as { app_name: string; schemas: Array<{ id: string }> };

    expect(parsed.app_name).toBe('notes');
    expect(parsed.schemas.some((schema) => schema.id === 'notes-note')).toBe(true);
  });

  it('finds a schema by file path', async () => {
    const result = await executeAppSchemaTool({
      file_path: 'apps/browser/data/bookmarks/bookmark-1.json',
    });
    const parsed = JSON.parse(result) as { id: string; appName: string };

    expect(parsed.id).toBe('browser-bookmark');
    expect(parsed.appName).toBe('browser');
  });
});
