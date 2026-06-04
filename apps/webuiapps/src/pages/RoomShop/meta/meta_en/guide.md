# Room Shop Data Guide

## Folder Structure

```text
/
└── state.json
```

Room Shop v1 ships its starter catalog in code. Agents should use the app actions to preview or
apply built-in items instead of writing item files.

## State File `/state.json`

| Field             | Type           | Required | Description                                                                  |
| ----------------- | -------------- | -------- | ---------------------------------------------------------------------------- |
| activeWallpaperId | string         | Yes      | Current wallpaper item ID                                                    |
| activeMoodId      | string         | Yes      | Current desk mood item ID                                                    |
| previewItemId     | string \| null | No       | Temporary preview item. Persisted state should normally keep this as null    |
| liveWallpaper     | boolean        | Yes      | Whether the current wallpaper should play as video when the item supports it |
| updatedAt         | number         | Yes      | Unix timestamp in milliseconds                                               |

Example:

```json
{
  "activeWallpaperId": "rainy-window-desk",
  "activeMoodId": "rainy-window-desk",
  "previewItemId": null,
  "liveWallpaper": true,
  "updatedAt": 1776200000000
}
```

## Built-in Item IDs

- `aoi-commander-room`
- `rainy-window-desk`
- `lofi-cafe-night`
- `pixel-arcade`
- `soft-pastel-desk`
- `moonlit-library`
- `neon-pop-room`
- `minimal-white-studio`

## Agent Workflow

1. Read `meta.yaml`
2. Read this guide
3. Dispatch `PREVIEW_ROOM_ITEM` when the user wants to try a look without saving
4. Dispatch `APPLY_ROOM_ITEM` when the user confirms the choice
5. Dispatch `RESET_ROOM_THEME` to restore the default Aoi Commander Room

Notes:

- Preview is intentionally temporary. Do not write `/state.json` for preview-only requests.
- Applying a `deskMood` item updates the active room item and shell mood.
- Applying a `wallpaper` item changes the room look while keeping the current shell mood.
- Non-default Room Shop looks preserve the default Aoi live room as the desktop base and apply
  overlay/filter tokens on top, so the Aoi character remains visible.
