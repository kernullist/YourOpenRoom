# Written By Me - Architecture Design Document

## 1. Overview

**Written By Me** is a local web application that analyzes a user's uploaded documents to extract their unique writing style across 13 stylometric dimensions. The analysis result is compiled into a `Skill.md` file -- a portable instruction set that any AI agent (Claude, GPT, OpenCode) can load to mimic the user's writing voice.

### Core Workflow
```
User Uploads Docs / Pastes Text  -->  Select Model  -->  [AI Analysis]  -->  Skill.md Generated  -->  Download / Copy
```

### Research Foundation
The analysis prompt is grounded in established research:
- **Stylometry** (Mosteller & Wallace, Mendenhall, Burrows Delta Method): function words as writer invariants, word-length distribution, vocabulary richness
- **Writeprint** (Abbasi & Chen 5-component model): lexical, syntactic, structural, content-specific, idiosyncratic features
- **Forensic Linguistics** (Svartvik, Coulthard): voice, perspective, register, rhetorical devices
- **Code Stylometry** (Caliskan et al.): source code authorship markers

---

## 2. Technology Stack

| Layer          | Technology                | Rationale                                    |
|----------------|---------------------------|----------------------------------------------|
| Frontend       | Vanilla HTML/CSS/JS       | No framework; single-page app; dark theme    |
| Backend        | Node.js + Express 4.x     | Lightweight, fast startup, streaming         |
| Runtime        | Node.js >= 18.0.0         | Required for `fetch`, `AbortSignal.timeout`  |
| File Upload    | multer 1.x                | Multipart/form-data parsing; 10 files, 10MB  |
| AI Provider    | DeepSeek (default)        | OpenAI-compatible API; configurable endpoint |
| Text Extraction| mammoth, pdf-parse        | .docx / .pdf plain text extraction           |
| Environment    | dotenv                    | API key and config management via .env       |

---

## 3. Project Structure

```
written-by-me/
  .env                    # API keys (gitignored)
  .env.example            # Template with DeepSeek defaults
  .gitignore              # node_modules, .env, uploads/*, output/*
  package.json            # Dependencies + engines field (node >= 18)
  server.js               # Express entrypoint, dotenv, mkdirSync, model cache
  ARCHITECTURE.md         # This document
  public/
    index.html            # SPA shell with model selector, upload/paste/result zones
    style.css             # Dark theme, responsive, custom select styling
    script.js             # Client-side logic: upload, drag-drop, model selector, analysis, download
  routes/
    upload.js             # POST /api/upload, POST /api/analyze-with-paste, POST /api/clear
    analyze.js            # POST /api/analyze (direct), GET /api/download/:id
  services/
    ai.js                 # AI API: analyzeStyle(), listModels(), streaming error reads, timeouts
    skillGenerator.js     # 13-dimension prompt engineering, source sanitization
    textExtractor.js      # .txt/.md/.docx/.pdf extraction, EUC-KR auto-detect
  uploads/                # Temp uploaded files (cleaned on startup + /api/clear)
  output/                 # Generated Skill.md files (served via /api/download/:id)
```

---

## 4. UX Flow & States

### Page Layout (top to bottom)
1. **Header** -- app title and subtitle
2. **Upload Zone** -- drag & drop + file picker; supported extensions list; file chips with remove
3. **Paste Zone** -- large textarea with character counter
4. **Action Bar** -- model selector dropdown + "Analyze My Style" button
5. **Result Zone** (hidden until analysis complete) -- Skill.md preview, download, copy, new analysis

### States
| State      | Behavior                                                             |
|------------|----------------------------------------------------------------------|
| Empty      | Analyze button disabled, model selector loads from API               |
| Loaded     | File list + paste count updated; analyze button enabled              |
| Analyzing  | Button shows spinner + "Analyzing..."; previous result hidden        |
| Done       | Result zone slides in; download/copy active; missing fileId warning  |
| Error      | Toast notification with error detail; retry by clicking analyze again|

---

## 5. API Design

### GET /api/config
Returns model list and server configuration for the frontend.
```
Response: 200 { model: "deepseek-chat", models: ["deepseek-chat", ...], maxFileSizeMb: 10 }
```
Model list is cached in memory with a 1-hour TTL. Falls back to the .env default if the provider's `/models` endpoint is unreachable.

### POST /api/upload
Upload files for analysis. Extracts text server-side and stores in memory.
```
Request:  multipart/form-data, field: "files" (up to 10 files, 10MB each)
Response: 200 { ok: true, files: [{ id, name, size, type }] }
          400 { error: "Unsupported file type" }
          413 { error: "File too large" }
```
Extracted text is capped at 50,000 chars per file. Temp files are cleaned at extract time. File content is held in an in-memory `textStore` Map keyed by file ID.

### POST /api/analyze-with-paste
The primary analysis endpoint used by the frontend. Combines uploaded file content (from textStore) with pasted text.
```
Request:  JSON { fileIds: string[], pastedText: string, model?: string, preferredLanguage?: string }
Response: 200 { ok: true, analysisId, analysis: { skillMd }, warning?, missingFileIds? }
          400 { error, missingFileIds? }
          500 { error, detail }
```
Limits: 100,000 chars total input. Missing fileIds are reported in the response as a warning.

