# Written By Me Data Guide

## Runtime

Written By Me is loaded from `F:/kernullist/written-by-me` through the in-app bridge:

- Static frame: `/written-by-me/`
- API bridge: `/api/written-by-me/*`
- Upload temp files: `F:/kernullist/written-by-me/uploads/*`
- Generated output: `F:/kernullist/written-by-me/output/*.md`

The bridge rewrites the original app's `/api/*` calls into the namespaced in-app API, so it does not
collide with other YourOpenRoom tools.

## AOI Main LLM

Analysis and translation requests use the AOI main model configured in `Settings > Models`. The
bridge reads `~/.openroom/config.json`, supports the same provider/model route used by the chat
panel, and does not require `F:/kernullist/written-by-me/.env` API credentials.

## Agent Workflow

1. Use `CHECK_WRITTEN_BY_ME_STATUS` when the app does not appear to load or model calls fail.
2. Use `REFRESH_WRITTEN_BY_ME` after source files or AOI model settings have changed.
3. Use `OPEN_WRITTEN_BY_ME_EXTERNAL` only when the user wants a normal browser tab.

## Storage Notes

Uploads are temporary and can be cleared with the app's `Start New Analysis` flow. Generated
`Skill.md` files are written to the original Written By Me `output/` directory so existing local
workflows can still inspect or archive them.
