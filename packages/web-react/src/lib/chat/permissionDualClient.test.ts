import { describe, expect, test } from "vitest";
import { applyPermissionSnapshot, applyPermissionRequest } from "./reducer";
import { createSession } from "./model";
import type { PermissionPromptSnapshotPayload } from "../types";

function session(id: string, agentId = "main") {
  return createSession({ id, agentId, title: id });
}

const snapshot = (over: Partial<PermissionPromptSnapshotPayload> = {}): PermissionPromptSnapshotPayload => ({
  items: [
    {
      requestId: "req-shared",
      clientMessageId: "m-user",
      toolUseId: "toolu_shared",
      toolName: "AskUserQuestion",
      inputJson: { questions: [{ question: "q" }] },
      status: "pending",
      behavior: null,
      reason: null,
      answers: null,
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
    },
  ],
  completeness: "complete",
  source: "pg",
  ...over,
});

describe("dual-client permission snapshot", () => {
  test("A answers then B's snapshot settles without a second auto-open card", () => {
    const tabA = session("s1");
    const tabB = session("s1");
    applyPermissionSnapshot(tabA, snapshot());
    applyPermissionSnapshot(tabB, snapshot());
    expect(tabA.messages.filter((m) => m.role === "permission")).toHaveLength(1);
    expect(tabB.messages.filter((m) => m.role === "permission")).toHaveLength(1);

    applyPermissionSnapshot(tabB, snapshot({
      items: [{
        ...snapshot().items[0]!,
        status: "responded",
        behavior: "allow",
        reason: null,
        updatedAt: Date.now(),
      }],
    }));
    const cardB = tabB.messages.find((m) => m.requestId === "req-shared");
    expect(cardB?._resolved).toBe(true);
    expect(cardB?._behavior).toBe("allow");
    expect(cardB?._settledReason).toBe("accepted");
  });

  test("late pending snapshot does not resurrect a settled card", () => {
    const tabB = session("s1");
    applyPermissionSnapshot(tabB, snapshot({
      items: [{
        ...snapshot().items[0]!,
        status: "responded",
        behavior: "allow",
        updatedAt: 500,
      }],
    }));
    applyPermissionSnapshot(tabB, snapshot({
      items: [{
        ...snapshot().items[0]!,
        status: "pending",
        behavior: null,
        updatedAt: 100,
      }],
    }));
    const card = tabB.messages.find((m) => m.requestId === "req-shared");
    expect(card?._resolved).toBe(true);
  });

  test("first-frame loss: snapshot materialises a card the live WS never delivered", () => {
    const tab = session("s1");
    expect(tab.messages.some((m) => m.role === "permission")).toBe(false);
    applyPermissionSnapshot(tab, snapshot());
    const card = tab.messages.find((m) => m.requestId === "req-shared");
    expect(card?.role).toBe("permission");
    expect(card?.toolUseId).toBe("toolu_shared");
    expect(card?._turnOwnerId).toBe("m-user");
    expect(card?._resolved).toBe(false);
  });

  test("idempotent request frames do not duplicate cards", () => {
    const tab = session("s1");
    applyPermissionSnapshot(tab, snapshot());
    applyPermissionRequest(tab, {
      type: "outbound.permission_request",
      sessionKey: "agent:main:webchat:dm:s1",
      channel: "webchat",
      peer: { id: "s1", kind: "dm" },
      requestId: "req-shared",
      toolName: "AskUserQuestion",
      inputJson: { questions: [] },
    } as Parameters<typeof applyPermissionRequest>[1]);
    expect(tab.messages.filter((m) => m.role === "permission")).toHaveLength(1);
  });

  test("reconnect snapshot settles an existing local pending card", () => {
    const tabB = session("s1");
    applyPermissionSnapshot(tabB, snapshot());
    expect(tabB.messages.find((m) => m.requestId === "req-shared")?._resolved).toBe(false);
    applyPermissionSnapshot(tabB, snapshot({
      items: [{
        ...snapshot().items[0]!,
        status: "responded",
        behavior: "allow",
        updatedAt: Date.now(),
      }],
    }));
    const card = tabB.messages.find((m) => m.requestId === "req-shared");
    expect(card?._resolved).toBe(true);
    expect(card?._behavior).toBe("allow");
  });

  test("late full lookup fills a truncated local pending card", () => {
    const tab = session("s1");
    applyPermissionSnapshot(tab, snapshot({
      items: [{
        ...snapshot().items[0]!,
        inputJson: {},
        inputTruncated: true,
      }],
    }));
    expect(tab.messages.find((m) => m.requestId === "req-shared")?._inputTruncated).toBe(true);
    applyPermissionSnapshot(tab, snapshot({
      items: [{
        ...snapshot().items[0]!,
        inputJson: { questions: [{ question: "完整题" }] },
        inputTruncated: false,
      }],
    }));
    const card = tab.messages.find((m) => m.requestId === "req-shared");
    expect(card?._inputTruncated).toBe(false);
    expect(card?.inputJson).toEqual({ questions: [{ question: "完整题" }] });
  });

  test("non-main agent snapshots keep agent-scoped sessionKey", () => {
    const tab = session("s1", "research-assistant");
    applyPermissionSnapshot(tab, snapshot());
    const card = tab.messages.find((m) => m.requestId === "req-shared");
    expect(card?._turnOwnerId).toBe("m-user");
    expect(tab.agentId).toBe("research-assistant");
  });
});
