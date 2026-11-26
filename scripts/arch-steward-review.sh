#!/usr/bin/env bash
# Architecture Steward Cross-Family Review Wrapper (OCV5-905 / OCV5-903 B2 & B3).
#
# Encapsulates the standardized 4-dimension Architecture Steward prompt:
#   1. godClassAppend    — prevents appending new branches/features into Top-20 append magnets
#   2. wheelReinvention  — catches duplicated utilities / 12-line clones instead of @openclaude/kernel reuse
#   3. boundaryIntegrity — enforces arch/modules.json layering, subdomain boundaries & gate couplings
#   4. complexityDrift   — blocks >100L / CC_direct > 20 / unnecessary state or branching bloat
#
# Calls a verified CROSS-FAMILY strong model (hard-verified before spending any tokens),
# writes a tamper-evident signed production `ArchStewardReceipt` JSON outside the repo
# (default `/opt/openclaude/harness-gate/steward-receipts/<headSha>.json`), validates it via
# `scripts/check-cross-family-audit.ts --enforce-commit`, and optionally publishes an
# out-of-commit GitHub Commit Status `oc-v5/arch-steward` (`--publish-github-status`).
#
# Security invariant (B3):
#   - `--dry-run` emits a non-production schema (`oc.v5.arch-steward-dry-run/1`, `dryRun: true`,
#     never `verdict: "approve"`), NEVER signs a production receipt, and NEVER publishes a GitHub status.
#
# Usage:
#   scripts/arch-steward-review.sh --author-model <slug> [--steward-model <slug>]
#     [--base <ref>] [--head <ref>] [--out <path.json>] [--root <repo>]
#     [--channel auto|codex|agy|command] [--publish-github-status] [--github-repo <owner/repo>]
#     [--dry-run] [--print-prompt] [--unsafe-test-skip-owner]
#
# Exit: 0 approved (or low-risk fast pass / --dry-run / --print-prompt),
#       1 cross-family violation or Steward VETO (non-overridable),
#       2 CLI / git / channel error.
set -euo pipefail

die() { echo "✗ [arch-steward-review] $*" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_HOST_RECEIPT_DIR="/opt/openclaude/harness-gate/steward-receipts"

root=""
base_ref=""
head_ref="HEAD"
author_model="${OC_AUTHOR_MODEL:-}"
steward_model="${OC_STEWARD_MODEL:-}"
out_path=""
channel="auto"
dry_run=0
print_prompt=0
publish_gh=0
gh_repo=""
unsafe_test_skip_owner=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) root="${2:-}"; shift 2 ;;
    --base) base_ref="${2:-}"; shift 2 ;;
    --head) head_ref="${2:-}"; shift 2 ;;
    --author-model) author_model="${2:-}"; shift 2 ;;
    --steward-model) steward_model="${2:-}"; shift 2 ;;
    --out) out_path="${2:-}"; shift 2 ;;
    --channel) channel="${2:-}"; shift 2 ;;
    --publish-github-status) publish_gh=1; shift ;;
    --github-repo) gh_repo="${2:-}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --print-prompt) print_prompt=1; shift ;;
    --unsafe-test-skip-owner) unsafe_test_skip_owner=1; shift ;;
    -h|--help)
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "未知参数: $1" ;;
  esac
done

if [[ "$dry_run" == 1 && "$publish_gh" == 1 ]]; then
  die "--dry-run 禁止与 --publish-github-status 联用（绝不向 GitHub 发布干跑状态）"
fi

if [[ -z "$root" ]]; then
  root="$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$DEFAULT_ROOT")"
fi
root="$(cd "$root" && pwd)"

[[ -n "$author_model" ]] || die "缺 --author-model（或设置 OC_AUTHOR_MODEL）"
case "$channel" in
  auto|codex|agy|command) ;;
  *) die "非法 --channel: $channel（允许 auto|codex|agy|command）" ;;
esac

AUDIT_SCRIPT="$SCRIPT_DIR/check-cross-family-audit.ts"
[[ -f "$AUDIT_SCRIPT" ]] || die "缺少 $AUDIT_SCRIPT"

