import { describe, expect, test } from "vitest";
import type { ChatMessage } from "./model";
import { carryLegacySizeRequestReferences } from "./render";
import { ChatSocket } from "./socket";
import type { StoredSession } from "../persist";

const diagnostic = "Request too large (max 20MB). Try with a smaller file.";
const requestId = "60760760760760760760760760760760";
const snapshot = { disposition: "card", tone: "red", title: "任务执行失败", message: "旧错误", detail: `${diagnostic} request id: ${requestId}` } as const;
// Actual legacy tape has completed; the current UI status type is narrower.
const row = (extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: "error", role: "assistant", text: diagnostic,
  ts: 2, status: "completed" as unknown as ChatMessage["status"], _source: "server", _clientMessageId: "m-g607-cache", _errorCode: "ENGINE_ERROR", ...extra });

describe("legacy size request ID hydration", () => {
  test("only the safe ID transfers while the current snapshot and content remain untouched", () => {
    const frozen = { ...snapshot, detail: undefined };
    const current = row({ _errorCardSnapshot: frozen, _errorDetail: "已保留的排查信息" });
    const result = carryLegacySizeRequestReferences([current], [row({ _errorCardSnapshot: snapshot })]);
    expect(result[0]._errorDetail).toBe(`已保留的排查信息\n请求 ID：${requestId}`);
    expect(result[0]._errorCardSnapshot).toBe(frozen);
    expect(result[0].text).toBe(current.text);
    expect(current._errorDetail).toBe("已保留的排查信息");
  });
  test("ordinary errors, partial bodies, different turns, conflicting IDs and current IDs never get replaced", () => {
    const cached = row({ _errorCardSnapshot: snapshot });
    for (const current of [row({ _errorCode: "upstream_failed" }), row({ text: `真实回答\n${diagnostic}` }), row({ _clientMessageId: "m-other" }), row({ _errorDetail: "请求 ID：aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })]) {
      const input = [current]; expect(carryLegacySizeRequestReferences(input, [cached])).toBe(input);
    }
    const input = [row()];
    expect(carryLegacySizeRequestReferences(input, [cached, row({ _errorDetail: "请求 ID：bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })])).toBe(input);
    expect(carryLegacySizeRequestReferences(input, [row({ text: "普通错误", _errorCardSnapshot: snapshot })])).toBe(input);
    expect(carryLegacySizeRequestReferences(input, [row({ _errorCardSnapshot: snapshot, _errorDetail: "请求 ID：bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })])).toBe(input);
    expect(carryLegacySizeRequestReferences(input, [null as unknown as ChatMessage])).toBe(input);
    expect(carryLegacySizeRequestReferences(input, null as unknown as ChatMessage[])).toBe(input);
    expect(carryLegacySizeRequestReferences([row({ _clientMessageId: " " })], [row({ _clientMessageId: " ", _errorCardSnapshot: snapshot })])[0]._errorDetail).toBeUndefined();
  });
  for (const order of ["REST-first", "IDB-first"] as const) test(`${order} and later REST keep the original request ID`, () => {
    const sock = new ChatSocket({ getToken: () => "fixture", getAuthEpoch: () => 0,
      silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }), onAuthExpired: () => {}, defaultAgentId: "main" });
    const stored: StoredSession = { id: "g607-cache", agentId: "main", title: "合成旧卡", createdAt: 1, lastAt: 2, messages: [row({ _errorCardSnapshot: snapshot })] };
    try {
      if (order === "REST-first") sock.applyServerMessages(stored.id, "main", [row()], true, 1, { serverUpdatedAt: 1 });
      sock.loadStored(stored);
      expect(() => sock.loadStored({ ...stored, messages: null as unknown as ChatMessage[] })).not.toThrow();
      expect(() => sock.loadStored({ ...stored, messages: [null as unknown as ChatMessage] })).not.toThrow();
      const before = sock.ensureSession(stored.id, "main").messages[0]._errorCardSnapshot;
      sock.applyServerMessages(stored.id, "main", [row()], true, 2, { serverUpdatedAt: 2 });
      const restored = sock.ensureSession(stored.id, "main").messages[0];
      expect(restored._errorDetail).toBe(`请求 ID：${requestId}`);
      expect(restored._errorCardSnapshot).toBe(before);
      expect(restored.text).toBe(diagnostic);
      sock.applyServerMessages(stored.id, "main", [row()], false, 3, { serverUpdatedAt: 3 });
      expect(sock.ensureSession(stored.id, "main").messages[0]._errorDetail).toBe(`请求 ID：${requestId}`);
    } finally { sock.stop(); }
  });
});
