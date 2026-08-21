#!/usr/bin/env tsx
// V5 P0/P1 事故回归锁。判据:manifest 里登记的每条证据,必须是**真的会跑、真的断言
// 了那件事**的产物 —— 而不是一个存在的文件名。
//
// 2026-07-26 审计实锤(本文件此前只做 existsSync,于是):
//   · 3 条事故(Weibo 图片/Weibo OOM/Kimi 配额)的唯一 proof 证据都填
//     scripts/v5-e2e-journey-canary.mjs,而该脚本只有 J1-J5 登录/附件/目标/发送/送达,
//     零 Weibo 零 quota;
//   · 催生整套真浏览器门的 INC-20260718-ATTACH-NOOP,其 layer:'browser' 证据填的却是
//     jsdom 的 composerAttach.test.tsx;
//   · browser 层粒度是整个 run.mjs —— 删掉 T11/T15 整段,本门照样 PASS。
// 因此新增四道校验:assertion 精确锚点、layer↔路径形态、layer→runner 可达、
// 事故↔修复 commit 血缘,外加 fix(v5) commit 的 Incident trailer 闭环门。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const MANIFEST = join(ROOT, "e2e/session-display/incidents.json");
const WAIVERS = join(ROOT, "e2e/session-display/incident-waivers.json");
const FIXED_MATRIX = [
  { engine: "codex", model: "gpt-5.6-luna" },
  { engine: "ccb", model: "deepseek-v4-flash" },
];
const PROOF_LAYERS = new Set(["browser", "live-e2e", "deploy-gate"]);
const ALL_LAYERS = new Set(["unit", "integration", ...PROOF_LAYERS]);

// ── 棘轮基线 ────────────────────────────────────────────────────────────────
// 存量债务的上界,只许降不许升。新登记的条目必须直接合规,否则这两个数会被顶破。
/** 允许没有 assertion 锚点的 unit/integration 条目数(proof 层一律必须有)。 */
const ASSERTION_DEBT_BASELINE = 37;
/**
 * 允许"暂无 proof 层证据"的事故数(必须显式写 proofPending 说明)。
 * 11 = 4 条存量(3 条 Weibo/Kimi 原本用无关脚本充数 + 1 条把 CI unit 误标 deploy-gate)
 *   + 5 条 2026-07-25 紧急通道事故(补登记时如实标注:回归只到 unit 层)
 *   + 2 条 SCNet 关机后从 V5 主发布门移除的 OCR 活体 proof。
 * 这个数是**债务上界**,不是目标:补上真 proof 证据后必须同步调低。
 */
const PROOF_PENDING_BASELINE = 11;

// ── Incident trailer 闭环门的生效锚点(运行时自算,不写死 SHA)─────────────
// 起点 = marker 文件被 git 添加的那个 commit。为什么不写死 SHA —— 连踩两次:
//   ① 怕 rebase:门首次落地时起点钉的是分支 rebase 前的 commit,分支合入前被
//      rebase 4 次 → SHA 消失 → 走"起点不可达"分支静默跳过,从落地起一次没跑过;
//   ② 怕并行合入:校准到"我写代码时的 HEAD"之后,其他会话在我 PR 排队期间合入的
//      commit 就落在起点之后,而他们无从知晓这个新要求 —— 门拦住无辜的人,且每次
//      排队都重演(2026-07-26 实测拦到了别人的 0191 模型接入 commit)。
// 运行时自算同时解决两条,详见 marker 文件自身的注释。
const TRAILER_GATE_MARKER = "e2e/session-display/incident-trailer-enforced-from";
function resolveTrailerGateStart(): string | null {
  let out: string;
  try {
    out = git("log", "--diff-filter=A", "--format=%H", "--", TRAILER_GATE_MARKER);
  } catch {
    return null;
  }
  // 同一路径可能被删后重加:取最早那次添加。
  const commits = out.split("\n").map((line) => line.trim()).filter(Boolean);
  return commits.length > 0 ? commits[commits.length - 1] : null;
}

