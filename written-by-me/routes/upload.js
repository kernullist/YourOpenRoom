const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { extractText } = require("../services/textExtractor");
const { analyzeWithBatching, analyzeStyle } = require("../services/ai");
const { fetchUrlContent } = require("../services/urlFetcher");

function log(type, message)
{
    if (global.__wbmLogEvent)
    {
        global.__wbmLogEvent(type, message);
    }
}

const router = express.Router();

const MAX_FILE_SIZE = (parseInt(process.env.MAX_FILE_SIZE_MB) || 10) * 1024 * 1024;

(function cleanupUploadsDir()
{
    const dir = path.join(__dirname, "..", "uploads");
    try
    {
        for (const entry of fs.readdirSync(dir))
        {
            try { fs.unlinkSync(path.join(dir, entry)); }
            catch (_) {}
        }
    }
    catch (_) {}
})();
const MAX_STORED_CONTENT = 50000;
const MAX_TOTAL_CHARS = 100000;

const ALLOWED_EXTENSIONS = [
    ".txt", ".md", ".csv", ".log",
    ".cpp", ".c", ".h", ".hpp", ".cs", ".java",
    ".py", ".js", ".ts", ".jsx", ".tsx",
    ".rs", ".go", ".rb", ".php", ".swift", ".kt",
    ".html", ".css", ".scss", ".json", ".xml", ".yaml", ".yml",
    ".docx", ".pdf"
];

const textStore = new Map();
const urlStore = new Map();

const storage = multer.diskStorage({
    destination: path.join(__dirname, "..", "uploads"),
    filename: (_req, file, cb) =>
    {
        const id = uuidv4();
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, id + ext);
    }
});

const fileFilter = (_req, file, cb) =>
{
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext))
    {
        cb(null, true);
    }
    else
    {
        cb(new Error(`Unsupported file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`));
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: MAX_FILE_SIZE, files: 10 }
});

router.post("/upload", async (req, res) =>
{
    upload.array("files", 10)(req, res, async (err) =>
    {
        if (err)
        {
            if (err instanceof multer.MulterError)
            {
                if (err.code === "LIMIT_FILE_SIZE")
                {
                    return res.status(413).json({ error: `File too large. Max ${process.env.MAX_FILE_SIZE_MB || 10}MB.` });
                }
                if (err.code === "LIMIT_FILE_COUNT")
                {
                    return res.status(400).json({ error: "Maximum 10 files allowed." });
                }
                return res.status(400).json({ error: err.message });
            }
            return res.status(400).json({ error: err.message });
        }

        if (!req.files || req.files.length === 0)
        {
            return res.status(400).json({ error: "No files provided." });
        }

    try
    {
        log("info", `Analysis started: ${texts.length} sources, ${totalChars} total chars`);
            const results = [];
            for (const file of req.files)
            {
                const text = await extractText(file.path, file.originalname);
                const fileId = path.basename(file.filename, path.extname(file.filename));

                const capped = text.length > MAX_STORED_CONTENT
                    ? text.slice(0, MAX_STORED_CONTENT)
                    : text;

                textStore.set(fileId, { name: file.originalname, content: capped });

                console.log(`[upload] Stored: ${file.originalname} (${text.length} chars, capped to ${capped.length})`);

                log("info", `Uploaded: ${file.originalname} (${text.length} chars)`);

                results.push({
                    id: fileId,
                    name: file.originalname,
                    size: file.size,
                    type: path.extname(file.originalname).toLowerCase()
                });
            }
            res.json({ ok: true, files: results });
        }
        catch (extractErr)
        {
            res.status(500).json({ error: "Text extraction failed.", detail: extractErr.message });
        }
    });
});

