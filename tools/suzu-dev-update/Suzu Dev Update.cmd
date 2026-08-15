@echo off
setlocal EnableExtensions

if not exist "%~dp0suzu-dev-update.ps1" (
  echo Missing suzu-dev-update.ps1. Keep both files in the same folder.
  echo.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0suzu-dev-update.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  pause
)

exit /b %EXIT_CODE%
