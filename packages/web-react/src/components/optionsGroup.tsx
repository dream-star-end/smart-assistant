/**
 * options 选择卡的**消息级聚合** —— 一条 assistant 消息里可能有多个 options 块
 * (引导式创建一轮问 2-3 题),作答单位必须是整条消息,不能点一题就把回复发出去
 * (boss 实测踩坑:点了第一题即发送,后两题没机会答)。
 *
 * 语义:
 *  - 非流式且只有 1 个单选块 → 点击即发(保留最顺手的路径);
 *  - 流式(live)期间点选永远可点,但禁止任何隐式发送:即使目前只看到 1 块
 *    也只暂存,必须渲染页脚由用户显式点「发送选择」(长回合中途就会贴卡,
 *    后继 options 的 JSON 也可能还是半截);
 *  - ≥2 个块(流式或非流式)→ 逐题点选只记录(单选可换选),GroupFooter 显示
 *    「已作答 x/y」,至少答 1 题即可「发送选择」,未答的题标成「(未答)」,
 *    聚合成一条回复一次发出;流式期页脚发送按钮同样可用;
 *  - 流式期点选过但没发,流式结束后(哪怕只有 1 块)页脚**留着**,点选不丢、仍由用户显式发出;
 *  - 发送后整组锁定。
 *
 * 块的「注册」必须在 layout effect 里做(RichBlocks.OptionsBlock):passive effect 会在
 * commit 之后才跑,中间那帧里块已可点、分组却还没数到它,点选会误走「单块点击即发」。
 *
 * 本模块刻意轻量(不进 MarkdownImpl 懒加载 chunk 也无妨):Message.tsx 每条
 * assistant 消息包一个 Provider(store 挂 useRef,随消息实例存活),RichBlocks 的
 * OptionsBlock 经 useOptionsGroup 注册/上报,Footer 用 useSyncExternalStore 订阅。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useChatInteraction } from "./tool/context";
import { Button } from "./ui";

export interface OptionsGroupEntry {
  key: string;
  /** 注册顺序(文档顺序),聚合回复按它排序。 */
  order: number;
  question?: string;
  multi: boolean;
  labels: string[];
}

interface Snapshot {
  entries: OptionsGroupEntry[];
  sent: boolean;
  count: number;
  answered: number;
  /** 本条消息是否仍在流式生成。live 期间禁止隐式发送,页脚必须出现。 */
  live: boolean;
  /**
   * 本组是否处于「聚合作答」模式(点选只记录,由页脚显式发送):≥2 块、流式期、
   * 或**已有未发送的点选**。最后一条是为了流式期点选后流式结束(单块)不把页脚收掉
   * 让点选凭空消失 —— 用户在 live 期被禁止隐式发送,结束后仍应能显式发出。
   * OptionsBlock 与 Footer 都读这一个字段,避免两边各算一遍口径漂移。
   */
  grouped: boolean;
}

/** 与 Snapshot.grouped 同一口径的纯函数,便于单测与调用方推导。 */
export function isOptionsGrouped(count: number, live: boolean, answered: number): boolean {
  return count >= 2 || live || answered >= 1;
}

export interface OptionsGroupStore {
  register: (key: string, meta: { question?: string; multi: boolean }) => void;
  unregister: (key: string) => void;
  setAnswer: (key: string, labels: string[]) => void;
  setLive: (live: boolean) => void;
  markSent: () => void;
  getSnapshot: () => Snapshot;
  subscribe: (cb: () => void) => () => void;
}

