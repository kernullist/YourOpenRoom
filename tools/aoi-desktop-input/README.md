# Aoi Desktop-Input Helper

Native (C++/Win32 + UI Automation) helper that lets Aoi **act on** the Windows
desktop: enumerate windows, snapshot a window's interactable elements, and drive
one of them.

Aoi could already *see* the desktop (`aoi-desktop-capture` for activity,
screen-vision for pixels) but had no way to touch it. This is the acting half.
It is the desktop counterpart of the browser-drive executor and speaks the
**same verdict vocabulary**, so both surfaces answer the one question that
matters: *did the action actually happen?*

Like the capture helper, it is deliberately a separate process (crash isolation
+ privilege separation), but where that one is a resident producer that pushes,
this is a **one-shot command executor**: read one JSON command, write one JSON
result, exit. There is no resident input capability sitting around waiting to be
driven.

## The verdict contract

Every acting command answers with the same shape:

```json
{ "ok": true, "effect": "confirmed", "verified": true, "path": "uia_value", "detail": "..." }
```

| Field | Meaning |
|---|---|
| `ok` | **Transport**: the command ran without erroring. Says nothing about effect. |
| `effect` | `confirmed` \| `unverifiable` \| `suspected_noop` — did it land? |
| `verified` | `true` **only** when a value was read back off the live element. |
| `path` | Which rung actually ran: `uia_invoke` / `uia_value` / `sendinput`. |
| `code` | On refusal: why it refused (see below). |

Transport success without semantic proof is not proof of effect. A helper that
returned only `ok` would let Aoi say "I clicked it" whenever the call didn't
throw, which is precisely the failure this contract exists to remove.

## Actions

| Op | What it does |
|---|---|
| `list_windows` / `list_apps` | Discovery. Read-only. |
| `snapshot` | Interactable controls, each with a ref valid for that snapshot only. |
| `invoke` | Press a control through UI Automation. |
| `set_value` | Replace a field's text, **verified by read-back**. |
| `select` | Choose a dropdown option by label, **verified**. |
| `toggle` | Set a checkbox to `on`/`off` (idempotent), **verified**. |
| `scroll` | Scroll a control, **verified** by reading the position back. |
| `click` | Right / middle / double click, or held modifiers. |
| `key` | A keystroke or combo (`ctrl+s`, `tab`, `f5`). |
| `type` | Free text at the caret. |
| `drag` | Drag between two controls. Foreground only. |
| `focus` | Raise a window. Persistent, so it is its own call. |
| `capture` | A picture of the window, controls outlined and numbered. |

## Delivery ladder

1. **UIA pattern** (`InvokePattern`, `ValuePattern`, `SelectionItemPattern`,
   `TogglePattern`, `ScrollPattern`). Does *not* move the cursor or steal focus,
   the API reports whether it worked, and for several of these the result can be
   read back — so this rung can return `effect: confirmed`.
2. **Background messages** posted straight to the target window. Still no focus
   steal and no cursor movement, but nothing reports whether the app acted, so
   it is `unverifiable`. Many Win32 apps accept these; Chromium/Electron and
   DirectInput games often ignore them, and that is **not predictable from the
   app** — it has to be attempted and then checked.
3. **SendInput**, only with `--allow-foreground`. Real input: takes focus, moves
   the cursor, equally unverifiable. Restores the window the operator was
   actually on afterwards.

A rung that cannot run says so with a code instead of silently escalating.
Escalating to real input is a decision for the operator, not a fallback the
helper takes on its own — and a modifier combo, which the background rung
genuinely cannot deliver, is refused rather than sent without its modifiers.

`verified: true` is earned only by reading state back off the live control:
`set_value`, `select`, `toggle` and `scroll` can reach it. An `invoke` is
`confirmed` when UIA reports the pattern succeeded. Everything on rungs 2 and 3
tops out at `unverifiable`, by construction.

## Refusal codes

