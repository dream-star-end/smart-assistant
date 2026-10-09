/**
 * Intelligent UI(OCV5-361)开关的前端状态。
 *
 * 权威在服务端:`user_preferences.prefs.intelligent_ui`(缺省 = 开)+ master 总开关
 * (`features.intelligent_ui.available`)。这里只是一份订阅式快照,由任何拿到
 * `/api/me/preferences` 响应的地方喂进来(App 启动水合、设置页读写)。
 * localStorage 记最后一次值,只为首屏不闪;读写都包 try/catch,拿不到就按默认开。
 */
import { useSyncExternalStore } from "react";

export const INTELLIGENT_UI_PREF_KEY = "intelligent_ui";
const STORAGE_KEY = "oc.intelligentUi.v1";

export type IntelligentUiState = {
  /** 用户偏好(缺省 true)。 */
  pref: boolean;
  /** 服务端总开关是否允许(缺省 true;旧服务端不返回该字段也视为允许)。 */
  available: boolean;
};

function readStored(): IntelligentUiState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { pref: true, available: true };
    const v = JSON.parse(raw) as Partial<IntelligentUiState>;
    return { pref: v.pref !== false, available: v.available !== false };
  } catch {
    return { pref: true, available: true };
  }
}

let state: IntelligentUiState = readStored();
const listeners = new Set<() => void>();

function set(next: IntelligentUiState) {
  if (next.pref === state.pref && next.available === state.available) return;
  state = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式等:只影响首屏,忽略 */
  }
  for (const l of listeners) l();
}

/** 从 `/api/me/preferences` 的原始响应({prefs, features} 或平铺)更新状态。 */
export function applyIntelligentUiSnapshot(snap: unknown): void {
  if (!snap || typeof snap !== "object") return;
  const obj = snap as Record<string, unknown>;
  const prefs = (obj.prefs && typeof obj.prefs === "object" ? obj.prefs : obj) as Record<string, unknown>;
  const feature = (obj.features as { intelligent_ui?: { available?: unknown } } | undefined)?.intelligent_ui;
  set({
    pref: prefs[INTELLIGENT_UI_PREF_KEY] !== false,
    available: feature?.available !== false,
  });
}

/** 设置页切换时先本地生效(乐观更新);服务端确认后由快照再校正一次。 */
export function setIntelligentUiPref(pref: boolean): void {
  set({ ...state, pref });
}

export function getIntelligentUiState(): IntelligentUiState {
  return state;
}

export function subscribeIntelligentUi(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 渲染层用:开关开且服务端允许时才把 ```ui 渲染成组件。 */
export function useIntelligentUiEnabled(): boolean {
  return useSyncExternalStore(
    subscribeIntelligentUi,
    () => state.pref && state.available,
    () => true,
  );
}

export function useIntelligentUiState(): IntelligentUiState {
  return useSyncExternalStore(subscribeIntelligentUi, getIntelligentUiState, getIntelligentUiState);
}

/** 测试用:重置为默认。 */
export function __resetIntelligentUiForTests(next: IntelligentUiState = { pref: true, available: true }): void {
  state = next;
  for (const l of listeners) l();
}
