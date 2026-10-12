import test from "node:test";
import assert from "node:assert/strict";
import type { ModelCatalogSnapshot } from "../../billing/modelCatalog.js";
import type { ModelPricing } from "../../billing/pricing.js";
import type { Logger } from "../../logging/logger.js";
import {
  BOX_SWITCH_COMPACT_MODEL,
  BOX_SWITCH_TRANSCRIPT_MAX_CHARS,
  BoxSwitchStore,
  applyBoxSwitchRecord,
  boxSwitchBoundary,
  boxSwitchPrefixDigest,
  prepareBoxSwitch,
  relabelBoxSwitchSession,
  renderBoxSwitchTranscript,
  sseText,
  type BoxSwitchDeps,
} from "./boxSwitchCompaction.js";
import type { ProxyBody } from "./shared.js";

const CHAT = "6f3cef51-641b-47b8-9319-ca2f65873dc0";
const meta = { user_id: JSON.stringify({ session_id: CHAT, oc_turn_key: "ab".repeat(32) }) };
const reminder = { type: "text", text: "<system-reminder>\nCLAUDE.md: never use git stash\n</system-reminder>",
  cache_control: { type: "ephemeral" } };
const filler = "x".repeat(4_000);

function chat(turns: number, last: unknown = { role: "user", content: "next question" }): unknown[] {
  const messages: unknown[] = [{ role: "user", content: [reminder, { type: "text", text: "start" }] }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${i} ${filler}` }] });
    messages.push({ role: "user", content: [{ type: "text", text: `question ${i + 1}` }] });
  }
  messages.pop();
  messages.push(last);
  return messages;
}
const body = (messages: unknown[], model = "box-claude-opus-5-5"): ProxyBody =>
  ({ model, max_tokens: 32_000, stream: true, system: "sys", messages, metadata: meta }) as unknown as ProxyBody;

test("the boundary is the user message that opened the turn in progress", () => {
  const toolRound = chat(3, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] });
  assert.equal(boxSwitchBoundary(chat(3)), 6);
  assert.equal(boxSwitchBoundary(toolRound), 4, "a tool result is not a turn start");
  assert.equal(boxSwitchBoundary([{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }]), null);
});

test("moving cache markers do not change the compacted prefix", () => {
  const a = chat(3);
  const b = structuredClone(a) as Array<{ content: Array<Record<string, unknown>> }>;
  Reflect.deleteProperty(b[0]!.content[0]!, "cache_control");
  b[2]!.content[0]!.cache_control = { type: "ephemeral" };
  assert.equal(boxSwitchPrefixDigest(a, 6), boxSwitchPrefixDigest(b, 6));
  (b[1]!.content[0]! as { text: string }).text = "edited";
  assert.notEqual(boxSwitchPrefixDigest(a, 6), boxSwitchPrefixDigest(b, 6));
});

test("the transcript shows roles, tool calls and results, and keeps start and end when too long", () => {
  const messages = [{ role: "user", content: "fix it" },
    { role: "assistant", content: [{ type: "thinking", thinking: "hidden" },
      { type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "a.ts" }] }] },
    { role: "user", content: "next" }];
  const text = renderBoxSwitchTranscript(messages, 3);
  assert.match(text, /\[0\] User:\nfix it/);
  assert.match(text, /\[1\] Assistant:\n\[tool call Bash\] \{"command":"ls"\}/);
  assert.match(text, /\[tool result\] a\.ts/);
  assert.doesNotMatch(text, /hidden|next/);
  const long = [{ role: "user", content: "FIRST" }, ...Array.from({ length: 200 }, (_, i) =>
    ({ role: i % 2 ? "user" : "assistant", content: `${i} ${"y".repeat(5_000)}` })), { role: "user", content: "LAST" }];
  const clipped = renderBoxSwitchTranscript(long, long.length);
  assert.ok(clipped.length < BOX_SWITCH_TRANSCRIPT_MAX_CHARS + 200);
  assert.match(clipped, /FIRST/);
  assert.match(clipped, /LAST/);
  assert.match(clipped, /characters of the middle of the conversation are not shown/);
});

test("a record rewrites the history it was made from and nothing else", () => {
  const messages = chat(3);
  const record = { boundary: 6, prefixDigest: boxSwitchPrefixDigest(messages, 6), summary: "S".repeat(300),
    cliSessionId: CHAT, reminders: [{ type: "text", text: reminder.text }] };
  const later = [...messages, { role: "assistant", content: "answer" }, { role: "user", content: "more" }];
  const b = body(later);
  assert.equal(applyBoxSwitchRecord(b, record), true);
  const out = b.messages as unknown as Array<{ role: string; content: Array<{ text?: string }> }>;
  assert.equal(out.length, 3);
  assert.equal(out[0]!.content[0]!.text, reminder.text, "Claude Code's user context stays first");
  assert.match(out[0]!.content[1]!.text!, /<summary>\nS{300}\n<\/summary>/);
  assert.match(out[0]!.content[1]!.text!, new RegExp(`/run/oc/claude-config/projects/\\*/${CHAT}\\.jsonl`));
  assert.equal(out[0]!.content[2]!.text, "next question", "the turn in progress follows unchanged");
  const edited = structuredClone(later) as Array<{ content: unknown }>;
  edited[1]!.content = "a different answer";
  assert.equal(applyBoxSwitchRecord(body(edited), record), false, "a different history is left alone");
});

test("sseText collects only text deltas", () => {
  const raw = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"no"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}',
  ].join("\n\n");
  assert.equal(sseText(raw), "Hello");
});

function harness(over: { mustMove?: boolean; summary?: string; fail?: boolean; insufficient?: boolean } = {}) {
  const pricing = { model_id: BOX_SWITCH_COMPACT_MODEL, display_name: "Haiku", input_per_mtok: 100n,
    output_per_mtok: 500n, cache_read_per_mtok: 10n, cache_write_per_mtok: 125n, multiplier: "1.000",
    enabled: true } as unknown as ModelPricing;
  const snapshot = {
    resolve: (m: string) => m === BOX_SWITCH_COMPACT_MODEL
      ? { providerId: "box_cli", upstreamModelId: "claude-haiku-5-5" } : null,
    billingPricingFor: (m: string) => m === BOX_SWITCH_COMPACT_MODEL ? pricing : null,
  } as unknown as ModelCatalogSnapshot;
  const calls: Array<Record<string, unknown>> = [];
  const journal: Array<Record<string, unknown>> = [];
  const settled: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const summary = over.summary ?? `## 1. Rules\n- ${"kept fact ".repeat(40)}`;
  const store = new BoxSwitchStore();
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":40000,"output_tokens":0}}}',
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: summary } })}`,
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":900}}',
    'event: message_stop\ndata: {"type":"message_stop"}', ""].join("\n\n");
  const deps: BoxSwitchDeps = {
    pgPool: {} as BoxSwitchDeps["pgPool"], preCheckRedis: {} as BoxSwitchDeps["preCheckRedis"],
    scheduler: {} as BoxSwitchDeps["scheduler"], store, endpoint: "box://internal",
    chatMustMove: () => over.mustMove ?? true,
    fetch: async (args) => {
      calls.push(args as unknown as Record<string, unknown>);
      if (over.fail) throw new Error("BOX_TARGET_UNAVAILABLE");
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
    log: { info: (_m: string, f: Record<string, unknown>) => logs.push(f), warn: () => {}, error: () => {} } as unknown as Logger,
    billing: {
      preCheck: (async (_r: unknown, a: { requestId: string; maxCost: bigint }) => {
        if (over.insufficient) {
          const { InsufficientCreditsError } = await import("../../billing/preCheck.js");
          throw new InsufficientCreditsError(0n, a.maxCost);
        }
        return { maxCost: a.maxCost, reservation: { requestId: a.requestId }, capped: false };
      }) as never,
      startJournal: (async (_p: unknown, row: Record<string, unknown>) => { journal.push(row); return true; }) as never,
      release: (async () => {}) as never,
      finalizer: ((_d: unknown, ctx: { requestId: string; model: string }) => ({
        commit: async (obs: { kind: string }) => { settled.push(`commit:${ctx.model}:${obs.kind}`);
          return { state: "committed", finalCredits: 5n, requestId: ctx.requestId }; },
        fail: async () => { settled.push("fail"); return { state: "aborted", finalCredits: 0n }; },
        failClient: async () => ({ state: "aborted", finalCredits: 0n }),
      })) as never,
    },
  };
  const input = (b: ProxyBody) => ({ uid: 3n, containerId: 9n, requestId: "req-1", body: b, snapshot,
    deniedModelIds: new Set<string>(), sessionId: "web-1", authority: null,
    signal: new AbortController().signal });
  return { deps, input, calls, journal, settled, logs, store, summary };
}

test("a long chat that must leave its login is compacted by Haiku, billed on its own row, then continues from the summary", async () => {
  const h = harness();
  const messages = chat(40);
  const b = body(messages);
  const out = await prepareBoxSwitch(h.deps, h.input(b));
  assert.equal(out.kind, "compacted");
  assert.equal(h.calls.length, 1);
  const call = h.calls[0]! as { canonicalModel: string; upstreamModel: string; requestId: string;
    canonicalBody: ProxyBody; init: { body: string } };
  assert.equal(call.canonicalModel, BOX_SWITCH_COMPACT_MODEL);
  assert.equal(call.upstreamModel, "claude-haiku-5-5");
  assert.equal(JSON.parse(call.init.body).model, "claude-haiku-5-5");
  assert.equal(call.requestId, "req-1-switch-compact", "its own request id, so its own usage row");
  assert.match(JSON.stringify(call.canonicalBody.messages), /answer 39/);
  assert.equal(h.journal[0]!.model, BOX_SWITCH_COMPACT_MODEL);
  assert.equal(h.journal[0]!.requestId, "req-1-switch-compact");
  assert.deepEqual(h.settled, [`commit:${BOX_SWITCH_COMPACT_MODEL}:final`], "billed at the Haiku price from its usage");
  const rewritten = b.messages as unknown as Array<{ content: Array<{ text?: string }> }>;
  assert.equal(rewritten.length, 1);
  assert.match(rewritten[0]!.content[1]!.text!, /kept fact/);
  assert.equal(rewritten[0]!.content.at(-1)!.text, "next question");
  assert.ok(out.kind === "compacted" && out.tokensAfter < out.tokensBefore / 10);

  // The next request of the chat (full history from the container) gets the same rewrite, no new call.
  const next = body([...messages, { role: "assistant", content: "done" }, { role: "user", content: "and now?" }]);
  const again = harness({ mustMove: false });
  Object.assign(again.deps, { store: h.store });
  assert.deepEqual(await prepareBoxSwitch(again.deps, again.input(next)), { kind: "applied", boundary: 80 });
  assert.equal(again.calls.length, 0);
  assert.equal((next.messages as unknown[]).length, 3);
});

test("nothing happens while the login has quota left, for short chats or mid tool round", async () => {
  const stay = harness({ mustMove: false });
  const b = body(chat(40));
  assert.deepEqual(await prepareBoxSwitch(stay.deps, stay.input(b)), { kind: "none" });
  assert.equal((b.messages as unknown[]).length, 81);
  const short = harness();
  assert.deepEqual(await prepareBoxSwitch(short.deps, short.input(body(chat(3)))), { kind: "skipped", reason: "short" });
  const tool = harness();
  const mid = body(chat(40, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }));
  assert.deepEqual(await prepareBoxSwitch(tool.deps, tool.input(mid)), { kind: "skipped", reason: "not_turn_start" });
  for (const h of [short, tool]) assert.equal(h.calls.length, 0);
});

test("a Haiku chat is compacted the same way (operator plan: every switch compacts)", async () => {
  const h = harness();
  const out = await prepareBoxSwitch(h.deps, h.input(body(chat(40), BOX_SWITCH_COMPACT_MODEL)));
  assert.equal(out.kind, "compacted");
  assert.equal(h.calls.length, 1);
});

test("a failed or unaffordable compaction leaves the full context and charges nothing", async () => {
  const failed = harness({ fail: true });
  const b = body(chat(40));
  assert.deepEqual(await prepareBoxSwitch(failed.deps, failed.input(b)), { kind: "skipped", reason: "compaction_failed" });
  assert.deepEqual(failed.settled, ["fail"]);
  assert.equal((b.messages as unknown[]).length, 81);
  const poor = harness({ insufficient: true });
  assert.deepEqual(await prepareBoxSwitch(poor.deps, poor.input(body(chat(40)))),
    { kind: "skipped", reason: "insufficient_credits" });
  assert.equal(poor.calls.length, 0);
  const empty = harness({ summary: "too short" });
  const e = body(chat(40));
  assert.deepEqual(await prepareBoxSwitch(empty.deps, empty.input(e)), { kind: "skipped", reason: "compaction_empty" });
  assert.equal((e.messages as unknown[]).length, 81, "an empty summary is billed (the call ran) but not used");
});

test("the compaction row is relabelled to the chat's final session id, and only that row", async () => {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const pool = { query: async (sql: string, params: unknown[]) => { seen.push({ sql, params });
    return { rowCount: 1, rows: [] }; } };
  assert.equal(await relabelBoxSwitchSession(pool as never, { uid: 3n,
    billingRequestId: "req-1-switch-compact", sessionId: "g385chat" }), true);
  assert.match(seen[0]!.sql, /UPDATE usage_records SET session_id = \$3\s+WHERE user_id = \$1 AND request_id = \$2/);
  assert.deepEqual(seen[0]!.params, ["3", "req-1-switch-compact", "g385chat"]);
  assert.doesNotMatch(seen[0]!.sql, /cost|credit|ledger|journal/i, "statistics only");
});
