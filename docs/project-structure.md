# OpenRoom 프로젝트 구조 분석

## 1. 프로젝트 한눈에 보기

OpenRoom은 `pnpm workspace` + `Turborepo` 기반의 모노레포이며, 크게 두 축으로 구성된다.

1. 브라우저에서 실행되는 데스크톱 UI 애플리케이션
2. AI가 앱을 생성/변경할 때 사용하는 `.claude` 워크플로우 자산

핵심 실행 앱은 `apps/webuiapps`이고, `packages/vibe-container`는 통신 SDK 인터페이스를 제공하는 패키지다. 오픈소스 단독 실행 모드에서는 실제 런타임이 `apps/webuiapps/src/lib/vibeContainerMock.ts`로 대체된다.

## 2. 최상위 디렉터리 구조

```text
OpenRoom/
├── apps/
│   └── webuiapps/              # 메인 브라우저 데스크톱 애플리케이션
├── packages/
│   └── vibe-container/         # 앱-셸 통신 SDK 인터페이스/타입
├── e2e/                        # Playwright E2E 테스트
├── .claude/                    # AI 기반 앱 생성/수정 워크플로우
├── .github/                    # GitHub 설정 및 CI
├── package.json                # 루트 스크립트와 공통 의존성
├── pnpm-workspace.yaml         # workspace 범위 정의
└── turbo.json                  # Turborepo task 파이프라인
```

## 3. 루트 레벨 역할

### 3.1 `package.json`

- 모노레포 공통 스크립트 제공
- `pnpm dev`: `turbo run dev`
- `pnpm build`: `turbo run build`
- `pnpm clean`: `turbo run clean`
- `pnpm test:e2e`: Playwright 실행

즉, 실제 개발 서버 실행은 각 패키지의 `dev` 스크립트를 Turborepo가 묶어서 수행하는 구조다.

### 3.2 `pnpm-workspace.yaml`

- 워크스페이스 범위는 `apps/*`, `packages/*`
- 새 앱/패키지를 추가할 때 이 규칙에 맞는 위치에 두면 자동으로 워크스페이스에 포함된다

### 3.3 `turbo.json`

- `build`는 상위 패키지 의존 빌드를 선행
- `dev`는 캐시 없이 지속 실행
- `clean`도 캐시 없이 실행

구조상 “앱 하나 + 보조 패키지들”보다 “여러 실행 단위를 한 저장소에서 함께 관리”하는 모노레포 운영을 염두에 둔 설정이다.

## 4. 핵심 앱: `apps/webuiapps`

이 디렉터리가 사용자가 직접 접하는 데스크톱 환경이다.

```text
apps/webuiapps/
├── src/
│   ├── components/             # 셸, 앱 윈도우, 채팅 패널 등 공통 UI
│   ├── lib/                    # 런타임 핵심 로직
│   ├── pages/                  # 개별 앱 구현
│   ├── routers/                # 라우팅 정의
│   ├── i18/                    # 국제화 설정
│   ├── hooks/                  # 커스텀 훅
│   └── types/                  # 전역/도메인 타입
├── public/                     # 정적 에셋
├── nginx/                      # 배포용 nginx 설정
├── script/                     # 빌드 스크립트
├── vite.config.ts              # 빌드/개발 서버/Vite 플러그인 설정
└── package.json
```

### 4.1 진입점

- `src/index.tsx`
  - i18n 초기화
  - React Router 생성
  - 루트 라우터를 `RouterProvider`로 마운트

- `src/routers/index.tsx`
  - 각 앱 페이지를 lazy loading으로 연결
  - 현재는 `standaloneMode = true`
  - 따라서 실제 루트는 각 앱 라우트가 아니라 `Shell` 하나로 고정된다

즉, 라우터는 존재하지만 현재 오픈소스 실행 모드에서는 “브라우저 라우팅 앱”이 아니라 “데스크톱 셸 안에서 창을 띄우는 앱”으로 동작한다.

## 5. 런타임 중심 구조

### 5.1 `components/Shell`

`src/components/Shell/index.tsx`는 전체 데스크톱의 중심이다.

주요 책임:

- 바탕화면 아이콘 렌더링
- 하단 바 제어
- 채팅 패널 표시/숨김
- 앱 창 목록 렌더링
- 메타 파일 시드(`seedMetaFiles`)
- OS 이벤트 수신(예: 배경화면 변경)
- 카드 업로드 및 mod 생성 흐름 시작

