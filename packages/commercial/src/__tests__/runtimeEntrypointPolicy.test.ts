/**
 * 3A-1: 验证 packages/commercial/agent-sandbox/platform-runtime/entrypoint/entrypoint.ts 的环境
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
// P2 债C 两源一致性:reviewer 裁决词汇的单一权威源。commercial 是 tsc/node-test(可 import
// protocol,已有 staticProviderGuard/agentModelAuthority 等测试先例);entrypoint.ts 则因是
// 容器内运行时脚本、非 tsc 编译只能硬编码字面量 → 用本测试把这两源锁在一起。
import { REVIEW_VERDICTS } from "@openclaude/protocol";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// runtime hotcfg:entrypoint 迁 platform-runtime/entrypoint/(bundle 源);SCIENTIST 种子内容 /
// persona 文案 / seed 声明已外置为文件(见 entrypointPlatform.test.ts 的行为断言)。本文件继续守
// entrypoint.ts **源码里保留的机制**(env scrub / 计费常量 / merge 逻辑 / buildSeedAgent 装配)。
const ENTRYPOINT_TS_PATH = join(
  __dirname,
  "..",
  "..",
  "agent-sandbox",
  "platform-runtime",
  "entrypoint",
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

// runtime hotcfg:desiredXAgent 不再是内联对象字面量(改由 buildSeedAgent 装配 yaml 声明 + billing
// 常量),extractConstObjectFromSource 随之退役;seed 对象结构的行为断言见 entrypointPlatform.test.ts。

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
    const ordinary = [
      "PATH",
      "HOME",
      "NODE_ENV",
      "TZ",
      "USER",
      "OC_CONTAINER_PREVIEW_ENABLED",
    ];
    for (const key of ordinary) {
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
      "minimal openclaude.json must mount no MCP servers now (browser uses the official CLI)",
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
      "entrypoint must not reference @playwright/mcp (Agent browser uses the official CLI)",
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

  test("entrypoint.ts 的 seed 装配全部来自 platform-seed 声明(schema v2:本地 billing 常量已删)", () => {
    const src = readFileSync(ENTRYPOINT_TS_PATH, "utf-8");
    // ── 模型权威批次 §5 阶段 A:entrypoint **不得再持有任何本地计费/引擎常量** ──
    // 双端硬编码(entrypoint 常量 + master platformDefaults)正是滚动窗口计费分叉的根;
    // 权威已下沉到 bundle 内的 platform-seed.yaml 声明,master 阶段 B 按 bundle_rev 读同一份。
    for (const retired of [
      "COMMERCIAL_DEFAULT_MODEL",
      "COMMERCIAL_DEFAULT_PROVIDER",
      "COMMERCIAL_CODEX_MODEL",
      "COMMERCIAL_HIDDEN_REVIEWER_MODEL",
      "COMMERCIAL_HIDDEN_REVIEWER_PROVIDER",
    ]) {
      assert.doesNotMatch(
        src,
        new RegExp(`const ${retired}\\s*=`),
        `${retired} 必须已删除 —— 执行三元组权威在 platform-seed.yaml 声明(schema v2),不得回潮为本地常量`,
      );
    }
    // 裸模型字面量回潮防线:entrypoint 源码里不得再出现任何模型 id 字面量。
    assert.doesNotMatch(src, /"glm-5\.2"/, "entrypoint 不得再硬编码 glm-5.2(权威在 seed 声明)");
    assert.doesNotMatch(src, /"gpt-5\.6-[a-z]+"/, "entrypoint 不得再硬编码 codex 型号(权威在 seed 声明)");

    // seed 装配:遍历声明 → buildSeedAgent(decl),执行三元组恒由 decl 带入。
    assert.match(
      src,
      /for \(const decl of seedDoc\.agents\)/,
      "seed 集合必须来自声明(生产 = main + codex + hidden-reviewer;其它可见 agent 走市场安装)",
    );
    assert.match(
      src,
      /buildSeedAgent\(\{\s*id: decl\.id,\s*decl,/,
      "buildSeedAgent 必须以声明为执行权威(不再有 billing 常量注入面)",
    );
    // 容器 config.defaults.model 同样从 main 的声明派生(不再是本地常量)。
    assert.match(
      src,
      /const CONTAINER_DEFAULT_MODEL = seedMainDecl\.model/,
      "容器默认模型必须取自 main seed agent 的声明",
    );
    assert.match(src, /model: CONTAINER_DEFAULT_MODEL/, "bootstrap 的 config.defaults.model 必须用声明派生值");
    // codex 队长显示名:按**声明的 model** 反查 protocol 型号目录(显示名权威留 protocol,不抄第二份)。
    assert.match(
      src,
      /CODEX_ENGINE_MODELS\.find\(\(m\) => m\.id === model\)/,
      "codex displayName 必须按声明的 model 反查 protocol 型号目录",
    );
    assert.match(
      src,
      /decl\.provider === "codex-native"/,
      "codex-native 的动态显示名派生必须按 provider 判定(不硬编码 agent id)",
    );
    // 隐藏 agent 保留 id 修复路径(reserved-id repair)仍在 patchPlatformSeedAgent(merge 逻辑不迁)。
    assert.match(src, /desired\.id === "hidden-reviewer"/, "hidden reviewer must have a dedicated reserved-id repair path");
    assert.match(src, /"source", "cwd", "greeting", "mcpServers"/, "hidden reviewer repair must strip user/marketplace-controlled fields");
    assert.match(src, /delete next\[key\]/, "hidden reviewer repair must remove stale source/cwd/mcp fields");
    assert.match(src, /setField\("toolsets", desired\.toolsets\)/, "hidden reviewer repair must force core-only toolsets");
    assert.match(
      src,
      /ensureAgentPersona\(decl\.id, personaContent, \{ force: decl\.forcePersona \?\? false \}\)/,
      "persona 强制刷新与否由声明的 forcePersona 决定(hidden-reviewer 声明 true,见一致性锚)",
    );
    // P2 债E 收口:隐藏 agent id 权威已上移 @openclaude/protocol,entrypoint 不再手抄
    // 黑名单,改 import 共享权威;本地 isHiddenSystemAgentId(id:unknown) 只做类型收窄后
    // 委派。守护意图从「entrypoint 自持一份识别逻辑(两源约定同步)」升级为「entrypoint
    // 与 gateway 编译期共享唯一权威(一源)」—— 防止回退成手抄字面量。
    assert.match(
      src,
      /import \{ isHiddenSystemAgentId as isHiddenSystemAgentIdShared \} from "\/opt\/openclaude\/packages\/protocol\/src\/agentVisibility\.ts"/,
      "entrypoint must import the hidden-agent id authority from @openclaude/protocol (single source, no hand-copied blacklist)",
    );
    assert.match(
      src,
      /function isHiddenSystemAgentId\(id: unknown\): boolean \{\s*return typeof id === "string" && isHiddenSystemAgentIdShared\(id\);/,
      "entrypoint's isHiddenSystemAgentId must delegate to the shared protocol authority (type-narrow adapter only)",
    );
    assert.doesNotMatch(
      src,
      /function isHiddenSystemAgentId\(id: unknown\): boolean \{\s*return id === "hidden-reviewer";/,
      "entrypoint must not re-introduce a hand-copied hidden-reviewer literal in the recognizer",
    );
    assert.match(src, /const routes = rawRoutes\.filter\(\(route\) => !isHiddenSystemAgentRoute\(route\)\)/, "entrypoint must strip stale routes targeting hidden reviewer");
    assert.match(src, /agentIds\.has\(doc\.default\) && !isHiddenSystemAgentId\(doc\.default\)/, "entrypoint must not preserve hidden reviewer as default agent");
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
  });

  // ───────────────────────────────────────────────
  // P2 债C:reviewer persona ↔ @openclaude/protocol 裁决词汇 两源一致性
  // ───────────────────────────────────────────────
  // 历史断裂:reviewer persona 让模型"输出 PASS / NEEDS_FIX"(自由文本),而 gateway 的
  // parseVerificationVerdict 只认结构化行 `VERDICT: <值>`,两条管线互不相认 → 硬编排解析不到
  // 裁决。现在 persona 必须在末行输出结构化裁决行,词汇由 @openclaude/protocol REVIEW_VERDICTS
  // 单一权威。本测试把两源锁在一起:任一源改动裁决词而另一源没跟 → 红。
  // 漂移后果:gateway 解析不到 VERDICT 行 → 判"审查未完成"并降级放行,团队模式隐藏审查形同虚设。
  test("hidden reviewer persona 的结构化裁决词汇与 @openclaude/protocol REVIEW_VERDICTS 两源一致", () => {
    // runtime hotcfg:persona 文案已外置为 bundle 文件 personas/hidden-reviewer.md(不再内联 entrypoint)。
    // 两源一致性(persona VERDICT 行 ↔ protocol 权威裁决词)照守,只是源1改读该文件。
    const personaPath = join(
      __dirname, "..", "..", "agent-sandbox", "platform-runtime", "seed", "personas", "hidden-reviewer.md",
    );
    const personaSrc = readFileSync(personaPath, "utf-8");

    // 源2 = protocol 权威裁决词(不再手抄,直接 import);当前应为 ['PASS','NEEDS_FIX']。
    // 兜底断言:如果哪天 protocol 词汇集变了,下面遍历会用新集合逐个校验 persona 是否跟进。
    assert.ok(
      REVIEW_VERDICTS.length >= 2,
      "REVIEW_VERDICTS 至少应含 PASS / NEEDS_FIX 两个裁决值(protocol teamCards.ts 单一权威)",
    );

    // 1) persona(源1,entrypoint.ts 源码文本)必须包含结构化裁决行形态,gateway 正则
    //    /^VERDICT:\s*(PASS|FAIL|PARTIAL|NEEDS_FIX)\s*$/m 才解析得到裁决。
    assert.match(
      personaSrc,
      /VERDICT:\s*PASS/,
      "reviewer persona 必须指示输出结构化裁决行 `VERDICT: PASS`;缺失则 gateway 解析不到裁决 → 降级放行",
    );
    assert.match(
      personaSrc,
      /VERDICT:\s*NEEDS_FIX/,
      "reviewer persona 必须指示输出结构化裁决行 `VERDICT: NEEDS_FIX`;缺失则 NEEDS_FIX 无法触发 continuation",
    );

    // 2) 遍历断言:protocol 权威里的**每个**裁决值,persona 都必须以结构化行形态提到。
    //    这样将来 protocol 加/改裁决词而 persona 没跟,这里就会红(锁死两源)。
    for (const verdict of REVIEW_VERDICTS) {
      assert.match(
        personaSrc,
        new RegExp(`VERDICT:\\s*${verdict}`),
        `@openclaude/protocol REVIEW_VERDICTS 含 "${verdict}",但 entrypoint reviewer persona 未指示输出 ` +
          `\`VERDICT: ${verdict}\` —— 两源漂移:gateway 解析器认这个词,persona 却不产出它,` +
          `团队硬编排会解析不到裁决而降级放行。protocol 改裁决词必须同步改 entrypoint persona。`,
      );
    }

    // 3) 证明已从旧自由文本形态改造:旧文案只让模型"输出 PASS / NEEDS_FIX",无结构化 VERDICT 行,
    //    gateway parseVerificationVerdict 认不出。改造后这句旧文案必须消失。
    assert.doesNotMatch(
      personaSrc,
      /只输出简洁审查结论：PASS \/ NEEDS_FIX/,
      "reviewer persona 仍是旧自由文本形态(未产出结构化 VERDICT 行)—— gateway 认不出裁决,硬编排失效",
    );
  });

  test("entrypoint.ts seeds curated scientific skills via externalized bundle files (yaml-manifest driven)", () => {
    // runtime hotcfg P2a:SCIENTIST 种子内容已外置为 bundle 文件(seed/skills/scientist/<name>/SKILL.md),
    // 清单在 platform-seed.yaml 的 seedSkills。**内容/清单断言移到 entrypointPlatform.test.ts**(读文件+yaml)。
    // 此处只守 entrypoint **源码里保留的 seed 机制**:read-only seed-skills 层 + 幂等 + 泛化 yaml 驱动。
    const src = readFileSync(ENTRYPOINT_TS_PATH, "utf-8");
    assert.match(
      src,
      /join\(ocConfigDir,\s*"agents",\s*agentId,\s*"seed-skills",\s*name\)/,
      "scientific seeds must be written to the per-agent read-only seed-skills layer (not the user-writable skills dir)",
    );
    assert.match(
      src,
      /for \(const \[seedAgentId, skillNames\] of Object\.entries\(platformSeed\.seedSkills\)\)/,
      "seed skill loop must be driven by the platform-seed.yaml seedSkills manifest (generic, not hardcoded scientist)",
    );
    assert.match(
      src,
      /ensureAgentSeedSkill\(seedAgentId,\s*skillName,\s*readFileSync\(skillMd,\s*"utf8"\)\)/,
      "seed skill content must be read from the bundle SKILL.md file, not an inline TS constant",
    );
    // M4a(runtime hotcfg):平台 seed skill 从 skip-if-exists 改**内容 hash 不一致即覆写**
    // (与 codex-skills overlay 同款 shouldWriteSeededSkill("hash-overwrite")),平台更新的 skill
    // 内容才能送达存量 volume。故不再有 `if (existsSync(skillPath)) return` 短路。
    assert.doesNotMatch(src, /if \(existsSync\(skillPath\)\) return;/, "seed skill 不得再走 skip-if-exists 短路(改 hash-overwrite)");
    assert.match(
      src,
      /shouldWriteSeededSkill\("hash-overwrite", targetExists, targetContent, content\)/,
      "seed skill 覆写决策必须复用共用纯函数 shouldWriteSeededSkill(hash-overwrite)",
    );
    // 反回潮:内容/清单不得再内联进 entrypoint(必须走 bundle 文件)。
    assert.doesNotMatch(src, /const SCIENTIST_SKILL_SEEDS/, "scientist seed content must be externalized to bundle files, not inline");
    assert.doesNotMatch(src, /function scientificSkillContent/, "scientificSkillContent must be gone (content lives in bundle files)");
    assert.doesNotMatch(src, /KDENSE_SCIENTIFIC_SOURCE_COMMIT/, "pinned commit must live in the bundle SKILL.md frontmatter, not entrypoint");
    assert.doesNotMatch(
      src,
      /ccb-baseline\/skills|agent-sandbox\/ccb-baseline\/skills/,
      "scientific skills must not be added to global platform baseline",
    );
  });

  test("codex/GPT-5.6 默认队长的路由字段(provider/runnerKind)落在 seed 声明里(schema v2)", () => {
    // 模型权威 §5 阶段 A:codex 的 model/provider/runnerKind 已从 entrypoint 常量迁到 platform-seed.yaml。
    // provider/runnerKind 是 gateway runner seam 的路由依据,缺失/写错 = 落错 runner(CCB 跑 codex 模型)。
    // 声明值与 protocol DEFAULT_CODEX_ENGINE_MODEL 的一致性由本文件末尾的**一致性锚**守护;
    // 这里守的是"声明里确实带着这三个字段",与 entrypoint 源码里显示名的动态派生。
    const src = readFileSync(ENTRYPOINT_TS_PATH, "utf-8");
    const seedYaml = readFileSync(
      join(__dirname, "..", "..", "agent-sandbox", "platform-runtime", "seed", "platform-seed.yaml"),
      "utf-8",
    );
    assert.match(seedYaml, /- id: codex\n\s+model: gpt-5\.6-[a-z]+\n\s+provider: codex-native\n\s+runnerKind: app-server/,
      "codex 声明必须带 model + codex-native provider + app-server runnerKind(gateway runner 路由依据)");
    assert.match(
      src,
      /return `\$\{spec\.displayName\} 队长`/,
      "codex display name must be derived from the protocol engine display name (按声明的 model 反查)",
    );
    assert.doesNotMatch(
      src,
      /DEFAULT_CODEX_ENGINE_MODEL_DISPLAY_NAME/,
      "显示名不得再钉死在 protocol 的『默认型号』常量上 —— 必须按**声明的** model 反查(换型号只改 yaml)",
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
    // main 队长 = glm-5.3/ark(2026-08-14);researcher 仍 MiniMax-M3/minimax;coder = glm-5.3/ark。
    assert.match(src, /model:\s*'MiniMax-M3'/, "web fallback must still have MiniMax-M3 (researcher)");
    assert.match(src, /provider:\s*'minimax'/, "web fallback must still have minimax provider (researcher)");
    assert.match(src, /model:\s*'glm-5\.3'/, "web fallback main/coder must use glm-5.3");
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

// ───────────────────────────────────────────────────────────────────────
// 模型权威 §5 阶段 A —— **一致性锚**:platform-seed.yaml 声明 == master platformDefaults/protocol 常量
// ───────────────────────────────────────────────────────────────────────
//
// 取代旧的"entrypoint 本地常量 ↔ platformDefaults 双源文本守护"(entrypoint 常量已删)。
//
// 阶段 A 的核心保证:seed 声明化后**行为零变化** —— 因为声明的值与 master 判定用的常量字面相等。
// 这条锚成立,阶段 B(master 改按 bundle_rev 读声明)才是"判定源切换但集合等值"的安全切换;
// 锚一旦断(有人只改一边),阶段 B 开 flag 的瞬间计费模型就会跳变。
//
// 声明是**唯一**权威(容器侧);master 常量在阶段 B 之后退化为回落路径 + 本锚的对照值。
// 改模型的正确姿势:改 platform-seed.yaml + 同步改 platformDefaults.ts,两边一起过本测试。
describe("模型权威阶段 A 一致性锚:platform-seed 声明 == master 常量", () => {
  const SEED_YAML_PATH = join(
    __dirname, "..", "..", "agent-sandbox", "platform-runtime", "seed", "platform-seed.yaml",
  );
  // 非字面量路径 → tsc 不解析(any);tsx 运行时按 .ts 载入(与 entrypointPlatform.test.ts 同款)。
  const PLATFORM_BUNDLE_PATH = join(
    __dirname, "..", "..", "agent-sandbox", "platform-runtime", "entrypoint", "platformBundle.ts",
  );

  async function loadSeed(): Promise<{
    pb: any;
    agents: Record<string, { model: string; provider: string; runnerKind?: string; forcePersona?: boolean }>;
  }> {
    const pb = await import(PLATFORM_BUNDLE_PATH);
    const { parse } = await import("yaml");
    const doc = pb.validatePlatformSeed(parse(readFileSync(SEED_YAML_PATH, "utf-8")));
    const agents: Record<string, any> = {};
    for (const a of doc.agents) agents[a.id] = a;
    return { pb, agents };
  }

  test("main / hidden-reviewer 声明 == platformDefaults;codex 声明 == protocol DEFAULT_CODEX_ENGINE_MODEL", async () => {
    const { agents } = await loadSeed();
    const {
      PLATFORM_DEFAULT_MODEL,
      PLATFORM_DEFAULT_PROVIDER,
      PLATFORM_HIDDEN_REVIEWER_MODEL,
      PLATFORM_HIDDEN_REVIEWER_PROVIDER,
    } = await import("../platformDefaults.js");
    const { DEFAULT_CODEX_ENGINE_MODEL } = await import("@openclaude/protocol");

    assert.equal(
      agents.main?.model,
      PLATFORM_DEFAULT_MODEL,
      "platform-seed main.model 与 platformDefaults.PLATFORM_DEFAULT_MODEL 漂移 —— 两处必须同改",
    );
    assert.equal(agents.main?.provider, PLATFORM_DEFAULT_PROVIDER, "platform-seed main.provider 漂移");
    assert.equal(
      agents["hidden-reviewer"]?.model,
      PLATFORM_HIDDEN_REVIEWER_MODEL,
      "platform-seed hidden-reviewer.model 与 platformDefaults 漂移",
    );
    assert.equal(
      agents["hidden-reviewer"]?.provider,
      PLATFORM_HIDDEN_REVIEWER_PROVIDER,
      "platform-seed hidden-reviewer.provider 与 platformDefaults 漂移",
    );
    assert.equal(
      agents.codex?.model,
      DEFAULT_CODEX_ENGINE_MODEL,
      "platform-seed codex.model 与 protocol DEFAULT_CODEX_ENGINE_MODEL 漂移(队长型号唯一权威在 protocol 型号表)",
    );
    assert.equal(agents.codex?.provider, "codex-native", "codex 必须 pin codex-native(gateway registry 路由依据)");
    assert.equal(agents.codex?.runnerKind, "app-server", "codex runner 必须是 app-server");
    assert.equal(agents["hidden-reviewer"]?.forcePersona, true, "隐藏审查员 persona 必须每 boot 强刷(裁决词同步)");

    // 当前期望值(2026-08-14 起 glm-5.3 / ark Coding Plan)。
    assert.equal(PLATFORM_DEFAULT_MODEL, "glm-5.3");
    assert.equal(PLATFORM_DEFAULT_PROVIDER, "ark");
    assert.equal(PLATFORM_HIDDEN_REVIEWER_MODEL, "glm-5.3");
    assert.equal(PLATFORM_HIDDEN_REVIEWER_PROVIDER, "ark");
  });

  test("dev fallback 内置声明 == platformDefaults(无 bundle 的 dev 路径也不许漂)", async () => {
    const { pb } = await loadSeed();
    const { PLATFORM_DEFAULT_MODEL, PLATFORM_DEFAULT_PROVIDER } = await import("../platformDefaults.js");
    const main = pb.DEV_FALLBACK_SEED_DOC.agents.find((a: { id: string }) => a.id === "main");
    assert.equal(main.model, PLATFORM_DEFAULT_MODEL, "DEV_FALLBACK_SEED_DOC.main.model 漂移");
    assert.equal(main.provider, PLATFORM_DEFAULT_PROVIDER, "DEV_FALLBACK_SEED_DOC.main.provider 漂移");
  });

  test("KNOWN_SEED_PROVIDERS == protocol 静态 provider 全集 ∪ {codex-native}(新增 provider 必须同步)", async () => {
    const { pb } = await loadSeed();
    const { STATIC_KEY_PROVIDERS } = await import("@openclaude/protocol");
    const expected = [...STATIC_KEY_PROVIDERS.map((p) => p.id), "codex-native"].sort();
    assert.deepEqual(
      [...(pb.KNOWN_SEED_PROVIDERS as string[])].sort(),
      expected,
      "platformBundle.KNOWN_SEED_PROVIDERS 是 protocol provider 集的镜像(entrypoint 侧不能 import protocol)——" +
        "protocol 新增/删除静态 provider 必须同步该镜像,否则新 provider 的 seed 声明会被误拒/漏校验",
    );
  });
});