| Code | Meaning |
|---|---|
| `element_forbidden` | Password/credential field. Never invoked, never typed into. |
| `element_disabled` | The control is disabled; acting on it would do nothing. |
| `element_ref_stale` | The window changed since the snapshot — take a fresh one. |
| `element_ref_unknown` | Ref out of range for that snapshot. |
| `uia_unsupported` | No usable pattern; pass `--allow-foreground` for rung 2. |
| `foreground_denied` | Windows refused to bring the window forward — see below. |
| `element_obscured` | Another window covers the click point. |
| `element_not_on_screen` | The element has no usable on-screen rectangle. |
| `input_blocked` | `SendInput` was blocked (UIPI / higher-privilege window). |
| `modifiers_need_foreground` | A held modifier cannot be posted; needs rung 3. |
| `bad_key_combo` | The combo named no usable key. |
| `option_not_found` / `option_ambiguous` | No option with that label, or more than one. |
| `no_automation_tree` | (snapshot note) The window exposes nothing to UIA at all. |
| `window_not_found` | The handle is not a live window. |

A refusal always reports `effect: suspected_noop`, never a claimed effect, and
in the SendInput rung a refusal means **no input was synthesized at all**.

### Why `foreground_denied` exists

Windows routinely refuses a foreground change requested by a background process
— it flashes the taskbar instead. The daemon spawns this helper from the
background, which is exactly that case, and it is not deterministic: the test
suite has seen the same call granted on one run and refused on the next.

Clicking anyway is the dangerous option. The coordinates belong to the target
element, but if the target never came forward those coordinates now belong to
whatever window IS in front — so Aoi would deliver a real click to something
nobody asked about. The helper therefore confirms it actually got the foreground
(and that the click point is not covered) and refuses otherwise.

Absolute mouse coordinates are normalized across the **virtual** screen, whose
origin is negative when a monitor sits left of or above the primary one. That
origin is included; dropping it puts the click on the wrong monitor while
`SendInput` still reports success.

### Capture is its own capability

Every other op returns the *names* of controls. `capture` returns a picture of
whatever is on the window — a document, a chat, an account page — and there is
no redacting pixels. It is gated by `os_desktop_capture`, separate from
`os_desktop_input`, so turning on desktop input does not quietly grant it. No
image is written to disk: the PNG exists in memory and leaves over stdout.

`PrintWindow` asks the window to draw itself rather than copying the screen, so
a window behind others captures correctly and nothing the operator is looking at
is disturbed. Some GPU-composited surfaces (games, hardware video) return a
blank frame; that is reported as `capture_blank` rather than handed over as a
black rectangle the model would describe as an empty window.

The numbers drawn on the image are the **same refs** the snapshot hands out, and
the reply carries the same snapshot id — so "click 6" needs no second lookup, and
the ref still dies with the snapshot. Credential fields are outlined but
deliberately **left unnumbered**: visible, so the model stops hunting for them,
and not addressable.

### Refs are addressing, never a trust shortcut

A ref is valid for exactly **one** snapshot. The snapshot id is a content hash
of the window's element identities, so a changed window mints a new id and every
outstanding ref is **refused** rather than re-pointed at whatever now occupies
that index. Acting re-resolves the ref against a fresh snapshot and compares
ids; there is no path that acts on a remembered element.

Identity comes from the **automation id**, and refs are ordered by it — not by
the order UI Automation returns elements in, and not by their accessible name.
Both of those move under ordinary use: writing into a field promotes it to the
front of the list, and a Win32 control's name is derived from a neighbouring
label and intermittently resolves to nothing. Hashing either meant typing into a
box retired every ref in the window, so an edit-then-click sequence could not be
completed. Insertions and removals still change the set, and still retire the
refs — which is the case that actually makes a ref point at something else.

### `no_automation_tree` vs an empty list

An empty element list is ambiguous, so the snapshot says which kind of empty it
is. `no_interactable_elements` means the window described itself and has nothing
to click; `no_automation_tree` means it refused to describe itself at all
(XAML/UWP under `ApplicationFrameHost` commonly does this — observed on a live,
non-minimized Settings window). The difference matters: the first invites the
conclusion that the window is empty, the second says go look with vision
instead.

## Safety model (the daemon authorizes; this adds defense in depth)

