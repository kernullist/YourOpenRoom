# YourOpenRoom

[中文](./README_zh.md) | English | [한국어](./README_ko.md)

> A fork of OpenRoom that has evolved into a local-first browser desktop for AI-operated apps, real
> workspace automation, and prompt-driven app workflows.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

**[Repository](https://github.com/kernullist/YourOpenRoom)** ·
**[Issues](https://github.com/kernullist/YourOpenRoom/issues)** ·
**[Original Fork Source](https://github.com/MiniMax-AI/OpenRoom)**

## What This Repo Is Now

YourOpenRoom started as a fork of MiniMax OpenRoom, but the current codebase is no longer just a
browser desktop demo.

Today the project is centered on three connected layers:

- A **browser desktop shell** with draggable/maximizable windows, reorderable desktop icons, a
  floating chat panel, local state, and a set of built-in apps.
- An **agent runtime** that can operate apps through `meta.yaml` actions, inspect app state, mutate
  app storage, and call tooling from the chat panel.
- A **local project automation stack** built around **Kira** and **Aoi's IDE**, with search, file
  editing, semantic code tools, diagnostics, checkpoints, safe command execution, and automated
  worker/reviewer loops.

The main runtime that ships today lives in `apps/webuiapps`.

## What Actually Ships Today

- A standalone browser desktop with floating windows, persistent drag-and-drop desktop icon order,
  chat-aware maximize/restore, chat docking, live wallpaper toggles, and Kira automation notices.
- A configurable chat panel with:
  - main LLM routing for OpenAI-compatible or Anthropic-compatible backends
  - optional cheaper dialog-model override for light chat turns
  - pasted, dropped, or file-selected image input for vision-capable main models
  - remembered preferred user name
  - reply language mode (`match-user` or `english`)
  - optional Aoi TTS playback for assistant messages, with prewarmed short replies
  - long-term memory saving
  - image generation
  - live web search through Tavily
  - prompt budget, run ledger, skills workshop, MCP/plugin admin, capability registry, tool
    inspector, and Aoi autonomy dashboard panels
- Session-scoped app storage persisted under `~/.openroom/sessions/...`.
- A local mock of `@gui/vibe-container`, so the open-source standalone build works without the
  original iframe runtime.
- Vite middleware APIs for Gmail OAuth, browser/article extraction, YouTube search, live cyber news
  RSS aggregation, album folder access, Tavily proxying, OpenVSCode workspace tools, PE Analyst
  IDA/PE analysis bridging, Dewdrop Canvas local app bridging, TTS lab synthesis, Kira automation,
  config persistence, and session file storage.
- The upstream character/mod layer is still present: characters, mods, emotion media, upload-based
  mod generation, and memory injection are part of the current shell and chat experience.

## Built-in Apps

| App              | What it does now                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Twitter`        | Local social feed with posts, likes, and comments persisted in app storage                                                                                                           |
| `YouTube`        | YouTube search, recent searches, favorite topics, playlists, queue playback, and popup player controls                                                                               |
| `Diary`          | Markdown journal with mood/weather metadata, calendar navigation, and styled handwritten rendering                                                                                   |
| `Album`          | Modern local photo gallery with folder picking, saved folder paths, search, sort, grid density controls, and preview metadata                                                        |
| `FreeCell`       | Persistent FreeCell game state with rule-aware moves                                                                                                                                 |
| `Email`          | Real Gmail sync with OAuth desktop flow, inbox/sent/drafts/trash, reply, draft save, archive, star, restore, and delete                                                              |
| `Chess`          | Full chess rules, 3D board, local persistence, and agent-turn synchronization                                                                                                        |
| `Evidence Vault` | Classified-style evidence browser for structured dossier files stored in app data                                                                                                    |
| `CyberNews`      | Live cybersecurity news pulled from RSS feeds plus a case-board investigation view                                                                                                   |
| `Calendar`       | Local event/reminder planner with month navigation, selected-day agenda, date picker to `Date & Time` sync, and reminder metadata saved in app storage                               |
| `Notes`          | Local markdown notes with pinned collections, tag/search filtering, sorting, formatting helpers, safer delete confirmation, autosaved view state, and preview mode                   |
| `Browser Reader` | Embedded browsing, reader extraction, bookmarks/history, Google result fallback UI, and save-to-Notes                                                                                |
| `Room Shop`      | Cheerful desktop decoration shop for previewing, applying, and resetting built-in Aoi room wallpaper looks and desk mood themes                                                      |
| `Dewdrop Canvas` | Embedded `F:/kernullist/dewdrop-canvas` liquid mind-map board with in-app static/API bridging, persistent projects, markdown export, and offline synthesis fallback                  |
| `Written By Me`  | Embedded `F:/kernullist/written-by-me` writing-style analyzer with in-app upload/URL/API bridging and AOI main-model analysis/translation                                            |
| `Aoi Research`   | Dense research-run library for browsing Aoi-generated reports, source ledgers, evidence claims, and run lifecycle state                                                              |
| `Kira`           | Project work board with work items, comments, discovery analysis, pre-worker clarification questions, and automation handoff                                                         |
| `Aoi's IDE`      | Local workspace tree/editor with file and folder creation on top of OpenVSCode-style APIs for search, symbols, references, rename preview/apply, and safe commands                   |
| `PE Analyst`     | PE static triage workspace with current-IDB mode for `ida_pro_mcp`, sample upload mode for pre-scan/headless flows, and tabs for findings, imports, sections, strings, and functions |

## PE Analyst + IDA MCP

`PE Analyst` now supports two workflows:

- **Current IDB mode**
  - Best with `ida_pro_mcp`
  - Uses the binary currently opened in IDA Pro as the source of truth
  - Supports function listing, pseudocode, disassembly, and xrefs without uploading a file
- **Sample upload mode**
  - Works for the built-in PE pre-scan and for headless backends
  - Stores uploaded PE samples in the local cache and persists analysis metadata in session app data

Today the backend auto-detects two MCP styles:

- `ida_pro_mcp`
  - typically exposed from the IDA plugin as `http://127.0.0.1:13337/mcp`
- `ida-headless-mcp`
  - typically exposed as a standalone HTTP MCP server such as `http://127.0.0.1:17300/`

## Aoi TTS + Voice Lab

The desktop now includes an **optional Aoi TTS layer** for assistant messages.

- When enabled in chat settings, newly added assistant messages are spoken aloud.
- The current default voice is **Google `Despina`**.
- The TTS helper can prewarm:
  - built-in short stock phrases
  - recent real assistant replies from the current session
- A browser-based voice comparison page is available at:
  - `http://localhost:3000/tts-lab.html`
- A local sample-generation script is also included:
  - `node apps/webuiapps/script/generate-aoi-voice-samples.mjs`

## Agent Tooling Inside Chat

The chat panel is not limited to `app_action`. It currently exposes several tool families:

- **App runtime tools**
  - `list_apps`, `app_action`, `get_app_state`, `get_app_schema`
  - declared app-owned operation/settings actions, such as Kira `APPLY_MODEL_SETTINGS` and
    `APPLY_PROJECT_SETTINGS`, run through the app's validation and persistence paths instead of raw
    storage writes
  - every non-OS app exposes common `OPEN_APP_WINDOW`, `FOCUS_APP_WINDOW`, and `CLOSE_APP_WINDOW`
    controls that route through OS window actions, so Aoi can always open, restore, or close an
    in-app surface before using app-specific actions
  - app-operation requests and setting/apply-style follow-ups stay on the main tool route so Aoi can
    dispatch the app action instead of only describing manual steps
  - contextual follow-ups such as "apply that", "run it", "그렇게 설정해줘", "거기에 붙여줘", and
    "실행해줘" keep tools exposed when recent chat context points to an app, browser page, current
    file, or command
  - descriptive app mentions such as "Kira looks good", "Kira 설정 좋네", or "I use Kira daily" stay
    on the dialog route without exposing app tools
  - `list_apps` now returns a capability inventory for every in-app surface: window open/close
    control, state readability, declared `app_action` count, schema coverage, destructive actions,
    and remaining gaps
  - `get_app_state(app_name=...)` includes the same per-app control capability block next to the
    current window/state summary, so Aoi can tell whether an app can be inspected, dispatched,
    schema-edited, or only opened
  - app schema/state coverage includes the legacy game/news surfaces and newer Aoi Research, Aoi
    Memory, Dewdrop Canvas, Written By Me, PE Analyst, and Room Shop state surfaces, reducing false
    "I cannot control this" answers when an app has a readable state or app-owned operation
  - schema-aware app storage tools: `file_read`, `file_write`, `file_patch`, `file_list`,
    `file_delete`
- **Web/content tools**
  - `search_web` via Tavily
  - `read_url` for article-style extraction
  - `start_research`, `get_research_status`, `read_research_artifact`, and `cancel_research` for
    Tavily-backed, AOI-main-LLM research runs that persist cited reports and evidence artifacts
  - `generate_image`
- **Workspace and IDE tools**
  - `workspace_search` for session app storage
  - `ide_search` for the real IDE workspace
  - `find_references`, `list_exports`, `peek_definition`
  - `rename_preview`, `apply_semantic_rename`
  - `run_command`, `structured_diagnostics`
- **Safety and recovery tools**
  - `preview_changes`
  - `undo_last_action`
  - `workspace_checkpoint`
  - IDE checkpoint create/list/restore/delete app actions
  - `autofix_diagnostics`
  - `background_watch`
- **Capability registry**
  - each exposed chat tool is classified by risk, capability surface, access type, cacheability, and
    parallel-safety
  - the active tool list is injected into the system prompt so the model sees only the tools exposed
    for that turn
  - Advanced -> Tool Inspector shows registered capability counts, high-risk tools, and unknown tool
    warnings
- **Run ledger and goal tracking**
  - each model run gets a compact goal derived from the latest user message
  - recent runs persist under the session's `aoi-run-ledger/runs.json`
  - Advanced -> Aoi Run Ledger shows run status, model route, iteration counts, and tool-call totals
- **Aoi autonomy runtime**
  - chat, research, Kira, workspace, and browser-context events are recorded as evidence-linked
    observations
  - mission state, active goals, context routing, background attention brokering, and operator
    digest lanes keep proactive suggestions quiet and reviewable
  - proposals support accept, dismiss, snooze, categorized feedback, source feedback, cooldowns, and
    quiet-mode suppression
  - read-only research artifact/status actions can run after policy checks; research start,
    procedure saving, Kira handoff, and command execution use preview and approval boundaries
  - `aoiOperatorReplay` replays representative operator scenarios to regression-test source
    selection, approval boundaries, evidence refs, non-interruption, blocked reasons, and preference
    conflicts without shell, network, or workspace mutation
- **Skills workshop**
  - built-in and user-authored skills are matched by trigger terms before a chat turn
  - only enabled and trusted skills are injected into the system prompt
  - Advanced -> Aoi Skills Workshop can toggle, trust, add, or delete user skill capsules
- **MCP / plugin admin**
  - built-in and user-registered integrations are tracked with kind, endpoint, enabled/trusted
    state, and health status
  - only enabled and trusted integration context is injected into the system prompt
  - Advanced -> MCP / Plugin Admin can add endpoints, toggle trust, and run lightweight health
    checks

These tools are guarded by the current implementation:

- app JSON writes are validated against machine-readable schemas when available
- semantic rename requires a preview signature before apply
- safe command execution is allowlisted to read-only `git`, `node`, `npm`, and `pnpm` patterns
- Kira reruns planned validation commands itself and can block or retry work before approval
- Aoi autonomy does not run high-risk mutations without an explicit accepted proposal. Approved
  command execution still rechecks cwd boundaries, destructive command patterns, approval
  fingerprints, timeouts, and redacted audit records before spawning a process.
- Aoi research runs reuse the main AOI LLM and require Tavily for live web collection. Artifacts are
  stored under `sessions/<character>/<mod>/aoi-research/runs/<runId>/` as `manifest.json`,
  `report.md`, `sources.json`, and `evidence.json`. Reports are generated from collected source
  claims, verified for citation coverage, and still save partial artifacts on failure, timeout, or
  cancellation. The Research Library app lists compact manifest summaries only; full reports and
  source/evidence ledgers are fetched per selected run. Missing Tavily config, rejected private or
  local URLs, failed source reads, malformed model JSON, artifact caps, duplicate active requests,
  and max-concurrency limits are surfaced as run status or API errors instead of hidden retries.
  Completed research runs also write dated, permanent `research_run` summaries into Aoi memory v2 so
  later chat turns can recall the result and reopen the report artifact when more detail is needed.
- Aoi memory v2 supports permanent memories for explicit "remember forever" / "never forget"
  requests. Permanent memories do not expire, are prioritized during retrieval, and are protected
  from non-permanent automatic replacement; they can still be archived or deleted manually. Aoi also
  auto-records reusable interests, preferences, and technical question topics from normal chat turns
  so later replies can adapt without an explicit memory request.

## Kira + Aoi's IDE

This fork invests heavily in local project work, not just built-in app demos.

### Kira

Kira stores work items and comments in app storage, shows project-scoped boards, and can run a
discovery flow against a configured local work root. The Vite plugin in
`apps/webuiapps/vite.config.ts` also exposes automation endpoints that can:

1. scan actionable tasks
2. analyze whether the brief is specific enough for worker assignment
3. ask clarification questions and block handoff when the brief is ambiguous
4. build a structured Planner and Context Scout contract
5. run Primary Worker, optional Alternative Worker, Reviewer, and Integrator stages
6. rerun validation
7. block, retry, or auto-commit based on project settings

The **Aoi Will Take Care of It** discovery flow now saves a project discovery dossier before it
creates any todo work. The dossier includes a deterministic scout pass, depth score, topology map,
blind spots, project fingerprint, evidence ledger, and candidate findings. Kira shows the saved
dossier in-app so the operator can inspect how much of the project Aoi actually read, copy the
dossier or individual findings as JSON, open/copy linked evidence references, and see whether the
saved fingerprint is fresh, stale, or unavailable.

Discovery findings are not automatically trusted just because an LLM suggested them. Each finding is
quality-gated against linked evidence, existing files, safe validation commands, scope size, stale
fingerprints, blind-spot overlap, and duplicate open work. Only `ready` findings can be selected for
todo creation; blocked findings keep human-readable reasons and raw reason codes in the UI. Created
work items receive a Discovery Provenance section so the worker and reviewer can re-check the source
analysis before editing files.

Clarification runs before workers receive a task. If Kira determines that the title/description
leave a material product or implementation choice open, the work is moved to `blocked` with
multiple-choice questions when possible. User answers are saved back onto the work item and appended
to the markdown brief before the work returns to `todo`.

Kira uses one Primary Worker by default. When work is high-risk, ambiguous, runtime-sensitive, or
running in deep mode, it may enable one Alternative Worker as an isolated patch challenger. The
Alternative Worker uses a separate git worktree and must produce a materially different attempt; the
Reviewer and Integrator still select one winning patch rather than merging pieces from several
attempts. Kira records the adaptive agent graph in each attempt: Planner, Context Scout, Primary
Worker, optional Alternative Worker, Reviewer, and Integrator. The Debugger role is intentionally
omitted; validation failures feed back into the worker/reviewer loop. Kira also limits concurrent
calls to the same provider/baseUrl/model route: local model routes (`llama.cpp`, localhost, or
private-network base URLs) run one at a time, while other routes allow up to two concurrent calls.
Each model call sets the response output token cap to 8192 tokens. Kira does not impose a fixed
tool-call count cap; cancellation, request timeouts, and execution policy checks remain the stopping
controls. When final review, Integrator selection, validation, or a timeout blocks the work, Kira
leaves a main-model status comment with the current state, concrete issues, possible solutions, and,
when the solution is review-pass feedback, a `Retry with feedback` section. Blocked work with that
section can be resumed from the Kira details panel; the retry comment is fed back into the next
worker attempt.

When `autoCommit` is enabled for a git project, approved work is committed in the winning isolated
worktree and then integrated back into the primary project worktree with a short project-level
cherry-pick lock. With an Alternative Worker and `autoCommit` disabled, Kira still isolates attempts
and integrates the winning diff with `cherry-pick --no-commit`. If the primary worktree has
overlapping dirty files, staged changes, or a cherry-pick conflict, Kira blocks the task and leaves
the winning worktree available for manual recovery instead of overwriting local work.

### Aoi's IDE

Aoi's IDE is a built-in file tree and text editor, but the server side is where the deeper tooling
lives. The current `/api/openvscode/*` endpoints support:

- workspace listing and file read/write/delete
- new empty file creation with relative workspace paths and duplicate protection
- text search
- symbol search
- reference lookup
- export listing
- definition peeking
- in-app Symbols panel for definition, references, and exports navigation
- semantic rename preview and apply
- active-file patch preview/apply/discard for model proposals and unsaved editor changes
- active selection context and selected-text replacement actions for chat-driven edits
- model action logging with undo for reversible active-editor edits
- recent workspace root quick switching from settings, command palette, or app action
- command palette search across commands, recent roots, open tabs, and loaded workspace files
- structured diagnostics surfaced in the IDE Problems panel with file/line navigation
- bottom Tests panel for safe test command runs and pass/fail history
- bottom Checkpoints panel for IDE/app-storage checkpoint creation, restore, delete, and refresh
- read-only Source Control panel for `git status` and per-file diff inspection
- safe command execution

Where possible, semantic features use the local TypeScript language service.

## Prompt-to-App Workflow

The original prompt-driven app workflow is still in this repo under `.claude/`.

- `.claude/commands/vibe.md` is the main entry point
- `.claude/workflow/` contains staged generation and change workflows
- `appGeneratorPlugin` in `apps/webuiapps/vite.config.ts` integrates generated apps into the runtime

This is still useful, but it is no longer the only story. The dominant focus of the current fork is
the AI desktop plus local workspace automation stack.

## Quick Start

### Prerequisites

| Tool    | Version |
| ------- | ------- |
| Node.js | 18+     |
| pnpm    | 9+      |

### Run Locally

```bash
git clone https://github.com/kernullist/YourOpenRoom.git
cd YourOpenRoom
pnpm install
cp apps/webuiapps/.env.example apps/webuiapps/.env
pnpm dev
```

Open `http://localhost:3000`.

### Important Runtime Note

`pnpm dev` is the full local stack.

Many of the current capabilities are implemented as Vite middleware, including:

- Gmail OAuth and sync
- Browser Reader proxying
- CyberNews live RSS ingestion
- YouTube search parsing
- album folder access
- Tavily proxying
- Kira automation APIs
- OpenVSCode workspace APIs
- config and session persistence

`pnpm build` will still produce the browser bundle, but those integrations only work if you also
provide equivalent backend endpoints in your deployment.

## Configuration

Runtime settings are read from `~/.openroom/config.json`.

A current example is also available at [`docs/config.example.json`](./docs/config.example.json).

```json
{
  "llm": {
    "provider": "openrouter",
    "apiKey": "YOUR_API_KEY",
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "anthropic/claude-sonnet-4.6"
  },
  "dialogLlm": {
    "provider": "openrouter",
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "openai/gpt-5-mini"
  },
  "userProfile": {
    "displayName": "Minji"
  },
  "conversationPreferences": {
    "responseLanguageMode": "match-user",
    "ttsEnabled": true,
    "ttsPreloadCommonPhrases": true
  },
  "imageGen": {
    "provider": "openai",
    "apiKey": "YOUR_IMAGE_API_KEY",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-image-1"
  },
  "album": {
    "photoDirectory": "C:\\Users\\your-name\\Pictures"
  },
  "kira": {
    "workRootDirectory": "C:\\Users\\your-name\\workspace",
    "projectDefaults": {
      "autoCommit": true
    },
    "workers": [
      {
        "name": "Fast API worker",
        "model": "openai/gpt-5.4-mini"
      },
      {
        "name": "Codex local worker",
        "provider": "codex-cli",
        "model": "gpt-5.3-codex"
      },
      {
        "name": "DeepSeek API worker",
        "provider": "deepseek",
        "apiKey": "YOUR_DEEPSEEK_API_KEY",
        "baseUrl": "https://api.deepseek.com",
        "model": "deepseek-v4-pro",
        "reasoningEffort": "high"
      }
    ],
    "reviewerLlm": {
      "provider": "claude-cli",
      "model": "claude-sonnet-4-6"
    }
  },
  "openvscode": {
    "workspacePath": "C:\\Users\\your-name\\workspace\\your-project",
    "workspaceHistory": ["C:\\Users\\your-name\\workspace\\your-project"]
  },
  "tavily": {
    "apiKey": "tvly-YOUR_API_KEY",
    "baseUrl": "https://api.tavily.com/search"
  },
  "gmail": {
    "clientId": "YOUR_GOOGLE_OAUTH_DESKTOP_CLIENT_ID",
    "clientSecret": "OPTIONAL_GOOGLE_CLIENT_SECRET"
  },
  "idaPe": {
    "mode": "prescan-only",
    "backendUrl": "http://127.0.0.1:17300/"
  },
  "app": {
    "title": "YourOpenRoom"
  }
}
```

Tavily can also be configured from Aoi's Settings -> Advanced -> Tavily Web Search. When configured,
Aoi exposes `search_web` and will use it before answering current-information requests. The same
Tavily config is required for `start_research`; AOI main LLM settings are reused for research
planning, evidence extraction, report synthesis, and verification.

Notes:

- `openvscode.workspacePath` is the real workspace used by Aoi's IDE and the IDE tooling APIs.
- If `openvscode.workspacePath` is omitted, the current code defaults to the repo root.
- `openvscode.workspaceHistory` stores recent IDE roots for quick switching in Workspace settings
  and the command palette.
- `gmail.clientId` must be a Google OAuth **Desktop App** client ID.
- `dialogLlm` is optional, but it needs at least a `baseUrl` and `model` when enabled unless it uses
  a local login CLI provider.
- Chat image input uses the main LLM route only. Up to four PNG, JPEG, WebP, or GIF images can be
  attached per message, each capped at 8 MB. If the selected main model is not recognized as
  vision-capable, Aoi keeps the pending images and opens the Models settings.
- `kira.workRootDirectory` can point either to a project folder itself or to a parent folder that
  contains multiple project folders. If the root has project markers such as `.git`, `package.json`,
  or `requirements.txt`, Kira treats that root as one project.
- `kira.workers` is optional. When omitted, Kira uses the legacy `workerLlm` / `workerModel` setting
  as one worker, then falls back to the main `llm` route when no Kira-specific role setting exists.
  When present, Kira uses the first three entries and each worker can choose a different provider or
  model.
- Aoi can inspect Kira's sanitized effective model/default settings with `get_app_state("kira")` and
  can apply user-approved Kira model/project settings through Kira-owned app actions. Secrets such
  as API keys and custom headers are not exposed in that state summary.
- `provider: "codex-cli"` runs the local Codex CLI with your existing ChatGPT login. Run
  `codex login` once outside Kira before using it.
- `provider: "claude-cli"` runs the local Claude CLI with your existing Claude Code auth session.
  Run `claude auth` or finish the Claude Code login flow once before using it.
- `provider: "deepseek"` uses the official DeepSeek OpenAI-compatible API at
  `https://api.deepseek.com`. Current presets include `deepseek-v4-pro` and `deepseek-v4-flash`;
  `deepseek-chat` and `deepseek-reasoner` are kept only as compatibility aliases until July
  24, 2026.
- `provider: "opencode"` and `"opencode-go"` use OpenCode Zen/Go API keys. Kira defaults their base
  URLs to `https://opencode.ai/zen` and `https://opencode.ai/zen/go`; set `apiStyle` only when you
  need to force `openai-chat`, `openai-responses`, or `anthropic-messages`.
- `userProfile.displayName` lets the chat panel remember how to address the user across launches.
- `conversationPreferences.responseLanguageMode` supports `match-user` and `english`.
- `conversationPreferences.ttsEnabled` turns Aoi message playback on or off.
- `conversationPreferences.ttsPreloadCommonPhrases` pre-generates common short lines and recent
  assistant replies to reduce playback delay.
- When `conversationPreferences.responseLanguageMode` is `english`, assistant replies, reminder
  messages, and newly seeded opening/prologue messages are generated in English.
- `imageGen` is optional and powers the chat panel's image-generation tool.
- `idaPe.mode` supports `prescan-only` and `mcp-http`.
- `idaPe.backendUrl` can point to an IDA MCP server such as `http://127.0.0.1:13337/mcp` for
  `ida_pro_mcp` current-IDB mode or `http://127.0.0.1:17300/` for `ida-headless-mcp`.

### Optional `.env`

`apps/webuiapps/.env.example` covers optional build/runtime settings such as CDN and Sentry values,
and local TTS experiments can use:

- `GEMINI_API_KEY`
- `ELEVENLABS_API_KEY`

## Local Data Layout

The standalone build persists data under `~/.openroom/`.

```text
~/.openroom/
├── config.json
├── characters.json
├── mods.json
└── sessions/
    └── <session-path>/
        ├── apps/
        │   ├── notes/data/
        │   ├── email/data/
        │   ├── kira/data/
        │   ├── peanalyzer/data/
        │   └── ...
        ├── aoi-autonomy/
        │   ├── observations/
        │   ├── proposals/
        │   ├── decisions/
        │   ├── goals/
        │   └── command-audit/
        ├── aoi-research/
        │   └── runs/
        ├── chat/
        └── memory/
```

## Repository Layout

```text
YourOpenRoom/
├── apps/
│   └── webuiapps/          # Main browser desktop runtime
├── packages/
│   └── vibe-container/     # Shared types + standalone stub package
├── .claude/                # Prompt-to-app workflow scaffolding
├── docs/                   # Supporting project docs and config example
└── e2e/                    # Playwright scenarios
```

Inside `apps/webuiapps/src/`:

- `components/` contains the desktop shell, chat panel, and app window chrome
- `pages/` contains built-in apps
- `lib/` contains the runtime glue: storage, LLM clients, tools, app registry, plugins, and IDE
  helpers
- `routers/` defines the browser routes used by the standalone shell

## Development

| Command                                           | Purpose                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm dev`                                        | Start the local desktop plus Vite middleware APIs at `http://localhost:3000` |
| `pnpm build`                                      | Build the browser bundle                                                     |
| `pnpm clean`                                      | Clean Turborepo artifacts                                                    |
| `pnpm run lint`                                   | Lint and auto-fix                                                            |
| `pnpm run pretty`                                 | Format source files                                                          |
| `pnpm --filter @openroom/webuiapps test`          | Run Vitest unit tests for the desktop app                                    |
| `pnpm --filter @openroom/webuiapps test:coverage` | Run Vitest with coverage                                                     |
| `pnpm test:e2e`                                   | Run Playwright end-to-end tests                                              |

## Tech Stack

| Area          | Current stack                                                                          |
| ------------- | -------------------------------------------------------------------------------------- |
| UI            | React 18, TypeScript, React Router, Vite                                               |
| Styling       | SCSS and CSS Modules                                                                   |
| Motion        | Framer Motion                                                                          |
| App runtime   | Local `@gui/vibe-container` mock, session-data middleware, app `meta.yaml` actions     |
| Local tooling | Filesystem APIs, TypeScript language service, safe command runner, diagnostics parsers |
| Integrations  | Gmail OAuth, Tavily, image generation, RSS ingestion, YouTube search parsing           |
| Monorepo      | pnpm workspaces, Turborepo                                                             |
| Testing       | Vitest and Playwright                                                                  |

## Contributing

Issues, documentation fixes, workflow improvements, new tools, and app changes are all welcome.
Start with [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
