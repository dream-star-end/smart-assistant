import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { BoxCliCompaction, BoxCliCompactionError } from "./boxCliCompaction.js";
import { BoxCliSseError, createBoxCliSseDecoder } from "./boxCliSse.js";
import { BoxToolResultEcho, BoxToolResultEchoError } from "./boxToolResultEcho.js";

const session = "e37f0afa-e659-40ba-84e4-fa90bf465945";
const capture = readFileSync(new URL("./ocv5-296-classic-2.stdout.jsonl", import.meta.url), "utf8");
const captureSha = "6e62db2a7f79ac8a52d0cae5722b03b74ca3262acb7af38f5b719e28ed0796c7";

test("trusted classic-2 boundary and synthetic summary are not billed as the message", () => {
  assert.equal(createHash("sha256").update(capture).digest("hex"), captureSha);
  const decoder = createBoxCliSseDecoder("claude-opus-5-5", session);
  decoder.push(capture);
  const finished = decoder.finish();
  assert.equal(finished.inputTokens, 222);
  assert.equal(finished.outputTokens, 5);
  assert.equal(finished.sse.includes("This session is being continued"), false);
  const lines = capture.split("\n").filter(Boolean);
  const summary = JSON.parse(lines[5] ?? "");
  const echo = new BoxToolResultEcho([{ modelToolUseId: "toolu_01OCV5296SYNTH",
    contentHash: "a".repeat(64), isError: false }]);
  assert.throws(() => echo.accept(summary),
    (error: unknown) => error instanceof BoxToolResultEchoError
      && error.code === "BOX_TOOL_ECHO_ID_INVALID");
});

test("wrong session, broken anchor, and a second boundary are rejected", () => {
  assert.throws(() => createBoxCliSseDecoder("claude-opus-5-5",
    "11111111-1111-4111-8111-111111111111").push(capture),
    (error: unknown) => error instanceof BoxCliSseError
      && error.code === "BOX_CLI_COMPACT_BOUNDARY_INVALID");
  const lines = capture.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    compact_metadata?: { preserved_segment?: { anchor_uuid?: string } };
    uuid?: string;
  });
  const boundary = lines[4];
  const summary = lines[5];
  if (boundary?.compact_metadata?.preserved_segment) {
    boundary.compact_metadata.preserved_segment.anchor_uuid = "22222222-2222-4222-8222-222222222222";
  }
  const reader = new BoxCliCompaction(session);
  assert.throws(() => reader.take(boundary),
    (error: unknown) => error instanceof BoxCliCompactionError
      && error.code === "BOX_CLI_COMPACT_BOUNDARY_INVALID");
  const again = new BoxCliCompaction(session);
  again.take(JSON.parse(capture.split("\n")[4] ?? ""));
  again.take(summary);
  assert.throws(() => again.take(JSON.parse(capture.split("\n")[4] ?? "")),
    (error: unknown) => error instanceof BoxCliCompactionError
      && error.code === "BOX_CLI_COMPACT_DUPLICATE");
});

test("an unbound compact boundary is not silently ignored", () => {
  const boundary = capture.split("\n").filter(Boolean)[4];
  assert.throws(() => createBoxCliSseDecoder("claude-opus-5-5").push(`${boundary}\n`),
    (error: unknown) => error instanceof BoxCliSseError
      && error.code === "BOX_CLI_COMPACT_UNBOUND");
});
