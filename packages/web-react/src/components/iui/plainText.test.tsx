import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hasUiFence, uiPlainText, uiPlainTextNow, useUiPlainText } from "./plainText";

const doc = ["对比如下:", "```ui", '{"type":"kv","items":[{"label":"重量","value":"1.2 kg"}]}', "```"].join("\n");

function Probe({ text }: { text: string }) {
  return <pre data-testid="out">{useUiPlainText(text)}</pre>;
}

describe("Intelligent UI plain text (lazy converter)", () => {
  it("text without a ui fence comes back unchanged", async () => {
    expect(hasUiFence("普通回答 ```js\nx\n```")).toBe(false);
    expect(uiPlainTextNow("普通回答")).toBe("普通回答");
    expect(await uiPlainText("普通回答")).toBe("普通回答");
  });

  it("async conversion turns ui blocks into Markdown", async () => {
    const md = await uiPlainText(doc);
    expect(md).toContain("重量");
    expect(md).toContain("1.2 kg");
    expect(md).not.toContain("```ui");
  });

  it("the hook re-renders with the Markdown version once the converter is loaded", async () => {
    render(<Probe text={doc} />);
    await waitFor(() => expect(screen.getByTestId("out").textContent).not.toContain("```ui"));
    expect(screen.getByTestId("out").textContent).toContain("1.2 kg");
  });
});
