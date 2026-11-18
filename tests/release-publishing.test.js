import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const python = fileURLToPath(new URL('../whisperx/cpu/python/python.exe', import.meta.url));

test('release publishing resumes verified uploads and rejects changed published assets', { skip: process.platform !== 'win32' || !existsSync(python) }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-publishing-'));
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'docs'));
    await mkdir(join(root, 'dist', 'release'), { recursive: true });
    await copyFile(new URL('../scripts/publish-release.ps1', import.meta.url), join(root, 'scripts', 'publish-release.ps1'));
    // Test upload/resume behavior independently; the real verifier has archive tests.
    await writeFile(join(root, 'scripts', 'verify-release.py'), "from pathlib import Path\nimport sys\nPath('verification.called').write_text('called')\nsys.exit(2 if Path('stale.flag').exists() else 0)\n");
    await writeFile(join(root, 'package.json'), '{"version":"1.0.0-beta.1"}');
    await writeFile(join(root, 'docs', 'release-1.0.0-beta.1.md'), 'Test release');
    await writeFile(join(root, 'dist', 'release', 'Portable.zip'), 'portable fixture');
    await writeFile(join(root, 'dist', 'release', 'Caps-1.0.0-beta.1-Setup-x64.exe'), 'installer fixture');
    await writeFile(join(root, 'dist', 'release', 'Caps-1.0.0-beta.1-Update-x64.zip'), 'update fixture');
    const harness = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility') -ErrorAction Stop
Set-Location -LiteralPath $PSScriptRoot
$directory = Join-Path $PWD 'dist/release'
$python = $env:CAPS_TEST_PYTHON
$updateArchive = Join-Path $directory 'Caps-1.0.0-beta.1-Update-x64.zip'
@{ schema=1; version='1.0.0-beta.1'; archive='Caps-1.0.0-beta.1-Update-x64.zip';
    size=(Get-Item -LiteralPath $updateArchive).Length; sha256=(Get-FileHash -LiteralPath $updateArchive).Hash.ToLowerInvariant() } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $directory 'Caps-1.0.0-beta.1-Update.json') -Encoding UTF8
