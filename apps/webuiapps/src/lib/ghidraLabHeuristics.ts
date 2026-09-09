// Ghidra Lab heuristics: the deterministic half of "what does this binary do".
//
// Everything here is code, not a model. That is the point. The 2026 work on LLMs
// over decompiled code is consistent on one thing -- summaries of long analyses
// drift generic and drop the load-bearing detail -- so the report's factual spine
// has to be produced by rules that can be pointed at, and the model's job is to
// connect facts it cannot invent.
//
// Two classifiers live here:
//   - API categorisation, which turns an import table into capability claims
//     ("writes another process's memory") that carry the symbol as evidence.
//   - String bucketing, which turns a string table into the same.
// Plus a selection score, which decides WHICH functions are worth spending
// decompilation tokens on.
//
// The API list leans towards process manipulation, anti-debug, driver loading and
// memory scanning because that is the domain this lab exists for. It is not
// exhaustive and does not pretend to be: an unmatched import is reported as
// uncategorised rather than silently dropped.
//
// Browser-safe: no node builtins.

export type GhidraApiCategory =
  | 'process'
  | 'injection'
  | 'memory'
  | 'anti-debug'
  | 'hooking'
  | 'driver'
  | 'privilege'
  | 'crypto'
  | 'network'
  | 'registry'
  | 'filesystem'
  | 'persistence'
  | 'ui'
  | 'time'
  | 'system-info';

export interface GhidraApiRule {
  category: GhidraApiCategory;
  /** Lower-cased substrings; a symbol matches if it contains any of them. */
  needles: readonly string[];
  /** What a match licenses the report to say. */
  claim: string;
  /** Higher means more worth explaining in the report. */
  weight: number;
}

export const GHIDRA_API_RULES: readonly GhidraApiRule[] = [
  {
    category: 'injection',
    needles: [
      'createremotethread',
      'ntcreatethreadex',
      'queueuserapc',
      'setwindowshookex',
      'ntmapviewofsection',
      'rtlcreateuserthread',
      'loadlibrary',
    ],
    claim: 'can run code inside another process',
    weight: 10,
  },
  {
    category: 'memory',
    needles: [
      'writeprocessmemory',
      'readprocessmemory',
      'virtualallocex',
      'virtualprotectex',
      'virtualqueryex',
      'ntwritevirtualmemory',
      'ntreadvirtualmemory',
    ],
    claim: "reads or writes another process's memory",
    weight: 10,
  },
  {
    category: 'process',
    needles: [
      'openprocess',
      'createprocess',
      'terminateprocess',
      'ntopenprocess',
      'createtoolhelp32snapshot',
      'process32first',
      'process32next',
      'enumprocesses',
      'ntqueryinformationprocess',
    ],
    claim: 'enumerates or opens other processes',
    weight: 8,
  },
  {
    category: 'anti-debug',
    needles: [
      'isdebuggerpresent',
      'checkremotedebuggerpresent',
      'ntsetinformationthread',
      'outputdebugstring',
      'ntqueryobject',
      'debugactiveprocess',
      'rtladjustprivilege',
    ],
    claim: 'checks for a debugger',
    weight: 9,
  },
  {
    category: 'hooking',
    needles: ['virtualprotect', 'flushinstructioncache', 'detour', 'minhook', 'writeprocessmemory'],
    claim: 'changes memory protection, which is what inline hooking needs',
    weight: 6,
  },
  {
    category: 'driver',
    needles: [
      'deviceiocontrol',
      'ntloaddriver',
      'zwloaddriver',
      'openscmanager',
      'createservice',
      'startservice',
      'ntopendirectoryobject',
    ],
    claim: 'talks to a kernel driver or installs one',
    weight: 10,
  },
  {
    category: 'privilege',
    needles: ['adjusttokenprivileges', 'openprocesstoken', 'lookupprivilegevalue', 'impersonate'],
    claim: 'adjusts process privileges',
    weight: 7,
  },
  {
    category: 'crypto',
    needles: ['crypt', 'bcrypt', 'ncrypt', 'aes', 'sha256', 'md5', 'rc4', 'tbsi_', 'tbs_'],
    claim: 'performs cryptographic operations',
    weight: 6,
  },
  {
    category: 'network',
    needles: [
      'wsastartup',
      'wsasocket',
      'connect',
      'send',
      'recv',
      'internetopen',
      'internetconnect',
      'winhttp',
      'httpsendrequest',
      'getaddrinfo',
      'gethostbyname',
    ],
    claim: 'talks to the network',
    weight: 7,
  },
  {
    category: 'registry',
    needles: ['regopenkey', 'regsetvalue', 'regquery', 'regcreatekey', 'regdeletekey', 'ntopenkey'],
    claim: 'reads or writes the registry',
    weight: 5,
  },
  {
    category: 'filesystem',
    needles: [
      'createfile',
      'writefile',
      'readfile',
      'deletefile',
      'movefile',
      'findfirstfile',
      'ntcreatefile',
      'shfileoperation',
    ],
    claim: 'reads or writes files',
    weight: 4,
  },
  {
    category: 'persistence',
    needles: ['schtasks', 'taskscheduler', 'itaskservice', 'shellexecute', 'winexec'],
    claim: 'can arrange to be run again later',
    weight: 7,
  },
  {
    category: 'system-info',
    needles: [
      'ntquerysysteminformation',
      'getsystemfirmwaretable',
      'getvolumeinformation',
      'getadaptersinfo',
      'cpuid',
      'getsystemmetrics',
      'wmi',
    ],
    claim: 'fingerprints the machine',
    weight: 6,
  },
  {
    category: 'ui',
    needles: ['findwindow', 'enumwindows', 'getforegroundwindow', 'sendmessage', 'postmessage'],
    claim: 'inspects or drives other windows',
    weight: 5,
  },
  {
    category: 'time',
    needles: ['queryperformancecounter', 'gettickcount', 'rdtsc', 'ntdelayexecution', 'sleep'],
    claim: 'measures elapsed time, which is also how timing-based anti-debug works',
    weight: 3,
  },
];

