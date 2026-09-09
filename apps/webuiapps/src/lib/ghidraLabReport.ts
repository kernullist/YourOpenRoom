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
import type { GhidraBehaviorResult } from './ghidraBehavior';
import type { GhidraDynamicApiResult } from './ghidraDynamicApi';
import type { GhidraDecodedString } from './ghidraFloss';
import type { GhidraObfuscationFinding } from './ghidraObfuscation';
import { looksLikeMermaid, type GhidraCapaMatch } from './ghidraLabSweep';
import {
  behaviorAnchorId,
  callgraphAnchorId,
  capaAnchorId,
  decodedAnchorId,
  dynApiAnchorId,
  obfuscationAnchorId,
  functionAnchorId,
  importAnchorId,
  indicatorAnchorId,
  stringAnchorId,
  type GhidraEvidenceAnchor,
  type GhidraSweepLedger,
} from './ghidraLabTypes';

const MAX_LEDGER_CHARS = 40000;
const MAX_REPORT_CHARS = 60000;
/**
 * Room for the whole report.
 *
 * Raised with the section count. At 6000 -- the budget from when there were six
 * sections -- a real run ended mid-sentence in "Notable functions" and the four
 * deep-analysis sections after it were simply never written. A truncated report
 * is not a shorter report; it is one that silently omits its findings.
 */
const REPORT_TOKENS = 12000;
const VERIFIER_TOKENS = 1500;

/**
 * Sections whose prose is allowed to stand without a citation.
 *
 * Matched EXACTLY, not as substrings. Substring matching was an escape hatch
 * out of the whole enforcement pass: a heading the model chose itself, like
 * "Capability summary and coverage", contains 'coverage' and freed every line
 * under it to say anything at all. The exemption exists for the four sections
 * that are meant to hold interpretation rather than findings, and it should
 * apply to those four and nothing else.
 */
const CITATION_EXEMPT_HEADINGS: readonly string[] = [
  'open questions',
  'evidence ledger',
  'coverage',
  'what was not examined',
];

