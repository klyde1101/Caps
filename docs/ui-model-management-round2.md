# Caps UI and model management — Round 2

## Delivered behavior

| Item | Implementation |
| --- | --- |
| 0. Shared compatibility | `getModelStatus` in the model catalog is used by Settings and Generate availability. Settings checks its draft device/GPU selection; Home checks saved settings. CPU ignores VRAM. Automatic prefers a fitting CUDA runtime and falls back to CPU. Missing CPU runtime has an additional `runtime_unavailable` status. |
| 1. Model warnings | Installed, ready models show Installed without an amber warning. Actual problems include available/required VRAM or the unavailable device/runtime. Catalog metadata supplies descriptions, model sizes and requirements; installed directory measurements take priority for size. |
| 2. Delete/download | Quiet trash controls have accessible labels and destructive hover/focus styling. Confirmation includes model name and measured space freed. Deletion updates persisted selection immediately to another installed model or None. Active/admitting jobs block deletion. Existing download polling, progress, cancel and retry remain. |
| 3. Generate/footer | A single footer status follows media, installation, compatibility, then ready priority. Model problems include an Open model settings action. Generate is disabled when blocked. SRT-only conversion remains usable without a transcription model. Footer stays pinned while the central workflow can scroll in small windows. |
| 4. Settings | CPU hides GPU selection. Save is inactive when unchanged and active for draft changes. Starting a job now also updates the saved comparison baseline after persisting Home settings. |
| 5. Branding | Retained the SVG header logo and multi-size ICO, including 16/32/48/256 frames. Results retain the Settings button without the redundant device status. |
| 6. Results | Retained the compact file/path summary, copy action, caption/word counts, validation and timing. Open folder is primary; Process another is secondary. No generic boxed stat row. |
| 7. Player | Retained custom play/pause, five-second seeking, progress/hover time, volume/mute, speed and fullscreen controls. Shortcut guards protect editable fields and dialogs. |
| 8. Caption seeking | Both Start and End seek the video. Playback highlights its current row and follows within the caption pane, with a pause after manual scrolling and while editing. Long results can follow across pages when no search is active. |
| 9. Timestamp entry | Seconds, MM:SS, HH:MM:SS and millisecond timestamps are accepted. Enter seeks, Escape cancels, out-of-range times clamp, and invalid input reverts with feedback. |

## Verification

- Previous implementation suite: 93 targeted tests passed, covering compatibility, caption editing/save/reload, exports, model deletion/downloads, queue behavior and packaging.
- Retry: 17 focused model/status/renderer tests passed after the saved-settings baseline correction.
- Retry packaging/cleanup suite: 16 passed, one junction test skipped because the sandbox cannot create junctions. Added coverage for retaining all files of an in-use build and refusing cleanup if its lock inspection fails.
- Native linked-video check using Small with the saved CUDA setting completed: 23 captions, 69 aligned words, validation Passed; UI reported overall 1m 8s and selected-file 1m 5s. This is a smoke test, not a controlled performance benchmark.
- Native Start seek reached 00:00,231; End seek reached 00:01,012; typed 00:00:08,500 reached 8.5 seconds. Invalid input reverted with a validation message.
- Native caption correction saved to disk and survived Reload SRT. The temporary punctuation correction was reverted and saved again.
- Native custom Play advanced the video; the active caption highlighted and the caption pane followed playback.
- Native Settings on NVIDIA GeForce RTX 3050 with 8 GB VRAM showed both installed models without warnings. Pending CPU hid GPU selection and enabled Save. The pending CPU change was discarded when closing Settings.
- Browser fixtures verified low VRAM, missing CUDA, equality at the VRAM threshold, saved-versus-pending selection, download/delete updates and single footer status. The last-model browser dialog stalled; None persistence and request behavior were verified in local tests instead. No real installed models were deleted during QA.
- Footer viewport checks: 1000×700, 800×560 and 667×467 had one status line, no horizontal overflow and the button within the viewport. These are layout checks, not actual Windows display-scale changes.

## Model figures and limits

| Model | Installed bytes | Displayed size | CUDA VRAM budget |
| --- | ---: | ---: | ---: |
| Large v3 Turbo | 1,621,667,428 | 1.62 GB | 4 GB |
| Small | 486,214,774 | 0.49 GB | 2 GB |

Model sizes use decimal GB. VRAM comparisons use byte values derived from GiB budgets, displayed with the existing GB convention. CUDA loads FP16; CPU loads INT8. The 4/2 GB VRAM budgets are existing conservative Caps estimates including alignment, not measured minimum requirements, and are explicitly marked unverified in the catalog. CPU RAM recommendations are advisory. Automatic can remain ready with inadequate GPU memory when CPU fallback is available.

Actual Windows 100%/125%/150% scaling was not changed or fully verified. Keyboard variants, fullscreen and every media codec were not exhaustively exercised in the native smoke test; targeted player tests cover control logic.

## Build and cleanup

`Caps.exe` now launches `dist/app-e54dc5ae9ece3cb12de6167e`. `Caps-rollback.exe` targets `dist/app-c5bb46cde9948bfc2cf93294`. All 83 included application files and 14 required Electron runtime files matched source after publication. Native smoke testing used the preceding c5bb build; the final build additionally contains the saved-settings baseline correction and was source-verified.

The first retry cleanup attempted to remove an older open ac10 build and stopped on a locked DLL. Missing shared Electron files were restored without replacing its executable or application archive; all 14 required runtime hashes then matched the installed Electron distribution. Cleanup now checks exclusive file access before planning old-build removal and preserves in-use builds. It does not depend on process enumeration permissions. The older open ac10 build remains in addition to current and rollback; future cleanup can remove it after it is closed. Temporary package staging was removed.

The root EXE must be reopened to use the final build; an already-running window retains its loaded version.

## Files touched

Production source:

- `src/model-catalog.js`
- `src/desktop/main.js`
- `src/desktop/settings-store.js`
- `src/desktop/ipc-contract.js`
- `src/desktop/renderer/app.js`
- `src/desktop/renderer/index.html`
- `src/desktop/renderer/editor-controls.css`
- `src/desktop/renderer/generation-availability.js`
- `src/desktop/renderer/model-cards.js`
- `src/desktop/renderer/caption-editor.js`
- `src/desktop/renderer/settings-draft.js` (new)
- `src/desktop/renderer/playback-follow.js` (new)

Build support and tests:

- `scripts/clean-project.mjs`
- `tests/project-cleanup.test.js`
- `tests/model-status.test.js` (new)
- `tests/generation-availability.test.js`
- `tests/audit-fixes.test.js`
- `tests/ui-presentation.test.js`
- `tests/caption-editor-renderer.test.js`
- `tests/renderer-navigation.test.js`
- `tests/ui-responsive-harness/browser-preview.mjs`
- `docs/ui-model-management-round2.md` (new)

Generated outputs: root current/rollback EXEs, immutable build folder, cleanup report, QA SRT and native Settings screenshot under `data/ui-qa/round2-settings-native.png`.
