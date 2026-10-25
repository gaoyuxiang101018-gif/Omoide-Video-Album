param(
    [string]$Python = 'python',
    [Parameter(Mandatory=$true)][string]$Destination,
    [string]$BuildDirectory = (Join-Path $env:TEMP 'omoide-launcher-build')
)
$ErrorActionPreference = 'Stop'
$desktop = $PSScriptRoot
& $Python -m PyInstaller --noconfirm --clean --onefile --windowed --name Omoide --distpath $Destination --workpath $BuildDirectory --specpath $BuildDirectory --paths $desktop --paths (Join-Path $desktop 'pocketfilm') (Join-Path $desktop 'portable_launcher.py')
if ($LASTEXITCODE -ne 0) { throw 'Launcher build failed' }
