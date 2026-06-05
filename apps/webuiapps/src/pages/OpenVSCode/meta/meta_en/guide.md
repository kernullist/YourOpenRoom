# Aoi's IDE Guide

This app provides a VSCode-style editor for a local workspace folder. It supports a file explorer,
Monaco text editing, tabs, workspace search, a safe command terminal, a bottom panel, and editor
state sharing with the chat model.

## Configuration

The IDE uses `openvscode.workspacePath` from `~/.openroom/config.json` as its workspace root. If
that value is missing, it falls back to the current OpenRoom repository root.

Example:

```json
{
  "openvscode": {
    "workspacePath": "F:/kernullist/YourOpenRoom"
  }
}
```

The user can also update the workspace path from inside the app.

## Agent Workflow

1. Use `OPEN_APP` to open Aoi's IDE.
2. Use `OPEN_FILE` with a path relative to the workspace root to focus a file.
3. Use `CREATE_FILE` with a relative path to create an empty file and open it. Absolute paths,
   parent-directory traversal, existing files, and directory paths are rejected.
4. Use `REFRESH_WORKSPACE` if files changed on disk and the tree needs reloading.
5. Use `RUN_DIAGNOSTICS` to run a safe lint/typecheck/test command and populate the Problems panel.
   Parsed diagnostics can be clicked in the IDE to open the file and line.
6. Use `REFRESH_GIT_STATUS` to update the read-only Source Control panel with changed files and
   diffs.

## Current File Context

The IDE writes `apps/openvscode/data/state.json` with the active editor tab, open tabs, cursor
position, workspace path, and UI panel state. The active file snapshot includes the current editor
buffer, so unsaved text is visible to the main model through `get_app_state` and `ide_current_file`.

Use this flow when the user says "current file", "active file", "opened file", "현재 파일", "활성
파일", or "열린 파일":

1. Call `ide_current_file` to read the active editor buffer.
2. For review or explanation, answer from that result.
3. When the user wants to inspect the change first, call `PREVIEW_APPEND_ACTIVE_FILE`,
   `PREVIEW_PATCH_ACTIVE_FILE`, or `PREVIEW_REPLACE_ACTIVE_FILE`. The pending diff appears in the
   IDE bottom Preview panel.
4. Call `APPLY_ACTIVE_FILE_PREVIEW` after the user approves the preview, or
   `DISCARD_ACTIVE_FILE_PREVIEW` when the proposal should be dropped.
5. For immediate appends, call `APPEND_ACTIVE_FILE`.
6. For immediate exact replacements, call `PATCH_ACTIVE_FILE`.
7. For immediate full-file replacement, call `REPLACE_ACTIVE_FILE`.

Active-file edit actions save to disk by default. Pass `save: "false"` only when the user explicitly
asks for a draft buffer edit.

Users can also preview their own unsaved editor changes from the toolbar or command palette before
saving. Applying that preview saves the current buffer to disk.

Use `ide_read_file` for known workspace files. Use `ide_patch_file` or `ide_write_file` only with an
explicit path that is not the current active editor buffer; active editor mutations must go through
the active-file app actions so Monaco's in-memory buffer and disk stay synchronized.

## Notes

- This IDE is text-file focused and does not provide LSP or a full git UI.
- Large files, binary files, and paths outside the workspace root are blocked by the dev-server API.
- The sidebar also exposes the same create-file flow with inline validation and duplicate
  protection.
