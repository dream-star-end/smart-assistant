// 移动端整页布局探针(T25 专用页面)。
//
// 为什么单独一页:主 harness 把十几个挂载根平铺在 body 上,并用脚手架 CSS 覆盖了
// `#root{position:fixed;inset:0}` 与 `body{overflow:hidden}` —— 在那种页面上问
// "整页有没有横向溢出"没有意义(答案永远是别人家的根节点)。这里只挂一棵树,
// 结构与 App.tsx 的聊天页外壳同构(safe-px 外层 → main → ChatHeader → 聊天滚动区
// → Composer),CSS 用的是同一份 production 产物,视口 390×844。
//
// 守的是哪一类用户可见事实:
//   ① 390px 下顶栏不被挤爆(汉堡/智能体/模型/主题四个入口全在视口内且可点);
//   ② 助手正文里的宽内容(长 URL、宽代码块、宽表格、长 Bash 命令)要么放得下,
//      要么落在自己的横向滚动区里 —— 聊天滚动区是 overflow-x-hidden,超出即被裁掉
//      看不见,而"看不见"在 jsdom 与单组件用例里都测不出来;
//   ③ 发送区可用:「+」菜单能弹、发送按钮能点、文本原样送出。
//
// 覆盖边界(别高估这道门):被守的是**组件 + production CSS**在 390px 下的表现
// (ChatHeader / Composer / MessageList / 各类卡片 / markdown)。App.tsx 那层外壳
// 类名在这里是复刻的三行 flex 结构 —— 它自己漂了本用例不会红。真要连外壳一起守,
// 得让 App 把聊天页外壳抽成可挂载组件,那是另一档改动(见交付说明的 followups)。
//
// stub 原则同主 harness:只 stub 网络/宿主副作用,不 stub 任何 UI 结构。
import { StrictMode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ChatHeader } from "../src/components/ChatHeader";
import { Composer } from "../src/components/Composer";
import { MessageList } from "../src/components/MessageRenderer";
import { createStickToBottomController } from "../src/components/chat/stickToBottom";
import { attachWheelFence } from "../src/components/chat/wheelFence";
import type { Agent } from "../src/lib/agents";
import type { MediaRef } from "../src/lib/chat/frames";
import type { ChatMessage } from "../src/lib/chat/model";

declare global {
  interface Window {
    /** T25 移动整页:上层真实收到的交互结果(run.mjs 读回)。 */
    __mobilePage: {
      navOpens: number;
      sends: Array<{ text: string; mediaCount: number }>;
      following: boolean;
      directManipulation: boolean;
      wheelFence: boolean;
      /** 程序化 scrollTop 写入计数(controller 是唯一写手;T63 断言滚轮期间为 0)。 */
      programmaticWrites: number;
      armSticky: () => void;
      growTimeline: () => void;
      attemptViewportCorrection: (delta: number) => void;
      /** T65:滚动区下方占位(模拟底部 HUD / 断线横幅 / 委派进度条),收起时 clientHeight 变大。 */
      setBottomInset: (px: number) => void;
      /** T65:用户上滑 px 与底部占位收起落在同一帧 → 浏览器一次 scroll 事件里 scrollTop == 新 max。 */
      scrollUpWithCollapse: (px: number) => void;
    };
  }
}

window.__mobilePage = {
  navOpens: 0,
  sends: [],
  following: true,
  directManipulation: false,
  wheelFence: false,
  programmaticWrites: 0,
  armSticky: () => {},
  growTimeline: () => {},
  attemptViewportCorrection: () => {},
  setBottomInset: () => {},
  scrollUpWithCollapse: () => {},
};

// 宽内容样本:每一条都是线上真实出现过的形态,且都是移动端最容易被裁的东西。
const LONG_URL =
  "https://openclaude.example.com/workspaces/acme-production/sessions/7f3a9c21-4d55-4b0e-9a11-0c6f2b8e5d33/artifacts/build-log-2026-07-26.txt";
