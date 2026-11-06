'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

// ============================================================================
// 1. Platform Constants, Logging & Paths (Google Antigravity - Win + macOS)
// ============================================================================
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const HOME_DIR = os.homedir();
const GEMINI_DIR = path.join(HOME_DIR, '.gemini');
const AGY_GLOBAL_CFG_DIR = path.join(GEMINI_DIR, 'config');
const AGY_HOOKS_JSON = path.join(AGY_GLOBAL_CFG_DIR, 'hooks.json');
const AGY_HOOK_SCRIPT = path.join(AGY_GLOBAL_CFG_DIR, 'streamdock_agy_notify.js');
const AGY_CLI_SETTINGS = path.join(GEMINI_DIR, 'antigravity-cli', 'settings.json');
const BUNDLED_HOOK_SCRIPT = path.join(__dirname, 'streamdock_agy_notify.js');
const WIN_BRIDGE_SCRIPT = path.join(__dirname, 'win_bridge.ps1');
const LOG_FILE = path.join(__dirname, 'plugin_runtime.log');
const HTTP_PORT = Number(process.env.AGY_SD_HTTP_PORT || 17531);

function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch (_) {}
}

try {
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 262144) {
    fs.writeFileSync(LOG_FILE, '', 'utf8');
  }
} catch (_) {}

// ============================================================================
// 2. Pure Node.js RFC 6455 WebSocket Client (Zero npm dependencies)
// ============================================================================
class MiniWebSocket {
  constructor(url) {
    const parsed = new URL(url);
    this.host = parsed.hostname || '127.0.0.1';
    this.port = Number(parsed.port);
    this.pathname = (parsed.pathname || '/') + (parsed.search || '');
    this.socket = null;
    this.rxBuf = Buffer.alloc(0);
    this.fragOpcode = 0;
    this.fragChunks = [];
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._connect();
  }

  _connect() {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: this.host,
      port: this.port,
      path: this.pathname,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key
      }
    });

    req.on('upgrade', (res, socket, head) => {
      this.socket = socket;
      this.socket.setNoDelay(true);
      this.readyState = 1;
      if (head && head.length > 0) this.rxBuf = Buffer.concat([this.rxBuf, head]);
      socket.on('data', (chunk) => {
        this.rxBuf = Buffer.concat([this.rxBuf, chunk]);
        this._drainFrames();
      });
      socket.on('close', () => {
        this.readyState = 3;
        if (this.onclose) this.onclose();
      });
      socket.on('error', (err) => {
        if (this.onerror) this.onerror(err);
      });
      if (this.onopen) this.onopen();
      if (this.rxBuf.length > 0) this._drainFrames();
    });

    req.on('error', (err) => {
      this.readyState = 3;
      if (this.onerror) this.onerror(err);
    });
    req.end();
  }

  _drainFrames() {
    while (this.rxBuf.length >= 2) {
      const b0 = this.rxBuf[0];
      const b1 = this.rxBuf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.rxBuf.length < 4) return;
        payloadLen = this.rxBuf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.rxBuf.length < 10) return;
        payloadLen = Number(this.rxBuf.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this.rxBuf.length < offset + maskLen + payloadLen) return;

      let payload = this.rxBuf.subarray(offset + maskLen, offset + maskLen + payloadLen);
      if (masked) {
        const mask = this.rxBuf.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ mask[i & 3];
        payload = unmasked;
      } else {
        payload = Buffer.from(payload);
      }

      this.rxBuf = this.rxBuf.subarray(offset + maskLen + payloadLen);

      if (opcode === 0x08) {
        this.close();
        return;
      } else if (opcode === 0x09) {
        this._sendFrame(0x0a, payload);
      } else if (opcode === 0x01 || opcode === 0x02) {
        if (fin) {
          if (opcode === 0x01 && this.onmessage) this.onmessage({ data: payload.toString('utf8') });
        } else {
          this.fragOpcode = opcode;
          this.fragChunks = [payload];
        }
      } else if (opcode === 0x00) {
        this.fragChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragChunks);
          const origOp = this.fragOpcode;
          this.fragChunks = [];
          this.fragOpcode = 0;
          if (origOp === 0x01 && this.onmessage) this.onmessage({ data: full.toString('utf8') });
        }
      }
    }
  }

  _sendFrame(opcode, payloadBuf) {
    if (this.readyState !== 1 || !this.socket) return;
    const len = payloadBuf.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | (opcode & 0x0f), 0x80 | len]);
    } else if (len <= 65535) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const maskedPayload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) maskedPayload[i] = payloadBuf[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, maskedPayload]));
  }

  send(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this._sendFrame(0x01, buf);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    try { if (this.socket) this.socket.end(); } catch (_) {}
  }
}

// ============================================================================
// 3. Cross-Platform Input & Window Focus Bridge (Prioritizing Antigravity App/CLI)
// ============================================================================
const MAC_JXA_SCRIPT = `
function run(argv) {
  const req = JSON.parse(argv[0]);
  const se = Application("System Events");
  const termNames = ["iTerm2", "iTerm", "Terminal", "Warp", "Ghostty", "wezterm-gui", "WezTerm", "Alacritty", "kitty"];
  const ideNames = ["Antigravity", "Cursor", "Code", "Visual Studio Code", "Windsurf", "Zed"];

  function findAgyProc() {
    const procs = se.applicationProcesses.whose({ backgroundOnly: false })();
    let agyGui = null, agyTerm = null, anyIde = null, anyTerm = null;
    for (let i = 0; i < procs.length; i++) {
      const p = procs[i];
      let pName = "";
      try { pName = p.name(); } catch (e) { continue; }
      const isTerm = termNames.indexOf(pName) >= 0;
      const isIde = ideNames.indexOf(pName) >= 0;
      if (!isTerm && !isIde) continue;

      let hasAgy = pName.toLowerCase().indexOf("antigravity") >= 0;
      try {
        const wins = p.windows();
        for (let w = 0; w < wins.length; w++) {
          const wt = String(wins[w].name() || "").toLowerCase();
          if (wt.indexOf("antigravity") >= 0 || wt.indexOf("agy") >= 0) { hasAgy = true; break; }
        }
      } catch (e) {}

      if (isIde && hasAgy && !agyGui) agyGui = { proc: p, isGui: true };
      else if (isTerm && hasAgy && !agyTerm) agyTerm = { proc: p, isGui: false };
      else if (isIde && !anyIde) anyIde = { proc: p, isGui: true };
      else if (isTerm && !anyTerm) anyTerm = { proc: p, isGui: false };
    }
    return agyGui || agyTerm || anyIde || anyTerm;
  }

  if (req.cmd === "focus") {
    const found = findAgyProc();
    if (found) {
      found.proc.frontmost = true;
      return JSON.stringify({ ok: true, foundCoding: true, isGui: found.isGui, target: found.proc.name() });
    }
    if (req.launchIfMissing) {
      try {
        const agyApp = Application("Antigravity");
        agyApp.activate();
        return JSON.stringify({ ok: true, launched: true, target: "Antigravity" });
      } catch (e) {
        const term = Application("Terminal");
        term.activate();
        return JSON.stringify({ ok: true, launched: true, target: "Terminal" });
      }
    }
    return JSON.stringify({ ok: false, foundCoding: false });
  }

  if (req.cmd === "launch_agy") {
    try {
      const agyApp = Application("Antigravity");
      agyApp.activate();
      return JSON.stringify({ ok: true, launched: "Antigravity" });
    } catch (e) {
      const sqEsc = String.fromCharCode(39, 92, 39, 39);
      const cwdEsc = String(req.cwd || "").split("'").join(sqEsc);
      const cdPart = cwdEsc ? ("cd '" + cwdEsc + "' && ") : "";
      const shCmd = cdPart + "(command -v agy >/dev/null 2>&1 && agy || echo 'Antigravity CLI (agy) Ready')";
      const term = Application("Terminal");
      term.activate();
      term.doScript(shCmd);
      return JSON.stringify({ ok: true, launched: "Terminal" });
    }
  }

  if (req.cmd === "key") {
    const combo = String(req.combo || "").toLowerCase();
    const isGlobal = (combo === "voice" || combo === "screen_snip");
    const found = findAgyProc();
    if (req.focus && found && combo !== "screen_snip") {
      found.proc.frontmost = true;
      delay(0.04);
    }
    if (!isGlobal && req.requireCoding && !found) {
      return JSON.stringify({ ok: false, skipped: "no_coding_window" });
    }

    switch (combo) {
      case "enter":     se.keyCode(36); break;
      case "esc":       se.keyCode(53); break;
      case "2":         se.keystroke("2"); break;
      case "y":         se.keystroke("y"); break;
      case "ctrl+c":    se.keyCode(8, { using: "control down" }); break;
      case "shift+tab": se.keyCode(48, { using: "shift down" }); break;
      case "image_paste":
        if (found && found.isGui) se.keyCode(9, { using: "command down" }); // Cmd+V in Antigravity macOS App
        else se.keyCode(9, { using: "control down" });
        break;
      case "screen_snip":
        se.keyCode(21, { using: ["command down", "control down", "shift down"] });
        break;
      case "cmd+v":
        se.keyCode(9, { using: "command down" });
        break;
      case "cmd+v+enter":
        se.keyCode(9, { using: "command down" });
        delay(0.05);
        se.keyCode(36);
        break;
      case "voice": {
        let triggered = false;
        const menus = ["Edit", "편집"];
        for (let m = 0; m < menus.length && !triggered; m++) {
          try {
            const fg = se.applicationProcesses.whose({ frontmost: true })()[0];
            const items = fg.menuBars[0].menuBarItems.byName(menus[m]).menus[0].menuItems();
            for (let i = 0; i < items.length; i++) {
              const nm = String(items[i].name() || "");
              if (nm.indexOf("Dictation") >= 0 || nm.indexOf("받아쓰기") >= 0) {
                items[i].click();
                triggered = true;
                break;
              }
            }
          } catch (e) {}
        }
        if (!triggered) { se.keyCode(63); delay(0.07); se.keyCode(63); }
        break;
      }
      default: se.keyCode(36); break;
    }
    return JSON.stringify({ ok: true, combo: combo });
  }
  return JSON.stringify({ ok: false, error: "unknown_cmd" });
}
`;

