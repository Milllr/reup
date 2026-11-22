# Brings the Pi up from the station laptop: the QNX desktop, the shelf node, and the hand model full screen on the
# Pi's screen, fed with the pictures of the camera on this laptop. Run it after a Pi boot, or any time in doubt.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File edge\qnx\pi_up.ps1
param(
  [string]$Hub = 'https://wheredidallmyinventorygo.wtf',
  # The development default the live hub accepts (apps/hub/src/config.ts). A real one comes from the environment.
  [string]$Token = $(if ($env:DEVICE_TOKEN) { $env:DEVICE_TOKEN } else { 'dev-device-token' }),
  [string]$Pi = 'reup-pi',
  [int]$Port = 8089
)
$ssh = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=6', $Pi)
try {
  $health = Invoke-RestMethod "http://localhost:$Port/health" -TimeoutSec 5
  if (-not $health.cameras[0].online) { 'The eye on this laptop has no camera. Plug the Facecam into the laptop, wait 20 seconds, and run this again.'; exit 1 }
} catch {
  'The eye on this laptop does not answer. Start it: powershell -NoProfile -ExecutionPolicy Bypass -File services\eye\restart.ps1'; exit 1
}
# The Pi is on a direct cable and reaches this laptop at the link local address of that adapter. Which one: ask the Pi.
$mine = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '169.254.*' } | ForEach-Object { $_.IPAddress })
$found = $null
foreach ($ip in $mine) {
  $code = & ssh @ssh "curl -s -m 2 -o /dev/null -w '%{http_code}' http://${ip}:$Port/health"
  if ("$code" -eq '200') { $found = $ip; break }
}
if (-not $found) { "The Pi cannot reach the eye on this laptop. Tried: $($mine -join ', '). Is the cable in, and does ssh $Pi work?"; exit 1 }
"The Pi sees this laptop at $found."
& ssh @ssh "HUB_URL=$Hub DEVICE_TOKEN=$Token CAMERA_URL=http://${found}:$Port/stream/board.mjpg ~/reup-node/up.sh"
