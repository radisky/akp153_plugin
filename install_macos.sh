#!/usr/bin/env bash
# =============================================================================
# Vibe Coding Stream Dock Plugins Suite - macOS Installer
# Installs Claude Code, Google Antigravity, and OpenAI Codex plugins & hooks
# Supports AJAZZ Stream Dock / Mirabox StreamDock on macOS 11+ (Apple Silicon & Intel)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGINS=(
  "com.vibecoding.claudecode.sdPlugin"
  "com.vibecoding.antigravity.sdPlugin"
  "com.vibecoding.codex.sdPlugin"
)

# 1. Detect Stream Dock macOS plugin directories
INSTALLED_DIRS=()
CANDIDATE_DIRS=(
  "${HOME}/Library/Application Support/HotSpot/StreamDock/plugins"
  "${HOME}/Library/Application Support/StreamDock/plugins"
  "${HOME}/Library/Application Support/ AJAZZ/StreamDock/plugins"
)

for DIR in "${CANDIDATE_DIRS[@]}"; do
  PARENT="$(dirname "${DIR}")"
  if [[ -d "${PARENT}" ]]; then
    mkdir -p "${DIR}"
    INSTALLED_DIRS+=("${DIR}")
  fi
done

if [[ "${#INSTALLED_DIRS[@]}" -eq 0 ]]; then
  DEFAULT_DIR="${HOME}/Library/Application Support/HotSpot/StreamDock/plugins"
  mkdir -p "${DEFAULT_DIR}"
  INSTALLED_DIRS+=("${DEFAULT_DIR}")
fi

for PLUGIN_NAME in "${PLUGINS[@]}"; do
  SRC_PLUGIN="${SCRIPT_DIR}/plugins/${PLUGIN_NAME}"
  if [[ ! -d "${SRC_PLUGIN}" && -d "${SCRIPT_DIR}/${PLUGIN_NAME}" ]]; then
    SRC_PLUGIN="${SCRIPT_DIR}/${PLUGIN_NAME}"
  fi
  if [[ ! -d "${SRC_PLUGIN}" ]]; then
    echo "[WARN] Skipping missing folder: ${PLUGIN_NAME}"
    continue
  fi

  for DST_ROOT in "${INSTALLED_DIRS[@]}"; do
    rm -rf "${DST_ROOT}/${PLUGIN_NAME}"
    cp -R "${SRC_PLUGIN}" "${DST_ROOT}/${PLUGIN_NAME}"
    chmod +x "${DST_ROOT}/${PLUGIN_NAME}/plugin/"streamdock*notify.js 2>/dev/null || true
    echo "[OK] Installed ${PLUGIN_NAME} -> ${DST_ROOT}/${PLUGIN_NAME}"
  done
done

# 2. Locate Node binary (Stream Dock bundled node, Homebrew, nvm, or system)
NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  for N_CAND in \
    "/Applications/Stream Dock AJAZZ.app/Contents/MacOS/node/bin/node" \
    "/Applications/Stream Dock.app/Contents/MacOS/node/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node"; do
    if [[ -x "${N_CAND}" ]]; then
      NODE_BIN="${N_CAND}"
      break
    fi
  done
fi

# 3. Pre-install hook scripts for Claude Code (17530), Antigravity (17531), and Codex (17532)
CLAUDE_HOOK="${HOME}/.claude/hooks/streamdock_notify.js"
AGY_HOOK="${HOME}/.gemini/config/streamdock_agy_notify.js"
CODEX_HOOK="${HOME}/.codex/hooks/streamdock_codex_notify.js"

if [[ -f "${SCRIPT_DIR}/plugins/com.vibecoding.claudecode.sdPlugin/plugin/streamdock_notify.js" ]]; then
  mkdir -p "$(dirname "${CLAUDE_HOOK}")"
  cp "${SCRIPT_DIR}/plugins/com.vibecoding.claudecode.sdPlugin/plugin/streamdock_notify.js" "${CLAUDE_HOOK}"
  chmod +x "${CLAUDE_HOOK}"
fi

if [[ -f "${SCRIPT_DIR}/plugins/com.vibecoding.antigravity.sdPlugin/plugin/streamdock_agy_notify.js" ]]; then
  mkdir -p "$(dirname "${AGY_HOOK}")"
  cp "${SCRIPT_DIR}/plugins/com.vibecoding.antigravity.sdPlugin/plugin/streamdock_agy_notify.js" "${AGY_HOOK}"
  chmod +x "${AGY_HOOK}"
fi

