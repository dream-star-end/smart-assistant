import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BRAND } from "../lib/brand";
import { Composer, ENV_PREP_EXPECTED_MS, SWARM_PLACEHOLDER } from "./Composer";
import { ToastProvider } from "./ui";

afterEach(cleanup);

// C-01 / C-14:此前 4 个 44px 按钮与 textarea 同排,390px 下正文只剩约 138px;桌面多行草稿时左侧空出一列。
describe("Composer 两行式布局", () => {
  test("textarea 独占第一行(父级不含任何按钮、通栏 w-full),工具按钮全部在第二行", () => {
    render(
      <Composer
        onSend={() => {}}
        onUpload={async () => ({ kind: "file", url: "/x" })}
        onOpenRepo={() => {}}
        onSetGoal={vi.fn()}
        onGoalAction={vi.fn()}
      />,
    );
    const textarea = screen.getByLabelText("消息输入框");
    const inputRow = screen.getByTestId("composer-input-row");
    expect(inputRow).toContainElement(textarea);
    expect(inputRow.querySelectorAll("button, label, [role='button']")).toHaveLength(0);
    expect(textarea).toHaveClass("w-full");
    const toolRow = screen.getByTestId("composer-tool-row");
    for (const el of [
      screen.getByTitle("添加附件"),
      screen.getByRole("button", { name: "更多选项" }),
      screen.getByRole("button", { name: "语音输入" }),
      screen.getByRole("button", { name: "发送" }),
    ]) {
      expect(toolRow).toContainElement(el);
    }
    // 工具行在输入行之后(视觉上位于下方)。
    expect(inputRow.compareDocumentPosition(toolRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 已彻底消灭 <640px 独立底部悬浮废行 composer-repo-slot-mobile。
    expect(screen.queryByTestId("composer-repo-slot-mobile")).toBeNull();
    // 未绑定仓库且无项目时：顶部微上下文条不占位；桌面 sm+ 工具行保留无框轻量入口，移动端收敛进「+」菜单。
    expect(screen.queryByTestId("composer-context-bar")).toBeNull();
    expect(screen.getAllByRole("button", { name: "关联 GitHub 仓库" })).toHaveLength(1);
    expect(screen.getByTestId("composer-repo-slot")).toHaveClass("hidden", "sm:flex");
    expect(toolRow).toContainElement(screen.getByTestId("composer-repo-slot"));
    // 守住 <768px 16px (text-base) 防 iOS 缩放红线。
    expect(textarea).toHaveClass("text-base", "md:text-sm");
  });

  test("已绑定仓库或项目时在卡片顶部微上下文条展示紧凑 chips，且未绑定仓库可通过「+」菜单触发", () => {
    const onOpenRepo = vi.fn();
    const { rerender } = render(
      <Composer
        onSend={() => {}}
        onOpenRepo={onOpenRepo}
        onSetGoal={vi.fn()}
        onGoalAction={vi.fn()}
      />,
    );
    const plusBtn = screen.getByRole("button", { name: "更多选项" });
    fireEvent.pointerDown(plusBtn, { button: 0, pointerType: "mouse" });
    fireEvent.click(plusBtn);
    const menuRepo = screen.getByTestId("composer-menu-repo");
    expect(menuRepo).toHaveTextContent("关联 GitHub 仓库");
    fireEvent.click(menuRepo);
    expect(onOpenRepo).toHaveBeenCalledTimes(1);

    rerender(
      <Composer
        onSend={() => {}}
        onOpenRepo={onOpenRepo}
        repoSelection={{
          selected: true,
          owner: "acme",
          repo: "openclaude",
          branch: "main",
          status: "ready",
          selection_version: 1,
        }}
        projectSlot={<span data-testid="fake-project">项目 A</span>}
      />,
    );
    const contextBar = screen.getByTestId("composer-context-bar");
    const shell = screen.getByTestId("composer-shell");
    expect(shell).toContainElement(contextBar);
    expect(contextBar).toContainElement(screen.getByTestId("fake-project"));
    expect(contextBar).toContainElement(screen.getByTestId("composer-repo-slot"));
    expect(screen.getByTestId("composer-tool-row")).not.toContainElement(screen.getByTestId("composer-repo-slot"));
    expect(screen.queryByTestId("composer-repo-slot-mobile")).toBeNull();
  });

  test("品牌名来自 lib/brand,不写死(M-16)", () => {
    render(<Composer onSend={() => {}} />);
    expect(screen.getByPlaceholderText(`给${BRAND.name}发消息…`)).toBeInTheDocument();
  });
});

// C-23:引用块只能点「×」取消;全局 Esc 被「停止生成」占用,只在不生成时于输入框内接管。
describe("Composer Esc 取消引用", () => {
  const replyTo = { messageId: "m1", role: "assistant" as const, text: "被引用的回答" };

  test("textarea 内按 Esc 取消引用;生成中不拦截", () => {
    const onCancelReply = vi.fn();
    const { rerender } = render(<Composer onSend={() => {}} replyTo={replyTo} onCancelReply={onCancelReply} />);
    fireEvent.keyDown(screen.getByLabelText("消息输入框"), { key: "Escape" });
    expect(onCancelReply).toHaveBeenCalledTimes(1);
    rerender(<Composer busy onSend={() => {}} onStop={() => {}} replyTo={replyTo} onCancelReply={onCancelReply} />);
    fireEvent.keyDown(screen.getByLabelText("消息输入框"), { key: "Escape" });
    expect(onCancelReply).toHaveBeenCalledTimes(1);
  });

  test("无引用时 Esc 不报错也不调用", () => {
    const onCancelReply = vi.fn();
    render(<Composer onSend={() => {}} onCancelReply={onCancelReply} />);
    fireEvent.keyDown(screen.getByLabelText("消息输入框"), { key: "Escape" });
    expect(onCancelReply).not.toHaveBeenCalled();
  });
});

// C-21:草稿超过 20KB 只留内存、刷新即丢,此前没有任何预警。
describe("Composer 草稿超限预警", () => {
  afterEach(() => sessionStorage.clear());

  test("超过 sessionStorage 上限时显示「草稿过长，刷新后不保留」;未超限不显示", () => {
    render(<Composer onSend={() => {}} draftKey="s-long" />);
    const ta = screen.getByLabelText("消息输入框");
    fireEvent.change(ta, { target: { value: "a".repeat(3000) } });
    expect(screen.queryByTestId("composer-draft-volatile")).toBeNull();
    // 7000 个汉字 ≈ 21KB > 20KB。
    fireEvent.change(ta, { target: { value: "啊".repeat(7000) } });
    expect(screen.getByTestId("composer-draft-volatile")).toHaveTextContent("草稿过长，刷新后不保留");
    expect(sessionStorage.getItem("oc_v5_composer_draft:s-long")).toBeNull();
  });

  test("无 draftKey(不持久化)时不提示", () => {
    render(<Composer onSend={() => {}} />);
    fireEvent.change(screen.getByLabelText("消息输入框"), { target: { value: "啊".repeat(7000) } });
    expect(screen.queryByTestId("composer-draft-volatile")).toBeNull();
  });
});

// C-20:不支持 MediaRecorder / 未登录时麦克风只是灰掉,触屏没有 title,用户不知道为什么。
describe("Composer 语音不可用原因", () => {
  test("jsdom 无 MediaRecorder → 麦克风 aria-disabled 但可点,点击 toast 说明原因", () => {
    render(
      <ToastProvider>
        <Composer onSend={() => {}} getVoiceToken={() => "tok"} />
      </ToastProvider>,
    );
    const mic = screen.getByRole("button", { name: "语音输入" });
    expect(mic).toHaveAttribute("aria-disabled", "true");
    expect(mic).not.toBeDisabled();
    fireEvent.click(mic);
    expect(screen.getByRole("status")).toHaveTextContent("不支持语音输入");
    // 不支持时不渲染语音状态 live region(voiceEnabled=false)。
    expect(screen.queryByTestId("composer-voice-status")).toBeNull();
  });
});

describe("Composer 控件边框 token", () => {
  test("外壳使用悬浮输入坞工艺类 oc-composer-dock，不用浮层 --shadow-float 或分隔线 border-border", () => {
    render(<Composer onSend={() => {}} />);
    // OCV5-822:外壳收敛为共享材质类 oc-composer-dock（内含双层景深、发丝高光与 focus-within 暖光晕）。
    const shell = screen.getByTestId("composer-shell");
    expect(shell.className).toContain("oc-composer-dock");
    expect(shell.className).not.toContain("--shadow-float");
    expect(shell?.className).not.toMatch(/(?:^|\s)border-border(?:\s|$)/);
  });
});

describe("Composer environment preparing", () => {
  afterEach(() => vi.useRealTimers());

  test("shows a 20s prep progress in the input area", () => {
    render(<Composer onSend={() => {}} environmentPreparing />);
    expect(screen.getByRole("status")).toHaveTextContent("环境准备中，约 20 秒");
  });

  test("hides the prep progress by default", () => {
    render(<Composer onSend={() => {}} />);
    expect(screen.queryByText(/环境准备中/)).toBeNull();
  });

  // C-09:20s 时间假进度走到 100% 后停住、文案仍是「约 20 秒」,慢路径上给的是失真信号。
  test("超过 20s 后切为不确定态:文案改「仍在准备」,进度条脉动而不是停在 100%", () => {
    vi.useFakeTimers();
    render(<Composer onSend={() => {}} environmentPreparing />);
    const bar = screen.getByTestId("composer-env-prep");
    expect(bar).toHaveAttribute("data-overdue", "false");
    act(() => {
      vi.advanceTimersByTime(ENV_PREP_EXPECTED_MS + 400);
    });
    expect(bar).toHaveAttribute("data-overdue", "true");
    expect(bar).toHaveTextContent("仍在准备环境，请稍候…");
    expect(bar).not.toHaveTextContent("约 20 秒");
    expect(bar.querySelector(".animate-pulse")).not.toBeNull();
  });
});

// C-02:生成中 Composer 唯一按钮是「停止」,桌面 Enter 排队无反馈、触屏 Enter=换行根本没有排队入口。
describe("Composer 生成中排队发送", () => {
  test("busy 且有正文 → 出现「排队发送」并调用 onSend,「停止」仍是唯一 Stop 控件", () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(
      <ToastProvider>
        <Composer busy onSend={onSend} onStop={onStop} />
      </ToastProvider>,
    );
    expect(screen.queryByRole("button", { name: "排队发送" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "生成中先排上这一条" } });
    const queue = screen.getByRole("button", { name: "排队发送" });
    expect(screen.getAllByRole("button", { name: "停止" })).toHaveLength(1);
    fireEvent.click(queue);
    expect(onSend).toHaveBeenCalledWith("生成中先排上这一条", undefined, undefined);
    expect(onStop).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent("已加入队列，本轮结束后发送");
  });

  test("onSend 返回 false(如软确认选了「先不发」)→ 不提示已入队,草稿保留", async () => {
    const onSend = vi.fn(async () => false);
    render(
      <ToastProvider>
        <Composer busy onSend={onSend} onStop={() => {}} />
      </ToastProvider>,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "继续" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "排队发送" }));
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox")).toHaveValue("继续");
    expect(screen.queryByText("已加入队列，本轮结束后发送")).toBeNull();
  });

  test("busy 但空正文 / stopping 态不出现排队按钮", () => {
    const { rerender } = render(<Composer busy onSend={() => {}} onStop={() => {}} />);
    expect(screen.queryByRole("button", { name: "排队发送" })).toBeNull();
    rerender(<Composer busy stopping onSend={() => {}} onStop={() => {}} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
    expect(screen.queryByRole("button", { name: "排队发送" })).toBeNull();
  });
});

