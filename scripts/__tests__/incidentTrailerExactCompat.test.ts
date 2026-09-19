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
type Waiver = { expiresAt: string; emergencyMissingTrailer?: boolean };
function execute(options: {
  sha?: string;
  trailer?: string | null;
  incidents?: Row[];
  waivers?: Map<string, Waiver>;
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
      if (key === `log --no-merges --format=%H%x1f%s%x1f%b%x1f%ct%x1e ${START}..HEAD`) {
        return `${sha}\x1ffix(v5): exact fixture\x1f${trailer === null ? "no trailer" : `Incident: ${trailer}`}\x1f101\x1e`;
      }
      return bad(`git ${key}`);
    },
    execFileSync: (cmd: string, args: string[], opts: { cwd: string }) => {
      assert.equal(cmd, "git"); assert.equal(opts.cwd, "/isolated-checker-fixture");
      const key = args.join(" "); calls.push(key);
      if (key === `merge-base --is-ancestor ${START} HEAD` || key === `merge-base --is-ancestor ${TIP} HEAD`) return "";
      if (key === `merge-base --is-ancestor ${sha} ${TIP}`) throw new Error("not a frozen ancestor");
      return bad(`exec ${key}`);
    },
  };
  try {
    const checked = runInNewContext(`${executable}\ncheckTrailerClosure();`, sandbox, { timeout: 2_000 }) as number;
    return { checked, audit: audit.join("") };
  } finally {
    assert.deepEqual(unexpected, [], "fixture cannot silently accept unknown git calls");
    assert.ok(calls.includes(`files:${sha}`), "commit must reach user-visible surface check");
    assert.ok(calls.includes(`merge-base --is-ancestor ${sha} ${TIP}`), "target must not be skipped as imported history");
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
