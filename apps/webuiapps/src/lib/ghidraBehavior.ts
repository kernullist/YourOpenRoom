// What the binary does when it runs -- phrased as something static analysis can
// actually support.
//
// It cannot say "it ran and injected code". It can say: from the entry point,
// these APIs are reachable, through these functions, and inside one function
// they are called in this order, and that ordering is the signature of process
// injection. That is a different and much more defensible claim, and the wording
// throughout is chosen so the report cannot drift into the first one.
//
// Three products, in increasing order of interpretation:
//
//   1. REACHABILITY -- which APIs a named entry can get to, and via what. This
//      is graph traversal over the call graph and is as close to fact as this
//      gets.
//   2. ORDERING -- the sequence APIs appear in within a function body. Source
//      order, not execution order, and labelled as such.
//   3. CHAINS -- an ordered pattern that names a behaviour. Interpretation, and
//      it carries the APIs it matched on so a reader can disagree.
//
// Pure functions: no engine, no I/O.

import { categorizeApi } from './ghidraLabHeuristics';

export interface GhidraCallNode {
  name: string;
  address: string;
  /** Imported or resolved APIs this function references. */
  callsImports?: readonly string[];
  /** Other functions in the image this one calls, by name or address. */
  callsFunctions?: readonly string[];
  isEntryPoint?: boolean;
  isExport?: boolean;
}

export interface GhidraReachableApi {
  symbol: string;
  /** The entry the walk started from. */
  from: string;
  /** How many calls deep, 1 meaning the entry calls it directly. */
  depth: number;
  /** The function that actually references the API. */
  via: string;
}

export interface GhidraApiSequence {
  functionName: string;
  address: string;
  /** APIs in the order they appear in the body. Source order, not run order. */
  apis: string[];
}

export interface GhidraBehaviorChain {
  code: string;
  title: string;
  /** What the ordering supports, worded as capability rather than as history. */
  detail: string;
  /** The APIs that matched, in the order they were found. */
  apis: string[];
  /** Where the ordering was observed. */
  functionName: string;
  address: string;
  confidence: 'strong' | 'moderate';
}

export interface GhidraBehaviorResult {
  reachable: GhidraReachableApi[];
  sequences: GhidraApiSequence[];
  chains: GhidraBehaviorChain[];
  /** Entries the walk started from, so a reader knows the coverage. */
  entries: string[];
  /** True when the call graph had no edges to walk. */
  graphMissing: boolean;
  /**
   * False when the walk could not start at the entry point and fell back to
   * treating each read function as its own root.
   *
   * The distinction is the claim: "reachable from the entry point" is a
   * statement about the program, "reachable from GetPdbDll" is a statement
   * about a function. The report must not print the second as though it were
   * the first.
   */
  rootedAtEntry: boolean;
}

/** Depth cap: past this the "reachable from entry" claim stops meaning much. */
const MAX_DEPTH = 6;
const MAX_REACHABLE = 300;

/**
 * Match on the API base name so the A/W spellings need not be listed twice.
 *
 * Only a trailing A or W is stripped. `Ex` is part of the name: dropping it
 * turned VirtualAllocEx into virtualalloc, which then could not match the
 * `virtualallocex` a spec lists, and the injection chain silently lost a step.
 */
function baseName(symbol: string): string {
  return symbol.replace(/[AW]$/, '').toLowerCase();
}

interface ChainSpec {
  code: string;
  title: string;
  detail: string;
  /** Ordered steps; each step is satisfied by any of its alternatives. */
  steps: readonly (readonly string[])[];
  /** Steps that must all appear for the chain to be worth reporting. */
  minSteps: number;
}

/**
 * Ordered API patterns that name a behaviour.
 *
 * Ordering matters: OpenProcess then WriteProcessMemory then CreateRemoteThread
 * is injection. The same three APIs in any order is a program that happens to
 * import them, which is a much weaker statement -- so a chain requires the steps
 * to appear in sequence.
 */
