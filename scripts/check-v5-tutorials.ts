#!/usr/bin/env tsx
/**
 * v5 教程防漂移门禁。
 *
 * `check`（默认）只读：验证能力注册表、教程、真实入口标记、交互入口覆盖、媒体规格，
 * 并要求当前语义快照与仓库内 tutorial-sync.json 完全一致。
 *
 * `accept` 是显式维护动作：功能语义变化时，正常模式要求同步提高教程内容版本或媒体版本；
 * 仅源代码重构可用 `--source-only --note "..."` 接受，但会追加不可覆盖的 JSONL 审计记录。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import process from "node:process";
import ts from "typescript";
import {
  PRODUCT_CAPABILITIES,
  PRODUCT_CAPABILITY_LIST,
  type ProductFeatureId,
} from "../packages/web-react/src/lib/productCapabilities.ts";
import {
  TUTORIAL_CATALOG_SCHEMA,
  TUTORIAL_MEDIA,
  TUTORIAL_TOPICS,
  type TutorialMediaKey,
} from "../packages/web-react/src/lib/tutorialCatalog.ts";
import {
  TUTORIAL_CASES,
  TUTORIAL_CASE_IDS,
} from "../packages/web-react/src/lib/tutorialCaseCatalog.ts";

const ROOT = resolve(import.meta.dirname, "..");
const WEB_ROOT = join(ROOT, "packages/web-react");
const SRC_ROOT = join(WEB_ROOT, "src");
const MANIFEST_PATH = join(WEB_ROOT, "tutorial-sync.json");
const HISTORY_PATH = join(WEB_ROOT, "tutorial-sync-history.jsonl");
const HISTORY_ANCHOR_PATH = join(WEB_ROOT, "tutorial-sync-history-head.json");
const CAPTURE_PROVENANCE_PATH = join(
  WEB_ROOT,
  "tutorial-capture-provenance.json",
);
const HISTORY_REPO_PATH = relative(ROOT, HISTORY_PATH).replaceAll("\\", "/");
const MAX_TOTAL_MEDIA_BYTES = 6 * 1024 * 1024;
const MAX_MEDIA_PAIR_BYTES = 768 * 1024;
const REQUIRED_WIDTH = 960;
const REQUIRED_HEIGHT = 540;
const MIN_DURATION_SECONDS = 2;
const MAX_DURATION_SECONDS = 12;

type MediaSnapshot = {
  version: number;
  poster: string;
  video: string;
  caption: string;
  posterSha256: string;
  videoSha256: string;
  posterBytes: number;
  videoBytes: number;
  width: number;
  height: number;
  durationSeconds: number;
  codec: "VP8";
};

type CapabilitySnapshot = {
  contentVersion: number;
  contentHash: string;
  registryHash: string;
  sourceHash: string;
  mediaKey: TutorialMediaKey;
  mediaVersion: number;
  mediaHash: string;
};

type CaseSnapshot = {
  contentVersion: number;
  contentHash: string;
};

type TutorialSnapshot = {
  schema: 1;
  catalogSchema: number;
  capabilities: Record<string, CapabilitySnapshot>;
  cases: Record<string, CaseSnapshot>;
  media: Record<TutorialMediaKey, MediaSnapshot>;
};

type TutorialAudit = {
  schema: 1;
  sequence: number;
  previousAuditSha256: string | null;
  at: string;
  actor: string;
  mode: "bootstrap" | "source-only" | "tutorial-sync";
  note: string;
  sourceChanged: string[];
  registryChanged: string[];
  contentChanged: string[];
  mediaChanged: string[];
  /** Added after the case-first tutorial catalog; absent on historical rows. */
  caseChanged?: string[];
  added: string[];
  retired: string[];
  snapshotSha256: string;
};

type TutorialHistoryAnchor = {
  schema: 1;
  entries: number;
  historySha256: string;
  headAuditSha256: string;
};

type Marker = {
  id: ProductFeatureId;
  file: string;
  line: number;
  semantic: string;
};

type CaptureActionTrace = {
  step: string;
  selector: string;
  tag: string;
  label: string;
  expectedFeatureId: ProductFeatureId;
  matchedFeatureId: string | null;
  matchedControl: boolean;
  dialogTitle: string | null;
  activeTabs: string[];
  assertions: string[];
};

type CaptureScenario = {
  mediaVersion: number;
  caption: string;
  stages: Array<{ label: string; dHash: string }>;
  actions: CaptureActionTrace[];
  assertions: string[];
  poster: { sha256: string; bytes: number };
  video: { sha256: string; bytes: number };
};

type CaptureProvenance = {
  schema: number;
  pipelineVersion: number;
  generatedAt: string;
  sourceCommit: string;
  sourceTreeHash: string;
  productionEntry: string;
  fixtureBoundary: string;
  networkPolicy: string;
  toolchain: Record<string, unknown>;
  scenarios: Record<string, CaptureScenario>;
};

const FEATURE_IDS = new Set(
  PRODUCT_CAPABILITY_LIST.map((feature) => feature.id),
);
const FEATURE_BY_KEY = new Map(
  Object.entries(PRODUCT_CAPABILITIES).map(([key, value]) => [
    key,
    value.id as ProductFeatureId,
  ]),
);
const printer = ts.createPrinter({
  removeComments: true,
  newLine: ts.NewLineKind.LineFeed,
});

function fail(message: string): never {
  throw new Error(message);
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
}

function semanticNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  return printer
    .printNode(ts.EmitHint.Unspecified, node, sourceFile)
    .replace(/\s+/g, " ")
    .trim();
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      // 教程本身与离线媒体舞台不能反过来充当“真实产品入口”。
      if (path === join(SRC_ROOT, "components/tutorial")) continue;
      out.push(...sourceFiles(path));
    } else if (
      (extname(name) === ".tsx" || extname(name) === ".ts") &&
      name !== "tutorialCapture.tsx" &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test.tsx") &&
      !name.endsWith(".spec.ts") &&
      !name.endsWith(".spec.tsx")
    ) {
      out.push(path);
    }
  }
  return out.sort();
}

function jsxName(node: ts.JsxTagNameExpression): string {
  return node.getText();
}

function jsxAttribute(
  node: ts.JsxOpeningLikeElement,
  name: string,
): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function featureIdFromExpression(
  expression: ts.Expression | undefined,
): ProductFeatureId | null {
  if (!expression) return null;
  if (ts.isStringLiteralLike(expression)) {
    return FEATURE_IDS.has(expression.text)
      ? (expression.text as ProductFeatureId)
      : null;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "id" &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "PRODUCT_CAPABILITIES"
  ) {
    return FEATURE_BY_KEY.get(expression.expression.name.text) ?? null;
  }
  return null;
}

function featureIdFromAttribute(
  attribute: ts.JsxAttribute,
): ProductFeatureId | null {
  if (!attribute.initializer) return null;
  if (ts.isStringLiteral(attribute.initializer)) {
    return featureIdFromExpression(attribute.initializer);
  }
  if (ts.isJsxExpression(attribute.initializer)) {
    return featureIdFromExpression(attribute.initializer.expression);
  }
  return null;
}

function markerSlice(opening: ts.JsxOpeningLikeElement): ts.Node {
  return ts.isJsxOpeningElement(opening) && ts.isJsxElement(opening.parent)
    ? opening.parent
    : opening;
}

function isInteractive(opening: ts.JsxOpeningLikeElement): boolean {
  const name = jsxName(opening.tagName);
  if (["button", "input", "select", "textarea", "summary"].includes(name))
    return true;
  if (name === "a")
    return !!jsxAttribute(opening, "href") || !!jsxAttribute(opening, "role");
  return ["Button", "IconButton", "Switch"].includes(name);
}

