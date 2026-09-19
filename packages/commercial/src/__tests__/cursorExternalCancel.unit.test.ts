/**
 * Real relay + FS outbox USER_CANCELLED chain (no PG).
 * Client hang-up uses the route's writableEnded/close contract, not signal.aborted.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import protobuf from "protobufjs";
import { CursorSandRelay } from "@openclaude/gateway";
import type { AccountRow, CursorTokenSnapshot } from "../account-pool/store.js";
import type { ModelPricing, PricingCache } from "../billing/pricing.js";
import type { SettleResult } from "../billing/proxyBilling.js";
import { createLogger } from "../logging/logger.js";
import type { ProxyIdentity } from "../auth/proxyIdentity.js";
import { makeCursorExternalRoute } from "../http/proxy/cursorExternal.js";
import { openCursorExternalApiOutbox } from "../billing/cursorExternalApiOutbox.js";

const MODEL = "cursor-fable-5.1-high";
const quiet = createLogger({ level: "error", out: () => undefined });
const protoRoot = protobuf.loadSync(
  path.resolve(fileURLToPath(new URL("../../../gateway/src/engine/cursorSandInference.proto", import.meta.url))),
);
const StreamResponse = protoRoot.lookupType("aiserver.v1.InferenceStreamResponse");

function envelope(payload: Uint8Array, flags = 0): Buffer {
  const out = Buffer.alloc(5 + payload.length);
  out[0] = flags;
  out.writeUInt32BE(payload.length, 1);
  Buffer.from(payload).copy(out, 5);
  return out;
}
function responseFrame(field: string, value: unknown): Buffer {
  return envelope(StreamResponse.encode(StreamResponse.fromObject({ [field]: value })).finish());
}
function fakeJwt(): string {
  return `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
}

class FakeRes extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  destroyed = false;
  writableEnded = false;
  writableNeedDrain = false;
  headersSent = false;
  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    this.headersSent = true;
    return this;
  }
  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  write(chunk: string | Buffer): boolean {
    this.headersSent = true;
    this.chunks.push(String(chunk));
    return true;
  }
  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.chunks.push(String(chunk));
    this.headersSent = true;
    this.writableEnded = true;
    this.emit("close");
    return this;
  }
  hangUp(): void {
    this.emit("close");
  }
  text(): string {
    return this.chunks.join("");
  }
}

function hangingFetch(frames: Buffer[]): typeof fetch {
  return (async (input, init) => {
    if (String(input).endsWith("/auth/exchange_user_api_key")) {
      return new Response(JSON.stringify({ accessToken: fakeJwt() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const signal = (init as RequestInit | undefined)?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.concat(frames));
        const onAbort = () => {
          try {
            controller.error(Object.assign(new Error("AbortError"), { name: "AbortError" }));
          } catch {
            /* already closed */
          }
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/connect+proto" } });
  }) as typeof fetch;
}

const PARTIAL_FRAMES = [
  responseFrame("textPart", { text: "partial-out" }),
  responseFrame("extendedUsage", {
    inputTokens: 40,
    outputTokens: 7,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    maxTokens: 64,
  }),
];
const ZERO_FRAMES = [
  responseFrame("textPart", { text: "" }),
  responseFrame("extendedUsage", {
    inputTokens: 8,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    maxTokens: 64,
  }),
];
const NO_USAGE_FRAMES = [responseFrame("textPart", { text: "no-usage-yet" })];

function pricingRow(): ModelPricing {
  return {
    model_id: MODEL,
    display_name: "Fable",
    input_per_mtok: 1500n,
    output_per_mtok: 7500n,
    cache_read_per_mtok: 150n,
    cache_write_per_mtok: 1875n,
    multiplier: "1.000",
    enabled: true,
    sort_order: 0,
    visibility: "public",
    extra_system_prompt: null,
    default_effort: null,
    updated_at: new Date("2026-09-08T00:00:00Z"),
  } as ModelPricing;
}

