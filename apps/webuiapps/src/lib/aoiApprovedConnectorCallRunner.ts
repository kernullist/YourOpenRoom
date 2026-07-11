import { createHash } from 'crypto';
import {
  compareAoiApprovedConnectorCallApproval,
  evaluateAoiApprovedConnectorCallPolicy,
} from './aoiApprovedConnectorCallPolicy';
import {
  assertAoiMcpConnectorEndpointResolvesPublic,
  buildAoiMcpConnectorPinnedDispatcher,
  type AoiMcpConnectorAddressResolver,
  type AoiMcpConnectorHostLookup,
} from './aoiMcpConnectorDnsGuard';
import {
  AOI_MCP_READ_RESOURCE_METHOD,
  resolveTrustedAoiMcpConnector,
  type AoiMcpConnectorsConfig,
} from './aoiMcpConnectorRegistry';
import { McpHttpClient } from './idaMcpHttpClient';
import type {
  AoiApprovedConnectorCallPolicy,
  AoiApprovedConnectorCallRequest,
  AoiApprovedConnectorCallResult,
  AoiConnectorCallAuditRecord,
  AoiConnectorCallBlockReason,
} from './aoiAutonomyTypes';

// Server-side runner that executes an approved Aoi connector call (live MCP RPC).
// Mirrors aoiApprovedAppActionRunner.ts / aoiApprovedFileMutationRunner.ts:
// re-derive the policy (with the same side-effecting env gate the execution layer
// used), validate the stored approval, then fire the RPC for any routing the policy
// allowed -- read-only by default, or a side-effecting tool ONLY when the hard env
// gate is on AND the approved action carried the irreversibility acknowledgment.
//
// Unlike app_action's live op (browser-only postMessage), an HTTP MCP backend IS
// reachable from Node, so this is a real server-side call. Two hard invariants:
//   1. The endpoint is resolved from the trusted allow-list by connector id, here
//      again at execute time -- NEVER from the proposal. If the connector is no
//      longer trusted/enabled/server-callable, the call is blocked before any RPC.
//   2. External side effects are not reversible, so there is never a checkpoint; a
//      side-effecting call is permitted only behind the env gate + explicit
//      irreversibility acknowledgment (the policy enforces both before it allows).
//
// The transport is injectable so tests never hit the network; the default wraps
// the shared McpHttpClient. This module is server-only (imports Node 'crypto' and
// the HTTP client) and must not be pulled into the client bundle.

