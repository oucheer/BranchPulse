<#
Starts a packaged GitManager build against an isolated user-data directory so
that smoke tests never touch the real profile and never hit the single-instance
lock of a user's running copy.

Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-smoke.ps1
  node scripts\smoke-cdp.mjs

Stop only the PID printed here; never blanket-kill GitManager processes.
#>
param(
  [string]$Exe = "$PSScriptRoot\..\release\win-unpacked\GitManager.exe",
  [string]$UserData = "$PSScriptRoot\..\.tmp-gitmanager-smoke\userdata",
  [string]$Port = "9222"
)

New-Item -ItemType Directory -Force -Path $UserData | Out-Null
$env:GITMANAGER_USER_DATA_DIR = (Resolve-Path $UserData).Path

$proc = Start-Process -FilePath (Resolve-Path $Exe).Path `
  -ArgumentList "--remote-debugging-port=$Port" `
  -PassThru -WindowStyle Hidden

Write-Output "PID=$($proc.Id)"
Write-Output "USERDATA=$env:GITMANAGER_USER_DATA_DIR"
Write-Output "CDP=http://127.0.0.1:$Port/json/list"
