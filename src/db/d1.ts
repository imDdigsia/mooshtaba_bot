/**
 * D1 (SQLite) helper functions.
 * Replaces all KV operations with D1 queries.
 */
import type { D1Database } from "@cloudflare/workers-types";

export interface D1Deps {
  db: D1Database;
}

// ---- Generic helpers ----

export async function d1GetJson<T>(db: D1Database, table: string, key: string, keyCol: string, fallback: T): Promise<T> {
  try {
    const row = await db.prepare(`SELECT data FROM ${table} WHERE ${keyCol} = ?`).bind(key).first<{ data: string }>();
    if (!row) return fallback;
    return JSON.parse(row.data) as T;
  } catch {
    return fallback;
  }
}

export async function d1PutJson(db: D1Database, table: string, key: string, keyCol: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value);
  await db.prepare(`INSERT OR REPLACE INTO ${table} (${keyCol}, data) VALUES (?, ?)`).bind(key, data).run();
}

// ---- Mood ----

export interface MoodRow {
  chat_id: number;
  state: string;
  updated_at: number;
}

export async function getMood(db: D1Database, chatId: number): Promise<MoodRow | null> {
  return db.prepare("SELECT chat_id, state, updated_at FROM mood WHERE chat_id = ?").bind(chatId).first<MoodRow>();
}

export async function putMood(db: D1Database, chatId: number, state: unknown, updatedAt: number): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO mood (chat_id, state, updated_at) VALUES (?, ?, ?)")
    .bind(chatId, JSON.stringify(state), updatedAt).run();
}

// ---- Activity ----

export interface ActivityRow {
  chat_id: number;
  window_start: number;
  count: number;
}

export async function getActivity(db: D1Database, chatId: number): Promise<ActivityRow | null> {
  return db.prepare("SELECT chat_id, window_start, count FROM activity WHERE chat_id = ?").bind(chatId).first<ActivityRow>();
}

export async function putActivity(db: D1Database, chatId: number, windowStart: number, count: number): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO activity (chat_id, window_start, count) VALUES (?, ?, ?)")
    .bind(chatId, windowStart, count).run();
}

// ---- Events ----

export interface EventRow {
  id: string;
  chat_id: number;
  data: string;
  created_at: number;
}

export async function getEvents(db: D1Database, chatId: number, limit = 80): Promise<EventRow[]> {
  const result = await db.prepare("SELECT id, chat_id, data, created_at FROM events WHERE chat_id = ? ORDER BY created_at ASC LIMIT ?")
    .bind(chatId, limit).all<EventRow>();
  return result.results ?? [];
}

