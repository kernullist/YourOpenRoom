import * as fs from 'fs';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { isAbsolute, relative, resolve } from 'path';
import {
  evaluateAoiApprovedCommandPolicy,
  normalizeAoiApprovedCommandCwd,
} from './aoiApprovedCommandPolicy';
import { redactAoiSensitiveContent } from './aoiMemoryShared';
import type {
  AoiApprovedCommandRequest,
  AoiApprovedCommandResult,
  AoiCommandAuditRecord,
  AoiCommandBlockReason,
} from './aoiAutonomyTypes';

const MAX_OUTPUT_CHARS = 6000;

export interface AoiApprovedCommandRunnerOptions {
  workspaceRoot: string;
  now?: number;
  spawnImpl?: typeof spawn;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function makeAuditId(request: AoiApprovedCommandRequest, startedAt: number): string {
  return `aoi-command-${startedAt.toString(36)}-${hashText(
    `${request.sessionPath}:${request.proposalId ?? ''}:${request.command}:${startedAt}`,
  )}`;
}

function truncateOutput(value: string): {
  excerpt: string;
  truncated: boolean;
} {
  const redacted = redactAoiSensitiveContent(value);
  if (redacted.length <= MAX_OUTPUT_CHARS) {
    return {
      excerpt: redacted,
      truncated: false,
    };
  }
  return {
    excerpt: `${redacted.slice(0, MAX_OUTPUT_CHARS - 3).trimEnd()}...`,
    truncated: true,
  };
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function resolveApprovedCwd(params: { workspaceRoot: string; cwd: string }):
  | {
      ok: true;
      cwd: string;
    }
  | {
      ok: false;
      reason: AoiCommandBlockReason;
    } {
  const workspaceRoot = resolve(params.workspaceRoot);
  const relativeCwd = normalizeAoiApprovedCommandCwd(params.cwd);
  const cwd = relativeCwd === '.' ? workspaceRoot : resolve(workspaceRoot, relativeCwd);
  if (!isPathInsideRoot(workspaceRoot, cwd)) {
    return {
      ok: false,
      reason: 'cwd_escapes_workspace',
    };
  }
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return {
      ok: false,
      reason: 'workspace_cwd_missing',
    };
  }
  return {
    ok: true,
    cwd,
  };
}

function createAuditRecord(params: {
  request: AoiApprovedCommandRequest;
  allowed: boolean;
  blockReasons: AoiCommandBlockReason[];
  startedAt: number;
  completedAt: number;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  approvalFingerprint: string;
  cwdLabel: string;
  cwdHash: string;
}): AoiCommandAuditRecord {
  const stdout = truncateOutput(params.stdout);
  const stderr = truncateOutput(params.stderr);
  return {
    version: 1,
    id: makeAuditId(params.request, params.startedAt),
    sessionPath: params.request.sessionPath,
    ...(params.request.proposalId ? { proposalId: params.request.proposalId } : {}),
    ...(params.request.decisionId ? { decisionId: params.request.decisionId } : {}),
    command: params.request.command,
    cwdLabel: params.cwdLabel,
    cwdHash: params.cwdHash,
    purpose: params.request.purpose,
    risk: params.request.risk,
    allowed: params.allowed,
    blockReasons: [...new Set(params.blockReasons)],
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    durationMs: Math.max(0, params.completedAt - params.startedAt),
    exitCode: params.exitCode,
    timedOut: params.timedOut,
    stdoutExcerpt: stdout.excerpt,
    stderrExcerpt: stderr.excerpt,
    stdoutTruncated: stdout.truncated || params.stdoutTruncated === true,
    stderrTruncated: stderr.truncated || params.stderrTruncated === true,
    evidenceRefs: [
      ...new Set([
        `aoi-command-audit:${makeAuditId(params.request, params.startedAt)}`,
        ...(params.request.proposalId ? [`proposal:${params.request.proposalId}`] : []),
        ...(params.request.decisionId ? [`decision:${params.request.decisionId}`] : []),
        ...params.request.evidenceRefs,
      ]),
    ].slice(0, 24),
    approvalFingerprint: params.approvalFingerprint,
  };
}

function resultFromAudit(auditRecord: AoiCommandAuditRecord): AoiApprovedCommandResult {
  return {
    version: 1,
    ok: auditRecord.allowed && !auditRecord.timedOut && auditRecord.exitCode === 0,
    command: auditRecord.command,
    cwdLabel: auditRecord.cwdLabel,
    exitCode: auditRecord.exitCode,
    timedOut: auditRecord.timedOut,
    durationMs: auditRecord.durationMs,
    stdoutExcerpt: auditRecord.stdoutExcerpt,
    stderrExcerpt: auditRecord.stderrExcerpt,
    stdoutTruncated: auditRecord.stdoutTruncated,
    stderrTruncated: auditRecord.stderrTruncated,
    auditRecord,
    evidenceRefs: auditRecord.evidenceRefs,
  };
}

export function runAoiApprovedCommand(
  request: AoiApprovedCommandRequest,
  options: AoiApprovedCommandRunnerOptions,
): Promise<AoiApprovedCommandResult> {
  const startedAt = options.now ?? Date.now();
  const policy = evaluateAoiApprovedCommandPolicy(request);
  const cwdResult = policy.allowed
    ? resolveApprovedCwd({
        workspaceRoot: options.workspaceRoot,
        cwd: policy.cwd,
      })
    : null;
  const blockReasons = [
    ...policy.blockReasons,
    ...(cwdResult && !cwdResult.ok ? [cwdResult.reason] : []),
  ];
  if (!policy.allowed || (cwdResult && !cwdResult.ok) || !policy.program) {
    const completedAt = startedAt;
    return Promise.resolve(
      resultFromAudit(
        createAuditRecord({
          request,
          allowed: false,
          blockReasons,
          startedAt,
          completedAt,
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          approvalFingerprint: policy.approvalFingerprint,
          cwdLabel: policy.cwdLabel,
          cwdHash: policy.cwdHash,
        }),
      ),
    );
  }

  return new Promise((resolveResult) => {
    const spawnImpl = options.spawnImpl ?? spawn;
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let finished = false;
    let timedOut = false;
    const child = spawnImpl(policy.program, policy.args, {
      cwd: cwdResult.cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
      shell: false,
      windowsHide: true,
    });

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const next = truncateOutput(`${stdout}${chunk.toString()}`);
      stdout = next.excerpt;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const next = truncateOutput(`${stderr}${chunk.toString()}`);
      stderr = next.excerpt;
      stderrTruncated = stderrTruncated || next.truncated;
    });

    const finish = (exitCode: number | null, extraReasons: AoiCommandBlockReason[] = []) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      const completedAt = Date.now();
      resolveResult(
        resultFromAudit(
          createAuditRecord({
            request,
            allowed: extraReasons.length <= 0,
            blockReasons: extraReasons,
            startedAt,
            completedAt,
            exitCode,
            timedOut,
            stdout,
            stderr,
            stdoutTruncated,
            stderrTruncated,
            approvalFingerprint: policy.approvalFingerprint,
            cwdLabel: policy.cwdLabel,
            cwdHash: policy.cwdHash,
          }),
        ),
      );
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish(null, ['execution_timeout']);
    }, policy.timeoutMs);

    child.on('error', (error) => {
      const next = truncateOutput(
        `${stderr}\n${error instanceof Error ? error.message : String(error)}`,
      );
      stderr = next.excerpt;
      stderrTruncated = stderrTruncated || next.truncated;
      finish(null, ['execution_failed']);
    });
    child.on('close', (code) => {
      finish(code ?? null);
    });
  });
}
