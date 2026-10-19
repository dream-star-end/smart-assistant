import { describe, expect, test } from "vitest";
import { hasVisibleAssistantContent } from "./assistantVisibleContent";
import { nextPredictionOf } from "./inputPrediction";

describe("OCV5-525 visible assistant content", () => {
  test("recognizes only the UI control fences already hidden by the renderer", () => {
    for (const text of [
      '```ui\n{"type":"next","text":"通过"}\n```',
      '~~~ui\n{"type":"prediction","text":"通过"}\n~~~',
      '```ui{"type":"next","text":"通过"}```',
      '```ui\n{"type":"ne',
      '```ui\n',
      '```ui\n{"type":"next"}\n```\n\n```ui\n{"type":"prediction"}\n```',
    ]) expect(hasVisibleAssistantContent(text)).toBe(false);
    for (const text of [
      '完成。```ui{"type":"next","text":"通过"}```',
      '```json\n{"type":"next","text":"示例"}\n```',
      '````markdown\n```ui\n{"type":"next"}\n```\n````',
      '    ```ui\n    {"type":"next"}\n    ```',
      '```ui\n{"type":"table","columns":["名称"],"rows":[["结果"]]}\n```',
      '```ui\n{"type":"suggestions","items":["继续"]}\n```',
      '```ui\n{"type":"unknown"}\n```',
    ]) expect(hasVisibleAssistantContent(text)).toBe(true);
    expect(nextPredictionOf('```ui\n{"type":"next","text":"通过"}\n```')).toBe("通过");
  });
});
