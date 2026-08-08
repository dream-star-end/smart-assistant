import { ChevronDown, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import type { TutorialCase } from "../../lib/tutorialCaseCatalog";
import { MessageList } from "../MessageRenderer";
import { Button } from "../ui";

const REPLAY_PAGE_SIZE = 30;

type ReplayLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; messages: ChatMessage[] };

/**
 * 真实案例轨迹单独按需读取，不把长过程塞进教程主 bundle。只读复用聊天消息渲染器，
 * 并逐页展开直到完整显示；没有 messagesPath 时不会发网络请求，更不会造一段替代轨迹。
 */
export function TutorialReplay({ replay }: { replay: TutorialCase["replay"] }) {
  const [loadState, setLoadState] = useState<ReplayLoadState>({ status: "idle" });
  const [visibleCount, setVisibleCount] = useState(REPLAY_PAGE_SIZE);
  const messagesPath = replay.messagesPath;

  useEffect(() => {
    setLoadState({ status: "idle" });
    setVisibleCount(REPLAY_PAGE_SIZE);
  }, [messagesPath]);

  const load = async () => {
    if (!messagesPath) return;
    setLoadState({ status: "loading" });
    try {
      const response = await fetch(messagesPath, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: unknown = await response.json();
      const messages = Array.isArray(payload)
        ? payload
        : payload && typeof payload === "object" && Array.isArray((payload as { messages?: unknown }).messages)
          ? (payload as { messages: unknown[] }).messages
          : null;
      if (!messages) throw new Error("轨迹文件格式不正确");
      setLoadState({ status: "ready", messages: messages as ChatMessage[] });
    } catch (error) {
      setLoadState({
        status: "error",
        message: error instanceof Error ? error.message : "读取失败",
      });
    }
  };

  if (replay.status === "pending_capture" || !messagesPath) {
    return (
      <p className="mt-1 text-[12.5px] leading-5 text-muted">
        待真实运行采集。当前只展示经人工编写、可复查的案例步骤，绝不把模拟文字伪装成 Agent 轨迹。
      </p>
    );
  }

  const provenance = (
    <div className="mt-3 rounded-lg bg-surface px-3 py-2 text-[11px] leading-5 text-faint">
      <p>
        {replay.provenance.repeatRuns} 次独立运行 · {replay.provenance.messageCount} 条真实消息 · 发布 {replay.provenance.release}
      </p>
      <p className="break-all">轨迹 SHA-256：{replay.provenance.messagesSha256}</p>
      <p className="break-all">运行 ID：{replay.provenance.runIds.join("、")}</p>
      <a href={replay.checkReport} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
        查看确定性验收报告
      </a>
    </div>
  );

  const preview = replay.video || replay.poster ? (
    <div className="mt-3 overflow-hidden rounded-xl border border-border bg-sidebar">
      {replay.video ? (
        <video controls playsInline preload="metadata" poster={replay.poster} className="aspect-video w-full object-cover">
          <source src={replay.video} type="video/webm" />
        </video>
      ) : (
        <img src={replay.poster} alt="案例真实运行预览" className="aspect-video w-full object-cover" />
      )}
      <p className="border-t border-border px-3 py-2 text-[11px] text-faint">短预览只帮助定位；下方轨迹保留完整过程，不以视频代替。</p>
    </div>
  ) : null;

  if (loadState.status === "idle") {
    return (
      <div className="mt-3">
        {provenance}
        {preview}
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          加载真实完整过程 <ChevronDown size={14} />
        </Button>
        <p className="mt-2 text-[11.5px] text-faint">点击后才读取脱敏轨迹，不影响教程中心首次打开速度。</p>
      </div>
    );
  }

  if (loadState.status === "loading") {
    return <div>{provenance}{preview}<p className="mt-3 inline-flex items-center gap-2 text-[12.5px] text-muted"><Loader2 size={14} className="animate-spin" /> 正在读取真实 Agent 过程…</p></div>;
  }

  if (loadState.status === "error") {
    return (
      <div className="mt-3">
        {provenance}
        {preview}
        <p className="text-[12.5px] text-danger">真实过程读取失败：{loadState.message}</p>
        <Button variant="ghost" size="sm" onClick={() => void load()} className="mt-2"><RotateCcw size={13} /> 重试</Button>
      </div>
    );
  }

  const visibleMessages = loadState.messages.slice(0, visibleCount);
  const remaining = loadState.messages.length - visibleMessages.length;
  return (
    <div>
      {provenance}
      {preview}
      <details open className="mt-3 rounded-xl border border-border bg-bg">
      <summary className="cursor-pointer px-4 py-3 text-[12.5px] font-semibold text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring">
        真实 Agent 过程 · 已显示 {visibleMessages.length}/{loadState.messages.length} 条
      </summary>
      <div className="border-t border-border">
        <MessageList
          messages={visibleMessages}
          sending={false}
          cb={{}}
          onRespondPermission={() => {}}
          readOnly
        />
        {remaining > 0 && (
          <div className="border-t border-border px-4 py-3 text-center">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setVisibleCount((count) => Math.min(count + REPLAY_PAGE_SIZE, loadState.messages.length))}
            >
              展开后续 {Math.min(REPLAY_PAGE_SIZE, remaining)} 条
            </Button>
            <p className="mt-1.5 text-[11px] text-faint">不截断；可继续展开直至完整过程全部可见。</p>
          </div>
        )}
      </div>
      </details>
    </div>
  );
}
