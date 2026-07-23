// Aoi host-bridge approval store (wiring slice 3): the server-side binding that
// makes a mutate approval REAL instead of a self-approve.
//
// Why it exists: it makes a mutate approval an explicit, recorded, single-use,
// time-bounded step BOUND to the content-addressed (sha256) fingerprint, sitting
// between preview and execute:
//
//   1. POST /<cap>/preview   -> server records a PENDING approval (fingerprint,
//                               capability, target, expiresAt, approved=false).
//   2. approve                -> POST /approvals/approve marks it approved=true.
//   3. POST /<cap>/execute    -> the runner is reached ONLY when the store has a
//                               matching approved, unexpired, unconsumed entry;
//                               execution CONSUMES it (single-use).
//
// A consumed or expired entry cannot execute again -- so an approval is one-shot
// and time-bounded, and echoing a preview never runs anything.
//
// POSTURE (do not overstate -- keep code and comments honest): /approvals/approve
// uses the SAME daemon token as execute, so this store does NOT by itself prove
// the approve came from a human rather than the executor. A token holder -- or,
// on the dev loopback-trust mount, any local process -- can walk preview ->
// approve -> execute. What actually stops the AI executor from self-approving
// today is that its TOOL SURFACE exposes only the operation routes (process /
// file / browser), NOT /approvals/approve or /killswitch set, plus the token
// requirement in production. A separate human-origin approval credential is the
// remaining hardening for a strict human-in-the-loop guarantee.
//
// Machine-scoped under ~/.openroom/host-bridge/approvals.json. Server-only (fs).
// The pure state helpers are exported for unit testing without the filesystem.
import * as fs from 'fs';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';

export const AOI_HOST_BRIDGE_APPROVAL_VERSION = 1 as const;
const HOST_BRIDGE_DIR = 'host-bridge';
const APPROVALS_FILE = 'approvals.json';
const MAX_APPROVALS = 64;
const FINGERPRINT_PATTERN = /^[a-f0-9]{4,64}$/i;

export type AoiHostBridgeApprovalState = 'pending' | 'approved' | 'consumed';

export interface AoiHostBridgeApproval {
  version: 1;
  id: string;
  capability: string;
  // The content-addressed fingerprint from the approval sandbox preview -- the
  // identity execute must match.
  approvalFingerprint: string;
  // A short human-facing summary of what is being approved (for the operator UI).
  targetSummary: string;
  state: AoiHostBridgeApprovalState;
  createdAt: number;
  approvedAt?: number;
  consumedAt?: number;
  expiresAt: number;
}

export interface AoiHostBridgeApprovalStoreData {
  version: 1;
  approvals: AoiHostBridgeApproval[];
  updatedAt: number;
}

export const DEFAULT_AOI_HOST_BRIDGE_APPROVAL_STORE: AoiHostBridgeApprovalStoreData = {
  version: 1,
  approvals: [],
  updatedAt: 0,
};

function normalizeApproval(raw: unknown): AoiHostBridgeApproval | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Partial<AoiHostBridgeApproval>;
  if (
    value.version !== 1 ||
    typeof value.id !== 'string' ||
    typeof value.capability !== 'string' ||
    typeof value.approvalFingerprint !== 'string' ||
    !FINGERPRINT_PATTERN.test(value.approvalFingerprint) ||
    typeof value.createdAt !== 'number' ||
    typeof value.expiresAt !== 'number' ||
    (value.state !== 'pending' && value.state !== 'approved' && value.state !== 'consumed')
  ) {
    return null;
  }
  return {
    version: 1,
    id: value.id,
    capability: value.capability.slice(0, 64),
    approvalFingerprint: value.approvalFingerprint,
    targetSummary: typeof value.targetSummary === 'string' ? value.targetSummary.slice(0, 240) : '',
    state: value.state,
    createdAt: value.createdAt,
    ...(typeof value.approvedAt === 'number' ? { approvedAt: value.approvedAt } : {}),
    ...(typeof value.consumedAt === 'number' ? { consumedAt: value.consumedAt } : {}),
    expiresAt: value.expiresAt,
  };
}

