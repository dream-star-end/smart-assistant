import * as assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { WebSocket } from "ws";

import { signAccess } from "../auth/jwt.js";
import {
  VOICE_WS_PATH,
  buildDeepgramListenUrl,
  createVoiceTranscribeHandler,
  joinTranscriptSegments,
  parseVoicePolishText,
  sanitizeVoiceStartPayload,
} from "../ws/voiceTranscribe.js";

const SECRET = "voice-test-secret-voice-test-secret-32";
const voiceSource = readFileSync(resolve(import.meta.dirname, "..", "ws", "voiceTranscribe.ts"), "utf-8");
const openHandlers: Array<{ shutdown(): Promise<void> }> = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  while (openHandlers.length) await openHandlers.pop()!.shutdown();
});

async function makeToken(sub = "123"): Promise<string> {
  return (await signAccess({ sub, role: "user" }, SECRET)).token;
}

async function listenWith(handler: ReturnType<typeof createVoiceTranscribeHandler>): Promise<string> {
  openHandlers.push(handler);
  const server = createServer();
  servers.push(server);
  server.on("upgrade", (req, socket, head) => {
    if (!handler.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return `ws://127.0.0.1:${addr.port}`;
}

function recvJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(String(data))));
  });
}

function streamResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(ctrl) {
      for (const chunk of chunks) ctrl.enqueue(enc.encode(chunk));
      ctrl.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("voiceTranscribe helpers", () => {
  test("sanitizes context and keyterms within bounded budgets", () => {
    const raw = {
      mimeType: "audio/webm; codecs=opus",
      context: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `消息${i} `.repeat(200) })),
      keyterms: ["OpenClaude", "openclaude", "DeepSeek V4 Flash", "\nVLBI\t", "x".repeat(200)],
    };
    const got = sanitizeVoiceStartPayload(raw);
    assert.equal(got.mimeType, "audio/webm;codecs=opus");
    assert.ok(got.context.length <= 12);
    assert.ok(got.context.every((m) => m.text.length <= 1000));
    assert.deepEqual(got.keyterms.slice(0, 3), ["OpenClaude", "DeepSeek V4 Flash", "VLBI"]);
    assert.equal(got.keyterms.at(-1)?.length, 80);
  });

  test("builds Deepgram Nova-3 URL with repeated keyterm and no raw-audio encoding params", () => {
    const url = new URL(buildDeepgramListenUrl({ model: "nova-3", language: "zh-CN", keyterms: ["VieVS", "GJBZ 171-2013"] }));
    assert.equal(url.protocol, "wss:");
    assert.equal(url.hostname, "api.deepgram.com");
    assert.equal(url.searchParams.get("model"), "nova-3");
    assert.equal(url.searchParams.get("language"), "zh-CN");
    assert.deepEqual(url.searchParams.getAll("keyterm"), ["VieVS", "GJBZ 171-2013"]);
    assert.equal(url.searchParams.has("encoding"), false);
    assert.equal(url.searchParams.has("sample_rate"), false);
  });

  test("parses strict DeepSeek polish JSON and falls back on invalid output", () => {
    assert.deepEqual(
      parseVoicePolishText('{"text":"OpenClaude worktree","changed":true,"confidence":0.92}', "raw"),
      { text: "OpenClaude worktree", changed: true, confidence: 0.92 },
    );
    assert.deepEqual(
      parseVoicePolishText("not json", "raw text"),
      { text: "raw text", changed: false, confidence: 0, skipped: true },
    );
  });

  test("joins final Deepgram segments without corrupting English or Chinese text", () => {
    assert.equal(joinTranscriptSegments(["hello", "world"]), "hello world");
    assert.equal(joinTranscriptSegments(["改商业版", "把"]), "改商业版把");
    assert.equal(joinTranscriptSegments(["DeepSeek", "V4 Flash", "模型"]), "DeepSeek V4 Flash 模型");
    assert.equal(joinTranscriptSegments(["你好", "，", "OpenClaude"]), "你好，OpenClaude");
  });

  test("guards prewarmed Deepgram sessions before first audio", () => {
    assert.match(voiceSource, /const DEFAULT_NO_AUDIO_TIMEOUT_MS = 20_000/, "prewarmed upstream sessions should have a bounded no-audio lifetime");
    assert.match(voiceSource, /const noAudioTimeoutMs = clampInt\(deps\.noAudioTimeoutMs, DEFAULT_NO_AUDIO_TIMEOUT_MS, 5_000, 60_000\)/, "no-audio timeout should be configurable but bounded");
    assert.match(voiceSource, /noAudioTimer = setTimeout\(\(\) => \{[\s\S]*VOICE_NO_AUDIO_TIMEOUT/, "Deepgram ready should arm a no-audio timeout");
    assert.match(voiceSource, /if \(!receivedAudio\) \{[\s\S]*startMaxTimer\(\)/, "recording max duration should start on the first audio frame");
  });
});

describe("voiceTranscribe websocket", () => {
  test("returns false for non voice websocket paths", () => {
    const h = createVoiceTranscribeHandler({ jwtSecret: SECRET });
    openHandlers.push(h);
    const req = { url: "/ws/user-chat-bridge", headers: {} } as any;
    assert.equal(h.handleUpgrade(req, {} as any, Buffer.alloc(0)), false);
  });

  test("rejects missing bearer token without accepting query-token auth", async () => {
    const h = createVoiceTranscribeHandler({ jwtSecret: SECRET });
    const base = await listenWith(h);
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}?token=leaky`);
    const msg = await recvJson(ws);
    assert.equal(msg.type, "error");
    assert.equal(msg.code, "UNAUTHORIZED");
  });

  test("authenticated start without Deepgram key returns VOICE_NOT_CONFIGURED", async () => {
    const h = createVoiceTranscribeHandler({ jwtSecret: SECRET });
    const base = await listenWith(h);
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}`, ["bearer", await makeToken()]);
    ws.on("open", () => ws.send(JSON.stringify({ type: "start", mimeType: "audio/webm;codecs=opus" })));
    const msg = await recvJson(ws);
    assert.equal(msg.type, "error");
    assert.equal(msg.code, "VOICE_NOT_CONFIGURED");
  });

  test("connects Deepgram with Authorization header and WebM content type", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    class FakeDeepgram extends EventEmitter {
      readyState: number = WebSocket.CONNECTING;
      send() {}
      close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
    }
    let fake: FakeDeepgram;
    const h = createVoiceTranscribeHandler({
      jwtSecret: SECRET,
      deepgramApiKey: "dg_secret",
      openCodeGoApiKey: "og_secret",
      createDeepgramSocket: (url, options) => {
        capturedUrl = url;
        capturedHeaders = options.headers;
        fake = new FakeDeepgram();
        setImmediate(() => { fake.readyState = WebSocket.OPEN; fake.emit("open"); });
        return fake as unknown as WebSocket;
      },
    });
    const base = await listenWith(h);
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}`, ["bearer", await makeToken()]);
    ws.on("open", () => ws.send(JSON.stringify({ type: "start", mimeType: "audio/webm;codecs=opus", keyterms: ["OpenClaude"] })));
    const msg = await recvJson(ws);
    assert.equal(msg.type, "ready");
    assert.equal(capturedHeaders.Authorization, "Token dg_secret");
    assert.equal(capturedHeaders["Content-Type"], "audio/webm;codecs=opus");
    const url = new URL(capturedUrl);
    assert.equal(url.searchParams.get("keyterm"), "OpenClaude");
    assert.equal(url.searchParams.has("encoding"), false);
    ws.close();
  });

  test("closes prewarmed Deepgram sockets when no audio arrives", async () => {
    class FakeDeepgram extends EventEmitter {
      readyState: number = WebSocket.CONNECTING;
      send() {}
      close() {
        if (this.readyState === WebSocket.CLOSED) return;
        this.readyState = WebSocket.CLOSED;
        this.emit("close");
      }
    }
    const h = createVoiceTranscribeHandler({
      jwtSecret: SECRET,
      deepgramApiKey: "dg_secret",
      openCodeGoApiKey: "og_secret",
      noAudioTimeoutMs: 5_000,
      createDeepgramSocket: () => {
        const fake = new FakeDeepgram();
        setImmediate(() => { fake.readyState = WebSocket.OPEN; fake.emit("open"); });
        return fake as unknown as WebSocket;
      },
    });
    const base = await listenWith(h);
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}`, ["bearer", await makeToken()]);
    ws.on("open", () => ws.send(JSON.stringify({ type: "start", mimeType: "audio/webm;codecs=opus" })));
    assert.equal((await recvJson(ws)).type, "ready");
    const msg = await recvJson(ws);
    assert.equal(msg.type, "error");
    assert.equal(msg.code, "VOICE_NO_AUDIO_TIMEOUT");
  });

  test("streams plain polish_delta frames before the final authoritative polish", async () => {
    class FakeDeepgram extends EventEmitter {
      readyState: number = WebSocket.CONNECTING;
      send(data?: unknown) {
        if (typeof data !== "string" || !data.includes("CloseStream")) return;
        this.emit("message", JSON.stringify({
          type: "Results",
          is_final: true,
          speech_final: true,
          start: 0,
          channel: { alternatives: [{ transcript: "晚上好亚，你在干什么", confidence: 0.87 }] },
        }));
        this.close();
      }
      close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
    }

    const h = createVoiceTranscribeHandler({
      jwtSecret: SECRET,
      deepgramApiKey: "dg_secret",
      openCodeGoApiKey: "og_secret",
      createDeepgramSocket: () => {
        const fake = new FakeDeepgram();
        setImmediate(() => { fake.readyState = WebSocket.OPEN; fake.emit("open"); });
        return fake as unknown as WebSocket;
      },
      fetchImpl: async (url, init) => {
        assert.equal(String(url), "https://opencode.ai/zen/go/v1/messages");
        const headers = (init?.headers ?? {}) as Record<string, string>;
        assert.equal(headers["x-api-key"], "og_secret");
        assert.equal(headers.Authorization, undefined);
        const body = JSON.parse(String(init?.body || "{}"));
        assert.equal(body.stream, true);
        assert.match(body.system, /不输出 JSON/);
        return streamResponse([
          `event: content_block_delta\r\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "晚上好呀" } })}\r\n\r\n`,
          `event: content_block_delta\r\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "，你在干什么？" } })}\r\n\r\n`,
          "event: message_stop\r\ndata: {\"type\":\"message_stop\"}\r\n\r\n",
        ]);
      },
    });
    const base = await listenWith(h);
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}`, ["bearer", await makeToken()]);
    ws.on("open", () => ws.send(JSON.stringify({ type: "start", mimeType: "audio/webm;codecs=opus" })));
    assert.equal((await recvJson(ws)).type, "ready");
    const framesP = new Promise<Record<string, unknown>[]>((resolve) => {
      const frames: Record<string, unknown>[] = [];
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        frames.push(msg);
        if (msg.type === "polish") resolve(frames);
      });
    });
    ws.send(JSON.stringify({ type: "stop" }));

    const frames = await framesP;
    const deltas = frames.filter((m) => m.type === "polish_delta");
    assert.ok(deltas.length >= 1, "expected at least one streaming polish_delta frame");
    assert.equal(deltas.at(-1)?.text, "晚上好呀，你在干什么？");
    assert.doesNotMatch(String(deltas.at(-1)?.text), /[{}]/, "polish_delta must not expose JSON fragments");
    const final = frames.at(-1);
    assert.equal(final?.type, "polish");
    assert.equal(final?.text, "晚上好呀，你在干什么？");
    assert.equal(final?.changed, true);
  });

  test("gpt-transcribe posts the buffered clip and does not open Deepgram", async () => {
    const seen: string[] = [];
    let deepgramOpened = false;
    const h = createVoiceTranscribeHandler({
      jwtSecret: SECRET,
      deepgramApiKey: "dg_secret",
      openAiApiKey: "sk-test-not-a-real-key-9876",
      logger: {
        trace() {},
        debug() {},
        info(msg, fields) { seen.push(`${msg} ${JSON.stringify(fields ?? {})}`); },
        warn(msg, fields) { seen.push(`${msg} ${JSON.stringify(fields ?? {})}`); },
        error(msg, fields) { seen.push(`${msg} ${JSON.stringify(fields ?? {})}`); },
        child() { return this; },
      },
      createDeepgramSocket: () => {
        deepgramOpened = true;
        throw new Error("deepgram should not open");
      },
      fetchImpl: async (url, init) => {
        assert.equal(String(url), "https://api.openai.com/v1/audio/transcriptions");
        assert.doesNotMatch(String(url), /sk-test/);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        assert.equal(headers.Authorization, "Bearer sk-test-not-a-real-key-9876");
        assert.equal(headers["Content-Type"], undefined);
        assert.equal((init as { dispatcher?: unknown }).dispatcher == null, false);
        const form = init?.body;
        assert.ok(form instanceof FormData);
        assert.equal(form.get("model"), "gpt-transcribe");
        assert.equal(form.get("response_format"), "json");
        assert.equal(form.get("language"), "zh");
        assert.equal(form.get("prompt"), "OpenClaude");
        const file = form.get("file");
        assert.ok(file instanceof Blob);
        assert.equal((file as File).name, "audio.webm");
        assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "helloworld");
        return new Response(JSON.stringify({ text: "你好世界" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const base = await listenWith(h);
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}`, ["bearer", await makeToken()]);
    ws.on("open", () => ws.send(JSON.stringify({
      type: "start",
      mimeType: "audio/webm;codecs=opus",
      keyterms: ["OpenClaude"],
    })));
    const ready = await recvJson(ws);
    assert.equal(ready.type, "ready");
    assert.equal(ready.model, "gpt-transcribe");
    ws.send(Buffer.from("hello"));
    ws.send(Buffer.from("world"));
    const framesP = new Promise<Record<string, unknown>[]>((resolve) => {
      const frames: Record<string, unknown>[] = [];
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        frames.push(msg);
        if (msg.type === "polish" || msg.type === "error") resolve(frames);
      });
    });
    ws.send(JSON.stringify({ type: "stop" }));
    const frames = await framesP;
    assert.equal(deepgramOpened, false);
    assert.equal(frames.some((m) => m.type === "stopping"), true);
    const transcript = frames.find((m) => m.type === "transcript");
    assert.equal(transcript?.text, "你好世界");
    assert.equal(transcript?.isFinal, true);
    const polish = frames.at(-1);
    assert.equal(polish?.type, "polish");
    assert.equal(polish?.text, "你好世界");
    assert.equal(polish?.skipped, true);
    assert.equal(seen.join("\n").includes("sk-test-not-a-real-key-9876"), false);
  });

  test("uses the session resolver and ignores a static key when the pool has no usable key", async () => {
    let deepgramOpened = false;
    const h = createVoiceTranscribeHandler({
      jwtSecret: SECRET,
      deepgramApiKey: "dg_secret",
      openAiApiKey: "sk-static-should-not-be-used",
      resolveOpenAiApiKey: async () => null,
      createDeepgramSocket: (url, options) => {
        deepgramOpened = true;
        assert.equal(options.headers.Authorization, "Token dg_secret");
        assert.doesNotMatch(url, /sk-static/);
        const fake = new EventEmitter() as EventEmitter & { readyState: number; close: () => void };
        fake.readyState = WebSocket.CONNECTING;
        fake.close = () => { fake.readyState = WebSocket.CLOSED; fake.emit("close"); };
        setImmediate(() => { fake.readyState = WebSocket.OPEN; fake.emit("open"); });
        return fake as unknown as WebSocket;
      },
    });
    const base = await listenWith(h);
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}`, ["bearer", await makeToken()]);
    ws.on("open", () => ws.send(JSON.stringify({ type: "start", mimeType: "audio/webm;codecs=opus" })));
    assert.equal((await recvJson(ws)).type, "ready");
    assert.equal(deepgramOpened, true);
    ws.close();
  });

  test("prefers a resolved OpenAI key over Deepgram", async () => {
    let deepgramOpened = false;
    let seenAuth = "";
    const h = createVoiceTranscribeHandler({
      jwtSecret: SECRET,
      deepgramApiKey: "dg_secret",
      openAiApiKey: "sk-static-should-not-be-used",
      resolveOpenAiApiKey: async () => "sk-pool-not-a-real-key",
      createDeepgramSocket: () => {
        deepgramOpened = true;
        throw new Error("deepgram should not open");
      },
      fetchImpl: async (_url, init) => {
        seenAuth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
        return new Response("nope", { status: 500 });
      },
    });
    const base = await listenWith(h);
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}`, ["bearer", await makeToken()]);
    ws.on("open", () => ws.send(JSON.stringify({ type: "start", mimeType: "audio/webm;codecs=opus" })));
    assert.equal((await recvJson(ws)).type, "ready");
    ws.send(Buffer.from("audio"));
    ws.send(JSON.stringify({ type: "stop" }));
    const frames: Record<string, unknown>[] = [];
    const error = await new Promise<Record<string, unknown>>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        frames.push(msg);
        if (msg.type === "error" || msg.type === "polish") resolve(msg);
      });
    });
    assert.equal(error.type, "error");
    assert.equal(error.code, "VOICE_UPSTREAM_ERROR");
    assert.equal(frames.some((m) => m.type === "polish"), false);
    assert.equal(deepgramOpened, false);
    assert.equal(seenAuth, "Bearer sk-pool-not-a-real-key");
  });

  test("blank or broken OpenAI key keeps VOICE_NOT_CONFIGURED when Deepgram is unset", async () => {
    const h = createVoiceTranscribeHandler({
      jwtSecret: SECRET,
      openAiApiKey: "sk-test\nsecret",
      fetchImpl: async () => {
        throw new Error("paid api should not be called");
      },
    });
    const base = await listenWith(h);
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}`, ["bearer", await makeToken()]);
    ws.on("open", () => ws.send(JSON.stringify({ type: "start", mimeType: "audio/webm;codecs=opus" })));
    const msg = await recvJson(ws);
    assert.equal(msg.type, "error");
    assert.equal(msg.code, "VOICE_NOT_CONFIGURED");
  });

  test("lookup failure falls through to Deepgram and does not call OpenAI", async () => {
    let deepgramOpened = false;
    const h = createVoiceTranscribeHandler({
      jwtSecret: SECRET,
      deepgramApiKey: "dg_secret",
      resolveOpenAiApiKey: async () => {
        throw new Error("db down");
      },
      createDeepgramSocket: () => {
        deepgramOpened = true;
        const fake = new EventEmitter() as EventEmitter & { readyState: number; close: () => void };
        fake.readyState = WebSocket.CONNECTING;
        fake.close = () => { fake.readyState = WebSocket.CLOSED; fake.emit("close"); };
        setImmediate(() => { fake.readyState = WebSocket.OPEN; fake.emit("open"); });
        return fake as unknown as WebSocket;
      },
      fetchImpl: async () => {
        throw new Error("paid api should not be called");
      },
    });
    const base = await listenWith(h);
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}`, ["bearer", await makeToken()]);
    ws.on("open", () => ws.send(JSON.stringify({ type: "start", mimeType: "audio/webm;codecs=opus" })));
    assert.equal((await recvJson(ws)).type, "ready");
    assert.equal(deepgramOpened, true);
    ws.close();
  });

  test("openai ready arms the no-audio timeout without calling the paid api", async () => {
    let called = false;
    const h = createVoiceTranscribeHandler({
      jwtSecret: SECRET,
      openAiApiKey: "sk-test-not-a-real-key-9876",
      noAudioTimeoutMs: 5_000,
      fetchImpl: async () => {
        called = true;
        throw new Error("paid api should not be called");
      },
    });
    const base = await listenWith(h);
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}`, ["bearer", await makeToken()]);
    ws.on("open", () => ws.send(JSON.stringify({ type: "start", mimeType: "audio/webm;codecs=opus" })));
    assert.equal((await recvJson(ws)).type, "ready");
    const msg = await recvJson(ws);
    assert.equal(msg.type, "error");
    assert.equal(msg.code, "VOICE_NO_AUDIO_TIMEOUT");
    assert.equal(called, false);
  });

  test("rejects an openai clip that exceeds the buffer cap before any upload", async () => {
    let called = false;
    const h = createVoiceTranscribeHandler({
      jwtSecret: SECRET,
      openAiApiKey: "sk-test-not-a-real-key-9876",
      maxBufferedAudioBytes: 1024,
      fetchImpl: async () => {
        called = true;
        throw new Error("paid api should not be called");
      },
    });
    const base = await listenWith(h);
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}`, ["bearer", await makeToken()]);
    ws.on("open", () => ws.send(JSON.stringify({ type: "start", mimeType: "audio/webm;codecs=opus" })));
    assert.equal((await recvJson(ws)).type, "ready");
    ws.send(Buffer.alloc(600));
    ws.send(Buffer.alloc(600));
    const msg = await recvJson(ws);
    assert.equal(msg.type, "error");
    assert.equal(msg.code, "VOICE_AUDIO_TOO_LARGE");
    assert.equal(called, false);
  });

  test("stop with no audio does not call gpt-transcribe", async () => {
    let called = false;
    const h = createVoiceTranscribeHandler({
      jwtSecret: SECRET,
      openAiApiKey: "sk-test-not-a-real-key-9876",
      fetchImpl: async () => {
        called = true;
        throw new Error("paid api should not be called");
      },
    });
    const base = await listenWith(h);
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}`, ["bearer", await makeToken()]);
    ws.on("open", () => ws.send(JSON.stringify({ type: "start", mimeType: "audio/webm;codecs=opus" })));
    assert.equal((await recvJson(ws)).type, "ready");
    const framesP = new Promise<Record<string, unknown>[]>((resolve) => {
      const frames: Record<string, unknown>[] = [];
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        frames.push(msg);
        if (msg.type === "polish" || msg.type === "error") resolve(frames);
      });
    });
    ws.send(JSON.stringify({ type: "stop" }));
    const frames = await framesP;
    assert.equal(called, false);
    assert.equal(frames.at(-1)?.type, "polish");
    assert.equal(frames.at(-1)?.text, "");
    assert.equal(frames.at(-1)?.skipped, true);
  });
});

const indexSource = readFileSync(resolve(import.meta.dirname, "..", "index.ts"), "utf-8");

test("voice handler resolves the openai pool key per session", () => {
  assert.match(
    indexSource,
    /resolveOpenAiApiKey:\s*\(\)\s*=>\s*selectOpenAiPlatformKey\("voice-transcribe"\)/,
  );
});
