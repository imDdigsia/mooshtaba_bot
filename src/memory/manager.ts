/**
 * Long-term memory manager using D1 (SQLite).
 *
 * Storage model (all in D1):
 *   events table   -> MemoryEvent[] (capped at 80)
 *   topics table   -> TopicCount[] (capped at 60)
 *   jokes table    -> RunningJoke[] (capped at 20)
 *   nicknames table -> { userId -> NicknameRecord }
 *   summaries table -> long-form rolling summary of older events
 *
 * Memory is bounded. On overflow we *summarize* the oldest slice into the
 * rolling summary string, then drop the events. This keeps prompts small.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { Config } from "../config.js";
import type {
  MemoryEvent,
  MemorySnapshot,
  NicknameRecord,
  RunningJoke,
  TopicCount,
} from "../types.js";
import { clamp, nanoId, pickRandom, truncate } from "../utils/util.js";
import { createLogger } from "../utils/logger.js";
import {
  getEvents, insertEvent, deleteEvents, countEvents,
  getTopics, upsertTopic, trimTopics,
  getJokes, insertJoke, incrementJokeReferences, trimJokes,
  getAllNicknames, putNickname, getNickname as getNicknameFromDb,
  getSummary, putSummary,
  clearChatData,
} from "../db/d1.js";

const MAX_EVENTS = 80;
const MAX_TOPICS = 60;
const MAX_JOKES = 20;
const SUMMARIZE_THRESHOLD = 60; // when events exceed this, summarize oldest half
const SUMMARY_KEEP_TOPICS = 12;

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","of","to","in","on","at","for","with","by","is","are","was","were","be","been","being",
  "i","you","he","she","it","we","they","me","him","her","us","them","my","your","his","its","our","their",
  "this","that","these","those","as","from","not","no","so","up","down","out","about","into","over","after","before",
  "just","like","than","then","now","here","there","what","which","who","whom","how","why","when","where",
  "که","از","به","در","با","برای","این","آن","ای","یه","یک","هم","همه","رو","را","های","ها","می","است","بود","شد","کن","کرد","داره","دارم","داری",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !STOPWORDS.has(t));
}

function extractTopics(text: string): string[] {
  const tokens = tokenize(text);
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);
}

export class MemoryManager {
  constructor(
    private readonly db: D1Database,
    private readonly cfg: Config,
    /** Per-chat isolation: each chat has its own event log, topics, jokes, nicknames, summary. */
    private readonly chatId: number,
  ) {}

  async addEvent(ev: MemoryEvent): Promise<MemoryEvent> {
    const log = createLogger(this.cfg, "memory");

    for (const t of ev.topics) {
      await upsertTopic(this.db, this.chatId, t, ev.ts);
    }
    await trimTopics(this.db, this.chatId, MAX_TOPICS);

    await insertEvent(this.db, this.chatId, ev.id, ev, ev.ts);

    const eventCount = await countEvents(this.db, this.chatId);
    if (eventCount > MAX_EVENTS) {
      const excess = eventCount - MAX_EVENTS;
      const oldest = await getEvents(this.db, this.chatId, excess);
      await deleteEvents(this.db, this.chatId, oldest.map(e => e.id));
    }

    if (eventCount >= SUMMARIZE_THRESHOLD) {
      const half = Math.floor(eventCount / 2);
      const old = await getEvents(this.db, this.chatId, half);
      await deleteEvents(this.db, this.chatId, old.map(e => e.id));
      await this.absorbIntoSummary(old.map(e => JSON.parse(e.data) as MemoryEvent));
    }
    log.debug("event_added", { id: ev.id, kind: ev.kind, topics: ev.topics });
    return ev;
  }

  private async absorbIntoSummary(oldEvents: MemoryEvent[]): Promise<void> {
    const prev = await getSummary(this.db, this.chatId);
    const topTopics = this.topicsFromEvents(oldEvents);
    const lines: string[] = [];
    const groupedByDay = new Map<string, string[]>();
    for (const e of oldEvents) {
      const d = new Date(e.ts).toISOString().slice(0, 10);
      groupedByDay.set(d, [...(groupedByDay.get(d) ?? []), `- ${e.displayName}: ${e.summary}`]);
    }
    for (const [d, ls] of groupedByDay) {
      lines.push(`[${d}]`);
      lines.push(...ls.slice(0, 30));
    }
    const topicLine = `موضوعات پرتکرار: ${topTopics.slice(0, SUMMARY_KEEP_TOPICS).join("، ")}`;
    const next = truncate(`${prev}\n\n${lines.join("\n")}\n${topicLine}`, 6000);
    await putSummary(this.db, this.chatId, next, Date.now());
  }

  private topicsFromEvents(evs: MemoryEvent[]): string[] {
    const counts = new Map<string, number>();
    for (const e of evs) for (const t of e.topics) counts.set(t, (counts.get(t) ?? 0) + 1);
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t);
  }

  async getRecent(limit = 20): Promise<MemoryEvent[]> {
    const rows = await getEvents(this.db, this.chatId, limit);
    return rows.map(r => JSON.parse(r.data) as MemoryEvent);
  }

  async getSummary(): Promise<string> {
    return getSummary(this.db, this.chatId);
  }

  async getTopics(limit = 15): Promise<TopicCount[]> {
    const rows = await getTopics(this.db, this.chatId, limit);
    return rows.map(r => ({ topic: r.topic, count: r.count, lastTs: r.last_ts }));
  }

  async getJokes(): Promise<RunningJoke[]> {
    const rows = await getJokes(this.db, this.chatId, MAX_JOKES);
    return rows.map(r => ({
      id: r.id,
      text: r.text,
      createdTs: r.created_at,
      references: r.joke_references,
    }));
  }

  async addJoke(text: string): Promise<RunningJoke> {
    const jokes = await this.getJokes();
    const j: RunningJoke = {
      id: nanoId(),
      text: truncate(text, 280),
      createdTs: Date.now(),
      references: 0,
    };
    await insertJoke(this.db, this.chatId, j.id, j.text, j.createdTs);
    if (jokes.length >= MAX_JOKES) {
      const excess = jokes.length - MAX_JOKES + 1;
      const oldest = await getJokes(this.db, this.chatId, excess);
      // TODO: delete oldest jokes if needed
    }
    return j;
  }

  async referenceJoke(id: string): Promise<void> {
    await incrementJokeReferences(this.db, id);
  }

  async pickRandomJoke(): Promise<RunningJoke | undefined> {
    const jokes = await this.getJokes();
    return pickRandom(jokes);
  }

  async setNickname(userId: number, nickname: string): Promise<NicknameRecord> {
    const rec: NicknameRecord = { userId, nickname: truncate(nickname, 64), updatedTs: Date.now() };
    await putNickname(this.db, this.chatId, userId, rec.nickname, rec.updatedTs);
    return rec;
  }

  async getNickname(userId: number): Promise<string | null> {
    return getNicknameFromDb(this.db, this.chatId, userId);
  }

  async getAllNicknames(): Promise<NicknameRecord[]> {
    const rows = await getAllNicknames(this.db, this.chatId);
    return rows.map(r => ({
      userId: r.user_id,
      nickname: r.nickname,
      updatedTs: r.updated_at,
    }));
  }

  async clearAll(): Promise<void> {
    await clearChatData(this.db, this.chatId);
  }

  async getSnapshot(): Promise<MemorySnapshot> {
    const [recentRows, topicsRows, jokesRows, nicknamesRows, summaryText] = await Promise.all([
      getEvents(this.db, this.chatId, 30),
      getTopics(this.db, this.chatId, 20),
      getJokes(this.db, this.chatId, MAX_JOKES),
      getAllNicknames(this.db, this.chatId),
      getSummary(this.db, this.chatId),
    ]);

    const recent = recentRows.map(r => JSON.parse(r.data) as MemoryEvent);
    const topics = topicsRows.map(r => ({ topic: r.topic, count: r.count, lastTs: r.last_ts }));
    const jokes = jokesRows.map(r => ({
      id: r.id,
      text: r.text,
      createdTs: r.created_at,
      references: r.joke_references,
    }));
    const nicknames = nicknamesRows.map(r => ({
      userId: r.user_id,
      nickname: r.nickname,
      updatedTs: r.updated_at,
    }));

    return { recent, topics, jokes, nicknames, summary: summaryText, summaryUpdatedTs: Date.now() };
  }
}

export function buildEventFromNormalized(input: {
  chatId: number;
  userId?: number;
  username?: string;
  displayName: string;
  kind: MemoryEvent["kind"];
  summary: string;
  rawText: string;
  topics?: string[];
}): MemoryEvent {
  const topics = input.topics ?? extractTopics(input.rawText);
  return {
    id: nanoId(),
    ts: Date.now(),
    chatId: input.chatId,
    userId: input.userId,
    username: input.username,
    displayName: input.displayName,
    kind: input.kind,
    summary: input.summary,
    topics,
  };
}