describe("Composer Stop ownership", () => {
  test("the composer is the sole active Stop control", () => {
    const onStop = vi.fn();
    render(<Composer busy onSend={() => {}} onStop={onStop} />);

    const stop = screen.getByRole("button", { name: "停止" });
    expect(screen.getAllByRole("button", { name: "停止" })).toHaveLength(1);
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("an in-flight Stop stays on the same control and cannot be submitted twice", () => {
    const onStop = vi.fn();
    render(<Composer busy stopping onSend={() => {}} onStop={onStop} />);

    const stopping = screen.getByRole("button", { name: "正在停止" });
    expect(stopping).toBeDisabled();
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    fireEvent.click(stopping);
    expect(onStop).not.toHaveBeenCalled();
  });

  test("stopping 态渲染可见「正在停止…」文案", () => {
    render(<Composer busy stopping onSend={() => {}} onStop={() => {}} />);
    expect(screen.getByText("正在停止…")).toBeInTheDocument();
  });
});

describe("Composer 输入无障碍", () => {
  test("textarea 可用消息输入框标签取到", () => {
    render(<Composer onSend={() => {}} />);
    expect(screen.getByLabelText("消息输入框")).toBeInTheDocument();
  });
});

describe("Composer ↑ 拉上一条用户消息", () => {
  test("空输入框按 ArrowUp 填入 lastUserText", () => {
    render(<Composer onSend={() => {}} lastUserText="上一句用户消息" />);
    const ta = screen.getByLabelText("消息输入框");
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(ta).toHaveValue("上一句用户消息");
  });

  test("非空输入框按 ArrowUp 不改动", () => {
    render(<Composer onSend={() => {}} lastUserText="上一句用户消息" />);
    const ta = screen.getByLabelText("消息输入框");
    fireEvent.change(ta, { target: { value: "正在写" } });
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(ta).toHaveValue("正在写");
  });
});

describe("Composer 草稿持久化", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.useRealTimers();
  });

  test("预置 sessionStorage 后挂载带 draftKey 的 Composer，textarea 还原草稿", () => {
    sessionStorage.setItem("oc_v5_composer_draft:s1", "未发送的草稿");
    render(<Composer onSend={() => {}} draftKey="s1" />);
    expect(screen.getByLabelText("消息输入框")).toHaveValue("未发送的草稿");
  });

  test("输入后 300ms 内 sessionStorage 有值", () => {
    vi.useFakeTimers();
    render(<Composer onSend={() => {}} draftKey="s1" />);
    fireEvent.change(screen.getByLabelText("消息输入框"), { target: { value: "正在输入" } });
    vi.advanceTimersByTime(300);
    expect(sessionStorage.getItem("oc_v5_composer_draft:s1")).toBe("正在输入");
  });
});

