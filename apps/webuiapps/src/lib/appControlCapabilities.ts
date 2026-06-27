import type { AppActionDef } from './appRegistry';
import { listSchemasForApp } from './appSchemaRegistry';

export type AppControlStatus = 'tool-backed' | 'inspectable' | 'window-only';

// Minimal structural input accepted by capability builders. Covers AppIdentity
// (no actions), AppDef (actions required), and the static registry shape
// (actions absent). actions is read defensively via an 'actions' in app guard.
export interface AppControlCapabilityInput {
  appId: number;
  appName: string;
  route: string;
  displayName: string;
  actions?: AppActionDef[];
}

export interface AppControlCapabilities {
  app_id: number;
  app_name: string;
  display_name: string;
  route: string;
  control_status: AppControlStatus;
  windows: {
    can_open: boolean;
    can_close: boolean;
  };
  state: {
    can_read_state_file: boolean;
    state_file_path: string | null;
    has_bespoke_summary: boolean;
  };
  storage: {
    can_read_files: boolean;
    can_write_files: boolean;
    data_root: string | null;
    schema_count: number;
    schema_ids: string[];
  };
  actions: {
    can_dispatch: boolean;
    declared_count: number;
    names: string[];
    categories: string[];
    mutating_names: string[];
    destructive_names: string[];
    external_names: string[];
  };
  guidance: string[];
  gaps: string[];
}

const BESPOKE_STATE_SUMMARY_APPS = new Set([
  'album',
  'browser',
  'calendar',
  'chess',
  'cyberNews',
  'aoimemory',
  'aoiresearch',
  'dewdropcanvas',
  'diary',
  'email',
  'evidencevault',
  'freecell',
  'gomoku',
  'kira',
  'notes',
  'openvscode',
  'peanalyzer',
  'roomshop',
  'twitter',
  'writtenbyme',
  'youtube',
]);

export function hasBespokeAppStateSummary(appName: string): boolean {
  return BESPOKE_STATE_SUMMARY_APPS.has(appName);
}

function getDeclaredActions(app: AppControlCapabilityInput): AppActionDef[] {
  if ('actions' in app && Array.isArray(app.actions)) {
    return app.actions;
  }
  return [];
}

function classifyActionName(actionName: string): string {
  const name = actionName.toUpperCase();
  if (/^(REFRESH|SYNC|CHECK|SHOW|OPEN|SELECT|FILTER|COPY)/.test(name)) return 'operation';
  if (/^(CREATE|ADD|SAVE|SEND)/.test(name)) return 'create';
  if (/^(UPDATE|PATCH|EDIT|MARK|STAR|UNSTAR|PROMOTE|DEMOTE)/.test(name)) return 'update';
  if (/^(DELETE|TRASH|ARCHIVE|REMOVE)/.test(name)) return 'delete';
  if (/^(PLAY|PAUSE|RESUME|NEXT|PREV|SEEK|SET_PLAY|SET_VOLUME)/.test(name)) return 'playback';
  if (/^(PREVIEW|APPLY|RESET|SET|SWITCH|USE|RUN|START|CANCEL)/.test(name)) return 'operation';
  if (/EXTERNAL/.test(name)) return 'external';
  return 'operation';
}

function isMutatingAction(actionName: string): boolean {
  return /^(CREATE|ADD|SAVE|SEND|UPDATE|PATCH|EDIT|MARK|STAR|UNSTAR|PROMOTE|DEMOTE|DELETE|TRASH|ARCHIVE|REMOVE|PLAY|PAUSE|RESUME|NEXT|PREV|SEEK|SET|PREVIEW|APPLY|RESET|SWITCH|USE|RUN|START|CANCEL)/i.test(
    actionName,
  );
}

function isDestructiveAction(actionName: string): boolean {
  return /^(DELETE|TRASH|ARCHIVE|REMOVE|RESET)/i.test(actionName);
}

function isExternalAction(actionName: string): boolean {
  return /(?:EXTERNAL|SEND_EMAIL|OPEN_URL)/i.test(actionName);
}

