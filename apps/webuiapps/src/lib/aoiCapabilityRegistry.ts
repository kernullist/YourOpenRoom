import { isParallelSafeToolName } from './toolBatching';
import { isCacheableToolName } from './toolResultCache';
import type { AppDef, AppIdentity } from './appRegistry';
import { APP_REGISTRY } from './appRegistry';
import {
  buildAppIntentContracts,
  type AppIntentContract,
  type AppIntentExecutionKind,
} from './appIntentContracts';

export type AoiCapabilityRisk = 'low' | 'medium' | 'high';

export type AoiCapabilitySurface =
  | 'chat'
  | 'memory'
  | 'app-runtime'
  | 'app-storage'
  | 'workspace'
  | 'ide'
  | 'web'
  | 'media'
  | 'diagnostics'
  | 'recovery'
  | 'automation';

export type AoiCapabilityKind = 'tool' | 'skill' | 'plugin' | 'mcp' | 'harness';

export type AoiCapabilityAccess =
  | 'read'
  | 'write'
  | 'execute'
  | 'network'
  | 'external'
  | 'credential'
  | 'irreversible';

export type AoiCapabilityApproval = 'none' | 'policy-gated' | 'user-confirmation';

export interface AoiCapabilityMetadata {
  name: string;
  label: string;
  kind: AoiCapabilityKind;
  surface: AoiCapabilitySurface;
  risk: AoiCapabilityRisk;
  description: string;
  access: readonly AoiCapabilityAccess[];
  sandboxEligible: boolean;
  approval: AoiCapabilityApproval;
  promptVisible: boolean;
  policyNotes?: string;
}

export interface AoiCapabilityRow extends Omit<AoiCapabilityMetadata, 'risk' | 'surface'> {
  risk: AoiCapabilityRisk | 'unknown';
  surface: AoiCapabilitySurface | 'unknown';
  registered: boolean;
  parallelSafe: boolean;
  cacheable: boolean;
}

export interface AoiCapabilitySummary {
  total: number;
  registered: number;
  unknown: number;
  promptVisible: number;
  sandboxEligible: number;
  parallelSafe: number;
  cacheable: number;
  writeOrExecute: number;
  external: number;
  byRisk: Record<AoiCapabilityRisk | 'unknown', number>;
  bySurface: Array<{ surface: AoiCapabilitySurface | 'unknown'; count: number }>;
  highRiskTools: string[];
  unknownTools: string[];
}