const TRAILER_GATE_SURFACES = [
  "packages/gateway/",
  "packages/commercial/",
  "packages/web-react/",
  "packages/protocol/",
  "packages/storage/",
];

type Regression = { layer: string; path: string; assertion?: string };
type Incident = {
  id: string;
  occurredAt: string;
  severity: string;
  symptom: string;
  rootFixCommit: string;
  /** 同一事故的后续提交(典型:containment commit 先上线,回归用例在同 PR 的 test commit 里)。 */
  coverageCommits?: string[];
  /** 暂无 browser/live-e2e/deploy-gate 证据时必须显式说明,并计入 PROOF_PENDING_BASELINE。 */
  proofPending?: { reason: string; since: string };
  regressions: Regression[];
};
type Manifest = {
  schema: number;
  scope: string;
  fixedLiveMatrix: Array<{ engine: string; model: string }>;
  incidents: Incident[];
};
type Waiver = {
  commit: string;
  reason: string;
  approvedBy: string;
  expiresAt: string;
  /** Exact P0 containment commits are immutable once production provenance is recorded. */
  emergencyMissingTrailer?: boolean;
};

function fail(message: string): never {
  throw new Error(`[incident-regressions] ${message}`);
}
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}
function commitFiles(sha: string): string[] {
  return git("show", "--format=", "--name-only", sha).split("\n").map((line) => line.trim()).filter(Boolean);
}

// ── layer → 路径形态 ────────────────────────────────────────────────────────
// layer 描述的是"这条证据在哪一层跑",不是"它讲的是哪个话题"。路径形态对不上就是
// 层级标错(ATTACH-NOOP 把 jsdom 组件测试标成 browser 就是这么混过去的)。
const LAYER_PATH_SHAPE: Record<string, { ok: (path: string) => boolean; expect: string }> = {
  unit: {
    ok: (p) => /\.test\.(ts|tsx)$/.test(p) && !/\.integ\.test\.ts$/.test(p)
      && !p.startsWith("packages/web-react/browser-tests/") && !p.startsWith("e2e/"),
    expect: "非 .integ 的 *.test.ts(x),且不在 browser-tests/ 或 e2e/ 下",
  },
  integration: {
    ok: (p) => /\.integ\.test\.ts$/.test(p),
    expect: "*.integ.test.ts",
  },
  browser: {
    ok: (p) => p.startsWith("packages/web-react/browser-tests/"),
    expect: "packages/web-react/browser-tests/ 下的真浏览器门产物",
  },
  "live-e2e": {
    ok: (p) => p.startsWith("e2e/session-display/tests/") && p.endsWith(".spec.ts"),
    expect: "e2e/session-display/tests/*.spec.ts",
  },
  "deploy-gate": {
    ok: (p) => p.startsWith("scripts/") && !p.startsWith("scripts/__tests__/") && /\.(mjs|sh|ts)$/.test(p),
    expect: "部署门真正调用的 scripts/ 脚本(scripts/__tests__ 下的属 unit 层)",
  },
};

// ── layer → runner 可达性 ───────────────────────────────────────────────────
// 声明了 layer 就必须能映射到一个真会执行它的 runner。映射不上直接红:否则"有证据"
// 只是文件躺在仓里,没有任何流水线会因为它变红。
type RunnerVerdict = { status: "wired" | "pending"; runner: string };
const CI_WORKFLOW = readFileSync(join(ROOT, ".github/workflows/v5-ci.yml"), "utf8");
const DEPLOY_SCRIPT = readFileSync(join(ROOT, "scripts/deploy-v5.sh"), "utf8");
const ROOT_PACKAGE_JSON = readFileSync(join(ROOT, "package.json"), "utf8");

