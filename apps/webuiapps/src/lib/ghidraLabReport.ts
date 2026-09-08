// Ghidra Lab report writer: turn an evidence ledger into a report a human can
// act on, and refuse to let the model add anything the ledger does not support.
//
// The pipeline is deliberately the same shape as aoiResearchEngine's, because the
// problem is the same and it was solved there: draft -> verify -> one bounded
// rewrite, over an evidence ledger the model did not author.
//
// What is different, and what this file is really about, is ANCHOR ENFORCEMENT.
// Every factual line in the report has to cite at least one ledger anchor by id.
// A line citing nothing, or citing an id that does not exist, is DELETED -- not
// softened, not hedged -- and the count of deletions is printed in the report.
// A silent drop is how a report starts lying by omission, so the number is part
// of the deliverable.
//
// There is always a report. `buildDeterministicReport` produces a real, useful
// document from the ledger alone, and it is both the fallback when the model is
// unavailable and the floor the model has to beat.
//
// Server-adjacent but node-free: the LLM call is injected, so this whole file is
// testable and could be imported anywhere.
import {
  GHIDRA_INTERESTING_STRING_BUCKETS,
  type GhidraAntiAnalysisIndicator,
  type GhidraCapabilitySignal,
  type GhidraStringSummary,
} from './ghidraLabHeuristics';
import { looksLikeMermaid, type GhidraCapaMatch } from './ghidraLabSweep';
import {
  callgraphAnchorId,
  capaAnchorId,
  functionAnchorId,
  importAnchorId,
  indicatorAnchorId,
  stringAnchorId,
  type GhidraEvidenceAnchor,
  type GhidraSweepLedger,
} from './ghidraLabTypes';

const MAX_LEDGER_CHARS = 40000;
const MAX_REPORT_CHARS = 60000;
const REPORT_TOKENS = 6000;
const VERIFIER_TOKENS = 1500;

/** Sections whose prose is allowed to stand without a citation. */
const CITATION_EXEMPT_HEADINGS: readonly string[] = [
  'open questions',
  'evidence ledger',
  'coverage',
  'what was not examined',
];

const ANCHOR_KINDS: readonly string[] = [
  'header',
  'section',
  'import',
  'export',
  'string',
  'function',
  'xref',
  'capa',
  'callgraph',
  'indicator',
];

