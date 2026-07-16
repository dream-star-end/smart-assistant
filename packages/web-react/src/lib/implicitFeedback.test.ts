/**
 * 隐式负反馈纯函数契约测试:相似度/改写目标/打断目标/高成本判定的边界。
 * now 全部显式传入（纯函数,不取真实时钟）。
 */
import { describe, expect, test } from "vitest";
import type { ChatMessage } from "./chat/model";
import {
  findRewriteTarget,
  findStopTarget,
  isExpensiveTurn,
  rewriteSimilarity,
} from "./implicitFeedback";

let seq = 0;
function mk(
  role: ChatMessage["role"],
  text: string,
  ts: number,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id: extra.id ?? `m${seq++}`, role, text, ts, ...extra };
}

const MIN = 60_000;

describe("rewriteSimilarity", () => {
  test("高相似中文改写（改一个字）→ 远超 0.55", () => {
    const s = rewriteSimilarity("帮我写一首关于春天的诗", "帮我写一首关于秋天的诗");
    expect(s).toBeGreaterThan(0.55);
  });

  test("完全不相干中文 → 远低于 0.55", () => {
    const s = rewriteSimilarity("今天上海天气怎么样", "帮我写一段快速排序代码");
    expect(s).toBeLessThan(0.55);
  });

  test("忽略大小写与标点/空白（归一化）", () => {
    expect(rewriteSimilarity("Hello, World!", "hello world")).toBe(1);
  });

  test("归一化后长度<2 → 整串相等回退（相等 1）", () => {
    expect(rewriteSimilarity("A", "a")).toBe(1);
  });

  test("归一化后长度<2 且不等 → 0", () => {
    expect(rewriteSimilarity("啊", "哦")).toBe(0);
  });
});

describe("findRewriteTarget", () => {
  const now = 1_000_000;
  const base = [
    mk("user", "帮我写一首关于春天的诗", now - MIN, { id: "u1" }),
    mk("assistant", "好的，这是一首关于春天的诗……", now - MIN + 5_000, {
      id: "a1",
      usage: { traceId: "trace-a1" },
    }),
  ];

  test("近期高相似改写 → 命中末条 assistant，带 traceId", () => {
    const t = findRewriteTarget(base, "帮我写一首关于秋天的诗", now);
    expect(t).toEqual({ messageId: "a1", traceId: "trace-a1" });
  });

  test("超出 5min 窗口 → null", () => {
    const old = [
      mk("user", "帮我写一首关于春天的诗", now - 6 * MIN, { id: "u1" }),
      mk("assistant", "……", now - 6 * MIN + 1000, { id: "a1" }),
    ];
    expect(findRewriteTarget(old, "帮我写一首关于秋天的诗", now)).toBeNull();
  });

  test("相似度低（真·新问题）→ null", () => {
    expect(findRewriteTarget(base, "帮我查一下明天的航班时刻", now)).toBeNull();
  });

  test("新文本归一化后过短（<4）→ null", () => {
    const short = [
      mk("user", "继续", now - 1000, { id: "u1" }),
      mk("assistant", "……", now - 500, { id: "a1" }),
    ];
    expect(findRewriteTarget(short, "继续", now)).toBeNull();
  });

  test("U 之后无 assistant 正文 → null", () => {
    const noAssistant = [mk("user", "帮我写一首关于春天的诗", now - 1000, { id: "u1" })];
    expect(findRewriteTarget(noAssistant, "帮我写一首关于秋天的诗", now)).toBeNull();
  });

  test("末条 assistant 是 error 行 → 跳过，退回上一条正文", () => {
    const withError = [
      mk("user", "帮我写一首关于春天的诗", now - MIN, { id: "u1" }),
      mk("assistant", "第一段回答……", now - MIN + 1000, { id: "a1", usage: { traceId: "t1" } }),
      mk("assistant", "出错了", now - MIN + 2000, { id: "a2", _errorCode: "ENGINE_ERROR" }),
    ];
    const t = findRewriteTarget(withError, "帮我写一首关于秋天的诗", now);
    expect(t).toEqual({ messageId: "a1", traceId: "t1" });
  });

  test("无 traceId → traceId 归 null", () => {
    const noTrace = [
      mk("user", "帮我写一首关于春天的诗", now - MIN, { id: "u1" }),
      mk("assistant", "好的……", now - MIN + 1000, { id: "a1" }),
    ];
    expect(findRewriteTarget(noTrace, "帮我写一首关于秋天的诗", now)).toEqual({
      messageId: "a1",
      traceId: null,
    });
  });
});

describe("findStopTarget", () => {
  const now = 1_000_000;

  test("已过秒停窗 + 有 assistant 正文 → 命中末条", () => {
    const msgs = [
      mk("user", "解释一下量子纠缠", now - 30_000, { id: "u1" }),
      mk("assistant", "量子纠缠是……", now - 20_000, { id: "a1", usage: { traceId: "t1" } }),
    ];
    expect(findStopTarget(msgs, now)).toEqual({ messageId: "a1", traceId: "t1" });
  });

  test("秒停（<10s）→ null（过滤手滑）", () => {
    const msgs = [
      mk("user", "解释一下量子纠缠", now - 3_000, { id: "u1" }),
      mk("assistant", "量子纠缠是……", now - 2_000, { id: "a1" }),
    ];
    expect(findStopTarget(msgs, now)).toBeNull();
  });

  test("打断时还没有 assistant 正文 → null", () => {
    const msgs = [mk("user", "解释一下量子纠缠", now - 30_000, { id: "u1" })];
    expect(findStopTarget(msgs, now)).toBeNull();
  });

  test("末条 assistant 是 error → 跳过，退回上一条正文", () => {
    const msgs = [
      mk("user", "解释一下量子纠缠", now - 30_000, { id: "u1" }),
      mk("assistant", "量子纠缠是……", now - 20_000, { id: "a1", usage: { traceId: "t1" } }),
      mk("assistant", "连接断开", now - 15_000, { id: "a2", _errorCode: "STREAM_ERROR" }),
    ];
    expect(findStopTarget(msgs, now)).toEqual({ messageId: "a1", traceId: "t1" });
  });
});

describe("isExpensiveTurn", () => {
  const t0 = 1_000_000;

  test("耗时 ≥ 60s → 高成本", () => {
    const msgs = [
      mk("user", "做个复杂分析", t0, { id: "u1" }),
      mk("assistant", "分析结果……", t0 + 61_000, { id: "a1", completedAt: t0 + 61_000 }),
    ];
    expect(isExpensiveTurn(msgs)).toBe(true);
  });

  test("工具/团队消息 ≥ 3 → 高成本", () => {
    const msgs = [
      mk("user", "查资料并汇总", t0, { id: "u1" }),
      mk("tool", "search", t0 + 1000, { id: "x1" }),
      mk("tool", "fetch", t0 + 2000, { id: "x2" }),
      mk("agent-group", "delegate", t0 + 3000, { id: "x3" }),
      mk("assistant", "汇总完成", t0 + 4000, { id: "a1", completedAt: t0 + 4000 }),
    ];
    expect(isExpensiveTurn(msgs)).toBe(true);
  });

  test("快速纯文本轮（<60s 且工具<3）→ 非高成本", () => {
    const msgs = [
      mk("user", "你好", t0, { id: "u1" }),
      mk("assistant", "你好，有什么可以帮你？", t0 + 2000, { id: "a1", completedAt: t0 + 2000 }),
    ];
    expect(isExpensiveTurn(msgs)).toBe(false);
  });

  test("空消息流 → false", () => {
    expect(isExpensiveTurn([])).toBe(false);
  });
});
