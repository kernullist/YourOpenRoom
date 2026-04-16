# Notes Data Guide

## Folder Structure

```
/
├── notes/
│   ├── {noteId}.json
│   └── ...
└── state.json
```

## Note Files `/notes/{noteId}.json`

Each note is stored as a separate JSON file. The filename must match `id`.

| Field | Type | Required | Description |
|---|---|---|---|
| id | string | Yes | Unique note ID, same as filename without `.json` |
| title | string | Yes | Note title. Can be a fallback title like "Untitled note" |
| content | string | Yes | Markdown body content |
| tags | string[] | Yes | Array of simple tag strings without `#` |
| pinned | boolean | Yes | Whether the note is pinned to the top |
| createdAt | number | Yes | Unix timestamp in milliseconds |
| updatedAt | number | Yes | Unix timestamp in milliseconds |

Example:

```json
{
  "id": "weekly-synthesis",
  "title": "Weekly synthesis",
  "content": "# This week\n\n- Ship the note app\n- Review the calendar reminders\n\n## Risks\n\nNeed a repeat-event model later.",
  "tags": ["product", "weekly"],
  "pinned": true,
  "createdAt": 1776200000000,
  "updatedAt": 1776203600000
}
```

## State File `/state.json`

| Field | Type | Required | Description |
|---|---|---|---|
| selectedNoteId | string \| null | No | Currently focused note |
| activeTag | string \| null | No | Active tag filter |
| searchQuery | string | Yes | Current search text |
| previewMode | boolean | Yes | Whether the editor is in preview mode |

Example:

```json
{
  "selectedNoteId": "weekly-synthesis",
  "activeTag": "product",
  "searchQuery": "",
  "previewMode": false
}
```

## Agent Workflow

1. Read `meta.yaml`
2. Read this guide
3. Read existing files in `/notes/`
4. Write or update the target note file in `apps/notes/data/notes/{id}.json`
5. Dispatch `CREATE_NOTE`, `UPDATE_NOTE`, `DELETE_NOTE`, or `REFRESH_NOTES`

Notes:

- Keep tags as plain strings without `#`.
- Write markdown in `content`, not HTML.
- Preserve `createdAt` when updating an existing note.
