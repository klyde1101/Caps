import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

test('release publishing resumes verified uploads and rejects changed published assets', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'caps-publishing-'));
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'docs'));
    await mkdir(join(root, 'dist', 'release'), { recursive: true });
    await copyFile(new URL('../scripts/publish-release.ps1', import.meta.url), join(root, 'scripts', 'publish-release.ps1'));
    await writeFile(join(root, 'package.json'), '{"version":"1.0.0-beta.1"}');
    await writeFile(join(root, 'docs', 'release-beta1.md'), 'Test release');
    await writeFile(join(root, 'dist', 'release', 'Portable.zip'), 'portable fixture');
    await writeFile(join(root, 'dist', 'release', 'Setup.exe'), 'installer fixture');
    const harness = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility') -ErrorAction Stop
Set-Location -LiteralPath $PSScriptRoot
$directory = Join-Path $PWD 'dist/release'
$lines = foreach ($name in @('Portable.zip', 'Setup.exe')) {
    (Get-FileHash -LiteralPath (Join-Path $directory $name)).Hash.ToLowerInvariant() + '  ' + $name
}
[IO.File]::WriteAllLines((Join-Path $directory 'SHA256SUMS.txt'), [string[]]$lines)
$global:state = @{ id = 123; tag_name = 'v1.0.0-beta.1'; draft = $true; target_commitish = ('a' * 40); html_url = 'https://example.test/release'; assets = @() }
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
        if ($args[1] -match '/tags/') { throw 'Drafts cannot be looked up by tag.' }
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
            if ($file.Name -eq 'Setup.exe' -and $global:failSetup) { $global:LASTEXITCODE = 1; return }
            $global:uploads += $file.Name
            $global:state.assets = @($global:state.assets | Where-Object name -ne $file.Name) + @(@{
                name = $file.Name; size = $file.Length
                digest = 'sha256:' + (Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant()
            })
            return
        }
        'edit' { $global:state.draft = $false; return }
        default { throw ('Unexpected GitHub operation: ' + ($args -join ' ')) }
    }
}
$publisher = Join-Path $PWD 'scripts/publish-release.ps1'
$failed = $false
try { & $publisher | Out-Null } catch {
    if ($_.Exception.Message -notmatch 'upload stopped') { throw }
    $failed = $true
}
if (-not $failed -or -not $global:state.draft) { throw 'Interrupted upload must leave a draft.' }
if ($global:uploads.Count -ne 2) { throw 'Expected checksum and portable uploads before interruption.' }
$global:failSetup = $false
& $publisher -KeepDraft | Out-Null
if (-not $global:state.draft -or $global:uploads.Count -ne 3) { throw 'KeepDraft must verify all uploads without publishing.' }
& $publisher | Out-Null
if ($global:state.draft -or $global:uploads.Count -ne 3) { throw 'Resume must upload only the missing installer and publish.' }
& $publisher | Out-Null
if ($global:uploads.Count -ne 3) { throw 'Verified published assets must not be uploaded again.' }
$global:state.assets[0].digest = 'sha256:changed'
$failed = $false
try { & $publisher | Out-Null } catch {
    if ($_.Exception.Message -notmatch 'Published release asset differs') { throw }
    $failed = $true
}
if (-not $failed -or $global:uploads.Count -ne 3) { throw 'Changed published assets must be rejected without mutation.' }
'publishing-tests-ok'
`;
    const harnessPath = join(root, 'verify.ps1');
    await writeFile(harnessPath, harness);
    const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harnessPath], { windowsHide: true, timeout: 20000 });
    assert.match(result.stdout, /publishing-tests-ok/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
