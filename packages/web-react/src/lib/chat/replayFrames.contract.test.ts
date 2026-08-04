/**
 * 真浏览器 replay fixture 的**协议形状门**。
 *
 * browser-tests/fixtures/turnReplay.ts 是"真 wire 帧驱动真 DOM"用例(T21/T25)的唯一
 * 帧来源。若它只是手写的相似 JSON,那条链绿了也证明不了线上帧能被消化 —— 帧字段
 * 一改,fixture 照旧、用例照绿、线上照挂。这里用 protocol 的 typebox schema 逐帧校验,
 * 把 fixture 钉在与 gateway 出站帧同一个契约上:protocol 改形状 → 这里先红。
 *
 * 断言的是**契约**(帧能通过 schema、序列的 wire 不变量),不是字面排列。
 */
import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "vitest";
import { OutboundMessage, OutboundTurnStatus } from "@openclaude/protocol/frames";
import {
  admittedAckFrame,
  EXPECTED_TIMELINE_ROLES,
  relayReadyFrame,
  REPLAY_MARKERS,
  legacyRetryStatusFrame,
  replayTurnFrames,
} from "../../../browser-tests/fixtures/turnReplay";

const CMID = "m-replaycontract01";

describe("browser replay fixture ↔ protocol wire 契约", () => {
  test("每一帧 outbound.message 都能通过 protocol typebox 校验", () => {
    const frames = replayTurnFrames(CMID);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      const errors = [...Value.Errors(OutboundMessage, frame)].map(
        (e) => `${e.path}: ${e.message}`,
      );
      expect(errors, `帧 frameSeq=${String(frame.frameSeq)} 不符合 OutboundMessage`).toEqual([]);
    }
  });

  test("fixture 覆盖时间线四类可见记录的 block 种类(少一类就不再是完整一轮)", () => {
    const kinds = new Set(
      replayTurnFrames(CMID).flatMap((frame) =>
        (frame.blocks as Array<{ kind: string }>).map((b) => b.kind),
      ),
    );
    for (const kind of ["thinking", "tool_use", "tool_output_tail", "tool_result", "text"]) {
      expect(kinds.has(kind), `fixture 缺 ${kind} 块`).toBe(true);
    }
    expect(EXPECTED_TIMELINE_ROLES).toContain("thinking");
    expect(EXPECTED_TIMELINE_ROLES).toContain("tool");
  });

  test("frameSeq 严格单调:非单调帧会被 acceptFrameSeq 当重复帧丢弃", () => {
    const seqs = replayTurnFrames(CMID).map((f) => f.frameSeq as number);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  test("整轮只有最后一帧 isFinal,且 clientMessageId 全程绑定同一次浏览器发送", () => {
    const frames = replayTurnFrames(CMID);
    const finals = frames.filter((f) => f.isFinal === true);
    expect(finals.length).toBe(1);
    expect(finals[0]).toBe(frames[frames.length - 1]);
    for (const frame of frames) expect(frame.clientMessageId).toBe(CMID);
  });

  test("tool_output_tail 的 toolUseBlockId 指向本轮真实 tool_use(否则 tail 无处落卡)", () => {
    const frames = replayTurnFrames(CMID);
    const blocks = frames.flatMap(
      (f) => f.blocks as Array<Record<string, unknown>>,
    );
    const use = blocks.find((b) => b.kind === "tool_use");
    const tail = blocks.find((b) => b.kind === "tool_output_tail");
    const result = blocks.find((b) => b.kind === "tool_result");
    expect(tail?.toolUseBlockId).toBe(use?.blockId);
    expect(result?.toolUseBlockId).toBe(use?.blockId);
  });

  test("受理 ACK / relay 就绪帧形状与消费侧 handler 对齐", () => {
    expect(relayReadyFrame.type).toBe("sys.relay_ready");
    const ack = admittedAckFrame(CMID);
    expect(ack).toMatchObject({ type: "outbound.ack", admitted: true, clientMessageId: CMID });
    expect(ack.idempotencyKey).toBe(`web:${CMID}:0`);
  });

  test("滚动旧 gateway 的 max=3 retry status 仍符合兼容 wire 契约", () => {
    const frame = legacyRetryStatusFrame(Date.now() + 1_000);
    const errors = [...Value.Errors(OutboundTurnStatus, frame)].map(
      (e) => `${e.path}: ${e.message}`,
    );
    expect(errors).toEqual([]);
  });

  test("DOM 断言用的精确文本标记互不相同(避免断言互相误命中)", () => {
    const values = Object.values(REPLAY_MARKERS);
    expect(new Set(values).size).toBe(values.length);
  });
});
