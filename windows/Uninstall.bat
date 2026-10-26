@echo off
rem Removes Avengers Pets, its shortcuts and its settings.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
pause