export function buildAppControlCapabilities(
  app: AppControlCapabilityInput,
): AppControlCapabilities {
  const isOs = app.appName === 'os';
  const actions = getDeclaredActions(app);
  const actionNames = actions.map((action) => action.name);
  const schemas = isOs ? [] : listSchemasForApp(app.appName);
  const categories = Array.from(new Set(actionNames.map(classifyActionName))).sort();
  const mutatingNames = actionNames.filter(isMutatingAction);
  const destructiveNames = actionNames.filter(isDestructiveAction);
  const externalNames = actionNames.filter(isExternalAction);
  const hasStateSummary = !isOs && hasBespokeAppStateSummary(app.appName);
  const hasStorage = !isOs;
  const hasToolBackedControl = !isOs && (actions.length > 0 || schemas.length > 0);
  const controlStatus: AppControlStatus = hasToolBackedControl
    ? 'tool-backed'
    : hasStorage
      ? 'inspectable'
      : 'window-only';
  const guidance: string[] = [];
  const gaps: string[] = [];

  if (isOs) {
    guidance.push('Use OS actions only for desktop-level operations such as opening apps.');
  } else {
    guidance.push('Use get_app_state before acting when current UI context matters.');
    guidance.push('Read apps/{appName}/meta.yaml before app_action for exact parameters.');
    if (schemas.length > 0) {
      guidance.push('Use get_app_schema before writing app storage files.');
    }
    if (mutatingNames.length > 0) {
      guidance.push(
        'Use app-owned actions for declared operations; use file tools for data files.',
      );
    }
  }

  if (!isOs && actions.length === 0) {
    gaps.push('No declared app actions are loaded from meta.yaml yet.');
  }
  if (!isOs && schemas.length === 0) {
    gaps.push('No machine-readable app data schemas are registered.');
  }
  if (!isOs && !hasStateSummary) {
    gaps.push('Only raw state.json is available; no bespoke state summary is registered.');
  }

  return {
    app_id: app.appId,
    app_name: app.appName,
    display_name: app.displayName,
    route: app.route,
    control_status: controlStatus,
    windows: {
      can_open: !isOs,
      can_close: !isOs,
    },
    state: {
      can_read_state_file: !isOs,
      state_file_path: isOs ? null : `apps/${app.appName}/data/state.json`,
      has_bespoke_summary: hasStateSummary,
    },
    storage: {
      can_read_files: hasStorage,
      can_write_files: hasStorage,
      data_root: isOs ? null : `apps/${app.appName}/data`,
      schema_count: schemas.length,
      schema_ids: schemas.map((schema) => schema.id),
    },
    actions: {
      can_dispatch: actions.length > 0,
      declared_count: actions.length,
      names: actionNames,
      categories,
      mutating_names: mutatingNames,
      destructive_names: destructiveNames,
      external_names: externalNames,
    },
    guidance,
    gaps,
  };
}

export function summarizeAppControlCapabilities(capabilities: AppControlCapabilities[]): {
  app_count: number;
  tool_backed_count: number;
  inspectable_count: number;
  window_only_count: number;
  apps_with_actions: number;
  apps_with_schemas: number;
  apps_with_bespoke_state_summary: number;
  destructive_action_apps: string[];
  gap_apps: Array<{ app_name: string; gaps: string[] }>;
} {
  return {
    app_count: capabilities.length,
    tool_backed_count: capabilities.filter((entry) => entry.control_status === 'tool-backed')
      .length,
    inspectable_count: capabilities.filter((entry) => entry.control_status === 'inspectable')
      .length,
    window_only_count: capabilities.filter((entry) => entry.control_status === 'window-only')
      .length,
    apps_with_actions: capabilities.filter((entry) => entry.actions.declared_count > 0).length,
    apps_with_schemas: capabilities.filter((entry) => entry.storage.schema_count > 0).length,
    apps_with_bespoke_state_summary: capabilities.filter((entry) => entry.state.has_bespoke_summary)
      .length,
    destructive_action_apps: capabilities
      .filter((entry) => entry.actions.destructive_names.length > 0)
      .map((entry) => entry.app_name),
    gap_apps: capabilities
      .filter((entry) => entry.gaps.length > 0)
      .map((entry) => ({ app_name: entry.app_name, gaps: entry.gaps })),
  };
}

export function formatAppCapabilityLine(capabilities: AppControlCapabilities): string {
  const actionPreview =
    capabilities.actions.names.length > 0
      ? capabilities.actions.names.slice(0, 8).join(', ') +
        (capabilities.actions.names.length > 8
          ? `, +${capabilities.actions.names.length - 8} more`
          : '')
      : 'none loaded';
  const schemaPreview =
    capabilities.storage.schema_ids.length > 0
      ? capabilities.storage.schema_ids.join(', ')
      : 'none';
  const gapText = capabilities.gaps.length > 0 ? ` gaps: ${capabilities.gaps.join(' ')}` : '';

  return [
    `${capabilities.display_name} controls:`,
    `status=${capabilities.control_status};`,
    `state=${capabilities.state.can_read_state_file ? 'readable' : 'none'}${
      capabilities.state.has_bespoke_summary ? '+summary' : ''
    };`,
    `actions=${capabilities.actions.declared_count} [${actionPreview}];`,
    `schemas=${capabilities.storage.schema_count} [${schemaPreview}];`,
    `destructive=${capabilities.actions.destructive_names.length};`,
    gapText.trim(),
  ]
    .filter(Boolean)
    .join(' ');
}