이 컴포넌트를 기준으로 보면 OpenRoom은 “웹 페이지 위에 데스크톱 셸을 구현한 앱”이라는 성격이 뚜렷하다.

### 5.2 `components/AppWindow`

`src/components/AppWindow/index.tsx`는 실제 앱 창 컨테이너다.

주요 특징:

- `import.meta.glob('../../pages/*/index.tsx')`로 페이지 자동 탐색
- `appRegistry`의 `sourceDir -> appId` 매핑으로 앱 연결
- 드래그 이동, 리사이즈, 최소화/닫기 제공
- 창 단위 lazy loading 적용

즉, 새 앱을 추가할 때 `pages/<AppName>/index.tsx` 패턴을 지키면 창 시스템에 자연스럽게 편입된다.

### 5.3 `lib/windowManager.ts`

단순하지만 핵심적인 전역 창 상태 저장소다.

역할:

- 창 열기/닫기
- 포커스와 z-index 관리
- 최소화
- 위치/크기 변경
- 구독 기반 외부 상태 노출

상태 관리 라이브러리 대신 모듈 스코프 변수 + `subscribe()` 패턴을 사용해 데스크톱 UI를 제어한다.

## 6. AI 상호작용 구조

### 6.1 `components/ChatPanel`

`src/components/ChatPanel/index.tsx`는 AI 에이전트 인터페이스의 핵심이다.

주요 역할:

- LLM 설정 로드/저장
- 채팅 이력 관리
- 캐릭터/모드 상태 관리
- 시스템 프롬프트 생성
- 툴 호출 실행
- 앱 액션 디스패치
- 메모리/이미지 생성 툴 통합

ChatPanel의 시스템 프롬프트는 앱 조작 절차를 강하게 규정한다.

1. `list_apps`
2. `meta.yaml` 읽기
3. `guide.md` 읽기
4. 앱 데이터 탐색
5. 파일 쓰기/삭제
6. `app_action` 호출

즉, 이 프로젝트는 “LLM이 UI를 직접 클릭”하는 방식이 아니라 “파일 시스템 + 액션 프로토콜”을 통해 앱을 조작한다.

### 6.2 `lib/appRegistry.ts`

앱 정적 정보와 액션 정의를 관리한다.

정적 정보:

- `appId`
- `appName`
- `route`
- `displayName`
- 아이콘/색상
- 기본 창 크기

동적 정보:

- 각 앱의 `meta.yaml`에서 읽어온 액션 목록

특징:

- OS 레벨 액션은 코드에 하드코딩
- 각 앱 액션은 런타임에 `meta.yaml`을 파싱해 로드
- 데스크톱 아이콘 목록과 창 기본 크기도 여기서 제공

이 파일은 “앱 메타데이터의 단일 진입점”이라고 보면 된다.

### 6.3 `lib/action.ts`

프론트엔드와 에이전트 사이에서 주고받는 액션 데이터 구조를 정의한다.

포함 내용:

- `CharacterAppAction`
- `CharacterOsEvent`
- 액션 보고 함수 `reportAction`
- 생명주기 보고 함수 `reportLifecycle`
- 앱이 에이전트 액션을 수신하는 `useAgentActionListener`

즉, 개별 앱은 이 모듈을 통해 “사용자/에이전트/시스템이 발생시킨 액션”을 공통 형식으로 주고받는다.

### 6.4 `lib/vibeContainerMock.ts`

오픈소스 단독 실행 모드의 핵심 어댑터다.

역할:

- `@gui/vibe-container`의 실제 구현 대체
- 앱 액션 이벤트 버스 제공
- OS 액션 직접 처리
- 앱 창 자동 열기
- 앱 응답 대기 및 결과 반환
- 사용자 액션 보고
- 로컬 파일 저장소와 연동

중요 포인트:

- 프로덕션용 iframe 기반 통신을 로컬 이벤트 버스로 흉내 낸다
- `OPEN_APP`, `CLOSE_APP`, `SET_WALLPAPER`는 여기서 직접 처리한다
- 에이전트 액션이 오면 창이 열려 있지 않아도 자동으로 창을 연 뒤 액션을 보낸다

이 파일 덕분에 오픈소스 버전은 별도 호스트 셸 없이도 동작한다.

## 7. 데이터 저장 구조

### 7.1 `lib/diskStorage.ts`

이름은 storage지만 실제로는 브라우저 fetch를 통해 Vite dev server의 API를 호출한다.

핵심 경로:

- `/api/session-data`

