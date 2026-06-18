import type { AppActionDef, AppDef, AppIdentity } from './appRegistry';
import { APP_REGISTRY, getAppIdentityByReference } from './appRegistry';
import type { AppSchemaDocument } from './appSchemaRegistry';
import { listSchemasForApp } from './appSchemaRegistry';

export type AppIntentExecutionKind =
  | 'app_action'
  | 'schema_file_write'
  | 'schema_file_delete'
  | 'state_file_write'
  | 'window_action'
  | 'inspect_only';

export type AppIntentRisk = 'low' | 'medium' | 'high';

export interface AppIntentExecutionContract {
  kind: AppIntentExecutionKind;
  tool_name: string;
  action_type?: string;
  schema_id?: string;
  entity_name?: string;
  file_path_pattern?: string;
  data_root?: string;
  refresh_action_type?: string | null;
  params?: AppActionDef['params'];
  requires_preview: boolean;
  requires_user_approval: boolean;
  notes: string[];
}

export interface AppIntentContract {
  id: string;
  app_id: number;
  app_name: string;
  display_name: string;
  intent: string;
  title: string;
  description: string;
  synonyms: string[];
  execution: AppIntentExecutionContract;
  required_tools: string[];
  risk: AppIntentRisk;
  destructive: boolean;
  external: boolean;
  evidence_refs: string[];
  gaps: string[];
}

export interface AppIntentSummary {
  app_count: number;
  intent_count: number;
  app_action_count: number;
  schema_write_count: number;
  state_write_count: number;
  window_action_count: number;
  destructive_count: number;
  external_count: number;
}

function getDeclaredActions(app: AppIdentity | AppDef): AppActionDef[] {
  if ('actions' in app && Array.isArray(app.actions)) {
    return app.actions;
  }
  return [];
}