$lines = foreach ($name in @('Portable.zip', 'Caps-1.0.0-beta.1-Setup-x64.exe', 'Caps-1.0.0-beta.1-Update-x64.zip', 'Caps-1.0.0-beta.1-Update.json')) {
    (Get-FileHash -LiteralPath (Join-Path $directory $name)).Hash.ToLowerInvariant() + '  ' + $name
}
[IO.File]::WriteAllLines((Join-Path $directory 'SHA256SUMS.txt'), [string[]]$lines)
$global:state = @{ id = 123; name='Caps v1.0.0-beta.1 - Windows Installer'; prerelease=$true; tag_name = 'v1.0.0-beta.1'; draft = $true; target_commitish = ('a' * 40); html_url = 'https://example.test/release'; assets = @() }
$global:uploads = @()
$global:failSetup = $true
$global:listReads = 0
function global:git {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'rev-parse') { 'a' * 40 }
}
function global:gh {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'api') {
        if ($args[1] -match '/releases/tags/') { throw 'Drafts cannot be looked up by tag.' }
        if ($args[1] -match '/git/ref/') { @{ object=@{sha=('a' * 40)} } | ConvertTo-Json; return }
        if ($args[1] -match '\?per_page=') {
            $global:listReads++
            if ($global:listReads -eq 1) { '[]' }
            else { ConvertTo-Json -InputObject @($global:state) -Depth 8 }
        }
        else { $global:state | ConvertTo-Json -Depth 8 }
        return
    }
    switch ($args[1]) {
        'list' { ConvertTo-Json -InputObject @(@{ tagName = 'v1.0.0-beta.1'; isDraft = $global:state.draft }); return }
        'upload' {
            $file = Get-Item -LiteralPath $args[3]
            if ($file.Name -eq 'Caps-1.0.0-beta.1-Setup-x64.exe' -and $global:failSetup) { $global:LASTEXITCODE = 1; return }
            $global:uploads += $file.Name
            $global:state.assets = @($global:state.assets | Where-Object name -ne $file.Name) + @(@{
                name = $file.Name; size = $file.Length
                digest = 'sha256:' + (Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant()
            })
            return
        }
        'download' {
            $folder=$args[[array]::IndexOf($args,'--dir')+1]
            $name=$args[[array]::IndexOf($args,'--pattern')+1]
            [IO.File]::WriteAllText((Join-Path $folder $name),$global:previousSetup)
            return
        }
        'edit' {
            $global:state.draft = $false
            $index=[array]::IndexOf($args,'--target'); if ($index -ge 0) { $global:state.target_commitish=$args[$index+1] }
            $index=[array]::IndexOf($args,'--title'); if ($index -ge 0) { $global:state.name=$args[$index+1] }
            return
        }
        default { throw ('Unexpected GitHub operation: ' + ($args -join ' ')) }
    }
}
$publisher = Join-Path $PWD 'scripts/publish-release.ps1'
[IO.File]::WriteAllText((Join-Path $PWD 'stale.flag'), 'stale')
$rejected = $false
try { & $publisher -Python $python | Out-Null } catch {
    if ($_.Exception.Message -notmatch 'freshness verification failed') { throw }
    $rejected = $true
}
if (-not $rejected -or $global:uploads.Count -ne 0 -or -not (Test-Path -LiteralPath 'verification.called')) {
    throw 'Stale releases must be rejected before any upload.'
}
Remove-Item -LiteralPath (Join-Path $PWD 'stale.flag')
$failed = $false
try { & $publisher -Python $python | Out-Null } catch {
    if ($_.Exception.Message -notmatch 'upload stopped') { throw }
    $failed = $true
}
if (-not $failed -or -not $global:state.draft) { throw 'Interrupted upload must leave a draft.' }
if ($global:uploads.Count -ne 2) { throw 'Expected checksum and portable uploads before interruption.' }
$global:failSetup = $false
& $publisher -KeepDraft -Python $python | Out-Null
if (-not $global:state.draft -or $global:uploads.Count -ne 5) { throw 'KeepDraft must verify all uploads without publishing.' }
& $publisher -Python $python | Out-Null
if ($global:state.draft -or $global:uploads.Count -ne 5) { throw 'Resume must upload only the missing installer and publish.' }
& $publisher -Python $python | Out-Null
if ($global:uploads.Count -ne 5) { throw 'Verified published assets must not be uploaded again.' }
$global:state.assets[0].digest = 'sha256:changed'
$failed = $false
try { & $publisher -Python $python | Out-Null } catch {
    if ($_.Exception.Message -notmatch 'Published release asset differs') { throw }
    $failed = $true
}
if (-not $failed -or $global:uploads.Count -ne 5) { throw 'Changed published assets must be rejected without mutation.' }
# Only the explicit existing-release mode can replace Setup; it archives the old
# executable and preserves the existing release title, tag and support assets.
($global:state.assets | Where-Object name -eq 'SHA256SUMS.txt').digest = 'sha256:' + (Get-FileHash -LiteralPath (Join-Path $directory 'SHA256SUMS.txt')).Hash.ToLowerInvariant()
$global:previousSetup='previous setup fixture'
$oldHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($global:previousSetup))).Replace('-','').ToLowerInvariant()
$oldSetup=$global:state.assets | Where-Object name -eq 'Caps-1.0.0-beta.1-Setup-x64.exe'
$oldSetup.digest='sha256:'+$oldHash; $oldSetup.size=[Text.Encoding]::UTF8.GetByteCount($global:previousSetup)
$global:state.target_commitish='b'*40
& $publisher -UpdateExisting -Python $python | Out-Null
if ($global:state.name -ne 'Caps v1.0.0-beta.1 - Windows Installer' -or $global:state.tag_name -ne 'v1.0.0-beta.1' -or $global:state.draft) { throw 'Existing release identity changed.' }
$backup=@($global:state.assets | Where-Object name -eq ('Legacy-Caps-1.0.0-beta.1-Setup-'+$oldHash.Substring(0,12)+'.exe'))
if ($backup.Count -ne 1 -or $backup[0].digest -ne ('sha256:'+$oldHash)) { throw 'Previous Setup was not preserved and verified.' }
if ($global:uploads[-1] -ne 'Caps-1.0.0-beta.1-Setup-x64.exe') { throw 'Replacement Setup must follow prerequisites.' }
$count=$global:uploads.Count
($global:state.assets | Where-Object name -eq 'Portable.zip').digest='sha256:changed'
$failed=$false
try { & $publisher -UpdateExisting -Python $python | Out-Null } catch {
    if ($_.Exception.Message -notmatch 'Published release asset differs') { throw }
    $failed=$true
}
if (-not $failed -or $global:uploads.Count -ne $count) { throw 'Explicit update must still refuse changed support assets before uploads.' }
'publishing-tests-ok'
`;
    const harnessPath = join(root, 'verify.ps1');
    await writeFile(harnessPath, harness);
    const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harnessPath], {
      windowsHide: true, timeout: 20000, env: { ...process.env, CAPS_TEST_PYTHON: python }
    });
    assert.match(result.stdout, /publishing-tests-ok/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
