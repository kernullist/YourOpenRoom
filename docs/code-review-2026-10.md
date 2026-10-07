# 코드 리뷰 결과와 개선 과제 (2026-10)

작성일: 2026-10-07

이 문서는 저장소 전체(코드와 문서)를 리뷰 모드로 검토한 결과다. 확인된 버그 중 이번 작업에서 고친
것과 고치지 않은 것을 나누어 적고, 고치지 않은 항목과 구조적 개선 과제는 우선순위를 붙여 정리했다.
항목 ID(`F1-B3`, `K2-B7` 등)는 리뷰를 나눈 영역(슬라이스)과 그 안의 번호다. 영역 구분은 8절에 있다.

## 요약

리뷰에서 나온 항목은 370건이다(버그 181건, 제안·문서 지적 189건). 이번 작업에서 74건을 고쳤고 14건은 일부만
고쳤다. 나머지 282건(버그 107건)은 5절과 부록 A에 권장 조치와 함께 정리했다. 이 집계는 부록 A를 만든 시점
기준이며, 그 뒤 G1-B2(예산 상한), H1-B3(자기 호출 주소), K1-B3(OpenVSCode Ctrl+S)를 더 고쳤다(5절).

## 1. 동작이 바뀐 부분 (먼저 읽을 것)

이번 수정 중 사용 방식에 영향을 주는 변경이다.

1. **개발 서버가 기본으로 `127.0.0.1`에만 바인딩된다.** 같은 LAN의 다른 기기에서 접속해야 하면
   `OPENROOM_DEV_HOST=0.0.0.0`(또는 원하는 주소)을 지정한다. 이전에는 모든 인터페이스에 열려 있었고,
   `/api/*` 라우트에는 인증이 없었다.
2. **`/api/*` 요청은 Host·Origin·`Sec-Fetch-Site`를 검사한다** (`apps/webuiapps/src/lib/devApiRequestGuard.ts`).
   루프백 이름, IP 리터럴, `server.allowedHosts`에 등록한 호스트만 통과하고, Origin이 Host와 다르거나
   다른 사이트에서 온 요청은 `403 {ok:false,error:'forbidden_request_origin'}`으로 거절한다. 다른 사이트에서
   시작한 최상위 GET 이동(OAuth 콜백)은 계속 허용한다. 사용자 정의 호스트명으로 접속한다면 Vite
   `server.allowedHosts`에 추가해야 한다.
3. **Browser Reader 프록시는 공개 주소만 가져온다.** 사설·루프백·링크 로컬 주소와 IPv4 매핑 IPv6는 거절하고,
   리다이렉트는 매 단계 다시 검사한다(최대 5회). 프록시한 HTML에는
   `Content-Security-Policy: sandbox allow-forms allow-popups allow-scripts`를 붙여 앱 출처의 API에 접근하지
   못하게 했다.
4. **`written-by-me` 서버**는 `cors()`를 쓰지 않고 `HOST`(기본 `127.0.0.1`)에만 바인딩한다. URL 가져오기는
   공개 주소만 허용하고 응답 본문을 5 MB로 제한한다. Claude CLI 모드에서는 API 키 없이 시작한다.
5. **Kira**: 승인된 변경이 통합되지 못하고 격리 워크트리에만 남는 경우(예: 실행 중 auto-commit을 끈 경우),
   작업을 `done`으로 넘기고 워크트리를 지우던 동작을 바꿨다. 이제 작업을 `blocked`로 두고 워크트리를 보존한다.
   통합할 변경이 정말 없을 때(`noChanges`)만 이전처럼 정리한다.
6. **채팅 직접 열기 단축 경로**(Kira/IDE/PE Analyst/YouTube 열기)는 앱 이름과 동사가 들어간 80자 이하의
   짧은 요청에만 반응한다. 문장 중간에 앱 이름이 나오는 긴 메시지는 일반 대화로 처리된다.
7. **대화 기록을 읽지 못하면 저장을 멈춘다.** `chat.json` 읽기가 실패하면(500, 잠금, 반쯤 쓰인 파일) 두 번 더
   시도하고, 그래도 실패하면 오류 안내를 보여 주고 그 세션의 자동 저장을 막는다. 파일이 없는 경우(빈 응답이나
   404)는 이전처럼 새 대화로 시작한다.
8. **CI**: Node 22로 올리고 `pnpm run lint:ci`(자동 수정 없음)와 타입 검사 단계를 추가했다. lint-staged는
   스테이징된 파일만 검사·수정한다. 단위 테스트와 e2e는 여전히 CI에서 돌지 않는다(6절 P1).

## 2. 기준선 (변경 전)

| 항목 | 결과 |
|---|---|
| 타입 검사 (`tsc --noEmit`) | 통과 |
| 린트 | 오류 0 |
| 빌드 (`pnpm build`) | 통과, 3.8 MB 청크 경고 |
| 단위 테스트 (Vitest) | 6257 통과 / 4 실패 (실행 환경에 의존하는 테스트 2개 파일) |
| e2e (Playwright, Chromium) | 152 / 152 통과 |

기준선의 단위 테스트 실패 4건은 테스트 환경 문제였다. `idaSqlPluginMiddleware.test.ts`는 스텁 플러그인
픽스처로, `aoiAutonomyReflectionChat.test.ts`는 `@vitest-environment node`로 고쳤다.

## 3. 검증 결과 (변경 후)

모두 Windows 11, Node 24.21에서 실행했다(CI는 Node 22).

| 명령 | 결과 |
|---|---|
| `pnpm --filter @openroom/webuiapps typecheck` | 통과 (오류 0) |
| `pnpm run lint:ci` | 통과 (오류 0) |
| `pnpm build` | 통과 (`Tasks: 1 successful`). 3.84 MB 청크 경고는 기준선부터 있던 것 |
| `cd apps/webuiapps && pnpm vitest run --coverage` | 425 파일, 6384 통과 / 5 건너뜀 / 0 실패 |
| 변경된 줄 커버리지 (istanbul, 8절의 방식) | 줄 90.8% (492/542), 분기 82.4% (422/512) |
| `pnpm exec playwright test` | 155 / 155 통과 (2.4분) |

위 결과는 모두 최종 코드(5절의 "부록 A를 만든 뒤 바뀐 상태"까지 반영)에서 다시 실행한 것이다.

e2e 참고: 앞선 전체 실행에서 두 번 간헐 실패가 있었다.

- `aoi-agentic-reflection-toggle.spec.ts`: 정책이 로드되기 전(토글이 비활성일 때) 표시값을 읽는 경쟁 조건이
  있었다. 다른 스펙이 저장값을 On으로 남기면 실패한다. 스펙이 토글 활성화를 기다리도록 고쳤다.
- `aoi-activity-capture.spec.ts`: 개발 서버 콜드 스타트 직후 한 번, 앱을 연 뒤 10초 안에 캡처 요청이 오지 않아
  실패했다. 단독 3회 반복과 이후 전체 실행에서는 통과했다. 이 요청은 스펙이 가로채므로 이번 서버 측 변경과는
  닿지 않는다. 원인은 아직 확인하지 못했다(6절).

변경된 줄 중 단위 테스트가 닿지 않는 50줄은 다음과 같다.

- `components/ChatPanel/index.tsx` 33줄: 대화 기록 로드 실패 처리, 직접 열기 실패 분기, 자동 검증 재실행,
  spawn 승인 인자 목록, 설정 저장. 컴포넌트가 21,288줄이라 단위 테스트 하네스가 없다. 대화 기록 로드
  실패는 새 e2e(`e2e/chat-history-load-failure.spec.ts`)로 확인했고, 이 스펙은 이전 코드에서 실패한다.
  나머지는 e2e도 닿지 않는다(6절 P1의 ChatPanel 분리 과제).
- `pages/BrowserReader/index.tsx` 3줄: `e2e/browser-reader.spec.ts`로 확인했다(이전 코드는 2.5초에 482번 요청).
- `components/Shell/index.tsx` 2줄: 메타 시드 실패 시의 `catch`. 성공 경로는 모든 e2e가 지난다.
- `pages/OpenVSCode/index.tsx` 4줄: Ctrl+S가 최신 저장 함수를 ref로 부르게 한 부분(K1-B3). 이 페이지에는 단위
  테스트도 e2e도 없다. Monaco를 대체한 페이지 테스트가 필요하다.
- `lib/kiraAutomationPlugin.ts` 8줄: 워커 오케스트레이션 루프 안의 "통합이 막혀 변경이 남은" 분기 두 곳과
  `git add` 뒤 스테이징이 비는 방어 분기. 판정 함수(`isStrandedIntegrationSkip`)와 통합 함수들의 건너뛰기
  분류는 실제 git 저장소로 테스트했지만, 루프 자체를 돌리는 하네스가 없다(6절 P1).

## 4. 수정한 문제

표의 "테스트" 열은 회귀를 막는 테스트다. "이전 코드에서 실패 확인"은 수정 전 코드로 되돌려 그 테스트가
실제로 실패하는 것을 확인했다는 뜻이다.

경로는 `apps/webuiapps/src` 기준이다(다른 위치는 저장소 루트 기준으로 적었다).

### 4.1 보안

| ID | 위치 | 문제 | 수정 | 테스트 |
|---|---|---|---|---|
| B-B1, J-B1, F2-P1, H1-B3 | `lib/devApiRequestGuard.ts`(신규), `vite.config.ts`, `lib/aoiDaemonServer.ts`, `lib/aoiHostBridgePlugin.ts`, `lib/idaSqlPlugin.ts`, `lib/ghidraLabPlugin.ts` | Vite 4의 플러그인 미들웨어는 Vite 자체의 Host 검사와 CORS보다 먼저 실행되어 `/api/*` 전체에 DNS 리바인딩 방어가 없었다. 아무 사이트나 CORS 단순 요청(`text/plain` POST)으로 이 라우트를 호출할 수 있었고, 루프백 토큰 폴백은 루프백에서 온 요청을 모두 믿었다 | Host 허용 목록, Origin=Host, `Sec-Fetch-Site` 검사를 하는 가드를 dev·preview 서버와 데몬의 첫 미들웨어로 두고, 루프백 폴백도 이 가드를 통과해야 쓰게 했다 | `devApiRequestGuard.test.ts`, 각 플러그인 테스트 |
| C-B2, K2-B2 | `vite.config.ts`, `lib/publicUrlFetch.ts`(신규) | `/api/browser-reader`가 사설 주소도 가져오고 리다이렉트를 그대로 따라갔다(SSRF). 가져온 HTML을 앱 출처의 최상위 문서로 내보내 그 안의 스크립트가 같은 출처 API를 부를 수 있었다 | 공개 주소만 허용, DNS 결과 검사, 리다이렉트 수동 처리(매 단계 재검사, 최대 5회), CSP sandbox 헤더 | `publicUrlFetch.test.ts`, e2e `browser-reader.spec.ts` |
| H1-B1 | `lib/aoiHostUrlSafety.ts`, `lib/aoiResearchEngine.ts`, `lib/aoiProactiveBriefResearch.ts` | `::ffff:7f00:1`처럼 URL 파서가 바꿔 쓴 IPv4 매핑 IPv6, `::a.b.c.d`, NAT64(`64:ff9b::`), 대괄호가 붙은 `URL.hostname`이 사설 주소 검사를 통과했다 | `extractEmbeddedIpv4`로 내장 IPv4를 꺼내 검사 | `publicUrlFetch.test.ts`, `aoiProactiveBriefScout.test.ts` |
| A (LAN 노출) | `vite.config.ts` | 개발 서버가 모든 인터페이스에 바인딩되어 같은 네트워크에서 인증 없는 `/api/*`에 접근할 수 있었다 | 기본 `127.0.0.1`, `OPENROOM_DEV_HOST`로 변경 가능 | e2e 전체(서버 기동) |
| F1-B1, F1-B4, F1-B7 | `lib/kiraAutomationPlugin.ts` | Kira 안전 명령 검사를 `$( )`, 백틱, `${ }`, `@( )`, 줄바꿈으로 우회할 수 있었다. `git branch -D/-f`, `git diff/log --output`, `rg --pre`가 안전 목록에 있었다. 환경 변수 노출 검사가 `src/env.ts` 같은 경로에도 걸렸다 | 치환·줄바꿈 거절, `git branch`는 목록 플래그만, 위험 플래그 추가, 환경 변수 패턴은 명령 위치에서만 | `kiraAutomationPlugin.test.ts` |
| F1-B2 | `lib/kiraAutomationPlugin.ts` | 보호 경로·dirty 경로 검사가 정규화 전 경로(`src/../.git/config`)를 봤다. Windows의 끝 점·공백, ADS(`:`)도 통과했다 | `canonicalizeKiraToolPath`로 도구 실행 전에 한 번 정규화, `.git` 정확히 일치도 보호 | `kiraAutomationPlugin.test.ts` (`canonicalizeKiraToolPath`, `executeTool`) |
| C-B1 | `lib/workspaceCommandPolicy.ts` | 승인 없이 실행되는 명령에 `git --output/--no-index`, `git branch -D`, `vite --outDir/--emptyOutDir`, `eslint -o`가 허용됐다 | 금지 플래그 목록과 `git branch` 목록 플래그 허용 목록 | `workspaceCommandPolicy.test.ts` |
| J-B2 | `lib/idaPePlugin.ts` | `/api/ida-pe/analyses`가 디스크의 아무 파일이나 읽어 문자열을 돌려줬고, headless 백엔드의 `/functions`·`/function-detail`은 아무 바이너리나 열어 디스어셈블·디컴파일 결과를 돌려줬다 | 실제 경로(링크 해석 후)가 샘플 캐시 안에 있을 때만 허용. IDA Pro 현재 IDB 모드는 열린 IDB와 대조만 하므로 제외 | `idaPePluginContainment.test.ts` |
| K1-B5 | `lib/rehypeAllowlist.ts`(신규), `pages/Diary` | `rehype-raw` 뒤에 정화 단계가 없어 일기 본문의 HTML 스크립트·이벤트 속성이 실행됐다 | 허용 목록 정화기를 `rehype-raw` 뒤에 둠 | `rehypeAllowlist.test.tsx` |
| K1-B10 | `pages/CyberNews/liveNews.ts` | 피드 링크에 `javascript:` URL이 들어갈 수 있었다 | `safeExternalUrl`로 http(s)만 허용 | `liveNews.test.ts` |
| G1-B2 | `lib/aoiAutonomyPlugin.ts` | `/wakeup` 요청 본문이 네트워크 허용·예산·`llmConfig`를 덮어써 정책과 배포 상한을 우회했다 | 네트워크 = 배포 상한 AND 정책 AND 요청, 예산은 줄이는 방향만, `llmConfig`는 네트워크가 허용될 때만 | `aoiAutonomyPlugin.test.ts`, `aoiAutonomyWakeupRoute.test.ts` |
| E2-B3 | `components/ChatPanel/AoiHostBridgeSettingsPanel.tsx`, `lib/aoiHostBridgeConsent.ts` | 설정 패널을 열 때마다 운영자가 끈 세션 소스 동의를 다시 켰다 | 소스 목록을 먼저 읽고, 아무도 결정하지 않은 소스만 복구. 목록을 못 읽으면 복구하지 않음 | `AoiHostBridgeSettingsPanel.test.tsx`(이전 코드에서 실패 확인), `aoiHostBridgeConsent.test.ts` |
| E2-B2 | `components/ChatPanel/index.tsx` | 프로세스 실행 승인 팝업이 인자를 200자에서 잘라, 승인하는 내용 전체를 볼 수 없었다 | 인자 전체를 목록으로 표시 | 없음 (UI) |
| B-B2 | `lib/aoiHostBridgeKillSwitch.ts`, `lib/aoiHostBridgePlugin.ts` | 데스크톱 캡처의 명시적 끄기(`false`)를 저장할 수도, 집행할 수도 없었다 | opt-out 키는 `false`를 저장하고 캡처 라우트가 확인 | `aoiHostBridgeKillSwitch.test.ts`, `aoiHostBridgePlugin.test.ts` |
| B-B3 | `lib/aoiHostBridgePlugin.ts` | 프로세스 종료 라우트가 보호 PID(자기 자신·부모)를 넘기지 않아 서버가 자기를 죽일 수 있었다 | `collectAoiHostBridgeProtectedPids()`를 두 종료 라우트에 전달 | `aoiHostBridgePlugin.test.ts` |
| L-B2 | `written-by-me/server.js`, `written-by-me/services/urlFetcher.js` | 모든 출처에 CORS를 열고 모든 인터페이스에 바인딩했으며, URL 가져오기에 사설 주소 차단·리다이렉트 검사·크기 제한이 없었다 | CORS 제거, `HOST` 기본 `127.0.0.1`, 공개 주소만·리다이렉트 재검사·5 MB 제한 | 테스트 없음. Node로 `isPrivateAddress`/`fetchUrlContent`를 직접 호출해 확인 |

### 4.2 데이터 손실

| ID | 위치 | 문제 | 수정 | 테스트 |
|---|---|---|---|---|
| E1-B3 (E1-B5 일부) | `lib/chatHistoryStorage.ts`, `components/ChatPanel/index.tsx` | `chat.json` 읽기 실패(500, 잠금, 반쯤 쓰인 파일)를 "대화 없음"과 똑같이 처리해 첫 인사를 시드했고, 500 ms 자동 저장이 그것으로 실제 대화를 덮어썼다 | `ok/missing/error` 세 상태로 구분하고 재시도, 실패한 세션은 자동 저장 보류, 저장 경로는 예약 시점에 고정 | `chatHistoryStorage.test.ts`, e2e `chat-history-load-failure.spec.ts`(이전 코드에서 실패 확인) |
| H2-B11 | `lib/sessionDataServer.ts` | 세션 파일을 제자리에 써서, 쓰는 중 충돌하거나 다른 프로세스가 읽으면 잘린 JSON을 보고 기록 전체를 없는 것으로 취급했다 | 임시 파일 + rename. Windows가 rename을 거절하면(EPERM/EBUSY/EACCES) 직접 쓰기 | `sessionDataServer.test.ts`, `sessionDataServerAtomicFallback.test.ts` |
| F2-B2 | `lib/kiraAutomationPlugin.ts` | 통합이 `skipped`이면 작업을 끝내고 워크트리와 브랜치를 강제 삭제해, 그곳에만 있던 승인된 변경이 사라졌다 | 건너뛰기에 `noChanges` 표시. 변경이 남는 건너뛰기는 작업을 막고 워크트리 보존(단일·다중 워커 모두) | `kiraAutomationPlugin.test.ts` (실제 git 저장소) |
| F2-B4 | `lib/kiraAutomationPlugin.ts` | `cherry-pick --no-commit` 충돌 뒤 `--abort`는 아무것도 하지 않아 사용자 체크아웃에 충돌 표시가 남았다 | `git reset --merge`로 되돌리고 남은 변경을 확인해 보고 | `kiraAutomationPlugin.test.ts` (실제 git 저장소) |
| D-B5 | `lib/undoTools.ts` | `undo_last_action`이 자기 자신을 변경으로 기록해, 두 번 부르면 되돌린 것을 다시 적용했다 | undo는 기록하지 않음 | `undoToolsHistory.test.ts` |
| G1-B1 | `lib/aoiAutonomyStore.ts` | 결정·성찰·디스패치 목록을 200개로 자를 때 가장 오래된 것을 남겼다 | 최신순(mtime, 이름) 정렬 후 자름 | `aoiAutonomyStore.test.ts` |
| K1-B2 | `pages/MusicApp/index.tsx` | 앱을 처음 열 때 에이전트 액션이 초기 상태로 실행되어 저장된 재생 목록을 덮어썼다 | 최신 상태 ref 사용 | `pages/MusicApp/index.test.tsx`(이전 코드에서 실패 확인) |

### 4.3 정확성

