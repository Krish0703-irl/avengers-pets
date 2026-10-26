# Removes Avengers Pets: puts the heroes away, then deletes the app, its shortcuts and its
# saved settings. Run it through Uninstall.bat.

$dest = Join-Path $env:LOCALAPPDATA 'AvengersPets'

Write-Host ''
Write-Host 'Removing Avengers Pets...' -ForegroundColor Cyan

# Put away a running copy.
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*AvengersPets.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

foreach ($folder in 'Programs', 'Desktop', 'Startup') {
    $link = Join-Path ([Environment]::GetFolderPath($folder)) 'Avengers Pets.lnk'
    if (Test-Path $link) { Remove-Item $link -Force }
}
Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:APPDATA 'AvengersPets') -Recurse -Force -ErrorAction SilentlyContinue

Write-Host 'Avengers Pets has been removed.' -ForegroundColor Green
