/**
 * Single reader for an integ-tier manifest budget.
 * max-minutes is the CI job ceiling. file-timeout-ms is the node --test
 * parent timeout. mutex-timeout-seconds is the test-mutex watchdog.
 * Shards that omit the two new fields keep 180000 / 3600 and are not
 * checked against the new margin rules (pr-1/2/3 and nightly).
 */
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_FILE_TIMEOUT_MS = 180_000;
export const DEFAULT_MUTEX_TIMEOUT_SECONDS = 3600;
/** Room after the serial file budgets for TAP flush and the mutex watchdog. */
export const CLEANUP_MARGIN_MS = 120_000;
/** Room in the job ceiling after the mutex, for npm ci / bun install. */
export const INSTALL_MARGIN_SECONDS = 180;
const MAX_FILE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_MUTEX_SECONDS = 24 * 60 * 60;
const MAX_MINUTES = 24 * 60;

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

export interface ShardBudget {
  minTests: number;
  maxMinutes: number;
  fileTimeoutMs: number;
  mutexTimeoutSeconds: number;
  files: string[];
  declaredNewFields: boolean;
}

function positiveInt(raw: string, label: string, max: number): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new BudgetError(`${label} 必须是有限正整数，收到 ${JSON.stringify(raw)}`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new BudgetError(`${label} 越界: ${raw}`);
  }
  return n;
}

function readOverride(env: NodeJS.ProcessEnv, key: string, max: number): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(env, key)) return undefined;
  const raw = env[key];
  if (raw === undefined) return undefined;
  return positiveInt(raw, key, max);
}

export function parseShardBudget(text: string, env: NodeJS.ProcessEnv = {}): ShardBudget {
  let minTests: number | null = null;
  let maxMinutes: number | null = null;
  let fileTimeout: number | null = null;
  let mutexTimeout: number | null = null;
  const files: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    if (t.startsWith("#")) {
      const min = /^#\s*min-tests:\s*(\S+)\s*$/.exec(t);
      if (min) {
        if (minTests !== null) throw new BudgetError("重复的 min-tests");
        minTests = positiveInt(min[1]!, "min-tests", 1_000_000);
      }
      const max = /^#\s*max-minutes:\s*(\S+)\s*$/.exec(t);
      if (max) {
        if (maxMinutes !== null) throw new BudgetError("重复的 max-minutes");
        maxMinutes = positiveInt(max[1]!, "max-minutes", MAX_MINUTES);
      }
      const file = /^#\s*file-timeout-ms:\s*(\S+)\s*$/.exec(t);
      if (file) {
        if (fileTimeout !== null) throw new BudgetError("重复的 file-timeout-ms");
        fileTimeout = positiveInt(file[1]!, "file-timeout-ms", MAX_FILE_TIMEOUT_MS);
      }
      const mutex = /^#\s*mutex-timeout-seconds:\s*(\S+)\s*$/.exec(t);
      if (mutex) {
        if (mutexTimeout !== null) throw new BudgetError("重复的 mutex-timeout-seconds");
        mutexTimeout = positiveInt(mutex[1]!, "mutex-timeout-seconds", MAX_MUTEX_SECONDS);
      }
      continue;
    }
    if (t.includes(" ") || t.includes("..")) throw new BudgetError(`非法测试路径: ${t}`);
    files.push(t);
  }
  if (minTests === null) throw new BudgetError("缺必填 min-tests");
  if (maxMinutes === null) throw new BudgetError("缺必填 max-minutes");
  if ((fileTimeout === null) !== (mutexTimeout === null)) {
    throw new BudgetError("file-timeout-ms 与 mutex-timeout-seconds 必须同时声明");
  }
  const declaredNewFields = fileTimeout !== null;
  const fileOverride = readOverride(env, "OC_INTEG_TEST_TIMEOUT_MS", MAX_FILE_TIMEOUT_MS);
  const mutexOverride = readOverride(env, "OC_TEST_MUTEX_TIMEOUT", MAX_MUTEX_SECONDS);
  if (declaredNewFields && fileOverride !== undefined && fileOverride !== fileTimeout) {
    throw new BudgetError(`OC_INTEG_TEST_TIMEOUT_MS=${fileOverride} 与清单 file-timeout-ms=${fileTimeout} 冲突`);
  }
  if (declaredNewFields && mutexOverride !== undefined && mutexOverride !== mutexTimeout) {
    throw new BudgetError(`OC_TEST_MUTEX_TIMEOUT=${mutexOverride} 与清单 mutex-timeout-seconds=${mutexTimeout} 冲突`);
  }
  const fileTimeoutMs = fileOverride ?? fileTimeout ?? DEFAULT_FILE_TIMEOUT_MS;
  const mutexTimeoutSeconds = mutexOverride ?? mutexTimeout ?? DEFAULT_MUTEX_TIMEOUT_SECONDS;
  if (declaredNewFields) {
    if (files.length < 1) throw new BudgetError("声明了新预算但没有测试文件");
    const serialMs = files.length * fileTimeoutMs + CLEANUP_MARGIN_MS;
    if (serialMs > mutexTimeoutSeconds * 1000) {
      throw new BudgetError(
        `串行文件预算 ${files.length}*${fileTimeoutMs}+${CLEANUP_MARGIN_MS}ms 超过 mutex ${mutexTimeoutSeconds}s`,
      );
    }
    if (mutexTimeoutSeconds + INSTALL_MARGIN_SECONDS > maxMinutes * 60) {
      throw new BudgetError(
        `mutex ${mutexTimeoutSeconds}s + 安装余量 ${INSTALL_MARGIN_SECONDS}s 超过 job ${maxMinutes}min`,
      );
    }
  }
  return { minTests, maxMinutes, fileTimeoutMs, mutexTimeoutSeconds, files, declaredNewFields };
}

