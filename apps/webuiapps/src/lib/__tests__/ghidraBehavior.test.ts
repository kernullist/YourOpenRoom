// @vitest-environment node
//
// The hardest thing to keep right here is the WORDING. Static analysis cannot
// say a binary did anything; it can say what is reachable and in what order. The
// tests check the claim strength as carefully as they check the detection,
// because a chain labelled 'strong' when the ordering was assembled by this code
// rather than found in one function would be the report telling a small lie.
import { describe, expect, it } from 'vitest';

import {
  buildCallGraphFromBodies,
  computeReachableApis,
  selectFrontier,
  detectBehaviorChains,
  extractApiSequence,
  mermaidFromCallGraph,
  summarizeReachableCategories,
  synthesizeBehavior,
  type GhidraCallNode,
} from '../ghidraBehavior';

describe('computeReachableApis', () => {
  it('walks from the entry point through callees and records the depth', () => {
    const { reachable, entries } = computeReachableApis([
      { name: 'entry', address: '0x1000', isEntryPoint: true, callsFunctions: ['stage1'] },
      {
        name: 'stage1',
        address: '0x2000',
        callsFunctions: ['stage2'],
        callsImports: ['VirtualAlloc'],
      },
      { name: 'stage2', address: '0x3000', callsImports: ['CreateRemoteThread'] },
      { name: 'orphan', address: '0x9000', callsImports: ['MessageBoxA'] },
    ]);
    expect(entries).toEqual(['entry']);
    const symbols = reachable.map((entry) => entry.symbol);
    expect(symbols).toContain('VirtualAlloc');
    expect(symbols).toContain('CreateRemoteThread');
    // Nothing calls the orphan, so it is not reachable from the entry and must
    // not be presented as if it were.
    expect(symbols).not.toContain('MessageBoxA');
    expect(reachable.find((entry) => entry.symbol === 'CreateRemoteThread')?.via).toBe('stage2');
  });

  it('falls back to the read functions when no path from the entry resolves', () => {
    // Measured: Ghidra's decompiler wrote `___tmainCRTStartup()` while its own
    // symbol table held `FID_conflict:_wmainCRTStartup`, so the edge out of
    // `entry` could not be resolved by name. Reporting zero after reading a
    // function that plainly calls LoadLibraryW helps nobody -- but the claim
    // has to change with it.
    const result = computeReachableApis([
      { name: 'entry', address: '0x1', isEntryPoint: true, callsFunctions: ['___tmainCRTStartup'] },
      { name: 'GetPdbDll', address: '0x2', callsImports: ['LoadLibraryW'] },
    ]);
    expect(result.rootedAtEntry).toBe(false);
    expect(result.reachable.map((entry) => entry.symbol)).toEqual(['LoadLibraryW']);
    // `from` names the function, never the entry point.
    expect(result.reachable[0].from).toBe('GetPdbDll');
    expect(result.entries).toEqual(['GetPdbDll']);
  });

  it('keeps the stronger claim whenever the entry point does reach something', () => {
    const result = computeReachableApis([
      { name: 'entry', address: '0x1', isEntryPoint: true, callsFunctions: ['worker'] },
      { name: 'worker', address: '0x2', callsImports: ['Sleep'] },
      { name: 'orphan', address: '0x3', callsImports: ['MessageBoxA'] },
    ]);
    expect(result.rootedAtEntry).toBe(true);
    // The orphan is not reachable from the entry and must not be smuggled in.
    expect(result.reachable.map((entry) => entry.symbol)).toEqual(['Sleep']);
  });

  it('says when the engine gave it no edges to walk', () => {
    const { graphMissing } = computeReachableApis([
      { name: 'a', address: '0x1', callsImports: ['Sleep'] },
    ]);
    expect(graphMissing).toBe(true);
  });

  it('falls back to exports when there is no entry point', () => {
    const { entries } = computeReachableApis([
      { name: 'DllMain', address: '0x1', isExport: true, callsImports: ['Sleep'] },
      { name: 'helper', address: '0x2' },
    ]);
    expect(entries).toEqual(['DllMain']);
  });

  it('stops at a depth where the claim still means something', () => {
    const chain: GhidraCallNode[] = Array.from({ length: 20 }, (_unused, index) => ({
      name: `f${index}`,
      address: `0x${index}`,
      callsFunctions: [`f${index + 1}`],
      callsImports: [`Api${index}`],
      isEntryPoint: index === 0,
    }));
    const { reachable } = computeReachableApis(chain);
    // An API twenty calls from the entry is technically reachable and tells a
    // reader nothing.
    expect(reachable.every((entry) => entry.depth <= 8)).toBe(true);
  });

  it('survives a cycle in the call graph', () => {
    const { reachable } = computeReachableApis([
      { name: 'a', address: '0x1', isEntryPoint: true, callsFunctions: ['b'] },
      { name: 'b', address: '0x2', callsFunctions: ['a'], callsImports: ['Sleep'] },
    ]);
    expect(reachable.map((entry) => entry.symbol)).toEqual(['Sleep']);
  });
});

