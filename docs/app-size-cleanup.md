# First beta size cleanup

The target-user beta remains 1.0.0-beta.1. Pre-testing fixes do not create a second beta version. Existing local installations with that same version need Setup again because the updater deliberately selects only newer versions.

## Included in the app

Caps keeps the current Electron runtime, both CPU and CUDA speech runtimes, the shared FFmpeg build, and dependency metadata and legal notices. Downloaded models and user settings are preserved. The remaining CUDA/PyTorch DLLs account for most of the speech-runtime size and are not disposable build output.

scripts/trim-runtime-development.ps1 has a dry run by default and applies changes only with -Apply. Its allowlist removes .lib linker inputs from Python/libs and torch/lib, plus .h/.hpp/.hxx/.cuh/.inl compiler headers from Python/Include and torch/include. Legal/notice filenames and every other file type are kept. Every root and traversed directory is checked for Windows reparse points before any deletion; junctions are rejected. The same cleanup runs when preparing future inference runtimes.

The legacy whisperx/cpu/ffmpeg.exe and whisperx/cuda/ffmpeg.exe executables are unused: Caps resolves codecs from whisperx/ffmpeg. Runtime preparation removes those obsolete copies after verifying the shared codecs. The release builder excludes them and rejects prepared archives that still contain them.

## Cleanup performed November 19, 2026

- Removed 18,918 development files, totaling 78,031,962 bytes. A 21,584,684-byte recovery ZIP is kept outside the app workspace in this chat's artifact folder.
- Removed two unused legacy FFmpeg executables totaling 175,276,032 bytes after successful offline CPU and CUDA transcription checks.
- Removed two abandoned package staging directories totaling 770,488,908 bytes after verifying the retained app package.
- Kept models, settings, media, captions, screenshots, source files, required libraries and legal notices.
- The first broad directory total counted two QA junctions as duplicated runtimes. The links point to the live whisperx directory; no live runtime was recursively deleted. Corrected size measurements do not traverse these links.

The actual runtime reduction is 253,307,994 bytes (about 242 MiB). Clearing local build outputs is reported separately from shrinking the installed app or download. Bytecode caches were already excluded from release archives, so clearing them would not reduce downloads and they were not used to inflate the reported savings.

The speech-runtime folder changed from 7,157,232,167 to 6,903,924,173 bytes. Runtime installer data changed from the internal candidate's 4,029,537,270 to 3,937,707,213 bytes, a 91,830,057-byte download reduction. The cleaned first beta uses two support parts. Setup is 4,859,416 bytes. After verifying the new release, eight obsolete local beta.2 assets totaling 4,454,909,502 bytes were removed. No hosted assets were changed.

The release builder now removes obsolete numbered parts after a successful build. Setup isolates exactly its manifest's verified volumes if a directory contains an extra part from an older, larger build. Tests cover both cases. The final suite reports 256 tests: 255 passed and the existing missing-fixture test skipped. The final release freshness check passed for all seven assets, both payloads and current source fingerprints.

An older Electron build was still in use and was deliberately retained. Close and reopen Caps to load the cleaned beta.1 build. Size comparisons apply to this cleaned workspace/runtime and a fresh installation; an older installation that is merely overlaid can retain obsolete files from its previous build.

Validation: both devices produced 13 aligned words and five captions from the offline speech sample after trimming. The full test suite passed with its existing missing-fixture skip. Release artifacts are rebuilt and verified before obsolete local beta.2 artifacts are removed. No GitHub update or commit is part of this cleanup.

## Subsequent publication authorization

The maintainer subsequently authorized committing these changes and refreshing the existing Caps v1.0.0-beta.1 - Windows Installer release. The refreshed Setup uses content-addressed support filenames; previous hosted support files are retained for compatibility. The cleanup measurements above describe the local cleanup before that publication step.
