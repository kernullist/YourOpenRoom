<#
.SYNOPSIS
  Install (or remove) the Aoi desktop-activity capture helper as a logon
  Scheduled Task (host-bridge Phase 2 native capture).

.DESCRIPTION
  aoi_desktop_capture.exe watches the foreground window and POSTs metadata-only
  samples to the loopback Aoi daemon. It MUST run in the interactive user session
  (foreground state does not exist in session 0), so this registers a per-user
  task that starts AtLogon under the current user, runs hidden (--hide-console),
  and restarts if the process dies.

  It posts into a CLOSED door until the operator, separately, enables:
    1. the desktop_activity kill-switch capability, and
    2. the desktop-activity environment-source consent for the session.
  Until then the daemon returns 403 and nothing is stored -- by design.

.PARAMETER Uninstall
  Remove the scheduled task instead of installing it.

.PARAMETER Session
  Consent scope to post under (default: aoi/default).

.PARAMETER CaptureTitles
  Include window titles in samples (the daemon still gates/redacts them).

.PARAMETER Port
  Daemon port (default: 7333).

.PARAMETER SkipBuild
  Do not run build.ps1 first (the exe already exists).

.EXAMPLE
  ./Install-AoiDesktopCapture.ps1
  ./Install-AoiDesktopCapture.ps1 -CaptureTitles -Session aoi/default
  ./Install-AoiDesktopCapture.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string]$Session = 'aoi/default',
    [switch]$CaptureTitles,
    [int]$Port = 7333,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$TaskName = 'AoiDesktopCapture'
$Here = $PSScriptRoot
$Exe = Join-Path $Here 'aoi_desktop_capture.exe'

function Write-Step
{
    param([string]$Message)
    Write-Host "[install-aoi-capture] $Message"
}

if ($Uninstall)
{
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $existing)
    {
        Write-Step "No '$TaskName' scheduled task is registered."
    }
    else
    {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Step "Removed the '$TaskName' scheduled task."
    }
    return
}

# Build the exe up front unless told otherwise.
if (-not $SkipBuild)
{
    Write-Step "Building aoi_desktop_capture.exe (build.ps1)."
    & (Join-Path $Here 'build.ps1')
}
if (-not (Test-Path $Exe))
{
    throw "aoi_desktop_capture.exe not found. Run build.ps1 (needs MSVC), then re-run with -SkipBuild."
}

# Resident arguments: hidden console, consent scope, port, optional titles.
$argList = @('--hide-console', '--session', $Session, '--port', "$Port")
if ($CaptureTitles)
{
    $argList += '--capture-titles'
}
$argument = ($argList -join ' ')

$action = New-ScheduledTaskAction -Execute $Exe -Argument $argument -WorkingDirectory $Here
$trigger = New-ScheduledTaskTrigger -AtLogOn
# Run in the interactive user session (needed for foreground observation), hidden,
# and restart if the capture process ever dies.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -Hidden `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

try
{
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Description 'Aoi desktop-activity capture: feeds foreground metadata to the loopback daemon (consent + kill-switch gated).' `
        -Force -ErrorAction Stop | Out-Null
}
catch
{
    throw ("Register-ScheduledTask failed: {0}" -f $_.Exception.Message)
}

if ($null -eq (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue))
{
    throw "The '$TaskName' scheduled task was not registered."
}

Write-Step "Registered '$TaskName' (starts at logon, hidden, session=$Session, titles=$([bool]$CaptureTitles))."
Write-Step "Remember: enable the desktop_activity capability + desktop-activity consent, or the daemon returns 403."
Write-Step "Start now:     Start-ScheduledTask -TaskName $TaskName"
Write-Step "Stop/remove:   ./Install-AoiDesktopCapture.ps1 -Uninstall"
