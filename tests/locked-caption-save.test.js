import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rename,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {lockedCaptionSave} from '../src/desktop/locked-caption-save.js';

test('exclusive caption lock denies external writes and replacement until commit', {skip:process.platform!=='win32'}, async()=>{
 const root=await mkdtemp(join(tmpdir(),'caps-lock-'));const file=join(root,'file.srt');
 try{await writeFile(file,'Original');await lockedCaptionSave(file,'Original','Corrected',{onLocked:async()=>{
  await assert.rejects(writeFile(file,'External'));await assert.rejects(rename(file,join(root,'moved.srt')));
 }});assert.equal(await readFile(file,'utf8'),'Corrected');assert.deepEqual(await readdir(root),['file.srt']);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('stale caption save and interrupted lock do not modify the original file',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'caps-lock-'));const file=join(root,'file.srt');
 try{await writeFile(file,'External');await assert.rejects(lockedCaptionSave(file,'Old','Corrected'),{code:'OUTPUT_CONFLICT'});
 await assert.rejects(lockedCaptionSave(file,'External','Corrected',{onLocked:()=>{throw Error('interrupted')}}),/interrupted/);
 assert.equal(await readFile(file,'utf8'),'External');assert.deepEqual(await readdir(root),['file.srt']);
 }finally{await rm(root,{recursive:true,force:true});}
});
