# @openroom/webuiapps

Main browser desktop runtime for YourOpenRoom.

This package is **not** a stock Vite starter anymore. It is the app that currently delivers:

- the desktop shell and window manager, including persistent icon ordering and chat-aware maximize
- the floating chat panel and tool runtime
- built-in apps under `src/pages/`, including Notes, Room Shop, Written By Me, Aoi Research, Kira,
  Aoi's IDE, and PE Analyst
- the local standalone implementation of `@gui/vibe-container`
- the Vite middleware APIs that make Gmail, Kira, Browser Reader, YouTube search, OpenVSCode, PE
  Analyst, Written By Me, TTS lab synthesis, session persistence, and config storage work in local
  development

## What Lives Here

### Frontend runtime

- `src/components/`
  - shell UI
  - chat panel
  - app windows
- `src/pages/`
  - built-in desktop apps such as Email, Room Shop, Kira, Browser Reader, Notes, Calendar, YouTube,
    Chess, OpenVSCode, Written By Me, and PE Analyst
- `src/routers/`
  - standalone desktop routing
- `src/common.scss`
  - shared global styles

### Runtime glue and tooling

- `src/lib/appRegistry.ts`
  - app registry, app metadata loading, action discovery
- `src/lib/fileTools.ts`
  - schema-aware app-storage read/write/patch/delete tools
- `src/lib/workspaceTools.ts`
  - session app-storage search
- `src/lib/ideTools.ts`
  - real workspace search, file reads, non-active file patch/write tools, and active IDE file
    context
- `src/lib/openVscode*`
  - symbol, search, and TypeScript semantic helpers
- `src/lib/idaPe*`
  - PE pre-scan logic, MCP transport adapter, and PE Analyst backend/client glue
- `src/lib/semanticTools.ts`
  - references, exports, definition peek, semantic rename preview/apply
- `src/lib/commandTools.ts`
  - safe workspace command execution
- `src/lib/diagnosticsTools.ts`
  - structured diagnostics parsing
- `src/lib/checkpointTools.ts`
  - IDE/app-storage checkpoints
- `src/lib/previewTools.ts`
  - pre-mutation previews
- `src/lib/undoTools.ts`
  - reversible file mutations
- `src/lib/backgroundWatchTools.ts`
  - polling-based watches for IDE or app-storage changes
- `src/lib/memoryManager.ts`
  - long-term memory persistence and prompt injection
- `src/lib/aoiMemoryManager.ts`
  - Aoi v2 durable memory episodes, conservative extraction, optional LLM distillation, conflict
    handling, and ranked prompt context
- `src/lib/aoiMemoryShared.ts` and `src/lib/aoiMemoryServerWriter.ts`
  - browser-safe Kira memory candidate helpers and server-side Kira automation memory writes
- `src/lib/aoiTts.ts`
  - Aoi message playback, phrase prewarming, and TTS status tracking
- `src/lib/aoiResearchEngine.ts`, `src/lib/aoiResearchPlugin.ts`, and `src/pages/AoiResearch/`
  - Tavily-backed research-run collection, SSRF-safe source reading, evidence extraction, cited
    report persistence, lifecycle hardening, list/status/artifact/cancel APIs, and the dense local
    Research Library UI
- `src/lib/llmClient.ts`
  - provider request formatting, including chat image attachments for OpenAI-compatible, Responses
    API, and Anthropic-compatible model routes

### TTS lab

- `public/tts-lab.html`
  - browser-based A/B listening page for Aoi voice comparisons
- `public/tts-lab.js`
  - the standalone client for the TTS lab page
- `script/generate-aoi-voice-samples.mjs`
  - local sample generation script for Google / ElevenLabs Aoi voice tests

### Dev-server APIs

Most backend behavior in local mode is implemented inside [`vite.config.ts`](./vite.config.ts):

- `/api/llm-config`
- `/api/session-data`
- `/api/gmail/*`
- `/api/browser-reader`
- `/api/cybernews/live`
- `/api/youtube-search`
- `/api/tavily-search`
- `/api/aoi-research/start`
- `/api/aoi-research/list`
- `/api/aoi-research/status`
- `/api/aoi-research/artifact`
- `/api/aoi-research/cancel`
- `/api/kira-*`
- `/api/openvscode/*`
- `/api/ida-pe/*`
- `/api/tts-lab/*`
- `/api/openroom-reset`

