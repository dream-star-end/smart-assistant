// #1240: 流式回合里 MessageList 每帧重渲。已结束轮的「工作过程」外壳不能跟着每帧重渲(长会话里
// 曾占整页渲染量的近一半);进行中的那一组照常每帧更新，展开 / 收起等用户操作仍即时生效。
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../lib/chat/model";
import type { CardCallbacks } from "./chat/cards";
import { MessageList } from "./MessageRenderer";
import { preloadProcessStages } from "./chat/lazyProcessStages";
import { loadBeforeAll } from "../test/moduleLoad";

loadBeforeAll(preloadProcessStages);

const disclosureRenders = vi.hoisted(() => ({ live: 0, settled: 0 }));
vi.mock("./chat/ProcessDisclosure", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./chat/ProcessDisclosure")>();
  return {
    ...mod,
    ProcessDisclosure: (props: Parameters<typeof mod.ProcessDisclosure>[0]) => {
      if (props.active) disclosureRenders.live += 1;
      else disclosureRenders.settled += 1;
      return mod.ProcessDisclosure(props);
    },
  };
});

afterEach(() => {
  cleanup();
  disclosureRenders.live = 0;
  disclosureRenders.settled = 0;
});

function row(id: string, role: ChatMessage["role"], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text, ts: 1_700_000_000_000, ...extra };
}

function bash(id: string, owner: string, command: string): ChatMessage {
  return row(id, "tool", "终端", { _clientMessageId: owner, toolName: "Bash", inputJson: { command }, _completed: true, output: "ok" });
}

const settled: ChatMessage[] = [
  row("u0", "user", "上一轮的问题", { status: "replied" }),
  bash("bash-0", "u0", "probe-settled"),
  row("answer-0", "assistant", "上一轮的回答", { _clientMessageId: "u0" }),
];

function liveTurn(stage: string): ChatMessage[] {
  return [
    row("u1", "user", "规划京都五日行程", { status: "replied" }),
    bash("bash-1", "u1", "probe-live"),
    row("stage-1", "assistant", stage, { _clientMessageId: "u1" }),
  ];
}

const cb: CardCallbacks = {};
const respond = () => {};

function list(messages: ChatMessage[], sending: boolean) {
  return (
    <MessageList processDisclosure messages={messages} sending={sending} sessionId="session-a" cb={cb} onRespondPermission={respond} />
  );
}

describe("MessageList 渲染预算 (#1240)", () => {
  test("进行中的回合每帧更新时，已结束轮的工作过程不重渲；进行中的那一组照常更新", () => {
    let text = "第 1 步完成";
    const view = render(list([...settled, ...liveTurn(text)], true));
    expect(screen.getAllByTestId("process-disclosure")).toHaveLength(2);
    const settledAtMount = disclosureRenders.settled;
    const liveAtMount = disclosureRenders.live;
    for (let i = 2; i <= 12; i++) {
      text += `，第 ${i} 步完成`;
      view.rerender(list([...settled, ...liveTurn(text)], true));
    }
    expect(disclosureRenders.settled).toBe(settledAtMount);
    expect(disclosureRenders.live).toBeGreaterThanOrEqual(liveAtMount + 11);
    expect(screen.getAllByTestId("process-stage").some((node) => (node.textContent ?? "").includes("第 12 步完成"))).toBe(true);
  });

  test("已结束轮的展开 / 收起即时生效；回合结束时进行中的那一组正常转为已结束", () => {
    const view = render(list([...settled, ...liveTurn("第 1 步完成")], true));
    const [settledToggle] = screen.getAllByTestId("process-toggle");
    expect(settledToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(settledToggle);
    expect(screen.getAllByTestId("process-toggle")[0]).toHaveAttribute("aria-expanded", "true");
    view.rerender(list([...settled, ...liveTurn("第 1 步完成，第 2 步完成")], true));
    expect(screen.getAllByTestId("process-toggle")[0]).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getAllByTestId("process-toggle")[0]);
    expect(screen.getAllByTestId("process-toggle")[0]).toHaveAttribute("aria-expanded", "false");

    view.rerender(list([...settled, ...liveTurn("第 1 步完成，第 2 步完成")], false));
    const shells = screen.getAllByTestId("process-disclosure");
    expect(shells).toHaveLength(2);
    expect(shells.every((shell) => shell.getAttribute("data-process-active") === "false")).toBe(true);
  });
});
