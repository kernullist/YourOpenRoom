// @vitest-environment node
//
// Anchor enforcement is the hallucination control for the whole feature, so it is
// pinned hard: an uncited claim is DELETED, an invented citation is stripped, and
// the count of deletions ends up in the report where a reader can see it.
//
// The other property worth defending is that there is always a report. A model
// that fails, returns garbage, or rewrites the document into generalities must
// not cost the operator the sweep that already ran.
import { describe, expect, it } from 'vitest';

import {
  buildAnchorIndex,
  buildDeterministicReport,
  capGraphText,
  buildLedgerText,
  buildReportPrompt,
  countRequiredSections,
  looksTruncated,
  enforceReportAnchors,
  parseVerifierResult,
  writeGhidraReport,
} from '../ghidraLabReport';
import type { GhidraSweepLedger } from '../ghidraLabTypes';

function ledgerFixture(overrides: Partial<GhidraSweepLedger> = {}): GhidraSweepLedger {
  return {
    runId: 'run-1',
    binaryPath: 'C:\\bins\\client.exe',
    binaryName: 'client.exe',
    sha256: 'a'.repeat(64),
    sizeBytes: 2048,
    createdAt: 0,
    anchors: [
      {
        id: 'header:sha256',
        kind: 'header',
        binary: 'client.exe',
        address: '',
        symbol: '',
        detail: 'sha256 aaa; 2048 bytes',
        deterministic: true,
      },
      {
        id: 'import:NtLoadDriver',
        kind: 'import',
        binary: 'client.exe',
        address: '',
        symbol: 'NtLoadDriver',
        detail: 'imported from ntdll.dll',
        deterministic: true,
      },
      {
        id: 'function:0x140001000',
        kind: 'function',
        binary: 'client.exe',
        address: '0x140001000',
        symbol: 'DriverEntry',
        detail: 'entry point -- loads a driver',
        deterministic: false,
      },
    ],
    stages: [
      {
        stage: 'identity',
        state: 'done',
        startedAt: 0,
        finishedAt: 1,
        summary: 'sha256 aaa',
        detail: '',
      },
      {
        stage: 'strings',
        state: 'failed',
        startedAt: 1,
        finishedAt: 2,
        summary: 'strings unavailable',
        detail: 'engine error',
      },
    ],
    facts: {
      functionCount: 120,
      importCapabilities: [
        {
          category: 'driver',
          claim: 'talks to a kernel driver or installs one',
          symbols: ['NtLoadDriver'],
          weight: 10,
        },
      ],
      stringSummary: [
        { bucket: 'url', count: 2, samples: [{ value: 'https://example.com', address: '0x1' }] },
      ],
      antiAnalysis: [
        {
          code: 'anti_debug_imports',
          detail: 'Imports debugger-detection APIs.',
          evidence: ['IsDebuggerPresent'],
        },
      ],
      selectedFunctions: [
        { name: 'DriverEntry', address: '0x140001000', reasons: ['entry point'] },
      ],
      deepRead: [{ name: 'DriverEntry', address: '0x140001000', summary: 'loads a driver' }],
      capa: [
        {
          rule: 'load driver',
          namespace: 'host-interaction/driver',
          attack: ['Boot or Logon T1547'],
          mbc: [],
          addresses: ['0x140001000'],
        },
      ],
      callgraph: 'graph TD; DriverEntry --> Init',
      callgraphRoot: 'DriverEntry',
    },
    ...overrides,
  };
}

const KNOWN = new Set(['header:sha256', 'import:NtLoadDriver', 'function:0x140001000']);

