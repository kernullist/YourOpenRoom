import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import {
  mapAoiDesktopInputActReply,
  parseAoiDesktopInputRequest,
  resolveAoiDesktopInputHelperPath,
  runAoiDesktopInput,
  type AoiDesktopInputSpawn,
} from './aoiDesktopInput';

// The helper resolves by statSync, so point the tests at a file that exists.
const REAL_FILE = __filename;

function spawnReturning(stdout: string): { spawn: AoiDesktopInputSpawn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: AoiDesktopInputSpawn = (_helper, args, stdin) => {
    calls.push([...args, stdin]);
    return { status: 0, stdout, stderr: '' };
  };
  return { spawn, calls };
}

function run(body: Record<string, unknown>, stdout: string, foregroundAllowed = false) {
  const request = parseAoiDesktopInputRequest(body);
  expect(request).not.toBeNull();
  const { spawn, calls } = spawnReturning(stdout);
  const result = runAoiDesktopInput({
    request: request!,
    openroomHome: 'C:/openroom',
    foregroundAllowed,
    spawnImpl: spawn,
    env: { AOI_DESKTOP_INPUT_HELPER: REAL_FILE },
  });
  return { result, calls };
}

describe('parseAoiDesktopInputRequest', () => {
  it('accepts a well-formed act', () => {
    expect(
      parseAoiDesktopInputRequest({
        op: 'invoke',
        hwnd: '0x1a2b',
        ref: 3,
        snapshotId: 'dis-0a1b2c3d',
      }),
    ).toEqual({
      op: 'invoke',
      hwnd: '0x1a2b',
      ref: 3,
      snapshotId: 'dis-0a1b2c3d',
      delivery: 'auto',
      allowForeground: false,
    });
  });

  it('accepts every op it claims to support', () => {
    // A missed op falls through to another branch's required fields and gets
    // rejected for lacking them -- which is how `invoke` was briefly demanding
    // a drag destination. One case per op is cheap insurance.
    const base = { hwnd: '0x1a2b', ref: 3, snapshotId: 'dis-0a1b2c3d' };
    const cases: Record<string, unknown>[] = [
      { op: 'list_windows' },
      { op: 'list_apps' },
      { op: 'snapshot', hwnd: base.hwnd },
      { op: 'focus', hwnd: base.hwnd },
      { op: 'key', hwnd: base.hwnd, keys: 'ctrl+s' },
      { op: 'type', hwnd: base.hwnd, text: 'hi' },
      { ...base, op: 'invoke' },
      { ...base, op: 'set_value', value: 'x' },
      { ...base, op: 'click' },
      { ...base, op: 'scroll', direction: 'down' },
      { ...base, op: 'drag', toRef: 4 },
    ];
    for (const input of cases) {
      expect(parseAoiDesktopInputRequest(input), String(input.op)).not.toBeNull();
    }
  });

  it('accepts a coordinate click for windows that describe nothing', () => {
    // Without this, a window whose snapshot returns no_automation_tree is
    // simply unreachable -- there is no ref to give.
    const request = parseAoiDesktopInputRequest({ op: 'click', hwnd: '0x1', x: 40, y: 12 });
    expect(request).toMatchObject({ op: 'click', x: 40, y: 12 });
    // And no snapshot id is demanded, because there is no snapshot involved.
    expect(request?.snapshotId).toBeUndefined();
  });

  it('refuses a coordinate that is not a sane window position', () => {
    expect(parseAoiDesktopInputRequest({ op: 'click', hwnd: '0x1', x: -5, y: 10 })).toBeNull();
    expect(parseAoiDesktopInputRequest({ op: 'click', hwnd: '0x1', x: 1.5, y: 10 })).toBeNull();
    expect(parseAoiDesktopInputRequest({ op: 'click', hwnd: '0x1', x: 999999, y: 10 })).toBeNull();
  });

  it('still demands a ref when no coordinate was given', () => {
    // The fallback must not become the default path.
    expect(parseAoiDesktopInputRequest({ op: 'click', hwnd: '0x1' })).toBeNull();
  });

  it('refuses input that names no target', () => {
    expect(parseAoiDesktopInputRequest({ op: 'key', hwnd: '0x1' })).toBeNull();
    expect(parseAoiDesktopInputRequest({ op: 'type', hwnd: '0x1', text: '' })).toBeNull();
    expect(
      parseAoiDesktopInputRequest({
        op: 'scroll',
        hwnd: '0x1',
        ref: 1,
        snapshotId: 'dis-00000000',
      }),
    ).toBeNull();
    expect(
      parseAoiDesktopInputRequest({ op: 'drag', hwnd: '0x1', ref: 1, snapshotId: 'dis-00000000' }),
    ).toBeNull();
  });

  it('refuses out-of-range click counts and scroll amounts', () => {
    // These become real input. An unchecked number turns one action into a
    // flood of them.
    const base = { hwnd: '0x1', ref: 1, snapshotId: 'dis-00000000' };
    expect(parseAoiDesktopInputRequest({ ...base, op: 'click', clicks: 99 })).toBeNull();
    expect(parseAoiDesktopInputRequest({ ...base, op: 'click', clicks: 0 })).toBeNull();
    expect(
      parseAoiDesktopInputRequest({ ...base, op: 'scroll', direction: 'down', amount: 5000 }),
    ).toBeNull();
  });

  it('refuses a rung it does not know instead of quietly using auto', () => {
    // Naming a rung is a request for something specific. Downgrading it
    // silently could route input through a more invasive path than was asked
    // for -- or a less capable one, reported as if it were the same thing.
    expect(
      parseAoiDesktopInputRequest({
        op: 'invoke',
        hwnd: '0x1',
        ref: 1,
        snapshotId: 'dis-00000000',
        delivery: 'telepathy',
      }),
    ).toBeNull();
  });

  it('refuses an unknown mouse button rather than falling back to left', () => {
    expect(
      parseAoiDesktopInputRequest({
        op: 'click',
        hwnd: '0x1',
        ref: 1,
        snapshotId: 'dis-00000000',
        button: 'thumb',
      }),
    ).toBeNull();
  });

  it('normalizes a modifier array into the wire form', () => {
    const request = parseAoiDesktopInputRequest({
      op: 'click',
      hwnd: '0x1',
      ref: 1,
      snapshotId: 'dis-00000000',
      modifiers: ['ctrl', 'shift'],
    });
    expect(request?.modifiers).toBe('ctrl+shift');
  });

  it('refuses an act with no snapshot id', () => {
    // A ref only means something paired with the snapshot that minted it. A
    // request that cannot possibly be resolved should not reach the spawn
    // boundary at all.
    expect(parseAoiDesktopInputRequest({ op: 'invoke', hwnd: '0x1a2b', ref: 3 })).toBeNull();
  });

  it('refuses a malformed window handle', () => {
    expect(
      parseAoiDesktopInputRequest({
        op: 'snapshot',
        hwnd: '0x1a2b; shutdown /s',
      }),
    ).toBeNull();
    expect(parseAoiDesktopInputRequest({ op: 'snapshot', hwnd: 'MAIN' })).toBeNull();
  });

  it('refuses an unknown op', () => {
    expect(parseAoiDesktopInputRequest({ op: 'drag', hwnd: '0x1' })).toBeNull();
    expect(parseAoiDesktopInputRequest({})).toBeNull();
  });

  it('refuses a set_value with no string value', () => {
    expect(
      parseAoiDesktopInputRequest({
        op: 'set_value',
        hwnd: '0x1',
        ref: 1,
        snapshotId: 'dis-00000000',
      }),
    ).toBeNull();
  });
});

