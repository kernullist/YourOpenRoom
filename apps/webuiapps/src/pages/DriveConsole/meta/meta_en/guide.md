# Drive Console

Operator cockpit for browser driving.

## Scope, and what was deliberately left out

`components/ChatPanel/AoiHostBridgeSettingsPanel.tsx` already renders the browser-drive allowlist,
standing grants, approvals inbox, and audit configuration. Rebuilding those here would have been
duplication, so this app covers only what had **no UI at all**: the execute path.

`aoiHostBridgeClient.ts` had `fetchAoiHostBrowserDriveRead`, `...ActPreview`, `...ActExecute` and
`runAoiHostBrowserDriveTask` with zero callers — the approvals inbox was visible but there was
nowhere to create something to approve.

## The rule

**The judgement happens while the plan is written, not when it runs.**

`classifyAoiBrowserDrivePlan` is a pure function and both modules behind it
(`aoiBrowserDrivePlan`, `aoiBrowserDriveAction`) are free of node dependencies, so the console
classifies every step **on each keystroke** — no server round-trip. Each step shows as read /
needs-approval / blocked with the reason, while the plan can still be changed.

> `aoiBrowserDriveAllowlist.ts` uses node `fs` and must never be imported here — it would break
> `pnpm build` while leaving typecheck and vitest green. Allowlist data comes over HTTP instead.

### Field metadata is recovered from the selector

The hard block on credential/payment/OTP fields keys off structured `field` metadata, not the
selector string. A hand-written plan only has a selector, so `inferFieldFromSelector` reads
`[type=…]`, `[name=…]`, `[autocomplete=…]` and `#id` out of it. Without that, a step typing into
`input[type=password]` would classify as a routine act needing approval, and the block would only
appear at execute time — the console would under-warn about the one thing it most needs to catch.
Explicit operator entries always win over what the selector implies.

## The three-step loop

```
propose (preview)  → records a PENDING approval, returns its fingerprint. Nothing is driven yet.
      ↓
operator approves  ← Settings > Host Bridge approvals inbox
      ↓
execute            → runs that ONE act. 403 without a human-approved single-use entry.
```

The console shows all three and **never approves on the operator's behalf** — the handoff line to
the approvals inbox is prominent rather than tucked away, because a UI that quietly approved its own
preview would collapse the loop into one step and make the whole gate chain decorative.

## Four outcomes, kept apart

| State | Means | Reaction |
|---|---|---|
| `empty` | nothing recorded yet | none |
| `unconfigured` (401) | the bridge token was never created | set it up — nothing is broken |
| `denied` (403) | request was fine, approval is missing | approve it — the system is working |
| `error` | something is actually wrong | investigate |

Collapsing `unconfigured` into `error` would send someone debugging a feature they simply have not
switched on. The dev server mounts the bridge with `trustLoopbackToken: true`, so the browser never
needs to hold a token itself.

## Actions

| Action | Params | Behavior |
|---|---|---|
| `SELECT_DRIVE_CONSOLE_VIEW` | `view` | Switch section; error on an unknown view |
| `REFRESH_DRIVE_CONSOLE` | — | Re-read the audit trail |
| `SYNC_STATE` | — | Re-read `state.json` defensively |

**Not exposed:** `PREVIEW_DRIVE_STEP`, `EXECUTE_DRIVE_STEP`, `APPROVE_DRIVE_STEP`,
`RUN_DRIVE_TASK`, `READ_DRIVE_PAGE`. This console belongs to the operator; Aoi drives through its
own tool path, which passes the same gates.

## Audit

Rows surface `viaStanding` prominently: a standing grant means nobody approved that act
individually, which is exactly what someone reviewing the trail afterwards is looking for.

## State

`apps/driveconsole/data/state.json` — `activeView`, `sessionPath`, `targetUrl`, `draft`,
`selectedStepIndex`. Checked with `listFiles('/')` before the first read and created with defaults
when absent; `mergeDriveConsoleState` merges field by field so a partial write cannot wipe an
in-progress plan.