async function runCancel(args: {
  frames: Buffer[];
  stream: boolean;
  buffered?: boolean;
}): Promise<{
  settle: Array<{ terminalCode?: string | null; engineStatus: string; usage: unknown; requestId: string }>;
  phase: string | null;
  readyUsage: unknown;
  readyTerminal: string | null;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "oc-cancel-"));
  const settle: Array<{ terminalCode?: string | null; engineStatus: string; usage: unknown; requestId: string }> = [];
  try {
    const box = await openCursorExternalApiOutbox({ directory: dir });
    const res = new FakeRes();
    const route = makeCursorExternalRoute({
      pgPool: {} as never,
      pricing: { get: () => pricingRow() } as unknown as PricingCache,
      logger: quiet,
      outbox: box,
      forceBufferedStreaming: args.buffered === true,
      listCursorAccounts: async () =>
        [{
          id: 17n,
          provider: "cursor",
          status: "active",
          cursor_sand_enabled: true,
          cursor_credential_kind: "api_key",
          cooldown_until: null,
          oauth_expires_at: new Date(Date.now() + 86400_000),
          cursor_quota_class: "other_ok",
        } as AccountRow],
      loadSnapshot: async (id): Promise<CursorTokenSnapshot | null> => ({
        id,
        token: Buffer.from("crsr_test"),
        credential_kind: "api_key",
        machine_id: null,
        refresh: null,
        expires_at: null,
      }),
      readBalance: async () => 1_000_000n,
      settle: async (s) => {
        settle.push({
          terminalCode: s.terminalCode,
          engineStatus: s.engineStatus,
          usage: s.usage,
          requestId: s.requestId,
        });
        return {
          usageId: 1n,
          ledgerId: s.engineStatus === "success" ? 2n : null,
          clamped: false,
          debitedCredits: null,
          attributionCredits: 0n,
          balanceAfter: null,
        } satisfies SettleResult;
      },
      relayFactory: (relayArgs) =>
        new CursorSandRelay({
          credentialKind: relayArgs.credentialKind,
          machineId: relayArgs.machineId,
          readApiKey: relayArgs.readApiKey,
          fetchImpl: hangingFetch(args.frames),
          passthrough: null,
          upstreamLabel: "Upstream",
        }),
    });
    const done = route.handle({
      req: { method: "POST", headers: {}, url: "/v1/messages" } as IncomingMessage,
      res: res as unknown as ServerResponse,
      requestId: "client-cancel",
      uid: 3n,
      identity: { uid: 3n, containerId: null, apiKey: { id: 9n, creditLimit: null, spentCredits: 0n } } as ProxyIdentity,
      body: {
        model: MODEL,
        max_tokens: 64,
        stream: args.stream,
        messages: [{ role: "user", content: "hi" }],
      } as never,
      authorize: async () => {},
      userLog: quiet,
    });
    const waitUntil = Date.now() + 1_000;
    while (Date.now() < waitUntil && !res.headersSent && res.chunks.length === 0) {
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 40));
    res.hangUp();
    await done;
    await route.close();
    const listing = await box.listBatch({ limit: 8 });
    const ready = listing.observations.find((o) => o.kind === "ready");
    const intent = listing.observations.find((o) => o.kind === "intent");
    return {
      settle,
      phase: ready ? "ready" : intent ? "intent" : listing.observations[0]?.kind ?? null,
      readyUsage: ready && ready.kind === "ready" ? ready.record.usage : null,
      readyTerminal: ready && ready.kind === "ready" ? ready.record.terminalCode : null,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("USER_CANCELLED real relay + FS", () => {
  for (const pipe of [
    { name: "native", stream: true, buffered: false },
    { name: "buffered", stream: true, buffered: true },
    { name: "nonstream", stream: false, buffered: false },
  ]) {
    test(`${pipe.name}: hang-up after positive output seals USER_CANCELLED reported partial`, async () => {
      const got = await runCancel({ frames: PARTIAL_FRAMES, stream: pipe.stream, buffered: pipe.buffered });
      assert.equal(got.settle.length, 1, JSON.stringify(got));
      assert.equal(got.settle[0]?.terminalCode, "USER_CANCELLED");
      assert.equal(got.settle[0]?.engineStatus, "error");
      assert.equal((got.settle[0]?.usage as { output_tokens: number }).output_tokens, 7);
    });

    test(`${pipe.name}: hang-up after explicit zero output is USER_CANCELLED reported zero`, async () => {
      const got = await runCancel({ frames: ZERO_FRAMES, stream: pipe.stream, buffered: pipe.buffered });
      assert.equal(got.settle.length, 1, JSON.stringify(got));
      assert.equal(got.settle[0]?.terminalCode, "USER_CANCELLED");
      assert.equal((got.settle[0]?.usage as { output_tokens: number }).output_tokens, 0);
    });

    test(`${pipe.name}: hang-up before any usage keeps intent/unobserved`, async () => {
      const got = await runCancel({ frames: NO_USAGE_FRAMES, stream: pipe.stream, buffered: pipe.buffered });
      assert.equal(got.phase, "intent");
      assert.equal(got.settle.length, 0);
    });
  }
});