describe('extractApiSequence', () => {
  it('lists the APIs in the order they appear, and only the known ones', () => {
    const sequence = extractApiSequence({
      name: 'inject',
      address: '0x1000',
      decompiled: [
        'h = OpenProcess(0x1fffff, 0, pid);',
        'p = VirtualAllocEx(h, 0, len, 0x3000, 0x40);',
        'local_helper(p);',
        'WriteProcessMemory(h, p, buf, len, 0);',
      ].join('\n'),
      known: new Set(['openprocess', 'virtualallocex', 'writeprocessmemory']),
    });
    expect(sequence.apis).toEqual(['OpenProcess', 'VirtualAllocEx', 'WriteProcessMemory']);
  });

  it('reads through the underscore prefix a decompiler puts on thunks', () => {
    const sequence = extractApiSequence({
      name: 'f',
      address: '0x1',
      decompiled: '_Sleep(1000);',
      known: new Set(['sleep']),
    });
    expect(sequence.apis).toEqual(['Sleep']);
  });
});

describe('detectBehaviorChains', () => {
  it('names process injection when one function calls the sequence in order', () => {
    const [chain] = detectBehaviorChains([
      {
        functionName: 'inject',
        address: '0x1000',
        apis: ['OpenProcess', 'VirtualAllocEx', 'WriteProcessMemory', 'CreateRemoteThread'],
      },
    ]);
    expect(chain.code).toBe('process_injection');
    // The ordering was found in one function, so the claim is the strong one.
    expect(chain.confidence).toBe('strong');
    expect(chain.functionName).toBe('inject');
    expect(chain.apis).toEqual([
      'OpenProcess',
      'VirtualAllocEx',
      'WriteProcessMemory',
      'CreateRemoteThread',
    ]);
  });

  it('refuses the chain when the APIs are there but out of order', () => {
    const chains = detectBehaviorChains([
      {
        functionName: 'scattered',
        address: '0x1000',
        apis: ['CreateRemoteThread', 'OpenProcess'],
      },
    ]);
    // Two of four steps, and backwards. Ordering is the whole claim.
    expect(chains.filter((chain) => chain.code === 'process_injection')).toEqual([]);
  });

  it('marks a whole-image match as the weaker claim, and says why', () => {
    const chains = detectBehaviorChains(
      [],
      [
        { symbol: 'OpenProcess', from: 'entry', depth: 1, via: 'a' },
        { symbol: 'VirtualAllocEx', from: 'entry', depth: 2, via: 'b' },
        { symbol: 'WriteProcessMemory', from: 'entry', depth: 3, via: 'c' },
      ],
    );
    const injection = chains.find((chain) => chain.code === 'process_injection');
    expect(injection?.confidence).toBe('moderate');
    expect(injection?.functionName).toBe('');
    expect(injection?.detail).toContain("the image's, not a function's");
  });

  it('prefers the in-function match over the whole-image one for the same behaviour', () => {
    const chains = detectBehaviorChains(
      [
        {
          functionName: 'inject',
          address: '0x1000',
          apis: ['OpenProcess', 'VirtualAllocEx', 'WriteProcessMemory'],
        },
      ],
      [
        { symbol: 'OpenProcess', from: 'entry', depth: 1, via: 'a' },
        { symbol: 'VirtualAllocEx', from: 'entry', depth: 2, via: 'b' },
        { symbol: 'WriteProcessMemory', from: 'entry', depth: 3, via: 'c' },
      ],
    );
    expect(chains.filter((chain) => chain.code === 'process_injection')).toHaveLength(1);
    expect(chains[0].confidence).toBe('strong');
  });

  it('matches through the A/W suffix rather than needing every spelling listed', () => {
    const [chain] = detectBehaviorChains([
      {
        functionName: 'persist',
        address: '0x1',
        apis: ['RegCreateKeyExW', 'RegSetValueExW'],
      },
    ]);
    expect(chain.code).toBe('persistence_registry');
  });

  it('names loading a kernel driver, which is the strongest thing a user-mode binary can do', () => {
    const [chain] = detectBehaviorChains([
      { functionName: 'load', address: '0x1', apis: ['CreateFileW', 'NtLoadDriver'] },
    ]);
    expect(chain.code).toBe('driver_load');
    expect(chain.detail).toContain('strongest');
  });

  it('says nothing for a program that just draws a window', () => {
    expect(
      detectBehaviorChains([
        { functionName: 'main', address: '0x1', apis: ['MessageBoxA', 'GetMessageW'] },
      ]),
    ).toEqual([]);
  });
});

