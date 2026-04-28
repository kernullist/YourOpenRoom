# Calendar Data Guide

## Folder Structure

```
/
├── events/
│   ├── {eventId}.json
│   └── ...
└── state.json
```

## Event Files `/events/{eventId}.json`

Each event is stored as one JSON file. The filename must match `id`.

| Field               | Type    | Required | Description                                                    |
| ------------------- | ------- | -------- | -------------------------------------------------------------- |
| id                  | string  | Yes      | Unique event ID, same as filename without `.json`              |
| title               | string  | Yes      | Event title                                                    |
| notes               | string  | Yes      | Optional reminder context and notes                            |
| startAt             | string  | Yes      | ISO datetime string for when the event starts                  |
| remindBeforeMinutes | number  | Yes      | Minutes before `startAt` when the reminder should trigger      |
| completed           | boolean | Yes      | Whether the event is completed                                 |
| createdAt           | number  | Yes      | Unix timestamp in milliseconds                                 |
| updatedAt           | number  | Yes      | Unix timestamp in milliseconds                                 |
| lastReminderSentAt  | number  | No       | Unix timestamp in milliseconds for the last proactive reminder |

Example:

```json
{
  "id": "launch-review",
  "title": "Launch review",
  "notes": "Bring the KPI deck and mention the QA checklist.",
  "startAt": "2026-04-15T09:30:00.000Z",
  "remindBeforeMinutes": 15,
  "completed": false,
  "createdAt": 1776200000000,
  "updatedAt": 1776200000000
}
```

## State File `/state.json`

| Field           | Type           | Required | Description                                   |
| --------------- | -------------- | -------- | --------------------------------------------- |
| selectedEventId | string \| null | No       | Currently focused event                       |
| selectedDateKey | string         | No       | Selected calendar date in `YYYY-MM-DD` format |

Example:

```json
{
  "selectedEventId": "launch-review",
  "selectedDateKey": "2026-04-15"
}
```

## Agent Workflow

1. Read `meta.yaml`
2. Read this guide
3. Read existing files in `/events/`
4. Write or update the target event file in `apps/calendar/data/events/{id}.json`
5. Dispatch `CREATE_EVENT`, `UPDATE_EVENT`, `DELETE_EVENT`, or `REFRESH_EVENTS`

Notes:

- Always write `startAt` as a valid ISO string.
- Keep `selectedDateKey` aligned with the event date when focusing or creating an event from a
  calendar day.
- Do not invent extra folders.
- When an event's time changes, omit `lastReminderSentAt` or reset it so reminders can trigger
  again.
