/**
 * Telegram Bot API client.
 * Exposes the small subset of methods we use. All methods return parsed JSON
 * and throw `TgApiError` on `ok:false`. We never log tokens or message bodies.
 */
import type { Config } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { fetchWithRetry, HttpError } from "../utils/fetch.js";
import { parseRetryAfter } from "../utils/util.js";
import type { TgApiResponse, TgMessage, TgUpdate } from "../types.js";

export class TgApiError extends Error {
  constructor(
    public readonly code: number | undefined,
    public readonly description: string,
    public readonly retryAfter: number,
  ) {
    super(`Telegram API error ${code ?? "?"}: ${description}`);
    this.name = "TgApiError";
  }
}

async function call<T>(cfg: Config, method: string, params: Record<string, unknown>): Promise<T> {
  const url = `${cfg.telegramApiBase}/bot${cfg.telegramToken}/${method}`;
  const log = createLogger(cfg, "tg");
  // Telegram wants form-urlencoded for some methods, but JSON works for all read/write methods.
  // We always use JSON to keep it simple.
  try {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      timeoutMs: 15_000,
      retries: 3,
    });
    const data = (await res.json()) as TgApiResponse<T>;
    if (!data.ok) {
      const retryAfter = data.parameters?.retry_after ?? 0;
      log.warn("api_error", { method, code: data.error_code, description: data.description, retryAfter });
      throw new TgApiError(data.error_code, data.description ?? "unknown", retryAfter);
    }
    return data.result as T;
  } catch (err) {
    if (err instanceof TgApiError) throw err;
    if (err instanceof HttpError) {
      const ra = parseRetryAfter(null, err.body);
      throw new TgApiError(err.status, `HTTP ${err.status}: ${err.body.slice(0, 200)}`, ra);
    }
    throw err;
  }
}

export interface SendMessageOpts {
  parse_mode?: "HTML" | "MarkdownV2";
  reply_to_message_id?: number;
  disable_notification?: boolean;
  reply_markup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | { remove_keyboard: true; selective?: boolean } | ForceReply | Record<string, unknown>;
  allow_sending_without_reply?: boolean;
}

export async function sendMessage(
  cfg: Config,
  chatId: number,
  text: string,
  opts: SendMessageOpts = {},
): Promise<TgMessage> {
  // Telegram message length limit
  const MAX = 4096;
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX));
  let last: TgMessage | undefined;
  for (const chunk of chunks) {
    last = await call<TgMessage>(cfg, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      ...(opts.parse_mode ? { parse_mode: opts.parse_mode } : {}),
      ...(opts.reply_to_message_id ? { reply_to_message_id: opts.reply_to_message_id } : {}),
      ...(opts.disable_notification ? { disable_notification: true } : {}),
      ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
      ...(opts.allow_sending_without_reply ? { allow_sending_without_reply: true } : {}),
    });
  }
  return last as TgMessage;
}

export async function editMessageText(
  cfg: Config,
  chatId: number,
  messageId: number,
  text: string,
  opts: { parse_mode?: "HTML" | "MarkdownV2"; reply_markup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | { remove_keyboard: true; selective?: boolean } | ForceReply | Record<string, unknown> } = {},
): Promise<boolean> {
  const r = await call<boolean>(cfg, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(opts.parse_mode ? { parse_mode: opts.parse_mode } : {}),
    ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
  });
  return r;
}

/** Send "typing..." action; the status expires after ~5s on Telegram's side. */
export async function sendChatAction(cfg: Config, chatId: number, action: string): Promise<void> {
  try {
    await call<boolean>(cfg, "sendChatAction", { chat_id: chatId, action });
  } catch {
    // non-fatal
  }
}

/** Register the webhook URL with Telegram. Called by the /setup route. */
export async function setWebhook(
  cfg: Config,
  url: string,
  secretToken: string | null,
): Promise<boolean> {
  return call<boolean>(cfg, "setWebhook", {
    url,
    ...(secretToken ? { secret_token: secretToken } : {}),
    allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "callback_query"],
    drop_pending_updates: true,
  });
}

export async function deleteWebhook(cfg: Config): Promise<boolean> {
  return call<boolean>(cfg, "deleteWebhook", { drop_pending_updates: true });
}

export async function getWebhookInfo(cfg: Config): Promise<Record<string, unknown>> {
  return call<Record<string, unknown>>(cfg, "getWebhookInfo", {});
}

export async function getMe(cfg: Config): Promise<{ id: number; username: string; first_name: string }> {
  return call(cfg, "getMe", {});
}

export interface SetReactionOpts {
  is_big?: boolean;
}
export async function setMessageReaction(
  cfg: Config,
  chatId: number,
  messageId: number,
  reaction: string[],
  opts: SetReactionOpts = {},
): Promise<boolean> {
  return call<boolean>(cfg, "setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: reaction.map((e) => ({ type: "emoji", emoji: e })),
    is_big: opts.is_big ?? false,
  });
}

export async function getFile(cfg: Config, fileId: string): Promise<{ file_id: string; file_path?: string; file_size?: number }> {
  return call(cfg, "getFile", { file_id: fileId });
}

export async function deleteMessage(
  cfg: Config,
  chatId: number,
  messageId: number,
): Promise<boolean> {
  return call<boolean>(cfg, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

export interface BotCommand {
  command: string;
  description: string;
}

export interface BotCommandScope {
  type: string;
  chat_id?: number;
  user_id?: number;
}

export async function setMyCommands(
  cfg: Config,
  commands: BotCommand[],
  scope?: BotCommandScope,
): Promise<boolean> {
  return call<boolean>(cfg, "setMyCommands", {
    commands,
    ...(scope ? { scope } : {}),
  });
}

export async function deleteMyCommands(
  cfg: Config,
  scope?: BotCommandScope,
): Promise<boolean> {
  return call<boolean>(cfg, "deleteMyCommands", {
    ...(scope ? { scope } : {}),
  });
}

export async function answerCallbackQuery(
  cfg: Config,
  callbackQueryId: string,
  text?: string,
): Promise<boolean> {
  return call<boolean>(cfg, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

/** Type-guard + helper to pick the "primary" message out of an update. */
export function pickMessage(update: TgUpdate): TgMessage | undefined {
  return update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface ReplyKeyboardButton {
  text: string;
  request_contact?: boolean;
  request_location?: boolean;
}

export interface ReplyKeyboardMarkup {
  keyboard: ReplyKeyboardButton[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  selective?: boolean;
}

export interface ForceReply {
  force_reply: true;
  selective?: boolean;
}

export function inlineKeyboard(keyboard: InlineKeyboardButton[][]): InlineKeyboardMarkup {
  return { inline_keyboard: keyboard };
}

export function replyKeyboard(keyboard: ReplyKeyboardButton[][], opts?: { resize?: boolean; oneTime?: boolean; selective?: boolean }): ReplyKeyboardMarkup {
  return {
    keyboard,
    resize_keyboard: opts?.resize ?? true,
    one_time_keyboard: opts?.oneTime ?? false,
    selective: opts?.selective ?? false,
  };
}

export function removeKeyboard(selective = false): { remove_keyboard: true; selective?: boolean } {
  return { remove_keyboard: true, selective };
}

export function forceReply(selective = false): ForceReply {
  return { force_reply: true, selective };
}
