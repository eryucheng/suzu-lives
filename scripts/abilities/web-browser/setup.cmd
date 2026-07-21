@echo off
setlocal
cd /d "%~dp0\..\..\.."

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found in PATH.
  pause
  exit /b 1
)

echo Installing the official Microsoft Playwright CLI...
call npm install -g @playwright/cli@latest
if errorlevel 1 goto :failed

echo Installing the official Playwright skill into this Claude Code project...
call playwright-cli install --skills
if errorlevel 1 goto :failed

echo.
echo Setup completed.
echo Next, run scripts\abilities\web-browser\start-browser.cmd and sign in to the required websites.
pause
exit /b 0

:failed
echo.
echo Setup failed. Review the npm output above.
pause
exit /b 1
