import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Button } from "./Button";
import { Field } from "./Field";
import { IconButton } from "./IconButton";
import { Input } from "./Input";
import { Select } from "./Select";
import { Switch } from "./Switch";
import { Textarea } from "./Textarea";

afterEach(cleanup);

test("Button loading: disabled + aria-busy + spinner + 忙态视觉压过 disabled 视觉", () => {
  const onClick = vi.fn();
  const { container } = render(
    <Button loading variant="primary" onClick={onClick}>
      保存
    </Button>,
  );
  const btn = screen.getByRole("button", { name: "保存" });
  expect(btn).toBeDisabled();
  expect(btn).toHaveAttribute("aria-busy", "true");
  expect(btn).toHaveTextContent("保存"); // 文案保留,不换成"处理中"
  expect(container.querySelector("svg.animate-spin")).toBeTruthy();
  expect(btn.className).toContain("cursor-wait");
  expect(btn.className).toContain("disabled:opacity-80");
  expect(btn.className).not.toContain("disabled:opacity-50");
  expect(btn.className).toContain("disabled:pointer-events-auto");
  expect(btn.className).not.toContain("disabled:pointer-events-none");
  fireEvent.click(btn);
  expect(onClick).not.toHaveBeenCalled();
});

test("Button 默认不落 aria-busy / 不带忙态类(向后兼容)", () => {
  const { container } = render(<Button>提交</Button>);
  const btn = screen.getByRole("button", { name: "提交" });
  expect(btn).not.toHaveAttribute("aria-busy");
  expect(btn).not.toBeDisabled();
  expect(btn.className).toContain("disabled:opacity-50");
  expect(btn.className).toContain("[@media(hover:none)]:min-h-11");
  expect(container.querySelector("svg")).toBeNull();
});

test("Button disabled 仍然禁用,且非忙态", () => {
  render(<Button disabled>x</Button>);
  const btn = screen.getByRole("button");
  expect(btn).toBeDisabled();
  expect(btn).not.toHaveAttribute("aria-busy");
});

test("IconButton 四档都带触控靶", () => {
  for (const size of ["xs", "sm", "md", "lg"] as const) {
    cleanup();
    render(
      <IconButton size={size} aria-label={`i-${size}`}>
        <span>i</span>
      </IconButton>,
    );
    expect(screen.getByRole("button").className).toContain("[@media(hover:none)]:size-11");
  }
});

test("IconButton 调用方重复补触控靶不产生重复类(twMerge 去重)", () => {
  render(
    <IconButton aria-label="关闭" className="[@media(hover:none)]:size-11">
      <span>x</span>
    </IconButton>,
  );
  const cls = screen.getByRole("button").className;
  expect(cls.match(/\[@media\(hover:none\)\]:size-11/g)?.length).toBe(1);
});

test("Input: 控件边框 + focus-visible 环 + inputSize 默认 md", () => {
  const { rerender } = render(<Input placeholder="p" />);
  const el = screen.getByPlaceholderText("p");
  expect(el.className).toContain("border-border-control");
  expect(el.className).not.toContain("border-border ");
  expect(el.className).toContain("focus-visible:ring-2");
  expect(el.className).not.toContain("focus:ring-2");
  expect(el.className).toContain("focus:border-accent");
  expect(el.className).toContain("h-10");
  expect(el.className).toContain("text-base");
  expect(el.className).toContain("md:text-sm");
  rerender(<Input placeholder="p" inputSize="sm" />);
  expect(screen.getByPlaceholderText("p").className).toContain("h-9");
  expect(screen.getByPlaceholderText("p").className).not.toContain("h-10");
});

test("Textarea 同构", () => {
  render(<Textarea placeholder="t" />);
  const el = screen.getByPlaceholderText("t");
  expect(el.className).toContain("border-border-control");
  expect(el.className).toContain("focus-visible:ring-2");
  expect(el.className).toContain("resize-none");
  expect(el.className).toContain("py-2.5");
});

test("Switch 触控靶伪元素", () => {
  render(<Switch aria-label="sw" />);
  const cls = screen.getByRole("switch").className;
  expect(cls).toContain("h-6"); // 视觉轨道不变粗
  expect(cls).toContain("[@media(hover:none)]:relative");
  expect(cls).toContain("[@media(hover:none)]:before:absolute");
  expect(cls).toContain("[@media(hover:none)]:before:-inset-y-2.5");
});

test("Select: 受控 + placeholder + 选项 disabled + 与 Input 同构", () => {
  const onValueChange = vi.fn();
  render(
    <Select
      aria-label="模型"
      value=""
      onValueChange={onValueChange}
      placeholder="请选择"
      options={[
        { value: "a", label: "甲" },
        { value: "b", label: "乙", disabled: true },
      ]}
    />,
  );
  const el = screen.getByRole("combobox", { name: "模型" });
  expect((el as HTMLSelectElement).value).toBe("");
  expect(screen.getByRole("option", { name: "请选择" })).toBeDisabled();
  expect(screen.getByRole("option", { name: "乙" })).toBeDisabled();
  expect(el.className).toContain("border-border-control");
  expect(el.className).toContain("appearance-none");
  expect(el.className).toContain("pr-9");
  expect(el.className).toContain("h-10");
  expect(el.className).toContain("[@media(hover:none)]:min-h-11");
  fireEvent.change(el, { target: { value: "a" } });
  expect(onValueChange).toHaveBeenCalledWith("a");
});

test("Field 自动接 label / describedby / invalid / required", () => {
  render(
    <Field label="邮箱" hint="用于登录" error="格式不对" required>
      <Input placeholder="e" />
    </Field>,
  );
  const input = screen.getByPlaceholderText("e");
  const label = screen.getByText("邮箱");
  expect(label.tagName).toBe("LABEL");
  expect(label.getAttribute("for")).toBe(input.id);
  expect(input.id).toBeTruthy();
  const described = (input.getAttribute("aria-describedby") ?? "").split(" ");
  expect(described).toHaveLength(2);
  for (const id of described) expect(document.getElementById(id)).toBeTruthy();
  expect(document.getElementById(described[0])?.textContent).toBe("用于登录");
  expect(document.getElementById(described[1])?.textContent).toBe("格式不对");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAttribute("aria-required", "true");
  expect(label.className).toContain("text-meta");
  expect(document.getElementById(described[1])?.className).toContain("text-danger");
});

test("Field 不覆盖调用方已给的 id / describedby / invalid", () => {
  render(
    <Field label="名称" hint="h">
      <Input id="my-id" aria-describedby="outer" aria-invalid={false} placeholder="n" />
    </Field>,
  );
  const input = screen.getByPlaceholderText("n");
  expect(input.id).toBe("my-id");
  expect(screen.getByText("名称").getAttribute("for")).toBe("my-id");
  expect(input.getAttribute("aria-describedby")).toMatch(/^outer .+-hint$/);
  expect(input).toHaveAttribute("aria-invalid", "false");
});

test("Field 无 hint/error 时不产生悬空 describedby", () => {
  render(
    <Field label="仅标签">
      <Input placeholder="q" />
    </Field>,
  );
  expect(screen.getByPlaceholderText("q")).not.toHaveAttribute("aria-describedby");
  expect(screen.getByPlaceholderText("q")).not.toHaveAttribute("aria-invalid");
});

test("Field + Select 也能自动连线", () => {
  render(
    <Field label="通道" htmlFor="ch">
      <Select id="ch" value="a" onValueChange={() => {}} options={[{ value: "a", label: "甲" }]} />
    </Field>,
  );
  expect(screen.getByLabelText("通道").tagName).toBe("SELECT");
});
