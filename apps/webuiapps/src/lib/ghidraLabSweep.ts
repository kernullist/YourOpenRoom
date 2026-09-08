// Ghidra Lab sweep: walk a binary through ten fixed stages and reduce everything
// found into an evidence ledger.
//
// The ledger is the contract with the report writer. Seven of the ten stages are
// produced by code, and every fact they produce becomes an ANCHOR -- an id, an
// address, and the fact itself. The model may only write about anchors; the
// verifier deletes any claim that cites none. That is the whole hallucination
// strategy, and it is why this file is deliberately boring: it collects, it does
// not interpret.
//
// The engine's response shapes are the one genuinely uncertain thing here.
// pyghidra-mcp's field names differ across versions and there is no schema to pin
// to, so extraction is forgiving by design (try several key names, keep what is
// there, never throw) and lives in exported pure functions so a real install can
// tighten it in one place.
//
// Server-only: fs + crypto for the identity stage.
import { createHash } from 'crypto';
import * as fs from 'fs';

import {
  detectAntiAnalysis,
  selectFunctionsForDeepRead,
  summarizeImportCapabilities,
  summarizeStrings,
  uncategorizedImports,
  type GhidraFunctionCandidate,
} from './ghidraLabHeuristics';
import type { GhidraLabQueryOutcome } from './ghidraLabSession';
import {
  GHIDRA_SWEEP_STAGES,
  callgraphAnchorId,
  capaAnchorId,
  exportAnchorId,
  functionAnchorId,
  importAnchorId,
  indicatorAnchorId,
  stringAnchorId,
  type GhidraEvidenceAnchor,
  type GhidraLabConfigView,
  type GhidraSweepLedger,
  type GhidraSweepStage,
  type GhidraSweepStageState,
  type GhidraSweepStageView,
} from './ghidraLabTypes';

/** How many functions the deep read may spend tokens on. */
export const GHIDRA_DEEP_READ_LIMIT = 40;
/** Per-function decompiled body kept in the ledger. */
export const GHIDRA_DECOMPILE_CHARS = 6000;
/** Total decompiled text the whole sweep may accumulate. */
export const GHIDRA_DEEP_READ_TOTAL_CHARS = 120000;
/** Functions per decompile call -- the engine's batch form is why this is not 1. */
export const GHIDRA_DECOMPILE_BATCH = 8;

/** How long the strings stage will wait for the engine's background index. */
export const STRING_INDEX_WAIT_MS = 60_000;
const STRING_INDEX_POLL_MS = 5_000;

const MAX_IMPORT_ANCHORS = 120;
const MAX_STRING_ANCHORS = 80;
const MAX_EXPORT_ANCHORS = 60;

export interface GhidraCapaOutcome {
  ok: boolean;
  /** Parsed capa JSON, when it ran. */
  payload: unknown;
  error: string;
}

export interface GhidraSweepDeps {
  query(
    sessionId: string,
    kind: string,
    args: Record<string, unknown>,
  ): Promise<GhidraLabQueryOutcome>;
  hashFile(path: string): { sha256: string; sizeBytes: number; mtimeMs: number };
  /** Absent -> the capability stage is skipped, not failed. */
  runCapa?(params: { binaryPath: string; config: GhidraLabConfigView }): Promise<GhidraCapaOutcome>;
  /** Absent -> deep read keeps the decompiled body but records no prose summary. */
  summarizeFunction?(params: {
    name: string;
    address: string;
    decompiled: string;
    reasons: string[];
  }): Promise<string>;
  now(): number;
  /**
   * Absent -> stages never wait. Present -> the strings stage may retry while
   * the engine finishes building its string index (see the stage comment).
   */
  sleep?(ms: number): Promise<void>;
  /** Return false to abort between stages (operator cancelled, panic, shutdown). */
  shouldContinue?(): boolean;
  onStage?(stage: GhidraSweepStageView, ledger: GhidraSweepLedger): void;
  logError?(message: string, error?: unknown): void;
}

// --- Forgiving extraction ---------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return '';
}

function pickNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      return Number.parseInt(value.trim(), 10);
    }
  }
  return undefined;
}

export interface ExtractedImport {
  symbol: string;
  library: string;
  address: string;
}

/** Pull imports out of whatever `list_imports` answered. */
export function extractImports(rows: readonly unknown[]): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      // "kernel32.dll!WriteProcessMemory" or a bare symbol.
      const bang = row.indexOf('!');
      if (bang > 0) {
        imports.push({
          library: row.slice(0, bang).trim(),
          symbol: row.slice(bang + 1).trim(),
          address: '',
        });
      } else if (row.trim()) {
        imports.push({ library: '', symbol: row.trim(), address: '' });
      }
      continue;
    }
    const record = asRecord(row);
    if (!record) {
      continue;
    }
    // Some builds answer one row per library with a nested symbol list.
    const nested = record.functions ?? record.symbols ?? record.imports;
    const library = pickString(record, ['library', 'dll', 'module', 'namespace', 'source']);
    if (Array.isArray(nested)) {
      for (const entry of nested) {
        const child = asRecord(entry);
        const symbol = child
          ? pickString(child, ['name', 'symbol', 'function'])
          : typeof entry === 'string'
            ? entry
            : '';
        if (symbol) {
          imports.push({
            symbol,
            // The library lives on the CHILD in the shape this engine returns
            // ({ imports: [{ name, library }] }); reading only the outer record
            // reported every import as coming from nowhere.
            library: (child && pickString(child, ['library', 'dll', 'module'])) || library,
            address: child ? pickString(child, ['address', 'addr', 'entry']) : '',
          });
        }
      }
      continue;
    }
    const symbol = pickString(record, ['name', 'symbol', 'function', 'import']);
    if (symbol) {
      imports.push({
        symbol,
        library,
        address: pickString(record, ['address', 'addr', 'entry']),
      });
    }
  }
  return imports;
}

export interface ExtractedString {
  value: string;
  address: string;
}

export function extractStrings(rows: readonly unknown[]): ExtractedString[] {
  const strings: ExtractedString[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      if (row.trim()) {
        strings.push({ value: row, address: '' });
      }
      continue;
    }
    const record = asRecord(row);
    if (!record) {
      continue;
    }
    const value = pickString(record, ['value', 'string', 'text', 'content', 'name']);
    if (value) {
      strings.push({
        value,
        address: pickString(record, ['address', 'addr', 'location', 'offset']),
      });
    }
  }
  return strings;
}

export function extractFunctions(rows: readonly unknown[]): GhidraFunctionCandidate[] {
  const functions: GhidraFunctionCandidate[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      if (row.trim()) {
        functions.push({ name: row.trim(), address: '' });
      }
      continue;
    }
    const record = asRecord(row);
    if (!record) {
      continue;
    }
    const name = pickString(record, ['name', 'symbol', 'function', 'label']);
    const address = pickString(record, ['address', 'addr', 'entry', 'entry_point', 'offset']);
    if (!name && !address) {
      continue;
    }
    const callsImports = Array.isArray(record.calls ?? record.callees ?? record.imports)
      ? ((record.calls ?? record.callees ?? record.imports) as unknown[])
          .map((entry) =>
            typeof entry === 'string'
              ? entry
              : pickString(asRecord(entry) ?? {}, ['name', 'symbol']),
          )
          .filter((entry): entry is string => Boolean(entry))
      : undefined;
    functions.push({
      name,
      address,
      ...(pickNumber(record, ['size', 'length', 'body_size']) !== undefined
        ? { size: pickNumber(record, ['size', 'length', 'body_size']) }
        : {}),
      ...(pickNumber(record, ['xref_count', 'xrefs', 'references', 'reference_count']) !== undefined
        ? {
            xrefCount: pickNumber(record, ['xref_count', 'xrefs', 'references', 'reference_count']),
          }
        : {}),
      ...(callsImports && callsImports.length ? { callsImports } : {}),
      ...(record.is_entry === true || record.entry === true ? { isEntryPoint: true } : {}),
      ...(record.is_export === true || record.exported === true ? { isExport: true } : {}),
    });
  }
  return functions;
}

