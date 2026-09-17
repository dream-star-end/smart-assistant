import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCT_CAPABILITIES,
  type ProductCapability,
  type ProductFeatureId,
} from "../lib/productCapabilities";
import type { TutorialCaseId } from "../lib/tutorialCaseCatalog";
import { api } from "../lib/api";
import { TUTORIAL_PENDING_CAPTURE_LABEL, TUTORIAL_SCENARIO_PATHS } from "../lib/tutorialJourneys";
import { SIGNATURE_WORKS } from "../lib/tutorialSignatureWorks";
import { TutorialCenter } from "./TutorialCenter";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

/** radix DropdownMenu Trigger 在 pointerdown 开启（click 不够），jsdom 里直接发。 */
function openHelpMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: /帮助与创作/ }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

function pickHelpMenu(name: string) {
  openHelpMenu();
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

function Harness({
  initial = PRODUCT_CAPABILITIES.chatBasics.id,
  enabled = true,
  onRun = vi.fn<(feature: ProductCapability) => void>(),
}: {
  initial?: ProductFeatureId;
  enabled?: boolean;
  onRun?: (feature: ProductCapability) => void;
}) {
  const [topic, setTopic] = useState<ProductFeatureId>(initial);
  return (
    <TutorialCenter
      open
      topicId={topic}
      onTopicChange={setTopic}
      onClose={() => {}}
      actionState={() =>
        enabled
          ? { enabled: true, label: "回到功能位置" }
          : {
              enabled: false,
              label: "打开组织中心",
              disabledReason: "只有组织管理员可以进入。",
            }
      }
      onRunAction={onRun}
    />
  );
}

function CaseHarness({
  initial = null,
  onRunCase = () => {},
}: {
  initial?: TutorialCaseId | null;
  onRunCase?: React.ComponentProps<typeof TutorialCenter>["onRunCase"];
}) {
  const [caseId, setCaseId] = useState<TutorialCaseId | null>(initial);
  const [topicId, setTopicId] = useState<ProductFeatureId | null>(null);
  return (
    <TutorialCenter
      open
      topicId={topicId}
      caseId={caseId}
      onTopicChange={(id) => {
        setTopicId(id);
        setCaseId(null);
      }}
      onCaseChange={(id) => {
        setCaseId(id);
        setTopicId(null);
      }}
      onShowCaseGallery={() => {
        setCaseId(null);
        setTopicId(null);
      }}
      caseActionLabel="带着指令去对话"
      onRunCase={onRunCase}
      onClose={() => {}}
      actionState={() => ({ enabled: true, label: "回到功能位置" })}
      onRunAction={() => {}}
    />
  );
}

describe("TutorialCenter", () => {
  it("默认成果展厅只展示有产物的精选实作，不再平铺教程和待采集脚本", () => {
    render(<CaseHarness />);
    expect(screen.getByRole("heading", { name: /让它做给你看/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^查看成果：/ })).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "10 分钟走完第一次任务" })).not.toBeInTheDocument();
    expect(screen.queryByText(TUTORIAL_PENDING_CAPTURE_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("已读");
    expect(screen.getByText(/不是完整会话回放/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /^查看成果：/ })[0]);
    expect(screen.getByRole("button", { name: "打开交互看板" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回案例展厅" }));
    expect(screen.getByRole("heading", { name: /让它做给你看/ })).toBeInTheDocument();
  });

  it("快速上手是一级页签，仍可进入功能详情", () => {
    render(<CaseHarness />);
    fireEvent.click(screen.getByRole("button", { name: "快速上手" }));
    expect(screen.getByRole("heading", { name: "10 分钟走完第一次任务" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开步骤：发第一个任务" }));
    expect(screen.getByRole("heading", { name: "开始一场高质量对话" })).toBeInTheDocument();
  });

  it("快速上手底部兑现 5 条按场景学习路径，点章节即打开功能参考（TU-14）", () => {
    render(<CaseHarness />);
    fireEvent.click(screen.getByRole("button", { name: "快速上手" }));
    for (const path of TUTORIAL_SCENARIO_PATHS) {
      expect(screen.getByRole("heading", { name: path.title })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: /GitHub 仓库/ }));
    expect(screen.getByRole("heading", { name: "连接 GitHub 仓库协作开发" })).toBeInTheDocument();
  });

  it("「功能参考」有一级入口，点别的页签后再点它回到上次看的那篇（TU-01）", () => {
    render(<CaseHarness />);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "功能参考" }));
    expect(screen.getByRole("heading", { name: "开始一场高质量对话" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "搜索教程" })).toBeInTheDocument();
    // 换一篇，再去别处，再回来：应当回到「GitHub 仓库」而不是永远回到默认的「对话入门」。
    fireEvent.click(screen.getAllByRole("button", { name: /GitHub 仓库/ })[0]);
    expect(screen.getByRole("heading", { name: "连接 GitHub 仓库协作开发" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "案例展厅" }));
    expect(screen.getByRole("heading", { name: /让它做给你看/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "功能参考" }));
    expect(screen.getByRole("heading", { name: "连接 GitHub 仓库协作开发" })).toBeInTheDocument();
  });

  it("精选作品详情受控于教程中心：点「案例展厅」页签能回到画廊，标题随作品变化（TU-02）", () => {
    render(<CaseHarness />);
    fireEvent.click(screen.getByRole("button", { name: SIGNATURE_WORKS[0].action }));
    expect(screen.getByRole("heading", { level: 1, name: SIGNATURE_WORKS[0].title })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: SIGNATURE_WORKS[0].title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "案例展厅" }));
    expect(screen.getByRole("heading", { name: /让它做给你看/ })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "案例展厅" })).toBeInTheDocument();
  });

  it("一级页签与精选作品可受控：browseView / signatureWorkId 由外部给定并回调，页签切换不再只活在内部 state（TU-17）", () => {
    const onBrowseViewChange = vi.fn();
    const onSignatureWorkChange = vi.fn();
    const { rerender } = render(
      <TutorialCenter
        open
        topicId={null}
        browseView="start"
        onBrowseViewChange={onBrowseViewChange}
        signatureWorkId={null}
        onSignatureWorkChange={onSignatureWorkChange}
        onTopicChange={() => {}}
        onClose={() => {}}
        actionState={() => ({ enabled: true, label: "回到功能位置" })}
        onRunAction={() => {}}
      />,
    );
    // 直接落在快速上手，不需要先点页签（`?panel=help&tab=start`）。
    expect(screen.getByRole("heading", { name: "10 分钟走完第一次任务" })).toBeInTheDocument();
    pickHelpMenu("案例脚本");
    expect(onBrowseViewChange).toHaveBeenLastCalledWith("cases");
    // 受控：父级没改 prop 前视图不动；父级改成作品详情后直接渲染那件作品（`&work=planet`）。
    expect(screen.getByRole("heading", { name: "10 分钟走完第一次任务" })).toBeInTheDocument();
    rerender(
      <TutorialCenter
        open
        topicId={null}
        browseView="showcase"
        onBrowseViewChange={onBrowseViewChange}
        signatureWorkId={SIGNATURE_WORKS[0].id}
        onSignatureWorkChange={onSignatureWorkChange}
        onTopicChange={() => {}}
        onClose={() => {}}
        actionState={() => ({ enabled: true, label: "回到功能位置" })}
        onRunAction={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: SIGNATURE_WORKS[0].title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回案例展厅" }));
    expect(onSignatureWorkChange).toHaveBeenLastCalledWith(null);
  });

  it("功能教程带 step 深链：目标步骤标 aria-current 并拿到焦点，越界的 step 不抛错也不标记（TU-17）", async () => {
    const { rerender } = render(
      <TutorialCenter
        open
        topicId={PRODUCT_CAPABILITIES.chatBasics.id}
        stepIndex={3}
        onTopicChange={() => {}}
        onClose={() => {}}
        actionState={() => ({ enabled: true, label: "回到功能位置" })}
        onRunAction={() => {}}
      />,
    );
    const steps = screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-tutorial-step"));
    expect(steps.length).toBeGreaterThanOrEqual(4);
    const target = steps.find((li) => li.getAttribute("data-tutorial-step") === "3");
    expect(target).toBeDefined();
    expect(target).toHaveAttribute("aria-current", "step");
    expect(target).toHaveAttribute("id", "tutorial-step-3");
    // 开场自动聚焦（Radix 下一次提交才跑）与本组件的 step 聚焦都落到这一步，而不是对话框本体。
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(steps.filter((li) => li.getAttribute("aria-current") === "step")).toHaveLength(1);

    rerender(
      <TutorialCenter
        open
        topicId={PRODUCT_CAPABILITIES.chatBasics.id}
        stepIndex={42}
        onTopicChange={() => {}}
        onClose={() => {}}
        actionState={() => ({ enabled: true, label: "回到功能位置" })}
        onRunAction={() => {}}
      />,
    );
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
  });

  it("hero 表面走模块级 token：品牌深蓝不再以写死的十六进制出现在 className 里（TU-34）", () => {
    render(<CaseHarness />);
    const heroes = document.querySelectorAll<HTMLElement>("[data-tutorial-hero]");
    expect(heroes.length).toBeGreaterThan(0);
    for (const hero of heroes) {
      expect(hero.className).toMatch(/\[--hero-bg:#/);
      expect(hero.className).toMatch(/dark:\[--hero-bg:#/);
      expect(hero.className).toContain("bg-(--hero-bg)");
      expect(hero.className).not.toMatch(/bg-\[#[0-9a-f]{6}\]/i);
    }
    // 案例脚本总览的 hero 同样不再写死。
    pickHelpMenu("案例脚本");
    const casesHero = document.querySelector<HTMLElement>('[data-tutorial-hero="cases"]');
    expect(casesHero).not.toBeNull();
    expect(casesHero?.className).toContain("bg-(--hero-bg)");
    expect(casesHero?.className).not.toMatch(/bg-\[#/);
  });

  it("「帮助与创作」是真正的菜单：Esc 关闭、菜单项带 menuitem 语义（TU-03）", () => {
    render(<CaseHarness />);
    openHelpMenu();
    expect(screen.getByRole("menuitem", { name: "教程工作室" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "案例脚本" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menuitem", { name: "案例脚本" })).not.toBeInTheDocument();
  });

  it("案例列表与详情用用户语言声明「尚无真实运行记录」，且详情页只说一次（TU-10）", () => {
    render(<CaseHarness />);
    pickHelpMenu("案例脚本");
    const pending = screen.getAllByText(TUTORIAL_PENDING_CAPTURE_LABEL);
    expect(pending.length).toBeGreaterThanOrEqual(12);
    expect(screen.getByRole("heading", { name: "这些是任务脚本，还没有真实运行记录" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("待采集");
    expect(document.body.textContent).not.toContain("先看完整故事");
    expect(screen.queryByRole("list", { name: "案例结果" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /从 30 篇论文到可追溯证据图谱/ }));
    expect(screen.getByRole("heading", { name: "从 30 篇论文到可追溯证据图谱" })).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(TUTORIAL_PENDING_CAPTURE_LABEL))).toHaveLength(1);
    expect(document.body.textContent).not.toContain("待采集");
    // 成果预览是示意图，不能当成本案例真实产物播报（TU-16）。
    expect(screen.getByText("示意图 · 非本案例实际产物")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^示意：/ })).toBeInTheDocument();
  });

  it("案例脚本总览可按分类与关键词筛选（TU-15）", () => {
    render(<CaseHarness />);
    pickHelpMenu("案例脚本");
    expect(screen.getByText("12 / 12 条")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "通用" }));
    expect(screen.getByText("2 / 12 条")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索案例" }), { target: { value: "SWE-bench" } });
    expect(screen.getByText("1 / 12 条")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索案例" }), { target: { value: "不存在的案例" } });
    expect(screen.getByRole("status")).toHaveTextContent("没有匹配案例");
  });

  it("社区 Tab 已改名为教程工作室，并提供四个入口", async () => {
    vi.spyOn(api, "listCommunityTutorials").mockResolvedValue({ tutorials: [], nextCursor: null });
    render(<CaseHarness />);
    pickHelpMenu("教程工作室");
    expect(await screen.findByRole("heading", { name: "探索教程，或把一次真实会话变成可复用方法" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "探索教程" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "从当前会话生成" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "手写教程" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "我的发布" })).toBeInTheDocument();
  });

  it("communityId 深链直接打开教程工作室并加载详情", async () => {
    vi.spyOn(api, "listCommunityTutorials").mockResolvedValue({ tutorials: [], nextCursor: null });
    vi.spyOn(api, "getCommunityTutorial").mockResolvedValue({
      id: "tut-7",
      title: "深链社区教程",
      summary: "从 URL 打开。",
      category: "general",
      authorName: "作者",
      publishedAt: "2026-08-20T00:00:00.000Z",
      bodyMarkdown: "深链正文",
    });
    render(
      <TutorialCenter
        open
        topicId={null}
        caseId={null}
        communityId="tut-7"
        onTopicChange={() => {}}
        onClose={() => {}}
        actionState={() => ({ enabled: true, label: "回到功能位置" })}
        onRunAction={() => {}}
      />,
    );
    expect(await screen.findByRole("heading", { name: "探索教程，或把一次真实会话变成可复用方法" })).toBeInTheDocument();
    await waitFor(() => expect(api.getCommunityTutorial).toHaveBeenCalledWith("tut-7"));
    expect(await screen.findByText("深链正文")).toBeInTheDocument();
  });

  it("公开数据实作与旧待采集回放分离，不挪用历史模型结果", () => {
    render(<CaseHarness initial="research-bike-demand" />);
    expect(screen.getByRole("heading", { name: "一堆出行数据，变成看得懂的需求规律。" })).toBeInTheDocument();
    expect(screen.getByText(/非完整会话回放/)).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "任务阶段" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("0.904");
    expect(document.body.textContent).not.toContain("34 项");
  });

  it("主操作只把选中的真实案例交给现有开工流程", () => {
    const onRunCase = vi.fn();
    render(<CaseHarness initial="coding-swe-bench-fix" onRunCase={onRunCase} />);

    fireEvent.click(screen.getByRole("button", { name: "带着我的材料开始，带着指令去对话" }));
    expect(onRunCase).toHaveBeenCalledTimes(1);
    expect(onRunCase).toHaveBeenCalledWith(expect.objectContaining({ id: "coding-swe-bench-fix" }));
  });

  it("非精选案例深链继续展示自己的原详情，不会错误回落到单车案例", () => {
    render(<CaseHarness initial="coding-feature-delivery" />);

    expect(
      screen.getByRole("heading", { name: "从一条需求交付可合并的 API 功能" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "你不用守着它。回来时，过程和成果都还在。" }),
    ).not.toBeInTheDocument();
  });

  it("展示详细步骤、本地演示媒体、风险提示与真实功能 CTA", () => {
    const onRun = vi.fn();
    render(<Harness onRun={onRun} />);

    expect(
      screen.getByRole("heading", { name: "开始一场高质量对话" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "跟着做" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(6);
    const video = screen.getByLabelText("对话入门演示视频");
    expect(video).toHaveAttribute("poster", "/tutorials/chat-basics.webp");
    expect(video.querySelector("source")).toHaveAttribute(
      "src",
      "/tutorials/chat-basics.webm",
    );
    expect(screen.getByText("真实界面录制 · 脱敏示例")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "回到功能位置" }));
    expect(onRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "chat-basics" }),
    );
  });

  it("搜索功能、场景和别名后可直接切换教程，窄屏也能看到命中计数与结果列表（TU-04）", () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索教程" }), {
      target: { value: "OAuth 仓库" },
    });
    // <lg 的结果列表与桌面侧栏各渲染一份（jsdom 不算 CSS），有查询时命中计数可见。
    const results = screen.getByRole("navigation", { name: "搜索结果" });
    expect(results).toHaveTextContent(/\d+ 篇匹配「OAuth 仓库」/);
    expect(screen.getAllByRole("button", { name: /GitHub 仓库/ }).length).toBeGreaterThanOrEqual(2);
    fireEvent.click(within(results).getByRole("button", { name: /GitHub 仓库/ }));
    expect(
      screen.getByRole("heading", { name: "连接 GitHub 仓库协作开发" }),
    ).toBeInTheDocument();
    // 点选后查询清空，回到 <select> 形态。
    expect(screen.queryByRole("navigation", { name: "搜索结果" })).not.toBeInTheDocument();
  });

  it("搜索无结果时窄屏与侧栏都给出空态文案，而不是毫无变化（TU-04）", () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索教程" }), {
      target: { value: "不存在的功能关键词" },
    });
    expect(screen.getAllByText("没有匹配的教程，换个关键词试试。").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("navigation", { name: "搜索结果" })).not.toHaveTextContent("篇匹配");
  });

  it("视频失败时显示同源截图兜底，不留下空白", () => {
    render(<Harness />);
    fireEvent.error(screen.getByLabelText("对话入门演示视频"));
    expect(
      screen.getByText("演示视频暂不可播放，已显示同一功能截图。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /输入目标并发送/ })).toHaveAttribute(
      "src",
      "/tutorials/chat-basics.webp",
    );
  });

  it("不可用动作保持教程打开并解释权限原因", () => {
    render(
      <Harness
        initial={PRODUCT_CAPABILITIES.organization.id}
        enabled={false}
      />,
    );
    expect(screen.getByText("只有组织管理员可以进入。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开组织中心" })).toBeDisabled();
    expect(
      screen.getByRole("heading", { name: "组织、成员、共享额度与发票" }),
    ).toBeInTheDocument();
  });
});
