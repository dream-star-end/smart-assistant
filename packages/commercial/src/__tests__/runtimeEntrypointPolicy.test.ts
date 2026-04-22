/**
 * 3A-1: 验证 packages/commercial/agent-sandbox/runtime/entrypoint.ts 的环境
 * 变量清洗策略与 personal-version `isProviderManagedEnvVar` helper 一致。
 *
 * 这个测试**不**真的跑 entrypoint.ts(它依赖容器内绝对路径 + npm 子进程,
 * 没法在 unit 层 spawn);而是把 entrypoint.ts 当作"策略声明文件",
 * 读源码提取 RETAIN_ENV_KEYS,然后断言:
 *
 *   1. RETAIN 集合 = {ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST}
 *      (supervisor 在 3C 注入的固定 3 个,不能多不能少)
 *   2. 这 3 个 RETAIN key **本身就是 managed** —— 即 "scrub 所有 managed 但
 *      白名单这 3 个" 的语义站得住,任意一个 retain key 不再被 helper 识别为
 *      managed 时,这个测试 fail,提醒同步
 *   3. 一组**已知危险的** routing env(从 §4.3 + master 旧账号路由代码摘的)
 *      必须**全部**被 helper 识别为 managed —— 防止 personal-version 哪天
 *      不小心把某个关键 key 删出 PROVIDER_MANAGED_ENV_VARS 集合却没人发现
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isProviderManagedEnvVar } from "../../../../claude-code-best/src/utils/managedEnvConstants.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ENTRYPOINT_TS_PATH = join(
  __dirname,
  "..",
  "..",
  "agent-sandbox",
  "runtime",
  "entrypoint.ts",
);

/** 从 entrypoint.ts 源码里抽 RETAIN_ENV_KEYS Set 的内容 */
function readRetainKeysFromSource(): Set<string> {
  const src = readFileSync(ENTRYPOINT_TS_PATH, "utf-8");
  // 定位 const RETAIN_ENV_KEYS = new Set([...]);
  const m = src.match(/const RETAIN_ENV_KEYS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!m) throw new Error("RETAIN_ENV_KEYS not found in entrypoint.ts");
  const body = m[1]!;
  const keys = new Set<string>();
  for (const lit of body.matchAll(/"([A-Z0-9_]+)"/g)) {
    keys.add(lit[1]!);
  }
  return keys;
}

const expect = (actual: unknown) => ({
  toBe: (expected: unknown) => assert.strictEqual(actual, expected),
  toEqual: (expected: unknown) => assert.deepStrictEqual(actual, expected),
  toBeTruthy: () => assert.ok(actual),
});

describe("openclaude-runtime entrypoint env-scrub policy", () => {
  const retain = readRetainKeysFromSource();

  test("RETAIN set 恰为 supervisor 在 3C 注入的 3 个 anthropic env", () => {
    expect([...retain].sort()).toEqual(
      ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"],
    );
  });

  test("RETAIN 里每个 key 本身都被 isProviderManagedEnvVar 识别为 managed", () => {
    // 语义:entrypoint.ts 用 "managed && !RETAIN" 来 scrub。如果某个 retain key 不再 managed,
    // helper 改了之后 retain 实质上变成 "无效白名单",scrub 逻辑悄无声息地不再保护它。
    for (const key of retain) {
      assert.ok(
        isProviderManagedEnvVar(key),
        `${key} 在 RETAIN 但 isProviderManagedEnvVar 不再识别它为 managed; ` +
          `personal-version managedEnvConstants.ts 可能改过,需要同步审查 entrypoint.ts`,
      );
    }
  });

  test("一组已知的危险路由 env 必须被 helper 识别为 managed (退化告警)", () => {
    const mustBeManaged = [
      // Provider 选择
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      // Endpoint 重定向
      "ANTHROPIC_BEDROCK_BASE_URL",
      "ANTHROPIC_VERTEX_BASE_URL",
      "ANTHROPIC_FOUNDRY_BASE_URL",
      // Auth
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "AWS_BEARER_TOKEN_BEDROCK",
      // Model defaults(其中一个采样)
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      // Vertex region 前缀
      "VERTEX_REGION_CLAUDE_4_5_SONNET",
    ];
    const notManaged = mustBeManaged.filter((k) => !isProviderManagedEnvVar(k));
    assert.deepStrictEqual(
      notManaged,
      [],
      `这些 env 应该被识别为 managed 但 helper 漏识别了: ${notManaged.join(",")}; ` +
        `personal-version managedEnvConstants.ts 可能误删,容器 entrypoint scrub 不到这些 key 会被运营 settings.json 反向覆盖`,
    );
  });

  test("普通 env (PATH / HOME / NODE_ENV) 不被识别为 managed (假阳性告警)", () => {
    for (const key of ["PATH", "HOME", "NODE_ENV", "TZ", "USER"]) {
      assert.ok(
        !isProviderManagedEnvVar(key),
        `${key} 被误识别为 managed,会被 entrypoint 误删,导致 npm run gateway 起不来`,
      );
    }
  });

  test("entrypoint.ts 强制 CLAUDE_CONFIG_DIR=/run/oc/claude-config", () => {
    const src = readFileSync(ENTRYPOINT_TS_PATH, "utf-8");
    assert.match(
      src,
      /cleanEnv\.CLAUDE_CONFIG_DIR\s*=\s*"\/run\/oc\/claude-config"/,
      "entrypoint.ts 必须强制 CLAUDE_CONFIG_DIR 指 tmpfs",
    );
  });

  test("entrypoint.ts 强制 OPENCLAUDE_HOME=/home/agent/.openclaude", () => {
    // 2026-04-22 P0 多租户防火墙 PR1 新增:容器内必须显式设 OPENCLAUDE_HOME,
    // 否则 subprocessRunner 向 MCP 传 `process.env.OPENCLAUDE_HOME ?? ''`,MCP
    // 侧 paths.ts 用 `?? join(homedir(), '.openclaude')` 兜底,空串不回退 → 相对路径,
    // memory/skill/cron 被写到 MCP cwd (/opt/openclaude) 而不是 per-user volume。
    const src = readFileSync(ENTRYPOINT_TS_PATH, "utf-8");
    assert.match(
      src,
      /cleanEnv\.OPENCLAUDE_HOME\s*=\s*"\/home\/agent\/\.openclaude"/,
      "entrypoint.ts 必须强制 OPENCLAUDE_HOME 指 volume 挂载点",
    );
  });
});
