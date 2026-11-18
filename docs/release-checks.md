# First beta release checks

This is a local release candidate. Building does not authorize or perform publication.

## Required before publication

- Keep the candidate at v1.0.0-beta.1 for initial target-user testing. Inspect the existing GitHub beta.1 release before any separately authorized change. The publisher deliberately rejects differing assets on a published release; do not bypass that check during cleanup.
- Verify the published contact details remain current. The maintainer supplied klyde.penus1101@gmail.com and the bundled Privacy, Terms and EULA now include it. See legal-maintenance.md for any additional identity/contact review.
- Complete the exact-binary redistribution review for FFmpeg/GPL corresponding source, NVIDIA components, model weights and fonts. Generated notices alone do not complete this review. Record the reviewed versions, evidence and any additional distribution files required.
- Run the packaged desktop outside the managed runner: fresh Setup installation, reinstall, Settings > Updates, normal exit with a queued update, offline startup, caption editing/saving, job and unsaved-edit close guards, and uninstall including the full installed speech runtimes. CPU/CUDA pipeline checks below do not replace this desktop acceptance run. The runner terminates descendants on parent exit, preventing a representative background-helper survival check here.
- Commit and push the matching sources before invoking the publisher. Do not replace existing published assets.

## Local preparation

Use the bundled Python for build-speech-resources.py before package:win, because that step updates src/speech-resources.json for the selected version. Then build-release.py --seven data/release-tools/7za.exe regenerates full runtime data, Setup, update ZIP/JSON and SHA256SUMS.txt. Prepared archives must contain the exact current application and trimmed runtime contents. Existing installations with the same beta.1 version need Setup again; automatic updates only select newer versions.

The publisher selects docs/release-<version>.md. Check that the release notes and update manifest match package.json. The builder also writes Caps-<version>-Build.json; publishing requires its source fingerprints and asset hashes to match. Run scripts/verify-release.py with the bundled Python to verify both archives against the current packaged application before publishing.

## Cleaned first beta on November 19, 2026

- The active app version, package lock, speech-resource URL, release notes and rebuilt assets are 1.0.0-beta.1, as requested before target-user testing. Earlier beta.2 records below refer only to internal local candidates.
- Removed 253,307,994 bytes of compiler inputs and unused legacy codecs from the speech-runtime folder. CPU and CUDA both passed offline transcription after trimming; required libraries, model files, metadata and legal notices were preserved.
- Runtime download data is 3,937,707,213 bytes in two numbered parts. Setup is 4,859,416 bytes. All seven current release assets, both payloads and source fingerprints passed the real release verifier.
- Full suite: 256 tests, 255 passed, one missing-fixture skip, no failures. Added protections/tests for junctions during header cleanup and stale extra archive parts during rebuilding and installation.
- Removed the abandoned package builds and eight obsolete local beta.2 release assets. The older app build still in use was preserved. See app-size-cleanup.md for the size breakdown and recovery archive details.
- No commit, push, publication or modification of hosted GitHub assets occurred. The existing beta.1 release must be inspected before any separately requested GitHub change; same-version installed apps need Setup, not automatic updates.

## Earlier internal beta.2 verification on November 19, 2026

- Full suite: 254 tests, 253 passed, one missing-fixture skip, no failures. Focused release-verifier tests also pass after the final checker changes.
- Immediate opt-out revokes queued installation before disk I/O. Tests cover closing during a delayed preference save and a failed save without restoring the cancelled update.
- Job cancellation returns through normal window closing, including the unsaved-edit and in-progress-save guards. Failed cancellation leaves the window open. A second app launch focuses the existing instance for that installation.
- Concurrent and repeated helpers serialize installation and retain completion receipts. Tests cover the legacy record format, a consumed record, a second attempt for the installed archive, previous-launcher preservation, and damaged old status data.
- Release publishing rejects stale sources or stale archive contents even when checksums are valid. The final local candidate passes the real freshness checker: 14 Electron runtime files, 116 application files, both archive payloads, source fingerprints and all eight release-asset checksums match.
- The latest UI changes are included in the refreshed app and release files. Unchanged speech-runtime ZIP records were retained from the previously verified candidate; the refreshed full ZIP passed CRC validation before splitting.
- tests/fixtures/AUDIO_1.srt was not found in the workspace or available Git history. Its existing test remains explicitly skipped; no substitute was fabricated.
- Changes remain uncommitted as requested. Nothing was published. The outside-runner desktop acceptance run and redistribution review above remain outstanding.

## Earlier verification on November 18, 2026

- Full test suite: 244 tests, 243 passed, one skipped because tests/fixtures/AUDIO_1.srt is absent; no failures. Includes final-staging cancellation, persisted helper-launch errors, real hidden PowerShell execution, download-worker termination and safe manifest merging/removal.
- Bundled private contact: klyde.penus1101@gmail.com appears in Privacy, Terms and EULA, including the verified update archive.
- Windows package: all 14 required Electron runtime files and 115 application files verified against their sources. Full runtime ZIP integrity checked before splitting; all seven release-asset SHA-256 checksums match SHA256SUMS.txt.
- Offline Small-model transcription on CPU and NVIDIA CUDA: a locally generated speech sample produced 13 aligned words and five captions on each device. These checks used the application pipeline with offline model loading; they did not drive the packaged desktop UI.
- Artifact migration: the updater extracted from the preserved beta.1 app verified and downloaded the actual beta.2 ZIP using a local replay of the release feed. Its helper, run directly after the client exited, installed the new app, retained the old runtime and backed up the previous launcher. The beta.2 Setup's app-file manifest merge and native removal then removed both app builds while preserving synthetic settings, model and caption files. Full speech runtimes, Start-menu entries and registry changes were not installed in this isolated test.
- The longest shipped relative path is 158 characters (200 under this user's standard installation folder). The deeply nested visualization test folder exceeded legacy Windows limits; the successful app-file lifecycle test used a shorter isolated folder.

The local candidate is not published. The redistribution review and outside-runner desktop acceptance run above remain required, along with remote version availability and matching committed/pushed sources.

## Authorized existing-release refresh

The maintainer authorized committing and refreshing the existing beta.1 release after cleanup. The publisher now has an explicit UpdateExisting mode with tests: content-addressed runtime names preserve existing downloads, the previous Setup is backed up and verified, and the title, tag and prerelease state are retained. The complete automated suite again passed (255 passed, one existing missing-fixture skip). Earlier local-only status entries above describe their dated checkpoints.
