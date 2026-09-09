// What the import table does not say.
//
// On anything obfuscated the import table is a lie by omission: it lists
// LoadLibrary and GetProcAddress and nothing else, and the real API surface is
// resolved at run time. A report built from imports alone therefore describes a
// program that does almost nothing, which is worse than saying nothing.
//
// Three recovery routes, in descending order of how much they can prove:
//
//   1. A literal in the call site. `GetProcAddress(h, "NtWriteVirtualMemory")`
//      names the API outright. Ghidra also auto-names string data `s_<text>_<addr>`,
//      so the same call through a data reference is still readable.
//   2. A string FLOSS recovered. If the argument is not a literal but the
//      decoding routine that feeds this function produced an API-shaped string,
//      that is strong evidence -- and it is the case that only works because the
//      recovered-strings stage ran first.
//   3. API hashing. The name is NOT recoverable without the hash table, so this
//      is reported as a named technique (ATT&CK T1027.007) with the constant
//      that gave it away, never as a resolved name. Claiming a name here would
//      be exactly the kind of invention the whole ledger exists to prevent.
//
// Pure functions over decompiled text: no engine, no process, no I/O.

/** Windows API names are CamelCase identifiers, often with an A/W/Ex suffix. */
const API_NAME_REGEX = /^[A-Z][A-Za-z0-9_]{3,63}$/;

/** Ghidra's auto-name for string data: `s_CreateFileW_00402000`. */
const GHIDRA_STRING_SYMBOL_REGEX = /\bs_([A-Za-z0-9_@?$]{4,64})_[0-9a-fA-F]{6,16}\b/g;

/** A quoted literal, single or double, with an optional L/u8 prefix. */
const QUOTED_LITERAL_REGEX = /(?:L|u8)?"((?:[^"\\\n]|\\.){2,128})"/g;

/**
 * The resolver being called, however the decompiler spelled it.
 *
 * The name is matched on its own rather than as `name(`, because Ghidra writes
 * a call through an imported function pointer as `(*_GetProcAddress)(args)` --
 * the parenthesis that follows the name there is a CLOSE. Requiring `(` right
 * after the name missed every indirect call, which on an obfuscated binary is
 * all of them. A separate check keeps this to lines that are actual calls.
 */
const RESOLVER_REGEX = /\b_*(?:GetProcAddress|LdrGetProcedureAddress)\w*\b/i;
const LOADER_REGEX = /\b_*(?:LoadLibrary(?:Ex)?[AW]?|LdrLoadDll)\w*\b/i;
const CALL_REGEX = /\(/;

export type GhidraDynApiEvidence = 'literal' | 'string_symbol' | 'recovered_string' | 'hashed';

export interface GhidraDynamicApi {
  /** The API name, or '' when only the technique is known (hashing). */
  symbol: string;
  /** The module it was resolved from, when the call site said so. */
  library: string;
  /** The function that resolves it. */
  functionName: string;
  address: string;
  evidence: GhidraDynApiEvidence;
}

export interface GhidraApiHashing {
  code: string;
  detail: string;
  evidence: string[];
}

export interface GhidraDynamicApiResult {
  resolved: GhidraDynamicApi[];
  hashing: GhidraApiHashing[];
  /** Functions that call a resolver at all, even where no name was recovered. */
  resolverSites: { functionName: string; address: string; calls: number }[];
}

export interface GhidraDecompiledBody {
  name: string;
  address: string;
  decompiled: string;
}

/** Module names as they appear in a resolver call site. */
const MODULE_REGEX = /^[A-Za-z0-9_.-]{3,64}\.(?:dll|DLL|sys|SYS)$/;

function candidatesIn(line: string): string[] {
  const found: string[] = [];
  for (const match of line.matchAll(QUOTED_LITERAL_REGEX)) {
    found.push(match[1]);
  }
  for (const match of line.matchAll(GHIDRA_STRING_SYMBOL_REGEX)) {
    found.push(match[1]);
  }
  return found;
}

/**
 * Known hashing seeds, as they appear in decompiled constants.
 *
 * A seed alone is weak evidence -- 5381 occurs in ordinary code -- so a match is
 * only reported when the function ALSO looks like a resolver loop. Naming the
 * constant is the point: it tells the analyst which algorithm to reimplement.
 */
const HASH_SEEDS: readonly { pattern: RegExp; name: string }[] = [
  { pattern: /\b(?:5381|0x1505)\b/, name: 'djb2 (seed 5381)' },
  { pattern: /\b(?:2166136261|0x811c9dc5)\b/i, name: 'FNV-1a (offset basis 0x811c9dc5)' },
  { pattern: /\b(?:16777619|0x1000193)\b/i, name: 'FNV-1a (prime 0x01000193)' },
  { pattern: /\b0xdeadbeef\b/i, name: 'custom seed 0xdeadbeef' },
];

/** ROR-13 has no constant; it has a shape: rotate right by 13 over a byte loop. */
const ROR13_REGEX = />>\s*0?x?0*d\b|>>\s*13\b/;
const ROL_SHIFT_REGEX = /<<\s*0?x?0*13\b|<<\s*19\b/;

/** A function that walks the PEB is resolving imports without any import. */
const PEB_REGEX =
  /\b(?:PEB|Peb|_PEB|InMemoryOrderModuleList|LdrData|0x60\s*\)|fs:\[0x30\]|gs:\[0x60\])/;

