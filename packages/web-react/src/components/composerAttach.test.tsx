import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { GoalStateSnapshot } from "@openclaude/protocol/goalState";
import { AttachChip, Composer } from "./Composer";
import { ToastProvider } from "./ui";
import type { MediaRef } from "../lib/chat/frames";

afterEach(cleanup);

// onUpload 存在即 canAttach（不实际调用）。
const uploadStub = vi.fn(async () => ({}) as MediaRef);

function goalFixture(over: Partial<GoalStateSnapshot> = {}): GoalStateSnapshot {
  return {
    sessionId: "s1",
    goalId: "11111111-1111-4111-8111-111111111111",
    objective: "迁移并验证",
    status: "active",
    tokenBudget: null,
    creditBudget: null,
    tokensUsed: 0,
    creditsUsed: "0",
    timeUsedSeconds: 0,
    stateRevision: 1,
    snapshotRevision: 1,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    statusChangedAt: "2026-07-16T00:00:00.000Z",
    ...over,
  };
}

/** Radix DropdownMenu 在 jsdom 需 pointerdown 序列开菜单（对齐 App.test）。 */
function openPlusMenu(): void {
  const trigger = screen.getByRole("button", { name: "更多选项" });
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  fireEvent.click(trigger);
}

describe("F1 附件选择器可靠性（+ 菜单附件项 = 原生 <label htmlFor> 激活）", () => {
  test("附件项是 label[for]，绑定 file input：input 非 display:none、type=file、无 accept", () => {
    render(<Composer onSend={() => {}} onUpload={uploadStub} />);
    openPlusMenu();
    const label = screen.getByText("添加附件").closest("label");
    expect(label).not.toBeNull();
    const forId = label!.getAttribute("for");
    expect(forId).toBeTruthy();
    const input = document.getElementById(forId as string) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.type).toBe("file");
    // 国产内核红线：不得 display:none（用 sr-only 视觉隐藏），且不得挂 accept 白名单。
    expect(input!.className).not.toContain("hidden");
    expect(input!.className).toContain("sr-only");
    expect(input!.hasAttribute("accept")).toBe(false);
    expect(input!.getAttribute("tabindex")).toBe("-1");
  });

  test("点击附件 label 原生转发一次 click 到 file input（Radix 未吞掉默认激活）", () => {
    render(<Composer onSend={() => {}} onUpload={uploadStub} />);
    openPlusMenu();
    const label = screen.getByText("添加附件").closest("label") as HTMLLabelElement;
    const input = document.getElementById(label.getAttribute("for") as string) as HTMLInputElement;
    const clickSpy = vi.fn();
    input.addEventListener("click", clickSpy);
    fireEvent.click(label);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  /** 竞态守门（2026-07-18 生产事故回归锁）:
   *  真浏览器里 label 的原生转发是 post-dispatch activation,发生在 click 派发完成之后;
   *  Radix Item 默认 select 会在派发过程中同步关菜单卸载 Portal → label detached →
   *  htmlFor 按 tree scope 解析不到 input → 选择器不弹(真机 Chromium 实证 0 转发)。
   *  上面的"转发"测试在 jsdom 恒绿测不出(jsdom 的 label control 查找走 ownerDocument
   *  而非 root tree,detached 也能转发)——所以这里直接锁 detach 本身:
   *  点击当下 label 必须仍 connected(即 onSelect 已 preventDefault),菜单随后异步关闭。 */
  test("点击附件项后 label 在激活窗口内保持挂载（select 已拦截），菜单随后异步关闭", async () => {
    render(<Composer onSend={() => {}} onUpload={uploadStub} />);
    openPlusMenu();
    const label = screen.getByText("添加附件").closest("label") as HTMLLabelElement;
    fireEvent.click(label);
    // click 派发结束的同步时刻:label 必须还在 DOM(原生激活依赖此窗口)。
    expect(label.isConnected).toBe(true);
    // 菜单不常驻:宏任务后正常关闭。
    await waitFor(() => expect(screen.queryByText("添加附件")).toBeNull());
  });
});

describe("F2 「+」按钮闭合态目标角标", () => {
  test("有活跃目标（未近预算）→ 触发按钮显 accent 圆点", () => {
    render(<Composer onSend={() => {}} onUpload={uploadStub} goal={goalFixture()} />);
    const dot = screen.getByTestId("composer-goal-dot");
    expect(dot).toHaveClass("bg-accent");
    expect(dot).not.toHaveClass("bg-warning");
  });

  test("近预算 → 圆点转 warning 色", () => {
    render(
      <Composer
        onSend={() => {}}
        onUpload={uploadStub}
        goal={goalFixture({ tokenBudget: 100, tokensUsed: 80 })}
      />,
    );
    expect(screen.getByTestId("composer-goal-dot")).toHaveClass("bg-warning");
  });

  test("无目标 / 已清除 → 不显示角标", () => {
    const { rerender } = render(<Composer onSend={() => {}} onUpload={uploadStub} />);
    expect(screen.queryByTestId("composer-goal-dot")).toBeNull();
    rerender(
      <Composer onSend={() => {}} onUpload={uploadStub} goal={goalFixture({ status: "cleared" })} />,
    );
    expect(screen.queryByTestId("composer-goal-dot")).toBeNull();
  });
});

describe("消息引用 Composer 预览", () => {
  const replyTo = {
    messageId: "assistant-quote",
    role: "assistant" as const,
    text: "这是完整的被引用回答",
  };

  test("预览可取消且不改正文", () => {
    const onCancelReply = vi.fn();
    render(<Composer onSend={() => {}} replyTo={replyTo} onCancelReply={onCancelReply} />);
    const textarea = screen.getByPlaceholderText("给 OpenClaude 发消息…");
    fireEvent.change(textarea, { target: { value: "当前问题" } });
    expect(screen.getByText("正在引用 OpenClaude")).toBeInTheDocument();
    expect(screen.getByText(replyTo.text)).toHaveClass("line-clamp-2");
    fireEvent.click(screen.getByRole("button", { name: "取消引用" }));
    expect(onCancelReply).toHaveBeenCalledTimes(1);
    expect(textarea).toHaveValue("当前问题");
  });

  test("发送把当前正文与精确引用分别交给发送链并清除引用", () => {
    const onSend = vi.fn();
    const onCancelReply = vi.fn();
    render(<Composer onSend={onSend} replyTo={replyTo} onCancelReply={onCancelReply} />);
    fireEvent.change(screen.getByPlaceholderText("给 OpenClaude 发消息…"), {
      target: { value: "请解释这一段" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalledWith("请解释这一段", undefined, replyTo);
    expect(onCancelReply).toHaveBeenCalledTimes(1);
  });
});

describe("Composer durable queue controls", () => {
  test("busy with an empty draft keeps stop separate and send in the rightmost disabled slot", () => {
    const { container } = render(<Composer onSend={() => {}} busy onStop={() => {}} />);
    const stop = screen.getByRole("button", { name: "停止" });
    const send = screen.getByTestId("composer-send");
    expect(send).toHaveAttribute("aria-label", "排队发送");
    expect(send).toBeDisabled();
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.indexOf(stop as HTMLButtonElement)).toBeLessThan(
      buttons.indexOf(send as HTMLButtonElement),
    );
    expect(buttons.at(-1)).toBe(send);
  });

  test("busy with text sends through the queue path and renders only the service snapshot receipt", () => {
    const onSend = vi.fn();
    render(
      <Composer
        onSend={onSend}
        busy
        queuedDispatch={{ count: 2, savingCount: 0, cancellingCount: 0, canUndo: true }}
        onUndoQueuedSend={async () => ({ ok: true })}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("给 OpenClaude 发消息…"), {
      target: { value: "下一条任务" },
    });
    fireEvent.click(screen.getByRole("button", { name: "排队发送" }));
    expect(onSend).toHaveBeenCalledWith("下一条任务", undefined, undefined);
    expect(screen.getByTestId("composer-queued-notice")).toHaveTextContent(
      "已排队 2 条，本轮结束后依次发送",
    );
  });

  test("durable undo failure remains visible instead of claiming cancellation", async () => {
    render(
      <ToastProvider>
        <Composer
          onSend={() => {}}
          queuedDispatch={{ count: 1, savingCount: 0, cancellingCount: 0, canUndo: true }}
          onUndoQueuedSend={async () => ({ ok: false, reason: "delete_failed" })}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "撤销最后一条" }));
    expect(
      await screen.findByText("撤销失败，消息仍在队列里，请重试"),
    ).toBeInTheDocument();
  });

  test("submit signal sends the user's edited composer text exactly once", async () => {
    const onSend = vi.fn();
    const { rerender } = render(
      <Composer
        onSend={onSend}
        prefill={{ text: "starter original", nonce: 1 }}
        submitSignal={0}
      />,
    );
    const textarea = screen.getByPlaceholderText("给 OpenClaude 发消息…");
    await waitFor(() => expect(textarea).toHaveValue("starter original"));
    fireEvent.change(textarea, { target: { value: "用户修改后的正文" } });
    rerender(
      <Composer
        onSend={onSend}
        prefill={{ text: "starter original", nonce: 1 }}
        submitSignal={1}
      />,
    );
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("用户修改后的正文", undefined, undefined),
    );
    rerender(
      <Composer
        onSend={onSend}
        prefill={{ text: "starter original", nonce: 1 }}
        submitSignal={1}
      />,
    );
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  test("an empty confirmation is not consumed; a later valid confirmation sends", async () => {
    const onSend = vi.fn();
    const { rerender } = render(<Composer onSend={onSend} submitSignal={0} />);
    rerender(<Composer onSend={onSend} submitSignal={1} />);
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("给 OpenClaude 发消息…"), {
      target: { value: "补好正文后再发" },
    });
    rerender(<Composer onSend={onSend} submitSignal={2} />);
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("补好正文后再发", undefined, undefined),
    );
  });

  test("a disabled confirmation is not consumed; enabling and confirming again sends", async () => {
    const onSend = vi.fn();
    const prefill = { text: "等待门控放行", nonce: 1 };
    const { rerender } = render(
      <Composer onSend={onSend} disabled prefill={prefill} submitSignal={0} />,
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("给 OpenClaude 发消息…")).toHaveValue(prefill.text),
    );
    rerender(<Composer onSend={onSend} disabled prefill={prefill} submitSignal={1} />);
    expect(onSend).not.toHaveBeenCalled();

    rerender(<Composer onSend={onSend} prefill={prefill} submitSignal={2} />);
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(prefill.text, undefined, undefined),
    );
  });

  test("an uploading confirmation is not consumed; confirming after upload sends the attachment", async () => {
    let finishUpload!: (media: MediaRef) => void;
    const upload = vi.fn(
      () => new Promise<MediaRef>((resolve) => { finishUpload = resolve; }),
    );
    const onSend = vi.fn();
    const { container, rerender } = render(
      <Composer onSend={onSend} onUpload={upload} submitSignal={0} />,
    );
    const file = new File(["payload"], "queued.txt", { type: "text/plain" });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.change(screen.getByPlaceholderText("给 OpenClaude 发消息…"), {
      target: { value: "带附件发送" },
    });
    rerender(<Composer onSend={onSend} onUpload={upload} submitSignal={1} />);
    expect(onSend).not.toHaveBeenCalled();

    const media = { kind: "file" as const, url: "/api/media/queued.txt", filename: "queued.txt" };
    finishUpload(media);
    await waitFor(() => expect(screen.getByRole("button", { name: "移除 queued.txt" })).toBeEnabled());
    rerender(<Composer onSend={onSend} onUpload={upload} submitSignal={2} />);
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("带附件发送", [media], undefined),
    );
  });
});

