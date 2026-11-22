import { MODEL_SWITCH_CANCELLED_MESSAGE } from "../modelSwitch";
import type {
  OutboundModelSwitchPreparedWire,
  OutboundSessionCompactResultWire,
  SessionContextPressureWire,
  SysContextCompactedWire,
} from "./frames";
import type { ChatSession } from "./model";
import { safeSessionKeyForAgent } from "./pure";
import { applyContextCompacted, applyContextPressure } from "./reducer";

export interface SocketContextCompactHost {
  getSession: (sessId: string) => ChatSession | undefined;
  safeWsSend: (raw: string) => boolean;
  scheduleNotify: () => void;
  persistSession?: (sessId: string) => void;
}

/**
 * OCV5-840: 负责 ChatSocket 的上下文水位/压缩帧处理、手动 `control.session.compact` RPC
 * 及关联的 `prepare_model_switch` 压缩切换 RPC，避免 ChatSocket 主类继续膨胀。
 */
export class SocketContextCompactManager {
  private readonly abandonedModelSwitches = new Map<string, string>();
  private readonly pendingModelSwitches = new Map<
    string,
    {
      sessId: string;
      targetModel: string;
      resolve: (switchId: string) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly pendingCompacts = new Map<
    string,
    {
      sessId: string;
      sessionKey: string;
      resolve: (result: OutboundSessionCompactResultWire) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly host: SocketContextCompactHost) {}

  hasPendingModelSwitches(): boolean {
    return this.pendingModelSwitches.size > 0;
  }

  handleContextPressure(frame: SessionContextPressureWire): void {
    const sess = frame.peer?.id ? this.host.getSession(frame.peer.id) : undefined;
    if (sess && applyContextPressure(sess, frame)) this.host.scheduleNotify();
  }

  handleContextCompacted(frame: SysContextCompactedWire): void {
    const sessId = frame.peer?.id ?? frame.sessionId;
    const sess = sessId ? this.host.getSession(sessId) : undefined;
    if (!sess) return;
    const row = applyContextCompacted(sess, frame);
    if (row) this.host.persistSession?.(sess.id);
    this.host.scheduleNotify();
  }

  handleCompactResult(frame: OutboundSessionCompactResultWire): void {
    const pending = frame.requestId ? this.pendingCompacts.get(frame.requestId) : undefined;
    const sessId = pending?.sessId ?? frame.peer?.id ?? frame.sessionId;
    const sess = sessId ? this.host.getSession(sessId) : undefined;
    if (sess) {
      sess._compactingManual = false;
      this.host.scheduleNotify();
    }
    if (pending && frame.requestId) {
      this.pendingCompacts.delete(frame.requestId);
      clearTimeout(pending.timer);
      pending.resolve(frame);
    }
  }

  handleModelSwitchPrepared(frame: OutboundModelSwitchPreparedWire): void {
    const pending = this.pendingModelSwitches.get(frame.requestId);
    if (!pending || pending.sessId !== frame.sessionKey || pending.targetModel !== frame.targetModel) return;
    this.pendingModelSwitches.delete(frame.requestId);
    clearTimeout(pending.timer);
    if (frame.status === "completed") pending.resolve(frame.requestId);
    else pending.reject(new Error(frame.message || frame.errorCode || "上下文压缩失败"));
  }

  compactSession(sessId: string, instructions?: string): Promise<OutboundSessionCompactResultWire> {
    const sess = this.host.getSession(sessId);
    if (!sess) return Promise.reject(new Error("会话尚未建立，暂时无法压缩"));
    for (const pending of this.pendingCompacts.values()) {
      if (pending.sessId === sessId) {
        return Promise.reject(new Error("当前会话正在压缩上下文，请稍候"));
      }
    }
    const requestId = `compact:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
    const sessionKey = safeSessionKeyForAgent(sessId, sess.agentId);
    const trimmed = typeof instructions === "string" ? instructions.trim() : "";
    const payload = {
      type: "control.session.compact" as const,
      sessionKey,
      sessionId: sessId,
      requestId,
      ...(trimmed ? { instructions: trimmed } : {}),
    };
    if (!this.host.safeWsSend(JSON.stringify(payload))) {
      return Promise.reject(new Error("当前未连接，无法压缩上下文"));
    }
    sess._compactingManual = true;
    this.host.scheduleNotify();
    return new Promise<OutboundSessionCompactResultWire>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCompacts.delete(requestId);
        const cur = this.host.getSession(sessId);
        if (cur) {
          cur._compactingManual = false;
          this.host.scheduleNotify();
        }
        reject(new Error("上下文压缩超时，请稍后重试"));
      }, 5 * 60_000);
      this.pendingCompacts.set(requestId, { sessId, sessionKey, resolve, reject, timer });
    });
  }

  private cancelPreparedModelSwitch(requestId: string, sessionKey: string): void {
    const sent = this.host.safeWsSend(
      JSON.stringify({
        type: "control.session.cancel_model_switch",
        sessionKey,
        requestId,
      }),
    );
    if (sent) this.abandonedModelSwitches.delete(requestId);
    else this.abandonedModelSwitches.set(requestId, sessionKey);
  }

  flushAbandonedModelSwitches(): void {
    for (const [requestId, sessionKey] of this.abandonedModelSwitches) {
      this.cancelPreparedModelSwitch(requestId, sessionKey);
    }
  }

  cancelPendingModelSwitches(sessId: string): void {
    const sess = this.host.getSession(sessId);
    if (sess) {
      this.rejectPendingModelSwitches(
        MODEL_SWITCH_CANCELLED_MESSAGE,
        true,
        safeSessionKeyForAgent(sessId, sess.agentId),
      );
    }
  }

  rejectPendingModelSwitches(message: string, canSendCancellation: boolean, onlySessionKey?: string): void {
    for (const [id, pending] of [...this.pendingModelSwitches].filter(
      ([, p]) => !onlySessionKey || p.sessId === onlySessionKey,
    )) {
      clearTimeout(pending.timer);
      if (canSendCancellation) this.cancelPreparedModelSwitch(id, pending.sessId);
      else this.abandonedModelSwitches.set(id, pending.sessId);
      pending.reject(new Error(message));
      this.pendingModelSwitches.delete(id);
    }
  }

  prepareModelSwitch(sessId: string, sourceModel: string, targetModel: string): Promise<string> {
    const sess = this.host.getSession(sessId);
    if (!sess) return Promise.reject(new Error("会话不存在"));
    const requestId = `model-switch:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
    const sessionKey = safeSessionKeyForAgent(sessId, sess.agentId);
    if (
      !this.host.safeWsSend(
        JSON.stringify({
          type: "control.session.prepare_model_switch",
          sessionKey,
          requestId,
          sourceModel,
          targetModel,
        }),
      )
    ) {
      return Promise.reject(new Error("当前未连接，无法压缩上下文"));
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingModelSwitches.delete(requestId);
        this.cancelPreparedModelSwitch(requestId, sessionKey);
        reject(new Error("上下文压缩超时，仍保留原模型"));
      }, 16 * 60_000);
      this.pendingModelSwitches.set(requestId, {
        sessId: sessionKey,
        targetModel,
        resolve,
        reject,
        timer,
      });
    });
  }

  cancelCompactsForSession(sessId: string): void {
    for (const [id, pending] of [...this.pendingCompacts]) {
      if (pending.sessId !== sessId) continue;
      clearTimeout(pending.timer);
      this.pendingCompacts.delete(id);
      pending.reject(new Error("会话已关闭"));
    }
  }
}
