'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

// ============================================================================
// 1. Platform Constants, Logging & Paths (Windows + macOS)
// ============================================================================
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const HOME_DIR = os.homedir();
const CLAUDE_DIR = path.join(HOME_DIR, '.claude');
const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const CLAUDE_HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const CLAUDE_HOOK_SCRIPT = path.join(CLAUDE_HOOKS_DIR, 'streamdock_notify.js');
const BUNDLED_HOOK_SCRIPT = path.join(__dirname, 'streamdock_notify.js');
const WIN_BRIDGE_SCRIPT = path.join(__dirname, 'win_bridge.ps1');
const LOG_FILE = path.join(__dirname, 'plugin_runtime.log');
const HTTP_PORT = Number(process.env.CLAUDE_SD_HTTP_PORT || 17530);

function log(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (_) {}
}

try {
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 262144) {
    fs.writeFileSync(LOG_FILE, '', 'utf8');
  }
} catch (_) {}

// ============================================================================
// 2. Pure Node.js RFC 6455 WebSocket Client (Zero npm dependencies, Node 20+)
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
      if (head && head.length > 0) {
        this.rxBuf = Buffer.concat([this.rxBuf, head]);
      }
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
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ mask[i & 3];
        }
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
          if (opcode === 0x01 && this.onmessage) {
            this.onmessage({ data: payload.toString('utf8') });
          }
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
          if (origOp === 0x01 && this.onmessage) {
            this.onmessage({ data: full.toString('utf8') });
          }
        }
      }
    }
  }

  _sendFrame(opcode, payloadBuf) {
    if (this.readyState !== 1 || !this.socket) return;
    const len = payloadBuf.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 0x80 | len;
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
    for (let i = 0; i < len; i++) {
      maskedPayload[i] = payloadBuf[i] ^ mask[i & 3];
    }

    this.socket.write(Buffer.concat([header, mask, maskedPayload]));
  }

  send(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this._sendFrame(0x01, buf);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    try {
      if (this.socket) this.socket.end();
    } catch (_) {}
  }
}