export interface WorkflowShard {
  shard: string;
  timeout: number;
}

export function readWorkflowInclude(workflowYaml: string): WorkflowShard[] {
  const lines = workflowYaml.split("\n");
  const out: WorkflowShard[] = [];
  for (let i = 0; i < lines.length; i++) {
    const shard = /^ +-\s+shard:\s+(\S+)\s*$/.exec(lines[i] ?? "");
    if (!shard) continue;
    const timeout = /^ +timeout:\s+(\S+)\s*$/.exec(lines[i + 1] ?? "");
    if (!timeout) throw new BudgetError(`workflow shard ${shard[1]} 下一行不是 timeout`);
    out.push({ shard: shard[1]!, timeout: positiveInt(timeout[1]!, `${shard[1]} timeout`, MAX_MINUTES) });
  }
  return out;
}

export function workflowBudgetDrift(workflowYaml: string, tierDir: string): string[] {
  const include = readWorkflowInclude(workflowYaml);
  const problems: string[] = [];
  const byShard = new Map(include.map((row) => [row.shard, row.timeout]));
  const manifests = readdirSync(tierDir).filter((name) => /^pr-.*\.txt$/.test(name)).sort();
  if (include.length !== manifests.length) {
    problems.push(`workflow 有 ${include.length} 个 shard，pr 清单有 ${manifests.length} 个`);
  }
  for (const name of manifests) {
    const shard = name.replace(/\.txt$/, "");
    const budget = parseShardBudget(readFileSync(join(tierDir, name), "utf8"), {});
    const timeout = byShard.get(shard);
    if (timeout === undefined) problems.push(`${shard} 不在 workflow matrix`);
    else if (timeout !== budget.maxMinutes) {
      problems.push(`${shard} job timeout ${timeout} != max-minutes ${budget.maxMinutes}`);
    }
  }
  for (const row of include) {
    if (!manifests.includes(`${row.shard}.txt`)) problems.push(`workflow shard ${row.shard} 没有清单`);
  }
  return problems;
}

function printShell(budget: ShardBudget): string {
  const lines = [
    `file_timeout_ms=${budget.fileTimeoutMs}`,
    `mutex_timeout_seconds=${budget.mutexTimeoutSeconds}`,
    `min_tests=${budget.minTests}`,
    `max_minutes=${budget.maxMinutes}`,
    "files=(",
    ...budget.files,
    ")",
  ];
  return `${lines.join("\n")}\n`;
}

function main(argv: string[]): number {
  const cmd = argv[2];
  try {
    if (cmd === "print-shell") {
      const text = readFileSync(argv[3]!, "utf8");
      process.stdout.write(printShell(parseShardBudget(text, process.env)));
      return 0;
    }
    if (cmd === "check-workflow") {
      const problems = workflowBudgetDrift(readFileSync(argv[3]!, "utf8"), argv[4]!);
      const include = readWorkflowInclude(readFileSync(argv[3]!, "utf8")).map((row) => ({
        shard: row.shard,
        timeout: row.timeout,
      }));
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `include=${JSON.stringify(include)}\n`);
      }
      process.stdout.write(`${JSON.stringify(include)}\n`);
      if (problems.length > 0) {
        for (const problem of problems) process.stderr.write(`::error::${problem}\n`);
        return 1;
      }
      return 0;
    }
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  process.stderr.write("usage: integ-shard-budget.ts print-shell <manifest> | check-workflow <yml> <tier-dir>\n");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
