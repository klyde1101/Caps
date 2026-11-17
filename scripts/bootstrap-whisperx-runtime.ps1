param(
 [ValidateSet('cpu','cuda','both')][string]$Target = 'both',
 [string]$OutputRoot,
 [string]$FfmpegDirectory
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $OutputRoot) { $OutputRoot = Join-Path $root 'whisperx' }
if (-not $FfmpegDirectory) { $FfmpegDirectory = Join-Path $root 'whisperx\ffmpeg' }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
if (-not $OutputRoot.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime output must be inside this checkout.' }
if (-not (Test-Path -LiteralPath (Join-Path $FfmpegDirectory 'ffmpeg.exe'))) { throw 'Provide a verified shared FFmpeg installation with -FfmpegDirectory.' }
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'Install uv before bootstrapping.' }
$oldCache = $env:UV_CACHE_DIR
$oldMpl = $env:MPLCONFIGDIR
try {
 $env:UV_CACHE_DIR = Join-Path $root 'data\uv-cache'
 $env:MPLCONFIGDIR = Join-Path $root 'data\matplotlib'
 foreach ($device in @('cpu','cuda')) {
  if ($Target -ne 'both' -and $Target -ne $device) { continue }
  $runtime = Join-Path $OutputRoot "$device\python"
  if (Test-Path -LiteralPath $runtime) { throw "Refusing to replace an existing runtime: $runtime" }
  $staging = Join-Path $OutputRoot ('.bootstrap-' + $device + '-' + [guid]::NewGuid().ToString('N'))
  $managed = Join-Path $staging 'managed'
  & uv python install 3.12.13 --install-dir $managed --no-bin --no-registry
  # Portable Caps uses the exact interpreter path; uv's optional minor-version aliases are unnecessary.
  $candidates = @(Get-ChildItem -LiteralPath $managed -Directory -Filter 'cpython-3.12.13-*' | ForEach-Object {
    $candidate = Join-Path $_.FullName 'python.exe'
    if (Test-Path -LiteralPath $candidate) { Get-Item -LiteralPath $candidate }
  })
  if ($candidates.Count -ne 1) { throw "Managed Python download is incomplete: $staging" }
  & $candidates[0].FullName -c 'import sys; assert sys.version_info[:3] == (3,12,13)'
  if ($LASTEXITCODE -ne 0) { throw 'Downloaded Python failed version validation.' }
  $pending = Join-Path $staging 'python'
  New-Item -ItemType Directory -Force $pending | Out-Null
  Copy-Item -Path (Join-Path $candidates[0].DirectoryName '*') -Destination $pending -Recurse
  $python = Join-Path $pending 'python.exe'
  $index = if ($device -eq 'cuda') { 'https://download.pytorch.org/whl/cu128' } else { 'https://download.pytorch.org/whl/cpu' }
  $pins = Get-Content (Join-Path $PSScriptRoot "requirements-$device.txt")
  $torchPins = @($pins | Where-Object { $_ -match '^(torch|torchaudio|torchvision)==' })
  $basePins = Join-Path $staging 'requirements-base.txt'
  $pins | Where-Object { $_ -notmatch '^(torch|torchaudio|torchvision)==' } | Set-Content $basePins
  # Resolve ordinary packages only from PyPI; PyTorch wheels only from their explicit vendor index.
  & uv pip sync --break-system-packages --python $python --index-url https://pypi.org/simple $basePins
  if ($LASTEXITCODE -ne 0) { throw "Pinned base dependency installation failed: $staging" }
  & uv pip install --break-system-packages --python $python --no-deps --index-url $index @torchPins
  if ($LASTEXITCODE -ne 0) { throw "Pinned PyTorch installation failed: $staging" }
  Copy-Item -Path (Join-Path $PSScriptRoot 'runtime-overlay\whisperx\*.py') -Destination (Join-Path $pending 'Lib\site-packages\whisperx') -Force
  & $python (Join-Path $PSScriptRoot 'prepare-whisperx-runtime.py') --ffmpeg-directory $FfmpegDirectory
  if ($LASTEXITCODE -ne 0) { throw 'Runtime codec/checkpoint preparation failed.' }
  & $python -c 'import os,sys; h=os.add_dll_directory(sys.argv[1]); from whisperx.asr import load_model; from whisperx.alignment import load_align_model; print("Runtime imports passed")' $FfmpegDirectory
  if ($LASTEXITCODE -ne 0) { throw 'Runtime import validation failed.' }
  & (Join-Path $PSScriptRoot 'trim-runtime-development.ps1') -PythonRoot $pending -Apply
  New-Item -ItemType Directory -Force (Split-Path -Parent $runtime) | Out-Null
  [IO.Directory]::Move($pending, $runtime)
  Write-Output "Published verified $device runtime: $runtime"
 }
} finally {
 $env:UV_CACHE_DIR = $oldCache
 $env:MPLCONFIGDIR = $oldMpl
}
