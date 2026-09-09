// @vitest-environment node
//
// The query policy is the narrow gate between Aoi and an MCP server that
// publishes dozens of tools including database mutators and raw byte reads. Two
// properties matter:
//
//   - An unknown sub-command is REFUSED, not forwarded. Otherwise `ghidra_query`
//     becomes a general MCP gateway for anyone who can invent a `kind`.
//   - Engine answers are bounded on three axes, because one decompiled function
//     can be tens of kilobytes on its own.
import { describe, expect, it } from 'vitest';

import {
  GHIDRA_QUERY_MAX_ROWS,
  GHIDRA_QUERY_SPECS,
  capGhidraQueryRows,
  findGhidraQuerySpec,
  normalizeGhidraToolResult,
  planGhidraQuery,
} from '../ghidraLabQuery';

describe('planGhidraQuery', () => {
  it('maps each known sub-command onto exactly one tool', () => {
    for (const spec of GHIDRA_QUERY_SPECS) {
      // Supply whatever this spec actually requires -- the engine's required
      // arguments differ per tool (name_or_address, function_name, query).
      const args: Record<string, unknown> = {};
      for (const key of spec.requiredArgs) {
        args[key] = 'x';
      }
      const plan = planGhidraQuery(spec.kind, args);
      expect(plan.ok, spec.kind).toBe(true);
      expect(plan.tool).toBe(spec.tool);
      expect(plan.candidates[0]).toBe(spec.tool);
    }
  });

  it('fills the engine-required query that callers have no reason to supply', () => {
    // search_strings and search_symbols_by_name both demand a `query`; asking for
    // everything is legitimate, so it defaults to match-all rather than refusing.
    // search_strings is SUBSTRING matching, not regex: '.*' matched nothing on a
    // binary with 132 strings, while the empty string matches everything.
    expect(planGhidraQuery('strings', {}).args.query).toBe('');
    expect(planGhidraQuery('functions', {}).args.query).toBe('.*');
    expect(planGhidraQuery('functions', {}).args.functions_only).toBe(true);
    expect(planGhidraQuery('imports', {}).args.query).toBe('.*');
    expect(planGhidraQuery('strings', { pattern: 'http' }).args.query).toBe('http');
  });

  it('translates the caller vocabulary into the engine argument names', () => {
    // A function target is `name_or_address` here and `function_name` there;
    // callers say `name` and this is where that is reconciled.
    expect(planGhidraQuery('decompile', { name: 'main' }).args.name_or_address).toBe('main');
    expect(planGhidraQuery('xrefs', { address: '0x1000' }).args.name_or_address).toBe('0x1000');
    expect(planGhidraQuery('callgraph', { name: 'DllMain' }).args.function_name).toBe('DllMain');
    expect(planGhidraQuery('decompile', { name: 'main' }).args.name).toBeUndefined();
  });

  it('refuses an unknown sub-command and lists the real ones', () => {
    for (const kind of ['read_bytes', 'rename_function', '', null, 42, {}]) {
      const plan = planGhidraQuery(kind, {});
      expect(plan.ok).toBe(false);
      expect(plan.reason).toContain('unknown_query_kind');
    }
    expect(planGhidraQuery('nope', {}).reason).toContain('decompile');
  });

  it('drops arguments that are not on the spec allowlist', () => {
    const plan = planGhidraQuery('imports', {
      binary_name: 'client.exe',
      shell: 'rm -rf /',
      __proto__: 'x',
    });
    expect(plan.args.binary_name).toBe('client.exe');
    expect(plan.args.shell).toBeUndefined();
    expect(plan.droppedArgs).toContain('shell');
  });

  it('drops nested objects rather than serializing them into an engine argument', () => {
    const plan = planGhidraQuery('decompile', { name: { evil: true } });
    expect(plan.args.name).toBeUndefined();
    expect(plan.droppedArgs).toContain('name');
  });

  it('accepts arrays of scalars, which is how the batch tools take targets', () => {
    const plan = planGhidraQuery('decompile', { names: ['a', 'b'], include_xrefs: true });
    expect(plan.args.name_or_address).toEqual(['a', 'b']);
    expect(plan.args.include_xrefs).toBe(true);
  });

  it('rejects an array containing objects', () => {
    const plan = planGhidraQuery('decompile', { names: [{ a: 1 }] });
    expect(plan.droppedArgs).toContain('names');
    expect(plan.args.name_or_address).toBeUndefined();
  });

  it('refuses when a required argument is missing', () => {
    const plan = planGhidraQuery('search', {});
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('missing_required_args: query');

    const noTarget = planGhidraQuery('decompile', {});
    expect(noTarget.ok).toBe(false);
    expect(noTarget.reason).toContain('name_or_address');
  });

  it('applies a default limit and clamps an oversized one', () => {
    expect(planGhidraQuery('strings', {}).args.limit).toBe(GHIDRA_QUERY_MAX_ROWS);
    expect(planGhidraQuery('strings', { limit: 99999 }).args.limit).toBe(GHIDRA_QUERY_MAX_ROWS);
    expect(planGhidraQuery('strings', { limit: 10 }).args.limit).toBe(10);
  });

  it('ignores null and undefined argument values', () => {
    const plan = planGhidraQuery('imports', { binary_name: null, pattern: undefined });
    expect(plan.args.binary_name).toBeUndefined();
    expect(plan.droppedArgs).toEqual([]);
  });

  it('tolerates a non-object args payload', () => {
    expect(planGhidraQuery('imports', 'nope').ok).toBe(true);
    expect(planGhidraQuery('imports', ['a']).ok).toBe(true);
    expect(planGhidraQuery('imports', null).ok).toBe(true);
  });
});

