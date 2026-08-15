#!/usr/bin/env tsx
/**
 * select-gates.ts — 本地快车道 `check:v5:fast` 的「路径 → 门」映射。
 *
 * 这不是 CI 权威。CI 与 `npm run check:v5` 仍是全量 18 步,由
 * `scripts/check-ci-parity.ts` 双向核对。本文件只回答:「这一组改动在本地
 * 预检时该跑哪些门」,好把「改一行也要串行 15 分钟」压成「只跑被触及的门,
 * 且独立门并行」。
 *
 * 映射依据(写在每条 RULE 的 comment 里,改映射时一起改):
 *   1. 包内单测脚本与目录一一对应(`test:gateway` ↔ `packages/gateway`)。
 *   2. `packages/protocol` 是 gateway↔web-react↔容器的帧/错误码单一权威,
 *      改它等于改跨包契约 → 退化为近全量(这是快车道的显式逃生口)。
 *   3. commercial unit / integ 共用 `scripts/test-mutex.sh commercial` 锁;
 *      调度器必须把带这把锁的门串行,绝不能自己制造锁竞争。
 *   4. 纯文案 / 普通 markdown 不进质量门;`docs/V5_CI.md` 与教程资产除外。
 *   5. 最容易失败、最便宜的门(lint / ci-parity / 单包 typecheck)标 cheap,
 *      昂贵 integ 标 very-expensive,runner 按 cost 分波,避免 14 分钟后才炸。
 */

export type GateCost = "cheap" | "medium" | "expensive" | "very-expensive";
export type GateLock = "commercial" | null;

export type GateId =
  | "check:ci-parity"
  | "check:v5:incidents"
  | "check:v5:e2e-selectors"
  | "check:tutorials"
  | "lint:scheduler-wiring"
  | "lint:agent-containers-sql"
  | "lint:integ-tiers"
  | "typecheck"
  | "test:v5:ops"
  | "test:protocol"
  | "test:channels"
  | "test:gateway"
  | "test:mcp-memory"
  | "test:storage"
  | "test:web-react"
  | "test:browser"
  | "test:commercial:unit:gate"
  | "test:commercial:integ:shard";

export interface GateMeta {
  id: GateId;
  /** 根 package.json 脚本名;typecheck 在 scoped 时由 runner 改写成 tsc --build */
  npmScript: GateId;
  npmArgs?: string[];
  cost: GateCost;
  lock: GateLock;
}

/** check:v5 的 18 道门,顺序与 package.json 全量链一致,便于打印「跳过了哪些」。 */
export const ALL_GATES: GateMeta[] = [
  { id: "check:ci-parity", npmScript: "check:ci-parity", cost: "cheap", lock: null },
  { id: "check:v5:incidents", npmScript: "check:v5:incidents", cost: "cheap", lock: null },
  { id: "check:v5:e2e-selectors", npmScript: "check:v5:e2e-selectors", cost: "cheap", lock: null },
  { id: "check:tutorials", npmScript: "check:tutorials", cost: "cheap", lock: null },
  { id: "lint:scheduler-wiring", npmScript: "lint:scheduler-wiring", cost: "cheap", lock: null },
  { id: "lint:agent-containers-sql", npmScript: "lint:agent-containers-sql", cost: "cheap", lock: null },
  { id: "lint:integ-tiers", npmScript: "lint:integ-tiers", cost: "cheap", lock: null },
  { id: "typecheck", npmScript: "typecheck", cost: "medium", lock: null },
  { id: "test:v5:ops", npmScript: "test:v5:ops", cost: "medium", lock: null },
  { id: "test:protocol", npmScript: "test:protocol", cost: "medium", lock: null },
  { id: "test:channels", npmScript: "test:channels", cost: "medium", lock: null },
  { id: "test:gateway", npmScript: "test:gateway", cost: "medium", lock: null },
  { id: "test:mcp-memory", npmScript: "test:mcp-memory", cost: "medium", lock: null },
  { id: "test:storage", npmScript: "test:storage", cost: "medium", lock: null },
  { id: "test:web-react", npmScript: "test:web-react", cost: "medium", lock: null },
  { id: "test:browser", npmScript: "test:browser", cost: "expensive", lock: null },
  { id: "test:commercial:unit:gate", npmScript: "test:commercial:unit:gate", cost: "expensive", lock: "commercial" },
  {
    id: "test:commercial:integ:shard",
    npmScript: "test:commercial:integ:shard",
    npmArgs: ["pr"],
    cost: "very-expensive",
    lock: "commercial",
  },
];

