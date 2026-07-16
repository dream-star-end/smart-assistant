import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { AuthSession, MarketplaceDetail, MarketplaceMyAgent } from "../../lib/types";
import { createMemoryAuthSession } from "../../lib/authSession";

const getMarketplaceDetail = vi.fn();
const listMyAgents = vi.fn();
const installMarketplace = vi.fn();
vi.mock("../../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    getMarketplaceDetail: (...a: unknown[]) => getMarketplaceDetail(...a),
    listMyAgents: (...a: unknown[]) => listMyAgents(...a),
    installMarketplace: (...a: unknown[]) => installMarketplace(...a),
  },
}));
// 富介绍走既有 <Markdown>(懒加载真实实现)。测试里用轻量桩直出文本,避免异步 chunk flake。
vi.mock("../Markdown", () => ({
  Markdown: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));

import { DetailModal } from "./DetailModal";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

function detail(over: Partial<MarketplaceDetail> = {}): MarketplaceDetail {
  return {
    slug: "academic-translate",
    kind: "skill",
    state: "active",
    ownerUserId: "1",
    version: "1.0.0",
    versionId: "v1",
    name: "学术翻译",
    description: "一句话描述",
    tags: ["翻译"],
    artifactHash: "h",
    rawArtifact: "# SKILL\nMODEL-FACING-BODY",
    riskFlags: [],
    installCount: 3,
    category: "office-docs",
    useCases: ["把中文论文摘要翻译成地道英文", "润色英文摘要"],
    outcomeExamples: ["给中文摘要 → 得到地道英文摘要"],
    humanMd: "这是富介绍正文段落",
    ...over,
  };
}

test("详情页人向重排:适用场景 / 效果 / 详细介绍 / 分类徽章都渲染", async () => {
  getMarketplaceDetail.mockResolvedValue(detail());
  listMyAgents.mockResolvedValue([] as MarketplaceMyAgent[]);

  render(<DetailModal slug="academic-translate" auth={auth} onClose={() => {}} onInstalled={() => {}} />);

  expect(await screen.findByText("适用场景")).toBeInTheDocument();
  expect(screen.getByText("把中文论文摘要翻译成地道英文")).toBeInTheDocument();
  expect(screen.getByText("能达成什么效果")).toBeInTheDocument();
  expect(screen.getByText("给中文摘要 → 得到地道英文摘要")).toBeInTheDocument();
  expect(screen.getByText("详细介绍")).toBeInTheDocument();
  expect(screen.getByText("这是富介绍正文段落")).toBeInTheDocument();
  // 分类 label 徽章
  expect(screen.getByText("办公文档")).toBeInTheDocument();
});

test("Agent 详情展示 typed capabilities、就绪状态与 Plugin 授权入口", async () => {
  getMarketplaceDetail.mockResolvedValue(
    detail({
      slug: "research-agent",
      kind: "agent",
      name: "科研智能体",
      manifest: {
        model: "glm-5.2",
        toolsets: ["core"],
        capabilities: [
          { kind: "skill", slug: "paper-read", optional: false },
          { kind: "plugin", slug: "paper-search", optional: false },
        ],
        skillDeps: ["paper-read"],
        persona: "严谨研究",
      },
      capabilityReadiness: {
        installed: true,
        ready: false,
        needsAuthorization: ["paper-search"],
        requirements: [
          {
            kind: "skill",
            slug: "paper-read",
            optional: false,
            installed: true,
            bound: true,
            status: "ready",
          },
          {
            kind: "plugin",
            slug: "paper-search",
            optional: false,
            installed: true,
            bound: true,
            status: "needs_authorization",
          },
        ],
      },
    }),
  );
  listMyAgents.mockResolvedValue([]);
  const open = vi.fn();
  render(
    <DetailModal
      slug="research-agent"
      auth={auth}
      onClose={() => {}}
      onInstalled={() => {}}
      onOpenConnectors={open}
    />,
  );

  expect(await screen.findByText(/Skill · paper-read · 必需 · 已就绪/)).toBeInTheDocument();
  expect(screen.getByText(/Plugin · paper-search · 必需 · 待授权/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "管理 Plugin 账号" }));
  expect(open).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/不是逐智能体的插件权限隔离/)).toBeInTheDocument();
});