describe('mapAoiDesktopInputActReply', () => {
  it('keeps a proven write proven', () => {
    const result = mapAoiDesktopInputActReply({
      ok: true,
      effect: 'confirmed',
      verified: true,
      path: 'uia_value',
      detail: 'value read back and matches',
    });
    expect(result.ok).toBe(true);
    expect(result.verdict.effect).toBe('confirmed');
    expect(result.verdict.verified).toBe(true);
    expect(result.path).toBe('uia_value');
  });

  it('does not promote transport success into a claimed effect', () => {
    // The whole point of the contract: ok says the call ran, nothing more.
    const result = mapAoiDesktopInputActReply({
      ok: true,
      effect: 'unverifiable',
      verified: false,
      path: 'sendinput',
    });
    expect(result.ok).toBe(true);
    expect(result.verdict.effect).toBe('unverifiable');
    expect(result.verdict.verified).toBe(false);
  });

  it('treats a reply with no usable verdict as unproven', () => {
    // A helper that is older, wedged, or lying must not be able to produce a
    // completion claim by omitting the field that would have contradicted it.
    const result = mapAoiDesktopInputActReply({ ok: true, detail: 'done!' });
    expect(result.ok).toBe(false);
    expect(result.verdict.effect).toBe('unverifiable');
    expect(result.verdict.verified).toBe(false);
  });

  it('refuses a verified flag that is not literally true', () => {
    const result = mapAoiDesktopInputActReply({
      ok: true,
      effect: 'confirmed',
      verified: 'yes',
    });
    expect(result.verdict.verified).toBe(false);
  });

  it('names no path for a refusal, because no rung ran', () => {
    const result = mapAoiDesktopInputActReply({
      ok: false,
      effect: 'suspected_noop',
      verified: false,
      code: 'foreground_denied',
      detail: 'Windows refused to bring the window forward',
    });
    expect(result.path).toBeUndefined();
    expect(result.verdict.code).toBe('foreground_denied');
  });
});

