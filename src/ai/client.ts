/**
 * OpenAI-compatible chat client.
 *
 *   - Non-streaming: `createChatCompletion()`  — returns the full response.
 *     This is the workhorse for the tool-calling loop because we need the
 *     full `tool_calls` payload to execute.
 *
 *   - Streaming:    `createChatCompletionStream()` — returns an async
 *     iterable of `StreamEvent`s. Supports accumulating tool_calls as they
 *     stream in (mirroring OpenAI's delta format).
 *
 * Both implement:
 *   - AbortController-based timeout
 *   - Exponential-backoff retry on 429/5xx/network errors
 *   - Respect for `Retry-After` header
 *   - Per-isolate in-memory rate limiting (token bucket)
 */
import type {
  ChatCompletionResponse,
  ChatContentPart,
  ChatMessage,
  ToolCall,
  ToolDef,
} from "../types.js";
import type { Config } from "../config.js";
import { fetchWithRetry, HttpError } from "../utils/fetch.js";
import { createLogger } from "../utils/logger.js";
import { parseRetryAfter, sleep } from "../utils/util.js";

/* ---------- Per-isolate rate limiter (token bucket) ---------- */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(private readonly capacity: number, private readonly refillPerSec: number) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = now;
  }
  async take(n = 1): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      const need = n - this.tokens;
      await sleep(Math.ceil((need / this.refillPerSec) * 1000));
    }
  }
}
const aiBucket = new TokenBucket(6, 1.5); // burst 6, ~1.5 rps sustained

/* ---------- Options ---------- */
export interface CompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  tools?: ToolDef[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  timeoutMs?: number;
  retries?: number;
  /** Optional AbortSignal to cancel the request (e.g. on timeout from caller). */
  signal?: AbortSignal;
  /**
   * Hint reasoning-capable providers to minimise or skip their internal
   * scratchpad. Forwarded verbatim. Ignored by providers that don't
   * support it (e.g. stock OpenAI chat models).
   */
  reasoning_effort?: "low" | "medium" | "high" | "none";
}

interface RawRequestBody {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  tools?: ToolDef[];
  tool_choice?: CompletionOptions["tool_choice"];
  stream?: boolean;
  reasoning_effort?: CompletionOptions["reasoning_effort"];
}

/* ---------- Non-streaming ---------- */
export async function createChatCompletion(
  cfg: Config,
  messages: ChatMessage[],
  opts: CompletionOptions = {},
): Promise<ChatCompletionResponse> {
  const log = createLogger(cfg, "ai");
  await aiBucket.take(1);
  const body: RawRequestBody = {
    model: opts.model ?? cfg.model,
    messages,
    temperature: opts.temperature ?? 0.9,
    max_tokens: opts.max_tokens ?? 600,
    top_p: opts.top_p ?? 1,
    ...(opts.frequency_penalty !== undefined ? { frequency_penalty: opts.frequency_penalty } : {}),
    ...(opts.presence_penalty !== undefined ? { presence_penalty: opts.presence_penalty } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.tool_choice ? { tool_choice: opts.tool_choice } : {}),
    ...(opts.reasoning_effort ? { reasoning_effort: opts.reasoning_effort } : {}),
    stream: false,
  };

  const url = `${cfg.tokenRouterBase}/chat/completions`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.tokenRouterKey}`,
    },
    body: JSON.stringify(body),
    timeoutMs: opts.timeoutMs ?? 25_000,
    retries: opts.retries ?? 2,
    signal: opts.signal,
  });

  const data = (await res.json()) as ChatCompletionResponse;
  log.debug("completion", {
    model: data.model,
    usage: data.usage,
    finish: data.choices?.[0]?.finish_reason,
  });
  return data;
}

/* ---------- Streaming ---------- */
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments_delta?: string }
  | { type: "tool_calls_done"; tool_calls: ToolCall[] }
  | { type: "finish"; reason: string | null }
  | { type: "error"; message: string };

/**
 * Streaming chat completion. Returns an AsyncIterable of `StreamEvent`s.
 *
 * The caller is responsible for iterating to drain the body. If iteration
 * stops early, the underlying connection is aborted (the response body
 * reader is cancelled).
 */
export async function* createChatCompletionStream(
  cfg: Config,
  messages: ChatMessage[],
  opts: CompletionOptions = {},
): AsyncGenerator<StreamEvent, void, void> {
  const log = createLogger(cfg, "ai");
  await aiBucket.take(1);

  const body: RawRequestBody = {
    model: opts.model ?? cfg.model,
    messages,
    temperature: opts.temperature ?? 0.9,
    max_tokens: opts.max_tokens ?? 600,
    top_p: opts.top_p ?? 1,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.tool_choice ? { tool_choice: opts.tool_choice } : {}),
    stream: true,
  };

  const url = `${cfg.tokenRouterBase}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25_000);
  opts.signal?.addEventListener("abort", () => controller.abort());

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${cfg.tokenRouterKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    log.error("stream_fetch_failed", { msg: (err as Error).message });
    yield { type: "error", message: (err as Error).message };
    return;
  }

  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const errBody = await res.text().catch(() => "");
    if (res.status === 429) {
      const ra = parseRetryAfter(res.headers.get("retry-after"), errBody);
      yield { type: "error", message: `rate_limited retry_after=${ra}` };
      return;
    }
    yield { type: "error", message: `HTTP ${res.status}: ${errBody.slice(0, 300)}` };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  // tool_call accumulator
  const tcAccum = new Map<number, { id: string; name: string; args: string }>();

  const cleanup = () => {
    clearTimeout(timer);
    try {
      reader.cancel().catch(() => undefined);
    } catch {
      /* noop */
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // split SSE frames
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") {
            // flush tool calls
            if (tcAccum.size > 0) {
              const tcs: ToolCall[] = Array.from(tcAccum.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([i, v]) => ({
                  id: v.id || `call_${i}`,
                  type: "function",
                  function: { name: v.name, arguments: v.args },
                }));
              yield { type: "tool_calls_done", tool_calls: tcs };
            }
            yield { type: "finish", reason: "stop" };
            cleanup();
            return;
          }
          let json: any;
          try {
            json = JSON.parse(payload);
          } catch {
            continue;
          }
          const choice = json?.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          if (typeof delta.content === "string" && delta.content.length > 0) {
            yield { type: "text", delta: delta.content };
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const i: number = tc.index ?? 0;
              const cur = tcAccum.get(i) ?? { id: "", name: "", args: "" };
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.name = tc.function.name;
              if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
              tcAccum.set(i, cur);
              yield {
                type: "tool_call_delta",
                index: i,
                ...(tc.id ? { id: tc.id } : {}),
                ...(tc.function?.name ? { name: tc.function.name } : {}),
                arguments_delta: tc.function?.arguments,
              };
            }
          }
          if (choice.finish_reason) {
            yield { type: "finish", reason: choice.finish_reason };
          }
        }
      }
    }
    // stream ended without [DONE]
    if (tcAccum.size > 0) {
      const tcs: ToolCall[] = Array.from(tcAccum.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([i, v]) => ({
          id: v.id || `call_${i}`,
          type: "function",
          function: { name: v.name, arguments: v.args },
        }));
      yield { type: "tool_calls_done", tool_calls: tcs };
    }
    yield { type: "finish", reason: "end_of_stream" };
  } catch (err) {
    log.error("stream_error", { msg: (err as Error).message });
    yield { type: "error", message: (err as Error).message };
  } finally {
    cleanup();
  }
}

