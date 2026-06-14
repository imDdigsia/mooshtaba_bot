/**
 * Admin commands + public commands (/start, /help, /role).
 * Uses inline keyboards for interactive menus.
 */
import type { Config } from "../config.js";
import type { Env, MoodName, BotSettings } from "../types.js";
import { sendMessage, editMessageText, inlineKeyboard, replyKeyboard, removeKeyboard, type InlineKeyboardButton } from "../telegram/api.js";
import { MOODS, MOOD_ORDER } from "../mood/moods.js";
import type { Analytics } from "../analytics/tracker.js";
import type { MemoryManager } from "../memory/manager.js";
import type { MoodEngine } from "../mood/engine.js";
import { loadSettings, saveWhitelist, saveAdminOnly, saveTimezone } from "../settings.js";

function isAdmin(cfg: Config, userId: number): boolean {
  return cfg.adminIds.includes(userId);
}

export interface AdminDeps {
  cfg: Config;
  env: Env;
  analytics: Analytics;
  memory: MemoryManager;
  mood: MoodEngine;
  settings: BotSettings;
}

export interface CommandArgs {
  chatId: number;
  userId: number;
  command: string;
  rest: string;
  isPrivate: boolean;
}

export async function handleCommand(
  deps: AdminDeps,
  args: CommandArgs,
): Promise<boolean> {
  const { cfg, settings } = deps;

  switch (args.command) {
    case "/start":
      await cmdStart(deps, args);
      return true;
    case "/help":
      await cmdHelp(deps, args);
      return true;
    case "/role":
      await cmdRole(cfg, args);
      return true;

    case "/status":
      if (!isAdmin(cfg, args.userId)) {
        await sendMessage(cfg, args.chatId, "🚫 فقط ادمین‌ها می‌تونن این دستور رو اجرا کنن.");
        return true;
      }
      await cmdStatus(deps, args.chatId);
      return true;
    case "/mood":
      if (!isAdmin(cfg, args.userId)) return false;
      await cmdMood(deps, args.chatId);
      return true;
    case "/setmood":
      if (!isAdmin(cfg, args.userId)) return false;
      await cmdSetMood(deps, args.chatId, args.rest);
      return true;
    case "/memory":
      if (!isAdmin(cfg, args.userId)) return false;
      await cmdMemory(deps, args.chatId);
      return true;
    case "/clear_memory":
      if (!isAdmin(cfg, args.userId)) return false;
      await cmdClearMemory(deps, args.chatId);
      return true;
    case "/reload_prompt":
      if (!isAdmin(cfg, args.userId)) return false;
      await cmdReloadPrompt(deps, args.chatId);
      return true;
    case "/stats":
      if (!isAdmin(cfg, args.userId)) return false;
      await cmdStats(deps, args.chatId);
      return true;
    case "/whitelist":
      if (!isAdmin(cfg, args.userId)) return false;
      await cmdWhitelist(deps, args);
      return true;
    case "/adminonly":
      if (!isAdmin(cfg, args.userId)) return false;
      await cmdAdminOnly(deps, args.chatId);
      return true;
    case "/timezone":
      if (!isAdmin(cfg, args.userId)) return false;
      await cmdTimezone(deps, args);
      return true;
    default:
      return false;
  }
}

const MAIN_MENU: InlineKeyboardButton[][] = [
  [{ text: "🎭 مود فعلی", callback_data: "cmd:mood" },
   { text: "📊 آمار", callback_data: "cmd:stats" }],
  [{ text: "🧠 حافظه", callback_data: "cmd:memory" },
   { text: "⚙️ تنظیمات", callback_data: "cmd:adminonly" }],
  [{ text: "📖 راهنما", callback_data: "cmd:help" }],
];

const MOOD_KEYBOARD: InlineKeyboardButton[][] = [
  [{ text: "🔥 excited", callback_data: "mood:excited" },
   { text: "😴 sleepy", callback_data: "mood:sleepy" }],
  [{ text: "🌪️ chaotic", callback_data: "mood:chaotic" },
   { text: "🔍 curious", callback_data: "mood:curious" }],
  [{ text: "😮 impressed", callback_data: "mood:impressed" },
   { text: "🤔 suspicious", callback_data: "mood:suspicious" }],
  [{ text: "😢 nostalgic", callback_data: "mood:nostalgic" },
   { text: "🎭 dramatic", callback_data: "mood:dramatic" }],
  [{ text: "🇺🇸 trump", callback_data: "mood:trump" }],
  [{ text: "🔄 رفرش", callback_data: "cmd:mood" },
   { text: "🔙 بازگشت", callback_data: "cmd:main" }],
];