describe('runAoiDesktopInput', () => {
  it('reports a missing helper instead of failing to spawn', () => {
    const result = runAoiDesktopInput({
      request: { op: 'list_windows' },
      openroomHome: 'C:/openroom',
      foregroundAllowed: false,
      spawnImpl: () => {
        throw new Error('should not spawn');
      },
      env: { AOI_DESKTOP_INPUT_HELPER: 'C:/nope/aoi_desktop_input.exe' },
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') {
      return;
    }
    expect(result.code).toBe('helper_not_installed');
    // Computer use is on by default, so installing the helper is the one setup
    // step left -- and this message is the only place anyone learns that.
    expect(result.detail).toContain('Install-AoiDesktopInput.ps1');
  });

  it('passes the command on stdin, never on the command line', () => {
    // A typed value on argv is readable by every other process on the machine.
    const { calls } = run(
      {
        op: 'set_value',
        hwnd: '0x1',
        ref: 2,
        snapshotId: 'dis-00000000',
        value: 'private note',
      },
      '{"ok":true,"effect":"confirmed","verified":true,"path":"uia_value"}',
    );
    const [args] = calls;
    const stdin = args[args.length - 1];
    expect(args.slice(0, -1)).toEqual(['--stdin']);
    expect(args.slice(0, -1).join(' ')).not.toContain('private note');
    expect(JSON.parse(stdin)).toMatchObject({ op: 'set_value', value: 'private note' });
  });

  it('does not grant the SendInput rung just because it was asked for', () => {
    // The request may ask; only the separate capability decides.
    const { calls } = run(
      {
        op: 'invoke',
        hwnd: '0x1',
        ref: 2,
        snapshotId: 'dis-00000000',
        allowForeground: true,
      },
      '{"ok":true,"effect":"confirmed","verified":false,"path":"uia_invoke"}',
      false,
    );
    expect(calls[0]).not.toContain('--allow-foreground');
  });

  it('grants the SendInput rung when the capability is on and it was asked for', () => {
    const { calls } = run(
      {
        op: 'invoke',
        hwnd: '0x1',
        ref: 2,
        snapshotId: 'dis-00000000',
        allowForeground: true,
      },
      '{"ok":true,"effect":"unverifiable","verified":false,"path":"sendinput"}',
      true,
    );
    expect(calls[0]).toContain('--allow-foreground');
  });

  it('never passes the rung flag when it was not asked for', () => {
    const { calls } = run(
      { op: 'invoke', hwnd: '0x1', ref: 2, snapshotId: 'dis-00000000' },
      '{"ok":true,"effect":"confirmed","verified":false,"path":"uia_invoke"}',
      true,
    );
    expect(calls[0]).not.toContain('--allow-foreground');
  });

  it('marks an element sensitive when the helper does not say otherwise', () => {
    // Fail-closed: "should Aoi touch this" defaults to no.
    const { result } = run(
      { op: 'snapshot', hwnd: '0x1' },
      JSON.stringify({
        ok: true,
        snapshotId: 'dis-00000000',
        note: 'ok',
        elements: [
          { ref: 1, role: 'button', name: 'Go', automationId: '', enabled: true },
          {
            ref: 2,
            role: 'textbox',
            name: 'Note',
            automationId: '',
            enabled: true,
            sensitive: false,
          },
        ],
      }),
    );
    expect(result.kind).toBe('snapshot');
    if (result.kind !== 'snapshot') {
      return;
    }
    expect(result.snapshot.elements[0].sensitive).toBe(true);
    expect(result.snapshot.elements[1].sensitive).toBe(false);
  });

  it('keeps the note that separates an empty window from a silent one', () => {
    const { result } = run(
      { op: 'snapshot', hwnd: '0x1' },
      JSON.stringify({
        ok: true,
        snapshotId: 'dis-00000000',
        note: 'no_automation_tree',
        elements: [],
      }),
    );
    expect(result.kind).toBe('snapshot');
    if (result.kind !== 'snapshot') {
      return;
    }
    expect(result.snapshot.note).toBe('no_automation_tree');
  });

  it('reports a helper that says nothing rather than inventing a result', () => {
    const request = parseAoiDesktopInputRequest({ op: 'list_windows' });
    const result = runAoiDesktopInput({
      request: request!,
      openroomHome: 'C:/openroom',
      foregroundAllowed: false,
      spawnImpl: () => ({ status: 1, stdout: '', stderr: 'access denied' }),
      env: { AOI_DESKTOP_INPUT_HELPER: REAL_FILE },
    });
    expect(result).toEqual({
      kind: 'error',
      code: 'helper_no_reply',
      detail: 'access denied',
    });
  });

  it('drops windows whose handle it cannot trust', () => {
    const { result } = run(
      { op: 'list_windows' },
      JSON.stringify({
        ok: true,
        windows: [
          { hwnd: '0x1', title: 'Real', process: 'a.exe' },
          { hwnd: 'not-a-handle', title: 'Bogus', process: 'b.exe' },
        ],
      }),
    );
    expect(result.kind).toBe('windows');
    if (result.kind !== 'windows') {
      return;
    }
    expect(result.windows).toEqual([{ hwnd: '0x1', title: 'Real', process: 'a.exe' }]);
  });
});

describe('resolveAoiDesktopInputHelperPath', () => {
  it('prefers an explicit override', () => {
    expect(
      resolveAoiDesktopInputHelperPath('C:/openroom', {
        AOI_DESKTOP_INPUT_HELPER: REAL_FILE,
      }),
    ).toBe(REAL_FILE);
  });

  it('returns null when nothing is installed', () => {
    expect(resolveAoiDesktopInputHelperPath('C:/definitely/not/here', {})).toBeNull();
  });

  it('falls back to the host-bridge copy when it exists', () => {
    // Use this file's own directory as a stand-in "openroom home".
    const home = resolve(__dirname, '..', '..');
    const expected = resolve(home, 'host-bridge', 'aoi_desktop_input.exe');
    const found = resolveAoiDesktopInputHelperPath(home, {});
    expect(found).toBe(fs.existsSync(expected) ? expected : null);
  });
});

function resolve(...parts: string[]): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require('path') as typeof import('path')).resolve(...parts);
}
