import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {findWhisperxRuntime} from '../whisperx-runner.js';
const source = readFileSync(new URL('./locked-caption-save.py', import.meta.url),'utf8').replace(/^\uFEFF/, '');
export async function lockedCaptionSave(path, expected, content, {onLocked, executable} = {}) {
  executable ??= (await findWhisperxRuntime({device:'cpu'})).executable;
  if (basename(executable).toLowerCase() !== 'python.exe') throw Error('The bundled Python runtime is required for safe caption saves.');
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,['-u','-c',source],{windowsHide:true,shell:false,env:{...process.env,PYTHONUTF8:'1'},stdio:['pipe','pipe','pipe']});
    let pending='',failure, saved=false, stderr='';
    const timer=setTimeout(()=>{failure=Error('Caption save timed out. Check the adjacent .caps-recovery file before retrying.');child.kill();},30000);
    child.on('error',error=>{clearTimeout(timer);reject(error)});
    child.stdin.on('error',error=>{failure ??= error;});
    child.stderr.on('data',chunk=>stderr+=chunk);
    child.stdout.on('data',chunk=>{pending+=chunk;let i;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);try{const event=JSON.parse(line);if(event.error)failure=Object.assign(Error(event.message),{code:event.error});if(event.saved)saved=true;if(event.locked)Promise.resolve().then(()=>onLocked?.()).then(()=>child.stdin.end('commit\n'),error=>{failure=error;child.stdin.end('abort\n')});}catch(error){failure=error;child.kill();}}});
    child.once('close',code=>{clearTimeout(timer);if(code===0&&saved&&!failure)resolve();else reject(failure??Error(stderr.trim()||'Caption save failed; any recovery copy has been retained.'));});
    child.stdin.write(JSON.stringify({path,expected,content})+'\n');
  });
}