function requireCi(script: string, runner: string): RunnerVerdict {
  if (!CI_WORKFLOW.includes(script)) fail(`CI workflow 未调用 ${script},runner 映射已失效`);
  return { status: "wired", runner };
}
function resolveRunner(layer: string, path: string): RunnerVerdict {
  if (layer === "browser") {
    return requireCi("test:browser", "CI job web-react → npm run --workspace @openclaude/web-react test:browser");
  }
  if (layer === "live-e2e") {
    if (!DEPLOY_SCRIPT.includes("e2e/session-display/run.sh")) fail("deploy-v5.sh 不再调用 live e2e run.sh");
    return { status: "wired", runner: "deploy-v5.sh candidate verification → e2e/session-display/run.sh" };
  }
  if (layer === "deploy-gate") {
    const base = path.split("/").pop() ?? "";
    if (!DEPLOY_SCRIPT.includes(base)) fail(`deploy-v5.sh 未调用 ${path},不能标 deploy-gate`);
    return { status: "wired", runner: `deploy-v5.sh → ${base}` };
  }
  if (layer === "integration") {
    // 2026-07-26:integ 已分梯队接进 CI(PR 门 pr-1/2/3 + 夜跑 nightly-*),所以这里
    // 不再一律 pending,而是按**该文件真实属于哪个梯队**判定 —— 登记了一条没有任何
    // 梯队收录的 integ 证据,等于它永远不会跑,必须红。
    const tierDir = join(ROOT, ".github/integ-tiers");
    const tiers = existsSync(tierDir) ? readdirSync(tierDir).filter((f) => f.endsWith(".txt")) : [];
    if (tiers.length === 0) fail("integ 梯队清单目录缺失(.github/integ-tiers),integration 层 runner 不可判");
    const owning = tiers.filter((f) =>
      readFileSync(join(tierDir, f), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .some((entry) => entry === path || entry.endsWith(`/${path.split("/").pop()}`)),
    );
    if (owning.length === 0) {
      fail(`${path} 未被任何 integ 梯队收录(.github/integ-tiers/*.txt),这条证据永远不会跑`);
    }
    const shard = owning[0].replace(/\.txt$/, "");
    if (shard.startsWith("pr-")) {
      if (!CI_WORKFLOW.includes("test:commercial:integ:shard")) {
        fail("CI workflow 未调用 test:commercial:integ:shard,integ PR 门映射已失效");
      }
      return { status: "wired", runner: `CI job commercial-integ (${shard})` };
    }
    // 夜跑梯队:确实会跑,但发现延迟到次日,不能当作 PR 门级证据。
    return { status: "pending", runner: `夜跑 ${shard}(v5-integ-nightly.yml,非 PR 门)` };
  }
  // unit:按包落到具体 CI job,落不到就是新增了没人跑的测试目录。
  if (/^packages\/gateway\/src\/__tests__\/[^/]+\.test\.ts$/.test(path)) {
    return requireCi("test:gateway", "CI job gateway → npm run test:gateway");
  }
  if (/^packages\/storage\/src\/__tests__\/[^/]+\.test\.ts$/.test(path)) {
    return requireCi("test:storage", "CI job storage → npm run test:storage");
  }
  if (/^packages\/web-react\/src\/.+\.test\.(ts|tsx)$/.test(path)) {
    return requireCi("test:web-react", "CI job web-react → npm run test:web-react");
  }
  if (/^packages\/commercial\/src\/.+\.test\.ts$/.test(path)) {
    return requireCi("test:commercial:unit:gate", "CI job commercial-unit → npm run test:commercial:unit:gate");
  }
  if (/^scripts\/__tests__\/[^/]+\.test\.ts$/.test(path)) {
    if (!CI_WORKFLOW.includes("test:v5:ops")) fail("CI workflow 未调用 test:v5:ops");
    if (!ROOT_PACKAGE_JSON.includes(path)) fail(`${path} 未列进 npm run test:v5:ops 的文件清单`);
    return { status: "wired", runner: "CI job v5-ops → npm run test:v5:ops" };
  }
  // packages/protocol/src/__tests__ 当前没有任何 npm script 收它(2026-07-26 核实),
  // 谁把它当证据登记,谁必须先补 runner。
  fail(`${path} 映射不到任何 runner(layer=${layer});先把它接进 CI 再登记为证据`);
}

// ── manifest ────────────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
if (manifest.schema !== 2) fail(`schema must be 2, got ${manifest.schema}`);
if (JSON.stringify(manifest.fixedLiveMatrix) !== JSON.stringify(FIXED_MATRIX)) {
  fail("fixedLiveMatrix must be exactly Codex/gpt-5.6-luna + CCB/deepseek-v4-flash");
}
if (!Array.isArray(manifest.incidents) || manifest.incidents.length === 0) fail("incidents must not be empty");

const fileCache = new Map<string, string>();
function readArtifact(path: string): string {
  let text = fileCache.get(path);
  if (text === undefined) {
    text = readFileSync(join(ROOT, path), "utf8");
    fileCache.set(path, text);
  }
  return text;
}

const ids = new Set<string>();
const linked = new Set<string>();
const pendingRunners: string[] = [];
let assertionDebt = 0;
let proofPending = 0;

for (const incident of manifest.incidents) {
  if (!/^INC-[0-9]{8}-[A-Z0-9-]{3,40}$/.test(incident.id)) fail(`invalid id ${incident.id}`);
  if (ids.has(incident.id)) fail(`duplicate id ${incident.id}`);
  ids.add(incident.id);
  if (!/^2026-[0-9]{2}-[0-9]{2}$/.test(incident.occurredAt)) fail(`${incident.id}: invalid occurredAt`);
  if (incident.severity !== "P0" && incident.severity !== "P1") fail(`${incident.id}: severity must be P0/P1`);
  if (!incident.symptom?.trim()) fail(`${incident.id}: symptom is required`);

  const lineageCommits = [incident.rootFixCommit, ...(incident.coverageCommits ?? [])];
  for (const sha of lineageCommits) {
    if (!/^[0-9a-f]{8}$/.test(sha)) fail(`${incident.id}: lineage commit ${sha} must be 8 hex`);
    try {
      git("cat-file", "-e", `${sha}^{commit}`);
      execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: ROOT });
    } catch {
      fail(`${incident.id}: lineage commit ${sha} is not an ancestor of HEAD`);
    }
  }
  const lineageFiles = new Set(lineageCommits.flatMap((sha) => commitFiles(sha)));

  if (!Array.isArray(incident.regressions) || incident.regressions.length === 0) {
    fail(`${incident.id}: no automated regression`);
  }

  const seen = new Set<string>();
  for (const regression of incident.regressions) {
    const { layer, path } = regression;
    if (!ALL_LAYERS.has(layer)) fail(`${incident.id}: invalid layer ${layer}`);
    if (path.startsWith("/") || path.includes("..")) fail(`${incident.id}: unsafe path`);
    if (!existsSync(join(ROOT, path))) fail(`${incident.id}: missing ${path}`);
    const key = `${layer}:${path}:${regression.assertion ?? ""}`;
    if (seen.has(key)) fail(`${incident.id}: duplicate regression ${key}`);
    seen.add(key);

    const shape = LAYER_PATH_SHAPE[layer];
    if (!shape.ok(path)) fail(`${incident.id}: layer=${layer} 的 ${path} 形态不对,应为 ${shape.expect}`);

    const verdict = resolveRunner(layer, path);
    if (verdict.status === "pending") {
      if (PROOF_LAYERS.has(layer)) fail(`${incident.id}: proof 层 ${layer} 不允许 pending runner`);
      pendingRunners.push(`${incident.id} ${layer} ${path} → ${verdict.runner}`);
    }

    // assertion = 该产物内部的精确锚点(顶层用例名 / 浏览器 T 编号标题)。
    // 只有它能挡住"挂靠一个存在但与事故无关的文件"。
    if (regression.assertion !== undefined) {
      if (!regression.assertion.trim()) fail(`${incident.id}: ${path} 的 assertion 不得为空串`);
      if (!readArtifact(path).includes(regression.assertion)) {
        fail(`${incident.id}: ${path} 内找不到 assertion 锚点「${regression.assertion}」`
          + "(用例被删/改名,或这份证据根本不讲这件事)");
      }
    } else if (PROOF_LAYERS.has(layer)) {
      fail(`${incident.id}: proof 层证据 ${path} 必须写 assertion 锚点`);
    } else {
      assertionDebt += 1;
    }

    linked.add(path);
  }

  // 血缘:这条事故的修复/补测 commit 至少动过它登记的一份证据。全都没动过 = 挂靠。
  // (逐条要求血缘不成立:live-e2e/browser 这类事后补的活体证据本就晚于 containment
  //  commit,逐条要求会逼人删掉真证据。锚点 + assertion 两条合起来才是有效约束。)
  const anchored = incident.regressions.some((item) => lineageFiles.has(item.path));
  if (!anchored) {
    fail(`${incident.id}: rootFixCommit/coverageCommits 没有动过任何一条登记的证据(疑似挂靠无关文件)`);
  }

  const hasProof = incident.regressions.some((item) => PROOF_LAYERS.has(item.layer));
  if (!hasProof) {
    if (!incident.proofPending?.reason?.trim() || !/^2026-[0-9]{2}-[0-9]{2}$/.test(incident.proofPending.since ?? "")) {
      fail(`${incident.id}: 没有 browser/live-e2e/deploy-gate 证据时必须写 proofPending{reason,since}`);
    }
    proofPending += 1;
  } else if (incident.proofPending) {
    fail(`${incident.id}: 已有 proof 层证据,不该再挂 proofPending`);
  }
}

