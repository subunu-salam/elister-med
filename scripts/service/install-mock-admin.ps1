# Run elevated. Adds the mock DHA server as a boot-time task running as SYSTEM.
Start-Transcript -Path 'C:\Users\mohda\Desktop\hospital\.cloudflared\install-mock.log' -Force | Out-Null
schtasks /create /tn ElisterMock /tr "cmd /c C:\Users\mohda\Desktop\hospital\scripts\service\run-mock.cmd" /sc onstart /ru SYSTEM /rl highest /f
schtasks /run /tn ElisterMock
schtasks /query /tn ElisterMock
Stop-Transcript | Out-Null