/** `[import:kernel32.dll!OpenProcess]` but not a markdown link `[text](url)`. */
const CITATION_REGEX = /\[([^\]\n]+)\](?!\()/g;

function looksLikeAnchorId(value: string): boolean {
  const colon = value.indexOf(':');
  if (colon <= 0) {
    return false;
  }
  return ANCHOR_KINDS.includes(value.slice(0, colon));
}

export interface AnchorEnforcementResult {
  report: string;
  /** Lines deleted for citing nothing, or nothing real. */
  droppedClaims: number;
  /** Ids the model cited that are not in the ledger. */
  unknownAnchors: string[];
  /** Ids the surviving report actually cites. */
  citedAnchors: string[];
}

/**
 * Delete every factual line the ledger does not support.
 *
 * Line-based rather than sentence-based on purpose: markdown structure (headings,
 * tables, code fences, list nesting) survives a line filter and does not survive
 * a sentence splitter. Headings, table rows, code blocks and blank lines pass
 * untouched; ordinary prose and list items must cite.
 */
export function enforceReportAnchors(
  report: string,
  knownIds: ReadonlySet<string>,
): AnchorEnforcementResult {
  const lines = report.split(/\r?\n/);
  const kept: string[] = [];
  const unknown = new Set<string>();
  const cited = new Set<string>();
  let dropped = 0;
  let inFence = false;
  let exempt = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^(?:```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (inFence) {
      kept.push(line);
      continue;
    }

    if (trimmed.startsWith('#')) {
      const heading = trimmed.replace(/^#+\s*/, '').toLowerCase();
      exempt = CITATION_EXEMPT_HEADINGS.some((name) => heading.includes(name));
      kept.push(line);
      continue;
    }

    // Structure and non-prose pass through: tables carry their evidence in the
    // cells, and a blank line is not a claim.
    if (
      !trimmed ||
      trimmed.startsWith('|') ||
      trimmed.startsWith('>') ||
      /^[-*_]{3,}$/.test(trimmed)
    ) {
      kept.push(line);
      continue;
    }
    if (exempt) {
      kept.push(line);
      continue;
    }

    const matches = [...trimmed.matchAll(CITATION_REGEX)]
      .map((match) => match[1].trim())
      .filter(looksLikeAnchorId);
    if (matches.length === 0) {
      dropped += 1;
      continue;
    }
    const real = matches.filter((id) => knownIds.has(id));
    for (const id of matches) {
      if (!knownIds.has(id)) {
        unknown.add(id);
      }
    }
    if (real.length === 0) {
      dropped += 1;
      continue;
    }
    for (const id of real) {
      cited.add(id);
    }
    // Strip citations that turned out to be invented, leaving the real ones.
    const cleaned =
      unknown.size === 0
        ? line
        : line.replace(CITATION_REGEX, (whole, id: string) => {
            const trimmedId = id.trim();
            if (looksLikeAnchorId(trimmedId) && !knownIds.has(trimmedId)) {
              return '';
            }
            return whole;
          });
    kept.push(cleaned.replace(/\s{2,}/g, ' ').trimEnd());
  }

  return {
    report: kept
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    droppedClaims: dropped,
    unknownAnchors: [...unknown].sort(),
    citedAnchors: [...cited].sort(),
  };
}

export function buildAnchorIndex(ledger: GhidraSweepLedger): Map<string, GhidraEvidenceAnchor> {
  const index = new Map<string, GhidraEvidenceAnchor>();
  for (const anchor of ledger.anchors) {
    if (!index.has(anchor.id)) {
      index.set(anchor.id, anchor);
    }
  }
  return index;
}

/** The ledger, rendered for a prompt. Bounded, and deterministic facts first. */
export function buildLedgerText(ledger: GhidraSweepLedger): string {
  const lines: string[] = [];
  const ordered = [...ledger.anchors].sort((left, right) => {
    if (left.deterministic !== right.deterministic) {
      return left.deterministic ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
  });
  for (const anchor of ordered) {
    const marker = anchor.deterministic ? '' : ' (model-inferred)';
    const where = anchor.address ? ` @${anchor.address}` : '';
    lines.push(`[${anchor.id}]${where}${marker} ${anchor.detail}`);
    if (lines.join('\n').length > MAX_LEDGER_CHARS) {
      lines.push(`...[ledger truncated at ${MAX_LEDGER_CHARS} chars]`);
      break;
    }
  }
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A complete report built from the ledger alone.
 *
 * This is not a stub. With no model at all it still answers the operator's
 * question -- what is this binary, what can it do, what is worth looking at --
 * because every one of those comes from a deterministic stage. The model's job
 * is to add explanation on top, and if it cannot, this is what ships.
 */
export function buildDeterministicReport(ledger: GhidraSweepLedger): string {
  const facts = ledger.facts as Record<string, unknown>;
  const capabilities = (facts.importCapabilities as GhidraCapabilitySignal[] | undefined) ?? [];
  const capa = (facts.capa as GhidraCapaMatch[] | undefined) ?? [];
  const strings = (facts.stringSummary as GhidraStringSummary[] | undefined) ?? [];
  const anti = (facts.antiAnalysis as GhidraAntiAnalysisIndicator[] | undefined) ?? [];
  const deepRead =
    (facts.deepRead as { name: string; address: string; summary: string }[] | undefined) ?? [];
  const selected =
    (facts.selectedFunctions as
      | { name: string; address: string; reasons: string[] }[]
      | undefined) ?? [];

  // Structure is expressed as headings, tables and blockquotes; CLAIMS are
  // expressed as cited lines. That split is not cosmetic: enforceReportAnchors
  // deletes any uncited prose line, so a label written as a sentence would be
  // deleted out of THIS report exactly as it would be out of the model's. The
  // deterministic report has to survive its own enforcement pass, or it is not
  // a usable fallback.
  const lines: string[] = [];
  lines.push(`# ${ledger.binaryName} -- Binary Analysis Report`);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Path | \`${ledger.binaryPath}\` |`);
  lines.push(`| SHA-256 | \`${ledger.sha256}\` |`);
  lines.push(`| Size | ${formatBytes(ledger.sizeBytes)} |`);
  lines.push(`| Functions found | ${String(facts.functionCount ?? 'unknown')} |`);
  lines.push('');

  lines.push('## Capability summary');
  lines.push('');
  if (capa.length > 0) {
    lines.push('#### From capa rules');
    lines.push('');
    for (const match of capa.slice(0, 40)) {
      const mapping = [...match.attack, ...match.mbc].filter(Boolean).join('; ');
      lines.push(`- ${match.rule}${mapping ? ` (${mapping})` : ''} [${capaAnchorId(match.rule)}]`);
    }
    lines.push('');
  }
  if (capabilities.length > 0) {
    lines.push('#### From the import table');
    lines.push('');
    for (const signal of capabilities) {
      const citations = signal.symbols
        .slice(0, 4)
        .map((symbol) => `[${importAnchorId(symbol)}]`)
        .join(' ');
      lines.push(`- **${signal.category}** -- ${signal.claim}. ${citations}`);
    }
    lines.push('');
  }
  if (capa.length === 0 && capabilities.length === 0) {
    lines.push('> No capability signals were derived. The import table was empty or unreadable.');
    lines.push('');
  }

  if (typeof facts.callgraph === 'string' && facts.callgraph) {
    const root = String(facts.callgraphRoot ?? '');
    const graph = String(facts.callgraph).slice(0, 8000);
    lines.push('## Architecture and entry flow');
    lines.push('');
    lines.push(`Call graph rooted at \`${root}\`. [${callgraphAnchorId(root)}]`);
    lines.push('');
    // Only fence it as mermaid when it IS mermaid. A JSON envelope inside a
    // mermaid fence renders as nothing at all, which is worse than showing the
    // raw answer.
    lines.push(looksLikeMermaid(graph) ? '```mermaid' : '```');
    lines.push(graph);
    lines.push('```');
    lines.push('');
  }

  lines.push('## Notable functions');
  lines.push('');
  if (selected.length === 0) {
    lines.push('> No functions scored high enough to be read in depth.');
    lines.push('');
  } else {
    lines.push('| Function | Address | Selected because | Summary | Evidence |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const entry of selected.slice(0, 40)) {
      const body = deepRead.find(
        (candidate) => candidate.address === entry.address || candidate.name === entry.name,
      );
      const label = entry.name || entry.address || '(unnamed)';
      // A summary containing a pipe or a newline would break the table row it
      // sits in, and the model writes these.
      const summary = body?.summary
        ? body.summary.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
        : '--';
      lines.push(
        `| \`${label}\` | \`${entry.address || 'unknown'}\` | ${entry.reasons.join('; ') || '--'} | ${summary} | [${functionAnchorId(entry.address, entry.name)}] |`,
      );
    }
    lines.push('');
  }

  lines.push('## Strings of interest');
  lines.push('');
  const interesting = strings.filter((entry) =>
    GHIDRA_INTERESTING_STRING_BUCKETS.includes(entry.bucket),
  );
  if (interesting.length === 0) {
    lines.push('> No strings fell into a category worth listing.');
    lines.push('');
  } else {
    for (const bucket of interesting) {
      lines.push(`#### ${bucket.bucket} (${bucket.count} total)`);
      lines.push('');
      for (const sample of bucket.samples.slice(0, 8)) {
        lines.push(`- \`${sample.value}\` [${stringAnchorId(sample.address, sample.value)}]`);
      }
      lines.push('');
    }
  }

  lines.push('## Anti-analysis and packaging');
  lines.push('');
  if (anti.length === 0) {
    lines.push('> Nothing in the surface data suggested packing or anti-analysis.');
  } else {
    for (const indicator of anti) {
      // The indicator itself is the anchor: its evidence can be a section name
      // or a string, so citing an import would be wrong for half of them.
      lines.push(
        `- **${indicator.code}** -- ${indicator.detail} [${indicatorAnchorId(indicator.code)}]`,
      );
    }
  }
  lines.push('');

  lines.push('## Coverage');
  lines.push('');
  for (const stage of ledger.stages) {
    const state = stage.state === 'done' ? 'ok' : stage.state;
    lines.push(
      `- ${stage.stage}: ${state}${stage.summary ? ` -- ${stage.summary}` : ''}${stage.detail ? ` (${stage.detail})` : ''}`,
    );
  }
  lines.push('');

  lines.push('## Open questions');
  lines.push('');
  lines.push('- This report covers the static surface only. Nothing was executed.');
  if (capa.length === 0) {
    lines.push(
      '- capa was not run, so capability claims come from the import table rather than from rules.',
    );
  }
  const failed = ledger.stages.filter((stage) => stage.state === 'failed');
  if (failed.length > 0) {
    lines.push(
      `- These stages failed and their findings are missing: ${failed.map((stage) => stage.stage).join(', ')}.`,
    );
  }
  lines.push('');

  lines.push('## Evidence ledger');
  lines.push('');
  lines.push('```');
  lines.push(buildLedgerText(ledger));
  lines.push('```');

  return lines.join('\n');
}

export function buildReportPrompt(ledger: GhidraSweepLedger): string {
  return [
    'You are a reverse-engineering report writer.',
    'Write a Markdown analysis report of one binary using ONLY the evidence ledger below.',
    '',
    'Hard rules:',
    '- Every factual line MUST cite at least one ledger anchor id in square brackets, e.g. [import:kernel32.dll!OpenProcess].',
    '- Never invent an anchor id. A line citing an id that is not in the ledger will be deleted.',
    '- Never state a behaviour the ledger does not show. If you are inferring, say so in Open questions instead.',
    '- Anchors marked (model-inferred) are summaries, not measurements. Do not present them as facts about the binary.',
    '- Prefer capa rule matches over your own reading of decompiled code where both exist.',
    '',
    'Required sections, in this order:',
    '# <binary name> -- Binary Analysis Report',
    'A short identity block, then one plain paragraph saying what this binary appears to be and do.',
    '## Capability summary',
    '## Architecture and entry flow',
    '## Notable functions',
    '## Strings of interest',
    '## Anti-analysis and packaging',
    '## Coverage',
    '## Open questions',
    '',
    `Binary: ${ledger.binaryName}`,
    `Path: ${ledger.binaryPath}`,
    `SHA-256: ${ledger.sha256}`,
    `Size: ${ledger.sizeBytes} bytes`,
    '',
    'Stage outcomes (say so in Coverage if a stage failed):',
    ledger.stages
      .map(
        (stage) => `- ${stage.stage}: ${stage.state}${stage.summary ? ` -- ${stage.summary}` : ''}`,
      )
      .join('\n'),
    '',
    'Evidence ledger:',
    buildLedgerText(ledger),
  ].join('\n');
}

export interface GhidraVerifierFinding {
  severity: 'blocking' | 'warning';
  code: string;
  message: string;
}

export interface GhidraVerifierResult {
  needsRewrite: boolean;
  findings: GhidraVerifierFinding[];
}

export function buildVerifierPrompt(ledger: GhidraSweepLedger, report: string): string {
  return [
    'You are a reverse-engineering report verifier.',
    'Review the report against the evidence ledger. Return only raw JSON, no markdown.',
    'Schema: {"needsRewrite":false,"findings":[{"severity":"blocking|warning","code":"short_code","message":"specific issue"}]}',
    '',
    'Treat as blocking: a claim the ledger does not support, a cited anchor id that is not in the ledger,',
    'presenting a (model-inferred) summary as a measured fact, or stating the binary DOES something when the',
    'evidence only shows it CAN (an imported API is a capability, not a behaviour).',
    '',
    'Evidence ledger:',
    buildLedgerText(ledger),
    '',
    'Report:',
    report.slice(0, MAX_REPORT_CHARS),
  ].join('\n');
}

export function parseVerifierResult(raw: string): GhidraVerifierResult {
  let parsed: unknown = null;
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      parsed = null;
    }
  }
  const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  const rawFindings = Array.isArray(record?.findings) ? record.findings : [];
  const findings: GhidraVerifierFinding[] = [];
  for (const item of rawFindings) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const message = typeof entry.message === 'string' ? entry.message.trim().slice(0, 500) : '';
    if (!message) {
      continue;
    }
    findings.push({
      severity: entry.severity === 'blocking' ? 'blocking' : 'warning',
      code:
        typeof entry.code === 'string' && entry.code
          ? entry.code.slice(0, 120)
          : 'verifier_finding',
      message,
    });
  }
  return {
    needsRewrite:
      record?.needsRewrite === true ||
      record?.needs_rewrite === true ||
      findings.some((finding) => finding.severity === 'blocking'),
    findings,
  };
}

