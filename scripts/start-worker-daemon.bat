@echo off
title xtt worker-daemon
:begin
cd /d C:\Users\eleme\.qoderwork\workspace\mqt347tluzy70qx9\outputs\xintongtu-mvp
echo [%date% %time%] worker-daemon starting...
node scripts\tee-runner.js
echo [%date% %time%] worker-daemon exited with code %errorlevel%, restarting in 5s...
timeout /t 5 /nobreak >nul
goto :begin
