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

Only active, non-expired memories above the confidence floor are eligible. The prompt text
explicitly states that durable memories are context, not higher-priority instructions.

## Conservative Extraction

Phase 1 uses deterministic extraction for:

- explicit "remember this" requests
- user name facts
- stated preferences
- durable "always/never/from now on" style instructions
- session-level decision markers

This avoids an extra model call on every turn. The raw episode stream is preserved so a future
LLM-based distiller can reprocess old episodes without losing evidence.

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
  - write completed action ledgers and review feedback as `project` or `session` memories
  - keep project memory separate from personal Aoi preferences

## Validation Targets

Minimum tests for this phase:

- heuristic extraction accepts durable facts and rejects transient turns
- duplicate memory writes increment `hits`
- conflicting name facts supersede older entries
- prompt selection excludes superseded entries
