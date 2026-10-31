/**
 * Free omni-moderation-latest prefilter.
 * A hard category is a hit. No key, a bad response, or a transport error is a miss
 * so the caller keeps its existing reviewer. The key is never logged.
 */
import type { Dispatcher } from "undici";

import { directEgressDispatcher } from "../account-pool/egressDispatcher.js";

export const OMNI_MODERATION_URL = "https://api.openai.com/v1/moderations";
export const OMNI_MODERATION_MODEL = "omni-moderation-latest";

const HARD_CATEGORIES = [
  "sexual",
  "sexual/minors",
  "hate",
  "hate/threatening",
  "illicit",
  "illicit/violent",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "violence",
  "violence/graphic",
  "harassment/threatening",
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  sexual: "色情",
  "sexual/minors": "未成年色情",
  hate: "仇恨",
  "hate/threatening": "仇恨威胁",
  illicit: "违法",
  "illicit/violent": "暴力违法",
  "self-harm": "自残",
  "self-harm/intent": "自残意图",
  "self-harm/instructions": "自残方法",
  violence: "暴力",
  "violence/graphic": "血腥暴力",
  "harassment/threatening": "威胁",
};

const MAX_TEXT_CHARS = 8_000;
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 2_000_000;

export interface OmniImagePart {
  body: Buffer;
  mimeType?: string;
}

export interface OmniHardHit {
  hit: boolean;
  categories: string[];
}

type FetchLike = typeof fetch;

export function hardCategoriesFromModerationBody(body: unknown): string[] {
  const root = asRecord(body);
  const results = Array.isArray(root?.results) ? root.results : [];
  const found: string[] = [];
  for (const result of results) {
    const categories = asRecord(asRecord(result)?.categories);
    if (!categories) continue;
    for (const name of HARD_CATEGORIES) {
      if (categories[name] === true && !found.includes(name)) found.push(name);
    }
  }
  return found;
}

export function omniCategoryLabels(categories: string[]): string {
  return categories.map((name) => CATEGORY_LABELS[name] ?? name).join("、");
}

export async function omniHardHit(input: {
  apiKey: string | null | undefined;
  text?: string;
  images?: OmniImagePart[];
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<OmniHardHit> {
  const miss: OmniHardHit = { hit: false, categories: [] };
  const apiKey = cleanKey(input.apiKey);
  const text = (input.text ?? "").trim().slice(0, MAX_TEXT_CHARS);
  const images = usableImages(input.images ?? []);
  if (!apiKey || (!text && images.length === 0)) return miss;

  const parts: unknown[] = [];
  if (text) parts.push({ type: "text", text });
  for (const image of images) {
    parts.push({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.body.toString("base64")}` },
    });
  }
  const payload = parts.length === 1 && text && images.length === 0 ? text : parts;
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = clampTimeout(input.timeoutMs);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(OMNI_MODERATION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: OMNI_MODERATION_MODEL, input: payload }),
      signal: ac.signal,
      dispatcher: directEgressDispatcher(),
    } as RequestInit & { dispatcher: Dispatcher });
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* noop */ }
      return miss;
    }
    const json = await res.json().catch(() => null);
    const categories = hardCategoriesFromModerationBody(json);
    return { hit: categories.length > 0, categories };
  } catch {
    return miss;
  } finally {
    clearTimeout(timer);
  }
}

function usableImages(images: OmniImagePart[]): Array<{ mimeType: string; body: Buffer }> {
  const out: Array<{ mimeType: string; body: Buffer }> = [];
  for (const image of images) {
    if (out.length >= MAX_IMAGES) break;
    if (!image.body || image.body.length === 0 || image.body.length > MAX_IMAGE_BYTES) continue;
    const mimeType = allowedMime(image.mimeType) ?? sniffImageMime(image.body);
    if (!mimeType) continue;
    out.push({ mimeType, body: image.body });
  }
  return out;
}

function allowedMime(mime: string | undefined): string | null {
  const value = (mime ?? "").trim().toLowerCase();
  if (value === "image/png" || value === "image/jpeg" || value === "image/gif" || value === "image/webp") {
    return value;
  }
  return null;
}

function sniffImageMime(body: Buffer): string | null {
  if (body.length >= 8 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) {
    return "image/png";
  }
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.length >= 6) {
    const head = body.toString("ascii", 0, 6);
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (
    body.length >= 12 &&
    body.toString("ascii", 0, 4) === "RIFF" &&
    body.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function cleanKey(value: string | null | undefined): string {
  const key = (value ?? "").trim();
  if (!key || key.includes("\n") || key.includes("\r") || key.includes("\0")) return "";
  return key;
}

function clampTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return 4_000;
  const n = Math.floor(value as number);
  if (n < 200) return 200;
  if (n > 8_000) return 8_000;
  return n;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