/** A heading reduced to comparable form: no markers, punctuation or case. */
function normalizeHeading(heading: string): string {
  return heading
    .replace(/^#+\s*/, '')
    .replace(/[^a-z0-9 ]+/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

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
  'decoded',
  'dynapi',
  'obfuscation',
  'behavior',
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
      const heading = normalizeHeading(trimmed);
      exempt = CITATION_EXEMPT_HEADINGS.includes(heading);
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
    if (real.length === matches.length) {
      // Nothing to strip, so nothing to tidy: leave the line byte for byte.
      kept.push(line);
      continue;
    }
    const cleaned = line.replace(CITATION_REGEX, (whole, id: string) => {
      const trimmedId = id.trim();
      if (looksLikeAnchorId(trimmedId) && !knownIds.has(trimmedId)) {
        return '';
      }
      return whole;
    });
    // Close the gap a removed citation left, but only from the BODY of the
    // line. Collapsing every run of whitespace also collapsed leading indent,
    // which is what markdown nests lists with -- a four-space child item came
    // out as a one-space sibling.
    const indent = cleaned.slice(0, cleaned.length - cleaned.trimStart().length);
    kept.push(
      `${indent}${cleaned
        .trimStart()
        .replace(/\s{2,}/g, ' ')
        .trimEnd()}`,
    );
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
/**
 * A line admitting that a table is a sample, printed only when it is one.
 *
 * A capped table with nothing above it reads as the whole set. Every number in
 * this report is supposed to be checkable, and "the first 40 of them" is part
 * of what makes a count checkable.
 */
/** Diagram text kept in the report. */
const MAX_GRAPH_CHARS = 8000;

/**
 * Trim diagram text to a whole number of lines and say that it was trimmed.
 *
 * mermaid is line-oriented: half an edge is a syntax error, and the viewer
 * renders a syntax error as an empty box rather than as a partial diagram.
 */
export function capGraphText(graph: string, limit: number): string {
  if (graph.length <= limit) {
    return graph;
  }
  const lines = graph.slice(0, limit).split('\n');
  // Drop the line the cut landed in the middle of.
  lines.pop();
  const kept = lines.length;
  const total = graph.split('\n').length;
  return [...lines, `  %% truncated for the report: ${kept} of ${total} lines`].join('\n');
}

function samplingNote(shown: number, total: number, what: string): string[] {
  if (total <= shown) {
    return [];
  }
  return [`> Showing the first ${shown} of ${total} ${what}.`, ''];
}

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
  const decoded = (facts.decodedStrings as GhidraDecodedString[] | undefined) ?? [];
  const dynamic = facts.dynamicApis as GhidraDynamicApiResult | undefined;
  const obfuscation = (facts.obfuscation as GhidraObfuscationFinding[] | undefined) ?? [];
  const behavior = facts.behavior as GhidraBehaviorResult | undefined;
  const reachableCategories =
    (facts.reachableCategories as { category: string; count: number }[] | undefined) ?? [];

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
    lines.push(...samplingNote(Math.min(40, capa.length), capa.length, 'capa matches'));
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
      const cited = signal.symbols.slice(0, 4);
      const citations = cited.map((symbol) => `[${importAnchorId(symbol)}]`).join(' ');
      // Four citations behind a claim backed by forty imports read exactly like
      // four behind a claim backed by four. The count separates them.
      const total = signal.symbolCount ?? signal.symbols.length;
      const scale = total > cited.length ? ` (${cited.length} of ${total} matching imports)` : '';
      lines.push(`- **${signal.category}** -- ${signal.claim}.${scale} ${citations}`);
    }
    lines.push('');
  }
  if (capa.length === 0 && capabilities.length === 0) {
    lines.push('> No capability signals were derived. The import table was empty or unreadable.');
    lines.push('');
  }

  if (typeof facts.callgraph === 'string' && facts.callgraph) {
    const root = String(facts.callgraphRoot ?? '');
    // Cut on a line boundary. Slicing a mermaid diagram mid-edge leaves a
    // broken statement, and a broken diagram renders as nothing at all --
    // which is how a truncated graph came to look like no graph.
    const graph = capGraphText(String(facts.callgraph), MAX_GRAPH_CHARS);
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
    lines.push(
      ...samplingNote(Math.min(40, selected.length), selected.length, 'functions that were read'),
    );
    lines.push('| Function | Address | Selected because | Summary | Evidence |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const entry of selected.slice(0, 40)) {
      // Address first, and only then the name. Taking either meant the row
      // for the second of two same-named functions matched the first one by
      // name and printed its summary -- a description of one function's code
      // filed under the other's address.
      const body =
        deepRead.find(
          (candidate) => Boolean(candidate.address) && candidate.address === entry.address,
        ) ?? deepRead.find((candidate) => candidate.name === entry.name);
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

  lines.push('## What it does when it runs');
  lines.push('');
  lines.push(
    '> Reachability and call ordering, not observed execution. Nothing here says the binary ran.',
  );
  if (behavior && !behavior.rootedAtEntry && behavior.reachable.length > 0) {
    lines.push('');
    // The weaker claim, said plainly rather than dressed as the stronger one.
    lines.push(
      '> No call path from the entry point could be resolved, so the table below lists what each function that WAS read calls -- not what the program reaches when it starts.',
    );
  }
  lines.push('');
  if (!behavior || behavior.chains.length === 0) {
    lines.push('> No known behaviour chain matched what was read.');
    lines.push('');
  } else {
    for (const chain of behavior.chains) {
      const where = chain.functionName
        ? `in \`${chain.functionName}\``
        : 'across the image, not within one function';
      lines.push(
        `- **${chain.title}** (${chain.confidence}) -- ${chain.apis.join(' -> ')} ${where}. [${behaviorAnchorId(chain.code)}]`,
      );
    }
    lines.push('');
  }
  if (behavior && behavior.reachable.length > 0) {
    lines.push(
      behavior.rootedAtEntry
        ? '| Reached API | From | Depth | Via |'
        : '| Called API | Called by | Depth | Via |',
    );
    lines.push('| --- | --- | --- | --- |');
    lines.push(
      ...samplingNote(
        Math.min(30, behavior.reachable.length),
        behavior.reachable.length,
        'reachable APIs',
      ),
    );
    for (const entry of behavior.reachable.slice(0, 30)) {
      lines.push(`| \`${entry.symbol}\` | ${entry.from} | ${entry.depth} | ${entry.via} |`);
    }
    lines.push('');
    if (reachableCategories.length > 0) {
      lines.push(
        `> Reachable API categories: ${reachableCategories.map((entry) => `${entry.category} ${entry.count}`).join(', ')}.`,
      );
      lines.push('');
    }
  }

  lines.push('## Dynamically resolved APIs');
  lines.push('');
  if (!dynamic || (dynamic.resolved.length === 0 && dynamic.hashing.length === 0)) {
    lines.push('> Nothing suggested the binary resolves APIs at run time.');
    lines.push('');
  } else {
    for (const entry of dynamic.hashing) {
      lines.push(`- **${entry.code}** -- ${entry.detail} [${dynApiAnchorId(entry.code)}]`);
    }
    const named = dynamic.resolved.filter((entry) => entry.symbol);
    if (named.length > 0) {
      lines.push('');
      lines.push('| API | Resolved in | Evidence |');
      lines.push('| --- | --- | --- |');
      lines.push(...samplingNote(Math.min(40, named.length), named.length, 'resolved APIs'));
      for (const entry of named.slice(0, 40)) {
        // The address rides along with the name because the name is not
        // unique: this binary has two `_RTC_GetSrcLine` functions, and two
        // rows naming the same one read as a duplicate rather than as the
        // two separate resolver sites they are.
        const where = entry.address ? ` @${entry.address}` : '';
        const site = entry.functionName
          ? `\`${entry.functionName}\`${where}`
          : where.trim() || 'an unnamed site';
        lines.push(
          `| \`${entry.symbol}\` [${dynApiAnchorId(entry.symbol)}] | ${site} | ${entry.evidence.replace(/_/g, ' ')} |`,
        );
      }
    }
    lines.push('');
  }

  lines.push('## Obfuscation');
  lines.push('');
  if (obfuscation.length === 0) {
    lines.push('> No obfuscation construct was found in what was read.');
    lines.push('');
  } else {
    lines.push('> Found and located, not undone. Each row names what would actually reverse it.');
    lines.push('');
    for (const finding of obfuscation) {
      const where = finding.functionName || finding.address || 'whole image';
      lines.push(
        `- **${finding.code}** in ${where} (${finding.confidence}) -- ${finding.detail} [${obfuscationAnchorId(finding.code, finding.address || finding.functionName)}]`,
      );
    }
    lines.push('');
  }

  lines.push('## Recovered strings');
  lines.push('');
  if (decoded.length === 0) {
    lines.push(
      '> No hidden strings were recovered. Either the binary does not hide its strings, or FLOSS was not configured -- Coverage says which.',
    );
    lines.push('');
  } else {
    lines.push(...samplingNote(Math.min(60, decoded.length), decoded.length, 'recovered strings'));
    lines.push('| String | Kind | Decoded by |');
    lines.push('| --- | --- | --- |');
    for (const entry of decoded.slice(0, 60)) {
      const value = entry.value.replace(/\|/g, '\\|').slice(0, 120);
      lines.push(
        `| \`${value}\` [${decodedAnchorId(entry.decodingRoutine, entry.value)}] | ${entry.kind} | ${entry.decodingRoutine || 'n/a'} |`,
      );
    }
    lines.push('');
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
  // Evidence that hit an anchor cap is evidence no claim can cite, so it
  // belongs in Coverage next to the stages that produced it.
  lines.push(...anchorCapNotes(ledger));
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
    '- In "What it does when it runs", write reachability and ordering ONLY. The binary was never executed; "can" and "is reachable from" are true, "does" and "then it" are not.',
    '- In "Obfuscation", do not claim anything was deobfuscated. The anchors say what was found and what would undo it.',
    '- A [dynapi:...] anchor for a hashing technique names a TECHNIQUE, not an API. Do not present it as a resolved function name.',
    '',
    'Required sections, in this order:',
    '# <binary name> -- Binary Analysis Report',
    'A short identity block, then one plain paragraph saying what this binary appears to be and do.',
    '## Capability summary',
    '## Architecture and entry flow',
    '## Notable functions',
    '## Strings of interest',
    '## What it does when it runs',
    '## Dynamically resolved APIs',
    '## Obfuscation',
    '## Recovered strings',
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
    // The detail carries "truncated at the engine cap", "some batches failed"
    // and "waited for the string index". Sending only the summary meant the
    // model wrote a Coverage section that could not mention any of them.
    ledger.stages
      .map(
        (stage) =>
          `- ${stage.stage}: ${stage.state}${stage.summary ? ` -- ${stage.summary}` : ''}${
            stage.detail ? ` (${stage.detail})` : ''
          }`,
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

/**
 * Say when evidence was never recorded, so a stripped claim has an explanation.
 *
 * The ledger is what a claim has to cite, so evidence that hit an anchor cap is
 * evidence no claim can lean on -- the enforcement pass deletes the sentence as
 * unsupported and, without this line, gives no reason.
 */
function anchorCapNotes(ledger: GhidraSweepLedger): string[] {
  const caps = (ledger.facts.anchorCaps ?? []) as { kind: string; kept: number; found: number }[];
  if (!Array.isArray(caps) || caps.length === 0) {
    return [];
  }
  return caps.map(
    (cap) =>
      `*${cap.found - cap.kept} ${cap.kind} anchors were not recorded: the ledger keeps ${cap.kept} of ${cap.found}.*`,
  );
}

/**
 * The headings a complete report has, in prompt order.
 *
 * Used to notice a model that stopped early. A draft missing most of these did
 * not summarise the binary more briefly -- it ran out of room, and the sections
 * it never reached are the ones the deep-analysis stages just paid for.
 */
const REQUIRED_SECTIONS: readonly string[] = [
  'capability summary',
  'architecture and entry flow',
  'notable functions',
  'strings of interest',
  'what it does when it runs',
  'dynamically resolved apis',
  'obfuscation',
  'recovered strings',
  // Already in normalised form: the normaliser turns punctuation into spaces,
  // so a hyphen here would never match the heading it came from.
  'anti analysis and packaging',
  'coverage',
  'open questions',
];

/** How many of the required sections a draft must carry to be worth shipping. */
const MIN_SECTION_COVERAGE = 0.6;

export function countRequiredSections(report: string): number {
  const headings = new Set(
    report
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith('#'))
      .map((line) =>
        line
          .replace(/^#+\s*/, '')
          .replace(/[^a-z0-9 ]+/gi, ' ')
          .trim()
          .replace(/\s+/g, ' ')
          .toLowerCase(),
      ),
  );
  return REQUIRED_SECTIONS.filter((name) => headings.has(name)).length;
}

/**
 * Did the model stop before it finished?
 *
 * Two tells, either of which is enough. A draft that reached fewer than most of
 * its required headings ran out of budget; so did one whose last line of prose
 * ends without terminal punctuation, which is what hitting a token cap
 * mid-sentence looks like.
 */
export function looksTruncated(report: string): boolean {
  if (countRequiredSections(report) < Math.ceil(REQUIRED_SECTIONS.length * MIN_SECTION_COVERAGE)) {
    return true;
  }
  const lines = report
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const isProse = !/^[#|>*-]|^```|^\*/.test(last);
  return isProse && last.length > 40 && !/[.!?:)\]`]$/.test(last);
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
  ledger: GhidraSweepLedger,
): string {
  const notes = [
    '',
    '---',
    '',
    `*Evidence check: ${result.citedAnchors.length} of ${anchorCount} ledger anchors are cited above.*`,
    ...anchorCapNotes(ledger),
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
      report: appendEnforcementNote(enforced.report, enforced, anchorIndex.size, ledger),
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
      report: appendEnforcementNote(enforced.report, enforced, anchorIndex.size, ledger),
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

  // A draft that lost almost everything to enforcement, or that stopped before
  // it finished, is worse than the deterministic report -- which always carries
  // every section. Ship the one that actually says something.
  //
  // Measured: a model asked for fourteen stages' worth of sections inside a
  // six-section token budget ended mid-sentence with four sections missing, and
  // shipped anyway because it had cited SOMETHING.
  if (enforced.citedAnchors.length === 0 || looksTruncated(enforced.report)) {
    const fallback = enforceReportAnchors(deterministic, knownIds);
    return {
      report: appendEnforcementNote(fallback.report, fallback, anchorIndex.size, ledger),
      modelWritten: false,
      droppedClaims: enforced.droppedClaims + fallback.droppedClaims,
      unknownAnchors: enforced.unknownAnchors,
      citedAnchors: fallback.citedAnchors,
      verifierFindings,
      rewritten: false,
    };
  }

  return {
    report: appendEnforcementNote(enforced.report, enforced, anchorIndex.size, ledger),
    modelWritten: true,
    droppedClaims: enforced.droppedClaims,
    unknownAnchors: enforced.unknownAnchors,
    citedAnchors: enforced.citedAnchors,
    verifierFindings,
    rewritten,
  };
}
