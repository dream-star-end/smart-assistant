import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { ChartBlock, HtmlPreview, OptionsBlock } from "./RichBlocks";
import { ChatInteractionContext } from "./tool/context";
import { OptionsGroupFooter, OptionsGroupProvider } from "./optionsGroup";

const single = JSON.stringify({
  question: "选一个部署方式?",
  options: [
    { label: "灰度发布", desc: "先小流量" },
    { label: "全量发布" },
  ],
});

afterEach(cleanup);

describe("OptionsBlock", () => {
  it("renders question + option cards and sends on single-select click", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsBlock code={single} />
      </ChatInteractionContext.Provider>,
    );
    expect(screen.getByText("选一个部署方式?")).toBeTruthy();
    fireEvent.click(screen.getByText("灰度发布"));
    expect(sendUserText).toHaveBeenCalledWith("我选择:灰度发布");
    // 已发送后锁定,不能再点
    fireEvent.click(screen.getByText("全量发布"));
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/已选择:灰度发布/)).toBeTruthy();
  });

  it("multi-select requires confirm and joins labels", () => {
    const sendUserText = vi.fn();
    const code = JSON.stringify({
      question: "要哪些能力?",
      multi: true,
      options: [{ label: "浏览器" }, { label: "研究检索" }, { label: "网页提取" }],
    });
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsBlock code={code} />
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(screen.getByText("浏览器"));
    fireEvent.click(screen.getByText("网页提取"));
    fireEvent.click(screen.getByText(/确认选择/));
    expect(sendUserText).toHaveBeenCalledWith("我选择:浏览器、网页提取");
  });

  it("demo 演示模式:没有发送能力时说清是「演示模式仅供浏览」,而不是笼统的「不可交互」(D-08)", () => {
    render(
      <ChatInteractionContext.Provider value={{ reason: "demo" }}>
        <OptionsBlock code={single} />
      </ChatInteractionContext.Provider>,
    );
    // 选项仍以卡片呈现(演示要看得到形态),但不可点、且原因写明是演示模式。
    expect(screen.getByText("选一个部署方式?")).toBeTruthy();
    expect(screen.getByText(/演示模式仅供浏览/)).toBeTruthy();
    expect(screen.queryByText(/此会话中不可交互/)).toBeNull();
    // 一般无 provider / 无 reason 的只读情形仍是通用文案。
    cleanup();
    render(
      <ChatInteractionContext.Provider value={{}}>
        <OptionsBlock code={single} />
      </ChatInteractionContext.Provider>,
    );
    expect(screen.getByText(/此会话中不可交互/)).toBeTruthy();
    expect(screen.queryByText(/演示模式/)).toBeNull();
  });

  it("已选项勾标与「确认选择」按钮前景走 text-accent-fg,不写死白字(深色 accent 上白字 2.82:1;a11y-C)", () => {
    const code = JSON.stringify({
      question: "要哪些能力?",
      multi: true,
      options: [{ label: "浏览器" }, { label: "研究检索" }],
    });
    render(
      <ChatInteractionContext.Provider value={{ sendUserText: vi.fn() }}>
        <OptionsBlock code={code} />
      </ChatInteractionContext.Provider>,
    );
    const option = screen.getByText("浏览器").closest("button");
    expect(option).toBeTruthy();
    fireEvent.click(option as HTMLButtonElement);
    const mark = (option as HTMLButtonElement).querySelector("span.size-4");
    expect(mark).toHaveClass("bg-accent", "text-accent-fg");
    expect(mark).not.toHaveClass("text-white");
    expect(mark?.querySelector("svg")).not.toBeNull();
    expect(mark?.textContent).not.toContain("✓");
    const confirm = screen.getByText(/确认选择/).closest("button");
    expect(confirm).toHaveClass("bg-accent", "text-accent-fg");
    expect(confirm).not.toHaveClass("text-white");
  });

  it("falls back to source on invalid/partial JSON and to display-only without provider", () => {
    const { container } = render(<OptionsBlock code={'{"question":"半截'} />);
    expect(container.querySelector("pre")).toBeTruthy();
    render(<OptionsBlock code={single} />);
    expect(screen.getByText(/此会话中不可交互/)).toBeTruthy();
  });

  it("trailing junk still renders clickable option cards and keeps leftover text", () => {
    const sendUserText = vi.fn();
    const leftover = "这四条是刚才三个子任务里 typecheck 命令的回执";
    const code = single + leftover;
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsBlock code={code} />
      </ChatInteractionContext.Provider>,
    );
    expect(screen.getByText("选一个部署方式?")).toBeTruthy();
    expect(screen.getByText(leftover)).toBeTruthy();
    expect(document.querySelector("pre")).toBeNull();
    fireEvent.click(screen.getByText("灰度发布"));
    expect(sendUserText).toHaveBeenCalledWith("我选择:灰度发布");
  });

  it("keeps valid pure JSON click-to-send behavior unchanged", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsBlock code={single} />
      </ChatInteractionContext.Provider>,
    );
    expect(screen.queryByText("这四条是刚才三个子任务里 typecheck 命令的回执")).toBeNull();
    fireEvent.click(screen.getByText("全量发布"));
    expect(sendUserText).toHaveBeenCalledWith("我选择:全量发布");
  });

  it("does not truncate a label that contains a closing brace", () => {
    const sendUserText = vi.fn();
    const code = JSON.stringify({
      question: "选哪个?",
      options: [
        { label: '含}括号的选项', desc: "desc 里也有 }" },
        { label: "普通" },
      ],
    });
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsBlock code={code} />
      </ChatInteractionContext.Provider>,
    );
    expect(screen.getByText("含}括号的选项")).toBeTruthy();
    expect(screen.getByText("desc 里也有 }")).toBeTruthy();
    fireEvent.click(screen.getByText("含}括号的选项"));
    expect(sendUserText).toHaveBeenCalledWith("我选择:含}括号的选项");
  });

  it("busy disables clicking", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText, busy: true }}>
        <OptionsBlock code={single} />
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(screen.getByText("灰度发布"));
    expect(sendUserText).not.toHaveBeenCalled();
  });

  // M-12:busy 下选项只被压成 opacity-80,用户不知道为什么点不动;触屏下选项/预览按钮不够 44px。
  it("busy 时说明「等待当前回合结束后可选择」;非 busy / 已发送不出该提示", () => {
    const sendUserText = vi.fn();
    const { rerender } = render(
      <ChatInteractionContext.Provider value={{ sendUserText, busy: true }}>
        <OptionsBlock code={single} />
      </ChatInteractionContext.Provider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("等待当前回合结束后可选择");
    expect(screen.getByRole("button", { name: /灰度发布/ })).toHaveClass("[@media(hover:none)]:min-h-11");
    rerender(
      <ChatInteractionContext.Provider value={{ sendUserText, busy: false }}>
        <OptionsBlock code={single} />
      </ChatInteractionContext.Provider>,
    );
    expect(screen.queryByText("等待当前回合结束后可选择")).toBeNull();
    fireEvent.click(screen.getByText("灰度发布"));
    rerender(
      <ChatInteractionContext.Provider value={{ sendUserText, busy: true }}>
        <OptionsBlock code={single} />
      </ChatInteractionContext.Provider>,
    );
    // 已发送(锁定)的卡不再需要解释 busy。
    expect(screen.queryByText("等待当前回合结束后可选择")).toBeNull();
  });
});

