# Kira 남은 개선 항목

작성일: 2026-05-03

이 문서는 P0/P1/P2 오케스트레이션 계약이 코드에 연결된 뒤 남았던 작업의 마감 기록이다. 2026-05-03
후속 구현에서 아래 항목을 MVP 수준이 아니라 운영 기준으로 닫았다. 현재 구현은 실행 정책, 환경 계약,
서브에이전트 레지스트리, 워크플로 DAG, 플러그인 커넥터, 품질 스냅샷을 Kira 설정, 컨텍스트 스캔, 실제
실행 정책, 환경 준비, worker/reviewer 기록, integration evidence, UI 요약까지 연결한 상태다.

## 완료 상태

- Orchestration contract JSON 편집 UX: 저장 전 parse 차단, 기본값 reset, 저장값 revert, schema chip,
  정규화 preview를 추가했다.
- Orchestration schema validation: UI와 `/api/kira-project-settings` 저장 경로 모두에서 필드별 오류
  path를 반환하고 invalid contract 저장을 차단한다.
- 설정 예제: `docs/config.example.json`에 execution policy, environment, subagents, workflow,
  plugins 예제를 추가했다.
- Environment contract: setup command 실행, required env, runner/network/secret/dev-server command
  정책 검증을 추가했다.
- Policy hooks: `before_tool`, `after_tool`, `before_validation`, `before_integration`,
  `task_completed`를 실제 실행/검증/완료 경로에 연결했다.
- Subagent scheduler: registry의 tool scope, profile, required evidence를 worker lane과 실제 tool
  execution 제한에 반영했다.
- Workflow DAG: design gate, validation 실행 여부, completion guard가 DAG와 execution policy 조합을
  따르도록 했다.
- Diff-aware reviewer: changed-line coverage, line-anchored finding count, worker summary
  contradiction detector를 review record와 UI에 추가했다.
- Failure memory v2: failure cluster, command remediation, stale score decay를 project intelligence
  learning에 저장한다.
- Plugin/GitHub adapter: GitHub connector가 enabled/apply일 때 gh CLI 기반 branch push, draft PR
  creation, check evidence collection을 수행하고 attempt integration record에 남긴다.
- GitHub adapter hardening: gh auth preflight, origin guard, protected branch guard, safe
  branch-name guard, existing PR detection, check polling을 추가했다.
- Record migration: attempt/review record version을 저장하고 legacy record는 UI와 integration update
  경로에서 호환되도록 정규화한다.
- Prompt contract versioning: worker/reviewer/attempt-selection prompt와 orchestration plan에
  contract version을 남긴다.
- Scope fidelity gate: small patch 지시는 patch surface 제한일 뿐 acceptance target 축소가 아니며,
  brief/project-instruction requirement를 `not_applicable`로 표시하는 worker/reviewer 승인을
  차단한다.
- Validation approval gate: 비문서 변경에 대해 Kira가 effective validation command를 만들지 못하면
  worker self-check와 reviewer approval, multi-worker attempt selection에서 모두 차단한다.
- Quality dashboard: SLO, policy exception history, connector events, failure cluster drilldown,
  최근 성공률, 반복 실패 명령을 Project Intelligence에 추가했다.
- Fixtures: policy-blocked, remote-runner-missing, plugin-enabled, DAG-customized regression
  fixture를 실제 vitest 경로에 연결했다.

## A. 운영 검증 연결

1. 실제 처리 경로
   - 구현 상태: todo -> worker plan -> edit -> validation rerun -> review -> done 경로에서
     orchestration plan, evidence ledger, review record, integration record가 같은 사실을 공유한다.
   - 차단 경로: protected path write, denied command, validation failure, repeated failure, policy
     hook block이 `blocked` 또는 `needs_attention` 상태와 evidence ledger blocker로 남는다.
   - 확인 지점: attempt/review JSON, 댓글, UI Attempts 패널, Project Intelligence 요약.

2. Orchestration contract JSON 편집 UX
   - 구현 상태: 저장 전 JSON parse, 필드별 schema validation, 기본값 reset, 저장값 revert, schema
     hint, 정규화 summary, invalid state의 save 차단을 추가했다.
   - 서버 보호: `/api/kira-project-settings` POST도 동일한 validation report를 반환하며 invalid
     contract를 저장하지 않는다.
   - 확인 지점: Project Settings의 orchestration contract textarea, ready/error status, schema chip,
     field path issue list, save button disabled state.

3. 설정 문서와 예제
   - 구현 상태: `apps/webuiapps/src/pages/Kira/meta/meta_en/guide.md`와 `docs/config.example.json`에
     execution policy, environment, subagents, workflow, plugins 예제를 반영했다.
   - 확인 지점: 예제 JSON을 project settings에 붙여도 정규화 후 안전 기본값과 병합된다.

## B. P0 마감

1. Apply/Commit/PR 파이프라인
   - 구현 상태: approved attempt는 auto-commit 이후 GitHub connector가 enabled/apply일 때
     `git push`, draft PR 생성, check status 수집까지 진행한다.
   - 기록: commit hash, PR URL, connector check evidence를 attempt integration record와 댓글에
     남긴다.
   - 보호: gh auth 실패, main/master/trunk/production/release branch, unsafe branch name, 누락된
     origin, 누락된 gh CLI, connector policy mismatch는 실행 대신 evidence로 격리한다.
   - 중복 방지: 현재 branch의 open PR이 이미 있으면 새 PR을 만들지 않고 기존 PR URL과 check
     evidence를 기록한다.

