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
- a capped conversation-continuity boost for user identity, preferences, durable instructions,
  explicit remember requests, session decisions, and LLM-distilled chat memories

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

Phase 4 started connecting Kira automation outcomes to the same local memory schema, but this is a
separate project-memory integration path rather than the active conversation-memory focus.

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
- Prompt retrieval no longer gives Kira-specific evidence memories a special boost in ordinary Aoi
  conversation mode. Kira recall should be handled as an explicit project-memory query mode if it is
  expanded later.

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

## Conversation Memory Focus

Aoi's primary memory loop is conversation continuity:

- preserve the raw chat turn as source evidence
- extract only stable facts, preferences, durable instructions, reusable procedures, decisions, and
  important completed actions
- summarize image attachments by name, MIME type, size, and dimensions instead of passing raw base64
  image data into memory extraction
- rank personal and session continuity above shallow events
- keep prompt injection small enough that memory does not drown the current user message
- keep review controls available because automatic extraction is allowed to be conservative, not
  magical

Project automation memories, including Kira-derived outcomes, are treated as a separate integration
layer. They can remain in the same storage schema for provenance and operator review, but ordinary
conversation prompt selection does not give them special ranking. If Kira needs first-class recall
later, it should be designed as a separate project-memory retrieval mode instead of being mixed into
personal conversation memory.

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
- Conversation memory quality
  - current: write chat episodes and durable memory candidates locally
  - current: use deterministic extraction plus optional provider-backed JSON distillation
  - current: prioritize durable user/session continuity during prompt selection
  - next: add an operator-visible audit view for accepted, rejected, and superseded chat memories
  - next: add source-episode replay so improved distillers can reprocess old conversations
- Kira bridge
  - separate: write server-side Kira completed/attention/interrupted events as `project` memories
  - separate: enrich completed project memories with attempt integration and review evidence
  - separate: keep project automation recall out of ordinary conversation-memory ranking unless the
    user explicitly enters a project-memory retrieval mode

## Validation Targets

Minimum tests for this phase:

- heuristic extraction accepts durable facts and rejects transient turns
- LLM distiller JSON is parsed defensively
- sensitive-looking LLM candidates are filtered
- duplicate memory writes increment `hits`
- conflicting name facts supersede older entries
- prompt selection excludes superseded entries
- prompt selection prioritizes durable conversation preferences over shallow event memories
