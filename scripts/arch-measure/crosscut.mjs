#!/usr/bin/env node
// OCV5-540: plan §1.5, §1.6 and §1.8 counts (appendix A.2/A.4). Lexical lower bounds over non-test
// .ts/.tsx, the way the plan measured them with rg: the raw text by default, `--strip` blanks
// comments first. Each rule names its scope, its regex and the §1 value it reproduces.
// Usage: node scripts/arch-measure/crosscut.mjs [--root <repo>] [--json] [--strip]
import { emit, parseArgs, prodFiles, read, stripComments } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2).filter((a) => a !== "--strip"));
const STRIP = process.argv.includes("--strip");
const R = args.root;
const P = (p) => `packages/${p}`;
const SERVER = [P("commercial"), P("gateway"), P("storage"), P("mcp-memory"), P("cli"), P("channels"), P("protocol"), P("plugin-sdk")];
const ALL = [...SERVER, P("web-react")];
const cache = new Map();
function files(scopes) {
  return scopes.flatMap((s) => {
    if (!cache.has(s)) cache.set(s, prodFiles(R, s));
    return cache.get(s);
  });
}
const text = new Map();
function body(f) {
  if (!text.has(f)) text.set(f, STRIP ? stripComments(read(R, f)) : read(R, f));
  return text.get(f);
}
function count(scopes, re) {
  let total = 0; let nfiles = 0;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const f of files(scopes)) {
    const n = (body(f).match(g) ?? []).length;
    if (n) { total += n; nfiles++; }
  }
  return { total, nfiles };
}
function distinct(scopes, re, group = 1) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const s = new Set();
  for (const f of files(scopes)) for (const m of body(f).matchAll(g)) s.add(m[group]);
  return s;
}

const rows = [];
const rule = (id, scopes, re, plan, note = "") => {
  const { total, nfiles } = count(scopes, re);
  rows.push({ id, value: `${total}/${nfiles}f`, what: `plan ${plan}; /${re.source}/ ${note}`.trim() });
};

