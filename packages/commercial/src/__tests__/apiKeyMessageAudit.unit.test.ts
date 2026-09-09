/**
 * 0279 — 外接 API-key 用户消息审计:纯函数 + INSERT/SELECT 参数契约。
 *
 * 跑法: npx tsx --test src/__tests__/apiKeyMessageAudit.unit.test.ts
 *
 * 锁住的不变量:
 *   1. 只取**最后一条 role=user** 的 text 块;tool_result / 图片不算;纯 tool_result 续轮 → null。
 *   2. UTF-8 字节截断不切半个字符,truncated 标记正确。
 *   3. 指纹 = canonical JSON(键排序)的 SHA-256:键序不同、逻辑相同的请求指纹一致。
 *   4. INSERT 参数顺序/类型(BigInt → string,error_message ≤ 512)。
 *   5. 列表查询:user_id 双重限定、游标分页、errors_only、limit 夹到 1..200。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  AUDIT_ERROR_MESSAGE_MAX_CHARS,
  AUDIT_LIST_MAX_LIMIT,
  canonicalJson,
  describeRequestShape,
  extractLastUserMessage,
  listApiKeyMessageAudit,
  recordApiKeyMessageAudit,
  truncateUtf8,
  usageCounts,
  type ApiKeyMessageAuditRow,
} from "../billing/apiKeyMessageAudit.js";
import type { ProxyBody } from "../http/proxy/shared.js";

describe("extractLastUserMessage", () => {
  test("picks the last user turn's text blocks; assistant / tool_result / media ignored", () => {
    const messages = [
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "answer" }, { type: "tool_use", id: "t1", name: "Read", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file contents that must NOT be audited" },
          { type: "text", text: "second" },
          { type: "image", source: { type: "base64", data: "AAAA" } },
          { type: "text", text: "question" },
        ],
      },
    ];
    assert.deepEqual(extractLastUserMessage(messages), { text: "second\nquestion", truncated: false });
  });

  test("pure tool_result continuation → null; string content accepted; no user turn → null", () => {
    assert.deepEqual(
      extractLastUserMessage([
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ]),
      { text: null, truncated: false },
    );
    assert.deepEqual(extractLastUserMessage([{ role: "user", content: "你好" }]), { text: "你好", truncated: false });
    assert.deepEqual(extractLastUserMessage([{ role: "assistant", content: "x" }]), { text: null, truncated: false });
    assert.deepEqual(extractLastUserMessage(undefined), { text: null, truncated: false });
    assert.deepEqual(extractLastUserMessage([{ role: "user", content: 42 }]), { text: null, truncated: false });
  });

  test("UTF-8 truncation never splits a multi-byte character", () => {
    // "你" is 3 bytes; 5 bytes budget must keep exactly one character.
    assert.deepEqual(truncateUtf8("你好", 5), { text: "你", truncated: true });
    assert.deepEqual(truncateUtf8("你好", 6), { text: "你好", truncated: false });
    assert.deepEqual(truncateUtf8("abc", 2), { text: "ab", truncated: true });
    const long = "é".repeat(3000); // 2 bytes each = 6000 bytes
    const cut = extractLastUserMessage([{ role: "user", content: long }]);
    assert.equal(cut.truncated, true);
    assert.equal(Buffer.byteLength(cut.text!, "utf8") <= 4096, true);
    assert.equal(Buffer.byteLength(cut.text!, "utf8") % 2, 0, "no half é");
  });
});

describe("describeRequestShape", () => {
  test("canonical fingerprint is key-order independent; counts + stream reflect the body", () => {
    const a = { model: "fable-5.1", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }], tools: [{ name: "Read", input_schema: { type: "object" } }] } as unknown as ProxyBody;
    const b = { tools: [{ input_schema: { type: "object" }, name: "Read" }], messages: [{ content: "hi", role: "user" }], stream: true, max_tokens: 10, model: "fable-5.1" } as unknown as ProxyBody;
    const sa = describeRequestShape(a);
    const sb = describeRequestShape(b);
    assert.equal(sa.bodySha256, sb.bodySha256);
    assert.match(sa.bodySha256, /^[0-9a-f]{64}$/);
    assert.equal(sa.bodyBytes, Buffer.byteLength(canonicalJson(a)));
    assert.equal(sa.messageCount, 1);
    assert.equal(sa.toolCount, 1);
    assert.equal(sa.stream, true);
    const c = describeRequestShape({ model: "x", max_tokens: 1, messages: [] } as unknown as ProxyBody);
    assert.equal(c.stream, false);
    assert.equal(c.toolCount, 0);
    assert.notEqual(c.bodySha256, sa.bodySha256);
    // undefined values are dropped from the canonical form (JSON.stringify would too).
    assert.equal(canonicalJson({ b: 1, a: undefined }), '{"b":1}');
  });

  test("usageCounts maps Anthropic snake_case usage; garbage → empty", () => {
    assert.deepEqual(
      usageCounts({ input_tokens: 4, output_tokens: 17, cache_read_input_tokens: 0, cache_creation_input_tokens: 32171 }),
      { inputTokens: 4, outputTokens: 17, cacheReadTokens: 0, cacheWriteTokens: 32171 },
    );
    assert.deepEqual(usageCounts({}), { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
    assert.deepEqual(usageCounts(null), {});
    assert.deepEqual(usageCounts("x"), {});
  });
});

function rowFixture(over: Partial<ApiKeyMessageAuditRow> = {}): ApiKeyMessageAuditRow {
  return {
    requestId: "req-1",
    userId: 3n,
    apiKeyId: 14n,
    requestedModel: "fable-5.1",
    model: "cursor-fable-5.1-high",
    effort: "high",
    effortSource: "request",
    accountId: 15n,
    shape: { bodySha256: "ab".repeat(32), bodyBytes: 83677, messageCount: 2, toolCount: 29, stream: true },
    lastUserMessage: { text: "你好", truncated: false },
    status: "error",
    terminalCode: "CURSOR_STREAM_FAILED",
    errorMessage: "Provider Error (400): We're having trouble connecting to the model provider.",
    durationMs: 61901,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    clientUserAgent: "claude-cli/2.1.263 (external, cli)",
    ...over,
  };
}

describe("recordApiKeyMessageAudit", () => {
  test("single INSERT with positional params in schema order; BigInt → string; error_message capped", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const pool = { query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return { rows: [] }; } };
    await recordApiKeyMessageAudit(pool, rowFixture());
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /INSERT INTO api_key_message_audit/);
    const p = calls[0]!.params;
    assert.equal(p.length, 24);
    assert.deepEqual(p.slice(0, 8), ["req-1", "3", "14", "fable-5.1", "cursor-fable-5.1-high", "high", "request", "15"]);
    assert.deepEqual(p.slice(8, 13), ["ab".repeat(32), 83677, 2, 29, true]);
    assert.deepEqual(p.slice(13, 15), ["你好", false]);
    assert.deepEqual(p.slice(15, 19), ["error", "CURSOR_STREAM_FAILED", "Provider Error (400): We're having trouble connecting to the model provider.", 61901]);
    assert.deepEqual(p.slice(19, 24), [0, 0, 0, 0, "claude-cli/2.1.263 (external, cli)"]);

    calls.length = 0;
    await recordApiKeyMessageAudit(pool, rowFixture({
      apiKeyId: null, accountId: null, effort: null, effortSource: null,
      lastUserMessage: { text: null, truncated: false }, status: "success", terminalCode: null,
      errorMessage: "x".repeat(AUDIT_ERROR_MESSAGE_MAX_CHARS + 100), usage: {}, clientUserAgent: null,
    }));
    const q = calls[0]!.params;
    assert.equal(q[2], null);
    assert.equal(q[7], null);
    assert.equal(q[13], null);
    assert.equal((q[17] as string).length, AUDIT_ERROR_MESSAGE_MAX_CHARS);
    assert.deepEqual(q.slice(19, 24), [null, null, null, null, null]);
  });

  test("does not swallow DB errors (caller is the fail-soft layer)", async () => {
    const pool = { query: async () => { throw new Error("relation does not exist"); } };
    await assert.rejects(() => recordApiKeyMessageAudit(pool, rowFixture()), /relation does not exist/);
  });
});

describe("listApiKeyMessageAudit", () => {
  test("user-scoped, key filter double-checks ownership, cursor + errors_only + limit clamp, next_before", async () => {
    const capture: { seen: { sql: string; params: unknown[] } | null } = { seen: null };
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({
      id: String(100 - i), created_at: new Date("2026-09-08T16:35:04Z"), request_id: `r${i}`, api_key_id: "14",
      requested_model: "fable-5.1", model: "cursor-fable-5.1-high", effort: "high", effort_source: "request",
      account_id: "15", body_sha256: "ab".repeat(32), body_bytes: 1, message_count: 2, tool_count: 29, stream: true,
      last_user_message: "你好", last_user_message_truncated: false, status: "error", terminal_code: "Error",
      error_message: "Provider Error (400): x", duration_ms: 100, input_tokens: "0", output_tokens: "0",
      cache_read_tokens: null, cache_write_tokens: null, client_user_agent: null,
    }));
    const pool = { query: async (sql: string, params: unknown[]) => { capture.seen = { sql, params }; return { rows: mk(3) }; } };

    const page = await listApiKeyMessageAudit(pool, "3", { apiKeyId: "14", beforeId: "200", limit: 2, errorsOnly: true });
    assert.ok(capture.seen);
    const { sql, params } = capture.seen!;
    assert.match(sql, /a\.user_id = \$1/);
    assert.match(sql, /a\.api_key_id = \$2 AND EXISTS \(SELECT 1 FROM user_api_keys k WHERE k\.id = a\.api_key_id AND k\.user_id = \$1\)/);
    assert.match(sql, /a\.id < \$3/);
    assert.match(sql, /a\.status = 'error'/);
    assert.match(sql, /ORDER BY a\.id DESC/);
    assert.deepEqual(params, ["3", "14", "200", 3]); // limit+1 to detect next page
    assert.equal(page.entries.length, 2);
    assert.equal(page.next_before, "99");
    assert.equal(page.entries[0]!.created_at, "2026-09-08T16:35:04.000Z");
    assert.equal(page.entries[0]!.last_user_message, "你好");
    assert.equal(page.entries[0]!.duration_ms, 100);

    // No filters, small result → next_before null; limit clamped to max.
    const pool2 = { query: async (sql: string, params: unknown[]) => { capture.seen = { sql, params }; return { rows: mk(1) }; } };
    const p2 = await listApiKeyMessageAudit(pool2, 3n, { apiKeyId: null, beforeId: null, limit: 10_000, errorsOnly: false });
    assert.equal(p2.next_before, null);
    const capturedAfterSecond = capture.seen;
    assert.ok(capturedAfterSecond);
    assert.doesNotMatch(capturedAfterSecond.sql, /api_key_id = \$|a\.id <|status = 'error'/);
    assert.deepEqual(capturedAfterSecond.params, ["3", AUDIT_LIST_MAX_LIMIT + 1]);
  });
});
