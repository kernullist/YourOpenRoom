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

Re-measured 2026-09-11 after the playback slots (section 3.7) were added to the tool and the
prompt, n=176 (the twelve playback cases included), thinking off, same model:

| | First slot wording | Final slot wording (shipped) |
| --- | --- | --- |
| Route accuracy | 94.3% | 93.2% |
| Under-routed / over-routed | 1 / 9 | 1 / 11 |
| Kind / family accuracy | 94.9% / 93.2% | 95.5% / 90.9% |
| References resolved | 26 / 32 | 28 / 32 |
| Music slots (12 cases) | 4 / 12 | 10 / 12 |
| Anaphora / confirmation / rejection route | 13/13, 13/13, 8/8 | 13/13, 13/13, 8/8 |
| Calls that fell back | 0 | 0 |
| Latency p50 / p90 / max | 1.23 s / 1.81 s / 2.72 s | 1.27 s / 1.93 s / 2.71 s |
| Over the 8 s runtime budget | 0 / 176 | 0 / 176 |

The extra prompt line did not move routing outside the run-to-run band seen above (92.7 to 94.3%
across five single runs); the family figure moved by four cases between the two runs, which is the
same band. The slot rewrite is what took music slots from 4 to 10.

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

### 3.7 Playback requests are read before they play (`aoiMusicPreference.ts`, 2026-09-11)

The direct music parser used to own the whole sentence: everything in front of 틀어줘 became the
YouTube query, so 에스파 내가 좋아하는 노래 틀어줘 searched the literal words while the taste memory
held the aespa track the user had played. Extending the parser with another regex per phrasing was
rejected ("이렇게 일일이 파서를 정규식으로 대응하려면 끝이 없을것 같아"); reading the sentence is
language and belongs to the classifier, and the parser keeps only the mechanics.

- `understand_turn` gained two slots. `music_target` is the exact words the user used for a
  title or artist; the parser drops any value that does not appear verbatim in the message
  (`isGroundedAoiReferent`), so the model cannot compose a title. `music_reference` is
  `none` (they named it), `taste` (내가 좋아하는, 자주 듣는, my favorite, the one I always play,
  with or without an artist), or `offered_pick` (they mean something Aoi offered).
- In `executeSend`, a typed playback request the parser recognises is classified first (one
  call, thinking off, the same budget as every other turn). A tapped play chip and a request that
  names a pick already on the table are not language and still play with no classifier call, so
  `aoi-music-bare-pick-replay` (0 model calls) and `aoi-music-offer-selection` (0 conversation
  calls) hold. The reading is handed to `runConversation` when the turn falls through, so it is
  never paid for twice.
- `decideAoiDirectMusicPlayback` turns the reading into one of five actions. No reading (setting
  off, timeout, CLI provider) keeps the parser's literal query, which is exactly the old behaviour.
  A literal request plays the parser's query, not the classifier's target: on the first measurement
  the target dropped the artist on two of four literal cases ("에스파 KISS N TELL 틀어줘" ->
  "KISS N TELL"), and a bare title is how an unrelated upload with that title gets played (the
  failure the subsumes-pick rule in `chatDirectActions` already guards). The slots decide what
  kind of request it is; the typed words decide what is searched. A taste reference looks up the
  newest remembered user play by that artist in `recentPlays`, matching across spellings through
  an alias table (에스파 / aespa / エスパ are one row; Latin aliases match on token boundaries so
  `ive` cannot match LOVE DIVE). Two structural guards sit in front of that lookup: a remembered
  label that is contained in the present request is skipped (it is the literal search these words
  ran last time, recorded as a play when its result autoplayed, and names no song), and a target
  that is the whole of the parser's query isolated nothing and reads as no artist. A target longer
  than the act ("에스파 내가 좋아하는 노래") is keyed on the act the alias table finds inside it. With
  no remembered play by that artist it searches the artist alone and the ack says so and asks for
  the song to remember; with no artist and no memory it falls into the existing taste-recommend
  branch (which asks for a lane when nothing at all is known). A high-confidence reading that names
  no app family and is either not a request (question, chitchat, meta) or a request for another
  family ("발표 자료는 어제 만든 버전으로 해줘" matches the parser's "...으로 해줘" pattern and reads as
  file) hands the turn to the model with the reading attached, instead of playing a misread; medium
  confidence does not, because the parser's judgement is the floor.
