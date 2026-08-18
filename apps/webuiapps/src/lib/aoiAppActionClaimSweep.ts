// Offline sweep: find turns where Aoi told the user an app did something and
// nothing was actually dispatched.
//
// The runtime guard (aoiAppActionClaimContract) has two layers -- a declared
// performed_actions list, and a prose detector as backstop. The prose layer
// fails OPEN: a phrasing nobody anticipated passes silently, which is how every
// bug in this area started. Nothing at runtime can tell us what that layer is
// missing, because a miss looks exactly like a turn with nothing to report.
//
// This reads the run ledger after the fact and finds them. Ledger runs carry the
// user's message, the final reply, and every tool event, so a turn can be sorted
// into: it dispatched, the app tools were not even available, the pattern
// already covers it, the reply honestly said nothing happened, or nobody would
// have caught it. That last bucket is the one worth reading -- each entry is a
// phrasing to add to the detector.
//
// Judging is injectable and optional. The buckets alone are usually enough to
// eyeball, and a judge (any model, run offline where latency and cost do not
// touch the conversation) only has to sort the residue.

import {
  detectAoiAppActionClaim,
  detectAoiExplicitNonAction,
  resolveAoiAppActionClaimContract,
  type AoiAppActionClaimKind,
} from './aoiAppActionClaimContract';

// Structural subset of an aoiRunLedger run. Kept local and permissive so the
// sweep can read ledgers written by older builds.
export interface AoiClaimSweepLedgerEvent {
  type?: string;
  message?: string;
  toolNames?: string[];
}

export interface AoiClaimSweepLedgerRun {
  id?: string;
  createdAt?: number;
  goal?: { sourceMessage?: string; summary?: string };
  finalMessage?: string;
  includeAppTools?: boolean;
  exposedToolNames?: string[];
  events?: AoiClaimSweepLedgerEvent[];
}

export type AoiClaimSweepVerdict =
  // The turn never asked an app to do anything.
  | 'not_a_request'
  // An app_action ran, so whatever the reply says is backed.
  | 'dispatched'
  // Nothing ran and the app tools were not exposed for this turn -- the model
  // could not have dispatched even if it wanted to. A routing problem, not a
  // wording one.
  | 'app_tools_unavailable'
  // Nothing ran, and the prose detector recognizes the claim, so the runtime
  // guard would reject it today.
  | 'pattern_covers'
  // Nothing ran and the reply says so out loud. The outcome the contract wants,
  // and NOT a gap: it looks identical to one from the outside (no dispatch, no
  // recognized claim) and would otherwise pad the report with correct turns.
  | 'honest_no_action'
  // Nothing ran, the reply neither claimed nor disclaimed it. Needs a read.
  | 'pattern_gap';

export interface AoiClaimSweepFinding {
  runId: string;
  createdAt: number;
  verdict: AoiClaimSweepVerdict;
  kind: AoiAppActionClaimKind | null;
  userMessage: string;
  assistantMessage: string;
  // Set only when a judge ran on this finding.
  judgedAsClaim?: boolean;
  judgeNote?: string;
}

export interface AoiClaimSweepReport {
  scannedRuns: number;
  counts: Record<AoiClaimSweepVerdict, number>;
  // Everything that asked for an app action but did not get one, newest first.
  // pattern_gap entries are what the detector should learn from.
  findings: AoiClaimSweepFinding[];
}

/**
 * A judge sorts the residue the pattern missed: is this reply telling the user
 * the action happened? Any implementation works -- a model call, a human
 * reviewing a list. Runs offline, so it never costs the conversation anything.
 */
export type AoiClaimSweepJudge = (input: {
  userMessage: string;
  assistantMessage: string;
  kind: AoiAppActionClaimKind;
}) => Promise<{ claimed: boolean; note?: string }>;

// The pending-summary shape a dispatched app action is logged under
// ("youtube/OPEN_SEARCH", "os/OPEN_APP").
const APP_ACTION_SUMMARY_PATTERN = /^[\w.-]+\/[A-Z][A-Z0-9_]*$/;

// run_started lists the tools EXPOSED for the turn, not the ones called; reading
// it as evidence would mark every app-tool turn as dispatched.
const NON_EXECUTION_EVENT_TYPES: ReadonlySet<string> = new Set(['run_started']);

function dispatchedAppAction(run: AoiClaimSweepLedgerRun): boolean {
  return (run.events ?? []).some((event) => {
    if (NON_EXECUTION_EVENT_TYPES.has(event.type ?? '')) {
      return false;
    }
    return (event.toolNames ?? []).some(
      (name) => name === 'app_action' || APP_ACTION_SUMMARY_PATTERN.test(name),
    );
  });
}

function appToolsAvailable(run: AoiClaimSweepLedgerRun): boolean {
  if (run.includeAppTools === true) {
    return true;
  }
  if (run.includeAppTools === false) {
    return false;
  }
  // Older ledgers may not carry the flag; fall back to the exposed tool list.
  return (run.exposedToolNames ?? []).includes('app_action');
}

// The reply the user actually saw.
export function resolveSweepAssistantMessage(run: AoiClaimSweepLedgerRun): string {
  const explicit = run.finalMessage?.trim();
  if (explicit) {
    return explicit;
  }
  const spoken = [...(run.events ?? [])]
    .reverse()
    .find(
      (event) =>
        (event.type === 'assistant_delivered' ||
          event.type === 'plain_text_fallback' ||
          event.type === 'model_response') &&
        (event.message ?? '').trim().length > 0,
    );
  return spoken?.message?.trim() ?? '';
}

