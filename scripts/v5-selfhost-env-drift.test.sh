#!/usr/bin/env bash
# OCV5-535(FINDINGS DEP-7)env 模板与漂移检查测试:
#  ① 模板覆盖 deploy-v5-selfhost.sh 写入的每个键(bootstrap 模板、ensure_env_kv、运行四元组、provider 透传规则);
#  ② 漂移检查的行为(MISSING 拒绝、UNDECLARED 告警、pattern 放行、从不打印值)。只写 mktemp 目录。
set -euo pipefail
export LC_ALL=C

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
DEPLOY="$DIR/deploy-v5-selfhost.sh"
ENVLIB="$DIR/lib/v5-selfhost-env.sh"
TEMPLATE="${ENV_TEMPLATE:-$ROOT/deploy/v5-selfhost/commercial-v5-selfhost.env.template}"
DRIFT="$DIR/v5-selfhost-env-drift.sh"
pass=0
fail=0
ok() { pass=$((pass + 1)); echo "PASS $*"; }
bad() { fail=$((fail + 1)); echo "FAIL $*"; }
BASE="$(mktemp -d "${TMPDIR:-/tmp}/v5-selfhost-env-drift.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT

declared="$(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$TEMPLATE" | sed 's/=$//' | sort -u)"
required="$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=.*#.*@required' "$TEMPLATE" | sed -E 's/=.*//' | sort -u)"
deploy_managed="$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=.*#.*@deploy' "$TEMPLATE" | sed -E 's/=.*//' | sort -u)"
absent() { comm -23 <(printf '%s\n' "$1" | sed '/^$/d' | sort -u) <(printf '%s\n' "$2" | sort -u); }

# T1 bootstrap 模板(write_env_file 的 heredoc)里的每个键
boot="$(awk '/^write_env_file\(\) \{/{f=1} f && /cat >"\$tmp" <<EOF/{g=1; next} g && /^EOF$/{exit} g{print}' "$ENVLIB" \
  | grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' | sed 's/=$//')"
[[ "$(wc -l <<<"$boot")" -ge 30 ]] || bad "T1 未能从 write_env_file 读出 bootstrap 键(只读到 $(wc -l <<<"$boot") 个)"
miss="$(absent "$boot" "$declared")"
[[ -z "$miss" ]] && ok "T1 bootstrap 写入的键全部登记" || bad "T1 bootstrap 键未登记: $(tr '\n' ' ' <<<"$miss")"

# T2 每次 --deploy 由 ensure_env_kv 写的键都登记为 @deploy;其中漂移检查之前写的(ensure_selfhost_env_keys、
#    ensure_model_authority)必须 @required,之后才写的(切流时)不得 @required,否则会挡住能自动补齐的发布。
ens_by_fn="$(awk '/^[a-z_]+\(\) *\{/{fn=$1} match($0,/ensure_env_kv "\$V5_ENV" [A-Za-z_][A-Za-z0-9_]*/){split(substr($0,RSTART,RLENGTH),a," "); print fn, a[3]}' "$DIR"/*.sh "$DIR"/lib/*.sh | sort -u)"
ens="$(awk '{print $2}' <<<"$ens_by_fn" | sort -u)"
pre="$(awk '$1=="ensure_selfhost_env_keys()" || $1=="ensure_model_authority()" {print $2}' <<<"$ens_by_fn" | sort -u)"
post="$(comm -23 <(printf '%s\n' "$ens") <(printf '%s\n' "$pre"))"
[[ -n "$ens" && -n "$pre" ]] || bad "T2 未找到 ensure_env_kv 调用"
miss="$(absent "$ens" "$deploy_managed")"; miss2="$(absent "$pre" "$required")"
extra="$(comm -12 <(printf '%s\n' "$post" | sed '/^$/d') <(printf '%s\n' "$required"))"
if [[ -z "$miss" && -z "$miss2" && -z "$extra" ]]; then ok "T2 ensure_env_kv 键:全部 @deploy;检查前写的 @required,切流时写的不 @required"
else bad "T2 未登记 @deploy=[$(tr '\n' ' ' <<<"$miss")] 缺 @required=[$(tr '\n' ' ' <<<"$miss2")] 不该 @required=[$(tr '\n' ' ' <<<"$extra")]"; fi

