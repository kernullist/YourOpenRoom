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
  buildLedgerText,
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
              '## Open questions',
              '',
              '- Nothing was executed.',
              'padding to clear the minimum length gate '.repeat(6),
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
      'padding to clear the minimum length gate '.repeat(6),
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
      'padding to clear the minimum length gate '.repeat(6),
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
              'padding to clear the minimum length gate '.repeat(6),
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
