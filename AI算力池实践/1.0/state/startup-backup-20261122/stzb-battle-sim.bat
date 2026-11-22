@echo off
rem stzb-battle-sim logon autostart -> single-source ps1 (start = async, bat exits immediately)
start "stzb-autostart" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\520\WorkBuddy\2026-10-31-17-04-52\stzb-battle-sim\autostart-stzb.ps1"
