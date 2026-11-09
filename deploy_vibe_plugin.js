'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const SD_ROOT = path.join(APPDATA, 'HotSpot', 'StreamDock');
const PLUGINS_DIR = path.join(SD_ROOT, 'plugins');
const PROFILES_DIR = path.join(SD_ROOT, 'profiles');
const CONFIG_INI = path.join(SD_ROOT, 'config', 'StreamDockConfig.ini');

const WORKSPACE_PLUGINS = path.join(__dirname, 'plugins');

const PLUGINS = [
  'com.vibecoding.claudecode.sdPlugin',
  'com.vibecoding.antigravity.sdPlugin',
  'com.vibecoding.codex.sdPlugin'
];

const PROFILE_IDS = {
  claude: 'CLAUDE01-VIBE-CODE-153E-000000000001.sdProfile',
  antigravity: 'ANTIGRAV-VIBE-CODE-153E-000000000002.sdProfile',
  codex: 'CODEX001-VIBE-CODE-153E-000000000003.sdProfile'
};

function detectDeviceSerial() {
  try {
    if (fs.existsSync(CONFIG_INI)) {
      const ini = fs.readFileSync(CONFIG_INI, 'utf8');
      const m = ini.match(/\[AKP153E([A-Za-z0-9]+)DeviceConfig\]/);
      if (m && m[1]) return m[1];
    }
  } catch (_) {}
  return '';
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'plugin_runtime.log') continue;
    const sPath = path.join(src, entry.name);
    const dPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(sPath, dPath);
    } else {
      fs.copyFileSync(sPath, dPath);
    }
  }
}

