require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const express = require("express");
const cors = require("cors");
const { listModels, AI_PROVIDER } = require("./services/ai");

const app = express();

if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === "sk-your-deepseek-api-key")
{
    console.error("[ERROR] OPENAI_API_KEY not set. Copy .env.example to .env and fill in your API key (DeepSeek or OpenAI-compatible).");
    process.exit(1);
}

fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });
fs.mkdirSync(path.join(__dirname, "output"), { recursive: true });

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public"), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store, must-revalidate")
}));

const logEmitter = new EventEmitter();
const MAX_LOG_ENTRIES = 200;
const logBuffer = [];

function logEvent(type, message)
{
    const entry = {
        ts: Date.now(),
        type,
        message
    };

    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES)
    {
        logBuffer.shift();
    }

    logEmitter.emit("entry", entry);

    const prefix = type === "error" ? "[ERROR]" : type === "warn" ? "[WARN]" : "[+]";
    console.log(`${prefix} ${message}`);
}

global.__wbmLogEvent = logEvent;

let cachedModels = null;
let cachedModelsAt = 0;
const MODEL_CACHE_TTL_MS = 3600000;

app.get("/api/config", async (_req, res) =>
{
    const defaultModel = process.env.AI_MODEL || "deepseek-chat";
    const claudeModels = ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5-20251001"];
    let models = {
        defaultModel,
        groups: [
            { label: "API Models", models: [defaultModel] },
            { label: "Claude CLI", models: claudeModels }
        ]
    };

    const now = Date.now();
    if (cachedModels && (now - cachedModelsAt) < MODEL_CACHE_TTL_MS)
    {
        models = cachedModels;
    }
    else
    {
        try
        {
            models = await listModels();
            cachedModels = models;
            cachedModelsAt = now;
        }
        catch (err)
        {
            logEvent("warn", "Could not fetch model list: " + err.message);
        }
    }

    res.json({
        provider: AI_PROVIDER,
        model: models.defaultModel || defaultModel,
        groups: models.groups,
        maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB) || 10
    });
});

app.get("/api/logs/stream", (req, res) =>
{
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
    });

    res.write("retry: 1000\n\n");

    for (const entry of logBuffer)
    {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const handler = (entry) =>
    {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };

    logEmitter.on("entry", handler);

    const keepAlive = setInterval(() =>
    {
        res.write(": keepalive\n\n");
    }, 15000);

    req.on("close", () =>
    {
        logEmitter.off("entry", handler);
        clearInterval(keepAlive);
    });
});

const uploadRoutes = require("./routes/upload");
const analyzeRoutes = require("./routes/analyze");

app.use("/api", uploadRoutes);
app.use("/api", analyzeRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
{
    console.log(`[WrittenByMe] Server running at http://localhost:${PORT}`);
    console.log(`[WrittenByMe] Provider: ${AI_PROVIDER === "claude_cli" ? "Claude CLI" : (process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1")}`);
    console.log(`[WrittenByMe] Model: ${process.env.AI_MODEL || "deepseek-chat"}`);
});
