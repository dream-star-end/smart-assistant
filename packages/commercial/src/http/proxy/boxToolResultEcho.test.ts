import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BoxToolResultEcho, BoxToolResultEchoError } from "./boxToolResultEcho.js";

const result = (id: string, text: string) => ({ modelToolUseId: id,
  content: [{ type: "text" as const, text }], isError: false,
  contentHash: createHash("sha256").update(JSON.stringify({
    content: [{ type: "text", text }], isError: false })).digest("hex") });
const expected = [result("toolu_A", "first"), result("toolu_B", "second")];
const echo = (id: string, content: string) => ({ type: "user",
  message: { role: "user", content: [{ type: "tool_result",
    tool_use_id: id, content }] } });

test("echo mismatches retain bounded metadata and distinguish hash-only and error-bit failures", () => {
  const privateText = "private tool output, image or credential ".repeat(2000);
  const published = result("toolu_private", privateText);
  const { content: _content, ...hashOnly } = published;
  for (const item of [published, hashOnly]) {
    assert.throws(() => new BoxToolResultEcho([item]).accept(echo("toolu_private", "changed")),
      (error: unknown) => {
        assert.ok(error instanceof BoxToolResultEchoError);
        assert.equal(error.message, "BOX_TOOL_ECHO_CONTENT_MISMATCH");
        assert.equal(error.boxFailureDiagnostic?.branch, "echo_content");
        assert.equal(error.boxFailureDiagnostic?.hashOnly, item === hashOnly);
        assert.equal(error.boxFailureDiagnostic?.expectedSha256, published.contentHash);
        assert.equal(error.boxFailureDiagnostic?.observedType, "text");
        const encoded = JSON.stringify(error.boxFailureDiagnostic);
        assert.ok(Buffer.byteLength(encoded) <= 2048);
        assert.ok(!encoded.includes("private tool output"));
        return true;
      });
  }
  const raw = echo("toolu_private", privateText);
  Object.assign(raw.message.content[0]!, { is_error: true });
  assert.throws(() => new BoxToolResultEcho([published]).accept(raw), (error: unknown) => {
    assert.ok(error instanceof BoxToolResultEchoError);
    assert.equal(error.message, "BOX_TOOL_ECHO_CONTENT_MISMATCH");
    assert.equal(error.boxFailureDiagnostic?.branch, "echo_error_bit");
    return true;
  });
});

test("deferred rewrite rejection keeps its original code and content-free diagnostic", async () => {
  const verifier = new BoxToolResultEcho([result("toolu_A", "private nonempty output")]);
  verifier.accept(echo("toolu_A", "(mcp__ocbridge__Bash completed with no output)"));
  await assert.rejects(() => verifier.verifyDeferred(), (error: unknown) => {
    assert.ok(error instanceof BoxToolResultEchoError);
    assert.equal(error.message, "BOX_TOOL_ECHO_CONTENT_MISMATCH");
    assert.equal(error.boxFailureDiagnostic?.branch, "echo_content");
    assert.ok(!JSON.stringify(error.boxFailureDiagnostic).includes("private nonempty"));
    return true;
  });
});

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

test("Claude Code's own background notice for a long tool call fails under its own code (OCV5-386)", () => {
  for (const notice of [
    'MCP tool "ocbridge/Bash" is still running after 120s. It was moved to the background as task kt4s1546v and keeps running.',
    'MCP tool "ocbridge/Bash" was moved to the background as task kt4s1546v so that a message that arrived while it was running can reach you',
  ]) {
    assert.throws(() => new BoxToolResultEcho(expected).accept(echo("toolu_A", notice)), /BOX_TOOL_ECHO_CLI_BACKGROUNDED/);
  }
  assert.throws(() => new BoxToolResultEcho(expected).accept(echo("toolu_A", "MCP tool output")),
    /BOX_TOOL_ECHO_CONTENT_MISMATCH/, "other mismatches keep their code");
});
