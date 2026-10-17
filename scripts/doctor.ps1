<#
.SYNOPSIS
  SupportPilot setup check ("doctor") for Windows.
  1. Checks required tools: Node 22+, pnpm, Git, Docker (engine running), Python + libs.
  2. Installs what is missing where it safely can (pnpm, Python libs), starts Docker Desktop.
  3. Syncs new settings into .env, pnpm install, starts Postgres + Redis, generates + runs
     migrations, seeds demo data, lint, typecheck, tests, build, integration tests, and a
     pnpm dev smoke test (API /health + dashboard /login answer, then everything is stopped).
  Everything is logged to .claude-logs\doctor.log so Claude can read the result.

.EXAMPLE
  scripts\doctor.cmd                # full run (double-click works too)
  scripts\doctor.cmd -SkipInstall   # skip pnpm install
  scripts\doctor.cmd -SkipChecks    # tools + install + database only
#>
param(
  [switch]$SkipInstall,
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on
$env:NO_COLOR = '1'
$env:FORCE_COLOR = '0'

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$LogDir = Join-Path $Root '.claude-logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'doctor.log'
"SupportPilot doctor  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Root" | Out-File -FilePath $Log -Encoding utf8
$Results = New-Object System.Collections.Generic.List[object]

function Write-Log([string]$Text) { $Text | Out-File -FilePath $Log -Append -Encoding utf8 }

function Add-Result([string]$Name, [bool]$Ok, [string]$Detail, [double]$Seconds = 0) {
  $Results.Add([pscustomobject]@{ Step = $Name; Result = $(if ($Ok) { 'PASS' } else { 'FAIL' }); Seconds = [math]::Round($Seconds, 1); Detail = $Detail })
}

function Invoke-Step([string]$Name, [scriptblock]$Command) {
  Write-Host ''
  Write-Host "=== $Name ===" -ForegroundColor Cyan
  Write-Log ''
  Write-Log "=== $Name ==="
  $global:LASTEXITCODE = 0
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $output = $null
  & $Command 2>&1 | ForEach-Object { "$_" } | Tee-Object -Variable output | Out-Host
  $code = $global:LASTEXITCODE
  $timer.Stop()
  if ($output) { $output | Out-File -FilePath $Log -Append -Encoding utf8 }
  $ok = ($code -eq 0)
  Write-Log "--- exit code $code ($([math]::Round($timer.Elapsed.TotalSeconds, 1))s)"
  Add-Result $Name $ok "exit $code" $timer.Elapsed.TotalSeconds
  return $ok
}

# Known install locations, used when a tool is installed but not on PATH.
$KnownPaths = @{
  'npm'    = @("$env:ProgramFiles\nodejs\npm.cmd")
  'pnpm'   = @("$env:APPDATA\npm\pnpm.cmd", "$env:LOCALAPPDATA\pnpm\pnpm.exe")
  'git'    = @("$env:ProgramFiles\Git\cmd\git.exe", "${env:ProgramFiles(x86)}\Git\cmd\git.exe", "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe")
  'python' = @("$env:ProgramFiles\Python311\python.exe", "$env:ProgramFiles\Python310\python.exe",
               "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe", "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
               "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe")
  'docker' = @("$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe", "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe")
}
$PathFixes = New-Object System.Collections.Generic.List[string]

# Run "<exe> <args>" and return the first output line, or $null when it fails.
# (Output is collected first: piping a native command into Select-Object -First leaves a stale $LASTEXITCODE.)
function Invoke-Version([string]$Exe, [string[]]$Arguments) {
  try {
    $global:LASTEXITCODE = 0
    $lines = @(& $Exe @Arguments 2>&1 | ForEach-Object { "$_" })
    $code = $global:LASTEXITCODE
    if ($code -eq 0 -and $lines.Count -gt 0 -and "$($lines[0])".Trim()) { return "$($lines[0])".Trim() }
    Write-Log "  note: '$Exe $($Arguments -join ' ')' exited with $code : $($lines -join ' | ')"
  } catch {
    Write-Log "  note: '$Exe' failed: $($_.Exception.Message)"
  }
  return $null
}

# Version of a tool from PATH; if missing or broken (e.g. the Microsoft Store "python" alias),
# try known install folders and add the working one to PATH for this run.
function Get-ToolVersion([string]$Exe, [string[]]$Arguments) {
  if (Get-Command $Exe -ErrorAction SilentlyContinue) {
    $version = Invoke-Version $Exe $Arguments
    if ($version) { return $version }
  }
  foreach ($candidate in @($KnownPaths[$Exe])) {
    if ($candidate -and (Test-Path $candidate)) {
      $version = Invoke-Version $candidate $Arguments
      if ($version) {
        $dir = Split-Path -Parent $candidate
        $env:Path = "$dir;$env:Path"
        $PathFixes.Add("$Exe -> $dir")
        Write-Log "  note: using $candidate (its folder is not on your PATH; added for this run)"
        return $version
      }
    }
  }
  return $null
}

function Test-Tool([string]$Name, [string]$Exe, [string[]]$Arguments, [string]$Hint) {
  $version = Get-ToolVersion $Exe $Arguments
  if ($version) {
    $where = (Get-Command $Exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    Write-Host ("  OK   {0,-16} {1}" -f $Name, $version) -ForegroundColor Green
    Write-Log ("  OK   {0,-16} {1}   ({2})" -f $Name, $version, $where)
    Add-Result "tool: $Name" $true $version
  } else {
    Write-Host ("  MISS {0,-16} {1}" -f $Name, $Hint) -ForegroundColor Yellow
    Write-Log ("  MISS {0,-16} {1}" -f $Name, $Hint)
  }
  return $version
}

# HTTP status of a URL, or 0 when nothing answers.
function Get-HttpStatus([string]$Url, [int]$TimeoutSec = 5) {
  try {
    return [int](Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec).StatusCode
  } catch {
    if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
    return 0
  }
}

# Start `pnpm dev`, wait until the API and dashboard answer, then stop everything again.
function Test-DevServers {
  Write-Host ''
  Write-Host '=== Dev servers smoke test (pnpm dev) ===' -ForegroundColor Cyan
  Write-Log ''
  Write-Log '=== Dev servers smoke test (pnpm dev) ==='
  if ((Get-HttpStatus 'http://localhost:4000/health' 2) -ne 0 -or (Get-HttpStatus 'http://localhost:3000' 2) -ne 0) {
    Write-Log '  ports 3000/4000 are used by something that is not a SupportPilot dev server'
    Add-Result 'Dev servers (pnpm dev)' $false 'ports 3000/4000 in use by another program'
    return
  }
  # Fresh log file per run: a leftover process from an earlier run may still hold the old one open.
  Get-ChildItem -Path $LogDir -Filter 'dev*.log' -ErrorAction SilentlyContinue | Remove-Item -ErrorAction SilentlyContinue
  $devLog = Join-Path $LogDir ('dev-{0}.log' -f (Get-Date -Format 'HHmmss'))
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "pnpm dev > `"$devLog`" 2>&1" `
    -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  $api = 0; $web = 0; $board = 0; $workerUp = $false
  try {
    for ($i = 0; $i -lt 60 -and ($api -ne 200 -or $web -ne 200); $i++) {
      Start-Sleep -Seconds 3
      if ($proc.HasExited) { break }
      if ($api -ne 200) { $api = Get-HttpStatus 'http://localhost:4000/health' 5 }
      # First request makes Next.js compile the page, so allow a long timeout.
      if ($api -eq 200 -and $web -ne 200) { $web = Get-HttpStatus 'http://localhost:3000/login' 60 }
    }
    # The worker has no HTTP API; its dev-only Bull Board UI proves it started.
    for ($j = 0; $j -lt 15 -and $api -eq 200 -and $board -ne 200; $j++) {
      $board = Get-HttpStatus 'http://localhost:4100' 5
      if ($board -ne 200) { Start-Sleep -Seconds 2 }
    }
    $workerUp = (Test-Path $devLog) -and [bool](Select-String -Path $devLog -Pattern '\[worker\] listening' -Quiet)
  } finally {
    $timer.Stop()
    & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
    & (Join-Path $PSScriptRoot 'stop-dev.ps1') -KeepNext 2>&1 | Out-Null
    Start-Sleep -Seconds 2
  }
  if ($proc.HasExited -and ($api -ne 200 -or $web -ne 200)) { Write-Log "  pnpm dev exited early (exit code $($proc.ExitCode))" }
  Write-Log "  API /health -> $api, dashboard /login -> $web, worker listening -> $workerUp, Bull Board -> $board ($([math]::Round($timer.Elapsed.TotalSeconds))s)"
  if ($api -ne 200 -or $web -ne 200 -or -not $workerUp -or $board -ne 200) {
    Write-Log "  --- last 80 lines of $devLog ---"
    if (Test-Path $devLog) { Get-Content $devLog -Tail 80 | ForEach-Object { Write-Log "  $_" } }
    Write-Host "  pnpm dev did not come up; see $devLog" -ForegroundColor Red
  } else {
    Write-Host '  API, dashboard and worker answered; dev servers stopped again.' -ForegroundColor Green
  }
  Add-Result 'Dev servers: API /health' ($api -eq 200) "HTTP $api" $timer.Elapsed.TotalSeconds
  Add-Result 'Dev servers: dashboard /login' ($web -eq 200) "HTTP $web"
  Add-Result 'Dev servers: worker on ingestion queue' $workerUp $(if ($workerUp) { 'listening' } else { 'no "[worker] listening" line' })
  Add-Result 'Dev servers: Bull Board :4100' ($board -eq 200) "HTTP $board"
}

# ------------------------------------------------------------------ 1. tools
Write-Host '=== Required tools ===' -ForegroundColor Cyan
Write-Log '=== Required tools ==='
Write-Log ("  OS {0}  PowerShell {1}" -f [Environment]::OSVersion.VersionString, $PSVersionTable.PSVersion)

$node = Test-Tool 'Node.js' 'node' @('--version') 'install Node 22 LTS from https://nodejs.org'
if ($node) {
  $major = [int]($node.TrimStart('v').Split('.')[0])
  if ($major -lt 22) {
    Add-Result 'tool: Node.js >= 22' $false "found $node; install Node 22 LTS"
  }
} else {
  Add-Result 'tool: Node.js' $false 'not found'
}
$npm = Test-Tool 'npm' 'npm' @('--version') 'comes with Node.js'
if (-not $npm) { Add-Result 'tool: npm' $false 'not found' }

$pnpm = Test-Tool 'pnpm' 'pnpm' @('--version') 'installing with npm...'
if (-not $pnpm -and $node) {
  Invoke-Step 'Install pnpm (npm install -g pnpm@10)' { npm install -g pnpm@10 } | Out-Null
  $pnpm = Test-Tool 'pnpm' 'pnpm' @('--version') 'still missing: run  npm install -g pnpm@10'
}
if (-not $pnpm) { Add-Result 'tool: pnpm' $false 'not found' }

$git = Test-Tool 'Git' 'git' @('--version') 'install from https://git-scm.com'
if (-not $git) { Add-Result 'tool: Git' $false 'not found' }

$python = 'python'
$py = Test-Tool 'Python' 'python' @('--version') 'trying the py launcher...'
if (-not $py) {
  $py = Test-Tool 'Python (py)' 'py' @('-3', '--version') 'install Python 3.10+ from https://python.org'
  if ($py) { $python = 'py' }
}
if ($py) {
  & $python -c 'import openpyxl, docx' 2>$null
  if ($LASTEXITCODE -ne 0) {
    Invoke-Step 'Install Python libs (openpyxl, python-docx)' { & $python -m pip install --user openpyxl python-docx } | Out-Null
  } else {
    Add-Result 'tool: Python libs' $true 'openpyxl + python-docx present'
  }
} else {
  Add-Result 'tool: Python' $false 'not found (needed only for scripts/progress.py)'
}

$docker = Test-Tool 'Docker CLI' 'docker' @('--version') 'install Docker Desktop'
$compose = Test-Tool 'Docker Compose' 'docker' @('compose', 'version') 'comes with Docker Desktop'
$engineOk = $false
if ($docker) {
  docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    $candidates = @("$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe", "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe")
    $exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($exe) {
      Write-Host '  Starting Docker Desktop (up to 3 minutes)...' -ForegroundColor Yellow
      Write-Log '  Docker engine not running; starting Docker Desktop'
      Start-Process -FilePath $exe | Out-Null
      for ($i = 0; $i -lt 36; $i++) {
        Start-Sleep -Seconds 5
        docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
      }
    }
  }
  $server = docker info --format '{{.ServerVersion}}' 2>$null
  $engineOk = ($LASTEXITCODE -eq 0)
  Add-Result 'Docker engine running' $engineOk $(if ($engineOk) { "server $server" } else { 'start Docker Desktop and run again' })
} else {
  Add-Result 'tool: Docker' $false 'not found'
}

# ---------------------------------------------------------- 2. project setup
# A dev server left running from an earlier run would fight with `pnpm build` over .next/.
Write-Host ''
Write-Host '=== Stop leftover dev servers ===' -ForegroundColor Cyan
Write-Log ''
Write-Log '=== Stop leftover dev servers ==='
& (Join-Path $PSScriptRoot 'stop-dev.ps1') -KeepNext 2>&1 | ForEach-Object { "$_" } | Tee-Object -Variable stopOut | Out-Host
if ($stopOut) { $stopOut | ForEach-Object { Write-Log "  $_" } }

$envFile = Join-Path $Root '.env'
$envExample = Join-Path $Root '.env.example'
if (-not (Test-Path $envFile)) {
  Copy-Item $envExample $envFile
  Write-Log '  Created .env from .env.example'
  Add-Result 'Create .env' $true 'copied from .env.example'
} else {
  # New settings added to .env.example by later tasks are appended; existing values are kept.
  $known = @{}
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') { $known[$Matches[1]] = $true }
  }
  $added = @()
  foreach ($line in Get-Content $envExample) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=' -and -not $known.ContainsKey($Matches[1])) {
      Add-Content -Path $envFile -Value $line
      $added += $Matches[1]
    }
  }
  if ($added.Count -gt 0) {
    Write-Log "  Added new settings to .env: $($added -join ', ')"
    Add-Result 'Update .env (new settings)' $true ($added -join ', ')
  }
}

