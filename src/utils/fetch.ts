/**
 * Fetch helpers with timeout, retry, and exponential backoff.
 * Workers' native `fetch` has no built-in timeout/abort, so we wrap it
 * with AbortController. Retries cover transient 5xx and 429 responses.
 */

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  retryBaseMs?: number;
  retryOn?: number[]; // HTTP statuses to retry on
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
    public readonly url: string,
  ) {
    super(`HTTP ${status} ${statusText} (${url})`);
    this.name = "HttpError";
  }
}

const DEFAULTS = {
  timeoutMs: 20_000,
  retries: 3,
  retryBaseMs: 400,
  retryOn: [408, 425, 429, 500, 502, 503, 504],
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffDelay(attempt: number, base: number): number {
  // exponential with jitter, capped at 8s
  const exp = Math.min(8000, base * 2 ** attempt);
  const jitter = Math.random() * (exp * 0.25);
  return Math.floor(exp + jitter);
}

export async function fetchWithRetry(input: string | URL, opts: FetchOptions = {}): Promise<Response> {
  const {
    timeoutMs = DEFAULTS.timeoutMs,
    retries = DEFAULTS.retries,
    retryBaseMs = DEFAULTS.retryBaseMs,
    retryOn = DEFAULTS.retryOn,
    ...init
  } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(input, { ...init, signal: controller.signal });
      clearTimeout(t);

      if (res.ok) return res;

      // Retry on configured statuses
      if (retryOn.includes(res.status) && attempt < retries) {
        let wait = backoffDelay(attempt, retryBaseMs);
        if (res.status === 429) {
          const ra = Number(res.headers.get("retry-after"));
          if (Number.isFinite(ra) && ra > 0) wait = Math.max(wait, ra * 1000);
        }
        // Drain body to free the connection
        try {
          await res.text();
        } catch {
          /* ignore */
        }
        await sleep(wait);
        lastErr = new HttpError(res.status, res.statusText, "", String(input));
        continue;
      }

      // Non-retryable error response
      const body = await res.text().catch(() => "");
      throw new HttpError(res.status, res.statusText, body, String(input));
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      // Retry on abort/timeout/network errors
      const isAbort = err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
      const isNetwork = err instanceof TypeError; // fetch network errors
      if ((isAbort || isNetwork) && attempt < retries) {
        await sleep(backoffDelay(attempt, retryBaseMs));
        continue;
      }
      throw err;
    }
  }
  // Should not reach, but just in case:
  throw lastErr instanceof Error ? lastErr : new Error("fetchWithRetry: exhausted");
}
