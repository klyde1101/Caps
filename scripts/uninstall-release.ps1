$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$expected = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Caps'))
if ($root -ne $expected) { throw 'Unrecognized installation path.' }
foreach ($name in [IO.File]::ReadLines((Join-Path $root 'installed-files.txt'))) {
    $target = [IO.Path]::GetFullPath((Join-Path $root $name))
    if (-not $target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid installed file path.' }
    if ([IO.File]::Exists($target)) { [IO.File]::Delete($target) }
    elseif ([IO.Directory]::Exists($target) -and -not [IO.Directory]::EnumerateFileSystemEntries($target).GetEnumerator().MoveNext()) {
        [IO.Directory]::Delete($target)
    }
}
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'Caps.lnk') -ErrorAction SilentlyContinue
Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Caps' -ErrorAction SilentlyContinue
[IO.File]::Delete((Join-Path $root 'installed-files.txt'))
[IO.File]::Delete($PSCommandPath)
