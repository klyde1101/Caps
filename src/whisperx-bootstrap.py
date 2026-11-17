"""Configure the bundled Python process before WhisperX imports native codecs."""
import os
import runpy
import sys
import json
import re


def install_file_progress():
    """Observe CLI stages without reloading its shared ASR/alignment models."""
    import whisperx.transcribe as task

    output = sys.stdout
    state = {'index': -1, 'phase': None}
    paths = []

    def emit(percent, phase=None):
        if phase is not None:
            state['phase'] = phase
        output.write('[CapsProgress] ' + json.dumps({
            'fileIndex': state['index'], 'phase': state['phase'], 'percent': percent
        }) + '\n')
        output.flush()

    class ProgressOutput:
        pending = ''

        def write(self, text):
            result = output.write(text)
            self.pending += text
            while '\n' in self.pending:
                line, self.pending = self.pending.split('\n', 1)
                match = re.match(r'^Progress:\s*(\d+(?:\.\d+)?)%', line)
                if match and state['phase'] in ('transcribing', 'aligning'):
                    percent = min(100, max(0, float(match.group(1))))
                    emit(percent * .70 if state['phase'] == 'transcribing' else 70 + percent * .25)
            self.pending = self.pending[-4096:]
            return result

        def flush(self):
            output.flush()

        def __getattr__(self, name):
            return getattr(output, name)

    original_audio = task.load_audio
    original_model = task.load_model
    original_align = task.align
    original_writer = task.get_writer

    def load_audio(path, *args, **kwargs):
        paths.append(os.fspath(path))
        state['index'] = len(paths) - 1
        emit(0, 'transcribing')
        return original_audio(path, *args, **kwargs)

    def load_model(*args, **kwargs):
        model = original_model(*args, **kwargs)
        transcribe = model.transcribe

        def tracked(*args, **kwargs):
            result = transcribe(*args, **kwargs)
            emit(70, 'awaiting-alignment')
            return result

        model.transcribe = tracked
        return model

    def align(segments, model, metadata, audio, *args, **kwargs):
        state['index'] = paths.index(os.fspath(audio)) if isinstance(audio, (str, os.PathLike)) else 0
        emit(70, 'aligning')
        result = original_align(segments, model, metadata, audio, *args, **kwargs)
        emit(95, 'finishing')
        return result

    def get_writer(*args, **kwargs):
        writer = original_writer(*args, **kwargs)

        def tracked(result, path, *args, **kwargs):
            written = writer(result, path, *args, **kwargs)
            state['index'] = paths.index(os.fspath(path))
            emit(95, 'finishing')
            return written

        return tracked

    task.load_audio = load_audio
    task.load_model = load_model
    task.align = align
    task.get_writer = get_writer
    sys.stdout = ProgressOutput()


def cuda_batch_size(free_bytes):
    # Leave headroom for Large v3, VAD, the desktop and other GPU applications.
    # Larger batches can spill into shared memory on Windows and be much slower.
    free_gib = free_bytes / (1024 ** 3)
    return 4 if free_gib >= 14 else 2 if free_gib >= 10 else 1


def configure_batch_size(torch):
    if os.environ.get('CAPS_AUTO_BATCH_SIZE') != '1':
        return
    def option(name, default):
        return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

    device = option('--device', 'cuda' if torch.cuda.is_available() else 'cpu')
    if device != 'cuda' or not torch.cuda.is_available():
        return
    index = int(option('--device_index', '0'))
    # Keep alignment/VAD on the same selected GPU as CTranslate2.
    torch.cuda.set_device(index)
    free_bytes, _ = torch.cuda.mem_get_info(index)
    batch_size = cuda_batch_size(free_bytes)
    if '--batch_size' in sys.argv:
        sys.argv[sys.argv.index('--batch_size') + 1] = str(batch_size)
    else:
        sys.argv.extend(['--batch_size', str(batch_size)])
    print(f'[Caps] CUDA batch size: {batch_size} ({free_bytes / 1024**3:.1f} GiB free before loading models)', flush=True)


def main():
    # PATH finds ffmpeg.exe, but Python 3.8+ uses explicit DLL search directories.
    # Keep the handle alive for the whole transcription, including delayed loads.
    dll_handles = []
    if sys.platform == 'win32':
        dll_handles.append(os.add_dll_directory(os.environ['CAPS_FFMPEG_DIRECTORY']))

    import torch

    # Pyannote enforces this precision anyway. Set it before inference rather than
    # triggering its corrective warning; CTranslate2's FP16 ASR is unaffected.
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    configure_batch_size(torch)
    if os.environ.get('CAPS_FILE_PROGRESS') == '1':
        install_file_progress()

    sys.argv[0] = 'whisperx'
    runpy.run_module('whisperx', run_name='__main__')


if __name__ == '__main__':
    main()