저장 위치 개념:

- 세션 경로 기준
- 세션 내부 `apps/...` 경로에 앱 데이터 저장

코드 주석 기준 실제 의도:

- `~/.openroom/sessions/{charId}/{modId}/...`

즉, 앱 데이터는 브라우저 메모리에만 있지 않고, 로컬 사용자 홈 디렉터리 아래 세션 파일로 유지된다.

### 7.2 `vite.config.ts`

이 프로젝트에서 Vite 설정은 단순 번들러 설정이 아니라 로컬 백엔드 역할도 수행한다.

주요 커스텀 플러그인:

- `llmConfigPlugin`
  - `~/.openroom/config.json` 읽기/쓰기
- `sessionDataPlugin`
  - `~/.openroom/sessions` 아래 파일 CRUD
- `jsonFilePlugin`
  - 캐릭터/모드 JSON 저장
- `llmProxyPlugin`
  - 브라우저 CORS 우회를 위한 LLM 프록시
- `logServerPlugin`
  - 브라우저 로그 수집
- `appGeneratorPlugin`
  - 앱 생성 관련 플러그인

추가로 중요한 alias:

- `@` -> `src`
- `@gui/vibe-container` -> `src/lib/vibeContainerMock.ts`

즉, 개발 서버가 곧 로컬 persistence 및 프록시 레이어를 겸한다.

## 8. 앱 구현 패턴: `src/pages`

각 앱은 `src/pages/<AppName>` 아래에 존재한다. 현재 포함된 앱은 다음과 같다.

- `Twitter`
- `MusicApp`
- `Diary`
- `Album`
- `FreeCell`
- `Email`
- `Gomoku`
- `Chess`
- `EvidenceVault`
- `CyberNews`
- `Home`

대표적인 앱 디렉터리 내부 패턴:

```text
pages/<AppName>/
├── index.tsx                   # 앱 엔트리 컴포넌트
├── index.module.scss           # 앱 전용 스타일
├── types.ts                    # 도메인 타입
├── i18n/                       # 앱 전용 다국어 리소스
├── actions/                    # 앱 액션 상수
├── data/ or mock/              # 시드/샘플 데이터
├── components/                 # 앱 내부 하위 컴포넌트
├── meta/ or <app>_en, <app>_cn # AI용 메타 문서
│   ├── meta.yaml
│   └── guide.md
└── assets/                     # 앱 내부 이미지/정적 자산
```

### 8.1 `meta.yaml` / `guide.md`의 의미

이 저장소에서 앱은 단순 UI 컴포넌트가 아니다. AI가 조작할 수 있어야 한다.

그래서 각 앱은 두 종류의 문서를 가진다.

- `meta.yaml`
  - 에이전트가 호출 가능한 액션 정의
- `guide.md`
  - 데이터 구조와 파일 스키마 설명

`seedMetaFiles()`가 이 파일들을 런타임 저장소에 복사하고, ChatPanel은 이를 읽어 앱 조작 방법을 학습한다.

즉, 앱의 “AI 연동 인터페이스”는 TypeScript 타입이 아니라 문서 기반 계약으로 제공된다.

## 9. `packages/vibe-container`

이 패키지는 원래 iframe 기반 마이크로 프론트엔드 통신 SDK를 위한 자리다.

구성:

- `src/types`
- `src/clientComManager`
- `src/parentComManager`
- `src/utils`

하지만 오픈소스 단독 모드에서는 Vite alias 때문에 실제 런타임 진입이 이 패키지가 아니라 `vibeContainerMock.ts`로 바뀐다.

따라서 현재 저장소에서의 실질적 역할은 다음 둘이다.

1. 통신 모델의 타입/인터페이스 문서화
2. 향후 iframe 기반 실제 구현으로 확장 가능한 구조 유지

## 10. `.claude` 디렉터리

이 디렉터리는 브라우저 앱 런타임이 아니라 “앱을 생성·수정하는 AI 워크플로우” 자산이다.

```text
.claude/
├── commands/
│   ├── vibe.md
│   └── import.md
├── rules/
│   ├── concurrent-execution.md
│   ├── data-interaction.md
│   ├── design-tokens.md
│   └── post-task-check.md
└── workflow/
    ├── rules/
    └── stages/
```

구성 의미:

- `commands/`
  - CLI 명령 진입점 문서
- `workflow/stages/`
  - 분석, 설계, 계획, 코드 생성, 자산 생성, 통합 등 단계별 프롬프트
