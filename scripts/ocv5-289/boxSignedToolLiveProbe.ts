/** Operator-only signed /v1/messages -> real Box two-HTTP acceptance.
 * This uses the existing selfhost billing wallet at the live Opus 5.5 price,
 * never commercial production; all prompts/results are synthetic. Ambiguous
 * paid or side-effecting work is never replayed. */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync,
  fchownSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { BoxDurableJournal } from
  "../../packages/commercial/src/http/proxy/boxDurableJournal.js";
import type { BoxJournalAdmission } from
  "../../packages/commercial/src/http/proxy/boxDurableJournal.js";
import { BoxToolFetch } from
  "../../packages/commercial/src/http/proxy/boxToolFetch.js";
import { BoxUserStopCoordinator } from
  "../../packages/commercial/src/http/proxy/boxUserStopCoordinator.js";
import { makeBoxUserStopHandler } from
  "../../packages/commercial/src/http/proxy/boxUserStopHandler.js";
import { parseBoxTerminalProof } from
  "../../packages/commercial/src/http/proxy/boxTerminalProof.js";
import { parseBoxNativePointer } from
  "../../packages/commercial/src/http/proxy/boxNativePointer.js";
import { makeBoxDetachedToolPlan } from
  "../../packages/commercial/src/http/proxy/boxDetachedToolPlan.js";
import { deriveBoxCallFingerprint, hashBoxAssistantContent } from
  "../../packages/commercial/src/http/proxy/boxCallFingerprint.js";
import { normalizeBoxSemanticBody } from
  "../../packages/commercial/src/http/proxy/boxCacheAnnotations.js";
import { validateBoxRequest, validateBoxToolRequest } from
  "../../packages/commercial/src/http/proxy/boxRequestGate.js";
import { createProductionBoxAccountResolver } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { makeAnthropicProxyHandler } from
  "../../packages/commercial/src/http/anthropicProxy.js";
import type { AnthropicProxyDeps } from
  "../../packages/commercial/src/http/anthropicProxy.js";
import { makeContainerIdentityStrategy } from
  "../../packages/commercial/src/auth/proxyIdentity.js";
import { PricingCache, type ModelPricing } from
  "../../packages/commercial/src/billing/pricing.js";
import { multiplierToScaled } from
  "../../packages/commercial/src/billing/calculator.js";
import { ModelCatalogSnapshot, type ModelCatalogEntry, type ModelCatalogPricing } from
  "../../packages/commercial/src/billing/modelCatalog.js";
import { LOCAL_CATALOG_HEADER, encodeLocalCatalogToken } from
  "../../packages/commercial/src/http/proxy/modelAuthorityGate.js";
import { wrapIoredisForPreCheck } from
  "../../packages/commercial/src/billing/preCheck.js";
import { wrapIoredis } from
  "../../packages/commercial/src/middleware/rateLimit.js";
import { createLogger } from
  "../../packages/commercial/src/logging/logger.js";
import { loadConfig } from "../../packages/commercial/src/config.js";
import { getPool, closePool } from "../../packages/commercial/src/db/index.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";
import { makeBoxThirdTurnBody } from "./boxThirdTurnPlan.js";
import type { ProxyBody } from
  "../../packages/commercial/src/http/proxy/shared.js";

const UID = 3n, ACCOUNT_ID = 20n;
const MODEL = "box-api-claude-opus-5-5", UPSTREAM = "claude-opus-5-5";
const WORK_HOST = "/var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-289-box-api";
const WORK_CONTAINER = "/home/agent/.openclaude/workspace/ocv5-289-box-api";
const EVIDENCE_PARENT = "/var/lib/openclaude";
const EVIDENCE_DIR = `${EVIDENCE_PARENT}/ocv5-289-box-operator`;
const EVIDENCE_PATH = `${EVIDENCE_DIR}/account-20.json`;
const OPERATOR_MUTEX = `${EVIDENCE_DIR}/account-20.mutex`;
type Event = { event: string; data: Record<string, unknown> };
function assertion(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
async function readEvents(response: Response): Promise<Event[]> {
  assertion(response.status === 200 && response.body, "BOX_TOOL_PROBE_HTTP_INVALID");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let raw = "", ended = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { ended = true; break; }
      raw += decoder.decode(next.value, { stream: true });
      assertion(Buffer.byteLength(raw) <= 2 * 1024 * 1024, "BOX_TOOL_PROBE_SSE_TOO_LARGE");
    }
  } finally { if (!ended) await reader.cancel().catch(() => {}); }
  raw += decoder.decode();
  const events = [...raw.matchAll(/^event: ([a-z_]+)\ndata: ([^\n]+)$/gm)]
    .map((match) => ({ event: match[1]!,
      data: JSON.parse(match[2]!) as Record<string, unknown> }));
  assertion(events.length > 0 && events.some((item) => item.event === "message_stop"),
    "BOX_TOOL_PROBE_SSE_INCOMPLETE");
  return events;
}
function assistantContent(events: Event[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const partial = new Map<number, string>();
  for (const { event, data } of events) {
    if (event === "content_block_start") {
      const index = data.index;
      const block = data.content_block;
      assertion(Number.isSafeInteger(index) && Number(index) >= 0
        && block && typeof block === "object" && !Array.isArray(block),
      "BOX_TOOL_PROBE_BLOCK_INVALID");
      blocks[index as number] = { ...block as Record<string, unknown> };
    } else if (event === "content_block_delta") {
      const index = data.index;
      const delta = data.delta as Record<string, unknown> | undefined;
      assertion(Number.isSafeInteger(index) && !!blocks[index as number] && !!delta,
        "BOX_TOOL_PROBE_DELTA_INVALID");
      const block = blocks[index as number]!;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        block.text = String(block.text ?? "") + delta.text;
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        block.thinking = String(block.thinking ?? "") + delta.thinking;
      } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
        block.signature = delta.signature;
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        partial.set(index as number, (partial.get(index as number) ?? "") + delta.partial_json);
      } else throw new Error("BOX_TOOL_PROBE_DELTA_UNSUPPORTED");
    } else if (event === "content_block_stop") {
      const index = data.index;
      assertion(Number.isSafeInteger(index) && !!blocks[index as number],
        "BOX_TOOL_PROBE_BLOCK_STOP_INVALID");
      const input = partial.get(index as number);
      if (input !== undefined) blocks[index as number]!.input = JSON.parse(input);
    }
  }
  assertion(blocks.length > 0 && blocks.length <= 64
    && Array.from({ length: blocks.length }, (_, index) => index)
      .every((index) => Object.hasOwn(blocks, index) && !!blocks[index]),
    "BOX_TOOL_PROBE_CONTENT_INVALID");
  return blocks;
}

const SAFE_CONTROL_KEYS = new Set(["edits", "type", "trigger", "value", "keep",
  "clear_at_least", "minimum", "effort", "display", "budget_tokens",
  "min_tokens", "max_tokens", "mode", "threshold"]);
const SAFE_CONTROL_VALUES = new Set(["adaptive", "omitted", "low", "medium",
  "high", "max", "enabled", "disabled", "input_tokens", "tool_uses",
  "clear_tool_uses_20250919", "clear_thinking_20251015", "all", "none"]);
/** Preserve only protocol enums/numbers and known keys. Unknown strings are
 * represented by length, never copied into an operator report. */
function safeControlShape(value: unknown, depth = 0,
  budget = { remaining: 256 }): unknown {
  if (budget.remaining <= 0) return "<node-limit>";
  budget.remaining--;
  if (depth > 6) return "<depth-limit>";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "<number>";
  if (typeof value === "string") return SAFE_CONTROL_VALUES.has(value) ? value
    : { stringBytes: Buffer.byteLength(value) };
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value.slice(0, 16)) {
      if (budget.remaining <= 0) break;
      items.push(safeControlShape(item, depth + 1, budget));
    }
    return { items, omitted: Math.max(0, value.length - items.length) };
  }
  if (typeof value !== "object") return `<${typeof value}>`;
  const source = value as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  let omitted = 0;
  for (const [key, item] of Object.entries(source)) {
    if (budget.remaining <= 0) { safe.truncated = true; break; }
    if (SAFE_CONTROL_KEYS.has(key)) safe[key] = safeControlShape(item, depth + 1, budget);
    else omitted++;
  }
  if (omitted) safe.omittedFields = omitted;
  return safe;
}
function boundedControlShape(value: unknown): unknown {
  const summary = safeControlShape(value);
  return Buffer.byteLength(JSON.stringify(summary)) <= 4096
    ? summary : "<summary-too-large>";
}

