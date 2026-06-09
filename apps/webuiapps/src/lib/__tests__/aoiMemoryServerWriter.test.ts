import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadServerAoiMemories,
  syncAoiMemoryFromKiraAutomationEventServer,
} from '../aoiMemoryServerWriter';
import type { AoiMemoryEpisode } from '../aoiMemoryShared';

const tempRoots: string[] = [];

function makeTempSessionsDir(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'aoi-memory-server-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Aoi server memory writer', () => {
  it('stores completed Kira events without a browser session-data round trip', () => {
    const sessionsDir = makeTempSessionsDir();

    const memories = syncAoiMemoryFromKiraAutomationEventServer(sessionsDir, 'aoi/default', {
      id: 'event-1',
      workId: 'work-1',
      title: 'Add review controls',
      projectName: 'YourOpenRoom',
      message: 'Kira completed the work.',
      createdAt: 100,
      type: 'completed',
    });

    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      scope: 'project',
      type: 'action',
      projectKey: 'youropenroom',
      hits: 1,
      sourceEpisodeIds: ['aoi_kira_event-1'],
    });

    const storedMemories = loadServerAoiMemories(sessionsDir);
    expect(storedMemories).toHaveLength(1);
    expect(storedMemories[0].content).toContain('Kira completed project work');

    const episodePath = join(
      sessionsDir,
      'aoi',
      'memory-v2',
      'episodes',
      'aoi',
      'default',
      'aoi_kira_event-1.json',
    );
    const episode = JSON.parse(fs.readFileSync(episodePath, 'utf-8')) as AoiMemoryEpisode;
    expect(episode).toMatchObject({
      id: 'aoi_kira_event-1',
      source: 'kira_automation',
      outcome: 'completed',
    });
  });

  it('does not inflate hits when the same Kira event is replayed', () => {
    const sessionsDir = makeTempSessionsDir();
    const event = {
      id: 'event-1',
      workId: 'work-1',
      title: 'Add review controls',
      projectName: 'YourOpenRoom',
      message: 'Kira completed the work.',
      createdAt: 100,
      type: 'completed' as const,
    };

    syncAoiMemoryFromKiraAutomationEventServer(sessionsDir, 'aoi/default', event);
    const second = syncAoiMemoryFromKiraAutomationEventServer(sessionsDir, 'aoi/default', event);

    expect(second).toHaveLength(1);
    expect(second[0].hits).toBe(1);
    expect(second[0].sourceEpisodeIds).toEqual(['aoi_kira_event-1']);
  });

  it('ignores transient Kira progress events', () => {
    const sessionsDir = makeTempSessionsDir();

    const memories = syncAoiMemoryFromKiraAutomationEventServer(sessionsDir, 'aoi/default', {
      id: 'event-1',
      workId: 'work-1',
      title: 'Add review controls',
      projectName: 'YourOpenRoom',
      message: 'Kira started.',
      createdAt: 100,
      type: 'started',
    });

    expect(memories).toEqual([]);
    expect(loadServerAoiMemories(sessionsDir)).toEqual([]);
  });
});