if (assertionDebt > ASSERTION_DEBT_BASELINE) {
  fail(`无 assertion 锚点的 unit/integration 证据 ${assertionDebt} 条 > 基线 ${ASSERTION_DEBT_BASELINE};`
    + "新增证据必须带 assertion(基线只许降不许升)");
}
if (proofPending > PROOF_PENDING_BASELINE) {
  fail(`proofPending 事故 ${proofPending} 条 > 基线 ${PROOF_PENDING_BASELINE};新事故必须带真 proof 证据`);
}

const specsDir = join(ROOT, "e2e/session-display/tests");
for (const name of readdirSync(specsDir).filter((name) => name.endsWith(".spec.ts"))) {
  const path = relative(ROOT, join(specsDir, name)).replaceAll("\\", "/");
  if (!linked.has(path)) fail(`live spec is not linked to an incident: ${path}`);
}

const runner = readFileSync(join(ROOT, "e2e/session-display/run.sh"), "utf8");
if (!/MATRIX=\(gpt-5\.6-luna deepseek-v4-flash\)/.test(runner)) fail("run.sh fixed matrix drifted");
if (!runner.includes("OC_E2E_REQUIRE_DIRECT_TIMELINE=1")) fail("run.sh must fail closed on direct-timeline skips");
if (!runner.includes('OC_E2E_EMAIL="v5-evals@claudeai.chat"')) fail("run.sh must use v5-evals");
if (!runner.includes("export CI=1")) fail("run.sh must forbid focused test subsets");

