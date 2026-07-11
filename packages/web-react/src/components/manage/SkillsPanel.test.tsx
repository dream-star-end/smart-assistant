import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../lib/api";
import type { AuthSession, SkillDetail, SkillSummary } from "../../lib/types";
import { SkillsPanel } from "./SkillsPanel";

const auth = {
  getToken: () => "tok",
  setToken: () => {},
  onExpired: () => {},
} as AuthSession;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// 四类技能覆盖徽章可见性矩阵:自建无 evals(显示)/自建有 evals(不显示)/只读/市场 hub。
const SKILLS: SkillSummary[] = [
  { name: "写作助手", writable: true, layer: "shared", agentIds: [] },
  { name: "翻译助手", writable: true, layer: "shared", agentIds: [] },
  { name: "只读技能", writable: false, layer: "shared", agentIds: [] },
  { name: "市场技能", writable: false, layer: "hub", agentIds: [] },
];

/** getSkillEvals 桩:仅「翻译助手」有评测用例,其余无。 */
function evalsFor(name: string): Awaited<ReturnType<typeof api.getSkillEvals>> {
  const hasCases = name === "翻译助手";
  return {
    writable: true,
    evals: hasCases ? { version: 1, cases: [{ id: "c1", prompt: "p", assertions: ["a"] }] } : null,
    lastRun: null,
  };
}

/** 装配 SkillsPanel + 全部依赖桩;返回 getSkillEvals spy 供断言探测行为。 */
function mountPanel() {
  vi.spyOn(api, "getPublicModels").mockResolvedValue([]);
  vi.spyOn(api, "listSkills").mockResolvedValue(SKILLS);
  vi.spyOn(api, "listMyAgents").mockResolvedValue([]);
  vi.spyOn(api, "getSkill").mockImplementation(
    async (_a, name) =>
      ({
        name,
        writable: SKILLS.find((s) => s.name === name)?.writable,
        layer: "shared",
        body: "技能正文",
        files: [],
      }) as SkillDetail,
  );
  const evals = vi.spyOn(api, "getSkillEvals").mockImplementation(async (_a, name) => evalsFor(name));
  render(<SkillsPanel auth={auth} />);
  return { evals };
}

/** 展开某技能行(点技能名触发行内 toggle 按钮)。 */
async function expandRow(name: string) {
  fireEvent.click(await screen.findByText(name));
}

describe("SkillsPanel 未配评测提示点", () => {
  test("自建可写技能且无评测用例:展开后页签栏出现「未配评测」提示点", async () => {
    mountPanel();
    await expandRow("写作助手");
    expect(await screen.findByRole("button", { name: /未配评测/ })).toBeInTheDocument();
  });

  test("自建技能已有评测用例:不显示提示点", async () => {
    const { evals } = mountPanel();
    await expandRow("翻译助手");
    // 展开完成(评测页签出现)且已探测过 → hasEvals=true → 无徽章。
    await screen.findByRole("button", { name: "评测" });
    await waitFor(() => expect(evals).toHaveBeenCalledWith(auth, "翻译助手"));
    expect(screen.queryByRole("button", { name: /未配评测/ })).not.toBeInTheDocument();
  });

  test("只读技能:展开后不显示提示点,也不探测评测", async () => {
    const { evals } = mountPanel();
    await expandRow("只读技能");
    await screen.findByRole("button", { name: "评测" });
    expect(screen.queryByRole("button", { name: /未配评测/ })).not.toBeInTheDocument();
    expect(evals).not.toHaveBeenCalledWith(auth, "只读技能");
  });

  test("市场(hub)技能:展开后不显示提示点,也不探测评测", async () => {
    const { evals } = mountPanel();
    await expandRow("市场技能");
    await screen.findByRole("button", { name: "评测" });
    expect(screen.queryByRole("button", { name: /未配评测/ })).not.toBeInTheDocument();
    expect(evals).not.toHaveBeenCalledWith(auth, "市场技能");
  });

  test("点击「未配评测」提示点 → 切到评测页签,提示点随之消失", async () => {
    mountPanel();
    await expandRow("写作助手");
    fireEvent.click(await screen.findByRole("button", { name: /未配评测/ }));
    // 评测分区渲染其空态(自建技能给出 AI 生成入口)。
    expect(await screen.findByText(/还没有评测用例/)).toBeInTheDocument();
    // 已在评测页签 → 提示点不再显示(section==='evals')。
    expect(screen.queryByRole("button", { name: /未配评测/ })).not.toBeInTheDocument();
  });
});