class PlatformBridge {
  constructor() {
    this.winProc = null;
    this.startingWin = false;
    if (IS_WIN && fs.existsSync(WIN_BRIDGE_SCRIPT)) this._spawnWinBridge();
  }

  _spawnWinBridge() {
    if (this.startingWin || this.winProc) return;
    this.startingWin = true;
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN_BRIDGE_SCRIPT],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
      child.stdin.setDefaultEncoding('utf8');
      child.stdout.on('data', (d) => { const s = d.toString('utf8').trim(); if (s) log(`[WinBridge] ${s}`); });
      child.stderr.on('data', (d) => { const s = d.toString('utf8').trim(); if (s) log(`[WinBridge:ERR] ${s}`); });
      child.on('exit', () => { this.winProc = null; this.startingWin = false; });
      this.winProc = child;
      this.startingWin = false;
    } catch (_) {
      this.startingWin = false;
    }
  }

  _sendWin(cmdObj) {
    if (!this.winProc) this._spawnWinBridge();
    if (this.winProc && this.winProc.stdin && !this.winProc.stdin.destroyed) {
      try { this.winProc.stdin.write(JSON.stringify(cmdObj) + '\n', 'utf8'); } catch (_) {}
    }
  }

  _runMacJxa(reqObj, cb) {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', MAC_JXA_SCRIPT, JSON.stringify(reqObj)],
      { timeout: 3500 },
      (err, stdout) => {
        if (err) { if (cb) cb(null); return; }
        const out = String(stdout || '').trim();
        if (cb) { try { cb(JSON.parse(out)); } catch (_) { cb(null); } }
      }
    );
  }

  _macClipboardWrite(text, done) {
    try {
      const pb = spawn('/usr/bin/pbcopy', [], {
        env: { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8' },
        stdio: ['pipe', 'ignore', 'ignore']
      });
      pb.stdin.write(String(text), 'utf8');
      pb.stdin.end();
      pb.on('close', () => done && done());
      pb.on('error', () => done && done());
    } catch (_) { if (done) done(); }
  }

  focusApp(launchIfMissing = false, cwd = '') {
    if (IS_WIN) this._sendWin({ cmd: 'focus', launchIfMissing, cwd });
    else if (IS_MAC) this._runMacJxa({ cmd: 'focus', launchIfMissing, cwd });
  }

  sendLogicalKey(actionKey, focus = true, requireCoding = true) {
    if (IS_WIN) {
      const winMap = { screen_snip: 'win+shift+s', voice: 'win+h' };
      this._sendWin({ cmd: 'key', combo: winMap[actionKey] || actionKey, focus, requireCoding });
    } else if (IS_MAC) {
      this._runMacJxa({ cmd: 'key', combo: actionKey, focus, requireCoding });
    }
  }

  sendText(text, enter = true, focus = true, requireCoding = true) {
    if (IS_WIN) {
      this._sendWin({ cmd: 'text', text, enter, focus, requireCoding });
      return;
    }
    if (IS_MAC) {
      this._runMacJxa({ cmd: 'focus', launchIfMissing: false }, (res) => {
        if (requireCoding && (!res || !res.foundCoding)) return;
        execFile(
          '/usr/bin/pbpaste',
          [],
          { env: { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8' }, timeout: 1000 },
          (pbErr, prevClip) => {
            const hadPrev = !pbErr && typeof prevClip === 'string';
            this._macClipboardWrite(text, () => {
              this._runMacJxa(
                { cmd: 'key', combo: enter ? 'cmd+v+enter' : 'cmd+v', focus, requireCoding: false },
                () => { if (hadPrev) setTimeout(() => this._macClipboardWrite(prevClip), 220); }
              );
            });
          }
        );
      });
    }
  }

  launchAgy(cwd = '') {
    let safeCwd = '';
    try { if (cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) safeCwd = cwd; } catch (_) {}
    if (IS_WIN) this._sendWin({ cmd: 'launch_agy', cwd: safeCwd });
    else if (IS_MAC) this._runMacJxa({ cmd: 'launch_agy', cwd: safeCwd });
  }
}

const bridge = new PlatformBridge();

// ============================================================================
// 4. Antigravity Settings, Hooks (~/.gemini/config/hooks.json) & Live Transcript Watcher
// ============================================================================
const MODEL_ORDER = ['argon', 'flash', 'sonnet', 'opus', 'auto'];
const MODEL_META = {
  argon:  { short: 'GEMINI 4',   chip: 'G4',   cliArg: 'gemini-4-argon',    color: '#60A5FA', border: '#3B82F6' },
  flash:  { short: 'FLASH 3.8',  chip: 'F3.8', cliArg: 'gemini-3.8-flash',  color: '#22D3EE', border: '#06B6D4' },
  sonnet: { short: 'SONNET 5.5', chip: 'S5.5', cliArg: 'claude-sonnet-5-5', color: '#FF8B66', border: '#D97757' },
  opus:   { short: 'OPUS 5.5',   chip: 'O5.5', cliArg: 'claude-opus-5-5',   color: '#C084FC', border: '#A855F7' },
  auto:   { short: 'AUTO',       chip: 'AUTO', cliArg: 'auto',              color: '#34D399', border: '#10B981' }
};

const THINKING_ORDER = ['low', 'medium', 'high'];
const THINKING_META = {
  low:    { label: 'LOW',  kor: '추론 LOW',  bars: 1, color: '#CBD5E1', border: '#94A3B8' },
  medium: { label: 'MED',  kor: '추론 MED',  bars: 2, color: '#60A5FA', border: '#3B82F6' },
  high:   { label: 'HIGH', kor: '추론 HIGH', bars: 3, color: '#22D3EE', border: '#06B6D4' }
};

const POLICY_ORDER = ['request-review', 'proceed-in-sandbox', 'always-proceed'];
const POLICY_META = {
  'request-review':     { label: '검토실행', color: '#60A5FA', border: '#3B82F6' },
  'proceed-in-sandbox': { label: '샌드박스', color: '#34D399', border: '#10B981' },
  'always-proceed':     { label: '자율진행', color: '#FBBF24', border: '#F59E0B' }
};

const agent = {
  state: 'IDLE',
  currentTool: '대기',
  rawToolName: '',
  waitingDetail: '',
  toolCount: 0,
  subagentCount: 0,
  turnStartedAt: 0,
  lastDurationSec: 0,
  cwdName: 'workspace',
  cwdFull: '',
  model: 'argon',
  thinkingLevel: 'high',
  execPolicy: 'request-review',
  sandboxEnabled: true,
  hooksInstalled: false,
  tick: 0
};

function normalizeModelName(raw) {
  if (!raw) return 'argon';
  const s = String(raw).toLowerCase().trim();
  if (s === 'auto') return 'auto';
  if (s.includes('flash')) return 'flash';
  if (s.includes('sonnet')) return 'sonnet';
  if (s.includes('opus')) return 'opus';
  return 'argon';
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    return {};
  }
}

function syncFromAgySettings() {
  const s = readJsonSafe(AGY_CLI_SETTINGS);
  if (s.model) agent.model = normalizeModelName(s.model);
  if (s.thinkingLevel && THINKING_META[s.thinkingLevel]) agent.thinkingLevel = s.thinkingLevel;
  if (s.executionPolicy && POLICY_META[s.executionPolicy]) agent.execPolicy = s.executionPolicy;
  if (typeof s.sandbox === 'boolean') agent.sandboxEnabled = s.sandbox;

  const h = readJsonSafe(AGY_HOOKS_JSON);
  agent.hooksInstalled = Boolean(h['streamdock-agy'] && h['streamdock-agy'].enabled !== false);
}

function updateAgyCliSettings(mutator) {
  try {
    fs.mkdirSync(path.dirname(AGY_CLI_SETTINGS), { recursive: true });
    const cur = readJsonSafe(AGY_CLI_SETTINGS);
    mutator(cur);
    fs.writeFileSync(AGY_CLI_SETTINGS, JSON.stringify(cur, null, 2) + '\n', 'utf8');
  } catch (err) {
    log(`updateAgyCliSettings error: ${err.message}`);
  }
}

function installOrRepairAgyHooks() {
  try {
    fs.mkdirSync(AGY_GLOBAL_CFG_DIR, { recursive: true });
    if (fs.existsSync(BUNDLED_HOOK_SCRIPT)) {
      fs.copyFileSync(BUNDLED_HOOK_SCRIPT, AGY_HOOK_SCRIPT);
    }
    if (!IS_WIN) {
      try { fs.chmodSync(AGY_HOOK_SCRIPT, 0o755); } catch (_) {}
    }

    const nodeExe = process.execPath;
    const mkCmd = (ev) => `"${nodeExe}" "${AGY_HOOK_SCRIPT}" ${ev}`;

    const hooksDoc = readJsonSafe(AGY_HOOKS_JSON);
    hooksDoc['streamdock-agy'] = {
      enabled: true,
      SessionStart: [{ type: 'command', command: mkCmd('SessionStart'), timeout: 5 }],
      PreInvocation: [{ type: 'command', command: mkCmd('PreInvocation'), timeout: 5 }],
      PostToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: mkCmd('PostToolUse'), timeout: 5 }]
        }
      ],
      Stop: [{ type: 'command', command: mkCmd('Stop'), timeout: 5 }]
    };
    fs.writeFileSync(AGY_HOOKS_JSON, JSON.stringify(hooksDoc, null, 2) + '\n', 'utf8');
    syncFromAgySettings();
    log(`Antigravity hooks installed at ${AGY_HOOKS_JSON}`);
    return true;
  } catch (err) {
    log(`installOrRepairAgyHooks error: ${err.message}`);
    return false;
  }
}

