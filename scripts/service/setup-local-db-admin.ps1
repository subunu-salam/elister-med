# Run elevated, once. Makes the local MongoDB (C:\ElisterDB) and the app start at boot as SYSTEM, and restarts both now.
# After this, a rebuild of the app goes live on its own: run-app.ps1 watches .next\BUILD_ID.
Start-Transcript -Path 'C:\Users\mohda\Desktop\hospital\.cloudflared\setup-db.log' -Force | Out-Null
$root = 'C:\Users\mohda\Desktop\hospital\scripts\service'
# stop the hand-started database (if any) and every app node process so the boot tasks own them
Get-Process mongod -ErrorAction SilentlyContinue | Where-Object { $_.Path -like 'C:\ElisterDB\*' } | Stop-Process -Force
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
  if ($cmd -match 'next' -and $cmd -match 'start') { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
}
Start-Sleep 3
schtasks /create /tn ElisterDB /tr "cmd /c $root\run-db.cmd" /sc onstart /ru SYSTEM /rl highest /f
schtasks /create /tn ElisterApp /tr "cmd /c $root\run-app.cmd" /sc onstart /ru SYSTEM /rl highest /f
schtasks /run /tn ElisterDB
Start-Sleep 8
schtasks /run /tn ElisterApp
Set-Service Cloudflared -StartupType Automatic; Start-Service Cloudflared -ErrorAction SilentlyContinue
Start-Sleep 10
foreach ($u in 'http://localhost:3200/login') { try { "$u -> " + (Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 20).StatusCode } catch { "$u -> failed: $_" } }
Get-Process mongod -ErrorAction SilentlyContinue | Select-Object Id, Path | Format-Table
Stop-Transcript | Out-Null
