/**
 * 生成占位卡（需求 C）帧序列驱动的行为契约：
 *  - 注入：socket.sendMessage 在 imageEdit 提交时紧随乐观 user 行注入运行中占位（jobId=clientJobId）。
 *  - 消解：本会话 turn final 到达时按 jobId 删占位（结果图作为 assistant 消息自然渲染）；
 *          交付帧未回带 clientJobId 的过渡态按「turn 串行」语义兜底消解。
 *  - 失败：turn error（结构化/legacy）→ 运行中占位转 failed（带原因）。
 *  - 不持久化：toStored 剥离占位行 → 重开会话（loadStored 回放）不留孤儿卡。
 *
 * 帧构造复刻 chat.test.ts 的 msgFrame()/sess() 模式。
 */
import { describe, expect, test } from "vitest";
import { addMessage, type ChatSession, createSession } from "./model";
import type { LegacyBridgeErrorWire, OutboundErrorWire, OutboundMessageWire } from "./frames";
import { applyLegacyBridgeError, applyOutboundError, applyOutboundMessage } from "./reducer";
import { ChatSocket, type ChatSocketDeps } from "./socket";

const JOB = "a".repeat(32);
const JOB2 = "b".repeat(32);

function sess(id = "s1"): ChatSession {
  return createSession({ id, agentId: "main" });
}
type AnyFrame = Record<string, unknown>;
function msgFrame(over: AnyFrame): OutboundMessageWire {
  return {
    type: "outbound.message",
    sessionKey: "agent:main:webchat:dm:s1",
    channel: "webchat",
    peer: { id: "s1", kind: "dm" },
    blocks: [],
    isFinal: false,
    ...over,
  } as unknown as OutboundMessageWire;
}
function makeSocket(overrides: Partial<ChatSocketDeps> = {}) {
  return new ChatSocket({
    getToken: () => "tok",
    silentRefresh: async () => null,
    onAuthExpired: () => {},
    defaultAgentId: "main",
    ...overrides,
  });
}
/** 直接注入一条运行中占位行（镜像 socket.sendMessage 的注入形态），供 reducer 单测起手。 */
function seedRunningPlaceholder(s: ChatSession, jobId = JOB, aspect: number | string = 1.25) {
  addMessage(s, "user", "把杯子改成玻璃杯", { status: "sending" });
  addMessage(s, "system", "", { _genPlaceholder: { jobId, aspect, status: "running", startedAt: Date.now() } });
  s._sendingInFlight = true;
}

describe("生成占位卡注入（socket.sendMessage）", () => {
  test("imageEdit 提交紧随乐观 user 行注入运行中占位（jobId=clientJobId，aspect=w/h）", () => {
    const sock = makeSocket();
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "把杯子改成玻璃杯",
      media: [
        { kind: "image", url: "/api/media/source.png", hidden: true },
        { kind: "image", url: "/api/media/mask.png", hidden: true },
        { kind: "image", url: "/api/media/guide.png" },
      ],
      imageEdit: { clientJobId: JOB, sourceIndex: 0, maskIndex: 1, guideIndex: 2, width: 100, height: 80 },
    });
    const s = sock.sessions.get("s1")!;
    const phIdx = s.messages.findIndex((m) => m._genPlaceholder);
    const userIdx = s.messages.findIndex((m) => m.role === "user");
    expect(phIdx).toBe(userIdx + 1); // 紧随乐观 user 行
    expect(s.messages[phIdx]._genPlaceholder).toMatchObject({ jobId: JOB, status: "running", aspect: 100 / 80 });
  });

  test("占位卡宽高比=源图宽高比,横图横卡不颠倒（§4 回归：评论/编辑/调整大小）", () => {
    const sock = makeSocket();
    // 评论/编辑（annotated）：横图源 1536×1024 → aspect=1.5>1（横卡），绝不颠倒成竖长条。
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "评论修改",
      media: [
        { kind: "image", url: "/api/media/source.png", hidden: true },
        { kind: "image", url: "/api/media/mask.png", hidden: true },
        { kind: "image", url: "/api/media/guide.png" },
      ],
      imageEdit: {
        clientJobId: JOB,
        mode: "annotated",
        sourceIndex: 0,
        maskIndex: 1,
        guideIndex: 2,
        width: 1536,
        height: 1024,
      },
    });
    const gp = sock.sessions.get("s1")!.messages.find((m) => m._genPlaceholder)!._genPlaceholder!;
    expect(gp.aspect).toBe(1536 / 1024);
    expect(gp.aspect as number).toBeGreaterThan(1);

    // 调整大小（outpaint）：aspect=目标比例枚举字符串（不取源图 w/h）。
    sock.sendMessage({
      sessId: "s2",
      agentId: "main",
      text: "调整大小",
      media: [
        { kind: "image", url: "/api/media/source.png", hidden: true },
        { kind: "image", url: "/api/media/guide.png" },
      ],
      imageEdit: {
        clientJobId: JOB2,
        mode: "outpaint",
        targetAspect: "16:9",
        sourceIndex: 0,
        guideIndex: 1,
        width: 1024,
        height: 1536,
      },
    });
    const gp2 = sock.sessions.get("s2")!.messages.find((m) => m._genPlaceholder)!._genPlaceholder!;
    expect(gp2.aspect).toBe("16:9");
  });

  test("普通文本消息不注入占位行", () => {
    const sock = makeSocket();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    expect(sock.sessions.get("s1")!.messages.some((m) => m._genPlaceholder)).toBe(false);
  });
});

