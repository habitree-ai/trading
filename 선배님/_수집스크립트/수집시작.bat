@echo off
chcp 65001 >nul
title Naver Blog Collector - pillion21
cd /d "%~dp0"
echo.
echo  Collecting blog.naver.com/pillion21 ...
echo  Progress is also written to  _수집원본\진행로그.txt
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0collect.ps1"
echo.
pause