// §1.5 front end
rule("web.components.fetch", [P("web-react/src/components")], /\bfetch\(/, "12 in 9 files");
rule("web.hooks.newWebSocket", [P("web-react/src/hooks")], /new WebSocket\(/, "2 hooks");
rule("web.provider===", [P("web-react")], /provider\s*===/, "30");
rule("web.provider===|!==", [P("web-react")], /provider\s*[!=]==/, "45");
// §1.6 auth
rule("auth.requireAdminVerifyDb()", [P("commercial")], /\brequireAdminVerifyDb\(/, "109 calls", "(incl. the definition)");
rule("auth.requireAdmin()", [P("commercial")], /\brequireAdmin\(/, "~77");
rule("auth.requireAuth()", [P("commercial")], /\brequireAuth\(/, "97");
rule("auth.verifyContainerIdentity()", [P("commercial")], /\bverifyContainerIdentity\(/, "51");
// §1.6 authorisation
rule("authz.user_id=$n", SERVER, /user_id\s*=\s*\$\d/, "916 / 117 files");
rule("authz.role==='admin'", ALL, /role\s*[!=]==\s*['"]admin['"]/, "52 / 35 files");
// §1.6 validation
rule("validate.zod.files", SERVER, /from\s+['"]zod['"]/, "26 files");
rule("validate.typebox.files", SERVER, /from\s+['"]@sinclair\/typebox/, "protocol + 13 files");
rule("validate.ajv.files", SERVER, /(?:from\s+|require\(\s*|import\(\s*)['"]ajv['"]/, "1");
rule("validate.typeof", SERVER, /\btypeof\s+[\w$.?[\]'"]+\s*[!=]==/, "~5,600");
rule("validate.isRecord/isObject defs", ALL, /(?:function|const|let)\s+(?:isRecord|isObject|isPlainObject)\b/, "40");
// §1.6 outbound
rule("outbound.fetch(commercial)", [P("commercial")], /\bfetch\(/, "57 / 41 files");
rule("outbound.fetch(gateway)", [P("gateway")], /\bfetch\(/, "23");
rule("outbound.undiciAgent", SERVER, /new\s+(?:undici\.)?(?:Agent|ProxyAgent|Pool)\(/, "10");
// §1.6 logging
rule("log.console(commercial)", [P("commercial")], /\bconsole\.(?:log|info|warn|error|debug)\(/, "383");
rule("log.console(gateway)", [P("gateway")], /\bconsole\.(?:log|info|warn|error|debug)\(/, "87");
rule("log.console(cli)", [P("cli")], /\bconsole\.(?:log|info|warn|error|debug)\(/, "81");
// §1.6 display
{
  let n = 0; let nf = 0;
  for (const f of files([P("commercial"), P("gateway"), P("storage"), P("cli")])) {
    const k = stripComments(read(R, f)).split("\n").filter((l) => /[\u4e00-\u9fff]/.test(l)).length;
    if (k) { n += k; nf++; }
  }
  rows.push({ id: "display.backendChineseLines", value: `${n}/${nf}f`, what: "plan ~4,200 lines / 396 files; code lines with a CJK character (comments always stripped)" });
}
// §1.6 errors
rule("errors.newHttpError", [P("commercial")], /new HttpError\(/, "1,044");
rows.push({ id: "errors.httpErrorCodes", value: distinct([P("commercial")], /new HttpError\(\s*\d+\s*,\s*['"]([A-Z0-9_]+)['"]/).size, what: "plan 161 distinct codes" });
rule("errors.ws.catch", [P("commercial/src/ws")], /\bcatch\b/, "333");
rule("errors.ws.emptyCatch", [P("commercial/src/ws")], /catch\s*(?:\([^)]*\))?\s*\{\s*\}|\.catch\(\s*\(\)\s*=>\s*(?:\{\s*\}|undefined|null|void 0)\s*\)/, "207 silent (plan counted bodies that neither log nor rethrow; this counts only empty ones)");
// §1.6 money and transactions
rule("billing.writes", [P("commercial")], /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:credit_ledger|usage_records|orders|user_api_keys|request_finalize_journal|topup|refunds?)\b/i, "76 / 21 files");
rule("billing.credit_ledger.writers", [P("commercial")], /INSERT\s+INTO\s+credit_ledger/i, "8 files");
rule("tx.bareBEGIN", [P("commercial")], /['"`]BEGIN(?:\s+ISOLATION[^'"`]*)?['"`]/, "68 / 34 files");
// §1.6 special cases
rule("special.engineId===", ALL, /\bengine(?:Id)?\s*[!=]==/, "116 (the plan's exact rule is not recorded; this is engine/engineId compared with ===/!==)");
rule("special.provider===", ALL, /provider\s*===/, "123");
rule("special.provider===|!==", ALL, /provider\s*[!=]==/, "200");
rule("special.selfhost", SERVER, /selfhost/i, "215 branches (plan counted branches; this counts every mention)");
// §1.8 configuration
rule("config.envReads", [P("commercial"), P("gateway"), P("storage"), P("mcp-memory"), P("cli")], /process\.env(?:\.[A-Z_][A-Z0-9_]*|\[\s*['"][A-Z_][A-Z0-9_]*['"]\s*\])/, "512 direct reads");
for (const p of ["commercial", "gateway", "storage", "mcp-memory", "cli"]) {
  rule(`config.envReads(${p})`, [P(p)], /process\.env(?:\.[A-Z_][A-Z0-9_]*|\[\s*['"][A-Z_][A-Z0-9_]*['"]\s*\])/, { commercial: "260 / 113 files", gateway: "164 / 121", storage: "36", "mcp-memory": "43", cli: "9" }[p]);
}
const keys2 = new Set();
for (const f of files(SERVER)) for (const m of body(f).matchAll(/process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])/g)) keys2.add(m[1] ?? m[2]);
rows.push({ id: "config.envKeys", value: keys2.size, what: "plan 446 keys read by production code (direct reads only here; the plan also followed env = process.env aliases)" });
rule("config.indirectEnvParam", SERVER, /\benv\s*(?::\s*[\w.<>|\s]+)?=\s*process\.env\b/, "~300 indirect via env = process.env (this counts the alias sites, not the reads)");
emit(args, `crosscut${STRIP ? " (comments stripped)" : ""}`, rows);
