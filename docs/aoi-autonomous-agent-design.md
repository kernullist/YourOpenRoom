# Aoi Autonomous Agent Design

작성일: 2026-06-11

## 목표

Aoi를 영화 속 Jarvis처럼 보이게 만드는 핵심은 "모델이 알아서 생각한다"가 아니라, 기억, 관찰, 계획,
반성, 검증, 제안을 분리한 런타임을 만드는 것이다. 이 문서의 목표는 현재 YourOpenRoom의 Aoi memory
v2, Aoi Research, capability registry, run ledger, Kira automation을 기반으로 Aoi가 다음을 할 수
있게 만드는 설계를 정리하는 것이다.

1. 과거 대화, 리서치, 자동화 결과, 사용자 선호를 스스로 조회한다.
2. 현재 요청과 환경 상태에 맞는 관련 기억을 조립한다.
3. 답변 또는 행동 전에 계획과 리스크를 판단한다.
4. 사용자에게 가치 있는 다음 행동을 먼저 제안한다.
5. 실행 결과를 검증하고, 실패와 성공을 다음 판단에 재사용한다.
6. 고위험 행동은 승인과 감사 로그 없이는 실행하지 않는다.

이 설계의 권장 방향은 "자율 실행"보다 "governed autonomy"이다. Aoi는 먼저 좋은 제안을 하는 조력자가
되고, 그 다음 낮은 위험의 read-only 작업부터 점진적으로 실행권을 얻어야 한다.

## 최신 연구 동향 요약

조사 기준일은 2026-06-11이다. 아래는 Aoi 설계에 직접 반영할 만한 흐름이다.