/**
 * Find one function's body in a decompile answer.
 *
 * The engine keys a decompiled function as `<name>-<address>`
 * (`check_managed_app-00412210`), not by the name we asked for, so an exact
 * lookup finds nothing and the deep-read stage reports "no function could be
 * decompiled" even though every call succeeded. Match on the name, the address,
 * or the combined form.
 */
export function findDecompiledBody(
  bodies: ReadonlyMap<string, string>,
  name: string,
  address: string,
): string {
  const direct = bodies.get(name) || (address ? bodies.get(address) : '');
  if (direct) {
    return direct;
  }
  const wantedName = name.toLowerCase();
  // Addresses come back with and without a leading 0x depending on the field.
  const wantedAddress = address.toLowerCase().replace(/^0x/, '');
  for (const [key, body] of bodies) {
    const lowered = key.toLowerCase();
    if (wantedName && (lowered === wantedName || lowered.startsWith(`${wantedName}-`))) {
      return body;
    }
    if (wantedAddress && lowered.includes(wantedAddress)) {
      return body;
    }
  }
  // A single unkeyed answer belongs to whatever was asked for.
  if (bodies.size === 1) {
    const only = [...bodies.entries()][0];
    if (!only[0]) {
      return only[1];
    }
  }
  return '';
}

/** Pull the decompiled body out of a decompile answer, whatever it is wrapped in. */
export function extractDecompiled(rows: readonly unknown[]): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const row of rows) {
    if (typeof row === 'string') {
      // A bare string answer belongs to whatever was asked for; the caller keys it.
      bodies.set('', row);
      continue;
    }
    const record = asRecord(row);
    if (!record) {
      continue;
    }
    const key =
      pickString(record, ['name', 'symbol', 'function']) ||
      pickString(record, ['address', 'addr', 'entry']);
    const body = pickString(record, [
      'decompiled',
      'code',
      'c',
      'pseudo_c',
      'text',
      'body',
      'source',
    ]);
    if (body) {
      bodies.set(key, body);
    }
  }
  return bodies;
}

// --- Ledger helpers ---------------------------------------------------------

function makeStages(): GhidraSweepStageView[] {
  return GHIDRA_SWEEP_STAGES.map((stage) => ({
    stage,
    state: 'pending' as GhidraSweepStageState,
    startedAt: null,
    finishedAt: null,
    summary: '',
    detail: '',
  }));
}

function anchor(
  ledger: GhidraSweepLedger,
  entry: Omit<GhidraEvidenceAnchor, 'binary'> & { binary?: string },
): GhidraEvidenceAnchor {
  const full: GhidraEvidenceAnchor = {
    binary: entry.binary ?? ledger.binaryName,
    id: entry.id,
    kind: entry.kind,
    address: entry.address,
    symbol: entry.symbol,
    detail: entry.detail,
    deterministic: entry.deterministic,
  };
  ledger.anchors.push(full);
  return full;
}

class SweepAborted extends Error {
  constructor() {
    super('sweep_cancelled');
    this.name = 'SweepAborted';
  }
}

/**
 * Run the sweep.
 *
 * Stage failures are recorded and the sweep CONTINUES: a binary whose strings
 * could not be read still deserves a report about its imports. Only cancellation
 * stops the walk. What each stage did (or could not do) ends up in the ledger, so
 * the report can state its own coverage honestly.
 */
