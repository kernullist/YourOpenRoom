# Aoi turn understanding: what a chat turn knows before it answers

Status: shipped 2026-09-10. Measurements in this document are from the labelled corpus in
`apps/webuiapps/src/lib/__fixtures__/aoiTurnUnderstandingCorpus.ts`, run through
`pnpm --filter webuiapps turn-understanding-eval`.

## 1. The problem, located

Aoi misread short chat turns in three recurring ways: a request phrased without a keyword the
router knew ("타이머 5분 맞춰줘", "package.json 열어봐") answered as conversation; a reference to an
earlier turn ("그거 다시 해줘", "아니 그거 말고") resolved against nothing; a confirmation ("응",
"맞아") after an offer treated as small talk. The transcript is short turns: of the last 27 real user
messages, 25 were 20 characters or fewer.

Reading the pipeline showed the limit was not the model.

- **Cross-turn action state did not exist.** The persisted history kept `{ role, content }` per
  turn (`ChatPanel` appended `{ role: 'assistant', content }` only), and `condenseConversationHistory`
  filtered to user/assistant before the model saw it. Tool calls, tool results, offers, and
  performed actions from turn N were gone by turn N+1. "그거" could only match prose Aoi happened
  to write.
- **Routing was regex over the latest message plus two history lines.** `shouldUseDialogModel` is
  about fifteen sequential deny checks; the follow-up predicates are verb and deictic lists. Each
  was added after a production miss, and five separate escape hatches (browser, app, IDA, Ghidra,
  playback) existed for the same failure class: a turn sent to the dialog route, whose tool array
  cannot serve it, so Aoi truthfully reports she cannot do something she can.
- **A misroute was terminal within the turn.** Nothing let the model say "I need tools for this".
- **No clarification path** in chat. Ambiguity was guessed.
- **Nothing was measured.** The run ledger recorded the route and the tools, not the reason or
  whether it was right, and there was no labelled utterance set, so regex edits were unfalsifiable.

## 2. Baseline, measured

Regex router over the 164-case corpus, before any of the work below:

| Metric | Value |
| --- | --- |
| Route accuracy | 72.0% |
| Under-routed to dialog (real misses) | 37 |
| Over-routed to main (cost only) | 9 |
| Kind accuracy | 81.7% |
| Family accuracy | 79.3% |
| References resolved | 0 / 30 |

(Kind and family figures are for the regex reading shipped with this work, after two fixes the
corpus itself surfaced: JavaScript `\b` never matched after a Hangul syllable, so bare refusals
such as 아니 read as chit-chat, and 디컴파일 matched the file family through 파일.)

The 37 misses are the user-visible bug: 타이머 맞춰줘, 음악 꺼줘, notepad 열어, run the tests,
네이버 확인해봐, 다시 해줘, retry that, 응 돌려 after a build offer, every rejection with a target.
The 0/30 is structural: a pattern over the message cannot know what T-1 did.

These numbers are pinned as floors in `aoiTurnUnderstandingEval.test.ts` so a router change cannot
silently make them worse.

### 2.1 Live classifier, measured 2026-09-10

`qwen/qwen3.7-flash` through OpenRouter, the configured model. 164 cases, concurrency 2, one run
per row; regex floor applied exactly as the runtime applies it, so "route" is what the turn would
have done. `pnpm --filter webuiapps turn-understanding-eval [--reasoning-effort none|low]`.

| | Regex only | Provider default (thinking on) | `--reasoning-effort none` | `--reasoning-effort low` |
| --- | --- | --- | --- | --- |
| Route accuracy | 72.0% | 92.7% | 93.3% | 89.0% |
| Under-routed to dialog (real misses) | 37 | 2 | 1 | 6 |
| Over-routed to main (regex floor, cost only) | 9 | 10 | 10 | 12 |
| Kind / family accuracy | 81.7% / 79.3% | 96.3% / 93.9% | 93.3% / 92.7% | 93.3% / 90.2% |
| References resolved | 0 / 30 | 29 / 30 | 18 / 30 | 26 / 30 |
| Anaphora / confirmation / rejection route | 5/12, 9/12, 1/8 | 12/12, 12/12, 7/8 | 12/12, 12/12, 8/8 | 12/12, 12/12, 4/8 |
| Calls that fell back | n/a | 7 (no tool call 6, failed validation 1) | 0 | 11 (no tool call 7, failed validation 2, timeout 2) |
| Latency p50 / p90 / max | n/a | 3.9 s / 13.2 s / 23.8 s | 1.09 s / 1.44 s / 2.08 s | 4.6 s / 15.4 s / 29.2 s |
| Over the 8 s runtime budget | n/a | 36 / 157 | 0 / 164 | 44 / 153 |

