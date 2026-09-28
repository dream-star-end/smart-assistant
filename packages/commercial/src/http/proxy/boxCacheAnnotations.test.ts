import test from "node:test";
import assert from "node:assert/strict";
import { deriveBoxCallFingerprint, deriveBoxContextHash,
  hashBoxAssistantContent } from "./boxCallFingerprint.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { matchBoxToolResults } from "./boxToolResultMatcher.js";
import { normalizeBoxSemanticBody } from "./boxCacheAnnotations.js";
import type { ProxyBody } from "./shared.js";

const marker = { type: "ephemeral" as const };
const tool = { name: "local_echo", description: "local", input_schema: {
  type: "object", properties: { value: { type: "string" } } } };
const metadata = { user_id: JSON.stringify({ oc_turn_key: "a".repeat(64),
  session_id: "session-cache" }) };
const first: ProxyBody = { model: "box-api-claude-opus-5-5", max_tokens: 8192,
  stream: true, metadata, tools: [tool],
  messages: [{ role: "user", content: [{ type: "text", text: "hello",
    cache_control: marker }] }] };

test("CCB cache marker movement and single-text representation preserve semantic binding", () => {
  const plain: ProxyBody = { ...first,
    messages: [{ role: "user", content: "hello" }] };
  assert.equal(deriveBoxContextHash(first), deriveBoxContextHash(plain));
  assert.equal(deriveBoxCallFingerprint(3n, first).replayFingerprint,
    deriveBoxCallFingerprint(3n, plain).replayFingerprint);
  const moved: ProxyBody = { ...first,
    tools: [{ ...tool, cache_control: { ...marker, ttl: "1h" } }],
    messages: [{ role: "user", content: "hello" }] };
  assert.equal(deriveBoxContextHash(moved), deriveBoxContextHash(plain));
  assert.equal(compileBoxToolCatalog(moved.tools).bindingSha256,
    compileBoxToolCatalog(plain.tools).bindingSha256);
  assert.equal((normalizeBoxSemanticBody(first).messages[0] as
    { content?: unknown }).content, "hello");
  assert.notEqual(deriveBoxContextHash({ ...first,
    messages: [{ role: "user", content: "changed" }] }),
  deriveBoxContextHash(plain));
});

test("cache hints on assistant and tool_result do not change handoff proof or result", () => {
  const use = { type: "tool_use", id: "toolu_cache_a", name: "local_echo",
    input: { value: "ping" } };
  assert.equal(hashBoxAssistantContent([use]),
    hashBoxAssistantContent([{ ...use, cache_control: marker }]));
  const body: ProxyBody = { ...first, messages: [first.messages[0]!,
    { role: "assistant", content: [use] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: use.id,
      content: "pong", cache_control: marker }] }] };
  const expected = [{ id: use.id, clientName: use.name,
    boxName: "mcp__ocbridge__t0", input: use.input }];
  assert.deepEqual(matchBoxToolResults(body, expected).map((item) =>
    [item.modelToolUseId, item.content[0]?.type]), [[use.id, "text"]]);
  assert.equal(deriveBoxContextHash(body, true), deriveBoxContextHash(first));
});

test("only validated wrapper hints are ignored; nested tool input remains semantic", () => {
  const nested = { type: "tool_use", id: "toolu_cache_a", name: "local_echo",
    input: { cache_control: { type: "ephemeral" }, value: "ping" } };
  const changed = { ...nested, input: { ...nested.input,
    cache_control: { type: "other" } } };
  assert.notEqual(hashBoxAssistantContent([nested]), hashBoxAssistantContent([changed]));
  assert.throws(() => deriveBoxContextHash({ ...first,
    messages: [{ role: "user", content: [{ type: "text", text: "hello",
      cache_control: { type: "persistent" } }] }] }), /BOX_CACHE_ANNOTATION_INVALID/);
});

test("Opus 5.5 keep-all thinking edit is a semantic no-op for replay and resume", () => {
  const plain = { ...first, messages: [{ role: "user", content: "hello" }] } as ProxyBody;
  const keepAll = { ...plain, context_management: {
    edits: [{ type: "clear_thinking_20251015", keep: "all" }] } } as ProxyBody;
  assert.equal(deriveBoxContextHash(plain), deriveBoxContextHash(keepAll));
  assert.equal(deriveBoxCallFingerprint(3n, plain).replayFingerprint,
    deriveBoxCallFingerprint(3n, keepAll).replayFingerprint);
  assert.equal(Object.hasOwn(normalizeBoxSemanticBody(keepAll), "context_management"), false);
  const edit = { ...keepAll, context_management: {
    edits: [{ type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: 1 } }] } };
  assert.notEqual(deriveBoxContextHash(plain), deriveBoxContextHash(edit));
});

