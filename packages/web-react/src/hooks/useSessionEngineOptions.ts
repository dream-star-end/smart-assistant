/**
 * 本会话的思考档位与 Cursor 上下文档位(per-session 记忆,切会话时回读)。
 * 从 App() 原样搬出(OCV5-376 P3):两组「状态 + 写入回调 + 切会话回读」;App 原位调用,
 * effect 顺序不变。语义见 lib/sessionEffort、lib/sessionContextTier。
 */
import { useCallback, useEffect, useState } from "react";
import type { CursorContextTier } from "@openclaude/protocol";
import { readContextTierForSession, writeContextTier } from "../lib/sessionContextTier";
import { readSessionEffort, writeSessionEffort } from "../lib/sessionEffort";
import type { PreferenceEffort } from "../lib/modelPreferences";

export function useSessionEngineOptions(activeId: string | undefined): {
  sessionEffort: PreferenceEffort | null | undefined;
  setSessionEffort: (value: PreferenceEffort | null) => void;
  contextTier: CursorContextTier;
  setContextTier: (tier: CursorContextTier) => void;
} {
  // 思考档位的会话级记忆(语义见 lib/sessionEffort):undefined = 未选择(继承
  // preferences.default_effort);null = 显式跟随模型默认;档位 = 显式选择。
  // 与 teamMode 同款 per-session 键;首条消息创建会话后同样落地当前 intent。
  const [sessionEffort, setSessionEffortState] = useState<PreferenceEffort | null | undefined>(() =>
    readSessionEffort(activeId),
  );
  const setSessionEffort = useCallback(
    (value: PreferenceEffort | null) => {
      setSessionEffortState(value);
      writeSessionEffort(activeId, value);
    },
    [activeId],
  );
  useEffect(() => {
    setSessionEffortState(readSessionEffort(activeId));
  }, [activeId]);

  // Cursor Opus/Fable 上下文档位(300k 默认 / 1M;语义见 lib/sessionContextTier)。
  // per-session 键优先,缺失继承全局最近选择,再缺失回产品默认 300k。
  const [contextTier, setContextTierState] = useState<CursorContextTier>(() =>
    readContextTierForSession(activeId),
  );
  const setContextTier = useCallback(
    (tier: CursorContextTier) => {
      setContextTierState(tier);
      writeContextTier(activeId, tier);
    },
    [activeId],
  );
  useEffect(() => {
    setContextTierState(readContextTierForSession(activeId));
  }, [activeId]);

  return { sessionEffort, setSessionEffort, contextTier, setContextTier };
}
