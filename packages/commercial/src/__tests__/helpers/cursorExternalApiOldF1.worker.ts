/**
 * Independent old-source F1 oracle. Loads the pinned 87d fixture (not git show).
 * Asserts two HTTP with the same client request id produce two usage rows.
 * Expected against 87d: exit 1 with that business assertion (collision → 1 row).
 * Exit 2 = fixture/hash/import failure (not a business red).
 *
 * argv unused; env: TEST_DATABASE_URL, OC_188_UID, OC_188_ACCOUNT, OC_188_KEY
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import protobuf from "protobufjs";
import { CursorSandRelay } from "@openclaude/gateway";
import { createPool } from "../../db/index.js";
import { query } from "../../db/queries.js";
import type { AccountRow, CursorTokenSnapshot } from "../../account-pool/store.js";
import type { ModelPricing, PricingCache } from "../../billing/pricing.js";
import type { ProxyIdentity } from "../../auth/proxyIdentity.js";
import { createLogger } from "../../logging/logger.js";
import type { makeCursorExternalRoute } from "../../http/proxy/cursorExternal.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../../../");
const FIXTURE = path.join(HERE, "../fixtures/cursorExternal.87d4554.fixture.txt");
const PIN = path.join(HERE, "../fixtures/cursorExternal.87d4554.sha256");
const MODEL = "cursor-fable-5.1-high";
const quiet = createLogger({ level: "error", out: () => undefined });

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

function envelope(payload: Uint8Array, flags = 0): Buffer {
  const out = Buffer.alloc(5 + payload.length);
  out[0] = flags;
  out.writeUInt32BE(payload.length, 1);
  Buffer.from(payload).copy(out, 5);
  return out;
}

const protoRoot = protobuf.loadSync(
  path.resolve(HERE, "../../../../gateway/src/engine/cursorSandInference.proto"),
);
const StreamResponse = protoRoot.lookupType("aiserver.v1.InferenceStreamResponse");
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

function fakeJwt(): string {
  return `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
}

function syntheticFetch(): typeof fetch {
  return (async (input) => {
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
  }) as typeof fetch;
}

process.stdout.write("oldf1-boot\n");
const overlay = await mkdtemp(path.join(tmpdir(), "ocv5-188-oldf1-"));
const pool = createPool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 5_000,
  statementTimeoutMs: 8_000,
  applicationName: `ocv5-188-oldf1-${process.pid}`,
});

try {
  const pin = (await readFile(PIN, "utf8")).trim().split(/\s+/)[0]!;
  const raw = await readFile(FIXTURE);
  const hash = createHash("sha256").update(raw).digest("hex");
  if (hash !== pin) {
    process.stderr.write(`fixture hash drift got=${hash} pin=${pin}\n`);
    process.exitCode = 2;
  } else if (raw.toString("utf8").includes("cursorExternalApiOutbox")) {
    process.stderr.write("fixture is not pre-outbox 87d\n");
    process.exitCode = 2;
  } else {
    const srcRoot = path.join(REPO_ROOT, "packages/commercial/src");
    const proxyDir = path.join(overlay, "packages/commercial/src/http/proxy");
    await mkdir(proxyDir, { recursive: true });
    for (const dir of ["billing", "logging", "auth", "account-pool", "admin", "db"]) {
      await symlink(path.join(srcRoot, dir), path.join(overlay, "packages/commercial/src", dir));
    }
    const httpDir = path.join(srcRoot, "http");
    for (const name of await readdir(httpDir)) {
      if (name === "proxy") continue;
      await symlink(path.join(httpDir, name), path.join(overlay, "packages/commercial/src/http", name));
    }
    for (const name of await readdir(path.join(httpDir, "proxy"))) {
      if (name.startsWith("cursorExternal.")) continue;
      await symlink(path.join(httpDir, "proxy", name), path.join(proxyDir, name));
    }
    await mkdir(path.join(overlay, "packages"), { recursive: true });
    await symlink(path.join(REPO_ROOT, "packages/gateway"), path.join(overlay, "packages/gateway"));
    await symlink(path.join(REPO_ROOT, "node_modules"), path.join(overlay, "node_modules"));
    await writeFile(path.join(proxyDir, "cursorExternal.ts"), raw);
    const oldMod = (await import(pathToFileURL(path.join(proxyDir, "cursorExternal.ts")).href)) as {
      makeCursorExternalRoute: typeof makeCursorExternalRoute;
    };
    const uid = BigInt(process.env.OC_188_UID!);
    const accountId = BigInt(process.env.OC_188_ACCOUNT!);
    const apiKeyId = BigInt(process.env.OC_188_KEY!);
    const before = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM usage_records WHERE user_id=$1",
      [uid.toString()],
      pool,
    );
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
    const route = oldMod.makeCursorExternalRoute({
      pgPool: pool,
      pricing,
      logger: quiet,
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
      relayFactory: (relayArgs) =>
        new CursorSandRelay({
          credentialKind: relayArgs.credentialKind,
          machineId: relayArgs.machineId,
          readApiKey: relayArgs.readApiKey,
          fetchImpl: syntheticFetch(),
          passthrough: null,
          upstreamLabel: "Upstream",
        }),
    });
    try {
      for (let i = 0; i < 2; i += 1) {
        const res = new FakeRes();
        await route.handle({
          req: { method: "POST", headers: {}, url: "/v1/messages" } as IncomingMessage,
          res: res as unknown as ServerResponse,
          requestId: "same-client-old",
          uid,
          identity: { uid, containerId: null, apiKey: { id: apiKeyId, creditLimit: null, spentCredits: 0n } } as ProxyIdentity,
          body: { model: MODEL, max_tokens: 64, stream: false, messages: [{ role: "user", content: "hi" }] } as never,
          authorize: async () => {},
          userLog: quiet,
        });
      }
    } finally {
      await route.close();
    }
    const after = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM usage_records WHERE user_id=$1",
      [uid.toString()],
      pool,
    );
    const usageDelta = Number(after.rows[0]!.n) - Number(before.rows[0]!.n);
    process.stdout.write(
      `${JSON.stringify({
        oracle: "F1 two HTTP same client id → 2 usage rows",
        source: "pinned-fixture-87d4554",
        sourceHash: hash,
        usageDelta,
      })}\n`,
    );
    assert.equal(usageDelta, 2, `F1 two HTTP same client id must produce 2 usage rows, old produced ${usageDelta}`);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${msg}\n`);
  if (process.exitCode !== 2) process.exitCode = /cannot find module|export|fixture hash/i.test(msg) ? 2 : 1;
} finally {
  await pool.end().catch(() => undefined);
  await rm(overlay, { recursive: true, force: true }).catch(() => undefined);
}
