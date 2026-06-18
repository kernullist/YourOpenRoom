import type { ToolDef } from './llmClient';

import * as idb from './diskStorage';
import { APP_REGISTRY } from './appRegistry';
import {
  loadPersistedConfig,
  type KiraConfig,
  type KiraRoleLlmConfig,
  type PersistedConfig,
} from './configPersistence';
import { getWindows } from './windowManager';

const TOOL_NAME = 'get_app_state';

function sanitizeKiraRole(role: KiraRoleLlmConfig | null | undefined) {
  if (!role) {
    return null;
  }

  return {
    name: role.name ?? null,
    provider: role.provider ?? null,
    model: role.model ?? null,
    reasoning_effort: role.reasoningEffort ?? null,
    reasoning_summary: role.reasoningSummary ?? null,
    verbosity: role.verbosity ?? null,
    service_tier: role.serviceTier ?? null,
  };
}

function buildKiraFallbackRole(config: PersistedConfig | null): KiraRoleLlmConfig | null {
  const llm = config?.llm;
  if (!llm?.model?.trim()) {
    return null;
  }

  return {
    provider: llm.provider,
    model: llm.model,
    ...(llm.reasoningEffort ? { reasoningEffort: llm.reasoningEffort } : {}),
    ...(llm.reasoningSummary ? { reasoningSummary: llm.reasoningSummary } : {}),
    ...(llm.verbosity ? { verbosity: llm.verbosity } : {}),
    ...(llm.serviceTier ? { serviceTier: llm.serviceTier } : {}),
  };
}

function resolveKiraStateWorkers(
  kira: KiraConfig | undefined,
  fallbackRole: KiraRoleLlmConfig | null,
): KiraRoleLlmConfig[] {
  if (!kira) {
    return fallbackRole ? [fallbackRole] : [];
  }
  if (Array.isArray(kira.workers) && kira.workers.length > 0) {
    return kira.workers.slice(0, 3);
  }

  const legacyWorker: KiraRoleLlmConfig = {
    ...(kira.workerLlm ?? {}),
    ...(kira.workerModel ? { model: kira.workerModel } : {}),
  };
  return legacyWorker.model || legacyWorker.provider
    ? [{ ...(fallbackRole ?? {}), ...legacyWorker }]
    : fallbackRole
      ? [fallbackRole]
      : [];
}

function resolveKiraStateReviewer(
  kira: KiraConfig | undefined,
  fallbackRole: KiraRoleLlmConfig | null,
): KiraRoleLlmConfig | null {
  if (!kira) {
    return fallbackRole;
  }

  const reviewer: KiraRoleLlmConfig = {
    ...(kira.reviewerLlm ?? {}),
    ...(kira.reviewerModel ? { model: kira.reviewerModel } : {}),
  };
  return reviewer.model || reviewer.provider
    ? { ...(fallbackRole ?? {}), ...reviewer }
    : fallbackRole;
}

async function countFiles(directory: string): Promise<number> {
  const result = await idb.listFiles(directory);
  return result.files.filter((entry) => entry.type === 0).length;
}

