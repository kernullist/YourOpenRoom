# Signal Desk — Storage & Integration Guide

Signal Desk (appId 30, route `/signal-desk`) is a real-feed triage console. Unlike CyberNews (app
14, in-world fiction), every item here is a real external signal.

## Architecture: who talks to the internet

The app never does. `src/lib/signalDeskPlugin.ts` (a Vite dev-server plugin, registered in
`apps/webuiapps/vite.config.ts`) fetches a **fixed source registry** server-side and serves two
local routes. The allowlist is enforced by construction: outbound URLs come only from
`SIGNAL_DESK_SOURCES`, and no client parameter participates in forming a URL. Interest weighting
reads Aoi's interest profile via `loadAoiInterestProfile` (node-only chain) — server-side only; the
app receives the computed result.

### Local routes

- `GET /api/signal-desk/signals?sessionPath=&category=&refresh=&limit=` →
  `{ ok, fetchedAt, cache: fresh|cached, sources: SignalSourceOutcome[], items: SignalItem[], interest: InterestMeta }`
- `GET /api/signal-desk/brief?sessionPath=&refresh=` →
  `{ ok, cache, brief: SignalBriefDoc, sources: SignalSourceOutcome[] }`

Snapshot cache TTL is 10 minutes; `refresh=1` bypasses it. Non-GET returns 405.

### Source registry (fixed)

| id             | kind     | category | feed                                             |
| -------------- | -------- | -------- | ------------------------------------------------ |
| cisa-kev       | kev-json | vuln     | CISA Known Exploited Vulnerabilities JSON        |
| msrc           | rss      | msrc     | MSRC Security Update Guide                       |
| secret-club    | rss      | research | secret.club (game hacking / anti-cheat research) |
| connor-mcgarr  | rss      | research | connormcgarr.github.io (kernel exploitation)     |
| arxiv-cscr     | atom     | paper    | arXiv cs.CR newest submissions                   |
| gh-x64dbg      | atom     | release  | x64dbg GitHub releases                           |
| gh-hyperdbg    | atom     | release  | HyperDbg GitHub releases                         |
| openai-news    | rss      | ai       | OpenAI news                                      |
| deepmind       | rss      | ai       | Google DeepMind blog                             |
| huggingface    | rss      | ai       | Hugging Face blog                                |
| simonwillison  | atom     | ai       | Simon Willison (model + harness coverage)        |
| gh-claude-code | atom     | harness  | Claude Code GitHub releases                      |
| gh-codex       | atom     | harness  | OpenAI Codex CLI GitHub releases                 |
| gh-gemini-cli  | atom     | harness  | Gemini CLI GitHub releases                       |

The declared `kind` is display metadata; XML feeds are parse-auto-detected (RSS first, Atom
fallback) because Jekyll-style blogs serve Atom from `feed.xml`.

## Data Schemas

Wire types live in `src/lib/signalDeskShared.ts` (node-free; the only signal-desk lib module app
code may import).

### SignalItem

| field                 | type                                           | notes                                                                    |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| id                    | string                                         | stable hash of sourceId + normalized url                                 |
| title / url / summary | string                                         | summary may be empty (rendered as "not provided")                        |
| sourceId / sourceName | string                                         | collecting source                                                        |
| category              | 'vuln'\|'msrc'\|'research'\|'paper'\|'release'\|'ai'\|'harness' |                                                         |
| publishedAt           | ISO string                                     |                                                                          |
| score                 | number                                         | recency + source weight + KEV boost + interest matches + duplicate boost |
| scoreReasons          | string[]                                       | human-readable contributions, rendered as chips                          |
| cveIds                | string[]                                       | extracted `CVE-YYYY-NNNN...`, used for cross-source dedup                |
| kev                   | boolean                                        | listed in CISA KEV                                                       |
| duplicateCount        | number                                         | merged duplicates beyond this item                                       |
| otherSources          | string[]                                       | names of merged sources                                                  |

### SignalSourceOutcome (honesty contract)

`ok: false` + `error` is structurally different from `ok: true` + `itemCount: 0`. The UI renders
failed sources as named failures (partial banner in Inbox, red rows in Sources) and never as an
empty feed.

### InterestMeta

`{ applied, keywordCount, reason?, detail? }` — when not applied, `reason` is one of `no-session` /
`no-profile` / `profile-error` (+detail). Rendered verbatim in the header meta line; a failed
profile read is never displayed as "default ranking by choice".

## NAS Storage (`apps/signaldesk/data/`)

### state.json

| field       | type                        | default                               |
| ----------- | --------------------------- | ------------------------------------- |
| version     | 1                           | 1                                     |
| activeView  | 'inbox'\|'brief'\|'sources' | inbox                                 |
| category    | 'all'\|category             | all                                   |
| sessionPath | string                      | seeded from live session on first run |
| seenIds     | string[]                    | [], capped at 300 (newest kept)       |

`SYNC_STATE` re-reads it with defensive field-by-field merge.

### briefs/{YYYY-MM-DD}.json

`SignalBriefDoc`: `{ version: 1, date, generatedAt, headline, caveats[], sections[], interest }`.
Written only by the operator's save click; listed and reopened in the Brief view. `headline` always
states signal/KEV/source-ok counts; `caveats` name failed sources and interest non-application.

## AoiResearch handoff

The expanded row's "Research 인계" button calls `startAoiResearchRun` from `@/lib/aoiResearchClient`
with a composed request (title, url, CVEs, summary, analysis framing) and the desk's `sessionPath`.
A 409 duplicate answer renders as _denied_ (guard working), other failures as errors. This path is
operator-click only and deliberately not an agent action.

## Testing

- `src/lib/__tests__/signalDeskCore.test.ts` — parsers, dedup, scoring, brief.
- `src/lib/__tests__/signalDeskPlugin.test.ts` — routes with injected fetch/interest loader.
- `src/pages/SignalDesk/__tests__/` — types, view helpers, api classification, StatePanel RTL, index
  RTL (bootstrap/agent/handoff/brief), actionSafety source scan.
- `e2e/signal-desk.spec.ts` — stubbed routes; every test sets its own view/filter/session explicitly
  because state.json persists across the shared e2e home.