function validateScope(
  scope: ts.JsxOpeningLikeElement,
  sourceFile: ts.SourceFile,
  errors: string[],
): void {
  const root = markerSlice(scope);
  const visit = (node: ts.Node): void => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node !== scope
    ) {
      if (isInteractive(node)) {
        const feature = jsxAttribute(node, "data-product-feature");
        const control = jsxAttribute(node, "data-product-control");
        if (!feature && !control) {
          const pos = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          errors.push(
            `${relative(ROOT, sourceFile.fileName)}:${pos.line + 1} <${jsxName(node.tagName)}> 位于 data-product-entry-scope 内，但没有 data-product-feature 或 data-product-control`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
}

function collectMarkers(): Marker[] {
  const markers: Marker[] = [];
  const errors: string[] = [];
  const scopes = new Set<string>();

  for (const file of sourceFiles(SRC_ROOT)) {
    const sourceText = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const addMarker = (id: ProductFeatureId, node: ts.Node): void => {
      const pos = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      markers.push({
        id,
        file: relative(ROOT, file),
        line: pos.line + 1,
        semantic: semanticNode(node, sourceFile),
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const featureAttribute = jsxAttribute(node, "data-product-feature");
        if (featureAttribute) {
          const id = featureIdFromAttribute(featureAttribute);
          if (!id) {
            const pos = sourceFile.getLineAndCharacterOfPosition(
              node.getStart(sourceFile),
            );
            // Tabs 的 `it.featureId` 是渲染器；真实 id 由各 items 对象字面量登记。
            if (
              !["{it.featureId}", "{featureId}"].includes(
                featureAttribute.initializer?.getText() ?? "",
              )
            ) {
              errors.push(
                `${relative(ROOT, file)}:${pos.line + 1} data-product-feature 必须引用 PRODUCT_CAPABILITIES.<key>.id 或稳定 id 字面量`,
              );
            }
          } else {
            addMarker(id, markerSlice(node));
          }
        }

        const featureProp = jsxAttribute(node, "featureId");
        if (featureProp) {
          const id = featureIdFromAttribute(featureProp);
          if (id) addMarker(id, markerSlice(node));
        }

        const scopeAttribute = jsxAttribute(node, "data-product-entry-scope");
        if (scopeAttribute) {
          const value =
            scopeAttribute.initializer?.getText().replace(/^['"]|['"]$/g, "") ??
            "";
          if (!value)
            errors.push(
              `${relative(ROOT, file)}: data-product-entry-scope 必须有稳定名称`,
            );
          else if (scopes.has(value))
            errors.push(`data-product-entry-scope 重名：${value}`);
          else scopes.add(value);
          validateScope(node, sourceFile, errors);
        }
      }

      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText() === "featureId"
      ) {
        const id = featureIdFromExpression(node.initializer);
        if (id)
          addMarker(
            id,
            ts.isObjectLiteralExpression(node.parent) ? node.parent : node,
          );
        else if (!node.initializer.getText().includes(".featureId")) {
          const pos = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          errors.push(
            `${relative(ROOT, file)}:${pos.line + 1} featureId 必须引用 PRODUCT_CAPABILITIES.<key>.id`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  if (errors.length) fail(`教程入口覆盖检查失败：\n- ${errors.join("\n- ")}`);
  return markers;
}

function validateCatalog(markers: Marker[]): void {
  const registryIds = [...FEATURE_IDS].sort();
  const topicIds = Object.keys(TUTORIAL_TOPICS).sort();
  if (stable(registryIds) !== stable(topicIds)) {
    fail(
      `能力注册表与教程目录不一一对应：registry=${registryIds.join(",")} topics=${topicIds.join(",")}`,
    );
  }

  const targetIds = new Set(markers.map((marker) => marker.id));
  const missingTargets = registryIds.filter(
    (id) => !targetIds.has(id as ProductFeatureId),
  );
  if (missingTargets.length) {
    fail(
      `以下能力没有真实 UI 目标标记 data-product-feature/featureId：${missingTargets.join(", ")}`,
    );
  }

  for (const feature of PRODUCT_CAPABILITY_LIST) {
    const id = feature.id as ProductFeatureId;
    const topic = TUTORIAL_TOPICS[id];
    if (topic.featureId !== id) fail(`${id}: topic.featureId 不一致`);
    if (!Number.isInteger(topic.contentVersion) || topic.contentVersion < 1) {
      fail(`${id}: contentVersion 必须是正整数`);
    }
    if (topic.intro.length < 70 || topic.outcome.length < 20)
      fail(`${id}: 介绍或学习结果过短`);
    if (
      topic.scenarios.length < 3 ||
      topic.steps.length < 4 ||
      topic.tips.length < 2
    ) {
      fail(`${id}: 教程至少需要 3 个场景、4 个步骤、2 条建议`);
    }
    if (topic.cautions.length < 1) fail(`${id}: 至少需要 1 条风险/注意事项`);
    const related = new Set(topic.related);
    if (related.size !== topic.related.length || related.has(id))
      fail(`${id}: related 必须唯一且不能指向自身`);
    for (const relatedId of related)
      if (!FEATURE_IDS.has(relatedId)) fail(`${id}: 未知相关教程 ${relatedId}`);
    if (!(topic.media in TUTORIAL_MEDIA))
      fail(`${id}: 未知媒体 ${topic.media}`);
    if (
      feature.destination.kind === "focus" &&
      !FEATURE_IDS.has(feature.destination.target)
    ) {
      fail(`${id}: focus 目标 ${feature.destination.target} 未登记`);
    }
  }
  const usedMedia = new Set(
    Object.values(TUTORIAL_TOPICS).map((topic) => topic.media),
  );
  const mediaIds = Object.keys(TUTORIAL_MEDIA).sort();
  if (stable(mediaIds) !== stable(registryIds)) {
    fail(
      `媒体目录必须与 ${FEATURE_IDS.size} 个能力稳定 ID 一一对应：media=${mediaIds.join(",")}`,
    );
  }
  for (const id of registryIds as ProductFeatureId[]) {
    const topic = TUTORIAL_TOPICS[id];
    const media = TUTORIAL_MEDIA[id];
    if (topic.media !== id)
      fail(`${id}: 禁止复用其他章节媒体，topic.media 必须等于 feature id`);
    if (
      media.poster !== `/tutorials/${id}.webp` ||
      media.video !== `/tutorials/${id}.webm`
    ) {
      fail(`${id}: 媒体文件名必须直接使用稳定 feature id`);
    }
  }
  const unusedMedia = Object.keys(TUTORIAL_MEDIA).filter(
    (key) => !usedMedia.has(key as TutorialMediaKey),
  );
  if (unusedMedia.length)
    fail(`存在未被任何教程引用的媒体：${unusedMedia.join(", ")}`);
}

const PUBLIC_MESSAGE_ROLES = new Set([
  "user",
  "assistant",
  "thinking",
  "tool",
  "agent-group",
  "plan",
  "goal",
  "permission",
  "delegate-progress",
  "runtime-event",
  "system",
]);

const FORBIDDEN_PUBLIC_IDENTITY_KEY =
  /^(?:traceId|requestId|sessionKey|sessionId|peerId|containerId|uid|_turnTapeId|_clientMessageId|_turnOwnerId|_turnKey|_continuationOfTurnKey|_continuationOfClientMessageId|_recoveryOfClientMessageId|_automaticRetryRootClientMessageId|_automaticRecoveryRootClientMessageId|_idem)$/i;

const FORBIDDEN_PUBLIC_TEXT =
  /claudeai\.chat|\/root\/|\/home\/(?:agent|openclaude)\/|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]{20,}\.|\b(?:trace|request|session|peer|container)[-_ ]?id\b/i;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} 必须是 JSON object`);
  return value as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const result = value[field];
  if (typeof result !== "string" || !result.trim())
    fail(`${label}.${field} 必须是非空字符串`);
  return result;
}

function integerField(
  value: Record<string, unknown>,
  field: string,
  label: string,
): number {
  const result = value[field];
  if (!Number.isSafeInteger(result) || (result as number) < 0)
    fail(`${label}.${field} 必须是非负安全整数`);
  return result as number;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (stable(actual) !== stable(wanted))
    fail(`${label} 字段不符：${actual.join(", ")}`);
}

function parseJsonFile(
  path: string,
  label: string,
): {
  bytes: Buffer;
  value: unknown;
} {
  if (!existsSync(path)) fail(`${label} 文件不存在`);
  const bytes = readFileSync(path);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    fail(`${label} 不是有效 JSON`);
  }
}

function assertPublicValue(value: unknown, label: string): void {
  if (typeof value === "string") {
    if (FORBIDDEN_PUBLIC_TEXT.test(value))
      fail(`${label} 含禁止公开的身份、路径或凭据`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertPublicValue(entry, `${label}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PUBLIC_IDENTITY_KEY.test(key))
      fail(`${label}.${key} 是禁止公开的生产身份字段`);
    assertPublicValue(entry, `${label}.${key}`);
  }
}

function validatePublicMessage(
  raw: unknown,
  caseId: string,
  ordinal: number,
): { id: string; ts: number } {
  const message = record(raw, `${caseId}: message ${ordinal}`);
  const id = stringField(message, "id", `${caseId}: message ${ordinal}`);
  if (!/^(?:msg|tutorial)-[a-z0-9][a-z0-9-]*$/.test(id))
    fail(`${caseId}: message ${ordinal} 必须使用脱敏公共 ID`);
  const role = stringField(message, "role", `${caseId}: message ${ordinal}`);
  if (!PUBLIC_MESSAGE_ROLES.has(role))
    fail(`${caseId}: message ${ordinal} role 无效`);
  if (typeof message.text !== "string")
    fail(`${caseId}: message ${ordinal}.text 必须是字符串`);
  const ts = integerField(message, "ts", `${caseId}: message ${ordinal}`);
  const media = message._media;
  if (media !== undefined) {
    if (!Array.isArray(media))
      fail(`${caseId}: message ${ordinal}._media 必须是数组`);
    for (const [index, entry] of media.entries()) {
      const item = record(entry, `${caseId}: media ${ordinal}/${index}`);
      if ("base64" in item || "localSrc" in item || item.hidden === true)
        fail(`${caseId}: 公开媒体不得内嵌 base64、blob 或隐藏附件`);
      const url = stringField(
        item,
        "url",
        `${caseId}: media ${ordinal}/${index}`,
      );
      if (!url.startsWith(`/tutorials/cases/${caseId}/media/`))
        fail(`${caseId}: 公开媒体必须绑定当前案例的同源静态目录`);
    }
  }
  assertPublicValue(message, `${caseId}: message ${ordinal}`);
  return { id, ts };
}

type ValidatedReplayManifest = {
  bytes: Buffer;
  messageCount: number;
  messages: unknown[];
};

function validateReplayManifest(
  caseId: string,
  messagesPath: string,
): ValidatedReplayManifest {
  const expectedManifestPath = `/tutorials/cases/${caseId}/messages-manifest.json`;
  if (messagesPath !== expectedManifestPath)
    fail(`${caseId}: replay manifest 路径必须绑定案例 ID`);
  const parsed = parseJsonFile(
    join(WEB_ROOT, "public", messagesPath),
    `${caseId}: replay manifest`,
  );
  const manifest = record(parsed.value, `${caseId}: replay manifest`);
  exactKeys(
    manifest,
    ["schemaVersion", "caseId", "messageCount", "pages"],
    `${caseId}: replay manifest`,
  );
  if (manifest.schemaVersion !== 1 || manifest.caseId !== caseId)
    fail(`${caseId}: replay manifest schema/caseId 不一致`);
  const messageCount = integerField(
    manifest,
    "messageCount",
    `${caseId}: replay manifest`,
  );
  if (
    messageCount < 2 ||
    !Array.isArray(manifest.pages) ||
    manifest.pages.length < 1
  )
    fail(`${caseId}: replay manifest 缺少完整分页`);

  const messages: unknown[] = [];
  const ids = new Set<string>();
  let lastTs = -1;
  for (const [pageIndex, rawPageMeta] of manifest.pages.entries()) {
    const pageMeta = record(rawPageMeta, `${caseId}: page meta ${pageIndex}`);
    exactKeys(
      pageMeta,
      ["path", "sha256", "bytes", "messageCount", "startOrdinal"],
      `${caseId}: page meta ${pageIndex}`,
    );
    const pageNumber = String(pageIndex + 1).padStart(4, "0");
    const pagePath = stringField(
      pageMeta,
      "path",
      `${caseId}: page meta ${pageIndex}`,
    );
    if (pagePath !== `/tutorials/cases/${caseId}/messages-${pageNumber}.json`)
      fail(`${caseId}: replay 页路径或顺序不正确`);
    const expectedSha = stringField(
      pageMeta,
      "sha256",
      `${caseId}: page meta ${pageIndex}`,
    );
    if (!/^[a-f0-9]{64}$/.test(expectedSha))
      fail(`${caseId}: replay 页 SHA-256 无效`);
    const expectedBytes = integerField(
      pageMeta,
      "bytes",
      `${caseId}: page meta ${pageIndex}`,
    );
    const expectedCount = integerField(
      pageMeta,
      "messageCount",
      `${caseId}: page meta ${pageIndex}`,
    );
    const startOrdinal = integerField(
      pageMeta,
      "startOrdinal",
      `${caseId}: page meta ${pageIndex}`,
    );
    if (startOrdinal !== messages.length || expectedCount < 1)
      fail(`${caseId}: replay 页游标不连续`);
    const pageParsed = parseJsonFile(
      join(WEB_ROOT, "public", pagePath),
      `${caseId}: replay page ${pageIndex}`,
    );
    if (
      pageParsed.bytes.length !== expectedBytes ||
      sha256(pageParsed.bytes) !== expectedSha
    )
      fail(`${caseId}: replay 页字节或哈希不一致`);
    const page = record(
      pageParsed.value,
      `${caseId}: replay page ${pageIndex}`,
    );
    exactKeys(
      page,
      ["schemaVersion", "caseId", "pageIndex", "startOrdinal", "messages"],
      `${caseId}: replay page ${pageIndex}`,
    );
    if (
      page.schemaVersion !== 1 ||
      page.caseId !== caseId ||
      page.pageIndex !== pageIndex ||
      page.startOrdinal !== startOrdinal ||
      !Array.isArray(page.messages) ||
      page.messages.length !== expectedCount
    ) {
      fail(`${caseId}: replay 页 schema、案例、游标或计数不一致`);
    }
    for (const rawMessage of page.messages) {
      const validated = validatePublicMessage(
        rawMessage,
        caseId,
        messages.length,
      );
      if (ids.has(validated.id)) fail(`${caseId}: replay message ID 重复`);
      if (validated.ts < lastTs) fail(`${caseId}: replay 时间顺序倒退`);
      ids.add(validated.id);
      lastTs = validated.ts;
      messages.push(rawMessage);
    }
  }
  if (messages.length !== messageCount)
    fail(`${caseId}: replay manifest 总消息数不一致`);
  assertPublicValue(manifest, `${caseId}: replay manifest`);
  return { bytes: parsed.bytes, messageCount, messages };
}

function validateVerifiedEvidence(item: (typeof TUTORIAL_CASES)[number]): void {
  const caseId = item.id;
  const replay = record(item.replay, `${caseId}: replay`);
  const messagesPath = stringField(replay, "messagesPath", `${caseId}: replay`);
  const checkReportPath = stringField(
    replay,
    "checkReport",
    `${caseId}: replay`,
  );
  if (checkReportPath !== `/tutorials/cases/${caseId}/checks.json`)
    fail(`${caseId}: checks 路径必须绑定案例 ID`);
  const provenance = record(replay.provenance, `${caseId}: provenance`);
  const runIds = provenance.runIds;
  if (
    provenance.repeatRuns !== 3 ||
    !Array.isArray(runIds) ||
    runIds.length !== 3 ||
    stable(runIds) !== stable(["run-1", "run-2", "run-3"]) ||
    new Set(runIds).size !== 3 ||
    !/^[a-f0-9]{64}$/.test(String(provenance.inputSha256)) ||
    !/^[a-f0-9]{64}$/.test(String(provenance.messagesSha256)) ||
    !Number.isFinite(Date.parse(String(provenance.capturedAt)))
  ) {
    fail(`${caseId}: provenance 缺少三次独立运行或完整哈希证据`);
  }
  for (const field of ["release", "agentId", "modelId", "engine"] as const) {
    stringField(provenance, field, `${caseId}: provenance`);
  }

  const manifest = validateReplayManifest(caseId, messagesPath);
  if (
    manifest.bytes.length !== provenance.bytes ||
    sha256(manifest.bytes) !== provenance.messagesSha256 ||
    manifest.messageCount !== provenance.messageCount
  ) {
    fail(`${caseId}: replay manifest 字节、哈希或总消息数与 provenance 不一致`);
  }

  const parsedChecks = parseJsonFile(
    join(WEB_ROOT, "public", checkReportPath),
    `${caseId}: checks`,
  );
  const checks = record(parsedChecks.value, `${caseId}: checks`);
  exactKeys(
    checks,
    ["schemaVersion", "caseId", "input", "selectedRunId", "runs", "artifacts"],
    `${caseId}: checks`,
  );
  if (checks.schemaVersion !== 1 || checks.caseId !== caseId)
    fail(`${caseId}: checks schema/caseId 不一致`);

  const input = record(checks.input, `${caseId}: checks.input`);
  exactKeys(input, ["path", "sha256", "bytes"], `${caseId}: checks.input`);
  const inputPath = stringField(input, "path", `${caseId}: checks.input`);
  if (inputPath !== `/tutorials/cases/${caseId}/input.json`)
    fail(`${caseId}: input 资产路径必须绑定案例 ID`);
  const inputSha = stringField(input, "sha256", `${caseId}: checks.input`);
  const inputBytes = integerField(input, "bytes", `${caseId}: checks.input`);
  const parsedInput = parseJsonFile(
    join(WEB_ROOT, "public", inputPath),
    `${caseId}: input asset`,
  );
  if (
    inputSha !== provenance.inputSha256 ||
    parsedInput.bytes.length !== inputBytes ||
    sha256(parsedInput.bytes) !== inputSha
  ) {
    fail(`${caseId}: input 资产字节/哈希与 checks/provenance 不一致`);
  }
  const inputAsset = record(parsedInput.value, `${caseId}: input asset`);
  exactKeys(
    inputAsset,
    ["schemaVersion", "caseId", "starterPrompt", "materials"],
    `${caseId}: input asset`,
  );
  if (
    inputAsset.schemaVersion !== 1 ||
    inputAsset.caseId !== caseId ||
    inputAsset.starterPrompt !== item.starterPrompt ||
    stable(inputAsset.materials) !== stable(item.inputMaterials)
  )
    fail(`${caseId}: input 资产未与 catalog 冻结指令和材料逐字绑定`);

  const selectedRunId = stringField(
    checks,
    "selectedRunId",
    `${caseId}: checks`,
  );
  if (!runIds.includes(selectedRunId))
    fail(`${caseId}: selectedRunId 不属于 provenance 三次运行`);
  if (!Array.isArray(checks.runs) || checks.runs.length !== 3)
    fail(`${caseId}: checks 必须包含恰好三次运行`);
  const reportRunIds = new Set<string>();
  const expectedCheckTitles = new Set(item.checks.map((check) => check.title));
  for (const [index, rawRun] of checks.runs.entries()) {
    const run = record(rawRun, `${caseId}: checks.run ${index}`);
    exactKeys(
      run,
      ["runId", "status", "agentId", "modelId", "engine", "checks"],
      `${caseId}: checks.run ${index}`,
    );
    const runId = stringField(run, "runId", `${caseId}: checks.run ${index}`);
    if (
      run.status !== "passed" ||
      !runIds.includes(runId) ||
      reportRunIds.has(runId) ||
      run.agentId !== provenance.agentId ||
      run.modelId !== provenance.modelId ||
      run.engine !== provenance.engine
    ) {
      fail(`${caseId}: checks 运行身份、状态或唯一性不一致`);
    }
    reportRunIds.add(runId);
    if (
      !Array.isArray(run.checks) ||
      run.checks.length !== expectedCheckTitles.size
    )
      fail(`${caseId}: 每次运行都必须覆盖全部确定性验收`);
    const seenChecks = new Set<string>();
    for (const [checkIndex, rawCheck] of run.checks.entries()) {
      const check = record(
        rawCheck,
        `${caseId}: run ${index} check ${checkIndex}`,
      );
      exactKeys(
        check,
        [
          "title",
          "status",
          "evidencePath",
          "evidenceSha256",
          "evidenceBytes",
        ],
        `${caseId}: run ${index} check ${checkIndex}`,
      );
      const title = stringField(
        check,
        "title",
        `${caseId}: run ${index} check ${checkIndex}`,
      );
      if (
        check.status !== "passed" ||
        !expectedCheckTitles.has(title) ||
        seenChecks.has(title) ||
        !/^[a-f0-9]{64}$/.test(String(check.evidenceSha256))
      ) {
        fail(`${caseId}: 运行验收状态、标题或证据哈希无效`);
      }
      const evidencePath = stringField(
        check,
        "evidencePath",
        `${caseId}: run ${index} check ${checkIndex}`,
      );
      if (
        !evidencePath.startsWith(
          `/tutorials/cases/${caseId}/evidence/${runId}/`,
        ) ||
        !evidencePath.endsWith(".json")
      )
        fail(`${caseId}: 验收证据路径必须绑定案例和公开运行别名`);
      const evidenceBytes = integerField(
        check,
        "evidenceBytes",
        `${caseId}: run ${index} check ${checkIndex}`,
      );
      const evidence = parseJsonFile(
        join(WEB_ROOT, "public", evidencePath),
        `${caseId}: run ${index} check ${checkIndex} evidence`,
      );
      if (
        evidence.bytes.length !== evidenceBytes ||
        sha256(evidence.bytes) !== check.evidenceSha256
      )
        fail(`${caseId}: 验收证据字节或哈希不一致`);
      assertPublicValue(
        evidence.value,
        `${caseId}: run ${index} check ${checkIndex} evidence`,
      );
      seenChecks.add(title);
    }
  }

  const actualArtifacts = replay.actualArtifacts;
  if (!Array.isArray(actualArtifacts) || actualArtifacts.length < 1)
    fail(`${caseId}: verified replay 必须声明实际下载产物`);
  if (!Array.isArray(checks.artifacts))
    fail(`${caseId}: checks.artifacts 必须是数组`);
  if (stable(actualArtifacts) !== stable(checks.artifacts))
    fail(`${caseId}: catalog 与 checks 的实际产物清单不一致`);
  const expectedArtifactTitles = new Set(
    item.artifacts.map((artifact) => artifact.title),
  );
  const actualArtifactTitles = new Set(
    actualArtifacts.map((artifact) =>
      stringField(
        record(artifact, `${caseId}: artifact`),
        "title",
        `${caseId}: artifact`,
      ),
    ),
  );
  for (const title of expectedArtifactTitles) {
    if (!actualArtifactTitles.has(title))
      fail(`${caseId}: 缺少预期实际产物 ${title}`);
  }
  for (const [index, rawArtifact] of actualArtifacts.entries()) {
    const artifact = record(rawArtifact, `${caseId}: artifact ${index}`);
    exactKeys(
      artifact,
      ["title", "path", "sha256", "bytes", "mimeType"],
      `${caseId}: artifact ${index}`,
    );
    stringField(artifact, "title", `${caseId}: artifact ${index}`);
    stringField(artifact, "mimeType", `${caseId}: artifact ${index}`);
    const path = stringField(artifact, "path", `${caseId}: artifact ${index}`);
    if (!path.startsWith(`/tutorials/cases/${caseId}/artifacts/`))
      fail(`${caseId}: 实际产物路径必须绑定案例 ID`);
    const expectedSha = stringField(
      artifact,
      "sha256",
      `${caseId}: artifact ${index}`,
    );
    if (!/^[a-f0-9]{64}$/.test(expectedSha))
      fail(`${caseId}: 实际产物哈希无效`);
    const expectedBytes = integerField(
      artifact,
      "bytes",
      `${caseId}: artifact ${index}`,
    );
    const bytes = readFileSync(join(WEB_ROOT, "public", path));
    if (bytes.length !== expectedBytes || sha256(bytes) !== expectedSha)
      fail(`${caseId}: 实际产物字节或哈希不一致`);
  }
  assertPublicValue(parsedChecks.value, `${caseId}: checks`);
  assertPublicValue(parsedInput.value, `${caseId}: input asset`);
}

function validateCaseCatalog(): void {
  if (TUTORIAL_CASES.length !== 12 || TUTORIAL_CASE_IDS.length !== 12)
    fail("场景教程必须固定包含 12 个旗舰案例");
  if (new Set(TUTORIAL_CASE_IDS).size !== TUTORIAL_CASE_IDS.length)
    fail("场景教程稳定 ID 不得重复");

  const expectedCounts = { research: 5, coding: 5, general: 2 } as const;
  for (const [category, count] of Object.entries(expectedCounts)) {
    const actual = TUTORIAL_CASES.filter(
      (item) => item.category === category,
    ).length;
    if (actual !== count)
      fail(`场景教程 ${category} 应有 ${count} 个，实际 ${actual} 个`);
  }

  const registeredIds = new Set<string>(TUTORIAL_CASE_IDS);
  const seenIds = new Set<string>();
  for (const item of TUTORIAL_CASES) {
    if (!registeredIds.has(item.id) || seenIds.has(item.id))
      fail(`${item.id}: 案例 ID 未登记或重复`);
    seenIds.add(item.id);
    if (!Number.isSafeInteger(item.contentVersion) || item.contentVersion < 1)
      fail(`${item.id}: contentVersion 必须是正整数`);
    if (
      item.title.trim().length < 8 ||
      item.summary.trim().length < 30 ||
      item.outcome.trim().length < 20 ||
      item.starterPrompt.trim().length < 100
    ) {
      fail(`${item.id}: 标题、摘要、结果或开工指令过于表面`);
    }
    if (
      item.sources.length < 2 ||
      item.inputMaterials.length < 1 ||
      item.stages.length < 4 ||
      item.artifacts.length < 1 ||
      item.checks.length < 2
    ) {
      fail(`${item.id}: 缺少来源、输入、全流程、产物或确定性验收`);
    }
    for (const capabilityId of item.capabilityIds) {
      if (!FEATURE_IDS.has(capabilityId))
        fail(`${item.id}: 引用了未知产品能力 ${capabilityId}`);
    }
    const officialAgents = {
      "research-assistant": { name: "科研助手", model: "deepseek-v4-pro" },
      "coding-assistant": { name: "编程助手", model: "glm-5.2" },
      "office-assistant": { name: "办公助手", model: "MiniMax-M3" },
    } as const;
    const officialAgent = officialAgents[item.suggestion.agentId];
    if (
      !officialAgent ||
      item.suggestion.agentName !== officialAgent.name ||
      item.suggestion.modelId !== officialAgent.model ||
      !item.suggestion.modelGuidance.trim() ||
      !item.suggestion.why.trim()
    ) {
      fail(`${item.id}: 建议 Agent/模型必须与产品官方登记一致`);
    }
    const stageIds = new Set<string>();
    for (const stage of item.stages) {
      if (!stage.id.trim() || stageIds.has(stage.id))
        fail(`${item.id}: 阶段 ID 为空或重复 ${stage.id}`);
      stageIds.add(stage.id);
      if (
        !stage.input.trim() ||
        !stage.operation.trim() ||
        !stage.output.trim() ||
        stage.visibleProcess.length < 2 ||
        stage.acceptance.length < 2
      ) {
        fail(
          `${item.id}/${stage.id}: 未完整说明输入、操作、可见过程、输出与验收`,
        );
      }
    }
    for (const source of item.sources) {
      let url: URL;
      try {
        url = new URL(source.url);
      } catch {
        fail(`${item.id}: 来源 URL 无效 ${source.url}`);
      }
      if (url.protocol !== "https:" || !url.hostname)
        fail(`${item.id}: 来源必须使用 HTTPS ${source.url}`);
      if (!source.license.trim() || !source.usageNote.trim())
        fail(`${item.id}: 来源必须写明许可与使用边界 ${source.url}`);
    }
    for (const [inputIndex, input] of item.inputMaterials.entries()) {
      if (
        !input.revision.trim() ||
        !/^[a-f0-9]{64}$/.test(input.sha256) ||
        !Number.isSafeInteger(input.bytes) ||
        input.bytes < 1
      ) {
        fail(
          `${item.id}: 输入 ${inputIndex + 1} 缺少固定 revision/SHA-256/字节数`,
        );
      }
      if (
        !input.sourceUrl &&
        !input.assetPath &&
        input.inlineContent === undefined
      )
        fail(
          `${item.id}: 输入 ${inputIndex + 1} 必须指向固定来源、静态资产或内联字节`,
        );
      if (input.sourceUrl) {
        let sourceUrl: URL;
        try {
          sourceUrl = new URL(input.sourceUrl);
        } catch {
          fail(`${item.id}: 输入来源 URL 无效 ${input.sourceUrl}`);
        }
        if (sourceUrl.protocol !== "https:")
          fail(`${item.id}: 输入来源必须使用 HTTPS ${input.sourceUrl}`);
      }
      if (input.assetPath) {
        if (input.inlineContent !== undefined) {
          if (!input.assetPath.startsWith(`tutorialCaseCatalog.ts#${item.id}/`))
            fail(`${item.id}: 内联输入定位符必须绑定当前案例`);
        } else {
          if (
            !input.assetPath.startsWith(`/tutorials/cases/${item.id}/inputs/`)
          )
            fail(`${item.id}: 输入资产路径必须绑定当前案例`);
          const bytes = readFileSync(join(WEB_ROOT, "public", input.assetPath));
          if (bytes.length !== input.bytes || sha256(bytes) !== input.sha256)
            fail(`${item.id}: 输入资产字节或哈希不一致`);
        }
      }
      if (input.inlineContent !== undefined) {
        const bytes = Buffer.from(input.inlineContent, "utf8");
        if (bytes.length !== input.bytes || sha256(bytes) !== input.sha256)
          fail(`${item.id}: 内联输入字节或哈希不一致`);
      }
      const frozenDescription = `${input.title}\n${input.description}\n${input.preparation}`;
      if (
        /运行时再(?:选择|任选)|请.{0,8}运行时.{0,8}(?:选择|任选)|待选择/i.test(
          frozenDescription,
        )
      )
        fail(`${item.id}: 输入 ${inputIndex + 1} 仍要求运行时再选择，未冻结`);
    }

    if (item.replay.status === "pending_capture") {
      if (
        item.replay.messagesPath !== undefined ||
        item.replay.provenance !== undefined ||
        item.replay.checkReport !== undefined ||
        item.replay.actualArtifacts !== undefined ||
        !item.replay.disclosure.includes("尚未完成三次独立运行")
      ) {
        fail(`${item.id}: 待采集案例不得携带或暗示真实回放`);
      }
      continue;
    }

    validateVerifiedEvidence(item);
  }
}

function webPublicPath(urlPath: string): string {
  if (!urlPath.startsWith("/tutorials/"))
    fail(`教程媒体必须是本地 /tutorials/ 路径：${urlPath}`);
  return join(WEB_ROOT, "public", urlPath.slice(1));
}

function webpDimensions(buffer: Buffer): { width: number; height: number } {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    fail("海报不是有效 WebP 文件");
  }
  const kind = buffer.toString("ascii", 12, 16);
  if (kind === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (kind === "VP8 ") {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a)
      fail("WebP VP8 帧头无效");
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (kind === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  fail(`不支持的 WebP 编码块：${kind}`);
}

function readVint(
  buffer: Buffer,
  offset: number,
): { length: number; value: number } | null {
  const first = buffer[offset];
  if (first == null || first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 8 || offset + length > buffer.length) return null;
  let value = first & (mask - 1);
  for (let i = 1; i < length; i += 1) value = value * 256 + buffer[offset + i];
  return { length, value };
}

function ebmlPayload(buffer: Buffer, id: readonly number[]): Buffer | null {
  const needle = Buffer.from(id);
  let offset = 0;
  while ((offset = buffer.indexOf(needle, offset)) >= 0) {
    const size = readVint(buffer, offset + needle.length);
    if (size && size.value >= 0 && size.value <= 16) {
      const start = offset + needle.length + size.length;
      if (start + size.value <= buffer.length)
        return buffer.subarray(start, start + size.value);
    }
    offset += 1;
  }
  return null;
}

function unsigned(payload: Buffer | null, label: string): number {
  if (!payload || payload.length === 0 || payload.length > 6)
    fail(`WebM 缺少 ${label}`);
  let value = 0;
  for (const byte of payload) value = value * 256 + byte;
  return value;
}

function webmMetadata(buffer: Buffer): {
  width: number;
  height: number;
  durationSeconds: number;
} {
  if (
    buffer.length < 64 ||
    !buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  ) {
    fail("视频不是有效 WebM/EBML 文件");
  }
  if (
    !buffer.includes(Buffer.from("webm")) ||
    !buffer.includes(Buffer.from("V_VP8"))
  ) {
    fail("教程视频必须使用 WebM VP8 编码");
  }
  const width = unsigned(ebmlPayload(buffer, [0xb0]), "PixelWidth");
  const height = unsigned(ebmlPayload(buffer, [0xba]), "PixelHeight");
  const durationPayload = ebmlPayload(buffer, [0x44, 0x89]);
  if (
    !durationPayload ||
    (durationPayload.length !== 4 && durationPayload.length !== 8)
  ) {
    fail("WebM 缺少可解析 Duration");
  }
  const durationTicks =
    durationPayload.length === 4
      ? durationPayload.readFloatBE(0)
      : durationPayload.readDoubleBE(0);
  const scalePayload = ebmlPayload(buffer, [0x2a, 0xd7, 0xb1]);
  const timecodeScale = scalePayload
    ? unsigned(scalePayload, "TimecodeScale")
    : 1_000_000;
  return {
    width,
    height,
    durationSeconds: (durationTicks * timecodeScale) / 1_000_000_000,
  };
}

function collectMedia(): Record<TutorialMediaKey, MediaSnapshot> {
  const result = {} as Record<TutorialMediaKey, MediaSnapshot>;
  let totalBytes = 0;
  const posterHashes = new Map<string, string>();
  const videoHashes = new Map<string, string>();
  for (const key of Object.keys(TUTORIAL_MEDIA).sort() as TutorialMediaKey[]) {
    const item = TUTORIAL_MEDIA[key];
    const posterPath = webPublicPath(item.poster);
    const videoPath = webPublicPath(item.video);
    if (!existsSync(posterPath) || !existsSync(videoPath))
      fail(`${key}: 缺少海报或视频文件`);
    const poster = readFileSync(posterPath);
    const video = readFileSync(videoPath);
    const posterMeta = webpDimensions(poster);
    const videoMeta = webmMetadata(video);
    const pairBytes = poster.length + video.length;
    const posterHash = sha256(poster);
    const videoHash = sha256(video);
    const posterDuplicate = posterHashes.get(posterHash);
    const videoDuplicate = videoHashes.get(videoHash);
    if (posterDuplicate) fail(`${key}: 海报与 ${posterDuplicate} 完全重复`);
    if (videoDuplicate) fail(`${key}: 视频与 ${videoDuplicate} 完全重复`);
    posterHashes.set(posterHash, key);
    videoHashes.set(videoHash, key);
    totalBytes += pairBytes;
    if (pairBytes > MAX_MEDIA_PAIR_BYTES)
      fail(`${key}: 媒体对 ${pairBytes} B 超过 ${MAX_MEDIA_PAIR_BYTES} B`);
    if (
      posterMeta.width !== REQUIRED_WIDTH ||
      posterMeta.height !== REQUIRED_HEIGHT
    ) {
      fail(
        `${key}: 海报必须为 ${REQUIRED_WIDTH}x${REQUIRED_HEIGHT}，实际 ${posterMeta.width}x${posterMeta.height}`,
      );
    }
    if (
      videoMeta.width !== REQUIRED_WIDTH ||
      videoMeta.height !== REQUIRED_HEIGHT
    ) {
      fail(
        `${key}: 视频必须为 ${REQUIRED_WIDTH}x${REQUIRED_HEIGHT}，实际 ${videoMeta.width}x${videoMeta.height}`,
      );
    }
    if (
      videoMeta.durationSeconds < MIN_DURATION_SECONDS ||
      videoMeta.durationSeconds > MAX_DURATION_SECONDS
    ) {
      fail(
        `${key}: 视频时长 ${videoMeta.durationSeconds.toFixed(3)} s 不在 ${MIN_DURATION_SECONDS}–${MAX_DURATION_SECONDS} s`,
      );
    }
    result[key] = {
      version: item.version,
      poster: item.poster,
      video: item.video,
      caption: item.caption,
      posterSha256: posterHash,
      videoSha256: videoHash,
      posterBytes: poster.length,
      videoBytes: video.length,
      width: videoMeta.width,
      height: videoMeta.height,
      durationSeconds: Number(videoMeta.durationSeconds.toFixed(3)),
      codec: "VP8",
    };
  }
  if (totalBytes > MAX_TOTAL_MEDIA_BYTES) {
    fail(`教程媒体总量 ${totalBytes} B 超过 ${MAX_TOTAL_MEDIA_BYTES} B`);
  }
  return result;
}

function hamming256(a: string, b: string): number {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b))
    fail("provenance dHash 必须是 256-bit 十六进制");
  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (value > 0n) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

function validateCaptureProvenance(
  media: Record<TutorialMediaKey, MediaSnapshot>,
): void {
  if (!existsSync(CAPTURE_PROVENANCE_PATH))
    fail("缺少 tutorial-capture-provenance.json 真实录制来源证明");
  let provenance: CaptureProvenance;
  try {
    provenance = JSON.parse(
      readFileSync(CAPTURE_PROVENANCE_PATH, "utf8"),
    ) as CaptureProvenance;
  } catch {
    fail("tutorial-capture-provenance.json 不是有效 JSON");
  }
  if (
    provenance.schema !== 1 ||
    provenance.pipelineVersion < 2 ||
    provenance.productionEntry !== "index.html -> src/main.tsx -> App" ||
    provenance.fixtureBoundary !==
      "HTTP / WebSocket / browser capabilities only" ||
    !provenance.networkPolicy.includes("all external requests fail") ||
    !/^[a-f0-9]{40}$/.test(provenance.sourceCommit) ||
    !/^[a-f0-9]{64}$/.test(provenance.sourceTreeHash) ||
    !Number.isFinite(Date.parse(provenance.generatedAt)) ||
    !provenance.toolchain ||
    typeof provenance.toolchain !== "object"
  ) {
    fail(
      "tutorial-capture-provenance.json 的生产入口、网络边界或工具链字段无效",
    );
  }
  const ids = [...FEATURE_IDS].sort();
  const scenarioIds = Object.keys(provenance.scenarios ?? {}).sort();
  if (stable(ids) !== stable(scenarioIds))
    fail(`provenance 必须覆盖且仅覆盖全部 ${FEATURE_IDS.size} 个能力`);

  const finalHashes = new Map<ProductFeatureId, string>();
  const stageSignatures = new Map<string, string>();
  const operationalStageHashes = new Map<string, string>();
  const actionSignatures = new Map<string, string>();
  for (const id of ids as ProductFeatureId[]) {
    const scenario = provenance.scenarios[id];
    const snapshot = media[id];
    if (
      !scenario ||
      scenario.mediaVersion !== TUTORIAL_MEDIA[id].version ||
      scenario.caption !== TUTORIAL_MEDIA[id].caption
    ) {
      fail(`${id}: provenance 版本或说明与教程目录不一致`);
    }
    if (
      scenario.poster.sha256 !== snapshot.posterSha256 ||
      scenario.poster.bytes !== snapshot.posterBytes ||
      scenario.video.sha256 !== snapshot.videoSha256 ||
      scenario.video.bytes !== snapshot.videoBytes
    ) {
      fail(`${id}: provenance 媒体哈希/大小与实际文件不一致`);
    }
    if (!Array.isArray(scenario.stages) || scenario.stages.length < 2)
      fail(`${id}: 至少需要两个真实界面录制阶段`);
    if (!Array.isArray(scenario.actions) || scenario.actions.length < 1)
      fail(`${id}: 缺少真实控件动作轨迹`);
    if (!Array.isArray(scenario.assertions) || scenario.assertions.length < 1)
      fail(`${id}: 缺少场景结果断言`);
    for (const [index, stage] of scenario.stages.entries()) {
      if (!stage.label?.trim() || !/^[a-f0-9]{64}$/.test(stage.dHash))
        fail(`${id}: 阶段标签或 dHash 无效`);
      if (index > 0) {
        const duplicate = operationalStageHashes.get(stage.dHash);
        if (duplicate)
          fail(`${id}: 操作画面“${stage.label}”与 ${duplicate} 完全重复`);
        operationalStageHashes.set(
          stage.dHash,
          `${id} 的操作画面“${stage.label}”`,
        );
      }
    }
    for (const action of scenario.actions) {
      if (
        !action.step?.trim() ||
        !action.selector?.trim() ||
        !action.tag?.trim() ||
        !action.label?.trim() ||
        action.expectedFeatureId !== id ||
        action.matchedFeatureId !== id ||
        !action.matchedControl ||
        !Array.isArray(action.activeTabs) ||
        !Array.isArray(action.assertions) ||
        action.assertions.length < 2
      ) {
        fail(`${id}: 动作轨迹没有证明 selector 命中了对应真实功能/控件祖先`);
      }
    }
    const finalHash = scenario.stages.at(-1)!.dHash;
    finalHashes.set(id, finalHash);
    const stageSignature = scenario.stages
      .map((stage) => `${stage.label}:${stage.dHash}`)
      .join("|");
    const stageDuplicate = stageSignatures.get(stageSignature);
    if (stageDuplicate) fail(`${id}: 阶段序列与 ${stageDuplicate} 完全重复`);
    stageSignatures.set(stageSignature, id);
    const actionSignature = scenario.actions
      .map((action) => `${action.selector}:${action.step}`)
      .join("|");
    const actionDuplicate = actionSignatures.get(actionSignature);
    if (actionDuplicate) fail(`${id}: 动作轨迹与 ${actionDuplicate} 完全重复`);
    actionSignatures.set(actionSignature, id);
  }

  const nearDuplicates: string[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const left = ids[i] as ProductFeatureId;
      const right = ids[j] as ProductFeatureId;
      const distance = hamming256(
        finalHashes.get(left)!,
        finalHashes.get(right)!,
      );
      if (distance < 12)
        nearDuplicates.push(`${left} ↔ ${right}（dHash 距离 ${distance}）`);
    }
  }
  if (nearDuplicates.length)
    fail(`教程最终产品画面疑似感知重复：\n- ${nearDuplicates.join("\n- ")}`);

  const raw = readFileSync(CAPTURE_PROVENANCE_PATH, "utf8");
  if (
    /claudeai\.chat|\beyJ[A-Za-z0-9_-]{20,}\.|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}/i.test(
      raw,
    )
  ) {
    fail("provenance 含生产域名或疑似密钥/JWT");
  }
  for (const retired of [
    join(WEB_ROOT, "tutorial-capture.html"),
    join(SRC_ROOT, "tutorialCapture.tsx"),
    join(SRC_ROOT, "components/tutorial/TutorialCaptureStudio.tsx"),
  ]) {
    if (existsSync(retired))
      fail(`真实录制不得保留教程专用伪 UI：${relative(ROOT, retired)}`);
  }
  const viteConfig = readFileSync(join(WEB_ROOT, "vite.config.ts"), "utf8");
  if (
    /tutorial-capture|tutorialCapture|TutorialCaptureStudio/.test(viteConfig)
  ) {
    fail("正式 Vite 配置不得保留教程专用入口");
  }
}

function buildSnapshot(): TutorialSnapshot {
  const markers = collectMarkers();
  validateCatalog(markers);
  validateCaseCatalog();
  const media = collectMedia();
  validateCaptureProvenance(media);
  const capabilities: Record<string, CapabilitySnapshot> = {};
  const cases: Record<string, CaseSnapshot> = {};
  for (const feature of [...PRODUCT_CAPABILITY_LIST].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const id = feature.id as ProductFeatureId;
    const topic = TUTORIAL_TOPICS[id];
    const markerSemantics = markers
      .filter((marker) => marker.id === id)
      .sort((a, b) =>
        `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`),
      )
      .map((marker) => `${marker.file}\n${marker.semantic}`);
    const mediaItem = media[topic.media];
    const { contentVersion: _contentVersion, ...contentBody } = topic;
    capabilities[id] = {
      contentVersion: topic.contentVersion,
      // 版本号不计入正文哈希：只“空加版本”不能冒充教程已同步更新。
      contentHash: sha256(stable(contentBody)),
      // 标题、搜索别名、分类、CTA 目的地与权限都是教程语义，必须进入版本化快照。
      registryHash: sha256(stable(feature)),
      sourceHash: sha256(markerSemantics.join("\n---\n")),
      mediaKey: topic.media,
      mediaVersion: mediaItem.version,
      mediaHash: sha256(
        `${mediaItem.posterSha256}:${mediaItem.videoSha256}:${sha256(mediaItem.caption)}`,
      ),
    };
  }
  for (const item of [...TUTORIAL_CASES].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const { contentVersion: _contentVersion, ...contentBody } = item;
    cases[item.id] = {
      contentVersion: item.contentVersion,
      // 案例正文、固定输入、来源、执行建议、验收和 replay 状态全部防漂移。
      contentHash: sha256(stable(contentBody)),
    };
  }
  return {
    schema: 1,
    catalogSchema: TUTORIAL_CATALOG_SCHEMA,
    capabilities,
    cases,
    media,
  };
}

function readManifest(): TutorialSnapshot | null {
  if (!existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as TutorialSnapshot;
}

function parseArgs(): {
  command: "check" | "accept";
  sourceOnly: boolean;
  bootstrap: boolean;
  note: string;
  retire: string[];
} {
  const args = process.argv.slice(2);
  const command = args[0] === "accept" ? "accept" : "check";
  const sourceOnly = args.includes("--source-only");
  const bootstrap = args.includes("--bootstrap");
  const noteIndex = args.indexOf("--note");
  const note = noteIndex >= 0 ? (args[noteIndex + 1] ?? "").trim() : "";
  const retire = args
    .flatMap((arg, index) =>
      arg === "--retire" ? [args[index + 1] ?? ""] : [],
    )
    .map((id) => id.trim())
    .filter(Boolean);
  return { command, sourceOnly, bootstrap, note, retire };
}

function snapshotCapabilityIds(
  before: TutorialSnapshot | null,
  after: TutorialSnapshot,
): string[] {
  return [
    ...new Set([
      ...Object.keys(before?.capabilities ?? {}),
      ...Object.keys(after.capabilities),
    ]),
  ].sort();
}

function changedIds(
  before: TutorialSnapshot | null,
  after: TutorialSnapshot,
  field: keyof CapabilitySnapshot,
): string[] {
  return snapshotCapabilityIds(before, after)
    .filter(
      (id) =>
        before?.capabilities[id]?.[field] !== after.capabilities[id]?.[field],
    )
    .sort();
}

function changedCapabilityIds(
  before: TutorialSnapshot | null,
  after: TutorialSnapshot,
): string[] {
  return snapshotCapabilityIds(before, after)
    .filter(
      (id) =>
        stable(before?.capabilities[id] ?? null) !==
        stable(after.capabilities[id] ?? null),
    )
    .sort();
}

function snapshotCaseIds(
  before: TutorialSnapshot | null,
  after: TutorialSnapshot,
): string[] {
  return [
    ...new Set([
      ...Object.keys(before?.cases ?? {}),
      ...Object.keys(after.cases),
    ]),
  ].sort();
}

function changedCaseIds(
  before: TutorialSnapshot | null,
  after: TutorialSnapshot,
): string[] {
  return snapshotCaseIds(before, after)
    .filter(
      (id) =>
        stable(before?.cases?.[id] ?? null) !== stable(after.cases[id] ?? null),
    )
    .sort();
}

function addedCapabilityIds(
  before: TutorialSnapshot | null,
  after: TutorialSnapshot,
): string[] {
  if (!before) return Object.keys(after.capabilities).sort();
  return Object.keys(after.capabilities)
    .filter((id) => !before.capabilities[id])
    .sort();
}

function retiredCapabilityIds(
  before: TutorialSnapshot | null,
  after: TutorialSnapshot,
): string[] {
  if (!before) return [];
  return Object.keys(before.capabilities)
    .filter((id) => !after.capabilities[id])
    .sort();
}

function committedHistoryBaseline(): string | null {
  const configured = (process.env.TUTORIAL_HISTORY_BASE_REF ?? "").trim();
  const ref = configured && !/^0+$/.test(configured) ? configured : "HEAD";
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], {
      cwd: ROOT,
      stdio: "ignore",
    });
  } catch {
    if (configured) fail(`无法读取教程历史基线提交：${configured}`);
    return null;
  }
  try {
    return execFileSync("git", ["show", `${ref}:${HISTORY_REPO_PATH}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // 首次引入教程系统时，可信基线提交中尚没有历史文件。
    return null;
  }
}

function historyAnchor(
  raw: string,
  audits: TutorialAudit[],
): TutorialHistoryAnchor {
  const head = audits.at(-1);
  if (!head) fail("tutorial-sync-history.jsonl 不能为空");
  return {
    schema: 1,
    entries: audits.length,
    historySha256: sha256(raw),
    headAuditSha256: sha256(stable(head)),
  };
}

function writeHistoryAnchor(audits: TutorialAudit[]): void {
  const raw = readFileSync(HISTORY_PATH, "utf8");
  const anchor = historyAnchor(raw, audits);
  writeAtomic(
    HISTORY_ANCHOR_PATH,
    `${JSON.stringify(JSON.parse(stable(anchor)), null, 2)}\n`,
  );
}

function readAndValidateHistory(manifest: TutorialSnapshot): TutorialAudit[] {
  if (!existsSync(HISTORY_PATH))
    fail("缺少 tutorial-sync-history.jsonl 追加式审计记录");
  const raw = readFileSync(HISTORY_PATH, "utf8");
  const lines = raw.endsWith("\n")
    ? raw.slice(0, -1).split("\n")
    : raw.split("\n");
  if (
    !raw.endsWith("\n") ||
    lines.length === 0 ||
    lines.some((line) => !line.trim())
  ) {
    fail("tutorial-sync-history.jsonl 必须是非空、逐行 JSON 且以换行结尾");
  }

  const audits: TutorialAudit[] = [];
  for (const [index, line] of lines.entries()) {
    let audit: TutorialAudit;
    try {
      audit = JSON.parse(line) as TutorialAudit;
    } catch {
      fail(`tutorial-sync-history.jsonl 第 ${index + 1} 行不是有效 JSON`);
    }
    if (
      audit.schema !== 1 ||
      audit.sequence !== index + 1 ||
      !["bootstrap", "source-only", "tutorial-sync"].includes(audit.mode) ||
      typeof audit.actor !== "string" ||
      !audit.actor ||
      typeof audit.at !== "string" ||
      !Number.isFinite(Date.parse(audit.at)) ||
      typeof audit.note !== "string" ||
      audit.note.length < 8 ||
      !/^[a-f0-9]{64}$/.test(audit.snapshotSha256)
    ) {
      fail(`tutorial-sync-history.jsonl 第 ${index + 1} 行字段或序号无效`);
    }
    const expectedPrevious =
      index === 0 ? null : sha256(stable(audits[index - 1]));
    if (audit.previousAuditSha256 !== expectedPrevious) {
      fail(`tutorial-sync-history.jsonl 第 ${index + 1} 行哈希链断裂`);
    }
    if ((index === 0) !== (audit.mode === "bootstrap")) {
      fail("tutorial-sync-history.jsonl 只能第一条记录使用 bootstrap 模式");
    }
    for (const field of [
      "sourceChanged",
      "registryChanged",
      "contentChanged",
      "mediaChanged",
      "added",
      "retired",
    ] as const) {
      if (
        !Array.isArray(audit[field]) ||
        audit[field].some((id) => typeof id !== "string")
      ) {
        fail(`tutorial-sync-history.jsonl 第 ${index + 1} 行 ${field} 无效`);
      }
    }
    if (
      audit.caseChanged !== undefined &&
      (!Array.isArray(audit.caseChanged) ||
        audit.caseChanged.some((id) => typeof id !== "string"))
    ) {
      fail(`tutorial-sync-history.jsonl 第 ${index + 1} 行 caseChanged 无效`);
    }
    audits.push(audit);
  }
  const expectedSnapshot = sha256(stable(manifest));
  if (audits.at(-1)?.snapshotSha256 !== expectedSnapshot) {
    fail(
      "tutorial-sync-history.jsonl 最后一条记录与 tutorial-sync.json 快照不一致",
    );
  }

  if (!existsSync(HISTORY_ANCHOR_PATH))
    fail("缺少 tutorial-sync-history-head.json 历史锚点");
  let anchor: TutorialHistoryAnchor;
  try {
    anchor = JSON.parse(
      readFileSync(HISTORY_ANCHOR_PATH, "utf8"),
    ) as TutorialHistoryAnchor;
  } catch {
    fail("tutorial-sync-history-head.json 不是有效 JSON");
  }
  if (stable(anchor) !== stable(historyAnchor(raw, audits))) {
    fail(
      "tutorial-sync-history.jsonl 与历史锚点不一致，既有审计记录可能被改写",
    );
  }

  const baseline = committedHistoryBaseline();
  if (baseline !== null && !raw.startsWith(baseline)) {
    fail(
      "tutorial-sync-history.jsonl 必须以可信 Git 基线的完整字节内容为前缀，只能追加",
    );
  }
  return audits;
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o644 });
  renameSync(temp, path);
}

function accept(
  before: TutorialSnapshot | null,
  after: TutorialSnapshot,
  args: ReturnType<typeof parseArgs>,
): void {
  if (!args.note || args.note.length < 8)
    fail("accept 必须提供至少 8 个字符的 --note，说明对应功能/教程变化");
  if (!before && !args.bootstrap)
    fail("首次建立同步快照必须显式使用 --bootstrap");
  if (before && args.bootstrap)
    fail("tutorial-sync.json 已存在，不能再次 --bootstrap");

  let history: TutorialAudit[] = [];
  if (before) {
    history = readAndValidateHistory(before);
  } else if (existsSync(HISTORY_PATH) || existsSync(HISTORY_ANCHOR_PATH)) {
    fail("首次 bootstrap 前不得存在旧的教程同步历史或历史锚点");
  }

  const sourceChanged = changedIds(before, after, "sourceHash");
  const registryChanged = changedIds(before, after, "registryHash");
  const contentChanged = changedIds(before, after, "contentHash");
  const mediaChanged = changedIds(before, after, "mediaHash");
  const allIds = new Set(changedCapabilityIds(before, after));
  const caseChanged = changedCaseIds(before, after);
  const added = addedCapabilityIds(before, after);
  const retired = retiredCapabilityIds(before, after);
  const retireSet = new Set(args.retire);

  if (retireSet.size !== args.retire.length)
    fail("--retire 不得重复同一个稳定 ID");
  const unconfirmedRetirements = retired.filter((id) => !retireSet.has(id));
  const unexpectedRetirements = args.retire.filter(
    (id) => !retired.includes(id),
  );
  if (unconfirmedRetirements.length) {
    fail(
      `能力稳定 ID 不得静默删除；确认下线请为每项添加 --retire：${unconfirmedRetirements.join(", ")}`,
    );
  }
  if (unexpectedRetirements.length) {
    fail(`--retire 与实际删除能力不一致：${unexpectedRetirements.join(", ")}`);
  }
  if (args.sourceOnly && (added.length > 0 || retired.length > 0)) {
    fail("--source-only 不能接受能力新增或下线");
  }
  if (args.sourceOnly && caseChanged.length > 0) {
    fail("--source-only 不能接受场景案例变化");
  }

  if (before) {
    for (const id of allIds) {
      const oldValue = before.capabilities[id];
      const newValue = after.capabilities[id];
      if (!oldValue || !newValue) continue;
      const contentHashChanged = oldValue.contentHash !== newValue.contentHash;
      const mediaHashChanged = oldValue.mediaHash !== newValue.mediaHash;
      const contentVersionRaised =
        newValue.contentVersion > oldValue.contentVersion;
      const mediaVersionRaised = newValue.mediaVersion > oldValue.mediaVersion;
      const mediaKeyChanged = oldValue.mediaKey !== newValue.mediaKey;
      const registryHashChanged =
        oldValue.registryHash !== newValue.registryHash;

      if (
        newValue.contentVersion !== oldValue.contentVersion &&
        !contentVersionRaised
      ) {
        fail(`${id}: contentVersion 不得降低`);
      }
      if (contentHashChanged !== contentVersionRaised) {
        fail(`${id}: 教程正文哈希变化与 contentVersion 递增必须同时发生`);
      }
      if (
        !mediaKeyChanged &&
        newValue.mediaVersion !== oldValue.mediaVersion &&
        !mediaVersionRaised
      ) {
        fail(`${id}: mediaVersion 不得降低`);
      }
      if (!mediaKeyChanged && mediaHashChanged !== mediaVersionRaised) {
        fail(`${id}: 教程媒体哈希变化与 mediaVersion 递增必须同时发生`);
      }
      const tutorialUpdated =
        (contentHashChanged && contentVersionRaised) ||
        (mediaHashChanged && mediaVersionRaised);
      if (registryHashChanged && !tutorialUpdated) {
        fail(
          `${id}: 能力标题/分类/别名/CTA/权限已变化，必须同步更新教程正文或媒体并提高对应版本`,
        );
      }
      if (sourceChanged.includes(id) && !args.sourceOnly && !tutorialUpdated) {
        fail(
          `${id}: 真实入口语义已变化；请同步更新教程正文/媒体并提高版本，或以 --source-only --note 审计接受等价重构`,
        );
      }
    }
    for (const id of caseChanged) {
      const oldValue = before.cases?.[id];
      const newValue = after.cases[id];
      if (!oldValue || !newValue) continue;
      const hashChanged = oldValue.contentHash !== newValue.contentHash;
      const versionRaised = newValue.contentVersion > oldValue.contentVersion;
      if (
        newValue.contentVersion !== oldValue.contentVersion &&
        !versionRaised
      ) {
        fail(`${id}: 案例 contentVersion 不得降低`);
      }
      if (hashChanged !== versionRaised) {
        fail(`${id}: 案例正文哈希变化与 contentVersion 递增必须同时发生`);
      }
    }
  }

  if (args.sourceOnly && registryChanged.length > 0)
    fail("--source-only 不能接受能力标题、分类、别名、CTA 或权限变化");
  if (args.sourceOnly && sourceChanged.length === 0)
    fail("--source-only 仅用于存在真实功能源语义变化的情况");
  if (before && allIds.size === 0 && caseChanged.length === 0)
    fail("当前能力、教程、入口、案例与媒体没有待接受的变化");
  const serialized = `${JSON.stringify(JSON.parse(stable(after)), null, 2)}\n`;
  writeAtomic(MANIFEST_PATH, serialized);
  const audit: TutorialAudit = {
    schema: 1,
    sequence: history.length + 1,
    previousAuditSha256: history.length ? sha256(stable(history.at(-1))) : null,
    at: new Date().toISOString(),
    actor: process.env.GITHUB_ACTOR || process.env.USER || "unknown",
    mode: args.bootstrap
      ? "bootstrap"
      : args.sourceOnly
        ? "source-only"
        : "tutorial-sync",
    note: args.note,
    sourceChanged,
    registryChanged,
    contentChanged,
    mediaChanged,
    caseChanged,
    added,
    retired,
    snapshotSha256: sha256(stable(after)),
  };
  appendFileSync(HISTORY_PATH, `${stable(audit)}\n`, {
    encoding: "utf8",
    mode: 0o644,
    flag: "a",
  });
  const nextHistory = [...history, audit];
  writeHistoryAnchor(nextHistory);
  readAndValidateHistory(after);
  console.log(
    `tutorials:accept OK · ${audit.mode} · ${allIds.size} capability snapshots changed · ${caseChanged.length} case snapshots changed`,
  );
}

function main(): void {
  const args = parseArgs();
  const snapshot = buildSnapshot();
  const manifest = readManifest();
  if (args.command === "accept") {
    accept(manifest, snapshot, args);
    return;
  }
  if (!manifest)
    fail(
      "缺少 packages/web-react/tutorial-sync.json；运行 tutorials:accept -- --bootstrap --note <说明>",
    );
  readAndValidateHistory(manifest);
  const expected = stable(manifest);
  const actual = stable(snapshot);
  if (expected !== actual) {
    const sourceChanged = changedIds(manifest, snapshot, "sourceHash");
    const registryChanged = changedIds(manifest, snapshot, "registryHash");
    const contentChanged = changedIds(manifest, snapshot, "contentHash");
    const mediaChanged = changedIds(manifest, snapshot, "mediaHash");
    const added = addedCapabilityIds(manifest, snapshot);
    const retired = retiredCapabilityIds(manifest, snapshot);
    const caseChanged = changedCaseIds(manifest, snapshot);
    fail(
      [
        "教程同步快照已漂移，CI 不会自动改写文件。",
        `能力注册表变化: ${registryChanged.join(", ") || "无"}`,
        `功能源变化: ${sourceChanged.join(", ") || "无"}`,
        `教程正文变化: ${contentChanged.join(", ") || "无"}`,
        `教程媒体变化: ${mediaChanged.join(", ") || "无"}`,
        `场景案例变化: ${caseChanged.join(", ") || "无"}`,
        `新增能力: ${added.join(", ") || "无"}`,
        `待确认下线: ${retired.join(", ") || "无"}`,
        '确认教程同步后运行 npm run tutorials:accept -- --note "说明"。',
      ].join("\n"),
    );
  }
  const totalBytes = Object.values(snapshot.media).reduce(
    (sum, item) => sum + item.posterBytes + item.videoBytes,
    0,
  );
  console.log(
    `check:tutorials OK · ${Object.keys(snapshot.capabilities).length} capabilities · ${TUTORIAL_CASES.length} real-world cases · ${Object.keys(snapshot.media).length} media pairs · ${totalBytes} B`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