$installed = $true
if ($pnpm -and -not $SkipInstall) {
  $installed = Invoke-Step 'pnpm install' { pnpm install }
}

$dbReady = $false
if ($engineOk) {
  if (Invoke-Step 'Start Postgres + Redis (docker compose up)' { docker compose up -d --wait }) {
    # Writes a new SQL migration only when the Drizzle schema changed (no-op otherwise).
    if (Invoke-Step 'Generate migrations from schema (pnpm db:generate)' { pnpm db:generate }) {
      $dbReady = Invoke-Step 'Database migrations (pnpm db:migrate)' { pnpm db:migrate }
      if ($dbReady) {
        Invoke-Step 'Seed demo data (pnpm db:seed)' { pnpm db:seed } | Out-Null
      }
    }
  }
}

# ----------------------------------------------------------------- 3. checks
if ($pnpm -and $installed -and -not $SkipChecks) {
  Invoke-Step 'Lint (pnpm lint)' { pnpm lint } | Out-Null
  Invoke-Step 'Typecheck (pnpm typecheck)' { pnpm typecheck } | Out-Null
  Invoke-Step 'Unit tests (pnpm test)' { pnpm test } | Out-Null
  Invoke-Step 'Build (pnpm build)' { pnpm build } | Out-Null
  if ($dbReady) {
    Invoke-Step 'Integration tests (pnpm test:integration)' { pnpm test:integration } | Out-Null
    Test-DevServers
  } else {
    Add-Result 'Integration tests' $false 'skipped: database not ready'
  }
}

# ---------------------------------------------------------------- 4. summary
$failed = @($Results | Where-Object { $_.Result -eq 'FAIL' })
$table = $Results | Format-Table -AutoSize | Out-String -Width 200
Write-Host ''
Write-Host '=== Summary ===' -ForegroundColor Cyan
Write-Host $table
Write-Log ''
Write-Log '=== Summary ==='
Write-Log $table
if ($PathFixes.Count -gt 0) {
  $msg = "Installed but not on PATH (found anyway for this run): $($PathFixes -join '; '). Add those folders to your user PATH so new terminals find them."
  Write-Host $msg -ForegroundColor Yellow
  Write-Log $msg
}
if ($failed.Count -eq 0) {
  Write-Host 'All checks passed.' -ForegroundColor Green
  Write-Log 'RESULT: ALL PASSED'
} else {
  Write-Host "$($failed.Count) step(s) failed. Tell Claude: 'doctor finished' - it reads .claude-logs\doctor.log." -ForegroundColor Red
  Write-Log "RESULT: $($failed.Count) FAILED"
}
exit $failed.Count
