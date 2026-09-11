# Lodex

로컬 LLM과 OpenRouter를 위한 데스크톱 AI 작업 공간.

개발 중 · Windows x64 실행 확인 · macOS/Linux 준비 중

- llama-server·OpenRouter 연결, Tailscale 지원
- 프로젝트 파일 탐색, 변경 검토·적용·되돌리기
- 마크다운 채팅, 접을 수 있는 thinking·도구 기록
- Goal·TODO 편집, 생성 설정과 속도 표시

## 시작하기

필요한 환경: Node 24.11.1 · pnpm 12.3.4 · Rust 1.98.0 · [Tauri 개발 도구](https://v2.tauri.app/start/prerequisites/)

```sh
git clone https://github.com/sonic240612/Lodex.git
cd Lodex
pnpm install --frozen-lockfile
pnpm dev
```

## 모델 연결

**llama-server** — 서버를 실행한 뒤 앱 설정에 API 주소를 입력하세요. 기본값은 `http://127.0.0.1:8080/v1`입니다.

**OpenRouter** — `.env.example`을 `.env`로 복사하고 키를 입력한 뒤 앱을 다시 실행하세요.

```dotenv
OPENROUTER_API_KEY=
```

`.env`는 Git 업로드에서 제외됩니다.
