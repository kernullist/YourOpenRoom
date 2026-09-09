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
import { GHIDRA_SWEEP_STAGES, type GhidraSweepStage } from '../ghidraLabTypes';

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
    // The SEED is capped below the limit, because the rest of the budget is
    // held back to follow the call path out of the entry point -- which cannot
    // be scored for, since it is not visible until something has been read.
    const selected = ledger.facts.selectedFunctions as unknown[];
    expect(selected.length).toBeLessThan(GHIDRA_DEEP_READ_LIMIT);
    expect(selected.length).toBeGreaterThan(GHIDRA_DEEP_READ_LIMIT / 2);
    // The invariant that matters is the total, seed plus expansion.
    const read = ledger.facts.deepRead as unknown[];
    expect(read.length).toBeLessThanOrEqual(GHIDRA_DEEP_READ_LIMIT);
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

  it('counts an anchor once, however many stages saw it', async () => {
    // ledger.anchors.length becomes the run's anchorCount in the UI and the
    // manifest, while the report's "N of M cited" denominator comes from the
    // deduplicated index. A duplicate pushed onto the array made those two
    // counts of the same thing disagree.
    const { ledger } = await sweep({
      answers: {
        exports: outcome([
          { name: 'DllMain', address: '0x140001000' },
          { name: 'DllMain', address: '0x140001000' },
        ]),
        imports: outcome([
          { library: 'ntdll.dll', name: 'NtLoadDriver' },
          { library: 'ntdll.dll', name: 'NtLoadDriver' },
        ]),
      },
      deps: {},
    });
    const ids = ledger.anchors.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === 'export:DllMain')).toHaveLength(1);
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

