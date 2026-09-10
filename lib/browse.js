/**
 * Real web browsing/search for agents — a plain page fetch + text extraction,
 * and a no-API-key search fallback via DuckDuckGo's HTML endpoint. No headless
 * browser, no JS execution — just HTTP + HTML parsing, which covers the large
 * majority of "look this up" requests without the cost/complexity of a real
 * browser engine.
 *
 * Swap in a real search API if you have one: set SEARCH_API_URL/SEARCH_API_KEY
 * and adapt searchWeb() below — DuckDuckGo HTML scraping is a reasonable
 * zero-config default, not the best long-term answer for heavy use.
 */
const cheerio = require('cheerio');

let fetch;
try {
    fetch = require('node-fetch');
} catch (e) {
    fetch = globalThis.fetch;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; AgentOSBrowser/1.0; +https://github.com/jaykk99/agentos-backend)';
const MAX_TEXT_LENGTH = 8000;

/**
 * Fetch a URL and return its title + readable text (scripts/styles/nav/footer
 * stripped). Real HTTP request, real response — reports failures honestly
 * (bad status, timeout, non-HTML content) rather than inventing content.
 */
async function browseUrl(targetUrl) {
    let urlObj;
    try {
        urlObj = new URL(targetUrl);
    } catch (e) {
        return { ok: false, error: `Invalid URL: ${targetUrl}` };
    }
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
        return { ok: false, error: `Unsupported protocol: ${urlObj.protocol}` };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
        const res = await fetch(urlObj.toString(), {
            headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
            redirect: 'follow',
            signal: controller.signal
        });
        clearTimeout(timeout);

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('text/html') && !contentType.includes('xml')) {
            return {
                ok: res.ok,
                status: res.status,
                finalUrl: res.url || urlObj.toString(),
                contentType,
                note: 'Non-HTML content — returning only status, not a text body.'
            };
        }

        const html = await res.text();
        const $ = cheerio.load(html);
        $('script, style, nav, footer, noscript, svg').remove();

        const title = $('title').first().text().trim();
        const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH);

        return {
            ok: res.ok,
            status: res.status,
            finalUrl: res.url || urlObj.toString(),
            title,
            text,
            truncated: text.length >= MAX_TEXT_LENGTH
        };
    } catch (err) {
        clearTimeout(timeout);
        return { ok: false, error: err.name === 'AbortError' ? 'Request timed out after 20s' : err.message };
    }
}

/**
 * Search DuckDuckGo's no-JS HTML endpoint and return real result titles,
 * URLs, and snippets. No API key required. Fails honestly (empty results,
 * blocked request) rather than fabricating hits.
 */
async function searchWeb(query, limit = 8) {
    if (!query || !query.trim()) return { ok: false, error: "'query' is required." };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.trim())}`, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!res.ok) {
            return { ok: false, error: `Search backend returned ${res.status}` };
        }

        const html = await res.text();
        const $ = cheerio.load(html);
        const results = [];

        $('.result').each((_, el) => {
            if (results.length >= limit) return;
            const linkEl = $(el).find('.result__a').first();
            const title = linkEl.text().trim();
            let href = linkEl.attr('href') || '';
            // DuckDuckGo's HTML endpoint wraps outbound links in a redirect —
            // unwrap it so the agent gets the real destination URL.
            const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
            if (uddgMatch) href = decodeURIComponent(uddgMatch[1]);
            const snippet = $(el).find('.result__snippet').first().text().trim();
            if (title && href) results.push({ title, url: href, snippet });
        });

        return { ok: true, query: query.trim(), count: results.length, results };
    } catch (err) {
        clearTimeout(timeout);
        return { ok: false, error: err.name === 'AbortError' ? 'Search timed out after 15s' : err.message };
    }
}

module.exports = { browseUrl, searchWeb };
