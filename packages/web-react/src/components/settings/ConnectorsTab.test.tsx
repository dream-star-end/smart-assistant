/**
 * ConnectorsTab（应用连接器设置分区）测试。
 *
 * api 网络层全 mock（保留真 ApiError 类，errText 走 instanceof 分支），验证组件与
 * 钉死契约的交互：
 *   1. 目录渲染：5 个 provider 卡（图标/中文名/描述/读写能力标注，github=只读）+
 *      已绑多账号列表（displayName/accountHint/状态）
 *   2. 表单驱动绑定：formFields 生成表单（password 字段=密码框）、顶部 helpText/helpUrl
 *      引导、提交调 bindConnector；错误码 → 中文文案（不裸露码）
 *   3. BYOA OAuth（feishu）：填 client 凭据 → startConnectorOAuth
 *   4. github：跳现有 GitHub OAuth（startGithubOAuth）
 *   5. RELINK_REQUIRED：显示「需要重新绑定」引导 + 重新绑定按钮
 *   6. 解绑二次确认 → deleteConnector；备注名行内编辑 → renameConnector
 *   7. 声明式连接器：直填绑定（static-token）· **oauth2-auth-code 重定向流**（填 client
 *      凭据 → 「前往授权」→ startDeclarativeOauth，绝不走直填 bind）
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ConnectorConnection,
  ConnectorProvider,
  ConnectorsResponse,
  DeclarativeCatalogEntry,
  DeclarativeManagementConnector,
  RuntimePluginAccount,
} from "../../lib/connectors";
import type { AuthSession } from "../../lib/types";
import { createMemoryAuthSession } from "../../lib/authSession";
import { ConnectorsTab } from "./ConnectorsTab";

vi.mock("../../lib/api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...orig,
    api: {
      ...orig.api,
      getConnectors: vi.fn(),
      bindConnector: vi.fn(),
      startConnectorOAuth: vi.fn(),
      startGithubOAuth: vi.fn(),
      renameConnector: vi.fn(),
      deleteConnector: vi.fn(),
      // 声明式引擎（统一界面第二套后端）
      getDeclarativeCatalog: vi.fn(),
      getDeclarativeConnections: vi.fn(),
      getDeclarativeManagement: vi.fn(),
      installMarketplace: vi.fn(),
      uninstallMarketplace: vi.fn(),
      bindDeclarativeConnector: vi.fn(),
      startDeclarativeOauth: vi.fn(),
      unbindDeclarativeConnector: vi.fn(),
      getPluginManagement: vi.fn(),
      startKnowledgePlanetSetup: vi.fn(),
      getKnowledgePlanetSetup: vi.fn(),
      getKnowledgePlanetSetupQr: vi.fn(),
      cancelKnowledgePlanetSetup: vi.fn(),
      revokePluginAccount: vi.fn(),
      setPluginWriteAccess: vi.fn(),
      setPluginWritePreapproval: vi.fn(),
      getKnowledgePlanetAutomation: vi.fn(),
      setKnowledgePlanetAutomation: vi.fn(),
      listKnowledgePlanetAutomationGroups: vi.fn(),
      createKnowledgePlanetAutomationRulesBatch: vi.fn(),
      createKnowledgePlanetAutomationRule: vi.fn(),
      patchKnowledgePlanetAutomationRule: vi.fn(),
      deleteKnowledgePlanetAutomationRule: vi.fn(),
    },
  };
});

import { api, ApiError } from "../../lib/api";

const mockedGetConnectors = vi.mocked(api.getConnectors)
const mockedBind = vi.mocked(api.bindConnector)
const mockedOAuthStart = vi.mocked(api.startConnectorOAuth)
const mockedGithubStart = vi.mocked(api.startGithubOAuth)
const mockedRename = vi.mocked(api.renameConnector)
const mockedDelete = vi.mocked(api.deleteConnector)
const mockedDeclCatalog = vi.mocked(api.getDeclarativeCatalog)
const mockedDeclConnections = vi.mocked(api.getDeclarativeConnections)
const mockedDeclManagement = vi.mocked(api.getDeclarativeManagement)
const mockedInstallMarketplace = vi.mocked(api.installMarketplace)
const mockedUninstallMarketplace = vi.mocked(api.uninstallMarketplace)
const mockedDeclBind = vi.mocked(api.bindDeclarativeConnector)
const mockedDeclOauthStart = vi.mocked(api.startDeclarativeOauth)
const mockedDeclUnbind = vi.mocked(api.unbindDeclarativeConnector)
const mockedPluginManagement = vi.mocked(api.getPluginManagement)
const mockedKnowledgeStart = vi.mocked(api.startKnowledgePlanetSetup)
const mockedKnowledgeStatus = vi.mocked(api.getKnowledgePlanetSetup)
const mockedKnowledgeQr = vi.mocked(api.getKnowledgePlanetSetupQr)
const mockedKnowledgeCancel = vi.mocked(api.cancelKnowledgePlanetSetup)
const mockedPluginRevoke = vi.mocked(api.revokePluginAccount)
const mockedSetPluginWriteAccess = vi.mocked(api.setPluginWriteAccess)
const mockedSetPluginWritePreapproval = vi.mocked(api.setPluginWritePreapproval)
const mockedGetKnowledgePlanetAutomation = vi.mocked(api.getKnowledgePlanetAutomation)
const mockedSetKnowledgePlanetAutomation = vi.mocked(api.setKnowledgePlanetAutomation)
const mockedListKnowledgePlanetGroups = vi.mocked(api.listKnowledgePlanetAutomationGroups)
const mockedCreateKnowledgePlanetRulesBatch = vi.mocked(
  api.createKnowledgePlanetAutomationRulesBatch,
)
const mockedPatchKnowledgePlanetRule = vi.mocked(api.patchKnowledgePlanetAutomationRule)
const mockedDeleteKnowledgePlanetRule = vi.mocked(api.deleteKnowledgePlanetAutomationRule)

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  // 声明式默认降级为空（现有 v1 用例不受第二套后端影响）；声明式用例各自 override。
  mockedDeclCatalog.mockResolvedValue({ connectors: [] })
  mockedDeclConnections.mockResolvedValue({ connections: [] })
  mockedPluginManagement.mockResolvedValue({ catalog: [], accounts: [] })
  mockedGetKnowledgePlanetAutomation.mockResolvedValue({
    control: {
      available: true,
      enabled: false,
      disclaimerVersion: 1,
      acceptedVersion: null,
      acceptedAt: null,
      disclaimerText: '无人值守会自动计费并发布带 AI 标识的文字回复。',
      accountDailyLimit: 10,
      pausedReason: null,
    },
    rules: [],
    recentRuns: [],
  })
  mockedSetKnowledgePlanetAutomation.mockResolvedValue({
    available: true,
    enabled: true,
    disclaimerVersion: 1,
    acceptedVersion: 1,
    acceptedAt: '2026-07-17T00:00:00.000Z',
    disclaimerText: '无人值守会自动计费并发布带 AI 标识的文字回复。',
    accountDailyLimit: 10,
    pausedReason: null,
  })
  mockedListKnowledgePlanetGroups.mockResolvedValue([
    { id: '12345678901234', name: '产品交流星球', memberCount: 128 },
    { id: '22345678901234', name: '内部测试星球', memberCount: 12 },
  ])
  // 旧目录 fixture 转成管理中心聚合契约，既保留既有交互覆盖，也钉住新读模型。
  mockedDeclManagement.mockImplementation(async (session) => {
    const [catalogResponse, connectionsResponse] = await Promise.all([
      mockedDeclCatalog(session),
      mockedDeclConnections(session),
    ]);
    return {
      connectors: catalogResponse.connectors.map((entry) => ({
        slug: entry.slug,
        label: entry.label,
        description: entry.description,
        installation: "default" as const,
        official: true,
        available: true,
        canBind: true,
        listingState: "active",
        installedVersion: "1.0.0",
        installedVersionId: String(entry.versionId),
        latestVersion: "1.0.0",
        latestVersionId: String(entry.versionId),
        updateAvailable: false,
        connectionCount: connectionsResponse.connections.filter((c) => c.slug === entry.slug)
          .length,
        contract: entry,
      })),
      connections: connectionsResponse.connections,
    };
  });
});

const auth: AuthSession = createMemoryAuthSession(() => {}, "t");

const PROVIDERS: ConnectorProvider[] = [
  {
    id: "webdav",
    label: "WebDAV 网盘",
    description: "坚果云 / Nextcloud 等支持 WebDAV 的网盘",
    authKind: "basic_form",
    formFields: [
      {
        key: "serverUrl",
        label: "服务器地址",
        type: "url",
        required: true,
        placeholder: "https://…",
      },
      { key: "username", label: "账号", type: "text", required: true },
      { key: "password", label: "应用密码", type: "password", required: true },
    ],
  },
  {
    id: "imap",
    label: "邮箱",
    description: "QQ / 163 / 通用 IMAP 邮箱收发",
    authKind: "basic_form",
    formFields: [
      { key: "email", label: "邮箱地址", type: "text", required: true },
      {
        key: "authCode",
        label: "授权码",
        type: "password",
        required: true,
        helpText: "QQ 邮箱需使用授权码而非登录密码。",
        helpUrl: "https://example.com/qq-auth-code",
      },
    ],
  },
  {
    id: "notion",
    label: "Notion",
    description: "读取与创建 Notion 页面",
    authKind: "token",
    formFields: [{ key: "token", label: "Integration Token", type: "password", required: true }],
  },
  {
    id: "github",
    label: "GitHub",
    description: "检索 Issue（只读）",
    authKind: "oauth2_byoa",
    formFields: [],
  },
  {
    id: "feishu",
    label: "飞书",
    description: "文档 / 日历 / 消息（企业自建应用）",
    authKind: "oauth2_byoa",
    formFields: [
      { key: "clientId", label: "App ID", type: "text", required: true },
      { key: "clientSecret", label: "App Secret", type: "password", required: true },
    ],
  },
];

function conn(overrides: Partial<ConnectorConnection> = {}): ConnectorConnection {
  return {
    id: "11",
    provider: "imap",
    displayName: "工作邮箱",
    accountHint: "a***@qq.com",
    status: "active",
    lastErrorCode: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

function catalog(connections: ConnectorConnection[] = []): ConnectorsResponse {
  return { providers: PROVIDERS, connections };
}

/** 声明式 catalog 条目 fixture（默认 slug=linear，v1 目录无此 slug，便于非去重用例）。 */
function declEntry(overrides: Partial<DeclarativeCatalogEntry> = {}): DeclarativeCatalogEntry {
  return {
    versionId: 42,
    slug: "linear",
    label: "Linear",
    description: "声明式：检索与创建 Linear issue",
    authMode: "static-token",
    requiredBindSources: ["access_token"],
    actions: [{ id: "search", effect: "read" }],
    ...overrides,
  };
}