describe("HtmlPreview 触控尺寸(M-12)", () => {
  it("操作行「全屏放大」「看源码」在触屏下满足 44px", () => {
    render(<HtmlPreview code="<div>hi</div>" />);
    for (const name of ["全屏放大预览", "看源码", "下载 HTML 文件", "重新运行"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("[@media(hover:none)]:min-h-11", "[@media(hover:none)]:min-w-11");
    }
  });
});

describe("OptionsBlock in a multi-question message (group mode)", () => {
  const q1 = JSON.stringify({ question: "风格?", options: [{ label: "正式" }, { label: "轻松" }] });
  const q2 = JSON.stringify({ question: "输出?", multi: true, options: [{ label: "要点" }, { label: "全文" }] });

  it("does NOT send on first click; aggregates and sends via footer after all answered", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsGroupProvider>
          <OptionsBlock code={q1} />
          <OptionsBlock code={q2} />
          <OptionsGroupFooter />
        </OptionsGroupProvider>
      </ChatInteractionContext.Provider>,
    );
    // 点第一题不发送(boss 踩坑场景)
    fireEvent.click(screen.getByText("正式"));
    expect(sendUserText).not.toHaveBeenCalled();
    expect(screen.getByText(/已作答/).textContent).toContain("1");
    // 部分作答即可发(至少 1 题)
    const sendBtn = screen.getByText("发送选择") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
    // 答第二题(多选)后仍可发
    fireEvent.click(screen.getByText("要点"));
    expect(sendBtn.disabled).toBe(false);
    fireEvent.click(sendBtn);
    expect(sendUserText).toHaveBeenCalledTimes(1);
    const sentText = sendUserText.mock.calls[0][0] as string;
    expect(sentText).toContain("风格?:正式");
    expect(sentText).toContain("输出?:要点");
    // 发送后锁定
    expect(screen.getByText(/已发送全部选择/)).toBeTruthy();
  });

  it("single block inside a group keeps click-to-send", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsGroupProvider>
          <OptionsBlock code={q1} />
          <OptionsGroupFooter />
        </OptionsGroupProvider>
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(screen.getByText("轻松"));
    expect(sendUserText).toHaveBeenCalledWith("我选择:轻松");
  });

  it("live streaming single block: clickable, no implicit send, footer submits aggregate text", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsGroupProvider live>
          <OptionsBlock code={single} />
          <OptionsGroupFooter />
        </OptionsGroupProvider>
      </ChatInteractionContext.Provider>,
    );
    const opt = screen.getByText("灰度发布").closest("button") as HTMLButtonElement;
    expect(opt.disabled).toBe(false);
    expect(opt.getAttribute("title")).toBeNull();
    expect(screen.queryByText("生成中")).toBeNull();
    fireEvent.click(opt);
    expect(sendUserText).not.toHaveBeenCalled();
    expect(opt.className).toContain("bg-accent-soft");
    expect(screen.getByText(/已作答/).textContent).toMatch(/1\s*\/\s*1/);
    const sendBtn = screen.getByText("发送选择") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
    fireEvent.click(sendBtn);
    expect(sendUserText).toHaveBeenCalledTimes(1);
    const sentText = sendUserText.mock.calls[0][0] as string;
    expect(sentText).toContain("我的选择:");
    expect(sentText).toContain("选一个部署方式?:灰度发布");
    expect(screen.getByText(/已发送全部选择/)).toBeTruthy();
    fireEvent.click(screen.getByText("全量发布"));
    expect(sendUserText).toHaveBeenCalledTimes(1);
  });

  it("live streaming multi-block: at least 1 answer can submit, unanswered marked 未答", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsGroupProvider live>
          <OptionsBlock code={q1} />
          <OptionsBlock code={q2} />
          <OptionsGroupFooter />
        </OptionsGroupProvider>
      </ChatInteractionContext.Provider>,
    );
    const opt = screen.getByText("正式").closest("button") as HTMLButtonElement;
    expect(opt.disabled).toBe(false);
    fireEvent.click(opt);
    expect(sendUserText).not.toHaveBeenCalled();
    const answered = screen.getByText(/已作答/).textContent ?? "";
    expect(answered).toContain("1");
    expect(answered).toContain("2");
    const sendBtn = screen.getByText("发送选择") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
    fireEvent.click(sendBtn);
    expect(sendUserText).toHaveBeenCalledTimes(1);
    const sentText = sendUserText.mock.calls[0][0] as string;
    expect(sentText).toContain("我的选择:");
    expect(sentText).toContain("风格?:正式");
    expect(sentText).toContain("输出?:(未答)");
    expect(screen.getByText(/已发送全部选择/)).toBeTruthy();
    fireEvent.click(screen.getByText("轻松"));
    fireEvent.click(screen.getByText("要点"));
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("发送选择")).toBeNull();
  });

  it("live streaming stays clickable even when session busy", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText, busy: true }}>
        <OptionsGroupProvider live>
          <OptionsBlock code={single} />
          <OptionsGroupFooter />
        </OptionsGroupProvider>
      </ChatInteractionContext.Provider>,
    );
    const opt = screen.getByText("灰度发布").closest("button") as HTMLButtonElement;
    expect(opt.disabled).toBe(false);
    fireEvent.click(opt);
    expect(sendUserText).not.toHaveBeenCalled();
    const sendBtn = screen.getByText("发送选择") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
    fireEvent.click(sendBtn);
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(sendUserText.mock.calls[0][0]).toContain("我的选择:");
  });

  it("partial answers can be submitted with 未答 marker and then lock", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsGroupProvider>
          <OptionsBlock code={q1} />
          <OptionsBlock code={q2} />
          <OptionsGroupFooter />
        </OptionsGroupProvider>
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(screen.getByText("正式"));
    expect(sendUserText).not.toHaveBeenCalled();
    const answered = screen.getByText(/已作答/).textContent ?? "";
    expect(answered).toContain("1");
    expect(answered).toContain("2");
    const sendBtn = screen.getByText("发送选择") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
    fireEvent.click(sendBtn);
    expect(sendUserText).toHaveBeenCalledTimes(1);
    const sentText = sendUserText.mock.calls[0][0] as string;
    expect(sentText).toContain("我的选择:");
    expect(sentText).toContain("风格?:正式");
    expect(sentText).toContain("输出?:(未答)");
    expect(screen.getByText(/已发送全部选择/)).toBeTruthy();
    fireEvent.click(screen.getByText("轻松"));
    fireEvent.click(screen.getByText("要点"));
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("发送选择")).toBeNull();
  });

  it("live with zero registered blocks does not render empty 0/0 footer", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsGroupProvider live>
          <OptionsGroupFooter />
        </OptionsGroupProvider>
      </ChatInteractionContext.Provider>,
    );
    expect(screen.queryByText("发送选择")).toBeNull();
    expect(screen.queryByText(/已作答/)).toBeNull();
    expect(sendUserText).not.toHaveBeenCalled();
  });

  it("non-streaming single block still click-to-sends 我选择:<label> with no footer (regression)", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsGroupProvider>
          <OptionsBlock code={single} />
          <OptionsGroupFooter />
        </OptionsGroupProvider>
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(screen.getByText("灰度发布"));
    expect(sendUserText).toHaveBeenCalledWith("我选择:灰度发布");
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("发送选择")).toBeNull();
    expect(screen.queryByText(/已作答/)).toBeNull();
    fireEvent.click(screen.getByText("全量发布"));
    expect(sendUserText).toHaveBeenCalledTimes(1);
  });

  it("expands top-level JSON array (#e3082ac8 case), splits em-dash descriptions, and aggregates cleanly", () => {
    const sendUserText = vi.fn();
    const arrayCode = JSON.stringify([
      {
        question: "本次功能上线范围怎么定？",
        options: [
          "(推荐) Codex 升到 0.170.0 + 同时开放 Fast 与 6.2-sol Ultrafast — 一次发车完成 CLI 升级",
          "仅把 Codex CLI 升到 0.170.0 — 只更新镜像与本地 CLI 版本",
        ],
      },
      {
        question: "如果开放加速档，平台侧对用户的积分计费倍率按多少结算？",
        options: [
          "(推荐) Fast 按 2×、Ultrafast 按 6× — 与 OpenAI 官方订阅额度消耗倍率一致",
          "暂不开放加速档（无需调整倍率）",
        ],
      },
      {
        question: "远端美区节点 cc5-us 是否一并升级？",
        options: [
          "(推荐) 一并升级主站镜像与 cc5-us — 全链路版本对齐",
          "仅升级主站容器镜像",
        ],
      },
    ]);

    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsGroupProvider>
          <OptionsBlock code={arrayCode} />
          <OptionsGroupFooter />
        </OptionsGroupProvider>
      </ChatInteractionContext.Provider>,
    );

    expect(document.querySelector("pre")).toBeNull();
    expect(screen.getByText("一次发车完成 CLI 升级")).toBeTruthy();
    expect(screen.getByText("全链路版本对齐")).toBeTruthy();

    fireEvent.click(screen.getByText("(推荐) Codex 升到 0.170.0 + 同时开放 Fast 与 6.2-sol Ultrafast"));
    expect(sendUserText).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("已作答 1 / 3 题");

    fireEvent.click(screen.getByText("(推荐) Fast 按 2×、Ultrafast 按 6×"));
    fireEvent.click(screen.getByText("(推荐) 一并升级主站镜像与 cc5-us"));
    fireEvent.click(screen.getByText("发送选择"));

    expect(sendUserText).toHaveBeenCalledTimes(1);
    const sent = sendUserText.mock.calls[0][0] as string;
    expect(sent).toContain("1. 本次功能上线范围怎么定？:(推荐) Codex 升到 0.170.0 + 同时开放 Fast 与 6.2-sol Ultrafast");
    expect(sent).toContain("2. 如果开放加速档，平台侧对用户的积分计费倍率按多少结算？:(推荐) Fast 按 2×、Ultrafast 按 6×");
    expect(sent).toContain("3. 远端美区节点 cc5-us 是否一并升级？:(推荐) 一并升级主站镜像与 cc5-us");
  });

  it("self-provides group footer for standalone array OptionsBlock and supports questions wrapper + multi-JSONL aliases", () => {
    const sendUserText = vi.fn();
    const wrapperAndJsonl = [
      JSON.stringify({
        questions: [
          {
            prompt: "选择区域",
            is_multi_select: true,
            options: [{ label: "美区", description: "cc5-us" }, { label: "亚太" }],
          },
        ],
      }),
      JSON.stringify({
        question: "是否同步重启",
        options: [{ label: "立即重启" }, { label: "稍后" }],
      }),
    ].join("\n");

    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsBlock code={wrapperAndJsonl} />
      </ChatInteractionContext.Provider>,
    );

    expect(document.querySelector("pre")).toBeNull();
    expect(screen.getByText("可多选")).toBeTruthy();
    expect(screen.getByText("cc5-us")).toBeTruthy();
    fireEvent.click(screen.getByText("美区"));
    fireEvent.click(screen.getByText("立即重启"));
    expect(sendUserText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("发送选择"));
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(sendUserText.mock.calls[0][0]).toContain("1. 选择区域:美区");
    expect(sendUserText.mock.calls[0][0]).toContain("2. 是否同步重启:立即重启");
  });

  it("renders bare top-level option arrays (#a16e52ae object list & string list) as single-question cards", () => {
    const sendUserText = vi.fn();
    const bareObjArray = JSON.stringify([
      { label: "不用改了，直接验收", description: "Ultrafast 已确认生效，维持当前线上版本" },
      { label: "顺手优化顶栏显示与兜底", description: "补齐顶栏标签与动态倍率展示" },
    ]);

    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsGroupProvider>
          <OptionsBlock code={bareObjArray} />
          <OptionsGroupFooter />
        </OptionsGroupProvider>
      </ChatInteractionContext.Provider>,
    );

    expect(document.querySelector("pre")).toBeNull();
    expect(screen.getByText("Ultrafast 已确认生效，维持当前线上版本")).toBeTruthy();
    expect(screen.queryByText("发送选择")).toBeNull();
    fireEvent.click(screen.getByText("不用改了，直接验收"));
    expect(sendUserText).toHaveBeenCalledWith("我选择:不用改了，直接验收");
  });

  it("supports bare string array, choices/title/detail/allowMultiple aliases, and falls back to <pre> on unrelated arrays", () => {
    const sendUserText = vi.fn();
    const bareStrings = JSON.stringify(["(推荐) 方案 A — 风险最低", "方案 B — 改动较大"]);
    const aliasedObj = JSON.stringify({
      header: "选部署策略",
      allowMultiple: true,
      choices: [
        { title: "灰度", detail: "先验证 10%" },
        { text: "全量", sublabel: "直接切换" },
      ],
    });
    const unrelated = JSON.stringify([{ foo: 1 }, { bar: 2 }]);

    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsBlock code={bareStrings} />
        <OptionsBlock code={aliasedObj} />
        <OptionsBlock code={unrelated} />
      </ChatInteractionContext.Provider>,
    );

    expect(screen.getByText("风险最低")).toBeTruthy();
    expect(screen.getByText("选部署策略")).toBeTruthy();
    expect(screen.getByText("先验证 10%")).toBeTruthy();
    expect(screen.getByText("直接切换")).toBeTruthy();
    expect(document.querySelector("pre")?.textContent).toContain('"foo":1');

    fireEvent.click(screen.getByText("(推荐) 方案 A"));
    expect(sendUserText).toHaveBeenCalledWith("我选择:(推荐) 方案 A");
    fireEvent.click(screen.getByText("灰度"));
    fireEvent.click(screen.getByText("全量"));
    fireEvent.click(screen.getByText(/确认选择/));
    expect(sendUserText).toHaveBeenLastCalledWith("我选择:灰度、全量");
  });
});

