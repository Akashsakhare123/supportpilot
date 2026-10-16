@echo off
rem SupportPilot setup check. Double-click this file or run: scripts\doctor.cmd [-SkipInstall] [-SkipChecks]
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0doctor.ps1" %*
echo.
echo Log saved to .claude-logs\doctor.log
pause