export function normalizeAoiHostBridgeApprovalStore(raw: unknown): AoiHostBridgeApprovalStoreData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_AOI_HOST_BRIDGE_APPROVAL_STORE, approvals: [] };
  }
  const value = raw as Partial<AoiHostBridgeApprovalStoreData>;
  if (value.version !== 1 || !Array.isArray(value.approvals)) {
    return { ...DEFAULT_AOI_HOST_BRIDGE_APPROVAL_STORE, approvals: [] };
  }
  const approvals: AoiHostBridgeApproval[] = [];
  for (const candidate of value.approvals) {
    const normalized = normalizeApproval(candidate);
    if (normalized) {
      approvals.push(normalized);
    }
    if (approvals.length >= MAX_APPROVALS) {
      break;
    }
  }
  return {
    version: 1,
    approvals,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

// Drop expired and consumed entries and cap the store. Keeps the store bounded
// and prevents an expired/consumed approval from ever being reconsidered.
export function pruneAoiHostBridgeApprovals(
  store: AoiHostBridgeApprovalStoreData,
  now: number,
): AoiHostBridgeApprovalStoreData {
  const approvals = store.approvals
    .filter((approval) => approval.state !== 'consumed' && approval.expiresAt > now)
    .slice(-MAX_APPROVALS);
  return { version: 1, approvals, updatedAt: store.updatedAt };
}

// Record a fresh PENDING approval for a preview. Any prior pending/approved
// entry for the SAME fingerprint is replaced (a re-preview supersedes it).
export function recordAoiHostBridgePendingApproval(
  store: AoiHostBridgeApprovalStoreData | null | undefined,
  params: {
    capability: string;
    approvalFingerprint: string;
    targetSummary: string;
    expiresAt: number;
    now: number;
  },
): { store: AoiHostBridgeApprovalStoreData; approval: AoiHostBridgeApproval } {
  const base = pruneAoiHostBridgeApprovals(normalizeAoiHostBridgeApprovalStore(store), params.now);
  const approval: AoiHostBridgeApproval = {
    version: 1,
    id: `aoi-host-approval-${params.now.toString(36)}-${randomUUID().slice(0, 8)}`,
    capability: params.capability.slice(0, 64),
    approvalFingerprint: params.approvalFingerprint,
    targetSummary: params.targetSummary.slice(0, 240),
    state: 'pending',
    createdAt: params.now,
    expiresAt: params.expiresAt,
  };
  const approvals = [
    ...base.approvals.filter(
      (existing) => existing.approvalFingerprint !== params.approvalFingerprint,
    ),
    approval,
  ].slice(-MAX_APPROVALS);
  return { store: { version: 1, approvals, updatedAt: params.now }, approval };
}

// The operator approves a pending entry by fingerprint. Returns the updated
// store and whether an entry was found + moved to 'approved'.
export function approveAoiHostBridgeApproval(
  store: AoiHostBridgeApprovalStoreData | null | undefined,
  approvalFingerprint: string,
  now: number,
): { store: AoiHostBridgeApprovalStoreData; approved: boolean } {
  const base = pruneAoiHostBridgeApprovals(normalizeAoiHostBridgeApprovalStore(store), now);
  let approved = false;
  const approvals = base.approvals.map((entry) => {
    if (
      entry.approvalFingerprint === approvalFingerprint &&
      entry.state === 'pending' &&
      entry.expiresAt > now
    ) {
      approved = true;
      return { ...entry, state: 'approved' as const, approvedAt: now };
    }
    return entry;
  });
  return { store: { version: 1, approvals, updatedAt: now }, approved };
}

// Consume an APPROVED, unexpired entry for the fingerprint (single-use). Returns
// ok only when such an entry existed; the entry is flipped to 'consumed' so it
// can never execute twice. This is the gate execute calls.
export function consumeAoiHostBridgeApproval(
  store: AoiHostBridgeApprovalStoreData | null | undefined,
  params: { capability: string; approvalFingerprint: string; now: number },
): { store: AoiHostBridgeApprovalStoreData; ok: boolean; reason?: string } {
  const base = pruneAoiHostBridgeApprovals(normalizeAoiHostBridgeApprovalStore(store), params.now);
  const match = base.approvals.find(
    (entry) =>
      entry.approvalFingerprint === params.approvalFingerprint &&
      entry.capability === params.capability &&
      entry.state === 'approved' &&
      entry.expiresAt > params.now,
  );
  if (!match) {
    // Distinguish "there is a pending entry but it is not approved" from "nothing".
    const pending = base.approvals.find(
      (entry) =>
        entry.approvalFingerprint === params.approvalFingerprint && entry.state === 'pending',
    );
    return {
      store: base,
      ok: false,
      reason: pending ? 'approval_not_granted' : 'approval_missing',
    };
  }
  const approvals = base.approvals.map((entry) =>
    entry.id === match.id
      ? { ...entry, state: 'consumed' as const, consumedAt: params.now }
      : entry,
  );
  return { store: { version: 1, approvals, updatedAt: params.now }, ok: true };
}

// --- Persistence -------------------------------------------------------------

export function resolveAoiHostBridgeApprovalStorePath(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, APPROVALS_FILE);
}

export function loadAoiHostBridgeApprovalStore(
  openroomHome: string,
): AoiHostBridgeApprovalStoreData {
  try {
    const filePath = resolveAoiHostBridgeApprovalStorePath(openroomHome);
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_AOI_HOST_BRIDGE_APPROVAL_STORE, approvals: [] };
    }
    return normalizeAoiHostBridgeApprovalStore(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    return { ...DEFAULT_AOI_HOST_BRIDGE_APPROVAL_STORE, approvals: [] };
  }
}

export function saveAoiHostBridgeApprovalStore(
  openroomHome: string,
  store: AoiHostBridgeApprovalStoreData,
): AoiHostBridgeApprovalStoreData {
  const normalized = normalizeAoiHostBridgeApprovalStore(store);
  const filePath = resolveAoiHostBridgeApprovalStorePath(openroomHome);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return normalized;
}
