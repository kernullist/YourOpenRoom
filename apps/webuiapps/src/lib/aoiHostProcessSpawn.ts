// Aoi host-bridge process spawn (HP2a): let Aoi START a real process on the PC,
// but ONLY an executable the operator pre-registered on an allowlist, and only
// with a content-addressed approval (docs/aoi-host-access-design.md, decision
// 10-2: allowlist to start).
//
// Safety posture (load-bearing):
//   - ALLOWLIST ONLY: a spawn request names a registered entry id; free-form
//     executable paths are never spawnable. The registry is operator-managed
//     and machine-scoped (~/.openroom/host-bridge/), like the kill switch.
//   - shell:false + a validated ARGUMENT VECTOR (no shell metacharacters,
//     bounded count/length). There is no string command line, so there is no
//     shell-injection surface.
//   - Content-addressed approval: the exact { path, args } is fingerprinted via
//     the approval sandbox; the runner re-verifies the fingerprint at execution
//     time, so an approval for one command can never launch another.
//   - The HP0 gate (auth + kill switch capability `os_process_spawn` + approval)
//     is enforced by the CALLER before the runner runs; the runner re-checks the
//     approval fingerprint as defense in depth and audits every attempt.
//   - Spawn is recorded (pid + image) so a later kill capability can reclaim an
//     Aoi-spawned process; that audit is the ownership record.
//
// This module implements spawn ONLY. Process termination (kill) is deferred to
// the very last roadmap step per the operator's instruction.
//
// Server-only (fs / child_process). The allowlist helpers and policy evaluation
// are PURE and unit-tested; the runner is exercised with an injected spawn.
import * as fs from 'fs';
import { spawn } from 'child_process';
import { dirname, isAbsolute, resolve } from 'path';
import { randomUUID } from 'crypto';
import {
  compareAoiApprovalSandboxPreviews,
  createAoiApprovalSandboxPreview,
  normalizeAoiApprovalSandboxPreview,
  type AoiApprovalSandboxPreview,
} from './aoiApprovalSandbox';

export const AOI_HOST_SPAWN_CAPABILITY = 'os_process_spawn';
export const AOI_HOST_SPAWN_APPROVAL_TTL_MS = 5 * 60 * 1000;
// The spawn capability is irreversible for gate purposes: it starts a real
// process. It is recoverable only by killing the spawned pid afterwards.
export const AOI_HOST_SPAWN_IRREVERSIBLE = true;

