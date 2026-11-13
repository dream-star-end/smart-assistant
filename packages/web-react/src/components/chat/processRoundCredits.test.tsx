import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { ProcessDisclosure, processRoundCredits, type ProcessSection } from "./ProcessDisclosure";

function assistant(id: string, credits?: string): ChatMessage {
  return {
    id,
    role: "assistant",
    text: "done",
    ts: 1_700_000_000_000,
    ...(credits ? { usage: { costCredits: credits } } : {}),
  };
}

const section: ProcessSection<string> = {
  key: "s",
  narrative: false,
  goal: false,
  items: ["tool"],
  messages: [{ id: "tool", role: "tool", text: "figcheck", ts: 1_700_000_000_000 }],
};

describe("processRoundCredits", () => {
  test("a finished turn shows the answer label", () => {
    expect(processRoundCredits({
      active: false,
      sectionMessages: section.messages,
      following: [assistant("answer", "132")],
    })).toBe("132");
  });

  test("a live turn shows the settled total and hides zero", () => {
    expect(processRoundCredits({
      active: true,
      settledCredits: "132",
      sectionMessages: section.messages,
      following: [assistant("answer", "97")],
    })).toBe("132");
    expect(processRoundCredits({
      active: true,
      settledCredits: "0",
      sectionMessages: [],
    })).toBeNull();
  });

  test("does not add the answer total on top of the same figure inside the section", () => {
    expect(processRoundCredits({
      active: false,
      sectionMessages: [assistant("inside", "132")],
      following: [assistant("answer", "132")],
    })).toBe("132");
  });
});

describe("ProcessDisclosure round header", () => {
  test("shows 本轮 132 积分 after refresh and while the turn is live", () => {
    const { rerender } = render(
      <ProcessDisclosure
        sections={[section]}
        active={false}
        open={false}
        setOpen={() => {}}
        detailOpen={() => false}
        setDetailOpen={() => {}}
        renderItem={() => null}
        keyOf={(item) => item}
        messagesOf={() => section.messages}
        bounds={{ startedAt: 1, endedAt: 2, following: [assistant("answer", "132")] }}
      />,
    );
    expect(screen.getByTestId("process-round-credits").textContent).toBe("本轮 132 积分");
    rerender(
      <ProcessDisclosure
        sections={[section]}
        active
        open={false}
        setOpen={() => {}}
        detailOpen={() => false}
        setDetailOpen={() => {}}
        renderItem={() => null}
        keyOf={(item) => item}
        messagesOf={() => section.messages}
        activity={{ startedAt: 1, agentName: "助手", settledCredits: "132" }}
      />,
    );
    expect(screen.getByTestId("process-round-credits").textContent).toBe("本轮 132 积分");
  });
});
