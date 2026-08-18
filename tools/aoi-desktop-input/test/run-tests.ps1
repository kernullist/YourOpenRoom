<#
.SYNOPSIS
  Contract tests for aoi_desktop_input.exe against a real UI Automation tree.

.DESCRIPTION
  Builds the helper and the fixture window, drives the fixture, and asserts the
  verdict contract end to end. These are the assertions that matter:

    - a proven write reports effect=confirmed AND verified=true, and the value
      really is in the control afterwards
    - a click on a disabled control is REFUSED, not reported as done
    - a password field is REFUSED even though it is perfectly drivable
    - a ref from a stale snapshot is REFUSED rather than re-pointed at whatever
      now sits at that index

  The fixture window opens without stealing focus and is closed at the end.

.PARAMETER IncludeForegroundTests
  Also exercise the SendInput fallback. Off by default because that rung does
  what it says: it pulls the fixture to the foreground and moves the real mouse,
  so running it uninvited would interrupt whoever is at the keyboard. The test
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
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder buf, int max);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr wp, System.Text.StringBuilder lp);
[DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
[DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
'@

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
    # --- list_windows -------------------------------------------------------
    Write-Host '[test] list_windows'
    $list = Invoke-Helper @{ op = 'list_windows' }
    $mine = $list.windows | Where-Object { $_.hwnd -eq $handle }
    Assert-That 'the fixture window is enumerated' ($null -ne $mine)
    Assert-That 'the window reports its process' ($mine.process -eq 'aoi_input_testwindow.exe') "got '$($mine.process)'"

    # --- snapshot -----------------------------------------------------------
    Write-Host '[test] snapshot'
    $snap = Invoke-Helper @{ op = 'snapshot'; hwnd = $handle }
    Assert-That 'the snapshot succeeds' ($snap.ok -eq $true)
    Assert-That 'the snapshot carries an id' (-not [string]::IsNullOrWhiteSpace($snap.snapshotId))
    Assert-That 'a real tree is not reported as absent' ($snap.note -eq 'ok') "note=$($snap.note)"

    $clickMe = $snap.elements | Where-Object { $_.name -eq 'Click Me' } | Select-Object -First 1
    $message = $snap.elements | Where-Object { $_.name -like 'Message*' } | Select-Object -First 1
    $password = $snap.elements | Where-Object { $_.name -like 'Password*' } | Select-Object -First 1
    $disabled = $snap.elements | Where-Object { $_.name -eq 'Disabled' } | Select-Object -First 1

    Assert-That 'the button is listed' ($null -ne $clickMe)
    Assert-That 'the message field is listed' ($null -ne $message)
    Assert-That 'the password field is listed' ($null -ne $password)
    Assert-That 'the disabled button is listed' ($null -ne $disabled)
    Assert-That 'the password field is marked sensitive' ($password.sensitive -eq $true)
    Assert-That 'the message field is NOT marked sensitive' ($message.sensitive -eq $false)
    Assert-That 'the disabled button reports enabled=false' ($disabled.enabled -eq $false)

    # --- refusals: these must not act at all --------------------------------
    Write-Host '[test] refusals'
    $onPassword = Invoke-Helper @{ op = 'set_value'; hwnd = $handle; ref = $password.ref; snapshotId = $snap.snapshotId; value = 'hunter2' }
    Assert-That 'writing to a password field is refused' ($onPassword.code -eq 'element_forbidden') "code=$($onPassword.code)"
    Assert-That 'a refusal never claims an effect' ($onPassword.effect -eq 'suspected_noop')

    $passwordBox = [AoiTest.Win]::GetDlgItem($hwnd, 103)
    $buffer = New-Object System.Text.StringBuilder 256
    [void][AoiTest.Win]::SendMessageW($passwordBox, 0x000D, [IntPtr]255, $buffer)  # WM_GETTEXT
    Assert-That 'the password field really is untouched' ($buffer.ToString() -eq '') "contains '$($buffer.ToString())'"

    $onDisabled = Invoke-Helper @{ op = 'invoke'; hwnd = $handle; ref = $disabled.ref; snapshotId = $snap.snapshotId }
    Assert-That 'invoking a disabled control is refused' ($onDisabled.code -eq 'element_disabled') "code=$($onDisabled.code)"

    $badRef = Invoke-Helper @{ op = 'invoke'; hwnd = $handle; ref = 999; snapshotId = $snap.snapshotId }
    Assert-That 'an out-of-range ref is refused' ($badRef.code -eq 'element_ref_unknown') "code=$($badRef.code)"

    $noSnapshot = Invoke-Helper @{ op = 'invoke'; hwnd = $handle; ref = $clickMe.ref }
    Assert-That 'a ref with no snapshot id is refused' ($noSnapshot.code -eq 'element_ref_stale') "code=$($noSnapshot.code)"

    # --- set_value: the only path that earns verified=true ------------------
    Write-Host '[test] set_value'
    $written = Invoke-Helper @{ op = 'set_value'; hwnd = $handle; ref = $message.ref; snapshotId = $snap.snapshotId; value = 'hello aoi' }
    Assert-That 'the write reports success' ($written.ok -eq $true) "detail=$($written.detail)"
    Assert-That 'the write is confirmed' ($written.effect -eq 'confirmed') "effect=$($written.effect)"
    Assert-That 'the write is verified by read-back' ($written.verified -eq $true)
    Assert-That 'the write reports the UIA path' ($written.path -eq 'uia_value') "path=$($written.path)"

    $messageBox = [AoiTest.Win]::GetDlgItem($hwnd, 102)
    $buffer = New-Object System.Text.StringBuilder 256
    [void][AoiTest.Win]::SendMessageW($messageBox, 0x000D, [IntPtr]255, $buffer)
    Assert-That 'the value is really in the control' ($buffer.ToString() -eq 'hello aoi') "contains '$($buffer.ToString())'"

    # --- invoke: proven effect, then the ref must go stale ------------------
    Write-Host '[test] invoke'
    $clicked = Invoke-Helper @{ op = 'invoke'; hwnd = $handle; ref = $clickMe.ref; snapshotId = $snap.snapshotId }
    Assert-That 'the click reports success' ($clicked.ok -eq $true) "detail=$($clicked.detail)"
    Assert-That 'the click is confirmed' ($clicked.effect -eq 'confirmed') "effect=$($clicked.effect)"
    Assert-That 'the click did not steal focus with synthetic input' ($clicked.path -eq 'uia_invoke') "path=$($clicked.path)"

    Start-Sleep -Milliseconds 200
    $captionBuffer = New-Object System.Text.StringBuilder 256
    [void][AoiTest.Win]::SendMessageW([AoiTest.Win]::GetDlgItem($hwnd, 101), 0x000D, [IntPtr]255, $captionBuffer)
    Assert-That 'the click really reached the app' ($captionBuffer.ToString() -eq 'Clicked!') "caption='$($captionBuffer.ToString())'"

    # The click renamed the button, so every ref from the old snapshot is dead.
    $stale = Invoke-Helper @{ op = 'invoke'; hwnd = $handle; ref = $clickMe.ref; snapshotId = $snap.snapshotId }
    Assert-That 'a ref from a changed window is refused' ($stale.code -eq 'element_ref_stale') "code=$($stale.code)"

    $fresh = Invoke-Helper @{ op = 'snapshot'; hwnd = $handle }
    Assert-That 'the changed window mints a new snapshot id' ($fresh.snapshotId -ne $snap.snapshotId)

    # --- the SendInput rung -------------------------------------------------
    # A plain edit box exposes no InvokePattern, so invoking one is the case
    # where rung 1 cannot run. What happens next is a security decision, not a
    # convenience one: without the flag it must refuse rather than quietly
    # escalate to real mouse input.
    Write-Host '[test] sendinput rung'
    $freshMessage = $fresh.elements | Where-Object { $_.name -like 'Message*' } | Select-Object -First 1
    $noPattern = Invoke-Helper @{ op = 'invoke'; hwnd = $handle; ref = $freshMessage.ref; snapshotId = $fresh.snapshotId }
    Assert-That 'synthetic input is not used unless asked for' ($noPattern.code -eq 'uia_unsupported') "code=$($noPattern.code)"

    if ($IncludeForegroundTests)
    {
        $cursor = [System.Windows.Forms.Cursor]::Position
        try
        {
            $clickedByInput = Invoke-Helper @{ op = 'invoke'; hwnd = $handle; ref = $freshMessage.ref; snapshotId = $fresh.snapshotId } -AllowForeground
            Assert-That 'the synthetic click is delivered' ($clickedByInput.ok -eq $true) "detail=$($clickedByInput.detail)"
            Assert-That 'the synthetic click reports its path' ($clickedByInput.path -eq 'sendinput') "path=$($clickedByInput.path)"
            # The whole point: nothing in this rung can prove the click landed
            # where it was aimed, so it must never say confirmed.
            Assert-That 'the synthetic click is never called confirmed' ($clickedByInput.effect -eq 'unverifiable') "effect=$($clickedByInput.effect)"
            Assert-That 'the synthetic click claims no verification' ($clickedByInput.verified -eq $false)
        }
        finally
        {
            [System.Windows.Forms.Cursor]::Position = $cursor
        }
    }
    else
    {
        Write-Host '  skip synthetic-input delivery (pass -IncludeForegroundTests)' -ForegroundColor DarkGray
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