describe('enforceReportAnchors', () => {
  it('deletes a prose line that cites nothing', () => {
    const result = enforceReportAnchors(
      ['## Capability summary', '', 'This binary exfiltrates credentials to a remote server.'].join(
        '\n',
      ),
      KNOWN,
    );
    expect(result.report).not.toContain('exfiltrates');
    expect(result.droppedClaims).toBe(1);
  });

  it('keeps a line that cites a real anchor', () => {
    const result = enforceReportAnchors('- Loads a kernel driver. [import:NtLoadDriver]', KNOWN);
    expect(result.report).toContain('Loads a kernel driver');
    expect(result.droppedClaims).toBe(0);
    expect(result.citedAnchors).toEqual(['import:NtLoadDriver']);
  });

  it('deletes a line whose only citation was invented', () => {
    const result = enforceReportAnchors('- Contacts a command server. [string:0xdeadbeef]', KNOWN);
    expect(result.report).not.toContain('command server');
    expect(result.droppedClaims).toBe(1);
    expect(result.unknownAnchors).toEqual(['string:0xdeadbeef']);
  });

  it('keeps a line with one real and one invented citation, and strips the invented one', () => {
    const result = enforceReportAnchors(
      '- Loads a driver [import:NtLoadDriver] and phones home [string:0xdeadbeef].',
      KNOWN,
    );
    expect(result.report).toContain('[import:NtLoadDriver]');
    expect(result.report).not.toContain('0xdeadbeef');
    expect(result.unknownAnchors).toEqual(['string:0xdeadbeef']);
    expect(result.droppedClaims).toBe(0);
  });

  it('leaves structure alone', () => {
    const source = [
      '# Title',
      '',
      '| col | col |',
      '| --- | --- |',
      '',
      '```mermaid',
      'graph TD; A --> B',
      '```',
      '',
      '> a quote',
    ].join('\n');
    const result = enforceReportAnchors(source, KNOWN);
    expect(result.report).toContain('graph TD; A --> B');
    expect(result.report).toContain('| col | col |');
    expect(result.droppedClaims).toBe(0);
  });

  it('does not require citations inside exempt sections', () => {
    const source = [
      '## Open questions',
      '',
      '- Nothing was executed; this is a static read only.',
      '',
      '## Capability summary',
      '',
      '- An uncited claim here.',
    ].join('\n');
    const result = enforceReportAnchors(source, KNOWN);
    expect(result.report).toContain('static read only');
    expect(result.report).not.toContain('An uncited claim');
    expect(result.droppedClaims).toBe(1);
  });

  it('does not mistake a markdown link for a citation', () => {
    const result = enforceReportAnchors(
      '## Capability summary\n\n- See [the docs](https://example.com) for detail.',
      KNOWN,
    );
    // No anchor cited -> dropped. The link must not have counted as one.
    expect(result.droppedClaims).toBe(1);
  });

  it('ignores bracketed text that is not shaped like an anchor id', () => {
    const result = enforceReportAnchors('## X\n\n- Something [TODO] here.', KNOWN);
    expect(result.droppedClaims).toBe(1);
  });
});

