import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BoxToolResultEcho } from "./boxToolResultEcho.js";

const result = (id: string, text: string) => ({ modelToolUseId: id,
  content: [{ type: "text" as const, text }], isError: false,
  contentHash: createHash("sha256").update(JSON.stringify({
    content: [{ type: "text", text }], isError: false })).digest("hex") });
const expected = [result("toolu_A", "first"), result("toolu_B", "second")];
const echo = (id: string, content: string) => ({ type: "user",
  message: { role: "user", content: [{ type: "tool_result",
    tool_use_id: id, content }] } });

test("CLI user echoes bind both published tool results in any dispatch order", () => {
  const verifier = new BoxToolResultEcho(expected);
  verifier.accept(echo("toolu_B", "second"));
  assert.throws(() => verifier.assertComplete(), /BOX_TOOL_ECHO_INCOMPLETE/);
  verifier.accept(echo("toolu_A", "first"));
  verifier.assertComplete();
});

test("missing, duplicate, forged and changed tool echoes fail closed", () => {
  for (const invalid of [echo("toolu_A", "wrong"), echo("toolu_C", "third"),
    { type: "user", message: { role: "user", content: "unbound prompt" } }]) {
    assert.throws(() => new BoxToolResultEcho(expected).accept(invalid),
      /BOX_TOOL_ECHO_/);
  }
  const verifier = new BoxToolResultEcho(expected);
  verifier.accept(echo("toolu_A", "first"));
  assert.throws(() => verifier.accept(echo("toolu_A", "first")),
    /BOX_TOOL_ECHO_ID_INVALID/);
});
