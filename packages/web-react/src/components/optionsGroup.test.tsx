// t-839 杂项 P3 · optionsGroup 多题聚合状态机(OG-01 ~ OG-07)。
// 用真实 OptionsBlock + Provider + Footer 组合,断言的是用户可见结果:发不发、页脚在不在、文案说什么。
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";
import { OptionsBlock } from "./RichBlocks";
import {
  OptionsGroupFooter,
  OptionsGroupProvider,
  createOptionsGroupStore,
  isOptionsGrouped,
} from "./optionsGroup";
import { ChatInteractionContext } from "./tool/context";

const q1 = JSON.stringify({ question: "风格?", options: [{ label: "正式" }, { label: "轻松" }] });
const q2 = JSON.stringify({ question: "输出?", multi: true, options: [{ label: "要点" }, { label: "全文" }] });
const q3 = JSON.stringify({ question: "复核?", options: [{ label: "需要" }, { label: "不需要" }] });

afterEach(cleanup);

function Group({
  live,
  busy,
  sendUserText,
  blocks,
}: {
  live?: boolean;
  busy?: boolean;
  sendUserText?: (t: string) => void;
  blocks: string[];
}) {
  return (
    <ChatInteractionContext.Provider value={{ sendUserText, busy }}>
      <OptionsGroupProvider live={live}>
        {blocks.map((code, i) => (
          <OptionsBlock key={`${i}-${code.length}`} code={code} />
        ))}
        <OptionsGroupFooter />
      </OptionsGroupProvider>
    </ChatInteractionContext.Provider>
  );
}

describe("isOptionsGrouped / store.grouped(口径单一权威)", () => {
  it("≥2 块、流式期、或已有未发送点选 → 聚合;非流式单块无点选 → 非聚合", () => {
    expect(isOptionsGrouped(1, false, 0)).toBe(false);
    expect(isOptionsGrouped(2, false, 0)).toBe(true);
    expect(isOptionsGrouped(1, true, 0)).toBe(true);
    expect(isOptionsGrouped(1, false, 1)).toBe(true);
    expect(isOptionsGrouped(0, false, 0)).toBe(false);
  });

  it("快照 grouped 随注册 / 点选 / live 变化同步更新", () => {
    const store = createOptionsGroupStore(true);
    expect(store.getSnapshot().grouped).toBe(true);
    store.setLive(false);
    expect(store.getSnapshot().grouped).toBe(false);
    store.register("a", { multi: false });
    expect(store.getSnapshot().grouped).toBe(false);
    store.setAnswer("a", ["x"]);
    expect(store.getSnapshot().grouped).toBe(true);
    store.register("b", { multi: false });
    store.setAnswer("a", []);
    expect(store.getSnapshot().grouped).toBe(true);
    store.markSent();
    store.setAnswer("b", ["y"]);
    expect(store.getSnapshot().answered).toBe(0);
  });
});

describe("OG-01 注册在 layout effect:首帧点选就走聚合,不隐式发送", () => {
  it("三题消息挂载后立刻点第一题:不发送、页脚计数 1/3、该块显示「已选(可在下方发送选择)」", () => {
    const sendUserText = vi.fn();
    render(<Group sendUserText={sendUserText} blocks={[q1, q2, q3]} />);
    // 不等任何 effect 刷新,commit 后的第一次交互就点
    fireEvent.click(screen.getByText("正式"));
    expect(sendUserText).not.toHaveBeenCalled();
    expect(screen.getByText(/已作答/).textContent).toMatch(/1\s*\/\s*3/);
    expect(screen.getByText(/可在下方发送选择/)).toBeInTheDocument();
    expect(screen.queryByText(/^已选择:/)).toBeNull();
  });
});

describe("OG-02 流式期点选后流式结束(单块):页脚留着、点选不丢、显式发送一次", () => {
  it("live → false 后页脚仍在,点「发送选择」发聚合文本,再点选项不会二次发送", () => {
    const sendUserText = vi.fn();
    const { rerender } = render(<Group live sendUserText={sendUserText} blocks={[q1]} />);
    fireEvent.click(screen.getByText("轻松"));
    expect(sendUserText).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "发送选择" })).toBeEnabled();

    rerender(<Group live={false} sendUserText={sendUserText} blocks={[q1]} />);
    // 修复前:页脚随 live=false 消失,点选凭空丢失,块退回「点击即发」
    const sendBtn = screen.getByRole("button", { name: "发送选择" });
    expect(sendBtn).toBeEnabled();
    expect(screen.getByText(/已选:轻松/)).toBeInTheDocument();
    fireEvent.click(sendBtn);
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(sendUserText.mock.calls[0][0]).toContain("风格?:轻松");
    fireEvent.click(screen.getByText("正式"));
    expect(sendUserText).toHaveBeenCalledTimes(1);
  });

  it("流式期没点过、流式结束的单块:回到点击即发,不留页脚(既有行为不变)", () => {
    const sendUserText = vi.fn();
    const { rerender } = render(<Group live sendUserText={sendUserText} blocks={[q1]} />);
    expect(screen.getByRole("button", { name: "发送选择" })).toBeDisabled();
    rerender(<Group live={false} sendUserText={sendUserText} blocks={[q1]} />);
    expect(screen.queryByRole("button", { name: "发送选择" })).toBeNull();
    fireEvent.click(screen.getByText("正式"));
    expect(sendUserText).toHaveBeenCalledWith("我选择:正式");
  });
});

