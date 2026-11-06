# Persistent Win32 Input & Window Focus Bridge for OpenAI Codex Stream Dock Plugin
$ErrorActionPreference = "Continue"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$csharp = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class CodexWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint uCode, uint uMapType);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public MOUSEINPUT mi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const int SW_RESTORE = 9;

    private static readonly HashSet<string> TerminalProcs = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "WindowsTerminal", "pwsh", "powershell", "cmd", "wezterm-gui", "mintty", "alacritty", "kitty", "ConEmu64"
    };

    private static readonly HashSet<string> IdeProcs = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "Codex", "Cursor", "Code", "Windsurf", "Antigravity", "devenv", "idea64"
    };

    public static IntPtr FindCodexOrCodingWindow(out string matchedInfo, out bool foundCoding, out bool isGuiApp) {
        IntPtr bestCodexTerm = IntPtr.Zero;
        IntPtr bestCodexApp = IntPtr.Zero;
        IntPtr bestTerm = IntPtr.Zero;
        IntPtr bestIde = IntPtr.Zero;
        string iCodexTerm = "", iCodexApp = "", iTerm = "", iIde = "";

        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len <= 0) return true;
            var sb = new StringBuilder(len + 2);
            GetWindowText(hWnd, sb, sb.Capacity);
            string title = sb.ToString();
            if (string.IsNullOrWhiteSpace(title)) return true;

            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            string procName = "";
            try { procName = Process.GetProcessById((int)pid).ProcessName; } catch { return true; }

            bool hasCodex = procName.IndexOf("Codex", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            title.IndexOf("codex", StringComparison.OrdinalIgnoreCase) >= 0;

            if (TerminalProcs.Contains(procName)) {
                if (hasCodex && bestCodexTerm == IntPtr.Zero) {
                    bestCodexTerm = hWnd; iCodexTerm = procName + ": " + title;
                } else if (bestTerm == IntPtr.Zero) {
                    bestTerm = hWnd; iTerm = procName + ": " + title;
                }
            } else if (IdeProcs.Contains(procName)) {
                if (hasCodex && bestCodexApp == IntPtr.Zero) {
                    bestCodexApp = hWnd; iCodexApp = procName + ": " + title;
                } else if (bestIde == IntPtr.Zero) {
                    bestIde = hWnd; iIde = procName + ": " + title;
                }
            }
            return true;
        }, IntPtr.Zero);

        if (bestCodexTerm != IntPtr.Zero) { matchedInfo = iCodexTerm; foundCoding = true; isGuiApp = false; return bestCodexTerm; }
        if (bestCodexApp != IntPtr.Zero)  { matchedInfo = iCodexApp;  foundCoding = true; isGuiApp = true;  return bestCodexApp; }
        if (bestTerm != IntPtr.Zero)      { matchedInfo = iTerm;      foundCoding = true; isGuiApp = false; return bestTerm; }
        if (bestIde != IntPtr.Zero)       { matchedInfo = iIde;       foundCoding = true; isGuiApp = true;  return bestIde; }

        matchedInfo = "none"; foundCoding = false; isGuiApp = false;
        return IntPtr.Zero;
    }

    public static bool FocusWindow(IntPtr target) {
        if (target == IntPtr.Zero) return false;
        IntPtr fg = GetForegroundWindow();
        if (fg == target) return true;
        if (IsIconic(target)) ShowWindow(target, SW_RESTORE);

        uint fgPid, targetPid;
        uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
        uint curThread = GetCurrentThreadId();
        GetWindowThreadProcessId(target, out targetPid);

        keybd_event(0, 0, 0, UIntPtr.Zero);
        bool attached = false;
        if (fgThread != 0 && fgThread != curThread) attached = AttachThreadInput(curThread, fgThread, true);
        SetForegroundWindow(target);
        BringWindowToTop(target);
        if (attached) AttachThreadInput(curThread, fgThread, false);

        for (int i = 0; i < 8; i++) {
            if (GetForegroundWindow() == target) return true;
            Thread.Sleep(12);
        }
        return GetForegroundWindow() == target;
    }

    private static INPUT MakeVk(ushort vk, bool up) {
        var inp = new INPUT();
        inp.type = INPUT_KEYBOARD;
        inp.U.ki.wVk = vk;
        inp.U.ki.wScan = (ushort)MapVirtualKey(vk, 0);
        inp.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        return inp;
    }

    public static void SendVkCombo(ushort[] mods, ushort mainVk) {
        var list = new List<INPUT>();
        foreach (var m in mods) list.Add(MakeVk(m, false));
        list.Add(MakeVk(mainVk, false));
        list.Add(MakeVk(mainVk, true));
        for (int i = mods.Length - 1; i >= 0; i--) list.Add(MakeVk(mods[i], true));
        var arr = list.ToArray();
        SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void SendUnicodeString(string text, bool pressEnter) {
        if (!string.IsNullOrEmpty(text)) {
            var list = new List<INPUT>(text.Length * 2);
            foreach (char ch in text) {
                var down = new INPUT();
                down.type = INPUT_KEYBOARD; down.U.ki.wScan = (ushort)ch; down.U.ki.dwFlags = KEYEVENTF_UNICODE;
                list.Add(down);
                var up = new INPUT();
                up.type = INPUT_KEYBOARD; up.U.ki.wScan = (ushort)ch; up.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
                list.Add(up);
            }
            var arr = list.ToArray();
            SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
        }
        if (pressEnter) {
            Thread.Sleep(30);
            SendVkCombo(new ushort[0], 0x0D);
        }
    }
}
"@

Add-Type -TypeDefinition $csharp -Language CSharp

