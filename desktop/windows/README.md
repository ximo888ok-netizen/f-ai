# F-AI Studio Windows 安装包

适用于 x64 版 Windows 10 和 Windows 11，运行需要 .NET Framework 4.6.2 或更高版本及 Microsoft Edge WebView2 Runtime。按当前 Windows 用户安装，开始菜单中打开 **F-AI Studio**。本机后端只监听 `127.0.0.1:18261`，随工作台窗口启动和关闭。首次启动可创建本地工作台账号，商品草稿、素材和运营台账等数据保存在 `%LOCALAPPDATA%\F-AI Studio\data`。卸载保留该目录和 WebView2 用户配置。桌面包包含 Node.js 和视频处理工具，打开本机工作台与导出已上传的 MP4 无需配置第三方账号。

## 构建

在 x64 Windows 上准备 PowerShell 7、.NET Framework 的 C# 编译器、NSIS 3、带 npm 的 Windows x64 Node.js 24 ZIP、Microsoft.Web.WebView2 NuGet 包及带 `libopenh264` 的 Windows x64 FFmpeg LGPL 构建。解压各依赖并按上游提供的信息核对完整性。WebView2 包需要包含 `lib/net462` 和 `runtimes/win-x64/native`。FFmpeg 需要包含 `bin/ffmpeg.exe`、`bin/ffprobe.exe` 及对应的 DLL。安装包内附带依赖的许可证和 FFmpeg 构建出处。

```powershell
$build = @{
    NodeDirectory  = 'C:\fai-build\node-win-x64'
    WebViewSdk     = 'C:\fai-build\webview2'
    MediaDirectory = 'C:\fai-build\ffmpeg-lgpl-win64'
    MediaSource    = 'https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases'
    MakeNsis       = 'C:\fai-build\nsis\makensis.exe'
    BuildDirectory = 'C:\fai-build\stage'
    OutputFile     = 'C:\fai-build\F-AI-Studio-Setup-x64.exe'
}
.\desktop\windows\Build-Installer.ps1 @build
```

将 `MediaSource` 替换为所使用的 FFmpeg 下载链接。使用全新的构建目录及目标文件。脚本按后端的锁文件安装依赖，并按工作台的 HTTP 路由打包前端运行文件。构建输出保存在源代码目录之外。安装包内含 `build-info.json`，记录源码提交、是否含有本地跟踪文件变更和构建时间。安装包旁边生成 SHA-256 校验文件。

可用 `F-AI-Studio-Setup-x64.exe /S` 静默安装。安装前先关闭正在运行的工作台。常规构建生成的安装包未做 Authenticode 签名。
