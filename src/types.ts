/// <reference types="@cloudflare/workers-types" />

/* =============================================================
 * Cloudflare Workers bindings
 * ============================================================= */
export interface Env {
  // Secrets
  TELEGRAM_BOT_TOKEN: string;
  TOKENROUTER_API_KEY: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  SETUP_SECRET?: string;

  // Vars
  TELEGRAM_API_BASE: string;
  TOKENROUTER_BASE: string;
  MODEL: string;
  ADMIN_IDS: string;
  ADMIN_ONLY: string;
  ALLOWED_CHAT_IDS: string;
  MIRROR_CHAT_ID?: string;
  LOG_LEVEL: string;
  BOT_NICKNAME: string;
  BOT_LANG_PRIMARY: string;
  TIMEZONE?: string;

  // D1 Database
  DB: D1Database;
}

/* =============================================================
 * Telegram — minimal but complete types we actually consume
 * (https://core.telegram.org/bots/api)
 * ============================================================= */
export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: boolean;
}

export interface TgMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TgUser;
  language?: string;
  custom_emoji_id?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TgVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  thumbnail?: TgPhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_unique_id: string;
  thumbnail?: TgPhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgAnimation {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  thumbnail?: TgPhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgSticker {
  file_id: string;
  file_unique_id: string;
  type: string;
  width: number;
  height: number;
  is_animated: boolean;
  is_video: boolean;
  thumbnail?: TgPhotoSize;
  emoji?: string;
  set_name?: string;
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TgUser;
  sender_chat?: TgChat;
  author_signature?: string;
  date: number;
  chat: TgChat;
  text?: string;
  caption?: string;
  entities?: TgMessageEntity[];
  caption_entities?: TgMessageEntity[];
  photo?: TgPhotoSize[];
  audio?: TgAudio;
  voice?: TgVoice;
  video?: TgVideo;
  document?: TgDocument;
  animation?: TgAnimation;
  sticker?: TgSticker;
  is_topic_message?: boolean;
  reply_to_message?: TgMessage;
  forward_from?: TgUser;
  forward_from_chat?: TgChat;
  forward_date?: number;
  via_bot?: TgUser;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  edited_channel_post?: TgMessage;
  callback_query?: {
    id: string;
    from: TgUser;
    message?: TgMessage;
    chat_instance: string;
    data?: string;
  };
}

export interface BotSettings {
  timezone: string;
  allowedChatIds: number[];
  adminOnly: boolean;
}

export interface TgApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

/* =============================================================
 * Mood
 * ============================================================= */
export type MoodName =
  | "excited"
  | "sleepy"
  | "chaotic"
  | "curious"
  | "impressed"
  | "suspicious"
  | "nostalgic"
  | "dramatic"
  | "trump";

export interface MoodState {
  mood: MoodName;
  intensity: number; // 0..1
  reason: string;
  updatedAt: number; // epoch ms
}

/* =============================================================
 * Memory
 * ============================================================= */
export interface MemoryEvent {
  id: string;
  ts: number;
  chatId: number;
  userId?: number;
  username?: string;
  displayName: string;
  kind:
    | "text"
    | "photo"
    | "video"
    | "audio"
    | "voice"
    | "document"
    | "sticker"
    | "link"
    | "forward"
    | "bot_reply";
  summary: string;
  topics: string[];
  mood?: MoodName;
  reactions?: string[];
}

export interface TopicCount {
  topic: string;
  count: number;
  lastTs: number;
}

export interface RunningJoke {
  id: string;
  text: string;
  createdTs: number;
  references: number;
}

export interface NicknameRecord {
  userId: number;
  nickname: string;
  updatedTs: number;
}

export interface MemorySnapshot {
  recent: MemoryEvent[];
  topics: TopicCount[];
  jokes: RunningJoke[];
  nicknames: NicknameRecord[];
  summary: string;
  summaryUpdatedTs: number;
}

/* =============================================================
 * Analytics
 * ============================================================= */
export interface AnalyticsSnapshot {
  messagesSeen: number;
  messagesAnswered: number;
  reactionsOnly: number;
  ignored: number;
  toolCalls: number;
  errors: number;
  byMood: Record<string, number>;
  byKind: Record<string, number>;
  topTopics: { topic: string; count: number }[];
  searchCount: number;
  startedAt: number;
}

/* =============================================================
 * AI provider — prox.us.ci / Power of God (OpenAI-compatible)
 * ============================================================= */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ChatChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
    refusal?: string | null;
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
