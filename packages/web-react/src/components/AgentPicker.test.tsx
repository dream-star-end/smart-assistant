import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { MAIN_AGENT, agentFromApiRow } from "../lib/agents";
import { createMemoryAuthSession } from "../lib/authSession";
import type { AuthSession } from "../lib/types";

// api 网络层全 mock —— 只验证团队模式开关区块的文案与交互契约。
const listMyAgents = vi.fn();
vi.mock("../lib/api", () => ({
  api: {
    listMyAgents: (...a: unknown[]) => listMyAgents(...a),
  },
}));

import { AgentPicker } from "./AgentPicker";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

function renderPicker(
  extra: Partial<Parameters<typeof AgentPicker>[0]> = {},
  rows: unknown[] = [],
) {
  listMyAgents.mockResolvedValue(rows);
  return render(
    <AgentPicker
      open
      current={MAIN_AGENT}
      auth={auth}
      teamMode={false}
      onClose={() => {}}
      onPick={() => {}}
      onToggleTeamMode={() => {}}
      {...extra}
    />,
  );
}

describe("AgentPicker 团队模式开关文案（知情同意）", () => {
  // UI-2a 改写成人话(「由 … 带队」「分出去的部分按各自的模型计费」),知情要素不变:引擎、计费更高、分工按各自模型计费。
  it("描述明确告知：队长切换 GPT-6-Astra 引擎、计费高于默认模型、委派按对应模型计费", async () => {
    renderPicker();
    const desc = await screen.findByText(/由 GPT-6-Astra 带队/);
    expect(desc.textContent).toContain("计费高于默认模型");
    expect(desc.textContent).toContain("分出去的部分按各自的模型计费");
  });

  it("开关翻转经 onToggleTeamMode 上抛（App 的全局 flag 是唯一权威）", async () => {
    const onToggleTeamMode = vi.fn();
    renderPicker({ onToggleTeamMode });
    const sw = await screen.findByRole("switch", { name: "启用团队模式" });
    expect(sw).toHaveAttribute("data-state", "unchecked");
    fireEvent.click(sw);
    expect(onToggleTeamMode).toHaveBeenCalledWith(true);
  });

  it("teamMode 开启时开关呈选中态", async () => {
    renderPicker({ teamMode: true });
    const sw = await screen.findByRole("switch", { name: "启用团队模式" });
    expect(sw).toHaveAttribute("data-state", "checked");
  });
});

describe("AgentPicker 三态协作", () => {
  it("onCollabModeChange 时渲染单人/顾问/团队三选一", async () => {
    const onCollabModeChange = vi.fn();
    renderPicker({ onCollabModeChange, collabMode: "solo", advisorModels: [{ id: "gpt-6-astra", label: "GPT-6-Astra", engine: "codex" }] });
    const advisor = await screen.findByRole("button", { name: /主模型不变/ });
    fireEvent.click(advisor);
    expect(onCollabModeChange).toHaveBeenCalledWith("advisor");
  });

  it("点顾问只走 onCollabModeChange，不再链式 onToggleTeamMode(false) 把 App 打回 solo", async () => {
    const onCollabModeChange = vi.fn();
    const onToggleTeamMode = vi.fn();
    renderPicker({ onCollabModeChange, onToggleTeamMode, collabMode: "solo", advisorModels: [{ id: "gpt-6-astra", label: "GPT-6-Astra", engine: "codex" }] });
    fireEvent.click(await screen.findByRole("button", { name: /主模型不变/ }));
    expect(onCollabModeChange).toHaveBeenCalledTimes(1);
    expect(onCollabModeChange).toHaveBeenCalledWith("advisor");
    expect(onToggleTeamMode).not.toHaveBeenCalled();
  });

  it("非 CCB 父引擎时顾问选项 disabled，点击不切换", async () => {
    const onCollabModeChange = vi.fn();
    renderPicker({
      onCollabModeChange,
      collabMode: "solo",
      advisorConsultParents: ["ccb"],
      parentEngine: "codex",
      advisorConsultAllowed: false,
      advisorConsultParentReason: "当前模型不能向顾问提问。把顶栏模型换成 GLM 或 MiniMax 后再试。",
    });
    const advisor = await screen.findByRole("button", { name: /换成 GLM 或 MiniMax/ });
    expect(advisor).toBeDisabled();
    fireEvent.click(advisor);
    expect(onCollabModeChange).not.toHaveBeenCalled();
  });

  it("当前已选 CCB 时不因 GET allowed=false 禁用顾问", async () => {
    const onCollabModeChange = vi.fn();
    renderPicker({
      onCollabModeChange,
      collabMode: "solo",
      advisorConsultParents: ["ccb"],
      parentEngine: "ccb",
      advisorModels: [{ id: "gpt-6-astra", label: "GPT-6-Astra", engine: "codex" }],
      advisorConsultAllowed: false,
      advisorConsultParentReason: "当前模型不能向顾问提问。把顶栏模型换成 GLM 或 MiniMax 后再试。",
    });
    const advisor = await screen.findByRole("button", { name: /主模型不变/ });
    expect(advisor).not.toBeDisabled();
    fireEvent.click(advisor);
    expect(onCollabModeChange).toHaveBeenCalledWith("advisor");
  });

  it("顾问无可用型号时明示原因，不静默填 gpt-6-astra", async () => {
    renderPicker({
      onCollabModeChange: () => {},
      collabMode: "advisor",
      advisorModels: [],
      advisorUnavailableReason: "顾问引擎尚未证明无工具隔离",
    });
    // UI-2a:服务端原因是工程口径,卡片写人话,原句只留在悬停提示里。
    const shown = await screen.findAllByText(/暂时没有可用的顾问型号/);
    expect(shown.length).toBeGreaterThan(0);
    expect(screen.queryByText(/尚未证明无工具隔离/)).toBeNull();
    expect(shown.some((el) => el.getAttribute("title") === "顾问引擎尚未证明无工具隔离")).toBe(true);
    expect(screen.queryByLabelText("选择顾问型号")).toBeNull();
  });

  it("OCV5-477: 没有顾问型号时顾问置灰并写明原因，点击不发起切换", async () => {
    const onCollabModeChange = vi.fn();
    renderPicker({ onCollabModeChange, collabMode: "solo", advisorModels: [] });
    const advisor = await screen.findByRole("button", { name: /暂时没有可用的顾问型号/ });
    expect(advisor).toBeDisabled();
    fireEvent.click(advisor);
    expect(onCollabModeChange).not.toHaveBeenCalled();
  });

  it("已配置顾问不在目录时警告并保持空选，不静默显示第一项", async () => {
    const onAdvisorModelChange = vi.fn();
    renderPicker({
      onCollabModeChange: () => {},
      onAdvisorModelChange,
      collabMode: "advisor",
      advisorModel: "MiniMax-M3",
      advisorModels: [
        { id: "gpt-6-astra", label: "GPT-6-Astra", engine: "codex" },
        { id: "kimi-k2.7-code", label: "Kimi", engine: "ccb" },
      ],
    });
    expect(await screen.findByText(/MiniMax-M3 当前不可用/)).toBeInTheDocument();
    const select = screen.getByLabelText("选择顾问型号") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(select.value).not.toBe("gpt-6-astra");
    expect(onAdvisorModelChange).not.toHaveBeenCalled();
  });
});

