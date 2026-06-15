import * as fs from 'fs';
import { createHash } from 'crypto';
import { dirname, isAbsolute, relative, resolve } from 'path';
import type {
  AoiAttentionEvent,
  AoiGoal,
  AoiKiraOutcomeEvent,
  AoiMissionState,
  AoiObservation,
  AoiPlanStep,
  AoiPlaybook,
  AoiPlaybookStep,
  AoiProposal,
  AoiProposalDecision,
} from './aoiAutonomyTypes';
import type { AoiMemoryEntry } from './aoiMemoryShared';

export type AoiRelationNodeKind =
  | 'memory'
  | 'episode'
  | 'research_run'
  | 'artifact'
  | 'proposal'
  | 'reflection'
  | 'procedure'
  | 'goal'
  | 'mission'
  | 'plan_step'
  | 'playbook'
  | 'playbook_step'
  | 'project'
  | 'kira_work'
  | 'kira_attempt'
  | 'kira_review'
  | 'event'
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
  if (ref.startsWith('goal:')) {
    return 'goal';
  }
  if (ref.startsWith('mission:')) {
    return 'mission';
  }
  if (ref.startsWith('plan-step:')) {
    return 'plan_step';
  }
  if (ref.startsWith('playbook:')) {
    return 'playbook';
  }
  if (ref.startsWith('playbook-step:')) {
    return 'playbook_step';
  }
  if (ref.startsWith('project:')) {
    return 'project';
  }
  if (ref.startsWith('kira-work:')) {
    return 'kira_work';
  }
  if (ref.startsWith('kira-attempt:')) {
    return 'kira_attempt';
  }
  if (ref.startsWith('kira-review:')) {
    return 'kira_review';
  }
  if (ref.startsWith('event:')) {
    return 'event';
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

export function recordAoiRecoveryProposalRelations(
  sessionsDir: string,
  proposal: AoiProposal,
  now = Date.now(),
): AoiRelationIndex {
  const preview = proposal.recoveryPreview;
  if (!preview) {
    return recordAoiProposalCreatedRelations(sessionsDir, proposal, now);
  }

  const proposalRef = `proposal:${proposal.id}`;
  const proposalNode = makeAoiRelationNode({
    ref: proposalRef,
    kind: 'proposal',
    label: proposal.title,
    status: proposal.status === 'active' || proposal.status === 'accepted' ? 'active' : 'unknown',
    now,
  });
  const recoveryRef = `recovery:${preview.failureSignature}`;
  const recoveryNode = makeAoiRelationNode({
    ref: recoveryRef,
    kind: 'artifact',
    label: `${preview.failureKind}:${preview.proposedAction.kind}`,
    status: 'active',
    now,
  });
  const sourceNode = makeAoiRelationNode({
    ref: preview.sourceRef,
    label: preview.failureKind,
    now,
  });
  const nodes = [proposalNode, recoveryNode, sourceNode];
  const edges: AoiRelationEdge[] = [
    makeAoiRelationEdge({
      from: sourceNode.id,
      to: proposalNode.id,
      kind: 'caused_by',
      evidenceRefs: [preview.sourceRef, recoveryRef],
      now,
    }),
    makeAoiRelationEdge({
      from: sourceNode.id,
      to: proposalNode.id,
      kind: 'supports',
      evidenceRefs: preview.evidenceRefs,
      now,
    }),
    makeAoiRelationEdge({
      from: proposalNode.id,
      to: recoveryNode.id,
      kind: 'followed_by',
      evidenceRefs: [proposalRef, preview.sourceRef],
      now,
    }),
  ];

  const refs = [...new Set([...preview.evidenceRefs, ...proposal.artifactRefs])];
  for (const ref of refs) {
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
    );
    if (ref.startsWith('goal:')) {
      edges.push(
        makeAoiRelationEdge({
          from: proposalNode.id,
          to: node.id,
          kind: 'followed_by',
          evidenceRefs: [proposalRef, ref],
          now,
        }),
      );
    }
  }

  return upsertAoiRelations(sessionsDir, proposal.sessionPath, { nodes, edges, now });
}

