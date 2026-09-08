// @vitest-environment node
//
// The deterministic spine of the report. If these rules are wrong the model has
// nothing true to write about, so they are pinned tightly -- including the cases
// where the honest answer is "uncategorised" rather than a guess.
import { describe, expect, it } from 'vitest';

import {
  bucketString,
  categorizeApi,
  detectAntiAnalysis,
  selectFunctionsForDeepRead,
  summarizeImportCapabilities,
  summarizeStrings,
  uncategorizedImports,
} from '../ghidraLabHeuristics';

describe('categorizeApi', () => {
  it('recognises the process-manipulation set this lab exists for', () => {
    expect(categorizeApi('WriteProcessMemory').map((match) => match.category)).toContain('memory');
    expect(categorizeApi('CreateRemoteThread').map((match) => match.category)).toContain(
      'injection',
    );
    expect(categorizeApi('DeviceIoControl').map((match) => match.category)).toContain('driver');
    expect(categorizeApi('IsDebuggerPresent').map((match) => match.category)).toContain(
      'anti-debug',
    );
    expect(categorizeApi('AdjustTokenPrivileges').map((match) => match.category)).toContain(
      'privilege',
    );
  });

  it('matches regardless of the A/W suffix and of case', () => {
    expect(categorizeApi('loadlibraryw').length).toBeGreaterThan(0);
    expect(categorizeApi('RegOpenKeyExA').map((match) => match.category)).toContain('registry');
  });

  it('returns every rule a symbol matches, not just the first', () => {
    // WriteProcessMemory is both a memory access and the thing inline hooking needs.
    const categories = categorizeApi('WriteProcessMemory').map((match) => match.category);
    expect(categories).toContain('memory');
    expect(categories).toContain('hooking');
  });

  it('returns nothing for a symbol it does not know, rather than guessing', () => {
    expect(categorizeApi('SomeVendorSpecificThing')).toEqual([]);
    expect(categorizeApi('')).toEqual([]);
  });
});

describe('summarizeImportCapabilities', () => {
  const imports = [
    { symbol: 'Sleep', library: 'kernel32.dll' },
    { symbol: 'NtLoadDriver', library: 'ntdll.dll' },
    { symbol: 'WriteProcessMemory', library: 'kernel32.dll' },
    { symbol: 'RegOpenKeyExA', library: 'advapi32.dll' },
  ];

  it('leads with the heaviest capability, not the alphabetically first', () => {
    const signals = summarizeImportCapabilities(imports);
    expect(['driver', 'memory']).toContain(signals[0].category);
    const categories = signals.map((signal) => signal.category);
    expect(categories.indexOf('driver')).toBeLessThan(categories.indexOf('registry'));
    expect(categories.indexOf('memory')).toBeLessThan(categories.indexOf('time'));
  });

  it('keeps the symbols that justify each claim', () => {
    const driver = summarizeImportCapabilities(imports).find(
      (signal) => signal.category === 'driver',
    );
    expect(driver?.symbols).toContain('NtLoadDriver');
    expect(driver?.claim).toContain('kernel driver');
  });

  it('does not repeat a symbol inside one signal', () => {
    const signals = summarizeImportCapabilities([
      { symbol: 'OpenProcess' },
      { symbol: 'OpenProcess' },
    ]);
    const process = signals.find((signal) => signal.category === 'process');
    expect(process?.symbols).toEqual(['OpenProcess']);
  });

  it('reports what it could not categorise instead of hiding it', () => {
    expect(uncategorizedImports([{ symbol: 'VendorInit' }, { symbol: 'OpenProcess' }])).toEqual([
      'VendorInit',
    ]);
  });
});

describe('bucketString', () => {
  it('sorts the shapes that matter into their own buckets', () => {
    expect(bucketString('https://example.com/beacon')).toBe('url');
    expect(bucketString('\\\\.\\Tvk')).toBe('device');
    expect(bucketString('HKEY_LOCAL_MACHINE\\Software\\Foo')).toBe('registry');
    expect(bucketString('C:\\Windows\\System32\\drivers\\x.sys')).toBe('path');
    expect(bucketString('cmd.exe /c whoami')).toBe('command');
    expect(bucketString('cdn.example.co.uk')).toBe('host');
    expect(bucketString('10.0.0.1')).toBe('host');
    expect(bucketString('{12345678-1234-1234-1234-123456789abc}')).toBe('guid');
    expect(bucketString('failed to open %s (%d)')).toBe('format');
    expect(bucketString('hello world')).toBe('other');
  });

  it('files a module name as a module, not as a network host', () => {
    // "kernel32.dll" matches the host pattern exactly (letters-dot-letters), and
    // a report listing every imported DLL as a host is actively misleading --
    // observed on a real run where all five "hosts" were DLLs.
    for (const name of ['kernel32.dll', 'MSVCR100D.dll', 'Tvk.sys', 'client.exe']) {
      expect(bucketString(name)).toBe('module');
    }
    expect(bucketString('cdn.example.co.uk')).toBe('host');
    expect(bucketString('10.0.0.1')).toBe('host');
  });

  it('prefers the more specific bucket when two patterns could match', () => {
    // A URL also contains a host; it must not be filed as one.
    expect(bucketString('https://cdn.example.com')).toBe('url');
    // A registry path is also a backslash path.
    expect(bucketString('SOFTWARE\\Microsoft\\Windows')).toBe('registry');
  });

  it('treats blank input as other rather than throwing', () => {
    expect(bucketString('')).toBe('other');
    expect(bucketString('   ')).toBe('other');
  });
});

