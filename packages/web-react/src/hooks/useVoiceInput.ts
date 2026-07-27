/**
 * 语音输入（STT）—— v3 parity：浏览器 MediaRecorder → WS /ws/voice-transcribe
 * → Deepgram Nova-3 转写 → DeepSeek 上下文润色。Deepgram key 不出服务端。
 *
 * 简化 UX（相对现网 speech.js 的按住-说话手势）：点击麦克风开始录音，再次点击停止
 * → 转写 → 把润色后的文本通过 onText 回填输入框。不支持/未配置时 supported=false。
 *
 * 协议（与 speech.js / gateway 一致）：
 *   open → send {type:'start', mimeType, context, keyterms}
 *   server {type:'ready'} → 启 MediaRecorder(150ms 切片)，每片 ws.send(ArrayBuffer)
 *   stop  → recorder.stop() → 冲刷最后一片后 send {type:'stop'}
 *   server {type:'transcript'}(中间) / {type:'polish', text}(最终) / {type:'error'}
 */
import { isKnownTurnErrorCode } from "@openclaude/protocol/turnErrorTaxonomy";
import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyBridgeErrorMessage, normalizeBridgeErrorCode } from "../lib/chat/pure";

export type VoiceState = "idle" | "connecting" | "recording" | "transcribing";

/**
 * STT 错误文案(任务⑤):`msg.code` 经 normalizeBridgeErrorCode(薄包装 protocol
 * normalizeTurnErrorCode)查 taxonomy —— 已知码走按码文案(voice_upstream_error →
 * 「语音识别服务暂时不可用，请重试」/voice_timeout →「语音识别超时，请重试」,均来自单一权威
 * BRIDGE_ERROR_MESSAGES),未知码用语音专属通用兜底。**不再直接展示服务端 message**:
 * friendlyBridgeErrorMessage 仅对 allowPublicServerMessage 白名单码透传 message,voice_* 不在
 * 白名单内 → 服务端裸串不会外泄给用户。
 */
function voiceErrorMessage(code: unknown, message: unknown): string {
  const n = normalizeBridgeErrorCode(code);
  if (isKnownTurnErrorCode(n)) {
    return friendlyBridgeErrorMessage(code, typeof message === "string" ? message : undefined);
  }
  return "语音识别失败，请重试";
}

function chooseMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  if (typeof window === "undefined" || !window.MediaRecorder) return "";
  for (const t of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* ignore */
    }
  }
  return "";
}

type Run = {
  ws: WebSocket | null;
  recorder: MediaRecorder | null;
  stream: MediaStream | null;
  chain: Promise<unknown>;
  stopSent: boolean;
  finished: boolean;
  alive: boolean;
};

