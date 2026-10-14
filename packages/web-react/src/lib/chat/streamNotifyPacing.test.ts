import { afterEach, describe, expect, test, vi } from "vitest";
import { ChatSocket, nextStreamRenderCostMs, streamNotifyWindowMs } from "./socket";

// OCV5-422: 流式渲染通知的间隔按实测渲染耗时自适应。慢 CPU 上固定 120ms 让渲染首尾相接、主线程满载。
describe("streamNotifyWindowMs / nextStreamRenderCostMs", () => {
  test("快设备仍是 120ms;慢设备按耗时 ×3,封顶 1 秒", () => {
    expect(streamNotifyWindowMs(0)).toBe(120);
    expect(streamNotifyWindowMs(30)).toBe(120);
    expect(streamNotifyWindowMs(100)).toBe(300);
    expect(streamNotifyWindowMs(250)).toBe(750);
    expect(streamNotifyWindowMs(800)).toBe(1000);
    expect(streamNotifyWindowMs(Number.NaN)).toBe(120);
    expect(streamNotifyWindowMs(-5)).toBe(120);
  });

  test("指数平均:首个样本直接采用,之后 0.6/0.4 平滑,坏样本忽略", () => {
    expect(nextStreamRenderCostMs(0, 200)).toBe(200);
    expect(nextStreamRenderCostMs(200, 100)).toBeCloseTo(160);
    expect(nextStreamRenderCostMs(160, Number.NaN)).toBe(160);
    expect(nextStreamRenderCostMs(160, -1)).toBe(160);
  });
});

function makeSocket() {
  return new ChatSocket({
    getToken: () => "tok",
    getAuthEpoch: () => 0,
    silentRefresh: async (epoch: number) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {},
    defaultAgentId: "main",
  } as ConstructorParameters<typeof ChatSocket>[0]);
}

describe("ChatSocket 流式通知节奏", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("一次渲染 200ms 时,流式中下一次通知等到 600ms 窗口;本轮结束的变更改到下一帧", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    // 帧回调走假定时器(16ms 一帧),时间线完全由用例推进。
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const socket = makeSocket();
    socket.loadStored({ id: "s1", title: "t", agentId: "main", messages: [], createdAt: 1, lastAt: 2 } as never);
    const sess = socket.sessions.get("s1") as unknown as { _sendingInFlight?: boolean };
    sess._sendingInFlight = true;
    const renders: number[] = [];
    socket.subscribe(() => {
      renders.push(Date.now());
      clock += 200; // 模拟这次通知触发的 React 渲染耗时
    });
    const notify = () => (socket as unknown as { scheduleNotify(): void }).scheduleNotify();

    notify();
    await vi.advanceTimersByTimeAsync(300);
    expect(renders).toHaveLength(1);
    const first = renders[0]!;

    notify();
    await vi.advanceTimersByTimeAsync(300);
    expect(renders).toHaveLength(1); // 旧的 120ms 窗口早该刷新了;现在按 200ms × 3 等
    await vi.advanceTimersByTimeAsync(300);
    expect(renders).toHaveLength(2);
    expect(renders[1]! - first).toBe(600);

    notify(); // 又一个流式 delta,排进 600ms 窗口
    await vi.advanceTimersByTimeAsync(50);
    sess._sendingInFlight = false; // final:本轮结束
    const endedAt = Date.now();
    notify();
    await vi.advanceTimersByTimeAsync(40);
    expect(renders).toHaveLength(3);
    // 下一帧就刷新,不等还剩 ~500ms 的流式窗口。
    expect(renders[2]! - endedAt).toBeLessThanOrEqual(16);
    expect(renders[2]! - renders[1]!).toBeLessThan(600);
  });

  test("没有进行中的轮次时不降频,也不测量", async () => {
    vi.useFakeTimers({ now: 2_000_000 });
    const socket = makeSocket();
    const renders: number[] = [];
    socket.subscribe(() => renders.push(Date.now()));
    const notify = () => (socket as unknown as { scheduleNotify(): void }).scheduleNotify();
    notify();
    await vi.advanceTimersByTimeAsync(20);
    notify();
    await vi.advanceTimersByTimeAsync(20);
    expect(renders).toHaveLength(2);
    expect((socket as unknown as { streamRenderCostMs: number }).streamRenderCostMs).toBe(0);
  });
});
