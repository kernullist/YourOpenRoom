// @vitest-environment node
//
// Sweep -> report, end to end, with a faked engine.
//
// This file exists because of a real defect. The sweep recorded imports as
// `import:ntdll.dll!NtLoadDriver` while the report cited `import:NtLoadDriver`,
// so the deterministic report -- the fallback that is supposed to always work --
// had every one of its own citations stripped as invented. Each half was correct
// in isolation and both unit suites passed.
//
// The invariant below is the fix: whatever the sweep collects, every citation the
// report emits must resolve to an anchor the sweep actually recorded. Anchor ids
// now come from one set of builders, and this test is what keeps them there.
import { describe, expect, it } from 'vitest';

import { normalizeGhidraLabConfig } from '../ghidraLabConfig';
import {
  buildAnchorIndex,
  buildDeterministicReport,
  enforceReportAnchors,
  writeGhidraReport,
} from '../ghidraLabReport';
import type { GhidraLabQueryOutcome } from '../ghidraLabSession';
import { runGhidraSweep, type GhidraSweepDeps } from '../ghidraLabSweep';

const CITATION_REGEX = /\[([a-z]+:[^\]\n]+)\](?!\()/g;

const config = normalizeGhidraLabConfig({
  ghidraInstallDir: 'C:\\ghidra',
  jdkHome: 'C:\\jdk21',
  projectRoot: 'C:\\projects',
  capaExePath: 'C:\\capa.exe',
});

function outcome(rows: unknown[]): GhidraLabQueryOutcome {
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
  };
}

/** A binary that trips every deterministic stage, so every citation shape is exercised. */
function richEngine(): GhidraSweepDeps {
  return {
    async query(_sessionId, kind) {
      switch (kind) {
        case 'metadata':
          return outcome([
            { name: 'client.exe', format: 'PE', sections: [{ name: '.text' }, { name: 'UPX0' }] },
          ]);
        case 'imports':
          return outcome([
            { library: 'ntdll.dll', name: 'NtLoadDriver' },
            { library: 'kernel32.dll', name: 'WriteProcessMemory' },
            { library: 'kernel32.dll', name: 'IsDebuggerPresent' },
            { library: 'ws2_32.dll', name: 'connect' },
            { library: 'advapi32.dll', name: 'RegOpenKeyExA' },
          ]);
        case 'exports':
          return outcome([{ name: 'DllMain', address: '0x140001000' }]);
        case 'strings':
          return outcome([
            { value: 'https://c2.example.com/beacon', address: '0x1400a0000' },
            { value: '\\\\.\\Tvk', address: '0x1400a0100' },
            { value: 'HKEY_LOCAL_MACHINE\\Software\\Thing', address: '0x1400a0200' },
            { value: 'VMware SVGA II', address: '0x1400a0300' },
          ]);
        case 'functions':
          return outcome([
            {
              name: 'DllMain',
              address: '0x140001000',
              is_entry: true,
              size: 2048,
              calls: ['NtLoadDriver', 'WriteProcessMemory'],
            },
            { name: 'sub_140002000', address: '0x140002000', size: 600, xref_count: 12 },
          ]);
        case 'decompile':
          return outcome([
            { name: 'DllMain', decompiled: 'int DllMain(void){ return 1; }' },
            { name: 'sub_140002000', decompiled: 'void sub_140002000(void){}' },
          ]);
        case 'callgraph':
          return outcome(['graph TD; DllMain --> sub_140002000']);
        default:
          return outcome([]);
      }
    },
    hashFile: () => ({ sha256: 'c'.repeat(64), sizeBytes: 8192, mtimeMs: 0 }),
    now: () => 1_000,
    runCapa: async () => ({
      ok: true,
      error: '',
      payload: {
        rules: {
          'load driver': {
            meta: {
              namespace: 'host-interaction/driver',
              attack: [{ technique: 'Boot or Logon Autostart Execution', id: 'T1547' }],
            },
            matches: [[{ value: '0x140001000' }, {}]],
          },
        },
      },
    }),
  };
}

