#!/usr/bin/env tsx
// check-ci-parity.ts — 消灭「本地全量门」与「CI 全量门」两个权威源。
//
// 背景(2026-07-26 门禁审计):
//   `npm run check:v5` 号称"与 CI 完全同一组命令",实测并不是 —— check:v5 缺
//   test:browser(最贵、最有证明力的真浏览器门),CI 缺 test:mcp-memory。开发者
//   按文档在本地跑绿,合并后才发现漏了一整道门;反过来 CI 里悄悄加/删一条命令,
//   本地永远发现不了。两套清单人肉同步 = 迟早漂。
//
// 本脚本把两者变成**可机器核对的同一集合**:
//   1. 解析 .github/workflows/v5-ci.yml,展开 matrix,收集所有 job 的 `run:` 里
//      出现的 `npm run <script>` —— 这是 CI 真正执行的门集合;
//   2. 解析 package.json 的 `check:v5` 链,取出同样形态的 `npm run <script>`;
//   3. 两个集合必须**完全相等**;任一方向的差集非空 → 退出 1;
//   4. 额外核对 docs/V5_CI.md 的 job 表格行 ≡ workflow 里真实存在的 job 名
//      (文档漂移同样是假绿的温床:审计发现文档还写着 5 个 job)。
//
// 硬要求:CI 里禁止出现 workspace 作用域的 `npm run --workspace <ws> <script>`
//   形态 —— 那种写法无法与根 check:v5 的脚本名对齐比较。要跑 workspace 脚本,
//   在根 package.json 里加一条 alias(例:`test:browser`),两侧都用 alias。
//
// 用法:npm run check:ci-parity  (退出 0 = 一致;1 = 有差异)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = ".github/workflows/v5-ci.yml";
const DOC_PATH = "docs/V5_CI.md";

export interface ParityProblem {
  kind:
    | "npm-script-drift"
    | "workspace-run-in-ci"
    | "unexpanded-matrix"
    | "doc-job-drift"
    | "artifact-contract";
  message: string;
}

/** 从一段 shell 命令文本里抽出所有 `npm run <script>` 的脚本名。 */
export function extractNpmScripts(command: string): { scripts: string[]; workspaceForms: string[] } {
  const scripts: string[] = [];
  const workspaceForms: string[] = [];
  const re = /\bnpm\s+run\s+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const token = m[1]!;
    if (token.startsWith("-")) {
      // `npm run --workspace <ws> <script>` / `npm run -w ...`:脚本名不在固定位置,
      // 无法与根脚本集合对齐 → 强制要求改成根 alias。
      workspaceForms.push(m[0]!);
      continue;
    }
    scripts.push(token);
  }
  return { scripts, workspaceForms };
}

interface JobView {
  /** 用于与文档表格核对的 job 标识(matrix job = 每个 include 的 name;否则 = job key) */
  identifiers: string[];
  /** 该 job 展开 matrix 后所有 run 文本 */
  runs: string[];
}

/** 把 `${{ matrix.k }}` 替换成 include 条目里的值。 */
function substituteMatrix(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\$\{\{\s*matrix\.([\w.-]+)\s*\}\}/g, (whole, key: string) => {
    const v = vars[key];
    return v === undefined ? whole : String(v);
  });
}

