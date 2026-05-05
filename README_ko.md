# YourOpenRoom

[English](./README.md) | [中文](./README_zh.md) | 한국어

> OpenRoom에서 출발했지만, 지금은 AI가 앱과 실제 로컬 워크스페이스를 다루는 로컬 우선 브라우저
> 데스크톱으로 발전한 포크입니다.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

**[저장소](https://github.com/kernullist/YourOpenRoom)** ·
**[이슈](https://github.com/kernullist/YourOpenRoom/issues)** ·
**[원본 업스트림](https://github.com/MiniMax-AI/OpenRoom)**

## 이 저장소의 현재 방향

YourOpenRoom은 MiniMax OpenRoom 포크로 시작했지만, 현재 코드는 단순 데모 데스크톱과는 성격이 많이
다릅니다.

지금의 중심은 세 가지입니다.

- **브라우저 데스크톱 셸**: 드래그/최대화 가능한 창, 사용자가 재배치할 수 있는 데스크톱 아이콘,
  플로팅 채팅 패널, 로컬 상태
- **Agent 런타임**: `meta.yaml` 액션, 앱 상태 조회, 앱 저장소 파일 조작, 채팅 툴 호출
- **로컬 프로젝트 자동화**: **Kira** 와 **Aoi's IDE** 를 통한 실제 워크스페이스 검색, 편집, 진단,
  시맨틱 리네임, 체크포인트, 안전한 명령 실행

실제로 실행되는 핵심 앱은 `apps/webuiapps` 입니다.

## 현재 코드에 이미 들어있는 것

- 독립 실행형 브라우저 데스크톱: 창 시스템, 채팅 패널, 재실행 후에도 유지되는 드래그 앤 드랍 아이콘
  순서, 채팅창 영역을 피하는 최대화/복원, 라이브 월페이퍼 토글, Kira 자동화 알림
- 채팅 패널 기능:
  - OpenAI-compatible / Anthropic-compatible LLM 설정
  - 가벼운 대화용 dialog model 오버라이드
  - 사용자 호칭/이름 기억
  - 응답 언어 모드 (`match-user` / `english`)
  - Aoi 답변을 음성으로 읽어주는 선택형 TTS와 짧은 대사 프리로드
  - 장기 메모리 저장
  - 이미지 생성
  - Tavily 실시간 웹 검색
  - prompt budget / tool inspector
- 세션 단위 앱 데이터 저장: `~/.openroom/sessions/...`
- 원래 iframe 런타임 대신 로컬 `@gui/vibe-container` mock 사용
- Vite middleware 기반 로컬 API:
  - Gmail OAuth / 동기화
  - Browser Reader 프록시
  - YouTube 검색 파싱
  - CyberNews RSS 집계
  - 로컬 앨범 폴더 접근
  - Tavily 프록시
  - OpenVSCode 워크스페이스 API
  - PE Analyst IDA / PE 분석 브리지
  - TTS lab 합성 API
  - Kira 자동화 API
  - 설정 및 세션 데이터 저장
- 업스트림의 캐릭터 / mod 계층도 여전히 남아 있습니다. 캐릭터, mod, 감정 미디어, 업로드 기반 mod
  생성, 메모리 주입이 현재 셸 안에 포함되어 있습니다.

## 기본 앱

| 앱               | 현재 실제 기능                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Twitter`        | 로컬 소셜 피드, 게시글/좋아요/댓글 저장                                                                                         |
| `YouTube`        | YouTube 검색, 최근 검색, 즐겨찾는 주제, 플레이리스트, 큐 재생, 팝업 플레이어                                                    |
| `Diary`          | Markdown 일기, 기분/날씨 메타데이터, 캘린더 탐색, 손글씨 스타일 렌더링                                                          |
| `Album`          | 폴더 선택, 저장된 로컬 경로, 검색, 정렬, 그리드 밀도, 미리보기 메타데이터를 지원하는 로컬 사진 갤러리                           |
| `FreeCell`       | 영속화되는 FreeCell 게임                                                                                                        |
| `Email`          | Gmail OAuth 데스크톱 플로우, inbox/sent/drafts/trash, 답장, 초안 저장, 보관, 별표, 복원, 삭제                                   |
| `Chess`          | 완전한 체스 규칙, 3D 보드, 로컬 저장, Agent 턴 동기화                                                                           |
| `Evidence Vault` | 구조화된 증거/조사 파일을 보는 로컬 자료 보관 앱                                                                                |
| `CyberNews`      | RSS 기반 실시간 보안 뉴스와 case-board 조사 화면                                                                                |
| `Calendar`       | 월간 탐색, 선택일 agenda, 날짜 선택과 `Date & Time` 동기화, 리마인더 메타데이터를 지원하는 로컬 일정 플래너                     |
| `Notes`          | 고정 컬렉션, 태그/검색 필터, 정렬, 서식 도구, 안전한 삭제 확인, 저장되는 보기 상태, 미리보기가 있는 로컬 Markdown 노트           |
| `Browser Reader` | 내장 브라우징, reader 추출, 북마크/히스토리, Google 결과 대체 UI, Notes 저장                                                    |
| `Kira`           | 작업 보드, work item/comment, discovery 분석, 워커 배정 전 clarification 질문, 자동화 handoff                                   |
| `Aoi's IDE`      | 새 파일 생성이 가능한 로컬 워크스페이스 파일 트리/에디터와 검색, 심볼, 참조, rename preview/apply, 안전 명령                    |
| `PE Analyst`     | `ida_pro_mcp` 기반 현재 IDB 분석, 업로드 기반 PE pre-scan, findings/imports/sections/strings/functions 탭을 제공하는 PE 분석 앱 |

## PE Analyst 와 IDA MCP

`PE Analyst` 는 지금 두 가지 흐름을 지원합니다.

- **Current IDB 모드**
  - `ida_pro_mcp` 와 가장 잘 맞습니다
  - 현재 IDA Pro 에 열려 있는 IDB 를 기준으로 바로 분석합니다
  - 파일 업로드 없이 함수 목록, pseudocode, disassembly, xref 를 볼 수 있습니다
- **샘플 업로드 모드**
  - 내장 PE pre-scan 과 headless 백엔드 흐름에 사용됩니다
  - 업로드한 PE 파일은 로컬 캐시에 저장되고, 분석 메타데이터는 세션 앱 저장소에 남습니다

현재 백엔드는 두 종류의 MCP 스타일을 자동 감지합니다.

- `ida_pro_mcp`
  - 보통 IDA 플러그인이 `http://127.0.0.1:13337/mcp` 로 제공합니다
- `ida-headless-mcp`
  - 보통 별도 HTTP MCP 서버 `http://127.0.0.1:17300/` 형태로 실행합니다

## Aoi TTS 와 Voice Lab

현재 데스크톱에는 **Aoi용 선택형 TTS 레이어**가 들어 있습니다.

- 채팅 설정에서 켜면 새로 추가되는 assistant 메시지를 음성으로 읽어줍니다
- 현재 기본 음성은 **Google `Despina`** 입니다
- TTS helper 는 다음을 미리 생성할 수 있습니다
  - 자주 쓰는 짧은 고정 대사
  - 현재 세션에서 최근 실제로 나온 assistant 대사
- 브라우저에서 음성 비교를 하려면:
  - `http://localhost:3000/tts-lab.html`
- 로컬 샘플 생성 스크립트:
  - `node apps/webuiapps/script/generate-aoi-voice-samples.mjs`

## 채팅 패널 안의 Agent 툴링

현재 채팅 패널은 `app_action` 하나로 끝나지 않습니다.

- **앱 런타임 툴**
  - `list_apps`, `app_action`, `get_app_state`, `get_app_schema`
  - `file_read`, `file_write`, `file_patch`, `file_list`, `file_delete`
- **웹/콘텐츠 툴**
  - `search_web`
  - `read_url`
  - `generate_image`
- **워크스페이스 / IDE 툴**
  - `workspace_search`
  - `ide_search`
  - `find_references`
  - `list_exports`
  - `peek_definition`
  - `rename_preview`
  - `apply_semantic_rename`
  - `run_command`
  - `structured_diagnostics`
- **안전 / 복구 툴**
  - `preview_changes`
  - `undo_last_action`
  - `workspace_checkpoint`
  - `autofix_diagnostics`
  - `background_watch`

안전 장치도 현재 코드에 반영되어 있습니다.

- 앱 JSON 쓰기는 가능한 경우 schema 검증을 거칩니다
- 시맨틱 리네임은 preview 서명 없이 apply 할 수 없습니다
- 워크스페이스 명령은 읽기 전용 `git` / `node` / `npm` / `pnpm` 안전 패턴만 허용됩니다
- Kira 는 계획된 검증 명령을 직접 다시 돌리고, 실패하면 block 또는 retry 할 수 있습니다

## Kira 와 Aoi's IDE

이 포크에서 가장 달라진 부분은 내장 앱 데모보다 실제 로컬 프로젝트 작업에 훨씬 무게를 둔다는
점입니다.

### Kira

Kira 는 앱 저장소에 work item 과 comment 를 저장하고, 설정된 로컬 프로젝트를 discovery 대상으로 삼을
수 있습니다. `apps/webuiapps/vite.config.ts` 안의 자동화 플러그인은 다음까지 수행합니다.

1. 처리할 작업 스캔
2. brief 가 워커에게 바로 배정될 만큼 충분히 구체적인지 분석
3. 모호한 경우 clarification 질문을 만들고 handoff 차단
4. 대상 파일 / 검증 명령 계획
5. worker / reviewer 루프 실행
6. 검증 재실행
7. 프로젝트 설정에 따라 block, retry, auto-commit

Clarification 은 worker 에게 일감이 넘어가기 전에 실행됩니다. 제목/설명에 제품 결정이나 구현 방향을
바꿀 수 있는 모호함이 있으면 Kira 는 가능한 한 객관식 질문으로 사용자에게 확인하고, 답변은 work item
상태와 Markdown brief 에 함께 저장한 뒤 작업을 다시 `todo` 로 돌려 자동화를 재개합니다.

Kira 는 기본적으로 1개의 worker 를 사용하지만, 설정으로 최대 3개의 worker 를 사용할 수 있습니다.
여러 worker 를 쓰면 각 worker 는 자기 전용 git worktree 에서 독립적인 attempt 를 만들고, reviewer 가
검증을 통과한 attempt 들을 비교해 하나의 winner 를 고릅니다. 모두 review 를 통과하지 못하면 같은
피드백으로 worker 들이 다시 시도합니다.
같은 provider/baseUrl/model route 로 동시에 모델을 호출할 때는 로컬 모델 route(`llama.cpp`,
localhost, private-network base URL)는 1개씩만 실행하고, 그 외 route 는 최대 2개까지만 동시에
실행합니다.
각 모델 호출의 response output token cap 은 8192 token 으로 설정됩니다.
Kira 는 고정 tool-call 횟수 cap 을 두지 않으며, 중단 기준은 cancellation, request timeout,
execution policy check 입니다.

git 프로젝트에서 `autoCommit` 이 켜져 있으면 승인된 작업은 winning 격리 worktree 에서 먼저 커밋한
뒤, 짧은 프로젝트 단위 cherry-pick 락을 잡고 기본 프로젝트 worktree 로 통합합니다. 여러 worker 를
쓰는 경우 `autoCommit` 이 꺼져 있어도 Kira 는 attempt 별 worktree 를 사용하고, 선택된 diff 를
`cherry-pick --no-commit` 으로 통합합니다. 기본 worktree 에 겹치는 dirty file, staged change,
cherry-pick 충돌이 있으면 로컬 작업을 덮어쓰지 않고 task 를 blocked 로 전환하며, 수동 복구를 위해
winning worktree 를 남깁니다.

### Aoi's IDE

Aoi's IDE 의 프런트엔드는 파일 트리와 에디터지만, 핵심은 `/api/openvscode/*` API 세트입니다.

- 워크스페이스 목록과 파일 읽기/쓰기/삭제
- 상대 워크스페이스 경로 기반의 빈 파일 생성과 중복 생성 방지
- 텍스트 검색
- 심볼 검색
- 참조 조회
- export 목록
- definition peek
- semantic rename preview / apply
- 안전한 명령 실행

TypeScript / JavaScript 프로젝트에서는 가능한 경우 로컬 TypeScript language service 를 활용합니다.

## 프롬프트 기반 앱 생성 워크플로

기존 OpenRoom 계열의 프롬프트 기반 앱 생성 흐름도 여전히 들어 있습니다.

- 진입점: `.claude/commands/vibe.md`
- 단계 정의: `.claude/workflow/`
- `apps/webuiapps/vite.config.ts` 의 `appGeneratorPlugin` 이 생성 결과를 런타임에 연결

다만 지금 이 포크의 주력은 이것 하나가 아니라, AI 데스크톱과 로컬 워크스페이스 자동화입니다.

## 빠른 시작

### 필요 조건

| 도구    | 버전 |
| ------- | ---- |
| Node.js | 18+  |
| pnpm    | 9+   |

### 로컬 실행

```bash
git clone https://github.com/kernullist/YourOpenRoom.git
cd YourOpenRoom
pnpm install
cp apps/webuiapps/.env.example apps/webuiapps/.env
pnpm dev
```

`http://localhost:3000` 을 열면 됩니다.

### 중요한 런타임 메모

`pnpm dev` 가 실제로는 전체 로컬 스택입니다.

현재 많은 기능이 Vite middleware 에 의존합니다.

- Gmail OAuth / Sync
- Browser Reader 프록시
- CyberNews RSS 집계
- YouTube 검색 파싱
- 로컬 앨범 폴더 접근
- Tavily 프록시
- Kira 자동화 API
- OpenVSCode 워크스페이스 API
- TTS lab 합성 API
- 설정 / 세션 데이터 저장

그래서 `pnpm build` 로 프런트 번들은 만들 수 있어도, 완전한 기능을 유지하려면 같은 백엔드
엔드포인트를 따로 제공해야 합니다.

## 설정

런타임 설정은 `~/.openroom/config.json` 에서 읽습니다.

동일한 샘플은 [`docs/config.example.json`](./docs/config.example.json) 에도 있습니다.

```json
{
  "llm": {
    "provider": "openrouter",
    "apiKey": "YOUR_API_KEY",
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "anthropic/claude-sonnet-4.6"
  },
  "dialogLlm": {
    "provider": "openrouter",
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "openai/gpt-5-mini"
  },
  "userProfile": {
    "displayName": "Minji"
  },
  "conversationPreferences": {
    "responseLanguageMode": "match-user",
    "ttsEnabled": true,
    "ttsPreloadCommonPhrases": true
  },
  "imageGen": {
    "provider": "openai",
    "apiKey": "YOUR_IMAGE_API_KEY",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-image-1"
  },
  "album": {
    "photoDirectory": "C:\\Users\\your-name\\Pictures"
  },
  "kira": {
    "workRootDirectory": "C:\\Users\\your-name\\workspace",
    "projectDefaults": {
      "autoCommit": true
    },
    "workers": [
      {
        "name": "Fast API worker",
        "model": "openai/gpt-5.4-mini"
      },
      {
        "name": "Codex local worker",
        "provider": "codex-cli",
        "model": "gpt-5.3-codex"
      },
      {
        "name": "OpenCode Go worker",
        "provider": "opencode-go",
        "apiKey": "YOUR_OPENCODE_API_KEY",
        "model": "opencode-go/kimi-k2.5"
      }
    ],
    "reviewerLlm": {
      "provider": "opencode",
      "apiKey": "YOUR_OPENCODE_API_KEY",
      "model": "opencode/claude-sonnet-4-6"
    }
  },
  "openvscode": {
    "workspacePath": "C:\\Users\\your-name\\workspace\\your-project"
  },
  "tavily": {
    "apiKey": "tvly-YOUR_API_KEY"
  },
  "gmail": {
    "clientId": "YOUR_GOOGLE_OAUTH_DESKTOP_CLIENT_ID",
    "clientSecret": "OPTIONAL_GOOGLE_CLIENT_SECRET"
  },
  "idaPe": {
    "mode": "prescan-only",
    "backendUrl": "http://127.0.0.1:17300/"
  },
  "app": {
    "title": "YourOpenRoom"
  }
}
```

메모:

- `openvscode.workspacePath` 는 Aoi's IDE 와 IDE 툴 API 가 바라보는 실제 로컬 프로젝트입니다
- `openvscode.workspacePath` 가 없으면 현재 코드는 저장소 루트를 기본값으로 사용합니다
- `gmail.clientId` 는 Google OAuth **Desktop App** client ID 여야 합니다
- `dialogLlm` 을 쓰려면 최소 `baseUrl` 과 `model` 이 필요합니다
- `kira.workRootDirectory` 는 프로젝트 폴더 자체를 가리켜도 되고, 여러 프로젝트 폴더를 담은 상위
  폴더를 가리켜도 됩니다. 루트에 `.git`, `package.json`, `requirements.txt` 같은 프로젝트 마커가
  있으면 Kira 는 그 루트 자체를 하나의 프로젝트로 취급합니다
- `kira.workers` 는 선택 설정입니다. 없으면 기존 `workerLlm` 을 1개 worker 로 사용하고, 있으면 앞의
  3개 항목까지만 사용합니다. 각 worker 는 서로 다른 provider/model 을 사용할 수 있습니다
- `provider: "codex-cli"` 는 로컬 Codex CLI 를 ChatGPT 로그인 세션으로 실행합니다. Kira 에서 쓰기
  전에 터미널에서 `codex login` 을 한 번 완료해야 합니다
- `provider: "opencode"` 와 `"opencode-go"` 는 OpenCode Zen/Go API 키를 사용합니다. 기본 base URL 은
  각각 `https://opencode.ai/zen`, `https://opencode.ai/zen/go` 이며, 필요할 때만 `apiStyle` 로
  `openai-chat`, `openai-responses`, `anthropic-messages` 중 하나를 강제하면 됩니다
- `userProfile.displayName` 을 설정하면 채팅 패널이 다음 실행에서도 같은 이름으로 사용자를 부릅니다
- `conversationPreferences.responseLanguageMode` 는 `match-user` 와 `english` 를 지원합니다
- `conversationPreferences.ttsEnabled` 로 Aoi 답변 음성 재생을 켜고 끌 수 있습니다
- `conversationPreferences.ttsPreloadCommonPhrases` 는 짧은 고정 대사와 최근 assistant 답변을 미리
  생성해서 재생 지연을 줄입니다
- `conversationPreferences.responseLanguageMode` 가 `english` 이면 일반 답변, 리마인더, 새로 심는 첫
  프로로그/추천 답변까지 영어로 맞춥니다
- `imageGen` 은 채팅 패널 이미지 생성 툴의 선택 설정입니다
- `idaPe.mode` 는 `prescan-only` 와 `mcp-http` 를 지원합니다
- `idaPe.backendUrl` 은 `ida_pro_mcp` current-IDB 모드라면 `http://127.0.0.1:13337/mcp`,
  `ida-headless-mcp` 라면 `http://127.0.0.1:17300/` 같은 주소를 사용하면 됩니다

### Optional `.env`

`apps/webuiapps/.env.example` 에는 CDN / Sentry 같은 선택 설정 외에도 TTS 실험용 키가 들어갑니다.

- `GEMINI_API_KEY`
- `ELEVENLABS_API_KEY`

## 로컬 데이터 구조

독립 실행 모드에서는 데이터가 `~/.openroom/` 아래에 저장됩니다.

```text
~/.openroom/
├── config.json
├── characters.json
├── mods.json
└── sessions/
    └── <session-path>/
        ├── apps/
        │   ├── notes/data/
        │   ├── email/data/
        │   ├── kira/data/
        │   ├── peanalyzer/data/
        │   └── ...
        ├── chat/
        └── memory/
```

## 저장소 구조

```text
YourOpenRoom/
├── apps/
│   └── webuiapps/          # 메인 브라우저 데스크톱 런타임
├── packages/
│   └── vibe-container/     # 공유 타입 + 독립 모드 stub
├── .claude/                # 프롬프트 기반 앱 생성 워크플로
├── docs/                   # 설정 샘플과 보조 문서
└── e2e/                    # Playwright 시나리오
```

`apps/webuiapps/src/` 안에서는:

- `components/`: 데스크톱 셸, 채팅 패널, 윈도우 컴포넌트
- `pages/`: 내장 앱
- `lib/`: 런타임 glue code, LLM 클라이언트, 툴, 앱 등록, IDE/Kira/Gmail 로직
- `routers/`: standalone 모드 라우팅

## 개발 명령

| 명령                                              | 용도                                |
| ------------------------------------------------- | ----------------------------------- |
| `pnpm dev`                                        | 데스크톱과 로컬 middleware API 실행 |
| `pnpm build`                                      | 프런트 번들 빌드                    |
| `pnpm clean`                                      | Turborepo 산출물 정리               |
| `pnpm run lint`                                   | 린트 + 자동 수정                    |
| `pnpm run pretty`                                 | 포맷팅                              |
| `pnpm --filter @openroom/webuiapps test`          | 데스크톱 앱 Vitest 단위 테스트      |
| `pnpm --filter @openroom/webuiapps test:coverage` | 커버리지 포함 Vitest                |
| `pnpm test:e2e`                                   | Playwright E2E                      |

## 기술 스택

| 영역      | 현재 구현                                                                             |
| --------- | ------------------------------------------------------------------------------------- |
| UI        | React 18, TypeScript, React Router, Vite                                              |
| 스타일    | SCSS, CSS Modules                                                                     |
| 모션      | Framer Motion                                                                         |
| 앱 런타임 | 로컬 `@gui/vibe-container` mock, session-data middleware, `meta.yaml` 기반 app action |
| 로컬 툴링 | 파일 시스템 API, TypeScript language service, 안전 명령 실행, 구조화 진단             |
| 외부 연동 | Gmail OAuth, Tavily, 이미지 생성, RSS 집계, YouTube 검색 파싱                         |
| 모노레포  | pnpm workspaces, Turborepo                                                            |
| 테스트    | Vitest, Playwright                                                                    |

## 기여

이슈, 문서 수정, 툴 개선, 앱 변경, 워크플로 업그레이드 모두 환영합니다.
[CONTRIBUTING.md](./CONTRIBUTING.md)를 먼저 참고하세요.

## License

[MIT](./LICENSE)