- The ack names the memory it used (전에 네가 들었던 에스파 곡으로 "…" 틀었어 / 기억해 둔 뉴진스 곡이
  없어서 "뉴진스"로 찾아서 틀었어), in ko/ja/zh/en, so a wrong pick is visible and correctable, and
  it is built from the dispatch result, never from the classifier's words.
- The corpus gained twelve playback cases (`music-01`..`music-12`) with a `music` gold label;
  the eval scores the slots as `music slots n/m` for classifier predictions only (the regex
  reading has none), and a corpus test asserts every gold target appears in its text.
- Measured 2026-09-11 (qwen3.7-flash, thinking off, `--tag music`). First prompt wording: 4/12,
  reference right on 11/12 but the target carried the taste words ("에스파 내가 좋아하는 노래") on
  five cases and dropped the artist on two literal cases. After the slot description and prompt
  line were rewritten to "artist and/or title exactly as written, including the artist; omit when
  neither is named": 9/12 on two consecutive runs, mean latency 1.6 s. The three left: music-05
  ("프로미스나인 ... 곡으로 가자" is not read as playback at all, so the parser's literal query
  plays), music-06 ("play my favorite aespa song" reads taste with no target, so the newest
  remembered play of any artist plays, with an ack that names it), and music-12 (a confirmation
  of an offered pick, which the runtime never classifies because a pick on the table goes to the
  music classifier). In the full-corpus run with the final wording music-12 was read correctly and
  the slots scored 10/12; the full-corpus numbers are in section 2.1.
- The alias table is data about artist names, not a parser over the user's words; adding a row is
  the only maintenance it needs. It is the one place a new act has to be taught before its Hangul
  and Latin spellings match the same remembered play.

### 3.8 The classifier model is its own setting (`aoiTurnClassifierConfig.ts`, 2026-09-11)

The classifier used to follow the main model unconditionally (dialog model standing in for a CLI
main model). Measuring DeepSeek flash through the official endpoint showed why that coupling is
wrong: as a reader it beats qwen3.7-flash on every slot, as a router it loses, and the two are the
same call.

| classifier, thinking off, n=176 | qwen3.7-flash (OpenRouter) | deepseek-flash (official) | deepseek-flash, thinking on |
| --- | --- | --- | --- |
| Route accuracy / under-routed | 93.2-94.3% / 1 | 88.6% / 11 | 90.3% / 8 |
| Kind / family accuracy | 95.5% / 90.9% | 98.9% / 96.6% | 97.7% / 94.9% |
| References / music slots | 28/32 / 10/12 | 30/32 / 12/12 | 32/32 / 11/12 |
| Confidence high / medium / low | 165 / 3 / 8 | 136 / 24 / 16 | 143 / 19 / 14 |
| Latency p50 / p90 | 1.27 s / 1.93 s | 1.07 s / 1.45 s | 1.46 s / 2.38 s |

Nine of DeepSeek's eleven under-routed turns are medium-confidence readings with the right kind
and family ("delete the temp folder", "리서치 시작해", "일러스트 하나 만들어줘"); the route rule
needs high. Letting medium pull to main would put it at about 93.7% with qwen unchanged. That rule
change is not made here; it needs the over-routing side measured on gold-dialog mediums first.

As a main model the picture inverts. On the real captured dialog-route body (12 Korean
conversational turns) qwen answered with `respond_to_user` 0/6 times at 31-57 s p50 with thinking
on; official DeepSeek flash 8/12 at 4.8 s. On the main-route body (54 tools, ~19.8k prompt tokens)
both are poor (DeepSeek 2/12 on, 1/12 off), a prompt problem rather than a model one. DeepSeek
thinks by default when no reasoning effort is sent, so the effort should be set explicitly.

What shipped:

- `classifierLlm` in the persisted config, a `Turn Classifier Model` card in Settings > Models
  beside Dialog Model (API providers only; provider, key, endpoint, model). Blank fields inherit
  from the main model when the provider matches, as dialogLlm does.
- `resolveTurnClassifierConfig(main, dialog, classifier)`: the explicit override wins when it can
  be called (endpoint, model, an API provider, and a key unless the provider is a local server);
  otherwise the previous behaviour, main model or dialog fallback for a CLI main. A remote
  override with no key is ignored rather than tried, because a classifier that 401s on every turn
  is indistinguishable from one that is off.
- Both call sites (the pre-playback read in `executeSend` and `runConversation`) resolve through
  it; the live config is re-read on every send like the dialog config.
- E2E: the classifier request is asserted to carry the override's endpoint and model while the
  conversation request keeps the main model's.