describe("OG-02 根因:经真 Markdown 渲染时 caret/live 翻转不得重挂载 options 块", () => {
  const fenced = `先定一件事：\n\n\`\`\`options\n${q1}\n\`\`\`\n`;

  it("流式期点选 → 流式结束(caret/live 同时翻转):点选与页脚保留,再由用户显式发送", async () => {
    const sendUserText = vi.fn();
    const view = (live: boolean) => (
      <ChatInteractionContext.Provider value={{ sendUserText, busy: live }}>
        <OptionsGroupProvider live={live}>
          <Markdown caret={live}>{fenced}</Markdown>
          <OptionsGroupFooter />
        </OptionsGroupProvider>
      </ChatInteractionContext.Provider>
    );
    const { rerender } = render(view(true));
    fireEvent.click(await screen.findByText("轻松"));
    expect(sendUserText).not.toHaveBeenCalled();
    expect(screen.getByText(/已作答/).textContent).toMatch(/1\s*\/\s*1/);

    const pickedBtn = screen.getByText("轻松").closest("button");
    rerender(view(false));
    // 修复前:MarkdownImpl 每次渲染新造 components 函数 → OptionsBlock 被卸载重挂,点选与注册全丢
    expect(await screen.findByText(/已选:轻松/)).toBeInTheDocument();
    // 直接断言实例未重挂:同一个 DOM 节点还在文档里(重挂会造出新节点)
    expect(screen.getByText("轻松").closest("button")).toBe(pickedBtn);
    expect(document.body.contains(pickedBtn)).toBe(true);
    const sendBtn = screen.getByRole("button", { name: "发送选择" });
    expect(sendBtn).toBeEnabled();
    fireEvent.click(sendBtn);
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(sendUserText.mock.calls[0][0]).toContain("风格?:轻松");
  });
});

describe("OG-03 / OG-07 页脚文案如实反映未答题", () => {
  it("部分作答时提示未答题数;发送后说明「N 题未答,已一并标注」而非笼统「全部」", () => {
    const sendUserText = vi.fn();
    render(<Group sendUserText={sendUserText} blocks={[q1, q2, q3]} />);
    expect(screen.getByText(/每题点选后一次性发送/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("正式"));
    expect(screen.getByText(/未答的 2 题会标为「未答」一并发出/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送选择" }));
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(sendUserText.mock.calls[0][0]).toContain("输出?:(未答)");
    const done = screen.getByText(/已发送全部选择/);
    expect(done.textContent).toContain("2 题未答，已一并标注");
  });

  it("全部作答后发送:仍是「已发送全部选择。」(既有用例契约)", () => {
    const sendUserText = vi.fn();
    render(<Group sendUserText={sendUserText} blocks={[q1, q3]} />);
    fireEvent.click(screen.getByText("正式"));
    fireEvent.click(screen.getByText("需要"));
    expect(screen.queryByText(/会标为「未答」/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "发送选择" }));
    expect(screen.getByText("已发送全部选择。")).toBeInTheDocument();
  });
});

describe("OG-04 / OG-06 页脚可达性", () => {
  it("计数是 live region;非流式 busy 时发送键禁用并说明原因", () => {
    const sendUserText = vi.fn();
    const { rerender } = render(<Group sendUserText={sendUserText} blocks={[q1, q2]} />);
    const status = screen.getByText(/已作答/);
    expect(status.tagName.toLowerCase()).toBe("output");
    expect(status).toHaveAttribute("aria-live", "polite");
    fireEvent.click(screen.getByText("正式"));
    rerender(<Group busy sendUserText={sendUserText} blocks={[q1, q2]} />);
    const sendBtn = screen.getByRole("button", { name: "发送选择" });
    expect(sendBtn).toBeDisabled();
    expect(sendBtn).toHaveAttribute("title", "等待当前回合结束后可发送");
    expect(screen.getByText(/等待当前回合结束后可发送/)).toBeInTheDocument();
    // 发送键走 Button 原语:触屏 44px 兜底类名在
    expect(sendBtn.className).toContain("min-h-11");
  });

  it("只读 / 无 sendUserText(demo、教程回放)不渲染页脚", () => {
    render(<Group blocks={[q1, q2]} />);
    expect(screen.queryByRole("button", { name: "发送选择" })).toBeNull();
    expect(screen.queryByText(/已作答/)).toBeNull();
  });
});
