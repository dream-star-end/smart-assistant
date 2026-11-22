import { describe, test, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { SWARM_BOARD_TOOL_NAME, type SwarmSnapshot } from "@openclaude/protocol/browser";
import type { ChatMessage } from "../lib/chat/model";
import {
  clearSessionSwarmMode,
  readSessionSwarmMode,
  swarmModeSessionKey,
  writeSessionSwarmMode,
} from "../lib/sessionSwarmMode";
import { useSwarmMode } from "./useSwarmUi";

const MODELS = [
  { id: "antigravity-gemini-4-neon", engine: "antigravity", name: "Gemini 4 Neon" },
  { id: "gpt-6.2-astra", engine: "codex", name: "GPT 6.2 Astra" },
] as const;

function makeSwarmMsg(phase: SwarmSnapshot["phase"] = "running"): ChatMessage {
  const snapshot: SwarmSnapshot = {
    swarmId: "7474cf40-399d-415c-a951-6713ce671aef",
    title: "Wave 4 蜂群",
    phase,
    revision: 10,
    updatedAt: 1_700_000_000_000,
    members: [{ name: "coordinator", role: "coordinator", status: phase === "running" ? "working" : "waiting", stepCount: 5, unreadCount: 0 }],
    channels: [{ name: "main", memberCount: 1, postCount: 1 }],
    posts: [{ seq: 1, agent: "coordinator", text: "启动", channel: "main", mentions: [] }],
    totalPosts: 1,
  };
  return {
    id: "m-swarm-1",
    role: "tool",
    text: SWARM_BOARD_TOOL_NAME,
    ts: 1_700_000_000_000,
    toolName: SWARM_BOARD_TOOL_NAME,
    _swarmSnapshot: snapshot,
  };
}

describe("OCV5-837: sessionSwarmMode persistence & useSwarmMode", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("persists explicit toggle across remount/reload and clears on session delete", () => {
    const { result, unmount } = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "s-persist",
        activeSessionId: "s-persist",
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(result.current.swarmSupported).toBe(true);
    expect(result.current.swarmMode).toBe(false);

    act(() => result.current.toggleSwarmMode());
    expect(result.current.swarmMode).toBe(true);
    expect(localStorage.getItem(swarmModeSessionKey("s-persist"))).toBe("1");
    expect(readSessionSwarmMode("s-persist")).toBe(true);

    // Simulate reload / returning from mobile background with fresh hook mount
    unmount();
    const remounted = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "s-persist",
        activeSessionId: "s-persist",
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(remounted.result.current.swarmMode).toBe(true);

    // Deleting session clears key and resets to default false
    act(() => clearSessionSwarmMode("s-persist"));
    expect(localStorage.getItem(swarmModeSessionKey("s-persist"))).toBeNull();
    expect(remounted.result.current.swarmMode).toBe(false);
    remounted.unmount();
  });

  test("auto-enables for sessions that already have a SwarmBoard card unless user explicitly toggled off", () => {
    const swarmMessages = [makeSwarmMsg()];
    const { result, unmount } = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "s-active-swarm",
        activeSessionId: "s-active-swarm",
        wsMessages: swarmMessages,
        messagesVersion: 1,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    // No localStorage key yet, but session has SwarmBoard -> button stays active!
    expect(readSessionSwarmMode("s-active-swarm")).toBeUndefined();
    expect(result.current.swarmMode).toBe(true);

    // Explicit off writes "0" and stays off even after reload with SwarmBoard still in history
    act(() => result.current.toggleSwarmMode());
    expect(result.current.swarmMode).toBe(false);
    expect(readSessionSwarmMode("s-active-swarm")).toBe(false);

    unmount();
    const remounted = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "s-active-swarm",
        activeSessionId: "s-active-swarm",
        wsMessages: swarmMessages,
        messagesVersion: 1,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(remounted.result.current.swarmMode).toBe(false);
    remounted.unmount();
  });

  test("syncs same-tab writeSessionSwarmMode (e.g. /swarm slash send) and keeps drafts out of localStorage", () => {
    const draft = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "draft-1",
        activeSessionId: undefined,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    act(() => draft.result.current.toggleSwarmMode());
    expect(draft.result.current.swarmMode).toBe(true);
    expect(localStorage.length).toBe(0);
    draft.unmount();

    const active = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "s-slash",
        activeSessionId: "s-slash",
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(active.result.current.swarmMode).toBe(false);
    act(() => writeSessionSwarmMode("s-slash", true));
    expect(active.result.current.swarmMode).toBe(true);
    active.unmount();
  });

  test("preserves draft swarm toggle when the same draftSessionId is materialized before first send (Goal/GitHub)", () => {
    const { result, rerender, unmount } = renderHook(
      ({ activeSessionId }: { activeSessionId?: string }) =>
        useSwarmMode({
          demo: false,
          sessionKey: activeSessionId ?? "draft-mat-1",
          activeSessionId,
          modelId: "antigravity-gemini-4-neon",
          models: [...MODELS],
        }),
      { initialProps: { activeSessionId: undefined as string | undefined } },
    );
    act(() => result.current.toggleSwarmMode());
    expect(result.current.swarmMode).toBe(true);
    expect(localStorage.length).toBe(0);

    // Goal/GitHub binding materializes the draft under the same id before first send
    rerender({ activeSessionId: "draft-mat-1" });
    expect(result.current.swarmMode).toBe(true);
    expect(readSessionSwarmMode("draft-mat-1")).toBe(true);
    unmount();
  });

  test("OCV5-843: setSwarmMode sets explicit boolean for both persisted sessions and drafts", () => {
    const persisted = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "s-explicit",
        activeSessionId: "s-explicit",
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    act(() => persisted.result.current.setSwarmMode(true));
    expect(persisted.result.current.swarmMode).toBe(true);
    expect(readSessionSwarmMode("s-explicit")).toBe(true);
    act(() => persisted.result.current.setSwarmMode(true));
    expect(persisted.result.current.swarmMode).toBe(true);
    act(() => persisted.result.current.setSwarmMode(false));
    expect(persisted.result.current.swarmMode).toBe(false);
    expect(readSessionSwarmMode("s-explicit")).toBe(false);
    persisted.unmount();

    const draft = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "draft-explicit",
        activeSessionId: undefined,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    act(() => draft.result.current.setSwarmMode(true));
    expect(draft.result.current.swarmMode).toBe(true);
    act(() => draft.result.current.setSwarmMode(false));
    expect(draft.result.current.swarmMode).toBe(false);
    draft.unmount();
  });

  test("does NOT auto-enable swarmMode for historical terminal SwarmBoard cards across devices", () => {
    for (const phase of ["completed", "interrupted", "error"] as const) {
      const { result, unmount } = renderHook(() =>
        useSwarmMode({
          demo: false,
          sessionKey: `s-hist-${phase}`,
          activeSessionId: `s-hist-${phase}`,
          wsMessages: [makeSwarmMsg(phase)],
          messagesVersion: 1,
          modelId: "antigravity-gemini-4-neon",
          models: [...MODELS],
        }),
      );
      expect(readSessionSwarmMode(`s-hist-${phase}`)).toBeUndefined();
      expect(result.current.swarmMode).toBe(false);
      unmount();
    }
  });
});
