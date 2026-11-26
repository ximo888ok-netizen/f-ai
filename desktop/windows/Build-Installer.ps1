#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$NodeDirectory,
    [Parameter(Mandatory)][string]$WebViewSdk,
    [Parameter(Mandatory)][string]$MediaDirectory,
    [Parameter(Mandatory)][uri]$MediaSource,
    [Parameter(Mandatory)][string]$MakeNsis,
    [Parameter(Mandatory)][string]$BuildDirectory,
    [Parameter(Mandatory)][string]$OutputFile
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$backend = Join-Path $repo 'backend'
$revision = (git -C $repo rev-parse --verify HEAD)
if ($LASTEXITCODE -or $revision -notmatch '^[a-f0-9]{40}$') { throw 'Could not read the source revision' }
git -C $repo diff --quiet HEAD
if ($LASTEXITCODE -gt 1) { throw 'Could not inspect the source tree' }
$modified = $LASTEXITCODE -eq 1
$tracked = @(git -C $repo -c core.quotePath=false ls-files)
if ($LASTEXITCODE) { throw 'Could not enumerate tracked sources' }
$output = [IO.Path]::GetFullPath($OutputFile)
$build = [IO.Path]::GetFullPath($BuildDirectory)
$prefix = $repo.TrimEnd('\') + '\'
foreach ($path in @($output, $build)) {
    if ($path.Equals($repo, 'OrdinalIgnoreCase') -or $path.StartsWith($prefix, 'OrdinalIgnoreCase')) {
        throw 'Choose build and output paths outside the source checkout.'
    }
}
if ((Test-Path -LiteralPath $build) -or (Test-Path -LiteralPath $output)) {
    throw 'Choose a new build directory and output file.'
}
if ($MediaSource.Scheme -ne 'https') { throw 'Provide the HTTPS release URL of the matching LGPL FFmpeg build.' }

$payload = Join-Path $build 'payload'
$app = Join-Path $payload 'app'
$target = Join-Path $app 'backend'
$media = Join-Path $app 'media'
$licenses = Join-Path $payload 'licenses'
New-Item -ItemType Directory -Path $target,$media,$licenses,(Split-Path -Parent $output) -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $backend 'package.json'),(Join-Path $backend 'package-lock.json') -Destination $target
foreach ($folder in @('src','migrations','integrations')) {
    $subdirectory = New-Item -ItemType Directory -Path (Join-Path $target $folder)
    $extension = if ($folder -eq 'src') { '*.js' } elseif ($folder -eq 'integrations') { '*.py' } else { '*.sql' }
    $tracked | Where-Object { $_ -like "backend/$folder/$extension" } | ForEach-Object {
        Copy-Item -LiteralPath (Join-Path $repo $_) -Destination $subdirectory.FullName
    }
}

# The versioned help endpoint reads this guide from the source directory.
$help = New-Item -ItemType Directory -Path (Join-Path $target 'src/help')
Copy-Item -LiteralPath (Join-Path $backend 'src/help/workbench-v1.md') -Destination $help.FullName

# Include only files served by the workbench.
$runtime = Join-Path $target 'media-runtime'
New-Item -ItemType Directory -Force (Join-Path $runtime 'aidge') | Out-Null
foreach ($file in @('prepare.mjs','Dockerfile','README.md','aidge/SKILL.md','aidge/run.py')) {
    Copy-Item -LiteralPath (Join-Path $backend "media-runtime/$file") -Destination (Join-Path $runtime $file)
}
$studio = '前端设计审查'
$root = Join-Path $app $studio
New-Item -ItemType Directory -Path (Join-Path $root 'assets') -Force | Out-Null
$routes = Get-Content -LiteralPath (Join-Path $backend 'src/studio.js') -Raw
$files = [regex]::Matches($routes, "'((?:[\w-]+/)*[^'/]+\.(?:js|css|html))'") | ForEach-Object { $_.Groups[1].Value }
foreach ($file in ($files | Sort-Object -Unique)) {
    if ($tracked -notcontains "$studio/$file") { throw "Untracked workbench file $file" }
    $destination = Join-Path $root $file
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path (Join-Path $repo $studio) $file) -Destination $destination
}
foreach ($file in @('optic-wave.webp', 'leather.webp', 'citrus.webp', 'audio.webp')) {
    if ($tracked -notcontains "$studio/assets/$file") { throw "Untracked workbench image $file" }
    Copy-Item -LiteralPath (Join-Path $repo "$studio/assets/$file") -Destination (Join-Path $root 'assets')
}

