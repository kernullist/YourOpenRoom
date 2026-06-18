import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../appRegistry', () => ({
  APP_REGISTRY: [
    { appId: 16, appName: 'notes', displayName: 'Notes', route: '/notes' },
    { appId: 18, appName: 'kira', displayName: 'Kira', route: '/kira' },
    { appId: 19, appName: 'openvscode', displayName: "Aoi's IDE", route: '/ide' },
  ],
}));

vi.mock('../windowManager', () => ({
  getWindows: vi.fn(),
}));

vi.mock('../diskStorage', () => ({
  getFile: vi.fn(),
  listFiles: vi.fn(),
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
const mockedListFiles = vi.mocked(diskStorage.listFiles);
const mockedLoadPersistedConfig = vi.mocked(configPersistence.loadPersistedConfig);

describe('executeAppStateTool()', () => {
  beforeEach(() => {
    mockedGetWindows.mockReset();
    mockedGetFile.mockReset();
    mockedListFiles.mockReset();
    mockedListFiles.mockResolvedValue({ files: [], not_exists: false });
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
    mockedGetFile.mockResolvedValue({
      workspaceRoot: 'F:/kernullist/YourOpenRoom',
      workspaceExists: true,
      workspaceHistory: ['F:/kernullist/YourOpenRoom', 'F:/kernullist/analyze-ue5'],
      activePath: 'README.md',
      activeFile: {
        path: 'README.md',
        name: 'README.md',
        language: 'markdown',
        dirty: true,
        lineCount: 12,
        charCount: 320,
        contentTruncated: false,
        cursor: { line: 3, column: 8 },
        selection: {
          startLine: 3,
          startColumn: 1,
          endLine: 3,
          endColumn: 10,
          lineCount: 1,
          charCount: 9,
          textTruncated: false,
          text: 'selection',
        },
      },
      openTabs: [
        {
          path: 'README.md',
          name: 'README.md',
          language: 'markdown',
          dirty: true,
          lineCount: 12,
          charCount: 320,
        },
      ],
      modelActions: [
        {
          id: 'action-1',
          actionType: 'PATCH_ACTIVE_FILE',
          status: 'success',
          path: 'README.md',
          reversible: true,
          undone: false,
        },
      ],
    });
    mockedLoadPersistedConfig.mockResolvedValue({
      openvscode: {
        workspacePath: 'F:/kernullist/YourOpenRoom',
        workspaceHistory: ['F:/kernullist/YourOpenRoom', 'F:/kernullist/analyze-ue5'],
        host: '127.0.0.1',
        port: 3001,
      },
    });

    const result = await executeAppStateTool({ app_name: 'openvscode' });
    const parsed = JSON.parse(result) as {
      app: { app_name: string };
      state: { activePath: string } | null;
      state_summary: {
        active_path: string;
        active_file: { path: string; dirty: boolean; line_count: number };
        workspace_history: string[];
        open_tab_count: number;
        model_action_count: number;
        recent_model_actions: Array<{ action_type: string; reversible: boolean }>;
      };
      workspace: {
        workspace_path: string | null;
        workspace_history: string[];
        port: number | null;
      } | null;
    };

    expect(parsed.app.app_name).toBe('openvscode');
    expect(parsed.state?.activePath).toBe('README.md');
    expect(parsed.state_summary.active_path).toBe('README.md');
    expect(parsed.state_summary.workspace_history).toEqual([
      'F:/kernullist/YourOpenRoom',
      'F:/kernullist/analyze-ue5',
    ]);
    expect(parsed.state_summary.active_file).toEqual({
      path: 'README.md',
      name: 'README.md',
      language: 'markdown',
      dirty: true,
      cursor: { line: 3, column: 8 },
      line_count: 12,
      char_count: 320,
      content_truncated: false,
      selection: {
        start_line: 3,
        start_column: 1,
        end_line: 3,
        end_column: 10,
        line_count: 1,
        char_count: 9,
        text_truncated: false,
      },
    });
    expect(parsed.state_summary.open_tab_count).toBe(1);
    expect(parsed.state_summary.model_action_count).toBe(1);
    expect(parsed.state_summary.recent_model_actions[0]).toEqual({
      action_type: 'PATCH_ACTIVE_FILE',
      status: 'success',
      path: 'README.md',
      reversible: true,
      undone: false,
    });
    expect(parsed.workspace).toEqual({
      workspace_path: 'F:/kernullist/YourOpenRoom',
      workspace_history: ['F:/kernullist/YourOpenRoom', 'F:/kernullist/analyze-ue5'],
      base_url: null,
      host: '127.0.0.1',
      port: 3001,
    });
  });

  it('returns sanitized Kira model settings in the app state summary', async () => {
    mockedGetWindows.mockReturnValue([
      {
        appId: 18,
        title: 'Kira',
        x: 0,
        y: 0,
        width: 1200,
        height: 760,
        zIndex: 130,
        minimized: false,
      },
    ]);
    mockedGetFile.mockResolvedValue({
      activeProjectName: 'im-tavern-client',
      selectedTaskId: 'task-1',
      previewMode: 'markdown',
    });
    mockedListFiles.mockResolvedValue({ files: [{ path: 'a.json', type: 0 }], not_exists: false });
    mockedLoadPersistedConfig.mockResolvedValue({
      kira: {
        workRootDirectory: 'F:/work',
        workers: [
          {
            provider: 'codex-cli',
            model: 'gpt-5.5',
            reasoningEffort: 'high',
            apiKey: 'secret-worker-key',
          },
        ],
        reviewerLlm: {
          provider: 'codex-cli',
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          apiKey: 'secret-reviewer-key',
        },
        projectDefaults: {
          runMode: 'deep',
          autoCommit: false,
        },
      },
    });

    const result = await executeAppStateTool({ app_name: 'kira' });
    const parsed = JSON.parse(result) as {
      state_summary: {
        active_project_name: string;
        model_settings: {
          workers: Array<{ provider: string; model: string; apiKey?: string }>;
          reviewer: { provider: string; model: string; apiKey?: string };
          project_defaults: { runMode: string; autoCommit: boolean };
        };
      };
    };

    expect(parsed.state_summary.active_project_name).toBe('im-tavern-client');
    expect(parsed.state_summary.model_settings.workers[0]).toEqual({
      name: null,
      provider: 'codex-cli',
      model: 'gpt-5.5',
      reasoning_effort: 'high',
      reasoning_summary: null,
      verbosity: null,
      service_tier: null,
    });
    expect(parsed.state_summary.model_settings.workers[0].apiKey).toBeUndefined();
    expect(parsed.state_summary.model_settings.reviewer.apiKey).toBeUndefined();
    expect(parsed.state_summary.model_settings.project_defaults).toEqual({
      runMode: 'deep',
      autoCommit: false,
    });
  });

  it('summarizes legacy Kira worker/reviewer settings without exposing secrets', async () => {
    mockedGetWindows.mockReturnValue([]);
    mockedGetFile.mockResolvedValue({});
    mockedLoadPersistedConfig.mockResolvedValue({
      kira: {
        workerModel: 'legacy-worker-model',
        workerLlm: {
          provider: 'anthropic',
          reasoningEffort: 'high',
          apiKey: 'secret-worker-key',
          customHeaders: 'x-secret: yes',
        },
        reviewerModel: 'legacy-reviewer-model',
        reviewerLlm: {
          provider: 'codex-cli',
          reasoningEffort: 'xhigh',
          apiKey: 'secret-reviewer-key',
        },
      },
    });

    const result = await executeAppStateTool({ app_name: 'kira' });
    const parsed = JSON.parse(result) as {
      state_summary: {
        model_settings: {
          worker_count: number;
          workers: Array<{
            provider: string;
            model: string;
            apiKey?: string;
            customHeaders?: string;
          }>;
          reviewer: { provider: string; model: string; apiKey?: string };
        };
      };
    };

    expect(parsed.state_summary.model_settings.worker_count).toBe(1);
    expect(parsed.state_summary.model_settings.workers[0]).toEqual({
      name: null,
      provider: 'anthropic',
      model: 'legacy-worker-model',
      reasoning_effort: 'high',
      reasoning_summary: null,
      verbosity: null,
      service_tier: null,
    });
    expect(parsed.state_summary.model_settings.workers[0].apiKey).toBeUndefined();
    expect(parsed.state_summary.model_settings.workers[0].customHeaders).toBeUndefined();
    expect(parsed.state_summary.model_settings.reviewer).toEqual({
      name: null,
      provider: 'codex-cli',
      model: 'legacy-reviewer-model',
      reasoning_effort: 'xhigh',
      reasoning_summary: null,
      verbosity: null,
      service_tier: null,
    });
    expect(parsed.state_summary.model_settings.reviewer.apiKey).toBeUndefined();
  });

  it('includes sanitized base LLM fallback when Kira has no role-specific settings', async () => {
    mockedGetWindows.mockReturnValue([]);
    mockedGetFile.mockResolvedValue({});
    mockedLoadPersistedConfig.mockResolvedValue({
      llm: {
        provider: 'codex-cli',
        model: 'gpt-5.5',
        apiKey: 'secret-base-key',
        baseUrl: '',
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
        verbosity: 'medium',
      },
    });

    const result = await executeAppStateTool({ app_name: 'kira' });
    const parsed = JSON.parse(result) as {
      state_summary: {
        model_settings: {
          worker_count: number;
          workers: Array<{ provider: string; model: string; apiKey?: string }>;
          reviewer: { provider: string; model: string; apiKey?: string };
        };
      };
    };

    expect(parsed.state_summary.model_settings.worker_count).toBe(1);
    expect(parsed.state_summary.model_settings.workers[0]).toEqual({
      name: null,
      provider: 'codex-cli',
      model: 'gpt-5.5',
      reasoning_effort: 'high',
      reasoning_summary: 'auto',
      verbosity: 'medium',
      service_tier: null,
    });
    expect(parsed.state_summary.model_settings.workers[0].apiKey).toBeUndefined();
    expect(parsed.state_summary.model_settings.reviewer).toEqual({
      name: null,
      provider: 'codex-cli',
      model: 'gpt-5.5',
      reasoning_effort: 'high',
      reasoning_summary: 'auto',
      verbosity: 'medium',
      service_tier: null,
    });
    expect(parsed.state_summary.model_settings.reviewer.apiKey).toBeUndefined();
  });
});
