#!/usr/bin/env node
// OCV5-540: plan §1.7 log-shape numbers (appendix A.6). Read-only; counts key names and levels,
// never prints a log line. Run as root on v5-dev (the logs are root-only).
//   node scripts/arch-measure/logs.mjs [--master /var/log/openclaude-v5-selfhost.log]
//        [--egress /var/log/openclaude-v5-selfhost-egress.log] [--rotated N] [--json]
// --rotated N also reads the N most recent rotations (.1 plain, .2.gz …).
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "./lib.mjs";

const args = parseArgs();
const files = (base, n) => {
  const out = [base];
  for (let i = 1; i <= n; i++) out.push(existsSync(`${base}.${i}`) ? `${base}.${i}` : `${base}.${i}.gz`);
  return out.filter((f) => existsSync(f));
};
const linesOf = (f) => (f.endsWith(".gz") ? gunzipSync(readFileSync(f)) : readFileSync(f)).toString("utf8").split("\n").filter(Boolean);
const ID_KEYS = ["traceId", "requestId", "dispatchId", "trace_id", "request_id", "dispatch_id"];
function measure(base) {
  const fs = files(base, Number(args.rotated ?? 0));
  const r = { files: fs, lines: 0, json: 0, withTraceId: 0, withDispatchOrBilling: 0, warnErr: 0, warnErrAnyId: 0, userKey: { uid: 0, userId: 0, user_id: 0 } };
  for (const f of fs) for (const line of linesOf(f)) {
    r.lines++;
    let o = null;
    if (line.startsWith("{")) { try { o = JSON.parse(line); } catch { o = null; } }
    if (!o || typeof o !== "object") continue;
    r.json++;
    const keys = new Set(Object.keys(o));
    if (keys.has("traceId") || keys.has("trace_id")) r.withTraceId++;
    if ([...keys].some((k) => /dispatch|billing/i.test(k))) r.withDispatchOrBilling++;
    for (const k of Object.keys(r.userKey)) if (keys.has(k)) r.userKey[k]++;
    const lvl = String(o.level ?? o.lvl ?? "").toLowerCase();
    if (lvl === "warn" || lvl === "warning" || lvl === "error" || lvl === "fatal" || o.level >= 40) {
      r.warnErr++;
      if (ID_KEYS.some((k) => keys.has(k))) r.warnErrAnyId++;
    }
  }
  r.jsonShare = r.lines ? +(r.json / r.lines).toFixed(3) : null;
  r.warnErrNoIdShare = r.warnErr ? +(1 - r.warnErrAnyId / r.warnErr).toFixed(3) : null;
  return r;
}
const out = {
  master: measure(args.master ?? "/var/log/openclaude-v5-selfhost.log"),
  egress: measure(args.egress ?? "/var/log/openclaude-v5-selfhost-egress.log"),
};
if (args.json) console.log(JSON.stringify(out, null, 2));
else for (const [k, r] of Object.entries(out)) {
  console.log(`# ${k}: ${r.files.length} file(s), ${r.lines} lines, JSON ${r.jsonShare} (§1.7 master 94%)`);
  console.log(`  traceId lines ${r.withTraceId} (§1.7 master 2,481; egress 0); dispatch/billing-key lines ${r.withDispatchOrBilling} (§1.7 master 0)`);
  console.log(`  warn/error ${r.warnErr}, with any id ${r.warnErrAnyId}, without ${r.warnErrNoIdShare} (§1.7 master 71% = 278/391)`);
  console.log(`  user keys uid/userId/user_id: ${r.userKey.uid}/${r.userKey.userId}/${r.userKey.user_id}`);
}