TSX_CMD=()
if [[ -f "$DEFAULT_ROOT/node_modules/tsx/dist/cli.mjs" ]]; then
  TSX_CMD=(node "$DEFAULT_ROOT/node_modules/tsx/dist/cli.mjs")
elif command -v tsx >/dev/null 2>&1; then
  TSX_CMD=(tsx)
else
  TSX_CMD=(node --import tsx)
fi

run_tsx() {
  "${TSX_CMD[@]}" "$@"
}

resolve_github_repo_slug() {
  local explicit="${1:-}"
  if [[ -n "$explicit" ]]; then
    printf '%s\n' "$explicit"
    return 0
  fi
  if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
    printf '%s\n' "$GITHUB_REPOSITORY"
    return 0
  fi
  if [[ -n "${GH_REPO:-}" ]]; then
    printf '%s\n' "$GH_REPO"
    return 0
  fi
  local origin_url=""
  origin_url="$(git -C "$root" remote get-url origin 2>/dev/null || true)"
  if [[ -n "$origin_url" ]]; then
    node -e '
      const m = (process.argv[1] || "").trim().match(/github\.com[:/]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/);
      if (m) console.log(m[1]);
    ' "$origin_url"
  fi
}

# 1. Single-process preflight: verify cross-family strong model pair + evaluate structural risk
preflight_args=(--steward-preflight --root "$root" --head "$head_ref" --author-model "$author_model")
if [[ -n "$steward_model" ]]; then
  preflight_args+=(--steward-model "$steward_model")
fi
if [[ -n "$base_ref" ]]; then
  preflight_args+=(--base "$base_ref")
fi
risk_json="$(run_tsx "$AUDIT_SCRIPT" "${preflight_args[@]}")" || exit $?

author_family="$(node -e 'console.log(JSON.parse(process.argv[1]).authorFamily)' "$risk_json")"
steward_model="$(node -e 'console.log(JSON.parse(process.argv[1]).stewardModel)' "$risk_json")"
steward_family="$(node -e 'console.log(JSON.parse(process.argv[1]).stewardFamily)' "$risk_json")"
head_sha="$(node -e 'console.log(JSON.parse(process.argv[1]).headSha)' "$risk_json")"
base_sha="$(node -e 'console.log(JSON.parse(process.argv[1]).baseSha)' "$risk_json")"
requires_steward="$(node -e 'console.log(JSON.parse(process.argv[1]).risk.requiresSteward ? "1" : "0")' "$risk_json")"
triggers_csv="$(node -e 'console.log(JSON.parse(process.argv[1]).risk.triggers.join(", "))' "$risk_json")"
triggers_json="$(node -e 'console.log(JSON.stringify(JSON.parse(process.argv[1]).risk.triggers))' "$risk_json")"
hits_markdown="$(node -e '
  const r = JSON.parse(process.argv[1]).risk;
  if (!r.hits.length) {
    console.log("- (none: low-risk change; dry-run/explicit review requested)");
  } else {
    for (const h of r.hits) {
      console.log(`- [${h.code}] ${h.summary}`);
      for (const e of h.evidence.slice(0, 8)) console.log(`    * ${e}`);
    }
  }
' "$risk_json")"

diff_stat="$(git -C "$root" diff --shortstat "${base_sha}..${head_sha}" 2>/dev/null || true)"

if [[ -z "$out_path" ]]; then
  if [[ "$dry_run" == 1 ]]; then
    out_path="${TMPDIR:-/tmp}/arch-steward-dry-run-${head_sha:0:12}.json"
  else
    receipt_dir="${OC_STEWARD_RECEIPT_DIR:-$DEFAULT_HOST_RECEIPT_DIR}"
    out_path="$receipt_dir/${head_sha}.json"
  fi
fi

# 2. Build standardized 4-dimension Architecture Steward prompt
prompt="$(cat <<EOF
你是 OpenClaude V5 的「跨家族架构看护员（Architecture Steward）」。
你的职责与开发实现者严格分离：你是独立、只读、具备**不可被开发队长单方驳回的硬否决权（Hard Veto）**的架构守门员。