| ID | 위치 | 문제 | 수정 | 테스트 |
|---|---|---|---|---|
| E1-B1 | `lib/chatDirectOpenIntents.ts`(신규), `components/ChatPanel/index.tsx` | 직접 열기 정규식이 앱 이름이 들어간 일반 메시지를 가로챘고, 앱 열기가 실패해도 성공 응답을 보냈다 | 짧고 고정된 요청만 인식, 디스패치 결과 확인 | `chatDirectOpenIntents.test.ts` |
| E1-B2, H2-B2 | `lib/chatDirectOpenIntents.ts`, `lib/aoiMemoryManager.ts`, `lib/aoiMemoryServerWriter.ts` | "I'm tired" 같은 말을 이름으로 저장하고 실제 이름을 덮어썼다 | "my name is", "call me", "내 이름은" 등 명시적 표현만 인정 | `chatDirectOpenIntents.test.ts`, `aoiMemoryManager.test.ts` |
| E2-B1 | `components/ChatPanel/index.tsx` | `respond_to_user` 자동 검증이 tool 결과 없이 system 메시지를 붙여 제공자가 400으로 거절했다 | tool 메시지로 응답, 진단 실패는 대화를 끊지 않음 | 없음 (ChatPanel) |
| D-B1 | `lib/vibeContainerMock.ts` | 겹치는 디스패치가 전역 함수를 번갈아 덮어써 결과가 엉뚱한 액션에 전달되고 거짓 타임아웃이 났다 | `action_id`별 대기 목록 | `vibeContainerMock.test.ts`(이전 코드에서 실패 확인) |
| D-B2 | `lib/seedMeta.ts`, `components/Shell/index.tsx`, `components/ChatPanel/index.tsx` | 모듈 플래그 때문에 초기화·세션 전환 뒤 메타 파일을 다시 시드하지 않았다 | 세션별 기록, 초기화 때 강제 | `seedMeta.test.ts` |
| D-B3 | `lib/appRegistry.ts` | CRLF `meta.yaml`에서 액션 설명이 사라졌다 | 줄바꿈 정규화 | `appRegistry.test.ts` |
| D-B10 | `lib/action.ts` | 핸들러가 동기로 던지면 결과가 가지 않아 타임아웃이 났다 | try/catch로 오류 결과 전송 | `actionListener.test.tsx` |
| F2-B3 | `lib/kiraAutomationPlugin.ts` | 분해된 하위 작업이 부모 설명을 물려받아 다시 분해되어 작업이 4→16→64개로 불어났다 | `decomposedFrom` 표시, 하위 작업은 다시 분해하지 않음 | `kiraAutomationPlugin.test.ts` |
| F1-B3 | `lib/kiraAutomationPlugin.ts` | 오류 메시지에 "aborted"가 들어가면 중단으로 보고 무한 재시작했다 | 이름(`AbortError`)으로만 판정 | `kiraAutomationPlugin.test.ts` |
| F1-B5, K1-B8 | `lib/kiraAutomationPlugin.ts`, `pages/OpenVSCode` | `String.replace`의 문자열 치환이 `$&`, `` $` ``, `$'`를 확장해 파일 나머지를 끼워 넣었다 | 함수 치환 사용(`edit_file`, 원격 명령 템플릿, OpenVSCode PATCH) | `kiraAutomationPlugin.test.ts` (`executeTool`, `buildRunnerCommand`). OpenVSCode 쪽은 테스트 없음 |
| F1-B6 | `lib/kiraAutomationPlugin.ts` | `tests/` 디렉터리만 있어도 Python이 아닌 저장소에 `pytest`를 기본 검증으로 넣었다 | Python 표지가 있을 때만 | `kiraAutomationPlugin.test.ts` |
| F2-B7 | `lib/kiraAutomationPlugin.ts` | 검증 명령의 경로 정규식이 `.tsx`, `.json`을 잘라 읽었다 | 긴 확장자 우선, 단어 경계 | `kiraAutomationPlugin.test.ts` |
| F2-B12 | `lib/kiraAutomationPlugin.ts` | `git diff --check`는 문제가 있을 때 0이 아닌 코드로 끝나는데, 그 출력이 버려졌다 | 거절 객체의 stdout을 읽어 보고 | `kiraAutomationPlugin.test.ts` |
| G1-B4 | `lib/aoiAutonomyBackgroundRunner.ts` | `stop()` 뒤에도 예약된 틱이 실행됐다 | 실행 중이거나 멈춘 상태면 틱을 시작하지 않음 | `aoiAutonomyBackgroundRunner.test.ts`(이전 코드에서 실패 확인) |
| G2-B1, G2-B2 | `lib/aoiAutonomyGoals.ts` | 자리표시자 sourceRef 때문에 모든 메시지가 목표 진전으로 집계되고 같은 목표가 중복 생성됐다 | 자리표시자 무시 | `aoiAutonomyGoals.test.ts`(이전 코드에서 실패 확인) |
| G2-B6 | `lib/aoiSafeActionPlan.ts` | 명시적으로 빈 검증 목록을 기본 검증으로 채웠다 | 빈 목록은 빈 채로 둠 | `aoiSafeActionPlanValidation.test.ts` |
| H1-B6 | `lib/aoiProactiveBriefStore.ts` | 다시 정찰하면 사용자가 거절한 브리프가 되살아났다 | 결정된 상태 보존 | `aoiProactiveBriefStore.test.ts` |
| K1-B1 | `pages/Chess` | 폰 공격 방향이 반대라 체크·스테일메이트 판정이 틀렸다 | 방향 수정 | `pages/Chess/__tests__/pawnAttack.test.ts` |
| K2-B1 | `pages/BrowserReader/index.tsx` | 기록 저장 함수가 effect 의존성에 들어가 페이지를 무한히 다시 가져왔다 | ref로 분리, `currentUrl`에만 의존 | e2e `browser-reader.spec.ts`(이전 코드는 2.5초에 482번 요청) |
| K2-B3 | `pages/EvidenceVault/index.tsx`, `components/AppWindow/index.tsx` | 알 수 없는 type/category/impact 값이 렌더 중 예외를 내고, 에러 경계가 없어 데스크톱 전체가 내려갔다 | 안전한 조회와 창 단위 에러 경계 | `EvidenceVault/__tests__/unknownFields.test.tsx`(이전 코드에서 실패 확인), `lookup.test.ts`, `WindowErrorBoundary.test.tsx` |
| K2-B7 | `pages/Gomoku/index.tsx` | 에이전트의 기권을 에이전트의 승리로 기록했다 | 기권한 쪽(`color`)이 패배 | `pages/Gomoku/index.test.tsx`(이전 코드에서 실패 확인) |
| E2-B5 | `lib/imageGenClient.ts`, `components/ChatPanel/index.tsx` | 이미지 생성 키를 지워도 localStorage에 남아 새로고침하면 돌아왔다 | `null`이면 삭제, 항상 저장 호출 | `imageGenClient.test.ts` |
| E2-B6 | `components/ChatPanel/index.tsx` | Codex Auth를 쓰는 대화 모델이 "사용 안 함"으로 보이고, 다음 저장에서 설정이 지워졌다 | Codex Auth도 활성 모델로 인정 | 없음 (ChatPanel) |
| E2-B8 | `components/ChatPanel/ModPanel.tsx` | 페이지마다 100부터 다시 세는 타깃 ID가 새로고침 뒤 중복됐다 | 단계와 완료 목록에서 다음 ID 계산 | `ModPanel.test.tsx`(이전 코드에서 실패 확인) |
| A-B2 | `lib/logPlugin.ts` | `split('/')`로 디렉터리를 구해 Windows에서 `mkdir('')`가 ENOENT로 실패했다 | `dirname` 사용 | `logPlugin.test.ts` |
| I-B4 | `lib/aoiFieldCiGateCli.ts` | `--base`가 비었거나 diff가 비어도 게이트가 통과했다 | 실행 오류 코드로 종료 | `aoiFieldCiGateCli.test.ts` |
| (소스 오류) | `vite.config.ts`, `lib/aoiAutonomyPlugin.ts` | 소스에 NUL 바이트가 그대로 들어 있었다 | `\0` 이스케이프 | 빌드·타입 검사 |

### 4.4 빌드·CI·도구

| ID | 위치 | 문제 | 수정 |
|---|---|---|---|
| L-B1 | `package.json` | Turbo 2 strict env 모드가 `AOI_*` 환경 변수를 지워, 네트워크 상한 같은 배포 설정이 개발 서버에 전달되지 않았다(열린 쪽으로 실패) | `dev` 스크립트에 `--env-mode=loose` |
| L-B6 | `.github/workflows/claude-review.yml` | `PR_NUMBER`가 트리거한 PR로 설정되지 않았다 | 이벤트의 PR 번호 사용 |
| L-B7, I-B6 | `.github/workflows/ci.yml`, `package.json` | CI가 `eslint --fix`로 돌아 고칠 수 있는 오류는 실패하지 않았고, 타입 검사가 없었다 | `lint:ci`(자동 수정 없음) 추가, 타입 검사 단계 |
| L-B8 | `.github/workflows/ci.yml` | `undici` 8에 필요한 Node 22.19보다 낮은 Node로 돌았다 | Node 22 |
| L-B9 | `package.json` | lint-staged가 저장소 전체를 검사·수정했다 | 스테이징된 파일만 `prettier --write`, `eslint --fix --quiet` |
| I-B1 | `.github/workflows/ci.yml` | push 이벤트에서 `--base origin/main`이 HEAD와 같아 필드 게이트가 항상 건너뛰었다 | push는 직전 커밋, PR은 대상 브랜치와 비교 |
| L-B3, L-B4 | `written-by-me/routes/upload.js`, `written-by-me/server.js` | 정의되지 않은 변수를 쓰는 로그 줄, CLI 모드인데 API 키가 없으면 종료 | 로그 줄 제거, CLI 모드는 키 없이 시작 |
| (기준선) | `lib/__tests__/idaSqlPluginMiddleware.test.ts`, `lib/__tests__/aoiAutonomyReflectionChat.test.ts` | 실행 환경에 따라 실패하는 테스트 4건 | 스텁 플러그인 픽스처, node 환경 지정 |
| (e2e) | `e2e/aoi-agentic-reflection-toggle.spec.ts` | 정책 로드 전 표시값을 읽는 경쟁 조건 | 토글 활성화를 기다린 뒤 읽음 |

## 5. 확인했지만 고치지 않은 문제

슬라이스별 전체 표(위치, 심각도, 권장 조치)는 부록 A에 있다. `OPEN (미확인)` 20건은 리뷰어가 재현까지 확인하지
못한 항목이다. 먼저 볼 미수정 버그는 다음과 같다.

| ID | 심각도 | 요약 |
|---|---|---|
| F2-B1 | 높음 | Kira 단일 워커 격리 모드에서 재시도하면 마지막 사이클 파일만 커밋되고 앞 사이클 편집은 리뷰 없이 사라진다 |
| H2-B1 | 높음 | 선호 near-duplicate 판정이 무관한 영어 선호(Radiohead/Coldplay)를 병합해 새 선호를 잃는다 |
| H2-B3 | 높음 | recall 사용량 기록이 턴 시작 때의 스냅샷으로 메모리 파일을 덮어써 supersede·삭제를 되돌린다 |
| K1-B4 | 높음 | OpenVSCode OPEN_FILE/SAVE_FILE이 실패해도 success를 돌려줘 다음 REPLACE가 엉뚱한 파일을 덮어쓴다 |
| A-B3 | 중간 | `/api/llm-proxy`가 임의 대상에 헤더 전체를 전달하고 요청·응답 본문을 콘솔에 남긴다 |
| E1-B4, E1-B5 | 중간 | 수동 턴과 앱 이벤트 턴이 동시에 돌고, 턴 도중 세션을 바꾸면 이전 세션 응답이 새 세션에 기록된다(E1-B5는 자동 저장 경로만 고침) |
| H2-B4, H2-B5 | 중간 | 임베딩 backfill과 decay apply가 오래된 스냅샷으로 써서 archive·삭제·pin을 되돌린다 |
| D-B4 | 중간 | 음악 직접 파서가 "한국어로 해줘" 같은 일반 문장을 YouTube 검색으로 처리한다 |
| F1-B11 | 중간(미확인) | Kira `read_file`/`search_files`가 protectedPaths를 무시해 `.env` 내용이 LLM으로 갈 수 있다 |
| K1-B6, K2-B5, K2-B6 | 중간 | HabitGarden 동의 스위치 원복, Gmail 연결 뒤 동기화 안 됨, 에이전트 refresh가 미저장 초안을 덮어씀 |

부록 A를 만든 뒤 바뀐 상태:

- **G1-B2**: `/wakeup`의 일일 예산(LLM 토큰, 스카우트 네트워크, 직접 채팅)을 서버가 쓰는 값(환경 변수, 없으면
  기본값) 이하로 묶었다(`resolveAoiServerWakeupDailyBudgets`). 남은 것은 본문 `llmConfig`를 네트워크가 허용될 때
  그대로 쓰는 부분이다(PARTIAL 유지).
- **H1-B3**: 자율 실행·리서치·Dewdrop·Ghidra Lab·Written By Me 플러그인이 자기 자신을 호출할 주소를 Host 헤더가
  아니라 요청을 받은 소켓에서 만든다(`lib/serverSelfOrigin.ts`). FIXED.
- **K1-B3**: OpenVSCode Ctrl+S가 에디터 마운트 시점의 저장 함수를 붙잡던 문제를 ref로 고쳤다. 이 페이지에는 테스트
  하네스가 없어 자동 테스트는 아직 없다(6절 P2에 추가할 과제).
- **F1-XR1**: 검증 결과 두 HTTP 핸들러 모두 실행 중인 job 컨트롤러가 있어야 파일을 읽으므로 임의 `workId`로는
  닿지 않는다. 방어적으로 `workId` 형식 검사는 권장한다.

## 6. 개선 과제

버그 단위 수정(5절)과 별개로, 같은 종류의 문제가 다시 생기지 않게 하는 구조적 과제다.

### P1 — 먼저 할 것

1. **CI에서 단위 테스트와 e2e를 돌린다.** 지금 CI는 린트, 타입 검사, 빌드, 필드 게이트만 돌린다. 이번 리뷰에서
   찾은 회귀 중 상당수는 이미 있는 테스트 방식으로 잡을 수 있는 것이었다. `pnpm --filter @openroom/webuiapps test`를
   추가하고, e2e는 `pnpm exec playwright install --with-deps chromium` 뒤 `pnpm test:e2e`로 돌린다. `apps/webuiapps/vitest.config.ts`의 커버리지
   측정 대상은 `src/lib/llmClient.ts` 하나뿐이다(임계값 줄 75, 함수 85, 분기 70). 대상을 넓히고, 변경된 줄 커버리지(CLAUDE.md의
   90% 기준)를 PR마다 계산해 보여 주는 단계가 있으면 기준을 실제로 지킬 수 있다.
2. **`components/ChatPanel/index.tsx`(21,288줄)를 나눈다.** 대화 기록 저장·복원, 직접 열기 단축 경로, 도구 루프와
   자동 검증, 설정 모달, 승인 팝업을 훅과 모듈로 분리해 단위 테스트가 닿게 한다. 이번에 고친 ChatPanel 버그
   (E1-B1, E1-B3, E2-B1, E2-B2, E2-B6)는 모두 이 파일 안의 흐름이었고, 변경된 줄 중 단위 테스트가 닿지 않는
   줄의 대부분(33/50)이 여기 있다.
3. **Kira 오케스트레이션 테스트 하네스를 만든다.** `lib/kiraAutomationPlugin.ts`(22,781줄)는 개별 함수 테스트는
   많지만 워커→리뷰어→통합 루프를 돌리는 테스트가 없다. 가짜 LLM과 임시 git 저장소로 한 작업을 끝까지 돌리는
   하네스가 있으면 F2-B1, F2-B2 같은 통합 단계 버그를 직접 검증할 수 있다. 파일 분리(명령 정책, 경로 가드,
   git 통합, 프롬프트 구성)도 함께 검토한다.
4. **서버 측 URL 가져오기의 DNS 고정(H1-B2).** 이번에 만든 `lib/publicUrlFetch.ts`와 리서치 엔진은 DNS 결과를
   검사한 뒤 `fetch`가 다시 조회해 연결한다. 검사와 연결 사이에 응답을 바꾸는 DNS 리바인딩은 아직 막지 못한다.
   검사한 주소로만 연결하는 `lookup`을 단 HTTP 에이전트(undici `Agent`의 `connect.lookup`)로 고정한다.
5. **에이전트 CLI 권한(F1-P1).** Kira의 claude-cli 워커는 `bypassPermissions`로 돌고, codex-cli에는 실행 정책이
   없다. 워크트리 밖 쓰기와 네트워크를 막는 샌드박스 또는 허용 목록이 필요하다.

### P2 — 다음

1. **번들 크기.** 메인 청크가 3.84 MB(gzip 998 kB), 다음 청크가 1.7 MB다. 무거운 앱(`ChessBoard3D` 950 kB, mermaid,
   cytoscape, katex)을 동적 import로 나누거나 `build.rollupOptions.output.manualChunks`로 분리한다.
2. **Vite 4.5 → 5/6.** 플러그인 미들웨어가 Vite의 Host 검사보다 먼저 도는 구조라 이번에 별도 가드를 넣었다.
   업그레이드하면 Sass legacy JS API 경고(Dart Sass 2.0에서 제거 예정)도 `api: 'modern'`으로 정리할 수 있다.
   가드는 업그레이드 뒤에도 유지한다.
3. **e2e 상태 격리.** 모든 워커가 같은 `e2e/.tmp-home`을 써서, 한 스펙이 바꾼 정책·소스 동의가 병렬로 도는
   다른 스펙에 영향을 준다(이번에 고친 토글 스펙의 경쟁 조건이 그 예). 워커별 홈 디렉터리를 쓰거나 스펙마다
   상태를 초기화한다. `aoi-activity-capture.spec.ts`의 콜드 스타트 실패(3절)도 이 과정에서 원인을 확인한다.
4. **쓰이지 않는 `less` 의존성 제거.** 루트 `devDependencies`의 `less`는 쓰는 곳이 없다(`.less` 파일 없음).
   `less@4.5.1`의 postinstall은 자기 모노레포 안인지 판정하는 조건이 일반 프로젝트에서도 참이 되어, CI가 아닌
   환경에서 설치할 때마다 `pnpm exec playwright install`을 실행한다(악성은 아니지만 의도하지 않은 동작).
   의존성을 지우거나 pnpm 설정으로 빌드 스크립트를 막는다.
5. **줄바꿈 정책.** 저장소에 `.gitattributes`가 없고 `core.autocrlf=true`에 의존한다. 도구가 LF로 쓴 파일과
   CRLF 작업 트리가 섞인다. `* text=auto eol=lf`와 같은 규칙으로 고정한다.

### P3 — 여유가 있을 때

1. **`written-by-me` 테스트와 의존성.** 테스트가 없고, 저장소에 의존성이 설치되어 있지 않다. URL 검사와 업로드
   라우트부터 테스트를 붙인다.
2. **세션 데이터 API의 "없음" 표현.** 없는 파일에 `200 {}`를 돌려줘 클라이언트가 빈 객체와 없는 파일을 구분하지
   못한다(C-B4). 404로 바꾸면 클라이언트 쪽 추측이 줄어든다. 이번 수정에서 대화 기록 로더는 두 형태를 모두
   "없음"으로 처리한다.

보고서별 P1~P3 제안 전체(약 190건)는 부록 A의 각 슬라이스 표에 있다.

## 7. 문서 불일치

고친 것: README 3종의 Node 버전(22.19+)·Written By Me 경로·루프백 바인딩 안내, CONTRIBUTING clone URL,
`docs/project-structure.md` 앱 목록(29개), `.claude` 규칙(data-interaction §2.4 참조·코드 펜스·경로 예시,
06-integration 스테이지 ID, vibe.md 6단계).

남은 것(부록 A의 L 절): README 앱 표 누락(L-DD1), 동작하지 않는 `pnpm clean`(L-DD3), 레거시 meta 레이아웃(L-DD6),
간격 토큰 불일치(L-DD7), `app_name` 표기 규칙(L-DD8), 커버리지 측정 대상(L-DD9), e2e 서버 재사용 설명(L-DD10),
꺼진 react-hooks 규칙(L-DD11), SECURITY.md 연락처(L-DD12), Dewdrop 경로(L-B12), `app-definition.md` 저장 트리(L-B11).
`.gitignore`의 `docs/*` 허용 목록에는 이 문서를 추가했다(L-P3c의 나머지는 남음).

## 8. 리뷰 범위와 한계

- **범위**: `apps/webuiapps`(UI, 앱 페이지, Vite 개발 서버 플러그인, Aoi/Kira/호스트 브리지 라이브러리),
  `packages/vibe-container`, `e2e/`, `written-by-me/`, `.github/workflows`, `.claude/`(규칙·워크플로 문서),
  `docs/`, README 3종, CONTRIBUTING.
- **영역 구분**: A 개발 서버·Vite 설정, B 호스트 브리지, C 워크스페이스·브라우저 도구, D 앱 레지스트리·액션
  버스·undo, E1/E2 ChatPanel(대화 흐름 / 설정·승인 UI), F1/F2 Kira(도구·명령 샌드박스 / 오케스트레이션·통합),
  G1/G2 자율 실행(스토어·러너·wakeup / 목표·계획), H1/H2 리서치·메모리, I 필드 CI 게이트, J RE 랩(IDA/Ghidra/PE),
  K1/K2 앱 페이지, L 빌드·CI·문서·`written-by-me`.
- **방법**: 정적 리뷰 후 재현 가능한 항목은 테스트로 확인했다. 수정한 항목 대부분은 수정 전 코드로 되돌려
  테스트가 실패하는지 확인했다.
- **확인하지 못한 것**: 실제 LLM, IDA Pro / IDA headless MCP, Ghidra, 외부 커넥터(GitHub 등)와의 연동은
  돌려 보지 않았다. 이 경로의 판단은 코드 읽기와 목(mock) 기반 테스트에 근거한다. 실행 환경은 Windows 11
  하나였고, e2e는 Chromium만 돌렸다. `written-by-me`에는 테스트와 설치된 의존성이 없어, 바꾼 URL 검사
  함수는 Node로 직접 호출해 확인했다.
- **커버리지 측정 방식**: 변경된 줄 기준 커버리지는 istanbul 결과(`coverage-final.json`)에서 `git diff -U0`가
  가리키는 추가·수정 줄만 골라 계산했다(새 파일은 전체 줄).

## 부록 A. 전체 지적 목록

리뷰 보고서와 원장(LEDGER)의 모든 항목을 작업 트리와 대조한 표다. 줄번호는 수정 전 기준이고, 상태 칸의 #번호는 아래 "수정 범례"를 가리킨다.

### 집계

