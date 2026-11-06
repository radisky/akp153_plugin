'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

// ============================================================================
// 1. Platform Constants, Logging & Paths (OpenAI Codex - Win + macOS)
// ============================================================================
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const HOME_DIR = os.homedir();
const CODEX_DIR = path.join(HOME_DIR, '.codex');
const CODEX_CONFIG_TOML = path.join(CODEX_DIR, 'config.toml');
const CODEX_HOOKS_JSON = path.join(CODEX_DIR, 'hooks.json');
const CODEX_HOOKS_DIR = path.join(CODEX_DIR, 'hooks');
const CODEX_HOOK_SCRIPT = path.join(CODEX_HOOKS_DIR, 'streamdock_codex_notify.js');
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const BUNDLED_HOOK_SCRIPT = path.join(__dirname, 'streamdock_codex_notify.js');
const WIN_BRIDGE_SCRIPT = path.join(__dirname, 'win_bridge.ps1');
const LOG_FILE = path.join(__dirname, 'plugin_runtime.log');
const HTTP_PORT = Number(process.env.CODEX_SD_HTTP_PORT || 17532);

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
// 3. Cross-Platform Input & Window Focus Bridge (Prioritizing Codex CLI / App)
// ============================================================================
const MAC_JXA_SCRIPT = `
function run(argv) {
  const req = JSON.parse(argv[0]);
  const se = Application("System Events");
  const termNames = ["iTerm2", "iTerm", "Terminal", "Warp", "Ghostty", "wezterm-gui", "WezTerm", "Alacritty", "kitty"];
  const ideNames = ["Codex", "Cursor", "Code", "Visual Studio Code", "Windsurf", "Antigravity", "Zed"];

  function findCodexProc() {
    const procs = se.applicationProcesses.whose({ backgroundOnly: false })();
    let codexTerm = null, codexGui = null, anyTerm = null, anyIde = null;
    for (let i = 0; i < procs.length; i++) {
      const p = procs[i];
      let pName = "";
      try { pName = p.name(); } catch (e) { continue; }
      const isTerm = termNames.indexOf(pName) >= 0;
      const isIde = ideNames.indexOf(pName) >= 0;
      if (!isTerm && !isIde) continue;

      let hasCodex = pName.toLowerCase().indexOf("codex") >= 0;
      try {
        const wins = p.windows();
        for (let w = 0; w < wins.length; w++) {
          const wt = String(wins[w].name() || "").toLowerCase();
          if (wt.indexOf("codex") >= 0) { hasCodex = true; break; }
        }
      } catch (e) {}

      if (isTerm && hasCodex && !codexTerm) codexTerm = { proc: p, isGui: false };
      else if (isIde && hasCodex && !codexGui) codexGui = { proc: p, isGui: true };
      else if (isTerm && !anyTerm) anyTerm = { proc: p, isGui: false };
      else if (isIde && !anyIde) anyIde = { proc: p, isGui: true };
    }
    return codexTerm || codexGui || anyTerm || anyIde;
  }

  if (req.cmd === "focus") {
    const found = findCodexProc();
    if (found) {
      found.proc.frontmost = true;
      return JSON.stringify({ ok: true, foundCoding: true, isGui: found.isGui, target: found.proc.name() });
    }
    if (req.launchIfMissing) {
      const term = Application("Terminal");
      term.activate();
      return JSON.stringify({ ok: true, launched: true, target: "Terminal" });
    }
    return JSON.stringify({ ok: false, foundCoding: false });
  }

  if (req.cmd === "launch_codex") {
    const sqEsc = String.fromCharCode(39, 92, 39, 39);
    const cwdEsc = String(req.cwd || "").split("'").join(sqEsc);
    const cdPart = cwdEsc ? ("cd '" + cwdEsc + "' && ") : "";
    const shCmd = cdPart + "(command -v codex >/dev/null 2>&1 && codex || echo 'OpenAI Codex CLI Ready')";
    const term = Application("Terminal");
    term.activate();
    term.doScript(shCmd);
    return JSON.stringify({ ok: true, launched: "Terminal" });
  }

  if (req.cmd === "key") {
    const combo = String(req.combo || "").toLowerCase();
    const isGlobal = (combo === "voice" || combo === "screen_snip");
    const found = findCodexProc();
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
      case "y":         se.keystroke("y"); break;
      case "a":         se.keystroke("a"); break;
      case "2":         se.keystroke("2"); break;
      case "ctrl+c":    se.keyCode(8, { using: "control down" }); break;
      case "shift+tab": se.keyCode(48, { using: "shift down" }); break;
      case "image_paste":
        if (found && found.isGui) se.keyCode(9, { using: "command down" });
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

  launchCodex(cwd = '') {
    let safeCwd = '';
    try { if (cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) safeCwd = cwd; } catch (_) {}
    if (IS_WIN) this._sendWin({ cmd: 'launch_codex', cwd: safeCwd });
    else if (IS_MAC) this._runMacJxa({ cmd: 'launch_codex', cwd: safeCwd });
  }
}

const bridge = new PlatformBridge();

// ============================================================================
// 4. Codex Config (~/.codex/config.toml), Hooks (~/.codex/hooks.json) & Session Watcher
// ============================================================================
const MODEL_ORDER = ['sol', 'astra', 'terra', 'luna'];
const MODEL_META = {
  sol:   { short: 'GPT-6.1 SOL',   chip: 'SOL', cliArg: 'gpt-6.1-sol',   color: '#34D399', border: '#10B981' },
  astra: { short: 'GPT-6 ASTRA',   chip: 'AST', cliArg: 'gpt-6-astra',   color: '#C084FC', border: '#A855F7' },
  terra: { short: 'GPT-6.1 TERRA', chip: 'TER', cliArg: 'gpt-6.1-terra', color: '#38BDF8', border: '#0284C7' },
  luna:  { short: 'GPT-6 LUNA',    chip: 'LUN', cliArg: 'gpt-6-luna',    color: '#FBBF24', border: '#F59E0B' }
};

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'];
const EFFORT_META = {
  low:    { label: 'LOW',   kor: '추론 LOW',   bars: 1, color: '#CBD5E1', border: '#94A3B8' },
  medium: { label: 'MED',   kor: '추론 MED',   bars: 2, color: '#60A5FA', border: '#3B82F6' },
  high:   { label: 'HIGH',  kor: '추론 HIGH',  bars: 3, color: '#34D399', border: '#10B981' },
  xhigh:  { label: 'XHIGH', kor: '추론 XHIGH', bars: 4, color: '#FBBF24', border: '#F59E0B' }
};

const APPROVAL_ORDER = ['on-request', 'on-failure', 'never'];
const APPROVAL_META = {
  'on-request': { label: '요청승인', color: '#60A5FA', border: '#3B82F6' },
  'on-failure': { label: '자동수정', color: '#34D399', border: '#10B981' },
  'never':      { label: '완전자율', color: '#FBBF24', border: '#F59E0B' }
};

const SANDBOX_ORDER = ['workspace-write', 'read-only', 'danger-full-access'];
const SANDBOX_META = {
  'workspace-write':    { label: '쓰기허용', badge: 'RW',   color: '#34D399', border: '#10B981' },
  'read-only':          { label: '읽기전용', badge: 'RO',   color: '#60A5FA', border: '#3B82F6' },
  'danger-full-access': { label: '풀액세스', badge: 'FULL', color: '#F87171', border: '#EF4444' }
};

const agent = {
  state: 'IDLE',
  currentTool: '대기',
  rawToolName: '',
  toolCount: 0,
  turnStartedAt: 0,
  lastDurationSec: 0,
  cwdName: 'workspace',
  cwdFull: '',
  model: 'sol',
  effort: 'high',
  approvalPolicy: 'on-request',
  sandboxMode: 'workspace-write',
  hooksInstalled: false,
  tick: 0
};

function normalizeModelName(raw) {
  if (!raw) return 'sol';
  const s = String(raw).toLowerCase().trim();
  if (s.includes('astra')) return 'astra';
  if (s.includes('terra')) return 'terra';
  if (s.includes('luna')) return 'luna';
  return 'sol';
}

function readTextSafe(p) {
  try {
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  } catch (_) {
    return '';
  }
}

function readJsonSafe(p) {
  try {
    const t = readTextSafe(p);
    return t ? JSON.parse(t) : {};
  } catch (_) {
    return {};
  }
}

function parseTopLevelTomlString(tomlText, key) {
  const lines = tomlText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) break; // entered first table
    const m = trimmed.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`));
    if (m) return m[1];
  }
  return '';
}

