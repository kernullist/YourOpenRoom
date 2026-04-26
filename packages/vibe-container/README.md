# @gui/vibe-container

Shared types and standalone stub package for the YourOpenRoom runtime.

## What This Package Is In This Fork

In the current standalone browser app, this package is **not** the active runtime implementation.

`apps/webuiapps/vite.config.ts` aliases `@gui/vibe-container` to:

```ts
resolve: {
  alias: {
    '@gui/vibe-container': resolve(__dirname, './src/lib/vibeContainerMock.ts'),
  },
}
```

That mock handles:

- app lifecycle handshake no-ops
- local event-bus based agent/app communication
- file access through the session-data API
- OS-level actions such as opening apps and changing wallpaper

## Why This Package Still Exists

The package is still useful because it keeps:

- shared type definitions
- the public import shape expected by app pages
- a documented separation between client-side app code and the standalone mock runtime

## Files

| Path | Role |
| --- | --- |
| `index.ts` | Public entry point |
| `src/types/index.ts` | Shared runtime types |
| `src/clientComManager/index.ts` | Client-side manager shape |
| `src/parentComManager/index.ts` | Parent-side manager stub |
| `src/utils/index.ts` | Small shared helpers |

## Practical Takeaway

You do **not** build or run this package separately for local development.

If you are working on the standalone desktop:

- edit `apps/webuiapps/src/lib/vibeContainerMock.ts` for runtime behavior
- edit this package only when you need to change shared interfaces or keep imports aligned
