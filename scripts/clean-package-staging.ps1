param([string]$StagingRoot, [switch]$KeepUnpacked, [string]$PublishedFolder)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
$distPrefix = $distRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

if (-not (Test-Path -LiteralPath $distRoot -PathType Container)) {
  Write-Output "No package staging directory found at $distRoot; nothing to clean."
  exit 0
}

# Cleanup is allowed only after a self-contained root executable has been published.
# Never prune files inside an unpacked Electron runtime: icudtl.dat and .pak/.bin are required.
if ($KeepUnpacked) {
  if (-not $PublishedFolder) { $PublishedFolder = Join-Path $distRoot 'win-unpacked' }
  $resolvedPublished = [System.IO.Path]::GetFullPath($PublishedFolder)
  if ((Split-Path -Parent $resolvedPublished) -ne $distRoot -or (Split-Path -Leaf $resolvedPublished) -notmatch '^(win-unpacked|app-[a-f0-9]{24})$') {
    throw 'Refusing cleanup with an unknown published build folder.'
  }
  & node (Join-Path $PSScriptRoot 'verify-windows-package.mjs') $resolvedPublished (Join-Path $projectRoot 'node_modules\electron\dist') '-' $projectRoot
  if ($LASTEXITCODE -ne 0) { throw 'Refusing cleanup without a verified complete folder build.' }
} else {
  $launcher = Join-Path $projectRoot 'Caps.exe'
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Refusing cleanup without the published portable executable: $launcher"
  }
  $stream = [System.IO.File]::OpenRead($launcher)
  try {
    $header = New-Object byte[] ([Math]::Min(1048576, $stream.Length))
    [void]$stream.Read($header, 0, $header.Length)
    if ($header.Length -lt 2 -or $header[0] -ne 77 -or $header[1] -ne 90 -or -not [System.Text.Encoding]::ASCII.GetString($header).Contains('NullsoftInst')) {
      throw 'Refusing cleanup: Caps.exe is not a self-contained portable executable.'
    }
  }
  finally { $stream.Dispose() }
}

if ($StagingRoot) {
  $resolvedStaging = [System.IO.Path]::GetFullPath($StagingRoot)
  if ((Split-Path -Parent $resolvedStaging) -ne $distRoot -or (Split-Path -Leaf $resolvedStaging) -notmatch '^\.(package|previous)-[a-f0-9]{32}$') {
    throw "Refusing cleanup of a live or unknown build folder: $resolvedStaging"
  }
  $targets = @($StagingRoot)
} else {
  $targets = @(
    (Join-Path $distRoot 'model-downloads'),
    (Join-Path $distRoot 'builder-debug.yml'),
    (Join-Path $distRoot 'builder-effective-config.yaml')
  )
  if (-not $KeepUnpacked) { $targets += (Join-Path $distRoot 'win-unpacked') }
  $targets += @(Get-ChildItem -LiteralPath $distRoot -File -Filter 'Caps-*-Fast-Launch.zip' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
}

foreach ($target in $targets) {
  $resolvedTarget = [System.IO.Path]::GetFullPath($target)
  if (-not $resolvedTarget.StartsWith($distPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a path outside the package directory: $resolvedTarget"
  }
  if (Test-Path -LiteralPath $resolvedTarget) {
    Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
  }
}

if (-not (Get-ChildItem -LiteralPath $distRoot -Force | Select-Object -First 1)) {
  Remove-Item -LiteralPath $distRoot
}

Write-Output "Removed temporary package staging from $distRoot"
