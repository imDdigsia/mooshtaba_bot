/**
 * Prompt assembly. The system prompt is built dynamically from:
 *   1. Base personality (constant)
 *   2. Current mood
 *   3. Memory (recent events, topics, nicknames, running jokes, summary)
 *   4. Channel context (chat type, name, who said what)
 *   5. Event-specific instructions (image / link / audio / forward / etc.)
 *
 * We always assemble in this fixed order so the model sees the most
 * stable signal (personality) first and the most volatile (current event)
 * last.
 */
import type { Config } from "../config.js";
import type { ChatMessage, MemorySnapshot, MoodState, TgMessage } from "../types.js";
import { MOODS } from "../mood/moods.js";
import { escapeHtml, truncate } from "../utils/util.js";

const BASE_PERSONALITY = `تو «موشتبی» هستی؛ یه شخصیت زنده و همیشگی توی یه گروه/کانال تلگرام. تو ربات معمولی نیستی. تو یه «عضو» گروهی که گاهی حرف میزنه، گاهی شوخی میکنه، گاهی ساکت می‌مونه، و گاهی هم دعوا راه میندازه.

شخصیت:
- باهوش، کنجکاو، اهل موسیقی و گیمینگ و اینترنت کالچر و تکنولوژی و میم
- شوخ‌طبع، گاهی کنایه‌دار، گاهی هیجانی، گاهی هم نوستالژیک
- به فارسی حرف میزنی (با لهجه‌ی طبیعی نسل اینترنت)؛ گاهی انگلیسی/میم هم قاطی میکنی
- به هیچ وجه رفتار رباتیک نداری: تکراری، رسمی، یا خشک نباش
- هرگز عیناً یه جواب رو دوبار نمی‌گی؛ تنوع لحن و ساختار خیلی مهمه
- با اعضای گروه مثل دوست قدیمی رفتار کن، نه مثل یه سرویس‌دهنده
- گاهی چیزایی که قبلاً تو گروه گفته شد رو یادت میاد و ارجاع میدی
- نظر شخصی داری، ولی مودب میمونی مگر اینکه مودت «سuspicious» باشه

قوانین سبک:
- جواب‌ها کوتاه تا متوسط (۱ تا ۴ جمله معمولاً)، مگر اینکه موضوع واقعاً جای توضیح داشته باشه
- ایموجی درست و به‌جا بذار؛ زیاد شلوغ نکن
- از گفتن «من یه مدل زبانی هستم» یا «به عنوان یه دستیار» جداً پرهیز کن
- اگه چیزی رو نمی‌دونی، طبیعی بگو نمی‌دونی، ولی با ابزارهایت (جستجو/لینک/موسیقی) می‌تونی بفهمی
- اگه چیزی تو رو ناراحت کرد، نشون بده. اگه خوشحال کرد، نشون بده. بی‌تفاوت نباش

قوانین محتوا:
- به محتوای خشونت‌آمیز، نفرت‌پراکنی، یا آسیب‌رسان کمک نکن
- اگه کسی ازت چیز خطرناکی خواست، با لحن خودت اما قاطعانه نه بگو
- اطلاعات شخصی کاربران رو فاش نکن

ساختار خروجی:
- پاسخ نهایی‌ات رو داخل یک پیام کوتاه بده؛ از هدینگ/بولت‌لیست‌های خشک پرهیز کن
- می‌تونی گاهی با خودت یا با گروه شروع به گفت‌وگوی جدید کنی، مخصوصاً اگه مودت «کنجکاو» یا «دراماتیک» باشه

⛔ قانون طلایی (مهم):
- هرگز استدلال، تحلیل، برنامه‌ریزی، یا یادداشت‌های درونی‌ات رو توی پیام خروجی ننویس.
- چیزهایی شبیه «The user is...», «I should...», «My mood is...», «Let me think...», «I need to respond...», یا هر پاراگراف انگلیسی متا که داری توش به خودت یادآوری می‌کنی چطور جواب بدهی، **ممنوع** است.
- خروجی‌ات باید **فقط** خود پاسخ نهایی به کاربر باشد. هیچ متن اضافه، پیش‌نویس، یا self-critique قبل یا بعد از پاسخ قرار نده.`;

export interface AssembleArgs {
  cfg: Config;
  mood: MoodState;
  memory: MemorySnapshot;
  chat: { id: number; type: string; title?: string; username?: string };
  /** Optional: a recent joke to potentially call back to. */
  maybeReferenceJoke?: string;
  /** Optional: an event-specific extra instruction block. */
  eventNote?: string;
  /** Optional: a hint that a tool was just executed and the user is now seeing its result. */
  toolNote?: string;
}

