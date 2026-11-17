# Run once from a regular PowerShell window; the managed workspace cannot write .git.
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Invoke-Git {
    & git @args
    if ($LASTEXITCODE -ne 0) { throw "Git failed: $($args -join ' ')" }
}

Push-Location -LiteralPath $projectRoot
try {
    Invoke-Git remote set-url origin https://github.com/klyde1101/Caps.git
    Invoke-Git fetch --prune origin
    # Short names can render refs/remotes/origin/HEAD as just "origin".
    # Compare full reference names so Git's display rules cannot change validation.
    $branches = @(& git for-each-ref '--format=%(refname)' refs/heads refs/remotes/origin refs/tags)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect repository references.' }
    $unexpected = @($branches | Where-Object { $_ -notin @('refs/heads/main', 'refs/remotes/origin/main', 'refs/remotes/origin/HEAD') })
    if ($unexpected.Count) { throw "Additional branches or tags need review before resetting all history: $($unexpected -join ', ')" }
    $metadata = Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json
    if ($metadata.version -ne '1.0.0-beta.1') { throw 'Expected Caps v1.0.0-beta.1.' }

    # Orphan checkout preserves the working files and starts a history without parents.
    Invoke-Git checkout --orphan caps-beta1-initial
    Invoke-Git add --all
    Invoke-Git commit --message 'Caps v1.0.0-beta.1'
    Invoke-Git branch --move --force main
    Invoke-Git push --force-with-lease --set-upstream origin main
    Invoke-Git reflog expire --expire=now --all
    Invoke-Git gc --prune=now
    Write-Host 'Created and pushed the fresh Caps v1.0.0-beta.1 history.' -ForegroundColor Green
}
finally {
    Pop-Location
}
