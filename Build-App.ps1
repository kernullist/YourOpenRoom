<#
.SYNOPSIS
  Build the OpenRoom artifacts: the client bundle, the Aoi daemon bundle, and the
  native desktop-activity capture helper.

.DESCRIPTION
  With no target switch, builds all three. Pass -Client / -Daemon / -Capture to
  build only that subset, or -SkipCapture to build client + daemon but skip the
  native helper (which needs the MSVC toolchain). -Install runs a frozen-lockfile
  install first.

  This is the build counterpart to Start-App.ps1 / Stop-App.ps1. Start-App builds
  lazily (only when a bundle is stale); this script forces a full rebuild, which
  is what you want after pulling changes or before restarting the daemon to pick
  up new /api/aoi-host/* routes.

.PARAMETER Client
  Build only the client bundle (pnpm build).

.PARAMETER Daemon
  Build only the Aoi daemon bundle (pnpm daemon:build).

.PARAMETER Capture
  Build only the native desktop-activity capture helper.

.PARAMETER SkipCapture
  Build client + daemon but skip the native capture helper.

.PARAMETER Install
  Run `pnpm install --frozen-lockfile` before building.

.EXAMPLE
  ./Build-App.ps1
  ./Build-App.ps1 -Daemon
  ./Build-App.ps1 -SkipCapture
#>
[CmdletBinding()]
param(
    [switch]$Client,
    [switch]$Daemon,
    [switch]$Capture,
    [switch]$SkipCapture,
    [switch]$Install
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:ExitCode = 0

function Write-Step
{
    param
    (
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    Write-Host "[build-app] $Message"
}

do
{
    try
    {
        $repoRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd("\")
        $appDir = Join-Path $repoRoot "apps\webuiapps"

        if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "package.json") -PathType Leaf))
        {
            throw "package.json was not found at $repoRoot."
        }

        # No explicit target -> build everything (still honoring -SkipCapture).
        $buildAll = -not ($Client -or $Daemon -or $Capture)
        $doClient = $Client -or $buildAll
        $doDaemon = $Daemon -or $buildAll
        $doCapture = ($Capture -or $buildAll) -and (-not $SkipCapture)

        $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
        if (($doClient -or $doDaemon -or $Install) -and $null -eq $pnpm)
        {
            throw "pnpm was not found in PATH. Install pnpm 9+ first."
        }

        if ($Install)
        {
            Write-Step "Installing dependencies (frozen lockfile)."
            & $pnpm.Source --dir $repoRoot install --frozen-lockfile
            if ($LASTEXITCODE -ne 0)
            {
                throw "pnpm install failed with exit code $LASTEXITCODE."
            }
        }

        if ($doClient)
        {
            Write-Step "Building the client bundle (pnpm build)."
            & $pnpm.Source --dir $repoRoot build
            if ($LASTEXITCODE -ne 0)
            {
                throw "Client build failed with exit code $LASTEXITCODE."
            }
        }

        if ($doDaemon)
        {
            Write-Step "Building the Aoi daemon bundle (pnpm daemon:build)."
            & $pnpm.Source --dir $appDir run daemon:build
            if ($LASTEXITCODE -ne 0)
            {
                throw "Daemon build failed with exit code $LASTEXITCODE."
            }
        }

        if ($doCapture)
        {
            $captureBuild = Join-Path $repoRoot "tools\aoi-desktop-capture\build.ps1"
            if (-not (Test-Path -LiteralPath $captureBuild -PathType Leaf))
            {
                Write-Warning "Capture build script not found at $captureBuild; skipping."
            }
            else
            {
                Write-Step "Building the native desktop-activity capture helper."
                try
                {
                    & $captureBuild
                }
                catch
                {
                    # Non-fatal: the native helper needs the MSVC toolchain. The
                    # client + daemon bundles above are what the app itself needs;
                    # the capture helper is an optional add-on.
                    Write-Warning ("Capture helper build failed (needs MSVC): {0}" -f $_.Exception.Message)
                    $script:ExitCode = 1
                }
            }
        }
        elseif ($SkipCapture)
        {
            Write-Step "Skipping the native capture helper (-SkipCapture)."
        }

        if ($script:ExitCode -eq 0)
        {
            Write-Step "Build complete."
        }
        else
        {
            Write-Step "Build finished with warnings (see above)."
        }
    }
    catch
    {
        Write-Error $_
        $script:ExitCode = 1
    }
} while ($false)

exit $script:ExitCode
