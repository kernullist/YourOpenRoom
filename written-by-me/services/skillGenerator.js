function sanitizeSource(source)
{
    return source.replace(/[`*_{}\[\]()#+\-.!|~]/g, "\\$&").replace(/\n/g, " ");
}

function buildPrompt(texts, preferredLanguage)
{
    const langInstruction = preferredLanguage === "korean"
        ? "The writer primarily uses Korean. Analyze Korean-specific patterns: honorifics (합니다/한다/해요), sentence endings (~다/~요/~니다), topic markers (은/는/이/가), and code-switching with English. The analysis summary should be written primarily in Korean."
        : preferredLanguage === "english"
            ? "The writer primarily uses English."
            : "Detect the language(s) used and analyze accordingly. Mixed-language patterns are also valid traits.";

    let textBlock = "";
    for (const t of texts)
    {
        const truncated = t.content.length > 15000
            ? t.content.slice(0, 15000) + "\n[...truncated...]"
            : t.content;
        const safeSource = sanitizeSource(t.source);
        textBlock += `\n--- SOURCE: ${safeSource} ---\n${truncated}\n`;
    }

    return `You are a computational stylometry expert. Analyze these texts by the same person using established dimensions from forensic linguistics, authorship attribution research, and writeprint analysis.

Analyze each of the following 12 dimensions with concrete evidence and examples:

===== LEXICAL DIMENSIONS =====

1. FUNCTION WORDS (Writer Invariant — Mosteller/Wallace method):
   Identify the author's subconscious pattern in using function words: articles (a, an, the), prepositions (of, in, to, for, with, on, at, by, from), conjunctions (and, but, or, so, because, although), auxiliary verbs (is, was, are, were, has, have, had, will, would, can, could), pronouns (I, you, he, she, it, we, they, my, your, his, her, our, their). Look for overuse or underuse of specific function words relative to typical prose. This is the SINGLE MOST RELIABLE authorship marker.

2. VOCABULARY RICHNESS (Type-Token Ratio):
   Measure lexical diversity: ratio of unique words to total words. Does the author reuse words heavily (low TTR, repetitive style) or use many distinct words (high TTR, varied vocabulary)? Note: account for text length bias.

3. WORD LENGTH DISTRIBUTION:
   Average word length (characters), preference for short vs long words. Frequency of multi-syllable words vs monosyllabic choices. Use of contractions (isn't, don't, I'm vs is not, do not, I am).

4. SIGNATURE VOCABULARY (Idiosyncratic Lexicon):
   Recurring preferred words, pet phrases, filler words (um, like, actually, basically, literally, you know), transitional phrases (however, therefore, moreover, on the other hand, in contrast), discourse markers (well, so, anyway, I mean, look, listen), and any notably overused terms.

===== SYNTACTIC DIMENSIONS =====

5. SENTENCE ARCHITECTURE:
   Average sentence length (in words). Distribution pattern: consistent vs highly variable. Preference for: short punchy sentences vs complex multi-clause sentences. Use of fragments. Do they vary length for effect (e.g., long-short-long pattern)? Clause structure: simple/compound/complex ratio. Subordinate clause nesting depth.

6. VOICE AND PERSPECTIVE:
   Active vs passive voice ratio. First-person (I, we) vs second-person (you) vs third-person (he/she/it/they) vs impersonal constructions. Use of hedging (might, perhaps, possibly, seems, tends to, arguably). Use of boosting (certainly, definitely, absolutely, clearly, obviously). Use of direct address (you, reader, as you can see).

7. PUNCTUATION FINGERPRINT:
   Overall punctuation density (marks per sentence). Comma usage: heavy (Oxford comma, many clauses), light (minimal punctuation), or standard. Use of: semicolons, colons, em-dashes, en-dashes, parentheses, ellipses, exclamation marks, question marks. Quotation style: single vs double quotes. Bullet point style: -, *, or numbered.

===== STRUCTURAL DIMENSIONS =====

8. TEXT ARCHITECTURE:
   Paragraph length: consistently short, consistently long, or varied. How does the author start paragraphs (topic sentence pattern)? How do they end (concluding statement, transition, abrupt)? Use of headings and subheadings. Overall organizational pattern: linear/narrative, hierarchical, problem-solution, compare-contrast, list-based.

9. LIST AND ENUMERATION STYLE:
   When presenting multiple items, does the author use: numbered lists, bullet points, inline enumeration ("first... second... third"), or narrative description? Format of numbered lists: "1." vs "1)" vs "Step 1:".

===== REGISTER AND RHETORIC =====

10. TONE AND REGISTER:
    Formal vs informal vs technical vs conversational. Academic distance vs personal engagement. Humor: dry/wry, sarcastic, playful, absurdist, or absent. Level of certainty expressed. Emotional register: warm/cold, enthusiastic/restrained, optimistic/pessimistic, confrontational/diplomatic.

11. RHETORICAL DEVICES:
    Use of: metaphors and analogies, rhetorical questions, repetition for emphasis (anaphora, epistrophe), direct reader address, contrast/comparison framing, rule-of-three, storytelling/anecdote insertion, alliteration, exaggeration/hyperbole, understatement/litotes.

===== CODE AND MIXED-MEDIA DIMENSIONS =====

12. CODE STYLE (if code is present):
    Brace placement: same-line (K&R) vs next-line (Allman). Comment style: // vs /* */, inline vs block vs doc-comment. Comments: sparse, thorough, ASCII-only, or natural language. Naming conventions: camelCase, snake_case, PascalCase, Hungarian. Indentation: tabs vs spaces, width. Line length preferences. Single-exit vs early-return patterns. Const-correctness. Error handling style: try/catch, if-checks, assertions, status codes.

If no code is found, describe the general formatting patterns of prose text instead.

===== LANGUAGE SPECIFIC =====

13. LANGUAGE PREFERENCE: ${langInstruction}

Now generate a Markdown Skill file that an AI agent can load to replicate this writer's style. Follow this structure EXACTLY:

---
name: [choose a short descriptive name based on the analysis, e.g. korean-tech-blog, casual-english-notes, formal-code-reviewer]
description: [describe this skill in natural language. It must contain these trigger phrases somewhere in the text: "write like me", "내 스타일", "문체", "글 작성", "써줘", "작성해", "tutorial", "blog post", "writing style", "내 말투". Then briefly describe the style: e.g. "Use when the user wants you to write in their personal style. Korean conversational tutorial tone with warm encouragement."]
---

The description MUST naturally include these trigger phrases: write like me, 내 스타일, 문체, 글 작성, 써줘, 작성해, tutorial, blog post, writing style, 내 말투.

The heading after the YAML frontmatter MUST be "# [skill-name]" — use the EXACT same name you chose for the "name" field. This is required for some agents to detect the skill.

## Lexical Patterns

### Function Words
[analysis of the author's function word fingerprint — the most reliable stylometric marker]

### Vocabulary
[word length, type-token richness, preferred terms, pet phrases, filler words]

## Sentence Craft

### Architecture
[sentence length patterns, complexity, clause structure, variation]

### Voice & Perspective
[active/passive, person, hedging, boosting, directness]

### Punctuation
[punctuation fingerprint: density, comma style, special characters]

## Structure & Organization

### Text Architecture
[paragraph patterns, heading style, organizational approach]

### Lists & Enumeration
[how the author presents sequences and groups]

## Tone & Rhetoric

### Register & Tone
[formality, humor style, emotional register, conversational distance]

### Rhetorical Style
[devices used: metaphors, questions, repetition, anecdotes, etc.]

## Formatting & Conventions

### Code Style
[if applicable; otherwise describe general formatting patterns]

### Language & Expression
[language preference, code-switching, expression quirks]

## Writing Guidelines

[numbered, actionable rules that an AI can follow to replicate this style. Each rule should be concrete and testable, e.g. "Use semicolons only between closely related independent clauses, never as a list separator."]

## Example Phrases

- "[verbatim example 1 from the texts]"
- "[verbatim example 2]"
- "[verbatim example 3]"
- "[verbatim example 4]"
- "[verbatim example 5]"

${textBlock}`;
}

function estimateTokens(text)
{
    return Math.ceil(text.length / 3.5);
}

function buildMergePrompt(analyses, totalDocs, preferredLanguage)
{
    const langInstruction = preferredLanguage === "korean"
        ? "The analysis and merged output should be written in Korean."
        : preferredLanguage === "english"
            ? "The analysis should be written in English."
            : "Use the language of the source analyses.";

    let analysesBlock = "";
    for (let i = 0; i < analyses.length; i++)
    {
        analysesBlock += `\n=== BATCH ${i + 1} ANALYSIS ===\n${analyses[i]}\n`;
    }

    return `You are a writing style synthesist. You have received ${analyses.length} separate style analyses from different batches of the SAME author's texts (${totalDocs} total documents). Merge them into ONE coherent Skill.md. Follow these rules:

1. Reconcile any conflicting observations across batches by looking for consensus patterns
2. If a trait appears in multiple batches, it is a STRONG SIGNAL — emphasize it
3. If a trait only appears in one batch, mention it as a weaker pattern
4. Combine example phrases from all batches, selecting the 3-7 most representative ones
5. Produce the final Skill.md in the EXACT format specified below
6. ${langInstruction}

Generate ONE unified Skill.md following this structure:

---
name: [choose a short descriptive name based on the merged analysis]
description: [natural language description. Must contain trigger phrases: "write like me", "내 스타일", "문체", "글 작성", "써줘", "작성해", "tutorial", "blog post", "writing style", "내 말투". Then briefly summarize the merged style.]
---

The description MUST naturally include: write like me, 내 스타일, 문체, 글 작성, 써줘, 작성해, tutorial, blog post, writing style, 내 말투.

The heading after the YAML MUST be "# [skill-name]" — use the EXACT same name you chose for the "name" field.

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
[merged, actionable rules — each concrete and testable]

## Example Phrases
- "[best representative example 1]"
- "[best representative example 2]"
- "[best representative example 3]"
- "[best representative example 4]"
- "[best representative example 5]"

${analysesBlock}`;
}

module.exports = { buildPrompt, estimateTokens, buildMergePrompt };
