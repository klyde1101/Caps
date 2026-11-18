param([string]$PythonRoot, [switch]$Apply)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$roots = if ($PythonRoot) { @([IO.Path]::GetFullPath($PythonRoot)) } else {
  @((Join-Path $projectRoot 'whisperx\cpu\python'), (Join-Path $projectRoot 'whisperx\cuda\python'))
}
$files = New-Object 'System.Collections.Generic.List[System.IO.FileInfo]'
$headerDirectories = New-Object 'System.Collections.Generic.List[string]'
function Add-Headers([string]$Directory) {
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return }
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($Directory)
  while ($pending.Count) {
    $current = $pending.Pop()
    if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a linked header directory.' }
    foreach ($entry in Get-ChildItem -LiteralPath $current -Force) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked header content.' }
      if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
      elseif ($entry.Extension -in @('.h','.hpp','.hxx','.cuh','.inl') -and $entry.Name -notmatch '(?i)license|notice|copying') {
        $script:files.Add($entry)
      }
    }
  }
  $script:headerDirectories.Add($Directory)
}
foreach ($root in $roots) {
  if (-not $root.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Runtime trimming must stay within this checkout.'
  }
  if ($root -notin @((Join-Path $projectRoot 'whisperx\cpu\python'), (Join-Path $projectRoot 'whisperx\cuda\python'))) {
    throw 'Only the bundled CPU and CUDA Python roots can be trimmed.'
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
      foreach ($file in Get-ChildItem -LiteralPath $directory -File -Filter '*.lib') {
        if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a linked library.' }
        $files.Add($file)
      }
    }
  }
  # These two explicit trees contain compiler headers, not inference data.
  # Keep legal notices, Python sources, DLLs, model weights and all other files.
  foreach ($relative in @('Include','Lib\site-packages\torch\include')) {
    $directory = Join-Path $root $relative
    $ancestor = $directory
    while ($ancestor -and $ancestor -ne $root) {
      if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing a linked header path.' }
      $ancestor = Split-Path -Parent $ancestor
    }
    Add-Headers $directory
  }
}
$bytes = ($files | Measure-Object Length -Sum).Sum
if ($Apply) {
  $logs = Join-Path $projectRoot 'data\logs'
  New-Item -ItemType Directory -Force -Path $logs | Out-Null
  $manifest = Join-Path $logs ('runtime-trim-' + [guid]::NewGuid().ToString('N') + '.json')
  $files | Select-Object FullName,Length | ConvertTo-Json | Set-Content -LiteralPath $manifest
  foreach ($file in $files) { Remove-Item -LiteralPath $file.FullName -Force }
  foreach ($directory in $headerDirectories) {
    $emptyCandidates = @((Get-ChildItem -LiteralPath $directory -Directory -Recurse -Force | Sort-Object { $_.FullName.Length } -Descending | Select-Object -ExpandProperty FullName)) + @($directory)
    foreach ($candidate in $emptyCandidates) {
      if ([IO.Directory]::Exists($candidate) -and [IO.Directory]::GetFileSystemEntries($candidate).Length -eq 0) { [IO.Directory]::Delete($candidate) }
    }
  }
}
[pscustomobject]@{ Applied=[bool]$Apply; Files=$files.Count; MiB=[math]::Round($bytes/1MB,1) } | Format-List
