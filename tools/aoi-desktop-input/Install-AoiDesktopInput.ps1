<#
.SYNOPSIS
  Install (or remove) the Aoi desktop-input helper for the local daemon.

.DESCRIPTION
  Unlike the capture helper, this one is NOT a resident process and gets no
  scheduled task: the daemon spawns it on demand, one command at a time. So
  installing it means exactly one thing -- putting the built exe where the
  daemon looks:

      ~/.openroom/host-bridge/aoi_desktop_input.exe

  Computer use (os_computer_use) is ON by default, so installing this DOES make
  desktop input usable -- that is the point: a feature that has to be discovered
  and enabled before it works is a feature that looks broken. Switching off
  "Computer use" in Settings > Advanced > Host bridge stops all of it at once,
  and global panic overrides everything.

  What installing does NOT enable is the synthetic-mouse fallback
  (os_desktop_input_foreground). That one takes the foreground and moves the
  real cursor, so it stays off until explicitly turned on.

  The daemon must be running in the INTERACTIVE user session. UI Automation
  cannot see a desktop from session 0, so a helper spawned by a service-hosted
  daemon would find nothing to drive.

.PARAMETER Uninstall
  Remove the installed copy instead of installing it.

.PARAMETER SkipBuild
  Do not run build.ps1 first (the exe already exists).

.PARAMETER OpenroomHome
  Override the Aoi home directory (default: ~/.openroom, or $env:OPENROOM_HOME).

.EXAMPLE
  ./Install-AoiDesktopInput.ps1
  ./Install-AoiDesktopInput.ps1 -SkipBuild
  ./Install-AoiDesktopInput.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$SkipBuild,
    [string]$OpenroomHome
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($OpenroomHome))
{
    $OpenroomHome = if (-not [string]::IsNullOrWhiteSpace($env:OPENROOM_HOME))
    {
        $env:OPENROOM_HOME
    }
    else
    {
        Join-Path $HOME '.openroom'
    }
}

$hostBridgeDir = Join-Path $OpenroomHome 'host-bridge'
$installed = Join-Path $hostBridgeDir 'aoi_desktop_input.exe'
$built = Join-Path $PSScriptRoot 'aoi_desktop_input.exe'

if ($Uninstall)
{
    if (Test-Path $installed)
    {
        Remove-Item $installed -Force
        Write-Host "[install] removed $installed"
    }
    else
    {
        Write-Host "[install] nothing to remove at $installed"
    }
    Write-Host '[install] the capability toggles are unchanged; turn them off in Settings if you also want the door shut.'
    return
}

if (-not $SkipBuild)
{
    & (Join-Path $PSScriptRoot 'build.ps1')
}
if (-not (Test-Path $built))
{
    throw "aoi_desktop_input.exe not found. Run ./build.ps1 first, or drop the -SkipBuild switch."
}

if (-not (Test-Path $hostBridgeDir))
{
    New-Item -ItemType Directory -Force $hostBridgeDir | Out-Null
}
Copy-Item $built $installed -Force
Write-Host "[install] installed -> $installed"

# Prove the copy actually runs before claiming success. --self-test touches
# neither COM nor the desktop, so this is safe to run unattended.
$probe = & $installed --self-test
if ($probe -notmatch '"ok":true')
{
    throw "the installed helper did not answer its self-test: $probe"
}
Write-Host '[install] self-test ok'

Write-Host ''
Write-Host 'Installed. Computer use is ON by default, so Aoi can now read and drive app'
Write-Host 'windows. To stop all of it at once:'
Write-Host '  Settings > Advanced > Host bridge > "Computer use (drive my PC and browser)"'
Write-Host ''
Write-Host 'Still OFF unless you turn it on separately:'
Write-Host '  "Computer use: synthetic mouse and keyboard"  (takes your real cursor; never verifiable)'
