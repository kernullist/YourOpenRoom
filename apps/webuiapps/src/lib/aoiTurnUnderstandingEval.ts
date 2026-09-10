// Scores a turn-understanding predictor against the labelled corpus.
//
// The predictor is any function from a corpus case to a reading -- the regex
// router (offline, deterministic, the baseline), the live classifier (one model
// call per case), or a combination. The report is the same for all of them, so a
// router change or a model swap produces a number that can be compared to the
// last one instead of a feeling.

import type { ChatMessage } from './llmClient';
import { shouldUseDialogModel } from './chatTokenControl';
import {
  createAoiTurnRecord,
  type AoiCapabilityFamily,
  type AoiTurnKind,
  type AoiTurnRecord,
} from './aoiTurnRecord';
import { inferAoiTurnUnderstandingFromRegex } from './aoiTurnUnderstanding';
import type {
  AoiTurnCorpusCase,
  AoiTurnCorpusTurn,
} from './__fixtures__/aoiTurnUnderstandingCorpus';

export interface AoiTurnEvalPrediction {
  kind: AoiTurnKind;
  families: AoiCapabilityFamily[];
  route: 'dialog' | 'main';
  // Relative position (1 = previous turn) or null.
  refersToTurn: number | null;
  latencyMs?: number;
  source: 'classifier' | 'regex' | 'none';
}

export interface AoiTurnEvalFailure {
  id: string;
  text: string;
  expected: {
    kind: AoiTurnKind;
    families: AoiCapabilityFamily[];
    route: 'dialog' | 'main';
    refersToTurn: number | null;
  };
  predicted: AoiTurnEvalPrediction;
  wrong: Array<'route' | 'kind' | 'families' | 'reference'>;
}

export interface AoiTurnEvalBucket {
  total: number;
  routeCorrect: number;
  kindCorrect: number;
  familiesCorrect: number;
}

export interface AoiTurnEvalReport {
  version: 1;
  total: number;
  routeAccuracy: number;
  kindAccuracy: number;
  familiesAccuracy: number;
  referenceCases: number;
  referenceCorrect: number;
  // Turns the gold labels dialog that the predictor sent to main: cost, not a miss.
  overRoutedToMain: number;
  // Turns the gold labels main that the predictor kept on dialog: a real miss.
  underRoutedToDialog: number;
  byKind: Record<string, AoiTurnEvalBucket>;
  byTag: Record<string, AoiTurnEvalBucket>;
  meanLatencyMs: number | null;
  failures: AoiTurnEvalFailure[];
}

const CORPUS_TURN_SPACING_MS = 60_000;

/**
 * The turns a case depends on, as the records the runtime would have kept. The
 * tool records are taken as given (they describe what ran), everything else is
 * derived the same way the live path derives it.
 */
export function corpusTurnsToRecords(
  turns: readonly AoiTurnCorpusTurn[] = [],
  now = 1_700_000_000_000,
): AoiTurnRecord[] {
  return turns.map((turn, index) => {
    const messages: ChatMessage[] = [];
    if (turn.tools && turn.tools.length > 0) {
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: turn.tools.map((tool, toolIndex) => ({
          id: `corpus-${index}-${toolIndex}`,
          type: 'function' as const,
          function: { name: tool.name, arguments: JSON.stringify(argsFromSummary(tool.args)) },
        })),
      });
      turn.tools.forEach((tool, toolIndex) => {
        messages.push({
          role: 'tool',
          tool_call_id: `corpus-${index}-${toolIndex}`,
          content:
            tool.outcome === 'error' ? 'error: corpus failure' : tool.outcome === 'ok' ? 'ok' : '',
        });
      });
    }
    const record = createAoiTurnRecord({
      id: `corpus-turn-${index + 1}`,
      turnIndex: index + 1,
      userMessage: turn.user,
      assistantMessage: turn.assistant,
      route: turn.route ?? 'main',
      routeReason: 'corpus',
      kind: 'unknown',
      families: [],
      messages,
      suggestedReplies: turn.offers ?? [],
      outcome: turn.outcome ?? 'delivered',
      openQuestion: turn.openQuestion ?? null,
      createdAt: now - (turns.length - index) * CORPUS_TURN_SPACING_MS,
    });
    // The corpus states tool outcomes directly; keep them verbatim rather than
    // re-deriving from the synthetic result strings.
    return turn.tools ? { ...record, tools: turn.tools.map((tool) => ({ ...tool })) } : record;
  });
}

