/** Offline gate/normalize/match of one native capture. Does not rewrite the wire. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateBoxRequest } from "../../packages/commercial/src/http/proxy/boxRequestGate.ts";
import { normalizeBoxSemanticBody } from "../../packages/commercial/src/http/proxy/boxCacheAnnotations.ts";
import { matchBoxToolResults } from "../../packages/commercial/src/http/proxy/boxToolResultMatcher.ts";
import type { ProxyBody } from "../../packages/commercial/src/http/proxy/shared.ts";

type Sent = { id: string; name: string; input: Record<string, unknown> };
type Wire = { bodies?: ProxyBody[]; sent?: Sent[]; rawSha256?: string[] };

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`MISSING_${name}`);
  return process.argv[index + 1]!;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function blockTypes(content: unknown): string[] {
  if (!Array.isArray(content)) return [typeof content];
  return content.map((block) => record(block) && typeof block.type === "string" ? block.type : typeof block);
}

function textFlags(content: unknown): { budgetLike: boolean; hookLike: boolean; chars: number } {
  const text = typeof content === "string" ? content
    : Array.isArray(content) && content.length === 1 && record(content[0])
      && typeof content[0].text === "string" ? content[0].text : "";
  return {
    budgetLike: text.includes("<total_tokens>") || text.includes("tokens left"),
    hookLike: text.includes("hook additional context"),
    chars: text.length,
  };
}

function shape(body: ProxyBody) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const roles = messages.map((message) => record(message) ? String(message.role) : typeof message);
  const users = messages.flatMap((message, index) => {
    if (!record(message) || message.role !== "user") return [];
    const types = blockTypes(message.content);
    const results = Array.isArray(message.content)
      ? message.content.filter((block) => record(block) && block.type === "tool_result") : [];
    return [{
      index,
      blockCount: Array.isArray(message.content) ? message.content.length : 0,
      types,
      toolResultCount: results.length,
      toolUseIds: results.map((block) => record(block) ? String(block.tool_use_id) : ""),
      isError: results.map((block) => record(block) && Object.hasOwn(block, "is_error")
        ? block.is_error === true : null),
      contentSha256: results.map((block) => createHash("sha256")
        .update(JSON.stringify(record(block) ? block.content : null)).digest("hex")),
    }];
  });
  const systems = messages.flatMap((message, index) => {
    if (!record(message) || message.role !== "system") return [];
    return [{
      index,
      outer: Object.keys(message).sort(),
      contentKind: Array.isArray(message.content) ? "array" : typeof message.content,
      blocks: Array.isArray(message.content) ? message.content.length : 0,
      ...textFlags(message.content),
    }];
  });
  const lastUser = users.at(-1) ?? null;
  return {
    roles,
    userCount: users.length,
    users,
    toolResultUserCount: users.filter((user) => user.toolResultCount > 0).length,
    lastUserBlockCount: lastUser?.blockCount ?? 0,
    lastUserTypes: lastUser?.types ?? [],
    systems,
    assistantToolIds: messages.flatMap((message) => {
      if (!record(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [];
      return message.content.flatMap((block) => record(block) && block.type === "tool_use"
        ? [String(block.id)] : []);
    }),
  };
}

function codeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.name : "THROWN";
}

function roundReport(body: ProxyBody, expected: Sent[]) {
  const before = shape(body);
  let gate: string | null = null;
  try { gate = validateBoxRequest(body, true); }
  catch (error) { gate = codeOf(error); }
  let normalizeError: string | null = null;
  let after: ReturnType<typeof shape> | null = null;
  try { after = shape(normalizeBoxSemanticBody(body)); }
  catch (error) { normalizeError = codeOf(error); }
  let matchCode: string | null = null;
  let matched = 0;
  if (expected.length > 0) {
    try {
      matched = matchBoxToolResults(body, expected.map((item) => ({
        id: item.id, clientName: item.name, input: item.input,
      }))).length;
    } catch (error) { matchCode = codeOf(error); }
  }
  return { before, gate, normalizeError, after, matchCode, matched,
    expectedIds: expected.map((item) => item.id) };
}

function synthetic(sent: Sent[]) {
  if (sent.length !== 2) return [{ name: "skipped", labeled: "synthetic-not-native-wire", matchCode: "NO_EDITS" }];
  const assistant = {
    role: "assistant",
    content: sent.map((item) => ({ type: "tool_use", id: item.id, name: item.name, input: item.input })),
  };
  const result = (item: Sent, text: string, extra?: Record<string, unknown>) => ({
    type: "tool_result", tool_use_id: item.id, content: text, ...extra,
  });
  const base = (content: unknown[]) => ({
    model: "box-api-claude-opus-5-5",
    messages: [{ role: "user", content: "synthetic-negative" }, assistant, { role: "user", content }],
  }) as ProxyBody;
  const cases: Array<{ name: string; body: ProxyBody }> = [
    { name: "both-present", body: base(sent.map((item, index) => result(item, `ok-${index}`))) },
    { name: "dropped-second", body: base([result(sent[0]!, "ok-0")]) },
    { name: "duplicate-id", body: base([result(sent[0]!, "ok-0"), result(sent[0]!, "ok-0")]) },
    { name: "wrong-id", body: base([
      result(sent[0]!, "ok-0"),
      { type: "tool_result", tool_use_id: "toolu_wrong_id_not_sent", content: "ok-1" },
    ]) },
    { name: "is-error", body: base([
      result(sent[0]!, "ok-0"), result(sent[1]!, "failed", { is_error: true }),
    ]) },
    { name: "swapped-order", body: base([result(sent[1]!, "ok-1"), result(sent[0]!, "ok-0")]) },
    { name: "same-text", body: base(sent.map((item) => result(item, "same success sentence"))) },
    { name: "split-users", body: {
      model: "box-api-claude-opus-5-5",
      messages: [
        { role: "user", content: "synthetic-negative" }, assistant,
        { role: "user", content: [result(sent[0]!, "ok-0")] },
        { role: "user", content: [result(sent[1]!, "ok-1")] },
      ],
    } as ProxyBody },
  ];
  return cases.map((item) => {
    let matchCode: string | null = null;
    let matched = 0;
    let isError: boolean[] = [];
    try {
      const rows = matchBoxToolResults(item.body, sent.map((entry) => ({
        id: entry.id, clientName: entry.name, input: entry.input,
      })));
      matched = rows.length;
      isError = rows.map((row) => row.isError);
    } catch (error) { matchCode = codeOf(error); }
    return { name: item.name, labeled: "synthetic-not-native-wire", matchCode, matched, isError };
  });
}

const wire = JSON.parse(readFileSync(flag("--wire"), "utf8")) as Wire;
const bodies = wire.bodies ?? [];
const edits = (wire.sent ?? []).filter((item) => item.name === "Edit");
const read = (wire.sent ?? []).filter((item) => item.name === "Read");
process.stdout.write(`${JSON.stringify({
  rawSha256: wire.rawSha256 ?? [],
  rounds: bodies.map((body, index) => roundReport(body, index === 2 ? edits : index === 1 ? read : [])),
  syntheticNegatives: synthetic(edits),
})}\n`);
