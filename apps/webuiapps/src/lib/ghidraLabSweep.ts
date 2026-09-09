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
  buildCallGraphFromBodies,
  mermaidFromCallGraph,
  selectFrontier,
  synthesizeBehavior,
  summarizeReachableCategories,
  type GhidraCallNode,
} from './ghidraBehavior';
import { findDynamicApis } from './ghidraDynamicApi';
import {
  countByKind,
  parseFlossResult,
  selectInterestingDecoded,
  type GhidraDecodedString,
  type GhidraFlossOutcome,
} from './ghidraFloss';
import { detectObfuscation } from './ghidraObfuscation';
import {
  GHIDRA_SWEEP_STAGES,
  behaviorAnchorId,
  callgraphAnchorId,
  capaAnchorId,
  decodedAnchorId,
  dynApiAnchorId,
  obfuscationAnchorId,
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

/**
 * How many functions the deep read may spend tokens on.
 *
 * Raised from 40 after a real run read 18 of 128 and used 13.8% of the
 * character budget: neither this nor the budget was binding, the scorer simply
 * had nothing left to offer. It is the CHARACTER budget below that is the real
 * cost control -- this is only there to stop an enormous image from queueing
 * thousands of calls.
 */
export const GHIDRA_DEEP_READ_LIMIT = 160;
/** Per-function decompiled body kept in the ledger. */
export const GHIDRA_DECOMPILE_CHARS = 6000;
/**
 * Total decompiled text the whole sweep may accumulate.
 *
 * Sized against measurement rather than a guess: bodies averaged 919 characters
 * on a real 32-bit PE, so the limit above fits comfortably. A binary of large
 * functions still stops here, which is the point -- the cap is on what is read,
 * not on how many were asked for.
 */
export const GHIDRA_DEEP_READ_TOTAL_CHARS = 320000;
/** Functions per decompile call -- the engine's batch form is why this is not 1. */
export const GHIDRA_DECOMPILE_BATCH = 8;

/** How long the strings stage will wait for the engine's background index. */
export const STRING_INDEX_WAIT_MS = 60_000;
const STRING_INDEX_POLL_MS = 5_000;

const MAX_IMPORT_ANCHORS = 120;
const MAX_STRING_ANCHORS = 80;
/**
 * Caps for the deep-analysis stages.
 *
 * Recovered strings get the largest budget on purpose: on an obfuscated binary
 * they carry the URLs, paths and API names that every other section wants to
 * cite, so starving them starves the report.
 */
const MAX_DECODED_ANCHORS = 160;
const MAX_DYNAPI_ANCHORS = 120;
const MAX_OBFUSCATION_ANCHORS = 40;
const MAX_BEHAVIOR_ANCHORS = 24;
/**
 * How much of the deep-read budget is held back to follow the entry path.
 *
 * Scoring alone never finds that path: CRT startup functions are small, have one
 * xref and call nothing interesting, so they never place and the chain out of
 * `entry` stays unread. Measured on a real PE -- 28 of 128 bodies read and not
 * one of them connected the entry point to anything.
 *
 * The reserve is spent expanding outward from what has already been read, one
 * hop per round, so the path is discovered as it is followed.
 */
const DEEP_READ_PATH_RESERVE = 0.4;
const DEEP_READ_EXPAND_ROUNDS = 4;
/** Entry points and exports always read, however they scored. */
const MAX_ROOT_SEED = 8;
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
  /**
   * Absent -> the recovered-strings stage is skipped, not failed.
   *
   * Skipping it is a real loss on an obfuscated target -- the strings that were
   * hidden are usually the ones worth reading -- so the stage detail says so
   * rather than passing over it silently.
   */
  runFloss?(params: {
    binaryPath: string;
    config: GhidraLabConfigView;
  }): Promise<GhidraFlossOutcome>;
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

/**
 * Field names carrying a reference count.
 *
 * `refcount` is what pyghidra-mcp sends, and its absence from this list meant
 * the reference weight never once fired on a real binary: every function was
 * scored on its name alone, so a 12-reference worker and a 1-reference stub
 * ranked identically and the alphabetical tie-break decided what got read.
 */
const XREF_FIELDS = ['refcount', 'xref_count', 'xrefs', 'references', 'reference_count'];

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
      ...(pickNumber(record, XREF_FIELDS) !== undefined
        ? { xrefCount: pickNumber(record, XREF_FIELDS) }
        : {}),
      ...(callsImports && callsImports.length ? { callsImports } : {}),
      ...(record.is_entry === true || record.entry === true ? { isEntryPoint: true } : {}),
      ...(record.is_export === true || record.exported === true ? { isExport: true } : {}),
      ...(record.is_thunk === true || record.thunk === true ? { isThunk: true } : {}),
      ...(record.external === true || record.is_external === true ? { isExternal: true } : {}),
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
  const direct = (address ? bodies.get(address) : '') || bodies.get(name);
  if (direct) {
    return direct;
  }
  const wantedName = name.toLowerCase();
  // Addresses come back with and without a leading 0x depending on the field.
  const wantedAddress = address.toLowerCase().replace(/^0x/, '');
  // The address is checked first, and in a pass of its own, because a name is
  // not unique. A real PE had 36 of its 128 functions sharing a name with a
  // function at another address -- `strcmp`, `_atexit`, `initterm`: a thunk and
  // the body it jumps to. Matching on the name handed both the same body.
  if (wantedAddress) {
    for (const [key, body] of bodies) {
      if (key.toLowerCase().includes(wantedAddress)) {
        return body;
      }
    }
  }
  for (const [key, body] of bodies) {
    const lowered = key.toLowerCase();
    if (wantedName && (lowered === wantedName || lowered.startsWith(`${wantedName}-`))) {
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
  // Deduplicate here rather than at every call site.
  //
  // buildAnchorIndex already collapses ids and keeps the first, so a duplicate
  // pushed onto this array made ledger.anchors.length (which becomes the run's
  // anchorCount in the UI and the manifest) larger than the number of anchors a
  // report can actually cite -- two counts of the same thing, free to disagree.
  // The imports stage carried its own guard for exactly this; the rest did not.
  const existing = ledger.anchors.find((candidate) => candidate.id === full.id);
  if (existing) {
    return existing;
  }
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

    // --- 5. Recovered strings (FLOSS) --------------------------------------
    //
    // The strings that are not in the binary as text. On an obfuscated target
    // this is where the URLs, the registry paths and the API names live, and a
    // report built from the static string list alone would describe a program
    // with nothing to say.
    let decoded: GhidraDecodedString[] = [];
    {
      const view = beginStage('decodedstrings');
      if (!deps.runFloss || !params.config.flossExePath) {
        endStage(
          view,
          'skipped',
          'FLOSS not configured',
          'Stack strings, tight strings and strings decoded at run time were NOT recovered. On an obfuscated binary these are usually the interesting ones -- configure FLOSS in Setup.',
        );
      } else {
        try {
          const outcome = await deps.runFloss({
            binaryPath: params.binaryPath,
            config: params.config,
          });
          if (!outcome.ok) {
            endStage(view, 'failed', 'FLOSS did not produce a result', outcome.error);
          } else {
            decoded = selectInterestingDecoded(parseFlossResult(outcome.payload));
            ledger.facts.decodedStrings = decoded;
            const counts = countByKind(decoded);
            for (const entry of decoded.slice(0, MAX_DECODED_ANCHORS)) {
              anchor(ledger, {
                id: decodedAnchorId(entry.decodingRoutine, entry.value),
                kind: 'decoded',
                address: entry.address,
                symbol: entry.decodingRoutine,
                detail: `${entry.kind} string${entry.decodingRoutine ? ` decoded by ${entry.decodingRoutine}` : ''}: ${entry.value}`,
                deterministic: true,
              });
            }
            endStage(
              view,
              'done',
              `${decoded.length} hidden strings recovered (decoded ${counts.decoded}, tight ${counts.tight}, stack ${counts.stack})`,
              decoded.length === 0
                ? 'FLOSS ran and found none, which is itself a finding: this binary does not hide its strings.'
                : '',
            );
          }
        } catch (error) {
          endStage(
            view,
            'failed',
            'FLOSS failed',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }

    // --- 6. Function inventory --------------------------------------------
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
      // The scored seed only. The rest of the budget is spent following the
      // call path out of the entry point, which cannot be scored for because it
      // is not visible until something has been read.
      //
      // ...unless the whole image fits, in which case there is nothing to hold
      // slots back from and holding them back just leaves functions unread: a
      // 128-function binary was stopping at 100 with four fifths of the
      // character budget untouched.
      const fitsEntirely = functions.length <= GHIDRA_DEEP_READ_LIMIT;
      const seedLimit = fitsEntirely
        ? GHIDRA_DEEP_READ_LIMIT
        : Math.max(1, Math.round(GHIDRA_DEEP_READ_LIMIT * (1 - DEEP_READ_PATH_RESERVE)));
      const scoredSeed = selectFunctionsForDeepRead(functions, seedLimit);
      // The entry point and the exports go in whatever they score.
      //
      // They are the roots of every path, and scoring can push them out: a
      // handful of large, heavily-referenced functions elsewhere in the image
      // outrank a 32-byte startup stub, and then there is nothing to expand
      // from and the whole path-following reserve is wasted.
      const rootFns = selectFunctionsForDeepRead(
        functions.filter((entry) => entry.isEntryPoint || entry.isExport),
        MAX_ROOT_SEED,
      );
      const seen = new Set<string>();
      selected = [...rootFns, ...scoredSeed]
        .filter((entry) => {
          // Keyed on the address. Keyed on the name, 36 of this binary's 128
          // functions collapsed into 18 -- a thunk and the function it jumps to
          // share a symbol -- and the seed quietly shrank by that much.
          const key = (entry.address || entry.name).toLowerCase();
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        })
        .slice(0, seedLimit);
      ledger.facts.selectedFunctions = selected;
      endStage(
        view,
        selected.length > 0 ? 'done' : 'skipped',
        selected.length > 0
          ? `${selected.length} of ${functions.length} functions seeded for deep read${
              fitsEntirely
                ? ' (every function in the image fits the budget)'
                : `, ${GHIDRA_DEEP_READ_LIMIT - seedLimit} slots held for the entry path`
            }`
          : 'no functions scored high enough to read',
      );
    }

    // --- 7. Deep read ------------------------------------------------------
    //
    // Declared out here because the dynamic-API, obfuscation and behaviour
    // stages all read these bodies. They are the single most expensive thing
    // the sweep produces and re-fetching them per stage would triple the cost.
    const deepReadBodies: {
      name: string;
      address: string;
      decompiled: string;
      summary: string;
    }[] = [];
    {
      const view = beginStage('deepread');
      let budget = GHIDRA_DEEP_READ_TOTAL_CHARS;
      let read_ok = 0;
      let summarized = 0;
      let missing = 0;
      let lastError = '';
      const bodies: { name: string; address: string; decompiled: string; summary: string }[] =
        deepReadBodies;

      /** Every function whose body is in hand, by name and by address. */
      const readKeys = new Set<string>();
      let pathFollowed = 0;
      let expandRounds = 0;
      let frontierFromEntry = false;

      /**
       * Read a queue of functions, then retry whatever came back empty.
       *
       * The engine resolves a function by `name_or_address`, and BOTH keys are
       * ambiguous on a real binary, in opposite cases:
       *
       *   - By name: two functions can share one. `strcmp` is the body and the
       *     thunk that jumps to it, and the answer is
       *     `Function or symbol 'strcmp' not found.`
       *   - By address: one address can carry a demangled name and a mangled
       *     symbol. 00413890 is both `GetPdbDll` and
       *     `?GetPdbDll@@YAPAUHINSTANCE__@@XZ`, and the answer is
       *     `Ambiguous match for '00413890'.`
       *
       * So the address goes first, because a duplicated name cannot be resolved
       * at all, and anything it fails on is asked for again by name. Each key
       * covers the other's blind spot; only a function that fails both is
       * genuinely unreadable, and only that is counted as missing.
       */
      const readBatchesOf = async (
        queue: readonly ReturnType<typeof selectFunctionsForDeepRead>[number][],
        byName = false,
      ): Promise<void> => {
        const unresolved: ReturnType<typeof selectFunctionsForDeepRead>[number][] = [];
        for (let offset = 0; offset < queue.length; offset += GHIDRA_DECOMPILE_BATCH) {
          if (budget <= 0) {
            break;
          }
          const batch = queue.slice(offset, offset + GHIDRA_DECOMPILE_BATCH);
          const names = batch
            .map((entry) => (byName ? entry.name || entry.address : entry.address || entry.name))
            .filter(Boolean);
          if (names.length === 0) {
            continue;
          }
          const result = await read('decompile', {
            names,
            include_callees: false,
            // Off, because asking for xrefs sends the engine down a symbol-table
            // lookup that cannot separate a demangled name from the mangled
            // symbol at the same address -- 13 of 96 requested bodies came back
            // as `Ambiguous match`, among them every named function this binary
            // is interesting for. The same addresses resolve cleanly with this
            // false, and nothing here ever read the xrefs it returned.
            include_xrefs: false,
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
              // Held for the retry pass rather than written off. Dropping these
              // silently hid a real failure: on one run 13 selected functions
              // produced nothing and the stage still reported itself done.
              unresolved.push(entry);
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
            readKeys.add(entry.name.toLowerCase());
            readKeys.add(entry.address.toLowerCase());
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

        if (byName) {
          missing += unresolved.length;
          return;
        }
        const retry = unresolved.filter(
          (entry) => entry.name && entry.address && entry.name !== entry.address,
        );
        // Nothing else to try for these: the two keys are the same string.
        missing += unresolved.length - retry.length;
        if (retry.length > 0 && budget > 0) {
          await readBatchesOf(retry, true);
        }
      };

      await readBatchesOf(selected);

      // Follow the path out of the entry point, one hop per round.
      //
      // Each round rebuilds the graph from what is in hand, takes the unread
      // functions its read callers name, nearest to the entry first, and reads
      // them. That is how the chain out of `entry` gets read at all: it is only
      // visible one hop at a time.
      const byName = new Map<string, (typeof functions)[number]>();
      for (const entry of functions) {
        // Address wins, and the name is only a fallback key, so a duplicated
        // symbol resolves to one real function instead of whichever of the two
        // the engine happened to list last.
        if (entry.address) {
          byName.set(entry.address.toLowerCase(), entry);
        }
        if (entry.name && !byName.has(entry.name.toLowerCase())) {
          byName.set(entry.name.toLowerCase(), entry);
        }
      }
      for (let round = 0; round < DEEP_READ_EXPAND_ROUNDS; round += 1) {
        // Cancellation is checked at the next beginStage, as everywhere else.
        const room = GHIDRA_DEEP_READ_LIMIT - bodies.length;
        if (budget <= 0 || room <= 0) {
          break;
        }
        const graph = buildCallGraphFromBodies({
          functions: functions.map((entry) => ({
            name: entry.name,
            address: entry.address,
            ...(entry.isEntryPoint === undefined ? {} : { isEntryPoint: entry.isEntryPoint }),
            ...(entry.isExport === undefined ? {} : { isExport: entry.isExport }),
          })),
          bodies,
          knownApis: imports.map((entry) => entry.symbol),
        });
        const frontier = selectFrontier({ nodes: graph.nodes, read: readKeys, limit: room });
        if (frontier.names.length === 0) {
          break;
        }
        frontierFromEntry = frontierFromEntry || frontier.fromEntry;
        expandRounds += 1;
        const next = frontier.names
          .map((name) => byName.get(name.toLowerCase()))
          .filter((entry): entry is (typeof functions)[number] => Boolean(entry))
          .map((entry) => ({
            ...entry,
            score: 0,
            reasons: [
              frontier.fromEntry
                ? 'on a call path from the entry point'
                : 'called by a function that was read',
            ],
          }));
        const before = bodies.length;
        await readBatchesOf(next);
        pathFollowed += bodies.length - before;
        if (bodies.length === before) {
          break;
        }
      }

      ledger.facts.deepRead = bodies;
      if (read_ok === 0 && selected.length > 0) {
        endStage(view, 'failed', 'no function could be decompiled', lastError);
      } else {
        endStage(
          view,
          selected.length === 0 ? 'skipped' : 'done',
          `${read_ok} functions decompiled (${pathFollowed} by following ${
            frontierFromEntry ? 'the entry path' : 'callers that were read'
          } over ${expandRounds} rounds), ${summarized} summarized${
            missing > 0 ? `, ${missing} returned no body` : ''
          }`,
          lastError ? `some batches failed: ${lastError}` : '',
        );
      }
    }

    // --- 9. Dynamically resolved APIs --------------------------------------
    // (deepReadBodies is filled by the deep read above and read by the three
    // stages below; it is declared before them so they share one list.)
    //
    // The import table of an obfuscated binary lists LoadLibrary,
    // GetProcAddress and little else. Everything the program actually calls is
    // resolved at run time, and a report that stops at the import table
    // describes a binary that does nothing.
    let dynamicApis: string[] = [];
    {
      const view = beginStage('dynapi');
      const found = findDynamicApis({
        bodies: deepReadBodies,
        imports: imports.map((entry) => ({ symbol: entry.symbol, library: entry.library })),
        recovered: decoded,
      });
      ledger.facts.dynamicApis = found;
      dynamicApis = found.resolved.map((entry) => entry.symbol).filter(Boolean);
      for (const entry of found.resolved.slice(0, MAX_DYNAPI_ANCHORS)) {
        if (!entry.symbol) {
          continue;
        }
        anchor(ledger, {
          id: dynApiAnchorId(entry.symbol),
          kind: 'dynapi',
          address: entry.address,
          symbol: entry.symbol,
          detail: `resolved at run time in ${entry.functionName || entry.address} (evidence: ${entry.evidence.replace(/_/g, ' ')})`,
          deterministic: entry.evidence !== 'recovered_string',
        });
      }
      for (const entry of found.hashing) {
        anchor(ledger, {
          id: dynApiAnchorId(entry.code),
          kind: 'dynapi',
          address: '',
          symbol: entry.code,
          detail: `${entry.detail} Evidence: ${entry.evidence.join('; ')}`,
          deterministic: true,
        });
      }
      const parts = [
        `${found.resolved.filter((entry) => entry.symbol).length} APIs resolved at run time`,
        found.resolverSites.length > 0 ? `${found.resolverSites.length} resolver sites` : '',
        found.hashing.length > 0 ? `${found.hashing.length} hashing indicators` : '',
      ].filter(Boolean);
      endStage(
        view,
        deepReadBodies.length === 0 ? 'skipped' : 'done',
        deepReadBodies.length === 0 ? 'no decompiled bodies to scan' : parts.join(', '),
        deepReadBodies.length === 0
          ? 'Dynamic resolution is read out of decompiled code, so this needs the deep read to have produced something.'
          : '',
      );
    }

    // The call graph, read out of the bodies rather than asked for.
    //
    // The engine's function listing carries no callees and no API references,
    // and `gen_callgraph` answered a real PE with its root node and no edges --
    // so reachability had nothing to walk and reported zero on a binary whose
    // bodies name every call it makes. Derived here, once, because the
    // structure stage draws it and the behaviour stage walks it.
    const knownApis = [...new Set([...imports.map((entry) => entry.symbol), ...dynamicApis])];
    const callGraph = buildCallGraphFromBodies({
      functions: functions.map((entry) => ({
        name: entry.name,
        address: entry.address,
        ...(entry.callsImports ? { callsImports: entry.callsImports } : {}),
        ...(entry.isEntryPoint === undefined ? {} : { isEntryPoint: entry.isEntryPoint }),
        ...(entry.isExport === undefined ? {} : { isExport: entry.isExport }),
      })),
      bodies: deepReadBodies,
      knownApis,
    });

    // --- 10. Capability map (capa) ----------------------------------------
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

    // --- 11. Obfuscation ----------------------------------------------------
    //
    // Found and located, not undone. Automatic unflattening is a research
    // problem and this says so; what it does deliver is WHICH functions are
    // obfuscated and with what, which is most of the analyst's search.
    {
      const view = beginStage('obfuscation');
      const findings = detectObfuscation({
        bodies: deepReadBodies,
        sectionNames: extractSectionNames(ledger.facts.metadata),
      });
      ledger.facts.obfuscation = findings;
      for (const finding of findings.slice(0, MAX_OBFUSCATION_ANCHORS)) {
        anchor(ledger, {
          id: obfuscationAnchorId(finding.code, finding.address || finding.functionName),
          kind: 'obfuscation',
          address: finding.address,
          symbol: finding.functionName,
          detail: `${finding.confidence} -- ${finding.detail} Remedy: ${finding.remedy}`,
          deterministic: true,
        });
      }
      const strong = findings.filter((finding) => finding.confidence === 'strong').length;
      endStage(
        view,
        'done',
        findings.length === 0
          ? 'no obfuscation constructs found in what was read'
          : `${findings.length} findings (${strong} strong)`,
        deepReadBodies.length === 0
          ? 'Only whole-image checks ran: no decompiled bodies were available to scan.'
          : '',
      );
    }

    // --- 12. Structure ------------------------------------------------------
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
          // A diagram with no edges is a picture of one box. Draw the edges the
          // bodies actually contain instead -- measured: the engine returned
          // `flowchart TD / classDef / entry` and nothing else.
          if (!/-->/.test(callgraph)) {
            const derived = mermaidFromCallGraph(callGraph.nodes);
            if (derived) {
              callgraph = derived;
              callgraphError =
                callgraphError || 'engine returned no edges; drawn from decompiled bodies';
            }
          }
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

    // --- 13. Behaviour ------------------------------------------------------
    //
    // Reachability and ordering, never a claim that the binary was observed
    // doing anything. Static analysis cannot say "it ran"; it can say which
    // APIs a named entry can get to, in what order one function calls them, and
    // which known chain that ordering matches.
    {
      const view = beginStage('behavior');
      const nodes: GhidraCallNode[] = callGraph.nodes;
      const behavior = synthesizeBehavior({
        nodes,
        bodies: deepReadBodies,
        knownApis,
      });
      ledger.facts.behavior = behavior;
      ledger.facts.reachableCategories = summarizeReachableCategories(behavior.reachable);
      for (const chain of behavior.chains.slice(0, MAX_BEHAVIOR_ANCHORS)) {
        anchor(ledger, {
          id: behaviorAnchorId(chain.code),
          kind: 'behavior',
          address: chain.address,
          symbol: chain.functionName,
          detail: `${chain.title} (${chain.confidence}): ${chain.detail} APIs in order: ${chain.apis.join(' -> ')}${chain.functionName ? `, in ${chain.functionName}` : ''}.`,
          deterministic: true,
        });
      }
      const parts = [
        `${behavior.chains.length} behaviour chains`,
        behavior.rootedAtEntry
          ? `${behavior.reachable.length} APIs reachable from ${behavior.entries.length || 0} entries`
          : `${behavior.reachable.length} APIs called by ${behavior.entries.length} read functions (no path from the entry point could be resolved)`,
        `${callGraph.edgeCount} call edges from ${callGraph.bodiesRead} bodies`,
      ];
      endStage(
        view,
        'done',
        parts.join(', '),
        // Coverage, not an excuse: the graph is only as complete as the deep
        // read, and a reader needs to know that before trusting a zero.
        behavior.graphMissing
          ? 'No call edges were recovered, so reachability was computed from each function in isolation rather than by walking the graph.'
          : `The graph covers the ${callGraph.bodiesRead} functions that were decompiled, out of ${functions.length} in the image, so an API only reachable through an unread function is not counted.`,
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
          // capa writes the address as a decimal number; anything else is kept
          // verbatim rather than pushed through Number(), which turned an
          // unexpected form into the literal string "0xNaN" in the report.
          const numeric = Number(value);
          addresses.push(
            value.startsWith('0x') || !Number.isFinite(numeric)
              ? value
              : `0x${numeric.toString(16)}`,
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
