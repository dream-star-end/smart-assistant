/**
 * reload governor(appUpdate.ts)单测 —— 防无限刷新矩阵 G1-G5 逐条锁死。
 * 这里锁的是"绝不会刷两次/绝不在忙时刷"的安全语义;改任何守卫前先看这组测试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppUpdateGovernor, type AppUpdateDeps } from "./appUpdate";

const CLIENT = "1111111111111111";
const SERVER = "2222222222222222";
const SERVER2 = "3333333333333333";

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, v),
  } as Storage;
}

function make(over?: Partial<AppUpdateDeps> & { storage?: Storage | null }) {
  const reload = vi.fn();
  const storage = over?.storage === undefined ? memStorage() : over.storage;
  const gov = new AppUpdateGovernor({
    getClientBuild: () => CLIENT,
    reload,
    now: () => Date.now(),
    storage,
    ...over,
  });
  return { gov, reload, storage };
}

/** 让"页面加载即活动"的 30s 输入静默期过去。 */
function passIdle() {
  vi.advanceTimersByTime(31_000);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("基本路径", () => {
  it("不匹配 + 安全点 → 恰好一次 reload,attempt 记录落 storage", () => {
    const { gov, reload, storage } = make();
    passIdle();
    gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(6_000); // 首次 check 即安全 → 立即刷;计时器兜底再走一格
    expect(reload).toHaveBeenCalledTimes(1);
    const rec = JSON.parse(storage!.getItem("oc-build-reload")!) as { target: string };
    expect(rec.target).toBe(SERVER);
  });

  it("版本一致 → 完全 no-op(含撤销挂起)", () => {
    const { gov, reload } = make();
    passIdle();
    gov.onServerBuild(CLIENT);
    vi.advanceTimersByTime(60_000);
    expect(reload).not.toHaveBeenCalled();
    expect(gov.getBannerVisible()).toBe(false);
  });

  it("G5:server id 形态非法 / client build 缺失(dev)→ 恒 inert", () => {
    const bad = make();
    passIdle();
    bad.gov.onServerBuild("NOT HEX");
    bad.gov.onServerBuild(123 as unknown as string);
    bad.gov.onServerBuild(undefined);
    vi.advanceTimersByTime(60_000);
    expect(bad.reload).not.toHaveBeenCalled();

    const dev = make({ getClientBuild: () => null });
    passIdle();
    dev.gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(60_000);
    expect(dev.reload).not.toHaveBeenCalled();
    expect(dev.gov.getBannerVisible()).toBe(false);
  });
});

describe("G1 目标一次性(无限刷新的核心闸)", () => {
  it("同一目标第二次(模拟刷新后仍不匹配)→ 不再自动刷,出横幅", () => {
    const first = make();
    passIdle();
    first.gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(6_000);
    expect(first.reload).toHaveBeenCalledTimes(1);

    // "reload 后"的新页面 = 新 governor 实例,共享同一 sessionStorage;client 仍旧值
    const second = make({ storage: first.storage });
    passIdle();
    second.gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(120 * 60_000); // 再久也不刷
    expect(second.reload).not.toHaveBeenCalled();
    expect(second.gov.getBannerVisible()).toBe(true);
  });
});

describe("G2 全局冷却", () => {
  it("新目标在冷却期内 → 先不刷;冷却结束自动补刷", () => {
    const { gov, reload, storage } = make();
    passIdle();
    gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(6_000);
    expect(reload).toHaveBeenCalledTimes(1);

    // 同 tab 未真的刷新(测试环境 reload 是 mock),又来一个新目标
    const g2 = make({ storage });
    passIdle();
    g2.gov.onServerBuild(SERVER2);
    vi.advanceTimersByTime(60_000); // 冷却 10min 未到
    expect(g2.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10 * 60_000); // 冷却过 → 自动补刷
    expect(g2.reload).toHaveBeenCalledTimes(1);
  });
});

describe("G3 storage 不可用", () => {
  it("storage=null → 永不自动刷,只出横幅", () => {
    const { gov, reload } = make({ storage: null });
    passIdle();
    gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(120 * 60_000);
    expect(reload).not.toHaveBeenCalled();
    expect(gov.getBannerVisible()).toBe(true);
  });

  it("写入读不回(配额满等)→ 放弃自动刷,出横幅", () => {
    const broken = {
      ...memStorage(),
      setItem: () => { /* 静默丢写 */ },
      getItem: () => null,
    } as Storage;
    const { gov, reload } = make({ storage: broken });
    passIdle();
    gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(6_000);
    expect(reload).not.toHaveBeenCalled();
    expect(gov.getBannerVisible()).toBe(true);
  });
});

describe("G4 安全点", () => {
  it("busy 探针为真 → 一直推迟;转假后下个重估周期刷", () => {
    const { gov, reload } = make();
    let busy = true;
    gov.registerBusyProbe(() => busy);
    passIdle();
    gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(60_000);
    expect(reload).not.toHaveBeenCalled();
    busy = false;
    vi.advanceTimersByTime(6_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("探针抛错按 busy 处理(保守)", () => {
    const { gov, reload } = make();
    gov.registerBusyProbe(() => { throw new Error("boom"); });
    passIdle();
    gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(60_000);
    expect(reload).not.toHaveBeenCalled();
  });

  it("距用户输入 <30s → 推迟;静默满 30s 后刷", () => {
    const { gov, reload } = make();
    passIdle();
    gov.noteUserActivity(); // 帧到达时用户正在打字
    gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(10_000);
    gov.noteUserActivity(); // 还在动
    vi.advanceTimersByTime(20_000);
    expect(reload).not.toHaveBeenCalled(); // 距上次输入仅 20s
    vi.advanceTimersByTime(15_000); // 静默满 30s
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("挂起超 5min(用户一直忙)→ 出横幅但不强刷;dismiss 后同目标不再弹", () => {
    const { gov, reload } = make();
    gov.registerBusyProbe(() => true);
    passIdle();
    gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(5 * 60_000 + 10_000);
    expect(reload).not.toHaveBeenCalled();
    expect(gov.getBannerVisible()).toBe(true);
    gov.dismissBanner();
    expect(gov.getBannerVisible()).toBe(false);
    vi.advanceTimersByTime(10 * 60_000);
    expect(gov.getBannerVisible()).toBe(false); // 同目标不再骚扰
  });
});

describe("横幅动作", () => {
  it("reloadNow:绕过安全点立即刷,且写 attempt 记账", () => {
    const { gov, reload, storage } = make();
    gov.registerBusyProbe(() => true); // 哪怕忙
    passIdle();
    gov.onServerBuild(SERVER);
    gov.reloadNow();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage!.getItem("oc-build-reload")!).target).toBe(SERVER);
  });

  it("subscribe:横幅可见性变化通知订阅者", () => {
    const { gov } = make({ storage: null });
    const seen: boolean[] = [];
    gov.subscribe(() => seen.push(gov.getBannerVisible()));
    passIdle();
    gov.onServerBuild(SERVER);
    expect(seen).toEqual([true]);
  });
});
