import { describe, expect, test } from "vitest";
import type { LiveUnit } from "@openclaude/protocol";
import { liveUnitToMessage } from "./liveUnitsHydrate";

function toolUnit(overrides: Partial<LiveUnit> & { inputPreview?: string }): LiveUnit {
  return {
    id: "u1",
    kind: "tool",
    seqFirst: 1,
    seqLast: 1,
    recordIdFirst: "r1",
    recordIdLast: "r1",
    open: true,
    clientMessageId: "m-1",
    toolName: "Bash",
    ...overrides,
  } as LiveUnit;
}

describe("liveUnitToMessage tool 行", () => {
  test("text 留空，不把 toolName 写成正文", () => {
    const msg = liveUnitToMessage(
      toolUnit({
        text: '{"command":"oc-memory delegate --goal x"}',
        inputJson: { command: "oc-memory delegate --goal x" },
      }),
    );
    expect(msg.role).toBe("tool");
    expect(msg.toolName).toBe("Bash");
    expect(msg.text).toBe("");
    expect(msg.text).not.toBe("Bash");
  });

  test("从 fold 的 unit.text 补拷 inputPreview", () => {
    const preview = '{"command":"oc-memory delegate --goal x"}';
    const msg = liveUnitToMessage(
      toolUnit({
        text: preview,
        inputJson: { command: "oc-memory delegate --goal x" },
      }),
    );
    expect(msg.inputPreview).toBe(preview);
    expect(msg.inputJson).toEqual({ command: "oc-memory delegate --goal x" });
  });

  test("显式 inputPreview 优先于 fold text", () => {
    const msg = liveUnitToMessage(
      toolUnit({
        text: '{"command":"stale"}',
        inputPreview: '{"command":"ls -la"}',
        inputJson: { command: "ls -la" },
      }),
    );
    expect(msg.inputPreview).toBe('{"command":"ls -la"}');
    expect(msg.text).toBe("");
  });
});
