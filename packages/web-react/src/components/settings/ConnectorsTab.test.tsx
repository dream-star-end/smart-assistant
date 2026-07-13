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
} from "../../lib/connectors";
import type { AuthSession } from "../../lib/types";
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
      bindDeclarativeConnector: vi.fn(),
      startDeclarativeOauth: vi.fn(),
      unbindDeclarativeConnector: vi.fn(),
    },
  };
});

import { api, ApiError } from "../../lib/api";

const mockedGetConnectors = vi.mocked(api.getConnectors);
const mockedBind = vi.mocked(api.bindConnector);
const mockedOAuthStart = vi.mocked(api.startConnectorOAuth);
const mockedGithubStart = vi.mocked(api.startGithubOAuth);
const mockedRename = vi.mocked(api.renameConnector);
const mockedDelete = vi.mocked(api.deleteConnector);
const mockedDeclCatalog = vi.mocked(api.getDeclarativeCatalog);
const mockedDeclConnections = vi.mocked(api.getDeclarativeConnections);
const mockedDeclBind = vi.mocked(api.bindDeclarativeConnector);
const mockedDeclOauthStart = vi.mocked(api.startDeclarativeOauth);
const mockedDeclUnbind = vi.mocked(api.unbindDeclarativeConnector);

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  // 声明式默认降级为空（现有 v1 用例不受第二套后端影响）；声明式用例各自 override。
  mockedDeclCatalog.mockResolvedValue({ connectors: [] });
  mockedDeclConnections.mockResolvedValue({ connections: [] });
});

const auth: AuthSession = {
  getToken: () => "t",
  setToken: () => {},
  onExpired: () => {},
};

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

    expect(await screen.findByText("WebDAV 网盘")).toBeInTheDocument();
    for (const p of PROVIDERS) expect(screen.getByText(p.label)).toBeInTheDocument();
    expect(screen.queryByText("加载应用连接失败")).not.toBeInTheDocument();
    warn.mockRestore();
  });
});
