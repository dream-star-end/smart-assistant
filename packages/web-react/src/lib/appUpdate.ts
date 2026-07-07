/**
 * 前端版本握手 + 安全点软刷新(reload governor,唯一权威)。
 *
 * 背景:SPA 标签页(尤其移动端)可长驻数小时旧 bundle;dist 高频发版时,旧前端撞新
 * 服务端语义(2026-07-07 旧前端合成续写被 CODEX_BILLING_GUARD 拒的复发事故)。
 * bridge 在每个 WS accept 时下发 `{type:"sys.frontend_build", build}`(服务端读
 * dist/index.html 的 `<meta name="oc-build">`);本模块比对客户端 DOM 里的同一 meta,
 * 不一致时在安全点 location.reload() 拿新前端。
 *
 * ── 防无限刷新硬机制(缺一不可,动任何一条前先想清楚)────────────────────────
 *  G1 目标一次性:每个 server build 目标,本 tab 只允许一次自动 reload。attempt 记录
 *     写 sessionStorage(跨 reload 存活、tab 关闭即弃):reload 后若仍不匹配(中间层
 *     缓存了旧 index.html / 双端探测源漂移),第二帧命中 G1 → 永不再自动刷,只挂手动横幅。
 *  G2 全局冷却:距上次自动 reload(attempt.ts,不分目标)≥ 10min 才允许下一次。
 *     发版列车(一天 10+ 次 dist)下用户至多每 10min 被刷一次,中间版本自然跳过。
 *  G3 storage 不可用(Safari 隐私模式等)→ 永不自动 reload:G1 无法持久化,宁可
 *     只出横幅。写入后还会读回校验,读不回同样放弃自动刷。
 *  G4 安全点:所有 busy 探针为假(无在飞 turn、composer 无草稿/附件——由各归属方
 *     registerBusyProbe 注入,本模块不伸手进别人状态)且距最近用户输入 ≥ 30s。
 *     不安全每 5s 重估;挂起 >5min 出横幅(带「立即刷新」,可忽略)。
 *  G5 形态校验:双端 id 均为 8-32 hex 且不相等才动作。dev 构建无 meta → 恒 inert。
 *  时钟纪律:全部比较只用本地 now(),不掺服务器时间戳(B 类跨时钟域红线)。
 */

const BUILD_ID_RE = /^[0-9a-f]{8,32}$/;
const STORAGE_KEY = "oc-build-reload";
const RELOAD_COOLDOWN_MS = 10 * 60_000;
const INPUT_IDLE_MS = 30_000;
const RECHECK_MS = 5_000;
const BANNER_AFTER_PENDING_MS = 5 * 60_000;

type AttemptRecord = { target: string; ts: number };

export type AppUpdateDeps = {
  getClientBuild: () => string | null;
  reload: () => void;
  now: () => number;
  /** 已探活的 sessionStorage;null = 不可用(G3 → 永不自动刷)。 */
  storage: Storage | null;
};

export class AppUpdateGovernor {
  private deps: AppUpdateDeps;
  private busyProbes = new Set<() => boolean>();
  private listeners = new Set<() => void>();
  private pendingTarget: string | null = null;
  private pendingSince: number | null = null;
  private lastActivityAt: number;
  private bannerVisible = false;
  private bannerDismissedFor: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reloaded = false;

  constructor(deps: AppUpdateDeps) {
    this.deps = deps;
    // 初始视作"刚有输入":新加载的页面至少静默 IDLE 时长才可能被刷,
    // 防止用户刚打开页面就被脚下抽毯。
    this.lastActivityAt = deps.now();
  }

  /** busy 探针:返回 true = 现在不能刷(在飞 turn/草稿/上传中)。返回注销函数。 */
  registerBusyProbe(probe: () => boolean): () => void {
    this.busyProbes.add(probe);
    return () => this.busyProbes.delete(probe);
  }

  /** 用户输入活动(keydown/pointerdown/touchstart/回到前台)。 */
  noteUserActivity(): void {
    this.lastActivityAt = this.deps.now();
  }

  /** 服务端握手帧入口。非法/缺失一律 no-op(G5)。 */
  onServerBuild(raw: unknown): void {
    const server = typeof raw === "string" && BUILD_ID_RE.test(raw) ? raw : null;
    if (!server || this.reloaded) return;
    const client = this.deps.getClientBuild();
    if (!client || !BUILD_ID_RE.test(client)) return; // dev / meta 缺失 → inert
    if (server === client) {
      // 已是最新(典型:成功软刷后的下一帧)。attempt 记录**故意不清**:
      // G2 冷却依赖 attempt.ts 给"发版列车"限频,清了冷却就失效。
      this.pendingTarget = null;
      this.pendingSince = null;
      this.stopTimer();
      this.setBanner(false);
      return;
    }
    const attempt = this.readAttempt();
    if (attempt?.target === server) {
      // G1:该目标已自动刷过仍不匹配 → 永不再自动刷,横幅兜底。
      this.showBanner(server);
      return;
    }
    if (!this.deps.storage) {
      // G3:记录无处持久化 → 自动刷会失去 G1 保护,只出横幅。
      this.showBanner(server);
      return;
    }
    if (this.pendingTarget !== server) {
      this.pendingTarget = server;
      this.pendingSince ??= this.deps.now();
    }
    this.check();
  }