describe('buildDeterministicReport', () => {
  it('produces a usable report with no model at all', () => {
    const report = buildDeterministicReport(ledgerFixture());
    expect(report).toContain('# client.exe -- Binary Analysis Report');
    expect(report).toContain('## Capability summary');
    expect(report).toContain('load driver');
    expect(report).toContain('[import:NtLoadDriver]');
    expect(report).toContain('```mermaid');
    expect(report).toContain('## Coverage');
  });

  it('fences the call graph as mermaid only when it is mermaid', () => {
    const good = buildDeterministicReport(ledgerFixture());
    expect(good).toContain('```mermaid');

    const ledger = ledgerFixture();
    (ledger.facts as Record<string, unknown>).callgraph = '{"graph":"unavailable"}';
    const bad = buildDeterministicReport(ledger);
    // A JSON envelope inside a mermaid fence renders as nothing at all.
    expect(bad).not.toContain('```mermaid');
    expect(bad).toContain('unavailable');
  });

  it('exempts only the four sections named, not any heading containing their words', () => {
    // Substring matching was a way straight out of the enforcement pass: the
    // model picks its own headings, and "Capability summary and coverage"
    // contains 'coverage', which freed every line under it to say anything.
    const known = new Set(['import:X']);
    const smuggled = enforceReportAnchors(
      ['## Capability summary and coverage', 'The binary exfiltrates data to a C2 server.'].join(
        '\n',
      ),
      known,
    );
    expect(smuggled.report).not.toContain('exfiltrates');
    expect(smuggled.droppedClaims).toBe(1);

    // The real section still stands uncited -- that is what it is for.
    const genuine = enforceReportAnchors(
      ['## Coverage', 'The strings stage failed, so no string evidence was collected.'].join('\n'),
      known,
    );
    expect(genuine.report).toContain('strings stage failed');
    expect(genuine.droppedClaims).toBe(0);

    // And punctuation or casing in the heading must not break the exemption.
    for (const heading of ['## Open Questions', '### open questions:', '## Open questions']) {
      const out = enforceReportAnchors(`${heading}\nIs this packed?`, known);
      expect(out.droppedClaims, heading).toBe(0);
    }
  });

  it('keeps list indentation, which is what markdown nests with', () => {
    // Every kept prose line used to have its whitespace runs collapsed whether
    // or not anything had been stripped from it, so a four-space child item came
    // out as a one-space sibling and the nesting was gone.
    const known = new Set(['import:X']);
    const out = enforceReportAnchors(
      ['- top [import:X]', '    - nested [import:X]'].join('\n'),
      known,
    );
    expect(out.report).toContain('    - nested');
  });

  it('closes the gap a stripped citation leaves without moving the line', () => {
    const known = new Set(['import:X']);
    // Behind a heading, because the whole document is trimmed at the end.
    const out = enforceReportAnchors(
      ['## Findings', '  - it does a thing [import:X] [import:FAKE]'].join('\n'),
      known,
    );
    expect(out.report).toContain('\n  - it does a thing');
    expect(out.report).not.toContain('FAKE');
    expect(out.report).not.toMatch(/\S {2,}\S/);
    expect(out.unknownAnchors).toEqual(['import:FAKE']);
  });

  it('states which stages failed rather than quietly omitting them', () => {
    const report = buildDeterministicReport(ledgerFixture());
    expect(report).toContain('strings: failed');
    expect(report).toContain('These stages failed');
  });

  it('says capa was not run when it was not', () => {
    const ledger = ledgerFixture();
    delete (ledger.facts as Record<string, unknown>).capa;
    const report = buildDeterministicReport(ledger);
    expect(report).toContain('capa was not run');
  });

  it('does not crash on an empty ledger', () => {
    const empty = ledgerFixture({ anchors: [], facts: {}, stages: [] });
    const report = buildDeterministicReport(empty);
    expect(report).toContain('No capability signals were derived');
  });
});

describe('buildLedgerText', () => {
  it('puts measured facts before model-inferred ones and marks the difference', () => {
    const text = buildLedgerText(ledgerFixture());
    const inferredIndex = text.indexOf('(model-inferred)');
    const importIndex = text.indexOf('[import:NtLoadDriver]');
    expect(inferredIndex).toBeGreaterThan(importIndex);
    expect(text).toContain('@0x140001000');
  });
});

describe('parseVerifierResult', () => {
  it('reads a clean verdict', () => {
    const result = parseVerifierResult(
      '{"needsRewrite":true,"findings":[{"severity":"blocking","code":"unsupported","message":"claim X"}]}',
    );
    expect(result.needsRewrite).toBe(true);
    expect(result.findings[0].severity).toBe('blocking');
  });

  it('digs the JSON out of a model that wrapped it in prose', () => {
    const result = parseVerifierResult('Sure!\n```json\n{"findings":[{"message":"m"}]}\n```');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('warning');
  });

  it('treats a blocking finding as needing a rewrite even without the flag', () => {
    const result = parseVerifierResult('{"findings":[{"severity":"blocking","message":"m"}]}');
    expect(result.needsRewrite).toBe(true);
  });

  it('returns an empty verdict for unparseable output rather than throwing', () => {
    expect(parseVerifierResult('not json at all')).toEqual({ needsRewrite: false, findings: [] });
  });
});

