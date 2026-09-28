/** Read-only, bounded structural evidence for one pinned Box run. No prompt,
 * result text, tool input, or credential may be printed. No paid CLI launch. */
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createProductionBoxAccountResolver } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { makeBoxDetachedRunAccess } from
  "../../packages/commercial/src/http/proxy/boxDetachedRunAccess.js";
import { readBoxSpoolChunk } from
  "../../packages/commercial/src/http/proxy/boxSpoolRead.js";
import { readBoxTerminalProof } from
  "../../packages/commercial/src/http/proxy/boxTerminalProof.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";

function requireValue(ok: unknown): asserts ok { if (!ok) throw new Error("BOX_READ_BOUNDARY_INVALID"); }
async function main(): Promise<void> {
  requireValue(hostname() === "v3-dev-sg" && getRuntimeChannel() === "v5"
    && process.env.OC_USER_ID === "3"
    && process.env.OCV5_291_READ_ACK === "1");
  const requestId = process.env.OCV5_291_EXPECT_REQUEST_ID;
  const runNonce = process.env.OCV5_291_EXPECT_RUN_NONCE;
  const leaseEpoch = process.env.OCV5_291_EXPECT_LEASE_EPOCH;
  const runnerHash = process.env.OCV5_291_EXPECT_RUNNER_HASH;
  const handoffOffset = Number(process.env.OCV5_291_HANDOFF_OFFSET);
  requireValue(/^[a-f0-9]{32}$/.test(requestId ?? "")
    && /^[a-f0-9]{24}$/.test(runNonce ?? "")
    && /^[a-f0-9]{32}$/.test(leaseEpoch ?? "")
    && /^[a-f0-9]{64}$/.test(runnerHash ?? "")
    && Number.isSafeInteger(handoffOffset) && handoffOffset >= 0);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 90_000);
  const resolver = createProductionBoxAccountResolver();
  let target: Awaited<ReturnType<typeof resolver.resolve>> | undefined;
  try {
    target = await resolver.resolve({ uid: 3n, sessionId: null,
      requestId: requestId!, upstreamModel: "claude-opus-5-5",
      requiredAccountId: 20n, allowWakeIfHibernated: false,
      signal: abort.signal });
    requireValue(target.accountId === 20n && !abort.signal.aborted);
    const proof = await readBoxTerminalProof({ target, expectedAccountId: 20n,
      runNonce: runNonce!, leaseEpoch: leaseEpoch!, signal: abort.signal });
    const access = makeBoxDetachedRunAccess({ runNonce: runNonce!,
      detachedRunnerHash: runnerHash! });
    const types: Record<string, number> = {};
    const afterHandoff: Record<string, number> = {};
    const last: Array<Record<string, unknown>> = [];
    const messages: Array<Record<string, unknown>> = [];
    let currentMessage: Record<string, unknown> | null = null;
    let bytePosition = 0, toolUseBlocks = 0, toolResultBlocks = 0;
    let finalUsage: Record<string, number> | null = null;
    let offset = 0, rows = 0, eof = false;
    const chunks: Buffer[] = [];
    for (let read = 0; read < 128 && offset < 8 * 1024 * 1024; read++) {
      const chunk = await readBoxSpoolChunk({ exec: target.exec, plan: access,
        offset, signal: abort.signal });
      if (chunk.bytes.length === 0) { eof = true; break; }
      offset = chunk.nextOffset;
      chunks.push(chunk.bytes);
    }
    const raw = Buffer.concat(chunks);
    const spoolSha256 = createHash("sha256").update(raw).digest("hex");
    const secondEof = await readBoxSpoolChunk({ exec: target.exec, plan: access,
      offset, signal: abort.signal });
    const secondProof = await readBoxTerminalProof({ target,
      expectedAccountId: 20n, runNonce: runNonce!, leaseEpoch: leaseEpoch!,
      signal: abort.signal });
    requireValue(eof && secondEof.bytes.length === 0
      && isDeepStrictEqual(secondProof, proof));
    const lines = raw.toString("utf8").split("\n");
    const tail = lines.pop() ?? "";
    const allowed = new Set(["system", "assistant", "user", "result",
      "rate_limit_event", "stream_event", "tool_progress",
      "tool_use_summary", "auth_status"]);
    for (const line of lines) {
        let value: Record<string, unknown>;
        try { value = JSON.parse(line) as Record<string, unknown>; }
        catch { throw new Error("BOX_READ_SPOOL_INVALID"); }
        requireValue(value && typeof value === "object" && !Array.isArray(value));
        const kind = typeof value.type === "string" && allowed.has(value.type)
          ? value.type : "other";
        types[kind] = (types[kind] ?? 0) + 1;
        if (bytePosition >= handoffOffset) {
          afterHandoff[kind] = (afterHandoff[kind] ?? 0) + 1;
        }
        const lineStart = bytePosition;
        bytePosition += Buffer.byteLength(line) + 1;
        rows++;
        const event = value.event && typeof value.event === "object"
          ? value.event as Record<string, unknown> : null;
        const delta = event?.delta && typeof event.delta === "object"
          ? event.delta as Record<string, unknown> : null;
        const block = event?.content_block && typeof event.content_block === "object"
          ? event.content_block as Record<string, unknown> : null;
        if (event?.type === "message_start") {
          requireValue(currentMessage === null && messages.length < 16);
          const started = event.message && typeof event.message === "object"
            ? event.message as Record<string, unknown> : null;
          const usage = started?.usage && typeof started.usage === "object"
            ? started.usage as Record<string, unknown> : null;
          requireValue(usage !== null);
          const tokens = ["input_tokens", "output_tokens",
            "cache_read_input_tokens", "cache_creation_input_tokens"];
          currentMessage = { startOffset: lineStart,
            inputTokens: Number(usage.input_tokens ?? 0),
            outputTokens: Number(usage.output_tokens ?? 0),
            cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
            cacheWriteTokens: Number(usage.cache_creation_input_tokens ?? 0) };
          requireValue(tokens.every((key) => Number.isSafeInteger(usage[key] ?? 0)
            && Number(usage[key] ?? 0) >= 0));
        }
        if (event?.type === "message_delta") {
          requireValue(currentMessage !== null);
          const usage = event.usage && typeof event.usage === "object"
            ? event.usage as Record<string, unknown> : null;
          requireValue(usage !== null && Number.isSafeInteger(usage.output_tokens)
            && Number(usage.output_tokens) >= 0);
          currentMessage.outputTokens = Number(usage.output_tokens);
          currentMessage.stopReason = typeof delta?.stop_reason === "string"
            && ["tool_use", "end_turn", "max_tokens", "stop_sequence"]
              .includes(delta.stop_reason) ? delta.stop_reason : "other";
        }
        if (event?.type === "message_stop") {
          requireValue(currentMessage !== null && currentMessage.stopReason !== undefined);
          currentMessage.endOffset = bytePosition;
          currentMessage.afterHandoff = Number(currentMessage.startOffset) >= handoffOffset;
          messages.push(currentMessage);
          currentMessage = null;
        }
        if (event?.type === "content_block_start" && block?.type === "tool_use")
          toolUseBlocks++;
        const message = value.message && typeof value.message === "object"
          ? value.message as Record<string, unknown> : null;
        if (kind === "user" && Array.isArray(message?.content)) {
          toolResultBlocks += message.content.filter((item: unknown) => item
            && typeof item === "object" && !Array.isArray(item)
            && (item as { type?: unknown }).type === "tool_result").length;
        }
        if (kind === "result" && value.usage && typeof value.usage === "object") {
          const usage = value.usage as Record<string, unknown>;
          finalUsage = Object.fromEntries(["input_tokens", "output_tokens",
            "cache_read_input_tokens", "cache_creation_input_tokens"]
            .filter((key) => Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0)
            .map((key) => [key, Number(usage[key])]));
        }
        last.push({ type: kind,
          subtype: ["success", "error", "error_during_execution",
            "error_max_turns"].includes(String(value.subtype)) ? value.subtype : null,
          isError: value.is_error === true,
          event: ["message_start", "content_block_start", "content_block_delta",
            "content_block_stop", "message_delta", "message_stop", "ping"]
            .includes(String(event?.type)) ? event!.type : null,
          stopReason: ["tool_use", "end_turn", "max_tokens", "stop_sequence"]
            .includes(String(delta?.stop_reason)) ? delta!.stop_reason : null });
        if (last.length > 12) last.shift();
    }
    const summed = { input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    for (const message of messages) {
      summed.input_tokens += Number(message.inputTokens);
      summed.output_tokens += Number(message.outputTokens);
      summed.cache_read_input_tokens += Number(message.cacheReadTokens);
      summed.cache_creation_input_tokens += Number(message.cacheWriteTokens);
    }
    requireValue(currentMessage === null && finalUsage !== null
      && Object.entries(summed).every(([key, value]) => finalUsage![key] === value));
    process.stdout.write(JSON.stringify({ requestId, proofReason: proof.reason,
      proofRevision: proof.revision, spoolBytes: offset, spoolSha256, rows, eof,
      incompleteTailBytes: Buffer.byteLength(tail), types, afterHandoff,
      toolUseBlocks, toolResultBlocks, finalUsage, summed, messages, last,
      paidLaunches: 0, toolWrites: 0 }) + "\n");
  } finally {
    clearTimeout(timer);
    if (target) await Promise.race([Promise.resolve().then(() => target!.dispose?.())
      .catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error && /^BOX_[A-Z0-9_]+$/.test(error.message)
    ? error.message + "\n" : "BOX_READ_FAILED\n");
  process.exitCode = 1;
});