// ── Incident trailer 闭环门 ─────────────────────────────────────────────────
// manifest 停更(最后更新停在 2026-07-23,此后 29 个 PR 自述的 5 个事故一条没登记)
// 的根因是"补登记全靠自觉"。这里把它变成机制:生效起点之后,凡是触碰用户可见面的
// fix(v5) commit,都必须在 trailer 里指认事故 id,或走带审批与到期日的 waiver。
function parseWaivers(): Map<string, Waiver> {
  const out = new Map<string, Waiver>();
  if (!existsSync(WAIVERS)) return out;
  const raw = JSON.parse(readFileSync(WAIVERS, "utf8")) as { schema: number; waivers: Waiver[] };
  if (raw.schema !== 1) fail(`incident-waivers.json schema must be 1, got ${raw.schema}`);
  for (const waiver of raw.waivers ?? []) {
    if (!/^[0-9a-f]{8,40}$/.test(waiver.commit ?? "")) fail(`waiver commit 非法:${waiver.commit}`);
    if (!waiver.reason?.trim()) fail(`waiver ${waiver.commit} 缺 reason`);
    if (!waiver.approvedBy?.trim()) fail(`waiver ${waiver.commit} 缺 approvedBy(审批引用)`);
    if (!/^2026-[0-9]{2}-[0-9]{2}$/.test(waiver.expiresAt ?? "")) fail(`waiver ${waiver.commit} 缺合法 expiresAt`);
    out.set(waiver.commit.slice(0, 8), waiver);
  }
  return out;
}

