/**
 * Mood engine. Stores the current mood in D1 and rotates it over time
 * based on:
 *   - Time of day (sleepy at night, excited in the morning, etc.)
 *   - Recent channel activity
 *   - Random variation
 *   - Special events
 *
 * The mood is *not* changed on every single message; we throttle updates
 * so it doesn't feel jittery.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { Config } from "../config.js";
import type { MoodName, MoodState } from "../types.js";
import { MOOD_ORDER, MOODS } from "./moods.js";
import { clamp, pickRandom } from "../utils/util.js";
import { createLogger } from "../utils/logger.js";
import { getHourInTz } from "../config.js";
import { getMood, putMood, getActivity, putActivity } from "../db/d1.js";

const MIN_HOLD_MS = 60 * 60 * 1000; // never re-roll sooner than 60 minutes
const RECENT_ACTIVITY_WINDOW_MS = 10 * 60 * 1000;

function defaultMoodForHour(hour: number): MoodName {
  if (hour >= 0 && hour < 6) return "sleepy";
  if (hour >= 6 && hour < 11) return "excited";
  if (hour >= 11 && hour < 14) return "curious";
  if (hour >= 14 && hour < 18) return "chaotic";
  if (hour >= 18 && hour < 22) return "dramatic";
  return "nostalgic";
}

function weightedPick(exclude?: MoodName, timezone?: string): MoodName {
  const hour = getHourInTz(timezone ?? "Asia/Tehran");
  const preferred = defaultMoodForHour(hour);
  const counts: Record<string, number> = {};
  for (const m of MOOD_ORDER) {
    counts[m] = 1;
    if (m === preferred) counts[m] += 2;
    if (Math.random() < 0.05) counts[m] += 1;
    if (m === exclude) counts[m] *= 0.15;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const m of MOOD_ORDER) {
    r -= counts[m] ?? 0;
    if (r <= 0) return m;
  }
  return preferred;
}

export interface ActivitySample {
  ts: number;
  count: number;
}

export class MoodEngine {
  constructor(
    private readonly db: D1Database,
    private readonly cfg: Config,
    /** Per-chat isolation: each chat (group, channel, or DM) has its own mood. */
    private readonly chatId: number,
    private readonly timezone: string = "Asia/Tehran",
  ) {}

  async getCurrent(): Promise<MoodState> {
    const row = await getMood(this.db, this.chatId);
    if (row) {
      try {
        const state = JSON.parse(row.state) as MoodState;
        if (state.mood && MOODS[state.mood]) return state;
      } catch {
        // fall through to default
      }
    }
    const init: MoodState = {
      mood: defaultMoodForHour(getHourInTz(this.timezone)),
      intensity: 0.6,
      reason: "initial default for time of day",
      updatedAt: Date.now(),
    };
    await putMood(this.db, this.chatId, init, init.updatedAt);
    return init;
  }

  async setMood(mood: MoodName, reason = "manual", intensity = 0.7): Promise<MoodState> {
    if (!MOODS[mood]) throw new Error(`unknown mood: ${mood}`);
    const state: MoodState = {
      mood,
      intensity: clamp(intensity, 0, 1),
      reason,
      updatedAt: Date.now(),
    };
    await putMood(this.db, this.chatId, state, state.updatedAt);
    return state;
  }

  /**
   * Re-evaluate the mood if it's been held long enough. Influenced by:
   *   - Time of day
   *   - Recent activity volume (more activity -> more excited/chaotic)
   *   - Random chance to drift
   * Returns the (possibly unchanged) current state.
   */
  async tick(activity: ActivitySample): Promise<MoodState> {
    const log = createLogger(this.cfg, "mood");
    const cur = await this.getCurrent();
    const age = Date.now() - cur.updatedAt;
    if (age < MIN_HOLD_MS) return cur;

    // Build weighted candidate set
    const candidates: MoodName[] = [...MOOD_ORDER];
    const weights = new Map<MoodName, number>();
    for (const m of candidates) weights.set(m, 1);

    // Time-of-day preference
    const hourMood = defaultMoodForHour(getHourInTz(this.timezone));
    weights.set(hourMood, (weights.get(hourMood) ?? 1) + 2);

    // Activity influence — subtle, not dominant
    const recent = activity.count;
    if (recent >= 20) {
      weights.set("excited", (weights.get("excited") ?? 1) + 1);
      weights.set("chaotic", (weights.get("chaotic") ?? 1) + 0.5);
    } else if (recent <= 2) {
      weights.set("sleepy", (weights.get("sleepy") ?? 1) + 1);
      weights.set("nostalgic", (weights.get("nostalgic") ?? 1) + 0.5);
    }

    // Strong inertia: keep current mood much more likely
    weights.set(cur.mood, (weights.get(cur.mood) ?? 1) + 5);

    const total = Array.from(weights.values()).reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let chosen: MoodName = cur.mood;
    for (const m of candidates) {
      r -= weights.get(m) ?? 0;
      if (r <= 0) {
        chosen = m;
        break;
      }
    }

    if (chosen === cur.mood) {
      const newIntensity = clamp(cur.intensity + (Math.random() - 0.5) * 0.1, 0.2, 1);
      if (Math.abs(newIntensity - cur.intensity) < 0.05) return cur;
      const drifted: MoodState = {
        ...cur,
        intensity: newIntensity,
        updatedAt: Date.now(),
      };
      await putMood(this.db, this.chatId, drifted, drifted.updatedAt);
      return drifted;
    }

    const next: MoodState = {
      mood: chosen,
      intensity: 0.65 + Math.random() * 0.3,
      reason: `tick (hour=${getHourInTz(this.timezone)}, recent=${recent}, prev=${cur.mood})`,
      updatedAt: Date.now(),
    };
    await putMood(this.db, this.chatId, next, next.updatedAt);
    log.info("mood_changed", { from: cur.mood, to: chosen, reason: next.reason });
    return next;
  }

  /** Activity tracker: single-row counter per chat. */
  async recordActivity(): Promise<number> {
    const now = Date.now();
    const windowStart = now - RECENT_ACTIVITY_WINDOW_MS;
    const row = await getActivity(this.db, this.chatId);
    let count = 1;
    if (row && row.window_start > windowStart) {
      count = row.count + 1;
    }
    await putActivity(this.db, this.chatId, now, count);
    return count;
  }

  async recentCount(now = Date.now()): Promise<number> {
    const row = await getActivity(this.db, this.chatId);
    if (!row || row.window_start <= now - RECENT_ACTIVITY_WINDOW_MS) return 0;
    return row.count;
  }
}
