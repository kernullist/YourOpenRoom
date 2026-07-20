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
    [switch]$Uninstall,
    # Skip the up-front daemon:build (the caller already ensured the bundle).
    [switch]$SkipBuild
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

# Prefer a modern Node before pnpm/daemon:build (PATH may hit Brackets Node 6).
$nodePath = & (Join-Path $RepoRoot "Resolve-OpenRoomNode.ps1")
Write-Step ("Node: {0} ({1})" -f (& $nodePath -v 2>$null), $nodePath)

# Resolve pnpm so the task command is self-contained (Scheduled Tasks do not get
# the interactive PATH).
$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue)
if ($null -eq $pnpm)
{
    throw "pnpm was not found on PATH. Install pnpm, then re-run this script."
}

# Build the daemon bundle up front so the supervised child exists at logon.
if ($SkipBuild)
{
    Write-Step "Skipping daemon:build (-SkipBuild)."
}
else
{
    Write-Step "Building the Aoi daemon bundle (pnpm daemon:build)."
    & $pnpm.Source --dir $AppDir run daemon:build
    if ($LASTEXITCODE -ne 0)
    {
        throw "pnpm daemon:build failed with exit code $LASTEXITCODE."
    }
}

# The task must run the daemon with the SAME Jarvis autonomy env as an interactive
# launch, but a Scheduled Task does not inherit any shell environment. So run it
# through a PowerShell host that dot-sources the single-source env setter first,
# then `pnpm daemon:supervise`. Resolve a PS host with an absolute path (the task
# has no interactive PATH).
$psHost = (Get-Command pwsh -ErrorAction SilentlyContinue)
if ($null -eq $psHost)
{
    $psHost = (Get-Command powershell -ErrorAction SilentlyContinue)
}
if ($null -eq $psHost)
{
    throw "Neither pwsh nor powershell was found on PATH."
}

$envSetter = Join-Path $RepoRoot 'Set-AoiDaemonEnv.ps1'
$innerCommand = ". '$envSetter'; Set-AoiDaemonEnv; & '$($pnpm.Source)' --dir '$AppDir' run daemon:supervise"
$taskArgument = "-NoProfile -ExecutionPolicy Bypass -Command `"$innerCommand`""
$action = New-ScheduledTaskAction -Execute $psHost.Source -Argument $taskArgument -WorkingDirectory $AppDir
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

try
{
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Description 'Keeps the Aoi autonomy daemon alive (start-at-logon + supervisor restart-on-crash).' `
        -Force -ErrorAction Stop | Out-Null
}
catch
{
    throw ("Register-ScheduledTask failed: {0}. Run this in an ELEVATED (Administrator) PowerShell." -f $_.Exception.Message)
}

# Registration can fail non-terminating on some hosts; confirm the task really exists.
if ($null -eq (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue))
{
    throw "The '$TaskName' scheduled task was not registered. Run this in an ELEVATED (Administrator) PowerShell."
}

Write-Step "Registered '$TaskName' (starts at logon, runs the supervised daemon with the Jarvis autonomy env)."
Write-Step "Start it now with:  Start-ScheduledTask -TaskName $TaskName"
Write-Step "Stop/remove with:   ./Install-AoiDaemonService.ps1 -Uninstall"
