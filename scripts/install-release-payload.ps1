# The installer runs this script from its private temporary directory.
$ErrorActionPreference = 'Stop'
$payload = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'payload.json') -Raw | ConvertFrom-Json
$cache = Join-Path $PSScriptRoot 'payload'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$allAdjacent = @($payload.files | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $env:CAPS_SETUP_SOURCE $_.name) -PathType Leaf)
}).Count -eq 0
foreach ($part in $payload.files) {
    $source = Join-Path $env:CAPS_SETUP_SOURCE $part.name
    $embedded = Join-Path $PSScriptRoot 'embedded.zip'
    if (Test-Path -LiteralPath $embedded -PathType Leaf) { $source = $embedded }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        $source = Join-Path $cache $part.name
        $uri = $payload.baseUrl + '/' + $part.name
        $client = New-Object Net.WebClient
        try { $client.DownloadFile($uri, $source) } finally { $client.Dispose() }
    }
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $inputFile = [IO.File]::OpenRead($source)
    try { $hash = [BitConverter]::ToString($algorithm.ComputeHash($inputFile)).Replace('-', '') }
    finally { $inputFile.Dispose(); $algorithm.Dispose() }
    if ($hash -ne $part.sha256) {
        throw "Integrity check failed for $($part.name)"
    }
    # Multi-part archives must reside together for extraction.
    if (-not $allAdjacent -and $payload.files.Count -gt 1 -and (Split-Path -Parent $source) -ne $cache) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $cache $part.name)
    }
    if (-not $first) { $first = $source }
}
if (-not $allAdjacent -and $payload.files.Count -gt 1) { $first = Join-Path $cache $payload.files[0].name }
& (Join-Path $PSScriptRoot '7za.exe') x -y "-o$env:CAPS_SETUP_DEST" $first
if ($LASTEXITCODE -ne 0) { throw "Caps extraction failed ($LASTEXITCODE)." }
