$ErrorActionPreference = "Continue"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class WinText {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  public static List<string> GetWindowTexts(uint pid) {
    var result = new List<string>();
    EnumWindows((hWnd, lParam) => {
      uint wpid;
      GetWindowThreadProcessId(hWnd, out wpid);
      if (wpid == pid) {
        var sb = new StringBuilder(512);
        GetWindowText(hWnd, sb, sb.Capacity);
        if (sb.Length > 0) result.Add("TOP: " + sb.ToString());
        EnumChildWindows(hWnd, (child, lp) => {
          var sb2 = new StringBuilder(512);
          GetWindowText(child, sb2, sb2.Capacity);
          if (sb2.Length > 0) result.Add("  CHILD: " + sb2.ToString());
          return true;
        }, IntPtr.Zero);
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
"@

function Run-Case {
  param(
    [string]$Exe,
    [string[]]$ArgsList,
    [string]$Tag
  )
  $stdout = "D:\Apps\codex\files\git-management-3\.dbg-$Tag-out.log"
  $stderr = "D:\Apps\codex\files\git-management-3\.dbg-$Tag-err.log"
  $logFile = "$env:APPDATA\branchpulse\logs\branchpulse-2026-09-03.log"
  Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
  if (Test-Path $logFile) { Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue }
  Get-Process -Name BranchPulse, branchpulse-stock -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2

  Write-Output "=== CASE $Tag ==="
  Write-Output "exe=$Exe args=$($ArgsList -join ' ')"
  $env:ELECTRON_ENABLE_LOGGING = "1"
  try {
    $p = Start-Process -FilePath $Exe -ArgumentList $ArgsList -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WorkingDirectory "D:\Apps\codex\files\git-management-3\release\win-unpacked"
    Write-Output "pid=$($p.Id)"
  } catch {
    Write-Output "start_error=$($_.Exception.Message)"
    return
  }
  Start-Sleep -Seconds 9
  $procs = Get-Process -Name BranchPulse, branchpulse-stock -ErrorAction SilentlyContinue
  Write-Output "process_count=$($procs.Count)"
  $procs | ForEach-Object { Write-Output ("proc id={0} name={1} title={2}" -f $_.Id, $_.ProcessName, $_.MainWindowTitle) }
  $all = Get-CimInstance Win32_Process -Filter "Name = 'BranchPulse.exe' OR Name = 'branchpulse-stock.exe'"
  $renderers = $all | Where-Object { $_.CommandLine -like '*--type=renderer*' }
  Write-Output "renderer_count=$($renderers.Count)"
  foreach ($proc in $procs) {
    $texts = [WinText]::GetWindowTexts([uint32]$proc.Id)
    foreach ($t in $texts) { Write-Output "windowtext $t" }
  }
  if (Test-Path $logFile) {
    Write-Output "=== APP LOG ==="
    Get-Content -LiteralPath $logFile -Tail 20
  } else {
    Write-Output "log_missing"
  }
  if (Test-Path $stdout) {
    Write-Output "=== STDOUT ==="
    Get-Content -LiteralPath $stdout -Tail 30
  }
  if (Test-Path $stderr) {
    Write-Output "=== STDERR ==="
    Get-Content -LiteralPath $stderr -Tail 50
  }
  Remove-Item Env:ELECTRON_ENABLE_LOGGING -ErrorAction SilentlyContinue
  Get-Process -Name BranchPulse, branchpulse-stock -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
}

$unpacked = "D:\Apps\codex\files\git-management-3\release\win-unpacked"
$stock = Join-Path $unpacked "branchpulse-stock.exe"
if (-not (Test-Path $stock)) {
  Copy-Item -LiteralPath "D:\Apps\codex\files\git-management-3\node_modules\electron\dist\electron.exe" -Destination $stock
}

Run-Case -Exe $stock -ArgsList @("--no-sandbox", "--enable-logging") -Tag "stock"
Run-Case -Exe "D:\Apps\codex\files\git-management-3\release\win-unpacked\BranchPulse.exe" -ArgsList @("--no-sandbox", "--enable-logging") -Tag "packed"
Run-Case -Exe "D:\Apps\codex\files\git-management-3\release\win-unpacked\BranchPulse.exe" -ArgsList @("D:\Apps\codex\files\git-management-3\release\win-unpacked\resources\app.asar", "--no-sandbox", "--enable-logging") -Tag "packedasar"

Write-Output "ALL DONE"
