@echo off
rem Same as "Start Avengers Pets.bat" but keeps this window open, so you can see any error message.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0AvengersPets.ps1"
echo.
echo Avengers Pets has stopped. If something went wrong, the message is above.
pause
