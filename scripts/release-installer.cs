using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

class Setup {
    const string Key = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Caps";
    static Form progress;
    static string executable = Assembly.GetExecutingAssembly().Location;
    static string install = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\Caps");
    static string PowerShell { get { return Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"); } }
    static string Q(string path) { return "\"" + path + "\""; }
    static void Export(string resource, string dest) {
        using (Stream src = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource))
        using (Stream dst = File.Create(dest)) { src.CopyTo(dst); }
    }
    static void RunScript(string script, string work, string dest) {
        var start = new ProcessStartInfo(PowerShell, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Q(script));
        start.WorkingDirectory = work;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardError = true;
        start.EnvironmentVariables["CAPS_SETUP_DEST"] = dest;
        start.EnvironmentVariables["CAPS_SETUP_SOURCE"] = Path.GetDirectoryName(executable);
        using (var proc = Process.Start(start)) {
            var error = proc.StandardError.ReadToEndAsync();
            while (!proc.WaitForExit(200)) { if (progress != null) Application.DoEvents(); }
            if (proc.ExitCode != 0) throw new IOException("Could not verify or extract the Caps package. Check available disk space and the release downloads. " + error.Result);
        }
    }
    [STAThread]
    static int Main(string[] args) {
        bool verify = args.Length == 2 && args[0] == "--extract-to";
        string dest = verify ? Path.GetFullPath(args[1]) : install;
        if (!verify && MessageBox.Show("Install Caps for this Windows account?\n\n" + dest, "Caps Setup", MessageBoxButtons.OKCancel) != DialogResult.OK) return 0;
        string work = Path.Combine(Path.GetTempPath(), "CapsSetup-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        if (!verify) {
            progress = new Form { Text = "Installing Caps", Width = 410, Height = 118,
                StartPosition = FormStartPosition.CenterScreen, ControlBox = false, FormBorderStyle = FormBorderStyle.FixedDialog };
            progress.Controls.Add(new Label { Text = "Preparing and extracting Caps. This can take several minutes.", Left = 12, Top = 12, AutoSize = true });
            progress.Controls.Add(new ProgressBar { Left = 12, Top = 40, Width = 370, Style = ProgressBarStyle.Marquee });
            progress.Show();
            Application.DoEvents();
        }
        try {
            foreach (string file in new [] {"7za.exe", "payload.json", "install-release-payload.ps1"}) Export(file, Path.Combine(work,file));
            // A compact setup carries its verified archive as an overlay. Larger releases use downloadable volumes.
            using (var input = File.OpenRead(executable)) {
                input.Seek(-8, SeekOrigin.End);
                var reader = new BinaryReader(input);
                long bytes = reader.ReadInt64();
                if (bytes < 0 || bytes > input.Length - 8) throw new IOException("Damaged Caps installer.");
                if (bytes > 0) {
                    input.Seek(-8-bytes, SeekOrigin.End);
                    using (var output = File.Create(Path.Combine(work,"embedded.zip"))) {
                        byte[] buffer = new byte[1024*1024];
                        while (bytes > 0) {
                            int count = input.Read(buffer,0,(int)Math.Min(buffer.Length,bytes));
                            if (count == 0) throw new EndOfStreamException();
                            output.Write(buffer,0,count); bytes -= count;
                            if (progress != null) Application.DoEvents();
                        }
                    }
                }
            }
            RunScript(Path.Combine(work,"install-release-payload.ps1"),work,dest);
            if (verify) return 0;
            Export("uninstall.ps1",Path.Combine(dest,"Uninstall-Caps.ps1"));
            Export("installed-files.txt",Path.Combine(dest,"installed-files.txt"));
            string shortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),"Caps.lnk");
            Type type = Type.GetTypeFromProgID("WScript.Shell");
            dynamic shell = Activator.CreateInstance(type);
            dynamic link = shell.CreateShortcut(shortcut);
            link.TargetPath = Path.Combine(dest,"Caps.exe"); link.WorkingDirectory = dest; link.Save();
            using (var reg = Registry.CurrentUser.CreateSubKey(Key)) {
                reg.SetValue("DisplayName","Caps");
                reg.SetValue("DisplayVersion",Application.ProductVersion);
                reg.SetValue("DisplayIcon",Path.Combine(dest,"Caps.exe"));
                reg.SetValue("InstallLocation",dest);
                reg.SetValue("UninstallString",Q(PowerShell)+" -NoProfile -ExecutionPolicy Bypass -File "+Q(Path.Combine(dest,"Uninstall-Caps.ps1")));
            }
            MessageBox.Show("Caps is installed. Open Caps from Start, then download a model in Settings.","Caps Setup");
            return 0;
        } catch (Exception e) {
            if (!verify) MessageBox.Show(e.Message,"Caps Setup",MessageBoxButtons.OK,MessageBoxIcon.Error);
            else { Console.Error.WriteLine(e); File.WriteAllText(dest + ".setup-error.txt", e.ToString()); }
            return 1;
        } finally { if (progress != null) progress.Dispose(); try { Directory.Delete(work,true); } catch (IOException) {} }
    }
}
