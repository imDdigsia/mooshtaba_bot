/**
 * Tool-calling executor. Wraps `createChatCompletion` in a loop that:
 *   1. Sends the current messages + tools.
 *   2. If the model returns `tool_calls`, runs them, appends results.
 *   3. Repeats up to MAX_ROUNDS, then forces a final text answer.
 *
 * Returns the final assistant text (may be empty) and a list of tool
 * summaries for logging / prompt building.
 */
import type { Config } from "../config.js";
import type { ChatMessage, ToolDef, ToolCall } from "../types.js";
import { createChatCompletion, createChatCompletionStream, StreamEvent } from "./client.js";
import { executeToolCall, ToolExecDeps } from "./tools.js";
import { createLogger } from "../utils/logger.js";

export interface ExecutorOptions {
  cfg: Config;
  messages: ChatMessage[];
  tools: ToolDef[];
  toolDeps: ToolExecDeps;
  maxRounds?: number;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ExecutorResult {
  finalText: string;
  toolSummaries: { name: string; summary: string; ok: boolean }[];
  rounds: number;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export async function runWithTools(opts: ExecutorOptions): Promise<ExecutorResult> {
  const { cfg, toolDeps } = opts;
  const log = createLogger(cfg, "exec");
  const maxRounds = opts.maxRounds ?? 4;
  const tools = opts.tools;
  const messages: ChatMessage[] = [...opts.messages];
  const toolSummaries: ExecutorResult["toolSummaries"] = [];
  let totalUsage: ExecutorResult["usage"];
  let rounds = 0;
  let finalText = "";

  for (let round = 0; round < maxRounds; round++) {
    rounds = round + 1;
    const completion = await createChatCompletion(cfg, messages, {
      ...(tools.length ? { tools } : { tool_choice: "none" }),
      temperature: opts.temperature ?? 0.95,
      max_tokens: opts.maxTokens ?? 600,
      signal: opts.signal,
    });
    if (completion.usage) {
      totalUsage = {
        prompt_tokens: (totalUsage?.prompt_tokens ?? 0) + completion.usage.prompt_tokens,
        completion_tokens: (totalUsage?.completion_tokens ?? 0) + completion.usage.completion_tokens,
        total_tokens: (totalUsage?.total_tokens ?? 0) + completion.usage.total_tokens,
      };
    }
    const choice = completion.choices?.[0];
    if (!choice) break;
    const msg = choice.message;
    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
    });

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      // Execute each tool call in parallel
      const results = await Promise.all(
        msg.tool_calls.map(async (tc: ToolCall) => {
          const r = await executeToolCall(toolDeps, tc.function.name, tc.function.arguments);
          toolSummaries.push({ name: tc.function.name, summary: r.summary, ok: r.ok });
          return { tc, r };
        }),
      );
      for (const { tc, r } of results) {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content: r.ok ? r.summary : `ERROR: ${r.summary}`,
        });
      }
      // Loop again so the model can use the tool results.
      continue;
    }

    // No tool calls -> we have the final text
    finalText = (msg.content ?? "").trim();
    break;
  }

  // Safety: if we exhausted rounds with no text, force one more turn without tools.
  if (!finalText) {
    log.warn("no_final_text_forcing_fallback", { rounds });
    const fallback = await createChatCompletion(cfg, messages, {
      tool_choice: "none",
      temperature: 0.8,
      max_tokens: 400,
    });
    if (fallback.usage) {
      totalUsage = {
        prompt_tokens: (totalUsage?.prompt_tokens ?? 0) + fallback.usage.prompt_tokens,
        completion_tokens: (totalUsage?.completion_tokens ?? 0) + fallback.usage.completion_tokens,
        total_tokens: (totalUsage?.total_tokens ?? 0) + fallback.usage.total_tokens,
      };
    }
    finalText = (fallback.choices?.[0]?.message?.content ?? "").trim();
  }

  return { finalText, toolSummaries, rounds, usage: totalUsage };
}

/* ---------- Streaming variant (for low-latency, single-shot text) ---------- */
export interface StreamRunResult {
  text: string;
  toolCalls: ToolCall[];
  finish: string | null;
}

export async function* streamText(
  cfg: Config,
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): AsyncGenerator<{ delta: string } | StreamRunResult, void, void> {
  let buf = "";
  for await (const ev of createChatCompletionStream(cfg, messages, {
    temperature: opts.temperature ?? 0.95,
    max_tokens: opts.maxTokens ?? 500,
    signal: opts.signal,
  })) {
    if (ev.type === "text") {
      buf += ev.delta;
      yield { delta: ev.delta };
    } else if (ev.type === "finish") {
      yield { text: buf, toolCalls: [], finish: ev.reason } as unknown as StreamRunResult;
      return;
    } else if (ev.type === "error") {
      throw new Error(ev.message);
    }
  }
  yield { text: buf, toolCalls: [], finish: "end_of_stream" } as unknown as StreamRunResult;
}
