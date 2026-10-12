/**
 * Intelligent UI(OCV5-361)开关的前端状态。
 *
 * 权威在服务端:`user_preferences.prefs.intelligent_ui`(缺省 = 开)+ master 总开关
 * (`features.intelligent_ui.available`)。这里只是一份订阅式快照,由任何拿到
 * `/api/me/preferences` 响应的地方喂进来(App 启动水合、设置页读写)。
 * localStorage 记最后一次值,只为首屏不闪;读写都包 try/catch,拿不到就按默认开。
 *
 * 输入预测(OCV5-375)的开关也在这里:`prefs.input_prediction` + `features.input_prediction`,
 * 同一个响应带回来,同样缺省开。两者在 master 拼进同一个 prompt slot。
 */
import { useSyncExternalStore } from "react";

export const INTELLIGENT_UI_PREF_KEY = "intelligent_ui";
export const INPUT_PREDICTION_PREF_KEY = "input_prediction";
const STORAGE_KEY = "oc.intelligentUi.v1";

export type IntelligentUiState = {
  /** 用户偏好(缺省 true)。 */
  pref: boolean;
  /** 服务端总开关是否允许(缺省 true;旧服务端不返回该字段也视为允许)。 */
  available: boolean;
  /** 输入预测的用户偏好(缺省 true)。 */
  predict: boolean;
  /** 输入预测的服务端总开关(缺省 true)。 */
  predictAvailable: boolean;
};

const DEFAULT_STATE: IntelligentUiState = { pref: true, available: true, predict: true, predictAvailable: true };

function readStored(): IntelligentUiState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const v = JSON.parse(raw) as Partial<IntelligentUiState>;
    return {
      pref: v.pref !== false,
      available: v.available !== false,
      predict: v.predict !== false,
      predictAvailable: v.predictAvailable !== false,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

let state: IntelligentUiState = readStored();
const listeners = new Set<() => void>();

function set(next: IntelligentUiState) {
  if (
    next.pref === state.pref &&
    next.available === state.available &&
    next.predict === state.predict &&
    next.predictAvailable === state.predictAvailable
  )
    return;
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
  const features = obj.features as
    | { intelligent_ui?: { available?: unknown }; input_prediction?: { available?: unknown } }
    | undefined;
  set({
    pref: prefs[INTELLIGENT_UI_PREF_KEY] !== false,
    available: features?.intelligent_ui?.available !== false,
    predict: prefs[INPUT_PREDICTION_PREF_KEY] !== false,
    predictAvailable: features?.input_prediction?.available !== false,
  });
}

/** 设置页切换时先本地生效(乐观更新);服务端确认后由快照再校正一次。 */
export function setIntelligentUiPref(pref: boolean): void {
  set({ ...state, pref });
}

/** 输入预测开关,同样先本地生效。 */
export function setInputPredictionPref(predict: boolean): void {
  set({ ...state, predict });
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

/** 输入框用:输入预测开且服务端允许。 */
export function useInputPredictionEnabled(): boolean {
  return useSyncExternalStore(
    subscribeIntelligentUi,
    () => state.predict && state.predictAvailable,
    () => true,
  );
}

export function useIntelligentUiState(): IntelligentUiState {
  return useSyncExternalStore(subscribeIntelligentUi, getIntelligentUiState, getIntelligentUiState);
}

/** 测试用:重置为默认。 */
export function __resetIntelligentUiForTests(next: Partial<IntelligentUiState> = {}): void {
  state = { ...DEFAULT_STATE, ...next };
  for (const l of listeners) l();
}
