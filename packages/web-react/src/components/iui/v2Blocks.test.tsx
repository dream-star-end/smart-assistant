import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetIntelligentUiForTests } from "../../lib/intelligentUi";
import { MediaSignProvider } from "../chat/media";
import { ArtifactInspectContext, ChatInteractionContext } from "../tool/context";
import { IuiBlock } from "./IuiBlock";
import { validateSpec } from "./schema";
import { uiFencesToMarkdown } from "./toMarkdown";

const j = (v: unknown) => JSON.stringify(v);

function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  return writeText;
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }),
  });
  __resetIntelligentUiForTests();
  try {
    localStorage.clear();
  } catch {
    /* jsdom */
  }
});
afterEach(cleanup);

describe("v2 schema and Markdown fallback", () => {
  it("validates all 6 new components, strips unsafe deliverable paths, auto-detects prompt slots, and converts to Markdown", () => {
    const blocks = [
      {
        type: "deliverables",
        title: "阶段产出",
        items: [
          { name: "技术方案.docx", path: "/home/agent/.openclaude/generated/plan.docx", size: "1.2 MB", preview: "# 摘要\n核心方案" },
          { name: "越界文件.txt", path: "/home/agent/../etc/passwd" },
          { name: "危险脚本.html", path: "javascript:alert(1)" },
        ],
      },
      {
        type: "citations",
        items: [{ id: "1", title: "Dual-Antenna GNSS", meta: "2025 · IEEE", conclusion: "精度提升 62%", url: "https://example.org/paper" }],
      },
      {
        type: "runbook",
        vars: [{ id: "host", label: "主机", value: "10.0.0.8" }],
        steps: [{ title: "检查健康", command: "curl http://{{host}}:8080/healthz", danger: false }],
      },
      {
        type: "prompt_template",
        template: "请面向{{受众}}汇报{{主题}}",
        slots: [{ id: "受众", label: "受众", options: ["研发团队", "管理层"] }],
      },
      {
        type: "storyboard",
        shots: [{ no: "01", shotType: "特写", line: "大家好这是第一镜", prompt: "Studio desk close-up" }],
      },
      {
        type: "flashcards",
        cards: [{ front: "React.lazy 失败为什么需重建?", back: "因为失败的 promise 会被永久缓存", tag: "前端" }],
      },
    ];

    const deliv = validateSpec(blocks[0]!, false);
    expect(deliv.ok && deliv.spec.type === "deliverables").toBe(true);
    if (deliv.ok && deliv.spec.type === "deliverables") {
      expect(deliv.spec.items[0]?.path).toBe("/home/agent/.openclaude/generated/plan.docx");
      expect(deliv.spec.items[1]?.path).toBeUndefined();
      expect(deliv.spec.items[2]?.path).toBeUndefined();
    }

    const pt = validateSpec(blocks[3]!, false);
    expect(pt.ok && pt.spec.type === "prompt_template" && pt.spec.slots.map((s) => s.id)).toEqual(["受众", "主题"]);

    const md = uiFencesToMarkdown(blocks.map((b) => `\`\`\`ui\n${j(b)}\n\`\`\``).join("\n\n"));
    for (const needle of ["技术方案.docx", "Dual-Antenna GNSS", "curl http://10.0.0.8:8080/healthz", "请面向研发团队汇报[主题]", "大家好这是第一镜", "React.lazy 失败为什么需重建?"]) {
      expect(md).toContain(needle);
    }
  });
});

