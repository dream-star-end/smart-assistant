import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";

// Execute the actual checker functions, not a second implementation of its rules.
// An optional source file is only for the old-checker negative-control invocation.
const source = readFileSync(process.env.OC_INCIDENT_COMPAT_CHECKER_SOURCE
  ?? fileURLToPath(new URL("../check-v5-incident-regressions.ts", import.meta.url)), "utf8");
const ast = ts.createSourceFile("checker.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ["normalizeImmutableIncidentTrailer", "checkTrailerClosure"];
const functions = ast.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && !!node.name && names.includes(node.name.text));
assert.equal(functions.filter((node) => node.name?.text === "checkTrailerClosure").length, 1);
const executable = ts.transpileModule(functions.map((node) => node.getText(ast)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const TARGET = "f496228de43718852cebda8fb9f35eb0e9c3a9c0";
const ID = "INC-20260908-CC-SWITCH-ASCII-NAME";
const OLD = "OCV5-171 follow-up";
const START = "1".repeat(40);
const TIP = "2".repeat(40);
type Row = { id: string; rootFixCommit: string; coverageCommits?: string[] };
type Waiver = { expiresAt: string; commit?: string; emergencyMissingTrailer?: boolean };
function execute(options: {
  sha?: string;
  trailer?: string | null;
  incidents?: Row[];
  waivers?: Map<string, Waiver>;
  /** Commits `git rev-list TIP ^START` reports as frozen imported history (default: the tip only). */
  frozen?: string[];
} = {}) {
  const sha = options.sha ?? TARGET;
  const trailer = options.trailer === undefined ? OLD : options.trailer;
  const calls: string[] = [], unexpected: string[] = [], audit: string[] = [];
  const bad = (s: string): never => { unexpected.push(s); throw new Error(`unexpected fixture call: ${s}`); };
  const sandbox = {
    ROOT: "/isolated-checker-fixture",
    TRAILER_GATE_MARKER: "marker",
    IMPORTED_TRAILER_HISTORY_TIPS: [TIP],
    TRAILER_GATE_SURFACES: ["packages/web-react/"],
    manifest: { incidents: options.incidents ?? [{ id: ID, rootFixCommit: TARGET.slice(0, 8) }] },
    resolveTrailerGateStart: () => START,
    parseWaivers: () => options.waivers ?? new Map(),
    fail: (message: string): never => { throw new Error(`[incident-regressions] ${message}`); },
    process: { stdout: { write: (s: string) => { audit.push(s); } } },
    commitFiles: (commit: string) => {
      calls.push(`files:${commit}`);
      assert.equal(commit, sha);
      return ["packages/web-react/src/components/settings/ApiKeysSection.tsx"];
    },
    git: (...args: string[]) => {
      const key = args.join(" "); calls.push(key);
      if (args[0] === "cat-file" && args[1] === "-e" && args.length === 3
        && [START + "^{commit}", TIP + "^{commit}"].includes(args[2]!)) return "";
      if (key === `log -1 --format=%ct ${START}`) return "100";
      // OCV5-376: the frozen-history set is one rev-list, not a merge-base per commit × tip.
      if (key === `rev-list ${TIP} ^${START}`) return (options.frozen ?? [TIP]).join("\n");
      if (key === `log --no-merges --format=%H%x1f%s%x1f%b%x1f%ct%x1e ${START}..HEAD`) {
        return `${sha}\x1ffix(v5): exact fixture\x1f${trailer === null ? "no trailer" : `Incident: ${trailer}`}\x1f101\x1e`;
      }
      return bad(`git ${key}`);
    },
    execFileSync: (cmd: string, args: string[], opts: { cwd: string }) => {
      assert.equal(cmd, "git"); assert.equal(opts.cwd, "/isolated-checker-fixture");
      const key = args.join(" "); calls.push(key);
      if (key === `merge-base --is-ancestor ${START} HEAD` || key === `merge-base --is-ancestor ${TIP} HEAD`) return "";
      return bad(`exec ${key}`);
    },
  };
  try {
    const checked = runInNewContext(`${executable}\ncheckTrailerClosure();`, sandbox, { timeout: 2_000 }) as number;
    return { checked, audit: audit.join("") };
  } finally {
    assert.deepEqual(unexpected, [], "fixture cannot silently accept unknown git calls");
    assert.ok(calls.includes(`rev-list ${TIP} ^${START}`), "frozen imported history must be queried");
    if (!(options.frozen ?? []).includes(sha)) {
      assert.ok(calls.includes(`files:${sha}`), "target must not be skipped as imported history");
    }
  }
}

test("exact immutable SHA and original trailer normalize then complete incident closure", () => {
  const result = execute();
  assert.equal(result.checked, 1);
  assert.ok(result.audit.includes(TARGET));
  assert.ok(result.audit.includes(OLD));
  assert.ok(result.audit.includes(ID));
});

for (const sha of [TARGET.slice(0, 8), TARGET.slice(0, 39), TARGET.slice(0, 39) + "1", "a".repeat(40)]) {
  test(`identical old trailer on non-exact SHA remains rejected: ${sha}`, () => {
    assert.throws(() => execute({ sha }), /Incident trailer 格式非法:OCV5-171 follow-up/);
  });
}
for (const trailer of ["OCV5-171", "OCV5-171 follow-up-extra", "ocv5-171 follow-up", "OCV5-172 follow-up"]) {
  test(`target SHA does not normalize other malformed trailer: ${trailer}`, () => {
    assert.throws(() => execute({ trailer }), /Incident trailer 格式非法/);
  });
}

test("exact mapping still rejects a missing semantic incident", () => {
  assert.throws(() => execute({ incidents: [] }), /指向的 INC-20260908-CC-SWITCH-ASCII-NAME 不在 incidents.json/);
});
test("exact mapping still rejects missing rootFix and coverage lineage", () => {
  assert.throws(() => execute({ incidents: [{ id: ID, rootFixCommit: "abcdef12" }] }), /rootFixCommit\/coverageCommits 未包含本 commit/);
});
test("exact mapping honors real coverage lineage without exempting the commit", () => {
  assert.equal(execute({ incidents: [{ id: ID, rootFixCommit: "abcdef12", coverageCommits: [TARGET.slice(0, 8)] }] }).checked, 1);
});
test("missing trailer on the mapped SHA is not pardoned", () => {
  assert.throws(() => execute({ trailer: null }), /触碰用户可见面但缺 trailer/);
});
test("none without a waiver remains rejected", () => {
  assert.throws(() => execute({ trailer: "none (fixture)" }), /没有对应 waiver/);
});
test("none with expired waiver remains rejected", () => {
  assert.throws(() => execute({ trailer: "none (fixture)", waivers: new Map([[TARGET.slice(0, 8), { expiresAt: "2020-01-01" }]]) }), /已于 2020-01-01 过期/);
});
test("none with a valid existing waiver preserves the ordinary path", () => {
  const r = execute({ trailer: "none (fixture)", waivers: new Map([[TARGET.slice(0, 8), { expiresAt: "2099-01-01" }]]) });
  assert.equal(r.checked, 1); assert.equal(r.audit, "");
});
test("a future ordinary legal incident still follows original closure", () => {
  const sha = "a".repeat(40);
  const r = execute({ sha, trailer: "INC-20260908-ORDINARY-FUTURE", incidents: [{ id: "INC-20260908-ORDINARY-FUTURE", rootFixCommit: sha.slice(0, 8) }] });
  assert.equal(r.checked, 1); assert.equal(r.audit, "");
});
test("a future ordinary malformed incident remains rejected", () => {
  assert.throws(() => execute({ sha: "b".repeat(40), trailer: "OCV5-999" }), /Incident trailer 格式非法:OCV5-999/);
});
test("a commit inside a frozen tip's history is skipped, not judged", () => {
  const r = execute({ trailer: "OCV5-999", frozen: [TIP, TARGET] });
  assert.equal(r.checked, 0);
});

const SHIPPED_EXPIRED_WAIVER = "da9cd5484db3b0e5c882f4032ee09685c4e5b5a7";

test("steward immutable exception pardons only shipped da9cd548 with its original expiry", () => {
  const waiver = { commit: SHIPPED_EXPIRED_WAIVER, expiresAt: "2026-10-31" };
  const result = execute({
    sha: SHIPPED_EXPIRED_WAIVER,
    trailer: "none (route lookup key; unit regression, no session display change)",
    waivers: new Map([[SHIPPED_EXPIRED_WAIVER.slice(0, 8), waiver]]),
  });
  assert.equal(result.checked, 1);
});

test("a different full SHA is not covered by the da9cd548 exception", () => {
  const sha = `${SHIPPED_EXPIRED_WAIVER.slice(0, 39)}0`;
  assert.throws(() => execute({
    sha,
    trailer: "none (fixture)",
    waivers: new Map([[sha.slice(0, 8), { commit: sha, expiresAt: "2026-10-31" }]]),
  }), /已于 2026-10-31 过期/);
});

test("da9cd548 with any other expiry date stays on the ordinary expired-waiver path", () => {
  assert.throws(() => execute({
    sha: SHIPPED_EXPIRED_WAIVER,
    trailer: "none (fixture)",
    waivers: new Map([[SHIPPED_EXPIRED_WAIVER.slice(0, 8), { commit: SHIPPED_EXPIRED_WAIVER, expiresAt: "2026-10-30" }]]),
  }), /已于 2026-10-30 过期/);
});

test("the da9cd548 exception does not extend the waiver or freeze a history tip", () => {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const checker = readFileSync(`${repo}/scripts/check-v5-incident-regressions.ts`, "utf8");
  const shell = readFileSync(`${repo}/scripts/check-v5-fix-trailers.sh`, "utf8");
  const waivers = JSON.parse(readFileSync(`${repo}/e2e/session-display/incident-waivers.json`, "utf8")) as {
    waivers: Array<{ commit: string; expiresAt: string }>;
  };
  assert.equal(checker.split(SHIPPED_EXPIRED_WAIVER).length - 1, 1);
  assert.equal(shell.split(SHIPPED_EXPIRED_WAIVER).length - 1, 1);
  const entry = waivers.waivers.find((waiver) => waiver.commit === SHIPPED_EXPIRED_WAIVER);
  assert.equal(entry?.expiresAt, "2026-10-31");
  const tips = /const IMPORTED_TRAILER_HISTORY_TIPS = \[([\s\S]*?)\] as const/.exec(checker)?.[1] ?? "";
  assert.equal(tips.includes(SHIPPED_EXPIRED_WAIVER), false);
  assert.equal(tips.includes("197735db77dfbf05280c526963ae04846544cabe"), true);
});
