import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildAoiServerJarvisAutonomyGovernor } from '../aoiServerJarvisGovernor';

const NOW = 1_800_000_000_000;
const SESSION_PATH = 'aoi/default';
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-server-governor-'));
  tempRoots.push(root);
  return fs.realpathSync(root);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('buildAoiServerJarvisAutonomyGovernor (P2.3 / P5.5 prerequisite)', () => {
  it('computes a display-only governor decision server-side from stores (no writes)', () => {
    const root = makeRoot();
    const decision = buildAoiServerJarvisAutonomyGovernor({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      configFile: join(root, 'config.json'),
      now: NOW,
    });

    // A real governor decision shape -- the same one the client builds.
    expect(decision.version).toBe(1);
    expect(decision.sessionPath).toBe(SESSION_PATH);
    expect(typeof decision.overallMode).toBe('string');
    expect(Array.isArray(decision.allowedAutonomyBands)).toBe(true);
    // Read-only by construction: it never gains authority or mutates.
    expect(decision.actionAuthority).toBe('display_only');
    expect(decision.mutationCount).toBe(0);

    // With empty stores (no earned closed-loop evidence), direct_chat is NOT auto-allowed --
    // the readiness gate fails closed, which is exactly the safe default.
    const directChatBand = decision.allowedAutonomyBands.find(
      (band) => band.capability === 'direct_chat',
    );
    expect(directChatBand?.allowed ?? false).toBe(false);
  });

  it('does not write anything to the sessions directory', () => {
    const root = makeRoot();
    buildAoiServerJarvisAutonomyGovernor({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      configFile: join(root, 'config.json'),
      now: NOW,
    });
    // The only entries should be nothing (governor is read-only; empty store stays empty).
    const entries = fs.existsSync(join(root, 'aoi')) ? fs.readdirSync(join(root, 'aoi')) : [];
    expect(entries).toEqual([]);
  });
});
