$ErrorActionPreference = "Continue"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class WinText2 {
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

function Kill-TestApps {
  Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('BranchPulse.exe', 'branchpulse-stock.exe', 'electron.exe') } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

function Screenshot {
  param([string]$Path)
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $g.Dispose()
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

Kill-TestApps

$unpacked = "D:\Apps\codex\files\git-management-3\release\win-unpacked"
$exe = Join-Path $unpacked "BranchPulse.exe"
$asar = Join-Path $unpacked "resources\app.asar"
$stdout = "D:\Apps\codex\files\git-management-3\.clean-out.log"
$stderr = "D:\Apps\codex\files\git-management-3\.clean-err.log"
$logFile = "$env:APPDATA\branchpulse\logs\branchpulse-2026-09-03.log"
Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
if (Test-Path $logFile) { Remove-Item -LiteralPath $logFile -Force -ErrorAction SilentlyContinue }

Write-Output "launch=$exe"
$env:ELECTRON_ENABLE_LOGGING = "1"
$p = Start-Process -FilePath $exe -ArgumentList @($asar, "--no-sandbox", "--enable-logging", "--v=1", "--remote-debugging-port=9333") -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WorkingDirectory $unpacked
Write-Output "pid=$($p.Id)"
Start-Sleep -Seconds 15

$procs = Get-Process -Name BranchPulse -ErrorAction SilentlyContinue
Write-Output "process_count=$($procs.Count)"
$procs | ForEach-Object { Write-Output ("proc id={0} title={1}" -f $_.Id, $_.MainWindowTitle) }
foreach ($proc in $procs) {
  $texts = [WinText2]::GetWindowTexts([uint32]$proc.Id)
  foreach ($t in $texts) { Write-Output "windowtext $t" }
}
$all = Get-CimInstance Win32_Process -Filter "Name = 'BranchPulse.exe'"
$renderers = $all | Where-Object { $_.CommandLine -like '*--type=renderer*' }
Write-Output "renderer_count=$($renderers.Count)"
$all | ForEach-Object { Write-Output ("cmdline {0}: {1}" -f $_.ProcessId, $_.CommandLine) }

Screenshot "D:\Apps\codex\files\git-management-3\.debug-screen.png"
Write-Output "screenshot_saved"

if (Test-Path $logFile) {
  Write-Output "=== APP LOG ==="
  Get-Content -LiteralPath $logFile -Tail 30
} else {
  Write-Output "log_missing"
}
Write-Output "=== STDOUT ==="
if (Test-Path $stdout) { Get-Content -LiteralPath $stdout -Tail 40 }
Write-Output "=== STDERR ==="
if (Test-Path $stderr) { Get-Content -LiteralPath $stderr -Tail 80 }

Kill-TestApps
Write-Output "DONE"
