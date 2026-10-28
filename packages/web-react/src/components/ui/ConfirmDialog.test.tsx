import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { type ConfirmOpts, useConfirm, usePrompt, zhPunct } from "./ConfirmDialog";

afterEach(cleanup);

function ConfirmHost({ altText }: { altText?: string }) {
  const [confirm, confirmEl] = useConfirm();
  const [choice, setChoice] = useState("none");
  return (
    <>
      <p data-testid="choice">{choice}</p>
      <button
        type="button"
        onClick={() => {
          void confirm({ title: "切换模型？", confirmText: "压缩并切换", altText }).then((value) => {
            setChoice(String(value));
          });
        }}
      >
        open
      </button>
      {confirmEl}
    </>
  );
}

test("useConfirm still resolves true/false without an alt action", async () => {
  render(<ConfirmHost />);
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  fireEvent.click(await screen.findByRole("button", { name: "压缩并切换" }));
  // findByTestId 只等节点出现(choice 一开始就是 none)，必须等 promise then 落定。
  await waitFor(() => {
    expect(screen.getByTestId("choice")).toHaveTextContent("true");
  });
});

test("useConfirm exposes a direct-switch alt action", async () => {
  render(<ConfirmHost altText="直接切换" />);
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  fireEvent.click(await screen.findByRole("button", { name: "直接切换" }));
  await waitFor(() => {
    expect(screen.getByTestId("choice")).toHaveTextContent("alt");
  });
});

function OpenConfirm({ opts }: { opts: ConfirmOpts }) {
  const [confirm, confirmEl] = useConfirm();
  return (
    <>
      <button type="button" onClick={() => void confirm(opts)}>
        open
      </button>
      {confirmEl}
    </>
  );
}

// UI-SPEC §6 #29:Radix 默认把焦点给第一个可聚焦元素(标题行的 ×)。
test("危险确认打开即聚焦「取消」,回车不会误删", async () => {
  render(<OpenConfirm opts={{ title: "删除该会话？", danger: true, confirmText: "删除" }} />);
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  const cancel = await screen.findByRole("button", { name: "取消" });
  await waitFor(() => expect(cancel).toHaveFocus());
});

test("普通确认打开即聚焦主按钮", async () => {
  render(<OpenConfirm opts={{ title: "切换模型？", confirmText: "切换" }} />);
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  const ok = await screen.findByRole("button", { name: "切换" });
  await waitFor(() => expect(ok).toHaveFocus());
});

test("对话框文案统一中文标点(只改紧跟汉字的半角标点)", async () => {
  render(
    <OpenConfirm
      opts={{
        title: "解绑「飞书」?",
        body: "「周会.txt」的本地与云端记录都将删除,不可恢复。账号:a,b 12:30",
        danger: true,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  expect(await screen.findByRole("heading", { name: "解绑「飞书」？" })).toBeInTheDocument();
  expect(
    screen.getByText("「周会.txt」的本地与云端记录都将删除，不可恢复。账号：a,b 12:30"),
  ).toBeInTheDocument();
  expect(zhPunct("Delete? 好的!")).toBe("Delete? 好的！");
  expect(zhPunct(undefined)).toBeUndefined();
});

function RenameHost() {
  const [promptText, promptEl] = usePrompt();
  const [value, setValue] = useState("none");
  return (
    <>
      <p data-testid="value">{value}</p>
      <button
        type="button"
        onClick={() => {
          void promptText({ title: "重命名会话", initial: "把刚才苏州行程整理成一份清单" }).then((v) =>
            setValue(String(v)),
          );
        }}
      >
        open
      </button>
      {promptEl}
    </>
  );
}

test("重命名:输入框自动聚焦并全选,直接输入即替换", async () => {
  render(<RenameHost />);
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  const input = (await screen.findByRole("textbox")) as HTMLInputElement;
  await waitFor(() => expect(input).toHaveFocus());
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(input.value.length);
  fireEvent.change(input, { target: { value: "苏州清单" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.getByTestId("value")).toHaveTextContent("苏州清单"));
});