const AOI_CAPABILITY_REGISTRY = {
  respond_to_user: {
    name: 'respond_to_user',
    label: 'Respond to user',
    kind: 'tool',
    surface: 'chat',
    risk: 'low',
    description: 'Send the assistant reply, emotion, and suggested replies to the chat UI.',
    access: ['write'],
    sandboxEligible: false,
    approval: 'none',
    promptVisible: true,
  },
  finish_target: {
    name: 'finish_target',
    label: 'Finish story target',
    kind: 'tool',
    surface: 'chat',
    risk: 'low',
    description: 'Mark local story targets as completed.',
    access: ['write'],
    sandboxEligible: false,
    approval: 'none',
    promptVisible: true,
  },
  save_memory: {
    name: 'save_memory',
    label: 'Save memory',
    kind: 'tool',
    surface: 'memory',
    risk: 'medium',
    description: 'Persist a long-term memory item for the current character session.',
    access: ['write'],
    sandboxEligible: false,
    approval: 'policy-gated',
    promptVisible: true,
    policyNotes: 'Must be paired with respond_to_user in the same turn.',
  },
  list_apps: {
    name: 'list_apps',
    label: 'List apps',
    kind: 'tool',
    surface: 'app-runtime',
    risk: 'low',
    description: 'Discover available local apps and app names.',
    access: ['read'],
    sandboxEligible: false,
    approval: 'none',
    promptVisible: true,
  },
  app_action: {
    name: 'app_action',
    label: 'App action',
    kind: 'tool',
    surface: 'app-runtime',
    risk: 'high',
    description: 'Trigger a local app action after app metadata discovery.',
    access: ['execute', 'write'],
    sandboxEligible: true,
    approval: 'policy-gated',
    promptVisible: true,
    policyNotes:
      'Storage data mutations use storage tools; declared app-owned operation/settings actions may persist through app validation paths.',
  },
  get_app_state: {
    name: 'get_app_state',
    label: 'Get app state',
    kind: 'tool',
    surface: 'app-runtime',
    risk: 'low',
    description: 'Read active window, app, or IDE state snapshots.',
    access: ['read'],
    sandboxEligible: false,
    approval: 'none',
    promptVisible: true,
  },
  get_app_schema: {
    name: 'get_app_schema',
    label: 'Get app schema',
    kind: 'tool',
    surface: 'app-storage',
    risk: 'low',
    description: 'Read machine-readable app storage schemas.',
    access: ['read'],
    sandboxEligible: false,
    approval: 'none',
    promptVisible: true,
  },
  file_read: {
    name: 'file_read',
    label: 'Read app file',
    kind: 'tool',
    surface: 'app-storage',
    risk: 'low',
    description: 'Read a file from session app storage.',
    access: ['read'],
    sandboxEligible: true,
    approval: 'none',
    promptVisible: true,
  },
  file_write: {
    name: 'file_write',
    label: 'Write app file',
    kind: 'tool',
    surface: 'app-storage',
    risk: 'high',
    description: 'Create or replace a file in session app storage.',
    access: ['write'],
    sandboxEligible: true,
    approval: 'policy-gated',
    promptVisible: true,
  },
  file_patch: {
    name: 'file_patch',
    label: 'Patch app file',
    kind: 'tool',
    surface: 'app-storage',
    risk: 'high',
    description: 'Apply a targeted text patch to a session app storage file.',
    access: ['write'],
    sandboxEligible: true,
    approval: 'policy-gated',
    promptVisible: true,
  },
  file_list: {
    name: 'file_list',
    label: 'List app files',
    kind: 'tool',
    surface: 'app-storage',
    risk: 'low',
    description: 'List files under session app storage.',
    access: ['read'],
    sandboxEligible: true,
    approval: 'none',
    promptVisible: true,
  },
  file_delete: {
    name: 'file_delete',
    label: 'Delete app file',
    kind: 'tool',
    surface: 'app-storage',
    risk: 'high',
    description: 'Delete a file from session app storage.',
    access: ['write', 'irreversible'],
    sandboxEligible: true,
    approval: 'policy-gated',
    promptVisible: true,
  },
  search_web: {
    name: 'search_web',
    label: 'Search web',
    kind: 'tool',
    surface: 'web',
    risk: 'medium',
    description: 'Run a Tavily-backed web search for current information.',
    access: ['read', 'network', 'external'],
    sandboxEligible: false,
    approval: 'none',
    promptVisible: true,
  },
  read_url: {
    name: 'read_url',
    label: 'Read URL',
    kind: 'tool',
    surface: 'web',
    risk: 'medium',
    description: 'Fetch and extract readable content from a specific URL.',
    access: ['read', 'network', 'external'],
    sandboxEligible: false,
    approval: 'none',
    promptVisible: true,
  },
  start_research: {
    name: 'start_research',
    label: 'Start research',
    kind: 'tool',
    surface: 'web',
    risk: 'medium',
    description: 'Start a structured Aoi research run that writes local report artifacts.',
    access: ['read', 'write', 'network', 'external'],
    sandboxEligible: false,
    approval: 'none',
    promptVisible: true,
  },
  get_research_status: {
    name: 'get_research_status',
    label: 'Get research status',
    kind: 'tool',
    surface: 'web',
    risk: 'low',
    description: 'Read status, phase, counts, and artifact availability for a research run.',
    access: ['read'],
    sandboxEligible: false,
    approval: 'none',
    promptVisible: true,
  },
  read_research_artifact: {
    name: 'read_research_artifact',
    label: 'Read research artifact',
    kind: 'tool',
    surface: 'web',
    risk: 'low',
    description: 'Read a manifest, report, sources, or evidence artifact for a research run.',
    access: ['read'],
    sandboxEligible: false,
    approval: 'none',
    promptVisible: true,
  },
  cancel_research: {
    name: 'cancel_research',
    label: 'Cancel research',
    kind: 'tool',
    surface: 'web',
    risk: 'medium',
    description: 'Cancel a queued or running Aoi research run.',
    access: ['write'],
    sandboxEligible: false,
    approval: 'none',
    promptVisible: true,
  },
  generate_image: {
    name: 'generate_image',
    label: 'Generate image',
    kind: 'tool',
    surface: 'media',
    risk: 'medium',
    description: 'Generate an image through the configured image provider.',
    access: ['write', 'network', 'external'],
    sandboxEligible: false,
    approval: 'none',
    promptVisible: true,
  },
  workspace_search: {
    name: 'workspace_search',
    label: 'Search app workspace',
    kind: 'tool',
    surface: 'workspace',
    risk: 'low',
    description: 'Search session app storage without mutating files.',
    access: ['read'],
    sandboxEligible: true,
    approval: 'none',
    promptVisible: true,
  },
  ide_search: {
    name: 'ide_search',
    label: 'Search IDE workspace',
    kind: 'tool',
    surface: 'ide',
    risk: 'low',
    description: 'Search the configured real IDE workspace.',
    access: ['read'],
    sandboxEligible: true,
    approval: 'none',
    promptVisible: true,
  },
  ide_current_file: {
    name: 'ide_current_file',
    label: 'Read current IDE file',
    kind: 'tool',
    surface: 'ide',
    risk: 'low',
    description: 'Read the active IDE file, selection, and unsaved buffer snapshot.',
    access: ['read'],
    sandboxEligible: true,
    approval: 'none',
    promptVisible: true,
  },
  ide_read_file: {
    name: 'ide_read_file',
    label: 'Read IDE file',
    kind: 'tool',
    surface: 'ide',
    risk: 'low',
    description: 'Read a known file from the configured IDE workspace.',
    access: ['read'],
    sandboxEligible: true,
    approval: 'none',
    promptVisible: true,
  },
  ide_patch_file: {
    name: 'ide_patch_file',
    label: 'Patch IDE file',
    kind: 'tool',
    surface: 'ide',
    risk: 'high',
    description: 'Patch a known file in the configured IDE workspace.',
    access: ['write'],
    sandboxEligible: true,
    approval: 'policy-gated',
    promptVisible: true,
  },
  ide_write_file: {
    name: 'ide_write_file',
    label: 'Write IDE file',
    kind: 'tool',
    surface: 'ide',
    risk: 'high',
    description: 'Create or replace a known file in the configured IDE workspace.',
    access: ['write'],
    sandboxEligible: true,
    approval: 'policy-gated',
    promptVisible: true,
  },
  open_symbol: {
    name: 'open_symbol',
    label: 'Open symbol',
    kind: 'tool',
    surface: 'ide',
    risk: 'low',
    description: 'Open or locate a symbol in the IDE workspace.',
    access: ['read'],
    sandboxEligible: true,
    approval: 'none',
    promptVisible: true,
  },
  find_references: {
    name: 'find_references',
    label: 'Find references',
    kind: 'tool',
    surface: 'ide',
    risk: 'low',
    description: 'Find symbol references with semantic workspace support.',
    access: ['read'],
    sandboxEligible: true,
    approval: 'none',
    promptVisible: true,
  },
  list_exports: {
    name: 'list_exports',
    label: 'List exports',
    kind: 'tool',
    surface: 'ide',
    risk: 'low',
    description: 'List exports from a file or workspace scope.',
    access: ['read'],
    sandboxEligible: true,
    approval: 'none',
    promptVisible: true,
  },
  peek_definition: {
    name: 'peek_definition',
    label: 'Peek definition',
    kind: 'tool',
    surface: 'ide',
    risk: 'low',
    description: 'Read a compact symbol definition excerpt.',
    access: ['read'],
    sandboxEligible: true,
    approval: 'none',
    promptVisible: true,
  },
  rename_preview: {
    name: 'rename_preview',
    label: 'Rename preview',
    kind: 'tool',
    surface: 'ide',
    risk: 'low',
    description: 'Preview a semantic rename before applying it.',
    access: ['read'],
    sandboxEligible: true,
    approval: 'none',
    promptVisible: true,
  },
  apply_semantic_rename: {
    name: 'apply_semantic_rename',
    label: 'Apply semantic rename',
    kind: 'tool',
    surface: 'ide',
    risk: 'high',
    description: 'Apply a previously previewed semantic rename.',
    access: ['write'],
    sandboxEligible: true,
    approval: 'policy-gated',
    promptVisible: true,
    policyNotes: 'Requires a matching rename_preview signature.',
  },
  run_command: {
    name: 'run_command',
    label: 'Run command',
    kind: 'tool',
    surface: 'diagnostics',
    risk: 'high',
    description: 'Run safe allowlisted workspace verification commands.',
    access: ['execute'],
    sandboxEligible: true,
    approval: 'policy-gated',
    promptVisible: true,
  },
  structured_diagnostics: {
    name: 'structured_diagnostics',
    label: 'Structured diagnostics',
    kind: 'tool',
    surface: 'diagnostics',
    risk: 'medium',
    description: 'Run diagnostics and return structured findings.',
    access: ['execute', 'read'],
    sandboxEligible: true,
    approval: 'policy-gated',
    promptVisible: true,
  },
  preview_changes: {
    name: 'preview_changes',
    label: 'Preview changes',
    kind: 'tool',
    surface: 'recovery',
    risk: 'low',
    description: 'Preview exact file mutation impact before applying changes.',
    access: ['read'],
    sandboxEligible: true,
    approval: 'none',
    promptVisible: true,
  },
  undo_last_action: {
    name: 'undo_last_action',
    label: 'Undo last action',
    kind: 'tool',
    surface: 'recovery',
    risk: 'medium',
    description: 'Revert the latest reversible file mutation in the session.',
    access: ['write'],
    sandboxEligible: true,
    approval: 'policy-gated',
    promptVisible: true,
  },
  workspace_checkpoint: {
    name: 'workspace_checkpoint',
    label: 'Workspace checkpoint',
    kind: 'tool',
    surface: 'recovery',
    risk: 'high',
    description: 'Create, list, restore, or delete workspace checkpoints.',
    access: ['read', 'write'],
    sandboxEligible: true,
    approval: 'policy-gated',
    promptVisible: true,
  },
  autofix_diagnostics: {
    name: 'autofix_diagnostics',
    label: 'Autofix diagnostics',
    kind: 'tool',
    surface: 'automation',
    risk: 'high',
    description: 'Start an IDE checkpoint and diagnostic-driven fix cycle.',
    access: ['execute', 'write'],
    sandboxEligible: true,
    approval: 'policy-gated',
    promptVisible: true,
  },
  background_watch: {
    name: 'background_watch',
    label: 'Background watch',
    kind: 'tool',
    surface: 'automation',
    risk: 'medium',
    description: 'Register a local directory watcher for future IDE or app-storage changes.',
    access: ['read', 'execute'],
    sandboxEligible: true,
    approval: 'policy-gated',
    promptVisible: true,
  },
} as const satisfies Record<string, AoiCapabilityMetadata>;

