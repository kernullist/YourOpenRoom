// IDA Lab SQL policy: split a submitted batch into statements and decide, per
// statement, whether it is a plain query, a database mutation, or something that
// is not an analysis query at all.
//
// Why this exists: IDASQL exposes the IDA database as live virtual tables, so
// `UPDATE funcs SET name = ...` is a real rename and `ATTACH` / `writefile()` are
// real filesystem writes. The operator chose "writes allowed, approved per
// query", which only means anything if the classifier is honest about which
// statements mutate. Three rules keep it honest:
//
//   1. Literals are redacted before matching, so a query that merely CONTAINS
//      the word "attach" in a LIKE pattern is still a read.
//   2. A batch is as dangerous as its most dangerous statement -- one mutation
//      among ten statements makes the whole submission a write.
//   3. Unrecognized syntax is treated as a WRITE, never as a read. The operator
//      then sees the exact SQL in the approval popup and decides.
//
// 'forbidden' is reserved for host escapes: attaching databases, reading or
// writing files from SQL, loading extensions, or dot-commands that touch the
// filesystem or start servers. Those are refused outright -- there is no
// approval that turns them into in-scope analysis.
//
// Browser-safe: no node builtins (the app UI pre-classifies as you type).
import type { IdaSqlStatementClass, IdaSqlStatementInfo } from './idaSqlTypes';

const MAX_STATEMENTS = 32;
const MAX_SQL_CHARS = 20000;

// Dot-commands that only read. Anything else starting with '.' is refused: the
// dot namespace includes .import / .output / .shell / .http, so an allowlist is
// the only safe shape for it.
const READ_DOT_COMMANDS: readonly string[] = [
  '.tables',
  '.schema',
  '.fullschema',
  '.databases',
  '.indexes',
  '.indices',
  '.types',
  '.help',
  '.status',
  '.version',
  '.show',
];