syncFromAgySettings();
if (!agent.hooksInstalled) {
  installOrRepairAgyHooks();
}

// --- Zero-Config Live Transcript Tail Watcher (~/.gemini/antigravity/brain/*/transcript.jsonl) ---
let watchedTranscriptPath = '';
let watchedTranscriptSize = -1;
let bootInitialized = false;

function mapAgyToolLabel(toolName) {
  const t = String(toolName || '').toLowerCase();
  if (t.includes('run_command')) return '터미널';
  if (t.includes('edit_file') || t.includes('write_file')) return '코드편집';
  if (t.includes('read_file')) return '파일읽기';
  if (t.includes('search_web')) return '웹검색';
  if (t.includes('subagent')) return '서브에이전트';
  if (t.includes('ask_question')) return '질문대기';
  if (t.includes('browser')) return '브라우저';
  return toolName || '실행중';
}

function pollActiveAgyTranscript() {
  try {
    const roots = [
      path.join(GEMINI_DIR, 'antigravity', 'brain'),
      path.join(GEMINI_DIR, 'antigravity-ide', 'brain'),
      path.join(GEMINI_DIR, 'antigravity-cli', 'brain')
    ];
    let newestFile = '';
    let newestMtime = 0;

    for (const r of roots) {
      if (!fs.existsSync(r)) continue;
      for (const d of fs.readdirSync(r)) {
        const candidate = path.join(r, d, '.system_generated', 'logs', 'transcript.jsonl');
        try {
          const st = fs.statSync(candidate);
          if (st.mtimeMs > newestMtime) {
            newestMtime = st.mtimeMs;
            newestFile = candidate;
          }
        } catch (_) {}
      }
    }

    if (!newestFile) {
      bootInitialized = true;
      return;
    }

    const stat = fs.statSync(newestFile);
    if (!bootInitialized) {
      // Record current EOF on startup so we only react to live activity
      watchedTranscriptPath = newestFile;
      watchedTranscriptSize = stat.size;
      bootInitialized = true;
      return;
    }

    if (newestFile === watchedTranscriptPath && stat.size === watchedTranscriptSize) {
      return;
    }

    watchedTranscriptPath = newestFile;
    watchedTranscriptSize = stat.size;

    const readLen = Math.min(stat.size, 12288);
    const fd = fs.openSync(newestFile, 'r');
    const buf = Buffer.allocUnsafe(readLen);
    fs.readSync(fd, buf, 0, readLen, stat.size - readLen);
    fs.closeSync(fd);

    const lines = buf.toString('utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return;
    const lastStep = JSON.parse(lines[lines.length - 1]);
    const stepType = String(lastStep.type || '');
    const toolCalls = Array.isArray(lastStep.tool_calls) ? lastStep.tool_calls : [];

    if (stepType === 'USER_INPUT') {
      agent.state = 'RUNNING';
      agent.turnStartedAt = Date.now();
      agent.toolCount = 0;
      agent.rawToolName = 'Think';
      agent.currentTool = '추론중';
      renderAllContexts();
      broadcastStateToPI();
    } else if (stepType === 'PLANNER_RESPONSE') {
      if (toolCalls.length > 0) {
        const lastTc = toolCalls[toolCalls.length - 1];
        const tName = String(lastTc.name || lastTc.tool_name || '');
        if (tName.includes('ask_question')) {
          agent.state = 'WAITING_INPUT';
          agent.rawToolName = 'ask_question';
          agent.currentTool = '질문대기';
        } else if (JSON.stringify(lastTc).includes('"RequestFeedback":true')) {
          agent.state = 'WAITING_PERMISSION';
          agent.rawToolName = 'artifact';
          agent.currentTool = '플랜승인';
        } else {
          agent.state = 'RUNNING';
          if (!agent.turnStartedAt) agent.turnStartedAt = Date.now();
          agent.toolCount += toolCalls.length;
          agent.rawToolName = tName;
          agent.currentTool = mapAgyToolLabel(tName);
        }
      } else if (lastStep.status === 'DONE') {
        if (agent.turnStartedAt > 0) {
          agent.lastDurationSec = Math.max(1, Math.round((Date.now() - agent.turnStartedAt) / 1000));
        }
        agent.turnStartedAt = 0;
        agent.state = 'COMPLETED';
        agent.currentTool = '완료';
      }
      renderAllContexts();
      broadcastStateToPI();
    }
  } catch (_) {}
}

setInterval(pollActiveAgyTranscript, 1200);

// ============================================================================
// 5. Hook Event Processing & Simulator
// ============================================================================
function handleHookEvent(payload) {
  if (!payload || typeof payload !== 'object') return;
  const evt = String(payload.hook_event_name || payload.event || '').trim();

  if (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]) {
    agent.cwdFull = String(payload.workspacePaths[0]);
    agent.cwdName = path.basename(agent.cwdFull) || 'workspace';
  }
  if (payload.modelName && payload.modelName !== 'auto') {
    agent.model = normalizeModelName(payload.modelName);
  }

  switch (evt) {
    case 'SessionStart':
      agent.state = 'IDLE';
      agent.turnStartedAt = 0;
      agent.toolCount = 0;
      agent.currentTool = '대기';
      break;
    case 'PreInvocation':
      agent.state = 'RUNNING';
      if (!agent.turnStartedAt) agent.turnStartedAt = Date.now();
      agent.rawToolName = 'Think';
      agent.currentTool = '추론중';
      break;
    case 'PostToolUse': {
      agent.state = 'RUNNING';
      if (!agent.turnStartedAt) agent.turnStartedAt = Date.now();
      agent.toolCount += 1;
      const tName = (payload.toolCall && payload.toolCall.name) || payload.tool_name || '';
      agent.rawToolName = tName;
      agent.currentTool = mapAgyToolLabel(tName);
      break;
    }
    case 'Stop':
      if (agent.turnStartedAt > 0) {
        agent.lastDurationSec = Math.max(1, Math.round((Date.now() - agent.turnStartedAt) / 1000));
      }
      agent.turnStartedAt = 0;
      agent.state = payload.terminationReason === 'USER_CANCELED' ? 'IDLE' : 'COMPLETED';
      agent.currentTool = agent.state === 'COMPLETED' ? '완료' : '중단됨';
      break;
    default:
      break;
  }

  renderAllContexts();
  broadcastStateToPI();
}