describe('writeGhidraReport', () => {
  it('ships the deterministic report when no model is available', async () => {
    const result = await writeGhidraReport(ledgerFixture());
    expect(result.modelWritten).toBe(false);
    expect(result.report).toContain('Binary Analysis Report');
    expect(result.report).toContain('Evidence check:');
  });

  it('uses the model draft when it cites real evidence', async () => {
    const result = await writeGhidraReport(ledgerFixture(), {
      callModel: async (_prompt, _tokens, json) =>
        json
          ? '{"needsRewrite":false,"findings":[]}'
          : [
              '# client.exe -- Binary Analysis Report',
              '',
              '## Capability summary',
              '',
              '- Installs or talks to a kernel driver. [import:NtLoadDriver]',
              '- Its entry point is DriverEntry. [function:0x140001000]',
              '',
              // Every required heading, so this test stays about citations
              // rather than about the completeness guard.
              '## Architecture and entry flow',
              '## Notable functions',
              '## Strings of interest',
              '## What it does when it runs',
              '## Dynamically resolved APIs',
              '## Obfuscation',
              '## Recovered strings',
              '## Anti-analysis and packaging',
              '## Coverage',
              '',
              '## Open questions',
              '',
            ].join('\n'),
    });
    expect(result.modelWritten).toBe(true);
    expect(result.citedAnchors).toContain('import:NtLoadDriver');
    expect(result.report).toContain('kernel driver');
  });

  it('falls back to deterministic when the model draft cites nothing real', async () => {
    const result = await writeGhidraReport(ledgerFixture(), {
      callModel: async (_prompt, _tokens, json) =>
        json
          ? '{"needsRewrite":false,"findings":[]}'
          : `# Report\n\n## Capability summary\n\n${'This binary is definitely malware. '.repeat(20)}`,
    });
    expect(result.modelWritten).toBe(false);
    expect(result.report).toContain('[import:NtLoadDriver]');
  });

  it('falls back when the model throws', async () => {
    const errors: string[] = [];
    const result = await writeGhidraReport(ledgerFixture(), {
      callModel: async () => {
        throw new Error('model offline');
      },
      logError: (message) => errors.push(message),
    });
    expect(result.modelWritten).toBe(false);
    expect(result.report).toContain('Binary Analysis Report');
    expect(errors.join(' ')).toContain('draft failed');
  });

  it('rejects a rewrite that collapsed the report into generalities', async () => {
    let call = 0;
    const draft = [
      '# client.exe -- Binary Analysis Report',
      '',
      '## Capability summary',
      '',
      '- Installs or talks to a kernel driver. [import:NtLoadDriver]',
      '- Its entry point is DriverEntry. [function:0x140001000]',
      '- Identity confirmed. [header:sha256]',
      'padding to clear the minimum length gate. '.repeat(6),
    ].join('\n');
    const result = await writeGhidraReport(ledgerFixture(), {
      callModel: async (_prompt, _tokens, json) => {
        if (json) {
          return '{"needsRewrite":true,"findings":[{"severity":"blocking","code":"c","message":"m"}]}';
        }
        call += 1;
        if (call === 1) {
          return draft;
        }
        // The rewrite drops almost every citation -- exactly the compression
        // failure the pipeline is defending against.
        return `# client.exe\n\n## Capability summary\n\n- It does things. [header:sha256]\n${'padding '.repeat(60)}`;
      },
    });
    expect(result.rewritten).toBe(false);
    expect(result.citedAnchors).toContain('import:NtLoadDriver');
  });

  it('accepts a rewrite that keeps the evidence', async () => {
    let call = 0;
    const base = [
      '# client.exe -- Binary Analysis Report',
      '',
      '## Capability summary',
      '',
      '- Installs or talks to a kernel driver. [import:NtLoadDriver]',
      '- Its entry point is DriverEntry. [function:0x140001000]',
      // Every required heading, so this test stays about the rewrite rather
      // than about the completeness guard.
      '## Architecture and entry flow',
      '## Notable functions',
      '## Strings of interest',
      '## What it does when it runs',
      '## Dynamically resolved APIs',
      '## Obfuscation',
      '## Recovered strings',
      '## Anti-analysis and packaging',
      '## Coverage',
      '## Open questions',
      'padding to clear the minimum length gate. '.repeat(6),
    ].join('\n');
    const result = await writeGhidraReport(ledgerFixture(), {
      callModel: async (_prompt, _tokens, json) => {
        if (json) {
          return '{"needsRewrite":true,"findings":[{"severity":"blocking","code":"c","message":"m"}]}';
        }
        call += 1;
        return call === 1 ? base : base.replace('Installs or talks to', 'Can load');
      },
    });
    expect(result.rewritten).toBe(true);
    expect(result.report).toContain('Can load');
  });

  it('prints the drop count where the reader can see it', async () => {
    const result = await writeGhidraReport(ledgerFixture(), {
      callModel: async (_prompt, _tokens, json) =>
        json
          ? '{"needsRewrite":false,"findings":[]}'
          : [
              '# client.exe -- Binary Analysis Report',
              '',
              '## Capability summary',
              '',
              '- Installs or talks to a kernel driver. [import:NtLoadDriver]',
              '- It also steals passwords.',
              'padding to clear the minimum length gate. '.repeat(6),
            ].join('\n'),
    });
    expect(result.droppedClaims).toBeGreaterThan(0);
    expect(result.report).toContain('removed for citing no supporting evidence');
    expect(result.report).not.toContain('steals passwords');
  });
});

