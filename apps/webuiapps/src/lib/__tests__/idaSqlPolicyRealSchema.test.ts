import { describe, expect, it } from 'vitest';
import {
  KNOWN_IDASQL_FUNCTIONS,
  classifyIdaSqlBatch,
  classifyIdaSqlStatement,
} from '../idaSqlPolicy';

// Written after enumerating what IDASQL v0.0.18.1 ACTUALLY exposes, rather than
// what its README describes. The enumeration is one query:
//
//   SELECT DISTINCT name FROM pragma_function_list WHERE builtin = 0
//
// 49 functions came back, and the verb-based classifier was wrong about a whole
// family of them: idasql ships MUTATING functions, so `SELECT f(x)` is not
// necessarily a read. Re-run that query after upgrading idasql.
//
// The measurement that forced this file: in a session started WITHOUT -w, an
// UPDATE followed by `SELECT save_database()` survived a full restart. The
// "a read-only session cannot persist anything" guarantee was false, and the
// statement that broke it was classified as a read and ran with no approval.

describe('IDASQL escapes reachable from a plain SELECT', () => {
  it('refuses save_database, which persists a read-only session', () => {
    const result = classifyIdaSqlStatement('SELECT save_database()');
    expect(result.statementClass).toBe('forbidden');
    expect(result.reason).toBe('save_database_persists');
  });

  it('refuses it however it is dressed up', () => {
    for (const sql of [
      'select save_database ( )',
      'SELECT 1 FROM funcs WHERE save_database() = 1',
      'WITH x AS (SELECT save_database()) SELECT * FROM x',
      'SELECT SAVE_DATABASE()',
    ]) {
      expect(classifyIdaSqlStatement(sql).statementClass, sql).toBe('forbidden');
    }
  });

  it('refuses IDAPython execution and the PRAGMA that unlocks it', () => {
    // The error message from a real install discloses the switch:
    // "idapython is disabled (enable via PRAGMA idasql.enable_idapython = 1)".
    // Refusing the switch closes the path structurally -- the snippet functions
    // refuse themselves while it is off.
    expect(classifyIdaSqlStatement("SELECT idapython_snippet('1+1')").reason).toBe(
      'idapython_code_execution',
    );
    expect(classifyIdaSqlStatement("SELECT idapython_file('x.py')").reason).toBe(
      'idapython_code_execution',
    );
    expect(classifyIdaSqlStatement('PRAGMA idasql.enable_idapython = 1').reason).toBe(
      'enables_code_execution',
    );
    // And the other way to flip it: it is a row in runtime_settings.
    expect(
      classifyIdaSqlStatement(
        "UPDATE runtime_settings SET value = '1' WHERE key = 'enable_idapython'",
      ).reason,
    ).toBe('enables_code_execution');
  });

  it('refuses the file primitives, which ignore the binary roots entirely', () => {
    // Measured: load_file_bytes reported success on C:\Windows\win.ini, a path
    // outside every registered root.
    expect(
      classifyIdaSqlStatement("SELECT load_file_bytes('C:\\Windows\\win.ini',0,0,64)").reason,
    ).toBe('arbitrary_file_read');
    expect(classifyIdaSqlStatement("SELECT gen_cfg_dot_file(4096,'C:\\out.dot')").reason).toBe(
      'arbitrary_file_write',
    );
  });

  it('does not confuse them with the read-only members of the same families', () => {
    // gen_cfg_dot returns the graph; gen_cfg_dot_FILE writes one. get_* reads,
    // set_* writes. The distinction is the point.
    for (const sql of [
      'SELECT gen_cfg_dot(4096)',
      'SELECT gen_listing(4096, 4196)',
      'SELECT gen_schema_dot()',
      'SELECT get_numform(4096)',
      'SELECT get_union_selection(4096)',
      'SELECT decompile(4096)',
      'SELECT disasm(4096)',
      'SELECT get_ui_context_json()',
    ]) {
      expect(classifyIdaSqlStatement(sql).statementClass, sql).toBe('read');
    }
  });
});