export interface GhidraApiMatch {
  symbol: string;
  library: string;
  category: GhidraApiCategory;
  claim: string;
  weight: number;
}

/** Categorise one imported symbol. Returns every rule it matched, not just the first. */
export function categorizeApi(symbol: string, library = ''): GhidraApiMatch[] {
  const lowered = symbol.toLowerCase();
  if (!lowered) {
    return [];
  }
  const matches: GhidraApiMatch[] = [];
  for (const rule of GHIDRA_API_RULES) {
    if (rule.needles.some((needle) => lowered.includes(needle))) {
      matches.push({
        symbol,
        library,
        category: rule.category,
        claim: rule.claim,
        weight: rule.weight,
      });
    }
  }
  return matches;
}

export interface GhidraCapabilitySignal {
  category: GhidraApiCategory;
  claim: string;
  /** The symbols that justify the claim -- the report cites these, not the claim. */
  symbols: string[];
  weight: number;
}

/**
 * Roll an import table up into capability signals.
 *
 * Sorted by weight so the report leads with "loads a kernel driver" rather than
 * "calls Sleep". Symbols are kept because a claim without its evidence is
 * exactly what the verifier is there to delete.
 */
export function summarizeImportCapabilities(
  imports: readonly { symbol: string; library?: string }[],
  maxSymbolsPerSignal = 12,
): GhidraCapabilitySignal[] {
  const byCategory = new Map<GhidraApiCategory, GhidraCapabilitySignal>();
  for (const entry of imports) {
    for (const match of categorizeApi(entry.symbol, entry.library ?? '')) {
      const existing = byCategory.get(match.category);
      if (existing) {
        if (!existing.symbols.includes(match.symbol)) {
          existing.symbols.push(match.symbol);
        }
        continue;
      }
      byCategory.set(match.category, {
        category: match.category,
        claim: match.claim,
        symbols: [match.symbol],
        weight: match.weight,
      });
    }
  }
  return [...byCategory.values()]
    .map((signal) => ({
      ...signal,
      symbols: signal.symbols.slice(0, maxSymbolsPerSignal).sort(),
    }))
    .sort(
      (left, right) => right.weight - left.weight || left.category.localeCompare(right.category),
    );
}

/** Imports that matched no rule at all, so the report can be honest about coverage. */
export function uncategorizedImports(
  imports: readonly { symbol: string; library?: string }[],
): string[] {
  const unmatched: string[] = [];
  for (const entry of imports) {
    if (categorizeApi(entry.symbol, entry.library ?? '').length === 0) {
      unmatched.push(entry.symbol);
    }
  }
  return unmatched;
}

// --- Strings ---------------------------------------------------------------

export type GhidraStringBucket =
  | 'url'
  | 'host'
  | 'module'
  | 'path'
  | 'registry'
  | 'command'
  | 'format'
  | 'guid'
  | 'error'
  | 'device'
  | 'other';

