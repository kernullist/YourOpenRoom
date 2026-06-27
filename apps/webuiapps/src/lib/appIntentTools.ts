import type { ToolDef } from './llmClient';

import { APP_REGISTRY, getAppIdentityByReference } from './appRegistry';
import {
  findAppIntentContract,
  formatAppIntentContractLine,
  listAppIntentContracts,
  summarizeAppIntentContracts,
  type AppIntentContract,
} from './appIntentContracts';
import {
  buildAppControlSurfaceContracts,
  formatAppControlSurfaceLine,
  summarizeAppControlSurfaceContracts,
  type AppControlSurfaceContract,
} from './appControlSurfaceContracts';

const TOOL_NAME = 'get_app_intents';

function compactIntent(contract: AppIntentContract): Record<string, unknown> {
  return {
    id: contract.id,
    intent: contract.intent,
    title: contract.title,
    execution: {
      kind: contract.execution.kind,
      tool_name: contract.execution.tool_name,
      action_type: contract.execution.action_type,
      schema_id: contract.execution.schema_id,
      file_path_pattern: contract.execution.file_path_pattern,
      refresh_action_type: contract.execution.refresh_action_type,
      requires_preview: contract.execution.requires_preview,
      requires_user_approval: contract.execution.requires_user_approval,
    },
    required_tools: contract.required_tools,
    risk: contract.risk,
    destructive: contract.destructive,
    external: contract.external,
    gaps: contract.gaps,
  };
}

function fullSurface(contract: AppControlSurfaceContract): Record<string, unknown> {
  return { ...contract };
}

function compactSurface(contract: AppControlSurfaceContract): Record<string, unknown> {
  return {
    id: contract.id,
    surface: contract.surface,
    title: contract.title,
    operations: contract.operations,
    coverage: contract.coverage,
    backing_intent_ids: contract.backing_intent_ids,
    backing_action_types: contract.backing_action_types,
    backing_schema_ids: contract.backing_schema_ids,
    backing_tools: contract.backing_tools,
    gaps: contract.gaps,
  };
}

function buildAllAppsSummary(): string {
  const contracts = listAppIntentContracts();
  const surfaceContracts = APP_REGISTRY.filter((app) => app.appName !== 'os').flatMap(
    buildAppControlSurfaceContracts,
  );
  const apps = APP_REGISTRY.filter((app) => app.appName !== 'os').map((app) => {
    const appContracts = contracts.filter((contract) => contract.app_name === app.appName);
    const appSurfaces = surfaceContracts.filter((contract) => contract.app_name === app.appName);
    return {
      app_id: app.appId,
      app_name: app.appName,
      display_name: app.displayName,
      intent_count: appContracts.length,
      control_surface_count: appSurfaces.length,
      control_surface_coverage: summarizeAppControlSurfaceContracts(appSurfaces),
      intents: appContracts.slice(0, 10).map(compactIntent),
      more_intents: Math.max(0, appContracts.length - 10),
      gap_surfaces: appSurfaces
        .filter((surface) => surface.coverage !== 'covered')
        .map((surface) => ({
          surface: surface.surface,
          coverage: surface.coverage,
          gaps: surface.gaps,
        })),
    };
  });

  return JSON.stringify({
    summary: summarizeAppIntentContracts(contracts),
    control_surface_summary: summarizeAppControlSurfaceContracts(surfaceContracts),
    guidance: [
      'Call get_app_intents with app_name for the target app before deciding an operation path.',
      'Use control_surfaces to decide whether a UI surface is covered, partially covered, or missing backing actions/schemas.',
      'For data mutations, prefer schema_file_write or schema_file_delete contracts over raw app_action refresh actions.',
      'Use app_action directly for window_action and app_action contracts.',
    ],
    apps,
  });
}

function resolveApp(appName: string) {
  const identity = getAppIdentityByReference(appName);
  if (!identity) {
    return null;
  }
  return APP_REGISTRY.find((app) => app.appId === identity.appId) ?? null;
}

