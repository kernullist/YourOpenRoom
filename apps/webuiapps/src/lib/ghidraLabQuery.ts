// Ghidra Lab query policy: map a sub-command onto exactly one MCP tool call, and
// decide what may be forwarded to it.
//
// Why a mapping table instead of exposing the MCP surface directly: pyghidra-mcp
// publishes dozens of tools and some competing servers publish 200+. Handing that
// to the model costs tokens on every turn and, worse, hands it `read_bytes`,
// `delete_project_binary` and the whole set of database mutators. So Aoi gets ten
// READ sub-commands, each pinned to one tool, with an allowlist of arguments.
// Anything not on the list is dropped before the call rather than passed through.
//
// This file is the one place that knows the engine's tool names. They are not
// fully stable across pyghidra-mcp versions, so each entry carries aliases and
// the session resolves against the tools the live server actually advertises --
// the same "ask the engine, do not assume" posture idaSqlSession takes with its
// function review. An unresolvable sub-command produces a refusal that names the
// tools the server does expose, which is what a model needs to recover.
//
// Browser-safe: no node builtins (the app pre-validates a query as you type).
import { isGhidraQueryKind, type GhidraQueryKind } from './ghidraLabTypes';

export interface GhidraQuerySpec {
  kind: GhidraQueryKind;
  /** Preferred MCP tool name. */
  tool: string;
  /** Other names the same capability has shipped under. Tried in order. */
  aliases: readonly string[];
  /** Argument keys forwarded to the engine. Everything else is dropped. */
  allowedArgs: readonly string[];
  /** Keys without which the call is refused before it is made. */
  requiredArgs: readonly string[];
  /**
   * Caller vocabulary -> engine argument name.
   *
   * The engine does not use one word for one idea: a function target is
   * `name_or_address` for decompile and xrefs but `function_name` for the call
   * graph. Callers (the sweep, Aoi, the app) all say `name`, and the translation
   * happens here so there is one place to fix when the engine renames something.
   */
  argMap?: Readonly<Record<string, string>>;
  /**
   * Arguments the engine REQUIRES but that have an obvious "everything" value.
   *
   * `search_strings` and `search_symbols_by_name` both demand a `query`; asking
   * for all strings is a legitimate thing to want, so the default is the
   * match-all pattern rather than a refusal.
   */
  defaults?: Readonly<Record<string, unknown>>;
  /** One line for the tool description Aoi reads. */
  summary: string;
}

// Argument names and requirements below were read off a live pyghidra-mcp 0.2.5
// (`mcp_tools.py`), not from its README. Several differ from the documented
// shape: `binary_name` is required everywhere except list_project_binaries,
// function targets are `name_or_address` (or `function_name` for the call
// graph), and both string and symbol search require a `query`.
export const GHIDRA_QUERY_SPECS: readonly GhidraQuerySpec[] = [
  {
    kind: 'metadata',
    tool: 'list_project_binary_metadata',
    aliases: ['list_project_binaries'],
    allowedArgs: ['binary_name'],
    requiredArgs: [],
    summary: 'Format, architecture, compiler and analysis state for a binary in the project.',
  },
  {
    kind: 'functions',
    tool: 'search_symbols_by_name',
    aliases: ['list_functions', 'search_functions'],
    allowedArgs: ['binary_name', 'query', 'functions_only', 'offset', 'limit'],
    requiredArgs: [],
    argMap: { name: 'query', pattern: 'query', regex: 'query' },
    defaults: { query: '.*', functions_only: true },
    summary: 'Function symbols, optionally filtered by a name pattern.',
  },
  {
    kind: 'imports',
    tool: 'list_imports',
    aliases: ['imports'],
    allowedArgs: ['binary_name', 'query', 'offset', 'limit'],
    requiredArgs: [],
    argMap: { name: 'query', pattern: 'query', regex: 'query' },
    defaults: { query: '.*' },
    summary: 'Imported symbols, optionally filtered by a pattern.',
  },
  {
    kind: 'exports',
    tool: 'list_exports',
    aliases: ['exports'],
    allowedArgs: ['binary_name', 'query', 'offset', 'limit'],
    requiredArgs: [],
    argMap: { name: 'query', pattern: 'query', regex: 'query' },
    defaults: { query: '.*' },
    summary: 'Exported entry points, optionally filtered by a pattern.',
  },
  {
    kind: 'strings',
    tool: 'search_strings',
    aliases: ['list_strings'],
    allowedArgs: ['binary_name', 'query', 'limit'],
    requiredArgs: [],
    argMap: { name: 'query', pattern: 'query', regex: 'query' },
    // SUBSTRING, not regex -- unlike every other search here. Read from the
    // shipped tools.py: `if query_lower in s.value.lower()`. The regex-looking
    // '.*' that works for imports and symbols matches nothing at all here, so a
    // binary with 132 strings reported zero. Empty string matches everything.
    defaults: { query: '' },
    summary: 'Defined strings, filtered by a substring (empty matches all).',
  },
  {
    kind: 'symbols',
    tool: 'search_symbols_by_name',
    aliases: ['search_symbols'],
    allowedArgs: ['binary_name', 'query', 'functions_only', 'offset', 'limit'],
    requiredArgs: [],
    argMap: { name: 'query', pattern: 'query', regex: 'query' },
    defaults: { query: '.*' },
    summary: 'Any symbol by name or regex.',
  },
  {
    kind: 'xrefs',
    tool: 'list_xrefs',
    aliases: ['xrefs_to', 'get_xrefs'],
    allowedArgs: ['binary_name', 'name_or_address'],
    requiredArgs: ['name_or_address'],
    argMap: {
      name: 'name_or_address',
      names: 'name_or_address',
      symbol: 'name_or_address',
      symbols: 'name_or_address',
      address: 'name_or_address',
      addresses: 'name_or_address',
    },
    summary: 'Cross-references to one or more symbols or addresses (batch-capable).',
  },
  {
    kind: 'decompile',
    tool: 'decompile_function',
    aliases: ['decompile'],
    allowedArgs: [
      'binary_name',
      'name_or_address',
      'include_callees',
      'include_strings',
      'include_xrefs',
      'timeout_sec',
    ],
    requiredArgs: ['name_or_address'],
    argMap: {
      name: 'name_or_address',
      names: 'name_or_address',
      symbol: 'name_or_address',
      symbols: 'name_or_address',
      address: 'name_or_address',
      addresses: 'name_or_address',
    },
    summary: 'Decompiled pseudo-C for one or more functions, optionally with callees and xrefs.',
  },
  {
    kind: 'callgraph',
    tool: 'gen_callgraph',
    aliases: ['generate_callgraph', 'callgraph'],
    allowedArgs: ['binary_name', 'function_name', 'direction', 'display_type'],
    requiredArgs: ['function_name'],
    argMap: { name: 'function_name', symbol: 'function_name', address: 'function_name' },
    summary: 'MermaidJS call graph rooted at a function.',
  },
  {
    kind: 'search',
    tool: 'search_code',
    aliases: ['search_pseudo_c', 'semantic_search'],
    allowedArgs: ['binary_name', 'query', 'limit', 'offset', 'search_mode'],
    requiredArgs: ['query'],
    argMap: { name: 'query', pattern: 'query', regex: 'query' },
    summary: 'Semantic or literal search across the decompiled pseudo-C of the project.',
  },
];

