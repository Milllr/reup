# Keeps the buyer running on the station laptop. It starts the buyer, and starts it again when it stops or when the hub
# has not seen it for a while. Run it once and leave it: every restart is a line in services\eye\data\buyer-watchdog.log.
# Run it from the clone where `infisical init` was done (C:\code\hw13), so the TinyFish key reaches the buyer from
# Infisical and is never typed.
param(
  [string]$Hub = 'https://wheredidallmyinventorygo.wtf',
  [string]$Store = 'https://offcut.wheredidallmyinventorygo.wtf',
  # tinyfish shops on the live web. local is the stand in that needs no key.
  [string]$Engine = 'tinyfish',
  # Seconds between looks.
  [int]$Every = 10,
  # Seconds the buyer gets to start and reach the hub before a look counts.
  [int]$Grace = 40,
  # Seconds the hub may say the buyer is offline before it is started again.
  [int]$Stale = 40,
  # For a test: look this many times, then stop. 0 looks for ever.
  [int]$Looks = 0
)
$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$data = Join-Path $repo 'services\eye\data'
New-Item -ItemType Directory -Force -Path $data | Out-Null
$log = Join-Path $data 'buyer-watchdog.log'

function Say([string]$text) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $text"
  Add-Content -Path $log -Value $line
  Write-Output $line
}

# One watchdog at a time: two buyers would each take the same job.
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'reup-buyer-keep-alive', [ref]$created)
if (-not $created) { Write-Output 'A buyer watchdog is already running. Nothing started.'; exit 0 }

function Get-Buyer { Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'tsx' -and $_.CommandLine -match 'src[\\/]index\.ts' } }

function Stop-Buyer { Get-Buyer | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }

function Start-Buyer([string]$why) {
  $env:HUB_URL = $Hub
  $env:SUPPLY_URL = $Store
  $env:BUYER_ENGINE = $Engine
  foreach ($name in 'buyer.log', 'buyer.err') {
    $file = Join-Path $data $name
    if (Test-Path $file) { Move-Item $file "$file.last" -Force -ErrorAction SilentlyContinue }
  }
  $run = if ($Engine -eq 'tinyfish') { 'infisical run --silent -- npm run start -w services/buyer' } else { 'npm run start -w services/buyer' }
  Start-Process cmd -ArgumentList '/c', $run -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'buyer.log') -RedirectStandardError (Join-Path $data 'buyer.err')
  $script:startedAt = Get-Date
  $script:badSince = $null
  Say "$why Started the buyer."
}

# True when the hub sees the buyer, false when it does not, nothing when the hub itself cannot be reached.
function Test-Online {
  try { return [bool](Invoke-RestMethod "$Hub/api/state" -TimeoutSec 6).buyerOnline } catch { return $null }
}

$startedAt = Get-Date
$badSince = $null
if (Get-Buyer) { Say 'Watching the buyer that is already running.' } else { Start-Buyer 'The buyer was not running.' }

$n = 0
while ($Looks -eq 0 -or $n -lt $Looks) {
  $n += 1
  Start-Sleep -Seconds $Every
  if (-not (Get-Buyer)) {
    $last = Get-Content (Join-Path $data 'buyer.err') -Tail 1 -ErrorAction SilentlyContinue
    Start-Buyer "The buyer had stopped.$(if ($last) { " Its last word: $($last.Trim())." })"
    continue
  }
  if (((Get-Date) - $startedAt).TotalSeconds -lt $Grace) { continue }
  $online = Test-Online
  # The hub cannot be reached: that is the network, not the buyer. Starting it again would not help.
  if ($online -eq $null -or $online) { $badSince = $null; continue }
  if (-not $badSince) { $badSince = Get-Date; continue }
  if (((Get-Date) - $badSince).TotalSeconds -ge $Stale) {
    Stop-Buyer
    Start-Sleep -Seconds 2
    Start-Buyer "The hub has not seen the buyer for $Stale seconds."
  }
}