# T3 运行四元组
# shellcheck disable=SC1091
tuple="$(OC_HOTCFG_HISTORY=/nonexistent bash -c 'source "$1" >/dev/null 2>&1; printf "%s\n" "${OC_HOTCFG_TUPLE_KEYS[@]}"' _ "$DIR/v5-runtime-release-lib.sh")"
miss="$(absent "$tuple" "$deploy_managed")"; extra="$(comm -12 <(printf '%s\n' "$tuple" | sort) <(printf '%s\n' "$required"))"
[[ -n "$tuple" && -z "$miss" && -z "$extra" ]] && ok "T3 运行四元组 4 键 @deploy 且不 @required(切流时才写)" || bad "T3 四元组登记不对: 缺=[$miss] 多余 required=[$extra]"

# T4 provider 透传规则与 @allow-pattern 是同一份集合
code_pat="$(awk '/^append_provider_keys\(\) \{/{f=1} f && /printf .%s\\n. "\$line"/{exit} f{print}' "$ENVLIB" \
  | grep -E '^\s+[A-Z*_|]+\)$' | tail -1 | tr -d ' )' | tr '|' '\n' | sort -u)"
tpl_pat="$(sed -nE 's/^#[[:space:]]*@allow-pattern[[:space:]]+//p' "$TEMPLATE" | tr ' ' '\n' | sed '/^$/d' | sort -u)"
if [[ -n "$code_pat" && "$code_pat" == "$tpl_pat" ]]; then ok "T4 @allow-pattern 与 append_provider_keys 一致"
else bad "T4 pattern 不一致: code=[$(tr '\n' ' ' <<<"$code_pat")] template=[$(tr '\n' ' ' <<<"$tpl_pat")]"; fi

# T5 模板里 @secret 键永远不带值
leaked="$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=[^ #].*@secret' "$TEMPLATE" | sed -E 's/=.*//' || true)"
[[ -z "$leaked" ]] && ok "T5 @secret 键在模板里均为空值" || bad "T5 模板里 @secret 键带了值: $leaked"

# D* 漂移检查行为
mkenv() { # 由模板生成一份完整的假现网 env,值换成哨兵
  grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$TEMPLATE" | sed 's/$/SENTINEL-VALUE-must-not-print/' >"$1"
}
E="$BASE/env"
mkenv "$E"
out="$(bash "$DRIFT" --env "$E" --template "$TEMPLATE")" && [[ "$out" == "ENV_DRIFT missing=0 undeclared=0" ]] \
  && ok "D1 完整 env 无漂移" || bad "D1: $out"
grep -v '^DATABASE_URL=' "$E" >"$E.2"
if out="$(bash "$DRIFT" --env "$E.2" --template "$TEMPLATE")"; then bad "D2 缺 @required 应退出 1"
elif [[ "$out" == *"MISSING DATABASE_URL"* && "$out" == *"missing=1"* ]]; then ok "D2 缺 @required 键 → MISSING 并退出 1"
else bad "D2: $out"; fi
{ cat "$E"; echo 'OC_BRAND_NEW_FLAG=SENTINEL-VALUE-must-not-print'; echo 'GEMINI_API_KEY=SENTINEL-VALUE-must-not-print'; } >"$E.3"
out="$(bash "$DRIFT" --env "$E.3" --template "$TEMPLATE")" && [[ "$out" == *"UNDECLARED OC_BRAND_NEW_FLAG"* \
  && "$out" != *"GEMINI_API_KEY"* && "$out" == *"undeclared=1"* ]] \
  && ok "D3 未登记键告警不拒绝;provider pattern 键放行" || bad "D3: $out"
all="$(bash "$DRIFT" --env "$E.2" --template "$TEMPLATE" 2>&1; bash "$DRIFT" --env "$E.3" --template "$TEMPLATE" 2>&1)" || true
[[ "$all" != *SENTINEL* ]] && ok "D4 输出从不包含 env 值" || bad "D4 输出泄露了值"
if bash "$DRIFT" --env "$BASE/nope" --template "$TEMPLATE" >/dev/null 2>&1; then bad "D5 env 不可读应退出 2"
else [[ $? == 2 ]] && ok "D5 env 不可读 → 退出 2" || bad "D5 退出码"; fi

