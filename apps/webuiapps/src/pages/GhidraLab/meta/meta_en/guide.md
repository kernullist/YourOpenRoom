# Ghidra Lab

Headless Ghidra, driven from inside the room. Point it at a binary on the real PC and it produces a
written analysis report in which every claim cites the evidence that supports it.

## What it needs before it does anything

| Requirement                        | Where                            | Notes                                                                                                                                            |
| ---------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ghidra install folder              | this app, Setup -> Paths         | The extracted `ghidra_<version>_PUBLIC` folder itself -- the one containing `support/` and `Ghidra/`.                                             |
| JDK 21+ home                       | this app, Setup -> Paths         | Ghidra 12 requires Java 21. Injected as `JAVA_HOME` into the Ghidra process only, so your system JDK is left alone.                               |
| Python interpreter                 | this app, Setup -> Paths         | Only for headless MCP mode. Use **Bootstrap** to build a private venv with `pyghidra-mcp` in it.                                                  |
| Ghidra project folder              | this app, Setup -> Paths         | Where `.gpr` projects live. Reusing a project is what makes a second analysis of the same binary fast.                                            |
| At least one binary root           | this app, Setup -> Binary roots  | The reach limit: a file outside every root cannot be browsed, found, or analyzed.                                                                 |
| `os_ghidra_analysis` capability    | Settings -> Advanced -> Host PC  | Off by default. Governs browse, session start, queries and sweeps.                                                                                |
| capa (optional)                    | this app, Setup -> Paths         | Adds rule-backed ATT&CK / MBC capability matches. Without it, capability claims come from the import table instead.                               |

## Why the JDK is a separate setting

Ghidra checks `JAVA_HOME` before `PATH`, and when it cannot find a usable JDK it **prompts on
stdin** for one. A background process has no console to answer with, so a wrong JDK does not fail --
it hangs until the analysis deadline, and then reports a timeout that points at the wrong thing.

Preflight therefore runs `java -version` itself and refuses to start when the major version is below
21, naming what it found. Your system `JAVA_HOME` is never read and never changed.

## Session modes

| Mode         | What runs                                                    | Good for                                                        |
| ------------ | ------------------------------------------------------------ | --------------------------------------------------------------- |
| **headless** | `pyghidra-mcp` serving MCP over loopback HTTP                 | Everything. Long-lived, answers follow-up questions.             |
| **batch**    | `analyzeHeadless` with a dump script, one shot                | A machine with no usable Python. Surface facts only, no session. |

A starting session reports which of two waits it is in. `Booting the JVM` means the engine is not
answering yet, and a failure there is almost always the Ghidra folder or the JDK. `Analyzing` means
the engine is up and Ghidra is still working through the binary, which on a large target is simply
slow.

## The sweep

Ten stages. Seven are produced by code, not by a model:

1. **Identity** -- sha256, size, format, architecture
2. **Imports** -- rolled up into capability signals ("can run code inside another process")
3. **Exports**
4. **Strings** -- bucketed into URLs, hosts, device paths, registry keys, commands
5. **Function inventory**
6. **Selection** -- up to 40 functions, each with a recorded reason for being chosen
7. **Deep read** -- decompiled bodies, optionally summarized by the model
8. **Capability map** -- capa rules with their ATT&CK / MBC ids, when capa is configured
9. **Structure** -- call graph plus anti-analysis and packing indicators
10. **Synthesis** -- the report

A stage that fails does not stop the sweep, and the report says which stages failed rather than
quietly omitting their findings.

## How the report avoids inventing things

Every fact the sweep collects becomes an **anchor**: an id, an address, and the fact itself. The
model may only write about anchors. After it drafts, an enforcement pass deletes every factual line
that cites no anchor or cites one that does not exist, and prints the number it deleted at the
bottom of the report. A verifier then reviews the draft against the ledger, and one bounded rewrite
is allowed -- but a rewrite that loses most of its citations is rejected, because that is what a
model does when it retreats into generalities.

If no model is available at all, the deterministic report still ships: it carries the imports,
capabilities, strings, capa matches, call graph and selected functions, all cited.

Summaries a model wrote are marked `(model-inferred)` in the ledger and are never presented as
measurements.

## What Aoi can and cannot do

Aoi has seven tools: find a binary, list sessions, propose a session, ask one bounded question,
propose a sweep, read a report, stop a session.

It **cannot** approve its own proposal, edit the configured paths, create the Python environment,
read raw bytes, or write to the Ghidra database. Those routes exist, but Aoi's tools do not call
them -- what keeps it out is the absence of the tool, not a separate credential.

When Aoi proposes an analysis from chat, the approval appears in this window with the binary, the
preflight state, and what approving will actually start.

## Storage

```text
~/.openroom/ghidra-lab/
  venv/                        bootstrapped python
  runs/<runId>/                report.md, ledger.json, manifest.json

<configured project folder>/   Ghidra projects (.gpr + .rep), reused across runs
apps/ghidralab/data/state.json selected tab, last binary, last run
```

The Ghidra project folder is configured separately and must NOT sit under a dotted
directory. Ghidra rejects any path element beginning with `.`, so `~/.openroom/...`
cannot hold it even though everything else here does -- and it only reports that
after the JVM has started, as a bare exit code 1. Preflight catches it first.

The original binary is never modified. Ghidra analyzes an imported copy, and this app has no path
that writes to the file it was pointed at.
