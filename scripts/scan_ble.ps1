# EcoTrack Native BLE Scanner Script
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$scannerExe = Join-Path $PSScriptRoot "ble_scanner.exe"

if (Test-Path $scannerExe) {
    & $scannerExe 3
} else {
    Write-Error "ble_scanner.exe not found at $scannerExe"
}
