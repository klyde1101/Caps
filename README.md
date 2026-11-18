# Caps v1.0.0-beta.1

Offline Windows caption editing and generation using WhisperX. Supported models: Large v3 Turbo and Small. Retired Canary code and Smart Mode tools/instructions are archived under docs/archive, outside the active application path.

Download and run the Windows **Setup-x64.exe** from [GitHub Releases](https://github.com/klyde1101/Caps/releases). Setup downloads and verifies its runtime data automatically and adds Caps to the Start menu. The numbered Runtime ZIP files are installer support data; users only need to download Setup. On first use, download a speech model in Settings; Caps also installs the shared speech resources before generation. No separate portable distribution is offered.

## Distribution layout

Keep Caps.exe, dist/, models/, and whisperx/ together in a writable folder. Caps.exe is a Windows GUI launcher, not a batch file. It starts its exact versioned runtime under dist/app-<build-id>. Never remove ICU, snapshots, DLLs, locales or resources from a runtime.

Settings and logs live under data/. Outputs are saved beside source media. Models are installed into models/ through Settings, with resumable downloads, retry and cancellation. Keep English alignment data, NLTK resources, CPU/CUDA runtimes and shared FFmpeg installed.

## Processing

Automatic prioritizes the selected NVIDIA GPU when available VRAM and RAM meet the model budget. Otherwise it selects CPU when system RAM allows. Recognized CUDA initialization or out-of-memory failures retry the queue on CPU once. Explicit CUDA selection reports failure instead of silently switching devices. Memory estimates are admission checks, not guarantees.

The desktop queue reuses one recognition process for compatible files, transcribes the waiting files, releases recognition weights, then aligns and exports. Recognition batch size is 1 in the queue. CLI transcription uses its separate batching path.

## Caption exports

Exports use the selected orientation: `clip_9X16.srt`, `clip_4X5.srt`, or `clip_16X9.srt`, with matching `.ttml` sidecars. The desktop uses Proxima Nova Semibold at 60px as its fixed caption layout and styled-export basis. SRT itself contains plain text and timing.

## Caption editing

Open generated captions beside local video/audio playback. Save corrections preserves timestamps and drafts on failure. Windows saves acquire an exclusive file handle, validate the expected bytes under the lock, and deny external writes and replacement until completion. A flushed .caps-recovery copy protects the original during writing. On an abrupt system/process failure, preserve that recovery copy before retrying; it can restore the original if the SRT was interrupted. Busy or changed files reject the save and preserve editor drafts.

## Development

Use Node.js 20 or newer, npm ci, npm test, and npm run desktop. npm start runs the CLI. The standalone model installer accepts small and large-v3-turbo. Source assets, scripts, tests and runtime overlays belong in Git; models, runtimes, builds, logs and personal media do not.

Fresh runtime assembly: run scripts/bootstrap-whisperx-runtime.ps1 with uv installed. Pinned environments and the vendored WhisperX Python overlay preserve the current progress and offline-alignment APIs. Building requires network access and has not yet been verified on a clean machine. English alignment/NLTK model data must also be provisioned.

Build the folder application with `npm run package:win`. The package is checked against source before publication. Calling `scripts/package-win.ps1` directly without `-Folder` creates a portable EXE instead.

To assemble the full release, run `scripts/build-speech-resources.py` with the bundled Python first, rebuild the folder application so it includes the generated speech-resource manifest, then run `scripts/build-release.py --seven <path-to-7za.exe>`. This produces Setup, its runtime data, shared speech resources, and checksums in `dist/release/`. Use `--prepared-parts` to rebuild Setup from existing numbered Runtime ZIP parts without recompressing them. After testing, commit and push the matching sources to main, then run `scripts/publish-release.ps1` with an authenticated GitHub CLI. Publishing verifies every local and uploaded checksum before making the beta available; rerun the publisher to resume an interrupted draft.

Every successful EXE rebuild runs guarded project cleanup after package verification. It keeps only the current release (plus any older build still in use), removes the legacy rollback launcher and unused recognized build folders, and clears only `data/runtime-verification`, `data/uv-cache`, and `data/electron-probe-runtime`. Settings, media, models, working Python runtimes, test evidence, source code, and development dependencies are retained. Failed builds do not trigger this cleanup. Preview cleanup with `node scripts/clean-project.mjs`; apply it with `--apply`. The latest cleanup report is saved to `data/logs/project-cleanup.json`.

## Troubleshooting

Startup stages and failures are recorded in data/startup.log and data/launch.log. The launcher waits up to 30 seconds for the application window readiness signal. A failure before main-entry can originate in native Electron initialization; preserve logs and crash dumps before changing the runtime. The beta release has passed installer extraction, launcher/window startup, CPU/CUDA runtime import, and speech-resource integrity checks on the build machine.

If a model cannot fit, choose a smaller model or CPU. If playback is unavailable, caption text can still be edited; use H.264/AAC MP4 for broad playback compatibility. Subtitle-only inputs do not require transcription models.

## Security

Renderer sandboxing and context isolation remain enabled, with validated IPC and a restrictive CSP. Model downloads use allowlisted repositories and staged verification. No media upload is required. This repository audit does not replace a dependency vulnerability review.

## Release checklist

Run unit/regression tests, verify packaged files, launch the EXE outside the managed runner, test real CPU/CUDA media transcription, cancel/retry a model download, and edit/save captions. Keep the current build; successful rebuilds replace the launcher without creating a rollback copy. Do not remove runtime data as temporary build output.

Installer identity is configured in `build/publisher.json`. The installer displays Klyde Alexander V. Penus and sets that name in file properties and the Windows installed-app entry. This metadata is separate from Authenticode signing: the beta remains unsigned, so Windows security prompts still say “Unknown publisher.” See [Windows signing](docs/windows-signing.md). Preview the installer without installing with `Setup-x64.exe --preview welcome` (also `download`, `verify`, `extract`, `complete`, or `error`).

## Version history

1.0.0-beta.1: WhisperX Turbo/Small, live queues, caption editor, fixed Settings layout, Automatic fallback and startup diagnostics.
