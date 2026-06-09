# Aoi Persistent Memory Design

This document describes the first local-first persistent memory layer for Aoi.

## Goal

Aoi should keep useful conversation context across turns and sessions without turning the full chat
log into prompt noise. The memory layer must:

- preserve raw turn evidence before extracting memories
- select durable facts, preferences, decisions, and procedures conservatively
- avoid blocking the user-facing response
- keep existing `save_memory` behavior compatible
- treat memory as lower priority than system rules and the current user message

## Current Baseline

Before this design, Aoi had a simple v1 memory path:

- `src/lib/memoryManager.ts`
  - stores individual JSON memories under the current character/mod session
  - exposes the `save_memory` tool
  - injects a small latest-first memory summary into the system prompt
- `src/lib/chatHistoryStorage.ts`
  - stores the current session chat in `chat/chat.json`
- `vite.config.ts`
  - exposes `/api/session-data`, backed by `~/.openroom/sessions/`

This is useful, but it lacks raw episode provenance, ranking, conflict handling, and cross-session
Aoi memory.

## Phase 1 Architecture

Phase 1 adds `src/lib/aoiMemoryManager.ts`.

Storage remains local and file-backed through `/api/session-data`:

- `~/.openroom/sessions/aoi/memory-v2/memories/*.json`
  - active, archived, and superseded durable memories
- `~/.openroom/sessions/aoi/memory-v2/episodes/{sessionPath}/*.json`
  - raw user/assistant turn records and direct action acknowledgements

The runtime loop is:

1. User sends a message.
2. ChatPanel builds the system prompt from character, mod, tools, v1 memories, and selected v2 Aoi
   memories.
3. Aoi responds normally.
4. ChatPanel records the delivered assistant message and any tool summaries.
5. `syncAoiMemoryFromTurn` runs in the background.
6. The background job stores a raw episode, extracts durable memory candidates, deduplicates or
   supersedes existing memories, and refreshes prompt-ready memory state.

The user-facing response is not delayed by step 5.

## Memory Schema

Durable memory entries use version `2`:

- `scope`: `user`, `agent`, `session`, or `project`
- `type`: `fact`, `preference`, `decision`, `event`, `procedure`, `action`, or `emotion`
- `status`: `active`, `superseded`, or `archived`
- `content`: concise memory text
- `importance` and `confidence`: ranking and prompt admission signals
- `hits`: repeated confirmations or duplicate observations
- `sourceEpisodeIds`: provenance links back to raw episodes
- `supersedes`: old memory ids replaced by a newer memory
- `tags` and `entities`: retrieval hints

## Selection Policy

Prompt injection is ranked, not latest-first. The score combines:

- importance
- confidence
- recency
- query overlap
- hit count
- scope boost for user/agent memory
- a capped Kira evidence boost for project memories with review, validation, commit, or PR
  provenance

Only active, non-expired memories above the confidence floor are eligible. The prompt text
explicitly states that durable memories are context, not higher-priority instructions.

## Phase 2 Distillation

Phase 2 adds an optional LLM distiller inside the same background sync path.

The distiller:

- runs only after the user-facing assistant response is already delivered
- reuses the configured `llmClient.chat()` provider path instead of introducing a separate API
  client
- skips direct app actions and manual memory writes, which already have deterministic provenance
- gates short or trivial turns before spending an extra model call
- asks the model to return strict JSON with at most five durable memory candidates
- filters sensitive-looking secrets such as passwords, API keys, and tokens
- falls back to deterministic candidates if the model times out or returns invalid JSON

This keeps the raw episode log as ground truth while allowing richer extraction for durable
preferences, decisions, procedures, and project context.

## Phase 3 Review Controls

Phase 3 adds an Aoi Memory Inspector in the Advanced settings tab.

The inspector exposes:

- active, prompt-eligible, archived, and superseded memory counts
- the latest durable memory entries with scope, type, status, confidence, hit count, tags, and
  update time
- refresh, archive, and delete controls

This is required operationally because automatic memory extraction can be wrong. The assistant may
suggest memories, but the user needs a direct way to inspect and remove low-quality or stale
memories without editing JSON files by hand.

## Phase 4 Kira Bridge

Phase 4 starts connecting Kira automation outcomes to Aoi memory.

- Kira automation `completed` events become `project/action` memories.
- Kira `needs_attention` and `interrupted` events become lower-confidence `project/event` memories.
- `started`, `resumed`, and `steered` progress events are ignored because they are transient.
- Kira event memories use stable episode ids, so reprocessing the same event does not inflate memory
  hit counts.
- Project memories carry a `projectKey` to keep Kira project outcomes separate from personal Aoi
  preferences.
- The Kira automation plugin writes these memories server-side when it enqueues automation events,
  so completed work can be remembered even when the chat panel is not open.
- Completed Kira memories are enriched from saved attempt and review records when available. The
  compact memory context includes attempt number/status, changed files, validation pass/fail counts,
  integration status, commit/PR evidence, review approval, review summary, and checked evidence
  files.
- Prompt retrieval gives these evidence-backed Kira memories a small capped boost when the user asks
  about Kira work, review, validation, commits, PRs, evidence, tests, or builds.

The server writer deliberately stays separate from the browser LLM distiller. It has no `window`,
`fetch`, or `localStorage` dependency and only records deterministic Kira outcome memories.

## Conservative Extraction

The deterministic extractor remains active for:

- explicit "remember this" requests
- user name facts
- stated preferences
- durable "always/never/from now on" style instructions
- session-level decision markers

The heuristic path is still the fallback and baseline. The raw episode stream is preserved so future
distillers or external providers can reprocess old episodes without losing evidence.

## Provider Roadmap

The local schema is intentionally provider-neutral.

- Mem0 adapter
  - map `add/search/update/delete` to the local candidate/search interface
  - keep local episode storage as ground truth
  - use Mem0 for external extraction/retrieval only when configured
- Zep or Graphiti adapter
  - map episodes into temporal graph episodes
  - use graph retrieval for people/projects/decisions that change over time
  - keep prompt admission gated by the local trust policy
- Kira bridge
  - current: write server-side Kira completed/attention/interrupted events as `project` memories
  - current: enrich completed project memories with attempt integration and review evidence
  - current: rank evidence-backed Kira memories slightly higher during prompt selection
  - next: add an operator-visible memory quality audit for Kira-derived memories
  - keep project memory separate from personal Aoi preferences

## Validation Targets

Minimum tests for this phase:

- heuristic extraction accepts durable facts and rejects transient turns
- LLM distiller JSON is parsed defensively
- sensitive-looking LLM candidates are filtered
- duplicate memory writes increment `hits`
- conflicting name facts supersede older entries
- prompt selection excludes superseded entries
- prompt selection prioritizes evidence-backed Kira memories over shallow completed-event memories