## Kira Automation Notes

The Kira app shell also supports project roots with long names or paths in its left panel. Regional
browser locales fall back to the available Kira translations so labels remain readable even when the
exact locale bundle is not present.

Kira uses one Primary Worker by default. It enables one Alternative Worker only when the adaptive
agent graph marks the work as high-risk, ambiguous, runtime-sensitive, or deep-mode. The alternative
attempt runs in a separate git worktree as a patch challenger; the Reviewer and Integrator still
select one winning patch instead of merging pieces from several attempts. Codex CLI
workers/reviewers can be configured with `provider: "codex-cli"` after `codex login`; Claude CLI
workers/reviewers can be configured with `provider: "claude-cli"` after the Claude Code auth flow;
DeepSeek API workers/reviewers can be configured with `provider: "deepseek"`,
`baseUrl: "https://api.deepseek.com"`, and a DeepSeek API key; OpenCode Zen/Go workers/reviewers can
be configured with `provider: "opencode"` or `"opencode-go"` and an OpenCode API key. When
Primary/Alternative workers share the same provider/baseUrl/model route, Kira throttles concurrent
model calls to one for local routes (`llama.cpp`, localhost, or private-network base URLs) and two
for all other routes. Each model call sets the response output token cap to 8192 tokens. Kira does
not impose a fixed tool-call count cap; cancellation, request timeouts, and execution policy checks
remain the stopping controls. When final review, Integrator selection, validation, or a timeout
blocks a work item, Kira writes a main-model status comment with issues and possible solutions.
Review-passable failures also include a `Retry with feedback` section, and the Kira detail panel can
resume the blocked work with that feedback carried into the next worker attempt.

Before worker assignment, Kira runs a clarification analysis over the work title, description, and
project context. If a material ambiguity would likely send workers in the wrong direction, Kira
marks the work `blocked`, asks concise questions with multiple-choice options where possible, and
only returns the work to `todo` after the user's answers are saved back into the brief.

For git projects with Kira `autoCommit` enabled, automation commits approved work in the winning
temporary git worktree. The primary project worktree is touched only during the final locked
cherry-pick integration. With an Alternative Worker and `autoCommit` disabled, Kira still isolates
attempts and integrates the selected diff without making the final commit. Integration conflicts,
overlapping dirty files, or existing staged changes block the task and keep the winning isolated
worktree for manual recovery.

If you run only a static build without equivalent backend endpoints, these features will not work.

## Desktop UX Notes

- Desktop icons can be rearranged with drag and drop. The order is stored in browser local storage
  and normalized so newly added apps appear after the user's saved order.
- Room Shop stores the active wallpaper look and desk mood in app data, while the shell keeps a
  small local-storage snapshot for fast startup and preview/apply/reset events. Non-default looks
  preserve the default Aoi live room as the desktop base and apply overlay/filter tokens on top.
- App windows expose minimize, maximize/restore, and close controls. Maximized windows use the
  available desktop area outside the chat panel.
- Minimized app windows remain mounted so long-running in-app behavior, such as YouTube playback,
  continues while the window is hidden.

## Commands

Run these from the repo root unless you specifically filter to this workspace.

| Command                                           | Purpose                                     |
| ------------------------------------------------- | ------------------------------------------- |
| `pnpm dev`                                        | Start the desktop and local middleware APIs |
| `pnpm --filter @openroom/webuiapps dev`           | Start this app directly with Vite           |
| `pnpm --filter @openroom/webuiapps build`         | Build the browser bundle                    |
| `pnpm --filter @openroom/webuiapps preview`       | Preview the built bundle                    |
| `pnpm --filter @openroom/webuiapps test`          | Run Vitest                                  |
| `pnpm --filter @openroom/webuiapps test:coverage` | Run Vitest with coverage                    |

## Local Persistence

This app reads and writes to `~/.openroom/` in standalone mode:

