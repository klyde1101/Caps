"""Compare native word timestamps with forced alignment without changing Caps."""
import argparse
import gc
import json
import os
from pathlib import Path
import re
import sys
import time
from difflib import SequenceMatcher

p=argparse.ArgumentParser()
p.add_argument('audio',type=Path)
p.add_argument('--output',type=Path,required=True)
p.add_argument('--device',choices=['cuda','cpu'],default='cuda')
p.add_argument('--model',choices=['large-v3-turbo','small'],default='large-v3-turbo')
a=p.parse_args()
root=Path(__file__).resolve().parents[1]
a.output.mkdir(parents=True,exist_ok=True)
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',NLTK_DATA=str(root/'models/nltk'),MPLCONFIGDIR=str(root/'data/matplotlib'),TORCH_HOME=str(root/'models/torch'))
ff=root/'whisperx/ffmpeg'
torchlib=Path(sys.executable).parent/'Lib/site-packages/torch/lib'
os.environ['PATH']=os.pathsep.join([str(ff),str(torchlib),os.environ.get('PATH','')])
handles=[]
if os.name=='nt':
    for directory in [ff,torchlib]:
        if directory.exists(): handles.append(os.add_dll_directory(str(directory)))
started=time.perf_counter()
import torch
from faster_whisper import WhisperModel
import whisperx
from whisperx.audio import load_audio
imports=time.perf_counter()-started
if a.device=='cuda' and not torch.cuda.is_available(): raise RuntimeError('CUDA unavailable; rerun explicitly with --device cpu')
torch.backends.cuda.matmul.allow_tf32=False
torch.backends.cudnn.allow_tf32=False
if a.device=='cuda': torch.cuda.set_device(0)
compute='float16' if a.device=='cuda' else 'int8'
model_path=root/'models'/a.model
print('Loading audio and Turbo',flush=True)
audio=load_audio(str(a.audio))
times={'imports_seconds':imports}
t=time.perf_counter()
model=WhisperModel(str(model_path),device=a.device,device_index=0,compute_type=compute,local_files_only=True)
times['recognition_model_load_seconds']=time.perf_counter()-t
print('Native faster-whisper transcription',flush=True)
t=time.perf_counter()
segments,info=model.transcribe(audio,language='en',beam_size=5,word_timestamps=True,vad_filter=True,condition_on_previous_text=False)
segments=list(segments)
times['native_recognition_with_word_timestamps_seconds']=time.perf_counter()-t
native=[{'word':w.word.strip(),'start':w.start,'end':w.end,'probability':w.probability} for s in segments for w in (s.words or [])]
fixed=[{'start':s.start,'end':s.end,'text':s.text} for s in segments]
(a.output/'native-intermediate.json').write_text(json.dumps({'words':native,'segments':fixed,'timings':times},indent=2),encoding='utf-8')
del model
gc.collect()
if a.device=='cuda':torch.cuda.empty_cache()
print('Caps WhisperX recognition, batch 1 (separate load of the same checkpoint)',flush=True)
t=time.perf_counter()
pipeline=whisperx.load_model(str(model_path),a.device,device_index=0,compute_type=compute,language='en',local_files_only=True)
times['whisperx_vad_pipeline_load_seconds']=time.perf_counter()-t
t=time.perf_counter()
wx_raw=pipeline.transcribe(audio,batch_size=1)
times['caps_recognition_seconds']=time.perf_counter()-t
del pipeline,segments
gc.collect()
if a.device=='cuda':torch.cuda.empty_cache()
print('Loading English alignment model',flush=True)
t=time.perf_counter()
aligner,metadata=whisperx.load_align_model(language_code='en',device=a.device,model_dir=str(root/'models/alignment'),model_cache_only=True)
times['alignment_model_load_seconds']=time.perf_counter()-t
print('Aligning identical faster-whisper transcript',flush=True)
t=time.perf_counter()
controlled=whisperx.align(fixed,aligner,metadata,audio,a.device,interpolate_method='linear')
times['controlled_alignment_seconds']=time.perf_counter()-t
print('Aligning current Caps transcript',flush=True)
t=time.perf_counter()
current=whisperx.align(wx_raw['segments'],aligner,metadata,audio,a.device,interpolate_method='linear')
times['caps_alignment_seconds']=time.perf_counter()-t

from word_timing_metrics import compare

sources={'native':native,'controlled_alignment':controlled['word_segments'],'current_caps':current['word_segments']}
for name,words in sources.items():
    (a.output/(name+'.json')).write_text(json.dumps(words,indent=2),encoding='utf-8')
    def stamp(t):
        ms=max(0,round(t*1000));return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'
    rows=[]
    for w in words:
        if w.get('start') is not None and w.get('end') is not None and w['end']>w['start']:
            rows.append(f'{len(rows)+1}\n{stamp(w["start"])} --> {stamp(w["end"])}\n{w["word"].strip()}\n')
    (a.output/(name+'-words.srt')).write_text('\n'.join(rows),encoding='utf-8')
report={'audio_seconds':len(audio)/16000,'model':a.model,'device':a.device,'compute_type':compute,'native_batch':'standard sequential API','caps_batch':1,'hardware':torch.cuda.get_device_name(0) if a.device=='cuda' else 'CPU','timings':times,'controlled_same_transcript':compare(controlled['word_segments'],native),'end_to_end_current_caps':compare(current['word_segments'],native),'limitations':['WhisperX is a reference, not human-labeled ground truth.','One clip and one run; speed measurements are illustrative and caches/order can affect them.','VAD and decoding paths differ in the end-to-end comparison.','Controlled alignment reuses exactly the native transcript.']}
(a.output/'report.json').write_text(json.dumps(report,indent=2,default=lambda value:value.item()),encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k not in ['controlled_same_transcript','end_to_end_current_caps']},indent=2),flush=True)
print('REPORT_WRITTEN',flush=True)