describe("生成占位卡消解（turn final）", () => {
  test("final 回带顶层 imageEditJobId（B 契约）→ 精确消解占位；assistant 结果行保留", () => {
    const s = sess();
    seedRunningPlaceholder(s, JOB);
    applyOutboundMessage(
      s,
      msgFrame({ isFinal: true, imageEditJobId: JOB, blocks: [{ kind: "text", text: "已完成\n\n/gen/out.png" }] }),
    );
    expect(s.messages.some((m) => m._genPlaceholder)).toBe(false);
    expect(s.messages.some((m) => m.role === "assistant")).toBe(true);
  });

  test("final 未回带 imageEditJobId（普通 turn/旧 gateway）→ 按 turn 串行语义兜底消解运行中占位", () => {
    const s = sess();
    seedRunningPlaceholder(s, JOB);
    applyOutboundMessage(s, msgFrame({ isFinal: true, blocks: [{ kind: "text", text: "已完成\n\n/gen/out.png" }] }));
    expect(s.messages.some((m) => m._genPlaceholder)).toBe(false);
  });

  test("final 回带的 imageEditJobId 与占位 jobId 不匹配 → 占位保留（精确匹配不误删他人任务）", () => {
    const s = sess();
    seedRunningPlaceholder(s, JOB);
    applyOutboundMessage(s, msgFrame({ isFinal: true, imageEditJobId: JOB2, blocks: [{ kind: "text", text: "无关轮" }] }));
    expect(s.messages.some((m) => m._genPlaceholder?.jobId === JOB && m._genPlaceholder?.status === "running")).toBe(true);
  });

  test("重试成功：final 按 imageEditJobId 消解**失败**残留占位（重试复用同 job，不留孤儿失败卡）", () => {
    const s = sess();
    seedRunningPlaceholder(s, JOB);
    s.messages.find((m) => m._genPlaceholder)!._genPlaceholder!.status = "failed";
    applyOutboundMessage(
      s,
      msgFrame({ isFinal: true, imageEditJobId: JOB, blocks: [{ kind: "text", text: "已完成\n\n/gen/out.png" }] }),
    );
    expect(s.messages.some((m) => m._genPlaceholder)).toBe(false);
  });
});

describe("生成占位卡失败（turn error）", () => {
  test("结构化 outbound.error → 运行中占位转 failed（带原因）", () => {
    const s = sess();
    seedRunningPlaceholder(s, JOB);
    applyOutboundError(s, {
      type: "outbound.error",
      code: "upstream_error",
      message: "boom",
      peer: { id: "s1", kind: "dm" },
    } as unknown as OutboundErrorWire);
    const ph = s.messages.find((m) => m._genPlaceholder);
    expect(ph!._genPlaceholder!.status).toBe("failed");
    expect(ph!._genPlaceholder!.reason).toBeTruthy();
  });

  test("legacy bridge error → 运行中占位转 failed", () => {
    const s = sess();
    seedRunningPlaceholder(s, JOB);
    applyLegacyBridgeError(s, {
      type: "error",
      code: "upstream_error",
      message: "boom",
      peer: { id: "s1", kind: "dm" },
    } as unknown as LegacyBridgeErrorWire);
    expect(s.messages.find((m) => m._genPlaceholder)!._genPlaceholder!.status).toBe("failed");
  });

  test("重试：imageEdit 重试把失败占位原地重置回 running（复用同 clientJobId，重试期显示生成中）", () => {
    const sock = makeSocket();
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "把杯子改成玻璃杯",
      imageEdit: { clientJobId: JOB, sourceIndex: 0, maskIndex: 1, guideIndex: 2, width: 100, height: 80 },
    });
    const s = sock.sessions.get("s1")!;
    const user = s.messages.find((m) => m.role === "user")!;
    // 模拟本轮失败：占位转 failed、user 行 error、清 in-flight。
    s.messages.find((m) => m._genPlaceholder)!._genPlaceholder!.status = "failed";
    user.status = "error";
    s._sendingInFlight = false;
    sock.retryMessage({ sessId: "s1", msgId: user.id, agentId: "main" });
    const ph = s.messages.filter((m) => m._genPlaceholder?.jobId === JOB);
    expect(ph).toHaveLength(1); // 原地重置，不新增第二张
    expect(ph[0]._genPlaceholder!.status).toBe("running");
  });
});

describe("生成占位卡不持久化（重开无孤儿）", () => {
  test("toStored 剥离占位行、保留 user 行；loadStored 回放不重建占位", () => {
    const sock = makeSocket();
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "调整为 16:9",
      imageEdit: { clientJobId: JOB, sourceIndex: 0, maskIndex: 1, guideIndex: 2, width: 100, height: 100 },
    });
    // live 会话里占位在
    expect(sock.sessions.get("s1")!.messages.some((m) => m._genPlaceholder)).toBe(true);
    const stored = sock.toStored("s1")!;
    expect(stored.messages.some((m) => m._genPlaceholder)).toBe(false);
    expect(stored.messages.some((m) => m.role === "user")).toBe(true);
    // 重开（新 socket 注水）→ 无孤儿占位卡
    const reopened = makeSocket();
    reopened.loadStored(stored);
    expect(reopened.sessions.get("s1")!.messages.some((m) => m._genPlaceholder)).toBe(false);
  });
});