| 흐름                                                                             | 대표 연구/문서                                                                                                                                                                                                          | Aoi 설계에 주는 의미                                                                                                |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Agent memory는 단순 RAG가 아니라 write-manage-read loop                          | [Memory for Autonomous LLM Agents, 2026](https://arxiv.org/html/2603.07670v1)                                                                                                                                           | Aoi memory v2에 write filter, consolidation, contradiction, forgetting, governance를 명시적으로 넣어야 한다.        |
| 인지 아키텍처는 working, episodic, semantic, procedural memory를 나눈다          | [CoALA, 2023](https://arxiv.org/abs/2309.02427)                                                                                                                                                                         | 현재 memory schema를 유지하되 episode, fact, decision, procedure, skill memory의 역할을 분리해야 한다.              |
| observation-reflection-planning loop가 believable behavior를 만든다              | [Generative Agents, 2023](https://arxiv.org/abs/2304.03442)                                                                                                                                                             | Aoi도 chat response와 별개로 background reflection tick을 가져야 한다.                                              |
| verbal reflection은 weight update 없이 실패 학습을 만든다                        | [Reflexion, 2023](https://arxiv.org/abs/2303.11366)                                                                                                                                                                     | Kira/research/tool 실패는 reflection note로 남기되, 실행 정책에 바로 반영하기 전에 검증해야 한다.                   |
| 긴 대화는 OS식 memory tiering이 필요하다                                         | [MemGPT, 2023](https://arxiv.org/abs/2310.08560)                                                                                                                                                                        | prompt에는 작은 working context만 넣고, 나머지는 searchable archive로 둔다.                                         |
| Memory는 스스로 태그/링크/갱신되는 네트워크가 되어야 한다                        | [A-MEM, 2025](https://arxiv.org/abs/2502.12110), [MemInsight, 2025](https://arxiv.org/abs/2503.21760)                                                                                                                   | memory write 이후 관련 memory를 링크하고, 오래된 memory의 context/tags를 진화시킨다.                                |
| 시간성 있는 관계는 graph memory가 강하다                                         | [Zep/Graphiti, 2025](https://arxiv.org/abs/2501.13956)                                                                                                                                                                  | 당장 외부 서비스 의존은 피하되, local temporal relation index를 추가할 여지를 남긴다.                               |
| personal assistant는 capability, efficiency, security가 함께 설계되어야 한다     | [Personal LLM Agents Survey, 2024](https://arxiv.org/abs/2401.05459)                                                                                                                                                    | Aoi의 "스스로 한다"는 개인 데이터와 로컬 도구 접근 정책을 포함해야 한다.                                            |
| proactive agent는 임의 개입이 아니라 이벤트, 예측, accept/reject feedback 문제다 | [Proactive Agent, 2024](https://arxiv.org/abs/2410.12361), [ProAgentBench, 2026](https://arxiv.org/html/2602.04482v1)                                                                                                   | Aoi 제안은 trigger, confidence, cooldown, user feedback으로 통제해야 한다.                                          |
| memory 평가는 static recall보다 incremental multi-turn이 중요하다                | [LoCoMo, 2024](https://arxiv.org/abs/2402.17753), [LongMemEval, 2024](https://arxiv.org/abs/2410.10813), [MemoryAgentBench, 2025/ICLR 2026](https://arxiv.org/abs/2507.05257)                                           | Aoi 평가는 recall, temporal reasoning, update, abstention, forgetting을 따로 측정해야 한다.                         |
| 자기 검증과 LLM judge는 과신할 수 있다                                           | [Self-Verification Dilemma, 2026](https://arxiv.org/html/2602.03485v1), [Overconfidence in LLM-as-a-Judge, 2025](https://arxiv.org/html/2508.06225v1)                                                                   | reflection/judge를 믿고 바로 행동하면 안 된다. deterministic check와 사용자 feedback을 같이 써야 한다.              |
| evolving memory는 corruption, poisoning, privacy risk를 만든다                   | [SSGM, 2026](https://arxiv.org/html/2603.11768v1)                                                                                                                                                                       | memory consolidation은 실행 루프와 분리하고, provenance, access control, decay, conflict check를 둔다.              |
| tool 표준화는 capability와 schema를 주지만 권한 정책은 별도 문제다               | [MCP Tools spec, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools), [MCP Authorization spec, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) | Aoi capability registry를 MCP/plugin까지 확장하되 token passthrough, confused deputy, tool poisoning을 막아야 한다. |

## 현재 Aoi 베이스라인

현재 코드에는 이미 다음 기반이 있다.

1. `apps/webuiapps/src/lib/aoiMemoryManager.ts`
   - memory v2 schema: `user`, `agent`, `session`, `project`
   - `fact`, `preference`, `decision`, `event`, `procedure`, `action`, `emotion`
   - raw episode 저장, LLM distiller, heuristic extraction, permanent memory, archive/delete
2. `apps/webuiapps/src/lib/aoiMemoryServerWriter.ts`
   - Kira automation과 research run 결과를 server-side memory로 저장
3. `apps/webuiapps/src/lib/aoiResearchEngine.ts`
   - Tavily search, browser reader, evidence extraction, cited report, partial artifact,
     timeout/cancel
4. `apps/webuiapps/src/lib/aoiCapabilityRegistry.ts`
   - tool별 risk, surface, access, approval, cacheability, parallel-safety
5. `apps/webuiapps/src/lib/aoiRunLedger.ts`
   - goal, model route, iteration, tool-call 요약
6. `apps/webuiapps/src/lib/aoiSkillsWorkshop.ts`
   - trusted skill만 prompt에 주입
7. Kira automation
   - 계획, context scan, worker/reviewer/integrator, validation rerun, risk policy

따라서 새 설계는 완전히 새 agent framework를 만들기보다, 위 구성 위에 `Aoi Autonomy Runtime`을
추가하는 형태가 가장 안전하다.

## 구현 현황 - 2026-06-16

이 문서의 초기 설계는 현재 `apps/webuiapps/src/lib/` 아래의 Aoi autonomy control plane으로 상당 부분
구현되었다. 현 상태의 핵심은 "완전 자동 실행"이 아니라, 관찰, 기억 확인, 맥락 조립, 조용한 주의
분배, 제안, 승인 경계, replay 평가를 갖춘 governed autonomy이다.

| 영역                                | 현재 구현                                                                                                                            | 운영상 의미                                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage / policy / API              | `aoiAutonomyTypes.ts`, `aoiAutonomyStore.ts`, `aoiAutonomyPolicy.ts`, `aoiAutonomyPlugin.ts`, `aoiAutonomyClient.ts`                 | 세션별 `aoi-autonomy/` 저장소, policy, proposal decision, status/evaluation API가 생겼다.                                                                                                                                    |
| Observation / reflection / proposal | `aoiAutonomyObserver.ts`, `aoiAutonomyEngine.ts`, `aoiAutonomyRecovery.ts`                                                           | chat/research/Kira/workspace 이벤트를 observation으로 만들고, completed/failed research, stale memory, reviewed Kira outcome, failure recovery를 evidence 기반 proposal로 바꾼다.                                            |
| Mission / goal / relation graph     | `aoiAutonomyMission.ts`, `aoiAutonomyGoals.ts`, `aoiAutonomyRelations.ts`                                                            | active goal, mission state, proposal/observation/research/Kira evidence 관계를 추적해 "지금 무엇을 계속해야 하는지"를 재구성한다.                                                                                            |
| Context routing                     | `aoiContextRouter.ts`, `aoiWorkspaceSignals.ts`                                                                                      | memory, research, browser context, workspace snapshot, validation signal, disabled source feedback을 점수화해 prompt-ready context로 조립한다.                                                                               |
| Attention and digest                | `aoiAttentionBroker.ts`, `aoiOperatorDigest.ts`, `aoiPreferenceMemory.ts`                                                            | background event를 바로 방해하지 않고 critical/approval/FYI/hidden lane으로 분류하며, quiet mode와 "too much" feedback을 반영한다.                                                                                           |
| UI decision helpers                 | `aoiAutonomyUi.ts`                                                                                                                   | inline proposal, dashboard badge, evidence panel, proactive explanation, approval boundary, blocked-state summary를 같은 결정 모델에서 만든다.                                                                               |
| Supervised execution                | `aoiAutonomyExecution.ts`, `aoiSafeActionPlan.ts`, `aoiKiraHandoff.ts`, `aoiApprovedCommandPolicy.ts`, `aoiApprovedCommandRunner.ts` | read-only research artifact/status, approval-gated research start, procedure promotion, Kira handoff, approved command runner를 분리했다. high-risk 실행은 승인 fingerprint, cwd guard, audit record 없이는 진행하지 않는다. |
| Evaluation / replay                 | `aoiAutonomyEvaluation.ts`, `aoiOperatorReplay.ts`, `aoiJarvisAcceptanceTrial.ts`                                                     | acceptance/dismissal/feedback metrics, 8개 built-in operator replay scenario, 9개 JARVIS acceptance scenario로 wrong source, unsafe approval boundary, noisy interruption, disabled source leakage, personal-source consent, replay redaction을 회귀 테스트한다. |

현재 구현된 built-in replay scenario는 다음 운영 상황을 고정 fixture로 검증한다.

1. 사용자가 branch drift 이후 돌아온 경우.
2. Kira가 validation 통과 및 reviewer note와 함께 완료된 경우.
3. research가 source 부족으로 실패한 경우.
4. 사용자가 제안을 "too much"로 거부한 경우.
5. high-risk command proposal이 차단되어야 하는 경우.
6. 사용자 preference가 project instruction과 충돌하는 경우.
7. disabled source가 context에 영향을 주면 안 되는 경우.
8. quiet mode가 low-value digest item을 숨겨야 하는 경우.

Goal 32 이후에는 `aoiJarvisAcceptanceTrial.ts`가 별도 acceptance pack을 제공한다. 이 trial은 synthetic
timeline/source state만 사용하고, 실제 shell, network, Gmail, Calendar, filesystem source reader,
Kira mutation을 호출하지 않는다. report는 scenario/metric별 pass/fail, actual summary, evidence refs,
privacy state, mutation count를 포함한다.

현재 JARVIS acceptance scenario는 다음 9개다.

1. branch drift 이후 stale validation을 감지하고 안전한 next step만 제안하는 경우.
2. Calendar source가 명시적으로 허용된 metadata만 노출하고 body/description을 숨기는 경우.
3. Gmail source가 disconnected 상태일 때 inbox를 본 척하지 않고 health blind spot을 보고하는 경우.
4. Kira completion이 quiet mode에서 operator-visible digest로 정리되는 경우.
5. too-much feedback 이후 유사 이벤트 interruption이 줄어드는 경우.
6. approved command preview가 바뀌면 기존 승인이 무효화되는 경우.
7. multi-step playbook이 Kira 완료 evidence를 기다리고 command approval gate를 유지하는 경우.
8. voice policy가 FYI는 억제하고 critical blocker만 말하는 경우.
9. trace export가 개인 값을 redaction하고 replay fixture draft로 승격되는 경우.

따라서 현 단계의 Aoi는 기억과 현재 상태를 능동적으로 확인해 제안할 수 있는 기반을 갖췄지만, 사용자
승인 없이 고위험 파일 변경이나 명령 실행을 맡기는 단계는 아니다. Jarvis-like 체감은 L2-L4의 근거
있는 제안, resume brief, approval inbox, 안전한 preview에서 먼저 확보하고, L5는 계속 좁은 승인 경계
안에 둔다.

## 권장 아키텍처

### 1. Aoi Autonomy Runtime

새 런타임은 사용자 응답 경로와 분리된 background control plane으로 둔다.

```text
User / App / Tool Event
        |
        v
Observation Collector
        |
        v
Memory Retrieval + State Snapshot
        |
        v
Reflection Engine
        |
        v
Proposal Judge + Policy Gate
        |
        +----> Suggestion Queue
        |
        +----> Memory Consolidation Queue
        |
        +----> Optional Low-Risk Action Plan
```

핵심 원칙:

1. Aoi의 일반 답변을 막지 않는다.
2. memory write와 reflection은 비동기 작업으로 돌린다.
3. reflection 결과는 직접 실행 명령이 아니라 `proposal` 또는 `memory_candidate`로 저장한다.
4. 실행은 capability registry와 autonomy policy를 통과해야 한다.
5. 모든 proposal/action/memory에는 evidence id와 source episode id를 남긴다.

### 2. Autonomy Level

| Level | 이름                 | 허용 행동                                                                             | 기본값                              |
| ----- | -------------------- | ------------------------------------------------------------------------------------- | ----------------------------------- |
| L0    | Reactive Chat        | 답변만 생성                                                                           | 항상 허용                           |
| L1    | Memory Aware         | 관련 기억 조회, 답변에 반영                                                           | 허용                                |
| L2    | Suggestive           | 다음 행동 제안, reminder, research 제안                                               | 허용하되 cooldown 적용              |
| L3    | Assisted Read        | read-only tool 실행, research status 확인, completed artifact 읽기                    | 사용자 설정 필요                    |
| L4    | Supervised Action    | research 시작, preview-first Kira work item 생성, 파일 preview, low-risk local action | 명시 승인 필요                      |
| L5    | Delegated Automation | file write, command, irreversible app mutation                                        | high-risk policy와 사용자 승인 필요 |

Jarvis 같은 체감은 L2와 L3에서 대부분 나온다. L5를 빨리 열면 편해지는 것보다 사고 가능성이 먼저
커진다.

### 3. Memory Fabric

현재 memory v2를 유지하되, 의미상 다음 계층을 명확히 한다.

| 계층              | 저장 대상                                         | 현재 대응                                                  | 추가 필요                                   |
| ----------------- | ------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| Working memory    | 이번 턴에 prompt로 들어가는 압축 context          | `buildAoiMemoryPrompt`                                     | proposal/research/project context assembler |
| Episodic memory   | 실제 있었던 대화, tool call, research, Kira event | `episodes/*`                                               | app observation episode                     |
| Semantic memory   | 사용자 선호, 사실, 결정, 프로젝트 상태            | `memories/*.json`                                          | contradiction graph, source confidence      |
| Procedural memory | 반복 가능한 방법, checklists, skill recipes       | `procedure`, `aoiSkillsWorkshop`, approval-gated promotion | richer reuse/eval loop                      |
| Reflection memory | 실패 원인, 좋은 판단 규칙, 다음에는 피할 것       | 일부 Kira review memory                                    | `reflection_note` 타입 또는 tags            |
| Proposal memory   | Aoi가 제안했지만 아직 결정되지 않은 것            | 없음                                                       | suggestion queue                            |

초기 구현은 기존 JSON 파일 구조와 맞춘다. 단, 검색 성능과 consistency가 필요해지면 SQLite FTS5 +
vector sidecar + relation table로 옮길 수 있게 type boundary를 둔다.

### 4. Storage Layout

기존 session storage 아래에 추가한다.

```text
sessions/<character>/<mod>/
  aoi-autonomy/
    policy.json
    observations/
      <observationId>.json
    reflections/
      <reflectionId>.json
    proposals/
      active.json
      archived.json
    decisions/
      <decisionId>.json
    relations.json
    eval/
      memory-golden.json
      proposal-feedback.json
```

Research run과 Kira artifact는 복사하지 말고 id/reference만 둔다.

### 5. Core Types

```ts
export type AoiAutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export type AoiProposalStatus =
  | 'active'
  | 'accepted'
  | 'dismissed'
  | 'snoozed'
  | 'expired'
  | 'executed'
  | 'blocked';

export interface AoiObservation {
  version: 1;
  id: string;
  source: 'chat' | 'tool' | 'research_run' | 'kira' | 'app' | 'calendar' | 'system';
  sessionPath: string;
  createdAt: number;
  summary: string;
  payloadRef?: string;
  memoryIds: string[];
  artifactRefs: string[];
  riskSignals: string[];
}

export interface AoiReflection {
  version: 1;
  id: string;
  observationIds: string[];
  createdAt: number;
  kind: 'memory_audit' | 'failure_postmortem' | 'opportunity' | 'procedure_candidate';
  claim: string;
  evidenceRefs: string[];
  confidence: number;
  risk: 'low' | 'medium' | 'high';
  proposedMemoryCandidates: string[];
  proposedActions: string[];
}

export interface AoiProposal {
  version: 1;
  id: string;
  status: AoiProposalStatus;
  title: string;
  body: string;
  reason: string;
  trigger: string;
  createdAt: number;
  expiresAt?: number;
  cooldownKey: string;
  confidence: number;
  risk: 'low' | 'medium' | 'high';
  requiredAutonomyLevel: AoiAutonomyLevel;
  suggestedTools: string[];
  evidenceRefs: string[];
  acceptAction?: {
    kind: 'start_research' | 'open_artifact' | 'create_kira_work' | 'open_app' | 'save_memory';
    params: Record<string, unknown>;
  };
}
```

### 6. Reflection Engine

Reflection은 세 종류로 나눈다.

1. Turn reflection
   - 일반 채팅 후 memory extraction이 끝난 뒤 실행
   - 목적: durable preference, unresolved request, future suggestion 후보 찾기
2. Outcome reflection
   - research/Kira/tool action 완료 또는 실패 후 실행
   - 목적: 실패 원인, 재시도 조건, reusable procedure 후보 기록
3. Periodic reflection
   - 앱 시작 후 또는 일정 간격으로 짧게 실행
   - 목적: 오래된 active proposal 만료, stale memory 후보, unfinished research/Kira 점검

Reflection prompt는 다음 제약을 가져야 한다.

1. 새 사실을 invent하지 말고 evidenceRefs에 있는 내용만 사용한다.
2. `action`은 직접 실행하지 말고 proposal로만 낸다.
3. confidence가 낮으면 proposal 대신 `needs_more_evidence`로 끝낸다.
4. memory 후보는 기존 memory와 충돌하는지 judge 단계에서 다시 확인한다.
5. secret, credential, private path, token은 memory/proposal에서 제거한다.

### 7. Proposal Judge

제안은 두 번 걸러야 한다.

1. Deterministic gate
   - confidence floor
   - cooldown
   - duplicate active proposal
   - capability risk
   - required autonomy level
   - missing evidence
   - local/private URL and SSRF guard reuse
2. LLM judge
   - 사용자에게 지금 말할 가치가 있는지
   - 너무 사소하거나 귀찮은지
   - 근거가 충분한지
   - 제안 문구가 과장되지 않았는지

LLM judge 결과는 단독 승인 근거로 쓰지 않는다. 2025-2026 연구는 self-check와 LLM judge가 과신할 수
있음을 반복해서 보여준다. 따라서 judge score는 deterministic policy를 통과한 뒤 ranking과
wording에만 사용한다.

### 8. Proactive Trigger

초기 trigger는 작고 실용적인 것만 둔다.

| Trigger               | 예시                                                         | 제안                                              |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| Research follow-up    | completed research run이 있고 사용자가 같은 주제를 다시 언급 | "이전 report를 다시 열어볼까?"                    |
| Stale research        | 오래된 research memory가 최신성이 필요한 주제와 매칭         | "최신 자료로 refresh run을 돌려볼까?"             |
| Failed run            | research/Kira가 timeout 또는 failed                          | "실패 원인을 정리하고 작은 재시도 plan을 만들까?" |
| Repeated user pattern | 사용자가 비슷한 요청을 여러 번 함                            | "이걸 procedure memory로 저장할까?"               |
| Project automation    | Kira work item이 clarification 대기                          | "이 질문에 답하면 자동화를 계속할 수 있어."       |
| Safety reminder       | high-risk file/write/command 요청 직전                       | "preview/checkpoint를 먼저 만들까?"               |

금지할 trigger:

1. 사용자가 요청하지 않은 고위험 실행
2. private file/content를 근거 없이 요약해서 먼저 말하기
3. 매 턴 반복되는 "도와줄까?" 류의 noise
4. confidence가 낮은 기억을 기반으로 한 제안
5. 사용자가 dismiss한 주제를 cooldown 없이 반복하기

### 9. Tool/Action Policy

현재 capability registry를 확장한다.

1. 각 tool metadata에 `autonomyMaxLevel` 추가
2. `approval`을 `none`, `policy-gated`, `user-confirmation`에서 유지하되 proposal accept flow와 연결
3. `access`에 `credential`, `irreversible`, `external`이 있으면 L5 또는 수동 승인
4. unknown tool은 prompt 노출과 autonomy 실행 모두 차단
5. MCP/plugin tool은 기본적으로 L3 이하 read-only로 시작하고, write/execute는 per-tool trust 필요

예시 정책:

```ts
const AOI_AUTONOMY_TOOL_POLICY = {
  get_research_status: { maxLevel: 'L3', requiresApproval: false },
  read_research_artifact: { maxLevel: 'L3', requiresApproval: false },
  start_research: { maxLevel: 'L4', requiresApproval: true },
  cancel_research: { maxLevel: 'L4', requiresApproval: true },
  workspace_search: { maxLevel: 'L3', requiresApproval: false },
  file_write: { maxLevel: 'L5', requiresApproval: true },
  run_command: { maxLevel: 'L5', requiresApproval: true },
};
```

### 10. UI/UX

Aoi의 proactive 기능은 조용해야 한다.

1. Chat inline suggestion
   - 낮은 빈도의 중요한 제안만 말풍선/카드로 표시
   - 버튼: `실행`, `나중에`, `숨김`, `왜?`
2. Advanced -> Aoi Autonomy
   - autonomy level slider
   - active proposals
   - recent reflections
   - blocked proposals and reasons
   - cooldown/dismiss history
3. Memory Inspector 연결
   - proposal이 사용한 memory/evidence를 바로 열 수 있게 함
   - 잘못된 기억이면 archive/delete로 이어짐
4. Run Ledger 연결
   - proposal accepted/executed/dismissed 이벤트를 run ledger에 기록

## 구현 계획

### Phase 0 - Design and Flags

1. 이 문서를 기준으로 scope를 고정한다.
2. `autonomy.enabled`, `autonomy.level`, `autonomy.proactiveSuggestionsEnabled` 설정을 추가한다.
3. 기본값은 `enabled=false`, level `L1` 또는 `L2 preview`로 둔다.

### Phase 1 - Read-Only Reflection Queue

목표: Aoi가 기억과 결과를 살펴보고 제안 후보를 만들지만 실행은 하지 않는다.

추가 파일 후보:

1. `apps/webuiapps/src/lib/aoiAutonomyTypes.ts`
2. `apps/webuiapps/src/lib/aoiAutonomyPolicy.ts`
3. `apps/webuiapps/src/lib/aoiAutonomyStore.ts`
4. `apps/webuiapps/src/lib/aoiAutonomyEngine.ts`
5. `apps/webuiapps/src/lib/aoiAutonomyPlugin.ts`
6. `apps/webuiapps/src/lib/__tests__/aoiAutonomy*.test.ts`

검증:

1. duplicate proposal 방지
2. dismissed proposal cooldown
3. high-risk action이 active proposal로 올라오더라도 execution blocked
4. evidence 없는 reflection 폐기
5. malformed model JSON 방어

### Phase 2 - Research and Memory Follow-up

목표: 현재 Aoi Research와 memory v2만 사용해서 체감 가능한 proactive suggestion을 만든다.

우선 trigger:

1. completed research memory 재사용 제안
2. stale current-information topic refresh 제안
3. failed research retry plan 제안
4. user가 반복 요청한 research topic procedure화 제안

이 단계에서는 `start_research` 자동 실행은 금지하고, 사용자가 `실행`을 눌렀을 때만 시작한다.

### Phase 3 - Procedure Memory and Skill Promotion

목표: 성공한 반복 작업을 절차 기억으로 승격한다.

흐름:

1. Kira/research/tool run이 성공한다.
2. outcome reflection이 "reusable procedure candidate"를 만든다.
3. Aoi가 "이 작업 방식을 skill/procedure로 저장할까?"라고 제안한다.
4. 사용자가 승인하면 procedure memory 또는 Skills Workshop user skill로 저장한다.
5. 이후 유사 요청에서 prompt에 짧게 주입한다.

승격 조건:

1. 최소 2회 이상의 유사 성공 evidence
2. validation 또는 user acceptance 존재
3. high-risk step은 절차 안에서도 approval 필요

### Phase 4 - Temporal Relation Index

목표: graph memory의 장점을 local-first 방식으로 일부 흡수한다.

초기 형태:

```text
aoi-autonomy/relations.json
  nodes: memory, episode, research_run, artifact, proposal, reflection, procedure, project, topic
  edges: supports, supersedes, contradicts, caused_by, followed_by, used_tool, belongs_to, suggested_by
```

나중에 필요하면 SQLite relation table 또는 embedded graph로 이전한다. 외부 Zep/Graphiti류 서비스는
provider adapter로만 붙이고 local episode를 ground truth로 유지한다.

### Phase 5 - Governed Action Execution

목표: 사용자가 명시적으로 허용한 일부 행동만 Aoi가 제안 카드 accept 후 실행한다.

허용 후보:

1. `read_research_artifact`
2. `get_research_status`
3. `open_research_artifact`
4. `start_research` after explicit accept
5. `save_memory` for user-approved procedure promotion
6. Kira work item creation after explicit accept and preview, only through a narrow safe API

금지 또는 L5-only:

1. `file_write`
2. `file_patch`
3. `file_delete`
4. `run_command`
5. external credential flow
6. irreversible app mutation

## API 설계

현재 Vite plugin API는 `/api/aoi-autonomy` prefix 아래에 구현되어 있다.

```text
GET  /api/aoi-autonomy/status?sessionPath=...
GET  /api/aoi-autonomy/proposals?sessionPath=...
GET  /api/aoi-autonomy/reflections?sessionPath=...
GET  /api/aoi-autonomy/observations?sessionPath=...
GET  /api/aoi-autonomy/goals?sessionPath=...
GET  /api/aoi-autonomy/evaluation?sessionPath=...
GET  /api/aoi-autonomy/mission?sessionPath=...
GET  /api/aoi-autonomy/sources?sessionPath=...
GET  /api/aoi-autonomy/workspace?sessionPath=...
GET  /api/aoi-autonomy/context?sessionPath=...
POST /api/aoi-autonomy/policy
POST /api/aoi-autonomy/sources
POST /api/aoi-autonomy/context/browser
POST /api/aoi-autonomy/context/feedback
POST /api/aoi-autonomy/workspace/validation
POST /api/aoi-autonomy/mission/decision
POST /api/aoi-autonomy/tick
POST /api/aoi-autonomy/goal/check
POST /api/aoi-autonomy/goal/decision
POST /api/aoi-autonomy/proposal/decision
POST /api/aoi-autonomy/proposal/feedback
POST /api/aoi-autonomy/proposal/preview
POST /api/aoi-autonomy/proposal/execute
```

현재 실행 가능한 proposal action은 다음으로 제한된다.

```text
get_research_status
open_research_artifact
read_research_artifact
start_research
save_memory
create_kira_work
run_command
```

`run_command`는 일반 command tool이 아니라 approved command request로 다시 정규화된다. policy는
workspace 안의 cwd, destructive command pattern, approval fingerprint, timeout, evidenceRefs를
확인하고, stdout/stderr는 redaction 및 길이 제한을 거쳐 audit record에 남긴다.

모델에 직접 노출할 수 있는 tool 후보는 여전히 별도 단계로 남긴다.

```text
list_aoi_proposals
explain_aoi_proposal
accept_aoi_proposal
dismiss_aoi_proposal
snooze_aoi_proposal
run_aoi_reflection
```

현재는 이 tool들을 모델에 직접 노출하지 않고 UI/API와 테스트로 먼저 검증하는 편이 안전하다. tool
노출은 capability registry 등록, permission surface, prompt-injection 방어가 모두 맞은 뒤에
진행한다.

## Prompt Contract

Autonomy runtime의 system prompt는 Aoi chat prompt와 분리한다.

필수 규칙:

1. You are Aoi's background autonomy evaluator, not the user-facing assistant.
2. Do not invent memories, files, URLs, or completed actions.
3. Use only supplied evidenceRefs and summaries.
4. Produce JSON only.
5. Propose actions; do not claim they were executed.
6. If confidence is low, return no proposal.
7. If risk is high, require user confirmation.
8. Never store secrets or credentials.

출력 schema:

```json
{
  "reflections": [
    {
      "kind": "opportunity",
      "claim": "A previous research run may answer the current topic.",
      "confidence": 0.82,
      "risk": "low",
      "evidenceRefs": ["memory:aoi-memory-123", "research:aoi-research-456"]
    }
  ],
  "proposals": [
    {
      "title": "이전 리서치 보고서를 다시 열까요?",
      "reason": "현재 질문과 2026-06-10 research_run memory가 같은 주제입니다.",
      "confidence": 0.81,
      "risk": "low",
      "requiredAutonomyLevel": "L2",
      "suggestedTools": ["read_research_artifact"]
    }
  ],
  "memoryCandidates": []
}
```

## Evaluation Plan

### Memory Quality

1. Retrieval precision
   - 현재 질문에 관련 없는 memory가 prompt에 들어오는 비율
2. Recall
   - 명시적으로 기억한 사실을 다시 물었을 때 찾는 비율
3. Temporal update
   - 오래된 사실보다 새 사실을 우선하는지
4. Conflict handling
   - 서로 충돌하는 memory를 동시에 단정하지 않는지
5. Abstention
   - 기억에 없는 내용을 "모른다"고 말하는지
6. Forgetting/delete
   - archive/delete 이후 prompt와 proposal에서 사라지는지

### Proactive Suggestion Quality

1. Acceptance rate
2. Dismiss rate
3. "너무 자주 끼어듦" feedback
4. proposal당 evidence coverage
5. high-risk proposal block rate
6. duplicate/cooldown violation count
7. accepted proposal execution success rate

### Reflection Quality

1. failed run의 실제 root cause와 reflection claim 일치율
2. procedure candidate가 실제 재사용 가능한지
3. hallucinated evidenceRef 비율
4. judge score와 human feedback의 calibration error

### Local Regression Tests

현재 core regression target:

```text
pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyStore.test.ts src/lib/__tests__/aoiAutonomyPolicy.test.ts src/lib/__tests__/aoiAutonomyEngine.test.ts src/lib/__tests__/aoiAutonomyExecution.test.ts src/lib/__tests__/aoiAutonomyUi.test.ts src/lib/__tests__/aoiAutonomyEvaluation.test.ts
pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyClient.test.ts src/lib/__tests__/aoiAutonomyObserver.test.ts src/lib/__tests__/aoiAutonomyMission.test.ts src/lib/__tests__/aoiAutonomyGoals.test.ts src/lib/__tests__/aoiAutonomyRelations.test.ts src/lib/__tests__/aoiAutonomyPlugin.test.ts
pnpm --filter @openroom/webuiapps build:test
git diff --check
```

Operator replay는 `aoiAutonomyEvaluation.test.ts`에서 `runBuiltInAoiOperatorReplayFixtures()`로
실행한다. 이 replay path는 실제 shell, network, file mutation을 호출하지 않고 injected fixture
state만 사용한다. JARVIS acceptance trial은 같은 test file에서 `runAoiJarvisAcceptanceTrial()`과
`formatAoiJarvisAcceptanceReport()`로 실행한다. 이 path도 synthetic fixture만 사용하며 live
connector, command execution, file mutation을 호출하지 않는다.

## Security and Failure Modes

| Risk                     | Failure Mode                                                    | Mitigation                                                                                    |
| ------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Memory poisoning         | 웹/문서 내용이 "앞으로 이렇게 행동해" 같은 지시를 memory로 승격 | source trust, instruction stripping, evidence type, user confirmation for durable instruction |
| Prompt injection         | read_url/research source가 tool policy를 우회하도록 지시        | source text는 data로만 취급, autonomy prompt에 tool policy 분리                               |
| Stale memory             | 예전 사실을 최신 사실처럼 제안                                  | timestamp, staleness score, current-info trigger는 research refresh 제안                      |
| Reflection hallucination | 없는 파일/실행/기억을 근거로 제안                               | evidenceRefs existence check                                                                  |
| LLM judge overconfidence | judge가 틀린 제안을 high confidence로 승인                      | deterministic gate first, human feedback calibration                                          |
| Excessive interruption   | 매 턴 proactive message                                         | cooldown, max suggestions per day/session, user dismiss learning                              |
| Data exposure            | private path/content를 제안 카드에 노출                         | redaction, path display policy, proposal detail gating                                        |
| Tool abuse               | proposal accept가 high-risk tool 실행으로 이어짐                | capability registry, autonomy level, explicit confirmation                                    |
| Confused deputy          | MCP/plugin token 또는 권한이 다른 upstream에 전달               | MCP authorization separation, per-server trust, no token passthrough                          |
| Irreversible mutation    | file_delete/run_command가 자동 실행                             | L5-only, checkpoint/preview, explicit user confirmation                                       |

## Current Milestone Status

초기 milestone과 JARVIS-grade presence/trust milestone의 replay-safe 범위는 완료된 상태로 본다.

1. `aoi-autonomy` 저장소와 type/policy/API가 추가되었다.
2. completed/failed research run, memory v2, Kira outcome, workspace signal을 읽어 proposal 후보를
   만든다.
3. UI helper는 active proposal, dismiss/snooze, feedback, mission, goal, prepared action, blocked
   state, proactive explanation, operator digest를 같은 decision surface로 요약한다.
4. read-only artifact/status는 실행 가능하고, `start_research`, `save_memory`, `create_kira_work`,
   `run_command`는 각자 별도의 preview/approval/policy path를 탄다.
5. source feedback과 quiet-mode feedback을 통해 틀리거나 시끄러운 제안을 억제한다.
6. relation index는 JSON 기반으로 시작했고 observation, proposal, goal, research, Kira work/review,
   validation evidence를 연결한다.
7. operator replay harness가 대표 운영 상황을 deterministic fixture로 고정한다.
8. operator timeline, trace export, replay fixture draft promotion이 추가되어 real-session evidence를
   redaction-first 방식으로 회귀 테스트 후보로 바꿀 수 있다.
9. budgeted wakeup, source consent, voice policy, trust calibration, operator health, playbook
   orchestration이 각자 기존 approval/policy gate 뒤에 붙었다.
10. JARVIS acceptance trial은 9개 scenario로 context awareness, interruption timing, approval
    boundary, personal-source consent, voice appropriateness, health honesty, playbook coordination,
    replay privacy를 한 번에 검증한다.

다음 milestone은 더 많은 실행권을 여는 것이 아니라, 운영자가 신뢰할 수 있는 관측성과 회귀 방어를
강화하는 쪽이 맞다.

1. Autonomy dashboard에서 operator timeline, health, playbook, JARVIS acceptance summary를 한 화면에
   연결한다.
2. 실제 세션 trace를 shadow-mode acceptance run으로 돌려 synthetic fixture와 drift를 비교한다.
3. long-running mission memory와 relation graph를 더 durable한 storage/index boundary로 분리한다.
4. approved command runner는 allowlist와 rollback/checkpoint 연계를 더 좁게 검증한다.
5. Calendar/Gmail 같은 외부 개인 데이터 source는 metadata-only consent path를 유지하되, live connector
   failure와 revocation이 UI/health/replay에 일관되게 반영되는지 운영 테스트한다.

이렇게 하면 Aoi가 "스스로 기억을 확인하고 제안한다"는 체감은 유지하면서, 위험한 자동 실행은 아직
좁은 승인 경계 안에 둔다.

## Non-goals

1. 모델 weight를 fine-tune해서 인격이나 기억을 학습시키지 않는다.
2. 모든 raw chat log를 prompt에 넣지 않는다.
3. Aoi가 사용자 승인 없이 파일을 쓰거나 명령을 실행하지 않는다.
4. 외부 memory service를 ground truth로 삼지 않는다.
5. LLM judge를 최종 보안 판정자로 쓰지 않는다.
6. proactive message를 일반 채팅 답변처럼 무제한 생성하지 않는다.

## Open Questions

1. Aoi Autonomy UI를 계속 ChatPanel Advanced 중심으로 둘지, 별도 `Aoi Autonomy` 앱으로 승격할지.
2. proposal notification을 desktop toast로 띄울지, chat panel 내부에만 둘지.
3. relation index를 언제 JSON에서 SQLite relation table로 옮길지.
4. proactive trigger에 Calendar/Email/Gmail을 어느 시점부터 포함할지.
5. feedback category를 어느 정도까지 사용자에게 노출하고, 어느 정도까지 자동 calibration으로만 쓸지.
6. procedure memory를 memory v2 기본값으로 둘지, Skills Workshop user skill draft로 승격할지.

## Decision

권장 결정은 다음과 같다.

1. Phase 1은 read-only reflection/proposal queue로 구현한다.
2. Aoi의 첫 autonomous value는 "먼저 실행"이 아니라 "좋은 다음 행동을 근거와 함께 제안"으로 둔다.
3. Memory는 현재 JSON 기반을 유지하되, relation index와 storage adapter boundary를 추가한다.
4. Proactive trigger는 research/memory/Kira처럼 이미 provenance가 있는 이벤트에서만 시작한다.
5. High-risk action은 Kira/capability registry의 기존 review and approval 패턴을 재사용한다.

이 경로가 현재 코드베이스와 가장 잘 맞고, Jarvis 같은 체감과 운영 안전성을 동시에 얻을 가능성이
높다.
