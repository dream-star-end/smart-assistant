/**
 * 杂项 P3 审计场景(t-839 · G-4 / G-5):
 *  - ?demo=1 离线演示模式的两个可见面:空会话(EmptyState 的 demo 形态,无「设定目标」出口)
 *    与 demo 消息流(components/Message.tsx 通道:用户气泡 / 助手正文 / 流式中 / 动作条);
 *  - components/optionsGroup.tsx 多题作答聚合页脚的四个状态:未答 / 部分答 / 已发送 /
 *    流式单块(禁止隐式发送)+ 流式结束后仍有未发送的点选。
 * 交互态用挂载期 AutoAct 点出来(shoot.mjs 配 OC_UI_SHOT_DELAY≥1500 再截)。
 */
import { type ReactNode, useEffect, useState } from "react";
import { EmptyState } from "../../src/components/EmptyState";
import { Markdown } from "../../src/components/Markdown";
import { AssistantMessage, UserMessage } from "../../src/components/Message";
import { OptionsGroupFooter, OptionsGroupProvider } from "../../src/components/optionsGroup";
import { ChatInteractionContext } from "../../src/components/tool/context";
import { DEFAULT_AGENT } from "../../src/lib/agents";
import { DEMO_MESSAGES, demoReply } from "../../src/lib/demo";
import type { Scene } from "./types";

const noop = () => {};

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-fg">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-8">{children}</div>
    </div>
  );
}

/** 挂载后按顺序点按钮(按可见文本匹配),每步最多等 2s;用于把交互态摆到静态截图里。 */
function AutoAct({ clicks, then, children }: { clicks: string[]; then?: () => void; children: ReactNode }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: 场景挂载期一次性动作,故意不随 props 重跑
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const text of clicks) {
        for (let i = 0; i < 40 && !cancelled; i++) {
          // 选项按钮开头是不可见的「✓」占位,按包含匹配
          const btn = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
            (b) => !b.disabled && (b.textContent ?? "").includes(text),
          );
          if (btn) {
            btn.click();
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        await new Promise((r) => setTimeout(r, 60));
      }
      if (!cancelled) then?.();
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return <>{children}</>;
}

// ── demo 模式 ───────────────────────────────────────────────────────────────

function DemoStream() {
  const streamingText = demoReply("帮我评估一下这个方案的风险点").slice(0, 118);
  return (
    <ChatInteractionContext.Provider value={{}}>
      <Page>
        {DEMO_MESSAGES.map((m, i) =>
          m.role === "user" ? (
            <UserMessage key={m.id} content={m.content} />
          ) : (
            <AssistantMessage key={m.id} message={m} toolCards={[]} onRegenerate={i === DEMO_MESSAGES.length - 1 ? noop : undefined} />
          ),
        )}
        <UserMessage content="帮我评估一下这个方案的风险点" />
        <AssistantMessage
          message={{ id: "streaming", role: "assistant", content: streamingText, createdAt: new Date().toISOString() }}
          streaming
          toolCards={[]}
        />
      </Page>
    </ChatInteractionContext.Provider>
  );
}

// ── optionsGroup 多题聚合 ────────────────────────────────────────────────────

const THREE_QUESTIONS = `先确认几个前提，我再给方案：

\`\`\`options
{"question":"这次更看重哪一点？","options":[{"label":"上线速度","desc":"两周内先跑通"},{"label":"长期可维护","desc":"接受多花一周"},{"label":"成本最低"}]}
\`\`\`

\`\`\`options
{"question":"需要接入哪些渠道？（可多选）","multi":true,"options":["微信","小红书","邮件","站内信"]}
\`\`\`

\`\`\`options
{"question":"是否需要人工复核环节？","options":["需要，每单必审","抽检 10%","不需要"]}
\`\`\`

选好后一次性发给我即可。`;

const ONE_QUESTION = `方案我先按默认口径走，只有一处要你定：

\`\`\`options
{"question":"发布节奏？","options":["每周一次","每两周一次","按需发布"]}
\`\`\`
`;

function OptionsScene({
  text,
  clicks = [],
  live = false,
  endLiveAfterClicks = false,
}: {
  text: string;
  clicks?: string[];
  live?: boolean;
  endLiveAfterClicks?: boolean;
}) {
  const [isLive, setIsLive] = useState(live);
  return (
    <ChatInteractionContext.Provider value={{ sendUserText: noop, busy: isLive }}>
      <Page>
        <UserMessage content="帮我做一个自动化投放方案" />
        <AutoAct clicks={clicks} then={endLiveAfterClicks ? () => setIsLive(false) : undefined}>
          <div className="flex gap-4">
            <div className="min-w-0 flex-1">
              <OptionsGroupProvider live={isLive}>
                <Markdown caret={isLive}>{text}</Markdown>
                <OptionsGroupFooter />
              </OptionsGroupProvider>
            </div>
          </div>
        </AutoAct>
      </Page>
    </ChatInteractionContext.Provider>
  );
}

export const miscP3Scenes: Scene[] = [
  {
    id: "misc-demo-empty",
    label: "demo 模式 · 空会话(无「设定目标」出口)",
    group: "工作区",
    viewports: ["desktop", "mobile"],
    api: {},
    render: () => (
      <div className="h-screen bg-bg text-fg">
        <EmptyState agent={DEFAULT_AGENT} onPrefill={noop} onChangeAgent={noop} />
      </div>
    ),
  },
  {
    id: "misc-demo-stream",
    label: "demo 模式 · 本地消息流(用户气泡 / 助手正文 / 流式中)",
    group: "工作区",
    viewports: ["desktop", "mobile"],
    api: {},
    render: () => <DemoStream />,
  },
  {
    id: "misc-options-unanswered",
    label: "optionsGroup · 三题未答",
    group: "工作区",
    viewports: ["desktop", "mobile"],
    api: {},
    render: () => <OptionsScene text={THREE_QUESTIONS} />,
  },
  {
    id: "misc-options-partial",
    label: "optionsGroup · 三题部分作答(1 单选 + 2 多选)",
    group: "工作区",
    viewports: ["desktop", "mobile"],
    api: {},
    render: () => <OptionsScene text={THREE_QUESTIONS} clicks={["长期可维护", "微信", "邮件"]} />,
  },
  {
    id: "misc-options-sent",
    label: "optionsGroup · 部分作答后发送(未答题标注)",
    group: "工作区",
    viewports: ["desktop", "mobile"],
    api: {},
    render: () => <OptionsScene text={THREE_QUESTIONS} clicks={["上线速度", "小红书", "发送选择"]} />,
  },
  {
    id: "misc-options-live-single",
    label: "optionsGroup · 流式期单块(禁止点击即发,页脚必现)",
    group: "工作区",
    viewports: ["desktop"],
    api: {},
    render: () => <OptionsScene text={ONE_QUESTION} live clicks={["每两周一次"]} />,
  },
  {
    id: "misc-options-live-ended-pending",
    label: "optionsGroup · 流式期点选后流式结束(仍应可显式发送)",
    group: "工作区",
    viewports: ["desktop"],
    api: {},
    render: () => <OptionsScene text={ONE_QUESTION} live clicks={["每两周一次"]} endLiveAfterClicks />,
  },
];
