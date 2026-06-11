import * as fs from 'fs';
import { createHash } from 'crypto';
import { dirname, isAbsolute, relative, resolve } from 'path';
import type { AoiProposal, AoiProposalDecision } from './aoiAutonomyTypes';
import type { AoiMemoryEntry } from './aoiMemoryShared';

export type AoiRelationNodeKind =
  | 'memory'
  | 'episode'
  | 'research_run'
  | 'artifact'
  | 'proposal'
  | 'reflection'
  | 'procedure'
  | 'project'
  | 'topic';

export type AoiRelationEdgeKind =
  | 'supports'
  | 'supersedes'
  | 'contradicts'
  | 'caused_by'
  | 'followed_by'
  | 'used_tool'
  | 'belongs_to'
  | 'suggested_by';

export interface AoiRelationNode {
  id: string;
  kind: AoiRelationNodeKind;
  ref: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  status?: 'active' | 'archived' | 'deleted' | 'superseded' | 'unknown';
}

export interface AoiRelationEdge {
  id: string;
  from: string;
  to: string;
  kind: AoiRelationEdgeKind;
  createdAt: number;
  updatedAt: number;
  evidenceRefs: string[];
}

export interface AoiRelationIndex {
  version: 1;
  sessionPath: string;
  updatedAt: number;
  nodes: AoiRelationNode[];
  edges: AoiRelationEdge[];
}

