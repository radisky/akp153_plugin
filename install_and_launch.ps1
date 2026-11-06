param(
    [ValidateSet("claude", "antigravity", "codex")]
    [string]$ActiveProfile = "antigravity"
)

$ErrorActionPreference = "Stop"

$pf86 = ${env:ProgramFiles(x86)}
$sdCandidates = @(
    (Join-Path $pf86 "Stream Dock AJAZZ Global\Stream Dock AJAZZ.exe"),
    (Join-Path $pf86 "Stream Dock AJAZZ\Stream Dock AJAZZ.exe"),
    (Join-Path $pf86 "Stream Dock\Stream Dock.exe")
)
$sdExe = $sdCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $sdExe) { throw "Stream Dock executable not found under $pf86" }

$sdInstallDir = Split-Path $sdExe
$nodeExe = Join-Path $sdInstallDir "node\node20.exe"
if (-not (Test-Path $nodeExe)) {
    $cmdNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmdNode) { $nodeExe = $cmdNode.Source } else { throw "node20.exe / node.exe not found" }
}

$cfgDir = Join-Path $env:APPDATA "HotSpot\StreamDock\config"
$dbFile = Join-Path $cfgDir "DataCache.db"
$iniFile = Join-Path $cfgDir "StreamDockConfig.ini"
$deployJs = Join-Path $PSScriptRoot "deploy_vibe_plugin.js"

# 1. Backup config files before stopping or editing
if (Test-Path $dbFile) { Copy-Item $dbFile "$dbFile.bak_vibe3" -Force }
if (Test-Path $iniFile) { Copy-Item $iniFile "$iniFile.bak_vibe3" -Force }
Write-Host "[1/5] Backed up DataCache.db & StreamDockConfig.ini"

# 2. Gracefully stop Stream Dock & plugin node20 processes
Get-Process -Name "Stream Dock AJAZZ", "Stream Dock" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 600
Get-Process -Name "node20" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800
Write-Host "[2/5] Stopped Stream Dock cleanly"

# 3. Deploy all 3 plugins, 3 top-level 18-slot profiles, and StreamDockConfig.ini
& $nodeExe $deployJs $ActiveProfile
Write-Host "[3/5] Deployed all 3 Vibe Coding plugins & 18-slot sdProfiles"

# 4. Register all 3 sdProfile IDs in DataCache.db ("AKP153E" table)
if (Test-Path $dbFile) {
    $cs = @"
using System;
using System.Runtime.InteropServices;
public class SqliteUpdaterV3 {
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern int sqlite3_open(byte[] filename, out IntPtr db);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern int sqlite3_exec(IntPtr db, byte[] sql, IntPtr cb, IntPtr arg, out IntPtr errmsg);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern int sqlite3_close(IntPtr db);
}
"@
    Add-Type -TypeDefinition $cs
    $dbBytes = [System.Text.Encoding]::UTF8.GetBytes("$dbFile`0")
    $db = [IntPtr]::Zero
    $rcOpen = [SqliteUpdaterV3]::sqlite3_open($dbBytes, [ref]$db)
    if ($rcOpen -ne 0) { throw "sqlite3_open failed: $rcOpen" }

    $profileIds = @(
        "CLAUDE01-VIBE-CODE-153E-000000000001.sdProfile",
        "ANTIGRAV-VIBE-CODE-153E-000000000002.sdProfile",
        "CODEX001-VIBE-CODE-153E-000000000003.sdProfile"
    )

    foreach ($pidStr in $profileIds) {
        $sqlText = "INSERT INTO ""AKP153E""(Profile) SELECT '$pidStr' WHERE NOT EXISTS (SELECT 1 FROM ""AKP153E"" WHERE Profile = '$pidStr');`0"
        $sqlBytes = [System.Text.Encoding]::UTF8.GetBytes($sqlText)
        $errPtr = [IntPtr]::Zero
        $rcExec = [SqliteUpdaterV3]::sqlite3_exec($db, $sqlBytes, [IntPtr]::Zero, [IntPtr]::Zero, [ref]$errPtr)
        if ($rcExec -ne 0) {
            [void][SqliteUpdaterV3]::sqlite3_close($db)
            throw "sqlite3_exec failed for ${pidStr}: $rcExec"
        }
    }
    [void][SqliteUpdaterV3]::sqlite3_close($db)
    Write-Host "[4/5] Registered all 3 Vibe Coding profiles in DataCache.db"
}

# 5. Relaunch Stream Dock detached via WMI
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = """$sdExe"""
    CurrentDirectory = $sdInstallDir
} | Out-Null
Write-Host "[5/5] Launched Stream Dock via WMI"

$portMap = @{
    claude      = 17530
    antigravity = 17531
    codex       = 17532
}
$activePort = $portMap[$ActiveProfile]

$ready = $false
for ($i = 0; $i -lt 26; $i++) {
    Start-Sleep -Milliseconds 750
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$activePort/state" -Method Get -TimeoutSec 1
        if ($resp.ok -and $resp.connectedContexts -gt 0) {
            Write-Host ("LIVE CONNECTED ($ActiveProfile :$activePort)! connectedContexts=" + $resp.connectedContexts + " model=" + $resp.modelDisplay + " hooksInstalled=" + $resp.hooksInstalled)
            $ready = $true
            break
        }
    } catch {}
}

if ($ready) {
    Invoke-RestMethod -Uri "http://127.0.0.1:$activePort/simulate" -Method Post -ContentType "application/json" -Body '{"demo":true}' | Out-Null
    Write-Host "Triggered live hardware LCD state demo sequence on port $activePort!"
}
