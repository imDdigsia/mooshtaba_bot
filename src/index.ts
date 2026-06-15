/**
 * موشتبی — Cloudflare Worker entrypoint.
 *
 * Routes:
 *   GET  /             -> health
 *   GET  /health       -> health
 *   POST /webhook      -> Telegram webhook (validates secret token, returns 200,
 *                          processes update via ctx.waitUntil)
 *   POST /setup        -> registers the webhook URL with Telegram
 *                          (requires header `X-Setup-Secret: <SETUP_SECRET>`)
 *   GET  /webhook-info -> returns Telegram's getWebhookInfo() (admin)
 *
 * The /webhook handler is intentionally minimal: it verifies the secret
 * token header, then offloads all processing to `handleUpdate()` inside
 * `ctx.waitUntil()` so we return 200 to Telegram immediately and stay
 * well under its retry window.
 */
import { loadConfig } from "./config.js";
import { createLogger } from "./utils/logger.js";
import type { Config } from "./config.js";
import type { Env, TgUpdate, TgMessage, BotSettings } from "./types.js";
import {
  sendMessage,
  editMessageText,
  deleteMessage,
  setMessageReaction,
  setWebhook,
  getWebhookInfo,
  getMe,
  TgApiError,
  sendChatAction,
  setMyCommands,
  answerCallbackQuery,
  inlineKeyboard,
  BotCommand,
} from "./telegram/api.js";
import { normalizeMessage, detectBotAddress } from "./telegram/formatter.js";
import { MoodEngine } from "./mood/engine.js";
import { MemoryManager, buildEventFromNormalized } from "./memory/manager.js";
import { Analytics } from "./analytics/tracker.js";
import { decideEngagement } from "./engagement/decision.js";
import { buildSystemPrompt } from "./ai/prompts.js";
import { runWithTools } from "./ai/executor.js";
import { TOOL_DEFS } from "./ai/tools.js";
import { prepareImageParts } from "./tools/image.js";
import { fetchLinkMetadata } from "./tools/link.js";
import { searchMusic } from "./tools/music.js";
import {
  handleCommand,
  cmdMood, cmdStats, cmdMemory, cmdHelp, cmdWhitelist, cmdAdminOnly, cmdClearMemory,
  MOOD_KEYBOARD, MEMORY_KEYBOARD, STATS_KEYBOARD, WHITELIST_KEYBOARD, SETTINGS_KEYBOARD, MAIN_MENU, REPLY_KB_MAP,
  type AdminDeps, type CommandArgs,
} from "./commands/admin.js";
import { MoodName } from "./types.js";
import { truncate, sleep, randInt, stripReasoning } from "./utils/util.js";
import { loadSettings, saveAdminOnly, saveWhitelist, saveTimezone } from "./settings.js";

const BOT_COMMANDS: BotCommand[] = [
  { command: "start", description: "شروع و خوشامدگویی" },
  { command: "help", description: "راهنمای دستورها" },
  { command: "role", description: "بررسی سطح دسترسی (ادمین/عادی)" },
  { command: "status", description: "وضعیت بات (ادمین)" },
  { command: "mood", description: "مود فعلی (ادمین)" },
  { command: "setmood", description: "تنظیم مود (ادمین)" },
  { command: "memory", description: "حافظه (ادمین)" },
  { command: "clear_memory", description: "پاکسازی حافظه (ادمین)" },
  { command: "stats", description: "آمار (ادمین)" },
  { command: "whitelist", description: "مدیریت وایت‌لیست (ادمین)" },
  { command: "adminonly", description: "حالت ادمین‌فقط (ادمین)" },
  { command: "timezone", description: "تنظیم ساعت (ادمین)" },
];

