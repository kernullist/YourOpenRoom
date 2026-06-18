/**
 * App Action Registry
 *
 * Static info (appId, appName, route, displayName) is defined in code.
 * Action definitions are dynamically loaded from each App's meta.yaml (stored on disk).
 */

import * as idb from './diskStorage';
import {
  buildAppControlCapabilities,
  formatAppCapabilityLine,
  summarizeAppControlCapabilities,
  type AppControlCapabilities,
} from './appControlCapabilities';

// ============ Type Definitions ============

export interface AppActionDef {
  name: string;
  description: string;
  params: Array<{
    name: string;
    type: string;
    description: string;
    required?: boolean;
    enum?: string[];
  }>;
}

export interface AppDef {
  appId: number;
  appName: string;
  route: string;
  displayName: string;
  aliases?: string[];
  actions: AppActionDef[];
}

export interface AppIdentity {
  appId: number;
  appName: string;
  route: string;
  displayName: string;
  aliases: string[];
}

// ============ Static App Registry (without actions) ============

interface AppStaticDef {
  appId: number;
  appName: string;
  route: string;
  displayName: string;
  aliases?: string[];
  /** Source directory name (under src/pages/), not present for OS */
  sourceDir?: string;
  /** Lucide icon name */
  icon?: string;
  /** Desktop icon color */
  color?: string;
  /** Default window size */
  defaultSize?: { width: number; height: number };
}

