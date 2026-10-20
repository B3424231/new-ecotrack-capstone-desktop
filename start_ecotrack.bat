@echo off
title EcoTrack Launcher

echo Cleaning up old processes...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*backend\app.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1

echo Starting Python Backend (SQLite3 Sensor Logs ^& ML Engine)...
if exist "venv\Scripts\python.exe" (
    start "EcoTrack Backend" cmd /k "venv\Scripts\python.exe backend\app.py"
) else (
    start "EcoTrack Backend" cmd /k "python backend\app.py"
)

echo Waiting for Python Backend initialization...
timeout /t 2 /nobreak >nul

echo.
echo Starting EcoTrack Frontend System...
call npm.cmd start

echo.
echo Closing EcoTrack Services...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*backend\app.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