export const ALL_GATE_IDS: GateId[] = ALL_GATES.map((g) => g.id);

/** tsc --build 工程图(根 tsconfig.json references)。web-react 不在图内,单独跑。 */
export const COMPOSITE_PROJECTS = [
  "packages/protocol",
  "packages/storage",
  "packages/plugin-sdk",
  "packages/mcp-memory",
  "packages/gateway",
  "packages/channels/wechat",
  "packages/commercial",
  "packages/cli",
] as const;

export type CompositeProject = (typeof COMPOSITE_PROJECTS)[number];

/**
 * 谁 typecheck 依赖于谁。改 A 时,除了 A 自己,还要建它的 dependents,
 * 否则「gateway 改了类型、commercial 没重编」会漏。
 * 依据:各包 tsconfig.json 的 references(2026-08 复核)。
 */
export const TYPECHECK_DEPENDENTS: Record<CompositeProject, CompositeProject[]> = {
  "packages/protocol": [
    "packages/plugin-sdk",
    "packages/gateway",
    "packages/channels/wechat",
    "packages/commercial",
    "packages/cli",
  ],
  "packages/storage": [
    "packages/mcp-memory",
    "packages/gateway",
    "packages/channels/wechat",
    "packages/commercial",
    "packages/cli",
  ],
  "packages/plugin-sdk": [
    "packages/gateway",
    "packages/channels/wechat",
    "packages/cli",
  ],
  "packages/mcp-memory": [],
  "packages/gateway": ["packages/commercial", "packages/cli"],
  "packages/channels/wechat": ["packages/commercial", "packages/cli"],
  "packages/commercial": ["packages/cli"],
  "packages/cli": [],
};

export interface GateRule {
  id: string;
  /** 人类可读:这条规则为什么存在 */
  comment: string;
  match: (file: string) => boolean;
  gates: GateId[];
  /** 额外纳入 typecheck 的 composite 工程(含自身)。函数形式按文件再裁一层。 */
  typecheckProjects?: CompositeProject[] | ((file: string) => CompositeProject[]);
  /** 是否要跑 web-react 的独立 tsc -b */
  typecheckWebReact?: boolean;
}

function isMdOrText(file: string): boolean {
  return /\.(md|txt|markdown)$/i.test(file);
}

/**
 * 显式映射表。多条规则命中取并集;没有任何规则命中 → 空集(docs-only 快车道)。
 * 新增目录时往这里加一行,不要在 runner 里写隐式 if。
 */
