# Caps 1.0.0-beta.1 for Windows x64

**[Download Caps-1.0.0-beta.1-Setup-x64.exe](https://github.com/klyde1101/Caps/releases/download/v1.0.0-beta.1/Caps-1.0.0-beta.1-Setup-x64.exe)**

This first beta is ready for target-user testing. Pre-testing fixes and size cleanup remain part of v1.0.0-beta.1.

## Install

Download and run **Caps-1.0.0-beta.1-Setup-x64.exe**. Fresh installs default to `C:\Program Files\Caps`. Choose Browse to select a different parent folder. Windows may ask permission to create the default folder. Setup installs for your Windows account and verifies the support files as it downloads them. Allow at least 12 GB of free space, plus space for speech models downloaded on first use. Both CPU and CUDA speech processing are included.

If you already installed beta.1, run this refreshed Setup again. Automatic updates select newer versions and do not replace an installation with the same version number.

## Changes

- Fixed the installation path display and GitHub button hover area. Model downloads now start alongside shared speech resources and report partial file progress.
- Reduced the runtime package by omitting upstream test suites.

- Removed unused compiler files and duplicate FFmpeg executables, reducing the installed speech runtime by about 242 MiB and its download by about 88 MiB. CPU and CUDA transcription were checked after cleanup.
- Added app updates under Settings > Updates. Updates install after Caps closes normally; turning automatic updates off cancels downloads and queued installation. Manual checks remain available.
- Improved update recovery, repeated-helper handling, single-instance behavior and closing during caption jobs while preserving unsaved-edit prompts.
- Added a graphical uninstaller under Windows Settings > Apps. Close Caps before uninstalling. Settings, downloaded models and personal files are preserved.
- Added offline policies, the MIT license and dependency notices under Settings > Legal, plus a GitHub link in the app header.
- Improved Setup cancellation and reinstall file tracking.

## Download details

Setup normally handles support downloads. For an offline installation, place the two content-addressed Support-Runtime parts listed in **SHA256SUMS.txt**, the Speech-Resources ZIP and Setup together. Keep both numbered parts intact. Models still download separately on first use.

This release contains one current build. Download the current Setup above; older copies of Setup reference superseded support files and should be replaced. SHA256SUMS.txt covers the current public downloads. The build verification record is kept internally.

This beta is unsigned, so Windows may show an Unknown Publisher warning. Private privacy requests: klyde.penus1101@gmail.com.
