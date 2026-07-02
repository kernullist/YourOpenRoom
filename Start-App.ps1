[CmdletBinding()]
param
(
    [int]$Port = 3000,
    [string]$HostAddress = "127.0.0.1",
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

        # The Aoi daemon is a long-lived service; only Stop-App.ps1 ends it.
        if ($commandLine -like "*aoiDaemonServer.js*")
        {
            continue
        }

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
                $commandLine = Get-ProcessCommandLine -Process $process
                if ($commandLine -like "*aoiDaemonServer.js*")
                {
                    continue
                }

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
                        CommandLine = (Get-ProcessCommandLine -Process $process)
                    }
                }
            }
        ) | Sort-Object ProcessId -Unique
    )

    if ($targets.Count -eq 0)
    {
        Write-Step "No existing OpenRoom dev server was found."
        return
    }

    Write-Step "Stopping stale OpenRoom dev processes."
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

function Get-OpenRoomDevServerListener
{
    param
    (
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [Parameter(Mandatory = $true)]
        [int]$PortToCheck
    )

    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $PortToCheck -ErrorAction SilentlyContinue)

    foreach ($listener in $listeners)
    {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
        if ($null -eq $owner)
        {
            continue
        }

        $commandLine = Get-ProcessCommandLine -Process $owner
        if ($commandLine -like "*$RepoRoot*" -and $commandLine -like "*vite*")
        {
            return [pscustomobject]@{
                ProcessId = [int]$owner.ProcessId
                Name = $owner.Name
            }
        }
    }

    return $null
}

function Get-AoiDaemonPort
{
    $rawPort = $env:AOI_DAEMON_PORT
    $parsedPort = 0

    if (-not [string]::IsNullOrWhiteSpace($rawPort) -and
        [int]::TryParse($rawPort, [ref]$parsedPort) -and
        $parsedPort -gt 0 -and
        $parsedPort -le 65535)
    {
        return $parsedPort
    }

    return 7333
}

function Get-AoiDaemonProcesses
{
    param
    (
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $daemonProcesses = @()
    $nodeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue)

    foreach ($process in $nodeProcesses)
    {
        $commandLine = Get-ProcessCommandLine -Process $process
        if ($commandLine -like "*$RepoRoot*" -and $commandLine -like "*aoiDaemonServer.js*")
        {
            $daemonProcesses += $process
        }
    }

    return $daemonProcesses
}

function Get-AoiDaemonSourceNewestWriteTimeUtc
{
    param
    (
        [Parameter(Mandatory = $true)]
        [string]$AppDir
    )

    $newest = [datetime]::MinValue
    $srcDir = Join-Path $AppDir "src"

    if (Test-Path -LiteralPath $srcDir -PathType Container)
    {
        foreach ($file in @(Get-ChildItem -LiteralPath $srcDir -Recurse -File -ErrorAction SilentlyContinue))
        {
            if ($file.Extension -ne ".ts" -and $file.Extension -ne ".tsx")
            {
                continue
            }

            if ($file.LastWriteTimeUtc -gt $newest)
            {
                $newest = $file.LastWriteTimeUtc
            }
        }
    }

    $daemonConfig = Join-Path $AppDir "vite.daemon.config.ts"
    if (Test-Path -LiteralPath $daemonConfig -PathType Leaf)
    {
        $configItem = Get-Item -LiteralPath $daemonConfig
        if ($configItem.LastWriteTimeUtc -gt $newest)
        {
            $newest = $configItem.LastWriteTimeUtc
        }
    }

    return $newest
}

function Test-AoiDaemonBundleStale
{
    param
    (
        [Parameter(Mandatory = $true)]
        [string]$AppDir,

        [Parameter(Mandatory = $true)]
        [string]$BundlePath
    )

    if (-not (Test-Path -LiteralPath $BundlePath -PathType Leaf))
    {
        return $true
    }

    $bundleTime = (Get-Item -LiteralPath $BundlePath).LastWriteTimeUtc
    $newestSourceTime = Get-AoiDaemonSourceNewestWriteTimeUtc -AppDir $AppDir

    return $newestSourceTime -gt $bundleTime
}

