# Aoi music intent: who understands, who acts, who reports

Design record for the chat path that turns "노래 틀어줘" into playback. Written 2026-08-24 after a
session that fixed the reported bug, then measured every assumption behind the fix. Every number
here was measured against the real app — its captured request bodies, its own run ledger, and the
live provider. Nothing here is estimated unless it says so.

The refactor this document authorises is at the end.

---

## 1. What went wrong, and why the fix was not where it looked

Reported transcript: Aoi recommended 에스파 "KISS N TELL" and printed its exact YouTube query.
Answering `에스파로 가자` played `[EP.07] 아우디즈의 찾아서 투어` — an unrelated variety episode.
Correcting her (`아니, 너가 추천한 에스파 노래 말야`) and confirming (`응 맞아`) produced nothing
but "다음 턴에 틀어줄게", repeated every turn.

Three independent defects, none of them a model failure:

| Defect             | Cause                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Wrong video played | The parser treated `에스파로 가자` as a fresh search and discarded the exact query the card already carried                                |
| Correction ignored | Every deferral pattern was anchored on a playback verb; a reference with none fell through                                                 |
| "다음 턴에" loop   | The turn shipped with **no app tools**, so the model could not act, and it filled the gap with the neighbouring web-search block's wording |

The third one is the structural finding. From the real run ledger
(`~/.openroom/sessions/aoi/space_adventure/aoi-run-ledger/runs.json`, which stores `modelRoute` +
`includeAppTools` + `exposedToolNames` per turn):

- **11 of 12** real chat turns shipped with 2 tools and no way to operate anything.
- **9 of 10** turns with at least one iteration recorded `plain_text_fallback`.

Aoi was not misbehaving. She was not equipped.

---

## 2. Measurements

### 2.1 Tool gating (why not simply attach everything)

End to end, from the captured request bodies:

|                           | tools | system prompt | tool schemas | total input            |
| ------------------------- | ----- | ------------- | ------------ | ---------------------- |
| dialog route              | 2     | 13,208 ch     | 1,562 ch     | 3,710 tok              |
| main route + full app set | 54    | 29,492 ch     | 49,218 ch    | 19,699 tok             |
| **delta**                 | +52   | +16,284 ch    | +47,656 ch   | **+15,989 tok (5.3x)** |

Acting never needed that. `list_apps` resolves the numeric id, `app_action` runs the action: **1,138
chars of schema, ~285 tokens**. The other 30 tool groups are file/IDE/workspace surface, plus a
15k-char policy block that is mostly file-path and guide.md rules.

Measured after attaching only those two on every tool-capable turn: **3,710 → 4,339 tok (+629,
+17%)**, and a dialog turn can reach the YouTube app.

### 2.2 Prompt cache

Replaying the real bodies against the provider, twice with different message sets:

|                             | cache hit | of prompt    | miss-priced   |
| --------------------------- | --------- | ------------ | ------------- |
| before the per-turn reorder | 2,176     | ~6,950 (31%) | 4,774 tok     |
| after                       | 4,736     | ~6,950 (68%) | **2,214 tok** |

The +629 of §2.1 lands inside the cached prefix, so its steady-state cost is close to nothing. Two
corrections worth keeping:

- A route flip does **not** evict the cache; each shape gets its own entry and pays one full miss
  the first time it appears (measured 5.2% hit on the switch).
- `chars/4` **underestimates Korean by ~22%** (5,712 estimated vs 6,950 actual). Trust
  `prompt_tokens`, not character counts.

### 2.3 respond_to_user compliance, per model

The app puts the user-visible message inside a tool call (`respond_to_user` is "terminal and must be
the final tool call"). Replaying the real dialog-route body (4 tools, 16 messages, `max_tokens`
8192, no temperature) on Korean conversational turns:

| model                        | respond           | chips | emotion | $/turn       |
| ---------------------------- | ----------------- | ----- | ------- | ------------ |
| **qwen/qwen3.7-flash**       | **9/12**          | 9/12  | 8/12    | **$0.00048** |
| anthropic/claude-haiku-4.5   | 8/12              | 6/12  | 5/12    | $0.0107      |
| minimax/MiniMax-M2.5         | 0/6               | 0/6   | 0/6     | $0.0028      |
| upstage/solar-pro4           | 0/6               | 0/6   | 0/6     | $0.0002      |
| google/gemini-2.5-flash-lite | 0/6               | 0/6   | 0/6     | $0.00057     |
| deepseek/deepseek-v4-flash   | 0/6 (0/12 direct) | 0/6   | 0/6     | $0.00061     |

Compliance tracks neither price nor Korean-nativeness. `solar-pro4` is a Korean-first model from a
Korean company and scored 0/6 — being good at Korean is irrelevant if the schema is never filled.
Predicting this from model metadata failed; only replaying the real body measured it.