const WIDE_CODE = [
  "```ts",
  'export const MOBILE_WIDE_CODE_MARKER = await pipeline.run({ source: "s3://bucket/very/long/prefix/object-key.json", transform: normalizeRecords, sink: warehouse, retries: 5 })',
  "```",
].join("\n");
const WIDE_TABLE = [
  "| 指标 | 上周 | 本周 | 环比 | 目标 | 负责人 | 备注说明字段 |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  "| 首次响应时延 | 1280ms | 940ms | -26.6% | <900ms | 平台组 | 长尾来自冷容器唤醒 |",
].join("\n");

const MOBILE_MESSAGES: ChatMessage[] = [
  {
    id: "mobile-user-1",
    role: "user",
    // 无空格长串:break-words 失效时它会把整行撑出视口。
    text: "MOBILE_LONG_TOKEN_MARKER_aG9yaXpvbnRhbC1vdmVyZmxvdy1yZWdyZXNzaW9uLWNhbmFyeS12ZXJ5LWxvbmctdW5icm9rZW4tdG9rZW4",
    ts: 1,
  },
  {
    id: "mobile-tool-1",
    role: "tool",
    text: "",
    ts: 2,
    toolName: "Bash",
    inputJson: {
      command:
        "docker exec openclaude-runtime-7f3a9c21 bash -lc 'cd /workspace/acme && npm run build --workspace packages/web-react -- --mode production --emptyOutDir false'",
    },
    output:
      "vite v8.0.14 building for production...\n" +
      "transforming (1842) node_modules/.pnpm/react-markdown@10.1.0/node_modules/react-markdown/lib/index.js\n" +
      "MOBILE_TOOL_OUTPUT_MARKER built in 41.62s",
    _completed: true,
  },
  {
    id: "mobile-assistant-1",
    role: "assistant",
    text: [
      "构建已经通过,产物在 " + LONG_URL + " 。",
      "",
      WIDE_CODE,
      "",
      WIDE_TABLE,
      "",
      "MOBILE_ASSISTANT_TAIL_MARKER",
    ].join("\n"),
    ts: 3,
  },
];

const MOBILE_AGENT: Agent = {
  id: "main",
  name: "全能助手",
  description: "移动端整页布局探针",
};

// 长展示名:顶栏拥挤度的真实上限(线上模型名比这更长的都有)。
const MOBILE_MODELS = [
  { id: "m-mobile-a", display_name: "OpenClaude 旗舰推理 Max 1M 长上下文" },
  { id: "m-mobile-b", display_name: "OpenClaude 均衡 Pro" },
];

