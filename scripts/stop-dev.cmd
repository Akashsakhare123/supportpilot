@echo off
rem Stop leftover SupportPilot dev servers. Double-click or run: scripts\stop-dev.cmd [-KeepNext]
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-dev.ps1" %*
pause
