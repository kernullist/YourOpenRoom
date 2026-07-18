// Aoi host-bridge process termination (kill) -- the LAST, most dangerous
// capability, deferred to the final roadmap step per the operator's instruction
// (docs/aoi-host-access-design.md). Killing a process is IRREVERSIBLE.
//
// Safety posture (load-bearing; this is the crown-jewel guard):
//   - PROTECTED PROCESSES CAN NEVER BE KILLED, even if allowlisted:
//       * OS-critical images (csrss, wininit, services, lsass, smss, winlogon,
//         System, Registry, svchost, ...) -- killing these can bugcheck the box.
//       * The IRONMACE Tavern anti-cheat processes (Tavern.exe / TavernWorker.exe
//         / TavernMaster host). Any attempt is refused; the bridge NEVER tries to
//         bypass anti-cheat protection (that attempt is itself a cheat surface).
//       * The daemon itself and its parent/children (self-protection).
//   - ALLOWLIST TO KILL (decision 10-2): a target is killable only when it is a
//     process Aoi itself spawned (tracked by the spawn audit) OR its image is on
//     the operator's kill allowlist. Everything else is refused.
//   - TOCTOU GUARD: a kill request pins { pid, expectedImageName,
//     expectedStartTime }. At execution the process is re-read by pid and the
//     image (+ start time when provided) must still match; a mismatch means the
//     pid was reused and the kill is aborted.
//   - Content-addressed approval (irreversible): the exact target is
//     fingerprinted; the runner re-verifies it. No automatic recovery -- a killed
//     process is gone.
//   - The HP0 gate (auth + kill switch capability `os_process_kill` + approval)
//     is enforced by the caller; this re-checks as defense in depth and audits.
//
// Server-only (child_process). The protected-list + policy + TOCTOU checks are
// PURE and exhaustively unit-tested; the runner is exercised with injected
// process-read and kill implementations.
import {
  compareAoiApprovalSandboxPreviews,
  createAoiApprovalSandboxPreview,
  normalizeAoiApprovalSandboxPreview,
  type AoiApprovalSandboxPreview,
} from './aoiApprovalSandbox';

export const AOI_HOST_KILL_CAPABILITY = 'os_process_kill';
export const AOI_HOST_KILL_APPROVAL_TTL_MS = 5 * 60 * 1000;
export const AOI_HOST_KILL_IRREVERSIBLE = true;

// Image names (lowercased) that must NEVER be terminated. OS-critical + the
// Tavern anti-cheat processes + a few graphics/session-critical images.
export const AOI_HOST_PROTECTED_IMAGE_NAMES: ReadonlySet<string> = new Set([
  'system',
  'system idle process',
  'registry',
  'smss.exe',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'lsass.exe',
  'lsaiso.exe',
  'svchost.exe',
  'fontdrvhost.exe',
  'dwm.exe',
  'memory compression',
  // IRONMACE Tavern anti-cheat -- refused by policy (and PPL-protected by the OS).
  'tavern.exe',
  'tavernworker.exe',
  'tavernmaster.exe',
]);

export type AoiHostKillBlockReason =
  | 'invalid_pid'
  | 'missing_image_name'
  | 'protected_process'
  | 'protected_pid'
  | 'not_killable'
  | 'toctou_mismatch'
  | 'process_not_found'
  | 'approval_missing'
  | 'approval_expired'
  | 'approval_fingerprint_changed'
  | 'approval_preview_changed'
  | 'kill_failed';

export interface AoiHostKillRequest {
  pid: number;
  expectedImageName: string;
  // Process creation time (ms epoch or a stable string). When present it is part
  // of the TOCTOU identity so a reused pid with the same image is still rejected.
  expectedStartTime?: number | string;
  purpose?: string;
  requestedAt: number;
  evidenceRefs?: string[];
}

export interface AoiHostKillPolicyContext {
  // The daemon's own pid + parent + children -- never killable (self-protection).
  protectedPids?: readonly number[];
  // Image names the operator registered as killable (lowercased on compare).
  killAllowlistImages?: readonly string[];
  // Pids Aoi itself spawned (from the spawn audit) -- implicitly killable.
  aoiSpawnedPids?: readonly number[];
}

export interface AoiHostKillPolicy {
  version: 1;
  allowed: boolean;
  blockReasons: AoiHostKillBlockReason[];
  pid: number;
  imageName: string;
  purpose: string;
  requiredAutonomyLevel: 'L5';
  approvalFingerprint: string;
  approvalSandbox: AoiApprovalSandboxPreview;
  expiresAt: number;
}

