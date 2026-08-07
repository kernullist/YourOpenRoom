import { isParallelSafeToolName } from './toolBatching';
import { isCacheableToolName } from './toolResultCache';
import type { AppDef, AppIdentity } from './appRegistry';
import { APP_REGISTRY } from './appRegistry';
import {
  buildAppIntentContracts,
  type AppIntentContract,
  type AppIntentExecutionKind,
} from './appIntentContracts';
import {
  createAoiApprovalSandboxPreview,
  formatAoiApprovalSandboxSummary,
  validateAoiApprovalSandboxApproval,
  type AoiApprovalSandboxApprovalReceipt,
  type AoiApprovalSandboxPreview,
  type AoiApprovalSandboxValidationResult,
} from './aoiApprovalSandbox';
import type { AoiEnvironmentSourceRegistry } from './aoiAutonomyTypes';
import type { AoiSourceFreshnessContract } from './aoiSourceFreshnessContract';
import type { AoiUnifiedOperatorSnapshot } from './aoiUnifiedOperatorModel';

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
  host_process_list: {
    name: 'host_process_list',
    label: 'Host process list',
    kind: 'tool',
    surface: 'diagnostics',
    risk: 'medium',
    description:
      'Read a metadata-only snapshot of running host processes (image name + pid; no command line).',
    access: ['read'],
    sandboxEligible: false,
    approval: 'policy-gated',
    promptVisible: true,
    policyNotes:
      'Requires Host Bridge process_activity capability and process-activity environment-source consent.',
  },
  host_browser_read: {
    name: 'host_browser_read',
    label: 'Host headless browser read',
    kind: 'tool',
    surface: 'web',
    risk: 'high',
    description:
      'Open a public http(s) page with local Chrome/Edge headless and extract reader text.',
    access: ['read', 'network', 'external'],
    sandboxEligible: false,
    approval: 'policy-gated',
    promptVisible: true,
    policyNotes:
      'Requires Host Bridge os_browser_read capability and host-browser-read consent. Private/local hosts blocked.',
  },
  os_browser_drive: {
    name: 'os_browser_drive',
    label: 'Host browser drive',
    kind: 'tool',
    surface: 'web',
    risk: 'high',
    description:
      'Attach to the operator PC Chrome/Edge over CDP and act on already-logged-in sites (navigate + extract; interactions gated per action).',
    access: ['read', 'write', 'network', 'external'],
    sandboxEligible: false,
    approval: 'policy-gated',
    promptVisible: true,
    policyNotes:
      'Requires Host Bridge os_browser_drive capability + browser-drive consent + a domain allowlist. Attaches to the MAIN profile, so the allowlist is the only containment; interactions need per-action approval, and passwords/payments/CAPTCHAs are never entered.',
  },
  // The four tool names the browser-drive surface actually exposes to the model.
  // os_browser_drive above is the host-bridge CAPABILITY name, which is what the
  // consent settings key off -- it never appears in a tools array, so on its own
  // it left every one of these unclassified. That put browser_drive_run and
  // browser_drive_task, the two that genuinely click and type in the operator's
  // logged-in browser, under "unknown ... require extra care" while carrying no
  // risk grade at all.
  browser_read_auth: {
    name: 'browser_read_auth',
    label: 'Logged-in browser read',
    kind: 'tool',
    surface: 'web',
    risk: 'high',
    description:
      "Read a page from the operator's own already-logged-in Chrome/Edge over CDP and extract reader text.",
    access: ['read', 'network', 'external'],
    sandboxEligible: false,
    approval: 'policy-gated',
    promptVisible: true,
    policyNotes:
      'Requires Host Bridge os_browser_drive capability + browser-drive consent + the domain on the allowlist. Read-only: never clicks, types, or submits. Reads authenticated session content, which is why it is graded high despite not writing.',
  },
  browser_drive_act: {
    name: 'browser_drive_act',
    label: 'Browser drive: propose one action',
    kind: 'tool',
    surface: 'automation',
    risk: 'high',
    description:
      'Propose ONE action on the logged-in browser and record a per-action approval request. Does not perform the action.',
    access: ['read', 'network', 'external'],
    sandboxEligible: false,
    approval: 'user-confirmation',
    promptVisible: true,
    policyNotes:
      'Captures a before-screenshot and records an approval the operator must accept in Settings -> Advanced -> Host PC -> Approvals. browser_drive_run performs it afterwards; passwords, payments, and CAPTCHAs are never entered.',
  },
  browser_drive_run: {
    name: 'browser_drive_run',
    label: 'Browser drive: perform approved action',
    kind: 'tool',
    surface: 'automation',
    risk: 'high',
    description:
      "Perform the single action previously approved via browser_drive_act in the operator's logged-in browser.",
    access: ['read', 'write', 'network', 'external'],
    sandboxEligible: false,
    approval: 'user-confirmation',
    promptVisible: true,
    policyNotes:
      'Fails unless the operator approved this exact plan. Acts on authenticated sites with no undo surface of its own, so the approval and the domain allowlist are the only containment.',
  },
  browser_drive_task: {
    name: 'browser_drive_task',
    label: 'Browser drive: bounded multi-act task',
    kind: 'tool',
    surface: 'automation',
    risk: 'high',
    description:
      'Run a bounded ordered list of single-act browser steps, fail-stopping on the first failure.',
    access: ['read', 'write', 'network', 'external'],
    sandboxEligible: false,
    approval: 'user-confirmation',
    promptVisible: true,
    policyNotes:
      'Requires the standing-approval and bounded-task toggles plus a standing grant per domain. Bounded to <=10 acts / <=40 steps. Only run a task the operator explicitly asked for.',
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
  // High risk disqualifies a tool from this list even when it only reads. The two
  // lines are read as opposites -- this one says "safe to reach for first", the
  // high-risk line says "can mutate, execute, or restore local state" -- so a tool
  // in both told the model both things about itself in the same prompt.
  // host_browser_read did exactly that: read/network/external access, graded high
  // because it drives a local browser at an arbitrary page. Grades are unchanged;
  // only the safe-to-start-with list is narrowed.
  const readOnlyTools = rows
    .filter(
      (row) =>
        row.risk !== 'high' &&
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

  // Models with a strong offline prior (and personas with a story reason to be
  // disconnected) answer freshness questions from stale knowledge and excuse it
  // as a connectivity problem. State the opposite explicitly while the tool is
  // actually exposed; the line disappears whenever search_web does.
  if (exposedTools.includes('search_web')) {
    lines.push(
      '- Live web access IS available this turn via search_web. For questions about current or recently-changed facts (news, prices, policies, defaults, release or support status), call search_web before answering. Do not claim you are offline, disconnected, or unable to check the live web, and do not roleplay a broken connection instead of searching.',
    );
  }

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
  | 'metadata_only'
  | 'body_content'
  | 'prepare'
  | 'preview'
  | 'request_approval'
  | 'execute'
  | 'rollback'
  | 'audit';

export type AoiCapabilityBrokerRollbackRequirement =
  | 'not_required'
  | 'required'
  | 'missing'
  | 'satisfied';

export type AoiConnectorAuthoritySourceState =
  | 'available'
  | 'disconnected'
  | 'revoked'
  | 'disabled'
  | 'stale'
  | 'unknown';

export type AoiConnectorAuthorityConsentState =
  | 'not_required'
  | 'required'
  | 'missing'
  | 'satisfied'
  | 'revoked'
  | 'disabled'
  | 'disconnected';

export interface AoiConnectorAuthorityConsentRequirement {
  version: 1;
  bodyContent: AoiConnectorAuthorityConsentState;
  mutation: AoiConnectorAuthorityConsentState;
  bodyContentReceiptRefs: string[];
  mutationReceiptRefs: string[];
  receiptRefs: string[];
}

export interface AoiConnectorAuthorityAuditEvent {
  version: 1;
  id: string;
  decisionId: string;
  connectorKind: 'app_capability' | 'personal_source' | 'unknown';
  appName?: string;
  sourceId?: string;
  capabilityId?: string;
  requestedBand: AoiCapabilityBrokerBand;
  allowedBand: AoiCapabilityBrokerBand;
  consentReceiptIds: string[];
  mutationIntent: string;
  expectedMutationCount: number;
  mutationCount: 0;
  blockedReasons: string[];
  cannotKnow: string[];
  evidenceRefs: string[];
  actionAuthority: 'display_only';
}

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
  sourceState: AoiConnectorAuthoritySourceState;
  bodyContentConsentReceiptRefs: string[];
  mutationConsentReceiptRefs: string[];
  mutationCapable: boolean;
  destructive: boolean;
  external: boolean;
  requiresPreview: boolean;
  requiresApproval: boolean;
  rollbackEvidenceRequired: boolean;
  auditRequired: boolean;
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
  approvalSandboxApproval?: AoiApprovalSandboxApprovalReceipt | null;
  previewEvidenceRefs?: readonly string[];
  targetEvidenceRefs?: readonly string[];
  rollbackEvidenceRefs?: readonly string[];
  consentReceiptRefs?: readonly string[];
  bodyContentConsentReceiptRefs?: readonly string[];
  mutationConsentReceiptRefs?: readonly string[];
  additionalBlockedReasons?: readonly string[];
  evidenceRefs?: readonly string[];
  operatorSnapshot?: AoiUnifiedOperatorSnapshot | null;
  now?: number;
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
  approvalSandbox: AoiApprovalSandboxPreview;
  approvalSandboxValidation: AoiApprovalSandboxValidationResult;
  approvalSandboxSummary: string;
  rollbackEvidenceRequirement: AoiCapabilityBrokerRollbackRequirement;
  rollbackEvidenceRefs: string[];
  requiredConsent: AoiConnectorAuthorityConsentRequirement;
  sourceState: AoiConnectorAuthoritySourceState;
  blockedReasons: string[];
  cannotKnow: string[];
  auditRequired: boolean;
  authorityDecisionId: string;
  auditEvent: AoiConnectorAuthorityAuditEvent;
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

export interface AoiConnectorAuthorityDecisionInput {
  connectorKind: 'app_capability' | 'personal_source';
  appReference?: string | number;
  sourceId?: string;
  capabilityId?: string;
  intentReference?: string;
  actionType?: string;
  requestedOperation?: string;
  requestedBand?: AoiCapabilityBrokerBand;
  approvalSatisfied?: boolean;
  approvalEvidenceRefs?: readonly string[];
  approvalSandboxApproval?: AoiApprovalSandboxApprovalReceipt | null;
  previewEvidenceRefs?: readonly string[];
  targetEvidenceRefs?: readonly string[];
  rollbackEvidenceRefs?: readonly string[];
  consentReceiptRefs?: readonly string[];
  bodyContentConsentReceiptRefs?: readonly string[];
  mutationConsentReceiptRefs?: readonly string[];
  additionalBlockedReasons?: readonly string[];
  evidenceRefs?: readonly string[];
  operatorSnapshot?: AoiUnifiedOperatorSnapshot | null;
  now?: number;
  apps?: readonly (AppDef | AppIdentity)[];
  sourceRegistry?: AoiEnvironmentSourceRegistry | null;
  sourceFreshnessContracts?: readonly AoiSourceFreshnessContract[];
}

export interface AoiConnectorAuthorityDecision {
  version: 1;
  authorityDecisionId: string;
  connectorKind: 'app_capability' | 'personal_source' | 'unknown';
  appId: number | null;
  appName: string;
  displayName: string;
  sourceId?: string;
  sourceKind?: string;
  capabilityId: string;
  requestedOperation: string;
  requestedBand: AoiCapabilityBrokerBand;
  allowedBand: AoiCapabilityBrokerBand;
  supportedBands: AoiCapabilityBrokerBand[];
  sourceState: AoiConnectorAuthoritySourceState;
  requiredConsent: AoiConnectorAuthorityConsentRequirement;
  requiredApproval: boolean;
  approvalSatisfied: boolean;
  approvalSandbox?: AoiApprovalSandboxPreview;
  approvalSandboxValidation?: AoiApprovalSandboxValidationResult;
  approvalSandboxSummary?: string;
  rollbackEvidenceRequirement: AoiCapabilityBrokerRollbackRequirement;
  auditRequired: boolean;
  auditEvent: AoiConnectorAuthorityAuditEvent;
  blockedReasons: string[];
  cannotKnow: string[];
  canExecute: boolean;
  bodyContentAuthorized: boolean;
  mutationCapable: boolean;
  mutationAuthorized: boolean;
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
  unauthorizedMutationCount: 0;
}

export const AOI_CAPABILITY_BROKER_BANDS: AoiCapabilityBrokerBand[] = [
  'observe',
  'summarize',
  'metadata_only',
  'body_content',
  'prepare',
  'preview',
  'request_approval',
  'execute',
  'rollback',
  'audit',
];

const AOI_CAPABILITY_BROKER_BAND_ORDER: Record<AoiCapabilityBrokerBand, number> = {
  observe: 1,
  summarize: 2,
  metadata_only: 3,
  body_content: 4,
  prepare: 5,
  preview: 6,
  request_approval: 7,
  execute: 8,
  rollback: 9,
  audit: 10,
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

function stableAuthorityHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function makeAuthorityDecisionId(parts: Array<string | number | undefined | null>): string {
  return `connector-authority:${stableAuthorityHash(parts.map((part) => String(part ?? '')).join('|'))}`;
}

function operatorSnapshotEvidenceRefs(
  snapshot: AoiUnifiedOperatorSnapshot | null | undefined,
): string[] {
  if (!snapshot) {
    return [];
  }
  return uniqueBrokerStrings([`operator-snapshot:${snapshot.id}`, ...snapshot.evidenceRefs], 12);
}

function operatorSnapshotCannotKnow(
  snapshot: AoiUnifiedOperatorSnapshot | null | undefined,
): string[] {
  if (!snapshot) {
    return [];
  }
  return uniqueBrokerStrings(snapshot.cannotKnow, 12);
}

function makeConsentRequirement(params: {
  bodyContentState?: AoiConnectorAuthorityConsentState;
  mutationState?: AoiConnectorAuthorityConsentState;
  bodyContentReceiptRefs?: readonly string[];
  mutationReceiptRefs?: readonly string[];
  consentReceiptRefs?: readonly string[];
}): AoiConnectorAuthorityConsentRequirement {
  const bodyContentReceiptRefs = uniqueBrokerStrings(
    [...(params.bodyContentReceiptRefs ?? []), ...(params.consentReceiptRefs ?? [])],
    12,
  );
  const mutationReceiptRefs = uniqueBrokerStrings(
    [...(params.mutationReceiptRefs ?? []), ...(params.consentReceiptRefs ?? [])],
    12,
  );
  return {
    version: 1,
    bodyContent: params.bodyContentState ?? 'not_required',
    mutation: params.mutationState ?? 'not_required',
    bodyContentReceiptRefs,
    mutationReceiptRefs,
    receiptRefs: uniqueBrokerStrings([...bodyContentReceiptRefs, ...mutationReceiptRefs], 16),
  };
}

function makeAuthorityAuditEvent(params: {
  decisionId: string;
  connectorKind: AoiConnectorAuthorityAuditEvent['connectorKind'];
  appName?: string;
  sourceId?: string;
  capabilityId?: string;
  requestedBand: AoiCapabilityBrokerBand;
  allowedBand: AoiCapabilityBrokerBand;
  requiredConsent: AoiConnectorAuthorityConsentRequirement;
  mutationCapable?: boolean;
  canExecute?: boolean;
  blockedReasons?: readonly string[];
  cannotKnow?: readonly string[];
  evidenceRefs?: readonly string[];
}): AoiConnectorAuthorityAuditEvent {
  const blockedReasons = uniqueBrokerStrings([...(params.blockedReasons ?? [])], 24);
  const evidenceRefs = uniqueBrokerStrings([...(params.evidenceRefs ?? [])], 24);
  return {
    version: 1,
    id: `connector-authority-audit:${stableAuthorityHash(
      [
        params.decisionId,
        params.connectorKind,
        params.appName ?? '',
        params.sourceId ?? '',
        params.capabilityId ?? '',
        params.requestedBand,
        params.allowedBand,
        blockedReasons.join(','),
      ].join('|'),
    )}`,
    decisionId: params.decisionId,
    connectorKind: params.connectorKind,
    ...(params.appName ? { appName: params.appName } : {}),
    ...(params.sourceId ? { sourceId: params.sourceId } : {}),
    ...(params.capabilityId ? { capabilityId: params.capabilityId } : {}),
    requestedBand: params.requestedBand,
    allowedBand: params.allowedBand,
    consentReceiptIds: params.requiredConsent.receiptRefs,
    mutationIntent: params.mutationCapable
      ? params.canExecute
        ? 'execute_after_authority'
        : 'mutation_requested_but_blocked'
      : 'no_mutation_intent',
    expectedMutationCount: params.mutationCapable ? 1 : 0,
    mutationCount: 0,
    blockedReasons,
    cannotKnow: uniqueBrokerStrings([...(params.cannotKnow ?? [])], 12),
    evidenceRefs,
    actionAuthority: 'display_only',
  };
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
  const bands = new Set<AoiCapabilityBrokerBand>([
    'observe',
    'summarize',
    'metadata_only',
    'prepare',
    'audit',
  ]);

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
    sourceState: 'available',
    bodyContentConsentReceiptRefs: [],
    mutationConsentReceiptRefs: [],
    mutationCapable,
    destructive: contract.destructive,
    external: contract.external,
    requiresPreview:
      contract.execution.requires_preview || (mutationCapable && !isPreviewOnlyAppAction(contract)),
    requiresApproval,
    rollbackEvidenceRequired: mutationCapable,
    auditRequired: true,
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
  if (/\baudit|receipt|record\b/i.test(operation)) {
    return 'audit';
  }
  if (/\bbody|content|message_text|full_text|raw_text|description\b/i.test(operation)) {
    return 'body_content';
  }
  if (/\bmetadata|meta|state|count|status\b/i.test(operation)) {
    return 'metadata_only';
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
  if (
    blockedReasons.some(
      (reason) =>
        reason === 'approval_required' ||
        reason === 'approval_missing' ||
        reason.startsWith('sandbox_approval_'),
    ) &&
    supportedBands.includes('request_approval')
  ) {
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
  app?: AoiAppCapabilityManifest | null,
  reason = 'unknown_app_or_capability_manifest',
): AoiCapabilityBrokerDecision {
  const operation =
    input.requestedOperation ||
    input.actionType ||
    input.intentReference ||
    input.capabilityId ||
    'unknown';
  const blockedReasons = uniqueBrokerStrings(
    [reason, ...(input.additionalBlockedReasons ?? [])],
    12,
  );
  const authorityDecisionId = makeAuthorityDecisionId([
    app?.appName ?? input.appReference,
    input.capabilityId ?? input.actionType ?? input.intentReference ?? 'unknown',
    requestedBand,
    blockedReasons.join(','),
  ]);
  const requiredConsent = makeConsentRequirement({});
  const approvalSandbox = createAoiApprovalSandboxPreview({
    targetKind: app ? 'app' : 'unknown',
    targetId: `${app?.appName ?? input.appReference}:${input.capabilityId ?? input.actionType ?? 'unknown'}`,
    intendedMutation: operation,
    dryRunSummary: `Unknown or unregistered capability cannot execute: ${operation}.`,
    requiredAuthorityDecisionId: authorityDecisionId,
    expectedMutationCount: 0,
    recoveryPlan: {
      kind: 'not_applicable',
      available: true,
      summary: 'No mutation is authorized for an unknown capability decision.',
      evidenceRefs: [],
    },
    rollback: {
      required: false,
      note: 'No rollback is required because the unknown capability cannot execute.',
      evidenceRefs: [],
    },
    postActionValidation: {
      kind: 'not_applicable',
      label: 'Unknown capability execution is blocked before mutation.',
      evidenceRefs: [`authority-decision:${authorityDecisionId}`],
    },
    evidenceRefs: [
      ...(input.evidenceRefs ? [...input.evidenceRefs] : []),
      ...(app?.evidenceRefs ?? []),
    ],
  });
  const approvalSandboxValidation = validateAoiApprovalSandboxApproval({
    preview: approvalSandbox,
    approval: input.approvalSandboxApproval,
    now: input.now ?? 0,
    approvalRequired: false,
  });
  const snapshotEvidenceRefs = operatorSnapshotEvidenceRefs(input.operatorSnapshot);
  const snapshotCannotKnow = operatorSnapshotCannotKnow(input.operatorSnapshot);
  const evidenceRefs = uniqueBrokerStrings(
    [
      ...(input.evidenceRefs ? [...input.evidenceRefs] : []),
      ...(app?.evidenceRefs ?? []),
      ...snapshotEvidenceRefs,
      `authority-decision:${authorityDecisionId}`,
      `approval-sandbox-preview:${approvalSandbox.previewHash}`,
    ],
    24,
  );
  const cannotKnow = uniqueBrokerStrings(
    ['Aoi cannot assume authority for an unregistered app capability.', ...snapshotCannotKnow],
    12,
  );
  const auditEvent = makeAuthorityAuditEvent({
    decisionId: authorityDecisionId,
    connectorKind: app ? 'app_capability' : 'unknown',
    appName: app?.appName ?? String(input.appReference),
    capabilityId: input.capabilityId ?? input.actionType ?? 'unknown',
    requestedBand,
    allowedBand: 'observe',
    requiredConsent,
    blockedReasons,
    cannotKnow,
    evidenceRefs,
  });
  return {
    version: 1,
    appId: app?.appId ?? null,
    appName: app?.appName ?? String(input.appReference),
    displayName: app?.displayName ?? String(input.appReference),
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
    approvalSandbox,
    approvalSandboxValidation,
    approvalSandboxSummary: formatAoiApprovalSandboxSummary(
      approvalSandbox,
      approvalSandboxValidation,
    ),
    rollbackEvidenceRequirement: 'not_required',
    rollbackEvidenceRefs: [],
    requiredConsent,
    sourceState: 'unknown',
    blockedReasons,
    cannotKnow,
    auditRequired: true,
    authorityDecisionId,
    auditEvent,
    canExecute: false,
    evidenceRefs,
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

  const explicitCapabilityRequest = [
    input.capabilityId,
    input.intentReference,
    input.actionType,
    input.requestedOperation,
  ].some((value) => normalizeBrokerRef(value).length > 0);
  const matchedCapability = manifest.capabilities.find((candidate) =>
    capabilityMatchesRequest(candidate, input),
  );
  const capability =
    matchedCapability ??
    manifest.capabilities.find((candidate) => candidate.intent === 'inspect_state') ??
    manifest.capabilities[0] ??
    null;
  const finalRequestedBand = inferRequestedBrokerBand(input, capability);
  if (!matchedCapability && explicitCapabilityRequest) {
    return buildUnknownCapabilityDecision(
      input,
      finalRequestedBand,
      manifest,
      'unknown_capability',
    );
  }
  if (!capability) {
    return buildUnknownCapabilityDecision(input, finalRequestedBand);
  }

  const blockedReasons: string[] = [...(input.additionalBlockedReasons ?? [])];
  let allowedBand = finalRequestedBand;
  if (!capability.supportedBands.includes(finalRequestedBand)) {
    blockedReasons.push(`unsupported_band:${finalRequestedBand}`);
    allowedBand = highestSupportedBandAtOrBelow(capability.supportedBands, finalRequestedBand);
  }

  const rawApprovalSatisfied = input.approvalSatisfied === true;
  const approvalEvidenceRefs = uniqueBrokerStrings(
    input.approvalEvidenceRefs ? [...input.approvalEvidenceRefs] : [],
    12,
  );
  const previewEvidenceRefs = uniqueBrokerStrings(
    input.previewEvidenceRefs ? [...input.previewEvidenceRefs] : [],
    12,
  );
  const targetEvidenceRefs = uniqueBrokerStrings(
    input.targetEvidenceRefs ? [...input.targetEvidenceRefs] : [],
    12,
  );
  const bodyContentConsentReceiptRefs = uniqueBrokerStrings(
    [
      ...(input.bodyContentConsentReceiptRefs ?? []),
      ...(input.consentReceiptRefs ?? []),
      ...capability.bodyContentConsentReceiptRefs,
    ],
    12,
  );
  const mutationConsentReceiptRefs = uniqueBrokerStrings(
    [
      ...(input.mutationConsentReceiptRefs ?? []),
      ...(input.consentReceiptRefs ?? []),
      ...capability.mutationConsentReceiptRefs,
    ],
    12,
  );
  const rollbackEvidenceRefs = uniqueBrokerStrings(
    input.rollbackEvidenceRefs ? [...input.rollbackEvidenceRefs] : [],
    12,
  );
  const executeLikeBand = finalRequestedBand === 'execute' || finalRequestedBand === 'rollback';
  const bodyContentBand = finalRequestedBand === 'body_content';
  const rollbackEvidenceRequirement: AoiCapabilityBrokerRollbackRequirement =
    !capability.rollbackEvidenceRequired
      ? 'not_required'
      : rollbackEvidenceRefs.length > 0
        ? 'satisfied'
        : executeLikeBand
          ? 'missing'
          : 'required';

  if (executeLikeBand && capability.requiresApproval && !rawApprovalSatisfied) {
    blockedReasons.push('approval_required');
  }
  if (executeLikeBand && capability.mutationCapable && mutationConsentReceiptRefs.length <= 0) {
    blockedReasons.push('mutation_consent_receipt_required');
  }
  if (
    executeLikeBand &&
    capability.mutationCapable &&
    rawApprovalSatisfied &&
    (approvalEvidenceRefs.length <= 0 ||
      previewEvidenceRefs.length <= 0 ||
      targetEvidenceRefs.length <= 0)
  ) {
    blockedReasons.push('approval_target_preview_mismatch');
  }
  if (
    executeLikeBand &&
    capability.rollbackEvidenceRequired &&
    rollbackEvidenceRequirement !== 'satisfied'
  ) {
    blockedReasons.push('rollback_evidence_required');
  }
  if (bodyContentBand && bodyContentConsentReceiptRefs.length <= 0) {
    blockedReasons.push('body_content_consent_receipt_required');
  }
  const requiredApproval =
    capability.requiresApproval || blockedReasons.includes('approval_required');
  const requiredConsent = makeConsentRequirement({
    bodyContentState: bodyContentBand
      ? bodyContentConsentReceiptRefs.length > 0
        ? 'satisfied'
        : 'missing'
      : 'not_required',
    mutationState: !capability.mutationCapable
      ? 'not_required'
      : mutationConsentReceiptRefs.length > 0
        ? 'satisfied'
        : executeLikeBand
          ? 'missing'
          : 'required',
    bodyContentReceiptRefs: bodyContentConsentReceiptRefs,
    mutationReceiptRefs: mutationConsentReceiptRefs,
  });
  const authorityDecisionId = makeAuthorityDecisionId([
    manifest.appName,
    capability.id,
    finalRequestedBand,
    requiredConsent.receiptRefs.join(','),
  ]);
  const approvalSandbox = createAoiApprovalSandboxPreview({
    targetKind: 'app',
    targetId: `${manifest.appName}:${capability.id}`,
    intendedMutation: input.requestedOperation || input.actionType || capability.title,
    dryRunSummary: `${manifest.displayName} ${capability.title}: requested=${finalRequestedBand}; operation=${
      input.requestedOperation || input.actionType || capability.intent
    }`,
    requiredAuthorityDecisionId: authorityDecisionId,
    expectedMutationCount: capability.mutationCapable && executeLikeBand ? 1 : 0,
    recoveryPlan: {
      kind: capability.rollbackEvidenceRequired ? 'manual_recovery' : 'not_applicable',
      available: !capability.rollbackEvidenceRequired || rollbackEvidenceRefs.length > 0,
      summary: capability.rollbackEvidenceRequired
        ? rollbackEvidenceRefs.length > 0
          ? `Rollback or recovery evidence is attached for ${capability.title}.`
          : `Rollback or recovery evidence is required before ${capability.title} can execute.`
        : 'No rollback evidence is required for this app capability.',
      evidenceRefs: rollbackEvidenceRefs,
    },
    rollback: {
      required: capability.rollbackEvidenceRequired && executeLikeBand,
      note:
        rollbackEvidenceRefs.length > 0
          ? `Use attached rollback/recovery evidence before retrying or reverting ${capability.title}.`
          : `Do not execute ${capability.title} until rollback/recovery evidence is attached.`,
      evidenceRefs: rollbackEvidenceRefs,
    },
    postActionValidation: {
      kind: 'check',
      label: `Record connector authority audit ${authorityDecisionId} and validate mutation count.`,
      check: 'App action result is recorded and mutationCount matches the expected sandbox count.',
      evidenceRefs: [`authority-decision:${authorityDecisionId}`],
    },
    evidenceRefs: [
      ...(input.evidenceRefs ? [...input.evidenceRefs] : []),
      ...approvalEvidenceRefs,
      ...previewEvidenceRefs,
      ...targetEvidenceRefs,
      ...rollbackEvidenceRefs,
      ...requiredConsent.receiptRefs,
    ],
  });
  const approvalSandboxValidation = validateAoiApprovalSandboxApproval({
    preview: approvalSandbox,
    approval: input.approvalSandboxApproval,
    now: input.now ?? 0,
    approvalRequired: executeLikeBand && capability.mutationCapable,
    connectorAuthorityState:
      input.additionalBlockedReasons?.some((reason) => reason.includes('source_revoked')) === true
        ? 'revoked'
        : capability.sourceState,
  });
  if (executeLikeBand && capability.mutationCapable && !approvalSandboxValidation.approved) {
    blockedReasons.push(
      ...approvalSandboxValidation.blockedReasons.map((reason) => `sandbox_${reason}`),
    );
  }
  if (blockedReasons.length > 0 && (executeLikeBand || bodyContentBand)) {
    allowedBand = safeBandAfterExecuteBlock(capability.supportedBands, blockedReasons);
  }
  const approvalSatisfied =
    rawApprovalSatisfied &&
    (!executeLikeBand || !capability.mutationCapable || approvalSandboxValidation.approved);
  const canExecute =
    finalRequestedBand === 'execute' &&
    allowedBand === 'execute' &&
    blockedReasons.length <= 0 &&
    (!requiredApproval || approvalSatisfied) &&
    rollbackEvidenceRequirement !== 'missing';
  const finalBlockedReasons = uniqueBrokerStrings(blockedReasons, 12);
  const snapshotEvidenceRefs = operatorSnapshotEvidenceRefs(input.operatorSnapshot);
  const snapshotCannotKnow = operatorSnapshotCannotKnow(input.operatorSnapshot);
  const evidenceRefs = uniqueBrokerStrings(
    [
      `capability-broker-v3:${manifest.appName}:${capability.intent}`,
      `authority-decision:${authorityDecisionId}`,
      ...manifest.evidenceRefs,
      ...capability.evidenceRefs,
      ...(input.evidenceRefs ? [...input.evidenceRefs] : []),
      ...snapshotEvidenceRefs,
      ...approvalEvidenceRefs,
      ...previewEvidenceRefs,
      ...targetEvidenceRefs,
      ...rollbackEvidenceRefs,
      ...requiredConsent.receiptRefs,
      `approval-sandbox-preview:${approvalSandbox.previewHash}`,
      ...approvalSandboxValidation.evidenceRefs,
    ],
    24,
  );
  const cannotKnow = uniqueBrokerStrings(
    [
      ...(finalBlockedReasons.length > 0
        ? [
            `Aoi cannot execute ${capability.title} until ${finalBlockedReasons.join(
              ', ',
            )} is resolved.`,
          ]
        : []),
      ...snapshotCannotKnow,
    ],
    12,
  );
  const auditEvent = makeAuthorityAuditEvent({
    decisionId: authorityDecisionId,
    connectorKind: 'app_capability',
    appName: manifest.appName,
    capabilityId: capability.id,
    requestedBand: finalRequestedBand,
    allowedBand,
    requiredConsent,
    mutationCapable: capability.mutationCapable && executeLikeBand,
    canExecute,
    blockedReasons: finalBlockedReasons,
    cannotKnow,
    evidenceRefs,
  });

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
    approvalSandbox,
    approvalSandboxValidation,
    approvalSandboxSummary: formatAoiApprovalSandboxSummary(
      approvalSandbox,
      approvalSandboxValidation,
    ),
    rollbackEvidenceRequirement,
    rollbackEvidenceRefs,
    requiredConsent,
    sourceState: capability.sourceState,
    blockedReasons: finalBlockedReasons,
    cannotKnow,
    auditRequired: true,
    authorityDecisionId,
    auditEvent,
    canExecute,
    evidenceRefs,
    actionAuthority: 'display_only',
    mutationCount: 0,
    unauthorizedMutationCount: 0,
  };
}

function sourceStateFromContract(
  contract: AoiSourceFreshnessContract | undefined,
): AoiConnectorAuthoritySourceState {
  if (!contract) {
    return 'unknown';
  }
  if (contract.consentState === 'disconnected' || contract.freshnessState === 'disconnected') {
    return 'disconnected';
  }
  if (contract.consentState === 'revoked' || contract.freshnessState === 'revoked') {
    return 'revoked';
  }
  if (contract.consentState === 'disabled' || contract.freshnessState === 'disabled') {
    return 'disabled';
  }
  if (contract.freshnessState === 'stale' || contract.freshnessState === 'failed') {
    return 'stale';
  }
  if (contract.freshnessState === 'unknown') {
    return 'unknown';
  }
  return 'available';
}

function sourceConsentStateForBand(params: {
  contract?: AoiSourceFreshnessContract;
  requestedBand: AoiCapabilityBrokerBand;
  receiptRefs: readonly string[];
}): AoiConnectorAuthorityConsentState {
  if (params.requestedBand !== 'body_content') {
    return 'not_required';
  }
  const contract = params.contract;
  if (!contract) {
    return 'missing';
  }
  if (contract.consentState === 'revoked') {
    return 'revoked';
  }
  if (contract.consentState === 'disabled') {
    return 'disabled';
  }
  if (contract.consentState === 'disconnected') {
    return 'disconnected';
  }
  if (
    contract.bodyAccessState === 'body_disabled' ||
    contract.bodyAccessState === 'metadata_only' ||
    contract.bodyAccessState === 'withheld'
  ) {
    return 'missing';
  }
  return params.receiptRefs.length > 0 ? 'satisfied' : 'missing';
}

function supportedBandsForSource(
  contract: AoiSourceFreshnessContract | undefined,
): AoiCapabilityBrokerBand[] {
  const bands = new Set<AoiCapabilityBrokerBand>([
    'observe',
    'summarize',
    'metadata_only',
    'audit',
  ]);
  if (contract?.bodyAccessState === 'not_applicable' && contract.consentState !== 'revoked') {
    bands.add('body_content');
  }
  return AOI_CAPABILITY_BROKER_BANDS.filter((band) => bands.has(band));
}

function connectorDecisionFromBroker(
  decision: AoiCapabilityBrokerDecision,
): AoiConnectorAuthorityDecision {
  return {
    version: 1,
    authorityDecisionId: decision.authorityDecisionId,
    connectorKind: 'app_capability',
    appId: decision.appId,
    appName: decision.appName,
    displayName: decision.displayName,
    capabilityId: decision.capabilityId,
    requestedOperation: decision.requestedOperation,
    requestedBand: decision.requestedBand,
    allowedBand: decision.allowedBand,
    supportedBands: decision.supportedBands,
    sourceState: decision.sourceState,
    requiredConsent: decision.requiredConsent,
    requiredApproval: decision.requiredApproval,
    approvalSatisfied: decision.approvalSatisfied,
    approvalSandbox: decision.approvalSandbox,
    approvalSandboxValidation: decision.approvalSandboxValidation,
    approvalSandboxSummary: decision.approvalSandboxSummary,
    rollbackEvidenceRequirement: decision.rollbackEvidenceRequirement,
    auditRequired: decision.auditRequired,
    auditEvent: decision.auditEvent,
    blockedReasons: decision.blockedReasons,
    cannotKnow: decision.cannotKnow,
    canExecute: decision.canExecute,
    bodyContentAuthorized:
      decision.requestedBand === 'body_content' &&
      decision.requiredConsent.bodyContent === 'satisfied' &&
      decision.blockedReasons.length <= 0,
    mutationCapable: decision.mutationCapable,
    mutationAuthorized: decision.canExecute && decision.mutationCapable,
    evidenceRefs: decision.evidenceRefs,
    actionAuthority: 'display_only',
    mutationCount: 0,
    unauthorizedMutationCount: 0,
  };
}

function decideAoiPersonalSourceConnectorAuthority(
  input: AoiConnectorAuthorityDecisionInput,
): AoiConnectorAuthorityDecision {
  const sourceId = String(input.sourceId ?? '').trim();
  const contract = input.sourceFreshnessContracts?.find((item) => item.sourceId === sourceId);
  const source =
    input.sourceRegistry?.sources.find((item) => item.id === sourceId) ??
    (contract
      ? {
          id: contract.sourceId,
          kind: contract.sourceKind,
          label: contract.sourceLabel,
        }
      : null);
  const requestedBand = input.requestedBand ?? 'metadata_only';
  const supportedBands = supportedBandsForSource(contract);
  const sourceState = sourceStateFromContract(contract);
  const bodyContentReceiptRefs = uniqueBrokerStrings(
    [
      ...(input.bodyContentConsentReceiptRefs ?? []),
      ...(input.consentReceiptRefs ?? []),
      ...(contract?.consentState === 'granted' ? [`source-consent:${sourceId}`] : []),
    ],
    12,
  );
  const bodyConsentState = sourceConsentStateForBand({
    contract,
    requestedBand,
    receiptRefs: bodyContentReceiptRefs,
  });
  const requiredConsent = makeConsentRequirement({
    bodyContentState: bodyConsentState,
    mutationState: 'not_required',
    bodyContentReceiptRefs,
  });
  const blockedReasons: string[] = [...(input.additionalBlockedReasons ?? [])];
  if (!sourceId || !source || !contract) {
    blockedReasons.push('unknown_source');
  }
  if (!supportedBands.includes(requestedBand)) {
    blockedReasons.push(`unsupported_band:${requestedBand}`);
  }
  if (sourceState === 'disconnected') {
    blockedReasons.push('source_disconnected');
  } else if (sourceState === 'revoked') {
    blockedReasons.push('source_revoked');
  } else if (sourceState === 'disabled') {
    blockedReasons.push('source_disabled');
  } else if (sourceState === 'stale') {
    blockedReasons.push('source_stale');
  } else if (sourceState === 'unknown') {
    blockedReasons.push('source_unknown');
  }
  if (requestedBand === 'body_content' && bodyConsentState !== 'satisfied') {
    blockedReasons.push('body_content_consent_required');
  }

  const finalBlockedReasons = uniqueBrokerStrings(blockedReasons, 12);
  const allowedBand =
    finalBlockedReasons.length > 0
      ? supportedBands.includes('metadata_only') && sourceState === 'available'
        ? 'metadata_only'
        : 'observe'
      : requestedBand;
  const authorityDecisionId = makeAuthorityDecisionId([
    'personal_source',
    sourceId,
    requestedBand,
    allowedBand,
    finalBlockedReasons.join(','),
    requiredConsent.receiptRefs.join(','),
  ]);
  const snapshotEvidenceRefs = operatorSnapshotEvidenceRefs(input.operatorSnapshot);
  const snapshotCannotKnow = operatorSnapshotCannotKnow(input.operatorSnapshot);
  const cannotKnow = uniqueBrokerStrings(
    [
      ...(contract?.cannotKnow.map((item) => item.statement) ?? []),
      ...(!contract
        ? ['Aoi cannot know this source because no source freshness contract exists.']
        : []),
      ...snapshotCannotKnow,
    ],
    12,
  );
  const evidenceRefs = uniqueBrokerStrings(
    [
      `authority-decision:${authorityDecisionId}`,
      ...(contract?.evidenceRefs ?? []),
      ...(input.evidenceRefs ? [...input.evidenceRefs] : []),
      ...snapshotEvidenceRefs,
      ...requiredConsent.receiptRefs,
    ],
    24,
  );
  const auditEvent = makeAuthorityAuditEvent({
    decisionId: authorityDecisionId,
    connectorKind: source ? 'personal_source' : 'unknown',
    sourceId: sourceId || undefined,
    capabilityId: requestedBand,
    requestedBand,
    allowedBand,
    requiredConsent,
    mutationCapable: false,
    canExecute: false,
    blockedReasons: finalBlockedReasons,
    cannotKnow,
    evidenceRefs,
  });
  return {
    version: 1,
    authorityDecisionId,
    connectorKind: source ? 'personal_source' : 'unknown',
    appId: null,
    appName: source?.kind ?? 'unknown',
    displayName: (source?.label ?? sourceId) || 'unknown source',
    ...(sourceId ? { sourceId } : {}),
    ...(source?.kind ? { sourceKind: source.kind } : {}),
    capabilityId: `source:${sourceId || 'unknown'}:${requestedBand}`,
    requestedOperation: input.requestedOperation ?? requestedBand,
    requestedBand,
    allowedBand,
    supportedBands,
    sourceState,
    requiredConsent,
    requiredApproval: false,
    approvalSatisfied: false,
    rollbackEvidenceRequirement: 'not_required',
    auditRequired: true,
    auditEvent,
    blockedReasons: finalBlockedReasons,
    cannotKnow,
    canExecute: false,
    bodyContentAuthorized:
      requestedBand === 'body_content' &&
      bodyConsentState === 'satisfied' &&
      finalBlockedReasons.length <= 0,
    mutationCapable: false,
    mutationAuthorized: false,
    evidenceRefs,
    actionAuthority: 'display_only',
    mutationCount: 0,
    unauthorizedMutationCount: 0,
  };
}

export function decideAoiConnectorAuthority(
  input: AoiConnectorAuthorityDecisionInput,
): AoiConnectorAuthorityDecision {
  if (input.connectorKind === 'personal_source') {
    return decideAoiPersonalSourceConnectorAuthority(input);
  }
  return connectorDecisionFromBroker(
    decideAoiCapabilityBrokerAuthority({
      appReference: input.appReference ?? 'unknown',
      capabilityId: input.capabilityId,
      intentReference: input.intentReference,
      actionType: input.actionType,
      requestedOperation: input.requestedOperation,
      requestedBand: input.requestedBand,
      approvalSatisfied: input.approvalSatisfied,
      approvalEvidenceRefs: input.approvalEvidenceRefs,
      approvalSandboxApproval: input.approvalSandboxApproval,
      previewEvidenceRefs: input.previewEvidenceRefs,
      targetEvidenceRefs: input.targetEvidenceRefs,
      rollbackEvidenceRefs: input.rollbackEvidenceRefs,
      consentReceiptRefs: input.consentReceiptRefs,
      bodyContentConsentReceiptRefs: input.bodyContentConsentReceiptRefs,
      mutationConsentReceiptRefs: input.mutationConsentReceiptRefs,
      additionalBlockedReasons: input.additionalBlockedReasons,
      evidenceRefs: input.evidenceRefs,
      operatorSnapshot: input.operatorSnapshot,
      now: input.now,
      apps: input.apps,
    }),
  );
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
    '- Connector Authority Registry v3 is the structured source of truth for app and personal-source authority. Use manifests, source freshness contracts, consent receipts, and audit decisions instead of UI text guesses.',
    `- Connector Authority Registry v3 coverage: ${summary.appCount} apps, ${summary.capabilityCount} app capabilities, ${summary.approvalGatedMutationCount} approval-gated mutation capabilities, ${summary.rollbackRequiredCount} rollback-required capabilities.`,
    '- App mutation execution is not authorized by capability discovery alone. Without matching approval, preview/target, consent, and rollback/recovery evidence, the safe ceiling is prepare, preview, or request approval, and mutationCount/unauthorizedMutationCount must remain 0.',
    '- Metadata-only authority never grants body/content access. Disconnected, revoked, disabled, stale, or unknown sources must be described as blind spots with cannot-know statements.',
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