const SPEC_BY_KIND = new Map<GhidraQueryKind, GhidraQuerySpec>(
  GHIDRA_QUERY_SPECS.map((spec) => [spec.kind, spec]),
);

export function findGhidraQuerySpec(kind: unknown): GhidraQuerySpec | null {
  if (!isGhidraQueryKind(kind)) {
    return null;
  }
  return SPEC_BY_KIND.get(kind) ?? null;
}

/** Per-call result bounds. A sweep of a 30k-function binary must not be able to
 *  put an unbounded engine answer into the model's history. */
export const GHIDRA_QUERY_MAX_ROWS = 200;
export const GHIDRA_QUERY_MAX_ROW_CHARS = 6000;
export const GHIDRA_QUERY_MAX_TOTAL_CHARS = 60000;

export interface GhidraQueryPlan {
  ok: boolean;
  kind: GhidraQueryKind | null;
  /** The preferred tool name; the session resolves aliases against the live server. */
  tool: string;
  candidates: string[];
  args: Record<string, unknown>;
  /** Argument keys that were dropped, so a refusal can explain itself. */
  droppedArgs: string[];
  reason: string;
}

function isScalarOrArray(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every(
      (entry) =>
        typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean',
    );
  }
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Turn a requested sub-command into a concrete, bounded MCP call.
 *
 * Unknown sub-commands are refused rather than passed through: the whole point
 * of the narrow surface is that `ghidra_query` cannot become a general MCP
 * gateway by someone inventing a `kind`.
 */
