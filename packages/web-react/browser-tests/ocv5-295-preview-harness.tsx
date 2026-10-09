// OCV5-295 移动聊天页减负 —— 真组件预览页(可长驻服务 + 截图)。
//
// 与 mobile-harness.tsx 同构:safe-px 外层 → main → ChatHeader → 聊天滚动区 → Composer,
// 同一份 production CSS。这里只换数据:三种典型态,由 URL 参数选择:
//   ?scene=complete   完成态(工作过程 + 正文 + 复制 · 赞踩 · 更多菜单;时间/积分/请求号在菜单里,OCV5-359)
//   ?scene=streaming  流式中(sending=true,末条 assistant 为 live,整排操作不出现)
//   ?scene=partial    停止 / 上游失败但已有部分正文(复制 + 精简菜单;积分/请求号在菜单里)
//   &theme=dark       暗色(useTheme 的唯一落点 <html class="dark">)
//   &model=long       超长模型名(顶栏截断回归)
// 只读合成示例:不发任何模型请求;网络只剩 fetch 兜底 204。评分 submit 只写内存。
import { StrictMode, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatHeader } from "../src/components/ChatHeader";
import { Composer } from "../src/components/Composer";
import { MessageList } from "../src/components/MessageRenderer";
import { ResponseRatingProvider, type RatingEntry } from "../src/components/chat/ResponseRating";
import { createStickToBottomController } from "../src/components/chat/stickToBottom";
import { ToastProvider, TooltipProvider } from "../src/components/ui";
import type { Agent } from "../src/lib/agents";
import type { MediaRef } from "../src/lib/chat/frames";
import type { ChatMessage } from "../src/lib/chat/model";

declare global {
  interface Window {
    __ocv5295: {
      scene: string;
      sends: Array<{ text: string; mediaCount: number }>;
      ratings: Array<{ messageId: string; rating: string }>;
      feedbackOpens: number;
      regenerates: number;
      quotes: number;
      repoOpens: number;
      exports: number;
    };
  }
}

const params = new URLSearchParams(location.search);
const SCENE = params.get("scene") ?? "complete";
const THEME = params.get("theme") === "dark" ? "dark" : "light";
const LONG_MODEL = params.get("model") === "long";
document.documentElement.classList.toggle("dark", THEME === "dark");

window.__ocv5295 = {
  scene: SCENE,
  sends: [],
  ratings: [],
  feedbackOpens: 0,
  regenerates: 0,
  quotes: 0,
  repoOpens: 0,
  exports: 0,
};
// 离线预览:旁路埋点(reportClientFriction 等)一律 204,不出网。
window.fetch = async () => new Response(null, { status: 204 });

const NOW = Date.now();
const AGENT: Agent = { id: "main", name: "全能助手", description: "OCV5-295 预览" };
const MODELS = [
  LONG_MODEL
    ? { id: "m-long", display_name: "Claude Opus 5.5 Box 超长上下文推理旗舰版 1M", cost_x: 4.1 }
    : { id: "m-astra", display_name: "GPT-6-Astra", cost_x: 4.1 },
  { id: "m-b", display_name: "OpenClaude 均衡 Pro", cost_x: 1 },
];

const USER: ChatMessage = { id: "u-1", role: "user", text: "发布到线上了吗?帮我核一下。", ts: NOW - 120_000 };
const TOOLS: ChatMessage[] = [
  {
    id: "t-1",
    role: "tool",
    text: "",
    ts: NOW - 110_000,
    toolName: "Bash",
    inputJson: { command: "curl -fsS https://example.invalid/healthz" },
    output: '{"ok":true,"db":"ok","redis":"ok"}',
    _completed: true,
  } as ChatMessage,
  {
    id: "t-2",
    role: "tool",
    text: "",
    ts: NOW - 100_000,
    toolName: "Bash",
    inputJson: { command: "git log --oneline -1" },
    output: "817c6940 fix: release",
    _completed: true,
  } as ChatMessage,
];
const FINAL_TEXT = [
  "**已上线。** 北京时间 00:53 完成切换到修复版 `817c6940`。",
  "",
  "刚核验:",
  "",
  "- 发布已成功提交,主服务确实运行新版。",
  "- 健康检查正常,数据库、Redis 正常。",
  "",
  "但真实 Box 并行 Edit 流程尚未验收,暂不能说问题已彻底解决。",
].join("\n");

// &history=1:前置若干历史轮,让滚动区可滚,用来验「回到底部」与历史行折叠。
const HISTORY: ChatMessage[] = params.get("history") === "1"
  ? Array.from({ length: 4 }, (_, i): ChatMessage[] => [
      { id: `h-u-${i}`, role: "user", text: `历史问题 ${i + 1}:这一步的回滚方案是什么?`, ts: NOW - 3_600_000 + i * 60_000 },
      {
        id: `h-a-${i}`,
        role: "assistant",
        text: Array.from({ length: 5 }, (__, j) => `历史回答 ${i + 1}-${j + 1}:按功能分支 revert 该提交再 push,无迁移、无数据回填。`).join("\n\n"),
        ts: NOW - 3_590_000 + i * 60_000,
        usage: { traceId: `9f0e${i}d2c1b3a4e5f6`, costCredits: String(20 + i) },
      } as ChatMessage,
    ]).flat()
  : [];

function sceneMessages(): { messages: ChatMessage[]; sending: boolean } {
  const out = sceneMessagesBase();
  return { ...out, messages: [...HISTORY, ...out.messages] };
}

