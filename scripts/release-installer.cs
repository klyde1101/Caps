using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

public sealed class PayloadFile { public string name, sha256; public long size; }
public sealed class PayloadManifest { public string baseUrl; public PayloadFile[] files; public long embeddedSize; }
public sealed class InstallProgress {
    public string Stage, Message;
    public long Current, Total;
    public int Index, Count;
    public static InstallProgress Parse(string line) {
        if (line == null || !line.StartsWith("CAPS_PROGRESS|", StringComparison.Ordinal)) return null;
        string[] f = line.Split('|');
        if (f.Length != 7) return null;
        try {
            return new InstallProgress { Stage=f[1], Current=long.Parse(f[2],CultureInfo.InvariantCulture),
                Total=long.Parse(f[3],CultureInfo.InvariantCulture), Index=int.Parse(f[4],CultureInfo.InvariantCulture),
                Count=int.Parse(f[5],CultureInfo.InvariantCulture), Message=Encoding.UTF8.GetString(Convert.FromBase64String(f[6])) };
        } catch (FormatException) { return null; } catch (OverflowException) { return null; }
    }
}
static class Setup {
    internal static readonly string Executable = Assembly.GetExecutingAssembly().Location;
    internal static readonly string InstallDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\Caps");
    internal static readonly PayloadManifest Payload = ReadPayload();
    static readonly byte[] Footer = Encoding.ASCII.GetBytes("CAPS_PAYLOAD_V1!");
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    internal static string Q(string s) { return "\"" + s + "\""; }
    internal static string PowerShell { get { return Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"); } }
    static PayloadManifest ReadPayload() {
        using (var reader = new StreamReader(Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.json")))
            return new JavaScriptSerializer().Deserialize<PayloadManifest>(reader.ReadToEnd());
    }
    internal static void Export(string name, string destination) {
        using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        using (Stream output = File.Create(destination)) source.CopyTo(output);
    }
    static long PayloadStart(FileStream input) {
        // A signature's PE certificate table follows the payload, with alignment padding.
        var reader = new BinaryReader(input);
        input.Position=0x3c; int pe=reader.ReadInt32();
        input.Position=pe+24; ushort magic=reader.ReadUInt16();
        input.Position=pe+24+(magic==0x20b?112:96)+4*8;
        uint certificate=reader.ReadUInt32(), certificateSize=reader.ReadUInt32();
        long end=certificate!=0 && certificateSize!=0?certificate:input.Length;
        if(end>input.Length || end<24) throw new IOException("The installer payload is damaged.");
        input.Position=Math.Max(0,end-64); long origin=input.Position;
        byte[] tail=reader.ReadBytes((int)(end-origin));
        for(int i=tail.Length-Footer.Length-8;i>=0;i--) {
            bool same=true;
            for(int j=0;j<Footer.Length;j++) if(tail[i+j]!=Footer[j]) { same=false; break; }
            if(!same) continue;
            long size=BitConverter.ToInt64(tail,i+Footer.Length), start=origin+i-size;
            if(size!=Payload.embeddedSize || start<0) throw new IOException("The installer payload is damaged.");
            return start;
        }
        throw new IOException("The installer payload could not be located.");
    }
    // Windows owns the entire worker tree, including an extractor started by PowerShell.
    sealed class WorkerJob:IDisposable {
        IntPtr handle;
        [StructLayout(LayoutKind.Sequential)] struct Limits {
            public long ProcessTime,JobTime; public uint Flags;
            public UIntPtr MinimumWorkingSet,MaximumWorkingSet;
            public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority,Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] struct Counters {public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes;}
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
            public Limits Basic; public Counters Io;
            public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;
        }
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimits limits,uint length);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        internal WorkerJob() {
            handle=CreateJobObject(IntPtr.Zero,null);
            var limits=new ExtendedLimits();limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE
            if(handle==IntPtr.Zero || !SetInformationJobObject(handle,9,ref limits,(uint)Marshal.SizeOf(limits))) {
                int error=Marshal.GetLastWin32Error();Dispose();throw new System.ComponentModel.Win32Exception(error);
            }
        }
        internal void Assign(Process process) {
            if(!AssignProcessToJobObject(handle,process.Handle)) {
                int error=Marshal.GetLastWin32Error();
                if(!process.HasExited){process.Kill();process.WaitForExit();}
                throw new System.ComponentModel.Win32Exception(error,"Could not protect the Setup worker for cancellation.");
            }
        }
        internal void Stop(Process process) {
            if(process.HasExited)return;
            if(!TerminateJobObject(handle,1))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            if(!process.WaitForExit(5000))throw new IOException("The Setup worker did not stop. Close Setup and retry.");
        }
        public void Dispose(){if(handle!=IntPtr.Zero){CloseHandle(handle);handle=IntPtr.Zero;}}
    }
    internal static void MergeInstalledFiles(string destination,IEnumerable<string> incoming) {
        string root=Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar);
        string manifest=Path.Combine(root,"installed-files.txt");
        var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var sources=new List<string>(incoming);
        if(File.Exists(manifest))sources.AddRange(File.ReadAllLines(manifest));
        sources.Add("installed-files.txt");
        foreach(string name in sources) {
            if(string.IsNullOrWhiteSpace(name))continue;
            if(Path.IsPathRooted(name))throw new IOException("Invalid installed file path.");
            string path=Path.GetFullPath(Path.Combine(root,name));
            if(!path.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new IOException("Installed file path escapes Caps.");
            for(string part=path;part!=null;part=Path.GetDirectoryName(part))
                if((File.Exists(part)||Directory.Exists(part)) && (File.GetAttributes(part)&FileAttributes.ReparsePoint)!=0)
                    throw new IOException("A linked installed path prevents safe registration.");
            string relative=path.Substring(root.Length+1);
            string first=relative.Split(Path.DirectorySeparatorChar)[0];
            if(first.Equals("data",StringComparison.OrdinalIgnoreCase)||first.Equals("models",StringComparison.OrdinalIgnoreCase))continue;
            if(!relative.Equals("installed-files.txt",StringComparison.OrdinalIgnoreCase))names.Add(relative);
        }
        string temporary=Path.Combine(root,"installed-files-"+Guid.NewGuid().ToString("N")+".tmp");
        try {
            var ordered=new List<string>(names);ordered.Sort(StringComparer.OrdinalIgnoreCase);
            File.WriteAllLines(temporary,ordered);
            if(File.Exists(manifest))File.Replace(temporary,manifest,null);else File.Move(temporary,manifest);
        } finally {if(File.Exists(temporary))File.Delete(temporary);}
    }
    internal static void Install(string destination,bool register,CancellationToken cancel,Action<InstallProgress> report) {
        string work=Path.Combine(Path.GetTempPath(),"CapsSetup-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        try {
            cancel.ThrowIfCancellationRequested();
            foreach(string file in new[]{"7za.exe","payload.json","install-release-payload.ps1"}) Export(file,Path.Combine(work,file));
            if(Payload.embeddedSize>0) {
                report(new InstallProgress {Stage="prepare",Message="Preparing the bundled runtime"});
                using(var input=File.OpenRead(Executable))
                using(var output=File.Create(Path.Combine(work,"embedded.zip"))) {
                    input.Position=PayloadStart(input); long remaining=Payload.embeddedSize; byte[] buffer=new byte[1024*1024];
                    while(remaining>0) {
                        cancel.ThrowIfCancellationRequested();
                        int count=input.Read(buffer,0,(int)Math.Min(buffer.Length,remaining));
                        if(count==0) throw new EndOfStreamException();
                        output.Write(buffer,0,count); remaining-=count;
                    }
                }
            }
            var start=new ProcessStartInfo(PowerShell,"-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "+Q(Path.Combine(work,"install-release-payload.ps1"))) {
                WorkingDirectory=work,UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true };
            start.EnvironmentVariables["CAPS_SETUP_DEST"]=destination;
            start.EnvironmentVariables["CAPS_SETUP_SOURCE"]=Path.GetDirectoryName(Executable);
            using(var job=new WorkerJob())
            using(var process=new Process {StartInfo=start}) {
                process.OutputDataReceived+=(s,e)=>{var progress=InstallProgress.Parse(e.Data);if(progress!=null) report(progress);};
                cancel.ThrowIfCancellationRequested(); process.Start(); job.Assign(process); process.BeginOutputReadLine();
                var errors=process.StandardError.ReadToEndAsync();
                try {
                    while(!process.WaitForExit(100)) cancel.ThrowIfCancellationRequested();
                    process.WaitForExit(); // Drain final asynchronous output.
                    cancel.ThrowIfCancellationRequested();
                    if(process.ExitCode!=0) throw new IOException(errors.Result.Trim());
                } finally { job.Stop(process); }
            }
            cancel.ThrowIfCancellationRequested();
            if(!register) return;
            report(new InstallProgress {Stage="finish",Message="Adding Caps to your Start menu"});
            Export("uninstall.exe",Path.Combine(destination,"Uninstall-Caps.exe"));
            using(var reader=new StreamReader(Assembly.GetExecutingAssembly().GetManifestResourceStream("installed-files.txt")))
                MergeInstalledFiles(destination,reader.ReadToEnd().Split(new[]{'\r','\n'},StringSplitOptions.RemoveEmptyEntries));
            Type type=Type.GetTypeFromProgID("WScript.Shell");
            dynamic shell=Activator.CreateInstance(type);
            dynamic link=shell.CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"Caps.lnk"));
            link.TargetPath=Path.Combine(destination,"Caps.exe");link.WorkingDirectory=destination;link.Save();
            using(var key=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Caps")) {
                key.SetValue("DisplayName","Caps");key.SetValue("DisplayVersion",InstallerIdentity.Version);
                key.SetValue("Publisher",InstallerIdentity.Publisher);key.SetValue("URLInfoAbout",InstallerIdentity.Url);
                key.SetValue("DisplayIcon",Path.Combine(destination,"Caps.exe"));key.SetValue("InstallLocation",destination);
                key.SetValue("NoModify",1,RegistryValueKind.DWord);key.SetValue("NoRepair",1,RegistryValueKind.DWord);
                key.SetValue("UninstallString",Q(Path.Combine(destination,"Uninstall-Caps.exe")));
            }
        } finally {try {Directory.Delete(work,true);} catch(IOException) {} catch(UnauthorizedAccessException) {}}
    }
    [STAThread] static int Main(string[] args) {
        if(args.Length==2 && args[0]=="--extract-to") {
            string destination=Path.GetFullPath(args[1]), log=destination+".setup-progress.log"; object gate=new object();
            try {
                Install(destination,false,CancellationToken.None,p=>{lock(gate) File.AppendAllText(log,new JavaScriptSerializer().Serialize(p)+Environment.NewLine);});
                return 0;
            } catch(Exception e) {File.WriteAllText(destination+".setup-error.txt",e.ToString());return 1;}
        }
        try {SetProcessDPIAware();} catch(EntryPointNotFoundException) {}
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        string preview=args.Length==2 && args[0]=="--preview"?args[1]:null;
        using(var form=new InstallerWindow(preview)) Application.Run(form);
        return 0;
    }
}
sealed class InstallerWindow:Form {
    readonly string preview;
    readonly Label heading,description,note,stage,percent,detail;
    readonly Label[] steps=new Label[3];
    readonly TextBox folder,errorDetails;
    readonly CapsProgress progress;
    readonly CapsButton primary,secondary;
    readonly LinkLabel detailsLink;
    readonly Stopwatch clock=new Stopwatch();
    CancellationTokenSource cancellation;
    System.Windows.Forms.Timer previewTimer;
    long previousBytes;double previousTime,speed;
    string currentStage="";bool busy,complete;
    [DllImport("dwmapi.dll")]static extern int DwmSetWindowAttribute(IntPtr window,int attr,ref int value,int size);
    internal InstallerWindow(string previewState) {
        preview=previewState;Text=preview==null?"Caps Setup":"Caps Setup - Preview";
        AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;ClientSize=new Size(640,504);
        BackColor=Skin.Ground;ForeColor=Skin.Text;Font=Skin.Font(14);FormBorderStyle=FormBorderStyle.FixedSingle;
        MaximizeBox=false;StartPosition=FormStartPosition.CenterScreen;Icon=Icon.ExtractAssociatedIcon(Setup.Executable);
        var logo=new PictureBox {Bounds=new Rectangle(32,24,38,38),SizeMode=PictureBoxSizeMode.Zoom,TabStop=false};
        using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("caps-icon.png"))
        using(var image=Image.FromStream(stream))logo.Image=new Bitmap(image);
        Controls.Add(logo);
        LabelAt(this,"Caps",82,20,240,30,24,Skin.Text,FontStyle.Bold);
        LabelAt(this,"Windows setup",83,51,260,22,12,Skin.Muted);
        var version=LabelAt(this,InstallerIdentity.Version,420,32,188,24,12,Skin.Muted);version.TextAlign=ContentAlignment.MiddleRight;
        Controls.Add(new Panel {Bounds=new Rectangle(32,88,576,1),BackColor=Skin.Line});
        heading=LabelAt(this,"Install Caps",32,112,576,40,26,Skin.Text,FontStyle.Bold);
        description=LabelAt(this,"Create and edit captions locally.\nInstall the app and its CPU and NVIDIA runtimes.",32,162,576,48,14,Skin.Muted);
        var card=new SurfacePanel {Bounds=new Rectangle(32,228,576,130)};Controls.Add(card);
        stage=LabelAt(card,"Installation folder",16,14,440,24,13,Skin.Muted);
        percent=LabelAt(card,"",464,14,96,24,14,Skin.Text,FontStyle.Bold);percent.TextAlign=ContentAlignment.MiddleRight;
        folder=new TextBox {Bounds=new Rectangle(16,48,544,24),Text=Setup.InstallDirectory,BorderStyle=BorderStyle.None,
            BackColor=Skin.Surface,ForeColor=Skin.Text,Font=Skin.Font(14),ReadOnly=true,AccessibleName="Installation folder",TabIndex=0};
        card.Controls.Add(folder);
        progress=new CapsProgress {Bounds=new Rectangle(16,48,544,9),Visible=false};card.Controls.Add(progress);
        long bytes=0;foreach(var f in Setup.Payload.files)bytes+=f.size;
        detail=LabelAt(card,"CPU + NVIDIA CUDA  \u00b7  "+Bytes(bytes)+" download",16,88,544,24,12,Skin.Muted);
        for(int i=0;i<3;i++) {steps[i]=LabelAt(card,(i+1)+"  "+new[]{"Download","Verify","Install"}[i],16+i*181,98,170,22,12,Skin.Muted);steps[i].Visible=false;}
        errorDetails=new TextBox {Bounds=new Rectangle(48,242,544,104),Multiline=true,ReadOnly=true,BorderStyle=BorderStyle.None,
            BackColor=Skin.Surface,ForeColor=Skin.Text,Font=Skin.Font(12),ScrollBars=ScrollBars.Vertical,Visible=false,AccessibleName="Installation error details"};
        Controls.Add(errorDetails);
        note=LabelAt(this,"Installs for your Windows account. No administrator access needed.\nAllow at least 12 GB of free space.",32,375,576,32,12,Skin.Muted);
        detailsLink=new LinkLabel {Bounds=new Rectangle(32,375,200,28),Text="Show details",Font=Skin.Font(12),LinkColor=Skin.Text,
            ActiveLinkColor=Skin.Accent,VisitedLinkColor=Skin.Text,Visible=false,TabIndex=3};
        detailsLink.LinkClicked+=(s,e)=>{errorDetails.Visible=!errorDetails.Visible;errorDetails.BringToFront();detailsLink.Text=errorDetails.Visible?"Hide details":"Show details";};
        Controls.Add(detailsLink);Controls.Add(new Panel {Bounds=new Rectangle(32,421,576,1),BackColor=Skin.Line});
        var github=new PictureBox {Bounds=new Rectangle(32,448,18,18),SizeMode=PictureBoxSizeMode.Zoom,TabStop=false};
        using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("github-mark.png"))
        using(var image=Image.FromStream(stream))github.Image=new Bitmap(image);
        Controls.Add(github);
        LabelAt(this,InstallerIdentity.Publisher,58,445,254,24,12,Skin.Muted);
        secondary=new CapsButton(false) {Bounds=new Rectangle(328,438,108,44),Text="Cancel",TabIndex=2};
        primary=new CapsButton(true) {Bounds=new Rectangle(448,438,160,44),Text="Install Caps",TabIndex=1};
        Controls.Add(secondary);Controls.Add(primary);AcceptButton=primary;
        primary.Click+=(s,e)=>{if(complete) {if(preview==null)Process.Start(new ProcessStartInfo(Path.Combine(Setup.InstallDirectory,"Caps.exe")) {WorkingDirectory=Setup.InstallDirectory});Close();}
            else if(preview!=null)Preview("download");else StartInstall();};
        secondary.Click+=(s,e)=>{if(busy)StopInstall();else Close();};
        FormClosing+=(s,e)=>{if(busy){e.Cancel=true;StopInstall();}};
        Shown+=(s,e)=>{primary.Focus();if(preview!=null)Preview(preview);};
    }
    protected override bool ProcessCmdKey(ref Message msg,Keys key) {if(key==Keys.Escape){secondary.PerformClick();return true;}return base.ProcessCmdKey(ref msg,key);}
    protected override void OnHandleCreated(EventArgs e) {base.OnHandleCreated(e);try{int dark=1;DwmSetWindowAttribute(Handle,20,ref dark,sizeof(int));}catch(DllNotFoundException){}catch(EntryPointNotFoundException){}}
    static Label LabelAt(Control parent,string text,int x,int y,int w,int h,float size,Color color,FontStyle style=FontStyle.Regular) {
        var l=new Label {Text=text,Bounds=new Rectangle(x,y,w,h),Font=Skin.Font(size,style),ForeColor=color,
            BackColor=parent is SurfacePanel?Skin.Surface:Skin.Ground,UseMnemonic=false};parent.Controls.Add(l);return l;
    }
    internal static string Bytes(double n) {return n>=1024*1024*1024?(n/(1024*1024*1024)).ToString("0.00",CultureInfo.InvariantCulture)+" GB":(n/(1024*1024)).ToString("0.0",CultureInfo.InvariantCulture)+" MB";}
    void StopInstall() {cancellation.Cancel();secondary.Enabled=false;note.Text="Stopping installation\u2026";}
    void StartInstall() {
        cancellation=new CancellationTokenSource();busy=true;complete=false;primary.Enabled=false;primary.Text="Installing...";secondary.Enabled=true;secondary.Text="Cancel";
        folder.Visible=false;errorDetails.Visible=false;detailsLink.Visible=false;note.Visible=true;
        foreach(var step in steps)step.Visible=true;
        progress.Visible=true;progress.Active=true;progress.Indeterminate=true;progress.Value=0;
        clock.Restart();previousBytes=0;previousTime=0;speed=0;currentStage="";
        ApplyProgress(new InstallProgress {Stage="prepare",Message="Connecting to the release downloads"});
        Task.Factory.StartNew(()=>{
            Exception failure=null;try{Setup.Install(Setup.InstallDirectory,true,cancellation.Token,Report);}catch(Exception e){failure=e;}
            if(!IsDisposed)BeginInvoke((Action)(()=>Finish(failure)));
        });
    }
    void Report(InstallProgress p) {if(!IsDisposed&&IsHandleCreated)BeginInvoke((Action)(()=>ApplyProgress(p)));}
    void ApplyProgress(InstallProgress p) {
        bool changed=currentStage!=p.Stage;
        if(changed){currentStage=p.Stage;previousBytes=p.Current;previousTime=clock.Elapsed.TotalSeconds;speed=0;progress.Reset();}
        heading.Text=p.Stage=="download"?"Downloading Caps":p.Stage=="verify"?"Verifying your download":p.Stage=="extract"?"Installing Caps":p.Stage=="finish"?"Almost ready":"Preparing installation";
        description.Text=p.Stage=="download"?"Getting the CPU and NVIDIA runtimes for local caption generation.":p.Stage=="verify"?"Checking runtime data before installation.":
            p.Stage=="extract"?"Setting up the app and its runtimes. This may take a few minutes.":"Preparing Caps for your Windows account.";
        stage.Text=p.Message;stage.ForeColor=Skin.Text;progress.Visible=true;progress.Active=true;progress.Indeterminate=p.Total<=0;
        double ratio=p.Total>0?Math.Max(0,Math.Min(1,(double)p.Current/p.Total)):0;progress.Value=ratio;
        percent.Text=p.Total>0?Math.Floor(ratio*100).ToString(CultureInfo.InvariantCulture)+"%":"";
        progress.AccessibleDescription=heading.Text+", "+percent.Text;folder.Visible=false;detail.Top=72;
        double now=clock.Elapsed.TotalSeconds;
        if(p.Stage=="download"&&!changed&&now-previousTime>=.5){double instant=Math.Max(0,p.Current-previousBytes)/Math.Max(.001,now-previousTime);
            speed=speed==0?instant:.75*speed+.25*instant;previousBytes=p.Current;previousTime=now;}
        detail.Text=p.Total>0&&p.Stage!="extract"?Bytes(p.Current)+" of "+Bytes(p.Total):"Preparing the installed app and runtimes";
        if(p.Stage=="download"&&speed>0){long seconds=(long)Math.Ceiling(Math.Max(0,p.Total-p.Current)/speed);detail.Text+="  \u00b7  "+Bytes(speed)+"/s";
            if(seconds>0)detail.Text+="  \u00b7  "+(seconds>=60?Math.Ceiling(seconds/60.0)+" min":seconds+" sec")+" remaining";}
        int current=p.Stage=="verify"?1:p.Stage=="extract"||p.Stage=="finish"?2:0;
        for(int i=0;i<3;i++){steps[i].Visible=true;steps[i].ForeColor=i<current?Skin.Success:i==current?Skin.Text:Skin.Muted;}
        note.Text="You can keep using your computer while Caps installs.";if(p.Stage=="finish")secondary.Enabled=false;
    }
    void Finish(Exception error) {
        busy=false;progress.Active=false;progress.Indeterminate=false;primary.Enabled=true;secondary.Enabled=true;secondary.Text="Close";
        folder.Visible=false;progress.Visible=true;detail.Top=72;foreach(var step in steps)step.Visible=true;
        if(error==null){complete=true;progress.Value=1;percent.Text="100%";heading.Text="Caps is ready";
            description.Text="Your captions stay on your computer.\nOpen Caps and choose a speech model in Settings to get started.";
            stage.Text="Installation complete";detail.Text="Caps has been added to your Start menu.";
            foreach(var step in steps)step.ForeColor=Skin.Success;
            note.Text="Your first model download needs an internet connection.";primary.Text="Open Caps";secondary.Text="Finish";
        } else {bool stopped=error is OperationCanceledException;heading.Text=stopped?"Installation stopped":"Installation couldn't finish";
            description.Text=stopped?"You can run Setup again whenever you're ready.":"Check your connection and available disk space, then try again.";
            stage.Text=stopped?"Setup was cancelled":"Setup needs your attention";percent.Text="";detail.Text="Retry to download, verify, and install Caps.";
            note.Text="";errorDetails.Text=error.ToString();detailsLink.Visible=!stopped;
            if(detailsLink.Visible){note.Visible=false;detailsLink.BringToFront();}primary.Text="Try again";}
        primary.Focus();
    }
    void Preview(string state) {
        if(state=="welcome")return;folder.Visible=false;primary.Enabled=false;primary.Text="Installing...";progress.Visible=true;progress.Active=true;
        foreach(var step in steps)step.Visible=true;clock.Restart();
        if(state=="complete"){Finish(null);return;}if(state=="error"){Finish(new IOException("The download was interrupted. Check your internet connection and try again."));return;}
        long total=0;foreach(var f in Setup.Payload.files)total+=f.size;long current=(long)(total*.42);
        string phase=state=="verify"?"verify":state=="extract"?"extract":"download";
        Action draw=()=>ApplyProgress(new InstallProgress {Stage=phase,Current=phase=="extract"?42:current,Total=phase=="extract"?100:total,
            Index=1,Count=Setup.Payload.files.Length,Message=phase=="download"?"Runtime data - part 1 of 3":phase=="verify"?"Checking runtime data - part 1 of 3":"Installing the app and runtimes"});
        draw();previewTimer=new System.Windows.Forms.Timer {Interval=250};previewTimer.Tick+=(s,e)=>{current=Math.Min((long)(total*.93),current+2*1024*1024);draw();};previewTimer.Start();secondary.Text="Close";
    }
    protected override void Dispose(bool disposing){if(disposing){if(previewTimer!=null)previewTimer.Dispose();if(cancellation!=null)cancellation.Dispose();}base.Dispose(disposing);}
}
