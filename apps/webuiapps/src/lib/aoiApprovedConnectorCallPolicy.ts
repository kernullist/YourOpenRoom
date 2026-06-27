import {
  compareAoiApprovalSandboxPreviews,
  createAoiApprovalSandboxPreview,
  normalizeAoiApprovalSandboxPreview,
} from './aoiApprovalSandbox';
import {
  classifyAoiMcpConnectorTool,
  resolveTrustedAoiMcpConnector,
  validateAoiMcpConnectorEndpointHost,
  type AoiMcpConnectorsConfig,
} from './aoiMcpConnectorRegistry';
import type {
  AoiApprovedConnectorCallPolicy,
  AoiApprovedConnectorCallRequest,
  AoiAutonomyRisk,
  AoiConnectorCallBlockReason,
  AoiConnectorCallRouting,
} from './aoiAutonomyTypes';

// Policy + content-addressed approval fingerprint for an approved Aoi connector
// call (MCP RPC). This is the connector analog of aoiApprovedAppActionPolicy.ts /
// aoiApprovedFileMutationPolicy.ts.
//
// The trust authority is the server-readable allow-list (aoiMcpConnectorRegistry,
// passed in via options.connectors); the endpoint is resolved by connector id and
// is NEVER taken from the proposal. Live RPC is gated to read-only tools (plus a
// gated resources/read) because external side effects are not reversible: a
// side-effecting tool is recognized but blocked from live execution this cut.
//
// This module is reachable from the client bundle via aoiAutonomyPolicy, so it
// stays browser-safe (no Node 'crypto'): it reuses the FNV approach shared by the
// approval sandbox, command, file-mutation, and app-action policies.

export const AOI_CONNECTOR_CALL_APPROVAL_TTL_MS = 5 * 60 * 1000;
export const AOI_MAX_CONNECTOR_CALL_ARGS_BYTES = 32 * 1024;

const MAX_PURPOSE_CHARS = 180;
const MAX_TOOL_NAME_CHARS = 120;

