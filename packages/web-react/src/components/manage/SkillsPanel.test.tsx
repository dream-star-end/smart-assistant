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

// 四类技能:两条自建可写 / 自建只读 / 市场 hub。
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
  vi.spyOn(api, "getPublicModels").mockResolvedValue({ models: [], lockedModels: [] });
  vi.spyOn(api, "listSkills").mockResolvedValue(opts.skills ?? SKILLS);
  vi.spyOn(api, "listMyAgents").mockResolvedValue([]);
  vi.spyOn(api, "getSkillHistory").mockResolvedValue({ history: [], writable: true });
  const list = opts.skills ?? SKILLS;
  vi.spyOn(api, "getSkill").mockImplementation(
    async (_a, name) =>
      ({
        name,
        writable: list.find((s) => s.name === name)?.writable,
        layer: list.find((s) => s.name === name)?.layer ?? "shared",
        body: "技能正文",
        files: [],
      }) as SkillDetail,
  );
  const evals = vi.spyOn(api, "getSkillEvals").mockImplementation(async (_a, name) => evalsFor(name));
  render(<SkillsPanel auth={auth} onOpenMarketplace={opts.onOpenMarketplace} />);
  return { evals };
}

describe("SkillsPanel 加载 / 空态 / 出口", () => {
  test("首次加载失败不显示假空态，可原地重试后显示真实空态", async () => {
    vi.spyOn(api, "getPublicModels").mockResolvedValue({ models: [], lockedModels: [] });
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
    // 计数是组头里单独的等宽数字(不再写进全角括号)。
    expect(await screen.findByRole("heading", { name: /^自建/ })).toHaveTextContent("自建3");
    expect(screen.getByRole("heading", { name: /^市场安装/ })).toHaveTextContent("市场安装1");
  });

  test("只读技能的行可访问名是「查看」,可写的是「打开」", async () => {
    mountPanel();
    expect(await screen.findByRole("button", { name: "查看 只读技能" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开 写作助手" })).toBeInTheDocument();
  });
});

describe("SkillsPanel 行(OCV5-360:整行一个点按目标)", () => {
  test("行面没有 编辑 / 删除 / 查看 按钮簇,也没有手风琴预览", async () => {
    mountPanel();
    await screen.findByText("写作助手");
    expect(screen.queryByRole("button", { name: /^编辑 / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^删除 / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /在工作台中打开/ })).not.toBeInTheDocument();
    // 每个技能恰好一个行按钮(4 个技能 → 4 个行按钮 + 页头无市场入口)。
    expect(screen.getAllByRole("button", { name: /^(打开|查看) / })).toHaveLength(4);
  });

  test("点行 → 打开技能工作台(标题用列表同款展示名)", async () => {
    mountPanel({
      skills: [{ name: "writer-pro", description: "帮你把草稿改成成稿\n第二行不进标题", writable: true, layer: "shared", agentIds: [] }],
    });
    fireEvent.click(await screen.findByRole("button", { name: "打开 帮你把草稿改成成稿" }));
    expect(await screen.findByRole("heading", { name: "帮你把草稿改成成稿" })).toBeInTheDocument();
  });

  test("短标题单行截断、其余描述窄屏两行 / 桌面一行(不叠 block)、slug 不上行面", async () => {
    mountPanel({
      skills: [{ name: "writer-pro", description: "帮你把草稿改成成稿\n第二行是补充说明", writable: true, layer: "shared", agentIds: [] }],
    });
    const title = await screen.findByText("帮你把草稿改成成稿");
    expect(title).toHaveClass("truncate", "font-medium");
    const desc = screen.getByText("第二行是补充说明");
    expect(desc).toHaveClass("line-clamp-2", "md:line-clamp-1", "text-muted");
    expect(desc).not.toHaveClass("block");
    expect(screen.queryByText("writer-pro")).not.toBeInTheDocument();
    expect(document.querySelector(".font-mono")).toBeNull();
  });

  test("触发句描述:第一句去掉「时使用」作短标题,其余进灰色补充行(OCV5-362 列表拥挤)", async () => {
    mountPanel({
      skills: [
        {
          name: "advisor",
          description: "设计或核验 Claude Code 风格的顾问模式时使用。先核验官方机制，再检查边界。",
          writable: true,
          layer: "shared",
          agentIds: [],
        },
      ],
    });
    expect(await screen.findByText("设计或核验 Claude Code 风格的顾问模式")).toHaveAttribute("data-skill-title");
    expect(screen.getByText("先核验官方机制，再检查边界。")).toHaveAttribute("data-skill-desc");
    expect(screen.getByRole("button", { name: "打开 设计或核验 Claude Code 风格的顾问模式" })).toBeInTheDocument();
  });

  test("搜索框写总数、不再另挂计数;筛选时才在右侧给「命中 / 总数」", async () => {
    mountPanel();
    const search = await screen.findByPlaceholderText(/^搜索 \d+ 个技能$/);
    expect(screen.queryByText(/^\d+ 个技能$/)).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "市场" } });
    expect(await screen.findByText(/^\d+ \/ \d+$/)).toBeInTheDocument();
  });

  test("元信息一行:来源 · 适用 · 前两个标签 +N", async () => {
    mountPanel({
      skills: [{ name: "tagged", description: "带很多标签", writable: true, layer: "shared", agentIds: [], tags: ["部署", "运维", "v5", "runbook", "灰度"] }],
    });
    await screen.findByText("带很多标签");
    const meta = document.querySelector("[data-skill-meta]") as HTMLElement;
    expect(meta).toHaveTextContent("自建");
    expect(meta).toHaveTextContent("#部署 #运维 +3");
    expect(meta).not.toHaveTextContent("#v5");
    expect(meta).toHaveClass("flex-nowrap");
  });

  test("删除从工作台底部发起:确认框用展示名 + slug,确认后删除并刷新列表", async () => {
    const del = vi.spyOn(api, "deleteSkill").mockResolvedValue({ ok: true });
    mountPanel({
      skills: [{ name: "writer-pro", description: "帮你把草稿改成成稿", writable: true, layer: "shared", agentIds: [] }],
    });
    fireEvent.click(await screen.findByRole("button", { name: "打开 帮你把草稿改成成稿" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除技能" }));
    expect(await screen.findByText("删除技能「帮你把草稿改成成稿」？")).toBeInTheDocument();
    expect(screen.getByText(/技能标识 writer-pro。/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(auth, "writer-pro"));
    await waitFor(() => expect(api.listSkills).toHaveBeenCalledTimes(2));
  });

  test("只读 / 市场技能的工作台没有删除入口", async () => {
    mountPanel();
    fireEvent.click(await screen.findByRole("button", { name: "查看 市场技能" }));
    await screen.findByRole("heading", { name: /市场技能/ });
    expect(screen.queryByRole("button", { name: "删除技能" })).not.toBeInTheDocument();
  });

  test("页头只有一颗紧凑的「市场」按钮", async () => {
    const onOpenMarketplace = vi.fn();
    mountPanel({ onOpenMarketplace });
    await screen.findByText("写作助手");
    const btn = screen.getByRole("button", { name: "市场" });
    fireEvent.click(btn);
    expect(onOpenMarketplace).toHaveBeenCalledTimes(1);
  });
});
