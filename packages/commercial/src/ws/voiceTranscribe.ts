import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";

import { verifyAccess, JwtError, type AccessClaims } from "../auth/jwt.js";
import type { Logger } from "../logging/logger.js";
import { DEEPSEEK_UPSTREAM_ENDPOINT } from "../http/proxy/shared.js";

export const VOICE_WS_PATH = "/ws/voice-transcribe";

const DEFAULT_ASR_MODEL = "nova-3";
const DEFAULT_ASR_LANGUAGE = "zh-CN";
const DEFAULT_POLISH_MODEL = "deepseek-v4-flash";
const DEFAULT_MAX_SECONDS = 90;
const DEFAULT_MAX_AUDIO_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONTEXT_MESSAGES = 12;
const DEFAULT_MAX_CONTEXT_CHARS = 6_000;
const DEFAULT_MAX_CONTEXT_ITEM_CHARS = 1_000;
const DEFAULT_MAX_KEYTERMS = 50;
const DEFAULT_MAX_KEYTERM_CHARS = 80;
const DEFAULT_FINAL_WAIT_MS = 4_000;
const DEFAULT_DEEPGRAM_OPEN_TIMEOUT_MS = 8_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PER_USER = 1;
const DEFAULT_MAX_GLOBAL = 50;

const CLOSE_VOICE = {
  NORMAL: 1000,
  POLICY: 1008,
  TOO_BIG: 1009,
  INTERNAL: 1011,
  TRY_AGAIN_LATER: 1013,
} as const;

export interface VoiceContextMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

export interface VoiceStartPayload {
  mimeType: string;
  context: VoiceContextMessage[];
  keyterms: string[];
}

export interface VoicePolishResult {
  text: string;
  changed: boolean;
  confidence: number;
  skipped?: boolean;
}

type FetchLike = typeof fetch;

type DeepgramSocketFactory = (url: string, options: { headers: Record<string, string> }) => WebSocket;

export interface VoiceTranscribeDeps {
  jwtSecret: string | Uint8Array;
  deepgramApiKey?: string;
  deepseekApiKey?: string;
  asrModel?: string;
  asrLanguage?: string;
  voicePolishModel?: string;
  maxSeconds?: number;
  maxPerUser?: number;
  maxGlobal?: number;
  maxAudioFrameBytes?: number;
  finalWaitMs?: number;
  deepgramOpenTimeoutMs?: number;
  logger?: Logger;
  fetchImpl?: FetchLike;
  createDeepgramSocket?: DeepgramSocketFactory;
}

export interface VoiceTranscribeHandler {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  shutdown(reason?: string): Promise<void>;
  activeCount(): number;
}

function parseWsUrl(req: IncomingMessage): URL | null {
  const raw = req.url ?? "/";
  try { return new URL(raw, "http://placeholder"); } catch { return null; }
}

function extractBearerToken(req: IncomingMessage): string {
  const protoHeader = req.headers["sec-websocket-protocol"];
  if (typeof protoHeader === "string") {
    const protos = protoHeader.split(",").map((s) => s.trim());
    if (protos.includes("bearer") && protos.length >= 2) {
      return protos[protos.length - 1] ?? "";
    }
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string") {
    return authHeader.replace(/^Bearer\s+/i, "").trim();
  }
  return "";
}

function uidFromClaims(claims: AccessClaims): bigint {
  if (!/^[1-9][0-9]{0,19}$/.test(claims.sub)) {
    throw new TypeError(`bad uid in claims.sub: ${claims.sub}`);
  }
  return BigInt(claims.sub);
}

function rawDataLen(data: RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((acc, b) => acc + b.length, 0);
  return 0;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return "";
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  if (typeof data === "string") return Buffer.from(data);
  return Buffer.alloc(0);
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(payload)); } catch { /* noop */ }
}

function sendErrorFrame(ws: WebSocket, code: string, message: string): void {
  sendJson(ws, { type: "error", code, message });
}

function safeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.floor(value as number);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function normalizeMimeType(raw: unknown): string {
  if (typeof raw !== "string") return "audio/webm;codecs=opus";
  const v = raw.trim().toLowerCase();
  if (!v) return "audio/webm;codecs=opus";
  if (v.startsWith("audio/webm")) return "audio/webm;codecs=opus";
  if (v.startsWith("audio/ogg")) return "audio/ogg;codecs=opus";
  if (v.startsWith("audio/mp4")) return "audio/mp4";
  if (v.startsWith("audio/mpeg") || v.startsWith("audio/mp3")) return "audio/mpeg";
  return "audio/webm;codecs=opus";
}

function trimOneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function isHanChar(ch: string): boolean {
  return /^[\u3400-\u9fff]$/.test(ch);
}

function shouldJoinWithoutSpace(prev: string, next: string): boolean {
  if (!prev || !next) return true;
  if (/\s$/.test(prev) || /^\s/.test(next)) return true;
  if (/^[,.;:!?，。！？；：、）)\]}】》]/.test(next)) return true;
  if (/[，。！？；：、]$/.test(prev)) return true;
  if (/[（([{【《]$/.test(prev)) return true;
  const a = prev.at(-1) || "";
  const b = next.at(0) || "";
  return isHanChar(a) && isHanChar(b);
}

export function joinTranscriptSegments(parts: string[]): string {
  let out = "";
  for (const raw of parts) {
    const text = trimOneLine(raw);
    if (!text) continue;
    if (!out) {
      out = text;
      continue;
    }
    out += shouldJoinWithoutSpace(out, text) ? text : ` ${text}`;
  }
  return out.trim();
}

export function sanitizeVoiceStartPayload(raw: unknown): VoiceStartPayload {
  const src = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const context: VoiceContextMessage[] = [];
  let usedChars = 0;
  const rawContext = Array.isArray(src.context) ? src.context : [];
  for (const item of rawContext.slice(-DEFAULT_MAX_CONTEXT_MESSAGES)) {
    if (!item || typeof item !== "object") continue;
    const msg = item as Record<string, unknown>;
    const role = msg.role === "user" || msg.role === "assistant" || msg.role === "system"
      ? msg.role
      : "user";
    const textRaw = typeof msg.text === "string" ? msg.text : "";
    const text = trimOneLine(textRaw).slice(0, DEFAULT_MAX_CONTEXT_ITEM_CHARS);
    if (!text) continue;
    if (usedChars + text.length > DEFAULT_MAX_CONTEXT_CHARS) break;
    usedChars += text.length;
    context.push({ role, text });
  }

  const seen = new Set<string>();
  const keyterms: string[] = [];
  const rawKeyterms = Array.isArray(src.keyterms) ? src.keyterms : [];
  for (const item of rawKeyterms) {
    if (typeof item !== "string") continue;
    const term = trimOneLine(item).slice(0, DEFAULT_MAX_KEYTERM_CHARS);
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keyterms.push(term);
    if (keyterms.length >= DEFAULT_MAX_KEYTERMS) break;
  }

  return {
    mimeType: normalizeMimeType(src.mimeType),
    context,
    keyterms,
  };
}

export function buildDeepgramListenUrl(opts: {
  model?: string;
  language?: string;
  keyterms?: string[];
}): string {
  const url = new URL("wss://api.deepgram.com/v1/listen");
  url.searchParams.set("model", opts.model || DEFAULT_ASR_MODEL);
  url.searchParams.set("language", opts.language || DEFAULT_ASR_LANGUAGE);
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("endpointing", "300");
  url.searchParams.set("utterance_end_ms", "1000");
  for (const term of opts.keyterms || []) {
    url.searchParams.append("keyterm", term);
  }
  return url.toString();
}

function extractDeepgramTranscript(raw: unknown): {
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  confidence: number | null;
  start: number | null;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw as Record<string, unknown>;
  if (msg.type !== "Results") return null;
  const channel = msg.channel && typeof msg.channel === "object" ? msg.channel as Record<string, unknown> : null;
  const alternatives = Array.isArray(channel?.alternatives) ? channel.alternatives : [];
  const alt = alternatives[0] && typeof alternatives[0] === "object" ? alternatives[0] as Record<string, unknown> : null;
  const text = typeof alt?.transcript === "string" ? alt.transcript : "";
  return {
    text,
    isFinal: msg.is_final === true,
    speechFinal: msg.speech_final === true,
    confidence: safeNumber(alt?.confidence),
    start: safeNumber(msg.start),
  };
}

function extractContentText(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.content)) return "";
  return data.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n")
    .trim();
}

function firstJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export function parseVoicePolishText(raw: string, fallback: string): VoicePolishResult {
  try {
    const parsed = JSON.parse(firstJsonObject(raw)) as Record<string, unknown>;
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!text) return { text: fallback, changed: false, confidence: 0, skipped: true };
    const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5;
    return {
      text: text.slice(0, Math.max(4000, fallback.length * 2)),
      changed: parsed.changed === true && text !== fallback,
      confidence,
    };
  } catch {
    return { text: fallback, changed: false, confidence: 0, skipped: true };
  }
}

function buildPolishPrompt(input: {
  transcript: string;
  context: VoiceContextMessage[];
  keyterms: string[];
}): string {
  const context = input.context
    .map((m) => `${m.role}: ${m.text}`)
    .join("\n");
  const terms = input.keyterms.join("、");
  return [
    "你是 OpenClaude 的语音输入转写修正器。",
    "任务: 根据用户最近对话上下文和术语表，修正语音识别文本里的同音/近音错误、英文大小写、专业术语、数字格式和标点。",
    "严格规则:",
    "1. 不要改写用户意图，不要扩写，不要总结。",
    "2. 不要添加语音识别中完全缺失且无法从上下文高置信确认的信息。",
    "3. 保持中文自然口语输入，保留必要英文/缩写/产品名格式。",
    "4. 只输出 JSON，不要 Markdown。格式: {\"text\":\"修正后的文本\",\"changed\":true/false,\"confidence\":0到1}",
    "",
    `术语表: ${terms || "(无)"}`,
    "最近上下文:",
    context || "(无)",
    "",
    "语音识别原文:",
    input.transcript,
  ].join("\n");
}

function buildStreamingPolishPrompt(input: {
  transcript: string;
  context: VoiceContextMessage[];
  keyterms: string[];
}): string {
  const context = input.context
    .map((m) => `${m.role}: ${m.text}`)
    .join("\n");
  const terms = input.keyterms.join("、");
  return [
    "你是 OpenClaude 的语音输入转写修正器。",
    "根据最近上下文和术语表，修正语音识别文本里的同音/近音错误、英文大小写、专业术语、数字格式和标点。",
    "只输出修正后的最终文本本身，不要 JSON、不要 Markdown、不要解释。",
    "不要改写用户意图，不要扩写，不要总结。",
    "",
    `术语表: ${terms || "(无)"}`,
    "最近上下文:",
    context || "(无)",
    "",
    "语音识别原文:",
    input.transcript,
  ].join("\n");
}

function parseSseDeltaText(block: string): string {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") return "";
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return ""; }
  if (!parsed || typeof parsed !== "object") return "";
  const obj = parsed as Record<string, unknown>;
  const delta = obj.delta && typeof obj.delta === "object" ? obj.delta as Record<string, unknown> : null;
  const text = delta && typeof delta.text === "string" ? delta.text : "";
  return text;
}