function sceneMessagesBase(): { messages: ChatMessage[]; sending: boolean } {
  if (SCENE === "streaming") {
    return {
      sending: true,
      messages: [
        USER,
        ...TOOLS,
        { id: "a-live", role: "assistant", text: "**已上线。** 北京时间 00:53 完成切换到修复版 `817c6940`。\n\n刚核验:", ts: NOW - 2_000 },
      ],
    };
  }
  if (SCENE === "partial") {
    return {
      sending: false,
      messages: [
        { ...USER, id: "u-p1", ts: NOW - 300_000, text: "先总结一下上周的发布记录。" },
        {
          id: "a-stopped",
          role: "assistant",
          text: "上周共 3 次发布:周一修复登录回跳,周三上线附件预览,周五——",
          ts: NOW - 290_000,
          _errorCode: "stopped",
          usage: { traceId: "5d1c0b7e2a9f4c31", costCredits: "12" },
        } as ChatMessage,
        { ...USER, id: "u-p2", ts: NOW - 90_000, text: "继续,把周五那次补完。" },
        {
          id: "a-failed",
          role: "assistant",
          text: "周五的发布切换了计费明细页的默认排序,并修复了",
          ts: NOW - 60_000,
          _errorCode: "upstream_failed",
          usage: { traceId: "c4e98a01b7d2e655", costCredits: "8" },
        } as ChatMessage,
      ],
    };
  }
  return {
    sending: false,
    messages: [
      USER,
      ...TOOLS,
      {
        id: "a-final",
        role: "assistant",
        text: FINAL_TEXT,
        ts: NOW - 60_000,
        usage: { traceId: "a80e9cae51f04b2d", costCredits: "109" },
      } as ChatMessage,
    ],
  };
}

function PreviewPage() {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [modelId, setModelId] = useState(MODELS[0].id);
  const [ratings, setRatings] = useState(() => new Map<string, RatingEntry>());
  const stick = useRef(createStickToBottomController()).current;
  const followBottomRef = useMemo(() => ({
    get current() {
      return stick.following.current;
    },
    set current(value: boolean) {
      stick.following.current = value;
    },
    scrollToBottom: stick.scrollToBottom,
    jumpToBottom: stick.jumpToBottom,
    correctTo: stick.correctTo,
  }), [stick]);
  const { messages, sending } = useMemo(sceneMessages, []);
  const ratingCtx = useMemo(() => ({
    ratings,
    submit: (input: { messageId: string; rating: "up" | "down"; tags?: string[] }) => {
      window.__ocv5295.ratings.push({ messageId: input.messageId, rating: input.rating });
      setRatings((prev) => new Map(prev).set(input.messageId, { rating: input.rating, tags: input.tags ?? [] }));
    },
  }), [ratings]);
  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-bg text-fg safe-px">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatHeader
          agent={AGENT}
          onAgentClick={() => {}}
          models={MODELS}
          selectedModelId={modelId}
          onSelectModel={setModelId}
          effortSupported={["low", "medium", "high"]}
          effortActive="high"
          onSelectEffort={() => {}}
          credits="123456"
          onOpenBilling={() => {}}
          onNew={() => {}}
          onOpenMobileNav={() => {}}
          onOpenFind={() => {}}
          onExport={() => {
            window.__ocv5295.exports += 1;
          }}
          sessionUnreadCount={27}
          onOpenInbox={() => {}}
          unreadCount={95}
        />
        <div
          ref={setScroller}
          onScroll={(event) => stick.onScroll(event.currentTarget)}
          onWheel={() => stick.markUserIntent()}
          onTouchStart={() => stick.beginDirectManipulation()}
          onTouchMove={() => stick.beginDirectManipulation()}
          onTouchEnd={() => stick.endDirectManipulation()}
          onTouchCancel={() => stick.endDirectManipulation()}
          onKeyDown={() => stick.markUserIntent()}
          data-testid="preview-chat-scroll"
          className="chat-scroll-area min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        >
          <ResponseRatingProvider value={ratingCtx}>
            <MessageList
              processDisclosure
              messages={messages}
              sending={sending}
              cb={{
                onRegenerate: () => {
                  window.__ocv5295.regenerates += 1;
                },
                onQuote: () => {
                  window.__ocv5295.quotes += 1;
                },
                onFeedback: () => {
                  window.__ocv5295.feedbackOpens += 1;
                },
              }}
              onRespondPermission={() => {}}
              scrollParent={scroller}
              historyGeneration={`ocv5-295-${SCENE}`}
              followBottomRef={followBottomRef}
            />
          </ResponseRatingProvider>
        </div>
        <div className="shrink-0 composer-safe-b">
          <Composer
            onSend={(text: string, media?: MediaRef[]) => {
              window.__ocv5295.sends.push({ text, mediaCount: media?.length ?? 0 });
            }}
            busy={sending}
            onStop={() => {}}
            getVoiceToken={() => "preview-token"}
            onSetGoal={async () => {}}
            placeholder="和「全能助手」对话…"
            onUpload={async (file: File): Promise<MediaRef> => ({
              kind: "file",
              url: "https://stub.invalid/ocv5-295",
              filename: file.name,
            })}
            repoSelection={{ selected: false }}
            onOpenRepo={() => {
              window.__ocv5295.repoOpens += 1;
            }}
          />
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <TooltipProvider>
        <PreviewPage />
      </TooltipProvider>
    </ToastProvider>
  </StrictMode>,
);