test("已安装 Agent 缺少必需 Skill 时提供整包修复动作", async () => {
  getMarketplaceDetail.mockResolvedValue(
    detail({
      slug: "repair-agent",
      kind: "agent",
      versionId: "agent-v1",
      name: "待修复助手",
      manifest: {
        model: "glm-5.2",
        toolsets: ["core"],
        capabilities: [{ kind: "skill", slug: "required-skill", optional: false }],
        persona: "测试",
      },
      capabilityReadiness: {
        installed: true,
        ready: false,
        needsAuthorization: [],
        requirements: [
          {
            kind: "skill",
            slug: "required-skill",
            optional: false,
            installed: false,
            bound: true,
            status: "missing",
            repairable: true,
          },
        ],
      },
    }),
  );
  listMyAgents.mockResolvedValue([]);
  installMarketplace.mockResolvedValue({
    ok: true,
    slug: "repair-agent",
    kind: "agent",
    version: "1.0.0",
    installedDeps: 1,
    installedCapabilities: [{ kind: "skill", slug: "required-skill", optional: false }],
    skippedOptional: [],
    needsAuthorization: [],
    ready: true,
    note: "repaired",
  });
  const onInstalled = vi.fn();
  render(
    <DetailModal
      slug="repair-agent"
      auth={auth}
      installed={{
        slug: "repair-agent",
        kind: "agent",
        version: "1.0.0",
        versionId: "agent-v1",
        name: "待修复助手",
        artifactHash: "agent-hash",
        installedAt: "2026-07-15T00:00:00Z",
        listingState: "active",
      }}
      onClose={() => {}}
      onInstalled={onInstalled}
    />,
  );

  const repair = await screen.findByRole("button", { name: "重新安装整包修复" });
  fireEvent.click(repair);
  expect(installMarketplace).toHaveBeenCalledWith(auth, "agent-v1", undefined);
  expect(await screen.findByText("安装成功")).toBeInTheDocument();
  expect(onInstalled).toHaveBeenCalledTimes(1);
});

test("Agent 的旧 Plugin pin 已失效时允许重装整包切到当前可信版本", async () => {
  getMarketplaceDetail.mockResolvedValue(
    detail({
      slug: "stale-plugin-agent",
      kind: "agent",
      versionId: "agent-v1",
      name: "插件待修复助手",
      manifest: {
        model: "glm-5.2",
        toolsets: ["core"],
        capabilities: [{ kind: "plugin", slug: "search-plugin", optional: false }],
        persona: "测试",
      },
      capabilityReadiness: {
        installed: true,
        ready: false,
        needsAuthorization: [],
        requirements: [
          {
            kind: "plugin",
            slug: "search-plugin",
            optional: false,
            installed: true,
            bound: true,
            status: "revoked",
            repairable: true,
          },
        ],
      },
    }),
  );
  listMyAgents.mockResolvedValue([]);
  installMarketplace.mockResolvedValue({
    ok: true,
    slug: "stale-plugin-agent",
    kind: "agent",
    version: "1.0.0",
    installedDeps: 1,
    installedCapabilities: [{ kind: "plugin", slug: "search-plugin", optional: false }],
    skippedOptional: [],
    needsAuthorization: [],
    ready: true,
    note: "repaired",
  });
  render(
    <DetailModal
      slug="stale-plugin-agent"
      auth={auth}
      installed={{
        slug: "stale-plugin-agent",
        kind: "agent",
        version: "1.0.0",
        versionId: "agent-v1",
        name: "插件待修复助手",
        artifactHash: "agent-hash",
        installedAt: "2026-07-15T00:00:00Z",
        listingState: "active",
      }}
      onClose={() => {}}
      onInstalled={() => {}}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "重新安装整包修复" }));
  expect(installMarketplace).toHaveBeenCalledWith(auth, "agent-v1", undefined);
});