async function polishTranscriptStream(input: {
  transcript: string;
  context: VoiceContextMessage[];
  keyterms: string[];
  apiKey?: string;
  model: string;
  fetchImpl: FetchLike;
  signal: AbortSignal;
  onDelta?: (text: string) => void;
}): Promise<VoicePolishResult | null> {
  const transcript = input.transcript.trim();
  if (!transcript || !input.apiKey) return null;

  const body = {
    model: input.model,
    max_tokens: 512,
    temperature: 0,
    thinking: { type: "disabled" },
    stream: true,
    system: "你只输出修正后的最终文本，不输出 JSON、Markdown 或解释。",
    messages: [
      { role: "user", content: buildStreamingPolishPrompt(input) },
    ],
  };

  let res: Response;
  try {
    res = await input.fetchImpl(DEEPSEEK_UPSTREAM_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch {
    return null;
  }
  if (!res.ok || !res.body) return null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let accumulated = "";
  let lastSent = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx = buffered.indexOf("\n\n");
      while (idx >= 0) {
        const block = buffered.slice(0, idx);
        buffered = buffered.slice(idx + 2);
        const delta = parseSseDeltaText(block);
        if (delta) {
          accumulated += delta;
          const visible = accumulated.replace(/^\s+/, "");
          if (visible && visible !== lastSent) {
            lastSent = visible;
            input.onDelta?.(visible);
          }
        }
        idx = buffered.indexOf("\n\n");
      }
    }
    const tail = decoder.decode().replace(/\r\n/g, "\n");
    if (tail) buffered += tail;
    if (buffered.trim()) {
      const delta = parseSseDeltaText(buffered);
      if (delta) accumulated += delta;
    }
  } catch {
    return null;
  } finally {
    try { reader.releaseLock(); } catch { /* noop */ }
  }

  const text = trimOneLine(accumulated);
  if (!text) return null;
  return {
    text: text.slice(0, Math.max(4000, transcript.length * 2)),
    changed: text !== transcript,
    confidence: 0.5,
  };
}

async function polishTranscriptOnce(input: {
  transcript: string;
  context: VoiceContextMessage[];
  keyterms: string[];
  apiKey?: string;
  model: string;
  fetchImpl: FetchLike;
  signal: AbortSignal;
}): Promise<VoicePolishResult> {
  const transcript = input.transcript.trim();
  if (!transcript) return { text: "", changed: false, confidence: 0, skipped: true };
  if (!input.apiKey) return { text: transcript, changed: false, confidence: 0, skipped: true };

  const body = {
    model: input.model,
    max_tokens: 512,
    temperature: 0,
    thinking: { type: "disabled" },
    system: "你只返回 JSON，不返回解释。",
    messages: [
      { role: "user", content: buildPolishPrompt(input) },
    ],
  };

  let res: Response;
  try {
    res = await input.fetchImpl(DEEPSEEK_UPSTREAM_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(body),
      signal: input.signal,
    });
  } catch {
    return { text: transcript, changed: false, confidence: 0, skipped: true };
  }
  if (!res.ok) return { text: transcript, changed: false, confidence: 0, skipped: true };
  const json = await res.json().catch(() => null);
  const text = extractContentText(json);
  if (!text) return { text: transcript, changed: false, confidence: 0, skipped: true };
  return parseVoicePolishText(text, transcript);
}

async function polishTranscript(input: {
  transcript: string;
  context: VoiceContextMessage[];
  keyterms: string[];
  apiKey?: string;
  model: string;
  fetchImpl: FetchLike;
  signal: AbortSignal;
  onDelta?: (text: string) => void;
}): Promise<VoicePolishResult> {
  const streamed = await polishTranscriptStream(input);
  if (streamed) return streamed;
  return polishTranscriptOnce(input);
}

class ActiveVoiceLimiter {
  private total = 0;
  private perUser = new Map<string, number>();

  constructor(
    private readonly maxPerUser: number,
    private readonly maxGlobal: number,
  ) {}

  tryAcquire(uid: bigint): boolean {
    const key = uid.toString();
    if (this.total >= this.maxGlobal) return false;
    if ((this.perUser.get(key) || 0) >= this.maxPerUser) return false;
    this.total += 1;
    this.perUser.set(key, (this.perUser.get(key) || 0) + 1);
    return true;
  }

  release(uid: bigint): void {
    const key = uid.toString();
    const next = (this.perUser.get(key) || 0) - 1;
    if (next <= 0) this.perUser.delete(key);
    else this.perUser.set(key, next);
    this.total = Math.max(0, this.total - 1);
  }

  count(): number { return this.total; }
}

