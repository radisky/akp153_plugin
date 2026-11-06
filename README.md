# AJAZZ AKP153 / AKP153E Vibe Coding Stream Dock Plugins

**AJAZZ AKP153 / AKP153E** (및 Mirabox 호환 Stream Dock)용 **AI 바이브코딩 실시간 구동 상태 모니터 & 원터치 컨트롤러 플러그인 3종 세트**입니다.  
외부 npm 패키지 의존성 없이 순수 Node.js 20 내장 모듈(`http`, `crypto`, RFC 6455 `MiniWebSocket`)만으로 동작하며, **Windows 10/11** 및 **macOS 11+ (Apple Silicon / Intel)** 크로스플랫폼을 모두 지원합니다.

---

## 포함 플러그인 3종 (동시 구동 지원 · 포트 분리)

| 에이전트 | 플러그인 번들 | 로컬 HTTP 포트 | 기본 테마 | 지원 최신 모델 |
| :--- | :--- | :---: | :--- | :--- |
| **Claude Code** | `plugins/com.vibecoding.claudecode.sdPlugin` | `127.0.0.1:17530` | 코랄 오렌지 스파크 (`#FF8B66`) | `Sonnet 5.5` · `Opus 5.5` · `Fable 5.1` · `Haiku 5.5` · `OpusPlan` |
| **Google Antigravity** | `plugins/com.vibecoding.antigravity.sdPlugin` | `127.0.0.1:17531` | 사파이어 블루 오빗 (`#60A5FA`) | `Gemini 4 Argon` · `Gemini 3.8 Flash` · `Sonnet 5.5` · `Opus 5.5` · `Auto` |
| **OpenAI Codex** | `plugins/com.vibecoding.codex.sdPlugin` | `127.0.0.1:17532` | 에메랄드 헥사곤 (`#34D399`) | `GPT-6.1 Sol` · `GPT-6 Astra` · `GPT-6.1 Terra` · `GPT-6 Luna` |

---

## 주요 기능

- **실시간 에이전트 구동 상태 대시보드 (`IDLE` / `RUNNING` / `WAITING_PERMISSION` / `WAITING_INPUT` / `COMPLETED`)**
  - **Claude Code**: `~/.claude/settings.json` Hooks 자동 구성 및 실시간 상태 수신
  - **Google Antigravity**: `~/.gemini/config/hooks.json` + `~/.gemini/antigravity*/brain/*/transcript.jsonl` 이중 실시간 감시
  - **OpenAI Codex**: `~/.codex/hooks.json` + `~/.codex/config.toml` (`notify`) + `~/.codex/sessions/**/*.jsonl` 삼중 감시 (기존 TOML 섹션 보존)
- **고시인성 순수 벡터 SVG 아이콘 타일 (`144x144`)**
  - 두꺼운 기하학 벡터 아이콘 + 외곽선 처리된 고대비 단일 라벨 기본 제공
  - Property Inspector에서 **무각인 아이콘 전용 미니멀 모드 (`icon_only`)** 즉시 전환 가능
- **1페이지 18슬롯 완결형 레이아웃 (`5x3` 물리 버튼 + 우측 `3`칸 LCD 상태 스트립)**
  - 승인(`Enter` / `y`), 세션 허용(`2` / `a` / 자동승인), 즉시 중단(`Esc` / 길게 `Ctrl+C`)
  - 최신 모델 순환/지정 변경, 추론 강도(`Effort` / `Thinking`) 토글, 실행 정책/샌드박스 순환
  - 에이전트별 핵심 슬래시 워크플로우(`/compact`, `/clear`, `/plan`, `/boost`, `/teamwork`, `/review`, `/new` 등) 및 길게 누르기(Long-press `>=550ms`) 보조 명령 지원
  - 음성 받아쓰기(`Win+H` / macOS 받아쓰기), 스마트 스크린샷 붙여넣기(`Ctrl+V` / `Alt+V` / `Cmd+V`)
- **크로스플랫폼 스마트 포커스 브리지 (Windows + macOS)**
  - **Windows**: 상주형 PowerShell Win32 `SendInput` 브리지로 활성 터미널/IDE/데스크톱 앱 자동 탐색 및 포커스
  - **macOS**: JXA(`osascript -l JavaScript`) + 클립보드 복원형 UTF-8 `pbcopy`/`pbpaste`로 한글 프롬프트 무손실 입력

---

## 설치 방법

### Windows (AJAZZ Stream Dock Global)
PowerShell에서 아래 스크립트를 실행하면 3개 플러그인 복사, 18슬롯 전용 프로필 3종 생성 및 `DataCache.db` 자동 등록, Stream Dock 재시작까지 한 번에 수행됩니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install_and_launch.ps1 -ActiveProfile antigravity
```
- `-ActiveProfile` 옵션: `claude`, `antigravity`, `codex` 중 초기 활성화할 프로필 선택 가능 (설치 후 Stream Dock 상단 프로필 목록에서 3종 모두 자유롭게 전환 가능)

### macOS (macOS 11+ Apple Silicon & Intel)
터미널에서 아래 스크립트를 실행하면 3개 `.sdPlugin` 번들과 각 에이전트용 실시간 상태 훅이 자동 설치됩니다.

```bash
chmod +x ./install_macos.sh
./install_macos.sh
```
> **macOS 권한 안내**: 키 입력 및 창 전환 제어를 위해 **시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용(Accessibility)** 에서 `Stream Dock` (및 `osascript`) 권한을 허용해 주세요.

---

## 디렉터리 구조

```text
├── plugins/
│   ├── com.vibecoding.claudecode.sdPlugin/   # Claude Code 플러그인 (포트 17530)
│   ├── com.vibecoding.antigravity.sdPlugin/  # Google Antigravity 플러그인 (포트 17531)
│   └── com.vibecoding.codex.sdPlugin/        # OpenAI Codex 플러그인 (포트 17532)
├── deploy_vibe_plugin.js                     # Windows 플러그인 & 18슬롯 프로필 3종 생성기
├── install_and_launch.ps1                    # Windows 원클릭 설치 · DB 등록 · 재시작 스크립트
├── install_macos.sh                          # macOS 원클릭 통합 설치 스크립트
├── generate_icons.ps1                        # Claude Code 정적 아이콘 생성 스크립트
└── generate_agy_codex_icons.ps1              # Antigravity & Codex 정적 아이콘 생성 스크립트
```

## 라이선스
MIT License