describe('findGhidraQuerySpec', () => {
  it('resolves known kinds and rejects everything else', () => {
    expect(findGhidraQuerySpec('decompile')?.tool).toBe('decompile_function');
    expect(findGhidraQuerySpec('read_bytes')).toBeNull();
    expect(findGhidraQuerySpec(7)).toBeNull();
  });
});

describe('capGhidraQueryRows', () => {
  it('caps by row count', () => {
    const rows = Array.from({ length: 500 }, (_, index) => index);
    const capped = capGhidraQueryRows(rows, 10);
    expect(capped.rowCount).toBe(10);
    expect(capped.truncated).toBe(true);
  });

  it('caps by total characters when many rows are individually under the row cap', () => {
    // 5000 chars each is below the per-row cap, so the total is what bites.
    const rows = Array.from({ length: 20 }, () => 'x'.repeat(5000));
    const capped = capGhidraQueryRows(rows, 100, 50000);
    expect(capped.rowCount).toBeLessThan(20);
    expect(capped.truncated).toBe(true);
  });

  it('applies the per-row cap before the total, so a few huge rows all survive', () => {
    // Three 40k rows are 120k raw but only ~18k after the per-row cap, which is
    // the intended order: shrink each row first, drop rows only if still over.
    const rows = ['x'.repeat(40000), 'y'.repeat(40000), 'z'.repeat(40000)];
    const capped = capGhidraQueryRows(rows, 100, 50000);
    expect(capped.rowCount).toBe(3);
    for (const row of capped.rows) {
      expect(String(row)).toContain('[truncated]');
    }
  });

  it('caps an individual oversized row rather than dropping it', () => {
    const capped = capGhidraQueryRows(['q'.repeat(20000)], 10, 1_000_000);
    expect(capped.rowCount).toBe(1);
    expect(String(capped.rows[0])).toContain('[truncated]');
  });

  it('keeps a small answer intact', () => {
    const capped = capGhidraQueryRows([{ a: 1 }, { b: 2 }]);
    expect(capped.rowCount).toBe(2);
    expect(capped.truncated).toBe(false);
  });

  it('survives rows that cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => capGhidraQueryRows([cyclic])).not.toThrow();
  });

  it('always keeps at least one row', () => {
    const capped = capGhidraQueryRows(['a'.repeat(10000)], 10, 10);
    expect(capped.rowCount).toBe(1);
  });
});

describe('capping an oversized single row', () => {
  it('caps a long string field inside an object row', () => {
    // A decompiled body arrives as { name, code } with the whole function in
    // `code`, so an object row was the one shape that needed the per-row cap and
    // the only shape that did not get it.
    const [row] = capGhidraQueryRows([{ name: 'f', code: 'x'.repeat(500_000) }]).rows;
    const code = (row as { name: string; code: string }).code;
    expect((row as { name: string }).name).toBe('f');
    expect(code.length).toBeLessThan(500_000);
    expect(code).toContain('[truncated]');
  });

  it('says truncated when the only row is over the total budget on its own', () => {
    // Answering with nothing would be worse, so the row goes through even when
    // it does not fit -- but reporting truncated:false about it told the caller
    // the answer was complete.
    const out = capGhidraQueryRows([{ blob: 'y'.repeat(5_000) }], 40, 1_000);
    expect(out.rows).toHaveLength(1);
    expect(out.truncated).toBe(true);
  });

  it('leaves a row that is already within the caps exactly as it was', () => {
    const row = { name: 'f', code: 'short' };
    expect(capGhidraQueryRows([row]).rows[0]).toBe(row);
  });
});