| 슬라이스 | 총계 | FIXED | PARTIAL | OPEN | 그중 버그(B) FIXED/PARTIAL/OPEN |
|---|---|---|---|---|---|
| A | 12 | 3 | 1 | 8 | 4: 2/1/1 |
| B | 3 | 3 | 0 | 0 | 3: 3/0/0 |
| C | 8 | 2 | 0 | 6 | 4: 2/0/2 |
| D | 22 | 5 | 0 | 17 | 10: 5/0/5 |
| E1 | 24 | 4 | 2 | 18 | 12: 3/1/8 |
| E2 | 24 | 6 | 0 | 18 | 12: 6/0/6 |
| F1 | 30 | 7 | 1 | 22 | 17: 7/1/9 |
| F2 | 28 | 5 | 2 | 21 | 16: 5/0/11 |
| G1 | 21 | 5 | 1 | 15 | 11: 3/1/7 |
| G2 | 21 | 3 | 0 | 18 | 9: 3/0/6 |
| H1 | 24 | 2 | 1 | 21 | 12: 2/1/9 |
| H2 | 25 | 3 | 0 | 22 | 13: 2/0/11 |
| I | 22 | 4 | 0 | 18 | 10: 4/0/6 |
| J | 7 | 2 | 0 | 5 | 2: 2/0/0 |
| K1 | 30 | 5 | 0 | 25 | 18: 5/0/13 |
| K2 | 30 | 5 | 1 | 24 | 13: 4/1/8 |
| L | 39 | 10 | 5 | 24 | 15: 6/4/5 |
| **합계** | **370** | **74** | **14** | **282** | **181: 64/10/107** |

OPEN 282건 중 20건은 `OPEN (미확인)`이다(D-B6, D-B7, E1-B11, E2-B4, E2-B7, E2-B10, F1-B11, F1-B14, F2-B8, F2-B13, G1-B5, G1-B6, G1-B7, G1-B9, G1-B11, H1-B2, H1-B7, H1-B9, H2-B6, H2-B12).

### 수정 범례 (상태 칸의 #번호)

| # | 내용 |
|---|---|
| #1 | 공용 dev-API 요청 가드 `src/lib/devApiRequestGuard.ts`(Host, Origin, Sec-Fetch-Site 검사)를 dev·preview 서버와 autonomy 데몬에 가장 먼저 마운트. hostBridge/idaSql/ghidraLab의 루프백 토큰 fallback도 가드 통과를 요구. 본문 크기 제한과 Content-Type 검사는 하지 않음 |
| #2 | browser-reader 프록시: `src/lib/publicUrlFetch.ts`(공용 호스트 전용, 리다이렉트마다 재검증) + 프록시 HTML에 CSP `sandbox` 헤더 |
| #3 | `aoiHostUrlSafety`의 IPv4-mapped, NAT64, 대괄호 IPv6 처리(`extractEmbeddedIpv4`)를 research engine과 proactive brief research가 사용. DNS TOCTOU는 미수정 |
| #4 | dev 서버 기본 바인딩 `127.0.0.1`(`OPENROOM_DEV_HOST`로 opt-in) |
| #5 | Kira(`kiraAutomationPlugin.ts`) 수정 묶음(F1-B1~B7, F2-B2/B3/B4/B7/B12) |
| #6 | `workspaceCommandPolicy` 금지 플래그와 `git branch` 목록 전용 |
| #7 | `idaPePlugin`의 `samplePath` 실경로 격리(`isRealPathInside`) |
| #8 | spawn 승인 팝업 전체 인자 표시, `os_desktop_capture` opt-out 강제, kill 라우트 `protectedPids` |
| #9 | `/wakeup`: network = env ceiling AND policy AND request, 0 이하 예산 제거, network 허용 시에만 llmConfig |
| #10 | Host bridge 설정 패널이 세션 소스를 먼저 읽고 미결정 소스만 복구 |
| #11 | Diary `rehype-raw` 뒤 allowlist sanitizer(`src/lib/rehypeAllowlist.ts`), CyberNews `safeExternalUrl` |
| #12 | chat history tri-state 로드(ok/missing/error)와 재시도, 로드 실패 시 autosave 보류, 저장 경로를 예약 시점에 캡처, session-data 원자적 쓰기 |
| #13 | `undo_last_action` 자기 기록 제거, autonomy store `listJsonFiles` 최신 유지, MusicApp 콜드 오픈 최신 상태 ref |
| #14 | direct-open fast path를 짧은 앵커 요청으로 한정하고 디스패치 결과 확인, 명시적 표현만 이름으로 추출(`src/lib/chatDirectOpenIntents.ts`) |
| #15 | `respond_to_user` 자동 검증 결과를 tool 메시지로 응답 |
| #16 | vibe-container mock: action_id별 resolver 레지스트리, seedMeta 세션별+리셋 시 force, meta.yaml CRLF, `action.ts` 동기 throw 처리 |
| #17 | runner `startTick` 조기 반환, placeholder goal sourceRefs 무시, 빈 검증 목록 유지, proactive brief 재스카우트 시 결정 상태 보존 |
| #18 | Chess 폰 공격, EvidenceVault 미지 필드 조회+`AppWindow` 창별 오류 경계, BrowserReader 재요청 루프, Gomoku 기권, OpenVSCode PATCH `replaceOnce`, ModPanel 고유 target id, image-gen 키 삭제, Codex Auth 대화 모델 |
| #19 | `logPlugin` `dirname` |
| #20 | 빌드·CI·툴링·문서: dev `--env-mode=loose`, written-by-me(cors 제거, 127.0.0.1, 공용 전용 fetcher, 업로드 로그, CLI 모드), claude-review `PR_NUMBER`, CI `lint:ci`+typecheck+Node 22, lint-staged, field CI gate base·빈 diff, `.claude` 규칙·스테이지 문서, README/CONTRIBUTING/project-structure 일부 |
| diff | 수정 목록에는 없지만 LEDGER와 작업 트리 diff로 확인 |

### 검증 메모 (수정 목록과 작업 트리의 차이)

- **J-B2 → FIXED**: 수정 목록은 `/analyses`만 고쳤다고 했지만, 작업 트리에는 `/functions`와 함수 상세 라우트에도 headless 백엔드용 `isRealPathInside` 격리가 있다. ida-pro-mcp 백엔드는 열린 IDB와 대조하려고 파일을 읽을 뿐 내용을 돌려주지 않는 의도적 예외다.
- **G1-B2 → PARTIAL**: `sanitizeAoiWakeupBudgetFromHttp`는 0 이하와 비유한 값만 지운다. 기본값보다 큰 일일 예산은 그대로 통과한다(`resolveAoiLlmTokenCeiling`에 상한 없음). 그래서 "budgets only tighten"이 실제로 보장되지 않는다. 확인한 테스트도 0·음수 제거만 검증한다. 본문 `llmConfig`(baseUrl)는 network가 허용되면 여전히 채택된다.
- **H1-B3 → PARTIAL**: `aoiResearchPlugin.ts`는 바뀌지 않았고 `serverOrigin`은 여전히 Host 헤더로 만든다. 가드는 IP 리터럴 Host를 허용한다.
- **F1-B12 → PARTIAL**: 수정 목록에는 없지만 `executeTool`의 경로 정규화로 루트 이탈 경로가 이제 `error:` 결과로 돌아간다.
- **문서 드리프트**: README 앱 표(9개 누락), `pnpm clean`, Dewdrop 경로는 수정되지 않았다. 수정된 것은 Written By Me 경로, Node 버전, dev 바인딩 안내, CONTRIBUTING, project-structure다.
- **PARTIAL 추가**: L-B8(`Dockerfile`이 여전히 `node:20-alpine`이고 `engines` 없음), L-B11(`app-definition.md` 저장 트리 미수정), L-B2(`model` allowlist 미반영), A-B4(`configurePreviewServer` 마운트 유지), K2-B4(창별 오류 경계로 피해만 한정됨).
- **수정 목록에 없지만 FIXED 확인**: G1-P3a(raw NUL을 `\0`으로 교체, 두 파일 모두 NUL 0바이트), G1-P3b(데몬 가드가 `pathPrefixes: ['/']`라 `/shutdown` 포함), I-B9(테스트 경로 수정과 통과 문구 assert), I-B6(`lint:ci`).

---

