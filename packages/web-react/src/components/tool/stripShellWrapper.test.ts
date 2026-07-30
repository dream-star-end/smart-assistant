import { describe, expect, test } from "vitest";
import { stripShellWrapperForDisplay } from "./format";

// 展示层剥壳兜底 —— 历史消息的 command 落库时带 /bin/bash -lc 包装(后端剥壳只作用
// 于 2026-07-10 后的新帧)。载荷取自生产会话 webmrevafa0pvo3qm 的真实存量消息。
describe("stripShellWrapperForDisplay(legacy Bash 包装)", () => {
  test("双引号包裹(含转义双引号/命令替换)→ 解包出原始命令", () => {
    const raw =
      '/bin/bash -lc "printf \'cwd=%s\\nuser=%s\\n\' \\"$PWD\\" \\"$(id -un)\\" && git status --short | head -20"';
    const got = stripShellWrapperForDisplay(raw);
    expect(got.startsWith("printf 'cwd=%s\\nuser=%s\\n'")).toBe(true);
    expect(got).toContain("git status --short | head -20");
    expect(got).not.toContain("/bin/bash");
  });

  test("单/双引号相邻拼接(结尾非单引号)→ 解包且中文段保留", () => {
    const raw =
      "/bin/bash -lc 'rm -f /opt/openclaude/tool-card-example.png && test ! -e /opt/openclaude/tool-card-example.png && echo '\"'截图演示文件已清理'\"";
    const got = stripShellWrapperForDisplay(raw);
    expect(got.startsWith("rm -f /opt/openclaude/tool-card-example.png")).toBe(true);
    expect(got).toContain("echo '截图演示文件已清理'");
    expect(got).not.toContain("/bin/bash");
  });

  test("标准单引号包裹(含 '\\'' 转义)→ 解包还原内嵌单引号", () => {
    const raw = "/bin/bash -lc 'echo '\\''it'\\''s ok'\\'''";
    expect(stripShellWrapperForDisplay(raw)).toBe("echo 'it's ok'");
  });

  test("非包装命令原样透传(oc-browser 复合命令不受影响)", () => {
    const raw = "oc-browser open https://example.com && oc-browser snapshot";
    expect(stripShellWrapperForDisplay(raw)).toBe(raw);
  });

  test("未闭合引号(解析失败)→ 保守只剥前缀", () => {
    const raw = '/bin/bash -lc "echo broken';
    expect(stripShellWrapperForDisplay(raw)).toBe('"echo broken');
  });
});
