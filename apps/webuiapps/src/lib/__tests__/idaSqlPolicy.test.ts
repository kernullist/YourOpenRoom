import { describe, expect, it } from 'vitest';
import {
  classifyIdaSqlBatch,
  classifyIdaSqlStatement,
  redactIdaSqlLiterals,
  findUnterminatedQuote,
  splitIdaSqlStatements,
  summarizeIdaSqlBatch,
} from '../idaSqlPolicy';

describe('redactIdaSqlLiterals', () => {
  it('empties string literal bodies so data cannot look like code', () => {
    const redacted = redactIdaSqlLiterals("SELECT * FROM funcs WHERE name LIKE '%attach%'");
    expect(redacted).toContain('SELECT * FROM funcs WHERE name LIKE');
    expect(redacted).not.toContain('attach');
  });

  it('handles a doubled quote inside a literal without ending it early', () => {
    const redacted = redactIdaSqlLiterals("SELECT 'it''s attach' , name FROM funcs");
    expect(redacted).not.toContain('attach');
    expect(redacted).toContain('name FROM funcs');
  });

  it('drops line and block comments', () => {
    expect(redactIdaSqlLiterals('SELECT 1 -- attach\n')).not.toContain('attach');
    expect(redactIdaSqlLiterals('SELECT /* attach */ 1')).not.toContain('attach');
  });

  it('empties bracket-quoted identifiers', () => {
    expect(redactIdaSqlLiterals('SELECT [attach] FROM funcs')).not.toContain('attach');
  });
});

