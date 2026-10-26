# Run from the checked-out Desktop folder with a trusted Python 3.11+ installation.
# Does not relax PowerShell execution policy, elevate privileges or embed keys.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if (-not $env:LOCALAPPDATA) { throw 'This installer requires Windows.' }
$gdPython = (Get-Command python.exe -ErrorAction Stop).Source
& $gdPython -c 'import sys,tkinter; assert sys.version_info[:2] == (3, 13), "Python 3.13 and tkinter are required"'
if ($LASTEXITCODE -ne 0) { throw 'Python version validation failed.' }
$gdDestination = Join-Path $env:LOCALAPPDATA 'GenDragoon\Companion'
New-Item -ItemType Directory -Path $gdDestination -Force | Out-Null
if ((Get-Item $gdDestination).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation path is a link or junction; inspect it first.' }
if ((Test-Path (Join-Path $gdDestination 'venv')) -and ((Get-Item (Join-Path $gdDestination 'venv')).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Private environment is a link or junction; inspect it first.' }
& $gdPython -B (Join-Path $PSScriptRoot 'gendragoon_gui.py') --check-idle
if ($LASTEXITCODE -ne 0) { throw 'Close the desktop client before installing.' }
& $gdPython -B (Join-Path $PSScriptRoot 'stage_runtime.py') --destination $gdDestination
if ($LASTEXITCODE -ne 0) { throw 'Pinned desktop codec did not build.' }
& $gdPython -m venv (Join-Path $gdDestination 'venv')
if ($LASTEXITCODE -ne 0) { throw 'Private desktop environment could not be created.' }
$gdRuntimePython = Join-Path $gdDestination 'venv\Scripts\python.exe'
& $gdRuntimePython -B -m pip install --disable-pip-version-check --only-binary=:all: -r (Join-Path $gdDestination 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Desktop runtime dependency installation failed.' }
& $gdRuntimePython -B -m pip install --disable-pip-version-check --only-binary=:all: -r (Join-Path $PSScriptRoot 'requirements-build.txt')
if ($LASTEXITCODE -ne 0) { throw 'Native host build dependency installation failed.' }
& $gdRuntimePython -B (Join-Path $PSScriptRoot 'build_windows_host.py') --destination $gdDestination
if ($LASTEXITCODE -ne 0) { throw 'Windows native messaging host did not build.' }
$gdWrapper = Join-Path $gdDestination 'gendragoon.cmd'
Set-Content -Encoding ASCII -Path $gdWrapper -Value ('@echo off' + "`r`n" + '"' + $gdRuntimePython + '" -B "%~dp0gendragoon_gui.py" %*')
& $gdRuntimePython -B (Join-Path $gdDestination 'gendragoon_gui.py') --check
if ($LASTEXITCODE -ne 0) { throw 'Installed companion capability check failed.' }
Write-Output "Installed: $gdWrapper"
Write-Output 'Run the command above to open Files and Teams. Browser approval and portable vault import happen inside the app.'
