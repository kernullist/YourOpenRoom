// @vitest-environment node
//
// What can honestly be done about an IDA window the operator cannot see.
//
// Measured on a real desktop from a background process, which is what the dev
// server is:
//   SetForegroundWindow    -> false, window not raised
//   SetWindowPos(HWND_TOP) -> returns true, z-order unchanged
//   FlashWindowEx          -> true
// So this module flashes and locates. It must never claim to have raised or
// focused anything, because the OS refuses both.
import { describe, expect, it } from 'vitest';

import {
  describeIdaWindow,
  describeIdaWindowForOperator,
  forgetIdaWindows,
  parseIdaWindowHint,
  recallIdaWindow,
} from '../idaSqlWindowHint';

function fakeSpawn(stdout: string, exitCode: number | null = 0) {
  return (_program: string, _args: readonly string[], _env: Readonly<Record<string, string>>) => ({
    onStdout(listener: (chunk: string) => void): void {
      setTimeout(() => listener(stdout), 0);
    },
    onExit(listener: (code: number | null) => void): void {
      setTimeout(() => listener(exitCode), 5);
    },
    kill(): void {},
  });
}

describe('parseIdaWindowHint', () => {
  it('reads the helper output', () => {
    const hint = parseIdaWindowHint(
      '{"found":true,"flashed":true,"left":3594,"top":667,"width":492,"height":136,"title":"Please confirm","offPrimaryMonitor":true}',
    );
    expect(hint.found).toBe(true);
    expect(hint.flashed).toBe(true);
    expect(hint.left).toBe(3594);
    expect(hint.offPrimaryMonitor).toBe(true);
    expect(hint.title).toBe('Please confirm');
  });

  it('treats every unusable output as simply no hint', () => {
    for (const raw of ['', '   ', 'not json', '{}', '{"found":false}', '[]', 'null']) {
      expect(parseIdaWindowHint(raw).found, raw).toBe(false);
    }
  });

  it('does not let a non-numeric coordinate through as NaN', () => {
    const hint = parseIdaWindowHint('{"found":true,"left":"x","top":null,"width":{}}');
    expect(hint.left).toBe(0);
    expect(hint.top).toBe(0);
    expect(hint.width).toBe(0);
  });

  it('bounds a title, which comes from another process', () => {
    const hint = parseIdaWindowHint(
      `{"found":true,"title":"${'t'.repeat(500)}"}`.replace(/\n/g, ''),
    );
    expect(hint.title.length).toBeLessThanOrEqual(120);
  });
});

describe('describeIdaWindow', () => {
  it('refuses a pid that is not one', async () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      const hint = await describeIdaWindow(pid, fakeSpawn('{"found":true}'));
      expect(hint.found, String(pid)).toBe(false);
      expect(hint.reason).toBe('no_pid');
    }
  });

  it('returns an empty hint rather than throwing when the helper cannot start', async () => {
    const hint = await describeIdaWindow(1234, () => {
      throw new Error('no powershell');
    });
    expect(hint.found).toBe(false);
    expect(hint.reason).toBe('spawn_failed');
  });

  it('gives up instead of hanging a GUI launch', async () => {
    // A cosmetic hint must never hold the route open.
    const hint = await describeIdaWindow(1234, () => ({
      onStdout(): void {},
      onExit(): void {},
      kill(): void {},
    }));
    expect(hint.found).toBe(false);
    expect(hint.reason).toBe('timeout');
  }, 15_000);

  it('parses a successful helper run', async () => {
    const hint = await describeIdaWindow(
      1234,
      fakeSpawn('{"found":true,"flashed":true,"left":10,"top":20,"width":800,"height":600}'),
    );
    expect(hint.found).toBe(true);
    expect(hint.flashed).toBe(true);
  });
});

