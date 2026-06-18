import type { AppDef, AppIdentity } from './appRegistry';
import { APP_REGISTRY, getAppIdentityByReference } from './appRegistry';
import { buildAppIntentContracts, type AppIntentContract } from './appIntentContracts';

export type AppControlSurfaceOperation =
  | 'inspect'
  | 'open'
  | 'focus'
  | 'select'
  | 'navigate'
  | 'filter'
  | 'search'
  | 'create'
  | 'update'
  | 'delete'
  | 'refresh'
  | 'preview'
  | 'apply'
  | 'run'
  | 'cancel'
  | 'playback'
  | 'external'
  | 'sync'
  | 'undo';

export type AppControlSurfaceCoverage = 'covered' | 'partial' | 'gap';

export interface AppControlSurfaceContract {
  id: string;
  app_id: number;
  app_name: string;
  display_name: string;
  surface: string;
  title: string;
  description: string;
  operations: AppControlSurfaceOperation[];
  expected_intents: string[];
  expected_action_types: string[];
  expected_schema_ids: string[];
  expected_tools: string[];
  backing_intent_ids: string[];
  backing_action_types: string[];
  backing_schema_ids: string[];
  backing_tools: string[];
  coverage: AppControlSurfaceCoverage;
  gaps: string[];
  evidence_refs: string[];
}

export interface AppControlSurfaceSummary {
  app_count: number;
  surface_count: number;
  covered_count: number;
  partial_count: number;
  gap_count: number;
  app_action_backed_count: number;
  schema_backed_count: number;
  inspect_backed_count: number;
  apps_with_gaps: string[];
  gap_surfaces: Array<{ app_name: string; surface: string; gaps: string[] }>;
}

interface AppControlSurfaceSeed {
  surface: string;
  title: string;
  description: string;
  operations: AppControlSurfaceOperation[];
  expectedIntents?: string[];
  expectedActionTypes?: string[];
  expectedSchemaIds?: string[];
  expectedTools?: string[];
  evidenceRefs?: string[];
}