describe('the deep-analysis stages', () => {
  it('skips recovered strings without FLOSS, and says what was lost', async () => {
    // Skipped, never failed -- a missing optional tool is a smaller report. But
    // the detail has to say what is missing, or a reader takes the empty
    // Recovered strings section for a binary that hides nothing.
    const { ledger } = await sweep({ answers: {}, deps: {} });
    const view = stage(ledger, 'decodedstrings');
    expect(view.state).toBe('skipped');
    expect(view.detail).toContain('NOT recovered');
  });

  it('anchors recovered strings with the routine that produced them', async () => {
    const deps = makeDeps({
      answers: {},
      deps: {
        runFloss: async () => ({
          ok: true,
          error: '',
          payload: {
            strings: {
              decoded_strings: [
                { string: 'http://c2.example.com/gate', decoding_routine: 4198400 },
              ],
              stack_strings: [{ string: 'ntdll.dll' }],
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
      config: normalizeGhidraLabConfig({ ...config, flossExePath: 'C:\\floss.exe' }),
      deps,
    });
    expect(stage(ledger, 'decodedstrings').summary).toContain('2 hidden strings');
    const decoded = ledger.anchors.filter((entry) => entry.kind === 'decoded');
    expect(decoded).toHaveLength(2);
    // The routine is the reason this is worth an anchor: it is a lead.
    expect(decoded.some((entry) => entry.detail.includes('decoded by 0x401000'))).toBe(true);
  });

  it('records a FLOSS failure as a stage failure, not a sweep failure', async () => {
    const deps = makeDeps({
      answers: {},
      deps: { runFloss: async () => ({ ok: false, payload: null, error: 'floss exited 2' }) },
    });
    const ledger = await runGhidraSweep({
      runId: 'run-1',
      sessionId: 'sess-1',
      binaryPath: BINARY,
      binaryName: 'client.exe',
      config: normalizeGhidraLabConfig({ ...config, flossExePath: 'C:\\floss.exe' }),
      deps,
    });
    expect(stage(ledger, 'decodedstrings').state).toBe('failed');
    expect(stage(ledger, 'decodedstrings').detail).toContain('floss exited 2');
    expect(stage(ledger, 'behavior').state).toBe('done');
  });

  it('anchors an API the binary resolves at run time', async () => {
    const { ledger } = await sweep({
      answers: {
        functions: outcome([{ name: 'resolve', address: '0x401000', is_entry: true }]),
        decompile: outcome([
          { name: 'resolve', code: 'p = GetProcAddress(h, "NtWriteVirtualMemory");' },
        ]),
      },
      deps: {},
    });
    const dynapi = ledger.anchors.filter((entry) => entry.kind === 'dynapi');
    expect(dynapi.map((entry) => entry.id)).toContain('dynapi:NtWriteVirtualMemory');
    expect(stage(ledger, 'dynapi').summary).toContain('resolved at run time');
  });

  it('anchors an obfuscation finding with what would undo it', async () => {
    const cases = Array.from(
      { length: 12 },
      (_unused, index) => `case ${index}: state = ${index + 1}; break;`,
    ).join('\n');
    const { ledger } = await sweep({
      answers: {
        functions: outcome([{ name: 'flat', address: '0x401000', is_entry: true }]),
        decompile: outcome([
          { name: 'flat', code: `while (true) { switch (state) { ${cases} } }` },
        ]),
      },
      deps: {},
    });
    const found = ledger.anchors.find((entry) => entry.kind === 'obfuscation');
    expect(found?.id).toContain('control_flow_flattening');
    expect(found?.detail).toContain('Remedy:');
    expect(stage(ledger, 'obfuscation').summary).toContain('findings');
  });

  it('names a behaviour chain from the order one function calls its APIs', async () => {
    const { ledger } = await sweep({
      answers: {
        imports: outcome([
          { library: 'kernel32.dll', name: 'OpenProcess' },
          { library: 'kernel32.dll', name: 'VirtualAllocEx' },
          { library: 'kernel32.dll', name: 'WriteProcessMemory' },
          { library: 'kernel32.dll', name: 'CreateRemoteThread' },
        ]),
        functions: outcome([
          {
            name: 'inject',
            address: '0x401000',
            is_entry: true,
            calls: ['OpenProcess', 'WriteProcessMemory'],
          },
        ]),
        decompile: outcome([
          {
            name: 'inject',
            code: [
              'h = OpenProcess(a, b, c);',
              'p = VirtualAllocEx(h, 0, n, 0x3000, 0x40);',
              'WriteProcessMemory(h, p, buf, n, 0);',
              'CreateRemoteThread(h, 0, 0, p, 0, 0, 0);',
            ].join('\n'),
          },
        ]),
      },
      deps: {},
    });
    const behavior = ledger.anchors.find((entry) => entry.kind === 'behavior');
    expect(behavior?.id).toBe('behavior:process_injection');
    expect(behavior?.detail).toContain('OpenProcess -> VirtualAllocEx');
    // The wording must stay on capability: the binary was never executed.
    expect(behavior?.detail).not.toMatch(/\bit ran\b|\bwas observed\b/);
  });

  it('walks a graph it built itself when the engine supplies no edges', async () => {
    // The shape of a real run: the function listing carries names and addresses
    // only, and gen_callgraph answers with its root node and nothing else. The
    // bodies still name every call, so reachability has to come from them or the
    // stage reports zero on a binary that plainly reaches an API.
    const { ledger } = await sweep({
      answers: {
        imports: outcome([{ library: 'kernel32.dll', name: 'LoadLibraryW' }]),
        functions: outcome([
          { name: 'entry', address: '0x401000', is_entry: true },
          { name: 'GetPdbDll', address: '0x402000' },
        ]),
        decompile: outcome([
          { name: 'entry', code: 'GetPdbDll();\nreturn 0;' },
          { name: 'GetPdbDll', code: 'h = LoadLibraryW(L"advapi32.dll");\nRegCloseKey(k);' },
        ]),
        // What the engine actually returned: a root and no edges at all.
        callgraph: outcome(['flowchart TD\nclassDef sh fill:#339933\nentry']),
      },
      deps: {},
    });

    const behavior = ledger.facts.behavior as {
      reachable: { symbol: string; from: string; via: string }[];
      graphMissing: boolean;
    };
    expect(behavior.graphMissing).toBe(false);
    expect(behavior.reachable.map((entry) => entry.symbol)).toContain('LoadLibraryW');
    const hop = behavior.reachable.find((entry) => entry.symbol === 'LoadLibraryW');
    expect(hop?.from).toBe('entry');
    expect(hop?.via).toBe('GetPdbDll');

    const view = stage(ledger, 'behavior');
    expect(view.summary).toContain('call edges');
    // Coverage is stated rather than implied: a zero has to be readable.
    expect(view.detail).toContain('out of 2 in the image');
  });

  it('draws the call graph from the bodies when the engine drew one box', async () => {
    const { ledger } = await sweep({
      answers: {
        functions: outcome([
          { name: 'entry', address: '0x401000', is_entry: true },
          { name: 'worker', address: '0x402000' },
        ]),
        decompile: outcome([{ name: 'entry', code: 'worker();' }]),
        callgraph: outcome(['flowchart TD\nclassDef sh fill:#339933\nentry']),
      },
      deps: {},
    });
    const graph = String(ledger.facts.callgraph ?? '');
    expect(graph).toContain('entry --> worker');
    expect(stage(ledger, 'structure').detail).toContain('drawn from decompiled bodies');
  });

  it('reaches an API the import table never listed', async () => {
    // The finding the whole deep-analysis pass exists for: GetPdbDll resolves
    // registry functions at run time, so they are in no import table, and the
    // behaviour stage must still see them as reachable from the entry point.
    const { ledger } = await sweep({
      answers: {
        imports: outcome([{ library: 'kernel32.dll', name: 'GetProcAddress' }]),
        functions: outcome([
          { name: 'entry', address: '0x401000', is_entry: true },
          { name: 'GetPdbDll', address: '0x402000' },
        ]),
        decompile: outcome([
          { name: 'entry', code: 'GetPdbDll();' },
          {
            name: 'GetPdbDll',
            code: ['p = GetProcAddress(h, "RegOpenKeyExW");', 'RegOpenKeyExW(a, b, c, d, e);'].join(
              '\n',
            ),
          },
        ]),
      },
      deps: {},
    });
    const behavior = ledger.facts.behavior as { reachable: { symbol: string }[] };
    expect(behavior.reachable.map((entry) => entry.symbol)).toContain('RegOpenKeyExW');
  });

  it('follows the call path out of the entry point, one hop per round', async () => {
    // Scoring alone never finds this chain: each link is small, has one xref and
    // calls nothing interesting, so none of them place. Measured on a real PE --
    // 28 of 128 bodies read and not one connected the entry point to anything.
    //
    // Noise is what the seed WOULD spend its whole budget on: large, heavily
    // referenced functions that are nowhere near the entry.
    const noise = Array.from({ length: 60 }, (_unused, index) => ({
      name: `Noise${index}`,
      address: `0x${(0x500000 + index * 16).toString(16)}`,
      size: 8192,
      xref_count: 50,
      calls: ['OpenProcess'],
    }));
    const chain = ['entry', 'crt_startup', 'crt_init', 'real_main', 'DoTheWork'];
    const chainFns = chain.map((name, index) => ({
      name,
      address: `0x${(0x401000 + index * 16).toString(16)}`,
      size: 32,
      ...(index === 0 ? { is_entry: true } : {}),
    }));
    const bodyOf = new Map<string, string>([
      ['entry', 'crt_startup();'],
      ['crt_startup', 'crt_init();'],
      ['crt_init', 'real_main();'],
      ['real_main', 'DoTheWork();'],
      ['DoTheWork', 'WriteProcessMemory(a, b, c, d, e);'],
    ]);

    const { ledger } = await sweep({
      answers: {
        imports: outcome([{ library: 'kernel32.dll', name: 'WriteProcessMemory' }]),
        functions: outcome([...chainFns, ...noise]),
        // The engine answers for whatever it was asked; the noise functions
        // decompile to something dull, the chain to its next link.
        decompile: () =>
          outcome([
            ...[...bodyOf.entries()].map(([name, code]) => ({ name, code })),
            ...noise.map((entry) => ({ name: entry.name, code: 'return 0;' })),
          ]),
      },
      deps: {},
    });

    const read = (ledger.facts.deepRead as { name: string }[]).map((entry) => entry.name);
    // The far end of the chain is four hops from the entry and scores nothing.
    // Only following the path gets there.
    expect(read).toContain('DoTheWork');
    expect(stage(ledger, 'deepread').summary).toContain('by following the entry path');

    // And the point of getting there: the API is now reachable FROM the entry,
    // which is the strong claim rather than the fallback one.
    const behavior = ledger.facts.behavior as {
      rootedAtEntry: boolean;
      reachable: { symbol: string; from: string }[];
    };
    expect(behavior.rootedAtEntry).toBe(true);
    expect(behavior.reachable.map((entry) => entry.symbol)).toContain('WriteProcessMemory');
    expect(behavior.reachable[0].from).toBe('entry');
  });

  it('says it followed read callers when the entry path cannot be resolved', async () => {
    // Ghidra writes `___tmainCRTStartup()` while its symbol table holds
    // `FID_conflict:_wmainCRTStartup`; the edge out of `entry` cannot be joined
    // by name. Expansion still has somewhere to go, and has to say which.
    const { ledger } = await sweep({
      answers: {
        imports: outcome([{ library: 'kernel32.dll', name: 'Sleep' }]),
        functions: outcome([
          { name: 'entry', address: '0x401000', is_entry: true, size: 16 },
          { name: 'helper', address: '0x402000', size: 4096, xref_count: 30 },
          { name: 'deeper', address: '0x403000', size: 16 },
        ]),
        decompile: () =>
          outcome([
            { name: 'entry', code: '___tmainCRTStartup();' },
            { name: 'helper', code: 'deeper();' },
            { name: 'deeper', code: 'Sleep(1000);' },
          ]),
      },
      deps: {},
    });
    const read = (ledger.facts.deepRead as { name: string }[]).map((entry) => entry.name);
    expect(read).toContain('deeper');
    expect(stage(ledger, 'deepread').summary).toContain('callers that were read');
  });

  it('never reads more than the limit, seed and expansion together', async () => {
    const many = Array.from({ length: 300 }, (_unused, index) => ({
      name: `F${index}`,
      address: `0x${(0x401000 + index * 16).toString(16)}`,
      size: 4096,
      xref_count: 10,
      ...(index === 0 ? { is_entry: true } : {}),
    }));
    const { ledger } = await sweep({
      answers: {
        functions: outcome(many),
        // Every function calls the next, so the frontier never runs out.
        decompile: () =>
          outcome(many.map((entry, index) => ({ name: entry.name, code: `F${index + 1}();` }))),
      },
      deps: {},
    });
    expect((ledger.facts.deepRead as unknown[]).length).toBeLessThanOrEqual(GHIDRA_DEEP_READ_LIMIT);
  });

  it('walks all fourteen stages in order', async () => {
    const { ledger } = await sweep({ answers: {}, deps: {} });
    expect(ledger.stages.map((entry) => entry.stage)).toEqual([...GHIDRA_SWEEP_STAGES]);
  });
});
