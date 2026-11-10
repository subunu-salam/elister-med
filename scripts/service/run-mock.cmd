@echo off
cd /d C:\Users\mohda\Desktop\hospital
:loop
node node_modules\tsx\dist\cli.mjs scripts\mock-dha.ts >> .cloudflared\mock.log 2>&1
timeout /t 5 /nobreak >nul
goto loop
