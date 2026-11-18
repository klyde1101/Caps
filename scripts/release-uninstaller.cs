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
    static void CheckPath(string root,string path,HashSet<string> visited = null) {
        if(!path.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))
            throw new IOException("An installed file path is outside the Caps folder.");
        InstalledPathCheck.Validate(path, visited);
    }
    // The caller supplies the fixed per-user install root; tests use isolated fixture roots.
    internal static void RemoveFiles(string root,Action<int,int> progress,Action<string,int,int> checking = null) {
        root=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        string manifest=Path.Combine(root,"installed-files.txt");
        var files=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        CheckPath(root,manifest);
        var entries = File.ReadAllLines(manifest);
        var visited = new HashSet<string>(StringComparer.Ordinal);
        int scanned = 0;
        foreach(string name in entries) {
            scanned++;
            if (checking != null && scanned % 128 == 0) checking("Checking installed paths",scanned,entries.Length);
            if(string.IsNullOrWhiteSpace(name))continue;
            if(Path.IsPathRooted(name))throw new IOException("Invalid installed file path.");
            string path=Path.GetFullPath(Path.Combine(root,name));CheckPath(root,path,visited);
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
        scanned = 0;
        foreach(string path in ordered) {
            if (checking != null && scanned % 128 == 0) checking("Checking for files in use",scanned,ordered.Count);
            scanned++;
            if(File.Exists(path))
            using(var probe=File.Open(path,FileMode.Open,FileAccess.ReadWrite,FileShare.None)){}
        }
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
    internal static void Remove(Action<int,int> progress,Action<string,int,int> checking) {
        string root=UninstallProgram.Root;
        RemoveFiles(root,progress,checking);
        string shortcut=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"Caps.lnk");
        if(File.Exists(shortcut))File.Delete(shortcut);
        Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Caps",false);
        File.Delete(Path.Combine(root,"installed-files.txt"));
        if(Directory.GetFileSystemEntries(root).Length==0)Directory.Delete(root);
    }
}

sealed class UninstallerWindow:SetupWindow {
    readonly SetupLayout layout;
    readonly string preview;
    readonly Label heading,description,status,note,percent,subtitle;
    readonly SetupSteps steps;
    readonly CapsButton primary,secondary;
    readonly CapsProgress progress;
    readonly TextBox details,folder;
    bool busy,complete;
    internal UninstallerWindow(string state):base("Uninstall Caps") {
        preview=state;
        layout=new SetupLayout(this,true,UninstallProgram.Root,"");
        heading=layout.Heading;description=layout.Description;status=layout.Stage;note=layout.Note;
        percent=layout.Percent;subtitle=layout.Part;steps=layout.Steps;steps.DownloadArrow=false;
        primary=layout.Primary;secondary=layout.Secondary;progress=layout.Progress;details=layout.ErrorDetails;folder=layout.Folder;
        AcceptButton=primary;CancelButton=secondary;
        primary.Click+=(s,e)=>{if(complete)Close();else if(preview!=null)Finish(null);else StartRemoval();};
        secondary.Click+=(s,e)=>Close();FormClosing+=(s,e)=>{if(busy)e.Cancel=true;};
        Shown+=(s,e)=>{if(preview=="complete")Finish(null);else if(preview=="error")Finish(new IOException("Close Caps and try again. A file is currently in use."));
            else if(preview=="remove"){SetBusy();progress.Indeterminate=false;progress.Value=.42;status.Text="Removing app files";percent.Text="42%";steps.Current=1;}};
    }
    void SetBusy(){busy=preview==null;primary.Enabled=false;secondary.Enabled=false;details.Visible=false;folder.Visible=false;progress.Visible=true;progress.Value=0;progress.Indeterminate=true;progress.Active=true;progress.Failed=false;steps.Current=0;percent.Text="";
        primary.Text="Uninstalling...";subtitle.Text="";
        heading.Text="Removing Caps";description.Text="Removing the app and its CPU and GPU speech tools.\nThis may take a few minutes.";status.Text="Checking installed files";}
    void StartRemoval(){SetBusy();Task.Factory.StartNew(()=>{Exception error=null;try{CapsRemoval.Remove((current,total)=>BeginInvoke((Action)(()=>{
        progress.Indeterminate=false;progress.Value=total==0?1:(double)current/total;status.Text="Removing app files";percent.Text=Math.Floor(progress.Value*100)+"%";steps.Current=1;})), (message,current,total)=>BeginInvoke((Action)(()=>{
            status.Text=message; progress.Indeterminate=false; progress.Value=(double)current/total; percent.Text=Math.Floor(progress.Value*100)+"%";
        })));}catch(Exception e){error=e;}
        BeginInvoke((Action)(()=>Finish(error)));});}
    void Finish(Exception error){busy=false;complete=error==null;progress.Active=false;progress.Indeterminate=false;primary.Enabled=true;secondary.Enabled=!complete;
        heading.Text=complete?"Caps was uninstalled":"Something went wrong";
        description.Text=complete?"The app and its bundled runtimes have been removed.":"Close Caps and any tools using its files, then try again.";
        status.Text=complete?"Uninstall complete":"Some files could not be removed";
        primary.Text=complete?"Finish":"Try again";secondary.Text="Close";progress.Visible=true;progress.Value=complete?1:0;folder.Visible=false;
        percent.Text=complete?"100%":"";subtitle.Text="";steps.Current=complete?3:steps.Current;progress.Failed=!complete;
        if(error!=null){details.Text=error.Message;details.Visible=true;details.BringToFront();}
        note.Text="Your settings, downloaded models, and caption files are kept.";primary.Focus();}
}
