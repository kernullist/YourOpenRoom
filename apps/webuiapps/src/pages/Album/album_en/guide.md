# Album Data Guide

Album is a local photo browser. It can read legacy image metadata from app storage, but the primary
user flow is now selecting a local folder from the UI or saving an absolute folder path in
configuration.

## Folder Structure

```text
/
└── images/                # Legacy image metadata directory
    ├── {id}.json          # Single image metadata
    └── ...
```

## Local Folder Source

Album can load photos from a local directory in two ways:

- the user clicks **Choose folder** and grants browser directory access for the current session
- the user saves an absolute folder path, which is persisted as `album.photoDirectory` in
  `~/.openroom/config.json`

The Vite middleware reads the saved folder path and returns supported image files. The frontend then
shows search, sort, grid density, folder counts, latest modified time, and a preview panel.

Supported file extensions are handled by the local Album API and should remain image-only. Agents
should not write arbitrary files into user photo folders.

## Legacy Image Directory `/images/`

Older sessions may still contain generated image metadata in `/images/`. Each image has a separate
JSON file, named by image ID.

- The frontend can still read these records as gallery items.
- New user-facing Album browsing is folder-based; prefer updating `album.photoDirectory` instead of
  adding generated metadata files for local photo collections.

### Image File `{id}.json`

| Field     | Type    | Required | Description                                                               |
| --------- | ------- | -------- | ------------------------------------------------------------------------- |
| id        | string  | Yes      | Unique image identifier, matches the filename without `.json` extension   |
| src       | string  | Yes      | Image URL: data URL such as `data:image/png;base64,...` or an `https` URL |
| name      | string  | No       | Display filename                                                          |
| createdAt | integer | Yes      | Creation timestamp in milliseconds                                        |
| size      | number  | No       | File size in bytes, when known                                            |
| folder    | string  | No       | Folder label shown in the gallery                                         |

Example:

```json
{
  "id": "img-001",
  "src": "data:image/jpeg;base64,/9j/4AAQ...",
  "name": "portrait.jpg",
  "folder": "portraits",
  "createdAt": 1706000000000,
  "size": 245760
}
```

## Data Synchronization

### Agent Operations

If an agent changes Album app-storage files, dispatch `REFRESH`. If the goal is to change the local
folder source, update the persisted runtime config through the config API rather than writing into
`/images/`.

### User Operations

Users can browse folders, search by filename/folder/date, sort by newest/oldest/name/folder, adjust
grid density, and open a preview. Selecting a folder through the browser picker is session-scoped;
saving an absolute path makes Album reopen that folder after restart.
