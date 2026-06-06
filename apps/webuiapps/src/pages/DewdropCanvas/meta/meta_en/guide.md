# Dewdrop Canvas Data Guide

## Runtime

Dewdrop Canvas is loaded from `F:/kernullist/dewdrop-canvas` through the in-app bridge:

- Static frame: `/dewdrop-canvas/`
- API bridge: `/api/dewdrop-canvas/*`
- Project data: `F:/kernullist/dewdrop-canvas/data/projects/*.json`

The bridge rewrites the original app's `/api/*` calls into the namespaced in-app API, so it does
not collide with other YourOpenRoom tools.

## Agent Workflow

1. Use `CHECK_DEWDROP_CANVAS_STATUS` when the app does not appear to load.
2. Use `REFRESH_DEWDROP_CANVAS` after source files or project data have changed.
3. Use `OPEN_DEWDROP_CANVAS_EXTERNAL` only when the user wants a normal browser tab.

## Storage Notes

Projects remain in the original Dewdrop Canvas folder. The in-app bridge creates
`data/projects/` and `data/last_active.json` on demand, matching the source app's local server
behavior.
