import { isParallelSafeToolName } from './toolBatching';
import { isCacheableToolName } from './toolResultCache';

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
    policyNotes: 'Data mutations must be persisted through storage tools before refresh actions.',
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

  return `\n${lines.join('\n')}`;
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