describe('synthesizeBehavior', () => {
  it('uses the dynamically resolved APIs, not only the imported ones', () => {
    // This is what makes the stage work on an obfuscated binary: the import
    // table has none of these names, so `known` from imports alone would leave
    // every sequence empty and the report would say the binary does nothing.
    const result = synthesizeBehavior({
      nodes: [
        {
          name: 'inject',
          address: '0x1000',
          isEntryPoint: true,
          callsImports: ['GetProcAddress'],
        },
      ],
      bodies: [
        {
          name: 'inject',
          address: '0x1000',
          decompiled: [
            'h = OpenProcess(a, b, c);',
            'p = VirtualAllocEx(h, 0, n, 0x3000, 0x40);',
            'WriteProcessMemory(h, p, buf, n, 0);',
            'CreateRemoteThread(h, 0, 0, p, 0, 0, 0);',
          ].join('\n'),
        },
      ],
      knownApis: [
        'GetProcAddress',
        'OpenProcess',
        'VirtualAllocEx',
        'WriteProcessMemory',
        'CreateRemoteThread',
      ],
    });
    expect(result.chains.map((chain) => chain.code)).toContain('process_injection');
    expect(result.sequences[0].apis).toHaveLength(4);
  });

  it('drops a function that references only one API, which is not a sequence', () => {
    const result = synthesizeBehavior({
      nodes: [],
      bodies: [{ name: 'f', address: '0x1', decompiled: 'Sleep(100);' }],
      knownApis: ['Sleep'],
    });
    expect(result.sequences).toEqual([]);
  });
});

describe('summarizeReachableCategories', () => {
  it('rolls the reachable set up into the categories a reader scans first', () => {
    const summary = summarizeReachableCategories([
      { symbol: 'WriteProcessMemory', from: 'entry', depth: 1, via: 'a' },
      { symbol: 'CreateRemoteThread', from: 'entry', depth: 2, via: 'b' },
      { symbol: 'IsDebuggerPresent', from: 'entry', depth: 1, via: 'c' },
    ]);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.map((entry) => entry.category)).toContain('anti-debug');
  });

  it('is empty for an empty set rather than inventing a category', () => {
    expect(summarizeReachableCategories([])).toEqual([]);
  });
});