const RELATIONS_FILE_NAME = 'relations.json';
const AUTONOMY_ROOT_DIR = 'aoi-autonomy';
const MAX_RELATION_NODES = 600;
const MAX_RELATION_EDGES = 1500;
const MAX_NODE_LABEL_CHARS = 120;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateLabel(value: string): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= MAX_NODE_LABEL_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_NODE_LABEL_CHARS - 1).trimEnd()}...`;
}

function sanitizePathSafePart(value: string): string {
  return (
    normalizeWhitespace(value)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'item'
  );
}

function hashPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function normalizeSessionPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.includes('..')) {
    return null;
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(normalized)) {
    return null;
  }
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return normalized;
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function resolveRelationsFile(
  sessionsDir: string,
  sessionPath: string,
): {
  sessionPath: string;
  filePath: string;
} {
  const normalizedSessionPath = normalizeSessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const sessionsRoot = resolve(sessionsDir);
  const filePath = resolve(
    sessionsRoot,
    normalizedSessionPath,
    AUTONOMY_ROOT_DIR,
    RELATIONS_FILE_NAME,
  );
  if (!isPathInsideRoot(sessionsRoot, filePath)) {
    throw new Error('Resolved Aoi relation index path escaped the sessions directory.');
  }
  return {
    sessionPath: normalizedSessionPath,
    filePath,
  };
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${hashPart(filePath).slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

export function makeAoiRelationNodeId(kind: AoiRelationNodeKind, ref: string): string {
  return `${kind}-${sanitizePathSafePart(ref)}-${hashPart(`${kind}:${ref}`)}`.slice(0, 96);
}

export function makeAoiRelationEdgeId(from: string, kind: AoiRelationEdgeKind, to: string): string {
  return `edge-${hashPart(`${from}|${kind}|${to}`)}`;
}

export function inferAoiRelationNodeKind(ref: string): AoiRelationNodeKind {
  if (ref.startsWith('memory:')) {
    return 'memory';
  }
  if (ref.startsWith('episode:') || ref.startsWith('observation:') || ref.startsWith('decision:')) {
    return 'episode';
  }
  if (ref.startsWith('research:')) {
    return ref.includes('/') ? 'artifact' : 'research_run';
  }
  if (ref.startsWith('artifact:')) {
    return 'artifact';
  }
  if (ref.startsWith('proposal:')) {
    return 'proposal';
  }
  if (ref.startsWith('reflection:')) {
    return 'reflection';
  }
  if (ref.startsWith('procedure:')) {
    return 'procedure';
  }
  if (ref.startsWith('project:')) {
    return 'project';
  }
  if (ref.startsWith('topic:')) {
    return 'topic';
  }
  return 'artifact';
}

export function makeAoiRelationNode(params: {
  ref: string;
  kind?: AoiRelationNodeKind;
  label?: string;
  status?: AoiRelationNode['status'];
  now?: number;
}): AoiRelationNode {
  const ref = truncateLabel(params.ref);
  const kind = params.kind ?? inferAoiRelationNodeKind(ref);
  const now = params.now ?? Date.now();
  return {
    id: makeAoiRelationNodeId(kind, ref),
    kind,
    ref,
    label: truncateLabel(params.label || ref),
    createdAt: now,
    updatedAt: now,
    ...(params.status ? { status: params.status } : {}),
  };
}

export function makeAoiRelationEdge(params: {
  from: string;
  to: string;
  kind: AoiRelationEdgeKind;
  evidenceRefs?: string[];
  now?: number;
}): AoiRelationEdge {
  const now = params.now ?? Date.now();
  return {
    id: makeAoiRelationEdgeId(params.from, params.kind, params.to),
    from: params.from,
    to: params.to,
    kind: params.kind,
    createdAt: now,
    updatedAt: now,
    evidenceRefs: [...new Set(params.evidenceRefs ?? [])].slice(0, 12),
  };
}

export function loadAoiRelationIndex(sessionsDir: string, sessionPath: string): AoiRelationIndex {
  const resolved = resolveRelationsFile(sessionsDir, sessionPath);
  const parsed = readJson<Partial<AoiRelationIndex>>(resolved.filePath);
  if (!parsed || parsed.version !== 1) {
    return {
      version: 1,
      sessionPath: resolved.sessionPath,
      updatedAt: 0,
      nodes: [],
      edges: [],
    };
  }
  return {
    version: 1,
    sessionPath: resolved.sessionPath,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes.filter(isAoiRelationNode) : [],
    edges: Array.isArray(parsed.edges) ? parsed.edges.filter(isAoiRelationEdge) : [],
  };
}

export function saveAoiRelationIndex(
  sessionsDir: string,
  sessionPath: string,
  index: AoiRelationIndex,
): AoiRelationIndex {
  const resolved = resolveRelationsFile(sessionsDir, sessionPath);
  const normalized: AoiRelationIndex = {
    version: 1,
    sessionPath: resolved.sessionPath,
    updatedAt: index.updatedAt,
    nodes: index.nodes.slice(0, MAX_RELATION_NODES),
    edges: index.edges.slice(0, MAX_RELATION_EDGES),
  };
  writeJsonAtomic(resolved.filePath, normalized);
  return normalized;
}

export function upsertAoiRelations(
  sessionsDir: string,
  sessionPath: string,
  patch: {
    nodes?: AoiRelationNode[];
    edges?: AoiRelationEdge[];
    now?: number;
  },
): AoiRelationIndex {
  const now = patch.now ?? Date.now();
  const current = loadAoiRelationIndex(sessionsDir, sessionPath);
  const nodesById = new Map<string, AoiRelationNode>();
  for (const node of current.nodes) {
    nodesById.set(node.id, node);
  }
  for (const node of patch.nodes ?? []) {
    const existing = nodesById.get(node.id);
    nodesById.set(node.id, {
      ...existing,
      ...node,
      createdAt: existing?.createdAt ?? node.createdAt ?? now,
      updatedAt: now,
    });
  }

  const edgesById = new Map<string, AoiRelationEdge>();
  for (const edge of current.edges) {
    edgesById.set(edge.id, edge);
  }
  for (const edge of patch.edges ?? []) {
    const existing = edgesById.get(edge.id);
    edgesById.set(edge.id, {
      ...existing,
      ...edge,
      createdAt: existing?.createdAt ?? edge.createdAt ?? now,
      updatedAt: now,
      evidenceRefs: [...new Set([...(existing?.evidenceRefs ?? []), ...edge.evidenceRefs])].slice(
        0,
        12,
      ),
    });
  }

  return saveAoiRelationIndex(sessionsDir, sessionPath, {
    version: 1,
    sessionPath: current.sessionPath,
    updatedAt: now,
    nodes: [...nodesById.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_RELATION_NODES),
    edges: [...edgesById.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_RELATION_EDGES),
  });
}

export function recordAoiProposalCreatedRelations(
  sessionsDir: string,
  proposal: AoiProposal,
  now = Date.now(),
): AoiRelationIndex {
  const proposalNode = makeAoiRelationNode({
    ref: `proposal:${proposal.id}`,
    kind: 'proposal',
    label: proposal.title,
    status: proposal.status === 'active' || proposal.status === 'accepted' ? 'active' : 'unknown',
    now,
  });
  const nodes = [proposalNode];
  const edges: AoiRelationEdge[] = [];
  const refs = [...new Set([...proposal.evidenceRefs, ...proposal.artifactRefs])];
  for (const memoryId of proposal.memoryIds) {
    refs.push(`memory:${memoryId}`);
  }
  for (const ref of [...new Set(refs)]) {
    const node = makeAoiRelationNode({ ref, now });
    nodes.push(node);
    edges.push(
      makeAoiRelationEdge({
        from: node.id,
        to: proposalNode.id,
        kind: 'supports',
        evidenceRefs: [ref],
        now,
      }),
      makeAoiRelationEdge({
        from: proposalNode.id,
        to: node.id,
        kind: 'suggested_by',
        evidenceRefs: [ref],
        now,
      }),
    );
  }
  return upsertAoiRelations(sessionsDir, proposal.sessionPath, { nodes, edges, now });
}

export function recordAoiProposalDecisionRelations(
  sessionsDir: string,
  sessionPath: string,
  proposal: AoiProposal,
  decision: AoiProposalDecision,
  now = Date.now(),
): AoiRelationIndex {
  const proposalNode = makeAoiRelationNode({
    ref: `proposal:${proposal.id}`,
    kind: 'proposal',
    label: proposal.title,
    status: proposal.status === 'active' || proposal.status === 'accepted' ? 'active' : 'unknown',
    now,
  });
  const decisionNode = makeAoiRelationNode({
    ref: `decision:${decision.id}`,
    kind: 'episode',
    label: `${decision.action}:${proposal.title}`,
    status: 'active',
    now,
  });
  return upsertAoiRelations(sessionsDir, sessionPath, {
    nodes: [proposalNode, decisionNode],
    edges: [
      makeAoiRelationEdge({
        from: proposalNode.id,
        to: decisionNode.id,
        kind: 'followed_by',
        evidenceRefs: [`proposal:${proposal.id}`],
        now,
      }),
      makeAoiRelationEdge({
        from: decisionNode.id,
        to: proposalNode.id,
        kind: 'caused_by',
        evidenceRefs: [`decision:${decision.id}`],
        now,
      }),
    ],
    now,
  });
}

export function recordAoiResearchFollowupExecutionRelations(params: {
  sessionsDir: string;
  sessionPath: string;
  proposal: AoiProposal;
  runId: string;
  priorRefs?: string[];
  now?: number;
}): AoiRelationIndex {
  const now = params.now ?? Date.now();
  const proposalNode = makeAoiRelationNode({
    ref: `proposal:${params.proposal.id}`,
    kind: 'proposal',
    label: params.proposal.title,
    now,
  });
  const runNode = makeAoiRelationNode({
    ref: `research:${params.runId}`,
    kind: 'research_run',
    label: params.runId,
    status: 'active',
    now,
  });
  const nodes = [proposalNode, runNode];
  const edges = [
    makeAoiRelationEdge({
      from: runNode.id,
      to: proposalNode.id,
      kind: 'caused_by',
      evidenceRefs: [`proposal:${params.proposal.id}`],
      now,
    }),
    makeAoiRelationEdge({
      from: proposalNode.id,
      to: runNode.id,
      kind: 'followed_by',
      evidenceRefs: [`proposal:${params.proposal.id}`],
      now,
    }),
  ];
  for (const ref of [...new Set(params.priorRefs ?? [])]) {
    const node = makeAoiRelationNode({ ref, now });
    nodes.push(node);
    edges.push(
      makeAoiRelationEdge({
        from: node.id,
        to: runNode.id,
        kind: 'supports',
        evidenceRefs: [ref],
        now,
      }),
    );
  }
  return upsertAoiRelations(params.sessionsDir, params.sessionPath, { nodes, edges, now });
}

export function recordAoiProcedurePromotionRelations(params: {
  sessionsDir: string;
  sessionPath: string;
  procedureId: string;
  targetRef: string;
  sourceRefs: string[];
  decisionId?: string;
  now?: number;
}): AoiRelationIndex {
  const now = params.now ?? Date.now();
  const procedureNode = makeAoiRelationNode({
    ref: `procedure:${params.procedureId}`,
    kind: 'procedure',
    label: params.procedureId,
    status: 'active',
    now,
  });
  const targetNode = makeAoiRelationNode({ ref: params.targetRef, now });
  const nodes = [procedureNode, targetNode];
  const edges = [
    makeAoiRelationEdge({
      from: procedureNode.id,
      to: targetNode.id,
      kind: 'belongs_to',
      evidenceRefs: params.sourceRefs,
      now,
    }),
  ];
  for (const ref of [...new Set(params.sourceRefs)]) {
    const node = makeAoiRelationNode({ ref, now });
    nodes.push(node);
    edges.push(
      makeAoiRelationEdge({
        from: node.id,
        to: procedureNode.id,
        kind: 'supports',
        evidenceRefs: [ref],
        now,
      }),
    );
  }
  if (params.decisionId) {
    const decisionNode = makeAoiRelationNode({ ref: `decision:${params.decisionId}`, now });
    nodes.push(decisionNode);
    edges.push(
      makeAoiRelationEdge({
        from: decisionNode.id,
        to: procedureNode.id,
        kind: 'caused_by',
        evidenceRefs: [`decision:${params.decisionId}`],
        now,
      }),
    );
  }
  return upsertAoiRelations(params.sessionsDir, params.sessionPath, { nodes, edges, now });
}

export function getActiveAoiRelationMemoryIds(
  index: AoiRelationIndex,
  memories: AoiMemoryEntry[],
): string[] {
  const activeIds = new Set(
    memories.filter((memory) => memory.status === 'active').map((memory) => `memory:${memory.id}`),
  );
  return index.nodes
    .filter((node) => node.kind === 'memory' && activeIds.has(node.ref))
    .map((node) => node.ref.slice('memory:'.length));
}

function isAoiRelationNode(value: unknown): value is AoiRelationNode {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const node = value as Partial<AoiRelationNode>;
  return (
    typeof node.id === 'string' &&
    typeof node.ref === 'string' &&
    typeof node.label === 'string' &&
    isAoiRelationNodeKind(node.kind) &&
    typeof node.createdAt === 'number' &&
    typeof node.updatedAt === 'number'
  );
}

function isAoiRelationEdge(value: unknown): value is AoiRelationEdge {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const edge = value as Partial<AoiRelationEdge>;
  return (
    typeof edge.id === 'string' &&
    typeof edge.from === 'string' &&
    typeof edge.to === 'string' &&
    isAoiRelationEdgeKind(edge.kind) &&
    Array.isArray(edge.evidenceRefs) &&
    typeof edge.createdAt === 'number' &&
    typeof edge.updatedAt === 'number'
  );
}

function isAoiRelationNodeKind(value: unknown): value is AoiRelationNodeKind {
  return (
    value === 'memory' ||
    value === 'episode' ||
    value === 'research_run' ||
    value === 'artifact' ||
    value === 'proposal' ||
    value === 'reflection' ||
    value === 'procedure' ||
    value === 'project' ||
    value === 'topic'
  );
}

function isAoiRelationEdgeKind(value: unknown): value is AoiRelationEdgeKind {
  return (
    value === 'supports' ||
    value === 'supersedes' ||
    value === 'contradicts' ||
    value === 'caused_by' ||
    value === 'followed_by' ||
    value === 'used_tool' ||
    value === 'belongs_to' ||
    value === 'suggested_by'
  );
}