function makeActionId(ns, seed) {
  const h = crypto.createHash('md5').update(`${ns}-vibe-${seed}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function actionEntry(ns, seed, uuid, name, iconFile, settings) {
  return {
    ActionID: makeActionId(ns, seed),
    Controller: '',
    Name: name,
    Settings: settings,
    State: 0,
    States: [
      {
        FontSize: '9',
        Image: `static/${iconFile}`,
        Title: '',
        TitleAlignment: 'center'
      }
    ],
    UUID: uuid
  };
}

// ============================================================================
// 1. Claude Code 18-Slot Profile Layout
// ============================================================================
function buildClaude18Slots() {
  const ns = 'claude';
  return {
    '0,0': actionEntry(ns, 'slot-0,0', 'com.vibecoding.claudecode.status', 'Agent Live Status', 'icon-status.png', {
      panelMode: 'overview', displayStyle: 'icon_label'
    }),
    '1,0': actionEntry(ns, 'slot-1,0', 'com.vibecoding.claudecode.approval', 'Approve / Confirm (Enter)', 'icon-approve.png', {
      responseType: 'approve', autoFocusTerminal: true, displayStyle: 'icon_label'
    }),
    '2,0': actionEntry(ns, 'slot-2,0', 'com.vibecoding.claudecode.approval', 'Allow for Session (2)', 'icon-approve.png', {
      responseType: 'approve_session', autoFocusTerminal: true, displayStyle: 'icon_label'
    }),
    '3,0': actionEntry(ns, 'slot-3,0', 'com.vibecoding.claudecode.approval', 'Reject / Stop (Esc)', 'icon-approve.png', {
      responseType: 'reject', autoFocusTerminal: true, displayStyle: 'icon_label'
    }),
    '4,0': actionEntry(ns, 'slot-4,0', 'com.vibecoding.claudecode.mode', 'Permission Mode (Shift+Tab)', 'icon-mode.png', {
      settingType: 'perm_mode', sendSlashCommand: false, displayStyle: 'icon_label'
    }),

    '0,1': actionEntry(ns, 'slot-0,1', 'com.vibecoding.claudecode.model', 'Model Cycle (5.5 / Fable)', 'icon-model.png', {
      modelMode: 'cycle', targetModel: 'sonnet', sendSlashCommand: true, displayStyle: 'icon_label'
    }),
    '1,1': actionEntry(ns, 'slot-1,1', 'com.vibecoding.claudecode.mode', 'Effort Level', 'icon-mode.png', {
      settingType: 'effort', sendSlashCommand: true, displayStyle: 'icon_label'
    }),
    '2,1': actionEntry(ns, 'slot-2,1', 'com.vibecoding.claudecode.mode', 'Extended Thinking (Alt+T)', 'icon-mode.png', {
      settingType: 'thinking', sendSlashCommand: false, displayStyle: 'icon_label'
    }),
    '3,1': actionEntry(ns, 'slot-3,1', 'com.vibecoding.claudecode.command', '/compact Context', 'icon-cmd.png', {
      preset: 'compact', label: '', commandText: '/compact', longPressCommand: '/context', autoEnter: true, displayStyle: 'icon_label'
    }),
    '4,1': actionEntry(ns, 'slot-4,1', 'com.vibecoding.claudecode.command', '/clear Reset', 'icon-cmd.png', {
      preset: 'clear', label: '', commandText: '/clear', longPressCommand: '/doctor', autoEnter: true, displayStyle: 'icon_label'
    }),

    '0,2': actionEntry(ns, 'slot-0,2', 'com.vibecoding.claudecode.utility', 'Voice Dictation', 'icon-util.png', {
      utilType: 'voice', displayStyle: 'icon_label'
    }),
    '1,2': actionEntry(ns, 'slot-1,2', 'com.vibecoding.claudecode.utility', 'Paste Screenshot', 'icon-util.png', {
      utilType: 'screenshot', displayStyle: 'icon_label'
    }),
    '2,2': actionEntry(ns, 'slot-2,2', 'com.vibecoding.claudecode.command', 'Build & Auto-Fix', 'icon-cmd.png', {
      preset: 'vibe_fix', label: '', commandText: 'Run the build and tests, and if any errors or failures occur, find the root cause and fix them.', longPressCommand: '', autoEnter: true, displayStyle: 'icon_label'
    }),
    '3,2': actionEntry(ns, 'slot-3,2', 'com.vibecoding.claudecode.command', 'Summarize & Commit', 'icon-cmd.png', {
      preset: 'vibe_commit', label: '', commandText: 'Check git status and diff, summarize the changes cleanly, and create a git commit with an appropriate message.', longPressCommand: '/diff', autoEnter: true, displayStyle: 'icon_label'
    }),
    '4,2': actionEntry(ns, 'slot-4,2', 'com.vibecoding.claudecode.command', '/cost & Resume', 'icon-cmd.png', {
      preset: 'cost', label: '', commandText: '/cost', longPressCommand: '/resume', autoEnter: true, displayStyle: 'icon_label'
    }),

    '5,0': actionEntry(ns, 'slot-5,0', 'com.vibecoding.claudecode.status', 'Status Monitor (Main)', 'icon-status.png', {
      panelMode: 'overview', displayStyle: 'icon_label'
    }),
    '5,1': actionEntry(ns, 'slot-5,1', 'com.vibecoding.claudecode.status', 'Active Tool & Prompt Monitor', 'icon-status.png', {
      panelMode: 'activity', displayStyle: 'icon_label'
    }),
    '5,2': actionEntry(ns, 'slot-5,2', 'com.vibecoding.claudecode.status', 'Model & Effort Summary', 'icon-status.png', {
      panelMode: 'metrics', displayStyle: 'icon_label'
    })
  };
}

// ============================================================================
// 2. Google Antigravity 18-Slot Profile Layout
// ============================================================================
function buildAntigravity18Slots() {
  const ns = 'antigravity';
  return {
    '0,0': actionEntry(ns, 'slot-0,0', 'com.vibecoding.antigravity.status', 'Agent Live Status', 'icon-status.png', {
      panelMode: 'overview', displayStyle: 'icon_label'
    }),
    '1,0': actionEntry(ns, 'slot-1,0', 'com.vibecoding.antigravity.approval', 'Approve / Proceed (Enter)', 'icon-approve.png', {
      responseType: 'approve', autoFocusTerminal: true, displayStyle: 'icon_label'
    }),
    '2,0': actionEntry(ns, 'slot-2,0', 'com.vibecoding.antigravity.approval', 'Auto-Proceed Remaining Steps', 'icon-approve.png', {
      responseType: 'auto_proceed', autoFocusTerminal: true, displayStyle: 'icon_label'
    }),
    '3,0': actionEntry(ns, 'slot-3,0', 'com.vibecoding.antigravity.approval', 'Stop Immediately (Esc)', 'icon-approve.png', {
      responseType: 'reject', autoFocusTerminal: true, displayStyle: 'icon_label'
    }),
    '4,0': actionEntry(ns, 'slot-4,0', 'com.vibecoding.antigravity.mode', 'Execution Policy', 'icon-mode.png', {
      settingType: 'exec_policy', displayStyle: 'icon_label'
    }),

    '0,1': actionEntry(ns, 'slot-0,1', 'com.vibecoding.antigravity.model', 'Model Cycle (Gemini 4 / 5.5)', 'icon-model.png', {
      modelMode: 'cycle', targetModel: 'argon', sendSlashCommand: true, displayStyle: 'icon_label'
    }),
    '1,1': actionEntry(ns, 'slot-1,1', 'com.vibecoding.antigravity.mode', 'Thinking Level', 'icon-mode.png', {
      settingType: 'thinking', displayStyle: 'icon_label'
    }),
    '2,1': actionEntry(ns, 'slot-2,1', 'com.vibecoding.antigravity.command', '/plan (Long: /grill-me)', 'icon-cmd.png', {
      preset: 'plan', label: '', commandText: '/plan ', longPressCommand: '/grill-me ', autoEnter: false, displayStyle: 'icon_label'
    }),
    '3,1': actionEntry(ns, 'slot-3,1', 'com.vibecoding.antigravity.command', '/boost (Long: /goal)', 'icon-cmd.png', {
      preset: 'boost', label: '', commandText: '/boost ', longPressCommand: '/goal ', autoEnter: false, displayStyle: 'icon_label'
    }),
    '4,1': actionEntry(ns, 'slot-4,1', 'com.vibecoding.antigravity.command', '/compact (Long: /learn)', 'icon-cmd.png', {
      preset: 'compact', label: '', commandText: '/compact', longPressCommand: '/learn ', autoEnter: true, displayStyle: 'icon_label'
    }),

    '0,2': actionEntry(ns, 'slot-0,2', 'com.vibecoding.antigravity.utility', 'Voice Dictation', 'icon-util.png', {
      utilType: 'voice', displayStyle: 'icon_label'
    }),
    '1,2': actionEntry(ns, 'slot-1,2', 'com.vibecoding.antigravity.utility', 'Paste Screenshot (Ctrl+V)', 'icon-util.png', {
      utilType: 'screenshot', displayStyle: 'icon_label'
    }),
    '2,2': actionEntry(ns, 'slot-2,2', 'com.vibecoding.antigravity.command', '/teamwork (Long: /browser)', 'icon-cmd.png', {
      preset: 'teamwork', label: '', commandText: '/teamwork ', longPressCommand: '/browser ', autoEnter: false, displayStyle: 'icon_label'
    }),
    '3,2': actionEntry(ns, 'slot-3,2', 'com.vibecoding.antigravity.command', 'Full Build & Fix', 'icon-cmd.png', {
      preset: 'vibe_fix', label: '', commandText: 'Run the full build and test suite to verify, and if any failures occur, find the root cause and fix them.', longPressCommand: '', autoEnter: true, displayStyle: 'icon_label'
    }),
    '4,2': actionEntry(ns, 'slot-4,2', 'com.vibecoding.antigravity.command', 'Summarize & Commit', 'icon-cmd.png', {
      preset: 'vibe_commit', label: '', commandText: 'Check git status and diff, summarize the changes cleanly, and create a git commit with an appropriate message.', longPressCommand: '/schedule ', autoEnter: true, displayStyle: 'icon_label'
    }),

    '5,0': actionEntry(ns, 'slot-5,0', 'com.vibecoding.antigravity.status', 'Status Monitor (Main)', 'icon-status.png', {
      panelMode: 'overview', displayStyle: 'icon_label'
    }),
    '5,1': actionEntry(ns, 'slot-5,1', 'com.vibecoding.antigravity.status', 'Active Tool & Prompt Monitor', 'icon-status.png', {
      panelMode: 'activity', displayStyle: 'icon_label'
    }),
    '5,2': actionEntry(ns, 'slot-5,2', 'com.vibecoding.antigravity.status', 'Model & Thinking Summary', 'icon-status.png', {
      panelMode: 'metrics', displayStyle: 'icon_label'
    })
  };
}

// ============================================================================
// 3. OpenAI Codex 18-Slot Profile Layout
// ============================================================================
function buildCodex18Slots() {
  const ns = 'codex';
  return {
    '0,0': actionEntry(ns, 'slot-0,0', 'com.vibecoding.codex.status', 'Agent Live Status', 'icon-status.png', {
      panelMode: 'overview', displayStyle: 'icon_label'
    }),
    '1,0': actionEntry(ns, 'slot-1,0', 'com.vibecoding.codex.approval', 'Approve / Confirm (Enter / y)', 'icon-approve.png', {
      responseType: 'approve', autoFocusTerminal: true, displayStyle: 'icon_label'
    }),
    '2,0': actionEntry(ns, 'slot-2,0', 'com.vibecoding.codex.approval', 'Always Allow Session (a)', 'icon-approve.png', {
      responseType: 'approve_session', autoFocusTerminal: true, displayStyle: 'icon_label'
    }),
    '3,0': actionEntry(ns, 'slot-3,0', 'com.vibecoding.codex.approval', 'Stop Immediately (Esc)', 'icon-approve.png', {
      responseType: 'reject', autoFocusTerminal: true, displayStyle: 'icon_label'
    }),
    '4,0': actionEntry(ns, 'slot-4,0', 'com.vibecoding.codex.mode', 'Approval Policy', 'icon-mode.png', {
      settingType: 'perm_mode', displayStyle: 'icon_label'
    }),

    '0,1': actionEntry(ns, 'slot-0,1', 'com.vibecoding.codex.model', 'Model Cycle (GPT-6.1 Sol / Astra)', 'icon-model.png', {
      modelMode: 'cycle', targetModel: 'sol', sendSlashCommand: true, displayStyle: 'icon_label'
    }),
    '1,1': actionEntry(ns, 'slot-1,1', 'com.vibecoding.codex.mode', 'Reasoning Effort (Low~XHigh)', 'icon-mode.png', {
      settingType: 'effort', displayStyle: 'icon_label'
    }),
    '2,1': actionEntry(ns, 'slot-2,1', 'com.vibecoding.codex.mode', 'Sandbox Mode (RW/RO/Full)', 'icon-mode.png', {
      settingType: 'sandbox', displayStyle: 'icon_label'
    }),
    '3,1': actionEntry(ns, 'slot-3,1', 'com.vibecoding.codex.command', '/compact (Long: /status)', 'icon-cmd.png', {
      preset: 'compact', label: '', commandText: '/compact', longPressCommand: '/status', autoEnter: true, displayStyle: 'icon_label'
    }),
    '4,1': actionEntry(ns, 'slot-4,1', 'com.vibecoding.codex.command', '/new Session (Long: /init)', 'icon-cmd.png', {
      preset: 'clear', label: '', commandText: '/new', longPressCommand: '/init', autoEnter: true, displayStyle: 'icon_label'
    }),

    '0,2': actionEntry(ns, 'slot-0,2', 'com.vibecoding.codex.utility', 'Voice Dictation', 'icon-util.png', {
      utilType: 'voice', displayStyle: 'icon_label'
    }),
    '1,2': actionEntry(ns, 'slot-1,2', 'com.vibecoding.codex.utility', 'Paste Screenshot (Ctrl+V)', 'icon-util.png', {
      utilType: 'screenshot', displayStyle: 'icon_label'
    }),
    '2,2': actionEntry(ns, 'slot-2,2', 'com.vibecoding.codex.command', '/review (Long: /diff)', 'icon-cmd.png', {
      preset: 'review', label: '', commandText: '/review', longPressCommand: '/diff', autoEnter: true, displayStyle: 'icon_label'
    }),
    '3,2': actionEntry(ns, 'slot-3,2', 'com.vibecoding.codex.command', 'Build & Fix (Long: /ide)', 'icon-cmd.png', {
      preset: 'ide_fix', label: '', commandText: 'Run the build and tests, and if any failures or errors occur, find the root cause and fix them.', longPressCommand: '/ide', autoEnter: true, displayStyle: 'icon_label'
    }),
    '4,2': actionEntry(ns, 'slot-4,2', 'com.vibecoding.codex.command', 'Summarize & Commit', 'icon-cmd.png', {
      preset: 'vibe_commit', label: '', commandText: 'Check git status and diff, summarize the changes cleanly, and create a git commit with an appropriate message.', longPressCommand: '/hooks', autoEnter: true, displayStyle: 'icon_label'
    }),

    '5,0': actionEntry(ns, 'slot-5,0', 'com.vibecoding.codex.status', 'Status Monitor (Main)', 'icon-status.png', {
      panelMode: 'overview', displayStyle: 'icon_label'
    }),
    '5,1': actionEntry(ns, 'slot-5,1', 'com.vibecoding.codex.status', 'Active Tool & Prompt Monitor', 'icon-status.png', {
      panelMode: 'activity', displayStyle: 'icon_label'
    }),
    '5,2': actionEntry(ns, 'slot-5,2', 'com.vibecoding.codex.status', 'Model & Sandbox Summary', 'icon-status.png', {
      panelMode: 'metrics', displayStyle: 'icon_label'
    })
  };
}

function writeManifestWithBackups(dirPath, manifestObj) {
  fs.mkdirSync(dirPath, { recursive: true });
  const jsonText = JSON.stringify(manifestObj, null, 4);
  fs.writeFileSync(path.join(dirPath, 'manifest.json'), jsonText, 'utf8');
  fs.writeFileSync(path.join(dirPath, 'manifest.json.A.bak'), jsonText, 'utf8');
  fs.writeFileSync(path.join(dirPath, 'manifest.json.B.bak'), jsonText, 'utf8');
}

const detectedSerial = detectDeviceSerial();

function deployTopLevelProfile(profileId, displayName, actionsObj) {
  const dstProfile = path.join(PROFILES_DIR, profileId);
  fs.mkdirSync(path.join(dstProfile, 'Images'), { recursive: true });
  fs.mkdirSync(path.join(dstProfile, 'profiles'), { recursive: true });
  const topManifest = {
    Actions: actionsObj,
    AppIdentifier: '',
    DeviceModel: '20GBA9901',
    DeviceSerialNumber: detectedSerial,
    DeviceUUID: 'AKP153E',
    Name: displayName,
    Pages: {
      Current: profileId,
      Pages: [profileId]
    },
    Version: '1.0'
  };
  writeManifestWithBackups(dstProfile, topManifest);
  console.log('Created 18-slot profile:', dstProfile, `(${displayName})`);
}

// 1. Deploy all 3 plugins
for (const pluginFolder of PLUGINS) {
  const src = path.join(WORKSPACE_PLUGINS, pluginFolder);
  const dst = path.join(PLUGINS_DIR, pluginFolder);
  if (fs.existsSync(dst)) {
    fs.rmSync(dst, { recursive: true, force: true });
  }
  copyDirRecursive(src, dst);
  console.log('Deployed plugin:', dst);
}

// 2. Build & deploy all 3 dedicated 1-page top-level profiles
const claudeActions = buildClaude18Slots();
const agyActions = buildAntigravity18Slots();
const codexActions = buildCodex18Slots();

deployTopLevelProfile(PROFILE_IDS.claude, 'Claude Code Vibe Coding', claudeActions);
deployTopLevelProfile(PROFILE_IDS.antigravity, 'Antigravity Vibe Coding', agyActions);
deployTopLevelProfile(PROFILE_IDS.codex, 'OpenAI Codex Vibe Coding', codexActions);

// 3. Switch active profile in StreamDockConfig.ini for any connected AKP153E section
const requestedActive = process.argv[2] || 'antigravity';
const activeId = PROFILE_IDS[requestedActive] || PROFILE_IDS.antigravity;
const activePath = path.join(PROFILES_DIR, activeId);

if (fs.existsSync(CONFIG_INI)) {
  let ini = fs.readFileSync(CONFIG_INI, 'utf8');
  const escapedPath = activePath.replace(/\\/g, '\\\\');
  ini = ini.replace(/(\[AKP153E[A-Za-z0-9]*DeviceConfig\][\s\S]*?sdProfileName=)([^\r\n]+)/g, `$1${activeId}`);
  ini = ini.replace(/(\[AKP153E[A-Za-z0-9]*DeviceConfig\][\s\S]*?sdProfilePath=)([^\r\n]+)/g, `$1${escapedPath}`);
  fs.writeFileSync(CONFIG_INI, ini, 'utf8');
  console.log('Updated StreamDockConfig.ini active profile to:', activeId);
}