describe('buildAnchorIndex', () => {
  it('is keyed by id and keeps the first of a duplicate', () => {
    const ledger = ledgerFixture();
    ledger.anchors.push({ ...ledger.anchors[0], detail: 'second' });
    const index = buildAnchorIndex(ledger);
    expect(index.size).toBe(3);
    expect(index.get('header:sha256')?.detail).not.toBe('second');
  });
});

describe('the deep-analysis report sections', () => {
  function deepLedger() {
    const ledger = ledgerFixture();
    const facts = ledger.facts as Record<string, unknown>;
    facts.decodedStrings = [
      {
        value: 'http://c2.example.com/gate',
        kind: 'decoded',
        address: '0x402000',
        decodingRoutine: '0x401000',
        encoding: '',
      },
    ];
    facts.dynamicApis = {
      resolved: [
        {
          symbol: 'NtWriteVirtualMemory',
          library: '',
          functionName: 'resolve',
          address: '0x401000',
          evidence: 'literal',
        },
      ],
      hashing: [
        {
          code: 'api_hashing',
          detail: 'Resolves imports by hashed name. ATT&CK T1027.007.',
          evidence: ['resolve: ROR-13 over a byte loop'],
        },
      ],
      resolverSites: [{ functionName: 'resolve', address: '0x401000', calls: 3 }],
    };
    facts.obfuscation = [
      {
        code: 'control_flow_flattening',
        functionName: 'flat',
        address: '0x403000',
        confidence: 'strong',
        detail: 'A dispatcher loop switches on `state`.',
        evidence: ['state = 1;'],
        remedy: 'D-810 does this at IDA decompilation time.',
      },
    ];
    facts.behavior = {
      reachable: [{ symbol: 'CreateRemoteThread', from: 'entry', depth: 2, via: 'inject' }],
      sequences: [],
      chains: [
        {
          code: 'process_injection',
          title: 'Process injection',
          detail: 'Opens another process and starts execution there.',
          apis: ['OpenProcess', 'WriteProcessMemory'],
          functionName: 'inject',
          address: '0x401000',
          confidence: 'strong',
        },
      ],
      entries: ['entry'],
      graphMissing: false,
    };
    facts.reachableCategories = [{ category: 'injection', count: 2 }];

    // The anchors the sections cite have to exist, or enforcement strips them --
    // which is exactly what these tests are here to catch.
    ledger.anchors.push(
      {
        binary: ledger.binaryName,
        id: 'decoded:0x401000:http://c2.example.com/gate',
        kind: 'decoded',
        address: '0x402000',
        symbol: '0x401000',
        detail: 'decoded string',
        deterministic: true,
      },
      {
        binary: ledger.binaryName,
        id: 'dynapi:NtWriteVirtualMemory',
        kind: 'dynapi',
        address: '0x401000',
        symbol: 'NtWriteVirtualMemory',
        detail: 'resolved at run time',
        deterministic: true,
      },
      {
        binary: ledger.binaryName,
        id: 'dynapi:api_hashing',
        kind: 'dynapi',
        address: '',
        symbol: 'api_hashing',
        detail: 'hashed imports',
        deterministic: true,
      },
      {
        binary: ledger.binaryName,
        id: 'obfuscation:control_flow_flattening:0x403000',
        kind: 'obfuscation',
        address: '0x403000',
        symbol: 'flat',
        detail: 'flattened',
        deterministic: true,
      },
      {
        binary: ledger.binaryName,
        id: 'behavior:process_injection',
        kind: 'behavior',
        address: '0x401000',
        symbol: 'inject',
        detail: 'injection chain',
        deterministic: true,
      },
    );
    return ledger;
  }

  it('renders all four sections with their evidence', () => {
    const report = buildDeterministicReport(deepLedger());
    expect(report).toContain('## What it does when it runs');
    expect(report).toContain('## Dynamically resolved APIs');
    expect(report).toContain('## Obfuscation');
    expect(report).toContain('## Recovered strings');
    expect(report).toContain('Process injection');
    expect(report).toContain('NtWriteVirtualMemory');
    expect(report).toContain('control_flow_flattening');
    expect(report).toContain('c2.example.com');
  });

  it('keeps the behaviour section on reachability, never on execution', () => {
    const report = buildDeterministicReport(deepLedger());
    expect(report).toContain('not observed execution');
    expect(report).toContain('Reachability');
  });

  it('survives its own enforcement pass with the new sections intact', () => {
    // The deterministic report is the fallback AND the floor the model has to
    // beat, so a section that enforcement strips out of it is a section that
    // cannot ship on a machine with no model.
    const ledger = deepLedger();
    const known = new Set(ledger.anchors.map((entry) => entry.id));
    const enforced = enforceReportAnchors(buildDeterministicReport(ledger), known);
    expect(enforced.report).toContain('## Recovered strings');
    expect(enforced.report).toContain('## Obfuscation');
    expect(enforced.report).toContain('NtWriteVirtualMemory');
    expect(enforced.report).toContain('Process injection');
    expect(enforced.report).toContain('control_flow_flattening');

    // Measured against the same ledger WITHOUT the deep facts, so the number is
    // about the new sections rather than about the fixture. Adding them must not
    // cost a single line: the deterministic report is the fallback, and a
    // section enforcement strips out of it cannot ship at all where no model is
    // configured.
    const shallow = ledgerFixture();
    shallow.anchors = ledger.anchors;
    const baseline = enforceReportAnchors(buildDeterministicReport(shallow), known);
    expect(enforced.droppedClaims).toBe(baseline.droppedClaims);
    expect(enforced.unknownAnchors).toEqual(baseline.unknownAnchors);
  });

  it('says which tool was missing rather than implying a clean binary', () => {
    const report = buildDeterministicReport(ledgerFixture());
    expect(report).toContain('No hidden strings were recovered');
    expect(report).toContain('Coverage says which');
    expect(report).toContain('No known behaviour chain matched');
    expect(report).toContain('No obfuscation construct was found');
  });
});