const READINESS_ROWS = [
  {
    id: "main",
    slug: "main",
    name: "全能助手",
    description: "",
    installed: true,
    isDefault: true,
    capabilityReadiness: {
      installed: true,
      ready: true,
      requirements: [],
      needsAuthorization: [],
    },
  },
  {
    id: "research-agent",
    slug: "research-agent",
    name: "科研助手",
    description: "需要检索插件",
    installed: true,
    capabilityReadiness: {
      installed: true,
      ready: false,
      requirements: [],
      needsAuthorization: ["paper-search"],
    },
  },
];

describe("AgentPicker 默认智能体徽章", () => {
  it("「默认」徽章走实底 accent + text-accent-fg:它落在本就 accent-soft 着色的卡上,soft 叠 soft 深色只有 4.1:1、bg-accent/15 只有 3.9(a11y-C)", async () => {
    renderPicker({}, READINESS_ROWS);
    await screen.findByRole("button", { name: /科研助手/ });
    const badge = screen.getAllByText("默认").find((el) => el.classList.contains("text-micro"));
    expect(badge).toBeTruthy();
    expect(badge).toHaveClass("bg-accent", "text-accent-fg");
    expect(badge).not.toHaveClass("bg-accent/15");
    expect(badge).not.toHaveClass("bg-accent-soft");
    expect(badge).not.toHaveClass("text-white");
  });
});

describe("AgentPicker capability readiness", () => {
  // C-06:此前整卡 disabled —— 不可聚焦、读屏读不到原因、也没有任何去授权的入口。
  it("未就绪 Agent 可聚焦(aria-disabled)且读屏能拿到原因,但点击不会 onPick", async () => {
    const onPick = vi.fn();
    renderPicker({ onPick }, READINESS_ROWS);

    const agent = await screen.findByRole("button", { name: /科研助手/ });
    expect(agent).not.toBeDisabled();
    expect(agent).toHaveAttribute("aria-disabled", "true");
    expect(agent).toHaveAccessibleDescription(/1 项插件待授权/);
    expect(screen.getByText("插件待授权")).toBeInTheDocument();
    fireEvent.click(agent);
    expect(onPick).not.toHaveBeenCalled();
    // 未传 onOpenPluginAuth:只保留说明,不渲染去授权按钮。
    expect(screen.queryByRole("button", { name: /去授权/ })).toBeNull();
  });

  it("传入 onOpenPluginAuth 时渲染「去授权」,按钮与整卡点击都带着该 Agent 回调", async () => {
    const onPick = vi.fn();
    const onOpenPluginAuth = vi.fn();
    renderPicker({ onPick, onOpenPluginAuth }, READINESS_ROWS);

    const go = await screen.findByRole("button", { name: /去授权/ });
    fireEvent.click(go);
    expect(onOpenPluginAuth).toHaveBeenCalledTimes(1);
    expect(onOpenPluginAuth.mock.calls[0][0]).toMatchObject({ id: "research-agent", ready: false });
    fireEvent.click(screen.getByRole("button", { name: /科研助手/ }));
    expect(onOpenPluginAuth).toHaveBeenCalledTimes(2);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("能力待修复(无待授权插件)时按钮文案为「去处理」", async () => {
    const rows = [
      READINESS_ROWS[0],
      {
        ...READINESS_ROWS[1],
        id: "broken-agent",
        name: "待修复助手",
        capabilityReadiness: { installed: true, ready: false, requirements: [], needsAuthorization: [] },
      },
    ];
    renderPicker({ onOpenPluginAuth: vi.fn() }, rows);
    expect(await screen.findByText("能力待修复")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /去处理/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /待修复助手/ })).toHaveAccessibleDescription(/所需能力暂不可用/);
  });
});

