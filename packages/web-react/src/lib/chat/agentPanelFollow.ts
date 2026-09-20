/**
 * 「Agent 电脑」面板的跟随 / 固定 / 步骤状态机（PRD_MANUS_A F1.1 / F1.3，DESIGN §6）。
 *
 * 纯函数：输入消息数组与用户动作，输出面板该看哪一条顶层工具。不持消息对象引用，
 * 只持**下标**（tool 行 id 在 live 与耐久 tape 间不稳定，SURVEY B7）；ChatSocket 就地
 * mutate 消息对象，宿主每次 render 重新 `sync` 一次，O(当前 turn 长度)。
 *
 * 三态：
 *   hidden  本 turn 无顶层 tool / 用户关过 / 外部禁用（看板占据 main、窄屏走 chip）
 *   follow  目标 = 最近一条运行中的顶层工具；无运行中则最后一条已结束（新工具到达即切）
 *   pinned  用户显式选了某一步（点卡 / 步进 / chip / 产物预览）；不再自动切换，可「回到最新」
 */
import type { ToolLike } from "../../components/tool/format";
import { currentTurnStartIndex } from "../../components/chat/turnSegment";
import type { ChatMessage } from "./model";

export type AgentPanelMode = "hidden" | "follow" | "pinned";

export type AgentPanelState = {
  mode: AgentPanelMode;
  /** 目标在 messages 里的下标；-1 = 无目标或 externalTarget。 */
  targetIndex: number;
  /** pinMessage 传入但不在顶层 tool 行里的对象（agent-group 子块工具）。 */
  externalTarget: ToolLike | null;
  /** 上次 sync 时的当前 turn 起点（新 user 消息 → 变化）。 */
  turnStart: number;
  /** 用户在哪个 turn 关过面板；同 turn 内不再自动打开。 */
  closedTurnStart: number | null;
  /** 用户主动打开 / 换目标的计数：宿主据此决定是否移焦。自动打开 / 自动跟随不变。 */
  openNonce: number;
  /** follow 模式下目标切换计数：宿主据此写 aria-live（同一目标不重复播报）。 */
  followNonce: number;
};

export type AgentPanelAction =
  | { type: "sync"; messages: ChatMessage[] }
  | { type: "pin"; index: number }
  | { type: "pinMessage"; message: ToolLike; messages: ChatMessage[] }
  | { type: "step"; delta: 1 | -1; messages: ChatMessage[] }
  | { type: "follow"; messages: ChatMessage[] }
  | { type: "close" }
  | { type: "reset" };

export function initialAgentPanelState(): AgentPanelState {
  return {
    mode: "hidden",
    targetIndex: -1,
    externalTarget: null,
    turnStart: 0,
    closedTurnStart: null,
    openNonce: 0,
    followNonce: 0,
  };
}

/** 当前 turn 内的顶层 tool 行下标（agent-group 子块工具不是独立行，天然不计）。 */
export function topLevelToolIndices(messages: ChatMessage[], turnStart: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, turnStart); i < messages.length; i++) {
    if (messages[i]?.role === "tool") out.push(i);
  }
  return out;
}

/**
 * 运行中判定（纯函数版，与 tool/status.ts resolveToolStatus 的 isRunning 口径一致的子集）：
 * 未完成、无错误、且不是历史 tape 里被中断的行。
 */
export function isRunningTool(m: ToolLike | ChatMessage | undefined): boolean {
  if (!m) return false;
  if (m._completed) return false;
  if (m.error) return false;
  if ((m as ToolLike).cancelled) return false;
  if (m._timelineRecord === true && m._dispatchOutcome === "interrupted") return false;
  return true;
}

/** 跟随模式的目标：最近一条运行中的顶层工具；没有则最后一条；没有工具 → -1。 */
export function autoTargetIndex(messages: ChatMessage[], turnStart: number): number {
  const indices = topLevelToolIndices(messages, turnStart);
  for (let i = indices.length - 1; i >= 0; i--) {
    if (isRunningTool(messages[indices[i]])) return indices[i];
  }
  return indices.length > 0 ? indices[indices.length - 1] : -1;
}

export type StepInfo = { k: number; n: number; indices: number[] };