const CHAIN_SPECS: readonly ChainSpec[] = [
  {
    code: 'process_injection',
    title: 'Process injection',
    detail:
      'Opens another process, allocates and writes memory inside it, then starts execution there. This is the classic remote-thread injection sequence.',
    steps: [
      ['openprocess', 'ntopenprocess', 'createtoolhelp32snapshot', 'process32first'],
      ['virtualallocex', 'ntallocatevirtualmemory', 'zwallocatevirtualmemory'],
      ['writeprocessmemory', 'ntwritevirtualmemory', 'zwwritevirtualmemory'],
      ['createremotethread', 'ntcreatethreadex', 'rtlcreateuserthread', 'queueuserapc'],
    ],
    minSteps: 3,
  },
  {
    code: 'self_injection',
    title: 'Runs code it wrote itself',
    detail:
      'Allocates executable memory in its own process, writes into it and transfers control. Shellcode loaders and unpackers both look like this.',
    steps: [
      ['virtualalloc', 'ntallocatevirtualmemory', 'heapalloc', 'virtualprotect'],
      ['memcpy', 'rtlmovememory', 'memmove', 'writeprocessmemory'],
      ['createthread', 'ntcreatethread', 'enumwindows', 'callwindowproc'],
    ],
    minSteps: 3,
  },
  {
    code: 'persistence_registry',
    title: 'Persistence through the registry',
    detail:
      'Opens or creates a registry key and writes a value into it. Where the key is a Run key, the value survives a reboot.',
    steps: [
      ['regcreatekey', 'regopenkey', 'ntcreatekey', 'ntopenkey'],
      ['regsetvalue', 'ntsetvalvalue', 'ntsetvaluekey'],
    ],
    minSteps: 2,
  },
  {
    code: 'persistence_service',
    title: 'Persistence as a service',
    detail: 'Opens the service control manager and creates or starts a service.',
    steps: [
      ['openscmanager'],
      ['createservice', 'openservice'],
      ['startservice', 'changeserviceconfig'],
    ],
    minSteps: 2,
  },
  {
    code: 'network_c2',
    title: 'Talks to a remote host',
    detail:
      'Resolves or connects to a host and exchanges data. Whether that is command and control depends on the address, which the strings section carries.',
    steps: [
      ['internetopen', 'winhttpopen', 'socket', 'wsastartup', 'getaddrinfo', 'gethostbyname'],
      ['internetconnect', 'winhttpconnect', 'connect', 'wsaconnect'],
      ['httpsendrequest', 'winhttpsendrequest', 'send', 'wsasend', 'internetreadfile', 'recv'],
    ],
    minSteps: 2,
  },
  {
    code: 'file_encryption',
    title: 'Encrypts files',
    detail:
      'Enumerates files, acquires a cryptographic context and writes transformed data back. This is the ransomware shape; it is also the backup-tool shape, so the target set matters.',
    steps: [
      ['findfirstfile', 'findnextfile', 'readdirectorychanges'],
      [
        'cryptacquirecontext',
        'bcryptopenalgorithmprovider',
        'cryptgenkey',
        'bcryptgeneratesymmetrickey',
      ],
      ['cryptencrypt', 'bcryptencrypt'],
      ['writefile', 'ntwritefile', 'movefile'],
    ],
    minSteps: 3,
  },
  {
    code: 'credential_access',
    title: 'Reads credentials',
    detail: 'Opens a process token or the credential store and reads from it.',
    steps: [
      ['openprocesstoken', 'credenumerate', 'credread', 'lsaopenpolicy'],
      ['cryptunprotectdata', 'lsaretrieveprivatedata', 'gettokeninformation'],
    ],
    minSteps: 2,
  },
  {
    code: 'anti_analysis_runtime',
    title: 'Checks whether it is being watched',
    detail:
      'Queries for a debugger or times itself before continuing. Behaviour after these checks is often different from behaviour under a debugger.',
    steps: [
      [
        'isdebuggerpresent',
        'checkremotedebuggerpresent',
        'ntqueryinformationprocess',
        'outputdebugstring',
      ],
      ['getickcount', 'gettickcount', 'queryperformancecounter', 'rdtsc', 'sleep'],
    ],
    minSteps: 2,
  },
  {
    code: 'privilege_escalation',
    title: 'Adjusts its own privileges',
    detail: 'Looks up a privilege by name and enables it in its own token.',
    steps: [['openprocesstoken'], ['lookupprivilegevalue'], ['adjusttokenprivileges']],
    minSteps: 2,
  },
  {
    code: 'driver_load',
    title: 'Loads a kernel driver',
    detail:
      'Writes a driver to disk or registers one, then asks the kernel to load it. This is the strongest single capability a user-mode binary can have.',
    steps: [
      ['writefile', 'createfile', 'regsetvalue'],
      ['ntloaddriver', 'zwloaddriver', 'createservice', 'startservice'],
    ],
    minSteps: 2,
  },
];

/**
 * Walk the call graph from every entry point and export.
 *
 * Breadth-first with a depth cap: an API twelve calls from the entry is
 * technically reachable and tells a reader nothing, so the claim is bounded to a
 * depth where it still means something.
 */