describe('normalizeGhidraToolResult', () => {
  it('unwraps the standard MCP text-content envelope', () => {
    expect(
      normalizeGhidraToolResult({ content: [{ type: 'text', text: '[{"name":"a"}]' }] }),
    ).toEqual([{ name: 'a' }]);
  });

  it('keeps non-JSON text as a single row', () => {
    expect(normalizeGhidraToolResult({ content: [{ type: 'text', text: 'plain text' }] })).toEqual([
      'plain text',
    ]);
  });

  it('unwraps a single JSON object inside a text block', () => {
    expect(normalizeGhidraToolResult({ content: [{ type: 'text', text: '{"a":1}' }] })).toEqual([
      { a: 1 },
    ]);
  });

  it('prefers structuredContent when present', () => {
    expect(
      normalizeGhidraToolResult({ structuredContent: [1, 2], content: [{ text: '[]' }] }),
    ).toEqual([1, 2]);
  });

  it('unwraps the singular `result` envelope decompile actually returns', () => {
    // Measured shape: { result: [{ name, code }] }. Missing this key cost the
    // entire deep-read stage -- the engine answered and the bodies were dropped.
    expect(
      normalizeGhidraToolResult({
        result: [{ name: 'check_managed_app-00412210', code: 'void f(){}' }],
      }),
    ).toEqual([{ name: 'check_managed_app-00412210', code: 'void f(){}' }]);
  });

  it('unwraps the per-kind envelopes the engine uses', () => {
    expect(normalizeGhidraToolResult({ imports: [{ name: 'a' }] })).toEqual([{ name: 'a' }]);
    expect(normalizeGhidraToolResult({ strings: [{ value: 's' }] })).toEqual([{ value: 's' }]);
    expect(normalizeGhidraToolResult({ programs: [{ name: 'p' }] })).toEqual([{ name: 'p' }]);
  });

  it('finds a well-known array field', () => {
    expect(normalizeGhidraToolResult({ binaries: [{ name: 'x' }] })).toEqual([{ name: 'x' }]);
    expect(normalizeGhidraToolResult({ results: ['a'] })).toEqual(['a']);
  });

  it('passes arrays and scalars through', () => {
    expect(normalizeGhidraToolResult([1, 2])).toEqual([1, 2]);
    expect(normalizeGhidraToolResult('text')).toEqual(['text']);
    expect(normalizeGhidraToolResult(42)).toEqual([42]);
  });

  it('returns empty for nothing at all', () => {
    expect(normalizeGhidraToolResult(null)).toEqual([]);
    expect(normalizeGhidraToolResult(undefined)).toEqual([]);
  });

  it('falls back to one row for a shape nobody anticipated', () => {
    expect(normalizeGhidraToolResult({ unexpected: { deeply: 'nested' } })).toEqual([
      { unexpected: { deeply: 'nested' } },
    ]);
  });

  it('keeps a non-text content entry as its own row', () => {
    expect(normalizeGhidraToolResult({ content: [{ type: 'image', data: 'x' }] })).toEqual([
      { type: 'image', data: 'x' },
    ]);
  });

  it('does not choke on malformed JSON in a text block', () => {
    expect(normalizeGhidraToolResult({ content: [{ type: 'text', text: '{broken' }] })).toEqual([
      '{broken',
    ]);
  });
});

describe('a page that came back exactly full', () => {
  it('is reported as truncated, because the request set that limit', () => {
    // The request carries limit = maxRows, so the engine never returns more and
    // `rows.length > maxRows` could never be true. Measured on notepad.exe: 315
    // imports in the file, 200 returned, and the report said "200 imports"
    // without a caveat while every downstream count used the 200.
    const rows = Array.from({ length: GHIDRA_QUERY_MAX_ROWS }, (_unused, index) => ({
      name: `Import${index}`,
    }));
    const capped = capGhidraQueryRows(rows);
    expect(capped.rowCount).toBe(GHIDRA_QUERY_MAX_ROWS);
    expect(capped.truncated).toBe(true);
  });

  it('is not reported as truncated when the page had room to spare', () => {
    const rows = Array.from({ length: GHIDRA_QUERY_MAX_ROWS - 1 }, (_unused, index) => ({
      name: `Import${index}`,
    }));
    expect(capGhidraQueryRows(rows).truncated).toBe(false);
  });
});

describe('the limit a page is judged against', () => {
  it('flags a full page at a smaller limit the caller asked for', () => {
    // The module default is not the only limit in play: a caller can ask for
    // fewer rows, and fifty rows back from a request for fifty is just as much
    // "there are more" as two hundred from a request for two hundred.
    const rows = Array.from({ length: 50 }, (_unused, index) => ({ name: `Row${index}` }));
    expect(capGhidraQueryRows(rows, 50).truncated).toBe(true);
    expect(capGhidraQueryRows(rows, 51).truncated).toBe(false);
  });

  it('does not call an empty answer truncated when the limit is zero', () => {
    expect(capGhidraQueryRows([], 0).truncated).toBe(false);
    expect(capGhidraQueryRows([], 0).rowCount).toBe(0);
  });
});
