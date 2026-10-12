import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { detectOcCli, resolveToolMeta } from "./meta";
import { researchToolCard } from "./researchCards";
import { thsUiBlocks } from "./thsCard";

afterEach(cleanup);

const QUOTE_UI =
  '```ui\n{"type":"quote","items":[{"code":"600519","name":"贵州茅台","status":"连续竞价","update_time":"2026-10-12 13:19","price":1281.37,"change":18.37,"change_pct":1.45,"prev_close":1263.0}],"source":"同花顺公开 Web 接口（ths 插件） · 2026-10-12 13:19"}\n```';

test("ths 命令被识别为同花顺插件调用（命令位置才算，路径前缀可）", () => {
  expect(detectOcCli("ths quote 600519 --ui")).toBe("ths");
  expect(detectOcCli("cd /tmp && /run/oc/platform/current/bin/ths kline 600519")).toBe("ths");
  expect(detectOcCli("cat ths.md")).toBeNull();
  expect(detectOcCli("echo ths")).toBeNull();
});

test("头部标签按子命令：同花顺 · 查行情 / 看 K 线", () => {
  expect(resolveToolMeta("Bash", { command: "ths quote 600519 --ui" }).label).toBe("同花顺 · 查行情");
  expect(resolveToolMeta("Bash", { command: "ths kline 600519 --period day --ui" }).label).toBe("同花顺 · 看 K 线");
});

test("--ui 输出：过程区直接渲染成行情卡（只读、数据就是 CLI 输出）", async () => {
  render(<div>{researchToolCard("ths quote 600519 --ui", { toolName: "Bash", output: QUOTE_UI, _completed: true })}</div>);
  expect(await screen.findByTestId("ths-tool-card")).toBeInTheDocument();
  expect(await screen.findByText("1281.37")).toBeInTheDocument();
  expect(screen.getByText("贵州茅台")).toBeInTheDocument();
});

test("不带 --ui 的 JSON 输出：不硬渲染组件，交给通用卡", () => {
  expect(thsUiBlocks('{"code":"600519","price":1281.37}')).toEqual([]);
  render(<div>{researchToolCard("ths quote 600519", { toolName: "Bash", output: '{"code":"600519"}', _completed: true })}</div>);
  expect(screen.queryByTestId("ths-tool-card")).not.toBeInTheDocument();
});