const APP_STATIC_REGISTRY: AppStaticDef[] = [
  { appId: 1, appName: 'os', route: '/home', displayName: 'OS' },
  {
    appId: 2,
    appName: 'twitter',
    route: '/twitter',
    displayName: 'Twitter',
    sourceDir: 'Twitter',
    icon: 'Twitter',
    color: '#1da1f2',
    defaultSize: { width: 400, height: 500 },
  },
  {
    appId: 3,
    appName: 'youtube',
    route: '/youtube',
    displayName: 'YouTube',
    aliases: ['Music App', 'music', 'song', 'track', 'artist', '유튜브', '뮤직 앱', '노래', '음악'],
    sourceDir: 'MusicApp',
    icon: 'Video',
    color: '#ff3b30',
    defaultSize: { width: 1100, height: 760 },
  },
  {
    appId: 4,
    appName: 'diary',
    route: '/diary',
    displayName: 'Diary',
    aliases: ['journal', '일기'],
    sourceDir: 'Diary',
    icon: 'BookOpen',
    color: '#faea5f',
    defaultSize: { width: 880, height: 480 },
  },
  {
    appId: 8,
    appName: 'album',
    route: '/album',
    displayName: 'Album',
    aliases: ['gallery', '앨범'],
    sourceDir: 'Album',
    icon: 'Image',
    color: '#58a6ff',
    defaultSize: { width: 640, height: 440 },
  },
  {
    appId: 9,
    appName: 'gomoku',
    route: '/gomoku',
    displayName: 'Gomoku',
    aliases: ['오목'],
    sourceDir: 'Gomoku',
    icon: 'Circle',
    color: '#f97316',
    defaultSize: { width: 600, height: 600 },
  },
  {
    appId: 10,
    appName: 'freecell',
    route: '/freecell',
    displayName: 'FreeCell',
    aliases: ['프리셀'],
    sourceDir: 'FreeCell',
    icon: 'LayoutGrid',
    color: '#22c55e',
    defaultSize: { width: 700, height: 500 },
  },
  {
    appId: 11,
    appName: 'email',
    route: '/email',
    displayName: 'Email',
    aliases: ['mail', '이메일', '메일'],
    sourceDir: 'Email',
    icon: 'Mail',
    color: '#a78bfa',
    defaultSize: { width: 540, height: 480 },
  },
  {
    appId: 12,
    appName: 'chess',
    route: '/chess',
    displayName: 'Chess',
    aliases: ['체스'],
    sourceDir: 'Chess',
    icon: 'Crown',
    color: '#eab308',
    defaultSize: { width: 700, height: 600 },
  },
  {
    appId: 13,
    appName: 'evidencevault',
    route: '/evidencevault',
    displayName: 'Evidence Vault',
    aliases: ['evidence', 'vault', '증거 보관함'],
    sourceDir: 'EvidenceVault',
    icon: 'Shield',
    color: '#ef4444',
    defaultSize: { width: 700, height: 500 },
  },
  {
    appId: 14,
    appName: 'cyberNews',
    route: '/cyberNews',
    displayName: 'CyberNews',
    aliases: ['cyber news', '사이버 뉴스'],
    sourceDir: 'CyberNews',
    icon: 'Newspaper',
    color: '#FAEA5F',
    defaultSize: { width: 1100, height: 750 },
  },
  {
    appId: 15,
    appName: 'calendar',
    route: '/calendar',
    displayName: 'Calendar',
    aliases: ['캘린더', '일정'],
    sourceDir: 'Calendar',
    icon: 'CalendarDays',
    color: '#38bdf8',
    defaultSize: { width: 860, height: 620 },
  },
  {
    appId: 16,
    appName: 'notes',
    route: '/notes',
    displayName: 'Notes',
    aliases: ['note', 'memo', '메모', '노트'],
    sourceDir: 'Notes',
    icon: 'FileText',
    color: '#f59e0b',
    defaultSize: { width: 1080, height: 680 },
  },
  {
    appId: 17,
    appName: 'browser',
    route: '/browser',
    displayName: 'Browser',
    aliases: ['reader', 'browser reader', 'web browser', '브라우저', '리더'],
    sourceDir: 'BrowserReader',
    icon: 'Globe',
    color: '#38bdf8',
    defaultSize: { width: 1180, height: 760 },
  },
  {
    appId: 18,
    appName: 'kira',
    route: '/kira',
    displayName: 'Kira',
    aliases: ['키라'],
    sourceDir: 'Kira',
    icon: 'KanbanSquare',
    color: '#ff8f3d',
    defaultSize: { width: 1320, height: 780 },
  },
  {
    appId: 19,
    appName: 'openvscode',
    route: '/ide',
    displayName: "Aoi's IDE",
    aliases: [
      'Aoi IDE',
      'IDE',
      'VSCode',
      'code editor',
      'editor',
      '아오이 IDE',
      '에디터',
      '코드 에디터',
    ],
    sourceDir: 'OpenVSCode',
    icon: 'Code2',
    color: '#38bdf8',
    defaultSize: { width: 1360, height: 760 },
  },
  {
    appId: 20,
    appName: 'peanalyzer',
    route: '/peanalyzer',
    displayName: 'PE Analyst',
    aliases: ['PE Analyzer', 'portable executable analyzer', 'PE 분석기', 'PE 애널리스트'],
    sourceDir: 'PeAnalyzer',
    icon: 'FileArchive',
    color: '#0f766e',
    defaultSize: { width: 1320, height: 820 },
  },
  {
    appId: 21,
    appName: 'roomshop',
    route: '/roomshop',
    displayName: 'Room Shop',
    aliases: ['RoomShop', 'room store', 'room theme shop', '룸샵', '방 상점', '방 꾸미기'],
    sourceDir: 'RoomShop',
    icon: 'Palette',
    color: '#fb9f3f',
    defaultSize: { width: 1120, height: 720 },
  },
  {
    appId: 22,
    appName: 'dewdropcanvas',
    route: '/dewdrop-canvas',
    displayName: 'Dewdrop Canvas',
    aliases: [
      'Dewdrop',
      'canvas',
      'mind map',
      'mindmap',
      '드롭 캔버스',
      '듀드롭 캔버스',
      '마인드맵',
      '캔버스',
    ],
    sourceDir: 'DewdropCanvas',
    icon: 'Droplets',
    color: '#06b6d4',
    defaultSize: { width: 1380, height: 820 },
  },
  {
    appId: 23,
    appName: 'writtenbyme',
    route: '/written-by-me',
    displayName: 'Written By Me',
    aliases: ['writing style analyzer', 'style analyzer', '문체 분석기', '글쓰기 분석기', '문체'],
    sourceDir: 'WrittenByMe',
    icon: 'Feather',
    color: '#58a6ff',
    defaultSize: { width: 1180, height: 780 },
  },
  {
    appId: 24,
    appName: 'aoiresearch',
    route: '/aoi-research',
    displayName: 'Aoi Research',
    aliases: [
      'research library',
      'aoi research library',
      'research reports',
      '리서치',
      '조사 문서',
    ],
    sourceDir: 'AoiResearch',
    icon: 'FileText',
    color: '#4cc3a5',
    defaultSize: { width: 1240, height: 760 },
  },
  {
    appId: 25,
    appName: 'aoimemory',
    route: '/aoi-memory',
    displayName: 'Aoi Memory',
    aliases: [
      'Aoi Memory Dashboard',
      'memory dashboard',
      'memory inspector',
      'what Aoi knows',
      '아오이 메모리',
      '메모리 대시보드',
      '기억 대시보드',
    ],
    sourceDir: 'AoiMemoryDashboard',
    icon: 'MessageCircle',
    color: '#7dd3fc',
    defaultSize: { width: 1280, height: 760 },
  },
];

