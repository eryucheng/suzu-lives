@echo off
chcp 65001 >nul
cd /d "%~dp0"
node compact-jsonl.mjs
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" echo 执行失败，退出码：%EXIT_CODE%
pause
exit /b %EXIT_CODE%
