param([Parameter(Mandatory = $true)][string]$OutputPath, [string]$RuntimeDirectory = 'dist\win-unpacked')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
  throw 'The Windows .NET Framework compiler is missing; the previous Caps build was preserved.'
}
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$projectPrefix = [System.IO.Path]::GetFullPath($projectRoot).TrimEnd('\') + '\'
if (-not $resolvedOutput.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to create a launcher outside the project: $resolvedOutput"
}
[System.IO.Directory]::CreateDirectory((Split-Path -Parent $resolvedOutput)) | Out-Null
$resolvedRuntime = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $RuntimeDirectory))
$distPrefix = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist')).TrimEnd('\') + '\'
if (-not $resolvedRuntime.StartsWith($distPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The launcher runtime must be inside the project dist folder.'
}
$directoryResource = $resolvedOutput + '.directory.txt'
try {
  [System.IO.File]::WriteAllText($directoryResource, $RuntimeDirectory)
  & $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$resolvedOutput" "/win32icon:$(Join-Path $projectRoot 'build\caps-icon.ico')" "/resource:$directoryResource,Caps.AppDirectory" /reference:System.Windows.Forms.dll (Join-Path $PSScriptRoot 'windows-launcher.cs')
  if ($LASTEXITCODE -ne 0) { throw 'The Caps EXE launcher could not be compiled.' }
}
finally { if (Test-Path -LiteralPath $directoryResource) { [System.IO.File]::Delete($directoryResource) } }
$assembly = [System.Reflection.AssemblyName]::GetAssemblyName($resolvedOutput)
if ($assembly.ProcessorArchitecture -ne 'Amd64') { throw 'Expected a 64-bit Caps launcher.' }
Write-Output "Compiled the Caps Windows EXE launcher: $resolvedOutput"
