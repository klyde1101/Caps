using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("Caps")]
[assembly: AssemblyProduct("Caps")]
[assembly: AssemblyDescription("Caps folder launcher")]
[assembly: AssemblyCompany("klyde1101")]
[assembly: AssemblyVersion("1.0.0.0")]

internal static class CapsLauncher
{
    // Quote arguments according to Windows CommandLineToArgvW rules; no shell is involved.
    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(character); slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }

    [STAThread]
    private static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string log = Path.Combine(root, "data", "launch.log");
        try
        {
            string relativeFolder;
            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("Caps.AppDirectory"))
            using (var reader = new StreamReader(resource)) relativeFolder = reader.ReadToEnd().Trim();
            string folder = Path.GetFullPath(Path.Combine(root, relativeFolder));
            string distPrefix = Path.GetFullPath(Path.Combine(root, "dist")) + Path.DirectorySeparatorChar;
            if (!folder.StartsWith(distPrefix, StringComparison.OrdinalIgnoreCase))
                throw new IOException("The Caps launcher contains an invalid runtime directory.");
            string[] required = { "Caps.exe", "icudtl.dat", "resources.pak", "chrome_100_percent.pak",
                "chrome_200_percent.pak", "snapshot_blob.bin", "v8_context_snapshot.bin", "ffmpeg.dll",
                "d3dcompiler_47.dll", "dxcompiler.dll", "dxil.dll", "vk_swiftshader.dll",
                "vk_swiftshader_icd.json", "vulkan-1.dll", "locales/en-US.pak", "resources/app.asar" };
            foreach (string name in required)
            {
                var file = new FileInfo(Path.Combine(folder, name));
                if (!file.Exists || file.Length == 0)
                    throw new IOException("The Caps runtime is incomplete: " + name + " is missing.\nKeep the complete dist folder beside Caps.exe.");
            }
            Directory.CreateDirectory(Path.GetDirectoryName(log));
            var arguments = new StringBuilder("--enable-logging ");
            arguments.Append(Quote("--log-file=" + log));
            string dumps = Path.Combine(root, "data", "crashes");
            Directory.CreateDirectory(dumps);
            arguments.Append(" " + Quote("--crash-dumps-dir=" + dumps));
            foreach (string argument in args) { arguments.Append(' '); arguments.Append(Quote(argument)); }
            var start = new ProcessStartInfo(Path.Combine(folder, "Caps.exe"), arguments.ToString());
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.EnvironmentVariables["PORTABLE_EXECUTABLE_DIR"] = root;
            start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            string ready = Path.Combine(root, "data", "startup-" + Guid.NewGuid().ToString("N") + ".ready");
            start.EnvironmentVariables["CAPS_READY_FILE"] = ready;
            using (Process child = Process.Start(start))
            {
                if (child == null) throw new IOException("Windows could not start Caps.");
                var deadline = DateTime.UtcNow.AddSeconds(30);
                try {
                    while (!File.Exists(ready)) {
                        if (child.WaitForExit(100)) {
                            if (child.ExitCode != 0) throw new IOException("Caps exited with code " + child.ExitCode + ".\nStartup log: " + log);
                            return 0;
                        }
                        if (DateTime.UtcNow >= deadline) throw new IOException("Caps did not report ready within 30 seconds.\nStartup logs: " + Path.Combine(root, "data"));
                    }
                } finally { if (File.Exists(ready)) File.Delete(ready); }
                return 0;
            }
        }
        catch (Exception error)
        {
            try { Directory.CreateDirectory(Path.GetDirectoryName(log)); File.AppendAllText(log, DateTime.Now.ToString("s") + " " + error.Message + Environment.NewLine); }
            catch { /* A read-only location should still show the startup error. */ }
            MessageBox.Show(error.Message, "Caps could not start", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