### A — dev-server backend & persistence

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| A-B1 | high | `vite.config.ts`(/api 전반, openvscode file ~1726, run ~1812, `server.host` :4379), `src/lib/sessionDataServer.ts:118`, gmail/appGenerator/dewdrop/writtenByMe 플러그인 | 상태를 바꾸는 `/api/*` 라우트가 Origin/Sec-Fetch를 검사하지 않고 Content-Type과 무관하게 JSON을 파싱. 외부 페이지의 text/plain POST로 CSRF가 가능하고(파일 쓰기 후 `pnpm test` 실행 = RCE, 설정 변경, 메일 발송), `host:true`로 LAN에도 노출 | FIXED (#1, #4) | — |
| A-B2 | low | `src/lib/logPlugin.ts:147` | Windows에서 로그 디렉터리를 `split('/')`로 구해 `mkdirSync('')`가 ENOENT. `/api/log`가 항상 400 | FIXED (#19) | — |
| A-B3 | medium | `vite.config.ts:3605-3687` | `/api/llm-proxy`가 `x-llm-target-url`로 받은 임의 대상에 헤더 전체를 전달(SSRF)하고, 요청·응답 본문을 콘솔에 기록(키 유출) | OPEN | 대상을 https allowlist(설정된 provider base URL)로 제한. 본문 로깅을 없애거나 디버그 플래그 뒤로 옮기고 `authorization`/`x-api-key`/`x-goog-api-key` 마스킹 |
| A-B4 | medium | `src/lib/writtenByMePlugin.ts`(`configurePreviewServer`, `/fetch-url`, `/upload`), `src/lib/dewdropCanvasPlugin.ts` | 파일 쓰기와 URL fetch 라우트가 `vite preview`에도 마운트되고, fetch-url은 SSRF 수단 [LIKELY] | PARTIAL (#1, #20) | fetch-url은 수정된 `written-by-me/services/urlFetcher.js`(공용 호스트 전용)를 쓰고 preview에도 가드가 붙음. 남은 것: 두 플러그인의 `configurePreviewServer` 마운트 제거 |
| A-P1a | P1 | `vite.config.ts` ~4076 (jsonFilePlugin) | `/api/characters`, `/api/mods`가 파일 전체를 `writeFileSync`로 쓰고 원자적 쓰기·ETag가 없음. 동시 쓰기에서 손상이나 업데이트 유실 | OPEN | `llmConfigPlugin`의 temp+rename과 ETag/If-Match 패턴 적용 |
| A-P1b | P1 | `readRequestBody`, inline `req.on('data')`, `appGeneratorPlugin`, `gmailPlugin.readJsonBody` | 요청 본문을 크기 제한 없이 버퍼링해 대용량 POST로 dev 서버 OOM 가능(공용 가드도 크기 제한 없음) | OPEN | 공용 본문 읽기 헬퍼에 바이트 상한과 413 응답 |
| A-P2a | P2 | `vite.config.ts:420` (`albumFolderPlugin.walkImages`), `/api/album-file` | 심볼릭 링크 가드가 없고, lexical `resolve`+`startsWith` 격리는 앨범 폴더 안 심링크로 우회 가능 | OPEN | 격리 검사 전에 `fs.realpathSync` 적용 |
| A-P2b | P2 | openVscodeManager, writtenByMe, dewdropCanvas 플러그인 | `isPathInsideRoot`/`ensureInsideWorkspace`를 각자 구현해 구분자 처리가 다르고, 경로 소문자화로 대소문자 구분 FS에서 과허용 | OPEN | 실제 구분자 경계를 쓰고 POSIX에서 소문자화하지 않는 공용 `path.ts` 헬퍼로 통합하고 테스트 |
| A-P2c | P2 | `vite.config.ts` ~1972 (daemon health/capabilities proxy) | `ECONNRESET`도 `not_running`으로 분류해 실행 중인 데몬을 정지로 표시 | OPEN | `ECONNREFUSED`만 `not_running`으로 처리 |
| A-P3a | P3 | `vite.config.ts:2245, 4106` | mkdir 경로를 `os.homedir()/.openroom`로 하드코딩해 `OPENROOM_HOME`을 무시 | OPEN | `dirname(LLM_CONFIG_FILE)`/`dirname(filePath)` 사용 |
| A-P3b | P3 | `vite.config.ts` (codexAuthPlugin) | 모듈에 `codexAuthLoginSession`이 하나뿐이라, close 전에 오류 난 이전 `codex login` child가 회수되지 않음 | OPEN | 새 로그인 전에 이전 child를 종료하고 회수 |
| A-P3c | P3 | `src/lib/logger.ts` | 브라우저 logger의 `/api/log` POST가 A-B2 때문에 Windows에서 쓸모없음("A-B2 먼저 수정") | FIXED (#19) | — |

### B — 호스트 브리지 (LEDGER만 근거)

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| B-B1 | 미기재 | `src/lib/aoiHostBridgePlugin.ts`(`trustLoopbackToken`), `vite.config.ts` /api 라우트 | 루프백 요청을 토큰 없이 신뢰하고 Origin을 검사하지 않아, 외부 페이지가 CSRF/DNS 리바인딩으로 호스트 브리지를 조작 | FIXED (#1) | — |
| B-B2 | 미기재 | `src/lib/aoiHostBridgeKillSwitch.ts`, `src/lib/aoiHostBridgePlugin.ts` | `os_desktop_capture`의 명시적 false(opt-out)를 저장할 수도 강제할 수도 없음 | FIXED (#8) | — |
| B-B3 | 미기재 | `src/lib/aoiHostBridgePlugin.ts` (kill 라우트) | kill 라우트가 `protectedPids`(자기·부모 프로세스)를 넘기지 않음 | FIXED (#8) | — |

### C — 명령 정책·브라우저 (LEDGER만 근거)

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| C-B1 | 미기재 | `src/lib/workspaceCommandPolicy.ts` | 승인 없이 `git --output`/`--no-index`/`branch -D`, `vite --outDir`/`--emptyOutDir`, `eslint -o`를 허용 | FIXED (#6) | — |
| C-B2 | 미기재 | `vite.config.ts` (`/api/browser-reader`, `read_url`) | 사설 호스트를 검사하지 않고 리다이렉트까지 따라가는 SSRF | FIXED (#2) | — |
| C-B3 | 미기재 | `src/lib/aoiBrowserDriveExecutor.ts:858` (`case 'tab'`, 위치 추정) | browser-drive `tab` 단계가 denylist 탭으로 전환하고, `finish()`가 그 DOM을 관찰·저장 | OPEN | 탭 전환 때 대상 탭 URL을 allow/denylist로 다시 검사하고, 거부된 탭이면 관찰·저장 중단 |
| C-B4 | 미기재 | `src/lib/sessionDataServer.ts` GET (~122-135) | 없는 파일 GET이 200 `{}`를 돌려줘 `file_read`의 not-found 분기가 죽은 코드 | OPEN | 없는 파일은 404 반환(새 `loadChatHistoryResult`는 404를 이미 missing으로 처리). 다른 호출부 영향 확인 |
| C-Pa | P2/P3 | `src/lib/aoiMcpConnectorDnsGuard.ts` (위치 추정) | MCP DNS 고정(pinned) lookup이 `options.all`을 무시 | OPEN | `options.all`이면 주소 배열 형태로 콜백 |
| C-Pb | P2/P3 | 위치 미기재 | 결정(decision) ID 시드에 32비트 FNV 해시를 써 충돌 여지 | OPEN | 더 긴 해시(sha256 앞부분 등)로 교체 |
| C-Pc | P2/P3 | 위치 미기재 | checkpoint 개수·크기 상한 없음 | OPEN | 보관 개수·용량 상한과 정리 정책 추가 |
| C-Pd | P2/P3 | 위치 미기재 | watch 등록 개수 상한 없음 | OPEN | watch 수 상한 추가 |

### D — chat/LLM core, 앱 디스패치, Shell·창

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| D-B1 | high | `src/lib/vibeContainerMock.ts:235-272` | 겹치는 `dispatchAgentAction`이 `sendAgentMessage` 몽키패치를 서로 덮어써 결과가 사라지고 거짓 timeout. 같은 ms의 `action_id`도 충돌 | FIXED (#16) | — |
| D-B2 | medium | `src/lib/seedMeta.ts:22-26`, `ChatPanel/index.tsx:4510` | 모듈 플래그 때문에 세션 리셋이나 전환 뒤 meta.yaml/guide.md가 다시 시드되지 않음 | FIXED (#16) | — |
| D-B3 | medium | `src/lib/appRegistry.ts:796, 830, 889` | CRLF 체크아웃에서 meta.yaml 파서가 한 줄 description을 모두 버림 | FIXED (#16) | — |
| D-B4 | medium | `src/lib/chatDirectActions.ts:540-543`, `src/lib/aoiMusicPreference.ts:294-309` | 음악 직접 파서가 "한국어로 해줘", "그럼 3번으로 해줘", "play chess with me" 같은 일반 문장을 YouTube 자동재생 검색으로 처리하고 메인 모델을 건너뜀 | OPEN | 음악 증거(음악 명사, `findKnownArtistIn` 아티스트, 음악 제안 컨텍스트)를 요구. reading이 null이거나 medium이면 모델에 위임. `이걸`, `저걸`을 `MUSIC_DEFERRAL_PRONOUN_PATTERN`에 추가 |
| D-B5 | medium | `src/lib/undoTools.ts:31-58`, `toolMutationHistory.ts` | `undo_last_action`을 두 번 부르면 두 번째가 첫 undo를 되돌려(redo) 아무것도 취소되지 않음 | FIXED (#13) | — |
| D-B6 | medium | `src/lib/toolMutationHistory.ts:126-135` | localStorage 쿼터를 넘으면 기록이 조용히 빠지고, undo가 엉뚱한 과거 파일을 복원 [LIKELY] | OPEN (미확인) | 쿼터 오류 때 오래된 기록을 정리하거나 큰 내용을 빼고 재시도. 안 되면 history를 무효화해 undo 거부, 또는 디스크 session-data로 이전 |
| D-B7 | low-medium | `src/lib/aoiMusicIntentClassifier.ts:306-348`, `ChatPanel/index.tsx:7845-7852` | 음악 의도 분류기 호출에 timeout과 취소가 없어, 업스트림이 멈추면 약 300초 대기 [LIKELY] | OPEN (미확인) | `classifyAoiTurn`처럼 8초 `AbortController`를 두고 외부 signal과 연결 |
| D-B8 | low | `src/lib/windowManager.ts:173-182, 266-297`, `AppWindow/index.tsx:178-192` | 창 위치를 복원·저장할 때 뷰포트 clamp가 없어, 화면 밖으로 나간 창을 되찾을 수 없음 | OPEN | 열기와 저장 때 타이틀바(약 120×32)가 뷰포트 안에 있도록 clamp. 유한수가 아닌 저장 필드는 무시 |
| D-B9 | low | `src/lib/vibeContainerMock.ts:186-199` | `SET_WALLPAPER`가 `/wallpaper/state.json`에 쓰지만 아무도 읽지 않아 리로드하면 원복 | OPEN | Shell 마운트 때 그 파일을 읽거나, room theme 상태로 저장 |
| D-B10 | low | `src/lib/action.ts:200-218` | 앱 핸들러의 동기 throw가 JSON 파싱용 try에 잡혀 결과를 보내지 않고, 10~20초 뒤 timeout | FIXED (#16) | — |
| D-P1a | P1 | `vite.config.ts` ~3609 (llm-proxy) | 프록시가 `Cookie`를 포함한 브라우저 헤더를 제3자 LLM 호스트로 넘김. 클라이언트가 abort해도 업스트림은 취소되지 않고, 업스트림 timeout도 없음 | OPEN | 헤더 allowlist(Cookie 제거), 요청 abort를 업스트림 fetch에 연결하고 timeout 추가 |
| D-P2a | P2 | `src/lib/vibeContainerMock.ts:274-292` | `notifyListenerAdded`가 대상 앱이 아닌 아무 등록에도 발화하고, 오래된 resolver가 최신 window snapshot을 지울 수 있음(작업 트리 미변경 확인) | OPEN | 대상 `app_id` 등록 때만 재디스패치하고, snapshot은 소유한 resolver만 지우게 |
| D-P2b | P2 | `src/lib/llmClient.ts` (:1463 등) | JSON이 아닌 200 응답의 파싱 오류가 불명확하고, `finish_reason:'length'`/`stop_reason:'max_tokens'`를 드러내지 않으며, 손상된 history의 `tool_calls.arguments` 파싱에서 throw | OPEN | 파싱 오류 메시지 개선, truncation stop reason을 결과에 노출, arguments 파싱 try/catch |
| D-P2c | P2 | `src/lib/chatHistoryStorage.ts` | chat.json이 한없이 커지고 저장마다 첨부 이미지 data URL까지 통째로 다시 업로드(E1-B6과 같은 계열) | OPEN | 크기 상한, 또는 첨부 dataUrl 제거나 별도 파일 저장 |
| D-P2d | P2 | `appRegistry.loadActionsFromMeta`, `memoryManager.loadMemories` | 약 28개 앱 meta를 하나씩 await하고, `loadMemories`는 제한 없는 `Promise.all`(동시성 규칙 위반) | OPEN | `batchConcurrent` 적용 |
| D-P2e | P2 | `docs/aoi-music-intent-design.md` §4.2, §6 | 문서 드리프트: `cache_control`을 안 보낸다고 적었지만 `llmClient.ts:1412`는 보냄. 분류기 모델 override가 없다고 적었지만 턴 분류기에는 있음 | OPEN | 문서를 현재 동작에 맞게 갱신 |
| D-P2f | P2 | `src/lib/aoiMusicPreference.ts:294` | 확신 높은 `confirmation`에 families `none`인 reading이 `play_literal`을 유지 | OPEN | 비음악 제안에 대한 확인 응답은 모델에 위임 |
| D-P3a | P3 | `packages/vibe-container/src/clientComManager` | `parentOrigin` 기본값이 `'*'`이고 `event.source === parent`를 검사하지 않음(런타임 미사용, L-P3a와 동일) | OPEN | origin을 명시하고 source 검사 추가 |
| D-P3b | P3 | `src/lib/aoiTurnUnderstanding.ts:362` | `refers_to_turn` 상한이 실제로 보여준 줄 수가 아니라 `DEFAULT_RECENT_TURNS_IN_PROMPT` | OPEN | `countAoiTurnLines(recentTurnsBlock)` 사용 |
| D-P3c | P3 | `src/components/Shell/index.tsx:410` | Kira 토스트가 앱 18에 `OPEN_APP`을 보내 "unknown action_type" 응답 | OPEN | 그 호출을 없애거나 OS `FOCUS_APP` 사용 |
| D-P3d | P3 | `chatTokenControl.hasRegistryAppMention` | 짧은 한국어 별칭(리더, 정원, 프로세스)이 일반 단어 안에서 매칭되어 앱 도구를 과하게 켬(토큰 낭비) | OPEN | 단어 경계나 최소 길이 조건 추가 |
| D-P3e | P3 | `aoiLiveFieldTruthPrompt.formatTimestamp` | 범위 밖 유한값에서 `toISOString`이 throw할 수 있음(가드 없음) | OPEN | persona bridge와 같은 범위 가드 추가 |

### E1 — ChatPanel/index.tsx 1–8,800행

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| E1-B1 | high | `ChatPanel/index.tsx:3123-3150, 2307-2321, 2269-2288, 2236-2250` (호출 7117-7202, 7546-7573) | 정규식 "앱 열기" fast path가 일반 메시지를 가로채 앱을 열고 LLM에는 넘기지 않으며, 디스패치 결과도 확인하지 않음 | FIXED (#14) | — |
| E1-B2 | high | `ChatPanel/index.tsx:2149-2167` (호출 7095-7115) | `extractNameMemory`가 "I'm tired" 같은 말을 이름 사실(importance 0.95)로 저장. 한국어 패턴은 `\b` 때문에 매칭 불가 | FIXED (#14) | — |
| E1-B3 | medium | `ChatPanel/index.tsx:4179-4209, 3852-3866`, `chatHistoryStorage.ts`, `sessionDataServer.ts:94-134` | history 로드 실패를 "기록 없음"으로 취급해 프롤로그를 시드하고, autosave가 chat.json을 덮어씀 | FIXED (#12) | — |
| E1-B4 | medium | `ChatPanel/index.tsx:6268-6319, 6381-6384` | 수동 턴이 도는 중에 앱 안 사용자 액션이 두 번째 대화를 시작(Stop 불가, 스피너와 툴 칩 혼선) | OPEN | `processActionQueue`에서 `manualConversationTurnInFlightRef`를 보고 조기 반환, `handleSend`의 finally에서 큐 드레인 |
| E1-B5 | medium | `ChatPanel/index.tsx:4128-4314, 3855-3861, 12563-12566, 13529-13539` | 턴 도중 캐릭터나 모드를 바꾸면 이전 세션의 응답이 새 세션의 transcript, chat.json, 메모리에 기록 | PARTIAL (#12) | autosave 경로는 예약 시점에 캡처됨. 남은 것: 세션 전환 때 진행 중 턴 abort와 `actionQueueRef` 비우기, run 세션이 다른 emit 폐기(또는 loading 중 전환 막기) |
| E1-B6 | medium | `ChatPanel/index.tsx:6867-6871, 6950-6956, 3852-3866` | 이미지 첨부(base64)가 두 곳에 중복 저장되고, 바뀔 때마다 history 전체를 POST해 용량 증가와 UI 끊김 | OPEN | 첨부는 메타데이터만 저장하거나 별도 파일로 분리해 참조. 턴이 끝나면 `chatHistory`에서 dataUrl 제거 |
| E1-B7 | medium | `ChatPanel/index.tsx:3939-3966, 4018-4098, 8653-8665` | 세션 전환 때 relationship 관련 ref를 초기화하지 않아 새 캐릭터가 이전 세션의 관계 상태로 인사 | OPEN | sessionPath effect에서 관련 ref 6개를 리셋하고, 캐시 promise에 path를 저장해 다른 path의 결과는 무시 |
| E1-B8 | low | `ChatPanel/index.tsx:4586-4606` vs `8120-8134` | Stop 뒤 다시 보낸 메시지가 중단된 run이 끝날 때까지 조용히 무시됨 | OPEN | 수동 턴마다 토큰을 두고, 취소 때 토큰을 올리고 플래그를 해제. finally에서는 토큰이 같을 때만 해제. 또는 "Stopping…" 표시 |
| E1-B9 | low | `ChatPanel/index.tsx:4905-4962` | `refreshAoiAutonomy`가 진행 중일 때 들어온 요청을 버리고 세션도 확인하지 않아, 해제한 제안이 다시 나타나거나 이전 세션 대시보드가 표시됨 | OPEN | 진행 중 요청이 있으면 끝난 뒤 한 번 더 실행하고, 세션이 다른 결과는 폐기 |
| E1-B10 | low | `ChatPanel/index.tsx:6862-6878, 6958-6959` | `executeSend`가 await 전에 찍은 스냅샷으로 history를 다시 만들어, 그 사이 추가된 assistant 메시지를 잃음 | OPEN | await 뒤 `chatHistoryRef.current` 기준 함수형 업데이트로 추가 |
| E1-B11 | low | `ChatPanel/index.tsx:6950-6956, 6986-6998, 7016-7021` | 같은 ms의 user 메시지와 직접 응답이 같은 id(`String(Date.now())`)를 가져 React key가 중복되고 복원 병합에서 하나가 빠짐 [LIKELY] | OPEN (미확인) | 카운터 접미사나 `crypto.randomUUID()`로 고유 id |
| E1-B12 | low | `ChatPanel/index.tsx:6268-6319, 8349, 11583` | `processActionQueue`가 첫 렌더의 `runConversation`을 붙잡아 앱 이벤트 턴이 오래된 governor 블록을 사용 | OPEN | governor를 ref로 읽거나 `runConversationRef.current`로 호출 |
| E1-P1a | P1 | `src/lib/vibeContainerMock.ts:240-272` | `dispatchAgentAction` 몽키패치가 겹쳐 두 번째 디스패치가 timeout(D-B1과 동일) [LIKELY] | FIXED (#16) | — |
| E1-P1b | P1 | ChatPanel 의도 헬퍼(B1/B2) | 의도 헬퍼를 `src/lib`로 옮기고, 라벨 코퍼스로 테스트하고, 모호한 문장은 분류기로 보내라는 제안 | PARTIAL (#14) | `src/lib/chatDirectOpenIntents.ts`로 이동하고 단위 테스트까지 완료. 남은 것: 라벨 코퍼스 기반 회귀 테스트, 모호한 문장의 분류기 라우팅 |
| E1-P1c | P1 | ChatPanel (B4/B5/B10) | 세션별 턴 코디네이터(mutex나 큐)가 없어 수동 턴, 액션 큐, nudge, 리마인더, Kira 알림이 동시에 실행 | OPEN | 세션 단위 단일 턴 큐 도입 |
| E1-P2a | P2 | `ChatPanel/index.tsx:2970-3015` | 캘린더 이벤트를 30초마다 제한 없는 `Promise.all`로 읽고, `node.path`가 아닌 `/events/${event.id}.json`에 되써 파일 중복과 반복 리마인드 | OPEN | `batchConcurrent` 사용, `node.path`에 쓰기 |
| E1-P2b | P2 | `ChatPanel/index.tsx:7325, 7441, 7487, 7548` | 직접 경로가 스피너 없이 최대 20초 디스패치나 분류기를 기다림 | OPEN | 첫 await에서 로딩 상태 시작 |
| E1-P2c | P2 | `ChatPanel/index.tsx:1044-1108, 6036, 6065, 6089, 6111-6133` | 하드코딩된 한국어 ack가 `responseLanguageMode`를 무시 | OPEN | 응답 언어 설정에 따른 i18n |
| E1-P2d | P2 | `ChatPanel/index.tsx` 전체 | 21k줄 컴포넌트에서 `runConversation`이 40개 넘는 mirror ref에 의존 | OPEN | `runConversation`을 입력이 명시된 hook이나 모듈로 분리 |
| E1-P3a | P3 | `ChatPanel/index.tsx:2081, 2133` | `buildChatCancelledAck`, `buildDefaultImagePrompt`가 `navigator.language` 사용(규칙 위반) | OPEN | 대화 언어나 systemSettings 사용 |
| E1-P3b | P3 | `ChatPanel/index.tsx:3341-3349` (`CharacterAvatar.handleMediaReady`) | state updater 안에서 정리 없이 `setTimeout`(StrictMode에서 2회). 300ms 안에 감정이 돌아오면 레이어 유실 | OPEN | updater 밖 effect로 옮기고 cleanup 추가 |
| E1-P3c | P3 | `ChatPanel/index.tsx:3423` | 렌더 중에 `setSessionPath` 호출 | OPEN | effect로 이동 |
| E1-P3d | P3 | `ChatPanel/index.tsx:4428` | model-usage effect deps에 baseUrl, apiKey가 빠져 엔드포인트나 키만 바꾸면 재확인 안 함 | OPEN | deps 추가 |
| E1-P3e | P3 | `ChatPanel/index.tsx:5516-5559` | follow-up context Map이 삽입 순서로 퇴출하고, 같은 키를 다시 넣어도 갱신되지 않음 | OPEN | set 전에 delete해 LRU처럼 갱신 |

### E2 — ChatPanel/index.tsx 8,800행~끝, 형제 패널

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| E2-B1 | high | `ChatPanel/index.tsx:9798-9817` | `respond_to_user` 자동 검증이 system 메시지만 붙여 tool_call에 tool 결과가 없음. 다음 요청이 400으로 실패하고, 진단이 throw하면 run이 중단 | FIXED (#15) | — |
| E2-B2 | medium (allowlist에 인터프리터나 셸이 있으면 high) | `ChatPanel/index.tsx:13217-13221` | 호스트 프로세스 실행 승인 팝업이 인자를 200자에서 잘라 뒤쪽 위험 인자를 숨김 | FIXED (#8) | — |
| E2-B3 | medium | `ChatPanel/AoiHostBridgeSettingsPanel.tsx:244-274` | Host PC 설정을 열 때마다 운영자가 철회한 세션 동의를 다시 부여하고 `lastReviewedAt`도 거짓으로 기록 | FIXED (#10) | — |
| E2-B4 | medium | `ChatPanel/index.tsx:13506-13523`, `src/lib/llmClient.ts:236-243, 119-124` | 설정 저장 실패를 삼켜 성공처럼 보이고, 다음 메시지에서 이전 설정으로 돌아감 [LIKELY] | OPEN (미확인) | API가 오류로 답하면 rethrow하고, onSave에서 await한 뒤 실패하면 모달을 열어둔 채 오류 표시 |
| E2-B5 | medium | `ChatPanel/index.tsx:13516`, `src/lib/imageGenClient.ts:49-76` | 이미지 생성 API 키를 비워도 localStorage에 남아 리로드 후 다시 쓰임 | FIXED (#18) | — |
| E2-B6 | medium | `ChatPanel/index.tsx:14485-14491` vs `21187-21194` | Codex Auth 대화 모델이 설정을 다시 열면 "Disabled"로 보이고, 다음 저장에서 삭제 | FIXED (#18) | — |
| E2-B7 | medium | `ChatPanel/index.tsx:10871-10893` | `desktop_capture` 스크린샷 user 메시지가 배치의 tool 결과 사이에 끼어 순서가 깨지고 요청이 거부됨 [LIKELY] | OPEN (미확인) | 이미지 메시지를 모았다가 배치의 마지막 tool 결과 뒤에 추가 |
| E2-B8 | medium | `ChatPanel/ModPanel.tsx:239` (262, 279, 219-221) | 모듈 레벨 `nextTargetId = 100`이 로드마다 리셋되어 target ID가 중복되고 스토리가 영구 정지 | FIXED (#18) | — |
| E2-B9 | low-medium | `AoiAutonomyCapabilityPanel.tsx:95-120, 198-222`, `src/lib/aoiAutonomyCapabilityPanelModel.ts:109-120`, `AoiMemoryMaintenancePanel.tsx:76-102` | 스위치 하나를 바꾸면 env에서 온 값(웹훅 URL 포함)까지 config.json에 고정 저장(G2-B3과 동일) | OPEN | 바뀐 필드만 전송. env에서 온 웹훅 URL은 프리필도 저장도 하지 않음 |
| E2-B10 | low | `ChatPanel/index.tsx:18137-18152`, `src/lib/aoiAutonomyMode.ts:74-82` | Autonomy 모드 드롭다운이 await 뒤 클릭 시점의 패널 설정 전체를 병합해 감사 이벤트를 잃음 [LIKELY] | OPEN (미확인) | `onUpdateAoiAutonomyPanelSettings({ notificationsEnabled: mode !== 'off' })`처럼 바뀐 필드만 |
| E2-B11 | low | `ChatPanel/index.tsx:18491-18505` | "Max suggestions" 옵션이 [0,1,2,3,5]뿐이라 실제 상한이 4나 6~12면 0으로 표시 | OPEN | 0..12를 제공하거나 현재 값을 항상 포함 |
| E2-B12 | low | `ChatPanel/index.tsx:15407-15417` (호출 20377-20436) | 메모리 인스펙터 버튼이 실패하면 catch 없이 unhandled rejection만 나고 사용자에게 아무것도 안 보임 | OPEN | catch해서 인라인 오류 표시 |
| E2-P1a | P1 | `ChatPanel/index.tsx:15419-15467` | main/dialog/classifier/image provider를 바꿔도 예전 API 키가 남아 새 provider 엔드포인트로 전송 | OPEN | Kira 역할 변경처럼 provider가 바뀌면 키를 비우거나 경고 |
| E2-P1b | P1 | `ChatPanel/index.tsx:18563-18640, 19740-19800` | 승인함과 제안 카드가 Approve 버튼 옆에서 `exactNextAction`/`boundary`를 220~260자로 자름 | OPEN | 승인 전에 전체 텍스트 표시(E2-B2와 같은 원칙) |
| E2-P2a | P2 | `src/lib/configPersistence.ts:436-513` | 모듈 하나뿐인 `lastKnownConfigEtag`를 동시 RMW 저장들이 공유해 다른 사이클의 ETag로 덮어쓰기 가능 | OPEN | 읽기마다 ETag를 넘기거나 쓰기 직렬화 |
| E2-P2b | P2 | `ChatPanel/index.tsx:16601-16626`, `AoiMcpConnectorsSettings.tsx:52-69` | 임베딩 설정 on-blur 저장과 MCP 토글 즉시 저장이 큐 없이 순서가 뒤바뀌고, Cancel로 되돌릴 수 없음 | OPEN | 저장을 큐잉·직렬화하거나 모달 Save 시점으로 모음 |
| E2-P2c | P2 | `ChatPanel/index.tsx:9478-9778` vs `9782-11208` | `runConversation`의 병렬·순차 툴 분기가 따로 있어 어긋남(병렬 경로는 `latestDiagnosticsParams`와 ledger 기록 누락) | OPEN | 단일 dispatch table로 통합 |
| E2-P2d | P2 | `ChatPanel/index.tsx:16723-16726`, `llmClient.ts:250-255` | 대화 API 키 placeholder는 "비우면 main 키 사용"이라 하지만 provider가 같을 때만 그렇게 동작 | OPEN | 문구 수정 또는 동작을 문구에 맞춤 |
| E2-P2e | P2 | `ChatPanel/index.tsx:6029-6038` | 실행 팝업의 Deny/Close가 로컬 상태만 지우고 서버 승인은 pending으로 남아 Approvals에서 승인 가능 | OPEN | Deny 때 서버 승인 요청도 거절 처리 |
| E2-P3a | P3 | `AoiHostBridgeSettingsPanel.tsx:534-537, 79-82` | Host Access 헤더는 모든 기능이 기본 꺼짐이라 하지만 `os_computer_use`는 기본 켜짐 | OPEN | 문구나 기본값 정정 |
| E2-P3b | P3 | `AoiSituationPanel`, `AoiRelationshipHistoryPanel`, Host 패널 `loadAll` | 세션 변경이나 언마운트 때 abort가 없어 이전 세션 데이터가 새 화면을 덮음 | OPEN | `AoiNonVoiceScorecardPanel.tsx:72-78`의 AbortController 패턴 적용 |
| E2-P3c | P3 | `ChatPanel/ModPanel.tsx:295-298` | 모드 편집기 "Done"이 단계를 지운 뒤에도 진행도를 유지해 `current_stage_index`가 `stage_count`를 넘음 | OPEN | 진행도 clamp |
| E2-P3d | P3 | `CharacterPanel.tsx:166-178`, `src/lib/characterManager.ts:353-364` | 캐릭터 편집기가 `emotion_images`를 첫 비디오 URL로 채워 저장하고, 비디오가 있으면 그 필드 편집이 효과 없음 | OPEN | 프리필 제거, 또는 비디오 우선 규칙을 UI에 표시 |
| E2-P3e | P3 | `ChatPanel/index.tsx` (`SettingsModal`) | `SettingsModal`이 약 7,200줄에 props 100개 이상 | OPEN | 탭·섹션별 memo 컴포넌트로 분리 |

### F1 — kiraAutomationPlugin.ts 1–11,400행

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| F1-B1 | high | `kira:1986-1992, 5500-5507, 6591-6614, 6956-6973` | safe command 필터가 `$( )`, 백틱, 개행을 막지 않아 읽기 전용 에이전트도 임의 명령 실행 가능 | FIXED (#5) | — |
| F1-B2 | high | `kira:3774-3781, 5689-5698, 5745-5751, 5843-5860, 6477-6512, 6524-6552` | 보호·계획보호·dirty 경로 가드가 해석 전 경로 문자열을 검사해 `src/../.git/config`, 절대경로, Windows 별칭으로 우회 | FIXED (#5) | — |
| F1-B3 | high | `kira:3846-3851` (재시작 22023) | `isAbortError`가 메시지에 "aborted"가 들어가면 취소로 보고 작업을 무한 재시작 | FIXED (#5) | — |
| F1-B4 | medium-high | `kira:1980-1981` | safe 목록의 `git branch -D/-f`, `git diff/log --output`, `rg --pre`로 브랜치 삭제, 임의 파일 쓰기, 프로그램 실행 | FIXED (#5) | — |
| F1-B5 | medium | `kira:6548` (6953) | `edit_file`과 remoteCommand의 `String.replace`가 `$'`, `$&`, `$$` 같은 패턴을 해석해 파일 손상 | FIXED (#5) | — |
| F1-B6 | medium | `kira:10556-10566` | `tests/` 디렉터리만 있으면 기본 검증에 `python -m pytest`를 넣어 TS 레포 검증이 매번 실패 | FIXED (#5) | — |
| F1-B7 | medium | `kira:1739-1740, 5537-5544` | env 노출 가드의 단어 경계 정규식이 경로 토큰(`src/env.ts`, `.env.example`)에도 걸려 정상 검증 명령을 차단 | FIXED (#5) | — |
| F1-B8 | medium | `kira:20317-20375, 22019-22021, 4328-4341` | 시작할 수 없는 작업(LLM 없음, 루트 없음)을 10초마다 재시도하며 매번 댓글과 이벤트를 추가하고 큐가 끝없이 커짐 | OPEN | 그 분기에서 work를 `blocked`로 바꾸거나 backoff 마커를 남기고, 이벤트 큐 길이에 상한 |
| F1-B9 | medium | `kira:6975-6995, 7063, 6827-6851, 7178-7190` | Windows codex-cli가 `shell:true`로 인자를 인용 없이 cmd.exe에 넘김(공백 경로 분리, `R&D` 폴더로 명령 실행). stdin EPIPE를 처리하지 않아 서버가 죽을 수 있음(이 부분 LIKELY) | OPEN | cmd용 인자 escape, 또는 `.cmd` shim을 찾아 `shell:false`로 실행. `child.stdin.on('error')` 추가 |
| F1-B10 | medium | `kira:1735, 9354-9380`, `vite.config.ts:4385` | 런타임 검증 프로브가 OpenRoom 자신의 포트 3000을 사용자 프로젝트의 증거로 기록 | OPEN | 호스트 포트 제외, 설정된 dev URL 우선, 페이지 정체 확인 |
| F1-B11 | medium | `kira:6465-6476, 6368-6417, 5745-5751` | `read_file`, `search_files`, `list_files`가 protectedPaths를 무시해 `.env` 비밀이 LLM으로 넘어감 [LIKELY] | OPEN (미확인) | `secretsPolicy`가 `unrestricted`가 아니면 보호 경로 읽기·검색을 거부하고 순회에서도 제외 |
| F1-B12 | medium-low | `kira:7361-7368` (5486, 6511-6512, 6542, 8780, 15254) | `executeTool` 예외(경로 이탈, EISDIR/EINVAL 등)가 try/catch 없이 시도 전체를 중단 | PARTIAL (#5) | `executeTool`이 경로를 먼저 정규화해 루트 이탈 경로는 이제 `error:` 결과로 반환. 남은 것: `runToolAgent`에서 AbortError가 아닌 모든 예외(fs 오류, `isHighRiskFile` 등)를 `error:` 툴 결과로 변환 |
| F1-B13 | medium-low | `kira:4352-4389` | 세션 탐색이 10초마다 Kira worktree 전체를 `readdirSync`로 동기 순회 | OPEN | `apps/kira/data`에서 내려가지 않거나 worktrees/attempts/reviews/comments/analysis 제외 |
| F1-B14 | low-medium | `kira:5072-5099` (`res.text()` 5174, 5285, 5401) | LLM timeout과 취소가 응답 본문 읽기를 덮지 않아, 느린 본문이 모델 라우트 슬롯을 붙잡음 [LIKELY] | OPEN (미확인) | `fetchLlmWithTimeout` 안에서 본문까지 읽어 텍스트로 반환 |
| F1-B15 | low | `kira:2504, 2517-2519, 2469-2475` | 사용자 정책 규칙이 같은 인덱스의 기본 규칙 필드를 물려받아 의도대로 매칭되지 않음 | OPEN | id가 같을 때만 fallback을 쓰고, 그 밖에는 빈 목록 기본값 |
| F1-B16 | low | `kira:7905-7910; 10010-10015; 9597-9605, 10082-10090` | 학습·분류 로직 오류 4건: (a) 빈 배열 `every`로 docs-maintainer 오분류 (b) decay가 업데이트 횟수만큼 복리 적용 (c) staleScore 하한 0.1로 새 클러스터가 바로 퇴출 (d) 학습이 곧 지워질 worktree에 기록(d는 LIKELY) | OPEN | (a) `files.length > 0 &&` 추가 (b) 기본 점수를 저장하고 읽을 때 decay (c) 하한을 낮추거나 `lastSeenAt` 기준으로 노화 (d) `primaryProjectRoot` 전달 |
| F1-B17 | low | `kira:6316; 6933-6938` vs `6961-6966; 6953` | `isHighRiskFile`이 basename을 `\\`로만 잘라 POSIX에서 작동 안 함. win32 WSL 모드에서도 PowerShell 인용을 써 따옴표 유실 | OPEN | `path.basename` 사용, 대상 셸에 맞춰 인용 방식 선택 |
| F1-P1a | P1 | `kira:7306` (`runToolAgent`) | 툴 호출 턴 수 상한과 전체 마감 시간이 없어, 루프에 빠진 모델은 컨텍스트 초과나 abort로만 끝남 | OPEN | 턴 상한과 전체 deadline 추가 |
| F1-P1b | P1 | `kira:6853-6872, 5745` | (LEDGER F1-P1) codex-cli/claude-cli에 실행 정책이 적용되지 않음(claude는 `bypassPermissions`). `before_integration`이 changedFiles의 protectedPaths를 무시 | OPEN | CLI 워커에도 정책 적용, 최종 diff에 보호 경로 검사 |
| F1-P2a | P2 | `kira:3914, 14033` | `git worktree prune`과 고아 정리가 없어 실패한 `remove --force`(Windows 파일 잠금)의 잔재가 영구히 남음 | OPEN | 시작 때 prune하고 고아 `worktrees/*` 정리(F2-B9와 연계) |
| F1-P2b | P2 | `kira:3880` (`writeJsonFile`) | 이벤트 큐, 프로필, works를 비원자적으로 써서 부분 읽기 때 `[]`가 되고 큐 전체를 덮어씀 | OPEN | temp에 쓰고 rename |
| F1-P2c | P2 | `kira:7088` (`runShellCommand`), `6917-6921` | stdin을 열린 파이프로 둬 프롬프트를 띄우는 도구가 90초 멈추고, POSIX kill은 SIGTERM만 보내고 SIGKILL로 올리지 않음 | OPEN | `stdio: ['ignore','pipe','pipe']`, SIGKILL 단계 추가 |
| F1-P2d | P2 | `kira:2232-2250` | Anthropic 토큰 사용량이 캐시 읽기·생성을 빼고 계산해 provider끼리 수치가 다름(테스트가 현재 동작을 고정) | OPEN | 캐시 토큰 포함 기준으로 통일하고 테스트 갱신 |
| F1-P2e | P2 | `kira:8103-8258, 10824` | 이벤트 루프에서 무거운 동기 FS 작업(시드마다 300~400개 파일 읽기), `spawnSync` 3회 | OPEN | 비동기화나 캐싱 |
| F1-P3a | P3 | `kira:2593, 6666` | 구현자 기본 툴 범위에 없는 `list_files`/`search_files`를 모델에 그대로 보여줌 | OPEN | 범위 안의 툴만 광고 |
| F1-P3b | P3 | `kira:10831` | `runGitCommandSync`가 `-c safe.directory=<root>`로 git의 저장소 소유권 보호를 우회 | OPEN | 그 옵션을 빼거나 꼭 필요한 경우로 한정 |
| F1-P3c | P3 | `kira:9845, 10336` | 컨텍스트 스캔마다 사용자 메인 체크아웃의 `.kira/project-profile.json`을 다시 씀 | OPEN | 바뀌었을 때만 쓰거나 세션 데이터로 이동 |
| F1-P3d | P3 | `kira:5528-5536` | localhost 검사가 `http://localhost.evil.com`과 localhost·공용 URL이 섞인 명령을 통과시킴 | OPEN | URL을 파싱해 hostname을 정확히 비교하고 명령 속 모든 URL 검사 |
| F1-P3e | P3 | `kira:6397-6400` | 디렉터리 순회가 심링크를 파일로 취급해 루트 밖 내용을 돌려줄 수 있음 | OPEN | lstat 또는 realpath 격리 |
| F1-XR1 | 미기재(교차참조) | `kira:22378, 22477` (HTTP 핸들러) | 요청 본문의 검증 안 된 `workId`로 `join(..., WORKS_DIR_NAME, workId + '.json')` 경로를 만들어 경로 순회 읽기 가능(F1 커버리지 노트, F2 보고서에는 없음) | OPEN | `workId`를 안전한 id 패턴으로 검증하거나 `sanitizeIdPart` 후 루트 격리 확인 |

### F2 — kiraAutomationPlugin.ts 11,400행~끝, Kira 앱·문서

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| F2-B1 | high | `kira:20835-20852, 21579-21589, 21680` | 단일 워커 격리 모드에서 재시도하면 마지막 사이클 파일만 커밋되고, 앞 사이클 편집은 리뷰도 없이 삭제 | OPEN | 격리 모드에서는 base 대비 worktree 전체 delta를 리뷰·커밋하거나, 사이클 누적 변경 파일을 리뷰어와 커밋에 사용 |
| F2-B2 | high | `kira:16638-16641, 16685-16691, 21671-21680, 20123-20197` | 통합이 "skipped"면 작업을 done 처리하고 worktree를 강제 삭제해 승인된 변경 유실 | FIXED (#5) | — |
| F2-B3 | high | `kira:19654-19710, 20399-20447, 10195` | 자동 분해가 자식 작업을 다시 쪼갬(4→16→64→80, 작업 164개 생성) | FIXED (#5) | — |
| F2-B4 | high | `kira:17233-17250` | `cherry-pick --no-commit` 충돌 때 `--abort`가 아무것도 안 해 사용자 메인 체크아웃에 충돌 마커가 남음 | FIXED (#5) | — |
| F2-B5 | medium | `kira:13102-13116` (19836, 20640) | 운영자 steering이 리뷰·검증 피드백 슬롯(12개)을 차지하고, 새 steering은 빠지며 오래된 것은 계속 재주입 | OPEN | 아직 소비되지 않은 최신 steering만 4개 안팎으로 쓰고, 리뷰 피드백용 슬롯을 따로 확보 |
| F2-B6 | medium | `kira:13914-13951` (16672, 17182, 14747-14760) | porcelain v1(`-z` 없음)의 C-인용 경로를 그대로 써 공백·비ASCII 파일의 스테이징과 통합이 실패 | OPEN | `status --porcelain=v1 -z`, `ls-files -z`로 NUL 구분 파싱(rename 쌍 포함) |
| F2-B7 | medium | `kira:11610-11620` | discovery 검증 정규식이 `.tsx`, `.jsx`, `.json`, `.mdx` 경로를 잘라 유효한 발견이 차단됨 | FIXED (#5) | — |
| F2-B8 | medium | 취소 핸들러 `kira:22508-22520` vs `21366, 21357-21362, 21842-21847` | 운영자 interrupt 뒤에도 실행 중인 job이 상태를 덮어써 `in_review`로 굳거나 재시작됨 [LIKELY] | OPEN (미확인) | 모든 상태 쓰기 직전에 `throwIfCanceled`/`signal.aborted` 확인, 운영자가 정한 `blocked`에서 다른 상태로의 전이 거부 |
| F2-B9 | medium | `kira:20513-20581, 21126-21212, 21298-21355, 21479-21525, 21782-21877, 19840-19857` | 성공 외 모든 경로에서 Kira worktree와 `codex/kira-*` 브랜치가 남고 prune도 없음 | OPEN | try/finally로 정리(복구할 승인 작업이 있는 worktree만 남기고 경로 기록), 시작 때 sweeper(prune과 고아 브랜치 삭제) |
| F2-B10 | medium | `kira:22015-22017, 18479-18515, 18471-18477` | 10초마다 스캔하며 done 작업마다 모든 댓글을 다시 읽고 락 파일을 만들었다 지움 | OPEN | 백필을 한 번만 하게(플래그나 updatedAt 캐시), taskId별 댓글 인덱스 |
| F2-B11 | low/medium | `kira:20639, 20692, 19849` | 재시도하면 attempt 번호가 1부터 다시 시작해 이전 실행의 attempt·review 기록을 덮어씀 | OPEN | 기존 최대 attemptNo + 1부터 번호 부여 |
| F2-B12 | low/medium | `kira:14373-14388` | `git diff --check`가 문제를 찾아 0이 아닌 코드로 끝나면 catch에서 무시되어 보고되지 않음 | FIXED (#5) | — |
| F2-B13 | low/medium | `kira:16990-17014` | 기존 PR이 있으면 push 전에 `continue`해 새 커밋이 PR에 올라가지 않음 [LIKELY] | OPEN (미확인) | 먼저 fast-forward push, 그다음 기존 PR을 재사용하고 새 SHA로 체크 수집 |
| F2-B14 | low | `kira:16703-16704, 16762, 16786-16796` | 격리 통합 뒤 worktree 쪽 커밋 해시를 기록하지만, cherry-pick으로 생긴 메인 쪽 커밋 해시와 다름 | OPEN | cherry-pick 뒤 `primaryRoot`에서 `rev-parse HEAD` 기록 |
| F2-B15 | low/medium | `src/lib/aoiKiraOutcomeLearning.ts:357-383, 443-456` | 워커 툴 명령 실패를 검증 실패로 집계해 성공 신호를 잃음 | OPEN | `validationReruns`만 사용 |
| F2-B16 | low | `src/pages/Kira/index.tsx:1836, 2030, 2063` | 에이전트 액션 핸들러가 `reportAction`을 불러 이벤트가 중복됨(data-interaction §2.2 위반) | OPEN | `fromAgent` 플래그로 `reportAction` 생략 |
| F2-P1a | P1 | `kira:22064-22573` (HTTP 라우트) | (LEDGER F2-P1) Origin/Host, content-type, 본문 크기 검사가 없어 교차 사이트 text/plain POST로 discovery LLM 비용, create-tasks, 스캔을 유발 | PARTIAL (#1) | 교차 출처·Host 검사는 `devApiRequestGuard`로 해결. 남은 것: 본문 크기 상한(413)과 `application/json` 요구 |
| F2-P1b | P1 | `kira:16708-16727, 17196-17214` | 통합 락이 경합하면 바로 실패해 동시에 끝난 작업 하나가 차단됨(문서는 "직렬화"라고 함) | OPEN | 제한된 대기·재시도 추가 |
| F2-P2a | P2 | `shouldUseKiraAttemptWorktrees` vs `createKiraWorktreeSession` | git 레포 안에 중첩된 프로젝트에서 porcelain 경로(레포 루트 기준)와 툴 경로(프로젝트 기준)가 어긋남 | OPEN | `--show-prefix`로 정규화하거나 그 구성을 막음 |
| F2-P2b | P2 | `kira:14815, 14854` | `collectReviewerDiffExcerpts`/`collectGitDiffStats`가 index 대비 diff라 워커가 stage한 변경이 안 보임 | OPEN | `git diff HEAD` 사용 |
| F2-P2c | P2 | `kira:9354-9380` | 런타임 검증이 OpenRoom 호스트를 포함해 아무 localhost 포트나 프로브(F1-B10과 동일) | OPEN | F1-B10과 같은 조치 |
| F2-P2d | P2 | 멀티 워커 `--no-commit` 통합 | 성공해도 변경이 사용자 index에 stage된 채 남아 이후 모든 통합이 "이미 staged" 때문에 차단 | OPEN | 적용 뒤 unstage |
| F2-P2e | P2 | `src/pages/Kira/index.tsx:3066-3082`, `updateWork` | UI가 오래된 status/clarification을 포함한 work 전체를 저장하고, 서버 RMW는 동기화도 원자성도 없어 업데이트 유실 | OPEN | 필드 단위 patch 또는 mtime/version 검사 |
| F2-P2f | P2 | `src/lib/aoiKiraHandoff.ts:185-196` | 기본 모듈에 늘 "Kira workflow"가 들어가 모든 handoff 브리프에 무관한 검증·모듈 힌트가 붙음 | OPEN | 기본 모듈을 조건부로 포함 |
| F2-P3a | P3 | Kira 계획 문서, `kira-remaining-work-items.md`, Kira `guide.md:507`과 폴더 트리 | 문서 드리프트 4건: "남은 것" 목록에 이미 구현된 항목, cherry-pick 충돌을 "차단"한다는 주장(F2-B4와 모순), 금지된 승인 override 설명, 폴더 트리의 attempts/reviews/worktrees 누락 | PARTIAL (#5) | cherry-pick 문구는 F2-B4 수정(`reset --merge` 롤백)으로 코드와 맞게 됨(재확인 권장). 남은 것: 나머지 3건 문서 갱신 |
| F2-P3b | P3 | DAG/policy optional validation | 검증이 optional이면 effectiveCommands가 비어 코드 변경을 승인할 수 없음 | OPEN | 문서화하거나 명시적으로 허용 |
| F2-P3c | P3 | `kira:15456-15488` (`extractChangedDiffLines`) | `--`로 시작하는 삭제 줄, `++`로 시작하는 추가 줄, `\ No newline` 줄이 줄 위치 계산을 흐트러뜨림 | OPEN | hunk 헤더 기반 파싱 |
| F2-P3d | P3 | 실행 중 작업 삭제 | 취소가 협조적이라 UI에서 지운 뒤에도 job이 댓글과 attempt를 써서 고아 데이터와 worktree가 남음 | OPEN | 삭제 전 job 종료를 기다리거나, 지워진 work에 대한 쓰기 거부 |

### G1 — autonomy runtime core

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| G1-B1 | high | `src/lib/aoiAutonomyStore.ts:286-300` (사용 :2881, :1470, :848) | `listJsonFiles`가 정렬 전에 가장 오래된 200개만 남겨 최신 결정, 리플렉션, 디스패치가 보이지 않음(제안이 영구 차단되고 안전 보정이 fail-open) | FIXED (#13) | — (보존 정리는 G1-P2b) |
| G1-B2 | high | `aoiAutonomyPlugin.ts:1698-1720, 611`, `aoiAutonomyScheduler.ts:368-373, 1901-1921, 2051, 1323` | `/wakeup` 본문이 네트워크 hard-off, `policy.allowNetwork`, 예산 상한을 모두 무시(0은 무제한)하고, `llmConfig`/baseUrl을 클라이언트가 지정해 메모리 등을 외부로 보냄 | PARTIAL (#9) | network 교집합, 0 이하 예산 제거, network 허용 때만 llmConfig는 반영됨. 남은 것: 기본값보다 큰 일일 예산이 그대로 통과(`resolveAoiLlmTokenCeiling`에 상한 없음)하니 env·기본값으로 `Math.min` 클램프. `llmConfig`는 서버의 `loadAoiMainLlmConfig`로 로드하고 본문 값 무시 |
| G1-B3 | high | `aoiAutonomyPlugin.ts:246-274`, `/policy` :2147, `/wakeup` :1680, `/proposal/decision`·`/execute` :3417/:3549 | 변경 라우트에 `/capabilities`가 가진 교차 출처 가드가 없어 웹페이지가 policy를 L5로 올리는 등 조작 가능 [LIKELY] | FIXED (#1, #4) | — |
| G1-B4 | medium | `aoiAutonomyBackgroundRunner.ts:279-281, 291-295` | 실행 중 interval tick이 `inFlight`를 resolved promise로 덮어 `stop()`이 사이클 도중 락을 놓음 | FIXED (#17) | — |
| G1-B5 | medium | `aoiAutonomyLoopLock.ts:92-104, 326-331` | 재사용된 PID(자기 PID 포함)를 살아 있는 락 보유자로 판단해 루프가 시작되지 않음 [LIKELY] | OPEN (미확인) | 자기 PID인데 인스턴스를 모르면 stale로 처리, heartbeat(mtime) 기반 stale 판정 추가 |
| G1-B6 | medium | `aoiAutonomyLoopLock.ts:337-356`, `aoiAutonomyPlugin.ts:3757` | stale 락 회수 경쟁으로 소유자가 둘 생기고, 사이클은 소유권을 다시 확인하지 않음 [LIKELY] | OPEN (미확인) | 매 사이클 시작 때 `loopLock.isOwner()` 확인, rename 기반 원자적 회수 |
| G1-B7 | medium | `aoiAutonomyEngine.ts:3150-3186`, `aoiAutonomyScheduler.ts:2186-2199, 2086-2114, 2143`, `aoiAutonomyStore.ts:1370, 1402-1437` | timeout된 tick과 wakeup이 lease와 계정을 놓은 뒤에도 계속 실행(스카우트 횟수 미집계, 수동 wakeup은 cooldown 0) [LIKELY] | OPEN (미확인) | 내부 promise가 끝날 때 lease 해제와 `activeTickId` 확인, 스카우트·실행 전에 `guard.cancelled` 확인, 스카우트를 돌리는 즉시 횟수 저장 |
| G1-B8 | medium | `aoiAutonomyExecution.ts:1495-1520, 2105-2115`, `aoiApprovedAppActionRunner.ts:145-158` | 차단된 app_action이나 connector_call이 "executed"로 기록됨 | OPEN | `!ok`이면 file 분기처럼 `blocked`와 차단 사유로 전이 |
| G1-B9 | medium | `aoiAutonomyStore.ts:1235-1262` (`aoiAutonomyPlugin.ts:836`의 본문 `now`) | 미래 날짜 관측 하나가 90일 보존 기준을 밀어 모든 관측을 삭제 [LIKELY] | OPEN (미확인) | 서버 `Date.now()` 기준으로 보존, 미래 createdAt은 무시하거나 clamp, HTTP `now` 수용 중단 |
| G1-B10 | low | `aoiAutonomyEngine.ts:2474, 2664` | 예외가 난 reflection LLM 호출이 예산에 잡히지 않음 | OPEN | try/finally로 실패해도 추정 비용 기록 |
| G1-B11 | low | `aoiAutonomyMission.ts:713-726`, `aoiAutonomyPlugin.ts:1602` | 미션 block/complete/clear 결정이 다음 derive(GET `/mission`)에서 원복 [LIKELY] | OPEN (미확인) | `paused`처럼 사용자가 정한 상태 보존 |
| G1-P1a | P1 | `aoiAutonomyPlugin.ts:1590, 1624, 1725` | GET `/mission`, `/workspace`, `/proactive-briefs`가 데이터를 써서 "조회 라우트는 무해하다"는 락 전제를 깸 | OPEN | 읽기 전용으로 변경 |
| G1-P1b | P1 | `aoiAutonomyLevelPromotionRunner.ts:237` | `AOI_AUTONOMY_AUTO_PROMOTE`를 끄면 평가 전에 반환해 자동 부여된 레벨(최대 L4)이 영구히 남음 | OPEN | 플래그가 꺼질 때 한 번 `baselineLevel`로 복귀 |
| G1-P2a | P2 | `aoiAutonomyScheduler.ts:948` | `nextAllowedWakeupAt`을 계산만 하고 강제하지 않음 | OPEN | 강제 적용하거나 주석 수정 |
| G1-P2b | P2 | `aoiAutonomyStore.ts` | 리플렉션, 결정, 디스패치가 끝없이 쌓이고, status를 만들 때마다 디렉터리 전체를 나열 | OPEN | 보존 정리(retention pruning)와 인덱스·캐시 |
| G1-P2c | P2 | `aoiAutonomousExecuteLoop.ts:30` | "세션 예산" 3이 wakeup 단위이고 저장되지 않음 | OPEN | 일일 상한을 저장하거나 이름 변경 |
| G1-P2d | P2 | `aoiAutonomyScheduler.ts:437` | 스카우트 일일 상한은 UTC 날짜, quiet window는 로컬 시간이라 KST에서는 09시에 리셋 | OPEN | 로컬 날짜로 통일 |
| G1-P2e | P2 | `aoiAutonomyLlmBudget.ts:98` | `windowStartedAt`이 미래(시계 역행)면 창이 넘어가지 않음 | OPEN | `now`로 clamp |
| G1-P2f | P2 | `aoiAutonomyPlugin.ts:3288` | `/tick`이 `maxRuntimeMs`를 clamp하지 않아(1e400이면 Infinity로 timeout 무력화) `llmConfig`도 네트워크 게이트 없이 받음 | OPEN | 범위 clamp, `/wakeup`과 같은 네트워크 게이트 |
| G1-P3a | P3 | `aoiAutonomyPlugin.ts:3642` | 템플릿 리터럴 안의 raw NUL 바이트 때문에 ripgrep이 파일을 바이너리로 보고 검색에서 빠짐 | FIXED (diff) | — |
| G1-P3b | P3 | `aoiDaemonServer.ts:115` | 데몬 POST `/shutdown`에 origin 검사가 없어 교차 사이트 DoS 가능 | FIXED (#1) | — |

### G2 — autonomy client/UI, goals, governance

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| G2-B1 | medium | `aoiAutonomyGoals.ts:1151-1163, 1277-1325`, `aoiAutonomyEngine.ts:1179, 3385-3399` | 사용자 메시지로 만든 목표의 placeholder ref 때문에 모든 채팅 메시지가 목표 진행(또는 차단)으로 처리됨 | FIXED (#17) | — |
| G2-B2 | medium | `aoiAutonomyGoals.ts:1046-1055` | 같은 placeholder ref 때문에 두 번째 사용자 목표가 첫 목표의 중복으로 처리됨 | FIXED (#17) | — |
| G2-B3 | medium | `aoiAutonomyCapabilityPanelModel.ts:109-120`, `AoiAutonomyCapabilityPanel.tsx:106, 192-219` | capability 토글 하나를 저장하면 env·default에서 온 값까지 config.json에 고정(E2-B9와 동일) | OPEN | 바뀐 필드만 전송(`buildAoiAutonomyCapabilityBody(prev, next)`) |
| G2-B4 | low-medium | `aoiJarvisAutonomyGovernor.ts:2150-2161, 1973-1985` | governor 감사 기록이 이전 결정으로 돌아온 것을 기록하지 않아 무기한 "stale"로 표시되고 그 문구가 프롬프트에 주입 | OPEN | `events[0]`이 같을 때만 그대로 두고, 아니면 같은 키의 이전 항목을 지운 뒤 맨 앞에 추가 |
| G2-B5 | low | `aoiActionLadder.ts:453-474` (784-797) | app_action, connector_call, file_* 의 L5 실행을 prepare band로 판정해 UI의 Execute 버튼 상태와 어긋남 | OPEN | 이 kind들을 `'app_action'`으로 매핑 |
| G2-B6 | low | `aoiSafeActionPlan.ts:720` (850-864) | save_memory의 명시적 빈 검증 목록이 기본 `pnpm test` 명령으로 바뀜 | FIXED (#17) | — |
| G2-B7 | low | `aoiAutonomyUi.ts:3592` | 이미 보여준 최상위 nudge 하나가 세션 내내 다른 nudge를 모두 막음 | OPEN | 우선순위 순 후보 가운데 아직 안 보여준 첫 항목 반환 |
| G2-B8 | low | `aoiJarvisReadinessScorecard.ts:1994-2007, 867-873` | 승인 우회와 stale source honesty 게이트가 hard safety block 목록에 없음(설계 문서와 불일치) | OPEN | 두 gate ID를 두 목록에 모두 추가 |
| G2-B9 | low | `aoiAutonomyClient.ts:2006-2009` | 수동 tick 실패 때 서버 사유(`warnings[]`)가 숨겨지고 일반 문구만 표시 | OPEN | `payload.warnings[0]`으로 fallback |
| G2-P1a | P1 | `aoiAutonomyClient.ts` (모든 fetch) | timeout과 AbortSignal이 없어 요청이 멈추면 refresh 락이 영영 풀리지 않음 | OPEN | 호출마다 `AbortSignal.timeout` |
| G2-P1b | P1 | `aoiAutonomyClient.ts:1861-1925` | 대시보드가 18-way `Promise.all`이라 섹션 하나만 실패해도 스냅샷 전체를 버림 | OPEN | 핵심이 아닌 섹션은 `allSettled` |
| G2-P2a | P2 | `aoiSafeActionPlan.ts:730-785` | app_action, connector_call, open_app용 builder가 없어 preview가 늘 차단되고 변경 여부도 잘못 판단 | OPEN | 해당 kind의 builder 추가 |
| G2-P2b | P2 | 설계 문서(executable actions 526-536, acceptAction 285) | 문서 드리프트: 없는 `open_artifact`, Kira 작업 생성 레벨(문서 L4, 코드 L1/L2) | OPEN | 문서 갱신 |
| G2-P2c | P2 | `aoiAutonomyGoals.ts:836`, `aoiAutonomyRelations.ts:805` | 관계 그래프에서 plan-step ref 하나가 노드 3개로 갈라지고, 노드·엣지 상한이 따로라 끊긴 엣지가 남음 | OPEN | 노드 kind 통일, 상한 적용 뒤 엣지 정리 |
| G2-P3a | P3 | `aoiCapabilityRegistry.ts:1856-1884` | `inferRequestedBrokerBand`의 `\b`가 첫·끝 대안에만 걸리고 metadata 검사가 먼저 돌아 `delete_account`가 metadata_only가 됨 | OPEN | 대안을 그룹으로 묶어 양쪽 `\b` 적용, execute 검사 먼저 |
| G2-P3b | P3 | `aoiJarvisAutonomyGovernor.ts:1850-1869` | dedupe key를 800자에서 잘라 뒤쪽 필드(plan, evidence) 변경을 놓침 | OPEN | 해시 기반 키 |
| G2-P3c | P3 | `aoiJarvisAutonomyGovernor.ts:1587-1593` | 요청 시나리오를 부분 문자열로 매칭("digital"의 git, "explanation"의 plan)해 오탐이 프롬프트에 주입 | OPEN | 단어 경계 매칭 |
| G2-P3d | P3 | `aoiJarvisAcceptanceTrial.ts:858, 993, 1244` | `mutation.*_zero` 지표가 `passed: true`로 하드코딩되어 통과율을 부풀림 | OPEN | 실제 측정값 사용 |
| G2-P3e | P3 | `aoiBoundedWorkOrder.ts:430-442` | `buildScopeHash`가 입력 배열을 제자리 정렬해 UI 표시 순서가 바뀜 | OPEN | 복사본을 정렬 |
| G2-P3f | P3 | `aoiAutonomyGoals.ts:381` | LLM이 제안한 plan step의 done-criteria는 공백만 정리(제목은 redaction과 지시 제거를 거침) | OPEN | 같은 sanitize 적용 |
| G2-P3g | P3 | readiness scorecard | 같은 신호를 다른 ID·그룹(field.* 와 shadow.*/safety.*)으로 두 번 세어 가중치가 이중 | OPEN | 중복 제거 |

### H1 — proactive + research

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| H1-B1 | high | `aoiResearchEngine.ts:1613-1629` (1647, 1869-1886), `aoiProactiveBriefResearch.ts:170-180` | IPv4-mapped IPv6 리터럴(`[::ffff:127.0.0.1]`)로 소스·리다이렉트 URL의 SSRF 필터를 우회 | FIXED (#3) | — |
| H1-B2 | medium | `aoiResearchEngine.ts:1642-1645, 1687-1699, 1860` | DNS 검증과 실제 연결이 따로 lookup해 리바인딩 TOCTOU [LIKELY] | OPEN (미확인) | 검증한 IP로 고정하는 undici `Agent`(`connect.lookup`), 리다이렉트마다 재검증 |
| H1-B3 | high | `aoiResearchPlugin.ts:130-158, 531-605, 745-764, 61-65` | research 라우트가 교차 사이트 text/plain 요청을 받고, Vite host check보다 먼저 실행되며, `serverOrigin`을 Host 헤더로 만듦 | PARTIAL (#1, #4) | 교차 출처와 DNS 리바인딩은 공용 가드로, LAN 노출은 `127.0.0.1` 기본 바인딩으로 해소. 남은 것: `serverOrigin`을 Host/`X-Forwarded-Proto` 대신 `server.httpServer.address()`에서 취득(가드가 IP 리터럴 Host를 허용하므로 `OPENROOM_DEV_HOST` opt-in 때 LAN 클라이언트가 CLI provider 호출 대상을 바꿀 수 있음) |
| H1-B4 | medium | `aoiProactivePushDelivery.ts:130-136`, `aoiAutonomyScheduler.ts:1587-1610`, `aoiProactiveTrendAdvisor.ts:2548, 2696-2699` | 스카우트 wakeup마다 이미 전달한 카드를 push로 다시 보냄(최대 14일) | OPEN | append 때 같은 id의 `consumedAt`을 유지하거나 건너뜀, 이번 wakeup에 만든 카드만 push, 예산 차감 |
| H1-B5 | medium | `aoiProactiveTrendAdvisor.ts:1692-1696` | too_frequent/wrong_timing 피드백 한 건이 기간 제한 없이 trend direct-chat 준비를 영구 차단 | OPEN | `createdAt >= now - window`(24~72시간)로 필터 |
| H1-B6 | medium | `aoiProactiveBriefStore.ts:2527-2539` | 재스카우트가 사용자가 dismiss, archive, unsafe 처리한 브리프를 되살림 | FIXED (#17) | — |
| H1-B7 | medium | `aoiProactiveTrendAdvisor.ts:986-1001, 1247-1255`, `aoiAutonomyPlugin.ts:518-527` | 브리프 GET이 스냅샷을 다시 만들어 저장하면서 자기 자신과 매칭해 direct_chat 카드를 dashboard로 강등 [LIKELY] | OPEN (미확인) | 전달 이벤트가 없으면 같은 id·candidateId 스냅샷은 제외, GET은 `persist:false`로 저장본만 읽기 |
| H1-B8 | medium-low | `aoiResearchPlugin.ts:241-243, 297-321, 507-513` | 재시작으로 고아가 된 run이 queued/running에 영구히 남아 새 시작은 429, 삭제는 409 | OPEN | 프로세스 안에 live run 집합을 두고, live가 아니거나 오래된 active manifest는 `interrupted`로 실패 처리 |
| H1-B9 | low-medium | `aoiResearchEngine.ts:2080-2091, 2134-2161, 2192-2207` | 취소가 프로세스 로컬이라 다른 프로세스에서 한 취소가 `running`으로 덮어써짐 [LIKELY] | OPEN (미확인) | `ensureNotCancelled`에서 디스크 상태를 다시 읽고, 종료 상태를 낮추지 않음 |
| H1-B10 | low-medium | `aoiProactivePushTransport.ts:62-86`, `aoiAutonomyScheduler.ts:1587, 1619-1635` | push 웹훅에 timeout이 없고 wakeup 안에서 await해 wakeup이 실패하고 예산이 집계되지 않음 | OPEN | 전송마다 `AbortSignal.timeout`(약 5초), 예산 저장을 push보다 먼저, 또는 비차단 전송 |
| H1-B11 | low | `aoiResearchEngine.ts:1454-1481` (1510, 1804-1840) | fetch timeout이 응답 헤더까지만 적용되어 느린 본문이 슬롯과 run을 몇 시간씩 붙잡음 | OPEN | 본문을 다 읽을 때까지 abort 타이머 유지, run deadline 전달 |
| H1-B12 | low | `aoiProactiveBriefPlanner.ts:211-224, 352-367`, `aoiProactiveTrendAdvisor.ts:617-621` | 토픽 pin이나 unmute가 최근 mute·부정 피드백에 밀려 7~30일 동안 무시됨 | OPEN | 같은 토픽의 최신 긍정·pin보다 오래된 부정·mute는 무시 |
| H1-P1a | P1 | `aoiResearchTools.ts:304-319`, evidence/plan/rewrite 프롬프트 | 프롬프트 주입 표면: 원문 페이지 블록과 근거를 그대로 툴 결과와 프롬프트에 넣음 | OPEN | 비신뢰 데이터로 감싸고 `stripAoiSourceInstructions` 적용, 프롬프트 안에서 구분자로 격리 |
| H1-P2a | P2 | `aoiResearchEngine.ts:354-370` | research 산출물을 비원자적으로 써 찢어진 manifest면 run이 사라지고 삭제도 불가 | OPEN | tmp+rename |
| H1-P2b | P2 | `aoiProactiveBriefStore.ts:2338-2345` | 필드 이벤트마다 최대 500개 파일을 다시 읽고 지표를 다시 써 wakeup당 O(N²) | OPEN | 지표 재계산을 배치로 |
| H1-P2c | P2 | trend snapshot, brief candidate, feedback 파일 | 인덱스에서 빠지거나 만료된 뒤에도 파일이 지워지지 않아 끝없이 쌓임 | OPEN | 만료·이탈 파일 정리 |
| H1-P2d | P2 | `aoiProactiveBriefScout.ts:736-750`, `aoiProactiveBriefPolicy.ts:211-228` | 스카우트 생성 cooldown과 전달 정책이 키를 공유해 새 브리프가 바로 전달 억제됨 | OPEN | 키 분리 |
| H1-P3a | P3 | `runAoiProactiveResearchRoutine` :454 | `now` 기본값이 고정값 `1_800_000_000_000`(2027년) | OPEN | 기본값을 `Date.now()`로 |
| H1-P3b | P3 | `checkAoiScoutNetworkBudget` :80 | `windowStartedAt > now`면 창이 넘어가지 않음 | OPEN | 미래 시작은 리셋으로 처리 |
| H1-P3c | P3 | scheduler :1621-1631 | 네트워크 예산을 성공 건만 차감해 실패나 429 검색은 무료 | OPEN | 시도 기준으로 차감 |
| H1-P3d | P3 | `aoiProactiveBriefResearch.ts:386-418` | "독립 소스"를 호스트가 아닌 URL 수로 세어 같은 사이트끼리 "교차 확인"으로 표시 | OPEN | 호스트 기준 집계 |
| H1-P3e | P3 | store :215-221 (`normalizeText`) | 경로 redaction이 `/home/`, `/var/`, `/tmp/`, `/workspace/`가 든 URL을 망가뜨려 소스가 빠짐 | OPEN | URL은 redaction에서 제외 |
| H1-P3f | P3 | scout :250-253 | 호스트 mute가 서브도메인을 포함하지 않음 | OPEN | 접미사 매칭 |
| H1-P3g | P3 | `aoiResearchPlugin` `/start`, quiet window | HTTP `/start`가 `persistResearchRunObservation`을 건너뜀. quiet window의 start === end가 "항상 조용"이라는 점이 문서에 없음 | OPEN | 관측 기록 추가, 동작 문서화 |

### H2 — memory, preferences, relationship, voice

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| H2-B1 | high | `aoiMemoryShared.ts:288-305, 272-282` (`aoiMemoryManager.ts:611-622`, `aoiMemoryServerWriter.ts:282-293`) | 선호 near-duplicate 판정이 무관한 영어 선호(Radiohead/Coldplay, FPS/RTS)를 병합해 새 선호를 잃음 | OPEN | 문자 집합 비교는 띄어쓰기 없는 한글·CJK에만 쓰거나 char-bigram Dice로 교체, 토큰 경로는 filler 단어 차이만 허용 |
| H2-B2 | high | `aoiMemoryManager.ts:738, 583-592, 671-693`, `aoiMemoryServerWriter.ts:240-249` | "I'm"/"I am" 휴리스틱이 가짜 이름 사실을 만들어 실제 이름을 supersede하고, "Git user name" 사실도 이름을 supersede | FIXED (#14) | — |
| H2-B3 | high | `aoiMemoryManager.ts:1580-1590` (`ChatPanel/index.tsx:8274-8283`) | recall 사용량 기록이 턴 시작 때의 스냅샷으로 메모리 파일을 통째로 덮어써 supersede와 삭제를 되돌림 | OPEN | 쓰기 직전에 다시 읽어 없거나 비활성이면 건너뛰고 `lastAccessedAt`/`recallHits`만 patch(또는 서버 PATCH·ETag) |
| H2-B4 | medium | `aoiMemoryServerWriter.ts:581-616, 802-824` | 서버 임베딩 backfill이 await 전 스냅샷을 써서 archive, delete, 정정을 되돌림 | OPEN | 임베딩 뒤 다시 읽고, 없거나 비활성이거나 내용이 바뀌었으면 건너뜀 |
| H2-B5 | medium | `aoiMemoryServerWriter.ts:714-730`, `aoiMemoryDecay.ts:140-155`, `aoiAutonomyPlugin.ts:2550-2563` | decay apply가 후보를 다시 고르지 않아 미리보기 뒤 pin된(영구) 메모리를 archive하고, 클라이언트가 임의 id를 archive 가능 | OPEN | 서버에서 후보를 다시 계산해 fingerprint가 다르면 409, `permanent` 메모리 제외 |
| H2-B6 | medium | `aoiMemoryConsolidation.ts:88-99, 145-237`, `aoiLocalEmbeddingCore.ts:30-49` | consolidation이 극성·충돌 검사 없이 cosine만으로 묶어 더 새로운 반대 메모리를 supersede [LIKELY] | OPEN (미확인) | 반대 극성이나 충돌 키 쌍은 제외, 사실·선호는 최신을 canonical로, `user-correction` 태그 제외 |
| H2-B7 | medium | `aoiPreferencePoll.ts:1277-1279, 1397-1426`, `aoiPreferenceQuestionGen.ts:416, 626`, `aoiMemoryManager.ts:533-543` | 생성 질문의 태그가 48자 상한을 넘어 재응답이 유실되고 Clear가 효과 없으며, 앞 18자가 같은 라벨끼리 섞임 | OPEN | 생성 키 길이 제한(예: `gen.depth.${fnv1a(label)}`) 또는 `tastePrefTag`에도 같은 정규화 |
| H2-B8 | medium | `aoiPreferencePoll.ts:1386-1410`, `aoiMemoryShared.ts:248-255` | 다른 세션에서 투표 답을 바꾸면 이전 세션 메모리에 병합되고 새 답을 잃음 | OPEN | `pref:taste.*`의 supersede와 forget을 전역으로 |
| H2-B9 | medium | `aoiMemoryServerWriter.ts:127-139, 162-214` (`aoiResearchPlugin.ts:202`) | 웹에서 온 research 결과가 지시 제거 없이 영구(permanent) 프롬프트 메모리가 됨 | OPEN | findings와 title에 `stripAoiSourceInstructions` 적용, 자동 생성 research 메모리의 permanent 재검토 |
| H2-B10 | medium | `aoiMemoryServerWriter.ts:588-592`, `aoiMemoryEmbeddingStatus.ts:34-39`, `aoiMemoryEmbedding.ts:178-180` | 임베딩 모델을 바꿔도 기존 메모리를 다시 임베딩하지 않고, 상태 패널은 100%로 표시 | OPEN | `embeddingModel !== provider.model`이면 pending으로 보고 집계 |
| H2-B11 | medium | `sessionDataServer.ts:132-134` | 브라우저 메모리 쓰기가 비원자적이라 잘린 JSON으로 메모리가 사라짐 | FIXED (#12) | — |
| H2-B12 | low/medium | `aoiInterestProfile.ts:488-497, 534-553` | 영어 부정 선호("not interested in crypto", "dislikes horror movies")가 긍정 관심 토픽이 됨 [LIKELY] | OPEN (미확인) | 부정·싫어함 패턴이면 phrase와 entity seed 제외 |
| H2-B13 | low/medium | `aoiTts.ts:40, 203-207, 210-242` | TTS 캐시에 상한이 없고 object URL을 해제하지 않아 renderer 메모리가 계속 증가 | OPEN | 재생 중인 URL을 뺀 LRU와 `revokeObjectURL` |
| H2-P1a | P1 | `/api/session-data` | 메모리 파일용 필드 병합 PATCH나 ETag/If-Match가 없어 B3/B4 같은 lost update가 생김 | OPEN | PATCH나 ETag를 도입하고 모든 writer가 거치게 |
| H2-P2a | P2 | `aoiMemoryShared.ts:228-241` | 극성 검사가 부분 문자열("dislike" 안의 "like")이라 같은 싫어함의 재진술이 병합되지 않음 | OPEN | 단어 토큰으로 비교 |
| H2-P2b | P2 | `aoiSelfProfile.ts:586-626` | 증류된 persona 지시까지 포함한 agent-scope 메모리 전체를 "Explored by you"로 제시 | OPEN | research 메모리로 한정 |
| H2-P2c | P2 | `aoiMemoryManager.ts:1226-1236` | `loadAoiMemories`가 제한 없는 `Promise.all`이고 턴마다 2~3번 실행 | OPEN | `batchConcurrent`, 호출 횟수 축소 |
| H2-P2d | P2 | `aoiMemoryManager.ts:502-512` | `writeJson`이 `res.ok`를 무시해 실패도 성공으로 반환 | OPEN | `res.ok`를 확인하고 오류 전파 |
| H2-P2e | P2 | `aoiMemoryManager.ts:813-829` | always, never, 항상, 절대가 들어간 메시지는 질문이어도 절차 메모리가 됨 | OPEN | 질문은 제외하고 명령형 조건 추가 |
| H2-P2f | P2 | `aoiPreferenceMemory.ts:179-209` | 부분 문자열 키 정규식(latest의 test, digital의 git, milestone의 tone)이 무관한 선호를 합치고 가짜 "Conflict:" 줄을 만들며, 이미 고른 메모리를 반복 | OPEN | 단어 경계 정규식, 선택된 메모리와의 중복 제거 |
| H2-P3a | P3 | `aoiMemoryManager.ts:737` | 한국어 "나는 X야" 이름 패턴이 `\b` 때문에 죽은 코드 | FIXED (#14) | — (패턴을 지우고 명시적 표현 전용 `extractStatedUserName`으로 교체) |
| H2-P3b | P3 | `aoiMissionMemoryStore.ts:63`, `aoiTrustCalibrationStore.ts:106`, `aoiMemoryIndex.ts:156` | 비원자적 쓰기가 남아 있음 | OPEN | temp+rename |
| H2-P3c | P3 | `aoiRelationshipState.ts:173-218` | 마일스톤 20개 상한 때문에 오래된 것이 밀려나고, 다시 유도하면 "새로 달성"으로 보고 | OPEN | 달성 이력을 따로 보존 |
| H2-P3d | P3 | `aoiMoodState.ts:169` | `mood in MOOD_EXPRESSION`이 프로토타입 키를 받아들이고 `reasons`를 검증하지 않음 | OPEN | own-property 검사, reasons 검증 |
| H2-P3e | P3 | `docs/aoi-persistent-memory-design.md`, `aoiMemoryDecayPanelModel.ts:5-7` | 설계 문서에 임베딩, recall, decay, consolidation, index, ledger가 없고, 주석이 fingerprint가 막아주는 범위를 과장 | OPEN | 문서와 주석 갱신 |

### I — field·operator·acceptance 하네스와 CLI

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| I-B1 | high | `.github/workflows/ci.yml:39-41`, `aoiFieldCiGateCliEntry.ts:24`, `aoiFieldCiGate.ts:549-550` | push 이벤트에서 `--base origin/main` diff가 비어 field CI gate가 늘 skip | FIXED (#20) | — |
| I-B2 | medium-high | `aoiFieldCiGate.ts:212-336` | 파일 이름 기반 분류라 pack이 런타임에 쓰는 모듈 약 25개(예: `aoiCapabilityRegistry.ts`)가 바뀌어도 gate를 건너뜀 | OPEN | pack을 항상 돌리고 그 결과로 실패 판정, 분류는 대상 테스트 목록에만 사용(또는 `src/lib/**`의 테스트 아닌 파일 전부를 대상으로) |
| I-B3 | medium | `aoiFieldCiGate.ts:403-442, 566-572`, `ci.yml`, `turbo.json` | gate가 "required" 테스트 명령을 실행하지 않고 PASS를 보고하며, CI에는 vitest 단계가 없음 | OPEN | CI에 대상 또는 전체 vitest 단계 추가, 또는 CLI가 명령을 실행해 종료 코드로 판정(아니면 "suggested"로 이름 변경) |
| I-B4 | medium-low | `aoiFieldCiGateCli.ts:54-68` | `--base=` 빈 값이나 값 누락이면 조용히 빈 diff가 되거나 `HEAD~1`로 fallback | FIXED (#20) | — |
| I-B5 | medium | `aoiOperatorTimeline.ts:484-495, 440-459`, `aoiFieldEvidenceManifest.ts:542-547, 1034-1036` | operator timeline `events.jsonl`이 끝없이 커져 128MiB를 넘으면 real-field 판정이 영구 NOT READY | OPEN | 회전·압축(최신 N개나 보존 기간), 큰 소스는 스트리밍 |
| I-B6 | low | 루트 `package.json`의 `lint`(`--fix`), `ci.yml:28-29` | CI lint가 자동 수정해 실패하지 않음 | FIXED (#20) | — |
| I-B7 | low | `aoiRunLedger.ts:286-293` | 80개로 자른 뒤에는 이벤트 ID가 모두 `-81`로 충돌하고, 지표는 잘린 창 기준이라 줄어듦 | OPEN | 단조 증가 시퀀스 카운터, 지표를 누적 갱신 |
| I-B8 | low | `aoiFieldCiGateCliEntry.ts:24`, `aoiFieldCiGateCli.ts:37-42` | 비ASCII 경로가 C-인용되어 분류에서 빠지고, rename의 이전 경로가 누락 | OPEN | `git -c core.quotePath=false diff --name-only --no-renames -z`로 받아 NUL로 분리 |
| I-B9 | low | `src/lib/__tests__/aoiFieldCiGateCli.test.ts` | "gate required" 테스트가 패키지 상대 경로를 넘겨 실제로는 그 경로를 검증하지 않음 | FIXED (diff) | — |
| I-B10 | low | `aoiNonVoiceClaimCliEntry.ts:10-12`, `aoiControlledRealFileEvidenceCli.ts:9-15`, `aoiControlledRealCognitionEvidenceCli.ts:9-15` | CLI 플래그 파싱이 제각각(`--format=json` 무시, `--flag=value` 미지원) | OPEN | 공용 파서로 통일 |
| I-P1a | P1 | field pack | 고정 합성 시나리오라 실제 회귀 대부분을 잡지 못함. CI에서 vitest를 돌리는 편이 훨씬 효과적 | OPEN | CI에 vitest 추가, pack은 여러 검사 중 하나로 |
| I-P2a | P2 | `aoiFieldGroundedJarvisAcceptancePack.ts:1887`, `aoiNonVoiceJarvisScorecardServer.ts:351, 382, 397-403` | 실패할 수 없는 검사(상수 0 객체에 `.every()`, manifest를 자기 자신과 비교, 중복 제거 뒤 중복 수 계산) | OPEN | 실제 값으로 검사 |
| I-P2b | P2 | `aoiFieldFeedbackLearning.ts:37` | `DEFAULT_FIELD_FEEDBACK_NOW = 1_800_000_000_000`(2027년)이 운영 기본값 | OPEN | 운영 경로에서 `now`를 필수로 |
| I-P2c | P2 | `aoiFieldFeedbackLearning.ts:247-259` | 대안 나열(workspace, git, build, validation 등)을 그룹 없이 `\b`로 감싸 "git", "source"가 아무 단어 안에서나 매칭되어 sourceKind 오분류 | OPEN | 대안을 그룹으로 묶고 양쪽에 `\b` |
| I-P2d | P2 | `aoiFieldEvidenceManifest.ts:227-234` | 합성 마커 부분 문자열로 실제 레코드를 합성으로 판정해 `mixed_evidence_class` hard failure | OPEN | 명시적 `evidenceClass` 필드 사용 |
| I-P2e | P2 | CLI 9개 | 각자 인자 파서를 복사해 `=` 지원, 값 누락 처리, env fallback이 다름 | OPEN | 값 누락 때 오류를 내는 공용 파서 추출(I-B10과 함께) |
| I-P3a | P3 | `aoiFieldEventLedger.ts:772-818` | 읽기 경로가 쓰기를 하고 잘못된 journal에서 throw해 ledger를 못 읽게 됨. 크래시 시 보존 레코드가 사라질 수 있음 | OPEN | 읽기와 복구 분리, 원자적 복구 |
| I-P3b | P3 | `aoiControlledRealCognitionHarness.ts` vs `aoiControlledRealCognitionEvidence.ts` | 하네스와 정규화기의 pass 조건이 달라 FAILED 대신 "Invalid evidence"로 exit 2 | OPEN | pass 조건 단일화 |
| I-P3c | P3 | `aoiMeasuredMemoryRecall.ts:44-52` | archived 메모리의 임베딩이 semantic 경로에 집계됨 | OPEN | archived 제외 |
| I-P3d | P3 | `aoiOutcomeFeedbackServer.ts:108, 175` | 읽기를 500건으로 제한해 오래된 대상이 "write-back 뒤 찾을 수 없음"으로 보고됨 | OPEN | id로 직접 조회하거나 상한 조정 |
| I-P3e | P3 | `nonvoice-claim`, `claim-sweep` 스크립트 | pnpm 워크스페이스에서 `npm run`을 부르고, 다른 CLI는 별도 `:build` 단계가 필요 | OPEN | pnpm으로 통일, 빌드 단계 정리 |
| I-P3f | P3 | 약 15개 파일 | 약 36,000줄 슬라이스에 `uniqueStrings`, `stableId`, `isPathInsideRoot`, `truncateText` 같은 헬퍼가 복제됨 | OPEN | 공용 유틸로 통합 |

### J — reverse-engineering labs, Signal Desk (LEDGER + report-J 일부)

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| J-B1 | high | `src/lib/idaSqlPlugin.ts:1630-1640, 1588-1616`, `src/lib/ghidraLabPlugin.ts:1275-1285, 1227-1255` | 토큰 없는 루프백 요청에 host-bridge 토큰을 빌려줘(`trustLoopbackToken`), 아무 웹페이지나 승인 단계를 포함한 ida-sql/ghidra-lab API를 조작 | FIXED (#1) | — |
| J-B2 | 미기재 | `src/lib/idaPePlugin.ts` (`/api/ida-pe/analyses`, `/functions`) | 인증 없이 임의 절대 `samplePath` 파일을 읽음. 작업 트리 확인 결과 `/analyses`와 `/functions`·함수 상세(headless 백엔드)에 모두 격리 적용, ida-pro-mcp 백엔드는 열린 IDB와 대조만 해서 내용을 돌려주지 않는 의도적 예외 | FIXED (#7) | — |
| J-P2a | P2 | `src/lib/idaMcpHttpClient.ts` | decompile 같은 무거운 호출에도 5초 timeout | OPEN | 호출 종류별로 timeout을 늘리거나 설정 가능하게 |
| J-P2b | P2 | `src/pages/SignalDesk/index.tsx:704` (위치 추정) | SignalDesk `window.open`이 URL 스킴을 검사하지 않음 | OPEN | http/https만 허용 |
| J-P2c | P2 | ghidraLab 플러그인 (위치 미기재) | ghidra 명령 검증기가 어디서도 쓰이지 않는 죽은 코드 | OPEN | 실제 경로에 연결하거나 제거 |
| J-P2d | P2 | `src/lib/ghidraLabRunner.ts` (`runCapa`, 위치 추정) | capa 실행 때 파일 인자 앞에 `--`가 없어 파일명이 옵션으로 해석될 수 있음 | OPEN | 경로 인자 앞에 `--` |
| J-P2e | P2 | `src/lib/ghidraFlossDownload.ts` (위치 추정) | FLOSS 다운로드에 체크섬 검증 없음 | OPEN | 고정 sha256으로 검증 |

### K1 — apps group 1 (Chess, MusicApp, OpenVSCode, Diary, HabitGarden, CyberNews, MissionControl)

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| K1-B1 | high | `src/pages/Chess/index.tsx:209-218` | 폰 공격 방향이 반대라 불법 수를 허용하고 폰 체크를 못 잡음(체크메이트가 스테일메이트로, 캐슬링 검사도 틀림) | FIXED (#18) | — |
| K1-B2 | high | `src/pages/MusicApp/index.tsx:1059-1072, 344-372, 490-497` | 콜드 오픈 OPEN_SEARCH가 기본 상태로 저장해 재생목록, 즐겨찾기, 최근 기록을 지움 | FIXED (#13) | — |
| K1-B3 | high | `src/pages/OpenVSCode/index.tsx:2711-2734, 4562-4567` | Monaco Ctrl+S가 처음 마운트 때의 클로저로 저장해 다른 파일을 예전 내용으로 되돌리고 현재 파일은 저장하지 않음 | OPEN | `saveCurrentFileRef.current`로 호출하거나 `saveCurrentFile`이 `activePathRef`/`openTabsRef`에서 읽게 |
| K1-B4 | high | `src/pages/OpenVSCode/index.tsx:3302-3307, 3511-3514, 1372-1374, 1502` | OPEN_FILE과 SAVE_FILE이 실패해도 `success`를 돌려줘, 다음 REPLACE가 엉뚱한 활성 파일을 덮어씀 | OPEN | `loadFile`/`saveCurrentFile`이 `{ok, error}`를 돌려주게 하고 `error:`로 매핑 |
| K1-B5 | high | `src/pages/Diary/index.tsx:308-319` | `rehype-raw`를 sanitize 없이 써서 `iframe srcdoc` XSS [LIKELY] | FIXED (#11) | — |
| K1-B6 | medium | `src/pages/HabitGarden/index.tsx:473-477`, `repository.ts:157` | SYNC_STATE가 부분 파일에서 동의 스위치를 기본값으로 되돌리고, 에이전트가 동의 값을 바꿀 수 있음 | OPEN | 원본 파싱 결과만 병합, `reflectWeatherInRoom`/`shareMomentumWithAoi`/`restoreRoomItemId`는 무시 |
| K1-B7 | medium | `src/pages/MusicApp/playlistUtils.ts:31-58`, `index.tsx:176-191, 1186-1217` | 항목 하나의 형식이 어긋나면 재생목록 전체가 빠지고 그 상태로 저장되어 영구 손실(도달 가능성 LIKELY) | OPEN | 항목별로 검증하고 선택 필드는 기본값, id 없는 항목만 제거 |
| K1-B8 | medium | `src/pages/OpenVSCode/index.tsx:3481-3483` | PATCH_ACTIVE_FILE이 `new_text`의 `$&`, `$'`, `$$` 같은 패턴을 확장해 디스크에 손상된 내용 저장 | FIXED (#18) | — |
| K1-B9 | medium | `src/pages/HabitGarden/garden.ts:314-323` | 며칠 빠지면 식물이 씨앗으로 돌아감(가이드와 다름) | OPEN | `plantStageForStreak(streak.best)` 같은 누적 지표 사용 |
| K1-B10 | medium | `src/pages/CyberNews/index.tsx:303-313`, `liveNews.ts:139` | 피드의 `sourceUrl`을 검증 없이 href로 써서 `javascript:` 링크 실행 [LIKELY] | FIXED (#11) | — |
| K1-B11 | medium | `src/pages/OpenVSCode/index.tsx:1712-1753, 4453-4458, 3312` | 워크스페이스 루트를 바꾸면 저장 안 한 버퍼를 경고 없이 버림 | OPEN | dirty 탭이면 UI에서 확인받고, 에이전트에는 `error: unsaved changes` |
| K1-B12 | low | `src/pages/OpenVSCode/index.tsx:3596-3611` | 체크포인트 restore/delete가 오래된 목록을 조회해 "not found" | OPEN | 못 찾으면 목록을 새로 읽고 한 번 재시도 |
| K1-B13 | low | `src/pages/HabitGarden/garden.ts:116-121, 164-172` | 주간 습관 활력에 주 단위가 아닌 일 단위 gap을 써서 정상인데도 시든 것으로 표시 | OPEN | 이번 주 목표 달성 여부로 판단 |
| K1-B14 | low | `src/pages/MusicApp/index.tsx:503, 2028-2033` | 에이전트 OPEN_SEARCH가 재생 중인 영상 iframe을 다시 로드하고 멈춤 | OPEN | 선택된 영상의 autoplay 플래그를 고정 |
| K1-B15 | low | `src/pages/MissionControl/index.tsx:208-232`, `types.ts:169` | 세션 목록을 다시 폴링하지 않아 수동 새로고침 전까지 빈 화면 | OPEN | 세션이 고정되지 않았거나 목록이 비면 sessions 폴링 |
| K1-B16 | low | `src/pages/MissionControl/index.tsx:406-425` | SELECT_MISSION_CONTROL_SESSION이 목록이 empty/error일 때 아무 경로나 받아 저장 | OPEN | 목록이 비어 있으면 거부 |
| K1-B17 | low | `src/pages/OpenVSCode/index.tsx:4556` vs `5157` | 하단 패널이 탭이 열려 있을 때만 그려져 터미널, 테스트, 체크포인트 결과가 안 보임 | OPEN | `activeTab` 분기 밖에서 렌더 |
| K1-B18 | low | `src/pages/CyberNews/index.tsx:976-983, 1027-1031`, `src/pages/Diary/index.tsx:1102-1107`, `src/pages/HabitGarden/index.tsx:429-438` | 에이전트 작업이 실행·저장 없이 success 반환(MOVE_CLUE 오래된 cases, 없는 엔트리의 SELECT_ENTRY, `cadence` 없으면 `timesPerWeek` 무시) | OPEN | 새로 읽고 한 번 재시도한 뒤 `error:`, 주간 습관에 `timesPerWeek` 적용 |
| K1-P2a | P2 | `src/pages/MusicApp/index.tsx:499` | `submitSearch`가 에이전트 경로에서도 `reportAction`을 부름(규칙 위반) | OPEN | `fromAgent`면 보고 생략 |
| K1-P2b | P2 | `src/pages/MusicApp/index.tsx:1186` | 키 입력과 상태 변경마다 state.json을 쓰고, SYNC_STATE 전에 에이전트가 쓴 내용을 덮는 것을 막지 않음 | OPEN | debounce, 저장 전에 다시 읽어 병합 |
| K1-P2c | P2 | `src/pages/OpenVSCode/index.tsx` (`applyPatchPreview` 2622, `saveAllFiles` 1536) | 버퍼 경쟁: 미리보기 적용 때 버퍼가 `beforeContent`인지 확인하지 않고, await 뒤의 편집도 저장된 것으로 표시 | OPEN | 적용 전 비교, 실제로 쓴 내용으로 `savedContent` 설정 |
| K1-P2d | P2 | `src/pages/OpenVSCode/index.tsx` | RUN_COMMAND, SEARCH_WORKSPACE가 출력과 매치를 에이전트에 돌려주지 않고, REFRESH_WORKSPACE, RUN_DIAGNOSTICS는 실패를 숨김 | OPEN | 결과를 반환하고 실패는 `error:` |
| K1-P2e | P2 | `src/pages/MissionControl/index.tsx:141-181` (`types.ts:40-43`) | 폴링이 한 번만 실패해도 마지막 정상 데이터가 오류 패널로 바뀜(주석과 다름) | OPEN | 데이터를 유지하고 오류 배지 표시 |
| K1-P2f | P2 | Diary meta | REFRESH, SYNC_STATE 액션이 없어 컬렉션 규칙 미충족 | OPEN | 액션 추가 |
| K1-P3a | P3 | OpenVSCode, HabitGarden, MissionControl meta | meta_cn이 없음(seedMeta는 EN만 시드해 CN은 문서용) | OPEN | CN을 추가하거나 CN 정책 정리 |
| K1-P3b | P3 | `src/pages/HabitGarden/garden.ts:221-231`, `src/lib/habitGardenMomentum.ts:121` | 날씨 비율에서 초과 달성한 주간 습관이 다른 습관의 미달을 가리고, 서버는 중복 체크인을 셈(클라이언트는 중복 제거) | OPEN | 습관별 비율 상한, 서버도 중복 제거 |
| K1-P3c | P3 | `src/pages/HabitGarden/garden.ts:339`, HabitDetail:60 | adherence가 습관 기간을 무시해 3일 된 습관을 매일 해도 약 5%로 표시 | OPEN | 생성일 기준 분모 |
| K1-P3d | P3 | Chess | USER_MOVE 보고 전에 `persist`를 기다리지 않고, state.json이 잘못돼도 AGENT_MOVE가 success | OPEN | await 뒤 보고, 잘못된 상태면 `error:` |
| K1-P3e | P3 | OpenVSCode `loadFile` | 경로를 정규화하지 않아 `./a`와 `a`가 탭 두 개로 열림 | OPEN | 경로 정규화 |
| K1-P3f | P3 | MusicApp `types.ts`, guide | `types.ts`(Song/PlayerState)가 낡았고, guide에 PlaylistItem 필드 타입이 없으며 `/live/` URL을 지원하지 않음 | OPEN | 타입과 가이드 갱신, live URL 지원 |

### K2 — apps group 2 (BrowserReader, EvidenceVault, DriveConsole, Email, Notes, Calendar, Gomoku 외)

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| K2-B1 | high | `src/pages/BrowserReader/index.tsx:377-403, 506-529` | 열린 페이지를 끝없이 다시 요청하고 history 파일을 계속 다시 씀 | FIXED (#18) | — |
| K2-B2 | high | `vite.config.ts:793-804, 857-863` | reader 프록시가 원격 HTML을 앱 origin의 최상위 문서로 제공(CSP sandbox 없음)해 동일 출처 /api와 host-bridge에 닿는 XSS가 되고, LAN SSRF 릴레이로도 쓰임 [LIKELY] | FIXED (#1, #2, #4) | — |
| K2-B3 | high | `src/pages/EvidenceVault/index.tsx:151-153, 169`, `src/components/AppWindow/index.tsx:40-49` | 알 수 없는 category/impact에서 렌더가 throw하고, 오류 경계가 없어 데스크톱 전체가 언마운트 | FIXED (#18) | — (스키마 enum은 K2-P1c) |
| K2-B4 | medium | `src/pages/DriveConsole/types.ts:86-91`, `planDraft.ts:135, 161`, `index.tsx:73` | 필드가 일부만 있는 plan step(SYNC_STATE)에서 렌더 중 `.trim()`이 throw해 UI 전체가 내려가고, 상태가 저장되어 매번 반복 | PARTIAL (#18) | 창별 오류 경계로 피해가 Drive Console 창 안으로 한정됨. 남은 것: `mergeDriveConsoleState`에서 `makeDraftStep()`으로 step을 만들고 필드를 문자열로 강제, 객체가 아닌 항목 제거 |
| K2-B5 | medium | `src/pages/Email/EmailPage.tsx:555, 979-1000` | Gmail 연결에 성공해도 오래된 `runSync` 클로저(`connected=false`) 때문에 동기화가 안 됨 | OPEN | `refreshStatus`가 새 상태를 돌려줘 그걸로 판단하거나, `connected`가 false에서 true로 바뀔 때 effect에서 sync |
| K2-B6 | medium | `src/pages/Notes/index.tsx:251, 331-343`, `src/pages/Calendar/index.tsx:287, 377-392` | 에이전트 refresh가 사용자가 저장하지 않은 노트나 일정 초안을 덮어씀 | OPEN | 미저장 변경이 있으면 폼을 리셋하지 않고, 선택 ID가 실제로 바뀔 때만 다시 채우며, 새 초안 중에는 첫 항목으로 fallback 금지 |
| K2-B7 | medium | `src/pages/Gomoku/index.tsx:759, 839-844` | SURRENDER가 `color`를 무시해 에이전트의 기권이 에이전트 승리로 기록 | FIXED (#18) | — |
| K2-B8 | medium | `AoiMemoryDashboard:462`, `RoomShop:207, 229, 247`, `AoiResearch:212, 360`, `WrittenByMe:55, 61`, `DewdropCanvas:50, 56` (모두 `src/pages/*/index.tsx`) | 에이전트 핸들러가 `reportAction`을 불러 가짜 "사용자 행동" 턴을 만듦 | OPEN | 에이전트 핸들러에서 `fromAgent=true`를 넘겨 보고 생략 |
| K2-B9 | medium | `AoiMemoryDashboard:500-506`, `RoomShop:194-198, 214-218`, `Email/EmailPage.tsx:555, 562-566, 864-871`, `AoiResearch:358`, `WrittenByMe:60`, `DewdropCanvas:55`, `FreeCell:315-338` | no-op이나 실패에도 `success`를 반환(없는 id archive, 연결 끊긴 Gmail, 사용자 제스처 없는 `window.open` 팝업 차단(LIKELY), 잘못된 FreeCell 상태) | OPEN | 없는 id, 미연결, 동기화 실패, 잘못된 상태는 `error:`. 팝업 전용 액션은 사용자 클릭이 필요하다고 보고 |
| K2-B10 | medium | `src/pages/Email/email_en/guide.md:37, 116-122, 136-139`, `email_cn/guide.md:113, 130` | Email guide가 예전 로컬 앱 기준(`/emails/{id}.json` 쓰기, 선언되지 않은 `COMPOSE_EMAIL`)이라 Aoi가 가짜 받은편지함 파일을 만듦 | OPEN | SEND_EMAIL, SAVE_DRAFT 중심으로 다시 쓰고, `emails/`는 에이전트가 쓰면 안 되는 Gmail 캐시라고 명시 |
| K2-B11 | low | `src/pages/Calendar/index.tsx:91-93` (405-408, 485-490, 720-733) | `addDays`가 하루를 고정 24시간으로 계산해 DST 지역에서 주 경계가 틀림(KST는 영향 없음) | OPEN | `d.setDate(d.getDate() + days)` |
| K2-B12 | low | `src/pages/Calendar/index.tsx:535-538, 583-591`, `ChatPanel/index.tsx:3009-3015` | 일정 편집 저장이 `lastReminderSentAt`을 지워 리마인더가 다시 옴 | OPEN | 쓰기 전에 다시 읽어 병합하거나, poller가 REFRESH_EVENTS를 디스패치 |
| K2-B13 | low | Album guide·meta, `Twitter/index.tsx:714-723`, `DriveConsole/components/PlanEditor.tsx:49`, `WrittenByMe:75-78`, `DewdropCanvas:70-73`, `Gomoku:562-586`, `FreeCell:374-386` | 작은 결함 6건: Album 문서의 레거시 `/images` 설명, Twitter CREATE_POST 중복(LIKELY), PlanEditor step ID 중복, CHECK_*_STATUS가 이전 렌더의 오류값 사용, Gomoku `npcName` 고정, FreeCell 로드 실패 시 새 게임으로 덮어쓰기 | OPEN | 항목별 수정: 문서 정정, 중복 방지, 고유 ID, ref 사용, `useCallback` deps, 로드 실패 시 저장 중단과 복구 UI |
| K2-CC1 | 계약 점검 | Email `meta.yaml` vs 핸들러 | DELETE_EMAIL을 처리하지만 선언하지 않아 도달 불가 | OPEN | 선언 추가 또는 case 제거 |
| K2-CC2 | 계약 점검 | AoiResearch `meta.yaml` vs switch | CREATE/DELETE_AOI_RESEARCH_RUN을 선언했지만 switch가 거부 | OPEN | 선언 제거 또는 구현 |
| K2-CC3 | 계약 점검 | Gomoku `meta.yaml` | UNDO_MOVE에 2수 이상 필요하다고 적었지만 코드는 1수도 허용 | OPEN | 문서와 코드 일치 |
| K2-CC4 | 계약 점검 | Calendar, Notes, Gomoku `meta.yaml` | `filePath`를 required로 표시했지만 핸들러가 무시 | OPEN | optional로 바꾸거나 실제로 사용 |
| K2-CC5 | 계약 점검 | EvidenceVault CN meta | CN meta에 액션 선언이 없음(EN만 시드되어 문서용) | OPEN | CN 보완 또는 CN 정책 정리(K2-P3a) |
| K2-P1a | P1 | `src/components/AppWindow/index.tsx:40-49` | 창별 error boundary 추가 | FIXED (#18) | — |
| K2-P1b | P1 | Calendar guide | 예시 `startAt`이 `Z`로 끝나 일정이 UTC 오프셋만큼 밀림 | OPEN | 오프셋이 붙은 로컬 시간(예: `+09:00`)을 쓰라고 안내 |
| K2-P1c | P1 | `src/lib/appDataSchemas.ts`, `src/lib/appSchemaRegistry.ts` | evidence 필드 enum이 없고, Drive Console·Host Sentinel `state.json` 스키마도 없음 | OPEN | enum과 스키마 추가 |
| K2-P2a | P2 | `src/pages/Notes/index.tsx:980` | 마크다운 링크가 앱 전체를 다른 페이지로 이동시킴 | OPEN | AoiResearch처럼 `target=_blank` override |
| K2-P2b | P2 | Email | OAuth 메시지의 출처(`event.source`, origin)를 확인하지 않고, client-secret 입력이 일반 텍스트 필드이며, star 낙관적 업데이트가 실패해도 롤백하지 않음 | OPEN | 출처 검사, password 필드, 실패 시 롤백 |
| K2-P2c | P2 | Notes 검색, Drive Console, Host Sentinel | 키 입력마다 state.json을 쓰고, Host Sentinel은 매 키 입력마다 다시 요청하며 늦게 온 응답이 이김 | OPEN | debounce, 최신 요청 결과만 반영 |
| K2-P2d | P2 | AoiResearch | 알림 전용 액션이 `actions:`에 들어 있고, run이 도는 동안 폴링하지 않음 | OPEN | 액션 목록 정리, 활성 run 폴링 |
| K2-P2e | P2 | BrowserReader | `saveToNotes`, `saveBookmark`에 try/catch가 없고(unhandled rejection), Notes 앱에 알리지 않음 | OPEN | 오류 처리, Notes에 REFRESH 통지 |
| K2-P3a | P3 | CN metas/guides | 시드되지 않는 CN 메타·가이드가 방치됨 | OPEN | 삭제하거나 패리티 테스트 추가 |
| K2-P3b | P3 | AoiMemoryDashboard (`DEFAULT_PROMPT_PROBE` :45) | UI 문자열이 한국어로 하드코딩되고, 개인 닉네임이 들어 있으며, 에피소드를 하나씩 순서대로 조회 | OPEN | i18n, 닉네임 제거, `batchConcurrent` |
| K2-P3c | P3 | WrittenByMe, Dewdrop meta·guide | `F:/kernullist/...` 경로를 하드코딩(플러그인 기본값은 `cwd/written-by-me`) | OPEN | 경로 정정 |
| K2-P3d | P3 | `src/pages/EvidenceVault/index.tsx:430`, Calendar `getLocale` | `files` state 배열을 제자리 정렬하고, `getLocale`이 한국어를 무시 | OPEN | 복사본을 정렬, ko 로케일 추가 |

### L — docs, .claude, CI·설정, e2e, vibe-container, written-by-me, 스크립트

| ID | 심각도 | 위치(file:line) | 내용 | 상태 | 권장 조치 |
|---|---|---|---|---|---|
| L-B1 | high | `turbo.json:6-21`, `package.json:30` | turbo strict env 모드가 `AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK` 등 런타임 env를 지워 네트워크 상한이 fail-open | FIXED (#20) | — |
| L-B2 | high | `written-by-me/server.js:21, 140`, `written-by-me/services/urlFetcher.js:3-21`, `written-by-me/services/ai.js:81, 137`, `src/lib/writtenByMePlugin.ts:978-1003` | written-by-me: CORS가 열려 있고 SSRF가 가능하며, 다른 출처에서 사용자의 LLM 키나 로컬 claude CLI를 쓸 수 있음 | PARTIAL (#20) | cors 제거, `127.0.0.1` 바인딩, urlFetcher 공용 호스트 전용(리다이렉트 재검증, 5MB 상한) 반영됨. 남은 것: 요청 `model` 허용 목록(`ai.js:137`은 `claude-`로 시작하는 모델이면 로컬 claude CLI 실행) |
| L-B3 | medium | `written-by-me/routes/upload.js:107` | 범위 밖 변수를 로그에 써서 ReferenceError가 나고 모든 업로드가 500 | FIXED (#20) | — |
| L-B4 | medium | `written-by-me/server.js:12-16`, `README.md:21-27, 78`, `.env.example:16` | 문서상 키가 필요 없는 Claude CLI 모드도 `OPENAI_API_KEY`가 없으면 시작하자마자 종료 | FIXED (#20) | — |
| L-B5 | medium | `pnpm-workspace.yaml:1-3`, `src/lib/writtenByMePlugin.ts:56-57, 696-716` | `written-by-me`가 워크스페이스 밖이라 mammoth와 pdf-parse가 설치되지 않아 .docx/.pdf를 읽지 못함 | OPEN | `written-by-me`를 워크스페이스에 넣거나 두 의존성을 `apps/webuiapps`에 추가 |
| L-B6 | medium | `.github/workflows/claude-review.yml:38, 49-50` | `$PR_NUMBER`를 설정하지 않고 `gh pr list`의 첫 항목을 써서 다른 PR에 리뷰를 올림 [LIKELY] | FIXED (#20) | — |
| L-B7 | medium | `.github/workflows/ci.yml:28-32`, `package.json:28` | CI가 단위 테스트, 타입체크, e2e를 돌리지 않고 lint는 자동 수정 | PARTIAL (#20) | `lint:ci`(--fix 없음)와 typecheck 단계 추가됨. 남은 것: CI에 `pnpm --filter @openroom/webuiapps test`와 e2e 추가 |
| L-B8 | medium | `README.md:394` (ko:336, zh:186), `ci.yml:23`, `apps/webuiapps/Dockerfile:1` | 문서는 Node 18+, CI와 Docker는 Node 20인데 `undici ^8.7.0`은 Node 22.19 이상 필요 [LIKELY] | PARTIAL (#20) | README 3종 22.19+와 CI Node 22는 반영됨. 남은 것: `apps/webuiapps/Dockerfile`의 `node:20-alpine` 갱신, 루트 `package.json`에 `engines` 추가(또는 `undici@^7` 고정) |
| L-B9 | medium-low | `package.json:27-28, 119-123` | pre-commit lint-staged가 커밋마다 레포 전체에 prettier와 eslint를 실행 | FIXED (#20) | — |
| L-B10 | low-medium | `.claude/commands/import.md:19`, `.gitignore:40` | `/import` 명령이 쓰는 `extract-card.py`가 없고, `.gitignore`의 `scripts/` 때문에 추가해도 무시됨 | OPEN | 스크립트를 추가하고 `!.claude/scripts/` 예외를 두거나, TS `extractCard`(cardExtractor)를 쓰도록 변경 |
| L-B11 | low-medium | `.claude/rules/data-interaction.md` §3.2, §3.4, `.claude/rules/concurrent-execution.md` §4, `.claude/workflow/rules/app-definition.md:40-45` | `.claude` 규칙이 잘못된 저장 경로(`/data/posts/...`)와 batch-write API(`putTextFiles`를 앱 상대 경로로) 안내 | PARTIAL (#20) | data-interaction.md §3.2, §3.4는 수정됨. 남은 것: `app-definition.md` §3 저장 트리의 `data/` 단계 제거, `concurrent-execution.md` §4에 putTextFiles 전체 경로 규칙 명시 |
| L-B12 | low | `src/lib/dewdropCanvasPlugin.ts:14, 1437`, `vite.config.ts:4259`, `README.md:74` | Dewdrop 기본 루트가 `F:/kernullist/dewdrop-canvas`이고 `DEWDROP_CANVAS_ROOT`가 문서화되지 않음(README 표기도 그대로) | OPEN | 변수를 문서화하고 전달, 설정이 없으면 "not configured" 상태 |
| L-B13 | low | `apps/webuiapps/script/generate-aoi-voice-samples.mjs:85-86` | 음성 샘플 스크립트가 `.env.local`만 읽고 README가 안내하는 `.env`는 무시 | OPEN | `.env`를 먼저, 그다음 `.env.local` 읽기 |
| L-B14 | low | `e2e/agent-tools.spec.ts:37-41`, `playwright.config.ts:20, 27` | spec 하나가 병렬 실행 중에 공유 e2e 홈을 초기화(로컬 2 workers에서만 flaky) | OPEN | 별도 project와 `dependencies`로 분리하거나, 리셋 범위를 한 세션으로 |
| L-B15 | low | `.claude/workflow/stages/06-integration.md:103`, `.claude/commands/vibe.md:159`, `app-definition.md:52` | /vibe 스펙 불일치(stage ID 05→06, 생성 단계 수 5→6, §2.6 참조→§2.4) | FIXED (#20) | — |
| L-DD1 | doc drift | `README.md` L59-79, `README_ko.md`, `README_zh.md` | 앱 표에서 등록 앱 9개(Gomoku, Aoi Memory, Mission Control, Habit Garden, Drive Console, Host Sentinel, Signal Desk, IDA Lab, Ghidra Lab)가 빠짐. zh는 Room Shop, Dewdrop Canvas, Written By Me, Aoi Research도 빠짐 | OPEN | README 3종의 앱 표 갱신 |
| L-DD2 | doc drift | `README.md` L75, `README_ko.md` L81 | Written By Me 경로를 `F:/kernullist/written-by-me`로 설명(실제는 레포 안 `written-by-me/`) | FIXED (#20) | — |
| L-DD3 | doc drift | `README.md` L645 (ko, zh), 루트 `package.json` `clean` | `pnpm clean`이 Turborepo 산출물을 지운다고 하지만 `clean` 스크립트를 가진 패키지가 없어 아무것도 안 함 | OPEN | 패키지별 clean 스크립트를 추가하거나 문서 수정 |
| L-DD4 | doc drift | `docs/project-structure.md` L282-297 | 앱을 11개만 나열(실제 29개) | FIXED (#20) | — |
| L-DD5 | doc drift | `CONTRIBUTING.md` L8, L18 | clone URL이 `OpenRoom.git`이고, hook이 lint/format을 "강제"한다는 설명이 L-B9와 맞지 않음 | FIXED (#20) | — |
| L-DD6 | doc drift | `CLAUDE.md` 파일 구조, `src/lib/seedMeta.ts:10-17` | 7개 앱(Album, Chess, Diary, Email, EvidenceVault, FreeCell, Twitter)이 레거시 `<app>_cn/_en` 레이아웃이고, seedMeta는 meta_en만 읽어 모든 단계가 요구하는 CN meta가 쓰이지 않음 | OPEN | CLAUDE.md 구조 설명을 갱신하거나 레이아웃 통일 |
| L-DD7 | doc drift | `.claude/rules/design-tokens.md` vs `.claude/workflow/stages/02-architecture.md:71` | 간격 토큰 값이 다름(md/lg/xl이 12/16/20 vs 16/24/32) | OPEN | 한쪽으로 통일 |
| L-DD8 | doc drift | `meta-yaml.md` vs `06-integration.md`, 레지스트리의 `cyberNews` | `app_name` 표기 규칙이 다름(소문자 vs camelCase) | OPEN | 규칙 통일 |
| L-DD9 | doc drift | `apps/webuiapps/vitest.config.ts:24` | 커버리지 측정 대상이 `src/lib/llmClient.ts` 하나라 CLAUDE.md의 "변경 코드 커버리지 90% 초과"를 확인할 수 없음 | OPEN | coverage include 확대 |
| L-DD10 | doc drift | `apps/webuiapps/README.md:133-135`, `vite.config.ts` 리셋 가드 주석(~4178) | "e2e가 로컬 dev 서버를 재사용한다"는 근거가 e2e를 3100 포트로 옮긴 뒤로 맞지 않음 | OPEN | 주석과 문서 갱신 |
| L-DD11 | doc drift | `post-task-check.md`, `06-integration.md`, `.eslintrc` | exhaustive-deps 경고 수정을 요구하지만 react-hooks가 꺼져 있고 `--quiet`가 경고를 숨김 | OPEN | eslint에서 react-hooks를 켜거나 문서 수정(L-P2b) |
| L-DD12 | doc drift | `SECURITY.md` | "메인테이너에게 이메일"이라고 하지만 주소가 없음 | OPEN | 연락처 추가 |
| L-P1a | P1 | `tsconfig.json`, `tsconfig.node.json` | `tsc -p tsconfig.json`이 `vite.config.ts`(서버 코드 156KB), `e2e/*.ts`, `playwright.config.ts`를 검사하지 않음 | OPEN | typecheck에 tsconfig.node.json을 포함(`-b` 또는 별도 실행), e2e용 tsconfig 추가 |
| L-P1b | P1 | `vite.config.ts` `server.host` | `host:true`가 로컬 파일·명령·설정 미들웨어를 LAN에 노출하고 text/plain CSRF도 가능 | FIXED (#1, #4) | — |
| L-P2a | P2 | `.github/workflows/claude-review.yml` | `show_full_output: true`로 공개 Actions 로그에 툴 출력이 남고, interactive 작업은 Edit/Write를 허용하며, 포크에 없을 `MINIMAX_API_KEY`와 MiniMax base URL에 의존 | OPEN | 출력 비공개, 툴 권한 축소, 시크릿이 없으면 job skip |
| L-P2b | P2 | `.eslintrc` | react-hooks, react, unused-imports, simple-import-sort가 설치만 되고 설정되지 않음 | OPEN | 플러그인 설정 |
| L-P2c | P2 | `e2e/mission-control.spec.ts:83`, `aoi-activity-capture.spec.ts:61`, `aoi-proposal-outcome-signal.spec.ts:89` | 조건부 `test.skip` 때문에 새 홈에서 live-session 경로를 건너뛰고, 부정 assertion이 고정 sleep에 기댐 | OPEN | 세션을 시드하고, 이벤트 기반으로 대기 |
| L-P2d | P2 | `turbo.json` | L-B1 재발 방지용 env 가드 테스트가 없음 | OPEN | `process.env` 읽기를 모아 turbo.json이 덮는지 확인하는 테스트 추가(dev는 loose 모드로 위험 완화됨) |
| L-P3a | P3 | `packages/vibe-container` clientComManager `:35`, `:177` | `parentOrigin` 기본값 `'*'`이고 `event.source`를 검사하지 않음(standalone에서는 미사용, D-P3a와 동일) | OPEN | origin 명시, source 검사 |
| L-P3b | P3 | `written-by-me/public/script.js:101` | `/api/config` 값으로 `<option>`을 `innerHTML`로 만듦 | OPEN | `textContent`나 DOM API 사용 |
| L-P3c | P3 | `.gitignore` | `scripts/`가 모든 깊이의 디렉터리에 걸리고, `docs/*` allowlist에 일부 문서가 빠져 새 문서가 조용히 무시됨 | OPEN | 패턴을 루트에 고정(`/scripts/`), allowlist 갱신 |
| L-P3d | P3 | written-by-me `PORT` | 기본 `PORT=3000`이 dev 서버와 겹침 | OPEN | 다른 기본 포트 |
| L-P3e | P3 | `.claude/rules/data-interaction.md` | readFile 콜아웃 뒤에 남은 코드 펜스가 나머지를 코드 블록으로 만들고, 예시 `action.params.trackId`는 `params`가 optional이라 strict TS에서 실패 | PARTIAL (#20) | 코드 펜스는 제거됨. 남은 것: §2.2 예시를 strict TS에서 컴파일되게(`action.params?.trackId` 등) 수정 |
| L-P3f | P3 | `apps/webuiapps/script/generate-aoi-voice-samples.mjs` | Gemini 호출 하나가 실패하면 `manifest.json`을 쓰기 전에 중단되고, ElevenLabs만 쓸 때도 Gemini 키를 요구 | OPEN | 실패를 격리하고 manifest를 보존, provider별로 키 요구 |