export interface AoiConnectorCallTransport {
  callTool(params: {
    endpointUrl: string;
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<unknown>;
  readResource(params: { endpointUrl: string; resourceUri: string }): Promise<unknown>;
}

export interface AoiApprovedConnectorCallRunnerOptions {
  connectors: AoiMcpConnectorsConfig | null;
  approvedPolicy?: AoiApprovedConnectorCallPolicy | null;
  // Hard env gate (server-resolved, OFF by default). Must match the value the
  // execution layer used so the execute-time policy re-evaluation here agrees with
  // the gate decision; false/absent keeps side-effecting tools hard-blocked.
  allowSideEffecting?: boolean;
  transport?: AoiConnectorCallTransport;
  // Injectable hostname resolver for the execute-time DNS-rebind re-check. Tests
  // pass a stub so they stay offline; production uses the Node 'dns' default.
  resolveHost?: AoiMcpConnectorHostLookup;
  // P2.5: injectable all-records resolver for the connect-time IP-pinning dispatcher.
  resolveAddresses?: AoiMcpConnectorAddressResolver;
  now?: number;
}

// P2.5: the default connector transport now PINS the connection to a DNS-validated public IP
// via an undici dispatcher, closing the DNS-rebind TOCTOU (validation + connect are atomic;
// fetch no longer re-resolves independently). A fresh pinned client is built per endpoint so
// the shared getOrCreateMcpHttpClient (idaPePlugin's loopback transport) is never touched.
function buildPinnedConnectorTransport(options: {
  allowPrivateHost?: boolean;
  resolveAddresses?: AoiMcpConnectorAddressResolver;
}): AoiConnectorCallTransport {
  const dispatcher = buildAoiMcpConnectorPinnedDispatcher({
    allowPrivateHost: options.allowPrivateHost === true,
    ...(options.resolveAddresses ? { resolveAddresses: options.resolveAddresses } : {}),
  });
  return {
    callTool({ endpointUrl, toolName, args }) {
      return new McpHttpClient(endpointUrl, 'openroom-connector', '0.2.0', dispatcher).callTool(
        toolName,
        args,
      );
    },
    readResource({ endpointUrl, resourceUri }) {
      return new McpHttpClient(endpointUrl, 'openroom-connector', '0.2.0', dispatcher).readResource(
        resourceUri,
      );
    },
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeAuditId(request: AoiApprovedConnectorCallRequest, startedAt: number): string {
  return `aoi-connector-call-${startedAt.toString(36)}-${sha256Hex(
    `${request.sessionPath}:${request.proposalId ?? ''}:${request.connectorRef}:${request.toolName}:${startedAt}`,
  ).slice(0, 16)}`;
}

// Bounded, content-addressed digest of the response for audit -- never the full
// payload (it may carry sensitive external data and be large).
function digestResult(value: unknown): string {
  let serialized: string;
  try {
    serialized = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null');
  } catch {
    serialized = String(value);
  }
  return `sha256:${sha256Hex(serialized).slice(0, 16)}:len=${serialized.length}`;
}

function digestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `error:${message.replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

interface ConnectorCallOutcome {
  applied: boolean;
  blockReasons: AoiConnectorCallBlockReason[];
  result?: unknown;
  resultDigest?: string;
}

function buildResult(params: {
  request: AoiApprovedConnectorCallRequest;
  policy: AoiApprovedConnectorCallPolicy;
  startedAt: number;
  completedAt: number;
  outcome: ConnectorCallOutcome;
}): AoiApprovedConnectorCallResult {
  const { request, policy, outcome } = params;
  const ok = outcome.applied && outcome.blockReasons.length === 0;
  const auditRecord: AoiConnectorCallAuditRecord = {
    version: 1,
    id: makeAuditId(request, params.startedAt),
    sessionPath: request.sessionPath,
    ...(request.proposalId ? { proposalId: request.proposalId } : {}),
    ...(request.decisionId ? { decisionId: request.decisionId } : {}),
    connectorId: policy.connectorId,
    connectorName: policy.connectorName,
    endpointHost: policy.endpointHost,
    toolName: policy.toolName,
    routing: policy.routing,
    readOnly: policy.readOnly,
    purpose: policy.purpose,
    risk: policy.risk,
    allowed: ok,
    blockReasons: [...new Set(outcome.blockReasons)],
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    durationMs: Math.max(0, params.completedAt - params.startedAt),
    applied: outcome.applied,
    ...(outcome.resultDigest ? { resultDigest: outcome.resultDigest } : {}),
    operationHash: policy.operationHash,
    argsHash: policy.argsHash,
    evidenceRefs: [
      ...new Set([
        `aoi-connector-call-audit:${makeAuditId(request, params.startedAt)}`,
        ...(request.proposalId ? [`proposal:${request.proposalId}`] : []),
        ...(request.decisionId ? [`decision:${request.decisionId}`] : []),
        ...request.evidenceRefs,
      ]),
    ].slice(0, 24),
    approvalFingerprint: policy.approvalFingerprint,
    ...(policy.approvalSandbox
      ? { approvalSandboxPreviewHash: policy.approvalSandbox.previewHash }
      : {}),
    approvalSandboxValidationStatus: ok ? 'approved' : 'blocked',
  };
  return {
    version: 1,
    ok,
    connectorId: policy.connectorId,
    connectorName: policy.connectorName,
    endpointHost: policy.endpointHost,
    toolName: policy.toolName,
    routing: policy.routing,
    readOnly: policy.readOnly,
    applied: outcome.applied,
    ...(outcome.result !== undefined ? { result: outcome.result } : {}),
    ...(outcome.resultDigest ? { resultDigest: outcome.resultDigest } : {}),
    blockReasons: auditRecord.blockReasons,
    auditRecord,
    evidenceRefs: auditRecord.evidenceRefs,
  };
}

export async function applyAoiApprovedConnectorCall(
  request: AoiApprovedConnectorCallRequest,
  options: AoiApprovedConnectorCallRunnerOptions,
): Promise<AoiApprovedConnectorCallResult> {
  const startedAt = options.now ?? Date.now();
  const connectors = options.connectors ?? null;
  const policy = evaluateAoiApprovedConnectorCallPolicy(request, {
    connectors,
    now: startedAt,
    ...(options.allowSideEffecting ? { allowSideEffecting: true } : {}),
  });
  const approvalReasons = compareAoiApprovedConnectorCallApproval({
    approved: options.approvedPolicy ?? undefined,
    current: policy,
    now: startedAt,
  });

  if (!policy.allowed || approvalReasons.length > 0) {
    return buildResult({
      request,
      policy,
      startedAt,
      completedAt: startedAt,
      outcome: {
        applied: false,
        blockReasons: [...policy.blockReasons, ...approvalReasons],
      },
    });
  }

  // Resolve the endpoint from the trusted allow-list again, at execute time. This
  // is the SSRF gate: the endpoint is never proposal-controlled, and a connector
  // that lost trust between accept and execute is blocked before any RPC.
  const entry = resolveTrustedAoiMcpConnector(connectors, request.connectorRef);
  if (!entry) {
    return buildResult({
      request,
      policy,
      startedAt,
      completedAt: options.now ?? startedAt,
      outcome: { applied: false, blockReasons: ['unknown_or_untrusted_connector'] },
    });
  }

  const transport =
    options.transport ??
    buildPinnedConnectorTransport({
      allowPrivateHost: entry.allowPrivateHost,
      ...(options.resolveAddresses ? { resolveAddresses: options.resolveAddresses } : {}),
    });
  const isReadResource = request.toolName === AOI_MCP_READ_RESOURCE_METHOD;
  const resourceUri = (request.resourceUri ?? '').trim();
  if (isReadResource && !resourceUri) {
    return buildResult({
      request,
      policy,
      startedAt,
      completedAt: options.now ?? startedAt,
      outcome: {
        applied: false,
        blockReasons: ['execution_failed'],
        resultDigest: 'error:resources/read requires a resourceUri',
      },
    });
  }

  // DNS-rebind / SSRF re-check at execute time. The registry's literal host check
  // never resolves DNS, so re-validate every address the endpoint hostname resolves
  // to before any network call. A resolved private / loopback / metadata address is
  // a distinct hard block; a transient resolution failure folds into execution_failed
  // (the call could not proceed, like a transport error). Skipped when the connector
  // opted into private hosts; the lookup is injectable so tests stay offline.
  const dnsCheck = await assertAoiMcpConnectorEndpointResolvesPublic(entry.endpointUrl, {
    allowPrivateHost: entry.allowPrivateHost,
    ...(options.resolveHost ? { lookup: options.resolveHost } : {}),
  });
  if (!dnsCheck.ok) {
    const blockReason: AoiConnectorCallBlockReason =
      dnsCheck.reason === 'resolved_private_host_blocked'
        ? 'dns_rebind_blocked'
        : 'execution_failed';
    return buildResult({
      request,
      policy,
      startedAt,
      completedAt: options.now ?? startedAt,
      outcome: {
        applied: false,
        blockReasons: [blockReason],
        resultDigest: `error:dns:${dnsCheck.reason}${
          dnsCheck.addresses.length > 0 ? `:${dnsCheck.addresses.slice(0, 3).join(',')}` : ''
        }`,
      },
    });
  }

  try {
    const result = isReadResource
      ? await transport.readResource({ endpointUrl: entry.endpointUrl, resourceUri })
      : await transport.callTool({
          endpointUrl: entry.endpointUrl,
          toolName: request.toolName,
          args: request.args ?? {},
        });
    return buildResult({
      request,
      policy,
      startedAt,
      completedAt: options.now ?? startedAt,
      outcome: {
        applied: true,
        blockReasons: [],
        result,
        resultDigest: digestResult(result),
      },
    });
  } catch (error) {
    return buildResult({
      request,
      policy,
      startedAt,
      completedAt: options.now ?? startedAt,
      outcome: {
        applied: false,
        blockReasons: ['execution_failed'],
        resultDigest: digestError(error),
      },
    });
  }
}
