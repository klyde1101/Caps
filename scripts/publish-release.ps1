param([switch]$KeepDraft)

$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath (Join-Path $PSScriptRoot '..')
try {
    $version = (Get-Content -Raw package.json | ConvertFrom-Json).version
    $tag = "v$version"
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
    if ($assets.Count -lt 3) { throw 'The release needs both a portable package and an installer.' }
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
        # Upload while still a draft so models and packages become available together.
        gh release create $tag --repo $repo --target $head --title "Caps v$version" --notes-file docs/release-beta1.md --draft --prerelease
        if ($LASTEXITCODE -ne 0) { throw 'Cannot create release draft.' }
    }
    # GitHub's lookup by tag excludes drafts. Find the draft's release ID first.
    $allReleases = gh api "repos/$repo/releases?per_page=100" | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the release draft.' }
    $release = @($allReleases | Where-Object tag_name -eq $tag)
    if ($release.Count -ne 1) { throw 'Cannot uniquely locate the release.' }
    $release = $release[0]
    if ($release.target_commitish -ne $head) { throw 'The existing release targets a different commit.' }
    foreach ($asset in $assets) {
        $file = Get-Item -LiteralPath $asset
        $remote = @($release.assets | Where-Object name -eq $file.Name)
        $expectedDigest = 'sha256:' + $expectedAssets[$file.Name].ToLowerInvariant()
        if ($remote.Count -eq 1 -and $remote[0].size -eq $file.Length -and $remote[0].digest -eq $expectedDigest) {
            Write-Output "Already uploaded and verified: $($file.Name)"
            continue
        }
        if (-not $release.draft) { throw "Published release asset differs: $($file.Name)" }
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
    if ($release.draft -and -not $KeepDraft) {
        gh release edit $tag --repo $repo --notes-file docs/release-beta1.md --draft=false --prerelease
        if ($LASTEXITCODE -ne 0) { throw 'Assets uploaded. Publishing the draft failed; run this script again.' }
    }
    if ($release.draft -and $KeepDraft) { Write-Output "Draft assets verified: $($release.html_url)" }
    else { Write-Output "Published and verified: $($release.html_url)" }
} finally { Pop-Location }
