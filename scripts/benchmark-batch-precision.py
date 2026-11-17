"""Real-media CUDA precision/batch sweep; leaves Caps settings untouched."""
import argparse
import ctypes
from ctypes import Structure,c_uint,c_void_p,c_ulonglong,POINTER,byref
from dataclasses import asdict
import gc
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import random
import re
import statistics
import sys
import threading
import time

p=argparse.ArgumentParser()
p.add_argument('audio',type=Path)
p.add_argument('--output',type=Path,required=True)
p.add_argument('--model',default='large-v3-turbo',choices=['large-v3-turbo','small'])
p.add_argument('--repeats',type=int,default=5)
p.add_argument('--batches',type=int,nargs='+',default=[1,2,4,8,16])
a=p.parse_args()
root=Path(__file__).resolve().parents[1]
a.output.mkdir(parents=True,exist_ok=True)
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',NLTK_DATA=str(root/'models/nltk'),MPLCONFIGDIR=str(root/'data/matplotlib'),TORCH_HOME=str(root/'models/torch'))
ff=root/'whisperx/ffmpeg'
torchlib=Path(sys.executable).parent/'Lib/site-packages/torch/lib'
os.environ['PATH']=os.pathsep.join([str(ff),str(torchlib),os.environ.get('PATH','')])
handles=[os.add_dll_directory(str(d)) for d in [ff,torchlib] if os.name=='nt' and d.exists()]
# This benchmark never needs network access or an external compiler.
os.environ.update(PYANNOTE_METRICS_ENABLED='0', OTEL_SDK_DISABLED='true', OTEL_TRACES_EXPORTER='none', OTEL_METRICS_EXPORTER='none', DO_NOT_TRACK='1')
network_attempts=[]
def offline_audit(event, args):
    if event in {'socket.connect','socket.getaddrinfo','socket.sendto','socket.sendmsg'}:
        network_attempts.append(event)
        raise RuntimeError('Network access is disabled for this local benchmark: '+event)
    if event == 'subprocess.Popen':
        command=str(args[1]).lower().strip()
        head=re.match(r'^(?:"([^"]+)"|(\S+))',command)
        cmd_path=str(args[0]).lower() if args[0] else (head.group(1) or head.group(2) if head else '')
        executable=Path(cmd_path).name.lower()
        if any(scheme in command for scheme in ['http://','https://','tcp://','udp://']):raise RuntimeError('Remote process input is disabled')
        os_version_query=executable=='cmd.exe' and command in {cmd_path+' /c "ver"','"'+cmd_path+'" /c "ver"',cmd_path+' /c ver','"'+cmd_path+'" /c ver'}
        if executable not in {'ffmpeg','ffmpeg.exe','nvidia-smi','nvidia-smi.exe'} and not os_version_query:
            raise RuntimeError('External process is disabled for this benchmark: '+executable)
sys.addaudithook(offline_audit)
import torch
import whisperx
import ctranslate2
from whisperx.audio import load_audio
from word_timing_metrics import compare,normalize
assert torch.cuda.is_available(),'CUDA is required for this test'
torch.cuda.set_device(0)
torch.backends.cuda.matmul.allow_tf32=False
torch.backends.cudnn.allow_tf32=False
supported=ctranslate2.get_supported_compute_types('cuda',0)
assert {'float16','int8_float16'} <= supported, supported

class Memory(Structure):_fields_=[('total',c_ulonglong),('free',c_ulonglong),('used',c_ulonglong)]
nv=ctypes.WinDLL('nvml.dll')
nv.nvmlDeviceGetHandleByIndex_v2.argtypes=[c_uint,POINTER(c_void_p)]
nv.nvmlDeviceGetMemoryInfo.argtypes=[c_void_p,POINTER(Memory)]
assert nv.nvmlInit_v2()==0
handle=c_void_p();assert nv.nvmlDeviceGetHandleByIndex_v2(0,byref(handle))==0

