# YouTube App Data Guide

## Folder Structure

```text
/
└── state.json
```

## State File `/state.json`

This app is a YouTube search launcher. It does not maintain song or playlist files. Everything it
needs is stored in `state.json`.

| Field           | Type          | Default         | Description                                                                                |
| --------------- | ------------- | --------------- | ------------------------------------------------------------------------------------------ |
| searchQuery     | string        | `""`            | Current search keyword                                                                     |
| recentSearches  | SearchEntry[] | `[]`            | Recent YouTube searches                                                                    |
| favoriteTopics  | string[]      | pre-seeded list | Saved one-click topics                                                                     |
| sidebarOpen     | boolean       | `false`         | Whether the left saved-topics sidebar is expanded                                          |
| resultsAutoHide | boolean       | `false`         | Whether the in-app search results list should automatically collapse after picking a video |
| loopPlayback    | boolean       | `false`         | Whether the in-app player should loop the currently selected video                         |
| playerZoom      | number        | `1`             | The current in-app player zoom factor, where `1` means 100%                                |

### SearchEntry

| Field     | Type   | Description               |
| --------- | ------ | ------------------------- |
| id        | string | Unique search entry ID    |
| query     | string | Search query text         |
| createdAt | number | Timestamp in milliseconds |

Example:

```json
{
  "searchQuery": "IVE I AM",
  "recentSearches": [
    {
      "id": "search_1776200000000",
      "query": "IVE I AM",
      "createdAt": 1776200000000
    }
  ],
  "favoriteTopics": ["lofi hip hop", "deep focus music", "IVE I AM"],
  "sidebarOpen": false,
  "resultsAutoHide": false,
  "loopPlayback": false,
  "playerZoom": 1
}
```

## Agent Workflow

For normal operation:

1. Read `meta.yaml`
2. Read this guide
3. Use `OPEN_SEARCH` with the exact song, artist, or topic query
4. Use `OPEN_VIDEO` when you already have a direct YouTube watch URL
5. Optionally use `OPEN_HOME` to open the YouTube home page

Notes:

- If the user agrees to play a recommended song, search the full artist + song title together.
- If you already have a concrete YouTube link, prefer `OPEN_VIDEO` over a fresh search.
- The app itself manages recent searches and saved topics in `state.json`.
