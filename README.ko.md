# Lodex

[English](README.md) · [한국어](README.ko.md)

로컬 LLM과 OpenRouter를 위한 데스크톱 에이전트 하네스.

> 개발 초기 단계. Windows x64 로컬 실행 확인. Windows·macOS·Linux 빌드는 CI에서 검사.

## 기능

- localhost·사설망·Tailscale을 통한 외부 llama-server 연결
- 재시작 후에도 유지되는 공개 Hugging Face GGUF 다운로드·해시/메타데이터 검증과 VRAM에 맞춘 컨텍스트·GPU·KV cache·스레드·예약량 권장값
- 모델 기본 설정·자동 컨텍스트/출력 한도·비용 표시·일시적 오류 재시도를 지원하는 OpenRouter 연결
- Plan·Build·서브에이전트별 모델 지정, 최대 3개 독립 읽기 작업 동시 실행
- 로컬 프로젝트 폴더 연결, 프로젝트별 대화, Git worktree 생성
- 프로젝트 파일 읽기·검색, 검토된 경로 생성·이동·삭제, 단일/다중 파일 변경과 Docker 검증 묶음 적용, 텍스트 수정 되돌리기
- 제한을 설정한 Docker 명령 실행, 전체 접근의 호스트 파일·셸·환경 변수·네트워크·MCP 사용
- 대화별 **승인 요청**·**대신 승인**·**전체 접근** 권한. Plan 모드는 항상 읽기 전용
- `/goal` 목표 실행과 선행 작업·완료 기준·검증 명령·예산을 사용하는 저장 계획 실행
- Agent Skills·Codex·Claude Code·pi·OpenCode·OpenClaw·Hermes 형식의 로컬 `SKILL.md` 가져오기
- stdio·Streamable HTTP MCP, 도구 선택, 리소스·프롬프트 미리보기와 첨부, Sampling·Elicitation, OAuth PKCE 로그인
- 원격 메시지·상태·계획 조회·중지·허용된 Build 작업을 위한 Telegram 봇
- 창을 닫아도 데몬·Telegram·진행 중인 에이전트를 유지하는 시스템 트레이 백그라운드 실행
- Eco 모드, 자동 빠른 압축, 대형 도구 결과의 로컬 ObservationPack 보관과 선택적 재호출
- LLM 기반 **컨텍스트 압축**과 모델 호출 없는 **빠른 압축**. 전체 대화는 SQLite에 유지
- Markdown/GFM, 접을 수 있는 thinking·도구 활동, 활성 컨텍스트·속도 표시, 최신 메시지 이동 버튼
- 비밀 정보를 제외한 일별·수동 JSON 백업, 개수/기간 보존 정책, 네이티브 저장 창 내보내기

## 시작하기

