import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P4.3: the embed-on-write WIRING for Kira automation memories. This verifies the
// plugin glue -- recordKiraAutomationAoiMemory resolves the embedding provider and
// fires the async embed-on-write best-effort, swallowing a failure so the
// synchronous enqueue path is never blocked. The substantive writer
// (syncAoiMemoryFromKiraAutomationEventServerWithEmbedding) is covered directly in
// aoiMemoryServerWriter.test.ts; here it is mocked to a rejection so the wiring's
// resolve -> call -> best-effort-catch path is exercised without a real backend.
vi.mock('../aoiMemoryServerWriter', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    syncAoiMemoryFromKiraAutomationEventServerWithEmbedding: () =>
      Promise.reject(new Error('embed backend down')),
  };
});

import { recordKiraAutomationAoiMemory } from '../kiraAutomationPlugin';

const tempRoots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function makeRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-kira-mem-'));
  tempRoots.push(root);
  return fs.realpathSync(root);
}

beforeEach(() => {
  // No config-sibling file under a temp dir + cleared keys -> the provider resolves
  // to null (lexical) deterministically, with no network. Restored in afterEach.
  for (const key of ['GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('recordKiraAutomationAoiMemory (P4.3 embed-on-write wiring)', () => {
  it('resolves the provider, fires the embed-on-write, and swallows a reject (best-effort)', async () => {
    const root = makeRoot();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The wiring (context build + provider resolve + async call) runs; a rejected
    // embed must never throw out of the synchronous enqueue path.
    expect(() =>
      recordKiraAutomationAoiMemory(root, 'aoi/default', {
        id: 'ev-p43',
        workId: 'w-p43',
        title: 'Add review controls',
        projectName: 'YourOpenRoom',
        message: 'Kira completed the work.',
        createdAt: 100,
        type: 'completed',
      }),
    ).not.toThrow();

    // Fire-and-forget: the rejection is handled on a later tick and only logged.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(warn).toHaveBeenCalledWith(
      '[Kira] Failed to embed Aoi memory for automation event:',
      expect.any(Error),
    );
    warn.mockRestore();
  });
});
