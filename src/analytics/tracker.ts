/**
 * Lightweight analytics stored in D1 (SQLite).
 * We keep counters in a JSON snapshot for fast `/stats` reads.
 * Write coalescing: multiple increments per request collapse into one write.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { AnalyticsSnapshot } from "../types.js";
import type { Config } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { getAnalytics, putAnalytics } from "../db/d1.js";

export class Analytics {
  constructor(
    private readonly db: D1Database,
    private readonly chatId: number,
    private readonly cfg: Config,
  ) {}

  private _pending: AnalyticsSnapshot | null = null;
  private _dirty = false;

  async initIfNeeded(): Promise<void> {
    if (this._pending) return;
    const existing = await getAnalytics(this.db, this.chatId);
    if (existing) {
      this._pending = existing;
      return;
    }
    this._pending = {
      messagesSeen: 0,
      messagesAnswered: 0,
      reactionsOnly: 0,
      ignored: 0,
      toolCalls: 0,
      errors: 0,
      byMood: {},
      byKind: {},
      topTopics: [],
      searchCount: 0,
      startedAt: Date.now(),
    };
  }

  private async read(): Promise<AnalyticsSnapshot> {
    await this.initIfNeeded();
    if (this._pending) return this._pending;
    const existing = await getAnalytics(this.db, this.chatId);
    this._pending =
      existing ?? {
        messagesSeen: 0,
        messagesAnswered: 0,
        reactionsOnly: 0,
        ignored: 0,
        toolCalls: 0,
        errors: 0,
        byMood: {},
        byKind: {},
        topTopics: [],
        searchCount: 0,
        startedAt: Date.now(),
      };
    return this._pending;
  }

  private stage(s: AnalyticsSnapshot): void {
    this._pending = s;
    this._dirty = true;
  }

  async flush(): Promise<void> {
    if (!this._pending || !this._dirty) return;
    const s = this._pending;
    const log = createLogger(this.cfg, "analytics");
    try {
      await putAnalytics(this.db, this.chatId, s);
      this._dirty = false;
    } catch (err) {
      log.warn("flush_failed", { err: (err as Error).message });
    }
  }

  async incSeen(kind: string, mood: string): Promise<void> {
    const s = await this.read();
    s.messagesSeen += 1;
    s.byKind[kind] = (s.byKind[kind] ?? 0) + 1;
    s.byMood[mood] = (s.byMood[mood] ?? 0) + 1;
    this.stage(s);
  }

  async incAnswered(): Promise<void> {
    const s = await this.read();
    s.messagesAnswered += 1;
    this.stage(s);
  }

  async incReacted(): Promise<void> {
    const s = await this.read();
    s.reactionsOnly += 1;
    this.stage(s);
  }

  async incIgnored(): Promise<void> {
    const s = await this.read();
    s.ignored += 1;
    this.stage(s);
  }

  async incToolCall(): Promise<void> {
    const s = await this.read();
    s.toolCalls += 1;
    this.stage(s);
  }

  async incError(): Promise<void> {
    const s = await this.read();
    s.errors += 1;
    this.stage(s);
  }

  async incSearch(): Promise<void> {
    const s = await this.read();
    s.searchCount += 1;
    this.stage(s);
  }

  async recordTopics(topics: string[]): Promise<void> {
    if (topics.length === 0) return;
    const s = await this.read();
    const map = new Map<string, number>(s.topTopics.map((t) => [t.topic, t.count]));
    for (const t of topics) map.set(t, (map.get(t) ?? 0) + 1);
    s.topTopics = Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([topic, count]) => ({ topic, count }));
    this.stage(s);
  }

  async snapshot(): Promise<AnalyticsSnapshot> {
    return this.read();
  }
}