审查元数据：
- 仓库提交范围：\`git diff ${base_sha}..${head_sha}\`（${diff_stat:-stat unavailable}）
- 精确绑定提交：\`headSha=${head_sha}\` / \`baseSha=${base_sha}\`
- 开发模型 / 家族：\`${author_model}\`（\`${author_family}\`）
- 看护员模型 / 家族：\`${steward_model}\`（\`${steward_family}\`）
- 机械触发的结构风险规则：
${hits_markdown}

你必须围绕以下 **4 个核心架构维度** 逐项审阅 \`git diff ${base_sha}..${head_sha}\` 与直接受影响的调用方：
1. \`godClassAppend\`（上帝类局部追加）：是否把新功能/新状态/新分支硬塞进 \`arch/append-magnets.json\` Top-20 追加磁铁或巨型文件，而非通过 Strangler Fig 抽离到独立子模块？
2. \`wheelReinvention\`（重复造轮子）：是否重新实现了 \`@openclaude/kernel\` 或既有公共工具，或引入了 >=12 行复制粘贴克隆块？
3. \`boundaryIntegrity\`（分层/子域边界破损）：是否破坏 \`arch/modules.json\` 的单向分层 / 进程作用域 / 模块内子域边界，或破坏 \`arch/gate-couplings.json\` 门耦合，或越权触碰 T2 核心路径（gateway/protocol/storage/billing/migrations/deploy）而未守恒不变量？
4. \`complexityDrift\`（无谓复杂度膨胀）：是否引入 >100 行或 \`CC_direct > 20\` 的复杂函数、深层嵌套、或可避免的状态/分支膨胀？

硬性裁决规则：
- 存在任意 P0/P1 真实架构阻断项时，必须输出 \`"verdict": "veto"\` 并在 \`blockers\` 中列出具体 \`location\`、\`reason\` 与 \`remediation\`。
- 若四维均无阻断项（可附非阻断 \`concern\` 建议），输出 \`"verdict": "approve"\` 且 \`"blockers": []\`。
- 只输出严格合法的单个 JSON 对象（不要额外解释散文），格式如下：
{
  "verdict": "approve" | "veto",
  "dimensions": {
    "godClassAppend": { "status": "pass" | "concern" | "veto", "notes": "..." },
    "wheelReinvention": { "status": "pass" | "concern" | "veto", "notes": "..." },
    "boundaryIntegrity": { "status": "pass" | "concern" | "veto", "notes": "..." },
    "complexityDrift": { "status": "pass" | "concern" | "veto", "notes": "..." }
  },
  "blockers": [
    {
      "dimension": "godClassAppend" | "wheelReinvention" | "boundaryIntegrity" | "complexityDrift",
      "severity": "P0" | "P1",
      "location": "path/to/file.ts:123",
      "reason": "...",
      "remediation": "..."
    }
  ]
}
EOF
)"

if [[ "$print_prompt" == 1 ]]; then
  printf '%s\n' "$prompt"
  exit 0
fi

# 3. Dry-run mode: emit NON-PRODUCTION dry-run preview artifact ONLY (never approve, never sign, never publish!)
if [[ "$dry_run" == 1 ]]; then
  now_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  mkdir -p "$(dirname "$out_path")"
  node -e '
    const fs = require("node:fs");
    const [outFile, headSha, baseSha, authorModel, authorFamily, stewardModel, stewardFamily, triggersJson, nowIso] = process.argv.slice(1);
    const preview = {
      schemaVersion: "oc.v5.arch-steward-dry-run/1",
      dryRun: true,
      note: "NON-PRODUCTION DRY-RUN PREVIEW ONLY — hard-rejected by check-cross-family-audit.ts --enforce-commit/--enforce-pr.",
      headSha,
      baseSha,
      authorModel,
      authorFamily,
      stewardModel,
      stewardFamily,
      verdict: "dry-run-preview",
      triggers: JSON.parse(triggersJson),
      dimensions: {
        godClassAppend: { status: "concern", notes: "[dry-run] preview only — no cross-family model executed" },
        wheelReinvention: { status: "concern", notes: "[dry-run] preview only — no cross-family model executed" },
        boundaryIntegrity: { status: "concern", notes: "[dry-run] preview only — no cross-family model executed" },
        complexityDrift: { status: "concern", notes: "[dry-run] preview only — no cross-family model executed" }
      },
      blockers: [],
      usageEvidence: {
        jobId: `dry-run-${headSha.slice(0, 12)}`,
        sessionKey: `steward-dry-run:${stewardFamily}`,
        timestamp: nowIso,
        provider: "dry-run",
        command: "scripts/arch-steward-review.sh --dry-run"
      }
    };
    fs.writeFileSync(outFile, `${JSON.stringify(preview, null, 2)}\n`, "utf8");
  ' "$out_path" "$head_sha" "$base_sha" "$author_model" "$author_family" "$steward_model" "$steward_family" "$triggers_json" "$now_iso"

  echo "[arch-steward-review] DRY-RUN preview written (NON-PRODUCTION; rejected by --enforce-commit):"
  echo "  headSha      : $head_sha"
  echo "  baseSha      : $base_sha"
  echo "  pair         : $author_model ($author_family) -> $steward_model ($steward_family)"
  echo "  triggers     : ${triggers_csv:-none (low-risk)}"
  echo "  previewOut   : $out_path"
  exit 0
fi

# 4. Fast exit if zero structural risk triggers fired (zero overhead on low-risk edits)
if [[ "$requires_steward" == "0" ]]; then
  echo "[arch-steward-review] LOW-RISK FAST PASS: 0/6 structural risk triggers fired for ${base_sha:0:12}..${head_sha:0:12}; skipping LLM review."
  exit 0
fi

# 5. Select cross-family execution channel
effective_channel="$channel"
if [[ "$effective_channel" == "auto" ]]; then
  if [[ -n "${OC_STEWARD_REVIEW_CMD:-}" ]]; then
    effective_channel="command"
  elif [[ "$steward_family" == "openai-gpt" ]]; then
    effective_channel="codex"
  else
    effective_channel="agy"
  fi
fi

tmp_raw="$(mktemp)"
tmp_unsigned="$(mktemp)"
trap 'rm -f "$tmp_raw" "$tmp_unsigned"' EXIT

job_id="steward-${head_sha:0:12}-$(date -u +%Y%m%d%H%M%S)"
session_key="arch-steward:${steward_family}:${head_sha:0:12}"
invoked_cmd=""

case "$effective_channel" in
  command)
    [[ -n "${OC_STEWARD_REVIEW_CMD:-}" ]] || die "--channel command 需要设置环境变量 OC_STEWARD_REVIEW_CMD"
    invoked_cmd="$OC_STEWARD_REVIEW_CMD"
    printf '%s\n' "$prompt" | env \
      STEWARD_HEAD_SHA="$head_sha" \
      STEWARD_BASE_SHA="$base_sha" \
      STEWARD_MODEL="$steward_model" \
      STEWARD_FAMILY="$steward_family" \
      AUTHOR_MODEL="$author_model" \
      AUTHOR_FAMILY="$author_family" \
      bash -c "$OC_STEWARD_REVIEW_CMD" > "$tmp_raw"
    ;;
  codex)
    command -v codex >/dev/null 2>&1 || die "未找到 codex CLI（可设置 OC_STEWARD_REVIEW_CMD 或使用 --channel command）"
    invoked_cmd="codex exec -s read-only -m $steward_model"
    (cd "$root" && printf '%s\n' "$prompt" | codex exec -s read-only -m "$steward_model" -o "$tmp_raw" -)
    ;;
  agy)
    if command -v agy >/dev/null 2>&1; then
      invoked_cmd="agy --model $steward_model"
      (cd "$root" && printf '%s\n' "$prompt" | agy --model "$steward_model" > "$tmp_raw")
    else
      die "未找到 agy CLI 跨家族审查通道（可配置 OC_STEWARD_REVIEW_CMD 接入平台跨家族 delegate 通道）"
    fi
    ;;
esac

# 6. Parse real cross-family model JSON verdict and assemble production ArchStewardReceipt
now_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
node -e '
  const fs = require("node:fs");
  const [rawFile, headSha, baseSha, authorModel, authorFamily, stewardModel, stewardFamily, triggersJson, jobId, sessionKey, nowIso, channel, invokedCmd] = process.argv.slice(1);
  const text = fs.readFileSync(rawFile, "utf8").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("steward output did not contain a valid JSON object");
  }
  const parsed = JSON.parse(candidate.slice(start, end + 1));
  if (parsed.verdict !== "approve" && parsed.verdict !== "veto") {
    throw new Error(`steward verdict must be "approve" or "veto", got ${JSON.stringify(parsed.verdict)}`);
  }
  const receipt = {
    schemaVersion: "oc.v5.arch-steward-receipt/1",
    headSha,
    baseSha,
    authorModel,
    authorFamily,
    stewardModel,
    stewardFamily,
    verdict: parsed.verdict,
    triggers: JSON.parse(triggersJson),
    dimensions: parsed.dimensions,
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
    usageEvidence: {
      jobId,
      sessionKey,
      timestamp: nowIso,
      provider: channel,
      command: invokedCmd
    }
  };
  process.stdout.write(JSON.stringify(receipt, null, 2));
' "$tmp_raw" "$head_sha" "$base_sha" "$author_model" "$author_family" "$steward_model" "$steward_family" "$triggers_json" "$job_id" "$session_key" "$now_iso" "$effective_channel" "$invoked_cmd" > "$tmp_unsigned"

mkdir -p "$(dirname "$out_path")"
run_tsx "$AUDIT_SCRIPT" --sign-receipt "$tmp_unsigned" --out "$out_path"
chmod 0644 "$out_path" 2>/dev/null || true
echo "[arch-steward-review] Production receipt written: $out_path"

# 7. Mechanically enforce the produced receipt (exits 1 on veto / invalid receipt!)
enforce_args=(--enforce-commit --root "$root" --base "$base_sha" --head "$head_sha" --receipt "$out_path")
if [[ "$unsafe_test_skip_owner" == 1 || "${OC_STEWARD_UNSAFE_TEST_SKIP_OWNER:-0}" == 1 ]]; then
  enforce_args+=(--unsafe-test-skip-owner)
fi
run_tsx "$AUDIT_SCRIPT" "${enforce_args[@]}"

# 8. Optionally publish out-of-commit GitHub Commit Status `oc-v5/arch-steward` (ONLY after enforce passed!)
if [[ "$publish_gh" == 1 ]]; then
  resolved_repo="$(resolve_github_repo_slug "$gh_repo")"
  [[ -n "$resolved_repo" ]] || die "--publish-github-status 需要 --github-repo <owner/repo>（或 GITHUB_REPOSITORY / GH_REPO）"
  command -v gh >/dev/null 2>&1 || die "--publish-github-status 需要 PATH 中可用的 gh CLI"
  receipt_digest="$(node -e 'const d = JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).receiptDigest || ""; console.log(d);' "$out_path")"
  digest_short="$(node -e 'const d = process.argv[1]; const [a, h] = d.split(":"); console.log(`${a}:${(h || "").slice(0, 16)}`);' "$receipt_digest")"
  gh_desc="verdict=approve sha=${head_sha:0:12} author=${author_family} steward=${steward_family} digest=${digest_short}"
  gh api -X POST "repos/${resolved_repo}/statuses/${head_sha}" \
    -f state=success \
    -f context="oc-v5/arch-steward" \
    -f description="${gh_desc:0:140}" >/dev/null || die "发布 GitHub status oc-v5/arch-steward 失败 (${resolved_repo}@${head_sha})"
  echo "[arch-steward-review] Published GitHub status oc-v5/arch-steward on ${resolved_repo}@${head_sha:0:12}"
fi