function managementEntry(
  overrides: Partial<DeclarativeManagementConnector> = {},
): DeclarativeManagementConnector {
  const contract = declEntry();
  return {
    slug: contract.slug,
    label: contract.label,
    description: contract.description,
    installation: "marketplace",
    official: false,
    available: true,
    canBind: true,
    listingState: "active",
    installedVersion: "1.0.0",
    installedVersionId: "42",
    latestVersion: "1.0.0",
    latestVersionId: "42",
    updateAvailable: false,
    connectionCount: 0,
    contract,
    ...overrides,
  };
}

function knowledgePlanetPlugin() {
  return {
    versionId: '101',
    slug: 'knowledge-planet',
    pluginType: 'managed-browser' as const,
    label: '知识星球',
    description: '读取已授权知识星球，并可在用户确认后发布主题或评论',
    accountMode: 'required' as const,
    actions: [
      { id: 'list_groups', description: '列出星球', readOnly: true as const },
      { id: 'create_topic', description: '发布主题', readOnly: false as const },
      { id: 'create_comment', description: '发布评论', readOnly: false as const },
    ],
    installed: true,
    installedVersion: '1.2.0',
    latestVersionId: '101',
    latestVersion: '1.2.0',
    installedCurrent: true,
    updateAvailable: false,
    available: true,
  }
}

function knowledgePlanetWriteControl(
  overrides: Partial<NonNullable<RuntimePluginAccount['writeControl']>> = {},
): NonNullable<RuntimePluginAccount['writeControl']> {
  return {
    available: true,
    enabled: false,
    disclaimerVersion: 1,
    acceptedVersion: null,
    acceptedAt: null,
    disclaimerText:
      '写入会以你的真实身份发布到知识星球。请确认内容合法、准确且不侵犯他人权益；结果不明确时不要重复提交。',
    preapproval: {
      available: true,
      enabled: false,
      disclaimerVersion: 1,
      acceptedVersion: null,
      acceptedAt: null,
      disclaimerText:
        '开启后所有 Agent 可直接发布、上传媒体、点赞、编辑和永久删除，不再展示逐次确认卡。',
    },
    ...overrides,
  }
}

