# IDA Lab

Native IDA Pro plus IDASQL, driven from inside the room. Pick a binary on the real PC, start
analysis, and query the IDA database in SQL.

## What it needs before it does anything

| Requirement                      | Where                           | Notes                                                                                                                                         |
| -------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `idasql` executable              | this app, Setup -> Paths        | Download the release and put it **next to the IDA binary**; that folder is placed on `PATH` when idasql runs, and is how it finds the engine. |
| `ida.exe`                        | this app, Setup -> Paths        | Only needed for GUI mode.                                                                                                                     |
| At least one binary root         | this app, Setup -> Binary roots | The reach limit: a file outside every root cannot be browsed, found, or analyzed.                                                             |
| `os_ida_analysis` capability     | Settings -> Advanced -> Host PC | Off by default. Governs browse, session start, and read SQL.                                                                                  |
| `os_ida_write` capability        | Settings -> Advanced -> Host PC | Off by default. Only needed for mutating SQL.                                                                                                 |
| `os_ida_auto_session` capability | Settings -> Advanced -> Host PC | Off by default. Only needed for unattended session start via a standing grant.                                                                |

`idalib` next to the IDA binary is what makes headless mode work. Setup -> Diagnostics reports
whether it was found.

## Session modes

**headless** (default) spawns `idasql -s <binary> --http <port>`. idalib runs the auto-analysis, so
a session sits in `analyzing` until the server answers - minutes, on a large binary. No IDA window
appears. Ports come from the configured window (8300-8399 by default).

**gui** launches `ida.exe <binary>` for you. IDASQL inside IDA picks its own port, so after you run
`.http start` in the IDA idasql CLI, press **Attach to open IDA** (or Aoi calls `ida_gui_attach`)
and ports 8100-8199 are probed. A GUI session's process is never killed by IDA Lab - closing it only
detaches.

## Reading vs writing

Every submitted batch is classified statement by statement before anything is sent to idasql:

| Class       | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`      | `SELECT`, `WITH ... SELECT`, `EXPLAIN`, `VALUES`, read-only `PRAGMA`, and the read dot-commands. Runs immediately.                                                                                                                                                                                                                                                                                                                                 |
| `write`     | Anything that mutates - `UPDATE funcs SET name = ...`, `INSERT`, `DELETE`, DDL - **plus a SELECT that calls a mutating IDASQL function** (`make_code`, `parse_decls`, `rebuild_strings`, `set_numform*`, `set_union_selection*`), plus a call to any function this build has not reviewed, plus anything the classifier does not recognize. Does **not** run: it records a content-addressed approval and shows a confirmation with the exact SQL. |
| `forbidden` | `ATTACH` / `DETACH`, `VACUUM INTO`, `load_extension()`, `readfile()` / `writefile()` / `fsdir()`, `PRAGMA writable_schema`, any dot-command outside the read list, **unterminated quoting**, and the IDASQL escapes: `save_database()`, `idapython_snippet()`, `idapython_file()`, anything naming `enable_idapython`, `load_file_bytes()`, `gen_cfg_dot_file()`. Refused outright - no approval makes these in-scope.                             |

### The verb is not the whole story

IDASQL exposes 49 functions of its own, and some of them change the database or leave it entirely.
`SELECT make_code(0x401000)` converts bytes to code; `SELECT save_database()` writes the database to
disk. A classifier that reads the leading verb calls both of those queries. They are handled by
name, and the names came from asking a real install:

```sql
SELECT DISTINCT name FROM pragma_function_list WHERE builtin = 0
```

Because that list is pinned to a version, **every session asks its own engine the same question when
it becomes ready** and compares the answer to the reviewed set. A function nobody has reviewed makes
a statement a `write` - unreviewed means "ask the operator", not "assume harmless". So an idasql
upgrade that adds something dangerous cannot arrive silently classified as a read.

Literals are redacted before matching, so `... WHERE name LIKE '%attach%'` is still a read. A batch
is as dangerous as its most dangerous statement.

Unterminated quoting is refused rather than tolerated. Both the statement splitter and the redactor
recover from an unclosed `'`, `"`, backtick or `[` by swallowing the rest of the input - which is
precisely how `SELECT [x ; UPDATE funcs SET name = 'a'` reduced to `select []` and read as a query
with a mutation inside it. SQLite rejects unterminated quoting anyway, so refusing it costs nothing.
An unterminated block comment is still accepted: it removes the tail rather than hiding it.

