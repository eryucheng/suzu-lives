@echo off
setlocal EnableExtensions

if not exist "%~dp0suzu-dev-update.ps1" (
  echo 缺少 suzu-dev-update.ps1。请保留整个 suzu-dev-update 文件夹后再运行。
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