describe("v2 interactive components", () => {
  it("DeliverablesBlock toggles preview and signs container path on download", async () => {
    const sign = vi.fn().mockResolvedValue({ "/home/agent/.openclaude/generated/out.md": "https://signed.example/out.md" });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(
      <MediaSignProvider sign={sign}>
        <IuiBlock
          code={j({
            type: "deliverables",
            items: [
              { name: "out.md", path: "/home/agent/.openclaude/generated/out.md", size: "12 KB", preview: "第一行说明" },
              { name: "report.pdf", path: "https://cdn.example/report.pdf" },
            ],
          })}
        />
      </MediaSignProvider>,
    );
    expect(screen.getByText("第一行说明")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起速览" }));
    expect(screen.queryByText("第一行说明")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "下载" })[0]!);
    });
    expect(sign).toHaveBeenCalledWith(["/home/agent/.openclaude/generated/out.md"]);
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it("CitationsBlock expands abstract, copies citation formats, and asks assistant to read", async () => {
    const writeText = mockClipboard();
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <IuiBlock
          code={j({
            type: "citations",
            items: [
              {
                id: "1",
                title: "Snowballing Surveys",
                meta: "Chen Y. · 2024",
                abstract: "完整摘要内容",
                gbt: "[1] CHEN Y. Snowballing.",
                bibtex: "@article{chen2024}",
              },
            ],
          })}
        />
      </ChatInteractionContext.Provider>,
    );
    expect(screen.getByText("完整摘要内容")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起摘要" }));
    expect(screen.queryByText("完整摘要内容")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /GB\/T 7714/ }));
    });
    expect(writeText).toHaveBeenCalledWith("[1] CHEN Y. Snowballing.");
    fireEvent.click(screen.getByRole("button", { name: "让助手精读" }));
    expect(sendUserText).toHaveBeenCalledWith(expect.stringContaining("Snowballing Surveys"));
  });

  it("RunbookBlock updates commands dynamically from vars and guards HTML injection", async () => {
    const writeText = mockClipboard();
    render(
      <IuiBlock
        code={j({
          type: "runbook",
          vars: [{ id: "port", label: "端口", value: "18790" }],
          steps: [{ title: "重启服务", command: "curl http://127.0.0.1:{{port}}/healthz", danger: true }],
        })}
      />,
    );
    expect(screen.getByText("变更操作")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("端口"), { target: { value: "9000<script>" } });
    expect(document.querySelector("script")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制第 1 步命令" }));
    });
    expect(writeText).toHaveBeenCalledWith("curl http://127.0.0.1:9000<script>/healthz");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Markdown/ }));
    });
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("curl http://127.0.0.1:9000<script>/healthz"));
    fireEvent.click(screen.getByRole("button", { name: "还原变量" }));
    expect(screen.getByLabelText("端口")).toHaveValue("18790");
  });

  it("PromptTemplateBlock switches slots, guards IME Enter, respects cleared defaults, and sends composed prompt", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <IuiBlock
          code={j({
            type: "prompt_template",
            template: "面向{{audience}}说明{{topic}}",
            slots: [
              { id: "audience", label: "受众", value: "工程师", options: ["工程师", "高管"] },
              { id: "topic", label: "主题", value: "UI 升级" },
            ],
          })}
        />
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "高管" }));
    fireEvent.click(screen.getByRole("button", { name: "UI 升级" }));
    const inp = screen.getByLabelText("填写主题");
    fireEvent.compositionStart(inp);
    fireEvent.change(inp, { target: { value: "二期上线" } });
    fireEvent.keyDown(inp, { key: "Enter", isComposing: true, keyCode: 229 });
    fireEvent.compositionEnd(inp);
    fireEvent.click(screen.getByRole("button", { name: "发给助手执行" }));
    expect(sendUserText).toHaveBeenCalledWith("面向高管说明二期上线");

    // 清空带默认值的槽位后，发送内容应退回占位符而不是恢复旧默认值
    fireEvent.click(screen.getByRole("button", { name: "高管" }));
    fireEvent.change(screen.getByLabelText("填写受众"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "发给助手执行" }));
    expect(sendUserText).toHaveBeenLastCalledWith("面向[受众]说明二期上线");
  });

  it("StoryboardBlock waits while streaming, keeps edits, and accepts added shots cleanly", async () => {
    const writeText = mockClipboard();
    const { rerender } = render(
      <IuiBlock
        live
        code={'{"type":"storyboard","cps":4,"shots":[{"no":"01","line":"半截台词","prompt":"Wide shot"}'}
      />,
    );
    expect(screen.queryByLabelText("镜 01 口播台词")).toBeNull();

    rerender(
      <IuiBlock
        live={false}
        code={j({
          type: "storyboard",
          cps: 4,
          shots: [
            { no: "01", line: "一二三四五六七八九十", prompt: "Wide shot" },
            { no: "02", line: "第二镜补全", prompt: "Close-up" },
          ],
        })}
      />,
    );
    expect(screen.getByLabelText("镜 01 口播台词")).toHaveValue("一二三四五六七八九十");
    expect(screen.getByLabelText("镜 02 口播台词")).toHaveValue("第二镜补全");
    fireEvent.click(screen.getByRole("radio", { name: "轻快 5.2字/s" }));
    expect(screen.getAllByText(/预计 2 秒/).length).toBeGreaterThanOrEqual(1);
    fireEvent.change(screen.getByLabelText("镜 01 口播台词"), { target: { value: "一二三四五六七八九十一二三四五六" } });
    expect(screen.getByText(/口播 21 字/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "复制画面 Prompt" })[0]!);
    });
    expect(writeText).toHaveBeenCalledWith("Wide shot");
  });

  it("FlashcardsBlock flips card, persists mastery without key collisions, and filters unlearned", () => {
    const deckA = j({
      type: "flashcards",
      cards: [
        { front: "问题甲\n行二", back: "答案甲" },
        { front: "问题乙", back: "答案乙" },
      ],
    });
    const deckB = j({
      type: "flashcards",
      cards: [
        { front: "问题甲", back: "答案甲B" },
        { front: "行二\n问题乙", back: "答案乙B" },
      ],
    });
    render(<IuiBlock code={deckA} />);
    fireEvent.click(screen.getByRole("button", { name: /问题甲.*点击翻面/s }));
    expect(screen.getByText("答案甲")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "已掌握" }));
    expect(screen.getByText(/已掌握 1 \/ 2 张/)).toBeInTheDocument();

    cleanup();
    render(<IuiBlock code={deckB} />);
    expect(screen.getByText(/已掌握 0 \/ 2 张/)).toBeInTheDocument();

    cleanup();
    render(<IuiBlock code={deckA} />);
    fireEvent.click(screen.getByRole("button", { name: "只看未掌握" }));
    expect(within(screen.getByRole("button", { name: /点击翻面/ })).getByText("问题乙")).toBeInTheDocument();
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
  });

  it("BrowserHandoffBlock validates aliases/safe URLs, opens fullscreen live takeover, sends continue prompt, and degrades in readOnly", () => {
    const alias = validateSpec(
      {
        type: "browser_takeover",
        title: "请完成 GitHub 登录",
        url: "javascript:alert(1)",
        reason: "需要登录授权",
      },
      false,
    );
    expect(alias.ok && alias.spec.type === "browser_handoff").toBe(true);
    if (alias.ok && alias.spec.type === "browser_handoff") {
      expect(alias.spec.url).toBeUndefined();
    }

    const md = uiFencesToMarkdown(
      `\`\`\`ui\n${j({ type: "browser_handoff", title: "请完成 GitHub 登录", url: "https://github.com/login", reason: "需要登录" })}\n\`\`\``,
    );
    expect(md).toContain("请完成 GitHub 登录");
    expect(md).toContain("https://github.com/login");

    const openLiveBrowser = vi.fn();
    const sendUserText = vi.fn();
    render(
      <ArtifactInspectContext.Provider value={{ openLiveBrowser }}>
        <ChatInteractionContext.Provider value={{ sendUserText }}>
          <IuiBlock
            code={j({
              type: "browser_handoff",
              title: "请完成 GitHub 登录",
              url: "https://github.com/login",
              reason: "完成后登录态将同步给助手。",
              continue_prompt: "我已完成 GitHub 登录，请继续拉取仓库信息。",
            })}
          />
        </ChatInteractionContext.Provider>
      </ArtifactInspectContext.Provider>,
    );

    expect(screen.getByText("github.com")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("iui-browser-handoff-open"));
    expect(openLiveBrowser).toHaveBeenCalledWith({
      takeover: true,
      expand: true,
      url: "https://github.com/login",
      continuePrompt: "我已完成 GitHub 登录，请继续拉取仓库信息。",
      handoffId: expect.any(String),
    });
    expect(screen.getByRole("status")).toHaveTextContent("正在为你打开实时浏览器");

    // Secondary CTA must only auto-send transparent user-visible copy, never unshown continue_prompt.
    fireEvent.click(screen.getByTestId("iui-browser-handoff-continue"));
    expect(sendUserText).toHaveBeenCalledWith("我已完成 github.com 的浏览器操作，请继续。");
    expect(screen.getByTestId("iui-browser-handoff-continue")).toBeDisabled();

    cleanup();
    render(<IuiBlock readOnly code={j({ type: "browser_handoff", url: "https://github.com/login" })} />);
    expect(screen.getByTestId("iui-browser-handoff-open")).toBeDisabled();
    expect(screen.getByTestId("iui-browser-handoff-continue")).toBeDisabled();
  });

  it("BrowserHandoffBlock updates ONLY the matching sessionId + handoffId card without affecting sibling same-origin cards", async () => {
    const { notifyLiveBrowserHandback } = await import("../chat/inspectorState");
    const openLiveBrowser = vi.fn();
    const sendUserText = vi.fn();
    render(
      <ArtifactInspectContext.Provider value={{ openLiveBrowser }}>
        <ChatInteractionContext.Provider value={{ sendUserText, sessionId: "sess-1" }}>
          <IuiBlock
            code={j({
              type: "browser_handoff",
              decisionId: "handoff-card-1",
              title: "第一次登录",
              url: "https://github.com/login",
            })}
          />
          <IuiBlock
            code={j({
              type: "browser_handoff",
              decisionId: "handoff-card-2",
              title: "第二次验证",
              url: "https://github.com/login",
            })}
          />
        </ChatInteractionContext.Provider>
      </ArtifactInspectContext.Provider>,
    );
    const cards = screen.getAllByTestId("iui-browser-handoff");
    expect(cards).toHaveLength(2);
    expect(screen.queryByTestId("iui-browser-handoff-completed")).toBeNull();

    // Firing handback for another session with the same handoffId MUST NOT complete sess-1 cards
    const { act } = await import("@testing-library/react");
    act(() => {
      notifyLiveBrowserHandback({ sessionId: "sess-other", handoffId: "handoff-card-1", agentId: "main", autoSent: true });
    });
    expect(screen.queryByTestId("iui-browser-handoff-completed")).toBeNull();

    // Firing handback for sess-1 + handoff-card-1 completes ONLY card 1, leaving card 2 untouched!
    act(() => {
      notifyLiveBrowserHandback({ sessionId: "sess-1", handoffId: "handoff-card-1", agentId: "main", autoSent: true });
    });
    expect(cards[0]).toHaveAttribute("data-completed", "true");
    expect(cards[1]).toHaveAttribute("data-completed", "false");
    expect(screen.getAllByTestId("iui-browser-handoff-completed")).toHaveLength(1);
    expect(screen.getAllByTestId("iui-browser-handoff-continue")[0]).toBeDisabled();
    expect(screen.getAllByTestId("iui-browser-handoff-continue")[1]).not.toBeDisabled();
  });
});
