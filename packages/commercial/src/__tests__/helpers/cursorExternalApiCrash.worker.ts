/**
 * Child: real route+relay+settle on a dedicated pool (unique application_name).
 * Writes a marker once settle starts so the parent can terminate only this
 * backend, then the child exits. Does not stop Postgres or touch the global pool.
 *
 * argv: <outboxDir> <databaseUrl> <markerPath> <uid> <accountId> <apiKeyId> <appName>
 */
import { writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import protobuf from "protobufjs";
import { CursorSandRelay } from "@openclaude/gateway";
import { createPool } from "../../db/index.js";
import { settleCursorExternalUsage } from "../../billing/cursorExternalSettle.js";
import { openCursorExternalApiOutbox } from "../../billing/cursorExternalApiOutbox.js";
import type { AccountRow, CursorTokenSnapshot } from "../../account-pool/store.js";
import type { ModelPricing, PricingCache } from "../../billing/pricing.js";
import type { ProxyIdentity } from "../../auth/proxyIdentity.js";
import { createLogger } from "../../logging/logger.js";
import { makeCursorExternalRoute } from "../../http/proxy/cursorExternal.js";

const [, , outboxDir, databaseUrl, markerPath, uidStr, accountStr, keyStr, appName] = process.argv;
if (!outboxDir || !databaseUrl || !markerPath || !uidStr || !accountStr || !keyStr || !appName) {
  process.stderr.write("usage: crash worker <outboxDir> <databaseUrl> <marker> <uid> <accountId> <apiKeyId> <appName>\n");
  process.exit(2);
}

const MODEL = "cursor-fable-5.1-high";
const quiet = createLogger({ level: "error", out: () => undefined });
const protoRoot = protobuf.loadSync(
  path.resolve(fileURLToPath(new URL("../../../../gateway/src/engine/cursorSandInference.proto", import.meta.url))),
);
const StreamResponse = protoRoot.lookupType("aiserver.v1.InferenceStreamResponse");

function envelope(payload: Uint8Array, flags = 0): Buffer {
  const out = Buffer.alloc(5 + payload.length);
  out[0] = flags;
  out.writeUInt32BE(payload.length, 1);
  Buffer.from(payload).copy(out, 5);
  return out;
}

class FakeRes extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: string[] = [];
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
}

function fakeJwt(): string {
  return `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
}

const USAGE_FRAMES = [
  envelope(StreamResponse.encode(StreamResponse.fromObject({ textPart: { text: "hello-out" } })).finish()),
  envelope(
    StreamResponse.encode(
      StreamResponse.fromObject({
        extendedUsage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 64 },
      }),
    ).finish(),
  ),
];

const pool = createPool({
  connectionString: databaseUrl,
  max: 2,
  connectionTimeoutMillis: 5_000,
  statementTimeoutMs: 8_000,
  applicationName: appName,
});
const uid = BigInt(uidStr);
const accountId = BigInt(accountStr);
const apiKeyId = BigInt(keyStr);
let route: ReturnType<typeof makeCursorExternalRoute> | undefined;

try {
  const box = await openCursorExternalApiOutbox({ directory: outboxDir });
  const pricing = {
    get: () =>
      ({
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
      }) as ModelPricing,
  } as unknown as PricingCache;
  route = makeCursorExternalRoute({
    pgPool: pool,
    pricing,
    logger: quiet,
    outbox: box,
    listCursorAccounts: async () =>
      [{
        id: accountId,
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
    settle: async (args) => {
      await writeFile(markerPath, "settling\n");
      const client = await args.pool.connect();
      try {
        await client.query("SELECT pg_sleep(8)");
      } catch (err) {
        try {
          client.release();
        } catch {
          /* already dead */
        }
        throw err;
      }
      client.release();
      return settleCursorExternalUsage(args);
    },
    relayFactory: (relayArgs) =>
      new CursorSandRelay({
        credentialKind: relayArgs.credentialKind,
        machineId: relayArgs.machineId,
        readApiKey: relayArgs.readApiKey,
        fetchImpl: (async (input) => {
          if (String(input).endsWith("/auth/exchange_user_api_key")) {
            return new Response(JSON.stringify({ accessToken: fakeJwt() }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(Buffer.concat([...USAGE_FRAMES, envelope(Buffer.from("{}"), 0x02)]), {
            status: 200,
            headers: { "content-type": "application/connect+proto" },
          });
        }) as typeof fetch,
        passthrough: null,
        upstreamLabel: "Upstream",
      }),
  });
  const res = new FakeRes();
  await route.handle({
    req: { method: "POST", headers: {}, url: "/v1/messages" } as IncomingMessage,
    res: res as unknown as ServerResponse,
    requestId: "crash-client",
    uid,
    identity: { uid, containerId: null, apiKey: { id: apiKeyId, creditLimit: null, spentCredits: 0n } } as ProxyIdentity,
    body: { model: MODEL, max_tokens: 64, stream: false, messages: [{ role: "user", content: "hi" }] } as never,
    authorize: async () => {},
    userLog: quiet,
  });
  const listing = await box.listBatch({ limit: 8 });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      observations: listing.observations.map((o) => o.kind),
      billingId: listing.observations.find((o) => o.kind === "ready" || o.kind === "intent")?.kind === "ready"
        ? (listing.observations.find((o) => o.kind === "ready") as { record: { billingId: string } }).record.billingId
        : listing.observations.find((o) => o.kind === "intent" && "billingId" in o)
          ? (listing.observations.find((o) => o.kind === "intent") as { billingId: string }).billingId
          : null,
    })}\n`,
  );
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, err: err instanceof Error ? err.message : String(err) })}\n`);
  process.exitCode = 0;
} finally {
  try {
    await route?.close();
  } catch {
    /* ignore */
  }
  await pool.end().catch(() => undefined);
}