/** 定位某 provider 目录卡的容器（label 文本 → 最近的卡片 div）。 */
function providerCard(label: string): HTMLElement {
  const el = screen.getByText(label).closest("div.rounded-xl");
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

describe("ConnectorsTab 目录渲染", () => {
  test("渲染 5 个 provider 卡:中文名/描述/读写能力标注(github 只读)", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    render(<ConnectorsTab auth={auth} />);

    expect(await screen.findByText("WebDAV 网盘")).toBeInTheDocument();
    for (const p of PROVIDERS) {
      expect(screen.getByText(p.label)).toBeInTheDocument();
      expect(screen.getByText(p.description)).toBeInTheDocument();
    }
    // github 标「只读」,其余标「可读写」
    expect(within(providerCard("GitHub")).getByText("只读")).toBeInTheDocument();
    expect(within(providerCard("邮箱")).getByText("可读写")).toBeInTheDocument();
    expect(screen.getAllByText("可读写")).toHaveLength(4);
  });

  test("已绑多账号:同 provider 多行,显示 displayName/accountHint/绑定状态", async () => {
    mockedGetConnectors.mockResolvedValue(
      catalog([conn(), conn({ id: "12", displayName: "", accountHint: "b***@163.com" })]),
    );
    render(<ConnectorsTab auth={auth} />);

    expect(await screen.findByText("工作邮箱")).toBeInTheDocument();
    const card = providerCard("邮箱");
    expect(within(card).getByText("已绑定 2 个账号")).toBeInTheDocument();
    expect(within(card).getByText("a***@qq.com")).toBeInTheDocument();
    // 无 displayName 的行回退 accountHint 作主名（truncate 展示 + hint 行,至少出现一次）
    expect(within(card).getAllByText("b***@163.com").length).toBeGreaterThan(0);
    expect(within(card).getAllByText("正常")).toHaveLength(2);
    // 已绑 provider 的按钮变为「添加账号」
    expect(within(card).getByRole("button", { name: "添加账号" })).toBeInTheDocument();
  });

  test("RELINK_REQUIRED:显示需要重新绑定引导与重新绑定按钮", async () => {
    mockedGetConnectors.mockResolvedValue(
      catalog([conn({ status: "error", lastErrorCode: "RELINK_REQUIRED" })]),
    );
    render(<ConnectorsTab auth={auth} />);

    expect(await screen.findByText("需要重新绑定")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新绑定" })).toBeInTheDocument();
    expect(screen.queryByText("正常")).not.toBeInTheDocument();
  });

  test("其他 error 码:映射为中文文案(不裸露码)", async () => {
    mockedGetConnectors.mockResolvedValue(
      catalog([conn({ status: "error", lastErrorCode: "INVALID_CREDENTIALS" })]),
    );
    render(<ConnectorsTab auth={auth} />);

    expect(await screen.findByText("凭据校验失败，请检查账号或授权码后重试")).toBeInTheDocument();
    expect(screen.queryByText("INVALID_CREDENTIALS")).not.toBeInTheDocument();
  });
});

describe("ConnectorsTab 表单驱动绑定", () => {
  test("imap:formFields 生成表单,password 字段用密码框,顶部有引导链接", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    render(<ConnectorsTab auth={auth} />);
    await screen.findByText("邮箱");

    fireEvent.click(within(providerCard("邮箱")).getByRole("button", { name: "绑定" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("绑定 邮箱")).toBeInTheDocument();
    // 顶部引导:helpText + helpUrl 链接
    expect(within(dialog).getByText(/QQ 邮箱需使用授权码而非登录密码/)).toBeInTheDocument();
    const help = within(dialog).getByRole("link", { name: /查看指引/ });
    expect(help).toHaveAttribute("href", "https://example.com/qq-auth-code");
    // password 字段 → 密码框
    const authCode = within(dialog).getByLabelText(/授权码/) as HTMLInputElement;
    expect(authCode.type).toBe("password");
    const email = within(dialog).getByLabelText(/邮箱地址/) as HTMLInputElement;
    expect(email.type).toBe("text");
  });

  test("必填未填提交钮禁用;填齐后提交调 bindConnector(fields+displayName)并刷新目录", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    mockedBind.mockResolvedValue({ connection: conn() });
    render(<ConnectorsTab auth={auth} />);
    await screen.findByText("邮箱");

    fireEvent.click(within(providerCard("邮箱")).getByRole("button", { name: "绑定" }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "绑定" });
    expect(submit).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText(/邮箱地址/), { target: { value: "a@qq.com" } });
    fireEvent.change(within(dialog).getByLabelText(/授权码/), { target: { value: "authcode123" } });
    fireEvent.change(within(dialog).getByLabelText(/备注名/), { target: { value: "工作邮箱" } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mockedBind).toHaveBeenCalledWith(auth, "imap", {
        fields: { email: "a@qq.com", authCode: "authcode123" },
        displayName: "工作邮箱",
      }),
    );
    // 绑定成功 → 目录 reload（初始 1 次 + 成功后 1 次）
    await waitFor(() => expect(mockedGetConnectors).toHaveBeenCalledTimes(2));
  });

  test("绑定失败:错误码映射中文文案展示在弹层内", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    mockedBind.mockRejectedValue(
      new ApiError({ status: 400, message: "raw upstream", code: "INVALID_CREDENTIALS" }),
    );
    render(<ConnectorsTab auth={auth} />);
    await screen.findByText("Notion");

    fireEvent.click(within(providerCard("Notion")).getByRole("button", { name: "绑定" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Integration Token/), {
      target: { value: "secret_token" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "绑定" }));

    expect(
      await within(dialog).findByText("凭据校验失败，请检查账号或授权码后重试"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("INVALID_CREDENTIALS")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("raw upstream")).not.toBeInTheDocument();
  });

  test("feishu(BYOA):填 client 凭据 → 前往授权 → startConnectorOAuth", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    // 返回后组件整页跳转;jsdom 不实现导航,仅断言 API 入参
    mockedOAuthStart.mockResolvedValue({ authorizeUrl: "https://open.feishu.cn/authorize?x=1" });
    render(<ConnectorsTab auth={auth} />);
    await screen.findByText("飞书");

    fireEvent.click(within(providerCard("飞书")).getByRole("button", { name: "绑定" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/App ID/), { target: { value: "cli_x" } });
    fireEvent.change(within(dialog).getByLabelText(/App Secret/), { target: { value: "sec_y" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "前往授权" }));

    await waitFor(() =>
      expect(mockedOAuthStart).toHaveBeenCalledWith(auth, "feishu", {
        clientId: "cli_x",
        clientSecret: "sec_y",
        displayName: undefined,
      }),
    );
  });

  test("github:绑定按钮直接走现有 GitHub OAuth 入口,不开表单弹层", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    mockedGithubStart.mockResolvedValue({
      authorizeUrl: "https://github.com/login/oauth",
      state: "s",
    });
    render(<ConnectorsTab auth={auth} />);
    await screen.findByText("GitHub");

    fireEvent.click(within(providerCard("GitHub")).getByRole("button", { name: "绑定" }));
    await waitFor(() => expect(mockedGithubStart).toHaveBeenCalledWith(auth));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("ConnectorsTab 已绑管理", () => {
  test("解绑走二次确认,确认后调 deleteConnector 并刷新", async () => {
    mockedGetConnectors.mockResolvedValue(catalog([conn()]));
    mockedDelete.mockResolvedValue(undefined);
    render(<ConnectorsTab auth={auth} />);
    await screen.findByText("工作邮箱");

    fireEvent.click(screen.getByRole("button", { name: "解绑" }));
    // 二次确认弹层
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/解绑「工作邮箱」/)).toBeInTheDocument();
    expect(mockedDelete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "解绑" }));

    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith(auth, "11"));
    await waitFor(() => expect(mockedGetConnectors).toHaveBeenCalledTimes(2));
  });

  test("备注名行内编辑:Enter 保存 → renameConnector", async () => {
    mockedGetConnectors.mockResolvedValue(catalog([conn()]));
    mockedRename.mockResolvedValue(undefined);
    render(<ConnectorsTab auth={auth} />);
    await screen.findByText("工作邮箱");

    fireEvent.click(screen.getByRole("button", { name: "编辑备注名" }));
    const input = screen.getByLabelText("备注名") as HTMLInputElement;
    expect(input.value).toBe("工作邮箱");
    fireEvent.change(input, { target: { value: "私人邮箱" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(mockedRename).toHaveBeenCalledWith(auth, "11", "私人邮箱"));
  });
});

describe("ConnectorsTab 声明式连接器（统一界面）", () => {
  test("市场连接器有新版本时从管理中心更新精确版本 pin", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    mockedDeclManagement.mockResolvedValue({
      connectors: [
        managementEntry({
          installedVersion: "1.0.0",
          installedVersionId: "42",
          latestVersion: "2.0.0",
          latestVersionId: "84",
          updateAvailable: true,
        }),
      ],
      connections: [],
    });
    mockedInstallMarketplace.mockResolvedValue({
      ok: true,
      slug: "linear",
      kind: "connector",
      version: "2.0.0",
      note: "updated",
      installedDeps: 0,
      installedCapabilities: [],
      skippedOptional: [],
      needsAuthorization: ["linear"],
      ready: false,
    });
    render(<ConnectorsTab auth={auth} />);

    await screen.findByText("Linear");
    const card = providerCard("Linear");
    expect(within(card).getByText("可更新 v2.0.0")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "更新" }));

    await waitFor(() => expect(mockedInstallMarketplace).toHaveBeenCalledWith(auth, "84"));
    await waitFor(() => expect(mockedGetConnectors).toHaveBeenCalledTimes(2));
  });

  test("无绑定账号的市场连接器可从管理中心二次确认卸载", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    mockedDeclManagement.mockResolvedValue({
      connectors: [managementEntry()],
      connections: [],
    });
    mockedUninstallMarketplace.mockResolvedValue({ ok: true });
    render(<ConnectorsTab auth={auth} />);

    await screen.findByText("Linear");
    fireEvent.click(within(providerCard("Linear")).getByRole("button", { name: "卸载" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/卸载 API 插件「Linear」/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "卸载" }));

    await waitFor(() => expect(mockedUninstallMarketplace).toHaveBeenCalledWith(auth, "linear"));
    await waitFor(() => expect(mockedGetConnectors).toHaveBeenCalledTimes(2));
  });

  test("声明式 catalog 渲染成卡片:label/描述/能力标注(只读动作→只读)", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    mockedDeclCatalog.mockResolvedValue({ connectors: [declEntry()] });
    render(<ConnectorsTab auth={auth} />);

    expect(await screen.findByText("Linear")).toBeInTheDocument();
    expect(screen.getByText("声明式：检索与创建 Linear issue")).toBeInTheDocument();
    // actions 仅 read → 只读（write/send 才可读写）
    expect(within(providerCard("Linear")).getByText("只读")).toBeInTheDocument();
  });

  test("写动作声明式连接器标注为可读写", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    mockedDeclCatalog.mockResolvedValue({
      connectors: [declEntry({ actions: [{ id: "create", effect: "write" }] })],
    });
    render(<ConnectorsTab auth={auth} />);

    await screen.findByText("Linear");
    expect(within(providerCard("Linear")).getByText("可读写")).toBeInTheDocument();
  });

  test("去重(声明式优先):v1 与声明式同 slug(notion)只渲染声明式版一张卡", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    mockedDeclCatalog.mockResolvedValue({
      connectors: [
        declEntry({
          slug: "notion",
          label: "Notion（声明式）",
          description: "声明式 Notion 引擎",
          actions: [{ id: "create", effect: "write" }],
        }),
      ],
    });
    render(<ConnectorsTab auth={auth} />);

    // 声明式 notion 卡渲染
    expect(await screen.findByText("Notion（声明式）")).toBeInTheDocument();
    // v1 notion 被去重(其描述与裸 label "Notion" 均不再出现)
    expect(screen.queryByText("读取与创建 Notion 页面")).not.toBeInTheDocument();
    expect(screen.queryByText("Notion")).not.toBeInTheDocument();
  });

  test("同 slug 的 v1 已绑连接仍合并展示，并按连接来源走 v1 解绑", async () => {
    mockedGetConnectors.mockResolvedValue(
      catalog([
        conn({
          id: "88",
          provider: "notion",
          displayName: "旧版 Notion",
          accountHint: "workspace-v1",
        }),
      ]),
    );
    mockedDeclCatalog.mockResolvedValue({
      connectors: [
        declEntry({
          slug: "notion",
          label: "Notion（声明式）",
          description: "声明式 Notion 引擎",
        }),
      ],
    });
    mockedDelete.mockResolvedValue();
    render(<ConnectorsTab auth={auth} />);

    await screen.findByText("Notion（声明式）");
    const card = providerCard("Notion（声明式）");
    expect(within(card).getByText("旧版 Notion")).toBeInTheDocument();
    expect(within(card).getByText("已绑定 1 个账号")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "解绑" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "解绑" }));
    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith(auth, "88"));
    expect(mockedDeclUnbind).not.toHaveBeenCalled();
  });

  test("声明式 bind:按 requiredBindSources 渲染字段→提交调 bindDeclarativeConnector(versionId+secrets)→reload", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    mockedDeclCatalog.mockResolvedValue({
      connectors: [
        declEntry({
          versionId: 77,
          requiredBindSources: ["client_id", "client_secret"],
          actions: [{ id: "create", effect: "write" }],
        }),
      ],
    });
    mockedDeclBind.mockResolvedValue({ connection: { id: "d1", rebound: false } });
    render(<ConnectorsTab auth={auth} />);
    await screen.findByText("Linear");

    fireEvent.click(within(providerCard("Linear")).getByRole("button", { name: "绑定" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("绑定 Linear")).toBeInTheDocument();
    // source → 表单字段元数据：client_id=text, client_secret=password
    const cid = within(dialog).getByLabelText(/应用 ID/) as HTMLInputElement;
    const csec = within(dialog).getByLabelText(/应用密钥/) as HTMLInputElement;
    expect(cid.type).toBe("text");
    expect(csec.type).toBe("password");

    const submit = within(dialog).getByRole("button", { name: "绑定" });
    expect(submit).toBeDisabled();
    fireEvent.change(cid, { target: { value: "cid_x" } });
    fireEvent.change(csec, { target: { value: "csec_y" } });
    fireEvent.change(within(dialog).getByLabelText(/备注名/), { target: { value: "团队账号" } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mockedDeclBind).toHaveBeenCalledWith(auth, {
        versionId: 77,
        secrets: { client_id: "cid_x", client_secret: "csec_y" },
        displayName: "团队账号",
      }),
    );
    // 非回归：非 oauth2 authMode 绝不走授权重定向流
    expect(mockedDeclOauthStart).not.toHaveBeenCalled();
    // 成功 → 目录 reload（getConnectors 初始 1 + 成功后 1）
    await waitFor(() => expect(mockedGetConnectors).toHaveBeenCalledTimes(2));
  });

  test("oauth2-auth-code:弹层渲染 client 凭据字段,提交钮文案为「前往授权」(非「绑定」)", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    mockedDeclCatalog.mockResolvedValue({
      connectors: [
        declEntry({
          authMode: "oauth2-auth-code",
          requiredBindSources: ["client_id", "client_secret"],
        }),
      ],
    });
    render(<ConnectorsTab auth={auth} />);
    await screen.findByText("Linear");

    fireEvent.click(within(providerCard("Linear")).getByRole("button", { name: "绑定" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("绑定 Linear")).toBeInTheDocument();
    // 字段仍由 requiredBindSources + bindFieldMeta 驱动（client_id=text / client_secret=password）
    const cid = within(dialog).getByLabelText(/应用 ID/) as HTMLInputElement;
    const csec = within(dialog).getByLabelText(/应用密钥/) as HTMLInputElement;
    expect(cid.type).toBe("text");
    expect(csec.type).toBe("password");
    // oauth2 → 提交钮是「前往授权」，且不存在「绑定」提交钮（直填 bind 会被后端硬拒）
    expect(within(dialog).getByRole("button", { name: "前往授权" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "绑定" })).not.toBeInTheDocument();
    // oauth2 专属引导文案
    expect(within(dialog).getByText(/前往授权后即可完成绑定/)).toBeInTheDocument();
  });

  test("oauth2-auth-code:填 client 凭据提交 → startDeclarativeOauth(versionId+client 凭据),不调 bindDeclarativeConnector", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    mockedDeclCatalog.mockResolvedValue({
      connectors: [
        declEntry({
          versionId: 88,
          authMode: "oauth2-auth-code",
          requiredBindSources: ["client_id", "client_secret"],
          actions: [{ id: "create", effect: "write" }],
        }),
      ],
    });
    // 返回后组件整页跳转；jsdom 不实现导航（既有 Not implemented: navigation 告警），仅断言 API 入参
    mockedDeclOauthStart.mockResolvedValue({
      authorizeUrl: "https://linear.app/oauth/authorize?x=1",
    });
    render(<ConnectorsTab auth={auth} />);
    await screen.findByText("Linear");

    fireEvent.click(within(providerCard("Linear")).getByRole("button", { name: "绑定" }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "前往授权" });
    expect(submit).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText(/应用 ID/), { target: { value: "cli_x" } });
    fireEvent.change(within(dialog).getByLabelText(/应用密钥/), { target: { value: "sec_y" } });
    fireEvent.change(within(dialog).getByLabelText(/备注名/), { target: { value: "我的应用" } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mockedDeclOauthStart).toHaveBeenCalledWith(auth, {
        versionId: 88,
        clientId: "cli_x",
        clientSecret: "sec_y",
        displayName: "我的应用",
      }),
    );
    // oauth2 连接器绝不走直填 bind（后端硬拒 BAD_REQUEST）
    expect(mockedDeclBind).not.toHaveBeenCalled();
  });

  test("oauth2 platform 模式:零凭据字段,一键「前往授权」(读 clientProvisioning,非从空数组反推)", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    mockedDeclCatalog.mockResolvedValue({
      connectors: [
        declEntry({
          versionId: 99,
          authMode: "oauth2-auth-code",
          clientProvisioning: "platform",
          requiredBindSources: [], // 平台已注册 App → 用户什么都不用填
        }),
      ],
    });
    mockedDeclOauthStart.mockResolvedValue({ authorizeUrl: "https://linear.app/oauth/authorize" });
    render(<ConnectorsTab auth={auth} />);
    await screen.findByText("Linear");

    fireEvent.click(within(providerCard("Linear")).getByRole("button", { name: "绑定" }));
    const dialog = await screen.findByRole("dialog");
    // 零凭据字段（不该出现 client_id / client_secret 输入框）
    expect(within(dialog).queryByLabelText(/应用 ID/)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/应用密钥/)).not.toBeInTheDocument();
    // 一键授权专属文案（不是 BYOA 的「填写你的自建应用凭据」）
    expect(within(dialog).getByText(/无需填写任何凭据/)).toBeInTheDocument();
    // 无必填项 → 按钮直接可点
    const submit = within(dialog).getByRole("button", { name: "前往授权" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mockedDeclOauthStart).toHaveBeenCalledWith(auth, {
        versionId: 99,
        clientId: "",
        clientSecret: "",
        displayName: undefined,
      }),
    );
    expect(mockedDeclBind).not.toHaveBeenCalled();
  });

  test("oauth2-auth-code:发起授权失败 → 弹层内中文文案(不裸露码)", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    mockedDeclCatalog.mockResolvedValue({
      connectors: [
        declEntry({
          authMode: "oauth2-auth-code",
          requiredBindSources: ["client_id", "client_secret"],
        }),
      ],
    });
    mockedDeclOauthStart.mockRejectedValue(
      new ApiError({ status: 503, message: "raw internal", code: "CONNECTOR_UNAVAILABLE" }),
    );
    render(<ConnectorsTab auth={auth} />);
    await screen.findByText("Linear");

    fireEvent.click(within(providerCard("Linear")).getByRole("button", { name: "绑定" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/应用 ID/), { target: { value: "cli_x" } });
    fireEvent.change(within(dialog).getByLabelText(/应用密钥/), { target: { value: "sec_y" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "前往授权" }));

    expect(
      await within(dialog).findByText("该连接器暂不可用，请稍后重试或联系管理员"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("CONNECTOR_UNAVAILABLE")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("raw internal")).not.toBeInTheDocument();
  });

  test("声明式已绑连接:无改名铅笔;解绑确认后调 unbindDeclarativeConnector(非 v1 deleteConnector)", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    mockedDeclCatalog.mockResolvedValue({
      connectors: [declEntry({ actions: [{ id: "create", effect: "write" }] })],
    });
    mockedDeclConnections.mockResolvedValue({
      connections: [
        {
          id: "dc1",
          slug: "linear",
          displayName: "我的 Linear",
          accountHint: "team-x",
          createdAt: "2026-07-11T00:00:00.000Z",
        },
      ],
    });
    mockedDeclUnbind.mockResolvedValue(undefined);
    render(<ConnectorsTab auth={auth} />);
    await screen.findByText("我的 Linear");

    const card = providerCard("Linear");
    // 声明式连接行不显示改名铅笔（后端无 rename）
    expect(within(card).queryByRole("button", { name: "编辑备注名" })).not.toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "解绑" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/解绑「我的 Linear」/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "解绑" }));

    await waitFor(() => expect(mockedDeclUnbind).toHaveBeenCalledWith(auth, "dc1"));
    // 走声明式解绑，绝不误调 v1 deleteConnector
    expect(mockedDelete).not.toHaveBeenCalled();
    await waitFor(() => expect(mockedGetConnectors).toHaveBeenCalledTimes(2));
  });

  test("非回归:v1 独有 provider(webdav)仍渲染且绑定走 v1 表单弹层", async () => {
    mockedGetConnectors.mockResolvedValue(catalog());
    mockedDeclCatalog.mockResolvedValue({ connectors: [declEntry()] });
    render(<ConnectorsTab auth={auth} />);
    await screen.findByText("WebDAV 网盘");

    fireEvent.click(within(providerCard("WebDAV 网盘")).getByRole("button", { name: "绑定" }));
    const dialog = await screen.findByRole("dialog");
    // v1 BindDialog：formFields 驱动的字段（服务器地址/账号/应用密码）
    expect(within(dialog).getByText("绑定 WebDAV 网盘")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/服务器地址/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/应用密码/)).toBeInTheDocument();
  });

  test("非回归降级:声明式接口拉取失败仍显示完整 v1 列表,不弹整体错误", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedGetConnectors.mockResolvedValue(catalog());
    mockedDeclCatalog.mockRejectedValue(new Error("boom"));
    mockedDeclConnections.mockRejectedValue(new Error("boom"));
    render(<ConnectorsTab auth={auth} />);

    expect(await screen.findByText('WebDAV 网盘')).toBeInTheDocument()
    for (const p of PROVIDERS) expect(screen.getByText(p.label)).toBeInTheDocument()
    expect(screen.queryByText('加载应用连接失败')).not.toBeInTheDocument()
    warn.mockRestore()
  })
})

