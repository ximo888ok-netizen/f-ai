# Run on the GitHub-hosted Windows runner from backend/.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$downloads = Join-Path $env:RUNNER_TEMP 'offline-inputs'
$dist = Join-Path $env:RUNNER_TEMP 'backend-delivery'
New-Item -ItemType Directory -Path $downloads | Out-Null

function Get-Distribution([string]$Url, [string]$Name, [string]$Sha256) {
    $file = Join-Path $downloads $Name
    curl.exe --fail --location --silent --show-error --retry 3 --output $file $Url
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $Sha256) {
        throw "Unexpected digest for $Name"
    }
    return $file
}

$nodeZip = Get-Distribution 'https://nodejs.org/dist/v24.16.0/node-v24.16.0-win-x64.zip' 'node.zip' 'edaca9bd58ec8e92037dac4e877d52f6b8f430b81c18b57e264b4e2fb111cd56'
$env:FAI_PG_DIST_ARCHIVE = Get-Distribution 'https://get.enterprisedb.com/postgresql/postgresql-18.7-1-windows-x64-binaries.zip' 'postgres.zip' 'ead0bbc27fb678fa24dcf86b738981323042abd073c744103bf7f3aed23f9a33'
$ffmpegDist = 'ffmpeg-n9.0.2-61-gd59078794d-win64-lgpl-shared-9.0'
$env:FAI_FFMPEG_SOURCE = "https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/autobuild-2026-11-21-12-37/$ffmpegDist.zip"
$mediaZip = Get-Distribution $env:FAI_FFMPEG_SOURCE 'media.zip' '499fa5e468f9ea6a4d38647f81f9ca4a9ac33655f30faf54b7a800ca9f4d6e5f'
tar -xf $nodeZip -C $downloads
tar -xf $mediaZip -C $downloads
$env:FAI_NODE_DIST = Join-Path $downloads 'node-v24.16.0-win-x64'
$env:VIDEO_FFMPEG_PATH = Join-Path $downloads "$ffmpegDist/bin/ffmpeg.exe"
$env:FAI_QA_NPM_CACHE = Join-Path $env:RUNNER_TEMP 'backend-npm-cache'
npm.cmd ci --omit=dev --no-audit --no-fund --cache $env:FAI_QA_NPM_CACHE
$release = (npm.cmd run --silent release:offline -- $dist | Out-String | ConvertFrom-Json)
if ($release.revision -ne $env:GITHUB_SHA) { throw 'Archive revision differs from the tested commit' }
$env:FAI_QA_OFFLINE_ARCHIVE = $release.archive
$env:FAI_QA_OFFLINE_SHA256 = $release.sha256
$env:FAI_QA_OFFLINE_MANIFEST_SHA256 = $release.manifestSha256
npm.cmd run --silent accept:deployment
@(
    "Verified Windows x64 offline package for $($release.revision)"
    ""
    "Archive SHA-256: $($release.sha256)"
    ""
    "Manifest SHA-256: $($release.manifestSha256)"
) | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY
Write-Output "Archive SHA-256: $($release.sha256)"
Write-Output "Manifest SHA-256: $($release.manifestSha256)"
