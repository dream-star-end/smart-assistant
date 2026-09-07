#!/usr/bin/env -S npx tsx
/**
 * v5-problem-card-review.ts — 每日问题卡审查（只读 PG + oc-task 开单/评论 + digest）。
 *
 * 宿主 cron 跑；不进 master 进程。fail-closed：PG 失败不写；oc-task 3/4 只留 digest。
 *
 *   npx tsx scripts/v5-problem-card-review.ts [--dry-run] [--window 24h] [--date YYYY-MM-DD]
 *     [--no-tickets] [--state-dir DIR] [--container oc-v5-u3] [--project OCV5]
 *     [--env-file /etc/openclaude/commercial-v5-selfhost.env]
 *
 * 退出码: 0 成功; 2 PG 失败; 3 面板不可用(digest 已写、state 未改); 4 参数错误。
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;

export const EXIT = { ok: 0, pg: 2, panel: 3, usage: 4 } as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PATH_RE = /^[a-z0-9_]{1,32}$/;
const REASON_RE = /^[a-z0-9_]{1,48}$/;
const STAGES = ["problem_card", "recovery_decision", "recovery_job", "visible_fallback"] as const;
const CLOSED_STATUSES = new Set(["done", "cancelled", "canceled"]);
const OC_TASK_BIN = "/home/agent/.local/bin/oc-task";
const DEFAULT_ENV_FILE = "/etc/openclaude/commercial-v5-selfhost.env";
const DEFAULT_STATE_DIR = "/opt/openclaude/var/problem-card-review";
const DEFAULT_CONTAINER = "oc-v5-u3";
const DEFAULT_PROJECT_KEY = "OCV5";
const INBOX_UID = "3";
const EXEC_TIMEOUT_MS = 30_000;

export interface WindowCounts {
  shown: number;
  recovered: number;
  failed: number;
  cancelled: number;
  pending: number;
  affected_users: number;
  affected_users_failed: number;
  p50_recover_ms: number | null;
  traces: string[];
}

export interface FingerprintAgg {
  fingerprint: string;
  stage: string;
  code: string;
  path: string;
  reason: string;
  h24: WindowCounts;
  d7: WindowCounts;
}

export interface DistRow {
  key: string;
  n: number;
}

export interface ReviewAgg {
  date: string;
  windowHours: number;
  fingerprints: FingerprintAgg[];
  decisions: DistRow[];
  jobs: DistRow[];
  fallbacks: DistRow[];
}

export interface TicketRef {
  identifier: string;
  title: string;
  status: string;
}

export interface DailyFailed {
  date: string;
  failed: number;
}

export interface StateEntry {
  identifier: string;
  created_at: string;
  last_comment_date?: string;
  last_counts?: Partial<WindowCounts>;
  daily: DailyFailed[];
  close_suggested_at?: string;
}

export interface StateFile {
  fingerprints: Record<string, StateEntry>;
}

export type PlannedAction =
  | { kind: "create"; fingerprint: string; title: string; body: string }
  | { kind: "comment"; fingerprint: string; identifier: string; body: string }
  | { kind: "suggest_close"; fingerprint: string; identifier: string; body: string };

export interface CliOptions {
  windowHours: number;
  dryRun: boolean;
  noTickets: boolean;
  stateDir: string;
  container: string;
  projectKey: string;
  date: string;
  envFile: string;
  help: boolean;
}

export interface FrictionRow {
  stage: string;
  code: string;
  path?: string | null;
  reason?: string | null;
}

export function normalizeToken(value: string | null | undefined, kind: "path" | "reason"): string {
  if (value == null) return "-";
  const trimmed = String(value).trim();
  if (!trimmed) return "-";
  const re = kind === "path" ? PATH_RE : REASON_RE;
  return re.test(trimmed) ? trimmed : "other";
}

export function fingerprintOf(row: FrictionRow): string {
  return `${row.stage}:${row.code}:${normalizeToken(row.path, "path")}:${normalizeToken(row.reason, "reason")}`;
}

export function shouldOpenTicket(counts: Pick<WindowCounts, "failed" | "affected_users_failed">): boolean {
  const failed = Number(counts.failed) || 0;
  const users = Number(counts.affected_users_failed) || 0;
  return (failed >= 3 && users >= 2) || failed >= 5;
}

export function safeDate(raw?: string | null, now: Date = new Date()): string {
  if (raw == null || raw === "") return cstToday(now);
  if (!DATE_RE.test(raw)) throw new Error(`invalid --date ${raw}`);
  const [ys, ms, ds] = raw.split("-");
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new Error(`invalid --date ${raw}`);
  }
  return raw;
}

export function parseWindowHours(raw?: string | null): number {
  const s = raw == null || raw === "" ? "24h" : raw;
  const m = /^(\d{1,3})h$/.exec(s);
  if (!m) throw new Error(`invalid --window ${s} (expected Nh, 1h..720h)`);
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > 720) {
    throw new Error(`--window out of range (1h..720h): ${s}`);
  }
  return n;
}

export function cstToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(ymd: string, delta: number): string {
  const checked = safeDate(ymd);
  const [y, m, d] = checked.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function isClosedStatus(status: string | null | undefined): boolean {
  return CLOSED_STATUSES.has(String(status ?? "").toLowerCase());
}

export type OcTaskKind = "project-list" | "ticket-list" | "ticket-create" | "ticket-comment";

export function buildOcTaskArgs(
  kind: OcTaskKind,
  opts: {
    projectId?: string;
    label?: string;
    limit?: number;
    title?: string;
    body?: string;
    identifier?: string;
    type?: string;
    priority?: string;
    labels?: string;
  } = {},
): string[] {
  switch (kind) {
    case "project-list":
      return ["project", "list"];
    case "ticket-list": {
      const args = ["ticket", "list"];
      if (opts.projectId) args.push("--project-id", opts.projectId);
      if (opts.label) args.push("--label", opts.label);
      args.push("--limit", String(opts.limit ?? 200));
      return args;
    }
    case "ticket-create":
      return [
        "ticket",
        "create",
        "--project-id",
        opts.projectId ?? "",
        "--type",
        opts.type ?? "bug",
        "--priority",
        opts.priority ?? "P2",
        "--labels",
        opts.labels ?? "problem-card,auto",
        "--title",
        opts.title ?? "",
        "--body",
        opts.body ?? "",
      ];
    case "ticket-comment":
      return ["ticket", "comment", opts.identifier ?? "", "--body", opts.body ?? ""];
    default: {
      const _never: never = kind;
      throw new Error(`unknown oc-task kind ${_never}`);
    }
  }
}

export function dockerExecOcTaskArgv(container: string, ocArgs: string[]): string[] {
  return ["exec", "-i", container, OC_TASK_BIN, ...ocArgs];
}

export function digestContainerPath(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`refusing digest path: invalid date ${date}`);
  return `/home/agent/.openclaude/generated/problem-card-digest-${date}.md`;
}

export function dockerCopyDigestArgv(container: string, date: string): { file: string; argv: string[] } {
  const dest = digestContainerPath(date);
  return {
    file: "docker",
    argv: ["exec", "-i", container, "sh", "-c", `cat > ${dest}`],
  };
}

function emptyCounts(): WindowCounts {
  return {
    shown: 0,
    recovered: 0,
    failed: 0,
    cancelled: 0,
    pending: 0,
    affected_users: 0,
    affected_users_failed: 0,
    p50_recover_ms: null,
    traces: [],
  };
}

function recoveryRate(recovered: number, failed: number): number | null {
  const den = recovered + failed;
  if (den <= 0) return null;
  return recovered / den;
}

function formatPct(rate: number | null): string {
  if (rate == null) return "n/a";
  return `${(rate * 100).toFixed(1)}%`;
}

function classifyFingerprint(fp: FingerprintAgg): string {
  if (fp.stage === "visible_fallback") return "对账占位";
  if (fp.stage === "recovery_decision" || fp.stage === "recovery_job") return "自恢复缺口";
  if (fp.stage === "problem_card" && fp.path === "immediate") return "真故障或不可恢复码";
  return "待归类";
}

function snapshotCounts(c: WindowCounts): Partial<WindowCounts> {
  return {
    shown: c.shown,
    recovered: c.recovered,
    failed: c.failed,
    cancelled: c.cancelled,
    pending: c.pending,
    affected_users: c.affected_users,
    affected_users_failed: c.affected_users_failed,
  };
}

function countsChanged(prev: Partial<WindowCounts> | undefined, next: WindowCounts): boolean {
  if (!prev) return true;
  const keys = [
    "shown",
    "recovered",
    "failed",
    "cancelled",
    "pending",
    "affected_users",
    "affected_users_failed",
  ] as const;
  return keys.some((k) => Number(prev[k] ?? 0) !== Number(next[k] ?? 0));
}

function findOpenTicket(fp: string, tickets: TicketRef[]): TicketRef | undefined {
  const title = `problem-card: ${fp}`;
  return tickets.find((t) => t.title === title && !isClosedStatus(t.status));
}

function trimDaily(daily: DailyFailed[], today: string): DailyFailed[] {
  const map = new Map<string, number>();
  for (const row of daily) {
    if (!DATE_RE.test(row.date)) continue;
    map.set(row.date, Number(row.failed) || 0);
  }
  const out: DailyFailed[] = [];
  for (let i = 13; i >= 0; i--) {
    const date = addDays(today, -i);
    if (map.has(date)) out.push({ date, failed: map.get(date)! });
  }
  return out.slice(-14);
}

function sevenDaysZeroFailed(daily: DailyFailed[], today: string): boolean {
  for (let i = 0; i < 7; i++) {
    const date = addDays(today, -i);
    const hit = daily.find((d) => d.date === date);
    if (!hit || hit.failed !== 0) return false;
  }
  return true;
}

function cloneState(state: StateFile): StateFile {
  return JSON.parse(JSON.stringify(state)) as StateFile;
}

export function nextActions(
  agg: ReviewAgg,
  state: StateFile,
  todayTickets: TicketRef[],
): { actions: PlannedAction[]; nextState: StateFile } {
  const today = agg.date;
  const nextState = cloneState(state);
  const byFp = new Map(agg.fingerprints.map((f) => [f.fingerprint, f]));
  const keys = new Set<string>([...byFp.keys(), ...Object.keys(nextState.fingerprints)]);
  const actions: PlannedAction[] = [];

  for (const fp of keys) {
    const row = byFp.get(fp);
    const failedToday = row?.h24.failed ?? 0;
    const entry = nextState.fingerprints[fp] ?? {
      identifier: "",
      created_at: today,
      daily: [],
    };
    entry.daily = trimDaily([...entry.daily, { date: today, failed: failedToday }], today);
    nextState.fingerprints[fp] = entry;

    const open = findOpenTicket(fp, todayTickets);
    if (open) entry.identifier = open.identifier;

    if (row && shouldOpenTicket(row.h24)) {
      if (!open) {
        actions.push({
          kind: "create",
          fingerprint: fp,
          title: `problem-card: ${fp}`,
          body: renderTicketBody(fp, agg),
        });
        continue;
      }
      if (entry.last_comment_date !== today && countsChanged(entry.last_counts, row.h24)) {
        actions.push({
          kind: "comment",
          fingerprint: fp,
          identifier: open.identifier,
          body: renderDailyCountsComment(today, fp, row.h24),
        });
      }
      continue;
    }

    if (
      open &&
      entry.identifier &&
      !entry.close_suggested_at &&
      sevenDaysZeroFailed(entry.daily, today)
    ) {
      actions.push({
        kind: "suggest_close",
        fingerprint: fp,
        identifier: open.identifier,
        body: "建议关单：7 天无新样本",
      });
    }
  }

  return { actions, nextState };
}

export function renderDailyCountsComment(date: string, fp: string, c: WindowCounts): string {
  return [
    `问题卡当日计数 ${date}`,
    "",
    `- fingerprint: \`${fp}\``,
    `- shown=${c.shown} failed=${c.failed} recovered=${c.recovered} cancelled=${c.cancelled} pending=${c.pending}`,
    `- affected_users=${c.affected_users} affected_users_failed=${c.affected_users_failed}`,
    `- p50_recover_ms=${c.p50_recover_ms ?? "n/a"} recovery_rate=${formatPct(recoveryRate(c.recovered, c.failed))}`,
  ].join("\n");
}

function countsTable(label: string, c: WindowCounts): string[] {
  return [
    `### ${label}`,
    "",
    "| shown | recovered | failed | cancelled | pending | users | users_failed | p50_ms | traces |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    `| ${c.shown} | ${c.recovered} | ${c.failed} | ${c.cancelled} | ${c.pending} | ${c.affected_users} | ${c.affected_users_failed} | ${c.p50_recover_ms ?? "n/a"} | ${c.traces.join(", ") || "-"} |`,
  ];
}

export function renderTicketBody(fp: string, agg: ReviewAgg): string {
  const row = agg.fingerprints.find((f) => f.fingerprint === fp);
  const h24 = row?.h24 ?? emptyCounts();
  const d7 = row?.d7 ?? emptyCounts();
  const rate = formatPct(recoveryRate(h24.recovered, h24.failed));
  const cls = row ? classifyFingerprint(row) : "待归类";
  const reasonDist = agg.decisions
    .slice(0, 8)
    .map((d) => `- \`${d.key}\`: ${d.n}`)
    .join("\n");
  return [
    `# problem-card: ${fp}`,
    "",
    `自动开单（backlog，需人批准）。归类建议：**${cls}**。`,
    "",
    ...countsTable("24h", h24),
    "",
    ...countsTable("7d", d7),
    "",
    `恢复率(24h recovered/(recovered+failed)): ${rate}`,
    "",
    "样本 trace_id（最多 3，无正文）:",
    ...(h24.traces.length ? h24.traces.map((t) => `- \`${t}\``) : ["- （无）"]),
    "",
    "recovery_decision reason 分布（7d）:",
    reasonDist || "- （无）",
    "",
    "本单由问题卡审查脚本自动创建，不含消息正文 / 堆栈 / URL / UA。",
  ].join("\n");
}

function distTable(title: string, rows: DistRow[]): string[] {
  const top = rows.slice(0, 20);
  if (top.length === 0) return [`## ${title}`, "", "_（无）_", ""];
  return [
    `## ${title}`,
    "",
    "| key | n |",
    "| --- | ---: |",
    ...top.map((r) => `| \`${r.key}\` | ${r.n} |`),
    "",
  ];
}

export function renderDigest(
  agg: ReviewAgg,
  actions: PlannedAction[] = [],
  notes: string[] = [],
): string {
  const h24 = agg.fingerprints.reduce(
    (acc, f) => {
      acc.shown += f.h24.shown;
      acc.failed += f.h24.failed;
      acc.recovered += f.h24.recovered;
      acc.cancelled += f.h24.cancelled;
      acc.users += f.h24.affected_users;
      return acc;
    },
    { shown: 0, failed: 0, recovered: 0, cancelled: 0, users: 0 },
  );
  const nClass = agg.fingerprints.filter((f) => f.h24.shown > 0).length;
  const rate = formatPct(recoveryRate(h24.recovered, h24.failed));
  const top = [...agg.fingerprints]
    .filter((f) => f.h24.shown > 0)
    .sort((a, b) => b.h24.failed - a.h24.failed || b.h24.shown - a.h24.shown)
    .slice(0, 20);
  const actionLines =
    actions.length === 0
      ? ["_无_"]
      : actions.map((a) => {
          if (a.kind === "create") return `- 新建单 \`${a.title}\``;
          if (a.kind === "comment") return `- 评论 ${a.identifier}（\`${a.fingerprint}\` 当日计数）`;
          return `- 建议关单 ${a.identifier}（\`${a.fingerprint}\`）`;
        });
  const noteLines = notes.length ? ["## 备注", "", ...notes.map((n) => `- ${n}`), ""] : [];
  return [
    `# 问题卡日报 ${agg.date}`,
    "",
    `窗口 ${agg.windowHours}h + 7d。stage ∈ problem_card / recovery_decision / recovery_job / visible_fallback。`,
    "",
    "## 总览",
    "",
    `- 指纹类（24h shown>0）: **${nClass}**`,
    `- 终态卡 failed（24h）: **${h24.failed}**`,
    `- recovered / cancelled: ${h24.recovered} / ${h24.cancelled}`,
    `- 恢复率 recovered/(recovered+failed): **${rate}**`,
    `- 受影响用户（Σ fingerprint affected_users，未去重跨指纹）: ${h24.users}`,
    `- shown 合计: ${h24.shown}`,
    "",
    "## Top fingerprint（按 failed 降序，≤20）",
    "",
    top.length === 0
      ? "_空聚合：窗口内无问题卡 / 裁决 / job / fallback 行（旧 chat/turn_error 不在范围内）。_"
      : [
          "| fingerprint | shown | failed | recovered | cancelled | users_failed | p50_ms | 建议 |",
          "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
          ...top.map((f) => {
            const c = f.h24;
            return `| \`${f.fingerprint}\` | ${c.shown} | ${c.failed} | ${c.recovered} | ${c.cancelled} | ${c.affected_users_failed} | ${c.p50_recover_ms ?? "n/a"} | ${classifyFingerprint(f)} |`;
          }),
        ].join("\n"),
    "",
    ...distTable("recovery_decision reason", agg.decisions),
    ...distTable("recovery_job reason", agg.jobs),
    ...distTable("visible_fallback reason", agg.fallbacks),
    "## 今日动作",
    "",
    ...actionLines,
    "",
    ...noteLines,
    "隐私：只读 `product_friction_events` 有界枚举；不查 messages / tape / 正文。",
    "",
  ].join("\n");
}

export function inboxTitle(agg: ReviewAgg): string {
  const n = agg.fingerprints.filter((f) => f.h24.shown > 0).length;
  const failed = agg.fingerprints.reduce((s, f) => s + f.h24.failed, 0);
  const recovered = agg.fingerprints.reduce((s, f) => s + f.h24.recovered, 0);
  return `问题卡日报 ${agg.date}：${n} 类 / ${failed} 张终态卡 / 恢复率 ${formatPct(recoveryRate(recovered, failed))}`;
}

export function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = {
    windowHours: 24,
    dryRun: false,
    noTickets: false,
    stateDir: DEFAULT_STATE_DIR,
    container: DEFAULT_CONTAINER,
    projectKey: DEFAULT_PROJECT_KEY,
    date: cstToday(),
    envFile: DEFAULT_ENV_FILE,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-tickets") opts.noTickets = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--window") opts.windowHours = parseWindowHours(next());
    else if (a === "--state-dir") opts.stateDir = next() ?? opts.stateDir;
    else if (a === "--container") opts.container = next() ?? opts.container;
    else if (a === "--project") opts.projectKey = next() ?? opts.projectKey;
    else if (a === "--date") opts.date = safeDate(next());
    else if (a === "--env-file") opts.envFile = next() ?? opts.envFile;
    else if (a.startsWith("--window=")) opts.windowHours = parseWindowHours(a.slice("--window=".length));
    else if (a.startsWith("--date=")) opts.date = safeDate(a.slice("--date=".length));
    else if (a.startsWith("--state-dir=")) opts.stateDir = a.slice("--state-dir=".length);
    else if (a.startsWith("--container=")) opts.container = a.slice("--container=".length);
    else if (a.startsWith("--project=")) opts.projectKey = a.slice("--project=".length);
    else if (a.startsWith("--env-file=")) opts.envFile = a.slice("--env-file=".length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.container || /[^A-Za-z0-9._-]/.test(opts.container)) {
    throw new Error(`invalid --container ${opts.container}`);
  }
  if (!opts.projectKey || /[^A-Za-z0-9_-]/.test(opts.projectKey)) {
    throw new Error(`invalid --project ${opts.projectKey}`);
  }
  opts.date = safeDate(opts.date);
  return opts;
}

export function readDatabaseUrl(envFile: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  if (!envFile || !existsSync(envFile)) return undefined;
  const text = readFileSync(envFile, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^DATABASE_URL=(.*)$/);
    if (!m) continue;
    let v = m[1]!.trim();
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1);
    }
    return v || undefined;
  }
  return undefined;
}

export function loadState(stateDir: string): StateFile {
  const file = path.join(stateDir, "state.json");
  if (!existsSync(file)) return { fingerprints: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`state.json parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("state.json must be an object");
  }
  const fps = (raw as { fingerprints?: unknown }).fingerprints;
  if (!fps || typeof fps !== "object" || Array.isArray(fps)) {
    throw new Error("state.json.fingerprints must be an object");
  }
  return { fingerprints: fps as Record<string, StateEntry> };
}

export function atomicWriteFile(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type ExecFileFn = (
  file: string,
  argv: string[],
  opts?: { input?: string; timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

const defaultExecFile: ExecFileFn = (file, argv, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      argv,
      {
        encoding: "utf8",
        timeout: opts.timeout ?? EXEC_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        cwd: opts.cwd,
        env: opts.env,
      },
      (err, stdout, stderr) => {
        let status: number | null = 0;
        let error: string | undefined;
        if (err) {
          const anyErr = err as NodeJS.ErrnoException & { status?: number | null };
          if (typeof anyErr.status === "number") status = anyErr.status;
          else if (typeof anyErr.code === "number") status = anyErr.code;
          else {
            status = 1;
            error = anyErr.code ? String(anyErr.code) : anyErr.message;
          }
        }
        resolve({
          status,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          error,
        });
      },
    );
    if (opts.input != null) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  });

function parseJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
    } catch {
      /* try previous line */
    }
  }
  return null;
}