export function createVoiceTranscribeHandler(deps: VoiceTranscribeDeps): VoiceTranscribeHandler {
  const wss = new WebSocketServer({ noServer: true, maxPayload: deps.maxAudioFrameBytes ?? DEFAULT_MAX_AUDIO_FRAME_BYTES });
  const sockets = new Set<WebSocket>();
  const log = deps.logger;
  const limiter = new ActiveVoiceLimiter(
    clampInt(deps.maxPerUser, DEFAULT_MAX_PER_USER, 1, 10),
    clampInt(deps.maxGlobal, DEFAULT_MAX_GLOBAL, 1, 500),
  );
  const maxSeconds = clampInt(deps.maxSeconds, DEFAULT_MAX_SECONDS, 10, 300);
  const maxAudioFrameBytes = deps.maxAudioFrameBytes ?? DEFAULT_MAX_AUDIO_FRAME_BYTES;
  const finalWaitMs = clampInt(deps.finalWaitMs, DEFAULT_FINAL_WAIT_MS, 500, 15_000);
  const deepgramOpenTimeoutMs = clampInt(deps.deepgramOpenTimeoutMs, DEFAULT_DEEPGRAM_OPEN_TIMEOUT_MS, 1000, 30_000);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const createDeepgramSocket = deps.createDeepgramSocket ?? ((url, options) => new WebSocket(url, options));

  const shutdown = async (reason = "shutdown"): Promise<void> => {
    for (const ws of [...sockets]) {
      try { ws.close(CLOSE_VOICE.INTERNAL, reason); } catch { /* noop */ }
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };

  const handleAuthenticated = (ws: WebSocket, req: IncomingMessage, uid: bigint, pendingMessages: Array<{ data: RawData; isBinary: boolean }>): void => {
    const connId = randomUUID();
    sockets.add(ws);
    let released = false;
    let started = false;
    let stopping = false;
    let finalized = false;
    let startPayload: VoiceStartPayload = { mimeType: "audio/webm;codecs=opus", context: [], keyterms: [] };
    let dg: WebSocket | null = null;
    let startTimer: NodeJS.Timeout | null = null;
    let openTimer: NodeJS.Timeout | null = null;
    let maxTimer: NodeJS.Timeout | null = null;
    let finalTimer: NodeJS.Timeout | null = null;
    let polishAbort: AbortController | null = null;
    let lastTranscript = "";
    const finalSegments = new Map<number, string>();

    const currentFinalText = (): string => {
      const segments = [...finalSegments.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, text]) => text)
        .filter(Boolean);
      return (joinTranscriptSegments(segments) || lastTranscript).trim();
    };

    const cleanup = (): void => {
      if (released) return;
      released = true;
      limiter.release(uid);
      sockets.delete(ws);
      if (startTimer) clearTimeout(startTimer);
      if (openTimer) clearTimeout(openTimer);
      if (maxTimer) clearTimeout(maxTimer);
      if (finalTimer) clearTimeout(finalTimer);
      try { polishAbort?.abort(); } catch { /* noop */ }
      if (dg && dg.readyState < WebSocket.CLOSING) {
        try { dg.close(); } catch { /* noop */ }
      }
    };

    const finish = async (reason: "deepgram_close" | "timeout" | "client_close"): Promise<void> => {
      if (finalized) return;
      finalized = true;
      if (finalTimer) clearTimeout(finalTimer);
      const rawText = currentFinalText();
      sendJson(ws, { type: "polish_start", rawText });
      polishAbort = new AbortController();
      const timeout = setTimeout(() => polishAbort?.abort(), 10_000);
      const result = await polishTranscript({
        transcript: rawText,
        context: startPayload.context,
        keyterms: startPayload.keyterms,
        apiKey: deps.deepseekApiKey,
        model: deps.voicePolishModel || DEFAULT_POLISH_MODEL,
        fetchImpl,
        signal: polishAbort.signal,
        onDelta: (text) => sendJson(ws, { type: "polish_delta", text, rawText }),
      }).finally(() => clearTimeout(timeout));
      sendJson(ws, {
        type: "polish",
        text: result.text,
        rawText,
        changed: result.changed,
        confidence: result.confidence,
        skipped: result.skipped === true,
        reason,
      });
      try { ws.close(CLOSE_VOICE.NORMAL, "done"); } catch { /* noop */ }
    };

    const scheduleFinalFallback = (): void => {
      if (finalTimer) clearTimeout(finalTimer);
      finalTimer = setTimeout(() => {
        void finish("timeout");
        if (dg && dg.readyState < WebSocket.CLOSING) {
          try { dg.close(); } catch { /* noop */ }
        }
      }, finalWaitMs);
    };

    const openDeepgram = (): void => {
      const url = buildDeepgramListenUrl({
        model: deps.asrModel || DEFAULT_ASR_MODEL,
        language: deps.asrLanguage || DEFAULT_ASR_LANGUAGE,
        keyterms: startPayload.keyterms,
      });
      dg = createDeepgramSocket(url, {
        headers: {
          "Authorization": `Token ${deps.deepgramApiKey}`,
          "Content-Type": startPayload.mimeType,
        },
      });
      openTimer = setTimeout(() => {
        sendErrorFrame(ws, "VOICE_UPSTREAM_TIMEOUT", "语音识别服务连接超时");
        try { ws.close(CLOSE_VOICE.INTERNAL, "voice upstream timeout"); } catch { /* noop */ }
      }, deepgramOpenTimeoutMs);

      dg.on("open", () => {
        if (openTimer) clearTimeout(openTimer);
        maxTimer = setTimeout(() => {
          sendErrorFrame(ws, "VOICE_MAX_DURATION", "单次语音输入时间过长");
          try { ws.close(CLOSE_VOICE.POLICY, "voice max duration"); } catch { /* noop */ }
          if (dg && dg.readyState === WebSocket.OPEN) {
            try { dg.send(JSON.stringify({ type: "CloseStream" })); } catch { /* noop */ }
          }
        }, maxSeconds * 1000);
        sendJson(ws, {
          type: "ready",
          model: deps.asrModel || DEFAULT_ASR_MODEL,
          language: deps.asrLanguage || DEFAULT_ASR_LANGUAGE,
          maxSeconds,
        });
      });

      dg.on("message", (data) => {
        let parsed: unknown;
        try { parsed = JSON.parse(rawDataToString(data)); } catch { return; }
        const result = extractDeepgramTranscript(parsed);
        if (!result) return;
        if (result.text) lastTranscript = result.text;
        if (result.isFinal && result.text) {
          finalSegments.set(result.start ?? finalSegments.size, result.text);
        }
        if (result.text) {
          sendJson(ws, {
            type: "transcript",
            text: result.text,
            finalText: currentFinalText(),
            isFinal: result.isFinal,
            speechFinal: result.speechFinal,
            confidence: result.confidence,
          });
        }
        if (stopping && result.isFinal) scheduleFinalFallback();
      });

      dg.on("close", () => {
        if (stopping) void finish("deepgram_close");
        else if (!finalized) {
          sendErrorFrame(ws, "VOICE_UPSTREAM_CLOSED", "语音识别服务已断开");
          try { ws.close(CLOSE_VOICE.INTERNAL, "voice upstream closed"); } catch { /* noop */ }
        }
      });
      dg.on("error", () => {
        if (!stopping && !finalized) {
          sendErrorFrame(ws, "VOICE_UPSTREAM_ERROR", "语音识别服务连接失败");
          try { ws.close(CLOSE_VOICE.INTERNAL, "voice upstream error"); } catch { /* noop */ }
        }
      });
    };

    const stopDeepgram = (): void => {
      if (stopping) return;
      stopping = true;
      if (maxTimer) clearTimeout(maxTimer);
      sendJson(ws, { type: "stopping", rawText: currentFinalText() });
      if (dg?.readyState === WebSocket.OPEN) {
        try { dg.send(JSON.stringify({ type: "CloseStream" })); } catch { /* noop */ }
      }
      scheduleFinalFallback();
    };

    const handleTextFrame = (data: RawData): void => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(rawDataToString(data)) as Record<string, unknown>; }
      catch {
        sendErrorFrame(ws, "BAD_JSON", "invalid control frame");
        try { ws.close(CLOSE_VOICE.POLICY, "bad json"); } catch { /* noop */ }
        return;
      }
      if (msg.type === "start") {
        if (started) {
          sendErrorFrame(ws, "BAD_SEQUENCE", "voice session already started");
          try { ws.close(CLOSE_VOICE.POLICY, "bad sequence"); } catch { /* noop */ }
          return;
        }
        if (!deps.deepgramApiKey) {
          sendErrorFrame(ws, "VOICE_NOT_CONFIGURED", "语音识别服务未配置");
          try { ws.close(CLOSE_VOICE.INTERNAL, "voice not configured"); } catch { /* noop */ }
          return;
        }
        if (startTimer) clearTimeout(startTimer);
        started = true;
        startPayload = sanitizeVoiceStartPayload(msg);
        openDeepgram();
        return;
      }
      if (msg.type === "stop") {
        stopDeepgram();
        return;
      }
      if (msg.type === "cancel") {
        try { ws.close(CLOSE_VOICE.NORMAL, "cancel"); } catch { /* noop */ }
        return;
      }
      sendErrorFrame(ws, "UNKNOWN_CONTROL", "unknown voice control frame");
    };

    const handleMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) {
        if (!started || !dg || dg.readyState !== WebSocket.OPEN || stopping) return;
        const bytes = rawDataLen(data);
        if (bytes > maxAudioFrameBytes) {
          sendErrorFrame(ws, "VOICE_FRAME_TOO_BIG", "audio frame too large");
          try { ws.close(CLOSE_VOICE.TOO_BIG, "audio frame too large"); } catch { /* noop */ }
          return;
        }
        try { dg.send(rawDataToBuffer(data), { binary: true }); } catch { /* noop */ }
        return;
      }
      handleTextFrame(data);
    };

    ws.on("message", handleMessage);
    ws.on("close", () => {
      if (started && !stopping && dg?.readyState === WebSocket.OPEN) {
        try { dg.send(JSON.stringify({ type: "CloseStream" })); } catch { /* noop */ }
      }
      cleanup();
    });
    ws.on("error", cleanup);

    startTimer = setTimeout(() => {
      if (started) return;
      sendErrorFrame(ws, "VOICE_START_TIMEOUT", "语音输入启动超时");
      try { ws.close(CLOSE_VOICE.POLICY, "voice start timeout"); } catch { /* noop */ }
    }, DEFAULT_START_TIMEOUT_MS);

    for (const m of pendingMessages) handleMessage(m.data, m.isBinary);
    log?.info("voice-transcribe: connected", { uid: uid.toString(), connId });
  };

  return {
    handleUpgrade(req, socket, head) {
      const url = parseWsUrl(req);
      if (!url || url.pathname !== VOICE_WS_PATH) return false;

      wss.handleUpgrade(req, socket, head, (ws) => {
        const pendingMessages: Array<{ data: RawData; isBinary: boolean }> = [];
        const onEarlyMessage = (data: RawData, isBinary: boolean): void => {
          pendingMessages.push({ data, isBinary });
        };
        ws.on("message", onEarlyMessage);

        void (async () => {
          const token = extractBearerToken(req);
          if (!token) {
            sendErrorFrame(ws, "UNAUTHORIZED", "missing token (bearer protocol or Authorization header)");
            try { ws.close(CLOSE_VOICE.POLICY, "unauthorized"); } catch { /* noop */ }
            return;
          }
          let claims: AccessClaims;
          try {
            claims = await verifyAccess(token, deps.jwtSecret);
          } catch (err) {
            if (err instanceof JwtError) sendErrorFrame(ws, "UNAUTHORIZED", "invalid or expired token");
            else sendErrorFrame(ws, "ERR_INTERNAL", "auth failure");
            try { ws.close(CLOSE_VOICE.POLICY, "unauthorized"); } catch { /* noop */ }
            return;
          }
          let uid: bigint;
          try { uid = uidFromClaims(claims); }
          catch {
            sendErrorFrame(ws, "UNAUTHORIZED", "bad uid in token");
            try { ws.close(CLOSE_VOICE.POLICY, "unauthorized"); } catch { /* noop */ }
            return;
          }
          if (!limiter.tryAcquire(uid)) {
            sendErrorFrame(ws, "VOICE_BUSY", "语音识别连接数过多，请稍后再试");
            try { ws.close(CLOSE_VOICE.TRY_AGAIN_LATER, "voice busy"); } catch { /* noop */ }
            return;
          }
          ws.off("message", onEarlyMessage);
          handleAuthenticated(ws, req, uid, pendingMessages);
        })();
      });
      return true;
    },
    shutdown,
    activeCount: () => limiter.count(),
  };
}
