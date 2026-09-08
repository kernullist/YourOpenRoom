// @vitest-environment node
//
// The sweep turns engine answers into an evidence ledger. Two properties matter
// more than the happy path:
//
//   - A stage that fails must not abort the sweep. A binary whose strings could
//     not be read still deserves a report about its imports, and the report has
//     to be able to say which stage came up empty.
//   - Field extraction must survive the shapes pyghidra-mcp actually returns
//     across versions, because there is no schema to pin to.
import { describe, expect, it } from 'vitest';

import { normalizeGhidraLabConfig } from '../ghidraLabConfig';
import type { GhidraLabQueryOutcome } from '../ghidraLabSession';
import {
  GHIDRA_DECOMPILE_CHARS,
  GHIDRA_DEEP_READ_LIMIT,
  GHIDRA_DEEP_READ_TOTAL_CHARS,
  extractCallgraph,
  extractCapaMatches,
  extractDecompiled,
  extractFunctions,
  findDecompiledBody,
  extractImports,
  extractSectionNames,
  extractStrings,
  runGhidraSweep,
  type GhidraSweepDeps,
} from '../ghidraLabSweep';
import type { GhidraSweepStage } from '../ghidraLabTypes';

const BINARY = 'C:\\bins\\client.exe';

function outcome(
  rows: unknown[],
  overrides: Partial<GhidraLabQueryOutcome> = {},
): GhidraLabQueryOutcome {
  return {
    ok: true,
    kind: null,
    mcpTool: 'fake',
    rows,
    rowCount: rows.length,
    truncated: false,
    elapsedMs: 1,
    engineError: '',
    reason: '',
    ...overrides,
  };
}

function failure(reason: string): GhidraLabQueryOutcome {
  return {
    ok: false,
    kind: null,
    mcpTool: 'fake',
    rows: [],
    rowCount: 0,
    truncated: false,
    elapsedMs: 1,
    engineError: reason,
    reason: 'engine_error',
  };
}

interface SweepWorld {
  answers: Partial<Record<string, GhidraLabQueryOutcome | (() => GhidraLabQueryOutcome)>>;
  deps: Partial<GhidraSweepDeps>;
}

function makeDeps(world: SweepWorld = { answers: {}, deps: {} }): GhidraSweepDeps {
  const queries: { kind: string; args: Record<string, unknown> }[] = [];
  const base: GhidraSweepDeps = {
    async query(_sessionId, kind, args) {
      queries.push({ kind, args });
      const canned = world.answers[kind];
      if (typeof canned === 'function') {
        return canned();
      }
      return canned ?? outcome([]);
    },
    hashFile: () => ({ sha256: 'a'.repeat(64), sizeBytes: 1024, mtimeMs: 0 }),
    now: () => 1_000,
    ...world.deps,
  };
  (base as unknown as { queries: typeof queries }).queries = queries;
  return base;
}

function queriesOf(deps: GhidraSweepDeps): { kind: string; args: Record<string, unknown> }[] {
  return (deps as unknown as { queries: { kind: string; args: Record<string, unknown> }[] })
    .queries;
}

function stage(ledger: Awaited<ReturnType<typeof runGhidraSweep>>, name: GhidraSweepStage) {
  const found = ledger.stages.find((entry) => entry.stage === name);
  if (!found) {
    throw new Error(`no stage ${name}`);
  }
  return found;
}

const config = normalizeGhidraLabConfig({
  ghidraInstallDir: 'C:\\ghidra',
  jdkHome: 'C:\\jdk21',
  projectRoot: 'C:\\projects',
});

async function sweep(world: SweepWorld) {
  const deps = makeDeps(world);
  const ledger = await runGhidraSweep({
    runId: 'run-1',
    sessionId: 'sess-1',
    binaryPath: BINARY,
    binaryName: 'client.exe',
    config,
    deps,
  });
  return { ledger, deps };
}

