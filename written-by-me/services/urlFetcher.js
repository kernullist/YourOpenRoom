const dns = require("dns").promises;
const net = require("net");

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

// The fetch-url and translate routes take any URL, and the OpenRoom dev server
// loads this module in-process, so without a host check they read loopback
// services, the LAN, or a cloud metadata endpoint -- directly or via a redirect.
function ipv4IsPrivate(address)
{
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function isPrivateAddress(raw)
{
    const address = String(raw).toLowerCase().replace(/^\[(.*)\]$/, "$1");
    if (net.isIP(address) === 4)
    {
        return ipv4IsPrivate(address);
    }
    if (net.isIP(address) === 6)
    {
        if (address === "::" || address === "::1" || /^f[cd]/.test(address) || /^fe[89ab]/.test(address))
        {
            return true;
        }
        // IPv4-mapped / -compatible / NAT64, dotted or in the hex form URL() produces.
        const tail = address.match(/^(?:::ffff:|::|64:ff9b::)(.+)$/);
        if (tail)
        {
            const dotted = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail[1]) ? tail[1] : null;
            const hex = tail[1].match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
            const v4 = dotted || (hex
                ? [parseInt(hex[1], 16) >> 8, parseInt(hex[1], 16) & 255, parseInt(hex[2], 16) >> 8, parseInt(hex[2], 16) & 255].join(".")
                : null);
            return v4 ? ipv4IsPrivate(v4) : false;
        }
        return false;
    }
    return true;
}

async function assertPublicUrl(target)
{
    if (target.protocol !== "http:" && target.protocol !== "https:")
    {
        throw new Error("Only http and https URLs are supported.");
    }
    const host = target.hostname.replace(/^\[(.*)\]$/, "$1");
    if (!host || host === "localhost" || host.endsWith(".localhost") ||
        (net.isIP(host) !== 0 && isPrivateAddress(host)))
    {
        throw new Error("Refusing to fetch a local or private-network address.");
    }
    const records = net.isIP(host) !== 0 ? [{ address: host }] : await dns.lookup(host, { all: true });
    if (records.length === 0 || records.some((record) => isPrivateAddress(record.address)))
    {
        throw new Error("Refusing to fetch a host that resolves to a private-network address.");
    }
}

async function readLimitedText(response)
{
    const reader = response.body ? response.body.getReader() : null;
    if (!reader)
    {
        return "";
    }
    const chunks = [];
    let total = 0;
    for (;;)
    {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES)
        {
            await reader.cancel();
            throw new Error("Page is too large to analyze.");
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
}

async function fetchUrlContent(url)
{
    let target = new URL(url);
    let response = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1)
    {
        await assertPublicUrl(target);
        response = await fetch(target, {
            headers: {
                "User-Agent": "WrittenByMe/1.0 (Style Analyzer)"
            },
            redirect: "manual",
            signal: AbortSignal.timeout(30000)
        });
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location)
        {
            target = new URL(location, target);
            response = null;
            continue;
        }
        break;
    }
    if (!response)
    {
        throw new Error("Too many redirects.");
    }

    if (!response.ok)
    {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain"))
    {
        throw new Error(`Unsupported content type: ${contentType}. Only text/html and text/plain are supported.`);
    }

    const html = await readLimitedText(response);
    return extractText(html, target.toString());
}

function extractText(html, url)
{
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : url;

    let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
        .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
        .replace(/<select[^>]*>[\s\S]*?<\/select>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<\/div>/gi, "\n")
        .replace(/<\/li>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]+/g, " ")
        .trim();

    if (!text)
    {
        throw new Error("No extractable text content found.");
    }

    return { title, text };
}

module.exports = { fetchUrlContent, isPrivateAddress };
