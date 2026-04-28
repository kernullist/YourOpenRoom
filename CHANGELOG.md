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
- Aoi's IDE can create new workspace files from the sidebar or through the `CREATE_FILE` app
  action, then opens the new file in the editor.

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
