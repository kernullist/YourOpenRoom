# Kira Data Guide

## Folder Structure

```
/
├── works/
│   ├── {workId}.json
│   └── ...
├── analysis/
│   ├── project-discovery-{projectName}.json
│   └── ...
├── comments/
│   ├── {commentId}.json
│   └── ...
└── state.json
```

## Work Files `/works/{workId}.json`

Each work item is stored as one JSON file. The filename must match `id`.

| Field         | Type   | Required | Description                                                           |
| ------------- | ------ | -------- | --------------------------------------------------------------------- |
| id            | string | Yes      | Unique work ID, same as filename without `.json`                      |
| type          | string | Yes      | Must be `"work"`                                                      |
| projectName   | string | Yes      | Selected local project name under `kira.workRootDirectory`            |
| title         | string | Yes      | Work title                                                            |
| description   | string | Yes      | Markdown implementation brief that sub-agents can later read directly |
| status        | string | Yes      | One of `todo`, `in_progress`, `in_review`, `blocked`, `done`          |
| assignee      | string | No       | Optional owner or agent label                                         |
| clarification | object | No       | Pre-worker clarification state for ambiguous work briefs              |
| createdAt     | number | Yes      | Unix timestamp in milliseconds                                        |
| updatedAt     | number | Yes      | Unix timestamp in milliseconds                                        |

Example:

```json
{
  "id": "wire-kira-actions",
  "type": "work",
  "projectName": "YourOpenRoom",
  "title": "Wire Kira app actions into the orchestrator",
  "description": "# Brief\n\n- Read Kira meta and guide files\n- Pick todo works\n- Update status when the worker starts\n- Leave review notes as comments",
  "status": "todo",
  "assignee": "planner-agent",
  "createdAt": 1776200000000,
  "updatedAt": 1776200000000
}
```

## Clarification State

Kira analyzes each `todo` work brief before assigning it to workers. If the brief is ambiguous in a
way that could materially change the implementation, Kira blocks the work and writes a
`clarification` object onto the work file.

| Field      | Type   | Required | Description                                                       |
| ---------- | ------ | -------- | ----------------------------------------------------------------- |
| status     | string | Yes      | One of `pending`, `answered`, or `cleared`                        |
| briefHash  | string | Yes      | Hash of the project name, title, and description that was checked |
| summary    | string | Yes      | Short reason why clarification was or was not needed              |
| questions  | array  | Yes      | Questions to show before worker assignment                        |
| answers    | array  | No       | User answers after the pending questions are submitted            |
| createdAt  | number | Yes      | Unix timestamp in milliseconds                                    |
| answeredAt | number | No       | Unix timestamp in milliseconds for submitted answers              |

Question objects:

| Field             | Type     | Required | Description                                                   |
| ----------------- | -------- | -------- | ------------------------------------------------------------- |
| id                | string   | Yes      | Stable question ID such as `q-1`                              |
| question          | string   | Yes      | User-facing clarification question                            |
| options           | string[] | Yes      | Multiple-choice options; may be empty for open-ended answers  |
| allowCustomAnswer | boolean  | Yes      | Whether the user may write a custom answer outside the option |

Answer objects:

| Field      | Type   | Required | Description                           |
| ---------- | ------ | -------- | ------------------------------------- |
| questionId | string | Yes      | ID of the answered question           |
| question   | string | Yes      | Question text at the time of answer   |
| answer     | string | Yes      | User answer or selected option string |

When answers are submitted, Kira changes the work back to `todo` and appends a generated
`## Clarification Answers` section to the markdown description. That generated section is rewritten
idempotently so repeated saves do not duplicate answer blocks.

## Comment Files `/comments/{commentId}.json`

Comments are intentionally lightweight and belong to a work.

| Field     | Type   | Required | Description                                         |
| --------- | ------ | -------- | --------------------------------------------------- |
| id        | string | Yes      | Unique comment ID, same as filename without `.json` |
| taskId    | string | Yes      | Related work ID                                     |
| taskType  | string | Yes      | Must be `"work"`                                    |
| author    | string | Yes      | Short author label                                  |
| body      | string | Yes      | Plain-text comment body                             |
| createdAt | number | Yes      | Unix timestamp in milliseconds                      |

Example:

```json
{
  "id": "comment-review-01",
  "taskId": "wire-kira-actions",
  "taskType": "work",
  "author": "reviewer-agent",
  "body": "Please preserve createdAt when updating work items.",
  "createdAt": 1776203600000
}
```

## Analysis Files `/analysis/project-discovery-{projectName}.json`

