@echo off
title Local Node Setup
cd /d "%~dp0"

echo.
echo ============================================================
echo   Local node init
echo     1) verify image SHA256
echo     2) wsl --import Ubuntu-24.04 to C:\WSL\Ubuntu-24.04
echo     3) create user k8s + enable systemd
echo     4) wsl --shutdown
echo     5) install GPU stack / containerd / kubelet / tailscale
echo     6) re-check three gates
echo.
echo   Full output goes to: state\local-setup-*.log
echo   Just wait, then close this window and tell me in chat.
echo ============================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp010_all-in-one.ps1"

echo.
echo ============================================================
echo   Finished. Close this window and say "done" in chat.
echo ============================================================
pause