export function computeReachableApis(nodes: readonly GhidraCallNode[]): {
  reachable: GhidraReachableApi[];
  entries: string[];
  graphMissing: boolean;
  rootedAtEntry: boolean;
} {
  const byKey = new Map<string, GhidraCallNode>();
  for (const node of nodes) {
    if (node.name) {
      byKey.set(node.name.toLowerCase(), node);
    }
    if (node.address) {
      byKey.set(node.address.toLowerCase(), node);
    }
  }
  const entries = nodes.filter((node) => node.isEntryPoint || node.isExport);
  const hasEdges = nodes.some((node) => (node.callsFunctions ?? []).length > 0);
  const referencing = nodes.filter((node) => (node.callsImports ?? []).length > 0);

  const walk = (roots: readonly GhidraCallNode[]): GhidraReachableApi[] => walkFrom(nodes, roots);

  let rootedAtEntry = entries.length > 0;
  let reachable = walk(entries.length > 0 ? entries : nodes.slice(0, 1));

  // The entry point is the claim worth making, but it cannot always be made.
  // Measured: Ghidra's decompiler wrote `___tmainCRTStartup()` while its own
  // symbol table held `FID_conflict:_wmainCRTStartup`, so the edge out of
  // `entry` could not be resolved by name and the walk stopped immediately --
  // reporting zero on a binary whose read functions call LoadLibraryW,
  // GetProcAddress and IsDebuggerPresent between them.
  //
  // Falling back to each read function as its own root keeps the finding and
  // keeps it honest: `from` names that function, not the entry, and
  // rootedAtEntry says which kind of claim this is.
  if (reachable.length === 0 && referencing.length > 0) {
    rootedAtEntry = false;
    reachable = walk(referencing);
  }

  return {
    reachable,
    entries: (rootedAtEntry ? entries : referencing)
      .map((node) => node.name || node.address)
      .filter(Boolean),
    graphMissing: !hasEdges,
    rootedAtEntry,
  };
}

/** Breadth-first from a set of roots, with the depth and reach caps applied. */
function walkFrom(
  nodes: readonly GhidraCallNode[],
  roots: readonly GhidraCallNode[],
): GhidraReachableApi[] {
  const byKey = new Map<string, GhidraCallNode>();
  for (const node of nodes) {
    if (node.name) {
      byKey.set(node.name.toLowerCase(), node);
    }
    if (node.address) {
      byKey.set(node.address.toLowerCase(), node);
    }
  }
  const reachable: GhidraReachableApi[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const rootLabel = root.name || root.address;
    const visited = new Set<string>();
    let frontier: { node: GhidraCallNode; depth: number }[] = [{ node: root, depth: 0 }];
    while (frontier.length > 0 && reachable.length < MAX_REACHABLE) {
      const next: { node: GhidraCallNode; depth: number }[] = [];
      for (const { node, depth } of frontier) {
        const key = (node.name || node.address).toLowerCase();
        if (visited.has(key)) {
          continue;
        }
        visited.add(key);
        for (const symbol of node.callsImports ?? []) {
          const identity = `${rootLabel}|${symbol}`;
          if (seen.has(identity)) {
            continue;
          }
          seen.add(identity);
          reachable.push({
            symbol,
            from: rootLabel,
            // Depth 0 means the entry itself references it, which reads as 1 call.
            depth: depth + 1,
            via: node.name || node.address,
          });
        }
        if (depth >= MAX_DEPTH) {
          continue;
        }
        for (const callee of node.callsFunctions ?? []) {
          const child = byKey.get(callee.toLowerCase());
          if (child && !visited.has((child.name || child.address).toLowerCase())) {
            next.push({ node: child, depth: depth + 1 });
          }
        }
      }
      frontier = next;
    }
  }
  return reachable.sort(
    (left, right) => left.depth - right.depth || left.symbol.localeCompare(right.symbol),
  );
}

/**
 * Build the call graph out of the decompiled bodies.
 *
 * The engine's function listing carries names and addresses and nothing else --
 * no callees, no API references -- and `gen_callgraph` answered a real 32-bit PE
 * with a diagram holding its root node and no edges at all. So reachability had
 * nothing to walk and reported zero on a binary whose bodies name every call it
 * makes.
 *
 * The bodies are already fetched, which makes this free: an identifier followed
 * by `(` is a call, and it is either an API we know the name of or another
 * function in the inventory. Anything else -- a cast, a macro, a local -- is
 * neither, and is ignored rather than guessed at.
 *
 * The graph is therefore only as complete as the deep read, and the stage says
 * so. A partial graph built from what was actually read beats a complete one
 * that was not.
 */