function Send-KeyByName([string]$combo, [bool]$isGui) {
    $c = $combo.ToLowerInvariant().Trim()
    switch ($c) {
        "enter"       { [CodexWin32]::SendVkCombo(@(), 0x0D) }
        "esc"         { [CodexWin32]::SendVkCombo(@(), 0x1B) }
        "y"           { [CodexWin32]::SendVkCombo(@(), 0x59) }
        "a"           { [CodexWin32]::SendVkCombo(@(), 0x41) }
        "2"           { [CodexWin32]::SendVkCombo(@(), 0x32) }
        "ctrl+c"      { [CodexWin32]::SendVkCombo(@(0x11), 0x43) }
        "shift+tab"   { [CodexWin32]::SendVkCombo(@(0x10), 0x09) }
        "image_paste" {
            if ($isGui) { [CodexWin32]::SendVkCombo(@(0x11), 0x56) } # Ctrl+V in Codex App / IDE
            else        { [CodexWin32]::SendVkCombo(@(0x11), 0x56) } # Ctrl+V in Codex CLI (Windows Terminal supports image paste via Ctrl+V / Alt+V)
        }
        "alt+v"       { [CodexWin32]::SendVkCombo(@(0x12), 0x56) }
        "win+h"       { [CodexWin32]::SendVkCombo(@(0x5B), 0x48) }
        "win+shift+s" { [CodexWin32]::SendVkCombo(@(0x5B, 0x10), 0x53) }
        default       { [CodexWin32]::SendVkCombo(@(), 0x0D) }
    }
}

Write-Output '{"ready":true}'

while (($line = [Console]::In.ReadLine()) -ne $null) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
        $req = $line | ConvertFrom-Json
        $cmd = [string]$req.cmd
        $autoFocus = if ($null -ne $req.focus) { [bool]$req.focus } else { $true }
        $requireCoding = if ($null -ne $req.requireCoding) { [bool]$req.requireCoding } else { $true }
        $winInfo = ""; $foundCoding = $false; $isGui = $false

        if ($cmd -eq "focus") {
            $h = [CodexWin32]::FindCodexOrCodingWindow([ref]$winInfo, [ref]$foundCoding, [ref]$isGui)
            if (-not $foundCoding -and $req.launchIfMissing) {
                $workDir = if ($req.cwd -and (Test-Path $req.cwd)) { [string]$req.cwd } else { $env:USERPROFILE }
                $wt = Get-Command wt.exe -ErrorAction SilentlyContinue
                if ($wt) { Start-Process "wt.exe" -ArgumentList @("-d", $workDir) }
                else { Start-Process "powershell.exe" -WorkingDirectory $workDir }
                Write-Output (@{ ok = $true; launched = $true } | ConvertTo-Json -Compress)
            } else {
                $ok = if ($foundCoding) { [CodexWin32]::FocusWindow($h) } else { $false }
                Write-Output (@{ ok = $ok; foundCoding = $foundCoding; target = $winInfo } | ConvertTo-Json -Compress)
            }
        }
        elseif ($cmd -eq "key") {
            $comboStr = ([string]$req.combo).ToLowerInvariant().Trim()
            $isGlobal = ($comboStr -eq "win+h" -or $comboStr -eq "win+shift+s")
            $h = [CodexWin32]::FindCodexOrCodingWindow([ref]$winInfo, [ref]$foundCoding, [ref]$isGui)
            if ($autoFocus -and $foundCoding -and $comboStr -ne "win+shift+s") {
                [void][CodexWin32]::FocusWindow($h)
                Start-Sleep -Milliseconds 30
            }
            if (-not $isGlobal -and $requireCoding -and -not $foundCoding) {
                Write-Output (@{ ok = $false; skipped = "no_coding_window" } | ConvertTo-Json -Compress)
            } else {
                Send-KeyByName $comboStr $isGui
                Write-Output (@{ ok = $true; combo = $comboStr; target = $winInfo } | ConvertTo-Json -Compress)
            }
        }
        elseif ($cmd -eq "text") {
            $h = [CodexWin32]::FindCodexOrCodingWindow([ref]$winInfo, [ref]$foundCoding, [ref]$isGui)
            if ($requireCoding -and -not $foundCoding) {
                Write-Output (@{ ok = $false; skipped = "no_coding_window" } | ConvertTo-Json -Compress)
            } else {
                if ($autoFocus -and $foundCoding) {
                    [void][CodexWin32]::FocusWindow($h)
                    Start-Sleep -Milliseconds 35
                }
                $pressEnter = if ($null -ne $req.enter) { [bool]$req.enter } else { $true }
                [CodexWin32]::SendUnicodeString([string]$req.text, $pressEnter)
                Write-Output (@{ ok = $true; text = $req.text; target = $winInfo } | ConvertTo-Json -Compress)
            }
        }
        elseif ($cmd -eq "launch_codex") {
            $workDir = if ($req.cwd -and (Test-Path $req.cwd)) { [string]$req.cwd } else { $env:USERPROFILE }
            $wt = Get-Command wt.exe -ErrorAction SilentlyContinue
            if ($wt) {
                Start-Process "wt.exe" -ArgumentList @("-d", $workDir, "powershell.exe", "-NoExit", "-Command", "if (Get-Command codex -ErrorAction SilentlyContinue) { codex } else { Write-Host 'OpenAI Codex CLI Ready' -ForegroundColor Green }")
            } else {
                Start-Process "powershell.exe" -WorkingDirectory $workDir -ArgumentList @("-NoExit", "-Command", "if (Get-Command codex -ErrorAction SilentlyContinue) { codex } else { Write-Host 'OpenAI Codex CLI Ready' -ForegroundColor Green }")
            }
            Write-Output (@{ ok = $true; launched = $true } | ConvertTo-Json -Compress)
        }
    } catch {
        Write-Output (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress)
    }
}
