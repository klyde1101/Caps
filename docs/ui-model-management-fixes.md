# UI and model management changes

## Implementation

1. The header uses a resolution-independent SVG based on the existing Caps mark.
   The green-dot device label is removed; Settings remains. The existing window
   image is 1024 pixels, and the Windows ICO contains 16, 24, 32, 48, 64, 128 and
   256 pixel frames. These existing native icon assets are preserved.
2. Generate uses one availability policy for file selection, model installation,
   hardware/runtime compatibility, active jobs and deletion state. A visible,
   live inline reason explains disabled states. Download events override stale
   diagnostics, so deletion cannot leave Generate enabled.
3. Model cards display a descriptor and `Model Size: # GB | Requires: # GB VRAM`.
   Warnings appear for known missing/incompatible models. Tooltips are removed.
   Delete goes through the trusted preload/IPC boundary, asks for confirmation
   using Electron's native dialog, checks job admission and active jobs, validates
   supported model IDs and rejects linked model folders/files. Application exit
   waits for an accepted deletion to finish. A compatible installed model is
   selected and persisted when possible; otherwise the deleted selection remains
   visibly unavailable until the user chooses or installs a model.
4. Results use a compact file header, copyable path, inline result facts and
   processing times. Open folder is the main result action; Process another is
   secondary. Queue-wide caption/word/validation totals and both queue and selected
   file timings are preserved. Editing actions remain in the editor panel.
5. Custom controls provide play/pause, five-second seeking, a seek bar with hover
   time, volume/mute, playback speed and fullscreen. Controls disable when media
   is absent or cannot load. Shortcuts respect editable fields, dialogs and normal
   button activation. Arrow keys work on focused player buttons as well.
6. Both Start and End are seek buttons. Binary-search caption lookup updates the
   overlay and current-row highlight without rewriting caption timing.
7. Current time is editable. Seconds, MM:SS, HH:MM:SS and millisecond timestamps
   are accepted; valid times clamp to duration. Invalid input reverts with a
   temporary error outline and accessible feedback. Escape cancels the edit.

## Assumptions

- SRT-only conversion remains available without a transcription model, preserving
  existing behavior. Mixed/media queues require the selected model.
- Compatibility uses the existing Small/Turbo admission budgets. Automatic mode
  remains healthy when CPU fallback can run the model.
- Sizes use measured installation/catalog bytes when known. Offline estimates
  are marked with `~` (0.49 GB Small, 1.62 GB Turbo). VRAM values remain the
  existing GPU estimates; CPU eligibility uses the RAM/runtime checks.
- Start/End seeking and typed player times change playback position, not SRT
  timestamp values. Save corrections and Reload SRT keep their existing behavior.

## Validation and outstanding work

76 targeted tests passed, including real temporary SRT writes and locking,
CPU fallback, download resume/cancel, deletion fixture isolation and selected-model
fallback, keyboard focus protection, timestamp parsing/clamping, playback-control
logic and caption seek/edit/save behavior. JavaScript syntax checks passed.

An isolated browser fixture rendered the new result layout using synthetic data.
Its initial WAV media did not load. An MP4 fixture was then prepared, but automatic
approval review blocked continuation of the preview because it detected Visual
Studio telemetry to an untrusted endpoint, potentially disclosing project or
environment metadata. The preview was not restarted through another route.
Real video playback, fullscreen and Windows scaling at 100%, 125%, and 150%
therefore still require live verification. Installed user models were not deleted
to test this feature; deletion tests used disposable fixture directories.

On November 12, 2026, following the user's explicit approval of the reported
telemetry risk, the standard folder build completed and published the updated
`C:\xampp\htdocs\caps\Caps.exe`. Package verification matched 81 application files
and 14 Electron runtime files. The launcher now references
`dist/app-ac10d45a32d34e78a740c5e0`; `Caps-rollback.exe` references the previous
`dist/app-982153dae24867dc0c0f27c2` build. Automatic cleanup completed and removed
another 0.31 GiB of obsolete build files. Both installed transcription models,
CPU/CUDA runtimes and saved settings were verified present afterward.

The rebuilt EXE was opened through Windows, and its native Caps window was
observed loading the new packaged renderer. The Home screen showed the SVG logo,
Settings button, no device-status label, and a disabled Generate button with
the visible reason `Choose a source file`. Full live playback/fullscreen and
100%/125%/150% Windows scaling checks remain outstanding.

## Files touched

- `C:\xampp\htdocs\caps\src\assets\caps-logo.svg`
- `C:\xampp\htdocs\caps\src\desktop\main.js`
- `C:\xampp\htdocs\caps\src\desktop\ipc-contract.js`
- `C:\xampp\htdocs\caps\src\desktop\preload.cjs`
- `C:\xampp\htdocs\caps\src\desktop\model-download-manager.js`
- `C:\xampp\htdocs\caps\src\desktop\renderer\app.js`
- `C:\xampp\htdocs\caps\src\desktop\renderer\index.html`
- `C:\xampp\htdocs\caps\src\desktop\renderer\model-cards.js`
- `C:\xampp\htdocs\caps\src\desktop\renderer\caption-editor.js`
- `C:\xampp\htdocs\caps\src\desktop\renderer\generation-availability.js`
- `C:\xampp\htdocs\caps\src\desktop\renderer\player-controls.js`
- `C:\xampp\htdocs\caps\src\desktop\renderer\editor-controls.css`
- `C:\xampp\htdocs\caps\tests\caption-editor-renderer.test.js`
- `C:\xampp\htdocs\caps\tests\desktop-shell.test.js`
- `C:\xampp\htdocs\caps\tests\ui-presentation.test.js`
- `C:\xampp\htdocs\caps\tests\generation-availability.test.js`
- `C:\xampp\htdocs\caps\tests\model-deletion.test.js`
- `C:\xampp\htdocs\caps\tests\player-controls.test.js`
- `C:\xampp\htdocs\caps\tests\ui-responsive-harness\browser-preview.mjs`
- `C:\xampp\htdocs\caps\docs\ui-model-management-fixes.md`

Generated local fixture: `C:\xampp\htdocs\caps\data\ui-qa\player.mp4` (synthetic,
approximately 17 KB; excluded from Git). Existing user media is not used by this
fixture. Browser QA is served on loopback only and uses in-memory model/SRT APIs.
