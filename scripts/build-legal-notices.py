"""Collect shipped dependency notices without relicensing third-party software."""
from email.parser import Parser
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def build_notices():
    blocks = ['Third-party notices\n\nCaps original code uses the MIT License. Dependencies and model weights retain their own licenses.\n'
        'This file collects notices found in the installed build runtimes; it is not a legal-compliance certification.\n'
        'Electron and Chromium notices are also distributed beside the versioned runtime executable.\n'
        'Python package notices remain in each runtime under Lib/site-packages/*.dist-info.\n'
        'Model-weight licenses and sources: https://huggingface.co/Systran/faster-whisper-small and '
        'https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo.\n'
        'Before redistributing, review each component license, including any source-code, attribution and NVIDIA redistribution obligations.\n'
        'Some FFmpeg builds use GPL or nonfree codecs; the actual build configuration below governs the shipped binary, not Caps MIT.']
    paths = [ROOT / 'node_modules/electron/dist/LICENSE', ROOT / 'src/assets/material-symbols/LICENSE', ROOT / 'build/github-mark-LICENSE.txt']
    for device in ('cpu', 'cuda'):
        base = ROOT / f'whisperx/{device}/python'
        paths.extend(sorted(base.glob('LICENSE*')))
        for info in sorted((base / 'Lib/site-packages').glob('*.dist-info')):
            metadata = info / 'METADATA'
            if metadata.exists():
                record = Parser().parsestr(metadata.read_text(encoding='utf-8', errors='replace'), headersonly=True)
                blocks.append(f"{device.upper()} dependency: {record.get('Name')} {record.get('Version')}\n"
                    f"Declared license: {record.get('License-Expression') or record.get('License') or 'See bundled package notices'}\n"
                    f"Source/homepage: {record.get('Home-page') or record.get('Project-URL') or 'See package METADATA'}")
            paths.extend(sorted(p for p in info.rglob('*') if p.is_file() and
                ('license' in p.name.lower() or 'notice' in p.name.lower() or 'copying' in p.name.lower())))
    for path in paths:
        if path.is_file():
            blocks.append(f"Bundled notice: {path.relative_to(ROOT).as_posix()}\n\n" + path.read_text(encoding='utf-8', errors='replace'))
    ffmpeg = ROOT / 'whisperx/ffmpeg/ffmpeg.exe'
    if ffmpeg.exists():
        result = subprocess.run([str(ffmpeg), '-L'], capture_output=True, text=True, errors='replace', check=True)
        blocks.append('Bundled FFmpeg license and configuration\n\n' + result.stdout + result.stderr)
    target = ROOT / 'src/legal/third-party-notices.txt'
    target.write_text('\n\n'.join(blocks) + '\n', encoding='utf-8')
    print(f'Collected {len(blocks)} notices and dependency records.')


if __name__ == '__main__':
    build_notices()
