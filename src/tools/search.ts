/**
 * General-purpose web search via DuckDuckGo's HTML endpoint.
 * Returns a list of {title, snippet, url}. URL extraction decodes the
 * uddg redirect parameter to get the *real* destination URL.
 */
import type { Config } from "../config.js";
import { fetchWithRetry } from "../utils/fetch.js";

export interface SearchHit {
  title: string;
  snippet: string;
  url: string;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function extractRealUrl(href: string): string {
  // DDG links look like //duckduckgo.com/l/?uddg=<encoded>&...
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m && typeof m[1] === "string") {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return href;
    }
  }
  return href;
}

function parseResults(html: string, limit: number): SearchHit[] {
  const out: SearchHit[] = [];
  // Each result roughly looks like:
  // <a class="result__a" href="...">Title</a>
  // <a class="result__snippet">...</a>
  // <a class="result__url" href="...">...</a>
  // We'll iterate over result blocks via a loose regex.
  const blockRe = /<div[^>]+class=["'][^"']*result["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
  let m: RegExpExecArray | null;
  const blocks: string[] = [];
  while ((m = blockRe.exec(html)) !== null && typeof m[1] === "string") blocks.push(m[1]);
  if (blocks.length === 0) {
    // Fallback: scan for anchors + snippet pairs linearly
    const linkRe = /<a[^>]+class=["']result__a["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g;
    const snipRe = /<a[^>]+class=["']result__snippet["'][^>]*>([\s\S]*?)<\/a>/g;
    const titles: { url: string; title: string }[] = [];
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(html)) !== null) {
      if (typeof lm[1] === "string" && typeof lm[2] === "string") {
        titles.push({ url: extractRealUrl(lm[1]), title: stripTags(decodeHtmlEntities(lm[2])) });
      }
    }
    let i = 0;
    let sm: RegExpExecArray | null;
    while ((sm = snipRe.exec(html)) !== null && i < titles.length) {
      const t = titles[i++];
      if (t && typeof sm[1] === "string") {
        out.push({
          url: t.url,
          title: t.title,
          snippet: stripTags(decodeHtmlEntities(sm[1])),
        });
      }
    }
    return out.slice(0, limit);
  }
  for (const b of blocks) {
    if (out.length >= limit) break;
    const linkM = /<a[^>]+class=["']result__a["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/.exec(b);
    const snipM = /<a[^>]+class=["']result__snippet["'][^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!linkM || typeof linkM[1] !== "string" || typeof linkM[2] !== "string") continue;
    out.push({
      url: extractRealUrl(linkM[1]),
      title: stripTags(decodeHtmlEntities(linkM[2])),
      snippet: snipM && typeof snipM[1] === "string" ? stripTags(decodeHtmlEntities(snipM[1])) : "",
    });
  }
  return out;
}

export async function generalSearch(cfg: Config, query: string, limit = 5): Promise<SearchHit[]> {
  void cfg;
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  url.searchParams.set("kl", "us-en");
  const res = await fetchWithRetry(url.toString(), {
    method: "GET",
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9,fa;q=0.8",
    },
    timeoutMs: 8_000,
    retries: 1,
    retryOn: [429, 502, 503, 504],
  });
  const html = (await res.text()).slice(0, 400_000);
  return parseResults(html, limit);
}

/**
 * Trending topics. DDG doesn't expose a stable JSON endpoint, so this is
 * a best-effort scrape of the "trending" page. Returns whatever we can
 * extract; may be empty.
 */
export async function searchTrending(cfg: Config, region = "global"): Promise<{ topic: string; url?: string }[]> {
  void cfg;
  void region;
  try {
    const res = await fetchWithRetry("https://duckduckgo.com/?q=trending&t=h_&ia=trending", {
      method: "GET",
      headers: { "user-agent": UA, accept: "text/html" },
      timeoutMs: 8_000,
      retries: 1,
    });
    const html = (await res.text()).slice(0, 200_000);
    const out: { topic: string; url?: string }[] = [];
    const re = /<a[^>]+class=["']tile__title["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      if (typeof m[1] !== "string" || typeof m[2] !== "string") continue;
      const topic = stripTags(decodeHtmlEntities(m[2]));
      if (topic) out.push({ topic, url: extractRealUrl(m[1]) });
      if (out.length >= 15) break;
    }
    if (out.length === 0) {
      // Fallback: scrape visible topic-ish strings from trending-tile anchors
      const re2 = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]{4,80})<\/a>/g;
      while ((m = re2.exec(html)) !== null) {
        if (typeof m[1] !== "string" || typeof m[2] !== "string") continue;
        const topic = stripTags(decodeHtmlEntities(m[2]));
        if (topic && topic.length > 4) out.push({ topic, url: extractRealUrl(m[1]) });
        if (out.length >= 15) break;
      }
    }
    return out;
  } catch {
    return [];
  }
}