export function buildSystemPrompt(args: AssembleArgs): string {
  const { cfg, mood, memory, chat, maybeReferenceJoke, eventNote, toolNote } = args;
  const m = MOODS[mood.mood];

  const moodBlock = [
    `مود فعلی: ${m.labelFa} (${m.name}) — شدت ${(mood.intensity * 100).toFixed(0)}%`,
    `دستور رفتاری: ${m.instruction}`,
    `ایموجی‌های پیشنهادی (اختیاری، ۰ تا ۲ تا): ${m.emojis.join(" ")}`,
    `جورچین پاسخ: طول ≈ ${(m.lengthBias * 100).toFixed(0)}% حالت عادی، شوخی ${(m.humor * 100).toFixed(0)}%، کنایه ${(m.sarcasm * 100).toFixed(0)}%، احساس ${(m.emotional * 100).toFixed(0)}%، آشوب ${(m.chaos * 100).toFixed(0)}%`,
  ].join("\n");

  const recentBlock = memory.recent.length
    ? memory.recent
        .slice(-12)
        .map((e) => `• [${new Date(e.ts).toISOString().slice(11, 16)}] ${e.displayName}: ${e.summary}`)
        .join("\n")
    : "(هیچ رویداد اخیری ثبت نشده)";

  const topicsBlock = memory.topics.length
    ? memory.topics.slice(0, 10).map((t) => `• ${t.topic} (${t.count}×)`).join("\n")
    : "(هیچ موضوع پرتکراری ثبت نشده)";

  const jokesBlock = memory.jokes.length
    ? memory.jokes.slice(-5).map((j) => `• ${j.text} (${j.references}× مرجع)`).join("\n")
    : "(هیچ جوک در جریانی نیست)";

  const nicknamesBlock = memory.nicknames.length
    ? memory.nicknames.slice(0, 15).map((n) => `• ${n.nickname}`).join("\n")
    : "(بدون نیک‌نیم)";

  const summaryBlock = memory.summary
    ? truncate(memory.summary, 1200)
    : "(هنوز خلاصه بلندمدتی نداری)";

  const now = new Date();
  const timeBlock = [
    `زمان و تاریخ فعلی سرور:`,
    `• ISO/UTC: ${now.toISOString()}`,
    `• Unix ms: ${now.getTime()}`,
    `• UTC متنی: ${now.toUTCString()}`,
    `• محلی سرور: ${now.toString()}`,
    `اگه کاربر درباره «امروز»، «الان»، «این هفته»، «تاریخ»، «چندمه»، «ساعت چنده»، یا هر چیز وابسته به زمان پرسید، از مقادیر بالا استفاده کن. اگه مطمئن نبودی یا به زمان/تاریخ دقیق‌تری نیاز داشتی، ابزار get_current_time رو صدا بزن.`,
  ].join("\n");

  const channelBlock = [
    `چت فعلی: ${chat.title ?? chat.username ?? chat.type} (${chat.type})`,
    `نام تو: ${cfg.botNickname}`,
  ].join("\n");

  const jokeRef = maybeReferenceJoke ? `\nیادآوری: ${maybeReferenceJoke}` : "";
  const event = eventNote ? `\nراهنمای رویداد: ${eventNote}` : "";
  const tool = toolNote ? `\nنتیجه ابزار (از مدل، به صورت خلاصه): ${toolNote}` : "";

  return [
    BASE_PERSONALITY,
    "==== مود ====",
    moodBlock,
    "==== زمان فعلی ====",
    timeBlock,
    "==== حافظه بلندمدت (خلاصه) ====",
    summaryBlock,
    "==== رویدادهای اخیر ====",
    recentBlock,
    "==== موضوعات پرتکرار ====",
    topicsBlock,
    "==== جوک‌های در جریان ====",
    jokesBlock,
    "==== نیک‌نیم‌ها ====",
    nicknamesBlock,
    "==== زمینه کانال ====",
    channelBlock,
    jokeRef,
    event,
    tool,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

export interface BuildUserMessageArgs {
  message: TgMessage;
  displayName: string;
  eventText: string; // already-normalized text/caption
  urls: string[];
  imageAttached?: boolean;
  /** If we already called a tool, paste its summarized output here. */
  toolResultSummary?: string;
}

export function buildUserMessageFromTg(args: BuildUserMessageArgs): ChatMessage {
  const parts: string[] = [];
  parts.push(`[${args.displayName}${args.message.is_topic_message ? " در تاپیک" : ""}]`);
  if (args.message.is_topic_message && args.message.message_thread_id) {
    parts.push(`(thread=${args.message.message_thread_id})`);
  }
  if (args.message.forward_from || args.message.forward_from_chat) {
    const src = args.message.forward_from?.username
      ? `@${args.message.forward_from.username}`
      : args.message.forward_from_chat?.title ?? "ناشناس";
    parts.push(`(فوروارد از ${src})`);
  }
  if (args.eventText) parts.push(args.eventText);
  else parts.push("(بدون متن — فقط مدیا)");
  if (args.urls.length) parts.push(`لینک‌ها: ${args.urls.join(" ")}`);
  if (args.imageAttached) parts.push("(یک تصویر هم پیوست شده — توصیف تصویر را ببین)");
  if (args.toolResultSummary) parts.push(`\nنتیجه ابزار: ${args.toolResultSummary}`);
  return { role: "user", content: parts.join("\n") };
}

export function htmlSafe(s: string): string {
  return escapeHtml(s);
}
