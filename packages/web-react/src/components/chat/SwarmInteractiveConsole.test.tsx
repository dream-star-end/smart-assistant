import "@testing-library/jest-dom/vitest";
import type { SwarmSnapshot } from "@openclaude/protocol/browser";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SWARM_PLAYBOOK_PRESETS, buildSwarmPlaybookDraft } from "../../lib/api/wave4Api";
import { createMemoryAuthSession } from "../../lib/authSession";
import { Composer } from "../Composer";
import { ToastProvider, TooltipProvider } from "../ui";
import { SwarmBoardDrawer } from "./SwarmBoardDrawer";
import { formatTelemetryDuration, formatTelemetryTokens } from "./swarmUtils";

const origFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

function makeTelemetrySnapshot(): SwarmSnapshot {
  return {
    swarmId: "22222222-2222-4222-8222-222222222222",
    title: "Wave 4B 联合交付",
    phase: "running",
    revision: 4,
    updatedAt: 1_760_000_000_000,
    startedAt: 1_760_000_000_000 - 90_000,
    members: [
      {
        name: "coordinator",
        role: "coordinator",
        status: "waiting",
        model: "gemini-4-neon-high",
        stepCount: 5,
        unreadCount: 0,
        elapsedMs: 12_400,
        inputTokens: 18_500,
        outputTokens: 3_200,
        toolCalls: 4,
        telemetryPartial: false,
      },
      {
        name: "worker-ui",
        role: "worker",
        status: "working",
        model: "gemini-4-neon-high",
        workspace: "share",
        stepCount: 9,
        unreadCount: 1,
        elapsedMs: 74_000,
        inputTokens: 45_200,
        outputTokens: 9_800,
        toolCalls: 14,
        telemetryPartial: true,
      },
    ],
    channels: [{ name: "main", memberCount: 2, postCount: 1 }],
    posts: [
      {
        seq: 1,
        agent: "coordinator",
        channel: "main",
        text: "@worker-ui 请推进前台 UI 闭环",
        mentions: ["worker-ui"],
      },
    ],
    totalPosts: 1,
  };
}