  /** 横幅「立即刷新」:用户主动,绕过安全点,但仍写 attempt(保住 G1/G2 记账)。 */
  reloadNow(): void {
    const target = this.pendingTarget ?? "manual";
    this.writeAttempt({ target, ts: this.deps.now() });
    this.reloaded = true;
    this.stopTimer();
    this.deps.reload();
  }

  dismissBanner(): void {
    this.bannerDismissedFor = this.pendingTarget ?? this.bannerDismissedFor ?? "unknown";
    this.setBanner(false);
  }

  // ── React useSyncExternalStore 接口 ──
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getBannerVisible = (): boolean => this.bannerVisible;

  // ── 内部 ──

  private check = (): void => {
    this.stopTimer();
    const target = this.pendingTarget;
    if (!target || this.reloaded) return;
    const now = this.deps.now();

    // G2 全局冷却
    const attempt = this.readAttempt();
    const sinceLastReload = attempt ? now - attempt.ts : Number.POSITIVE_INFINITY;
    if (sinceLastReload < RELOAD_COOLDOWN_MS) {
      this.maybePendingBanner(now, target);
      this.timer = setTimeout(this.check, Math.max(RELOAD_COOLDOWN_MS - sinceLastReload, RECHECK_MS));
      return;
    }

    // G4 安全点
    const busy = [...this.busyProbes].some((p) => {
      try { return p(); } catch { return true; } // 探针抛错按 busy 处理(保守)
    });
    if (busy || now - this.lastActivityAt < INPUT_IDLE_MS) {
      this.maybePendingBanner(now, target);
      this.timer = setTimeout(this.check, RECHECK_MS);
      return;
    }

    // 全绿 → 记账后刷。写入必须读回核验:核验失败视同 G3,放弃自动刷。
    this.writeAttempt({ target, ts: now });
    if (this.readAttempt()?.target !== target) {
      this.showBanner(target);
      return;
    }
    this.reloaded = true;
    this.deps.reload();
  };

  private maybePendingBanner(now: number, target: string): void {
    if (this.pendingSince !== null && now - this.pendingSince > BANNER_AFTER_PENDING_MS) {
      this.showBanner(target);
    }
  }

  private showBanner(target: string): void {
    if (this.bannerDismissedFor === target) return;
    this.setBanner(true);
  }

  private setBanner(visible: boolean): void {
    if (this.bannerVisible === visible) return;
    this.bannerVisible = visible;
    for (const fn of this.listeners) fn();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private readAttempt(): AttemptRecord | null {
    const s = this.deps.storage;
    if (!s) return null;
    try {
      const raw = s.getItem(STORAGE_KEY);
      if (!raw) return null;
      const j = JSON.parse(raw) as Partial<AttemptRecord>;
      if (typeof j.target === "string" && typeof j.ts === "number") {
        return { target: j.target, ts: j.ts };
      }
      s.removeItem(STORAGE_KEY); // 形态坏 → 当无记录并清掉
      return null;
    } catch {
      return null;
    }
  }

  private writeAttempt(rec: AttemptRecord): void {
    try {
      this.deps.storage?.setItem(STORAGE_KEY, JSON.stringify(rec));
    } catch {
      /* quota/隐私模式:writeAttempt 后的读回核验会兜住 */
    }
  }
}

// ── 生产单例(测试直接 new AppUpdateGovernor 注入假 deps,不走这里)──

function probeSessionStorage(): Storage | null {
  try {
    const s = window.sessionStorage;
    const k = `${STORAGE_KEY}::probe`;
    s.setItem(k, "1");
    if (s.getItem(k) !== "1") return null;
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

let clientBuildCache: string | null | undefined;
function readClientBuild(): string | null {
  if (clientBuildCache === undefined) {
    clientBuildCache =
      document.querySelector('meta[name="oc-build"]')?.getAttribute("content") ?? null;
  }
  return clientBuildCache;
}

export const appUpdate = new AppUpdateGovernor({
  getClientBuild: readClientBuild,
  reload: () => window.location.reload(),
  now: () => Date.now(),
  storage: typeof window === "undefined" ? null : probeSessionStorage(),
});

if (typeof window !== "undefined") {
  const activity = () => appUpdate.noteUserActivity();
  window.addEventListener("keydown", activity, { capture: true, passive: true });
  window.addEventListener("pointerdown", activity, { capture: true, passive: true });
  window.addEventListener("touchstart", activity, { capture: true, passive: true });
  // 回到前台按一次输入算:用户刚回来那一眼不许刷(后台静置时定时器照跑,
  // 真正的静默软刷大多发生在后台,对用户完全无感)。
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") activity();
  });
}