export function readWorkflowJobs(yamlText: string): { jobs: JobView[]; problems: ParityProblem[] } {
  const doc = parseYaml(yamlText) as { jobs?: Record<string, any> };
  const problems: ParityProblem[] = [];
  const jobs: JobView[] = [];
  for (const [jobKey, job] of Object.entries(doc.jobs ?? {})) {
    const include: Record<string, unknown>[] | undefined = job?.strategy?.matrix?.include;
    const steps: { run?: string }[] = Array.isArray(job?.steps) ? job.steps : [];
    const rawRuns = steps.map((s) => s?.run).filter((r): r is string => typeof r === "string");
    if (Array.isArray(include) && include.length > 0) {
      // 每个 matrix 变体独立成一条 JobView:报错时能精确指到是哪一格。
      for (const variant of include) {
        jobs.push({
          identifiers: [String(variant.name ?? jobKey)],
          runs: rawRuns.map((raw) => substituteMatrix(raw, variant)),
        });
      }
    } else {
      jobs.push({ identifiers: [jobKey], runs: rawRuns });
    }
  }
  for (const j of jobs) {
    for (const run of j.runs) {
      if (/\$\{\{\s*matrix\./.test(run)) {
        problems.push({
          kind: "unexpanded-matrix",
          message: `job ${j.identifiers.join("/")}: run 里仍有未展开的 matrix 表达式,parity 无法核对:\n    ${run.trim()}`,
        });
      }
    }
  }
  return { jobs, problems };
}

/** 解析 docs/V5_CI.md 里第一列表头为 `Job` 的 markdown 表格,返回首列取值。 */
export function readDocJobTable(markdown: string): string[] | null {
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const cells = splitRow(lines[i]!);
    if (!cells || cells[0]?.trim().toLowerCase() !== "job") continue;
    const sep = splitRow(lines[i + 1] ?? "");
    if (!sep || !/^:?-{2,}:?$/.test(sep[0]!.trim())) continue;
    const out: string[] = [];
    for (let j = i + 2; j < lines.length; j++) {
      const row = splitRow(lines[j]!);
      if (!row) break;
      out.push(row[0]!.trim().replace(/^`|`$/g, ""));
    }
    return out;
  }
  return null;
}

function splitRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return null;
  return t.slice(1, -1).split("|");
}

function sorted(s: Iterable<string>): string[] {
  return [...new Set(s)].sort();
}

/**
 * upload-artifact 的 fail-closed 契约。
 *
 * 从 packages/commercial/src/__tests__/v5CiWorkflow.test.ts 迁过来(2026-07-26):
 * 那个测试用正则匹配 YAML 的**缩进列数**(`^ {10}path: …`),把 6 空格改成 4 空格
 * 就红 —— 典型的"重构必红、价值不高"。同一条不变量在这里按解析后的 YAML 结构断言,
 * 与排版无关。
 *
 * 保住的事实:
 *   ① 每个 upload-artifact 步骤都必须 `if-no-files-found: error` —— 否则产物丢了
 *      job 照样绿,门只剩套件名、没有断言详情可查(commercial-unit 尤其致命);
 *   ② commercial-unit 的 TAP 写入路径与上传路径必须是**同一个** env 变量,
 *      不能一边写 a.tap 一边传 b.tap。
 */
export function checkArtifactContract(yamlText: string): ParityProblem[] {
  const doc = parseYaml(yamlText) as { jobs?: Record<string, any> };
  const problems: ParityProblem[] = [];
  let uploadSteps = 0;
  for (const [jobKey, job] of Object.entries(doc.jobs ?? {})) {
    const steps: any[] = Array.isArray(job?.steps) ? job.steps : [];
    for (const step of steps) {
      const uses = typeof step?.uses === "string" ? step.uses : "";
      if (!uses.startsWith("actions/upload-artifact")) continue;
      uploadSteps += 1;
      const withBlock = step?.with ?? {};
      if (String(withBlock["if-no-files-found"] ?? "") !== "error") {
        problems.push({
          kind: "artifact-contract",
          message:
            `job ${jobKey} 的 upload-artifact 步骤缺 \`if-no-files-found: error\` —— ` +
            `产物丢失必须让 job 红,否则门只报套件名、丢掉真实断言详情。`,
        });
      }
    }
  }
  if (uploadSteps === 0) {
    problems.push({
      kind: "artifact-contract",
      message:
        "workflow 里一个 upload-artifact 步骤都没有 —— commercial-unit 的 TAP 产物是" +
        "门禁的唯一取证材料,不能删。",
    });
  }

  // commercial-unit:TAP_OUT 与上传 path 必须引用同一个 env 变量。
  const cu = (doc.jobs ?? {})["commercial-unit"];
  if (cu) {
    const steps: any[] = Array.isArray(cu.steps) ? cu.steps : [];
    const runner = steps.find((s) => typeof s?.run === "string" && s.run.includes("test:commercial:unit:gate"));
    const uploader = steps.find((s) => typeof s?.uses === "string" && s.uses.startsWith("actions/upload-artifact"));
    const tapOut = String(runner?.env?.TAP_OUT ?? "");
    const uploadPath = String(uploader?.with?.path ?? "");
    if (tapOut === "" || uploadPath === "" || tapOut !== uploadPath) {
      problems.push({
        kind: "artifact-contract",
        message:
          `commercial-unit 的 TAP 写入路径与上传路径必须同源,实测 ` +
          `TAP_OUT=${tapOut || "<missing>"} vs upload path=${uploadPath || "<missing>"}。` +
          `两者都应引用同一个 job env(当前是 COMMERCIAL_UNIT_TAP)。`,
      });
    }
  }
  return problems;
}

