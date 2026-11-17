"""Build the optional shared model pack and its integrity manifest."""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
paths = [root / "models/alignment/wav2vec2_fairseq_base_ls960_asr_ls960.pth"]
paths.extend(sorted((root / "models/nltk/tokenizers/punkt_tab/english").glob("*")))
for device in ("cpu", "cuda"):
    packages = root / "whisperx" / device / "python/Lib/site-packages"
    paths.extend([packages / "whisperx/assets/pytorch_model.bin",
                  packages / "faster_whisper/assets/silero_vad_v6.onnx"])

release = root / "dist/release"
release.mkdir(parents=True, exist_ok=True)
version = json.loads((root / "package.json").read_text())["version"]
asset = "Caps-" + version + "-Speech-Resources.zip"
manifest = {"url": f"https://github.com/klyde1101/Caps/releases/download/v{version}/{asset}", "files": {}}
with zipfile.ZipFile(release / asset, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
    for path in paths:
        name = path.relative_to(root).as_posix()
        with path.open("rb") as stream:
            manifest["files"][name] = hashlib.file_digest(stream, "sha256").hexdigest()
        archive.write(path, name)
(root / "src/speech-resources.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
