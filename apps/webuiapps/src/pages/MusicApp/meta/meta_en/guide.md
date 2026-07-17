# YouTube App Data Guide

## Folder Structure

```text
/
└── state.json
```

## State File `/state.json`

This app is a YouTube search launcher with in-app playlists. It does not maintain separate song or
playlist files. Everything it needs is stored in `state.json`.

| Field                  | Type          | Default            | Description                                                                                |
| ---------------------- | ------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| searchQuery            | string        | `""`               | Current search keyword                                                                     |
| recentSearches         | SearchEntry[] | `[]`               | Recent YouTube searches                                                                    |
| favoriteTopics         | string[]      | pre-seeded list    | Saved one-click topics                                                                     |
| playlists              | Playlist[]    | one empty playlist | In-app playlists holding saved videos                                                      |
| activePlaylistId       | string\|null  | default playlist   | The playlist currently selected for editing/adding                                         |
| lastPlayedPlaylistId   | string\|null  | `null`             | The playlist most recently played as a queue                                               |
| lastPlayedPlaylistMode | string\|null  | `null`             | Last used queue mode: `"sequential"` or `"shuffle"`                                        |
| sidebarOpen            | boolean       | `false`            | Whether the left saved-topics sidebar is expanded                                          |
| resultsAutoHide        | boolean       | `false`            | Whether the in-app search results list should automatically collapse after picking a video |
| loopPlayback           | boolean       | `false`            | Whether the in-app player should loop the current video or queue                           |
| playerZoom             | number        | `1`                | The current in-app player zoom factor, where `1` means 100%                                |
| nowPlaying             | NowPlaying\|null | `null`          | Snapshot of the video currently loaded in the in-app player; `null` when nothing plays     |

### SearchEntry

| Field     | Type   | Description               |
| --------- | ------ | ------------------------- |
| id        | string | Unique search entry ID    |
| query     | string | Search query text         |
| createdAt | number | Timestamp in milliseconds |

### Playlist

| Field     | Type           | Description                        |
| --------- | -------------- | ---------------------------------- |
| id        | string         | Unique playlist ID                 |
| name      | string         | Playlist display name              |
| items     | PlaylistItem[] | Saved videos in playlist order     |
| createdAt | number         | Timestamp in milliseconds          |
| updatedAt | number         | Timestamp of the last modification |

### PlaylistItem

A saved YouTube search result. Fields: `id` (YouTube video id), `title`, `channel`, `duration`,
`views`, `published`, `thumbnail`, `url`, plus `addedAt` (timestamp in milliseconds).

### NowPlaying

The video currently loaded in the in-app player. The app rewrites this field on every playback
change — including queue auto-advance — and clears it to `null` when the viewer closes. The app
owns this field: values written by the Agent are overwritten by the live player state, so treat it
as read-only. Use `updatedAt` as the freshness signal; a stale timestamp means the app went away
mid-playback and the claim must not be treated as live.

| Field     | Type         | Description                                                    |
| --------- | ------------ | -------------------------------------------------------------- |
| videoId   | string       | YouTube video id currently in the player                       |
| title     | string       | Video title as shown in the player header                      |
| channel   | string       | Channel name of the current video                              |
| queueName | string\|null | Playlist name when playing as a queue, `null` for single plays |
| startedAt | number       | Timestamp (ms) when this video started playing                 |
| updatedAt | number       | Timestamp (ms) of the last playback-state refresh              |

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
5. Use `PLAY_LAST_PLAYLIST` to resume the most recently played playlist queue
6. Optionally use `OPEN_HOME` to open the YouTube home page
7. After writing `state.json` directly, send `SYNC_STATE` so the app reloads it

Notes:

- If the user agrees to play a recommended song, search the full artist + song title together.
- To auto-start the top result instead of only cueing it, pass `autoplay: "1"` to `OPEN_SEARCH`.
- `OPEN_VIDEO` starts playback automatically; pass `autoplay: "0"` to only cue the video.
- If you already have a concrete YouTube link, prefer `OPEN_VIDEO` over a fresh search.
- The app itself manages recent searches, saved topics, and playlists in `state.json`.

## In-App Player Behavior

- Clicking a result or playlist item in the app starts playback immediately.
- During playlist queue playback, clicking another queue entry jumps to it without reshuffling the
  queue or reloading the player.
- Toggling loop, zoom, or the results list never reloads the player iframe.
- The player popup is closed only by its close button or the Escape key.
