/**
 * Centralized configuration. Reads from Env (Cloudflare bindings + vars + secrets)
 * and exposes a typed `Config` object used throughout the bot.
 *
 * Keep this file dependency-free so it can be imported anywhere.
 */
import type { Env } from "./types.js";

export interface Config {
  telegramToken: string;
  telegramApiBase: string;
  tokenRouterBase: string;
  tokenRouterKey: string;
  model: string;
  adminIds: number[];
  adminOnly: boolean;
  allowedChatIds: number[];
  mirrorChatId: number | null;
  webhookSecret: string | null;
  setupSecret: string | null;
  logLevel: "trace" | "debug" | "info" | "warn" | "error";
  botNickname: string;
  botLangPrimary: string;
  timezone: string;
}

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

function parseLogLevel(v: string | undefined): LogLevel {
  const x = (v ?? "info").toLowerCase() as LogLevel;
  return (LOG_LEVELS as readonly string[]).includes(x) ? x : "info";
}

function parseIds(v: string | undefined): number[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n !== 0);
}

function parseBool(v: string | undefined, defaultVal = false): boolean {
  if (v === undefined) return defaultVal;
  return /^(true|1|yes|on)$/i.test(v.trim());
}

export function loadConfig(env: Env): Config {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required (set via `wrangler secret put`).");
  }
  if (!env.TOKENROUTER_API_KEY) {
    throw new Error("TOKENROUTER_API_KEY is required (set via `wrangler secret put`).");
  }
  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    telegramApiBase: (env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, ""),
    tokenRouterBase: (env.TOKENROUTER_BASE || "https://api.prox.us.ci/v1").replace(/\/+$/, ""),
    tokenRouterKey: env.TOKENROUTER_API_KEY,
    model: env.MODEL || "gpt-5.4",
    adminIds: parseIds(env.ADMIN_IDS),
    adminOnly: parseBool(env.ADMIN_ONLY, false),
    allowedChatIds: parseIds(env.ALLOWED_CHAT_IDS),
    mirrorChatId: env.MIRROR_CHAT_ID ? Number(env.MIRROR_CHAT_ID) : null,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || null,
    setupSecret: env.SETUP_SECRET || null,
    logLevel: parseLogLevel(env.LOG_LEVEL),
    botNickname: env.BOT_NICKNAME || "موشتبی",
    botLangPrimary: env.BOT_LANG_PRIMARY || "fa",
    timezone: env.TIMEZONE || "Asia/Tehran",
  };
}

export function getHourInTz(tz: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date());
    const hourPart = parts.find((p) => p.type === "hour");
    return parseInt(hourPart?.value ?? "0", 10);
  } catch {
    const offset = tz === "Asia/Tehran" ? 3.5 : 0;
    return Math.floor(new Date().getUTCHours() + offset) % 24;
  }
}

export function nowInTz(tz: string): Date {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date());
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
    return new Date(
      parseInt(get("year"), 10),
      parseInt(get("month"), 10) - 1,
      parseInt(get("day"), 10),
      parseInt(get("hour"), 10),
      parseInt(get("minute"), 10),
      parseInt(get("second"), 10),
    );
  } catch {
    return new Date();
  }
}

/** Build the public file URL Telegram exposes for a given file_path. */
export function telegramFileUrl(token: string, filePath: string): string {
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}
