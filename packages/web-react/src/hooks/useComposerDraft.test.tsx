import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { clearDraft, readDraft, writeDraft } from "../lib/composerDraft";
import { useComposerDraft } from "./useComposerDraft";

afterEach(() => {
  cleanup();
  for (const key of ["A", "B"]) clearDraft(key);
});

describe("useComposerDraft ownership", () => {
  test("StrictMode switches restore each owner, never overwrite target", () => {
    writeDraft("A", "、"); writeDraft("B", "B draft");
    const { result, rerender } = renderHook(({ id }) => useComposerDraft(id), {
      initialProps: { id: "A" },
      wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
    });
    rerender({ id: "B" });
    expect(result.current[0]).toBe("B draft");
    expect(readDraft("A")).toBe("、");
    act(() => result.current[1]("B edited"));
    rerender({ id: "A" });
    expect(result.current[0]).toBe("、");
    expect(readDraft("B")).toBe("B edited");
  });

  test("latest edit and deletion are committed without advancing timers", () => {
    const { result, rerender } = renderHook(({ id }) => useComposerDraft(id), { initialProps: { id: "A" } });
    act(() => result.current[1]("latest"));
    expect(readDraft("A")).toBe("latest");
    rerender({ id: "B" }); rerender({ id: "A" });
    expect(result.current[0]).toBe("latest");
    act(() => result.current[1](""));
    expect(readDraft("A")).toBe("");
    rerender({ id: "B" }); rerender({ id: "A" });
    expect(result.current[0]).toBe("");
  });

  test("stable functional setter uses the current owner", () => {
    const { result, rerender } = renderHook(({ id }) => useComposerDraft(id), { initialProps: { id: "A" } });
    const setText = result.current[1];
    rerender({ id: "B" });
    expect(result.current[1]).toBe(setText);
    act(() => { setText((v) => v + "one"); setText((v) => v + "two"); });
    expect(readDraft("B")).toBe("onetwo");
    expect(readDraft("A")).toBe("");
  });

  test("keyless demo input is local and cannot leak into a keyed session", () => {
    const { result, rerender } = renderHook(({ id }) => useComposerDraft(id), {
      initialProps: { id: undefined as string | undefined },
    });
    act(() => result.current[1]("local demo"));
    rerender({ id: "A" });
    expect(result.current[0]).toBe("");
  });

  test("oversized memory draft and its deletion survive owner switches", () => {
    const { result, rerender } = renderHook(({ id }) => useComposerDraft(id), { initialProps: { id: "A" } });
    const text = "中".repeat(8000);
    act(() => result.current[1](text));
    rerender({ id: "B" }); rerender({ id: "A" });
    expect(result.current[0]).toBe(text);
    act(() => result.current[1](""));
    rerender({ id: "B" }); rerender({ id: "A" });
    expect(result.current[0]).toBe("");
  });
});