export const AOI_DEFAULT_CAPABILITY_NAMES = Object.keys(AOI_CAPABILITY_REGISTRY).sort();

export function getAoiCapabilityMetadata(toolName: string): AoiCapabilityMetadata | null {
  return AOI_CAPABILITY_REGISTRY[toolName as keyof typeof AOI_CAPABILITY_REGISTRY] ?? null;
}

export function getAoiCapabilityRows(toolNames = AOI_DEFAULT_CAPABILITY_NAMES): AoiCapabilityRow[] {
  return dedupeNames(toolNames).map((name) => {
    const metadata = getAoiCapabilityMetadata(name);
    if (!metadata) {
      return {
        name,
        label: name,
        kind: 'tool',
        surface: 'unknown',
        risk: 'unknown',
        description: 'Unregistered capability. Review before exposing this tool to the model.',
        access: [],
        sandboxEligible: false,
        approval: 'user-confirmation',
        promptVisible: true,
        registered: false,
        parallelSafe: isParallelSafeToolName(name),
        cacheable: isCacheableToolName(name),
      };
    }

    return {
      ...metadata,
      registered: true,
      parallelSafe: isParallelSafeToolName(name),
      cacheable: isCacheableToolName(name),
    };
  });
}

export function getUnknownAoiCapabilityNames(toolNames: string[]): string[] {
  return getAoiCapabilityRows(toolNames)
    .filter((row) => !row.registered)
    .map((row) => row.name);
}

