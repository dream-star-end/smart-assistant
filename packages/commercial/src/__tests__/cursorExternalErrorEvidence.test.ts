/** Real route -> relay error frame -> planner -> FS. No PG or model network. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import protobuf from "protobufjs";
import { CursorSandRelay, classifyRelayTerminalCode } from "@openclaude/gateway";
import type { AccountRow, CursorTokenSnapshot } from "../account-pool/store.js";
import type { ModelPricing, PricingCache } from "../billing/pricing.js";
import type { ProxyIdentity } from "../auth/proxyIdentity.js";
import { createLogger } from "../logging/logger.js";
import { makeCursorExternalRoute } from "../http/proxy/cursorExternal.js";
import { openCursorExternalApiOutbox } from "../billing/cursorExternalApiOutbox.js";

const MODEL = "cursor-fable-5.1-high";
const quiet = createLogger({ level: "error", out: () => undefined });
const ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const proto = protobuf.loadSync(path.join(ROOT, "packages/gateway/src/engine/cursorSandInference.proto"));
const streamResponse = proto.lookupType("aiserver.v1.InferenceStreamResponse");
function envelope(payload: Uint8Array, flags = 0): Buffer {
  const bytes = Buffer.alloc(5 + payload.length);
  bytes[0] = flags; bytes.writeUInt32BE(payload.length, 1); Buffer.from(payload).copy(bytes, 5);
  return bytes;
}
function frame(field: string, value: unknown): Buffer {
  return envelope(streamResponse.encode(streamResponse.fromObject({ [field]: value })).finish());
}
class TestResponse extends EventEmitter {
  statusCode = 200; headersSent = false; writableEnded = false;
  writableNeedDrain = false; destroyed = false; chunks: string[] = [];
  setHeader(): this { return this; }
  writeHead(status: number): this { this.statusCode = status; this.headersSent = true; return this; }
  write(chunk: string | Buffer): boolean { this.headersSent = true; this.chunks.push(String(chunk)); return true; }
  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.chunks.push(String(chunk));
    this.headersSent = true; this.writableEnded = true; this.emit("close"); return this;
  }
}
const pricing: ModelPricing = {
  model_id: MODEL, display_name: "Fable", input_per_mtok: 1500n, output_per_mtok: 7500n,
  cache_read_per_mtok: 150n, cache_write_per_mtok: 1875n, multiplier: "1.000",
  enabled: true, sort_order: 0, visibility: "public", extra_system_prompt: null,
  default_effort: null, updated_at: new Date("2026-09-08T00:00:00Z"),
} as ModelPricing;

async function observeErrorFrame(pipe: { stream: boolean; buffered: boolean }, privateText: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "oc-188-error-"));
  let route: ReturnType<typeof makeCursorExternalRoute> | undefined;
  let inferenceCalls = 0; let settleCalls = 0;
  const result: Record<string, unknown> = { privateTextKind: privateText.startsWith("CURSOR_") ? "unknown-prefix" : "raw-message" };
  try {
    const box = await openCursorExternalApiOutbox({ directory: dir });
    const res = new TestResponse();
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/auth/exchange_user_api_key")) {
        const token = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
        return new Response(JSON.stringify({ accessToken: token }), { headers: { "content-type": "application/json" } });
      }
      inferenceCalls += 1;
      return new Response(Buffer.concat([
        frame("extendedUsage", { inputTokens: 40, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 }),
        frame("error", { message: privateText, code: "internal" }), envelope(Buffer.from("{}"), 2),
      ]), { headers: { "content-type": "application/connect+proto" } });
    };
    route = makeCursorExternalRoute({
      pgPool: {} as never, pricing: { get: () => pricing } as unknown as PricingCache,
      logger: quiet, outbox: box, forceBufferedStreaming: pipe.buffered,
      listCursorAccounts: async () => [{ id: 17n, provider: "cursor", status: "active",
        cursor_sand_enabled: true, cursor_credential_kind: "api_key", cooldown_until: null,
        oauth_expires_at: new Date(Date.now() + 86400_000), cursor_quota_class: "other_ok" } as AccountRow],
      loadSnapshot: async (id): Promise<CursorTokenSnapshot | null> => ({ id, token: Buffer.from("crsr_test"),
        credential_kind: "api_key", machine_id: null, refresh: null, expires_at: null }),
      readBalance: async () => 1_000_000n,
      // Null leaves the actual ready on disk. This seam does not claim PG proof.
      settle: async () => { settleCalls += 1; return null; },
      relayFactory: (a) => new CursorSandRelay({ credentialKind: a.credentialKind,
        machineId: a.machineId, readApiKey: a.readApiKey, fetchImpl, passthrough: null, upstreamLabel: "Upstream" }),
    });
    await route.handle({ req: { method: "POST", headers: {}, url: "/v1/messages" } as IncomingMessage,
      res: res as unknown as ServerResponse, requestId: "client-error-evidence", uid: 3n,
      identity: { uid: 3n, containerId: null, apiKey: { id: 9n, creditLimit: null, spentCredits: 0n } } as ProxyIdentity,
      body: { model: MODEL, max_tokens: 64, stream: pipe.stream, messages: [{ role: "user", content: "synthetic" }] } as never,
      authorize: async () => {}, userLog: quiet });
    const batch = await box.listBatch();
    const ready = batch.observations.find((o) => o.kind === "ready");
    const wire = res.chunks.join("");
    Object.assign(result, { inferenceCalls, settleCalls, readyCount: batch.observations.filter((o) => o.kind === "ready").length,
      terminalCode: ready?.kind === "ready" ? ready.record.terminalCode : null,
      usage: ready?.kind === "ready" ? ready.record.usage : null, status: res.statusCode });
    assert.ok(ready?.kind === "ready", "actual ready must exist before absence-of-private-text assertions");
    const disk = await readFile(path.join(dir, ready.file), "utf8");
    const snapshot = JSON.parse(ready.record.plan.snapshotJson) as Record<string, unknown>;
    const expectedWire = privateText.replace(/\bCURSOR_SAND_/g, "");
    Object.assign(result, { billingId: ready.record.billingId, diskBytes: Buffer.byteLength(disk),
      rawInDisk: disk.includes(privateText), rawInSnapshot: ready.record.plan.snapshotJson.includes(privateText),
      snapshotCode: snapshot.cursor_terminal_code, wireErrorPreserved: wire.includes(expectedWire),
      successfulStop: pipe.stream ? wire.includes("event: message_stop") : wire.includes('"stop_reason"'),
      readySha256: createHash("sha256").update(disk).digest("hex") });
    assert.equal(inferenceCalls, 1); assert.equal(settleCalls, 1);
    assert.equal(result.readyCount, 1);
    assert.equal(ready.record.usage.input_tokens, 40); assert.equal(ready.record.usage.output_tokens, 7);
    assert.equal(ready.record.terminalCode, "CURSOR_SAND_UPSTREAM_ERROR");
    assert.equal(snapshot.cursor_terminal_code, "CURSOR_SAND_UPSTREAM_ERROR");
    assert.equal(result.rawInDisk, false); assert.equal(result.rawInSnapshot, false);
    assert.equal(result.wireErrorPreserved, true); assert.equal(result.successfulStop, false);
    return result;
  } finally {
    try { await route?.close(); } finally {
      await rm(dir, { recursive: true, force: true });
      process.stdout.write(JSON.stringify({ contractId: "A-W2-error-frame-FS", pipe,
        expected: { usage: [40, 7], inferenceCalls: 1, settleCalls: 1, readyCount: 1,
          terminalCode: "CURSOR_SAND_UPSTREAM_ERROR", rawInDisk: false, rawInSnapshot: false,
          wireErrorPreserved: true, successfulStop: false }, actual: result }) + "\n");
    }
  }
}

describe("error-frame evidence through real route and FS", () => {
  for (const pipe of [
    { name: "native", stream: true, buffered: false },
    { name: "buffered", stream: true, buffered: true },
    { name: "nonstream", stream: false, buffered: false },
  ]) {
    test(`${pipe.name}: reported error frame persists only stable evidence and preserves wire error`, async () => {
      for (const code of ["USER_CANCELLED", "CURSOR_SAND_UPSTREAM_ERROR", "CURSOR_SAND_UPSTREAM_TERMINATED",
        "CURSOR_SAND_UPSTREAM_STALLED", "CURSOR_SAND_ABORTED"]) {
        assert.equal(classifyRelayTerminalCode(code), code);
        assert.equal(classifyRelayTerminalCode(classifyRelayTerminalCode(code)), code);
      }
      assert.equal(classifyRelayTerminalCode("USER_CANCELLED private text"), "CURSOR_SAND_UPSTREAM_ERROR");
      for (const marker of ["SYNTHETIC_PRIVATE_TEXT_188 do-not-persist", "CURSOR_SAND_SYNTHETIC_PRIVATE_188"]) {
        await observeErrorFrame(pipe, marker);
      }
    });
  }
});