describe("Composer 拖拽上传", () => {
  function fileDt(file?: File, types: string[] = ["Files"]) {
    const files = file ? [file] : [];
    return {
      types,
      files,
      dropEffect: "none",
      items: [],
    };
  }

  test("drop 含 File 的 dataTransfer 后附件列表出现文件名", async () => {
    const onUpload = vi.fn(async () => ({ kind: "file" as const, url: "/api/media/note.txt" }));
    render(<Composer onSend={() => {}} onUpload={onUpload} />);
    const shell = screen.getByTestId("composer-shell");
    const file = new File(["hello"], "drop-note.txt", { type: "text/plain" });
    fireEvent.drop(shell as Element, { dataTransfer: fileDt(file) });
    await waitFor(() => expect(screen.getByText("drop-note.txt")).toBeInTheDocument());
  });

  test("dragover 含 Files 时根容器出现高亮 class；拖纯文本不高亮", () => {
    const onUpload = vi.fn(async () => ({ kind: "file" as const, url: "/x" }));
    render(<Composer onSend={() => {}} onUpload={onUpload} />);
    const shell = screen.getByTestId("composer-shell");
    fireEvent.dragOver(shell, { dataTransfer: fileDt(undefined, ["Files"]) });
    expect(shell.className).toContain("ring-2");
    expect(shell.className).toContain("ring-ring");
    fireEvent.dragLeave(shell, { dataTransfer: fileDt(undefined, ["Files"]) });
    expect(shell.className).not.toContain("ring-2");
    fireEvent.dragOver(shell, { dataTransfer: fileDt(undefined, ["text/plain"]) });
    expect(shell.className).not.toContain("ring-2");
  });
});

