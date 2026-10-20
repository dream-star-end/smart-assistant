#!/usr/bin/env node
// OCV5-540: plan §1.1/§1.3–§1.5 sizes. Non-test .ts/.tsx lines (lib.isProdTs); package totals
// count the whole package directory (src plus e.g. commercial/agent-sandbox), as §1.1 does.
// Usage: node scripts/arch-measure/sizes.mjs [--root <repo>] [--json]
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { emit, lineCount, lines, parseArgs, prodFiles, read } from "./lib.mjs";

const args = parseArgs();
const R = args.root;
const rows = [];
const add = (id, value, what) => rows.push({ id, value, what });
const pkgLines = (rel) => lines(R, prodFiles(R, rel));
const fileLines = (rel) => (existsSync(path.join(R, rel)) ? lineCount(read(R, rel)) : null);

add("lines.commercial", pkgLines("packages/commercial"), "packages/commercial non-test lines, whole package (§1.1)");
const csrc = path.join(R, "packages/commercial/src");
const ents = readdirSync(csrc, { withFileTypes: true });
add("commercial.topDirs", ents.filter((e) => e.isDirectory() && !e.name.startsWith("__")).length, "commercial/src top-level dirs, excluding __tests__ (§1.1/§1.3)");
add("commercial.rootFiles", ents.filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)).length, "commercial/src root non-test .ts files (§1.1)");
add("lines.gateway", pkgLines("packages/gateway"), "packages/gateway (§1.1)");
add("lines.protocol", pkgLines("packages/protocol"), "packages/protocol (§1.1)");
add("lines.storage", pkgLines("packages/storage"), "packages/storage (§1.1)");
add("lines.mcp-memory", pkgLines("packages/mcp-memory"), "packages/mcp-memory (§1.1)");
add("lines.channels", pkgLines("packages/channels"), "packages/channels/* (§1.1)");
add("lines.plugin-sdk", pkgLines("packages/plugin-sdk"), "packages/plugin-sdk (§1.1)");
add("lines.cli", pkgLines("packages/cli"), "packages/cli (§1.1)");
add("lines.web-react", pkgLines("packages/web-react"), "packages/web-react incl. .tsx (§1.1, ~210k)");
add("lines.egress-main", fileLines("packages/commercial/src/egress/main.ts"), "egress/main.ts (§1.1)");
add("lines.commercial-http", pkgLines("packages/commercial/src/http"), "commercial/src/http (§1.3)");
add("lines.commercial-http-proxy", pkgLines("packages/commercial/src/http/proxy"), "commercial/src/http/proxy (§1.3, ~30k)");
add("lines.commercial-index", fileLines("packages/commercial/src/index.ts"), "commercial/src/index.ts (§1.3)");
add("lines.pgSessionsBackend", fileLines("packages/commercial/src/db/pgSessionsBackend.ts"), "db/pgSessionsBackend.ts (§1.3)");
const gsrc = path.join(R, "packages/gateway/src");
const gents = readdirSync(gsrc, { withFileTypes: true });
add("gateway.rootFiles", gents.filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)).length, "gateway/src root non-test .ts files (§1.4)");
add("gateway.subdirs", gents.filter((e) => e.isDirectory() && !e.name.startsWith("__")).map((e) => e.name).join(","), "gateway/src subdirs (§1.4)");
add("lines.gateway-server", fileLines("packages/gateway/src/server.ts"), "gateway/src/server.ts (§1.4)");
add("lines.web-socket", fileLines("packages/web-react/src/lib/chat/socket.ts"), "web-react lib/chat/socket.ts (§1.5)");
add("lines.web-App", fileLines("packages/web-react/src/App.tsx"), "web-react App.tsx (§1.5)");
add("lines.deploy-selfhost", fileLines("scripts/deploy-v5-selfhost.sh"), "scripts/deploy-v5-selfhost.sh (§1.1)");
add("lines.master-release-lib", fileLines("scripts/v5-selfhost-master-release-lib.sh"), "scripts/v5-selfhost-master-release-lib.sh (§1.1)");
emit(args, "sizes", rows);
