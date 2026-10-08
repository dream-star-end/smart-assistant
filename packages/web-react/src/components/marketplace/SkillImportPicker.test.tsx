import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SkillImportPicker } from "./SkillImportPicker";

afterEach(cleanup);
const skills = Array.from({ length: 317 }, (_, i) => ({
  name: `skill-${i}`,
  description: `用途说明 ${i} ${"很长的说明".repeat(100)}`,
  tags: i === 316 ? ["最后一项"] : [],
}));

test("317 项技能默认收起，不占据发布表单；展开才挂载可解析面板", () => {
  render(<SkillImportPicker skills={skills} importing={null} onSelect={() => {}} />);
  const toggle = screen.getByRole("button", { name: "选择已有技能" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).not.toHaveAttribute("aria-controls");
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  fireEvent.click(toggle);
  expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /^导入 / })).toHaveLength(50);
  fireEvent.click(screen.getByRole("button", { name: /显示更多/ }));
  expect(screen.getAllByRole("button", { name: /^导入 / })).toHaveLength(100);
});

test("搜索包含未加载项的名称、说明、标签；选中保持原始技能身份", () => {
  const select = vi.fn();
  render(<SkillImportPicker skills={skills} importing={null} onSelect={select} />);
  fireEvent.click(screen.getByRole("button", { name: "选择已有技能" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "最后一项" } });
  const option = screen.getByRole("button", { name: "导入 skill-316" });
  expect(screen.getAllByRole("button", { name: /^导入 / })).toHaveLength(1);
  expect(option).toHaveAccessibleDescription(skills[316].description);
  fireEvent.click(option);
  expect(select).toHaveBeenCalledWith(skills[316]);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "不存在" } });
  expect(screen.getByRole("status")).toHaveTextContent("没有找到匹配的技能");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "SKILL-316" } });
  expect(screen.getByRole("button", { name: "导入 skill-316" })).toBeInTheDocument();
});

test("导入进行时禁止重复选取，完成后恢复选择", () => {
  const select = vi.fn();
  const { rerender } = render(<SkillImportPicker skills={skills.slice(0, 2)} importing="skill-0" onSelect={select} />);
  fireEvent.click(screen.getByRole("button", { name: "选择已有技能" }));
  const option = screen.getByRole("button", { name: "导入 skill-1" });
  expect(option).toBeDisabled();
  fireEvent.click(option);
  expect(select).not.toHaveBeenCalled();
  rerender(<SkillImportPicker skills={skills.slice(0, 2)} importing={null} onSelect={select} />);
  expect(option).toBeEnabled();
});
