import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, test } from "vitest";
import { MOBILE_SESSION_NATIVE_DISMISS, Sheet } from "./Sheet";

const exactNativeDismissSelector =
  '[data-aurora-native-dismiss="mobile-session-v1"]';

function SessionSheetHarness() {
  const [surface, setSurface] = useState<"none" | "session" | "other">("none");
  return (
    <>
      <button type="button" onClick={() => setSurface("session")}>打开会话导航</button>
      <button type="button" onClick={() => setSurface("other")}>打开其它面板</button>
      <Sheet
        open={surface === "session"}
        onOpenChange={(open) => setSurface(open ? "session" : "none")}
        srTitle="会话导航"
        nativeDismissMarker={MOBILE_SESSION_NATIVE_DISMISS}
      >
        会话列表
      </Sheet>
      <Sheet
        open={surface === "other"}
        onOpenChange={(open) => setSurface(open ? "other" : "none")}
        srTitle="其它面板"
      >
        其它内容
      </Sheet>
    </>
  );
}

describe("Sheet — Harmony 原生精确关闭契约", () => {
  test("版本化 marker 只在移动会话 Sheet 打开时唯一存在，Escape 关闭后移除", async () => {
    render(<SessionSheetHarness />);
    expect(document.querySelectorAll(exactNativeDismissSelector)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "打开会话导航" }));
    const marker = await waitFor(() => {
      const matches = document.querySelectorAll(exactNativeDismissSelector);
      expect(matches).toHaveLength(1);
      return matches[0] as HTMLElement;
    });
    expect(marker).toHaveTextContent("会话列表");
    expect(marker).not.toHaveTextContent("其它内容");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(document.querySelectorAll(exactNativeDismissSelector)).toHaveLength(0),
    );

    fireEvent.click(screen.getByRole("button", { name: "打开其它面板" }));
    await screen.findByRole("dialog", { name: "其它面板" });
    expect(document.querySelectorAll(exactNativeDismissSelector)).toHaveLength(0);
  });
});