### 3.9 Written data reaches its app, and a report is not a request (2026-09-11)

The first turn on DeepSeek flash as the main model showed the shape of the next failure. A
YouTube `PLAY_VIDEO` report arrived as a turn with the full 59-tool set and the instruction "read
its meta.yaml and respond accordingly"; the model made twelve tool calls, wrote
`apps/diary/data/entries/mission-list-2026-09-11.json` (success), focused the Diary window, ran
into the loop guard's budget message, and told the user the entry was on the page. The file was
real. The Diary showed "No diaries yet", because its meta.yaml protocol is write-then-dispatch
`CREATE_ENTRY {filePath}` and the dispatch never came; an app re-reads its data only at startup.
The app-action claim contract did not fire: it arms on a user request for playback or open, this
"user message" was a synthetic report, and "써넣었어" is not a claim shape it knows.

Two rules, both structural, neither reading prose:

- **Written data reaches its app** (`aoiAppMutationSync.ts`). After a successful `file_write`,
  `file_patch`, or `file_delete` under `apps/<app>/data/` while that app's window is open, the
  runtime plans the sync from the app's declared actions (a `CREATE_`/`UPDATE_`/`DELETE_` action
  whose params are a file path or an id, else a parameterless `REFRESH_`/`SYNC_STATE`; the app's
  own state file, a file directly under the data root, takes only the parameterless kind, since
  CREATE_ENTRY on state.json would have the Diary read state as an entry), dispatches it,
  records it in the run ledger as `app sync <app> <ACTION>(<path>) -> <result>`, and appends a note
  to the tool result so the model knows what ran. `respond_to_user` is then checked per written
  file: a file written while its app was open, with no successful sync covering it (runtime or
  model; a record action covers the file its params name, a whole-app refresh covers all), fails
  the postcondition and the correction names the exact call. The obligation is decided at write
  time: a file written while the app was closed owes nothing, because the app re-reads it when it
  opens, even when the model opens it later in the same turn (and a dispatch would open its
  window). A failed attempt is reported through the transcript rather than re-demanded; a file
  with no plan cannot block. This is the meta.yaml header's own rule, enforced by the runtime
  instead of hoped for from the model. The adversarial pass found the three cases this wording
  encodes: state.json planned as CREATE_ENTRY, one synced file passing for two written, and a
  write-then-open turn demanding a sync the open already made.
- **A report is not a request** (`aoiAppEventTurn.ts`). A turn whose message starts with
  `[User performed action in …]` keeps the conversation tools and the app tools a reaction can
  need (`list_apps`, `app_action`, schema/state/intent readers, memory) and loses everything that
  writes files, runs commands, drives the host or browser, or searches. The prompt says so in
  place of the meta.yaml line, with the one exception kept: a game reports the user's move and
  Aoi answers with her own through `app_action`. The classifier is not called on these turns.
  Initiative has its own path in this project (the autonomy loop, proposals, the L1-L4 gates,
  approval); a reaction turn with file tools bypassed all of it.
- The loop guard's stall and budget messages now end with: report only what completed; a step
  not finished is remaining work, never described as done.

E2E (`aoi-app-data-sync.spec.ts`): a scripted model writes a diary entry and claims it is there
without dispatching; the open Diary shows the entry, the ledger carries
`app sync diary CREATE_ENTRY`, and no correction round was needed. A user search in YouTube
becomes an event turn whose request carries `respond_to_user` and `app_action` but no
`file_write`, `host_process_spawn_preview`, or `search_web`, and no classifier call.

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
tool call, which makes the turn fall back to the regex route. Since 2026-09-11 a typed playback
request the direct parser recognises makes that call too (section 3.7); a play chip and an offered
pick do not. `aoi-turn-understanding.spec.ts` is the spec that exercises the classifier itself,
including the taste-resolved and artist-fallback plays.

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
- Medium-confidence readings do not pull a turn to main (section 3.8). With DeepSeek flash as the
  classifier that is the whole routing gap; measure over-routing on gold-dialog mediums before
  relaxing the rule.
- The playback slots (section 3.7) are measured on the corpus (`--tag music`) but not yet on real
  turns; the direct-action turn record carries `play_music(play_remembered)` /
  `play_music(play_artist_fallback)` so the ledger panel can show which memory path ran.
- Taste lookup keys on the artist only. "에스파 발라드 중에 내가 좋아하는 거" resolves to the newest
  aespa play regardless of mood; a genre or mood filter over remembered plays is not built.