export function createOptionsGroupStore(initialLive = false): OptionsGroupStore {
  const entries = new Map<string, OptionsGroupEntry>();
  let order = 0;
  let sent = false;
  let live = initialLive;
  let snapshot: Snapshot = {
    entries: [],
    sent: false,
    count: 0,
    answered: 0,
    live: initialLive,
    grouped: isOptionsGrouped(0, initialLive, 0),
  };
  const listeners = new Set<() => void>();
  const emit = () => {
    const list = [...entries.values()].sort((a, b) => a.order - b.order);
    const answered = list.filter((e) => e.labels.length > 0).length;
    snapshot = {
      entries: list,
      sent,
      count: list.length,
      answered,
      live,
      grouped: isOptionsGrouped(list.length, live, answered),
    };
    for (const cb of listeners) cb();
  };
  return {
    register(key, meta) {
      if (!entries.has(key)) {
        entries.set(key, { key, order: order++, question: meta.question, multi: meta.multi, labels: [] });
      } else {
        const e = entries.get(key);
        if (e) {
          e.question = meta.question;
          e.multi = meta.multi;
        }
      }
      emit();
    },
    unregister(key) {
      entries.delete(key);
      emit();
    },
    setAnswer(key, labels) {
      const e = entries.get(key);
      if (!e || sent) return;
      e.labels = labels;
      emit();
    },
    setLive(next) {
      if (live === next) return;
      live = next;
      emit();
    },
    markSent() {
      sent = true;
      emit();
    },
    getSnapshot: () => snapshot,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

const OptionsGroupContext = createContext<OptionsGroupStore | null>(null);

export function useOptionsGroup(): OptionsGroupStore | null {
  return useContext(OptionsGroupContext);
}

/** 订阅组快照(无 provider 时返回 null,调用方走单块独立行为)。 */
export function useOptionsGroupSnapshot(): Snapshot | null {
  const store = useContext(OptionsGroupContext);
  const subscribe = useCallback((cb: () => void) => store?.subscribe(cb) ?? (() => {}), [store]);
  const get = useCallback(
    () => store?.getSnapshot() ?? null,
    [store],
  );
  return useSyncExternalStore(subscribe, get, get);
}

/** 每条 assistant 消息一个 Provider;store 随消息组件实例存活(流式重渲不重置)。 */
export function OptionsGroupProvider({ children, live = false }: { children: ReactNode; live?: boolean }) {
  const storeRef = useRef<OptionsGroupStore | null>(null);
  if (!storeRef.current) storeRef.current = createOptionsGroupStore(live);
  useEffect(() => {
    storeRef.current?.setLive(live);
  }, [live]);
  return (
    <OptionsGroupContext.Provider value={storeRef.current}>{children}</OptionsGroupContext.Provider>
  );
}

/** 多题或流式单块时的统一发送条(渲染在消息 Markdown 之后;非流式单块 / 已发 / 不可交互时隐身)。 */
export function OptionsGroupFooter() {
  const store = useOptionsGroup();
  const snap = useOptionsGroupSnapshot();
  const { sendUserText, busy } = useChatInteraction();
  const text = useMemo(() => {
    if (!snap) return "";
    const lines = snap.entries.map(
      (e, i) => `${i + 1}. ${e.question ?? `第 ${i + 1} 题`}:${e.labels.join("、") || "(未答)"}`,
    );
    return `我的选择:\n${lines.join("\n")}`;
  }, [snap]);
  // 没有已解析的 options 块时不渲染空页脚(避免思考过程出现「已作答 0/0」)。
  // 流式期只要有 ≥1 块就必须出页脚(禁止点击即发);非流式 ≥2 块出页脚;
  // 单块流式结束后若还有未发送的点选,页脚留着让用户显式发出(见 Snapshot.grouped)。
  const showFooter = !!snap && snap.count >= 1 && snap.grouped;
  if (!store || !snap || !showFooter || !sendUserText) return null;
  if (snap.sent) {
    const missing = snap.count - snap.answered;
    return (
      <p className="mt-1.5 text-caption text-faint">
        {missing > 0 ? `已发送全部选择（${missing} 题未答，已一并标注）。` : "已发送全部选择。"}
      </p>
    );
  }
  const ready = snap.answered >= 1;
  const unanswered = snap.count - snap.answered;
  // 生产里 busy===sending===live;流式期忽略 busy,否则长回合发不出选择。
  const blockedByBusy = !!busy && !snap.live;
  const hint = !ready
    ? "每题点选后一次性发送"
    : blockedByBusy
      ? "等待当前回合结束后可发送"
      : unanswered > 0
        ? `未答的 ${unanswered} 题会标为「未答」一并发出`
        : null;
  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-xl border border-border bg-surface px-3.5 py-2.5">
      {/* 计数走 live region:读屏用户点选后能听到进度,而不是只看得见。 */}
      <output aria-live="polite" className="min-w-0 text-meta text-muted">
        已作答 <span className="font-medium text-fg">{snap.answered}</span> / {snap.count} 题
        {hint ? <span className="text-faint"> —— {hint}</span> : null}
      </output>
      <Button
        type="button"
        variant="accent"
        size="sm"
        disabled={!ready || blockedByBusy}
        title={blockedByBusy ? "等待当前回合结束后可发送" : undefined}
        onClick={() => {
          store.markSent();
          sendUserText(text);
        }}
      >
        发送选择
      </Button>
    </div>
  );
}
