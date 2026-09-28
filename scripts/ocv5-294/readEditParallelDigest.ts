/** Digest branch for one saved wire. Does not rewrite the wire or its old receipt. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hashBoxToolInput } from "../../packages/commercial/src/http/proxy/boxToolInputHash.ts";
import { matchBoxToolResults } from "../../packages/commercial/src/http/proxy/boxToolResultMatcher.ts";
import type { ProxyBody } from "../../packages/commercial/src/http/proxy/shared.ts";

type Sent = { id: string; name: string; input: Record<string, unknown> };
type Wire = { bodies?: ProxyBody[]; sent?: Sent[]; rawSha256?: string[]; labeled?: string };

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`MISSING_${name}`);
  return process.argv[index + 1]!;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function sha(value: unknown): { type: string; len: number; sha256: string } {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
    len: typeof value === "string" ? value.length : text.length,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}
function uses(body: ProxyBody): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.flatMap((message) => {
    if (!record(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [];
    return message.content.flatMap((block) => {
      if (!record(block) || block.type !== "tool_use" || !record(block.input)) return [];
      return [{ id: String(block.id), name: String(block.name), input: block.input }];
    });
  });
}
function codeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "THROWN";
}

const wire = JSON.parse(readFileSync(flag("--wire"), "utf8")) as Wire;
const bodies = wire.bodies ?? [];
const echoed = bodies.flatMap((body) => uses(body));
const rows = (wire.sent ?? []).map((sent) => {
  const found = echoed.filter((item) => item.id === sent.id);
  const echo = found[0];
  const sentHash = hashBoxToolInput(sent.input);
  const echoHash = echo ? hashBoxToolInput(echo.input) : null;
  const keys = [...new Set([...Object.keys(sent.input), ...Object.keys(echo?.input ?? {})])].sort();
  return {
    id: sent.id, name: sent.name, copies: found.length,
    sentHash, echoHash, hashEqual: echoHash === sentHash,
    keys: keys.map((key) => {
      const left = sha(sent.input[key]);
      const right = echo ? sha(echo.input[key]) : null;
      return { key, same: right !== null && left.sha256 === right.sha256, sent: left, echo: right };
    }),
  };
});
function matchAt(index: number, sent: Sent[]) {
  const body = bodies[index];
  if (!body || sent.length === 0) return { index, matchCode: "ABSENT", matched: 0 };
  try {
    const matched = matchBoxToolResults(body, sent.map((item) => ({
      id: item.id, clientName: item.name, inputHash: hashBoxToolInput(item.input),
    }))).length;
    return { index, matchCode: null, matched };
  } catch (error) { return { index, matchCode: codeOf(error), matched: 0 }; }
}
const edits = (wire.sent ?? []).filter((item) => item.name === "Edit");
const read = (wire.sent ?? []).filter((item) => item.name === "Read");
process.stdout.write(`${JSON.stringify({
  labeled: "digest-branch-not-live-http",
  sourceLabeled: wire.labeled ?? null,
  rawSha256: wire.rawSha256 ?? [],
  rows, readMatch: matchAt(1, read), editMatch: matchAt(2, edits),
})}\n`);
