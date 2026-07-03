# Written By Me

**Your writing style, distilled into a Skill.md for AI agents.**

![Before vs After](public/written_by_me_combined.png?v=2)

Upload your documents (notes, emails, code, blog posts) -- the AI analyzes your writing across 13 stylometric dimensions and generates a portable `Skill.md` that any AI agent (Claude, OpenCode, Cline, GPT) can load to write in your voice.

## Quick Start

### Option A: API Mode (DeepSeek, OpenAI, etc.)

```bash
npm install
cp .env.example .env
# Edit .env → paste your API key
npm start
```

### Option B: Claude CLI Mode (no API key)

```bash
npm install -g @anthropic-ai/claude-code   # if not already installed
npm install
cp .env.example .env
# Edit .env → set AI_PROVIDER=claude_cli
npm start
```

Open `http://localhost:3000`, upload documents or paste text, select a model, and click **Analyze My Style**.

## How It Works

```
Upload Files / Paste Text  →  Select Model  →  AI Analysis (13 dimensions)  →  Download Skill.md
```

The analysis is grounded in computational stylometry research:

| Dimension | Research Basis |
|-----------|---------------|
| Function Words | Mosteller & Wallace (Federalist Papers) -- the most reliable authorship marker |
| Vocabulary Richness | Type-Token Ratio, Burrows Delta Method |
| Word Length | Mendenhall distribution, contraction preferences |
| Sentence Architecture | Clause complexity, nesting depth, variation patterns |
| Voice & Perspective | Active/passive ratio, hedging, boosting, person |
| Punctuation Fingerprint | Density, comma style, semicolons, em-dashes |
| Text Architecture | Paragraph patterns, headings, organizational structure |
| Tone & Register | Formality, humor type, emotional register |
| Rhetorical Devices | Metaphors, rhetorical questions, anaphora, anecdotes |
| Code Style | Brace placement, naming conventions, comment style |
| Language Preference | Korean/English patterns, honorifics, code-switching |

## Project Structure

```
written-by-me/
  server.js               # Express entrypoint, model cache, directory init
  routes/
    upload.js              # POST /api/upload, /analyze-with-paste, /clear
    analyze.js             # POST /api/analyze, GET /api/download/:id
  services/
    ai.js                  # AI API + Claude CLI calls, analyze, list models, timeouts, batching
    skillGenerator.js      # 13-dimension prompt engineering + source sanitization
    textExtractor.js       # .txt .md .docx .pdf extraction, EUC-KR auto-detect
  public/
    index.html             # SPA shell
    style.css              # Dark theme, responsive
    script.js              # Upload, drag-drop, model selector, analysis, download
```

## Configuration (.env)

```env
AI_PROVIDER=api                # "api" (default) or "claude_cli"

# API mode
OPENAI_API_KEY=sk-xxx          # Required for API mode
OPENAI_BASE_URL=...            # Defaults to https://api.deepseek.com/v1
AI_MODEL=deepseek-chat         # Model override (API) or claude-sonnet-4-6 (CLI)
AI_MAX_TOKENS=8192             # Output token limit

# Claude CLI mode (no key needed):
# AI_PROVIDER=claude_cli
# AI_MODEL=claude-sonnet-4-6   # or claude-opus-4-7 / claude-haiku-4-5-20251001

PORT=3000
MAX_FILE_SIZE_MB=10
```

API mode supports DeepSeek, OpenAI, Groq, Ollama, and any OpenAI-compatible provider.

## Supported File Formats

`.txt` `.md` `.csv` `.log` `.cpp` `.c` `.h` `.hpp` `.cs` `.java` `.py` `.js` `.ts` `.jsx` `.tsx` `.rs` `.go` `.rb` `.php` `.swift` `.kt` `.html` `.css` `.scss` `.json` `.xml` `.yaml` `.yml` `.docx` `.pdf`

## Limits

- 10 files per upload, 10 MB per file
- 50,000 characters stored per file (server-side mem cap)
- 100,000 characters total input per analysis
- 15,000 characters per source in the AI prompt
- 300-second server timeout on AI calls, 310-second client timeout

## Requirements

- Node.js >= 18.0.0
- API key (DeepSeek, OpenAI, or compatible) **or** Claude CLI (`@anthropic-ai/claude-code`)
- Optional: `claude` CLI in PATH for Claude CLI mode
