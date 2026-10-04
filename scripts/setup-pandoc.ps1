param([string]$DestinationRoot = '')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $DestinationRoot) { $DestinationRoot = Join-Path $projectRoot '.tools/pandoc' }
$destination = [IO.Path]::GetFullPath($DestinationRoot)
if (-not $destination.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'DestinationRoot must be inside the Penlume project.'
}
$version = '3.12'
$archiveName = "pandoc-$version-windows-x86_64.zip"
$source = "https://github.com/jgm/pandoc/releases/download/$version/$archiveName"
$expectedHash = '2a77ebc2517d13e95056e76b1cd5b574cfe958ac61aa6058117d80c22ca19b79'
function Get-Sha256([string]$FilePath) {
  $stream = [IO.File]::OpenRead($FilePath)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $hash.Dispose() }
}
$archive = Join-Path $destination $archiveName
New-Item -ItemType Directory -Path $destination -Force | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
  $download = Join-Path $destination ($archiveName + '.download')
  Write-Host "Downloading Pandoc $version from the official release..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $client = New-Object Net.WebClient
  try { $client.DownloadFile($source, $download) } finally { $client.Dispose() }
  if ((Get-Sha256 $download) -ne $expectedHash) {
    throw 'Pandoc archive checksum mismatch. The download was not installed.'
  }
  Move-Item -LiteralPath $download -Destination $archive
}
if ((Get-Sha256 $archive) -ne $expectedHash) {
  throw 'Cached Pandoc archive checksum mismatch. Remove the invalid archive and retry.'
}

# Check each installed file against the verified archive, including on repeated runs.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  $required = @('pandoc.exe', 'COPYRIGHT.txt', 'COPYING.rtf', 'MANUAL.html')
  foreach ($name in $required) {
    $entry = $zip.GetEntry("pandoc-$version/$name")
    if (-not $entry) { throw "Required Pandoc resource missing from archive: $name" }
    $target = Join-Path $destination "pandoc-$version/$name"
    $entryStream = $entry.Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $archiveHash = [BitConverter]::ToString($sha.ComputeHash($entryStream)).Replace('-', '').ToLowerInvariant() }
    finally { $entryStream.Dispose(); $sha.Dispose() }
    if (Test-Path -LiteralPath $target) {
      if ((Get-Sha256 $target) -ne $archiveHash) {
        throw "Installed Pandoc resource differs from the verified archive: $target"
      }
    } else {
      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
  }
} finally { $zip.Dispose() }

$record = [ordered]@{ version = $version; source = $source; sha256 = $expectedHash; publishedDigest = "sha256:$expectedHash" }
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $destination 'provenance.json'), (($record | ConvertTo-Json) + "`n"), $utf8)
$pandocExe = Join-Path $destination "pandoc-$version/pandoc.exe"
$versionText = & $pandocExe --version
if ($LASTEXITCODE -ne 0 -or $versionText[0] -ne "pandoc $version") { throw 'Pandoc version check failed.' }
Write-Host "Ready: $pandocExe (SHA-256 verified archive; licenses and provenance included)."