def memory():
    info=Memory();assert nv.nvmlDeviceGetMemoryInfo(handle,byref(info))==0
    return info.used/1024**2,info.free/1024**2

class Sample:
    def __enter__(self):
        self.before,self.free_before=memory()
        self.peak=self.before
        self.free_min=self.free_before
        self.stop=threading.Event()
        def loop():
            while not self.stop.wait(.02):
                used,free=memory();self.peak=max(self.peak,used);self.free_min=min(self.free_min,free)
        self.thread=threading.Thread(target=loop,daemon=True);self.thread.start()
        return self
    def __exit__(self,*args):
        used,free=memory();self.peak=max(self.peak,used);self.free_min=min(self.free_min,free)
        self.stop.set();self.thread.join()
    def values(self):return {'gpu_wide_before_mib':round(self.before,1),'gpu_wide_peak_mib':round(self.peak,1),'gpu_free_min_mib':round(self.free_min,1),'increment_from_loaded_baseline_mib':round(self.peak-self.before,1)}

report={'model':a.model,'audio_file':a.audio.name,'audio_sha256':hashlib.sha256(a.audio.read_bytes()).hexdigest(),'gpu':torch.cuda.get_device_name(0),'total_vram_mib':torch.cuda.get_device_properties(0).total_memory/1024**2,'repeats':a.repeats,'requested_batches':a.batches,'versions':{n:importlib.metadata.version(n) for n in ['torch','whisperx','faster-whisper','ctranslate2']},'loads':{},'warmups':{},'runs':[],'limitations':['One input video; available VAD chunks limit effective batch size.','GPU-wide NVML memory includes other applications; sampled every 20 ms.','Alignment is measured separately after ASR unload, matching Caps memory sequencing.','Initializations are measured once per precision, not true cold disk-cache benchmarks.','Token differences and timing agreement against FP16 batch 1 are not human-verified accuracy.']}
def save():
    (a.output/'report.partial.json').write_text(json.dumps(report,indent=2,default=lambda x:x.item()),encoding='utf-8')