function applySimulatedState(targetState) {
  const s = String(targetState || 'IDLE').toUpperCase();
  if (s === 'IDLE') {
    agent.state = 'IDLE';
    agent.turnStartedAt = 0;
    agent.rawToolName = '';
    agent.currentTool = '대기';
  } else if (s === 'RUNNING') {
    agent.state = 'RUNNING';
    agent.turnStartedAt = Date.now() - 12000;
    agent.toolCount = Math.max(4, agent.toolCount);
    agent.rawToolName = 'edit_file';
    agent.currentTool = '코드편집';
  } else if (s === 'WAITING_PERMISSION') {
    agent.state = 'WAITING_PERMISSION';
    agent.rawToolName = 'artifact';
    agent.currentTool = '플랜승인';
  } else if (s === 'WAITING_INPUT') {
    agent.state = 'WAITING_INPUT';
    agent.rawToolName = 'ask_question';
    agent.currentTool = '질문대기';
  } else if (s === 'COMPLETED') {
    agent.state = 'COMPLETED';
    agent.lastDurationSec = 15;
    agent.turnStartedAt = 0;
    agent.toolCount = Math.max(6, agent.toolCount);
    agent.currentTool = '완료';
  }
  renderAllContexts();
  broadcastStateToPI();
}

// ============================================================================
// 6. Pure Vector SVG Icon Library (Antigravity Theme)
// ============================================================================
const FONT_FAMILY =
  "'Apple SD Gothic Neo','Pretendard','Malgun Gothic',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

function escXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function charUnits(str) {
  let u = 0;
  for (const ch of String(str ?? '')) {
    const code = ch.charCodeAt(0);
    if (code > 0x2e80) u += 1.0;
    else if (code > 0x7f) u += 0.85;
    else if (/[A-Z0-9/_&]/.test(ch)) u += 0.63;
    else u += 0.53;
  }
  return u;
}