const MEMORY_KEYBOARD: InlineKeyboardButton[][] = [
  [{ text: "📋 موضوعات", callback_data: "mem:topics" },
   { text: "😂 جوک‌ها", callback_data: "mem:jokes" }],
  [{ text: "👤 نیک‌نیم‌ها", callback_data: "mem:nicknames" },
   { text: "📝 خلاصه", callback_data: "mem:summary" }],
  [{ text: "🧹 پاکسازی", callback_data: "mem:clear" },
   { text: "🔄 رفرش", callback_data: "cmd:memory" }],
  [{ text: "🔙 بازگشت", callback_data: "cmd:main" }],
];

const STATS_KEYBOARD: InlineKeyboardButton[][] = [
  [{ text: "🎭 تفکیک مود", callback_data: "stats:mood" },
   { text: "📝 تفکیک نوع", callback_data: "stats:kind" }],
  [{ text: "📋 تاپیک‌ها", callback_data: "stats:topics" },
   { text: "🔄 رفرش", callback_data: "cmd:stats" }],
  [{ text: "🔙 بازگشت", callback_data: "cmd:main" }],
];

const WHITELIST_KEYBOARD: InlineKeyboardButton[][] = [
  [{ text: "➕ افزودن", callback_data: "wl:add" },
   { text: "➖ حذف", callback_data: "wl:remove" }],
  [{ text: "🧹 پاکسازی", callback_data: "wl:clear" },
   { text: "🔄 رفرش", callback_data: "cmd:whitelist" }],
  [{ text: "🔙 بازگشت", callback_data: "cmd:main" }],
];

const SETTINGS_KEYBOARD: InlineKeyboardButton[][] = [
  [{ text: "🔒 ادمین‌فقط", callback_data: "set:adminonly" },
   { text: "🕐 ساعت", callback_data: "set:timezone" }],
  [{ text: "📋 وایت‌لیست", callback_data: "cmd:whitelist" },
   { text: "🔄 رفرش", callback_data: "cmd:adminonly" }],
  [{ text: "🔙 بازگشت", callback_data: "cmd:main" }],
];

const REPLY_KB = [
  [{ text: "🎭 مود" }, { text: "📊 آمار" }, { text: "🧠 حافظه" }],
  [{ text: "⚙️ تنظیمات" }, { text: "📋 دستورها" }],
];

const REPLY_KB_MAP: Record<string, string> = {
  "🎭 مود": "/mood",
  "📊 آمار": "/stats",
  "🧠 حافظه": "/memory",
  "⚙️ تنظیمات": "/adminonly",
  "📋 دستورها": "/help",
};

async function cmdStart(deps: AdminDeps, args: CommandArgs): Promise<void> {
  const isAdm = isAdmin(deps.cfg, args.userId);
  const lines = [
    `سلام! 👋 من <b>${escape(deps.cfg.botNickname)}</b> هستم.`,
    isAdm
      ? "تو ادمین هستی — همه دستورها در دسترس شما."
      : "می‌تونم باهات حرف بزنم، شوخی کنم، و یه کم رنگ به گروه بدم!",
  ];
  const opts = isAdm
    ? { parse_mode: "HTML" as const, reply_markup: inlineKeyboard(MAIN_MENU) }
    : { parse_mode: "HTML" as const };
  await sendMessage(deps.cfg, args.chatId, lines.join("\n"), opts);

  if (args.isPrivate && isAdm) {
    await sendMessage(deps.cfg, args.chatId, "─ منوی سریع ─", {
      reply_markup: replyKeyboard(REPLY_KB),
    });
  }
}

async function cmdHelp(deps: AdminDeps, args: CommandArgs, messageId?: number): Promise<void> {
  const isAdm = isAdmin(deps.cfg, args.userId);
  const lines = [
    "📖 <b>راهنمای موشتبی</b>",
    "",
    "<b>دستورهای عمومی:</b>",
    "• /start — شروع / خوشامد",
    "• /help — این راهنما",
    "• /role — بررسی دسترسی",
  ];
  if (isAdm) {
    lines.push("", "<b>دستورهای ادمین:</b>");
    lines.push("• /status — وضعیت بات");
    lines.push("• /mood — مود فعلی");
    lines.push("• /memory — حافظه");
    lines.push("• /stats — آمار");
    lines.push("• /whitelist — وایت‌لیست");
    lines.push("• /adminonly — حالت ادمین‌فقط");
    lines.push("• /timezone — ساعت");
  }
  const kb = isAdm ? inlineKeyboard(MAIN_MENU) : undefined;
  const opts = { parse_mode: "HTML" as const, ...(kb ? { reply_markup: kb } : {}) };
  if (messageId) {
    try { await editMessageText(deps.cfg, args.chatId, messageId, lines.join("\n"), opts); return; } catch { /* fall through to send */ }
  }
  await sendMessage(deps.cfg, args.chatId, lines.join("\n"), opts);
}