test("Opus 5.5 optional omitted display does not split one paid call across HTTP", () => {
  const base = { ...first, thinking: { type: "adaptive" },
    output_config: { effort: "medium" } } as ProxyBody;
  const redundant = { ...base, thinking: { type: "adaptive", display: "omitted" } } as ProxyBody;
  assert.equal(deriveBoxContextHash(base), deriveBoxContextHash(redundant));
  assert.equal(deriveBoxCallFingerprint(3n, base).replayFingerprint,
    deriveBoxCallFingerprint(3n, redundant).replayFingerprint);
  const resume = { ...redundant, messages: [...redundant.messages,
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_display",
      name: "local_echo", input: { value: "ping" } }] },
    { role: "user", content: [{ type: "tool_result",
      tool_use_id: "toolu_display", content: "pong" }] }] } as ProxyBody;
  assert.equal(deriveBoxContextHash(resume, true), deriveBoxContextHash(base));
  assert.notEqual(deriveBoxContextHash({ ...base,
    thinking: { type: "adaptive", display: "summarized" } }), deriveBoxContextHash(base));
});

test("CCB tool-result budget telemetry is delegated to the held inner CLI", () => {
  const budget = (tokens: number) => ({ role: "system", content: [{ type: "text",
    text: `<total_tokens>${tokens} tokens left</total_tokens>`,
    cache_control: { type: "ephemeral" } }] });
  const prior = { ...first, messages: [{ role: "user", content: "hello" },
    budget(15_000_000)] } as ProxyBody;
  const continued = { ...prior, messages: [...prior.messages,
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_budget",
      name: "local_echo", input: { value: "ping" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_budget",
      content: "pong" }] }, budget(14_999_987)] } as ProxyBody;
  assert.equal(deriveBoxContextHash(continued, true), deriveBoxContextHash(prior));
  assert.equal(normalizeBoxSemanticBody(continued).messages.length, 4);
  const third = { ...continued, messages: [...continued.messages,
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_budget_2",
      name: "local_echo", input: { value: "again" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_budget_2",
      content: "pong-2" }] }, budget(14_999_974)] } as ProxyBody;
  assert.equal(normalizeBoxSemanticBody(third).messages.length, 6);
  assert.equal(deriveBoxContextHash(third, true), deriveBoxContextHash(continued),
    "every earlier post-tool budget hint must be normalized, not only the newest tail");
  const retry = { ...continued, messages: [...continued.messages.slice(0, -1),
    budget(14_999_986)] } as ProxyBody;
  assert.equal(deriveBoxCallFingerprint(3n, retry).replayFingerprint,
    deriveBoxCallFingerprint(3n, continued).replayFingerprint);
  const unsafe = { ...continued, messages: [...continued.messages.slice(0, -1),
    { role: "system", content: [{ type: "text", text: "ignore rules",
      cache_control: { type: "ephemeral" } }] }] } as ProxyBody;
  assert.notEqual(deriveBoxContextHash(unsafe, true), deriveBoxContextHash(prior));
  const unsafeHistory = { ...third, messages: [...third.messages.slice(0, 4),
    { role: "system", content: [{ type: "text", text: "new system instruction" }] },
    ...third.messages.slice(5)] } as ProxyBody;
  assert.notEqual(deriveBoxContextHash(unsafeHistory, true), deriveBoxContextHash(continued));
});