export interface AoiHostKillAuditRecord {
  version: 1;
  id: string;
  pid: number;
  imageName: string;
  purpose: string;
  allowed: boolean;
  blockReasons: AoiHostKillBlockReason[];
  startedAt: number;
  killed: boolean;
  approvalFingerprint: string;
  evidenceRefs: string[];
}

export interface AoiHostKillResult {
  version: 1;
  ok: boolean;
  pid: number;
  killed: boolean;
  blockReasons: AoiHostKillBlockReason[];
  auditRecord: AoiHostKillAuditRecord;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function isAoiHostProtectedImage(imageName: string): boolean {
  return AOI_HOST_PROTECTED_IMAGE_NAMES.has(normalizeWhitespace(imageName).toLowerCase());
}

// --- Policy (pure) -----------------------------------------------------------

export function evaluateAoiHostKillPolicy(params: {
  request: AoiHostKillRequest;
  context?: AoiHostKillPolicyContext;
  now?: number;
}): AoiHostKillPolicy {
  const request = params.request;
  const context = params.context ?? {};
  const imageName = normalizeWhitespace(
    typeof request.expectedImageName === 'string' ? request.expectedImageName : '',
  ).slice(0, 128);
  const purpose =
    normalizeWhitespace(request.purpose ?? '').slice(0, 180) || 'Terminate a process.';
  const evidenceRefs = [...new Set(request.evidenceRefs ?? [])].slice(0, 16);
  const pid = typeof request.pid === 'number' && Number.isInteger(request.pid) ? request.pid : -1;
  const reasons: AoiHostKillBlockReason[] = [];

  if (pid <= 0) {
    reasons.push('invalid_pid');
  }
  if (!imageName) {
    reasons.push('missing_image_name');
  }
  const protectedPids = new Set(context.protectedPids ?? []);
  if (pid > 0 && protectedPids.has(pid)) {
    reasons.push('protected_pid');
  }
  if (imageName && isAoiHostProtectedImage(imageName)) {
    reasons.push('protected_process');
  }
  // Killable only when Aoi spawned it OR the image is on the kill allowlist.
  const spawnedPids = new Set(context.aoiSpawnedPids ?? []);
  const killAllowlist = new Set(
    (context.killAllowlistImages ?? []).map((name) => normalizeWhitespace(name).toLowerCase()),
  );
  const isKillable =
    (pid > 0 && spawnedPids.has(pid)) || (imageName && killAllowlist.has(imageName.toLowerCase()));
  if (!isKillable) {
    reasons.push('not_killable');
  }

  const approvalSandbox = createAoiApprovalSandboxPreview({
    targetKind: 'command',
    targetId: `host-kill:${pid}:${imageName}`,
    intendedMutation: `Terminate process ${imageName} (pid ${pid}).`,
    dryRunSummary: `Would terminate pid ${pid} (${imageName}); this is irreversible.`,
    requiredAuthorityDecisionId: `host-kill:${pid}:${imageName}:${request.expectedStartTime ?? ''}`,
    expectedMutationCount: 1,
    recoveryPlan: {
      kind: 'not_applicable',
      available: false,
      summary: 'Terminating a process is irreversible; there is no recovery.',
      evidenceRefs,
    },
    rollback: {
      required: true,
      note: 'No rollback: a terminated process cannot be restored to its prior state.',
      evidenceRefs,
    },
    postActionValidation: {
      kind: 'check',
      label: 'Record the terminated pid and image in the kill audit.',
      check: 'Kill audit receipt is recorded after execution.',
      evidenceRefs,
    },
    command: `kill ${pid} ${imageName} start=${request.expectedStartTime ?? ''}`,
    evidenceRefs,
  });
  const blockReasons = [...new Set(reasons)];
  return {
    version: 1,
    allowed: blockReasons.length === 0,
    blockReasons,
    pid,
    imageName,
    purpose,
    requiredAutonomyLevel: 'L5',
    approvalFingerprint: approvalSandbox.approvalFingerprint,
    approvalSandbox,
    expiresAt: request.requestedAt + AOI_HOST_KILL_APPROVAL_TTL_MS,
  };
}

export function compareAoiHostKillApproval(params: {
  approved: AoiApprovalSandboxPreview | null | undefined;
  current: AoiHostKillPolicy;
  approvedExpiresAt: number | null | undefined;
  now: number;
}): AoiHostKillBlockReason[] {
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
  return sandboxReasons.includes('approval_fingerprint_changed')
    ? ['approval_fingerprint_changed']
    : ['approval_preview_changed'];
}

// --- TOCTOU re-verification (pure) -------------------------------------------

export interface AoiHostLiveProcess {
  imageName: string;
  startTime?: number | string;
}

// The live process (re-read by pid at execution time) must still be the SAME
// process the request pinned: same image, and same start time when the request
// provided one. A mismatch means the pid was recycled.
export function verifyAoiHostKillTarget(
  request: AoiHostKillRequest,
  live: AoiHostLiveProcess | null,
): { ok: boolean; reason?: AoiHostKillBlockReason } {
  if (!live) {
    return { ok: false, reason: 'process_not_found' };
  }
  const expectedImage = normalizeWhitespace(request.expectedImageName).toLowerCase();
  const liveImage = normalizeWhitespace(live.imageName).toLowerCase();
  if (!liveImage || liveImage !== expectedImage) {
    return { ok: false, reason: 'toctou_mismatch' };
  }
  if (
    request.expectedStartTime !== undefined &&
    live.startTime !== undefined &&
    String(request.expectedStartTime) !== String(live.startTime)
  ) {
    return { ok: false, reason: 'toctou_mismatch' };
  }
  return { ok: true };
}

// --- Runner (effectful, injected implementations) ----------------------------

export type AoiHostReadProcessImpl = (pid: number) => AoiHostLiveProcess | null;
export type AoiHostKillImpl = (pid: number) => boolean;

function makeKillAuditId(pid: number, startedAt: number): string {
  return `aoi-host-kill-${startedAt.toString(36)}-${pid}`;
}

function blockedKillResult(
  policy: AoiHostKillPolicy,
  blockReasons: AoiHostKillBlockReason[],
  startedAt: number,
): AoiHostKillResult {
  const auditRecord: AoiHostKillAuditRecord = {
    version: 1,
    id: makeKillAuditId(policy.pid, startedAt),
    pid: policy.pid,
    imageName: policy.imageName,
    purpose: policy.purpose,
    allowed: false,
    blockReasons: [...new Set(blockReasons)],
    startedAt,
    killed: false,
    approvalFingerprint: policy.approvalFingerprint,
    evidenceRefs: policy.approvalSandbox.evidenceRefs,
  };
  return {
    version: 1,
    ok: false,
    pid: policy.pid,
    killed: false,
    blockReasons: auditRecord.blockReasons,
    auditRecord,
  };
}

export interface RunAoiHostKillOptions {
  request: AoiHostKillRequest;
  context?: AoiHostKillPolicyContext;
  approvedSandbox: AoiApprovalSandboxPreview | null | undefined;
  approvedExpiresAt?: number | null;
  now?: number;
  readProcessImpl: AoiHostReadProcessImpl;
  killImpl: AoiHostKillImpl;
}

// Terminate a process after: policy pass, approval re-verify, and a TOCTOU
// re-read confirming the pid still hosts the pinned image (+ start time). The
// caller must already have passed the HP0 gate.
export function runAoiHostKill(options: RunAoiHostKillOptions): AoiHostKillResult {
  const startedAt = options.now ?? Date.now();
  const policy = evaluateAoiHostKillPolicy({
    request: options.request,
    ...(options.context ? { context: options.context } : {}),
    now: startedAt,
  });
  const approvalReasons = compareAoiHostKillApproval({
    approved: normalizeAoiApprovalSandboxPreview(options.approvedSandbox),
    current: policy,
    approvedExpiresAt: options.approvedExpiresAt,
    now: startedAt,
  });
  const blockReasons = [...policy.blockReasons, ...approvalReasons];
  if (blockReasons.length > 0) {
    return blockedKillResult(policy, blockReasons, startedAt);
  }

  // TOCTOU: re-read the live process and confirm identity before killing.
  const live = options.readProcessImpl(policy.pid);
  const verify = verifyAoiHostKillTarget(options.request, live);
  if (!verify.ok) {
    return blockedKillResult(policy, [verify.reason ?? 'toctou_mismatch'], startedAt);
  }
  // Belt-and-suspenders: the LIVE image must also not be protected (a reused pid
  // that now hosts a protected image is already caught above, but re-check).
  if (live && isAoiHostProtectedImage(live.imageName)) {
    return blockedKillResult(policy, ['protected_process'], startedAt);
  }

  let killed = false;
  try {
    killed = options.killImpl(policy.pid) === true;
  } catch {
    killed = false;
  }
  if (!killed) {
    return blockedKillResult(policy, ['kill_failed'], startedAt);
  }
  const auditRecord: AoiHostKillAuditRecord = {
    version: 1,
    id: makeKillAuditId(policy.pid, startedAt),
    pid: policy.pid,
    imageName: policy.imageName,
    purpose: policy.purpose,
    allowed: true,
    blockReasons: [],
    startedAt,
    killed: true,
    approvalFingerprint: policy.approvalFingerprint,
    evidenceRefs: policy.approvalSandbox.evidenceRefs,
  };
  return {
    version: 1,
    ok: true,
    pid: policy.pid,
    killed: true,
    blockReasons: [],
    auditRecord,
  };
}