describe('runGhidraSweep', () => {
  it('walks every stage and anchors what it found', async () => {
    const { ledger } = await sweep({
      answers: {
        metadata: outcome([{ name: 'client.exe', format: 'PE', arch: 'x86:LE:64' }]),
        imports: outcome([
          { library: 'kernel32.dll', name: 'WriteProcessMemory' },
          { library: 'ntdll.dll', name: 'NtLoadDriver' },
        ]),
        exports: outcome([{ name: 'DllMain', address: '0x140001000' }]),
        strings: outcome([
          { value: 'https://c2.example.com', address: '0x1400a0000' },
          { value: '\\\\.\\Tvk', address: '0x1400a0100' },
        ]),
        functions: outcome([
          { name: 'DllMain', address: '0x140001000', size: 512, calls: ['WriteProcessMemory'] },
          { name: 'sub_140002000', address: '0x140002000', size: 64 },
        ]),
        decompile: outcome([{ name: 'DllMain', decompiled: 'int DllMain(void){ return 1; }' }]),
        callgraph: outcome(['graph TD; DllMain --> sub_140002000']),
      },
      deps: {},
    });

    expect(ledger.sha256).toHaveLength(64);
    expect(ledger.sizeBytes).toBe(1024);
    expect(stage(ledger, 'identity').state).toBe('done');
    expect(stage(ledger, 'imports').state).toBe('done');
    expect(stage(ledger, 'imports').summary).toContain('2 imports');
    expect(stage(ledger, 'exports').summary).toContain('1 exports');
    expect(stage(ledger, 'strings').summary).toContain('url');
    expect(stage(ledger, 'structure').state).toBe('done');

    const ids = ledger.anchors.map((entry) => entry.id);
    expect(ids).toContain('header:sha256');
    // Anchor ids come from the shared builders and carry the symbol alone; which
    // library it came from lives in the anchor detail, so a citation can be
    // built by code that only has a symbol name.
    expect(ids).toContain('import:WriteProcessMemory');
    expect(ids).toContain('export:DllMain');
    expect(ids.some((id) => id.startsWith('string:'))).toBe(true);
    expect(ids).toContain('function:0x140001000');
    expect(ids).toContain('callgraph:DllMain');
  });

  it('leaves the binary name to the session, which knows the engine name', async () => {
    // The engine renames the binary at import (/client.exe-ab12cd), so a
    // sweep-supplied filename would win over the correct one and fail every
    // stage.
    const { deps } = await sweep({ answers: {}, deps: {} });
    for (const query of queriesOf(deps)) {
      expect(query.args.binary_name).toBeUndefined();
    }
  });

  it('keeps going when one stage fails, and records why', async () => {
    const { ledger } = await sweep({
      answers: {
        imports: failure('decompiler unavailable'),
        exports: outcome([{ name: 'Start', address: '0x1000' }]),
      },
      deps: {},
    });
    expect(stage(ledger, 'imports').state).toBe('failed');
    expect(stage(ledger, 'imports').detail).toContain('decompiler unavailable');
    // Later stages still ran.
    expect(stage(ledger, 'exports').state).toBe('done');
    expect(stage(ledger, 'structure').state).toBe('done');
  });

  it('does not throw when the file cannot be hashed', async () => {
    const { ledger } = await sweep({
      answers: {},
      deps: {
        hashFile: () => {
          throw new Error('ENOENT');
        },
      },
    });
    expect(stage(ledger, 'identity').state).toBe('failed');
    expect(stage(ledger, 'exports').state).toBe('done');
  });

  it('waits for the engine to build its string index before recording zero', async () => {
    // The index is built after analysis, on a background task: a session that is
    // legitimately ready can answer "no strings" for a while. Measured on a
    // binary with 132 strings that reported zero immediately after readiness.
    let attempt = 0;
    let slept = 0;
    const deps = makeDeps({
      answers: {
        strings: () => {
          attempt += 1;
          return attempt < 3
            ? outcome([])
            : outcome([{ value: 'https://example.com', address: '0x1' }]);
        },
      },
      deps: {
        sleep: async (ms: number) => {
          slept += ms;
        },
      },
    });
    const ledger = await runGhidraSweep({
      runId: 'run-1',
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
      deps,
    });
    expect(attempt).toBeGreaterThanOrEqual(3);
    expect(slept).toBeGreaterThan(0);
    expect(stage(ledger, 'strings').summary).toContain('1 strings');
    expect(stage(ledger, 'strings').detail).toContain('waited');
  });

  it('does not wait when the engine reports an error rather than an empty index', async () => {
    let slept = 0;
    const deps = makeDeps({
      answers: { strings: failure('engine down') },
      deps: {
        sleep: async (ms: number) => {
          slept += ms;
        },
      },
    });
    await runGhidraSweep({
      runId: 'run-1',
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
      deps,
    });
    expect(slept).toBe(0);
  });

  it('skips the capability stage when capa is not configured, and says how to enable it', async () => {
    const { ledger } = await sweep({ answers: {}, deps: {} });
    const capability = stage(ledger, 'capability');
    expect(capability.state).toBe('skipped');
    expect(capability.detail).toContain('Setup');
  });

  it('anchors capa matches with their ATT&CK ids when capa runs', async () => {
    const deps = makeDeps({
      answers: {},
      deps: {
        runCapa: async () => ({
          ok: true,
          error: '',
          payload: {
            rules: {
              'inject code': {
                meta: {
                  namespace: 'host-interaction/process/inject',
                  attack: [{ technique: 'Process Injection', id: 'T1055' }],
                },
                matches: [[{ value: '0x140001000' }, {}]],
              },
            },
          },
        }),
      },
    });
    const ledger = await runGhidraSweep({
      runId: 'run-1',
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config: normalizeGhidraLabConfig({ ...config, capaExePath: 'C:\\capa.exe' }),
      deps,
    });
    expect(stage(ledger, 'capability').state).toBe('done');
    const capaAnchor = ledger.anchors.find((entry) => entry.kind === 'capa');
    expect(capaAnchor?.id).toBe('capa:inject code');
    expect(capaAnchor?.detail).toContain('T1055');
    expect(capaAnchor?.deterministic).toBe(true);
  });

  it('records a capa failure as a stage failure, not a sweep failure', async () => {
    const deps = makeDeps({
      answers: {},
      deps: { runCapa: async () => ({ ok: false, payload: null, error: 'capa exited 2' }) },
    });
    const ledger = await runGhidraSweep({
      runId: 'run-1',
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config: normalizeGhidraLabConfig({ ...config, capaExePath: 'C:\\capa.exe' }),
      deps,
    });
    expect(stage(ledger, 'capability').state).toBe('failed');
    expect(stage(ledger, 'capability').detail).toContain('capa exited 2');
    expect(stage(ledger, 'structure').state).toBe('done');
  });

  it('marks a function anchor non-deterministic once a model has summarized it', async () => {
    const { ledger } = await sweep({
      answers: {
        functions: outcome([{ name: 'Inject', address: '0x1000', calls: ['CreateRemoteThread'] }]),
        decompile: outcome([{ name: 'Inject', decompiled: 'void Inject(void){}' }]),
      },
      deps: {
        summarizeFunction: async () => 'opens a target process and starts a thread in it',
      },
    });
    const fn = ledger.anchors.find((entry) => entry.kind === 'function');
    expect(fn?.deterministic).toBe(false);
    expect(fn?.detail).toContain('starts a thread');
    expect(stage(ledger, 'deepread').summary).toContain('1 summarized');
  });

  it('keeps the decompiled body but stays deterministic with no summarizer', async () => {
    const { ledger } = await sweep({
      answers: {
        functions: outcome([{ name: 'Inject', address: '0x1000', calls: ['CreateRemoteThread'] }]),
        decompile: outcome([{ name: 'Inject', decompiled: 'void Inject(void){}' }]),
      },
      deps: {},
    });
    const fn = ledger.anchors.find((entry) => entry.kind === 'function');
    expect(fn?.deterministic).toBe(true);
    expect(fn?.detail).toContain('not summarized');
  });

  it('caps how many functions the deep read spends tokens on', async () => {
    const many = Array.from({ length: 500 }, (_, index) => ({
      name: `Handler${index}`,
      address: `0x${(0x140000000 + index * 16).toString(16)}`,
      size: 2048,
      calls: ['OpenProcess'],
    }));
    const { ledger } = await sweep({
      answers: { functions: outcome(many), decompile: outcome([]) },
      deps: {},
    });
    const selected = ledger.facts.selectedFunctions as unknown[];
    expect(selected.length).toBe(GHIDRA_DEEP_READ_LIMIT);
  });

  it('never stores more decompiled text than the budget allows', async () => {
    // The budget used to be checked once per BATCH of eight. One long body could
    // drive it negative, and `slice(0, negative)` counts from the END of the
    // string -- so the cap stopped capping and later functions in the batch got
    // bodies cut from the wrong end.
    const many = Array.from({ length: 60 }, (_, index) => ({
      name: `Handler${index}`,
      address: `0x${(0x140000000 + index * 16).toString(16)}`,
      size: 4096,
      calls: ['OpenProcess'],
    }));
    const huge = 'x'.repeat(GHIDRA_DECOMPILE_CHARS * 2);
    const { ledger } = await sweep({
      answers: {
        functions: outcome(many),
        decompile: () => outcome(many.map((entry) => ({ name: entry.name, code: huge }))),
      },
      deps: {},
    });
    const bodies = ledger.facts.deepRead as { decompiled: string }[];
    const total = bodies.reduce((sum, entry) => sum + entry.decompiled.length, 0);
    expect(total).toBeLessThanOrEqual(GHIDRA_DEEP_READ_TOTAL_CHARS);
    for (const body of bodies) {
      expect(body.decompiled.length).toBeGreaterThan(0);
      expect(body.decompiled.length).toBeLessThanOrEqual(GHIDRA_DECOMPILE_CHARS);
    }
  });

  it('stops between stages when cancelled and marks the rest skipped', async () => {
    let calls = 0;
    const { ledger } = await sweep({
      answers: {},
      deps: {
        shouldContinue: () => {
          calls += 1;
          // Allow identity + imports, then cancel.
          return calls <= 2;
        },
      },
    });
    expect(stage(ledger, 'identity').state).toBe('done');
    expect(stage(ledger, 'exports').state).toBe('skipped');
    expect(stage(ledger, 'exports').detail).toBe('cancelled');
  });

  it('reports progress for each stage as it runs', async () => {
    const seen: string[] = [];
    const deps = makeDeps({
      answers: {},
      deps: {
        onStage: (view) => {
          seen.push(`${view.stage}:${view.state}`);
        },
      },
    });
    await runGhidraSweep({
      runId: 'run-1',
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config,
      deps,
    });
    expect(seen).toContain('identity:running');
    expect(seen).toContain('identity:done');
    expect(seen.filter((entry) => entry.endsWith(':running')).length).toBeGreaterThanOrEqual(9);
  });
});

