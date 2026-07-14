import type { SettingRow } from "./types";

// 按 key 前缀（第一个 `.` 或 `_` 之前的段）把设置项重组为若干分区卡。
// 纯展示重组，不改任何保存语义（value/description/端点均不受影响）。

/** 取 key 的前缀段：`signup_bonus` → `signup`，`billing.tax` → `billing`，无分隔符 → ""。 */
export function settingPrefix(key: string): string {
  const m = /^([A-Za-z0-9]+)[._]/.exec(key);
  return m ? m[1] : "";
}

/** 已知前缀的中文标注（未知前缀原样展示前缀本身）。仅影响分区标题文案。 */
const GROUP_LABELS: Record<string, string> = {
  signup: "注册",
  billing: "计费",
  risk: "风控",
  team: "团队",
  cron: "定时任务",
  provider: "服务商",
  codex: "Codex",
  egress: "出站代理",
  market: "市场",
  marketplace: "市场",
  org: "企业",
  session: "会话",
  delegate: "委派",
  review: "审查",
  rate: "限流",
  topup: "充值",
  memory: "记忆",
  skill: "技能",
  research: "科研",
  auto: "自动化",
};

const OTHER_ID = "__other__";

export type SettingGroup = {
  /** 分区稳定 id（前缀或 __other__），用作 React key。 */
  id: string;
  /** 分区标题：已知前缀用中文标注，未知前缀用前缀本身，无前缀用「其它」。 */
  title: string;
  /** 分区副标题：暴露原始前缀命名空间 + 数量。 */
  hint: string;
  rows: SettingRow[];
};

/**
 * 按前缀分组，保持前缀首次出现顺序；无前缀项统一归入「其它」并置于末尾。
 * 组内保持原始行顺序（后端返回序）。
 */
export function groupSettings(rows: SettingRow[]): SettingGroup[] {
  const buckets = new Map<string, SettingRow[]>();
  for (const r of rows) {
    const id = settingPrefix(r.key) || OTHER_ID;
    const list = buckets.get(id);
    if (list) list.push(r);
    else buckets.set(id, [r]);
  }

  const groups: SettingGroup[] = [];
  for (const [id, groupRows] of buckets) {
    if (id === OTHER_ID) continue; // 「其它」最后统一追加
    const label = GROUP_LABELS[id] ?? id;
    groups.push({
      id,
      title: label,
      hint: `前缀 ${id}_ · ${groupRows.length} 项`,
      rows: groupRows,
    });
  }

  const other = buckets.get(OTHER_ID);
  if (other && other.length > 0) {
    groups.push({
      id: OTHER_ID,
      title: "其它",
      hint: `无明显前缀 · ${other.length} 项`,
      rows: other,
    });
  }

  return groups;
}