async function cmdRole(cfg: Config, args: CommandArgs): Promise<void> {
  const isAdm = isAdmin(cfg, args.userId);
  const role = isAdm ? "🟢 <b>ادمین</b>" : "⚪ عادی";
  const txt = [
    `🔍 سطح دسترسی شما: ${role}`,
    isAdm
      ? `شما (ID: <code>${args.userId}</code>) در لیست ادمین‌ها هستید.`
      : `شما (ID: <code>${args.userId}</code>) ادمین نیستید.`,
  ].join("\n");
  await sendMessage(cfg, args.chatId, txt, { parse_mode: "HTML" });
}

async function cmdStatus(deps: AdminDeps, chatId: number): Promise<void> {
  const m = await deps.mood.getCurrent();
  const a = await deps.analytics.snapshot();
  const since = new Date(a.startedAt).toISOString();
  const txt = [
    "🟢 <b>وضعیت موشتبی</b>",
    `• مدل: <code>${deps.cfg.model}</code>`,
    `• مود: <b>${MOODS[m.mood].labelFa}</b> (${m.intensity * 100}%)`,
    `• دیده: ${a.messagesSeen} | جواب: ${a.messagesAnswered} | خطا: ${a.errors}`,
  ].join("\n");
  await sendMessage(deps.cfg, chatId, txt, {
    parse_mode: "HTML",
    reply_markup: inlineKeyboard(STATS_KEYBOARD),
  });
}

async function cmdMood(deps: AdminDeps, chatId: number, messageId?: number): Promise<void> {
  const m = await deps.mood.getCurrent();
  const txt = [
    `🎭 <b>مود فعلی:</b> ${MOODS[m.mood].labelFa} (${m.mood})`,
    `شدت: ${(m.intensity * 100).toFixed(0)}%`,
    `دلیل: <i>${escape(m.reason)}</i>`,
    "",
    "یکی رو انتخاب کن:",
  ].join("\n");
  const opts = { parse_mode: "HTML" as const, reply_markup: inlineKeyboard(MOOD_KEYBOARD) };
  if (messageId) {
    try { await editMessageText(deps.cfg, chatId, messageId, txt, opts); return; } catch { /* fall through to send */ }
  }
  await sendMessage(deps.cfg, chatId, txt, opts);
}

async function cmdSetMood(deps: AdminDeps, chatId: number, rest: string): Promise<void> {
  const m = rest.trim().toLowerCase() as MoodName;
  if (!MOODS[m]) {
    await sendMessage(deps.cfg, chatId, `مود ناشناخته. یکی از اینا رو بفرست:\n${MOOD_ORDER.join(", ")}`);
    return;
  }
  await deps.mood.setMood(m, "admin /setmood", 0.85);
  await sendMessage(deps.cfg, chatId, `✅ مود تنظیم شد: <b>${MOODS[m].labelFa}</b>`, { parse_mode: "HTML" });
}

async function cmdMemory(deps: AdminDeps, chatId: number, messageId?: number): Promise<void> {
  const snap = await deps.memory.getSnapshot();
  const recent = snap.recent.slice(-5).map((e) => `• ${escape(e.displayName)}: ${escape(e.summary)}`).join("\n") || "—";
  const txt = [
    "🧠 <b>حافظه موشتبی</b>",
    `<b>اخیر (${snap.recent.length}):</b>\n${recent}`,
  ].join("\n");
  const opts = { parse_mode: "HTML" as const, reply_markup: inlineKeyboard(MEMORY_KEYBOARD) };
  if (messageId) {
    try { await editMessageText(deps.cfg, chatId, messageId, txt, opts); return; } catch { /* fall through to send */ }
  }
  await sendMessage(deps.cfg, chatId, txt, opts);
}

async function cmdClearMemory(deps: AdminDeps, chatId: number): Promise<void> {
  await deps.memory.clearAll();
  await sendMessage(deps.cfg, chatId, "🧹 حافظه پاک شد.", {
    reply_markup: inlineKeyboard(MEMORY_KEYBOARD),
  });
}

async function cmdReloadPrompt(deps: AdminDeps, chatId: number): Promise<void> {
  await deps.mood.tick({ ts: Date.now(), count: await deps.mood.recentCount() });
  await sendMessage(deps.cfg, chatId, "♻️ پرامپت و مود ری‌فرش شدن.");
}