const URL_REGEX = /^[a-z][a-z0-9+.-]*:\/\//i;
const HOST_REGEX = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
// A bare module name matches the host pattern exactly ("kernel32.dll" is
// letters-dot-letters), and a report that lists every imported DLL as a network
// host is actively misleading. Measured: all five "hosts" in a real report were
// DLLs. Module names are their own bucket -- which is the more useful reading
// anyway, since a dynamically resolved DLL name is worth seeing.
const MODULE_REGEX = /\.(?:dll|exe|sys|ocx|cpl|drv|so|dylib|node)$/i;
const IPV4_REGEX = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const WINDOWS_PATH_REGEX = /^[a-z]:\\|^\\\\/i;
const POSIX_PATH_REGEX = /^\/(?:usr|etc|var|tmp|home|opt|proc|sys)\//;
const REGISTRY_REGEX = /^(?:hkey_|software\\|system\\currentcontrolset)/i;
const DEVICE_REGEX = /^\\\\[.?]\\|^\\device\\/i;
const GUID_REGEX = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;
const FORMAT_REGEX = /%[-+ #0]*\d*(?:\.\d+)?[hlLqjzt]*[diouxXeEfgGaAcspn%]/;
const COMMAND_REGEX =
  /\b(?:cmd\.exe|powershell|rundll32|regsvr32|schtasks|net\s+(?:user|localgroup)|sc\s+(?:create|start))\b/i;
const ERROR_REGEX = /\b(?:error|failed|failure|exception|invalid|cannot|unable to)\b/i;

/** Bucket one string. Order matters: the most specific pattern wins. */
export function bucketString(value: string): GhidraStringBucket {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'other';
  }
  if (URL_REGEX.test(trimmed)) {
    return 'url';
  }
  if (DEVICE_REGEX.test(trimmed)) {
    return 'device';
  }
  if (GUID_REGEX.test(trimmed)) {
    return 'guid';
  }
  if (REGISTRY_REGEX.test(trimmed)) {
    return 'registry';
  }
  if (WINDOWS_PATH_REGEX.test(trimmed) || POSIX_PATH_REGEX.test(trimmed)) {
    return 'path';
  }
  if (COMMAND_REGEX.test(trimmed)) {
    return 'command';
  }
  if (MODULE_REGEX.test(trimmed) && !trimmed.includes(' ')) {
    return 'module';
  }
  if (HOST_REGEX.test(trimmed) || IPV4_REGEX.test(trimmed)) {
    return 'host';
  }
  if (FORMAT_REGEX.test(trimmed)) {
    return 'format';
  }
  if (ERROR_REGEX.test(trimmed)) {
    return 'error';
  }
  return 'other';
}

/** Buckets worth putting in a report on their own. 'other' and 'error' are noise
 *  at report scale -- they are counted, not listed. */
export const GHIDRA_INTERESTING_STRING_BUCKETS: readonly GhidraStringBucket[] = [
  'url',
  'host',
  'device',
  'registry',
  'command',
  'module',
  'path',
  'guid',
];

export interface GhidraStringSummary {
  bucket: GhidraStringBucket;
  count: number;
  samples: { value: string; address: string }[];
}

export function summarizeStrings(
  strings: readonly { value: string; address?: string }[],
  maxSamplesPerBucket = 12,
): GhidraStringSummary[] {
  const byBucket = new Map<GhidraStringBucket, GhidraStringSummary>();
  for (const entry of strings) {
    const bucket = bucketString(entry.value);
    let summary = byBucket.get(bucket);
    if (!summary) {
      summary = { bucket, count: 0, samples: [] };
      byBucket.set(bucket, summary);
    }
    summary.count += 1;
    if (summary.samples.length < maxSamplesPerBucket) {
      summary.samples.push({ value: entry.value.slice(0, 240), address: entry.address ?? '' });
    }
  }
  const order = new Map(GHIDRA_INTERESTING_STRING_BUCKETS.map((bucket, index) => [bucket, index]));
  return [...byBucket.values()].sort((left, right) => {
    const leftRank = order.get(left.bucket) ?? 99;
    const rightRank = order.get(right.bucket) ?? 99;
    return leftRank - rightRank || right.count - left.count;
  });
}

// --- Anti-analysis ---------------------------------------------------------

export interface GhidraAntiAnalysisIndicator {
  code: string;
  detail: string;
  evidence: string[];
}

/**
 * Packing and anti-analysis signals that can be read off the surface alone.
 *
 * Deliberately conservative: each indicator names what it saw. "Few imports" is
 * suggestive of packing, not proof of it, and the wording says so -- a report
 * that calls a statically-linked binary "packed" has taught the reader nothing.
 */
