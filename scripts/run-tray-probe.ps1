<#
Launches the unfused dev runtime (which loads the same out/main/index.js as the
packaged build) with both the main-process inspector and the renderer debugger
enabled, then leaves it running so scripts/tray-probe.mjs can attach.

The packaged exe disables EnableNodeCliInspectArguments, so --inspect cannot be
used there; see scripts/after-pack.cjs.

Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-tray-probe.ps1
  node scripts\tray-probe.mjs 9338 9339
#>
param(
  [int]$MainPort = 9338,
  [int]$RendererPort = 9339,
  [string]$UserData = "$PSScriptRoot\..\.tmp-gitmanager-tray6\userdata"
)

New-Item -ItemType Directory -Force -Path $UserData | Out-Null
$env:GITMANAGER_USER_DATA_DIR = (Resolve-Path $UserData).Path

$electron = "$PSScriptRoot\..\node_modules\electron\dist\electron.exe"
$proc = Start-Process -FilePath (Resolve-Path $electron).Path `
  -ArgumentList '.', "--inspect=$MainPort", "--remote-debugging-port=$RendererPort" `
  -WorkingDirectory (Resolve-Path "$PSScriptRoot\..").Path `
  -PassThru -WindowStyle Hidden

Write-Output "PID=$($proc.Id)"
Write-Output "MAIN=127.0.0.1:$MainPort  RENDERER=127.0.0.1:$RendererPort"
