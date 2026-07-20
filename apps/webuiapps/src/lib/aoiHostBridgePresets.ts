// Operator-facing host-bridge presets: one-click consent for common user
// folders and program directories. Capability kill-switch + per-action
// approval still gate real effects; these only reduce registration friction.
//
// Browser-safe: never reference the bare Node `process` identifier (Settings
// UI runs in the browser; that throws ReferenceError: process is not defined).

export interface AoiHostPathPreset {
  id: string;
  label: string;
  path: string;
  kind: 'file' | 'directory' | 'root';
}

export type AoiHostPresetPlatform = 'win32' | 'posix';

type ProcessLike = {
  env?: Record<string, string | undefined>;
  platform?: string;
};

function getProcessLike(): ProcessLike | null {
  const candidate = (globalThis as { process?: ProcessLike }).process;
  return candidate && typeof candidate === 'object' ? candidate : null;
}

function readProcessEnv(): Record<string, string | undefined> {
  const env = getProcessLike()?.env;
  return env && typeof env === 'object' ? env : {};
}

function readProcessPlatform(): AoiHostPresetPlatform | null {
  const platform = getProcessLike()?.platform;
  if (typeof platform !== 'string' || !platform) {
    return null;
  }
  return platform === 'win32' ? 'win32' : 'posix';
}

function readBrowserPlatform(): AoiHostPresetPlatform | null {
  if (typeof navigator === 'undefined') {
    return null;
  }
  const signal = `${navigator.platform || ''} ${navigator.userAgent || ''}`;
  if (/Win/i.test(signal)) {
    return 'win32';
  }
  if (signal.trim()) {
    return 'posix';
  }
  return null;
}

export function resolveAoiHostPresetPlatform(
  platform?: AoiHostPresetPlatform | string,
): AoiHostPresetPlatform {
  if (platform === 'win32' || platform === 'posix') {
    return platform;
  }
  return readProcessPlatform() ?? readBrowserPlatform() ?? 'posix';
}

function joinUserPath(home: string, ...parts: string[]): string {
  const sep = home.includes('\\') ? '\\' : '/';
  return [home.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

export function listAoiHostReadRootPresets(
  env: Record<string, string | undefined> = readProcessEnv(),
): AoiHostPathPreset[] {
  const home = env.USERPROFILE || env.HOME || '';
  if (!home) {
    return [];
  }
  return [
    { id: 'root-user-home', label: 'User profile', path: home, kind: 'root' },
    {
      id: 'root-documents',
      label: 'Documents',
      path: joinUserPath(home, 'Documents'),
      kind: 'root',
    },
    { id: 'root-desktop', label: 'Desktop', path: joinUserPath(home, 'Desktop'), kind: 'root' },
    {
      id: 'root-downloads',
      label: 'Downloads',
      path: joinUserPath(home, 'Downloads'),
      kind: 'root',
    },
  ];
}

export function listAoiHostSpawnPresets(
  env: Record<string, string | undefined> = readProcessEnv(),
  platform?: AoiHostPresetPlatform | string,
): AoiHostPathPreset[] {
  const home = env.USERPROFILE || env.HOME || '';
  const presets: AoiHostPathPreset[] = [];
  const resolved = resolveAoiHostPresetPlatform(platform);

  if (resolved === 'win32') {
    presets.push(
      {
        id: 'exe-notepad',
        label: 'Notepad',
        path: 'C:\\Windows\\System32\\notepad.exe',
        kind: 'file',
      },
      {
        id: 'exe-calc',
        label: 'Calculator',
        path: 'C:\\Windows\\System32\\calc.exe',
        kind: 'file',
      },
      {
        id: 'dir-program-files',
        label: 'Program Files (any nested .exe)',
        path: 'C:\\Program Files',
        kind: 'directory',
      },
      {
        id: 'dir-program-files-x86',
        label: 'Program Files (x86) (any nested .exe)',
        path: 'C:\\Program Files (x86)',
        kind: 'directory',
      },
    );
    if (home) {
      presets.push({
        id: 'dir-local-programs',
        label: 'LocalAppData Programs (any nested .exe)',
        path: joinUserPath(home, 'AppData', 'Local', 'Programs'),
        kind: 'directory',
      });
    }
  } else if (home) {
    presets.push(
      { id: 'dir-usr-bin', label: '/usr/bin', path: '/usr/bin', kind: 'directory' },
      {
        id: 'dir-usr-local-bin',
        label: '/usr/local/bin',
        path: '/usr/local/bin',
        kind: 'directory',
      },
    );
  }
  return presets;
}
