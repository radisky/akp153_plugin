'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const HOME_DIR = os.homedir();
const LOOPBACK_HOST = '127.0.0.1';

// ============================================================================
// 1. Strict Localhost (127.0.0.1) Port & Loopback Security Helpers
// ============================================================================
function parseLoopbackPort(raw, defaultPort) {
  const n = Number(raw || defaultPort);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : defaultPort;
}

function isLoopbackAddress(addr) {
  if (!addr) return false;
  const s = String(addr).trim().toLowerCase();
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1';
}

function isLocalHostHeader(hostHeader, expectedPort) {
  if (!hostHeader) return true;
  const raw = String(hostHeader).trim().toLowerCase();
  let hostPart = raw;
  let portPart = '';

  if (raw.startsWith('[')) {
    const closeIdx = raw.indexOf(']');
    if (closeIdx < 0) return false;
    hostPart = raw.slice(0, closeIdx + 1);
    const rest = raw.slice(closeIdx + 1);
    if (rest.startsWith(':')) portPart = rest.slice(1);
    else if (rest !== '') return false;
  } else {
    const colonIdx = raw.indexOf(':');
    if (colonIdx >= 0) {
      hostPart = raw.slice(0, colonIdx);
      portPart = raw.slice(colonIdx + 1);
    }
  }

  if (hostPart !== '127.0.0.1' && hostPart !== 'localhost' && hostPart !== '[::1]') {
    return false;
  }
  if (portPart && Number(portPart) !== expectedPort) {
    return false;
  }
  return true;
}

function isAllowedLocalOrigin(req) {
  const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (secFetchSite === 'cross-site') return false;

  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;
  if (origin.startsWith('file://')) return true;
  if (origin === 'null') return secFetchSite !== 'cross-site';

  try {
    const parsed = new URL(origin);
    const h = (parsed.hostname || '').toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch (_) {
    return false;
  }
}

function createLocalhostHttpServer({ port, onRequest, log }) {
  const safePort = parseLoopbackPort(port, 17530);
  const srv = http.createServer((req, res) => {
    const remoteAddr = req.socket && req.socket.remoteAddress;
    if (!isLoopbackAddress(remoteAddr)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'forbidden_remote_address' }));
      try { req.socket.destroy(); } catch (_) {}
      return;
    }

    if (!isLocalHostHeader(req.headers.host, safePort)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'forbidden_host' }));
      return;
    }

    if (!isAllowedLocalOrigin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'forbidden_origin' }));
      return;
    }

    onRequest(req, res);
  });

  srv.on('connection', (socket) => {
    if (!isLoopbackAddress(socket.remoteAddress)) {
      try { socket.destroy(); } catch (_) {}
    }
  });

  srv.on('error', (err) => {
    if (log) log(`HTTP server error on ${LOOPBACK_HOST}:${safePort}: ${err.message}`);
  });

  // Bind strictly to IPv4 loopback (127.0.0.1) only — never 0.0.0.0 / ::
  srv.listen({ port: safePort, host: LOOPBACK_HOST, exclusive: false }, () => {
    if (log) log(`Localhost HTTP server bound strictly to http://${LOOPBACK_HOST}:${safePort} (${process.platform})`);
  });

  return srv;
}