export function getAppIntentToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          'Return app intent contracts that map natural app requests to exact app_action, schema file mutation, state mutation, or inspect-only execution paths.',
        parameters: {
          type: 'object',
          properties: {
            app_name: {
              type: 'string',
              description:
                'Optional appName, displayName, alias, or appId, for example "kira", "Notes", or "Aoi Memory".',
            },
            intent: {
              type: 'string',
              description:
                'Optional requested intent, action type, or natural operation name, for example "create_note", "APPLY_MODEL_SETTINGS", or "update state".',
            },
            include_details: {
              type: 'boolean',
              description:
                'When true, return full contract details for all matching app intents. Defaults to false for compact output.',
            },
            include_surfaces: {
              type: 'boolean',
              description:
                'When true, include per-app UI control surface coverage. App-specific calls include compact surfaces by default unless this is false.',
            },
          },
          required: [],
        },
      },
    },
  ];
}

export function isAppIntentTool(toolName: string): boolean {
  return toolName === TOOL_NAME;
}

export function getAppIntentToolPendingSummary(params: Record<string, unknown>): string {
  return `get_app_intents(${String(params.app_name || 'all').slice(0, 48)}${
    params.intent ? `:${String(params.intent).slice(0, 32)}` : ''
  })`;
}

export async function executeAppIntentTool(params: Record<string, unknown>): Promise<string> {
  const appName = String(params.app_name || '').trim();
  const intent = String(params.intent || '').trim();
  const includeDetails = params.include_details === true;
  const includeSurfaces = params.include_surfaces !== false;

  if (!appName) {
    return buildAllAppsSummary();
  }

  const app = resolveApp(appName);
  if (!app) {
    return `error: unknown app "${appName}". Call list_apps first.`;
  }

  const contracts = listAppIntentContracts(app.appName);
  const controlSurfaces = buildAppControlSurfaceContracts(app);
  const controlSurfaceSummary = summarizeAppControlSurfaceContracts(controlSurfaces);
  if (intent) {
    const match = findAppIntentContract(app.appName, intent);
    if (!match) {
      return JSON.stringify({
        ok: false,
        error: 'unsupported_app_intent',
        app: {
          app_id: app.appId,
          app_name: app.appName,
          display_name: app.displayName,
        },
        requested_intent: intent,
        available_intents: contracts.map((contract) => compactIntent(contract)),
        control_surface_summary: controlSurfaceSummary,
        control_surfaces: includeSurfaces
          ? controlSurfaces.map(compactSurface)
          : controlSurfaces.slice(0, 8).map(formatAppControlSurfaceLine),
        next_steps: [
          `Use one of the listed intents for ${app.displayName}.`,
          'If a matching control surface is partial or gap, explain the exact missing action/schema instead of saying the whole app is unavailable.',
          `Call get_app_state(app_name="${app.appName}") if current UI context matters.`,
          `Call get_app_schema(app_name="${app.appName}") before schema-backed storage writes.`,
        ],
      });
    }

    return JSON.stringify({
      ok: true,
      app: {
        app_id: app.appId,
        app_name: app.appName,
        display_name: app.displayName,
      },
      requested_intent: intent,
      contract: match,
      contract_line: formatAppIntentContractLine(match),
      control_surface_summary: controlSurfaceSummary,
      control_surfaces: includeSurfaces
        ? controlSurfaces
            .filter((surface) => surface.backing_intent_ids.includes(match.id))
            .map(includeDetails ? fullSurface : compactSurface)
        : [],
    });
  }

  return JSON.stringify({
    app: {
      app_id: app.appId,
      app_name: app.appName,
      display_name: app.displayName,
      route: app.route,
    },
    summary: summarizeAppIntentContracts(contracts),
    guidance: [
      'Select the closest contract before acting.',
      'Check control_surfaces coverage before claiming a specific UI surface cannot be controlled.',
      'Use schema-backed contracts for persisted data changes.',
      'Use app_action contracts for app-owned operations and window controls.',
    ],
    intents: includeDetails ? contracts : contracts.map(compactIntent),
    contract_lines: contracts.slice(0, 16).map(formatAppIntentContractLine),
    control_surface_summary: controlSurfaceSummary,
    control_surfaces: includeSurfaces
      ? includeDetails
        ? controlSurfaces
        : controlSurfaces.map(compactSurface)
      : [],
    control_surface_lines: controlSurfaces.slice(0, 16).map(formatAppControlSurfaceLine),
  });
}
