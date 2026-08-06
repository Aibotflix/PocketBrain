param(
  [Parameter(Mandatory = $true)][string]$Zip,
  [Parameter(Mandatory = $true)][string]$Dest
)
# Fast zip extraction with a real progress bar. Uses System.IO.Compression
# (5-10x faster than Expand-Archive). FAT/exFAT USB sticks can't restore some
# archive timestamps - skip any entry that errors instead of dying.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$archive = [System.IO.Compression.ZipFile]::OpenRead($Zip)
try {
  $entries = @($archive.Entries)
  $count = $entries.Count
  $i = 0
  foreach ($e in $entries) {
    $i++
    $target = Join-Path $Dest $e.FullName
    if ($e.FullName.EndsWith('/')) {
      New-Item -ItemType Directory -Force -Path $target | Out-Null
      continue
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
    try {
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)
    } catch {
      Write-Host "  (skipped: $($e.FullName))"
    }
    Write-Progress -Activity "Extracting $(Split-Path $Zip -Leaf)" `
      -Status "$i / $count files" -PercentComplete (100 * $i / $count)
  }
  Write-Progress -Activity "Extracting $(Split-Path $Zip -Leaf)" -Completed
} finally {
  $archive.Dispose()
}