describe('describeIdaWindowForOperator', () => {
  it('never claims the window was raised or focused', () => {
    const text = describeIdaWindowForOperator(
      parseIdaWindowHint('{"found":true,"flashed":true,"left":10,"top":20}'),
    );
    for (const forbidden of ['brought to the front', 'focused it', 'raised it', 'activated']) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
    // ...and says plainly why not.
    expect(text).toContain('does not let a background launcher take the foreground');
  });

  it('names the other monitor, which is the whole answer sometimes', () => {
    const text = describeIdaWindowForOperator(
      parseIdaWindowHint(
        '{"found":true,"flashed":true,"left":3594,"top":667,"offPrimaryMonitor":true}',
      ),
    );
    expect(text).toContain('another monitor');
    expect(text).toContain('3594,667');
  });

  it('does not say a flash happened when it did not', () => {
    const text = describeIdaWindowForOperator(
      parseIdaWindowHint('{"found":true,"flashed":false,"left":1,"top":2}'),
    );
    expect(text).not.toContain('flashing');
    expect(text).toContain('window is open');
  });

  it('explains a window that has not appeared yet', () => {
    expect(describeIdaWindowForOperator(parseIdaWindowHint('{"found":false}'))).toContain(
      'has not drawn its window yet',
    );
  });

  it('says nothing at all when there is nothing to say', () => {
    // A failure of the helper itself is not the operator's problem to read about.
    expect(describeIdaWindowForOperator(parseIdaWindowHint(''))).toBe('');
  });
});

describe('against a real window on this machine', () => {
  it('finds it, flashes it, and reports its position', async () => {
    if (process.platform !== 'win32') {
      return;
    }
    const { spawn } = await import('child_process');
    const child = spawn('C:\\Windows\\System32\\charmap.exe', [], {
      shell: false,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    await new Promise((done) => setTimeout(done, 2500));
    try {
      const hint = await describeIdaWindow(child.pid ?? 0);
      expect(hint.found).toBe(true);
      expect(hint.flashed).toBe(true);
      expect(hint.width).toBeGreaterThan(0);
      // The title round-trips as UTF-8. It arrived as mojibake until the helper
      // was told to stop writing in the console's ANSI codepage, and IDA's title
      // carries the binary path.
      expect(hint.title).not.toContain('\uFFFD');
    } finally {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
  }, 40_000);
});

describe('the pid channel', () => {
  it('travels in the child environment, not through the shared process env', async () => {
    // process.env is shared: two GUI launches at once would overwrite each
    // other's pid, and the variable would outlive the call.
    const seen: Record<string, string>[] = [];
    const before = process.env.IDA_HINT_PID;
    await describeIdaWindow(4242, (_program, _args, env) => {
      seen.push({ ...env });
      return {
        onStdout(listener: (chunk: string) => void): void {
          setTimeout(() => listener('{"found":true,"left":1,"top":2}'), 0);
        },
        onExit(listener: (code: number | null) => void): void {
          setTimeout(() => listener(0), 5);
        },
        kill(): void {},
      };
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].IDA_HINT_PID).toBe('4242');
    expect(process.env.IDA_HINT_PID).toBe(before);
  });
});

describe('remembering a hint', () => {
  it('lets a later read get the result without measuring again', async () => {
    forgetIdaWindows();
    expect(recallIdaWindow(777)).toBeNull();
    await describeIdaWindow(777, fakeSpawn('{"found":true,"flashed":true,"left":9,"top":9}'));
    // This is what the /gui-window route serves: the launch fires one
    // measurement and does not wait for it, so the UI reads the remembered one.
    expect(recallIdaWindow(777)?.found).toBe(true);
    expect(recallIdaWindow(778)).toBeNull();
  });

  it('remembers a failure too, so the UI stops asking', async () => {
    forgetIdaWindows();
    await describeIdaWindow(778, fakeSpawn('{"found":false}'));
    expect(recallIdaWindow(778)).not.toBeNull();
    expect(recallIdaWindow(778)?.found).toBe(false);
  });

  it('does not grow without bound', async () => {
    forgetIdaWindows();
    for (let pid = 1; pid <= 20; pid += 1) {
      await describeIdaWindow(pid, fakeSpawn('{"found":true,"left":1,"top":1}'));
    }
    // Oldest evicted, newest kept.
    expect(recallIdaWindow(1)).toBeNull();
    expect(recallIdaWindow(20)).not.toBeNull();
    forgetIdaWindows();
  });
});
