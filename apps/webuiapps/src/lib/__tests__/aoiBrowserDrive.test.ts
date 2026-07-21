import { describe, expect, it } from 'vitest';
import {
  AOI_BROWSER_DRIVE_CAPABILITY,
  AOI_BROWSER_DRIVE_SOURCE_ID,
  buildAoiBrowserDriveCdpHttpEndpoint,
  buildAoiBrowserDriveCdpWsEndpoint,
  buildAoiBrowserDriveLaunchArgs,
  isAoiBrowserDriveLoopbackHost,
  isAoiBrowserDrivePort,
  parseAoiDevToolsActivePort,
  resolveAoiBrowserDriveAllowOrigin,
  resolveAoiBrowserDriveDefaultUserDataDir,
} from '../aoiBrowserDrive';

describe('browser-drive constants', () => {
  it('exposes the capability + source ids', () => {
    expect(AOI_BROWSER_DRIVE_CAPABILITY).toBe('os_browser_drive');
    expect(AOI_BROWSER_DRIVE_SOURCE_ID).toBe('browser-drive');
  });
});

describe('isAoiBrowserDriveLoopbackHost', () => {
  it('accepts loopback forms only', () => {
    expect(isAoiBrowserDriveLoopbackHost('127.0.0.1')).toBe(true);
    expect(isAoiBrowserDriveLoopbackHost('127.5.6.7')).toBe(true);
    expect(isAoiBrowserDriveLoopbackHost('localhost')).toBe(true);
    expect(isAoiBrowserDriveLoopbackHost('LOCALHOST.')).toBe(true);
    expect(isAoiBrowserDriveLoopbackHost('::1')).toBe(true);
    expect(isAoiBrowserDriveLoopbackHost('[::1]')).toBe(true);
  });

  it('rejects non-loopback / malformed hosts', () => {
    expect(isAoiBrowserDriveLoopbackHost('10.0.0.1')).toBe(false);
    expect(isAoiBrowserDriveLoopbackHost('192.168.1.1')).toBe(false);
    expect(isAoiBrowserDriveLoopbackHost('example.com')).toBe(false);
    expect(isAoiBrowserDriveLoopbackHost('127.0.0.256')).toBe(false);
    expect(isAoiBrowserDriveLoopbackHost('')).toBe(false);
    expect(isAoiBrowserDriveLoopbackHost('   ')).toBe(false);
  });
});

describe('isAoiBrowserDrivePort', () => {
  it('accepts valid ports and rejects the rest', () => {
    expect(isAoiBrowserDrivePort(9222)).toBe(true);
    expect(isAoiBrowserDrivePort(1)).toBe(true);
    expect(isAoiBrowserDrivePort(65_535)).toBe(true);
    expect(isAoiBrowserDrivePort(0)).toBe(false);
    expect(isAoiBrowserDrivePort(65_536)).toBe(false);
    expect(isAoiBrowserDrivePort(9222.5)).toBe(false);
    expect(isAoiBrowserDrivePort('9222')).toBe(false);
    expect(isAoiBrowserDrivePort(Number.NaN)).toBe(false);
  });
});

describe('resolveAoiBrowserDriveAllowOrigin', () => {
  it('pins to the loopback endpoint for the port', () => {
    expect(resolveAoiBrowserDriveAllowOrigin(9222)).toBe('http://127.0.0.1:9222');
  });

  it('throws on an invalid port', () => {
    expect(() => resolveAoiBrowserDriveAllowOrigin(0)).toThrow(/invalid browser-drive debug port/);
  });
});

describe('CDP endpoint builders', () => {
  it('builds the http endpoint', () => {
    expect(buildAoiBrowserDriveCdpHttpEndpoint(9222)).toBe('http://127.0.0.1:9222');
    expect(() => buildAoiBrowserDriveCdpHttpEndpoint(0)).toThrow();
  });

  it('builds the ws endpoint from a valid path', () => {
    expect(buildAoiBrowserDriveCdpWsEndpoint(9222, '/devtools/browser/abc')).toBe(
      'ws://127.0.0.1:9222/devtools/browser/abc',
    );
  });

  it('rejects a bad port or path', () => {
    expect(() => buildAoiBrowserDriveCdpWsEndpoint(0, '/x')).toThrow();
    expect(() => buildAoiBrowserDriveCdpWsEndpoint(9222, 'devtools/no-slash')).toThrow(
      /invalid DevTools ws path/,
    );
  });
});