export async function insertEvent(db: D1Database, chatId: number, id: string, data: unknown, createdAt: number): Promise<void> {
  await db.prepare("INSERT INTO events (id, chat_id, data, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, chatId, JSON.stringify(data), createdAt).run();
}

export async function deleteEvents(db: D1Database, chatId: number, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  await db.prepare(`DELETE FROM events WHERE chat_id = ? AND id IN (${placeholders})`)
    .bind(chatId, ...ids).run();
}

export async function countEvents(db: D1Database, chatId: number): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as cnt FROM events WHERE chat_id = ?").bind(chatId).first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

// ---- Topics ----

export interface TopicRow {
  id: number;
  chat_id: number;
  topic: string;
  count: number;
  last_ts: number;
}

export async function getTopics(db: D1Database, chatId: number, limit = 60): Promise<TopicRow[]> {
  const result = await db.prepare("SELECT id, chat_id, topic, count, last_ts FROM topics WHERE chat_id = ? ORDER BY count DESC LIMIT ?")
    .bind(chatId, limit).all<TopicRow>();
  return result.results ?? [];
}

export async function upsertTopic(db: D1Database, chatId: number, topic: string, lastTs: number): Promise<void> {
  const existing = await db.prepare("SELECT id FROM topics WHERE chat_id = ? AND topic = ?").bind(chatId, topic).first<{ id: number }>();
  if (existing) {
    await db.prepare("UPDATE topics SET count = count + 1, last_ts = ? WHERE id = ?").bind(lastTs, existing.id).run();
  } else {
    await db.prepare("INSERT INTO topics (chat_id, topic, count, last_ts) VALUES (?, ?, 1, ?)")
      .bind(chatId, topic, lastTs).run();
  }
}

export async function trimTopics(db: D1Database, chatId: number, maxCount = 60): Promise<void> {
  const rows = await db.prepare("SELECT id FROM topics WHERE chat_id = ? ORDER BY count DESC LIMIT ? OFFSET ?")
    .bind(chatId, maxCount, maxCount).all<{ id: number }>();
  if (rows.results && rows.results.length > 0) {
    const ids = rows.results.map(r => r.id);
    const placeholders = ids.map(() => "?").join(",");
    await db.prepare(`DELETE FROM topics WHERE chat_id = ? AND id IN (${placeholders})`).bind(chatId, ...ids).run();
  }
}

// ---- Jokes ----

export interface JokeRow {
  id: string;
  chat_id: number;
  text: string;
  joke_references: number;
  created_at: number;
}

export async function getJokes(db: D1Database, chatId: number, limit = 20): Promise<JokeRow[]> {
  const result = await db.prepare("SELECT id, chat_id, text, joke_references, created_at FROM jokes WHERE chat_id = ? ORDER BY created_at ASC LIMIT ?")
    .bind(chatId, limit).all<JokeRow>();
  return result.results ?? [];
}

export async function insertJoke(db: D1Database, chatId: number, id: string, text: string, createdAt: number): Promise<void> {
  await db.prepare("INSERT INTO jokes (id, chat_id, text, joke_references, created_at) VALUES (?, ?, ?, 0, ?)")
    .bind(id, chatId, text, createdAt).run();
}

export async function incrementJokeReferences(db: D1Database, jokeId: string): Promise<void> {
  await db.prepare("UPDATE jokes SET joke_references = joke_references + 1 WHERE id = ?").bind(jokeId).run();
}

export async function trimJokes(db: D1Database, chatId: number, maxCount = 20): Promise<void> {
  const rows = await db.prepare("SELECT id FROM jokes WHERE chat_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?")
    .bind(chatId, maxCount, maxCount).all<{ id: string }>();
  if (rows.results && rows.results.length > 0) {
    const ids = rows.results.map(r => r.id);
    const placeholders = ids.map(() => "?").join(",");
    await db.prepare(`DELETE FROM jokes WHERE chat_id = ? AND id IN (${placeholders})`).bind(chatId, ...ids).run();
  }
}

// ---- Nicknames ----

export interface NicknameRow {
  user_id: number;
  chat_id: number;
  nickname: string;
  updated_at: number;
}

export async function getNickname(db: D1Database, chatId: number, userId: number): Promise<string | null> {
  const row = await db.prepare("SELECT nickname FROM nicknames WHERE chat_id = ? AND user_id = ?")
    .bind(chatId, userId).first<{ nickname: string }>();
  return row?.nickname ?? null;
}

export async function getAllNicknames(db: D1Database, chatId: number): Promise<NicknameRow[]> {
  const result = await db.prepare("SELECT user_id, chat_id, nickname, updated_at FROM nicknames WHERE chat_id = ?")
    .bind(chatId).all<NicknameRow>();
  return result.results ?? [];
}

export async function putNickname(db: D1Database, chatId: number, userId: number, nickname: string, updatedAt: number): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO nicknames (user_id, chat_id, nickname, updated_at) VALUES (?, ?, ?, ?)")
    .bind(userId, chatId, nickname, updatedAt).run();
}

// ---- Summaries ----

export interface SummaryRow {
  chat_id: number;
  text: string;
  updated_at: number;
}

export async function getSummary(db: D1Database, chatId: number): Promise<string> {
  const row = await db.prepare("SELECT text FROM summaries WHERE chat_id = ?").bind(chatId).first<{ text: string }>();
  return row?.text ?? "";
}

export async function putSummary(db: D1Database, chatId: number, text: string, updatedAt: number): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO summaries (chat_id, text, updated_at) VALUES (?, ?, ?)")
    .bind(chatId, text, updatedAt).run();
}

// ---- Settings ----

export async function getSetting<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function putSetting(db: D1Database, key: string, value: unknown): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .bind(key, JSON.stringify(value)).run();
}

// ---- Analytics ----

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

export async function getAnalytics(db: D1Database, chatId: number): Promise<AnalyticsSnapshot | null> {
  const row = await db.prepare("SELECT data, started_at FROM analytics WHERE chat_id = ?").bind(chatId).first<{ data: string; started_at: number }>();
  if (!row) return null;
  try {
    return JSON.parse(row.data) as AnalyticsSnapshot;
  } catch {
    return null;
  }
}

export async function putAnalytics(db: D1Database, chatId: number, snapshot: AnalyticsSnapshot): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO analytics (chat_id, data, started_at) VALUES (?, ?, ?)")
    .bind(chatId, JSON.stringify(snapshot), snapshot.startedAt).run();
}

// ---- Cleanup ----

export async function clearChatData(db: D1Database, chatId: number): Promise<void> {
  await db.prepare("DELETE FROM mood WHERE chat_id = ?").bind(chatId).run();
  await db.prepare("DELETE FROM activity WHERE chat_id = ?").bind(chatId).run();
  await db.prepare("DELETE FROM events WHERE chat_id = ?").bind(chatId).run();
  await db.prepare("DELETE FROM topics WHERE chat_id = ?").bind(chatId).run();
  await db.prepare("DELETE FROM jokes WHERE chat_id = ?").bind(chatId).run();
  await db.prepare("DELETE FROM nicknames WHERE chat_id = ?").bind(chatId).run();
  await db.prepare("DELETE FROM summaries WHERE chat_id = ?").bind(chatId).run();
  await db.prepare("DELETE FROM analytics WHERE chat_id = ?").bind(chatId).run();
}