export function useVoiceInput({
  getToken,
  onText,
  onError,
}: {
  /** 返回当前 access token（demo/未登录省略 → 麦克风禁用）。 */
  getToken?: () => string | null;
  /** 转写润色完成的文本回填。 */
  onText: (text: string) => void;
  onError?: (msg: string) => void;
}) {
  const supported =
    typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window.MediaRecorder !== "undefined" &&
    typeof window.WebSocket !== "undefined" &&
    chooseMimeType() !== "";
  const [state, setState] = useState<VoiceState>("idle");
  const ref = useRef<Run | null>(null);

  const cleanup = useCallback(() => {
    const r = ref.current;
    if (!r) return;
    r.alive = false;
    r.finished = true;
    try {
      if (r.recorder && r.recorder.state === "recording") r.recorder.stop();
    } catch {
      /* ignore */
    }
    try {
      r.stream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    try {
      r.ws?.close();
    } catch {
      /* ignore */
    }
    ref.current = null;
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const fail = useCallback(
    (msg: string) => {
      onError?.(msg);
      cleanup();
      setState("idle");
    },
    [onError, cleanup],
  );

  const start = useCallback(async () => {
    if (!supported || !getToken) return;
    const token = getToken();
    if (!token) {
      onError?.("请先登录后再使用语音输入");
      return;
    }
    const mimeType = chooseMimeType();
    cleanup();
    const r: Run = {
      ws: null,
      recorder: null,
      stream: null,
      chain: Promise.resolve(),
      stopSent: false,
      finished: false,
      alive: true,
    };
    ref.current = r;
    setState("connecting");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      fail("无法访问麦克风，请检查浏览器权限");
      return;
    }
    if (!r.alive) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    r.stream = stream;

    const url = `${location.protocol === "https:" ? "wss://" : "ws://"}${location.host}/ws/voice-transcribe`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, ["bearer", token]);
    } catch {
      fail("语音连接失败");
      return;
    }
    r.ws = ws;

    ws.onopen = () => {
      if (!r.alive || r.ws !== ws) return;
      try {
        ws.send(JSON.stringify({ type: "start", mimeType, context: [], keyterms: [] }));
      } catch {
        /* ignore */
      }
    };

    ws.onmessage = (ev) => {
      let msg: { type?: string; text?: string; rawText?: string; message?: string; code?: string };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (!r.alive || r.ws !== ws) return;
      if (msg.type === "ready") {
        let rec: MediaRecorder;
        try {
          rec = new MediaRecorder(stream, { mimeType });
        } catch {
          fail("录音启动失败");
          return;
        }
        r.recorder = rec;
        rec.ondataavailable = (e) => {
          if (!e.data || e.data.size <= 0) return;
          r.chain = r.chain
            .then(async () => {
              const buf = await e.data.arrayBuffer();
              if (r.ws?.readyState === WebSocket.OPEN && !r.stopSent) r.ws.send(buf);
            })
            .catch(() => {});
        };
        rec.onstop = () => {
          void r.chain.then(() => {
            if (r.alive && r.ws?.readyState === WebSocket.OPEN && !r.stopSent) {
              r.stopSent = true;
              try {
                r.ws.send(JSON.stringify({ type: "stop" }));
              } catch {
                /* ignore */
              }
            }
          });
        };
        try {
          rec.start(150);
          setState("recording");
        } catch {
          fail("录音启动失败");
        }
      } else if (msg.type === "stopping" || msg.type === "polish_start") {
        setState("transcribing");
      } else if (msg.type === "polish") {
        const text = (msg.text || msg.rawText || "").trim();
        r.finished = true;
        if (text) onText(text);
        else onError?.("未识别到有效语音");
        cleanup();
        setState("idle");
      } else if (msg.type === "error") {
        fail(voiceErrorMessage(msg.code, msg.message));
      }
    };

    ws.onerror = () => {
      if (r.alive && !r.finished) fail("语音连接失败");
    };
    ws.onclose = () => {
      if (r.alive && !r.finished) {
        cleanup();
        setState("idle");
      }
    };
  }, [supported, getToken, onText, onError, cleanup, fail]);

  const stop = useCallback(() => {
    const r = ref.current;
    if (!r) {
      setState("idle");
      return;
    }
    setState("transcribing");
    const rec = r.recorder;
    if (rec && rec.state === "recording") {
      try {
        rec.requestData?.();
      } catch {
        /* ignore */
      }
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    } else if (r.ws?.readyState === WebSocket.OPEN && !r.stopSent) {
      // 还没拿到 ready / 没起录音 —— 直接发 stop（多半会拿到空转写）。
      r.stopSent = true;
      try {
        r.ws.send(JSON.stringify({ type: "stop" }));
      } catch {
        /* ignore */
      }
    } else {
      cleanup();
      setState("idle");
    }
    try {
      r.stream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
  }, [cleanup]);

  const toggle = useCallback(() => {
    if (state === "idle") void start();
    else if (state === "recording") stop();
    else if (state === "connecting") {
      // 连接中再次点击 → 取消
      cleanup();
      setState("idle");
    }
    // transcribing：等结果，忽略点击
  }, [state, start, stop, cleanup]);

  return { supported, state, toggle };
}
