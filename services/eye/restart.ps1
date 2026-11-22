# Puts the eye on the station laptop on a ref (default origin/main) and starts it again, then prints what it sees.
# The watchdog (keep_alive.ps1) does the starting. If none is running, this starts one and leaves it running.
param(
  [string]$Hub = 'https://wheredidallmyinventorygo.wtf',
  [string]$Ref = 'origin/main',
  [int]$Wait = 30,
  [int]$Port = 8089
)
$eyeDir = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $eyeDir '..\..')).Path
$data = Join-Path $eyeDir 'data'
New-Item -ItemType Directory -Force -Path $data | Out-Null
$hold = Join-Path $data 'hold'
# While this file is there the watchdog starts nothing: the code is changing under it.
Set-Content -Path $hold -Value (Get-Date)
try {
  Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*' -and $_.CommandLine -match 'reup_eye' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  git -C $repo fetch -q origin "+refs/heads/*:refs/remotes/origin/*" 2>&1 | Out-Null
  git -C $repo checkout -q --detach $Ref 2>&1 | Out-Null
  git -C $repo log --oneline -1
} finally {
  Remove-Item $hold -Force -ErrorAction SilentlyContinue
}
# The watchdog holds a named mutex while it runs. Looking for its name in command lines found this very shell once,
# so nothing was started and the board had no camera.
$held = $null
$watching = [System.Threading.Mutex]::TryOpenExisting('reup-eye-keep-alive', [ref]$held)
if ($held) { $held.Dispose() }
if (-not $watching) {
  Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $eyeDir 'keep_alive.ps1'), '-Hub', $Hub, '-Port', $Port -WindowStyle Hidden
  'Started the watchdog. It keeps the eye running from here on.'
}
Start-Sleep -Seconds $Wait
try {
  $h = Invoke-RestMethod "http://localhost:$Port/health" -TimeoutSec 6
  "detector: $($h.detector)  counts: " + ($h.counts | ConvertTo-Json -Compress) + "  fps " + $h.cameras[0].fps + "  camera online " + $h.cameras[0].online
  "settled: " + ($h.settled | ConvertTo-Json -Compress) + "  notes: " + ($h.notes | ConvertTo-Json -Compress)
  "teach: " + ($h.teach | ConvertTo-Json -Compress)
} catch {
  "The eye does not answer yet. Its last words:"
  Get-Content (Join-Path $data 'eye.err') -Tail 4 -ErrorAction SilentlyContinue
}
Get-Content (Join-Path $data 'watchdog.log') -Tail 3 -ErrorAction SilentlyContinue
