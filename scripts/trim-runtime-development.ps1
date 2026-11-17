param([string]$PythonRoot, [switch]$Apply)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$roots = if ($PythonRoot) { @([IO.Path]::GetFullPath($PythonRoot)) } else {
  @((Join-Path $projectRoot 'whisperx\cpu\python'), (Join-Path $projectRoot 'whisperx\cuda\python'))
}
$files = @()
foreach ($root in $roots) {
  if (-not $root.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Runtime trimming must stay within this checkout.'
  }
  # Reject links in every ancestor before enumerating or deleting anything.
  $ancestor = $root
  while ($ancestor -and $ancestor -ne $projectRoot) {
    if ((Test-Path -LiteralPath $ancestor) -and
        ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Refusing a linked runtime path: $ancestor"
    }
    $ancestor = Split-Path -Parent $ancestor
  }
  # Windows inference loads .dll/.pyd files. These .lib files are only inputs to
  # a C++ linker; Caps never builds native extensions in its bundled runtime.
  foreach ($relative in @('Lib\site-packages\torch\lib', 'libs')) {
    $directory = Join-Path $root $relative
    $ancestor = $directory
    while ($ancestor -and $ancestor -ne $root) {
      if ((Test-Path -LiteralPath $ancestor) -and
          ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing a linked library path: $ancestor"
      }
      $ancestor = Split-Path -Parent $ancestor
    }
    if (Test-Path -LiteralPath $directory -PathType Container) {
      $files += @(Get-ChildItem -LiteralPath $directory -File -Filter '*.lib' | Where-Object {
        if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a linked library.' }
        $true
      })
    }
  }
}
$bytes = ($files | Measure-Object Length -Sum).Sum
if ($Apply) {
  $logs = Join-Path $projectRoot 'data\logs'
  New-Item -ItemType Directory -Force -Path $logs | Out-Null
  $manifest = Join-Path $logs ('runtime-trim-' + [guid]::NewGuid().ToString('N') + '.json')
  $files | Select-Object FullName,Length | ConvertTo-Json | Set-Content -LiteralPath $manifest
  foreach ($file in $files) { Remove-Item -LiteralPath $file.FullName -Force }
}
[pscustomobject]@{ Applied=[bool]$Apply; Files=$files.Count; MiB=[math]::Round($bytes/1MB,1) } | Format-List