/* ---------- Vision helper: fetch a URL and turn it into an image_url part ---------- */
/**
 * Fetches a remote image and converts to a base64 data URL so the model
 * provider doesn't have to fetch arbitrary URLs. Caps payload size.
 * Uses chunked String.fromCharCode to avoid stack overflow / quadratic
 * string concatenation on large buffers.
 */
export async function fetchImageAsDataUrl(
  url: string,
  maxBytes = 4 * 1024 * 1024,
): Promise<ChatContentPart | null> {
  try {
    const res = await fetchWithRetry(url, { timeoutMs: 10_000, retries: 1 });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) return null;
    const CHUNK = 0x8000; // 32KB chunks keep apply() safe
    let binary = "";
    for (let i = 0; i < buf.byteLength; i += CHUNK) {
      const slice = buf.subarray(i, Math.min(i + CHUNK, buf.byteLength));
      binary += String.fromCharCode.apply(null, Array.from(slice) as number[]);
    }
    const b64 = btoa(binary);
    const ct = pickImageMime(res.headers.get("content-type"), url, buf);
    if (!ct) return null;
    return { type: "image_url", image_url: { url: `data:${ct};base64,${b64}` } };
  } catch {
    return null;
  }
}

/**
 * Pick a valid `image/*` MIME type for the data URL. Some providers
 * (e.g. strict OpenAI-compatible ones) reject `application/octet-stream`
 * or anything that isn't `image/<subtype>`. We try, in order:
 *   1. The response's Content-Type, if it's already `image/*`
 *   2. The URL's file extension (.jpg/.png/.gif/.webp)
 *   3. A magic-byte sniff of the first few bytes
 *   4. `image/jpeg` as a last-resort for Telegram file URLs (photos are
 *      always JPEG on Telegram's side)
 * Returns null if nothing image-like is detected, so the caller can
 * skip embedding this image rather than sending a guaranteed-bad payload.
 */
function pickImageMime(headerCt: string | null, url: string, bytes: Uint8Array): string | null {
  const fromHeader = headerCt?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (fromHeader.startsWith("image/")) return fromHeader;

  const path = url.split("?")[0] ?? url;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";

  if (bytes.byteLength >= 4) {
    // JPEG: FF D8 FF
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    // PNG: 89 50 4E 47
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    // GIF: 47 49 46 38
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
    // WebP: "RIFF"...."WEBP"
    if (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes.byteLength >= 12 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
      return "image/webp";
    }
  }

  if (url.includes("api.telegram.org/")) return "image/jpeg";
  return null;
}
