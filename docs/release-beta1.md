# Windows x64 beta

Caps generates captions locally with WhisperX. Both distributions include the Python runtimes for CPU and NVIDIA CUDA, shared FFmpeg, and the desktop application.

- **Installer** — Download and run the Setup EXE. It downloads the runtime package, or uses all three numbered portable ZIP parts when they are beside the installer. It installs for your Windows account and adds Caps to the Start menu. No administrator access is needed.
- **Portable** — Download all three numbered Portable ZIP parts into one folder. Open the .001 file with 7-Zip and extract it into a writable folder, then open Caps.exe. These parts form one portable version; all three are required.
- **First use** — Open Settings, choose Small or Large v3 Turbo, and click Download. The first download also fetches the shared English alignment, voice detection and tokenizer resources. After it completes, generation works offline. The Speech-Resources ZIP is an app-managed release asset.

Keep the extracted dist and whisperx folders beside Caps.exe. Caption exports are saved beside the source media.

The runtime package is approximately 4 GB because it includes both CPU and CUDA support. Allow at least 12 GB of free space during setup, plus space for downloaded models. SHA256SUMS.txt contains checksums for all release downloads. This is an unsigned beta build.
