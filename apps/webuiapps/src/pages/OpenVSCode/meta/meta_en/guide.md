# Aoi's IDE Guide

This app provides a lightweight editor for a local workspace folder.

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

## Notes

- This IDE is intentionally simple: text files only, no terminal, no LSP, no git UI.
- Large files, binary files, and paths outside the workspace root are blocked by the dev-server API.
- The sidebar also exposes the same create-file flow with inline validation and duplicate
  protection.