describe("AttachChip（附件 chip 上传失败重试）", () => {
  test("error 态且持有 File + onRetry → 显示「重试」，点击回调复用重传入口", () => {
    const onRetry = vi.fn();
    render(
      <AttachChip
        a={{
          id: "att-0",
          name: "report.pdf",
          size: 1234,
          kind: "file",
          status: "error",
          error: "网络错误",
          file: new File(["x"], "report.pdf"),
        }}
        onRemove={() => {}}
        onRetry={onRetry}
      />,
    );
    const btn = screen.getByLabelText("重试上传 report.pdf");
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("上传中(uploading)态不显示「重试」（仅失败态可重试）", () => {
    render(
      <AttachChip
        a={{ id: "att-1", name: "a.txt", size: 10, kind: "file", status: "uploading" }}
        onRemove={() => {}}
      />,
    );
    expect(screen.queryByLabelText("重试上传 a.txt")).toBeNull();
  });

  test("done 态不显示「重试」", () => {
    render(
      <AttachChip
        a={{ id: "att-2", name: "b.txt", size: 20, kind: "file", status: "done" }}
        onRemove={() => {}}
      />,
    );
    expect(screen.queryByLabelText("重试上传 b.txt")).toBeNull();
  });

  test("touch devices receive a 44px remove target without changing desktop density", () => {
    render(
      <AttachChip
        a={{ id: "att-touch", name: "touch.txt", size: 10, kind: "file", status: "done" }}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "移除 touch.txt" })).toHaveClass(
      "[@media(hover:none)]:size-11",
    );
  });

  test("error 态但未传 onRetry（如无持有 File）→ 不渲染重试按钮", () => {
    render(
      <AttachChip
        a={{ id: "att-3", name: "c.txt", size: 30, kind: "file", status: "error" }}
        onRemove={() => {}}
      />,
    );
    expect(screen.queryByLabelText("重试上传 c.txt")).toBeNull();
  });
});

describe("AttachChip（对话框上传图的「编辑」入口 —— 需求 §5 可点回归）", () => {
  const imageAttach = {
    id: "img-0",
    name: "photo.png",
    size: 2048,
    kind: "image" as const,
    status: "done" as const,
    previewUrl: "blob:preview-photo",
  };

  test("已传成功的图 + onAnnotate → 渲染可点「编辑」按钮,点击回调触发", () => {
    const onAnnotate = vi.fn();
    render(<AttachChip a={imageAttach} onRemove={() => {}} onAnnotate={onAnnotate} />);
    const btn = screen.getByRole("button", { name: "编辑图片 photo.png" });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onAnnotate).toHaveBeenCalledTimes(1);
  });

  test("不可编辑(仅 annotateDisabledReason)→ 按钮渲染但禁用,原因入 title", () => {
    render(
      <AttachChip
        a={imageAttach}
        onRemove={() => {}}
        annotateDisabledReason="当前模型不支持 Image 2 圈选修改，请切换到 GPT 模型"
      />,
    );
    const btn = screen.getByRole("button", { name: "编辑图片 photo.png" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "当前模型不支持 Image 2 圈选修改，请切换到 GPT 模型");
  });
});
