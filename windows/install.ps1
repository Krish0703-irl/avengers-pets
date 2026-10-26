# Installs Avengers Pets for the current user: copies it into your local app folder, adds
# Start menu and desktop shortcuts, can start it with Windows, then lets the heroes out.
# Run it through Install.bat. No administrator rights are needed.

$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA 'AvengersPets'
$script = Join-Path $dest 'AvengersPets.ps1'
$icon = Join-Path $dest 'avengers-pets.ico'
$conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
# conhost --headless runs PowerShell with no window at all, even where Windows Terminal is the default console.
$arguments = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""

Write-Host ''
Write-Host 'Installing Avengers Pets...' -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $source 'AvengersPets.ps1') $script -Force
Copy-Item (Join-Path $source 'avengers-pets.ico') $icon -Force
# Files from a downloaded zip are marked as coming from the internet; this copy is now trusted.
Unblock-File -Path $script, $icon -ErrorAction SilentlyContinue

$shell = New-Object -ComObject WScript.Shell
function New-PetShortcut([string]$path) {
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = $conhost
    $link.Arguments = $arguments
    $link.WorkingDirectory = $dest
    $link.IconLocation = $icon
    $link.Description = 'Avengers desktop pets'
    $link.Save()
}

New-PetShortcut (Join-Path ([Environment]::GetFolderPath('Programs')) 'Avengers Pets.lnk')
New-PetShortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Avengers Pets.lnk')
Write-Host 'Added Avengers Pets to your Start menu and desktop.'

$answer = Read-Host 'Start Avengers Pets automatically when you sign in to Windows? (y/N)'
if ($answer -match '^\s*(y|yes)\s*$') {
    New-PetShortcut (Join-Path ([Environment]::GetFolderPath('Startup')) 'Avengers Pets.lnk')
    Write-Host 'Avengers Pets will start when you sign in.'
}

Start-Process -FilePath $conhost -ArgumentList $arguments -WorkingDirectory $dest
Write-Host ''
Write-Host 'The heroes are out! Open Avengers Pets from the Start menu any time to choose who stays.' -ForegroundColor Green
