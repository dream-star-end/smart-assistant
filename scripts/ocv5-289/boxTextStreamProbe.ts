/** Operator-only synthetic Box model API smoke. It exercises the same
 * BoxAccountResolver -> BoxTextFetch -> Connect Exec path intended for the
 * internal Messages route, without opening a catalog model or user traffic.
 * An ambiguous result is NEVER retried; do not use this as a reconciler.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { BoxAccountResolver, createProductionBoxAccountResolver } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { BoxTextFetch } from "../../packages/commercial/src/http/proxy/boxTextFetch.js";
import { BoxInvocationRegistry } from "../../packages/commercial/src/http/proxy/boxInvocationRegistry.js";
import { readBoxTerminalProof } from "../../packages/commercial/src/http/proxy/boxTerminalProof.js";
import { BOX_INTERNAL_ENDPOINT } from "../../packages/commercial/src/http/proxy/upstream.js";
import { _UsageObserver, type ProxyBody } from "../../packages/commercial/src/http/proxy/shared.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";

const ACCOUNT_ID = 20n;
const UID = 3n;
const MODEL = "claude-opus-5-5";
function requireAck(): void {
  if (process.env.OCV5_289_ACK_ACCOUNT_ID !== String(ACCOUNT_ID)
    || process.env.OCV5_289_ACK_USER_ID !== String(UID)
    || process.env.OCV5_289_STREAM_ACK !== "1"
    || getRuntimeChannel() !== "v5") throw new Error("BOX_STREAM_OPERATOR_ACK_REQUIRED");
}

async function main(): Promise<void> {
  requireAck();
  const supervisorAsset = readFileSync(new URL("./box_supervisor.py", import.meta.url));
  const keeperAsset = readFileSync(new URL("./box_keeper.py", import.meta.url));
  const resolver: BoxAccountResolver = createProductionBoxAccountResolver();
  const registry = new BoxInvocationRegistry({ maxPerUser: 1, maxPerAccount: 1,
    leaseMs: 900_000 });
  const requestId = `ocv5-289-probe-${randomBytes(12).toString("hex")}`;
  const expected = `ocv5-289-${randomBytes(12).toString("hex")}`;
  const startedAt = process.hrtime.bigint();
  let modelTerminalAt: bigint | null = null;
  let proofIdentity: { runNonce: string; leaseEpoch: string } | null = null;
  let unknown: string | null = null;
  const service = new BoxTextFetch({ supervisorAsset, keeperAsset, registry, budgetMs: 600_000,
    // Synthetic operator probe is not a catalog request. The real route must
    // inject BoxDurableJournal; this stub cannot be used to enable traffic.
    journal: { admit: async () => {}, markRunning: async () => {},
      markPrestartStopped: async () => {},
      markUnknown: async () => {}, complete: async () => {} },
    maxOutputTokensForModel: (model) => model === MODEL ? 128_000 : null,
    resolveTarget: async (args) => {
      const target = await resolver.resolve(args);
      if (target.accountId !== ACCOUNT_ID) {
        await target.dispose?.();
        throw new Error("BOX_PROBE_ACCOUNT_MISMATCH");
      }
      return { ...target, exec: { run: async (request, opts) => {
        const modelRun = request.args[0]?.startsWith("/tmp/ocv5-289-keeper-");
        if (modelRun) {
          const proofDir = request.args[request.args.indexOf("--proof-dir") + 1];
          const leaseEpoch = request.args[request.args.indexOf("--lease-epoch") + 1];
          if (!proofDir?.startsWith("/tmp/ocv5-289-proof-") || !leaseEpoch) {
            throw new Error("BOX_PROBE_PROOF_IDENTITY_MISSING");
          }
          proofIdentity = { runNonce: proofDir.slice(-24), leaseEpoch };
        }
        const result = await target.exec.run(request, opts);
        if (modelRun) modelTerminalAt = process.hrtime.bigint();
        return result;
      } } };
    },
    onUnknown: async ({ phase }) => { unknown ??= phase; },
  });
  const body: ProxyBody = { model: MODEL, max_tokens: 128, stream: true,
    metadata: { user_id: JSON.stringify({ oc_turn_key: randomBytes(32).toString("hex"),
      session_id: requestId }) },
    system: "Synthetic OpenClaude Box model transport verification. No tools.",
    messages: [{ role: "user", content:
      `Return exactly this token, with no other words: ${expected}` }] };
  const response = await service.fetch({ uid: UID, sessionId: requestId, requestId,
    canonicalModel: MODEL, canonicalBody: body, upstreamModel: MODEL,
    url: BOX_INTERNAL_ENDPOINT,
    init: { method: "POST", body: JSON.stringify(body) } });
  if (response.status !== 200 || !response.body) throw new Error("BOX_STREAM_HTTP_INVALID");
  const reader = response.body.getReader();
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const observer = new _UsageObserver();
  let sse = "", firstDeltaAt: bigint | null = null, ended = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { ended = true; break; }
      const part = utf8.decode(next.value, { stream: true });
      sse += part;
      if (Buffer.byteLength(sse) > 1_048_576) throw new Error("BOX_STREAM_TOO_LARGE");
      observer.push(part);
      if (firstDeltaAt === null && sse.includes("event: content_block_delta")) {
        firstDeltaAt = process.hrtime.bigint();
      }
    }
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
  }
  sse += utf8.decode();
  observer.flush();
  const observed = observer.result();
  const events = [...sse.matchAll(/^event: ([a-z_]+)\ndata: ([^\n]+)$/gm)]
    .map((match) => ({ event: match[1], data: JSON.parse(match[2]!) as Record<string, unknown> }));
  const startMessage = events.find((entry) => entry.event === "message_start")?.data.message;
  const modelId = startMessage && typeof startMessage === "object"
    ? (startMessage as { model?: unknown }).model : null;
  const text = events.filter((entry) => entry.event === "content_block_delta")
    .map((entry) => (entry.data.delta as { text?: unknown } | undefined)?.text)
    .filter((value): value is string => typeof value === "string").join("");
  for (let i = 0; i < 50 && registry.counts(UID, ACCOUNT_ID).account !== 0; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  if (modelId !== MODEL || text !== expected || observed.kind !== "final"
    || firstDeltaAt === null || modelTerminalAt === null || firstDeltaAt >= modelTerminalAt
    || unknown !== null || registry.counts(UID, ACCOUNT_ID).account !== 0) {
    throw new Error("BOX_STREAM_CONTRACT_FAILED");
  }
  if (!proofIdentity) throw new Error("BOX_PROBE_PROOF_IDENTITY_MISSING");
  const recovered = await resolver.resolve({ uid: UID, sessionId: requestId,
    requestId: `${requestId}-recovery`, upstreamModel: MODEL,
    signal: new AbortController().signal });
  try {
    const proof = await readBoxTerminalProof({ target: recovered,
      expectedAccountId: ACCOUNT_ID, ...proofIdentity });
    if (proof.reason !== "worker_complete") throw new Error("BOX_PROBE_RECOVERY_INVALID");
  } finally { await recovered.dispose?.(); }
  process.stdout.write(JSON.stringify({ route: "box-text-fetch-live", accountId: String(ACCOUNT_ID),
    modelId, exact: true, firstDeltaBeforeModelTerminal: true,
    crossRequestProof: true,
    firstDeltaMs: Number((firstDeltaAt - startedAt) / 1_000_000n),
    modelTerminalMs: Number((modelTerminalAt - startedAt) / 1_000_000n),
    totalMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
    eventTypes: events.map((entry) => entry.event),
    usage: Object.fromEntries(Object.entries(observed.usage)
      .map(([key, value]) => [key, String(value)])),
    sseHash: createHash("sha256").update(sse).digest("hex").slice(0, 16),
    unknown: false, capacityReleased: true }) + "\n");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(message) ? message : "BOX_STREAM_PROBE_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
