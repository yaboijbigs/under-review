#requires -Version 7.0
<#
.SYNOPSIS
Back up one Under Review Compose project without exporting configuration secrets.
.EXAMPLE
pwsh -File scripts/backup.ps1 -ProjectName under-review-staging-check -ComposeFile deploy/private/local-staging.yaml -EnvFile deploy/private/staging.env -PauseWorker -VerifyRestore
#>
[CmdletBinding()]
param(
    [ValidatePattern('^under-review(?:-[a-z0-9][a-z0-9-]*)?$')]
    [string] $ProjectName = 'under-review',
    [string] $ComposeFile = 'compose.yaml',
    [string] $EnvFile = '.env',
    [switch] $PauseWorker,
    [switch] $VerifyRestore,
    [ValidateRange(30, 900)]
    [int] $WorkerStopTimeoutSeconds = 300
)

Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $PSScriptRoot
$backupRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'deploy/private/backups'))
$snapshotId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N')
$snapshotDirectory = Join-Path $backupRoot $snapshotId
$restoreDatabase = 'ur_restore_test_' + [Guid]::NewGuid().ToString('N')
$workerWasStopped = $false
$restoreWasCreated = $false
$dbContainer = $null
$workerContainer = $null

function Resolve-ProjectFile([string] $File) {
    $candidate = if ([IO.Path]::IsPathRooted($File)) { $File } else { Join-Path $projectRoot $File }
    return (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
}

# Binary stdout/stdin use streams, never PowerShell text redirection (which can corrupt pg_dump).
function Invoke-BoundedProcess {
    param(
        [string] $Executable, [string[]] $Arguments, [string] $Operation,
        [string] $InputFile, [string] $OutputFile,
        [ValidateRange(1, 3600000)] [int] $TimeoutMilliseconds = 3600000
    )
    $info = [Diagnostics.ProcessStartInfo]::new($Executable)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.RedirectStandardInput = [bool] $InputFile
    foreach ($argument in $Arguments) { [void] $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $outputStream = $null
    $inputStream = $null
    $inputTask = $null
    $inputClosed = -not [bool]$InputFile
    $started = $false
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    $cancellation = [Threading.CancellationTokenSource]::new()
    try {
        $started = $process.Start()
        $errorTask = $process.StandardError.ReadToEndAsync()
        if ($OutputFile) {
            $outputStream = [IO.File]::Open($OutputFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
            $outputTask = $process.StandardOutput.BaseStream.CopyToAsync($outputStream, 81920, $cancellation.Token)
        } else { $outputTask = $process.StandardOutput.ReadToEndAsync() }
        if ($InputFile) {
            $inputStream = [IO.File]::OpenRead($InputFile)
            $inputTask = $inputStream.CopyToAsync($process.StandardInput.BaseStream, 81920, $cancellation.Token)
        }
        # One deadline covers backpressured stdin, process exit, and both output streams.
        # Closing stdin only after its asynchronous copy completes delivers EOF to pg_restore.
        while ($true) {
            if ($deadline.ElapsedMilliseconds -ge $TimeoutMilliseconds) {
                throw "$Operation exceeded its $TimeoutMilliseconds ms execution deadline."
            }
            if ($inputTask -and $inputTask.IsCompleted -and -not $inputClosed) {
                $inputTask.GetAwaiter().GetResult() | Out-Null
                $process.StandardInput.Close()
                $inputClosed = $true
            }
            if ($outputTask.IsFaulted) { $outputTask.GetAwaiter().GetResult() | Out-Null }
            if ($errorTask.IsFaulted) { $errorTask.GetAwaiter().GetResult() | Out-Null }
            if ($process.HasExited -and $inputClosed -and $outputTask.IsCompleted -and $errorTask.IsCompleted) { break }
            Start-Sleep -Milliseconds ([Math]::Min(25, [Math]::Max(1, $TimeoutMilliseconds - $deadline.ElapsedMilliseconds)))
        }
        $outputTask.GetAwaiter().GetResult() | Out-Null
        $errorTask.GetAwaiter().GetResult() | Out-Null
        if ($process.ExitCode -ne 0) {
            # Do not echo interpolated Compose configuration, credentials, or database error contents.
            throw "$Operation failed (process exit $($process.ExitCode)). The backup is not marked complete."
        }
        if (-not $OutputFile) { return $outputTask.Result.Trim() }
    } finally {
        try {
            $cancellation.Cancel()
            if ($started -and -not $process.HasExited) {
                $process.Kill($true)
                if (-not $process.WaitForExit(5000)) { throw "$Operation could not terminate its child process." }
            }
        } finally {
            if ($inputStream) { $inputStream.Dispose() }
            if ($outputStream) { $outputStream.Dispose() }
            $cancellation.Dispose()
            $process.Dispose()
        }
    }
}

function Invoke-DockerProcess {
    param([string[]] $Arguments, [string] $Operation, [string] $InputFile, [string] $OutputFile)
    return Invoke-BoundedProcess -Executable 'docker' -Arguments $Arguments -Operation $Operation -InputFile $InputFile -OutputFile $OutputFile
}

$composeArguments = @('compose', '--project-name', $ProjectName, '--file', (Resolve-ProjectFile $ComposeFile), '--env-file', (Resolve-ProjectFile $EnvFile))
function Invoke-Compose([string[]] $Arguments, [string] $Operation) {
    return Invoke-DockerProcess -Arguments ($composeArguments + $Arguments) -Operation $Operation
}
function Inspect-ProjectContainer([string] $Service) {
    $id = Invoke-Compose -Arguments @('ps', '--all', '--quiet', $Service) -Operation "Find $Service container"
    if ($id -notmatch '^[a-f0-9]{12,64}$') { throw "Exactly one $Service container is required for $ProjectName." }
    # Inspect only labels/state/mounts/image, never the environment containing credentials.
    $raw = Invoke-DockerProcess -Arguments @('inspect', '--format', '{"labels":{{json .Config.Labels}},"state":{{json .State}},"mounts":{{json .Mounts}},"image":{{json .Image}}}', $id) -Operation "Inspect $Service ownership"
    $details = $raw | ConvertFrom-Json -ErrorAction Stop
    if ($details.labels.'com.docker.compose.project' -ne $ProjectName -or $details.labels.'com.docker.compose.service' -ne $Service) {
        throw "Refusing a $Service container outside the selected project."
    }
    return @{ Id = $id; Details = $details }
}
function Invoke-DatabaseSql([string] $Sql, [string] $Database = '') {
    return Invoke-DockerProcess -Arguments @('exec', $dbContainer.Id, 'sh', '-c', 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "${1:-$POSTGRES_DB}" -Atqc "$2"', '--', $Database, $Sql) -Operation 'Read database backup verification data'
}

$verificationSql = @'
SELECT jsonb_build_object(
 'games',(SELECT count(*) FROM games),
 'revisions',(SELECT count(*) FROM analysis_revisions),
 'snapshots',(SELECT count(*) FROM source_snapshots),
 'plays',(SELECT count(*) FROM plays),
 'events',(SELECT count(*) FROM events),
 'reviews',(SELECT count(*) FROM reviews),
 'publications',(SELECT count(*) FROM publication_outbox),
 'attempts',(SELECT count(*) FROM publication_attempts),
 'users',(SELECT count(*) FROM users),
 'migrations',(SELECT jsonb_agg(jsonb_build_object('name',name,'checksum',checksum) ORDER BY name) FROM schema_migrations)
);
'@

try {
    $dbContainer = Inspect-ProjectContainer 'db'
    $workerContainer = Inspect-ProjectContainer 'worker'
    if (-not $dbContainer.Details.state.Running) { throw 'The selected project database must be running.' }
    $mounts = @($workerContainer.Details.mounts | Where-Object { $_.Type -eq 'volume' -and $_.Destination -eq '/data' })
    if ($mounts.Count -ne 1 -or $mounts[0].Name -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]+$') { throw 'Exactly one named artifact volume mounted at /data is required.' }
    $artifactVolume = $mounts[0].Name
    $volumeLabels = (Invoke-DockerProcess -Arguments @('volume', 'inspect', '--format', '{{json .Labels}}', $artifactVolume) -Operation 'Check artifact volume ownership') | ConvertFrom-Json -ErrorAction Stop
    if ($volumeLabels.'com.docker.compose.project' -ne $ProjectName -or $volumeLabels.'com.docker.compose.volume' -ne 'artifacts') { throw 'The artifact volume must belong exclusively to the selected Compose project.' }
    if ($workerContainer.Details.state.Running) {
        if (-not $PauseWorker) { throw 'The worker is running. Use -PauseWorker to drain its current job, stop it for the backup, and restart it afterward.' }
        # SIGTERM tells this worker to finish its current job without claiming another.
        # If interrupted, keep the durable job row for ordinary lease recovery after restart/restore.
        $workerWasStopped = $true
        Invoke-Compose -Arguments @('stop', '--timeout', [string]$WorkerStopTimeoutSeconds, 'worker') -Operation 'Drain and stop only the selected worker' | Out-Null
    }
    $workerState = Invoke-DockerProcess -Arguments @('inspect', '--format', '{{.State.Running}}', $workerContainer.Id) -Operation 'Verify that the selected worker stopped'
    if ($workerState -ne 'false') { throw 'The selected worker must be stopped before artifact capture.' }
    $leaseDeadline = [DateTime]::UtcNow.AddSeconds($WorkerStopTimeoutSeconds)
    while ([int](Invoke-DatabaseSql "SELECT count(*) FROM jobs WHERE status='running' AND lease_until>now()") -gt 0) {
        if ([DateTime]::UtcNow -ge $leaseDeadline) { throw 'A live job lease remains after shutdown; backup deferred without changing its state.' }
        Start-Sleep -Seconds 5
    }
    $recoverableJobs = [int](Invoke-DatabaseSql "SELECT count(*) FROM jobs WHERE status='running'")

    # Every host output stays in this one newly generated ignored directory. No deletion/retention runs here.
    $relative = [IO.Path]::GetRelativePath($backupRoot, [IO.Path]::GetFullPath($snapshotDirectory))
    if ($relative.StartsWith('..') -or [IO.Path]::IsPathRooted($relative)) { throw 'Backup output escaped the permitted directory.' }
    [void](New-Item -ItemType Directory -Path $snapshotDirectory -ErrorAction Stop)
    $dumpPath = Join-Path $snapshotDirectory 'database.dump'
    $archivePath = Join-Path $snapshotDirectory 'artifacts.tar.gz'
    $expected = Invoke-DatabaseSql $verificationSql
    Invoke-DockerProcess -Arguments @('exec', $dbContainer.Id, 'sh', '-c', 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl') -Operation 'Dump the selected project database' -OutputFile $dumpPath

    # Reuse the existing database image for tar/gzip; this helper has no network or writable source mounts.
    $helperArguments = @('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--cpus', '0.25', '--memory', '256m', '--pids-limit', '64')
    Invoke-DockerProcess -Arguments ($helperArguments + @('--user', '10001:10001', '--label', "under-review.backup=$snapshotId", '--mount', "type=volume,source=$artifactVolume,target=/artifacts,readonly", $dbContainer.Details.image, 'tar', '-czf', '-', '-C', '/artifacts', '.')) -Operation 'Archive the selected immutable artifacts volume' -OutputFile $archivePath
    Invoke-DockerProcess -Arguments ($helperArguments + @('-i', $dbContainer.Details.image, 'gzip', '-t')) -Operation 'Verify the complete artifact archive stream' -InputFile $archivePath | Out-Null
    $actual = $null
    if ($VerifyRestore) {
        if ($restoreDatabase -notmatch '^ur_restore_test_[a-f0-9]{32}$') { throw 'Invalid generated restore database name.' }
        Invoke-DockerProcess -Arguments @('exec', $dbContainer.Id, 'sh', '-c', 'exec createdb -U "$POSTGRES_USER" -- "$1"', '--', $restoreDatabase) -Operation 'Create the unique temporary restore database' | Out-Null
        $restoreWasCreated = $true
        Invoke-DockerProcess -Arguments @('exec', '-i', $dbContainer.Id, 'sh', '-c', 'exec pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --no-acl --exit-on-error', '--', $restoreDatabase) -Operation 'Restore only into the temporary database' -InputFile $dumpPath | Out-Null
        $actual = Invoke-DatabaseSql -Sql $verificationSql -Database $restoreDatabase
        if ($actual -ne $expected) { throw 'Restored counts/migration checksums differ. Ensure administrative writes are quiescent and investigate the preserved backup.' }
    }
    $manifest = [ordered]@{
        schemaVersion = 1
        project = $ProjectName
        snapshotId = $snapshotId
        createdAt = [DateTime]::UtcNow.ToString('o')
        databaseImage = $dbContainer.Details.image
        workerImage = $workerContainer.Details.image
        artifactVolume = $artifactVolume
        workerPausedForBackup = $workerWasStopped
        restoreVerified = [bool]$VerifyRestore
        interruptedJobsPreserved = $recoverableJobs
        expectedDatabase = ($expected | ConvertFrom-Json)
        files = @(
            @{ path = 'database.dump'; bytes = (Get-Item -LiteralPath $dumpPath).Length; sha256 = (Get-FileHash -LiteralPath $dumpPath -Algorithm SHA256).Hash.ToLowerInvariant() },
            @{ path = 'artifacts.tar.gz'; bytes = (Get-Item -LiteralPath $archivePath).Length; sha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() }
        )
        configuration = 'Environment secrets and proxy configuration are intentionally not exported; retain them separately in encrypted storage.'
    }
    $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $snapshotDirectory 'manifest.json') -Encoding utf8NoBOM -ErrorAction Stop
} finally {
    try {
        if ($restoreWasCreated) {
            # Only this exact database, generated and successfully created above, can be dropped.
            if ($restoreDatabase -notmatch '^ur_restore_test_[a-f0-9]{32}$') { throw 'Refusing unsafe restore database cleanup.' }
            Invoke-DockerProcess -Arguments @('exec', $dbContainer.Id, 'sh', '-c', 'exec dropdb -U "$POSTGRES_USER" -- "$1"', '--', $restoreDatabase) -Operation 'Drop only the newly created restore test database' | Out-Null
        }
    } finally {
        if ($workerWasStopped) { Invoke-Compose -Arguments @('start', 'worker') -Operation 'Restart only the worker stopped by this backup' | Out-Null }
    }
}

[ordered]@{ project = $ProjectName; backupDirectory = $snapshotDirectory; restoreVerified = [bool]$VerifyRestore; workerResumed = $workerWasStopped } | ConvertTo-Json
