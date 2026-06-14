/**
 * Link metadata extraction. Fetches the URL with a short timeout, follows
 * redirects, and pulls OpenGraph / Twitter / standard meta tags. Falls
 * back to <title> / <meta name="description"> when OG is missing.
 */
import type { Config } from "../config.js";
import { fetchWithRetry } from "../utils/fetch.js";

export interface LinkMetadata {
  url: string;
  finalUrl: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  type?: string;
  favicon?: string;
}

const UA =
  "Mozilla/5.0 (compatible; MooshtabiBot/1.0; +https://github.com/) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function metaContent(html: string, attr: "name" | "property", key: string): string | undefined {
  // Match <meta name="..." content="..."> or <meta property="..." content="...">
  const re = new RegExp(
    `<meta[^>]+${attr}=["']${key}["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const m = re.exec(html);
  if (m && typeof m[1] === "string") return decodeEntities(m[1]);
  // try the reverse attribute order
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${key}["']`,
    "i",
  );
  const m2 = re2.exec(html);
  return m2 && typeof m2[1] === "string" ? decodeEntities(m2[1]) : undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function titleFromHtml(html: string): string | undefined {
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return m && typeof m[1] === "string" ? decodeEntities(m[1].trim()) : undefined;
}

function faviconFromHtml(html: string, base: string): string | undefined {
  const re = /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/i;
  const m = re.exec(html);
  if (!m || typeof m[1] !== "string") return undefined;
  try {
    return new URL(m[1], base).toString();
  } catch {
    return undefined;
  }
}

function siteFromUrl(u: string): string | undefined {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export async function fetchLinkMetadata(cfg: Config, url: string): Promise<LinkMetadata> {
  void cfg;
  const res = await fetchWithRetry(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9,fa;q=0.8",
    },
    timeoutMs: 8_000,
    retries: 1,
    retryOn: [429, 500, 502, 503, 504],
  });
  const finalUrl = res.url || url;
  const ctype = res.headers.get("content-type") || "";
  // Cap how much we read to keep memory bounded.
  const html = (await res.text()).slice(0, 200_000);

  if (!ctype.includes("text/html") && !ctype.includes("xml")) {
    return { url, finalUrl, siteName: siteFromUrl(finalUrl) };
  }

  return {
    url,
    finalUrl,
    title:
      metaContent(html, "property", "og:title") ??
      metaContent(html, "name", "twitter:title") ??
      titleFromHtml(html),
    description:
      metaContent(html, "property", "og:description") ??
      metaContent(html, "name", "description") ??
      metaContent(html, "name", "twitter:description"),
    image:
      metaContent(html, "property", "og:image") ??
      metaContent(html, "name", "twitter:image"),
    siteName:
      metaContent(html, "property", "og:site_name") ?? siteFromUrl(finalUrl),
    type: metaContent(html, "property", "og:type"),
    favicon: faviconFromHtml(html, finalUrl),
  };
}