export function classifyAoiClaimSweepRun(run: AoiClaimSweepLedgerRun): AoiClaimSweepFinding {
  const userMessage = (run.goal?.sourceMessage ?? run.goal?.summary ?? '').trim();
  const assistantMessage = resolveSweepAssistantMessage(run);
  const contract = resolveAoiAppActionClaimContract({ latestUserMessage: userMessage });
  const base = {
    runId: run.id ?? '',
    createdAt: run.createdAt ?? 0,
    userMessage,
    assistantMessage,
  };

  if (!contract) {
    return { ...base, verdict: 'not_a_request', kind: null };
  }
  if (dispatchedAppAction(run)) {
    return { ...base, verdict: 'dispatched', kind: contract.kind };
  }
  if (!appToolsAvailable(run)) {
    return { ...base, verdict: 'app_tools_unavailable', kind: contract.kind };
  }
  if (detectAoiAppActionClaim(assistantMessage, contract.kind)) {
    return { ...base, verdict: 'pattern_covers', kind: contract.kind };
  }
  if (detectAoiExplicitNonAction(assistantMessage)) {
    return { ...base, verdict: 'honest_no_action', kind: contract.kind };
  }
  return { ...base, verdict: 'pattern_gap', kind: contract.kind };
}

function emptyCounts(): Record<AoiClaimSweepVerdict, number> {
  return {
    not_a_request: 0,
    dispatched: 0,
    app_tools_unavailable: 0,
    pattern_covers: 0,
    honest_no_action: 0,
    pattern_gap: 0,
  };
}

/**
 * Sweep a set of ledger runs.
 *
 * @param judge Optional. Applied to pattern_gap findings only -- the residue the
 * detector missed. A judge that says "not a claim" downgrades the finding to
 * not_a_request, so the report is not padded with turns where Aoi answered
 * honestly.
 */
export async function sweepAoiAppActionClaims(
  runs: readonly AoiClaimSweepLedgerRun[],
  options: { judge?: AoiClaimSweepJudge } = {},
): Promise<AoiClaimSweepReport> {
  const findings: AoiClaimSweepFinding[] = [];
  for (const run of runs) {
    const finding = classifyAoiClaimSweepRun(run);
    if (finding.verdict === 'pattern_gap' && options.judge && finding.kind) {
      try {
        const judged = await options.judge({
          userMessage: finding.userMessage,
          assistantMessage: finding.assistantMessage,
          kind: finding.kind,
        });
        finding.judgedAsClaim = judged.claimed;
        if (judged.note) {
          finding.judgeNote = judged.note;
        }
        if (!judged.claimed) {
          finding.verdict = 'not_a_request';
        }
      } catch {
        // A judge failure must not lose the finding: leave it in the gap bucket
        // unjudged so it still gets read.
      }
    }
    findings.push(finding);
  }

  const counts = emptyCounts();
  findings.forEach((finding) => {
    counts[finding.verdict] += 1;
  });

  return {
    scannedRuns: runs.length,
    counts,
    findings: findings
      .filter(
        (finding) =>
          finding.verdict !== 'not_a_request' &&
          finding.verdict !== 'dispatched' &&
          finding.verdict !== 'honest_no_action',
      )
      .sort((a, b) => b.createdAt - a.createdAt),
  };
}

function excerpt(value: string, limit = 140): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
}

export function formatAoiClaimSweepReport(report: AoiClaimSweepReport): string {
  const lines: string[] = [
    `Scanned ${report.scannedRuns} run(s).`,
    `  dispatched            ${report.counts.dispatched}  (an app action really ran)`,
    `  app_tools_unavailable ${report.counts.app_tools_unavailable}  (app tools were not exposed for the turn)`,
    `  pattern_covers        ${report.counts.pattern_covers}  (the runtime guard would reject this today)`,
    `  honest_no_action      ${report.counts.honest_no_action}  (nothing ran and Aoi said so)`,
    `  pattern_gap           ${report.counts.pattern_gap}  (nothing would have caught this)`,
    `  not_a_request         ${report.counts.not_a_request}`,
  ];
  if (report.findings.length === 0) {
    lines.push('', 'No unbacked app-action requests found.');
    return lines.join('\n');
  }
  lines.push('', 'Findings (newest first):');
  report.findings.forEach((finding) => {
    lines.push(
      '',
      `- [${finding.verdict}] ${finding.kind ?? '-'}  ${finding.runId}`,
      `    user: ${excerpt(finding.userMessage)}`,
      `    aoi : ${excerpt(finding.assistantMessage)}`,
    );
    if (finding.judgedAsClaim !== undefined) {
      lines.push(`    judge: ${finding.judgedAsClaim ? 'CLAIM' : 'not a claim'}`);
    }
    if (finding.judgeNote) {
      lines.push(`    note : ${excerpt(finding.judgeNote, 100)}`);
    }
  });
  if (report.counts.pattern_gap > 0) {
    lines.push(
      '',
      'Each pattern_gap reply is a phrasing the prose detector in',
      'aoiAppActionClaimContract does not recognize. Add its wording there.',
    );
  }
  return lines.join('\n');
}