export function recordAoiObservationRelations(
  sessionsDir: string,
  observation: AoiObservation,
  now = Date.now(),
): AoiRelationIndex {
  const observationRef = `observation:${observation.id}`;
  const observationNode = makeAoiRelationNode({
    ref: observationRef,
    kind: 'episode',
    label: observation.summary,
    status: 'active',
    now,
  });
  const nodes = [observationNode];
  const edges: AoiRelationEdge[] = [];
  const refs = [
    ...observation.memoryIds.map((id) => `memory:${id}`),
    ...observation.artifactRefs,
    ...observation.proposalIds.map((id) => `proposal:${id}`),
  ];

  for (const ref of [...new Set(refs)]) {
    const node = makeAoiRelationNode({ ref, now });
    nodes.push(node);
    edges.push(
      makeAoiRelationEdge({
        from: node.id,
        to: observationNode.id,
        kind: 'supports',
        evidenceRefs: [ref, observationRef],
        now,
      }),
      makeAoiRelationEdge({
        from: observationNode.id,
        to: node.id,
        kind: ref.startsWith('proposal:') ? 'followed_by' : 'belongs_to',
        evidenceRefs: [observationRef],
        now,
      }),
    );
  }

  return upsertAoiRelations(sessionsDir, observation.sessionPath, { nodes, edges, now });
}

export function recordAoiAttentionEventRelations(params: {
  sessionsDir: string;
  event: AoiAttentionEvent;
  observation: AoiObservation;
  proposal?: AoiProposal;
  mission?: AoiMissionState | null;
  now?: number;
}): AoiRelationIndex {
  const now = params.now ?? Date.now();
  const eventRef = `event:${params.event.id}`;
  const observationRef = `observation:${params.observation.id}`;
  const eventNode = makeAoiRelationNode({
    ref: eventRef,
    kind: 'event',
    label: params.event.summary,
    status: 'active',
    now,
  });
  const observationNode = makeAoiRelationNode({
    ref: observationRef,
    kind: 'episode',
    label: params.observation.summary,
    status: 'active',
    now,
  });
  const nodes = [eventNode, observationNode];
  const edges: AoiRelationEdge[] = [
    makeAoiRelationEdge({
      from: eventNode.id,
      to: observationNode.id,
      kind: 'caused_by',
      evidenceRefs: [eventRef, params.event.sourceRef],
      now,
    }),
    makeAoiRelationEdge({
      from: observationNode.id,
      to: eventNode.id,
      kind: 'supports',
      evidenceRefs: [observationRef],
      now,
    }),
  ];

  const refs = [
    params.event.sourceRef,
    ...params.event.evidenceRefs,
    ...(params.proposal ? [`proposal:${params.proposal.id}`] : []),
    ...(params.mission?.sourceRefs.goalRef ? [params.mission.sourceRefs.goalRef] : []),
    ...(params.mission?.sourceRefs.proposalRef ? [params.mission.sourceRefs.proposalRef] : []),
    ...(params.mission?.sourceRefs.researchRunRef
      ? [params.mission.sourceRefs.researchRunRef]
      : []),
    ...(params.mission?.sourceRefs.kiraWorkRef ? [params.mission.sourceRefs.kiraWorkRef] : []),
  ];

  for (const ref of [...new Set(refs)].filter(Boolean)) {
    const node = makeAoiRelationNode({ ref, now });
    nodes.push(node);
    edges.push(
      makeAoiRelationEdge({
        from: node.id,
        to: eventNode.id,
        kind: 'supports',
        evidenceRefs: [ref, eventRef],
        now,
      }),
    );
  }

  if (params.proposal) {
    const proposalNode = makeAoiRelationNode({
      ref: `proposal:${params.proposal.id}`,
      kind: 'proposal',
      label: params.proposal.title,
      status: 'active',
      now,
    });
    nodes.push(proposalNode);
    edges.push(
      makeAoiRelationEdge({
        from: observationNode.id,
        to: proposalNode.id,
        kind: 'suggested_by',
        evidenceRefs: [observationRef, eventRef],
        now,
      }),
    );
  }

  if (params.mission && params.mission.status !== 'none') {
    const missionRef = `mission:${params.event.sessionPath}`;
    const missionNode = makeAoiRelationNode({
      ref: missionRef,
      kind: 'mission',
      label: params.mission.focusSummary,
      status: params.mission.status === 'completed' ? 'archived' : 'active',
      now,
    });
    nodes.push(missionNode);
    edges.push(
      makeAoiRelationEdge({
        from: observationNode.id,
        to: missionNode.id,
        kind: 'supports',
        evidenceRefs: [observationRef, eventRef],
        now,
      }),
    );
  }

  return upsertAoiRelations(params.sessionsDir, params.event.sessionPath, { nodes, edges, now });
}