Two gotchas found here:

- `claude-haiku-4.5` sometimes serialises `character_expression` as a JSON **string** instead of an
  object, so `args.character_expression.content` is undefined and the reply is lost. Worse than a
  prose fallback, which at least delivers text.
- `tool_choice: 'required'` is **refused while thinking mode is on** — HTTP 400 "Thinking mode does
  not support this tool_choice" on DeepSeek direct, and HTTP 400 for qwen via OpenRouter. Disabling
  thinking on DeepSeek did not restore compliance either (0/3).

So the plain-text fallback is not an exception to design around; on the configured model it is the
common path. It delivers the reply and still runs the app-action claim contract
(`declaredAppActions` defaults to `[]`, so the prose detector applies). What it cannot deliver is
the reply chips and the expression, both of which ride on `respond_to_user`'s arguments.

### 2.4 What happens with no parsing at all

Full agent loop, real system prompt, qwen (429s cut coverage to 3 of 7):

| input                          | outcome                                                      | latency    |
| ------------------------------ | ------------------------------------------------------------ | ---------- |
| `응 맞아`                      | exact offer query dispatched                                 | **19.2 s** |
| `그래 에스파 틀어줘`           | dispatched, but **rewrote** the query as `aespa KISS N TELL` | **15.6 s** |
| `너가 추천한 에스파 노래 말야` | **no action at all**                                         | 6.6 s      |

Latency is three model round trips (`list_apps` → `app_action` → `respond_to_user`) on a reasoning
model. And the decisive one — handed a tool result saying it started something else
(`{"title":"[EP.07] 아우디즈...","matchedQuery":false}`), the model's own reply was:

> "자, 바로 틀어줄게. 눈 떼지 말고 지켜봐."

