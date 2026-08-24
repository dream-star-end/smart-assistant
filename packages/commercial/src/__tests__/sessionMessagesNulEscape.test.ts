import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeNulInSessionMessagesJson } from "../db/pgSessionsBackend.js";

// INC-20260821-SESSION-LIST-NUL-READ-STORM 写入侧治本:
// messages 落库前,原始 U+0000 的 JSON 转义序列必须改写成正文字面量 \u0000,
// 否则 ::json ->>'text' / ::jsonb 读取 22P05,读侧只能整行隔离。

test("raw NUL in message text is escaped to a literal \\u0000 before persist", () => {
  const json = JSON.stringify([{ id: "m1", role: "user", text: "abc\u0000def" }]);
  const escaped = escapeNulInSessionMessagesJson(json);
  const parsed = JSON.parse(escaped) as Array<{ text: string }>;
  assert.equal(parsed[0]!.text, "abc\\u0000def", "读回 = pgModelSidecarText 的可逆转义形态");
  assert.ok(!parsed[0]!.text.includes("\u0000"), "任何字段读回后都不再含原始 NUL");
});

test("user-typed literal \\u0000 text survives unchanged (no double escape)", () => {
  const json = JSON.stringify([{ text: "code sample: \\u0000 marker" }]);
  assert.equal(escapeNulInSessionMessagesJson(json), json);
  const parsed = JSON.parse(escapeNulInSessionMessagesJson(json)) as Array<{ text: string }>;
  assert.equal(parsed[0]!.text, "code sample: \\u0000 marker");
});

test("literal backslash immediately before a raw NUL is handled by parity", () => {
  const json = JSON.stringify([{ text: "tail\\" + "\u0000" }]);
  const parsed = JSON.parse(escapeNulInSessionMessagesJson(json)) as Array<{ text: string }>;
  assert.equal(parsed[0]!.text, "tail\\\\u0000", "字面反斜杠保留,NUL 变字面 \\u0000");
  assert.ok(!parsed[0]!.text.includes("\u0000"));
});

test("NUL in nested fields (ids/keys/arrays) is also neutralized", () => {
  const json = JSON.stringify([
    { id: "x\u0000y", _media: [{ name: "a\u0000b" }], text: "ok" },
  ]);
  const escaped = escapeNulInSessionMessagesJson(json);
  assert.ok(!/(?<!\\)(?:\\\\)*\\u0000/.test("sentinel"), "regex sanity");
  const parsed = JSON.stringify(JSON.parse(escaped));
  assert.ok(!parsed.includes("\u0000"), "整棵树读回后无原始 NUL");
});

test("json without NUL passes through byte-identical", () => {
  const json = JSON.stringify([{ text: "普通消息 with \\n and \\\\u0001", n: 1 }]);
  assert.equal(escapeNulInSessionMessagesJson(json), json);
});