describe('buildCallGraphFromBodies', () => {
  // Measured on a real 32-bit PE: the engine's function listing carried names
  // and addresses and nothing else, and gen_callgraph answered with its root
  // node and no edges. Reachability therefore reported zero on a binary whose
  // 28 decompiled bodies name every call it makes.

  const inventory = [
    { name: 'entry', address: '0x1000', isEntryPoint: true },
    { name: 'GetPdbDll', address: '0x2000' },
    { name: 'FUN_00403000', address: '0x3000' },
    { name: 'unread', address: '0x4000' },
  ];

  it('recovers callee edges and API references from the bodies alone', () => {
    const graph = buildCallGraphFromBodies({
      functions: inventory,
      bodies: [
        { name: 'entry', address: '0x1000', decompiled: 'GetPdbDll();\nreturn 0;' },
        {
          name: 'GetPdbDll',
          address: '0x2000',
          decompiled: [
            'h = RegOpenKeyExW(HKEY_LOCAL_MACHINE, path, 0, 0x20019, &key);',
            'RegQueryValueExW(key, name, 0, &type, buf, &len);',
            'FUN_00403000(buf);',
            'RegCloseKey(key);',
          ].join('\n'),
        },
      ],
      knownApis: ['RegOpenKeyExW', 'RegQueryValueExW', 'RegCloseKey'],
    });

    const byName = new Map(graph.nodes.map((node) => [node.name, node]));
    expect(byName.get('entry')?.callsFunctions).toEqual(['GetPdbDll']);
    expect(byName.get('GetPdbDll')?.callsImports).toEqual([
      'RegCloseKey',
      'RegOpenKeyExW',
      'RegQueryValueExW',
    ]);
    expect(byName.get('GetPdbDll')?.callsFunctions).toEqual(['FUN_00403000']);
    expect(graph.edgeCount).toBe(2);
    expect(graph.bodiesRead).toBe(2);
  });

  it('makes the APIs reachable from the entry point, which is the whole point', () => {
    const graph = buildCallGraphFromBodies({
      functions: inventory,
      bodies: [
        { name: 'entry', address: '0x1000', decompiled: 'GetPdbDll();' },
        { name: 'GetPdbDll', address: '0x2000', decompiled: 'RegOpenKeyExW(a, b, c, d, e);' },
      ],
      knownApis: ['RegOpenKeyExW'],
    });
    const { reachable, graphMissing } = computeReachableApis(graph.nodes);
    expect(graphMissing).toBe(false);
    expect(reachable.map((entry) => entry.symbol)).toEqual(['RegOpenKeyExW']);
    expect(reachable[0].from).toBe('entry');
    expect(reachable[0].via).toBe('GetPdbDll');
  });

  it('ignores anything that is neither a known API nor a function in the image', () => {
    // A cast, a macro, a local helper the listing never mentioned: guessing at
    // these would put edges in the graph that the evidence does not support.
    const graph = buildCallGraphFromBodies({
      functions: inventory,
      bodies: [
        {
          name: 'entry',
          address: '0x1000',
          decompiled: 'if (x) { while (y) { local_thing(z); memset(buf, 0, n); } }',
        },
      ],
      knownApis: ['RegOpenKeyExW'],
    });
    const entry = graph.nodes.find((node) => node.name === 'entry');
    expect(entry?.callsFunctions).toEqual([]);
    expect(entry?.callsImports).toEqual([]);
  });

  it('reads through the underscore a decompiler puts on a thunk', () => {
    const graph = buildCallGraphFromBodies({
      functions: inventory,
      bodies: [{ name: 'entry', address: '0x1000', decompiled: '_RegCloseKey(key);' }],
      knownApis: ['RegCloseKey'],
    });
    expect(graph.nodes.find((node) => node.name === 'entry')?.callsImports).toEqual([
      'RegCloseKey',
    ]);
  });

  it('matches a CRT thunk the decompiler wrote with leading underscores', () => {
    // Measured: `entry` calls `___tmainCRTStartup()`. The call site is read with
    // its underscores stripped, so an inventory keyed only by the raw name never
    // matched and the entry point came out with no outgoing edges -- which made
    // reachability zero on a binary whose graph was right there.
    const graph = buildCallGraphFromBodies({
      functions: [
        { name: 'entry', address: '0x1000', isEntryPoint: true },
        { name: '___tmainCRTStartup', address: '0x2000' },
      ],
      bodies: [
        { name: 'entry', address: '0x1000', decompiled: '___tmainCRTStartup();' },
        { name: '___tmainCRTStartup', address: '0x2000', decompiled: 'Sleep(1);' },
      ],
      knownApis: ['Sleep'],
    });
    expect(graph.nodes[0].callsFunctions).toEqual(['___tmainCRTStartup']);
    const { reachable } = computeReachableApis(graph.nodes);
    expect(reachable.map((entry) => entry.symbol)).toEqual(['Sleep']);
  });

  it('drops self-recursion, which is an edge to nowhere for a walk', () => {
    const graph = buildCallGraphFromBodies({
      functions: inventory,
      bodies: [{ name: 'GetPdbDll', address: '0x2000', decompiled: 'GetPdbDll(n - 1);' }],
      knownApis: [],
    });
    expect(graph.nodes.find((node) => node.name === 'GetPdbDll')?.callsFunctions).toEqual([]);
    expect(graph.edgeCount).toBe(0);
  });

  it('keeps what the listing already knew rather than replacing it', () => {
    const graph = buildCallGraphFromBodies({
      functions: [{ name: 'entry', address: '0x1000', callsImports: ['Sleep'] }],
      bodies: [{ name: 'entry', address: '0x1000', decompiled: 'RegCloseKey(k);' }],
      knownApis: ['RegCloseKey'],
    });
    // The engine's own answer is not worse than what was read out of the text.
    expect(graph.nodes[0].callsImports).toEqual(['Sleep', 'RegCloseKey']);
  });

  it('leaves a function with no body untouched, and says how many it read', () => {
    const graph = buildCallGraphFromBodies({ functions: inventory, bodies: [], knownApis: [] });
    expect(graph.bodiesRead).toBe(0);
    expect(graph.edgeCount).toBe(0);
    expect(graph.nodes.every((node) => (node.callsFunctions ?? []).length === 0)).toBe(true);
  });
});