// Exact historical import fence. The selfhost branch used a different release
// discipline and already shipped these immutable commits before commercial
// synchronization, so retroactively requiring trailers would force a history
// rewrite and destroy the live source SHA. Only ancestors of this frozen tip are
// exempt; every later/future commit remains under the normal trailer gate.
const IMPORTED_TRAILER_HISTORY_TIPS = [
  "7ad3910346d03f072db5b4debd9e29b43f13de30",
] as const;

function checkTrailerClosure(): number {
  const start = resolveTrailerGateStart();
  if (start === null) {
    // marker 尚未提交 = 门本身还没合入 → 还没到生效的时候,不冒充检查过。
    process.stdout.write(
      "[incident-regressions] trailer 闭环门尚未生效(marker 未提交),本次跳过\n",
    );
    return 0;
  }
  try {
    git("cat-file", "-e", `${start}^{commit}`);
    execFileSync("git", ["merge-base", "--is-ancestor", start, "HEAD"], { cwd: ROOT });
  } catch {
    // 起点不可达有两种原因,必须区别对待 —— 此前一律 WARN 跳过,等于把
    // "门失效" 伪装成 "门通过"(2026-07-26 实测:分支 rebase 后原 SHA 消失,
    // 整道门安静地什么都没查)。
    //   · 真·浅克隆:历史确实取不到,跳过是唯一选择(但要说清楚)。
    //   · 完整克隆却找不到起点:起点写错了或被 rebase 冲掉 → 这是门坏了,必须红。
    const shallow = (() => {
      try {
        return git("rev-parse", "--is-shallow-repository").trim() === "true";
      } catch {
        return false;
      }
    })();
    if (shallow) {
      process.stdout.write(
        "[incident-regressions] WARN: 浅克隆,trailer 闭环门起点不可达,本次跳过该门\n",
      );
      return 0;
    }
    fail(
      `trailer 闭环门锚点 ${start.slice(0, 12)}(${TRAILER_GATE_MARKER} 的引入 commit)在完整克隆里不可达 —— ` +
        "这道门当前什么都没在检查。marker 文件被删/被重写历史都会导致这个状态。",
    );
    return 0;
  }
  const waivers = parseWaivers();
  const today = new Date().toISOString().slice(0, 10);
  for (const tip of IMPORTED_TRAILER_HISTORY_TIPS) {
    try {
      git("cat-file", "-e", `${tip}^{commit}`);
      execFileSync("git", ["merge-base", "--is-ancestor", tip, "HEAD"], { cwd: ROOT });
    } catch {
      fail(`冻结的 trailer import tip ${tip.slice(0, 12)} 不可达 HEAD，拒绝静默失效`);
    }
  }
  const isFrozenImportedCommit = (sha: string): boolean =>
    IMPORTED_TRAILER_HISTORY_TIPS.some((tip) => {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", sha, tip], { cwd: ROOT });
        return true;
      } catch {
        return false;
      }
    });
  // 拓扑范围不够:CI 检出的是 PR 的 **merge ref**(base + head 的合并态),于是 base 侧
  // 在本 PR 排队期间新合入的 commit 与 head 侧的锚点 commit 是并行两支 —— 它们不是锚点
  // 的祖先,`start..HEAD` 会把它们一并捞进来,门于是拦住别人的提交(2026-07-26 实测拦到
  // 另一会话的 0191 commit)。再叠加时间维度:早于锚点的提交一律不判,因为那些作者在
  // 提交时这道门还不存在。
  const anchorTs = Number(git("log", "-1", "--format=%ct", start));
  const log = git("log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1f%ct%x1e", `${start}..HEAD`);
  let checked = 0;
  for (const entry of log.split("\x1e").map((line) => line.trim()).filter(Boolean)) {
    const [sha, subject, body = "", committedAt = ""] = entry.split("\x1f");
    // 并行合入的旧提交:锚点之后(拓扑)但早于锚点(时间)→ 门当时还不存在,不判。
    if (Number.isFinite(anchorTs) && Number(committedAt) < anchorTs) continue;
    if (isFrozenImportedCommit(sha)) continue;
    if (!/^fix\(v5\)/.test(subject)) continue;
    const touched = commitFiles(sha);
    if (!touched.some((file) => TRAILER_GATE_SURFACES.some((prefix) => file.startsWith(prefix)))) continue;
    checked += 1;
    const trailer = /^Incident:[ \t]*(.+)$/m.exec(body)?.[1]?.trim();
    if (!trailer) {
      const waiver = waivers.get(sha.slice(0, 8));
      const incident = manifest.incidents.find((item) =>
        [item.rootFixCommit, ...(item.coverageCommits ?? [])]
          .some((candidate) => sha.startsWith(candidate))
      );
      const exactImmutableEmergency =
        sha === "aa583b702d5e454801e90ff3c6b25df38e808a98"
        && waiver?.emergencyMissingTrailer === true
        && incident?.id === "INC-20260804-RETRY-ERROR-REDCARD"
        && incident.rootFixCommit === "aa583b70";
      if (!exactImmutableEmergency) {
        fail(`${sha.slice(0, 8)} "${subject}" 触碰用户可见面但缺 trailer:`
          + "Incident: INC-YYYYMMDD-SLUG,或仅对已登记 exact P0 containment 使用带审批的 emergencyMissingTrailer waiver");
      }
      if (waiver.expiresAt < today) fail(`${sha.slice(0, 8)} 的 emergency trailer waiver 已于 ${waiver.expiresAt} 过期`);
      continue;
    }
    if (/^none\b/.test(trailer)) {
      const waiver = waivers.get(sha.slice(0, 8));
      if (!waiver) fail(`${sha.slice(0, 8)} 声明 Incident: none,但 incident-waivers.json 里没有对应 waiver`);
      if (waiver.expiresAt < today) fail(`${sha.slice(0, 8)} 的 waiver 已于 ${waiver.expiresAt} 过期`);
      continue;
    }
    if (!/^INC-[0-9]{8}-[A-Z0-9-]{3,40}$/.test(trailer)) {
      fail(`${sha.slice(0, 8)} 的 Incident trailer 格式非法:${trailer}`);
    }
    const incident = manifest.incidents.find((item) => item.id === trailer);
    if (!incident) fail(`${sha.slice(0, 8)} 指向的 ${trailer} 不在 incidents.json 内(补登记后再合)`);
    const lineage = [incident.rootFixCommit, ...(incident.coverageCommits ?? [])];
    if (!lineage.some((candidate) => sha.startsWith(candidate))) {
      fail(`${sha.slice(0, 8)} 声明 ${trailer},但该事故的 rootFixCommit/coverageCommits 未包含本 commit`);
    }
  }
  return checked;
}

const trailerChecked = checkTrailerClosure();

for (const note of pendingRunners) {
  process.stdout.write(`[incident-regressions] pending-runner: ${note}\n`);
}
process.stdout.write(
  `[incident-regressions] PASS: ${manifest.incidents.length} P0/P1 incidents, ${linked.size} regression artifacts, `
  + `assertion debt ${assertionDebt}/${ASSERTION_DEBT_BASELINE}, proofPending ${proofPending}/${PROOF_PENDING_BASELINE}, `
  + `trailer-closure checked ${trailerChecked} fix(v5) commits, fixed live matrix locked\n`,
);
