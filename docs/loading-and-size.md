# Loading and installed size

The Windows release uses a small `Caps.exe` launcher and a complete Electron
folder beside it. `npm run package:win` now selects this folder build so launching
does not require extracting a portable archive.

## Runtime size

Measured on November 11, 2026, using logical file sizes:

| Component | Before (MiB) | After (MiB) |
| --- | ---: | ---: |
| CPU runtime | 3967.1 | 1322.7 |
| CUDA runtime | 8036.0 | 5350.5 |
| Shared FFmpeg | 151.4 | 151.4 |
| Installed models and alignment data | 2384.9 | 2384.9 |

`scripts/trim-runtime-development.ps1 -Apply` removed 111 C++ linker library
files (5329.8 MiB). Without `-Apply`, the script only reports candidates. It
targets `.lib` files directly inside Python's `libs` and PyTorch's `torch/lib`;
DLLs, Python extensions, model weights and licenses are preserved. Both runtime
build workflows apply the same trimming. These runtimes support inference;
building custom C++ extensions requires restoring the development libraries.

## Loading behavior

- Main-window creation no longer awaits model-download state inspection.
  Download commands still wait for initialization, and catalog network requests
  begin after the main window is ready.
- A successful desktop queue can leave its Python process alive for 60 seconds.
  The next compatible queue reuses imported modules. Model weights, transcripts
  and temporary subtitle files are released between queues. Cancellation,
  processing failure, device changes and application exit dispose of the cached
  engine. This reduces repeated initialization, not the first model's disk read.
- PyTorch-only backend settings skip optional TensorFlow and Flax discovery.
- `[CapsTiming]` logs separate Python initialization, recognition-model loading
  and alignment-model loading. `startup.log` records main-entry-to-window timing.

## Validation and remaining limits

68 targeted tests passed, covering queue lifecycle, cancellation, reset routing,
downloads, trimming and packaging. The new folder build passed verification of
14 Electron runtime files and 77 current application files.

The native launch comparison still exits with `0x80000003` for both stock
Electron and packaged Caps before the application starts in this environment.
End-to-end startup and model-load speedups have not been measured. Older builds
remain available while launch verification is unresolved.