/* ============================================================
 * Worker entrypoint
 * ============================================================ */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cfg = loadConfig(env);
    const log = createLogger(cfg, "worker");
    const url = new URL(req.url);

    try {
      // --- Health & info ---
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return jsonResponse({ ok: true, bot: cfg.botNickname, model: cfg.model, ts: Date.now() });
      }

      // --- Webhook setup helper ---
      if (req.method === "POST" && url.pathname === "/setup") {
        return await handleSetup(req, env, cfg, log);
      }

      if (req.method === "GET" && url.pathname === "/webhook-info") {
        return await handleWebhookInfo(req, env, cfg, log);
      }

      // --- Telegram webhook ---
      if (req.method === "POST" && url.pathname === "/webhook") {
        return await handleWebhook(req, env, cfg, log, ctx);
      }

      return new Response("not found", { status: 404 });
    } catch (err) {
      log.error("top_level_error", { msg: (err as Error).message, stack: (err as Error).stack });
      return jsonResponse({ ok: false, error: (err as Error).message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/* ============================================================
 * /setup
 * ============================================================ */
async function handleSetup(
  req: Request,
  env: Env,
  cfg: Config,
  log: ReturnType<typeof createLogger>,
): Promise<Response> {
  if (!cfg.setupSecret) {
    return jsonResponse({ ok: false, error: "SETUP_SECRET not configured" }, 400);
  }
  const provided = req.headers.get("x-setup-secret") || urlSearchParam(req, "secret");
  if (provided !== cfg.setupSecret) {
    return jsonResponse({ ok: false, error: "bad setup secret" }, 403);
  }
  const u = new URL(req.url);
  const webhookUrl = `${u.protocol}//${u.host}/webhook`;
  const ok = await setWebhook(cfg, webhookUrl, cfg.webhookSecret);
  log.info("webhook_set", { url: webhookUrl, ok });
  try {
    const cmdOk = await setMyCommands(cfg, BOT_COMMANDS);
    log.info("commands_set", { ok: cmdOk });
  } catch (err) {
    log.warn("commands_set_failed", { err: (err as Error).message });
  }
  return jsonResponse({ ok, url: webhookUrl, commandsRegistered: true });
}

async function handleWebhookInfo(
  req: Request,
  env: Env,
  cfg: Config,
  log: ReturnType<typeof createLogger>,
): Promise<Response> {
  if (cfg.adminIds.length === 0) return jsonResponse({ ok: false, error: "no admins configured" }, 400);
  const token = req.headers.get("x-admin-token") || urlSearchParam(req, "token");
  if (token !== cfg.setupSecret) {
    return jsonResponse({ ok: false, error: "admin token required" }, 403);
  }
  const info = await getWebhookInfo(cfg);
  log.info("webhook_info", info as Record<string, unknown>);
  return jsonResponse({ ok: true, info });
}

function urlSearchParam(req: Request, key: string): string | null {
  try {
    return new URL(req.url).searchParams.get(key);
  } catch {
    return null;
  }
}

/* ============================================================
 * /webhook
 * ============================================================ */
async function handleWebhook(
  req: Request,
  env: Env,
  cfg: Config,
  log: ReturnType<typeof createLogger>,
  ctx: ExecutionContext,
): Promise<Response> {
  if (cfg.webhookSecret) {
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (got !== cfg.webhookSecret) {
      log.warn("webhook_bad_secret", { got: got ? "***" : null });
      return new Response("unauthorized", { status: 401 });
    }
  }

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (!update || typeof update.update_id !== "number") {
    return new Response("bad update", { status: 400 });
  }

  ctx.waitUntil(
    (async () => {
      try {
        await handleUpdate(env, cfg, update, log);
      } catch (err) {
        log.error("handle_update_failed", {
          update_id: update.update_id,
          err: (err as Error).message,
        });
        try {
          const fallbackChatId =
            update.message?.chat.id ??
            update.channel_post?.chat.id ??
            update.edited_message?.chat.id ??
            update.edited_channel_post?.chat.id ??
            0;
          const analytics = new Analytics(env.DB, fallbackChatId, cfg);
          await analytics.incError();
        } catch {
          /* ignore */
        }
      }
    })(),
  );

  return new Response("ok", { status: 200 });
}

/* ============================================================
 * Bot info cache (per-isolate)
 * ============================================================ */
let botInfoPromise: Promise<{ id: number; username: string; first_name: string }> | null = null;
async function botInfo(cfg: Config): Promise<{ id: number; username: string; first_name: string }> {
  if (!botInfoPromise) {
    botInfoPromise = getMe(cfg).catch((err) => {
      botInfoPromise = null;
      throw err;
    });
  }
  return botInfoPromise;
}

/* ============================================================
 * Update handling
 * ============================================================ */
async function handleUpdate(
  env: Env,
  cfg: Config,
  update: TgUpdate,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const settings = await loadSettings(env.DB, {
    timezone: cfg.timezone,
    allowedChatIds: cfg.allowedChatIds,
    adminOnly: cfg.adminOnly,
  });

  if (update.callback_query) {
    await handleCallbackQuery(env, cfg, update.callback_query, log);
    return;
  }

  const msg: TgMessage | undefined = update.message ?? update.channel_post;
  if (!msg) return;
  const chat = msg.chat;
  const isPrivate = chat.type === "private";

  if (msg.from?.is_bot) return;
  if (msg.date && Math.abs(Date.now() / 1000 - msg.date) > 60 * 60) {
    log.debug("skipping_old_message", { age_s: Date.now() / 1000 - msg.date });
    return;
  }

  if (settings.adminOnly) {
    const senderId = msg.from?.id;
    const isFromAdmin = senderId !== undefined && cfg.adminIds.includes(senderId);
    const isChannelPost = msg.from === undefined;
    const isWhitelistedChat = settings.allowedChatIds.length > 0 && settings.allowedChatIds.includes(chat.id);
    if (!isFromAdmin && !isChannelPost && !isWhitelistedChat) {
      log.debug("admin_only_ignored", {
        chat: chat.id,
        senderId,
        admins: cfg.adminIds,
      });
      return;
    }
  }

  const norm = normalizeMessage(msg);
  const analytics = new Analytics(env.DB, chat.id, cfg);
  const mood = new MoodEngine(env.DB, cfg, chat.id, settings.timezone);
  const memory = new MemoryManager(env.DB, cfg, chat.id);

  const text = norm.text;
  const replyToBot = msg.reply_to_message?.from?.id && msg.reply_to_message.from.id === (await botInfo(cfg).catch(() => null))?.id;
  const replyText = msg.reply_to_message?.text ?? "";
  const isWhitelistReply = replyToBot && (replyText.includes("وایت‌لیست") || replyText.includes("افزودن") || replyText.includes("حذف"));
  if (isWhitelistReply && text && /^\d+$/.test(text.trim())) {
    const id = parseInt(text.trim(), 10);
    const wlIndex = settings.allowedChatIds.indexOf(id);
    if (wlIndex >= 0) {
      settings.allowedChatIds.splice(wlIndex, 1);
      await saveWhitelist(env.DB, settings.allowedChatIds);
      await sendMessage(cfg, chat.id, `✅ <code>${id}</code> از وایت‌لیست حذف شد.`, { parse_mode: "HTML", reply_markup: inlineKeyboard(WHITELIST_KEYBOARD) });
    } else {
      settings.allowedChatIds.push(id);
      await saveWhitelist(env.DB, settings.allowedChatIds);
      await sendMessage(cfg, chat.id, `✅ <code>${id}</code> به وایت‌لیست اضافه شد.`, { parse_mode: "HTML", reply_markup: inlineKeyboard(WHITELIST_KEYBOARD) });
    }
    return;
  }

  let dbHealthy = true;
  try {
    await analytics.initIfNeeded();
    await memory.addEvent(
      buildEventFromNormalized({
        chatId: chat.id,
        userId: msg.from?.id,
        username: msg.from?.username,
        displayName: norm.event.displayName,
        kind: norm.event.kind,
        summary: norm.event.summary,
        rawText: norm.text,
        topics: norm.event.topics,
      }),
    );
    await analytics.incSeen(norm.event.kind, (await mood.getCurrent()).mood);
    await analytics.recordTopics(norm.event.topics);
    await mood.recordActivity();
  } catch (err) {
    dbHealthy = false;
    log.warn("persistence_layer_failed_continuing", {
      chat: chat.id,
      err: (err as Error).message,
    });
  }
  if (!dbHealthy) {
    try { await analytics.flush(); } catch { /* swallow */ }
  }

  const mappedCommand = text ? REPLY_KB_MAP[text.trim()] : undefined;
  const effectiveText = mappedCommand ?? text;
  if (effectiveText && effectiveText.startsWith("/")) {
    const firstToken = (effectiveText.split(/\s+/, 2)[0] ?? "").split("@")[0] ?? "";
    const command = firstToken.toLowerCase();
    const rest = effectiveText.slice(effectiveText.split(/\s+/, 2)[0]?.length ?? command.length).trim();
    const me = await botInfo(cfg).catch(() => null);
    const isCommandForBot = !!me?.username &&
      effectiveText.toLowerCase().startsWith(`/${command}@${me.username.toLowerCase()}`);
    const detection = detectBotAddress(
      msg,
      me ? { id: me.id, username: me.username } : null,
      cfg.botNickname,
    );
    const addressedToBot = isPrivate || isCommandForBot || detection.addressed;

    if (addressedToBot) {
      const isChannelPost = msg.from === undefined && chat.type === "channel";
      const effectiveUserId = isChannelPost ? (cfg.adminIds[0] ?? -1) : (msg.from?.id ?? -1);
      const handled = await handleCommand(
        { cfg, env, analytics, memory, mood, settings },
        { chatId: chat.id, userId: effectiveUserId, command, rest, isPrivate },
      ).catch((e) => {
        log.error("command_failed", { err: e.message });
        return false;
      });
      if (handled) return;
    }
  }

  const curMood = await mood.tick({ ts: Date.now(), count: await mood.recentCount() });
  const recent = await mood.recentCount();
  const me = await botInfo(cfg).catch(() => null);
  const detection = detectBotAddress(
    msg,
    me ? { id: me.id, username: me.username } : null,
    cfg.botNickname,
  );
  if (detection.addressed) {
    log.info("bot_addressed", {
      chat: chat.id,
      chatType: chat.type,
      source: detection.source,
      mentioned: detection.mentioned,
      replyToBot: detection.replyToBot,
    });
  }

  const decision = decideEngagement(cfg, {
    mood: curMood.mood,
    intensity: curMood.intensity,
    recentActivity: recent,
    chatType: chat.type,
    isAddressed: detection.addressed,
    hasMedia: norm.hasMedia,
    isForward: norm.isForward,
    messageLength: text?.length ?? 0,
    chatId: chat.id,
    allowedChatIds: settings.allowedChatIds,
  });

  log.info("engagement_decision", {
    chat: chat.id,
    kind: norm.event.kind,
    decision: decision.kind,
    reason: "reason" in decision ? decision.reason : "",
    mood: curMood.mood,
  });

  if (decision.kind === "ignore") {
    await analytics.incIgnored();
    return;
  }
  if (decision.kind === "react") {
    try {
      await setMessageReaction(cfg, chat.id, msg.message_id, decision.emojis);
      await analytics.incReacted();
    } catch (err) {
      log.warn("react_failed", { err: (err as Error).message });
    }
    return;
  }

  const replyMode: "full" | "short" = decision.mode;
  await analytics.incAnswered();
  const isChannel = chat.type === "channel";
  const replyToId =
    isPrivate || msg.is_topic_message ? undefined : msg.message_id;

  let placeholderId: number | null = null;
  if (isChannel) {
    try {
      const placeholder = await sendMessage(cfg, chat.id, "✍️ دارم می‌نویسم...", {
        ...(replyToId ? { reply_to_message_id: replyToId, allow_sending_without_reply: true } : {}),
        disable_notification: true,
      });
      placeholderId = placeholder.message_id;
    } catch (err) {
      log.warn("placeholder_send_failed", { err: (err as Error).message });
    }
  }

  await maybeTyping(cfg, chat.id, msg.message_thread_id);

  const snap = await memory.getSnapshot();
  const maybeJoke = (Math.random() < 0.15 && (await memory.pickRandomJoke()))
    ? `یه جوک قدیمی یادتون نره: «${(await memory.pickRandomJoke())!.text}»`
    : undefined;

  const eventNotes: string[] = [];
  if (replyMode === "short") eventNotes.push("لطفاً خیلی کوتاه جواب بده (یکی دو جمله).");
  if (norm.isForward) eventNotes.push("این پیام فوروارد شده. می‌تونی نظرت رو بگی یا ارجاع بدی.");
  if (norm.hasMedia) {
    if (norm.mediaKind === "photo") eventNotes.push("یه عکس پیوست شده؛ اگه ابزار دیدن عکس داری، نگاه کن و جزئیات جالبش رو بگو. از کپشن‌های کلیشه‌ای پرهیز کن.");
    if (norm.mediaKind === "audio" && norm.audioMeta) {
      const m = norm.audioMeta;
      eventNotes.push(
        `یه فایل صوتی پیوست شده${m.title || m.performer ? ` (${[m.title, m.performer].filter(Boolean).join(" — ")})` : ""}. اگه می‌تونی با ابزار search_song اطلاعات جالبش رو دربیار.`,
      );
    }
    if (norm.mediaKind === "voice") eventNotes.push("یه ویس فرستاده شده. محتوای ویس رو نداریم، ولی می‌تونی واکنش طبیعی نشون بدی.");
    if (norm.mediaKind === "video") eventNotes.push("یه ویدیو پیوست شده. ویدیو رو نمی‌بینی ولی می‌تونی بر اساس کپشن/نام فایل واکنش نشون بدی.");
    if (norm.mediaKind === "sticker") eventNotes.push("استیکر فرستاده شده؛ واکنش طبیعی نشون بده.");
    if (norm.mediaKind === "document") eventNotes.push("یه فایل/سند پیوست شده. بر اساس نام فایل و کپشن واکنش نشون بده.");
  }
  if (norm.urls.length) {
    eventNotes.push(`لینک پیوست شده: ${norm.urls[0]} — اگه مرتبطه، با fetch_link اطلاعاتش رو بگیر و نظر شخصی بده.`);
  }

  const trumpTriggered = !!text && /trump|ترامپ/i.test(text);

  const systemPrompt = buildSystemPrompt({
    cfg,
    mood: curMood,
    memory: snap,
    chat: { id: chat.id, type: chat.type, title: chat.title, username: chat.username },
    ...(maybeJoke ? { maybeReferenceJoke: maybeJoke } : {}),
    eventNote: eventNotes.join(" "),
    trumpTriggered,
  });

  const userMsg = await buildUserMessageWithMedia(cfg, msg, norm);

  const messages = [
    { role: "system" as const, content: systemPrompt },
    userMsg,
  ];

  const toolNotes: string[] = [];

  if (norm.mediaKind === "audio" && norm.audioMeta?.title) {
    try {
      const r = await searchMusic(cfg, `${norm.audioMeta.title} ${norm.audioMeta.performer ?? ""}`, 2);
      if (r.length) {
        toolNotes.push(`موسیقی (پیش‌سرچ): ${r.map((x) => `${x.trackName} — ${x.artistName} (${x.collectionName ?? "—"})`).join(" | ")}`);
      }
    } catch {
      /* ignore */
    }
  }

  if (norm.urls.length) {
    try {
      const meta = await fetchLinkMetadata(cfg, norm.urls[0]!);
      toolNotes.push(`لینک (پیش‌نگاه): ${meta.title ?? "—"}${meta.description ? ` — ${truncate(meta.description, 160)}` : ""} [${meta.siteName ?? ""}]`);
    } catch {
      /* ignore */
    }
  }

  if (toolNotes.length) {
    messages.push({
      role: "system",
      content: "==== یادداشت‌های زمینه‌ای (از ابزارها) ====\n" + toolNotes.join("\n"),
    });
  }

  const result = await runWithTools({
    cfg,
    messages,
    tools: TOOL_DEFS,
    toolDeps: {
      cfg,
      onToolCall: async (name) => {
        await analytics.incToolCall();
        if (name === "web_search" || name === "search_song" || name === "search_artist" || name === "search_album") {
          await analytics.incSearch();
        }
      },
      onNickname: async (uid, nick) => {
        await memory.setNickname(uid, nick);
      },
      onJoke: async (text) => {
        await memory.addJoke(text);
      },
    },
    maxRounds: 3,
    maxTokens: replyMode === "short" ? 300 : 1000,
    temperature: 0.7,
  });

  let finalText = result.finalText;
  if (!finalText) {
    log.warn("empty_final_text", { rounds: result.rounds });
    if (placeholderId) {
      try {
        await editMessageText(cfg, chat.id, placeholderId, "⚠️ جوابی تولید نشد.");
      } catch {
        /* ignore */
      }
    }
    return;
  }
  finalText = cleanModelOutput(finalText);
  if (!finalText) {
    if (placeholderId) {
      try {
        await editMessageText(cfg, chat.id, placeholderId, "⚠️ جوابی تولید نشد.");
      } catch {
        /* ignore */
      }
    }
    return;
  }

  const sent = await deliverReply(
    cfg,
    log,
    chat.id,
    placeholderId,
    finalText,
    replyToId,
    replyMode,
    analytics,
  );
  if (!sent) {
    await analytics.flush();
    return;
  }

  if (cfg.mirrorChatId && chat.id !== cfg.mirrorChatId) {
    try {
      await sendMessage(cfg, cfg.mirrorChatId, stripHtml(finalText), { disable_notification: true });
    } catch (err) {
      log.warn("mirror_failed", { err: (err as Error).message });
    }
  }

  await analytics.flush();
}

async function handleCallbackQuery(
  env: Env,
  cfg: Config,
  cq: { id: string; from: { id: number; username?: string }; message?: TgMessage; data?: string },
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const data = cq.data ?? "";
  const chatId = cq.message?.chat.id ?? cq.from.id;
  const userId = cq.from.id;
  const isAdm = cfg.adminIds.includes(userId);

  if (data.startsWith("cmd:")) {
    const cmd = data.split(":")[1] ?? "";
    if (!isAdm && ["mood", "stats", "memory", "adminonly", "whitelist"].includes(cmd)) {
      await answerCallbackQuery(cfg, cq.id, "🚫 فقط ادمین‌ها.");
      return;
    }
    const settings = await loadSettings(env.DB, {
      timezone: cfg.timezone,
      allowedChatIds: cfg.allowedChatIds,
      adminOnly: cfg.adminOnly,
    });
    const analytics = new Analytics(env.DB, chatId, cfg);
    const mood = new MoodEngine(env.DB, cfg, chatId, settings.timezone);
    const memory = new MemoryManager(env.DB, cfg, chatId);
    const deps: AdminDeps = { cfg, env, analytics, memory, mood, settings };
    const args: CommandArgs = { chatId, userId, command: `/${cmd}`, rest: "", isPrivate: true };

    switch (cmd) {
      case "main": {
        const mainTxt = `سلام! 👋 من <b>${cfg.botNickname}</b> هستم.\nتو ادمین هستی — همه دستورها در دسترس شما.`;
        const msgId = cq.message?.message_id;
        if (msgId) { try { await editMessageText(cfg, chatId, msgId, mainTxt, { parse_mode: "HTML", reply_markup: inlineKeyboard(MAIN_MENU) }); await answerCallbackQuery(cfg, cq.id); return; } catch { /* fall through */ } }
        await sendMessage(cfg, chatId, mainTxt, { parse_mode: "HTML", reply_markup: inlineKeyboard(MAIN_MENU) });
        break;
      }
      case "mood": await cmdMood(deps, chatId, cq.message?.message_id); break;
      case "stats": await cmdStats(deps, chatId, cq.message?.message_id); break;
      case "memory": await cmdMemory(deps, chatId, cq.message?.message_id); break;
      case "help": await cmdHelp(deps, args, cq.message?.message_id); break;
      case "whitelist": await cmdWhitelist(deps, args, cq.message?.message_id); break;
      case "adminonly": await cmdAdminOnly(deps, chatId, cq.message?.message_id); break;
      default: await answerCallbackQuery(cfg, cq.id);
    }
    await answerCallbackQuery(cfg, cq.id);
    return;
  }

  if (data.startsWith("mood:")) {
    if (!isAdm) { await answerCallbackQuery(cfg, cq.id, "🚫 فقط ادمین‌ها."); return; }
    const moodName = data.split(":")[1] as MoodName;
    const settings = await loadSettings(env.DB, { timezone: cfg.timezone, allowedChatIds: cfg.allowedChatIds, adminOnly: cfg.adminOnly });
    const mood = new MoodEngine(env.DB, cfg, chatId, settings.timezone);
    await mood.setMood(moodName, "admin button", 0.85);
    await cmdMood({ cfg, env, analytics: new Analytics(env.DB, chatId, cfg), memory: new MemoryManager(env.DB, cfg, chatId), mood, settings }, chatId, cq.message?.message_id);
    await answerCallbackQuery(cfg, cq.id, `مود: ${moodName}`);
    return;
  }

  if (data.startsWith("mem:")) {
    if (!isAdm) { await answerCallbackQuery(cfg, cq.id, "🚫 فقط ادمین‌ها."); return; }
    const section = data.split(":")[1];
    const settings = await loadSettings(env.DB, { timezone: cfg.timezone, allowedChatIds: cfg.allowedChatIds, adminOnly: cfg.adminOnly });
    const memory = new MemoryManager(env.DB, cfg, chatId);

    if (section === "clear") {
      await memory.clearAll();
      const msgId = cq.message?.message_id;
      const clearTxt = "🧹 حافظه پاک شد.";
      const clearOpts = { reply_markup: inlineKeyboard(MEMORY_KEYBOARD) };
      if (msgId) { try { await editMessageText(cfg, chatId, msgId, clearTxt, clearOpts); await answerCallbackQuery(cfg, cq.id, "حافظه پاک شد"); return; } catch { /* fall through */ } }
      await sendMessage(cfg, chatId, clearTxt, clearOpts);
      await answerCallbackQuery(cfg, cq.id, "حافظه پاک شد");
      return;
    }

    const snap = await memory.getSnapshot();
    let txt = "";
    switch (section) {
      case "topics":
        txt = `📋 <b>موضوعات:</b>\n${snap.topics.slice(0, 10).map((t) => `• ${escape(t.topic)} — ${t.count}`).join("\n") || "—"}`;
        break;
      case "jokes":
        txt = `😂 <b>جوک‌ها:</b>\n${snap.jokes.slice(-5).map((j) => `• ${escape(j.text)} (×${j.references})`).join("\n") || "—"}`;
        break;
      case "nicknames":
        txt = `👤 <b>نیک‌نیم‌ها:</b>\n${snap.nicknames.slice(0, 10).map((n) => `• ${n.nickname}`).join("\n") || "—"}`;
        break;
      case "summary":
        txt = `📝 <b>خلاصه بلندمدت:</b>\n<pre>${escape(snap.summary || "(خالی)")}</pre>`;
        break;
    }
    const memMsgId = cq.message?.message_id;
    const memOpts = { parse_mode: "HTML" as const, reply_markup: inlineKeyboard(MEMORY_KEYBOARD) };
    if (memMsgId) { try { await editMessageText(cfg, chatId, memMsgId, txt, memOpts); await answerCallbackQuery(cfg, cq.id); return; } catch { /* fall through */ } }
    await sendMessage(cfg, chatId, txt, memOpts);
    await answerCallbackQuery(cfg, cq.id);
    return;
  }

  if (data.startsWith("stats:")) {
    if (!isAdm) { await answerCallbackQuery(cfg, cq.id, "🚫 فقط ادمین‌ها."); return; }
    const section = data.split(":")[1];
    const settings = await loadSettings(env.DB, { timezone: cfg.timezone, allowedChatIds: cfg.allowedChatIds, adminOnly: cfg.adminOnly });
    const analytics = new Analytics(env.DB, chatId, cfg);
    const a = await analytics.snapshot();
    let txt = "";

    switch (section) {
      case "mood":
        txt = `🎭 <b>تفکیک مود:</b>\n${Object.entries(a.byMood).sort((x, y) => y[1] - x[1]).map(([k, v]) => `• ${k}: ${v}`).join("\n") || "—"}`;
        break;
      case "kind":
        txt = `📝 <b>تفکیک نوع:</b>\n${Object.entries(a.byKind).sort((x, y) => y[1] - x[1]).map(([k, v]) => `• ${k}: ${v}`).join("\n") || "—"}`;
        break;
      case "topics":
        txt = `📋 <b>تاپیک‌ها:</b>\n${a.topTopics.slice(0, 10).map((t) => `• ${escape(t.topic)}: ${t.count}`).join("\n") || "—"}`;
        break;
    }
    const statsMsgId = cq.message?.message_id;
    const statsOpts = { parse_mode: "HTML" as const, reply_markup: inlineKeyboard(STATS_KEYBOARD) };
    if (statsMsgId) { try { await editMessageText(cfg, chatId, statsMsgId, txt, statsOpts); await answerCallbackQuery(cfg, cq.id); return; } catch { /* fall through */ } }
    await sendMessage(cfg, chatId, txt, statsOpts);
    await answerCallbackQuery(cfg, cq.id);
    return;
  }

  if (data.startsWith("wl:")) {
    if (!isAdm) { await answerCallbackQuery(cfg, cq.id, "🚫 فقط ادمین‌ها."); return; }
    const action = data.split(":")[1];
    const settings = await loadSettings(env.DB, { timezone: cfg.timezone, allowedChatIds: cfg.allowedChatIds, adminOnly: cfg.adminOnly });

    if (action === "clear") {
      settings.allowedChatIds = [];
      await saveWhitelist(env.DB, []);
      const wlMsgId = cq.message?.message_id;
      const wlClearTxt = "🧹 وایت‌لیست پاک شد.";
      const wlClearOpts = { reply_markup: inlineKeyboard(WHITELIST_KEYBOARD) };
      if (wlMsgId) { try { await editMessageText(cfg, chatId, wlMsgId, wlClearTxt, wlClearOpts); await answerCallbackQuery(cfg, cq.id, "وایت‌لیست پاک شد"); return; } catch { /* fall through */ } }
      await sendMessage(cfg, chatId, wlClearTxt, wlClearOpts);
      await answerCallbackQuery(cfg, cq.id, "وایت‌لیست پاک شد");
      return;
    }

    if (action === "add" || action === "remove") {
      await sendMessage(cfg, chatId, `وایت‌لیست — آیدی چت رو بفرست (${action === "add" ? "افزودن" : "حذف"}):`, {
        reply_markup: { force_reply: true, selective: true },
      });
      await answerCallbackQuery(cfg, cq.id);
      return;
    }

    await cmdWhitelist({ cfg, env, analytics: new Analytics(env.DB, chatId, cfg), memory: new MemoryManager(env.DB, cfg, chatId), mood: new MoodEngine(env.DB, cfg, chatId), settings }, { chatId, userId, command: "/whitelist", rest: "", isPrivate: true }, cq.message?.message_id);
    await answerCallbackQuery(cfg, cq.id);
    return;
  }

  if (data.startsWith("set:")) {
    if (!isAdm) { await answerCallbackQuery(cfg, cq.id, "🚫 فقط ادمین‌ها."); return; }
    const setting = data.split(":")[1];
    const settings = await loadSettings(env.DB, { timezone: cfg.timezone, allowedChatIds: cfg.allowedChatIds, adminOnly: cfg.adminOnly });

    if (setting === "adminonly") {
      settings.adminOnly = !settings.adminOnly;
      await saveAdminOnly(env.DB, settings.adminOnly);
      await cmdAdminOnly({ cfg, env, analytics: new Analytics(env.DB, chatId, cfg), memory: new MemoryManager(env.DB, cfg, chatId), mood: new MoodEngine(env.DB, cfg, chatId), settings }, chatId, cq.message?.message_id);
      await answerCallbackQuery(cfg, cq.id, settings.adminOnly ? "ادمین‌فقط فعال" : "ادمین‌فقط غیرفعال");
      return;
    }

    if (setting === "timezone") {
      await sendMessage(cfg, chatId, "ساعت جدید رو بفرست (مثل Asia/Tehran):", {
        reply_markup: { force_reply: true, selective: true },
      });
      await answerCallbackQuery(cfg, cq.id);
      return;
    }

    await answerCallbackQuery(cfg, cq.id);
    return;
  }

  await answerCallbackQuery(cfg, cq.id);
}

async function maybeTyping(cfg: Config, chatId: number, threadId?: number): Promise<void> {
  void threadId;
  try {
    await sendChatAction(cfg, chatId, "typing");
  } catch {
    /* ignore */
  }
  void sleep(randInt(4000, 7000)).then(() => sendChatAction(cfg, chatId, "typing"));
}

/* ============================================================
 * Reply delivery
 * ============================================================ */
async function deliverReply(
  cfg: Config,
  log: ReturnType<typeof createLogger>,
  chatId: number,
  placeholderId: number | null,
  text: string,
  replyToId: number | undefined,
  replyMode: "full" | "short",
  analytics: Analytics,
): Promise<boolean> {
  const MAX = 4096;

  if (placeholderId !== null) {
    const firstChunk = text.slice(0, MAX);
    const restText = text.slice(MAX);
    let edited = false;
    try {
      await editMessageText(cfg, chatId, placeholderId, firstChunk, { parse_mode: "HTML" });
      edited = true;
    } catch (err) {
      if (err instanceof TgApiError) {
        log.warn("edit_html_failed_retry_plain", { err: err.description });
        try {
          await editMessageText(cfg, chatId, placeholderId, stripHtml(firstChunk));
          edited = true;
        } catch (err2) {
          log.warn("edit_plain_failed_fallback_send", { err: (err2 as Error).message });
        }
      } else {
        log.warn("edit_failed_fallback_send", { err: (err as Error).message });
      }
    }
    if (edited) {
      if (restText.length > 0) {
        try {
          await sendMessage(cfg, chatId, restText, {
            parse_mode: "HTML",
            disable_notification: replyMode === "short" ? true : false,
          });
        } catch (err) {
          if (err instanceof TgApiError) {
            log.warn("send_rest_html_failed_retry_plain", { err: err.description });
            try {
              await sendMessage(cfg, chatId, stripHtml(restText));
            } catch (err2) {
              log.error("send_rest_plain_failed", { err: (err2 as Error).message });
              await analytics.incError();
            }
          } else {
            log.error("send_rest_failed", { err: (err as Error).message });
            await analytics.incError();
          }
        }
      }
      return true;
    }
    try {
      await deleteMessage(cfg, chatId, placeholderId);
    } catch {
      /* ignore */
    }
  }

  try {
    await sendMessage(cfg, chatId, text, {
      parse_mode: "HTML",
      ...(replyToId ? { reply_to_message_id: replyToId, allow_sending_without_reply: true } : {}),
      disable_notification: replyMode === "short" ? true : false,
    });
    return true;
  } catch (err) {
    if (err instanceof TgApiError) {
      log.warn("send_html_failed_retry_plain", { err: err.description });
      try {
        await sendMessage(cfg, chatId, stripHtml(text), {
          ...(replyToId ? { reply_to_message_id: replyToId, allow_sending_without_reply: true } : {}),
        });
        return true;
      } catch (err2) {
        log.error("send_plain_failed", { err: (err2 as Error).message });
        await analytics.incError();
        return false;
      }
    }
    log.error("send_failed", { err: (err as Error).message });
    await analytics.incError();
    return false;
  }
}

/* ============================================================
 * Helpers
 * ============================================================ */
async function buildUserMessageWithMedia(
  cfg: Config,
  msg: TgMessage,
  norm: ReturnType<typeof normalizeMessage>,
): Promise<{ role: "user"; content: string | import("./types.js").ChatContentPart[] }> {
  const displayName = norm.event.displayName;
  const text = norm.text;

  const parts: string[] = [];
  parts.push(`[${displayName}${msg.is_topic_message ? " در تاپیک" : ""}]`);
  if (msg.is_topic_message && msg.message_thread_id) {
    parts.push(`(thread=${msg.message_thread_id})`);
  }
  if (msg.forward_from || msg.forward_from_chat) {
    const src = msg.forward_from?.username
      ? `@${msg.forward_from.username}`
      : msg.forward_from_chat?.title ?? "ناشناس";
    parts.push(`(فوروارد از ${src})`);
  }
  if (text) parts.push(text);
  else parts.push("(بدون متن — فقط مدیا)");
  if (norm.urls.length) parts.push(`لینک‌ها: ${norm.urls.join(" ")}`);
  if (norm.mediaKind === "audio" && norm.audioMeta) {
    const m = norm.audioMeta;
    parts.push(
      `🎵 [audio] ${[m.title, m.performer].filter(Boolean).join(" — ")} (${Math.round((m.duration ?? 0) / 60)}:${String((m.duration ?? 0) % 60).padStart(2, "0")})${m.file_name ? ` — فایل: ${m.file_name}` : ""}`,
    );
  }
  if (norm.mediaKind === "video") parts.push("🎬 [video]");
  if (norm.mediaKind === "sticker" && msg.sticker?.emoji) parts.push(`[sticker ${msg.sticker.emoji}]`);
  if (norm.mediaKind === "document" && msg.document?.file_name) parts.push(`📄 [document: ${msg.document.file_name}]`);

  let imageParts: import("./types.js").ChatContentPart[] = [];
  if (norm.mediaKind === "photo" && norm.imageTelegramFileId) {
    try {
      const r = await prepareImageParts(cfg, norm.imageTelegramFileId);
      imageParts = r.parts;
    } catch {
      imageParts = [];
    }
  }

  if (imageParts.length > 0) {
    return {
      role: "user",
      content: [
        { type: "text", text: parts.join("\n") + "\n\n(تصویر پیوست شده — توصیف و جزئیاتش رو ببین)" },
        ...imageParts,
      ],
    };
  }
  return { role: "user", content: parts.join("\n") };
}

function cleanModelOutput(s: string): string {
  let out = stripReasoning(s);
  out = out.replace(/^```[a-zA-Z]*\n/, "").replace(/\n```$/, "");
  out = out.replace(/^["']|["']$/g, "").trim();
  return out;
}

function stripHtml(s: string): string {
  return s.replace(/<\/?[a-zA-Z][^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