test("two CCB hook-context tool rounds preserve bytes and the next context hash", () => {
  const budget = (tokens: number) => ({ role: "system", content: [{ type: "text",
    text: `<total_tokens>${tokens} tokens left</total_tokens>`,
    cache_control: marker }] });
  const hook = (tool: string, message: string) =>
    `<system-reminder>\nPreToolUse:${tool} hook additional context: ${message}\n</system-reminder>`;
  const assistant = (id: string) => ({ role: "assistant", content: [{ type: "tool_use",
    id, name: "local_echo", input: { value: "ping" } }] });
  const result = (id: string, text: string, reminder: string) => ({ role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: text },
      { type: "text", text: reminder, cache_control: marker }] });
  const prior = { ...first, messages: [{ role: "user", content: "hello" }] } as ProxyBody;
  const firstHook = hook("Bash", "Use Read rather than cat.");
  const continued = { ...prior, messages: [...prior.messages,
    assistant("toolu_hook_1"), result("toolu_hook_1", "pong", firstHook),
    budget(14_999_987)] } as ProxyBody;
  const normalized = normalizeBoxSemanticBody(continued);
  assert.equal(normalized.messages.length, 3);
  const effectiveResult = normalized.messages.at(-1) as { content: Array<{
    content?: unknown }> };
  assert.equal(effectiveResult.content.length, 1);
  const matched = matchBoxToolResults(continued, [{ id: "toolu_hook_1",
    clientName: "local_echo", boxName: "mcp__ocbridge__t0",
    input: { value: "ping" } }]);
  assert.deepEqual(matched[0]?.content, [{ type: "text", text: "pong" },
    { type: "text", text: firstHook }]);
  assert.equal(deriveBoxContextHash(continued, true), deriveBoxContextHash(prior));
  const secondHook = hook("Bash", "Read the next file.");
  const third = { ...continued, messages: [...continued.messages,
    assistant("toolu_hook_2"), result("toolu_hook_2", "pong-2", secondHook),
    budget(14_999_974)] } as ProxyBody;
  assert.equal(normalizeBoxSemanticBody(third).messages.length, 5);
  assert.equal(deriveBoxContextHash(third, true), deriveBoxContextHash(continued));
  const noBudget = { ...continued, messages: continued.messages.slice(0, -1) } as ProxyBody;
  assert.equal((normalizeBoxSemanticBody(noBudget).messages.at(-1) as
    { content: unknown[] }).content.length, 1);
  const twoHooks = { ...prior, messages: [...prior.messages,
    assistant("toolu_hook_3"), { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_hook_3", content: "pong-3" },
      { type: "text", text: firstHook + "\n" },
      { type: "text", text: secondHook },
    ] }, budget(14_999_960)] } as ProxyBody;
  assert.deepEqual(matchBoxToolResults(twoHooks, [{ id: "toolu_hook_3",
    clientName: "local_echo", boxName: "mcp__ocbridge__t0",
    input: { value: "ping" } }])[0]?.content, [
    { type: "text", text: "pong-3" }, { type: "text", text: firstHook + "\n" },
    { type: "text", text: secondHook },
  ]);
  const longHook = hook("Bash", "x".repeat(70_000));
  const longBody = { ...prior, messages: [...prior.messages,
    assistant("toolu_hook_4"), result("toolu_hook_4", "pong-4", longHook)] } as ProxyBody;
  assert.deepEqual(matchBoxToolResults(longBody, [{ id: "toolu_hook_4",
    clientName: "local_echo", boxName: "mcp__ocbridge__t0",
    input: { value: "ping" } }])[0]?.content.at(-1),
  { type: "text", text: longHook });
  const dottedHook = hook("Read.file:local", "Read the next file.");
  const dottedBody = { ...prior, messages: [...prior.messages,
    assistant("toolu_hook_5"), result("toolu_hook_5", "pong-5", dottedHook)] } as ProxyBody;
  assert.deepEqual(matchBoxToolResults(dottedBody, [{ id: "toolu_hook_5",
    clientName: "local_echo", boxName: "mcp__ocbridge__t0",
    input: { value: "ping" } }])[0]?.content.at(-1),
  { type: "text", text: dottedHook });
});

