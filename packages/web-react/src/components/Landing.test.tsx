import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../lib/api";
import { Landing } from "./Landing";

const base = { theme: "light" as const, onCycleTheme: () => {}, onCreateOrg: () => {} };

beforeEach(() => {
  // 企业区块挂载即拉公开档位锚点价;默认桩返回空,走静态兜底,避免真实网络。
  vi.spyOn(api, "listOrgPlansPublic").mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Landing 落地页", () => {
  test("叙事 / 动态演示 / 对比区 / 快速上手 / FAQ 均呈现，定价区已移除", () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />);

    // 叙事主题（对比区副文案保留该锚点）
    expect(screen.getByText(/越用越好用，越用越懂你/)).toBeInTheDocument();
    // 动态演示：首个真实公开案例的用户提问 + 成果面板交付物均立即可见
    expect(screen.getAllByText(/修仙割草游戏/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("《万劫问仙》· 公网游戏")).toBeInTheDocument();
    // 差异化对比区
    expect(screen.getByText("不是又一个聊天机器人")).toBeInTheDocument();
    // 快速上手：三步 + 可复制「开口第一句」
    expect(screen.getByText(/三步开始，一分钟上手/)).toBeInTheDocument();
    expect(screen.getByText(/开口第一句，照抄就行/)).toBeInTheDocument();
    expect(screen.getAllByTitle("点击复制").length).toBeGreaterThan(4);
    // FAQ 信任区（nav/footer 链接 + 区标题，故用 getAllBy）
    expect(screen.getAllByText("常见问题").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("需要会写提示词吗？")).toBeInTheDocument();
    // 包月套餐说明已按要求移除
    expect(screen.queryByText(/包月套餐/)).toBeNull();
    expect(screen.queryByText("¥88")).toBeNull();
    // 「无需信用卡」已按要求移除
    expect(screen.queryByText(/无需信用卡/)).toBeNull();
  });

  test("nav「登录」触发 onLogin；「免费开始」触发 onStart", () => {
    const onStart = vi.fn();
    const onLogin = vi.fn();
    render(<Landing {...base} onStart={onStart} onLogin={onLogin} />);

    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(onLogin).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole("button", { name: /免费开始/ })[0]);
    expect(onStart).toHaveBeenCalled();
  });

  test("移动导航可展开全部入口，导航与 CTA 操作后自动收起", () => {
    const onStart = vi.fn();
    const onLogin = vi.fn();
    render(<Landing {...base} onStart={onStart} onLogin={onLogin} />);

    const menu = screen.getByRole("button", { name: "打开导航菜单" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(menu);

    const mobileNav = document.getElementById("landing-mobile-nav");
    expect(mobileNav).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭导航菜单" })).toHaveAttribute("aria-expanded", "true");
    const nav = within(mobileNav!);
    for (const label of ["演示", "智能体", "快速上手", "企业版", "常见问题"]) {
      expect(nav.getByRole("link", { name: label })).toBeInTheDocument();
    }

    fireEvent.click(nav.getByRole("link", { name: "智能体" }));
    expect(document.getElementById("landing-mobile-nav")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "打开导航菜单" }));
    fireEvent.click(within(document.getElementById("landing-mobile-nav")!).getByRole("button", { name: "登录" }));
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(document.getElementById("landing-mobile-nav")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "打开导航菜单" }));
    fireEvent.click(within(document.getElementById("landing-mobile-nav")!).getByRole("button", { name: "免费开始" }));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(document.getElementById("landing-mobile-nav")).toBeNull();
  });

  test("主标题渐变句独占一行且手机字号不挤压", () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveClass("text-[36px]", "sm:text-[40px]", "md:text-[60px]");
    expect(heading.querySelector("br")).toBeNull();
    expect(screen.getByText("拿回能直接用的成果")).toHaveClass("block");
  });
});

describe("Landing 企业 / 团队版区块", () => {
  test("卖点与示意可视元素呈现，且不出现折扣/优惠字样", () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />);

    // 区块标题 + 四卖点
    expect(screen.getByText("团队一起用，积分池共享不浪费")).toBeInTheDocument();
    expect(screen.getByText("席位共享积分池")).toBeInTheDocument();
    expect(screen.getByText("成员与角色管理")).toBeInTheDocument();
    expect(screen.getByText("组织报表与发票")).toBeInTheDocument();
    expect(screen.getByText("自助开通即用")).toBeInTheDocument();
    // 虚构示意元素显式标注「示意数据」，绝不冒充真实用量
    expect(screen.getByText("示意数据")).toBeInTheDocument();
    expect(screen.getByText(/以上为示意数据，非真实用量/)).toBeInTheDocument();
    // 不打价格差：无「折扣 / 优惠 / 9 折」话术
    expect(screen.queryByText(/折扣|优惠|9\s*折/)).toBeNull();
  });

  test("拉不到公开档位 → 锚点走静态兜底「¥88/席起」", async () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />);
    expect(await screen.findByText("¥88/席起")).toBeInTheDocument();
  });

  test("公开档位可用 → 锚点显示最低每席价", async () => {
    vi.spyOn(api, "listOrgPlansPublic").mockResolvedValue([
      { code: "org-pro", name: "企业·专业", seatPriceCents: "8800", perSeatCredits: "0", minSeats: 3, periodDays: 30 },
      { code: "org-max", name: "企业·旗舰", seatPriceCents: "29800", perSeatCredits: "0", minSeats: 3, periodDays: 30 },
    ]);
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />);
    expect(await screen.findByText("¥88/席起")).toBeInTheDocument();
  });

  test("CTA「创建组织」触发 onCreateOrg", () => {
    const onCreateOrg = vi.fn();
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} onCreateOrg={onCreateOrg} />);
    fireEvent.click(screen.getByRole("button", { name: /创建组织/ }));
    expect(onCreateOrg).toHaveBeenCalledTimes(1);
  });
});