describe('the report prompt', () => {
  it('asks for the deep-analysis sections, or a model simply omits them', () => {
    const prompt = buildReportPrompt(ledgerFixture());
    expect(prompt).toContain('## What it does when it runs');
    expect(prompt).toContain('## Recovered strings');
    // The rules that keep the model on the right side of the claim.
    expect(prompt).toContain('reachability and ordering ONLY');
    expect(prompt).toContain('do not claim anything was deobfuscated');
    expect(prompt).toContain('names a TECHNIQUE, not an API');
  });

  it('separates two resolver sites that share a function name', () => {
    // Reading the whole image means reading functions whose names repeat: this
    // binary has two `_RTC_GetSrcLine` bodies at different addresses, each with
    // its own GetProcAddress call. Named alone, the two rows look like one row
    // printed twice.
    const ledger = ledgerFixture();
    (ledger.facts as Record<string, unknown>).dynamicApis = {
      resolved: [
        {
          symbol: 'PDBOpenValidate5',
          library: '',
          functionName: '_RTC_GetSrcLine',
          address: '0041119a',
          evidence: 'literal',
        },
        {
          symbol: 'PDBOpenValidate5',
          library: '',
          functionName: '_RTC_GetSrcLine',
          address: '00413520',
          evidence: 'literal',
        },
      ],
      hashing: [],
      resolverSites: [],
    };
    const report = buildDeterministicReport(ledger);
    expect(report).toContain('@0041119a');
    expect(report).toContain('@00413520');
  });
});

