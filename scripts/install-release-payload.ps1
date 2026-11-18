# The installer runs this script from its private temporary directory.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility') -ErrorAction Stop
function Report([string]$Stage, [long]$Current, [long]$Total, [int]$Index, [int]$Count, [string]$Message) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Message))
    [Console]::Out.WriteLine(('CAPS_PROGRESS|{0}|{1}|{2}|{3}|{4}|{5}' -f $Stage,$Current,$Total,$Index,$Count,$encoded))
}
$payload = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'payload.json') -Raw | ConvertFrom-Json
$cache = Join-Path $PSScriptRoot 'payload'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$files = @($payload.files)
$total = [long]0
if (-not $files.Count) { throw 'The installer runtime manifest is empty.' }
foreach ($part in $files) {
    if ($part.name -notmatch '^[A-Za-z0-9._-]+$' -or $part.name -in @('.','..') -or $part.sha256 -notmatch '^[a-f0-9]{64}$' -or $part.size -le 0) {
        throw 'The installer runtime manifest is invalid.'
    }
    $total += [long]$part.size
}
$allAdjacent = @($files | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $env:CAPS_SETUP_SOURCE $_.name) -PathType Leaf)
}).Count -eq 0
if ($allAdjacent -and $files.Count -gt 1 -and $files[0].name -match '^(.*)\.001$') {
    $volumePattern = '^' + [regex]::Escape($Matches[1]) + '\.[0-9]{3}$'
    $listedNames = @($files | ForEach-Object { $_.name })
    $extraVolumes = @(Get-ChildItem -LiteralPath $env:CAPS_SETUP_SOURCE -File | Where-Object {
        $_.Name -match $volumePattern -and $_.Name -notin $listedNames
    })
    # 7-Zip discovers neighboring volumes automatically. Isolate exactly the
    # verified manifest volumes if an older, larger build left extra parts here.
    if ($extraVolumes.Count) { $allAdjacent = $false }
}
$sources = @()
$completed = [long]0
$index = 0
$clock = [Diagnostics.Stopwatch]::StartNew()
foreach ($part in $files) {
    $index++
    $message = 'Runtime data - part {0} of {1}' -f $index,$files.Count
    $source = Join-Path $env:CAPS_SETUP_SOURCE $part.name
    $embedded = Join-Path $PSScriptRoot 'embedded.zip'
    if (Test-Path -LiteralPath $embedded -PathType Leaf) { $source = $embedded }
    Report 'download' $completed $total $index $files.Count $message
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        $source = Join-Path $cache $part.name
        $partial = $source + '.partial'
        $request = [Net.HttpWebRequest]::Create($payload.baseUrl + '/' + $part.name)
        $request.UserAgent = 'Caps-Setup'
        $request.Timeout = 30000
        $request.ReadWriteTimeout = 30000
        $response = $null; $inputFile = $null; $output = $null
        try {
            $response = $request.GetResponse()
            $inputFile = $response.GetResponseStream()
            $output = [IO.File]::Open($partial,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
            $buffer = New-Object byte[] (1024 * 1024)
            $received = [long]0
            $lastReport = [long]0
            while (($read = $inputFile.Read($buffer,0,$buffer.Length)) -gt 0) {
                $output.Write($buffer,0,$read)
                $received += $read
                if ($received -gt [long]$part.size) { throw 'The runtime download is larger than expected.' }
                if ($clock.ElapsedMilliseconds - $lastReport -ge 200) {
                    Report 'download' ($completed + $received) $total $index $files.Count $message
                    $lastReport = $clock.ElapsedMilliseconds
                }
            }
            if ($received -ne [long]$part.size) { throw 'The runtime download was interrupted. Please retry.' }
            $output.Dispose(); $output = $null
            [IO.File]::Move($partial,$source)
        } finally {
            if ($output) { $output.Dispose() }
            if ($inputFile) { $inputFile.Dispose() }
            if ($response) { $response.Dispose() }
            if ([IO.File]::Exists($partial)) { [IO.File]::Delete($partial) }
        }
    }
    if ((Get-Item -LiteralPath $source).Length -ne [long]$part.size) { throw "The runtime file has an unexpected size: $($part.name)" }
    if (-not $allAdjacent -and $files.Count -gt 1 -and (Split-Path -Parent $source) -ne $cache) {
        Report 'prepare' 0 0 $index $files.Count 'Preparing local runtime files'
        $copy = Join-Path $cache $part.name
        [IO.File]::Copy($source,$copy,$true)
        $source = $copy
    }
    $sources += $source
    $completed += [long]$part.size
    Report 'download' $completed $total $index $files.Count $message
}
$verified = [long]0
for ($i = 0; $i -lt $files.Count; $i++) {
    $part = $files[$i]
    $message = 'Checking runtime data - part {0} of {1}' -f ($i+1),$files.Count
    Report 'verify' $verified $total ($i+1) $files.Count $message
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $inputFile = [IO.File]::OpenRead($sources[$i])
    try {
        $buffer = New-Object byte[] (1024 * 1024)
        $lastReport = [long]0
        while (($read = $inputFile.Read($buffer,0,$buffer.Length)) -gt 0) {
            [void]$algorithm.TransformBlock($buffer,0,$read,$buffer,0)
            $verified += $read
            if ($clock.ElapsedMilliseconds - $lastReport -ge 200) {
                Report 'verify' $verified $total ($i+1) $files.Count $message
                $lastReport = $clock.ElapsedMilliseconds
            }
        }
        [void]$algorithm.TransformFinalBlock((New-Object byte[] 0),0,0)
        $hash = [BitConverter]::ToString($algorithm.Hash).Replace('-','')
        if ($hash -ne $part.sha256) { throw "Integrity check failed for $($part.name). Please retry Setup." }
    } finally { $inputFile.Dispose(); $algorithm.Dispose() }
    Report 'verify' $verified $total ($i+1) $files.Count $message
}
Report 'extract' 0 100 0 0 'Installing the app and runtimes'
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = Join-Path $PSScriptRoot '7za.exe'
$start.Arguments = 'x -y -bsp1 -bso0 -bse2 "-o' + $env:CAPS_SETUP_DEST + '" "' + $sources[0] + '"'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = New-Object Diagnostics.Process
$process.StartInfo = $start
try {
    [void]$process.Start()
    $errors = $process.StandardError.ReadToEndAsync()
    $line = ''
    $lastPercent = -1
    while (($character = $process.StandardOutput.Read()) -ne -1) {
        if ($character -eq 13 -or $character -eq 10) {
            if ($line -match '(\d{1,3})%') {
                $percent = [int]$Matches[1]
                if ($percent -gt $lastPercent -and $percent -le 100) {
                    Report 'extract' $percent 100 0 0 'Installing the app and runtimes'
                    $lastPercent = $percent
                }
            }
            $line = ''
        } else { $line += [char]$character }
    }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw ('Caps extraction failed. ' + $errors.Result) }
} finally { $process.Dispose() }
Report 'extract' 100 100 0 0 'The app and runtimes are installed'
