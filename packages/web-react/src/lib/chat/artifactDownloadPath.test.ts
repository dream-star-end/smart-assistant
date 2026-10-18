import { describe, expect, test } from "vitest";
import { artifactDownloadPath } from "./artifactDownloadPath";

describe("artifactDownloadPath", () => {
  test("recognizes platform files and decodes their actual filename once", () => {
    expect(artifactDownloadPath("/home/agent/.openclaude/generated/sales.csv")).toBe("/home/agent/.openclaude/generated/sales.csv");
    expect(artifactDownloadPath("/root/.openclaude/uploads/%E6%8A%A5%E8%A1%A8%202026.csv")).toBe("/root/.openclaude/uploads/报表 2026.csv");
  });
  test("keeps websites, preview URLs and noncanonical paths outside signing", () => {
    for (const href of [undefined, "#section", "/help/report.csv", "https://example.com/a.csv", "//example.com/a.csv", "/api/preview/a", "/home/agent/.openclaude/generated/../secret", "/home/agent/.openclaude/generated/%2e%2e/secret", "/home/agent/.openclaude/generated/a%2fb/../secret", "/home/agent/.openclaude/generated/a?x", "/home/agent/.openclaude/generated/%zz", "/home/agent/.openclaude/generated/", "/home/agent/.openclaude/generated/a%5cb"]) {
      expect(artifactDownloadPath(href), href).toBeNull();
    }
  });
});
