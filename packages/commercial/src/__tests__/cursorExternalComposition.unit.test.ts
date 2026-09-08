/** New-parent composition: actual route + relay + FS; model transport and PG settlement are controlled seams. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import protobuf from "protobufjs";
import { CursorSandRelay } from "@openclaude/gateway";
import type { AccountRow, CursorTokenSnapshot } from "../account-pool/store.js";
import type { ModelPricing, PricingCache } from "../billing/pricing.js";
import type { ProxyIdentity } from "../auth/proxyIdentity.js";
import type { ApiKeyMessageAuditRow } from "../billing/apiKeyMessageAudit.js";
import { createLogger } from "../logging/logger.js";
import { makeCursorExternalRoute, type CursorExternalDeps } from "../http/proxy/cursorExternal.js";
import { openCursorExternalApiOutbox, type CursorExternalReadyRecord } from "../billing/cursorExternalApiOutbox.js";

const MODEL = "cursor-fable-5.1-high";
const TRACE = "client-composition-trace";
const PUBLIC_ERROR = "Provider Error (400): Synthetic provider detail for composition";
const quiet = createLogger({ level: "error", out: () => undefined });
const proto = protobuf.loadSync(path.resolve(fileURLToPath(new URL("../../../gateway/src/engine/cursorSandInference.proto", import.meta.url))));
const streamResponse = proto.lookupType("aiserver.v1.InferenceStreamResponse");
function envelope(payload: Uint8Array, flags = 0): Buffer {
  const bytes = Buffer.alloc(5 + payload.length);
  bytes[0] = flags; bytes.writeUInt32BE(payload.length, 1); Buffer.from(payload).copy(bytes, 5); return bytes;
}
function frame(field: string, value: unknown): Buffer {
  return envelope(streamResponse.encode(streamResponse.fromObject({ [field]: value })).finish());
}
const providerError = {
  code: "resource_exhausted", message: "Error",
  details: [{ type: "aiserver.v1.ErrorDetails", debug: { error: "ERROR_PROVIDER_ERROR", details: {
    title: "Provider Error", detail: "Synthetic provider detail for composition", isRetryable: false,
    additionalInfo: { providerStatusCode: "400" },
  } } }],
};
// Sand inputTokens includes cache tokens; uncached input = 40 - 3 - 2.
const usage = { input_tokens: 35, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 };
class TestResponse extends EventEmitter {
  statusCode = 200; headersSent = false; writableEnded = false;
  writableNeedDrain = false; destroyed = false; chunks: string[] = [];
  headers: Record<string, string> = {};
  successBeforeReady = false;
  constructor(private readonly readyCount: () => number) { super(); }
  setHeader(k: string, v: string): this { this.headers[k.toLowerCase()] = v; return this; }
  writeHead(status: number): this { this.statusCode = status; this.headersSent = true; return this; }
  write(chunk: string | Buffer): boolean {
    const text = String(chunk);
    if ((text.includes("event: message_stop") || text.includes('"stop_reason":"')) && this.readyCount() !== 1) this.successBeforeReady = true;
    this.headersSent = true; this.chunks.push(text); return true;
  }
  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.write(chunk);
    this.headersSent = true; this.writableEnded = true; this.emit("close"); return this;
  }
}
const pricing = {
  model_id: MODEL, display_name: "Fable", input_per_mtok: 1500n, output_per_mtok: 7500n,
  cache_read_per_mtok: 150n, cache_write_per_mtok: 1875n, multiplier: "1.000",
  enabled: true, sort_order: 0, visibility: "public", extra_system_prompt: null,
  default_effort: null, updated_at: new Date("2026-09-08T00:00:00Z"),
} as ModelPricing;

for (const pipe of [
  { name: "native", stream: true, buffered: false },
  { name: "buffered", stream: true, buffered: true },
  { name: "nonstream", stream: false, buffered: false },
]) for (const success of [false, true]) {
  test(`composition ${pipe.name} ${success ? "success" : "nonretryable"}: billing evidence and trace audit retain separate authority`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-181-188-composition-"));
    let route: ReturnType<typeof makeCursorExternalRoute> | undefined;
    const records: CursorExternalReadyRecord[] = [];
    const disk: string[] = [];
    const audit: ApiKeyMessageAuditRow[] = [];
    const settled: Parameters<NonNullable<CursorExternalDeps["settle"]>>[0][] = [];
    const events: string[] = [];
    const appends: unknown[][] = [];
    const broadcasts: unknown[] = [];
    let inferenceCalls = 0;
    try {
      const box = await openCursorExternalApiOutbox({ directory: dir });
      const res = new TestResponse(() => records.length);
      const fetchImpl: typeof fetch = async (input) => {
        if (String(input).endsWith("/auth/exchange_user_api_key")) {
          const token = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
          return new Response(JSON.stringify({ accessToken: token }), { headers: { "content-type": "application/json" } });
        }
        inferenceCalls++;
        return new Response(Buffer.concat([
          frame("extendedUsage", { inputTokens: 40, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2 }),
          ...(success ? [frame("textPart", { text: "synthetic success" })] : []),
          envelope(Buffer.from(JSON.stringify(success ? {} : { error: providerError })), 2),
        ]), { headers: { "content-type": "application/connect+proto" } });
      };
      route = makeCursorExternalRoute({
        pgPool: {} as never, pricing: { get: () => pricing } as unknown as PricingCache,
        logger: quiet, forceBufferedStreaming: pipe.buffered,
        outbox: { ...box, async writeReady(record) {
          const saved = await box.writeReady(record);
          const readBack = await box.read(saved.billingId);
          assert.ok(readBack?.phase === "ready", "ready persisted before successful response");
          const batch = await box.listBatch();
          const leaf = batch.observations.find(o => o.kind === "ready");
          assert.ok(leaf?.kind === "ready");
          disk.push(await readFile(path.join(dir, leaf.file), "utf8"));
          records.push(readBack); events.push("ready"); return saved;
        } },
        listCursorAccounts: async () => [{ id: 17n, provider: "cursor", status: "active",
          cursor_sand_enabled: true, cursor_credential_kind: "api_key", cooldown_until: null,
          oauth_expires_at: new Date(Date.now() + 86400_000), cursor_quota_class: "other_ok" } as AccountRow],
        loadSnapshot: async (id): Promise<CursorTokenSnapshot | null> => ({ id, token: Buffer.from("crsr_test"),
          credential_kind: "api_key", machine_id: null, refresh: null, expires_at: null }),
        readBalance: async () => 1_000_000n,
        settle: async (s) => {
          settled.push(s); events.push("settle");
          if (!success) return null; // Keep the real error ready; do not claim a real PG ledger commit.
          return { usageId: 1n, ledgerId: 2n, clamped: false, debitedCredits: 42n,
            attributionCredits: 42n, balanceAfter: 958n, commitDisposition: "new_commit" };
        },
        recordMessageAudit: async row => { audit.push(row); events.push("audit"); },
        relayFactory: a => new CursorSandRelay({ credentialKind: a.credentialKind,
          machineId: a.machineId, readApiKey: a.readApiKey, fetchImpl, passthrough: null, upstreamLabel: "Upstream" }),
      });
      await route.handle({ req: { method: "POST", headers: {}, url: "/v1/messages" } as IncomingMessage,
        res: res as unknown as ServerResponse, requestId: TRACE, uid: 3n,
        identity: { uid: 3n, containerId: null, apiKey: { id: 9n, creditLimit: null, spentCredits: 0n } } as ProxyIdentity,
        body: { model: MODEL, max_tokens: 64, stream: pipe.stream, messages: [{ role: "user", content: "synthetic" }] } as never,
        requestedModel: "fable-5.1", effort: "high", effortSource: "request",
        authorize: async () => {}, userLog: quiet,
        appendCostCredits: async (...args) => { appends.push(args); events.push("append"); },
        broadcastToUser: (_uid, payload) => { broadcasts.push(payload); events.push("broadcast"); },
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      const wire = res.chunks.join("");
      assert.equal(inferenceCalls, 1); assert.equal(records.length, 1); assert.equal(settled.length, 1);
      const ready = records[0]!;
      assert.match(ready.billingId, /^[0-9a-f]{32}$/); assert.notEqual(ready.billingId, TRACE);
      assert.equal(settled[0]!.requestId, ready.billingId); assert.deepEqual(ready.usage, usage);
      assert.deepEqual(settled[0]!.usage, usage);
      assert.equal(audit.length, 1); assert.equal(audit[0]!.requestId, TRACE);
      assert.equal(audit[0]!.model, MODEL); assert.equal(audit[0]!.requestedModel, "fable-5.1");
      assert.equal(audit[0]!.effort, "high"); assert.equal(audit[0]!.effortSource, "request");
      assert.deepEqual(audit[0]!.usage, { inputTokens: 35, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2 });
      assert.doesNotMatch(wire, /\[non-retryable\]/);
      assert.equal(res.successBeforeReady, false);
      if (success) {
        assert.equal(ready.engineStatus, "success"); assert.equal(ready.terminalCode, null);
        assert.equal(audit[0]!.status, "success"); assert.equal(audit[0]!.errorMessage, null);
        assert.equal(appends.length, 1); assert.equal(appends[0]![0], ready.billingId);
        assert.deepEqual(broadcasts, [{ type: "outbound.cost_charged", requestId: ready.billingId,
          costCredits: "42", balanceAfter: "958", sessionId: null, parentSessionId: null }]);
        assert.deepEqual(events, ["ready", "settle", "audit", "append", "broadcast"]);
        assert.equal(res.statusCode, 200);
        if (pipe.stream) assert.match(wire, /event: message_stop/);
        else assert.equal(JSON.parse(wire).type, "message");
      } else {
        assert.equal(ready.engineStatus, "error"); assert.equal(ready.terminalCode, "CURSOR_SAND_UPSTREAM_ERROR");
        const snapshot = JSON.parse(ready.plan.snapshotJson);
        assert.equal(snapshot.cursor_terminal_code, "CURSOR_SAND_UPSTREAM_ERROR");
        assert.equal(ready.plan.costCredits, "0");
        assert.doesNotMatch(disk[0]!, /Synthetic provider detail|ERROR_PROVIDER_ERROR|\[non-retryable\]/);
        assert.equal(audit[0]!.status, "error"); assert.equal(audit[0]!.errorMessage, PUBLIC_ERROR);
        assert.equal(broadcasts.length, 0); assert.equal(appends.length, 0);
        assert.match(wire, /"type":"invalid_request_error"/);
        assert.ok(wire.includes(PUBLIC_ERROR));
        assert.doesNotMatch(wire, /event: message_stop|"stop_reason"/);
        if (!pipe.stream || pipe.buffered) assert.equal(res.headers["x-should-retry"], "false");
        if (!pipe.stream) assert.equal(res.statusCode, 502);
      }
      process.stdout.write(JSON.stringify({ contract: "181-188-composition", pipe: pipe.name, success,
        inferenceCalls, ready: records.length, settle: settled.length, audit: audit.length,
        serverBillingId: ready.billingId, traceId: audit[0]!.requestId, events, fs: true, pg: "stub" })+"\n");
    } finally { try { await route?.close(); } finally { await rm(dir, { recursive: true, force: true }); } }
  });
}
