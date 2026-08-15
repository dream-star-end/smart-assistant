// migrationOrder.ts — 迁移「顺序依赖」声明的单一权威解析与校验。
//
// 为什么需要它(2026-08-15 并行开发审计):
//   仓库同时挂着 80+ worktree,迁移是"每人新建一个文件"的形态 —— git 永远不报冲突,
//   但 migrate.ts 的 out-of-order 完整性门要求「任何未应用版本严格 > max(applied)」。
//   两支分支各占 0218 / 0219 时,**让号消除不了顺序依赖**:完整性门要的就是严格递增,
//   小号那支永远必须先 apply。让号只是把约束翻个面,而不是解决它。
//
//   更糟的是失败点落在无辜的一方:先 apply 了 0219,后来者的 0218 会被判 out-of-order,
//   于是**整个迁移运行 fail-closed**,卡死的是那支什么都没做错的分支的部署。
//
// 既然消除不了,就让它可声明、可断言、可被 CI 检查。迁移文件头部注释块里写:
//
//   -- order-dependency: 0218_public_zai_glm53
//   -- order-dependency: none   (0218 由 feat/x 保留;若该分支放弃,本支可独立 apply)
//
// 设计取舍:
//   * 声明落在**各自的 .sql 文件头**,不引入新的全局单例清单 —— 那种清单本身就是
//     并行会话的冲突源(release-metadata.json 已经是一个)。
//   * 解析只看第一条非注释非空行之前的头部块。既有的 `-- no-transaction` 标记用
//     `/^--\s*no-transaction\b/im` 扫全文,本模块**故意更严**:埋在 SQL 中段的声明
//     容易在后续编辑里被连带删掉而无人察觉,而这条声明一旦丢失就会静默失去保护。
//   * 本模块是纯函数、无 IO、无 pg 依赖,两个消费者共用,禁止各自再实现一份:
//       - packages/commercial/src/db/migrate.ts —— apply 前 fail-closed 断言
//       - scripts/check-migration-order.ts      —— PR 期编号/声明漂移门

/** 合法 version(= 文件名去 `.sql`)。4 位数字前缀 + 小写 snake_case。 */
export const MIGRATION_VERSION_RE = /^\d{4}_[a-z0-9][a-z0-9_]*$/;

/** 头部声明行:`-- order-dependency: <value>`。 */
const ORDER_DEPENDENCY_LINE_RE = /^--\s*order-dependency\s*:\s*(.*)$/i;

export class OrderDependencySyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderDependencySyntaxError";
  }
}

export interface OrderDependencyDeclaration {
  /** 是否出现过 `-- order-dependency:` 行。未声明与声明 none 是两种状态,不能混。 */
  declared: boolean;
  /** 必须先于本迁移 apply 的 version 列表。显式 `none` → 空数组。 */
  dependsOn: string[];
  /** 声明行号(1-based),仅用于报错定位。 */
  lines: number[];
}

/**
 * 解析一支迁移 SQL 的头部顺序依赖声明。
 *
 * 只扫描头部注释块:从第一行开始,遇到第一条既非空行也非 `--` 注释的行即停止。
 * 这样声明不可能被埋在 SQL 中段(那种位置的注释容易被后续编辑连带删掉而无人察觉)。
 *
 * @throws OrderDependencySyntaxError 值非法、或把 `none` 与具体 version 混写。
 */
export function parseOrderDependency(sql: string): OrderDependencyDeclaration {
  const out: OrderDependencyDeclaration = { declared: false, dependsOn: [], lines: [] };
  let sawNone = false;

  const lines = sql.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("--")) break; // 头部注释块结束

    const m = ORDER_DEPENDENCY_LINE_RE.exec(trimmed);
    if (!m) continue;

    const lineNo = i + 1;
    out.declared = true;
    out.lines.push(lineNo);

    // 值形如 `0218_public_zai_glm53` 或 `none`,允许后面跟自由文本理由:
    //   `-- order-dependency: none  (0218 由 feat/x 保留)`
    const value = (m[1] ?? "").trim();
    const token = value.split(/[\s,(#]/, 1)[0] ?? "";

    if (token === "") {
      throw new OrderDependencySyntaxError(
        `line ${lineNo}: order-dependency 声明为空;写具体 version 或 \`none <理由>\``,
      );
    }
    if (token.toLowerCase() === "none") {
      sawNone = true;
      continue;
    }
    if (!MIGRATION_VERSION_RE.test(token)) {
      throw new OrderDependencySyntaxError(
        `line ${lineNo}: order-dependency 值 \`${token}\` 不是合法 version(应形如 0218_public_zai_glm53 或 none)`,
      );
    }
    out.dependsOn.push(token);
  }

  if (sawNone && out.dependsOn.length > 0) {
    throw new OrderDependencySyntaxError(
      `line ${out.lines.join(", ")}: order-dependency 同时声明了 none 与具体依赖,语义矛盾`,
    );
  }
  return out;
}

export interface PendingMigrationSource {
  /** 文件名去 `.sql`。 */
  version: string;
  /** 文件全文。只需头部,但调用方通常已有全文。 */
  sql: string;
}

/**
 * 校验待应用迁移的顺序依赖。纯函数,返回违规描述列表(空 = 通过)。
 *
 * @param pending      本次将要 apply 的迁移(已 applied 的不再校验:它们的依赖在
 *                     当时已被满足,事后重放校验只会把历史噪声变成新的 fail-closed)。
 * @param knownVersions 已 applied ∪ 迁移目录内存在的全部 version。目录内但未 applied
 *                     的依赖不算违规 —— 它排序在前,同一次运行里会先被 apply。
 */
export function verifyOrderDependencies(
  pending: ReadonlyArray<PendingMigrationSource>,
  knownVersions: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];
  for (const { version, sql } of pending) {
    let decl: OrderDependencyDeclaration;
    try {
      decl = parseOrderDependency(sql);
    } catch (err) {
      violations.push(`${version}: ${(err as Error).message}`);
      continue;
    }
    for (const dep of decl.dependsOn) {
      if (dep >= version) {
        violations.push(
          `${version}: 声明依赖 ${dep},但依赖必须是更小的编号(顺序门只保证「小号先 apply」)`,
        );
        continue;
      }
      if (!knownVersions.has(dep)) {
        violations.push(
          `${version}: 声明必须先 apply ${dep},但它既不在 schema_migrations 也不在迁移目录 —— ` +
            `占号的那支分支尚未合并。先合并并 apply ${dep},或在本支分支放弃时改写声明为 none。`,
        );
      }
    }
  }
  return violations;
}