describe('mermaidFromCallGraph', () => {
  it('draws the edges the bodies contained', () => {
    const diagram = mermaidFromCallGraph([
      { name: 'entry', address: '0x1', callsFunctions: ['GetPdbDll'] },
      { name: 'GetPdbDll', address: '0x2', callsFunctions: ['FUN_00403000'] },
    ]);
    expect(diagram).toContain('flowchart TD');
    expect(diagram).toContain('entry --> GetPdbDll');
    expect(diagram).toContain('GetPdbDll --> FUN_00403000');
  });

  it('returns nothing when there is nothing to draw', () => {
    // Better an absent diagram than a picture of one box, which is what the
    // engine handed back on a real run.
    expect(mermaidFromCallGraph([{ name: 'entry', address: '0x1' }])).toBe('');
  });

  it('sanitises a name that would break the diagram', () => {
    const diagram = mermaidFromCallGraph([
      { name: 'operator new[]', address: '0x1', callsFunctions: ['std::_Xlen'] },
    ]);
    expect(diagram).not.toContain('[]');
    expect(diagram).toContain('-->');
  });

  it('stops at the edge cap rather than emitting an unreadable wall', () => {
    const nodes = Array.from({ length: 200 }, (_unused, index) => ({
      name: `f${index}`,
      address: `0x${index}`,
      callsFunctions: [`f${index + 1}`],
    }));
    const diagram = mermaidFromCallGraph(nodes, 10);
    expect(diagram).toContain('truncated at 10 edges');
    expect(diagram.split('-->').length - 1).toBe(10);
  });
});

describe('selectFrontier and the keys it trusts', () => {
  const node = (over: Partial<GhidraCallNode>): GhidraCallNode => ({
    name: '',
    address: '',
    callsFunctions: [],
    callsImports: [],
    isEntryPoint: false,
    isExport: false,
    ...over,
  });

  it('does not treat a function as read because its namesake was', () => {
    // 36 of one binary's 128 functions share a name with a function at another
    // address. Judging "already read" by name marked the twin as read too, and
    // the frontier then refused to expand to code nobody had looked at.
    const nodes = [
      node({ name: 'entry', address: '00401000', isEntryPoint: true, callsFunctions: ['strcmp'] }),
      node({ name: 'strcmp', address: '00402000' }),
      node({ name: 'strcmp', address: '00403000' }),
    ];
    const frontier = selectFrontier({
      nodes,
      // The entry point and ONE of the two strcmps have been read.
      read: new Set(['entry', '00401000', 'strcmp', '00402000']),
      limit: 8,
    });
    expect(frontier.names).toContain('strcmp');
  });

  it('falls back to the name for a node the engine gave no address', () => {
    const nodes = [
      node({ name: 'root', isEntryPoint: true, callsFunctions: ['leaf'] }),
      node({ name: 'leaf' }),
    ];
    expect(selectFrontier({ nodes, read: new Set(['root']), limit: 8 }).names).toEqual(['leaf']);
    expect(selectFrontier({ nodes, read: new Set(['root', 'leaf']), limit: 8 }).names).toEqual([]);
  });
});