function upsertCodexConfigToml(updates = {}, ensureFeaturesHooks = false, notifyArr = null) {
  try {
    fs.mkdirSync(CODEX_DIR, { recursive: true });
    const raw = readTextSafe(CODEX_CONFIG_TOML);
    const lines = raw ? raw.split(/\r?\n/) : [];

    // Find index of first [section] header
    let firstSectionIdx = lines.findIndex((l) => l.trim().startsWith('['));
    if (firstSectionIdx < 0) firstSectionIdx = lines.length;

    const topLines = lines.slice(0, firstSectionIdx);
    const restLines = lines.slice(firstSectionIdx);

    const setTopKey = (key, valExpr) => {
      const re = new RegExp(`^\\s*${key}\\s*=`);
      const idx = topLines.findIndex((l) => re.test(l));
      const formatted = `${key} = ${valExpr}`;
      if (idx >= 0) topLines[idx] = formatted;
      else topLines.push(formatted);
    };

    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined && v !== null) {
        setTopKey(k, JSON.stringify(String(v)));
      }
    }

    if (Array.isArray(notifyArr)) {
      setTopKey('notify', `[${notifyArr.map((s) => JSON.stringify(s)).join(', ')}]`);
    }

    if (ensureFeaturesHooks) {
      const featIdx = restLines.findIndex((l) => /^\s*\[features\]\s*$/.test(l));
      if (featIdx < 0) {
        if (restLines.length > 0 && restLines[restLines.length - 1].trim() !== '') restLines.push('');
        restLines.push('[features]');
        restLines.push('hooks = true');
      } else {
        let endIdx = restLines.length;
        for (let i = featIdx + 1; i < restLines.length; i++) {
          if (restLines[i].trim().startsWith('[')) { endIdx = i; break; }
        }
        let foundHooksKey = false;
        for (let i = featIdx + 1; i < endIdx; i++) {
          if (/^\s*hooks\s*=/.test(restLines[i])) {
            restLines[i] = 'hooks = true';
            foundHooksKey = true;
            break;
          }
        }
        if (!foundHooksKey) {
          restLines.splice(featIdx + 1, 0, 'hooks = true');
        }
      }
    }

    while (topLines.length > 0 && topLines[topLines.length - 1].trim() === '') topLines.pop();
    const joined = restLines.length > 0
      ? [...topLines, '', ...restLines].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
      : topLines.join('\n').trim() + '\n';

    fs.writeFileSync(CODEX_CONFIG_TOML, joined, 'utf8');
  } catch (err) {
    log(`upsertCodexConfigToml error: ${err.message}`);
  }
}

