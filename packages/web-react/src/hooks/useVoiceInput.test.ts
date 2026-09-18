import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useVoiceInput, VOICE_STAGE_TIMEOUT_MS } from "./useVoiceInput";

// C-11:stop 后进入「正在转写…」,服务端不回 polish/error 时状态永久卡在 transcribing,麦克风禁用到刷新。
// 这里用假 WebSocket / MediaRecorder 复现「不回包」,断言 15s 安全超时把状态收回 idle 并给出可读错误。

class FakeWebSocket {
  static OPEN = 1;
  static last: FakeWebSocket | null = null;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor() {
    FakeWebSocket.last = this;
  }
  send(data: unknown) {
    if (typeof data === "string") this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
  requestData() {}
}

const originals: Record<string, PropertyDescriptor | undefined> = {};

function install(name: string, target: object, value: unknown) {
  originals[name] = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  install("WebSocket", window, FakeWebSocket);
  install("MediaRecorder", window, FakeMediaRecorder);
  install("mediaDevices", navigator, {
    getUserMedia: async () => ({ getTracks: () => [] }),
  });
  FakeWebSocket.last = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const [name, target] of [
    ["WebSocket", window],
    ["MediaRecorder", window],
    ["mediaDevices", navigator],
  ] as const) {
    const desc = originals[name];
    if (desc) Object.defineProperty(target, name, desc);
    else delete (target as unknown as Record<string, unknown>)[name];
  }
});

describe("useVoiceInput 阶段安全超时(C-11)", () => {
  test("connecting 等不到 ready:15s 后回 idle 并提示连接超时", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useVoiceInput({ getToken: () => "tok", onText: vi.fn(), onError }),
    );
    expect(result.current.supported).toBe(true);
    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });
    expect(result.current.state).toBe("connecting");
    await act(async () => {
      vi.advanceTimersByTime(VOICE_STAGE_TIMEOUT_MS + 10);
    });
    expect(onError).toHaveBeenCalledWith("语音服务连接超时，请重试");
    expect(result.current.state).toBe("idle");
  });

  test("stop 后服务端不回 polish:15s 后回 idle 并提示识别超时,麦克风可再次使用", async () => {
    const onError = vi.fn();
    const onText = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ getToken: () => "tok", onText, onError }));
    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
      await Promise.resolve();
    });
    const ws = FakeWebSocket.last!;
    expect(ws).toBeTruthy();
    await act(async () => {
      ws.onopen?.();
      ws.onmessage?.({ data: JSON.stringify({ type: "ready" }) });
    });
    expect(result.current.state).toBe("recording");
    // 录音阶段不设超时:久录不会被误判超时。
    await act(async () => {
      vi.advanceTimersByTime(VOICE_STAGE_TIMEOUT_MS + 10);
    });
    expect(result.current.state).toBe("recording");
    expect(onError).not.toHaveBeenCalled();

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });
    expect(result.current.state).toBe("transcribing");
    await act(async () => {
      vi.advanceTimersByTime(VOICE_STAGE_TIMEOUT_MS + 10);
    });
    expect(onError).toHaveBeenCalledWith("语音识别超时，请重试");
    expect(onText).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
    // 超时后再点一次能重新开始(此前会永久禁用)。
    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });
    expect(result.current.state).toBe("connecting");
  });

  test("polish 按时到达则不触发超时", async () => {
    const onError = vi.fn();
    const onText = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ getToken: () => "tok", onText, onError }));
    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
      await Promise.resolve();
    });
    const ws = FakeWebSocket.last!;
    await act(async () => {
      ws.onopen?.();
      ws.onmessage?.({ data: JSON.stringify({ type: "ready" }) });
    });
    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });
    await act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: "polish", text: "你好" }) });
    });
    expect(onText).toHaveBeenCalledWith("你好");
    await act(async () => {
      vi.advanceTimersByTime(VOICE_STAGE_TIMEOUT_MS + 10);
    });
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
  });
});