No consent or capability check lives in this binary. The daemon decides whether
desktop input is allowed at all and only then spawns it — same posture as the
capture helper, where running the binary by hand proves nothing about consent.

On top of that, the helper enforces:

- **Credential fields are never driven.** An element whose UIA control type is a
  password box, or whose name/automation id reads like a credential (`password`,
  `cvc`, `otp`, `pin`, …), is refused for both invoke and set_value. Windows
  blocks `ValuePattern` writes into password fields too, so this is the first of
  two layers, not the only one.
- **Focus is never taken** unless `--allow-foreground` is passed explicitly.
- **Refs fail closed** (above).
- The process holds **no secrets** and reads no files.

## Usage

```powershell
aoi_desktop_input.exe --command '{"op":"list_windows"}'
aoi_desktop_input.exe --command '{"op":"snapshot","hwnd":"0x1234"}'
aoi_desktop_input.exe --command '{"op":"invoke","hwnd":"0x1234","ref":7,"snapshotId":"dis-abc"}'
aoi_desktop_input.exe --command '{"op":"set_value","hwnd":"0x1234","ref":7,"snapshotId":"dis-abc","value":"hi"}'
```

`--stdin` reads the command from stdin instead (avoids quoting pain and keeps
values out of the process command line). `--self-test` proves the binary runs
without touching COM or the desktop.

Window titles and process names are returned **basename only** — the full image
path is not the caller's business.

## Build

Requires MSVC (Visual Studio 2019/2022 or Build Tools, "Desktop development with
C++"). `build.ps1` uses `cl.exe` if it is on PATH, otherwise it locates Visual
Studio with `vswhere` and builds inside `vcvars64`.

```powershell
./build.ps1              # release
./build.ps1 -DebugBuild  # /Od /Zi
```

## Install

The daemon spawns this on demand, so there is no service and no scheduled task
-- installing means putting the exe where the daemon looks.

```powershell
./Install-AoiDesktopInput.ps1              # build + copy + self-test
./Install-AoiDesktopInput.ps1 -Uninstall
```

It lands at `~/.openroom/host-bridge/aoi_desktop_input.exe`;
`AOI_DESKTOP_INPUT_HELPER` overrides that (how the daemon is pointed at a build
tree). Installing **grants nothing**: the daemon refuses every request until
`os_desktop_input` is turned on in Settings > Advanced > Host bridge, and the
SendInput rung stays unavailable until `os_desktop_input_foreground` is turned
on separately. Both default OFF; global panic kills both.

The daemon must run in the **interactive** user session. UI Automation cannot
see a desktop from session 0, so a helper spawned by a service-hosted daemon
would find nothing to drive.

## Tests

```powershell
./test/run-tests.ps1
./test/run-tests.ps1 -IncludeForegroundTests   # also exercises the SendInput rung
```

The tests build their own fixture window (`test/aoi_input_testwindow.cpp`) with
one control per branch of the contract — a button, a text field, a password
field, and a disabled button — and drive it for real. They assert the parts that
would otherwise rot silently: that a proven write really is in the control, that
the password field is still empty after a refused write, that a click really
reached the app, and that a ref from a changed window is refused.

The fixture exists because the helper cannot be tested against the operator's
real desktop: driving their live browser to prove a click landed is exactly the
side effect this helper is built to keep under control. For the same reason the
SendInput rung is opt-in — it takes over the real mouse — and the test restores
the cursor position afterwards.

That rung asserts whichever outcome occurred, because the test cannot decide
whether Windows grants the foreground: if the click was delivered it must land
inside the target control, and if it was refused the mouse must not have moved
at all. Checking only that `SendInput` returned would repeat the exact mistake
this contract exists to catch.

Making the fixture check what actually *arrived* — rather than only what the
helper claimed — is what caught the real bugs: a posted key with no scan code in
`lParam` (delivered, produced no character), `clicks: 2` arriving as two single
clicks instead of a double, and a combo box reporting `verified: true` for a
selection the app never committed, because the read-back was measuring the
highlight in an open menu rather than the control's value.
