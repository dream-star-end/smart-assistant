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
import { addMessage, type ChatMessage, type ChatSession, createSession } from "./model";
import type {
  LegacyBridgeErrorWire,
  OutboundErrorWire,
  OutboundMessageWire,
  OutboundResumeFailedWire,
} from "./frames";
import {
  applyLegacyBridgeError,
  applyOutboundError,
  applyOutboundMessage,
  applyResumeFailed,
  resetAgentFrameSeqCursorsForSession,
} from "./reducer";
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
    silentRefresh: async () => ({ kind: "invalid" as const }),
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

// ═══════════════ 2026-07-11 boss 生产事故回归(会话 webmrfo3rtrwhgi15) ═══════════════
// 事故链:容器 6h 闲置被回收(oc-v5-u1 19:36 重建)→ outboundRing 内存计数从零 → 22:10 页面
// boot hello,容器仲裁答复 resume_failed{from:14,to:0,no_buffer}(实测容器日志),旧客户端游标
// 只进不退停在 14 → 22:12 提交圈选编辑(占位注入)→ 22:13 免模型直投终帧 frameSeq=1 ≤ 14 被
// acceptFrameSeq 当重复帧丢弃 → 占位永转;结果行靠 REST 对账(applyServerMessages)迟到补上,
// 该路径不消解占位;cost_charged 不进 frameSeq 去重故计费正常(实测 22:13:16 余额刷新),
// 使 bug 看似"只有占位卡坏了"。帧形态均按生产实录构造。
describe("生产回归:冷容器 frameSeq 重置 → 直投终帧黑洞", () => {
  /** 生产实录形态的直投终帧(gateway server.ts delivered + deliver() ts/frameSeq 盖章)。 */
  function prodDeliveredFinal(frameSeq: number, jobId = JOB): OutboundMessageWire {
    return msgFrame({
      isFinal: true,
      imageEditJobId: jobId,
      traceId: "1376356b8b67e1f789321e198329cf2b",
      ts: Date.now(),
      frameSeq,
      blocks: [
        {
          kind: "text",
          text: `已完成圈选区域的精确修改（Image 2 · 50 积分）。\n\n/home/agent/.openclaude/generated/image2-edit-${jobId}.png`,
          messageId: "srv-webmrfo3rtrwhgi15-x",
        },
      ],
    });
  }

  test("事故复盘全链:resume_failed(no_buffer,to=0) 归零游标 → 冷容器终帧 frameSeq=1 被接受,占位消解", () => {
    const sock = makeSocket();
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "蓝色眼睛",
      imageEdit: { clientJobId: JOB, sourceIndex: 0, maskIndex: 1, guideIndex: 2, width: 1024, height: 1024 },
    });
    const s = sock.sessions.get("s1")!;
    // 上一代容器时代持久化下来的游标(IndexedDB 注水语义)。
    s._lastFrameSeqByKey!["agent:main:webchat:dm:s1"] = 14;
    // hello 仲裁:容器答复空 ring(生产实录 {from:14,to:0,reason:no_buffer})→ 游标归零。
    applyResumeFailed(
      s,
      {
        type: "outbound.resume_failed",
        sessionKey: "agent:main:webchat:dm:s1",
        channel: "webchat",
        peer: { id: "s1", kind: "dm" },
        from: 14,
        to: 0,
        reason: "no_buffer",
        ts: Date.now(),
      } as unknown as OutboundResumeFailedWire,
      {},
    );
    expect(s._lastFrameSeqByKey?.["agent:main:webchat:dm:s1"]).toBe(0);
    // 冷容器新生代直投终帧 frameSeq=1:必须被接受(事故中被当重复帧丢弃)。
    applyOutboundMessage(s, prodDeliveredFinal(1));
    expect(s.messages.some((m) => m._genPlaceholder)).toBe(false); // 占位已消解
    expect(s.messages.some((m) => m.role === "assistant" && (m.text || "").includes("已完成圈选区域"))).toBe(true);
    expect(s._sendingInFlight).toBe(false); // 发送态正常收尾(事故中挂到 thinking-safety)
  });

  test("sys.cold_start(容器中途回收,无 hello 仲裁)→ 该会话 agent-scoped 游标归零", () => {
    const s = sess();
    s._lastFrameSeqByKey = {
      "agent:main:webchat:dm:s1": 14,
      "agent:coder:webchat:dm:s1": 9,
      "agent:main:webchat:dm:OTHER": 33, // 别的会话的游标不受影响
    };
    resetAgentFrameSeqCursorsForSession(s);
    expect(s._lastFrameSeqByKey["agent:main:webchat:dm:s1"]).toBeUndefined();
    expect(s._lastFrameSeqByKey["agent:coder:webchat:dm:s1"]).toBeUndefined();
    expect(s._lastFrameSeqByKey["agent:main:webchat:dm:OTHER"]).toBe(33);
  });

  test("兜底:终帧仍丢失时,REST 对账(锚点 user 行 echo + 更晚 _seq 的 server assistant 行)清运行中占位", () => {
    const sock = makeSocket();
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "蓝色眼睛",
      imageEdit: { clientJobId: JOB, sourceIndex: 0, maskIndex: 1, guideIndex: 2, width: 1024, height: 1024 },
    });
    const s = sock.sessions.get("s1")!;
    const user = s.messages.find((m) => m.role === "user")!;
    expect(s.messages.find((m) => m._genPlaceholder)!._genPlaceholder!.afterUserMsgId).toBe(user.id);
    // 终帧丢失(什么都不发生);随后 REST 对账带回:user 行 echo(_seq=16)+ 直投结果行(_seq=17)。
    sock.applyServerMessages(
      "s1",
      "main",
      [
        { id: user.id, role: "user", text: user.text, ts: user.ts, _seq: 16 },
        {
          id: "srv-webmrfo3rtrwhgi15-17",
          role: "assistant",
          text: "已完成圈选区域的精确修改（Image 2 · 50 积分）。\n\n/home/agent/.openclaude/generated/x.png",
          ts: Date.now(),
          _source: "server",
          _seq: 17,
        },
      ] as ChatMessage[],
      false,
    );
    const after = sock.sessions.get("s1")!;
    expect(after.messages.some((m) => m._genPlaceholder)).toBe(false); // 占位被兜底消解
    expect(after.messages.some((m) => m.role === "assistant" && (m.text || "").includes("已完成圈选区域"))).toBe(true);
  });

  test("兜底不误清:对账只带回 user echo(轮未收尾/无更晚 assistant 行)→ 运行中占位保留", () => {
    const sock = makeSocket();
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "蓝色眼睛",
      imageEdit: { clientJobId: JOB, sourceIndex: 0, maskIndex: 1, guideIndex: 2, width: 1024, height: 1024 },
    });
    const s = sock.sessions.get("s1")!;
    const user = s.messages.find((m) => m.role === "user")!;
    sock.applyServerMessages(
      "s1",
      "main",
      [{ id: user.id, role: "user", text: user.text, ts: user.ts, _seq: 16 }] as ChatMessage[],
      false,
    );
    expect(sock.sessions.get("s1")!.messages.some((m) => m._genPlaceholder?.status === "running")).toBe(true);
  });

  test("兜底不误清:锚点 user 行尚未被 server echo(_seq 缺省)→ 占位保留(fail-safe)", () => {
    const sock = makeSocket();
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "蓝色眼睛",
      imageEdit: { clientJobId: JOB, sourceIndex: 0, maskIndex: 1, guideIndex: 2, width: 1024, height: 1024 },
    });
    // 对账只带回一条与本轮无关、但 _seq 很大的 server assistant 行;锚点 user 行没有 _seq。
    sock.applyServerMessages(
      "s1",
      "main",
      [
        {
          id: "srv-old-assistant",
          role: "assistant",
          text: "旧轮回答",
          ts: Date.now() - 1,
          _source: "server",
          _seq: 999,
        },
      ] as ChatMessage[],
      false,
    );
    expect(sock.sessions.get("s1")!.messages.some((m) => m._genPlaceholder?.status === "running")).toBe(true);
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
