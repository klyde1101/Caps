"""One queue worker: recognize every input, release ASR, then align with WhisperX."""
import argparse
import gc
import json
import os
import re
from pathlib import Path
import sys
import time


def reply(command, **values):
    print('[CapsResult] ' + json.dumps({'commandId': command['commandId'], **values}), flush=True)


def progress(index, phase, percent):
    print('[CapsProgress] ' + json.dumps({'fileIndex': index, 'phase': phase, 'percent': percent}), flush=True)


def write_words(result, destination):
    def stamp(seconds):
        millis = max(0, round(seconds * 1000))
        hours, millis = divmod(millis, 3600000)
        minutes, millis = divmod(millis, 60000)
        seconds, millis = divmod(millis, 1000)
        return f'{hours:02}:{minutes:02}:{seconds:02},{millis:03}'
    rows = []
    words = result.get('word_segments', [])
    if not words:
        raise RuntimeError('WhisperX did not detect speech to caption.')
    for word in words:
        text = word.get('word', '').strip()
        if not text:
            continue
        if word.get('start') is None or word.get('end') is None or word['end'] <= word['start']:
            raise RuntimeError(f'Could not align the word {text!r}. Correct the transcript or try another WhisperX model.')
        rows.append(f'{len(rows)+1}\n{stamp(word["start"])} --> {stamp(word["end"])}\n{text}\n')
    destination.write_text('\n'.join(rows), encoding='utf-8')


class QueueWorker:
    def __init__(self, args):
        import torch
        self.torch = torch
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False
        self.args = args
        if args.device == 'cpu' and getattr(args, 'cpu_threads', 0):
            torch.set_num_threads(args.cpu_threads)
            torch.set_num_interop_threads(1)
            if os.name == 'nt':
                import ctypes
                ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)

        self.handles = []
        if os.name == 'nt':
            self.handles.append(os.add_dll_directory(os.environ['CAPS_FFMPEG_DIRECTORY']))
        self.cuda = args.device != 'cpu' and torch.cuda.is_available()
        if args.device == 'cuda' and not self.cuda:
            raise RuntimeError('CUDA_UNAVAILABLE: PyTorch cannot use CUDA.')
        if self.cuda:
            if args.device_index >= torch.cuda.device_count():
                raise RuntimeError('CUDA_UNAVAILABLE: The selected GPU does not exist.')
            torch.cuda.set_device(args.device_index)
        self.device = f'cuda:{args.device_index}' if self.cuda else 'cpu'
        self.model = self.selection = None
        self.transcripts = []


    def release(self):
        self.model = self.selection = None
        gc.collect()
        if self.cuda:
            self.torch.cuda.empty_cache()

    def load(self, selection):
        if self.selection == selection:
            return
        self.release()
        started = time.perf_counter()
        import whisperx
        self.model = whisperx.load_model(selection, 'cuda' if self.cuda else 'cpu',
            device_index=self.args.device_index, language='en', compute_type=(
                'float16' if self.cuda else 'int8') if self.args.compute_type == 'default' else self.args.compute_type,
            local_files_only=True)
        self.selection = selection
        print('[CapsTiming] ' + json.dumps({'stage': 'recognition-model-load',
            'seconds': time.perf_counter() - started, 'device': self.device}), flush=True)

    def reset(self, command):
        self.release()
        self.transcripts.clear()
        for subtitle in Path(self.args.output_dir).glob('*.srt'):
            subtitle.unlink()
        reply(command)

    def transcribe(self, command):
        from whisperx.audio import load_audio
        started = time.perf_counter()
        try:
            self.load(command['model'])
        except RuntimeError as error:
            if not (self.cuda and self.args.device == 'auto' and re.search(
                r'CUDA_UNAVAILABLE|not compiled with cuda|cuda (?:is|was) not available|no cuda|no nvidia driver|cuda driver version|(?:cudnn|cublas).*(?:not found|could not|cannot)', str(error), re.I)):
                raise
            self.release()
            self.cuda, self.device = False, 'cpu'
            print('[Caps] CUDA initialization failed; retrying recognition on CPU.', flush=True)
            self.load(command['model'])
        index = command['fileIndex']
        emit = progress
        emit(index, 'transcribing', 0)
        audio = load_audio(command['path'])
        # Keep memory budgets predictable across both supported models.
        result = self.model.transcribe(audio, batch_size=1,
            progress_callback=lambda fraction: emit(index, 'transcribing', fraction * .7))
        segments = result['segments']
        self.transcripts.append({**command, 'segments': segments})
        emit(index, 'awaiting-alignment', 70)
        reply(command)

    def align(self, command):
        # No recognition model remains resident when the alignment model loads.
        self.release()
        import whisperx
        from whisperx.audio import load_audio
        emit = progress
        aligned = []
        if self.transcripts:
            started = time.perf_counter()
            model, metadata = whisperx.load_align_model(language_code='en', device=self.device,
                model_dir=self.args.alignment_dir, model_cache_only=True)
            print('[CapsTiming] ' + json.dumps({'stage': 'alignment-model-load',
                'seconds': time.perf_counter() - started, 'device': self.device}), flush=True)
            for item in self.transcripts:
                started = time.perf_counter()
                index = item['fileIndex']
                emit(index, 'aligning', 70)
                result = whisperx.align(item['segments'], model, metadata, load_audio(item['path']), self.device,
                    interpolate_method='linear', progress_callback=lambda fraction, index=index: emit(index, 'aligning', 70 + .25 * fraction))
                # The stable file index prevents collisions between identical input stems.
                destination = Path(self.args.output_dir) / f'{index}.srt'
                write_words(result, destination)
                aligned.append({'fileIndex': index, 'srt': destination.read_text(encoding='utf-8'), **({'seconds': time.perf_counter() - started} if command.get('metrics') else {})})
                emit(index, 'finishing', 95)
            del model
        reply(command, aligned=aligned)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--alignment_dir', required=True)
    parser.add_argument('--output_dir', required=True)
    parser.add_argument('--device', choices=['cpu', 'cuda', 'auto'], default='auto')
    parser.add_argument('--device_index', type=int, default=0)
    parser.add_argument('--compute_type', default='default')
    parser.add_argument('--cpu_threads', type=int, default=0)
    started = time.perf_counter()
    worker = QueueWorker(parser.parse_args())
    print('[CapsTiming] ' + json.dumps({'stage': 'python-runtime-init',
        'seconds': time.perf_counter() - started, 'device': getattr(worker, 'device', 'unknown')}), file=sys.stderr, flush=True)
    try:
        # Node writes UTF-8; Windows text stdin may default to a legacy code page.
        for line in sys.stdin.buffer:
            command = json.loads(line.decode('utf-8'))
            if command['action'] == 'transcribe':
                worker.transcribe(command)
            elif command['action'] == 'align':
                worker.align(command)
            elif command['action'] == 'release':
                worker.release()
                reply(command)
            elif command['action'] == 'reset':
                worker.reset(command)
            elif command['action'] == 'close':
                break
            else:
                raise ValueError('Unknown queue command')
    finally:
        worker.release()


if __name__ == '__main__':
    main()