Single runs, n=164 per column; the two thinking-on columns differ from each other by about the
run-to-run noise one would expect at this size, so read them as one configuration measured twice.

Re-measured after the change below shipped (2026-09-11, an unqualified `turn-understanding-eval`
run, which now sends exactly what the runtime sends: `reasoning.enabled=false`, `temperature 0`):

| Shipped setting, second run | |
| --- | --- |
| Route accuracy | 92.7% (under-routed 1, over-routed 11) |
| Kind / family accuracy | 95.7% / 93.3% |
| References resolved | 19 / 30 (the 11 misses: 10 bare confirmations, 1 rejection) |
| Anaphora / confirmation / rejection / needs-tool route | 12/12, 12/12, 8/8, 10/10 |
| Calls that fell back | 1 (HTTP 429 after two retries) |
| Latency p50 / p90 / max | 1.0 s / 1.8 s / 12.3 s |
| Over the 8 s runtime budget | 2 / 163 |

The one remaining under-routed turn in both thinking-off runs is res-06 ("이 주제로 보고서
만들어줘, 출처 포함해서"), read as an in-room app request rather than research.

What the numbers say:

- The classifier does what it was built for. Under-routing drops from 37 turns to 1 or 2, the
  anaphora cases resolve 12/12 in every configuration, and the ten over-routed turns are the regex
  floor sending questions with 왜/어떻게/설명 to main, which the classifier is not allowed to undo.
- **With the provider default, thinking is on, and 36 of 157 successful readings took longer than
  the runtime's 8 s classifier timeout.** In a real turn those fall back to the regex reading, so
  about a quarter of turns run as if the feature were off, after waiting 8 s for nothing. The
  slowest cases are the low-confidence ones (file-05, res-09, no-05: 19 to 21 s).
- With thinking off, latency collapses (p90 1.44 s, nothing over budget, no fallbacks) and route
  accuracy is unchanged. The cost is references: 18/30 instead of 29/30. Every missed reference is
  a confirmation or rejection ("응", "그래", "yes do it", "아니 취소해") where kind and family were
  right but `refers_to_turn` was left empty. The anaphoric requests ("그거 다시 읽어줘", "다시 해줘")
  still resolve 12/12, and a bare confirmation is already covered by the offer the runtime injects
  from the previous reply.
- `low` is not a middle ground. On this model through OpenRouter it thought as long as the default
  (p90 15.4 s, 44 readings over budget, two outright timeouts at 30 s) and routed worse, with four
  of the eight rejections left on the dialog route. The choice is binary: thinking on or off.
- Recurring misreads in every configuration, all cost-only: 메모장/계산기/notepad are read as `app`
  rather than `host` (both route to main, where host tools always ride); `meta` questions about Aoi
  herself are read as `question` (both dialog). Kira settings questions are read as needing no
  tool.

**What was found, and changed, on the back of these numbers (2026-09-11).** Until this change the
runtime did not control reasoning on OpenRouter at all: the browser client mapped `reasoningEffort`
only for CLI providers and DeepSeek, and disabled thinking only for Kimi and OpenCode models, so the
classifier's "keep reasoning at least medium" rule never reached the wire and the provider-default
column was what shipped. Two edits followed:

- `chat()` now sends `reasoning: { enabled: false }` to OpenRouter when the config's
  `reasoningEffort` is `'none'`. Only `'none'` is mapped; other efforts stay provider-default, so
  nothing changes for a chat model unless its config asks for no thinking, in which case it now gets
  what it asked for.
- The classifier passes `'none'` and pins `temperature: 0` (`withThinkingDisabled`), instead of
  upgrading a `'none'` to `'medium'`. Both are provider-aware: a model that publishes a
  reasoning-effort list without `'none'` (the GPT reasoning models on the Responses API) keeps the
  caller's setting, and neither reasoning models nor the Responses API are sent `temperature`,
  because a rejected request is a classifier that never runs.

The `--reasoning-effort none` column is therefore what ships now; the CLI's unqualified run
measures that, and `--reasoning-effort default` reproduces the old behaviour. The accepted loss is
`refers_to_turn` on bare confirmations, which the runtime already covers by injecting the previous
offer. If that ever matters, the alternative measured here is thinking on with a 15 s timeout,
which the p90 says would still lose roughly one turn in ten.

## 3. What shipped

Six pieces, in the order they pay off.

### 3.1 Turn records (`aoiTurnRecord.ts`)

Every turn ends by writing one structured record: the user message, the delivered reply, the route
and why, the reading (kind, families), the tools that actually ran with their real outcomes (paired
from `tool_calls` to `tool` messages by id, classified with `classifyAoiToolResult`), the entities
touched (paths, URLs, quoted and backticked names, tool targets), the offers made (chips plus
offer sentences), and the question left open if the reply ended on one. Records are derived from
what the runtime did, never from what the model claimed.

The last six are rendered as a `Recent turns` system block in the per-turn prompt: oldest first,
T-1 is the previous turn, each line naming tools with outcomes, refs, offers, and open questions.
It sits in `perTurn`, next to the run goal, so the cacheable `base` is untouched. Persisted at
`<session>/aoi-turn-records/turns.json`, capped at 40, cleared on session reset.

Turns that a direct-action path answers in code (a chip, the music parser, the music intent
classifier) never reach `runConversation`; they record themselves from the memory-episode hook
(`recordAoiMemoryTurn` with `source: 'direct_action'`), with the action label as the tool, so
"그 노래 다시" after a chip-played song still has a referent.

### 3.2 The classifier (`aoiTurnUnderstanding.ts`)

One small model call per turn, generalizing the music intent classifier whose shape was already
measured to work. It reads the message with the recent turns, the open question, and the offers,
and answers one tool call:

```text
kind:                action_request | question | confirmation | rejection_or_correction | chitchat | meta
families:            app | file | command | browser | host | ida | ghidra | research | memory | image | none
refers_to_turn:      T-n position only (1 = the previous turn), converted to the record's turn index
referent:            exact string, must appear in the message or the records (grounding guard)
confidence:          high | medium | low
needs_clarification: only at low confidence for a request that changes something
clarification_options: two or three short answers
```

Validation rejects anything the model was not entitled to produce: kinds and families outside the
enum, a turn number not on record, an ungrounded referent (dropped, not fatal). Thinking is
**off** for this call, decided by measurement (section 2.1): with the provider default a quarter of
readings outran the 8 s timeout, and turning thinking off kept routing accuracy while cutting p90
from 13.2 s to 1.4 s. The music classifier measured the opposite for its task; this one was measured
for this prompt. Output cap 2048 (a ceiling, not a spend). Timeout 8 s, then null.

The call starts before the memory, mission, and context-router round trips and is awaited after
them, so its latency mostly hides behind work the turn already did. Null on any failure leaves the
turn exactly as it was before the classifier existed. The regex reading
(`inferAoiTurnUnderstandingFromRegex`) is the fallback and the offline baseline.

A Settings toggle (Conversation: "Read each message before answering") turns it off.

### 3.3 Route and tool decisions (`aoiTurnContext.ts`)

The regex router is the floor. A high-confidence classifier reading naming a real family, or an
escalation, can pull a turn from dialog to main and add tool families (app/file/command turn on
the app tool block, ida and ghidra their labs). Nothing can push a turn down to dialog or remove
a tool the regex would have exposed. Medium and low readings are shown to the model as context and
never move a tool.

The decision, its layer, and its reason are recorded on the run ledger entry (`routeReason`,
`understanding`), and the reading is appended to the prompt as a short block when it is worth
stating: kind, families, the referenced turn and referent, and one line of guidance for
confirmations, rejections, and anaphoric requests.

### 3.4 Mid-turn escalation (`request_capabilities`)

The dialog route carries one extra tool. If the model decides the turn needs files, commands, the
browser, the host, a lab, research, memory, or images, it calls `request_capabilities(families,
reason)` instead of answering. The runtime checks for it before anything else in the batch runs,
so a reply in the same batch is not delivered and then contradicted, and re-runs the turn on the
main route with those families added. One escalation per turn; on the re-run the tool is not
offered, and the run ledger entry continues (route flipped, `escalation` recorded) rather than
opening a second run. The system prompt for the dialog route states the rule in one paragraph,
replacing the case-by-case escape hatches.

### 3.5 Clarification

When the classifier reading is low confidence, the kind is `action_request`, at least one family
changes something outside the conversation, the classifier supplied a question, and the previous
turn was not already a question, Aoi asks the question with the supplied chips and makes no model
call. The turn record carries `outcome: 'clarification_asked'` and the open question, so the next
turn's reading and the model both see what the answer answers. Read-only requests and conversation
are never clarified.

### 3.6 Measurement

- The labelled corpus: 164 cases, Korean and English, chit-chat, questions with and without tool
  need, requests across every family, confirmations and rejections with the turn they depend on,
  anaphora with the tool that ran, and meta. Gold labels describe need, not the router's current
  behaviour.
- `aoiTurnUnderstandingEval.ts` scores any predictor: route, kind, families, references,
  over/under-routing, per kind and tag, with a failure list.
- `turn-understanding-eval` CLI: `--regex-only` offline; live mode runs the classifier through the
  OpenAI chat-completions wire against `~/.openroom/config.json` (or `--config-file`), applies the
  regex floor as the runtime does, and reports both.
- The run ledger now records `routeReason`, the reading, `promptTokensEstimate` at the seed request,
  and provider-reported `usageTotalTokens` summed over the run. The Settings ledger panel shows
  route reason, escalation, and tokens per run.

## 4. What did not change, on purpose

- `aoiIntentInference` (SA2) still infers what the user is doing at the desk from git, activity,
  and calendar signals, display-only. It is not the chat router and was not repurposed.
- The five regex escape hatches remain as the floor. They can be retired one at a time once the
  live eval shows the classifier plus escalation covering their cases.
- The prose fallback (the model answering without `respond_to_user`) is a rendering contract issue
  and is unchanged; a dialog-route model that says "I cannot" in prose cannot escalate.
- `performed_actions` is still verified against real dispatch, never taken from the model.

## 4.1 E2E mocks

Every e2e spec that mocks `/api/llm-proxy` now sees one extra request per turn, offered only the
`understand_turn` tool. Mocks that key off the call index, or push every call into a list, skip it
the way they already skip `resolve_music_intent`: check the request's `tools` and answer with no
tool call, which makes the turn fall back to the regex route. `aoi-turn-understanding.spec.ts` is
the spec that exercises the classifier itself.

## 5. Operational notes

- One extra provider call per turn. On OpenRouter this is one more 429 exposure; a 429 returns
  null and the regex floor applies.
- The recent-turns block costs roughly 300 to 700 tokens per turn at six turns; the budget is
  2,400 characters, each line shows at most six tools, and the oldest lines drop first.
- The classifier uses the main LLM config, as the music classifier does, with thinking disabled
  and a 2,048-token output ceiling. Using the main config is deliberate: the dialog model is the
  cheap one, but the one measured dialog candidate with zero `respond_to_user` compliance would
  fail every classifier call and silently switch the feature off. A CLI provider (codex, claude)
  spawns a process for it; the toggle exists for that case.
- Escalation is honoured only before any tool batch has started executing on the dialog attempt (a
  `list_apps` or `app_action` that already ran would be lost by the re-run and could be repeated;
  a plain-text iteration or a refused request does not count), and only for families this session
  can serve: `research` needs a Tavily key and `image` needs image generation configured.
  Otherwise the call is refused with the reason as its tool result, so the model tells the user
  what is missing instead of retrying. The re-run continues the ledger's iteration numbering and
  gets a fresh iteration budget on top of what the attempt spent; the attempt did no real work, and
  it repeats the memory, mission, and context-router loads (an accepted cost on a rare path).
- The classifier is skipped when the main model is a CLI or managed-auth provider (a process per
  call would usually outlive the 8 s budget); if the dialog model is an API provider it classifies
  instead, as the memory distiller does.
- Turn records survive a load race: a load that resolves after a turn already appended merges
  the two lists (persisted indices kept, in-memory records rebased after them), and a load that
  resolves after a session switch or clear-history is dropped. Proactive nudges, which arrive as a
  synthetic `[aoi-...]` user message, are not recorded as user turns.
- Clearing the chat history clears the turn records too; a next turn must not resolve 그거
  against a transcript the user no longer sees.
- Turn records are per session and are not memory: nothing in them is recalled beyond the last six
  turns, and a session reset clears them.

## 6. Open items

- Thinking is now off for the classifier (section 2.1). The eval CLI records per-case latency,
  confidence, and fallback reasons, so a model swap or prompt edit can be re-measured with one
  command; run it after any change to the classifier prompt.
- 메모장/계산기/notepad read as `app` instead of `host` in every configuration; the family
  description in `getAoiTurnUnderstandingToolDefinition` should name those examples under `host`.
- A "was this right?" control on the ledger panel would turn real turns into labelled data. Not
  built.
- Family-scoped tool narrowing (removing tools the regex would include) is deliberately off. It
  saves tokens and risks misses; revisit once the live numbers are in.