audio=load_audio(str(a.audio))
report['audio_seconds']=len(audio)/16000
report['telemetry_policy']={'pyannote_metrics':False,'opentelemetry_sdk':False,'python_outbound_network':'denied','external_processes':'ffmpeg, nvidia-smi, and exact Windows ver query only'}
reference=None
for precision in ['float16','int8_float16']:
    print('LOAD',precision,flush=True)
    gc.collect();torch.cuda.empty_cache()
    t=time.perf_counter()
    with Sample() as sample:
        pipe=whisperx.load_model(str(root/'models'/a.model),'cuda',device_index=0,compute_type=precision,language='en',local_files_only=True)
        torch.cuda.synchronize()
    report['loads'][precision]={'seconds':time.perf_counter()-t,'actual_compute_type':getattr(pipe.model.model,'compute_type',None),**sample.values()}
    report['decoding']={'beam_size':pipe.options.beam_size,'chunk_seconds':30,'vad':'pyannote','language':'en'}
    print('WARMUP',precision,flush=True)
    t=time.perf_counter();warm=pipe.transcribe(audio,batch_size=1);torch.cuda.synchronize()
    report['warmups'][precision]={'seconds':time.perf_counter()-t,'vad_chunks':len(warm['segments'])}
    save()
    pending=[]
    for repeat in range(a.repeats):
        order=list(a.batches);random.Random(1111+repeat).shuffle(order)
        for batch in order:
            row={'precision':precision,'batch':batch,'repeat':repeat+1}
            try:
                torch.cuda.synchronize();t=time.perf_counter()
                with Sample() as sample:
                    result=pipe.transcribe(audio,batch_size=batch)
                    torch.cuda.synchronize()
                row.update(asr_seconds=time.perf_counter()-t,vad_chunks=len(result['segments']),effective_batch_upper_bound=min(batch,len(result['segments'])),**sample.values())
                row['transcript']=' '.join(s['text'].strip() for s in result['segments'])
                row['transcript_sha256']=hashlib.sha256(row['transcript'].encode()).hexdigest()
                row['segments']=result['segments']
                pending.append(row)
                print('ASR',precision,'batch',batch,'repeat',repeat+1,'seconds',round(row['asr_seconds'],3),'chunks',row['vad_chunks'],'peak MiB',sample.values()['gpu_wide_peak_mib'],flush=True)
            except Exception as e:
                row['error']=str(e)
                print('ERROR',precision,batch,str(e),flush=True)
                torch.cuda.empty_cache()
            report['runs'].append(row);save()
    del pipe,warm
    gc.collect();torch.cuda.empty_cache()
    print('ALIGN LOAD',precision,flush=True)
    t=time.perf_counter()
    with Sample() as sample:
        aligner,metadata=whisperx.load_align_model(language_code='en',device='cuda:0',model_dir=str(root/'models/alignment'),model_cache_only=True)
        torch.cuda.synchronize()
    report['loads'][precision]['alignment_seconds']=time.perf_counter()-t
    report['loads'][precision]['alignment_memory']=sample.values()
    # Warm only the separate alignment stage, outside measured repeats.
    if pending:whisperx.align(pending[0]['segments'],aligner,metadata,audio,'cuda:0',interpolate_method='linear')
    for row in pending:
        try:
            torch.cuda.synchronize();t=time.perf_counter()
            with Sample() as sample:
                aligned=whisperx.align(row['segments'],aligner,metadata,audio,'cuda:0',interpolate_method='linear')
                torch.cuda.synchronize()
            row['alignment_seconds']=time.perf_counter()-t
            row['alignment_memory']=sample.values()
            row['processing_seconds']=row['asr_seconds']+row['alignment_seconds']
            row['words']=aligned['word_segments']
            row['invalid_timing_words']=[w.get('word') for w in row['words'] if w.get('start') is None or w.get('end') is None or w['end']<=w['start']]
            print('ALIGNED',precision,row['batch'],row['repeat'],'total seconds',round(row['processing_seconds'],3),flush=True)
        except Exception as e:row['alignment_error']=str(e)
        save()
    del aligner,metadata
    gc.collect();torch.cuda.empty_cache()

baseline=next(r for r in report['runs'] if r['precision']=='float16' and r['batch']==1 and r.get('words'))
for row in report['runs']:
    if row.get('words'):
        stats=compare(baseline['words'],row['words'])
        row['baseline_agreement']={k:v for k,v in stats.items() if k not in ['pairs','largest_disagreements']}
summary=[]
for precision in ['float16','int8_float16']:
    for batch in a.batches:
        rows=[r for r in report['runs'] if r['precision']==precision and r['batch']==batch]
        valid=[r for r in rows if 'processing_seconds' in r]
        median=lambda key:round(statistics.median(r[key] for r in valid),4) if valid else None
        summary.append({'precision':precision,'batch':batch,'successes':len(valid),'runs':len(rows),'asr_median_seconds':median('asr_seconds'),'alignment_median_seconds':median('alignment_seconds'),'processing_median_seconds':median('processing_seconds'),'processing_min_seconds':round(min((r['processing_seconds'] for r in valid),default=0),4),'processing_max_seconds':round(max((r['processing_seconds'] for r in valid),default=0),4),'gpu_wide_peak_mib':max((r['gpu_wide_peak_mib'] for r in valid),default=None),'effective_batch_upper_bound':max((r['effective_batch_upper_bound'] for r in valid),default=None),'transcript_variants':len(set(r['transcript_sha256'] for r in valid)),'invalid_timing_words':sum(len(r['invalid_timing_words']) for r in valid),'baseline_unmatched_reference_words_max':max((r['baseline_agreement']['unmatched_reference_words'] for r in valid),default=None)})
report['summary']=summary
report['blocked_python_network_attempts']=network_attempts
(a.output/'report.json').write_text(json.dumps(report,indent=2,default=lambda x:x.item()),encoding='utf-8')
print('SUMMARY',json.dumps(summary,indent=2),flush=True)
