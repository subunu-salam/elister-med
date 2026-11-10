# Run elevated. Stops and disables the PC-hosted copies after the site moved to the server.
Start-Transcript -Path 'C:\Users\mohda\Desktop\hospital\.cloudflared\disable.log' -Force | Out-Null
Stop-Service Cloudflared -Force; Set-Service Cloudflared -StartupType Disabled
foreach ($t in 'ElisterApp','ElisterMock') { schtasks /end /tn $t; schtasks /change /tn $t /disable }
Get-Process node, cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*nodejs*' -or $_.Path -like '*cloudflared*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Service Cloudflared | Format-List Name, Status, StartType
Stop-Transcript | Out-Null
