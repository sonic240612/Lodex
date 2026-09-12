# Lodex

[English](README.md) · [한국어](README.ko.md)

로컬 LLM과 OpenRouter를 위한 데스크톱 에이전트 하네스.

- localhost·사설망·Tailscale을 통한 llama-server 연결
- GGUF 모델 로드·언로드, 엔진 상세 설정과 VRAM 예약
- 프로젝트 파일 읽기, 변경 검토·적용·되돌리기
- Plan/Build 전환, AI 계획 검토, 작업별 완료 기준·선행 작업 편집
- 선택형 Docker 명령 실행, 접을 수 있는 출력과 실행 중지
- 선행 작업·검증 명령·예산을 따르는 로컬 Autopilot
- 생성 설정 조절, 토큰 사용량·생성 속도·프리필 속도 표시

개발 초기 단계 · Windows x64 실행 확인 · macOS/Linux CI 빌드 확인

## 시작하기

필요한 환경: Node 24.11.1 · npm 11.19.1 · Rust 1.98.0 · [Tauri 개발 도구](https://v2.tauri.app/start/prerequisites/)

```sh
git clone https://github.com/sonic240612/Lodex.git
cd Lodex
npm ci
npm run dev
```

## 모델 연결

- **로컬 모델:** 모델 관리에서 llama-server 실행 파일과 GGUF 파일을 선택하고, 저장한 모델로 대화를 시작하세요. 컨텍스트·GPU 레이어·KV cache·스레드·템플릿·추가 엔진 인자를 설정할 수 있습니다.
- **외부 llama-server:** 서버를 실행한 뒤 앱 설정에 API 주소를 입력하세요. 기본값은 `http://127.0.0.1:8080/v1`입니다.
- **OpenRouter:** [`.env.example`](.env.example)을 `.env`로 복사하고 `OPENROUTER_API_KEY`를 입력한 뒤 앱을 다시 실행하세요. 앱에서 OS 키 저장소에 키를 저장하는 방법도 지원합니다.

`.env`는 Git 업로드에서 제외됩니다. 관리 엔진은 전용 loopback 연결을 사용합니다. VRAM 배치는 입력한 예약량을 기준으로 하며, 실제 GPU 메모리 사용량을 강제로 제한하지 않습니다.

## 명령 실행

프로젝트 대화의 계획 패널에서 **명령 실행**을 펼치세요. `/bin/sh`가 있는 로컬 Linux Docker 이미지를 선택하고 엔진·이미지 확인 후 프로젝트 접근을 허용하면 Build 모드에서 명령을 사용할 수 있습니다. 네트워크는 기본으로 꺼져 있고 이미지는 자동 다운로드하지 않습니다. 컨테이너 연동은 실험 단계이며, 호스트 셸·대화형 PTY는 준비 중입니다.

**Autopilot**은 작업별 완료 기준·검증 명령을 저장하고 모델 요청에 계획 포함을 켠 뒤, 실행 범위와 예산을 정해 시작하세요. 검사 통과와 수동 체크박스는 별도로 기록됩니다. 수정안은 검토를 기다리고, 중단된 실행은 자동 재시작하지 않습니다. 현재는 로컬 모델만 지원합니다.

## 패키지

| 패키지                                  | 역할                              |
| --------------------------------------- | --------------------------------- |
| [desktop](apps/desktop)                 | Tauri 앱과 React 화면             |
| [daemon](apps/daemon)                   | 로컬 API와 에이전트 실행 루프     |
| [providers](packages/providers)         | llama-server·OpenRouter 연결      |
| [local-runtime](packages/local-runtime) | 모델 설정·엔진 프로세스·VRAM 예약 |
| [tools](packages/tools)                 | 프로젝트 파일 도구와 변경 검토    |
| [context](packages/context)             | 요청 구성과 컨텍스트 예산         |
| [storage](packages/storage)             | SQLite 저장과 복구                |
| [contracts](packages/contracts)         | 공통 타입과 입력 검증             |

## 개발

```sh
npm run check    # 타입 검사, 테스트, 빌드
npm run dev:web  # 데모 데이터로 브라우저 UI 미리보기
```
