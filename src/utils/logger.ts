/**
 * Minimal structured logger. Uses the global `console` (Workers pipes this to
 * `wrangler tail` / Workers Logs). We never log secrets or message bodies in
 * full; we only log metadata (lengths, ids, kinds).
 */
import type { Config } from "../config.js";

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 } as const;
type Level = keyof typeof LEVELS;

function shouldLog(cfg: Config, lvl: Level): boolean {
  return LEVELS[lvl] >= LEVELS[cfg.logLevel];
}

function fmt(level: Level, scope: string, msg: string, extra?: Record<string, unknown>): string {
  const base = {
    t: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(extra ?? {}),
  };
  try {
    return JSON.stringify(base);
  } catch {
    return `[${level}] ${scope}: ${msg}`;
  }
}

export function createLogger(cfg: Config, scope: string) {
  return {
    trace(msg: string, extra?: Record<string, unknown>) {
      if (shouldLog(cfg, "trace")) console.log(fmt("trace", scope, msg, extra));
    },
    debug(msg: string, extra?: Record<string, unknown>) {
      if (shouldLog(cfg, "debug")) console.log(fmt("debug", scope, msg, extra));
    },
    info(msg: string, extra?: Record<string, unknown>) {
      if (shouldLog(cfg, "info")) console.log(fmt("info", scope, msg, extra));
    },
    warn(msg: string, extra?: Record<string, unknown>) {
      if (shouldLog(cfg, "warn")) console.warn(fmt("warn", scope, msg, extra));
    },
    error(msg: string, extra?: Record<string, unknown>) {
      if (shouldLog(cfg, "error")) console.error(fmt("error", scope, msg, extra));
    },
  };
}
