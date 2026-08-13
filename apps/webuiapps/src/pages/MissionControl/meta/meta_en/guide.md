# Mission Control

Operator console for Aoi's autonomy runtime.

## What it is for

The autonomy stack is large and mostly invisible: a background daemon, a per-session policy, a
proposal queue, a timeline, a flight recorder, and a set of closed-loop metrics. Before this app
there was no way to tell a healthy loop from a wedged one. Mission Control is a dashboard over
machinery that already exists — it adds one server route and otherwise renders existing modules.

## Design rule

**Uncertainty is displayed as uncertainty.**

- A panel distinguishes `loading` / `empty` / `error` / stale. An empty result and a failed read
  never look the same.
- Daemon status keeps all four states (`running`, `not_running`, `unreachable`, `probe_failed`).
  `unreachable` and `probe_failed` mean the loop state is unknown and are never coloured as healthy.
- A metric whose sample size is below `minSample` renders as "표본 부족 (n/minSample)", never as 0%.
- A stale panel keeps showing its last good data with a warning, rather than blanking.

## Sections

| Section         | Shows                                                                          | Source                                                                                           |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Runtime         | Daemon health, autonomy policy, unified snapshot, scheduler, manual tick       | `/api/aoi-daemon/health`, `/api/aoi-autonomy/status`, `/operator/unified-snapshot`, `/scheduler` |
| Queue           | Active proposals with an inspector and accept / snooze / dismiss               | `/api/aoi-autonomy/proposals`, `/proposal/decision`                                              |
| Timeline        | Operator timeline events, filterable by kind, expandable to raw payload        | `/api/aoi-autonomy/timeline`                                                                     |
| Flight Recorder | Decision lane, source freshness, approval state, hard-fail counters, redaction | `/api/aoi-autonomy/flight-recorder`                                                              |
| Metrics         | Closed-loop precision / success / recall quality, overall and per capability   | `/api/aoi-autonomy/decisions` + `/outcomes`, assembled with `buildAoiClosedLoopMetrics`          |

Closed-loop metrics have no route of their own. `buildAoiClosedLoopMetrics` is a pure function and
both of its inputs are already served, so the console composes them client-side rather than
reimplementing the calculation the gates use. If either read fails, the panel reports the failure
instead of computing a number from half the evidence.

## Sessions

Every `/api/aoi-autonomy/*` route requires a `sessionPath`, and an app iframe cannot read the host's
in-process session holder. `GET /api/aoi-autonomy/sessions` (added with this app) answers without
one, listing sessions that have an initialized autonomy store, newest first. The console defaults to
the newest and lets the operator pin another. Zero sessions is reported as a normal state, not an
error.

## Safety boundary

Mission Control can approve proposals, change nothing about the policy, and run a manual tick — all
from operator clicks only.

**The agent action surface is read and navigation only.** `APPROVE_PROPOSAL`, `EXECUTE_PROPOSAL`,
`SET_AUTONOMY_POLICY`, and `RUN_TICK` are deliberately absent. Aoi accepting its own proposals
through its own console would bypass the no-self-approval invariant that the autonomy model enforces
structurally (L5 is unreachable by auto-promotion; promotion writes throw for any actor other than
`user`). The decision path is wired to DOM handlers and is never reachable from the action listener;
`__tests__/actionSafety.test.ts` fails if that changes.

Every decision is posted with `actor: 'user'`.

## Actions

| Action                           | Params        | Behavior                                                           |
| -------------------------------- | ------------- | ------------------------------------------------------------------ |
| `REFRESH_MISSION_CONTROL`        | `view?`       | Re-read sessions, strip panels, and the current (or given) section |
| `SELECT_MISSION_CONTROL_VIEW`    | `view`        | Switch section; error on an unknown view                           |
| `SELECT_MISSION_CONTROL_SESSION` | `sessionPath` | Switch observed session; error if not in the discovered list       |
| `SYNC_STATE`                     | —             | Re-read `state.json` and apply fields defensively                  |

## State

`apps/missioncontrol/data/state.json`

| Field                | Type                                                          | Default     | Notes                                                      |
| -------------------- | ------------------------------------------------------------- | ----------- | ---------------------------------------------------------- |
| `version`            | `1`                                                           | `1`         |                                                            |
| `activeView`         | `'runtime' \| 'queue' \| 'timeline' \| 'flight' \| 'metrics'` | `'runtime'` |                                                            |
| `sessionPath`        | `string \| null`                                              | `null`      | `null` means follow the newest session rather than pin one |
| `autoRefresh`        | `boolean`                                                     | `true`      |                                                            |
| `refreshIntervalMs`  | `number`                                                      | `10000`     | One of 5000, 10000, 30000                                  |
| `timelineKindFilter` | `string \| null`                                              | `null`      |                                                            |
| `selectedProposalId` | `string \| null`                                              | `null`      |                                                            |

The file is checked with `listFiles('/')` before the first read and created with defaults when
absent. `SYNC_STATE` merges field by field, so a partial write cannot reset the operator's session
selection.

## Polling

- Default 10s, pausable from the strip, with a manual refresh button.
- Only the current section's panels are polled; the status strip is polled regardless of section.
- Polling stops while the window is hidden.
- Concurrent reads of the same panel **and session** are suppressed so a slow response cannot
  install data older than what is already on screen. The guard is keyed by session, not just by
  panel: keying it by panel alone let an in-flight read for session A starve the switch to session
  B, and then A's response rendered under B's label. Results are also dropped on arrival if the
  observed session moved on while the request was out.

## Layout

Width comes from a `ResizeObserver` on the root element, not from viewport media queries — the app
renders in an iframe whose size is unrelated to the browser window. Breakpoints are `compact`
(<600px), `regular` (<1200px), and `expanded`. The status strip simplifies but never hides; the rail
collapses to icons while keeping the pending-proposal badge.
