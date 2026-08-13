# Host Sentinel

Process watch for the real machine, with a kill path that goes through approval.

## Scope

`AoiHostBridgeSettingsPanel` already renders bridge status, spawn allowlist, roots and approvals, so
none of that is repeated here. What had no UI at all was `fetchAoiHostProcesses` (zero callers) and
the kill routes — `/kill/preview` and `/kill/execute` had no client functions either, so they were
added to `aoiHostBridgeClient` alongside the existing ones.

## The rule

**A process list is a photograph, not a feed.**

The sample age is always shown and goes amber past 30 seconds. That is not decoration: a kill
request carries a **pid**, pids get reused, and acting on a stale row is exactly how the wrong
process gets terminated. Refusing to say how old the sample is would hide the one fact that makes
the difference.

For the same reason a missing memory reading renders as `-`, never `0 MB`, and sorts to the bottom
of a biggest-first list rather than into the "uses nothing" slot — an absent measurement is not a
measurement of zero.

## Kill loop

```
propose (preview)  → records a PENDING approval; kills nothing
      ↓
operator approves  ← Settings > Host Bridge approvals inbox
      ↓
execute            → 403 without a human-approved single-use entry
```

The console never approves on the operator's behalf.

### About `killAllowlistImages`

That field is **caller-declared** — the server has no list of killable images to consult, and the
real guard is its protected-process list. So the app declares exactly the image being acted on, at
the moment of acting, and says plainly in the UI that this is not a security boundary. Presenting a
caller-supplied list as if it were a gate would be the more dangerous kind of wrong.

An earlier draft of this app populated it from the **spawn** allowlist. That was a conceptual error:
spawn entries are executable _paths_ to launch, not image names to terminate. It was removed rather
than mapped.

## Panic

When the bridge reports `killSwitch.globalPanic`, a banner states it above the table — every control
below is inert, and discovering that by clicking one would be worse.

## Four outcomes, kept apart

`unconfigured` (401, the bridge token was never created — setup, not failure), `denied` (403, the
request was fine and an approval or policy said no — the system working), `error`, and the plain
"enter a sessionPath" idle state.

## Actions

| Action                  | Params   | Behavior                         |
| ----------------------- | -------- | -------------------------------- |
| `FILTER_HOST_PROCESSES` | `query?` | Set the image/pid filter         |
| `REFRESH_HOST_SENTINEL` | —        | Take a fresh sample              |
| `SYNC_STATE`            | —        | Re-read `state.json` defensively |

**Not exposed:** `PREVIEW_HOST_KILL`, `EXECUTE_HOST_KILL`, `APPROVE_HOST_KILL`,
`SET_HOST_KILLSWITCH`, `CLEAR_HOST_PANIC`.

## Not covered yet

Desktop-activity (`/desktop-activity`, `/desktop-activity/summary`) and screen-vision
(`/screen-vision`) still have no client functions and no UI. They were left out of this pass rather
than half-built.

## State

`apps/hostsentinel/data/state.json` — `query`, `sort`, `sessionPath`.
