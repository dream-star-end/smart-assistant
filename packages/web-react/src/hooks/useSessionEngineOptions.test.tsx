import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { readSessionEffort } from "../lib/sessionEffort";
import { readContextTierForSession } from "../lib/sessionContextTier";
import { useSessionEngineOptions } from "./useSessionEngineOptions";

afterEach(() => {
  localStorage.clear();
});

describe("useSessionEngineOptions", () => {
  test("a choice is stored for its session and read back when the session is selected again", () => {
    const { result, rerender } = renderHook((id: string | undefined) => useSessionEngineOptions(id), {
      initialProps: "s1",
    });
    expect(result.current.sessionEffort).toBeUndefined();
    act(() => {
      result.current.setSessionEffort("high");
      result.current.setContextTier("1m");
    });
    expect(result.current.sessionEffort).toBe("high");
    expect(result.current.contextTier).toBe("1m");
    expect(readSessionEffort("s1")).toBe("high");
    expect(readContextTierForSession("s1")).toBe("1m");

    rerender("s2");
    expect(result.current.sessionEffort).toBe(readSessionEffort("s2"));
    expect(result.current.contextTier).toBe(readContextTierForSession("s2"));

    rerender("s1");
    expect(result.current.sessionEffort).toBe("high");
    expect(result.current.contextTier).toBe("1m");
  });
});