- `config.json`
  - runtime settings such as LLM, remembered user profile, conversation language mode, Gmail, Aoi
    TTS preferences, Tavily, album, Kira, OpenVSCode, and `idaPe` config
  - Tavily web search can be edited from Settings -> Advanced -> Tavily Web Search, and the same
    server-side Tavily config is required for Aoi research runs
- `sessions/...`
  - session-scoped app data, chat data, chat image attachments, and local Aoi memory v2 data
  - Aoi research artifacts live under `sessions/<character>/<mod>/aoi-research/runs/<runId>/` as
    `manifest.json`, `report.md`, `sources.json`, and `evidence.json`
  - completed Aoi research runs also write a dated, permanent `research_run` memory summary into
    `sessions/aoi/memory-v2/` so later chat turns can recall the result and reopen the artifact
- `characters.json`
  - character definitions
- `mods.json`
  - mod definitions

Session app data is accessed through `src/lib/diskStorage.ts`, which talks to `/api/session-data`.

## Important Notes

- The open-source standalone build aliases `@gui/vibe-container` to `src/lib/vibeContainerMock.ts`.
- App action definitions are loaded from each app's `meta.yaml`.
- The chat panel includes both app-level tools and real workspace tools, so changes in `src/lib/`
  often affect the desktop, Kira, and Aoi's IDE together.
- Aoi chat playback currently uses Google `Despina` by default when TTS is enabled in chat settings.
- Aoi research uses the AOI main LLM route for planning, evidence extraction, report synthesis, and
  verification. Tavily is required only for live web collection. The engine rejects local/private
  source URLs, saves partial artifacts on failure/cancel/timeout, caps source/report artifact size,
  and prevents duplicate active requests plus excessive concurrent runs. The list API returns only
  compact manifest summaries; full report/source/evidence payloads are read through the artifact
  endpoint for a selected run.
- Aoi durable memory v2 stores raw turn episodes and selected memories under
  `sessions/aoi/memory-v2/`. The prompt only receives a ranked, confidence-gated subset. Background
  sync can use the configured LLM as a distiller, but invalid or timed-out distillation falls back
  to deterministic extraction. Aoi also auto-records reusable user interests, preferences, and
  technical question topics from chat turns without requiring an explicit remember request. Explicit
  "remember forever" or "never forget" requests become permanent Aoi memories: they ignore expiry,
  receive retrieval priority, and are protected from automatic supersession by non-permanent
  conflicting facts. Completed research summaries are also permanent and include the completion
  date. The Advanced settings tab includes an Aoi Memory Inspector for review, archive, delete, and
  refresh operations. Kira automation completion and attention events are also bridged into
  project-scoped Aoi memories by a server-side writer, so they persist even when the chat panel is
  not open.
- Chat image input accepts pasted, dropped, or selected PNG, JPEG, WebP, and GIF files. Images stay
  on the main LLM route, bypass the dialog model, and are stored in session chat history as data
  URLs. Aoi memory sync records only attachment metadata instead of raw image payloads.
- The TTS lab page is available at `/tts-lab.html` in local dev.
- `openvscode.workspacePath` defaults to the repo root when not configured explicitly.
- Aoi's IDE supports creating empty files by relative workspace path. Duplicate paths and folders
  are rejected by the local `/api/openvscode/file` endpoint.
- Aoi's IDE publishes the active editor tab to `apps/openvscode/data/state.json`, including the
  current buffer snapshot, cursor, dirty state, open tabs, and panel state. Chat requests such as
  "current file" or "현재 파일" should use `ide_current_file` before reviewing or editing.
- Active editor edits must use the IDE app actions `APPEND_ACTIVE_FILE`, `PATCH_ACTIVE_FILE`, or
  `REPLACE_ACTIVE_FILE` so Monaco's buffer and disk stay in sync. `ide_patch_file` and
  `ide_write_file` are reserved for explicit non-active workspace paths.
- `PE Analyst` supports two modes today:
  - current-IDB mode through `ida_pro_mcp` style endpoints such as `http://127.0.0.1:13337/mcp`
  - sample-upload / headless mode through `ida-headless-mcp` style endpoints such as
    `http://127.0.0.1:17300/`