// OS actions are built-in system actions, not from meta.yaml
const OS_ACTIONS: AppActionDef[] = [
  {
    name: 'OPEN_APP',
    description:
      'Open a specified app. Pass app_id as the application ID. When speaking to the user, use the app display name rather than the numeric app_id.',
    params: [
      {
        name: 'app_id',
        type: 'string',
        description: `Application ID (${APP_STATIC_REGISTRY.filter((a) => a.appName !== 'os')
          .map((a) => `${a.appId}=${a.displayName} appName=${a.appName}`)
          .join(', ')})`,
        required: true,
      },
    ],
  },
  {
    name: 'CLOSE_APP',
    description:
      'Close a specified app. Pass app_id as the application ID. When speaking to the user, use the app display name rather than the numeric app_id.',
    params: [
      {
        name: 'app_id',
        type: 'string',
        description: `Application ID (${APP_STATIC_REGISTRY.filter((a) => a.appName !== 'os')
          .map((a) => `${a.appId}=${a.displayName} appName=${a.appName}`)
          .join(', ')})`,
        required: true,
      },
    ],
  },
  {
    name: 'FOCUS_APP',
    description:
      'Focus or restore a specified app window. Pass app_id as the application ID. When speaking to the user, use the app display name rather than the numeric app_id.',
    params: [
      {
        name: 'app_id',
        type: 'string',
        description: `Application ID (${APP_STATIC_REGISTRY.filter((a) => a.appName !== 'os')
          .map((a) => `${a.appId}=${a.displayName} appName=${a.appName}`)
          .join(', ')})`,
        required: true,
      },
    ],
  },
  {
    name: 'SET_WALLPAPER',
    description:
      'Change the desktop wallpaper. wallpaper_url must be a https URL or a data URL (data:image/...). ' +
      'You can use the dataUrl returned by generate_image, or any https image/video URL.',
    params: [
      {
        name: 'wallpaper_url',
        type: 'string',
        description: 'https URL or data URL for the wallpaper',
        required: true,
      },
    ],
  },
];

const COMMON_APP_ACTIONS: AppActionDef[] = [
  {
    name: 'OPEN_APP_WINDOW',
    description:
      'Open this app window. This is a common app control routed through the OS OPEN_APP action.',
    params: [],
  },
  {
    name: 'FOCUS_APP_WINDOW',
    description:
      'Focus or restore this app window. This is a common app control routed through the OS FOCUS_APP action.',
    params: [],
  },
  {
    name: 'CLOSE_APP_WINDOW',
    description:
      'Close this app window. This is a common app control routed through the OS CLOSE_APP action.',
    params: [],
  },
];

// ============ Helper Query Functions ============

export function getAppDisplayName(appId: number): string {
  return APP_STATIC_REGISTRY.find((a) => a.appId === appId)?.displayName ?? `App ${appId}`;
}

function toAppIdentity(app: AppStaticDef | AppDef): AppIdentity {
  return {
    appId: app.appId,
    appName: app.appName,
    route: app.route,
    displayName: app.displayName,
    aliases: app.aliases ?? [],
  };
}

export function getAppIdentityById(appId: number): AppIdentity | null {
  const app =
    APP_REGISTRY.find((a) => a.appId === appId) ??
    APP_STATIC_REGISTRY.find((a) => a.appId === appId);
  return app ? toAppIdentity(app) : null;
}

