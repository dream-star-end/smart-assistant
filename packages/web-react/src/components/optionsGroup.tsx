/**
 * options 选择卡的**消息级聚合** —— 一条 assistant 消息里可能有多个 options 块
 * (引导式创建一轮问 2-3 题),作答单位必须是整条消息,不能点一题就把回复发出去
 * (boss 实测踩坑:点了第一题即发送,后两题没机会答)。
 *
 * 语义:
 *  - 消息里只有 1 个单选块 → 点击即发(保留最顺手的路径);
 *  - ≥2 个块 → 逐题点选只记录(单选可换选),Markdown 下方的 GroupFooter 显示
 *    「已答 x/y」,全部答完才能「发送选择」,聚合成一条回复一次发出;
 *  - 发送后整组锁定。
 *
 * 本模块刻意轻量(不进 MarkdownImpl 懒加载 chunk 也无妨):Message.tsx 每条
 * assistant 消息包一个 Provider(store 挂 useRef,随消息实例存活),RichBlocks 的
 * OptionsBlock 经 useOptionsGroup 注册/上报,Footer 用 useSyncExternalStore 订阅。
 */
import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useChatInteraction } from "./tool/context";

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
}

export interface OptionsGroupStore {
  register: (key: string, meta: { question?: string; multi: boolean }) => void;
  unregister: (key: string) => void;
  setAnswer: (key: string, labels: string[]) => void;
  markSent: () => void;
  getSnapshot: () => Snapshot;
  subscribe: (cb: () => void) => () => void;
}

export function createOptionsGroupStore(): OptionsGroupStore {
  const entries = new Map<string, OptionsGroupEntry>();
  let order = 0;
  let sent = false;
  let snapshot: Snapshot = { entries: [], sent: false, count: 0, answered: 0 };
  const listeners = new Set<() => void>();
  const emit = () => {
    const list = [...entries.values()].sort((a, b) => a.order - b.order);
    snapshot = {
      entries: list,
      sent,
      count: list.length,
      answered: list.filter((e) => e.labels.length > 0).length,
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
export function OptionsGroupProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<OptionsGroupStore | null>(null);
  if (!storeRef.current) storeRef.current = createOptionsGroupStore();
  return (
    <OptionsGroupContext.Provider value={storeRef.current}>{children}</OptionsGroupContext.Provider>
  );
}

/** 多题时的统一发送条(渲染在消息 Markdown 之后;<2 题 / 已发 / 不可交互时隐身)。 */
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
  if (!store || !snap || snap.count < 2 || !sendUserText) return null;
  if (snap.sent)
    return <p className="mt-1.5 text-[11.5px] text-faint">已发送全部选择。</p>;
  const ready = snap.answered === snap.count;
  return (
    <div className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-3.5 py-2.5">
      <span className="text-[12.5px] text-muted">
        已作答 <span className="font-medium text-fg">{snap.answered}</span> / {snap.count} 题
        {!ready && <span className="text-faint"> —— 每题点选后一次性发送</span>}
      </span>
      <button
        type="button"
        disabled={!ready || !!busy}
        onClick={() => {
          store.markSent();
          sendUserText(text);
        }}
        className="rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-white transition-opacity disabled:opacity-40"
      >
        发送选择
      </button>
    </div>
  );
}
