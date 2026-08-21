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
  newTokenRatio,
  rewriteSimilarity,
  ratingNudgeBucket,
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

describe("ratingNudgeBucket", () => {
  test("is stable across calls and always returns one of ten buckets", () => {
    const values = Array.from({ length: 100 }, (_, i) => ratingNudgeBucket(`message-${i}`));
    expect(values.every((value) => value >= 0 && value <= 9)).toBe(true);
    expect(ratingNudgeBucket("same-message")).toBe(ratingNudgeBucket("same-message"));
    expect(new Set(values).size).toBe(10);
  });
});

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

describe("newTokenRatio", () => {
  test("单字换主题（真·改写）→ 新词占比很低（< 0.3）", () => {
    // 「春天」→「秋天」只换 1 字，共享 10/11 字。
    expect(newTokenRatio("帮我写一首关于春天的诗", "帮我写一首关于秋天的诗")).toBeLessThan(0.3);
  });

  test("整词换实体（顺序任务）→ 新词占比很高（≥ 0.3）", () => {
    // 「快排」→「归并」是完全不同的技术名(归/并 均为新 token)。
    expect(newTokenRatio("写Python快排", "写Python归并")).toBeGreaterThanOrEqual(0.3);
  });

  test("完全一致 → 0", () => {
    expect(newTokenRatio("写Python快排", "写Python快排")).toBe(0);
  });

  test("新文本为空 → 0（不触发收窄）", () => {
    expect(newTokenRatio("写Python快排", "")).toBe(0);
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

  test("高相似但换了新实体（顺序任务，非改写不满）→ null（误伤缓解）", () => {
    // 「写Python快排」→「写Python归并」：相似度 ≥0.55 但引入新实体(归并),是接着做的顺序任务。
    const seq = [
      mk("user", "写Python快排", now - MIN, { id: "u1" }),
      mk("assistant", "def quicksort(a): ...", now - MIN + 1000, { id: "a1", usage: { traceId: "t1" } }),
    ];
    // 前置确认:确实越过了相似度门(证明是新词占比收窄在起作用,而非相似度低导致的 null)。
    expect(rewriteSimilarity("写Python快排", "写Python归并")).toBeGreaterThanOrEqual(0.55);
    expect(findRewriteTarget(seq, "写Python归并", now)).toBeNull();
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

  test("产出很长（≥200 字符）后被 Stop → null（够了已满意，误伤缓解）", () => {
    const longBody = "内容".repeat(120); // 240 字符,无完成语形态
    const msgs = [
      mk("user", "详细讲讲量子纠缠", now - 30_000, { id: "u1" }),
      mk("assistant", longBody, now - 20_000, { id: "a1", usage: { traceId: "t1" } }),
    ];
    expect(findStopTarget(msgs, now)).toBeNull();
  });

  test("短产出但已带完成语形态后被 Stop → null（已收尾，误伤缓解）", () => {
    const msgs = [
      mk("user", "帮我改一下这段代码", now - 30_000, { id: "u1" }),
      mk("assistant", "已经改好了，希望对你有帮助！", now - 20_000, { id: "a1", usage: { traceId: "t1" } }),
    ];
    expect(findStopTarget(msgs, now)).toBeNull();
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