Saved project analysis snapshots live here so future discovery runs can reuse them.

- These files are generated by the main AI analysis flow.
- They capture candidate feature and bug tasks for the active project.
- The saved findings can later be turned into todo works inside Kira.

## Project Settings File (inside the selected local project)

Kira also reads an optional project-local settings file:

```
{projectRoot}/.kira/project-settings.json
```

Current fields:

| Field                | Type    | Default      | Description                                                                                                                        |
| -------------------- | ------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| autoCommit           | boolean | `true`       | If `true`, Kira will try to git-commit approved work using the reviewer’s suggested commit message                                 |
| requiredInstructions | string  | `""`         | Mandatory project instructions, such as coding style or architecture rules, enforced for workers, reviewers, and attempt selection |
| runMode              | string  | `"standard"` | One of `quick`, `standard`, or `deep`; controls orchestration, worker count, validation depth, and review depth                    |
| rulePacks            | array   | `[]`         | Enabled preset rule packs. Each item is `{ "id": string, "enabled": boolean }`                                                     |

Example:

```json
{
  "autoCommit": false,
  "requiredInstructions": "Follow the existing coding style and reject attempts that skip validation.",
  "runMode": "deep",
  "rulePacks": [
    { "id": "strict-typescript", "enabled": true },
    { "id": "validation-first", "enabled": true },
    { "id": "small-patch", "enabled": false }
  ]
}
```

If the project file is missing, Kira falls back to `kira.projectDefaults` from
`~/.openroom/config.json`. If that is also missing, `autoCommit` defaults to `true` and
`requiredInstructions` defaults to an empty string, `runMode` defaults to `standard`, and no rule
packs are enabled. A project-local `rulePacks` list intentionally overrides inherited defaults, even
when it is empty.

When `requiredInstructions` or rule-pack instructions are not empty, Kira injects the combined
effective instructions into worker, reviewer, and multi-worker selection prompts as binding
acceptance criteria. Reviewers and attempt judges must reject attempts that violate them.

Available rule pack IDs:

- `strict-typescript`
- `small-patch`
- `validation-first`
- `frontend-runtime`
- `safe-refactor`
- `docs-safe`

## Project Intelligence Profile

Kira can generate a project-local intelligence profile:

```
{projectRoot}/.kira/project-profile.json
```

The profile is generated from the Kira project panel when no profile exists, refreshed from the same
panel after it exists, or generated automatically during worker context scans. It records:

- repository map, source roots, test roots, docs, entrypoints, and config files
- detected style/tooling signals and architecture notes
- candidate validation commands and related test files
- high-risk files, generated paths, and concurrency notes
- recommended worker specializations such as `frontend-ui`, `backend-api`, `test-validation`,
  `tooling-config`, and `docs-maintainer`
- recent review failures, validation failures, repeated patterns, worker guidance rules, and
  decomposition recommendations

Workers and reviewers receive the profile as part of the context scan. Kira also uses it to:

- collect smarter task-specific context before planning
- require a pre-edit `changeDesign` with target files, invariants, expected impact, validation
  strategy, and rollback strategy
- validate preflight plan quality, low-confidence plans, missing change designs, and over-broad
  intended file lists
- infer task-type playbooks, dependency hints, semantic code graph nodes, requirement traceability,
  runtime validation signals, risk review policy, and uncertainty escalation signals before a worker
  edits files
- require planners to compare patch alternatives and select one approach before implementation
- infer targeted validation commands from changed files and nearby test files before falling back to
  broader project checks
- run a clarification quality gate so unresolved high-impact uncertainty is escalated instead of
  guessed through
- run a design review gate after worker planning and before implementation; product, architecture,
  validation, risk, and integration checks can block unsafe plans before files are edited
- require worker final self-checks for diff review, per-file/hunk `diffHunkReview`, project
  instructions, requirement trace evidence, plan fit, validation, and uncertainty
- capture already-running dev server HTTP evidence without starting a server
- verify patch intent against the preflight plan and flag drift before review
- interpret validation failures into categories, reproduction steps, and concrete worker guidance
- remember reviewer feedback, validation failures, successful patterns, and weighted worker guidance
  memories so future workers avoid repeated mistakes
- recommend or automatically create smaller split works when a task is too broad
- enforce a small-patch policy when a worker changes too many files or too many lines for one
  reviewable attempt
- require reviewers and attempt judges to record independent `filesChecked`, `evidenceChecked`, and
  `requirementVerdicts` before approval
- require reviewer discourse for adversarial review modes and persist finding triage items for
  review issues, missing validation, design-gate concerns, intent drift, and runtime blockers
