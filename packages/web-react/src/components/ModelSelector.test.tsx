import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { PublicModel } from "../lib/types";
import { ModelSelector, modelLabel, teamEngineLabel } from "./ModelSelector";

// 本仓 vitest 未开 globals 自动 cleanup,显式隔离每个用例的 DOM。
afterEach(cleanup);

const MODELS: PublicModel[] = [
  { id: "glm-5.2", display_name: "GLM-5.2" },
  { id: "deepseek-v4", display_name: "DeepSeek-V4" },
  { id: "gpt-5.5", display_name: "GPT-5.5" },
];

/** radix DropdownMenu Trigger 在 pointerdown 开启(click 不够),jsdom 里直接发。 */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("ModelSelector 团队模式诚信显示", () => {
  it("常态：触发器显示用户自选模型（display_name 权威）", () => {
    render(<ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} />);
    const trigger = screen.getByRole("button", { name: "选择对话模型" });
    expect(trigger.textContent).toContain("GLM-5.2");
    expect(trigger.textContent).not.toContain("团队模式");
  });

  it("团队态：触发器如实显示实际生效的队长引擎，而非用户自选模型", () => {
    render(
      <ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} teamEngineActive />,
    );
    const trigger = screen.getByRole("button", { name: "选择对话模型" });
    expect(trigger.textContent).toContain("团队模式 · GPT-5.5");
    expect(trigger.textContent).not.toContain("GLM-5.2");
  });

  it("团队态：菜单含不可选说明态（非 menuitem），自选模型保留选中记忆并标注生效时机", async () => {
    render(
      <ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} teamEngineActive />,
    );
    openMenu(screen.getByRole("button", { name: "选择对话模型" }));

    // 说明态存在且不可选（role=note,不在 menuitem 集合里）
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("团队模式 · 队长引擎 GPT-5.5");
    expect(note.textContent).toContain("团队模式关闭后生效");
    const items = screen.getAllByRole("menuitem");
    expect(items.some((i) => i.contains(note))).toBe(false);

    // 用户自选模型仍是列表里的选中项（记忆保留）,并带"关闭后生效"标注
    const selectedItem = items.find((i) => i.textContent?.includes("GLM-5.2"));
    expect(selectedItem).toBeTruthy();
    expect(selectedItem?.textContent).toContain("团队模式关闭后生效");
    // 未选中项不带该标注
    const otherItem = items.find((i) => i.textContent?.includes("DeepSeek-V4"));
    expect(otherItem?.textContent).not.toContain("团队模式关闭后生效");
  });

  it("常态：菜单不渲染团队说明态", async () => {
    render(<ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={() => {}} />);
    openMenu(screen.getByRole("button", { name: "选择对话模型" }));
    await screen.findAllByRole("menuitem");
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText(/队长引擎/)).toBeNull();
  });

  it("团队态：模型仍可选择（onSelect 照常上抛,作为关闭团队模式后的记忆）", async () => {
    const onSelect = vi.fn();
    render(
      <ModelSelector models={MODELS} selectedId="glm-5.2" onSelect={onSelect} teamEngineActive />,
    );
    openMenu(screen.getByRole("button", { name: "选择对话模型" }));
    const items = await screen.findAllByRole("menuitem");
    const target = items.find((i) => i.textContent?.includes("DeepSeek-V4"));
    expect(target).toBeTruthy();
    if (target) fireEvent.click(target);
    expect(onSelect).toHaveBeenCalledWith("deepseek-v4");
  });

  it("teamEngineLabel：优先取 /api/public/models 里 gpt-5.5 的 display_name,缺失退回固定标签", () => {
    expect(teamEngineLabel(MODELS)).toBe("GPT-5.5");
    expect(teamEngineLabel([{ id: "gpt-5.5", display_name: "GPT 5.5 旗舰" }])).toBe("GPT 5.5 旗舰");
    expect(teamEngineLabel([{ id: "glm-5.2" }])).toBe("GPT-5.5");
    expect(modelLabel({ id: "x" })).toBe("x");
  });
});

describe("ModelSelector provider 健康度降级(0108)", () => {
  const DEG_MODELS: PublicModel[] = [
    { id: "glm-5.2", display_name: "GLM-5.2", degraded: true },
    { id: "deepseek-v4", display_name: "DeepSeek-V4" },
    { id: "gpt-5.5", display_name: "GPT-5.5" },
  ];

  it("degraded 模型显示「暂不可用」徽记且禁选(aria-disabled)", async () => {
    render(<ModelSelector models={DEG_MODELS} selectedId="deepseek-v4" onSelect={() => {}} />);
    openMenu(screen.getByRole("button", { name: "选择对话模型" }));
    const items = await screen.findAllByRole("menuitem");
    const deg = items.find((i) => i.textContent?.includes("GLM-5.2"));
    expect(deg).toBeTruthy();
    expect(deg?.textContent).toContain("暂不可用");
    expect(deg?.getAttribute("aria-disabled")).toBe("true");
    // 非降级模型不带徽记
    const ok = items.find((i) => i.textContent?.includes("DeepSeek-V4"));
    expect(ok?.textContent).not.toContain("暂不可用");
  });

  it("degraded 模型点击不触发 onSelect(禁选)", async () => {
    const onSelect = vi.fn();
    render(<ModelSelector models={DEG_MODELS} selectedId="deepseek-v4" onSelect={onSelect} />);
    openMenu(screen.getByRole("button", { name: "选择对话模型" }));
    const items = await screen.findAllByRole("menuitem");
    const deg = items.find((i) => i.textContent?.includes("GLM-5.2"));
    if (deg) fireEvent.click(deg);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("已选模型 degraded → 菜单顶部提示条建议换模", async () => {
    render(<ModelSelector models={DEG_MODELS} selectedId="glm-5.2" onSelect={() => {}} />);
    openMenu(screen.getByRole("button", { name: "选择对话模型" }));
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("当前模型暂不可用");
    expect(note.textContent).toContain("建议改用下方可用模型");
  });

  it("已选模型健康 → 无降级提示条", async () => {
    render(<ModelSelector models={DEG_MODELS} selectedId="deepseek-v4" onSelect={() => {}} />);
    openMenu(screen.getByRole("button", { name: "选择对话模型" }));
    await screen.findAllByRole("menuitem");
    expect(screen.queryByRole("note")).toBeNull();
  });
});