describe("Composer sendKey", () => {
  test("sendKey=mod-enter 时 Enter 不发送，⌘+Enter 发送", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} sendKey="mod-enter" />);
    const textarea = screen.getByLabelText("消息输入框");
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("hello", undefined, undefined);
  });
});

describe("Composer 长文字数", () => {
  test("超过 2000 字时工具条显示字数", () => {
    render(<Composer onSend={() => {}} />);
    expect(screen.queryByText(/字$/)).toBeNull();
    fireEvent.change(screen.getByLabelText("消息输入框"), { target: { value: "啊".repeat(2001) } });
    expect(screen.getByText("2001 字")).toBeInTheDocument();
  });

  test("不超过 2000 字不显示字数", () => {
    render(<Composer onSend={() => {}} />);
    fireEvent.change(screen.getByLabelText("消息输入框"), { target: { value: "啊".repeat(2000) } });
    expect(screen.queryByText("2000 字")).toBeNull();
  });
});

describe("Composer goalOpenRequest", () => {
  test("nonce 变化打开 GoalDialog", async () => {
    const { rerender } = render(
      <Composer onSend={() => {}} onSetGoal={vi.fn()} onGoalAction={vi.fn()} />,
    );
    expect(screen.queryByPlaceholderText("这次会话要达成什么？")).toBeNull();
    rerender(
      <Composer onSend={() => {}} onSetGoal={vi.fn()} onGoalAction={vi.fn()} goalOpenRequest={1} />,
    );
    expect(await screen.findByPlaceholderText("这次会话要达成什么？")).toBeInTheDocument();
    expect(screen.getByText("会话目标")).toBeInTheDocument();
  });
});

