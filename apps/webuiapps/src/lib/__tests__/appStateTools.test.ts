import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../appRegistry', () => {
  const apps = [
    { appId: 16, appName: 'notes', displayName: 'Notes', route: '/notes', actions: [] },
    { appId: 18, appName: 'kira', displayName: 'Kira', route: '/kira', actions: [] },
    {
      appId: 19,
      appName: 'openvscode',
      displayName: "Aoi's IDE",
      route: '/ide',
      actions: [{ name: 'APPEND_ACTIVE_FILE', description: 'Append active file', params: [] }],
    },
    {
      appId: 20,
      appName: 'peanalyzer',
      displayName: 'PE Analyst',
      route: '/peanalyzer',
      actions: [],
    },
    { appId: 21, appName: 'roomshop', displayName: 'Room Shop', route: '/roomshop', actions: [] },
    {
      appId: 22,
      appName: 'dewdropcanvas',
      displayName: 'Dewdrop Canvas',
      route: '/dewdrop-canvas',
      actions: [],
    },
    {
      appId: 23,
      appName: 'writtenbyme',
      displayName: 'Written By Me',
      route: '/written-by-me',
      actions: [],
    },
    {
      appId: 24,
      appName: 'aoiresearch',
      displayName: 'Aoi Research',
      route: '/aoi-research',
      actions: [],
    },
    {
      appId: 25,
      appName: 'aoimemory',
      displayName: 'Aoi Memory',
      route: '/aoi-memory',
      actions: [],
    },
  ];
  return {
    APP_REGISTRY: apps,
    getAppIdentityByReference: (appReference: string) => {
      const normalized = appReference.trim().toLowerCase();
      const app = apps.find(
        (entry) =>
          entry.appName.toLowerCase() === normalized ||
          entry.displayName.toLowerCase() === normalized ||
          String(entry.appId) === normalized,
      );
      return app ? { ...app, aliases: [] } : null;
    },
  };
});

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
      capabilities: {
        actions: { names: string[] };
        state: { has_bespoke_summary: boolean };
      };
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
    expect(parsed.capabilities.actions.names).toEqual(['APPEND_ACTIVE_FILE']);
    expect(parsed.capabilities.state.has_bespoke_summary).toBe(true);
  });

  it('returns app control inventory in the global window overview', async () => {
    mockedGetWindows.mockReturnValue([]);

    const result = await executeAppStateTool({});
    const parsed = JSON.parse(result) as {
      app_control_summary: {
        app_count: number;
        apps_with_bespoke_state_summary: number;
      };
    };

    expect(parsed.app_control_summary.app_count).toBe(9);
    expect(parsed.app_control_summary.apps_with_bespoke_state_summary).toBeGreaterThan(0);
  });

  it('accepts display names when resolving app state', async () => {
    mockedGetWindows.mockReturnValue([]);
    mockedGetFile.mockResolvedValue({ selectedNoteId: 'note-1' });

    const result = await executeAppStateTool({ app_name: 'Notes' });
    const parsed = JSON.parse(result) as {
      app: { app_name: string };
      state_summary: { selected_note_id: string };
    };

    expect(parsed.app.app_name).toBe('notes');
    expect(parsed.state_summary.selected_note_id).toBe('note-1');
  });

  it('summarizes Room Shop state and PE Analyst workspace state', async () => {
    mockedGetWindows.mockReturnValue([]);
    mockedGetFile
      .mockResolvedValueOnce({
        activeWallpaperId: 'lofi-cafe-night',
        activeMoodId: 'rainy-window-desk',
        previewItemId: 'sunlit-library',
        liveWallpaper: true,
        updatedAt: 123,
      })
      .mockResolvedValueOnce({
        activeSampleId: 'sample-1',
        activeAnalysisId: 'analysis-1',
        selectedFindingId: 'finding-1',
        selectedFunctionEa: '401000',
        activeView: 'functions',
      });
    mockedListFiles.mockImplementation(async (directory: string) => {
      if (directory.endsWith('/samples')) {
        return { files: [{ path: 'sample-1.json', type: 0 }], not_exists: false };
      }
      if (directory.endsWith('/analyses')) {
        return { files: [{ path: 'analysis-1.json', type: 0 }], not_exists: false };
      }
      return { files: [], not_exists: false };
    });

    const roomShopResult = await executeAppStateTool({ app_name: 'roomshop' });
    const peResult = await executeAppStateTool({ app_name: 'peanalyzer' });
    const roomShopParsed = JSON.parse(roomShopResult) as {
      state_summary: {
        active_wallpaper_id: string;
        active_mood_id: string;
        live_wallpaper: boolean;
      };
    };
    const peParsed = JSON.parse(peResult) as {
      state_summary: {
        active_sample_id: string;
        active_analysis_id: string;
        active_view: string;
        sample_count: number;
        analysis_count: number;
      };
    };

    expect(roomShopParsed.state_summary).toMatchObject({
      active_wallpaper_id: 'lofi-cafe-night',
      active_mood_id: 'rainy-window-desk',
      live_wallpaper: true,
    });
    expect(peParsed.state_summary).toMatchObject({
      active_sample_id: 'sample-1',
      active_analysis_id: 'analysis-1',
      active_view: 'functions',
      sample_count: 1,
      analysis_count: 1,
    });
  });

  it('summarizes Aoi Research and Aoi Memory state', async () => {
    mockedGetWindows.mockReturnValue([]);
    mockedGetFile
      .mockResolvedValueOnce({
        selectedRunId: 'run-1',
        detailTab: 'evidence',
      })
      .mockResolvedValueOnce({
        selectedMemoryId: 'memory-1',
        typeFilter: 'preference',
        trustFilter: 'needs_review',
        query: 'kira',
      });
    mockedListFiles.mockImplementation(async (directory: string) => {
      if (directory.endsWith('/runs')) {
        return { files: [{ path: 'run-1.json', type: 0 }], not_exists: false };
      }
      if (directory.endsWith('/reports')) {
        return { files: [{ path: 'run-1.md', type: 0 }], not_exists: false };
      }
      if (directory.endsWith('/memories')) {
        return { files: [{ path: 'memory-1.json', type: 0 }], not_exists: false };
      }
      return { files: [], not_exists: false };
    });

    const researchResult = await executeAppStateTool({ app_name: 'Aoi Research' });
    const memoryResult = await executeAppStateTool({ app_name: 'Aoi Memory' });
    const researchParsed = JSON.parse(researchResult) as {
      state_summary: {
        selected_run_id: string;
        detail_tab: string;
        run_count: number;
        report_count: number;
      };
    };
    const memoryParsed = JSON.parse(memoryResult) as {
      state_summary: {
        selected_memory_id: string;
        type_filter: string;
        trust_filter: string;
        query: string;
        memory_count: number;
      };
    };

    expect(researchParsed.state_summary).toMatchObject({
      selected_run_id: 'run-1',
      detail_tab: 'evidence',
      run_count: 1,
      report_count: 1,
    });
    expect(memoryParsed.state_summary).toMatchObject({
      selected_memory_id: 'memory-1',
      type_filter: 'preference',
      trust_filter: 'needs_review',
      query: 'kira',
      memory_count: 1,
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