test("Agent 的必需 Plugin 已下架时不展示无法成功的修复动作", async () => {
  getMarketplaceDetail.mockResolvedValue(
    detail({
      slug: "unavailable-plugin-agent",
      kind: "agent",
      versionId: "agent-v1",
      name: "插件已下架助手",
      manifest: {
        model: "glm-5.2",
        toolsets: ["core"],
        capabilities: [{ kind: "plugin", slug: "removed-plugin", optional: false }],
        persona: "测试",
      },
      capabilityReadiness: {
        installed: true,
        ready: false,
        needsAuthorization: [],
        requirements: [
          {
            kind: "plugin",
            slug: "removed-plugin",
            optional: false,
            installed: true,
            bound: true,
            status: "revoked",
            repairable: false,
          },
        ],
      },
    }),
  );
  listMyAgents.mockResolvedValue([]);
  render(
    <DetailModal
      slug="unavailable-plugin-agent"
      auth={auth}
      installed={{
        slug: "unavailable-plugin-agent",
        kind: "agent",
        version: "1.0.0",
        versionId: "agent-v1",
        name: "插件已下架助手",
        artifactHash: "agent-hash",
        installedAt: "2026-07-15T00:00:00Z",
        listingState: "active",
      }}
      onClose={() => {}}
      onInstalled={() => {}}
    />,
  );

  expect(await screen.findByText(/必需能力已被下架或撤销/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "重新安装整包修复" })).not.toBeInTheDocument();
  expect(screen.getByText("已安装")).toBeInTheDocument();
});

test("可选 Plugin 待授权时 Agent 仍可用，但完成态保留明确授权入口", async () => {
  getMarketplaceDetail.mockResolvedValue(
    detail({
      slug: "optional-plugin-agent",
      kind: "agent",
      versionId: "agent-v2",
      name: "可选插件助手",
      manifest: {
        model: "glm-5.2",
        toolsets: ["core"],
        capabilities: [{ kind: "plugin", slug: "optional-search", optional: true }],
        persona: "测试",
      },
      capabilityReadiness: {
        installed: false,
        ready: false,
        needsAuthorization: [],
        requirements: [],
      },
    }),
  );
  listMyAgents.mockResolvedValue([]);
  installMarketplace.mockResolvedValue({
    ok: true,
    slug: "optional-plugin-agent",
    kind: "agent",
    version: "1.0.0",
    installedDeps: 1,
    installedCapabilities: [{ kind: "plugin", slug: "optional-search", optional: true }],
    skippedOptional: [],
    needsAuthorization: ["optional-search"],
    ready: true,
    note: "installed",
  });
  const open = vi.fn();
  render(
    <DetailModal
      slug="optional-plugin-agent"
      auth={auth}
      onClose={() => {}}
      onInstalled={() => {}}
      onOpenConnectors={open}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "安装" }));
  expect(await screen.findByText("安装完成，仍有 Plugin 待授权")).toBeInTheDocument();
  expect(screen.getByText(/智能体已经可用；另有 1 项可选 Plugin/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "管理 Plugin 账号" }));
  expect(open).toHaveBeenCalledTimes(1);
});

test("更新依赖带来的 Skill 时只保留手动归属，不把兼容投影写成 manual", async () => {
  getMarketplaceDetail.mockResolvedValue(detail({ version: "2.0.0", versionId: "skill-v2" }));
  listMyAgents.mockResolvedValue([]);
  installMarketplace.mockResolvedValue({
    ok: true,
    slug: "academic-translate",
    kind: "skill",
    version: "2.0.0",
    installedDeps: 0,
    installedCapabilities: [],
    skippedOptional: [],
    needsAuthorization: [],
    ready: true,
    note: "updated",
  });
  render(
    <DetailModal
      slug="academic-translate"
      auth={auth}
      installed={{
        slug: "academic-translate",
        kind: "skill",
        version: "1.0.0",
        versionId: "skill-v1",
        name: "学术翻译",
        artifactHash: "old-hash",
        manualAgentIds: [],
        agentIds: ["research-agent"],
        installedAt: "2026-07-15T00:00:00Z",
        listingState: "active",
      }}
      onClose={() => {}}
      onInstalled={() => {}}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "更新到 v2.0.0" }));
  expect(installMarketplace).toHaveBeenCalledWith(auth, "skill-v2", ["research-agent"], true);
});

