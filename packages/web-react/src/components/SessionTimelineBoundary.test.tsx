import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionTimelineBoundary } from "./SessionTimelineBoundary";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Boom(): never {
  throw new Error("timeline boom");
}

function BrokenMessageCard(): never {
  const err = new TypeError("Cannot read properties of undefined (reading 'USER_BODY_SECRET')");
  err.stack = [
    "TypeError: Cannot read properties of undefined (reading 'USER_BODY_SECRET')",
    "    at BrokenMessageCard (https://oc.example/assets/MessageRenderer-9a8b.js:412:19)",
  ].join("\n");
  throw err;
}

describe("SessionTimelineBoundary", () => {
  test("React #185 只自动重挂一次，瞬时渲染循环不留下失败卡", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let allowRecovery = false;
    const onRetry = vi.fn(() => {
      allowRecovery = true;
    });
    function UpdateDepthUntilRetry() {
      if (!allowRecovery) throw new Error("Minified React error #185");
      return <div>恢复后的会话内容</div>;
    }
    render(
      <SessionTimelineBoundary resetKey="sess-depth" onRetry={onRetry}>
        <UpdateDepthUntilRetry />
      </SessionTimelineBoundary>,
    );
    await waitFor(() => expect(screen.getByText("恢复后的会话内容")).toBeInTheDocument());
    expect(screen.queryByTestId("timeline-fatal-error")).toBeNull();
    expect(onRetry).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  test("渲染失败占位按钮正名为「重新加载」并触发 onRetry", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const onRetry = vi.fn();
    render(
      <SessionTimelineBoundary resetKey="sess-btn" onRetry={onRetry}>
        <Boom />
      </SessionTimelineBoundary>,
    );
    expect(screen.queryByRole("button", { name: "继续" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  test("resetKey/activeId 变化后清除失败态,不把异常泄漏到下一会话", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <SessionTimelineBoundary resetKey="sess-a">
        <Boom />
      </SessionTimelineBoundary>,
    );
    expect(screen.getByTestId("timeline-fatal-error")).toBeInTheDocument();
    rerender(
      <SessionTimelineBoundary resetKey="sess-b">
        <div>下一会话内容</div>
      </SessionTimelineBoundary>,
    );
    expect(screen.queryByTestId("timeline-fatal-error")).toBeNull();
    expect(screen.getByText("下一会话内容")).toBeInTheDocument();
    err.mockRestore();
  });

  test("OCV5-77: TIMELINE_RENDER_ERROR 上报有界错误名、脚本帧、组件路径与跨会话一致指纹，且不泄漏用户正文", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));

    render(
      <SessionTimelineBoundary resetKey="webmtjc2282iys2o">
        <BrokenMessageCard />
      </SessionTimelineBoundary>,
    );
    cleanup();
    render(
      <SessionTimelineBoundary resetKey="webmtjgj2b8gslpy">
        <BrokenMessageCard />
      </SessionTimelineBoundary>,
    );

    const payloads = fetchMock.mock.calls
      .filter((call) => String(call[0]).includes("/api/client-errors"))
      .map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(payloads).toHaveLength(2);

    const [first, second] = payloads;
    expect(first).toMatchObject({
      surface: "chat",
      stage: "timeline_render",
      code: "TIMELINE_RENDER_ERROR",
      session_id: "webmtjc2282iys2o",
      attempts: 1,
      error_name: "TypeError",
      script_ref: "MessageRenderer-9a8b.js",
      line_no: 412,
      col_no: 19,
      path: "broken_message_card",
      reason: "undefined_dereference",
    });
    expect(first.error_fingerprint).toMatch(/^[a-f0-9]{8}$/);
    expect(second.session_id).toBe("webmtjgj2b8gslpy");
    expect(second.error_fingerprint).toBe(first.error_fingerprint);
    expect(JSON.stringify(payloads)).not.toContain("USER_BODY_SECRET");
    expect(first).not.toHaveProperty("message");
    expect(first).not.toHaveProperty("stack");
    err.mockRestore();
  });

  test("OCV5-77: REACT_UPDATE_DEPTH_185 携带 react_error_185 与重试次数，且 resetKey='none' 不上送伪会话 id", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    window.history.replaceState({}, "", "/s/webmt_route_sess");

    function AlwaysLoop(): never {
      const e = new Error("Minified React error #185");
      e.stack = "Error: Minified React error #185\n    at AlwaysLoop (https://oc.example/assets/index-1a2b.js:77:5)";
      throw e;
    }

    render(
      <SessionTimelineBoundary resetKey="none">
        <AlwaysLoop />
      </SessionTimelineBoundary>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const payloads = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(payloads[0]).toMatchObject({
      code: "REACT_UPDATE_DEPTH_185",
      session_id: "webmt_route_sess",
      attempts: 1,
      error_name: "Error",
      script_ref: "index-1a2b.js",
      line_no: 77,
      col_no: 5,
      path: "always_loop",
      reason: "react_error_185",
    });
    expect(payloads[1]).toMatchObject({
      code: "REACT_UPDATE_DEPTH_185",
      session_id: "webmt_route_sess",
      attempts: 2,
      reason: "react_error_185",
    });
    expect(payloads[0].error_fingerprint).toMatch(/^[a-f0-9]{8}$/);
    expect(payloads[1].error_fingerprint).toBe(payloads[0].error_fingerprint);
    err.mockRestore();
  });
});
