const { spawn } = require("child_process");
const { buildPrompt, estimateTokens, buildMergePrompt } = require("./skillGenerator");

function log(type, message)
{
    if (global.__wbmLogEvent)
    {
        global.__wbmLogEvent(type, message);
    }
}

const AI_PROVIDER = process.env.AI_PROVIDER || "api";

function getBaseUrl()
{
    let url = process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1";
    return url.replace(/\/+$/, "");
}

function getApiKey()
{
    return process.env.OPENAI_API_KEY;
}

const CONNECT_TIMEOUT_MS = 30000;
const RESPONSE_TIMEOUT_MS = 300000;

const MODEL_CONTEXT_WINDOWS = {
    "deepseek-chat": 64000,
    "deepseek-reasoner": 64000,
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
    "gpt-4-turbo": 128000,
    "gpt-4": 8192,
    "gpt-3.5-turbo": 16385,
    "claude-sonnet-4-6": 1000000,
    "claude-opus-4-7": 1000000,
    "claude-haiku-4-5-20251001": 200000,
    "claude-3-opus": 200000,
    "claude-3-sonnet": 200000,
    "claude-3-haiku": 200000,
    "claude-3.5-sonnet": 200000,
    "o1": 200000,
    "o1-mini": 128000,
    "o3-mini": 200000
};

function fetchWithTimeout(url, options, timeoutMs)
{
    return new Promise((resolve, reject) =>
    {
        const controller = new AbortController();
        const timer = setTimeout(() =>
        {
            controller.abort();
        }, timeoutMs);

        fetch(url, { ...options, signal: controller.signal })
            .then((res) =>
            {
                clearTimeout(timer);
                resolve(res);
            })
            .catch((err) =>
            {
                clearTimeout(timer);
                reject(err);
            });
    });
}

async function claudeCliAnalyze(fullPrompt, modelOverride)
{
    const model = modelOverride || "claude-sonnet-4-6";

    console.log(`[ai] Sending prompt (${fullPrompt.length} chars) via Claude CLI`);
    log("info", `Sending ${fullPrompt.length} chars via Claude CLI`);

    return new Promise((resolve, reject) =>
    {
        const child = spawn("claude", ["-p", "--output-format", "text", "--model", model], {
            stdio: ["pipe", "pipe", "pipe"],
            timeout: RESPONSE_TIMEOUT_MS,
            windowsHide: true
        });

        const stdout = [];
        const stderr = [];

        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));

        child.on("close", (code) =>
        {
            const output = Buffer.concat(stdout).toString("utf-8").trim();
            const errOutput = Buffer.concat(stderr).toString("utf-8").trim();

            if (code !== 0)
            {
                log("error", `Claude CLI exit code ${code}: ${errOutput}`);
                reject(new Error(`Claude CLI failed (exit ${code}): ${errOutput.slice(0, 300)}`));
                return;
            }

            if (!output)
            {
                reject(new Error("Claude CLI returned empty output."));
                return;
            }

            log("info", `Claude CLI response: ${output.length} chars`);
            resolve(output);
        });

        child.on("error", (err) =>
        {
            if (err.code === "ENOENT")
            {
                reject(new Error("Claude CLI not found. Install with: npm i -g @anthropic-ai/claude-code"));
            }
            else
            {
                reject(new Error(`Claude CLI error: ${err.message}`));
            }
        });

        const stdinContent = fullPrompt;
        child.stdin.write(stdinContent);
        child.stdin.end();
    });
}

async function analyzeStyle(prompt, modelOverride)
{
    const model = modelOverride || process.env.AI_MODEL || "deepseek-chat";

    if (AI_PROVIDER === "claude_cli" || (model && model.startsWith("claude-")))
    {
        const systemPrompt = "You are a writing style analyst. Your task is to analyze texts written by the same person and produce a comprehensive writing style profile in the exact Markdown format specified. Do not add commentary outside the requested format. Be precise and evidence-based in your analysis.";
        const fullPrompt = systemPrompt + "\n\n" + prompt;
        return claudeCliAnalyze(fullPrompt, model);
    }

    const baseUrl = getBaseUrl();
    const apiKey = getApiKey();
    const maxTokens = parseInt(process.env.AI_MAX_TOKENS) || 8192;

    console.log(`[ai] Sending prompt (${prompt.length} chars) to model: ${model}`);
    log("info", `Sending ${prompt.length} chars to ${model}`);

    const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model,
            messages: [
                {
                    role: "system",
                    content: "You are a writing style analyst. Your task is to analyze texts written by the same person and produce a comprehensive writing style profile in the exact Markdown format specified. Do not add commentary outside the requested format. Be precise and evidence-based in your analysis."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.3,
            max_tokens: maxTokens,
            ...(model.includes("v4-pro") || model.includes("reasoner") ? { thinking: { type: "disabled" } } : {})
        })
    }, RESPONSE_TIMEOUT_MS);

    if (!response.ok)
    {
        let errText;
        try
        {
            const reader = response.body.getReader();
            const chunks = [];
            let total = 0;
            while (true)
            {
                const { done, value } = await reader.read();
                if (done)
                {
                    break;
                }
                chunks.push(value);
                total += value.length;
                if (total > 1024)
                {
                    try { reader.cancel(); }
                    catch (_) {}
                    break;
                }
            }
            const buf = Buffer.concat(chunks).slice(0, 1024);
            errText = buf.toString("utf-8");
        }
        catch (_)
        {
            errText = "(could not read error body)";
        }
        log("error", `API error ${response.status}: ${errText}`);
        throw new Error(`AI API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    if (!data.choices || !data.choices[0] || !data.choices[0].message)
    {
        throw new Error("Unexpected AI API response structure.");
    }

    const content = data.choices[0].message.content;
    const finishReason = data.choices[0].finish_reason;
    log("info", `Response received: ${content.length} chars, finish_reason=${finishReason || "stop"}`);

    if (finishReason === "length")
    {
        log("warn", "Output was truncated (finish_reason=length). Consider increasing AI_MAX_TOKENS.");
        console.warn("[ai] Output was truncated (finish_reason=length). Consider increasing AI_MAX_TOKENS.");
    }

    return content;
}

async function listModels()
{
    const apiModels = [];
    const claudeModels = ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5-20251001"];

    if (AI_PROVIDER === "claude_cli")
    {
        return { defaultModel: "claude-sonnet-4-6", groups: [{ label: "Claude CLI", models: claudeModels }] };
    }

    const baseUrl = getBaseUrl();
    const apiKey = getApiKey();

    try
    {
        const response = await fetchWithTimeout(`${baseUrl}/models`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${apiKey}`
            }
        }, CONNECT_TIMEOUT_MS);

        if (response.ok)
        {
            const data = await response.json();
            if (data.data && Array.isArray(data.data))
            {
                const excludePatterns = [
                    "embedding", "moderation", "dall-e", "tts", "whisper",
                    "audio", "babbage", "davinci", "instruct", "draft",
                    "omni-moderation", "gpt-3.5-turbo-instruct"
                ];

                const chatModels = data.data
                    .map((m) => m.id)
                    .filter((id) =>
                    {
                        const lower = id.toLowerCase();
                        for (const pat of excludePatterns)
                        {
                            if (lower.includes(pat))
                            {
                                return false;
                            }
                        }
                        return true;
                    })
                    .sort();

                apiModels.push(...chatModels);
            }
        }
    }
    catch (_)
    {
    }

    const groups = [];
    if (apiModels.length > 0)
    {
        groups.push({ label: "API Models", models: apiModels });
    }
    groups.push({ label: "Claude CLI", models: claudeModels });

    return { defaultModel: process.env.AI_MODEL || "deepseek-chat", groups };
}

