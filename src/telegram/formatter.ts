/**
 * Normalize a Telegram message into a compact, type-safe description
 * ("event") that the rest of the pipeline can consume uniformly.
 *
 * We never store raw user text; we summarize / excerpt it.
 */
import type { TgMessage, MemoryEvent } from "../types.js";
import { extractUrls, nanoId, truncate } from "../utils/util.js";
import { extractFirstUrl } from "../utils/util.js";
import { escapeRegex } from "../utils/util.js";

export interface NormalizedEvent {
  event: Omit<MemoryEvent, "mood" | "reactions">;
  text: string; // clean text/caption (already truncated, urls redacted if long)
  urls: string[];
  hasMedia: boolean;
  mediaKind: "photo" | "video" | "audio" | "voice" | "document" | "sticker" | "animation" | null;
  isForward: boolean;
  imageTelegramFileId: string | null;
  audioMeta: { performer?: string; title?: string; file_name?: string; duration: number } | null;
}

function displayNameOf(m: TgMessage): string {
  if (m.from) {
    const u = m.from;
    return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || `user#${u.id}`;
  }
  if (m.author_signature) return m.author_signature;
  if (m.sender_chat) return m.sender_chat.title || m.sender_chat.username || `chat#${m.sender_chat.id}`;
  return "unknown";
}

function biggestPhoto(m: TgMessage): { file_id: string } | null {
  if (!m.photo || m.photo.length === 0) return null;
  return m.photo.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
}

export function normalizeMessage(m: TgMessage): NormalizedEvent {
  const raw = m.text ?? m.caption ?? "";
  const urls = extractUrls(raw);
  const text = truncate(raw, 800);

  let kind: NormalizedEvent["mediaKind"] = null;
  if (m.photo) kind = "photo";
  else if (m.audio) kind = "audio";
  else if (m.voice) kind = "voice";
  else if (m.video) kind = "video";
  else if (m.animation) kind = "animation";
  else if (m.document) kind = "document";
  else if (m.sticker) kind = "sticker";

  const hasMedia = kind !== null;
  const isForward = !!(m.forward_from || m.forward_from_chat || m.forward_date);

  // Build a short human-readable summary
  const parts: string[] = [];
  const who = displayNameOf(m);
  if (text) parts.push(`"${truncate(text, 240)}"`);
  if (kind) parts.push(`[${kind}]`);
  if (isForward) parts.push("(forwarded)");
  if (m.audio?.performer || m.audio?.title) {
    parts.push(`🎵 ${[m.audio.title, m.audio.performer].filter(Boolean).join(" — ")}`);
  }
  const summary = `${who}: ${parts.join(" ")}`.trim();

  const event: Omit<MemoryEvent, "mood" | "reactions"> = {
    id: nanoId(),
    ts: m.date * 1000,
    chatId: m.chat.id,
    userId: m.from?.id,
    username: m.from?.username,
    displayName: who,
    kind: hasMedia ? (kind as MemoryEvent["kind"]) : "text",
    summary,
    topics: [],
  };

  const audioMeta =
    m.audio
      ? {
          performer: m.audio.performer,
          title: m.audio.title,
          file_name: m.audio.file_name,
          duration: m.audio.duration,
        }
      : null;

  return {
    event,
    text,
    urls,
    hasMedia,
    mediaKind: kind,
    isForward,
    imageTelegramFileId: biggestPhoto(m)?.file_id ?? null,
    audioMeta,
  };
}

export function firstUrlOrNull(text: string): string | null {
  return extractFirstUrl(text);
}

/* ============================================================
 * Bot address detection
 *
 * Determines whether an incoming message is "addressed" to the bot
 * — either by mentioning it (proper @mention via entities, the
 * ASCII username, or the configured Persian nickname) or by being
 * a reply to one of the bot's own messages.
 *
 * This is the only reliable way to handle channel posts, where the
 * bot may not have access to `message_thread_id` and users may type
 * the Persian nickname instead of the @username.
 * ============================================================ */
export interface BotIdentity {
  id: number;
  username: string;
}

export interface AddressDetection {
  /** True if the message contains any kind of mention of the bot. */
  mentioned: boolean;
  /** True if the message is a direct reply to a message the bot posted. */
  replyToBot: boolean;
  /** Convenience: mentioned || replyToBot. */
  addressed: boolean;
  /** Which signal triggered the detection, for logging. */
  source: "entity_text_mention" | "entity_mention" | "username_regex" | "nickname" | "reply_to_bot" | "none";
}

export function detectBotAddress(
  msg: TgMessage,
  me: BotIdentity | null,
  nickname: string,
): AddressDetection {
  if (!me) return { mentioned: false, replyToBot: false, addressed: false, source: "none" };

  const text = msg.text ?? msg.caption ?? "";
  let mentioned = false;
  let source: AddressDetection["source"] = "none";

  // 1) Proper Telegram @mention via entities — the most reliable path.
  //    Channels and groups always populate `entities` for real mentions.
  const entities = msg.entities ?? msg.caption_entities ?? [];
  for (const e of entities) {
    if (e.type === "text_mention" && e.user?.id === me.id) {
      mentioned = true;
      source = "entity_text_mention";
      break;
    }
    if (e.type === "mention" && me.username) {
      const mentionedText = text
        .slice(e.offset, e.offset + e.length)
        .toLowerCase();
      if (mentionedText === `@${me.username.toLowerCase()}`) {
        mentioned = true;
        source = "entity_mention";
        break;
      }
    }
  }

  // 2) Fallback: @username anywhere in the text (catches manual typing
  //    and edge cases where entities were stripped).
  if (!mentioned && me.username) {
    const re = new RegExp(`@${escapeRegex(me.username)}\\b`, "i");
    if (re.test(text)) {
      mentioned = true;
      source = "username_regex";
    }
  }

  // 3) Configured Persian nickname (e.g. "موشتبی") anywhere in the text.
  //    The user types the name without @, and we still treat it as a mention.
  if (!mentioned && nickname && nickname.length >= 2 && text.includes(nickname)) {
    mentioned = true;
    source = "nickname";
  }

  // 4) Reply to the bot's own message. Match by user ID (stable) rather
  //    than username (which the bot might not have or could change).
  const replyToBot = !!msg.reply_to_message?.from?.id && msg.reply_to_message.from.id === me.id;
  if (replyToBot && source === "none") source = "reply_to_bot";

  return {
    mentioned,
    replyToBot,
    addressed: mentioned || replyToBot,
    source,
  };
}
