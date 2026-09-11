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

# The installed scheduled task (Install-AoiDesktopCapture.ps1) runs THIS exe from
# THIS directory, so a rebuild while the helper is up fails at link time with
# LNK1104 (the output file is locked). Stop a running instance first, remember
# whether the task owned it, and start the task again after a successful link.
$taskName = 'AoiDesktopCapture'
$taskWasRunning = $false
$helperWasRunning = $false
$running = @(Get-Process -Name 'aoi_desktop_capture' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and ([IO.Path]::GetFullPath($_.Path) -ieq [IO.Path]::GetFullPath($out)) })
if ($running.Count -gt 0)
{
    $helperWasRunning = $true
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -ne $task -and $task.State -eq 'Running')
    {
        $taskWasRunning = $true
        Write-Host "[build] stopping the '$taskName' task so the exe can be replaced."
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    }
    # Remember how the first instance was started (Start-App.ps1 launches it
    # directly with --hide-console --session ...), so it can be restarted the same
    # way once the new exe is in place.
    $restartArgs = $null
    try
    {
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($running[0].Id)" -ErrorAction Stop
        if ($cim -and $cim.CommandLine)
        {
            $cmd = [string]$cim.CommandLine
            $exeToken = if ($cmd.StartsWith('"')) { $cmd.Substring(0, $cmd.IndexOf('"', 1) + 1) } else { ($cmd -split ' ', 2)[0] }
            $restartArgs = $cmd.Substring($exeToken.Length).Trim()
        }
    }
    catch
    {
        $restartArgs = $null
    }
    foreach ($proc in $running)
    {
        Write-Host "[build] stopping running helper (pid $($proc.Id))."
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline)
    {
        $still = Get-Process -Name 'aoi_desktop_capture' -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and ([IO.Path]::GetFullPath($_.Path) -ieq [IO.Path]::GetFullPath($out)) }
        if (-not $still) { break }
        Start-Sleep -Milliseconds 200
    }
}

Write-Host "[build] $clLine"
$code = Invoke-Build -CommandLine $clLine
if ($code -ne 0)
{
    $hint = ''
    if (Get-Process -Name 'aoi_desktop_capture' -ErrorAction SilentlyContinue)
    {
        $hint = " aoi_desktop_capture.exe is still running, so the linker cannot replace it; stop it (or the '$taskName' task) and re-run."
    }
    throw "Build failed (exit $code).$hint"
}

if ($taskWasRunning)
{
    Write-Host "[build] restarting the '$taskName' task."
    Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}
elseif ($helperWasRunning)
{
    if ($null -ne $restartArgs)
    {
        Write-Host "[build] restarting the helper the way it was running: $restartArgs"
        if ([string]::IsNullOrWhiteSpace($restartArgs))
        {
            [void](Start-Process -FilePath $out -WorkingDirectory $PSScriptRoot -WindowStyle Hidden)
        }
        else
        {
            [void](Start-Process -FilePath $out -ArgumentList $restartArgs -WorkingDirectory $PSScriptRoot -WindowStyle Hidden)
        }
    }
    else
    {
        Write-Host "[build] the helper was running outside the '$taskName' task and has been stopped; Start-App.ps1 starts it again."
    }
}

# cl drops the intermediate .obj next to the source; clean it up.
$obj = Join-Path $PSScriptRoot 'aoi_desktop_capture.obj'
if (Test-Path $obj)
{
    Remove-Item $obj -Force
}

Write-Host "[build] ok -> $out"
