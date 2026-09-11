# Lodex

[English](README.md) · [한국어](README.ko.md)

로컬 LLM과 OpenRouter를 위한 데스크톱 에이전트 하네스.

- localhost·사설망·Tailscale을 통한 llama-server 연결
- 프로젝트 파일 읽기, 변경 검토·적용·되돌리기
- 채팅 옆에서 Goal·TODO 편집, 접을 수 있는 thinking·도구 기록
- 생성 설정 조절, 토큰 사용량·생성 속도·프리필 속도 표시

개발 초기 단계 · Windows x64 실행 확인 · macOS/Linux 지원 준비 중

## 시작하기

필요한 환경: Node 24.11.1 · pnpm 12.3.4 · Rust 1.98.0 · [Tauri 개발 도구](https://v2.tauri.app/start/prerequisites/)

```sh
git clone https://github.com/sonic240612/Lodex.git
cd Lodex
pnpm install --frozen-lockfile
pnpm dev
```

## 모델 연결

- **llama-server:** 서버를 실행한 뒤 앱 설정에 API 주소를 입력하세요. 기본값은 `http://127.0.0.1:8080/v1`입니다.
- **OpenRouter:** [`.env.example`](.env.example)을 `.env`로 복사하고 `OPENROUTER_API_KEY`를 입력한 뒤 앱을 다시 실행하세요. 앱에서 OS 키 저장소에 키를 저장하는 방법도 지원합니다.

`.env`는 Git 업로드에서 제외됩니다. 로컬 모델 서버는 별도로 실행해 주세요.

## 패키지

| 패키지                          | 역할                           |
| ------------------------------- | ------------------------------ |
| [desktop](apps/desktop)         | Tauri 앱과 React 화면          |
| [daemon](apps/daemon)           | 로컬 API와 에이전트 실행 루프  |
| [providers](packages/providers) | llama-server·OpenRouter 연결   |
| [tools](packages/tools)         | 프로젝트 파일 도구와 변경 검토 |
| [context](packages/context)     | 요청 구성과 컨텍스트 예산      |
| [storage](packages/storage)     | SQLite 저장과 복구             |
| [contracts](packages/contracts) | 공통 타입과 입력 검증          |

## 개발

```sh
pnpm check    # 타입 검사, 테스트, 빌드
pnpm dev:web  # 데모 데이터로 브라우저 UI 미리보기
```
