# ST Card Import — CLI Orchestrator

Import SillyTavern character card files (PNG / CharX / ZIP) into the VibeApp system. Extracts apps from the card's character book and generates VibeApp code + mod scenario.

## Parameter Parsing

- `$ARGUMENTS` format: `{FilePath}`
- `FilePath`: path to a `.png`, `.charx`, or `.zip` file containing a SillyTavern character card

If `$ARGUMENTS` is empty, ask the user for the file path.

## Execution Protocol

### 1. Extract Card Data

Run the extraction script:

```bash
python3 .claude/scripts/extract-card.py "{FilePath}"
```

Capture the JSON output. If extraction fails, report the error and stop.

### 2. Analyze & Present Results

Parse the extraction output JSON. Display a structured summary to the user:

```
Card: {source} ({source_type})
Character: {character.name}
  Description: {first 100 chars of character.description}...

Apps Found ({count}):
  1. [{comment}] — keywords: {keywords} | format: {format} | tags: {tag_names}
  2. ...

Lore Entries: {count}
Regex Scripts: {count}
```

### 3. User Selection

Ask the user which apps to generate using AskUserQuestion:
- Option 1: Generate all apps (recommended)
- Option 2: Select specific apps
- Option 3: Skip app generation (mod only)

If the user selects specific apps, present a multi-select list of extracted apps.

### 4. Generate Apps via Vibe Workflow

For each selected app, derive a VibeApp requirement from the card data:

#### 4.1 App Name Derivation

Convert the app's `comment` field to PascalCase for the VibeApp name:
- `"live stream"` → `LiveStream`
- `"social-feed"` → `SocialFeed`
- `"music app"` → `MusicApp`
- Chinese names: translate to English PascalCase

#### 4.2 Requirement Generation

Build a comprehensive requirement description from the extracted data:

```
A {format}-based app that provides {functional description based on keywords and tags}.

UI Features:
{For each tag: describe the UI element it represents}

Data Resources:
{For each resource list: describe what data it manages}

Content Format: {format type — xml tags / bracket notation / prose}

Regex Scripts (for reference):
{List relevant scripts that transform this app's output}
```

#### 4.3 Execute Vibe Workflow

For each app, execute the `/vibe` command:

```
/vibe {PascalCaseAppName} {GeneratedRequirement}
```

Process apps **sequentially** — each vibe workflow must complete before starting the next.

**Important**: Before starting each app, check if a VibeApp with that name already exists at `src/pages/{AppName}/`. If it does, ask the user whether to:
- Skip this app
- Overwrite (delete existing and regenerate)
- Use change mode (modify existing app)

### 5. Completion Report

```
═══════════════════════════════════════
  ST Card Import Complete
═══════════════════════════════════════
  Source:    {filename} ({source_type})
  Character: {character.name}

  Apps Generated ({count}):
    • {AppName1} → http://localhost:3000/{app-name-1}
    • {AppName2} → http://localhost:3000/{app-name-2}
═══════════════════════════════════════
```

## Error Handling

- If extraction fails: report error, suggest checking file format
- If a vibe workflow fails for one app: log error, continue with remaining apps

## Notes

- The extraction script handles both PNG (ccv3/chara tEXt chunks) and CharX/ZIP (card.json) formats
- Apps are identified by character book entries containing `<rule S>` in their content
- The vibe workflow handles all code generation, architecture, and integration
- Lore entries are preserved as reference data but not directly used in app generation
