import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../lib/api";
import { createMemoryAuthSession } from "../../lib/authSession";
import type { AuthSession, SkillDetail, SkillSummary } from "../../lib/types";
import { SkillsPanel } from "./SkillsPanel";

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

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
function mountPanel(opts: { skills?: SkillSummary[]; onOpenMarketplace?: () => void } = {}) {
  vi.spyOn(api, "getPublicModels").mockResolvedValue([]);
  vi.spyOn(api, "listSkills").mockResolvedValue(opts.skills ?? SKILLS);
  vi.spyOn(api, "listMyAgents").mockResolvedValue([]);
  vi.spyOn(api, "getSkillHistory").mockResolvedValue({ history: [], writable: true });
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
  render(<SkillsPanel auth={auth} onOpenMarketplace={opts.onOpenMarketplace} />);
  return { evals };
}

/** 展开某技能行(点技能名触发行内 toggle 按钮)。 */
async function expandRow(name: string) {
  fireEvent.click(await screen.findByText(name));
}

describe("SkillsPanel 加载 / 空态 / 出口", () => {
  test("首次加载失败不显示假空态，可原地重试后显示真实空态", async () => {
    vi.spyOn(api, "getPublicModels").mockResolvedValue([]);
    const listSkills = vi
      .spyOn(api, "listSkills")
      .mockRejectedValueOnce(new Error("backend unavailable"))
      .mockResolvedValueOnce([]);
    vi.spyOn(api, "listMyAgents").mockResolvedValue([]);

    render(<SkillsPanel auth={auth} />);

    expect(await screen.findByText("加载技能失败")).toBeInTheDocument();
    expect(screen.queryByText("还没有技能")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("还没有技能")).toBeInTheDocument();
    await waitFor(() => expect(listSkills).toHaveBeenCalledTimes(2));
  });

  test("空态给出可点的市场入口(不再是一句没有出口的说明)", async () => {
    const onOpenMarketplace = vi.fn();
    mountPanel({ skills: [], onOpenMarketplace });

    fireEvent.click(await screen.findByRole("button", { name: "去市场安装技能" }));
    expect(onOpenMarketplace).toHaveBeenCalledTimes(1);
  });

  test("搜索无结果:走空态并给「清除筛选」出口", async () => {
    mountPanel();
    await screen.findByText("写作助手");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz-不存在" } });

    expect(await screen.findByText("没有匹配的技能")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(await screen.findByText("写作助手")).toBeInTheDocument();
  });
});

describe("SkillsPanel 来源可辨与只读语义", () => {
  test("自建 / 市场安装分组呈现,组头带计数", async () => {
    mountPanel();
    expect(await screen.findByText("自建（3）")).toBeInTheDocument();
    expect(screen.getByText("市场安装（1）")).toBeInTheDocument();
  });

  test("只读技能行尾是「查看」而不是「编辑」(点了改不了 = 点了没有预期反应)", async () => {
    mountPanel();
    expect(await screen.findByRole("button", { name: "查看 只读技能" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑 写作助手" })).toBeInTheDocument();
    // 只读技能不给删除入口。
    expect(screen.queryByRole("button", { name: "删除 只读技能" })).not.toBeInTheDocument();
  });
});

describe("SkillsPanel 未配评测提示", () => {
  test("自建可写技能且无评测用例:展开后出现「未配评测」入口", async () => {
    mountPanel();
    await expandRow("写作助手");
    expect(await screen.findByRole("button", { name: /未配评测/ })).toBeInTheDocument();
  });

  test("自建技能已有评测用例:不显示提示", async () => {
    const { evals } = mountPanel();
    await expandRow("翻译助手");
    // 展开完成(工作台入口出现)且已探测过 → hasEvals=true → 无提示。
    await screen.findAllByRole("button", { name: /在工作台中打开/ });
    await waitFor(() => expect(evals).toHaveBeenCalledWith(auth, "翻译助手"));
    expect(screen.queryByRole("button", { name: /未配评测/ })).not.toBeInTheDocument();
  });

  test("只读技能:展开后不显示提示,也不探测评测", async () => {
    const { evals } = mountPanel();
    await expandRow("只读技能");
    await screen.findAllByRole("button", { name: /在工作台中打开/ });
    expect(screen.queryByRole("button", { name: /未配评测/ })).not.toBeInTheDocument();
    expect(evals).not.toHaveBeenCalledWith(auth, "只读技能");
  });

  test("市场(hub)技能:展开后不显示提示,也不探测评测", async () => {
    const { evals } = mountPanel();
    await expandRow("市场技能");
    await screen.findAllByRole("button", { name: /在工作台中打开/ });
    expect(screen.queryByRole("button", { name: /未配评测/ })).not.toBeInTheDocument();
    expect(evals).not.toHaveBeenCalledWith(auth, "市场技能");
  });

  test("点「未配评测」→ 直接打开技能工作台并落在「评测」页签", async () => {
    mountPanel();
    await expandRow("写作助手");
    fireEvent.click(await screen.findByRole("button", { name: /未配评测/ }));

    expect(await screen.findByText("技能工作台:写作助手")).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "评测" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

describe("SkillsPanel 行内预览只做轻量摘要", () => {
  test("正文只给前 20 行 + 「在工作台中打开」,不再把评测/训练塞进行手风琴", async () => {
    vi.spyOn(api, "getPublicModels").mockResolvedValue([]);
    vi.spyOn(api, "listSkills").mockResolvedValue([SKILLS[0]]);
    vi.spyOn(api, "listMyAgents").mockResolvedValue([]);
    vi.spyOn(api, "getSkillEvals").mockImplementation(async (_a, name) => evalsFor(name));
    vi.spyOn(api, "getSkill").mockResolvedValue({
      name: "写作助手",
      writable: true,
      layer: "shared",
      body: Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行`).join("\n"),
      files: [],
    } as SkillDetail);

    render(<SkillsPanel auth={auth} />);
    await expandRow("写作助手");

    expect(await screen.findByText(/仅显示前 20 行,共 30 行/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /在工作台中打开/ })).toBeInTheDocument();
    // 评测 / 训练优化不再是行内二级页签。
    expect(screen.queryByRole("button", { name: "评测" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "训练优化" })).not.toBeInTheDocument();
  });

  test("正文加载失败:行内 Alert 带「重试」,不再是一行裸红字", async () => {
    vi.spyOn(api, "getPublicModels").mockResolvedValue([]);
    vi.spyOn(api, "listSkills").mockResolvedValue([SKILLS[0]]);
    vi.spyOn(api, "listMyAgents").mockResolvedValue([]);
    vi.spyOn(api, "getSkillEvals").mockImplementation(async (_a, name) => evalsFor(name));
    const getSkill = vi
      .spyOn(api, "getSkill")
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce({
        name: "写作助手",
        writable: true,
        layer: "shared",
        body: "技能正文",
        files: [],
      } as SkillDetail);

    render(<SkillsPanel auth={auth} />);
    await expandRow("写作助手");

    expect(await screen.findByText("加载技能正文失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(getSkill).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("技能正文")).toBeInTheDocument();
  });
});
