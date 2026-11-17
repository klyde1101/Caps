"""Install a supported transcription model beside Caps for offline transcription."""
import argparse
import json
from pathlib import Path

REPOSITORIES = json.loads((Path(__file__).resolve().parent.parent / 'src' / 'model-repositories.json').read_text(encoding='utf-8'))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('model', choices=REPOSITORIES)
    parser.add_argument('--models-dir', type=Path, default=Path(__file__).resolve().parent.parent / 'models')
    args = parser.parse_args()
    from huggingface_hub import snapshot_download

    destination = args.models_dir.resolve() / args.model
    patterns = ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.json',
                'vocabulary.txt', 'preprocessor_config.json', 'README.md', 'LICENSE*']
    snapshot_download(
        repo_id=REPOSITORIES[args.model]['repoId'],
        local_dir=str(destination),
        allow_patterns=patterns,
    )
    required = ['config.json', 'model.bin', 'tokenizer.json']
    missing = [name for name in required if not (destination / name).is_file()]
    if not any((destination / name).is_file() for name in ('vocabulary.json', 'vocabulary.txt')):
        missing.append('vocabulary.json or vocabulary.txt')
    if missing:
        raise RuntimeError('Incomplete model: ' + ', '.join(missing))
    print(f'Installed {args.model}: {destination}')


if __name__ == '__main__':
    main()
