'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  LOOPBACK_HOST,
  parseLoopbackPort,
  createLocalhostHttpServer,
  MiniWebSocket,
  SessionBridge
} = require('./session_bridge');

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
const HTTP_PORT = parseLoopbackPort(process.env.CLAUDE_SD_HTTP_PORT, 17530);

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
// 2. Orca / Multi-IDE / Terminal Active Session Bridge
// ============================================================================
const bridge = new SessionBridge({
  agentKind: 'claude',
  agentBinaries: ['claude', 'claude-code'],
  agentKeywords: ['claude'],
  pureGuiApps: ['claude'],
  winBridgeScript: WIN_BRIDGE_SCRIPT,
  log
});

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
  low:    { label: 'LOW',  kor: 'EFF LOW',  bars: 1, color: '#CBD5E1', border: '#94A3B8' },
  medium: { label: 'MED',  kor: 'EFF MED',  bars: 2, color: '#7DD3FC', border: '#38BDF8' },
  high:   { label: 'HIGH', kor: 'EFF HIGH', bars: 3, color: '#FCD34D', border: '#F59E0B' },
  max:    { label: 'MAX',  kor: 'EFF MAX',  bars: 4, color: '#F472B6', border: '#EC4899' }
};

const PERM_ORDER = ['default', 'acceptEdits', 'plan'];
const PERM_META = {
  default:     { label: 'DEFAULT',   color: '#7DD3FC', border: '#38BDF8' },
  acceptEdits: { label: 'AUTO-EDIT', color: '#34D399', border: '#10B981' },
  plan:        { label: 'PLAN',      color: '#C084FC', border: '#A855F7' }
};

