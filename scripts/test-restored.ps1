$ErrorActionPreference = "Continue"
$unpacked = "D:\Apps\codex\files\git-management-3\release\win-unpacked"
$asar = Join-Path $unpacked "resources\app.asar"
$logFile = "$env:APPDATA\branchpulse\logs\branchpulse-2026-09-03.log"

function Kill-All {
  Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('BranchPulse.exe', 'branchpulse-stock.exe', 'electron.exe', 'BranchPulse-restored.exe') } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

function Test-Exe {
  param([string]$Exe, [string]$Tag, [string[]]$ExtraArgs)
  Kill-All
  if (Test-Path $logFile) { Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue }
  $out = "D:\Apps\codex\files\git-management-3\.tst-$Tag-out.log"
  $err = "D:\Apps\codex\files\git-management-3\.tst-$Tag-err.log"
  Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue
  $env:ELECTRON_ENABLE_LOGGING = "1"
  $argsList = @($asar) + $ExtraArgs
  Write-Output "=== $Tag ==="
  $p = Start-Process -FilePath $Exe -ArgumentList $argsList -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WorkingDirectory $unpacked
  Start-Sleep -Seconds 10
  $procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*BranchPulse*' -or $_.Name -eq 'electron.exe' }
  $renderers = $procs | Where-Object { $_.CommandLine -like '*--type=renderer*' }
  $any = Get-Process -Name BranchPulse, BranchPulse-restored, branchpulse-stock, electron -ErrorAction SilentlyContinue
  $titles = $any | ForEach-Object { "$($_.Id):$($_.MainWindowTitle)" }
  Write-Output "pid=$($p.Id) proc_count=$($procs.Count) renderer_count=$($renderers.Count) titles=$($titles -join ',')"
  if (Test-Path $logFile) {
    Write-Output "=== APP LOG ==="
    Get-Content -LiteralPath $logFile -Tail 15
  } else {
    Write-Output "log_missing"
  }
  if (Test-Path $err) {
    $errTail = Get-Content -LiteralPath $err -Tail 15
    if ($errTail) { Write-Output "=== STDERR ==="; $errTail }
  }
  Remove-Item Env:ELECTRON_ENABLE_LOGGING -ErrorAction SilentlyContinue
}

Test-Exe -Exe (Join-Path $unpacked "BranchPulse-restored.exe") -Tag "restored" -ExtraArgs @("--no-sandbox")
Test-Exe -Exe (Join-Path $unpacked "branchpulse-stock.exe") -Tag "stock" -ExtraArgs @("--no-sandbox")
Kill-All
Write-Output "DONE"
