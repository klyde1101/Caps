import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

test('native setup and removal previews preserve progress data, accessible controls, and state coverage', { skip: process.platform !== 'win32' }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'caps-ui-'));
  try {
    const harness = join(work, 'preview.cs');
    await writeFile(harness, String.raw`
using System;using System.Drawing;using System.Reflection;using System.Windows.Forms;
internal static class InstallerIdentity {public const string Publisher="test",Version="test",Url="https://example.test";}
class PreviewTest {
 static object Field(object form,string name){return form.GetType().GetField(name,BindingFlags.Instance|BindingFlags.NonPublic).GetValue(form);}
 static void Call(object form,string method,object value){form.GetType().GetMethod(method,BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,new[]{value});}
 static void Check(bool valid,string reason){if(!valid)throw new Exception(reason);}
 static void CheckControls(Control parent){foreach(Control control in parent.Controls){if(!control.Visible)continue;
  Check(control.Left>=0&&control.Top>=0&&control.Right<=parent.ClientSize.Width+1&&control.Bottom<=parent.ClientSize.Height+1,"Control outside parent: "+control.GetType().Name+" "+control.Bounds+" parent "+parent.ClientSize+" "+control.Text);
  if(control is Button)Check(control.AccessibilityObject.Name.Length>0,"Unnamed button");
  if(control is VersionPill||control is CapsProgress||control is SetupSteps)Check(!control.TabStop,"Display-only control must not receive keyboard focus");CheckControls(control);
 }}
 [STAThread] static void Main(){Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
  var estimate=new DownloadEstimate();
  estimate.Update(0,0);estimate.Update(1,100);Check(!estimate.Stable,"Do not show unstable ETA");
  for(int second=2;second<=15;second++)estimate.Update(second,second*100);
  Check(estimate.Stable&&estimate.Speed==100,"Ten-second moving average must preserve a steady rate");
  Check(estimate.Remaining(6000)=="about 1 min left"&&estimate.Remaining(5900)=="less than a minute left","ETA boundary copy");
  estimate.Update(16,0);Check(!estimate.Stable,"A new part must clear the previous speed estimate");
  foreach(float scale in new[]{1f,1.25f,1.5f})foreach(bool removal in new[]{false,true})foreach(string state in removal?new[]{"welcome","remove","complete","error"}:new[]{"welcome","download","verify","extract","complete","error"})
   using(Form form=removal?(Form)new UninstallerWindow(state):new InstallerWindow(state)){
    form.Show();Application.DoEvents();
    var cancel=(Button)Field(form,"secondary");var primary=(Button)Field(form,"primary");
    Check(cancel.TabIndex<primary.TabIndex,"Cancel must precede primary in keyboard order");
    Check(!cancel.Focused,"Cancel must never be autofocused on open");
    Check(form.FormBorderStyle==FormBorderStyle.None&&!form.MaximizeBox,"Both windows must use the flat shell with maximize disabled");
    Check(form.Text==(removal?"Uninstall Caps":"Caps Setup"),"Preview and production must use approved titles");
    if(scale!=1){form.AutoScaleDimensions=new SizeF(96/scale,96/scale);form.PerformAutoScale();}
    CheckControls(form);
    var layout=(SetupLayout)Field(form,"layout");int edge=layout.Card.Left;
    foreach(Control aligned in new Control[]{layout.Logo,layout.Heading,layout.Description,layout.Repository})Check(aligned.Left==edge,"All content left edges must match");
    Check(layout.Steps.Left+layout.Steps.Inset==edge,"First step circle must share the content left edge");
    Check(layout.Version.Right==layout.Card.Right&&layout.Primary.Right==layout.Card.Right,"All content right edges must match");
    if(state=="welcome"){
      var field=layout.Folder;
      Check(field.Parent.GetChildAtPoint(new Point(field.Left+2,field.Top+2))==field,"Path text must be in front of the stage subtitle");
    }
    if(state=="download"||state=="remove")Check(cancel.Text=="Cancel","Running-state secondary label must be Cancel");
    if(removal){Check(layout.Note.Text=="Your settings, downloaded models, and caption files are kept.","One approved reassurance line");Check(layout.Part.Text.Length==0&&layout.Detail.Text.Length==0,"No duplicate reassurance in removal card");}
    Skin.MotionOverride=false;
    if(removal&&state=="remove")using(var pixels=new Bitmap(layout.Steps.Width,layout.Steps.Height)){
      layout.Steps.DrawToBitmap(pixels,layout.Steps.ClientRectangle);float unit=layout.Steps.Height/48f;
      Color completed=pixels.GetPixel((int)(164*unit+layout.Steps.ConnectorWidth/2),layout.Steps.Height/2);
      Check(completed.R==Skin.Accent.R&&completed.G==Skin.Accent.G&&completed.B==Skin.Accent.B,"Completed connector must be solid accent");
    }
    var motionBar=(CapsProgress)Field(form,"progress");motionBar.Value=.375;
    Check(motionBar.RenderedValue==.375,"Reduced motion must immediately render real progress");
    Skin.MotionOverride=null;
    if(!removal&&state=="download"){
     Call(form,"ApplyProgress",new InstallProgress{Stage="download",Current=30,Total=100,Index=4,Count=7});
     Check(((Label)Field(form,"part")).Text=="Part 4 of 7","Part count must come from worker data");
     var bar=(CapsProgress)Field(form,"progress");Check(Math.Abs(bar.Value-.3)<.001&&!bar.Indeterminate,"Download must retain real progress");
     Check(bar.AccessibleRole==AccessibleRole.ProgressBar,"Progress must expose native role");
     Call(form,"ApplyProgress",new InstallProgress{Stage="verify",Current=30,Total=100});Check(bar.Indeterminate,"File checking is indeterminate");
     Call(form,"ApplyProgress",new InstallProgress{Stage="extract",Current=30,Total=100});Check(!bar.Indeterminate&&Math.Abs(bar.Value-.3)<.001,"Install must retain real progress");
     Call(form,"ApplyProgress",new InstallProgress{Stage="extract",Total=0});Check(bar.Indeterminate,"Unknown install progress must stay indeterminate");
    }
    if(state=="complete")Check(((SetupSteps)Field(form,"steps")).Current==3,"Completion must finish all steps");
    if(state=="error")Check(((CapsProgress)Field(form,"progress")).Failed,"Failure must show error treatment");
    form.Close();
   }
  Console.WriteLine("native-ui-ok");
 }
}`);
    const payload = join(work, 'payload.json');
    await writeFile(payload, '{"files":[{"name":"part1","size":100},{"name":"part2","size":100}]}');
    const exe = join(work, 'preview.exe');
    await run(join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
      '/nologo', '/target:exe', '/main:PreviewTest', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
      '/reference:System.Web.Extensions.dll', '/reference:Microsoft.CSharp.dll', `/out:${exe}`, `/resource:${payload},payload.json`,
      `/resource:${join(root, 'build/caps-icon.png')},caps-icon.png`, `/resource:${join(root, 'build/github-mark.png')},github-mark.png`,
      harness, ...['release-installer.cs', 'release-uninstaller.cs', 'release-skin.cs'].map(name => join(root, 'scripts', name)),
    ], { windowsHide: true });
    const result = await run(exe, [], { windowsHide: true, timeout: 30000 });
    assert.match(result.stdout, /native-ui-ok/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

