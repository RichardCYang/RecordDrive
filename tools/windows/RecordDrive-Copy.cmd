@echo off
setlocal
if "%~2"=="" (
  echo Usage: RecordDrive-Copy.cmd "SOURCE" "\\SERVER\recorddrive-ID\DESTINATION"
  exit /b 2
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0RecordDrive-Copy.ps1" -Source "%~1" -Destination "%~2"
exit /b %ERRORLEVEL%
