[CmdletBinding()]
param
(
    [int]$Port = 3000,
    [string]$HostAddress = "127.0.0.1",
    [switch]$NoCleanup,
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

    Write-Host "[openroom] $Message"
}

function Get-ProcessCommandLine
{
    param
    (
        [Parameter(Mandatory = $true)]
        [object]$Process
    )

    if ($null -eq $Process.CommandLine)
    {
        return ""
    }

    return [string]$Process.CommandLine
}

function Add-TargetProcess
{
    param
    (
        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.HashSet[int]]$TargetIds,

        [Parameter(Mandatory = $true)]
        [int]$ProcessId,

        [Parameter(Mandatory = $true)]
        [int]$CurrentProcessId
    )

    if ($ProcessId -gt 0 -and $ProcessId -ne $CurrentProcessId)
    {
        [void]$TargetIds.Add($ProcessId)
    }
}

function Stop-ExistingOpenRoomDevServers
{
    param
    (
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [Parameter(Mandatory = $true)]
        [int]$CurrentProcessId
    )

    $devNames = @(
        "node.exe",
        "pnpm.exe",
        "cmd.exe",
        "powershell.exe",
        "pwsh.exe",
        "esbuild.exe"
    )
    $knownPorts = @($Port, 3000, 3001, 3100, 5173, 5180) | Sort-Object -Unique
    $allProcesses = @(Get-CimInstance Win32_Process)
    $byPid = @{}

    foreach ($process in $allProcesses)
    {
        $byPid[[int]$process.ProcessId] = $process
    }

    $targetIds = [System.Collections.Generic.HashSet[int]]::new()
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $knownPorts -contains [int]$_.LocalPort })

    foreach ($listener in $listeners)
    {
        $ownerProcessId = [int]$listener.OwningProcess
        if (-not $byPid.ContainsKey($ownerProcessId))
        {
            continue
        }

        $owner = $byPid[$ownerProcessId]
        $ownerCommandLine = Get-ProcessCommandLine -Process $owner
        if ($ownerCommandLine -like "*$RepoRoot*" -and $ownerCommandLine -like "*vite*")
        {
            Add-TargetProcess -TargetIds $targetIds -ProcessId $ownerProcessId -CurrentProcessId $CurrentProcessId
        }
    }

    foreach ($process in $allProcesses)
    {
        $processId = [int]$process.ProcessId
        if ($processId -eq $CurrentProcessId)
        {
            continue
        }

        if (-not ($devNames -contains $process.Name))
        {
            continue
        }

        $commandLine = Get-ProcessCommandLine -Process $process
        $isRepoProcess = $commandLine -like "*$RepoRoot*"
        $isDevCommand = (
            $commandLine -like "*vite*" -or
            $commandLine -like "*@openroom/webuiapps*" -or
            ($commandLine -like "*apps\webuiapps*" -and $commandLine -like "* dev*")
        )

        if ($isRepoProcess -and $isDevCommand)
        {
            Add-TargetProcess -TargetIds $targetIds -ProcessId $processId -CurrentProcessId $CurrentProcessId
        }
    }

    $changed = $true
    while ($changed)
    {
        $changed = $false
        foreach ($process in $allProcesses)
        {
            $processId = [int]$process.ProcessId
            $parentProcessId = [int]$process.ParentProcessId
            if ($processId -eq $CurrentProcessId)
            {
                continue
            }

            if ($targetIds.Contains($parentProcessId) -and ($devNames -contains $process.Name))
            {
                if ($targetIds.Add($processId))
                {
                    $changed = $true
                }
            }
        }
    }

    $targets = @(
        foreach ($targetId in $targetIds)
        {
            if ($byPid.ContainsKey($targetId))
            {
                $process = $byPid[$targetId]
                [pscustomobject]@{
                    ProcessId = [int]$process.ProcessId
                    Name = $process.Name
                    CommandLine = (Get-ProcessCommandLine -Process $process)
                }
            }
        }
    ) | Sort-Object ProcessId -Unique

    if ($targets.Count -eq 0)
    {
        Write-Step "No existing OpenRoom dev server was found."
        return
    }

    Write-Step "Stopping existing OpenRoom dev processes."
    foreach ($target in $targets)
    {
        Write-Step ("Stop {0}:{1}" -f $target.Name, $target.ProcessId)
    }

    Stop-Process -Id ($targets.ProcessId) -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1200
}

function Assert-PortAvailable
{
    param
    (
        [Parameter(Mandatory = $true)]
        [int]$PortToCheck
    )

    $listener = Get-NetTCPConnection -State Listen -LocalPort $PortToCheck -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if ($null -ne $listener)
    {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
        if ($null -ne $owner)
        {
            $name = $owner.Name
        }
        else
        {
            $name = "unknown"
        }

        throw "Port $PortToCheck is already in use by PID $($listener.OwningProcess) ($name)."
    }
}

do
{
    try
    {
        $repoRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd("\")
        $appDir = Join-Path $repoRoot "apps\webuiapps"
        $appPackageJson = Join-Path $appDir "package.json"
        $rootPackageJson = Join-Path $repoRoot "package.json"
        $lockFile = Join-Path $repoRoot "pnpm-lock.yaml"

        if (-not (Test-Path -LiteralPath $rootPackageJson -PathType Leaf))
        {
            throw "package.json was not found at $repoRoot."
        }

        if (-not (Test-Path -LiteralPath $appPackageJson -PathType Leaf))
        {
            throw "apps\webuiapps\package.json was not found."
        }

        $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
        if ($null -eq $pnpmCommand)
        {
            throw "pnpm was not found in PATH. Install pnpm 9+ first."
        }

        Write-Step "Repo: $repoRoot"
        Write-Step "App: $appDir"
        Write-Step "URL: http://$HostAddress`:$Port"

        if (-not $NoCleanup)
        {
            Stop-ExistingOpenRoomDevServers -RepoRoot $repoRoot -CurrentProcessId ([int]$PID)
        }

        Assert-PortAvailable -PortToCheck $Port

        if ($Install)
        {
            if (-not (Test-Path -LiteralPath $lockFile -PathType Leaf))
            {
                throw "pnpm-lock.yaml was not found."
            }

            Write-Step "Installing dependencies with frozen lockfile."
            & $pnpmCommand.Source install --frozen-lockfile
            if ($LASTEXITCODE -ne 0)
            {
                throw "pnpm install failed with exit code $LASTEXITCODE."
            }
        }

        Write-Step "Starting Vite dev server."
        Write-Step "Press Ctrl+C to stop."
        & $pnpmCommand.Source --dir $appDir dev --host $HostAddress --port $Port --strictPort
        $script:ExitCode = $LASTEXITCODE
    }
    catch
    {
        Write-Error $_
        $script:ExitCode = 1
    }
} while ($false)

exit $script:ExitCode
