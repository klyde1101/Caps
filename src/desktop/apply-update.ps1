param([Parameter(Mandatory=$true)][string]$Record)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility') -ErrorAction Stop
Add-Type -AssemblyName System.IO.Compression.FileSystem
$recordPath = [IO.Path]::GetFullPath($Record)
$updateDirectory = Split-Path -Parent $recordPath
$resultPath = Join-Path $updateDirectory 'result.json'
$stage = $null
$updateLock = $null
$receiptPath = $recordPath + '.completed.json'
function Write-UpdateJson([string]$Path, $Value) {
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json))
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}
try {
    if ((Split-Path -Leaf $recordPath) -notmatch '^pending(?:-[a-f0-9-]{36})?\.json$') { throw 'Invalid update record name.' }
    # Read records only after acquiring the installation lock. A duplicate waits
    # for the first helper's receipt instead of overwriting its result with error.
    $lockWait = [Diagnostics.Stopwatch]::StartNew()
    while (-not $updateLock) {
        try { $updateLock = [IO.File]::Open((Join-Path $updateDirectory 'apply.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
        catch [IO.IOException] {
            if ($lockWait.ElapsedMilliseconds -ge 30000) { exit 0 }
            Start-Sleep -Milliseconds 100
        }
    }
    if (-not [IO.File]::Exists($recordPath)) {
        if ([IO.File]::Exists($receiptPath)) {
            $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
            if ($receipt.state -eq 'installed' -and $receipt.record -eq $recordPath) { exit 0 }
        }
        throw 'The queued update record is missing. Check for updates again.'
    }
    $info = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    $root = [IO.Path]::GetFullPath($info.root).TrimEnd('\')
    if ($updateDirectory -ne (Join-Path $root 'data\updates')) { throw 'Invalid update directory.' }
    if ($info.schema -ne 1 -or $info.runtimeRevision -ne 1 -or $info.runtimeDirectory -notmatch '^dist/app-[a-f0-9]{24}$' -or
        $info.sha256 -notmatch '^[a-f0-9]{64}$' -or $info.archive -notmatch '-Update-x64\.zip$') { throw 'Invalid update record.' }
    $archivePath = [IO.Path]::GetFullPath($info.archive)
    if ((Split-Path -Parent $archivePath) -ne $updateDirectory) { throw 'Invalid archive directory.' }
    $launcher = Join-Path $root 'Caps.exe'
    if ([IO.File]::Exists($resultPath)) {
        $completed = $null
        try { $completed = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json } catch { <# A damaged old status must not block a fresh update. #> }
        if ($completed.state -eq 'installed' -and $completed.sha256 -eq $info.sha256 -and
            $completed.runtimeDirectory -eq $info.runtimeDirectory -and [IO.File]::Exists($launcher) -and
            (Get-FileHash -LiteralPath $launcher).Hash.ToLowerInvariant() -eq $completed.launcherSha256) {
            $completed | Add-Member -NotePropertyName record -NotePropertyValue $recordPath -Force
            Write-UpdateJson $receiptPath $completed
            [IO.File]::Delete($recordPath)
            exit 0
        }
    }
    # Never terminate Caps. The normal job and unsaved-caption guards decide when it can exit.
    $parentProcess = Get-Process -Id ([int]$info.parentPid) -ErrorAction SilentlyContinue
    if ($parentProcess -and -not $parentProcess.WaitForExit(120000)) { throw 'Caps is still running. Update deferred.' }
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $info.sha256 -or
        (Get-Item -LiteralPath $archivePath).Length -ne $info.size) { throw 'Update archive verification failed.' }
    $stage = Join-Path $updateDirectory ('stage-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    $stagePrefix = [IO.Path]::GetFullPath($stage).TrimEnd('\') + '\'
    $runtimeRelative = $info.runtimeDirectory.Replace('/', '\')
    $runtimePrefix = $runtimeRelative + '\'
    $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        [long]$total = 0
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('/', '\')
            if ($name -ne 'Caps.exe' -and -not $name.StartsWith($runtimePrefix, [StringComparison]::Ordinal)) { throw 'Unexpected file in update.' }
            if ($name -match '(^|\\)\.\.?($|\\)|:|[\x00-\x1f]' -or $name.StartsWith('\') -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000 -or -not $names.Add($name)) { throw 'Unsafe update entry.' }
            foreach ($component in $name.Split('\')) {
                if ($component -match '[. ]$|^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') { throw 'Unsafe Windows filename.' }
            }
            $destination = [IO.Path]::GetFullPath((Join-Path $stage $name))
            if (-not $destination.StartsWith($stagePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Update path escapes staging.' }
            $total += $entry.Length
            if ($total -gt 3GB -or $entry.Length -eq 0) { throw 'Invalid expanded update size.' }
            [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
        }
    } finally { $archive.Dispose() }
    foreach ($required in @('Caps.exe', "$runtimeRelative\Caps.exe", "$runtimeRelative\icudtl.dat", "$runtimeRelative\resources\app.asar", "$runtimeRelative\locales\en-US.pak")) {
        if (-not $names.Contains($required)) { throw "Incomplete update: $required" }
    }
    $published = Join-Path $root $runtimeRelative
    $distPrefix = [IO.Path]::GetFullPath((Join-Path $root 'dist')).TrimEnd('\') + '\'
    if (-not ([IO.Path]::GetFullPath($published)).StartsWith($distPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid runtime destination.' }
    # Refuse junctions/reparse points so installed data cannot redirect writes outside Caps.
    foreach ($path in @($root, (Join-Path $root 'dist'), (Join-Path $root 'Caps.exe'), $updateDirectory, $published)) {
        if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Update destination is a reparse point.' }
    }
    if (Test-Path -LiteralPath $published) {
        foreach ($file in Get-ChildItem -LiteralPath (Join-Path $stage $runtimeRelative) -Recurse -File) {
            $relative = $file.FullName.Substring((Join-Path $stage $runtimeRelative).Length).TrimStart('\')
            $existing = Join-Path $published $relative
            if (-not (Test-Path -LiteralPath $existing -PathType Leaf) -or
                (Get-FileHash -LiteralPath $existing).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) { throw 'Existing runtime differs; update stopped.' }
        }
    } else { [IO.Directory]::Move((Join-Path $stage $runtimeRelative), $published) }
    $backup = Join-Path $updateDirectory 'previous-launcher.exe'
    # Record update-owned files before switching launchers so uninstall also covers newer runtimes.
    $installedManifest = Join-Path $root 'installed-files.txt'
    if (Test-Path -LiteralPath $installedManifest) {
        if ((Get-Item -LiteralPath $installedManifest -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installed file manifest is a reparse point.' }
        $owned = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($name in [IO.File]::ReadAllLines($installedManifest)) { [void]$owned.Add($name) }
        foreach ($name in $names) {
            [void]$owned.Add($name)
            $parent = [IO.Path]::GetDirectoryName($name)
            while ($parent) { [void]$owned.Add($parent); $parent = [IO.Path]::GetDirectoryName($parent) }
        }
        $manifestStage = Join-Path $updateDirectory ('manifest-' + [guid]::NewGuid().ToString('N') + '.txt')
        try {
            [IO.File]::WriteAllLines($manifestStage, [string[]]$owned)
            [IO.File]::Replace($manifestStage, $installedManifest, [NullString]::Value)
        } finally { if ([IO.File]::Exists($manifestStage)) { [IO.File]::Delete($manifestStage) } }
    }
    $stagedLauncher = Join-Path $stage 'Caps.exe'
    if ((Get-FileHash -LiteralPath $stagedLauncher).Hash -ne (Get-FileHash -LiteralPath $launcher).Hash) {
        if (Test-Path -LiteralPath $backup) { [IO.File]::Delete($backup) }
        [IO.File]::Replace($stagedLauncher, $launcher, $backup)
    }
    # Leave the previous runtime intact for recovery. Models, settings, media and Python are untouched.
    $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Caps'
    if ((Test-Path -LiteralPath $uninstallKey) -and (Get-ItemProperty -LiteralPath $uninstallKey).InstallLocation -eq $root) {
        Set-ItemProperty -LiteralPath $uninstallKey -Name DisplayVersion -Value $info.version
    }
    $completed = @{ state='installed'; version=$info.version; message="Updated to Caps $($info.version).";
        record=$recordPath; sha256=$info.sha256; runtimeDirectory=$info.runtimeDirectory;
        launcherSha256=(Get-FileHash -LiteralPath $launcher).Hash.ToLowerInvariant() }
    Write-UpdateJson $receiptPath $completed
    Write-UpdateJson $resultPath $completed
    [IO.File]::Delete($recordPath)
    [IO.File]::Delete($archivePath)
} catch {
    # Never replace another active helper's result if we could not own the lock.
    if ($updateLock) { Write-UpdateJson $resultPath @{ state='error'; message=$_.Exception.Message } }
    exit 1
} finally {
    if ($updateLock) { $updateLock.Dispose() }
    if ($stage) {
        $resolvedStage = [IO.Path]::GetFullPath($stage)
        $expectedPrefix = [IO.Path]::GetFullPath($updateDirectory).TrimEnd('\') + '\stage-'
        if ($resolvedStage.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            try { Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction Stop } catch { <# A locked cache can be removed later. #> }
        }
    }
}
