@echo off
cd /d C:\Users\mohda\Desktop\hospital
:loop
set /p TOKEN=<.cloudflared\token.txt
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --no-autoupdate run --token %TOKEN% >> .cloudflared\tunnel.log 2>&1
timeout /t 5 /nobreak >nul
goto loop