### POST /api/analyze
Direct analysis endpoint for external API consumers. Accepts pre-assembled text payloads.
```
Request:  JSON { texts: [{ source, content }], preferredLanguage?, model? }
Response: 200 { ok: true, analysisId, analysis: { skillMd } }
          400 { error }
```

### GET /api/download/:analysisId
Download a generated Skill.md file.
```
Response: 200  Content-Type: text/markdown; charset=utf-8
               Content-Disposition: attachment; filename="Skill.md"
          400  { error: "Invalid analysis ID." }  (analysisId fails UUID regex)
          404  { error: "Analysis not found." }
```
Security: analysisId is validated against UUID regex `/^[0-9a-f]{8}-[0-9a-f]{4}-...$/i` to prevent path traversal.

### POST /api/clear
Clears the in-memory textStore and deletes temp files from uploads/.
```
Response: 200 { ok: true, cleared: N }
```
Called by the frontend when the user clicks "Start New Analysis".

---

## 6. AI Prompt Design (13 Dimensions)

The prompt is grounded in stylometry research and instructs the AI to analyze:

### Lexical Dimensions
1. **Function Words** (Mosteller-Wallace method): subconscious patterns in articles, prepositions, conjunctions, auxiliary verbs, pronouns -- the single most reliable authorship marker
2. **Vocabulary Richness**: Type-Token Ratio, lexical diversity, repetitiveness
3. **Word Length Distribution**: average word length, contraction preferences
4. **Signature Vocabulary**: pet phrases, filler words, transitional phrases, discourse markers

### Syntactic Dimensions
5. **Sentence Architecture**: length distribution, clause complexity, fragment usage
6. **Voice & Perspective**: active/passive ratio, person, hedging, boosting
7. **Punctuation Fingerprint**: density, comma style, semicolons, em-dashes, quote style

### Structural Dimensions
8. **Text Architecture**: paragraph length, heading usage, organizational patterns
9. **List & Enumeration Style**: numbered vs bullet vs inline enumeration

### Register & Rhetoric
10. **Tone & Register**: formality, humor type, emotional register
11. **Rhetorical Devices**: metaphors, questions, repetition, anecdotes, hyperbole

### Code & Language
12. **Code Style**: brace placement, comment style, naming conventions, indentation, error handling
13. **Language Preference**: Korean/English/mixed, honorifics, sentence endings, code-switching

### Output Template (Skill.md)
```markdown
---
name: my-writing-style
description: Writing style extracted from N document(s) across 13 stylometric dimensions.
---

# My Writing Style

## Lexical Patterns
### Function Words
### Vocabulary

## Sentence Craft
### Architecture
### Voice & Perspective
### Punctuation

## Structure & Organization
### Text Architecture
### Lists & Enumeration

## Tone & Rhetoric
### Register & Tone
### Rhetorical Style

## Formatting & Conventions
### Code Style
### Language & Expression

## Writing Guidelines
1. [actionable, testable rule]
2. ...

## Example Phrases
- "[verbatim example 1]"
- ...
```

---

## 7. File Handling

| Extension                                    | Method        | Notes                                      |
|----------------------------------------------|---------------|--------------------------------------------|
| .txt .md .csv .log .cpp .h .c .py .js .ts ...| fs.readFile   | UTF-8; EUC-KR auto-detect via iconv-lite   |
| .docx                                        | mammoth       | Plain text extraction, warnings reported   |
| .pdf                                         | pdf-parse     | Text layer only; scanned PDF not supported |

### Limits
- Max 10 files per upload
- Max 10 MB per file
- Max 50,000 chars stored per file
- Max 100,000 chars total input per analysis
- Max 15,000 chars per source in the AI prompt (truncation applied)
- AI max_tokens: 8192 (configurable via `AI_MAX_TOKENS`)
- Server-side AI timeout: 300 seconds
- Client-side analysis timeout: 310 seconds (AbortController)

---

## 8. Security & Stability

| Measure                        | Implementation                                           |
|--------------------------------|----------------------------------------------------------|
| Path traversal prevention      | UUID regex validation on `:analysisId`                   |
| Directory creation             | `fs.mkdirSync({ recursive: true })` on startup           |
| AI API timeout                 | `AbortSignal.timeout(180000)` on all fetch calls         |
| Memory cap                     | textStore per-entry 50k char limit                       |
| Memory cleanup                 | `/api/clear` endpoint + startup uploads/ purge           |
| Total input limit              | 100,000 chars checked before AI call                     |
| Error body streaming           | Read limited to 1024 bytes before truncation             |
| Truncation warning             | `finish_reason === "length"` check with console.warn    |
| Input validation               | File extension whitelist, size limits, empty check       |
| Missing fileId detection       | Reported in response warning + missingFileIds array      |

---

## 9. Configuration (.env)

```
# DeepSeek API (default, OpenAI-compatible)
OPENAI_API_KEY=sk-your-deepseek-api-key
OPENAI_BASE_URL=https://api.deepseek.com/v1
AI_MODEL=deepseek-chat
AI_MAX_TOKENS=8192

# Other OpenAI-compatible providers:
# OPENAI_BASE_URL=https://api.openai.com/v1
# AI_MODEL=gpt-4o
# AI_MAX_TOKENS=8192

PORT=3000
MAX_FILE_SIZE_MB=10
```