export function detectAntiAnalysis(params: {
  imports: readonly { symbol: string; library?: string }[];
  sectionNames?: readonly string[];
  strings?: readonly { value: string }[];
}): GhidraAntiAnalysisIndicator[] {
  const indicators: GhidraAntiAnalysisIndicator[] = [];

  const antiDebug = params.imports
    .flatMap((entry) => categorizeApi(entry.symbol, entry.library ?? ''))
    .filter((match) => match.category === 'anti-debug');
  if (antiDebug.length > 0) {
    indicators.push({
      code: 'anti_debug_imports',
      detail: 'Imports APIs whose main use is detecting a debugger.',
      evidence: [...new Set(antiDebug.map((match) => match.symbol))].sort().slice(0, 10),
    });
  }

  const loaderOnly = params.imports.filter((entry) =>
    /^(loadlibrary|getprocaddress)/i.test(entry.symbol),
  );
  if (params.imports.length > 0 && params.imports.length <= 12 && loaderOnly.length > 0) {
    indicators.push({
      code: 'minimal_import_table',
      detail:
        'Very small import table dominated by dynamic-resolution APIs. Consistent with packing or with imports resolved at runtime; not proof of either.',
      evidence: loaderOnly.map((entry) => entry.symbol).slice(0, 10),
    });
  }

  const suspiciousSections = (params.sectionNames ?? []).filter((name) =>
    /^(?:upx|\.aspack|\.themida|\.vmp|\.enigma|\.petite|\.nsp)/i.test(name.trim()),
  );
  if (suspiciousSections.length > 0) {
    indicators.push({
      code: 'packer_section_names',
      detail: 'Section names match a known packer or protector.',
      evidence: suspiciousSections.slice(0, 10),
    });
  }

  const vmStrings = (params.strings ?? [])
    .map((entry) => entry.value)
    .filter((value) => /\b(?:vmware|virtualbox|vbox|qemu|sandboxie|wine_get|xen)\b/i.test(value));
  if (vmStrings.length > 0) {
    indicators.push({
      code: 'vm_detection_strings',
      detail: 'Contains strings used to recognise virtual machines or sandboxes.',
      evidence: [...new Set(vmStrings)].slice(0, 10),
    });
  }

  return indicators;
}

// --- Function selection -----------------------------------------------------

export interface GhidraFunctionCandidate {
  name: string;
  address: string;
  size?: number;
  xrefCount?: number;
  /** Imported symbols this function is known to reference, when the engine said so. */
  callsImports?: readonly string[];
  isEntryPoint?: boolean;
  isExport?: boolean;
  /** A one-instruction jump to the real function. Cheap to read, teaches nothing. */
  isThunk?: boolean;
  /** Lives in another module: there is no body in this binary to decompile. */
  isExternal?: boolean;
}

export interface GhidraSelectedFunction extends GhidraFunctionCandidate {
  score: number;
  /** Why this one was chosen. Recorded in the ledger so selection is auditable. */
  reasons: string[];
}

/**
 * Names that identify runtime plumbing rather than the program's own code.
 *
 * The leading underscore is deliberately part of this: in an MSVC build it
 * really does mean CRT, and the alternative was measured. Narrowing the rule to
 * a list of specific helpers let ~110 of 128 functions tie with real code at the
 * same score, and since the tie-break is alphabetical, `___report_gsfailure`,
 * `__RTC_InitBase` and `_atexit` took the seed and pushed `GetPdbDll` -- the one
 * function holding the binary's dynamically resolved registry APIs -- out of it
 * entirely. The dynamic-API stage went from three findings to none.
 *
 * A match no longer EXCLUDES the function, though. It ranks it last, so it is
 * read only when there is budget nobody else wants -- which is what raises
 * coverage without letting boilerplate displace anything.
 */
const DEFAULT_LIBRARY_NAME =
  /^(?:_+|std::|operator|__scrt|__security|_cinit|atexit|malloc$|free$|memcpy$|memset$|printf$)/i;

/**
 * Score and rank functions for deep reading.
 *
 * Token budget is the binding constraint: decompiled bodies are large and a real
 * binary has tens of thousands of functions, so the sweep can only afford a few
 * dozen. Ranking is by what a reader would actually want explained -- entry
 * points, exports, anything touching a high-weight API, then heavily referenced
 * and unusually large functions.
 */