// ============================================================================
// 3. Cross-Platform Input & Window Bridge (Windows Win32 + macOS JXA/Cocoa)
// ============================================================================
const MAC_JXA_SCRIPT = `
function run(argv) {
  const req = JSON.parse(argv[0]);
  const se = Application("System Events");
  const termNames = ["iTerm2", "iTerm", "Terminal", "Warp", "Ghostty", "wezterm-gui", "WezTerm", "Alacritty", "kitty"];
  const ideNames = ["Cursor", "Code", "Visual Studio Code", "Windsurf", "Antigravity", "Zed"];

  function findCodingProc() {
    const procs = se.applicationProcesses.whose({ backgroundOnly: false })();
    let claudeTerm = null, anyTerm = null, claudeIde = null, anyIde = null;
    for (let i = 0; i < procs.length; i++) {
      const p = procs[i];
      let pName = "";
      try { pName = p.name(); } catch (e) { continue; }
      const isTerm = termNames.indexOf(pName) >= 0;
      const isIde = ideNames.indexOf(pName) >= 0;
      if (!isTerm && !isIde) continue;

      let hasClaude = false;
      try {
        const wins = p.windows();
        for (let w = 0; w < wins.length; w++) {
          const wt = String(wins[w].name() || "");
          if (wt.toLowerCase().indexOf("claude") >= 0) { hasClaude = true; break; }
        }
      } catch (e) {}

      if (isTerm) {
        if (hasClaude && !claudeTerm) claudeTerm = p;
        else if (!anyTerm) anyTerm = p;
      } else if (isIde) {
        if (hasClaude && !claudeIde) claudeIde = p;
        else if (!anyIde) anyIde = p;
      }
    }
    return claudeTerm || claudeIde || anyTerm || anyIde;
  }

  if (req.cmd === "focus") {
    const target = findCodingProc();
    if (target) {
      target.frontmost = true;
      return JSON.stringify({ ok: true, foundCoding: true, target: target.name() });
    }
    if (req.launchIfMissing) {
      const term = Application("Terminal");
      term.activate();
      return JSON.stringify({ ok: true, launched: true, target: "Terminal" });
    }
    return JSON.stringify({ ok: false, foundCoding: false });
  }

  if (req.cmd === "launch_claude") {
    const cwdEsc = String(req.cwd || "").replace(/'/g, "'\\\\''");
    const cdPart = cwdEsc ? ("cd '" + cwdEsc + "' && ") : "";
    const shCmd = cdPart + "(command -v claude >/dev/null 2>&1 && claude || echo 'Claude Code CLI Ready')";
    try {
      const iterm = Application("iTerm");
      iterm.activate();
      const win = iterm.createWindowWithDefaultProfile();
      win.currentSession.write({ text: shCmd });
      return JSON.stringify({ ok: true, launched: "iTerm" });
    } catch (e) {
      const term = Application("Terminal");
      term.activate();
      term.doScript(shCmd);
      return JSON.stringify({ ok: true, launched: "Terminal" });
    }
  }

  if (req.cmd === "key") {
    const combo = String(req.combo || "").toLowerCase();
    const isGlobal = (combo === "voice" || combo === "screen_snip");
    const target = findCodingProc();
    if (req.focus && target && combo !== "screen_snip") {
      target.frontmost = true;
      delay(0.04);
    }
    if (!isGlobal && req.requireCoding && !target) {
      return JSON.stringify({ ok: false, skipped: "no_coding_window" });
    }

    switch (combo) {
      case "enter":       se.keyCode(36); break;
      case "esc":         se.keyCode(53); break;
      case "2":           se.keystroke("2"); break;
      case "1":           se.keystroke("1"); break;
      case "y":           se.keystroke("y"); break;
      case "n":           se.keystroke("n"); break;
      case "ctrl+c":      se.keyCode(8, { using: "control down" }); break;
      case "ctrl+l":      se.keyCode(37, { using: "control down" }); break;
      case "shift+tab":   se.keyCode(48, { using: "shift down" }); break;
      case "thinking":    se.keyCode(17, { using: "option down" }); break;
      case "image_paste": se.keyCode(9, { using: "control down" }); break;
      case "screen_snip": se.keyCode(21, { using: ["command down", "control down", "shift down"] }); break;
      case "cmd+v":       se.keyCode(9, { using: "command down" }); break;
      case "cmd+v+enter":
        se.keyCode(9, { using: "command down" });
        delay(0.05);
        se.keyCode(36);
        break;
      case "voice": {
        let triggered = false;
        const menuNames = ["Edit", "편집"];
        for (let m = 0; m < menuNames.length && !triggered; m++) {
          try {
            const fg = se.applicationProcesses.whose({ frontmost: true })()[0];
            const editMenu = fg.menuBars[0].menuBarItems.byName(menuNames[m]);
            const items = editMenu.menus[0].menuItems();
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
        if (!triggered) {
          se.keyCode(63);
          delay(0.07);
          se.keyCode(63);
        }
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
    if (IS_WIN && fs.existsSync(WIN_BRIDGE_SCRIPT)) {
      this._spawnWinBridge();
    }
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
      child.stdout.on('data', (d) => {
        const s = d.toString('utf8').trim();
        if (s) log(`[WinBridge] ${s}`);
      });
      child.stderr.on('data', (d) => {
        const s = d.toString('utf8').trim();
        if (s) log(`[WinBridge:ERR] ${s}`);
      });
      child.on('exit', (code) => {
        log(`[WinBridge] exited (${code})`);
        this.winProc = null;
        this.startingWin = false;
      });
      this.winProc = child;
      this.startingWin = false;
    } catch (err) {
      log(`[WinBridge] spawn failed: ${err.message}`);
      this.startingWin = false;
    }
  }

  _sendWin(cmdObj) {
    if (!this.winProc) this._spawnWinBridge();
    if (this.winProc && this.winProc.stdin && !this.winProc.stdin.destroyed) {
      try {
        this.winProc.stdin.write(JSON.stringify(cmdObj) + '\n', 'utf8');
      } catch (err) {
        log(`[WinBridge] write error: ${err.message}`);
      }
    }
  }

  _runMacJxa(reqObj, cb) {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', MAC_JXA_SCRIPT, JSON.stringify(reqObj)],
      { timeout: 3500 },
      (err, stdout, stderr) => {
        if (err) {
          log(`[MacBridge:ERR] ${err.message} ${stderr || ''}`.trim());
          if (cb) cb(null);
          return;
        }
        const out = String(stdout || '').trim();
        if (out) log(`[MacBridge] ${out}`);
        if (cb) {
          try { cb(JSON.parse(out)); } catch (_) { cb(null); }
        }
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
    } catch (_) {
      if (done) done();
    }
  }

  focusTerminal(launchIfMissing = false, cwd = '') {
    if (IS_WIN) this._sendWin({ cmd: 'focus', launchIfMissing, cwd });
    else if (IS_MAC) this._runMacJxa({ cmd: 'focus', launchIfMissing, cwd });
  }

  sendLogicalKey(actionKey, focus = true, requireCoding = true) {
    if (IS_WIN) {
      const winMap = {
        thinking: 'alt+t',
        image_paste: 'alt+v',
        screen_snip: 'win+shift+s',
        voice: 'win+h'
      };
      const combo = winMap[actionKey] || actionKey;
      this._sendWin({ cmd: 'key', combo, focus, requireCoding });
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
        if (requireCoding && (!res || !res.foundCoding)) {
          log('[MacBridge] Skipped sendText: no coding window open');
          return;
        }
        execFile(
          '/usr/bin/pbpaste',
          [],
          { env: { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8' }, timeout: 1000 },
          (pbErr, prevClip) => {
            const hadPrev = !pbErr && typeof prevClip === 'string';
            this._macClipboardWrite(text, () => {
              this._runMacJxa(
                { cmd: 'key', combo: enter ? 'cmd+v+enter' : 'cmd+v', focus, requireCoding: false },
                () => {
                  if (hadPrev) {
                    setTimeout(() => this._macClipboardWrite(prevClip), 220);
                  }
                }
              );
            });
          }
        );
      });
    }
  }

  launchClaude(cwd = '') {
    if (IS_WIN) this._sendWin({ cmd: 'launch_claude', cwd });
    else if (IS_MAC) this._runMacJxa({ cmd: 'launch_claude', cwd });
  }
}

const bridge = new PlatformBridge();

// ============================================================================
// 4. Claude Code Settings & Hooks Sync (~/.claude/settings.json)
// ============================================================================
const MODEL_ORDER = ['sonnet', 'opus', 'fable', 'haiku', 'opusplan'];
const MODEL_META = {
  sonnet:   { short: 'SONNET 5.5', chip: 'S5.5', cliArg: 'claude-sonnet-5-5', color: '#FF8B66', border: '#D97757' },
  opus:     { short: 'OPUS 5.5',   chip: 'O5.5', cliArg: 'claude-opus-5-5',   color: '#C084FC', border: '#A855F7' },
  fable:    { short: 'FABLE 5.1',  chip: 'F5.1', cliArg: 'claude-fable-5-1',  color: '#FCD34D', border: '#F59E0B' },
  haiku:    { short: 'HAIKU 5.5',  chip: 'H5.5', cliArg: 'claude-haiku-5-5',  color: '#34D399', border: '#10B981' },
  opusplan: { short: 'OPUS PLAN',  chip: 'PLAN', cliArg: 'opusplan',          color: '#7DD3FC', border: '#38BDF8' }
};

const EFFORT_ORDER = ['low', 'medium', 'high', 'max'];
const EFFORT_META = {
  low:    { label: 'LOW',  kor: '강도 LOW',  bars: 1, color: '#CBD5E1', border: '#94A3B8' },
  medium: { label: 'MED',  kor: '강도 MED',  bars: 2, color: '#7DD3FC', border: '#38BDF8' },
  high:   { label: 'HIGH', kor: '강도 HIGH', bars: 3, color: '#FCD34D', border: '#F59E0B' },
  max:    { label: 'MAX',  kor: '강도 MAX',  bars: 4, color: '#F472B6', border: '#EC4899' }
};

const PERM_ORDER = ['default', 'acceptEdits', 'plan'];
const PERM_META = {
  default:     { label: '일반',     color: '#7DD3FC', border: '#38BDF8' },
  acceptEdits: { label: '자동수정', color: '#34D399', border: '#10B981' },
  plan:        { label: '플랜',     color: '#C084FC', border: '#A855F7' }
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
  lastEventAt: Date.now(),
  cwdName: 'workspace',
  cwdFull: '',
  model: 'sonnet',
  effortLevel: 'high',
  thinkingEnabled: true,
  permMode: 'default',
  hooksInstalled: false,
  tick: 0
};

function normalizeModelName(raw) {
  if (!raw) return 'sonnet';
  const s = String(raw).toLowerCase().trim();
  if (s.includes('opusplan')) return 'opusplan';
  if (s.includes('fable') || s === 'best') return 'fable';
  if (s.includes('opus')) return 'opus';
  if (s.includes('haiku')) return 'haiku';
  return 'sonnet';
}

function normalizeEffort(raw) {
  if (!raw) return 'high';
  const s = String(raw).toLowerCase();
  return EFFORT_ORDER.includes(s) ? s : 'high';
}

function readClaudeSettings() {
  try {
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return {};
    const raw = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    log(`readClaudeSettings error: ${err.message}`);
    return {};
  }
}

function syncFromClaudeSettings() {
  const s = readClaudeSettings();
  if (s.model) agent.model = normalizeModelName(s.model);
  if (s.effortLevel) agent.effortLevel = normalizeEffort(s.effortLevel);
  if (typeof s.alwaysThinkingEnabled === 'boolean') {
    agent.thinkingEnabled = s.alwaysThinkingEnabled;
  }
  agent.hooksInstalled = Boolean(
    s.hooks &&
      s.hooks.PreToolUse &&
      JSON.stringify(s.hooks).includes('streamdock_notify.js')
  );
}

function updateClaudeSettings(mutator) {
  try {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    const current = readClaudeSettings();
    mutator(current);
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8');
    syncFromClaudeSettings();
    return true;
  } catch (err) {
    log(`updateClaudeSettings error: ${err.message}`);
    return false;
  }
}

function installOrRepairClaudeHooks() {
  try {
    fs.mkdirSync(CLAUDE_HOOKS_DIR, { recursive: true });
    if (fs.existsSync(BUNDLED_HOOK_SCRIPT)) {
      fs.copyFileSync(BUNDLED_HOOK_SCRIPT, CLAUDE_HOOK_SCRIPT);
    }
    if (!IS_WIN) {
      try { fs.chmodSync(CLAUDE_HOOK_SCRIPT, 0o755); } catch (_) {}
    }

    const nodeExe = process.execPath;
    const hookCmd = `"${nodeExe}" "${CLAUDE_HOOK_SCRIPT}"`;
    const hookEvents = [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PermissionRequest',
      'PostToolUse',
      'Notification',
      'SubagentStart',
      'SubagentStop',
      'Stop'
    ];

    updateClaudeSettings((cfg) => {
      if (!cfg.hooks || typeof cfg.hooks !== 'object') cfg.hooks = {};
      for (const evtName of hookEvents) {
        const existing = Array.isArray(cfg.hooks[evtName]) ? cfg.hooks[evtName] : [];
        const filtered = existing.filter(
          (entry) => !JSON.stringify(entry).includes('streamdock_notify.js')
        );
        filtered.push({
          hooks: [{ type: 'command', command: hookCmd }]
        });
        cfg.hooks[evtName] = filtered;
      }
      if (!cfg.model) cfg.model = (MODEL_META[agent.model] && MODEL_META[agent.model].cliArg) || 'claude-sonnet-5-5';
      if (!cfg.effortLevel) cfg.effortLevel = agent.effortLevel;
      if (typeof cfg.alwaysThinkingEnabled !== 'boolean') {
        cfg.alwaysThinkingEnabled = agent.thinkingEnabled;
      }
    });

    log(`Claude Code hooks installed/verified (${process.platform}) at ${CLAUDE_SETTINGS_PATH}`);
    return true;
  } catch (err) {
    log(`installOrRepairClaudeHooks error: ${err.message}`);
    return false;
  }
}

syncFromClaudeSettings();
if (!agent.hooksInstalled) {
  installOrRepairClaudeHooks();
}

try {
  if (fs.existsSync(CLAUDE_DIR)) {
    let debounceTimer = null;
    fs.watch(CLAUDE_DIR, (evt, filename) => {
      if (filename === 'settings.json') {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          syncFromClaudeSettings();
          renderAllContexts();
          broadcastStateToPI();
        }, 150);
      }
    });
  }
} catch (_) {}

// ============================================================================
// 5. Hook Event Processing & State Machine
// ============================================================================
function handleHookEvent(payload) {
  if (!payload || typeof payload !== 'object') return;
  const evt = String(payload.hook_event_name || payload.event || '').trim();
  agent.lastEventAt = Date.now();

  if (payload.cwd) {
    agent.cwdFull = String(payload.cwd);
    agent.cwdName = path.basename(agent.cwdFull) || 'workspace';
  }
  if (payload.permission_mode && PERM_META[payload.permission_mode]) {
    agent.permMode = payload.permission_mode;
  }
  if (payload.model) {
    agent.model = normalizeModelName(payload.model);
  }

  const toolName = String(payload.tool_name || payload.toolName || '').trim();

  switch (evt) {
    case 'SessionStart':
      agent.state = 'IDLE';
      agent.rawToolName = '';
      agent.currentTool = '대기';
      agent.waitingDetail = '';
      agent.toolCount = 0;
      agent.subagentCount = 0;
      agent.turnStartedAt = 0;
      break;

    case 'UserPromptSubmit':
      agent.state = 'RUNNING';
      agent.turnStartedAt = Date.now();
      agent.rawToolName = 'Think';
      agent.currentTool = '추론중';
      agent.waitingDetail = '';
      agent.toolCount = 0;
      break;

    case 'PreToolUse':
      agent.state = 'RUNNING';
      if (!agent.turnStartedAt) agent.turnStartedAt = Date.now();
      agent.toolCount += 1;
      agent.rawToolName = toolName || 'Tool';
      agent.currentTool = toolName || '실행중';
      agent.waitingDetail = '';
      break;

    case 'PermissionRequest':
      agent.state = 'WAITING_PERMISSION';
      agent.rawToolName = toolName || 'Approve';
      agent.waitingDetail = toolName ? `${toolName}` : '승인요청';
      agent.currentTool = toolName || '승인대기';
      break;

    case 'PostToolUse':
    case 'PostToolUseFailure':
      agent.state = 'RUNNING';
      if (!agent.turnStartedAt) agent.turnStartedAt = Date.now();
      agent.waitingDetail = '';
      if (toolName) {
        agent.rawToolName = toolName;
        agent.currentTool = toolName;
      }
      break;

    case 'SubagentStart':
      agent.subagentCount += 1;
      agent.state = 'RUNNING';
      if (!agent.turnStartedAt) agent.turnStartedAt = Date.now();
      agent.rawToolName = 'Subagent';
      agent.currentTool = `에이전트×${agent.subagentCount}`;
      break;

    case 'SubagentStop':
      agent.subagentCount = Math.max(0, agent.subagentCount - 1);
      break;

    case 'Notification': {
      const nType = String(payload.notification_type || payload.type || '').toLowerCase();
      const msg = String(payload.message || payload.title || '').trim();
      if (
        nType.includes('permission') ||
        /permission|allow|approve|승인|허용/i.test(msg)
      ) {
        agent.state = 'WAITING_PERMISSION';
        agent.waitingDetail = '승인요청';
      } else {
        agent.state = 'WAITING_INPUT';
        agent.waitingDetail = '입력대기';
      }
      break;
    }

    case 'Stop':
      if (agent.turnStartedAt > 0) {
        agent.lastDurationSec = Math.max(1, Math.round((Date.now() - agent.turnStartedAt) / 1000));
      }
      agent.turnStartedAt = 0;
      agent.subagentCount = 0;
      agent.waitingDetail = '';
      agent.rawToolName = 'Done';
      agent.currentTool = '완료';
      agent.state = 'COMPLETED';
      break;

    default:
      break;
  }

  log(`Hook [${evt}] -> state=${agent.state} tool="${agent.currentTool}"`);
  renderAllContexts();
  broadcastStateToPI();
}

function applySimulatedState(targetState) {
  const s = String(targetState || 'IDLE').toUpperCase();
  agent.lastEventAt = Date.now();
  if (s === 'IDLE') {
    agent.state = 'IDLE';
    agent.turnStartedAt = 0;
    agent.rawToolName = '';
    agent.currentTool = '대기';
    agent.waitingDetail = '';
  } else if (s === 'RUNNING') {
    agent.state = 'RUNNING';
    agent.turnStartedAt = Date.now() - 14000;
    agent.toolCount = Math.max(3, agent.toolCount);
    agent.rawToolName = 'Bash';
    agent.currentTool = 'Bash';
    agent.waitingDetail = '';
  } else if (s === 'WAITING_PERMISSION') {
    agent.state = 'WAITING_PERMISSION';
    if (!agent.turnStartedAt) agent.turnStartedAt = Date.now() - 8000;
    agent.rawToolName = 'Bash';
    agent.currentTool = 'Bash';
    agent.waitingDetail = 'Bash 승인';
  } else if (s === 'WAITING_INPUT') {
    agent.state = 'WAITING_INPUT';
    agent.rawToolName = 'Input';
    agent.currentTool = '입력대기';
    agent.waitingDetail = '선택 대기';
  } else if (s === 'COMPLETED') {
    agent.state = 'COMPLETED';
    agent.lastDurationSec = 18;
    agent.turnStartedAt = 0;
    agent.toolCount = Math.max(5, agent.toolCount);
    agent.rawToolName = 'Done';
    agent.currentTool = '완료';
    agent.waitingDetail = '';
  }
  renderAllContexts();
  broadcastStateToPI();
}

// ============================================================================
// 6. Pure Vector SVG Icon Library + Single-Label High-Legibility Tile Builder
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

function fitFont(text, maxFont = 25, minFont = 16, safePx = 118) {
  const u = Math.max(1, charUnits(text));
  return Math.max(minFont, Math.min(maxFont, Math.floor(safePx / u)));
}

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

// --- Custom Crisp Vector Icons (centered around x=72, y=52) ---
const VEC = {
  claudeStar(col) {
    let lines = '';
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const r1 = i % 2 === 0 ? 9 : 11;
      const r2 = i % 2 === 0 ? 30 : 25;
      const x1 = (72 + Math.cos(a) * r1).toFixed(1);
      const y1 = (52 + Math.sin(a) * r1).toFixed(1);
      const x2 = (72 + Math.cos(a) * r2).toFixed(1);
      const y2 = (52 + Math.sin(a) * r2).toFixed(1);
      lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="6.5" stroke-linecap="round"/>`;
    }
    return `${lines}<circle cx="72" cy="52" r="6" fill="${col}"/>`;
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

  warningTriangle(col, innerCol = '#0B0B0C') {
    return `
      <path d="M 72 20 L 105 77 Q 107 82 101 82 L 43 82 Q 37 82 39 77 Z" fill="${col}" stroke="#000000" stroke-width="3" stroke-linejoin="round"/>
      <line x1="72" y1="40" x2="72" y2="59" stroke="${innerCol}" stroke-width="7" stroke-linecap="round"/>
      <circle cx="72" cy="70.5" r="4.2" fill="${innerCol}"/>
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
    return `
      <polygon points="78,20 48,56 69,56 64,85 95,48 74,48" fill="${col}" stroke="#000000" stroke-width="2.5" stroke-linejoin="round"/>
    `;
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
      <text x="72" y="59" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="19.5" font-weight="900" fill="${col}">${escXml(chipText)}</text>
    `;
  },

  effortBars(activeBars, col) {
    return [1, 2, 3, 4]
      .map((n) => {
        const x = 35 + (n - 1) * 20;
        const h = 16 + n * 11;
        const y = 82 - h;
        const fill = n <= activeBars ? col : '#27272A';
        return `<rect x="${x}" y="${y}" width="14" height="${h}" rx="4" fill="${fill}" stroke="#000000" stroke-width="1.5"/>`;
      })
      .join('');
  },

  bulbSpark(on, col) {
    const rays = on
      ? `
        <line x1="72" y1="14" x2="72" y2="21" stroke="${col}" stroke-width="4.5" stroke-linecap="round"/>
        <line x1="38" y1="28" x2="44" y2="33" stroke="${col}" stroke-width="4.5" stroke-linecap="round"/>
        <line x1="106" y1="28" x2="100" y2="33" stroke="${col}" stroke-width="4.5" stroke-linecap="round"/>
        <line x1="33" y1="50" x2="40" y2="50" stroke="${col}" stroke-width="4.5" stroke-linecap="round"/>
        <line x1="111" y1="50" x2="104" y2="50" stroke="${col}" stroke-width="4.5" stroke-linecap="round"/>
      `
      : '';
    return `
      ${rays}
      <path d="M 58 67 C 53 60 50 54 50 46 A 22 22 0 1 1 94 46 C 94 54 91 60 86 67 Z" fill="${on ? col : 'none'}" fill-opacity="${on ? '0.28' : '0'}" stroke="${col}" stroke-width="5.5" stroke-linejoin="round"/>
      <line x1="61" y1="75" x2="83" y2="75" stroke="${col}" stroke-width="5.5" stroke-linecap="round"/>
      <line x1="65" y1="83" x2="79" y2="83" stroke="${col}" stroke-width="5.5" stroke-linecap="round"/>
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

  resetSweep(col) {
    return `
      <path d="M 96 46 A 25 25 0 1 0 92 67" fill="none" stroke="${col}" stroke-width="6.5" stroke-linecap="round"/>
      <polyline points="83,28 97,46 79,48" fill="none" stroke="${col}" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
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

  coinResume(col) {
    return `
      <ellipse cx="64" cy="34" rx="20" ry="8" fill="${col}" fill-opacity="0.25" stroke="${col}" stroke-width="5"/>
      <path d="M 44 34 V 64 C 44 69 53 73 64 73 C 75 73 84 69 84 64 V 34" fill="none" stroke="${col}" stroke-width="5"/>
      <path d="M 44 49 C 44 54 53 58 64 58 C 75 58 84 54 84 49" fill="none" stroke="${col}" stroke-width="5"/>
      <polygon points="84,52 104,64 84,76" fill="#FCD34D" stroke="#000000" stroke-width="2" stroke-linejoin="round"/>
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

/**
 * Builds an Icon-Centric Stream Dock Tile:
 * - Upper/Center: Large crisp SVG vector icon (or full-canvas scaled 1.24x if iconOnly)
 * - Optional Corner Badge (e.g. timer "00:14" or "[2]")
 * - Bottom: ONE single ultra-bold high-contrast label (22~25px #FFFFFF with 4.2px black stroke)
 */
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
    let bg = '#0B0B0C';
    let border = '#52525B';
    let col = '#94A3B8';
    let icon = VEC.terminalPrompt('#94A3B8');
    let label = '대기중';
    let labelColor = '#E2E8F0';
    let badge = agent.hooksInstalled ? 'ON' : '!';

    if (agent.state === 'RUNNING') {
      bg = '#071E2E';
      border = '#38BDF8';
      col = '#38BDF8';
      const tn = (agent.rawToolName || '').toLowerCase();
      if (tn.includes('edit') || tn.includes('write')) icon = VEC.codeEdit('#38BDF8');
      else if (tn.includes('read') || tn.includes('grep') || tn.includes('glob')) icon = VEC.searchLens('#38BDF8');
      else if (tn.includes('subagent') || tn.includes('task')) icon = VEC.linkNodes('#38BDF8');
      else icon = VEC.terminalPrompt('#38BDF8');
      label = agent.currentTool || '실행중';
      labelColor = '#FFFFFF';
      badge = `${agent.toolCount}`;
    } else if (agent.state === 'WAITING_PERMISSION') {
      bg = pulseOn ? '#3B1D02' : '#1C0E02';
      border = pulseOn ? '#FDE047' : '#F59E0B';
      col = '#FDE047';
      icon = VEC.warningTriangle('#FACC15');
      label = '권한승인';
      labelColor = '#FEF08A';
      badge = '!';
    } else if (agent.state === 'WAITING_INPUT') {
      bg = pulseOn ? '#3B1219' : '#1C080C';
      border = pulseOn ? '#FB923C' : '#F43F5E';
      col = '#FB923C';
      icon = VEC.questionBubble('#FB923C');
      label = '입력대기';
      labelColor = '#FEF08A';
      badge = '?';
    } else if (agent.state === 'COMPLETED') {
      bg = '#05291A';
      border = '#10B981';
      col = '#34D399';
      icon = VEC.checkCircle('#34D399');
      label = `${agent.toolCount}회 완료`;
      labelColor = '#A7F3D0';
      badge = agent.lastDurationSec ? `${agent.lastDurationSec}s` : '✓';
    }

    const urgent = agent.state === 'WAITING_PERMISSION' || agent.state === 'WAITING_INPUT';
    return svgIconTile({
      bg,
      border: flashed ? '#FFFFFF' : border,
      borderWidth: urgent ? 6 : 4.5,
      glowColor: col,
      iconSvg: icon,
      label,
      labelColor,
      badge,
      badgeColor: col,
      iconOnly
    });
  }

  if (mode === 'metrics') {
    const mMeta = MODEL_META[agent.model] || MODEL_META.sonnet;
    const eMeta = EFFORT_META[agent.effortLevel] || EFFORT_META.high;
    return svgIconTile({
      bg: '#0B0B0C',
      border: flashed ? '#FFFFFF' : mMeta.border,
      borderWidth: 4.5,
      glowColor: mMeta.border,
      iconSvg: VEC.aiChip(mMeta.color, mMeta.chip),
      label: `${eMeta.label}·${PERM_META[agent.permMode].label}`,
      labelColor: '#FFFFFF',
      badge: agent.thinkingEnabled ? '🧠' : '',
      badgeColor: '#E9D5FF',
      iconOnly
    });
  }

  // Default: 'overview' (Primary Agent Status Icon Tile)
  let bg = '#0B0B0C';
  let border = '#D97757';
  let glow = '#D97757';
  let icon = VEC.claudeStar('#FF8B66');
  let label = '대기';
  let labelColor = '#FFFFFF';
  let badge = '';

  if (agent.state === 'RUNNING') {
    bg = '#071E2E';
    border = '#38BDF8';
    glow = '#38BDF8';
    icon = VEC.spinner('#38BDF8', agent.tick);
    label = formatDuration(elapsedSec);
    labelColor = '#7DD3FC';
    badge = 'RUN';
  } else if (agent.state === 'WAITING_PERMISSION') {
    bg = pulseOn ? '#422006' : '#1F1003';
    border = pulseOn ? '#FDE047' : '#F59E0B';
    glow = '#F59E0B';
    icon = VEC.warningTriangle(pulseOn ? '#FDE047' : '#F59E0B');
    label = '승인대기';
    labelColor = '#FEF08A';
  } else if (agent.state === 'WAITING_INPUT') {
    bg = pulseOn ? '#431407' : '#1F0B05';
    border = pulseOn ? '#FDBA74' : '#FB923C';
    glow = '#FB923C';
    icon = VEC.questionBubble('#FB923C');
    label = '입력대기';
    labelColor = '#FEF08A';
  } else if (agent.state === 'COMPLETED') {
    bg = '#05291A';
    border = '#10B981';
    glow = '#10B981';
    icon = VEC.checkCircle('#34D399');
    label = '완료';
    labelColor = '#6EE7B7';
    badge = agent.lastDurationSec ? `${agent.lastDurationSec}s` : '';
  }

  const urgent = agent.state === 'WAITING_PERMISSION' || agent.state === 'WAITING_INPUT';
  return svgIconTile({
    bg,
    border: flashed ? '#FFFFFF' : border,
    borderWidth: urgent ? 6 : 4.5,
    glowColor: glow,
    iconSvg: icon,
    label,
    labelColor,
    badge,
    badgeColor: labelColor,
    iconOnly
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
      border: flashed ? '#FFFFFF' : col,
      borderWidth: waitingPerm ? 6 : 4.5,
      glowColor: col,
      iconSvg: VEC.doubleCheck(col),
      label: '세션허용',
      labelColor: waitingPerm ? '#FEF08A' : '#FFFFFF',
      badge: '2',
      badgeColor: col,
      iconOnly
    });
  }

  if (type === 'reject') {
    const col = activeRun ? '#FB7185' : '#F43F5E';
    return svgIconTile({
      bg: activeRun ? '#2E0913' : '#0B0B0C',
      border: flashed ? '#FFFFFF' : col,
      borderWidth: activeRun ? 5.5 : 4.5,
      glowColor: col,
      iconSvg: VEC.stopCross(col),
      label: '중단',
      labelColor: '#FFFFFF',
      badge: 'ESC',
      badgeColor: '#FDA4AF',
      iconOnly
    });
  }

  const col = waitingAny ? (pulseOn ? '#34D399' : '#FACC15') : '#34D399';
  return svgIconTile({
    bg: waitingAny && pulseOn ? '#063321' : '#0B0B0C',
    border: flashed ? '#FFFFFF' : col,
    borderWidth: waitingAny ? 6 : 4.5,
    glowColor: col,
    iconSvg: VEC.bigCheck(col),
    label: '승인',
    labelColor: waitingAny ? '#FEF08A' : '#FFFFFF',
    badge: '⏎',
    badgeColor: col,
    iconOnly
  });
}

function renderModelSvg(settings = {}, flashed = false) {
  const mode = settings.modelMode || 'cycle';
  const iconOnly = settings.displayStyle === 'icon_only';
  const shownKey = mode === 'fixed' ? normalizeModelName(settings.targetModel) : agent.model;
  const meta = MODEL_META[shownKey] || MODEL_META.sonnet;
  const isActive = agent.model === shownKey;

  const startCx = 72 - ((MODEL_ORDER.length - 1) * 15) / 2;
  const dots =
    mode === 'cycle'
      ? MODEL_ORDER.map((m, idx) => {
          const cx = startCx + idx * 15;
          const active = m === agent.model;
          const col = active ? MODEL_META[m].color : '#3F3F46';
          const r = active ? 5 : 3.2;
          return `<circle cx="${cx}" cy="128" r="${r}" fill="${col}" stroke="#000000" stroke-width="1"/>`;
        }).join('')
      : '';

  return svgIconTile({
    bg: '#0B0B0C',
    border: flashed ? '#FFFFFF' : isActive ? meta.border : '#3F3F46',
    borderWidth: 4.5,
    glowColor: meta.border,
    iconSvg: VEC.aiChip(meta.color, meta.chip),
    label: meta.short,
    labelColor: '#FFFFFF',
    extraBottomSvg: dots,
    iconOnly
  });
}

function renderModeSvg(settings = {}, flashed = false) {
  const sType = settings.settingType || 'perm_mode';
  const iconOnly = settings.displayStyle === 'icon_only';

  if (sType === 'effort') {
    const eMeta = EFFORT_META[agent.effortLevel] || EFFORT_META.high;
    return svgIconTile({
      bg: '#0B0B0C',
      border: flashed ? '#FFFFFF' : eMeta.border,
      borderWidth: 4.5,
      glowColor: eMeta.border,
      iconSvg: VEC.effortBars(eMeta.bars, eMeta.color),
      label: eMeta.kor,
      labelColor: '#FFFFFF',
      iconOnly
    });
  }

  if (sType === 'thinking') {
    const on = agent.thinkingEnabled;
    const col = on ? '#C084FC' : '#71717A';
    return svgIconTile({
      bg: on ? '#1D0E2E' : '#0B0B0C',
      border: flashed ? '#FFFFFF' : on ? '#A855F7' : '#52525B',
      borderWidth: 4.5,
      glowColor: on ? '#A855F7' : '',
      iconSvg: VEC.bulbSpark(on, col),
      label: on ? '사고 ON' : '사고 OFF',
      labelColor: on ? '#F3E8FF' : '#CBD5E1',
      badge: IS_MAC ? '⌥T' : 'Alt+T',
      badgeColor: '#E9D5FF',
      iconOnly
    });
  }

  const pMeta = PERM_META[agent.permMode] || PERM_META.default;
  const icon =
    agent.permMode === 'acceptEdits'
      ? VEC.bolt(pMeta.color)
      : agent.permMode === 'plan'
        ? VEC.blueprint(pMeta.color)
        : VEC.shield(pMeta.color);

  return svgIconTile({
    bg: '#0B0B0C',
    border: flashed ? '#FFFFFF' : pMeta.border,
    borderWidth: 4.5,
    glowColor: pMeta.border,
    iconSvg: icon,
    label: pMeta.label,
    labelColor: '#FFFFFF',
    iconOnly
  });
}

const CMD_PRESETS = {
  compact: {
    shortLabel: '압축',
    color: '#FBBF24',
    border: '#F59E0B',
    cmd: '/compact',
    longCmd: '/context',
    iconFn: () => VEC.compress('#FBBF24')
  },
  clear: {
    shortLabel: '초기화',
    color: '#F87171',
    border: '#EF4444',
    cmd: '/clear',
    longCmd: '/doctor',
    iconFn: () => VEC.resetSweep('#F87171')
  },
  cost: {
    shortLabel: '비용·재개',
    color: '#34D399',
    border: '#10B981',
    cmd: '/cost',
    longCmd: '/resume',
    iconFn: () => VEC.coinResume('#34D399')
  },
  vibe_fix: {
    shortLabel: '빌드수정',
    color: '#38BDF8',
    border: '#0284C7',
    cmd: '빌드와 테스트를 실행하고 에러나 실패한 항목이 있으면 원인을 찾아 수정해줘',
    longCmd: '',
    iconFn: () => VEC.wrenchFix('#38BDF8')
  },
  vibe_commit: {
    shortLabel: '커밋',
    color: '#FF8B66',
    border: '#D97757',
    cmd: 'git status와 diff를 확인해서 변경사항을 깔끔하게 요약하고 적절한 커밋 메시지로 커밋해줘',
    longCmd: '/diff',
    iconFn: () => VEC.gitGraph('#FF8B66')
  }
};

function renderCommandSvg(settings = {}, flashed = false) {
  const presetKey = settings.preset || 'compact';
  const iconOnly = settings.displayStyle === 'icon_only';
  const preset = CMD_PRESETS[presetKey] || {
    shortLabel: settings.label || '명령',
    color: '#FBBF24',
    border: '#F59E0B',
    iconFn: () => VEC.terminalPrompt('#FBBF24')
  };

  // Map verbose default preset labels to ultra-clean icon labels unless customized by user
  const defaultLegacyLabels = new Set(['/compact', '/clear', '/cost', '빌드 & 수정', '빌드·수정', '요약 & 커밋', '요약·커밋', 'COMPACT']);
  const label =
    settings.label && !defaultLegacyLabels.has(settings.label)
      ? settings.label
      : preset.shortLabel;

  return svgIconTile({
    bg: '#0B0B0C',
    border: flashed ? '#FFFFFF' : preset.border,
    borderWidth: 4.5,
    glowColor: preset.border,
    iconSvg: preset.iconFn(),
    label,
    labelColor: '#FFFFFF',
    iconOnly
  });
}

function renderUtilitySvg(settings = {}, flashed = false) {
  const uType = settings.utilType || 'voice';
  const iconOnly = settings.displayStyle === 'icon_only';

  if (uType === 'screenshot') {
    return svgIconTile({
      bg: '#0B0B0C',
      border: flashed ? '#FFFFFF' : '#06B6D4',
      borderWidth: 4.5,
      glowColor: '#06B6D4',
      iconSvg: VEC.screenshotFrame('#22D3EE'),
      label: '스샷',
      labelColor: '#FFFFFF',
      badge: IS_MAC ? '⌃V' : 'Alt+V',
      badgeColor: '#67E8F9',
      iconOnly
    });
  }

  if (uType === 'launch') {
    return svgIconTile({
      bg: '#0B0B0C',
      border: flashed ? '#FFFFFF' : '#D97757',
      borderWidth: 4.5,
      glowColor: '#D97757',
      iconSvg: VEC.terminalPrompt('#FF8B66'),
      label: '터미널',
      labelColor: '#FFFFFF',
      iconOnly
    });
  }

  if (uType === 'install_hooks') {
    const col = agent.hooksInstalled ? '#34D399' : '#FBBF24';
    return svgIconTile({
      bg: '#0B0B0C',
      border: flashed ? '#FFFFFF' : col,
      borderWidth: 4.5,
      glowColor: col,
      iconSvg: VEC.linkNodes(col),
      label: '훅점검',
      labelColor: '#FFFFFF',
      iconOnly
    });
  }

  // Default: 'voice'
  return svgIconTile({
    bg: '#0B0B0C',
    border: flashed ? '#FFFFFF' : '#EC4899',
    borderWidth: 4.5,
    glowColor: '#EC4899',
    iconSvg: VEC.mic('#F472B6'),
    label: '음성',
    labelColor: '#FFFFFF',
    badge: IS_MAC ? 'Fn' : 'Win+H',
    badgeColor: '#F9A8D4',
    iconOnly
  });
}

// ============================================================================
// 7. Stream Dock Context Management & Action Handlers
// ============================================================================
const contexts = new Map();
let sdWs = null;
const activePIConns = new Set();

function sendJson(obj) {
  if (sdWs && sdWs.readyState === 1) {
    sdWs.send(JSON.stringify(obj));
  }
}

function renderContext(ctx) {
  const entry = contexts.get(ctx);
  if (!entry) return;
  const flashed = entry.flashUntil > Date.now();
  let svg = '';

  switch (entry.action) {
    case 'com.vibecoding.claudecode.status':
      svg = renderStatusSvg(entry.settings, flashed);
      break;
    case 'com.vibecoding.claudecode.approval':
      svg = renderApprovalSvg(entry.settings, flashed);
      break;
    case 'com.vibecoding.claudecode.model':
      svg = renderModelSvg(entry.settings, flashed);
      break;
    case 'com.vibecoding.claudecode.mode':
      svg = renderModeSvg(entry.settings, flashed);
      break;
    case 'com.vibecoding.claudecode.command':
      svg = renderCommandSvg(entry.settings, flashed);
      break;
    case 'com.vibecoding.claudecode.utility':
      svg = renderUtilitySvg(entry.settings, flashed);
      break;
    default:
      return;
  }

  if (svg !== entry.lastSvg) {
    entry.lastSvg = svg;
    sendJson({
      event: 'setImage',
      context: ctx,
      payload: {
        target: 0,
        image: 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svg)
      }
    });
  }
}

function renderAllContexts() {
  for (const ctx of contexts.keys()) {
    renderContext(ctx);
  }
}

function flashContext(ctx, ms = 420) {
  const entry = contexts.get(ctx);
  if (!entry) return;
  entry.flashUntil = Date.now() + ms;
  renderContext(ctx);
  setTimeout(() => renderContext(ctx), ms + 30);
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
  for (const st of steps) {
    setTimeout(() => applySimulatedState(st.state), st.delay);
  }
}

function handleActionTrigger(ctx, isLongPress) {
  const entry = contexts.get(ctx);
  if (!entry) return;
  const s = entry.settings || {};
  flashContext(ctx);

  switch (entry.action) {
    case 'com.vibecoding.claudecode.status': {
      if (isLongPress) {
        const order = ['IDLE', 'RUNNING', 'WAITING_PERMISSION', 'WAITING_INPUT', 'COMPLETED'];
        const next = order[(order.indexOf(agent.state) + 1) % order.length];
        applySimulatedState(next);
      } else {
        if (agent.state === 'COMPLETED') {
          agent.state = 'IDLE';
          agent.currentTool = '대기';
          renderAllContexts();
        }
        bridge.focusTerminal(true, agent.cwdFull);
      }
      break;
    }

    case 'com.vibecoding.claudecode.approval': {
      const rType = s.responseType || 'approve';
      const autoFocus = s.autoFocusTerminal !== false;
      if (rType === 'approve_session') {
        if (isLongPress) {
          bridge.sendLogicalKey('shift+tab', autoFocus);
        } else {
          bridge.sendLogicalKey('2', autoFocus);
          if (agent.state === 'WAITING_PERMISSION') {
            agent.state = 'RUNNING';
            agent.waitingDetail = '';
            renderAllContexts();
          }
        }
      } else if (rType === 'reject') {
        if (isLongPress) {
          bridge.sendLogicalKey('ctrl+c', autoFocus);
        } else {
          bridge.sendLogicalKey('esc', autoFocus);
        }
        if (agent.state !== 'IDLE') {
          agent.state = 'IDLE';
          agent.turnStartedAt = 0;
          agent.waitingDetail = '';
          agent.currentTool = '중단됨';
          renderAllContexts();
        }
      } else {
        if (isLongPress) {
          bridge.sendText('y', true, autoFocus);
        } else {
          bridge.sendLogicalKey('enter', autoFocus);
        }
        if (agent.state === 'WAITING_PERMISSION' || agent.state === 'WAITING_INPUT') {
          agent.state = 'RUNNING';
          agent.waitingDetail = '';
          renderAllContexts();
        }
      }
      break;
    }

    case 'com.vibecoding.claudecode.model': {
      let nextModel = 'sonnet';
      if ((s.modelMode || 'cycle') === 'fixed') {
        nextModel = normalizeModelName(s.targetModel);
      } else if (isLongPress) {
        nextModel = 'sonnet';
      } else {
        const idx = MODEL_ORDER.indexOf(agent.model);
        nextModel = MODEL_ORDER[(idx + 1) % MODEL_ORDER.length];
      }
      agent.model = nextModel;
      const modelCliId = (MODEL_META[nextModel] && MODEL_META[nextModel].cliArg) || nextModel;
      updateClaudeSettings((cfg) => {
        cfg.model = modelCliId;
      });
      if (s.sendSlashCommand !== false) {
        bridge.sendText(`/model ${modelCliId}`, true, true, true);
      }
      renderAllContexts();
      broadcastStateToPI();
      break;
    }

    case 'com.vibecoding.claudecode.mode': {
      const sType = s.settingType || 'perm_mode';
      if (sType === 'effort') {
        const idx = EFFORT_ORDER.indexOf(agent.effortLevel);
        const nextEffort = isLongPress
          ? 'high'
          : EFFORT_ORDER[(idx + 1) % EFFORT_ORDER.length];
        agent.effortLevel = nextEffort;
        updateClaudeSettings((cfg) => {
          cfg.effortLevel = nextEffort;
        });
        if (s.sendSlashCommand === true) {
          bridge.sendText(`/effort ${nextEffort}`, true, true, true);
        }
      } else if (sType === 'thinking') {
        agent.thinkingEnabled = !agent.thinkingEnabled;
        updateClaudeSettings((cfg) => {
          cfg.alwaysThinkingEnabled = agent.thinkingEnabled;
        });
        bridge.sendLogicalKey('thinking', true, true);
      } else {
        const idx = PERM_ORDER.indexOf(agent.permMode);
        agent.permMode = PERM_ORDER[(idx + 1) % PERM_ORDER.length];
        bridge.sendLogicalKey('shift+tab', true, true);
      }
      renderAllContexts();
      broadcastStateToPI();
      break;
    }

    case 'com.vibecoding.claudecode.command': {
      const preset = CMD_PRESETS[s.preset || 'compact'] || CMD_PRESETS.compact;
      const primaryCmd = s.commandText !== undefined && s.commandText !== '' ? s.commandText : preset.cmd;
      const longCmd = s.longPressCommand !== undefined && s.longPressCommand !== '' ? s.longPressCommand : preset.longCmd;
      const chosen = isLongPress && longCmd ? longCmd : primaryCmd;
      const autoEnter = s.autoEnter !== false;
      if (chosen) {
        bridge.sendText(chosen, autoEnter, true, true);
      }
      break;
    }

    case 'com.vibecoding.claudecode.utility': {
      const uType = s.utilType || 'voice';
      if (uType === 'voice') {
        bridge.sendLogicalKey('voice', true, false);
      } else if (uType === 'screenshot') {
        if (isLongPress) {
          bridge.sendLogicalKey('screen_snip', false, false);
        } else {
          bridge.sendLogicalKey('image_paste', true, true);
        }
      } else if (uType === 'launch') {
        if (isLongPress) {
          bridge.launchClaude(agent.cwdFull);
        } else {
          bridge.focusTerminal(true, agent.cwdFull);
        }
      } else if (uType === 'install_hooks') {
        installOrRepairClaudeHooks();
        runLiveDemoSequence();
      }
      renderAllContexts();
      broadcastStateToPI();
      break;
    }

    default:
      break;
  }
}

setInterval(() => {
  agent.tick = (agent.tick + 1) % 100000;
  if (
    agent.state === 'RUNNING' ||
    agent.state === 'WAITING_PERMISSION' ||
    agent.state === 'WAITING_INPUT'
  ) {
    renderAllContexts();
  }
}, 900);

// ============================================================================
// 8. Local HTTP Server (127.0.0.1:17530) for Hooks & Diagnostics
// ============================================================================
function getPublicState() {
  const mMeta = MODEL_META[agent.model] || MODEL_META.sonnet;
  return {
    platform: process.platform,
    state: agent.state,
    currentTool: agent.currentTool,
    waitingDetail: agent.waitingDetail,
    toolCount: agent.toolCount,
    subagentCount: agent.subagentCount,
    elapsedSec: agent.turnStartedAt ? Math.round((Date.now() - agent.turnStartedAt) / 1000) : 0,
    lastDurationSec: agent.lastDurationSec,
    cwdName: agent.cwdName,
    model: agent.model,
    modelDisplay: mMeta.short,
    modelId: mMeta.cliArg,
    effortLevel: agent.effortLevel,
    thinkingEnabled: agent.thinkingEnabled,
    permMode: agent.permMode,
    hooksInstalled: agent.hooksInstalled,
    connectedContexts: contexts.size
  };
}

function startLocalHttpServer() {
  const srv = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, ...getPublicState() }));
      return;
    }

    if (req.method === 'POST' && (req.url === '/hook' || req.url === '/simulate')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8').trim();
          const body = raw ? JSON.parse(raw) : {};
          if (req.url === '/simulate') {
            if (body.demo) {
              runLiveDemoSequence();
            } else {
              applySimulatedState(body.state || 'IDLE');
            }
          } else {
            handleHookEvent(body);
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, state: agent.state }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });

  srv.on('error', (err) => {
    log(`HTTP server error on ${HTTP_PORT}: ${err.message}`);
  });

  srv.listen(HTTP_PORT, '127.0.0.1', () => {
    log(`Claude Hook HTTP server listening on http://127.0.0.1:${HTTP_PORT} (${process.platform})`);
  });
}

