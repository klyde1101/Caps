# App updates

Caps uses its existing per-user folder installer and a GitHub Releases feed. It does not use Electron's Squirrel updater or electron-updater's NSIS installer. Their Windows installation formats do not match Caps's custom installer.

## User behavior

An installed Windows folder build checks public releases 15 seconds after startup, then every six hours. Checking and downloading never block startup. Automatic updates default to on; Settings > Updates saves the switch immediately. Turning it off aborts an active app-update download and clears any queued application. Manual checking also downloads a compatible update when one is available. Turning off app updates does not disable Hugging Face model-catalog requests.

A downloaded update applies only after the normal close flow has accepted exit and the app process has ended. Caption-job and unsaved-edit protections remain in charge. Caps does not force a restart. Open Caps again after closing to use the new version. Models, Python/FFmpeg runtimes, user settings, media and exports are excluded from app-update archives. Development and legacy portable builds do not apply updates automatically.

Turning automatic updates off cancels permission to install before saving the preference. Normal exit waits for preference saves; even a failed save cannot restore that cancelled installation. Failed saves are shown as errors instead of being presented as saved preferences. Only one Caps instance owns an installation's update state. New attempts use unique pending records and keep completion receipts so repeated helpers do not overwrite success with a missing-record error. The new helper also serializes application under an installation lock and accepts the older pending.json record format. An older app's bundled helper is replaced only when that app is upgraded.

Existing releases that do not contain the updater cannot acquire it automatically. Users must install an updater-enabled build once. No public release is created or changed by local packaging.

Stable versions ignore prereleases; a beta version can receive newer beta or stable versions. Version comparison follows numeric release/prerelease ordering. Drafts, invalid version tags and downgrades are ignored. The newest release must have compatible update assets; otherwise Settings directs the user to the full installer instead of silently skipping that release.

## Release process

1. Set a new, unique semantic version in package.json and the root package-lock.json records, and write docs/release-<version>.md for the publisher. Use a new version for subsequent tested releases. The explicitly authorized pre-testing beta.1 refresh uses the existing-release procedure below. Complete the outstanding release-checks.md items before publication.
2. Run `scripts/build-legal-notices.py` with the bundled Python if dependencies changed. Review the policy and dependency notices for changed behavior.
3. Run `scripts/build-speech-resources.py` with the bundled Python, then `npm run package:win`. The first step creates this version's shared resource asset and updates its bundled download address. The verified folder build includes the updater, its helper and legal documents.
4. Run `scripts/build-release.py --seven data/release-tools/7za.exe` with the bundled Python. It creates the fresh full installer data, app-only update ZIP, update JSON and checksums. Use `--prepared-parts` only when the numbered parts contain the exact current build; parts from an older build cannot be reused after changing app files.
5. Test installation and updating from the previous release in an isolated folder, including normal exit, interrupted/corrupt downloads and offline startup. Sign the final Setup where a trusted signing identity is available, then refresh its checksum.
6. Commit/push the matching sources and use `scripts/publish-release.ps1`. It requires the matching app-update JSON and ZIP in SHA256SUMS.txt, uploads and verifies every listed asset before publishing the draft. Do not delete support files from older releases that existing installers still reference.

The release builder writes Caps-<version>-Build.json with source fingerprints and asset hashes and includes it in SHA256SUMS.txt. The publisher runs scripts/verify-release.py using the bundled Python before any network or upload work. That check verifies the local package against source, the provenance against current app/native/build sources, every asset hash, and the application bytes inside both the update ZIP and full installer payload. A source edit or a fresh folder build requires refreshed release files; recomputing checksums alone cannot make an old app archive current.

An app-only update contains root Caps.exe plus its complete immutable `dist/app-<build-id>` directory. `scripts/build_app_update.py` can build just these update assets for testing; the full release builder includes them in SHA256SUMS.txt automatically. Standalone update builds must not be published using an older checksum list.

`runtimeRevision` is currently 1 in the updater, installer helper and release builder. Increment it if an app release requires incompatible changes to Python, FFmpeg or another separately installed runtime. Older clients then require a full installation. Do not label an incompatible app-only ZIP with revision 1.

## Verification and recovery

The updater accepts only HTTPS GitHub/API/release-download hosts, verifies metadata against GitHub's asset SHA-256 digest and checks ZIP size and SHA-256 against both the manifest and GitHub. The helper repeats archive verification after exit, rejects traversal, symlinks, duplicate paths and unexpected top-level files, stages the runtime and atomically replaces the launcher. It never executes commands supplied by release text. A same-user local attacker or a compromised publisher account remains outside what repository-provided hashes can authenticate; these hashes are not independent digital signatures or a replacement for Authenticode. Protect the release account and review signing before public distribution.

The old runtime remains in place. `data/updates/previous-launcher.exe` contains the previous launcher; with Caps closed, copy it back to the installation root as Caps.exe to return to that retained build. Update results are in `data/updates/result.json`; a failed attempt is shown on the next startup. A failed or interrupted download retries on the next check instead of installing partial content. Keep the prior runtime until the new build has been validated. Pending updates are checked again after a process crash rather than trusted from disk automatically.

References: [Electron updater platforms](https://www.electronjs.org/docs/latest/api/auto-updater), [electron-builder update formats](https://www.electron.build/docs/features/auto-update/), [GitHub release assets and digests](https://docs.github.com/en/rest/releases/assets).

## Authorized refresh of the first beta

Before target-user testing, the maintainer requested that the cleaned build retain v1.0.0-beta.1. Runtime filenames include their aggregate SHA-256 prefix, so old installers retain access to their original support files. Speech resources at an existing name must remain byte-identical.

After committing and pushing main and the matching tag, run `scripts/publish-release.ps1 -UpdateExisting`. This explicit mode requires an existing mutable release, preserves its title and prerelease state, backs up the previous Setup with a verified Legacy filename, uploads prerequisites before replacing Setup, and checks every uploaded digest. It permits replacement only of Setup, app-update metadata/archive, provenance and current checksums. Existing runtime and speech assets cannot be replaced with different bytes. The default publisher continues to reject changed published assets. Same-version installations must rerun Setup.