const agent = {
  state: 'IDLE',
  currentTool: 'IDLE',
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
  bridge.updateFromHook(payload);
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
      agent.currentTool = 'IDLE';
      agent.waitingDetail = '';
      agent.toolCount = 0;
      agent.subagentCount = 0;
      agent.turnStartedAt = 0;
      break;

    case 'UserPromptSubmit':
      agent.state = 'RUNNING';
      agent.turnStartedAt = Date.now();
      agent.rawToolName = 'Think';
      agent.currentTool = 'Thinking';
      agent.waitingDetail = '';
      agent.toolCount = 0;
      break;

    case 'PreToolUse':
      agent.state = 'RUNNING';
      if (!agent.turnStartedAt) agent.turnStartedAt = Date.now();
      agent.toolCount += 1;
      agent.rawToolName = toolName || 'Tool';
      agent.currentTool = toolName || 'Running';
      agent.waitingDetail = '';
      break;

    case 'PermissionRequest':
      agent.state = 'WAITING_PERMISSION';
      agent.rawToolName = toolName || 'Approve';
      agent.waitingDetail = toolName ? `${toolName}` : 'Approval';
      agent.currentTool = toolName || 'Approve';
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
      agent.currentTool = `Agent×${agent.subagentCount}`;
      break;

    case 'SubagentStop':
      agent.subagentCount = Math.max(0, agent.subagentCount - 1);
      break;

    case 'Notification': {
      const nType = String(payload.notification_type || payload.type || '').toLowerCase();
      const msg = String(payload.message || payload.title || '').trim();
      if (
        nType.includes('permission') ||
        /permission|allow|approve/i.test(msg)
      ) {
        agent.state = 'WAITING_PERMISSION';
        agent.waitingDetail = 'Approval';
      } else {
        agent.state = 'WAITING_INPUT';
        agent.waitingDetail = 'Input';
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
      agent.currentTool = 'Done';
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
    agent.currentTool = 'IDLE';
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
    agent.waitingDetail = 'Bash Approval';
  } else if (s === 'WAITING_INPUT') {
    agent.state = 'WAITING_INPUT';
    agent.rawToolName = 'Input';
    agent.currentTool = 'Input';
    agent.waitingDetail = 'Awaiting Choice';
  } else if (s === 'COMPLETED') {
    agent.state = 'COMPLETED';
    agent.lastDurationSec = 18;
    agent.turnStartedAt = 0;
    agent.toolCount = Math.max(5, agent.toolCount);
    agent.rawToolName = 'Done';
    agent.currentTool = 'Done';
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
    let label = 'IDLE';
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
      label = agent.currentTool || 'Running';
      labelColor = '#FFFFFF';
      badge = `${agent.toolCount}`;
    } else if (agent.state === 'WAITING_PERMISSION') {
      bg = pulseOn ? '#3B1D02' : '#1C0E02';
      border = pulseOn ? '#FDE047' : '#F59E0B';
      col = '#FDE047';
      icon = VEC.warningTriangle('#FACC15');
      label = 'PERMIT';
      labelColor = '#FEF08A';
      badge = '!';
    } else if (agent.state === 'WAITING_INPUT') {
      bg = pulseOn ? '#3B1219' : '#1C080C';
      border = pulseOn ? '#FB923C' : '#F43F5E';
      col = '#FB923C';
      icon = VEC.questionBubble('#FB923C');
      label = 'INPUT';
      labelColor = '#FEF08A';
      badge = '?';
    } else if (agent.state === 'COMPLETED') {
      bg = '#05291A';
      border = '#10B981';
      col = '#34D399';
      icon = VEC.checkCircle('#34D399');
      label = `${agent.toolCount} DONE`;
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
  let label = 'IDLE';
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
    label = 'PERMIT';
    labelColor = '#FEF08A';
  } else if (agent.state === 'WAITING_INPUT') {
    bg = pulseOn ? '#431407' : '#1F0B05';
    border = pulseOn ? '#FDBA74' : '#FB923C';
    glow = '#FB923C';
    icon = VEC.questionBubble('#FB923C');
    label = 'INPUT';
    labelColor = '#FEF08A';
  } else if (agent.state === 'COMPLETED') {
    bg = '#05291A';
    border = '#10B981';
    glow = '#10B981';
    icon = VEC.checkCircle('#34D399');
    label = 'DONE';
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
      label: 'SESSION',
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
      label: 'STOP',
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
    label: 'APPROVE',
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
      label: on ? 'THINK ON' : 'THINK OFF',
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
    shortLabel: 'COMPACT',
    color: '#FBBF24',
    border: '#F59E0B',
    cmd: '/compact',
    longCmd: '/context',
    iconFn: () => VEC.compress('#FBBF24')
  },
  clear: {
    shortLabel: 'CLEAR',
    color: '#F87171',
    border: '#EF4444',
    cmd: '/clear',
    longCmd: '/doctor',
    iconFn: () => VEC.resetSweep('#F87171')
  },
  cost: {
    shortLabel: 'COST',
    color: '#34D399',
    border: '#10B981',
    cmd: '/cost',
    longCmd: '/resume',
    iconFn: () => VEC.coinResume('#34D399')
  },
  vibe_fix: {
    shortLabel: 'FIX',
    color: '#38BDF8',
    border: '#0284C7',
    cmd: 'Run the build and tests, and if any errors or failures occur, find the root cause and fix them.',
    longCmd: '',
    iconFn: () => VEC.wrenchFix('#38BDF8')
  },
  vibe_commit: {
    shortLabel: 'COMMIT',
    color: '#FF8B66',
    border: '#D97757',
    cmd: 'Check git status and diff, summarize the changes cleanly, and create a git commit with an appropriate message.',
    longCmd: '/diff',
    iconFn: () => VEC.gitGraph('#FF8B66')
  }
};

function renderCommandSvg(settings = {}, flashed = false) {
  const presetKey = settings.preset || 'compact';
  const iconOnly = settings.displayStyle === 'icon_only';
  const preset = CMD_PRESETS[presetKey] || {
    shortLabel: settings.label || 'CMD',
    color: '#FBBF24',
    border: '#F59E0B',
    iconFn: () => VEC.terminalPrompt('#FBBF24')
  };

  // Map verbose default preset labels to ultra-clean icon labels unless customized by user
  const defaultLegacyLabels = new Set(['/compact', '/clear', '/cost', 'Build & Fix', 'Summarize & Commit', 'COMPACT']);
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
      label: 'PASTE',
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
      label: 'TERMINAL',
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
      label: 'HOOKS',
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
    label: 'VOICE',
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
          agent.currentTool = 'IDLE';
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
          agent.currentTool = 'Stopped';
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
        if (s.sendSlashCommand !== false) {
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
          bridge.launchAgent(agent.cwdFull);
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
    model: agent.model,
    modelDisplay: mMeta.short,
    modelId: mMeta.cliArg,
    effortLevel: agent.effortLevel,
    thinkingEnabled: agent.thinkingEnabled,
    permMode: agent.permMode,
    sessionHost: bridge.session.hostApp || '',
    hooksInstalled: agent.hooksInstalled,
    connectedContexts: contexts.size
  };
}

function startLocalHttpServer() {
  createLocalhostHttpServer({
    port: HTTP_PORT,
    log,
    onRequest: (req, res) => {
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
          if (totalBytes > 65536) {
            req.destroy();
            return;
          }
          chunks.push(c);
        });
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
    }
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
  sdWs = new MiniWebSocket(`ws://${LOOPBACK_HOST}:${cli.port}`);

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
