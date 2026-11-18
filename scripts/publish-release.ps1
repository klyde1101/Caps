param([switch]$KeepDraft, [switch]$UpdateExisting, [string]$Python)

$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath (Join-Path $PSScriptRoot '..')
try {
    $version = (Get-Content -Raw package.json | ConvertFrom-Json).version
    $tag = "v$version"
    $notes = "docs/release-$version.md"
    if (-not (Test-Path -LiteralPath $notes -PathType Leaf)) { throw "Missing release notes: $notes" }
    $repo = 'klyde1101/Caps'
    $directory = Join-Path $PWD 'dist/release'
    $checksums = Join-Path $directory 'SHA256SUMS.txt'
    $assets = @($checksums)
    $expectedAssets = @{}
    foreach ($line in Get-Content -LiteralPath $checksums) {
        if ($line -notmatch '^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$') { throw 'Invalid SHA256SUMS.txt entry.' }
        $expected = $Matches[1]
        $asset = Join-Path $directory $Matches[2]
        if ((Get-FileHash -LiteralPath $asset).Hash -ne $expected) { throw "Changed release asset: $asset" }
        if ($expectedAssets.ContainsKey($Matches[2])) { throw 'Duplicate release asset.' }
        $expectedAssets[$Matches[2]] = $expected
        $assets += $asset
    }
    if ($assets.Count -lt 3) { throw 'The release needs installer runtime data and Setup.' }
    $updateName = "Caps-$version-Update.json"
    $updateArchive = "Caps-$version-Update-x64.zip"
    if (-not $expectedAssets.ContainsKey($updateName) -or -not $expectedAssets.ContainsKey($updateArchive)) {
        throw 'Build a fresh release with the app-update JSON and ZIP included in SHA256SUMS.txt before publishing.'
    }
    $update = Get-Content -LiteralPath (Join-Path $directory $updateName) -Raw | ConvertFrom-Json
    if ($update.schema -ne 1 -or $update.version -ne $version -or $update.archive -ne $updateArchive -or
        $update.sha256 -ne $expectedAssets[$updateArchive] -or
        $update.size -ne (Get-Item -LiteralPath (Join-Path $directory $updateArchive)).Length) {
        throw 'The app-update manifest does not match the release version and archive.'
    }
    if (-not $Python) { $Python = Join-Path $PWD 'whisperx/cpu/python/python.exe' }
    & $Python -B (Join-Path $PSScriptRoot 'verify-release.py') --project-root $PWD
    if ($LASTEXITCODE -ne 0) { throw 'Release freshness verification failed. Rebuild before publishing.' }
    $expectedAssets['SHA256SUMS.txt'] = (Get-FileHash -LiteralPath $checksums).Hash.ToLowerInvariant()
    foreach ($asset in $assets) {
        if ((Get-Item -LiteralPath $asset).Length -ge 2GB) { throw "Release asset exceeds GitHub's size limit: $asset" }
    }
    $changes = git status --porcelain
    if ($LASTEXITCODE -ne 0 -or $changes) { throw 'Commit the release sources before publishing.' }
    git fetch origin main
    if ($LASTEXITCODE -ne 0) { throw 'Cannot fetch origin/main.' }
    $head = git rev-parse HEAD
    if ((git rev-parse FETCH_HEAD) -ne $head) { throw 'Push the release commit to main before publishing.' }
    $releases = gh release list --repo $repo --limit 100 --json tagName,isDraft | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect existing releases.' }
    if (-not @($releases | Where-Object tagName -eq $tag).Count) {
        if ($UpdateExisting) { throw 'The requested existing release was not found; no new release was created.' }
        # Upload while still a draft so models and packages become available together.
        gh release create $tag --repo $repo --target $head --title "Caps v$version" --notes-file $notes --draft --prerelease
        if ($LASTEXITCODE -ne 0) { throw 'Cannot create release draft.' }
    }
    # GitHub's lookup by tag excludes drafts. Find the draft's release ID first.
    $release = @()
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        $allReleases = gh api "repos/$repo/releases?per_page=100" | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the release draft.' }
        $release = @($allReleases | Where-Object tag_name -eq $tag)
        if ($release.Count) { break }
        if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
    }
    if ($release.Count -ne 1) { throw 'Cannot uniquely locate the release.' }
    $release = $release[0]
    if ($UpdateExisting) {
        if ($release.immutable) { throw 'GitHub marks this release immutable; it cannot be updated.' }
        $tagRef = gh api "repos/$repo/git/ref/tags/$tag" | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or $tagRef.object.sha -ne $head) { throw 'Push the matching release tag before updating the existing release.' }
    } elseif ($release.target_commitish -ne $head) { throw 'The existing release targets a different commit.' }
    $mutableNames = @("Caps-$version-Setup-x64.exe", "Caps-$version-Update-x64.zip", "Caps-$version-Update.json", "Caps-$version-Build.json", 'SHA256SUMS.txt')
    # Preflight every replacement before the first upload. Runtime and speech
    # resource bytes at an existing name must never change on a published release.
    foreach ($asset in $assets) {
        $file = Get-Item -LiteralPath $asset
        $remote = @($release.assets | Where-Object name -eq $file.Name)
        $same = $remote.Count -eq 1 -and $remote[0].size -eq $file.Length -and $remote[0].digest -eq ('sha256:' + $expectedAssets[$file.Name])
        if (-not $release.draft -and -not $same -and
            (-not $UpdateExisting -or ($remote.Count -gt 0 -and $file.Name -notin $mutableNames))) {
            throw "Published release asset differs: $($file.Name)"
        }
    }
    $preserved = @($release.assets | Where-Object { $_.name -like "Caps-$version-Support-Runtime-*" -or $_.name -eq "Caps-$version-Speech-Resources.zip" })
    if ($UpdateExisting -and -not $release.draft) {
        $oldSetup = @($release.assets | Where-Object name -eq "Caps-$version-Setup-x64.exe")
        if ($oldSetup.Count -eq 1 -and $oldSetup[0].digest -ne ('sha256:' + $expectedAssets[$oldSetup[0].name])) {
            if ($oldSetup[0].digest -notmatch '^sha256:([0-9a-f]{64})$') { throw 'Cannot verify the previous installer before replacing it.' }
            $oldHash = $Matches[1]
            $legacyName = "Legacy-Caps-$version-Setup-$($oldHash.Substring(0,12)).exe"
            $backupAsset = @($release.assets | Where-Object name -eq $legacyName)
            if ($backupAsset.Count -eq 0) {
                $work = Join-Path ([IO.Path]::GetTempPath()) ('CapsReleaseBackup-' + [guid]::NewGuid().ToString('N'))
                [IO.Directory]::CreateDirectory($work) | Out-Null
                try {
                    gh release download $tag --repo $repo --pattern $oldSetup[0].name --dir $work
                    if ($LASTEXITCODE -ne 0) { throw 'Cannot preserve the previous installer.' }
                    $downloaded = Join-Path $work $oldSetup[0].name
                    if ((Get-FileHash -LiteralPath $downloaded).Hash.ToLowerInvariant() -ne $oldHash) { throw 'Previous installer download failed verification.' }
                    $backupFile = Join-Path $work $legacyName
                    [IO.File]::Move($downloaded, $backupFile)
                    gh release upload $tag $backupFile --repo $repo
                    if ($LASTEXITCODE -ne 0) { throw 'Cannot upload the previous installer backup.' }
                    $uploaded = gh api "repos/$repo/releases/$($release.id)" | ConvertFrom-Json
                    $backupAsset = @($uploaded.assets | Where-Object name -eq $legacyName)
                } finally {
                    $resolvedWork = [IO.Path]::GetFullPath($work)
                    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\CapsReleaseBackup-'
                    if ($resolvedWork.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolvedWork -Recurse -Force }
                }
            }
            if ($backupAsset.Count -ne 1 -or $backupAsset[0].digest -ne $oldSetup[0].digest -or $backupAsset[0].size -ne $oldSetup[0].size) {
                throw 'The previous installer backup could not be verified.'
            }
        }
        # Publish prerequisites first, the replacement Setup next, checksums last.
        $assets = @($assets | Sort-Object { if ((Split-Path -Leaf $_) -eq 'SHA256SUMS.txt') { 2 } elseif ((Split-Path -Leaf $_) -eq "Caps-$version-Setup-x64.exe") { 1 } else { 0 } })
    }
    foreach ($asset in $assets) {
        $file = Get-Item -LiteralPath $asset
        $remote = @($release.assets | Where-Object name -eq $file.Name)
        $expectedDigest = 'sha256:' + $expectedAssets[$file.Name].ToLowerInvariant()
        if ($remote.Count -eq 1 -and $remote[0].size -eq $file.Length -and $remote[0].digest -eq $expectedDigest) {
            Write-Output "Already uploaded and verified: $($file.Name)"
            continue
        }
        Write-Output "Uploading $($file.Name) ($($file.Length) bytes)"
        gh release upload $tag $asset --repo $repo --clobber
        if ($LASTEXITCODE -ne 0) { throw 'Asset upload stopped. Run this script again to resume the draft.' }
    }
    $release = gh api "repos/$repo/releases/$($release.id)" | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot verify uploaded release assets.' }
    foreach ($asset in $assets) {
        $file = Get-Item -LiteralPath $asset
        $remote = @($release.assets | Where-Object name -eq $file.Name)
        if ($remote.Count -ne 1 -or $remote[0].size -ne $file.Length -or
            $remote[0].digest -ne ('sha256:' + $expectedAssets[$file.Name].ToLowerInvariant())) {
            throw "GitHub has not verified the expected asset: $($file.Name)"
        }
    }
    foreach ($old in $preserved) {
        $remaining = @($release.assets | Where-Object name -eq $old.name)
        if ($remaining.Count -ne 1 -or $remaining[0].digest -ne $old.digest -or $remaining[0].size -ne $old.size) {
            throw "Existing installers' support asset changed: $($old.name)"
        }
    }
    if ($UpdateExisting -and -not $release.draft) {
        $originalTitle = $release.name
        $prereleaseFlag = '--prerelease=' + ([bool]$release.prerelease).ToString().ToLowerInvariant()
        gh release edit $tag --repo $repo --title $originalTitle --target $head --notes-file $notes $prereleaseFlag
        if ($LASTEXITCODE -ne 0) { throw 'Assets verified, but updating the existing release notes failed. Retry this command.' }
        $release = gh api "repos/$repo/releases/$($release.id)" | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or $release.name -ne $originalTitle -or $release.tag_name -ne $tag -or $release.draft) {
            throw 'Cannot confirm the existing release title, tag and publication state.'
        }
    }
    if ($release.draft -and -not $KeepDraft) {
        gh release edit $tag --repo $repo --tag $tag --target $head --notes-file $notes --draft=false --prerelease
        if ($LASTEXITCODE -ne 0) { throw 'Assets uploaded. Publishing the draft failed; run this script again.' }
        $release = gh api "repos/$repo/releases/$($release.id)" | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or $release.draft -or $release.tag_name -ne $tag) {
            throw 'Cannot confirm the published release tag.'
        }
    }
    if ($release.draft -and $KeepDraft) { Write-Output "Draft assets verified: $($release.html_url)" }
    else { Write-Output "Published and verified: $($release.html_url)" }
} finally { Pop-Location }