describe("OCV5-817 Composer prefill append / slash menu / stopping indicator", () => {
  test("prefill.mode === 'append' 保留现有草稿并以空行追加，不静默覆盖", () => {
    const { rerender } = render(<Composer onSend={() => {}} />);
    const textarea = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "我已写的草稿" } });
    rerender(
      <Composer
        onSend={() => {}}
        prefill={{ text: "> 引用的要点", nonce: 1, mode: "append" }}
      />,
    );
    expect(textarea.value).toBe("我已写的草稿\n\n> 引用的要点");
  });

  test("行首输入 / 弹出 Slash 命令补全菜单，回车补全 /btw", () => {
    render(<Composer onSend={() => {}} onQuickAskCommand={vi.fn()} />);
    const textarea = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/b" } });
    expect(screen.getByTestId("composer-slash-menu")).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("/btw ");
  });

  test("stopping 为 true 时展示可见的「正在停止…」状态提示", () => {
    render(<Composer onSend={() => {}} busy stopping onStop={vi.fn()} />);
    expect(screen.getByTestId("composer-stopping-status")).toHaveTextContent("正在停止");
  });
});

describe("OCV5-831 Composer 蜂群占位符单行化与视觉重心", () => {
  test("swarmMode 开启时展示紧凑单行占位文案，未开启时回落默认品牌文案", () => {
    const { rerender } = render(<Composer onSend={() => {}} swarmSupported swarmMode />);
    const ta = screen.getByLabelText("消息输入框");
    expect(ta).toHaveAttribute("placeholder", SWARM_PLACEHOLDER);
    expect(SWARM_PLACEHOLDER.length).toBeLessThanOrEqual(22);

    rerender(<Composer onSend={() => {}} swarmSupported swarmMode={false} />);
    expect(ta).toHaveAttribute("placeholder", `给${BRAND.name}发消息…`);
  });

  test("蜂群开关与发送/停止按钮具备清晰主次对比：激活暖陶土软底描边、未激活轻盈无框、发送钮随状态切换高光工艺类", () => {
    const { rerender } = render(
      <Composer onSend={() => {}} swarmSupported swarmMode={false} onToggleSwarmMode={vi.fn()} />,
    );
    const swarmBtn = screen.getByTestId("composer-swarm-toggle");
    const shell = screen.getByTestId("composer-shell");
    expect(shell).not.toHaveAttribute("data-swarm");
    expect(swarmBtn).toHaveClass("border-transparent", "text-muted", "oc-spring-press");
    expect(swarmBtn).not.toHaveClass("bg-accent-soft", "oc-breathe-aura");

    const ta = screen.getByLabelText("消息输入框");
    fireEvent.change(ta, { target: { value: "写一个计划" } });
    expect(screen.getByRole("button", { name: "发送" })).toHaveClass(
      "oc-btn-primary-craft",
      "oc-shimmer-sheen",
      "oc-spring-press",
      "oc-icon-nudge",
      "text-primary-fg",
    );

    rerender(<Composer onSend={() => {}} swarmSupported swarmMode onToggleSwarmMode={vi.fn()} />);
    expect(shell).toHaveAttribute("data-swarm", "true");
    expect(swarmBtn).toHaveClass("bg-accent-soft", "text-accent", "border-accent/30", "oc-breathe-aura");
    expect(screen.getByRole("button", { name: "发送" })).toHaveClass(
      "oc-btn-accent-craft",
      "oc-shimmer-sheen",
      "text-accent-fg",
    );

    rerender(<Composer onSend={() => {}} busy onStop={vi.fn()} swarmSupported swarmMode onToggleSwarmMode={vi.fn()} />);
    expect(screen.getByRole("button", { name: "停止" })).toHaveClass("oc-btn-primary-craft", "text-primary-fg");
  });
});