Copy-Item -LiteralPath (Join-Path $NodeDirectory 'node.exe') -Destination $app
Copy-Item -LiteralPath (Join-Path $NodeDirectory 'LICENSE') -Destination (Join-Path $licenses 'Node.txt')
$node = Join-Path $app 'node.exe'
$npm = Join-Path $NodeDirectory 'node_modules/npm/bin/npm-cli.js'
Push-Location $target
try {
    & $node $npm ci --include=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE) { throw 'npm ci failed' }
    & $node --input-type=module -e "await import('@napi-rs/canvas'); await import('@electric-sql/pglite');"
    if ($LASTEXITCODE) { throw 'A bundled runtime dependency failed to load' }
} finally { Pop-Location }

foreach ($file in @('ffmpeg.exe','ffprobe.exe')) {
    Copy-Item -LiteralPath (Join-Path $MediaDirectory "bin/$file") -Destination $media
}
Get-ChildItem -LiteralPath (Join-Path $MediaDirectory 'bin') -Filter '*.dll' -File | Copy-Item -Destination $media
$encoderHelp = & (Join-Path $media 'ffmpeg.exe') -hide_banner -encoders 2>&1 | Out-String
if ($LASTEXITCODE -or $encoderHelp -notmatch '\blibopenh264\b' -or $encoderHelp -match '\blibx264\b') {
    throw 'A Windows x64 LGPL FFmpeg build with libopenh264 is required.'
}
Copy-Item -LiteralPath (Join-Path $MediaDirectory 'LICENSE.txt') -Destination (Join-Path $licenses 'FFmpeg.txt')
@"
FFmpeg Windows binaries: $MediaSource
Build recipes and source references: https://github.com/BtbN/FFmpeg-Builds
FFmpeg LGPL information and source: https://ffmpeg.org/legal.html
OpenH264 source and license: https://github.com/cisco/openh264
"@ | Set-Content -LiteralPath (Join-Path $licenses 'Media-source.txt') -Encoding utf8

foreach ($file in @('Core','WinForms')) {
    Copy-Item -LiteralPath (Join-Path $WebViewSdk "lib/net462/Microsoft.Web.WebView2.$file.dll") -Destination $payload
}
Copy-Item -LiteralPath (Join-Path $WebViewSdk 'runtimes/win-x64/native/WebView2Loader.dll') -Destination $payload
Copy-Item -LiteralPath (Join-Path $WebViewSdk 'LICENSE.txt') -Destination (Join-Path $licenses 'WebView2.txt')
Copy-Item -LiteralPath (Join-Path $WebViewSdk 'NOTICE.txt') -Destination (Join-Path $licenses 'WebView2-notice.txt')
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$launcher = Join-Path $payload 'F-AI Studio.exe'
$references = @(
    '/reference:System.Windows.Forms.dll'
    '/reference:System.Drawing.dll'
    "/reference:$payload\Microsoft.Web.WebView2.Core.dll"
    "/reference:$payload\Microsoft.Web.WebView2.WinForms.dll"
)
& $csc /nologo /codepage:65001 /target:winexe /platform:x64 "/out:$launcher" @references (Join-Path $PSScriptRoot 'Studio.cs')
if ($LASTEXITCODE) { throw 'Desktop launcher compilation failed' }

$version = (Get-Content -LiteralPath (Join-Path $backend 'package.json') -Raw | ConvertFrom-Json).version
[ordered]@{
    version = $version
    sourceCommit = $revision
    trackedSourceModified = $modified
    builtAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    nodeVersion = (& $node --version)
    ffmpegRelease = $MediaSource.AbsoluteUri
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $payload 'build-info.json') -Encoding utf8

# Uninstall the exact packaged files and empty directories, preserving the local workspace.
$uninstall = Join-Path $build 'uninstall-files.nsh'
$commands = foreach ($entry in (Get-ChildItem -LiteralPath $payload -Force -Recurse | Sort-Object {$_.FullName.Length} -Descending)) {
    $name = [IO.Path]::GetRelativePath($payload,$entry.FullName).Replace('$','$$')
    $verb = if ($entry.PSIsContainer) {'RMDir'} else {'Delete'}
    $verb+' "$INSTDIR\'+$name+'"'
}
$commands | Set-Content -LiteralPath $uninstall -Encoding utf8
$definitions = @("/DVERSION=$version", "/DOUTPUT_FILE=$output", "/DPAYLOAD_DIR=$payload", "/DUNINSTALL_FILES=$uninstall")
& $MakeNsis /V3 /INPUTCHARSET UTF8 @definitions (Join-Path $PSScriptRoot 'Studio.nsi')
if ($LASTEXITCODE -or !(Test-Path -LiteralPath $output)) { throw 'Installer compilation failed' }
Get-Item -LiteralPath $output
$hash = Get-FileHash -LiteralPath $output -Algorithm SHA256
$hash.Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($output) |
    Set-Content -LiteralPath ($output + '.sha256') -Encoding ascii
$hash