function syncFromCodexConfig() {
  const toml = readTextSafe(CODEX_CONFIG_TOML);
  if (toml) {
    const m = parseTopLevelTomlString(toml, 'model');
    if (m) agent.model = normalizeModelName(m);
    const eff = parseTopLevelTomlString(toml, 'model_reasoning_effort');
    if (eff && EFFORT_META[eff]) agent.effort = eff;
    const ap = parseTopLevelTomlString(toml, 'approval_policy');
    if (ap && APPROVAL_META[ap]) agent.approvalPolicy = ap;
    const sb = parseTopLevelTomlString(toml, 'sandbox_mode');
    if (sb && SANDBOX_META[sb]) agent.sandboxMode = sb;
  }
  const h = readJsonSafe(CODEX_HOOKS_JSON);
  agent.hooksInstalled = Boolean(
    fs.existsSync(CODEX_HOOK_SCRIPT) &&
    toml.includes('streamdock_codex_notify.js') &&
    h.hooks
  );
}

function installOrRepairCodexHooks() {
  try {
    fs.mkdirSync(CODEX_HOOKS_DIR, { recursive: true });
    if (fs.existsSync(BUNDLED_HOOK_SCRIPT)) {
      fs.copyFileSync(BUNDLED_HOOK_SCRIPT, CODEX_HOOK_SCRIPT);
    }
    if (!IS_WIN) {
      try { fs.chmodSync(CODEX_HOOK_SCRIPT, 0o755); } catch (_) {}
    }

    const nodeExe = process.execPath;
    const mkCmd = (ev) => `"${nodeExe}" "${CODEX_HOOK_SCRIPT}" ${ev}`;

    // 1. Configure ~/.codex/hooks.json (preserving any existing user hooks)
    const hooksDoc = readJsonSafe(CODEX_HOOKS_JSON);
    if (!hooksDoc.hooks || typeof hooksDoc.hooks !== 'object') hooksDoc.hooks = {};

    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']) {
      const existing = Array.isArray(hooksDoc.hooks[ev]) ? hooksDoc.hooks[ev] : [];
      const cleaned = existing.filter((x) => !JSON.stringify(x).includes('streamdock_codex_notify.js'));
      if (ev === 'PostToolUse') {
        cleaned.push({ matcher: '*', hooks: [{ type: 'command', command: mkCmd(ev) }] });
      } else {
        cleaned.push({ hooks: [{ type: 'command', command: mkCmd(ev) }] });
      }
      hooksDoc.hooks[ev] = cleaned;
    }
    fs.writeFileSync(CODEX_HOOKS_JSON, JSON.stringify(hooksDoc, null, 2) + '\n', 'utf8');

    // 2. Ensure ~/.codex/config.toml has latest defaults (if unset), notify, and [features] hooks = true
    const curToml = readTextSafe(CODEX_CONFIG_TOML);
    const defaults = {};
    if (!parseTopLevelTomlString(curToml, 'model')) defaults.model = MODEL_META[agent.model].cliArg;
    if (!parseTopLevelTomlString(curToml, 'model_reasoning_effort')) defaults.model_reasoning_effort = agent.effort;
    if (!parseTopLevelTomlString(curToml, 'approval_policy')) defaults.approval_policy = agent.approvalPolicy;
    if (!parseTopLevelTomlString(curToml, 'sandbox_mode')) defaults.sandbox_mode = agent.sandboxMode;

    upsertCodexConfigToml(defaults, true, [nodeExe, CODEX_HOOK_SCRIPT]);
    syncFromCodexConfig();
    log(`Codex hooks & config.toml installed at ${CODEX_DIR}`);
    return true;
  } catch (err) {
    log(`installOrRepairCodexHooks error: ${err.message}`);
    return false;
  }
}