export const GATE_RULES: GateRule[] = [
  {
    id: "ci-parity-sources",
    comment:
      "parity 门的三个权威源:workflow / check:v5 链 / docs/V5_CI.md job 表。" +
      "改任一源必须立刻核对,否则本地全量门与 CI 会再漂成两套。",
    match: (f) =>
      f === "package.json" ||
      f === ".github/workflows/v5-ci.yml" ||
      f === "docs/V5_CI.md" ||
      f === "scripts/check-ci-parity.ts",
    gates: ["check:ci-parity"],
  },
  {
    id: "tsconfig-or-lockfile",
    comment:
      "根/包 tsconfig 或 lockfile 变动会改变模块解析,单包裁剪不可信 → 全量 typecheck。",
    match: (f) =>
      f === "package.json" ||
      f === "package-lock.json" ||
      f === "tsconfig.json" ||
      f === "tsconfig.base.json" ||
      /(^|\/)tsconfig(\.[\w-]+)?\.json$/.test(f),
    gates: ["typecheck"],
    typecheckProjects: [...COMPOSITE_PROJECTS],
    typecheckWebReact: true,
  },
  {
    id: "incident-surface",
    comment:
      "check-v5-incident-regressions.ts 只扫描 gateway/commercial/web-react/protocol/storage " +
      "上的 fix(v5) 提交;改这些包或门自身时才跑。",
    match: (f) =>
      f.startsWith("packages/gateway/") ||
      f.startsWith("packages/commercial/") ||
      f.startsWith("packages/web-react/") ||
      f.startsWith("packages/protocol/") ||
      f.startsWith("packages/storage/") ||
      f === "scripts/check-v5-incident-regressions.ts" ||
      /(^|\/)incidents\.json$/.test(f),
    gates: ["check:v5:incidents"],
  },
  {
    id: "e2e-selectors",
    comment:
      "e2e 用到的 testid/aria-label 必须在 web-react 非测试源码里真实存在。" +
      "改 e2e、选择器门、或 web-react 源码时跑。",
    match: (f) =>
      f.startsWith("e2e/") ||
      f === "scripts/check-v5-e2e-selectors.ts" ||
      (f.startsWith("packages/web-react/src/") && /\.(ts|tsx)$/.test(f)),
    gates: ["check:v5:e2e-selectors"],
  },
  {
    id: "tutorials",
    comment: "教程 JSONL 只追加 + 媒体路径契约。只在教程资产或门脚本变动时跑。",
    match: (f) =>
      f === "scripts/check-v5-tutorials.ts" ||
      f === "packages/web-react/TUTORIALS.md" ||
      f.includes("tutorial-sync-history.jsonl") ||
      f.includes("/tutorials/") ||
      /tutorial/i.test(f) && (f.startsWith("packages/web-react/") || f.startsWith("scripts/")),
    gates: ["check:tutorials"],
  },
  {
    id: "scheduler-wiring",
    comment:
      "扫描导出的生命周期类/工厂是否被 start(HealthPoller 事故)。" +
      "门脚本或任一 packages/*.ts 变动都可能引入未 start 的调度器。",
    match: (f) =>
      f === "scripts/check-schedulers.ts" ||
      (f.startsWith("packages/") && f.endsWith(".ts") && !f.endsWith(".d.ts") && !isMdOrText(f)),
    gates: ["lint:scheduler-wiring"],
  },
  {
    id: "agent-containers-sql",
    comment:
      "commercial 里读 agent_containers 必须显式过滤 state。只扫 commercial/src。",
    match: (f) =>
      f.startsWith("packages/commercial/src/") ||
      f === "packages/commercial/scripts/lint-agent-containers-sql.ts",
    gates: ["lint:agent-containers-sql"],
  },
  {
    id: "integ-tiers",
    comment:
      "每个 *.integ.test.ts 必须登记进 .github/integ-tiers。清单或 integ 文件变动时跑。",
    match: (f) =>
      f.startsWith(".github/integ-tiers/") ||
      f === "scripts/check-integ-tiers.ts" ||
      f.endsWith(".integ.test.ts") ||
      f === ".github/scripts/commercial-integ-gate.sh",
    gates: ["lint:integ-tiers"],
  },
  {
    id: "v5-ops",
    comment: "发布/回滚/ops 脚本的安全契约。scripts/ 下 ops 与其单测变动时跑。",
    match: (f) =>
      f.startsWith("scripts/__tests__/") ||
      f.startsWith("scripts/v5-") ||
      f.startsWith("scripts/lib/") ||
      f === "scripts/deploy-v5.sh" ||
      f === ".github/scripts/diff-known-failures.sh" ||
      f.startsWith(".github/known-failures/"),
    gates: ["test:v5:ops"],
  },
  {
    id: "protocol-near-full",
    comment:
      "protocol 是跨包契约单一权威。改它必须近全量:所有包单测 + 前端 + 浏览器门 +" +
      "commercial unit/integ + 全量 typecheck。这是快车道的显式降级,不是漏裁。",
    match: (f) => f.startsWith("packages/protocol/"),
    gates: [
      "typecheck",
      "test:protocol",
      "test:channels",
      "test:gateway",
      "test:mcp-memory",
      "test:storage",
      "test:web-react",
      "test:browser",
      "test:commercial:unit:gate",
      "test:commercial:integ:shard",
      "lint:scheduler-wiring",
    ],
    typecheckProjects: [...COMPOSITE_PROJECTS],
    typecheckWebReact: true,
  },
  {
    id: "gateway",
    comment:
      "网关单测 + 自身及 dependents(commercial/cli)的 typecheck。" +
      "不拉 commercial 运行时套件:类型破裂由 scoped typecheck 抓住,运行时回归交给 CI 全量门。",
    match: (f) => f.startsWith("packages/gateway/"),
    gates: ["test:gateway", "typecheck", "lint:scheduler-wiring"],
    typecheckProjects: ["packages/gateway", "packages/commercial", "packages/cli"],
  },
  {
    id: "storage",
    comment: "storage 被 mcp-memory/gateway/wechat/commercial/cli 引用。",
    match: (f) => f.startsWith("packages/storage/"),
    gates: ["test:storage", "test:mcp-memory", "typecheck", "lint:scheduler-wiring"],
    typecheckProjects: [
      "packages/storage",
      "packages/mcp-memory",
      "packages/gateway",
      "packages/channels/wechat",
      "packages/commercial",
      "packages/cli",
    ],
  },
  {
    id: "mcp-memory",
    comment: "记忆子系统,composite 图上无 dependents。",
    match: (f) => f.startsWith("packages/mcp-memory/"),
    gates: ["test:mcp-memory", "typecheck"],
    typecheckProjects: ["packages/mcp-memory"],
  },
  {
    id: "channels",
    comment:
      "test:channels 扫整个 packages/channels。wechat 在 composite 图内,要带 dependents typecheck。",
    match: (f) => f.startsWith("packages/channels/"),
    gates: ["test:channels"],
    typecheckProjects: (f) =>
      f.startsWith("packages/channels/wechat/")
        ? ["packages/channels/wechat", "packages/commercial", "packages/cli"]
        : [],
  },
  {
    id: "web-react",
    comment: "jsdom 单测 + 真浏览器门 + 选择器/教程(源码变动时已由其它规则覆盖)。",
    match: (f) => f.startsWith("packages/web-react/"),
    gates: ["test:web-react", "test:browser", "typecheck"],
    typecheckWebReact: true,
  },
  {
    id: "web-react-browser-tests",
    comment: "browser-tests/ 是 test:browser 的本体,改它必须跑真 Chromium 门。",
    match: (f) => f.startsWith("packages/web-react/browser-tests/"),
    gates: ["test:browser"],
  },
  {
    id: "commercial-unit",
    comment:
      "商业 unit 基线 diff 门。改 commercial 源码/门脚本/known-failures 时跑。" +
      "与 integ 共用 commercial 锁,runner 必须串行这两门。",
    match: (f) =>
      f.startsWith("packages/commercial/") ||
      f === ".github/scripts/commercial-unit-gate.sh" ||
      f.startsWith(".github/known-failures/"),
    gates: ["test:commercial:unit:gate", "typecheck", "lint:agent-containers-sql"],
    typecheckProjects: ["packages/commercial", "packages/cli"],
  },
  {
    id: "commercial-integ",
    comment:
      "真 PG 语义。只在 integ 文件、integ 门脚本、梯队清单或 commercial db/http 核心变动时拉起," +
      "避免「改一行 commercial 注释也排队等 integ」。",
    match: (f) =>
      f.endsWith(".integ.test.ts") ||
      f.startsWith(".github/integ-tiers/") ||
      f === ".github/scripts/commercial-integ-gate.sh" ||
      f.startsWith("packages/commercial/src/db/") ||
      f.startsWith("packages/commercial/src/http/"),
    gates: ["test:commercial:integ:shard", "lint:integ-tiers"],
  },
  {
    id: "plugin-sdk",
    comment: "被 gateway/wechat/cli 引用,自身无独立 check:v5 单测脚本。",
    match: (f) => f.startsWith("packages/plugin-sdk/"),
    gates: ["test:gateway", "typecheck"],
    typecheckProjects: [
      "packages/plugin-sdk",
      "packages/gateway",
      "packages/channels/wechat",
      "packages/cli",
    ],
  },
  {
    id: "cli",
    comment: "composite 叶子。只建自己。",
    match: (f) => f.startsWith("packages/cli/"),
    gates: ["typecheck"],
    typecheckProjects: ["packages/cli"],
  },
  {
    id: "fastpath-self",
    comment:
      "快车道自身:映射/调度改动必须跑自己的单测(挂在 test:v5:ops 文件清单里)和 parity," +
      "防止有人把 check:v5:fast 误加进 check:v5 链。",
    match: (f) =>
      f === "scripts/select-gates.ts" ||
      f === "scripts/run-v5-fast.ts" ||
      f === "scripts/__tests__/selectGates.test.ts" ||
      f === "scripts/__tests__/huggingfaceTransformersStub.test.ts",
    gates: ["test:v5:ops", "check:ci-parity"],
  },
];