describe('splitIdaSqlStatements', () => {
  it('splits on top-level semicolons only', () => {
    expect(splitIdaSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('keeps a semicolon inside a literal in the same statement', () => {
    expect(splitIdaSqlStatements("SELECT ';' AS s")).toEqual(["SELECT ';' AS s"]);
  });

  it('ignores a semicolon inside a comment', () => {
    expect(splitIdaSqlStatements('SELECT 1 -- ; not a split\nFROM funcs')).toHaveLength(1);
  });

  it('keeps a semicolon inside a bracket identifier in the same statement', () => {
    // The splitter and redactIdaSqlLiterals model one lexer; when only the
    // redactor knew about brackets, this query was cut in two and its tail
    // classified as a write.
    expect(splitIdaSqlStatements('SELECT [a;b] FROM t')).toEqual(['SELECT [a;b] FROM t']);
    expect(classifyIdaSqlStatement('SELECT [a;b] FROM t').statementClass).toBe('read');
    expect(classifyIdaSqlBatch('SELECT [a;b] FROM t').statements).toHaveLength(1);
  });

  it('still splits after a closed bracket', () => {
    expect(splitIdaSqlStatements('SELECT [a] FROM t; SELECT 2')).toEqual([
      'SELECT [a] FROM t',
      'SELECT 2',
    ]);
  });

  it('refuses a mutation hidden behind an unterminated bracket', () => {
    // The bracket swallows the rest, and redaction then empties it -- which is
    // exactly how `select []` came out as a read with an UPDATE inside it.
    const batch = classifyIdaSqlBatch("SELECT [x ; UPDATE funcs SET name = 'a'");
    expect(batch.statements).toHaveLength(1);
    expect(batch.statementClass).toBe('forbidden');
    expect(batch.statements[0].reason).toBe('unterminated_quote');
  });

  it('refuses a mutation hidden behind an unterminated string literal', () => {
    // One unbalanced quote, so the rest of the input is swallowed into a literal
    // that redaction then empties.
    const batch = classifyIdaSqlBatch("SELECT 'x ; UPDATE funcs SET name = a");
    expect(batch.statements).toHaveLength(1);
    expect(batch.statementClass).toBe('forbidden');
    expect(batch.statements[0].reason).toBe('unterminated_quote');
  });

  it('reads balanced quoting as a read even when it looks alarming', () => {
    // Every quote here is closed, so the UPDATE text sits INSIDE a literal and
    // no engine can execute it. Refusing this would be superstition, not safety.
    const batch = classifyIdaSqlBatch("SELECT 'x ; UPDATE funcs SET name = 'a'' FROM t");
    expect(batch.statementClass).toBe('read');
  });

  it('refuses every kind of unterminated quoting', () => {
    for (const sql of ['SELECT [a', 'SELECT "a', "SELECT 'a", 'SELECT `a']) {
      expect(classifyIdaSqlStatement(sql).reason, sql).toBe('unterminated_quote');
    }
  });

  it('accepts an unterminated block comment, which removes rather than hides', () => {
    // SQLite accepts this and the tail really is commented out.
    const batch = classifyIdaSqlBatch("SELECT 1 /* ; UPDATE funcs SET name = 'a'");
    expect(batch.statementClass).toBe('read');
  });

  it('accepts doubled quotes as escapes rather than calling them unterminated', () => {
    expect(findUnterminatedQuote("SELECT 'it''s fine'")).toBe('');
    expect(classifyIdaSqlStatement("SELECT 'it''s fine'").statementClass).toBe('read');
  });

  it('does not mistake a quote inside a comment for an unterminated literal', () => {
    // Refusing these would break ordinary annotated SQL, which is most of what
    // anyone actually types.
    expect(findUnterminatedQuote("SELECT 1 -- it's fine\n")).toBe('');
    expect(findUnterminatedQuote("SELECT 1 /* don't worry */")).toBe('');
    expect(findUnterminatedQuote('SELECT 1 -- a [bracket')).toBe('');
    expect(
      classifyIdaSqlStatement("SELECT name FROM funcs -- it's the entry point").statementClass,
    ).toBe('read');
  });

  it('rejects a batch that is nothing but a comment', () => {
    // Reachable from the editor: type a note, press Run.
    expect(classifyIdaSqlBatch('-- just a note').rejectReason).toBe('empty_sql');
    expect(classifyIdaSqlBatch('/* nothing here */').rejectReason).toBe('empty_sql');
  });
});

describe('classifyIdaSqlStatement', () => {
  it('treats plain queries as reads', () => {
    for (const sql of [
      'SELECT name FROM funcs',
      'select * from strings limit 10',
      'EXPLAIN SELECT 1',
      'VALUES (1)',
      'PRAGMA table_info(funcs)',
      '.tables',
      '.schema funcs',
    ]) {
      expect(classifyIdaSqlStatement(sql).statementClass, sql).toBe('read');
    }
  });

  it('treats a CTE that only selects as a read', () => {
    expect(
      classifyIdaSqlStatement('WITH big AS (SELECT * FROM funcs) SELECT count(*) FROM big')
        .statementClass,
    ).toBe('read');
  });

  it('treats a CTE that fronts a mutation as a write', () => {
    expect(
      classifyIdaSqlStatement('WITH t AS (SELECT 1) INSERT INTO funcs SELECT * FROM t')
        .statementClass,
    ).toBe('write');
  });

  it('treats database mutations as writes', () => {
    for (const sql of [
      "UPDATE funcs SET name = 'parsed' WHERE start_ea = 4096",
      'INSERT INTO comments VALUES (1)',
      'DELETE FROM comments',
      'CREATE TABLE t (a)',
      'DROP TABLE t',
      'PRAGMA user_version = 3',
    ]) {
      expect(classifyIdaSqlStatement(sql).statementClass, sql).toBe('write');
    }
  });

  it('treats unrecognized syntax as a write, never a read', () => {
    expect(classifyIdaSqlStatement('FROBNICATE funcs').statementClass).toBe('write');
  });

  it('refuses host escapes outright', () => {
    const cases: [string, string][] = [
      ["ATTACH DATABASE 'x.db' AS x", 'attach_database'],
      ['DETACH x', 'detach_database'],
      ["VACUUM INTO 'copy.db'", 'vacuum_into_file'],
      ["SELECT load_extension('evil.dll')", 'load_extension'],
      ["SELECT writefile('c:\\out.bin', 1)", 'writefile'],
      ["SELECT readfile('c:\\secret')", 'readfile'],
      ['PRAGMA writable_schema = ON', 'writable_schema'],
    ];
    for (const [sql, reason] of cases) {
      const result = classifyIdaSqlStatement(sql);
      expect(result.statementClass, sql).toBe('forbidden');
      expect(result.reason, sql).toBe(reason);
    }
  });

  it('refuses dot-commands outside the read allowlist', () => {
    for (const sql of ['.output out.txt', '.shell dir', '.import a.csv t', '.http start']) {
      expect(classifyIdaSqlStatement(sql).statementClass, sql).toBe('forbidden');
    }
  });
});

describe('classifyIdaSqlBatch', () => {
  it('is as dangerous as its most dangerous statement', () => {
    const batch = classifyIdaSqlBatch("SELECT 1; UPDATE funcs SET name = 'a'; SELECT 2;");
    expect(batch.statementClass).toBe('write');
    expect(batch.statements).toHaveLength(3);
  });

  it('escalates to forbidden when any statement is a host escape', () => {
    const batch = classifyIdaSqlBatch("SELECT 1; ATTACH DATABASE 'x' AS y;");
    expect(batch.statementClass).toBe('forbidden');
  });

  it('rejects an empty batch', () => {
    expect(classifyIdaSqlBatch('   ').rejectReason).toBe('empty_sql');
  });

  it('rejects an oversized batch', () => {
    expect(classifyIdaSqlBatch(`SELECT '${'a'.repeat(20001)}'`).rejectReason).toBe('sql_too_long');
  });

  it('rejects too many statements', () => {
    expect(classifyIdaSqlBatch('SELECT 1;'.repeat(33)).rejectReason).toBe('too_many_statements');
  });

  it('summarizes writes with the actual SQL so an approval popup can show it', () => {
    const batch = classifyIdaSqlBatch("UPDATE funcs SET name = 'decrypt_blob' WHERE start_ea = 1");
    expect(summarizeIdaSqlBatch(batch)).toContain('decrypt_blob');
  });

  it('summarizes a refusal with the reason', () => {
    const batch = classifyIdaSqlBatch("ATTACH DATABASE 'x' AS y");
    expect(summarizeIdaSqlBatch(batch)).toContain('attach_database');
  });

  it('summarizes a read-only batch by count', () => {
    expect(summarizeIdaSqlBatch(classifyIdaSqlBatch('SELECT 1; SELECT 2'))).toBe(
      '2 read statement(s)',
    );
  });

  it('surfaces a reject reason as the summary', () => {
    expect(summarizeIdaSqlBatch(classifyIdaSqlBatch(''))).toBe('empty_sql');
  });
});

describe('truncated and malformed input', () => {
  it('recovers from an unterminated string literal without crashing, and refuses it', () => {
    // The lexers RECOVER (swallow to end of input) so nothing throws; the
    // classifier then refuses the statement, because that recovery is exactly
    // what would hide a mutation inside a literal.
    expect(redactIdaSqlLiterals("SELECT 'unclosed")).toBe("SELECT ''");
    expect(splitIdaSqlStatements("SELECT 'unclosed; still inside")).toHaveLength(1);
    expect(classifyIdaSqlStatement("SELECT 'unclosed").statementClass).toBe('forbidden');
  });

  it('tolerates an unterminated block comment', () => {
    expect(redactIdaSqlLiterals('SELECT 1 /* forever').trim()).toBe('SELECT 1');
    expect(splitIdaSqlStatements('SELECT 1 /* forever; and ever')).toEqual(['SELECT 1']);
  });

  it('tolerates an unterminated bracket identifier', () => {
    expect(redactIdaSqlLiterals('SELECT [unclosed')).toBe('SELECT []');
  });

  it('tolerates a line comment that runs to the end of input', () => {
    expect(splitIdaSqlStatements('SELECT 1 -- trailing')).toEqual(['SELECT 1']);
    expect(redactIdaSqlLiterals('SELECT 1 -- trailing')).toBe('SELECT 1 ');
  });

  it('refuses a bare dot with no command', () => {
    const result = classifyIdaSqlStatement('.');
    expect(result.statementClass).toBe('forbidden');
    expect(result.reason).toBe('dot_command_none');
  });

  it('treats an empty statement as forbidden rather than as a read', () => {
    expect(classifyIdaSqlStatement('   ').statementClass).toBe('forbidden');
  });

  it('drops a trailing empty statement after the last semicolon', () => {
    expect(splitIdaSqlStatements('SELECT 1;   ')).toEqual(['SELECT 1']);
  });

  it('rejects a non-string batch', () => {
    expect(classifyIdaSqlBatch(undefined as unknown as string).rejectReason).toBe('empty_sql');
  });
});
