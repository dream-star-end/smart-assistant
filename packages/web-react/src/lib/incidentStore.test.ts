import { beforeEach, describe, expect, test, vi } from "vitest";
import type { IncidentWire } from "./chat/frames";
import { incidentStore } from "./incidentStore";

function frame(over: Partial<IncidentWire>): IncidentWire {
  return {
    type: "sys.incident",
    incidentId: "inc-1",
    rev: 1,
    status: "resolved",
    noticeKind: "approved_recovery",
    severity: "info",
    surface: "recovery",
    title: "服务已恢复",
    message: "相关功能现已恢复。",
    ts: 1000,
    ...over,
  };
}

describe("incidentStore — approved recovery only", () => {
  beforeEach(() => incidentStore._resetForTest());

  test("resolved-only approved_recovery 无需先见 open 也会触发一次正向通知", () => {
    const fn = vi.fn();
    const off = incidentStore.onResolved(fn);
    incidentStore.ingest(frame({}));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({
      incidentId: "inc-1",
      message: "相关功能现已恢复。",
    }));
    off();
  });

  test("普通 open/resolved 全部静默，且不会用 rev 压掉后续合法通知", () => {
    const fn = vi.fn();
    const off = incidentStore.onResolved(fn);
    incidentStore.ingest(frame({ status: "open", rev: 99 }));
    incidentStore.ingest(frame({ noticeKind: undefined, rev: 99 }));
    incidentStore.ingest(frame({ rev: 1 }));
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });

  test("相同或更低 rev 重投不重复通知", () => {
    const fn = vi.fn();
    const off = incidentStore.onResolved(fn);
    incidentStore.ingest(frame({ rev: 5 }));
    incidentStore.ingest(frame({ rev: 5 }));
    incidentStore.ingest(frame({ rev: 4 }));
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });

  test("更高 rev 的新审批恢复通知可再次触发", () => {
    const fn = vi.fn();
    const off = incidentStore.onResolved(fn);
    incidentStore.ingest(frame({ rev: 5 }));
    incidentStore.ingest(frame({ rev: 6, message: "二次恢复完成。" }));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1][0].message).toBe("二次恢复完成。");
    off();
  });

  test("恢复事件缓冲：消费者晚挂载不丢事件", () => {
    incidentStore.ingest(frame({ rev: 1 }));
    const seen: string[] = [];
    incidentStore.onResolved((e) => seen.push(e.incidentId));
    expect(seen).toEqual(["inc-1"]);
  });
});