// Host escapes. Matched against the literal-redacted statement.
const FORBIDDEN_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\battach\b/, reason: 'attach_database' },
  { pattern: /\bdetach\b/, reason: 'detach_database' },
  { pattern: /\bvacuum\s+into\b/, reason: 'vacuum_into_file' },
  { pattern: /\bload_extension\s*\(/, reason: 'load_extension' },
  { pattern: /\breadfile\s*\(/, reason: 'readfile' },
  { pattern: /\bwritefile\s*\(/, reason: 'writefile' },
  { pattern: /\bfsdir\s*\(/, reason: 'fsdir' },
  { pattern: /\bedit\s*\(/, reason: 'edit_shell' },
  { pattern: /\bsqlite_dbpage\b/, reason: 'raw_page_access' },
  { pattern: /\bpragma\s+writable_schema\b/, reason: 'writable_schema' },
  { pattern: /\bpragma\s+temp_store_directory\b/, reason: 'temp_store_directory' },
  { pattern: /\bpragma\s+data_store_directory\b/, reason: 'data_store_directory' },

  // --- IDASQL's own escapes (enumerated from a real v0.0.18.1 install) -------
  //
  // These are FUNCTIONS, so they ride inside a SELECT -- which the verb-based
  // classifier called a read and ran with no approval. Each one was measured:
  //
  //   save_database()      persisted an UPDATE from a session started WITHOUT
  //                        -w, and the rename survived a restart. This is the
  //                        function that made the "a read-only session cannot
  //                        persist anything" guarantee false.
  //   idapython_snippet()  arbitrary IDAPython, i.e. arbitrary code on this PC.
  //   idapython_file()     the same, from a file.
  //   load_file_bytes()    takes a filesystem path and reported success on
  //                        C:\Windows\win.ini -- outside every binary root, so
  //                        the containment limit simply does not apply to it.
  //   gen_cfg_dot_file()   writes a file at a caller-chosen path.
  //
  // The enabling PRAGMA is refused too, so the IDAPython path cannot be opened
  // from here at all: without enable_idapython the snippet functions refuse
  // themselves. That is a structural close rather than a name match.
  { pattern: /\bsave_database\s*\(/, reason: 'save_database_persists' },
  { pattern: /\bidapython_snippet\s*\(/, reason: 'idapython_code_execution' },
  { pattern: /\bidapython_file\s*\(/, reason: 'idapython_code_execution' },
  { pattern: /\bload_file_bytes\s*\(/, reason: 'arbitrary_file_read' },
  { pattern: /\bgen_cfg_dot_file\s*\(/, reason: 'arbitrary_file_write' },
];

/**
 * Refused on the RAW statement, literals included.
 *
 * Everything else is matched after redaction, because data must not be able to
 * look like code. `enable_idapython` is the exception that proves the rule:
 * there are two ways to flip it, and one of them puts the identifier in a
 * literal --
 *
 *   PRAGMA idasql.enable_idapython = 1
 *   UPDATE runtime_settings SET value = '1' WHERE key = 'enable_idapython'
 *
 * -- so a redaction-only check sees the first and is blind to the second. Here
 * the literal IS the dangerous part: it names the row that unlocks arbitrary
 * IDAPython. The accepted cost is a false positive on a query that merely
 * mentions the string; a refusal message is a fair price for closing the code
 * execution path.
 */
const FORBIDDEN_RAW_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /enable_idapython/, reason: 'enables_code_execution' },
];

/**
 * IDASQL functions that MUTATE the database, callable from a SELECT.
 *
 * Enumerated with `SELECT DISTINCT name FROM pragma_function_list WHERE
 * builtin = 0` against idasql v0.0.18.1 -- 49 functions, of which these change
 * the database. A verb-based classifier cannot see them: `SELECT make_code(x)`
 * converts bytes to code and looks exactly like a query.
 *
 * They are 'write', not 'forbidden': renaming, retyping and marking code IS the
 * work, it just has to go through the same approval as an UPDATE. The ones that
 * escape the database entirely (save_database, idapython_*, file access) are in
 * FORBIDDEN_PATTERNS above.
 *
 * PINNED TO A VERSION. Re-run the query above after upgrading idasql; a new
 * mutating function would otherwise arrive classified as a read.
 */
const MUTATING_FUNCTION_PATTERN =
  /\b(?:make_code(?:_range)?|parse_decls|rebuild_strings|set_numform(?:_addr_arg|_addr_expr|_item)?|set_union_selection(?:_addr_arg|_addr_expr|_item)?)\s*\(/;

/**
 * Every non-builtin function idasql v0.0.18.1 exposes, as reviewed above.
 *
 * The point of listing the SAFE ones too is that a blocklist pinned to a version
 * goes stale silently: upgrade idasql, gain a `wipe_database()`, and a
 * verb-based classifier calls `SELECT wipe_database()` a read. A session asks
 * the running engine for its own function list (pragma_function_list) and
 * anything absent from this set is treated as a write -- unreviewed means
 * "needs a human", not "assume harmless".
 */
export const KNOWN_IDASQL_FUNCTIONS: ReadonlySet<string> = new Set([
  // read / compute
  'blob_concat',
  'call_arg_addrs',
  'call_arg_item',
  'ctree_item_at',
  'decompile',
  'disasm',
  'disasm_at',
  'disasm_func',
  'disasm_range',
  'gen_cfg_dot',
  'gen_listing',
  'gen_schema_dot',
  'get_numform',
  'get_numform_addr_arg',
  'get_numform_addr_expr',
  'get_numform_item',
  'get_ui_context_json',
  'get_union_selection',
  'get_union_selection_addr_arg',
  'get_union_selection_addr_expr',
  'get_union_selection_item',
  // full-text search / rtree internals SQLite ships through the extension
  'bm25',
  'fts5',
  'fts5_get_locale',
  'fts5_locale',
  'fts5_source_id',
  'highlight',
  'match',
  'snippet',
  'rtreecheck',
  'rtreedepth',
  'rtreenode',
  // mutating -- classified as writes by MUTATING_FUNCTION_PATTERN
  'make_code',
  'make_code_range',
  'parse_decls',
  'rebuild_strings',
  'set_numform',
  'set_numform_addr_arg',
  'set_numform_addr_expr',
  'set_numform_item',
  'set_union_selection',
  'set_union_selection_addr_arg',
  'set_union_selection_addr_expr',
  'set_union_selection_item',
  // refused outright -- listed so the diff does not flag them as unreviewed
  'save_database',
  'idapython_file',
  'idapython_snippet',
  'load_file_bytes',
  'gen_cfg_dot_file',
]);

/** Function calls in a statement, from the literal-redacted projection. */
function calledFunctions(code: string): string[] {
  const names: string[] = [];
  const pattern = /\b([a-z_][a-z_0-9]*)\s*\(/g;
  let match = pattern.exec(code);
  while (match) {
    names.push(match[1]);
    match = pattern.exec(code);
  }
  return names;
}

export interface IdaSqlClassifyOptions {
  /**
   * Non-builtin functions the live session exposes that this build has never
   * reviewed. Supplied by the session (which asks the engine); a statement
   * calling one is a write, because nobody has decided it is safe.
   */
  unreviewedFunctions?: ReadonlySet<string>;
}

// PRAGMAs that only introspect. A pragma with an assignment, or one outside this
// set, falls through to 'write'.
const READ_PRAGMAS: readonly string[] = [
  'table_info',
  'table_xinfo',
  'table_list',
  'database_list',
  'function_list',
  'module_list',
  'pragma_list',
  'index_info',
  'index_xinfo',
  'index_list',
  'foreign_key_list',
  'collation_list',
  'compile_options',
  'encoding',
  'page_count',
  'page_size',
  'user_version',
  'integrity_check',
  'quick_check',
];

const WRITE_VERBS: readonly string[] = [
  'insert',
  'update',
  'delete',
  'replace',
  'upsert',
  'create',
  'drop',
  'alter',
  'truncate',
  'begin',
  'commit',
  'end',
  'rollback',
  'savepoint',
  'release',
  'reindex',
  'analyze',
  'vacuum',
];

const SINGLE_QUOTE = String.fromCharCode(39);
const DOUBLE_QUOTE = String.fromCharCode(34);
const BACKTICK = String.fromCharCode(96);
const QUOTE_CHARS: readonly string[] = [SINGLE_QUOTE, DOUBLE_QUOTE, BACKTICK];

/**
 * Replace the contents of every string literal / quoted identifier with an empty
 * body, so keyword matching sees code and never data. Comments are dropped in the
 * same pass -- a comment can hide a keyword just as well as a literal can.
 */
export function redactIdaSqlLiterals(sql: string): string {
  let out = '';
  let index = 0;
  const length = sql.length;

  while (index < length) {
    const char = sql[index];

    if (char === '-' && sql[index + 1] === '-') {
      const newline = sql.indexOf('\n', index);
      index = newline < 0 ? length : newline;
      continue;
    }

    if (char === '/' && sql[index + 1] === '*') {
      const close = sql.indexOf('*/', index + 2);
      index = close < 0 ? length : close + 2;
      out += ' ';
      continue;
    }

    if (QUOTE_CHARS.includes(char)) {
      // SQL escapes a quote by doubling it; walk to the real terminator.
      let cursor = index + 1;
      while (cursor < length) {
        if (sql[cursor] === char) {
          if (sql[cursor + 1] === char) {
            cursor += 2;
            continue;
          }
          break;
        }
        cursor += 1;
      }
      out += char + char;
      index = cursor < length ? cursor + 1 : length;
      continue;
    }

    if (char === '[') {
      const close = sql.indexOf(']', index + 1);
      out += '[]';
      index = close < 0 ? length : close + 1;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

/**
 * Split a batch on top-level semicolons. The walk mirrors the redaction state
 * machine over the ORIGINAL text, so a semicolon inside a literal or a comment
 * never ends a statement.
 */
export function splitIdaSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;
  const length = sql.length;

  while (index < length) {
    const char = sql[index];

    if (char === '-' && sql[index + 1] === '-') {
      const newline = sql.indexOf('\n', index);
      current += newline < 0 ? '' : '\n';
      index = newline < 0 ? length : newline + 1;
      continue;
    }

    if (char === '/' && sql[index + 1] === '*') {
      const close = sql.indexOf('*/', index + 2);
      current += ' ';
      index = close < 0 ? length : close + 2;
      continue;
    }

    if (QUOTE_CHARS.includes(char)) {
      let cursor = index + 1;
      while (cursor < length) {
        if (sql[cursor] === char) {
          if (sql[cursor + 1] === char) {
            cursor += 2;
            continue;
          }
          break;
        }
        cursor += 1;
      }
      const end = cursor < length ? cursor + 1 : length;
      current += sql.slice(index, end);
      index = end;
      continue;
    }

    if (char === '[') {
      // Bracket identifiers are opaque here for the same reason they are in
      // redactIdaSqlLiterals: these two functions model ONE lexer, and the
      // splitter not knowing about brackets meant `SELECT [a;b] FROM t` was cut
      // in half. Safe (the tail classified as a write and asked for approval)
      // but wrong, and a disagreement between the splitter and the classifier is
      // exactly the kind of gap a bypass hides in.
      const close = sql.indexOf(']', index + 1);
      const end = close < 0 ? length : close + 1;
      current += sql.slice(index, end);
      index = end;
      continue;
    }

    if (char === ';') {
      if (current.trim()) {
        statements.push(current.trim());
      }
      current = '';
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  if (current.trim()) {
    statements.push(current.trim());
  }
  return statements;
}

function firstWord(value: string): string {
  const match = /^[a-z_]+/.exec(value);
  return match ? match[0] : '';
}

/**
 * Is a quote or bracket opened and never closed?
 *
 * This is the hiding trick the redaction pass would otherwise enable: both the
 * splitter and the redactor RECOVER from an unterminated quote by swallowing to
 * the end of input, so `SELECT [x ; UPDATE funcs SET name = 'a'` became one
 * statement whose contents redacted away to `select []` -- a read, with a
 * mutation inside it. SQLite rejects unterminated quoting as a syntax error
 * anyway, so refusing it here costs nothing and closes the gap without relying
 * on what the engine happens to do.
 *
 * An unterminated BLOCK COMMENT is deliberately not included: SQLite accepts it
 * and genuinely comments out the rest, so nothing is hidden -- it is removed.
 */
export function findUnterminatedQuote(sql: string): string {
  let index = 0;
  const length = sql.length;

  while (index < length) {
    const char = sql[index];

    if (char === '-' && sql[index + 1] === '-') {
      const newline = sql.indexOf('\n', index);
      index = newline < 0 ? length : newline + 1;
      continue;
    }

    if (char === '/' && sql[index + 1] === '*') {
      const close = sql.indexOf('*/', index + 2);
      index = close < 0 ? length : close + 2;
      continue;
    }

    if (QUOTE_CHARS.includes(char)) {
      let cursor = index + 1;
      let closed = false;
      while (cursor < length) {
        if (sql[cursor] === char) {
          if (sql[cursor + 1] === char) {
            cursor += 2;
            continue;
          }
          closed = true;
          break;
        }
        cursor += 1;
      }
      if (!closed) {
        return char;
      }
      index = cursor + 1;
      continue;
    }

    if (char === '[') {
      const close = sql.indexOf(']', index + 1);
      if (close < 0) {
        return '[';
      }
      index = close + 1;
      continue;
    }

    index += 1;
  }

  return '';
}

/** Classify one statement. `sql` is the original text; matching uses a redaction. */
export function classifyIdaSqlStatement(
  sql: string,
  options: IdaSqlClassifyOptions = {},
): IdaSqlStatementInfo {
  const trimmed = sql.trim();
  if (!trimmed) {
    return { sql: trimmed, statementClass: 'forbidden', reason: 'empty_statement' };
  }

  // Before any keyword matching: malformed quoting is how a mutation hides
  // inside what redacts down to a harmless read.
  const unterminated = findUnterminatedQuote(trimmed);
  if (unterminated) {
    return { sql: trimmed, statementClass: 'forbidden', reason: 'unterminated_quote' };
  }

  // Checked on the raw text, before redaction can hide it. See
  // FORBIDDEN_RAW_PATTERNS for why exactly one thing is treated this way.
  const raw = trimmed.toLowerCase();
  for (const entry of FORBIDDEN_RAW_PATTERNS) {
    if (entry.pattern.test(raw)) {
      return { sql: trimmed, statementClass: 'forbidden', reason: entry.reason };
    }
  }

  const code = redactIdaSqlLiterals(trimmed).toLowerCase().trim();

  if (code.startsWith('.')) {
    const command = firstWord(code.slice(1));
    const dotCommand = `.${command}`;
    if (READ_DOT_COMMANDS.includes(dotCommand)) {
      return { sql: trimmed, statementClass: 'read' };
    }
    return {
      sql: trimmed,
      statementClass: 'forbidden',
      reason: `dot_command_${command || 'none'}`,
    };
  }

  for (const entry of FORBIDDEN_PATTERNS) {
    if (entry.pattern.test(code)) {
      return { sql: trimmed, statementClass: 'forbidden', reason: entry.reason };
    }
  }

  const verb = firstWord(code);

  // A mutating FUNCTION makes a SELECT a write. The verb is not the whole story
  // with this schema: `SELECT make_code(0x401000)` converts bytes to code and
  // reads exactly like a query. Checked before the read verbs so it cannot be
  // short-circuited by them.
  if (MUTATING_FUNCTION_PATTERN.test(code)) {
    return { sql: trimmed, statementClass: 'write' };
  }

  // A function this build has never reviewed is a write for the same reason
  // unrecognized syntax is: the safe default when we do not know is "ask".
  const unreviewed = options.unreviewedFunctions;
  if (unreviewed && unreviewed.size > 0) {
    const hit = calledFunctions(code).find((name) => unreviewed.has(name));
    if (hit) {
      return { sql: trimmed, statementClass: 'write', reason: `unreviewed_function_${hit}` };
    }
  }

  if (verb === 'select' || verb === 'values' || verb === 'explain') {
    return { sql: trimmed, statementClass: 'read' };
  }

  if (verb === 'with') {
    // A CTE can front a mutation: WITH x AS (...) INSERT INTO ...
    if (/\b(insert|update|delete|replace)\b/.test(code)) {
      return { sql: trimmed, statementClass: 'write' };
    }
    return { sql: trimmed, statementClass: 'read' };
  }

  if (verb === 'pragma') {
    const pragmaMatch = /^pragma\s+(?:[a-z_0-9]+\s*\.\s*)?([a-z_0-9]+)\s*(=|\()?/.exec(code);
    const name = pragmaMatch ? pragmaMatch[1] : '';
    const assigns = pragmaMatch ? pragmaMatch[2] === '=' : false;
    if (!assigns && READ_PRAGMAS.includes(name)) {
      return { sql: trimmed, statementClass: 'read' };
    }
    return { sql: trimmed, statementClass: 'write' };
  }

  if (WRITE_VERBS.includes(verb)) {
    return { sql: trimmed, statementClass: 'write' };
  }

  // Unrecognized: conservative. The operator sees the SQL in the approval popup.
  return { sql: trimmed, statementClass: 'write' };
}

export interface IdaSqlBatchClassification {
  statementClass: IdaSqlStatementClass;
  statements: IdaSqlStatementInfo[];
  /** Set when the batch cannot be run at all (empty, too long, too many). */
  rejectReason: string;
}

function rankOf(statementClass: IdaSqlStatementClass): number {
  if (statementClass === 'forbidden') {
    return 2;
  }
  if (statementClass === 'write') {
    return 1;
  }
  return 0;
}

/** A batch is as dangerous as its most dangerous statement. */
export function classifyIdaSqlBatch(
  sql: string,
  options: IdaSqlClassifyOptions = {},
): IdaSqlBatchClassification {
  if (typeof sql !== 'string' || !sql.trim()) {
    return { statementClass: 'forbidden', statements: [], rejectReason: 'empty_sql' };
  }
  if (sql.length > MAX_SQL_CHARS) {
    return { statementClass: 'forbidden', statements: [], rejectReason: 'sql_too_long' };
  }

  const parts = splitIdaSqlStatements(sql);
  if (parts.length === 0) {
    return { statementClass: 'forbidden', statements: [], rejectReason: 'empty_sql' };
  }
  if (parts.length > MAX_STATEMENTS) {
    return { statementClass: 'forbidden', statements: [], rejectReason: 'too_many_statements' };
  }

  const statements = parts.map((part) => classifyIdaSqlStatement(part, options));
  const worst = statements.reduce<IdaSqlStatementClass>((acc, entry) => {
    return rankOf(entry.statementClass) > rankOf(acc) ? entry.statementClass : acc;
  }, 'read');

  return { statementClass: worst, statements, rejectReason: '' };
}

/** Human-facing summary of what a batch would do, for the approval popup. */
export function summarizeIdaSqlBatch(classification: IdaSqlBatchClassification): string {
  if (classification.rejectReason) {
    return classification.rejectReason;
  }
  const forbidden = classification.statements.filter(
    (statement) => statement.statementClass === 'forbidden',
  );
  if (forbidden.length > 0) {
    return `refused: ${forbidden.map((statement) => statement.reason ?? 'forbidden').join(', ')}`;
  }
  const writes = classification.statements.filter(
    (statement) => statement.statementClass === 'write',
  );
  if (writes.length === 0) {
    return `${classification.statements.length} read statement(s)`;
  }
  return `${writes.length} write statement(s): ${writes
    .map((statement) => statement.sql.replace(/\s+/g, ' ').slice(0, 80))
    .join(' | ')
    .slice(0, 200)}`;
}
