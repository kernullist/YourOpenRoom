# Habit Garden

Habits as plants. One click a day.

## What it is for

A habit tracker fails the moment it becomes a spreadsheet. The apps that work (Finch, First
Voyage) put a thing to care for on screen and let the user move for its sake rather than their
own. So the first screen here is a garden, not a statistic — numbers exist, but you have to go
looking for them.

## Rules the UI keeps

- **Check-in is one click, with no confirmation, and the same click undoes it.** Every bit of
  friction converts directly into skipped days.
- **A lapse never kills a plant.** Growth stage is accumulated achievement and only moves with the
  streak; vitality is recent condition. A 12-day habit missed twice is a *wilting bud*, not a seed.
- **Today being unchecked does not break a streak.** The day is not over. Showing an 8-day streak
  as 0 at 10am would be both demoralizing and wrong.
- **A young garden gets no weather verdict.** Below 3 days of history the strip says so instead of
  declaring rain.

## Dates

Every completion is stored as a **local day key** (`YYYY-MM-DD`) written at check-in time. Nothing
downstream re-derives a date from a timestamp. That removes three separate bugs at once: a 01:00
check-in landing on the previous UTC day, the daemon disagreeing with the browser because its
process timezone differs, and DST or travel retroactively relocating history.

`shiftDayKey` anchors at local **noon** rather than midnight, because on a spring-forward date
local midnight can be a time that does not exist.

## Growth

| Streak | Stage |
|---|---|
| 0 | seed |
| 1–2 | sprout |
| 3–6 | leaf |
| 7–20 | bud |
| 21+ | bloom |

Thresholds are the first hurdle, one week, and the popular habit-formation figure — spaced so the
next stage always looks reachable, not because 21 is a scientific claim.

Vitality is separate: `thriving` (done today, or one day out), `ok` (two days), `wilting` (three
or more, or never done).

**Weekly cadence counts weeks, not days.** A perfect Mon/Wed/Fri week under "3 times a week" would
read as a 1-day streak if counted daily, so the unit matches the commitment. An in-progress week
neither counts toward the run nor breaks it.

## Weather

Adherence across the whole garden over the last 7 days: `>= 0.8` sunny, `>= 0.5` cloudy, below
that rain, and `unknown` under 3 days of history. Weekly habits scale their expected count, so
"3 a week" done 3 times reads as full adherence rather than 3/7.

## Aoi integration

When **Aoi에게 습관 흐름 공유** is on (default on), the garden's recent trend is summarized to one
of `growing` / `steady` / `slipping` and passed to Aoi's mood derivation.

It is a **trend, not a level**, deliberately: someone climbing out of a rough patch should not be
met with concern, and someone falling from near-perfect is slipping even at a respectable number.

Three constraints hold this in place:

1. **Expression only.** `AoiMoodState` is `actionAuthority: 'display_only'` with `mutationCount: 0`
   by type. Habit momentum sits at the bottom of the mood precedence ladder, so it colours an
   otherwise neutral mood and never overrides a real work signal — a slipping week cannot turn into
   worry while actual work is going fine, which would read as nagging.
2. **Never near a gate.** `aoiMoodGateIntegrity.test.ts` scans the eight gate modules for both mood
   *and* habit references. Blocking mood while leaving its inputs unguarded would just move the hole
   sideways.
3. **Three values, nothing more.** `lib/habitGardenMomentum.ts` (server-only, uses node `fs`)
   summarizes on the server; the raw habit log never enters the autonomy store. It returns `null` —
   not `steady` — when there is no garden, so no claim is made about someone who does not use the app.

The day key comes from the client in the `session-open` request body, because only the browser knows
the user's local calendar day. A missing or malformed key skips the input rather than guessing.

## Room reflection

Optional, **default off**. Missing a habit must not silently repaint someone's desktop.

| Weather | Room item |
|---|---|
| rain | `rainy-window-desk` |
| cloudy | `lofi-cafe-night` |
| sunny | `pixel-arcade` |
| unknown | nothing applied |

It applies **only when the weather changes** (`lastAppliedWeather` guard) — otherwise every poll
would overwrite a theme the user just picked in RoomShop, and the desktop would appear to reject
their choice. Turning the toggle on records the current room item so turning it off restores it.

Writes go through RoomShop's own `createAppliedRoomThemeState` + `persistRoomThemeState` path, not
by touching the theme key directly. The Shell picks the change up across the iframe boundary via the
`storage` event.

## Actions

| Action | Params | Behavior |
|---|---|---|
| `CHECK_IN_HABIT` | `habitId`, `dayKey?` | Idempotent completion |
| `UNDO_HABIT_CHECK_IN` | `habitId`, `dayKey?` | Remove a completion |
| `CREATE_HABIT` | `name`, `cadence?`, `timesPerWeek?` | Plant a habit |
| `UPDATE_HABIT` | `habitId`, `name?`, `cadence?`, `timesPerWeek?` | Rename / re-cadence |
| `DELETE_HABIT` | `habitId` | Remove habit and history |
| `SELECT_HABIT` | `habitId` | Open detail |
| `REFRESH_HABIT_GARDEN` | `habitId?` | Reload, optionally focus |
| `SYNC_STATE` | — | Re-read `state.json` defensively |

**Not exposed, on purpose:** `SET_GARDEN_SETTINGS`, `SET_REFLECT_WEATHER_IN_ROOM`,
`SET_SHARE_MOMENTUM_WITH_AOI`. Writes to habits are the user's own record; the consent switches are
not.

## Storage

`apps/habitgarden/data/habits/{id}.json`

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | |
| `name` | `string` | ≤ 40 chars |
| `cadence` | `{kind:'daily'} \| {kind:'weekly',timesPerWeek:1-7}` | |
| `color` | `string` | design token |
| `createdAt` / `updatedAt` | `number` | |
| `checkIns` | `DayKey[]` | Order **not** guaranteed; normalized to a Set on read. Trimmed to the most recent 400 on write |
| `archived` | `boolean?` | |

`apps/habitgarden/data/state.json`

| Field | Type | Default |
|---|---|---|
| `activeTab` | `'garden' \| 'settings'` | `'garden'` |
| `selectedHabitId` | `string \| null` | `null` |
| `reflectWeatherInRoom` | `boolean` | `false` |
| `shareMomentumWithAoi` | `boolean` | `true` |
| `restoreRoomItemId` | `string \| null` | `null` |
| `lastAppliedWeather` | `string \| null` | `null` |

`state.json` is checked with `listFiles('/')` before the first read and created with defaults when
absent. `mergeHabitGardenState` merges field by field so a partial write cannot flip a consent
switch back to its default.

## Layout

Width comes from a `ResizeObserver` on the root element, not viewport media queries — the app runs
in an iframe. Breakpoints: `compact` (<600px, 2 columns), `regular` (<1200px, 4), `expanded` (6).
The check-in bar scrolls sideways and is never hidden at any width; it is the one thing this app
needs the user to be able to do.

The root reserves a 72px bottom strip (`--hg-dock-safe-area`). The shell's desktop dock is
`position: fixed; bottom: 16px; z-index: 99999`, so in a maximized window it draws over the app's
bottom edge and swallows clicks there. For most apps that is cosmetic; here it would cover the
check-in bar, so the strip is reserved rather than lost.
