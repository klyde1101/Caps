# Windows x64 beta

Caps generates captions locally with WhisperX. The Windows installer includes the desktop application, Python runtimes for CPU and NVIDIA CUDA, and shared FFmpeg.

- **Download** — Download and run **Caps-1.0.0-beta.1-Setup-x64.exe**. This is the default Windows installation. No separate portable download is offered.
- **Install** — Setup downloads and verifies its runtime data automatically, installs for your Windows account, and adds Caps to the Start menu. No administrator access is needed. Allow at least 12 GB of free space, plus space for downloaded models.
- **Progress** — Setup matches the Caps interface and shows animated download progress, transferred data, speed, remaining time, verification, and extraction progress. Downloads can be cancelled and retried.
- **Uninstall** — Windows Settings > Apps > Caps > Uninstall opens a matching graphical uninstaller, with progress and retryable errors. Close Caps first. Settings, downloaded models, and personal files are kept. App-only updates record their installed files for later removal. Existing installations need the new Setup once to replace the older PowerShell uninstaller.
- **First use** — Open Settings, choose Small or Large v3 Turbo, and click Download. The first download also fetches the shared English alignment, voice detection and tokenizer resources. After it completes, generation works offline. The Speech-Resources ZIP is an app-managed release asset.

Keep the dist and whisperx folders beside Caps.exe in the installation directory. Caption exports are saved beside the source media.

**Other release files are managed by Setup or Caps.** The numbered Runtime ZIP files contain installer support data for CPU and CUDA, not additional downloads you need to select. The Speech-Resources ZIP contains word-timing alignment, voice detection, and English tokenizer data; Caps fetches it automatically on the first model download. Do not delete hosted support files while published installers reference them. For an offline installation, place all Runtime ZIP parts provided for the current build beside Setup before running it; a first model download still needs internet access. The number of parts can change when the bundle size changes.

Created by **[klyde1101](https://github.com/klyde1101)**. SHA256SUMS.txt contains checksums for all release files. This beta is unsigned: Windows will still show “Unknown publisher” until a trusted code-signing certificate is obtained.