A write also needs the session to have been started **in write mode** (`idasql -w`). Without `-w`
idasql discards changes on exit, which is the structural guarantee behind read-only sessions - so a
write against a read-only session is refused with `session_is_read_only` rather than silently doing
nothing.

## Approval flow

```text
propose  ->  pending approval (sha256 of the exact action, 5 min TTL)  ->  operator click  ->  execute
```

The fingerprint covers `{binary, mode, write}` for a session start and the normalized SQL for a
write, so an approval for one action can never run a different one. Execution consumes the approval
before the effect happens, so it is single-use even if something crashes mid-run.

Aoi's tools stop at "propose". `POST /approvals/run`, `POST /config` and the grant routes exist but
are not in Aoi's tool surface, so it cannot approve its own proposal, widen the roots, or mint a
grant. Honest limit: those routes share the daemon token, so what keeps Aoi out is the absence of
the tool (plus the token in production), not a separate human credential.

## Standing grants (unattended start)

A grant is the only way a session starts without a click. It is scoped to **one binary root**,
capped at 24h (2h default) and a session quota (3 default), consumed under the cross-process store
lock, and never covers a write query. It is honored only while `os_ida_auto_session` is on; panic or
that switch stops it instantly. Create and revoke them under Setup -> Standing grants.

**Inert today, and worth being blunt about.** The server side is complete and tested: a request that
asks for an auto start (`auto: true` on `/sessions/preview`) consumes a live grant and starts the
session. Nothing sends that flag. Every host capability in this codebase - process spawn, browser
drive, desktop input, and now IDA Lab - is reached through a browser-only client, so the tools exist
only on the chat path where the operator is present and a click is trivial. The autonomous daemon
loop has no tool client at all. Until it gets one, a grant changes nothing, and the honest reading
of "autonomous session start" is "the gate and the quota are ready for it", not "it is happening".

## The binary is the untrusted party

Worth stating plainly for a tool whose whole job is reading things you do not trust: strings, symbol
names and decompiled pseudocode from a sample are **written by whoever wrote the sample**, and a
query result puts them straight into Aoi's context. A crafted binary can carry text aimed at the
model reading it - a fake clean verdict, or an instruction to open something else.

Every query result is therefore delivered with an `content_trust` field, first in the payload,
saying the rows are untrusted content to be reported as evidence and never followed as instructions.
Filename listings carry the same label. This does not hide anything: the content is delivered in
full, it is just labelled as what it is.

## Aoi's tools

| Tool                | Effect                                              |
| ------------------- | --------------------------------------------------- |
| `ida_find_binary`   | Names and sizes inside the roots. No file content.  |
| `ida_session_list`  | Open sessions plus configuration state.             |
| `ida_analyze_start` | Proposes a session; returns `approval_required`.    |
| `ida_sql_query`     | Runs reads; turns a write into an approval request. |
| `ida_gui_attach`    | Attaches to an idasql server inside a running IDA.  |
| `ida_session_stop`  | Closes a session IDA Lab owns.                      |

They ride a turn only when it looks like reversing work, or once a session has been touched in this
page - six tool definitions on every turn is real prompt cost.

## Data schemas

`apps/idalab/data/state.json`

| Field            | Type                  | Notes                                   |
| ---------------- | --------------------- | --------------------------------------- |
| `version`        | `1`                   | Schema version.                         |
| `sqlDraft`       | string                | The SQL editor contents.                |
| `lastBinaryPath` | string                | Last selected binary, restored on open. |
| `mode`           | `'headless' \| 'gui'` | Preferred session mode.                 |

Session state itself is **not** persisted. Sessions are process-scoped on purpose: a restarted
server must not inherit ownership of processes it can no longer see, and a session the daemon
started is not visible to the dev server.

Configuration lives in the shared config file under the `idaSql` key (`idaExePath`, `idasqlExePath`,
`defaultMode`, `binaryRoots`, `httpPortStart`, `httpPortEnd`, `sessionIdleTimeoutMs`,
`writeEnabled`). Approvals and grants live under `~/.openroom/host-bridge/`.

## Server routes

