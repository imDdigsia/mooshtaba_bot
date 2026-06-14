/**
 * Probability-based engagement: decides whether the bot should respond
 * to a given message, and if so, *how* (full reply, short reaction,
 * emoji-only reaction, or start a new sub-thread). The goal is to feel
 * human — never answer 100% of the time.
 */
import type { Config } from "../config.js";
import type { MoodName } from "../types.js";
import { MOODS } from "../mood/moods.js";
import { clamp, pickRandom } from "../utils/util.js";

export type EngagementAction =
  | { kind: "ignore"; reason: string }
  | { kind: "react"; emojis: string[]; reason: string }
  | { kind: "reply"; mode: "full" | "short"; reason: string };

export interface EngagementContext {
  mood: MoodName;
  intensity: number; // 0..1
  recentActivity: number; // messages in last 10m
  chatType: "private" | "group" | "supergroup" | "channel";
  /** The message is addressed to the bot (mention or reply-to-bot). */
  isAddressed: boolean;
  hasMedia: boolean;
  isForward: boolean;
  messageLength: number;
  /** Configured chat id; we tighten probability for unknown channels. */
  chatId: number;
  /** Whitelisted chat ids from env; empty = allow all. */
  allowedChatIds: number[];
}

const LIGHT = ["👀", "🤔", "😏", "🙃", "✨", "🔥", "🫡"];
const EXCITED = ["🤩", "🔥", "💯", "🫨", "✨"];
const SLEEPY = ["😴", "💤", "🥱", "☕"];

function emojiForMood(mood: MoodName): string[] {
  switch (mood) {
    case "excited":
      return EXCITED;
    case "sleepy":
      return SLEEPY;
    case "dramatic":
      return ["🎭", "✨", "💫", "😩"];
    case "nostalgic":
      return ["🥹", "💭", "🌅"];
    case "suspicious":
      return ["🤨", "👀", "🚩"];
    case "chaotic":
      return ["🌀", "🧨", "💀"];
    case "curious":
      return ["🧐", "🔍"];
    case "impressed":
      return ["🤯", "👏", "🙌"];
    case "trump":
      return ["🇺🇸", "🏆", "📢", "💰", "🔥", "⭐"];
  }
}

export function decideEngagement(cfg: Config, ctx: EngagementContext): EngagementAction {
  // Private chats: always reply, with a light probability of being lazy.
  if (ctx.chatType === "private") {
    if (ctx.hasMedia) return { kind: "reply", mode: "full", reason: "private: media" };
    if (ctx.messageLength < 3) return { kind: "reply", mode: "short", reason: "private: tiny" };
    return { kind: "reply", mode: "full", reason: "private chat" };
  }

  // Whitelist gate (if configured)
  if (ctx.allowedChatIds.length > 0 && !ctx.allowedChatIds.includes(ctx.chatId)) {
    return { kind: "ignore", reason: "chat not whitelisted" };
  }

  // Direct trigger: always engage if the bot is mentioned or its message is replied to
  if (ctx.isAddressed) {
    return { kind: "reply", mode: "full", reason: "addressed directly" };
  }

  const mood = MOODS[ctx.mood];

  // Base probability of *some* engagement
  let p = 0.18;
  p += (mood.verbosity - 0.5) * 0.4; // -0.2..+0.2
  p += (ctx.intensity - 0.5) * 0.15; // mood intensity
  if (ctx.hasMedia) p += 0.15;
  if (ctx.isForward) p += 0.07;
  if (ctx.recentActivity > 30) p -= 0.1; // too noisy -> step back
  if (ctx.recentActivity < 4 && ctx.chatType !== "channel") p += 0.08; // quiet -> chime in
  if (mood.name === "sleepy") p -= 0.1;
  if (mood.name === "chaotic" || mood.name === "excited") p += 0.1;

  p = clamp(p, 0.02, 0.95);

  const roll = Math.random();
  if (roll > p) {
    // Sometimes *react* even if we don't reply (to feel present)
    if (Math.random() < 0.35) {
      return {
        kind: "react",
        emojis: [pickRandom(emojiForMood(mood.name)) ?? "👀"],
        reason: "ambient reaction",
      };
    }
    return { kind: "ignore", reason: `p=${p.toFixed(2)} roll=${roll.toFixed(2)}` };
  }

  // Decide reply vs. react
  if (Math.random() < 0.25) {
    return {
      kind: "react",
      emojis: [pickRandom(emojiForMood(mood.name)) ?? "👀"],
      reason: "lucky react",
    };
  }
  const short = Math.random() < mood.verbosity * 0.6 ? "short" : "full";
  return { kind: "reply", mode: short, reason: `p=${p.toFixed(2)}` };
}