describe("HtmlPreview 导出", () => {
  it("RichBlocks 仍导出 HtmlPreview(实现已移到 HtmlEmbed,调用方不变)", async () => {
    const embed = await import("./HtmlEmbed");
    expect(HtmlPreview).toBe(embed.HtmlPreview);
  });
});

describe("ChartBlock 悬浮微工具条(OCV5-838)", () => {
  it("支持切换源码、复制源码与全屏放大预览", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const cfg = JSON.stringify({ type: "bar", data: { labels: ["A"], datasets: [{ data: [1] }] } });
    const { container } = render(<ChartBlock code={cfg} />);

    expect(screen.getByTestId("rich-block-toolbar")).toBeInTheDocument();
    // 切换源码
    fireEvent.click(screen.getByRole("button", { name: "查看源码" }));
    expect(container.querySelector("pre")).toHaveTextContent('"type":"bar"');
    fireEvent.click(screen.getByRole("button", { name: "查看图表" }));
    expect(container.querySelector("canvas")).not.toBeNull();

    // 一键复制
    fireEvent.click(screen.getByRole("button", { name: "复制源码" }));
    expect(writeText).toHaveBeenCalledWith(cfg);

    // 全屏放大预览
    fireEvent.click(screen.getByRole("button", { name: "全屏放大预览" }));
    expect(await screen.findByRole("dialog", { name: "图表预览" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭全屏预览" }));
    expect(screen.queryByRole("dialog", { name: "图表预览" })).toBeNull();
  });
});


