@echo off
chcp 65001 >nul
title Naver Blog - missing media retry
cd /d "%~dp0"
echo.
echo  Retrying missing images / videos ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0retry.ps1"
echo.
pause
