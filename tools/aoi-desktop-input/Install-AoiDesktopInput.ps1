<#
.SYNOPSIS
  Install (or remove) the Aoi desktop-input helper for the local daemon.

.DESCRIPTION
  Unlike the capture helper, this one is NOT a resident process and gets no
  scheduled task: the daemon spawns it on demand, one command at a time. So
  installing it means exactly one thing -- putting the built exe where the
  daemon looks:

      ~/.openroom/host-bridge/aoi_desktop_input.exe

  Installing grants nothing. The daemon refuses every desktop-input request
  until the operator separately turns on the os_desktop_input capability in
  Settings > Advanced > Host bridge, and the synthetic-mouse fallback stays off
  until os_desktop_input_foreground is turned on as well. Both default OFF and
  both are killed by global panic. Copying a file here does not open that door;
  it only means the door has something behind it.

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
Write-Host 'Installed, but NOT enabled. Aoi still cannot touch the desktop until you turn on:'
Write-Host '  Settings > Advanced > Host bridge > "Desktop input (drive real windows)"'
Write-Host 'and, only if you want the synthetic-mouse fallback as well:'
Write-Host '  "Desktop input: synthetic mouse"  (moves your real cursor; never verifiable)'