function MobileChatPage() {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [growCount, setGrowCount] = useState(0);
  const [bottomInset, setBottomInset] = useState(0);
  const [modelId, setModelId] = useState(MOBILE_MODELS[0].id);
  const stick = useRef(createStickToBottomController()).current;
  const syncFollowing = useCallback(() => {
    window.__mobilePage.following = stick.following.current;
    window.__mobilePage.directManipulation = stick.directManipulation.current;
  }, [stick]);
  // 篱笆标志按实时值读:释放由原生 timer/scrollend 触发,不经过任何 React 事件,
  // 靠 syncFollowing 快照会读到过期值。
  useLayoutEffect(() => {
    Object.defineProperty(window.__mobilePage, "wheelFence", {
      configurable: true,
      get: () => stick.wheelFence.current,
    });
  }, [stick]);
  // 与 App.tsx 同一份滚轮篱笆接线(共享 attachWheelFence),真浏览器 T63 守的就是它。
  useLayoutEffect(() => {
    if (!scroller) return;
    return attachWheelFence(scroller, stick);
  }, [scroller, stick]);
  // 统计 controller 之外无人写 scrollTop:把 scroller 的 scrollTop setter 包一层,
  // 只在非用户手势(篱笆已起)期间计数。用户滚轮本身由合成线程滚动,不经过 setter。
  useLayoutEffect(() => {
    if (!scroller) return;
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    if (!desc?.set || !desc.get) return;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get() { return desc.get!.call(this); },
      set(v: number) {
        if (stick.wheelFence.current || stick.directManipulation.current) {
          window.__mobilePage.programmaticWrites += 1;
        }
        desc.set!.call(this, v);
      },
    });
    return () => { delete (scroller as { scrollTop?: unknown }).scrollTop; };
  }, [scroller, stick]);
  window.__mobilePage.armSticky = () => {
    if (!scroller) return;
    stick.scrollToBottom(scroller);
    syncFollowing();
  };
  window.__mobilePage.growTimeline = () => setGrowCount((value) => value + 1);
  window.__mobilePage.attemptViewportCorrection = (delta) => {
    if (!scroller) return;
    stick.correctTo(scroller, scroller.scrollTop + delta);
    syncFollowing();
  };
  window.__mobilePage.setBottomInset = (px) => setBottomInset(px);
  window.__mobilePage.scrollUpWithCollapse = (px) => {
    if (!scroller) return;
    // 键盘/滚轮首 tick 都先 mark;用户位移与占位收起在同一任务里落地,浏览器把两者
    // 合并成一次 scroll 事件,scrollTop 恰好等于新 max —— 和 scrollHeight 收缩 clamp 同形。
    stick.markUserIntent();
    scroller.scrollTop = scroller.scrollTop - px;
    flushSync(() => setBottomInset(0));
  };
  useLayoutEffect(() => {
    if (!scroller) return;
    stick.reset();
    stick.scrollToBottom(scroller);
    syncFollowing();
  }, [scroller, stick, syncFollowing]);
  const messages = [
    ...MOBILE_MESSAGES,
    ...Array.from({ length: growCount }, (_, index): ChatMessage => ({
      id: `mobile-grow-${index}`,
      role: "assistant",
      text: Array.from(
        { length: 36 },
        (__, line) => `MOBILE_GROW_${index}_${line} 触控滚动高度增长回归样本。`,
      ).join("\n\n"),
      ts: 100 + index,
    })),
  ];
  // 与 App.tsx 聊天页外壳同构(safe-px 外层 → main → header → 滚动区 → 发送区)。
  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-bg text-fg safe-px">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatHeader
          agent={MOBILE_AGENT}
          onAgentClick={() => {}}
          models={MOBILE_MODELS}
          selectedModelId={modelId}
          onSelectModel={setModelId}
          credits="123456"
          onOpenBilling={() => {}}
          onNew={() => {}}
          onOpenMobileNav={() => {
            window.__mobilePage.navOpens += 1;
          }}
          onOpenInbox={() => {}}
          unreadCount={3}
        />
        <div
          ref={setScroller}
          onScroll={(event) => {
            stick.onScroll(event.currentTarget);
            syncFollowing();
          }}
          onWheel={() => stick.markUserIntent()}
          onTouchStart={() => stick.beginDirectManipulation()}
          onTouchMove={() => stick.beginDirectManipulation()}
          onTouchEnd={() => {
            stick.endDirectManipulation();
            syncFollowing();
          }}
          onTouchCancel={() => stick.endDirectManipulation()}
          onPointerDown={() => stick.beginDirectManipulation()}
          onPointerUp={() => stick.endDirectManipulation()}
          onPointerCancel={(event) => {
            if (event.pointerType !== "touch") stick.endDirectManipulation();
          }}
          onKeyDown={() => stick.markUserIntent()}
          data-testid="mobile-chat-scroll"
          className="chat-scroll-area min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        >
          <MessageList
            messages={messages}
            sending={false}
            cb={{}}
            onRespondPermission={() => {}}
            scrollParent={scroller}
            historyGeneration="mobile-page"
            followBottomRef={stick.canRestick}
          />
        </div>
        {bottomInset > 0 ? (
          <div data-testid="mobile-bottom-inset" className="shrink-0" style={{ height: bottomInset }} />
        ) : null}
        <div className="shrink-0 composer-safe-b">
          <Composer
            onSend={(text: string, media?: MediaRef[]) => {
              window.__mobilePage.sends.push({ text, mediaCount: media?.length ?? 0 });
            }}
            placeholder="和「全能助手」对话…"
            onUpload={async (file: File): Promise<MediaRef> => ({
              kind: "file",
              url: "https://stub.invalid/mobile",
              filename: file.name,
            })}
          />
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MobileChatPage />
  </StrictMode>,
);