async function startSignedLoopback(args: { pool: Pool; redis: Redis;
  boxModel: AnthropicProxyDeps["boxModel"]; price: ModelPricing;
  containerId: number; bindHost?: string; containerInboundIp?: string;
  listenPort?: number; assignedRequestIds?: readonly string[];
  shapeOnly?: boolean }) {
  const diagnostics: Array<{ msg: string; code?: string; detail?: string }> = [];
  const continuationEvidence: Array<{ requestId: string; assistantHash: string | null;
    assistantShape: Array<{ type: string; keys: string[]; unknownKeys: number }>;
    messageRoles: string[]; parseCode: string }> = [];
  const pricing = new PricingCache();
  pricing._setForTests([args.price]);
  const entry: ModelCatalogEntry = {
    entryId: 289, modelId: MODEL, engine: "ccb", providerId: "box_cli",
    upstreamModelId: UPSTREAM, contextWindow: 200_000,
    capabilityProfile: { supportsVision: false,
      reasoning: { supported: [], codexModelDefault: null },
      ccb: { capabilityZero: true, supportsThinking: false } },
    capabilitySchemaVersion: 1, state: "active", lockVersion: 0,
  };
  const catalogPrice: ModelCatalogPricing = {
    modelId: MODEL, displayName: args.price.display_name,
    inputPerMtok: args.price.input_per_mtok,
    outputPerMtok: args.price.output_per_mtok,
    cacheReadPerMtok: args.price.cache_read_per_mtok,
    cacheWritePerMtok: args.price.cache_write_per_mtok,
    multiplier: args.price.multiplier, visibility: "public", sortOrder: 289,
    defaultEffort: null,
  };
  const snapshot = new ModelCatalogSnapshot({ entries: [entry], aliases: new Map(),
    pricing: new Map([[MODEL, catalogPrice]]), securityEpoch: 7n });
  const loadUserModelAuthz = async () => ({ role: "admin" as const,
    grantedModelIds: new Set<string>() });
  const hostUuid = `ocv5-289-signed-${randomBytes(6).toString("hex")}`;
  const boundIp = "127.0.0.1";
  const containerId = args.containerId;
  const secret = randomBytes(32);
  const secretHex = secret.toString("hex");
  const identity = makeContainerIdentityStrategy({
    repo: { async findActiveByHostAndBoundIp(host, ip) {
      return host === hostUuid && ip === boundIp ? {
        id: containerId, user_id: Number(UID), host_uuid: hostUuid,
        bound_ip: boundIp, secret_hash: createHash("sha256").update(secret).digest(),
      } : null;
    } },
    pricing, loadUserModelAuthz, recordHostRequest: () => {},
  });
  const token = encodeLocalCatalogToken({ v: 1, kind: "local_catalog",
    projectionRevision: snapshot.projectionRevisionFor({ uid: String(UID),
      role: "admin", grantedModelIds: new Set() }),
    securityEpoch: snapshot.securityEpoch.toString() });
  const handler = makeAnthropicProxyHandler({
    pgPool: args.pool, pricing,
    preCheckRedis: wrapIoredisForPreCheck(args.redis),
    rateLimitRedis: wrapIoredis(args.redis),
    scheduler: {} as AnthropicProxyDeps["scheduler"],
    identity, loadUserModelAuthz,
    modelCatalog: { async assertFresh() { return snapshot; },
      peek() { return snapshot; } } as NonNullable<AnthropicProxyDeps["modelCatalog"]>,
    modelAuthorityEnforce: true,
    boxModel: args.boxModel,
    logger: createLogger({ level: "trace", base: { probe: "ocv5-289-signed" },
      out: (line) => {
        try {
          const item = JSON.parse(line) as { msg?: unknown; code?: unknown;
            errcode?: unknown; err?: { message?: unknown } };
          if (typeof item.msg === "string") diagnostics.push({ msg: item.msg,
            ...(typeof item.errcode === "string" ? { code: item.errcode }
              : typeof item.code === "string" ? { code: item.code } : {}),
            ...(item.msg === "proxy_journal_insert_failed"
              && typeof item.err?.message === "string"
              ? { detail: item.err.message.slice(0, 160) } : {}) });
        } catch { /* Only bounded codes, never raw request or credential data. */ }
      } }),
    appendCostCredits: async () => {}, broadcastToUser: () => {},
  });
  const stopHandler = makeBoxUserStopHandler({ identity,
    journal: new BoxDurableJournal(args.pool),
    coordinator: new BoxUserStopCoordinator({ journal: new BoxDurableJournal(args.pool),
      resolver: createProductionBoxAccountResolver() }) });
  const inFlight = new Map<string, Promise<void>>();
  const shapes: Array<{ requestId: string; model: unknown; keys: string[];
    toolNames: string[]; hasTurnKey: boolean; hasSessionId: boolean;
    contextManagement: unknown; thinking: unknown; outputConfig: unknown;
    messageRoles: string[];
    unsupported: string | null; planStatus: string; fingerprintOk: boolean }> = [];
  let assigned = 0;
  const server = createServer((req, res) => {
    if (args.containerInboundIp && req.socket.remoteAddress !== args.containerInboundIp) {
      diagnostics.push({ msg: "ccb_source_ip_mismatch" });
      res.writeHead(403); res.end(); return;
    }
    // Claude Code 2.1.280 sends /v1/messages?beta=true; production proxy
    // routes on URL.pathname, so this test listener must do the same.
    const path = new URL(req.url ?? "/", "http://probe.invalid").pathname;
    if (path === "/internal/box/stop") {
      void stopHandler(req, res, { hostUuid, boundIp }).catch(() => {
        if (!res.headersSent) res.writeHead(503);
        res.end();
      });
      return;
    }
    if (path !== "/v1/messages" || req.method !== "POST") {
      res.writeHead(404); res.end(); return;
    }
    const requestId = args.assignedRequestIds
      ? args.assignedRequestIds[assigned++] : req.headers["x-request-id"];
    if (typeof requestId !== "string" || inFlight.has(requestId)) {
      res.writeHead(409); res.end(); return;
    }
    req.headers["x-request-id"] = requestId;
    // Observe the real CCB continuation in memory only. No prompt, private
    // tool result, auth header, or model text is ever logged or persisted.
    if (args.assignedRequestIds?.[1] === requestId && !args.shapeOnly) {
      const originalIterator = req[Symbol.asyncIterator].bind(req);
      const parts: Buffer[] = []; let size = 0;
      const finishCapture = (): void => {
        let parseCode = "ok", assistantHash: string | null = null;
        let assistantShape: Array<{ type: string; keys: string[];
          unknownKeys: number }> = [];
        let messageRoles: string[] = [];
        try {
          if (size > 2_000_000) throw new Error("BODY_TOO_LARGE");
          const parsed = JSON.parse(Buffer.concat(parts).toString("utf8")) as ProxyBody;
          const effective = normalizeBoxSemanticBody(parsed);
          messageRoles = effective.messages.slice(0, 64).map((item) =>
            ["user", "assistant", "system"].includes(item.role) ? item.role : "<other>");
          const content = (effective.messages.at(-2) as { content?: unknown } | undefined)?.content;
          if (!Array.isArray(content)) throw new Error("ASSISTANT_NOT_ARRAY");
          assistantHash = hashBoxAssistantContent(content);
          assistantShape = content.slice(0, 64).map((block: unknown) => {
            if (!block || typeof block !== "object" || Array.isArray(block)) {
              return { type: "<other>", keys: [], unknownKeys: 0 };
            }
            const obj = block as Record<string, unknown>;
            const allowed = new Set(["type", "thinking", "signature", "data",
              "text", "id", "name", "input", "cache_control"]);
            const keys = Object.keys(obj);
            return { type: typeof obj.type === "string"
              && ["thinking", "redacted_thinking", "text", "tool_use"].includes(obj.type)
                ? obj.type : "<other>",
              keys: keys.filter((key) => allowed.has(key)).sort(),
              unknownKeys: keys.filter((key) => !allowed.has(key)).length };
          });
        } catch (error) {
          parseCode = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message)
            ? error.message : "CAPTURE_FAILED";
        }
        continuationEvidence.push({ requestId, assistantHash,
          assistantShape, messageRoles, parseCode });
      };
      // The proxy's bounded JSON reader is the only stream consumer. Capture
      // each chunk as *it* pulls, never add a data listener that starts flow
      // before async auth/rate-limit prechecks finish.
      Object.defineProperty(req, Symbol.asyncIterator, {
        configurable: true,
        value: async function* () {
          try {
            for await (const chunk of originalIterator()) {
              const part = Buffer.from(chunk);
              size += part.length;
              if (size <= 2_000_000) parts.push(part);
              yield chunk;
            }
          } finally { finishCapture(); }
        },
      });
    }
    if (args.shapeOnly) {
      void (async () => {
        if (req.headers.authorization !== `Bearer oc-v3.${containerId}.${secretHex}`
          || req.headers[LOCAL_CATALOG_HEADER] !== token) {
          diagnostics.push({ msg: "ccb_shape_auth_failed" });
          res.writeHead(401); res.end(); return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          const part = Buffer.from(chunk);
          bytes += part.length;
          if (bytes > 2_000_000) throw new Error("BOX_CCB_SHAPE_TOO_LARGE");
          chunks.push(part);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProxyBody;
        let identity: Record<string, unknown> = {};
        try {
          if (typeof body.metadata?.user_id === "string") {
            identity = JSON.parse(body.metadata.user_id) as Record<string, unknown>;
          }
        } catch { /* Preserve a malformed metadata negative as shape evidence. */ }
        let unsupported: string | null;
        try { unsupported = validateBoxRequest(body, true); }
        catch { unsupported = "BOX_SHAPE_PARSE_FAILED"; }
        let planStatus = unsupported ?? "BOX_PLAN_NOT_RUN";
        let fingerprintOk = false;
        if (unsupported === null) {
          try {
            deriveBoxCallFingerprint(UID, body);
            fingerprintOk = true;
            // Build the exact detached tool plan in memory; never execute any
            // Box request or stage a private file during this shape preflight.
            makeBoxDetachedToolPlan({ body, upstreamModel: UPSTREAM,
              maxOutputTokensLimit: 128_000,
              supervisorAsset: readFileSync(new URL("./box_supervisor.py", import.meta.url)),
              keeperAsset: readFileSync(new URL("./box_keeper.py", import.meta.url)),
              virtualMcpAsset: readFileSync(new URL("./box_virtual_mcp.py", import.meta.url)),
              detachedRunnerAsset: readFileSync(new URL("./box_detached_runner.py", import.meta.url)) });
            planStatus = "ok";
          } catch (error) {
            planStatus = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message)
              ? error.message : "BOX_PLAN_FAILED";
          }
        }
        shapes.push({ requestId, model: body.model, keys: Object.keys(body).sort(),
          toolNames: Array.isArray(body.tools) ? body.tools.map((tool) =>
            tool !== null && typeof tool === "object" && "name" in tool
              && typeof tool.name === "string" ? tool.name : "<invalid>") : [],
          contextManagement: boundedControlShape(body.context_management ?? null),
          thinking: boundedControlShape(body.thinking ?? null),
          outputConfig: boundedControlShape(body.output_config ?? null),
          messageRoles: Array.isArray(body.messages) ? body.messages.slice(0, 64)
            .map((msg) => msg && typeof msg === "object" && "role" in msg
              && typeof msg.role === "string"
              && ["user", "assistant", "system", "tool"].includes(msg.role)
              ? msg.role : "<invalid>") : [],
          hasTurnKey: typeof identity.oc_turn_key === "string"
            && /^[a-f0-9]{64}$/.test(identity.oc_turn_key),
          hasSessionId: typeof identity.session_id === "string" && !!identity.session_id,
          unsupported, planStatus, fingerprintOk });
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "BOX_CCB_SHAPE_PREFLIGHT",
          message: "intentional no-paid shape probe" } }));
      })().catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); });
      return;
    }
    const done = handler(req, res, { hostUuid, boundIp }).catch((error: unknown) => {
      diagnostics.push({ msg: "handler_exception", code: error instanceof Error
        && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "UNKNOWN" });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    inFlight.set(requestId, done);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.listenPort ?? 0, args.bindHost ?? "127.0.0.1", () => {
      server.off("error", reject); resolve();
    });
  });
  const address = server.address();
  assertion(address && typeof address !== "string", "BOX_SIGNED_LISTENER_INVALID");
  return {
    diagnostics,
    continuationEvidence,
    shapes,
    observedRequestIds(): string[] {
      return args.shapeOnly ? shapes.map((item) => item.requestId) : [...inFlight.keys()];
    },
    baseUrl: `http://${args.bindHost ?? "127.0.0.1"}:${address.port}`,
    authToken: `oc-v3.${containerId}.${secretHex}`,
    catalogToken: token,
    async call(body: ProxyBody, requestId: string): Promise<Response> {
      return fetch(`http://${args.bindHost ?? "127.0.0.1"}:${address.port}/v1/messages`, {
        method: "POST", headers: { authorization: `Bearer oc-v3.${containerId}.${secretHex}`,
          "content-type": "application/json", "anthropic-version": "2023-06-01",
          "x-request-id": requestId, [LOCAL_CATALOG_HEADER]: token },
        body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
      });
    },
    async stop(sessionId: string, turnKey: string): Promise<Response> {
      return fetch(`http://${args.bindHost ?? "127.0.0.1"}:${address.port}/internal/box/stop`, {
        method: "POST", headers: { authorization: `Bearer oc-v3.${containerId}.${secretHex}`,
          "content-type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, oc_turn_key: turnKey }),
        signal: AbortSignal.timeout(60_000),
      });
    },
    async waitHandler(requestId: string): Promise<void> {
      const pending = inFlight.get(requestId);
      assertion(pending, "BOX_SIGNED_HANDLER_UNKNOWN");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([pending, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("BOX_SIGNED_FINALIZER_TIMEOUT")), 120_000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    },
    async close(): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.allSettled([...inFlight.values()]),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); })]);
      } finally { if (timer) clearTimeout(timer); }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      secret.fill(0);
    },
  };
}

