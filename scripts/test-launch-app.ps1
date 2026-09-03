$logPath = "$env:APPDATA\branchpulse\logs\branchpulse-2026-09-03.log"
$exePath = "D:\Apps\codex\files\git-management-3\release\win-unpacked\BranchPulse.exe"
$asarPath = "D:\Apps\codex\files\git-management-3\release\win-unpacked\resources\app.asar"
$stderrPath = "D:\Apps\codex\files\git-management-3\.bp-stderr2.log"
$stdoutPath = "D:\Apps\codex\files\git-management-3\.bp-stdout2.log"

if (Test-Path $logPath) { Remove-Item $logPath -Force }
if (Test-Path $stderrPath) { Remove-Item $stderrPath -Force }
if (Test-Path $stdoutPath) { Remove-Item $stdoutPath -Force }
Get-Process -Name BranchPulse -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$p = Start-Process -FilePath $exePath -ArgumentList "--app=$asarPath","--no-sandbox","--enable-logging","--v=1" -RedirectStandardError $stderrPath -RedirectStandardOutput $stdoutPath -PassThru
Write-Output "pid=$($p.Id)"
Start-Sleep -Seconds 12

$procs = Get-Process -Name BranchPulse -ErrorAction SilentlyContinue
Write-Output "count=$($procs.Count)"
Write-Output "title=$(($procs | Select-Object -First 1).MainWindowTitle)"

$all = Get-CimInstance Win32_Process -Filter "Name = 'BranchPulse.exe'"
$renderers = $all | Where-Object { $_.CommandLine -like '*--type=renderer*' }
Write-Output "renderer=$($renderers.Count)"

if (Test-Path $logPath) { Write-Output '=== APP LOG ==='; Get-Content $logPath -Tail 30 } else { Write-Output 'no_log' }
if (Test-Path $stderrPath) { Write-Output '=== STDERR ==='; Get-Content $stderrPath -Tail 80 } else { Write-Output 'no_stderr' }
if (Test-Path $stdoutPath) { Write-Output '=== STDOUT ==='; Get-Content $stdoutPath -Tail 30 } else { Write-Output 'no_stdout' }

Get-Process -Name BranchPulse -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Output "done"
