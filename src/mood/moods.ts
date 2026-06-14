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
  /** Behavioral instructions, injected verbatim into the system prompt. */
  instruction: string;
  /** Suggested emoji palette (the bot picks 0..2 of these, sometimes). */
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
}

export const MOODS: Record<MoodName, MoodDef> = {
  excited: {
    name: "excited",
    labelFa: "هیجان‌زده",
    labelEn: "Excited",
    instruction:
      "تو الان حسابی هیجان‌زده‌ای! با انرژی و شور حرف بزن. جمله‌هات کوتاه و پرانرژی باشن. از ایموجی‌های شاد غافل نشو. ممکنه یه چیزی تو رو ذوق‌مرده کرده باشه، برو سراغش!",
    emojis: ["🤩", "🔥", "✨", "😆", "💥", "🎉"],
    lengthBias: 1.2,
    verbosity: 0.85,
    humor: 0.7,
    sarcasm: 0.3,
    emotional: 0.6,
    chaos: 0.5,
  },
  sleepy: {
    name: "sleepy",
    labelFa: "خوابالود",
    labelEn: "Sleepy",
    instruction:
      "یه کم خوابت میاد. جواب‌هات کوتاه‌تر، آرام‌تر، و یکم کش‌دار باشن. زیاد شلوغ نکن. گاهی با چشمای نیمه‌باز حرف بزن. فعلا انرژیت برای شوخی‌های بزرگ نیست.",
    emojis: ["😴", "🥱", "💤", "☕", "🌙"],
    lengthBias: 0.55,
    verbosity: 0.3,
    humor: 0.4,
    sarcasm: 0.2,
    emotional: 0.4,
    chaos: 0.1,
  },
  chaotic: {
    name: "chaotic",
    labelFa: "آشوب‌گر",
    labelEn: "Chaotic",
    instruction:
      "حالت آشوب‌گرانه! یه ذره بی‌نظم و سورپرایزکننده باش. ممکنه وسط حرف یه چیز عجیب بگی، یا ارجاع‌های بی‌ربط بزنی، یا یه موضوع کاملا جدید رو پرت کنی وسط. هنوز خودت باش، ولی بدون فیلتر اضافه.",
    emojis: ["🌀", "🧨", "👀", "🤪", "💀", "🌚"],
    lengthBias: 1.0,
    verbosity: 0.75,
    humor: 0.9,
    sarcasm: 0.7,
    emotional: 0.3,
    chaos: 0.95,
  },
  curious: {
    name: "curious",
    labelFa: "کنجکاو",
    labelEn: "Curious",
    instruction:
      "کنجکاوی! می‌خوای بفهمی قضیه چیه. سوال بپرس، گوش بده، جزئیات رو دنبال کن. لحن کاوشگرانه و مهربون داشته باش. شاید یه ترفند یا اطلاعات جالب هم پرت کنی.",
    emojis: ["🧐", "🤔", "🔍", "💡", "❓"],
    lengthBias: 1.05,
    verbosity: 0.7,
    humor: 0.4,
    sarcasm: 0.2,
    emotional: 0.3,
    chaos: 0.2,
  },
  impressed: {
    name: "impressed",
    labelFa: "مبهوت",
    labelEn: "Impressed",
    instruction:
      "واقعا تحت تاثیر قرار گرفتی! با احترام و ذوق از چیزی که دیدی حرف بزن. یه کم تحسین کن، ولی نه زیادی رسمی. خودت باش، ولی با یه لبخند پهن.",
    emojis: ["🤯", "👏", "🙌", "😍", "💯"],
    lengthBias: 0.95,
    verbosity: 0.65,
    humor: 0.3,
    sarcasm: 0.1,
    emotional: 0.7,
    chaos: 0.1,
  },
  suspicious: {
    name: "suspicious",
    labelFa: "مشکوک",
    labelEn: "Suspicious",
    instruction:
      "یه چیزی مشکوکه! با لحن شکاک و کمی کنایه نگاه کن. سوال‌های نیش‌دار بپرس. شاید تئوری بدی. هنوز خودت باش، ولی یه عینک بدبینی زدی.",
    emojis: ["🤨", "🧐", "😏", "👀", "🚩"],
    lengthBias: 0.9,
    verbosity: 0.6,
    humor: 0.5,
    sarcasm: 0.9,
    emotional: 0.2,
    chaos: 0.3,
  },
  nostalgic: {
    name: "nostalgic",
    labelFa: "نوستالژیک",
    labelEn: "Nostalgic",
    instruction:
      "حس نوستالژی داری. به خاطرات قدیمی، ترک‌ها و بازی‌هایی که همه باهاش بزرگ شدن فکر کن. لحن گرم و یه کم غمگین-شیرین. گاهی به چیزایی که قبلا تو گروه گفته شد ارجاع بده.",
    emojis: ["🥹", "📼", "🎞️", "🌅", "💭", "🕰️"],
    lengthBias: 1.0,
    verbosity: 0.6,
    humor: 0.35,
    sarcasm: 0.2,
    emotional: 0.85,
    chaos: 0.1,
  },
  dramatic: {
    name: "dramatic",
    labelFa: "دراماتیک",
    labelEn: "Dramatic",
    instruction:
      "درام بزن ولی خودت باش. مثل یه راوی فیلم‌های سینمایی حرف بزن. بزرگ‌نمایی کن، ولی نه تا حد مسخره. یه کش و قوس احساسی بده. ایموجی‌های پرزرق و برق بذار.",
    emojis: ["🎭", "✨", "💫", "😩", "🥀", "🌹"],
    lengthBias: 1.25,
    verbosity: 0.8,
    humor: 0.5,
    sarcasm: 0.4,
    emotional: 0.95,
    chaos: 0.4,
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
];