/** No adapter or remote execution layer: run the installed Claude Code CLI in
 * the existing uid3 container. Credentials travel over docker-exec stdin and
 * are never printed, put in argv, or written to a persistent file. */
async function runContainerCcbProbe(input: { baseUrl: string;
  authToken: string; catalogToken: string; turnKey: string;
  prompt?: string; expectedMarker?: string; deadlineSeconds?: number;
  localToolConfig?: { script: string; fixture: string } }): Promise<{
  exitCode: number; stdoutBytes: number; stderrBytes: number;
  stderrTail: string; stdoutEvents: Array<{ type: unknown;
    subtype: unknown; keys: string[] }>;
  initSummary: { model: unknown; apiKeySource: unknown; permissionMode: unknown;
    memoryPathCount: number; skillCount: number; toolCount: number } | null;
  toolUseCount: number; toolUseEvents: number; resultCount: number;
  malformedOutput: boolean; exactResult: boolean }> {
  const python = `import json,os,sys
cfg=json.load(sys.stdin)
env=os.environ.copy()
env["ANTHROPIC_BASE_URL"]=cfg["baseUrl"]
env["ANTHROPIC_AUTH_TOKEN"]=cfg["authToken"]
env["ANTHROPIC_CUSTOM_HEADERS"]="x-oc-local-catalog: "+cfg["catalogToken"]
env["CLAUDE_CODE_EXTRA_METADATA"]=json.dumps({"oc_turn_key":cfg["turnKey"]})
env["NO_PROXY"]="127.0.0.1,localhost,"+env.get("NO_PROXY","")
env.pop("ANTHROPIC_API_KEY",None)
env.pop("CLAUDE_CODE_OAUTH_TOKEN",None)
args=["claude","-p",cfg["prompt"],"--model","box-api-claude-opus-5-5"]
if "localToolConfig" in cfg:
    tool=cfg["localToolConfig"]
    mcp={"mcpServers":{"ocv5probe":{"type":"stdio","command":"/usr/bin/python3",
         "args":["-I",tool["script"],tool["fixture"]]}}}
    args += ["--mcp-config",json.dumps(mcp),"--strict-mcp-config",
             "--tools","",
             "--allowedTools","mcp__ocv5probe__read_secret"]
else:
    args += ["--tools","Read","--allowedTools","Read"]
args += ["--output-format","stream-json","--verbose","--no-session-persistence"]
os.execvpe("claude",args,env)
`;
  const child = spawn("docker", ["exec", "-i", "--user", "1000:1000",
    "--workdir", "/home/agent/.openclaude/workspace/ocv5-289-box-api",
    "oc-v5-u3", "/usr/bin/timeout", "-s", "TERM", "-k", "5s",
    `${input.deadlineSeconds ?? 30}s`,
    "python3", "-I", "-c", python],
  { stdio: ["pipe", "pipe", "pipe"] });
  const cfg = JSON.stringify({ baseUrl: input.baseUrl, authToken: input.authToken,
    catalogToken: input.catalogToken, turnKey: input.turnKey,
    prompt: input.prompt ?? "Reply with exactly READY. Do not use tools.",
    ...(input.localToolConfig ? { localToolConfig: input.localToolConfig } : {}) });
  child.stdin.end(cfg);
  let stdoutBytes = 0, stderrBytes = 0;
  const stdoutChunks: Buffer[] = [];
  let stderrTail = "";
  let outputExceeded = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= 2_000_000) stdoutChunks.push(Buffer.from(chunk));
    if (stdoutBytes > 2_000_000) {
      outputExceeded = true; child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2048);
    if (stderrBytes > 500_000) {
      outputExceeded = true; child.kill("SIGTERM");
    }
  });
  let hostTimedOut = false;
  const timeout = setTimeout(() => { hostTimedOut = true; child.kill("SIGTERM"); },
    (input.deadlineSeconds ?? 30) * 1000 + 15_000);
  try {
    const closed = await new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code: code ?? 1, signal }));
    });
    if (hostTimedOut || outputExceeded || closed.signal !== null) {
      throw new Error("BOX_CCB_PROCESS_UNCONFIRMED");
    }
    const stdoutRaw = Buffer.concat(stdoutChunks).toString("utf8");
    const stdoutEvents = stdoutRaw.split("\n").filter(Boolean).slice(-20).map((line) => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        return { type: value.type, subtype: value.subtype,
          keys: Object.keys(value).sort() };
      } catch { return { type: "non_json", subtype: null, keys: [] }; }
    });
    let initSummary: { model: unknown; apiKeySource: unknown;
      permissionMode: unknown; memoryPathCount: number; skillCount: number;
      toolCount: number } | null = null;
    const toolUseIds = new Set<string>();
    const expectedToolName = input.localToolConfig
      ? "mcp__ocv5probe__read_secret" : "Read";
    let exactResult = false;
    let toolUseEvents = 0, resultCount = 0, malformedOutput = false;
    let seenResult = false;
    for (const line of stdoutRaw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
          || seenResult) { malformedOutput = true; continue; }
        const value = parsed as Record<string, unknown>;
        if (value.type === "system" && value.subtype === "init") {
          initSummary = { model: value.model, apiKeySource: value.apiKeySource,
            permissionMode: value.permissionMode,
            memoryPathCount: Array.isArray(value.memory_paths) ? value.memory_paths.length : 0,
            skillCount: Array.isArray(value.skills) ? value.skills.length : 0,
            toolCount: Array.isArray(value.tools) ? value.tools.length : 0 };
        }
        if (value.type === "assistant" && value.message
          && typeof value.message === "object" && !Array.isArray(value.message)) {
          const blocks = (value.message as { content?: unknown }).content;
          if (Array.isArray(blocks)) for (const block of blocks) {
            if (block && typeof block === "object" && "type" in block
              && "name" in block && "id" in block
              && block.type === "tool_use" && block.name === expectedToolName
              && typeof block.id === "string") {
              toolUseEvents++;
              toolUseIds.add(block.id);
            }
          }
        }
        if (value.type === "result") {
          resultCount++;
          seenResult = true;
          exactResult = input.expectedMarker !== undefined
            && value.subtype === "success" && value.is_error === false
            && typeof value.result === "string"
            && value.result.trim() === input.expectedMarker;
        }
      } catch { if (line.trim()) malformedOutput = true; }
    }
    return { exitCode: closed.code, stdoutBytes, stderrBytes,
      stdoutEvents, initSummary, toolUseCount: toolUseIds.size,
      toolUseEvents, resultCount, malformedOutput, exactResult,
      stderrTail: stderrTail.replaceAll(input.authToken, "[synthetic-auth]")
        .replaceAll(input.catalogToken, "[synthetic-catalog]").slice(-300) };
  } finally { clearTimeout(timeout); }
}