export function checkParity(opts: {
  workflowYaml: string;
  packageJson: string;
  docMarkdown: string;
}): ParityProblem[] {
  const { jobs, problems } = readWorkflowJobs(opts.workflowYaml);
  problems.push(...checkArtifactContract(opts.workflowYaml));
  const ciScripts = new Set<string>();
  for (const job of jobs) {
    for (const run of job.runs) {
      const { scripts, workspaceForms } = extractNpmScripts(run);
      for (const s of scripts) ciScripts.add(s);
      for (const w of workspaceForms) {
        problems.push({
          kind: "workspace-run-in-ci",
          message:
            `job ${job.identifiers.join("/")}: CI 里出现 workspace 作用域调用 \`${w}\`。` +
            `请在根 package.json 加一条 alias 脚本,CI 与 check:v5 都用该 alias —— ` +
            `否则 parity 无法比较脚本名。`,
        });
      }
    }
  }

  const pkg = JSON.parse(opts.packageJson) as { scripts?: Record<string, string> };
  const checkV5 = pkg.scripts?.["check:v5"];
  if (!checkV5) {
    problems.push({ kind: "npm-script-drift", message: "package.json 缺少 check:v5 脚本" });
    return problems;
  }
  const localScripts = new Set(extractNpmScripts(checkV5).scripts);

  const missingInCi = sorted([...localScripts].filter((s) => !ciScripts.has(s)));
  const missingInLocal = sorted([...ciScripts].filter((s) => !localScripts.has(s)));
  if (missingInCi.length > 0) {
    problems.push({
      kind: "npm-script-drift",
      message:
        `check:v5 里有、CI 里没有的门(CI 假绿风险):\n` +
        missingInCi.map((s) => `    - npm run ${s}`).join("\n"),
    });
  }
  if (missingInLocal.length > 0) {
    problems.push({
      kind: "npm-script-drift",
      message:
        `CI 里有、check:v5 里没有的门(本地跑绿骗人风险):\n` +
        missingInLocal.map((s) => `    - npm run ${s}`).join("\n"),
    });
  }

  const docJobs = readDocJobTable(opts.docMarkdown);
  const realJobs = sorted(jobs.flatMap((j) => j.identifiers));
  if (docJobs === null) {
    problems.push({
      kind: "doc-job-drift",
      message: `${DOC_PATH} 里找不到首列表头为 \`Job\` 的表格 —— 文档 job 表是 CI 的对外契约,不能删。`,
    });
  } else {
    const docSet = sorted(docJobs);
    const docMissing = realJobs.filter((j) => !docSet.includes(j));
    const docExtra = docSet.filter((j) => !realJobs.includes(j));
    if (docMissing.length > 0 || docExtra.length > 0) {
      problems.push({
        kind: "doc-job-drift",
        message:
          `${DOC_PATH} 的 job 表格与 workflow 不一致:\n` +
          (docMissing.length > 0 ? `    文档缺少:${docMissing.join(", ")}\n` : "") +
          (docExtra.length > 0 ? `    文档多余:${docExtra.join(", ")}\n` : "") +
          `    workflow 实际 job:${realJobs.join(", ")}`,
      });
    }
  }

  return problems;
}

export function main(repoRoot: string): number {
  const problems = checkParity({
    workflowYaml: readFileSync(join(repoRoot, WORKFLOW_PATH), "utf8"),
    packageJson: readFileSync(join(repoRoot, "package.json"), "utf8"),
    docMarkdown: readFileSync(join(repoRoot, DOC_PATH), "utf8"),
  });
  if (problems.length === 0) {
    console.log("[check-ci-parity] OK — v5-ci.yml 的 npm 门集合 ≡ check:v5,且 docs/V5_CI.md job 表格与 workflow 一致");
    return 0;
  }
  console.error(`[check-ci-parity] FAIL — ${problems.length} 处不一致:`);
  for (const p of problems) console.error(`  [${p.kind}] ${p.message}`);
  console.error(
    "\n修法:CI 与 check:v5 必须逐条对齐(新增门两边都加),docs/V5_CI.md 的 job 表格同步。",
  );
  return 1;
}

const __filename_ = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === __filename_) {
  process.exit(main(REPO_ROOT));
}