- `workflow/rules/`
  - `meta.yaml`, `guide.md`, 앱 정의, 반응형 레이아웃 규칙
- `rules/`
  - 전역 작업 원칙

즉, `.claude`는 실행 코드가 아니라 “AI 개발 파이프라인의 스펙 저장소”에 가깝다.

## 11. 테스트 구조

### 11.1 `e2e/app.spec.ts`

Playwright 기반 E2E 테스트가 포함되어 있으며, 현재는 셸 중심의 기본 동작을 검증한다.

검증 항목 예시:

- 셸 렌더링
- 데스크톱 아이콘 표시
- 채팅 패널 토글
- 설정 모달 열기/닫기
- 메시지 입력
- 앱 창 열기/닫기
- 언어 토글

즉, 지금의 테스트 초점은 “플랫폼 껍데기 안정성” 쪽에 가깝다.

## 12. 실행 흐름 요약

OpenRoom의 런타임을 순서대로 요약하면 다음과 같다.

1. `src/index.tsx`가 앱을 마운트한다.
2. 라우터는 현재 `Shell`을 루트로 사용한다.
3. `Shell`이 데스크톱 아이콘, 채팅 패널, 앱 창 레이어를 구성한다.
4. `seedMetaFiles()`가 각 앱의 `meta.yaml`, `guide.md`를 세션 저장소에 기록한다.
5. 사용자가 채팅에서 요청하면 `ChatPanel`이 LLM에 프롬프트와 툴 정의를 전달한다.
6. LLM은 파일 읽기/쓰기와 `app_action`을 조합해 앱을 조작한다.
7. `dispatchAgentAction()`이 필요 시 창을 열고 액션을 앱으로 전달한다.
8. 개별 앱은 `useAgentActionListener`를 통해 액션을 처리하고 결과를 돌려준다.

핵심은 “UI 데스크톱”, “문서 기반 앱 계약”, “파일 저장소”, “액션 버스”가 한 흐름으로 묶여 있다는 점이다.

## 13. 유지보수 관점에서 중요한 포인트

### 13.1 새 앱을 추가할 때 봐야 할 위치

- UI 엔트리: `apps/webuiapps/src/pages/<AppName>/index.tsx`
- 등록 정보: `apps/webuiapps/src/lib/appRegistry.ts`
- AI 메타: `pages/<AppName>/meta.../meta.yaml`, `guide.md`
- 액션 상수: `pages/<AppName>/actions/constants.ts`
- 테스트 필요 시: `e2e/app.spec.ts`

### 13.2 구조상 결합도가 높은 파일

- `src/lib/appRegistry.ts`
- `src/components/ChatPanel/index.tsx`
- `src/lib/vibeContainerMock.ts`
- `src/lib/diskStorage.ts`
- `apps/webuiapps/vite.config.ts`

이 다섯 축은 각각 “앱 정의”, “에이전트 실행”, “통신 브리지”, “저장소 접근”, “개발 서버 백엔드”를 맡고 있어서 영향 범위가 크다.

### 13.3 문서 기반 계약이 매우 중요함

이 프로젝트는 단순 프론트엔드가 아니라 AI가 앱을 이해하고 조작해야 한다. 따라서 아래 파일들은 코드만큼 중요하다.

- `meta.yaml`
- `guide.md`
- `.claude/workflow/*`

새 기능을 추가할 때 코드만 수정하고 메타 문서를 갱신하지 않으면 AI 연동 품질이 쉽게 깨질 수 있다.

## 14. 요약

OpenRoom은 단순한 React 앱이 아니라 다음 네 층이 결합된 구조다.

1. 브라우저 데스크톱 셸
2. 개별 앱 모음
3. 파일 기반 AI 조작 인터페이스
4. 앱 생성용 AI 워크플로우 자산

실무적으로 처음 봐야 할 우선순위는 다음이 가장 좋다.

1. `apps/webuiapps/src/components/Shell`
2. `apps/webuiapps/src/components/ChatPanel`
3. `apps/webuiapps/src/lib/appRegistry.ts`
4. `apps/webuiapps/src/lib/vibeContainerMock.ts`
5. `apps/webuiapps/src/pages/*`
6. `apps/webuiapps/vite.config.ts`
7. `.claude/`

이 순서로 보면 “사용자 화면 -> AI 동작 -> 앱 계약 -> 저장소/서버 -> 생성 워크플로우”까지 전체 구조를 빠르게 연결할 수 있다.