function fitFont(text, maxFont = 24.5, minFont = 16, safePx = 120) {
  const u = Math.max(1, charUnits(text));
  return Math.max(minFont, Math.min(maxFont, Math.floor(safePx / u)));
}

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const VEC = {
  agyOrbit(col) {
    return `
      <g transform="rotate(-24 72 52)">
        <ellipse cx="72" cy="52" rx="34" ry="13" fill="none" stroke="${col}" stroke-width="5" stroke-opacity="0.85"/>
      </g>
      <path d="M 72 21 Q 75 45 99 52 Q 75 59 72 83 Q 69 59 45 52 Q 69 45 72 21 Z" fill="${col}"/>
      <circle cx="98" cy="36" r="4.5" fill="#22D3EE"/>
    `;
  },

  spinner(col, tick) {
    const angle = (tick * 90) % 360;
    return `
      <circle cx="72" cy="52" r="27" fill="none" stroke="${col}" stroke-opacity="0.22" stroke-width="6.5"/>
      <g transform="rotate(${angle} 72 52)">
        <path d="M 72 25 A 27 27 0 1 1 46.5 61" fill="none" stroke="${col}" stroke-width="7" stroke-linecap="round"/>
      </g>
      <circle cx="72" cy="52" r="8" fill="${col}"/>
    `;
  },

  warningTriangle(col) {
    return `
      <path d="M 72 20 L 105 77 Q 107 82 101 82 L 43 82 Q 37 82 39 77 Z" fill="${col}" stroke="#000000" stroke-width="3" stroke-linejoin="round"/>
      <line x1="72" y1="40" x2="72" y2="59" stroke="#0B0B0C" stroke-width="7" stroke-linecap="round"/>
      <circle cx="72" cy="70.5" r="4.2" fill="#0B0B0C"/>
    `;
  },

  questionBubble(col) {
    return `
      <rect x="40" y="23" width="64" height="50" rx="15" fill="none" stroke="${col}" stroke-width="6"/>
      <path d="M 57 73 L 49 85 L 69 73" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M 64 41 C 64 34 80 34 80 43 C 80 49 72 50 72 56" fill="none" stroke="#FFFFFF" stroke-width="5.5" stroke-linecap="round"/>
      <circle cx="72" cy="64.5" r="3.4" fill="#FFFFFF"/>
    `;
  },

  checkCircle(col) {
    return `
      <circle cx="72" cy="52" r="28" fill="${col}" fill-opacity="0.2" stroke="${col}" stroke-width="6"/>
      <polyline points="56,52 67,64 89,40" fill="none" stroke="${col}" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  },

  bigCheck(col) {
    return `
      <rect x="40" y="22" width="64" height="58" rx="16" fill="${col}" fill-opacity="0.16" stroke="${col}" stroke-width="5.5"/>
      <polyline points="53,52 66,65 92,38" fill="none" stroke="${col}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  },

  doubleCheck(col) {
    return `
      <polyline points="38,54 50,67 74,38" fill="none" stroke="${col}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
      <polyline points="60,54 72,67 98,38" fill="none" stroke="${col}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  },

  stopCross(col) {
    return `
      <circle cx="72" cy="52" r="28" fill="${col}" fill-opacity="0.18" stroke="${col}" stroke-width="6"/>
      <line x1="59" y1="39" x2="85" y2="65" stroke="${col}" stroke-width="7.5" stroke-linecap="round"/>
      <line x1="85" y1="39" x2="59" y2="65" stroke="${col}" stroke-width="7.5" stroke-linecap="round"/>
    `;
  },

  shield(col) {
    return `
      <path d="M 72 21 L 99 32 V 52 C 99 69 87 80 72 85 C 57 80 45 69 45 52 V 32 Z" fill="${col}" fill-opacity="0.16" stroke="${col}" stroke-width="5.8" stroke-linejoin="round"/>
      <polyline points="61,53 69,61 84,44" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  },

  bolt(col) {
    return `<polygon points="78,20 48,56 69,56 64,85 95,48 74,48" fill="${col}" stroke="#000000" stroke-width="2.5" stroke-linejoin="round"/>`;
  },

  blueprint(col) {
    return `
      <rect x="42" y="25" width="60" height="54" rx="10" fill="${col}" fill-opacity="0.14" stroke="${col}" stroke-width="5.5"/>
      <circle cx="56" cy="41" r="4" fill="${col}"/>
      <line x1="66" y1="41" x2="90" y2="41" stroke="${col}" stroke-width="5" stroke-linecap="round"/>
      <circle cx="56" cy="55" r="4" fill="${col}"/>
      <line x1="66" y1="55" x2="84" y2="55" stroke="${col}" stroke-width="5" stroke-linecap="round"/>
      <circle cx="56" cy="68" r="4" fill="${col}"/>
      <line x1="66" y1="68" x2="90" y2="68" stroke="${col}" stroke-width="5" stroke-linecap="round"/>
    `;
  },

  rocketBoost(col) {
    return `
      <path d="M 72 19 C 86 31 90 49 86 66 L 58 66 C 54 49 58 31 72 19 Z" fill="${col}" fill-opacity="0.22" stroke="${col}" stroke-width="5.5" stroke-linejoin="round"/>
      <path d="M 58 56 L 45 68 L 58 68 Z" fill="${col}"/>
      <path d="M 86 56 L 99 68 L 86 68 Z" fill="${col}"/>
      <circle cx="72" cy="44" r="6" fill="#FFFFFF"/>
      <path d="M 65 73 L 72 86 L 79 73" fill="none" stroke="#FBBF24" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  },

  aiChip(col, chipText) {
    const pins = [56, 72, 88]
      .map(
        (p) => `
        <line x1="${p}" y1="17" x2="${p}" y2="26" stroke="${col}" stroke-width="5" stroke-linecap="round"/>
        <line x1="${p}" y1="78" x2="${p}" y2="87" stroke="${col}" stroke-width="5" stroke-linecap="round"/>
        <line x1="35" y1="${p - 20}" x2="44" y2="${p - 20}" stroke="${col}" stroke-width="5" stroke-linecap="round"/>
        <line x1="100" y1="${p - 20}" x2="109" y2="${p - 20}" stroke="${col}" stroke-width="5" stroke-linecap="round"/>`
      )
      .join('');
    return `
      ${pins}
      <rect x="44" y="26" width="56" height="52" rx="12" fill="#141417" stroke="${col}" stroke-width="5.5"/>
      <text x="72" y="59" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="18.5" font-weight="900" fill="${col}">${escXml(chipText)}</text>
    `;
  },

  effortBars(activeBars, col) {
    return [1, 2, 3]
      .map((n) => {
        const x = 40 + (n - 1) * 24;
        const h = 20 + n * 14;
        const y = 82 - h;
        const fill = n <= activeBars ? col : '#27272A';
        return `<rect x="${x}" y="${y}" width="16" height="${h}" rx="4" fill="${fill}" stroke="#000000" stroke-width="1.5"/>`;
      })
      .join('');
  },

  compress(col) {
    return `
      <polyline points="42,26 60,44 45,44 60,44 60,29" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      <polyline points="102,26 84,44 99,44 84,44 84,29" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      <polyline points="42,78 60,60 45,60 60,60 60,75" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      <polyline points="102,78 84,60 99,60 84,60 84,75" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="65" y="47" width="14" height="10" rx="3" fill="${col}"/>
    `;
  },

  mic(col) {
    return `
      <rect x="61" y="21" width="22" height="36" rx="11" fill="${col}"/>
      <path d="M 50 47 A 22 22 0 0 0 94 47" fill="none" stroke="${col}" stroke-width="5.5" stroke-linecap="round"/>
      <line x1="72" y1="69" x2="72" y2="82" stroke="${col}" stroke-width="5.5" stroke-linecap="round"/>
      <line x1="57" y1="82" x2="87" y2="82" stroke="${col}" stroke-width="5.5" stroke-linecap="round"/>
    `;
  },

  screenshotFrame(col) {
    return `
      <rect x="40" y="26" width="64" height="52" rx="11" fill="${col}" fill-opacity="0.14" stroke="${col}" stroke-width="5.5"/>
      <circle cx="57" cy="43" r="5.5" fill="${col}"/>
      <polyline points="44,72 62,54 74,65 84,55 100,72" fill="none" stroke="${col}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  },

  wrenchFix(col) {
    return `
      <path d="M 85 24 A 16 16 0 0 0 65 43 L 44 64 A 7 7 0 0 0 54 74 L 75 53 A 16 16 0 0 0 94 33 L 86 41 L 77 32 Z" fill="${col}" fill-opacity="0.22" stroke="${col}" stroke-width="5.2" stroke-linejoin="round"/>
      <polyline points="78,64 86,72 101,56" fill="none" stroke="#34D399" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  },

  gitGraph(col) {
    return `
      <line x1="56" y1="32" x2="56" y2="74" stroke="${col}" stroke-width="6" stroke-linecap="round"/>
      <path d="M 56 62 C 56 48 88 52 88 38" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round"/>
      <circle cx="56" cy="29" r="8" fill="#0B0B0C" stroke="${col}" stroke-width="5.5"/>
      <circle cx="56" cy="75" r="8" fill="#0B0B0C" stroke="${col}" stroke-width="5.5"/>
      <circle cx="88" cy="34" r="8" fill="${col}"/>
    `;
  },

  terminalPrompt(col) {
    return `
      <rect x="38" y="24" width="68" height="54" rx="12" fill="${col}" fill-opacity="0.14" stroke="${col}" stroke-width="5.5"/>
      <polyline points="51,41 64,51 51,61" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      <line x1="71" y1="61" x2="89" y2="61" stroke="${col}" stroke-width="6" stroke-linecap="round"/>
    `;
  },

  codeEdit(col) {
    return `
      <polyline points="54,36 39,52 54,68" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      <polyline points="90,36 105,52 90,68" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      <line x1="78" y1="30" x2="66" y2="74" stroke="#FFFFFF" stroke-width="5.5" stroke-linecap="round"/>
    `;
  },

  searchLens(col) {
    return `
      <circle cx="67" cy="47" r="20" fill="${col}" fill-opacity="0.16" stroke="${col}" stroke-width="6"/>
      <line x1="82" y1="62" x2="99" y2="79" stroke="${col}" stroke-width="7" stroke-linecap="round"/>
    `;
  },

  linkNodes(col) {
    return `
      <line x1="72" y1="32" x2="50" y2="68" stroke="${col}" stroke-width="5"/>
      <line x1="72" y1="32" x2="94" y2="68" stroke="${col}" stroke-width="5"/>
      <line x1="50" y1="68" x2="94" y2="68" stroke="${col}" stroke-width="5"/>
      <circle cx="72" cy="31" r="9" fill="${col}"/>
      <circle cx="50" cy="68" r="8" fill="#0B0B0C" stroke="${col}" stroke-width="5"/>
      <circle cx="94" cy="68" r="8" fill="#0B0B0C" stroke="${col}" stroke-width="5"/>
    `;
  }
};

function svgIconTile({
  bg = '#0B0B0C',
  border = '#3F3F46',
  borderWidth = 4.5,
  glowColor = '',
  iconSvg = '',
  label = '',
  labelColor = '#FFFFFF',
  badge = '',
  badgeColor = '#FFFFFF',
  badgeBg = '#18181B',
  extraBottomSvg = '',
  iconOnly = false
}) {
  const glowCy = iconOnly ? 72 : 52;
  const glow = glowColor
    ? `<circle cx="72" cy="${glowCy}" r="${iconOnly ? 44 : 35}" fill="${glowColor}" fill-opacity="0.20"/>`
    : '';
  const iconTransform = iconOnly
    ? 'translate(72,72) scale(1.26) translate(-72,-52)'
    : extraBottomSvg
      ? 'translate(72,47) scale(0.95) translate(-72,-52)'
      : '';

  const badgeWidth = Math.max(36, Math.round(charUnits(badge) * 14 + 16));
  const badgeX = 132 - badgeWidth;
  const badgeBlock = badge
    ? `<rect x="${badgeX}" y="11" width="${badgeWidth}" height="24" rx="8" fill="${badgeBg}" stroke="${border}" stroke-width="1.5"/>
       <text x="${badgeX + badgeWidth / 2}" y="28" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="13.5" font-weight="900" fill="${badgeColor}">${escXml(badge)}</text>`
    : '';

  const fontSize = fitFont(label, 24.5, 17, 120);
  const labelY = extraBottomSvg ? 114 : 121;
  const labelBlock =
    !iconOnly && label
      ? `<text x="72" y="${labelY}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="900" letter-spacing="-0.5" fill="${labelColor}" stroke="#000000" stroke-width="4.2" paint-order="stroke fill" stroke-linejoin="round">${escXml(label)}</text>`
      : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect x="3" y="3" width="138" height="138" rx="25" fill="${bg}" stroke="${border}" stroke-width="${borderWidth}"/>
    ${glow}
    <g transform="${iconTransform}">${iconSvg}</g>
    ${badgeBlock}
    ${labelBlock}
    ${iconOnly ? '' : extraBottomSvg}
  </svg>`;
}

function renderStatusSvg(settings = {}, flashed = false) {
  const mode = settings.panelMode || 'overview';
  const iconOnly = settings.displayStyle === 'icon_only';
  const pulseOn = agent.tick % 2 === 0;
  const elapsedSec = agent.turnStartedAt ? (Date.now() - agent.turnStartedAt) / 1000 : 0;

  if (mode === 'activity') {
    let bg = '#0B0B0C', border = '#52525B', col = '#94A3B8';
    let icon = VEC.terminalPrompt('#94A3B8');
    let label = '대기중', labelColor = '#E2E8F0', badge = 'AGY';

    if (agent.state === 'RUNNING') {
      bg = '#071E2E'; border = '#38BDF8'; col = '#38BDF8';
      const tn = (agent.rawToolName || '').toLowerCase();
      if (tn.includes('edit') || tn.includes('write')) icon = VEC.codeEdit('#38BDF8');
      else if (tn.includes('read') || tn.includes('search')) icon = VEC.searchLens('#38BDF8');
      else if (tn.includes('subagent')) icon = VEC.linkNodes('#38BDF8');
      else icon = VEC.terminalPrompt('#38BDF8');
      label = agent.currentTool || '실행중';
      labelColor = '#FFFFFF';
      badge = `${agent.toolCount}`;
    } else if (agent.state === 'WAITING_PERMISSION') {
      bg = pulseOn ? '#3B1D02' : '#1C0E02'; border = pulseOn ? '#FDE047' : '#F59E0B'; col = '#FDE047';
      icon = VEC.warningTriangle('#FACC15'); label = '플랜승인'; labelColor = '#FEF08A'; badge = '!';
    } else if (agent.state === 'WAITING_INPUT') {
      bg = pulseOn ? '#3B1219' : '#1C080C'; border = pulseOn ? '#FB923C' : '#F43F5E'; col = '#FB923C';
      icon = VEC.questionBubble('#FB923C'); label = '질문대기'; labelColor = '#FEF08A'; badge = '?';
    } else if (agent.state === 'COMPLETED') {
      bg = '#05291A'; border = '#10B981'; col = '#34D399';
      icon = VEC.checkCircle('#34D399'); label = `${agent.toolCount}회 완료`; labelColor = '#A7F3D0';
      badge = agent.lastDurationSec ? `${agent.lastDurationSec}s` : '✓';
    }

    const urgent = agent.state === 'WAITING_PERMISSION' || agent.state === 'WAITING_INPUT';
    return svgIconTile({
      bg, border: flashed ? '#FFFFFF' : border, borderWidth: urgent ? 6 : 4.5,
      glowColor: col, iconSvg: icon, label, labelColor, badge, badgeColor: col, iconOnly
    });
  }

  if (mode === 'metrics') {
    const mMeta = MODEL_META[agent.model] || MODEL_META.argon;
    const tMeta = THINKING_META[agent.thinkingLevel] || THINKING_META.high;
    const pMeta = POLICY_META[agent.execPolicy] || POLICY_META['request-review'];
    return svgIconTile({
      bg: '#0B0B0C', border: flashed ? '#FFFFFF' : mMeta.border, borderWidth: 4.5,
      glowColor: mMeta.border, iconSvg: VEC.aiChip(mMeta.color, mMeta.chip),
      label: `${tMeta.label}·${pMeta.label}`, labelColor: '#FFFFFF', iconOnly
    });
  }

  let bg = '#0B0B0C', border = '#3B82F6', glow = '#3B82F6';
  let icon = VEC.agyOrbit('#60A5FA');
  let label = '대기', labelColor = '#FFFFFF', badge = '';

  if (agent.state === 'RUNNING') {
    bg = '#071E2E'; border = '#38BDF8'; glow = '#38BDF8';
    icon = VEC.spinner('#38BDF8', agent.tick);
    label = formatDuration(elapsedSec); labelColor = '#7DD3FC'; badge = 'RUN';
  } else if (agent.state === 'WAITING_PERMISSION') {
    bg = pulseOn ? '#422006' : '#1F1003'; border = pulseOn ? '#FDE047' : '#F59E0B'; glow = '#F59E0B';
    icon = VEC.warningTriangle(pulseOn ? '#FDE047' : '#F59E0B');
    label = '승인대기'; labelColor = '#FEF08A';
  } else if (agent.state === 'WAITING_INPUT') {
    bg = pulseOn ? '#431407' : '#1F0B05'; border = pulseOn ? '#FDBA74' : '#FB923C'; glow = '#FB923C';
    icon = VEC.questionBubble('#FB923C'); label = '질문대기'; labelColor = '#FEF08A';
  } else if (agent.state === 'COMPLETED') {
    bg = '#05291A'; border = '#10B981'; glow = '#10B981';
    icon = VEC.checkCircle('#34D399'); label = '완료'; labelColor = '#6EE7B7';
    badge = agent.lastDurationSec ? `${agent.lastDurationSec}s` : '';
  }

  const urgent = agent.state === 'WAITING_PERMISSION' || agent.state === 'WAITING_INPUT';
  return svgIconTile({
    bg, border: flashed ? '#FFFFFF' : border, borderWidth: urgent ? 6 : 4.5,
    glowColor: glow, iconSvg: icon, label, labelColor, badge, badgeColor: labelColor, iconOnly
  });
}

function renderApprovalSvg(settings = {}, flashed = false) {
  const type = settings.responseType || 'approve';
  const iconOnly = settings.displayStyle === 'icon_only';
  const pulseOn = agent.tick % 2 === 0;
  const waitingPerm = agent.state === 'WAITING_PERMISSION';
  const waitingAny = waitingPerm || agent.state === 'WAITING_INPUT';
  const activeRun = agent.state === 'RUNNING' || waitingAny;

  if (type === 'auto_proceed') {
    const col = waitingPerm ? (pulseOn ? '#FDE047' : '#2DD4BF') : '#2DD4BF';
    return svgIconTile({
      bg: waitingPerm && pulseOn ? '#06322D' : '#0B0B0C',
      border: flashed ? '#FFFFFF' : col, borderWidth: waitingPerm ? 6 : 4.5,
      glowColor: col, iconSvg: VEC.doubleCheck(col),
      label: '자동승인', labelColor: waitingPerm ? '#FEF08A' : '#FFFFFF',
      badge: 'AUTO', badgeColor: col, iconOnly
    });
  }

  if (type === 'reject') {
    const col = activeRun ? '#FB7185' : '#F43F5E';
    return svgIconTile({
      bg: activeRun ? '#2E0913' : '#0B0B0C',
      border: flashed ? '#FFFFFF' : col, borderWidth: activeRun ? 5.5 : 4.5,
      glowColor: col, iconSvg: VEC.stopCross(col),
      label: '중단', labelColor: '#FFFFFF', badge: 'ESC', badgeColor: '#FDA4AF', iconOnly
    });
  }

  const col = waitingAny ? (pulseOn ? '#34D399' : '#FACC15') : '#34D399';
  return svgIconTile({
    bg: waitingAny && pulseOn ? '#063321' : '#0B0B0C',
    border: flashed ? '#FFFFFF' : col, borderWidth: waitingAny ? 6 : 4.5,
    glowColor: col, iconSvg: VEC.bigCheck(col),
    label: '승인', labelColor: waitingAny ? '#FEF08A' : '#FFFFFF',
    badge: '⏎', badgeColor: col, iconOnly
  });
}

function renderModelSvg(settings = {}, flashed = false) {
  const mode = settings.modelMode || 'cycle';
  const iconOnly = settings.displayStyle === 'icon_only';
  const shownKey = mode === 'fixed' ? normalizeModelName(settings.targetModel) : agent.model;
  const meta = MODEL_META[shownKey] || MODEL_META.argon;

  const startCx = 72 - ((MODEL_ORDER.length - 1) * 15) / 2;
  const dots = mode === 'cycle'
    ? MODEL_ORDER.map((m, idx) => {
        const cx = startCx + idx * 15;
        const active = m === agent.model;
        return `<circle cx="${cx}" cy="128" r="${active ? 5 : 3.2}" fill="${active ? MODEL_META[m].color : '#3F3F46'}" stroke="#000000" stroke-width="1"/>`;
      }).join('')
    : '';

  return svgIconTile({
    bg: '#0B0B0C', border: flashed ? '#FFFFFF' : meta.border, borderWidth: 4.5,
    glowColor: meta.border, iconSvg: VEC.aiChip(meta.color, meta.chip),
    label: meta.short, labelColor: '#FFFFFF', extraBottomSvg: dots, iconOnly
  });
}

function renderModeSvg(settings = {}, flashed = false) {
  const sType = settings.settingType || 'exec_policy';
  const iconOnly = settings.displayStyle === 'icon_only';

  if (sType === 'thinking') {
    const tMeta = THINKING_META[agent.thinkingLevel] || THINKING_META.high;
    return svgIconTile({
      bg: '#0B0B0C', border: flashed ? '#FFFFFF' : tMeta.border, borderWidth: 4.5,
      glowColor: tMeta.border, iconSvg: VEC.effortBars(tMeta.bars, tMeta.color),
      label: tMeta.kor, labelColor: '#FFFFFF', iconOnly
    });
  }

  if (sType === 'sandbox') {
    const on = agent.sandboxEnabled;
    const col = on ? '#34D399' : '#F87171';
    return svgIconTile({
      bg: on ? '#05291A' : '#2E0913',
      border: flashed ? '#FFFFFF' : col, borderWidth: 4.5,
      glowColor: col, iconSvg: VEC.shield(col),
      label: on ? '샌드박스' : '제한해제', labelColor: '#FFFFFF',
      badge: on ? 'ON' : 'OFF', badgeColor: col, iconOnly
    });
  }

  const pMeta = POLICY_META[agent.execPolicy] || POLICY_META['request-review'];
  const icon = agent.execPolicy === 'always-proceed'
    ? VEC.bolt(pMeta.color)
    : agent.execPolicy === 'proceed-in-sandbox'
      ? VEC.shield(pMeta.color)
      : VEC.blueprint(pMeta.color);

  return svgIconTile({
    bg: '#0B0B0C', border: flashed ? '#FFFFFF' : pMeta.border, borderWidth: 4.5,
    glowColor: pMeta.border, iconSvg: icon, label: pMeta.label, labelColor: '#FFFFFF', iconOnly
  });
}

const CMD_PRESETS = {
  plan: {
    shortLabel: '플랜', border: '#A855F7',
    cmd: '/plan ', longCmd: '/grill-me ', defaultAutoEnter: false,
    iconFn: () => VEC.blueprint('#C084FC')
  },
  boost: {
    shortLabel: '부스트', border: '#F59E0B',
    cmd: '/boost ', longCmd: '/goal ', defaultAutoEnter: false,
    iconFn: () => VEC.rocketBoost('#FBBF24')
  },
  compact: {
    shortLabel: '압축', border: '#06B6D4',
    cmd: '/compact', longCmd: '/learn ', defaultAutoEnter: true,
    iconFn: () => VEC.compress('#22D3EE')
  },
  teamwork: {
    shortLabel: '팀워크', border: '#3B82F6',
    cmd: '/teamwork ', longCmd: '/browser ', defaultAutoEnter: false,
    iconFn: () => VEC.linkNodes('#60A5FA')
  },
  vibe_fix: {
    shortLabel: '빌드검증', border: '#0284C7',
    cmd: '전체 빌드와 테스트를 실행해 검증하고 실패한 부분이 있으면 원인을 찾아 수정해줘',
    longCmd: '', defaultAutoEnter: true,
    iconFn: () => VEC.wrenchFix('#38BDF8')
  },
  vibe_commit: {
    shortLabel: '커밋', border: '#10B981',
    cmd: 'git status와 diff를 확인해 변경사항을 요약하고 적절한 커밋 메시지로 git commit 해줘',
    longCmd: '/schedule ', defaultAutoEnter: true,
    iconFn: () => VEC.gitGraph('#34D399')
  }
};

function renderCommandSvg(settings = {}, flashed = false) {
  const presetKey = settings.preset || 'plan';
  const iconOnly = settings.displayStyle === 'icon_only';
  const preset = CMD_PRESETS[presetKey] || {
    shortLabel: settings.label || '명령', border: '#3B82F6',
    iconFn: () => VEC.terminalPrompt('#60A5FA')
  };
  const label = settings.label ? settings.label : preset.shortLabel;

  return svgIconTile({
    bg: '#0B0B0C', border: flashed ? '#FFFFFF' : preset.border, borderWidth: 4.5,
    glowColor: preset.border, iconSvg: preset.iconFn(), label, labelColor: '#FFFFFF', iconOnly
  });
}

function renderUtilitySvg(settings = {}, flashed = false) {
  const uType = settings.utilType || 'voice';
  const iconOnly = settings.displayStyle === 'icon_only';

  if (uType === 'screenshot') {
    return svgIconTile({
      bg: '#0B0B0C', border: flashed ? '#FFFFFF' : '#06B6D4', borderWidth: 4.5,
      glowColor: '#06B6D4', iconSvg: VEC.screenshotFrame('#22D3EE'),
      label: '스샷', labelColor: '#FFFFFF', badge: IS_MAC ? '⌘V' : 'Ctrl+V', badgeColor: '#67E8F9', iconOnly
    });
  }
  if (uType === 'launch') {
    return svgIconTile({
      bg: '#0B0B0C', border: flashed ? '#FFFFFF' : '#3B82F6', borderWidth: 4.5,
      glowColor: '#3B82F6', iconSvg: VEC.agyOrbit('#60A5FA'),
      label: 'AGY열기', labelColor: '#FFFFFF', iconOnly
    });
  }
  if (uType === 'install_hooks') {
    const col = agent.hooksInstalled ? '#34D399' : '#FBBF24';
    return svgIconTile({
      bg: '#0B0B0C', border: flashed ? '#FFFFFF' : col, borderWidth: 4.5,
      glowColor: col, iconSvg: VEC.linkNodes(col), label: '훅점검', labelColor: '#FFFFFF', iconOnly
    });
  }
  return svgIconTile({
    bg: '#0B0B0C', border: flashed ? '#FFFFFF' : '#EC4899', borderWidth: 4.5,
    glowColor: '#EC4899', iconSvg: VEC.mic('#F472B6'),
    label: '음성', labelColor: '#FFFFFF', badge: IS_MAC ? 'Fn' : 'Win+H', badgeColor: '#F9A8D4', iconOnly
  });
}

// ============================================================================
// 7. Stream Dock Context Management & Action Triggers
// ============================================================================
const contexts = new Map();
let sdWs = null;
const activePIConns = new Set();

function sendJson(obj) {
  if (sdWs && sdWs.readyState === 1) sdWs.send(JSON.stringify(obj));
}

function renderContext(ctx) {
  const entry = contexts.get(ctx);
  if (!entry) return;
  const flashed = entry.flashUntil > Date.now();
  let svg = '';

  switch (entry.action) {
    case 'com.vibecoding.antigravity.status':   svg = renderStatusSvg(entry.settings, flashed); break;
    case 'com.vibecoding.antigravity.approval': svg = renderApprovalSvg(entry.settings, flashed); break;
    case 'com.vibecoding.antigravity.model':    svg = renderModelSvg(entry.settings, flashed); break;
    case 'com.vibecoding.antigravity.mode':     svg = renderModeSvg(entry.settings, flashed); break;
    case 'com.vibecoding.antigravity.command':  svg = renderCommandSvg(entry.settings, flashed); break;
    case 'com.vibecoding.antigravity.utility':  svg = renderUtilitySvg(entry.settings, flashed); break;
    default: return;
  }

  if (svg !== entry.lastSvg) {
    entry.lastSvg = svg;
    sendJson({
      event: 'setImage',
      context: ctx,
      payload: { target: 0, image: 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svg) }
    });
  }
}

function renderAllContexts() {
  for (const ctx of contexts.keys()) renderContext(ctx);
}

function flashContext(ctx, ms = 420) {
  const entry = contexts.get(ctx);
  if (!entry) return;
  entry.flashUntil = Date.now() + ms;
  renderContext(ctx);
  setTimeout(() => renderContext(ctx), ms + 30);
}

function getPublicState() {
  const mMeta = MODEL_META[agent.model] || MODEL_META.argon;
  return {
    platform: process.platform,
    state: agent.state,
    currentTool: agent.currentTool,
    toolCount: agent.toolCount,
    elapsedSec: agent.turnStartedAt ? Math.round((Date.now() - agent.turnStartedAt) / 1000) : 0,
    lastDurationSec: agent.lastDurationSec,
    model: agent.model,
    modelDisplay: mMeta.short,
    modelId: mMeta.cliArg,
    thinkingLevel: agent.thinkingLevel,
    execPolicy: agent.execPolicy,
    hooksInstalled: agent.hooksInstalled,
    connectedContexts: contexts.size
  };
}

function broadcastStateToPI() {
  const snapshot = getPublicState();
  for (const ctx of activePIConns) {
    const entry = contexts.get(ctx);
    if (!entry) continue;
    sendJson({
      event: 'sendToPropertyInspector',
      action: entry.action,
      context: ctx,
      payload: { type: 'stateUpdate', state: snapshot }
    });
  }
}

function runLiveDemoSequence() {
  const steps = [
    { delay: 0,    state: 'RUNNING' },
    { delay: 1600, state: 'WAITING_PERMISSION' },
    { delay: 3600, state: 'COMPLETED' },
    { delay: 5600, state: 'IDLE' }
  ];
  for (const st of steps) setTimeout(() => applySimulatedState(st.state), st.delay);
}

function handleActionTrigger(ctx, isLongPress) {
  const entry = contexts.get(ctx);
  if (!entry) return;
  const s = entry.settings || {};
  flashContext(ctx);

  switch (entry.action) {
    case 'com.vibecoding.antigravity.status': {
      if (isLongPress) {
        const order = ['IDLE', 'RUNNING', 'WAITING_PERMISSION', 'WAITING_INPUT', 'COMPLETED'];
        applySimulatedState(order[(order.indexOf(agent.state) + 1) % order.length]);
      } else {
        if (agent.state === 'COMPLETED') {
          agent.state = 'IDLE';
          renderAllContexts();
        }
        bridge.focusApp(true, agent.cwdFull);
      }
      break;
    }

    case 'com.vibecoding.antigravity.approval': {
      const rType = s.responseType || 'approve';
      const autoFocus = s.autoFocusTerminal !== false;
      if (rType === 'auto_proceed') {
        if (isLongPress) bridge.sendLogicalKey('2', autoFocus);
        else bridge.sendText('남은 작업은 자동 승인해서 끝까지 진행해줘', true, autoFocus);
        if (agent.state === 'WAITING_PERMISSION' || agent.state === 'WAITING_INPUT') {
          agent.state = 'RUNNING';
          renderAllContexts();
        }
      } else if (rType === 'reject') {
        if (isLongPress) bridge.sendLogicalKey('ctrl+c', autoFocus);
        else bridge.sendLogicalKey('esc', autoFocus);
        if (agent.state !== 'IDLE') {
          agent.state = 'IDLE';
          agent.turnStartedAt = 0;
          renderAllContexts();
        }
      } else {
        if (isLongPress) bridge.sendText('진행해줘', true, autoFocus);
        else bridge.sendLogicalKey('enter', autoFocus);
        if (agent.state === 'WAITING_PERMISSION' || agent.state === 'WAITING_INPUT') {
          agent.state = 'RUNNING';
          renderAllContexts();
        }
      }
      break;
    }

    case 'com.vibecoding.antigravity.model': {
      let nextModel = 'argon';
      if ((s.modelMode || 'cycle') === 'fixed') nextModel = normalizeModelName(s.targetModel);
      else if (isLongPress) nextModel = 'argon';
      else nextModel = MODEL_ORDER[(MODEL_ORDER.indexOf(agent.model) + 1) % MODEL_ORDER.length];

      agent.model = nextModel;
      const cliId = MODEL_META[nextModel].cliArg;
      updateAgyCliSettings((cfg) => { cfg.model = cliId; });
      if (s.sendSlashCommand === true) {
        bridge.sendText(`/model ${cliId}`, true, true, true);
      }
      renderAllContexts();
      broadcastStateToPI();
      break;
    }

    case 'com.vibecoding.antigravity.mode': {
      const sType = s.settingType || 'exec_policy';
      if (sType === 'thinking') {
        const idx = THINKING_ORDER.indexOf(agent.thinkingLevel);
        agent.thinkingLevel = isLongPress ? 'high' : THINKING_ORDER[(idx + 1) % THINKING_ORDER.length];
        updateAgyCliSettings((cfg) => { cfg.thinkingLevel = agent.thinkingLevel; });
      } else if (sType === 'sandbox') {
        agent.sandboxEnabled = !agent.sandboxEnabled;
        updateAgyCliSettings((cfg) => { cfg.sandbox = agent.sandboxEnabled; });
      } else {
        const idx = POLICY_ORDER.indexOf(agent.execPolicy);
        agent.execPolicy = POLICY_ORDER[(idx + 1) % POLICY_ORDER.length];
        updateAgyCliSettings((cfg) => { cfg.executionPolicy = agent.execPolicy; });
      }
      renderAllContexts();
      broadcastStateToPI();
      break;
    }

    case 'com.vibecoding.antigravity.command': {
      const preset = CMD_PRESETS[s.preset || 'plan'] || CMD_PRESETS.plan;
      const primaryCmd = s.commandText !== undefined && s.commandText !== '' ? s.commandText : preset.cmd;
      const longCmd = s.longPressCommand !== undefined && s.longPressCommand !== '' ? s.longPressCommand : preset.longCmd;
      const chosen = isLongPress && longCmd ? longCmd : primaryCmd;
      const autoEnter = s.autoEnter !== undefined ? Boolean(s.autoEnter) : preset.defaultAutoEnter;
      if (chosen) {
        const shouldEnter = chosen.endsWith(' ') ? false : autoEnter;
        bridge.sendText(chosen, shouldEnter, true, true);
      }
      break;
    }

    case 'com.vibecoding.antigravity.utility': {
      const uType = s.utilType || 'voice';
      if (uType === 'voice') {
        bridge.sendLogicalKey('voice', true, false);
      } else if (uType === 'screenshot') {
        if (isLongPress) bridge.sendLogicalKey('screen_snip', false, false);
        else bridge.sendLogicalKey('image_paste', true, true);
      } else if (uType === 'launch') {
        if (isLongPress) bridge.launchAgy(agent.cwdFull);
        else bridge.focusApp(true, agent.cwdFull);
      } else if (uType === 'install_hooks') {
        installOrRepairAgyHooks();
        runLiveDemoSequence();
      }
      renderAllContexts();
      broadcastStateToPI();
      break;
    }

    default: break;
  }
}

setInterval(() => {
  agent.tick = (agent.tick + 1) % 100000;
  if (agent.state === 'RUNNING' || agent.state === 'WAITING_PERMISSION' || agent.state === 'WAITING_INPUT') {
    renderAllContexts();
  }
}, 900);

// ============================================================================
// 8. Local HTTP Server (127.0.0.1:17531) & Stream Dock WebSocket Bootstrap
// ============================================================================
const srv = http.createServer((req, res) => {
  const origin = String(req.headers.origin || '');
  if (origin && origin !== 'null' && !origin.startsWith('file://')) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'forbidden_origin' }));
    return;
  }

  if (req.method === 'GET' && req.url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, ...getPublicState() }));
    return;
  }

  if (req.method === 'POST' && (req.url === '/hook' || req.url === '/simulate')) {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', (c) => {
      totalBytes += c.length;
      if (totalBytes > 65536) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8').trim() || '{}');
        if (req.url === '/simulate') {
          if (body.demo) runLiveDemoSequence();
          else applySimulatedState(body.state || 'IDLE');
        } else {
          handleHookEvent(body);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state: agent.state }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end('{}');
});
srv.on('error', (e) => log(`HTTP 17531 error: ${e.message}`));
srv.listen(HTTP_PORT, '127.0.0.1', () => log(`AGY HTTP server on 127.0.0.1:${HTTP_PORT}`));

function parseCliArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '-port') out.port = argv[++i];
    else if (argv[i] === '-pluginUUID') out.pluginUUID = argv[++i];
    else if (argv[i] === '-registerEvent') out.registerEvent = argv[++i];
  }
  if (!out.port && argv[3]) out.port = argv[3];
  if (!out.pluginUUID && argv[5]) out.pluginUUID = argv[5];
  if (!out.registerEvent && argv[7]) out.registerEvent = argv[7];
  return out;
}

const cli = parseCliArgs(process.argv);
if (cli.port && cli.pluginUUID && cli.registerEvent) {
  sdWs = new MiniWebSocket(`ws://127.0.0.1:${cli.port}`);
  sdWs.onopen = () => sendJson({ event: cli.registerEvent, uuid: cli.pluginUUID });
  sdWs.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      const { event, action, context, payload } = msg;
      if (event === 'willAppear') {
        contexts.set(context, { action, settings: (payload && payload.settings) || {}, downAt: 0, flashUntil: 0, lastSvg: '' });
        renderContext(context);
      } else if (event === 'willDisappear') {
        contexts.delete(context); activePIConns.delete(context);
      } else if (event === 'didReceiveSettings') {
        const entry = contexts.get(context);
        if (entry) { entry.settings = (payload && payload.settings) || {}; entry.lastSvg = ''; renderContext(context); }
      } else if (event === 'keyDown') {
        const entry = contexts.get(context);
        if (entry) entry.downAt = Date.now();
      } else if (event === 'keyUp') {
        const entry = contexts.get(context);
        const held = entry && entry.downAt ? Date.now() - entry.downAt : 0;
        if (entry) entry.downAt = 0;
        handleActionTrigger(context, held >= 550);
      } else if (event === 'propertyInspectorDidAppear') {
        activePIConns.add(context);
        broadcastStateToPI();
      } else if (event === 'propertyInspectorDidDisappear') {
        activePIConns.delete(context);
      } else if (event === 'sendToPlugin' && payload) {
        if (payload.cmd === 'simulate') applySimulatedState(payload.state);
        else if (payload.cmd === 'demo') runLiveDemoSequence();
        else if (payload.cmd === 'installHooks') { installOrRepairAgyHooks(); renderAllContexts(); broadcastStateToPI(); }
        else if (payload.cmd === 'getState') broadcastStateToPI();
      }
    } catch (_) {}
  };
  sdWs.onclose = () => process.exit(0);
}