if [[ -f "${SCRIPT_DIR}/plugins/com.vibecoding.codex.sdPlugin/plugin/streamdock_codex_notify.js" ]]; then
  mkdir -p "$(dirname "${CODEX_HOOK}")"
  cp "${SCRIPT_DIR}/plugins/com.vibecoding.codex.sdPlugin/plugin/streamdock_codex_notify.js" "${CODEX_HOOK}"
  chmod +x "${CODEX_HOOK}"
fi

if [[ -n "${NODE_BIN}" ]]; then
  "${NODE_BIN}" -e '
    const fs = require("fs");
    const path = require("path");
    const home = process.env.HOME;
    const nodeBin = process.argv[1];

    const readJson = (p) => {
      try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {}; }
      catch (_) { return {}; }
    };

    // 1) Claude Code (~/.claude/settings.json)
    const claudeSettings = path.join(home, ".claude", "settings.json");
    const claudeHook = path.join(home, ".claude", "hooks", "streamdock_notify.js");
    if (fs.existsSync(claudeHook)) {
      const cfg = readJson(claudeSettings);
      if (!cfg.hooks || typeof cfg.hooks !== "object") cfg.hooks = {};
      const cmd = `"${nodeBin}" "${claudeHook}"`;
      for (const ev of ["SessionStart","UserPromptSubmit","PreToolUse","PermissionRequest","PostToolUse","Notification","SubagentStart","SubagentStop","Stop"]) {
        const arr = Array.isArray(cfg.hooks[ev]) ? cfg.hooks[ev] : [];
        const clean = arr.filter(x => !JSON.stringify(x).includes("streamdock_notify.js"));
        clean.push({ hooks: [{ type: "command", command: cmd }] });
        cfg.hooks[ev] = clean;
      }
      if (!cfg.model) cfg.model = "claude-sonnet-5-5";
      fs.writeFileSync(claudeSettings, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      console.log("[OK] Configured Claude Code hooks in", claudeSettings);
    }

    // 2) Google Antigravity (~/.gemini/config/hooks.json)
    const agyHooksPath = path.join(home, ".gemini", "config", "hooks.json");
    const agyHook = path.join(home, ".gemini", "config", "streamdock_agy_notify.js");
    if (fs.existsSync(agyHook)) {
      const hDoc = readJson(agyHooksPath);
      const mkAgy = (ev) => `"${nodeBin}" "${agyHook}" ${ev}`;
      hDoc["streamdock-agy"] = {
        enabled: true,
        SessionStart: [{ type: "command", command: mkAgy("SessionStart"), timeout: 5 }],
        PreInvocation: [{ type: "command", command: mkAgy("PreInvocation"), timeout: 5 }],
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: mkAgy("PostToolUse"), timeout: 5 }] }],
        Stop: [{ type: "command", command: mkAgy("Stop"), timeout: 5 }]
      };
      fs.writeFileSync(agyHooksPath, JSON.stringify(hDoc, null, 2) + "\n", "utf8");
      console.log("[OK] Configured Antigravity hooks in", agyHooksPath);
    }

    // 3) OpenAI Codex (~/.codex/hooks.json)
    const codexHooksPath = path.join(home, ".codex", "hooks.json");
    const codexHook = path.join(home, ".codex", "hooks", "streamdock_codex_notify.js");
    if (fs.existsSync(codexHook)) {
      const cDoc = readJson(codexHooksPath);
      if (!cDoc.hooks || typeof cDoc.hooks !== "object") cDoc.hooks = {};
      const mkCdx = (ev) => `"${nodeBin}" "${codexHook}" ${ev}`;
      for (const ev of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
        const arr = Array.isArray(cDoc.hooks[ev]) ? cDoc.hooks[ev] : [];
        const clean = arr.filter(x => !JSON.stringify(x).includes("streamdock_codex_notify.js"));
        if (ev === "PostToolUse") clean.push({ matcher: "*", hooks: [{ type: "command", command: mkCdx(ev) }] });
        else clean.push({ hooks: [{ type: "command", command: mkCdx(ev) }] });
        cDoc.hooks[ev] = clean;
      }
      fs.writeFileSync(codexHooksPath, JSON.stringify(cDoc, null, 2) + "\n", "utf8");
      console.log("[OK] Configured OpenAI Codex hooks in", codexHooksPath);
    }
  ' "${NODE_BIN}"
else
  echo "[INFO] Node CLI not in PATH yet; each Stream Dock plugin will auto-configure its hooks on launch."
fi

echo ""
echo "====================================================================="
echo " macOS Installation Complete! (Claude Code · Antigravity · OpenAI Codex)"
echo " 1. Restart the Stream Dock app."
echo " 2. Grant Accessibility permission to Stream Dock (and osascript) under"
echo "    [System Settings > Privacy & Security > Accessibility]."
echo "====================================================================="