syncFromCodexConfig();
if (!agent.hooksInstalled) {
  installOrRepairCodexHooks();
}

// --- Zero-Config Live Session JSONL Watcher (~/.codex/sessions/**/*.jsonl) ---
let watchedSessionFile = '';
let watchedSessionSize = -1;
let sessionBooted = false;

function mapCodexToolLabel(toolName) {
  const t = String(toolName || '').toLowerCase();
  if (t.includes('shell') || t.includes('exec') || t.includes('bash') || t.includes('command')) return '셸실행';
  if (t.includes('patch') || t.includes('edit') || t.includes('write')) return '패치적용';
  if (t.includes('read') || t.includes('view')) return '파일읽기';
  if (t.includes('web') || t.includes('search')) return '웹검색';
  if (t.includes('review')) return '코드리뷰';
  return toolName || '실행중';
}

function findNewestCodexJsonl(dir, depth = 0) {
  let best = { path: '', mtime: 0 };
  if (depth > 4 || !fs.existsSync(dir)) return best;
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const sub = findNewestCodexJsonl(full, depth + 1);
        if (sub.mtime > best.mtime) best = sub;
      } else if (ent.name.endsWith('.jsonl')) {
        const st = fs.statSync(full);
        if (st.mtimeMs > best.mtime) best = { path: full, mtime: st.mtimeMs };
      }
    }
  } catch (_) {}
  return best;
}

function pollActiveCodexSession() {
  try {
    const newest = findNewestCodexJsonl(CODEX_SESSIONS_DIR, 0);
    if (!newest.path) {
      sessionBooted = true;
      return;
    }
    const stat = fs.statSync(newest.path);
    if (!sessionBooted) {
      watchedSessionFile = newest.path;
      watchedSessionSize = stat.size;
      sessionBooted = true;
      return;
    }
    if (newest.path === watchedSessionFile && stat.size === watchedSessionSize) return;
    watchedSessionFile = newest.path;
    watchedSessionSize = stat.size;

    const readLen = Math.min(stat.size, 8192);
    const fd = fs.openSync(newest.path, 'r');
    const buf = Buffer.allocUnsafe(readLen);
    fs.readSync(fd, buf, 0, readLen, stat.size - readLen);
    fs.closeSync(fd);

    const lines = buf.toString('utf8').trim().split('\n').filter(Boolean);
    if (!lines.length) return;
    const item = JSON.parse(lines[lines.length - 1]);
    const t = String(item.type || item.event || '').toLowerCase();

    if (t.includes('approval') || t.includes('permission')) {
      agent.state = 'WAITING_PERMISSION';
      agent.currentTool = '승인대기';
      renderAllContexts();
      broadcastStateToPI();
    } else if (t.includes('function_call') || t.includes('tool_call') || t.includes('command_execution')) {
      agent.state = 'RUNNING';
      if (!agent.turnStartedAt) agent.turnStartedAt = Date.now();
      agent.toolCount += 1;
      const fn = (item.payload && item.payload.name) || item.name || 'shell';
      agent.rawToolName = fn;
      agent.currentTool = mapCodexToolLabel(fn);
      renderAllContexts();
      broadcastStateToPI();
    } else if (t.includes('task_complete') || t.includes('turn_complete')) {
      if (agent.turnStartedAt > 0) {
        agent.lastDurationSec = Math.max(1, Math.round((Date.now() - agent.turnStartedAt) / 1000));
      }
      agent.turnStartedAt = 0;
      agent.state = 'COMPLETED';
      agent.currentTool = '완료';
      renderAllContexts();
      broadcastStateToPI();
    }
  } catch (_) {}
}

