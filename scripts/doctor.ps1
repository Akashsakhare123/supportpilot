<#
.SYNOPSIS
  SupportPilot setup check ("doctor") for Windows.
  1. Checks required tools: Node 22+, pnpm, Git, Docker (engine running), Python + libs.
  2. Installs what is missing where it safely can (pnpm, Python libs), starts Docker Desktop.
  3. pnpm install, starts Postgres + Redis, runs migrations, lint, typecheck, tests, build,
     integration tests.
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
if (-not (Test-Path (Join-Path $Root '.env'))) {
  Copy-Item (Join-Path $Root '.env.example') (Join-Path $Root '.env')
  Write-Log '  Created .env from .env.example'
  Add-Result 'Create .env' $true 'copied from .env.example'
}

$installed = $true
if ($pnpm -and -not $SkipInstall) {
  $installed = Invoke-Step 'pnpm install' { pnpm install }
}

$dbReady = $false
if ($engineOk) {
  if (Invoke-Step 'Start Postgres + Redis (docker compose up)' { docker compose up -d --wait }) {
    $dbReady = Invoke-Step 'Database migrations (pnpm db:migrate)' { pnpm db:migrate }
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
