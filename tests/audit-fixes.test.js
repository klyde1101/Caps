import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueueTranscriber} from '../src/queue-transcriber.js';
import {modelCompatibility} from '../src/model-catalog.js';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPreviewStore} from '../src/desktop/preview-store.js';

test('Automatic retries a VRAM failure on CPU once and replays prior transcripts exactly once', async()=>{
 const created=[];
 const queue=await createQueueTranscriber({createWorker:async({device})=>{
  created.push(device); const items=[];
  return {async transcribe(request,index){if(device==='auto' && index===1)throw Error('CUDA out of memory');items.push({fileIndex:index,srt:'aligned'});},async align(){return items;},async release(){},async close(){}};
 }});
 try{for(let i=0;i<3;i++)await queue.transcribe({inputPath:i+'.wav',device:'cuda',processingPolicy:'auto'},i);
 assert.deepEqual(created,['auto','cpu']);assert.deepEqual((await queue.align()).map(x=>x.fileIndex),[0,1,2]);}finally{await queue.close();}
});
test('explicit CUDA never retries on CPU',async()=>{
 const devices=[];const queue=await createQueueTranscriber({createWorker:async({device})=>{devices.push(device);return{async transcribe(){throw Error('CUDA out of memory');},async close(){}};}});
 try{await assert.rejects(queue.transcribe({device:'cuda'},0),/out of memory/);assert.deepEqual(devices,['cuda']);}finally{await queue.close();}
});
test('Automatic uses CPU when free VRAM is insufficient; GPU readiness does not invent a RAM/VRAM warning',()=>{
 const d={memory:{totalBytes:16*1024**3},runtimes:{cpu:{available:true},cuda:{available:true}},cuda:{devices:[{index:0,totalMemoryBytes:8*1024**3,freeMemoryBytes:1024**3}]}};
 assert.equal(modelCompatibility('large-v3-turbo',d).device,'cpu');d.memory.totalBytes=6*1024**3;d.cuda.devices[0].freeMemoryBytes=8*1024**3;
 assert.equal(modelCompatibility('large-v3-turbo',d,{device:'cuda'}).supported,true);
});
test('caption saves reject an external edit that occurs after the first read',async()=>{
 const root=await mkdtemp(join(tmpdir(),'caps-save-race-'));const outputPath=join(root,'out.srt');const original='1\n00:00:00,000 --> 00:00:01,000\nOriginal\n';let reads=0;
 try{await writeFile(outputPath,original);const store=createPreviewStore({readFile:async(p,e)=>{const content=await readFile(p,e);if(++reads===1)await writeFile(p,original.replace('Original','External'));return content;}});
 const {previewToken}=store.register({outputPath});await assert.rejects(store.save({previewToken,original,changes:[{index:1,text:'Local'}]}),{code:'OUTPUT_CONFLICT'});assert.match(await readFile(outputPath,'utf8'),/External/);
 }finally{await rm(root,{recursive:true,force:true});}
});
