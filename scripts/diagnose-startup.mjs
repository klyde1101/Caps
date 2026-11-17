import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const output=join(root,'data','startup-probe');
await mkdir(output,{recursive:true});
await writeFile(join(output,'main.cjs'),"const {app}=require('electron'); require('node:fs').writeFileSync(process.env.CAPS_PROBE_MARKER,'main-entry'); app.whenReady().then(()=>app.quit());");
const runtime=process.argv[2];
if(!runtime)throw Error('Supply the versioned runtime directory from the Caps EXE resource.');
const records=[];
for(const [name,exe,args]of [['stock',join(root,'node_modules/electron/dist/electron.exe'),[join(output,'main.cjs')]],['packaged',join(resolve(runtime),'Caps.exe'),['--enable-logging=stderr','--crash-dumps-dir='+join(output,'crashes')]]]){
 const record=await new Promise(resolveResult=>{const env={...process.env,PORTABLE_EXECUTABLE_DIR:root,CAPS_PROBE_MARKER:join(output,'marker.txt')};delete env.ELECTRON_RUN_AS_NODE;let stderr='';const child=spawn(exe,args,{env,cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe']});child.stderr.on('data',c=>stderr+=c);const timer=setTimeout(()=>child.kill(),15000);child.once('error',error=>{clearTimeout(timer);resolveResult({name,error:error.message})});child.once('exit',(code,signal)=>{clearTimeout(timer);resolveResult({name,code,hex:code==null?null:(code>>>0).toString(16),signal,stderr})});});records.push(record);
}
await writeFile(join(output,'report.json'),JSON.stringify(records,null,2));console.log(records);