async function buildStateSummary(
  appName: string,
  state: unknown,
): Promise<Record<string, unknown> | null> {
  const normalizedState =
    state && typeof state === 'object' && !Array.isArray(state)
      ? (state as Record<string, unknown>)
      : null;

  switch (appName) {
    case 'browser':
      return {
        current_url: normalizedState?.currentUrl ?? null,
        view_mode: normalizedState?.viewMode ?? null,
        sidebar_open: normalizedState?.sidebarOpen ?? null,
        bookmark_count: await countFiles('apps/browser/data/bookmarks'),
        history_count: await countFiles('apps/browser/data/history'),
      };
    case 'notes':
      return {
        selected_note_id: normalizedState?.selectedNoteId ?? null,
        active_tag: normalizedState?.activeTag ?? null,
        search_query: normalizedState?.searchQuery ?? '',
        preview_mode: normalizedState?.previewMode ?? null,
        note_count: await countFiles('apps/notes/data/notes'),
      };
    case 'calendar':
      return {
        selected_event_id: normalizedState?.selectedEventId ?? null,
        event_count: await countFiles('apps/calendar/data/events'),
      };
    case 'kira': {
      const persisted = await loadPersistedConfig().catch(() => null);
      const kira = persisted?.kira;
      const fallbackRole = buildKiraFallbackRole(persisted);
      const workers = resolveKiraStateWorkers(kira, fallbackRole);
      const reviewer = resolveKiraStateReviewer(kira, fallbackRole);
      return {
        selected_task_id: normalizedState?.selectedTaskId ?? null,
        active_project_name: normalizedState?.activeProjectName ?? null,
        preview_mode: normalizedState?.previewMode ?? null,
        work_count: await countFiles('apps/kira/data/works'),
        comment_count: await countFiles('apps/kira/data/comments'),
        model_settings:
          kira || fallbackRole
            ? {
                work_root_directory: kira?.workRootDirectory ?? null,
                worker_count: workers.length,
                workers: workers.map(sanitizeKiraRole),
                reviewer: sanitizeKiraRole(reviewer),
                project_defaults: kira?.projectDefaults ?? null,
              }
            : null,
      };
    }
    case 'youtube':
      return {
        search_query: normalizedState?.searchQuery ?? '',
        recent_search_count: Array.isArray(normalizedState?.recentSearches)
          ? normalizedState?.recentSearches.length
          : 0,
        favorite_topic_count: Array.isArray(normalizedState?.favoriteTopics)
          ? normalizedState?.favoriteTopics.length
          : 0,
        sidebar_open: normalizedState?.sidebarOpen ?? null,
        loop_playback: normalizedState?.loopPlayback ?? null,
        player_zoom: normalizedState?.playerZoom ?? null,
      };
    case 'diary':
      return {
        selected_date: normalizedState?.selectedDate ?? null,
        entry_count: await countFiles('apps/diary/data/entries'),
      };
    case 'email':
      return {
        selected_email_id: normalizedState?.selectedEmailId ?? null,
        current_folder: normalizedState?.currentFolder ?? 'inbox',
        email_count: await countFiles('apps/email/data/emails'),
      };
    case 'twitter':
      return {
        draft_content_length:
          typeof normalizedState?.draftContent === 'string'
            ? normalizedState.draftContent.length
            : 0,
        current_user: normalizedState?.currentUser ?? null,
        post_count: await countFiles('apps/twitter/data/posts'),
      };
    case 'cyberNews':
      return {
        article_count: await countFiles('apps/cyberNews/data/articles'),
        case_count: await countFiles('apps/cyberNews/data/cases'),
        ...((normalizedState ?? {}) as Record<string, unknown>),
      };
    case 'chess':
      return {
        game_id: normalizedState?.gameId ?? null,
        current_turn: normalizedState?.currentTurn ?? null,
        game_status: normalizedState?.gameStatus ?? null,
        winner: normalizedState?.winner ?? null,
        move_count: Array.isArray(normalizedState?.moveHistory)
          ? normalizedState.moveHistory.length
          : 0,
        is_agent_thinking: normalizedState?.isAgentThinking ?? null,
      };
    case 'gomoku':
      return {
        current_game_id: normalizedState?.currentGameId ?? null,
        total_games: normalizedState?.totalGames ?? 0,
        stats: normalizedState?.stats ?? null,
        history_count: await countFiles('apps/gomoku/data/history'),
      };
    case 'openvscode': {
      const activeFile =
        normalizedState?.activeFile &&
        typeof normalizedState.activeFile === 'object' &&
        !Array.isArray(normalizedState.activeFile)
          ? (normalizedState.activeFile as Record<string, unknown>)
          : null;
      const activeSelection =
        activeFile?.selection &&
        typeof activeFile.selection === 'object' &&
        !Array.isArray(activeFile.selection)
          ? (activeFile.selection as Record<string, unknown>)
          : null;
      const openTabs = Array.isArray(normalizedState?.openTabs)
        ? normalizedState.openTabs.filter(
            (tab): tab is Record<string, unknown> =>
              !!tab && typeof tab === 'object' && !Array.isArray(tab),
          )
        : [];
      const modelActions = Array.isArray(normalizedState?.modelActions)
        ? normalizedState.modelActions.filter(
            (entry): entry is Record<string, unknown> =>
              !!entry && typeof entry === 'object' && !Array.isArray(entry),
          )
        : [];
      const workspaceHistory = Array.isArray(normalizedState?.workspaceHistory)
        ? normalizedState.workspaceHistory.filter(
            (root): root is string => typeof root === 'string' && root.trim().length > 0,
          )
        : [];
      return {
        workspace_root: normalizedState?.workspaceRoot ?? null,
        workspace_exists: normalizedState?.workspaceExists ?? null,
        workspace_history: workspaceHistory.slice(0, 8),
        active_path: normalizedState?.activePath ?? activeFile?.path ?? null,
        active_file: activeFile
          ? {
              path: activeFile.path ?? null,
              name: activeFile.name ?? null,
              language: activeFile.language ?? null,
              dirty: activeFile.dirty ?? null,
              cursor: activeFile.cursor ?? null,
              line_count: activeFile.lineCount ?? null,
              char_count: activeFile.charCount ?? null,
              content_truncated: activeFile.contentTruncated ?? null,
              selection: activeSelection
                ? {
                    start_line: activeSelection.startLine ?? null,
                    start_column: activeSelection.startColumn ?? null,
                    end_line: activeSelection.endLine ?? null,
                    end_column: activeSelection.endColumn ?? null,
                    line_count: activeSelection.lineCount ?? null,
                    char_count: activeSelection.charCount ?? null,
                    text_truncated: activeSelection.textTruncated ?? null,
                  }
                : null,
            }
          : null,
        open_tab_count: openTabs.length,
        open_tabs: openTabs.slice(0, 10).map((tab) => ({
          path: tab.path ?? null,
          name: tab.name ?? null,
          language: tab.language ?? null,
          dirty: tab.dirty ?? null,
          line_count: tab.lineCount ?? null,
          char_count: tab.charCount ?? null,
        })),
        model_action_count: modelActions.length,
        recent_model_actions: modelActions.slice(0, 5).map((entry) => ({
          action_type: entry.actionType ?? null,
          status: entry.status ?? null,
          path: entry.path ?? null,
          reversible: entry.reversible ?? null,
          undone: entry.undone ?? null,
        })),
        ui: normalizedState?.ui ?? null,
        updated_at: normalizedState?.updatedAt ?? null,
      };
    }
    case 'freecell':
      return {
        game_id: normalizedState?.gameId ?? null,
        move_count: normalizedState?.moveCount ?? 0,
        game_status: normalizedState?.gameStatus ?? null,
        free_cell_count: Array.isArray(normalizedState?.freeCells)
          ? normalizedState.freeCells.filter((item: unknown) => item !== null).length
          : 0,
      };
    case 'evidencevault':
      return {
        file_count: await countFiles('apps/evidencevault/data/files'),
      };
    case 'album':
      return {
        image_count: await countFiles('apps/album/data/images'),
      };
    default:
      return normalizedState ? { ...normalizedState } : null;
  }
}