export function buildRewritePrompt(
  ledger: GhidraSweepLedger,
  report: string,
  findings: readonly GhidraVerifierFinding[],
): string {
  return [
    'You are a reverse-engineering report rewriter.',
    'Rewrite the report once to fix the findings below. Keep the section structure.',
    'Every factual line must still cite a ledger anchor id in square brackets.',
    'Do not add anything new; remove or qualify what the findings identified.',
    '',
    'Findings:',
    findings
      .map((finding) => `- [${finding.severity}] ${finding.code}: ${finding.message}`)
      .join('\n'),
    '',
    'Evidence ledger:',
    buildLedgerText(ledger),
    '',
    'Report:',
    report.slice(0, MAX_REPORT_CHARS),
  ].join('\n');
}

export interface GhidraReportDeps {
  /** Absent -> the deterministic report is the deliverable. */
  callModel?(prompt: string, maxTokens: number, responseJson: boolean): Promise<string>;
  logError?(message: string, error?: unknown): void;
}

export interface GhidraReportResult {
  report: string;
  /** True when a model wrote it; false when the deterministic report shipped. */
  modelWritten: boolean;
  droppedClaims: number;
  unknownAnchors: string[];
  citedAnchors: string[];
  verifierFindings: GhidraVerifierFinding[];
  rewritten: boolean;
}

