// @vitest-environment node
//
// Findings are the product of the PE triage: everything else on the screen is
// raw material. What matters here is that a finding is decided by the whole
// import table and not by the sample of it that happens to be on display.
import { describe, expect, it } from 'vitest';

import { buildFindings, collectStrings, groupImportsFromIdaPro } from '../idaPePlugin';
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

describe('the string scan and the size of what it kept', () => {
  /** A buffer holding `count` distinct printable strings, NUL separated. */
  function bufferOfStrings(count: number, prefix = 'string_'): Buffer {
    const parts: string[] = [];
    for (let index = 0; index < count; index += 1) {
      parts.push(`${prefix}${String(index).padStart(5, '0')}_padding`);
    }
    return Buffer.from(parts.join('\u0000') + '\u0000', 'ascii');
  }

  it('counts every string it found, not the ones it kept', () => {
    // The counts were taken from the sample, which made 160 the largest number
    // of strings any binary could be said to contain.
    const scan = collectStrings(bufferOfStrings(400));
    expect(scan.hits.length).toBe(160);
    expect(scan.total).toBe(400);
    expect(scan.truncated).toBe(true);
  });

  it('is not truncated when everything fits', () => {
    const scan = collectStrings(bufferOfStrings(12));
    expect(scan.hits.length).toBe(12);
    expect(scan.total).toBe(12);
    expect(scan.truncated).toBe(false);
  });

  it('counts suspicious strings over the whole scan', () => {
    // One suspicious string among four hundred: the count has to find it, and
    // the sample has to carry it, or the finding beside the count cites nothing.
    const buffer = Buffer.concat([
      bufferOfStrings(400),
      Buffer.from('powershell.exe -enc SQBFAFgA\u0000', 'ascii'),
    ]);
    const scan = collectStrings(buffer);
    expect(scan.suspiciousTotal).toBe(1);
    expect(scan.hits.some((hit) => hit.suspicious)).toBe(true);
    // Suspicious sorts first, so the cap can never be what hides it.
    expect(scan.hits[0].suspicious).toBe(true);
  });
});

describe('evidence, and how much of it there was', () => {
  function moduleWith(names: string[]): PeImportModule {
    return {
      module: 'kernel32.dll',
      count: names.length,
      suspiciousCount: names.length,
      names,
      suspiciousNames: names,
    };
  }

  it('counts the indicators behind a finding, not the ones it prints', () => {
    // Six chips with nothing saying "six of what" read as the complete case for
    // a finding. On a real import table there can be many more.
    const injection = [
      'WriteProcessMemory',
      'CreateRemoteThread',
      'VirtualAllocEx',
      'OpenProcess',
      'NtWriteVirtualMemory',
      'QueueUserAPC',
      'VirtualProtectEx',
      'RtlCreateUserThread',
    ];
    const findings = buildFindings(metadata, sections, [moduleWith(injection)], noStrings);
    const found = findings.find((entry) => entry.id === 'process-injection');
    expect(found?.evidence).toHaveLength(6);
    expect(found?.evidenceTotal).toBe(injection.length);
  });

  it('reports evidenceTotal equal to the list when nothing was cut', () => {
    const findings = buildFindings(
      metadata,
      sections,
      [moduleWith(['WriteProcessMemory', 'CreateRemoteThread'])],
      noStrings,
    );
    const found = findings.find((entry) => entry.id === 'process-injection');
    expect(found?.evidence).toHaveLength(2);
    expect(found?.evidenceTotal).toBe(2);
  });

  it('never drops a finding to keep the list short', () => {
    // There are seven of these and they are the product of the whole triage.
    // The old cap of eight could not bite yet, which is exactly why it would
    // have gone unnoticed when an eighth was added.
    const packed: PeSectionSummary[] = [
      { ...sections[0], name: 'UPX0', entropy: 7.9 },
      { ...sections[0], name: 'UPX1', entropy: 7.8 },
    ];
    const strings: PeStringHit[] = [
      { value: 'powershell.exe -enc', kind: 'ascii', offset: '1000', suspicious: true },
      { value: 'http://example.test/x', kind: 'ascii', offset: '1010', suspicious: true },
    ];
    const findings = buildFindings(
      { ...metadata, tlsDirectoryPresent: true },
      packed,
      [moduleWith(['WriteProcessMemory', 'InternetOpenW', 'IsDebuggerPresent'])],
      strings,
    );
    // Five distinct findings from one sample, none of them lost.
    expect(new Set(findings.map((entry) => entry.id)).size).toBe(findings.length);
    expect(findings.length).toBeGreaterThanOrEqual(5);
  });
});
