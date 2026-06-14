/**
 * Image analysis helper. Telegram photos are accessed via getFile, which
 * returns a `file_path` we can turn into a public URL using the bot
 * token. We fetch the bytes and base64 them so the model provider doesn't
 * need to fetch arbitrary URLs (more reliable, works behind firewalls).
 *
 * If the image is too large, we fall back to passing the URL (some model
 * providers can fetch it themselves).
 */
import type { Config } from "../config.js";
import type { ChatContentPart } from "../types.js";
import { getFile, TgApiError } from "../telegram/api.js";
import { fetchImageAsDataUrl } from "../ai/client.js";
import { fetchWithRetry } from "../utils/fetch.js";
import { telegramFileUrl } from "../config.js";

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB cap for base64 embedding

export interface ImagePrepResult {
  parts: ChatContentPart[];
  source: "data_url" | "url" | "none";
  bytes?: number;
  mime?: string;
}

export async function prepareImageParts(
  cfg: Config,
  fileId: string,
): Promise<ImagePrepResult> {
  let filePath: string | undefined;
  let fileSize: number | undefined;
  try {
    const f = await getFile(cfg, fileId);
    filePath = f.file_path;
    fileSize = f.file_size;
  } catch (err) {
    if (err instanceof TgApiError) {
      return { parts: [], source: "none" };
    }
    throw err;
  }
  if (!filePath) return { parts: [], source: "none" };

  const url = telegramFileUrl(cfg.telegramToken, filePath);
  if (fileSize && fileSize <= MAX_BYTES) {
    const part = await fetchImageAsDataUrl(url, MAX_BYTES);
    if (part) {
      return { parts: [part], source: "data_url", bytes: fileSize, mime: "image/jpeg" };
    }
  }
  // Try to fetch & base64 anyway
  const part = await fetchImageAsDataUrl(url, MAX_BYTES);
  if (part) {
    return { parts: [part], source: "data_url" };
  }
  // Last resort: hand the URL to the model provider
  return {
    parts: [{ type: "image_url", image_url: { url, detail: "low" } }],
    source: "url",
  };
}

/** Fetch any Telegram file and return its bytes (cap by maxBytes). */
export async function fetchTelegramFile(
  cfg: Config,
  fileId: string,
  maxBytes = 8 * 1024 * 1024,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  let filePath: string | undefined;
  try {
    const f = await getFile(cfg, fileId);
    filePath = f.file_path;
  } catch {
    return null;
  }
  if (!filePath) return null;
  const url = telegramFileUrl(cfg.telegramToken, filePath);
  try {
    const res = await fetchWithRetry(url, { timeoutMs: 10_000, retries: 1 });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) return null;
    const mime = res.headers.get("content-type") || guessMime(filePath);
    return { bytes: buf, mime };
  } catch {
    return null;
  }
}

function guessMime(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "m4a") return "audio/mp4";
  if (ext === "ogg" || ext === "oga") return "audio/ogg";
  if (ext === "opus") return "audio/ogg";
  return "application/octet-stream";
}