describe('a model that stopped before it finished', () => {
  // Measured on a real run: the prompt grew to fourteen stages' worth of
  // sections while the token budget stayed at the six-section figure, so the
  // draft ended mid-sentence in "Notable functions" and the four deep-analysis
  // sections were never written. It shipped anyway, because it had cited
  // SOMETHING -- which is how a report silently loses the findings that cost the
  // most to collect.

  function fullSections(): string {
    return [
      '# client.exe -- Binary Analysis Report',
      'Identity paragraph. [import:NtLoadDriver]',
      '## Capability summary',
      'It can load a driver. [import:NtLoadDriver]',
      '## Architecture and entry flow',
      'Entry is DriverEntry. [import:NtLoadDriver]',
      '## Notable functions',
      'One function stands out. [import:NtLoadDriver]',
      '## Strings of interest',
      'Nothing notable. [import:NtLoadDriver]',
      '## What it does when it runs',
      'A driver load is reachable. [import:NtLoadDriver]',
      '## Dynamically resolved APIs',
      'None found. [import:NtLoadDriver]',
      '## Obfuscation',
      'None found. [import:NtLoadDriver]',
      '## Recovered strings',
      'None recovered. [import:NtLoadDriver]',
      '## Anti-analysis and packaging',
      'Nothing suggested packing. [import:NtLoadDriver]',
      '## Coverage',
      'Every stage ran.',
      '## Open questions',
      'What loads the driver?',
    ].join('\n');
  }

  it('counts the required sections a draft actually reached', () => {
    expect(countRequiredSections(fullSections())).toBe(11);
    expect(countRequiredSections('# Title\n## Capability summary\nx.')).toBe(1);
    // Casing and trailing punctuation in a heading must not lose the match.
    expect(countRequiredSections('## Capability Summary:\n## OBFUSCATION')).toBe(2);
  });

  it('calls a draft that stopped a third of the way through truncated', () => {
    const cut = fullSections().split('## Strings of interest')[0];
    expect(looksTruncated(cut)).toBe(true);
  });

  it('calls a draft that ends mid-sentence truncated, even with every heading', () => {
    const cut = `${fullSections()}\nSeveral additional functions were included primarily to fill the analysis`;
    expect(looksTruncated(cut)).toBe(true);
  });

  it('does not call a finished report truncated', () => {
    expect(looksTruncated(fullSections())).toBe(false);
    // Ending on a table or a fence is finished, not cut off.
    expect(looksTruncated(`${fullSections()}\n| a | b |`)).toBe(false);
  });

  it('ships the deterministic report instead of a truncated draft', async () => {
    const ledger = ledgerFixture();
    const cut = fullSections().split('## Notable functions')[0];
    const result = await writeGhidraReport(ledger, {
      callModel: async (_prompt, _tokens, json) => (json ? '{"needsRewrite":false}' : cut),
    });
    // The draft cited real anchors, so the old "cited nothing" guard let it
    // through. The section it never reached is the one the sweep paid for.
    expect(result.modelWritten).toBe(false);
    expect(result.report).toContain('## Recovered strings');
    expect(result.report).toContain('## What it does when it runs');
  });

  it('still ships a complete model draft', async () => {
    const result = await writeGhidraReport(ledgerFixture(), {
      callModel: async (_prompt, _tokens, json) =>
        json ? '{"needsRewrite":false,"findings":[]}' : fullSections(),
    });
    expect(result.modelWritten).toBe(true);
  });
});

describe('a resolver site with no address', () => {
  it('does not print a bare @', () => {
    const ledger = ledgerFixture();
    (ledger.facts as Record<string, unknown>).dynamicApis = {
      resolved: [
        {
          symbol: 'LoadLibraryW',
          library: '',
          functionName: 'resolve',
          address: '',
          evidence: 'literal',
        },
      ],
      hashing: [],
      resolverSites: [],
    };
    const report = buildDeterministicReport(ledger);
    expect(report).toContain('`resolve`');
    expect(report).not.toMatch(/@\s*\|/);
  });
});