`/api/ida-sql/*` - `health`, `config`, `browse` (with `find` for a bounded name search), `sessions`,
`sessions/preview`, `sessions/attach`, `query`, `approvals/run`, `approvals`, `grants`,
`session-output`. Mounted on both the dev server (loopback-trusted) and the autonomy daemon
(token-required).

## Verified against a real install

Checked on 2026-08-27 against **idasql v0.0.18.1 (ida94 build)** at `F:\Aoi\idasql\idasql.exe` with
**IDA Professional 9.4**, analyzing a real PE end to end. What that pinned down:

- **The IDA directory must be on PATH, and it is the `ida.exe` directory - not idasql's.** Launched
  without it, idasql exits with `0xC0000135` (DLL not found) having printed nothing at all. That
  exit code is now translated into a message that says so.
- **`Authorization: Bearer <token>`** is the auth scheme (`X-Token` and `?token=` both get 401).
  Every session now starts with `--token` and its own random token, and `--bind 127.0.0.1`. Honest
  limit: the token is on the command line, so another process running as you can read it with a
  process listing. It stops a web page in your browser posting to the port, and any caller that
  cannot enumerate processes - not a determined local attacker.
- **A failed statement comes back as HTTP 200** with a top-level `"success": false` and the message
  in `results[i].error`. Reading only the top level reported "no such column" as a successful query
  with zero rows.
- **Dot-commands are REPL-only.** `.tables` over HTTP is `near ".": syntax error`. Use
  `SELECT name FROM sqlite_master WHERE type IN ('table','view')` and `PRAGMA table_info(<name>)`.
- **The schema is ~80 tables/views**, and function addresses are `addr` / `end_addr` (there is no
  `start_ea`). The snippets in the app use the real columns.
- Analysis leaves IDA's unpacked database next to the binary (`.id0`, `.id1`, `.nam`, `.til`) even
  after a clean shutdown, roughly 900 KB for a 64 KB executable. Re-analyzing the same binary with
  them present works.
- **One idasql per database.** Two processes on the same binary is the second one exiting with code
  1 after printing only `Opening: ...`. Within one server that is refused up front
  (`session_already_open`); across the dev server and the daemon it is not visible, so it can still
  happen.
- **`-w` decides whether a session persists on exit, and that was measured.** A write session
  renamed a function and the new name survived a full restart. A session started **without** `-w`
  also _accepts_ the same `UPDATE` and shows the new name for the rest of that session, but after a
  clean shutdown and reopen the change was gone. Caveat: inside a read-only session a mutation IS
  visible, so a renamed symbol can be reported as if it were the name on disk. Treat a read-only
  session's answers as the database plus whatever was done to it in that session.
- **CORRECTION.** An earlier version of this guide said a read-only session could not persist
  anything _whatever SQL reached it_. That was false. `SELECT save_database()` persisted an UPDATE
  from a session started without `-w`, and the rename survived a restart - and being a `SELECT`, it
  was classified as a read and ran with no approval. `save_database` is now refused outright. The
  accurate statement is narrower: **`-w` governs what happens at exit; it is not a barrier against a
  statement that saves on purpose.**
- `/shutdown` requires the token too (401 without it), so the token is what lets IDA Lab stop its
  own server rather than having to kill it.

## Known limits

- The idasql wire format is not something this app controls. The response parser follows the shapes
  observed in v0.0.18.1 (above) plus several plausible variants, and surfaces anything else as an
  engine error rather than guessing.
- Session registries **and pending previews** are per process (dev server vs daemon), so a session
  started by one is not listed by the other, and a preview recorded by one cannot be approved
  through the other. In practice the browser always talks to the same server that previewed.
- The GUI attach probe requires a scanned responder to look like idasql; an unrelated local server
  on 8100-8199 is skipped rather than sent SQL. A port you pass explicitly is taken at your word.
- **A write session's per-query approval covers statements the classifier can see as mutations.**
  IDASQL's schema is its own; if it exposes a table-valued function that changes the database when
  SELECTed, that would read as a query. Two things bound this: a session started without `-w`
  discards changes on exit whatever the SQL does, and write sessions need both the Setup toggle and
  the `os_ida_write` capability. Prefer a read-only session for exploration, and open a write
  session for the change you are about to make rather than leaving one open.
