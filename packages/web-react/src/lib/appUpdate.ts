/**
 * 前端版本握手 + 安全点软刷新(reload governor,唯一权威)。
 *
 * 背景:SPA 标签页(尤其移动端内嵌 webview)可长驻数小时旧 bundle;dist 高频发版时,
 * 旧前端撞新服务端语义(2026-07-07 鸿蒙 ArkWeb 长驻旧 JS,合成续写被 CODEX_BILLING_GUARD
 * 拒的"无响应"复发)。bridge 每次 WS accept 下发 {type:"sys.frontend_build", build}
 * (服务端读 dist/index.html 的 <meta name="oc-build">);本模块比对客户端 DOM 的同一
 * meta,不一致时在安全点 location.reload() 拿新前端。
 *
 * ── 防无限刷新:硬上限不依赖任何存储(失忆也兜底)────────────────────────────
 * 核心不变量:**一条 reload 谱系最多自动刷 MAX_AUTO_RELOADS 次,之后只出手动横幅。**
 * 谱系计数器写在 URL hash(#ocr=N)里——URL 是 reload 的固有部分,任何能正常 reload
 * 的浏览器/webview 都保留它,即使 sessionStorage/localStorage 被清空也照样存活。
 * 这根治 Codex P0(ArkWeb reload 清 storage → 存储层守卫全废 → 死循环):
 *   page0(无标记,n=0)→ 自动刷写 #ocr=1 → page1 读到 1 → 仍不匹配 → 刷写 #ocr=2
 *   → page2 读到 2 ≥ MAX → 只出横幅,永不再自动刷。无论 storage 是否存活、build 如何
 *   在 B/C 间漂移(P1),自动刷都被这个计数器封顶。
 * 关键:计数器**只在版本匹配(成功拿到新前端)时才清零**;仍不匹配期间保留 #ocr=N,
 * 这样即便页面被自发 reload(浏览器刷新键 / webview 恢复重载),谱系是延续而非重置,
 * 预算不会被"刷新→到顶→清零→再获满预算"的乒乓重开(否则又是一类无限刷新)。
 * 若 URL 计数器不可写(history.replaceState 抛错,极罕见)→ 一次都不自动刷(只横幅)。
 *
 * ── 之上的最佳努力层(需 localStorage,失效仅降级不失安全)──────────────────
 *  D1 目标记账:某目标在本机曾把谱系顶到 MAX(刷了也没用)→ 记 localStorage;以后
 *     新标签页见同一目标直接横幅,省掉那 MAX 次无用刷新(多 tab/重开的观感风暴收敛)。
 *     storage 没了 → 退回纯谱系封顶(每条谱系仍 ≤ MAX 次)。
 * ── 安全点(与存储无关)────────────────────────────────────────────────────
 *  S1 无在飞 turn(_sendingInFlight 探针)+ 无草稿附件 + 距用户输入 ≥30s;不安全每 5s
 *     重估,挂起 >5min 出横幅;探针抛错按 busy(保守)。
 *  S2 形态校验:双端 id 均 8-32 hex 且不等才动作;dev 无 meta → 恒 inert。
 *  全程只用本地 now(),不掺服务器时间戳(跨时钟域红线)。
 *
 * 刻意不做 reload 冷却:谱系硬顶已限总次数(≤MAX),再加"两次刷之间等 10min"只会
 * 拖延真正需要的第二次刷新(快速修复版发布后用户被迫干等),弊大于利。
 */

const BUILD_ID_RE = /^[0-9a-f]{8,32}$/;
const STORAGE_KEY = "oc-build-reload";
const MAX_AUTO_RELOADS = 2; // 每条 reload 谱系的硬上限(URL 承载,失忆也生效)
const INPUT_IDLE_MS = 30_000;
const RECHECK_MS = 5_000;
const BANNER_AFTER_PENDING_MS = 5 * 60_000;

/** localStorage 里的最佳努力记账(D1);缺失一律降级,不影响谱系硬上限。 */
type PersistState = { maxedTargets?: string[] };

