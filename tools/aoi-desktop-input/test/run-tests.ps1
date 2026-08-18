<#
.SYNOPSIS
  Contract tests for aoi_desktop_input.exe against a real UI Automation tree.

.DESCRIPTION
  Builds the helper and the fixture window, drives the fixture, and asserts the
  verdict contract end to end. Two kinds of assertion matter here:

  1. The helper reports honestly -- a proven write says confirmed + verified, a
     posted click says unverifiable, a refusal says nothing happened, and a ref
     from a changed window is refused rather than re-pointed.

  2. The rungs actually work. The helper reports a background click as
     unverifiable BECAUSE it cannot see whether the app acted; the fixture can,
     so these tests assert what the helper honestly will not. Without that, a
     background rung that silently did nothing would still pass every
     honesty check.

  The fixture window opens without stealing focus and is closed at the end.

.PARAMETER IncludeForegroundTests
  Also exercise the foreground rung. Off by default because that rung does what
  it says: it fronts the fixture and moves the real mouse and keyboard, so
  running it uninvited would interrupt whoever is at the keyboard. The test
  restores the cursor position afterwards.

.EXAMPLE
  ./run-tests.ps1
  ./run-tests.ps1 -IncludeForegroundTests
#>
[CmdletBinding()]
param(
    [switch]$IncludeForegroundTests
)

$ErrorActionPreference = 'Stop'
# Do not inherit the shell's codepage: the helper emits ASCII-escaped JSON now,
# but a non-UTF-8 console still mangles anything else it prints.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$toolDir = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $toolDir 'aoi_desktop_input.exe'
$fixtureSrc = Join-Path $PSScriptRoot 'aoi_input_testwindow.cpp'
$fixtureExe = Join-Path $PSScriptRoot 'aoi_input_testwindow.exe'
$title = "Aoi Input Test Fixture $PID"

$script:failures = 0
$script:checks = 0

function Assert-That
{
    param([string]$What, [bool]$Condition, [string]$Detail = '')

    $script:checks++
    if ($Condition)
    {
        Write-Host "  ok   $What" -ForegroundColor Green
    }
    else
    {
        $script:failures++
        Write-Host "  FAIL $What" -ForegroundColor Red
        if ($Detail -ne '')
        {
            Write-Host "       $Detail" -ForegroundColor DarkGray
        }
    }
}

function Invoke-Helper
{
    param([hashtable]$Command, [switch]$AllowForeground)

    $json = ($Command | ConvertTo-Json -Compress)
    if ($AllowForeground)
    {
        $raw = & $helper --command $json --allow-foreground
    }
    else
    {
        $raw = & $helper --command $json
    }
    if ([string]::IsNullOrWhiteSpace($raw))
    {
        throw "helper returned nothing for $json"
    }
    return ($raw | ConvertFrom-Json)
}

# --- build ------------------------------------------------------------------
Write-Host '[test] building helper'
& (Join-Path $toolDir 'build.ps1') | Out-Null

Write-Host '[test] building fixture'
$fixtureObj = Join-Path $PSScriptRoot 'aoi_input_testwindow.obj'
$clLine = "cl /nologo /W4 /EHsc /std:c++17 /O2 `"$fixtureSrc`" /Fo:`"$fixtureObj`" /Fe:`"$fixtureExe`" /link /SUBSYSTEM:WINDOWS"
$cl = Get-Command cl -ErrorAction SilentlyContinue
if ($null -ne $cl)
{
    cmd /c $clLine | Out-Null
}
else
{
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    $vcvars = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
    cmd /c "`"$vcvars`" >nul && $clLine" | Out-Null
}
if (-not (Test-Path $fixtureExe))
{
    throw 'fixture build failed'
}
if (Test-Path $fixtureObj)
{
    Remove-Item $fixtureObj -Force
}

# --- launch fixture ---------------------------------------------------------
Add-Type -Namespace AoiTest -Name Win -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr wp, System.Text.StringBuilder lp);
[DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
[DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, ref RECT r);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
'@

function Find-Element
{
    param($Snapshot, [int]$AutomationId)

    return ($Snapshot.elements | Where-Object { $_.automationId -eq "$AutomationId" } | Select-Object -First 1)
}

function Get-ControlText
{
    param([IntPtr]$Window, [int]$Id)

    $buffer = New-Object System.Text.StringBuilder 4096
    [void][AoiTest.Win]::SendMessageW([AoiTest.Win]::GetDlgItem($Window, $Id), 0x000D, [IntPtr]4095, $buffer)
    return $buffer.ToString()
}

$fixture = Start-Process -FilePath $fixtureExe -ArgumentList "--title `"$title`"" -PassThru
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 50 -and $hwnd -eq [IntPtr]::Zero; $i++)
{
    Start-Sleep -Milliseconds 100
    $hwnd = [AoiTest.Win]::FindWindowW('AoiInputTestFixture', $title)
}
if ($hwnd -eq [IntPtr]::Zero)
{
    $fixture | Stop-Process -Force -ErrorAction SilentlyContinue
    throw 'fixture window never appeared'
}
$handle = '0x{0:x}' -f $hwnd.ToInt64()
Write-Host "[test] fixture window $handle"