test("切换市场条目会重置未保存的 Skill 归属，不泄漏到下一条安装", async () => {
  getMarketplaceDetail.mockImplementation((_auth: AuthSession, slug: string) =>
    Promise.resolve(
      detail({
        slug,
        name: slug === "first-skill" ? "第一个 Skill" : "第二个 Skill",
        description: slug === "first-skill" ? "第一个详情" : "第二个详情",
      }),
    ),
  );
  listMyAgents.mockResolvedValue([
    { id: "main", slug: "main", name: "全能助手", description: "", installed: true, isDefault: true },
    { id: "writer", slug: "writer", name: "写作助手", description: "", installed: true },
  ] as MarketplaceMyAgent[]);

  const view = render(
    <DetailModal slug="first-skill" auth={auth} onClose={() => {}} onInstalled={() => {}} />,
  );
  await screen.findByText("第一个详情");
  const writer = screen.getByRole("button", { name: /写作助手/ });
  fireEvent.click(writer);
  expect(writer).toHaveAttribute("aria-pressed", "true");

  view.rerender(
    <DetailModal slug="second-skill" auth={auth} onClose={() => {}} onInstalled={() => {}} />,
  );
  await screen.findByText("第二个详情");
  expect(screen.getByRole("button", { name: /写作助手/ })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(screen.getByRole("button", { name: /全能助手/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("SKILL.md 原文默认折叠进「技术详情」<details>(默认收起)", async () => {
  getMarketplaceDetail.mockResolvedValue(detail());
  listMyAgents.mockResolvedValue([]);

  render(<DetailModal slug="academic-translate" auth={auth} onClose={() => {}} onInstalled={() => {}} />);

  const summary = await screen.findByText("技术详情（SKILL.md 原文）");
  const details = summary.closest("details") as HTMLDetailsElement | null;
  expect(details).not.toBeNull();
  // 默认收起(无 open 属性)
  expect(details?.open).toBe(false);
});

test("缺人向字段的存量详情不白屏,只渲染已有内容(无适用场景块)", async () => {
  getMarketplaceDetail.mockResolvedValue(
    detail({ useCases: undefined, outcomeExamples: undefined, humanMd: null, category: null }),
  );
  listMyAgents.mockResolvedValue([]);

  render(<DetailModal slug="academic-translate" auth={auth} onClose={() => {}} onInstalled={() => {}} />);

  // description 仍在(未白屏),但没有「适用场景」块
  expect(await screen.findByText("一句话描述")).toBeInTheDocument();
  expect(screen.queryByText("适用场景")).not.toBeInTheDocument();
});

test("信号徽章:usage30d/users30d/安装数/rating 都渲染,rating 文案诚实(非背书百分比)", async () => {
  getMarketplaceDetail.mockResolvedValue(
    detail({ installCount: 20, usage30d: 42, users30d: 9, rating: { up: 8, down: 1 } }),
  );
  listMyAgents.mockResolvedValue([]);

  render(<DetailModal slug="academic-translate" auth={auth} onClose={() => {}} onInstalled={() => {}} />);

  expect(await screen.findByText("30天 42 次使用")).toBeInTheDocument();
  expect(screen.getByText("30天 9 人在用")).toBeInTheDocument();
  expect(screen.getByText("已安装 20")).toBeInTheDocument();
  // 评分徽章 + 诚实旁注,不做「好评率 89%」式背书大字
  const badge = screen.getByText("👍 8/9");
  expect(badge).toHaveAttribute("title", "来自 9 次使用反馈");
  expect(screen.getByText("来自 9 次使用反馈")).toBeInTheDocument();
  expect(screen.queryByText(/好评率/)).not.toBeInTheDocument();
});

test("footer「在对话中试用」→ 回调带预填(含名称与 slug),供 AI 装好并给示例", async () => {
  getMarketplaceDetail.mockResolvedValue(detail());
  listMyAgents.mockResolvedValue([]);
  const onAsk = vi.fn();

  render(
    <DetailModal
      slug="academic-translate"
      auth={auth}
      onClose={() => {}}
      onInstalled={() => {}}
      onAskAiInChat={onAsk}
    />,
  );

  const btn = await screen.findByRole("button", { name: "在对话中试用" });
  fireEvent.click(btn);
  expect(onAsk).toHaveBeenCalledTimes(1);
  const text = onAsk.mock.calls[0][0] as string;
  expect(text).toContain("「学术翻译」");
  expect(text).toContain("slug: academic-translate");
});

test("未传 onAskAiInChat → 不渲染「在对话中试用」按钮", async () => {
  getMarketplaceDetail.mockResolvedValue(detail());
  listMyAgents.mockResolvedValue([]);

  render(<DetailModal slug="academic-translate" auth={auth} onClose={() => {}} onInstalled={() => {}} />);
  await screen.findByText("适用场景");
  expect(screen.queryByRole("button", { name: "在对话中试用" })).not.toBeInTheDocument();
});

test("信号徽章:旧后端缺字段 → 不渲染 usage/rating,仅保留安装数(优雅降级)", async () => {
  getMarketplaceDetail.mockResolvedValue(
    detail({ installCount: 5, usage30d: undefined, users30d: undefined, rating: null }),
  );
  listMyAgents.mockResolvedValue([]);

  render(<DetailModal slug="academic-translate" auth={auth} onClose={() => {}} onInstalled={() => {}} />);

  expect(await screen.findByText("已安装 5")).toBeInTheDocument();
  expect(screen.queryByText(/次使用/)).not.toBeInTheDocument();
  expect(screen.queryByText(/👍/)).not.toBeInTheDocument();
});

test("官方但非预装的 Plugin 仍显示安装按钮并可恢复安装", async () => {
  getMarketplaceDetail.mockResolvedValue(
    detail({
      slug: "knowledge-planet",
      kind: "connector",
      artifactKind: "plugin",
      pluginType: "managed-browser",
      name: "知识星球",
      versionId: "1606",
      official: true,
      preinstalled: false,
    }),
  );
  listMyAgents.mockResolvedValue([]);
  installMarketplace.mockResolvedValue({
    ok: true,
    slug: "knowledge-planet",
    kind: "connector",
    artifactKind: "plugin",
    pluginType: "managed-browser",
    version: "1.0.0",
    installedDeps: 0,
    installedCapabilities: [],
    skippedOptional: [],
    needsAuthorization: ["knowledge-planet"],
    ready: false,
    note: "installed",
  });
  const onInstalled = vi.fn();
  const onOpenConnectors = vi.fn();

  render(
    <DetailModal
      slug="knowledge-planet"
      auth={auth}
      onClose={() => {}}
      onInstalled={onInstalled}
      onOpenConnectors={onOpenConnectors}
    />,
  );

  const install = await screen.findByRole("button", { name: "安装" });
  expect(screen.queryByText(/已预装/)).not.toBeInTheDocument();
  fireEvent.click(install);
  expect(await screen.findByText("安装成功")).toBeInTheDocument();
  expect(installMarketplace).toHaveBeenCalledWith(auth, "1606", undefined);
  expect(onInstalled).toHaveBeenCalledTimes(1);
  expect(onOpenConnectors).toHaveBeenCalledWith("knowledge-planet");
});

test("精确预装 Plugin 不提供市场安装，只引导到管理中心", async () => {
  getMarketplaceDetail.mockResolvedValue(
    detail({
      slug: "notion",
      kind: "connector",
      artifactKind: "plugin",
      pluginType: "declarative-http",
      name: "Notion",
      official: true,
      preinstalled: true,
    }),
  );
  listMyAgents.mockResolvedValue([]);
  const openConnectors = vi.fn();

  render(
    <DetailModal
      slug="notion"
      auth={auth}
      onClose={() => {}}
      onInstalled={() => {}}
      onOpenConnectors={openConnectors}
    />,
  );

  expect(await screen.findByText("官方 API 插件 · 已预装")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "安装" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "去绑定账号" }));
  expect(openConnectors).toHaveBeenCalledTimes(1);
  expect(installMarketplace).not.toHaveBeenCalled();
});

test.each([
  ["ai", /AI 自动审核/, /管理员人工审核/],
  ["manual", /管理员人工审核/, /AI 自动审核/],
  ["platform", /平台官方内容/, /管理员人工审核/],
  [undefined, /发布审核/, /管理员人工审核/],
] as const)("脚本信任文案按 reviewSource=%s 如实展示", async (source, expected, forbidden) => {
  getMarketplaceDetail.mockResolvedValue(
    detail({
      reviewSource: source,
      rawBundle: { "scripts/run.sh": "echo ok" },
    }),
  );
  listMyAgents.mockResolvedValue([]);

  render(
    <DetailModal
      slug="academic-translate"
      auth={auth}
      onClose={() => {}}
      onInstalled={() => {}}
    />,
  );

  expect(await screen.findByText("含可执行脚本")).toBeInTheDocument();
  expect(screen.getByText(expected)).toBeInTheDocument();
  expect(screen.queryByText(forbidden)).not.toBeInTheDocument();
});
