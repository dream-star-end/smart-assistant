import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../../lib/authSession";
import type { AuthSession, OrgMember } from "../../lib/types";

vi.mock("../../lib/api", () => ({
  api: {
    listOrgMembers: vi.fn(),
    listOrgInvitations: vi.fn(),
    patchOrgMember: vi.fn(),
    removeOrgMember: vi.fn(),
    createOrgInvitation: vi.fn(),
    revokeOrgInvitation: vi.fn(),
  },
  apiErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

import { api } from "../../lib/api";
import { MEMBER_SEARCH_THRESHOLD, MembersTab, filterMembers } from "./MembersTab";

const auth: AuthSession = createMemoryAuthSession(() => {}, "t");

function mkMember(i: number, over: Partial<OrgMember> = {}): OrgMember {
  return {
    user_id: `u${i}`,
    email: `user${i}@example.com`,
    display_name: `成员${i}`,
    org_role: i === 0 ? "owner" : "member",
    status: "active",
    billing_enabled: true,
    billing_delegate: false,
    monthly_org_budget: null,
    month_org_spent: "0",
    user_status: "active",
    invited_by: null,
    joined_at: "2026-07-01T08:00:00.000Z",
    ...over,
  };
}

describe("filterMembers（客户端成员搜索）", () => {
  const members = [
    mkMember(0, { display_name: "Alice Zhang", email: "alice@corp.cn" }),
    mkMember(1, { display_name: null, email: "bob@corp.cn" }),
    mkMember(2, { display_name: "王小明", email: "xm@corp.cn" }),
  ];

  test("空 query 原样返回", () => {
    expect(filterMembers(members, "")).toBe(members);
    expect(filterMembers(members, "   ")).toBe(members);
  });

  test("按显示名 / 邮箱大小写不敏感子串匹配，display_name 为 null 不抛", () => {
    expect(filterMembers(members, "ALICE").map((m) => m.user_id)).toEqual(["u0"]);
    expect(filterMembers(members, "bob").map((m) => m.user_id)).toEqual(["u1"]);
    expect(filterMembers(members, "小明").map((m) => m.user_id)).toEqual(["u2"]);
    expect(filterMembers(members, "corp.cn")).toHaveLength(3);
    expect(filterMembers(members, "nobody")).toEqual([]);
  });
});

describe("MembersTab 成员列表", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listOrgInvitations).mockResolvedValue([]);
  });
  afterEach(cleanup);

  test("成员 ≤ 阈值：无搜索框、无分页；邮箱与加入时间分两行", async () => {
    vi.mocked(api.listOrgMembers).mockResolvedValue([mkMember(0), mkMember(1)]);
    render(<MembersTab auth={auth} callerRole="owner" />);
    expect(await screen.findByText("成员（2）")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "搜索成员" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("pager-成员")).not.toBeInTheDocument();
    // 审计 SET-38：此前「邮箱 · 加入 时间」挤在一行 truncate，移动端加入时间被省略号吃掉。
    expect(screen.getByText("user1@example.com")).toBeInTheDocument();
    expect(screen.getAllByText(/^加入 /).length).toBe(2);
    expect(screen.queryByText(/user1@example\.com · 加入/)).not.toBeInTheDocument();
  });

  test("成员 > 阈值：搜索框过滤 + 本地分页（每页 10）", async () => {
    const many = Array.from({ length: MEMBER_SEARCH_THRESHOLD + 5 }, (_, i) => mkMember(i));
    vi.mocked(api.listOrgMembers).mockResolvedValue(many);
    render(<MembersTab auth={auth} callerRole="owner" />);
    expect(await screen.findByText(`成员（${many.length}）`)).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "搜索成员" });
    // 第一页 10 行，分页条出现
    expect(screen.getByTestId("pager-成员")).toHaveTextContent("第 1/2 页");
    expect(screen.getByText("成员9")).toBeInTheDocument();
    expect(screen.queryByText("成员10")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "成员·下一页" }));
    expect(screen.getByText("成员10")).toBeInTheDocument();
    // 搜索缩到一行，分页条自动消失，摘要给出匹配数
    fireEvent.change(search, { target: { value: "user12@" } });
    expect(screen.getByTestId("member-search-summary")).toHaveTextContent("匹配 1 / 15 位成员");
    expect(screen.getByText("成员12")).toBeInTheDocument();
    expect(screen.queryByText("成员9")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pager-成员")).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "nobody" } });
    expect(screen.getByText("没有匹配的成员。")).toBeInTheDocument();
  });

  test("owner 看到的角色下拉是 ui/Select（原生 select 已替换），改选即 patch", async () => {
    vi.mocked(api.listOrgMembers).mockResolvedValue([mkMember(0), mkMember(1)]);
    vi.mocked(api.patchOrgMember).mockResolvedValue(undefined as never);
    render(<MembersTab auth={auth} callerRole="owner" />);
    await screen.findByText("成员（2）");
    const roleSelect = screen.getByRole("combobox", { name: "角色 · 成员1" });
    expect(roleSelect.tagName).toBe("SELECT");
    // ui/Select：自绘箭头 + 触屏 44px 兜底类来自共用 controlSurfaceClass
    expect(roleSelect).toHaveClass("appearance-none");
    fireEvent.change(roleSelect, { target: { value: "admin" } });
    expect(api.patchOrgMember).toHaveBeenCalledWith(auth, "u1", { org_role: "admin" });
    expect(screen.getByRole("combobox", { name: "邀请角色" })).toHaveValue("member");
    // 邀请邮箱此前只有 placeholder：一输入就消失，也不是可访问名（t-762 settings#2）。
    const inviteEmail = screen.getByRole("textbox", { name: "成员邮箱" });
    expect(inviteEmail).toHaveAttribute("placeholder", "成员邮箱");
    fireEvent.change(inviteEmail, { target: { value: "new@example.com" } });
    expect(screen.getByRole("textbox", { name: "成员邮箱" })).toHaveValue("new@example.com");
  });

  test("非 owner 的「组织结算」开关禁用并说明原因（审计 SET-40）", async () => {
    vi.mocked(api.listOrgMembers).mockResolvedValue([mkMember(0), mkMember(1)]);
    render(<MembersTab auth={auth} callerRole="admin" />);
    await screen.findByText("成员（2）");
    const switches = screen.getAllByRole("switch", { name: "组织结算" });
    expect(switches.length).toBe(2);
    for (const sw of switches) {
      expect(sw).toBeDisabled();
      const label = sw.closest("label");
      expect(label).toHaveAttribute("title", "仅组织拥有者可更改组织结算");
      expect(within(label as HTMLElement).getByText("（仅拥有者可改）")).toBeInTheDocument();
    }
    // admin 看不到角色下拉
    expect(screen.queryByRole("combobox", { name: /^角色 · / })).not.toBeInTheDocument();
  });
});
