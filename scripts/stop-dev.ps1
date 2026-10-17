<#
.SYNOPSIS
  Stop every SupportPilot dev server that is still running (pnpm dev, turbo, next, nest, vite, tsx)
  and clear the dashboard's .next cache. Use it when ports 3000 / 4000 / 5173 are stuck or the
  dashboard shows "Cannot find module" errors.

.EXAMPLE
  scripts\stop-dev.cmd              # stop servers and delete apps\dashboard\.next
  scripts\stop-dev.cmd -KeepNext    # stop servers only (used by the doctor)
#>
param(
  [switch]$KeepNext
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$rootPattern = [regex]::Escape($Root)
$self = $PID
$parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue).ParentProcessId

# 1. Node / turbo / esbuild processes started from this repository.
$targets = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -in @('node.exe', 'turbo.exe', 'esbuild.exe') -and
    $_.CommandLine -and $_.CommandLine -match $rootPattern -and
    $_.ProcessId -ne $self -and $_.ProcessId -ne $parent
  })

# 2. Anything node-based still listening on the dev ports.
foreach ($port in 3000, 4000, 5173) {
  $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($l in $listeners) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($l.OwningProcess)" -ErrorAction SilentlyContinue
    if ($p -and $p.Name -eq 'node.exe' -and -not ($targets | Where-Object { $_.ProcessId -eq $p.ProcessId })) {
      $targets += $p
    }
  }
}

if ($targets.Count -eq 0) {
  Write-Host 'No SupportPilot dev servers running.'
} else {
  foreach ($t in $targets) {
    $cmd = "$($t.CommandLine)"
    if ($cmd.Length -gt 110) { $cmd = $cmd.Substring(0, 110) + '...' }
    Write-Host ("Stopping {0,-11} PID {1,-6} {2}" -f $t.Name, $t.ProcessId, $cmd)
    Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
  Write-Host "Stopped $($targets.Count) process(es)."
}

if (-not $KeepNext) {
  $next = Join-Path $Root 'apps\dashboard\.next'
  if (Test-Path $next) {
    Remove-Item -Recurse -Force $next -ErrorAction SilentlyContinue
    if (Test-Path $next) { Write-Host 'Could not fully delete apps\dashboard\.next (a file is still in use).' }
    else { Write-Host 'Cleared apps\dashboard\.next (rebuilt automatically by pnpm dev).' }
  }
}