async function cmdStats(deps: AdminDeps, chatId: number, messageId?: number): Promise<void> {
  const a = await deps.analytics.snapshot();
  const txt = [
    "📊 <b>آمار موشتبی</b>",
    `• دیده‌شده: <b>${a.messagesSeen}</b>`,
    `• جواب داده: <b>${a.messagesAnswered}</b>`,
    `• فقط ری‌اکشن: <b>${a.reactionsOnly}</b>`,
    `• بی‌خیال: <b>${a.ignored}</b>`,
    `• خطا: <b>${a.errors}</b>`,
  ].join("\n");
  const opts = { parse_mode: "HTML" as const, reply_markup: inlineKeyboard(STATS_KEYBOARD) };
  if (messageId) {
    try { await editMessageText(deps.cfg, chatId, messageId, txt, opts); return; } catch { /* fall through to send */ }
  }
  await sendMessage(deps.cfg, chatId, txt, opts);
}

async function cmdWhitelist(deps: AdminDeps, args: CommandArgs, messageId?: number): Promise<void> {
  const parts = args.rest.trim().split(/\s+/);
  const sub = (parts[0] ?? "").toLowerCase();
  const idStr = parts[1] ?? "";

  if (sub === "add" && idStr) {
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      await sendMessage(deps.cfg, args.chatId, "❌ آیدی نامعتبر.");
      return;
    }
    if (!deps.settings.allowedChatIds.includes(id)) {
      deps.settings.allowedChatIds.push(id);
      await saveWhitelist(deps.env.DB, deps.settings.allowedChatIds);
    }
    const txt = `✅ <code>${id}</code> به وایت‌لیست اضافه شد.`;
    await sendMessage(deps.cfg, args.chatId, txt, { parse_mode: "HTML", reply_markup: inlineKeyboard(WHITELIST_KEYBOARD) });
    return;
  }

  if (sub === "remove" && idStr) {
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      await sendMessage(deps.cfg, args.chatId, "❌ آیدی نامعتبر.");
      return;
    }
    deps.settings.allowedChatIds = deps.settings.allowedChatIds.filter((x) => x !== id);
    await saveWhitelist(deps.env.DB, deps.settings.allowedChatIds);
    const txt = `✅ <code>${id}</code> از وایت‌لیست حذف شد.`;
    await sendMessage(deps.cfg, args.chatId, txt, { parse_mode: "HTML", reply_markup: inlineKeyboard(WHITELIST_KEYBOARD) });
    return;
  }

  const ids = deps.settings.allowedChatIds;
  const txt = ids.length
    ? `📋 <b>وایت‌لیست:</b>\n${ids.map((id) => `• <code>${id}</code>`).join("\n")}`
    : "📋 وایت‌لیست خالی — بات در همه چت‌ها فعال.";
  const opts = { parse_mode: "HTML" as const, reply_markup: inlineKeyboard(WHITELIST_KEYBOARD) };
  if (messageId) {
    try { await editMessageText(deps.cfg, args.chatId, messageId, txt, opts); return; } catch { /* fall through to send */ }
  }
  await sendMessage(deps.cfg, args.chatId, txt, opts);
}

async function cmdAdminOnly(deps: AdminDeps, chatId: number, messageId?: number): Promise<void> {
  const stTxt = deps.settings.adminOnly
    ? "🔒 حالت ادمین‌فقط <b>فعال</b>"
    : "🔓 حالت ادمین‌فقط <b>غیرفعال</b>";
  const opts = { parse_mode: "HTML" as const, reply_markup: inlineKeyboard(SETTINGS_KEYBOARD) };
  if (messageId) {
    try { await editMessageText(deps.cfg, chatId, messageId, stTxt, opts); return; } catch { /* fall through to send */ }
  }
  await sendMessage(deps.cfg, chatId, stTxt, opts);
}

async function cmdTimezone(deps: AdminDeps, args: CommandArgs): Promise<void> {
  const { getHourInTz, nowInTz } = await import("../config.js");
  const hour = getHourInTz(deps.settings.timezone);
  const now = nowInTz(deps.settings.timezone);
  const txt = [
    `🕐 <b>ساعت بات:</b> ${deps.settings.timezone}`,
    `ساعت فعلی: <code>${hour}:xx</code> (${now.toLocaleString("fa-IR")})`,
  ].join("\n");
  await sendMessage(deps.cfg, args.chatId, txt, {
    parse_mode: "HTML",
    reply_markup: inlineKeyboard(SETTINGS_KEYBOARD),
  });
}

export {
  cmdMood, cmdStats, cmdMemory, cmdHelp, cmdWhitelist, cmdAdminOnly,
  cmdClearMemory, cmdSetMood, cmdStatus,
  MOOD_KEYBOARD, MEMORY_KEYBOARD, STATS_KEYBOARD, WHITELIST_KEYBOARD, SETTINGS_KEYBOARD, MAIN_MENU, REPLY_KB, REPLY_KB_MAP,
};

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
