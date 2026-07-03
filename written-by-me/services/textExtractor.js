const fs = require("fs");
const path = require("path");

let iconvLite = null;
try
{
    iconvLite = require("iconv-lite");
}
catch (_)
{
}

let mammothModule = null;
try
{
    mammothModule = require("mammoth");
}
catch (_)
{
}

let pdfParseModule = null;
try
{
    pdfParseModule = require("pdf-parse");
}
catch (_)
{
}

async function extractText(filePath, originalName)
{
    const ext = path.extname(originalName).toLowerCase();

    if (ext === ".docx")
    {
        return extractTextFromDocx(filePath);
    }

    if (ext === ".pdf")
    {
        return extractTextFromPdf(filePath);
    }

    return extractRawText(filePath);
}

function extractRawText(filePath)
{
    try
    {
        const buf = fs.readFileSync(filePath);
        let text = buf.toString("utf-8");

        if (iconvLite && (text.includes("\ufffd") || hasGarbledKorean(buf)))
        {
            try
            {
                text = iconvLite.decode(buf, "euc-kr");
            }
            catch (decodeErr)
            {
                console.warn("[textExtractor] EUC-KR decode failed:", decodeErr.message);
                try
                {
                    text = buf.toString("latin1");
                }
                catch (latinErr)
                {
                    console.warn("[textExtractor] latin1 fallback also failed:", latinErr.message);
                }
            }
        }

        return text;
    }
    catch (err)
    {
        throw new Error(`Failed to read text file: ${err.message}`);
    }
}

function hasGarbledKorean(buf)
{
    const sample = buf.slice(0, Math.min(buf.length, 512));
    const text = sample.toString("utf-8");
    const garbled = text.includes("\ufffd\u0020\ufffd") || text.includes("\u00b0\u00a1");
    return garbled;
}

async function extractTextFromDocx(filePath)
{
    if (!mammothModule)
    {
        throw new Error("Cannot extract .docx: mammoth module not available.");
    }

    try
    {
        const result = await mammothModule.extractRawText({ path: filePath });
        if (!result.value || result.value.trim().length === 0)
        {
            const messages = result.messages.map((m) => m.message).join("; ");
            throw new Error(`No text extracted from .docx. ${messages}`);
        }
        return result.value;
    }
    catch (err)
    {
        if (err.message.includes("No text extracted"))
        {
            throw err;
        }
        throw new Error(`Failed to extract .docx: ${err.message}`);
    }
}

async function extractTextFromPdf(filePath)
{
    if (!pdfParseModule)
    {
        throw new Error("Cannot extract .pdf: pdf-parse module not available.");
    }

    try
    {
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdfParseModule(dataBuffer);
        if (!data.text || data.text.trim().length === 0)
        {
            throw new Error("No extractable text layer found in PDF (scanned image PDF not supported).");
        }
        return data.text;
    }
    catch (err)
    {
        if (err.message.includes("No extractable"))
        {
            throw err;
        }
        throw new Error(`Failed to extract .pdf: ${err.message}`);
    }
}

module.exports = { extractText };
