// OCV5-302: live failure #f82c733f — Read of a 1290x2796 phone screenshot was
// echoed by the Box CLI as a 923x2000 image (its MCP image resize), the strict
// echo bind failed and the continuation went unknown ("任务执行失败 / 内部错误").
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { BoxToolResultEcho, BoxToolResultEchoError } from "./boxToolResultEcho.js";

const id = "toolu_echo_cli";
type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const picture = (width: number, height: number, color = { r: 200, g: 30, b: 40 }) =>
  sharp({ create: { width, height, channels: 3, background: color } })
    .composite([{ input: { create: { width: Math.round(width / 3), height: Math.round(height / 4),
      channels: 3, background: { r: 250, g: 250, b: 250 } } }, left: 0, top: 0 }]);
const png = async (width: number, height: number, color?: { r: number; g: number; b: number }) =>
  (await picture(width, height, color).png().toBuffer()).toString("base64");
const hash = (content: unknown, isError = false) => createHash("sha256")
  .update(JSON.stringify({ content, isError })).digest("hex");
const expected = (content: Block[], withContent = true) => ({ modelToolUseId: id, isError: false,
  contentHash: hash(content), ...(withContent ? { content } : {}) });
const echoOf = (content: unknown, isError?: boolean) => ({ type: "user", message: { role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content,
    ...(isError === undefined ? {} : { is_error: isError }) }] } });
const apiImage = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
const ok = async (exp: ReturnType<typeof expected>, echo: unknown) => {
  const e = new BoxToolResultEcho([exp]); e.accept(echo); await e.verifyDeferred(); e.assertComplete(); };
const bad = async (exp: ReturnType<typeof expected>, echo: unknown) => assert.rejects(async () => {
  const e = new BoxToolResultEcho([exp]); e.accept(echo); await e.verifyDeferred(); },
(error: unknown) => error instanceof BoxToolResultEchoError && error.code === "BOX_TOOL_ECHO_CONTENT_MISMATCH");

test("OCV5-302 image echoes stay byte-exact: a CLI resize is never accepted", async () => {
  // boxToolResultImages publishes within the CLI limits, so a resize can only
  // mean other bytes than OpenClaude published; neither a faithful resize nor a
  // different picture of the same size may pass the bind.
  const original = await picture(1290, 2796).png().toBuffer();
  const published = [{ type: "image" as const, data: original.toString("base64"), mimeType: "image/png" }];
  const resized = (await sharp(original).resize(923, 2000).png().toBuffer()).toString("base64");
  for (const data of [resized, await png(923, 2000, { r: 20, g: 200, b: 60 })]) {
    assert.throws(() => new BoxToolResultEcho([expected(published)]).accept(echoOf([apiImage(data)])),
      (error: unknown) => error instanceof BoxToolResultEchoError
        && error.code === "BOX_TOOL_ECHO_CONTENT_MISMATCH");
  }
  await ok(expected(published), echoOf([apiImage(published[0]!.data)]));
  // a rewrite-shaped echo that skipped verification cannot complete
  const e = new BoxToolResultEcho([expected([{ type: "text", text: "" }])]);
  e.accept(echoOf("(mcp__ocbridge__Bash completed with no output)"));
  assert.throws(() => e.assertComplete(), (error: unknown) =>
    error instanceof BoxToolResultEchoError && error.code === "BOX_TOOL_ECHO_UNVERIFIED");
});

test("the empty marker and persisted-output preview must be exact rewrites of published text", async () => {
  const marker = "(mcp__ocbridge__Bash completed with no output)";
  await ok(expected([{ type: "text", text: "" }]), echoOf(marker));
  await ok(expected([]), echoOf(marker));
  await bad(expected([{ type: "text", text: "data" }]), echoOf(marker));
  assert.throws(() => new BoxToolResultEcho([expected([{ type: "text", text: "" }], false)])
    .accept(echoOf(marker)), BoxToolResultEchoError, "hash-only marker stays strict");
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const source = JSON.stringify([{ type: "text", text: lines }], null, 2);
  const lastNewline = source.slice(0, 2000).lastIndexOf("\n");
  const cut = lastNewline > 1000 ? lastNewline : 2000;   // Claude Code generatePreview
  const preview = `<persisted-output>\nOutput too large (${(source.length / 1024).toFixed(1)}KB). Full output saved to: `
    + `/home/box/.claude/projects/p/tool-results/${id}.json\n\nPreview (first 2KB):\n`
    + `${source.slice(0, cut)}\n...\n</persisted-output>`;
  await ok(expected([{ type: "text", text: lines }]), echoOf(preview));
  await bad(expected([{ type: "text", text: lines }]), echoOf(preview.replace("line 3 ", "line 9 ")));
  // a plain-text (non-JSON) persisted source is accepted the same exact way
  const plainCut = lines.slice(0, 2000).lastIndexOf("\n");
  const plain = `<persisted-output>\nOutput too large (${(lines.length / 1024).toFixed(1)}KB). Full output saved to: `
    + `/home/box/.claude/projects/p/tool-results/${id}.txt\n\nPreview (first 2KB):\n`
    + `${lines.slice(0, plainCut)}\n...\n</persisted-output>`;
  await ok(expected([{ type: "text", text: lines }]), echoOf(plain));
  await bad(expected([{ type: "text", text: lines }]), echoOf(preview.replace(`${id}.json`, "other.json")));
  // the CLI message is lossy past its preview; a different size is still caught
  await bad(expected([{ type: "text", text: lines + "!".repeat(5000) }]), echoOf(preview));
});