// C-33:首次打开列表未返回前网格是空的,数据到达时卡片突然出现 —— 骨架卡占位避免跳动。
describe("AgentPicker 加载骨架", () => {
  it("读取失败保留已确认的目录并明示重试，重试成功后恢复列表", async () => {
    listMyAgents.mockRejectedValueOnce(new Error("503"));
    render(
      <AgentPicker open current={MAIN_AGENT} auth={auth}
        knownAgents={READINESS_ROWS.map(agentFromApiRow)} onClose={() => {}} onPick={() => {}} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("智能体加载失败");
    expect(screen.getByRole("button", { name: /科研助手/ })).toBeInTheDocument();
    listMyAgents.mockResolvedValueOnce([
      ...READINESS_ROWS,
      { id: "office-agent", slug: "office-agent", name: "办公助手", description: "", installed: true },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("button", { name: /办公助手/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(listMyAgents).toHaveBeenCalledTimes(2);
  });

  it("列表未返回时网格内渲染骨架(role=status 播报加载中),返回后骨架消失", async () => {
    let resolve!: (rows: unknown[]) => void;
    listMyAgents.mockReturnValue(
      new Promise<unknown[]>((r) => {
        resolve = r;
      }),
    );
    render(<AgentPicker open current={MAIN_AGENT} auth={auth} onClose={() => {}} onPick={() => {}} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("加载中…");
    // 4 张 = 官方预设数,骨架与到达后的卡片占同样行数(OCV5-639)。
    expect(status.querySelectorAll(":scope > :not(.sr-only)")).toHaveLength(4);
    resolve(READINESS_ROWS);
    expect(await screen.findByRole("button", { name: /科研助手/ })).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  // OCV5-639:预设卡异步长出来时弹层(垂直居中)整体上移,体验官点「同时设为默认」落到科研助手上。
  it("App 已拉到目录时打开即最终排版:不出骨架、上方不插提示行,后台重拉回来就地更新", async () => {
    let resolve!: (rows: unknown[]) => void;
    listMyAgents.mockReturnValue(
      new Promise<unknown[]>((r) => {
        resolve = r;
      }),
    );
    render(
      <AgentPicker
        open
        current={MAIN_AGENT}
        auth={auth}
        knownAgents={READINESS_ROWS.map(agentFromApiRow)}
        onClose={() => {}}
        onPick={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /科研助手/ })).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("加载你的智能体…")).toBeNull();
    expect(listMyAgents).toHaveBeenCalledTimes(1);
    resolve([...READINESS_ROWS, { id: "office-agent", slug: "office-agent", name: "办公助手", description: "", installed: true }]);
    expect(await screen.findByRole("button", { name: /办公助手/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /科研助手/ })).toBeInTheDocument();
  });

  // Codex r1:缓存目录里的卡可能已被卸载 / 变不可用;重拉回来前点选会立刻关窗,错选纠正不回来。
  it("重拉在途时缓存目录的卡只占位不接受点选;回来后按新目录点选", async () => {
    let resolve!: (rows: unknown[]) => void;
    listMyAgents.mockReturnValue(
      new Promise<unknown[]>((r) => {
        resolve = r;
      }),
    );
    const onPick = vi.fn();
    const office = { id: "office-agent", slug: "office-agent", name: "办公助手", description: "", installed: true };
    const coder = { id: "code-agent", slug: "code-agent", name: "编程助手", description: "", installed: true };
    render(
      <AgentPicker
        open
        current={MAIN_AGENT}
        auth={auth}
        knownAgents={[READINESS_ROWS[0], office, coder].map(agentFromApiRow)}
        onClose={() => {}}
        onPick={onPick}
      />,
    );
    const stale = screen.getByRole("button", { name: /办公助手/ });
    expect(stale).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(stale);
    expect(onPick).not.toHaveBeenCalled();
    // 服务端:办公助手已卸载,编程助手仍在。
    resolve([READINESS_ROWS[0], coder]);
    await waitFor(() => expect(screen.queryByRole("button", { name: /办公助手/ })).toBeNull());
    const fresh = screen.getByRole("button", { name: /编程助手/ });
    expect(fresh).not.toHaveAttribute("aria-disabled");
    fireEvent.click(fresh);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "code-agent" }));
  });
});
