using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

static class UninstallProgram {
    internal static readonly string Root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),@"Programs\Caps");
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [STAThread] static int Main(string[] args) {
        try {
            string self=Assembly.GetExecutingAssembly().Location;
            bool preview=args.Length==2 && args[0]=="--preview";
            if(!preview && args.Length==0) {
                if(!string.Equals(Path.GetDirectoryName(self),Root,StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Run Uninstall-Caps.exe from the Caps installation folder.");
                // Run outside the installation so Windows can remove the installed EXE.
                string copy=Path.Combine(Path.GetTempPath(),"Caps-Uninstall-"+Guid.NewGuid().ToString("N")+".exe");
                File.Copy(self,copy);
                Process.Start(new ProcessStartInfo(copy,"--remove") {UseShellExecute=false,WorkingDirectory=Path.GetTempPath()});
                return 0;
            }
            if(!preview && !(args.Length==1 && args[0]=="--remove")) return 1;
            SetProcessDPIAware();Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
            using(var window=new UninstallerWindow(preview?args[1]:null))Application.Run(window);
            return 0;
        } catch(Exception e) {MessageBox.Show(e.Message,"Caps uninstall",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1;}
    }
}

static class CapsRemoval {
    static void CheckPath(string root,string path) {
        if(!path.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))
            throw new IOException("An installed file path is outside the Caps folder.");
        for(string part=path;part!=null;part=Path.GetDirectoryName(part)) {
            if((File.Exists(part)||Directory.Exists(part)) && (File.GetAttributes(part)&FileAttributes.ReparsePoint)!=0)
                throw new IOException("A linked installation path prevents safe removal: "+part);
        }
    }
    // The caller supplies the fixed per-user install root; tests use isolated fixture roots.
    internal static void RemoveFiles(string root,Action<int,int> progress) {
        root=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        string manifest=Path.Combine(root,"installed-files.txt");
        var files=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        CheckPath(root,manifest);
        foreach(string name in File.ReadAllLines(manifest)) {
            if(string.IsNullOrWhiteSpace(name))continue;
            if(Path.IsPathRooted(name))throw new IOException("Invalid installed file path.");
            string path=Path.GetFullPath(Path.Combine(root,name));CheckPath(root,path);
            string relative=path.Substring(root.Length+1);
            // Personal files and downloaded models survive even an incorrect manifest.
            string first=relative.Split(Path.DirectorySeparatorChar)[0];
            if(first.Equals("data",StringComparison.OrdinalIgnoreCase)||first.Equals("models",StringComparison.OrdinalIgnoreCase))continue;
            files.Add(path);
        }
        foreach(string name in new[]{"Uninstall-Caps.exe","Uninstall-Caps.ps1"}) {
            string path=Path.Combine(root,name);CheckPath(root,path);files.Add(path);
        }
        var ordered=new List<string>(files);ordered.Sort((a,b)=>b.Length.CompareTo(a.Length));
        // Check for locked files before removal, so a running Caps usually leaves the install intact.
        foreach(string path in ordered)if(File.Exists(path))
            using(var probe=File.Open(path,FileMode.Open,FileAccess.ReadWrite,FileShare.None)){}
        int count=0;
        foreach(string path in ordered) {
            CheckPath(root,path);
            if(File.Exists(path))File.Delete(path);
            else if(Directory.Exists(path) && Directory.GetFileSystemEntries(path).Length==0)Directory.Delete(path);
            count++;
            if(count%128==0 || count==ordered.Count)progress(count,ordered.Count);
        }
        // Keep the manifest until every owned file has been removed, allowing retries.
    }
    internal static void Remove(Action<int,int> progress) {
        string root=UninstallProgram.Root;
        RemoveFiles(root,progress);
        string shortcut=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"Caps.lnk");
        if(File.Exists(shortcut))File.Delete(shortcut);
        Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Caps",false);
        File.Delete(Path.Combine(root,"installed-files.txt"));
        if(Directory.GetFileSystemEntries(root).Length==0)Directory.Delete(root);
    }
}