describe('ConnectorsTab 通用 Plugin 账号', () => {
  test('旧版 Plugin 无账号时可直接更新到市场当前版本', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    mockedPluginManagement.mockResolvedValue({
      catalog: [
        {
          ...knowledgePlanetPlugin(),
          installedVersion: '1.0.0',
          latestVersionId: '202',
          latestVersion: '1.2.0',
          installedCurrent: false,
          updateAvailable: true,
        },
      ],
      accounts: [],
    })
    mockedInstallMarketplace.mockResolvedValue({
      ok: true,
      slug: 'knowledge-planet',
      kind: 'connector',
      version: '1.2.0',
      note: 'updated',
      installedDeps: 0,
      installedCapabilities: [],
      skippedOptional: [],
      needsAuthorization: ['knowledge-planet'],
      ready: false,
    })
    render(<ConnectorsTab auth={auth} />)

    await screen.findByText('知识星球')
    const card = providerCard('知识星球')
    expect(within(card).getByText('可更新 v1.2.0')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: '更新' }))

    await waitFor(() => expect(mockedInstallMarketplace).toHaveBeenCalledWith(auth, '202'))
  })

  test('旧版 Plugin 有账号时保留恢复入口并要求先解绑再更新', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    mockedPluginManagement.mockResolvedValue({
      catalog: [
        {
          ...knowledgePlanetPlugin(),
          latestVersionId: '202',
          latestVersion: '1.2.0',
          installedCurrent: false,
          updateAvailable: true,
        },
      ],
      accounts: [
        {
          id: '901',
          provider: 'knowledge-planet',
          pluginType: 'managed-browser',
          displayName: '旧版知识星球',
          accountHint: '微信扫码账号',
          status: 'active',
          actions: [{ id: 'list_groups', description: '列出星球', readOnly: true }],
          versionId: '101',
          executable: false,
          writeControl: knowledgePlanetWriteControl(),
        },
      ],
    })
    render(<ConnectorsTab auth={auth} />)

    await screen.findByText('旧版知识星球')
    const card = providerCard('知识星球')
    expect(within(card).getByText('需先更新')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '更新' })).toBeDisabled()
    expect(within(card).getByRole('button', { name: '解绑' })).toBeEnabled()
  })

  test('受管 Plugin 登录过期后明确提示重新授权并保留解绑入口', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    mockedPluginManagement.mockResolvedValue({
      catalog: [knowledgePlanetPlugin()],
      accounts: [
        {
          id: '901',
          provider: 'knowledge-planet',
          pluginType: 'managed-browser',
          displayName: '过期的知识星球账号',
          accountHint: '微信扫码账号',
          status: 'error',
          actions: [{ id: 'list_groups', description: '列出星球', readOnly: true }],
          versionId: '101',
          executable: false,
          writeControl: knowledgePlanetWriteControl(),
        },
      ],
    })
    render(<ConnectorsTab auth={auth} />)

    await screen.findByText('过期的知识星球账号')
    const card = providerCard('知识星球')
    expect(within(card).getByText('需重新授权')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '解绑' })).toBeEnabled()
  })

  test('无账号的运行时 Plugin 可二次确认卸载', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    mockedPluginManagement.mockResolvedValue({ catalog: [knowledgePlanetPlugin()], accounts: [] })
    mockedUninstallMarketplace.mockResolvedValue({ ok: true })
    render(<ConnectorsTab auth={auth} />)

    await screen.findByText('知识星球')
    fireEvent.click(within(providerCard('知识星球')).getByRole('button', { name: '卸载' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/卸载 Plugin「知识星球」/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '卸载' }))

    await waitFor(() =>
      expect(mockedUninstallMarketplace).toHaveBeenCalledWith(auth, 'knowledge-planet'),
    )
  })

  test('知识星球已安装但未授权时提供微信扫码流程，关闭会取消并销毁会话', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    mockedPluginManagement.mockResolvedValue({ catalog: [knowledgePlanetPlugin()], accounts: [] })
    mockedKnowledgeStart.mockResolvedValue({
      sessionId: '11111111-1111-4111-8111-111111111111',
      status: 'waiting_for_scan',
      qrReady: true,
      createdAt: '2026-07-16T00:00:00.000Z',
      expiresAt: '2026-07-16T00:04:00.000Z',
    })
    mockedKnowledgeStatus.mockImplementation(() => new Promise(() => {}))
    mockedKnowledgeQr.mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
    mockedKnowledgeCancel.mockResolvedValue({
      sessionId: '11111111-1111-4111-8111-111111111111',
      status: 'cancelled',
      qrReady: false,
      createdAt: '2026-07-16T00:00:00.000Z',
      expiresAt: '2026-07-16T00:04:00.000Z',
    })
    const createObjectUrl = vi.fn(() => 'blob:knowledge-planet-qr')
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })

    render(<ConnectorsTab auth={auth} />)
    await screen.findByText('知识星球')
    expect(within(providerCard('知识星球')).getByText('隔离运行')).toBeInTheDocument()
    fireEvent.click(within(providerCard('知识星球')).getByRole('button', { name: '微信扫码授权' }))
    const dialog = await screen.findByRole('dialog')
    const start = within(dialog).getByRole('button', { name: '同意并生成二维码' })
    expect(start).toBeEnabled()
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument()
    fireEvent.click(start)

    expect(await within(dialog).findByAltText('知识星球微信登录二维码')).toHaveAttribute(
      'src',
      'blob:knowledge-planet-qr',
    )
    expect(mockedKnowledgeStart).toHaveBeenCalledWith(auth)
    expect(mockedKnowledgeQr).toHaveBeenCalledWith(auth, '11111111-1111-4111-8111-111111111111')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() =>
      expect(mockedKnowledgeCancel).toHaveBeenCalledWith(
        auth,
        '11111111-1111-4111-8111-111111111111',
      ),
    )
  })

  test('市场安装后一次性自动打开知识星球授权弹层', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    mockedPluginManagement.mockResolvedValue({ catalog: [knowledgePlanetPlugin()], accounts: [] })
    const consumed = vi.fn()

    render(
      <ConnectorsTab
        auth={auth}
        autoAuthorizePluginSlug="knowledge-planet"
        onAutoAuthorizeConsumed={consumed}
      />,
    )

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('授权知识星球')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '同意并生成二维码' })).toBeEnabled()
    expect(consumed).toHaveBeenCalledTimes(1)
  })

  test('扫码成功后刷新账号卡并保留明确成功态，直到用户点完成', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    mockedPluginManagement.mockResolvedValue({ catalog: [knowledgePlanetPlugin()], accounts: [] })
    mockedKnowledgeStart.mockResolvedValue({
      sessionId: '22222222-2222-4222-8222-222222222222',
      status: 'waiting_for_scan',
      qrReady: false,
      createdAt: '2026-07-17T00:00:00.000Z',
      expiresAt: '2026-07-17T00:04:00.000Z',
    })
    mockedKnowledgeStatus.mockResolvedValue({
      sessionId: '22222222-2222-4222-8222-222222222222',
      status: 'active',
      qrReady: false,
      createdAt: '2026-07-17T00:00:00.000Z',
      expiresAt: '2026-07-17T00:04:00.000Z',
      accountId: '902',
    })

    render(<ConnectorsTab auth={auth} />)
    await screen.findByText('知识星球')
    fireEvent.click(within(providerCard('知识星球')).getByRole('button', { name: '微信扫码授权' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: '同意并生成二维码',
      }),
    )

    const successDialog = screen.getByRole('dialog')
    expect(
      await within(successDialog).findByText(/授权成功，Agent 现在可以直接读取知识星球内容/),
    ).toBeInTheDocument()
    expect(
      await within(successDialog).findByText(/写入能力保持关闭/),
    ).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 1_300))
    expect(successDialog).toBeInTheDocument()
    fireEvent.click(within(successDialog).getByRole('button', { name: '完成' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mockedPluginManagement.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  test('实时展示扫码确认与加密保存阶段，旧版兼容登录成功后不谎报 Agent 已可用', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    mockedPluginManagement.mockResolvedValue({ catalog: [knowledgePlanetPlugin()], accounts: [] })
    const base = {
      sessionId: '25252525-2525-4252-8252-252525252525',
      qrReady: false,
      agentReady: false,
      createdAt: '2026-07-17T00:00:00.000Z',
      expiresAt: '2026-07-17T00:04:00.000Z',
    }
    mockedKnowledgeStart.mockResolvedValue({
      ...base,
      status: 'waiting_for_scan',
      phase: 'generating_qr',
    })
    mockedKnowledgeStatus
      .mockResolvedValueOnce({
        ...base,
        status: 'finalizing',
        phase: 'scan_confirmed',
      })
      .mockResolvedValueOnce({ ...base, status: 'finalizing', phase: 'saving' })
      .mockResolvedValue({
        ...base,
        status: 'active',
        phase: 'active',
        accountId: '925',
      })

    render(<ConnectorsTab auth={auth} />)
    await screen.findByText('知识星球')
    fireEvent.click(within(providerCard('知识星球')).getByRole('button', { name: '微信扫码授权' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '同意并生成二维码' }))

    expect(await within(dialog).findByText(/微信扫码已确认/)).toBeInTheDocument()
    expect(await within(dialog).findByText(/正在加密保存账号/)).toBeInTheDocument()
    expect(await within(dialog).findByText(/无需再次扫码/)).toBeInTheDocument()
    expect(screen.queryByText(/Agent 现在可以直接读取相关内容/)).not.toBeInTheDocument()
    expect(
      await within(dialog).findByText(/系统完成 Plugin 升级后会自动启用/),
    ).toBeInTheDocument()
    expect(dialog).toBeInTheDocument()
  })

  test('扫码状态因服务重启丢失时从账号权威恢复成功而不让用户空转', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    mockedPluginManagement
      .mockResolvedValueOnce({ catalog: [knowledgePlanetPlugin()], accounts: [] })
      .mockResolvedValue({
        catalog: [knowledgePlanetPlugin()],
        accounts: [
          {
            id: '903',
            provider: 'knowledge-planet',
            pluginType: 'managed-browser',
            displayName: '知识星球',
            accountHint: '微信扫码账号',
            status: 'active',
            actions: [{ id: 'list_groups', description: '列出星球', readOnly: true }],
            versionId: '101',
            executable: true,
            writeControl: knowledgePlanetWriteControl(),
          },
        ],
      })
    mockedKnowledgeStart.mockResolvedValue({
      sessionId: '33333333-3333-4333-8333-333333333333',
      status: 'waiting_for_scan',
      qrReady: false,
      createdAt: '2026-07-17T00:00:00.000Z',
      expiresAt: '2026-07-17T00:04:00.000Z',
    })
    mockedKnowledgeStatus.mockRejectedValue(
      new ApiError({ status: 404, code: 'SETUP_NOT_FOUND', message: 'missing' }),
    )

    render(<ConnectorsTab auth={auth} />)
    await screen.findByText('知识星球')
    fireEvent.click(within(providerCard('知识星球')).getByRole('button', { name: '微信扫码授权' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: '同意并生成二维码',
      }),
    )

    expect(
      await screen.findByText(/授权成功，Agent 现在可以直接读取知识星球内容/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/扫码会话已失效/)).not.toBeInTheDocument()
  })

  test('已授权的受管 Plugin 展示账号并在二次确认后走安全解绑端点', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    mockedPluginManagement.mockResolvedValue({
      catalog: [knowledgePlanetPlugin()],
      accounts: [
        {
          id: '901',
          provider: 'knowledge-planet',
          pluginType: 'managed-browser',
          displayName: '我的知识星球',
          accountHint: '微信扫码账号',
          status: 'active',
          actions: [{ id: 'list_groups', description: '列出星球', readOnly: true }],
          versionId: '101',
          executable: true,
          writeControl: knowledgePlanetWriteControl(),
        },
      ],
    })
    mockedPluginRevoke.mockResolvedValue(undefined)
    render(<ConnectorsTab auth={auth} />)

    await screen.findByText('微信扫码账号')
    const card = providerCard('知识星球')
    expect(within(card).getByText('已授权')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: '微信扫码授权' })).not.toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: '解绑' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/加密保存的登录状态会被销毁/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '解绑' }))

    await waitFor(() => expect(mockedPluginRevoke).toHaveBeenCalledWith(auth, '901'))
    await waitFor(() => expect(mockedPluginManagement).toHaveBeenCalledTimes(2))
  })

  test('写入默认关闭，必须阅读免责声明并勾选后才能精确开启', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    const disabledAccount: RuntimePluginAccount = {
      id: '905',
      provider: 'knowledge-planet',
      pluginType: 'managed-browser',
      displayName: '我的知识星球',
      accountHint: '微信扫码账号',
      status: 'active',
      actions: knowledgePlanetPlugin().actions,
      versionId: '101',
      executable: true,
      writeControl: knowledgePlanetWriteControl(),
    }
    const enabledControl = knowledgePlanetWriteControl({
      enabled: true,
      acceptedVersion: 1,
      acceptedAt: '2026-07-17T01:02:03.000Z',
    })
    mockedPluginManagement
      .mockResolvedValueOnce({ catalog: [knowledgePlanetPlugin()], accounts: [disabledAccount] })
      .mockResolvedValue({
        catalog: [knowledgePlanetPlugin()],
        accounts: [{ ...disabledAccount, writeControl: enabledControl }],
      })
    mockedSetPluginWriteAccess.mockResolvedValue(enabledControl)

    render(<ConnectorsTab auth={auth} />)
    const writeSwitch = await screen.findByRole('switch', {
      name: '我的知识星球写入能力',
    })
    expect(writeSwitch).not.toBeChecked()
    expect(screen.getByText('写入已关闭')).toBeInTheDocument()

    fireEvent.click(writeSwitch)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/写入会以你的真实身份发布到知识星球/)).toBeInTheDocument()
    const enable = within(dialog).getByRole('button', { name: '同意并开启' })
    expect(enable).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('checkbox'))
    expect(enable).toBeEnabled()
    fireEvent.click(enable)

    await waitFor(() =>
      expect(mockedSetPluginWriteAccess).toHaveBeenCalledWith(auth, '905', {
        enabled: true,
        accepted: true,
        disclaimerVersion: 1,
      }),
    )
    expect(await screen.findByText(/知识星球写入能力已开启/)).toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: '我的知识星球写入能力' }),
      ).toBeChecked(),
    )
  })

  test('免逐次确认默认关闭，必须接受独立免责声明后才能开启', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    const base = knowledgePlanetWriteControl({
      enabled: true,
      acceptedVersion: 1,
      acceptedAt: '2026-07-17T01:02:03.000Z',
    })
    const enabled = knowledgePlanetWriteControl({
      ...base,
      preapproval: {
        ...base.preapproval!,
        enabled: true,
        acceptedVersion: 1,
        acceptedAt: '2026-07-17T03:04:05.000Z',
      },
    })
    const account: RuntimePluginAccount = {
      id: '912',
      provider: 'knowledge-planet',
      pluginType: 'managed-browser',
      displayName: '免确认账号',
      accountHint: '微信扫码账号',
      status: 'active',
      actions: knowledgePlanetPlugin().actions,
      versionId: '101',
      executable: true,
      writeControl: base,
    }
    mockedPluginManagement
      .mockResolvedValueOnce({ catalog: [knowledgePlanetPlugin()], accounts: [account] })
      .mockResolvedValue({
        catalog: [knowledgePlanetPlugin()],
        accounts: [{ ...account, writeControl: enabled }],
      })
    mockedSetPluginWritePreapproval.mockResolvedValue(enabled)

    render(<ConnectorsTab auth={auth} />)
    const preapprovalSwitch = await screen.findByRole('switch', {
      name: '免确认账号免逐次确认',
    })
    expect(preapprovalSwitch).not.toBeChecked()
    fireEvent.click(preapprovalSwitch)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/永久删除/)).toBeInTheDocument()
    const enable = within(dialog).getByRole('button', { name: '同意并开启' })
    expect(enable).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(enable)

    await waitFor(() =>
      expect(mockedSetPluginWritePreapproval).toHaveBeenCalledWith(auth, '912', {
        enabled: true,
        accepted: true,
        disclaimerVersion: 1,
      }),
    )
    expect(await screen.findByText(/“免逐次确认”已开启/)).toBeInTheDocument()
  })

  test('开启写入失败时在免责声明弹层内说明错误且不乐观翻转', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    const account: RuntimePluginAccount = {
      id: '907',
      provider: 'knowledge-planet',
      pluginType: 'managed-browser',
      displayName: '失败探针账号',
      accountHint: '微信扫码账号',
      status: 'active',
      actions: knowledgePlanetPlugin().actions,
      versionId: '101',
      executable: true,
      writeControl: knowledgePlanetWriteControl(),
    }
    mockedPluginManagement.mockResolvedValue({
      catalog: [knowledgePlanetPlugin()],
      accounts: [account],
    })
    mockedSetPluginWriteAccess.mockRejectedValue(
      new ApiError({ status: 409, code: 'WRITE_DISABLED', message: 'failed' }),
    )

    render(<ConnectorsTab auth={auth} />)
    const writeSwitch = await screen.findByRole('switch', {
      name: '失败探针账号写入能力',
    })
    fireEvent.click(writeSwitch)
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: '同意并开启' }))

    expect(
      await within(dialog).findByText(
        '写入能力尚未开启，请先在 Plugin 账号中阅读免责声明并开启',
      ),
    ).toBeInTheDocument()
    expect(writeSwitch).not.toBeChecked()
    expect(dialog).toBeInTheDocument()
  })

  test('关闭写入无需再次接受条款，失败时不乐观翻转界面', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    const enabledControl = knowledgePlanetWriteControl({
      enabled: true,
      acceptedVersion: 1,
      acceptedAt: '2026-07-17T01:02:03.000Z',
    })
    const account: RuntimePluginAccount = {
      id: '906',
      provider: 'knowledge-planet',
      pluginType: 'managed-browser',
      displayName: '发布账号',
      accountHint: '微信扫码账号',
      status: 'active',
      actions: knowledgePlanetPlugin().actions,
      versionId: '101',
      executable: true,
      writeControl: enabledControl,
    }
    mockedPluginManagement.mockResolvedValue({
      catalog: [knowledgePlanetPlugin()],
      accounts: [account],
    })
    mockedSetPluginWriteAccess.mockRejectedValue(
      new ApiError({ status: 409, code: 'WRITE_DISABLED', message: 'failed' }),
    )

    render(<ConnectorsTab auth={auth} />)
    const writeSwitch = await screen.findByRole('switch', { name: '发布账号写入能力' })
    expect(writeSwitch).toBeChecked()
    fireEvent.click(writeSwitch)

    await waitFor(() =>
      expect(mockedSetPluginWriteAccess).toHaveBeenCalledWith(auth, '906', { enabled: false }),
    )
    expect(
      await screen.findByText('写入能力尚未开启，请先在 Plugin 账号中阅读免责声明并开启'),
    ).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '发布账号写入能力' })).toBeChecked()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('无人值守自动回复默认关闭，必须独立阅读免责声明并勾选后才能开启', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    const account: RuntimePluginAccount = {
      id: '908',
      provider: 'knowledge-planet',
      pluginType: 'managed-browser',
      displayName: '自动回复账号',
      accountHint: '微信扫码账号',
      status: 'active',
      actions: knowledgePlanetPlugin().actions,
      versionId: '101',
      executable: true,
      writeControl: knowledgePlanetWriteControl({
        enabled: true,
        acceptedVersion: 1,
        acceptedAt: '2026-07-17T01:02:03.000Z',
      }),
    }
    mockedPluginManagement.mockResolvedValue({
      catalog: [knowledgePlanetPlugin()],
      accounts: [account],
    })
    const disabledView = {
      control: {
        available: true,
        enabled: false,
        disclaimerVersion: 1,
        acceptedVersion: null,
        acceptedAt: null,
        disclaimerText: '无人值守会自动计费并发布带 AI 标识的文字回复。',
        accountDailyLimit: 10,
        pausedReason: null,
      },
      rules: [],
      recentRuns: [],
    }
    mockedGetKnowledgePlanetAutomation
      .mockResolvedValueOnce(disabledView)
      .mockResolvedValue({
        ...disabledView,
        control: {
          ...disabledView.control,
          enabled: true,
          acceptedVersion: 1,
          acceptedAt: '2026-07-17T02:03:04.000Z',
          accountDailyLimit: 12,
        },
      })

    render(<ConnectorsTab auth={auth} />)
    const automationSwitch = await screen.findByRole('switch', {
      name: '知识星球无人值守自动回复',
    })
    expect(automationSwitch).not.toBeChecked()
    fireEvent.click(automationSwitch)

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/自动计费并发布带 AI 标识/)).toBeInTheDocument()
    const enable = within(dialog).getByRole('button', { name: '同意并开启' })
    expect(enable).toBeDisabled()
    fireEvent.change(within(dialog).getByRole('spinbutton'), { target: { value: '12' } })
    fireEvent.click(within(dialog).getByRole('checkbox'))
    expect(enable).toBeEnabled()
    fireEvent.click(enable)

    await waitFor(() =>
      expect(mockedSetKnowledgePlanetAutomation).toHaveBeenCalledWith(auth, '908', {
        enabled: true,
        accepted: true,
        disclaimerVersion: 1,
        accountDailyLimit: 12,
      }),
    )
    await waitFor(() => expect(automationSwitch).toBeChecked())
  })

  test('自动回复可从实时星球下拉多选并原子创建已启用规则', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    const account: RuntimePluginAccount = {
      id: '909',
      provider: 'knowledge-planet',
      pluginType: 'managed-browser',
      displayName: '规则账号',
      accountHint: '微信扫码账号',
      status: 'active',
      actions: knowledgePlanetPlugin().actions,
      versionId: '101',
      executable: true,
      writeControl: knowledgePlanetWriteControl({
        enabled: true,
        acceptedVersion: 1,
        acceptedAt: '2026-07-17T01:02:03.000Z',
      }),
    }
    const rule = {
      id: '11111111-1111-4111-8111-111111111111',
      groupId: '12345678901234',
      name: '回答新提问',
      instructions: '仅在能够确定答案时简洁回复，不确定就跳过。',
      triggerKind: 'new_question' as const,
      enabled: true,
      dailyLimit: 3,
      cooldownMinutes: 20,
      maxReplyChars: 600,
      consecutiveFailures: 0,
      pausedReason: null,
      lastCursorAt: '2026-07-17T02:03:04.000Z',
      nextRunAt: '2026-07-17T02:03:04.000Z',
      createdAt: '2026-07-17T02:03:04.000Z',
      updatedAt: '2026-07-17T02:03:04.000Z',
    }
    const secondRule = {
      ...rule,
      id: '123e4567-e89b-42d3-a456-426614174002',
      groupId: '22345678901234',
    }
    mockedPluginManagement.mockResolvedValue({
      catalog: [knowledgePlanetPlugin()],
      accounts: [account],
    })
    const baseView = {
      control: {
        available: true,
        enabled: true,
        disclaimerVersion: 1,
        acceptedVersion: 1,
        acceptedAt: '2026-07-17T02:03:04.000Z',
        disclaimerText: '无人值守会自动计费并发布带 AI 标识的文字回复。',
        accountDailyLimit: 10,
        pausedReason: null,
      },
      rules: [],
      recentRuns: [],
    }
    mockedGetKnowledgePlanetAutomation
      .mockResolvedValueOnce(baseView)
      .mockResolvedValue({ ...baseView, rules: [rule, secondRule] })
    mockedCreateKnowledgePlanetRulesBatch.mockResolvedValue([rule, secondRule])

    render(<ConnectorsTab auth={auth} />)
    fireEvent.click(await screen.findByRole('button', { name: '添加规则' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(
      within(dialog).getByRole('button', { name: /从当前账号已加入的星球中选择/ }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /产品交流星球/ }))
    fireEvent.click(await screen.findByRole('button', { name: /内部测试星球/ }))
    fireEvent.change(within(dialog).getByLabelText('规则名称'), {
      target: { value: '回答新提问' },
    })
    fireEvent.change(within(dialog).getByLabelText('回复要求'), {
      target: { value: '仅在能够确定答案时简洁回复，不确定就跳过。' },
    })
    fireEvent.change(within(dialog).getByLabelText('触发范围'), {
      target: { value: 'new_question' },
    })
    const numbers = within(dialog).getAllByRole('spinbutton')
    fireEvent.change(numbers[0]!, { target: { value: '3' } })
    fireEvent.change(numbers[1]!, { target: { value: '20' } })
    fireEvent.change(numbers[2]!, { target: { value: '600' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存并启用 2 条规则' }))

    await waitFor(() =>
      expect(mockedCreateKnowledgePlanetRulesBatch).toHaveBeenCalledWith(auth, '909', {
        groupIds: ['12345678901234', '22345678901234'],
        name: '回答新提问',
        instructions: '仅在能够确定答案时简洁回复，不确定就跳过。',
        triggerKind: 'new_question',
        dailyLimit: 3,
        cooldownMinutes: 20,
        maxReplyChars: 600,
      }),
    )
    expect(
      await screen.findByRole('switch', {
        name: '回答新提问（产品交流星球）自动回复规则',
      }),
    ).toBeChecked()
    expect(
      screen.getByRole('switch', {
        name: '回答新提问（内部测试星球）自动回复规则',
      }),
    ).toBeChecked()
    expect(screen.getByText(/产品交流星球/)).toBeInTheDocument()
    expect(mockedPatchKnowledgePlanetRule).not.toHaveBeenCalled()
  })

  test('授权成功提示在解绑时立即清除，解绑后无需刷新即可重新发起扫码', async () => {
    mockedGetConnectors.mockResolvedValue(catalog())
    const account = {
      id: '904',
      provider: 'knowledge-planet',
      pluginType: 'managed-browser' as const,
      displayName: '我的知识星球',
      accountHint: '微信扫码账号',
      status: 'active' as const,
      actions: [{ id: 'list_groups', description: '列出星球', readOnly: true as const }],
      versionId: '101',
      executable: true,
      writeControl: knowledgePlanetWriteControl(),
    }
    mockedPluginManagement
      .mockResolvedValueOnce({ catalog: [knowledgePlanetPlugin()], accounts: [] })
      .mockResolvedValueOnce({ catalog: [knowledgePlanetPlugin()], accounts: [account] })
      .mockResolvedValue({ catalog: [knowledgePlanetPlugin()], accounts: [] })
    mockedKnowledgeStart.mockResolvedValue({
      sessionId: '44444444-4444-4444-8444-444444444444',
      status: 'waiting_for_scan',
      qrReady: false,
      createdAt: '2026-07-17T00:00:00.000Z',
      expiresAt: '2026-07-17T00:04:00.000Z',
    })
    mockedKnowledgeStatus.mockResolvedValue({
      sessionId: '44444444-4444-4444-8444-444444444444',
      status: 'active',
      qrReady: false,
      createdAt: '2026-07-17T00:00:00.000Z',
      expiresAt: '2026-07-17T00:04:00.000Z',
      accountId: account.id,
    })
    mockedPluginRevoke.mockResolvedValue(undefined)

    render(<ConnectorsTab auth={auth} />)
    await screen.findByText('知识星球')
    fireEvent.click(within(providerCard('知识星球')).getByRole('button', { name: '微信扫码授权' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: '同意并生成二维码',
      }),
    )
    expect(await screen.findByText(/Agent 现在可以直接读取相关内容/)).toBeInTheDocument()
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: '完成',
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const boundCard = providerCard('知识星球')
    fireEvent.click(within(boundCard).getByRole('button', { name: '解绑' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: '解绑' }),
    )
    await waitFor(() =>
      expect(screen.queryByText(/Agent 现在可以直接读取相关内容/)).not.toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(
        within(providerCard('知识星球')).getByRole('button', { name: '微信扫码授权' }),
      ).toBeEnabled(),
    )
    fireEvent.click(
      within(providerCard('知识星球')).getByRole('button', { name: '微信扫码授权' }),
    )
    expect(await screen.findByRole('dialog')).toHaveTextContent('授权知识星球')
  })
})