describe('the notable-functions table with duplicated symbols', () => {
  it('gives each of two same-named functions its own summary', () => {
    const ledger = ledgerFixture();
    const facts = ledger.facts as Record<string, unknown>;
    facts.selectedFunctions = [
      { name: 'strcmp', address: '004110b9', reasons: ['has a symbol name'] },
      { name: 'strcmp', address: '00411d8c', reasons: ['has a symbol name'] },
    ];
    facts.deepRead = [
      { name: 'strcmp', address: '004110b9', summary: 'the import stub', decompiled: 'a' },
      { name: 'strcmp', address: '00411d8c', summary: 'the thunk beside it', decompiled: 'b' },
    ];
    const report = buildDeterministicReport(ledger);
    // Matching on either key took the first row for both, so one function's
    // description was printed under the other function's address.
    expect(report).toContain('the import stub');
    expect(report).toContain('the thunk beside it');
    const stub = report.indexOf('the import stub');
    const thunk = report.indexOf('the thunk beside it');
    expect(report.slice(0, stub)).toContain('004110b9');
    expect(report.slice(stub, thunk)).toContain('00411d8c');
  });
});

describe('tables that show only part of what was found', () => {
  function ledgerWithSelected(count: number) {
    const ledger = ledgerFixture();
    (ledger.facts as Record<string, unknown>).selectedFunctions = Array.from(
      { length: count },
      (_unused, index) => ({
        name: `Fn${index}`,
        address: `0040${(0x1000 + index).toString(16)}`,
        reasons: ['has a symbol name'],
      }),
    );
    return ledger;
  }

  it('says a table is the first N of more', () => {
    // A capped table with nothing above it reads as the whole set, and this
    // report exists to be checkable line by line.
    const report = buildDeterministicReport(ledgerWithSelected(128));
    expect(report).toContain('Showing the first 40 of 128 functions that were read');
  });

  it('stays quiet when the table is everything there is', () => {
    const report = buildDeterministicReport(ledgerWithSelected(9));
    expect(report).not.toContain('Showing the first');
  });
});

describe('what the report says about evidence it never had', () => {
  it('cuts a diagram on a line and says how much of it is there', () => {
    // mermaid is line-oriented: half an edge is a syntax error, and the viewer
    // renders a syntax error as an empty box rather than a partial diagram.
    const graph = [
      'flowchart TD',
      ...Array.from({ length: 200 }, (_u, i) => `  a${i} --> b${i}`),
    ].join('\n');
    const capped = capGraphText(graph, 400);
    expect(capped.length).toBeLessThan(graph.length);
    expect(
      capped.split('\n').every((line) => !line.startsWith('  a') || line.includes('-->')),
    ).toBe(true);
    expect(capped).toContain('%% truncated for the report');
  });

  it('leaves a diagram alone when it fits', () => {
    const graph = 'flowchart TD\n  a --> b';
    expect(capGraphText(graph, 4000)).toBe(graph);
  });

  it('says when an anchor cap kept evidence out of the ledger', () => {
    // A claim can only cite an anchor that exists, so evidence that hit a cap
    // is evidence the enforcement pass will delete a true sentence for lacking.
    const ledger = ledgerFixture();
    (ledger.facts as Record<string, unknown>).anchorCaps = [
      { kind: 'import', kept: 120, found: 296 },
    ];
    const report = buildDeterministicReport(ledger);
    expect(report).toContain('176 import anchors were not recorded');
    expect(report).toContain('keeps 120 of 296');
  });

  it('says nothing when every anchor was recorded', () => {
    expect(buildDeterministicReport(ledgerFixture())).not.toContain('were not recorded');
  });

  it('gives a capability claim the scale of its evidence', () => {
    const ledger = ledgerFixture();
    (ledger.facts as Record<string, unknown>).importCapabilities = [
      {
        category: 'registry',
        claim: 'reads or writes the registry',
        symbols: ['RegOpenKeyExW', 'RegQueryValueExW', 'RegCloseKey', 'RegSetValueExW'],
        symbolCount: 37,
        weight: 5,
      },
    ];
    expect(buildDeterministicReport(ledger)).toContain('(4 of 37 matching imports)');
  });
});