function Start-AoiDaemon
{
    param
    (
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [Parameter(Mandatory = $true)]
        [string]$AppDir,

        [Parameter(Mandatory = $true)]
        [string]$PnpmPath
    )

    $daemonPort = Get-AoiDaemonPort
    $bundlePath = Join-Path $AppDir "dist-daemon\aoiDaemonServer.js"

    if (Test-AoiDaemonBundleStale -AppDir $AppDir -BundlePath $bundlePath)
    {
        Write-Step "Building Aoi daemon bundle (dist-daemon is missing or older than src)."
        & $PnpmPath --dir $AppDir run daemon:build
        if ($LASTEXITCODE -ne 0)
        {
            throw "pnpm daemon:build failed with exit code $LASTEXITCODE."
        }
    }

    if (-not (Test-Path -LiteralPath $bundlePath -PathType Leaf))
    {
        throw "Aoi daemon bundle was not found at $bundlePath."
    }

    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand)
    {
        throw "node was not found in PATH."
    }

    $stdoutLog = Join-Path $AppDir "dist-daemon\aoi-daemon.out.log"
    $stderrLog = Join-Path $AppDir "dist-daemon\aoi-daemon.err.log"

    # Jarvis autonomy (cognition/memory/proactive tier). These make Aoi think,
    # propose, remember, and reach out MORE; none of them run a side-effecting
    # action without the existing approval gates, so they are safe to default on.
    # Set only when unset so an explicit shell value still wins, and the node
    # daemon (started below) inherits them. AOI_AUTONOMY_BACKGROUND=0 is still the
    # hard off switch.
    #
    # Action tier (operator-enabled): these reduce human-in-the-loop friction and
    # open real effects. They still require earned trusted_operator readiness plus
    # the unchanged hard gates -- L5 + content-addressed approval, per-call
    # irreversibility ack for side-effecting connectors, and the DNS-rebind guard --
    # so flipping them on does not by itself let Aoi act without approval; it opens
    # the capability once the operator promotion is earned. Auto-promotion is left
    # off on purpose: the level is pinned at L5 manually, so auto-promote (hard-cap
    # L4) could only roll it back.
    $jarvisAutonomyEnv = [ordered]@{
        'AOI_AUTONOMY_GOAL_SYNTHESIS'         = '1'
        'AOI_AUTONOMY_CONSOLIDATION'          = '1'
        'AOI_AUTONOMY_EMBED_SWEEP'            = '1'
        'AOI_AUTONOMY_IDLE_CONFIDENCE_SURGE'  = '1'
        'AOI_AUTONOMY_FIELD_SHADOW_CAPTURE'   = '1'
        'AOI_AUTONOMY_APP_OP_LIVE_DISPATCH'   = '1'
        'AOI_AUTONOMY_APPROVAL_TTL'           = '1'
        'AOI_MCP_SIDE_EFFECTING_RPC'          = '1'
    }
    foreach ($key in $jarvisAutonomyEnv.Keys)
    {
        if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($key)))
        {
            [Environment]::SetEnvironmentVariable($key, $jarvisAutonomyEnv[$key])
        }
    }

    Write-Step ("Starting Aoi daemon on port {0} (logs: apps\webuiapps\dist-daemon\aoi-daemon.*.log)." -f $daemonPort)

    # The absolute bundle path keeps the repo root in the command line, which is
    # what Get-AoiDaemonProcesses and the dev-cleanup exemption match against.
    $daemonProcess = Start-Process -FilePath $nodeCommand.Source `
        -ArgumentList @('"{0}"' -f $bundlePath) `
        -WorkingDirectory $AppDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog `
        -PassThru

    $deadline = [datetime]::UtcNow.AddSeconds(15)
    $listening = $false

    while ([datetime]::UtcNow -lt $deadline)
    {
        if ($daemonProcess.HasExited)
        {
            break
        }

        $listener = Get-NetTCPConnection -State Listen -LocalPort $daemonPort -ErrorAction SilentlyContinue |
            Where-Object { [int]$_.OwningProcess -eq [int]$daemonProcess.Id } |
            Select-Object -First 1

        if ($null -ne $listener)
        {
            $listening = $true
            break
        }

        Start-Sleep -Milliseconds 250
    }

    if (-not $listening)
    {
        $errorTail = ""
        if (Test-Path -LiteralPath $stderrLog -PathType Leaf)
        {
            $errorTail = ((Get-Content -LiteralPath $stderrLog -Tail 10 -ErrorAction SilentlyContinue) -join "`n")
        }

        if ($daemonProcess.HasExited)
        {
            throw "Aoi daemon exited early (exit code $($daemonProcess.ExitCode)). $errorTail"
        }

        Stop-Process -Id $daemonProcess.Id -Force -ErrorAction SilentlyContinue
        throw "Aoi daemon did not listen on port $daemonPort within 15 seconds. $errorTail"
    }

    Write-Step ("Aoi daemon is running (PID {0}, http://127.0.0.1:{1})." -f $daemonProcess.Id, $daemonPort)
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

        # Aoi daemon: start it only when it is not already running.
        $daemonProcesses = @(Get-AoiDaemonProcesses -RepoRoot $repoRoot)
        if ($daemonProcesses.Count -gt 0)
        {
            $daemonPids = ($daemonProcesses | ForEach-Object { $_.ProcessId }) -join ", "
            Write-Step ("Aoi daemon already running (PID {0}, port {1})." -f $daemonPids, (Get-AoiDaemonPort))
        }
        else
        {
            try
            {
                Start-AoiDaemon -RepoRoot $repoRoot -AppDir $appDir -PnpmPath $pnpmCommand.Source
            }
            catch
            {
                Write-Warning ("Aoi daemon start failed: {0}" -f $_.Exception.Message)
                Write-Step "Continuing with the dev server only."
            }
        }

        # Dev server: leave a healthy running instance alone.
        $devListener = Get-OpenRoomDevServerListener -RepoRoot $repoRoot -PortToCheck $Port
        if ($null -ne $devListener)
        {
            Write-Step ("Dev server already running on port {0} (PID {1})." -f $Port, $devListener.ProcessId)
            Write-Step "Nothing to start. Use .\Stop-App.ps1 to stop everything."
            break
        }

        Stop-ExistingOpenRoomDevServers -RepoRoot $repoRoot -CurrentProcessId ([int]$PID)
        Assert-PortAvailable -PortToCheck $Port

        if ($Install)
        {
            if (-not (Test-Path -LiteralPath $lockFile -PathType Leaf))
            {
                throw "pnpm-lock.yaml was not found."
            }

            Write-Step "Installing dependencies with frozen lockfile."
            & $pnpmCommand.Source --dir $repoRoot install --frozen-lockfile
            if ($LASTEXITCODE -ne 0)
            {
                throw "pnpm install failed with exit code $LASTEXITCODE."
            }
        }

        Write-Step "Starting Vite dev server."
        Write-Step "Press Ctrl+C to stop the dev server. The Aoi daemon keeps running; use .\Stop-App.ps1 to stop everything."
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