**0 of 2 admitted the substitution.** The honest sentence in the shipped app ("에스파로 찾아서
[EP.07]... 틀었어") exists because _code_ builds it from the dispatch result.

### 2.5 Classifier accuracy

Ten Korean cases against the real prompt builder, tool definition and validator:

| variant          | correct  | mean latency | mean output | tool_choice     |
| ---------------- | -------- | ------------ | ----------- | --------------- |
| **reasoning ON** | **9/10** | **540 ms**   | 412 tok     | **400 refused** |
| reasoning OFF    | 6/9      | 1,488 ms     | 56 tok      | accepted        |
| OFF + forced     | 8/10     | 876 ms       | 50 tok      | accepted        |
| ON + forced      | —        | —            | —           | **400 refused** |

- Turning reasoning off **costs accuracy and does not buy speed**. Output tokens fell 412 → 56 but
  wall clock got worse; the latency was provider scheduling, not reasoning.
- The degradation is specific and _safe_: `뉴진스로 가자` and `프로미스나인으로 가자` became
  `reject_and_repick` instead of `search`. Distinguishing "named an alternative" from "refused, pick
  again" is exactly the small inference reasoning supplies. A wrong `reject_and_repick` plays
  nothing; it costs a turn.
- `그래서 그대는 틀어줘` (a title that opens with a filler word) **failed in all three variants**,
  always absorbed into the offer. The repaired parser handles this case correctly. **The classifier
  is not uniformly better than the parser.**

### 2.6 Where the bugs actually were

An adversarial review of this session's own additions, three passes, found **7 defects — all 7
inside the parser, 0 in the model path.** One of them reintroduced the original bug: comparing the
typed reply against the card's whole prose let a card naming another artist in passing resolve
`뉴진스로 가자` to the aespa query.

That is the honest case for shrinking the parser. §2.5 is the honest case for not deleting it.

---

## 3. The decision

Four layers, ordered by cost. Each owns exactly one thing.

| Layer           | Owns                                                                                                      | Model calls |
| --------------- | --------------------------------------------------------------------------------------------------------- | ----------- |
| 1. Chip literal | String equality on chips the app itself emitted (`▶ 재생`, a pending offer's `playPrompt`)                | 0           |
| 2. Exact recall | Reading back a string **the app printed**: the `YouTube 검색어:` line, a backticked query, a quoted title | 0           |
| 3. Classifier   | Everything else — the phrasing space, with reasoning ON                                                   | 1           |
| 4. Ack          | What actually started, from the dispatch result                                                           | 0           |

The distinction that matters, and the one this session got wrong twice:

> The thing worth keeping in code is **not "parsing what the user said"** — it is **"reading back
> the exact string the app printed"** and **"reporting what actually happened"**. The first is
> inference and belongs to the model. The other two are not inference at all.

Layers 1 and 2 are not language understanding. Layer 4 is not either — and §2.4 proves the model
will not do it.

### 3.1 Rejected, with the reason

| Option                                 | Why not                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| Attach the full app toolset every turn | +15,989 tok/turn for reach the minimal pair already provides (§2.1)                           |
| Delete the parser entirely             | 15–24 s per request, the model rewrites the exact query, and 0/2 honest reporting (§2.4)      |
| Turn thinking off for the classifier   | 9/10 → 6/9 accuracy, and no speed gain (§2.5)                                                 |
| Turn thinking off globally             | Costs the classifier, and on DeepSeek did not restore compliance (0/3)                        |
| `tool_choice: 'required'`              | Mutually exclusive with thinking mode; the reachable variant scores below reasoning-ON (§2.5) |
| Let the model write the ack            | 0/2 admitted a substitution (§2.4)                                                            |

---

## 4. Recommended model

**`qwen/qwen3.7-flash` via the `openrouter` provider, for both routes.**

Set `llm.model`; provider and key stay. There is no separate dialog entry in `config.json`, so
`resolveLlmOverride` inherits — one field covers both routes. It is not in the app's curated
OpenRouter list, so enter it as a custom model id.

Why it wins on the measured axes:

- Highest `respond_to_user` compliance of the tested set, with chips and emotion (9/12, 9/12, 8/12)
  — §2.3.
- Highest classifier accuracy (9/10 at 540 ms) — §2.5.
- $0.00048/turn: 5.8x cheaper than the MiniMax default, 22x cheaper than haiku.

What it does not fix: roughly a quarter of turns still land on the plain-text fallback, so chips and
emotion go from ~0% to ~75%, not to 100%.

Known caveats: it is a reasoning model (~2,100 output tokens on a full turn, and that is where the
persona quality lives, so leave reasoning on), and OpenRouter returned 429 on 4 of 7 sequential
calls during measurement — a three-round-trip design would triple that exposure, which is another
argument for layers 1–2.

**Alternative if reliability outranks cost:** `anthropic/claude-haiku-4.5`, but only with a
defensive parse for the double-encoded `character_expression` (§2.3), and at $0.0107/turn.

**Do not use** for this app: `minimax/MiniMax-M2.5` (the current default, 0/6 and the most expensive
of the cheap tier), `upstage/solar-pro4`, `google/gemini-2.5-flash-lite`,
`deepseek/deepseek-v4-flash` — all 0 on the contract that renders the reply.

---

## 4.1 Found while starting the refactor

Two defects in the classifier path, both from the same blind spot — treating the output cap and the
reasoning setting as free parameters when both had been measured:

- `MAX_CLASSIFIER_OUTPUT_TOKENS` was **96**. Reasoning tokens count against that cap, and §2.5
  measured 412 output tokens mean / 1,065 worst. Verified against the live provider: at 96 the
  answer is cut off before the tool call every time (`finish_reason=length`, zero tool calls), so
  **the classifier returned null on every turn and layer 3 was dead in shipped code**. Raised to
  2048; it is a ceiling, not a spend.
- The classifier inherited the chat model's `reasoningEffort`, so a global 'none' would have
  silently taken accuracy from 9/10 to 6/9. Pinned: 'none' is substituted, any other value is left
  as the operator set it.

Also settled while checking: `temperature: 0` **is** accepted by qwen via OpenRouter. The existing
"reasoning models reject temperature" comment does not apply to this provider, and both variants
classify correctly.

The lesson for the rest of the refactor: §2 is not background reading. Any constant that touches the
classifier has a measured value behind it.

## 5. Refactor scope

**Shrinks** — the inference-heavy parsing in `lib/chatDirectActions.ts`, which is where all 7 review
defects lived. Each case it currently guesses at moves to the classifier, which reads the phrasing
space and returns a candidate id rather than a string it composed:

- the suffix/prefix phrasing patterns
- lead-in stripping and its interjection/ambiguous split
- the placeholder ("다른거") family
- the offer alias window
- the pick-reference patterns
- the bare-confirmation path

**Stays, deliberately:**

- chip equality and the pending-offer accept path (layer 1)
- the exact-recall extractors, including the code-shaped-candidate guard that keeps a backticked
  path from becoming a search (layer 2)
- `그래서 그대는`-style handling if it cannot be moved without regressing §2.5
- the whole ack path: `isFailedAgentActionResult`, `parseStartedVideo`, `buildMusicSubstituteAck`
  (layer 4)
- `getMinimalAppToolDefinitions` on every tool-capable turn
- the per-turn prompt block grouped stable-first

**Invariants for the refactor.** The existing suites are the safety net; none of these may regress:

1. A tapped chip dispatches with zero model calls.
2. An offer resolves to the query the card printed, never to a paraphrase.
3. A card naming another artist in passing never resolves to the offered pick.
4. The ack names what actually started whenever it differs from the query.
5. A refused pick is never replayed.

---

## 5.1 What shipped

The parser went from 770 lines to 534. `parseDirectMusicIntent` is three branches:

1. `isDirectPlaylistPlaybackIntent` → null, because saved-playlist playback is a different action.
2. A tapped chip → the card's own printed pick, zero model calls.
3. **A pick on the table → null.** The classifier owns it.
4. Nothing on the table → an explicit playback verb with a subject, taken verbatim, with the
   `A 말고 B` split and the unsearchable-word guard kept.

Deleted: the offer-selection upgrade and its alias window, lead-in stripping and its two word
classes, the bare-confirmation path, pick-reference-to-query resolution, and history enrichment.
Those were the six mechanisms behind the seven review defects.

Kept and re-gated: the honest "I cannot find it" ack now requires there to be **no candidate at
all**. Without that gate the parser's new deference would have turned every "그거 틀어줘" into
"미안, 못 찾겠어" while the pick sat in the transcript.

Test contract moved with it. 25 unit tests asserted the old behaviour and now assert the new one —
the same inputs, expecting null with the reason written next to them. Two e2e specs moved from "the
parser resolved this with zero model calls" to "the classifier resolved it and code dispatched its
exact query"; what they assert about the _outcome_ is unchanged, which is the point.

## 4.2 z-ai/glm-5.3-flash, measured 2026-08-27 and not adopted

Released the same day and reported by the operator as noticeably better to talk to. Measured on both
suites, and the two disagree, so it is recorded rather than adopted.

|                     | qwen3.7-flash (shipped) | glm-5.3-flash |
| ------------------- | ----------------------- | ------------- |
| respond_to_user     | 9/12 (75%)              | 7/10 (70%)    |
| chips / emotion     | 75% / 67%               | 60% / 70%     |
| classifier accuracy | **9/10**                | 8/10          |
| classifier latency  | **434-540 ms**          | **5,572 ms**  |
| cache observed      | 0%                      | **64-92%**    |
| $/turn (chat)       | $0.00048                | **$0.000436** |
| 429s during probing | 4 of 7 in a burst       | none          |

glm wins on cost, on cache — it actually caches, where qwen reported 0% — and on rate-limit
resilience. It loses on one axis that outweighs those here: the classifier sits in the user's wait
path, and 5.5 s against 0.5 s is the same objection that rejected removing the parser entirely
(§2.4).

The latency is not a network artifact. Back to back, same moment, same prompt and tools: glm 5,549 /
5,731 / 5,436 ms against qwen 382 / 507 / 412 ms. Output was 100-600 tokens, so it is not compute,
and the spread is under +-150 ms. A model released hours earlier may simply be under-provisioned,
which is a reason to re-measure rather than to conclude.

Its compliance misses were all `list_apps` first, including on "오늘 좀 피곤하다" — harmless but a
wasted round trip.

What the probes do not measure: conversation quality, which is the axis the operator judged it on
and the one they are better placed to judge. If the latency improves, the split worth building is
glm for the conversation and qwen for the classifier, which needs a classifier-model override the
code does not have yet (the classifier inherits the chat config today).

**Decision: no change. Re-measure the classifier latency in a few days.**

## 5.2 The one known regression, and a failed attempt at it

Handing the phrasing space to the classifier lost the one case the repaired parser handled:
`그래서 그대는 틀어줘`, a title that opens with a word that also works as filler, gets absorbed into
the offer (§2.5, all three reasoning variants).

**Tried and reverted:** a prompt rule telling the classifier that a title can open with filler and
to judge by whether the subject appears in any candidate. It did not fix the target case and cost
four that already worked — 6/11 against a 9/10 baseline, including two turns that produced no tool
call at all. Recorded so the same edit is not attempted twice: this is not a wording problem.

**Fixed instead, and it was a real defect underneath:** one card names its pick twice — the exact
query behind `YouTube 검색어:` and the bare title quoted in the prose — and
`collectMusicPickCandidates` offered both as separate candidates. Measured, the classifier answered
with the weaker one (`KISS N TELL` instead of the query carrying the artist and `MV`). A shape
contained in another shape from the same message is the same pick said shorter, so only the longest
survives. That removed the ambiguity without touching the prompt.

The filler-opening-title case remains open. It needs a candidate a user actually asks for while a
card is on screen, and its failure mode is playing the offered pick — which the ack names, so it is
visible and recoverable.

## 6. Open items

- The classifier's `그래서 그대는` miss (§2.5) is unexplained; it may be the candidate list crowding
  out a plain search, which a prompt change could fix.
- Coverage gaps from 429s: 4 of 7 no-parse cases, 1 of 10 classifier cases.
- All model figures are n≈10 per cell, single run, one model per row.
- Cache figures come from DeepSeek direct; OpenRouter reported 0% cached for everything except
  MiniMax (44%), and Anthropic caching needs `cache_control` breakpoints the app does not send.