function argsFromSummary(summary: string): Record<string, string> {
  const args: Record<string, string> = {};
  for (const part of summary.split(', ')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      args[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  return args;
}

export function corpusTurnsToHistory(turns: readonly AoiTurnCorpusTurn[] = []): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (const turn of turns) {
    history.push({ role: 'user', content: turn.user });
    history.push({ role: 'assistant', content: turn.assistant });
  }
  return history;
}

/** The offline baseline: the regex router exactly as the live turn uses it. */
export function predictAoiTurnWithRegex(testCase: AoiTurnCorpusCase): AoiTurnEvalPrediction {
  const history = corpusTurnsToHistory(testCase.turns);
  const reading = inferAoiTurnUnderstandingFromRegex(testCase.text, history);
  return {
    kind: reading.kind,
    families: reading.families,
    route: shouldUseDialogModel(testCase.text, history) ? 'dialog' : 'main',
    refersToTurn: null,
    source: 'regex',
  };
}

function sameFamilies(
  left: readonly AoiCapabilityFamily[],
  right: readonly AoiCapabilityFamily[],
): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function emptyBucket(): AoiTurnEvalBucket {
  return { total: 0, routeCorrect: 0, kindCorrect: 0, familiesCorrect: 0 };
}

function bump(
  buckets: Record<string, AoiTurnEvalBucket>,
  key: string,
  routeOk: boolean,
  kindOk: boolean,
  familiesOk: boolean,
): void {
  const bucket = buckets[key] ?? emptyBucket();
  bucket.total += 1;
  if (routeOk) {
    bucket.routeCorrect += 1;
  }
  if (kindOk) {
    bucket.kindCorrect += 1;
  }
  if (familiesOk) {
    bucket.familiesCorrect += 1;
  }
  buckets[key] = bucket;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 1000;
}

export async function evaluateAoiTurnUnderstanding(
  cases: readonly AoiTurnCorpusCase[],
  predict: (testCase: AoiTurnCorpusCase) => AoiTurnEvalPrediction | Promise<AoiTurnEvalPrediction>,
): Promise<AoiTurnEvalReport> {
  let routeCorrect = 0;
  let kindCorrect = 0;
  let familiesCorrect = 0;
  let referenceCases = 0;
  let referenceCorrect = 0;
  let overRoutedToMain = 0;
  let underRoutedToDialog = 0;
  const byKind: Record<string, AoiTurnEvalBucket> = {};
  const byTag: Record<string, AoiTurnEvalBucket> = {};
  const failures: AoiTurnEvalFailure[] = [];
  const latencies: number[] = [];

  for (const testCase of cases) {
    const predicted = await predict(testCase);
    const expectedReference = testCase.gold.refersToTurn ?? null;
    const routeOk = predicted.route === testCase.gold.route;
    const kindOk = predicted.kind === testCase.gold.kind;
    const familiesOk = sameFamilies(predicted.families, testCase.gold.families);
    const referenceOk = expectedReference === null || predicted.refersToTurn === expectedReference;
    if (routeOk) {
      routeCorrect += 1;
    } else if (predicted.route === 'main') {
      overRoutedToMain += 1;
    } else {
      underRoutedToDialog += 1;
    }
    if (kindOk) {
      kindCorrect += 1;
    }
    if (familiesOk) {
      familiesCorrect += 1;
    }
    if (expectedReference !== null) {
      referenceCases += 1;
      if (referenceOk) {
        referenceCorrect += 1;
      }
    }
    if (typeof predicted.latencyMs === 'number') {
      latencies.push(predicted.latencyMs);
    }
    bump(byKind, testCase.gold.kind, routeOk, kindOk, familiesOk);
    for (const tag of testCase.tags) {
      bump(byTag, tag, routeOk, kindOk, familiesOk);
    }
    const wrong: AoiTurnEvalFailure['wrong'] = [];
    if (!routeOk) {
      wrong.push('route');
    }
    if (!kindOk) {
      wrong.push('kind');
    }
    if (!familiesOk) {
      wrong.push('families');
    }
    if (!referenceOk) {
      wrong.push('reference');
    }
    if (wrong.length > 0) {
      failures.push({
        id: testCase.id,
        text: testCase.text,
        expected: {
          kind: testCase.gold.kind,
          families: testCase.gold.families,
          route: testCase.gold.route,
          refersToTurn: expectedReference,
        },
        predicted,
        wrong,
      });
    }
  }

  return {
    version: 1,
    total: cases.length,
    routeAccuracy: ratio(routeCorrect, cases.length),
    kindAccuracy: ratio(kindCorrect, cases.length),
    familiesAccuracy: ratio(familiesCorrect, cases.length),
    referenceCases,
    referenceCorrect,
    overRoutedToMain,
    underRoutedToDialog,
    byKind,
    byTag,
    meanLatencyMs:
      latencies.length > 0
        ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
        : null,
    failures,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatAoiTurnEvalReport(
  report: AoiTurnEvalReport,
  label = 'turn understanding',
): string {
  const lines: string[] = [];
  lines.push(`[${label}] ${report.total} cases`);
  lines.push(
    `  route ${pct(report.routeAccuracy)} (over-routed to main ${report.overRoutedToMain}, under-routed to dialog ${report.underRoutedToDialog})`,
  );
  lines.push(`  kind ${pct(report.kindAccuracy)}  families ${pct(report.familiesAccuracy)}`);
  if (report.referenceCases > 0) {
    lines.push(`  references ${report.referenceCorrect}/${report.referenceCases}`);
  }
  if (report.meanLatencyMs !== null) {
    lines.push(`  mean latency ${report.meanLatencyMs} ms`);
  }
  lines.push('  by kind:');
  for (const [kind, bucket] of Object.entries(report.byKind).sort()) {
    lines.push(
      `    ${kind.padEnd(24)} n=${String(bucket.total).padStart(3)} route ${pct(ratio(bucket.routeCorrect, bucket.total)).padStart(6)} kind ${pct(ratio(bucket.kindCorrect, bucket.total)).padStart(6)} families ${pct(ratio(bucket.familiesCorrect, bucket.total)).padStart(6)}`,
    );
  }
  if (report.failures.length > 0) {
    lines.push(`  failures (${report.failures.length}):`);
    for (const failure of report.failures) {
      lines.push(
        `    ${failure.id}: ${JSON.stringify(failure.text)} expected ${failure.expected.kind}/${failure.expected.families.join('+')}/${failure.expected.route}${failure.expected.refersToTurn ? `/T-${failure.expected.refersToTurn}` : ''} got ${failure.predicted.kind}/${failure.predicted.families.join('+')}/${failure.predicted.route}${failure.predicted.refersToTurn ? `/T-${failure.predicted.refersToTurn}` : ''} [${failure.wrong.join(',')}]`,
      );
    }
  }
  return lines.join('\n');
}