// ============================================================================
// 2. Pure Node.js RFC 6455 WebSocket Client (Loopback-Restricted)
// ============================================================================
class MiniWebSocket {
  constructor(url) {
    const parsed = new URL(url);
    const rawHost = (parsed.hostname || LOOPBACK_HOST).toLowerCase();
    if (rawHost !== '127.0.0.1' && rawHost !== 'localhost' && rawHost !== '::1' && rawHost !== '[::1]') {
      throw new Error(`Refusing non-loopback WebSocket host: ${rawHost}`);
    }
    this.host = rawHost === 'localhost' ? LOOPBACK_HOST : parsed.hostname || LOOPBACK_HOST;
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
    const reqOpts = {
      hostname: this.host,
      port: this.port,
      path: this.pathname,
      method: 'GET',
      headers: {
        Host: `${this.host}:${this.port}`,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key
      }
    };
    if (this.host === LOOPBACK_HOST) {
      reqOpts.localAddress = LOOPBACK_HOST;
    }

    const req = http.request(reqOpts);

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
// 3. macOS JXA Session-Aware Window & Shortcut Bridge (Orca + IDEs + Terminals)
// ============================================================================
const MAC_JXA_SCRIPT = `
function run(argv) {
  const req = JSON.parse(argv[0]);
  const se = Application("System Events");

  const termTokens = [
    "iterm2", "iterm", "terminal", "warp", "ghostty", "wezterm-gui", "wezterm",
    "alacritty", "kitty", "hyper", "tabby", "rio", "waveterm"
  ];
  const ideTokens = [
    "orca", "orca-ide", "antigravity", "codex", "cursor", "visual studio code",
    "code - insiders", "vscodium", "windsurf", "zed", "trae", "cmux", "conductor",
    "superset", "pearai", "void", "fleet", "intellij", "webstorm", "pycharm",
    "goland", "clion", "rider", "rubymine", "phpstorm", "android studio",
    "xcode", "nova", "sublime text", "claude"
  ];
  const exactIdeNames = ["code", "idea", "studio", "orca", "zed", "cursor", "codex", "antigravity", "windsurf", "cmux", "trae", "fleet"];
  const ignoreTokens = ["stream dock", "streamdock", "streamdeck"];

  const targetPid = Number(req.targetPid || 0);
  const liveHostPids = Array.isArray(req.liveHostPids) ? req.liveHostPids.map(Number) : [];
  const cwdHints = Array.isArray(req.cwdHints) ? req.cwdHints.map(function(s) { return String(s || "").toLowerCase(); }).filter(Boolean) : [];
  const agentKeywords = Array.isArray(req.agentKeywords) ? req.agentKeywords.map(function(s) { return String(s || "").toLowerCase(); }).filter(Boolean) : [];
  const pureGuiApps = Array.isArray(req.pureGuiApps) ? req.pureGuiApps.map(function(s) { return String(s || "").toLowerCase(); }).filter(Boolean) : [];

  function hasAny(hay, arr) {
    if (!hay) return false;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] && hay.indexOf(arr[i]) >= 0) return true;
    }
    return false;
  }

  function classifyProc(p, pid) {
    let pName = "", dispName = "", bundleId = "", isFront = false;
    try { pName = String(p.name() || ""); } catch (e) { return null; }
    try { dispName = String(p.displayedName() || ""); } catch (e) {}
    try { bundleId = String(p.bundleIdentifier() || ""); } catch (e) {}
    try { isFront = Boolean(p.frontmost()); } catch (e) {}

    const pLow = pName.toLowerCase();
    const dLow = dispName.toLowerCase();
    const bLow = bundleId.toLowerCase();
    const combined = pLow + " | " + dLow + " | " + bLow;

    if (hasAny(combined, ignoreTokens)) return null;

    const isOrca =
      pLow === "orca" ||
      dLow === "orca" ||
      dLow.indexOf("orca ") === 0 ||
      pLow.indexOf("orca") >= 0 ||
      bLow.indexOf("orca") >= 0;

    const isWarp = pLow === "warp" || dLow === "warp" || bLow.indexOf("dev.warp") >= 0;
    const isTerm =
      !isOrca &&
      (isWarp ||
        termTokens.indexOf(pLow) >= 0 ||
        termTokens.indexOf(dLow) >= 0 ||
        bLow.indexOf("apple.terminal") >= 0 ||
        bLow.indexOf("googlecode.iterm2") >= 0 ||
        bLow.indexOf("ghostty") >= 0 ||
        bLow.indexOf("wezterm") >= 0 ||
        bLow.indexOf("alacritty") >= 0 ||
        bLow.indexOf("kovidgoyal.kitty") >= 0);

    const isKnownIde =
      isOrca ||
      exactIdeNames.indexOf(pLow) >= 0 ||
      exactIdeNames.indexOf(dLow) >= 0 ||
      hasAny(dLow, ideTokens) ||
      hasAny(pLow, ideTokens) ||
      bLow.indexOf("microsoft.vscode") >= 0 ||
      bLow.indexOf("todesktop") >= 0 ||
      bLow.indexOf("jetbrains") >= 0 ||
      bLow.indexOf("antigravity") >= 0 ||
      bLow.indexOf("cursor") >= 0 ||
      bLow.indexOf("windsurf") >= 0 ||
      bLow.indexOf("dev.zed") >= 0 ||
      bLow.indexOf("openai.codex") >= 0 ||
      bLow.indexOf("anthropic.claude") >= 0;

    const isSessionOwner = (targetPid > 0 && pid === targetPid) || liveHostPids.indexOf(pid) >= 0;
    if (!isTerm && !isKnownIde && !isSessionOwner) return null;

    let matchedCwdWin = null;
    let matchedAgentWin = null;
    let firstWin = null;
    let winCount = 0;

    try {
      const wins = p.windows();
      winCount = wins.length;
      for (let w = 0; w < wins.length; w++) {
        const winObj = wins[w];
        let wt = "";
        try { wt = String(winObj.name() || ""); } catch (e) {}
        if (!firstWin) firstWin = winObj;
        const wtLow = wt.toLowerCase();
        if (!matchedCwdWin && cwdHints.length > 0 && hasAny(wtLow, cwdHints)) {
          matchedCwdWin = winObj;
        }
        if (!matchedAgentWin && agentKeywords.length > 0 && hasAny(wtLow, agentKeywords)) {
          matchedAgentWin = winObj;
        }
      }
    } catch (e) {}

    let score = 100;
    if (isFront) score += 1200;
    if (targetPid > 0 && pid === targetPid) score += 950;
    else if (liveHostPids.indexOf(pid) >= 0) score += 550;

    if (matchedCwdWin) score += 320;
    if (matchedAgentWin || hasAny(combined, agentKeywords)) score += 220;
    if (isOrca) score += 90;
    if (winCount === 0 && !isFront && !isSessionOwner) score -= 60;

    const isPureGui = !isOrca && !isTerm && pureGuiApps.length > 0 && hasAny(combined, pureGuiApps);

    return {
      proc: p,
      pid: pid,
      name: dispName || pName,
      procName: pName,
      isFront: isFront,
      isOrca: isOrca,
      isIde: !isTerm,
      isTerm: isTerm,
      isPureGui: isPureGui,
      win: matchedCwdWin || matchedAgentWin || firstWin,
      score: score
    };
  }

  function findBestTarget() {
    const procs = se.applicationProcesses.whose({ backgroundOnly: false })();
    let best = null;
    for (let i = 0; i < procs.length; i++) {
      const p = procs[i];
      let pid = 0;
      try { pid = Number(p.unixId() || 0); } catch (e) {}
      const info = classifyProc(p, pid);
      if (!info) continue;
      if (!best || info.score > best.score) {
        best = info;
      }
    }
    return best;
  }

  function focusInfo(info) {
    if (!info || !info.proc) return;
    const wasFront = info.isFront;
    info.proc.frontmost = true;
    if (info.win) {
      try { info.win.actions.byName("AXRaise").perform(); } catch (e) {}
    }
    if (!wasFront) delay(0.045);
  }

  if (req.cmd === "probe" || req.cmd === "focus") {
    const found = findBestTarget();
    if (found) {
      if (req.cmd === "focus") focusInfo(found);
      return JSON.stringify({
        ok: true,
        foundCoding: true,
        pid: found.pid,
        target: found.name,
        isOrca: found.isOrca,
        isIde: found.isIde,
        isTerm: found.isTerm,
        isPureGui: found.isPureGui,
        isFront: found.isFront
      });
    }
    if (req.cmd === "focus" && req.launchIfMissing) {
      if (req.preferApp) {
        try {
          const app = Application(req.preferApp);
          app.activate();
          return JSON.stringify({ ok: true, foundCoding: true, launched: true, target: req.preferApp });
        } catch (e) {}
      }
      const term = Application("Terminal");
      term.activate();
      return JSON.stringify({ ok: true, foundCoding: true, launched: true, target: "Terminal" });
    }
    return JSON.stringify({ ok: false, foundCoding: false });
  }

  if (req.cmd === "launch") {
    if (req.preferApp) {
      try {
        const app = Application(req.preferApp);
        app.activate();
        return JSON.stringify({ ok: true, launched: req.preferApp });
      } catch (e) {}
    }
    const sqEsc = String.fromCharCode(39, 92, 39, 39);
    const cwdEsc = String(req.cwd || "").split("'").join(sqEsc);
    const cdPart = cwdEsc ? ("cd '" + cwdEsc + "' && ") : "";
    const cliBin = String(req.cliBin || "claude");
    const shCmd = cdPart + "(command -v " + cliBin + " >/dev/null 2>&1 && " + cliBin + " || echo '" + cliBin + " CLI Ready')";
    try {
      const iterm = Application("iTerm");
      if (iterm.running()) {
        iterm.activate();
        const win = iterm.createWindowWithDefaultProfile();
        win.currentSession.write({ text: shCmd });
        return JSON.stringify({ ok: true, launched: "iTerm" });
      }
    } catch (e) {}
    const term = Application("Terminal");
    term.activate();
    term.doScript(shCmd);
    return JSON.stringify({ ok: true, launched: "Terminal" });
  }

  if (req.cmd === "key") {
    const combo = String(req.combo || "").toLowerCase();
    const isGlobal = (combo === "voice" || combo === "screen_snip");
    const found = findBestTarget();

    if (req.focus && found && combo !== "screen_snip") {
      focusInfo(found);
    }
    if (!isGlobal && req.requireCoding && !found) {
      return JSON.stringify({ ok: false, skipped: "no_coding_window" });
    }

    switch (combo) {
      case "enter":     se.keyCode(36); break;
      case "esc":       se.keyCode(53); break;
      case "1":         se.keyCode(18); break;
      case "2":         se.keyCode(19); break;
      case "ctrl+c":    se.keyCode(8, { using: "control down" }); break;
      case "ctrl+l":    se.keyCode(37, { using: "control down" }); break;
      case "shift+tab": se.keyCode(48, { using: "shift down" }); break;
      case "thinking":  se.keyCode(17, { using: "option down" }); break;
      case "image_paste":
        if (found && found.isPureGui) {
          se.keyCode(9, { using: "command down" });
        } else {
          se.keyCode(9, { using: "control down" });
        }
        break;
      case "screen_snip":
        se.keyCode(21, { using: ["command down", "control down", "shift down"] });
        break;
      case "cmd+v":
        se.keyCode(9, { using: "command down" });
        break;
      case "cmd+v+enter":
        se.keyCode(9, { using: "command down" });
        delay(0.065);
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
      default:
        se.keyCode(36);
        break;
    }

    return JSON.stringify({
      ok: true,
      combo: combo,
      target: found ? found.name : "",
      isOrca: Boolean(found && found.isOrca),
      isPureGui: Boolean(found && found.isPureGui)
    });
  }

  return JSON.stringify({ ok: false, error: "unknown_cmd" });
}
`;

// ============================================================================
// 4. Process Ancestry & Orca / Multi-IDE Session Bridge
// ============================================================================
const GENERIC_DIRS = new Set([
  '', '.', '..', 'users', 'home', 'workspace', 'workspaces', 'worktrees',
  'project', 'projects', 'repos', 'src', 'app', 'main', 'master', 'orca', '.orca'
]);

function extractCwdHints(cwdPath, orcaWorktreePath = '') {
  const hints = [];
  const addFromPath = (p) => {
    if (!p) return;
    const norm = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = norm.split('/').filter(Boolean);
    if (parts.length === 0) return;

    const leaf = parts[parts.length - 1];
    if (leaf && leaf.length >= 2 && !GENERIC_DIRS.has(leaf.toLowerCase())) {
      hints.push(leaf);
    }

    const wtIdx = parts.findIndex((seg) => seg.toLowerCase() === 'worktrees' || seg.toLowerCase() === '.worktrees');
    if (wtIdx > 0) {
      const before = parts[wtIdx - 1];
      if (before && before !== '.orca' && before !== '.git' && !GENERIC_DIRS.has(before.toLowerCase())) {
        hints.push(before);
      } else if (wtIdx > 1 && (before === '.orca' || before === '.git')) {
        const repoParent = parts[wtIdx - 2];
        if (repoParent && !GENERIC_DIRS.has(repoParent.toLowerCase())) hints.push(repoParent);
      }
      if (wtIdx + 1 < parts.length) {
        const after = parts[wtIdx + 1];
        if (after && !GENERIC_DIRS.has(after.toLowerCase())) hints.push(after);
      }
    }
  };

  addFromPath(cwdPath);
  addFromPath(orcaWorktreePath);
  return Array.from(new Set(hints));
}

function classifyMacProcessEntry(cmdLine) {
  const low = String(cmdLine || '').toLowerCase();
  if (!low || low.includes('streamdock') || low.includes('stream dock')) return null;

  // Ignore Electron/macOS sub-helpers so we keep walking up to the main .app bundle process
  if (low.includes('helper.app/') || low.includes('crashpad_handler') || low.includes('.xpc/')) {
    return null;
  }

  if (low.includes('/orca.app/contents/macos/') || /(?:^|\/)orca(?:-ide)?(?:\s|$)/.test(low)) {
    return { app: 'Orca', kind: 'orca' };
  }
  if (low.includes('/antigravity.app/contents/macos/')) return { app: 'Antigravity', kind: 'ide' };
  if (low.includes('/codex.app/contents/macos/')) return { app: 'Codex', kind: 'ide' };
  if (low.includes('/cursor.app/contents/macos/')) return { app: 'Cursor', kind: 'ide' };
  if (low.includes('/visual studio code.app/contents/macos/') || low.includes('/vscodium.app/contents/macos/') || low.includes('/code - insiders.app/contents/macos/')) {
    return { app: 'Visual Studio Code', kind: 'ide' };
  }
  if (low.includes('/windsurf.app/contents/macos/')) return { app: 'Windsurf', kind: 'ide' };
  if (low.includes('/zed.app/contents/macos/')) return { app: 'Zed', kind: 'ide' };
  if (low.includes('/cmux.app/contents/macos/')) return { app: 'cmux', kind: 'ide' };
  if (low.includes('/conductor.app/contents/macos/')) return { app: 'Conductor', kind: 'ide' };
  if (low.includes('/superset.app/contents/macos/')) return { app: 'Superset', kind: 'ide' };
  if (low.includes('/trae.app/contents/macos/')) return { app: 'Trae', kind: 'ide' };
  if (low.includes('/claude.app/contents/macos/')) return { app: 'Claude', kind: 'ide' };
  if (/(intellij|webstorm|pycharm|goland|clion|rider|rubymine|phpstorm|android studio|fleet).*\.app\/contents\/macos\//.test(low)) {
    return { app: 'JetBrains IDE', kind: 'ide' };
  }
  if (low.includes('/iterm.app/contents/macos/')) return { app: 'iTerm2', kind: 'terminal' };
  if (low.includes('/terminal.app/contents/macos/')) return { app: 'Terminal', kind: 'terminal' };
  if (low.includes('/warp.app/contents/macos/')) return { app: 'Warp', kind: 'terminal' };
  if (low.includes('/ghostty.app/contents/macos/')) return { app: 'Ghostty', kind: 'terminal' };
  if (low.includes('/wezterm.app/contents/macos/') || low.includes('wezterm-gui')) return { app: 'WezTerm', kind: 'terminal' };
  if (low.includes('/alacritty.app/contents/macos/')) return { app: 'Alacritty', kind: 'terminal' };
  if (low.includes('/kitty.app/contents/macos/')) return { app: 'kitty', kind: 'terminal' };

  if (low.includes('.app/contents/macos/')) {
    const m = cmdLine.match(/\/([^/]+)\.app\/Contents\/MacOS\//i);
    if (m && m[1]) return { app: m[1], kind: 'ide' };
  }
  return null;
}

class SessionBridge {
  constructor({
    agentKind = 'claude',
    agentBinaries = ['claude'],
    agentKeywords = ['claude'],
    pureGuiApps = [],
    preferLaunchApp = '',
    winBridgeScript = '',
    log = () => {}
  }) {
    this.agentKind = agentKind;
    this.agentBinaries = agentBinaries;
    this.agentKeywords = agentKeywords;
    this.pureGuiApps = pureGuiApps;
    this.preferLaunchApp = preferLaunchApp;
    this.winBridgeScript = winBridgeScript;
    this.log = log;

    this.session = {
      agentPid: 0,
      hostPid: 0,
      hostApp: '',
      hostKind: '',
      isCliSession: false,
      cwd: '',
      cwdHints: [],
      orcaHandle: '',
      orcaWorktreeId: '',
      orcaWorktreePath: '',
      orcaCli: '',
      termProgram: '',
      liveHostPids: [],
      updatedAt: 0
    };

    this.lastPsScanAt = 0;
    this.orcaCliCache = { bin: null, checkedAt: 0 };

    this.winProc = null;
    this.startingWin = false;
    if (IS_WIN && this.winBridgeScript && fs.existsSync(this.winBridgeScript)) {
      this._spawnWinBridge();
    }
  }

  isPidAlive(pid) {
    const n = Number(pid || 0);
    if (!n || n <= 1) return false;
    try {
      process.kill(n, 0);
      return true;
    } catch (err) {
      return err && err.code === 'EPERM';
    }
  }

  setCwd(cwdPath) {
    if (!cwdPath) return;
    this.session.cwd = String(cwdPath);
    this.session.cwdHints = extractCwdHints(this.session.cwd, this.session.orcaWorktreePath);
  }

  updateFromHook(payload) {
    if (!payload || typeof payload !== 'object') return;

    const hookCwd =
      payload.cwd ||
      (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]) ||
      (payload._session && payload._session.cwd) ||
      '';
    if (hookCwd) this.setCwd(hookCwd);

    const meta = payload._session;
    if (meta && typeof meta === 'object') {
      if (meta.orcaHandle) this.session.orcaHandle = String(meta.orcaHandle);
      if (meta.orcaWorktreeId) this.session.orcaWorktreeId = String(meta.orcaWorktreeId);
      if (meta.orcaWorktreePath) {
        this.session.orcaWorktreePath = String(meta.orcaWorktreePath);
        this.session.cwdHints = extractCwdHints(this.session.cwd, this.session.orcaWorktreePath);
      }
      if (meta.orcaCli) this.session.orcaCli = String(meta.orcaCli);
      if (meta.termProgram) this.session.termProgram = String(meta.termProgram);

      const tpLow = String(meta.termProgram || '').toLowerCase();
      if (
        this.session.orcaHandle ||
        this.session.orcaWorktreePath ||
        tpLow.includes('orca')
      ) {
        this.session.hostKind = 'orca';
        this.session.hostApp = 'Orca';
        this.session.isCliSession = true;
      } else if (tpLow) {
        this.session.isCliSession = true;
      }

      const pid = Number(meta.agentPid || 0);
      if (pid > 1) {
        this.session.agentPid = pid;
        this.session.updatedAt = Date.now();
        if (IS_MAC) {
          this._resolveMacProcessTree(pid, () => {});
        }
      }
    }
  }

  _resolveMacProcessTree(seedAgentPid, done) {
    if (!IS_MAC) {
      if (done) done();
      return;
    }
    this.lastPsScanAt = Date.now();
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,args='], { timeout: 900, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) {
        if (done) done();
        return;
      }
      const procMap = new Map();
      const cliPids = [];
      const binRegex = new RegExp(`(?:^|/)(?:${this.agentBinaries.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:\\s|$)`, 'i');

      for (const rawLine of String(stdout).split('\n')) {
        const m = rawLine.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const ppid = Number(m[2]);
        const args = m[3] || '';
        procMap.set(pid, { pid, ppid, args });

        if (
          pid !== process.pid &&
          !args.includes('streamdock_') &&
          !args.includes('StreamDock') &&
          binRegex.test(args)
        ) {
          cliPids.push(pid);
        }
      }

      const findTopAppOwner = (startPid) => {
        let cur = Number(startPid || 0);
        let bestOwner = null;
        let sawShellOrPty = false;
        const visited = new Set();
        while (cur > 1 && !visited.has(cur)) {
          visited.add(cur);
          const entry = procMap.get(cur);
          if (!entry) break;
          if (/\/(zsh|bash|fish|sh|tmux|login)(\s|$)/i.test(entry.args)) {
            sawShellOrPty = true;
          }
          const classified = classifyMacProcessEntry(entry.args);
          if (classified) {
            bestOwner = { pid: entry.pid, ...classified, sawShellOrPty };
          }
          cur = entry.ppid;
        }
        return bestOwner;
      };

      if (seedAgentPid > 1) {
        const owner = findTopAppOwner(seedAgentPid);
        if (owner) {
          this.session.hostPid = owner.pid;
          this.session.hostApp = owner.app;
          this.session.hostKind = owner.kind;
          if (owner.kind === 'orca' || owner.kind === 'terminal' || owner.sawShellOrPty) {
            this.session.isCliSession = true;
          }
          this.log(`[SessionBridge] Bound active session PID ${seedAgentPid} -> ${owner.app} (PID ${owner.pid})`);
        }
      }

      const liveOwners = [];
      for (const cPid of cliPids) {
        const owner = findTopAppOwner(cPid);
        if (owner) {
          liveOwners.push(owner.pid);
          if (!this.session.hostPid || !this.isPidAlive(this.session.hostPid)) {
            this.session.agentPid = cPid;
            this.session.hostPid = owner.pid;
            this.session.hostApp = owner.app;
            this.session.hostKind = owner.kind;
            this.session.isCliSession = true;
          }
        }
      }
      this.session.liveHostPids = Array.from(new Set(liveOwners));
      if (done) done();
    });
  }

  _ensureMacSessionFresh(cb) {
    if (!IS_MAC) {
      cb();
      return;
    }
    if (this.session.hostPid && !this.isPidAlive(this.session.hostPid)) {
      this.session.hostPid = 0;
      this.session.hostApp = '';
      this.session.hostKind = '';
    }
    if (!this.session.hostPid && Date.now() - this.lastPsScanAt > 1500) {
      this._resolveMacProcessTree(this.session.agentPid, cb);
      return;
    }
    cb();
  }

  // --------------------------------------------------------------------------
  // Orca CLI Discovery & Direct PTY Session Control (`orca terminal ...`)
  // --------------------------------------------------------------------------
  _resolveOrcaCli(cb) {
    if (this.session.orcaCli && fs.existsSync(this.session.orcaCli)) {
      cb(this.session.orcaCli);
      return;
    }
    if (process.env.ORCA_CLI_COMMAND && fs.existsSync(process.env.ORCA_CLI_COMMAND)) {
      cb(process.env.ORCA_CLI_COMMAND);
      return;
    }

    if (Date.now() - this.orcaCliCache.checkedAt < 45000) {
      cb(this.orcaCliCache.bin);
      return;
    }

    const candidates = IS_WIN
      ? [
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Orca', 'resources', 'bin', 'orca.cmd'),
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Orca', 'resources', 'bin', 'orca.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'orca', 'bin', 'orca.exe')
        ]
      : [
          '/opt/homebrew/bin/orca',
          '/usr/local/bin/orca',
          path.join(HOME_DIR, '.local', 'bin', 'orca'),
          '/Applications/Orca.app/Contents/Resources/bin/orca',
          '/Applications/Orca.app/Contents/MacOS/orca-cli',
          '/opt/homebrew/bin/orca-ide',
          '/usr/local/bin/orca-ide'
        ];

    for (const c of candidates) {
      try {
        if (c && fs.existsSync(c) && fs.statSync(c).isFile()) {
          this.orcaCliCache = { bin: c, checkedAt: Date.now() };
          cb(c);
          return;
        }
      } catch (_) {}
    }

    const locator = IS_WIN ? 'where.exe' : '/usr/bin/which';
    execFile(locator, ['orca'], { timeout: 500 }, (err, stdout) => {
      const found = !err && stdout ? String(stdout).trim().split(/\r?\n/)[0].trim() : '';
      this.orcaCliCache = { bin: found || null, checkedAt: Date.now() };
      cb(this.orcaCliCache.bin);
    });
  }

  _extractOrcaTerminals(parsed) {
    if (!parsed) return [];
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.terminals)) return parsed.terminals;
    if (parsed.result && Array.isArray(parsed.result.terminals)) return parsed.result.terminals;
    if (parsed.data && Array.isArray(parsed.data.terminals)) return parsed.data.terminals;
    return [];
  }

  _selectBestOrcaHandle(orcaBin, cb) {
    execFile(orcaBin, ['terminal', 'list', '--json'], { timeout: 650 }, (err, stdout) => {
      if (err || !stdout) {
        cb(this.session.orcaHandle || '');
        return;
      }
      let list = [];
      try {
        list = this._extractOrcaTerminals(JSON.parse(String(stdout).trim()));
      } catch (_) {
        cb(this.session.orcaHandle || '');
        return;
      }

      if (!list.length) {
        cb(this.session.orcaHandle || '');
        return;
      }

      const getHandle = (t) => String((t && (t.handle || t.id || t.terminalId)) || '');

      if (this.session.orcaHandle) {
        const exact = list.find((t) => getHandle(t) === this.session.orcaHandle);
        if (exact) {
          cb(this.session.orcaHandle);
          return;
        }
      }

      const normCwd = String(this.session.orcaWorktreePath || this.session.cwd || '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();

      let bestHandle = '';
      let bestScore = -1;

      for (const t of list) {
        const handle = getHandle(t);
        if (!handle) continue;
        const status = String(t.status || t.state || '').toLowerCase();
        if (status === 'orphaned' || status === 'closed' || status === 'exited') continue;

        let score = 10;
        const wtPath = String(t.worktreePath || t.cwd || t.path || '')
          .replace(/\\/g, '/')
          .replace(/\/+$/, '')
          .toLowerCase();
        const desc = `${t.command || ''} ${t.title || ''} ${t.name || ''} ${t.agent || ''} ${t.shell || ''}`.toLowerCase();

        if (normCwd && wtPath) {
          if (normCwd === wtPath) score += 500;
          else if (normCwd.startsWith(wtPath + '/') || wtPath.startsWith(normCwd + '/')) score += 350;
        }
        if (this.agentKeywords.some((kw) => kw && desc.includes(kw))) {
          score += 320;
        }
        if (t.active || t.focused || t.isActive || t.isFocused) {
          score += 160;
        }

        if (score > bestScore) {
          bestScore = score;
          bestHandle = handle;
        }
      }

      cb(bestHandle);
    });
  }

  _tryOrcaFocusPane(cb) {
    this._resolveOrcaCli((orcaBin) => {
      if (!orcaBin) {
        if (cb) cb(false);
        return;
      }
      this._selectBestOrcaHandle(orcaBin, (handle) => {
        if (!handle) {
          if (cb) cb(false);
          return;
        }
        execFile(orcaBin, ['terminal', 'focus', '--terminal', handle], { timeout: 450 }, () => {
          if (cb) cb(true, handle);
        });
      });
    });
  }

  _tryOrcaSendText(text, enter, cb) {
    this._resolveOrcaCli((orcaBin) => {
      if (!orcaBin) {
        cb(false);
        return;
      }
      this._selectBestOrcaHandle(orcaBin, (handle) => {
        if (!handle) {
          cb(false);
          return;
        }
        execFile(orcaBin, ['terminal', 'focus', '--terminal', handle], { timeout: 350 }, () => {
          const args = ['terminal', 'send', '--terminal', handle, '--text', String(text)];
          if (enter) args.push('--enter');
          args.push('--json');
          execFile(orcaBin, args, { timeout: 900 }, (sendErr) => {
            if (sendErr) {
              this.log(`[OrcaBridge] terminal send fallback to GUI paste (${sendErr.message})`);
              cb(false);
              return;
            }
            this.log(`[OrcaBridge] Delivered to Orca handle ${handle}`);
            cb(true);
          });
        });
      });
    });
  }

  // --------------------------------------------------------------------------
  // Windows Persistent Win32 Bridge
  // --------------------------------------------------------------------------
  _spawnWinBridge() {
    if (this.startingWin || this.winProc || !this.winBridgeScript) return;
    this.startingWin = true;
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.winBridgeScript],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
      child.stdin.setDefaultEncoding('utf8');
      child.stdout.on('data', (d) => {
        const s = d.toString('utf8').trim();
        if (s) this.log(`[WinBridge] ${s}`);
      });
      child.stderr.on('data', (d) => {
        const s = d.toString('utf8').trim();
        if (s) this.log(`[WinBridge:ERR] ${s}`);
      });
      child.on('exit', () => {
        this.winProc = null;
        this.startingWin = false;
      });
      this.winProc = child;
      this.startingWin = false;
    } catch (err) {
      this.log(`[WinBridge] spawn error: ${err.message}`);
      this.startingWin = false;
    }
  }

  _sendWin(cmdObj) {
    if (!this.winProc) this._spawnWinBridge();
    if (this.winProc && this.winProc.stdin && !this.winProc.stdin.destroyed) {
      try {
        const enriched = {
          agentKind: this.agentKind,
          agentPid: this.session.agentPid || 0,
          targetPid: this.session.hostPid || 0,
          cwdHints: this.session.cwdHints || [],
          agentKeywords: this.agentKeywords,
          agentBinaries: this.agentBinaries,
          pureGuiApps: this.pureGuiApps,
          ...cmdObj
        };
        this.winProc.stdin.write(JSON.stringify(enriched) + '\n', 'utf8');
      } catch (err) {
        this.log(`[WinBridge] write error: ${err.message}`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // macOS JXA & Clipboard Helpers
  // --------------------------------------------------------------------------
  _runMacJxa(reqObj, cb) {
    const payload = {
      targetPid: this.session.hostPid || 0,
      liveHostPids: this.session.liveHostPids || [],
      cwdHints: this.session.cwdHints || [],
      agentKeywords: this.agentKeywords,
      pureGuiApps: this.pureGuiApps,
      preferApp: this.preferLaunchApp || '',
      ...reqObj
    };
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', MAC_JXA_SCRIPT, JSON.stringify(payload)],
      { timeout: 3500 },
      (err, stdout, stderr) => {
        if (err) {
          this.log(`[MacBridge:ERR] ${err.message} ${stderr || ''}`.trim());
          if (cb) cb(null);
          return;
        }
        const out = String(stdout || '').trim();
        if (out) this.log(`[MacBridge] ${out}`);
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

  _macPasteAndRestore(text, enter, focus) {
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
                setTimeout(() => this._macClipboardWrite(prevClip), 240);
              }
            }
          );
        });
      }
    );
  }

  // --------------------------------------------------------------------------
  // Unified Public Control API (Focus, Keys, Text, Slash Commands, Launch)
  // --------------------------------------------------------------------------
  focusApp(launchIfMissing = false, cwd = '') {
    if (cwd) this.setCwd(cwd);
    if (IS_WIN) {
      if (this.session.hostKind === 'orca' || this.session.orcaHandle) {
        this._tryOrcaFocusPane();
      }
      this._sendWin({ cmd: 'focus', launchIfMissing, cwd: cwd || this.session.cwd });
      return;
    }
    if (IS_MAC) {
      this._ensureMacSessionFresh(() => {
        this._runMacJxa({ cmd: 'focus', launchIfMissing, cwd: cwd || this.session.cwd }, (res) => {
          if ((res && res.isOrca) || this.session.hostKind === 'orca') {
            this._tryOrcaFocusPane();
          }
        });
      });
    }
  }

  focusTerminal(launchIfMissing = false, cwd = '') {
    this.focusApp(launchIfMissing, cwd);
  }

  sendLogicalKey(actionKey, focus = true, requireCoding = true) {
    const k = String(actionKey || '').toLowerCase().trim();

    // IME-safe single-letter responses ('y', 'a', 'n') so Korean IME never types 'ㅛ', 'ㅁ', 'ㅜ'
    if (k === 'y' || k === 'a' || k === 'n') {
      this.sendText(k, false, focus, requireCoding);
      return;
    }

    if (IS_WIN) {
      if (this.session.hostKind === 'orca' || this.session.orcaHandle) {
        this._tryOrcaFocusPane();
      }
      const winMap = {
        thinking: 'alt+t',
        screen_snip: 'win+shift+s',
        voice: 'win+h'
      };
      this._sendWin({ cmd: 'key', combo: winMap[k] || k, focus, requireCoding });
      return;
    }

    if (IS_MAC) {
      this._ensureMacSessionFresh(() => {
        if (this.session.hostKind === 'orca' || this.session.orcaHandle) {
          this._tryOrcaFocusPane(() => {
            this._runMacJxa({ cmd: 'key', combo: k, focus, requireCoding });
          });
        } else {
          this._runMacJxa({ cmd: 'key', combo: k, focus, requireCoding }, (res) => {
            if (res && res.isOrca) this._tryOrcaFocusPane();
          });
        }
      });
    }
  }

  sendText(text, enter = true, focus = true, requireCoding = true, options = {}) {
    const str = String(text ?? '');
    if (!str) return;

    if (IS_WIN) {
      if (this.session.hostKind === 'orca' || this.session.orcaHandle) {
        if (focus) this._sendWin({ cmd: 'focus', launchIfMissing: false, cwd: this.session.cwd });
        this._tryOrcaSendText(str, enter, (sentViaOrca) => {
          if (!sentViaOrca) {
            this._sendWin({
              cmd: 'text',
              text: str,
              enter,
              focus,
              requireCoding,
              skipPureGui: Boolean(options.skipPureGui)
            });
          }
        });
        return;
      }
      this._sendWin({
        cmd: 'text',
        text: str,
        enter,
        focus,
        requireCoding,
        skipPureGui: Boolean(options.skipPureGui)
      });
      return;
    }

    if (IS_MAC) {
      this._ensureMacSessionFresh(() => {
        this._runMacJxa({ cmd: focus ? 'focus' : 'probe', launchIfMissing: false }, (res) => {
          if (requireCoding && (!res || !res.foundCoding)) {
            if (this.session.hostKind === 'orca' || this.session.orcaHandle) {
              this._tryOrcaSendText(str, enter, () => {});
            } else {
              this.log('[SessionBridge] Skipped sendText: no coding IDE/Terminal window found');
            }
            return;
          }

          if (options.skipPureGui && res && res.isPureGui && !this.session.isCliSession) {
            this.log(`[SessionBridge] Skipped CLI-only slash command on pure GUI window (${res.target})`);
            return;
          }

          const targetIsOrca = Boolean((res && res.isOrca) || this.session.hostKind === 'orca' || this.session.orcaHandle);
          if (targetIsOrca) {
            this._tryOrcaSendText(str, enter, (sentViaOrca) => {
              if (!sentViaOrca) {
                this._macPasteAndRestore(str, enter, false);
              }
            });
            return;
          }

          this._macPasteAndRestore(str, enter, false);
        });
      });
    }
  }

  launchAgent(cwd = '') {
    let safeCwd = '';
    const candidate = cwd || this.session.cwd || '';
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        safeCwd = candidate;
      }
    } catch (_) {}

    const cliBin = this.agentBinaries[0] || 'claude';
    if (IS_WIN) {
      this._sendWin({ cmd: `launch_${this.agentKind}`, cliBin, cwd: safeCwd });
    } else if (IS_MAC) {
      this._runMacJxa({ cmd: 'launch', cliBin, cwd: safeCwd });
    }
  }
}

module.exports = {
  LOOPBACK_HOST,
  parseLoopbackPort,
  createLocalhostHttpServer,
  MiniWebSocket,
  SessionBridge
};
