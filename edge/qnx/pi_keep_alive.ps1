# Keeps the Pi's side of the station up, from the laptop. The Pi has no battery: when the table is unplugged it goes
# down at once, and after it boots nothing on it starts the shelf node or the hand model again. This looks every few
# seconds. When the Pi answers and its node is not running, it runs pi_up.ps1: the clock, the desktop, the node and the
# hand model full screen. Run it once and leave it: powershell -NoProfile -ExecutionPolicy Bypass -File edge\qnx\pi_keep_alive.ps1
# Every start is written to services\eye\data\pi_watchdog.log.
param(
  [string]$Pi = 'reup-pi',
  # Seconds between looks.
  [int]$Every = 8,
  # Seconds the Pi is left alone after a start: ROS 2 takes about 40 s to set up.
  [int]$Settle = 80,
  # For a test: look this many times, then stop. 0 looks for ever.
  [int]$Looks = 0
)
$ErrorActionPreference = 'Continue'
$data = Join-Path $PSScriptRoot '..\..\services\eye\data'
New-Item -ItemType Directory -Force -Path $data | Out-Null
$log = Join-Path $data 'pi_watchdog.log'

function Say([string]$text) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $text"
  Add-Content -Path $log -Value $line
  Write-Output $line
}

# One watchdog at a time: two would each start the node.
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'reup-pi-keep-alive', [ref]$created)
if (-not $created) { Write-Output 'A Pi watchdog is already running. Nothing started.'; exit 0 }

# -n: ssh must not wait on a keyboard. Started with no window there is none, and without -n the first look never came back.
$ssh = @('-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', '-o', 'ConnectionAttempts=1', $Pi)
# How many supervisors of the shelf node run on the Pi. A number is an answer, anything else is no answer.
$ask = "pidin ar 2>/dev/null | grep -v grep | grep -c supervisor.py"

Say "Watching the Pi ($Pi)."
$was = ''
$quietUntil = Get-Date
$n = 0
while ($true) {
  $n += 1
  $answer = "$(& ssh @ssh $ask 2>$null)".Trim()
  if ($answer -notmatch '^\d+$') { $now = 'away' } elseif ([int]$answer -ge 1) { $now = 'up' } else { $now = 'down' }
  if ($now -ne $was) {
    if ($now -eq 'away') { Say 'The Pi does not answer. Unplugged, or still starting.' }
    if ($now -eq 'up') { Say 'The Pi answers and its shelf node is running.' }
    if ($now -eq 'down') { Say 'The Pi answers and its shelf node is not running.' }
    $was = $now
  }
  if ($now -eq 'down' -and (Get-Date) -ge $quietUntil) {
    Say 'Bringing the Pi up.'
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'pi_up.ps1') -Pi $Pi 2>&1
    foreach ($line in @($out | Select-Object -Last 6)) { Say "  $line" }
    $quietUntil = (Get-Date).AddSeconds($Settle)
    $was = ''
  }
  if ($Looks -gt 0 -and $n -ge $Looks) { break }
  Start-Sleep -Seconds $Every
}
