import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../appRegistry', () => ({
  APP_REGISTRY: [
    { appId: 16, appName: 'notes', displayName: 'Notes', route: '/notes' },
    { appId: 19, appName: 'openvscode', displayName: "Aoi's IDE", route: '/ide' },
  ],
}));

vi.mock('../windowManager', () => ({
  getWindows: vi.fn(),
}));

vi.mock('../diskStorage', () => ({
  getFile: vi.fn(),
}));

vi.mock('../configPersistence', () => ({
  loadPersistedConfig: vi.fn(),
}));

import * as diskStorage from '../diskStorage';
import * as configPersistence from '../configPersistence';
import { getWindows } from '../windowManager';
import { executeAppStateTool } from '../appStateTools';

const mockedGetWindows = vi.mocked(getWindows);
const mockedGetFile = vi.mocked(diskStorage.getFile);
const mockedLoadPersistedConfig = vi.mocked(configPersistence.loadPersistedConfig);

describe('executeAppStateTool()', () => {
  beforeEach(() => {
    mockedGetWindows.mockReset();
    mockedGetFile.mockReset();
    mockedLoadPersistedConfig.mockReset();
  });

  it('returns a global open-window overview when no app_name is provided', async () => {
    mockedGetWindows.mockReturnValue([
      {
        appId: 16,
        title: 'Notes',
        x: 10,
        y: 20,
        width: 500,
        height: 400,
        zIndex: 120,
        minimized: false,
      },
    ]);

    const result = await executeAppStateTool({});
    const parsed = JSON.parse(result) as {
      open_window_count: number;
      active_app_name: string | null;
      windows: Array<{ app_name: string }>;
    };

    expect(parsed.open_window_count).toBe(1);
    expect(parsed.active_app_name).toBe('notes');
    expect(parsed.windows[0].app_name).toBe('notes');
  });

  it('returns app window data, state.json, and workspace config for openvscode', async () => {
    mockedGetWindows.mockReturnValue([
      {
        appId: 19,
        title: "Aoi's IDE",
        x: 0,
        y: 0,
        width: 1000,
        height: 700,
        zIndex: 140,
        minimized: false,
      },
    ]);
    mockedGetFile.mockResolvedValue({ selectedFile: 'README.md' });
    mockedLoadPersistedConfig.mockResolvedValue({
      openvscode: {
        workspacePath: 'F:/kernullist/YourOpenRoom',
        host: '127.0.0.1',
        port: 3001,
      },
    });

    const result = await executeAppStateTool({ app_name: 'openvscode' });
    const parsed = JSON.parse(result) as {
      app: { app_name: string };
      state: { selectedFile: string } | null;
      workspace: { workspace_path: string | null; port: number | null } | null;
    };

    expect(parsed.app.app_name).toBe('openvscode');
    expect(parsed.state).toEqual({ selectedFile: 'README.md' });
    expect(parsed.workspace).toEqual({
      workspace_path: 'F:/kernullist/YourOpenRoom',
      base_url: null,
      host: '127.0.0.1',
      port: 3001,
    });
  });
});