/** k/n：n = 目标所属 turn 的顶层 tool 数；k = 目标的 1 基序号（externalTarget → 0）。 */
export function stepInfo(state: AgentPanelState, messages: ChatMessage[]): StepInfo {
  const indices = topLevelToolIndices(messages, state.turnStart);
  const k = state.targetIndex >= 0 ? indices.indexOf(state.targetIndex) + 1 : 0;
  return { k, n: indices.length, indices };
}

/** 同一状态不造新对象：宿主每次 render 都 sync 一次，靠引用相等让 useReducer 直接 bail out。 */
function followState(state: AgentPanelState, messages: ChatMessage[], turnStart: number): AgentPanelState {
  const target = autoTargetIndex(messages, turnStart);
  if (target < 0) {
    if (state.mode === "hidden" && state.turnStart === turnStart && state.targetIndex === -1 && !state.externalTarget) {
      return state;
    }
    return { ...state, mode: "hidden", targetIndex: -1, externalTarget: null, turnStart };
  }
  const changed = state.mode !== "follow" || state.targetIndex !== target;
  if (!changed && state.turnStart === turnStart && !state.externalTarget) return state;
  return {
    ...state,
    mode: "follow",
    targetIndex: target,
    externalTarget: null,
    turnStart,
    followNonce: changed ? state.followNonce + 1 : state.followNonce,
  };
}

export function agentPanelReduce(state: AgentPanelState, action: AgentPanelAction): AgentPanelState {
  switch (action.type) {
    case "reset":
      return initialAgentPanelState();

    case "sync": {
      const { messages } = action;
      const turnStart = currentTurnStartIndex(messages);
      const newTurn = turnStart !== state.turnStart;
      if (newTurn) {
        // 新 user 消息开启新 turn：清「已关闭」标记，目标序列换到新 turn，回到跟随。
        return followState({ ...state, closedTurnStart: null }, messages, turnStart);
      }
      if (state.mode === "pinned") {
        // 固定：目标被删（消息数组被替换/裁剪）才兜底回跟随。
        if (state.externalTarget || messages[state.targetIndex]?.role === "tool") return state;
        return followState(state, messages, turnStart);
      }
      if (state.mode === "follow") return followState(state, messages, turnStart);
      // hidden：本 turn 被用户关过就不再自动打开；否则有顶层 tool 即打开为 follow。
      if (state.closedTurnStart === turnStart) return state.turnStart === turnStart ? state : { ...state, turnStart };
      return followState(state, messages, turnStart);
    }

    case "pin":
      if (action.index < 0) return state;
      return {
        ...state,
        mode: "pinned",
        targetIndex: action.index,
        externalTarget: null,
        openNonce: state.openNonce + 1,
      };

    case "pinMessage": {
      const idx = action.messages.indexOf(action.message as ChatMessage);
      if (idx >= 0 && action.messages[idx]?.role === "tool") {
        return { ...state, mode: "pinned", targetIndex: idx, externalTarget: null, openNonce: state.openNonce + 1 };
      }
      return { ...state, mode: "pinned", targetIndex: -1, externalTarget: action.message, openNonce: state.openNonce + 1 };
    }

    case "step": {
      const { indices, k } = stepInfo(state, action.messages);
      if (indices.length === 0 || k === 0) return state;
      const next = Math.min(indices.length, Math.max(1, k + action.delta));
      if (next === k) return state;
      return { ...state, mode: "pinned", targetIndex: indices[next - 1], externalTarget: null };
    }

    case "follow":
      return followState(state, action.messages, state.turnStart);

    case "close":
      return {
        ...state,
        mode: "hidden",
        targetIndex: -1,
        externalTarget: null,
        closedTurnStart: state.turnStart,
      };

    default:
      return state;
  }
}

/** 当前目标消息对象（externalTarget 优先）。 */
export function currentTarget(state: AgentPanelState, messages: ChatMessage[]): ToolLike | null {
  if (state.mode === "hidden") return null;
  if (state.externalTarget) return state.externalTarget;
  const m = state.targetIndex >= 0 ? messages[state.targetIndex] : undefined;
  return m && m.role === "tool" ? (m as ToolLike) : null;
}
