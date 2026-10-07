/**
 * Seed each APP's meta.yaml and guide.md into disk storage on initialization
 * So Agent can read them via file_read("apps/{appName}/meta.yaml")
 */

import * as idb from './diskStorage';
import { getSourceDirToAppName } from './appRegistry';
import { getSessionPath } from './sessionPath';

// Eager import — inlined as strings at build time
const metaFiles: Record<string, string> = import.meta.glob(
  [
    '../pages/*/meta/meta_en/meta.yaml',
    '../pages/*/meta/meta_en/guide.md',
    '../pages/*/*_en/meta.yaml',
    '../pages/*/*_en/guide.md',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const DIR_TO_APP_NAME = getSourceDirToAppName();

// Per session path: storage is scoped to the active session, so a one-shot
// module flag left a switched-to character/mod (and a session just reset, which
// deletes its directory) with no meta.yaml for the agent's required first read.
// Keeping the in-flight promise also lets a second caller wait for the first
// write instead of returning before it lands.
const seededSessions = new Map<string, Promise<void>>();

export function seedMetaFiles(options: { force?: boolean } = {}): Promise<void> {
  const sessionPath = getSessionPath();
  const existing = seededSessions.get(sessionPath);
  if (existing && !options.force) {
    return existing;
  }
  const seeding = writeMetaFiles().catch((error) => {
    // A failed write must be retried by the next caller, not remembered.
    seededSessions.delete(sessionPath);
    throw error;
  });
  seededSessions.set(sessionPath, seeding);
  return seeding;
}

async function writeMetaFiles(): Promise<void> {
  const files: Array<{ path: string; name: string; content: string }> = [];

  for (const [filePath, content] of Object.entries(metaFiles)) {
    const dirMatch = filePath.match(/\.\.\/pages\/([^/]+)\//);
    if (!dirMatch) continue;
    const appName = DIR_TO_APP_NAME[dirMatch[1]] || dirMatch[1].toLowerCase();
    const fileName = filePath.split('/').pop() || '';
    if (!fileName) continue;
    files.push({ path: `apps/${appName}`, name: fileName, content });
  }

  if (files.length > 0) {
    await idb.putTextFilesByJSON({ files });
    console.info(`[seedMeta] Seeded ${files.length} meta files to disk`);
  }
}
