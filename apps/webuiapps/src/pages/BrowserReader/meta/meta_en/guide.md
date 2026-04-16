# Browser / Reader Data Guide

## Folder Structure

```
/
├── bookmarks/
│   ├── {bookmarkId}.json
│   └── ...
├── history/
│   ├── {historyId}.json
│   └── ...
└── state.json
```

## Bookmark Files `/bookmarks/{bookmarkId}.json`

| Field | Type | Required | Description |
|---|---|---|---|
| id | string | Yes | Bookmark ID, same as filename without `.json` |
| url | string | Yes | Full http/https URL |
| title | string | Yes | Display title |
| createdAt | number | Yes | Unix timestamp in milliseconds |

Example:

```json
{
  "id": "bookmark-001",
  "url": "https://www.notion.com/notes",
  "title": "Notes, docs, and wikis",
  "createdAt": 1776200000000
}
```

## History Files `/history/{historyId}.json`

These are frontend-managed records of recently visited pages.

| Field | Type | Required | Description |
|---|---|---|---|
| id | string | Yes | History ID |
| url | string | Yes | Full http/https URL |
| title | string | Yes | Best-known page title |
| visitedAt | number | Yes | Unix timestamp in milliseconds |

## State File `/state.json`

| Field | Type | Required | Description |
|---|---|---|---|
| currentUrl | string | Yes | URL currently open |
| inputUrl | string | Yes | Current address-bar text |
| viewMode | string | Yes | Either `browse` or `reader` |
| sidebarOpen | boolean | Yes | Whether the left library sidebar is currently expanded |

Example:

```json
{
  "currentUrl": "https://www.notion.com/notes",
  "inputUrl": "https://www.notion.com/notes",
  "viewMode": "reader",
  "sidebarOpen": false
}
```

## Agent Workflow

For simple navigation:

1. Read `meta.yaml`
2. Use `OPEN_URL`

For bookmark editing:

1. Read `meta.yaml`
2. Read this guide
3. Read existing files in `/bookmarks/`
4. Write or delete the target bookmark file in `apps/browser/data/bookmarks/{id}.json`
5. Dispatch `CREATE_BOOKMARK`, `DELETE_BOOKMARK`, or `REFRESH_DATA`

Notes:

- Only use full `http` or `https` URLs.
- History files are managed by the frontend; the Agent usually should not edit them.
- Reader mode content is generated live from the opened page and is not stored as separate files.