export function summarizeAoiCapabilityRegistry(
  toolNames = AOI_DEFAULT_CAPABILITY_NAMES,
): AoiCapabilitySummary {
  const rows = getAoiCapabilityRows(toolNames);
  const byRisk: AoiCapabilitySummary['byRisk'] = {
    low: 0,
    medium: 0,
    high: 0,
    unknown: 0,
  };
  const surfaceCounts = new Map<AoiCapabilitySurface | 'unknown', number>();
  let promptVisible = 0;
  let sandboxEligible = 0;
  let parallelSafe = 0;
  let cacheable = 0;
  let writeOrExecute = 0;
  let external = 0;
  const highRiskTools: string[] = [];
  const unknownTools: string[] = [];

  rows.forEach((row) => {
    byRisk[row.risk] += 1;
    surfaceCounts.set(row.surface, (surfaceCounts.get(row.surface) ?? 0) + 1);

    if (row.promptVisible) {
      promptVisible += 1;
    }
    if (row.sandboxEligible) {
      sandboxEligible += 1;
    }
    if (row.parallelSafe) {
      parallelSafe += 1;
    }
    if (row.cacheable) {
      cacheable += 1;
    }
    if (row.access.includes('write') || row.access.includes('execute')) {
      writeOrExecute += 1;
    }
    if (row.access.includes('external') || row.access.includes('network')) {
      external += 1;
    }
    if (row.risk === 'high') {
      highRiskTools.push(row.name);
    }
    if (!row.registered) {
      unknownTools.push(row.name);
    }
  });

  return {
    total: rows.length,
    registered: rows.length - unknownTools.length,
    unknown: unknownTools.length,
    promptVisible,
    sandboxEligible,
    parallelSafe,
    cacheable,
    writeOrExecute,
    external,
    byRisk,
    bySurface: Array.from(surfaceCounts.entries())
      .map(([surface, count]) => ({ surface, count }))
      .sort((left, right) => right.count - left.count || left.surface.localeCompare(right.surface)),
    highRiskTools,
    unknownTools,
  };
}

export function buildAoiCapabilityPrompt(toolNames: string[]): string {
  const rows = getAoiCapabilityRows(toolNames).filter((row) => row.promptVisible);
  if (rows.length === 0) {
    return '';
  }

  const summary = summarizeAoiCapabilityRegistry(toolNames);
  const exposedTools = rows.map((row) => row.name);
  const highRiskTools = rows.filter((row) => row.risk === 'high').map((row) => row.name);
  const readOnlyTools = rows
    .filter(
      (row) =>
        row.access.includes('read') &&
        !row.access.includes('write') &&
        !row.access.includes('execute'),
    )
    .map((row) => row.name);

  const lines = [
    '',
    'Aoi Capability Registry:',
    `- Exposed tool names for this turn: ${formatNameList(exposedTools)}.`,
    `- Risk summary: low ${summary.byRisk.low}, medium ${summary.byRisk.medium}, high ${summary.byRisk.high}, unknown ${summary.byRisk.unknown}.`,
    `- Read-only or discovery tools: ${formatNameList(readOnlyTools)}.`,
  ];

  if (highRiskTools.length > 0) {
    lines.push(
      `- High-risk tools can mutate, execute, or restore local state: ${formatNameList(
        highRiskTools,
      )}. Prefer preview_changes, workspace_checkpoint, and undo_last_action when available.`,
    );
  }

  if (summary.unknownTools.length > 0) {
    lines.push(
      `- Unknown tools are unclassified and require extra care: ${formatNameList(
        summary.unknownTools,
      )}.`,
    );
  }

  lines.push(
    '- Never call a tool outside this exposed list, and follow each capability policy before using a write, execute, network, or recovery surface.',
  );

  if (
    rows.some((row) =>
      ['app_action', 'get_app_state', 'get_app_schema', 'file_write', 'file_patch'].includes(
        row.name,
      ),
    )
  ) {
    lines.push(...buildAoiAppCapabilityAuthorityPromptLines());
  }

  return `\n${lines.join('\n')}`;
}

export type AoiCapabilityBrokerBand =
  | 'observe'
  | 'summarize'
  | 'prepare'
  | 'preview'
  | 'request_approval'
  | 'execute'
  | 'rollback';