router.post("/analyze-with-paste", async (req, res) =>
{
    const { fileIds, pasteTexts, pastedText, urlIds, model, preferredLanguage } = req.body;
    const texts = [];
    const missingFileIds = [];
    const missingUrlIds = [];

    if (pasteTexts && Array.isArray(pasteTexts))
    {
        for (const pt of pasteTexts)
        {
            if (pt.content && pt.content.trim().length > 0)
            {
                const source = pt.source || "pasted-text";
                texts.push({ source, content: pt.content.trim() });
            }
        }
    }
    else if (pastedText && pastedText.trim().length > 0)
    {
        texts.push({ source: "pasted-text", content: pastedText.trim() });
    }

    if (urlIds && Array.isArray(urlIds))
    {
        for (const urlId of urlIds)
        {
            const stored = urlStore.get(urlId);
            if (stored)
            {
                texts.push({ source: "[URL] " + stored.name, content: stored.content });
            }
            else
            {
                missingUrlIds.push(urlId);
            }
        }
    }

    if (fileIds && Array.isArray(fileIds))
    {
        for (const fileId of fileIds)
        {
            const stored = textStore.get(fileId);
            if (stored)
            {
                texts.push({ source: stored.name, content: stored.content });
            }
            else
            {
                missingFileIds.push(fileId);
            }
        }
    }

    if (texts.length === 0)
    {
        return res.status(400).json({
            error: "No content available. Upload files, paste text, or add URLs first.",
            missingFileIds: missingFileIds.length > 0 ? missingFileIds : undefined,
            missingUrlIds: missingUrlIds.length > 0 ? missingUrlIds : undefined
        });
    }

    const totalChars = texts.reduce((sum, t) => sum + (t.content ? t.content.length : 0), 0);
    if (totalChars === 0)
    {
        return res.status(400).json({ error: "All provided texts are empty." });
    }

    if (totalChars > MAX_TOTAL_CHARS)
    {
        return res.status(400).json({
            error: `Combined text too large (${totalChars} chars). Maximum is ${MAX_TOTAL_CHARS} characters.`
        });
    }

    try
    {
        const { skillMd, strategy, batches } = await analyzeWithBatching(texts, preferredLanguage || "auto", model);
        const analysisId = uuidv4();
        const outputPath = path.join(__dirname, "..", "output", `${analysisId}.md`);
        await fs.promises.writeFile(outputPath, skillMd, "utf-8");

        const resp = {
            ok: true,
            analysisId,
            strategy,
            batches,
            analysis: {
                skillMd
            }
        };

        if (missingFileIds.length > 0)
        {
            resp.warning = `${missingFileIds.length} uploaded file(s) could not be found. The server may have restarted. Please re-upload those files.`;
            resp.missingFileIds = missingFileIds;
        }

        if (missingUrlIds.length > 0)
        {
            resp.warning = (resp.warning ? resp.warning + " " : "") + `${missingUrlIds.length} URL(s) could not be found. Please re-fetch them.`;
            resp.missingUrlIds = missingUrlIds;
        }

        log("info", `Analysis complete: ${skillMd.length} chars Skill.md generated (${strategy}, ${batches} batches)`);

        res.json(resp);
    }
    catch (err)
    {
        console.error("[analyze] AI call failed:", err.message);
        log("error", "Analysis failed: " + err.message);
        res.status(500).json({ error: "AI analysis failed.", detail: err.message });
    }
});

router.post("/fetch-url", async (req, res) =>
{
    const { url } = req.body;

    if (!url || typeof url !== "string")
    {
        return res.status(400).json({ error: "URL is required." });
    }

    let parsed;
    try
    {
        parsed = new URL(url);
    }
    catch (_)
    {
        return res.status(400).json({ error: "Invalid URL." });
    }

    if (!parsed.protocol.startsWith("http"))
    {
        return res.status(400).json({ error: "Only http/https URLs are supported." });
    }

    try
    {
        log("info", "Fetching URL: " + url);
        const { title, text } = await fetchUrlContent(url);
        const id = uuidv4();
        const source = title.length > 80 ? title.slice(0, 80) + "..." : title;

        const capped = text.length > MAX_STORED_CONTENT
            ? text.slice(0, MAX_STORED_CONTENT)
            : text;

        urlStore.set(id, { url, name: source, content: capped });

        log("info", `URL fetched: ${source} (${text.length} chars, capped to ${capped.length})`);

        res.json({
            ok: true,
            id,
            title: source,
            charCount: text.length
        });
    }
    catch (err)
    {
        log("error", "URL fetch failed: " + err.message);
        res.status(500).json({ error: "Failed to fetch URL.", detail: err.message });
    }
});

router.post("/clear", (_req, res) =>
{
    const count = textStore.size + urlStore.size;
    textStore.clear();
    urlStore.clear();

    const dir = path.join(__dirname, "..", "uploads");
    try
    {
        for (const entry of fs.readdirSync(dir))
        {
            try { fs.unlinkSync(path.join(dir, entry)); }
            catch (_) {}
        }
    }
    catch (_) {}

    res.json({ ok: true, cleared: count });
});

router.post("/translate", async (req, res) =>
{
    const { text, direction, skillMd, model } = req.body;

    if (!text || !text.trim())
    {
        return res.status(400).json({ error: "No text to translate." });
    }

    if (!skillMd)
    {
        return res.status(400).json({ error: "No style reference. Run an analysis first." });
    }

    const dirLabel = direction === "kr2en" ? "Korean to English" : "English to Korean";
    const targetLang = direction === "kr2en" ? "English" : "Korean";

    const prompt = `Translate the following text to ${targetLang}. The translation MUST be written in exactly this writing style:

${skillMd}

TEXT TO TRANSLATE:
${text.trim()}

Return ONLY the translated text with no additional commentary.`;

    try
    {
        log("info", `Translation started: ${dirLabel} (${text.length} chars)`);
        const result = await analyzeStyle(prompt, model);
        log("info", `Translation complete: ${result.length} chars`);
        res.json({ ok: true, translated: result });
    }
    catch (err)
    {
        console.error("[translate] Failed:", err.message);
        log("error", "Translation failed: " + err.message);
        res.status(500).json({ error: "Translation failed.", detail: err.message });
    }
});

module.exports = router;