function normalizeIntentRef(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function humanizeToken(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function humanizeActionName(actionName: string): string {
  return humanizeToken(actionName);
}

function isWindowAction(actionName: string): boolean {
  return (
    actionName === 'OPEN_APP_WINDOW' ||
    actionName === 'FOCUS_APP_WINDOW' ||
    actionName === 'CLOSE_APP_WINDOW'
  );
}

function isDestructiveAction(actionName: string): boolean {
  return /^(DELETE|TRASH|ARCHIVE|REMOVE|RESET|RESTORE)/i.test(actionName);
}

function isExternalAction(actionName: string): boolean {
  return /(?:EXTERNAL|SEND_EMAIL|OPEN_URL|OPEN_REPORT_EXTERNAL)/i.test(actionName);
}

function isMutatingAction(actionName: string): boolean {
  return /^(CREATE|ADD|SAVE|SEND|UPDATE|PATCH|EDIT|MARK|STAR|UNSTAR|PROMOTE|DEMOTE|DELETE|TRASH|ARCHIVE|REMOVE|PLAY|PAUSE|RESUME|NEXT|PREV|SEEK|SET|PREVIEW|APPLY|RESET|SWITCH|USE|RUN|START|CANCEL|RESTORE)/i.test(
    actionName,
  );
}

function riskForAction(actionName: string): AppIntentRisk {
  if (isDestructiveAction(actionName)) {
    return 'high';
  }
  if (isExternalAction(actionName)) {
    return 'medium';
  }
  if (isMutatingAction(actionName)) {
    return 'medium';
  }
  return 'low';
}

function schemaPathHint(schema: AppSchemaDocument): string {
  return schema.pathPattern.source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/')
    .replace(/\[\^\/\]\+/g, '{id}')
    .replace(/\\\.json/g, '.json')
    .replace(/\\/g, '');
}

function actionMatchesEntity(actionName: string, verb: string, entityName: string): boolean {
  const normalized = actionName.toUpperCase();
  const normalizedEntity = entityName.replace(/[^a-z0-9]/gi, '_').toUpperCase();
  const pluralEntity = `${normalizedEntity}S`;
  return (
    normalized === `${verb}_${normalizedEntity}` ||
    normalized === `${verb}_${pluralEntity}` ||
    normalized.startsWith(`${verb}_${normalizedEntity}_`) ||
    normalized.startsWith(`${verb}_${pluralEntity}_`)
  );
}

function findRefreshAction(
  actions: AppActionDef[],
  entityName: string,
  operation: 'create' | 'update' | 'delete' | 'state',
): string | null {
  const verb =
    operation === 'create'
      ? 'CREATE'
      : operation === 'update'
        ? 'UPDATE'
        : operation === 'delete'
          ? 'DELETE'
          : 'REFRESH';
  const direct =
    operation === 'state'
      ? actions.find((action) => /^REFRESH(?:_|$)/i.test(action.name))
      : actions.find((action) => actionMatchesEntity(action.name, verb, entityName));
  if (direct) {
    return direct.name;
  }
  const refresh = actions.find((action) => /^REFRESH(?:_|$)/i.test(action.name));
  return refresh?.name ?? null;
}

function buildActionIntent(app: AppDef | AppIdentity, action: AppActionDef): AppIntentContract {
  const kind: AppIntentExecutionKind = isWindowAction(action.name) ? 'window_action' : 'app_action';
  const risk = kind === 'window_action' ? 'low' : riskForAction(action.name);
  const destructive = isDestructiveAction(action.name);
  const external = isExternalAction(action.name);
  const intent = normalizeIntentRef(action.name);
  const title = humanizeActionName(action.name);

  return {
    id: `${app.appName}:${intent}`,
    app_id: app.appId,
    app_name: app.appName,
    display_name: app.displayName,
    intent,
    title,
    description: action.description || `${title} on ${app.displayName}`,
    synonyms: [action.name, action.name.toLowerCase(), title, title.toLowerCase(), intent],
    execution: {
      kind,
      tool_name: 'app_action',
      action_type: action.name,
      params: action.params,
      requires_preview: /^PREVIEW_/i.test(action.name) ? false : risk !== 'low',
      requires_user_approval:
        destructive || external || /^(APPLY|RUN|START|RESTORE)/i.test(action.name),
      notes:
        kind === 'window_action'
          ? ['Common window control routed through the OS action bridge.']
          : ['Use the declared app action and pass only documented params.'],
    },
    required_tools: ['app_action'],
    risk,
    destructive,
    external,
    evidence_refs: [`apps/${app.appName}/meta.yaml`],
    gaps: [],
  };
}

function buildSchemaIntent(
  app: AppDef | AppIdentity,
  schema: AppSchemaDocument,
  operation: 'create' | 'update' | 'delete' | 'state',
  refreshActionType: string | null,
): AppIntentContract {
  const isState = operation === 'state';
  const destructive = operation === 'delete';
  const risk: AppIntentRisk = destructive ? 'high' : isState ? 'low' : 'medium';
  const intent = isState ? 'update_state' : `${operation}_${normalizeIntentRef(schema.entityName)}`;
  const title = isState
    ? `Update ${app.displayName} State`
    : `${humanizeToken(operation)} ${humanizeToken(schema.entityName)}`;
  const filePathPattern = schemaPathHint(schema);
  const requiredTools = isState
    ? ['get_app_state', 'get_app_schema', 'file_read', 'file_patch']
    : operation === 'delete'
      ? ['get_app_schema', 'workspace_search', 'file_delete']
      : ['get_app_schema', 'workspace_search', 'file_read', 'file_write'];
  if (refreshActionType) {
    requiredTools.push('app_action');
  }

  return {
    id: `${app.appName}:schema:${intent}`,
    app_id: app.appId,
    app_name: app.appName,
    display_name: app.displayName,
    intent,
    title,
    description: isState
      ? `Update ${app.displayName} UI state through schema-validated app storage.`
      : `${humanizeToken(operation)} ${schema.description} through schema-validated app storage.`,
    synonyms: [
      intent,
      title.toLowerCase(),
      `${operation} ${schema.entityName}`,
      `${operation}_${schema.id}`,
      schema.id,
      schema.entityName,
    ],
    execution: {
      kind: isState
        ? 'state_file_write'
        : operation === 'delete'
          ? 'schema_file_delete'
          : 'schema_file_write',
      tool_name: operation === 'delete' ? 'file_delete' : 'file_write',
      schema_id: schema.id,
      entity_name: schema.entityName,
      file_path_pattern: filePathPattern,
      data_root: `apps/${app.appName}/data`,
      refresh_action_type: refreshActionType,
      requires_preview: risk !== 'low',
      requires_user_approval: destructive,
      notes: [
        'Use get_app_schema before mutation and keep the JSON valid for this schema.',
        refreshActionType
          ? `After the file mutation, call app_action ${refreshActionType}.`
          : 'No matching refresh app_action is declared; verify the app observes storage changes.',
      ],
    },
    required_tools: Array.from(new Set(requiredTools)),
    risk,
    destructive,
    external: false,
    evidence_refs: [`schema:${schema.id}`, `path:${filePathPattern}`],
    gaps: refreshActionType ? [] : ['No matching refresh action is declared for this schema path.'],
  };
}

export function buildAppIntentContracts(app: AppDef | AppIdentity): AppIntentContract[] {
  if (app.appName === 'os') {
    return getDeclaredActions(app).map((action) => buildActionIntent(app, action));
  }

  const actions = getDeclaredActions(app);
  const actionContracts = actions.map((action) => buildActionIntent(app, action));
  const schemas = listSchemasForApp(app.appName);
  const schemaContracts = schemas.flatMap((schema) => {
    if (schema.entityName === 'state') {
      return [
        buildSchemaIntent(app, schema, 'state', findRefreshAction(actions, 'state', 'state')),
      ];
    }
    return [
      buildSchemaIntent(
        app,
        schema,
        'create',
        findRefreshAction(actions, schema.entityName, 'create'),
      ),
      buildSchemaIntent(
        app,
        schema,
        'update',
        findRefreshAction(actions, schema.entityName, 'update'),
      ),
      buildSchemaIntent(
        app,
        schema,
        'delete',
        findRefreshAction(actions, schema.entityName, 'delete'),
      ),
    ];
  });

  const inspectIntent: AppIntentContract = {
    id: `${app.appName}:inspect_state`,
    app_id: app.appId,
    app_name: app.appName,
    display_name: app.displayName,
    intent: 'inspect_state',
    title: `Inspect ${app.displayName} State`,
    description: `Inspect ${app.displayName} windows, current state, summaries, and control capabilities.`,
    synonyms: ['inspect', 'inspect_state', 'read state', 'status', 'current state'],
    execution: {
      kind: 'inspect_only',
      tool_name: 'get_app_state',
      data_root: `apps/${app.appName}/data`,
      requires_preview: false,
      requires_user_approval: false,
      notes: ['Read-only state and capability inspection.'],
    },
    required_tools: ['get_app_state'],
    risk: 'low',
    destructive: false,
    external: false,
    evidence_refs: [`apps/${app.appName}/data/state.json`],
    gaps: [],
  };

  return [inspectIntent, ...schemaContracts, ...actionContracts];
}

export function listAppIntentContracts(appReference?: string): AppIntentContract[] {
  if (appReference?.trim()) {
    const appIdentity = getAppIdentityByReference(appReference);
    const app = appIdentity
      ? APP_REGISTRY.find((entry) => entry.appId === appIdentity.appId)
      : APP_REGISTRY.find((entry) => entry.appName === appReference);
    return app ? buildAppIntentContracts(app) : [];
  }

  return APP_REGISTRY.filter((app) => app.appName !== 'os').flatMap(buildAppIntentContracts);
}

export function findAppIntentContract(
  appReference: string,
  intentReference: string,
): AppIntentContract | null {
  const normalized = normalizeIntentRef(intentReference);
  if (!normalized) {
    return null;
  }

  return (
    listAppIntentContracts(appReference).find((contract) => {
      const values = [
        contract.id,
        contract.intent,
        contract.title,
        contract.execution.action_type ?? '',
        ...contract.synonyms,
      ];
      return values.some((value) => normalizeIntentRef(value) === normalized);
    }) ?? null
  );
}

export function summarizeAppIntentContracts(contracts: AppIntentContract[]): AppIntentSummary {
  const appNames = new Set(contracts.map((contract) => contract.app_name));
  return {
    app_count: appNames.size,
    intent_count: contracts.length,
    app_action_count: contracts.filter((contract) => contract.execution.kind === 'app_action')
      .length,
    schema_write_count: contracts.filter(
      (contract) =>
        contract.execution.kind === 'schema_file_write' ||
        contract.execution.kind === 'schema_file_delete',
    ).length,
    state_write_count: contracts.filter(
      (contract) => contract.execution.kind === 'state_file_write',
    ).length,
    window_action_count: contracts.filter((contract) => contract.execution.kind === 'window_action')
      .length,
    destructive_count: contracts.filter((contract) => contract.destructive).length,
    external_count: contracts.filter((contract) => contract.external).length,
  };
}

export function formatAppIntentContractLine(contract: AppIntentContract): string {
  const actionText = contract.execution.action_type
    ? ` action=${contract.execution.action_type};`
    : '';
  const schemaText = contract.execution.schema_id ? ` schema=${contract.execution.schema_id};` : '';
  const refreshText = contract.execution.refresh_action_type
    ? ` refresh=${contract.execution.refresh_action_type};`
    : '';
  return [
    `${contract.display_name} intent ${contract.intent}:`,
    `kind=${contract.execution.kind};`,
    `tool=${contract.execution.tool_name};`,
    actionText.trim(),
    schemaText.trim(),
    refreshText.trim(),
    `risk=${contract.risk};`,
  ]
    .filter(Boolean)
    .join(' ');
}