describe('an unreviewed function is a write, so a version bump cannot slip past', () => {
  it('treats a function this build has never seen as needing approval', () => {
    const unreviewed = new Set(['wipe_database', 'exec_shell']);
    expect(
      classifyIdaSqlStatement('SELECT wipe_database()', { unreviewedFunctions: unreviewed }),
    ).toMatchObject({ statementClass: 'write', reason: 'unreviewed_function_wipe_database' });
    // Nested in a bigger query, and behind a builtin call.
    expect(
      classifyIdaSqlStatement('SELECT count(exec_shell(1)) FROM funcs', {
        unreviewedFunctions: unreviewed,
      }).statementClass,
    ).toBe('write');
  });

  it('leaves reviewed functions and builtins alone', () => {
    const unreviewed = new Set(['wipe_database']);
    for (const sql of [
      'SELECT decompile(4096)',
      'SELECT count(*) FROM funcs',
      'SELECT length(name), substr(name,1,3) FROM funcs',
    ]) {
      expect(
        classifyIdaSqlStatement(sql, { unreviewedFunctions: unreviewed }).statementClass,
        sql,
      ).toBe('read');
    }
  });

  it('is inert when the session reviewed everything', () => {
    expect(
      classifyIdaSqlStatement('SELECT decompile(4096)', { unreviewedFunctions: new Set() })
        .statementClass,
    ).toBe('read');
    expect(classifyIdaSqlStatement('SELECT decompile(4096)').statementClass).toBe('read');
  });

  it('escalates a batch through the option too', () => {
    expect(
      classifyIdaSqlBatch('SELECT 1; SELECT brand_new_thing()', {
        unreviewedFunctions: new Set(['brand_new_thing']),
      }).statementClass,
    ).toBe('write');
  });

  it('does not fire on a name that only appears in a literal', () => {
    expect(
      classifyIdaSqlStatement("SELECT name FROM funcs WHERE name = 'wipe_database()'", {
        unreviewedFunctions: new Set(['wipe_database']),
      }).statementClass,
    ).toBe('read');
  });

  it('covers every function the reviewed set claims, so the diff is meaningful', () => {
    // If this set were missing a real function name, that function would be
    // reported as unreviewed on every session and every query touching it would
    // demand approval -- annoying enough to be worth a guard.
    for (const name of ['decompile', 'save_database', 'make_code', 'idapython_snippet']) {
      expect(KNOWN_IDASQL_FUNCTIONS.has(name), name).toBe(true);
    }
    expect(KNOWN_IDASQL_FUNCTIONS.size).toBe(49);
  });
});

describe('IDASQL mutating functions are writes, not reads', () => {
  it('classifies a SELECT that changes the database as a write', () => {
    for (const sql of [
      'SELECT make_code(4096)',
      'SELECT make_code_range(4096, 4196)',
      "SELECT parse_decls('struct foo { int a; };')",
      'SELECT rebuild_strings()',
      "SELECT set_numform(4096, 'hex')",
      "SELECT set_numform_item(4096, 0, 'dec')",
      'SELECT set_union_selection(4096, 1)',
      'SELECT set_union_selection_addr_expr(4096, 1, 2)',
    ]) {
      // Renaming and retyping IS the work -- it just goes through the same
      // approval an UPDATE does.
      expect(classifyIdaSqlStatement(sql).statementClass, sql).toBe('write');
    }
  });

  it('escalates a whole batch when one statement calls a mutating function', () => {
    const batch = classifyIdaSqlBatch('SELECT name FROM funcs; SELECT make_code(4096)');
    expect(batch.statementClass).toBe('write');
  });

  it('still lets the word appear inside a literal', () => {
    // Redaction happens first, so a comment or a LIKE pattern mentioning one of
    // these is not a call.
    expect(
      classifyIdaSqlStatement("SELECT name FROM funcs WHERE name LIKE '%make_code(%'")
        .statementClass,
    ).toBe('read');
    expect(
      classifyIdaSqlStatement('SELECT name FROM funcs -- save_database() would persist')
        .statementClass,
    ).toBe('read');
  });

  it('makes exactly one literal-blind exception, and owns the false positive', () => {
    // enable_idapython is refused even inside a literal, because a literal is
    // how you flip it via runtime_settings. The cost is that a query merely
    // mentioning the string is refused too -- accepted deliberately.
    expect(
      classifyIdaSqlStatement("SELECT * FROM runtime_settings WHERE key = 'enable_idapython'")
        .statementClass,
    ).toBe('forbidden');
    // Nothing else gets this treatment: the other names stay literal-safe.
    expect(classifyIdaSqlStatement("SELECT 'idapython_snippet' AS just_text").statementClass).toBe(
      'read',
    );
  });
});
