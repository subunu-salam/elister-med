@echo off
:loop
C:\ElisterDB\bin\mongod.exe --replSet rs0 --dbpath C:\ElisterDB\data --bind_ip 127.0.0.1 --port 27018 --logpath C:\ElisterDB\logs\mongod.log --logappend --wiredTigerCacheSizeGB 1
timeout /t 5 /nobreak >nul
goto loop
