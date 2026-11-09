# Persistent Win32 Session-Aware Input & Window Focus Bridge (Orca + IDEs + Terminals)
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

public static class VibeSessionWin32 {
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

    [DllImport("user32.dll", SetLastError = true)] public static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)] public static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetClipboardData(uint uFormat);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
    [DllImport("user32.dll")] public static extern bool IsClipboardFormatAvailable(uint format);

    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GlobalUnlock(IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GlobalFree(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PROCESSENTRY32 {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

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
    public const uint CF_UNICODETEXT = 13;
    public const uint GMEM_MOVEABLE = 0x0002;
    public const uint TH32CS_SNAPPROCESS = 0x00000002;

    private static readonly HashSet<string> TerminalProcs = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "WindowsTerminal", "wt", "pwsh", "powershell", "cmd", "wezterm-gui",
        "mintty", "alacritty", "kitty", "ConEmu64", "ConEmu", "Hyper", "Tabby", "warp", "Wave", "ghostty"
    };

    private static readonly HashSet<string> IdeProcs = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "Orca", "orca-ide", "Antigravity", "Codex", "Cursor", "Code", "Code - Insiders",
        "VSCodium", "Windsurf", "Zed", "Trae", "cmux", "Conductor", "Superset",
        "PearAI", "Void", "Fleet", "devenv", "idea64", "webstorm64", "pycharm64",
        "goland64", "clion64", "rider64", "rubymine64", "phpstorm64", "studio64", "Claude"
    };

    private static void BuildProcessTree(out Dictionary<uint, uint> parentMap, out Dictionary<uint, string> nameMap) {
        parentMap = new Dictionary<uint, uint>();
        nameMap = new Dictionary<uint, string>();
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return;
        try {
            PROCESSENTRY32 pe = new PROCESSENTRY32();
            pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (Process32First(snap, ref pe)) {
                do {
                    parentMap[pe.th32ProcessID] = pe.th32ParentProcessID;
                    string exe = pe.szExeFile ?? "";
                    if (exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) {
                        exe = exe.Substring(0, exe.Length - 4);
                    }
                    nameMap[pe.th32ProcessID] = exe;
                } while (Process32Next(snap, ref pe));
            }
        } finally {
            CloseHandle(snap);
        }
    }

    private static void CollectAncestors(uint seedPid, Dictionary<uint, uint> parentMap, HashSet<uint> into) {
        uint cur = seedPid;
        int guard = 0;
        while (cur > 4 && guard++ < 32) {
            if (!into.Add(cur)) break;
            uint parent;
            if (!parentMap.TryGetValue(cur, out parent)) break;
            cur = parent;
        }
    }

    private static bool ContainsAny(string hay, string[] needles) {
        if (string.IsNullOrEmpty(hay) || needles == null) return false;
        foreach (var n in needles) {
            if (!string.IsNullOrEmpty(n) && hay.IndexOf(n, StringComparison.OrdinalIgnoreCase) >= 0) {
                return true;
            }
        }
        return false;
    }

    public static IntPtr FindSessionWindow(
        uint agentPid,
        uint targetPid,
        string[] cwdHints,
        string[] agentKeywords,
        string[] agentBinaries,
        string[] pureGuiApps,
        out string matchedInfo,
        out string matchedProc,
        out bool foundCoding,
        out bool isOrca,
        out bool isPureGui,
        out bool isCliSession
    ) {
        Dictionary<uint, uint> parentMap;
        Dictionary<uint, string> nameMap;
        BuildProcessTree(out parentMap, out nameMap);

        var sessionAncestors = new HashSet<uint>();
        if (agentPid > 4) CollectAncestors(agentPid, parentMap, sessionAncestors);
        if (targetPid > 4) sessionAncestors.Add(targetPid);

        var liveCliAncestors = new HashSet<uint>();
        if (agentBinaries != null && agentBinaries.Length > 0) {
            var binSet = new HashSet<string>(agentBinaries, StringComparer.OrdinalIgnoreCase);
            foreach (var kv in nameMap) {
                if (binSet.Contains(kv.Value)) {
                    CollectAncestors(kv.Key, parentMap, liveCliAncestors);
                }
            }
        }

        IntPtr fgWnd = GetForegroundWindow();
        uint fgPid = 0;
        if (fgWnd != IntPtr.Zero) GetWindowThreadProcessId(fgWnd, out fgPid);

        IntPtr bestWnd = IntPtr.Zero;
        int bestScore = int.MinValue;
        string bestTitle = "none";
        string bestProcName = "";
        bool bestIsOrca = false;
        bool bestIsPureGui = false;

        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len <= 0) return true;
            var sb = new StringBuilder(len + 2);
            GetWindowText(hWnd, sb, sb.Capacity);
            string title = sb.ToString();
            if (string.IsNullOrWhiteSpace(title)) return true;

            uint winPid;
            GetWindowThreadProcessId(hWnd, out winPid);
            string procName = "";
            if (!nameMap.TryGetValue(winPid, out procName)) {
                try { procName = Process.GetProcessById((int)winPid).ProcessName; } catch { return true; }
            }
            if (string.IsNullOrEmpty(procName)) return true;
            if (procName.IndexOf("StreamDock", StringComparison.OrdinalIgnoreCase) >= 0 ||
                procName.IndexOf("Stream Dock", StringComparison.OrdinalIgnoreCase) >= 0) {
                return true;
            }

            bool procIsOrca = procName.Equals("Orca", StringComparison.OrdinalIgnoreCase) ||
                              procName.Equals("orca-ide", StringComparison.OrdinalIgnoreCase) ||
                              title.EndsWith(" - Orca", StringComparison.OrdinalIgnoreCase) ||
                              title.Equals("Orca", StringComparison.OrdinalIgnoreCase);
            bool procIsTerm = !procIsOrca && TerminalProcs.Contains(procName);
            bool procIsIde = procIsOrca || IdeProcs.Contains(procName);
            bool procOwnsSession = sessionAncestors.Contains(winPid) || liveCliAncestors.Contains(winPid);

            if (!procIsTerm && !procIsIde && !procOwnsSession) return true;

            int score = 100;
            if (hWnd == fgWnd || (fgPid != 0 && winPid == fgPid && hWnd == fgWnd)) score += 1200;
            if (sessionAncestors.Contains(winPid)) score += 950;
            else if (liveCliAncestors.Contains(winPid)) score += 550;

            if (ContainsAny(title, cwdHints)) score += 320;
            if (ContainsAny(title, agentKeywords) || ContainsAny(procName, agentKeywords)) score += 220;
            if (procIsOrca) score += 90;

            if (score > bestScore) {
                bestScore = score;
                bestWnd = hWnd;
                bestProcName = procName;
                bestTitle = procName + ": " + title;
                bestIsOrca = procIsOrca;
                bestIsPureGui = !procIsOrca && !procIsTerm && ContainsAny(procName, pureGuiApps);
            }
            return true;
        }, IntPtr.Zero);

        matchedInfo = bestTitle;
        matchedProc = bestProcName;
        foundCoding = bestWnd != IntPtr.Zero;
        isOrca = bestIsOrca;
        isPureGui = bestIsPureGui;
        isCliSession = sessionAncestors.Count > 0 || liveCliAncestors.Count > 0;
        return bestWnd;
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

    private static string ReadClipboardTextWin32() {
        if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return null;
        if (!OpenClipboard(IntPtr.Zero)) return null;
        try {
            IntPtr hData = GetClipboardData(CF_UNICODETEXT);
            if (hData == IntPtr.Zero) return null;
            IntPtr ptr = GlobalLock(hData);
            if (ptr == IntPtr.Zero) return null;
            try {
                return Marshal.PtrToStringUni(ptr);
            } finally {
                GlobalUnlock(hData);
            }
        } finally {
            CloseClipboard();
        }
    }

    private static bool WriteClipboardTextWin32(string text) {
        for (int attempt = 0; attempt < 4; attempt++) {
            if (OpenClipboard(IntPtr.Zero)) {
                try {
                    EmptyClipboard();
                    byte[] bytes = Encoding.Unicode.GetBytes((text ?? "") + "\0");
                    IntPtr hGlobal = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes.Length);
                    if (hGlobal == IntPtr.Zero) return false;
                    IntPtr target = GlobalLock(hGlobal);
                    if (target == IntPtr.Zero) {
                        GlobalFree(hGlobal);
                        return false;
                    }
                    try {
                        Marshal.Copy(bytes, 0, target, bytes.Length);
                    } finally {
                        GlobalUnlock(hGlobal);
                    }
                    if (SetClipboardData(CF_UNICODETEXT, hGlobal) == IntPtr.Zero) {
                        GlobalFree(hGlobal);
                        return false;
                    }
                    return true;
                } finally {
                    CloseClipboard();
                }
            }
            Thread.Sleep(12);
        }
        return false;
    }

    public static void SendUnicodeString(string text, bool pressEnter) {
        if (!string.IsNullOrEmpty(text)) {
            var list = new List<INPUT>(text.Length * 2);
            foreach (char ch in text) {
                var down = new INPUT();
                down.type = INPUT_KEYBOARD; down.U.ki.wVk = 0; down.U.ki.wScan = (ushort)ch; down.U.ki.dwFlags = KEYEVENTF_UNICODE;
                list.Add(down);
                var up = new INPUT();
                up.type = INPUT_KEYBOARD; up.U.ki.wVk = 0; up.U.ki.wScan = (ushort)ch; up.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
                list.Add(up);
            }
            var arr = list.ToArray();
            SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
        }
        if (pressEnter) {
            Thread.Sleep(45);
            SendVkCombo(new ushort[0], 0x0D);
        }
    }

    public static void SendTextSmart(string text, bool pressEnter, string targetProcName) {
        if (string.IsNullOrEmpty(text)) {
            if (pressEnter) SendVkCombo(new ushort[0], 0x0D);
            return;
        }

        // Single ASCII character ('y', 'a', 'n') via KEYEVENTF_UNICODE avoids clipboard & bypasses Korean IME
        if (text.Length == 1 && text[0] < 128 && !pressEnter) {
            SendUnicodeString(text, false);
            return;
        }

        string prevClip = ReadClipboardTextWin32();
        bool hadPrev = prevClip != null;

        if (WriteClipboardTextWin32(text)) {
            bool useShiftInsert = !string.IsNullOrEmpty(targetProcName) &&
                                  targetProcName.Equals("mintty", StringComparison.OrdinalIgnoreCase);
            bool useCtrlShiftV = !string.IsNullOrEmpty(targetProcName) &&
                                 (targetProcName.Equals("alacritty", StringComparison.OrdinalIgnoreCase) ||
                                  targetProcName.Equals("kitty", StringComparison.OrdinalIgnoreCase));

            if (useShiftInsert) {
                SendVkCombo(new ushort[] { 0x10 }, 0x2D); // Shift+Insert
            } else if (useCtrlShiftV) {
                SendVkCombo(new ushort[] { 0x11, 0x10 }, 0x56); // Ctrl+Shift+V
            } else {
                SendVkCombo(new ushort[] { 0x11 }, 0x56); // Ctrl+V (Orca, Cursor, VS Code, Antigravity, Codex, WindowsTerminal)
            }

            if (pressEnter) {
                Thread.Sleep(65);
                SendVkCombo(new ushort[0], 0x0D);
            }

            if (hadPrev) {
                Thread.Sleep(150);
                WriteClipboardTextWin32(prevClip);
            }
            return;
        }

        // Fallback if clipboard is locked by another process
        SendUnicodeString(text, pressEnter);
    }
}
"@

