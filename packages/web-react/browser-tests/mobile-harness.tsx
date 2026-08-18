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
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatHeader } from "../src/components/ChatHeader";
import { Composer } from "../src/components/Composer";
import { MessageList } from "../src/components/MessageRenderer";
import type { Agent } from "../src/lib/agents";
import type { ChatMessage } from "../src/lib/chat/model";
import type { MediaRef } from "../src/lib/chat/frames";

declare global {
  interface Window {
    /** T25 移动整页:上层真实收到的交互结果(run.mjs 读回)。 */
    __mobilePage: {
      navOpens: number;
      sends: Array<{ text: string; mediaCount: number }>;
    };
  }
}

window.__mobilePage = { navOpens: 0, sends: [] };

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
  const [modelId, setModelId] = useState(MOBILE_MODELS[0].id);
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
          data-testid="mobile-chat-scroll"
          className="chat-scroll-area min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        >
          <MessageList
            messages={MOBILE_MESSAGES}
            sending={false}
            cb={{}}
            onRespondPermission={() => {}}
            scrollParent={scroller}
            historyGeneration="mobile-page"
          />
        </div>
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
