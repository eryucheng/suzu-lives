@echo off
chcp 65001 >nul
cd /d "%~dp0"
python receive_from_iphone.py
pause