sealed class UninstallerWindow:Form {
    readonly string preview;
    readonly Label heading,description,status,note;
    readonly CapsButton primary,secondary;
    readonly CapsProgress progress;
    readonly TextBox details,folder;
    bool busy,complete;
    [DllImport("dwmapi.dll")]static extern int DwmSetWindowAttribute(IntPtr window,int attr,ref int value,int size);
    internal UninstallerWindow(string state) {
        preview=state;Text=state==null?"Uninstall Caps":"Uninstall Caps - Preview";
        AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;ClientSize=new Size(640,504);
        BackColor=Skin.Ground;ForeColor=Skin.Text;Font=Skin.Font(14);FormBorderStyle=FormBorderStyle.FixedSingle;
        MaximizeBox=false;StartPosition=FormStartPosition.CenterScreen;
        Icon=Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
        AddImage("caps-icon.png",new Rectangle(32,24,38,38));
        LabelAt(this,"Caps",82,20,240,30,24,Skin.Text,FontStyle.Bold);
        LabelAt(this,"Windows uninstall",83,51,260,22,12,Skin.Muted);
        var version=LabelAt(this,InstallerIdentity.Version,420,32,188,24,12,Skin.Muted);version.TextAlign=ContentAlignment.MiddleRight;
        Controls.Add(new Panel{Bounds=new Rectangle(32,88,576,1),BackColor=Skin.Line});
        heading=LabelAt(this,"Uninstall Caps?",32,112,576,40,26,Skin.Text,FontStyle.Bold);
        description=LabelAt(this,"Remove the app and its bundled CPU and NVIDIA runtimes.\nClose Caps before continuing.",32,162,576,48,14,Skin.Muted);
        var card=new SurfacePanel{Bounds=new Rectangle(32,228,576,130)};Controls.Add(card);
        status=LabelAt(card,"Installation folder",16,14,544,24,13,Skin.Muted);
        folder=new TextBox{Bounds=new Rectangle(16,48,544,24),Text=UninstallProgram.Root,ReadOnly=true,
            BorderStyle=BorderStyle.None,BackColor=Skin.Surface,ForeColor=Skin.Text,Font=Skin.Font(14),AccessibleName="Installation folder"};card.Controls.Add(folder);
        progress=new CapsProgress{Bounds=new Rectangle(16,88,544,9),Visible=false,AccessibleName="Uninstall progress"};card.Controls.Add(progress);
        note=LabelAt(this,"Your settings, downloaded models, and caption files are kept.",32,375,576,32,12,Skin.Muted);
        details=new TextBox{Bounds=new Rectangle(16,42,544,72),Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Vertical,
            BorderStyle=BorderStyle.None,BackColor=Skin.Surface,ForeColor=Skin.Text,Font=Skin.Font(12),Visible=false,AccessibleName="Uninstall error details"};card.Controls.Add(details);
        Controls.Add(new Panel{Bounds=new Rectangle(32,421,576,1),BackColor=Skin.Line});
        AddImage("github-mark.png",new Rectangle(32,448,18,18));LabelAt(this,InstallerIdentity.Publisher,58,445,254,24,12,Skin.Muted);
        secondary=new CapsButton(false){Bounds=new Rectangle(328,438,108,44),Text="Cancel",TabIndex=2};
        primary=new CapsButton(true){Bounds=new Rectangle(448,438,160,44),Text="Uninstall Caps",TabIndex=1};
        Controls.Add(secondary);Controls.Add(primary);AcceptButton=primary;CancelButton=secondary;
        primary.Click+=(s,e)=>{if(complete)Close();else if(preview!=null)Finish(null);else StartRemoval();};
        secondary.Click+=(s,e)=>Close();FormClosing+=(s,e)=>{if(busy)e.Cancel=true;};
        Shown+=(s,e)=>{secondary.Focus();if(preview=="complete")Finish(null);else if(preview=="error")Finish(new IOException("Close Caps and try again. A file is currently in use."));
            else if(preview=="remove"){SetBusy();progress.Indeterminate=false;progress.Value=.42;status.Text="Removing app files - 42%";}};
    }
    protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);try{int dark=1;DwmSetWindowAttribute(Handle,20,ref dark,sizeof(int));}catch(DllNotFoundException){}catch(EntryPointNotFoundException){}}
    void AddImage(string name,Rectangle bounds){var picture=new PictureBox{Bounds=bounds,SizeMode=PictureBoxSizeMode.Zoom,TabStop=false};
        using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream(name))using(var image=Image.FromStream(stream))picture.Image=new Bitmap(image);Controls.Add(picture);}
    static Label LabelAt(Control parent,string text,int x,int y,int w,int h,float size,Color color,FontStyle style=FontStyle.Regular){
        var label=new Label{Text=text,Bounds=new Rectangle(x,y,w,h),Font=Skin.Font(size,style),ForeColor=color,BackColor=parent is SurfacePanel?Skin.Surface:Skin.Ground,UseMnemonic=false};parent.Controls.Add(label);return label;}
    void SetBusy(){busy=preview==null;primary.Enabled=false;secondary.Enabled=false;details.Visible=false;folder.Visible=true;progress.Visible=true;progress.Value=0;progress.Indeterminate=true;progress.Active=true;
        heading.Text="Uninstalling Caps";description.Text="Removing the app and its bundled runtimes. This may take a few minutes.";status.Text="Checking installed files";}
    void StartRemoval(){SetBusy();Task.Factory.StartNew(()=>{Exception error=null;try{CapsRemoval.Remove((current,total)=>BeginInvoke((Action)(()=>{
        progress.Indeterminate=false;progress.Value=total==0?1:(double)current/total;status.Text="Removing app files - "+Math.Floor(progress.Value*100)+"%";})));}catch(Exception e){error=e;}
        BeginInvoke((Action)(()=>Finish(error)));});}
    void Finish(Exception error){busy=false;complete=error==null;progress.Active=false;progress.Indeterminate=false;primary.Enabled=true;secondary.Enabled=!complete;
        heading.Text=complete?"Caps was uninstalled":"Uninstall couldn't finish";
        description.Text=complete?"The app and its bundled runtimes have been removed.":"Close Caps and any tools using its files, then try again.";
        status.Text=complete?"Uninstall complete":"Some files could not be removed";
        primary.Text=complete?"Finish":"Try again";secondary.Text="Close";progress.Visible=complete;progress.Value=complete?1:0;
        if(error!=null){folder.Visible=false;details.Text=error.Message;details.Visible=true;details.BringToFront();}
        note.Text="Settings, downloaded models, and personal files remain in your Caps folder.";primary.Focus();}
}