# D6 多行引号值/续行里的内容不得被当成键(Codex r1 P1:否则值的片段会进部署日志)
{ cat "$E"; printf 'OC_CHATGPT_PROXY_TLS_KEY="-----BEGIN-----\nSENTINEL_SECRET_MATERIAL=x\n-----END-----"\n'
  printf "OC_JEV_API_KEY='a\nSENTINEL_SINGLE=y'\nOC_WS_MAX_PER_USER=3 \\\nSENTINEL_CONT=z\n"; } >"$E.6"
out="$(bash "$DRIFT" --env "$E.6" --template "$TEMPLATE")" && [[ "$out" == "ENV_DRIFT missing=0 undeclared=0" && "$out" != *SENTINEL* ]] \
  && ok "D6 多行引号值与续行内容不被当成键" || bad "D6: $out"

# D7 未加引号值中间的引号是普通字符,不得开启跨行(Codex r2 P1)
{ cat "$E"; printf "OC_JEV_API_KEY=abc'def\nOC_CHATGPT_PROXY_TLS_KEY='first\nSENTINEL_SECRET_MATERIAL=\nlast'\n"; } >"$E.7"
out="$(bash "$DRIFT" --env "$E.7" --template "$TEMPLATE")" && [[ "$out" == "ENV_DRIFT missing=0 undeclared=0" && "$out" != *SENTINEL* ]] \
  && ok "D7 值中间的引号不开启跨行;其后的多行引号值仍整体跳过" || bad "D7: $out"

# D8 引号闭合后的再一段引号、注释里的反斜杠续行、引号后的续行(Codex r3 P1;systemd env-file.c 语义)
{ cat "$E"; printf "OC_CHATGPT_PROXY_TLS_KEY='first' 'second\nSENTINEL_SECRET_MATERIAL=\nlast'\n"
  printf '# comment continues \\\nSENTINEL_IN_COMMENT=x\nOC_JEV_API_KEY="a" \\\nSENTINEL_CONT2=y\n'; } >"$E.8"
out="$(bash "$DRIFT" --env "$E.8" --template "$TEMPLATE")" && [[ "$out" == "ENV_DRIFT missing=0 undeclared=0" && "$out" != *SENTINEL* ]] \
  && ok "D8 多段引号、注释续行、引号后续行都不产生键" || bad "D8: $out"

# D9 CRLF:反斜杠+CR 是续行,单引号值跨 CRLF 行;值片段不得被当成键(Codex P1:通用换行会改变续行边界)
{ cat "$E"; printf 'OC_JEV_API_KEY=abc\\\r\nOC_CHATGPT_PROXY_TLS_KEY='"'"'first\r\nSENTINEL_SECRET_MATERIAL=x\r\nlast'"'"'\r\n'; } >"$E.9"
out="$(bash "$DRIFT" --env "$E.9" --template "$TEMPLATE")" && [[ "$out" == "ENV_DRIFT missing=0 undeclared=0" && "$out" != *SENTINEL* ]] \
  && ok "D9 CRLF 续行与跨行单引号值不产生键" || bad "D9: $out"

# W* 接线
grep -qF 'source "$SCRIPT_DIR/lib/v5-selfhost-env.sh"' "$DEPLOY" \
  && awk '/^assert_env_key_drift\(\) \{/{f=1} f {print} f && /^}/{exit}' "$ENVLIB" \
    | grep -qF 'bash "$SCRIPT_DIR/v5-selfhost-env-drift.sh" --env "$V5_ENV"' \
  && awk '/^(cmd_deploy|cmd_cutover)\(\) \{/{f=1;e=m=d=0} f && /^[[:space:]]+ensure_selfhost_env_keys$/{e=NR} f && /^[[:space:]]+ensure_model_authority$/{m=NR} f && /^[[:space:]]+assert_env_key_drift$/{d=NR} f && /^}/{if (!(e && m && d && d>e && d>m)) bad=1; n++; f=0} END{exit !(n==2 && !bad)}' "$DEPLOY" \
  && ok "W1 legacy deploy 与 prepared cutover 都在 env/model 补齐之后才跑漂移检查" || bad "W1 --deploy 漂移检查位置不对"

echo "env drift tests: $pass passed, $fail failed"
[[ "$fail" == 0 ]]