try
{
    # --- discovery ----------------------------------------------------------
    Write-Host '[test] discovery'
    $list = Invoke-Helper @{ op = 'list_windows' }
    $mine = $list.windows | Where-Object { $_.hwnd -eq $handle }
    Assert-That 'the fixture window is enumerated' ($null -ne $mine)
    Assert-That 'the window reports its process' ($mine.process -eq 'aoi_input_testwindow.exe') "got '$($mine.process)'"

    $apps = Invoke-Helper @{ op = 'list_apps' }
    $myApp = $apps.apps | Where-Object { $_.process -eq 'aoi_input_testwindow.exe' }
    Assert-That 'apps are grouped by process' ($null -ne $myApp) "apps=$($apps.apps.Count)"

    # --- snapshot -----------------------------------------------------------
    Write-Host '[test] snapshot'
    $snap = Invoke-Helper @{ op = 'snapshot'; hwnd = $handle }
    Assert-That 'the snapshot succeeds' ($snap.ok -eq $true)
    Assert-That 'the snapshot carries an id' (-not [string]::IsNullOrWhiteSpace($snap.snapshotId))
    Assert-That 'a real tree is not reported as absent' ($snap.note -eq 'ok') "note=$($snap.note)"
    # A cap that reports nothing turns "120 of 400" into "the controls".
    Assert-That 'the snapshot reports the true element count' ($snap.totalElements -ge $snap.elements.Count) "total=$($snap.totalElements) shown=$($snap.elements.Count)"
    Assert-That 'an untruncated snapshot says so' ($snap.truncated -eq $false) "truncated=$($snap.truncated)"

    # Look controls up by automation id, not by name. The id is the identity the
    # helper guarantees; a Win32 accessible name is derived from a neighbouring
    # label and intermittently resolves to nothing, which would make these
    # lookups -- not the helper -- the flaky part.
    $clickMe = Find-Element $snap 101
    $renameMe = Find-Element $snap 106
    $message = Find-Element $snap 102
    $password = Find-Element $snap 103
    $disabled = Find-Element $snap 104
    $notes = Find-Element $snap 107

    Assert-That 'the button is listed' ($null -ne $clickMe)
    Assert-That 'the rename button is listed' ($null -ne $renameMe)
    Assert-That 'the message field is listed' ($null -ne $message)
    Assert-That 'the notes field is listed' ($null -ne $notes)
    Assert-That 'the password field is marked sensitive' ($password.sensitive -eq $true)
    Assert-That 'the message field is NOT marked sensitive' ($message.sensitive -eq $false)
    Assert-That 'the disabled button reports enabled=false' ($disabled.enabled -eq $false)

    # --- capture -------------------------------------------------------------
    Write-Host '[test] capture'
    $shot = Invoke-Helper @{ op = 'capture'; hwnd = $handle; mode = 'som' }
    Assert-That 'the capture succeeds' ($shot.ok -eq $true) "detail=$($shot.detail)"
    Assert-That 'it reports the numbered mode' ($shot.mode -eq 'som') "mode=$($shot.mode)"
    Assert-That 'it returns a real image' ($shot.pngBase64.Length -gt 2000) "base64 length=$($shot.pngBase64.Length)"

    $bytes = [Convert]::FromBase64String($shot.pngBase64)
    # PNG magic. Proves it is an image rather than an error string that happened
    # to survive base64.
    Assert-That 'the bytes really are a PNG' ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47) "first bytes: $($bytes[0..3] -join ',')"
    Assert-That 'the image has real dimensions' ($shot.width -gt 100 -and $shot.height -gt 100) "$($shot.width)x$($shot.height)"

    # The numbers drawn on the image are worthless if they do not match the refs
    # the acting ops expect. Same window, same ids.
    Assert-That 'the capture and the snapshot agree on the snapshot id' ($shot.snapshotId -eq $snap.snapshotId) "capture=$($shot.snapshotId) snapshot=$($snap.snapshotId)"
    $capturedRefs = ($shot.elements | ForEach-Object { $_.ref }) -join ','
    $snapRefs = ($snap.elements | ForEach-Object { $_.ref }) -join ','
    Assert-That 'the capture and the snapshot agree on the refs' ($capturedRefs -eq $snapRefs) "capture=$capturedRefs snapshot=$snapRefs"

    # A password field must still be listed as sensitive in the capture reply --
    # the model is shown it exists so it stops hunting, but never invited to it.
    $capturedPassword = Find-Element $shot 103
    Assert-That 'the capture marks the credential field sensitive' ($capturedPassword.sensitive -eq $true)

    $plain = Invoke-Helper @{ op = 'capture'; hwnd = $handle; mode = 'plain' }
    Assert-That 'plain mode skips the overlay' ($plain.mode -eq 'plain') "mode=$($plain.mode)"
    # An overlay is drawn pixels, so the numbered image is not the plain one.
    Assert-That 'the numbered image differs from the plain one' ($plain.pngBase64 -ne $shot.pngBase64)

    $scaled = Invoke-Helper @{ op = 'capture'; hwnd = $handle; mode = 'plain'; maxLongSide = 240 }
    Assert-That 'a long-side cap is honored' (([Math]::Max($scaled.width, $scaled.height)) -le 240) "$($scaled.width)x$($scaled.height)"
    Assert-That 'and the scale factor is reported' ($scaled.scale -lt 1) "scale=$($scaled.scale)"

    $goneShot = Invoke-Helper @{ op = 'capture'; hwnd = '0xdeadbeef'; mode = 'som' }
    Assert-That 'capturing a dead window is refused' ($goneShot.code -eq 'window_not_found') "code=$($goneShot.code)"

    # --- refusals: these must not act at all --------------------------------
    Write-Host '[test] refusals'
    $onPassword = Invoke-Helper @{ op = 'set_value'; hwnd = $handle; ref = $password.ref; snapshotId = $snap.snapshotId; value = 'hunter2' }
    Assert-That 'writing to a password field is refused' ($onPassword.code -eq 'element_forbidden') "code=$($onPassword.code)"
    Assert-That 'a refusal never claims an effect' ($onPassword.effect -eq 'suspected_noop')
    Assert-That 'the password field really is untouched' ((Get-ControlText $hwnd 103) -eq '') "contains '$(Get-ControlText $hwnd 103)'"

    $onDisabled = Invoke-Helper @{ op = 'invoke'; hwnd = $handle; ref = $disabled.ref; snapshotId = $snap.snapshotId }
    Assert-That 'invoking a disabled control is refused' ($onDisabled.code -eq 'element_disabled') "code=$($onDisabled.code)"

    $badRef = Invoke-Helper @{ op = 'invoke'; hwnd = $handle; ref = 999; snapshotId = $snap.snapshotId }
    Assert-That 'an out-of-range ref is refused' ($badRef.code -eq 'element_ref_unknown') "code=$($badRef.code)"

    $noSnapshot = Invoke-Helper @{ op = 'invoke'; hwnd = $handle; ref = $clickMe.ref }
    Assert-That 'a ref with no snapshot id is refused' ($noSnapshot.code -eq 'element_ref_stale') "code=$($noSnapshot.code)"

    # --- set_value: the only path that earns verified=true ------------------
    Write-Host '[test] set_value'
    $written = Invoke-Helper @{ op = 'set_value'; hwnd = $handle; ref = $message.ref; snapshotId = $snap.snapshotId; value = 'hello aoi' }
    Assert-That 'the write is confirmed' ($written.effect -eq 'confirmed') "effect=$($written.effect) detail=$($written.detail)"
    Assert-That 'the write is verified by read-back' ($written.verified -eq $true)
    Assert-That 'the write reports the UIA path' ($written.path -eq 'uia_value') "path=$($written.path)"
    Assert-That 'the value is really in the control' ((Get-ControlText $hwnd 102) -eq 'hello aoi') "contains '$(Get-ControlText $hwnd 102)'"

    # --- keyboard: run BEFORE the click tests --------------------------------
    # A posted click gives the button focus, which would move the keyboard
    # target out from under these.
    Write-Host '[test] keyboard (background rung)'
    $before = Get-ControlText $hwnd 102
    $typed = Invoke-Helper @{ op = 'type'; hwnd = $handle; text = '-typed' }
    Assert-That 'typing is delivered' ($typed.ok -eq $true) "detail=$($typed.detail)"
    Assert-That 'typing takes no focus' ($typed.path -eq 'background') "path=$($typed.path)"
    # The helper cannot see whether the app accepted it, and says so.
    Assert-That 'typing is never called confirmed' ($typed.effect -eq 'unverifiable') "effect=$($typed.effect)"
    Start-Sleep -Milliseconds 250
    # Deliberately not asserting a position: text lands at the caret, and after a
    # programmatic set_value the caret is at 0, so this PREPENDS. That is real
    # Windows behavior, not a helper bug -- what matters is that it arrived.
    $after = Get-ControlText $hwnd 102
    Assert-That 'the typed text really reached the app' ($after.Contains('-typed') -and $after.Contains($before)) "got '$after' from '$before'"

    $before = Get-ControlText $hwnd 102
    $key = Invoke-Helper @{ op = 'key'; hwnd = $handle; keys = 'a' }
    Assert-That 'a key is delivered' ($key.ok -eq $true) "detail=$($key.detail)"
    Assert-That 'a key takes no focus' ($key.path -eq 'background') "path=$($key.path)"
    Start-Sleep -Milliseconds 250
    $after = Get-ControlText $hwnd 102
    Assert-That 'the key really reached the app' ($after.Length -eq ($before.Length + 1) -and $after.Contains('a')) "got '$after' from '$before'"

    # A modifier combo cannot be posted: the app reads modifier state from the
    # real keyboard. Dropping them silently would report a plain key as the
    # combo that was asked for.
    $combo = Invoke-Helper @{ op = 'key'; hwnd = $handle; keys = 'ctrl+s'; delivery = 'background' }
    Assert-That 'a modifier combo is refused in the background' ($combo.code -eq 'modifiers_need_foreground') "code=$($combo.code)"

    $badCombo = Invoke-Helper @{ op = 'key'; hwnd = $handle; keys = 'ctrl+nonsense' }
    Assert-That 'an unreadable combo is refused' ($badCombo.code -eq 'bad_key_combo') "code=$($badCombo.code)"

    # --- scroll: the one input action with a verifiable rung -----------------
    Write-Host '[test] scroll'
    $scrolled = Invoke-Helper @{ op = 'scroll'; hwnd = $handle; ref = $notes.ref; snapshotId = $snap.snapshotId; direction = 'down'; amount = 3 }
    Assert-That 'scrolling down is confirmed by read-back' ($scrolled.effect -eq 'confirmed') "effect=$($scrolled.effect) detail=$($scrolled.detail)"
    Assert-That 'the scroll reports the UIA path' ($scrolled.path -eq 'uia_scroll') "path=$($scrolled.path)"

    # Already at the top: the API reports success while nothing moves, and that
    # is a no-op the caller needs told rather than a completed scroll.
    Invoke-Helper @{ op = 'scroll'; hwnd = $handle; ref = $notes.ref; snapshotId = $snap.snapshotId; direction = 'up'; amount = 30 } | Out-Null
    $noMove = Invoke-Helper @{ op = 'scroll'; hwnd = $handle; ref = $notes.ref; snapshotId = $snap.snapshotId; direction = 'up'; amount = 3 }
    Assert-That 'a scroll that cannot move is reported as a no-op' ($noMove.effect -eq 'suspected_noop') "effect=$($noMove.effect) detail=$($noMove.detail)"

    $badDirection = Invoke-Helper @{ op = 'scroll'; hwnd = $handle; ref = $notes.ref; snapshotId = $snap.snapshotId; direction = 'sideways' }
    Assert-That 'an unknown scroll direction is refused' ($badDirection.code -eq 'bad_request') "code=$($badDirection.code)"

    # --- select / toggle: state that can be READ BACK ------------------------
    # These are the ops worth having over a plain click: a click on a checked box
    # unchecks it, so "check this" and "click this" are different requests, and
    # only one of them is idempotent.
    Write-Host '[test] select and toggle'
    $check = Find-Element $snap 108
    $combo = Find-Element $snap 109
    Assert-That 'the checkbox is listed' ($null -ne $check)
    Assert-That 'the combo box is listed' ($null -ne $combo)

    $on = Invoke-Helper @{ op = 'toggle'; hwnd = $handle; ref = $check.ref; snapshotId = $snap.snapshotId; state = 'on' }
    Assert-That 'turning a checkbox on is confirmed' ($on.effect -eq 'confirmed') "effect=$($on.effect) detail=$($on.detail)"
    Assert-That 'the toggle is verified by read-back' ($on.verified -eq $true)

    # Asking for a state already held must be idempotent, not a flip.
    $again = Invoke-Helper @{ op = 'toggle'; hwnd = $handle; ref = $check.ref; snapshotId = $snap.snapshotId; state = 'on' }
    Assert-That 'asking for a state already held changes nothing' ($again.effect -eq 'confirmed') "effect=$($again.effect)"
    Assert-That 'and says it changed nothing' ($again.detail -match 'already') "detail=$($again.detail)"

    $off = Invoke-Helper @{ op = 'toggle'; hwnd = $handle; ref = $check.ref; snapshotId = $snap.snapshotId; state = 'off' }
    Assert-That 'turning it back off is confirmed' ($off.effect -eq 'confirmed') "effect=$($off.effect) detail=$($off.detail)"

    $picked = Invoke-Helper @{ op = 'select'; hwnd = $handle; ref = $combo.ref; snapshotId = $snap.snapshotId; option = 'Gamma' }
    Assert-That 'selecting an option is confirmed' ($picked.effect -eq 'confirmed') "effect=$($picked.effect) detail=$($picked.detail)"
    Assert-That 'the selection is verified by read-back' ($picked.verified -eq $true)
    # Not "does not open the menu" -- a closed Win32 dropdown has no list to
    # search, so it may have to. What must hold is that it went through UIA
    # rather than synthetic clicks, and that it says which happened.
    Assert-That 'selecting uses the UIA path, not synthetic clicks' ($picked.path -eq 'uia_select') "path=$($picked.path)"
    # CB_GETCURSEL: index 2 is Gamma. Proves the app really changed, not just UIA.
    Assert-That 'the app really changed selection' (([AoiTest.Win]::SendMessageW([AoiTest.Win]::GetDlgItem($hwnd, 109), 0x0147, [IntPtr]0, $null)).ToInt64() -eq 2) 'CB_GETCURSEL mismatch'

    $missing = Invoke-Helper @{ op = 'select'; hwnd = $handle; ref = $combo.ref; snapshotId = $snap.snapshotId; option = 'Omega' }
    Assert-That 'an option that does not exist is refused' ($missing.code -eq 'option_not_found') "code=$($missing.code)"

    $notToggleable = Invoke-Helper @{ op = 'toggle'; hwnd = $handle; ref = $clickMe.ref; snapshotId = $snap.snapshotId; state = 'on' }
    Assert-That 'a control that does not toggle is refused' ($notToggleable.code -eq 'uia_unsupported') "code=$($notToggleable.code)"

    # --- clicks --------------------------------------------------------------
    Write-Host '[test] clicks'
    $invoked = Invoke-Helper @{ op = 'invoke'; hwnd = $handle; ref = $clickMe.ref; snapshotId = $snap.snapshotId }
    Assert-That 'invoke is confirmed' ($invoked.effect -eq 'confirmed') "effect=$($invoked.effect)"
    Assert-That 'invoke does not use synthetic input' ($invoked.path -eq 'uia_invoke') "path=$($invoked.path)"
    Start-Sleep -Milliseconds 250
    Assert-That 'invoke really reached the app' ((Get-ControlText $hwnd 105) -eq 'L:1 R:0 D:0') "tally=$(Get-ControlText $hwnd 105)"

    $posted = Invoke-Helper @{ op = 'click'; hwnd = $handle; ref = $clickMe.ref; snapshotId = $snap.snapshotId; delivery = 'background' }
    Assert-That 'a background click is delivered' ($posted.ok -eq $true) "detail=$($posted.detail)"
    Assert-That 'a background click takes no focus' ($posted.path -eq 'background') "path=$($posted.path)"
    Assert-That 'a background click is never called confirmed' ($posted.effect -eq 'unverifiable') "effect=$($posted.effect)"
    Start-Sleep -Milliseconds 250
    # What the helper honestly cannot prove, the fixture can.
    Assert-That 'the background click really reached the app' ((Get-ControlText $hwnd 105) -eq 'L:2 R:0 D:0') "tally=$(Get-ControlText $hwnd 105)"

    $right = Invoke-Helper @{ op = 'click'; hwnd = $handle; ref = $clickMe.ref; snapshotId = $snap.snapshotId; button = 'right'; delivery = 'background' }
    Assert-That 'a right click is delivered' ($right.ok -eq $true) "detail=$($right.detail)"
    Start-Sleep -Milliseconds 250
    Assert-That 'the right click really reached the app' ((Get-ControlText $hwnd 105) -eq 'L:2 R:1 D:0') "tally=$(Get-ControlText $hwnd 105)"

    $double = Invoke-Helper @{ op = 'click'; hwnd = $handle; ref = $clickMe.ref; snapshotId = $snap.snapshotId; clicks = 2; delivery = 'background' }
    Assert-That 'a double click is delivered' ($double.ok -eq $true) "detail=$($double.detail)"
    Start-Sleep -Milliseconds 300
    Assert-That 'the double click really reached the app' ((Get-ControlText $hwnd 105) -match 'D:1') "tally=$(Get-ControlText $hwnd 105)"

    $modified = Invoke-Helper @{ op = 'click'; hwnd = $handle; ref = $clickMe.ref; snapshotId = $snap.snapshotId; modifiers = 'ctrl'; delivery = 'background' }
    Assert-That 'a modified click is refused in the background' ($modified.code -eq 'modifiers_need_foreground') "code=$($modified.code)"

    $badButton = Invoke-Helper @{ op = 'click'; hwnd = $handle; ref = $clickMe.ref; snapshotId = $snap.snapshotId; button = 'thumb' }
    Assert-That 'an unknown mouse button is refused' ($badButton.code -eq 'bad_request') "code=$($badButton.code)"

    # --- coordinate targeting ------------------------------------------------
    # The escape hatch for windows that expose no automation tree. It must not
    # become a way around the element guards.
    Write-Host '[test] coordinate targeting'
    $box = New-Object AoiTest.Win+RECT
    [void][AoiTest.Win]::GetWindowRect([AoiTest.Win]::GetDlgItem($hwnd, 101), [ref]$box)
    $frame = New-Object AoiTest.Win+RECT
    [void][AoiTest.Win]::GetWindowRect($hwnd, [ref]$frame)
    # Window-relative, but GetWindowRect is frame-relative, so convert through
    # screen coordinates the same way the helper does.
    $screenX = $box.Left + [int](($box.Right - $box.Left) / 2)
    $screenY = $box.Top + [int](($box.Bottom - $box.Top) / 2)
    $clientPoint = New-Object AoiTest.Win+POINT
    $clientPoint.X = $screenX
    $clientPoint.Y = $screenY
    [void][AoiTest.Win]::ScreenToClient($hwnd, [ref]$clientPoint)

    $tallyBefore = Get-ControlText $hwnd 105
    $byPoint = Invoke-Helper @{ op = 'click'; hwnd = $handle; x = $clientPoint.X; y = $clientPoint.Y; delivery = 'background' }
    Assert-That 'a coordinate click is delivered' ($byPoint.ok -eq $true) "detail=$($byPoint.detail)"
    Start-Sleep -Milliseconds 250
    Assert-That 'the coordinate click really reached the app' ((Get-ControlText $hwnd 105) -ne $tallyBefore) "tally stayed $tallyBefore"
    # It landed on a real control, so the guards ran and it should say so.
    Assert-That 'it reports that a control was behind the point' ($byPoint.detail -match 'known control') "detail=$($byPoint.detail)"

    # The password field by POSITION must be refused exactly like by ref --
    # otherwise coordinates are a way around the credential guard.
    [void][AoiTest.Win]::GetWindowRect([AoiTest.Win]::GetDlgItem($hwnd, 103), [ref]$box)
    $pwPoint = New-Object AoiTest.Win+POINT
    $pwPoint.X = $box.Left + [int](($box.Right - $box.Left) / 2)
    $pwPoint.Y = $box.Top + [int](($box.Bottom - $box.Top) / 2)
    [void][AoiTest.Win]::ScreenToClient($hwnd, [ref]$pwPoint)
    $atPassword = Invoke-Helper @{ op = 'click'; hwnd = $handle; x = $pwPoint.X; y = $pwPoint.Y; delivery = 'background' }
    Assert-That 'a coordinate over a credential field is refused' ($atPassword.code -eq 'element_forbidden') "code=$($atPassword.code)"

    # --- stale refs ----------------------------------------------------------
    Write-Host '[test] stale refs'
    Invoke-Helper @{ op = 'invoke'; hwnd = $handle; ref = $renameMe.ref; snapshotId = $snap.snapshotId } | Out-Null
    Start-Sleep -Milliseconds 250
    $stale = Invoke-Helper @{ op = 'invoke'; hwnd = $handle; ref = $clickMe.ref; snapshotId = $snap.snapshotId }
    Assert-That 'a ref from a changed window is refused' ($stale.code -eq 'element_ref_stale') "code=$($stale.code)"

    $fresh = Invoke-Helper @{ op = 'snapshot'; hwnd = $handle }
    Assert-That 'the changed window mints a new snapshot id' ($fresh.snapshotId -ne $snap.snapshotId)
    # Every acting op re-resolves through the same guard, so the refusal must
    # not be specific to invoke.
    $staleClick = Invoke-Helper @{ op = 'click'; hwnd = $handle; ref = $clickMe.ref; snapshotId = $snap.snapshotId }
    Assert-That 'a stale ref is refused for click too' ($staleClick.code -eq 'element_ref_stale') "code=$($staleClick.code)"

    # --- the foreground rung -------------------------------------------------
    Write-Host '[test] foreground rung'
    $freshMessage = Find-Element $fresh 102
    $noPattern = Invoke-Helper @{ op = 'invoke'; hwnd = $handle; ref = $freshMessage.ref; snapshotId = $fresh.snapshotId }
    Assert-That 'synthetic input is not used unless asked for' ($noPattern.code -eq 'uia_unsupported') "code=$($noPattern.code)"

    $focusDenied = Invoke-Helper @{ op = 'focus'; hwnd = $handle }
    Assert-That 'raising a window needs the foreground flag' ($focusDenied.code -eq 'uia_unsupported') "code=$($focusDenied.code)"

    if ($IncludeForegroundTests)
    {
        $cursor = [System.Windows.Forms.Cursor]::Position
        $priorForeground = [AoiTest.Win]::GetForegroundWindow()
        try
        {
            $clickedByInput = Invoke-Helper @{ op = 'invoke'; hwnd = $handle; ref = $freshMessage.ref; snapshotId = $fresh.snapshotId } -AllowForeground
            $landed = [System.Windows.Forms.Cursor]::Position
            $box = New-Object AoiTest.Win+RECT
            [void][AoiTest.Win]::GetWindowRect([AoiTest.Win]::GetDlgItem($hwnd, 102), [ref]$box)

            # Both outcomes are correct, and which one happens is not the test's
            # to decide: Windows grants or refuses a foreground change from a
            # background process on its own terms. What must hold is that each
            # outcome is reported honestly.
            if ($clickedByInput.ok -eq $true)
            {
                Assert-That 'the synthetic click reports its path' ($clickedByInput.path -eq 'sendinput') "path=$($clickedByInput.path)"
                Assert-That 'the synthetic click is never called confirmed' ($clickedByInput.effect -eq 'unverifiable') "effect=$($clickedByInput.effect)"
                # Asserting only that SendInput returned would repeat the exact
                # mistake this contract exists to catch: the call succeeding says
                # nothing about WHERE the click went.
                $inside = ($landed.X -ge $box.Left) -and ($landed.X -le $box.Right) -and `
                          ($landed.Y -ge $box.Top) -and ($landed.Y -le $box.Bottom)
                Assert-That 'the click landed on the targeted control' $inside "cursor=($($landed.X),$($landed.Y)) control=($($box.Left),$($box.Top))-($($box.Right),$($box.Bottom))"
            }
            else
            {
                Assert-That 'a refused foreground change is named' ($clickedByInput.code -eq 'foreground_denied' -or $clickedByInput.code -eq 'element_obscured') "code=$($clickedByInput.code)"
                Assert-That 'a refused click claims no effect' ($clickedByInput.effect -eq 'suspected_noop') "effect=$($clickedByInput.effect)"
                $moved = ($landed.X -ne $cursor.X) -or ($landed.Y -ne $cursor.Y)
                Assert-That 'a refused click moves no mouse at all' (-not $moved) "cursor went ($($cursor.X),$($cursor.Y)) -> ($($landed.X),$($landed.Y))"
                Write-Host '       (Windows refused the foreground change this run; that is the path under test)' -ForegroundColor DarkGray
            }

            # A foreground key must put focus back where it found it. Leaving the
            # operator somewhere they did not navigate is a side effect of its own.
            $keyFg = Invoke-Helper @{ op = 'key'; hwnd = $handle; keys = 'ctrl+shift'; delivery = 'foreground' } -AllowForeground
            Assert-That 'an all-modifier combo is still refused' ($keyFg.code -eq 'bad_key_combo') "code=$($keyFg.code)"

            $typeFg = Invoke-Helper @{ op = 'type'; hwnd = $handle; text = 'FG'; delivery = 'foreground' } -AllowForeground
            if ($typeFg.ok -eq $true)
            {
                Assert-That 'foreground typing reports its rung' ($typeFg.path -eq 'foreground') "path=$($typeFg.path)"
                Start-Sleep -Milliseconds 300
                $restored = [AoiTest.Win]::GetForegroundWindow()
                Assert-That 'the prior foreground window is restored' ($restored -eq $priorForeground) "prior=$priorForeground now=$restored"
            }
            else
            {
                Assert-That 'a refused foreground type is named' ($typeFg.code -eq 'foreground_denied') "code=$($typeFg.code)"
            }
        }
        finally
        {
            [System.Windows.Forms.Cursor]::Position = $cursor
        }
    }
    else
    {
        Write-Host '  skip foreground delivery (pass -IncludeForegroundTests)' -ForegroundColor DarkGray
    }

    # --- unknown window -----------------------------------------------------
    $gone = Invoke-Helper @{ op = 'snapshot'; hwnd = '0xdeadbeef' }
    Assert-That 'a dead window handle is refused' ($gone.code -eq 'window_not_found') "code=$($gone.code)"
}
finally
{
    [void][AoiTest.Win]::PostMessageW($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)  # WM_CLOSE
    Start-Sleep -Milliseconds 300
    $fixture | Stop-Process -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($script:failures -eq 0)
{
    Write-Host "[test] $($script:checks)/$($script:checks) checks passed" -ForegroundColor Green
    exit 0
}
Write-Host "[test] $($script:failures) of $($script:checks) checks FAILED" -ForegroundColor Red
exit 1
