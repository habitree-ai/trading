@echo off
chcp 65001 >nul
title Senior blog archive - commit and push
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0commit.ps1"