describe('summarizeStrings', () => {
  it('counts everything but samples only a bounded number', () => {
    const strings = Array.from({ length: 50 }, (_, index) => ({
      value: `https://host${index}.example.com/`,
      address: `0x${(0x140000000 + index).toString(16)}`,
    }));
    const summary = summarizeStrings(strings, 5);
    const urls = summary.find((entry) => entry.bucket === 'url');
    expect(urls?.count).toBe(50);
    expect(urls?.samples).toHaveLength(5);
    expect(urls?.samples[0].address).toBeTruthy();
  });

  it('puts the interesting buckets first', () => {
    const summary = summarizeStrings([
      { value: 'just some text' },
      { value: 'just some other text' },
      { value: 'https://example.com' },
    ]);
    expect(summary[0].bucket).toBe('url');
  });
});

describe('detectAntiAnalysis', () => {
  it('flags anti-debug imports with the symbols that triggered it', () => {
    const indicators = detectAntiAnalysis({
      imports: [{ symbol: 'IsDebuggerPresent' }, { symbol: 'CheckRemoteDebuggerPresent' }],
    });
    const antiDebug = indicators.find((entry) => entry.code === 'anti_debug_imports');
    expect(antiDebug?.evidence).toContain('IsDebuggerPresent');
  });

  it('hedges on a small import table instead of calling it packed', () => {
    const indicators = detectAntiAnalysis({
      imports: [{ symbol: 'LoadLibraryA' }, { symbol: 'GetProcAddress' }],
    });
    const minimal = indicators.find((entry) => entry.code === 'minimal_import_table');
    expect(minimal?.detail).toContain('not proof');
  });

  it('does not flag a large import table as minimal', () => {
    const imports = Array.from({ length: 40 }, (_, index) => ({ symbol: `Api${index}` }));
    imports.push({ symbol: 'LoadLibraryA' });
    const indicators = detectAntiAnalysis({ imports });
    expect(indicators.some((entry) => entry.code === 'minimal_import_table')).toBe(false);
  });

  it('recognises packer section names and VM-detection strings', () => {
    const indicators = detectAntiAnalysis({
      imports: [],
      sectionNames: ['.text', 'UPX0', '.vmp0'],
      strings: [{ value: 'VMware SVGA II' }, { value: 'hello' }],
    });
    expect(indicators.some((entry) => entry.code === 'packer_section_names')).toBe(true);
    expect(indicators.some((entry) => entry.code === 'vm_detection_strings')).toBe(true);
  });

  it('says nothing when there is nothing to say', () => {
    expect(detectAntiAnalysis({ imports: [{ symbol: 'CreateFileW' }] })).toEqual([]);
  });
});

describe('selectFunctionsForDeepRead', () => {
  it('ranks the entry point and API-touching functions above filler', () => {
    const selected = selectFunctionsForDeepRead([
      { name: 'sub_401000', address: '0x401000', size: 40 },
      { name: 'DriverEntry', address: '0x140001000', isEntryPoint: true },
      {
        name: 'sub_402000',
        address: '0x402000',
        size: 900,
        callsImports: ['WriteProcessMemory'],
      },
    ]);
    expect(selected[0].name).toBe('DriverEntry');
    expect(selected[1].name).toBe('sub_402000');
    expect(selected[1].reasons.join(' ')).toContain('memory');
  });

  it('records why each function was chosen', () => {
    const [entry] = selectFunctionsForDeepRead([
      { name: 'DllMain', address: '0x1000', isEntryPoint: true, isExport: true },
    ]);
    expect(entry.reasons).toContain('entry point');
    expect(entry.reasons).toContain('exported');
  });

  it('pushes runtime boilerplate down even when it is large', () => {
    const selected = selectFunctionsForDeepRead([
      { name: '__scrt_common_main_seh', address: '0x1000', size: 8192 },
      {
        name: 'ScanProcessMemory',
        address: '0x2000',
        size: 512,
        callsImports: ['ReadProcessMemory'],
      },
    ]);
    expect(selected[0].name).toBe('ScanProcessMemory');
  });

  it('honours the limit and drops zero-score candidates', () => {
    const many = Array.from({ length: 200 }, (_, index) => ({
      name: `sub_${index}`,
      address: `0x${index.toString(16)}`,
      size: 100,
      xrefCount: 1,
    }));
    expect(selectFunctionsForDeepRead(many, 10)).toHaveLength(10);
    expect(selectFunctionsForDeepRead([{ name: '', address: '' }])).toEqual([]);
  });
});
