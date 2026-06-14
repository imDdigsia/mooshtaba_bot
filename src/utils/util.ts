/**
 * Small utilities used across the bot.
 */

/** Telegram HTML escape. Use for any user-controlled content rendered as parse_mode=HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Extract the first http(s) URL from a string, or null. */
export function extractFirstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return null;
  return m[0].replace(/[),.;]+$/, "");
}

/** Extract all unique http(s) URLs. */
export function extractUrls(text: string): string[] {
  const set = new Set<string>();
  const re = /https?:\/\/[^\s<>"']+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    set.add(m[0].replace(/[),.;]+$/, ""));
  }
  return Array.from(set);
}

/** Truncate to Telegram's limit. Tries to break on a space/newline. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  const nl = cut.lastIndexOf("\n");
  const idx = Math.max(sp, nl);
  return (idx > max * 0.6 ? cut.slice(0, idx) : cut).trimEnd() + "…";
}

/** Cheap, deterministic id (good enough for in-memory dedupe). */
export function nanoId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${t}${r}`;
}

/** Random integer in [min, max] inclusive. */
export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Pick a random element, or undefined for empty arrays. */
export function pickRandom<T>(arr: readonly T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

/** Clamp a number to [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Format a duration in ms as a compact string like "3.2s". */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Sleep helper. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Escape a string for use inside a RegExp. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Best-effort retry-after parser for 429 responses. */
export function parseRetryAfter(headerVal: string | null, body: string | null): number {
  if (headerVal) {
    const n = Number(headerVal);
    if (Number.isFinite(n) && n >= 0) return Math.max(0, n);
  }
  if (body) {
    try {
      const j = JSON.parse(body) as { parameters?: { retry_after?: number } };
      const n = j?.parameters?.retry_after;
      if (typeof n === "number" && n >= 0) return n;
    } catch {
      /* ignore */
    }
  }
  return 0;
}

/**
 * Strip a model's chain-of-thought / planning / self-critique prefix (and
 * any trailing commentary) from its output. Some OpenAI-compatible
 * reasoning models on certain providers leak their internal scratchpad
 * into the `content` field — sometimes wrapped in tags (`<think>…</think>`),
 * sometimes in markdown headers, sometimes as plain English paragraphs
 * before the actual reply.
 *
 * Strategy (in order):
 *   1. Strip explicit thinking-tag blocks.
 *   2. Strip everything before a markdown "Answer:" / "پاسخ:" marker.
 *   3. Strip a leading "**Thinking:**"-style header.
 *   4. Split into paragraphs and find the first one that looks like the
 *      real answer (Persian script, or non-reasoning English).
 *   5. Stop at the first trailing reasoning-looking paragraph so we don't
 *      leak a self-critique that follows the answer.
 */
const PERSIAN_RE = /[\u0600-\u06FF]/;

const REASONING_START_RE =
  /^(the user|they'?re|they are|i should|i need to|i must|i will|i'?ll|let me|my mood|my response|my role|looking at|considering|given that|now i|i'?m being|i want to|to respond|in this case|response should|output should|here'?s my|the user'?s|alright[,.]? so|okay[,.]? so|so,?\s|the assistant|i am being|as an? (ai|assistant)|as a character|to craft|to generate|first[,.]? |let'?s craft|let'?s think|brainstorming|thinking out|step[- ]by[- ]step|i think|i need|i notice|note to self|self[- ]?critique|here'?s|okay[,.]? |alright[,.]? |hmm[,.]? |so[,.]? )/i;

const REASONING_INLINE_RE =
  /\b(should respond|should be|mood is|intensity is|personality is|i need to respond|let me craft|i'?ll respond|i need to write|i need to generate|the response should|the output should|is curious|is friendly|with some personality|not robotic|not formal|in persian|natural internet|tone|register|voice|needs? to|has to|must be|aiming for|target audience|word count|length should|register should|voice should)\b/i;

function isLikelyReasoningParagraph(p: string): boolean {
  const trimmed = p.trim();
  if (!trimmed) return true;

  // If the paragraph contains Persian script, treat it as a real reply.
  if (PERSIAN_RE.test(trimmed)) return false;

  const firstLine = trimmed.split("\n")[0] ?? "";
  if (REASONING_START_RE.test(firstLine.trim())) return true;

  // Multiple "style requirement" bullet lines => reasoning scratchpad.
  const bulletCount = (trimmed.match(/^\s*[-•*]\s+/gm) ?? []).length;
  if (bulletCount >= 2) return true;

  // Numbered-step reasoning.
  const stepCount = (trimmed.match(/^\s*\d+[.)]\s+/gm) ?? []).length;
  if (stepCount >= 2) return true;

  // Multiple reasoning-style keywords.
  let hits = 0;
  const inlineRe = new RegExp(REASONING_INLINE_RE.source, "gi");
  while (inlineRe.exec(trimmed) !== null) hits++;
  if (hits >= 2) return true;

  return false;
}

export function stripReasoning(s: string): string {
  if (!s) return s;
  let text = s.replace(/\r\n/g, "\n");

  // 1) Strip explicit thinking-tag blocks.
  const tagPatterns: RegExp[] = [
    /<think>[\s\S]*?<\/think>/gi,
    /<thinking>[\s\S]*?<\/thinking>/gi,
    /<reasoning>[\s\S]*?<\/reasoning>/gi,
    /<scratchpad>[\s\S]*?<\/scratchpad>/gi,
    /<analysis>[\s\S]*?<\/analysis>/gi,
    /<reflection>[\s\S]*?<\/reflection>/gi,
    /<\|im_start\|>think[\s\S]*?<\|im_end\|>/gi,
    /<\|begin▁of▁thinking\|>[\s\S]*?<\|end▁of▁thinking\|>/gi,
    /\[THINKING\][\s\S]*?\[\/THINKING\]/gi,
  ];
  for (const p of tagPatterns) text = text.replace(p, "");

  // 2) Drop everything before a markdown "Answer:" / "پاسخ:" marker.
  const answerMarkerRe =
    /^\s*\**\s*(response|answer|reply|final answer|پاسخ نهایی|پاسخ|جواب|خروجی|پاسخم|answer is)\s*:?\s*\**\s*$/im;
  const m = answerMarkerRe.exec(text);
  if (m && m.index !== undefined && m.index < 400) {
    text = text.slice(m.index + m[0].length).trim();
  }

  // 3) Drop a leading "**Thinking:**" / "**Reasoning:**" header.
  const thinkingHeaderRe =
    /^\s*\**\s*(thinking|reasoning|analysis|thoughts?|my (thoughts|reasoning|analysis)|step[- ]by[- ]step|plan|approach|internal (monologue|reasoning)|brainstorm)\s*:?\**\s*$/im;
  const tm = thinkingHeaderRe.exec(text);
  if (tm && tm.index !== undefined && tm.index < 300) {
    text = text.slice(tm.index + tm[0].length).trim();
  }

  // 4) Fast path: if the first non-blank line is Persian, return as-is.
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  if (PERSIAN_RE.test(firstLine) && !isLikelyReasoningParagraph(firstLine)) {
    return text.trim();
  }

  // 5) Split into paragraphs.
  const paras = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length === 0) return text.trim();

  // 5a) Find the first paragraph that looks like a real answer.
  let answerStart = -1;
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i] ?? "";
    if (PERSIAN_RE.test(p) && p.length >= 3) {
      answerStart = i;
      break;
    }
  }
  if (answerStart === -1) {
    for (let i = 0; i < paras.length; i++) {
      if (!isLikelyReasoningParagraph(paras[i] ?? "")) {
        answerStart = i;
        break;
      }
    }
  }
  if (answerStart === -1) {
    // All paragraphs look like reasoning — return the last one as best effort.
    return (paras[paras.length - 1] ?? text).trim();
  }

  // 5b) From `answerStart` onwards, stop at the first trailing reasoning block.
  const kept: string[] = [];
  for (let i = answerStart; i < paras.length; i++) {
    const p = paras[i] ?? "";
    if (
      i > answerStart &&
      isLikelyReasoningParagraph(p) &&
      !PERSIAN_RE.test(p)
    ) {
      break;
    }
    kept.push(p);
  }
  return kept.join("\n\n").trim();
}
