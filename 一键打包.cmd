@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\package-release.ps1"
set "PACKAGE_EXIT_CODE=%ERRORLEVEL%"

if not "%PACKAGE_EXIT_CODE%"=="0" (
  echo.
  echo Packaging failed. Copy the error above when asking for help.
) else (
  echo.
  echo Packaging completed. The ZIP has been selected in Explorer.
)

pause
exit /b %PACKAGE_EXIT_CODE%
