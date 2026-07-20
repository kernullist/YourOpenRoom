[CmdletBinding()]
param
(
    [int]$Port = 3000,
    [string]$HostAddress = "127.0.0.1",
    [switch]$Install,
    # Also register the boot-persistent Aoi daemon service (scheduled task, survives
    # logoff/reboot). Needs an elevated shell; without it Start-App still runs the
    # self-healing in-process supervised daemon for this session.
    [switch]$InstallService,
    # Force the in-process supervised daemon even if the boot service task exists.
    [switch]$NoService,
    # Skip starting the Aoi desktop-activity capture helper.
    [switch]$NoCapture,
    # Also build + register the boot-persistent desktop capture task (needs MSVC
    # for the build, elevation for the task). Without it, Start-App runs the built
    # capture exe directly for this session when it is present.
    [switch]$InstallCaptureService
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

function Confirm-AoiDaemonBundle
{
    param
    (
        [Parameter(Mandatory = $true)]
        [string]$AppDir,

        [Parameter(Mandatory = $true)]
        [string]$PnpmPath
    )

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

    return $bundlePath
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
    $bundlePath = Confirm-AoiDaemonBundle -AppDir $AppDir -PnpmPath $PnpmPath

    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand)
    {
        throw "node was not found in PATH."
    }

    $stdoutLog = Join-Path $AppDir "dist-daemon\aoi-daemon.out.log"
    $stderrLog = Join-Path $AppDir "dist-daemon\aoi-daemon.err.log"

    # Jarvis autonomy env, single-sourced so the in-process launch here and the
    # boot-persistent scheduled task run with the identical tier. Set only when
    # unset (an explicit shell value still wins); the daemon started below and its
    # supervised child both inherit them. AOI_AUTONOMY_BACKGROUND=0 is still the
    # hard off switch; autonomous self-execution stays behind its own gate.
    . (Join-Path $RepoRoot "Set-AoiDaemonEnv.ps1")
    Set-AoiDaemonEnv

    Write-Step ("Starting supervised Aoi daemon on port {0} (self-healing; logs: apps\webuiapps\dist-daemon\aoi-daemon.*.log)." -f $daemonPort)

    # --supervise keeps a child daemon alive across crashes (restart + backoff +
    # crash-loop guard). The launched process is the SUPERVISOR; the real HTTP
    # server is the child it spawns, so the port listener is owned by the child,
    # not by $daemonProcess.Id. The absolute bundle path keeps the repo root in the
    # command line, which is what Get-AoiDaemonProcesses and the dev-cleanup
    # exemption match against.
    $daemonProcess = Start-Process -FilePath $nodeCommand.Source `
        -ArgumentList @(('"{0}"' -f $bundlePath), '--supervise') `
        -WorkingDirectory $AppDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog `
        -PassThru

    $deadline = [datetime]::UtcNow.AddSeconds(20)
    $listening = $false

    while ([datetime]::UtcNow -lt $deadline)
    {
        if ($daemonProcess.HasExited)
        {
            break
        }

        # Any listener on the Aoi daemon port -- the supervised child owns it.
        $listener = Get-NetTCPConnection -State Listen -LocalPort $daemonPort -ErrorAction SilentlyContinue |
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
            throw "Aoi supervisor exited early (exit code $($daemonProcess.ExitCode)). $errorTail"
        }

        Stop-Process -Id $daemonProcess.Id -Force -ErrorAction SilentlyContinue
        throw "Aoi daemon did not listen on port $daemonPort within 20 seconds. $errorTail"
    }

    Write-Step ("Supervised Aoi daemon is running (supervisor PID {0}, http://127.0.0.1:{1})." -f $daemonProcess.Id, $daemonPort)
}

# Bring up the boot-persistent daemon service (Scheduled Task 'AoiAutonomyDaemon'),
# which survives logoff/reboot -- start-at-logon + the in-task supervisor. Registering
# it needs elevation, so that is opt-in ($AllowInstall, from -InstallService); by
# default we only USE an already-registered task. Returns $true when the daemon is
# listening under the task; $false otherwise, so the caller falls back to the
# no-admin in-process supervisor.
function Start-AoiDaemonBootService
{
    param
    (
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [switch]$AllowInstall
    )

    if ($null -eq (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue))
    {
        return $false
    }

    $taskName = 'AoiAutonomyDaemon'
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

    if ($null -eq $existing)
    {
        if (-not $AllowInstall)
        {
            return $false
        }

        $installer = Join-Path $RepoRoot "Install-AoiDaemonService.ps1"
        if (-not (Test-Path -LiteralPath $installer -PathType Leaf))
        {
            return $false
        }

        Write-Step "Registering the boot-persistent Aoi daemon service (Scheduled Task '$taskName')."
        try
        {
            & $installer -SkipBuild
        }
        catch
        {
            Write-Warning ("Service registration failed (run PowerShell as Administrator to install it): {0}" -f $_.Exception.Message)
        }

        $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($null -eq $existing)
        {
            Write-Warning "Could not register the boot service (needs elevation). Using the in-process supervisor instead."
            return $false
        }
    }

    try
    {
        Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    }
    catch
    {
        Write-Warning ("Starting the Aoi daemon service task failed: {0}" -f $_.Exception.Message)
        return $false
    }

    $daemonPort = Get-AoiDaemonPort
    $deadline = [datetime]::UtcNow.AddSeconds(25)
    while ([datetime]::UtcNow -lt $deadline)
    {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $daemonPort -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -ne $listener)
        {
            Write-Step ("Aoi daemon service is running (Scheduled Task '{0}', http://127.0.0.1:{1}); starts at every logon." -f $taskName, $daemonPort)
            return $true
        }

        Start-Sleep -Milliseconds 300
    }

    Write-Step "Aoi daemon service did not come up in time; falling back to the in-process supervisor."
    return $false
}

# Running instances of the native desktop-activity capture helper for this repo
# (matched by image name plus the repo/tool path so a stray same-named binary
# elsewhere is not touched).
function Get-AoiCaptureProcesses
{
    param
    (
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $captureProcesses = @()
    $matched = @(Get-CimInstance Win32_Process -Filter "Name = 'aoi_desktop_capture.exe'" -ErrorAction SilentlyContinue)

    foreach ($process in $matched)
    {
        $commandLine = Get-ProcessCommandLine -Process $process
        if ($commandLine -like "*$RepoRoot*" -or $commandLine -like "*aoi-desktop-capture*")
        {
            $captureProcesses += $process
        }
    }

    return $captureProcesses
}

# Bring up the native desktop-activity capture helper alongside the daemon. It is
# server-side gated (auth token + desktop_activity capability + desktop-activity
# consent), so starting it observes nothing until the operator opts in. Prefers a
# registered logon Scheduled Task; otherwise runs the built exe directly (hidden)
# for this session. -AllowInstall (from -InstallCaptureService) builds + registers
# the boot task. Best-effort: a missing exe or toolchain is a warning, not a stop.
function Start-AoiCaptureHelper
{
    param
    (
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [switch]$AllowInstall
    )

    $captureDir = Join-Path $RepoRoot "tools\aoi-desktop-capture"
    $captureExe = Join-Path $captureDir "aoi_desktop_capture.exe"
    $taskName = 'AoiDesktopCapture'

    $running = @(Get-AoiCaptureProcesses -RepoRoot $RepoRoot)
    if ($running.Count -gt 0)
    {
        $capturePids = ($running | ForEach-Object { $_.ProcessId }) -join ", "
        Write-Step ("Aoi desktop capture already running (PID {0})." -f $capturePids)
        return
    }

    if ($AllowInstall)
    {
        $installer = Join-Path $captureDir "Install-AoiDesktopCapture.ps1"
        if (Test-Path -LiteralPath $installer -PathType Leaf)
        {
            Write-Step "Building + registering the Aoi desktop capture service (Scheduled Task '$taskName')."
            try
            {
                & $installer
            }
            catch
            {
                Write-Warning ("Capture service registration failed: {0}" -f $_.Exception.Message)
            }
        }
    }

    $captureTask = $null
    if ($null -ne (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue))
    {
        $captureTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    }

    if ($null -ne $captureTask)
    {
        try
        {
            Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
            Write-Step ("Aoi desktop capture service started (Scheduled Task '{0}')." -f $taskName)
            return
        }
        catch
        {
            Write-Warning ("Starting the capture task failed: {0}" -f $_.Exception.Message)
        }
    }

    if (-not (Test-Path -LiteralPath $captureExe -PathType Leaf))
    {
        Write-Step "Aoi desktop capture is not built; skipping (build: tools\aoi-desktop-capture\build.ps1, or run Start-App.ps1 -InstallCaptureService)."
        return
    }

    Write-Step "Starting Aoi desktop capture (hidden, session aoi/default)."
    [void](Start-Process -FilePath $captureExe `
        -ArgumentList @('--hide-console', '--session', 'aoi/default') `
        -WorkingDirectory $captureDir `
        -WindowStyle Hidden `
        -PassThru)
    Write-Step "Aoi desktop capture running. It stays gated until you enable the desktop_activity capability + desktop-activity consent."
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

        # Vite is ESM-only. A stale PATH entry (e.g. Brackets Node 6) makes
        # `pnpm dev` fail with: SyntaxError: Unexpected token import.
        $nodePath = & (Join-Path $repoRoot "Resolve-OpenRoomNode.ps1")
        $nodeVersion = (& $nodePath -v 2>$null)
        Write-Step ("Node: {0} ({1})" -f $nodeVersion, $nodePath)

        $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
        if ($null -eq $pnpmCommand)
        {
            throw "pnpm was not found in PATH. Install pnpm 9+ first."
        }

        Write-Step "Repo: $repoRoot"
        Write-Step "App: $appDir"
        Write-Step "URL: http://$HostAddress`:$Port"

        # Aoi daemon: bring up the always-on supervised service; skip if already running.
        $daemonProcesses = @(Get-AoiDaemonProcesses -RepoRoot $repoRoot)
        if ($daemonProcesses.Count -gt 0)
        {
            $daemonPids = ($daemonProcesses | ForEach-Object { $_.ProcessId }) -join ", "
            Write-Step ("Aoi daemon already running (PID {0}, port {1})." -f $daemonPids, (Get-AoiDaemonPort))
        }
        else
        {
            # Ensure the bundle exists before either the service or the fallback runs it.
            try
            {
                [void](Confirm-AoiDaemonBundle -AppDir $appDir -PnpmPath $pnpmCommand.Source)
            }
            catch
            {
                Write-Warning ("Aoi daemon bundle build failed: {0}" -f $_.Exception.Message)
            }

            # Prefer the boot-persistent Scheduled Task service (survives logoff/reboot,
            # -InstallService registers it -- needs elevation); otherwise run the
            # self-healing in-process supervisor (no admin, survives crashes + this shell).
            $serviceStarted = $false
            if (-not $NoService)
            {
                try
                {
                    $serviceStarted = Start-AoiDaemonBootService -RepoRoot $repoRoot -AllowInstall:$InstallService
                }
                catch
                {
                    Write-Warning ("Aoi daemon service start failed: {0}" -f $_.Exception.Message)
                    $serviceStarted = $false
                }
            }

            if (-not $serviceStarted)
            {
                try
                {
                    Start-AoiDaemon -RepoRoot $repoRoot -AppDir $appDir -PnpmPath $pnpmCommand.Source
                    if (-not $InstallService)
                    {
                        Write-Step "For boot-persistence (survives reboot), run (elevated): .\Start-App.ps1 -InstallService  or  .\Install-AoiDaemonService.ps1"
                    }
                }
                catch
                {
                    Write-Warning ("Aoi daemon start failed: {0}" -f $_.Exception.Message)
                    Write-Step "Continuing with the dev server only."
                }
            }
        }

        # Aoi desktop capture: bring up the foreground-activity producer next to the
        # daemon (server-side gated; -NoCapture skips it).
        if (-not $NoCapture)
        {
            try
            {
                Start-AoiCaptureHelper -RepoRoot $repoRoot -AllowInstall:$InstallCaptureService
            }
            catch
            {
                Write-Warning ("Aoi desktop capture start failed: {0}" -f $_.Exception.Message)
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
