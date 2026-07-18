<#
.SYNOPSIS
  Build the Aoi desktop-activity capture helper (aoi_desktop_capture.exe).

.DESCRIPTION
  Compiles aoi_desktop_capture.cpp with MSVC (cl.exe). If cl.exe is already on
  PATH (e.g. a Developer Prompt), it is used directly. Otherwise the script
  locates a Visual Studio install with vswhere and runs the build inside the
  x64 developer environment (vcvars64.bat).

  Output: aoi_desktop_capture.exe next to the source.

.PARAMETER DebugBuild
  Build an unoptimized debug binary (/Od /Zi) instead of the default /O2 release.

.EXAMPLE
  ./build.ps1
  ./build.ps1 -DebugBuild
#>
[CmdletBinding()]
param(
    [switch]$DebugBuild
)

$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'aoi_desktop_capture.cpp'
$out = Join-Path $PSScriptRoot 'aoi_desktop_capture.exe'

if (-not (Test-Path $src))
{
    throw "Source not found: $src"
}

# cl flags. winhttp.lib/user32.lib are pulled in via #pragma comment(lib,...).
$optFlags = if ($DebugBuild) { '/Od /Zi' } else { '/O2' }
# /Fo pins the intermediate .obj into the tool dir (where .gitignore covers it)
# regardless of the caller's working directory; without it cl drops the .obj in
# the cwd, which can be the repo root. Name the file explicitly (no trailing
# backslash, which would escape the closing quote).
$objFile = Join-Path $PSScriptRoot 'aoi_desktop_capture.obj'
$clFlags = "/nologo /W4 /EHsc /std:c++17 $optFlags"
$clLine = "cl $clFlags `"$src`" /Fo:`"$objFile`" /Fe:`"$out`""

function Invoke-Build
{
    param([string]$CommandLine)

    # If cl is already available, just run it. Route cmd's stdout to the host so
    # it does not pollute this function's return value (only the exit code does).
    $cl = Get-Command cl -ErrorAction SilentlyContinue
    if ($null -ne $cl)
    {
        Write-Host "[build] using cl on PATH: $($cl.Source)"
        cmd /c $CommandLine | Out-Host
        return $LASTEXITCODE
    }

    # Otherwise locate Visual Studio via vswhere and enter vcvars64.
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere))
    {
        throw "cl.exe not on PATH and vswhere not found. Open a 'x64 Native Tools Command Prompt for VS' and re-run, or install Visual Studio Build Tools."
    }
    $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ([string]::IsNullOrWhiteSpace($vsPath))
    {
        throw "No Visual Studio install with the C++ toolset (VC.Tools.x86.x64) was found."
    }
    $vcvars = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
    if (-not (Test-Path $vcvars))
    {
        throw "vcvars64.bat not found under $vsPath."
    }
    Write-Host "[build] entering VS dev env: $vcvars"
    cmd /c "`"$vcvars`" >nul && $CommandLine" | Out-Host
    return $LASTEXITCODE
}

Write-Host "[build] $clLine"
$code = Invoke-Build -CommandLine $clLine
if ($code -ne 0)
{
    throw "Build failed (exit $code)."
}

# cl drops the intermediate .obj next to the source; clean it up.
$obj = Join-Path $PSScriptRoot 'aoi_desktop_capture.obj'
if (Test-Path $obj)
{
    Remove-Item $obj -Force
}

Write-Host "[build] ok -> $out"
