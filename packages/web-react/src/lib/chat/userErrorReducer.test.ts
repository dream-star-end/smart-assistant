import { USER_ERROR_CATALOG } from "@openclaude/protocol/browser";
import { describe, expect, test, vi } from "vitest";
import { addMessage, createSession, type ChatSession } from "./model";
import { applyLegacyBridgeError, applyOutboundError } from "./reducer";

function sess(): ChatSession {
  const s = createSession({ id: "s1", agentId: "main" });
  addMessage(s, "user", "问题", { id: "u1", status: "sent" });
  s._sendingInFlight = true;
  s._activeClientMessageId = "u1";
  return s;
}

const serverUserError = {
  code: "bad_request",
  category: "input",
  retryable: false,
  userMessageKey: "errors.bad_request",
  message: "服务端目录给的人话。",
  actions: ["edit_message"],
};

function errorFrame(extra: Record<string, unknown> = {}) {
  return {
    type: "outbound.error",
    sessionKey: "k",
    channel: "webchat",
    peer: { id: "s1", kind: "dm" },
    code: "bad_request",
    message: "upstream said 400 BAD_REQUEST trace=abc",
    clientMessageId: "u1",
    isFinal: false,
    ...extra,
  } as never;
}

describe("错误帧的 userError 落到错误卡", () => {
  test("outbound.error 带 userError:落到错误行,并随快照冻结", () => {
    const s = sess();
    applyOutboundError(s, errorFrame({ userError: serverUserError }));
    const card = s.messages.find((m) => m._errorCode);
    expect(card?._userError?.message).toBe("服务端目录给的人话。");
    expect(card?._errorCardSnapshot).toMatchObject({ disposition: "card", userError: { message: "服务端目录给的人话。" } });
  });

  test("旧服务不带 userError:快照冻结查目录用的码,正文里没有原始码", () => {
    const s = sess();
    applyOutboundError(s, errorFrame());
    const card = s.messages.find((m) => m._errorCode);
    expect(card?._userError).toBeUndefined();
    expect(card?._errorCardSnapshot).toMatchObject({ disposition: "card", catalogCode: "bad_request" });
    const snapshot = card?._errorCardSnapshot;
    expect(snapshot?.disposition === "card" ? snapshot.message : "").not.toContain("BAD_REQUEST");
    expect(USER_ERROR_CATALOG.bad_request!.message).not.toContain("BAD_REQUEST");
  });

  test("legacy error 帧同样带上 userError", () => {
    const s = sess();
    applyLegacyBridgeError(s, {
      type: "error", peer: { id: "s1", kind: "dm" }, clientMessageId: "u1", code: "bad_request", userError: serverUserError,
    } as never);
    expect(s.messages.find((m) => m._errorCode)?._userError?.message).toBe("服务端目录给的人话。");
  });
});

describe("重连重放同一条错误不重复画卡、不重复上报", () => {
  test("同一回合的错误帧再来一次:仍只有一张卡,只报一次", () => {
    const s = sess();
    const reportProblemCard = vi.fn();
    applyOutboundError(s, errorFrame(), { reportProblemCard });
    s._sendingInFlight = true;
    s._activeClientMessageId = "u1";
    applyOutboundError(s, errorFrame(), { reportProblemCard });
    expect(s.messages.filter((m) => m._errorCode)).toHaveLength(1);
    expect(reportProblemCard).toHaveBeenCalledTimes(1);
  });
});
