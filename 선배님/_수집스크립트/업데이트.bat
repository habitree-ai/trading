@echo off
chcp 65001 >nul
title Naver Blog - incremental update
cd /d "%~dp0"
echo.
echo  Checking blog.naver.com/pillion21 for new posts ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
echo.
pause
