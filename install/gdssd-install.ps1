# Run in PowerShell: powershell -ExecutionPolicy Bypass -File .\gdssd-install.ps1
# Windows requires a trusted SHA-256 manifest next to the published installer.
$ErrorActionPreference = 'Stop'
$base = if ($env:GDSSD_RELEASE_BASE) { $env:GDSSD_RELEASE_BASE } else { 'https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/releases/latest/download' }
if (-not $base.StartsWith('https://')) { throw 'HTTPS release URL required' }
$arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'ARM64' {'arm64'} 'AMD64' {'x64'} default {throw 'Unsupported CPU'} }
$temp = Join-Path $env:TEMP ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $filename = "gdssd-windows-$arch.exe"
  $installer = Join-Path $temp $filename
  Invoke-WebRequest "$base/$filename" -OutFile $installer
  $expectedFile = Join-Path $temp "$filename.sha256"
  Invoke-WebRequest "$base/$filename.sha256" -OutFile $expectedFile
  $expected = ((Get-Content $expectedFile -Raw).Trim() -split '\s+')[0]
  if ($expected -notmatch '^[0-9a-fA-F]{64}$') { throw 'Invalid SHA-256 manifest' }
  $actual = (Get-FileHash -Algorithm SHA256 $installer).Hash
  if ($actual -ne $expected) { throw 'Installer hash mismatch' }
  $signature = Get-AuthenticodeSignature $installer
  if ($signature.Status -ne 'Valid') { throw "Installer must be authenticode signed: $($signature.Status)" }
  Start-Process -FilePath $installer -Wait
  Write-Host 'Installer exited. Verify GenDragoon is installed before continuing.'
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
