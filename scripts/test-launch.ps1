$logPath = "$env:APPDATA\branchpulse\logs\branchpulse-2026-09-03.log"
$exePath = "D:\Apps\codex\files\git-management-3\release\win-unpacked\BranchPulse.exe"
$stderrPath = "D:\Apps\codex\files\git-management-3\.bp-launch-stderr.log"
$stdoutPath = "D:\Apps\codex\files\git-management-3\.bp-launch-stdout.log"

# Clean previous logs
if (Test-Path $logPath) { Remove-Item -LiteralPath $logPath -Force }
if (Test-Path $stderrPath) { Remove-Item -LiteralPath $stderrPath -Force }
if (Test-Path $stdoutPath) { Remove-Item -LiteralPath $stdoutPath -Force }

# Kill any existing instance
Get-Process -Name BranchPulse -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# Launch with logging and capture stderr
$p = Start-Process -FilePath $exePath -ArgumentList "--no-sandbox","--enable-logging","--v=1" -RedirectStandardError $stderrPath -RedirectStandardOutput $stdoutPath -PassThru
Write-Output "started_pid=$($p.Id)"

# Wait for startup
Start-Sleep -Seconds 12

# Check processes
$procs = Get-Process -Name BranchPulse -ErrorAction SilentlyContinue
Write-Output "process_count=$($procs.Count)"
$procs | Select-Object Id,ProcessName,MainWindowTitle | Format-Table -AutoSize

# Check for renderer via WMI
$all = Get-CimInstance Win32_Process -Filter "Name = 'BranchPulse.exe'"
$renderers = $all | Where-Object { $_.CommandLine -like '*--type=renderer*' }
Write-Output "renderer_count=$($renderers.Count)"

# App log
if (Test-Path $logPath) {
  Write-Output "=== APP LOG ==="
  Get-Content -LiteralPath $logPath -Tail 40
} else {
  Write-Output "log_missing"
}

# Stderr tail
if (Test-Path $stderrPath) {
  Write-Output "=== STDERR (tail 80) ==="
  Get-Content -LiteralPath $stderrPath -Tail 80
} else {
  Write-Output "stderr_missing"
}

# Cleanup
Get-Process -Name BranchPulse -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Output "done"