Add-Type -TypeDefinition $csharp -Language CSharp

function Send-KeyByName([string]$combo, [bool]$isPureGui, [string]$agentKind) {
    $c = $combo.ToLowerInvariant().Trim()
    switch ($c) {
        "enter"       { [VibeSessionWin32]::SendVkCombo(@(), 0x0D) }
        "esc"         { [VibeSessionWin32]::SendVkCombo(@(), 0x1B) }
        "1"           { [VibeSessionWin32]::SendVkCombo(@(), 0x31) }
        "2"           { [VibeSessionWin32]::SendVkCombo(@(), 0x32) }
        "y"           { [VibeSessionWin32]::SendUnicodeString("y", $false) }
        "a"           { [VibeSessionWin32]::SendUnicodeString("a", $false) }
        "n"           { [VibeSessionWin32]::SendUnicodeString("n", $false) }
        "ctrl+c"      { [VibeSessionWin32]::SendVkCombo(@(0x11), 0x43) }
        "ctrl+l"      { [VibeSessionWin32]::SendVkCombo(@(0x11), 0x4C) }
        "shift+tab"   { [VibeSessionWin32]::SendVkCombo(@(0x10), 0x09) }
        "alt+t"       { [VibeSessionWin32]::SendVkCombo(@(0x12), 0x54) }
        "alt+v"       { [VibeSessionWin32]::SendVkCombo(@(0x12), 0x56) }
        "ctrl+v"      { [VibeSessionWin32]::SendVkCombo(@(0x11), 0x56) }
        "image_paste" {
            if ($isPureGui -or $agentKind -eq "codex") {
                [VibeSessionWin32]::SendVkCombo(@(0x11), 0x56)
            } else {
                [VibeSessionWin32]::SendVkCombo(@(0x12), 0x56)
            }
        }
        "win+h"       { [VibeSessionWin32]::SendVkCombo(@(0x5B), 0x48) }
        "win+shift+s" { [VibeSessionWin32]::SendVkCombo(@(0x5B, 0x10), 0x53) }
        default       { [VibeSessionWin32]::SendVkCombo(@(), 0x0D) }
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
        $agentKind = if ($req.agentKind) { ([string]$req.agentKind).ToLowerInvariant() } else { "claude" }
        $agentPid = if ($null -ne $req.agentPid) { [uint32]$req.agentPid } else { [uint32]0 }
        $targetPid = if ($null -ne $req.targetPid) { [uint32]$req.targetPid } else { [uint32]0 }
        $cwdHints = if ($req.cwdHints) { @($req.cwdHints | ForEach-Object { [string]$_ }) } else { @() }
        $agentKeywords = if ($req.agentKeywords) { @($req.agentKeywords | ForEach-Object { [string]$_ }) } else { @() }
        $agentBinaries = if ($req.agentBinaries) { @($req.agentBinaries | ForEach-Object { [string]$_ }) } else { @() }
        $pureGuiApps = if ($req.pureGuiApps) { @($req.pureGuiApps | ForEach-Object { [string]$_ }) } else { @() }

        $winInfo = ""; $procName = ""; $foundCoding = $false; $isOrca = $false; $isPureGui = $false; $isCliSession = $false

        if ($cmd -eq "focus") {
            $h = [VibeSessionWin32]::FindSessionWindow(
                $agentPid, $targetPid, $cwdHints, $agentKeywords, $agentBinaries, $pureGuiApps,
                [ref]$winInfo, [ref]$procName, [ref]$foundCoding, [ref]$isOrca, [ref]$isPureGui, [ref]$isCliSession
            )
            if (-not $foundCoding -and $req.launchIfMissing) {
                $workDir = if ($req.cwd -and (Test-Path $req.cwd)) { [string]$req.cwd } else { $env:USERPROFILE }
                $wt = Get-Command wt.exe -ErrorAction SilentlyContinue
                if ($wt) { Start-Process "wt.exe" -ArgumentList @("-d", $workDir) }
                else { Start-Process "powershell.exe" -WorkingDirectory $workDir }
                Write-Output (@{ ok = $true; launched = $true; target = "launched_terminal" } | ConvertTo-Json -Compress)
            } else {
                $ok = if ($foundCoding) { [VibeSessionWin32]::FocusWindow($h) } else { $false }
                Write-Output (@{ ok = $ok; foundCoding = $foundCoding; isOrca = $isOrca; target = $winInfo } | ConvertTo-Json -Compress)
            }
        }
        elseif ($cmd -eq "key") {
            $comboStr = ([string]$req.combo).ToLowerInvariant().Trim()
            $isGlobal = ($comboStr -eq "win+h" -or $comboStr -eq "win+shift+s")
            $h = [VibeSessionWin32]::FindSessionWindow(
                $agentPid, $targetPid, $cwdHints, $agentKeywords, $agentBinaries, $pureGuiApps,
                [ref]$winInfo, [ref]$procName, [ref]$foundCoding, [ref]$isOrca, [ref]$isPureGui, [ref]$isCliSession
            )
            if ($autoFocus -and $foundCoding -and $comboStr -ne "win+shift+s") {
                [void][VibeSessionWin32]::FocusWindow($h)
                Start-Sleep -Milliseconds 35
            }
            if (-not $isGlobal -and $requireCoding -and -not $foundCoding) {
                Write-Output (@{ ok = $false; skipped = "no_coding_window"; combo = $comboStr } | ConvertTo-Json -Compress)
            } else {
                Send-KeyByName $comboStr $isPureGui $agentKind
                Write-Output (@{ ok = $true; combo = $comboStr; target = $winInfo; isOrca = $isOrca } | ConvertTo-Json -Compress)
            }
        }
        elseif ($cmd -eq "text") {
            $h = [VibeSessionWin32]::FindSessionWindow(
                $agentPid, $targetPid, $cwdHints, $agentKeywords, $agentBinaries, $pureGuiApps,
                [ref]$winInfo, [ref]$procName, [ref]$foundCoding, [ref]$isOrca, [ref]$isPureGui, [ref]$isCliSession
            )
            if ($requireCoding -and -not $foundCoding) {
                Write-Output (@{ ok = $false; skipped = "no_coding_window" } | ConvertTo-Json -Compress)
            } elseif ($req.skipPureGui -and $isPureGui -and -not $isCliSession) {
                Write-Output (@{ ok = $false; skipped = "pure_gui_skip_slash"; target = $winInfo } | ConvertTo-Json -Compress)
            } else {
                if ($autoFocus -and $foundCoding) {
                    [void][VibeSessionWin32]::FocusWindow($h)
                    Start-Sleep -Milliseconds 40
                }
                $pressEnter = if ($null -ne $req.enter) { [bool]$req.enter } else { $true }
                [VibeSessionWin32]::SendTextSmart([string]$req.text, $pressEnter, $procName)
                Write-Output (@{ ok = $true; text = $req.text; target = $winInfo; isOrca = $isOrca } | ConvertTo-Json -Compress)
            }
        }
        elseif ($cmd -like "launch_*") {
            $workDir = if ($req.cwd -and (Test-Path $req.cwd)) { [string]$req.cwd } else { $env:USERPROFILE }
            $cliBin = if ($req.cliBin) { [string]$req.cliBin } else { "claude" }
            $wt = Get-Command wt.exe -ErrorAction SilentlyContinue
            $psCmd = "if (Get-Command $cliBin -ErrorAction SilentlyContinue) { $cliBin } else { Write-Host '$cliBin CLI Ready' -ForegroundColor Cyan }"
            if ($wt) {
                Start-Process "wt.exe" -ArgumentList @("-d", $workDir, "powershell.exe", "-NoExit", "-Command", $psCmd)
            } else {
                Start-Process "powershell.exe" -WorkingDirectory $workDir -ArgumentList @("-NoExit", "-Command", $psCmd)
            }
            Write-Output (@{ ok = $true; launched = $true } | ConvertTo-Json -Compress)
        }
        else {
            Write-Output (@{ ok = $false; error = "unknown_cmd" } | ConvertTo-Json -Compress)
        }
    } catch {
        Write-Output (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress)
    }
}