async function ocTask(
  container: string,
  ocArgs: string[],
  execFn: ExecFileFn,
): Promise<{ status: number; json: Record<string, unknown> | null; stdout: string; stderr: string }> {
  const argv = dockerExecOcTaskArgv(container, ocArgs);
  const res = await execFn("docker", argv);
  const json = parseJsonLine(res.stdout);
  return { status: res.status ?? 1, json, stdout: res.stdout, stderr: res.stderr };
}

function asItems(json: Record<string, unknown> | null): Array<Record<string, unknown>> {
  if (!json) return [];
  const items = json.items;
  if (Array.isArray(items)) return items.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>;
  return [];
}

function ticketFromUnknown(row: Record<string, unknown>): TicketRef | null {
  const identifier = typeof row.identifier === "string" ? row.identifier : "";
  const title = typeof row.title === "string" ? row.title : "";
  const status = typeof row.status === "string" ? row.status : "";
  if (!identifier || !title) return null;
  return { identifier, title, status };
}

async function withRetry409(
  run: () => Promise<{ status: number; json: Record<string, unknown> | null; stdout: string; stderr: string }>,
): Promise<{ status: number; json: Record<string, unknown> | null; stdout: string; stderr: string }> {
  const first = await run();
  if (first.status !== 5) return first;
  return run();
}

