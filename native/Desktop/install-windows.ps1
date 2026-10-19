# Run from the checked-out Desktop folder with a trusted Python 3.11+ installation.
# Does not relax PowerShell execution policy, elevate privileges or embed keys.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if (-not $env:LOCALAPPDATA) { throw 'This installer requires Windows.' }
$gdPython = (Get-Command python.exe -ErrorAction Stop).Source
& $gdPython -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11 or newer is required"'
if ($LASTEXITCODE -ne 0) { throw 'Python version validation failed.' }
$gdDestination = Join-Path $env:LOCALAPPDATA 'GenDragoon\Companion'
New-Item -ItemType Directory -Path $gdDestination -Force | Out-Null
if ((Get-Item $gdDestination).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation path is a link or junction; inspect it first.' }
$gdCode = Join-Path $gdDestination 'gendragoon_desktop.py'
Copy-Item (Join-Path $PSScriptRoot 'gendragoon_desktop.py') "$gdCode.new" -Force
& $gdPython -m py_compile "$gdCode.new"
if ($LASTEXITCODE -ne 0) { Remove-Item "$gdCode.new"; throw 'Companion code did not validate.' }
Move-Item "$gdCode.new" $gdCode -Force
$gdWrapper = Join-Path $gdDestination 'gendragoon.cmd'
Set-Content -Encoding ASCII -Path $gdWrapper -Value ('@echo off' + "`r`n" + '"' + $gdPython + '" "%~dp0gendragoon_desktop.py" %*')
& $gdPython $gdCode capabilities
if ($LASTEXITCODE -ne 0) { throw 'Installed companion capability check failed.' }
Write-Output "Installed: $gdWrapper"
Write-Output 'Use the full command path above. Credentials are entered in a hidden prompt, never command arguments.'