/** Append the enforcement outcome to the report. A drop the reader cannot see is
 *  indistinguishable from a fact that was never collected. */
function appendEnforcementNote(
  report: string,
  result: AnchorEnforcementResult,
  anchorCount: number,
): string {
  const notes = [
    '',
    '---',
    '',
    `*Evidence check: ${result.citedAnchors.length} of ${anchorCount} ledger anchors are cited above.*`,
  ];
  if (result.droppedClaims > 0) {
    notes.push(
      `*${result.droppedClaims} line${result.droppedClaims === 1 ? '' : 's'} were removed for citing no supporting evidence.*`,
    );
  }
  if (result.unknownAnchors.length > 0) {
    notes.push(
      `*Citations to non-existent anchors were stripped: ${result.unknownAnchors.join(', ')}.*`,
    );
  }
  return `${report}\n${notes.join('\n')}\n`;
}

/**
 * Draft -> enforce -> verify -> (one) rewrite -> enforce.
 *
 * Any model failure falls back to the deterministic report rather than to
 * nothing: the sweep already did the expensive work, and shipping its findings
 * unadorned beats shipping an error.
 */
export async function writeGhidraReport(
  ledger: GhidraSweepLedger,
  deps: GhidraReportDeps = {},
): Promise<GhidraReportResult> {
  const anchorIndex = buildAnchorIndex(ledger);
  const knownIds = new Set(anchorIndex.keys());
  const deterministic = buildDeterministicReport(ledger);

  if (!deps.callModel) {
    const enforced = enforceReportAnchors(deterministic, knownIds);
    return {
      report: appendEnforcementNote(enforced.report, enforced, anchorIndex.size),
      modelWritten: false,
      droppedClaims: enforced.droppedClaims,
      unknownAnchors: enforced.unknownAnchors,
      citedAnchors: enforced.citedAnchors,
      verifierFindings: [],
      rewritten: false,
    };
  }

  let draft = '';
  try {
    draft = (await deps.callModel(buildReportPrompt(ledger), REPORT_TOKENS, false)).trim();
  } catch (error) {
    deps.logError?.('ghidra-lab report draft failed', error);
  }
  if (!draft || draft.length < 200) {
    const enforced = enforceReportAnchors(deterministic, knownIds);
    return {
      report: appendEnforcementNote(enforced.report, enforced, anchorIndex.size),
      modelWritten: false,
      droppedClaims: enforced.droppedClaims,
      unknownAnchors: enforced.unknownAnchors,
      citedAnchors: enforced.citedAnchors,
      verifierFindings: [],
      rewritten: false,
    };
  }

  let enforced = enforceReportAnchors(draft, knownIds);
  let verifierFindings: GhidraVerifierFinding[] = [];
  let rewritten = false;

  try {
    const verdict = parseVerifierResult(
      await deps.callModel(buildVerifierPrompt(ledger, enforced.report), VERIFIER_TOKENS, true),
    );
    verifierFindings = verdict.findings;
    if (verdict.needsRewrite && verdict.findings.length > 0) {
      const rewrite = (
        await deps.callModel(
          buildRewritePrompt(ledger, enforced.report, verdict.findings),
          REPORT_TOKENS,
          false,
        )
      ).trim();
      if (rewrite.length >= 200) {
        const reEnforced = enforceReportAnchors(rewrite, knownIds);
        // Only accept the rewrite if it did not gut the report: a rewrite that
        // cites less than half of what the draft cited has usually collapsed
        // into generalities, which is the failure mode the whole pipeline exists
        // to avoid.
        if (reEnforced.citedAnchors.length * 2 >= enforced.citedAnchors.length) {
          enforced = reEnforced;
          rewritten = true;
        }
      }
    }
  } catch (error) {
    deps.logError?.('ghidra-lab report verification failed', error);
  }

  // A draft that lost almost everything to enforcement is worse than the
  // deterministic report; ship the one that actually says something.
  if (enforced.citedAnchors.length === 0) {
    const fallback = enforceReportAnchors(deterministic, knownIds);
    return {
      report: appendEnforcementNote(fallback.report, fallback, anchorIndex.size),
      modelWritten: false,
      droppedClaims: enforced.droppedClaims + fallback.droppedClaims,
      unknownAnchors: enforced.unknownAnchors,
      citedAnchors: fallback.citedAnchors,
      verifierFindings,
      rewritten: false,
    };
  }

  return {
    report: appendEnforcementNote(enforced.report, enforced, anchorIndex.size),
    modelWritten: true,
    droppedClaims: enforced.droppedClaims,
    unknownAnchors: enforced.unknownAnchors,
    citedAnchors: enforced.citedAnchors,
    verifierFindings,
    rewritten,
  };
}