export function getAppIdentityByName(appName: string): AppIdentity | null {
  const normalized = appName.trim().toLowerCase();
  const app =
    APP_REGISTRY.find((a) => a.appName.toLowerCase() === normalized) ??
    APP_STATIC_REGISTRY.find((a) => a.appName.toLowerCase() === normalized);
  return app ? toAppIdentity(app) : null;
}

function normalizeAppReference(value: string): string {
  return value.trim().toLowerCase();
}

function appReferenceMatches(app: AppStaticDef | AppDef, appReference: string): boolean {
  const normalized = normalizeAppReference(appReference);
  if (!normalized) {
    return false;
  }
  if (app.appName.toLowerCase() === normalized) return true;
  if (app.displayName.toLowerCase() === normalized) return true;
  if (String(app.appId) === normalized) return true;
  return (app.aliases ?? []).some((alias) => alias.toLowerCase() === normalized);
}

function findAppByReference(appReference: string): AppDef | AppStaticDef | null {
  return (
    APP_REGISTRY.find((app) => appReferenceMatches(app, appReference)) ??
    APP_STATIC_REGISTRY.find((app) => appReferenceMatches(app, appReference)) ??
    null
  );
}

export function getAppIdentityByReference(appReference: string): AppIdentity | null {
  const app = findAppByReference(appReference);
  return app ? toAppIdentity(app) : null;
}

export function getAppRecognitionEntries(): AppIdentity[] {
  return APP_REGISTRY.filter((a) => a.appName !== 'os').map(toAppIdentity);
}

export function getAppControlInventory(): AppControlCapabilities[] {
  return APP_REGISTRY.map(buildAppControlCapabilities);
}

export function getAppControlCapabilitiesByName(appName: string): AppControlCapabilities | null {
  const app = findAppByReference(appName);
  return app ? buildAppControlCapabilities(app) : null;
}

export function formatAppReference(app: AppIdentity): string {
  return `${app.displayName} (appName: ${app.appName}, appId: ${app.appId})`;
}

export function getOsActionTargetApp(
  actionType: string,
  params?: Record<string, string>,
): AppIdentity | null {
  if (actionType !== 'OPEN_APP' && actionType !== 'CLOSE_APP' && actionType !== 'FOCUS_APP') {
    return null;
  }

  const appId = Number(params?.app_id);
  if (!Number.isFinite(appId)) {
    return null;
  }

  return getAppIdentityById(appId);
}

export function describeAppActionResultForModel(input: {
  sourceAppId: number;
  actionType: string;
  params?: Record<string, string>;
  rawResult: string;
}): string {
  const sourceApp = getAppIdentityById(input.sourceAppId);
  const targetApp = getOsActionTargetApp(input.actionType, input.params);
  return JSON.stringify({
    ok: !/^(error|timeout):/i.test(input.rawResult.trim()),
    source_app: sourceApp
      ? {
          app_id: sourceApp.appId,
          app_name: sourceApp.appName,
          display_name: sourceApp.displayName,
        }
      : {
          app_id: input.sourceAppId,
          app_name: `app-${input.sourceAppId}`,
          display_name: `App ${input.sourceAppId}`,
        },
    target_app: targetApp
      ? {
          app_id: targetApp.appId,
          app_name: targetApp.appName,
          display_name: targetApp.displayName,
        }
      : null,
    action_type: input.actionType,
    params: input.params ?? {},
    raw_result: input.rawResult,
    user_facing_name: (targetApp ?? sourceApp)?.displayName ?? `App ${input.sourceAppId}`,
  });
}

export function getAppDefaultSize(appId: number): { width: number; height: number } {
  return (
    APP_STATIC_REGISTRY.find((a) => a.appId === appId)?.defaultSize ?? { width: 600, height: 400 }
  );
}

/** Returns all desktop Apps (excluding OS), used for Shell desktop icons */
export function getDesktopApps(): Array<{
  appId: number;
  displayName: string;
  icon: string;
  color: string;
}> {
  return APP_STATIC_REGISTRY.filter((a) => a.appName !== 'os' && a.icon && a.color).map((a) => ({
    appId: a.appId,
    displayName: a.displayName,
    icon: a.icon!,
    color: a.color!,
  }));
}

