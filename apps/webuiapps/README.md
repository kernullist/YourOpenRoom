# @openroom/webuiapps

Main browser desktop runtime for YourOpenRoom.

This package is **not** a stock Vite starter anymore. It is the app that currently delivers:

- the desktop shell and window manager, including persistent icon ordering and chat-aware maximize
- the floating chat panel and tool runtime
- built-in apps under `src/pages/`, including OpenVSCode and PE Analyst
- the local standalone implementation of `@gui/vibe-container`
- the Vite middleware APIs that make Gmail, Kira, Browser Reader, YouTube search, OpenVSCode, PE
  Analyst, TTS lab synthesis, session persistence, and config storage work in local development

## What Lives Here

### Frontend runtime

- `src/components/`
  - shell UI
  - chat panel
  - app windows
- `src/pages/`
  - built-in desktop apps such as Email, Kira, Browser Reader, Notes, Calendar, YouTube, Chess,
    OpenVSCode, and PE Analyst
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
  - real workspace text search
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
- `src/lib/aoiTts.ts`
  - Aoi message playback, phrase prewarming, and TTS status tracking

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
- `/api/kira-*`
- `/api/openvscode/*`
- `/api/ida-pe/*`
- `/api/tts-lab/*`
- `/api/openroom-reset`

## Kira Automation Notes

Kira supports one worker by default or up to three configured workers. In multi-worker mode, every
worker gets a separate git worktree for its attempt, and the reviewer compares all validated
attempts before selecting one winner. Codex CLI workers/reviewers can be configured with
`provider: "codex-cli"` after `codex login`; OpenCode Zen/Go workers/reviewers can be configured
with `provider: "opencode"` or `"opencode-go"` and an OpenCode API key.

Before worker assignment, Kira runs a clarification analysis over the work title, description, and
project context. If a material ambiguity would likely send workers in the wrong direction, Kira
marks the work `blocked`, asks concise questions with multiple-choice options where possible, and
only returns the work to `todo` after the user's answers are saved back into the brief.

For git projects with Kira `autoCommit` enabled, automation commits approved work in the winning
temporary git worktree. The primary project worktree is touched only during the final locked
cherry-pick integration. With multiple workers and `autoCommit` disabled, Kira still isolates
attempts and integrates the selected diff without making the final commit. Integration conflicts,
overlapping dirty files, or existing staged changes block the task and keep the winning isolated
worktree for manual recovery.

If you run only a static build without equivalent backend endpoints, these features will not work.

## Desktop UX Notes

- Desktop icons can be rearranged with drag and drop. The order is stored in browser local storage
  and normalized so newly added apps appear after the user's saved order.
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
- `sessions/...`
  - session-scoped app data and chat data
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
- The TTS lab page is available at `/tts-lab.html` in local dev.
- `openvscode.workspacePath` defaults to the repo root when not configured explicitly.
- `PE Analyst` supports two modes today:
  - current-IDB mode through `ida_pro_mcp` style endpoints such as `http://127.0.0.1:13337/mcp`
  - sample-upload / headless mode through `ida-headless-mcp` style endpoints such as
    `http://127.0.0.1:17300/`
