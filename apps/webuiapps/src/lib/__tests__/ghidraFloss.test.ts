// @vitest-environment node
//
// FLOSS is the difference between "this binary has no interesting strings" and
// "every interesting string in this binary was hidden". The parser is the part
// that has to be forgiving: FLOSS's JSON has moved across versions, and a parser
// pinned to one shape silently reports zero on the operator's build -- which
// reads exactly like a clean binary.
import { describe, expect, it } from 'vitest';

import {
  MAX_DECODED_STRINGS,
  countByKind,
  parseFlossResult,
  runFloss,
  selectInterestingDecoded,
} from '../ghidraFloss';
import { normalizeGhidraLabConfig } from '../ghidraLabConfig';

const BINARY = 'C:\\bins\\client.exe';

function config(patch: Record<string, unknown> = {}) {
  return normalizeGhidraLabConfig({
    ghidraInstallDir: 'C:\\ghidra',
    jdkHome: 'C:\\jdk21',
    projectRoot: 'C:\\projects',
    ...patch,
  });
}

describe('parseFlossResult', () => {
  it('reads the nested shape current builds emit', () => {
    const parsed = parseFlossResult({
      metadata: { version: '3.1.1' },
      strings: {
        decoded_strings: [
          {
            string: 'http://c2.example.com/gate.php',
            address: 4198400,
            decoding_routine: 4200000,
          },
        ],
        stack_strings: [{ string: 'ntdll.dll', program_counter: 4198500 }],
        tight_strings: [{ string: 'NtLoadDriver', program_counter: 4198600 }],
        static_strings: [{ string: 'boring', offset: 1024, encoding: 'ASCII' }],
      },
    });
    expect(parsed).toHaveLength(4);
    const decoded = parsed.find((entry) => entry.kind === 'decoded');
    expect(decoded?.value).toBe('http://c2.example.com/gate.php');
    // Addresses arrive as integers and have to come back as hex, because every
    // other address in the ledger is hex and a reader compares them by eye.
    expect(decoded?.address).toBe('0x401000');
    expect(decoded?.decodingRoutine).toBe('0x401640');
    expect(parsed.find((entry) => entry.kind === 'static')?.encoding).toBe('ASCII');
  });

  it('reads the flat shape older builds emit', () => {
    const parsed = parseFlossResult({
      decoded_strings: [{ value: 'secret', decoded_at: '0x401000' }],
      stack_strings: ['bare string'],
    });
    expect(parsed.map((entry) => entry.value)).toEqual(['secret', 'bare string']);
    expect(parsed[0].kind).toBe('decoded');
    expect(parsed[1].kind).toBe('stack');
  });

  it('accepts a hex address, a decimal string and an integer alike', () => {
    const parsed = parseFlossResult({
      strings: {
        decoded_strings: [
          { string: 'a', address: '0x401000' },
          { string: 'b', address: '4198400' },
          { string: 'c', address: 4198400 },
          { string: 'd', address: 'somewhere else' },
        ],
      },
    });
    expect(parsed.map((entry) => entry.address)).toEqual([
      '0x401000',
      '0x401000',
      '0x401000',
      'somewhere else',
    ]);
  });

  it('returns nothing for a document it does not recognise, rather than throwing', () => {
    expect(parseFlossResult(null)).toEqual([]);
    expect(parseFlossResult('not json')).toEqual([]);
    expect(parseFlossResult({ nope: true })).toEqual([]);
    expect(parseFlossResult({ strings: { decoded_strings: [null, 42, {}] } })).toEqual([]);
  });

  it('keeps the same plaintext from two decoders, and drops a repeat from one', () => {
    // A binary with two decoders is a different thing from a binary with one,
    // so the routine is part of the identity.
    const parsed = parseFlossResult({
      strings: {
        decoded_strings: [
          { string: 'kernel32.dll', decoding_routine: 4198400 },
          { string: 'kernel32.dll', decoding_routine: 4198400 },
          { string: 'kernel32.dll', decoding_routine: 4210000 },
        ],
      },
    });
    expect(parsed).toHaveLength(2);
    expect(parsed.map((entry) => entry.decodingRoutine)).toEqual(['0x401000', '0x403d50']);
  });

  it('caps a value that is a blob rather than a string', () => {
    const parsed = parseFlossResult({
      strings: { decoded_strings: [{ string: 'x'.repeat(5000) }] },
    });
    expect(parsed[0].value.length).toBeLessThan(1000);
  });
});

