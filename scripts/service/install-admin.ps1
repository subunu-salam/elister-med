# Run elevated. Installs the Cloudflare tunnel as a Windows service and the app as a boot-time task running as SYSTEM.
$ErrorActionPreference = 'Continue'
$log = 'C:\Users\mohda\Desktop\hospital\.cloudflared\install.log'
Start-Transcript -Path $log -Force | Out-Null
$cf = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$token = (Get-Content 'C:\Users\mohda\Desktop\hospital\.cloudflared\token.txt' -Raw).Trim()
if (-not (Get-Service Cloudflared -ErrorAction SilentlyContinue)) { & $cf service install $token } else { 'Cloudflared service already installed' }
Set-Service Cloudflared -StartupType Automatic; Start-Service Cloudflared
$cmd = 'C:\Users\mohda\Desktop\hospital\scripts\service\run-app.cmd'
schtasks /create /tn ElisterApp /tr "cmd /c $cmd" /sc onstart /ru SYSTEM /rl highest /f
schtasks /run /tn ElisterApp
Get-Service Cloudflared | Format-List Name, Status, StartType
schtasks /query /tn ElisterApp
Stop-Transcript | Out-Null
