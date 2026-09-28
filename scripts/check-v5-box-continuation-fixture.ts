/** Synthetic Box continuation fixtures. Expected bytes are written here.
 * This file must not import the normalizer, gate, matcher, or any capture. */

export const PROGRESS = "The user hasn't heard from you in a while. As you continue, keep them updated when there's something to tell \u2014 a finding, a change of plan.";
export const HOOK = "PreToolUse:Bash hook additional context: synthetic-hook-byte";
export const WRAPPED = "<system-reminder>\nPreToolUse:Bash hook additional context: synthetic-wrapped.\n</system-reminder>";
export const BUDGET = "<total_tokens>1000 tokens left</total_tokens>";
export const PROGRESS_LINE = `${PROGRESS}\n\n${BUDGET}`;
export const HOOK_LINE = `${HOOK}\n\n${BUDGET}`;
const MARKER = { type: "ephemeral" };

export const TOOL = { name: "local_echo", description: "synthetic echo", input_schema: {
  type: "object", properties: { value: { type: "string" } } } };
export const METADATA = { user_id: JSON.stringify({ oc_turn_key: "b".repeat(64),
  session_id: "synthetic-b1-continuation" }) };

export function request(messages: readonly unknown[]): Record<string, unknown> {
  return { model: "box-api-claude-opus-5-5", max_tokens: 128, stream: true,
    metadata: METADATA, tools: [TOOL], messages: [...messages] };
}
function arraySystem(text: string, cache: Record<string, unknown> | null): Record<string, unknown> {
  return cache === null
    ? { role: "system", content: [{ type: "text", text }] }
    : { role: "system", content: [{ type: "text", text, cache_control: cache }] };
}
function stringSystem(text: string): Record<string, unknown> {
  return { role: "system", content: text };
}
export function pair(id: string, input: string, text: string): unknown[] {
  return [
    { role: "assistant", content: [{ type: "tool_use", id, name: "local_echo", input: { value: input } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
  ];
}
function withTail(messages: readonly unknown[], system: unknown): unknown[] {
  return [...messages.slice(0, -1), system];
}

const user = { role: "user", content: "hello" };
const arrayBudget = arraySystem(BUDGET, MARKER);
const stringBudget = stringSystem(BUDGET);
const progressCached = arraySystem(PROGRESS_LINE, MARKER);
const progressHistorical = stringSystem(PROGRESS_LINE);
const hookCached = arraySystem(HOOK_LINE, MARKER);
const hookHistorical = stringSystem(HOOK_LINE);
const wrappedHook = arraySystem(WRAPPED, MARKER);

const http1 = [user, ...pair("toolu_syn_1", "one", "r1"), arrayBudget];
const http2 = [...withTail(http1, stringBudget), ...pair("toolu_syn_2", "two", "r2"), stringBudget];
const http3 = [...http2, ...pair("toolu_syn_3", "three", "r3"), progressCached];
const http4 = [...withTail(http3, progressHistorical), ...pair("toolu_syn_4", "four", "r4"), arrayBudget];
const http5 = [...http4, ...pair("toolu_syn_5", "five", "r5"), hookCached];
const http6 = [...withTail(http5, hookHistorical), ...pair("toolu_syn_6", "six", "r6"), progressCached];

/** Six HTTP requests and the five continuations between them. */
export const chain = [http1, http2, http3, http4, http5, http6].map(request);
/** Counts after one normalization. Not derived from a normalizer run. */
export const annotationCounts = [
  { progress: 0, hook: 0, wrapped: 0 },
  { progress: 0, hook: 0, wrapped: 0 },
  { progress: 1, hook: 0, wrapped: 0 },
  { progress: 1, hook: 0, wrapped: 0 },
  { progress: 1, hook: 1, wrapped: 0 },
  { progress: 2, hook: 1, wrapped: 0 },
];
export const rewrites = [
  { from: 2, to: 3, cached: progressCached, historical: progressHistorical },
  { from: 4, to: 5, cached: hookCached, historical: hookHistorical },
];
export const matchedTails = [
  { step: 2, id: "toolu_syn_3", input: "three", content: [
    { type: "text", text: "r3" }, { type: "text", text: PROGRESS }] },
  { step: 5, id: "toolu_syn_6", input: "six", content: [
    { type: "text", text: "r6" }, { type: "text", text: PROGRESS }] },
];
export const legalWrapped = request([user, ...pair("toolu_syn_wrap", "wrap", "rw"), wrappedHook, arrayBudget]);
export const legalWrappedBytes = WRAPPED;
export const historicalBudgetOnly = request([user, ...pair("toolu_syn_hist", "hist", "rh"), stringBudget]);
export const unknownText = request([user, ...pair("toolu_syn_unk", "unk", "ru"),
  arraySystem("not an annotation", MARKER)]);
export const unknownMarker = request([user, ...pair("toolu_syn_mark", "mark", "rm"),
  arraySystem(BUDGET, { type: "persistent" })]);

const badCaches: Array<Record<string, unknown> | null> = [
  { type: "ephemeral", ttl: "1h" },
  { type: "ephemeral", scope: "global" },
  null,
];
const openings = [
  [wrappedHook],
  [hookCached],
  [stringSystem(HOOK_LINE)],
  [arrayBudget],
  [stringBudget],
  [arrayBudget, stringBudget],
];
export const composedRejects: Array<{ id: string; input: string; body: Record<string, unknown> }> = [];
for (const opening of openings) {
  for (const cache of badCaches) {
    const bad = arraySystem(BUDGET, cache);
    composedRejects.push({
      id: "toolu_c2_now", input: "now",
      body: request([user, ...pair("toolu_c2_now", "now", "current"), ...opening, bad]),
    });
    composedRejects.push({
      id: "toolu_c2_new", input: "new",
      body: request([user, ...pair("toolu_c2_old", "old", "history"), ...opening, bad,
        ...pair("toolu_c2_new", "new", "next"), arrayBudget]),
    });
  }
}
