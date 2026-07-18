// WS turn 驱动(在册模式:参照 scripts/v5-smoke-turn-canary.mjs)。
// 用于协议级用例:resend-dedup(同 clientMessageId/idempotencyKey 重发)与需要精确
// 帧控制的场景。UI 可见断言仍走浏览器;此驱动只做 setup/协议校验。
//
// inbound.message 帧与前端 socket.ts 构造同构:
//   { type, idempotencyKey:"web:<cmid>:0", channel:"webchat", peer:{id,kind:"dm"},
//     content:{text}, model?, ts, clientMessageId:"m-..." }

import WebSocket from 'ws';
import { config } from './env';

export function mintClientMessageId(): string {
  return `m-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function idemKey(cmid: string, attempt = 0): string {
  return `web:${cmid}:${attempt}`;
}

export interface TurnEvent {
  raw: any;
  type: string;
}

export interface TurnResult {
  sawText: boolean;
  sawFinal: boolean;
  finalCount: number;
  costCount: number;
  errors: string[];
  texts: string[];
  events: TurnEvent[];
  endedBy: 'final' | 'silence' | 'error' | 'closed' | 'hardcap';
  cmid: string;
}

export interface DriveOpts {
  token: string;
  sessionId: string;
  text: string;
  clientMessageId?: string;
  model?: string;
  /** 发几次同帧(dedup 用):默认 1。>1 时用同一 cmid+idempotencyKey 连发。 */
  sendTimes?: number;
  /** 静默兜底 ms(仅兜底,判成靠 isFinal);默认取 config().turnTimeoutMs。 */
  silenceMs?: number;
  /** 硬上限 ms:无论如何到点收尾并 resolve(不 hang);默认 silenceMs*1.5。 */
  hardCapMs?: number;
}

/**
 * 驱动一个(或去重的)turn。收集所有 outbound 事件,resolve 出计数供断言。
 * 绝不 hang:isFinal / 静默 / error / 关闭 / 硬上限 任一到达即 resolve。
 */
export function driveTurn(opts: DriveOpts): Promise<TurnResult> {
  const cfg = config();
  const cmid = opts.clientMessageId ?? mintClientMessageId();
  const model = opts.model ?? cfg.model;
  const silenceMs = opts.silenceMs ?? cfg.turnTimeoutMs;
  const hardCapMs = opts.hardCapMs ?? Math.round(silenceMs * 1.5);
  const sendTimes = Math.max(1, opts.sendTimes ?? 1);

  const result: TurnResult = {
    sawText: false,
    sawFinal: false,
    finalCount: 0,
    costCount: 0,
    errors: [],
    texts: [],
    events: [],
    endedBy: 'closed',
    cmid,
  };

  return new Promise<TurnResult>((resolve) => {
    const ws = new WebSocket(`${cfg.wsBase}/ws/user-chat-bridge`, ['bearer', opts.token]);
    let silenceTimer: NodeJS.Timeout;
    let hardTimer: NodeJS.Timeout;
    let done = false;

    const finish = (endedBy: TurnResult['endedBy']) => {
      if (done) return;
      done = true;
      result.endedBy = endedBy;
      clearTimeout(silenceTimer);
      clearTimeout(hardTimer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const resetSilence = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => finish('silence'), silenceMs);
    };

    hardTimer = setTimeout(() => finish('hardcap'), hardCapMs);

    ws.on('open', () => {
      const frame = {
        type: 'inbound.message',
        idempotencyKey: idemKey(cmid, 0),
        channel: 'webchat',
        peer: { id: opts.sessionId, kind: 'dm' },
        content: { text: opts.text },
        model,
        ts: Date.now(),
        clientMessageId: cmid,
      };
      for (let i = 0; i < sendTimes; i++) ws.send(JSON.stringify(frame));
      resetSilence();
    });

    ws.on('message', (data) => {
      resetSilence();
      let f: any;
      try {
        f = JSON.parse(String(data));
      } catch {
        return;
      }
      result.events.push({ raw: f, type: f?.type ?? 'unknown' });
      if (f?.type === 'outbound.message') {
        for (const b of f.blocks ?? []) {
          if (b?.kind === 'text' && String(b.text ?? '').trim()) {
            result.sawText = true;
            result.texts.push(String(b.text));
          }
        }
        if (f.isFinal === true) {
          result.sawFinal = true;
          result.finalCount += 1;
        }
        if (f.error) result.errors.push(JSON.stringify(f.error).slice(0, 300));
      } else if (f?.type === 'outbound.cost_charged') {
        result.costCount += 1;
      } else if (f?.type === 'outbound.error' || f?.type === 'outbound.turn_error' || f?.type === 'error') {
        // 记录错误帧但**不立即收尾**:dedup 场景下第二帧会被服务端以 busy/duplicate 拒绝
        // (如 CODEX_TURN_BUSY),那是去重**生效**的证据,不该打断第一帧的真实 turn。
        // 继续等 final/silence,让真 turn 走完;是否算失败交调用方按 code 判定。
        result.errors.push(JSON.stringify(f).slice(0, 300));
      }
      // 收到 final 后再宽限一小段(等 cost_charged 广播),然后收尾。
      if (result.sawFinal) {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => finish('final'), 3000);
      }
    });

    ws.on('error', () => {
      result.errors.push('ws transport error');
      finish('error');
    });
    ws.on('close', () => finish('closed'));
  });
}
