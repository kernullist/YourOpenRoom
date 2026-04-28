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

| Field      | Type    | Default | Description                                                                                        |
| ---------- | ------- | ------- | -------------------------------------------------------------------------------------------------- |
| autoCommit | boolean | `true`  | If `true`, Kira will try to git-commit approved work using the reviewer’s suggested commit message |

Example:

```json
{
  "autoCommit": false
}
```

If the project file is missing, Kira falls back to `kira.projectDefaults` from
`~/.openroom/config.json`, and if that is also missing it still defaults to `true`.

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
