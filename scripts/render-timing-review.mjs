import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,relative,join} from 'node:path';
import {convertWhisperxSrt} from '../src/pipeline.js';
const root=resolve(import.meta.dirname,'..');
const dir=join(root,'data/timing-qa/results');
const settings=JSON.parse(await readFile(join(root,'data/settings.json'),'utf8'));
const summary={captionSettings:{orientation:settings.orientation,fontSize:settings.fontSize,fontFamily:settings.fontFamily,timing:settings.timing},recognitionModel:'large-v3-turbo',engines:{}};
const stamp=ms=>{ms=Math.round(ms/10);return Math.floor(ms/360000)+':'+String(Math.floor(ms/6000)%60).padStart(2,'0')+':'+String(Math.floor(ms/100)%60).padStart(2,'0')+'.'+String(ms%100).padStart(2,'0');};
for(const name of ['native','controlled_alignment','current_caps']){
 const words=JSON.parse(await readFile(join(dir,name+'.json'),'utf8'));
 const invalid=words.filter(w=>w.start==null||w.end==null||w.end<=w.start).map(w=>w.word);
 if(invalid.length)throw Error(name+' has invalid timings: '+invalid.join(', '));
 const result=convertWhisperxSrt(await readFile(join(dir,name+'-words.srt'),'utf8'),'social-media',settings);
 await writeFile(join(dir,name+'-social.srt'),result.srt);
 summary.engines[name]={words:words.length,cues:result.cues.length,validation:result.validation};
 const label={native:'faster-whisper',controlled_alignment:'Same text + alignment',current_caps:'Caps pipeline (Turbo)'}[name];
 const header=`[Script Info]\nScriptType: v4.00+\nPlayResX: 360\nPlayResY: 640\nWrapStyle: 2\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H88000000,-1,0,0,0,100,100,0,0,1,1.5,0,2,20,20,110,1\nStyle: Header,Arial,14,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,3,2,0,8,5,5,15,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 1,0:00:00.00,0:00:37.00,Header,,0,0,0,,${label}\n`;
 const events=result.cues.map(c=>`Dialogue: 0,${stamp(c.start)},${stamp(c.end)},Caption,,0,0,0,,${c.text.replaceAll('\\','/').replaceAll('{','(').replaceAll('}',')').replaceAll('\n','\\N')}`).join('\n');
 await writeFile(join(dir,name+'.ass'),header+events+'\n');
}
await writeFile(join(dir,'caption-summary.json'),JSON.stringify(summary,null,2));
const rel=relative(root,dir).replaceAll('\\','/');
const graph=`[0:v]fps=30,scale=360:640,split=3[a][b][c];[a]ass=${rel}/native.ass[x];[b]ass=${rel}/controlled_alignment.ass[y];[c]ass=${rel}/current_caps.ass[z];[x][y][z]hstack=inputs=3[video]`;
await writeFile(join(dir,'comparison-filter.txt'),graph);
const output=join(dir,'Caps_Timing_Comparison.mp4');
const child=spawn(join(root,'whisperx/ffmpeg/ffmpeg.exe'),['-hide_banner','-loglevel','warning','-i',join(root,'data/timing-qa/input/NRTV_MEGA169_A_118Refresh_US_E545_9x16_V4_1.mp4'),'-filter_complex_script',join(dir,'comparison-filter.txt'),'-map','[video]','-map','0:a:0','-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-b:a','96k','-movflags','+faststart','-y',output],{cwd:root,windowsHide:true,stdio:['ignore','inherit','inherit']});
child.on('exit',code=>{if(code!==0)process.exitCode=1;else console.log(output)});
