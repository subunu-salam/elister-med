# Run elevated. Brings the PC-hosted copies back: clears any stuck node process, re-enables the boot tasks and the Cloudflare tunnel service.
Start-Transcript -Path 'C:\Users\mohda\Desktop\hospital\.cloudflared\enable.log' -Force | Out-Null
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*nodejs*' } | ForEach-Object {
  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
  if ($cmd -notmatch 'modelcontextprotocol') { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
}
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2
Set-Service Cloudflared -StartupType Automatic; Start-Service Cloudflared
foreach ($t in 'ElisterApp','ElisterMock') { schtasks /change /tn $t /enable; schtasks /run /tn $t }
Get-Service Cloudflared | Format-List Name, Status, StartType
Stop-Transcript | Out-Null
