import { describe, expect, it } from 'vitest';
import {
  IdaSqlSessionManager,
  looksLikeIdaSqlStatus,
  parseIdaSqlQueryResponse,
} from '../idaSqlSession';

// Captured verbatim from idasql v0.0.18.1 (ida94 build) serving
// F:\Aoi\samples\where.exe over --http on 2026-08-27. Everything above this
// point in the suite used shapes the README implied; these are the real thing.
//
// The lesson that produced this file: idasql answers a FAILED statement with
// HTTP 200, a top-level "success": false, and the message nested in
// results[i].error. A parser that only looked at the top level reported "no such
// column" as a perfectly successful query returning zero rows.

const REAL_STATUS = '{"functions":103,"status":"ok","success":true,"tool":"idasql"}';

const REAL_SUCCESS_TWO_STATEMENTS =
  '{"success":true,"statement_count":2,"results":[{"statement_index":0,"success":true,' +
  '"columns":["a"],"rows":[["1"]],"row_count":1,"elapsed_ms":0,"error":null},' +
  '{"statement_index":1,"success":true,"columns":["b"],"rows":[["2"]],"row_count":1,' +
  '"elapsed_ms":0,"error":null}],"row_count_total":2,"elapsed_ms_total":0,' +
  '"first_error_index":null}';

const REAL_UNKNOWN_COLUMN =
  '{"success":false,"statement_count":1,"results":[{"statement_index":0,"success":false,' +
  '"columns":[],"rows":[],"row_count":0,"elapsed_ms":0,' +
  '"error":"no such column: start_ea"}],"row_count_total":0,"elapsed_ms_total":0,' +
  '"first_error_index":0}';

const REAL_SYNTAX_ERROR =
  '{"success":false,"statement_count":1,"results":[{"statement_index":0,"success":false,' +
  '"columns":[],"rows":[],"row_count":0,"elapsed_ms":0,' +
  '"error":"near \\"SELCT\\": syntax error"}],"row_count_total":0,"elapsed_ms_total":0,' +
  '"first_error_index":0}';

const REAL_DOT_COMMAND_REJECTED =
  '{"success":false,"statement_count":1,"results":[{"statement_index":0,"success":false,' +
  '"columns":[],"rows":[],"row_count":0,"elapsed_ms":0,' +
  '"error":"near \\".\\": syntax error"}],"row_count_total":0,"elapsed_ms_total":0,' +
  '"first_error_index":0}';

const REAL_FUNCS_ROWS =
  '{"success":true,"statement_count":1,"results":[{"statement_index":0,"success":true,' +
  '"columns":["name","addr","size"],"rows":[["sub_1400012F0","5368713456","96"],' +
  '["main","5368714016","320"]],"row_count":2,"elapsed_ms":1,"error":null}],' +
  '"row_count_total":2,"elapsed_ms_total":1,"first_error_index":null}';

describe('the timeout ordering the engine imposes', () => {
  it('keeps the client timeout above idasql own limits', async () => {
    // Read from a live install's runtime_settings:
    //   query_timeout_ms           = 60000
    //   queue_admission_timeout_ms = 120000
    // The client timeout has to exceed BOTH, or a timeout could come from either
    // side and the operator cannot tell which.
    const captured: number[] = [];
    const manager = new IdaSqlSessionManager({
      spawnProcess: () => ({ pid: 1, onExit() {}, onOutput() {}, kill() {} }),
      async httpRequest(url, init) {
        if (url.endsWith('/query')) {
          captured.push(init.timeoutMs);
          return { status: 200, text: '{"success":true,"results":[]}' };
        }
        return { status: 200, text: '{"tool":"idasql"}' };
      },
      now: () => Date.now(),
      sleep: async () => {},
      isPortFree: async () => true,
    });
    const attached = await manager.attachGui({ portHint: 8100 });
    await manager.query(attached.session?.id ?? '', 'SELECT 1');
    const queryTimeout = captured[captured.length - 1];
    expect(queryTimeout).toBeGreaterThan(120_000);
  });
});

describe('the real idasql /status body', () => {
  it('is recognized by the GUI attach probe', () => {
    // Note what carries it: the "tool":"idasql" field. The key allowlist alone
    // (database/input_file/idb/tables) would NOT match this body.
    expect(looksLikeIdaSqlStatus(REAL_STATUS)).toBe(true);
  });
});

describe('the real idasql /query envelope', () => {
  it('reads a successful multi-statement answer', () => {
    const parsed = parseIdaSqlQueryResponse(REAL_SUCCESS_TWO_STATEMENTS);
    expect(parsed.engineError).toBe('');
    expect(parsed.resultSets).toHaveLength(2);
    expect(parsed.resultSets[0].columns).toEqual(['a']);
    expect(parsed.resultSets[0].rows).toEqual([['1']]);
    expect(parsed.resultSets[1].rows).toEqual([['2']]);
  });

  it('reads real rows and their declared count', () => {
    const parsed = parseIdaSqlQueryResponse(REAL_FUNCS_ROWS);
    expect(parsed.resultSets[0].columns).toEqual(['name', 'addr', 'size']);
    expect(parsed.resultSets[0].rows[1]).toEqual(['main', '5368714016', '320']);
    expect(parsed.resultSets[0].rowCount).toBe(2);
    expect(parsed.engineError).toBe('');
  });

  it('surfaces a per-statement error instead of reporting success with no rows', () => {
    const parsed = parseIdaSqlQueryResponse(REAL_UNKNOWN_COLUMN);
    expect(parsed.engineError).toBe('no such column: start_ea');
    expect(parsed.resultSets[0].rows).toEqual([]);
  });

  it('surfaces a syntax error', () => {
    expect(parseIdaSqlQueryResponse(REAL_SYNTAX_ERROR).engineError).toContain('syntax error');
  });

  it('surfaces the refusal of a dot-command, which HTTP mode does not support', () => {
    // `.tables` works in the REPL and is a syntax error over HTTP. Worth pinning:
    // the app used to offer it as a one-click snippet.
    expect(parseIdaSqlQueryResponse(REAL_DOT_COMMAND_REJECTED).engineError).toContain(
      'syntax error',
    );
  });

  it('names one failing statement out of several', () => {
    const mixed =
      '{"success":false,"statement_count":2,"results":[' +
      '{"statement_index":0,"success":true,"columns":["a"],"rows":[["1"]],"row_count":1,"error":null},' +
      '{"statement_index":1,"success":false,"columns":[],"rows":[],"row_count":0,' +
      '"error":"no such table: nope"}],"first_error_index":1}';
    const parsed = parseIdaSqlQueryResponse(mixed);
    expect(parsed.engineError).toBe('statement 2: no such table: nope');
    expect(parsed.resultSets).toHaveLength(2);
    expect(parsed.resultSets[0].rows).toEqual([['1']]);
  });

  it('still reports a declared failure that carries no message', () => {
    const parsed = parseIdaSqlQueryResponse(
      '{"success":false,"statement_count":1,"results":[{"statement_index":0,"success":false,' +
        '"columns":[],"rows":[],"row_count":0,"error":null}]}',
    );
    expect(parsed.engineError).toContain('gave no reason');
  });
});