// Browser-safe short hash (FNV-1a). Matches the sibling policies.
function hashStable(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// Wider (64-bit) content hash from two independent FNV-1a passes, so the
// content-addressed approval binding has a low collision rate without 'crypto'.
export function hashAoiConnectorCallContent(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = (0x811c9dc5 ^ 0x5bd1e995) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizePurpose(value: unknown): string {
  const purpose =
    typeof value === 'string' ? normalizeWhitespace(value).slice(0, MAX_PURPOSE_CHARS) : '';
  return purpose || 'Trigger an approved Aoi connector call.';
}

function normalizeReference(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeToolName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TOOL_NAME_CHARS) : '';
}

// Strip non-JSON values and bound the size, so the persisted request is portable
// and the content hash is deterministic. Returns undefined for a non-object or an
// unserializable / oversized payload.
export function normalizeConnectorCallArgs(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (!serialized || serialized.length > AOI_MAX_CONNECTOR_CALL_ARGS_BYTES) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// Deterministic canonical serialization (recursively sorted object keys) so the
// args hash is stable regardless of key insertion order between accept and
// execute. Arrays keep their order (semantically significant).
export function stableStringifyConnectorArgs(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyConnectorArgs(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort((left, right) => left[0].localeCompare(right[0]));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringifyConnectorArgs(item)}`)
    .join(',')}}`;
}

export function createAoiApprovedConnectorCallRequest(params: {
  sessionPath: string;
  proposalId?: string;
  decisionId?: string;
  connectorRef: unknown;
  toolName: unknown;
  resourceUri?: unknown;
  args?: unknown;
  purpose?: unknown;
  risk?: AoiAutonomyRisk;
  requestedAt?: number;
  evidenceRefs?: string[];
}): AoiApprovedConnectorCallRequest {
  const args = normalizeConnectorCallArgs(params.args);
  const resourceUri = normalizeReference(params.resourceUri);
  return {
    version: 1,
    sessionPath: params.sessionPath,
    ...(params.proposalId ? { proposalId: params.proposalId } : {}),
    ...(params.decisionId ? { decisionId: params.decisionId } : {}),
    connectorRef: normalizeReference(params.connectorRef),
    toolName: normalizeToolName(params.toolName),
    ...(resourceUri ? { resourceUri } : {}),
    ...(args ? { args } : {}),
    purpose: normalizePurpose(params.purpose),
    risk: params.risk ?? 'high',
    requestedAt: params.requestedAt ?? Date.now(),
    evidenceRefs: [...new Set(params.evidenceRefs ?? [])].slice(0, 16),
  };
}

export function evaluateAoiApprovedConnectorCallPolicy(
  request: AoiApprovedConnectorCallRequest,
  options: { connectors?: AoiMcpConnectorsConfig | null; now?: number } = {},
): AoiApprovedConnectorCallPolicy {
  const purpose = normalizePurpose(request.purpose);
  const purposeHash = hashStable(purpose);
  const connectorRef = normalizeReference(request.connectorRef);
  const toolName = normalizeToolName(request.toolName);
  const blockReasons: AoiConnectorCallBlockReason[] = [];

  if (!connectorRef) {
    blockReasons.push('missing_connector_reference');
  }
  if (!toolName) {
    blockReasons.push('missing_tool_name');
  }

  const entry = connectorRef
    ? resolveTrustedAoiMcpConnector(options.connectors ?? null, connectorRef)
    : null;
  if (connectorRef && !entry) {
    blockReasons.push('unknown_or_untrusted_connector');
  }

  let connectorId = '';
  let connectorName = '';
  let endpointHost = '';
  let routing: AoiConnectorCallRouting = 'unknown';
  let readOnly = false;

  if (entry && toolName) {
    connectorId = entry.id;
    connectorName = entry.name;
    const hostCheck = validateAoiMcpConnectorEndpointHost(entry.endpointUrl, {
      allowPrivateHost: entry.allowPrivateHost,
    });
    if (hostCheck.ok) {
      endpointHost = hostCheck.hostname;
    } else {
      // resolveTrustedAoiMcpConnector already enforces server-callability, so this
      // is defensive; keep a precise reason if a stricter re-check ever fails.
      blockReasons.push('endpoint_not_server_callable');
    }

    const classification = classifyAoiMcpConnectorTool(entry, toolName);
    readOnly = classification.readOnly;
    if (!classification.allowed) {
      if (classification.reason === 'read_resource_not_allowed') {
        blockReasons.push('read_resource_not_allowed');
      } else if (classification.reason === 'missing_tool_name') {
        // already reported above when toolName is blank
      } else {
        blockReasons.push('tool_not_allow_listed');
      }
      routing = 'unknown';
    } else if (classification.readOnly) {
      routing = 'live_read_only';
    } else {
      // Recognized but side-effecting: not eligible for live RPC this cut.
      routing = 'side_effecting';
      blockReasons.push('side_effecting_live_rpc_not_enabled');
    }
  }

  const resourceUri = normalizeReference(request.resourceUri);
  const argsHash = hashAoiConnectorCallContent(stableStringifyConnectorArgs(request.args ?? null));
  const operationHash = hashAoiConnectorCallContent(
    [connectorId || connectorRef, toolName, resourceUri, argsHash].join('|'),
  );

  // External calls make no local file mutation, so the display_only /
  // mutationCount:0 invariant holds even for a live read-only RPC.
  const expectedMutationCount = 0;
  const operationLabel = `${connectorName || connectorRef} ${toolName} (${routing})`;
  const dryRunSummary =
    routing === 'live_read_only'
      ? `Would invoke read-only connector tool ${toolName} on ${connectorName || connectorRef} (op hash ${operationHash}); no local mutation.`
      : `Connector tool ${toolName} on ${connectorName || connectorRef} is not eligible for live RPC (${routing}).`;

  const approvalSandbox = createAoiApprovalSandboxPreview({
    targetKind: 'command',
    targetId: `${connectorId || connectorRef}:${toolName}`,
    intendedMutation: `${operationLabel} op hash ${operationHash}`,
    dryRunSummary,
    requiredAuthorityDecisionId: `approved-connector-call:${hashStable(
      [connectorId || connectorRef, toolName, operationHash, request.risk].join('|'),
    )}`,
    expectedMutationCount,
    recoveryPlan: {
      kind: 'not_applicable',
      available: true,
      summary:
        'A read-only connector call has no local or external side effect, so there is nothing to recover.',
      evidenceRefs: request.evidenceRefs,
    },
    rollback: {
      required: false,
      note: 'External connector calls are not rolled back; live RPC is gated to read-only tools.',
      evidenceRefs: request.evidenceRefs,
    },
    postActionValidation: {
      kind: 'check',
      label: 'Record the connector-call audit and bounded result digest.',
      check: 'Connector-call audit receipt is recorded after execution.',
      evidenceRefs: request.evidenceRefs,
    },
    evidenceRefs: request.evidenceRefs,
  });

  const allowed = blockReasons.length === 0;
  return {
    version: 1,
    allowed,
    blockReasons: [...new Set(blockReasons)],
    connectorRef,
    connectorId,
    connectorName,
    endpointHost,
    toolName,
    routing,
    readOnly,
    operationHash,
    argsHash,
    purpose,
    purposeHash,
    risk: request.risk,
    requiredAutonomyLevel: 'L5',
    approvalFingerprint: approvalSandbox.approvalFingerprint,
    approvalSandbox,
    expiresAt: request.requestedAt + AOI_CONNECTOR_CALL_APPROVAL_TTL_MS,
    rationale: allowed
      ? [
          `Approved read-only connector call ${toolName} on ${connectorName} under L5; external side effects are not reversible so only read-only tools run live.`,
        ]
      : ['Connector call is blocked until it matches the approved connector-call policy.'],
  };
}

export function normalizeAoiApprovedConnectorCallPolicy(
  value: unknown,
): AoiApprovedConnectorCallPolicy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<AoiApprovedConnectorCallPolicy>;
  if (
    raw.version !== 1 ||
    typeof raw.allowed !== 'boolean' ||
    !Array.isArray(raw.blockReasons) ||
    typeof raw.connectorRef !== 'string' ||
    typeof raw.connectorId !== 'string' ||
    typeof raw.connectorName !== 'string' ||
    typeof raw.endpointHost !== 'string' ||
    typeof raw.toolName !== 'string' ||
    (raw.routing !== 'live_read_only' &&
      raw.routing !== 'side_effecting' &&
      raw.routing !== 'unknown') ||
    typeof raw.readOnly !== 'boolean' ||
    typeof raw.operationHash !== 'string' ||
    typeof raw.argsHash !== 'string' ||
    typeof raw.purpose !== 'string' ||
    typeof raw.purposeHash !== 'string' ||
    (raw.risk !== 'low' && raw.risk !== 'medium' && raw.risk !== 'high') ||
    raw.requiredAutonomyLevel !== 'L5' ||
    typeof raw.approvalFingerprint !== 'string' ||
    typeof raw.expiresAt !== 'number' ||
    !Array.isArray(raw.rationale)
  ) {
    return undefined;
  }
  const approvalSandbox = normalizeAoiApprovalSandboxPreview(raw.approvalSandbox);
  return {
    version: 1,
    allowed: raw.allowed,
    blockReasons: raw.blockReasons.filter(
      (item): item is AoiConnectorCallBlockReason => typeof item === 'string',
    ),
    connectorRef: raw.connectorRef,
    connectorId: raw.connectorId,
    connectorName: raw.connectorName,
    endpointHost: raw.endpointHost,
    toolName: raw.toolName,
    routing: raw.routing,
    readOnly: raw.readOnly,
    operationHash: raw.operationHash,
    argsHash: raw.argsHash,
    purpose: raw.purpose,
    purposeHash: raw.purposeHash,
    risk: raw.risk,
    requiredAutonomyLevel: 'L5',
    approvalFingerprint: raw.approvalFingerprint,
    ...(approvalSandbox ? { approvalSandbox } : {}),
    expiresAt: raw.expiresAt,
    rationale: raw.rationale.filter((item): item is string => typeof item === 'string'),
  };
}

export function compareAoiApprovedConnectorCallApproval(params: {
  approved: AoiApprovedConnectorCallPolicy | undefined;
  current: AoiApprovedConnectorCallPolicy;
  now: number;
}): AoiConnectorCallBlockReason[] {
  const approved = params.approved;
  if (!approved) {
    return ['approval_missing', 'approval_sandbox_missing'];
  }
  const reasons: AoiConnectorCallBlockReason[] = [];
  if (approved.expiresAt < params.now) {
    reasons.push('approval_expired');
  }
  if (approved.connectorId !== params.current.connectorId) {
    reasons.push('approval_connector_changed');
  }
  if (approved.toolName !== params.current.toolName) {
    reasons.push('approval_tool_changed');
  }
  if (approved.operationHash !== params.current.operationHash) {
    reasons.push('approval_operation_changed');
  }
  if (approved.risk !== params.current.risk) {
    reasons.push('approval_risk_changed');
  }
  if (approved.purposeHash !== params.current.purposeHash) {
    reasons.push('approval_purpose_changed');
  }
  for (const reason of compareAoiApprovalSandboxPreviews({
    approved: approved.approvalSandbox,
    current: params.current.approvalSandbox,
  })) {
    reasons.push(reason as AoiConnectorCallBlockReason);
  }
  if (
    approved.approvalFingerprint !== params.current.approvalFingerprint &&
    !reasons.includes('approval_operation_changed') &&
    !reasons.includes('approval_connector_changed')
  ) {
    reasons.push('approval_fingerprint_changed');
  }
  return [...new Set(reasons)];
}
