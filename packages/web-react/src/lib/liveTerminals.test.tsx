import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useState } from "react";
import type { ChatMessage } from "./chat/model";
import { useLiveTerminals } from "./liveTerminals";
import type { Session } from "./types";

afterEach(cleanup);

describe("useLiveTerminals", () => {
  test("terminating a session dispatches applySessionTerminal exactly once and keeps Map reference stable across subsequent sessions renders", () => {
    const applyCalls = vi.fn();
    let sending = true;
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", text: "hi", ts: 1000 },
      { id: "a1", role: "assistant", text: "done", ts: 2000, _dispatchOutcome: "completed" },
    ];
    let version = 1;
    let metaVersion = 1;
    const makeChat = () => ({
      version,
      metaVersion,
      isSending: (id: string | undefined) => id === "s1" && sending,
      getSession: (id: string | undefined) => (id === "s1" ? { messages } : undefined),
    });

    const { result, rerender } = renderHook(
      ({ chat, extraTick }: { chat: ReturnType<typeof makeChat>; extraTick: number }) => {
        void extraTick;
        const [sessions, setSessions] = useState<Session[]>([
          {
            id: "s1",
            title: "T",
            ownerUserId: "u",
            createdAt: 1,
            updatedAt: new Date(1000).toISOString(),
            messageCount: 2,
            runState: "running",
          },
        ]);
        const apply = (id: string, terminal: { lastOutcome: Session["lastOutcome"]; lastErrorCode: string | null; endedAt: number } | null) => {
          applyCalls(id, terminal);
          // Even if caller clones array, useLiveTerminals must not re-fire applySessionTerminal!
          setSessions((cur) => cur.map((x) => (x.id === id ? { ...x, runState: "idle" } : x)));
        };
        return useLiveTerminals({ demo: false, chat, sessions, applySessionTerminal: apply });
      },
      { initialProps: { chat: makeChat(), extraTick: 0 } },
    );

    expect(applyCalls).toHaveBeenCalledTimes(0);

    // Transition s1 from sending -> idle (completed)
    sending = false;
    version += 1;
    metaVersion += 1;
    rerender({ chat: makeChat(), extraTick: 1 });

    expect(applyCalls).toHaveBeenCalledTimes(1);
    expect(applyCalls).toHaveBeenCalledWith("s1", {
      lastOutcome: "completed",
      lastErrorCode: null,
      endedAt: 2000,
    });
    const mapAfterComplete = result.current.liveTerminals;

    // Subsequent streaming ticks on another session or re-renders must NOT allocate new Map or re-fire applySessionTerminal
    version += 1;
    rerender({ chat: makeChat(), extraTick: 2 });
    version += 1;
    rerender({ chat: makeChat(), extraTick: 3 });

    expect(result.current.liveTerminals).toBe(mapAfterComplete);
    expect(applyCalls).toHaveBeenCalledTimes(1);

    // When s1 starts sending again, its terminal entry clears cleanly
    sending = true;
    version += 1;
    metaVersion += 1;
    rerender({ chat: makeChat(), extraTick: 4 });
    expect(result.current.liveTerminal("s1")).toBeUndefined();
    expect(applyCalls).toHaveBeenCalledTimes(1);
  });
});
