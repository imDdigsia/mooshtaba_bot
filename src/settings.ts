/**
 * Dynamic bot settings stored in D1 (SQLite).
 * These override env-var defaults and can be changed from within the bot
 * via admin commands (whitelist, adminonly, timezone).
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { BotSettings } from "./types.js";
import { getSetting, putSetting } from "./db/d1.js";

const KEY_WHITELIST = "settings:whitelist";
const KEY_ADMINONLY = "settings:adminonly";
const KEY_TIMEZONE = "settings:timezone";

export async function loadSettings(db: D1Database, defaults: BotSettings): Promise<BotSettings> {
  const whitelist = await getSetting<number[]>(db, KEY_WHITELIST, defaults.allowedChatIds);
  const adminOnly = await getSetting<boolean>(db, KEY_ADMINONLY, defaults.adminOnly);
  const timezone = await getSetting<string>(db, KEY_TIMEZONE, defaults.timezone);
  return {
    allowedChatIds: whitelist,
    adminOnly,
    timezone,
  };
}

export async function saveWhitelist(db: D1Database, ids: number[]): Promise<void> {
  await putSetting(db, KEY_WHITELIST, ids);
}

export async function saveAdminOnly(db: D1Database, value: boolean): Promise<void> {
  await putSetting(db, KEY_ADMINONLY, value);
}

export async function saveTimezone(db: D1Database, tz: string): Promise<void> {
  await putSetting(db, KEY_TIMEZONE, tz);
}