describe('selectInterestingDecoded', () => {
  it('drops static strings, which the sweep already lists', () => {
    const selected = selectInterestingDecoded([
      { value: 'plain', kind: 'static', address: '', decodingRoutine: '', encoding: 'ASCII' },
      { value: 'hidden', kind: 'decoded', address: '', decodingRoutine: '0x1', encoding: '' },
    ]);
    expect(selected.map((entry) => entry.value)).toEqual(['hidden']);
  });

  it('orders by how much work went into hiding the string', () => {
    const selected = selectInterestingDecoded([
      { value: 'stack one', kind: 'stack', address: '', decodingRoutine: '', encoding: '' },
      { value: 'decoded one', kind: 'decoded', address: '', decodingRoutine: '', encoding: '' },
      { value: 'tight one', kind: 'tight', address: '', decodingRoutine: '', encoding: '' },
    ]);
    // A decoded string means there is a decoder function worth reading, which is
    // a lead in a way that a stack string is not.
    expect(selected.map((entry) => entry.kind)).toEqual(['decoded', 'tight', 'stack']);
  });

  it('drops one-character noise and honours the cap', () => {
    const many = Array.from({ length: MAX_DECODED_STRINGS + 50 }, (_unused, index) => ({
      value: `string-${index}`,
      kind: 'decoded' as const,
      address: '',
      decodingRoutine: '',
      encoding: '',
    }));
    const selected = selectInterestingDecoded([
      ...many,
      { value: 'x', kind: 'decoded', address: '', decodingRoutine: '', encoding: '' },
    ]);
    expect(selected).toHaveLength(MAX_DECODED_STRINGS);
    expect(selected.some((entry) => entry.value === 'x')).toBe(false);
  });
});

describe('countByKind', () => {
  it('counts every kind, including the ones that are zero', () => {
    const counts = countByKind([
      { value: 'a', kind: 'decoded', address: '', decodingRoutine: '', encoding: '' },
      { value: 'b', kind: 'decoded', address: '', decodingRoutine: '', encoding: '' },
      { value: 'c', kind: 'stack', address: '', decodingRoutine: '', encoding: '' },
    ]);
    expect(counts).toEqual({ static: 0, stack: 1, tight: 0, decoded: 2, language: 0 });
  });
});

describe('runFloss', () => {
  function fakeChild() {
    const listeners = new Map<string, ((value: never) => void)[]>();
    const stream = (prefix: string) => ({
      setEncoding: () => {},
      on: (event: string, fn: never) => {
        const key = `${prefix}:${event}`;
        listeners.set(key, [...(listeners.get(key) ?? []), fn]);
      },
    });
    const child = {
      stdout: stream('out'),
      stderr: stream('err'),
      kill: () => {},
      on: (event: string, fn: never) => {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      },
    };
    const emit = (event: string, value?: unknown): void => {
      for (const fn of listeners.get(event) ?? []) {
        (fn as unknown as (arg: unknown) => void)(value);
      }
    };
    return { child, emit };
  }

  const flossConfig = config({ flossExePath: 'C:\\tools\\floss.exe' });

  it('refuses cleanly when FLOSS is not configured', async () => {
    const result = await runFloss({ binaryPath: BINARY, config: config() });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('floss_not_configured');
  });

  it('does not ask FLOSS for static strings, which the sweep already has', async () => {
    const { child, emit } = fakeChild();
    let args: readonly string[] = [];
    const pending = runFloss({ binaryPath: BINARY, config: flossConfig }, ((
      _program: string,
      spawnArgs: readonly string[],
    ) => {
      args = spawnArgs;
      return child;
    }) as unknown as Parameters<typeof runFloss>[1]);
    await Promise.resolve();
    emit('out:data', '{"strings":{}}');
    emit('close', 0);
    await pending;
    // Asking for them again doubles a run that already takes minutes.
    expect(args).toContain('--json');
    expect(args.join(' ')).toContain('--no static');
    expect(args[args.length - 1]).toBe(BINARY);
  });

  it('parses the JSON document FLOSS writes to stdout', async () => {
    const { child, emit } = fakeChild();
    const pending = runFloss(
      { binaryPath: BINARY, config: flossConfig },
      (() => child) as unknown as Parameters<typeof runFloss>[1],
    );
    await Promise.resolve();
    emit('out:data', 'FLOSS banner\n{"strings":{"decoded_strings":[{"string":"hi"}]}}');
    emit('close', 0);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(parseFlossResult(result.payload)[0].value).toBe('hi');
  });

  it('keeps the TAIL of stderr, which is where the reason is', async () => {
    // FLOSS writes a progress bar to stderr, so the head is a banner.
    const { child, emit } = fakeChild();
    const pending = runFloss(
      { binaryPath: BINARY, config: flossConfig },
      (() => child) as unknown as Parameters<typeof runFloss>[1],
    );
    await Promise.resolve();
    emit('err:data', `${'progress '.repeat(200)}ERROR: not a PE file`);
    emit('close', 1);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not a PE file');
  });

  it('reports unparseable output instead of claiming a result', async () => {
    const { child, emit } = fakeChild();
    const pending = runFloss(
      { binaryPath: BINARY, config: flossConfig },
      (() => child) as unknown as Parameters<typeof runFloss>[1],
    );
    await Promise.resolve();
    emit('out:data', '{"strings": truncated');
    emit('close', 0);
    expect((await pending).error).toContain('not JSON');
  });

  it('surfaces a spawn that throws and a child that errors', async () => {
    const thrown = await runFloss({ binaryPath: BINARY, config: flossConfig }, (() => {
      throw new Error('EACCES');
    }) as unknown as Parameters<typeof runFloss>[1]);
    expect(thrown.error).toBe('EACCES');

    const { child, emit } = fakeChild();
    const pending = runFloss(
      { binaryPath: BINARY, config: flossConfig },
      (() => child) as unknown as Parameters<typeof runFloss>[1],
    );
    await Promise.resolve();
    emit('error', new Error('ENOENT'));
    expect((await pending).error).toBe('ENOENT');
  });
});