const APP_SURFACE_CATALOG: Record<string, AppControlSurfaceSeed[]> = {
  twitter: [
    {
      surface: 'posts',
      title: 'Posts And Reactions',
      description: 'Create, update, delete, like, unlike, or comment on Twitter posts.',
      operations: ['inspect', 'create', 'update', 'delete'],
      expectedActionTypes: [
        'CREATE_POST',
        'UPDATE_POST',
        'DELETE_POST',
        'LIKE_POST',
        'UNLIKE_POST',
        'COMMENT_POST',
      ],
      expectedSchemaIds: ['twitter-post'],
    },
    {
      surface: 'compose_state',
      title: 'Compose State',
      description: 'Inspect or update the draft and current-user state.',
      operations: ['inspect', 'update'],
      expectedSchemaIds: ['twitter-state'],
    },
  ],
  youtube: [
    {
      surface: 'youtube_launcher',
      title: 'YouTube Launcher',
      description: 'Open YouTube home, search results, or a specific video.',
      operations: ['open', 'search', 'navigate'],
      expectedActionTypes: ['OPEN_SEARCH', 'OPEN_HOME', 'OPEN_VIDEO'],
      expectedSchemaIds: ['youtube-state'],
    },
  ],
  diary: [
    {
      surface: 'entries',
      title: 'Diary Entries',
      description: 'Create, update, delete, select, or inspect diary entries.',
      operations: ['inspect', 'create', 'update', 'delete', 'select'],
      expectedActionTypes: [
        'CREATE_ENTRY',
        'UPDATE_ENTRY',
        'DELETE_ENTRY',
        'SELECT_ENTRY',
        'SELECT_DATE',
      ],
      expectedSchemaIds: ['diary-entry', 'diary-state'],
    },
  ],
  album: [
    {
      surface: 'images',
      title: 'Image Metadata',
      description: 'Inspect Album images and refresh the gallery after metadata changes.',
      operations: ['inspect', 'refresh', 'create', 'update', 'delete'],
      expectedActionTypes: ['REFRESH'],
      expectedSchemaIds: ['album-image'],
    },
  ],
  gomoku: [
    {
      surface: 'board',
      title: 'Gomoku Board',
      description: 'Place stones, undo moves, start a new game, surrender, or sync board state.',
      operations: ['inspect', 'run', 'undo', 'sync'],
      expectedActionTypes: ['PLACE_STONE', 'UNDO_MOVE', 'NEW_GAME', 'SURRENDER', 'SYNC_STATE'],
      expectedSchemaIds: ['gomoku-state'],
    },
    {
      surface: 'history',
      title: 'Gomoku History',
      description: 'Inspect or refresh completed game history.',
      operations: ['inspect', 'create', 'update', 'delete', 'refresh'],
      expectedActionTypes: ['CREATE_GAME', 'UPDATE_GAME', 'DELETE_GAME', 'REFRESH_HISTORY'],
      expectedSchemaIds: ['gomoku-history'],
    },
  ],
  freecell: [
    {
      surface: 'game_state',
      title: 'FreeCell Game State',
      description: 'Inspect, sync, or start a FreeCell game.',
      operations: ['inspect', 'run', 'sync'],
      expectedActionTypes: ['SYNC_STATE', 'NEW_GAME'],
      expectedSchemaIds: ['freecell-state'],
    },
  ],
  email: [
    {
      surface: 'mailbox',
      title: 'Mailbox And Messages',
      description: 'Sync, send, draft, read, star, unstar, trash, or inspect email records.',
      operations: ['inspect', 'create', 'update', 'delete', 'sync'],
      expectedActionTypes: [
        'SYNC_EMAIL',
        'SEND_EMAIL',
        'SAVE_DRAFT',
        'MARK_READ',
        'STAR_EMAIL',
        'UNSTAR_EMAIL',
        'TRASH_EMAIL',
      ],
      expectedSchemaIds: ['email-email', 'email-state'],
    },
  ],
  chess: [
    {
      surface: 'board',
      title: 'Chess Board',
      description: 'Inspect board state, ask the agent to move, sync state, or start a game.',
      operations: ['inspect', 'run', 'sync'],
      expectedActionTypes: ['AGENT_MOVE', 'SYNC_STATE', 'NEW_GAME'],
      expectedSchemaIds: ['chess-state'],
    },
  ],
  evidencevault: [
    {
      surface: 'evidence_files',
      title: 'Evidence Files',
      description: 'Open, filter, create, update, delete, refresh, or inspect evidence records.',
      operations: ['inspect', 'open', 'filter', 'create', 'update', 'delete', 'refresh'],
      expectedActionTypes: [
        'REFRESH_EVIDENCE',
        'OPEN_EVIDENCE_FILE',
        'FILTER_EVIDENCE',
        'CREATE_EVIDENCE',
        'UPDATE_EVIDENCE',
        'DELETE_EVIDENCE',
      ],
      expectedSchemaIds: ['evidencevault-file'],
    },
  ],
  cyberNews: [
    {
      surface: 'articles',
      title: 'CyberNews Articles',
      description: 'View, filter, create, update, delete, refresh, or inspect article records.',
      operations: ['inspect', 'open', 'filter', 'create', 'update', 'delete', 'refresh'],
      expectedActionTypes: [
        'VIEW_ARTICLE',
        'FILTER_NEWS',
        'CREATE_ARTICLE',
        'UPDATE_ARTICLE',
        'DELETE_ARTICLE',
        'REFRESH_ARTICLES',
      ],
      expectedSchemaIds: ['cybernews-article', 'cybernews-state'],
    },
    {
      surface: 'cases_and_clues',
      title: 'Cases And Clues',
      description: 'Select cases, move clues, mutate case records, refresh, or sync state.',
      operations: ['inspect', 'select', 'create', 'update', 'delete', 'refresh', 'sync'],
      expectedActionTypes: [
        'SELECT_CASE',
        'MOVE_CLUE',
        'CREATE_CASE',
        'UPDATE_CASE',
        'DELETE_CASE',
        'CREATE_CLUE',
        'UPDATE_CLUE',
        'DELETE_CLUE',
        'REFRESH_CASES',
        'SYNC_STATE',
      ],
      expectedSchemaIds: ['cybernews-case', 'cybernews-state'],
    },
  ],
  calendar: [
    {
      surface: 'events',
      title: 'Calendar Events',
      description: 'Create, update, delete, refresh, select, or inspect calendar events.',
      operations: ['inspect', 'create', 'update', 'delete', 'refresh', 'select'],
      expectedActionTypes: ['CREATE_EVENT', 'UPDATE_EVENT', 'DELETE_EVENT', 'REFRESH_EVENTS'],
      expectedSchemaIds: ['calendar-event', 'calendar-state'],
    },
  ],
  notes: [
    {
      surface: 'notes',
      title: 'Notes',
      description: 'Create, update, delete, refresh, select, filter, or inspect notes.',
      operations: ['inspect', 'create', 'update', 'delete', 'refresh', 'select', 'filter'],
      expectedActionTypes: ['CREATE_NOTE', 'UPDATE_NOTE', 'DELETE_NOTE', 'REFRESH_NOTES'],
      expectedSchemaIds: ['notes-note', 'notes-state'],
    },
  ],
  browser: [
    {
      surface: 'reader',
      title: 'Browser Reader',
      description: 'Open URLs, change reader mode, and inspect Browser state.',
      operations: ['inspect', 'open', 'navigate', 'update'],
      expectedActionTypes: ['OPEN_URL', 'SET_VIEW_MODE', 'REFRESH_DATA'],
      expectedSchemaIds: ['browser-state'],
    },
    {
      surface: 'bookmarks_and_history',
      title: 'Bookmarks And History',
      description: 'Create or delete bookmarks, inspect history, and refresh Browser data.',
      operations: ['inspect', 'create', 'delete', 'refresh'],
      expectedActionTypes: ['CREATE_BOOKMARK', 'DELETE_BOOKMARK', 'REFRESH_DATA'],
      expectedSchemaIds: ['browser-bookmark', 'browser-history'],
    },
  ],
  kira: [
    {
      surface: 'work_board',
      title: 'Kira Work Board',
      description: 'Create, update, delete, refresh, select, or inspect Kira work items.',
      operations: ['inspect', 'create', 'update', 'delete', 'refresh', 'select'],
      expectedActionTypes: ['CREATE_WORK', 'UPDATE_WORK', 'DELETE_WORK', 'REFRESH_KIRA'],
      expectedSchemaIds: ['kira-work', 'kira-state'],
    },
    {
      surface: 'comments',
      title: 'Kira Comments',
      description: 'Create, delete, refresh, or inspect Kira work comments.',
      operations: ['inspect', 'create', 'delete', 'refresh'],
      expectedActionTypes: ['CREATE_COMMENT', 'DELETE_COMMENT', 'REFRESH_KIRA'],
      expectedSchemaIds: ['kira-comment'],
    },
    {
      surface: 'model_settings',
      title: 'Kira Model Settings',
      description: 'Open and apply Kira model, reviewer, worker, and project default settings.',
      operations: ['inspect', 'open', 'apply', 'update'],
      expectedActionTypes: [
        'OPEN_MODEL_SETTINGS',
        'APPLY_MODEL_SETTINGS',
        'APPLY_PROJECT_SETTINGS',
      ],
      expectedIntents: ['inspect_state'],
    },
  ],
  openvscode: [
    {
      surface: 'workspace_files',
      title: 'Workspace Files',
      description: 'Open, create, search, save, refresh, or switch workspace files and folders.',
      operations: ['inspect', 'open', 'search', 'create', 'update', 'refresh'],
      expectedActionTypes: [
        'OPEN_FILE',
        'CREATE_FILE',
        'CREATE_FOLDER',
        'REFRESH_WORKSPACE',
        'SWITCH_WORKSPACE_ROOT',
        'SAVE_FILE',
        'SEARCH_WORKSPACE',
      ],
    },
    {
      surface: 'active_editor',
      title: 'Active Editor',
      description:
        'Preview, apply, discard, undo, append, patch, or replace active editor content.',
      operations: ['inspect', 'preview', 'apply', 'update', 'undo'],
      expectedActionTypes: [
        'PREVIEW_APPEND_ACTIVE_FILE',
        'PREVIEW_PATCH_ACTIVE_FILE',
        'PREVIEW_REPLACE_ACTIVE_FILE',
        'PREVIEW_REPLACE_ACTIVE_SELECTION',
        'APPLY_ACTIVE_FILE_PREVIEW',
        'DISCARD_ACTIVE_FILE_PREVIEW',
        'UNDO_MODEL_ACTION',
        'APPEND_ACTIVE_FILE',
        'PATCH_ACTIVE_FILE',
        'REPLACE_ACTIVE_FILE',
        'REPLACE_ACTIVE_SELECTION',
      ],
    },
    {
      surface: 'diagnostics_tests_git',
      title: 'Diagnostics, Tests, And Git',
      description: 'Run commands, diagnostics, tests, and refresh Git status inside the IDE.',
      operations: ['inspect', 'run', 'refresh'],
      expectedActionTypes: ['RUN_COMMAND', 'RUN_DIAGNOSTICS', 'RUN_TESTS', 'REFRESH_GIT_STATUS'],
    },
    {
      surface: 'checkpoints_and_semantic_navigation',
      title: 'Checkpoints And Semantic Navigation',
      description: 'Create, list, restore, or delete checkpoints and open semantic navigation.',
      operations: ['inspect', 'create', 'delete', 'run', 'navigate'],
      expectedActionTypes: [
        'LIST_WORKSPACE_CHECKPOINTS',
        'CREATE_WORKSPACE_CHECKPOINT',
        'RESTORE_WORKSPACE_CHECKPOINT',
        'DELETE_WORKSPACE_CHECKPOINT',
        'OPEN_SEMANTIC_NAVIGATION',
      ],
    },
  ],
  peanalyzer: [
    {
      surface: 'samples_and_analysis',
      title: 'Samples And Analysis',
      description:
        'Use the current IDB, open samples, run triage, show analysis, or refresh state.',
      operations: ['inspect', 'open', 'run', 'select', 'refresh'],
      expectedActionTypes: [
        'USE_CURRENT_IDB',
        'OPEN_SAMPLE',
        'RUN_QUICK_TRIAGE',
        'SHOW_ANALYSIS',
        'REFRESH_PE_ANALYZER',
      ],
      expectedSchemaIds: ['peanalyzer-state'],
    },
    {
      surface: 'analysis_artifacts',
      title: 'Analysis Artifacts',
      description: 'Inspect persisted sample and analysis artifacts when schemas exist.',
      operations: ['inspect', 'create', 'update', 'delete'],
      expectedActionTypes: ['SHOW_ANALYSIS', 'REFRESH_PE_ANALYZER'],
      expectedSchemaIds: ['peanalyzer-sample', 'peanalyzer-analysis'],
    },
  ],
  roomshop: [
    {
      surface: 'room_theme',
      title: 'Room Theme',
      description: 'Preview, apply, reset, refresh, or inspect Room Shop wallpaper and mood state.',
      operations: ['inspect', 'preview', 'apply', 'refresh'],
      expectedActionTypes: [
        'REFRESH_ROOM_SHOP',
        'PREVIEW_ROOM_ITEM',
        'APPLY_ROOM_ITEM',
        'RESET_ROOM_THEME',
      ],
      expectedSchemaIds: ['roomshop-state'],
    },
  ],
  dewdropcanvas: [
    {
      surface: 'canvas_state',
      title: 'Canvas State',
      description: 'Inspect, refresh, status-check, or open Dewdrop Canvas externally.',
      operations: ['inspect', 'refresh', 'external'],
      expectedActionTypes: [
        'REFRESH_DEWDROP_CANVAS',
        'CHECK_DEWDROP_CANVAS_STATUS',
        'OPEN_DEWDROP_CANVAS_EXTERNAL',
      ],
      expectedSchemaIds: ['dewdropcanvas-state'],
    },
    {
      surface: 'canvas_documents',
      title: 'Canvas Documents, Nodes, And Edges',
      description: 'Track whether document, node, and edge storage has machine-readable contracts.',
      operations: ['inspect', 'create', 'update', 'delete'],
      expectedActionTypes: ['REFRESH_DEWDROP_CANVAS'],
      expectedSchemaIds: ['dewdropcanvas-document', 'dewdropcanvas-node', 'dewdropcanvas-edge'],
    },
  ],
  writtenbyme: [
    {
      surface: 'analysis_state',
      title: 'Analysis State',
      description: 'Inspect, refresh, status-check, or open Written By Me externally.',
      operations: ['inspect', 'refresh', 'external'],
      expectedActionTypes: [
        'REFRESH_WRITTEN_BY_ME',
        'CHECK_WRITTEN_BY_ME_STATUS',
        'OPEN_WRITTEN_BY_ME_EXTERNAL',
      ],
      expectedSchemaIds: ['writtenbyme-state'],
    },
    {
      surface: 'writing_corpus',
      title: 'Writing Corpus',
      description: 'Track whether writing profiles, samples, and analysis artifacts have schemas.',
      operations: ['inspect', 'create', 'update', 'delete'],
      expectedActionTypes: ['REFRESH_WRITTEN_BY_ME'],
      expectedSchemaIds: ['writtenbyme-profile', 'writtenbyme-sample', 'writtenbyme-analysis'],
    },
  ],
  aoiresearch: [
    {
      surface: 'research_library',
      title: 'Research Library',
      description: 'Refresh Aoi Research runs, open reports, and inspect selected run state.',
      operations: ['inspect', 'open', 'refresh'],
      expectedActionTypes: ['REFRESH_AOI_RESEARCH_RUNS', 'OPEN_AOI_RESEARCH_REPORT'],
      expectedSchemaIds: ['aoiresearch-state'],
    },
    {
      surface: 'research_artifacts',
      title: 'Research Artifacts',
      description: 'Track whether run and report artifacts have app-storage mutation contracts.',
      operations: ['inspect', 'create', 'update', 'delete'],
      expectedActionTypes: ['REFRESH_AOI_RESEARCH_RUNS'],
      expectedSchemaIds: ['aoiresearch-run', 'aoiresearch-report'],
    },
  ],
  aoimemory: [
    {
      surface: 'memory_dashboard',
      title: 'Memory Dashboard',
      description: 'Refresh, filter, archive, and inspect Aoi Memory dashboard state.',
      operations: ['inspect', 'filter', 'refresh', 'delete'],
      expectedActionTypes: [
        'REFRESH_AOI_MEMORY_DASHBOARD',
        'FILTER_AOI_MEMORY',
        'ARCHIVE_AOI_MEMORY',
      ],
      expectedSchemaIds: ['aoimemory-state'],
    },
    {
      surface: 'memory_records',
      title: 'Memory Records',
      description:
        'Track whether promote, demote, archive, delete, and record schemas are exposed.',
      operations: ['inspect', 'update', 'delete'],
      expectedActionTypes: [
        'PROMOTE_AOI_MEMORY',
        'DEMOTE_AOI_MEMORY',
        'ARCHIVE_AOI_MEMORY',
        'DELETE_AOI_MEMORY',
      ],
      expectedSchemaIds: ['aoimemory-memory'],
    },
  ],
};

