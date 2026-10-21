@echo off
REM Bootstrap from Windows CMD after downloading the official scripts to the same directory.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0gdssd-install.ps1"
exit /b %ERRORLEVEL%