/** Source directory name to appName mapping, used for seedMeta */
export function getSourceDirToAppName(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const app of APP_STATIC_REGISTRY) {
    if (app.sourceDir) map[app.sourceDir] = app.appName;
  }
  return map;
}

/** sourceDir to appId mapping, used for AppWindow dynamic component loading */
export function getSourceDirToAppId(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const app of APP_STATIC_REGISTRY) {
    if (app.sourceDir) map[app.sourceDir] = app.appId;
  }
  return map;
}

// ============ Full Registry After Dynamic Loading ============

function buildDefaultAppRegistry(): AppDef[] {
  return APP_STATIC_REGISTRY.map((app) => ({
    ...app,
    actions: app.appName === 'os' ? OS_ACTIONS : COMMON_APP_ACTIONS,
  }));
}

/** Full APP_REGISTRY, including dynamically loaded actions */
export let APP_REGISTRY: AppDef[] = buildDefaultAppRegistry();

function withCommonAppActions(app: AppStaticDef, actions: AppActionDef[]): AppActionDef[] {
  if (app.appName === 'os') {
    return actions;
  }

  const existingNames = new Set(actions.map((action) => action.name));
  const missingCommonActions = COMMON_APP_ACTIONS.filter(
    (action) => !existingNames.has(action.name),
  );
  return [...missingCommonActions, ...actions];
}

// ============ Meta.yaml Parsing ============

/**
 * Parse action definitions from meta.yaml
 * Standard array format: actions: [{ type, name, description, params: [{ name, type, ... }] }]
 */
function parseMetaYamlActions(yamlContent: string): AppActionDef[] {
  const actions: AppActionDef[] = [];

  // Check for actions: [] (inline empty)
  if (/^actions:\s*\[\]\s*$/m.test(yamlContent)) return actions;

  // Find the actions: section
  const actionsMatch = yamlContent.match(/^actions:\s*$/m);
  if (!actionsMatch) return actions;

  const actionsStart = actionsMatch.index! + actionsMatch[0].length;
  const restContent = yamlContent.slice(actionsStart);

  const lines = restContent.split('\n');
  parseStandardActions(lines, actions);

  return actions;
}

function parseStandardActions(lines: string[], actions: AppActionDef[]): void {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Stop parsing the actions block when encountering a non-indented non-empty line (top-level key)
    if (line.match(/^\S/) && line.trim() !== '') break;

    const typeMatch = line.match(/^\s+-\s+type:\s+(\S+)/);
    if (typeMatch) {
      const action: AppActionDef = { name: typeMatch[1], description: '', params: [] };
      i++;
      // Parse this action's properties
      while (i < lines.length) {
        const l = lines[i];
        if (l.match(/^\s+-\s+type:\s/) || (l.match(/^\S/) && l.trim() !== '')) break;

        const descMatch = l.match(/^\s+description:\s*>?\s*$/);
        if (descMatch) {
          // Multi-line description
          i++;
          const descLines: string[] = [];
          while (i < lines.length && lines[i].match(/^\s{6,}/) && !lines[i].match(/^\s+\w+:/)) {
            descLines.push(lines[i].trim());
            i++;
          }
          action.description = descLines.join(' ');
          continue;
        }
        const descInlineMatch = l.match(/^\s+description:\s+(.+)$/);
        if (descInlineMatch) {
          action.description = descInlineMatch[1].trim();
          i++;
          continue;
        }

        const paramsMatch = l.match(/^\s+params:\s*$/);
        if (paramsMatch) {
          i++;
          parseParamsList(lines, i, action.params, (newI) => {
            i = newI;
          });
          continue;
        }
        // params: [] (empty)
        if (l.match(/^\s+params:\s*\[\]\s*$/)) {
          i++;
          continue;
        }

        i++;
      }
      actions.push(action);
    } else {
      i++;
    }
  }
}

