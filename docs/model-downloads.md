# Settings popups and model downloads

Caps uses its bundled Python and `huggingface_hub` 0.36.2; no system Python, CLI installation, or new npm dependency is required. The renderer cannot choose an executable, repository, or destination. IPC accepts only supported model IDs.

## Files changed

- `src/model-repositories.json` — shared repository mapping.
- `src/model-download-worker.py` — anonymous hidden download worker and parent-death monitoring.
- `src/desktop/model-download-manager.js` — metadata, byte polling, resume, cancellation, verification and publication.
- `src/desktop/main.js`, `src/desktop/ipc-contract.js`, `src/desktop/preload.cjs` — application lifecycle and validated IPC.
- `src/desktop/renderer/index.html`, `src/desktop/renderer/app.js`, `src/desktop/renderer/workspace.css` — popup markup, state integration and fixed layout.
- `src/desktop/renderer/model-cards.js`, `src/desktop/renderer/settings-popups.js` — shared cards and popup focus controller.
- `scripts/download-model.py` — reads the same repository mapping as the application.
- `tests/model-downloads.test.js`, `tests/model-download-worker.test.js`, `tests/settings-popups.test.js` — new lifecycle, worker and accessibility tests.
- `tests/ui-presentation.test.js`, `tests/desktop-shell.test.js` — updated UI/IPC coverage.
- `tests/ui-responsive-harness/main.cjs`, `tests/ui-responsive-harness/preload.cjs`, `tests/ui-responsive-harness/settings.cjs` — popup and equal-card geometry checks.
- `scripts/windows-launcher.cs`, `scripts/build-windows-launcher.ps1` - GUI executable launcher for the verified folder build, preserving the existing model/runtime/data root and Caps icon.
- `docs/model-downloads.md` — implementation notes and manual checklist.

Run `Caps.exe` from the project root so models, runtimes and settings continue to resolve beside the launcher. It is a 64-bit Windows GUI executable compiled with the existing Windows .NET Framework compiler, retains the original Caps icon, and starts its exact immutable runtime under `dist/app-<build-id>/` without a shell or batch file. Keep every file in that runtime together: `icudtl.dat`, `.pak` files, snapshots and DLLs are required Electron runtime files. Older builds that remain open in another process must be kept until that process closes.

## Sources and sizes

The single repository mapping is `src/model-repositories.json`. It matches `scripts/download-model.py` and the `_MODELS` mapping in the bundled faster-whisper runtime:

| Model | Repository |
| --- | --- |
| Large v3 Turbo | `mobiuslabsgmbh/faster-whisper-large-v3-turbo` |
| Small | `Systran/faster-whisper-small` |

The Turbo alias redirects to `dropbox-dash/faster-whisper-large-v3-turbo`. The installed Turbo README and its Hugging Face metadata identify the same model and commit `0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`.

For each repository Caps requests `https://huggingface.co/api/models/<repo>?blobs=true`. Required files, exact byte sizes, optional LFS SHA256 hashes and the pinned commit come from that response. Only runtime files plus README/license files are downloaded, so the displayed total is the sum of those selected files. There are no guessed production size constants. Offline metadata reads display “Size unavailable” unless verified metadata was retained from a previous attempt.

The repository file pages were verified on November 10, 2026. Live Hub API requests from the development execution environment failed DNS resolution; therefore real API manifests, transfer speeds and a complete live model download still need the manual network check below. Automated downloads use small fixture files, not approximate production metadata.

## Lifecycle and safety

`ModelDownloadManager` belongs to the Electron main process and survives Settings closing, screen changes and renderer reloads. One download is permitted at a time; other Install/Retry buttons are disabled.

Python starts through Node `spawn` with `windowsHide: true`, `shell: false` and `stdio: ['ignore', log.fd, log.fd]`. No shell, terminal, progress-bar parser or command text is exposed. `snapshot_download` runs anonymously with `token=False`, implicit tokens disabled, and no inherited token variables. Log streams redact credentials and signed URL queries.

Data is staged under `models/.downloads/<name>/`. The API manifest pins the revision for retries. Bytes are polled every 500 ms, including matching Hugging Face `.incomplete` files; metadata and duplicate completed/incomplete files are excluded. Exact sizes and required files are verified, with SHA256 verification for LFS files when supplied. Only then is the staged directory renamed to `models/<name>/` on the same volume. Detection never searches `.downloads`.

Cancel stops the worker and deletes that model's staging folder. A normal quit stops the worker but retains staging for resume. The worker also watches the main-process handle on Windows and exits if its parent is forcibly terminated. Restart presents an interrupted attempt as Retry, never Installed. Detailed logs are at `data/logs/model-download-<name>.log` beside Caps; diagnostics show a safe summary and offer Copy.

## Manual test checklist

Use a disposable Caps folder with its bundled `whisperx/` runtimes and fresh `data/`; preserve any existing working models.

- [ ] **Fresh install:** no model folders; both cards say Not installed and offer Install. Home says “Install a model in Settings to start”. The Generate button still follows the existing file-selection logic, including SRT conversion.
- [ ] **Live API and download:** install Small on a working internet connection. Confirm its API manifest lists positive sizes, then observe percent, transferred/total bytes, speed and remaining time. No terminal should flash. Other Install/Retry buttons remain disabled. Installed appears only after verification and final publication.
- [ ] **Cancel:** cancel partway through. Confirm the worker stops, `.downloads/small/` is removed, and existing models remain intact.
- [ ] **Offline and retry:** disconnect during a transfer and wait for its error. Error and Retry stay inside the card with unchanged dimensions. Reconnect and retry; verify cached bytes are reused and the revision remains pinned.
- [ ] **Close Settings:** close Settings or switch screens during a transfer. Reopening must show the same running download, and completion must refresh model detection.
- [ ] **Quit and restart:** quit normally mid-download; restart and Retry. Repeat with a forced main-process termination. The worker must stop, partial data must remain outside the final model folder, and restart must not say Installed.
- [ ] **Timing popup keyboard:** open its row with the keyboard; focus starts on Close. Tab/Shift+Tab wrap inside it. Change timing, close with Done/Escape/backdrop and reopen: the draft remains, but nothing is persisted before Save settings. Escape closes only the popup and returns focus to its row.
- [ ] **Diagnostics popup keyboard:** repeat focus and dismissal checks; use Refresh and Copy. Its long content scrolls only in its body.
- [ ] **Geometry:** at normal, maximized and minimum app size, compare idle, downloading, failed and installed cards. Both card heights, footer positions, column endings and divider height must remain equal. Settings must not scroll or resize when either popup opens.

`tests/ui-responsive-harness/settings.cjs` automates the geometry and popup checks with fixture data when Electron rendering is available. In the restricted execution environment Electron exits before rendering, so that visual check remains pending.