export type AoiCapabilityBrokerRollbackRequirement =
  | 'not_required'
  | 'required'
  | 'missing'
  | 'satisfied';

export interface AoiAppCapabilityDefinition {
  version: 1;
  id: string;
  appId: number;
  appName: string;
  displayName: string;
  intent: string;
  title: string;
  description: string;
  executionKind: AppIntentExecutionKind | 'capability_manifest';
  toolName: string;
  actionType?: string;
  schemaId?: string;
  dataRoot?: string;
  supportedBands: AoiCapabilityBrokerBand[];
  mutationCapable: boolean;
  destructive: boolean;
  external: boolean;
  requiresPreview: boolean;
  requiresApproval: boolean;
  rollbackEvidenceRequired: boolean;
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiAppCapabilityManifest {
  version: 1;
  appId: number;
  appName: string;
  displayName: string;
  capabilityCount: number;
  supportedBands: AoiCapabilityBrokerBand[];
  capabilities: AoiAppCapabilityDefinition[];
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiCapabilityBrokerDecisionInput {
  appReference: string | number;
  capabilityId?: string;
  intentReference?: string;
  actionType?: string;
  requestedOperation?: string;
  requestedBand?: AoiCapabilityBrokerBand;
  approvalSatisfied?: boolean;
  approvalEvidenceRefs?: readonly string[];
  rollbackEvidenceRefs?: readonly string[];
  evidenceRefs?: readonly string[];
  apps?: readonly (AppDef | AppIdentity)[];
}

export interface AoiCapabilityBrokerDecision {
  version: 1;
  appId: number | null;
  appName: string;
  displayName: string;
  capabilityId: string;
  requestedOperation: string;
  requestedBand: AoiCapabilityBrokerBand;
  allowedBand: AoiCapabilityBrokerBand;
  supportedBands: AoiCapabilityBrokerBand[];
  executionKind: AppIntentExecutionKind | 'capability_manifest' | 'unknown';
  toolName: string;
  actionType?: string;
  schemaId?: string;
  mutationCapable: boolean;
  requiredApproval: boolean;
  approvalSatisfied: boolean;
  rollbackEvidenceRequirement: AoiCapabilityBrokerRollbackRequirement;
  rollbackEvidenceRefs: string[];
  blockedReasons: string[];
  canExecute: boolean;
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
  unauthorizedMutationCount: 0;
}

export interface AoiAppCapabilityAuthoritySummary {
  version: 1;
  appCount: number;
  capabilityCount: number;
  mutationCapableCount: number;
  approvalGatedMutationCount: number;
  rollbackRequiredCount: number;
  bandLabels: string[];
  appLabels: string[];
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
  unauthorizedMutationCount: 0;
}

export const AOI_CAPABILITY_BROKER_BANDS: AoiCapabilityBrokerBand[] = [
  'observe',
  'summarize',
  'prepare',
  'preview',
  'request_approval',
  'execute',
  'rollback',
];

const AOI_CAPABILITY_BROKER_BAND_ORDER: Record<AoiCapabilityBrokerBand, number> = {
  observe: 1,
  summarize: 2,
  prepare: 3,
  preview: 4,
  request_approval: 5,
  execute: 6,
  rollback: 7,
};

function normalizeBrokerRef(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function uniqueBrokerStrings(values: Array<string | undefined | null>, limit = 24): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function getAppField(app: AppDef | AppIdentity, field: 'aliases'): readonly string[] {
  return app[field] ?? [];
}

function appMatchesBrokerReference(
  app: AppDef | AppIdentity,
  appReference: string | number,
): boolean {
  const normalized = normalizeBrokerRef(appReference);
  if (!normalized) {
    return false;
  }
  return [app.appId, app.appName, app.displayName, ...getAppField(app, 'aliases')].some(
    (value) => normalizeBrokerRef(value) === normalized,
  );
}

function resolveBrokerApp(
  appReference: string | number,
  apps: readonly (AppDef | AppIdentity)[] = APP_REGISTRY,
): AppDef | AppIdentity | null {
  return apps.find((app) => appMatchesBrokerReference(app, appReference)) ?? null;
}

function isPreviewOnlyAppAction(contract: AppIntentContract): boolean {
  return /^PREVIEW_/i.test(contract.execution.action_type ?? '');
}

function isContractMutationCapable(contract: AppIntentContract): boolean {
  if (contract.execution.kind === 'schema_file_write') {
    return true;
  }
  if (contract.execution.kind === 'schema_file_delete') {
    return true;
  }
  if (contract.execution.kind === 'state_file_write') {
    return true;
  }
  if (contract.execution.kind !== 'app_action') {
    return false;
  }
  if (isPreviewOnlyAppAction(contract)) {
    return false;
  }
  return (
    contract.execution.requires_user_approval ||
    contract.execution.requires_preview ||
    contract.destructive ||
    contract.external ||
    contract.risk !== 'low'
  );
}

function supportedBandsForContract(contract: AppIntentContract): AoiCapabilityBrokerBand[] {
  const mutationCapable = isContractMutationCapable(contract);
  const requiresApproval =
    mutationCapable ||
    contract.execution.requires_user_approval ||
    contract.destructive ||
    contract.external ||
    contract.risk === 'high';
  const bands = new Set<AoiCapabilityBrokerBand>(['observe', 'summarize', 'prepare']);

  if (contract.execution.requires_preview || mutationCapable || isPreviewOnlyAppAction(contract)) {
    bands.add('preview');
  }
  if (requiresApproval) {
    bands.add('request_approval');
  }
  bands.add('execute');
  if (mutationCapable) {
    bands.add('rollback');
  }

  return AOI_CAPABILITY_BROKER_BANDS.filter((band) => bands.has(band));
}

function capabilityFromContract(contract: AppIntentContract): AoiAppCapabilityDefinition {
  const mutationCapable = isContractMutationCapable(contract);
  const requiresApproval =
    mutationCapable ||
    contract.execution.requires_user_approval ||
    contract.destructive ||
    contract.external ||
    contract.risk === 'high';

  return {
    version: 1,
    id: contract.id,
    appId: contract.app_id,
    appName: contract.app_name,
    displayName: contract.display_name,
    intent: contract.intent,
    title: contract.title,
    description: contract.description,
    executionKind: contract.execution.kind,
    toolName: contract.execution.tool_name,
    ...(contract.execution.action_type ? { actionType: contract.execution.action_type } : {}),
    ...(contract.execution.schema_id ? { schemaId: contract.execution.schema_id } : {}),
    ...(contract.execution.data_root ? { dataRoot: contract.execution.data_root } : {}),
    supportedBands: supportedBandsForContract(contract),
    mutationCapable,
    destructive: contract.destructive,
    external: contract.external,
    requiresPreview:
      contract.execution.requires_preview || (mutationCapable && !isPreviewOnlyAppAction(contract)),
    requiresApproval,
    rollbackEvidenceRequired: mutationCapable,
    evidenceRefs: uniqueBrokerStrings(contract.evidence_refs, 12),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function capabilityMatchesRequest(
  capability: AoiAppCapabilityDefinition,
  input: AoiCapabilityBrokerDecisionInput,
): boolean {
  const refs = [
    input.capabilityId,
    input.intentReference,
    input.actionType,
    input.requestedOperation,
  ]
    .map(normalizeBrokerRef)
    .filter(Boolean);
  if (refs.length <= 0) {
    return capability.intent === 'inspect_state';
  }

  const capabilityRefs = [
    capability.id,
    capability.intent,
    capability.title,
    capability.actionType,
    capability.schemaId,
    capability.toolName,
  ]
    .map(normalizeBrokerRef)
    .filter(Boolean);
  return refs.some((ref) => capabilityRefs.includes(ref));
}

function inferRequestedBrokerBand(
  input: AoiCapabilityBrokerDecisionInput,
  capability: AoiAppCapabilityDefinition | null,
): AoiCapabilityBrokerBand {
  if (input.requestedBand) {
    return input.requestedBand;
  }

  const operation = normalizeBrokerRef(
    [
      input.requestedOperation,
      input.actionType,
      input.intentReference,
      capability?.intent,
      capability?.actionType,
    ]
      .filter(Boolean)
      .join(' '),
  );

  if (/\brollback|undo|revert|restore\b/i.test(operation)) {
    return 'rollback';
  }
  if (
    /\bexecute|apply|save|create|update|delete|write|patch|run|start|switch|append|replace\b/i.test(
      operation,
    )
  ) {
    return 'execute';
  }
  if (/\bapprove|approval|authorize|confirm\b/i.test(operation)) {
    return 'request_approval';
  }
  if (/\bpreview|diff|simulate\b/i.test(operation)) {
    return 'preview';
  }
  if (/\bprepare|plan|draft|propose\b/i.test(operation)) {
    return 'prepare';
  }
  if (/\bsummarize|summary|brief\b/i.test(operation)) {
    return 'summarize';
  }
  return 'observe';
}

function highestSupportedBandAtOrBelow(
  supportedBands: readonly AoiCapabilityBrokerBand[],
  requestedBand: AoiCapabilityBrokerBand,
): AoiCapabilityBrokerBand {
  return (
    supportedBands
      .filter(
        (band) =>
          AOI_CAPABILITY_BROKER_BAND_ORDER[band] <= AOI_CAPABILITY_BROKER_BAND_ORDER[requestedBand],
      )
      .sort(
        (left, right) =>
          AOI_CAPABILITY_BROKER_BAND_ORDER[right] - AOI_CAPABILITY_BROKER_BAND_ORDER[left],
      )[0] ?? 'observe'
  );
}

function safeBandAfterExecuteBlock(
  supportedBands: readonly AoiCapabilityBrokerBand[],
  blockedReasons: readonly string[],
): AoiCapabilityBrokerBand {
  if (blockedReasons.includes('approval_required') && supportedBands.includes('request_approval')) {
    return 'request_approval';
  }
  if (supportedBands.includes('preview')) {
    return 'preview';
  }
  if (supportedBands.includes('prepare')) {
    return 'prepare';
  }
  return 'observe';
}

function buildUnknownCapabilityDecision(
  input: AoiCapabilityBrokerDecisionInput,
  requestedBand: AoiCapabilityBrokerBand,
): AoiCapabilityBrokerDecision {
  const operation =
    input.requestedOperation ||
    input.actionType ||
    input.intentReference ||
    input.capabilityId ||
    'unknown';
  return {
    version: 1,
    appId: null,
    appName: String(input.appReference),
    displayName: String(input.appReference),
    capabilityId: input.capabilityId ?? 'unknown',
    requestedOperation: operation,
    requestedBand,
    allowedBand: 'observe',
    supportedBands: ['observe'],
    executionKind: 'unknown',
    toolName: 'none',
    mutationCapable: false,
    requiredApproval: false,
    approvalSatisfied: false,
    rollbackEvidenceRequirement: 'not_required',
    rollbackEvidenceRefs: [],
    blockedReasons: ['unknown_app_or_capability_manifest'],
    canExecute: false,
    evidenceRefs: uniqueBrokerStrings(input.evidenceRefs ? [...input.evidenceRefs] : [], 12),
    actionAuthority: 'display_only',
    mutationCount: 0,
    unauthorizedMutationCount: 0,
  };
}

export function getAoiAppCapabilityManifest(
  appReference: string | number,
  apps: readonly (AppDef | AppIdentity)[] = APP_REGISTRY,
): AoiAppCapabilityManifest | null {
  const app = resolveBrokerApp(appReference, apps);
  if (!app) {
    return null;
  }
  const capabilities = buildAppIntentContracts(app).map(capabilityFromContract);
  const supportedBands = AOI_CAPABILITY_BROKER_BANDS.filter((band) =>
    capabilities.some((capability) => capability.supportedBands.includes(band)),
  );

  return {
    version: 1,
    appId: app.appId,
    appName: app.appName,
    displayName: app.displayName,
    capabilityCount: capabilities.length,
    supportedBands,
    capabilities,
    evidenceRefs: uniqueBrokerStrings(
      [
        `app:${app.appName}`,
        `app-id:${app.appId}`,
        ...capabilities.flatMap((capability) => capability.evidenceRefs),
      ],
      24,
    ),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function listAoiAppCapabilityManifests(
  apps: readonly (AppDef | AppIdentity)[] = APP_REGISTRY,
): AoiAppCapabilityManifest[] {
  return apps
    .filter((app) => app.appName !== 'os')
    .map((app) => getAoiAppCapabilityManifest(app.appId, apps))
    .filter((manifest): manifest is AoiAppCapabilityManifest => Boolean(manifest));
}

export function decideAoiCapabilityBrokerAuthority(
  input: AoiCapabilityBrokerDecisionInput,
): AoiCapabilityBrokerDecision {
  const manifest = getAoiAppCapabilityManifest(input.appReference, input.apps);
  const requestedBand = inferRequestedBrokerBand(input, null);
  if (!manifest) {
    return buildUnknownCapabilityDecision(input, requestedBand);
  }

  const capability =
    manifest.capabilities.find((candidate) => capabilityMatchesRequest(candidate, input)) ??
    manifest.capabilities.find((candidate) => candidate.intent === 'inspect_state') ??
    manifest.capabilities[0] ??
    null;
  const finalRequestedBand = inferRequestedBrokerBand(input, capability);
  if (!capability) {
    return buildUnknownCapabilityDecision(input, finalRequestedBand);
  }

  const blockedReasons: string[] = [];
  let allowedBand = finalRequestedBand;
  if (!capability.supportedBands.includes(finalRequestedBand)) {
    blockedReasons.push(`unsupported_band:${finalRequestedBand}`);
    allowedBand = highestSupportedBandAtOrBelow(capability.supportedBands, finalRequestedBand);
  }

  const approvalSatisfied = input.approvalSatisfied === true;
  const rollbackEvidenceRefs = uniqueBrokerStrings(
    input.rollbackEvidenceRefs ? [...input.rollbackEvidenceRefs] : [],
    12,
  );
  const executeLikeBand = finalRequestedBand === 'execute' || finalRequestedBand === 'rollback';
  const rollbackEvidenceRequirement: AoiCapabilityBrokerRollbackRequirement =
    !capability.rollbackEvidenceRequired
      ? 'not_required'
      : rollbackEvidenceRefs.length > 0
        ? 'satisfied'
        : executeLikeBand
          ? 'missing'
          : 'required';

  if (executeLikeBand && capability.requiresApproval && !approvalSatisfied) {
    blockedReasons.push('approval_required');
  }
  if (
    executeLikeBand &&
    capability.rollbackEvidenceRequired &&
    rollbackEvidenceRequirement !== 'satisfied'
  ) {
    blockedReasons.push('rollback_evidence_required');
  }
  if (blockedReasons.length > 0 && executeLikeBand) {
    allowedBand = safeBandAfterExecuteBlock(capability.supportedBands, blockedReasons);
  }

  const requiredApproval =
    capability.requiresApproval || blockedReasons.includes('approval_required');
  const canExecute =
    finalRequestedBand === 'execute' &&
    allowedBand === 'execute' &&
    blockedReasons.length <= 0 &&
    (!requiredApproval || approvalSatisfied) &&
    rollbackEvidenceRequirement !== 'missing';

  return {
    version: 1,
    appId: manifest.appId,
    appName: manifest.appName,
    displayName: manifest.displayName,
    capabilityId: capability.id,
    requestedOperation:
      input.requestedOperation || input.actionType || input.intentReference || capability.intent,
    requestedBand: finalRequestedBand,
    allowedBand,
    supportedBands: capability.supportedBands,
    executionKind: capability.executionKind,
    toolName: capability.toolName,
    ...(capability.actionType ? { actionType: capability.actionType } : {}),
    ...(capability.schemaId ? { schemaId: capability.schemaId } : {}),
    mutationCapable: capability.mutationCapable,
    requiredApproval,
    approvalSatisfied,
    rollbackEvidenceRequirement,
    rollbackEvidenceRefs,
    blockedReasons: uniqueBrokerStrings(blockedReasons, 8),
    canExecute,
    evidenceRefs: uniqueBrokerStrings(
      [
        `capability-broker:${manifest.appName}:${capability.intent}`,
        ...manifest.evidenceRefs,
        ...capability.evidenceRefs,
        ...(input.evidenceRefs ? [...input.evidenceRefs] : []),
        ...(input.approvalEvidenceRefs ? [...input.approvalEvidenceRefs] : []),
        ...rollbackEvidenceRefs,
      ],
      24,
    ),
    actionAuthority: 'display_only',
    mutationCount: 0,
    unauthorizedMutationCount: 0,
  };
}

export function summarizeAoiAppCapabilityAuthority(
  apps: readonly (AppDef | AppIdentity)[] = APP_REGISTRY,
): AoiAppCapabilityAuthoritySummary {
  const manifests = listAoiAppCapabilityManifests(apps);
  const capabilities = manifests.flatMap((manifest) => manifest.capabilities);
  const mutationCapabilities = capabilities.filter((capability) => capability.mutationCapable);
  const approvalGatedMutationCount = mutationCapabilities.filter(
    (capability) => capability.requiresApproval,
  ).length;
  const rollbackRequiredCount = mutationCapabilities.filter(
    (capability) => capability.rollbackEvidenceRequired,
  ).length;

  return {
    version: 1,
    appCount: manifests.length,
    capabilityCount: capabilities.length,
    mutationCapableCount: mutationCapabilities.length,
    approvalGatedMutationCount,
    rollbackRequiredCount,
    bandLabels: AOI_CAPABILITY_BROKER_BANDS.map((band) => getAoiCapabilityBrokerBandLabel(band)),
    appLabels: manifests
      .slice(0, 8)
      .map(
        (manifest) =>
          `${manifest.displayName}: ${manifest.capabilityCount} manifest capability(s); bands=${manifest.supportedBands
            .map(getAoiCapabilityBrokerBandLabel)
            .join('/')}`,
      ),
    evidenceRefs: uniqueBrokerStrings(
      manifests.flatMap((manifest) => manifest.evidenceRefs),
      24,
    ),
    actionAuthority: 'display_only',
    mutationCount: 0,
    unauthorizedMutationCount: 0,
  };
}

export function getAoiCapabilityBrokerBandLabel(band: AoiCapabilityBrokerBand): string {
  return band === 'request_approval' ? 'request approval' : band;
}

export function formatAoiCapabilityBrokerDecisionLine(
  decision: AoiCapabilityBrokerDecision,
): string {
  const blockLabel =
    decision.blockedReasons.length > 0
      ? ` blocked=${decision.blockedReasons.join(',')}`
      : ' blocked=none';
  const approvalLabel = decision.requiredApproval
    ? ` approval=${decision.approvalSatisfied ? 'satisfied' : 'required'}`
    : ' approval=none';
  const rollbackLabel =
    decision.rollbackEvidenceRequirement === 'not_required'
      ? ' rollback=not required'
      : ` rollback=${decision.rollbackEvidenceRequirement}`;
  return `${decision.displayName} ${decision.capabilityId}: requested=${getAoiCapabilityBrokerBandLabel(
    decision.requestedBand,
  )}; allowed=${getAoiCapabilityBrokerBandLabel(decision.allowedBand)}; mutation=${
    decision.mutationCapable
  };${approvalLabel};${rollbackLabel};${blockLabel}`;
}

function buildAoiAppCapabilityAuthorityPromptLines(): string[] {
  const summary = summarizeAoiAppCapabilityAuthority();
  return [
    '- Capability Broker v2 is the structured source of truth for app authority. Use app manifests and get_app_intents contracts, not UI text guesses, to explain what Aoi can observe, summarize, prepare, preview, request approval for, execute, or roll back.',
    `- Capability Broker v2 coverage: ${summary.appCount} apps, ${summary.capabilityCount} app capabilities, ${summary.approvalGatedMutationCount} approval-gated mutation capabilities, ${summary.rollbackRequiredCount} rollback-required capabilities.`,
    '- App mutation execution is not authorized by capability discovery alone. Without explicit approval evidence and rollback/recovery evidence, the safe ceiling is preview or request approval, and mutationCount/unauthorizedMutationCount must remain 0.',
  ];
}

function dedupeNames(toolNames: string[]): string[] {
  return Array.from(new Set(toolNames.filter((name) => name.trim().length > 0))).sort();
}

function formatNameList(names: string[], maxItems = 16): string {
  if (names.length === 0) {
    return 'none';
  }

  const visible = names.slice(0, maxItems);
  const suffix = names.length > maxItems ? `, +${names.length - maxItems} more` : '';
  return `${visible.join(', ')}${suffix}`;
}
