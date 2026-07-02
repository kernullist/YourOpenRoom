[CmdletBinding()]
param
(
    [int]$Port = 3000,
    [string]$HostAddress = "127.0.0.1",
    [switch]$NoCleanup,
    [switch]$Install,
    [switch]$Aoi,
    [switch]$Stop
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

        # The Aoi daemon is a long-lived service and is only stopped by -Stop.
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
    $running = @(Get-AoiDaemonProcesses -RepoRoot $RepoRoot)

    if ($running.Count -gt 0)
    {
        $pids = ($running | ForEach-Object { $_.ProcessId }) -join ", "
        Write-Step ("Aoi daemon already running (PID {0}, port {1})." -f $pids, $daemonPort)
        return
    }

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

function Stop-AoiDaemon
{
    param
    (
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $running = @(Get-AoiDaemonProcesses -RepoRoot $RepoRoot)

    if ($running.Count -eq 0)
    {
        Write-Step "No Aoi daemon is running."
        return
    }

    foreach ($process in $running)
    {
        Write-Step ("Stop aoi-daemon node.exe:{0}" -f $process.ProcessId)
    }

    Stop-Process -Id (@($running | ForEach-Object { [int]$_.ProcessId })) -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500

    $remaining = @(Get-AoiDaemonProcesses -RepoRoot $RepoRoot)
    if ($remaining.Count -gt 0)
    {
        $pids = ($remaining | ForEach-Object { $_.ProcessId }) -join ", "
        Write-Warning ("Aoi daemon did not stop cleanly (PID {0})." -f $pids)
    }
    else
    {
        Write-Step "Aoi daemon stopped."
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

        if ($Stop)
        {
            Write-Step "Stop requested: shutting down the dev server and the Aoi daemon."
            Stop-ExistingOpenRoomDevServers -RepoRoot $repoRoot -CurrentProcessId ([int]$PID)
            Stop-AoiDaemon -RepoRoot $repoRoot
            break
        }

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

        if ($Aoi)
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
        if ($Aoi)
        {
            Write-Step "Press Ctrl+C to stop the dev server. The Aoi daemon keeps running; use .\Start-App.ps1 -Stop to stop everything."
        }
        else
        {
            Write-Step "Press Ctrl+C to stop."
        }

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