setInterval(pollActiveCodexSession, 1300);

// ============================================================================
// 5. Hook Event Processing & Simulator
// ============================================================================
function handleHookEvent(payload) {
  if (!payload || typeof payload !== 'object') return;
  const evt = String(payload.hook_event_name || payload.type || payload.event || '').trim();

  if (payload.cwd) {
    agent.cwdFull = String(payload.cwd);
    agent.cwdName = path.basename(agent.cwdFull) || 'workspace';
  }
  if (payload.model) {
    agent.model = normalizeModelName(payload.model);
  }

  // Codex `notify = [...]` sends `{ type: "agent-turn-complete", ... }` or approval notifications
  if (evt === 'agent-turn-complete' || evt === 'Stop') {
    if (agent.turnStartedAt > 0) {
      agent.lastDurationSec = Math.max(1, Math.round((Date.now() - agent.turnStartedAt) / 1000));
    }
    agent.turnStartedAt = 0;
    agent.state = 'COMPLETED';
    agent.currentTool = '완료';
  } else if (evt === 'approval-requested' || evt === 'PermissionRequest') {
    agent.state = 'WAITING_PERMISSION';
    agent.currentTool = '승인대기';
  } else if (evt === 'SessionStart') {
    agent.state = 'IDLE';
    agent.turnStartedAt = 0;
    agent.toolCount = 0;
    agent.currentTool = '대기';
  } else if (evt === 'UserPromptSubmit') {
    agent.state = 'RUNNING';
    agent.turnStartedAt = Date.now();
    agent.toolCount = 0;
    agent.rawToolName = 'Think';
    agent.currentTool = '추론중';
  } else if (evt === 'PostToolUse' || evt === 'PreToolUse') {
    agent.state = 'RUNNING';
    if (!agent.turnStartedAt) agent.turnStartedAt = Date.now();
    agent.toolCount += 1;
    const tName = payload.tool_name || (payload.tool && payload.tool.name) || 'shell';
    agent.rawToolName = tName;
    agent.currentTool = mapCodexToolLabel(tName);
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
    agent.turnStartedAt = Date.now() - 11000;
    agent.toolCount = Math.max(3, agent.toolCount);
    agent.rawToolName = 'apply_patch';
    agent.currentTool = '패치적용';
  } else if (s === 'WAITING_PERMISSION') {
    agent.state = 'WAITING_PERMISSION';
    agent.rawToolName = 'shell';
    agent.currentTool = '승인대기';
  } else if (s === 'WAITING_INPUT') {
    agent.state = 'WAITING_INPUT';
    agent.rawToolName = 'question';
    agent.currentTool = '입력대기';
  } else if (s === 'COMPLETED') {
    agent.state = 'COMPLETED';
    agent.lastDurationSec = 14;
    agent.turnStartedAt = 0;
    agent.toolCount = Math.max(5, agent.toolCount);
    agent.currentTool = '완료';
  }
  renderAllContexts();
  broadcastStateToPI();
}