startLocalHttpServer();

// ============================================================================
// 9. Stream Dock WebSocket Bootstrap
// ============================================================================
function parseCliArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '-port' && argv[i + 1]) out.port = argv[++i];
    else if (flag === '-pluginUUID' && argv[i + 1]) out.pluginUUID = argv[++i];
    else if (flag === '-registerEvent' && argv[i + 1]) out.registerEvent = argv[++i];
    else if (flag === '-info' && argv[i + 1]) out.info = argv[++i];
  }
  if (!out.port && argv[3]) out.port = argv[3];
  if (!out.pluginUUID && argv[5]) out.pluginUUID = argv[5];
  if (!out.registerEvent && argv[7]) out.registerEvent = argv[7];
  return out;
}

const cli = parseCliArgs(process.argv);
log(`Starting plugin (${process.platform}) port=${cli.port} uuid=${cli.pluginUUID} event=${cli.registerEvent}`);

if (cli.port && cli.pluginUUID && cli.registerEvent) {
  sdWs = new MiniWebSocket(`ws://127.0.0.1:${cli.port}`);

  sdWs.onopen = () => {
    log(`Connected to Stream Dock WebSocket on port ${cli.port}`);
    sendJson({
      event: cli.registerEvent,
      uuid: cli.pluginUUID
    });
  };

  sdWs.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      const { event, action, context, payload } = msg;

      switch (event) {
        case 'willAppear': {
          contexts.set(context, {
            action,
            settings: (payload && payload.settings) || {},
            downAt: 0,
            flashUntil: 0,
            lastSvg: ''
          });
          renderContext(context);
          break;
        }

        case 'willDisappear': {
          contexts.delete(context);
          activePIConns.delete(context);
          break;
        }

        case 'didReceiveSettings': {
          const entry = contexts.get(context);
          if (entry) {
            entry.settings = (payload && payload.settings) || {};
            entry.lastSvg = '';
            renderContext(context);
          }
          break;
        }

        case 'keyDown': {
          const entry = contexts.get(context);
          if (entry) entry.downAt = Date.now();
          break;
        }

        case 'keyUp': {
          const entry = contexts.get(context);
          const heldMs = entry && entry.downAt ? Date.now() - entry.downAt : 0;
          if (entry) entry.downAt = 0;
          handleActionTrigger(context, heldMs >= 550);
          break;
        }

        case 'propertyInspectorDidAppear': {
          activePIConns.add(context);
          sendJson({
            event: 'sendToPropertyInspector',
            action,
            context,
            payload: { type: 'stateUpdate', state: getPublicState() }
          });
          break;
        }

        case 'propertyInspectorDidDisappear': {
          activePIConns.delete(context);
          break;
        }

        case 'sendToPlugin': {
          if (payload && payload.cmd === 'simulate') {
            applySimulatedState(payload.state);
          } else if (payload && payload.cmd === 'demo') {
            runLiveDemoSequence();
          } else if (payload && payload.cmd === 'installHooks') {
            installOrRepairClaudeHooks();
            renderAllContexts();
            broadcastStateToPI();
          } else if (payload && payload.cmd === 'getState') {
            broadcastStateToPI();
          }
          break;
        }

        default:
          break;
      }
    } catch (err) {
      log(`WS message error: ${err.message}`);
    }
  };

  sdWs.onerror = (err) => {
    log(`WS error: ${err.message}`);
  };

  sdWs.onclose = () => {
    log('Stream Dock WebSocket closed, exiting.');
    process.exit(0);
  };
}