const HOST_BRIDGE_DIR = 'host-bridge';
const SPAWN_ALLOWLIST_FILE = 'spawn-allowlist.json';
const MAX_ALLOWLIST_ENTRIES = 64;
const MAX_ARGS = 24;
const MAX_ARG_CHARS = 512;
const MAX_PATH_CHARS = 1024;
const SHELL_METACHAR_REGEX = /[|&;<>`\r\n$]/;
const ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type AoiHostSpawnBlockReason =
  | 'missing_allowlist_id'
  | 'unknown_allowlist_entry'
  | 'too_many_arguments'
  | 'argument_too_long'
  | 'shell_metacharacters'
  | 'empty_argument'
  | 'approval_missing'
  | 'approval_expired'
  | 'approval_fingerprint_changed'
  | 'approval_preview_changed'
  | 'rate_limited'
  | 'spawn_failed';

export interface AoiHostSpawnAllowlistEntry {
  id: string;
  label: string;
  // Absolute executable path. Validated on add and again at spawn time.
  path: string;
  // Fixed arguments always passed. When present, request args are appended
  // after these; when the entry pins the full arg vector, requests pass none.
  fixedArgs?: string[];
}

export interface AoiHostSpawnAllowlist {
  version: 1;
  entries: AoiHostSpawnAllowlistEntry[];
  updatedAt: number;
}

export const DEFAULT_AOI_HOST_SPAWN_ALLOWLIST: AoiHostSpawnAllowlist = {
  version: 1,
  entries: [],
  updatedAt: 0,
};

export interface AoiHostSpawnRequest {
  allowlistId: string;
  args?: string[];
  purpose?: string;
  requestedAt: number;
  evidenceRefs?: string[];
}

export interface AoiHostSpawnPolicy {
  version: 1;
  allowed: boolean;
  blockReasons: AoiHostSpawnBlockReason[];
  allowlistId: string;
  label: string;
  program: string;
  args: string[];
  purpose: string;
  requiredAutonomyLevel: 'L5';
  approvalFingerprint: string;
  approvalSandbox: AoiApprovalSandboxPreview;
  expiresAt: number;
}

export interface AoiHostSpawnAuditRecord {
  version: 1;
  id: string;
  allowlistId: string;
  program: string;
  argsSummary: string;
  purpose: string;
  allowed: boolean;
  blockReasons: AoiHostSpawnBlockReason[];
  startedAt: number;
  spawnedPid: number | null;
  approvalFingerprint: string;
  evidenceRefs: string[];
}

export interface AoiHostSpawnResult {
  version: 1;
  ok: boolean;
  allowlistId: string;
  program: string;
  spawnedPid: number | null;
  blockReasons: AoiHostSpawnBlockReason[];
  auditRecord: AoiHostSpawnAuditRecord;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isSafeArg(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ARG_CHARS && !SHELL_METACHAR_REGEX.test(value);
}

function isSafeExecutablePath(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_CHARS &&
    isAbsolute(value) &&
    !SHELL_METACHAR_REGEX.test(value) &&
    !value.includes('..')
  );
}

// --- Allowlist (pure + fs) ---------------------------------------------------

export function normalizeAoiHostSpawnAllowlist(raw: unknown): AoiHostSpawnAllowlist {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_AOI_HOST_SPAWN_ALLOWLIST, entries: [] };
  }
  const value = raw as Partial<AoiHostSpawnAllowlist>;
  if (value.version !== 1 || !Array.isArray(value.entries)) {
    return { ...DEFAULT_AOI_HOST_SPAWN_ALLOWLIST, entries: [] };
  }
  const entries: AoiHostSpawnAllowlistEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of value.entries) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const entry = candidate as Partial<AoiHostSpawnAllowlistEntry>;
    const id = typeof entry.id === 'string' ? entry.id : '';
    const path = typeof entry.path === 'string' ? entry.path : '';
    if (!ENTRY_ID_PATTERN.test(id) || seen.has(id) || !isSafeExecutablePath(path)) {
      continue;
    }
    const fixedArgs = Array.isArray(entry.fixedArgs)
      ? entry.fixedArgs.filter((arg): arg is string => typeof arg === 'string' && isSafeArg(arg))
      : undefined;
    entries.push({
      id,
      label:
        normalizeWhitespace(typeof entry.label === 'string' ? entry.label : id).slice(0, 80) || id,
      path,
      ...(fixedArgs && fixedArgs.length > 0 ? { fixedArgs: fixedArgs.slice(0, MAX_ARGS) } : {}),
    });
    seen.add(id);
    if (entries.length >= MAX_ALLOWLIST_ENTRIES) {
      break;
    }
  }
  return {
    version: 1,
    entries,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

export function addAoiHostSpawnAllowlistEntry(
  allowlist: AoiHostSpawnAllowlist | null | undefined,
  entry: { id: string; label?: string; path: string; fixedArgs?: string[] },
  now: number,
): { allowlist: AoiHostSpawnAllowlist; added: boolean; reason?: string } {
  const base = normalizeAoiHostSpawnAllowlist(allowlist);
  if (!ENTRY_ID_PATTERN.test(entry.id)) {
    return { allowlist: base, added: false, reason: 'invalid_id' };
  }
  if (!isSafeExecutablePath(entry.path)) {
    return { allowlist: base, added: false, reason: 'invalid_path' };
  }
  if (
    base.entries.every((existing) => existing.id !== entry.id) &&
    base.entries.length >= MAX_ALLOWLIST_ENTRIES
  ) {
    return { allowlist: base, added: false, reason: 'allowlist_full' };
  }
  const fixedArgs = (entry.fixedArgs ?? []).filter(isSafeArg).slice(0, MAX_ARGS);
  const nextEntry: AoiHostSpawnAllowlistEntry = {
    id: entry.id,
    label: normalizeWhitespace(entry.label ?? entry.id).slice(0, 80) || entry.id,
    path: entry.path,
    ...(fixedArgs.length > 0 ? { fixedArgs } : {}),
  };
  const entries = [...base.entries.filter((existing) => existing.id !== entry.id), nextEntry];
  return { allowlist: { version: 1, entries, updatedAt: now }, added: true };
}

export function removeAoiHostSpawnAllowlistEntry(
  allowlist: AoiHostSpawnAllowlist | null | undefined,
  id: string,
  now: number,
): AoiHostSpawnAllowlist {
  const base = normalizeAoiHostSpawnAllowlist(allowlist);
  const entries = base.entries.filter((entry) => entry.id !== id);
  return {
    version: 1,
    entries,
    updatedAt: entries.length === base.entries.length ? base.updatedAt : now,
  };
}

export function findAoiHostSpawnAllowlistEntry(
  allowlist: AoiHostSpawnAllowlist | null | undefined,
  id: string,
): AoiHostSpawnAllowlistEntry | null {
  return normalizeAoiHostSpawnAllowlist(allowlist).entries.find((entry) => entry.id === id) ?? null;
}

export function resolveAoiHostSpawnAllowlistPath(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, SPAWN_ALLOWLIST_FILE);
}

export function loadAoiHostSpawnAllowlist(openroomHome: string): AoiHostSpawnAllowlist {
  try {
    const filePath = resolveAoiHostSpawnAllowlistPath(openroomHome);
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_AOI_HOST_SPAWN_ALLOWLIST, entries: [] };
    }
    return normalizeAoiHostSpawnAllowlist(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    return { ...DEFAULT_AOI_HOST_SPAWN_ALLOWLIST, entries: [] };
  }
}

export function saveAoiHostSpawnAllowlist(
  openroomHome: string,
  allowlist: AoiHostSpawnAllowlist,
): AoiHostSpawnAllowlist {
  const normalized = normalizeAoiHostSpawnAllowlist(allowlist);
  const filePath = resolveAoiHostSpawnAllowlistPath(openroomHome);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return normalized;
}

// --- Rate limit (pure) -------------------------------------------------------

// Bound spawn frequency so a runaway loop cannot fork-bomb the machine. Pure:
// the caller keeps the recent-timestamps list and passes it in.
export function isAoiHostSpawnRateLimited(
  recentSpawnAtMs: readonly number[],
  now: number,
  options: { maxPerWindow?: number; windowMs?: number } = {},
): boolean {
  const maxPerWindow = options.maxPerWindow ?? 5;
  const windowMs = options.windowMs ?? 60_000;
  const withinWindow = recentSpawnAtMs.filter((at) => now - at < windowMs).length;
  return withinWindow >= maxPerWindow;
}

// --- Policy evaluation (pure) ------------------------------------------------

function resolveSpawnArgs(
  entry: AoiHostSpawnAllowlistEntry,
  requestArgs: string[] | undefined,
): { args: string[]; reasons: AoiHostSpawnBlockReason[] } {
  const reasons: AoiHostSpawnBlockReason[] = [];
  const requested = Array.isArray(requestArgs) ? requestArgs : [];
  for (const arg of requested) {
    if (typeof arg !== 'string' || arg.length === 0) {
      reasons.push('empty_argument');
      continue;
    }
    if (arg.length > MAX_ARG_CHARS) {
      reasons.push('argument_too_long');
    }
    if (SHELL_METACHAR_REGEX.test(arg)) {
      reasons.push('shell_metacharacters');
    }
  }
  const args = [...(entry.fixedArgs ?? []), ...requested];
  if (args.length > MAX_ARGS) {
    reasons.push('too_many_arguments');
  }
  return { args, reasons: [...new Set(reasons)] };
}

export function evaluateAoiHostSpawnPolicy(params: {
  request: AoiHostSpawnRequest;
  allowlist: AoiHostSpawnAllowlist | null | undefined;
  // Accepted for call-site symmetry with the runner; the approval expiry is
  // anchored to request.requestedAt (like the approved-command policy), not now.
  now?: number;
}): AoiHostSpawnPolicy {
  const { request } = params;
  const purpose =
    normalizeWhitespace(request.purpose ?? '').slice(0, 180) || 'Launch an allowlisted process.';
  const evidenceRefs = [...new Set(request.evidenceRefs ?? [])].slice(0, 16);
  const allowlistId = typeof request.allowlistId === 'string' ? request.allowlistId : '';
  const reasons: AoiHostSpawnBlockReason[] = [];
  const entry = findAoiHostSpawnAllowlistEntry(params.allowlist, allowlistId);
  if (!allowlistId) {
    reasons.push('missing_allowlist_id');
  } else if (!entry) {
    reasons.push('unknown_allowlist_entry');
  }
  const resolved = entry
    ? resolveSpawnArgs(entry, request.args)
    : { args: [], reasons: [] as AoiHostSpawnBlockReason[] };
  reasons.push(...resolved.reasons);

  const program = entry?.path ?? '';
  const args = resolved.args;
  const label = entry?.label ?? (allowlistId || 'unknown');
  const argsSummary = args.join(' ').slice(0, 240);
  const approvalSandbox = createAoiApprovalSandboxPreview({
    targetKind: 'command',
    targetId: `host-spawn:${allowlistId}`,
    intendedMutation: `Spawn allowlisted process "${label}".`,
    dryRunSummary: `Would spawn "${program}" ${argsSummary} (allowlist entry ${allowlistId}) with shell disabled.`,
    requiredAuthorityDecisionId: `host-spawn:${allowlistId}`,
    // Spawning starts a real process -> a mutation recoverable only by killing
    // the spawned pid.
    expectedMutationCount: 1,
    recoveryPlan: {
      kind: 'manual_recovery',
      available: true,
      summary: 'Terminate the spawned process to reclaim it (recorded pid in the spawn audit).',
      evidenceRefs,
    },
    rollback: {
      required: true,
      note: 'No automatic rollback: a spawned process is stopped by terminating its pid.',
      evidenceRefs,
    },
    postActionValidation: {
      kind: 'check',
      label: 'Record the spawned pid and image in the host spawn audit.',
      check: 'Spawn audit receipt is recorded after execution.',
      evidenceRefs,
    },
    command: `${program} ${argsSummary}`.trim(),
    evidenceRefs,
  });
  const blockReasons = [...new Set(reasons)];
  return {
    version: 1,
    allowed: blockReasons.length === 0,
    blockReasons,
    allowlistId,
    label,
    program,
    args,
    purpose,
    requiredAutonomyLevel: 'L5',
    approvalFingerprint: approvalSandbox.approvalFingerprint,
    approvalSandbox,
    expiresAt: request.requestedAt + AOI_HOST_SPAWN_APPROVAL_TTL_MS,
  };
}

// Compare an approved sandbox preview against the freshly evaluated one. Returns
// the block reasons (empty when the approval still matches and is unexpired).
export function compareAoiHostSpawnApproval(params: {
  approved: AoiApprovalSandboxPreview | null | undefined;
  current: AoiHostSpawnPolicy;
  approvedExpiresAt: number | null | undefined;
  now: number;
}): AoiHostSpawnBlockReason[] {
  if (!params.approved) {
    return ['approval_missing'];
  }
  if (typeof params.approvedExpiresAt === 'number' && params.approvedExpiresAt < params.now) {
    return ['approval_expired'];
  }
  const sandboxReasons = compareAoiApprovalSandboxPreviews({
    approved: params.approved,
    current: params.current.approvalSandbox,
  });
  if (sandboxReasons.length === 0) {
    return [];
  }
  // Map the sandbox diff onto the spawn reason vocabulary.
  return sandboxReasons.includes('approval_fingerprint_changed')
    ? ['approval_fingerprint_changed']
    : ['approval_preview_changed'];
}

// --- Runner (effectful) ------------------------------------------------------

function makeSpawnAuditId(allowlistId: string, startedAt: number): string {
  return `aoi-host-spawn-${startedAt.toString(36)}-${randomUUID().slice(0, 8)}-${allowlistId}`;
}

export interface RunAoiHostSpawnOptions {
  request: AoiHostSpawnRequest;
  allowlist: AoiHostSpawnAllowlist | null | undefined;
  // The operator-approved sandbox preview + its expiry (from the approval
  // decision). The runner re-verifies it against the freshly evaluated policy.
  approvedSandbox: AoiApprovalSandboxPreview | null | undefined;
  approvedExpiresAt?: number | null;
  now?: number;
  spawnImpl?: typeof spawn;
}

function blockedSpawnResult(
  policy: AoiHostSpawnPolicy,
  blockReasons: AoiHostSpawnBlockReason[],
  startedAt: number,
): AoiHostSpawnResult {
  const auditRecord: AoiHostSpawnAuditRecord = {
    version: 1,
    id: makeSpawnAuditId(policy.allowlistId || 'unknown', startedAt),
    allowlistId: policy.allowlistId,
    program: policy.program,
    argsSummary: policy.args.join(' ').slice(0, 240),
    purpose: policy.purpose,
    allowed: false,
    blockReasons: [...new Set(blockReasons)],
    startedAt,
    spawnedPid: null,
    approvalFingerprint: policy.approvalFingerprint,
    evidenceRefs: policy.approvalSandbox.evidenceRefs,
  };
  return {
    version: 1,
    ok: false,
    allowlistId: policy.allowlistId,
    program: policy.program,
    spawnedPid: null,
    blockReasons: auditRecord.blockReasons,
    auditRecord,
  };
}

// Spawn an allowlisted process, detached, after re-verifying the approval
// fingerprint. Never runs a shell; the argument vector is fixed by the policy.
// The caller MUST have already passed the HP0 gate (auth + kill switch +
// approval); this re-check is defense in depth.
export function runAoiHostSpawn(options: RunAoiHostSpawnOptions): AoiHostSpawnResult {
  const startedAt = options.now ?? Date.now();
  const policy = evaluateAoiHostSpawnPolicy({
    request: options.request,
    allowlist: options.allowlist,
    now: startedAt,
  });
  const approvalReasons = compareAoiHostSpawnApproval({
    approved: normalizeAoiApprovalSandboxPreview(options.approvedSandbox),
    current: policy,
    approvedExpiresAt: options.approvedExpiresAt,
    now: startedAt,
  });
  const blockReasons = [...policy.blockReasons, ...approvalReasons];
  if (blockReasons.length > 0 || !policy.program) {
    return blockedSpawnResult(policy, blockReasons, startedAt);
  }

  const spawnImpl = options.spawnImpl ?? spawn;
  try {
    const child = spawnImpl(policy.program, policy.args, {
      shell: false,
      windowsHide: false,
      detached: true,
      stdio: 'ignore',
    });
    const spawnedPid = typeof child.pid === 'number' ? child.pid : null;
    // Detach so the launched process outlives this daemon request.
    child.unref?.();
    if (spawnedPid === null) {
      return blockedSpawnResult(policy, ['spawn_failed'], startedAt);
    }
    const auditRecord: AoiHostSpawnAuditRecord = {
      version: 1,
      id: makeSpawnAuditId(policy.allowlistId, startedAt),
      allowlistId: policy.allowlistId,
      program: policy.program,
      argsSummary: policy.args.join(' ').slice(0, 240),
      purpose: policy.purpose,
      allowed: true,
      blockReasons: [],
      startedAt,
      spawnedPid,
      approvalFingerprint: policy.approvalFingerprint,
      evidenceRefs: policy.approvalSandbox.evidenceRefs,
    };
    return {
      version: 1,
      ok: true,
      allowlistId: policy.allowlistId,
      program: policy.program,
      spawnedPid,
      blockReasons: [],
      auditRecord,
    };
  } catch {
    return blockedSpawnResult(policy, ['spawn_failed'], startedAt);
  }
}
