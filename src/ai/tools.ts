/**
 * Tool definitions (OpenAI function-calling format) and the dispatcher
 * that actually runs them. We keep tool *schemas* here, and tool
 * *implementations* in `../tools/*` for separation of concerns.
 */
import type { Config } from "../config.js";
import type { ToolDef } from "../types.js";
import { searchMusic, searchArtist, searchAlbum } from "../tools/music.js";
import { fetchLinkMetadata } from "../tools/link.js";
import { generalSearch, searchTrending } from "../tools/search.js";
import { createLogger } from "../utils/logger.js";

export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_song",
      description:
        "Search for a song by a free-text query (artist, title, or both). Returns top matches with artist, album, release date, duration, genre, and a 30s preview URL.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Song title, artist, or any combination." },
          limit: { type: "number", description: "Max results to return (1-5).", default: 3 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_artist",
      description: "Search for a music artist. Returns genre, top tracks, and a short bio snippet.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number", default: 3 } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_album",
      description: "Search for a music album. Returns artist, year, track count, and a cover-art URL.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number", default: 3 } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_link",
      description:
        "Fetch a URL and extract OpenGraph / metadata (title, description, image, site name). Use this whenever a link is shared.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute http(s) URL." } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Run a general web search (DuckDuckGo HTML) and return the top results as {title, snippet, url}. Useful for games, movies, internet trends, and current events.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", default: 5 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "trending_topics",
      description: "Fetch a list of currently trending internet topics. Best-effort; no guarantees on freshness.",
      parameters: {
        type: "object",
        properties: { region: { type: "string", default: "global" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_nickname",
      description:
        "Save a nickname for a user so the bot can refer to them by it later. Use only when the nickname is clearly offered or strongly implied.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "number" },
          nickname: { type: "string" },
        },
        required: ["user_id", "nickname"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_joke",
      description: "Add a running joke / inside reference to long-term memory for future callbacks.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description:
        "Get the current server date and time. Use this whenever the user asks about 'today', 'now', the current date/time, 'what day is it', or anything time-dependent. The current time is also injected into the system prompt on every call, so you only need this for re-checks or if you need a fresh value.",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description: "Optional IANA timezone name, e.g. 'Asia/Tehran', 'Europe/London'. Defaults to UTC.",
          },
        },
        additionalProperties: false,
      },
    },
  },
];

export interface ToolExecDeps {
  cfg: Config;
  onToolCall?: (name: string) => void | Promise<void>;
  onNickname?: (userId: number, nickname: string) => Promise<void>;
  onJoke?: (text: string) => Promise<void>;
}

export interface ToolResult {
  ok: boolean;
  /** Short, model-friendly summary of the result. */
  summary: string;
  /** Raw structured data, optionally attached to memory. */
  data?: unknown;
}

function summarize(value: unknown, max = 1500): string {
  try {
    const s = JSON.stringify(value);
    return s.length <= max ? s : s.slice(0, max) + "…";
  } catch {
    return String(value).slice(0, max);
  }
}

export async function executeToolCall(
  deps: ToolExecDeps,
  name: string,
  rawArgs: string,
): Promise<ToolResult> {
  const log = createLogger(deps.cfg, "tools");
  await deps.onToolCall?.(name);
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch (err) {
    log.warn("tool_args_parse_failed", { name, raw: rawArgs.slice(0, 200) });
    return { ok: false, summary: `invalid arguments: ${(err as Error).message}` };
  }

  try {
    switch (name) {
      case "search_song": {
        const q = String(args.query ?? "").trim();
        const limit = Number(args.limit ?? 3);
        if (!q) return { ok: false, summary: "query is empty" };
        const r = await searchMusic(deps.cfg, q, Math.min(Math.max(limit, 1), 5));
        return { ok: true, summary: summarize(r), data: r };
      }
      case "search_artist": {
        const q = String(args.query ?? "").trim();
        const limit = Number(args.limit ?? 3);
        if (!q) return { ok: false, summary: "query is empty" };
        const r = await searchArtist(deps.cfg, q, Math.min(Math.max(limit, 1), 5));
        return { ok: true, summary: summarize(r), data: r };
      }
      case "search_album": {
        const q = String(args.query ?? "").trim();
        const limit = Number(args.limit ?? 3);
        if (!q) return { ok: false, summary: "query is empty" };
        const r = await searchAlbum(deps.cfg, q, Math.min(Math.max(limit, 1), 5));
        return { ok: true, summary: summarize(r), data: r };
      }
      case "fetch_link": {
        const url = String(args.url ?? "").trim();
        if (!/^https?:\/\//i.test(url)) return { ok: false, summary: "invalid url" };
        const r = await fetchLinkMetadata(deps.cfg, url);
        return { ok: true, summary: summarize(r), data: r };
      }
      case "web_search": {
        const q = String(args.query ?? "").trim();
        const limit = Number(args.limit ?? 5);
        if (!q) return { ok: false, summary: "query is empty" };
        const r = await generalSearch(deps.cfg, q, Math.min(Math.max(limit, 1), 10));
        return { ok: true, summary: summarize(r), data: r };
      }
      case "trending_topics": {
        const region = String(args.region ?? "global");
        const r = await searchTrending(deps.cfg, region);
        return { ok: true, summary: summarize(r), data: r };
      }
      case "set_nickname": {
        const uid = Number(args.user_id);
        const nick = String(args.nickname ?? "").trim();
        if (!uid || !nick) return { ok: false, summary: "user_id and nickname required" };
        await deps.onNickname?.(uid, nick);
        return { ok: true, summary: `nickname saved: ${nick}` };
      }
      case "add_joke": {
        const text = String(args.text ?? "").trim();
        if (!text) return { ok: false, summary: "text required" };
        await deps.onJoke?.(text);
        return { ok: true, summary: "joke added" };
      }
      case "get_current_time": {
        const now = new Date();
        const tz = String(args.timezone ?? "UTC");
        let tzFormatted: string | null = null;
        try {
          tzFormatted = new Intl.DateTimeFormat("en-GB", {
            timeZone: tz,
            dateStyle: "full",
            timeStyle: "long",
          }).format(now);
        } catch {
          tzFormatted = null;
        }
        return {
          ok: true,
          summary: JSON.stringify({
            iso: now.toISOString(),
            utc: now.toUTCString(),
            unix_ms: now.getTime(),
            timezone_requested: tz,
            timezone_formatted: tzFormatted,
            server_local: now.toString(),
          }),
          data: { tz },
        };
      }
      default:
        return { ok: false, summary: `unknown tool: ${name}` };
    }
  } catch (err) {
    log.error("tool_failed", { name, err: (err as Error).message });
    return { ok: false, summary: `tool ${name} failed: ${(err as Error).message}` };
  }
}
