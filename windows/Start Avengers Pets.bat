@echo off
rem Lets the heroes out without installing. Right-click any hero and choose "Put everyone away" to stop.
rem conhost --headless runs PowerShell with no window at all; older Windows falls back to a minimized one.
start "" conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0AvengersPets.ps1"
if errorlevel 1 start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0AvengersPets.ps1"
exit
