"""Validate codecs and migrate the bundled, trusted VAD checkpoint once at setup."""
import argparse
import os
from pathlib import Path
import shutil
import sys
import tempfile


def prepare(ffmpeg_directory):
    project_root = Path(__file__).resolve().parent.parent
    os.environ.setdefault('MPLCONFIGDIR', str(project_root / 'data' / 'matplotlib'))
    os.environ.setdefault('HF_HUB_OFFLINE', '1')
    os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
    handles = []
    if sys.platform == 'win32':
        handles.append(os.add_dll_directory(str(Path(ffmpeg_directory).resolve())))

    import torch
    import torchcodec
    import lightning.pytorch as pl
    from lightning.pytorch.utilities.migration import migrate_checkpoint, pl_legacy_patch

    checkpoint_path = Path(sys.executable).parent / 'Lib/site-packages/whisperx/assets/pytorch_model.bin'
    # This is the shipped WhisperX asset, never an uploaded media/checkpoint file.
    with pl_legacy_patch():
        checkpoint = torch.load(checkpoint_path, map_location='cpu', weights_only=False)
    old_version = checkpoint.get('pytorch-lightning_version')
    if old_version != pl.__version__:
        migrated, _ = migrate_checkpoint(checkpoint)
        backup = checkpoint_path.with_suffix('.bin.caps-backup')
        if not backup.exists():
            shutil.copy2(checkpoint_path, backup)
        descriptor, temporary = tempfile.mkstemp(dir=checkpoint_path.parent, suffix='.tmp')
        os.close(descriptor)
        try:
            torch.save(migrated, temporary)
            saved = torch.load(temporary, map_location='cpu', weights_only=False)
            original = torch.load(backup, map_location='cpu', weights_only=False)
            assert saved['state_dict'].keys() == original['state_dict'].keys()
            assert all(torch.equal(value, original['state_dict'][key]) for key, value in saved['state_dict'].items()), 'Migration must preserve every model weight'
            os.replace(temporary, checkpoint_path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        print(f'VAD checkpoint migrated {old_version} -> {pl.__version__}; all weights unchanged; backup: {backup}')
    else:
        print(f'VAD checkpoint already prepared for Lightning {pl.__version__}')
    print(f'Codec load verified: PyTorch {torch.__version__}, TorchCodec {torchcodec.__version__}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ffmpeg-directory', required=True)
    prepare(parser.parse_args().ffmpeg_directory)