describe('buildAoiBrowserDriveLaunchArgs', () => {
  it('builds argv with a pinned loopback allow-origin by default', () => {
    const args = buildAoiBrowserDriveLaunchArgs({
      port: 9222,
      userDataDir: 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data',
    });
    expect(args).toContain('--remote-debugging-port=9222');
    expect(args).toContain('--remote-allow-origins=http://127.0.0.1:9222');
    expect(args).toContain(
      '--user-data-dir=C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data',
    );
    expect(args).toContain('--no-first-run');
    expect(args).toContain('--no-default-browser-check');
    // Attaching to the visible browser: not headless unless asked.
    expect(args.some((a) => a.startsWith('--headless'))).toBe(false);
  });

  it('adds headless only when requested', () => {
    const args = buildAoiBrowserDriveLaunchArgs({
      port: 9222,
      userDataDir: '/home/me/.config/google-chrome',
      headless: true,
    });
    expect(args).toContain('--headless=new');
  });

  it('rejects a wildcard allow-origin fail-closed', () => {
    expect(() =>
      buildAoiBrowserDriveLaunchArgs({
        port: 9222,
        userDataDir: '/x',
        allowOrigin: '*',
      }),
    ).toThrow(/allow-origin/);
  });

  it('rejects a non-loopback allow-origin fail-closed', () => {
    expect(() =>
      buildAoiBrowserDriveLaunchArgs({
        port: 9222,
        userDataDir: '/x',
        allowOrigin: 'http://evil.example.com:9222',
      }),
    ).toThrow(/pinned loopback endpoint/);
  });

  it('rejects a bad port and an empty user-data-dir', () => {
    expect(() => buildAoiBrowserDriveLaunchArgs({ port: 0, userDataDir: '/x' })).toThrow();
    expect(() => buildAoiBrowserDriveLaunchArgs({ port: 9222, userDataDir: '   ' })).toThrow(
      /user-data-dir/,
    );
  });

  it('rejects an unparseable allow-origin', () => {
    expect(() =>
      buildAoiBrowserDriveLaunchArgs({ port: 9222, userDataDir: '/x', allowOrigin: 'not a url' }),
    ).toThrow(/invalid browser-drive allow-origin/);
  });
});

describe('parseAoiDevToolsActivePort', () => {
  it('parses the two-line handshake', () => {
    expect(parseAoiDevToolsActivePort('9222\n/devtools/browser/uuid-1')).toEqual({
      port: 9222,
      wsPath: '/devtools/browser/uuid-1',
    });
    // CRLF is tolerated.
    expect(parseAoiDevToolsActivePort('51234\r\n/devtools/browser/x')?.port).toBe(51234);
  });

  it('returns null on malformed content', () => {
    expect(parseAoiDevToolsActivePort('')).toBeNull();
    expect(parseAoiDevToolsActivePort('notaport\n/devtools/browser/x')).toBeNull();
    expect(parseAoiDevToolsActivePort('9222')).toBeNull();
    expect(parseAoiDevToolsActivePort('9222\ndevtools-without-slash')).toBeNull();
    expect(parseAoiDevToolsActivePort('0\n/devtools/browser/x')).toBeNull();
    // Non-string input is guarded.
    expect(parseAoiDevToolsActivePort(undefined as unknown as string)).toBeNull();
  });
});

describe('resolveAoiBrowserDriveDefaultUserDataDir', () => {
  it('resolves Windows Chrome + Edge dirs from LOCALAPPDATA', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
    expect(resolveAoiBrowserDriveDefaultUserDataDir('chrome', env, 'win32')).toBe(
      'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data',
    );
    expect(resolveAoiBrowserDriveDefaultUserDataDir('edge', env, 'win32')).toBe(
      'C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data',
    );
    expect(resolveAoiBrowserDriveDefaultUserDataDir('chrome', {}, 'win32')).toBeNull();
  });

  it('resolves macOS dirs from HOME', () => {
    const env = { HOME: '/Users/me' };
    expect(resolveAoiBrowserDriveDefaultUserDataDir('chrome', env, 'darwin')).toBe(
      '/Users/me/Library/Application Support/Google/Chrome',
    );
    expect(resolveAoiBrowserDriveDefaultUserDataDir('edge', env, 'darwin')).toBe(
      '/Users/me/Library/Application Support/Microsoft Edge',
    );
    expect(resolveAoiBrowserDriveDefaultUserDataDir('chrome', {}, 'darwin')).toBeNull();
  });

  it('resolves Linux dirs from HOME/USERPROFILE', () => {
    expect(resolveAoiBrowserDriveDefaultUserDataDir('chrome', { HOME: '/home/me' }, 'linux')).toBe(
      '/home/me/.config/google-chrome',
    );
    expect(
      resolveAoiBrowserDriveDefaultUserDataDir('edge', { USERPROFILE: '/home/me' }, 'linux'),
    ).toBe('/home/me/.config/microsoft-edge');
    expect(resolveAoiBrowserDriveDefaultUserDataDir('chrome', {}, 'linux')).toBeNull();
  });
});