export function planGhidraQuery(kind: unknown, rawArgs: unknown): GhidraQueryPlan {
  const spec = findGhidraQuerySpec(kind);
  if (!spec) {
    return {
      ok: false,
      kind: null,
      tool: '',
      candidates: [],
      args: {},
      droppedArgs: [],
      reason: `unknown_query_kind: use one of ${GHIDRA_QUERY_SPECS.map((entry) => entry.kind).join(', ')}`,
    };
  }

  const args: Record<string, unknown> = {};
  const droppedArgs: string[] = [];
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    for (const [rawKey, value] of Object.entries(rawArgs as Record<string, unknown>)) {
      if (value === undefined || value === null) {
        continue;
      }
      // Translate the caller's word into the engine's before checking anything:
      // the allowlist is expressed in engine terms.
      const key = spec.argMap?.[rawKey] ?? rawKey;
      if (!spec.allowedArgs.includes(key)) {
        droppedArgs.push(rawKey);
        continue;
      }
      if (!isScalarOrArray(value)) {
        // Nested objects are how a caller would try to smuggle structure into an
        // engine argument. Drop rather than serialize.
        droppedArgs.push(rawKey);
        continue;
      }
      // First writer wins, so an explicit engine-named argument is not clobbered
      // by an aliased one later in the object.
      if (args[key] === undefined) {
        args[key] = value;
      }
    }
  }

  // Fill what the engine demands but the caller had no reason to say.
  for (const [key, value] of Object.entries(spec.defaults ?? {})) {
    if (args[key] === undefined) {
      args[key] = value;
    }
  }

  const missing = spec.requiredArgs.filter((key) => args[key] === undefined);
  if (missing.length > 0) {
    return {
      ok: false,
      kind: spec.kind,
      tool: spec.tool,
      candidates: [spec.tool, ...spec.aliases],
      args,
      droppedArgs,
      reason: `missing_required_args: ${missing.join(', ')}`,
    };
  }

  // Always bound the engine side too when the tool understands a limit.
  if (spec.allowedArgs.includes('limit') && args.limit === undefined) {
    args.limit = GHIDRA_QUERY_MAX_ROWS;
  } else if (typeof args.limit === 'number' && args.limit > GHIDRA_QUERY_MAX_ROWS) {
    args.limit = GHIDRA_QUERY_MAX_ROWS;
  }

  return {
    ok: true,
    kind: spec.kind,
    tool: spec.tool,
    candidates: [spec.tool, ...spec.aliases],
    args,
    droppedArgs,
    reason: '',
  };
}

export interface GhidraCappedRows {
  rows: unknown[];
  rowCount: number;
  truncated: boolean;
}

function rowCharCost(row: unknown): number {
  if (typeof row === 'string') {
    return row.length;
  }
  try {
    return JSON.stringify(row)?.length ?? 0;
  } catch {
    return 0;
  }
}

function capRowText(row: unknown): unknown {
  if (typeof row !== 'string') {
    return row;
  }
  return row.length > GHIDRA_QUERY_MAX_ROW_CHARS
    ? `${row.slice(0, GHIDRA_QUERY_MAX_ROW_CHARS)}\n...[truncated]`
    : row;
}

/**
 * Bound an engine answer on three axes at once: row count, per-row size, and
 * total size. A decompiled function can be tens of kilobytes on its own, so
 * capping rows alone is not enough.
 */
export function capGhidraQueryRows(
  rows: readonly unknown[],
  maxRows: number = GHIDRA_QUERY_MAX_ROWS,
  maxTotalChars: number = GHIDRA_QUERY_MAX_TOTAL_CHARS,
): GhidraCappedRows {
  const capped: unknown[] = [];
  let total = 0;
  let truncated = rows.length > maxRows;
  for (const row of rows.slice(0, maxRows)) {
    const shaped = capRowText(row);
    const cost = rowCharCost(shaped);
    if (total + cost > maxTotalChars && capped.length > 0) {
      truncated = true;
      break;
    }
    capped.push(shaped);
    total += cost;
  }
  return { rows: capped, rowCount: capped.length, truncated };
}

/**
 * Normalize whatever an MCP tool answered into rows.
 *
 * MCP results are `{ content: [{ type: 'text', text }] }` in the common case,
 * but servers also return structured content, a bare array, or a single object.
 * All four shapes appear in practice, so this accepts them rather than making
 * the caller guess -- and a shape nobody anticipated becomes one row rather
 * than an exception.
 */
export function normalizeGhidraToolResult(payload: unknown): unknown[] {
  if (payload === undefined || payload === null) {
    return [];
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  if (typeof payload !== 'object') {
    return [payload];
  }
  const record = payload as Record<string, unknown>;

  if (Array.isArray(record.structuredContent)) {
    return record.structuredContent;
  }
  if (Array.isArray(record.content)) {
    const rows: unknown[] = [];
    for (const entry of record.content) {
      if (entry && typeof entry === 'object' && 'text' in (entry as Record<string, unknown>)) {
        const text = (entry as Record<string, unknown>).text;
        if (typeof text === 'string') {
          // A text block is very often JSON. Unwrap when it is, so the caller
          // gets rows rather than one enormous string.
          const parsed = tryParseJson(text);
          if (Array.isArray(parsed)) {
            rows.push(...parsed);
          } else if (parsed !== undefined) {
            rows.push(parsed);
          } else {
            rows.push(text);
          }
          continue;
        }
      }
      rows.push(entry);
    }
    return rows;
  }
  // `result` singular is what decompile_function actually answers with:
  // { result: [{ name, code }] }. Leaving it out cost the whole deep-read
  // stage -- the call succeeded and the bodies were simply never found.
  for (const key of [
    'result',
    'results',
    'items',
    'rows',
    'data',
    'binaries',
    'programs',
    'functions',
    'symbols',
    'imports',
    'exports',
    'strings',
  ]) {
    if (Array.isArray(record[key])) {
      return record[key] as unknown[];
    }
  }
  return [payload];
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
