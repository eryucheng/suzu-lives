@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  pause
  exit /b 9009
)

node "%~dp0compact-jsonl.mjs"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Compactor failed. Exit code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