async function sweepRich() {
  return runGhidraSweep({
    runId: 'run-1',
    sessionId: 'sess-1',
    binaryPath: 'C:\\bins\\client.exe',
    binaryName: 'client.exe',
    config,
    deps: richEngine(),
  });
}

function citationsIn(report: string): string[] {
  return [...report.matchAll(CITATION_REGEX)].map((match) => match[1].trim());
}

describe('sweep -> report anchor consistency', () => {
  it('emits no citation the sweep did not anchor', async () => {
    const ledger = await sweepRich();
    const known = new Set(buildAnchorIndex(ledger).keys());
    const report = buildDeterministicReport(ledger);

    // The evidence-ledger section lists every anchor verbatim; only the prose
    // above it is under test here.
    const prose = report.split('## Evidence ledger')[0];
    const unknown = citationsIn(prose).filter((id) => !known.has(id));
    expect(unknown).toEqual([]);
  });

  it('survives enforcement without losing its own claims', async () => {
    const ledger = await sweepRich();
    const known = new Set(buildAnchorIndex(ledger).keys());
    const enforced = enforceReportAnchors(buildDeterministicReport(ledger), known);

    expect(enforced.unknownAnchors).toEqual([]);
    expect(enforced.citedAnchors.length).toBeGreaterThan(5);
    // Every capability the deterministic report claims must still be there.
    expect(enforced.report).toContain('NtLoadDriver');
    expect(enforced.report).toContain('load driver');
    expect(enforced.report).toContain('anti_debug_imports');
  });

  it('anchors every capability signal symbol it will go on to cite', async () => {
    const ledger = await sweepRich();
    const known = new Set(buildAnchorIndex(ledger).keys());
    const signals = ledger.facts.importCapabilities as { symbols: string[] }[];
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      for (const symbol of signal.symbols.slice(0, 4)) {
        expect(known.has(`import:${symbol}`)).toBe(true);
      }
    }
  });

  it('anchors each anti-analysis indicator rather than an import that may not exist', async () => {
    const ledger = await sweepRich();
    const known = new Set(buildAnchorIndex(ledger).keys());
    // The packer-section and VM-string indicators have evidence that is not a
    // symbol at all -- the case that made per-import citation wrong.
    expect(known.has('indicator:packer_section_names')).toBe(true);
    expect(known.has('indicator:vm_detection_strings')).toBe(true);
    expect(known.has('indicator:anti_debug_imports')).toBe(true);
  });

  it('produces a shipped report with a clean evidence check line', async () => {
    const ledger = await sweepRich();
    const result = await writeGhidraReport(ledger);
    expect(result.modelWritten).toBe(false);
    expect(result.unknownAnchors).toEqual([]);
    expect(result.droppedClaims).toBe(0);
    expect(result.report).toContain('Evidence check:');
    expect(result.report).not.toContain('were removed for citing no supporting evidence');
  });

  it('carries the capa mapping through to the report body', async () => {
    const ledger = await sweepRich();
    const report = buildDeterministicReport(ledger);
    expect(report).toContain('T1547');
    expect(report).toContain('[capa:load driver]');
  });

  it('still yields a citation-clean report when most stages fail', async () => {
    const ledger = await runGhidraSweep({
      runId: 'run-2',
      sessionId: 'sess-1',
      binaryPath: 'C:\\bins\\client.exe',
      binaryName: 'client.exe',
      config,
      deps: {
        query: async () => ({
          ok: false,
          kind: null,
          mcpTool: '',
          rows: [],
          rowCount: 0,
          truncated: false,
          elapsedMs: 0,
          engineError: 'engine down',
          reason: 'engine_error',
        }),
        hashFile: () => ({ sha256: 'd'.repeat(64), sizeBytes: 1, mtimeMs: 0 }),
        now: () => 1_000,
      },
    });
    const result = await writeGhidraReport(ledger);
    expect(result.unknownAnchors).toEqual([]);
    // It should say plainly that stages failed rather than implying coverage.
    expect(result.report).toContain('These stages failed');
    expect(result.report).toContain('imports: failed');
  });
});