- calibrate reviewer strictness and require adversarial mode checks for correctness, regression,
  security, runtime UX, data safety, integration, and maintainability when those risks apply
- synthesize lessons across multiple isolated worker attempts while still integrating one selected
  winner
- persist attempt observability metrics such as exploration count, changed files, validation reruns,
  runtime validation evidence, failure analysis, patch intent, diff stats, duration, estimated token
  counts, and timeline notes
- select a worker specialization focus for single-worker and multi-worker attempts

## Attempt Evidence and Review Records

Kira persists worker attempts and reviewer decisions under the app data directory:

```
apps/kira/data/attempts/{workId}-{attemptNo}.json
apps/kira/data/reviews/{workId}-{attemptNo}.json
```

Attempt records may include:

- `orchestrationPlan` with the selected run mode, lane goals, evidence requirements, checkpoints,
  and stop rules
- `evidenceLedger` with concrete plan, diff, validation, runtime, intent, manual, risk-acceptance,
  design, and review evidence
- an approval-readiness score with blockers and missing evidence
- worker self-checks, requirement traces, patch alternatives, diff hunk review, runtime validation,
  failure analysis, and patch-intent verification

Review records may include:

- independent `filesChecked`, `evidenceChecked`, `requirementVerdicts`, and adversarial checks
- simulated reviewer discourse for skeptical review modes
- triage items for review findings, validation gaps, runtime blockers, design-gate concerns, and
  patch-intent drift
- multi-worker attempt synthesis, including non-selected attempts and fully rejected comparison
  cycles

Operators can add manual evidence from the Kira work detail panel. Kira stores it as a normal
comment with a `[Kira manual evidence]` marker. Manual evidence and risk acceptance are review
context only; they do not replace required Kira validation evidence.

## Automation Locks

Kira uses lock files to avoid duplicate work and unsafe same-project integration:

```
apps/kira/data/automation-locks/
.kira-automation-locks/
```

On Windows, an already-running dev server or another process may briefly hold one of these files and
cause `EPERM`, `EACCES`, `EBUSY`, or related filesystem errors. Kira treats these as recoverable
lock noise when the path points at the automation lock directories. Such scan events are not queued
for the assistant chat, and older queued lock-noise events are filtered when events are drained.

## UI and Locale Behavior

- The left project panel is responsive and truncates long paths or project names rather than
  overlapping the work board.
- Region-specific browser locales such as `en-US`, `zh-CN`, or `ko-KR` fall back to the supported
  Kira translation bundles. Unsupported languages fall back to English labels.
- The Project Intelligence action is labeled `Generate profile` when no profile exists and
  `Refresh profile` after one has been created.
- The global settings modal waits for the persisted config to finish loading before it renders a
  saveable form. This prevents saving default UI state over existing model, Kira, image generation,
  and project-default settings.

## State File `/state.json`

| Field             | Type           | Required | Description                                                          |
| ----------------- | -------------- | -------- | -------------------------------------------------------------------- |
| selectedTaskId    | string \| null | No       | Currently focused work ID                                            |
| activeProjectName | string \| null | No       | Currently selected local project name under `kira.workRootDirectory` |
| previewMode       | boolean        | Yes      | Whether the detail panel is in markdown preview mode                 |

Example:

```json
{
  "selectedTaskId": "wire-kira-actions",
  "activeProjectName": "YourOpenRoom",
  "previewMode": false
}
```

## Agent Workflow

1. Read `meta.yaml`
2. Read this guide
3. Read existing files in `/works/` and `/comments/`
4. Write or update the target file in `apps/kira/data/...`
5. Dispatch `CREATE_WORK`, `UPDATE_WORK`, `DELETE_WORK`, `CREATE_COMMENT`, `DELETE_COMMENT`, or
   `REFRESH_KIRA`

Notes:

- Keep work descriptions in markdown, not HTML.
- Keep each work `projectName` aligned with the active project selected in Kira.
- Do not fabricate clarification answers. If `clarification.status` is `pending`, leave the work
  blocked until the user answers or explicitly proceeds with the current brief.
- Comments are simple text notes; do not overload them with long implementation briefs.
- Optional local execution root: set `kira.workRootDirectory` in `~/.openroom/config.json` if Kira
  should point sub-agents at a specific local workspace root.
- Kira accepts either a project root or a parent folder containing projects. If the configured root
  has project markers such as `.git`, `package.json`, or `requirements.txt`, Kira treats that root
  itself as the selectable project; otherwise it lists first-level folders as projects.
