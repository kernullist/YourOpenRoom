[CmdletBinding()]
param
(
    [int[]]$Ports = @(3000, 3001, 3100, 5173, 5180),
    [switch]$DryRun
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

function Find-OpenRoomDevProcesses
{
    param
    (
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [Parameter(Mandatory = $true)]
        [int[]]$KnownPorts,

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
    $targetPorts = @($KnownPorts) | Sort-Object -Unique
    $allProcesses = @(Get-CimInstance Win32_Process)
    $byPid = @{}

    foreach ($process in $allProcesses)
    {
        $byPid[[int]$process.ProcessId] = $process
    }

    $targetIds = [System.Collections.Generic.HashSet[int]]::new()
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $targetPorts -contains [int]$_.LocalPort })

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
            $commandLine -like "*Start-App.ps1*" -or
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
        @(
            foreach ($targetId in $targetIds)
            {
                if ($byPid.ContainsKey($targetId))
                {
                    $process = $byPid[$targetId]
                    [pscustomobject]@{
                        ProcessId = [int]$process.ProcessId
                        Name = $process.Name
                        ParentProcessId = [int]$process.ParentProcessId
                        CommandLine = (Get-ProcessCommandLine -Process $process)
                    }
                }
            }
        ) | Sort-Object ProcessId -Unique
    )

    return @($targets)
}

function Find-RemainingOpenRoomDevProcesses
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

    $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $remaining = @(
        @(
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
                if ($commandLine -like "*$RepoRoot*")
                {
                    [pscustomobject]@{
                        ProcessId = $processId
                        Name = $process.Name
                        CommandLine = $commandLine
                    }
                }
            }
        ) | Sort-Object ProcessId -Unique
    )

    return @($remaining)
}

do
{
    try
    {
        $repoRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd("\")
        $rootPackageJson = Join-Path $repoRoot "package.json"
        $appPackageJson = Join-Path $repoRoot "apps\webuiapps\package.json"
        $currentProcessId = [int]$PID

        if (-not (Test-Path -LiteralPath $rootPackageJson -PathType Leaf))
        {
            throw "package.json was not found at $repoRoot."
        }

        if (-not (Test-Path -LiteralPath $appPackageJson -PathType Leaf))
        {
            throw "apps\webuiapps\package.json was not found."
        }

        Write-Step "Repo: $repoRoot"
        Write-Step ("Ports: {0}" -f (($Ports | Sort-Object -Unique) -join ", "))

        $round = 0
        $sawTargets = $false
        while ($round -lt 4)
        {
            $round++
            $targets = @(
                Find-OpenRoomDevProcesses `
                    -RepoRoot $repoRoot `
                    -KnownPorts $Ports `
                    -CurrentProcessId $currentProcessId
            )

            if ($targets.Count -eq 0)
            {
                if (-not $sawTargets)
                {
                    Write-Step "No OpenRoom dev process was found."
                }
                break
            }

            $sawTargets = $true
            Write-Step ("Matched OpenRoom dev processes. Round {0}." -f $round)
            $targets |
                Select-Object ProcessId, Name, ParentProcessId, CommandLine |
                Format-Table -AutoSize -Wrap

            if ($DryRun)
            {
                Write-Step "Dry run only. No process was stopped."
                break
            }

            Write-Step "Stopping matched processes."
            Stop-Process -Id ($targets.ProcessId) -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 1200
        }

        if ($DryRun)
        {
            break
        }

        $remainingPorts = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { ($Ports -contains [int]$_.LocalPort) -and $_.OwningProcess -in $targets.ProcessId })
        $remainingProcesses = @(
            Find-RemainingOpenRoomDevProcesses `
                -RepoRoot $repoRoot `
                -CurrentProcessId $currentProcessId
        )

        if ($remainingPorts.Count -eq 0 -and $remainingProcesses.Count -eq 0)
        {
            Write-Step "Stopped all matched OpenRoom dev processes."
            break
        }

        if ($remainingPorts.Count -gt 0)
        {
            Write-Step "Some matched ports are still listening."
            $remainingPorts |
                Select-Object LocalAddress, LocalPort, OwningProcess |
                Format-Table -AutoSize
        }

        if ($remainingProcesses.Count -gt 0)
        {
            Write-Step "Some repo dev processes are still running."
            $remainingProcesses |
                Select-Object ProcessId, Name, CommandLine |
                Format-Table -AutoSize -Wrap
        }

        $script:ExitCode = 1
    }
    catch
    {
        Write-Error $_
        $script:ExitCode = 1
    }
} while ($false)

exit $script:ExitCode
