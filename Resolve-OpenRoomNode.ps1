<#
.SYNOPSIS
  Resolve a modern Node.js (>= 18) for OpenRoom scripts and put it first on PATH.

.DESCRIPTION
  Windows PATH often picks up a stale bundled node.exe first (for example
  Adobe Brackets ships Node 6). Vite/pnpm then fail with:
    SyntaxError: Unexpected token import

  This script finds a usable Node 18+ binary, prefers the newest version among
  eligible installs (so a fresh Node 24 install wins over Hermes Node 22 or
  Brackets Node 6), prepends its directory to the current process PATH, and
  returns the absolute path to node.exe.

  Optional override: set OPENROOM_NODE to a full path of node.exe, or set
  OPENROOM_NODE_DIR to a directory that contains node.exe. Overrides always win
  when they point at a Node that meets MinimumMajor.

.OUTPUTS
  System.String - absolute path of the selected node.exe
#>
[CmdletBinding()]
param
(
    [int]$MinimumMajor = 18
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-NodeVersionInfo
{
    param
    (
        [Parameter(Mandatory = $true)]
        [string]$NodePath
    )

    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf))
    {
        return $null
    }

    try
    {
        $raw = & $NodePath -v 2>$null
        if ($null -eq $raw)
        {
            return $null
        }

        $text = ([string]$raw).Trim().TrimStart('v')
        if ($text -notmatch '^(\d+)\.(\d+)\.(\d+)')
        {
            return $null
        }

        $version = [version]::new(
            [int]$Matches[1],
            [int]$Matches[2],
            [int]$Matches[3]
        )

        return [pscustomobject]@{
            Path = $NodePath
            Version = $version
            Display = ("v{0}" -f $text)
        }
    }
    catch
    {
        return $null
    }
}

function Add-CandidatePath
{
    param
    (
        [System.Collections.Generic.List[string]]$List,
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path))
    {
        return
    }

    $full = $null
    try
    {
        $full = [System.IO.Path]::GetFullPath($Path)
    }
    catch
    {
        return
    }

    if (-not (Test-Path -LiteralPath $full -PathType Leaf))
    {
        return
    }

    if (-not $List.Contains($full))
    {
        $List.Add($full)
    }
}

function Get-NodeCandidatePaths
{
    param
    (
        [switch]$IncludeOverrides
    )

    $candidates = [System.Collections.Generic.List[string]]::new()

    if ($IncludeOverrides)
    {
        if (-not [string]::IsNullOrWhiteSpace($env:OPENROOM_NODE))
        {
            Add-CandidatePath -List $candidates -Path $env:OPENROOM_NODE
        }

        if (-not [string]::IsNullOrWhiteSpace($env:OPENROOM_NODE_DIR))
        {
            Add-CandidatePath -List $candidates -Path (Join-Path $env:OPENROOM_NODE_DIR "node.exe")
        }

        return $candidates
    }

    # Official / manager roots first for discovery only; final pick is by
    # highest version, so order here only affects enumeration cost.
    $knownDirs = @(
        "C:\Program Files\nodejs",
        "C:\Program Files (x86)\nodejs",
        (Join-Path $env:LOCALAPPDATA "Programs\nodejs"),
        (Join-Path $env:LOCALAPPDATA "hermes\node"),
        (Join-Path $env:APPDATA "nvm"),
        (Join-Path $env:LOCALAPPDATA "fnm_multishells"),
        (Join-Path $env:USERPROFILE ".volta\bin"),
        (Join-Path $env:LOCALAPPDATA "Volta\bin"),
        (Join-Path $env:USERPROFILE ".bun\bin")
    )

    foreach ($dir in $knownDirs)
    {
        if ([string]::IsNullOrWhiteSpace($dir))
        {
            continue
        }

        if (Test-Path -LiteralPath $dir -PathType Container)
        {
            Add-CandidatePath -List $candidates -Path (Join-Path $dir "node.exe")

            # nvm-windows / fnm layout: nested version folders with node.exe
            try
            {
                $nested = @(Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue |
                    Sort-Object Name -Descending |
                    Select-Object -First 12)
                foreach ($folder in $nested)
                {
                    Add-CandidatePath -List $candidates -Path (Join-Path $folder.FullName "node.exe")
                }
            }
            catch
            {
                # ignore enumeration failures
            }
        }
    }

    $pathEntries = @($env:Path -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    foreach ($entry in $pathEntries)
    {
        Add-CandidatePath -List $candidates -Path (Join-Path $entry.Trim('"') "node.exe")
    }

    $commands = @(Get-Command node -All -ErrorAction SilentlyContinue)
    foreach ($command in $commands)
    {
        if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace($command.Source))
        {
            Add-CandidatePath -List $candidates -Path $command.Source
        }
    }

    return $candidates
}

function Select-BestNode
{
    param
    (
        [string[]]$CandidatePaths,
        [int]$MinimumMajor
    )

    $rejected = [System.Collections.Generic.List[string]]::new()
    $best = $null

    foreach ($candidate in $CandidatePaths)
    {
        $info = Get-NodeVersionInfo -NodePath $candidate
        if ($null -eq $info)
        {
            $rejected.Add(("$candidate (unreadable version)"))
            continue
        }

        if ($info.Version.Major -lt $MinimumMajor)
        {
            $rejected.Add(("$candidate ({0})" -f $info.Display))
            continue
        }

        if ($null -eq $best -or $info.Version -gt $best.Version)
        {
            $best = $info
        }
    }

    return [pscustomobject]@{
        Selected = $best
        Rejected = $rejected
    }
}

# Explicit override always wins when it meets the minimum.
$overridePaths = @(Get-NodeCandidatePaths -IncludeOverrides)
if ($overridePaths.Count -gt 0)
{
    $overridePick = Select-BestNode -CandidatePaths $overridePaths -MinimumMajor $MinimumMajor
    if ($null -ne $overridePick.Selected)
    {
        $selected = $overridePick.Selected
    }
    else
    {
        $detail = ""
        if ($overridePick.Rejected.Count -gt 0)
        {
            $detail = " Override was: " + ($overridePick.Rejected -join "; ") + "."
        }

        throw ("OPENROOM_NODE / OPENROOM_NODE_DIR does not point at Node.js $MinimumMajor+.$detail")
    }
}
else
{
    $candidates = @(Get-NodeCandidatePaths)
    $pick = Select-BestNode -CandidatePaths $candidates -MinimumMajor $MinimumMajor
    $selected = $pick.Selected

    if ($null -eq $selected)
    {
        $detail = ""
        if ($pick.Rejected.Count -gt 0)
        {
            $detail = " Found only incompatible node.exe: " + ($pick.Rejected -join "; ") + "."
        }

        throw ("Node.js $MinimumMajor+ is required (README). No suitable node.exe was found.$detail " +
            "Install Node 18+ from https://nodejs.org and ensure it is on PATH ahead of editor-bundled " +
            "binaries (e.g. Brackets Node 6). Or set OPENROOM_NODE to the full path of node.exe.")
    }
}

$nodeDir = [System.IO.Path]::GetDirectoryName($selected.Path)
$pathParts = @($env:Path -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

# Drop the selected dir if already present, then put it first so pnpm/vite/shims
# all resolve this node.exe.
$filtered = @(
    foreach ($part in $pathParts)
    {
        $trimmed = $part.Trim('"')
        if ($trimmed -ieq $nodeDir)
        {
            continue
        }

        $trimmed
    }
)

$env:Path = (@($nodeDir) + $filtered) -join ';'

# Also export for scheduled tasks / child scripts that read it.
$env:OPENROOM_NODE = $selected.Path

return $selected.Path
