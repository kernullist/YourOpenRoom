import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeAoiBrowserDriveAuditObserver,
  resolveAoiBrowserDriveArtifactDir,
  writeAoiBrowserDriveArtifact,
} from '../aoiBrowserDriveAuditObserver';
import type { AoiBrowserDriveActablePage } from '../aoiBrowserDriveExecutor';

const tempRoots: string[] = [];
afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function capturablePage(
  overrides: Partial<AoiBrowserDriveActablePage> = {},
): AoiBrowserDriveActablePage {
  return {
    screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
    content: vi.fn(async () => '<html><body>ok</body></html>'),
    ...overrides,
  } as unknown as AoiBrowserDriveActablePage;
}

describe('makeAoiBrowserDriveAuditObserver', () => {
  it('captures screenshot + DOM and returns refs per phase', async () => {
    const writes: Array<{ path: string; kind: string }> = [];
    const observer = makeAoiBrowserDriveAuditObserver({
      page: capturablePage(),
      runId: 'run-1',
      writeArtifact: (relPath, data) => {
        writes.push({ path: relPath, kind: typeof data === 'string' ? 'text' : 'bytes' });
      },
    });
    const before = await observer.onStep!({
      stepIndex: 2,
      phase: 'before',
      action: { kind: 'click', selector: '#go' },
      url: 'https://example.com',
    });
    expect(before).toEqual({
      screenshotRef: 'run-1/step-2-before.png',
      domRef: 'run-1/step-2-before.html',
    });
    expect(writes).toEqual([
      { path: 'run-1/step-2-before.png', kind: 'bytes' },
      { path: 'run-1/step-2-before.html', kind: 'text' },
    ]);
  });

  it('sanitizes a hostile runId into a safe path segment', async () => {
    const writes: string[] = [];
    const observer = makeAoiBrowserDriveAuditObserver({
      page: capturablePage(),
      runId: '../../etc/passwd',
      writeArtifact: (relPath) => {
        writes.push(relPath);
      },
    });
    await observer.onStep!({ stepIndex: 0, phase: 'after', action: { kind: 'click' }, url: '' });
    expect(writes[0]).not.toContain('..');
    expect(writes[0]).toMatch(/^_+etc_passwd\/step-0-after\.png$/);
  });

  it('is best-effort: a screenshot failure still yields the DOM ref, no throw', async () => {
    const observer = makeAoiBrowserDriveAuditObserver({
      page: capturablePage({
        screenshot: vi.fn(async () => {
          throw new Error('surface lost');
        }),
      }),
      runId: 'run-1',
      writeArtifact: () => {},
    });
    const result = await observer.onStep!({
      stepIndex: 1,
      phase: 'before',
      action: { kind: 'click' },
      url: '',
    });
    expect(result).toEqual({ domRef: 'run-1/step-1-before.html' });
  });

  it('returns undefined when nothing could be captured', async () => {
    const observer = makeAoiBrowserDriveAuditObserver({
      page: capturablePage({
        screenshot: vi.fn(async () => {
          throw new Error('x');
        }),
        content: vi.fn(async () => {
          throw new Error('y');
        }),
      }),
      runId: 'r',
      writeArtifact: () => {},
    });
    const result = await observer.onStep!({
      stepIndex: 0,
      phase: 'after',
      action: { kind: 'click' },
      url: '',
    });
    expect(result).toBeUndefined();
  });
});

describe('writeAoiBrowserDriveArtifact (fs containment)', () => {
  function makeHome(): string {
    const home = fs.mkdtempSync(join(os.tmpdir(), 'aoi-bd-art-'));
    tempRoots.push(home);
    return home;
  }

  it('writes under the artifact root', () => {
    const home = makeHome();
    writeAoiBrowserDriveArtifact(home, 'run-1/step-0-before.png', new Uint8Array([9]));
    const target = join(resolveAoiBrowserDriveArtifactDir(home), 'run-1', 'step-0-before.png');
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target)[0]).toBe(9);
  });

  it('refuses to escape the artifact root', () => {
    const home = makeHome();
    writeAoiBrowserDriveArtifact(home, '../../escape.txt', 'nope');
    expect(fs.existsSync(join(home, 'escape.txt'))).toBe(false);
  });
});
