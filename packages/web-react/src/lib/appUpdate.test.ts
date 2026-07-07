/**
 * reload governor(appUpdate.ts)单测 —— 防无限刷新矩阵逐条锁死。
 * 核心不变量:一条 reload 谱系最多自动刷 MAX_AUTO_RELOADS(=2)次,即使 storage 被清、
 * 即使 build 在多值间漂移,也永不无限循环。改任何守卫前先看这组测试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppUpdateGovernor,
  readLineageFromUrl,
  setLineageInHash,
  type AppUpdateDeps,
} from "./appUpdate";

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

/**
 * URL 谱系计数器的可注入模拟。`box.n` 模拟 URL 里的 #ocr=N,**跨 governor 实例存活**
 * (= 跨 reload 存活),这正是它相对 storage 的关键优势;测试里"模拟 reload"= 用同一个
 * box 造新 governor。writable=false 模拟 history.replaceState 不可用。
 */
function urlLineage(box: { n: number }, writable = true) {
  return {
    readLineage: () => box.n,
    writeLineage: (n: number) => {
      if (!writable) return false;
      box.n = n > 0 ? n : 0;
      return true;
    },
  };
}

function make(over?: Partial<AppUpdateDeps> & { storage?: Storage | null; lineage?: { n: number } }) {
  const reload = vi.fn();
  const storage = over?.storage === undefined ? memStorage() : over.storage;
  const box = over?.lineage ?? { n: 0 };
  const gov = new AppUpdateGovernor({
    getClientBuild: () => CLIENT,
    reload,
    now: () => Date.now(),
    storage,
    ...urlLineage(box),
    ...over,
  });
  return { gov, reload, storage, box };
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
  it("不匹配 + 安全点 → 恰好一次 reload,谱系计数 +1", () => {
    const { gov, reload, box } = make();
    passIdle();
    gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(6_000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(box.n).toBe(1);
  });

  it("版本一致 → 完全 no-op", () => {
    const { gov, reload } = make();
    passIdle();
    gov.onServerBuild(CLIENT);
    vi.advanceTimersByTime(60_000);
    expect(reload).not.toHaveBeenCalled();
    expect(gov.getBannerVisible()).toBe(false);
  });

  it("S2:server id 形态非法 / client build 缺失(dev)→ 恒 inert", () => {
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

  it("构造时清空 URL 谱系标记(地址栏干净 + 成功更新后不残留)", () => {
    const box = { n: 0 };
    make({ lineage: box }); // 构造即 writeLineage(0)
    expect(box.n).toBe(0);
  });
});

describe("硬上限:谱系计数(Codex P0/P1 核心防线,失忆也生效)", () => {
  it("storage 每次 reload 都被清空,仍在 MAX 次后停止(ArkWeb 死循环场景)", () => {
    // 模拟 webview:每次 reload 后 sessionStorage/localStorage 全没,但 URL(box)存活。
    const box = { n: 0 };
    let reloads = 0;
    // 反复"reload":每次造新 governor + 全新空 storage,共享同一 URL box。
    for (let i = 0; i < 6; i++) {
      const { gov, reload } = make({ storage: memStorage(), lineage: box });
      passIdle();
      gov.onServerBuild(SERVER); // client 永远旧,server 永远新(reload 没拿到新 HTML)
      vi.advanceTimersByTime(6_000);
      if (reload.mock.calls.length > 0) reloads++;
      else {
        // 已停止自动刷 → 必须是横幅兜底,且不再前进
        expect(gov.getBannerVisible()).toBe(true);
      }
    }
    expect(reloads).toBe(2); // 恰好 MAX_AUTO_RELOADS 次,绝不无限
    expect(box.n).toBe(2);
  });

  it("build 在 B/C 间漂移 + storage 清空 → 仍被谱系封顶(P1)", () => {
    const box = { n: 0 };
    const targets = [SERVER, SERVER2, SERVER, SERVER2, SERVER];
    let reloads = 0;
    for (const t of targets) {
      const { gov, reload } = make({ storage: memStorage(), lineage: box });
      passIdle();
      gov.onServerBuild(t);
      vi.advanceTimersByTime(6_000);
      if (reload.mock.calls.length > 0) reloads++;
    }
    expect(reloads).toBe(2); // 目标漂移也无法突破封顶
  });

  it("谱系不可写(history 抛错)→ 一次都不自动刷,只横幅", () => {
    const { gov, reload } = make({ writeLineage: () => false, readLineage: () => 0 });
    passIdle();
    gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(120 * 60_000);
    expect(reload).not.toHaveBeenCalled();
    expect(gov.getBannerVisible()).toBe(true);
  });
});

describe("谱系只在成功时清零(自发 reload 不重开预算)", () => {
  it("到顶出横幅后 URL 计数器保留;自发 reload(新 governor 同 box)延续谱系不再自动刷", () => {
    const box = { n: 0 };
    // 两次自动刷到顶
    for (let i = 0; i < 2; i++) {
      const { gov } = make({ storage: memStorage(), lineage: box });
      passIdle();
      gov.onServerBuild(SERVER);
      vi.advanceTimersByTime(6_000);
    }
    expect(box.n).toBe(2);
    // page2 到顶:横幅,box 保持 2(不清零)
    const p2 = make({ storage: memStorage(), lineage: box });
    passIdle();
    p2.gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(6_000);
    expect(p2.reload).not.toHaveBeenCalled();
    expect(box.n).toBe(2); // 关键:mismatch 期间不清零
    // 用户按浏览器刷新键(又一次自发 reload)→ 新 page 读 box=2 → 仍不刷(预算未重开)
    const p3 = make({ storage: memStorage(), lineage: box });
    passIdle();
    p3.gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(60_000);
    expect(p3.reload).not.toHaveBeenCalled();
  });

  it("版本匹配(成功拿到新前端)→ 清零 URL 计数器,地址栏归位", () => {
    const box = { n: 2 };
    const { gov } = make({ lineage: box }); // 模拟 reload 后落地页,且这次 client 已是最新
    gov.onServerBuild(CLIENT); // server==client
    expect(box.n).toBe(0);
  });
});

describe("D1 目标记账(best-effort;storage 在时省无用刷新)", () => {
  it("同一目标顶到 MAX 后,新标签页(谱系归零但 storage 在)直接横幅、不再刷", () => {
    const storage = memStorage();
    // 第一条谱系:两次 reload 顶到 MAX(storage 全程存活)→ 第三页记下 maxedTargets。
    const box = { n: 0 };
    for (let i = 0; i < 3; i++) {
      const { gov } = make({ storage, lineage: box });
      passIdle();
      gov.onServerBuild(SERVER);
      vi.advanceTimersByTime(6_000);
    }
    // 新标签页:谱系从 0 开始,但共享 storage 已知 SERVER 刷了没用。
    const fresh = make({ storage, lineage: { n: 0 } });
    passIdle();
    fresh.gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(120 * 60_000);
    expect(fresh.reload).not.toHaveBeenCalled(); // 省掉无用刷新
    expect(fresh.gov.getBannerVisible()).toBe(true);
  });
});

describe("storage 完全不可用", () => {
  it("storage=null 但谱系可写 → 仍自动刷(封顶 MAX),不再是'永不刷'", () => {
    const box = { n: 0 };
    const { gov, reload } = make({ storage: null, lineage: box });
    passIdle();
    gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(6_000);
    expect(reload).toHaveBeenCalledTimes(1); // 谱系兜底,可安全放行
    expect(box.n).toBe(1);
  });
});

describe("S1 安全点", () => {
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
    gov.noteUserActivity();
    gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(10_000);
    gov.noteUserActivity();
    vi.advanceTimersByTime(20_000);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("挂起超 5min(一直忙)→ 出横幅但不强刷;dismiss 后同目标不再弹", () => {
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
    expect(gov.getBannerVisible()).toBe(false);
  });
});

describe("横幅动作", () => {
  it("reloadNow:绕过安全点立即刷,但不动谱系计数(手动刷人工限频,不消耗自动预算)", () => {
    const box = { n: 0 };
    const { gov, reload } = make({ lineage: box });
    gov.registerBusyProbe(() => true); // 哪怕忙
    passIdle();
    gov.onServerBuild(SERVER);
    gov.reloadNow();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(box.n).toBe(0); // 不写 #ocr:避免离线成功刷新后残留压低后续预算(Codex 二轮 P2)
  });

  it("reloadNow 保留 URL 里已有的谱系(到顶后手动刷不会重开自动预算)", () => {
    const box = { n: 2 }; // 已到顶
    const { gov, reload } = make({ lineage: box });
    passIdle();
    gov.onServerBuild(SERVER);
    gov.reloadNow();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(box.n).toBe(2); // 谱系原样保留 → 新页面读到 2 → 仍只横幅
  });

  it("reloadNow 后 reloaded 置位,重复调用不再刷(不循环)", () => {
    const { gov, reload } = make();
    passIdle();
    gov.onServerBuild(SERVER);
    gov.reloadNow();
    gov.reloadNow();
    gov.onServerBuild(SERVER2);
    vi.advanceTimersByTime(60_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("subscribe:横幅可见性变化通知订阅者", () => {
    const { gov } = make({ writeLineage: () => false });
    const seen: boolean[] = [];
    gov.subscribe(() => seen.push(gov.getBannerVisible()));
    passIdle();
    gov.onServerBuild(SERVER);
    expect(seen).toEqual([true]);
  });
});

describe("URL hash 谱系读写(纯函数,锁 P1 锚点保留 + P3 解析形态)", () => {
  it("readLineageFromUrl 各种 hash 形态", () => {
    expect(readLineageFromUrl("")).toBe(0);
    expect(readLineageFromUrl("#")).toBe(0);
    expect(readLineageFromUrl("#demo")).toBe(0);
    expect(readLineageFromUrl("#ocr=2")).toBe(2);
    expect(readLineageFromUrl("#demo&ocr=2")).toBe(2);
    expect(readLineageFromUrl("#ocr=2&bar")).toBe(2);
    expect(readLineageFromUrl("#ocrx=9")).toBe(0); // 不误匹配相似 key
    expect(readLineageFromUrl("#ocr=abc")).toBe(0);
  });

  it("setLineageInHash 保留非 ocr 锚点(修 Codex 二轮 P1:不吞 #demo/#agents)", () => {
    // 清零:锚点原样留存
    expect(setLineageInHash("#demo", 0)).toBe("demo");
    expect(setLineageInHash("#agents", 0)).toBe("agents");
    expect(setLineageInHash("", 0)).toBe("");
    // 设值:锚点 + ocr 段共存
    expect(setLineageInHash("#demo", 2)).toBe("demo&ocr=2");
    expect(setLineageInHash("", 1)).toBe("ocr=1");
    // 替换已有 ocr,不重复、不残留多余 &
    expect(setLineageInHash("#ocr=1", 2)).toBe("ocr=2");
    expect(setLineageInHash("#demo&ocr=1", 2)).toBe("demo&ocr=2");
    expect(setLineageInHash("#demo&ocr=1", 0)).toBe("demo");
    expect(setLineageInHash("#ocr=1&demo", 0)).toBe("demo");
  });
});

describe("WS 重连风暴", () => {
  it("同一 governor 反复 onServerBuild → 只刷一次,不堆定时器", () => {
    const { gov, reload } = make();
    passIdle();
    for (let i = 0; i < 20; i++) gov.onServerBuild(SERVER); // 每几分钟一次重连帧,压缩到瞬间
    vi.advanceTimersByTime(6_000);
    expect(reload).toHaveBeenCalledTimes(1);
    // reloaded 置位后再来帧也不动作
    for (let i = 0; i < 20; i++) gov.onServerBuild(SERVER);
    vi.advanceTimersByTime(60_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
