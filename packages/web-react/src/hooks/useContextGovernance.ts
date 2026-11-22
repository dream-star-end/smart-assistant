import { useCallback, useEffect, useMemo, useState } from "react";
import type { ToastFn } from "../components/ui/Toast";
import type { ChatMessage } from "../lib/chat/model";
import { useInputPredictionEnabled } from "../lib/intelligentUi";
import type { UseChatSocket } from "./useChatSocket";

type PredictInput = typeof import("../lib/inputPrediction").predictInput;

/**
 * OCV5-840: 会话上下文健康浮层开关 + 手动压缩控制器（抽离自 App.tsx，保持首屏体积与行预算可控）。
 */
export function useContextCompactAction({
  demo,
  activeId,
  wsSending,
  chat,
  toast,
}: {
  demo: boolean;
  activeId: string | null | undefined;
  wsSending: boolean;
  chat: Pick<UseChatSocket, "compactSession">;
  toast: ToastFn;
}) {
  const [contextHealthOpen, setContextHealthOpen] = useState(false);

  const handleCompactSession = useCallback(
    async (instructions?: string) => {
      if (demo || !activeId) {
        toast("请先打开一个进行中的会话后再压缩上下文", "info");
        return;
      }
      if (wsSending) {
        toast("当前回复尚未结束，请等待本轮完成后再压缩", "info");
        return;
      }
      toast("正在压缩当前会话上下文…", "info");
      try {
        const res = await chat.compactSession(activeId, instructions);
        if (!res.supported) {
          toast(res.error || "当前引擎暂不支持原地压缩，建议开启新会话继续", "info");
          return;
        }
        if (!res.ok) {
          toast(res.error || "上下文压缩失败，请稍后重试", "error");
          return;
        }
        toast("上下文压缩完成，完整记录仍保留在时间线中", "success");
      } catch (e) {
        toast(e instanceof Error ? e.message : "上下文压缩失败，请稍后重试", "error");
      }
    },
    [demo, activeId, wsSending, chat, toast],
  );

  return { contextHealthOpen, setContextHealthOpen, handleCompactSession };
}

/**
 * 输入预测按需加载（OCV5-375）：解析器延迟加载，不进首屏包。
 */
export function useSessionInputPrediction(demo: boolean, wsMessages: ChatMessage[]) {
  const inputPredictionOn = useInputPredictionEnabled();
  const [predictInput, setPredictInput] = useState<PredictInput | null>(null);
  useEffect(() => {
    if (demo || !inputPredictionOn || predictInput) return;
    let alive = true;
    void import("../lib/inputPrediction").then(
      (m) => {
        if (alive) setPredictInput(() => m.predictInput);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [demo, inputPredictionOn, predictInput]);
  return useMemo(
    () => (demo || !inputPredictionOn || !predictInput ? null : predictInput(wsMessages)),
    [demo, inputPredictionOn, predictInput, wsMessages],
  );
}

export function findLastUserText(
  demo: boolean,
  demoMessages: ReadonlyArray<{ role: string; content?: string }>,
  wsMessages: ReadonlyArray<ChatMessage>,
): string | undefined {
  if (demo) {
    for (let i = demoMessages.length - 1; i >= 0; i--) {
      if (demoMessages[i].role === "user" && demoMessages[i].content) return demoMessages[i].content;
    }
    return undefined;
  }
  for (let i = wsMessages.length - 1; i >= 0; i--) {
    const message = wsMessages[i];
    if (message.role === "user" && message.status !== "queued" && message.text) return message.text;
  }
  return undefined;
}