function parseParamsList(
  lines: string[],
  startI: number,
  params: AppActionDef['params'],
  setI: (i: number) => void,
): void {
  let i = startI;
  while (i < lines.length) {
    const l = lines[i];
    // Parameter items start with "      - name:"
    const paramNameMatch = l.match(/^\s+-\s+name:\s+(\S+)/);
    if (!paramNameMatch) break;

    const param: AppActionDef['params'][0] = {
      name: paramNameMatch[1],
      type: 'string',
      description: paramNameMatch[1],
    };
    i++;
    while (i < lines.length) {
      const pl = lines[i];
      if (pl.match(/^\s+-\s+name:\s/) || !pl.match(/^\s{8,}/)) break;

      const typeMatch = pl.match(/^\s+type:\s+(\S+)/);
      if (typeMatch) {
        param.type = typeMatch[1];
        i++;
        continue;
      }
      const descMatch = pl.match(/^\s+description:\s+(.+)$/);
      if (descMatch) {
        param.description = descMatch[1].trim();
        i++;
        continue;
      }
      const reqMatch = pl.match(/^\s+required:\s+(true|false)/);
      if (reqMatch) {
        param.required = reqMatch[1] === 'true';
        i++;
        continue;
      }
      const enumMatch = pl.match(/^\s+enum:\s+\[(.+)\]/);
      if (enumMatch) {
        param.enum = enumMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, ''));
        i++;
        continue;
      }
      i++;
    }
    params.push(param);
  }
  setI(i);
}

// ============ Dynamic Loading ============

let _loaded = false;

/**
 * Load all App meta.yaml from disk storage, parse actions and populate APP_REGISTRY.
 * Should be called once before ChatPanel first uses tool definitions.
 */
export async function loadActionsFromMeta(): Promise<void> {
  if (_loaded) return;

  const loaded: AppDef[] = [];

  for (const app of APP_STATIC_REGISTRY) {
    if (app.appName === 'os') {
      loaded.push({ ...app, actions: OS_ACTIONS });
      continue;
    }

    const metaPath = `apps/${app.appName}/meta.yaml`;
    try {
      const content = await idb.getFile(metaPath);
      if (content && typeof content === 'string') {
        const actions = parseMetaYamlActions(content);
        loaded.push({ ...app, actions: withCommonAppActions(app, actions) });
      } else {
        loaded.push({ ...app, actions: withCommonAppActions(app, []) });
      }
    } catch {
      loaded.push({ ...app, actions: withCommonAppActions(app, []) });
    }
  }

  APP_REGISTRY = loaded;
  _loaded = true;
}

/**
 * Reset loading state, forcing a reload on next call to loadActionsFromMeta
 */
export function resetActionsCache(): void {
  APP_REGISTRY = buildDefaultAppRegistry();
  _loaded = false;
}

function findDeclaredAction(app: AppDef | AppStaticDef, actionType: string): AppActionDef | null {
  if (!('actions' in app) || !Array.isArray(app.actions)) {
    return null;
  }

  const normalized = actionType.trim().toUpperCase();
  return app.actions.find((action) => action.name.toUpperCase() === normalized) ?? null;
}

function buildUnsupportedActionError(app: AppDef | AppStaticDef, actionType: string): string {
  const capabilities = buildAppControlCapabilities(app);
  const supportedActions = capabilities.actions.names;
  return JSON.stringify({
    ok: false,
    error: 'unsupported_app_action',
    app: {
      app_id: app.appId,
      app_name: app.appName,
      display_name: app.displayName,
    },
    requested_action: actionType,
    actions_loaded: _loaded,
    supported_actions: supportedActions,
    next_steps: [
      `Call list_apps or get_app_state(app_name="${app.appName}") to inspect current app capabilities.`,
      `Read apps/${app.appName}/meta.yaml for exact app-specific action parameters.`,
      'Use file/schema tools for data mutations when no app-owned action exists.',
    ],
  });
}

// ============ Tool Definition Generation ============

/**
 * Single generic app_action tool that replaces per-app tool definitions.
 * LLM discovers available actions by reading meta.yaml via file tools.
 */