describe("SwarmBoardDrawer · 遥测展示与交互式指挥操控台", () => {
  it("正确格式化耗时与 token 遥测", () => {
    expect(formatTelemetryDuration(420)).toBe("420ms");
    expect(formatTelemetryDuration(12_400)).toBe("12s");
    expect(formatTelemetryDuration(74_000)).toBe("1m14s");
    expect(formatTelemetryTokens(18_500, 3_200)).toBe("18.5k↑ 3.2k↓");
  });

  it("在成员矩阵中隐藏 ~ 近似 工程徽标，操控栏使用通俗文案并通过 Toast 反馈（不叠内联反馈条）", async () => {
    const auth = createMemoryAuthSession(() => {}, "jwt-swarm-token");
    let terminateMode: "requested" | "confirmed" = "requested";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toBe("/api/sessions/sess-swarm-1/swarm/command");
      const body = JSON.parse(String(init?.body));
      if (body.action === "steer") {
        return new Response(
          JSON.stringify({
            ok: true,
            seq: 2,
            target: body.target,
            channel: body.channel ?? "main",
            agent: "user:42",
            text: `@${body.target} ${body.message}`,
            mentions: [body.target],
            time: "2026-11-21T08:10:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (body.action === "terminate") {
        return new Response(
          JSON.stringify({
            ok: true,
            status: terminateMode,
            memberName: body.memberName,
            alreadyKilled: false,
            noticeSeq: 3,
            time: "2026-11-21T08:11:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("bad request", { status: 400 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(
      <ToastProvider>
        <SwarmBoardDrawer
          open
          onOpenChange={() => {}}
          snapshot={makeTelemetrySnapshot()}
          sessionId="sess-swarm-1"
          auth={auth}
        />
      </ToastProvider>,
    );

    // 校验成员遥测呈现且不再展示「~ 近似」工程徽标
    expect(screen.getByTestId("swarm-member-telemetry-coordinator")).toHaveTextContent("18.5k↑ 3.2k↓");
    expect(screen.queryByTestId("swarm-telemetry-partial-coordinator")).toBeNull();
    expect(screen.getByTestId("swarm-member-telemetry-worker-ui")).toHaveTextContent("~1m14s");
    expect(screen.getByTestId("swarm-member-telemetry-worker-ui")).toHaveTextContent("~14 次");
    expect(screen.queryByTestId("swarm-telemetry-partial-worker-ui")).toBeNull();

    // 默认目标是 coordinator，不显示停止成员按钮
    expect(screen.queryByTestId("swarm-terminate-trigger")).toBeNull();

    // 发送指令给 coordinator → Toast 提示 + 讨论流立即乐观回显「已投递」，不出现重复内联反馈条
    fireEvent.change(screen.getByTestId("swarm-command-input"), {
      target: { value: "请优先核验 bundle 体积预算" },
    });
    fireEvent.click(screen.getByTestId("swarm-command-send"));
    expect(await screen.findByText("已向 @coordinator 发送指令（#2）")).toBeInTheDocument();
    expect(screen.getByTestId("swarm-post-delivered-2")).toHaveTextContent("已投递");
    expect(screen.queryByTestId("swarm-command-feedback")).toBeNull();

    // 切换目标到非 coordinator 成员 worker-ui → 展示停止该成员按钮 → 二次确认
    const targetTrigger = screen.getByTestId("swarm-command-target");
    fireEvent.pointerDown(targetTrigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByTestId("swarm-command-target-option-worker-ui"));
    fireEvent.click(screen.getByTestId("swarm-terminate-trigger"));
    expect(screen.getByTestId("swarm-terminate-confirm")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("swarm-terminate-reason"), {
      target: { value: "任务已由其他切片覆盖" },
    });
    fireEvent.click(screen.getByTestId("swarm-terminate-confirm-btn"));

    // Toast 通俗反馈 requested 状态，且不出现重复内联条
    expect(await screen.findByText("已请求停止 @worker-ui")).toBeInTheDocument();
    expect(screen.queryByTestId("swarm-command-feedback")).toBeNull();

    // 再次请求并返回 confirmed 状态，验证 Toast 明确区分已停止
    terminateMode = "confirmed";
    fireEvent.click(screen.getByTestId("swarm-terminate-trigger"));
    fireEvent.click(screen.getByTestId("swarm-terminate-confirm-btn"));
    await waitFor(() => expect(screen.getByText("已停止 @worker-ui")).toBeInTheDocument());
    expect(screen.queryByTestId("swarm-command-feedback")).toBeNull();
  });

  it("OCV5-932 Defect #2: 诚实区分 wakeDelivery='woken' 与 'board_only_unwoken'（steer 与 terminate）", async () => {
    const auth = createMemoryAuthSession(() => {}, "jwt-swarm-wake");
    let steerWakeDelivery: "woken" | "board_only_unwoken" = "woken";
    let terminateWakeDelivery: "woken" | "board_only_unwoken" = "board_only_unwoken";
    let seqCounter = 10;

    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seqCounter += 1;
      if (body.action === "steer") {
        return new Response(
          JSON.stringify({
            ok: true,
            seq: seqCounter,
            target: body.target,
            channel: body.channel ?? "main",
            agent: "user:42",
            text: `@${body.target} ${body.message}`,
            mentions: [body.target],
            time: "2026-11-28T08:30:00Z",
            wakeDelivery: steerWakeDelivery,
            wakeDetail: steerWakeDelivery === "woken" ? "remote_swarm_runtime" : "no_active_native_swarm_process",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (body.action === "terminate") {
        return new Response(
          JSON.stringify({
            ok: true,
            status: "requested",
            memberName: body.memberName,
            alreadyKilled: false,
            noticeSeq: seqCounter,
            time: "2026-11-28T08:31:00Z",
            wakeDelivery: terminateWakeDelivery,
            wakeDetail:
              terminateWakeDelivery === "woken" ? "remote_swarm_runtime" : "native_cli_stdin_queued_until_result",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("bad request", { status: 400 });
    }) as typeof fetch;

    render(
      <ToastProvider>
        <SwarmBoardDrawer
          open
          onOpenChange={() => {}}
          snapshot={makeTelemetrySnapshot()}
          sessionId="sess-swarm-wake"
          auth={auth}
        />
      </ToastProvider>,
    );

    // 1. steer + wakeDelivery === "woken" -> 成功唤醒文案
    fireEvent.change(screen.getByTestId("swarm-command-input"), { target: { value: "继续推进" } });
    fireEvent.click(screen.getByTestId("swarm-command-send"));
    expect(await screen.findByText("已向 @coordinator 发送指令（#11）")).toBeInTheDocument();

    // 2. steer + wakeDelivery === "board_only_unwoken" -> 诚实告知仅落盘且未即时唤醒
    steerWakeDelivery = "board_only_unwoken";
    fireEvent.change(screen.getByTestId("swarm-command-input"), { target: { value: "补充约束" } });
    fireEvent.click(screen.getByTestId("swarm-command-send"));
    expect(
      await screen.findByText("已写入讨论板（#12），未即时唤醒目标成员（将在其下次读板时可见）"),
    ).toBeInTheDocument();

    // 3. terminate(requested) + wakeDelivery === "board_only_unwoken" -> 诚实告知协调者未即时唤醒
    const targetTrigger = screen.getByTestId("swarm-command-target");
    fireEvent.pointerDown(targetTrigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByTestId("swarm-command-target-option-worker-ui"));
    fireEvent.click(screen.getByTestId("swarm-terminate-trigger"));
    fireEvent.click(screen.getByTestId("swarm-terminate-confirm-btn"));
    expect(
      await screen.findByText("已写入停止 @worker-ui 请求（#13），未即时唤醒协调者（将在其下次读板时可见）"),
    ).toBeInTheDocument();

    // 4. terminate(requested) + wakeDelivery === "woken" -> 保持清爽请求文案
    terminateWakeDelivery = "woken";
    fireEvent.click(screen.getByTestId("swarm-terminate-trigger"));
    fireEvent.click(screen.getByTestId("swarm-terminate-confirm-btn"));
    expect(await screen.findByText("已请求停止 @worker-ui")).toBeInTheDocument();
  });
});

describe("Composer · 蜂群剧本模板快选弹层", () => {
  it("提供 6 套预设剧本（含 2 套科研专属剧本），点击一键填充结构化指令并自动开启蜂群模式", async () => {
    expect(SWARM_PLAYBOOK_PRESETS).toHaveLength(6);
    expect(buildSwarmPlaybookDraft(SWARM_PLAYBOOK_PRESETS[0]!, "实现登录页")).toContain(
      "/swarm-playbook parallel-impl-verify 实现登录页",
    );

    const onToggleSwarmMode = vi.fn();
    render(
      <TooltipProvider>
        <ToastProvider>
          <Composer
            onSend={() => {}}
            swarmSupported
            swarmMode={false}
            onToggleSwarmMode={onToggleSwarmMode}
          />
        </ToastProvider>
      </TooltipProvider>,
    );

    const plusBtn = screen.getByRole("button", { name: "更多选项" });
    fireEvent.pointerDown(plusBtn, { button: 0, pointerType: "mouse" });
    fireEvent.click(plusBtn);
    fireEvent.click(await screen.findByTestId("composer-menu-swarm-playbooks"));
    const popover = await screen.findByTestId("swarm-playbook-popover");
    expect(popover).toHaveTextContent("并行实现+验收");
    expect(popover).toHaveTextContent("多源文献深研+核验");
    expect(popover).toHaveTextContent("架构深度体检");
    expect(popover).toHaveTextContent("多方案评审");
    expect(popover).toHaveTextContent("论文写作+盲审+批判修订");
    expect(popover).toHaveTextContent("受控实验循环（防刷分）");

    fireEvent.click(screen.getByTestId("swarm-playbook-option-research-write-review-revise"));

    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.value).toContain("/swarm-playbook research-write-review-revise");
    expect(onToggleSwarmMode).toHaveBeenCalledTimes(1);

    // 等选完剧本后的 rAF 回焦输入框完成，避免 JSDOM 慢帧时 rAF 在二次打开「+」菜单途中抢焦关闭菜单。
    await waitFor(() => expect(document.activeElement).toBe(input));

    // OCV5-861 回归：chunk 预热后二次打开剧本弹层，即便触发器收到 focusin 也不得误关弹层。
    fireEvent.pointerDown(plusBtn, { button: 0, pointerType: "mouse" });
    fireEvent.click(plusBtn);
    fireEvent.click(await screen.findByTestId("composer-menu-swarm-playbooks"));
    const reopened = await screen.findByTestId("swarm-playbook-popover");
    expect(screen.getByTestId("swarm-playbook-option-research-controlled-exp-loop")).toBeInTheDocument();
    fireEvent.focus(plusBtn);
    expect(screen.getByTestId("swarm-playbook-popover")).toBe(reopened);
  });
});