function n(v: unknown): number {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

function nNull(v: unknown): number | null {
  if (v == null) return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

interface SqlAggRow {
  stage: string;
  code: string;
  path: string | null;
  reason: string | null;
  shown: number | string;
  recovered: number | string;
  failed: number | string;
  cancelled: number | string;
  pending: number | string;
  affected_users: number | string;
  affected_users_failed: number | string;
  p50_recover_ms: number | string | null;
}

function toWindowCounts(row: SqlAggRow, traces: string[]): WindowCounts {
  return {
    shown: n(row.shown),
    recovered: n(row.recovered),
    failed: n(row.failed),
    cancelled: n(row.cancelled),
    pending: n(row.pending),
    affected_users: n(row.affected_users),
    affected_users_failed: n(row.affected_users_failed),
    p50_recover_ms: nNull(row.p50_recover_ms),
    traces,
  };
}

async function queryAggregation(client: pg.Client, hours: number): Promise<{
  rows: SqlAggRow[];
  traces: Map<string, string[]>;
  decisions: DistRow[];
  jobs: DistRow[];
  fallbacks: DistRow[];
}> {
  const colProbe = await client.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'product_friction_events'
        AND column_name IN ('presentation','path','reason')`,
  );
  const cols = new Set(colProbe.rows.map((r) => r.column_name));
  const pathExpr = cols.has("path") ? "path" : "NULL::varchar";
  const reasonExpr = cols.has("reason") ? "reason" : "NULL::varchar";

  const aggSql = `
    SELECT stage, code,
           ${pathExpr} AS path,
           ${reasonExpr} AS reason,
           COUNT(*)::int AS shown,
           COUNT(*) FILTER (WHERE outcome='recovered')::int AS recovered,
           COUNT(*) FILTER (WHERE outcome='failed')::int AS failed,
           COUNT(*) FILTER (WHERE outcome='cancelled')::int AS cancelled,
           COUNT(*) FILTER (WHERE outcome='pending')::int AS pending,
           COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::int AS affected_users,
           COUNT(DISTINCT user_id) FILTER (WHERE outcome='failed' AND user_id IS NOT NULL)::int AS affected_users_failed,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (recovered_at - created_at)) * 1000
           ) FILTER (WHERE outcome='recovered' AND recovered_at IS NOT NULL) AS p50_recover_ms
      FROM product_friction_events
     WHERE stage = ANY($1::text[])
       AND created_at > NOW() - ($2::int * INTERVAL '1 hour')
     GROUP BY stage, code, ${pathExpr}, ${reasonExpr}`;

  const traceSql = `
    SELECT stage, code, path, reason, trace_id FROM (
      SELECT stage, code,
             ${pathExpr} AS path,
             ${reasonExpr} AS reason,
             trace_id,
             ROW_NUMBER() OVER (
               PARTITION BY stage, code, COALESCE(${pathExpr}, '-'), COALESCE(${reasonExpr}, '-')
               ORDER BY created_at DESC
             ) AS rn
        FROM product_friction_events
       WHERE stage = ANY($1::text[])
         AND created_at > NOW() - ($2::int * INTERVAL '1 hour')
         AND trace_id IS NOT NULL
         AND trace_id <> ''
    ) s
    WHERE rn <= 3`;

  const distSql = (stage: string) => `
    SELECT COALESCE(${reasonExpr}, '-') AS key, COUNT(*)::int AS n
      FROM product_friction_events
     WHERE stage = $1
       AND created_at > NOW() - ($2::int * INTERVAL '1 hour')
     GROUP BY 1
     ORDER BY n DESC
     LIMIT 50`;

  // Single pg.Client cannot pipeline concurrent queries (deprecated in pg@9).
  const agg = await client.query<SqlAggRow>(aggSql, [STAGES, hours]);
  const tracesRes = await client.query<{
    stage: string;
    code: string;
    path: string | null;
    reason: string | null;
    trace_id: string;
  }>(traceSql, [STAGES, hours]);
  const decisions = await client.query<{ key: string; n: number | string }>(distSql("recovery_decision"), [
    "recovery_decision",
    hours,
  ]);
  const jobs = await client.query<{ key: string; n: number | string }>(distSql("recovery_job"), [
    "recovery_job",
    hours,
  ]);
  const fallbacks = await client.query<{ key: string; n: number | string }>(distSql("visible_fallback"), [
    "visible_fallback",
    hours,
  ]);

  const traces = new Map<string, string[]>();
  for (const t of tracesRes.rows) {
    const fp = fingerprintOf(t);
    const list = traces.get(fp) ?? [];
    if (list.length < 3 && t.trace_id && !list.includes(t.trace_id)) list.push(t.trace_id);
    traces.set(fp, list);
  }

  const toDist = (rows: { key: string; n: number | string }[]): DistRow[] =>
    rows.map((r) => ({ key: normalizeToken(r.key, "reason"), n: n(r.n) }));

  return {
    rows: agg.rows,
    traces,
    decisions: toDist(decisions.rows),
    jobs: toDist(jobs.rows),
    fallbacks: toDist(fallbacks.rows),
  };
}

function mergeWindows(
  date: string,
  windowHours: number,
  primary: Awaited<ReturnType<typeof queryAggregation>>,
  week: Awaited<ReturnType<typeof queryAggregation>>,
): ReviewAgg {
  const map = new Map<string, FingerprintAgg>();
  const ingest = (pack: Awaited<ReturnType<typeof queryAggregation>>, which: "h24" | "d7") => {
    for (const row of pack.rows) {
      const fp = fingerprintOf(row);
      let cur = map.get(fp);
      if (!cur) {
        cur = {
          fingerprint: fp,
          stage: row.stage,
          code: row.code,
          path: normalizeToken(row.path, "path"),
          reason: normalizeToken(row.reason, "reason"),
          h24: emptyCounts(),
          d7: emptyCounts(),
        };
        map.set(fp, cur);
      }
      cur[which] = toWindowCounts(row, pack.traces.get(fp) ?? cur[which].traces);
    }
  };
  ingest(week, "d7");
  ingest(primary, "h24");
  return {
    date,
    windowHours,
    fingerprints: [...map.values()].sort((a, b) => b.h24.failed - a.h24.failed || b.h24.shown - a.h24.shown),
    decisions: week.decisions,
    jobs: week.jobs,
    fallbacks: week.fallbacks,
  };
}

async function loadFromPg(databaseUrl: string, windowHours: number, date: string): Promise<ReviewAgg> {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    await client.query("START TRANSACTION READ ONLY");
    try {
      const primary = await queryAggregation(client, windowHours);
      const week = await queryAggregation(client, 168);
      return mergeWindows(date, windowHours, primary, week);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}

function repoRootFromMeta(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (path.basename(here) === "scripts") return path.dirname(here);
  if (existsSync(path.join(process.cwd(), "scripts/v5-inbox-broadcast.ts"))) return process.cwd();
  return process.cwd();
}

function applySuccessfulAction(nextState: StateFile, action: PlannedAction, identifier: string, today: string, agg: ReviewAgg): void {
  const row = agg.fingerprints.find((f) => f.fingerprint === action.fingerprint);
  const entry = nextState.fingerprints[action.fingerprint] ?? {
    identifier,
    created_at: today,
    daily: [],
  };
  entry.identifier = identifier;
  if (action.kind === "create") {
    entry.created_at = entry.created_at || today;
    if (row) entry.last_counts = snapshotCounts(row.h24);
  } else if (action.kind === "comment") {
    entry.last_comment_date = today;
    if (row) entry.last_counts = snapshotCounts(row.h24);
  } else if (action.kind === "suggest_close") {
    entry.close_suggested_at = today;
    entry.last_comment_date = today;
  }
  nextState.fingerprints[action.fingerprint] = entry;
}

function helpText(): string {
  return `v5-problem-card-review.ts
  --dry-run              不建单/不评论/不写 state/不发站内信；打印动作与 digest
  --no-tickets           聚合+digest+站内信，不动工单
  --window Nh            主窗口（默认 24h，范围 1h..720h）；7d 窗口始终计算
  --date YYYY-MM-DD      默认今天 CST
  --state-dir DIR        默认 ${DEFAULT_STATE_DIR}
  --container NAME       默认 ${DEFAULT_CONTAINER}
  --project KEY          默认 ${DEFAULT_PROJECT_KEY}
  --env-file PATH        默认 ${DEFAULT_ENV_FILE}（仅当 DATABASE_URL 未设置）
  DATABASE_URL           优先环境变量

退出码: 0 成功; 2 PG 失败; 3 面板不可用; 4 参数错误`;
}

export async function runReview(
  argv: string[] = process.argv.slice(2),
  deps: { execFile?: ExecFileFn; loadAgg?: (url: string, hours: number, date: string) => Promise<ReviewAgg> } = {},
): Promise<number> {
  const execFn = deps.execFile ?? defaultExecFile;
  let opts: CliOptions;
  try {
    opts = parseCli(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT.usage;
  }
  if (opts.help) {
    console.log(helpText());
    return EXIT.ok;
  }

  const databaseUrl = readDatabaseUrl(opts.envFile);
  if (!databaseUrl) {
    console.error("DATABASE_URL missing (env or --env-file)");
    return EXIT.usage;
  }

  let agg: ReviewAgg;
  try {
    agg = deps.loadAgg
      ? await deps.loadAgg(databaseUrl, opts.windowHours, opts.date)
      : await loadFromPg(databaseUrl, opts.windowHours, opts.date);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`PG failed: ${msg}`);
    console.log(JSON.stringify({ ok: false, error: "pg", exit: EXIT.pg }));
    return EXIT.pg;
  }

  let state: StateFile = { fingerprints: {} };
  let stateError: string | undefined;
  if (!opts.dryRun) {
    try {
      state = loadState(opts.stateDir);
    } catch (err) {
      stateError = err instanceof Error ? err.message : String(err);
      console.error(stateError);
      return EXIT.usage;
    }
  } else {
    try {
      state = loadState(opts.stateDir);
    } catch {
      state = { fingerprints: {} };
    }
  }

  const notes: string[] = [];
  let tickets: TicketRef[] = [];
  let projectId: string | undefined;
  let panel: "ok" | "unavailable" | "skipped" = "skipped";
  let exit = EXIT.ok;
  let wroteState = false;

  const skipTickets = opts.dryRun || opts.noTickets;
  if (!skipTickets) {
    const listed = await ocTask(opts.container, buildOcTaskArgs("project-list"), execFn);
    if (listed.status === 3 || listed.status === 4 || listed.status === 1) {
      panel = "unavailable";
      notes.push("面板不可用（oc-task project list 退出 3/4）");
      exit = EXIT.panel;
    } else if (listed.status === 6) {
      notes.push("project list 423 跳过");
      panel = "unavailable";
      exit = EXIT.panel;
    } else {
      const projects = asItems(listed.json);
      const hit = projects.find((p) => p.key === opts.projectKey || p.id === opts.projectKey);
      const id = typeof hit?.id === "string" ? hit.id : undefined;
      if (!id) {
        notes.push(`项目 ${opts.projectKey} 未找到`);
        panel = "unavailable";
        exit = EXIT.panel;
      } else {
        projectId = id;
        const tlist = await ocTask(
          opts.container,
          buildOcTaskArgs("ticket-list", { projectId, label: "problem-card", limit: 200 }),
          execFn,
        );
        if (tlist.status === 3 || tlist.status === 4) {
          panel = "unavailable";
          notes.push("面板不可用（oc-task ticket list 退出 3/4）");
          exit = EXIT.panel;
        } else {
          tickets = asItems(tlist.json)
            .map(ticketFromUnknown)
            .filter((t): t is TicketRef => t != null);
          panel = "ok";
        }
      }
    }
  } else {
    notes.push(opts.dryRun ? "dry-run：跳过 oc-task / 写 state / 站内信 / 容器 digest 复制" : "--no-tickets：跳过工单");
  }

  const planned = nextActions(agg, state, tickets);
  let actions = planned.actions;
  const nextState = planned.nextState;
  if (skipTickets) {
    /* keep planned actions for digest only */
  } else if (panel !== "ok") {
    actions = [];
  }

  const title = inboxTitle(agg);
  let digest = renderDigest(agg, skipTickets ? planned.actions : actions, notes);
  if (opts.dryRun) {
    notes.push(`将发送站内信 title=${title} length=${Math.min(digest.length, 2000)}`);
    digest = renderDigest(agg, planned.actions, notes);
  }

  if (!opts.dryRun) {
    const digestFile = path.join(opts.stateDir, `digest-${opts.date}.md`);
    atomicWriteFile(digestFile, digest);
    const copy = dockerCopyDigestArgv(opts.container, opts.date);
    const copied = await execFn(copy.file, copy.argv, { input: digest });
    if (copied.status !== 0) {
      notes.push(`容器 digest 复制失败（docker exit ${copied.status}），宿主 digest 已写`);
    }
  }

  if (!skipTickets && panel === "ok" && projectId) {
    for (const action of [...actions]) {
      if (action.kind === "create") {
        const run = () =>
          ocTask(
            opts.container,
            buildOcTaskArgs("ticket-create", {
              projectId,
              title: action.title,
              body: action.body,
            }),
            execFn,
          );
        const res = await withRetry409(run);
        if (res.status === 3 || res.status === 4) {
          notes.push(`面板不可用（create ${action.fingerprint} 退出 ${res.status}）`);
          panel = "unavailable";
          exit = EXIT.panel;
          break;
        }
        if (res.status === 6) {
          notes.push(`create ${action.fingerprint} 423 跳过`);
          continue;
        }
        if (res.status !== 0) {
          notes.push(`create ${action.fingerprint} 退出 ${res.status}`);
          continue;
        }
        const ticket = (res.json?.ticket && typeof res.json.ticket === "object"
          ? (res.json.ticket as Record<string, unknown>)
          : res.json) as Record<string, unknown> | null;
        const ident = typeof ticket?.identifier === "string" ? ticket.identifier : "";
        if (!ident) {
          notes.push(`create ${action.fingerprint} 未返回 identifier，忽略`);
          continue;
        }
        applySuccessfulAction(nextState, action, ident, opts.date, agg);
      } else {
        const run = () =>
          ocTask(
            opts.container,
            buildOcTaskArgs("ticket-comment", { identifier: action.identifier, body: action.body }),
            execFn,
          );
        const res = await withRetry409(run);
        if (res.status === 3 || res.status === 4) {
          notes.push(`面板不可用（comment ${action.identifier} 退出 ${res.status}）`);
          panel = "unavailable";
          exit = EXIT.panel;
          break;
        }
        if (res.status === 6) {
          notes.push(`comment ${action.identifier} 423 跳过`);
          continue;
        }
        if (res.status !== 0) {
          notes.push(`comment ${action.identifier} 退出 ${res.status}`);
          continue;
        }
        applySuccessfulAction(nextState, action, action.identifier, opts.date, agg);
      }
    }
    if (exit !== EXIT.panel) {
      atomicWriteFile(path.join(opts.stateDir, "state.json"), `${JSON.stringify(nextState, null, 2)}\n`);
      wroteState = true;
    }
  }

  if (!opts.dryRun && exit !== EXIT.pg) {
    const body = `${digest.slice(0, 2000)}\n\n容器内路径: ${digestContainerPath(opts.date)}\n`;
    const bodyFile = path.join(tmpdir(), `problem-card-inbox-${opts.date}-${process.pid}.md`);
    try {
      writeFileSync(bodyFile, body, "utf8");
      const inboxScript = path.join(repoRootFromMeta(), "scripts/v5-inbox-broadcast.ts");
      const tsxBin = path.join(repoRootFromMeta(), "node_modules/.bin/tsx");
      const file = existsSync(tsxBin) ? tsxBin : "npx";
      const inboxArgv = existsSync(tsxBin)
        ? [inboxScript, "--title", title, "--body-file", bodyFile, "--user", INBOX_UID, "--yes"]
        : ["tsx", inboxScript, "--title", title, "--body-file", bodyFile, "--user", INBOX_UID, "--yes"];
      const sent = await execFn(file, inboxArgv, {
        cwd: repoRootFromMeta(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
      });
      if (sent.status !== 0) {
        notes.push(`站内信发送失败 exit=${sent.status}`);
      }
    } finally {
      try {
        unlinkSync(bodyFile);
      } catch {
        /* ignore */
      }
    }
  }

  const finalDigest = notes.length && !opts.dryRun ? renderDigest(agg, skipTickets ? planned.actions : actions, notes) : digest;
  if (!opts.dryRun && notes.length) {
    atomicWriteFile(path.join(opts.stateDir, `digest-${opts.date}.md`), finalDigest);
  }

  const failed = agg.fingerprints.reduce((s, f) => s + f.h24.failed, 0);
  const recovered = agg.fingerprints.reduce((s, f) => s + f.h24.recovered, 0);
  const shown = agg.fingerprints.reduce((s, f) => s + f.h24.shown, 0);
  const summary = {
    ok: exit === EXIT.ok,
    dryRun: opts.dryRun,
    date: opts.date,
    windowHours: opts.windowHours,
    fingerprints: agg.fingerprints.filter((f) => f.h24.shown > 0).length,
    shown,
    failed,
    recovered,
    recoveryRate: recoveryRate(recovered, failed),
    actions: (opts.dryRun || opts.noTickets ? planned.actions : actions).map((a) => ({
      kind: a.kind,
      fingerprint: a.fingerprint,
      identifier: a.kind === "create" ? undefined : a.identifier,
    })),
    panel,
    wroteState,
    digestBytes: finalDigest.length,
    exit,
  };
  console.log(JSON.stringify(summary));
  if (opts.dryRun) {
    console.log("");
    console.log(finalDigest);
  }
  return exit;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun() || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  runReview()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
