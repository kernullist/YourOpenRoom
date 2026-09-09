// @vitest-environment node
//
// Findings are the product of the PE triage: everything else on the screen is
// raw material. What matters here is that a finding is decided by the whole
// import table and not by the sample of it that happens to be on display.
import { describe, expect, it } from 'vitest';

import { buildFindings, groupImportsFromIdaPro } from '../idaPePlugin';
import type { PeImportModule, PeMetadata, PeSectionSummary, PeStringHit } from '../idaPeTypes';

const metadata: PeMetadata = {
  fileType: 'PE32',
  machine: 'i386',
  subsystem: 'console',
  imageBase: '00400000',
  entryPointRva: '00001000',
  imageSize: 0x8000,
  headersSize: 0x400,
  sectionAlignment: 0x1000,
  fileAlignment: 0x200,
  numberOfSections: 1,
  numberOfDirectories: 16,
  timestamp: 0,
  timestampIso: null,
  characteristics: [],
  dllCharacteristics: [],
  importDirectoryPresent: true,
  exportDirectoryPresent: false,
  tlsDirectoryPresent: false,
};

const sections: PeSectionSummary[] = [
  {
    name: '.text',
    virtualAddress: '00001000',
    virtualSize: 0x2000,
    rawSize: 0x2000,
    rawOffset: 0x400,
    entropy: 6.1,
    permissions: 'r-x',
    characteristicsHex: '60000020',
  },
];

const noStrings: PeStringHit[] = [];

/** A module whose injection API sits past the display cap, as real ones do. */
function bigModule(over: Partial<PeImportModule> = {}): PeImportModule {
  const filler = Array.from({ length: 200 }, (_unused, index) => `Ordinary${index}`);
  const all = [...filler.slice(0, 150), 'WriteProcessMemory', ...filler.slice(150)];
  const suspicious = all.filter((name) => name === 'WriteProcessMemory');
  return {
    module: 'kernel32.dll',
    count: all.length,
    suspiciousCount: suspicious.length,
    // What the UI shows: the first 120 in import-table order, which does not
    // reach position 150.
    names: all.slice(0, 120),
    suspiciousNames: suspicious,
    ...over,
  };
}

describe('buildFindings and the import table it reasons over', () => {
  it('raises injection for an API the display sample never reached', () => {
    const imports = [bigModule()];
    // The premise: the sample really does not contain it.
    expect(imports[0].names).not.toContain('WriteProcessMemory');
    expect(imports[0].suspiciousCount).toBe(1);

    const findings = buildFindings(metadata, sections, imports, noStrings);
    const injection = findings.find((entry) => entry.id === 'process-injection');
    expect(injection).toBeDefined();
    expect(injection?.evidence).toContain('WriteProcessMemory');
  });

  it('does not invent a finding when nothing in the table is suspicious', () => {
    const clean = bigModule({ suspiciousCount: 0, suspiciousNames: [] });
    const findings = buildFindings(metadata, sections, [clean], noStrings);
    expect(findings.find((entry) => entry.id === 'process-injection')).toBeUndefined();
  });

  it('keeps the count and the evidence telling the same story', () => {
    // A count that says "one suspicious import" beside a finding that cites
    // none is the shape the old code produced, and it reads as a tool that
    // cannot make up its mind.
    const imports = [bigModule()];
    const findings = buildFindings(metadata, sections, imports, noStrings);
    const cited = findings.flatMap((entry) => entry.evidence ?? []);
    expect(imports[0].suspiciousCount > 0).toBe(cited.includes('WriteProcessMemory'));
  });
});

describe('grouping the IDA Pro import rows', () => {
  it('keeps a suspicious import that falls outside the display sample', () => {
    // Measured on shell32.dll: 296 imports from USER32.dll, of which the first
    // 120 are shown, and four suspicious ones sat past that line. Drawn from
    // the sample they were invisible to every finding.
    const rows = [
      ...Array.from({ length: 150 }, (_unused, index) => ({
        module: 'USER32.dll',
        imported_name: `Ordinary${index}`,
      })),
      { module: 'USER32.dll', imported_name: 'CreateRemoteThread' },
    ];
    const [module] = groupImportsFromIdaPro({ data: rows });
    expect(module.count).toBe(151);
    expect(module.names).not.toContain('CreateRemoteThread');
    expect(module.suspiciousNames).toContain('CreateRemoteThread');
    expect(module.suspiciousCount).toBe(1);
  });

  it('reports no suspicious names for an ordinary import table', () => {
    const [module] = groupImportsFromIdaPro({
      data: [{ module: 'USER32.dll', imported_name: 'DrawTextW' }],
    });
    expect(module.suspiciousNames).toEqual([]);
    expect(module.suspiciousCount).toBe(0);
  });
});