export function buildCallGraphFromBodies(params: {
  functions: readonly GhidraCallNode[];
  bodies: readonly { name: string; address: string; decompiled: string }[];
  knownApis: readonly string[];
}): { nodes: GhidraCallNode[]; edgeCount: number; bodiesRead: number } {
  const apis = new Map<string, string>();
  for (const symbol of params.knownApis) {
    if (symbol) {
      apis.set(symbol.toLowerCase(), symbol);
    }
  }

  /** Inventory by name and by address, so a body can name either. */
  const byKey = new Map<string, GhidraCallNode>();
  for (const node of params.functions) {
    if (node.name) {
      byKey.set(node.name.toLowerCase(), node);
      // Also under the underscore-stripped name. The call site is read with its
      // leading underscores removed (a decompiler writes thunks as `_name`), so
      // an inventory keyed only by the raw name never matches the CRT: `entry`
      // calls `___tmainCRTStartup`, which was looked up as `tmaincrtstartup`
      // and missed -- leaving the entry point with no outgoing edges at all.
      const stripped = node.name.toLowerCase().replace(/^_+/, '');
      if (stripped && !byKey.has(stripped)) {
        byKey.set(stripped, node);
      }
    }
    if (node.address) {
      byKey.set(node.address.toLowerCase(), node);
      // Ghidra writes addresses with and without the 0x prefix in different
      // places; a body referring to one must still find a node keyed by the other.
      byKey.set(node.address.toLowerCase().replace(/^0x/, ''), node);
    }
  }

  const importsOf = new Map<string, Set<string>>();
  const calleesOf = new Map<string, Set<string>>();
  let edgeCount = 0;

  for (const body of params.bodies) {
    const selfKey = (body.name || body.address).toLowerCase();
    const imports = importsOf.get(selfKey) ?? new Set<string>();
    const callees = calleesOf.get(selfKey) ?? new Set<string>();
    for (const match of body.decompiled.matchAll(/\b_*([A-Za-z_][A-Za-z0-9_]{2,63})\s*\(/g)) {
      const raw = match[1];
      const lowered = raw.toLowerCase();
      const api = apis.get(lowered);
      if (api) {
        imports.add(api);
        continue;
      }
      const callee = byKey.get(lowered);
      if (!callee) {
        continue;
      }
      const calleeKey = (callee.name || callee.address).toLowerCase();
      if (calleeKey === selfKey) {
        // Recursion is an edge to nowhere for a reachability walk.
        continue;
      }
      callees.add(callee.name || callee.address);
    }
    importsOf.set(selfKey, imports);
    calleesOf.set(selfKey, callees);
    edgeCount += callees.size;
  }

  const nodes = params.functions.map((node) => {
    const key = (node.name || node.address).toLowerCase();
    const imports = [...(importsOf.get(key) ?? new Set<string>())].sort();
    const callees = [...(calleesOf.get(key) ?? new Set<string>())].sort();
    return {
      ...node,
      // Anything the listing already knew is kept: it came from the engine and
      // is not worse than what was read out of the text.
      callsImports: [...new Set([...(node.callsImports ?? []), ...imports])],
      callsFunctions: [...new Set([...(node.callsFunctions ?? []), ...callees])],
    };
  });

  return { nodes, edgeCount, bodiesRead: params.bodies.length };
}

/** A mermaid label that cannot break the diagram it goes into. */
function mermaidId(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 48) || 'node';
}

/**
 * Render the derived graph as mermaid.
 *
 * Used when the engine's own diagram came back with no edges, which is what a
 * real run produced. A diagram of one node teaches nothing; this one is drawn
 * from the calls the bodies actually make.
 */
export function mermaidFromCallGraph(nodes: readonly GhidraCallNode[], maxEdges = 60): string {
  const lines = ['flowchart TD'];
  const seen = new Set<string>();
  for (const node of nodes) {
    const from = node.name || node.address;
    for (const callee of node.callsFunctions ?? []) {
      const edge = `${mermaidId(from)} --> ${mermaidId(callee)}`;
      if (seen.has(edge)) {
        continue;
      }
      seen.add(edge);
      lines.push(`  ${edge}`);
      if (seen.size >= maxEdges) {
        return `${lines.join('\n')}\n  %% truncated at ${maxEdges} edges`;
      }
    }
  }
  return seen.size > 0 ? lines.join('\n') : '';
}

