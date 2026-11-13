import { describe, expect, test } from "vitest";
import { createSession, type ChatMessage } from "./model";
import { paintDeferredTerminalError } from "./reducer";
import { freezeErrorCardSnapshots, isErrorCardHeld } from "./render";

/**
 * INC-20261006-DOUBLE-FAILURE-CARD × 浏览器自有恢复:恢复决定为「不再重试」时,这一轮被
 * freezeErrorCardSnapshots 挂起的状态记录(已确认未计费)也要放出来。只放红卡时,状态记录仍挂起
 * 不显示,而它又把同轮红卡收起 → 一张卡都没有(REST 对账循环删掉后不再有第二次 freeze 补救)。
 */
describe("paintDeferredTerminalError 放出同轮挂起的卡", () => {
  test("declined decision commits the held status record and the red card", () => {
    const sess = createSession({ id: "s1", agentId: "main" });
    const cmid = "m-recover-last";
    sess.messages.push(...([
      { id: cmid, role: "user", text: "q", ts: 1, status: "error", _source: "server" },
      { id: `turn-status:${cmid}`, role: "system", text: "", ts: 2, _source: "server", _clientMessageId: cmid,
        _turnStatusRecord: true, _dispatchTerminal: true, _errorCode: "dispatch_lost" },
      { id: `error-${cmid}`, role: "assistant", text: "", ts: 3, _source: "server", _clientMessageId: cmid,
        _errorCode: "ENGINE_ERROR" },
    ] as ChatMessage[]));
    // Full sync while the recovery decision is pending: both cards are held.
    freezeErrorCardSnapshots(sess.messages, cmid);
    const status = sess.messages[1]!;
    expect(isErrorCardHeld(status)).toBe(true);

    expect(paintDeferredTerminalError(sess, { normalized: "ENGINE_ERROR", text: "", clientMessageId: cmid })).toBe(true);
    expect(isErrorCardHeld(status)).toBe(false);
    expect(status._errorCardSnapshot?.disposition).toBe("card");
    expect(sess.messages[2]!._errorCardSnapshot?.disposition).toBe("card");
  });
});
