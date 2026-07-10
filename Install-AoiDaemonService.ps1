<#
.SYNOPSIS
  Install (or remove) the Aoi autonomy daemon as a boot-persistent, self-healing
  background service on Windows (roadmap P0.1).

.DESCRIPTION
  The Aoi daemon (apps/webuiapps/dist-daemon/aoiDaemonServer.js) is otherwise a
  plain child process: a crash or a reboot leaves Aoi simply OFF until someone
  re-runs Start-App.ps1, so "24/7" is not actually backed by anything.

  This registers a per-user Scheduled Task that:
    - starts at logon (boot persistence), and
    - runs `pnpm daemon:supervise`, which spawns the daemon under the in-process
      supervisor (aoiDaemonSupervisor) that restarts it on crash with backoff and
      a crash-loop guard.
    - the Task itself is set to restart if the supervisor process ever dies,
      giving a second layer of resilience.

  The restart brain (aoiDaemonSupervisor) is unit-tested; this script is the thin,
  OS-specific registration around it.

.PARAMETER Uninstall
  Remove the scheduled task instead of installing it.

.EXAMPLE
  ./Install-AoiDaemonService.ps1
  ./Install-AoiDaemonService.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName = 'AoiAutonomyDaemon'
$RepoRoot = $PSScriptRoot
$AppDir = Join-Path $RepoRoot 'apps\webuiapps'

function Write-Step
{
    param([string]$Message)
    Write-Host "[install-aoi-daemon] $Message"
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

# Resolve pnpm so the task command is self-contained (Scheduled Tasks do not get
# the interactive PATH).
$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue)
if ($null -eq $pnpm)
{
    throw "pnpm was not found on PATH. Install pnpm, then re-run this script."
}

# Build the daemon bundle up front so the supervised child exists at logon.
Write-Step "Building the Aoi daemon bundle (pnpm daemon:build)."
& $pnpm.Source --dir $AppDir run daemon:build
if ($LASTEXITCODE -ne 0)
{
    throw "pnpm daemon:build failed with exit code $LASTEXITCODE."
}

$action = New-ScheduledTaskAction -Execute $pnpm.Source -Argument 'run daemon:supervise' -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
# Restart-on-failure gives a second resilience layer if the supervisor itself dies;
# the supervisor already handles daemon crashes. Keep the process hidden + long-lived.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Keeps the Aoi autonomy daemon alive (start-at-logon + supervisor restart-on-crash).' `
    -Force | Out-Null

Write-Step "Registered '$TaskName' (starts at logon, runs 'pnpm daemon:supervise')."
Write-Step "Start it now with:  Start-ScheduledTask -TaskName $TaskName"
Write-Step "Stop/remove with:   ./Install-AoiDaemonService.ps1 -Uninstall"
