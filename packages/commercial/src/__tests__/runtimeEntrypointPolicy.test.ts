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

const WEB_AGENTS_MODULE_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "web",
  "public",
  "modules",
  "agents.js",
);

const WEB_AGENT_TEAMS_MODULE_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "web",
  "public",
  "modules",
  "agentTeams.js",
);

/**
 * personal-version 的 PROVIDER_MANAGED_ENV_VARS 源码 — 跨仓引用 .ts 源码会让 commercial
 * composite TS project 把外部源码纳入编译图,触发 rootDir/include 边界问题(S12a 三审 MAJOR 2)。
 * 改成读源码字符串解析:同已有 readRetainKeysFromSource() 模式,纯运行时,无编译期耦合。
 */
const MANAGED_ENV_CONSTANTS_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "claude-code-best",
  "src",
  "utils",
  "managedEnvConstants.ts",
);

/** 从 managedEnvConstants.ts 源码里抽 PROVIDER_MANAGED_ENV_VARS Set + PREFIXES list 的内容 */
function loadManagedEnvVarsFromSource(): { exact: Set<string>; prefixes: string[] } {
  const src = readFileSync(MANAGED_ENV_CONSTANTS_PATH, "utf-8");
  const setMatch = src.match(/PROVIDER_MANAGED_ENV_VARS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!setMatch) throw new Error("PROVIDER_MANAGED_ENV_VARS not found in managedEnvConstants.ts");
  const exact = new Set<string>();
  for (const lit of setMatch[1]!.matchAll(/['"]([A-Z0-9_]+)['"]/g)) exact.add(lit[1]!);
  const prefixMatch = src.match(/PROVIDER_MANAGED_ENV_PREFIXES\s*=\s*\[([\s\S]*?)\]/);
  const prefixes: string[] = [];
  if (prefixMatch) {
    for (const lit of prefixMatch[1]!.matchAll(/['"]([A-Z0-9_]+)['"]/g)) prefixes.push(lit[1]!);
  }
  return { exact, prefixes };
}

const MANAGED = loadManagedEnvVarsFromSource();

function isProviderManagedEnvVar(key: string): boolean {
  const upper = key.toUpperCase();
  return MANAGED.exact.has(upper) || MANAGED.prefixes.some((p) => upper.startsWith(p));
}

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

function extractConstObjectFromSource(src: string, name: string): string {
  const m = src.match(new RegExp(String.raw`const ${name} = \{([\s\S]*?)\n  \};`));
  if (!m) throw new Error(`${name} object not found in entrypoint.ts`);
  return m[0]!;
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

  test("entrypoint.ts wires a core-only toolset with no MCP servers, and strips retired browser/scansci/web-context", () => {
    const src = readFileSync(ENTRYPOINT_TS_PATH, "utf-8");
    assert.match(
      src,
      /const SCANSCI_PDF_DATA_DIR\s*=\s*"\/home\/agent\/\.local\/share\/scansci-pdf"/,
      "ScanSci PDF data dir must be under the per-user persistent .local volume",
    );
    assert.match(
      src,
      /cleanEnv\.SCANSCI_PDF_DATA_DIR\s*=\s*SCANSCI_PDF_DATA_DIR/,
      "entrypoint must still pass SCANSCI_PDF_DATA_DIR (the scansci-pdf CLI reads it)",
    );
    assert.match(
      src,
      /toolsets:\s*\[CORE_TOOLSET_ID\]/,
      "minimal openclaude.json must default to core toolset only",
    );
    assert.match(
      src,
      /\[CORE_TOOLSET_ID\]:\s*\[\]/,
      "core toolset must be empty so default turns stay lightweight",
    );
    assert.match(
      src,
      /mcpServers:\s*\[\]/,
      "minimal openclaude.json must mount no MCP servers now (browser is the oc-browser daemon)",
    );
    // browser + scansci-pdf + web-context all retired from MCP → CLI (baseline
    // skills). The minimal config must not re-introduce them, and upsert must
    // actively strip stale entries (servers + toolsets) from existing volumes.
    assert.doesNotMatch(
      src,
      /cloneScanSciPdfMcpServer\(\)|cloneWebContextMcpServer\(\)|cloneBrowserMcpServer\(\)/,
      "retired scansci/web-context/browser MCP server builders must be gone",
    );
    assert.doesNotMatch(
      src,
      /@playwright\/mcp/,
      "entrypoint must not reference @playwright/mcp (browser is the oc-browser daemon now)",
    );
    assert.doesNotMatch(
      src,
      /setToolset\(toolsets,\s*(?:RESEARCH_TOOLSET_ID|WEB_CONTEXT_TOOLSET_ID|BROWSER_TOOLSET_ID)/,
      "research / web_context / browser toolsets must no longer be provisioned",
    );
    assert.match(
      src,
      /removePlatformMcpServer\(existingServers,\s*BROWSER_MCP_ID\)[\s\S]*removePlatformMcpServer\(existingServers,\s*SCANSCI_PDF_MCP_ID\)[\s\S]*removePlatformMcpServer\(existingServers,\s*WEB_CONTEXT_MCP_ID\)/,
      "upsert must strip stale browser/scansci/web-context MCP entries from existing volumes",
    );
    assert.match(
      src,
      /deleteToolset\(toolsets,\s*BROWSER_TOOLSET_ID\)[\s\S]*deleteToolset\(toolsets,\s*RESEARCH_TOOLSET_ID\)[\s\S]*deleteToolset\(toolsets,\s*WEB_CONTEXT_TOOLSET_ID\)/,
      "upsert must strip stale browser/research/web_context toolsets from existing volumes",
    );
    assert.doesNotMatch(
      src,
      /for\s*\(\s*const\s+name\s+of\s+defaultToolsets\s*\)/,
      "entrypoint must not append ScanSci into every default toolset",
    );
    assert.doesNotMatch(
      src,
      /"scansci_pdf_config_get"/,
      "commercial default ScanSci tool list must not expose raw config dumps",
    );
  });

  test("entrypoint.ts seeds ONLY the main 全能助手 agent (v5 纯市场:子 agent 走市场安装)", () => {
    const src = readFileSync(ENTRYPOINT_TS_PATH, "utf-8");
    // 默认模型仍是 glm-5.2 / ark(火山方舟)
    assert.match(
      src,
      /const COMMERCIAL_DEFAULT_MODEL\s*=\s*"glm-5\.2"/,
      "commercial runtime default model must be glm-5.2",
    );
    assert.match(
      src,
      /const COMMERCIAL_DEFAULT_PROVIDER\s*=\s*"ark"/,
      "commercial runtime default provider must be ark (火山方舟)",
    );
    // 纯市场:初始 agents.yaml 只 seed main。desiredSeedAgents 恰为 [desiredMainAgent]。
    assert.match(
      src,
      /const desiredSeedAgents\s*=\s*\[desiredMainAgent\]/,
      "v5 纯市场:initial agents.yaml must seed only the main agent (其它 agent 走市场安装)",
    );
    const mainAgent = extractConstObjectFromSource(src, "desiredMainAgent");
    assert.match(mainAgent, /id:\s*"main"/, "main agent id must be stable");
    assert.match(mainAgent, /model:\s*COMMERCIAL_DEFAULT_MODEL/, "main must use DEFAULT model (glm-5.2)");
    assert.match(mainAgent, /provider:\s*COMMERCIAL_DEFAULT_PROVIDER/, "main must use DEFAULT provider (ark)");
    assert.match(mainAgent, /permissionMode:\s*"bypassPermissions"/, "main must bypass permissions in the sandbox");
    // 退役的平台预置子 agent / 团队定义不得再出现(纯市场根治 agent 数据分裂)。
    for (const removed of [
      "desiredResearcherAgent",
      "desiredScientistAgent",
      "desiredCoderAgent",
      "desiredReviewerAgent",
      "desiredScholarAgent",
      "desiredCollaborationSeedAgents",
      "desiredScienceTeam",
      "desiredProgrammingTeam",
    ]) {
      assert.doesNotMatch(
        src,
        new RegExp(`const ${removed}\\b`),
        `v5 纯市场:退役平台 seed ${removed} 必须已从 entrypoint 移除`,
      );
    }
    assert.doesNotMatch(
      src,
      /model:\s*"claude-opus-4-7"/,
      "entrypoint must not seed Claude Opus as an agent/openclaude default",
    );
    assert.doesNotMatch(
      src,
      /provider:\s*"claude-subscription"/,
      "entrypoint must not seed Claude subscription provider for the default commercial agent",
    );
    assert.doesNotMatch(
      src,
      /provider:\s*"codex-native"/,
      "v5 ccb-only: entrypoint must not seed any codex-native agent",
    );
  });

  test("entrypoint.ts seeds curated scientific skills only under scientist agent seed-skills (read-only layer)", () => {
    const src = readFileSync(ENTRYPOINT_TS_PATH, "utf-8");
    assert.match(
      src,
      /const KDENSE_SCIENTIFIC_SOURCE_COMMIT\s*=\s*"dab7aa672944a77f20cda3f2a672a6f1582adab6"/,
      "scientific skill seed must pin the audited upstream commit",
    );
    assert.match(
      src,
      /join\(ocConfigDir,\s*"agents",\s*agentId,\s*"seed-skills",\s*name\)/,
      "scientific seeds must be written to the per-agent read-only seed-skills layer (not the user-writable skills dir)",
    );
    assert.match(
      src,
      /ensureAgentSeedSkill\("scientist",\s*seed\.name,\s*scientificSkillContent\(seed\)\)/,
      "scientific seed loop must target only the scientist agent",
    );
    assert.match(src, /if \(existsSync\(skillPath\)\) return/, "skill seed must not overwrite existing skills");
    assert.doesNotMatch(
      src,
      /ccb-baseline\/skills|agent-sandbox\/ccb-baseline\/skills/,
      "scientific skills must not be added to global platform baseline",
    );
    for (const name of [
      "matplotlib",
      "statistical-analysis",
      "statsmodels",
      "scikit-learn",
      "sympy",
      "pymc",
      "pymoo",
      "aeon",
      "scanpy",
      "scvi-tools",
    ]) {
      assert.match(src, new RegExp(`name:\\s*"${name}"`), `scientist curated skill missing: ${name}`);
    }
  });

  test("entrypoint.ts seeds no codex/gpt agent (v5 ccb-only)", () => {
    const src = readFileSync(ENTRYPOINT_TS_PATH, "utf-8");
    assert.doesNotMatch(
      src,
      /const desiredCodexAgent\s*=/,
      "v5 ccb-only: entrypoint must not define a codex seed agent",
    );
    assert.doesNotMatch(
      src,
      /const COMMERCIAL_CODEX_MODEL\s*=/,
      "v5 ccb-only: entrypoint must not define the gpt-5.5 codex model const",
    );
    assert.doesNotMatch(
      src,
      /provider:\s*"codex-native"/,
      "v5 ccb-only: entrypoint must not seed any codex-native agent",
    );
  });

  test("entrypoint.ts repairs reserved seed agents without replacing custom fields wholesale", () => {
    const src = readFileSync(ENTRYPOINT_TS_PATH, "utf-8");
    assert.match(
      src,
      /function patchPlatformSeedAgent\([\s\S]*const next = \{ \.\.\.agent \}/,
      "seed repair must start from a copy of the existing agent to preserve custom fields",
    );
    assert.match(
      src,
      /"GPT 5\.5 \(default\)"/,
      "main drift to the old GPT 5.5 default display must be recognized as a platform seed",
    );
    assert.match(
      src,
      /backupAgentsYamlOnce\(`修复 \$\{desiredAgent\.id\} seed agent`\)/,
      "seed repair must back up agents.yaml before mutating existing config",
    );
    assert.doesNotMatch(
      src,
      /agents\[idx\]\s*=\s*desiredMainAgent/,
      "seed repair must not wholesale replace the existing main agent",
    );
  });

  test("entrypoint.ts migrates only exact legacy platform seed toolsets", () => {
    const src = readFileSync(ENTRYPOINT_TS_PATH, "utf-8");
    const patchBody = src.match(
      /function patchPlatformSeedAgent\([\s\S]*?return patched \? next : null;\n  \}/,
    )?.[0];
    assert.ok(patchBody, "patchPlatformSeedAgent body must be present");

    assert.match(
      src,
      /const LEGACY_RESEARCHER_TOOLSETS\s*=\s*\[\s*CORE_TOOLSET_ID,\s*BROWSER_TOOLSET_ID,\s*RESEARCH_TOOLSET_ID,\s*\]\s*as const/,
      "researcher legacy migration must be locked to the exact old platform default",
    );
    assert.match(
      src,
      /const LEGACY_CODER_TOOLSETS\s*=\s*\[CORE_TOOLSET_ID,\s*BROWSER_TOOLSET_ID\]\s*as const/,
      "coder legacy migration must be locked to the exact old platform default",
    );
    assert.match(
      src,
      /function isLegacyPlatformSeedToolsets\([\s\S]*sameStringArray\(toolsets,\s*legacy\)/,
      "legacy detection must use ordered sameStringArray exact-match, not set matching",
    );
    assert.match(
      patchBody,
      /!Array\.isArray\(next\.toolsets\)[\s\S]*setField\("toolsets", desired\.toolsets\)/,
      "seed repair must still fill missing toolsets from desired defaults",
    );
    assert.match(
      patchBody,
      /isLegacyPlatformSeedToolsets\(desired\.id, next\.toolsets\)[\s\S]*!sameStringArray\(next\.toolsets, desired\.toolsets\)[\s\S]*setField\("toolsets", desired\.toolsets\)/,
      "seed repair must migrate exact legacy researcher/coder defaults back to core-only",
    );
    assert.doesNotMatch(
      patchBody,
      /sameStringSet/,
      "seed repair must not use set matching; reordered or custom toolsets should remain untouched",
    );

    const exactLegacyMigrationCases = [
      { id: "researcher", current: ["core", "browser", "research"], shouldMigrate: true },
      { id: "coder", current: ["core", "browser"], shouldMigrate: true },
      { id: "researcher", current: ["core", "browser"], shouldMigrate: false },
      { id: "researcher", current: ["browser", "core", "research"], shouldMigrate: false },
      { id: "coder", current: ["core", "research"], shouldMigrate: false },
      { id: "coder", current: ["core", "browser", "custom"], shouldMigrate: false },
    ];
    for (const c of exactLegacyMigrationCases) {
      const legacy =
        c.id === "researcher"
          ? [["core", "browser", "research"]]
          : c.id === "coder"
            ? [["core", "browser"]]
            : [];
      const wouldMigrate = legacy.some(
        (ids) => ids.length === c.current.length && ids.every((id, i) => id === c.current[i]),
      );
      assert.equal(
        wouldMigrate,
        c.shouldMigrate,
        `legacy migration spec mismatch for ${c.id} ${JSON.stringify(c.current)}`,
      );
    }
  });

  test("entrypoint.ts pre-seeds NO teams (v5 轻量组队:队长 turn 级自主 delegate)", () => {
    const src = readFileSync(ENTRYPOINT_TS_PATH, "utf-8");
    // 纯市场轻量组队:不再预置任何默认团队,desiredSeedTeams 为空数组。
    assert.match(
      src,
      /const desiredSeedTeams:\s*Record<string,\s*unknown>\[\]\s*=\s*\[\]/,
      "v5:no default teams may be pre-seeded (leader forms ad-hoc team via delegate_task)",
    );
    // bootstrap 仍消费 desiredSeedTeams(空 → teams:[]),团队 merge 循环成为 no-op:
    // 存量容器已有的团队条目按设计不 prune,靠 listCollaboratorAgents 的 source 过滤惰性化。
    assert.match(
      src,
      /teams:\s*desiredSeedTeams\.map\(cloneSeedTeam\)/,
      "bootstrap still maps desiredSeedTeams (empty seed → teams:[])",
    );
    assert.match(
      src,
      /for \(const desiredTeam of desiredSeedTeams\)/,
      "team merge loop retained as no-op on empty seed (existing container teams not pruned)",
    );
  });

  test("entrypoint.ts migrates only exact old default science team to scientist member set", () => {
    const src = readFileSync(ENTRYPOINT_TS_PATH, "utf-8");
    assert.match(
      src,
      /const LEGACY_SCIENCE_TEAM_MEMBER_IDS\s*=\s*\["researcher",\s*"coder",\s*"reviewer"\]\s*as const/,
      "old default science team member set must be explicit",
    );
    assert.match(
      src,
      /const legacyScienceMembers\s*=[\s\S]*desired\.id === "science_research_team"[\s\S]*sameStringSet\(memberIds,\s*LEGACY_SCIENCE_TEAM_MEMBER_IDS\)[\s\S]*hasLegacyPlatformSeedTeamPrompt\(team,\s*desired\.id\)/,
      "old science migration must require exact old members plus legacy prompt markers",
    );
    assert.match(
      src,
      /return defaultName && defaultLeader && \(defaultMembers \|\| legacyScienceMembers\)/,
      "seed team repair must include the explicit old science-team migration branch",
    );

    const cases = [
      { current: ["researcher", "coder", "reviewer"], legacyPrompt: true, shouldMigrate: true },
      { current: ["reviewer", "researcher", "coder"], legacyPrompt: true, shouldMigrate: true },
      { current: ["researcher", "scientist", "coder", "reviewer"], legacyPrompt: true, shouldMigrate: false },
      { current: ["researcher", "coder"], legacyPrompt: true, shouldMigrate: false },
      { current: ["researcher", "coder", "reviewer", "custom"], legacyPrompt: true, shouldMigrate: false },
      { current: ["researcher", "coder", "reviewer"], legacyPrompt: false, shouldMigrate: false },
    ];
    const oldSet = ["researcher", "coder", "reviewer"];
    for (const c of cases) {
      const sameSet =
        c.current.length === oldSet.length && oldSet.every((id) => c.current.includes(id));
      assert.equal(
        sameSet && c.legacyPrompt,
        c.shouldMigrate,
        `science team migration spec mismatch for ${JSON.stringify(c.current)}`,
      );
    }
  });

  test("web agents fallback uses MiniMax-M3 (platform default) instead of an unsupported Claude default", () => {
    const src = readFileSync(WEB_AGENTS_MODULE_PATH, "utf-8");
    // main 队长 = glm-5.2/ark(2026-06-17);researcher 仍 MiniMax-M3/minimax;coder = glm-5.2/ark。
    assert.match(src, /model:\s*'MiniMax-M3'/, "web fallback must still have MiniMax-M3 (researcher)");
    assert.match(src, /provider:\s*'minimax'/, "web fallback must still have minimax provider (researcher)");
    assert.match(src, /model:\s*'glm-5\.2'/, "web fallback main/coder must use glm-5.2");
    assert.match(src, /provider:\s*'ark'/, "web fallback main/coder must use ark provider");
    assert.match(src, /id:\s*'scientist'/, "web fallback must include the scientist agent");
    assert.match(src, /displayName:\s*'科研分析师'/, "web fallback scientist display name must match runtime seed");
    // scholar(P2 综述写手)三权威源同步:web fallback 必含,与 entrypoint seed 一致
    assert.match(src, /id:\s*'scholar'/, "web fallback must include the scholar agent");
    assert.match(src, /displayName:\s*'科研写手'/, "web fallback scholar display name must match runtime seed");
    assert.match(src, /model:\s*'deepseek-v4-pro'/, "web fallback scientist/reviewer must use DeepSeek V4 Pro");
    assert.match(src, /provider:\s*'deepseek'/, "web fallback scientist/reviewer must use the deepseek provider");
    assert.doesNotMatch(
      src,
      /model:\s*'claude-opus-4-7'/,
      "web fallback must not show Claude Opus as the only main agent",
    );
  });
});

// 平台全局默认模型单一权威源守护:entrypoint.ts(runtime 镜像里本地常量,无法 import master src)
// 必须与 master 侧 platformDefaults.ts 的 PLATFORM_DEFAULT_MODEL/PROVIDER 一致。改一处忘改另一处 → 这里 fail。
describe("platform default model — entrypoint ↔ platformDefaults 一致性", () => {
  function extractConst(src: string, name: string): string {
    const m = src.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`));
    if (!m) throw new Error(`${name} not found in entrypoint.ts`);
    return m[1];
  }

  test("entrypoint COMMERCIAL_DEFAULT_MODEL/PROVIDER == platformDefaults 常量", async () => {
    const src = readFileSync(ENTRYPOINT_TS_PATH, "utf-8");
    const epModel = extractConst(src, "COMMERCIAL_DEFAULT_MODEL");
    const epProvider = extractConst(src, "COMMERCIAL_DEFAULT_PROVIDER");

    const { PLATFORM_DEFAULT_MODEL, PLATFORM_DEFAULT_PROVIDER } = await import(
      "../platformDefaults.js"
    );

    assert.equal(
      epModel,
      PLATFORM_DEFAULT_MODEL,
      "entrypoint.ts COMMERCIAL_DEFAULT_MODEL 与 platformDefaults.PLATFORM_DEFAULT_MODEL 漂移 —— 两处都要改",
    );
    assert.equal(
      epProvider,
      PLATFORM_DEFAULT_PROVIDER,
      "entrypoint.ts COMMERCIAL_DEFAULT_PROVIDER 与 platformDefaults.PLATFORM_DEFAULT_PROVIDER 漂移",
    );
    // 当前期望值(2026-06-17 起 glm-5.2 / ark —— boss 决定替换 glm-5.1、队长全切 glm-5.2,接受跨境风险)
    assert.equal(PLATFORM_DEFAULT_MODEL, "glm-5.2");
    assert.equal(PLATFORM_DEFAULT_PROVIDER, "ark");
  });
});
