param(
  [ValidateSet('cpu', 'cuda', 'both')]
  [string]$Target = 'both',
  [string]$FfmpegArchive
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot 'whisperx'
$modelRoot = Join-Path $projectRoot 'models'
$uvCommand = Get-Command uv -ErrorAction SilentlyContinue

if (-not $uvCommand) {
  throw "uv is required to assemble the bundled WhisperX runtime. Install uv and rerun this script."
}

New-Item -ItemType Directory -Force -Path $modelRoot | Out-Null

$ffmpegRoot = Join-Path $runtimeRoot 'ffmpeg'
$ffmpegPattern = '^(ffmpeg\.exe|(?:avcodec|avdevice|avfilter|avformat|avutil|postproc|swresample|swscale)-\d+\.dll)$'
$legacyDirectories = @((Join-Path $runtimeRoot 'cpu\python'), (Join-Path $runtimeRoot 'cuda\python'))

# A prepared CPU runtime remains a supported source for the existing local build workflow.
# New shared builds can be extracted once with -FfmpegArchive <shared-build.zip>.
if (-not (Test-Path -LiteralPath (Join-Path $ffmpegRoot 'ffmpeg.exe') -PathType Leaf)) {
  $extractionRoot = $null
  try {
    if ($FfmpegArchive) {
      $extractionRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('caps-ffmpeg-' + [guid]::NewGuid())
      Expand-Archive -LiteralPath $FfmpegArchive -DestinationPath $extractionRoot
      $executables = @(Get-ChildItem -LiteralPath $extractionRoot -Recurse -File -Filter 'ffmpeg.exe')
      if ($executables.Count -ne 1) { throw 'The FFmpeg archive must contain exactly one ffmpeg.exe.' }
      $sourceFiles = @(Get-ChildItem -LiteralPath $executables[0].DirectoryName -File | Where-Object { $_.Name -eq 'ffmpeg.exe' -or $_.Extension -eq '.dll' })
    }
    else {
      $sourceDirectory = $legacyDirectories | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'ffmpeg.exe') -PathType Leaf } | Select-Object -First 1
      if (-not $sourceDirectory) { throw 'FFmpeg is missing. Supply -FfmpegArchive <shared-build.zip> or prepare the CPU runtime first.' }
      $sourceFiles = @(Get-ChildItem -LiteralPath $sourceDirectory -File | Where-Object { $_.Name -match $ffmpegPattern })
    }
    New-Item -ItemType Directory -Force -Path $ffmpegRoot | Out-Null
    foreach ($file in $sourceFiles) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $ffmpegRoot $file.Name) }
  }
  finally {
    if ($extractionRoot -and (Test-Path -LiteralPath $extractionRoot)) {
      $resolvedExtraction = [System.IO.Path]::GetFullPath($extractionRoot)
      $tempPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
      if (-not $resolvedExtraction.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid FFmpeg extraction directory.' }
      Remove-Item -LiteralPath $resolvedExtraction -Recurse -Force
    }
  }
}

& (Join-Path $ffmpegRoot 'ffmpeg.exe') -version | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The shared FFmpeg executable could not load. Check its DLLs.' }

# Verify every legacy file before removing any copy; never discard a different build.
$legacyFiles = @($legacyDirectories | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | ForEach-Object {
  Get-ChildItem -LiteralPath $_ -File | Where-Object { $_.Name -match $ffmpegPattern }
})
foreach ($file in $legacyFiles) {
  $sharedFile = Join-Path $ffmpegRoot $file.Name
  if (-not (Test-Path -LiteralPath $sharedFile -PathType Leaf) -or
      (Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $sharedFile).Hash) {
    throw "Legacy FFmpeg differs from the shared build: $($file.FullName). Reconcile the builds before removing it."
  }
}
foreach ($file in $legacyFiles) { Remove-Item -LiteralPath $file.FullName }
Write-Output "Shared FFmpeg is ready under $ffmpegRoot"

if ($Target -in @('cpu', 'both')) {
  if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'cpu\python\python.exe') -PathType Leaf)) {
    throw "The CPU runtime is missing. Prepare whisperx\cpu before building the CUDA runtime."
  }
  Write-Output "CPU runtime is present under $runtimeRoot\cpu"
}

if ($Target -in @('cuda', 'both')) {
  $cpuRuntime = Join-Path $runtimeRoot 'cpu'
  $cudaRuntime = Join-Path $runtimeRoot 'cuda'
  $cudaPython = Join-Path $cudaRuntime 'python\python.exe'
  if (-not (Test-Path -LiteralPath (Join-Path $cpuRuntime 'python\python.exe') -PathType Leaf)) {
    throw "The CPU runtime is required as the base for the CUDA runtime."
  }
  if (-not (Test-Path -LiteralPath $cudaPython -PathType Leaf)) {
    New-Item -ItemType Directory -Force -Path $cudaRuntime | Out-Null
    & robocopy $cpuRuntime $cudaRuntime /E /COPY:DAT /R:2 /W:1 /NFL /NDL /NP
    if ($LASTEXITCODE -gt 7) { exit $LASTEXITCODE }
  }
  Write-Output "Installing CUDA 12.8 PyTorch packages under $cudaRuntime"
  & uv pip install --break-system-packages --reinstall --python $cudaPython --index-url https://download.pytorch.org/whl/cu128 torch==2.8.0 torchaudio==2.8.0 torchvision==0.23.0
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

foreach ($device in @('cpu', 'cuda')) {
  if ($Target -ne 'both' -and $Target -ne $device) { continue }
  $runtimePython = Join-Path $runtimeRoot "$device\python\python.exe"
  & $runtimePython (Join-Path $PSScriptRoot 'prepare-whisperx-runtime.py') --ffmpeg-directory $ffmpegRoot
  if ($LASTEXITCODE -ne 0) { throw "The $device runtime failed codec/checkpoint preparation." }
  & (Join-Path $PSScriptRoot 'trim-runtime-development.ps1') -PythonRoot (Split-Path -Parent $runtimePython) -Apply
  if ($LASTEXITCODE -ne 0) { throw "The $device runtime development-file cleanup failed." }
  # Caps always resolves codecs from the verified shared ffmpeg directory.
  # Old standalone executables beside the Python folder are no longer used.
  $legacyExecutable = [IO.Path]::GetFullPath((Join-Path $runtimeRoot "$device\ffmpeg.exe"))
  $expectedDeviceRoot = [IO.Path]::GetFullPath((Join-Path $runtimeRoot $device))
  if ((Split-Path -Parent $legacyExecutable) -ne $expectedDeviceRoot) { throw 'Unexpected legacy codec path.' }
  if (Test-Path -LiteralPath $legacyExecutable) {
    if ((Get-Item -LiteralPath $legacyExecutable -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a linked legacy codec.' }
    Remove-Item -LiteralPath $legacyExecutable -Force
  }
}

Write-Output "WhisperX runtimes are ready."
