import { describe, expect, test } from "vitest";
import { artifactEvidenceKeys } from "./ProcessDisclosure";

// OCV5-422: 时间线每次流式通知都要问每条助手正文的产物键;结果只取决于正文,按正文缓存。
describe("artifactEvidenceKeys", () => {
  test("同一正文返回同一份(冻结的)结果;正文变了重新计算", () => {
    const text = `看图：![图](/home/agent/.openclaude/generated/chart-${Math.random().toString(36).slice(2)}.png)`;
    const first = artifactEvidenceKeys(text);
    expect(first.length).toBeGreaterThan(0);
    expect(artifactEvidenceKeys(text)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    const longer = artifactEvidenceKeys(`${text}\n\n另见 /home/agent/.openclaude/generated/report.pdf`);
    expect(longer).not.toBe(first);
    expect(longer.length).toBe(first.length + 1);
    expect(artifactEvidenceKeys("没有产物的普通回答")).toEqual([]);
  });
});