export async function runGhidraSweep(params: {
  runId: string;
  sessionId: string;
  binaryPath: string;
  binaryName: string;
  config: GhidraLabConfigView;
  deps: GhidraSweepDeps;
}): Promise<GhidraSweepLedger> {
  const { deps } = params;
  const ledger: GhidraSweepLedger = {
    runId: params.runId,
    binaryPath: params.binaryPath,
    binaryName: params.binaryName,
    sha256: '',
    sizeBytes: 0,
    createdAt: deps.now(),
    anchors: [],
    stages: makeStages(),
    facts: {},
  };

  const stageIndex = new Map<GhidraSweepStage, number>(
    ledger.stages.map((entry, index) => [entry.stage, index]),
  );

  const beginStage = (stage: GhidraSweepStage): GhidraSweepStageView => {
    if (deps.shouldContinue && !deps.shouldContinue()) {
      throw new SweepAborted();
    }
    const view = ledger.stages[stageIndex.get(stage) ?? 0];
    view.state = 'running';
    view.startedAt = deps.now();
    deps.onStage?.(view, ledger);
    return view;
  };

  const endStage = (
    view: GhidraSweepStageView,
    state: GhidraSweepStageState,
    summary: string,
    detail = '',
  ): void => {
    view.state = state;
    view.finishedAt = deps.now();
    view.summary = summary;
    view.detail = detail;
    deps.onStage?.(view, ledger);
  };

  /** One engine read, with the failure folded into the stage rather than thrown. */
  const read = async (
    kind: string,
    args: Record<string, unknown> = {},
  ): Promise<{ rows: unknown[]; error: string; truncated: boolean }> => {
    try {
      // No binary_name here on purpose: the session injects the name the ENGINE
      // assigned at import, which is not the filename this sweep was started
      // with. Passing ours would win over the correct one and every stage would
      // fail with "Binary <file> not found".
      const outcome = await deps.query(params.sessionId, kind, args);
      if (!outcome.ok) {
        return { rows: [], error: outcome.engineError || outcome.reason, truncated: false };
      }
      return { rows: outcome.rows, error: '', truncated: outcome.truncated };
    } catch (error) {
      return {
        rows: [],
        error: error instanceof Error ? error.message : String(error),
        truncated: false,
      };
    }
  };

  try {
    // --- 1. Identity -------------------------------------------------------
    {
      const view = beginStage('identity');
      try {
        const hashed = deps.hashFile(params.binaryPath);
        ledger.sha256 = hashed.sha256;
        ledger.sizeBytes = hashed.sizeBytes;
        anchor(ledger, {
          id: 'header:sha256',
          kind: 'header',
          address: '',
          symbol: '',
          detail: `sha256 ${hashed.sha256}; ${hashed.sizeBytes} bytes`,
          deterministic: true,
        });
        const metadata = await read('metadata');
        ledger.facts.metadata = metadata.rows;
        if (metadata.rows.length > 0) {
          anchor(ledger, {
            id: 'header:metadata',
            kind: 'header',
            address: '',
            symbol: '',
            detail: JSON.stringify(metadata.rows).slice(0, 2000),
            deterministic: true,
          });
        }
        endStage(
          view,
          'done',
          `sha256 ${hashed.sha256.slice(0, 12)}..., ${hashed.sizeBytes} bytes`,
          metadata.error,
        );
      } catch (error) {
        endStage(view, 'failed', 'could not hash the file', String(error));
      }
    }

    // --- 2. Imports --------------------------------------------------------
    let imports: ExtractedImport[] = [];
    {
      const view = beginStage('imports');
      const result = await read('imports');
      imports = extractImports(result.rows);
      ledger.facts.imports = imports;
      const signals = summarizeImportCapabilities(imports);
      ledger.facts.importCapabilities = signals;
      ledger.facts.uncategorizedImports = uncategorizedImports(imports).slice(0, 200);
      // Symbols the report is going to cite must be anchored whatever the cap.
      // An import that fell off the end is an import the enforcement pass would
      // then delete the claim for -- the capability would be real and the report
      // would silently lose it.
      const willBeCited = new Set(signals.flatMap((signal) => signal.symbols));
      const ordered = [
        ...imports.filter((entry) => willBeCited.has(entry.symbol)),
        ...imports.filter((entry) => !willBeCited.has(entry.symbol)),
      ];
      const seenImportIds = new Set<string>();
      for (const entry of ordered.slice(0, MAX_IMPORT_ANCHORS)) {
        const id = importAnchorId(entry.symbol);
        if (seenImportIds.has(id)) {
          continue;
        }
        seenImportIds.add(id);
        anchor(ledger, {
          id,
          kind: 'import',
          address: entry.address,
          symbol: entry.symbol,
          detail: entry.library ? `imported from ${entry.library}` : 'imported',
          deterministic: true,
        });
      }
      if (result.error) {
        endStage(view, 'failed', 'imports unavailable', result.error);
      } else {
        const libraries = new Set(imports.map((entry) => entry.library).filter(Boolean));
        endStage(
          view,
          'done',
          `${imports.length} imports across ${libraries.size} librar${libraries.size === 1 ? 'y' : 'ies'}; ${signals.length} capability signals`,
        );
      }
    }

    // --- 3. Exports --------------------------------------------------------
    let exportNames: string[] = [];
    {
      const view = beginStage('exports');
      const result = await read('exports');
      const exported = extractFunctions(result.rows);
      exportNames = exported.map((entry) => entry.name).filter(Boolean);
      ledger.facts.exports = exported;
      for (const entry of exported.slice(0, MAX_EXPORT_ANCHORS)) {
        anchor(ledger, {
          id: exportAnchorId(entry.name, entry.address),
          kind: 'export',
          address: entry.address,
          symbol: entry.name,
          detail: 'exported entry point',
          deterministic: true,
        });
      }
      if (result.error) {
        endStage(view, 'failed', 'exports unavailable', result.error);
      } else {
        endStage(view, 'done', `${exported.length} exports`);
      }
    }

    // --- 4. Strings --------------------------------------------------------
    let strings: ExtractedString[] = [];
    {
      const view = beginStage('strings');
      // The engine builds its string index AFTER analysis completes, on a
      // background task, so a session that is legitimately ready can still
      // answer "no strings" for a while. Measured: a binary with 132 strings
      // reported zero immediately after readiness. Retry briefly rather than
      // record an empty -- and say in the stage detail that we waited.
      let result = await read('strings');
      strings = extractStrings(result.rows);
      let waitedMs = 0;
      if (deps.sleep) {
        while (strings.length === 0 && !result.error && waitedMs < STRING_INDEX_WAIT_MS) {
          if (deps.shouldContinue && !deps.shouldContinue()) {
            break;
          }
          await deps.sleep(STRING_INDEX_POLL_MS);
          waitedMs += STRING_INDEX_POLL_MS;
          result = await read('strings');
          strings = extractStrings(result.rows);
        }
      }
      const summary = summarizeStrings(strings);
      ledger.facts.stringSummary = summary;
      for (const bucket of summary) {
        for (const sample of bucket.samples.slice(
          0,
          Math.ceil(MAX_STRING_ANCHORS / Math.max(1, summary.length)),
        )) {
          anchor(ledger, {
            id: stringAnchorId(sample.address, sample.value),
            kind: 'string',
            address: sample.address,
            symbol: '',
            detail: `${bucket.bucket}: ${sample.value}`,
            deterministic: true,
          });
        }
      }
      if (result.error) {
        endStage(view, 'failed', 'strings unavailable', result.error);
      } else {
        const waited =
          waitedMs > 0 ? `waited ${Math.round(waitedMs / 1000)}s for the string index` : '';
        endStage(
          view,
          'done',
          `${strings.length} strings; ${summary.map((entry) => `${entry.bucket} ${entry.count}`).join(', ')}`,
          [result.truncated ? 'string list was truncated at the engine cap' : '', waited]
            .filter(Boolean)
            .join('; '),
        );
      }
    }

    // --- 5. Function inventory --------------------------------------------
    let functions: GhidraFunctionCandidate[] = [];
    {
      const view = beginStage('inventory');
      const result = await read('functions');
      functions = extractFunctions(result.rows);
      // The engine does not always mark exports; fold what stage 3 found back in.
      const exportSet = new Set(exportNames.map((name) => name.toLowerCase()));
      functions = functions.map((entry) =>
        exportSet.has(entry.name.toLowerCase()) ? { ...entry, isExport: true } : entry,
      );
      ledger.facts.functionCount = functions.length;
      if (result.error) {
        endStage(view, 'failed', 'function list unavailable', result.error);
      } else {
        endStage(
          view,
          'done',
          `${functions.length} functions`,
          result.truncated ? 'function list was truncated at the engine cap' : '',
        );
      }
    }

    // --- 6. Selection ------------------------------------------------------
    let selected: ReturnType<typeof selectFunctionsForDeepRead> = [];
    {
      const view = beginStage('selection');
      selected = selectFunctionsForDeepRead(functions, GHIDRA_DEEP_READ_LIMIT);
      ledger.facts.selectedFunctions = selected;
      endStage(
        view,
        selected.length > 0 ? 'done' : 'skipped',
        selected.length > 0
          ? `${selected.length} of ${functions.length} functions selected for deep read`
          : 'no functions scored high enough to read',
      );
    }

    // --- 7. Deep read ------------------------------------------------------
    {
      const view = beginStage('deepread');
      let budget = GHIDRA_DEEP_READ_TOTAL_CHARS;
      let read_ok = 0;
      let summarized = 0;
      let lastError = '';
      const bodies: { name: string; address: string; decompiled: string; summary: string }[] = [];

      for (let offset = 0; offset < selected.length; offset += GHIDRA_DECOMPILE_BATCH) {
        if (budget <= 0) {
          break;
        }
        const batch = selected.slice(offset, offset + GHIDRA_DECOMPILE_BATCH);
        const names = batch.map((entry) => entry.name || entry.address).filter(Boolean);
        if (names.length === 0) {
          continue;
        }
        const result = await read('decompile', {
          names,
          include_callees: false,
          include_xrefs: true,
        });
        if (result.error) {
          lastError = result.error;
          continue;
        }
        const decompiled = extractDecompiled(result.rows);
        for (const entry of batch) {
          // Re-check INSIDE the batch. Checking only per batch let one long body
          // drive the budget negative, and `slice(0, negative)` counts from the
          // end of the string -- so the cap stopped capping and every later
          // function in the batch stored a body cut from the wrong end.
          if (budget <= 0) {
            break;
          }
          const body = findDecompiledBody(decompiled, entry.name, entry.address);
          if (!body) {
            continue;
          }
          const room = Math.max(0, Math.min(GHIDRA_DECOMPILE_CHARS, budget));
          const capped = body.slice(0, room);
          if (!capped) {
            break;
          }
          budget -= capped.length;
          read_ok += 1;

          let summary = '';
          if (deps.summarizeFunction) {
            try {
              summary = await deps.summarizeFunction({
                name: entry.name,
                address: entry.address,
                decompiled: capped,
                reasons: entry.reasons,
              });
              if (summary) {
                summarized += 1;
              }
            } catch (error) {
              deps.logError?.('ghidra-lab function summary failed', error);
            }
          }

          bodies.push({ name: entry.name, address: entry.address, decompiled: capped, summary });
          anchor(ledger, {
            id: functionAnchorId(entry.address, entry.name),
            kind: 'function',
            address: entry.address,
            symbol: entry.name,
            detail: summary
              ? `${entry.reasons.join('; ')} -- ${summary}`
              : `${entry.reasons.join('; ')} (decompiled, not summarized)`,
            // A model wrote the summary half of this. Marked so the report can
            // separate what was measured from what was inferred.
            deterministic: !summary,
          });
        }
      }
      ledger.facts.deepRead = bodies;
      if (read_ok === 0 && selected.length > 0) {
        endStage(view, 'failed', 'no function could be decompiled', lastError);
      } else {
        endStage(
          view,
          selected.length === 0 ? 'skipped' : 'done',
          `${read_ok} functions decompiled, ${summarized} summarized`,
          lastError ? `some batches failed: ${lastError}` : '',
        );
      }
    }

    // --- 8. Capability map (capa) -----------------------------------------
    {
      const view = beginStage('capability');
      if (!deps.runCapa || !params.config.capaExePath) {
        endStage(
          view,
          'skipped',
          'capa not configured',
          'Configure capa in Setup to get rule-backed ATT&CK/MBC matches instead of model inference.',
        );
      } else {
        try {
          const outcome = await deps.runCapa({
            binaryPath: params.binaryPath,
            config: params.config,
          });
          if (!outcome.ok) {
            endStage(view, 'failed', 'capa did not run', outcome.error);
          } else {
            const matches = extractCapaMatches(outcome.payload);
            ledger.facts.capa = matches;
            for (const match of matches) {
              anchor(ledger, {
                id: capaAnchorId(match.rule),
                kind: 'capa',
                address: match.addresses[0] ?? '',
                symbol: '',
                detail: match.attack.length
                  ? `${match.namespace || 'capa'}: ${match.rule} [${match.attack.join(', ')}]`
                  : `${match.namespace || 'capa'}: ${match.rule}`,
                deterministic: true,
              });
            }
            endStage(view, 'done', `${matches.length} capa rules matched`);
          }
        } catch (error) {
          endStage(
            view,
            'failed',
            'capa failed',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }

    // --- 9. Structure ------------------------------------------------------
    {
      const view = beginStage('structure');
      const indicators = detectAntiAnalysis({
        imports,
        strings,
        sectionNames: extractSectionNames(ledger.facts.metadata),
      });
      ledger.facts.antiAnalysis = indicators;
      // Anchor the rolled-up finding rather than its evidence: evidence here can
      // be a section name or a string, not only an imported symbol, so citing
      // the underlying import would be wrong half the time.
      for (const indicator of indicators) {
        anchor(ledger, {
          id: indicatorAnchorId(indicator.code),
          kind: 'indicator',
          address: '',
          symbol: '',
          detail: indicator.evidence.length
            ? `${indicator.detail} evidence: ${indicator.evidence.join(', ')}`
            : indicator.detail,
          deterministic: true,
        });
      }

      const rootName =
        selected.find((entry) => entry.isEntryPoint)?.name ||
        exportNames[0] ||
        selected[0]?.name ||
        '';
      let callgraph = '';
      let callgraphError = '';
      if (rootName) {
        const result = await read('callgraph', { name: rootName });
        if (result.error) {
          callgraphError = result.error;
        } else {
          callgraph = extractCallgraph(result.rows).slice(0, 20000);
        }
      }
      ledger.facts.callgraph = callgraph;
      ledger.facts.callgraphRoot = rootName;
      if (callgraph) {
        anchor(ledger, {
          id: callgraphAnchorId(rootName),
          kind: 'callgraph',
          address: '',
          symbol: rootName,
          detail: `call graph rooted at ${rootName}`,
          deterministic: true,
        });
      }
      endStage(
        view,
        'done',
        `${indicators.length} anti-analysis indicators${callgraph ? `; call graph from ${rootName}` : ''}`,
        callgraphError,
      );
    }

    // Synthesis is the report writer's stage; the sweep marks it pending and
    // hands the ledger over.
  } catch (error) {
    if (!(error instanceof SweepAborted)) {
      deps.logError?.('ghidra-lab sweep failed', error);
      throw error;
    }
    for (const view of ledger.stages) {
      if (view.state === 'pending' || view.state === 'running') {
        view.state = 'skipped';
        view.detail = 'cancelled';
      }
    }
  }

  return ledger;
}

export interface GhidraCapaMatch {
  rule: string;
  namespace: string;
  attack: string[];
  mbc: string[];
  addresses: string[];
}

/**
 * Pull rule matches out of capa's JSON.
 *
 * capa's document format nests matches under `rules` keyed by rule name, with
 * meta carrying the ATT&CK/MBC mapping. Written forgivingly because the document
 * version has changed before and a report that quotes rule names is still useful
 * even if the address extraction misses.
 */
export function extractCapaMatches(payload: unknown): GhidraCapaMatch[] {
  const root = asRecord(payload);
  if (!root) {
    return [];
  }
  const rules = asRecord(root.rules);
  if (!rules) {
    return [];
  }
  const matches: GhidraCapaMatch[] = [];
  for (const [ruleName, rawRule] of Object.entries(rules)) {
    const rule = asRecord(rawRule);
    if (!rule) {
      continue;
    }
    const meta = asRecord(rule.meta) ?? {};
    const namespace = pickString(meta, ['namespace']);
    const attack: string[] = [];
    for (const entry of Array.isArray(meta.attack) ? meta.attack : []) {
      const record = asRecord(entry);
      if (record) {
        const id = pickString(record, ['id']);
        const technique = pickString(record, ['technique', 'tactic']);
        attack.push([technique, id].filter(Boolean).join(' '));
      } else if (typeof entry === 'string') {
        attack.push(entry);
      }
    }
    const mbc: string[] = [];
    for (const entry of Array.isArray(meta.mbc) ? meta.mbc : []) {
      const record = asRecord(entry);
      if (record) {
        mbc.push(
          [pickString(record, ['behavior', 'objective']), pickString(record, ['id'])]
            .filter(Boolean)
            .join(' '),
        );
      } else if (typeof entry === 'string') {
        mbc.push(entry);
      }
    }
    const addresses: string[] = [];
    const matchList = Array.isArray(rule.matches) ? rule.matches : [];
    for (const entry of matchList.slice(0, 8)) {
      if (Array.isArray(entry) && entry.length > 0) {
        const address = asRecord(entry[0]);
        const value = address ? pickString(address, ['value', 'address']) : '';
        if (value) {
          addresses.push(
            typeof value === 'string' && value.startsWith('0x')
              ? value
              : `0x${Number(value).toString(16)}`,
          );
        }
      }
    }
    matches.push({ rule: ruleName, namespace, attack, mbc, addresses });
  }
  return matches;
}

/**
 * Pull the Mermaid source out of a call-graph answer.
 *
 * The engine answers with an object -- `{function_name, direction, graph,
 * mermaid_url}` -- and the diagram is the `graph` field. Stringifying the whole
 * row put raw JSON inside the report's ```mermaid fence, which renders as
 * nothing. Observed in a real report.
 */
export function extractCallgraph(rows: readonly unknown[]): string {
  const parts: string[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      parts.push(row);
      continue;
    }
    const record = asRecord(row);
    if (!record) {
      continue;
    }
    const graph = pickString(record, ['graph', 'mermaid', 'diagram', 'flowchart', 'text']);
    if (graph) {
      parts.push(graph);
      continue;
    }
    // Nothing that looks like a diagram: keep the row rather than lose it, but
    // it must not end up inside the fence, so the caller gets plain JSON only
    // when there was no diagram at all.
    try {
      parts.push(JSON.stringify(record));
    } catch {
      // Unserializable; skip.
    }
  }
  return parts.join('\n').trim();
}

/** Does this text look like a Mermaid diagram rather than a JSON dump? */
export function looksLikeMermaid(value: string): boolean {
  return /^\s*(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram)\b/m.test(value);
}

/** Section names out of whatever the metadata stage collected, when present. */
export function extractSectionNames(metadata: unknown): string[] {
  const names: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || !value) {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry, depth + 1);
      }
      return;
    }
    const record = asRecord(value);
    if (!record) {
      return;
    }
    const sections = record.sections ?? record.memory_blocks ?? record.blocks;
    if (Array.isArray(sections)) {
      for (const section of sections) {
        const child = asRecord(section);
        const name = child
          ? pickString(child, ['name', 'section', 'block'])
          : typeof section === 'string'
            ? section
            : '';
        if (name) {
          names.push(name);
        }
      }
    }
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === 'object') {
        visit(nested, depth + 1);
      }
    }
  };
  visit(metadata, 0);
  return [...new Set(names)];
}

/** Node implementation of the identity hash. */
export function hashFileSync(path: string): { sha256: string; sizeBytes: number; mtimeMs: number } {
  const stat = fs.statSync(path);
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(path));
  return { sha256: hash.digest('hex'), sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
}