필요한 환경: Node 24.11.1 · npm 11.19.1 · Rust 1.98.0 · [Tauri 개발 도구](https://v2.tauri.app/start/prerequisites/)

```sh
git clone https://github.com/sonic240612/Lodex.git
cd Lodex
npm ci
npm run dev
```

Windows에서는 `run-lodex.bat`를 더블클릭하면 빠진 npm 패키지를 설치하고 개발용 앱을 실행합니다.

## 모델

### 관리형 로컬 모델

모델 관리에서 공개 Hugging Face GGUF를 받거나 디스크의 파일을 선택하세요. 모델 아키텍처·레이어와 attention 크기·원래 컨텍스트·tokenizer·내장 chat template을 읽고, 설정한 VRAM 예산에 맞는 실행 설정을 등록 전에 채울 수 있습니다. 다운로드 이력은 앱을 다시 시작해도 유지됩니다. VRAM 값은 스케줄러 예약량이며 실제 GPU 메모리의 강제 제한이 아닙니다.

### 외부 llama-server

OpenAI 호환 llama-server를 실행하고 API 주소를 입력하세요. 기본값은 `http://127.0.0.1:8080/v1`입니다. localhost·사설 IPv4·허용된 Tailscale 주소를 지원합니다.

### OpenRouter

[`.env.example`](.env.example)을 `.env`로 복사하고 키를 입력한 뒤 Lodex를 다시 시작하세요.

```dotenv
OPENROUTER_API_KEY=your-key
```

앱에서 운영체제 키 저장소에 저장할 수도 있습니다. `.env`, `.env.mcp`, 데이터베이스, 로컬 런타임 파일과 인증 정보는 Git에서 제외됩니다. OpenRouter 전송에는 해당 대화의 동의가 필요합니다.

## 에이전트 제어

| 설정      | 동작                                                                                 |
| --------- | ------------------------------------------------------------------------------------ |
| Plan      | 읽기 전용 확인과 계획 작성                                                           |
| Build     | 선택한 권한 단계 안에서 프로젝트 도구와 작업 실행                                    |
| 승인 요청 | 읽기는 바로 실행하고 파일 변경·명령·외부 작업은 승인 대기                            |
| 대신 승인 | 일반 프로젝트 수정과 제한된 안전 작업을 고정 정책으로 자동 승인                      |
| 전체 접근 | 경고 확인 후 호스트 경로·셸·네트워크·비밀 파일·선택한 MCP 작업을 추가 질문 없이 실행 |

전체 접근은 대화별로 저장됩니다. 파일 해시·경로·심볼릭 링크 검사, 실행 취소, 자식 프로세스 정리와 감사 기록은 계속 적용됩니다.

`/goal <목표>`는 독립 목표 실행을 시작하고 모델이 완료를 기록하거나 차단 사유·예산에 도달할 때까지 계속합니다. 저장 계획 실행은 작업 의존성과 검증 근거를 사용합니다. 수동 체크박스와 검증 기록은 별도입니다.

## 컨텍스트

- **컨텍스트 압축**은 현재 모델을 호출해 목표·제약·진행 상황·결정·파일·검증·실패·다음 작업을 담은 인수인계 요약을 생성합니다.
- **빠른 압축**은 추가 모델 호출 없이 기존 규칙 기반 추출기를 사용합니다.
- 일반적으로 최근 완료 메시지 4개는 원문으로 유지합니다. 원본 메시지는 삭제하지 않습니다.
- Eco 모드는 더 일찍 압축하고 짧은 답변을 요청합니다.
- Eco 모드의 ObservationPack은 큰 도구 결과를 두 번 원문 전송한 뒤 로컬에 보관하고 필요한 범위만 다시 읽습니다.
- 최신 llama.cpp에서는 실제 chat template과 tokenizer를 적용한 입력 토큰을 표시합니다. 구형 서버나 다른 제공자는 보수적 추정 또는 제공자 사용량을 표시합니다.

## 프로젝트와 실행

로컬 폴더를 연결하면 프로젝트 대화를 만들 수 있습니다. 전체 접근이 아니면 파일 도구는 선택 프로젝트 내부에서만 작동합니다. 프로젝트 루트에 없는 `.env` 파일은 기존 비밀 파일 내용을 노출하지 않고 새로 만들 수 있습니다.

경로 이동과 삭제에는 직전에 확인한 콘텐츠 지문이 필요합니다. **대신 승인**은 일반 폴더 생성과 이동을 자동 승인하지만 삭제는 계속 승인을 기다립니다. 대상 경로를 덮어쓰지 않으며 삭제는 자동으로 되돌릴 수 없습니다.

Worktree는 현재 커밋에서 별도 브랜치와 프로젝트를 만듭니다. 미커밋 변경은 원본 폴더에 남으며 병합과 정리는 수동입니다.

Docker 실행은 선택 사항이며 이미지·CPU·메모리·네트워크·프로젝트 접근 설정을 사용합니다. 변경 제안에 검증 명령 하나를 포함하면 승인·파일 적용·검증을 한 작업으로 기록합니다. 대화형 PTY는 준비 중입니다.

## 스킬과 MCP

스킬은 메타데이터를 먼저 읽고 모델이 요청할 때만 지침이나 참조 문서를 불러옵니다. 스킬 가져오기는 훅·스크립트·의존성 설치를 실행하지 않습니다.

MCP 설정은 일반적인 `mcpServers` JSON을 받습니다. 선택한 도구, 정적·매개변수형 텍스트 리소스, 프롬프트, 인자 자동 완성, 카탈로그 변경 검사, 비밀 참조, 사전 등록 공개 클라이언트의 OAuth를 지원합니다. 에이전트 실행 중 서버가 root를 요청하면 선택한 프로젝트 폴더만 제공합니다. 텍스트 전용 MCP Sampling은 선택 모델과 공통 모델·토큰·비용 예산을 사용하고 Lodex 대화·프로젝트 문맥을 전달하지 않습니다. 전체 접근이 아니면 실행 전에 승인을 요청합니다. MCP Elicitation은 실행 중 폼이나 HTTPS 링크를 채팅창 위에 표시하며 제출값은 활동 기록에 저장하지 않습니다. 비밀번호·토큰·인증 정보를 요구하는 폼은 차단합니다. MCP 비밀은 `.env`의 `LODEX_MCP_` 이름으로 저장하세요. OAuth 토큰은 Git에서 제외된 `.env.mcp`에 저장됩니다.

## Telegram

[BotFather](https://core.telegram.org/bots/tutorial#obtain-your-bot-token)에서 봇을 만든 뒤 Telegram 설정에 토큰을 입력하거나 `.env`에 `TELEGRAM_BOT_TOKEN`을 설정하세요. 대화를 선택하고 전송을 허용한 뒤 연결 ID를 승인합니다.

명령: `/ask`, `/goal`, `/resume`, `/run`, `/status`, `/plan`, `/todo`, `/autopilot ask|auto|full`, `/approve`, `/deny`, `/answer`, `/decline`, `/cancel-input`, `/stop`. `/todo`로 저장 목표와 완료 기준을 설정하고, 할 일을 추가하거나 번호로 완료·되돌리기·삭제할 수 있습니다. 원격 Build 작업과 권한 변경은 Telegram 설정에서 Build 접근을 허용해야 합니다. 결과를 확인하지 못한 전달은 기록만 남기고 자동 재시도하지 않습니다.

데스크톱 창을 닫아도 Lodex는 시스템 트레이에서 계속 실행됩니다. 데몬과 Telegram 연결을 종료하려면 트레이 메뉴의 **완전히 종료**를 사용하세요.

## 데이터

데이터 설정에서 대화·프로젝트·계획·모델 프로필·Skills·MCP 등록을 백업하거나 다른 위치로 내보낼 수 있습니다. API 키, OAuth 토큰, Telegram 봇 토큰과 모델 파일은 제외됩니다.

## 패키지

| 패키지                                  | 역할                                           |
| --------------------------------------- | ---------------------------------------------- |
| [desktop](apps/desktop)                 | Tauri 셸과 React 화면                          |
| [daemon](apps/daemon)                   | 로컬 API, 에이전트 루프, 권한과 연동 기능      |
| [providers](packages/providers)         | llama-server·OpenRouter 어댑터                 |
| [local-runtime](packages/local-runtime) | 모델 프로필·프로세스·VRAM 배치                 |
| [tools](packages/tools)                 | 프로젝트 파일·변경·되돌리기·Docker/호스트 실행 |
| [context](packages/context)             | 요청 구성·압축·컨텍스트 예산                   |
| [storage](packages/storage)             | SQLite 저장·이벤트·명령 기록·복구              |
| [contracts](packages/contracts)         | 공통 프로토콜 타입과 검증                      |
| [skills](packages/skills)               | 스킬 메타데이터·지연 읽기·출처 기록            |
| [mcp](packages/mcp)                     | MCP 전송·도구·콘텐츠·비밀·OAuth                |

## 개발

```sh
npm run check          # 타입 검사, 테스트, 프로덕션 웹 빌드
npm run dev:web        # 임시 데모 데이터로 브라우저 미리보기
npm run build:desktop  # 네이티브 데스크톱 빌드
```
