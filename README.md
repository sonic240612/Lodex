# Lodex

로컬 LLM과 OpenRouter를 연결하는 Windows·macOS·Linux용 데스크톱 에이전트 워크스페이스.

현재는 개발 빌드다. Windows x64에서 실행을 검증했으며, macOS/Linux는 CI와 실기기 검증을 진행한다. 설치 프로그램·서명된 배포 패키지는 아직 제공하지 않는다.

## 기능

- 외부 llama-server, 사설망·Tailscale·MagicDNS, OpenRouter 연결
- 모델 선택, Temperature·Top P·출력 한도·앱 컨텍스트 예산 설정
- 마크다운 대화, 스트리밍·중지, 대화 선택 삭제, 생성·프리필 속도 표시
- 프로젝트 폴더 연결과 파일 목록·읽기·검색 도구
- 기본 접힘 thinking/도구 카드와 전체 표시·숨김
- 기존 파일 수정과 새 파일 생성을 묶어서 검토·적용·되돌리기
- Goal/TODO 수동 편집·저장, 모델 입력 포함 선택, Eco 지시문
- SQLite 영속 저장과 중단된 실행·파일 변경 상태 확인

셸/PTY, 자동 Plan/Build·Autopilot, 모델 다운로드·로드/언로드·VRAM 관리, subagent, skills/MCP, Telegram은 아직 지원하지 않는다. 모델별 실제 도구 호출 품질과 OpenRouter 비용 한도도 후속 검증·구현 대상이다.

## 실행

Node 24.11.1, pnpm 12.3.4, Rust 1.98.0 및 [OS별 Tauri 개발 도구](https://v2.tauri.app/start/prerequisites/)를 준비한다.

```sh
git clone https://github.com/sonic240612/Lodex.git
cd Lodex
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev`는 Node 런타임과 데몬을 준비한 뒤 데스크톱 앱을 시작한다. `pnpm dev:web`은 실제 파일·키·모델 서버에 접근하지 않는 메모리 기반 UI 미리보기다.

llama-server는 직접 실행한 서버의 API 주소를 설정한다. 기본 주소는 `http://127.0.0.1:8080/v1`이며 Tailscale 예시는 `http://100.75.2.3:8080/v1`이다. `0.0.0.0`은 서버의 수신 주소이므로 앱에는 실제 접속 IP를 입력한다. 모델·생성 설정 변경은 대화 시작 이후에는 새 대화에 적용된다.

## API 키와 .env

개발할 때 저장소 루트의 `.env.example`을 `.env`로 복사하고 `OPENROUTER_API_KEY`를 입력한다. 기존 `.env`가 있으면 그 파일을 편집한다. 변경 후 앱을 다시 시작한다.

```dotenv
OPENROUTER_API_KEY=your_openrouter_api_key
```

키 우선순위는 **프로세스 환경 변수 → .env → OS 키 저장소**다. 값이 비어 있으면 다음 저장 위치를 확인한다. 기존 OS 키 저장 기능도 사용할 수 있으며, 환경 변수나 `.env`에서 키를 불러온 경우 앱은 출처만 표시하고 저장·제거 버튼을 잠근다. 키를 완전히 제거하려면 우선순위 아래의 저장 위치에도 값이 남아 있는지 확인한다.

- 개발 빌드: 해당 빌드 작업 폴더의 `.env`가 있으면 사용한다.
- 설치용 빌드 또는 작업 폴더의 `.env`가 없는 경우: 앱 로컬 데이터 폴더의 `.env`를 사용한다. Windows 기본 위치는 `%LOCALAPPDATA%/app.lodex.desktop/.env`다.
- 다른 파일을 지정하려면 실행 전에 `LODEX_ENV_FILE` 환경 변수에 절대 경로를 설정한다. 앱 설정에서 현재 파일 경로를 확인할 수 있다.

`.env`에서 지원하는 비밀 값은 현재 `OPENROUTER_API_KEY`다. 선택한 사용자 프로젝트의 `.env`를 자동으로 읽지 않으며, `NODE_OPTIONS`나 `VITE_*` 등의 항목을 실행 환경으로 전달하지 않는다. 키는 모델 프롬프트·대화 DB·상태 API에 넣지 않는다. OpenRouter 사용에는 별도의 전송 동의가 필요하며 실제 요청에 비용이 발생할 수 있다.

`.env`는 로컬 평문 파일이므로 저장소 밖의 앱 데이터 폴더에도 둘 수 있다. Git에는 빈 `.env.example`만 포함한다. `.env` 변형 파일, 비밀 키·자격증명 파일, 대화 DB, 모델 파일, 빌드 결과, 로컬 개발 문서 `docs/`는 `.gitignore`로 제외한다.

## 파일 변경 검토

프로젝트를 추가한 뒤 모델이 `propose_edit` 또는 `propose_changes`로 제안한 카드를 펼치고 파일별 diff를 확인한다. 응답이 끝나면 **검토한 변경 적용**을 누른다. `propose_changes`는 기존 폴더 안의 새 파일과 기존 파일 수정 최대 8개를 묶는다. 새 폴더 생성, 기존 파일 삭제·이동은 지원하지 않는다.

적용 전에 모든 파일의 충돌을 검사하고 파일별로 변경한다. 여러 파일이 하나의 파일 시스템 트랜잭션으로 바뀌지는 않는다. 중단되면 **파일 상태 확인**으로 파일별 결과를 확인한 뒤 **남은 변경 적용**이나 **변경 되돌리기**를 선택한다. 새 파일 되돌리기는 Lodex가 생성한 파일의 내용과 식별 정보가 일치할 때만 삭제한다.

기존 파일은 UTF-8 일반 파일 1 MiB 이하, 교체 전후 텍스트 각각 6,000자 이하를 지원한다. 새 파일 내용은 12,000자 이하이며 도구 인자 전체는 16 KiB로 제한한다. 생성은 덮어쓰기를 방지하기 위해 하드 링크를 지원하는 파일 시스템이 필요하다. 원자적 교체·권한 메타데이터의 세부 동작은 OS와 파일 시스템에 따라 추가 검증이 필요하다.

## 검사와 빌드

```sh
pnpm check
node scripts/smoke-runtime.mjs
pnpm --filter @lodex/desktop tauri build --debug --no-bundle
node scripts/smoke-runtime.mjs apps/desktop/src-tauri/target/debug
```

Windows 실행 파일은 `apps/desktop/src-tauri/target/debug/lodex.exe`다. 인접한 `runtime`과 `daemon` 리소스를 함께 유지한다. 앱 창을 닫으면 데몬도 종료한다. 모델 파일·API 키는 배포 파일에 포함하지 않는다.
