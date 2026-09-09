// @vitest-environment node
//
// The hardest thing to keep right here is the WORDING. Static analysis cannot
// say a binary did anything; it can say what is reachable and in what order. The
// tests check the claim strength as carefully as they check the detection,
// because a chain labelled 'strong' when the ordering was assembled by this code
// rather than found in one function would be the report telling a small lie.
import { describe, expect, it } from 'vitest';

import {
  computeReachableApis,
  detectBehaviorChains,
  extractApiSequence,
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