export type AppUpdateDeps = {
  getClientBuild: () => string | null;
  reload: () => void;
  now: () => number;
  /** 最佳努力持久化(生产=localStorage);null = 不可用,退化为纯谱系封顶。 */
  storage: Storage | null;
  /** 读当前 reload 谱系计数(生产=URL hash #ocr=N)。失忆兜底的核心。 */
  readLineage: () => number;
  /** 写 reload 谱系计数,返回是否**写入并读回成功**(生产=history.replaceState + 读回)。
   *  返回 false = 无法持久化谱系 → 一次都不自动刷(fail-safe)。 */
  writeLineage: (n: number) => boolean;
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
  /** 本页所处 reload 谱系的已刷次数(构造时从 URL 读一次,之后只增不减)。 */
  private reloadsSoFar: number;
  /** URL 谱系计数器是否可写(构造时非破坏性探活);false → 永不自动刷。 */
  private lineageWritable: boolean;

  constructor(deps: AppUpdateDeps) {
    this.deps = deps;
    // 页面加载即视作"刚有输入":新页面至少静默 INPUT_IDLE_MS 才可能被刷,防止用户
    // 刚打开就被脚下抽毯。
    this.lastActivityAt = deps.now();
    this.reloadsSoFar = clampCount(deps.readLineage());
    // 非破坏性写回同一值作为"谱系可写"探针(不改计数,只验证 history 可写 + 读回一致)。
    // 抛错/读不回 → lineageWritable=false → 下面一次都不自动刷。
    this.lineageWritable = deps.writeLineage(this.reloadsSoFar);
  }

  registerBusyProbe(probe: () => boolean): () => void {
    this.busyProbes.add(probe);
    return () => this.busyProbes.delete(probe);
  }

  noteUserActivity(): void {
    this.lastActivityAt = this.deps.now();
  }

  /** 服务端握手帧入口。非法/缺失一律 no-op(S2)。 */
  onServerBuild(raw: unknown): void {
    const server = typeof raw === "string" && BUILD_ID_RE.test(raw) ? raw : null;
    if (!server || this.reloaded) return;
    const client = this.deps.getClientBuild();
    if (!client || !BUILD_ID_RE.test(client)) return; // dev / meta 缺失 → inert
    if (server === client) {
      // 已是最新(典型:成功软刷后的下一帧)。清空 pending + 清 URL 谱系标记(谱系完成,
      // 地址栏归位;此后自发 reload 从 0 重新计,因为已经是对的版本了)。
      this.pendingTarget = null;
      this.pendingSince = null;
      this.stopTimer();
      this.setBanner(false);
      if (this.reloadsSoFar > 0) {
        this.deps.writeLineage(0);
        this.reloadsSoFar = 0;
      }
      return;
    }
    // D1:本机曾对该目标刷到 MAX 仍没用 → 直接横幅,省无用刷新(best-effort)。
    if (this.readPersist().maxedTargets?.includes(server)) {
      this.showBanner(server);
      return;
    }
    if (this.pendingTarget !== server) {
      this.pendingTarget = server;
      this.pendingSince ??= this.deps.now();
    }
    this.check();
  }

  /** 横幅「立即刷新」:用户主动,绕过安全点,**不动谱系计数**。手动刷是人工限频(点一次
   *  =一次,非循环),不该消耗自动 reload 预算;URL 里已有的 #ocr 原样保留 → 若这次刷新
   *  仍拿回旧 HTML,新页面延续既有谱系(到顶仍只横幅,不会因手动刷重开自动预算)。
   *  也避免了"手动成功刷新后没收到握手帧 → #ocr 残留压低后续预算"(Codex 二轮 P2)。 */
  reloadNow(): void {
    if (this.reloaded) return;
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

    // 硬上限(失忆也生效):本谱系已刷够 MAX → 记账 + 横幅,永不再自动刷。
    if (this.reloadsSoFar >= MAX_AUTO_RELOADS) {
      this.markTargetMaxed(target);
      this.showBanner(target);
      return;
    }
    // 谱系不可写 → 无法保证封顶 → 一次都不自动刷(fail-safe)。
    if (!this.lineageWritable) {
      this.showBanner(target);
      return;
    }

    // S1 安全点
    const busy = [...this.busyProbes].some((p) => {
      try { return p(); } catch { return true; } // 探针抛错按 busy(保守)
    });
    if (busy || now - this.lastActivityAt < INPUT_IDLE_MS) {
      this.maybePendingBanner(now, target);
      this.timer = setTimeout(this.check, RECHECK_MS);
      return;
    }

    // 全绿 → 推进谱系计数(reload 前再确认一次可写),然后刷。
    if (!this.deps.writeLineage(this.reloadsSoFar + 1)) {
      this.showBanner(target); // 此刻写不进 → 不冒险
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

  private markTargetMaxed(target: string): void {
    const s = this.readPersist();
    const set = new Set(s.maxedTargets ?? []);
    if (set.has(target)) return;
    set.add(target);
    this.writePersist({ maxedTargets: [...set].slice(-8) }); // 只留最近若干,防无限增长
  }

  private readPersist(): PersistState {
    const s = this.deps.storage;
    if (!s) return {};
    try {
      const raw = s.getItem(STORAGE_KEY);
      if (!raw) return {};
      const j = JSON.parse(raw) as PersistState;
      return j && typeof j === "object" ? j : {};
    } catch {
      return {};
    }
  }

  private writePersist(patch: PersistState): void {
    const s = this.deps.storage;
    if (!s) return;
    try {
      s.setItem(STORAGE_KEY, JSON.stringify({ ...this.readPersist(), ...patch }));
    } catch {
      /* quota/隐私模式:best-effort,谱系硬上限仍兜底 */
    }
  }
}

function clampCount(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 99) : 0;
}

// ── 生产单例(测试直接 new AppUpdateGovernor 注入假 deps,不走这里)──

const LINEAGE_RE = /(?:^|[#&])ocr=(\d{1,3})(?:&|$)/;

/** 读 reload 谱系计数:URL hash 里的 ocr=N 段。URL 是 reload 的固有部分,storage 被清也存活。
 *  导出仅供单测(锁定各种 hash 形态的解析);运行时经 deps 注入。 */
export function readLineageFromUrl(hash: string): number {
  try {
    const m = LINEAGE_RE.exec(hash);
    return m ? clampCount(parseInt(m[1], 10)) : 0;
  } catch {
    return 0;
  }
}

/**
 * 把 hash 里的 ocr=N 段设为 n(n<=0 则移除),**保留其余 hash 内容**(如 Landing 的
 * `#demo`/`#agents` 锚点——它们不是 ocr 段,必须原样留存,否则会破坏深链)。返回新 hash
 * (不含前导 #,空则空串)。纯函数,导出供单测直测。
 */
export function setLineageInHash(hash: string, n: number): string {
  let h = hash.replace(/^#/, "");
  // 去掉已有 ocr 段并清理多余 & 分隔符
  h = h
    .replace(/(?:^|&)ocr=\d+/g, "")
    .replace(/&{2,}/g, "&")
    .replace(/^&|&$/g, "");
  if (n > 0) h = h ? `${h}&ocr=${clampCount(n)}` : `ocr=${clampCount(n)}`;
  return h;
}

/**
 * 写 reload 谱系计数到 URL hash,返回是否写入并读回成功。保留非 ocr 的 hash 锚点。
 * history.replaceState 不压历史栈;抛错 → false(→ 永不自动刷)。
 */
function writeLineageToUrl(n: number): boolean {
  try {
    const loc = window.location;
    const newHash = setLineageInHash(loc.hash, n);
    const url = loc.pathname + loc.search + (newHash ? `#${newHash}` : "");
    window.history.replaceState(window.history.state, "", url);
    return readLineageFromUrl(window.location.hash) === (n > 0 ? clampCount(n) : 0);
  } catch {
    return false;
  }
}

function probeLocalStorage(): Storage | null {
  try {
    const s = window.localStorage;
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
  storage: typeof window === "undefined" ? null : probeLocalStorage(),
  readLineage: () => (typeof window === "undefined" ? 0 : readLineageFromUrl(window.location.hash)),
  writeLineage: writeLineageToUrl,
});

if (typeof window !== "undefined") {
  const activity = () => appUpdate.noteUserActivity();
  window.addEventListener("keydown", activity, { capture: true, passive: true });
  window.addEventListener("pointerdown", activity, { capture: true, passive: true });
  window.addEventListener("touchstart", activity, { capture: true, passive: true });
  // 回到前台按一次输入算:用户刚回来那一眼不许刷(后台静置时定时器照跑,真正的静默
  // 软刷大多发生在后台,对用户无感)。
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") activity();
  });
}