// ============================================================================
// 6. Pure Vector SVG Icon Library (OpenAI Codex Emerald Hex Theme)
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
    else if (/[A-Z0-9/_&.-]/.test(ch)) u += 0.63;
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
  codexHex(col) {
    return `
      <polygon points="72,20 100,36 100,68 72,84 44,68 44,36" fill="${col}" fill-opacity="0.16" stroke="${col}" stroke-width="6" stroke-linejoin="round"/>
      <polyline points="44,36 72,52 100,36" fill="none" stroke="${col}" stroke-width="4.5" stroke-linejoin="round"/>
      <line x1="72" y1="52" x2="72" y2="84" stroke="${col}" stroke-width="4.5" stroke-linecap="round"/>
      <circle cx="72" cy="52" r="7" fill="#FFFFFF"/>
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

  effortBars4(activeBars, col) {
    return [1, 2, 3, 4]
      .map((n) => {
        const x = 35 + (n - 1) * 19.5;
        const h = 18 + n * 11.5;
        const y = 82 - h;
        const fill = n <= activeBars ? col : '#27272A';
        return `<rect x="${x}" y="${y}" width="14" height="${h}" rx="4" fill="${fill}" stroke="#000000" stroke-width="1.5"/>`;
      })
      .join('');
  },

  reviewShieldLens(col) {
    return `
      <circle cx="66" cy="46" r="21" fill="${col}" fill-opacity="0.16" stroke="${col}" stroke-width="6"/>
      <polyline points="57,46 64,53 76,39" fill="none" stroke="#FFFFFF" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
      <line x1="82" y1="62" x2="100" y2="80" stroke="${col}" stroke-width="7" stroke-linecap="round"/>
    `;
  },

  newSessionPlus(col) {
    return `
      <rect x="42" y="24" width="60" height="56" rx="14" fill="${col}" fill-opacity="0.15" stroke="${col}" stroke-width="5.5"/>
      <line x1="72" y1="37" x2="72" y2="67" stroke="${col}" stroke-width="7" stroke-linecap="round"/>
      <line x1="57" y1="52" x2="87" y2="52" stroke="${col}" stroke-width="7" stroke-linecap="round"/>
    `;
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
    let label = '대기중', labelColor = '#E2E8F0', badge = 'CDX';

    if (agent.state === 'RUNNING') {
      bg = '#05291A'; border = '#34D399'; col = '#34D399';
      const tn = (agent.rawToolName || '').toLowerCase();
      if (tn.includes('patch') || tn.includes('edit') || tn.includes('write')) icon = VEC.codeEdit('#34D399');
      else if (tn.includes('review')) icon = VEC.reviewShieldLens('#34D399');
      else icon = VEC.terminalPrompt('#34D399');
      label = agent.currentTool || '실행중';
      labelColor = '#FFFFFF';
      badge = `${agent.toolCount}`;
    } else if (agent.state === 'WAITING_PERMISSION') {
      bg = pulseOn ? '#3B1D02' : '#1C0E02'; border = pulseOn ? '#FDE047' : '#F59E0B'; col = '#FDE047';
      icon = VEC.warningTriangle('#FACC15'); label = '승인대기'; labelColor = '#FEF08A'; badge = 'Y/A';
    } else if (agent.state === 'WAITING_INPUT') {
      bg = pulseOn ? '#3B1219' : '#1C080C'; border = pulseOn ? '#FB923C' : '#F43F5E'; col = '#FB923C';
      icon = VEC.questionBubble('#FB923C'); label = '입력대기'; labelColor = '#FEF08A'; badge = '?';
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
    const mMeta = MODEL_META[agent.model] || MODEL_META.sol;
    const eMeta = EFFORT_META[agent.effort] || EFFORT_META.high;
    const sMeta = SANDBOX_META[agent.sandboxMode] || SANDBOX_META['workspace-write'];
    return svgIconTile({
      bg: '#0B0B0C', border: flashed ? '#FFFFFF' : mMeta.border, borderWidth: 4.5,
      glowColor: mMeta.border, iconSvg: VEC.aiChip(mMeta.color, mMeta.chip),
      label: `${eMeta.label}·${sMeta.label}`, labelColor: '#FFFFFF', badge: sMeta.badge, badgeColor: sMeta.color, iconOnly
    });
  }

  let bg = '#0B0B0C', border = '#10B981', glow = '#10B981';
  let icon = VEC.codexHex('#34D399');
  let label = '대기', labelColor = '#FFFFFF', badge = '';

  if (agent.state === 'RUNNING') {
    bg = '#05291A'; border = '#34D399'; glow = '#34D399';
    icon = VEC.spinner('#34D399', agent.tick);
    label = formatDuration(elapsedSec); labelColor = '#6EE7B7'; badge = 'RUN';
  } else if (agent.state === 'WAITING_PERMISSION') {
    bg = pulseOn ? '#422006' : '#1F1003'; border = pulseOn ? '#FDE047' : '#F59E0B'; glow = '#F59E0B';
    icon = VEC.warningTriangle(pulseOn ? '#FDE047' : '#F59E0B');
    label = '승인대기'; labelColor = '#FEF08A';
  } else if (agent.state === 'WAITING_INPUT') {
    bg = pulseOn ? '#431407' : '#1F0B05'; border = pulseOn ? '#FDBA74' : '#FB923C'; glow = '#FB923C';
    icon = VEC.questionBubble('#FB923C'); label = '입력대기'; labelColor = '#FEF08A';
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

  if (type === 'approve_session') {
    const col = waitingPerm ? (pulseOn ? '#FDE047' : '#2DD4BF') : '#2DD4BF';
    return svgIconTile({
      bg: waitingPerm && pulseOn ? '#06322D' : '#0B0B0C',
      border: flashed ? '#FFFFFF' : col, borderWidth: waitingPerm ? 6 : 4.5,
      glowColor: col, iconSvg: VEC.doubleCheck(col),
      label: '세션허용', labelColor: waitingPerm ? '#FEF08A' : '#FFFFFF',
      badge: 'A', badgeColor: col, iconOnly
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
    badge: 'Y/⏎', badgeColor: col, iconOnly
  });
}

function renderModelSvg(settings = {}, flashed = false) {
  const mode = settings.modelMode || 'cycle';
  const iconOnly = settings.displayStyle === 'icon_only';
  const shownKey = mode === 'fixed' ? normalizeModelName(settings.targetModel) : agent.model;
  const meta = MODEL_META[shownKey] || MODEL_META.sol;

  const startCx = 72 - ((MODEL_ORDER.length - 1) * 16) / 2;
  const dots = mode === 'cycle'
    ? MODEL_ORDER.map((m, idx) => {
        const cx = startCx + idx * 16;
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
  const sType = settings.settingType || 'perm_mode';
  const iconOnly = settings.displayStyle === 'icon_only';

  if (sType === 'effort') {
    const eMeta = EFFORT_META[agent.effort] || EFFORT_META.high;
    return svgIconTile({
      bg: '#0B0B0C', border: flashed ? '#FFFFFF' : eMeta.border, borderWidth: 4.5,
      glowColor: eMeta.border, iconSvg: VEC.effortBars4(eMeta.bars, eMeta.color),
      label: eMeta.kor, labelColor: '#FFFFFF', iconOnly
    });
  }

  if (sType === 'sandbox') {
    const sMeta = SANDBOX_META[agent.sandboxMode] || SANDBOX_META['workspace-write'];
    const icon = agent.sandboxMode === 'danger-full-access' ? VEC.bolt(sMeta.color) : VEC.shield(sMeta.color);
    return svgIconTile({
      bg: '#0B0B0C', border: flashed ? '#FFFFFF' : sMeta.border, borderWidth: 4.5,
      glowColor: sMeta.border, iconSvg: icon,
      label: sMeta.label, labelColor: '#FFFFFF', badge: sMeta.badge, badgeColor: sMeta.color, iconOnly
    });
  }

  const aMeta = APPROVAL_META[agent.approvalPolicy] || APPROVAL_META['on-request'];
  const icon = agent.approvalPolicy === 'never' ? VEC.bolt(aMeta.color) : VEC.shield(aMeta.color);
  return svgIconTile({
    bg: '#0B0B0C', border: flashed ? '#FFFFFF' : aMeta.border, borderWidth: 4.5,
    glowColor: aMeta.border, iconSvg: icon, label: aMeta.label, labelColor: '#FFFFFF', iconOnly
  });
}

const CMD_PRESETS = {
  review: {
    shortLabel: '코드리뷰', border: '#10B981',
    cmd: '/review', longCmd: '/diff', defaultAutoEnter: true,
    iconFn: () => VEC.reviewShieldLens('#34D399')
  },
  compact: {
    shortLabel: '압축', border: '#06B6D4',
    cmd: '/compact', longCmd: '/status', defaultAutoEnter: true,
    iconFn: () => VEC.compress('#22D3EE')
  },
  clear: {
    shortLabel: '새세션', border: '#A855F7',
    cmd: '/new', longCmd: '/init', defaultAutoEnter: true,
    iconFn: () => VEC.newSessionPlus('#C084FC')
  },
  ide_fix: {
    shortLabel: 'IDE·수정', border: '#0284C7',
    cmd: '빌드와 테스트를 실행하고 실패하거나 오류가 나는 부분을 찾아 수정해줘',
    longCmd: '/ide', defaultAutoEnter: true,
    iconFn: () => VEC.wrenchFix('#38BDF8')
  },
  vibe_commit: {
    shortLabel: '커밋', border: '#10B981',
    cmd: 'git status와 diff를 확인해서 변경사항을 깔끔하게 요약하고 적절한 커밋 메시지로 커밋해줘',
    longCmd: '/hooks', defaultAutoEnter: true,
    iconFn: () => VEC.gitGraph('#34D399')
  }
};

function renderCommandSvg(settings = {}, flashed = false) {
  const presetKey = settings.preset || 'review';
  const iconOnly = settings.displayStyle === 'icon_only';
  const preset = CMD_PRESETS[presetKey] || {
    shortLabel: settings.label || '명령', border: '#10B981',
    iconFn: () => VEC.terminalPrompt('#34D399')
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
      bg: '#0B0B0C', border: flashed ? '#FFFFFF' : '#10B981', borderWidth: 4.5,
      glowColor: '#10B981', iconSvg: VEC.codexHex('#34D399'),
      label: 'Codex열기', labelColor: '#FFFFFF', iconOnly
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
    case 'com.vibecoding.codex.status':   svg = renderStatusSvg(entry.settings, flashed); break;
    case 'com.vibecoding.codex.approval': svg = renderApprovalSvg(entry.settings, flashed); break;
    case 'com.vibecoding.codex.model':    svg = renderModelSvg(entry.settings, flashed); break;
    case 'com.vibecoding.codex.mode':     svg = renderModeSvg(entry.settings, flashed); break;
    case 'com.vibecoding.codex.command':  svg = renderCommandSvg(entry.settings, flashed); break;
    case 'com.vibecoding.codex.utility':  svg = renderUtilitySvg(entry.settings, flashed); break;
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
  const mMeta = MODEL_META[agent.model] || MODEL_META.sol;
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
    effort: agent.effort,
    approvalPolicy: agent.approvalPolicy,
    sandboxMode: agent.sandboxMode,
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
    case 'com.vibecoding.codex.status': {
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

    case 'com.vibecoding.codex.approval': {
      const rType = s.responseType || 'approve';
      const autoFocus = s.autoFocusTerminal !== false;
      if (rType === 'approve_session') {
        if (isLongPress) bridge.sendText('/permissions', true, autoFocus, true);
        else bridge.sendLogicalKey('a', autoFocus);
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
        if (isLongPress) bridge.sendLogicalKey('y', autoFocus);
        else bridge.sendLogicalKey('enter', autoFocus);
        if (agent.state === 'WAITING_PERMISSION' || agent.state === 'WAITING_INPUT') {
          agent.state = 'RUNNING';
          renderAllContexts();
        }
      }
      break;
    }

    case 'com.vibecoding.codex.model': {
      let nextModel = 'sol';
      if ((s.modelMode || 'cycle') === 'fixed') nextModel = normalizeModelName(s.targetModel);
      else if (isLongPress) nextModel = 'sol';
      else nextModel = MODEL_ORDER[(MODEL_ORDER.indexOf(agent.model) + 1) % MODEL_ORDER.length];

      agent.model = nextModel;
      const cliId = MODEL_META[nextModel].cliArg;
      upsertCodexConfigToml({ model: cliId });
      if (s.sendSlashCommand !== false) {
        bridge.sendText(`/model ${cliId}`, true, true, true);
      }
      renderAllContexts();
      broadcastStateToPI();
      break;
    }

    case 'com.vibecoding.codex.mode': {
      const sType = s.settingType || 'perm_mode';
      if (sType === 'effort') {
        const idx = EFFORT_ORDER.indexOf(agent.effort);
        agent.effort = isLongPress ? 'high' : EFFORT_ORDER[(idx + 1) % EFFORT_ORDER.length];
        upsertCodexConfigToml({ model_reasoning_effort: agent.effort });
      } else if (sType === 'sandbox') {
        const idx = SANDBOX_ORDER.indexOf(agent.sandboxMode);
        agent.sandboxMode = isLongPress ? 'workspace-write' : SANDBOX_ORDER[(idx + 1) % SANDBOX_ORDER.length];
        upsertCodexConfigToml({ sandbox_mode: agent.sandboxMode });
      } else {
        const idx = APPROVAL_ORDER.indexOf(agent.approvalPolicy);
        agent.approvalPolicy = isLongPress ? 'on-request' : APPROVAL_ORDER[(idx + 1) % APPROVAL_ORDER.length];
        upsertCodexConfigToml({ approval_policy: agent.approvalPolicy });
        if (isLongPress) bridge.sendText('/permissions', true, true, true);
      }
      renderAllContexts();
      broadcastStateToPI();
      break;
    }

    case 'com.vibecoding.codex.command': {
      const preset = CMD_PRESETS[s.preset || 'review'] || CMD_PRESETS.review;
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

    case 'com.vibecoding.codex.utility': {
      const uType = s.utilType || 'voice';
      if (uType === 'voice') {
        bridge.sendLogicalKey('voice', true, false);
      } else if (uType === 'screenshot') {
        if (isLongPress) bridge.sendLogicalKey('screen_snip', false, false);
        else bridge.sendLogicalKey('image_paste', true, true);
      } else if (uType === 'launch') {
        if (isLongPress) bridge.launchCodex(agent.cwdFull);
        else bridge.focusApp(true, agent.cwdFull);
      } else if (uType === 'install_hooks') {
        installOrRepairCodexHooks();
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
// 8. Local HTTP Server (127.0.0.1:17532) & Stream Dock WebSocket Bootstrap
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
srv.on('error', (e) => log(`HTTP 17532 error: ${e.message}`));
srv.listen(HTTP_PORT, '127.0.0.1', () => log(`Codex HTTP server on 127.0.0.1:${HTTP_PORT}`));

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
        else if (payload.cmd === 'installHooks') { installOrRepairCodexHooks(); renderAllContexts(); broadcastStateToPI(); }
        else if (payload.cmd === 'getState') broadcastStateToPI();
      }
    } catch (_) {}
  };
  sdWs.onclose = () => process.exit(0);
}
