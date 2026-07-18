# Aoi Desktop-Activity Capture Helper

Native (C++/Win32) producer for the host-bridge `desktop-activity` capability.
It watches the Windows **foreground window** and POSTs **metadata-only** samples
to the loopback Aoi daemon, which normalizes, redacts, consent-gates, and stores
them as a taste signal ("spends foreground time in Ghidra").

This is the missing piece: the daemon already exposes
`POST /api/aoi-host/desktop-activity`, but the browser cannot observe the real
desktop. This process is the only component that can, and it is deliberately
kept separate (crash isolation + privilege separation).

## Why native + event-driven

- Only a native process in the interactive session can read `GetForegroundWindow`.
- `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` is **event-driven**: it never misses
  a short foreground switch and costs ~0 CPU at idle (vs. a polling loop).
- A heartbeat timer (default 30 s) re-sends the current foreground so long,
  uninterrupted usage of one app is still reflected.

## What a sample contains (metadata only)

```json
{
  "sessionPath": "aoi/default",
  "captureWindowTitles": false,
  "sample": {
    "appName": "ghidra.exe",     // image BASENAME only, never a full path
    "focused": true,
    "idleMs": 1234,              // ms since last input
    "observedAt": 1699999999999 // epoch ms
  }
}
```

A `windowTitle` is included **only** with `--capture-titles`, and even then the
daemon drops or redacts it (emails / URLs / paths masked) unless the operator
turned on the window-title sub-toggle for the source.

## Safety model (enforced by the daemon; helper adds defense in depth)

The daemon returns **403** and stores nothing unless ALL of these hold:

1. **Auth token** — the helper reads `~/.openroom/host-bridge/auth-token`
   (owner-only file) and sends it as `x-aoi-host-bridge-token`. Proves the
   request came from the same OS user. Re-read automatically on a 401 (rotation).
2. **Kill-switch capability** `desktop_activity` is ON (default OFF).
3. **Consent** — the `desktop-activity` environment source is enabled for the
   session (default OFF, private, explicit-target).

So installing/running this helper alone captures nothing. You explicitly open the
door in the Aoi UI (or via the killswitch/consent endpoints) first.

Observed activity is an **observation-only signal**. Turning "uses Ghidra a lot"
into a stored preference still goes through the taste-poll / explicit
confirmation path -- implicit observation never auto-promotes a preference.

## Build

Requires MSVC (Visual Studio 2019/2022 or Build Tools, "Desktop development with
C++").

```powershell
./build.ps1              # release (/O2)
./build.ps1 -DebugBuild  # /Od /Zi
```

`build.ps1` uses `cl.exe` if it is on PATH, otherwise auto-locates Visual Studio
with `vswhere` and builds inside `vcvars64.bat`. Output: `aoi_desktop_capture.exe`.

If you prefer a manual build from an *x64 Native Tools Command Prompt*:

```bat
cl /nologo /W4 /EHsc /O2 /std:c++17 aoi_desktop_capture.cpp
```

(`winhttp.lib` / `user32.lib` are linked via `#pragma comment(lib, ...)`.)

## Verify before installing

The daemon must be running (`pnpm daemon:supervise` or the installed
`AoiAutonomyDaemon` task).

```powershell
# 1. Inspect the JSON that would be sent -- no daemon, no auth needed:
./aoi_desktop_capture.exe --once --dry-run

# 2. Post a single real sample (expect 403 until capability + consent are on,
#    then 200). Focus the app you want sampled first:
./aoi_desktop_capture.exe --once

# 3. With titles (still gated by the daemon sub-toggle):
./aoi_desktop_capture.exe --once --dry-run --capture-titles
```

Then read it back via the daemon summary route
(`GET /api/aoi-host/desktop-activity/summary?sessionPath=aoi/default`, with the
token header) or the Aoi UI.

## Install as a logon task

```powershell
./Install-AoiDesktopCapture.ps1                       # hidden, session aoi/default
./Install-AoiDesktopCapture.ps1 -CaptureTitles        # also send titles
./Install-AoiDesktopCapture.ps1 -Uninstall            # remove
```

Registers `AoiDesktopCapture`: starts at logon in the interactive user session,
runs hidden (`--hide-console`), restarts on crash. Start immediately with
`Start-ScheduledTask -TaskName AoiDesktopCapture`.

## CLI reference

| Flag | Default | Meaning |
|---|---|---|
| `--home <path>` | `%USERPROFILE%\.openroom` | host-bridge base (token lives under `<home>\host-bridge`) |
| `--session <path>` | `aoi/default` | consent scope |
| `--host <host>` | `127.0.0.1` | daemon host |
| `--port <n>` | `7333` | daemon port |
| `--heartbeat-ms <n>` | `30000` | periodic resend of current foreground; `0` disables |
| `--capture-titles` | off | include window titles (daemon still gates/redacts) |
| `--dry-run` | off | print the JSON body instead of POSTing |
| `--once` | off | capture a single sample and exit |
| `--hide-console` | off | hide the console window at startup (resident mode) |

Home resolution mirrors the daemon: `--home` wins; else the parent of
`AOI_DAEMON_SESSIONS_DIR`; else `%USERPROFILE%\.openroom`.

## Troubleshooting

- **Every post is 403** — the capability or the consent is still OFF. Expected
  until you enable both. This is the safety design, not a bug.
- **`no auth token ...`** — the daemon has not minted the token yet. Start the
  daemon; the helper retries for ~15 s at startup and again on each send.
- **`post failed (daemon unreachable?)`** — the daemon is not listening on the
  given host/port. Check `--port` and that the daemon is up.
- **`SetWinEventHook failed`** — the process is not in an interactive desktop
  session (e.g. launched from session 0). It must run as the logged-on user.
- **A console window flashes under the task** — confirm the task arguments
  include `--hide-console` (the installer adds it).
