/**
 * 2J-1: 测试 packages/commercial/scripts/check-caddyfile.sh 的 grep 行为。
 *
 * 这是一个 P0 级安全规则:Caddy site config 里**绝不**能 reverse_proxy / handle
 * `/v1/*` 或 `/internal/*` —— 否则内部代理会被公网直接到达,身份校验链路绕过。
 *
 * 我们把 fixture Caddyfile 写到临时目录,跑 bash 脚本,断言退出码 + stderr/stdout。
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCRIPT = join(__dirname, "..", "..", "scripts", "check-caddyfile.sh");

let workDir: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "ocv3-caddy-"));
});

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function runChecker(content: string): { code: number; stdout: string; stderr: string } {
  const file = join(workDir, `cf-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(file, content);
  const res = spawnSync("bash", [SCRIPT, file], { encoding: "utf8" });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

const expect = (actual: unknown) => ({
  toBe: (expected: unknown) => assert.strictEqual(actual, expected),
  toContain: (substr: string) => assert.ok(String(actual).includes(substr), `expected to contain ${JSON.stringify(substr)}, got ${JSON.stringify(actual)}`),
  toMatch: (pattern: RegExp) => assert.match(String(actual), pattern),
  not: {
    toMatch: (pattern: RegExp) => assert.doesNotMatch(String(actual), pattern),
  },
});

describe("check-caddyfile.sh", () => {
  test("missing argument → exit 2", () => {
    const res = spawnSync("bash", [SCRIPT], { encoding: "utf8" });
    expect(res.status).toBe(2);
    expect((res.stdout ?? "") + (res.stderr ?? "")).toContain("用法");
  });

  test("non-existent file → exit 2", () => {
    const res = spawnSync("bash", [SCRIPT, "/nope/does-not-exist-zz.caddy"], { encoding: "utf8" });
    expect(res.status).toBe(2);
    expect((res.stdout ?? "") + (res.stderr ?? "")).toContain("不存在");
  });

  test("clean Caddyfile (only / /ws /modules/* /verify-email) → exit 0", () => {
    const res = runChecker(`
claudeai.chat {
    handle / {
        rewrite * /app.html
        reverse_proxy localhost:18789
    }
    handle /verify-email {
        rewrite * /app.html
        reverse_proxy localhost:18789
    }
    handle /modules/* {
        reverse_proxy localhost:18789
    }
    handle /ws {
        reverse_proxy localhost:18789
    }
    handle {
        reverse_proxy localhost:18789
    }
}
`);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("[OK]");
  });

  test("handle /v1/messages → exit 1 with violation line", () => {
    const res = runChecker(`
claudeai.chat {
    handle / {
        reverse_proxy localhost:18789
    }
    handle /v1/messages {
        reverse_proxy 172.30.0.1:18791
    }
}
`);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("[FAIL]");
    expect(res.stdout).toMatch(/handle \/v1\/messages/);
  });

  test("handle_path /internal/health → exit 1", () => {
    const res = runChecker(`
example.com {
    handle_path /internal/health {
        respond "ok"
    }
}
`);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/handle_path \/internal\/health/);
  });

  test("route /v1/* → exit 1", () => {
    const res = runChecker(`
claudeai.chat {
    route /v1/* {
        reverse_proxy localhost:18789
    }
}
`);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/route \/v1\/\*/);
  });

  test("reverse_proxy /internal/metrics directly → exit 1", () => {
    const res = runChecker(`
claudeai.chat {
    reverse_proxy /internal/metrics localhost:18789
}
`);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/reverse_proxy \/internal\/metrics/);
  });

  test("comments mentioning /v1/ /internal/ do not trigger fail", () => {
    const res = runChecker(`
# 注意: 不要 reverse_proxy /v1/messages 到外部!
# 同样禁止 handle /internal/* 出现在公网 site config
claudeai.chat {
    handle / {
        reverse_proxy localhost:18789
    }
}
`);
    expect(res.code).toBe(0);
  });

  test("multi-site mixed: clean site + bad site → exit 1 lists only bad lines", () => {
    const res = runChecker(`
example.com {
    handle / {
        respond "hi"
    }
}

claudeai.chat {
    handle /v1/messages {
        reverse_proxy 172.30.0.1:18791
    }
    handle /internal/admin {
        reverse_proxy localhost:18789
    }
}
`);
    expect(res.code).toBe(1);
    // 两个违规行都要出现
    expect(res.stdout).toMatch(/handle \/v1\/messages/);
    expect(res.stdout).toMatch(/handle \/internal\/admin/);
    // 干净的 example.com 行不能误报
    expect(res.stdout).not.toMatch(/handle \/$/m);
  });

  test("redir /internal/old → exit 1 (防止用 redir 偷绕)", () => {
    const res = runChecker(`
claudeai.chat {
    redir /internal/old /elsewhere
}
`);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/redir \/internal\/old/);
  });

  test("rewrite /v1/messages → exit 1", () => {
    const res = runChecker(`
claudeai.chat {
    rewrite /v1/messages /something-else
}
`);
    expect(res.code).toBe(1);
  });

  test("path /v1abc/ (前缀不匹配 /v1/) → exit 0 (正则要求斜杠分隔)", () => {
    const res = runChecker(`
claudeai.chat {
    handle /v1abc/foo {
        reverse_proxy localhost:18789
    }
}
`);
    expect(res.code).toBe(0);
  });

  // Codex 2026-04-20 audit: quoted token 是 Caddyfile 合法语法,旧正则会漏。
  test('quoted: handle "/v1/messages" → exit 1', () => {
    const res = runChecker(`
claudeai.chat {
    handle "/v1/messages" {
        reverse_proxy 172.30.0.1:18791
    }
}
`);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/handle "\/v1\/messages"/);
  });

  test('quoted: handle_path "/internal/admin" → exit 1', () => {
    const res = runChecker(`
example.com {
    handle_path "/internal/admin" {
        respond "ok"
    }
}
`);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/handle_path "\/internal\/admin"/);
  });
});
