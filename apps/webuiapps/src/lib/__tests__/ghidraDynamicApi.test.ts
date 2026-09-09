// @vitest-environment node
//
// The import table of an obfuscated binary lists LoadLibrary, GetProcAddress and
// almost nothing else. A report built from it describes a program that does
// nothing, which is worse than saying nothing at all -- so these are the three
// routes back to the real API surface, and the line each of them must not cross.
import { describe, expect, it } from 'vitest';

import { findDynamicApis } from '../ghidraDynamicApi';

function body(name: string, address: string, decompiled: string) {
  return { name, address, decompiled };
}

describe('findDynamicApis', () => {
  it('reads the API name out of a quoted argument', () => {
    const found = findDynamicApis({
      bodies: [
        body(
          'resolve_all',
          '0x401000',
          [
            'HMODULE h = LoadLibraryA("ntdll.dll");',
            'pNtWrite = GetProcAddress(h, "NtWriteVirtualMemory");',
          ].join('\n'),
        ),
      ],
      imports: [{ symbol: 'LoadLibraryA', library: 'kernel32.dll' }],
    });
    expect(found.resolved.map((entry) => entry.symbol)).toContain('NtWriteVirtualMemory');
    const api = found.resolved.find((entry) => entry.symbol === 'NtWriteVirtualMemory');
    expect(api?.evidence).toBe('literal');
    expect(api?.functionName).toBe('resolve_all');
    // The module half comes off the loader call and is worth keeping.
    expect(found.resolved.some((entry) => entry.library === 'ntdll.dll')).toBe(true);
  });

  it("reads it out of Ghidra's auto-named string data too", () => {
    // Ghidra names string data `s_<text>_<addr>`, so the same call through a
    // data reference is still readable and must not be missed.
    const found = findDynamicApis({
      bodies: [
        body(
          'FUN_00401500',
          '0x401500',
          'pCreate = (code *)(*_GetProcAddress)(hMod, s_CreateRemoteThread_00402100);',
        ),
      ],
      imports: [],
    });
    const api = found.resolved.find((entry) => entry.symbol === 'CreateRemoteThread');
    expect(api).toBeDefined();
    expect(api?.evidence).toBe('string_symbol');
  });

  it('uses a FLOSS-recovered string where the call site has no literal', () => {
    // This is the case that only works because the recovered-strings stage ran
    // first: the name exists nowhere in the binary as text.
    const found = findDynamicApis({
      bodies: [body('resolver', '0x401000', 'p = GetProcAddress(h, decoded_buffer);')],
      imports: [],
      recovered: [{ value: 'NtProtectVirtualMemory', decodingRoutine: '0x402000' }],
    });
    const api = found.resolved.find((entry) => entry.symbol === 'NtProtectVirtualMemory');
    expect(api?.evidence).toBe('recovered_string');
  });

  it('does not attach recovered strings to functions that resolve nothing', () => {
    const found = findDynamicApis({
      bodies: [body('unrelated', '0x401000', 'int x = compute(a, b);')],
      imports: [],
      recovered: [{ value: 'NtProtectVirtualMemory', decodingRoutine: '0x402000' }],
    });
    expect(found.resolved).toEqual([]);
  });

  it('ignores arguments that are not shaped like an API name', () => {
    const found = findDynamicApis({
      bodies: [
        body('resolver', '0x401000', 'p = GetProcAddress(h, "not an api name with spaces");'),
      ],
      imports: [],
    });
    expect(found.resolved.filter((entry) => entry.symbol)).toEqual([]);
    // The site still counts: something is being resolved even if the name is not
    // recoverable, and that is worth telling the reader.
    expect(found.resolverSites[0]?.functionName).toBe('resolver');
  });

  it('names API hashing as a TECHNIQUE and never as a resolved API', () => {
    // The names are not recoverable without the hash table. Emitting one here
    // would be exactly the invention the ledger exists to prevent.
    const found = findDynamicApis({
      bodies: [
        body(
          'hash_resolve',
          '0x401000',
          [
            'for (i = 0; name[i] != 0; i++) {',
            '  hash = (hash >> 0xd) | (hash << 0x13);',
            '  hash = hash + name[i];',
            '}',
          ].join('\n'),
        ),
      ],
      imports: [],
    });
    expect(found.hashing.map((entry) => entry.code)).toContain('api_hashing');
    expect(found.hashing[0].detail).toContain('T1027.007');
    expect(found.resolved.filter((entry) => entry.symbol)).toEqual([]);
  });

  it('recognises a djb2 seed inside a byte loop, and names the algorithm', () => {
    const found = findDynamicApis({
      bodies: [
        body(
          'djb2',
          '0x401000',
          ['h = 5381;', 'for (i = 0; s[i]; i++) {', '  h = h * 33 + s[i];', '}'].join('\n'),
        ),
      ],
      imports: [],
    });
    expect(found.hashing[0].evidence.join(' ')).toContain('djb2');
  });

  it('calls out an import table that can resolve more than it lists', () => {
    // The strongest signal of all, and it needs no decompilation.
    const found = findDynamicApis({
      bodies: [],
      imports: [
        { symbol: 'LoadLibraryA' },
        { symbol: 'GetProcAddress' },
        { symbol: 'ExitProcess' },
      ],
    });
    const minimal = found.hashing.find((entry) => entry.code === 'resolution_only_imports');
    expect(minimal).toBeDefined();
    expect(minimal?.detail).toContain('3 entries');
  });

  it('does not call a full import table suspicious', () => {
    const imports = Array.from({ length: 60 }, (_unused, index) => ({ symbol: `Api${index}` }));
    const found = findDynamicApis({
      bodies: [],
      imports: [...imports, { symbol: 'GetProcAddress' }],
    });
    expect(found.hashing.some((entry) => entry.code === 'resolution_only_imports')).toBe(false);
  });

  it('flags a function that walks the PEB, which resolves without importing at all', () => {
    const found = findDynamicApis({
      bodies: [
        body('peb_walk', '0x401000', 'ldr = peb->LdrData; e = ldr->InMemoryOrderModuleList;'),
      ],
      imports: [],
    });
    expect(found.hashing[0]?.evidence.join(' ')).toContain('PEB');
  });

  it('reports nothing at all for an ordinary binary', () => {
    const found = findDynamicApis({
      bodies: [body('main', '0x401000', 'printf("hello");\nreturn 0;')],
      imports: [
        { symbol: 'printf' },
        ...Array.from({ length: 40 }, (_u, i) => ({ symbol: `F${i}` })),
      ],
    });
    expect(found.resolved).toEqual([]);
    expect(found.hashing).toEqual([]);
    expect(found.resolverSites).toEqual([]);
  });
});
