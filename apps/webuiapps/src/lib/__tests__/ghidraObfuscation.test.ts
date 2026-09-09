// @vitest-environment node
//
// The claim these functions are allowed to make is "found, located, quantified"
// -- never "undone". The tests hold that line as much as they hold the
// detection: a finding that did not name what would actually reverse it would be
// a verdict with nowhere to go.
import { describe, expect, it } from 'vitest';

import { detectObfuscation, detectSectionObfuscation } from '../ghidraObfuscation';

function flattened(): string {
  const cases = Array.from(
    { length: 12 },
    (_unused, index) => `    case ${index}:\n      state = ${index + 1};\n      break;`,
  ).join('\n');
  return ['  while (true) {', '    switch (state) {', cases, '    }', '  }'].join('\n');
}

describe('detectObfuscation', () => {
  it('recognises a dispatcher loop as control-flow flattening, and names the state variable', () => {
    const [finding] = detectObfuscation({
      bodies: [{ name: 'FUN_00401000', address: '0x401000', decompiled: flattened() }],
    });
    expect(finding.code).toBe('control_flow_flattening');
    expect(finding.functionName).toBe('FUN_00401000');
    expect(finding.detail).toContain('`state`');
    expect(finding.confidence).toBe('strong');
    // The point of the finding is the next step, not the verdict.
    expect(finding.remedy).toContain('D-810');
  });

  it('does not call an ordinary switch flattened', () => {
    const ordinary = [
      'switch (message) {',
      '  case WM_PAINT: paint(); break;',
      '  case WM_CLOSE: close(); break;',
      '  case WM_SIZE: resize(); break;',
      '  case WM_MOVE: move(); break;',
      '  case WM_TIMER: tick(); break;',
      '}',
    ].join('\n');
    expect(
      detectObfuscation({ bodies: [{ name: 'wndproc', address: '0x1', decompiled: ordinary }] }),
    ).toEqual([]);
  });

  it('needs both a loop and enough cases before it will say flattening', () => {
    const fewCases = 'while (true) { switch (s) { case 0: s = 1; break; case 1: return; } }';
    expect(
      detectObfuscation({ bodies: [{ name: 'f', address: '0x1', decompiled: fewCases }] }),
    ).toEqual([]);
  });

  it('finds opaque predicates and says the arms they guard are unreachable', () => {
    const body = [
      'if (7 == 9) { junk_a(); }',
      'if (0x10 != 0x10) { junk_b(); }',
      'if ((x * x) % 2 == 0) { junk_c(); }',
    ].join('\n');
    const findings = detectObfuscation({
      bodies: [{ name: 'f', address: '0x1', decompiled: body }],
    });
    const opaque = findings.find((entry) => entry.code === 'opaque_predicates');
    expect(opaque).toBeDefined();
    expect(opaque?.detail).toContain('cannot vary');
    expect(opaque?.evidence.length).toBeGreaterThan(0);
  });

  it('measures MBA as a density rather than as a keyword', () => {
    const dense = Array.from(
      { length: 12 },
      (_u, i) => `  v${i} = ((a ^ b) & (c | d)) + ((a & b) << 2) - ((c ^ d) >> 3);`,
    ).join('\n');
    const findings = detectObfuscation({
      bodies: [{ name: 'mba', address: '0x1', decompiled: dense }],
    });
    const mba = findings.find((entry) => entry.code === 'mixed_boolean_arithmetic');
    expect(mba).toBeDefined();
    expect(mba?.detail).toMatch(/per statement/);
    expect(mba?.remedy).toContain('gooMBA');
  });

  it('does not call ordinary bit manipulation MBA', () => {
    const normal = [
      'flags = flags | FLAG_A;',
      'value = value & 0xff;',
      'shifted = value << 8;',
      'result = shifted | low;',
      'a = 1; b = 2; c = 3; d = 4; e = 5;',
    ].join('\n');
    const findings = detectObfuscation({
      bodies: [{ name: 'f', address: '0x1', decompiled: normal }],
    });
    expect(findings.some((entry) => entry.code === 'mixed_boolean_arithmetic')).toBe(false);
  });

  it('skips a body that decompiled to nothing rather than scoring it', () => {
    expect(
      detectObfuscation({ bodies: [{ name: 'f', address: '0x1', decompiled: '   ' }] }),
    ).toEqual([]);
  });

  it('puts the findings that change the analysis first', () => {
    const findings = detectObfuscation({
      bodies: [
        {
          name: 'mba',
          address: '0x2',
          decompiled: Array.from(
            { length: 12 },
            () => 'v = ((a ^ b) & (c | d)) + ((a & b) << 2) - ((c ^ d) >> 3);',
          ).join('\n'),
        },
        { name: 'flat', address: '0x1', decompiled: flattened() },
      ],
      sectionNames: ['.text', 'UPX0'],
    });
    // A packed image means the decompiled code is the stub; nothing else in the
    // list matters until that is dealt with.
    expect(findings[0].code).toBe('packer_sections');
    expect(findings[1].code).toBe('control_flow_flattening');
  });
});

describe('detectSectionObfuscation', () => {
  it('names the packer and says the decompiled code is the stub', () => {
    const [finding] = detectSectionObfuscation({ sectionNames: ['.text', 'UPX1', '.rsrc'] });
    expect(finding.code).toBe('packer_sections');
    expect(finding.confidence).toBe('strong');
    expect(finding.detail).toContain('stub');
    expect(finding.remedy).toContain('Unpack');
  });

  it('reports a high-entropy section as content the decompiler cannot read', () => {
    const findings = detectSectionObfuscation({
      entropyBySection: { '.text': 6.1, '.data': 7.6 },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('high_entropy_section');
    expect(findings[0].detail).toContain('.data');
    expect(findings[0].confidence).toBe('moderate');
  });

  it('says nothing about an ordinary section table', () => {
    expect(
      detectSectionObfuscation({ sectionNames: ['.text', '.rdata', '.data', '.rsrc', '.reloc'] }),
    ).toEqual([]);
    expect(detectSectionObfuscation({})).toEqual([]);
  });
});