export function recordAoiKiraOutcomeRelations(params: {
  sessionsDir: string;
  outcome: AoiKiraOutcomeEvent;
  observation?: AoiObservation;
  proposal?: AoiProposal;
  goal?: AoiGoal;
  planStep?: AoiPlanStep;
  memoryIds?: string[];
  now?: number;
}): AoiRelationIndex {
  const now = params.now ?? Date.now();
  const outcomeRef = `event:${params.outcome.id}`;
  const workRef = params.outcome.workRef;
  const outcomeNode = makeAoiRelationNode({
    ref: outcomeRef,
    kind: 'event',
    label: params.outcome.kind,
    status: 'active',
    now,
  });
  const workNode = makeAoiRelationNode({
    ref: workRef,
    kind: 'kira_work',
    label: params.outcome.workTitle,
    status:
      params.outcome.kind === 'kira_work_completed' || params.outcome.kind === 'kira_integrated'
        ? 'archived'
        : 'active',
    now,
  });
  const nodes = [outcomeNode, workNode];
  const edges: AoiRelationEdge[] = [
    makeAoiRelationEdge({
      from: outcomeNode.id,
      to: workNode.id,
      kind: 'caused_by',
      evidenceRefs: [outcomeRef, workRef],
      now,
    }),
  ];

  if (params.outcome.attemptId) {
    const attemptRef = `kira-attempt:${params.outcome.attemptId}`;
    const attemptNode = makeAoiRelationNode({
      ref: attemptRef,
      kind: 'kira_attempt',
      label: `Attempt ${params.outcome.attemptNo ?? params.outcome.attemptId}`,
      status: 'archived',
      now,
    });
    nodes.push(attemptNode);
    edges.push(
      makeAoiRelationEdge({
        from: attemptNode.id,
        to: workNode.id,
        kind: 'belongs_to',
        evidenceRefs: [attemptRef, workRef],
        now,
      }),
    );
  }

  if (params.outcome.reviewId) {
    const reviewRef = `kira-review:${params.outcome.reviewId}`;
    const reviewNode = makeAoiRelationNode({
      ref: reviewRef,
      kind: 'kira_review',
      label: params.outcome.reviewApproved ? 'Kira review approved' : 'Kira review rejected',
      status: 'archived',
      now,
    });
    nodes.push(reviewNode);
    edges.push(
      makeAoiRelationEdge({
        from: reviewNode.id,
        to: workNode.id,
        kind: 'belongs_to',
        evidenceRefs: [reviewRef, workRef],
        now,
      }),
    );
  }

  if (params.proposal) {
    const proposalRef = `proposal:${params.proposal.id}`;
    const proposalNode = makeAoiRelationNode({
      ref: proposalRef,
      kind: 'proposal',
      label: params.proposal.title,
      status:
        params.proposal.status === 'dismissed' ||
        params.proposal.status === 'expired' ||
        params.proposal.status === 'executed'
          ? 'archived'
          : 'active',
      now,
    });
    nodes.push(proposalNode);
    edges.push(
      makeAoiRelationEdge({
        from: workNode.id,
        to: proposalNode.id,
        kind: 'caused_by',
        evidenceRefs: [workRef, proposalRef],
        now,
      }),
      makeAoiRelationEdge({
        from: proposalNode.id,
        to: workNode.id,
        kind: 'followed_by',
        evidenceRefs: [proposalRef, workRef],
        now,
      }),
    );
  }

  if (params.goal) {
    const goalRef = `goal:${params.goal.id}`;
    const goalNode = makeAoiRelationNode({
      ref: goalRef,
      kind: 'goal',
      label: params.goal.title,
      status:
        params.goal.status === 'completed' || params.goal.status === 'abandoned'
          ? 'archived'
          : 'active',
      now,
    });
    nodes.push(goalNode);
    edges.push(
      makeAoiRelationEdge({
        from: workNode.id,
        to: goalNode.id,
        kind: 'supports',
        evidenceRefs: [workRef, goalRef],
        now,
      }),
    );
  }

  if (params.goal && params.planStep) {
    const stepRef = `goal:${params.goal.id}/step:${params.planStep.id}`;
    const stepNode = makeAoiRelationNode({
      ref: stepRef,
      kind: 'plan_step',
      label: params.planStep.title,
      status: params.planStep.status === 'done' ? 'archived' : 'active',
      now,
    });
    nodes.push(stepNode);
    edges.push(
      makeAoiRelationEdge({
        from: workNode.id,
        to: stepNode.id,
        kind: 'supports',
        evidenceRefs: [workRef, stepRef],
        now,
      }),
    );
  }

  if (params.observation) {
    const observationRef = `observation:${params.observation.id}`;
    const observationNode = makeAoiRelationNode({
      ref: observationRef,
      kind: 'episode',
      label: params.observation.summary,
      status: 'active',
      now,
    });
    nodes.push(observationNode);
    edges.push(
      makeAoiRelationEdge({
        from: observationNode.id,
        to: outcomeNode.id,
        kind: 'supports',
        evidenceRefs: [observationRef, outcomeRef],
        now,
      }),
    );
  }

  for (const memoryId of params.memoryIds ?? []) {
    const memoryRef = `memory:${memoryId}`;
    const memoryNode = makeAoiRelationNode({
      ref: memoryRef,
      kind: 'memory',
      label: memoryId,
      status: 'active',
      now,
    });
    nodes.push(memoryNode);
    edges.push(
      makeAoiRelationEdge({
        from: memoryNode.id,
        to: outcomeNode.id,
        kind: 'supports',
        evidenceRefs: [memoryRef, outcomeRef],
        now,
      }),
    );
  }

  for (const ref of [...new Set(params.outcome.evidenceRefs)].filter(Boolean)) {
    const node = makeAoiRelationNode({ ref, now });
    nodes.push(node);
    edges.push(
      makeAoiRelationEdge({
        from: node.id,
        to: outcomeNode.id,
        kind: 'supports',
        evidenceRefs: [ref, outcomeRef],
        now,
      }),
    );
  }

  return upsertAoiRelations(params.sessionsDir, params.outcome.sessionPath, {
    nodes,
    edges,
    now,
  });
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

export function recordAoiKiraHandoffRelations(params: {
  sessionsDir: string;
  sessionPath: string;
  proposal: AoiProposal;
  workRef: string;
  workTitle: string;
  decisionId?: string;
  evidenceRefs?: string[];
  goalRefs?: string[];
  now?: number;
}): AoiRelationIndex {
  const now = params.now ?? Date.now();
  const proposalRef = `proposal:${params.proposal.id}`;
  const proposalNode = makeAoiRelationNode({
    ref: proposalRef,
    kind: 'proposal',
    label: params.proposal.title,
    status: 'active',
    now,
  });
  const workNode = makeAoiRelationNode({
    ref: params.workRef,
    kind: 'kira_work',
    label: params.workTitle,
    status: 'active',
    now,
  });
  const nodes = [proposalNode, workNode];
  const edges: AoiRelationEdge[] = [
    makeAoiRelationEdge({
      from: proposalNode.id,
      to: workNode.id,
      kind: 'followed_by',
      evidenceRefs: [proposalRef],
      now,
    }),
    makeAoiRelationEdge({
      from: workNode.id,
      to: proposalNode.id,
      kind: 'caused_by',
      evidenceRefs: [params.workRef],
      now,
    }),
  ];

  const refs = [...new Set(params.evidenceRefs ?? [])];
  for (const ref of refs) {
    const node = makeAoiRelationNode({ ref, now });
    nodes.push(node);
    edges.push(
      makeAoiRelationEdge({
        from: node.id,
        to: workNode.id,
        kind: 'supports',
        evidenceRefs: [ref],
        now,
      }),
    );
  }

  for (const ref of [...new Set(params.goalRefs ?? [])]) {
    const node = makeAoiRelationNode({ ref, now });
    nodes.push(node);
    edges.push(
      makeAoiRelationEdge({
        from: node.id,
        to: workNode.id,
        kind: 'suggested_by',
        evidenceRefs: [ref, proposalRef],
        now,
      }),
    );
  }

  if (params.decisionId) {
    const decisionRef = `decision:${params.decisionId}`;
    const decisionNode = makeAoiRelationNode({ ref: decisionRef, now });
    nodes.push(decisionNode);
    edges.push(
      makeAoiRelationEdge({
        from: decisionNode.id,
        to: workNode.id,
        kind: 'caused_by',
        evidenceRefs: [decisionRef],
        now,
      }),
    );
  }

  return upsertAoiRelations(params.sessionsDir, params.sessionPath, { nodes, edges, now });
}

export function recordAoiMissionStateRelations(params: {
  sessionsDir: string;
  sessionPath: string;
  mission: AoiMissionState;
  now?: number;
}): AoiRelationIndex {
  const now = params.now ?? Date.now();
  const missionRef = `mission:${params.sessionPath}`;
  const missionNode = makeAoiRelationNode({
    ref: missionRef,
    kind: 'mission',
    label: params.mission.focusSummary || 'Aoi mission focus',
    status:
      params.mission.status === 'completed' ||
      params.mission.status === 'blocked' ||
      params.mission.status === 'none'
        ? 'archived'
        : 'active',
    now,
  });
  const nodes = [missionNode];
  const edges: AoiRelationEdge[] = [];
  const sourceRefs = [
    params.mission.sourceRefs.goalRef,
    params.mission.sourceRefs.planStepRef,
    params.mission.sourceRefs.proposalRef,
    params.mission.sourceRefs.decisionRef,
    params.mission.sourceRefs.observationRef,
    params.mission.sourceRefs.researchRunRef,
    params.mission.sourceRefs.kiraWorkRef,
    params.mission.lastMeaningfulEventRef,
    ...params.mission.evidenceRefs,
  ].filter((ref): ref is string => Boolean(ref));

  for (const ref of [...new Set(sourceRefs)]) {
    const node = makeAoiRelationNode({ ref, now });
    nodes.push(node);
    edges.push(
      makeAoiRelationEdge({
        from: node.id,
        to: missionNode.id,
        kind: 'supports',
        evidenceRefs: [ref, missionRef],
        now,
      }),
      makeAoiRelationEdge({
        from: missionNode.id,
        to: node.id,
        kind: 'belongs_to',
        evidenceRefs: [missionRef, ref],
        now,
      }),
    );
  }

  return upsertAoiRelations(params.sessionsDir, params.sessionPath, { nodes, edges, now });
}

function refsForAoiPlaybookStep(step: AoiPlaybookStep): string[] {
  return [
    `playbook-step:${step.id}`,
    step.refs.proposalRef,
    step.refs.goalRef,
    step.refs.missionRef,
    step.refs.researchRunRef,
    step.refs.researchArtifactRef,
    step.refs.kiraWorkRef,
    step.refs.commandAuditRef,
    step.refs.timelineEventRef,
    ...step.evidenceRefs,
    ...step.sourceRefs,
  ].filter((ref): ref is string => Boolean(ref));
}

export function recordAoiPlaybookRelations(params: {
  sessionsDir: string;
  sessionPath: string;
  playbook: AoiPlaybook;
  now?: number;
}): AoiRelationIndex {
  const now = params.now ?? Date.now();
  const playbookRef = `playbook:${params.playbook.id}`;
  const playbookNode = makeAoiRelationNode({
    ref: playbookRef,
    kind: 'playbook',
    label: params.playbook.title,
    status:
      params.playbook.status === 'archived' || params.playbook.status === 'completed'
        ? 'archived'
        : 'active',
    now,
  });
  const nodes = [playbookNode];
  const edges: AoiRelationEdge[] = [];

  const sourceRefs = [
    ...params.playbook.sourceRefs,
    ...params.playbook.evidenceRefs,
    ...(params.playbook.goalId ? [`goal:${params.playbook.goalId}`] : []),
    ...(params.playbook.proposalId ? [`proposal:${params.playbook.proposalId}`] : []),
    params.playbook.missionRef,
    ...params.playbook.healthIssueRefs,
  ].filter((ref): ref is string => Boolean(ref));

  for (const ref of [...new Set(sourceRefs)]) {
    const node = makeAoiRelationNode({ ref, now });
    nodes.push(node);
    edges.push(
      makeAoiRelationEdge({
        from: node.id,
        to: playbookNode.id,
        kind: 'supports',
        evidenceRefs: [ref, playbookRef],
        now,
      }),
    );
  }

  for (const step of params.playbook.steps) {
    const stepRef = `playbook-step:${step.id}`;
    const stepNode = makeAoiRelationNode({
      ref: stepRef,
      kind: 'playbook_step',
      label: step.title,
      status:
        step.status === 'completed' || step.status === 'skipped'
          ? 'archived'
          : step.status === 'blocked'
            ? 'unknown'
            : 'active',
      now,
    });
    nodes.push(stepNode);
    edges.push(
      makeAoiRelationEdge({
        from: stepNode.id,
        to: playbookNode.id,
        kind: 'belongs_to',
        evidenceRefs: [stepRef, playbookRef],
        now,
      }),
      makeAoiRelationEdge({
        from: playbookNode.id,
        to: stepNode.id,
        kind: 'followed_by',
        evidenceRefs: [playbookRef, stepRef],
        now,
      }),
    );

    for (const ref of [...new Set(refsForAoiPlaybookStep(step))].filter((ref) => ref !== stepRef)) {
      const node = makeAoiRelationNode({ ref, now });
      nodes.push(node);
      edges.push(
        makeAoiRelationEdge({
          from: node.id,
          to: stepNode.id,
          kind: 'supports',
          evidenceRefs: [ref, stepRef],
          now,
        }),
      );
    }
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
    value === 'goal' ||
    value === 'mission' ||
    value === 'plan_step' ||
    value === 'playbook' ||
    value === 'playbook_step' ||
    value === 'project' ||
    value === 'kira_work' ||
    value === 'kira_attempt' ||
    value === 'kira_review' ||
    value === 'event' ||
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
