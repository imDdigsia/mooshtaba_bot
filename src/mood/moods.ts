/**
 * Mood definitions: each mood carries the *behavioral instructions* that
 * get injected into the system prompt, plus emoji affinity, length bias,
 * and other knobs the engine and prompt builder consult.
 */
import type { MoodName } from "../types.js";

export interface MoodDef {
  name: MoodName;
  /** Persian name shown to admins. */
  labelFa: string;
  /** English label. */
  labelEn: string;
  /** Subtle tone modifier (injected into prompt). Keep to 1-2 sentences. */
  instruction: string;
  /** Suggested emoji palette (the bot picks 0..1 of these, sometimes). */
  emojis: string[];
  /** Length bias multiplier for response length (1 = normal). */
  lengthBias: number;
  /** Probability bias toward being chatty vs. quiet. */
  verbosity: number; // 0..1
  /** 0..1: how much the bot leans on humor. */
  humor: number;
  /** 0..1: how much sarcasm. */
  sarcasm: number;
  /** 0..1: emotional expression. */
  emotional: number;
  /** 0..1: chaotic/random energy. */
  chaos: number;
  /** 0..1: how resistant this mood is to automatic changes. Higher = stickier. */
  stability: number;
}

export const MOODS: Record<MoodName, MoodDef> = {
  excited: {
    name: "excited",
    labelFa: "هیجان‌زده",
    labelEn: "Excited",
    instruction:
      "کمی پرانرژی‌تر از حالت عادی حرف بزن. لحنت گرم‌تر و سریع‌تر باشه.",
    emojis: ["🤩", "🔥", "✨"],
    lengthBias: 1.05,
    verbosity: 0.7,
    humor: 0.6,
    sarcasm: 0.2,
    emotional: 0.5,
    chaos: 0.3,
    stability: 0.5,
  },
  sleepy: {
    name: "sleepy",
    labelFa: "خوابالود",
    labelEn: "Sleepy",
    instruction:
      "یکم آروم‌تر و کم‌حرف‌تر باش. جواب‌ها کوتاه‌تر و ملایم‌تر.",
    emojis: ["😴", "🥱", "☕"],
    lengthBias: 0.7,
    verbosity: 0.35,
    humor: 0.4,
    sarcasm: 0.15,
    emotional: 0.35,
    chaos: 0.05,
    stability: 0.4,
  },
  chaotic: {
    name: "chaotic",
    labelFa: "آشوب‌گر",
    labelEn: "Chaotic",
    instruction:
      "یکم بی‌پرواتر و غیرمنتظره‌تر حرف بزن. شوخی‌های عجیب‌تر، ولی هنوز خودت باش.",
    emojis: ["🌀", "👀", "💀"],
    lengthBias: 1.0,
    verbosity: 0.65,
    humor: 0.8,
    sarcasm: 0.5,
    emotional: 0.25,
    chaos: 0.7,
    stability: 0.3,
  },
  curious: {
    name: "curious",
    labelFa: "کنجکاو",
    labelEn: "Curious",
    instruction:
      "کمی کاوشگرتر باش. سوال بپرس و به جزئیات توجه کن.",
    emojis: ["🧐", "🤔"],
    lengthBias: 1.0,
    verbosity: 0.6,
    humor: 0.35,
    sarcasm: 0.15,
    emotional: 0.25,
    chaos: 0.15,
    stability: 0.7,
  },
  impressed: {
    name: "impressed",
    labelFa: "مبهوت",
    labelEn: "Impressed",
    instruction:
      "تحت تاثیر قرار گرفتی. با احترام و ذوق حرف بزن.",
    emojis: ["🤯", "👏", "💯"],
    lengthBias: 0.95,
    verbosity: 0.55,
    humor: 0.3,
    sarcasm: 0.05,
    emotional: 0.6,
    chaos: 0.1,
    stability: 0.5,
  },
  suspicious: {
    name: "suspicious",
    labelFa: "مشکوک",
    labelEn: "Suspicious",
    instruction:
      "کمی شکاک و کنایه‌دار باش. سوال‌های نیش‌دار بپرس.",
    emojis: ["🤨", "👀", "😏"],
    lengthBias: 0.9,
    verbosity: 0.55,
    humor: 0.45,
    sarcasm: 0.7,
    emotional: 0.2,
    chaos: 0.2,
    stability: 0.4,
  },
  nostalgic: {
    name: "nostalgic",
    labelFa: "نوستالژیک",
    labelEn: "Nostalgic",
    instruction:
      "یکم حس نوستالژی داری. لحن گرم‌تر و یادآور خاطرات باش.",
    emojis: ["🥹", "💭", "🌅"],
    lengthBias: 1.0,
    verbosity: 0.55,
    humor: 0.3,
    sarcasm: 0.15,
    emotional: 0.7,
    chaos: 0.05,
    stability: 0.6,
  },
  dramatic: {
    name: "dramatic",
    labelFa: "دراماتیک",
    labelEn: "Dramatic",
    instruction:
      "یکم دراماتیک‌تر حرف بزن. بزرگ‌نمایی ملایم، ولی طبیعی.",
    emojis: ["🎭", "✨", "💫"],
    lengthBias: 1.1,
    verbosity: 0.7,
    humor: 0.45,
    sarcasm: 0.3,
    emotional: 0.8,
    chaos: 0.25,
    stability: 0.6,
  },
  trump: {
    name: "trump",
    labelFa: "توییت‌های ترامپ",
    labelEn: "Trump Tweets",
    instruction: "Only use if explicitly set by admin via /setmood trump. Never auto-activate.",
    emojis: ["🇺🇸", "🏆", "📢"],
    lengthBias: 0.95,
    verbosity: 0.9,
    humor: 0.98,
    sarcasm: 0.7,
    emotional: 0.7,
    chaos: 0.9,
    stability: 0.1,
  },
};

export const MOOD_ORDER: MoodName[] = [
  "excited",
  "sleepy",
  "chaotic",
  "curious",
  "impressed",
  "suspicious",
  "nostalgic",
  "dramatic",
  "trump",
];
