using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program
{
    internal const string MutexName = @"Local\FAI.Studio.Desktop";
    internal static readonly string State = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "F-AI Studio");

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool first;
        using (var mutex = new Mutex(true, MutexName, out first))
        {
            if (!first)
            {
                MessageBox.Show("工作台已在运行。", "F-AI Studio");
                return;
            }

            try
            {
                Directory.CreateDirectory(State);
                using (var lease = new FileStream(Path.Combine(State, "desktop.lock"),
                    FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
                using (var window = new StudioWindow())
                {
                    Application.Run(window);
                }
            }
            catch (Exception error)
            {
                MessageBox.Show("无法启动工作台。\n" + error.Message, "F-AI Studio",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}

internal sealed class StudioWindow : Form
{
    private readonly Label status = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter,
        Text = "正在启动工作台…" };
    private readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill, Visible = false };
    private readonly Uri local = new Uri("http://127.0.0.1:18261/");
    private Process backend;
    private volatile bool stopping;

    internal StudioWindow()
    {
        Text = "F-AI Studio";
        Size = new Size(1360, 880);
        MinimumSize = new Size(840, 620);
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(status);
        Controls.Add(web);
        Shown += LoadWorkspace;
    }

    private async void LoadWorkspace(object sender, EventArgs args)
    {
        try
        {
            CoreWebView2Environment.GetAvailableBrowserVersionString();
            await StartBackend();
            if (IsDisposed) return;

            var profile = Path.Combine(Program.State, "browser");
            var environment = await CoreWebView2Environment.CreateAsync(null, profile, null);
            if (IsDisposed) return;

            await web.EnsureCoreWebView2Async(environment);
            if (IsDisposed) return;
            web.CoreWebView2.Settings.IsWebMessageEnabled = false;
            web.CoreWebView2.Settings.AreHostObjectsAllowed = false;
            web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            web.CoreWebView2.NavigationStarting += (origin, e) => {
                Uri target;
                e.Cancel = !Uri.TryCreate(e.Uri, UriKind.Absolute, out target) || !IsLocal(target);
            };
            web.CoreWebView2.NewWindowRequested += OpenExternal;
            web.CoreWebView2.NavigationCompleted += (origin, e) => {
                if (e.IsSuccess)
                {
                    web.Visible = true;
                    status.Visible = false;
                }
                else if (status.Visible && e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
                    ShowFailure("工作台页面加载失败。");
            };
            web.Source = local;
        }
        catch (WebView2RuntimeNotFoundException)
        {
            if (!IsDisposed) ShowFailure("请安装 Microsoft Edge WebView2 Runtime 后重新启动工作台。");
        }
        catch (Exception error)
        {
            if (!IsDisposed) ShowFailure(error.Message);
        }
    }

    private bool IsLocal(Uri target)
    {
        return target.Scheme == local.Scheme && target.Host == local.Host && target.Port == local.Port;
    }

    private void OpenExternal(object sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        Uri url;
        if (!e.IsUserInitiated || !Uri.TryCreate(e.Uri, UriKind.Absolute, out url) || url.Scheme != Uri.UriSchemeHttps)
            return;
        try { Process.Start(new ProcessStartInfo(url.AbsoluteUri) { UseShellExecute = true }); }
        catch (System.ComponentModel.Win32Exception error)
        {
            MessageBox.Show(this, error.Message, "F-AI Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async Task StartBackend()
    {
        string app = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app");
        string tools = Path.Combine(app, "media");
        var start = new ProcessStartInfo(Path.Combine(app, "node.exe"), @"src\local-studio.js") {
            WorkingDirectory = Path.Combine(app, "backend"),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.EnvironmentVariables.Remove("NODE_OPTIONS");
        start.EnvironmentVariables.Remove("NODE_PATH");
        start.EnvironmentVariables["FAI_DESKTOP_STATE_DIR"] = Path.Combine(Program.State, "data");
        start.EnvironmentVariables["FAI_LOCAL_STUDIO_PORT"] = local.Port.ToString();
        start.EnvironmentVariables["VIDEO_FFMPEG_PATH"] = Path.Combine(tools, "ffmpeg.exe");
        start.EnvironmentVariables["VIDEO_FFPROBE_PATH"] = Path.Combine(tools, "ffprobe.exe");
        start.EnvironmentVariables["VIDEO_EXPORT_ENCODER"] = "libopenh264";

        var ready = new TaskCompletionSource<bool>();
        backend = new Process { StartInfo = start, EnableRaisingEvents = true };
        backend.OutputDataReceived += (sender, e) => {
            if (e.Data == "Studio desktop ready at " + local.GetLeftPart(UriPartial.Authority))
                ready.TrySetResult(true);
        };
        backend.ErrorDataReceived += (sender, e) => {
            if (String.IsNullOrEmpty(e.Data)) return;
            try { File.AppendAllText(Path.Combine(Program.State, "studio.log"), e.Data + Environment.NewLine); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        };
        backend.Exited += (sender, e) => {
            if (!ready.TrySetResult(false) && !stopping)
            {
                try { BeginInvoke((Action)(() => ShowFailure("本地服务已停止。请重新打开工作台。"))); }
                catch (InvalidOperationException) { }
            }
        };
        if (!backend.Start()) throw new InvalidOperationException("无法启动本地服务。");
        backend.BeginOutputReadLine();
        backend.BeginErrorReadLine();

        if (await Task.WhenAny(ready.Task, Task.Delay(TimeSpan.FromSeconds(40))) != ready.Task || !await ready.Task)
            throw new InvalidOperationException("本地服务启动失败。请检查端口 18261 和日志。\n" +
                Path.Combine(Program.State, "studio.log"));
    }

    private void ShowFailure(string message)
    {
        StopBackend();
        web.Visible = false;
        status.Text = message;
        status.Visible = true;
    }

    private void StopBackend()
    {
        if (backend == null) return;
        stopping = true;
        try
        {
            if (!backend.HasExited)
            {
                backend.StandardInput.Close();
                backend.WaitForExit(15000);
            }
        }
        catch (InvalidOperationException) { }
        catch (IOException) { }
        finally { backend.Dispose(); backend = null; }
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        StopBackend();
        base.OnFormClosed(e);
    }
}
