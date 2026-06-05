# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Desktop app icons can now be rearranged by drag and drop, with the custom order persisted across
  reloads and app restarts.
- App windows now include minimize, maximize, and close controls. Maximized windows avoid the
  visible chat panel and can be restored to their previous bounds.
- Kira now analyzes work briefs before worker assignment and blocks ambiguous work with
  clarification questions when more information is needed.
- Album can browse a user-selected local photo folder, remember a saved folder path, and expose
  search, sort, grid density, and preview controls.
- Calendar now stores the selected calendar date in view state so the planner reopens on the same
  day.
- Aoi's IDE can create new workspace files from the sidebar or through the `CREATE_FILE` app action,
  then opens the new file in the editor.
- Aoi's IDE now provides a VSCode-style Monaco editor with tabs, workspace search, safe terminal
  commands, split preview, sidebar/bottom-panel toggles, and active-file context for chat.
- Aoi's IDE now has an active-file patch Preview panel so model proposals and unsaved editor edits
  can be inspected before applying or saving.
- Aoi's IDE Problems panel can now run safe diagnostics, parse structured lint/typecheck/test
  findings, and jump to the reported file and line.
- Aoi's IDE now includes a read-only Source Control panel for Git status and per-file diff review.
- Chat tooling can now read the current Aoi's IDE editor buffer through `ide_current_file`,
  including unsaved content snapshots, and can route active-file edits through IDE app actions.
- Chat tooling can now read the active Aoi's IDE selection and replace only the selected text
  through previewable or direct selected-text actions.
- Aoi's IDE now logs chat-driven model actions in a bottom Actions panel and can undo reversible
  active-editor edits.
- Aoi's IDE command palette now searches commands, open tabs, and loaded workspace files with
  keyboard result navigation.
- Aoi's IDE now remembers recent workspace roots and can quick-switch them from Workspace settings,
  the command palette, or the `SWITCH_WORKSPACE_ROOT` app action.
- Room Shop adds a cheerful desktop decoration app with built-in Aoi room wallpaper looks, desk
  moods, live preview, apply, and reset actions.

### Changed

- Minimized app windows stay mounted so ongoing app behavior, including YouTube playback, is not
  interrupted.
- Calendar, Notes, and Album received broad usability refreshes for denser navigation, clearer
  editing surfaces, and better empty/loading states.
- Notes now has clearer navigation stats, search/filter controls, a safer delete confirmation flow,
  and a warmer mixed-color visual system.
- Kira's work, review, and clarification models now preserve clarification state in app storage and
  expose it through schema-aware tooling.

### Fixed

- Calendar date picker selections now update the `Date & Time` field for new or edited events.
- Kira's left project panel no longer overlaps the board at medium widths, and regional or
  unsupported browser locales now fall back to readable labels instead of raw translation keys.
- Kira no longer leaves users stuck on a pending clarification with no usable questions.
- Kira clarification answers are rewritten idempotently instead of appending duplicate answer
  sections to the work brief.
- Kira automation now writes and returns a single consistent `updatedAt` value when updating work
  files.
- Aoi's IDE disk mutation tools now reject the active editor tab, preventing stale Monaco buffers
  when the chat model edits the currently open file.

## [0.1.0] - 2026-03-03

### Added

- Initial open-source release
- Desktop environment with draggable, resizable app windows
- AI Agent chat panel with LLM-powered tool calls
- Built-in apps: Music, Chess, Gomoku, FreeCell, Email, Diary, Twitter, Album, CyberNews
- Vibe workflow for generating new apps via Claude Code
- IndexedDB-based local file system
- i18n support (English, Chinese, Japanese)
- iframe communication SDK (`@gui/vibe-container`)
- Design token system with CSS variables
- CI pipeline (lint + build)
