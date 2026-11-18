"""Importable entry point shared with the hyphenated command-line verifier."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('caps_release_verifier', Path(__file__).with_name('verify-release.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
write_provenance = module.write_provenance