/**
 * Recover what a binary resolves at run time.
 *
 * `recovered` is the FLOSS output, and is what makes route 2 possible: an
 * API-shaped string that exists only after decoding, produced inside a function
 * that also calls a resolver, is a resolution that no literal would have shown.
 */
export function findDynamicApis(params: {
  bodies: readonly GhidraDecompiledBody[];
  imports: readonly { symbol: string; library?: string }[];
  recovered?: readonly { value: string; decodingRoutine: string }[];
}): GhidraDynamicApiResult {
  const resolved: GhidraDynamicApi[] = [];
  const seen = new Set<string>();
  const resolverSites: { functionName: string; address: string; calls: number }[] = [];
  const hashing: GhidraApiHashing[] = [];
  const hashEvidence = new Set<string>();

  const recoveredApiNames = new Set(
    (params.recovered ?? [])
      .map((entry) => entry.value.trim())
      .filter((value) => API_NAME_REGEX.test(value)),
  );

  const add = (entry: GhidraDynamicApi): void => {
    const identity = `${entry.symbol}|${entry.address}`;
    if (seen.has(identity)) {
      return;
    }
    seen.add(identity);
    resolved.push(entry);
  };

  for (const body of params.bodies) {
    const lines = body.decompiled.split(/\r?\n/);
    let resolverCalls = 0;
    let sawRor13 = false;
    let sawByteLoop = false;

    for (const line of lines) {
      const isCall = CALL_REGEX.test(line);
      const isResolver = isCall && RESOLVER_REGEX.test(line);
      const isLoader = isCall && LOADER_REGEX.test(line);
      if (isResolver) {
        resolverCalls += 1;
      }
      if (isResolver || isLoader) {
        for (const candidate of candidatesIn(line)) {
          const value = candidate.trim();
          if (!value) {
            continue;
          }
          if (MODULE_REGEX.test(value)) {
            // A module name on a resolver line is the library half.
            if (isLoader) {
              add({
                symbol: '',
                library: value,
                functionName: body.name,
                address: body.address,
                evidence: 'literal',
              });
            }
            continue;
          }
          if (!API_NAME_REGEX.test(value)) {
            continue;
          }
          add({
            symbol: value,
            library: '',
            functionName: body.name,
            address: body.address,
            // A quoted literal and a Ghidra string symbol are the same strength
            // of evidence -- both are the name, in the call site.
            evidence: line.includes(`"${value}`) ? 'literal' : 'string_symbol',
          });
        }
      }
      if (ROR13_REGEX.test(line) && ROL_SHIFT_REGEX.test(line)) {
        sawRor13 = true;
      }
      if (/\bwhile\b|\bfor\b|\bdo\b/.test(line) && /\+\+|\+ 1\b/.test(line)) {
        sawByteLoop = true;
      }
    }

    if (resolverCalls > 0) {
      resolverSites.push({
        functionName: body.name,
        address: body.address,
        calls: resolverCalls,
      });
      // Route 2: this function resolves something, and a decoder produced an
      // API-shaped string. Weaker than a literal, and labelled as such.
      for (const value of recoveredApiNames) {
        add({
          symbol: value,
          library: '',
          functionName: body.name,
          address: body.address,
          evidence: 'recovered_string',
        });
      }
    }

    if (sawRor13 && sawByteLoop) {
      hashEvidence.add(`${body.name || body.address}: ROR-13 over a byte loop`);
    }
    for (const seed of HASH_SEEDS) {
      if (seed.pattern.test(body.decompiled) && sawByteLoop) {
        hashEvidence.add(`${body.name || body.address}: ${seed.name}`);
      }
    }
    if (PEB_REGEX.test(body.decompiled)) {
      hashEvidence.add(`${body.name || body.address}: walks the PEB module list`);
    }
  }

  if (hashEvidence.size > 0) {
    hashing.push({
      code: 'api_hashing',
      detail:
        'Resolves imports by hashed name rather than by string. The names are not recoverable without the hash table, so the APIs behind this are NOT in the list above. ATT&CK T1027.007.',
      evidence: [...hashEvidence].sort().slice(0, 12),
    });
  }

  // The strongest signal of all, and it needs no decompilation: an import table
  // that holds the resolution APIs and essentially nothing else.
  const importNames = params.imports.map((entry) => entry.symbol);
  const resolverImports = importNames.filter((name) =>
    /^(?:LoadLibrary|GetProcAddress|LdrLoadDll|LdrGetProcedureAddress)/i.test(name),
  );
  if (importNames.length > 0 && importNames.length <= 20 && resolverImports.length > 0) {
    hashing.push({
      code: 'resolution_only_imports',
      detail: `The import table has ${importNames.length} entries and includes ${resolverImports.join(', ')}. An import table this small that can resolve more is describing a fraction of what the binary calls.`,
      evidence: resolverImports.slice(0, 10),
    });
  }

  return {
    resolved: resolved.sort(
      (left, right) =>
        left.symbol.localeCompare(right.symbol) || left.address.localeCompare(right.address),
    ),
    hashing,
    resolverSites: resolverSites.sort((left, right) => right.calls - left.calls),
  };
}