2. Environment contract enforcement
   - 구현 상태: setup commands, validation commands, required env, runner/network/secret/dev-server
     command 정책을 실제 실행 전에 검사한다.
   - 차단: secret disclosure command, remote runner placeholder, cloud runner without connector,
     disallowed network command는 worker tool 실행 전 차단된다.
   - 실행: setup과 validation은 취소 가능한 경로로 실행되며 masked/remote secret policy에서는
     secret-like env를 자식 프로세스에 넘기지 않는다.
   - Remote probe: remote-command runner는 worker 시작 전에 `git rev-parse --is-inside-work-tree`
     probe를 통과해야 하며 실패/차단 사유는 environment evidence와 approval blocker에 기록된다.

3. Policy hook coverage
   - 구현 상태: `before_tool`, `after_tool`, `before_validation`, `before_integration`,
     `task_completed`를 실행, 파일 수정, 검증, 통합, 완료 판정 경로에 연결했다.
   - 기록: policy warning/block/exception은 evidence ledger와 attempt comments에 남는다.

## C. P1 마감

1. Subagent registry scheduler
   - 구현 상태: project subagent registry의 `tools`, `profile`, `modelHint`, `requiredEvidence`가
     worker lane 구성과 실제 tool execution 제한에 반영된다.
   - 차단: lane에 허용되지 않은 tool은 worker가 호출해도 실행 전에 거부된다.

2. Workflow DAG 실행
   - 구현 상태: design gate, validation, completion guard가 workflow DAG와 execution policy 조합을
     따른다.
   - 동작: DAG에서 required validation node를 제거하고 policy도 validation optional로 두면
     validation rerun이 명시적 생략 evidence로 남는다.
   - 보호: policy가 validation 또는 reviewer evidence를 요구하면 DAG 누락은 project safety issue로
     차단된다.

3. Diff-aware reviewer
   - 구현 상태: changed-line coverage, line-anchored finding count, worker summary contradiction
     detector를 review enforcement에 추가했다.
   - 차단: approved review가 changed files를 실제로 확인하지 않았거나 worker summary가 diff와
     충돌하면 approval이 거부된다.
   - Scope fidelity: reviewer와 attempt judge는 작은 patch를 선호하더라도 원래 brief와 mandatory
     project instructions의 acceptance target을 축소한 attempt를 승인할 수 없다.
   - Validation gate: 비문서 변경에서 effective validation command가 비어 있으면 수동 승인 대신
     project validation command 추가 또는 blocked/manual path로 되돌린다.
   - UI: Attempts 패널에서 diff coverage, anchored finding count, covered files, changed-line files,
     coverage issue를 확인할 수 있다.

4. Failure memory v2
   - 구현 상태: failure signature clustering, command-specific remediation, stale memory decay를
     project intelligence learning에 저장한다.
   - 재사용: 반복 실패는 다음 worker prompt와 Project Intelligence 요약에 이전 실패 원인, 재현 명령,
     권장 remediation으로 노출된다.

## D. P2 마감

1. Remote/cloud runner guard
   - 구현 상태: remote/cloud runner 선언은 placeholder command, connector availability, network
     policy, secret policy, remote worktree probe를 통과해야만 실행 경로로 들어간다.
   - 기록: local runner와 같은 environment evidence를 남기며, remote probe 출력과 실패/차단 사유를
     approval readiness blocker로 연결한다.
   - 보호: 지원되지 않는 remote/cloud 조합은 silent fallback 없이 blocked 처리한다.

2. Plugin/MCP adapter layer
   - 구현 상태: connector registry는 설정, context scan, orchestration plan, evidence ledger,
     integration record로 연결된다.
   - GitHub: enabled/apply 정책에서 branch push, draft PR creation, check evidence collection을
     수행한다.
   - 기타 connector: 현재는 observe/suggest evidence로 격리하고 자동 write는 수행하지 않는다.

3. Quality dashboard
   - 구현 상태: Project Intelligence에 SLO 상태, policy exception history, connector events, failure
     cluster drilldown, 최근 성공률, 반복 실패 명령을 추가했다.
   - 확인 지점: pass rate, readiness, blocked reasons, integration status, failure cluster, flaky
     validation command가 한 화면에서 연결된다.

## E. 회귀 검증 매트릭스

1. Unit/model regression
   - `src/lib/__tests__/kiraAutomationPlugin.test.ts`: policy hook, execution policy, schema
     validation, fixture regression, worker/reviewer enforcement 경로.
   - `src/pages/Kira/model.test.ts`: attempt integration record, review diff coverage, record
     version, orchestration plan normalization.

2. Fixture regression
   - `policyBlockedAttempt`: policy hook block이 completion으로 빠지지 않는지 확인.
   - `remoteRunnerMissing`: remote runner 선언이 실제 command 없이 실행되지 않는지 확인.
   - `pluginEnabled`: connector metadata와 GitHub integration evidence shape 확인.
   - `dagCustomized`: workflow DAG customization이 plan/evidence shape에 유지되는지 확인.

3. Manual run checklist
   - docs-only task: validation optional path와 review evidence 확인.
   - TypeScript edit task: changed-line coverage와 targeted validation 확인.
   - validation-failing task: failure cluster와 remediation 저장 확인.
   - protected-path task: policy block과 rollback evidence 확인.
   - multi-worker task: isolated attempt selection과 selected integration record 확인.
