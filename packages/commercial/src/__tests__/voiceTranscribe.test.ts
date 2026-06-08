import * as assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
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
      deepseekApiKey: "ds_secret",
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
});