/** APIs in the order they appear in a decompiled body. */
export function extractApiSequence(params: {
  name: string;
  address: string;
  decompiled: string;
  known: ReadonlySet<string>;
}): GhidraApiSequence {
  const apis: string[] = [];
  const seen = new Set<string>();
  // A call is an identifier followed by '('. Ghidra prefixes indirect calls and
  // thunks with underscores, so those are stripped before matching.
  for (const match of params.decompiled.matchAll(/\b(_*)([A-Za-z_][A-Za-z0-9_]{2,63})\s*\(/g)) {
    const symbol = match[2];
    if (!params.known.has(symbol.toLowerCase())) {
      continue;
    }
    if (seen.has(symbol)) {
      continue;
    }
    seen.add(symbol);
    apis.push(symbol);
  }
  return { functionName: params.name, address: params.address, apis };
}

/** Does this ordered API list satisfy the spec, in order? */
function matchChain(spec: ChainSpec, apis: readonly string[]): string[] | null {
  const lowered = apis.map(baseName);
  const matched: string[] = [];
  let cursor = 0;
  for (const step of spec.steps) {
    let found = -1;
    for (let index = cursor; index < lowered.length; index += 1) {
      if (step.some((alternative) => lowered[index].includes(alternative))) {
        found = index;
        break;
      }
    }
    if (found < 0) {
      continue;
    }
    matched.push(apis[found]);
    cursor = found + 1;
  }
  return matched.length >= spec.minSteps ? matched : null;
}

/**
 * Name the behaviours the orderings support.
 *
 * A chain found inside ONE function is stronger than the same APIs scattered
 * across the image, because the ordering is real rather than assembled by this
 * code. Both are reported, and they are labelled differently.
 */
export function detectBehaviorChains(
  sequences: readonly GhidraApiSequence[],
  reachable: readonly GhidraReachableApi[] = [],
): GhidraBehaviorChain[] {
  const chains: GhidraBehaviorChain[] = [];
  const claimed = new Set<string>();

  for (const sequence of sequences) {
    for (const spec of CHAIN_SPECS) {
      const matched = matchChain(spec, sequence.apis);
      if (!matched) {
        continue;
      }
      const identity = `${spec.code}|${sequence.address}`;
      if (claimed.has(identity)) {
        continue;
      }
      claimed.add(identity);
      chains.push({
        code: spec.code,
        title: spec.title,
        detail: spec.detail,
        apis: matched,
        functionName: sequence.functionName,
        address: sequence.address,
        confidence: 'strong',
      });
    }
  }

  // Whole-image fallback: the APIs are all reachable but no single function
  // holds the ordering. Worth saying, and worth marking as the weaker claim.
  const imageApis = [...new Set(reachable.map((entry) => entry.symbol))];
  for (const spec of CHAIN_SPECS) {
    if (chains.some((chain) => chain.code === spec.code)) {
      continue;
    }
    const matched = matchChain(spec, imageApis);
    if (!matched) {
      continue;
    }
    chains.push({
      code: spec.code,
      title: spec.title,
      detail: `${spec.detail} These APIs are reachable from the entry point but no single function was read that calls them in this order, so the ordering here is the image's, not a function's.`,
      apis: matched,
      functionName: '',
      address: '',
      confidence: 'moderate',
    });
  }

  return chains;
}

/**
 * Everything the behaviour stage produces.
 *
 * `known` is the union of imported and dynamically resolved APIs -- passing the
 * resolved ones in is what makes this work on an obfuscated binary, where the
 * import table alone would leave every sequence empty.
 */
export function synthesizeBehavior(params: {
  nodes: readonly GhidraCallNode[];
  bodies: readonly { name: string; address: string; decompiled: string }[];
  knownApis: readonly string[];
}): GhidraBehaviorResult {
  const known = new Set(params.knownApis.map((symbol) => symbol.toLowerCase()));
  const { reachable, entries, graphMissing, rootedAtEntry } = computeReachableApis(params.nodes);
  const sequences = params.bodies
    .map((body) =>
      extractApiSequence({
        name: body.name,
        address: body.address,
        decompiled: body.decompiled,
        known,
      }),
    )
    .filter((sequence) => sequence.apis.length > 1);
  const chains = detectBehaviorChains(sequences, reachable);
  return { reachable, sequences, chains, entries, graphMissing, rootedAtEntry };
}

/** The API categories a reachable set touches, for the report's summary line. */
export function summarizeReachableCategories(
  reachable: readonly GhidraReachableApi[],
): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of reachable) {
    for (const hit of categorizeApi(entry.symbol)) {
      counts.set(hit.category, (counts.get(hit.category) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category));
}
