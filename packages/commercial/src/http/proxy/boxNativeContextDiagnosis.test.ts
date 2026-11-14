import test from "node:test";
import assert from "node:assert/strict";
import type { ProxyBody } from "./shared.js";
import { explainBoxNativeHistoryDetailed, makeBoxNativeHistoryBasis } from "./boxNativeHistory.js";
import { rememberBoxNativeContext, resetBoxNativeContextDiagnosisForTest } from "./boxNativeContextDiagnosis.js";
import { createLogger } from "../../logging/logger.js";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const body = (messages: unknown[], extra: Record<string, unknown> = {}): ProxyBody => ({
  model: "box-api-claude-opus-5-5", stream: true, max_tokens: 256,
  system: [{ type: "text", text: "static SECRET-SYS" }, { type: "text", text: "dynamic SECRET-DATE" }],
  tools: [{ name: "Read", description: "r", input_schema: { type: "object" } }],
  messages, ...extra } as ProxyBody);

function remembered(previous: ProxyBody) {
  resetBoxNativeContextDiagnosisForTest();
  const basis = makeBoxNativeHistoryBasis(previous, [{ type: "text", text: "READY" }]);
  rememberBoxNativeContext(basis.contextHashBeforeFinal, previous);
  return basis;
}

test("a context miss names the changed system block, not its text", () => {
  const previous = body([user("SECRET-Q1")]);
  const basis = remembered(previous);
  const next = body([user("SECRET-Q1"), assistant("READY"), user("SECRET-Q2")], {
    system: [{ type: "text", text: "static SECRET-SYS" }, { type: "text", text: "dynamic SECRET-DATE2" }] });
  const out = explainBoxNativeHistoryDetailed(next, basis);
  assert.equal(out.reason, "context");
  assert.deepEqual(out.detail, { basis: "known", systemParts: { prev: 2, next: 2, firstDiff: 1 },
    changed: ["system"] });
  assert.doesNotMatch(JSON.stringify(out.detail), /SECRET/);
});

test("a context miss names changed request params and an inserted message", () => {
  const previous = body([user("SECRET-Q1"), assistant("A1"), user("SECRET-Q2")]);
  const basis = remembered(previous);
  const next = body([user("SECRET-Q1"), user("SECRET-INSERTED"), assistant("A1"), user("SECRET-Q2"),
    assistant("READY"), user("SECRET-Q3")], { max_tokens: 512 });
  const out = explainBoxNativeHistoryDetailed(next, basis);
  assert.equal(out.reason, "context");
  assert.deepEqual(out.detail, { basis: "known", params: ["max_tokens"],
    messageParts: { prev: 3, next: 4, firstDiff: 1, prevKind: "assistant:str", nextKind: "user:str",
      alignedAfter: 0, insertedShift: 2, removedShift: 0 },
    changed: ["params", "messages"] });
  assert.doesNotMatch(JSON.stringify(out.detail), /SECRET/);
});

test("an exact prefix still resumes and an unknown basis is reported as such", () => {
  const previous = body([user("Q1")]);
  const basis = remembered(previous);
  assert.equal(explainBoxNativeHistoryDetailed(body([user("Q1"), assistant("READY"), user("Q2")]), basis).reason, "ok");
  resetBoxNativeContextDiagnosisForTest();
  const out = explainBoxNativeHistoryDetailed(body([user("Q1x"), assistant("READY"), user("Q2")]), basis);
  assert.deepEqual(out, { reason: "context", detail: { basis: "unknown" } });
});

test("a roles miss records the content-free tail shape", () => {
  const basis = remembered(body([user("Q1")]));
  const out = explainBoxNativeHistoryDetailed(body([user("SECRET-Q1"), assistant("READY"),
    { role: "assistant", content: [{ type: "thinking", thinking: "SECRET-T", signature: "s" }, { type: "text", text: "SECRET" }] },
    user("SECRET-Q2"), user("SECRET-Q3")]), basis);
  assert.equal(out.reason, "roles");
  assert.deepEqual(out.detail, { count: 5, tail: ["assistant:str", "assistant:thinking|text", "user:str", "user:str"] });
  assert.doesNotMatch(JSON.stringify(out.detail), /SECRET/);
});

test("OCV5-756: commercial createLogger keeps context, roles and restage_attachments details unredacted", () => {
  const previous = body([user("SECRET-Q1"), assistant("A1"), user("SECRET-Q2")]);
  const basis = remembered(previous);
  const next = body([user("SECRET-Q1"), user("SECRET-INSERTED"), assistant("A1"), user("SECRET-Q2"),
    assistant("READY"), user("SECRET-Q3")], {
    system: [{ type: "text", text: "static SECRET-SYS" }, { type: "text", text: "dynamic SECRET-DATE2" }],
    tools: [{ name: "Read", description: "r2", input_schema: { type: "object" } }],
    max_tokens: 512,
  });
  const contextOut = explainBoxNativeHistoryDetailed(next, basis);
  assert.equal(contextOut.reason, "context");

  const rolesOut = explainBoxNativeHistoryDetailed(body([user("SECRET-Q1"), assistant("READY"),
    { role: "assistant", content: [{ type: "thinking", thinking: "SECRET-T", signature: "s" }, { type: "text", text: "SECRET" }] },
    user("SECRET-Q2"), user("SECRET-Q3")]), basis);
  assert.equal(rolesOut.reason, "roles");

  const restageDetail = { priorReason: "context", attachmentCount: 2 };

  const lines: string[] = [];
  const log = createLogger({ level: "info", out: (line) => { lines.push(line); } });
  log.info("box_native_decision", { requestId: "req-1", decision: "miss", reason: "context",
    cliVersion: "2.1.0", detail: contextOut.detail });
  log.info("box_native_decision", { requestId: "req-2", decision: "miss", reason: "roles",
    cliVersion: "2.1.0", detail: rolesOut.detail });
  log.info("box_native_decision", { requestId: "req-3", decision: "miss", reason: "restage_attachments",
    cliVersion: "2.1.0", detail: restageDetail });

  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.equal(line.includes("<redacted>"), false, `unexpected redaction in ${line}`);
    assert.equal(line.includes("SECRET"), false, `unexpected secret text in ${line}`);
  }

  const parsedContext = JSON.parse(lines[0]!) as { detail: Record<string, unknown> };
  assert.deepEqual(parsedContext.detail, {
    basis: "known",
    systemParts: { prev: 2, next: 2, firstDiff: 1 },
    toolParts: { prev: 1, next: 1, firstDiff: 0 },
    params: ["max_tokens"],
    messageParts: {
      prev: 3, next: 4, firstDiff: 1,
      prevKind: "assistant:str", nextKind: "user:str",
      alignedAfter: 0, insertedShift: 2, removedShift: 0,
    },
    changed: ["system", "tools", "params", "messages"],
  });

  const parsedRoles = JSON.parse(lines[1]!) as { detail: Record<string, unknown> };
  assert.deepEqual(parsedRoles.detail, {
    count: 5,
    tail: ["assistant:str", "assistant:thinking|text", "user:str", "user:str"],
  });

  const parsedRestage = JSON.parse(lines[2]!) as { detail: Record<string, unknown> };
  assert.deepEqual(parsedRestage.detail, { priorReason: "context", attachmentCount: 2 });
});