function buildWindowSummary(appId: number) {
  const app = APP_REGISTRY.find((item) => item.appId === appId);
  return getWindows()
    .filter((windowState) => windowState.appId === appId)
    .map((windowState) => ({
      app_id: windowState.appId,
      app_name: app?.appName || `app-${windowState.appId}`,
      display_name: app?.displayName || windowState.title,
      title: windowState.title,
      x: windowState.x,
      y: windowState.y,
      width: windowState.width,
      height: windowState.height,
      z_index: windowState.zIndex,
      minimized: windowState.minimized,
      maximized: !!windowState.maximized,
    }));
}

function buildAllWindowSummaries() {
  const windows = getWindows();
  const activeWindow = [...windows].sort((a, b) => b.zIndex - a.zIndex)[0];

  return {
    open_window_count: windows.length,
    active_app_name:
      APP_REGISTRY.find((item) => item.appId === activeWindow?.appId)?.appName || null,
    windows: windows
      .map((windowState) => {
        const app = APP_REGISTRY.find((item) => item.appId === windowState.appId);
        return {
          app_id: windowState.appId,
          app_name: app?.appName || `app-${windowState.appId}`,
          display_name: app?.displayName || windowState.title,
          title: windowState.title,
          minimized: windowState.minimized,
          maximized: !!windowState.maximized,
          z_index: windowState.zIndex,
          x: windowState.x,
          y: windowState.y,
          width: windowState.width,
          height: windowState.height,
        };
      })
      .sort((a, b) => b.z_index - a.z_index),
  };
}

export function getAppStateToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          'Inspect current app and window state. Use this to see which apps are open, focused, or what an app state.json currently contains.',
        parameters: {
          type: 'object',
          properties: {
            app_name: {
              type: 'string',
              description:
                'Optional target appName from list_apps, for example "notes" or "browser".',
            },
            include_state: {
              type: 'boolean',
              description: 'When true, also read apps/{appName}/data/state.json if it exists.',
            },
          },
          required: [],
        },
      },
    },
  ];
}

export function isAppStateTool(toolName: string): boolean {
  return toolName === TOOL_NAME;
}

export async function executeAppStateTool(params: Record<string, unknown>): Promise<string> {
  const appName = String(params.app_name || '').trim();
  const includeState = params.include_state !== false;

  if (!appName) {
    return JSON.stringify(buildAllWindowSummaries());
  }

  const app = APP_REGISTRY.find((item) => item.appName === appName);
  if (!app) return `error: unknown app "${appName}"`;

  const result: Record<string, unknown> = {
    app: {
      app_id: app.appId,
      app_name: app.appName,
      display_name: app.displayName,
      route: app.route,
    },
    windows: buildWindowSummary(app.appId),
  };

  if (includeState && app.appName !== 'os') {
    const stateFilePath = `apps/${app.appName}/data/state.json`;
    const state = await idb.getFile(stateFilePath);
    result.state_file_path = stateFilePath;
    result.state = state ?? null;
    result.state_summary = await buildStateSummary(app.appName, state ?? null);
  }

  if (app.appName === 'openvscode') {
    const persisted = await loadPersistedConfig();
    result.workspace = persisted?.openvscode
      ? {
          workspace_path: persisted.openvscode.workspacePath || null,
          workspace_history: Array.isArray(persisted.openvscode.workspaceHistory)
            ? persisted.openvscode.workspaceHistory
            : [],
          base_url: persisted.openvscode.baseUrl || null,
          host: persisted.openvscode.host || null,
          port: persisted.openvscode.port || null,
        }
      : null;
  }

  return JSON.stringify(result);
}
