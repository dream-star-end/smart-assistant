import { beforeEach, describe, expect, test, vi } from "vitest";
import type { IncidentWire } from "./chat/frames";
import { incidentStore } from "./incidentStore";

function frame(over: Partial<IncidentWire>): IncidentWire {
  return {
    type: "sys.incident",
    incidentId: "inc-1",
    rev: 1,
    status: "open",
    severity: "warning",
    surface: "image",
    title: "图片生成暂时不可用",
    message: "我们正在自动修复，稍后重试即可。",
    ts: 1000,
    ...over,
  };
}

describe("incidentStore rev 幂等", () => {
  beforeEach(() => incidentStore._resetForTest());

  test("open → 进入活跃列表", () => {
    incidentStore.ingest(frame({ rev: 1 }));
    const snap = incidentStore.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].incidentId).toBe("inc-1");
    expect(snap[0].severity).toBe("warning");
  });

  test("更高 rev 就地升级（warning→critical）", () => {
    incidentStore.ingest(frame({ rev: 1, severity: "warning" }));
    incidentStore.ingest(frame({ rev: 2, severity: "critical" }));
    const snap = incidentStore.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].severity).toBe("critical");
    expect(snap[0].rev).toBe(2);
  });

  test("同/低 rev 丢弃（不覆盖已有）", () => {
    incidentStore.ingest(frame({ rev: 3, severity: "critical" }));
    incidentStore.ingest(frame({ rev: 3, severity: "info" })); // 同 rev
    incidentStore.ingest(frame({ rev: 2, severity: "info" })); // 低 rev
    expect(incidentStore.getSnapshot()[0].severity).toBe("critical");
  });

  test("resolved 移出活跃 + 触发一次性恢复事件", () => {
    const seen: string[] = [];
    const off = incidentStore.onResolved((e) => seen.push(e.incidentId));
    incidentStore.ingest(frame({ rev: 1, status: "open" }));
    incidentStore.ingest(frame({ rev: 2, status: "resolved", message: "图片生成已恢复。" }));
    expect(incidentStore.getSnapshot()).toHaveLength(0);
    expect(seen).toEqual(["inc-1"]);
    off();
  });

  test("resolved 后迟到的低 rev open 不复活（M4 核心）", () => {
    incidentStore.ingest(frame({ rev: 1, status: "open" }));
    incidentStore.ingest(frame({ rev: 2, status: "resolved" }));
    incidentStore.ingest(frame({ rev: 1, status: "open" })); // 乱序迟到
    expect(incidentStore.getSnapshot()).toHaveLength(0);
  });

  test("从未活跃的事故 resolved → 不发恢复事件、活跃集不变", () => {
    const fn = vi.fn();
    const off = incidentStore.onResolved(fn);
    incidentStore.ingest(frame({ rev: 5, status: "resolved" }));
    expect(fn).not.toHaveBeenCalled();
    expect(incidentStore.getSnapshot()).toHaveLength(0);
    off();
  });

  test("多事故按 severity 降序堆叠", () => {
    incidentStore.ingest(frame({ incidentId: "a", rev: 1, severity: "info", ts: 1 }));
    incidentStore.ingest(frame({ incidentId: "b", rev: 1, severity: "critical", ts: 2 }));
    incidentStore.ingest(frame({ incidentId: "c", rev: 1, severity: "warning", ts: 3 }));
    expect(incidentStore.getSnapshot().map((i) => i.incidentId)).toEqual(["b", "c", "a"]);
  });

  test("恢复事件缓冲：晚挂载的消费者不丢事件", () => {
    incidentStore.ingest(frame({ rev: 1, status: "open" }));
    incidentStore.ingest(frame({ rev: 2, status: "resolved" }));
    const seen: string[] = [];
    incidentStore.onResolved((e) => seen.push(e.incidentId)); // 事件已发生后才订阅
    expect(seen).toEqual(["inc-1"]);
  });
});