export function getAppActionToolDefinition(): {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  };
} {
  return {
    type: 'function',
    function: {
      name: 'app_action',
      description:
        "Trigger an action on an app. Read the app's meta.yaml first to discover available action types and their parameters. " +
        'Every non-OS app also supports common window actions: OPEN_APP_WINDOW, FOCUS_APP_WINDOW, CLOSE_APP_WINDOW. ' +
        'OS-level actions (OPEN_APP, CLOSE_APP, SET_WALLPAPER) MUST use app_name="os". ' +
        'Use appName/app display names when speaking to the user; numeric app_id values are only tool parameters.',
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description:
              'The appName, displayName, alias, or numeric appId of the target app (from list_apps)',
          },
          action_type: {
            type: 'string',
            description: 'The action type to trigger (e.g. REFRESH_TRACKS, SYNC_STATE, OPEN_APP)',
          },
          params: {
            type: 'string',
            description: 'JSON string of action parameters, e.g. \'{"trackId":"123"}\'',
          },
        },
        required: ['app_name', 'action_type'],
      },
    },
  };
}

/**
 * Execute the generic app_action tool call.
 * Returns { appId, actionType, params } for dispatch, or an error string.
 */
export function resolveAppAction(
  appName: string,
  actionType: string,
): { appId: number; actionType: string; params?: Record<string, string> } | string {
  const app = findAppByReference(appName);
  if (!app) return `error: unknown app "${appName}". Call list_apps to see available apps.`;

  const declaredAction = findDeclaredAction(app, actionType);

  if (app.appName !== 'os') {
    if (declaredAction?.name === 'OPEN_APP_WINDOW') {
      return { appId: 1, actionType: 'OPEN_APP', params: { app_id: String(app.appId) } };
    }
    if (declaredAction?.name === 'FOCUS_APP_WINDOW') {
      return { appId: 1, actionType: 'FOCUS_APP', params: { app_id: String(app.appId) } };
    }
    if (declaredAction?.name === 'CLOSE_APP_WINDOW') {
      return { appId: 1, actionType: 'CLOSE_APP', params: { app_id: String(app.appId) } };
    }
  }

  if (!declaredAction) {
    if (!_loaded) {
      return { appId: app.appId, actionType };
    }
    return buildUnsupportedActionError(app, actionType);
  }

  return { appId: app.appId, actionType: declaredAction.name };
}

// ============ list_apps Tool ============

export function getListAppsToolDefinition(): {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  };
} {
  return {
    type: 'function',
    function: {
      name: 'list_apps',
      description:
        'List all available apps on the device. Returns app names, display names, aliases, and numeric app IDs. Call this first to discover what apps are available.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  };
}

export function executeListApps(): string {
  const visibleApps = APP_REGISTRY.filter((a) => a.appName !== 'os');
  const apps = visibleApps.map((a) => {
    const aliases = a.aliases?.length ? `, aliases: ${a.aliases.join(', ')}` : '';
    return `- ${a.displayName} (appName: ${a.appName}, appId: ${a.appId}, route: ${a.route}${aliases})`;
  });
  const capabilities = visibleApps.map(buildAppControlCapabilities);
  const summary = summarizeAppControlCapabilities(capabilities);
  const capabilityLines = capabilities.map((entry) => `- ${formatAppCapabilityLine(entry)}`);

  return (
    'Available apps:\n' +
    'Use displayName or appName when speaking to the user. Use appId only as an OS OPEN_APP/CLOSE_APP parameter.\n' +
    'Use get_app_intents(app_name=..., include_surfaces=true) to map natural requests to exact app_action, schema write, state write, inspect-only paths, and per-surface coverage.\n' +
    `${apps.join('\n')}\n\n` +
    'Capability inventory:\n' +
    `- summary: ${summary.tool_backed_count}/${summary.app_count} apps have tool-backed controls, ${summary.apps_with_actions} have declared app actions, ${summary.apps_with_schemas} have machine-readable schemas, ${summary.apps_with_bespoke_state_summary} have bespoke state summaries.\n` +
    `${capabilityLines.join('\n')}\n\n` +
    'OS-level actions (use app_name="os"):\n' +
    '- OPEN_APP: open an app (params: app_id; speak using the target app displayName)\n' +
    '- CLOSE_APP: close an app (params: app_id; speak using the target app displayName)\n' +
    '- FOCUS_APP: focus or restore an app (params: app_id; speak using the target app displayName)\n' +
    '- SET_WALLPAPER: change wallpaper (params: wallpaper_url)'
  );
}