export function selectFunctionsForDeepRead(
  candidates: readonly GhidraFunctionCandidate[],
  limit = 40,
): GhidraSelectedFunction[] {
  const scored: GhidraSelectedFunction[] = [];
  /** Scored exactly zero: no signal either way, kept as budget filler. */
  const unranked: GhidraFunctionCandidate[] = [];
  /** Named as runtime boilerplate: filler of last resort, never a displacer. */
  const deprioritized: GhidraSelectedFunction[] = [];
  for (const candidate of candidates) {
    if (!candidate.name && !candidate.address) {
      continue;
    }
    if (candidate.isExternal) {
      // An imported symbol listed as a function. There is no body in this
      // binary to decompile, so a slot spent here comes back empty.
      continue;
    }
    let score = 0;
    const reasons: string[] = [];

    if (candidate.isEntryPoint) {
      score += 40;
      reasons.push('entry point');
    }
    if (candidate.isExport) {
      score += 20;
      reasons.push('exported');
    }

    const apiHits = (candidate.callsImports ?? []).flatMap((symbol) => categorizeApi(symbol));
    if (apiHits.length > 0) {
      const best = apiHits.reduce((max, hit) => Math.max(max, hit.weight), 0);
      score += best * 3;
      const categories = [...new Set(apiHits.map((hit) => hit.category))].sort();
      reasons.push(`calls ${categories.join('/')} APIs`);
    }

    if (typeof candidate.xrefCount === 'number' && candidate.xrefCount > 0) {
      score += Math.min(20, candidate.xrefCount);
      if (candidate.xrefCount >= 10) {
        reasons.push(`${candidate.xrefCount} references`);
      }
    }

    if (typeof candidate.size === 'number' && candidate.size > 0) {
      // Large functions carry more logic; log-ish so one giant function does not
      // crowd out everything else.
      score += Math.min(15, Math.floor(Math.log2(Math.max(2, candidate.size))));
      if (candidate.size >= 4096) {
        reasons.push(`large (${candidate.size} bytes)`);
      }
    }

    // Named functions beat sub_xxxxxx: a symbol usually means the author named
    // it, or a signature matched, and either is a reason to look.
    if (candidate.name && !/^(?:sub_|fun_|func_|loc_)/i.test(candidate.name)) {
      score += 6;
      if (DEFAULT_LIBRARY_NAME.test(candidate.name)) {
        // ...unless the name says it is runtime boilerplate.
        score -= 25;
        reasons.push('looks like runtime/library code');
      } else {
        reasons.push('has a symbol name');
      }
    }

    if (candidate.isThunk) {
      // A thunk is `jmp real_function`. Measured on a real PE: 67 of 128
      // "functions" were thunks, and 14 of them held seed slots beside the very
      // functions they jump to -- the same body read twice, once uselessly.
      //
      // Kept, because they are a few bytes each and they complete the call
      // graph, but never ahead of a function with a body worth reading.
      deprioritized.push({
        ...candidate,
        score: Math.min(score, 0) - 1,
        reasons: [...reasons, 'thunk to another function'],
      });
      continue;
    }

    if (score < 0) {
      // The name says runtime boilerplate. Kept, but behind everything else:
      // reading `_atexit` teaches nothing until there is nothing better left,
      // and excluding it outright was capping coverage at 14% of the image with
      // the character budget almost untouched.
      //
      // The ones that genuinely matter -- the CRT startup chain -- are reached
      // by the deep read's path expansion rather than by scoring, which is what
      // that reserve is for.
      deprioritized.push({ ...candidate, score, reasons });
      continue;
    }
    if (score === 0) {
      unranked.push(candidate);
      continue;
    }
    scored.push({ ...candidate, score, reasons });
  }

  const ranked = scored
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, Math.max(0, limit));

  // Spend the rest of the budget rather than reading nothing.
  //
  // Every signal above -- entry point, export, called APIs, xref count, size --
  // comes from the engine's function listing, and a stripped target can come
  // back as bare {name, address} rows with none of them. Every function then
  // scored zero, nothing was selected, and the deep read reported "no functions
  // scored high enough to read" on exactly the binaries where reading the code
  // is the only thing left to do.
  if (ranked.length >= limit) {
    return ranked;
  }
  for (const candidate of unranked) {
    if (ranked.length >= limit) {
      return ranked;
    }
    ranked.push({
      ...candidate,
      score: 0,
      reasons: ['no ranking signal from the engine; included to fill the read budget'],
    });
  }
  // Boilerplate last, and only into budget nobody else wanted.
  const boilerplate = [...deprioritized].sort(
    (left, right) => right.score - left.score || left.name.localeCompare(right.name),
  );
  for (const candidate of boilerplate) {
    if (ranked.length >= limit) {
      return ranked;
    }
    ranked.push(candidate);
  }
  return ranked;
}