describe('extraction', () => {
  it('reads imports out of every shape the engine has used', () => {
    expect(extractImports([{ library: 'kernel32.dll', name: 'OpenProcess' }])).toEqual([
      { symbol: 'OpenProcess', library: 'kernel32.dll', address: '' },
    ]);
    // Grouped-by-library shape.
    expect(
      extractImports([
        { library: 'ntdll.dll', functions: [{ name: 'NtOpenProcess', address: '0x1' }] },
      ]),
    ).toEqual([{ symbol: 'NtOpenProcess', library: 'ntdll.dll', address: '0x1' }]);
    // Flat string shape.
    expect(extractImports(['kernel32.dll!Sleep', 'GetTickCount'])).toEqual([
      { library: 'kernel32.dll', symbol: 'Sleep', address: '' },
      { library: '', symbol: 'GetTickCount', address: '' },
    ]);
    expect(extractImports([null, 42, {}])).toEqual([]);
  });

  it('takes the library from the nested row, which is where the engine puts it', () => {
    // Real shape: [{ imports: [{ name, library }] }] -- reading only the outer
    // record reported every import as coming from no library at all.
    expect(
      extractImports([
        {
          imports: [
            { name: '_unlock', library: 'MSVCR100D.DLL' },
            { name: 'HeapAlloc', library: 'KERNEL32.DLL' },
          ],
        },
      ]),
    ).toEqual([
      { symbol: '_unlock', library: 'MSVCR100D.DLL', address: '' },
      { symbol: 'HeapAlloc', library: 'KERNEL32.DLL', address: '' },
    ]);
  });

  it('still falls back to an outer library when the rows have none', () => {
    expect(extractImports([{ library: 'ntdll.dll', functions: [{ name: 'NtClose' }] }])).toEqual([
      { symbol: 'NtClose', library: 'ntdll.dll', address: '' },
    ]);
  });

  it('reads strings with or without an address', () => {
    expect(extractStrings([{ value: 'hi', address: '0x1' }, 'bare', { nope: 1 }])).toEqual([
      { value: 'hi', address: '0x1' },
      { value: 'bare', address: '' },
    ]);
  });

  it('steps over rows that are not records, in every extractor', () => {
    // The engine's answers are not schema-checked anywhere upstream. A null or a
    // number mixed into a list has to be skipped, not crash the stage that was
    // reading it -- one throw here costs the whole sweep.
    expect(extractStrings([null, 42, true])).toEqual([]);
    expect(extractFunctions([null, 42, {}])).toEqual([]);
    expect(extractDecompiled([null, 42]).size).toBe(0);
    expect(extractCallgraph([null, 42])).toBe('');
  });

  it('accepts a bare function name and a numeric string value', () => {
    expect(extractFunctions(['DriverEntry', '  '])).toEqual([{ name: 'DriverEntry', address: '' }]);
    // Some builds answer with the string's numeric value rather than its text.
    expect(extractStrings([{ value: 12345, address: '0x1' }])).toEqual([
      { value: '12345', address: '0x1' },
    ]);
  });

  it('reads functions and their optional metrics', () => {
    const [fn] = extractFunctions([
      { name: 'Main', entry_point: '0x1000', body_size: '512', xref_count: 4, is_entry: true },
    ]);
    expect(fn.name).toBe('Main');
    expect(fn.address).toBe('0x1000');
    expect(fn.size).toBe(512);
    expect(fn.xrefCount).toBe(4);
    expect(fn.isEntryPoint).toBe(true);
  });

  it('reads a decompiled body under any of its key names', () => {
    expect(extractDecompiled([{ name: 'A', pseudo_c: 'void A(){}' }]).get('A')).toBe('void A(){}');
    expect(extractDecompiled([{ address: '0x1', code: 'x' }]).get('0x1')).toBe('x');
    expect(extractDecompiled(['raw body']).get('')).toBe('raw body');
  });

  it('finds a body the engine keyed as <name>-<address>', () => {
    // Measured: asking for check_managed_app returns a row keyed
    // check_managed_app-00412210. An exact lookup found nothing, and the whole
    // deep-read stage reported "no function could be decompiled" while every
    // call had in fact succeeded.
    const bodies = new Map([['check_managed_app-00412210', 'void f(void){}']]);
    expect(findDecompiledBody(bodies, 'check_managed_app', '00412210')).toBe('void f(void){}');
    expect(findDecompiledBody(bodies, 'check_managed_app', '')).toBe('void f(void){}');
    expect(findDecompiledBody(bodies, '', '0x00412210')).toBe('void f(void){}');
    expect(findDecompiledBody(bodies, 'other_function', '0x999')).toBe('');
  });

  it('prefers an exact key and tolerates an unkeyed single answer', () => {
    expect(
      findDecompiledBody(
        new Map([
          ['main', 'a'],
          ['main-0x1', 'b'],
        ]),
        'main',
        '',
      ),
    ).toBe('a');
    expect(findDecompiledBody(new Map([['', 'only']]), 'whatever', '')).toBe('only');
  });

  it('pulls the mermaid source out of a call-graph answer', () => {
    // The engine answers with an envelope; the diagram is the `graph` field.
    // Stringifying the whole row put raw JSON inside the report's mermaid fence,
    // which renders as nothing.
    expect(
      extractCallgraph([
        {
          function_name: 'entry',
          direction: 'calling',
          graph: 'flowchart TD\nentry --> init',
          mermaid_url: 'https://mermaid.ink/svg/x',
        },
      ]),
    ).toBe('flowchart TD\nentry --> init');
    expect(extractCallgraph(['flowchart TD\nA --> B'])).toBe('flowchart TD\nA --> B');
    expect(extractCallgraph([])).toBe('');
  });

  it('keeps a row that carries no diagram rather than losing it', () => {
    const out = extractCallgraph([{ note: 'no graph produced' }]);
    expect(out).toContain('no graph produced');
  });

  it('pulls section names out of nested metadata', () => {
    expect(extractSectionNames([{ sections: [{ name: '.text' }, '.rdata'] }])).toEqual([
      '.text',
      '.rdata',
    ]);
    expect(extractSectionNames(null)).toEqual([]);
  });

  it('reads capa rules, mappings and addresses; tolerates a partial document', () => {
    const matches = extractCapaMatches({
      rules: {
        'read file': {
          meta: {
            namespace: 'host-interaction/file-system/read',
            mbc: [{ behavior: 'File Read', id: 'C0051' }],
          },
          matches: [[{ value: '0x401000' }, {}]],
        },
        'no meta': {},
      },
    });
    expect(matches).toHaveLength(2);
    expect(matches[0].namespace).toBe('host-interaction/file-system/read');
    expect(matches[0].mbc[0]).toContain('C0051');
    expect(matches[0].addresses).toContain('0x401000');
    expect(extractCapaMatches(null)).toEqual([]);
    expect(extractCapaMatches({ nope: true })).toEqual([]);
    // An address capa did not write as a decimal number used to be pushed
    // through Number() and land in the report as the literal string "0xNaN".
    const odd = extractCapaMatches({
      rules: {
        'odd address': { meta: {}, matches: [[{ value: 'file offset 0x200' }, {}]] },
        'hex address': { meta: {}, matches: [[{ value: '0x401000' }, {}]] },
        'decimal address': { meta: {}, matches: [[{ value: 4198400 }, {}]] },
      },
    });
    expect(odd.map((match) => match.addresses[0])).toEqual([
      'file offset 0x200',
      '0x401000',
      '0x401000',
    ]);
    expect(JSON.stringify(odd)).not.toContain('NaN');

    // Older capa documents list attack/mbc as plain strings, not records.
    const flat = extractCapaMatches({
      rules: {
        'flat meta': { meta: { attack: ['T1055 Process Injection'], mbc: ['C0051 File Read'] } },
        'not a rule': 42,
      },
    });
    expect(flat).toHaveLength(1);
    expect(flat[0].attack).toEqual(['T1055 Process Injection']);
    expect(flat[0].mbc).toEqual(['C0051 File Read']);
  });
});
