# PE Analyst Data Guide

## Folder Structure

```
/
├── samples/
│   ├── {sampleId}.json
│   └── ...
├── analyses/
│   ├── {analysisId}.json
│   └── ...
└── state.json
```

The raw PE binary is not stored in app JSON storage. The backend saves it to the local OpenRoom
cache and stores its absolute `diskPath` in the sample record.

## Sample Files `/samples/{sampleId}.json`

Each sample file tracks one uploaded PE sample.

| Field            | Type           | Required | Description                                     |
| ---------------- | -------------- | -------- | ----------------------------------------------- |
| `id`             | string         | Yes      | Sample ID, must match the filename              |
| `fileName`       | string         | Yes      | Original uploaded filename                      |
| `sha256`         | string         | Yes      | SHA-256 hash of the raw PE file                 |
| `size`           | number         | Yes      | Raw file size in bytes                          |
| `diskPath`       | string         | Yes      | Absolute path to the cached PE file on disk     |
| `uploadedAt`     | number         | Yes      | Unix timestamp in milliseconds                  |
| `machineType`    | string         | Yes      | Parsed PE machine type, e.g. `x64`              |
| `isDll`          | boolean        | Yes      | Whether the image characteristics include `DLL` |
| `lastAnalysisId` | string \| null | Yes      | Most recent analysis ID for this sample         |
| `lastScannedAt`  | number \| null | Yes      | Timestamp of the most recent quick triage run   |

## Analysis Files `/analyses/{analysisId}.json`

Each analysis file stores a single quick triage output.

Important fields:

| Field         | Type   | Required | Description                                      |
| ------------- | ------ | -------- | ------------------------------------------------ |
| `id`          | string | Yes      | Analysis ID, must match the filename             |
| `sampleId`    | string | Yes      | Related sample ID                                |
| `profile`     | string | Yes      | Current value is `quick-triage`                  |
| `backendMode` | string | Yes      | `prescan-only` for the initial implementation    |
| `status`      | string | Yes      | Current value is `completed`                     |
| `summary`     | string | Yes      | Short top-line narrative                         |
| `metadata`    | object | Yes      | Parsed PE header details                         |
| `triage`      | object | Yes      | Aggregate quick triage counters                  |
| `sections`    | array  | Yes      | Parsed section list with entropy and permissions |
| `imports`     | array  | Yes      | Imported modules and names                       |
| `exports`     | object | Yes      | Export count and example names                   |
| `strings`     | array  | Yes      | Indexed strings, including suspicious hits       |
| `findings`    | array  | Yes      | Human-readable quick triage findings             |

## State File `/state.json`

| Field                  | Type           | Required | Description                                         |
| ---------------------- | -------------- | -------- | --------------------------------------------------- |
| `activeSampleId`       | string \| null | No       | Focused sample ID                                   |
| `activeAnalysisId`     | string \| null | No       | Focused analysis ID                                 |
| `selectedFindingId`    | string \| null | No       | Focused finding ID                                  |
| `selectedFunctionEa`   | string \| null | No       | Reserved for later function drill-down              |
| `activeView`           | string         | Yes      | One of `overview`, `imports`, `sections`, `strings` |
| `filterSeverity`       | string \| null | No       | Optional finding severity filter                    |
| `sidebarOpen`          | boolean        | Yes      | Whether the left workspace panel is visible         |
| `showLibraryFunctions` | boolean        | Yes      | Reserved for later IDA-backed workflows             |

## Agent Workflow

1. Read `meta.yaml`
2. Read this guide
3. Read the current `state.json`
4. Read `/samples/` and `/analyses/`
5. Write or update sample/analysis JSON files in `apps/peanalyzer/data/...`
6. Dispatch one of:
   - `USE_CURRENT_IDB`
   - `OPEN_SAMPLE`
   - `RUN_QUICK_TRIAGE`
   - `SHOW_ANALYSIS`
   - `REFRESH_PE_ANALYZER`

Notes:

- Keep `sample.id` and `analysis.id` aligned with filenames.
- Do not overwrite `diskPath` with a relative path.
- The initial version is intentionally read-focused and quick-triage oriented.
- Raw binaries are cached by the backend and should not be written into JSON app storage.
- `USE_CURRENT_IDB` is intended for `ida_pro_mcp` style workflows where the currently open IDA
  database is the source of truth.
