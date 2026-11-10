# Runs the production app on port 3200 and restarts it by itself whenever a new build appears (.next\BUILD_ID changes), so a rebuild goes live without anyone restarting a task.
Set-Location C:\Users\mohda\Desktop\hospital
function BuildId { try { (Get-Content .next\BUILD_ID -Raw -ErrorAction Stop).Trim() } catch { '' } }
function DbUp { try { (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1', 27018); $true } catch { $false } }
for ($i = 0; $i -lt 30 -and -not (DbUp); $i++) { Start-Sleep 2 }   # wait for the local database after a reboot
while ($true) {
  $id = BuildId
  $p = Start-Process node -ArgumentList 'node_modules\next\dist\bin\next', 'start', '-p', '3200' -PassThru -WindowStyle Hidden -RedirectStandardOutput .cloudflared\app.log -RedirectStandardError .cloudflared\app.err.log
  while (-not $p.HasExited) {
    Start-Sleep 4
    $now = BuildId
    if ($now -and $now -ne $id) { & taskkill /PID $p.Id /T /F | Out-Null; break }
  }
  Start-Sleep 3
}