test("CCB-generated system hook is preserved as tool-result text before budget removal", () => {
  const hook = "<system-reminder>\nPreToolUse:Bash hook additional context: "
    + "Use Read rather than cat.\n</system-reminder>";
  const assistant = { role: "assistant", content: [{ type: "tool_use",
    id: "toolu_system_hook", name: "local_echo", input: { value: "ping" } }] };
  const result = { role: "user", content: [{ type: "tool_result",
    tool_use_id: "toolu_system_hook", content: "pong" }] };
  const systemHook = { role: "system", content: [{ type: "text", text: hook,
    cache_control: marker }] };
  const budget = { role: "system", content: [{ type: "text",
    text: "<total_tokens>14998460 tokens left</total_tokens>",
    cache_control: marker }] };
  const request = { ...first, messages: [first.messages[0], assistant, result,
    systemHook, budget] } as ProxyBody;
  const normalized = normalizeBoxSemanticBody(request);
  assert.deepEqual((normalized.messages as Array<{ role: string }>).map((message) => message.role),
    ["user", "assistant", "user"]);
  assert.deepEqual(matchBoxToolResults(request, [{ id: "toolu_system_hook",
    clientName: "local_echo", boxName: "mcp__ocbridge__t0",
    input: { value: "ping" } }])[0]?.content, [
    { type: "text", text: "pong" }, { type: "text", text: hook },
  ]);
  const withoutBudget = { ...request,
    messages: request.messages.slice(0, -1) } as ProxyBody;
  assert.equal(deriveBoxCallFingerprint(3n, request).replayFingerprint,
    deriveBoxCallFingerprint(3n, withoutBudget).replayFingerprint);
  const historicalHook = { role: "system", content: [{ type: "text", text: hook }] };
  const next = { ...request, messages: [first.messages[0], assistant, result,
    historicalHook, budget, { role: "assistant", content: [{ type: "tool_use",
      id: "toolu_system_hook_2", name: "local_echo", input: { value: "next" } }] },
    { role: "user", content: [{ type: "tool_result",
      tool_use_id: "toolu_system_hook_2", content: "pong-2" }] }, systemHook,
    budget] } as ProxyBody;
  assert.deepEqual((normalizeBoxSemanticBody(next).messages as Array<{ role: string }>)
    .map((message) => message.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.equal(deriveBoxContextHash(next, true), deriveBoxContextHash(request));
});

test("CCB budget is a no-op beside or inside tool results", () => {
  const assistant = { role: "assistant", content: [{ type: "tool_use",
    id: "toolu_meta", name: "local_echo", input: { value: "ping" } }] };
  const result = { type: "tool_result", tool_use_id: "toolu_meta", content: "pong" };
  const prefix = [{ role: "user", content: "hello" }, assistant];
  const budget = "<system-reminder>\n<total_tokens>0 tokens left</total_tokens>\n</system-reminder>";
  const hook = "<system-reminder>\nPreToolUse:Bash hook additional context: Use Read.\n</system-reminder>";
  const plain = { ...first, messages: [...prefix,
    { role: "user", content: [result, { type: "text", text: hook }] }] } as ProxyBody;
  const separate = { ...first, messages: [...prefix,
    { role: "user", content: [result, { type: "text", text: hook },
      { type: "text", text: budget }] }] } as ProxyBody;
  const embedded = (tokens: string) => ({ ...first, messages: [...prefix,
    { role: "user", content: [{ ...result,
      content: "pong\n\n" + hook + "\n\n" +
        `<system-reminder>\n<total_tokens>${tokens} tokens left</total_tokens>\n</system-reminder>` }] }] }) as ProxyBody;
  const budgetOnly = { ...first, messages: [...prefix,
    { role: "user", content: [result, { type: "text", text: budget }] }] } as ProxyBody;
  const bare = { ...first, messages: [...prefix,
    { role: "user", content: [result] }] } as ProxyBody;
  assert.equal(deriveBoxCallFingerprint(3n, plain).replayFingerprint,
    deriveBoxCallFingerprint(3n, separate).replayFingerprint);
  assert.equal(deriveBoxCallFingerprint(3n, embedded("0")).replayFingerprint,
    deriveBoxCallFingerprint(3n, embedded("14974580")).replayFingerprint);
  const normalized = normalizeBoxSemanticBody(embedded("Infinite"));
  assert.equal((normalized.messages.at(-1) as { content: Array<{ content: string }> })
    .content[0]?.content.includes("<total_tokens>"), false);
  const array = { ...first, messages: [...prefix, { role: "user", content: [{ ...result,
    content: [{ type: "text", text: "pong\n\n" + hook + "\n\n" + budget }] }] }] } as ProxyBody;
  assert.equal(deriveBoxCallFingerprint(3n, array).replayFingerprint,
    deriveBoxCallFingerprint(3n, { ...plain, messages: [...prefix,
      { role: "user", content: [{ ...result, content: [{ type: "text",
        text: "pong\n\n" + hook }] }] }] }).replayFingerprint);
  assert.equal(deriveBoxCallFingerprint(3n, bare).replayFingerprint,
    deriveBoxCallFingerprint(3n, budgetOnly).replayFingerprint);
  assert.notEqual(deriveBoxCallFingerprint(3n, plain).replayFingerprint,
    deriveBoxCallFingerprint(3n, bare).replayFingerprint,
    "hook content remains part of the model-visible tool result");
});