export interface GateTrigger {
  file: string;
  ruleId: string;
  comment: string;
}

export interface TypecheckPlan {
  /** 空 = 不跑 typecheck */
  projects: CompositeProject[];
  webReact: boolean;
  /** 覆盖了全部 composite 工程时,runner 应直接 `npm run typecheck` */
  fullComposite: boolean;
}

export interface GateSelection {
  files: string[];
  selected: GateId[];
  skipped: GateId[];
  triggers: Record<GateId, GateTrigger[]>;
  typecheck: TypecheckPlan;
}

function normalizeFile(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function projectsForRule(rule: GateRule, file: string): CompositeProject[] {
  const raw = rule.typecheckProjects;
  if (!raw) return [];
  if (typeof raw === "function") {
    return (raw as (f: string) => CompositeProject[])(file);
  }
  return raw;
}

export function selectGates(files: string[]): GateSelection {
  const normalized = [...new Set(files.map(normalizeFile).filter(Boolean))].sort();
  const selected = new Set<GateId>();
  const triggers = {} as Record<GateId, GateTrigger[]>;
  const projects = new Set<CompositeProject>();
  let webReact = false;

  for (const file of normalized) {
    for (const rule of GATE_RULES) {
      if (!rule.match(file)) continue;
      for (const gate of rule.gates) {
        selected.add(gate);
        triggers[gate] ??= [];
        triggers[gate].push({ file, ruleId: rule.id, comment: rule.comment });
      }
      for (const p of projectsForRule(rule, file)) projects.add(p);
      if (rule.typecheckWebReact) webReact = true;
    }
  }

  // typecheck 工程非空时,保证 typecheck 门在 selected 里
  if (projects.size > 0 || webReact) {
    selected.add("typecheck");
    if (!triggers.typecheck?.length) {
      triggers.typecheck = [
        {
          file: normalized[0] ?? "(derived)",
          ruleId: "typecheck-dependents",
          comment: "由其它规则的 typecheckProjects / typecheckWebReact 推导",
        },
      ];
    }
  }

  const selectedList = ALL_GATE_IDS.filter((id) => selected.has(id));
  const skipped = ALL_GATE_IDS.filter((id) => !selected.has(id));
  const projectList = COMPOSITE_PROJECTS.filter((p) => projects.has(p));

  return {
    files: normalized,
    selected: selectedList,
    skipped,
    triggers,
    typecheck: {
      projects: projectList,
      webReact,
      fullComposite: projectList.length === COMPOSITE_PROJECTS.length,
    },
  };
}

export function gateMeta(id: GateId): GateMeta {
  const meta = ALL_GATES.find((g) => g.id === id);
  if (!meta) throw new Error(`unknown gate: ${id}`);
  return meta;
}

/** 按 cost 分波:cheap → medium → expensive → very-expensive。同波内无锁并行、有锁串行。 */
export const COST_PHASES: GateCost[] = ["cheap", "medium", "expensive", "very-expensive"];

export function groupByPhase(ids: GateId[]): { cost: GateCost; gates: GateMeta[] }[] {
  return COST_PHASES.map((cost) => ({
    cost,
    gates: ids.map(gateMeta).filter((g) => g.cost === cost),
  })).filter((p) => p.gates.length > 0);
}
