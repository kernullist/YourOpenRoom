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
    // referenced functions that are nowhere near the entry. There has to be
    // more of it than the whole read budget holds, or every function fits and
    // the seed reads the chain by accident -- and the test stops proving
    // anything.
    const noise = Array.from({ length: 200 }, (_unused, index) => ({
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
    //
    // The filler exists to push the image past the whole read budget. Under it,
    // every function is seeded, nothing is left to expand to, and the test
    // proves nothing about expansion at all. It is deliberately ranked between
    // `helper` (which must be seeded, since expansion walks out from what was
    // read) and `deeper` (which must not be).
    const filler = Array.from({ length: 200 }, (_unused, index) => ({
      name: `Filler${index}`,
      address: `0x${(0x500000 + index * 16).toString(16)}`,
      size: 1024,
      refcount: 5,
    }));
    const { ledger } = await sweep({
      answers: {
        imports: outcome([{ library: 'kernel32.dll', name: 'Sleep' }]),
        functions: outcome([
          { name: 'entry', address: '0x401000', is_entry: true, size: 16 },
          { name: 'helper', address: '0x402000', size: 8192, refcount: 50 },
          { name: 'deeper', address: '0x403000', size: 16 },
          ...filler,
        ]),
        decompile: () =>
          outcome([
            { name: 'entry-0x401000', code: '___tmainCRTStartup();' },
            { name: 'helper-0x402000', code: 'deeper();' },
            { name: 'deeper-0x403000', code: 'Sleep(1000);' },
          ]),
      },
      deps: {},
    });
    const read = (ledger.facts.deepRead as { name: string }[]).map((entry) => entry.name);
    expect(read).toContain('helper');
    expect(read).toContain('deeper');
    expect(stage(ledger, 'deepread').summary).toContain('callers that were read');
  });

  it('seeds the whole image when the whole image fits', async () => {
    // The path reserve exists to leave room for following calls out of the entry
    // point in an image too big to read in one go. Holding those slots back when
    // everything fits only leaves functions unread: a real 128-function binary
    // stopped at 100 with four fifths of the character budget untouched.
    const small = Array.from({ length: 12 }, (_unused, index) => ({
      name: `Fn${index}`,
      address: `0x${(0x401000 + index * 16).toString(16)}`,
      refcount: 2,
    }));
    const { ledger } = await sweep({
      answers: {
        functions: outcome(small),
        decompile: () =>
          outcome(
            small.map((entry) => ({
              name: `${entry.name}-${entry.address}`,
              code: 'return 0;',
            })),
          ),
      },
      deps: {},
    });
    expect(stage(ledger, 'selection').summary).toContain('12 of 12 functions seeded');
    expect(stage(ledger, 'selection').summary).toContain('fits the budget');
    expect((ledger.facts.deepRead as unknown[]).length).toBe(12);
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

describe('reading what the engine actually returns', () => {
  // Every fixture here is the row shape pyghidra-mcp 0.2.5 really sends, copied
  // off a live session rather than guessed at. Three separate things were being
  // read wrong at once, and all three were invisible: the sweep reported success
  // either way, just with less of the binary in it.
  const ENGINE_ROWS = [
    {
      name: 'entry',
      address: '00401000',
      type: 'Function',
      namespace: 'Global',
      source: 'ANALYSIS',
      refcount: 0,
      external: false,
      is_thunk: false,
      thunk_target: null,
      is_entry: true,
    },
    {
      name: 'strcmp',
      address: '00402000',
      type: 'Function',
      refcount: 12,
      external: false,
      is_thunk: false,
      thunk_target: null,
    },
    {
      name: 'strcmp',
      address: '00403000',
      type: 'Function',
      refcount: 1,
      external: false,
      is_thunk: true,
      thunk_target: 'strcmp',
    },
    {
      name: 'CoreWorker',
      address: '00404000',
      type: 'Function',
      refcount: 6,
      external: false,
      is_thunk: false,
      thunk_target: null,
    },
    {
      name: 'Sleep',
      address: '00405000',
      type: 'Function',
      refcount: 3,
      external: true,
      is_thunk: false,
      thunk_target: null,
    },
  ];

  it('reads refcount, thunk and external off the engine row', () => {
    const parsed = extractFunctions(ENGINE_ROWS);
    const byAddress = new Map(parsed.map((entry) => [entry.address, entry]));

    // `refcount` is the field name. The list only knew `xref_count`, `xrefs`,
    // `references` and `reference_count`, so on every real binary the reference
    // weight scored zero for all 128 functions and the ranking came down to a
    // name comparison.
    expect(byAddress.get('00402000')?.xrefCount).toBe(12);
    expect(byAddress.get('00404000')?.xrefCount).toBe(6);
    expect(byAddress.get('00403000')?.isThunk).toBe(true);
    expect(byAddress.get('00402000')?.isThunk).toBeUndefined();
    expect(byAddress.get('00405000')?.isExternal).toBe(true);
  });

  it('gives two functions that share a name their own bodies', () => {
    // `strcmp` exists twice: the body and the thunk that jumps to it. Matching a
    // decompile answer by name returned whichever came first in the map, so both
    // were recorded with the same code -- and the report then cited one address
    // for a body belonging to the other.
    const bodies = new Map([
      ['strcmp-00402000', 'int strcmp(char *a, char *b) { /* real */ }'],
      ['strcmp-00403000', 'JMP strcmp'],
    ]);
    expect(findDecompiledBody(bodies, 'strcmp', '00402000')).toContain('real');
    expect(findDecompiledBody(bodies, 'strcmp', '00403000')).toBe('JMP strcmp');
  });

  it('still matches on the name when there is no address to go on', () => {
    const bodies = new Map([['lonely-00401000', 'void lonely(void) { return; }']]);
    expect(findDecompiledBody(bodies, 'lonely', '')).toContain('lonely');
  });

  it('asks for bodies by address, and keeps both halves of a duplicated name', async () => {
    const { ledger, deps } = await sweep({
      answers: {
        functions: outcome(ENGINE_ROWS),
        decompile: () =>
          outcome([
            { name: 'entry-00401000', code: 'CoreWorker();' },
            { name: 'strcmp-00402000', code: 'int strcmp(char *a, char *b) { /* real */ }' },
            { name: 'strcmp-00403000', code: 'JMP strcmp' },
            { name: 'CoreWorker-00404000', code: 'strcmp(x, y);' },
          ]),
      },
      deps: {},
    });

    // Asked by name, the engine answers a duplicated symbol with
    // `Function or symbol 'strcmp' not found.` and the read is lost.
    const asked = queriesOf(deps)
      .filter((entry) => entry.kind === 'decompile')
      .flatMap((entry) => (entry.args.names as string[]) ?? []);
    expect(asked).toContain('00402000');
    expect(asked).not.toContain('strcmp');

    const read = ledger.facts.deepRead as { name: string; address: string; decompiled: string }[];
    const strcmps = read.filter((entry) => entry.name === 'strcmp');
    expect(strcmps).toHaveLength(2);
    expect(new Set(strcmps.map((entry) => entry.decompiled)).size).toBe(2);

    // An external is an import wearing a function row: there is no body here to
    // decompile, so spending a slot on it only ever returns nothing.
    expect(read.some((entry) => entry.name === 'Sleep')).toBe(false);
  });

  it('says how many requested bodies never came back', async () => {
    const { ledger } = await sweep({
      answers: {
        functions: outcome([
          { name: 'Present', address: '00401000', refcount: 4 },
          { name: 'Absent', address: '00402000', refcount: 4 },
        ]),
        decompile: () => outcome([{ name: 'Present-00401000', code: 'return 1;' }]),
      },
      deps: {},
    });
    // This used to be a bare `continue`: the stage called itself done while
    // silently dropping the functions it had just decided were worth reading.
    expect(stage(ledger, 'deepread').summary).toContain('1 returned no body');
  });
});

describe('when one of the engine keys is ambiguous', () => {
  it('asks again by name for whatever the address could not resolve', async () => {
    // One address, two symbols: `GetPdbDll` and `?GetPdbDll@@YAPAUHINSTANCE__@@XZ`
    // both sit at 00413890, and the engine refuses to choose -- `Ambiguous match
    // for '00413890'`. It answered the name without complaint. Without the
    // second attempt this binary lost the one function holding its dynamically
    // resolved registry APIs, which is the whole finding.
    let call = 0;
    const { ledger, deps } = await sweep({
      answers: {
        functions: outcome([{ name: 'GetPdbDll', address: '00413890', refcount: 2 }]),
        decompile: () => {
          call += 1;
          return call === 1
            ? outcome([{ name: '00413890', code: '', error: "Ambiguous match for '00413890'." }])
            : outcome([
                { name: 'GetPdbDll-00413890', code: 'pRegOpenKeyExW(HKEY_LOCAL_MACHINE);' },
              ]);
        },
      },
      deps: {},
    });

    const asked = queriesOf(deps)
      .filter((entry) => entry.kind === 'decompile')
      .map((entry) => (entry.args.names as string[]).join(','));
    expect(asked).toEqual(['00413890', 'GetPdbDll']);

    const read = ledger.facts.deepRead as { name: string; decompiled: string }[];
    expect(read.map((entry) => entry.name)).toContain('GetPdbDll');
    expect(stage(ledger, 'deepread').summary).not.toContain('returned no body');
  });

  it('does not ask for xrefs it never reads', async () => {
    // Asking for them is what made the address ambiguous in the first place.
    const { deps } = await sweep({
      answers: {
        functions: outcome([{ name: 'Worker', address: '00401000', refcount: 4 }]),
        decompile: () => outcome([{ name: 'Worker-00401000', code: 'return 0;' }]),
      },
      deps: {},
    });
    const decompiles = queriesOf(deps).filter((entry) => entry.kind === 'decompile');
    expect(decompiles).not.toHaveLength(0);
    for (const entry of decompiles) {
      expect(entry.args.include_xrefs).toBe(false);
    }
  });

  it('counts a function as missing only after both keys have failed', async () => {
    const { ledger, deps } = await sweep({
      answers: {
        functions: outcome([{ name: 'Absent', address: '00402000', refcount: 4 }]),
        decompile: () => outcome([]),
      },
      deps: {},
    });
    // Two attempts, one per key, before it is called a failure.
    expect(queriesOf(deps).filter((entry) => entry.kind === 'decompile')).toHaveLength(2);
    expect(stage(ledger, 'deepread').state).toBe('failed');
    expect(stage(ledger, 'deepread').summary).toBe('no function could be decompiled');
  });
});

describe('matching a decompiled body back to the function that was asked for', () => {
  it('does not hand a function the body of a thunk that merely names it', () => {
    // Both shapes are real, from the same binary. The thunk lives at 00411131
    // and is called `thunk_FUN_00411440` -- its NAME carries the address of the
    // function it jumps to. A substring test for 00411440 therefore matches the
    // thunk's key, and the function actually at 00411440 is handed the wrong
    // body: three lines of jump instead of the code, filed under an address
    // where that code does not exist. Thirteen pairs in one 128-function image
    // were exposed to this.
    const bodies = new Map([
      ['thunk_FUN_00411440-00411131', 'JMP FUN_00411440'],
      ['FUN_00411440-00411440', 'the real body'],
    ]);
    expect(findDecompiledBody(bodies, 'FUN_00411440', '00411440')).toBe('the real body');
    expect(findDecompiledBody(bodies, 'thunk_FUN_00411440', '00411131')).toBe('JMP FUN_00411440');
  });

  it('reads an address the same whether it is padded or prefixed', () => {
    const bodies = new Map([['worker-0x4123f0', 'body']]);
    expect(findDecompiledBody(bodies, 'worker', '004123f0')).toBe('body');
    expect(findDecompiledBody(bodies, 'worker', '0x4123f0')).toBe('body');
  });

  it('finds a namespaced key by name when there is no address to match on', () => {
    // `MSVCR100D.DLL::strcmp-004110b9` is what the engine returns for a CRT
    // import. Without an address the name is the only key left, and a plain
    // prefix test never matches past the namespace.
    const bodies = new Map([['MSVCR100D.DLL::strcmp-004110b9', 'int strcmp(...)']]);
    expect(findDecompiledBody(bodies, 'strcmp', '')).toBe('int strcmp(...)');
  });

  it('keeps expanding when the engine answers with bare names and no addresses', async () => {
    // Some answers are plain strings, so every function carries an empty
    // address. That empty string used to be written into the set of things
    // already read, and the frontier's membership test then matched every node
    // without an address -- so everything looked read and expansion stopped on
    // the first round.
    //
    // The filler pushes the image past the read budget so expansion is the only
    // way to reach `omega`; `Aalpha` sorts ahead of it into the seed.
    const filler = Array.from({ length: 200 }, (_unused, index) => `Filler${index}`);
    const { ledger } = await sweep({
      answers: {
        functions: outcome(['Aalpha', ...filler, 'omega']),
        decompile: () =>
          outcome([
            { name: 'Aalpha', code: 'omega();' },
            { name: 'omega', code: 'return 1;' },
          ]),
      },
      deps: {},
    });
    const read = (ledger.facts.deepRead as { name: string }[]).map((entry) => entry.name);
    expect(read).toContain('Aalpha');
    expect(read).toContain('omega');
  });

  it('names the cause when every function the engine listed is external', async () => {
    // Nothing to read is a result, and it has a reason worth printing. An
    // external is an import wearing a function row.
    const { ledger } = await sweep({
      answers: {
        functions: outcome([
          { name: 'Sleep', address: '00405000', external: true },
          { name: 'GetProcAddress', address: '00405010', external: true },
        ]),
      },
      deps: {},
    });
    expect(stage(ledger, 'selection').state).toBe('skipped');
    expect(stage(ledger, 'selection').summary).toContain('2 of 2 are listed as external');
  });

  it('leaves the path clause out when no path was followed', async () => {
    const { ledger } = await sweep({
      answers: {
        functions: outcome([{ name: 'Only', address: '00401000', refcount: 3 }]),
        decompile: () => outcome([{ name: 'Only-00401000', code: 'return 0;' }]),
      },
      deps: {},
    });
    const summary = stage(ledger, 'deepread').summary;
    expect(summary).toBe('1 functions decompiled, 0 summarized');
    expect(summary).not.toContain('over 0 rounds');
  });
});

describe('the budget, and saying when it ran out', () => {
  it('reports a read that stopped at the character budget', async () => {
    // A truncated read used to look exactly like a complete one. The count is
    // in the summary either way, so nothing said whether the sweep chose to
    // stop reading or was stopped.
    const many = Array.from({ length: 120 }, (_unused, index) => ({
      name: `Big${index}`,
      address: `0x${(0x401000 + index * 16).toString(16)}`,
      refcount: 4,
    }));
    const huge = 'x'.repeat(GHIDRA_DECOMPILE_CHARS);
    const { ledger } = await sweep({
      answers: {
        functions: outcome(many),
        decompile: () =>
          outcome(many.map((entry) => ({ name: `${entry.name}-${entry.address}`, code: huge }))),
      },
      deps: {},
    });
    const bodies = ledger.facts.deepRead as { decompiled: string }[];
    expect(bodies.length).toBeLessThan(many.length);
    // The cap is on characters stored, and the last body is trimmed to whatever
    // was left rather than being dropped or stored whole.
    const stored = bodies.reduce((total, entry) => total + entry.decompiled.length, 0);
    expect(stored).toBeLessThanOrEqual(GHIDRA_DEEP_READ_TOTAL_CHARS);
    expect(stage(ledger, 'deepread').summary).toContain('the character budget ran out');
  });

  it('counts only functions with a body towards "the whole image fits"', async () => {
    // 300 rows, but 260 of them are imports wearing a function row. The 40 that
    // have a body fit the budget with room to spare, and holding slots back for
    // an expansion with nothing to reach would only leave real code unread.
    const externals = Array.from({ length: 260 }, (_unused, index) => ({
      name: `Imported${index}`,
      address: `0x${(0x700000 + index * 16).toString(16)}`,
      external: true,
    }));
    const real = Array.from({ length: 40 }, (_unused, index) => ({
      name: `Real${index}`,
      address: `0x${(0x401000 + index * 16).toString(16)}`,
      refcount: 3,
    }));
    const { ledger } = await sweep({
      answers: {
        functions: outcome([...externals, ...real]),
        decompile: () =>
          outcome(
            real.map((entry) => ({ name: `${entry.name}-${entry.address}`, code: 'return 0;' })),
          ),
      },
      deps: {},
    });
    expect(stage(ledger, 'selection').summary).toContain('fits the budget');
    expect((ledger.facts.deepRead as unknown[]).length).toBe(40);
  });
});
