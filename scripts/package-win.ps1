param([switch]$Folder)

$ErrorActionPreference = 'Stop'

function Get-BuildIdentity([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try { return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').Substring(0, 12).ToLowerInvariant() }
  finally { $sha256.Dispose(); $stream.Dispose() }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
$packageMetadata = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$artifactName = "Caps-$($packageMetadata.version).exe"
$stagingRoot = Join-Path $distRoot ('.package-' + [guid]::NewGuid().ToString('N'))
Write-Output "Packaging Caps build into $stagingRoot"

Push-Location $projectRoot
try {
  # Leave previous builds intact until the replacement has passed verification.
  $builderArguments = @('electron-builder', 'build', '--win', "--config.directories.output=$stagingRoot")
  if ($Folder) { $builderArguments += '--dir' } else { $builderArguments += 'portable' }
  $localElectron = Join-Path $projectRoot 'node_modules\electron\dist'
  if (Test-Path -LiteralPath (Join-Path $localElectron 'electron.exe') -PathType Leaf) {
    $builderArguments += "--config.electronDist=$localElectron"
  }
  & npx @builderArguments
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  $artifact = Join-Path $stagingRoot $artifactName
  if ($Folder) { $artifact = Join-Path $stagingRoot 'win-unpacked\Caps.exe' }
  if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
    throw "Packaged artifact was not created at $artifact"
  }
  $portableArtifact = $artifact
  if ($Folder) { $portableArtifact = '-' }
  & node (Join-Path $PSScriptRoot 'verify-windows-package.mjs') (Join-Path $stagingRoot 'win-unpacked') $localElectron $portableArtifact $projectRoot
  if ($LASTEXITCODE -ne 0) { throw "Package verification failed; previous builds were preserved at $distRoot" }
  if ($Folder) {
    $asarHash = Get-BuildIdentity (Join-Path $stagingRoot 'win-unpacked\resources\app.asar')
    $exeHash = Get-BuildIdentity $artifact
    $relativeRuntime = "dist\app-$asarHash$exeHash"
    $publishedFolder = Join-Path $projectRoot $relativeRuntime
    $folderLauncher = Join-Path $stagingRoot 'Caps-launcher.exe'
    & (Join-Path $PSScriptRoot 'build-windows-launcher.ps1') -OutputPath $folderLauncher -RuntimeDirectory $relativeRuntime
    if (Test-Path -LiteralPath $publishedFolder) {
      & node (Join-Path $PSScriptRoot 'verify-windows-package.mjs') $publishedFolder $localElectron '-' $projectRoot
      if ($LASTEXITCODE -ne 0) { throw 'An existing immutable build is damaged; previous launchers were preserved.' }
    } else {
      # Directory.Move performs a same-volume rename; it never moves runtime files individually.
      [System.IO.Directory]::Move((Join-Path $stagingRoot 'win-unpacked'), $publishedFolder)
    }
    $launcher = Join-Path $projectRoot 'Caps.exe'
    if (Test-Path -LiteralPath $launcher) { [System.IO.File]::Replace($folderLauncher, $launcher, [System.Management.Automation.Language.NullString]::Value) }
    else { [System.IO.File]::Move($folderLauncher, $launcher) }
    & node (Join-Path $PSScriptRoot 'clean-project.mjs') --apply --staging-root $stagingRoot
    if ($LASTEXITCODE -ne 0) { throw 'The build was published, but project cleanup stopped. Retained files require review.' }
    & (Join-Path $PSScriptRoot 'clean-package-staging.ps1') -StagingRoot $stagingRoot -KeepUnpacked -PublishedFolder $publishedFolder
  } else {
    # Launch beside the model/runtime folders with the original embedded Caps icon.
    $launcher = Join-Path $projectRoot 'Caps.exe'
    if (Test-Path -LiteralPath $launcher) { [System.IO.File]::Replace($artifact, $launcher, [System.Management.Automation.Language.NullString]::Value) }
    else { [System.IO.File]::Move($artifact, $launcher) }
    & node (Join-Path $PSScriptRoot 'clean-project.mjs') --apply --staging-root $stagingRoot --published-runtime (Join-Path $stagingRoot 'win-unpacked')
    if ($LASTEXITCODE -ne 0) { throw 'The build was published, but project cleanup stopped. Retained files require review.' }
    & (Join-Path $PSScriptRoot 'clean-package-staging.ps1') -StagingRoot $stagingRoot
  }
  if ((Test-Path -LiteralPath $distRoot -PathType Container) -and -not (Get-ChildItem -LiteralPath $distRoot -Force | Select-Object -First 1)) {
    Remove-Item -LiteralPath $distRoot
  }
}
finally {
  Pop-Location
}

Write-Output "Packaging completed: $launcher"
