# Keeps the eye running on the station laptop. It starts the eye, and starts it again when it stops, stops answering,
# or stops getting frames from the camera. Run it once and leave it: every restart is written to data\watchdog.log.
#
# Why it exists: on Saturday night the eye was started from a shell whose python had none of its packages. It stopped at
# the first import, nothing started it again, and the board had no picture until someone noticed.
param(
  [string]$Hub = 'https://wheredidallmyinventorygo.wtf',
  [int]$Port = 8089,
  # Seconds between looks.
  [int]$Every = 5,
  # Seconds the eye gets to load its model before a look counts.
  [int]$Grace = 45,
  # Seconds with no answer or no frames before the eye is started again.
  [int]$Stale = 20,
  # For a test: look this many times, then stop. 0 looks for ever.
  [int]$Looks = 0
)
$ErrorActionPreference = 'Continue'
$eyeDir = $PSScriptRoot
$data = Join-Path $eyeDir 'data'
New-Item -ItemType Directory -Force -Path $data | Out-Null
$log = Join-Path $data 'watchdog.log'
# restart.ps1 writes this file while it changes the code, so the eye is not started on half a checkout.
$hold = Join-Path $data 'hold'

function Say([string]$text) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $text"
  Add-Content -Path $log -Value $line
  Write-Output $line
}

# One watchdog at a time: two would each start an eye, and the second eye cannot open the camera.
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'reup-eye-keep-alive', [ref]$created)
if (-not $created) { Write-Output 'A watchdog is already running. Nothing started.'; exit 0 }

# The python that has the eye's packages. A shell can have another python first on its PATH.
function Find-Python {
  $found = @()
  if ($env:REUP_PYTHON) { $found += $env:REUP_PYTHON }
  $found += @(Get-Command python -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
  $found += @(Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object { $_.FullName })
  foreach ($exe in ($found | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path $exe)) { continue }
    & $exe -c "import pydantic, cv2, numpy" 2>$null
    if ($LASTEXITCODE -eq 0) { return $exe }
  }
  return $null
}

function Get-Eye { Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*' -and $_.CommandLine -match 'reup_eye' } }

function Stop-Eye { Get-Eye | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }

function Start-Eye([string]$why) {
  $python = Find-Python
  if (-not $python) { Say "$why No python on this laptop has the eye's packages. Install them with: python -m pip install -r services\eye\requirements.txt"; return }
  # The log of the run that just ended is kept beside the new one.
  foreach ($name in 'eye.log', 'eye.err') {
    $file = Join-Path $data $name
    if (Test-Path $file) { Move-Item $file "$file.last" -Force -ErrorAction SilentlyContinue }
  }
  Start-Process $python -ArgumentList '-u', '-m', 'reup_eye', '--hub', $Hub -WorkingDirectory $eyeDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'eye.log') -RedirectStandardError (Join-Path $data 'eye.err')
  $script:startedAt = Get-Date
  $script:badSince = $null
  Say "$why Started the eye with $python."
}

# What is wrong with the eye right now, in words, or nothing when it is well.
function Get-Trouble {
  try {
    $h = Invoke-RestMethod "http://localhost:$Port/health" -TimeoutSec 4
  } catch {
    return 'The eye does not answer.'
  }
  $cams = @($h.cameras)
  if ($cams.Count -eq 0) { return 'The eye has no camera.' }
  $live = @($cams | Where-Object { $_.online -and $_.fps -gt 0 })
  if ($live.Count -eq 0) { return 'The camera gives the eye no frames.' }
  return $null
}

$startedAt = Get-Date
$badSince = $null
if (Get-Eye) { Say 'Watching the eye that is already running.' } else { Start-Eye 'The eye was not running.' }

$n = 0
while ($Looks -eq 0 -or $n -lt $Looks) {
  $n += 1
  Start-Sleep -Seconds $Every
  # Someone is changing the code. A hold older than two minutes was left behind and is not obeyed.
  if ((Test-Path $hold) -and ((Get-Date) - (Get-Item $hold).LastWriteTime).TotalSeconds -lt 120) { $startedAt = Get-Date; $badSince = $null; continue }
  if (-not (Get-Eye)) {
    $last = Get-Content (Join-Path $data 'eye.err') -Tail 1 -ErrorAction SilentlyContinue
    Start-Eye "The eye had stopped.$(if ($last) { " Its last word: $($last.Trim())." })"
    continue
  }
  if (((Get-Date) - $startedAt).TotalSeconds -lt $Grace) { continue }
  $trouble = Get-Trouble
  if (-not $trouble) { $badSince = $null; continue }
  if (-not $badSince) { $badSince = Get-Date; continue }
  if (((Get-Date) - $badSince).TotalSeconds -ge $Stale) {
    Stop-Eye
    Start-Sleep -Seconds 2
    Start-Eye "$trouble For $Stale seconds."
  }
}
