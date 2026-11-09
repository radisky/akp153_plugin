# AJAZZ AKP153 / AKP153E Vibe Coding Stream Dock Plugins

A suite of 3 **live AI Vibe Coding status monitors & one-touch hardware controller plugins** for **AJAZZ AKP153 / AKP153E** (and Mirabox-compatible Stream Dock devices).  
Built with zero external npm dependencies using pure Node.js 20 built-ins (`http`, `crypto`, and a custom RFC 6455 `MiniWebSocket`), with full cross-platform support for **Windows 10/11** and **macOS 11+ (Apple Silicon & Intel)**.

---

## Included Plugins (Concurrent Execution · Isolated Loopback Ports)

| Agent | Plugin Bundle | Local HTTP Port | Theme | Supported Models |
| :--- | :--- | :---: | :--- | :--- |
| **Claude Code** | `plugins/com.vibecoding.claudecode.sdPlugin` | `127.0.0.1:17530` | Coral Orange Spark (`#FF8B66`) | `Sonnet 5.5` · `Opus 5.5` · `Fable 5.1` · `Haiku 5.5` · `OpusPlan` |
| **Google Antigravity** | `plugins/com.vibecoding.antigravity.sdPlugin` | `127.0.0.1:17531` | Sapphire Blue Orbit (`#60A5FA`) | `Gemini 4 Argon` · `Gemini 3.8 Flash` · `Sonnet 5.5` · `Opus 5.5` · `Auto` |
| **OpenAI Codex** | `plugins/com.vibecoding.codex.sdPlugin` | `127.0.0.1:17532` | Emerald Hexagon (`#34D399`) | `GPT-6.1 Sol` · `GPT-6 Astra` · `GPT-6.1 Terra` · `GPT-6 Luna` |

---

## Key Features

- **Live Agent Status Dashboard (`IDLE` / `RUNNING` / `WAITING_PERMISSION` / `WAITING_INPUT` / `COMPLETED`)**
  - **Claude Code**: Auto-installs and syncs `~/.claude/settings.json` hooks for real-time state updates.
  - **Google Antigravity**: Dual live monitoring via `~/.gemini/config/hooks.json` and `~/.gemini/antigravity*/brain/*/transcript.jsonl`.
  - **OpenAI Codex**: Triple live monitoring via `~/.codex/hooks.json`, `~/.codex/config.toml` (`notify`), and `~/.codex/sessions/**/*.jsonl` while preserving existing TOML sections.
- **High-Legibility Pure Vector SVG Tiles (`144x144`)**
  - Crisp geometric vector icons paired with a high-contrast outlined bottom label.
  - Instant toggle to **Minimal Icon Only (`icon_only`)** mode in the Property Inspector.
- **Complete 1-Page 18-Slot Layout (`5x3` Physical Keys + `3`-Tile Side LCD Strip)**
  - Instant Approve (`Enter` / `y`), Allow Session (`2` / `a` / Auto-Proceed), and Emergency Stop (`Esc` / long-press `Ctrl+C`).
  - Cycle or lock the latest AI models, toggle reasoning effort (`Effort` / `Thinking`), and switch execution/sandbox policies.
  - Dedicated slash workflows (`/compact`, `/clear`, `/plan`, `/boost`, `/teamwork`, `/review`, `/new`, etc.) with secondary long-press (`>=550ms`) actions.
  - Voice dictation (`Win+H` / macOS Dictation) and smart screenshot paste (`Ctrl+V` / `Alt+V` / `Cmd+V`).
- **Orca & Multi-IDE / Terminal Active Session Smart Bridge (Windows + macOS)**
  - **Native Orca (`stablyai/orca`) Integration**: Tracks the hook process tree (`PPID`), worktree path (`cwd`), and `ORCA_*` environment variables. Uses `orca terminal focus` and `orca terminal send` when the `orca` CLI is installed to inject commands directly into the active split pane, falling back automatically to OS window focus + clipboard paste.
  - **Multi-IDE & Terminal Priority**: Routes shortcuts, approvals, and slash commands (`/model`, `/effort`, `/compact`, etc.) directly into the currently active IDE (**Orca**, **Cursor**, **VS Code**, **Antigravity**, **Codex**, **Windsurf**, **Zed**, **cmux**, **JetBrains**, etc.) or terminal session without stealing focus to an unrelated background terminal.
  - **IME-Safe Input**: Uses clipboard paste for single-character approval keys (`y`, `a`, `n`) and slash commands so non-English IME states never garble input.
- **Strict Localhost (`127.0.0.1`) Loopback Binding & Security**
  - All HTTP status/hook servers (`17530`, `17531`, `17532`) and WebSocket clients bind exclusively to `127.0.0.1` and reject non-loopback sockets, DNS rebinding (`Host` header validation), and cross-site browser requests (`Origin` / `Sec-Fetch-Site: cross-site`).

---

## Installation

### Windows (AJAZZ Stream Dock Global)
Run the PowerShell installer to deploy all 3 plugins, generate the 3 dedicated 18-slot profiles, register them in `DataCache.db`, and restart Stream Dock:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install_and_launch.ps1 -ActiveProfile antigravity
```
- `-ActiveProfile`: Choose `claude`, `antigravity`, or `codex` as the initial active profile (all 3 profiles remain available in the Stream Dock profile selector).

### macOS (macOS 11+ Apple Silicon & Intel)
Run the macOS installer in Terminal to install all 3 `.sdPlugin` bundles and configure real-time hooks for each agent:

```bash
chmod +x ./install_macos.sh
./install_macos.sh
```
> **macOS Accessibility Permission**: Grant permission to `Stream Dock` (and `osascript`) under **System Settings → Privacy & Security → Accessibility** so keystrokes and window focus switching work seamlessly.

---

## Directory Structure

```text
├── plugins/
│   ├── com.vibecoding.claudecode.sdPlugin/   # Claude Code plugin (127.0.0.1:17530)
│   ├── com.vibecoding.antigravity.sdPlugin/  # Google Antigravity plugin (127.0.0.1:17531)
│   └── com.vibecoding.codex.sdPlugin/        # OpenAI Codex plugin (127.0.0.1:17532)
├── deploy_vibe_plugin.js                     # Windows plugin & 18-slot profile generator
├── install_and_launch.ps1                    # Windows one-click installer, DB registration & launcher
├── install_macos.sh                          # macOS one-click installer
├── generate_icons.ps1                        # Claude Code static icon generator
└── generate_agy_codex_icons.ps1              # Antigravity & Codex static icon generator
```

## License
MIT License