async function main(): Promise<void> {
  if (process.env.OCV5_289_ACK_ACCOUNT_ID !== String(ACCOUNT_ID)
    || process.env.OCV5_289_ACK_USER_ID !== String(UID)
    || process.env.OCV5_289_SIGNED_LIVE_ACK !== "1"
    || getRuntimeChannel() !== "v5") throw new Error("BOX_SIGNED_LIVE_ACK_REQUIRED");
  const expectedContainerId = process.env.OCV5_289_EXPECT_CONTAINER_ID;
  assertion(expectedContainerId && /^[1-9][0-9]{0,9}$/.test(expectedContainerId),
    "BOX_SIGNED_CONTAINER_ID_ACK_REQUIRED");
  const cfg = loadConfig();
  const redisUrl = new URL(cfg.REDIS_URL);
  assertion(hostname() === "v3-dev-sg"
    && redisUrl.hostname === "127.0.0.1" && redisUrl.port === "6379"
    && redisUrl.pathname === "/3", "BOX_SIGNED_SELFHOST_BOUNDARY_INVALID");
  const pool = getPool();
  const client = await pool.connect();
  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 3,
    enableReadyCheck: true });
  const nonce = randomBytes(12).toString("hex");
  const sessionId = `ocv5-289-signed-${nonce}`;
  const turnKey = randomBytes(32).toString("hex");
  const firstId = `box-signed-a-${nonce}`, secondId = `box-signed-b-${nonce}`;
  const thirdId = `box-signed-c-${nonce}`;
  const thirdTurn = process.env.OCV5_291_THIRD_TURN_ACK === "1";
  if (thirdTurn && process.env.OC_BOX_NATIVE_RESUME !== "1") {
    throw new Error("BOX_NATIVE_THIRD_FLAG_REQUIRED");
  }
  const challenge = `probe-${randomBytes(8).toString("hex")}`;
  const localResult = `ocv5-289-local-${randomBytes(12).toString("hex")}`;
  const fixtureHostPath = `${WORK_HOST}/.ocv5-289-read-${nonce}.txt`;
  const fixtureContainerPath = `${WORK_CONTAINER}/.ocv5-289-read-${nonce}.txt`;
  const fixtureUsedPath = fixtureHostPath + ".used";
  let localExecutions = 0, unknownPhase: string | null = null;
  let terminal = false;
  let identityPersisted = false;
  let thirdArmed = false, thirdAdmitted = false;
  let secondTerminalCleaned = false;
  let lockHeld = false;
  let fixtureCreated = false;
  let ccbProcessUnconfirmed = false;
  let dbReady = false;
  let loopback: Awaited<ReturnType<typeof startSignedLoopback>> | null = null;
  let diagnosticStage = "setup";
  const oldModelFlag = process.env.OC_BOX_MODEL_API;
  const oldToolFlag = process.env.OC_BOX_TOOL_BRIDGE;
  const syncDirectory = (path = EVIDENCE_DIR): void => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY
      | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  const writeDurable = (path: string, raw: string): void => {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT
      | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const bytes = Buffer.from(raw);
      for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        assertion(written > 0, "BOX_TOOL_EVIDENCE_WRITE_FAILED");
        offset += written;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
  };
  const withOperatorMutex = (action: () => void): void => {
    try {
      writeDurable(OPERATOR_MUTEX, JSON.stringify({ pid: process.pid,
        createdAt: new Date().toISOString() }) + "\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("BOX_TOOL_OPERATOR_BUSY");
      }
      throw error;
    }
    syncDirectory();
    try { action(); }
    finally { unlinkSync(OPERATOR_MUTEX); syncDirectory(); }
  };
  const persistIdentity = (input: BoxJournalAdmission): void => {
    if (thirdTurn && input.requestId === thirdId) {
      assertion(lockHeld && identityPersisted && thirdArmed && !thirdAdmitted
        && input.uid === UID && input.accountId === ACCOUNT_ID,
      "BOX_TOOL_THIRD_IDENTITY_INVALID");
      withOperatorMutex(() => {
        const before = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as Record<string, unknown>;
        assertion(before.firstId === firstId && before.secondId === secondId
          && before.thirdId === thirdId && before.state === "third_preparing",
        "BOX_TOOL_THIRD_EVIDENCE_INVALID");
        const staged = `${EVIDENCE_PATH}.${nonce}.third-run.part`;
        writeDurable(staged, JSON.stringify({ ...before, state: "third_unresolved",
          thirdRunNonce: input.runNonce, thirdLeaseEpoch: input.leaseEpoch }) + "\n");
        renameSync(staged, EVIDENCE_PATH); syncDirectory();
      });
      thirdAdmitted = true;
      return;
    }
    assertion(lockHeld && !identityPersisted && input.requestId === firstId && input.uid === UID
      && input.accountId === ACCOUNT_ID, "BOX_TOOL_ATTEMPT_IDENTITY_INVALID");
    const raw = JSON.stringify({ v: 1, pid: process.pid,
      accountId: String(ACCOUNT_ID), uid: String(UID),
      firstId, secondId, sessionId, runNonce: input.runNonce,
      leaseEpoch: input.leaseEpoch, state: "unresolved",
      createdAt: new Date().toISOString() }) + "\n";
    const staged = `${EVIDENCE_PATH}.${nonce}.part`;
    writeDurable(staged, raw);
    renameSync(staged, EVIDENCE_PATH);
    syncDirectory();
    identityPersisted = true;
  };
  const armThird = (): void => {
    assertion(thirdTurn && lockHeld && identityPersisted && !thirdArmed,
      "BOX_TOOL_THIRD_ARM_INVALID");
    withOperatorMutex(() => {
      const before = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as Record<string, unknown>;
      assertion(before.firstId === firstId && before.secondId === secondId
        && before.sessionId === sessionId && before.state === "unresolved"
        && before.thirdId === undefined,
      "BOX_TOOL_THIRD_EVIDENCE_INVALID");
      const staged = `${EVIDENCE_PATH}.${nonce}.third.part`;
      writeDurable(staged, JSON.stringify({ ...before, thirdId,
        state: "third_preparing" }) + "\n");
      renameSync(staged, EVIDENCE_PATH); syncDirectory();
    });
    thirdArmed = true;
  };
  try {
    const database = await client.query<{ current_database: string }>(
      "SELECT current_database()");
    assertion(database.rows[0]?.current_database === "openclaude_v5_selfhost",
      "BOX_SIGNED_DATABASE_BOUNDARY_INVALID");
    const parent = lstatSync(EVIDENCE_PARENT);
    assertion(parent.isDirectory() && !parent.isSymbolicLink()
      && parent.uid === process.getuid()
      && (parent.mode & 0o777) === 0o700,
    "BOX_TOOL_EVIDENCE_PARENT_INVALID");
    try { mkdirSync(EVIDENCE_DIR, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Persist the newly-created child directory entry as well as files in it.
    syncDirectory(EVIDENCE_PARENT);
    const directory = lstatSync(EVIDENCE_DIR);
    assertion(directory.isDirectory() && !directory.isSymbolicLink()
      && directory.uid === process.getuid()
      && (directory.mode & 0o777) === 0o700,
    "BOX_TOOL_EVIDENCE_DIR_INVALID");
    withOperatorMutex(() => {
      try {
        writeDurable(EVIDENCE_PATH, JSON.stringify({ v: 1, pid: process.pid,
          accountId: String(ACCOUNT_ID), uid: String(UID), firstId, secondId,
          state: "preparing", createdAt: new Date().toISOString() }) + "\n");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("BOX_TOOL_PRIOR_UNKNOWN_REQUIRES_RECONCILIATION");
        }
        throw error;
      }
      syncDirectory(); lockHeld = true;
    });
    const owners = await client.query<{ id: string; bound_ip: string }>(
      `SELECT id::text,host(bound_ip) AS bound_ip FROM agent_containers
       WHERE user_id=$1 AND state='active' AND runtime_channel='v5'
         AND runtime_kind='docker' AND secret_hash IS NOT NULL`, [UID.toString()]);
    assertion(owners.rows.length === 1 && owners.rows[0]?.id === expectedContainerId,
      "BOX_SIGNED_CONTAINER_NOT_CURRENT");
    const containerId = Number(expectedContainerId);
    assertion(Number.isSafeInteger(containerId), "BOX_SIGNED_CONTAINER_ID_INVALID");
    const livePricing = new PricingCache();
    await livePricing.load();
    const directPrice = livePricing.get(UPSTREAM);
    assertion(directPrice?.enabled && directPrice.input_per_mtok > 0n
      && directPrice.input_per_mtok <= 1000n
      && directPrice.output_per_mtok > 0n
      && directPrice.output_per_mtok <= 5000n
      && directPrice.cache_read_per_mtok <= 1000n
      && directPrice.cache_write_per_mtok <= 5000n
      && multiplierToScaled(directPrice.multiplier) <= 5000n,
    "BOX_SIGNED_PRICE_UNAVAILABLE");
    // This one-off local route inherits the current selfhost Opus rate. It
    // never inserts a catalog/pricing row or exposes a public model entry.
    const price: ModelPricing = { ...directPrice, model_id: MODEL,
      display_name: "Box Claude Opus 5.5 operator canary", default_effort: null };
    const before = await client.query<{ credits: string }>(
      "SELECT credits::text FROM users WHERE id=$1", [UID.toString()]);
    assertion(before.rows.length === 1 && BigInt(before.rows[0]!.credits) > 0n,
      "BOX_SIGNED_WALLET_UNAVAILABLE");
    const initialCredits = BigInt(before.rows[0]!.credits);
    dbReady = true;
    const baseJournal = new BoxDurableJournal(pool);
    const journal = new Proxy(baseJournal, { get(target, key) {
      if (key === "admit") return async (input: BoxJournalAdmission) => {
        // fsynced before durable admission and paid CLI launch. A crash cannot
        // erase which real wallet and Box invocation need reconciliation.
        persistIdentity(input);
        return target.admit(input);
      };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const resolver = createProductionBoxAccountResolver();
    const service = new BoxToolFetch({
      supervisorAsset: readFileSync(new URL("./box_supervisor.py", import.meta.url)),
      keeperAsset: readFileSync(new URL("./box_keeper.py", import.meta.url)),
      virtualMcpAsset: readFileSync(new URL("./box_virtual_mcp.py", import.meta.url)),
      detachedRunnerAsset: readFileSync(new URL("./box_detached_runner.py", import.meta.url)),
      journal, maxOutputTokensForModel: (model) => model === MODEL ? 128_000 : null,
      resolveTarget: (args) => resolver.resolve({ ...args, requiredAccountId: ACCOUNT_ID }),
      onUnknown: async ({ phase }) => { unknownPhase ??= phase; },
    });
    const preflightOnly = process.env.OCV5_289_SIGNED_PREFLIGHT_ONLY === "1";
    const ccbPreflight = process.env.OCV5_289_CCB_PREFLIGHT_ONLY === "1";
    const ccbLive = process.env.OCV5_289_CCB_LIVE_ACK === "1";
    const signedCancel = process.env.OCV5_289_SIGNED_CANCEL_ACK === "1";
    assertion(Number(preflightOnly) + Number(ccbPreflight) + Number(ccbLive)
      + Number(signedCancel) + Number(thirdTurn) <= 1,
      "BOX_SIGNED_PROBE_MODE_CONFLICT");
    let transportCalls = 0;
    let paidCalls = 0;
    process.env.OC_BOX_MODEL_API = "1";
    process.env.OC_BOX_TOOL_BRIDGE = "1";
    loopback = await startSignedLoopback({ pool, redis, containerId,
      ...(ccbPreflight || ccbLive ? { bindHost: "127.0.0.1", listenPort: 31000,
        // Existing key-authenticated host SSH tunnel terminates on loopback;
        // no arbitrary host port is exposed across the Docker firewall.
        containerInboundIp: "127.0.0.1",
        assignedRequestIds: [firstId, secondId], shapeOnly: ccbPreflight } : {}),
      ...(thirdTurn ? { assignedRequestIds: [firstId, secondId, thirdId] } : {}),
      boxModel: { toolBridgeReady: true, fetch: (args) => {
        transportCalls++;
        if (preflightOnly || ccbPreflight) throw new Error("BOX_PREFLIGHT_TRANSPORT_CALLED");
        paidCalls++;
        return service.fetch(args);
      } }, price });
    diagnosticStage = "loopback_ready";
    if (ccbPreflight) {
      ccbProcessUnconfirmed = true;
      const result = await runContainerCcbProbe({ baseUrl: "http://127.0.0.1:31002",
        authToken: loopback.authToken, catalogToken: loopback.catalogToken, turnKey,
        prompt: "Use the local read_secret tool once and report its result.",
        localToolConfig: { script: `${WORK_CONTAINER}/scripts/ocv5-289/ccb_local_probe_mcp.py`,
          fixture: fixtureContainerPath } });
      ccbProcessUnconfirmed = false;
      const observed = loopback.observedRequestIds();
      const usage = await client.query("SELECT 1 FROM usage_records WHERE request_id=ANY($1::text[])",
        [observed]);
      process.stderr.write(JSON.stringify({ code: "BOX_CCB_PREFLIGHT_OBSERVED",
        requestIds: observed, transportCalls, paidCalls,
        exitCode: result.exitCode, stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes, stderrTail: result.stderrTail,
        stdoutEvents: result.stdoutEvents, initSummary: result.initSummary,
        shapes: loopback.shapes, diagnostics: loopback.diagnostics.slice(-8) }) + "\n");
      assertion(observed.length >= 1 && observed.length <= 2
        && transportCalls === 0 && paidCalls === 0
        && result.exitCode !== 124 && result.exitCode !== 137
        && !identityPersisted && usage.rowCount === 0
        && loopback.shapes.length === observed.length
        && loopback.shapes.every((shape) => shape.unsupported === null
          && shape.fingerprintOk && shape.planStatus === "ok"
          && shape.toolNames.length === 1
          && shape.toolNames[0] === "mcp__ocv5probe__read_secret"),
      "BOX_CCB_PREFLIGHT_INVALID");
      withOperatorMutex(() => { unlinkSync(EVIDENCE_PATH); syncDirectory(); lockHeld = false; });
      process.stdout.write(JSON.stringify({ ccbUserContainer: true, preflightOnly: true,
        requestIds: observed, transportCalls, paidCalls,
        exitCode: result.exitCode, stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
        shapes: loopback.shapes,
        diagnostics: loopback.diagnostics.slice(-12) }) + "\n");
      return;
    }
    if (ccbLive) {
      diagnosticStage = "ccb_fixture_precheck";
      const work = lstatSync(WORK_HOST);
      assertion(process.cwd() === WORK_HOST && work.isDirectory()
        && !work.isSymbolicLink(), "BOX_CCB_FIXTURE_DIR_INVALID");
      const fd = openSync(fixtureHostPath, constants.O_WRONLY | constants.O_CREAT
        | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      fixtureCreated = true;
      try {
        fchownSync(fd, 1000, 1000);
        const raw = Buffer.from(localResult + "\n");
        for (let n = 0; n < raw.length;) {
          const count = writeSync(fd, raw, n, raw.length - n);
          assertion(count > 0, "BOX_CCB_FIXTURE_WRITE_FAILED"); n += count;
        }
        fsyncSync(fd);
      } finally { closeSync(fd); }
      syncDirectory(WORK_HOST);
      diagnosticStage = "ccb_fixture_ready";
      const prompt = "Use the local read_secret tool exactly once. It has no arguments and "
        + "returns an unpredictable synthetic token held only in this OpenClaude user container. "
        + "Reply with exactly that token, without quotes or explanation. Do not guess.";
      ccbProcessUnconfirmed = true;
      diagnosticStage = "ccb_process";
      const result = await runContainerCcbProbe({ baseUrl: "http://127.0.0.1:31002",
        authToken: loopback.authToken, catalogToken: loopback.catalogToken,
        turnKey, prompt, expectedMarker: localResult, deadlineSeconds: 240,
        localToolConfig: { script: `${WORK_CONTAINER}/scripts/ocv5-289/ccb_local_probe_mcp.py`,
          fixture: fixtureContainerPath } });
      ccbProcessUnconfirmed = false;
      diagnosticStage = "ccb_process_returned";
      const observed = loopback.observedRequestIds();
      for (const id of observed) await loopback.waitHandler(id);
      const used = lstatSync(fixtureUsedPath);
      assertion(used.isFile() && !used.isSymbolicLink() && used.uid === 1000
        && (used.mode & 0o777) === 0o600 && used.nlink === 1
        && readFileSync(fixtureUsedPath, "utf8") === "1\n",
      "BOX_CCB_LOCAL_TOOL_ONCE_UNPROVEN");
      assertion(result.exitCode === 0 && result.exactResult
        && result.resultCount === 1 && !result.malformedOutput
        && result.toolUseCount === 1 && result.toolUseEvents === 1
        && observed.length === 2
        && observed[0] === firstId && observed[1] === secondId
        && transportCalls === 2 && paidCalls === 2 && unknownPhase === null,
      "BOX_CCB_LIVE_BUSINESS_RESULT_INVALID");
      const rows = await client.query<{ request_id: string; state: string;
        ctx: Record<string, unknown> }>(
        "SELECT request_id,state,ctx FROM request_finalize_journal WHERE request_id IN ($1,$2)",
        [firstId, secondId]);
      const owner = rows.rows.find((row) => row.request_id === firstId);
      const final = rows.rows.find((row) => row.request_id === secondId);
      assertion(rows.rows.length === 2 && owner?.state === "committed"
        && final?.state === "committed"
        && owner.ctx.boxState === "terminal" && !!owner.ctx.boxToolHandoff
        && final.ctx.boxState === "terminal"
        && final.ctx.boxRunNonce === owner.ctx.boxRunNonce
        && final.ctx.boxLeaseEpoch === owner.ctx.boxLeaseEpoch
        && (final.ctx.boxTerminalProof as { reason?: unknown } | undefined)?.reason
          === "worker_complete",
      "BOX_CCB_LIVE_TERMINAL_UNPROVEN");
      const usage = await client.query<{ id: string; request_id: string;
        model: string; cost: string; ledger_id: string | null }>(
        `SELECT id::text,request_id,model,cost_credits::text AS cost,ledger_id::text
           FROM usage_records WHERE user_id=$1 AND request_id IN ($2,$3)`,
        [UID.toString(), firstId, secondId]);
      const ids = usage.rows.map((row) => row.id);
      const ledger = await client.query<{ id: string; ref_id: string; delta: string }>(
        `SELECT id::text,ref_id,delta::text FROM credit_ledger
          WHERE user_id=$1 AND ref_type='usage_record' AND ref_id=ANY($2::text[])`,
        [UID.toString(), ids]);
      assertion(usage.rows.length === 2
        && new Set(usage.rows.map((row) => row.request_id)).size === 2
        && usage.rows.every((row) => {
          const charges = ledger.rows.filter((item) => item.ref_id === row.id);
          return row.model === MODEL && BigInt(row.cost) > 0n && row.ledger_id
            && charges.length >= 1 && charges.length <= 4
            && charges.some((item) => item.id === row.ledger_id)
            && charges.every((item) => BigInt(item.delta) < 0n)
            && charges.reduce((sum, item) => sum - BigInt(item.delta), 0n)
              === BigInt(row.cost);
        }), "BOX_CCB_LIVE_LEDGER_MISMATCH");
      const pendingCleanup = await service.retryTerminalCleanup();
      const cleaned = await client.query<{ status: string | null }>(
        "SELECT ctx->>'boxRemoteCleanup' AS status FROM request_finalize_journal WHERE request_id=$1",
        [secondId]);
      assertion(pendingCleanup === 0 && cleaned.rows[0]?.status === "done"
        && identityPersisted, "BOX_CCB_LIVE_CLEANUP_UNPROVEN");
      terminal = true;
      unlinkSync(fixtureUsedPath);
      unlinkSync(fixtureHostPath); syncDirectory(WORK_HOST); fixtureCreated = false;
      withOperatorMutex(() => { unlinkSync(EVIDENCE_PATH); syncDirectory(); lockHeld = false; });
      process.stdout.write(JSON.stringify({ ccbUserContainer: true,
        modelId: UPSTREAM, localReadExecutedOnce: true, exactFinal: true,
        detachedAcrossHttp: true, requestIds: observed,
        persistentUsageRows: usage.rows.length, persistentLedgerRows: ledger.rows.length,
        debitedCredits: usage.rows.reduce((n, row) => n + BigInt(row.cost), 0n).toString(),
        remoteCleanupDone: true, unknown: false,
        initSummary: result.initSummary }) + "\n");
      return;
    }
    if (preflightOnly) {
      const invalid: ProxyBody = { model: MODEL, max_tokens: 128, stream: true,
        messages: [{ role: "user", content: "synthetic preflight" }],
        metadata: { user_id: JSON.stringify({ session_id: sessionId }) } };
      const response = await loopback.call(invalid, firstId);
      const code = (await response.json().catch(() => null)) as
        { error?: { code?: string } } | null;
      await loopback.waitHandler(firstId);
      assertion(response.status === 500 && code?.error?.code === "INTERNAL"
        && loopback.diagnostics.some((item) => item.msg === "proxy_journal_insert_failed"
          && item.detail === "BOX_BILLING_TURN_KEY_INVALID")
        && transportCalls === 0 && !identityPersisted,
      "BOX_SIGNED_PREFLIGHT_INVALID");
      const rows = await client.query("SELECT 1 FROM request_finalize_journal WHERE request_id=$1",
        [firstId]);
      assertion(rows.rowCount === 0, "BOX_SIGNED_PREFLIGHT_JOURNAL_LEAK");
      withOperatorMutex(() => { unlinkSync(EVIDENCE_PATH); syncDirectory(); lockHeld = false; });
      process.stdout.write(JSON.stringify({ signedIdentity: true, paidCalls: 0,
        status: response.status, code: code.error.code, accountId: String(ACCOUNT_ID),
        diagnostics: loopback.diagnostics.slice(-8) }) + "\n");
      return;
    }
    const tools = [{ name: "local_echo", description:
      "Returns a private, unpredictable result token for the supplied value. The result is not the input and cannot be inferred without invoking this tool.",
      input_schema: { type: "object", properties: { value: { type: "string" } },
        required: ["value"] } }];
    // Opus 5.5 adaptive thinking can consume a 128-token ceiling before it
    // reaches tool_use; use the actual CCB-scale request budget for this probe.
    const first: ProxyBody = { model: MODEL, max_tokens: 8192, stream: true,
      system: "Synthetic tool-dispatch verification; no real user content. The user asks for a secret result that exists only behind local_echo. Do not guess or echo its input. Call local_echo before answering; emit no explanatory text before the call.",
      metadata: { user_id: JSON.stringify({ oc_turn_key: turnKey, session_id: sessionId }) },
      messages: [{ role: "user", content:
        `The answer is an unpredictable secret held by local_echo. Invoke local_echo exactly once with value ${challenge}. Only after receiving its result, reply with exactly that result text. A reply without the tool result is incorrect.` }],
      tools, tool_choice: { type: "auto" } };
    assertion(validateBoxToolRequest(first) === null, "BOX_SIGNED_FIXTURE_INVALID");
    const firstResponse = await loopback.call(first, firstId);
    const firstEvents = await readEvents(firstResponse);
    await loopback.waitHandler(firstId);
    const content = assistantContent(firstEvents);
    const toolUse = content.filter((block) => block.type === "tool_use");
    if (toolUse.length !== 1) {
      const finalText = content.filter((block) => block.type === "text")
        .map((block) => String(block.text ?? "")).join("");
      process.stderr.write(JSON.stringify({ code: "BOX_SIGNED_NO_TOOL_DIAGNOSTIC",
        stopReason: firstEvents.filter((item) => item.event === "message_delta")
          .map((item) => (item.data.delta as { stop_reason?: unknown } | undefined)?.stop_reason)
          .at(-1), textPreview: finalText.slice(0, 160) }) + "\n");
    }
    assertion(toolUse.length === 1 && toolUse[0]?.name === "local_echo"
      && typeof toolUse[0]?.id === "string"
      && JSON.stringify(toolUse[0]?.input) === JSON.stringify({ value: challenge }),
    "BOX_TOOL_PROBE_TOOL_USE_INVALID");
    assertion(firstEvents.some((item) => item.event === "message_delta"
      && (item.data.delta as { stop_reason?: unknown } | undefined)?.stop_reason === "tool_use"),
    "BOX_TOOL_PROBE_HANDOFF_INVALID");
    const firstBilled = await client.query<{ request_id: string }>(
      "SELECT request_id FROM usage_records WHERE request_id=$1 AND user_id=$2",
      [firstId, UID.toString()]);
    assertion(firstBilled.rows.length === 1, "BOX_SIGNED_HANDOFF_NOT_BILLED");
    if (signedCancel) {
      const stopped = await loopback.stop(sessionId, turnKey);
      const reply = await stopped.json() as { status?: unknown };
      assertion(stopped.status === 200 && reply.status === "stopped",
        "BOX_SIGNED_STOP_NOT_PROVEN");
      const row = await client.query<{ state: string; ctx: Record<string, unknown> }>(
        "SELECT state,ctx FROM request_finalize_journal WHERE request_id=$1", [firstId]);
      const ctx = row.rows[0]?.ctx;
      assertion(row.rows.length === 1 && row.rows[0]?.state === "committed"
        && ctx?.boxState === "failed_stopped"
        && ctx.boxStopOutcome === "failed" && !!ctx.boxTerminalProof
        && typeof ctx.boxRunNonce === "string" && typeof ctx.boxLeaseEpoch === "string",
      "BOX_SIGNED_STOP_JOURNAL_INVALID");
      const proof = parseBoxTerminalProof(JSON.stringify(ctx.boxTerminalProof) + "\n",
        { runNonce: ctx.boxRunNonce, leaseEpoch: ctx.boxLeaseEpoch });
      assertion(proof.reason === "keeper_stopped" || proof.reason === "worker_failed",
        "BOX_SIGNED_STOP_PROOF_INVALID");
      await service.reconcileRemoteCleanup();
      const after = await client.query<{ state: string; cleanup: string | null }>(
        "SELECT state,ctx->>'boxRemoteCleanup' AS cleanup FROM request_finalize_journal WHERE request_id=$1",
        [firstId]);
      assertion(after.rows[0]?.state === "committed" && after.rows[0]?.cleanup === "done",
        "BOX_SIGNED_STOP_CLEANUP_UNPROVEN");
      const usage = await client.query<{ id: string; cost: string }>(
        `SELECT id::text,cost_credits::text AS cost FROM usage_records
          WHERE user_id=$1 AND request_id=$2`, [UID.toString(), firstId]);
      assertion(usage.rows.length === 1 && BigInt(usage.rows[0]!.cost) > 0n,
        "BOX_SIGNED_STOP_USAGE_INVALID");
      const ledger = await client.query<{ delta: string }>(
        `SELECT delta::text FROM credit_ledger WHERE user_id=$1
          AND ref_type='usage_record' AND ref_id=$2`, [UID.toString(), usage.rows[0]!.id]);
      assertion(ledger.rows.length >= 1 && ledger.rows.length <= 4
        && ledger.rows.every((entry) => BigInt(entry.delta) < 0n)
        && ledger.rows.reduce((sum, entry) => sum - BigInt(entry.delta), 0n)
          === BigInt(usage.rows[0]!.cost), "BOX_SIGNED_STOP_LEDGER_INVALID");
      terminal = true;
      withOperatorMutex(() => { unlinkSync(EVIDENCE_PATH); syncDirectory(); lockHeld = false; });
      process.stdout.write(JSON.stringify({ signedStop: true, accountId: String(ACCOUNT_ID),
        firstId, onePaidMessage: true, remoteProof: proof.reason,
        remoteCleanupDone: true, ledgerRows: ledger.rows.length,
        debitedCredits: usage.rows[0]!.cost, replayed: false }) + "\n");
      return;
    }
    // The only tool implementation is here in OpenClaude's operator process;
    // Box receives only schema/pending/result via the virtual MCP.
    localExecutions++;
    const second: ProxyBody = { ...first, messages: [
      ...first.messages, { role: "assistant", content },
      { role: "user", content: [{ type: "tool_result",
        tool_use_id: toolUse[0]!.id, content: localResult }] },
    ] };
    const secondResponse = await loopback.call(second, secondId);
    const secondEvents = await readEvents(secondResponse);
    await loopback.waitHandler(secondId);
    const secondContent = assistantContent(secondEvents);
    const answer = secondContent
      .filter((block) => block.type === "text").map((block) => block.text).join("");
    assertion(answer.trim() === localResult && localExecutions === 1
      && unknownPhase === null, "BOX_TOOL_PROBE_FINAL_INVALID");
    const rows = await client.query<{ request_id: string; state: string;
      ctx: Record<string, unknown> }>(
      `SELECT request_id,state,ctx FROM request_finalize_journal
       WHERE request_id IN ($1,$2) ORDER BY request_id`, [firstId, secondId]);
    const ownerRow = rows.rows.find((row) => row.request_id === firstId);
    const finalRow = rows.rows.find((row) => row.request_id === secondId);
    assertion(rows.rows.length === 2 && rows.rows.every((row) => row.ctx.boxState === "terminal"
      && row.state === "committed")
      && !!ownerRow?.ctx.boxToolHandoff && !ownerRow.ctx.boxTerminalProof
      && (finalRow?.ctx.boxTerminalProof as { reason?: unknown } | undefined)?.reason
        === "worker_complete",
    "BOX_TOOL_PROBE_JOURNAL_NOT_TERMINAL");
    const finance = await client.query<{ id: string; request_id: string; model: string;
      cost_credits: string; input_tokens: string; output_tokens: string;
      ledger_id: string | null }>(
      `SELECT ur.id::text,ur.request_id,ur.model,ur.cost_credits::text,
         ur.input_tokens::text,ur.output_tokens::text,ur.ledger_id::text
       FROM usage_records ur
       WHERE ur.request_id IN ($1,$2) AND ur.user_id=$3 ORDER BY ur.request_id`,
      [firstId, secondId, UID.toString()]);
    const usageIds = finance.rows.map((row) => row.id);
    const ledger = await client.query<{ id: string; ref_id: string; delta: string;
      bucket: string; reason: string }>(
      `SELECT id::text,ref_id,delta::text,bucket,reason FROM credit_ledger
        WHERE user_id=$1 AND ref_type='usage_record' AND ref_id=ANY($2::text[])`,
      [UID.toString(), usageIds]);
    assertion(finance.rows.length === 2
      && new Set(finance.rows.map((row) => row.request_id)).size === 2
      && finance.rows.every((row) => {
        const charges = ledger.rows.filter((item) => item.ref_id === row.id);
        return row.model === MODEL
        && BigInt(row.input_tokens) >= 0n && BigInt(row.output_tokens) > 0n
        && BigInt(row.cost_credits) > 0n && row.ledger_id
        && charges.length >= 1 && charges.length <= 4
        && charges.some((item) => item.id === row.ledger_id)
        && charges.every((item) => item.reason === "chat"
          && ["period", "wallet", "org_period", "org_wallet"].includes(item.bucket)
          && BigInt(item.delta) < 0n)
        && charges.reduce((sum, item) => sum - BigInt(item.delta), 0n)
          === BigInt(row.cost_credits);
      })
      && ledger.rows.length <= 8,
    "BOX_SIGNED_REAL_LEDGER_MISMATCH");
    const debited = finance.rows.reduce((sum, row) => sum + BigInt(row.cost_credits), 0n);
    const after = await client.query<{ credits: string }>(
      "SELECT credits::text FROM users WHERE id=$1", [UID.toString()]);
    assertion(after.rows.length === 1 && BigInt(after.rows[0]!.credits) >= 0n
      && initialCredits > 0n, "BOX_SIGNED_WALLET_INVALID");
    if (!thirdTurn) terminal = true;
    const pendingCleanup = await service.retryTerminalCleanup();
    const cleanupRow = await client.query<{ cleanup: string | null }>(
      `SELECT ctx->>'boxRemoteCleanup' AS cleanup FROM request_finalize_journal
       WHERE request_id=$1`, [secondId]);
    assertion(pendingCleanup === 0 && cleanupRow.rows[0]?.cleanup === "done",
    "BOX_TOOL_PROBE_CLEANUP_UNPROVEN");
    secondTerminalCleaned = true;
    assertion(identityPersisted, "BOX_TOOL_PROBE_IDENTITY_NOT_DURABLE");
    let thirdSummary: Record<string, unknown> = {};
    if (thirdTurn) {
      diagnosticStage = "third_preflight";
      const pointer = parseBoxNativePointer(finalRow?.ctx.boxNativePointer);
      assertion(pointer && pointer.accountId === String(ACCOUNT_ID)
        && pointer.cliCwd === `/tmp/ocv5-289-run-${ownerRow?.ctx.boxRunNonce}`,
      "BOX_NATIVE_THIRD_POINTER_INVALID");
      const thirdPrompt = "Without calling tools, repeat exactly the token returned by "
        + "local_echo in the previous turn. Do not call local_echo again. "
        + "Reply with only that token.";
      const third = makeBoxThirdTurnBody({ second,
        fullAssistantContent: secondContent,
        assistantContentHash: pointer.assistantContentHash,
        turnKey: randomBytes(32).toString("hex"), sessionId,
        userPrompt: thirdPrompt });
      assertion(!thirdPrompt.includes(localResult)
        && validateBoxToolRequest(third) === null,
      "BOX_NATIVE_THIRD_FIXTURE_INVALID");
      armThird();
      diagnosticStage = "third_paid_dispatch";
      const startedThird = Date.now();
      const thirdResponse = await loopback.call(third, thirdId);
      const thirdEvents = await readEvents(thirdResponse);
      await loopback.waitHandler(thirdId);
      const thirdContent = assistantContent(thirdEvents);
      const thirdText = thirdContent.filter((block) => block.type === "text")
        .map((block) => String(block.text ?? "")).join("");
      assertion(thirdText.trim() === localResult && localExecutions === 1
        && thirdContent.every((block) => block.type !== "tool_use")
        && unknownPhase === null,
      "BOX_NATIVE_THIRD_FINAL_INVALID");
      const thirdRows = await client.query<{ request_id: string; state: string;
        ctx: Record<string, unknown> }>(
        `SELECT request_id,state,ctx FROM request_finalize_journal
          WHERE request_id=ANY($1::text[])`, [[secondId, thirdId]]);
      const secondAfter = thirdRows.rows.find((row) => row.request_id === secondId);
      const thirdAfter = thirdRows.rows.find((row) => row.request_id === thirdId);
      const thirdUsage = thirdAfter?.ctx.boxUsage as { cacheReadTokens?: unknown } | undefined;
      assertion(secondAfter?.ctx.boxNativeClaimRequestId === thirdId
        && thirdAfter?.ctx.boxNativeOwnerRequestId === secondId
        && thirdAfter.ctx.boxNativeSessionId === pointer.nativeSessionId
        && thirdAfter.ctx.boxNativeCliCwd === pointer.cliCwd
        && thirdAfter.ctx.boxAccountId === String(ACCOUNT_ID)
        && thirdAfter.ctx.boxSessionId === sessionId
        && thirdAfter.ctx.boxState === "terminal" && thirdAfter.state === "committed"
        && (thirdAfter.ctx.boxTerminalProof as { reason?: unknown } | undefined)?.reason
          === "worker_complete"
        && typeof thirdUsage?.cacheReadTokens === "number"
        && thirdUsage.cacheReadTokens > 0,
      "BOX_NATIVE_THIRD_CLAIM_UNPROVEN");
      const billed = await client.query<{ id: string; cost: string; cache_read: string }>(
        `SELECT id::text,cost_credits::text AS cost,
          cache_read_tokens::text AS cache_read FROM usage_records
          WHERE user_id=$1 AND request_id=$2`, [UID.toString(), thirdId]);
      assertion(billed.rows.length === 1 && BigInt(billed.rows[0]!.cost) > 0n
        && BigInt(billed.rows[0]!.cache_read) > 0n,
      "BOX_NATIVE_THIRD_USAGE_INVALID");
      const thirdLedger = await client.query<{ delta: string }>(
        `SELECT delta::text FROM credit_ledger WHERE user_id=$1
          AND ref_type='usage_record' AND ref_id=$2`,
        [UID.toString(), billed.rows[0]!.id]);
      assertion(thirdLedger.rows.length >= 1 && thirdLedger.rows.length <= 4
        && thirdLedger.rows.every((row) => BigInt(row.delta) < 0n)
        && thirdLedger.rows.reduce((sum, row) => sum - BigInt(row.delta), 0n)
          === BigInt(billed.rows[0]!.cost),
      "BOX_NATIVE_THIRD_LEDGER_INVALID");
      const thirdPendingCleanup = await service.retryTerminalCleanup();
      const thirdCleanup = await client.query<{ cleanup: string | null }>(
        `SELECT ctx->>'boxRemoteCleanup' AS cleanup FROM request_finalize_journal
          WHERE request_id=$1`, [thirdId]);
      assertion(thirdPendingCleanup === 0 && thirdCleanup.rows[0]?.cleanup === "done",
      "BOX_NATIVE_THIRD_CLEANUP_UNPROVEN");
      terminal = true;
      thirdSummary = { nativeResume: true, thirdRequestBound: true,
        thirdCacheReadTokens: billed.rows[0]!.cache_read,
        thirdElapsedMs: Date.now() - startedThird, thirdEventCount: thirdEvents.length,
        persistentUsageRows: 3,
        persistentLedgerRows: ledger.rows.length + thirdLedger.rows.length,
        debitedCredits: (debited + BigInt(billed.rows[0]!.cost)).toString() };
    }
    withOperatorMutex(() => {
      unlinkSync(EVIDENCE_PATH); syncDirectory(); lockHeld = false;
    });
    process.stdout.write(JSON.stringify({ accountId: String(ACCOUNT_ID),
      modelId: UPSTREAM, detachedAcrossHttp: true,
      localToolExecutions: localExecutions,
      exactFinal: true, terminalRows: rows.rows.length,
      signedContainerRoute: true, persistentUsageRows: 2,
      persistentLedgerRows: ledger.rows.length, inheritsDirectOpusPrice: true,
      debitedCredits: debited.toString(),
      firstEventCount: firstEvents.length, secondEventCount: secondEvents.length,
      remoteCleanupDone: true, unknown: false, ...thirdSummary }) + "\n");
  } catch (error) {
    if (lockHeld && thirdTurn && secondTerminalCleaned && !thirdArmed) {
      // First two paid rounds are proven complete and cleaned; no third
      // dispatch was armed. A local preflight mismatch cannot be unknown.
      try { withOperatorMutex(() => {
        unlinkSync(EVIDENCE_PATH); syncDirectory(); lockHeld = false;
      }); }
      catch { /* Retain the conservative lock on filesystem failure. */ }
    }
    if (lockHeld && !identityPersisted && !ccbProcessUnconfirmed) {
      // The durable admission wrapper has not run, so no paid CLI can have
      // started. Release this prelaunch-only reservation, still fail the probe.
      try { withOperatorMutex(() => {
        unlinkSync(EVIDENCE_PATH); syncDirectory(); lockHeld = false;
      }); }
      catch { /* Keep a conservative unknown lock on cleanup failure. */ }
    }
    if (fixtureCreated && !identityPersisted && !ccbProcessUnconfirmed) {
      try {
        try { unlinkSync(fixtureUsedPath); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        unlinkSync(fixtureHostPath); syncDirectory(WORK_HOST); fixtureCreated = false;
      }
      catch { /* Private synthetic file is safer retained than misreported removed. */ }
    }
    const observed = dbReady
      ? await client.query<{ request_id: string; ctx: Record<string, unknown> }>(
        `SELECT request_id,ctx FROM request_finalize_journal
         WHERE request_id=ANY($1::text[])`,
        [[firstId, secondId, ...(thirdTurn ? [thirdId] : [])]]).catch(() => ({ rows: [] }))
      : { rows: [] as Array<{ request_id: string; ctx: Record<string, unknown> }> };
    const evidence = observed.rows.map((row) => ({ requestId: row.request_id,
      state: row.ctx.boxState, runNonce: row.ctx.boxRunNonce,
      leaseEpoch: row.ctx.boxLeaseEpoch,
      assistantHash: row.ctx.boxToolHandoff && typeof row.ctx.boxToolHandoff === "object"
        ? (row.ctx.boxToolHandoff as { assistantContentHash?: unknown }).assistantContentHash
        : null }));
    process.stderr.write(JSON.stringify({ code: error instanceof Error
      && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : "BOX_TOOL_PROBE_FAILED",
      diagnosticStage,
      nodeErrorCode: error && typeof error === "object"
        && "code" in error && typeof error.code === "string"
        && /^[A-Z][A-Z0-9_]{0,39}$/.test(error.code) ? error.code : null,
      terminal, unknownPhase, evidencePath: lockHeld ? EVIDENCE_PATH : null,
       evidence, continuationEvidence: loopback?.continuationEvidence,
       diagnostics: loopback?.diagnostics.slice(-12) }) + "\n");
    throw error;
  } finally {
    if (oldModelFlag === undefined) delete process.env.OC_BOX_MODEL_API;
    else process.env.OC_BOX_MODEL_API = oldModelFlag;
    if (oldToolFlag === undefined) delete process.env.OC_BOX_TOOL_BRIDGE;
    else process.env.OC_BOX_TOOL_BRIDGE = oldToolFlag;
    await loopback?.close().catch(() => {});
    client.release();
    await redis.quit().catch(() => redis.disconnect());
    await closePool();
  }
}
void main().then(() => process.exit(0), (error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
    ? error.message : "BOX_TOOL_PROBE_FAILED";
  process.stderr.write(code + "\n"); process.exit(1);
});