async function analyzeWithBatching(allTexts, preferredLanguage, modelOverride)
{
    const model = modelOverride || process.env.AI_MODEL || "deepseek-chat";
    const maxTokens = parseInt(process.env.AI_MAX_TOKENS) || 8192;
    const contextWindow = MODEL_CONTEXT_WINDOWS[model] || (AI_PROVIDER === "claude_cli" ? 200000 : 64000);
    const safetyMargin = Math.ceil(contextWindow * 0.15);
    const availableForInput = contextWindow - maxTokens - safetyMargin;

    const totalCount = allTexts.length;
    if (totalCount === 0)
    {
        throw new Error("No texts to analyze.");
    }

    const fullPrompt = buildPrompt(allTexts, preferredLanguage);
    const totalTokens = estimateTokens(fullPrompt);

    console.log(`[ai] Texts: ${totalCount}, total chars: ${allTexts.reduce((s, t) => s + t.content.length, 0)}, est tokens: ${totalTokens}, available: ${availableForInput}`);

    if (totalTokens <= availableForInput)
    {
        console.log("[ai] Strategy: single_pass");
        log("info", `Strategy: single_pass (${totalCount} sources, ~${totalTokens} tokens fit in ${availableForInput})`);
        const result = await analyzeStyle(fullPrompt, model);
        return { skillMd: result, strategy: "single_pass", batches: 1 };
    }

    console.log("[ai] Strategy: batched");
    log("info", `Strategy: batched — ${totalTokens} tokens exceeds ${availableForInput} limit, splitting sources`);

    const batches = [];
    let currentBatch = [];
    let currentTokens = 0;

    for (const text of allTexts)
    {
        const truncated = text.content.length > 15000
            ? text.content.slice(0, 15000)
            : text.content;
        const entryTokens = estimateTokens(truncated) + 20;

        if (currentBatch.length > 0 && (currentTokens + entryTokens > availableForInput || currentBatch.length >= 5))
        {
            batches.push([...currentBatch]);
            currentBatch = [];
            currentTokens = 0;
        }

        currentBatch.push(text);
        currentTokens += entryTokens;
    }

    if (currentBatch.length > 0)
    {
        batches.push([...currentBatch]);
    }

    if (batches.length === 1)
    {
        const result = await analyzeStyle(fullPrompt, model);
        return { skillMd: result, strategy: "single_pass", batches: 1 };
    }

    console.log(`[ai] Split into ${batches.length} batches`);
    log("info", `Split into ${batches.length} batches`);

    const analyses = [];
    for (let i = 0; i < batches.length; i++)
    {
        console.log(`[ai] Processing batch ${i + 1}/${batches.length} (${batches[i].length} sources)`);
        log("info", `Batch ${i + 1}/${batches.length}: analyzing ${batches[i].length} sources (${batches[i].reduce((s, t) => s + t.content.length, 0)} chars)`);
        const batchPrompt = buildPrompt(batches[i], preferredLanguage);
        const analysis = await analyzeStyle(batchPrompt, model);
        analyses.push(analysis);
    }

    console.log("[ai] Merging batch results...");
    log("info", `Merging ${analyses.length} batch analyses into one Skill.md`);
    const mergePrompt = buildMergePrompt(analyses, totalCount, preferredLanguage);
    const merged = await analyzeStyle(mergePrompt, model);

    return { skillMd: merged, strategy: "batched", batches: batches.length };
}

module.exports = { analyzeStyle, listModels, analyzeWithBatching, AI_PROVIDER };
