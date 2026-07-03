const express = require("express");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { analyzeWithBatching } = require("../services/ai");

function log(type, message)
{
    if (global.__wbmLogEvent)
    {
        global.__wbmLogEvent(type, message);
    }
}

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post("/analyze", async (req, res) =>
{
    const { texts, preferredLanguage, model } = req.body;

    if (!texts || !Array.isArray(texts) || texts.length === 0)
    {
        return res.status(400).json({ error: "No content provided. Upload files or paste text first." });
    }

    const totalChars = texts.reduce((sum, t) => sum + (t.content ? t.content.length : 0), 0);
    if (totalChars === 0)
    {
        return res.status(400).json({ error: "All provided texts are empty." });
    }

    try
    {
        const { skillMd, strategy, batches } = await analyzeWithBatching(texts, preferredLanguage || "auto", model);
        const analysisId = uuidv4();
        const outputPath = path.join(__dirname, "..", "output", `${analysisId}.md`);

        await fs.promises.writeFile(outputPath, skillMd, "utf-8");

        res.json({
            ok: true,
            analysisId,
            strategy,
            batches,
            analysis: {
                skillMd
            }
        });
    }
    catch (err)
    {
        console.error("[analyze] AI call failed:", err.message);
        log("error", "Analysis failed: " + err.message);
        res.status(500).json({ error: "AI analysis failed.", detail: err.message });
    }
});

router.get("/download/:analysisId", (req, res) =>
{
    const { analysisId } = req.params;

    if (!UUID_RE.test(analysisId))
    {
        return res.status(400).json({ error: "Invalid analysis ID." });
    }

    const filePath = path.join(__dirname, "..", "output", `${analysisId}.md`);

    if (!fs.existsSync(filePath))
    {
        return res.status(404).json({ error: "Analysis not found. It may have expired." });
    }

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"Skill.md\"");
    res.sendFile(filePath);
});

module.exports = router;