function normalizeRef(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function contractValues(contract: AppIntentContract): string[] {
  return [
    contract.id,
    contract.intent,
    contract.title,
    contract.execution.action_type ?? '',
    contract.execution.schema_id ?? '',
    contract.execution.entity_name ?? '',
    ...contract.synonyms,
  ];
}

function contractMatchesIntent(contract: AppIntentContract, intent: string): boolean {
  const normalized = normalizeRef(intent);
  return contractValues(contract).some((value) => normalizeRef(value) === normalized);
}

function contractMatchesAction(contract: AppIntentContract, actionType: string): boolean {
  return normalizeRef(contract.execution.action_type ?? '') === normalizeRef(actionType);
}

function contractMatchesSchema(contract: AppIntentContract, schemaId: string): boolean {
  return normalizeRef(contract.execution.schema_id ?? '') === normalizeRef(schemaId);
}

function contractMatchesTool(contract: AppIntentContract, toolName: string): boolean {
  return (
    normalizeRef(contract.execution.tool_name) === normalizeRef(toolName) ||
    contract.required_tools.some(
      (requiredTool) => normalizeRef(requiredTool) === normalizeRef(toolName),
    )
  );
}

function contractMatchesSeed(contract: AppIntentContract, seed: AppControlSurfaceSeed): boolean {
  return (
    (seed.expectedIntents ?? []).some((intent) => contractMatchesIntent(contract, intent)) ||
    (seed.expectedActionTypes ?? []).some((actionType) =>
      contractMatchesAction(contract, actionType),
    ) ||
    (seed.expectedSchemaIds ?? []).some((schemaId) => contractMatchesSchema(contract, schemaId)) ||
    (seed.expectedTools ?? []).some((toolName) => contractMatchesTool(contract, toolName))
  );
}

function missingExpectedRefs(
  contracts: AppIntentContract[],
  refs: string[],
  label: string,
  matcher: (contract: AppIntentContract, ref: string) => boolean,
): string[] {
  return refs
    .filter((ref) => !contracts.some((contract) => matcher(contract, ref)))
    .map((ref) => `Missing ${label}: ${ref}`);
}

function buildBaseSurfaceSeeds(app: AppDef | AppIdentity): AppControlSurfaceSeed[] {
  if (app.appName === 'os') {
    return [];
  }

  return [
    {
      surface: 'window_controls',
      title: `${app.displayName} Window Controls`,
      description: `Open, focus, restore, or close the ${app.displayName} window.`,
      operations: ['open', 'focus'],
      expectedActionTypes: ['OPEN_APP_WINDOW', 'FOCUS_APP_WINDOW', 'CLOSE_APP_WINDOW'],
      evidenceRefs: [`apps/${app.appName}/meta.yaml`, 'common-app-window-actions'],
    },
    {
      surface: 'state_snapshot',
      title: `${app.displayName} State Snapshot`,
      description: `Inspect ${app.displayName} windows, current state summary, capability inventory, and contracts.`,
      operations: ['inspect'],
      expectedIntents: ['inspect_state'],
      evidenceRefs: [`apps/${app.appName}/data/state.json`],
    },
  ];
}

function buildSurfaceContract(
  app: AppDef | AppIdentity,
  seed: AppControlSurfaceSeed,
  intentContracts: AppIntentContract[],
): AppControlSurfaceContract {
  const backingContracts = intentContracts.filter((contract) =>
    contractMatchesSeed(contract, seed),
  );
  const expectedIntents = seed.expectedIntents ?? [];
  const expectedActionTypes = seed.expectedActionTypes ?? [];
  const expectedSchemaIds = seed.expectedSchemaIds ?? [];
  const expectedTools = seed.expectedTools ?? [];
  const backingIntentIds = unique(backingContracts.map((contract) => contract.id));
  const backingActionTypes = unique(
    backingContracts.map((contract) => contract.execution.action_type ?? '').filter(Boolean),
  );
  const backingSchemaIds = unique(
    backingContracts.map((contract) => contract.execution.schema_id ?? '').filter(Boolean),
  );
  const backingTools = unique(
    backingContracts.flatMap((contract) => [
      contract.execution.tool_name,
      ...contract.required_tools,
    ]),
  );
  const missingRefs = [
    ...missingExpectedRefs(intentContracts, expectedIntents, 'intent', contractMatchesIntent),
    ...missingExpectedRefs(intentContracts, expectedActionTypes, 'action', contractMatchesAction),
    ...missingExpectedRefs(intentContracts, expectedSchemaIds, 'schema', contractMatchesSchema),
    ...missingExpectedRefs(intentContracts, expectedTools, 'tool', contractMatchesTool),
  ];
  const backingGaps = unique(backingContracts.flatMap((contract) => contract.gaps));
  const gaps = unique([...missingRefs, ...backingGaps]);
  const coverage: AppControlSurfaceCoverage =
    backingContracts.length === 0 ? 'gap' : gaps.length > 0 ? 'partial' : 'covered';
  const evidenceRefs = unique([
    ...(seed.evidenceRefs ?? []),
    `apps/${app.appName}/meta.yaml`,
    ...expectedSchemaIds.map((schemaId) => `schema:${schemaId}`),
    ...backingContracts.flatMap((contract) => contract.evidence_refs),
  ]);

  return {
    id: `${app.appName}:${seed.surface}`,
    app_id: app.appId,
    app_name: app.appName,
    display_name: app.displayName,
    surface: seed.surface,
    title: seed.title,
    description: seed.description,
    operations: seed.operations,
    expected_intents: expectedIntents,
    expected_action_types: expectedActionTypes,
    expected_schema_ids: expectedSchemaIds,
    expected_tools: expectedTools,
    backing_intent_ids: backingIntentIds,
    backing_action_types: backingActionTypes,
    backing_schema_ids: backingSchemaIds,
    backing_tools: backingTools,
    coverage,
    gaps,
    evidence_refs: evidenceRefs,
  };
}

export function buildAppControlSurfaceContracts(
  app: AppDef | AppIdentity,
): AppControlSurfaceContract[] {
  if (app.appName === 'os') {
    return [];
  }

  const intentContracts = buildAppIntentContracts(app);
  const seeds = [...buildBaseSurfaceSeeds(app), ...(APP_SURFACE_CATALOG[app.appName] ?? [])];

  return seeds.map((seed) => buildSurfaceContract(app, seed, intentContracts));
}

export function listAppControlSurfaceContracts(appReference?: string): AppControlSurfaceContract[] {
  if (appReference?.trim()) {
    const appIdentity = getAppIdentityByReference(appReference);
    const app = appIdentity
      ? APP_REGISTRY.find((entry) => entry.appId === appIdentity.appId)
      : APP_REGISTRY.find((entry) => entry.appName === appReference);
    return app ? buildAppControlSurfaceContracts(app) : [];
  }

  return APP_REGISTRY.filter((app) => app.appName !== 'os').flatMap(
    buildAppControlSurfaceContracts,
  );
}

export function findAppControlSurfaceContract(
  appReference: string,
  surfaceReference: string,
): AppControlSurfaceContract | null {
  const normalized = normalizeRef(surfaceReference);
  if (!normalized) {
    return null;
  }

  return (
    listAppControlSurfaceContracts(appReference).find((contract) => {
      const values = [
        contract.id,
        contract.surface,
        contract.title,
        ...contract.expected_intents,
        ...contract.expected_action_types,
        ...contract.expected_schema_ids,
        ...contract.backing_intent_ids,
        ...contract.backing_action_types,
        ...contract.backing_schema_ids,
      ];
      return values.some((value) => normalizeRef(value) === normalized);
    }) ?? null
  );
}

export function summarizeAppControlSurfaceContracts(
  contracts: AppControlSurfaceContract[],
): AppControlSurfaceSummary {
  const appNames = new Set(contracts.map((contract) => contract.app_name));
  const gapSurfaces = contracts
    .filter((contract) => contract.coverage !== 'covered')
    .map((contract) => ({
      app_name: contract.app_name,
      surface: contract.surface,
      gaps: contract.gaps,
    }));

  return {
    app_count: appNames.size,
    surface_count: contracts.length,
    covered_count: contracts.filter((contract) => contract.coverage === 'covered').length,
    partial_count: contracts.filter((contract) => contract.coverage === 'partial').length,
    gap_count: contracts.filter((contract) => contract.coverage === 'gap').length,
    app_action_backed_count: contracts.filter(
      (contract) => contract.backing_action_types.length > 0,
    ).length,
    schema_backed_count: contracts.filter((contract) => contract.backing_schema_ids.length > 0)
      .length,
    inspect_backed_count: contracts.filter((contract) =>
      contract.backing_tools.includes('get_app_state'),
    ).length,
    apps_with_gaps: Array.from(new Set(gapSurfaces.map((surface) => surface.app_name))).sort(),
    gap_surfaces: gapSurfaces,
  };
}

export function formatAppControlSurfaceLine(contract: AppControlSurfaceContract): string {
  const actions =
    contract.backing_action_types.length > 0
      ? `actions=${contract.backing_action_types.slice(0, 6).join(',')}${
          contract.backing_action_types.length > 6
            ? `,+${contract.backing_action_types.length - 6}`
            : ''
        };`
      : '';
  const schemas =
    contract.backing_schema_ids.length > 0
      ? `schemas=${contract.backing_schema_ids.slice(0, 4).join(',')}${
          contract.backing_schema_ids.length > 4
            ? `,+${contract.backing_schema_ids.length - 4}`
            : ''
        };`
      : '';
  const gapText = contract.gaps.length > 0 ? `gaps=${contract.gaps.slice(0, 3).join(' | ')};` : '';

  return [
    `${contract.display_name} surface ${contract.surface}:`,
    `coverage=${contract.coverage};`,
    `ops=${contract.operations.join(',')};`,
    actions,
    schemas,
    gapText,
  ]
    .filter(Boolean)
    .join(' ');
}
