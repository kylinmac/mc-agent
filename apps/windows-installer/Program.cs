using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Interop;
using System.Windows.Media.Imaging;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Win32;
using Forms = System.Windows.Forms;

// The UI only installs the embedded, hash-checked NSIS payload. The app's
// updater still downloads NSIS directly and never runs this presentation UI.
internal sealed class Setup
{
    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    Window window;
    Dictionary<string, string> words;
    Dictionary<string, string> metadata;
    string destination;
    bool existing;
    bool busy;
    bool complete;
    bool preview;

    static Stream Resource(string name)
    {
        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        if (stream == null) throw new IOException("Missing installer resource: " + name);
        return stream;
    }
    static string ReadResource(string name)
    {
        using (var stream = Resource(name)) using (var reader = new StreamReader(stream)) return reader.ReadToEnd();
    }
    T Control<T>(string name) where T : FrameworkElement { return (T)window.FindName(name); }
    string Text(string key) { return words[key]; }
    void Label(string name, string key) { Control<TextBlock>(name).Text = Text(key); }
    void Button(string name, string key) { Control<Button>(name).Content = Text(key); }

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
#if INSTALLER_TEST
            var validatePath = args.FirstOrDefault(arg => arg.StartsWith("--test-validate-path="));
            if (validatePath != null) return ValidDestination(validatePath.Substring("--test-validate-path=".Length)) ? 0 : 1;
#endif
            var identity = new JavaScriptSerializer().Deserialize<Dictionary<string, string>>(ReadResource("metadata.json"));
            var key = identity["registryKey"].Split('\\').Last();
            using (var mutex = new Mutex(false, "Local\\mc-agent-setup-" + key + (args.Contains("--preview") ? "-preview" : "")))
            {
                bool held;
                try { held = mutex.WaitOne(0); } catch (AbandonedMutexException) { held = true; }
                if (!held) return 0;
                try { return new Setup().Run(args); } finally { mutex.ReleaseMutex(); }
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "mc-agent Setup", MessageBoxButton.OK, MessageBoxImage.Error);
            return 1;
        }
    }

    int Run(string[] args)
    {
        preview = args.Contains("--preview");
        var json = new JavaScriptSerializer();
        metadata = json.Deserialize<Dictionary<string, string>>(ReadResource("metadata.json"));
        bool chinese = CultureInfo.CurrentUICulture.Name.StartsWith("zh", StringComparison.OrdinalIgnoreCase);
        if (args.Contains("--lang=en")) chinese = false;
        if (args.Contains("--lang=zh-CN")) chinese = true;
        words = json.Deserialize<Dictionary<string, string>>(ReadResource(chinese ? "zh-CN.json" : "en.json"));
        // Read only this app's exact NSIS registry key; never discover by a
        // fuzzy display name or change the installation's user/machine scope.
        destination = FindExistingInstallation();
        existing = destination != null;
        if (!existing) destination = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", metadata["directory"]);
        var app = new Application();
        using (var stream = Resource("Window.xaml")) window = (Window)XamlReader.Load(stream);
        window.SourceInitialized += delegate
        {
            var handle = new WindowInteropHelper(window).Handle;
            int dark = 1;
            int result = DwmSetWindowAttribute(handle, 20, ref dark, sizeof(int));
            if (result != 0) Debug.WriteLine("Native dark title bar unavailable: " + result);
        };
        using (var stream = Resource("icon.png"))
        {
            var icon = new BitmapImage();
            icon.BeginInit(); icon.CacheOption = BitmapCacheOption.OnLoad; icon.StreamSource = stream; icon.EndInit(); icon.Freeze();
            Control<Image>("BrandIcon").Source = icon;
            window.Icon = icon;
        }
        Control<TextBlock>("Version").Text = "v" + metadata["version"] + "  ·  Windows";
        Label("Heading", "heading"); Label("Description", "description"); Label("LocationLabel", "location");
        Label("Status", existing ? "existing" : "hint");
        Button("Primary", "install"); Button("Secondary", "cancel"); Button("ChangeLocation", "change");
        UpdateLocation();
        Control<Button>("ChangeLocation").IsEnabled = !existing;
        Control<Button>("ChangeLocation").Click += delegate { ChooseLocation(); };
        Control<Button>("Secondary").Click += delegate { if (!busy) window.Close(); };
        Control<Button>("Primary").Click += async delegate
        {
            if (busy || preview) return;
            if (complete) { Launch(); return; }
            await Install();
        };
        window.Closing += delegate(object sender, System.ComponentModel.CancelEventArgs e) { e.Cancel = busy; };
        if (preview)
        {
            // Preview is side-effect free: no extraction, registry writes or
            // installation. Used for visual review of all presentation states.
            var state = args.FirstOrDefault(arg => arg.StartsWith("--state="));
            if (state == "--state=installing") ShowInstalling();
            if (state == "--state=ready") ShowReady();
            if (state == "--state=error") ShowError("Preview: installation could not complete.");
            Control<Button>("ChangeLocation").IsEnabled = false;
        }
#if INSTALLER_TEST
        // Only compiled into the disposable integration fixture, never Setup.
        var testTarget = args.FirstOrDefault(arg => arg.StartsWith("--test-install="));
        if (testTarget != null)
        {
            if (args.Contains("--test-bad-checksum")) metadata["sha512"] = "invalid";
            if (testTarget != "--test-install=existing") destination = testTarget.Substring("--test-install=".Length);
            else if (!existing) throw new IOException("Expected an existing installation");
            UpdateLocation();
            window.Loaded += async delegate
            {
                await Install();
                if (complete) Launch();
                else app.Shutdown(1);
            };
        }
        var testRender = args.FirstOrDefault(arg => arg.StartsWith("--test-render="));
        if (preview && testRender != null)
        {
            window.ShowActivated = false;
            window.ShowInTaskbar = false;
            window.Left = -10000;
            window.Top = -10000;
            window.WindowStartupLocation = WindowStartupLocation.Manual;
            window.Loaded += delegate
            {
                window.Dispatcher.BeginInvoke(new Action(delegate
                {
                    window.UpdateLayout();
                    double scale = args.Contains("--test-scale=2") ? 2 : 1;
                    var content = (FrameworkElement)window.Content;
                    var bitmap = new RenderTargetBitmap((int)Math.Ceiling(window.ActualWidth * scale), (int)Math.Ceiling(window.ActualHeight * scale), 96 * scale, 96 * scale, PixelFormats.Pbgra32);
                    bitmap.Render(window);
                    var encoder = new PngBitmapEncoder();
                    encoder.Frames.Add(BitmapFrame.Create(bitmap));
                    using (var output = File.Create(testRender.Substring("--test-render=".Length))) encoder.Save(output);
                    app.Shutdown();
                }), DispatcherPriority.ApplicationIdle);
            };
        }
#endif
        return app.Run(window);
    }

    string FindExistingInstallation()
    {
        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        {
            using (var root = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64))
            using (var key = root.OpenSubKey(metadata["registryKey"]))
            {
                var location = key == null ? null : key.GetValue("InstallLocation") as string;
                if (!String.IsNullOrWhiteSpace(location) && File.Exists(Path.Combine(location, metadata["executable"]))) return Path.GetFullPath(location);
            }
        }
        return null;
    }
    void UpdateLocation()
    {
        Control<TextBlock>("Location").Text = destination;
        Control<TextBlock>("Location").ToolTip = destination;
    }
    void ChooseLocation()
    {
        using (var picker = new Forms.FolderBrowserDialog())
        {
            picker.Description = Text("folder");
            picker.SelectedPath = Path.GetDirectoryName(destination);
            if (picker.ShowDialog() != Forms.DialogResult.OK) return;
            destination = Path.Combine(picker.SelectedPath, metadata["directory"]);
            UpdateLocation();
        }
    }
    static bool ValidDestination(string path)
    {
        if (String.IsNullOrWhiteSpace(path) || path.Length <= 3 || !Char.IsLetter(path[0]) || path[1] != ':' ||
            (path[2] != '\\' && path[2] != '/') || path.Any(c => Char.IsControl(c) || c == '"')) return false;
        try
        {
            string fullPath = Path.GetFullPath(path);
            return !String.Equals(Path.GetPathRoot(fullPath).TrimEnd('\\'), fullPath.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }
        catch (ArgumentException) { return false; }
        catch (NotSupportedException) { return false; }
        catch (PathTooLongException) { return false; }
    }
    void ShowInstalling()
    {
        Label("Heading", "installing"); Label("Description", "installingDescription"); Label("Status", "extracting");
        Control<Button>("Primary").IsEnabled = false;
        Control<Button>("Secondary").IsEnabled = false;
        Control<Button>("ChangeLocation").IsEnabled = false;
        Control<ProgressBar>("Progress").Visibility = Visibility.Visible;
        Control<ProgressBar>("Progress").IsIndeterminate = true;
    }
    void ShowReady()
    {
        Label("Heading", "ready"); Label("Description", "readyDescription");
        Control<TextBlock>("Status").Text = "";
        Control<ProgressBar>("Progress").Visibility = Visibility.Collapsed;
        Button("Primary", "open"); Button("Secondary", "close");
        Control<Button>("Primary").IsEnabled = true;
        Control<Button>("Secondary").IsEnabled = true;
    }
    void ShowError(string detail)
    {
        Label("Heading", "failed"); Label("Description", "failedDescription");
        Control<TextBlock>("Status").Text = detail;
        Control<ProgressBar>("Progress").Visibility = Visibility.Collapsed;
        Button("Primary", "retry"); Button("Secondary", "close");
        Control<Button>("Primary").IsEnabled = true;
        Control<Button>("Secondary").IsEnabled = true;
        Control<Button>("ChangeLocation").IsEnabled = !existing;
    }
    async Task Install()
    {
        if (!ValidDestination(destination)) { ShowError(Text("invalidPath")); return; }
        destination = Path.GetFullPath(destination);
        UpdateLocation();
        busy = true; ShowInstalling();
        string staging = Path.Combine(Path.GetTempPath(), "mc-agent-setup-" + Guid.NewGuid().ToString("N"));
        try
        {
            await Task.Run(delegate
            {
                Directory.CreateDirectory(staging);
                string payload = Path.Combine(staging, "install.exe");
                using (var input = Resource("payload.exe")) using (var output = new FileStream(payload, FileMode.CreateNew, FileAccess.Write, FileShare.None)) input.CopyTo(output);
                using (var file = File.OpenRead(payload)) using (var hash = SHA512.Create())
                    if (Convert.ToBase64String(hash.ComputeHash(file)) != metadata["sha512"]) throw new IOException("The installer checksum does not match. Download Setup again.");
                window.Dispatcher.Invoke(new Action(delegate { Label("Status", "copying"); }));
                // NSIS /D consumes the remainder verbatim; it must be last and
                // unquoted even for paths containing spaces. No shell is used.
                string args = existing ? "/S" : "/S /currentuser /D=" + destination;
                using (var process = Process.Start(new ProcessStartInfo(payload, args) { UseShellExecute = false, CreateNoWindow = true }))
                {
                    if (process == null) throw new IOException("Could not start the installer.");
                    process.WaitForExit();
                    if (process.ExitCode != 0) throw new IOException("Installer exited with code " + process.ExitCode + ".");
                }
                if (!File.Exists(Path.Combine(destination, metadata["executable"]))) throw new IOException("The installed application was not found at the selected location.");
            });
            complete = true; ShowReady();
        }
        catch (Exception error) { ShowError(error.Message); }
        finally
        {
            busy = false;
            // This path is created here with a random name, never from user
            // input or the installed program. Surface cleanup failures without
            // incorrectly reporting a successful installation as a failed one.
            try { if (Directory.Exists(staging)) Directory.Delete(staging, true); }
            catch (IOException error) { Control<TextBlock>("Status").Text += " " + Text("cleanupFailed") + " " + error.Message; }
            catch (UnauthorizedAccessException error) { Control<TextBlock>("Status").Text += " " + Text("cleanupFailed") + " " + error.Message; }
        }
    }
    void Launch()
    {
        try
        {
            Process.Start(new ProcessStartInfo(Path.Combine(destination, metadata["executable"])) { UseShellExecute = false, WorkingDirectory = destination });
            window.Close();
        }
        catch (Exception error) { Control<TextBlock>("Status").Text = Text("launchFailed") + " " + error.Message; }
    }
}
